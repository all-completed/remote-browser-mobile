import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IonReactRouter } from '@ionic/react-router';
import { IonIcon, IonLabel, IonRouterOutlet, IonTabBar, IonTabButton, IonTabs } from '@ionic/react';
import { Redirect, Route } from 'react-router-dom';
import { homeOutline, settingsOutline, timeOutline } from 'ionicons/icons';
import { App as CapApp } from '@capacitor/app';

import { keeper, type ConnState, type FillRequest } from './lib/keeperClient';
import { keeperWsUrl, loadConfig, type Config } from './lib/config';
import { saveScreenshot } from './lib/history';
import StatusPage from './pages/StatusPage';
import HistoryPage from './pages/HistoryPage';
import SettingsPage from './pages/SettingsPage';
import PromptModal from './components/PromptModal';

interface AppCtx {
  config: Config;
  connState: ConnState;
  reloadConfig: () => Promise<void>;
}

const Ctx = createContext<AppCtx>({
  config: { baseUrl: '', apiKey: '' },
  connState: 'disconnected',
  reloadConfig: async () => {},
});

export const useApp = () => useContext(Ctx);

export default function App() {
  const [config, setConfig] = useState<Config>({ baseUrl: '', apiKey: '' });
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [queue, setQueue] = useState<FillRequest[]>([]);
  const started = useRef(false);

  const applyConfig = useCallback(async () => {
    const cfg = await loadConfig();
    setConfig(cfg);
    keeper.configure(keeperWsUrl(cfg.baseUrl), cfg.apiKey);
    keeper.disconnect();
    keeper.connect();
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    keeper.on('state', setConnState);
    keeper.on('request', (req) => setQueue((q) => [...q, req]));
    applyConfig();

    // Dev-only: lets a web preview inject a simulated fill_request to exercise the
    // prompt UI without a live connection. Stripped from production builds.
    if (import.meta.env.DEV) {
      (window as any).__injectFill = (req: FillRequest) => setQueue((q) => [...q, req]);
    }

    // Foreground-only: (re)connect when the app becomes active, drop on pause.
    const resume = CapApp.addListener('resume', () => keeper.connect());
    const pause = CapApp.addListener('pause', () => keeper.disconnect());
    return () => {
      resume.then((h) => h.remove());
      pause.then((h) => h.remove());
    };
  }, [applyConfig]);

  const current = queue[0] || null;

  const finish = (req: FillRequest, payload: { values?: { selector: string; value: string }[]; cancelled?: boolean }) => {
    if (payload.cancelled) keeper.cancel(req.request_id);
    else keeper.submit(req.request_id, payload.values || []);
    // Cache the proof screenshot locally so History can show it (no values stored).
    if (req.screenshot) void saveScreenshot(req.request_id, req.screenshot);
    setQueue((q) => q.filter((r) => r.request_id !== req.request_id));
  };

  return (
    <Ctx.Provider value={{ config, connState, reloadConfig: applyConfig }}>
      {current && (
        <PromptModal
          request={current}
          onSubmit={(values) => finish(current, { values })}
          onCancel={() => finish(current, { cancelled: true })}
        />
      )}
      <IonReactRouter>
        <IonTabs>
          <IonRouterOutlet>
            <Route exact path="/status" component={StatusPage} />
            <Route exact path="/history" component={HistoryPage} />
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
