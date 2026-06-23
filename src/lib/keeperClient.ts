// Keeper WebSocket client — ported from remote-browser-keeper/src/main.js.
// Connects to the service's /api/keeper/ws, receives fill_requests, and sends the
// user-supplied values back. The token is carried in the WebSocket subprotocol
// (never the URL). Values are sent only over this authenticated socket — never
// logged, never exposed to any model.

export interface FillField {
  selector: string;
  label?: string;
  field?: string; // password | code | login | email | text
  length?: number;
  format?: string;
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

export type ConnState = 'connected' | 'reconnecting' | 'disconnected';

interface Listeners {
  state?: (s: ConnState) => void;
  request?: (r: FillRequest) => void;
}

export class KeeperClient {
  private ws: WebSocket | null = null;
  private wsUrl = '';
  private apiKey = '';
  private backoff = 1000; // ms, capped at 30s
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  state: ConnState = 'disconnected';
  private listeners: Listeners = {};

  configure(wsUrl: string, apiKey: string) {
    this.wsUrl = wsUrl;
    this.apiKey = apiKey;
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
    if (this.ws) return;
    if (!this.wsUrl || !this.apiKey) {
      this.setState('disconnected');
      return;
    }
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
      this.backoff = 1000;
      this.setState('connected');
      this.send({ type: 'hello', app: 'remote-browser-mobile', version: '0.1.0' });
    };
    ws.onmessage = (ev) => {
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
      if (this.ws === ws) this.ws = null;
      this.setState('reconnecting');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
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

  submit(requestId: string, values: { selector: string; value: string }[]) {
    this.send({ type: 'fill_response', request_id: requestId, values });
  }

  cancel(requestId: string) {
    this.send({ type: 'fill_response', request_id: requestId, cancelled: true });
  }
}

// App-wide singleton.
export const keeper = new KeeperClient();
