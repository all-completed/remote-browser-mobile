import { useEffect } from 'react';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonContent,
  IonHeader,
  IonIcon,
  IonPage,
  IonTitle,
  IonToolbar,
  useIonRouter,
} from '@ionic/react';
import { ellipse } from 'ionicons/icons';
import { useApp } from '../App';
import { serviceHost } from '../lib/config';

export default function StatusPage() {
  const { config, connState, configLoaded, reloadConfig } = useApp();
  const router = useIonRouter();
  const host = serviceHost(config.baseUrl);

  // Nothing works without a token — send the user straight to Settings to pair.
  useEffect(() => {
    if (configLoaded && !config.apiKey) {
      router.push('/settings', 'forward', 'replace');
    }
  }, [configLoaded, config.apiKey, router]);
  const label =
    connState === 'connected' ? 'Connected'
    : connState === 'reconnecting' ? 'Reconnecting…'
    : connState === 'unauthorized' ? 'Authentication failed'
    : 'Disconnected';
  const cls = connState === 'connected' ? 'ok' : connState === 'reconnecting' ? 'warn' : 'off';

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Remote Browser Keeper</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <IonCard>
          <IonCardContent>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IonIcon icon={ellipse} className={`rb-dot ${cls}`} />
              <strong style={{ color: 'var(--rb-text)' }}>{label}</strong>
            </div>
            <p className="rb-note" style={{ marginTop: 8 }}>
              Service: {host || '—'}
            </p>
            {!config.apiKey ? (
              <>
                <p className="rb-note">No API key set. Pair a device or paste a key in Settings.</p>
                <IonButton size="small" fill="outline" style={{ marginTop: 10 }} routerLink="/settings">
                  Open Settings
                </IonButton>
              </>
            ) : connState === 'unauthorized' ? (
              <>
                <p className="rb-note" style={{ color: 'var(--ion-color-danger, #eb445a)' }}>
                  The service rejected your API key — it may be wrong or expired. Update it in Settings or re-pair.
                </p>
                <IonButton size="small" color="danger" style={{ marginTop: 10 }} routerLink="/settings">
                  Go to Settings
                </IonButton>
              </>
            ) : (
              <IonButton size="small" fill="outline" style={{ marginTop: 10 }} onClick={() => { void reloadConfig(); }}>
                Reconnect
              </IonButton>
            )}
          </IonCardContent>
        </IonCard>

        <p className="rb-note" style={{ marginTop: 16 }}>
          When a remote session needs a password or code, a prompt appears here. You enter the value; it is sent to the
          service and typed into the form for you. The value is never shown to the AI model.
        </p>
      </IonContent>
    </IonPage>
  );
}
