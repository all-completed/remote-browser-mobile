import { Preferences } from '@capacitor/preferences';

export interface Config {
  baseUrl: string;
  apiKey: string;
}

const KEY = 'rbkeeper.config';
const DEFAULT_URL = 'https://rb.all-completed.com';

export async function loadConfig(): Promise<Config> {
  try {
    const { value } = await Preferences.get({ key: KEY });
    if (value) {
      const c = JSON.parse(value);
      return { baseUrl: c.baseUrl || DEFAULT_URL, apiKey: c.apiKey || '' };
    }
  } catch {
    /* fall through to defaults */
  }
  return { baseUrl: DEFAULT_URL, apiKey: '' };
}

export async function saveConfig(c: Config): Promise<void> {
  const baseUrl = (c.baseUrl || DEFAULT_URL).trim().replace(/\/+$/, '');
  await Preferences.set({
    key: KEY,
    value: JSON.stringify({ baseUrl, apiKey: (c.apiKey || '').trim() }),
  });
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
