// Saved field values (passwords and other entered values) the user chose to keep,
// so future fill_requests for the same field prefill — or fill automatically. Three
// scopes, mirroring the desktop keeper:
//   - "session" : in-memory only, gone when the app process is killed.
//   - "forever" : persisted via Capacitor Preferences (app-private storage).
//   - "vault"   : cached locally AND end-to-end encrypted + synced across every
//                 paired Keeper via /api/vault (see vault.ts / vaultCrypto.ts). The
//                 local cache is the source for auto-fill; App.tsx pushes/pulls it.
// Keyed by base URL + session + host + selector. Values stay on this device, are
// only ever sent back over the authenticated keeper socket, and never reach any model.
// (Vault entries drop the base URL from their key — the vault is already per-user via
// the API — so the blob is identical across the desktop and mobile Keepers.)
import { Preferences } from '@capacitor/preferences';

const KEY = 'rbkeeper.fields';
const VAULT_KEY = 'rbkeeper.vault';

export type Scope = 'session' | 'forever' | 'vault';

// A vault entry carries an updated_at for last-write-wins merge; a delete leaves a
// { deleted, updated_at } tombstone so it propagates to the other devices.
type VaultEntry = { value: string; auto: boolean; updated_at: string } | { deleted: true; updated_at: string };
const isLive = (e?: VaultEntry): e is { value: string; auto: boolean; updated_at: string } =>
  !!e && typeof e === 'object' && !(e as any).deleted;
const nowIso = () => new Date().toISOString();
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
  // Trim session + selector so incidental whitespace in the agent-supplied selector
  // can't hash the same field to a second key (which both duplicates the saved-fields
  // entry and makes auto-fill miss → re-prompt → re-save).
  return `${baseUrl || ''}|${(session || '').trim()}|${host}|${(selector || '').trim()}`;
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

// --- Vault local cache (the mergeable copy App.tsx syncs to /api/vault) ---
// Keyed by session|host|selector (no base URL) so it matches the desktop blob.
function vaultKeyOf(session: string, host: string, selector: string): string {
  return `${(session || '').trim()}|${host}|${(selector || '').trim()}`;
}
async function loadVaultFields(): Promise<Record<string, VaultEntry>> {
  try {
    const { value } = await Preferences.get({ key: VAULT_KEY });
    if (value) {
      const o = JSON.parse(value);
      if (o && typeof o === 'object' && o.fields && typeof o.fields === 'object') {
        return o.fields as Record<string, VaultEntry>;
      }
    }
  } catch {
    /* ignore */
  }
  return {};
}
async function writeVaultFields(fields: Record<string, VaultEntry>): Promise<void> {
  await Preferences.set({ key: VAULT_KEY, value: JSON.stringify({ schema: 1, fields: fields || {} }) });
}
// Tombstone a key when it moves to a non-vault scope, so the removal syncs too.
async function clearVault(session: string, host: string, selector: string): Promise<void> {
  const vk = vaultKeyOf(session, host, selector);
  const fields = await loadVaultFields();
  if (isLive(fields[vk])) {
    fields[vk] = { deleted: true, updated_at: nowIso() };
    await writeVaultFields(fields);
  }
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
  const vaultFields = await loadVaultFields();
  const ve = vaultFields[vaultKeyOf(session, host, selector)];
  if (isLive(ve)) return { value: ve.value, auto: !!ve.auto, scope: 'vault' };
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
    await clearVault(session, host, selector);
    return;
  }
  if (scope === 'vault') {
    memory.delete(k);
    const p = await loadPersisted();
    if (k in p) {
      delete p[k];
      await writePersisted(p);
    }
    const fields = await loadVaultFields();
    fields[vaultKeyOf(session, host, selector)] = { value, auto: !!auto, updated_at: nowIso() };
    await writeVaultFields(fields);
    return;
  }
  // forever
  memory.delete(k);
  const p = await loadPersisted();
  p[k] = entry;
  await writePersisted(p);
  await clearVault(session, host, selector);
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
  await clearVault(session, host, selector); // tombstone so the delete propagates
}

// All saved entries (metadata only — NEVER the value) for the management screen.
export async function listSaved(): Promise<SavedMeta[]> {
  // Dedup by normalized session|host|selector so the same field never shows twice;
  // a persisted "forever" entry wins over an in-memory "session" one.
  const byKey = new Map<string, SavedMeta>();
  const add = (meta: SavedMeta, precedence: boolean) => {
    const norm = `${meta.session.trim()}|${meta.host}|${meta.selector.trim()}`;
    if (precedence || !byKey.has(norm)) byKey.set(norm, meta);
  };
  const addKeyed = (k: string, scope: 'session' | 'forever', auto: boolean) => {
    const p = parseKey(k);
    if (p) add({ ...p, scope, auto }, scope === 'forever');
  };
  for (const [k, e] of memory.entries()) addKeyed(k, 'session', !!e.auto);
  const persisted = await loadPersisted();
  for (const k of Object.keys(persisted)) addKeyed(k, 'forever', !!persisted[k].auto);
  // Vault entries are keyed session|host|selector (no base URL); surface the live ones.
  const vaultFields = await loadVaultFields();
  for (const [vk, e] of Object.entries(vaultFields)) {
    if (!isLive(e)) continue;
    const i1 = vk.indexOf('|');
    const i2 = vk.indexOf('|', i1 + 1);
    if (i1 < 0 || i2 < 0) continue;
    const session = vk.slice(0, i1);
    const host = vk.slice(i1 + 1, i2);
    const selector = vk.slice(i2 + 1);
    add({ baseUrl: '', session, host, selector, scope: 'vault', auto: !!e.auto }, true);
  }
  // Synced "vault" fields first, then on-device "forever", then in-memory "session".
  const rank: Record<string, number> = { vault: 0, forever: 1, session: 2 };
  return [...byKey.values()].sort((a, b) => (rank[a.scope] ?? 3) - (rank[b.scope] ?? 3));
}

// --- Vault sync helpers (used by App.tsx against /api/vault via vault.ts) ---
// The full local vault field map (INCLUDING tombstones) to push to the server.
export async function localVaultMap(): Promise<Record<string, VaultEntry>> {
  return loadVaultFields();
}
// Merge a decrypted remote field map into the local cache (last-write-wins by
// updated_at, tie → remote), persist it, and return the merged map to push back.
export async function mergeRemoteVault(remoteFields: Record<string, VaultEntry>): Promise<Record<string, VaultEntry>> {
  const local = await loadVaultFields();
  const merged: Record<string, VaultEntry> = {};
  const at = (e?: VaultEntry) => (e && typeof (e as any).updated_at === 'string' ? (e as any).updated_at : '');
  for (const k of new Set([...Object.keys(remoteFields || {}), ...Object.keys(local || {})])) {
    const r = remoteFields && remoteFields[k];
    const l = local && local[k];
    merged[k] = r && l ? (at(l) > at(r) ? l : r) : r || l;
  }
  await writeVaultFields(merged);
  return merged;
}

export async function forgetMeta(m: { baseUrl: string; session: string; host: string; selector: string }): Promise<void> {
  await forget(m.baseUrl, m.session, m.host, m.selector);
}

export async function forgetAll(): Promise<void> {
  memory.clear();
  await writePersisted({});
  // Tombstone every live vault entry so the wipe propagates to paired devices too.
  const fields = await loadVaultFields();
  let changed = false;
  for (const k of Object.keys(fields)) {
    if (isLive(fields[k])) {
      fields[k] = { deleted: true, updated_at: nowIso() };
      changed = true;
    }
  }
  if (changed) await writeVaultFields(fields);
}
