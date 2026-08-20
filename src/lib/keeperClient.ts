// Keeper WebSocket client — ported from remote-browser-keeper/src/main.js.
// Connects to the service's /api/keeper/ws, receives fill_requests, and sends the
// user-supplied values back. The token is carried in the WebSocket subprotocol
// (never the URL). Values are sent only over this authenticated socket — never
// logged, never exposed to any model.
import { CapacitorHttp } from '@capacitor/core';
import { APP_VERSION, type DeviceReport } from './device';
import { isRevocationSignal, type CredentialKind } from './enroll';
import { normalizeDeclineReason } from './format';
import { deadlineFromFrame } from './deadline';

export interface FillField {
  selector: string;
  label?: string;
  field?: string; // password | code | login | email | text
  length?: number;
  format?: string;
  generate?: boolean; // Keeper generates a strong value for this field (e.g. new password)
  symbols?: boolean; // generated password may include symbols (default true; false = a-z/A-Z/0-9 only)
}

export interface FillRequest {
  request_id: string;
  session_id?: string;
  url?: string;
  message?: string;
  screenshot?: string; // single proof image (data URL)
  fields: FillField[];
  // When the service stops waiting (status `timeout`). Absolute — epoch seconds, epoch
  // milliseconds or ISO-8601 — because this frame is REPLAYED verbatim to a reconnecting
  // Keeper; see deadline.ts. Optional: older services send no deadline at all.
  expires_at?: number | string;
  created_at?: number | string; // absolute start; with timeout_s it also yields a deadline
  timeout_s?: number | string;
  server_now?: number | string; // the service's clock at send time (cancels device skew)
  _requested_at?: string;
  // Local-only: `expires_at` resolved onto THIS device's clock at arrival (epoch ms).
  // Absent = no trustworthy deadline → no countdown, no local expiry.
  _deadline_ms?: number;
}

// 'unauthorized' = the service rejected the token (wrong/expired key).
export type ConnState = 'connected' | 'reconnecting' | 'disconnected' | 'unauthorized';

interface Listeners {
  state?: (s: ConnState) => void;
  request?: (r: FillRequest) => void;
  resolved?: (requestId: string) => void; // request resolved elsewhere → dismiss prompt
  // This device's own token was refused (revoked server-side, or a record the service
  // can't see). The app drops it and reconnects on the account key — see issue #12.
  revoked?: () => void;
}

export class KeeperClient {
  private ws: WebSocket | null = null;
  private wsUrl = '';
  private apiKey = '';
  private baseUrl = '';
  private opened = false; // did the current/last socket reach OPEN?
  private backoff = 1000; // ms, capped at 30s
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private fcmToken = ''; // FCM device token; re-sent over the WS on every connect
  private deviceReport: DeviceReport | null = null; // who we are + which vault we hold
  private sentReport = ''; // the report this socket has already announced
  private credentialKind: CredentialKind = 'account'; // what the socket is presenting
  state: ConnState = 'disconnected';
  private listeners: Listeners = {};

  // `apiKey` is whatever we present: this device's token when it has one, else the
  // shared account key. `kind` says which, and it is not cosmetic — it decides whether a
  // 401 means "this device was revoked" or "the account key is wrong" (enroll.ts).
  configure(wsUrl: string, apiKey: string, baseUrl = '', kind: CredentialKind = 'account') {
    this.wsUrl = wsUrl;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.credentialKind = kind;
  }

  on<K extends keyof Listeners>(key: K, fn: Listeners[K]) {
    this.listeners[key] = fn;
  }

  private setState(s: ConnState) {
    this.state = s;
    this.listeners.state?.(s);
  }

