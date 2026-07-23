// Synced zero-knowledge vault — mobile client (sync + transport half).
// Encryption/merge live in vaultCrypto.ts; this file pulls/pushes the opaque
// ciphertext to the service's /api/vault over CapacitorHttp (native, so no CORS
// from the webview origin) with optimistic-version 409 retry. The service stores
// only ciphertext and holds no key — see the service repo docs/vault-sync.md.
import { CapacitorHttp } from '@capacitor/core';
import {
  VAULT_FORMAT,
  VAULT_SCHEMA,
  emptyVault,
  encryptVault,
  decryptVault,
  secretIdOf,
  type VaultBlob,
  type VaultEntry,
} from './vaultCrypto';

export interface VaultConfig {
  baseUrl: string;
  apiKey: string;
}

// Injectable HTTP so the sync logic is testable off-device; defaults to
// CapacitorHttp which bypasses webview CORS.
export interface HttpResponse {
  status: number;
  data: any;
}
export type HttpFn = (req: { method: string; url: string; headers: Record<string, string>; body?: any }) => Promise<HttpResponse>;

const defaultHttp: HttpFn = async (req) => {
  const res = await CapacitorHttp.request({
    method: req.method,
    url: req.url,
    headers: req.headers,
    data: req.body,
  });
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

export async function pullVault(cfg: VaultConfig, secret: string, http: HttpFn = defaultHttp): Promise<{ version: number; data: VaultBlob }> {
  const res = await http({ method: 'GET', url: apiUrl(cfg.baseUrl), headers: { ...authHeaders(cfg.apiKey) } });
  if (res.status === 404) return { version: 0, data: emptyVault() };
  if (res.status < 200 || res.status >= 300) throw new Error(`vault GET failed: ${res.status}`);
  const body = asObj(res.data);
  if (body.secret_id && body.secret_id !== (await secretIdOf(secret))) throw new Error('vault secret mismatch');
  return { version: Number(body.version) || 0, data: await decryptVault<VaultBlob>(secret, body.ciphertext) };
}

export async function putVault(
  cfg: VaultConfig,
  secret: string,
  data: VaultBlob,
  baseVersion: number,
  http: HttpFn = defaultHttp,
): Promise<{ ok?: boolean; version?: number; conflict?: boolean; current?: any }> {
  const body = {
    ciphertext: await encryptVault(secret, data),
    secret_id: await secretIdOf(secret),
    format: VAULT_FORMAT,
    base_version: Number(baseVersion) || 0,
  };
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

// Order-independent JSON so a routine sync that changes nothing skips the PUT
// (avoids version churn between devices on every reconnect).
function stableStringify(obj: Record<string, VaultEntry>): string {
  return JSON.stringify(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

// Pull → mutate(remoteFields) → push at the pulled version, retrying on 409.
// `mutate` merges the decrypted remote map with local state and returns the map to
// store (idempotent, so re-applying after a conflict is safe).
export async function syncVault(
  cfg: VaultConfig,
  secret: string,
  mutate: (remoteFields: Record<string, VaultEntry>) => Record<string, VaultEntry> | Promise<Record<string, VaultEntry>>,
  http: HttpFn = defaultHttp,
  retries = 5,
): Promise<Record<string, VaultEntry>> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { version, data } = await pullVault(cfg, secret, http);
    const remoteFields = (data && data.fields) || {};
    const nextFields = (await mutate({ ...remoteFields })) || {};
    if (version > 0 && stableStringify(nextFields) === stableStringify(remoteFields)) return nextFields;
    const res = await putVault(cfg, secret, { schema: VAULT_SCHEMA, fields: nextFields }, version, http);
    if (res.conflict) continue;
    return nextFields;
  }
  throw new Error('vault sync failed after repeated version conflicts');
}
