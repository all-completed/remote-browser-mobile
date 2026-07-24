// Visual pairing: encode/decode the connection config (service URL + API token, plus the
// session secret and the dedicated vault password) as a QR code so it can be transferred
// between the desktop Keeper and this app without typing. The QR is only ever
// shown/scanned locally between the user's own devices; nothing is put in a network URL
// or sent to any model.
import QRCode from 'qrcode';
import type { VaultKey } from './vaultCrypto';

export interface PairConfig {
  baseUrl: string;
  apiKey: string;
  secret?: string; // optional session secret (present when the desktop holds one)
  vault?: VaultKey; // optional dedicated vault key { password, format, salt? }
}

const APP_TAG = 'rbkeeper';

export function buildPayload(cfg: PairConfig): string {
  return JSON.stringify({
    app: APP_TAG, v: 1, url: cfg.baseUrl, key: cfg.apiKey,
    ...(cfg.secret ? { secret: cfg.secret } : {}),
    ...(cfg.vault ? { vault: cfg.vault } : {}),
  });
}

export async function makeQrDataUrl(cfg: PairConfig): Promise<string> {
  return QRCode.toDataURL(buildPayload(cfg), { margin: 1, scale: 8, errorCorrectionLevel: 'M' });
}

function parseVault(v: any): VaultKey | undefined {
  if (v && typeof v.password === 'string' && v.password && typeof v.format === 'string') {
    return { password: v.password, format: v.format, ...(typeof v.salt === 'string' && v.salt ? { salt: v.salt } : {}) };
  }
  return undefined;
}

// Parse a scanned payload back into a config, or null if it isn't ours. The `secret` and
// `vault`, when the desktop included them, are carried through so the synced vault can be
// decrypted on this device.
export function parsePayload(text: string): PairConfig | null {
  try {
    const o = JSON.parse(text);
    if (o && o.app === APP_TAG && typeof o.url === 'string' && typeof o.key === 'string') {
      const vault = parseVault(o.vault);
      return {
        baseUrl: o.url, apiKey: o.key,
        ...(typeof o.secret === 'string' && o.secret ? { secret: o.secret } : {}),
        ...(vault ? { vault } : {}),
      };
    }
  } catch {
    /* not our payload */
  }
  return null;
}
