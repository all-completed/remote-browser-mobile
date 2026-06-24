import { useEffect, useState } from 'react';
import {
  IonButton,
  IonButtons,
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
import { qrCodeOutline, scanOutline } from 'ionicons/icons';
import { IonIcon } from '@ionic/react';
import { useApp } from '../App';
import { loadConfig, saveConfig } from '../lib/config';
import { makeQrDataUrl, parsePayload } from '../lib/pair';
import { canScan, scanQr } from '../lib/scan';

export default function SettingsPage() {
  const { reloadConfig, connState } = useApp();
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [qr, setQr] = useState<string | null>(null);
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

  // Show a QR of the current config so another device can scan it to pair.
  const showQr = async () => {
    if (!apiKey) {
      present({ message: 'Set an API key first', duration: 1500, position: 'bottom' });
      return;
    }
    if (qr) {
      setQr(null);
      return;
    }
    try {
      setQr(await makeQrDataUrl({ baseUrl, apiKey }));
    } catch (e: any) {
      present({ message: 'Could not build QR: ' + (e?.message || e), duration: 2000, position: 'bottom' });
    }
  };

  // Scan a QR shown by the desktop Keeper (or another device) and pair instantly.
  const scan = async () => {
    if (!canScan()) {
      present({ message: 'Scanning is available in the installed app', duration: 2000, position: 'bottom' });
      return;
    }
    try {
      const text = await scanQr();
      if (!text) return; // cancelled
      const cfg = parsePayload(text);
      if (!cfg) {
        present({ message: 'Not a Keeper pairing code', duration: 2000, position: 'bottom' });
        return;
      }
      setBaseUrl(cfg.baseUrl);
      setApiKey(cfg.apiKey);
      await saveConfig(cfg);
      await reloadConfig();
      present({ message: 'Paired — reconnecting', duration: 1800, position: 'bottom' });
    } catch (e: any) {
      present({ message: 'Scan failed: ' + (e?.message || e), duration: 2200, position: 'bottom' });
    }
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Settings</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={scan}>
              <IonIcon slot="icon-only" icon={scanOutline} />
            </IonButton>
          </IonButtons>
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

        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <IonButton fill="outline" expand="block" style={{ flex: 1 }} onClick={scan}>
            <IonIcon slot="start" icon={scanOutline} />
            Scan QR
          </IonButton>
          <IonButton fill="outline" expand="block" style={{ flex: 1 }} onClick={showQr}>
            <IonIcon slot="start" icon={qrCodeOutline} />
            {qr ? 'Hide QR' : 'Show QR'}
          </IonButton>
        </div>

        {qr && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginTop: 14 }}>
            <img
              src={qr}
              alt="Pairing QR"
              width={240}
              height={240}
              style={{ background: '#fff', borderRadius: 12, padding: 10 }}
            />
            <p className="rb-note" style={{ textAlign: 'center', maxWidth: 300 }}>
              Scan from another device to copy this service URL and token. It grants full access — show it only to your
              own devices.
            </p>
          </div>
        )}

        <p className="rb-note" style={{ marginTop: 12 }}>
          Status: {connState}
        </p>
      </IonContent>
    </IonPage>
  );
}
