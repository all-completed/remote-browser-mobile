import { Preferences } from '@capacitor/preferences';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

export interface Config {
  baseUrl: string;
  apiKey: string;
  secret: string; // session vault key (from pairing); '' when none is held
}

// The base URL is non-secret and stays in Preferences. The API token and the session
// `secret` live in secure storage (Android Keystore-backed EncryptedSharedPreferences
// / iOS Keychain), never in plaintext on disk.
const LEGACY_KEY = 'rbkeeper.config'; // old combined blob (baseUrl + apiKey, plaintext)
const URL_KEY = 'rbkeeper.baseUrl';
const SECURE_API_KEY = 'rbkeeper.apiKey';
const SECURE_SECRET = 'rbkeeper.secret';
const DEFAULT_URL = 'https://rb.all-completed.com';

async function getApiKey(): Promise<string> {
  try {
    const v = await SecureStorage.get(SECURE_API_KEY);
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

async function setApiKey(value: string): Promise<boolean> {
  try {
    if (value) await SecureStorage.set(SECURE_API_KEY, value);
    else await SecureStorage.remove(SECURE_API_KEY);
    return true;
  } catch {
    /* secure storage unavailable (e.g. web preview) — token isn't persisted */
    return false;
  }
}

// The session secret keys the synced vault (vaultCrypto.ts). It is provisioned by
// the desktop pair QR; treated exactly like the API token at rest.
async function getSecret(): Promise<string> {
  try {
    const v = await SecureStorage.get(SECURE_SECRET);
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

async function setSecret(value: string): Promise<boolean> {
  try {
    if (value) await SecureStorage.set(SECURE_SECRET, value);
    else await SecureStorage.remove(SECURE_SECRET);
    return true;
  } catch {
    return false;
  }
}

// The held session secret, or '' — used to encrypt/decrypt the synced vault.
export async function loadSecret(): Promise<string> {
  return getSecret();
}

export async function loadConfig(): Promise<Config> {
  let baseUrl = DEFAULT_URL;
  try {
    const { value } = await Preferences.get({ key: URL_KEY });
    if (value) baseUrl = value;
  } catch {
    /* defaults */
  }
  let apiKey = await getApiKey();
  const secret = await getSecret();

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
        // Only drop the plaintext copy once the token is safely in secure storage —
        // never delete it if the secure write failed (would lose the token).
        let secured = true;
        if (c.apiKey && !apiKey) {
          apiKey = c.apiKey;
          secured = await setApiKey(apiKey);
        }
        if (secured) await Preferences.remove({ key: LEGACY_KEY });
      }
    } catch {
      /* nothing to migrate */
    }
  }

  return { baseUrl: baseUrl || DEFAULT_URL, apiKey, secret };
}

// `secret` is optional here: the manual settings form doesn't touch it, and pairing
// may or may not carry one — an absent/empty secret leaves any stored secret intact.
export async function saveConfig(c: { baseUrl: string; apiKey: string; secret?: string }): Promise<void> {
  const baseUrl = (c.baseUrl || DEFAULT_URL).trim().replace(/\/+$/, '');
  await Preferences.set({ key: URL_KEY, value: baseUrl });
  await setApiKey((c.apiKey || '').trim());
  // Only overwrite the stored secret when the caller supplies one (pairing may or may
  // not carry it); never clobber an existing secret with an empty string.
  if (typeof c.secret === 'string' && c.secret.trim()) await setSecret(c.secret.trim());
  // Ensure no legacy plaintext token lingers.
  try { await Preferences.remove({ key: LEGACY_KEY }); } catch { /* ignore */ }
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
