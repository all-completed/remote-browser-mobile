import { useEffect, useState } from 'react';
import {
  IonButton,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonNote,
  IonPage,
  IonTitle,
  IonToolbar,
  useIonToast,
} from '@ionic/react';
import { useApp } from '../App';
import { loadConfig, saveConfig } from '../lib/config';

export default function SettingsPage() {
  const { reloadConfig, connState } = useApp();
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [present] = useIonToast();

  useEffect(() => {
    loadConfig().then((c) => {
      setBaseUrl(c.baseUrl);
      setApiKey(c.apiKey);
    });
  }, []);

  const save = async () => {
    await saveConfig({ baseUrl, apiKey });
    await reloadConfig();
    present({ message: 'Saved — reconnecting', duration: 1500, position: 'bottom' });
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Settings</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <IonItem>
          <IonLabel position="stacked">Service URL</IonLabel>
          <IonInput
            value={baseUrl}
            placeholder="https://rb.all-completed.com"
            autocapitalize="off"
            autocomplete="off"
            onIonInput={(e) => setBaseUrl(e.detail.value || '')}
          />
        </IonItem>
        <IonItem>
          <IonLabel position="stacked">API key</IonLabel>
          <IonInput
            type="password"
            value={apiKey}
            placeholder="paste API key"
            autocapitalize="off"
            autocomplete="off"
            onIonInput={(e) => setApiKey(e.detail.value || '')}
          />
        </IonItem>

        <IonNote className="rb-note" style={{ display: 'block', marginTop: 10 }}>
          Used to connect to the Keeper channel and list your request history. Stored locally on this device. The token
          is sent via the WebSocket subprotocol, never in the URL.
        </IonNote>

        <IonButton expand="block" style={{ marginTop: 16 }} onClick={save}>
          Save &amp; connect
        </IonButton>

        <p className="rb-note" style={{ marginTop: 12 }}>
          Status: {connState}
        </p>
      </IonContent>
    </IonPage>
  );
}
