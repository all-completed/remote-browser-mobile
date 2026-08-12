// Request history. The list comes from the server (rb/{user_id}/keeper-history.jsonl
// via GET /api/sessions/fill-history) — status + field metadata only, never values.
// Proof screenshots are cached locally per request_id and evicted by reconciling
// against the server list; the service keeps the durable copy (rb/{user_id}/
// keeper-proofs/{request_id}.jpg) and serves it, so anything missing locally —
// a fill done on the desktop Keeper, or a cache we pruned — is still viewable.
import { CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';

export interface HistoryField {
  selector?: string;
  label?: string;
  field?: string;
  length?: number | null;
  format?: string | null;
}

export interface HistoryItem {
  request_id: string;
  session_id?: string;
  status?: string;
  url?: string;
  message?: string;
  fields?: HistoryField[];
  created_at?: number;
  completed_at?: number;
  // Set by the service only when a proof screenshot was actually written for this
  // request; absent means there is nothing to fetch (records predating proof
  // retention never carry it either).
  has_screenshot?: boolean;
}

const SHOT_DIR = 'screenshots';

export async function fetchHistory(baseUrl: string, apiKey: string, limit = 200): Promise<HistoryItem[]> {
  const url = baseUrl.replace(/\/+$/, '') + '/api/sessions/fill-history?limit=' + limit;
  const res = await CapacitorHttp.get({ url, headers: { Authorization: 'Bearer ' + apiKey } });
  let data: any = res.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = {};
    }
  }
  const items: HistoryItem[] = Array.isArray(data?.requests) ? data.requests : [];
  return items;
}

function safeId(id: string): string | null {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

// The server history only knows a request was "filled" — it can't tell a silent
// auto-fill from a manual one. So we remember locally which requests THIS device
// auto-filled, and the History page relabels those as "autofilled" (matching the
// desktop keeper). Values are never involved — just request_ids.
const AUTOFILLED_KEY = 'autofilled_request_ids';
const AUTOFILLED_MAX = 500;

export async function markAutofilled(requestId: string): Promise<void> {
  const id = safeId(requestId);
  if (!id) return;
  try {
    const ids = await getAutofilledIds();
    if (ids.has(id)) return;
    const arr = [...ids, id].slice(-AUTOFILLED_MAX); // cap, keep most recent
    await Preferences.set({ key: AUTOFILLED_KEY, value: JSON.stringify(arr) });
  } catch {
    /* best effort */
  }
}

export async function getAutofilledIds(): Promise<Set<string>> {
  try {
    const { value } = await Preferences.get({ key: AUTOFILLED_KEY });
    const arr = value ? JSON.parse(value) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

/** Persist the proof screenshot (data URL) for a request on this device. */
export async function saveScreenshot(requestId: string, dataUrl: string): Promise<void> {
  const id = safeId(requestId);
  if (!id || !/^data:image\//.test(dataUrl)) return;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return;
  try {
    await Filesystem.mkdir({ path: SHOT_DIR, directory: Directory.Data, recursive: true }).catch(() => {});
    await Filesystem.writeFile({
      path: `${SHOT_DIR}/${id}.jpg`,
      data: dataUrl.slice(comma + 1), // base64 (no prefix)
      directory: Directory.Data,
    });
  } catch {
    /* best effort */
  }
}

export async function readScreenshot(requestId: string): Promise<string | null> {
  const id = safeId(requestId);
  if (!id) return null;
  try {
    const r = await Filesystem.readFile({ path: `${SHOT_DIR}/${id}.jpg`, directory: Directory.Data });
    return 'data:image/jpeg;base64,' + (r.data as string);
  } catch {
    return null;
  }
}

/** 'absent' = the server confirms there is no proof; 'error' = we couldn't ask it. */
export type ScreenshotResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: 'absent' | 'error' };

/**
 * Fetch the proof screenshot from the service. Works for fills performed on ANY
 * device (the desktop Keeper, another phone) — the WS `fill_request` frame only
 * ever reaches the device that was connected at the time.
 */
export async function fetchScreenshot(baseUrl: string, apiKey: string, requestId: string): Promise<ScreenshotResult> {
  const id = safeId(requestId);
  if (!id || !apiKey) return { ok: false, reason: 'absent' };
  const url = baseUrl.replace(/\/+$/, '') + '/api/sessions/fill-history/' + id + '/screenshot';
  let res;
  try {
    res = await CapacitorHttp.get({
      url,
      headers: { Authorization: 'Bearer ' + apiKey },
      responseType: 'blob', // JPEG bytes come back base64-encoded in `data`
      connectTimeout: 15000,
      readTimeout: 15000,
    });
  } catch {
    return { ok: false, reason: 'error' }; // offline / DNS / TLS — not a verdict
  }
  // 404 is the service's "expired, or none was ever captured" — the only honest
  // "nothing to show". Anything else non-2xx (401, 5xx) is a failure to ask.
  if (res.status === 404) return { ok: false, reason: 'absent' };
  if (res.status < 200 || res.status >= 300) return { ok: false, reason: 'error' };
  // Android encodes with Base64.DEFAULT, which line-wraps; strip the whitespace.
  const b64 = (typeof res.data === 'string' ? res.data : '').replace(/\s+/g, '');
  if (!b64) return { ok: false, reason: 'error' };
  return { ok: true, dataUrl: 'data:image/jpeg;base64,' + b64 };
}

/** request_ids whose proof screenshot is cached on this device. */
export async function listCachedScreenshotIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const name of await listShotFiles()) ids.add(name.slice(0, -4));
  return ids;
}

/**
 * Delete cached screenshots whose request_id is no longer in the server history.
 * Kept deliberately: the local file is now only a cache — the service holds the
 * durable proof for as long as it holds the history record, so pruning costs a
 * round-trip on the next view, never the image itself.
 */
export async function reconcileScreenshots(keepIds: Set<string>): Promise<void> {
  for (const name of await listShotFiles()) {
    if (!keepIds.has(name.slice(0, -4))) {
      await Filesystem.deleteFile({ path: `${SHOT_DIR}/${name}`, directory: Directory.Data }).catch(() => {});
    }
  }
}

async function listShotFiles(): Promise<string[]> {
  try {
    const r = await Filesystem.readdir({ path: SHOT_DIR, directory: Directory.Data });
    return r.files
      .map((entry) => (typeof entry === 'string' ? entry : (entry as any).name))
      .filter((name): name is string => !!name && name.endsWith('.jpg'));
  } catch {
    return []; // dir may not exist yet
  }
}
