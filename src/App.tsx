import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IonReactRouter } from '@ionic/react-router';
import { IonIcon, IonLabel, IonRouterOutlet, IonTabBar, IonTabButton, IonTabs } from '@ionic/react';
import { Redirect, Route } from 'react-router-dom';
import { homeOutline, keyOutline, settingsOutline, timeOutline } from 'ionicons/icons';
import { App as CapApp } from '@capacitor/app';

import { keeper, type ConnState, type FillRequest } from './lib/keeperClient';
import { foregroundService } from './lib/foregroundService';
import { keeperWsUrl, loadConfig, type Config } from './lib/config';
import { saveScreenshot } from './lib/history';
import { getSaved, hostFromUrl } from './lib/fieldStore';
import StatusPage from './pages/StatusPage';
import HistoryPage from './pages/HistoryPage';
import SettingsPage from './pages/SettingsPage';
import SavedFieldsPage from './pages/SavedFieldsPage';
import PromptModal from './components/PromptModal';

const isCard = (field?: string) => String(field || '').toLowerCase().startsWith('card-');

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
  config: { baseUrl: '', apiKey: '' },
  connState: 'disconnected',
  configLoaded: false,
  reloadConfig: async () => {},
});

export const useApp = () => useContext(Ctx);

export default function App() {
  const [config, setConfig] = useState<Config>({ baseUrl: '', apiKey: '' });
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [configLoaded, setConfigLoaded] = useState(false);
  const [queue, setQueue] = useState<FillRequest[]>([]);
  const started = useRef(false);
  const baseUrlRef = useRef(''); // latest base URL for the once-registered request listener

  const applyConfig = useCallback(async () => {
    const cfg = await loadConfig();
    setConfig(cfg);
    setConfigLoaded(true);
    baseUrlRef.current = cfg.baseUrl;
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
        if (await tryAutoFill(req, baseUrlRef.current)) return;
        setQueue((q) => [...q, req]);
        // Ping the user (sound + vibration + heads-up) so a backgrounded request
        // isn't missed; cleared when they answer (see finish()).
        void foregroundService.notifyRequest('🔐 A session needs a value', req.message || 'Tap to respond in the Keeper');
      })();
    });
    applyConfig();

    // Dev-only: lets a web preview inject a simulated fill_request to exercise the
    // prompt UI without a live connection. Stripped from production builds.
    if (import.meta.env.DEV) {
      (window as any).__injectFill = (req: FillRequest) => setQueue((q) => [...q, req]);
    }

    // Always-on: a foreground service keeps the process alive in the background, so
    // we stay connected on pause (no disconnect) and only re-assert the socket on
    // resume as a recovery (e.g. if the OS dropped it during deep Doze).
    const resume = CapApp.addListener('resume', () => keeper.connect());
    return () => {
      resume.then((h) => h.remove());
    };
  }, [applyConfig]);

  const current = queue[0] || null;

  const finish = (req: FillRequest, payload: { values?: { selector: string; value: string }[]; cancelled?: boolean }) => {
    if (payload.cancelled) keeper.cancel(req.request_id);
    else keeper.submit(req.request_id, payload.values || []);
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