  connect() {
    this.stopped = false;
    // A socket that's still OPEN/CONNECTING is fine to keep; a CLOSING/CLOSED one
    // is stale and must not block a fresh attempt (e.g. after resume/reconfigure).
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.ws = null;
    if (!this.wsUrl || !this.apiKey) {
      this.setState('disconnected');
      return;
    }
    this.backoff = 1000; // explicit (re)connect resets backoff
    this.opened = false;
    this.setState('reconnecting');
    let ws: WebSocket;
    try {
      // Token via subprotocol — keeps it out of the URL/query/logs.
      ws = new WebSocket(this.wsUrl, ['bearer', this.apiKey]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // event from a superseded socket — ignore
      this.opened = true;
      this.backoff = 1000;
      this.setState('connected');
      // Announce who we are and which vault we hold on every connect, so the service's
      // device list self-heals across a restart (the same contract as the FCM token).
      const report = this.deviceReport;
      this.sentReport = report ? JSON.stringify(report) : '';
      this.send({ type: 'hello', app: 'remote-browser-mobile', version: APP_VERSION, ...(report || {}) });
      this.sendFcmToken(); // (re)register the device for wake-pushes on this fresh socket
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (msg.type === 'ping') {
        this.send({ type: 'pong' });
        return;
      }
      if (msg.type === 'fill_request' && msg.request_id) {
        const now = Date.now();
        msg._requested_at = new Date(now).toISOString();
        // Pin the deadline to an instant on arrival. A replay of this same frame after a
        // reconnect resolves to the SAME instant, so the countdown stays honest instead
        // of restarting; a frame carrying no usable deadline stays undefined (never
        // timed from arrival — see deadline.ts).
        const deadline = deadlineFromFrame(msg, now);
        if (deadline != null) msg._deadline_ms = deadline;
        this.listeners.request?.(msg as FillRequest);
        return;
      }
      // Another keeper (or a timeout) resolved this request — drop our prompt for it.
      if (msg.type === 'request_resolved' && msg.request_id) {
        this.listeners.resolved?.(String(msg.request_id));
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // a superseded socket closing — don't touch state
      this.ws = null;
      if (this.opened) {
        // Revoking a device hangs up its live sockets with 1008, so this is the usual
        // path when the user revokes while the phone is connected.
        if (isRevocationSignal({ kind: this.credentialKind, code: ev?.code, reason: ev?.reason })) {
          this.setState('reconnecting');
          this.listeners.revoked?.();
          return;
        }
        // Was connected and dropped — ordinary reconnect.
        this.setState('reconnecting');
        this.scheduleReconnect();
      } else {
        // Never opened: the handshake failed. A browser WebSocket can't read the
        // HTTP status of a rejected handshake, so probe over HTTP to tell a wrong
        // token (401/403) apart from a network/server problem.
        void this.diagnoseFailure();
      }
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  // Probe an authenticated endpoint to classify a failed handshake. 401/403 means
  // the token is wrong/expired → 'unauthorized' (stop retrying until reconfigured);
  // anything else is treated as a transient network issue → keep reconnecting.
  private async diagnoseFailure() {
    let status = 0;
    try {
      const res = await CapacitorHttp.get({
        url: this.baseUrl.replace(/\/+$/, '') + '/api/sessions/fill-history?limit=1',
        headers: { Authorization: 'Bearer ' + this.apiKey },
        connectTimeout: 8000,
        readTimeout: 8000,
      });
      status = res.status;
    } catch {
      status = 0; // network/DNS error — not an auth verdict
    }
    if (this.stopped || this.ws) return; // superseded by a newer attempt
    if (isRevocationSignal({ kind: this.credentialKind, httpStatus: status })) {
      // A refused DEVICE token is recoverable without the user: drop it and come back
      // on the account key (the app re-enrolls if the service still offers it). Going
      // to 'unauthorized' here instead would strand a working phone behind an
      // "open Settings" message it cannot act on — the loop issue #12 rules out.
      this.setState('reconnecting');
      this.listeners.revoked?.();
      return;
    }
    if (status === 401 || status === 403) {
      this.setState('unauthorized'); // don't hammer the server with a known-bad token
      return;
    }
    this.setState('reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped) {
      this.setState('disconnected');
      return;
    }
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoff = Math.min(this.backoff * 2, 30000);
      this.connect();
    }, this.backoff);
  }

  // Force a brand-new socket. Used on an FCM wake from deep background: the existing
  // socket is usually a zombie — readyState still OPEN, but the server couldn't reach
  // us (that's why it pushed), so connect() alone would short-circuit and the server's
  // pending-request replay would never run. Tear the old socket down and reconnect.
  reconnect() {
    this.stopped = false;
    const old = this.ws;
    this.ws = null; // so connect()'s "already OPEN/CONNECTING" guard doesn't bail
    try {
      old?.close();
    } catch {
      /* ignore */
    }
    this.connect();
  }

  disconnect() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    this.setState('disconnected');
  }

  private send(obj: unknown) {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
      }
    } catch {
      /* ignore */
    }
  }

  // Register this device's FCM token so the service can send a content-free wake-push
  // when a request arrives while the app is deep-backgrounded. The token only enables
  // a "doorbell"; the actual request still flows over this authenticated socket.
  setFcmToken(token: string) {
    this.fcmToken = token || '';
    this.sendFcmToken();
  }

  private sendFcmToken() {
    if (this.fcmToken) this.send({ type: 'fcm_token', token: this.fcmToken });
  }

  // Publish this device's identity + vault state (src/lib/device.ts). It rides on `hello`
  // for a fresh socket; a state that CHANGES mid-connection (first vault sync, a re-pair,
  // a key mismatch) is re-announced as `device_info` — the companion frame the service
  // dispatches alongside hello (remote-browser-service server/api/keeper.py:171). An
  // unchanged state sends nothing. Inert metadata only: no password, no derived key, and
  // no secret_id for a legacy v1 key (vaultCrypto.ts's vaultKeyReport).
  setDeviceReport(report: DeviceReport) {
    this.deviceReport = report;
    const json = JSON.stringify(report);
    if (json === this.sentReport) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: 'device_info', ...report });
      this.sentReport = json;
    }
  }

  submit(requestId: string, values: { selector: string; value: string }[]) {
    this.send({ type: 'fill_response', request_id: requestId, values });
  }

  // A decline may carry an OPTIONAL short note explaining it ("wrong account", "I did
  // it myself"), so the agent gets more than a bare `cancelled` to act on. It rides on
  // the existing fill_response frame as `reason` — the same field name the desktop
  // Keeper already sends on its ui_failed cancel (remote-browser-keeper src/main.js:593)
  // — so no new transport is introduced: a service that does not read it yet simply
  // ignores it and the decline behaves exactly as before. The note is ordinary text
  // typed by the user; field values are never sourced into it, and an empty/whitespace
  // note is omitted entirely so a plain dismiss stays byte-identical to today's frame.
  cancel(requestId: string, reason?: string) {
    const note = normalizeDeclineReason(reason);
    this.send({ type: 'fill_response', request_id: requestId, cancelled: true, ...(note ? { reason: note } : {}) });
  }
}

// App-wide singleton.
export const keeper = new KeeperClient();
