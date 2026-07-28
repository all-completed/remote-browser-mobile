import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IonReactRouter } from '@ionic/react-router';
import { IonIcon, IonLabel, IonRouterOutlet, IonTabBar, IonTabButton, IonTabs } from '@ionic/react';
import { Redirect, Route } from 'react-router-dom';
import { cardOutline, homeOutline, keyOutline, settingsOutline, timeOutline } from 'ionicons/icons';
import { App as CapApp } from '@capacitor/app';

import { keeper, type ConnState, type FillRequest } from './lib/keeperClient';
import { foregroundService } from './lib/foregroundService';
import { initPush } from './lib/push';
import { keeperWsUrl, loadConfig, loadVaultKey, type Config } from './lib/config';
import { generatePassword } from './lib/format';
import { markAutofilled, saveScreenshot } from './lib/history';
import { getSaved, hostFromUrl, mergeRemoteVault, saveValue } from './lib/fieldStore';
import { loadGenerateShowWindow } from './lib/settings';
import { syncVault, VaultKeyMismatch } from './lib/vault';
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
  const out: { selector: string; value: string }[] = [];
  for (const f of fields) {
    const value = generatePassword(f);
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
  reloadConfig: () => Promise<void>;
}

const Ctx = createContext<AppCtx>({
  config: { baseUrl: '', apiKey: '', secret: '', vaultKey: null },
  connState: 'disconnected',
  configLoaded: false,
  reloadConfig: async () => {},
});

export const useApp = () => useContext(Ctx);

export default function App() {
  const [config, setConfig] = useState<Config>({ baseUrl: '', apiKey: '', secret: '', vaultKey: null });
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [configLoaded, setConfigLoaded] = useState(false);
  const [queue, setQueue] = useState<FillRequest[]>([]);
  const started = useRef(false);
  const baseUrlRef = useRef(''); // latest base URL for the once-registered request listener
  const cfgRef = useRef<Config>({ baseUrl: '', apiKey: '', secret: '', vaultKey: null }); // latest full config
  const syncingVault = useRef(false);

  // Sync the "vault"-scoped saved fields with the service: pull the remote blob,
  // merge it into the local cache (last-write-wins), and push the union back. The
  // service only ever sees opaque ciphertext (see vault.ts). Best-effort — no-ops
  // without an API key or a held vault key (provisioned by the desktop pair QR).
  const syncVaultNow = useCallback(async () => {
    if (syncingVault.current) return;
    const { baseUrl, apiKey, vaultKey } = cfgRef.current;
    if (!baseUrl || !apiKey || !vaultKey) return;
    syncingVault.current = true;
    try {
      // Merge only `fields`; pass every other collection (e.g. desktop-saved `cards`)
      // through unchanged so this device never drops them.
      await syncVault({ baseUrl, apiKey }, vaultKey, async (remoteBlob) => ({
        ...remoteBlob,
        fields: await mergeRemoteVault(remoteBlob.fields || {}),
      }));
    } catch (e) {
      // A key mismatch means the vault password changed elsewhere — re-pair to update it.
      if (e instanceof VaultKeyMismatch) console.warn('[keeper] vault: re-pair to update the vault password');
      /* otherwise offline / transient — retried on the next connect or save */
    } finally {
      syncingVault.current = false;
    }
  }, []);

  const applyConfig = useCallback(async () => {
    const cfg = await loadConfig();
    setConfig(cfg);
    setConfigLoaded(true);
    baseUrlRef.current = cfg.baseUrl;
    cfgRef.current = cfg;
    keeper.configure(keeperWsUrl(cfg.baseUrl), cfg.apiKey, cfg.baseUrl);
    keeper.disconnect();
    keeper.connect();
    // Once paired, keep a persistent tray notification (Android) so the Keeper stays
    // alive in the background and keeps answering requests; drop it when unpaired.
    if (cfg.baseUrl && cfg.apiKey) void foregroundService.start();
    else void foregroundService.stop();
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    keeper.on('state', (s) => {
      setConnState(s);
      // On (re)connect, pull vault entries saved on another paired device (and push ours).
      if (s === 'connected') void syncVaultNow();
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
    <Ctx.Provider value={{ config, connState, configLoaded, reloadConfig: applyConfig }}>
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
