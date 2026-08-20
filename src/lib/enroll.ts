// Device enrollment: trading the shared account key for a credential of this phone's own.
//
// Until now every Keeper on an account presented the SAME key — the one the pairing QR
// copies over verbatim (pair.ts) — so a device's identity was whatever it claimed in its
// `hello` frame, and the only way to cut this phone off was to rotate the account key,
// which cuts off the desktop Keeper and every script at the same time. The service now
// mints per-device tokens (vasyaod/remote-browser-service#33); this is the mobile half
// (issue #12), and it is the twin of `enroll.js` in remote-browser-keeper — same decision
// table, same names, so the two clients cannot quietly drift apart.
//
// Two rules shape everything here, and on this app they bind harder than on the desktop:
// updates arrive by manual sideload, so an installed version may lag for months.
//
//   1. ADDITIVE, NEVER A CUT. The shared key keeps working forever. We enroll only when
//      the service offers it, we keep the shared key afterwards, and any doubt about the
//      device token (revoked, unreadable, service too old) falls back to the shared key
//      rather than to a phone that can no longer answer a fill request.
//   2. THE TOKEN IS A CREDENTIAL. It goes to secure storage (Android Keystore-backed),
//      never Preferences, and is presented in a header or the WS subprotocol — never a
//      query param, which the service refuses for device tokens by design.
export const ENROLL_PATH = '/api/keeper/devices/enroll';

// How long to wait before asking again after an answer that might change (a 5xx, a
// network blip). An outright "this service has no such endpoint" is remembered for the
// run instead — see `enrollmentState`.
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000; // 6h

export type EnrollOutcome = 'ok' | 'unsupported' | 'unauthorized' | 'error';
export type CredentialKind = 'device' | 'account' | 'none';

export interface EnrollmentState {
  supported: boolean | null; // null = not asked yet this run
  lastAttempt: number;
  attempts: number;
  lastError: string;
}

export interface EnrollResult {
  ok: boolean;
  token?: string;
  deviceId?: string;
  secretBound?: boolean;
  reason?: EnrollOutcome;
  status?: number;
}

// What a service's answer to an enrollment attempt MEANS for us.
//
//   ok           — enrolled; use the token from here on
//   unsupported  — this service predates #33 (404), or has no metadata store wired
//                  (503). Not an error: it is capability negotiation, and the shared key
//                  keeps working. Do not ask again this run.
//   unauthorized — the credential we presented isn't valid (401/403). Enrolling cannot
//                  fix that; the connection itself reports the real problem.
//   error        — anything transient. Try again later.
export function classifyEnrollStatus(status: number): EnrollOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 501 || status === 503) return 'unsupported';
  if (status === 401 || status === 403) return 'unauthorized';
  return 'error';
}

// Which credential to present. The device token wins when we have one; otherwise the
// shared account key, which is exactly today's behaviour. Tagged, because the caller has
// to know which of the two was refused when a socket is rejected.
export function pickCredential(
  opts: { deviceToken?: string; apiKey?: string } = {},
): { token: string; kind: CredentialKind } {
  const t = (opts.deviceToken || '').trim();
  if (t) return { token: t, kind: 'device' };
  const k = (opts.apiKey || '').trim();
  return k ? { token: k, kind: 'account' } : { token: '', kind: 'none' };
}

// Did the service just tell us this device's token is no longer good?
//
// `kind` is load-bearing: the very same 401 means "this device was revoked" for a device
// token and "the account key is wrong" for the shared key. Acting on the second would
// throw away a perfectly good enrollment because the user mistyped their key — so nothing
// here fires unless we presented a device token. On this platform a browser WebSocket
// can't even read the rejected handshake's status, so the caller supplies what its HTTP
// probe found (keeperClient.diagnoseFailure).
export function isRevocationSignal(
  opts: { kind?: string; httpStatus?: number; code?: number; reason?: string } = {},
): boolean {
  if (opts.kind !== 'device') return false;
  if (opts.httpStatus === 401 || opts.httpStatus === 403) return true;
  if (opts.code === 1008) return true;
  return /revoke|not enrolled/i.test(String(opts.reason || ''));
}

// Where enrollment stands this run. Deliberately NOT persisted: "this service doesn't
// support enrollment" is a fact about the service, and the service is upgraded far more
// often than this app is — persisting it would strand a sideloaded install on the shared
// key long after the service caught up.
export function enrollmentState(): EnrollmentState {
  return { supported: null, lastAttempt: 0, attempts: 0, lastError: '' };
}

// Should we try (again) right now? Only when there is nothing better to present, the
// service hasn't already said it can't, and we aren't hammering it.
export function shouldEnroll(
  state: EnrollmentState,
  opts: { hasDeviceToken?: boolean; hasApiKey?: boolean; now?: number } = {},
): boolean {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  if (opts.hasDeviceToken || !opts.hasApiKey) return false; // nothing to upgrade, or nothing to upgrade WITH
  if (state.supported === false) return false;              // asked and answered for this run
  if (!state.lastAttempt) return true;
  return now - state.lastAttempt >= RETRY_AFTER_MS;
}

type HttpPost = (opts: any) => Promise<{ status: number; data?: any }>;

// Ask the service for a token of this phone's own.
//
// `identity` is the same non-secret block already sent in `hello` ({id, name, platform,
// app_version}); the service assigns the authoritative device id, so ours is a naming
// hint at most. Never throws — a failed enrollment must never take down a Keeper that is
// otherwise answering requests.
export async function enrollDevice(opts: {
  baseUrl: string;
  apiKey: string;
  identity?: { name?: string; platform?: string; app_version?: string };
  post?: HttpPost;
}): Promise<EnrollResult> {
  const { baseUrl, apiKey, identity = {} } = opts;
  if (!baseUrl || !apiKey) return { ok: false, reason: 'unauthorized', status: 0 };
  // Imported lazily so this module — the whole decision table above — can be loaded and
  // tested under plain Node, where @capacitor/core does not resolve.
  const post: HttpPost = opts.post || (async (o) => (await import('@capacitor/core')).CapacitorHttp.post(o) as any);
  try {
    const res = await post({
      url: baseUrl.replace(/\/+$/, '') + ENROLL_PATH,
      // Header, not query — the service rejects device tokens on the URL, and the key we
      // present to obtain one has no business there either.
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      data: {
        device_name: identity.name || undefined,
        platform: identity.platform || undefined,
        app_version: identity.app_version || undefined,
      },
      connectTimeout: 10000,
      readTimeout: 10000,
    });
    const outcome = classifyEnrollStatus(res.status);
    if (outcome !== 'ok') return { ok: false, reason: outcome, status: res.status };
    // CapacitorHttp parses JSON responses; a string body means a proxy answered instead.
    let body: any = res.data;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return { ok: false, reason: 'error', status: res.status };
    const device = (body && body.device) || {};
    return {
      ok: true,
      token,
      // The service assigns the id; adopting it keeps our reports pointing at the record
      // the user sees — and revokes — on the Devices page. The enroll response spells it
      // `device_id` (public_device_record), the same key the devices list uses; `id` is
      // accepted too so a future/older service shape doesn't silently yield ''.
      deviceId: typeof device.device_id === 'string' ? device.device_id
        : typeof device.id === 'string' ? device.id : '',
      // False when enrolled from a browser login rather than a key: the device fills
      // fields fine but cannot be the key authority for NEW encrypted sessions. We only
      // ever enroll with the account key, so this should be true.
      secretBound: !!(body && body.secret_bound),
    };
  } catch {
    return { ok: false, reason: 'error', status: 0 };
  }
}
