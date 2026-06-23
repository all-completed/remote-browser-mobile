// Saved field values (passwords and other entered values) the user chose to keep,
// so future fill_requests for the same field prefill — or fill automatically. Two
// scopes, mirroring the desktop keeper:
//   - "session" : in-memory only, gone when the app process is killed.
//   - "forever" : persisted via Capacitor Preferences (app-private storage).
// Keyed by base URL + session + host + selector. Values stay on this device, are
// only ever sent back over the authenticated keeper socket, and never reach any model.
import { Preferences } from '@capacitor/preferences';

const KEY = 'rbkeeper.fields';

export type Scope = 'session' | 'forever';
export interface SavedEntry {
  value: string;
  auto: boolean;
}
export interface SavedMeta {
  baseUrl: string;
  session: string;
  host: string;
  selector: string;
  scope: Scope;
  auto: boolean;
}

const memory = new Map<string, SavedEntry>(); // "session" scope (cleared when the app dies)

export function hostFromUrl(u?: string): string {
  if (!u) return '';
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function keyOf(baseUrl: string, session: string, host: string, selector: string): string {
  return `${baseUrl || ''}|${session || ''}|${host}|${selector}`;
}

function parseKey(k: string): { baseUrl: string; session: string; host: string; selector: string } | null {
  const parts = k.split('|');
  if (parts.length < 4) return null;
  const [baseUrl, session, host, ...rest] = parts;
  return { baseUrl, session, host, selector: rest.join('|') };
}

async function loadPersisted(): Promise<Record<string, SavedEntry>> {
  try {
    const { value } = await Preferences.get({ key: KEY });
    if (value) {
      const o = JSON.parse(value);
      if (o && typeof o === 'object') return o as Record<string, SavedEntry>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

async function writePersisted(obj: Record<string, SavedEntry>): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(obj) });
}

// Returns { value, scope, auto } or null. auto means "fill automatically next time".
export async function getSaved(
  baseUrl: string,
  session: string,
  host: string,
  selector: string,
): Promise<{ value: string; auto: boolean; scope: Scope } | null> {
  const k = keyOf(baseUrl, session, host, selector);
  const mem = memory.get(k);
  if (mem) return { value: mem.value, auto: !!mem.auto, scope: 'session' };
  const persisted = await loadPersisted();
  if (Object.prototype.hasOwnProperty.call(persisted, k)) {
    const e = persisted[k];
    return { value: e.value, auto: !!e.auto, scope: 'forever' };
  }
  return null;
}

export async function saveValue(
  baseUrl: string,
  session: string,
  host: string,
  selector: string,
  value: string,
  scope: Scope,
  auto: boolean,
): Promise<void> {
  if (!host || !selector) return;
  const k = keyOf(baseUrl, session, host, selector);
  const entry: SavedEntry = { value, auto: !!auto };
  if (scope === 'session') {
    memory.set(k, entry);
    const p = await loadPersisted();
    if (k in p) {
      delete p[k];
      await writePersisted(p);
    }
    return;
  }
  // forever
  memory.delete(k);
  const p = await loadPersisted();
  p[k] = entry;
  await writePersisted(p);
}

export async function forget(baseUrl: string, session: string, host: string, selector: string): Promise<void> {
  if (!host || !selector) return;
  const k = keyOf(baseUrl, session, host, selector);
  memory.delete(k);
  const p = await loadPersisted();
  if (k in p) {
    delete p[k];
    await writePersisted(p);
  }
}

// All saved entries (metadata only — NEVER the value) for the management screen.
export async function listSaved(): Promise<SavedMeta[]> {
  const out: SavedMeta[] = [];
  for (const [k, e] of memory.entries()) {
    const p = parseKey(k);
    if (p) out.push({ ...p, scope: 'session', auto: !!e.auto });
  }
  const persisted = await loadPersisted();
  for (const k of Object.keys(persisted)) {
    const p = parseKey(k);
    if (p) out.push({ ...p, scope: 'forever', auto: !!persisted[k].auto });
  }
  return out;
}

export async function forgetMeta(m: { baseUrl: string; session: string; host: string; selector: string }): Promise<void> {
  await forget(m.baseUrl, m.session, m.host, m.selector);
}

export async function forgetAll(): Promise<void> {
  memory.clear();
  await writePersisted({});
}
