// Zero-knowledge vault crypto — the WebCrypto half, byte-for-byte interoperable with
// the desktop Keeper's node:crypto implementation (remote-browser-keeper src/vault.js).
//
// KEY MODEL (v2). The vault is encrypted with a DEDICATED vault password, independent of
// the session secret, provisioned to this device via the pair QR. Two independent values
// are derived with domain separation so the identifier can NEVER equal the key (the v1
// bug: secret_id === the AES key, which the service stored in plaintext):
//   master   = sha256(password)                     [aesgcm-sha256-v2, high-entropy]
//            = pbkdf2_sha256(password, salt, ITER)   [aesgcm-pbkdf2-v2, user password]
//   encKey   = master                                (AES-256-GCM key)
//   secret_id= sha256("rbvault-id-v2" ‖ master)      (opaque tag; reveals nothing of encKey)
//
// Envelope (base64), identical bytes to node:crypto:
//   aesgcm-sha256-v2 :        iv(12) ‖ ciphertext ‖ tag(16)
//   aesgcm-pbkdf2-v2 : salt(16) ‖ iv(12) ‖ ciphertext ‖ tag(16)
//
// No Capacitor imports, so it runs in a plain browser, the Capacitor webview, and under
// Node (the interop test). The HTTP/sync layer lives in vault.ts.

export const FORMAT_V1 = 'aesgcm-sha256-v1'; // legacy (decrypt-only, migration)
export const FORMAT_SHA256_V2 = 'aesgcm-sha256-v2';
export const FORMAT_PBKDF2_V2 = 'aesgcm-pbkdf2-v2';
export const VAULT_SCHEMA = 1;
export const PBKDF2_ITERATIONS = 210000;
const SALT_BYTES = 16;

export type VaultFormat = typeof FORMAT_SHA256_V2 | typeof FORMAT_PBKDF2_V2;
// A vault key config { password, format, salt? } (salt base64, pbkdf2 only).
export interface VaultKey {
  password: string;
  format: VaultFormat;
  salt?: string;
}

export type VaultEntry =
  | { value: string; auto: boolean; updated_at: string }
  | { deleted: true; updated_at: string };
export interface VaultBlob {
  schema: number;
  fields: Record<string, VaultEntry>;
  // Cards are a desktop-only feature; mobile preserves this collection untouched on sync.
  cards?: Record<string, VaultEntry>;
  cardsMeta?: Record<string, any>;
  // Forward-compat: keep any future collections a newer client adds.
  [k: string]: any;
}

export function emptyVault(): VaultBlob {
  return { schema: VAULT_SCHEMA, fields: {}, cards: {}, cardsMeta: {} };
}

const subtle = (): SubtleCrypto => {
  const c = (globalThis as any).crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto unavailable');
  return c.subtle;
};
const rng = (n: number): Uint8Array => (globalThis as any).crypto.getRandomValues(new Uint8Array(n));

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
function bytesToB64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

const ID_DOMAIN = utf8('rbvault-id-v2');

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', bytes as BufferSource));
}
async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const km = await subtle().importKey('raw', utf8(password) as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    km, 256,
  );
  return new Uint8Array(bits);
}
async function masterFor(format: string, password: string, salt?: Uint8Array): Promise<Uint8Array> {
  if (format === FORMAT_PBKDF2_V2) {
    if (!salt || salt.length !== SALT_BYTES) throw new Error('pbkdf2 vault key missing salt');
    return pbkdf2(password, salt);
  }
  return sha256(utf8(password)); // v1 + sha256-v2
}
async function secretIdFromMaster(master: Uint8Array): Promise<string> {
  return hex(await sha256(concat(ID_DOMAIN, master)));
}
async function aesKey(master: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', master as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Generate a fresh high-entropy vault password (base64url of 32 random bytes).
export function generateVaultKey(): VaultKey {
  return { password: bytesToB64url(rng(32)), format: FORMAT_SHA256_V2 };
}
// Build a user-password key (item 3) with a fresh random salt.
export function userVaultKey(password: string): VaultKey {
  return { password: String(password), format: FORMAT_PBKDF2_V2, salt: bytesToB64(rng(SALT_BYTES)) };
}

export async function encryptVault(key: VaultKey, obj: unknown): Promise<{ ciphertext: string; secret_id: string; format: string }> {
  const format = key.format || FORMAT_SHA256_V2;
  const iv = rng(12);
  let prefix: Uint8Array = new Uint8Array(0);
  let salt: Uint8Array | undefined;
  if (format === FORMAT_PBKDF2_V2) {
    salt = b64ToBytes(String(key.salt || ''));
    if (salt.length !== SALT_BYTES) throw new Error('pbkdf2 vault key missing salt');
    prefix = salt;
  }
  const master = await masterFor(format, key.password, salt);
  const ck = await aesKey(master);
  const ctTag = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, ck, utf8(JSON.stringify(obj ?? {})) as BufferSource),
  );
  return { ciphertext: bytesToB64(concat(prefix, iv, ctTag)), secret_id: await secretIdFromMaster(master), format };
}

// Open a stored blob using OUR password but the blob's own salt/format.
async function openEnvelope(format: string, password: string, b64: string): Promise<{ master: Uint8Array; body: Uint8Array }> {
  const env = b64ToBytes(b64);
  let off = 0;
  let salt: Uint8Array | undefined;
  if (format === FORMAT_PBKDF2_V2) {
    if (env.length < SALT_BYTES + 28) throw new Error('vault ciphertext too short');
    salt = env.subarray(0, SALT_BYTES);
    off = SALT_BYTES;
  } else if (env.length < 28) {
    throw new Error('vault ciphertext too short');
  }
  return { master: await masterFor(format, password, salt), body: env.subarray(off) };
}

export async function decryptVault<T = VaultBlob>(key: VaultKey, b64: string, format?: string): Promise<T> {
  const fmt = format || key.format || FORMAT_SHA256_V2;
  const { master, body } = await openEnvelope(fmt, key.password, b64);
  const iv = body.subarray(0, 12);
  const ctTag = body.subarray(12);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await aesKey(master), ctTag as BufferSource);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

// The secret_id a stored blob of `format` would carry if it were ours (pull-time
// wrong-password check). v1 blobs used the legacy hex(master) id.
export async function expectedSecretId(key: VaultKey, b64: string, format?: string): Promise<string> {
  const fmt = format || key.format || FORMAT_SHA256_V2;
  const { master } = await openEnvelope(fmt, key.password, b64);
  return fmt === FORMAT_V1 ? hex(master) : secretIdFromMaster(master);
}

// Per-entry last-write-wins merge (higher updated_at wins; tie → remote), so two devices
// always converge. Live entries and { deleted, updated_at } tombstones compare the same
// way, letting deletes propagate.
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
