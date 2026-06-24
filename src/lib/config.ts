import { Preferences } from '@capacitor/preferences';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

export interface Config {
  baseUrl: string;
  apiKey: string;
}

// The base URL is non-secret and stays in Preferences. The API token lives in
// secure storage (Android Keystore-backed EncryptedSharedPreferences / iOS Keychain),
// never in plaintext on disk.
const LEGACY_KEY = 'rbkeeper.config'; // old combined blob (baseUrl + apiKey, plaintext)
const URL_KEY = 'rbkeeper.baseUrl';
const SECURE_API_KEY = 'rbkeeper.apiKey';
const DEFAULT_URL = 'https://rb.all-completed.com';

async function getApiKey(): Promise<string> {
  try {
    const v = await SecureStorage.get(SECURE_API_KEY);
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

async function setApiKey(value: string): Promise<void> {
  try {
    if (value) await SecureStorage.set(SECURE_API_KEY, value);
    else await SecureStorage.remove(SECURE_API_KEY);
  } catch {
    /* secure storage unavailable (e.g. web preview) — token simply isn't persisted */
  }
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
        if (c.apiKey && !apiKey) {
          apiKey = c.apiKey;
          await setApiKey(apiKey);
        }
        await Preferences.remove({ key: LEGACY_KEY }); // drop the plaintext token
      }
    } catch {
      /* nothing to migrate */
    }
  }

  return { baseUrl: baseUrl || DEFAULT_URL, apiKey };
}

export async function saveConfig(c: Config): Promise<void> {
  const baseUrl = (c.baseUrl || DEFAULT_URL).trim().replace(/\/+$/, '');
  await Preferences.set({ key: URL_KEY, value: baseUrl });
  await setApiKey((c.apiKey || '').trim());
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
