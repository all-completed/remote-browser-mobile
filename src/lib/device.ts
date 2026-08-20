// This device's identity, and the inert report that says WHICH vault it is holding.
//
// Without it neither the user nor the service can answer two operational questions: which
// devices are paired and hold a usable vault, and what vault each one is on. The second is
// security-relevant — a device left on the legacy aesgcm-sha256-v1 key model is a live
// exposure, not cosmetic version skew (see vaultCrypto.ts's header).
//
// Everything here is NON-SECRET metadata: a stable id, a human-readable name, the platform,
// the app version, and the vault's blob `schema` + key `format` + last synced `version`. It
// never carries the vault password, the derived key, the session secret, or any field value.
// The v1/v2 `secret_id` rule is not re-implemented here — vaultKeyReport() (vaultCrypto.ts)
// owns it, so there is exactly one place that can get it wrong.
//
// The id is a label, not a credential, so it lives in Preferences next to the other
// non-secret per-device settings (settings.ts) rather than in secure storage. Keeping it out
// of the config blob is what makes it survive a re-pair: saveConfig() never touches it.
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { vaultKeyReport, vaultState, type VaultKey, type VaultKeyReport, type VaultState } from './vaultCrypto';

// Injected by Vite from package.json (vite.config.ts) — never written as a literal, so it
// cannot drift from the released version.
export const APP_VERSION: string = __APP_VERSION__;

const DEVICE_ID_KEY = 'rbkeeper.deviceId';
const PLATFORMS: Record<string, string> = { android: 'Android', ios: 'iOS', web: 'Web' };

export interface DeviceIdentity {
  id: string;
  name: string;
  platform: string;
  app_version: string;
}

export interface DeviceVaultReport extends VaultKeyReport {
  needs_migration: boolean; // legacy v1 → must be re-keyed onto v2
  version: number | null; // last synced vault version, or null if never synced here
  state: VaultState;
}

export interface DeviceReport {
  device: DeviceIdentity;
  vault: DeviceVaultReport;
}

function randomId(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  return Array.from(b as Uint8Array).map((n) => n.toString(16).padStart(2, '0')).join('');
}

let idPromise: Promise<string> | null = null;

// The stable id for this install: minted once, then reused forever. Cached in-module so
// concurrent callers (hello + Settings) can't mint two ids in a race.
export function getDeviceId(): Promise<string> {
  if (!idPromise) {
    idPromise = (async () => {
      try {
        const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
        if (value) return value;
      } catch {
        /* preferences unavailable (e.g. web preview) — mint a per-run id below */
      }
      const id = randomId();
      try {
        await Preferences.set({ key: DEVICE_ID_KEY, value: id });
      } catch {
        /* not persisted — the id is still usable for this run */
      }
      return id;
    })();
  }
  return idPromise;
}

// Adopt the id the service assigned at enrollment (issue #12).
//
// Before enrolling, the id is ours and self-declared; after, the service ignores what we
// claim and uses the one bound to the token. Writing it back keeps the two in step, so
// this phone's `hello` names the same record the user sees — and revokes — on the Devices
// page. The in-module cache is updated too, or `hello` would keep announcing the old id
// until the next app start.
export async function adoptDeviceId(id: string): Promise<boolean> {
  const next = (id || '').trim();
  if (!next || next === (await getDeviceId())) return false;
  try {
    await Preferences.set({ key: DEVICE_ID_KEY, value: next });
  } catch {
    return false; // not persisted — we still connect, just under the old label
  }
  idPromise = Promise.resolve(next);
  return true;
}

// A name a human recognises in a device list. @capacitor/device isn't a dependency (adding
// a native plugin for one string would need a native rebuild), so this reads the model out
// of the webview's UA, which on Android carries it:
//   "…(Linux; Android 14; Pixel 7 Build/UP1A.231005.007; wv) AppleWebKit/…"
export function deviceName(): string {
  const ua = String((globalThis as any).navigator?.userAgent || '');
  const android = /Android\s+[\d.]+;\s*([^;)]+)/.exec(ua);
  if (android) {
    const model = android[1].replace(/\s+Build\/.*$/, '').trim(); // drop the build id
    if (model && model !== 'wv') return model.slice(0, 64);
  }
  const ios = /(iPhone|iPad|iPod)/.exec(ua);
  if (ios) return ios[1];
  return platformName() + ' device'; // e.g. "Web device" in the browser preview
}

export function platformName(): string {
  const p = Capacitor.getPlatform();
  return PLATFORMS[p] || p;
}

export async function deviceIdentity(): Promise<DeviceIdentity> {
  return { id: await getDeviceId(), name: deviceName(), platform: platformName(), app_version: APP_VERSION };
}

// Identity + vault state, as sent on connect and shown in Settings.
export async function buildDeviceReport(
  key: VaultKey | null,
  opts: { needsRepair?: boolean; version?: number | null } = {},
): Promise<DeviceReport> {
  const vault = await vaultKeyReport(key);
  const version = typeof opts.version === 'number' && Number.isFinite(opts.version) ? opts.version : null;
  return {
    device: await deviceIdentity(),
    vault: { ...vault, needs_migration: vault.legacy, version, state: vaultState(vault, opts.needsRepair) },
  };
}
