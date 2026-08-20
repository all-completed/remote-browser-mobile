import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IonReactRouter } from '@ionic/react-router';
import { IonIcon, IonLabel, IonRouterOutlet, IonTabBar, IonTabButton, IonTabs } from '@ionic/react';
import { Redirect, Route } from 'react-router-dom';
import { cardOutline, homeOutline, keyOutline, settingsOutline, timeOutline } from 'ionicons/icons';
import { App as CapApp } from '@capacitor/app';

import { keeper, type ConnState, type FillRequest } from './lib/keeperClient';
import { foregroundService } from './lib/foregroundService';
import { initPush } from './lib/push';
import { clearDeviceToken, keeperWsUrl, loadConfig, loadDeviceToken, loadVaultKey, saveDeviceToken, type Config } from './lib/config';
import { generateSharedPasswords } from './lib/format';
import { markAutofilled, saveScreenshot } from './lib/history';
import { getSaved, hostFromUrl, mergeRemoteVault, saveValue } from './lib/fieldStore';
import { loadGenerateShowWindow } from './lib/settings';
import { syncVault, VaultKeyMismatch } from './lib/vault';
import { adoptDeviceId, buildDeviceReport, deviceIdentity, type DeviceReport } from './lib/device';
import { enrollDevice, enrollmentState, pickCredential, shouldEnroll } from './lib/enroll';
import StatusPage from './pages/StatusPage';
import HistoryPage from './pages/HistoryPage';
import SettingsPage from './pages/SettingsPage';
import SavedFieldsPage from './pages/SavedFieldsPage';
import CardsPage from './pages/CardsPage';
import PromptModal from './components/PromptModal';

const isCard = (field?: string) => String(field || '').toLowerCase().startsWith('card-');

// When every field of a request is a generate-field (a new password), the Keeper creates
// each value itself and answers WITHOUT ever asking the user (mirrors the desktop keeper's
// tryAutofillGenerate). The generated value is never shown, so it's saved to the synced
// vault by default (falling back to on-device when no vault key is held) with auto-fill on,
// so it's backed up / refillable. Returns true when it handled the request. To have the
// user type a password instead, the agent sends a normal (non-generate) request_fill.
async function tryAutoGenerate(req: FillRequest, baseUrl: string): Promise<boolean> {
  const fields = req.fields || [];
  if (!fields.length || !fields.every((f) => f && f.generate && !isCard(f.field))) return false;
  // Opt-out: when the user turned on "show the password window", generation isn't silent —
  // fall through to the prompt so they can review/edit the generated value before it fills.
  if (await loadGenerateShowWindow()) return false;
  const host = hostFromUrl(req.url);
  const session = req.session_id || '';
  const scope = (await loadVaultKey().catch(() => null)) ? 'vault' : 'forever';
  // Shared per kind so "Password" + "Confirm password" in one request match.
  const shared = generateSharedPasswords(fields);
  const out: { selector: string; value: string }[] = [];
  for (const f of fields) {
    const value = shared[f.selector];
    out.push({ selector: f.selector, value });
    if (host) await saveValue(baseUrl, session, host, f.selector, value, scope, true); // auto-fill next time
  }
  keeper.submit(req.request_id, out);
  void markAutofilled(req.request_id); // History labels this "autofilled" (green)
  if (req.screenshot) void saveScreenshot(req.request_id, req.screenshot);
  return true;
}

// If every field already has a saved value flagged "fill automatically", answer the
// request silently without showing the prompt (mirrors the desktop keeper).
async function tryAutoFill(req: FillRequest, baseUrl: string): Promise<boolean> {
  const fields = req.fields || [];
  if (!fields.length || fields.some((f) => isCard(f.field))) return false;
  const host = hostFromUrl(req.url);
  const session = req.session_id || '';
  const out: { selector: string; value: string }[] = [];
  for (const f of fields) {
    const s = await getSaved(baseUrl, session, host, f.selector);
    if (!s || !s.auto || s.value == null) return false;
    out.push({ selector: f.selector, value: s.value });
  }
  keeper.submit(req.request_id, out);
  void markAutofilled(req.request_id); // so History labels this "autofilled" (green)
  if (req.screenshot) void saveScreenshot(req.request_id, req.screenshot);
  return true;
}

interface AppCtx {
  config: Config;
  connState: ConnState;
  configLoaded: boolean;
  deviceReport: DeviceReport | null; // this device's identity + vault state (Settings)
  reloadConfig: () => Promise<void>;
}

