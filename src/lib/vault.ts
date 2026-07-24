// Synced zero-knowledge vault — mobile client (sync + transport half).
// Encryption/merge live in vaultCrypto.ts; this file pulls/pushes the opaque ciphertext
// to the service's /api/vault over CapacitorHttp (native, so no CORS from the webview
// origin) with optimistic-version 409 retry. The service stores only ciphertext and
// holds no key — see the service repo docs/vault-sync.md.
import { CapacitorHttp } from '@capacitor/core';
import {
  VAULT_SCHEMA,
  emptyVault,
  encryptVault,
  decryptVault,
  expectedSecretId,
  type VaultBlob,
  type VaultEntry,
  type VaultKey,
} from './vaultCrypto';

export interface VaultConfig {
  baseUrl: string;
  apiKey: string;
}

// Thrown when the stored blob was written under a different password — this device must
// re-pair to pick up the new vault password.
export class VaultKeyMismatch extends Error {
  mismatch = true;
  constructor(msg?: string) { super(msg || 'vault secret mismatch'); this.name = 'VaultKeyMismatch'; }
}

// Injectable HTTP so the sync logic is testable off-device; defaults to CapacitorHttp
// which bypasses webview CORS.
export interface HttpResponse {
  status: number;
  data: any;
}
export type HttpFn = (req: { method: string; url: string; headers: Record<string, string>; body?: any }) => Promise<HttpResponse>;

const defaultHttp: HttpFn = async (req) => {
  const res = await CapacitorHttp.request({ method: req.method, url: req.url, headers: req.headers, data: req.body });
  return { status: res.status, data: res.data };
};

const apiUrl = (b: string) => String(b || '').replace(/\/+$/, '') + '/api/vault';
const authHeaders = (k: string): Record<string, string> => (k ? { Authorization: `Bearer ${k}` } : {});

// CapacitorHttp may hand back an already-parsed object or a JSON string.
function asObj(data: any): any {
  if (data && typeof data === 'object') return data;
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return {}; }
  }
  return {};
}

export async function pullVault(cfg: VaultConfig, key: VaultKey, http: HttpFn = defaultHttp): Promise<{ version: number; data: VaultBlob; format: string }> {
  const res = await http({ method: 'GET', url: apiUrl(cfg.baseUrl), headers: { ...authHeaders(cfg.apiKey) } });
  if (res.status === 404) return { version: 0, data: emptyVault(), format: key.format };
  if (res.status < 200 || res.status >= 300) throw new Error(`vault GET failed: ${res.status}`);
  const body = asObj(res.data);
  const fmt = body.format || key.format;
  if (body.secret_id) {
    let expect: string | null;
    try { expect = await expectedSecretId(key, body.ciphertext, fmt); } catch { expect = null; }
    if (expect !== body.secret_id) throw new VaultKeyMismatch('vault password changed — re-pair this device');
  }
  return { version: Number(body.version) || 0, data: await decryptVault<VaultBlob>(key, body.ciphertext, fmt), format: fmt };
}

export async function putVault(
  cfg: VaultConfig,
  key: VaultKey,
  data: VaultBlob,
  baseVersion: number,
  http: HttpFn = defaultHttp,
): Promise<{ ok?: boolean; version?: number; conflict?: boolean; current?: any }> {
  const enc = await encryptVault(key, { schema: VAULT_SCHEMA, fields: (data && data.fields) || {} });
  const body = { ciphertext: enc.ciphertext, secret_id: enc.secret_id, format: enc.format, base_version: Number(baseVersion) || 0 };
  const res = await http({
    method: 'PUT',
    url: apiUrl(cfg.baseUrl),
    headers: { 'Content-Type': 'application/json', ...authHeaders(cfg.apiKey) },
    body,
  });
  if (res.status === 409) {
    const d = asObj(res.data);
    return { conflict: true, current: d?.detail?.current || null };
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`vault PUT failed: ${res.status}`);
  const out = asObj(res.data);
  return { ok: true, version: out?.metadata?.version };
}

// Order-independent JSON so a routine sync that changes nothing skips the PUT.
function stableStringify(obj: Record<string, VaultEntry>): string {
  return JSON.stringify(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

// Pull → mutate(remoteFields) → push at the pulled version, retrying on 409. `mutate`
// merges the decrypted remote map with local state and returns the map to store
// (idempotent, so re-applying after a conflict is safe).
export async function syncVault(
  cfg: VaultConfig,
  key: VaultKey,
  mutate: (remoteFields: Record<string, VaultEntry>) => Record<string, VaultEntry> | Promise<Record<string, VaultEntry>>,
  http: HttpFn = defaultHttp,
  retries = 5,
): Promise<Record<string, VaultEntry>> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { version, data, format } = await pullVault(cfg, key, http);
    const remoteFields = (data && data.fields) || {};
    const nextFields = (await mutate({ ...remoteFields })) || {};
    // Skip a no-op write only when the stored format matches our key's format — a re-key
    // with unchanged fields must still be pushed.
    if (version > 0 && format === key.format && stableStringify(nextFields) === stableStringify(remoteFields)) return nextFields;
    const res = await putVault(cfg, key, { schema: VAULT_SCHEMA, fields: nextFields }, version, http);
    if (res.conflict) continue;
    return nextFields;
  }
  throw new Error('vault sync failed after repeated version conflicts');
}
