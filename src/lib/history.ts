// Request history. The list comes from the server (rb/{user_id}/keeper-history.jsonl
// via GET /api/sessions/fill-history) — status + field metadata only, never values.
// Proof screenshots are cached locally per request_id and evicted by reconciling
// against the server list.
import { CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

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

/** Delete cached screenshots whose request_id is no longer in the server history. */
export async function reconcileScreenshots(keepIds: Set<string>): Promise<void> {
  try {
    const r = await Filesystem.readdir({ path: SHOT_DIR, directory: Directory.Data });
    for (const entry of r.files) {
      const name = typeof entry === 'string' ? entry : (entry as any).name;
      if (!name || !name.endsWith('.jpg')) continue;
      if (!keepIds.has(name.slice(0, -4))) {
        await Filesystem.deleteFile({ path: `${SHOT_DIR}/${name}`, directory: Directory.Data }).catch(() => {});
      }
    }
  } catch {
    /* dir may not exist yet */
  }
}