const Ctx = createContext<AppCtx>({
  config: { baseUrl: '', apiKey: '', deviceToken: '', credential: '', secret: '', vaultKey: null },
  connState: 'disconnected',
  configLoaded: false,
  deviceReport: null,
  reloadConfig: async () => {},
});

export const useApp = () => useContext(Ctx);

export default function App() {
  const [config, setConfig] = useState<Config>({ baseUrl: '', apiKey: '', deviceToken: '', credential: '', secret: '', vaultKey: null });
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [configLoaded, setConfigLoaded] = useState(false);
  const [queue, setQueue] = useState<FillRequest[]>([]);
  const started = useRef(false);
  const baseUrlRef = useRef(''); // latest base URL for the once-registered request listener
  const cfgRef = useRef<Config>({ baseUrl: '', apiKey: '', deviceToken: '', credential: '', secret: '', vaultKey: null }); // latest full config
  const enrollState = useRef(enrollmentState()); // where device enrollment stands this run
  const rejectedTokens = useRef(0);              // device tokens the service refused this run
  const applyConfigRef = useRef<(() => Promise<void>) | null>(null);
  const syncingVault = useRef(false);
  const [deviceReport, setDeviceReport] = useState<DeviceReport | null>(null);
  // What only a sync can tell us about the vault: the version this device reached, and
  // whether the stored blob was written under a different password (VaultKeyMismatch).
  const vaultSync = useRef<{ version: number | null; needsRepair: boolean }>({ version: null, needsRepair: false });

  // Rebuild "who am I / which vault do I hold" and publish it: to the service (rides on
  // `hello`, or a `device_info` frame when it changes mid-connection) and to Settings.
  const refreshDeviceReport = useCallback(async () => {
    const report = await buildDeviceReport(cfgRef.current.vaultKey, vaultSync.current);
    setDeviceReport(report);
    keeper.setDeviceReport(report);
  }, []);

  // Sync the "vault"-scoped saved fields with the service: pull the remote blob,
  // merge it into the local cache (last-write-wins), and push the union back. The
  // service only ever sees opaque ciphertext (see vault.ts). Best-effort — no-ops
  // without an API key or a held vault key (provisioned by the desktop pair QR).
  const syncVaultNow = useCallback(async () => {
    if (syncingVault.current) return;
    const { baseUrl, credential, vaultKey } = cfgRef.current;
    if (!baseUrl || !credential || !vaultKey) return;
    syncingVault.current = true;
    try {
      // Merge only `fields`; pass every other collection (e.g. desktop-saved `cards`)
      // through unchanged so this device never drops them.
      await syncVault(
        { baseUrl, apiKey: credential },
        vaultKey,
        async (remoteBlob) => ({ ...remoteBlob, fields: await mergeRemoteVault(remoteBlob.fields || {}) }),
        {
          onVersion: (version) => {
            vaultSync.current = { version, needsRepair: false }; // decrypted fine → not broken
          },
        },
      );
    } catch (e) {
      // A key mismatch means the vault password changed elsewhere — re-pair to update it.
      // That's "holds a vault it cannot decrypt", not "holds no vault": report it as such.
      if (e instanceof VaultKeyMismatch) {
        vaultSync.current = { ...vaultSync.current, needsRepair: true };
        console.warn('[keeper] vault: re-pair to update the vault password');
      }
      /* otherwise offline / transient — retried on the next connect or save */
    } finally {
      syncingVault.current = false;
      void refreshDeviceReport(); // the vault state may have moved (version / needs_repair)
    }
  }, [refreshDeviceReport]);

  // -- device enrollment (issue #12) ------------------------------------------------
  // Ask the service, once the socket is up, for a token belonging to this phone alone.
  // Best-effort by design: a service that predates #33 answers 404, one without a
  // metadata store answers 503, and either way we say so once and stay on the account
  // key — which is not a degraded mode, it is how this app has always run. Nothing here
  // can leave the phone worse off than not calling it, which matters more here than on
  // the desktop: this build reaches users by sideload and may sit unchanged for months.
  const maybeEnroll = useCallback(async () => {
    const cfg = cfgRef.current;
    if (!shouldEnroll(enrollState.current, {
      hasDeviceToken: !!cfg.deviceToken,
      hasApiKey: !!cfg.apiKey,
    })) return;
    enrollState.current.lastAttempt = Date.now();
    enrollState.current.attempts += 1;
    const res = await enrollDevice({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      identity: await deviceIdentity(),
    });
    if (!res.ok) {
      enrollState.current.lastError = res.reason || 'error';
      if (res.reason === 'unsupported') enrollState.current.supported = false;
      console.log('[keeper] not enrolling (' + res.reason + ') — staying on the account key');
      return;
    }
    enrollState.current.supported = true;
    if (!(await saveDeviceToken(res.token || ''))) {
      // Secure storage refused it. Presenting a token we cannot persist would enroll the
      // device afresh on every launch, so leave it on the account key instead.
      console.warn('[keeper] could not store the device token; staying on the account key');
      return;
    }
    // The service is the authority on this device's id from here on; match it so `hello`
    // names the record the user revokes on the Devices page.
    if (res.deviceId) await adoptDeviceId(res.deviceId);
    console.log('[keeper] enrolled as device', res.deviceId || '(unnamed)');
    await applyConfigRef.current?.(); // reconnect, now authenticated by our own token
  }, []);

  // The service refused, or hung up on, a socket authenticated by our device token —
  // a revoke, or a record this deployment can't see. Drop it and come back on the
  // account key; re-enroll once, so revoking to re-pair heals itself, but not forever:
  // a service that mints tokens it then rejects must not have us spinning.
  const handleRevoked = useCallback(async () => {
    await clearDeviceToken();
    rejectedTokens.current += 1;
    if (rejectedTokens.current < 2) enrollState.current.lastAttempt = 0;
    else enrollState.current.supported = false;
    console.warn('[keeper] device token rejected — falling back to the account key');
    await applyConfigRef.current?.();
  }, []);

  const applyConfig = useCallback(async () => {
    const cfg = await loadConfig();
    setConfig(cfg);
    setConfigLoaded(true);
    baseUrlRef.current = cfg.baseUrl;
    // A different vault key (a re-pair) invalidates what the last sync told us — the
    // version and any "cannot decrypt" verdict belong to the key that produced them. The
    // device id is untouched by this: it lives outside the config (src/lib/device.ts).
    if (JSON.stringify(cfg.vaultKey) !== JSON.stringify(cfgRef.current.vaultKey)) {
      vaultSync.current = { version: null, needsRepair: false };
    }
    cfgRef.current = cfg;
    const cred = pickCredential({ deviceToken: cfg.deviceToken, apiKey: cfg.apiKey });
    keeper.configure(keeperWsUrl(cfg.baseUrl), cred.token, cfg.baseUrl, cred.kind);
    await refreshDeviceReport(); // ready before the socket opens, so `hello` carries it
    keeper.disconnect();
    keeper.connect();
    // Once paired, keep a persistent tray notification (Android) so the Keeper stays
    // alive in the background and keeps answering requests; drop it when unpaired.
    if (cfg.baseUrl && cfg.apiKey) {
      void foregroundService.start();
      // Once paired, make sure Doze can't sit on our wake-pushes. Android defers
      // even priority-"high" FCM for optimized idle apps, which is exactly how a
      // request goes unseen until the screen comes on. No-op once granted, so
      // this asks at most once (the system dialog stops appearing after consent).
      void (async () => {
        if (!(await foregroundService.isBatteryOptimizationIgnored())) {
          await foregroundService.requestIgnoreBatteryOptimization();
        }
      })();
    } else {
      void foregroundService.stop();
    }
  }, [refreshDeviceReport]);

  // applyConfig re-reads the config and reconnects; enrollment and revocation both need
  // it, and both are defined above it, so they reach it through a ref rather than by
  // reordering the hooks around them.
  applyConfigRef.current = applyConfig;

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    keeper.on('revoked', () => { void handleRevoked(); });
    keeper.on('state', (s) => {
      setConnState(s);
      // On (re)connect, pull vault entries saved on another paired device (and push ours).
      if (s === 'connected') void syncVaultNow();
      // ...and see whether this service will give this phone a credential of its own.
      // After connecting, never before: a phone that can answer requests must not be
      // held up by an endpoint that may not exist.
      if (s === 'connected') void maybeEnroll();
      // Surface the live socket state in the ongoing notification, so the user can
      // see whether the keeper is actually connected (not just "running").
      const text =
        s === 'connected' ? 'Connected · watching for requests'
        : s === 'reconnecting' ? 'Reconnecting…'
        : s === 'unauthorized' ? 'Auth failed — open Settings'
        : 'Disconnected — open the app to reconnect';
      void foregroundService.setStatus(text);
    });
    keeper.on('request', (req) => {
      void (async () => {
        // Password generation is fully unattended — create + fill + save, never ask.
        if (await tryAutoGenerate(req, baseUrlRef.current)) { void syncVaultNow(); return; }
        if (await tryAutoFill(req, baseUrlRef.current)) return;
        let added = false;
        setQueue((q) => {
          // Dedup: the server replays still-pending requests on every (re)connect, so
          // the same request_id can arrive again — don't enqueue/alert twice.
          if (q.some((r) => r.request_id === req.request_id)) return q;
          added = true;
          return [...q, req];
        });
        if (!added) return;
        // Ping the user (sound + vibration + heads-up) so a backgrounded request
        // isn't missed; cleared when they answer (see finish()).
        void foregroundService.notifyRequest('🔐 A session needs a value', req.message || 'Tap to respond in the Keeper');
      })();
    });
    keeper.on('resolved', (requestId) => {
      // Another keeper (desktop/other phone) answered this, or it timed out — drop it
      // from our queue without responding, so we don't ask the user for it too.
      setQueue((q) => {
        const next = q.filter((r) => r.request_id !== requestId);
        if (next.length === 0) void foregroundService.clearAlert();
        return next;
      });
    });
    applyConfig();

    // Register for FCM so the service can wake us with a content-free push when a
    // request lands while we're deep-backgrounded. The token rides over the WS; a
    // wake (received or tapped) just re-asserts the socket so replay delivers it.
    void initPush(
      (token) => keeper.setFcmToken(token),
      // Background wake (force) → fresh reconnect so the server replays pending requests;
      // foreground wake → a gentle connect() is enough.
      (force) => (force ? keeper.reconnect() : keeper.connect()),
    );

    // Dev-only: lets a web preview inject a simulated fill_request to exercise the
    // prompt UI without a live connection. Stripped from production builds.
    if (import.meta.env.DEV) {
      (window as any).__injectFill = (req: FillRequest) => setQueue((q) => [...q, req]);
    }

    // Always-on: a foreground service keeps the process alive in the background, so
    // we stay connected on pause (no disconnect) and only re-assert the socket on
    // resume as a recovery (e.g. if the OS dropped it during deep Doze).
    const resume = CapApp.addListener('resume', () => keeper.reconnect());
    return () => {
      resume.then((h) => h.remove());
    };
  }, [applyConfig, syncVaultNow]);

  const current = queue[0] || null;

  const finish = (req: FillRequest, payload: { values?: { selector: string; value: string }[]; cancelled?: boolean }) => {
    if (payload.cancelled) keeper.cancel(req.request_id);
    else keeper.submit(req.request_id, payload.values || []);
    // The prompt may have saved/forgotten a vault-scoped value → push it to other devices.
    if (!payload.cancelled) void syncVaultNow();
    // Cache the proof screenshot locally so History can show it (no values stored).
    if (req.screenshot) void saveScreenshot(req.request_id, req.screenshot);
    setQueue((q) => {
      const next = q.filter((r) => r.request_id !== req.request_id);
      if (next.length === 0) void foregroundService.clearAlert(); // no pending prompts left
      return next;
    });
  };

  return (
    <Ctx.Provider value={{ config, connState, configLoaded, deviceReport, reloadConfig: applyConfig }}>
      {current && (
        <PromptModal
          request={current}
          baseUrl={config.baseUrl}
          onSubmit={(values) => finish(current, { values })}
          onCancel={() => finish(current, { cancelled: true })}
        />
      )}
      <IonReactRouter>
        <IonTabs>
          <IonRouterOutlet>
            <Route exact path="/status" component={StatusPage} />
            <Route exact path="/history" component={HistoryPage} />
            <Route exact path="/saved" component={SavedFieldsPage} />
            <Route exact path="/cards" component={CardsPage} />
            <Route exact path="/settings" component={SettingsPage} />
            <Route exact path="/">
              <Redirect to="/status" />
            </Route>
          </IonRouterOutlet>
          <IonTabBar slot="bottom">
            <IonTabButton tab="status" href="/status">
              <IonIcon icon={homeOutline} />
              <IonLabel>Status</IonLabel>
            </IonTabButton>
            <IonTabButton tab="history" href="/history">
              <IonIcon icon={timeOutline} />
              <IonLabel>History</IonLabel>
            </IonTabButton>
            <IonTabButton tab="saved" href="/saved">
              <IonIcon icon={keyOutline} />
              <IonLabel>Saved</IonLabel>
            </IonTabButton>
            <IonTabButton tab="cards" href="/cards">
              <IonIcon icon={cardOutline} />
              <IonLabel>Cards</IonLabel>
            </IonTabButton>
            <IonTabButton tab="settings" href="/settings">
              <IonIcon icon={settingsOutline} />
              <IonLabel>Settings</IonLabel>
            </IonTabButton>
          </IonTabBar>
        </IonTabs>
      </IonReactRouter>
    </Ctx.Provider>
  );
}
