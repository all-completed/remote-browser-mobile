// Visual pairing: encode/decode the connection config (service URL + API token) as
// a QR code so it can be transferred between the desktop Keeper and this app without
// typing the token. The QR is only ever shown/scanned locally between the user's own
// devices; the token is never put in a network URL or sent to any model.
import QRCode from 'qrcode';

export interface PairConfig {
  baseUrl: string;
  apiKey: string;
}

const APP_TAG = 'rbkeeper';

export function buildPayload(cfg: PairConfig): string {
  return JSON.stringify({ app: APP_TAG, v: 1, url: cfg.baseUrl, key: cfg.apiKey });
}

export async function makeQrDataUrl(cfg: PairConfig): Promise<string> {
  return QRCode.toDataURL(buildPayload(cfg), { margin: 1, scale: 8, errorCorrectionLevel: 'M' });
}

// Parse a scanned payload back into a config, or null if it isn't ours.
export function parsePayload(text: string): PairConfig | null {
  try {
    const o = JSON.parse(text);
    if (o && o.app === APP_TAG && typeof o.url === 'string' && typeof o.key === 'string') {
      return { baseUrl: o.url, apiKey: o.key };
    }
  } catch {
    /* not our payload */
  }
  return null;
}
