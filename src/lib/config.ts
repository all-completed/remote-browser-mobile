import { Preferences } from '@capacitor/preferences';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import type { VaultKey } from './vaultCrypto';

export interface Config {
  baseUrl: string;
  apiKey: string; // the shared ACCOUNT key, as copied by the pairing QR
  deviceToken: string; // this device's own token once enrolled (issue #12); '' before
  // What to actually present to the service: the device token when we have one, else the
  // account key. Kept separate from `apiKey` on purpose — the account key is still what
  // Settings displays and what the pairing QR shares, and it stays the fallback forever.
  credential: string;
  secret: string; // session secret (from pairing); '' when none is held
  vaultKey: VaultKey | null; // dedicated vault password (from pairing); null when none
}

// The base URL is non-secret and stays in Preferences. The API token, the session
// `secret`, and the dedicated vault key live in secure storage (Android Keystore-backed
// EncryptedSharedPreferences / iOS Keychain), never in plaintext on disk.
const LEGACY_KEY = 'rbkeeper.config'; // old combined blob (baseUrl + apiKey, plaintext)
const URL_KEY = 'rbkeeper.baseUrl';
const SECURE_API_KEY = 'rbkeeper.apiKey';
// This device's own token (issue #12). Secure storage, never Preferences — it is a
// credential, and one that can be revoked individually without touching the account key.
const SECURE_DEVICE_TOKEN = 'rbkeeper.deviceToken';
const SECURE_SECRET = 'rbkeeper.secret';
const SECURE_VAULTKEY = 'rbkeeper.vaultKey';
const DEFAULT_URL = 'https://rb.all-completed.com';

async function secureGet(key: string): Promise<string> {
  try {
    const v = await SecureStorage.get(key);
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}
async function secureSet(key: string, value: string): Promise<boolean> {
  try {
    if (value) await SecureStorage.set(key, value);
    else await SecureStorage.remove(key);
    return true;
  } catch {
    /* secure storage unavailable (e.g. web preview) — not persisted */
    return false;
  }
}

// The dedicated vault key (vaultCrypto.ts) — { password, format, salt? }. Provisioned by
// the desktop pair QR; treated exactly like the API token at rest.
async function getVaultKey(): Promise<VaultKey | null> {
  const raw = await secureGet(SECURE_VAULTKEY);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o.password === 'string' && o.password && typeof o.format === 'string') {
      return { password: o.password, format: o.format, ...(o.salt ? { salt: o.salt } : {}) };
    }
  } catch { /* corrupt */ }
  return null;
}
async function setVaultKey(key: VaultKey | null | undefined): Promise<boolean> {
  if (!key || !key.password) return true; // never clobber an existing key with nothing
  return secureSet(SECURE_VAULTKEY, JSON.stringify({ password: key.password, format: key.format, ...(key.salt ? { salt: key.salt } : {}) }));
}

// The held session secret, or '' (legacy; the vault now uses its own key).
export async function loadSecret(): Promise<string> {
  return secureGet(SECURE_SECRET);
}
// The held vault key, or null — used to encrypt/decrypt the synced vault.
export async function loadVaultKey(): Promise<VaultKey | null> {
  return getVaultKey();
}

export async function loadConfig(): Promise<Config> {
  let baseUrl = DEFAULT_URL;
  try {
    const { value } = await Preferences.get({ key: URL_KEY });
    if (value) baseUrl = value;
  } catch {
    /* defaults */
  }
  let apiKey = await secureGet(SECURE_API_KEY);
  const deviceToken = await secureGet(SECURE_DEVICE_TOKEN);
  const secret = await secureGet(SECURE_SECRET);
  const vaultKey = await getVaultKey();

  // One-time migration: older builds kept {baseUrl, apiKey} as a plaintext blob in
  // Preferences. Move the token into secure storage and delete the cleartext copy.
  if (!apiKey || baseUrl === DEFAULT_URL) {
    try {
      const { value } = await Preferences.get({ key: LEGACY_KEY });
      if (value) {
        const c = JSON.parse(value);
        if (c.baseUrl) {
          baseUrl = c.baseUrl;
          await Preferences.set({ key: URL_KEY, value: baseUrl });
        }
        let secured = true;
        if (c.apiKey && !apiKey) {
          apiKey = c.apiKey;
          secured = await secureSet(SECURE_API_KEY, apiKey);
        }
        if (secured) await Preferences.remove({ key: LEGACY_KEY });
      }
    } catch {
      /* nothing to migrate */
    }
  }

  return {
    baseUrl: baseUrl || DEFAULT_URL,
    apiKey,
    deviceToken,
    credential: deviceToken || apiKey,
    secret,
    vaultKey,
  };
}

// -- this device's own token (issue #12) -------------------------------------------
// Stored, read and cleared on its own, never through saveConfig(): re-pairing or editing
// the account key in Settings must not silently drop an enrollment, and dropping an
// enrollment must not touch the account key. That independence is the whole point of
// per-device tokens.

export async function loadDeviceToken(): Promise<string> {
  return secureGet(SECURE_DEVICE_TOKEN);
}

export async function saveDeviceToken(token: string): Promise<boolean> {
  return secureSet(SECURE_DEVICE_TOKEN, (token || '').trim());
}

// Forget the token — after a server-side revoke, or when the service says no record
// backs it. The next connect goes out on the account key and re-enrolls if it can.
export async function clearDeviceToken(): Promise<boolean> {
  return secureSet(SECURE_DEVICE_TOKEN, '');
}

// `secret` / `vaultKey` are optional here: the manual settings form doesn't touch them,
// and pairing may or may not carry them — an absent value leaves any stored one intact.
export async function saveConfig(c: { baseUrl: string; apiKey: string; secret?: string; vaultKey?: VaultKey | null }): Promise<void> {
  const baseUrl = (c.baseUrl || DEFAULT_URL).trim().replace(/\/+$/, '');
  await Preferences.set({ key: URL_KEY, value: baseUrl });
  await secureSet(SECURE_API_KEY, (c.apiKey || '').trim());
  if (typeof c.secret === 'string' && c.secret.trim()) await secureSet(SECURE_SECRET, c.secret.trim());
  await setVaultKey(c.vaultKey);
  // Ensure no legacy plaintext token lingers.
  try { await Preferences.remove({ key: LEGACY_KEY }); } catch { /* ignore */ }
}

// Persist a vault key locally after a re-key on this device (item 3).
export async function storeVaultKey(key: VaultKey): Promise<boolean> {
  return setVaultKey(key);
}

/** Derive the Keeper WebSocket URL from the service base URL. */
export function keeperWsUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/^http/, 'ws') + '/api/keeper/ws';
}

export function serviceHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
