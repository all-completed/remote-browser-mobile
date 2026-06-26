// Keeper WebSocket client — ported from remote-browser-keeper/src/main.js.
// Connects to the service's /api/keeper/ws, receives fill_requests, and sends the
// user-supplied values back. The token is carried in the WebSocket subprotocol
// (never the URL). Values are sent only over this authenticated socket — never
// logged, never exposed to any model.
import { CapacitorHttp } from '@capacitor/core';

export interface FillField {
  selector: string;
  label?: string;
  field?: string; // password | code | login | email | text
  length?: number;
  format?: string;
  generate?: boolean; // Keeper generates a strong value for this field (e.g. new password)
}

export interface FillRequest {
  request_id: string;
  session_id?: string;
  url?: string;
  message?: string;
  screenshot?: string; // single proof image (data URL)
  fields: FillField[];
  _requested_at?: string;
}

// 'unauthorized' = the service rejected the token (wrong/expired key).
export type ConnState = 'connected' | 'reconnecting' | 'disconnected' | 'unauthorized';

interface Listeners {
  state?: (s: ConnState) => void;
  request?: (r: FillRequest) => void;
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
  state: ConnState = 'disconnected';
  private listeners: Listeners = {};

  configure(wsUrl: string, apiKey: string, baseUrl = '') {
    this.wsUrl = wsUrl;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
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
      this.send({ type: 'hello', app: 'remote-browser-mobile', version: '0.1.0' });
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
        msg._requested_at = new Date().toISOString();
        this.listeners.request?.(msg as FillRequest);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // a superseded socket closing — don't touch state
      this.ws = null;
      if (this.opened) {
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

  submit(requestId: string, values: { selector: string; value: string }[]) {
    this.send({ type: 'fill_response', request_id: requestId, values });
  }

  cancel(requestId: string) {
    this.send({ type: 'fill_response', request_id: requestId, cancelled: true });
  }
}

// App-wide singleton.
export const keeper = new KeeperClient();
