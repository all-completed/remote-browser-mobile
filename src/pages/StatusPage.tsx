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
} from '@ionic/react';
import { ellipse } from 'ionicons/icons';
import { useApp } from '../App';
import { serviceHost } from '../lib/config';

export default function StatusPage() {
  const { config, connState, reloadConfig } = useApp();
  const host = serviceHost(config.baseUrl);
  const label =
    connState === 'connected' ? 'Connected' : connState === 'reconnecting' ? 'Reconnecting…' : 'Disconnected';
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
            {!config.apiKey && (
              <p className="rb-note">No API key set. Open Settings to connect.</p>
            )}
            <IonButton
              size="small"
              fill="outline"
              style={{ marginTop: 10 }}
              onClick={() => { void reloadConfig(); }}
            >
              Reconnect
            </IonButton>
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
