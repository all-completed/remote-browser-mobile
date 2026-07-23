// Zero-knowledge vault crypto — the WebCrypto half, byte-for-byte interoperable
// with the desktop Keeper's node:crypto implementation (remote-browser-keeper
// src/vault.js). Both produce/consume the SAME envelope so a vault saved on one
// device decrypts on the other:
//
//   base64( iv(12) ‖ ciphertext ‖ authTag(16) ),  AES-256-GCM,  key = sha256(secret)
//   format = "aesgcm-sha256-v1"
//
// (WebCrypto's AES-GCM output already appends the 16-byte tag to the ciphertext, so
// iv ‖ webcryptoOutput == iv ‖ ciphertext ‖ tag — the exact desktop layout.)
//
// This module has NO Capacitor imports so it runs in a plain browser, in the
// Capacitor webview, and under Node (for the interop test). The HTTP/sync layer
// lives in vault.ts.

export const VAULT_FORMAT = 'aesgcm-sha256-v1';
export const VAULT_SCHEMA = 1;

export type VaultEntry =
  | { value: string; auto: boolean; updated_at: string }
  | { deleted: true; updated_at: string };
export interface VaultBlob {
  schema: number;
  fields: Record<string, VaultEntry>;
}

export function emptyVault(): VaultBlob {
  return { schema: VAULT_SCHEMA, fields: {} };
}

const subtle = (): SubtleCrypto => {
  const c = (globalThis as any).crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto unavailable');
  return c.subtle;
};

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const s = atob(String(b64 || ''));
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function sha256(secret: string): Promise<Uint8Array> {
  const d = await subtle().digest('SHA-256', utf8(String(secret)) as BufferSource);
  return new Uint8Array(d);
}

export async function secretIdOf(secret: string): Promise<string> {
  const h = await sha256(secret);
  return Array.from(h).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function keyOf(secret: string): Promise<CryptoKey> {
  const raw = await sha256(secret); // 32 bytes → AES-256
  return subtle().importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptVault(secret: string, obj: unknown): Promise<string> {
  const iv = (globalThis as any).crypto.getRandomValues(new Uint8Array(12)) as Uint8Array;
  const key = await keyOf(secret);
  const ctTag = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, utf8(JSON.stringify(obj ?? {})) as BufferSource),
  );
  const env = new Uint8Array(iv.length + ctTag.length);
  env.set(iv, 0);
  env.set(ctTag, iv.length);
  return bytesToB64(env);
}

export async function decryptVault<T = VaultBlob>(secret: string, b64: string): Promise<T> {
  const env = b64ToBytes(b64);
  if (env.length < 28) throw new Error('vault ciphertext too short');
  const iv = env.subarray(0, 12);
  const ctTag = env.subarray(12); // ciphertext ‖ tag (WebCrypto wants them together)
  const key = await keyOf(secret);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ctTag as BufferSource);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

// Per-entry last-write-wins merge (higher updated_at wins; tie → remote), so two
// devices always converge. Live entries and { deleted, updated_at } tombstones are
// compared the same way, letting deletes propagate.
export function mergeFieldMaps(
  remote: Record<string, VaultEntry>,
  local: Record<string, VaultEntry>,
): Record<string, VaultEntry> {
  const out: Record<string, VaultEntry> = {};
  const at = (e?: VaultEntry) => (e && typeof (e as any).updated_at === 'string' ? (e as any).updated_at : '');
  for (const k of new Set([...Object.keys(remote || {}), ...Object.keys(local || {})])) {
    const r = remote && remote[k];
    const l = local && local[k];
    out[k] = r && l ? (at(l) > at(r) ? l : r) : r || l;
  }
  return out;
}
