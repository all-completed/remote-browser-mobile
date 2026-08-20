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
  IonToggle,
  IonToolbar,
  useIonToast,
} from '@ionic/react';
import { qrCodeOutline, scanOutline } from 'ionicons/icons';
import { IonIcon } from '@ionic/react';
import { useApp } from '../App';
import { clearDeviceToken, loadConfig, loadSecret, loadVaultKey, saveConfig } from '../lib/config';
import { loadGenerateShowWindow, setGenerateShowWindow } from '../lib/settings';
import { makeQrDataUrl, parsePayload } from '../lib/pair';
import { canScan, scanQr } from '../lib/scan';

// What this device's vault state means, and what the user can do about it. The four states
// come from vaultState() (src/lib/vaultCrypto.ts) — in particular "no vault key at all" and
// "holds a vault it cannot decrypt" are different problems with different fixes.
const VAULT_STATE_TEXT: Record<string, { text: string; bad?: boolean }> = {
  ok: { text: 'In sync — current key model (v2).' },
  no_key: { text: 'No vault key on this device — saved values stay on this phone. Scan the desktop Keeper’s QR to receive one.' },
  needs_repair: { text: 'This device holds a vault key that no longer opens the stored vault — the vault password was changed on another device. Re-pair to update it.', bad: true },
  legacy_v1: { text: 'Legacy key model — needs migration. Re-pair from a device on the v2 key model to re-encrypt this vault.', bad: true },
};

export default function SettingsPage() {
  const { reloadConfig, connState, deviceReport, config } = useApp();
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [genShowWindow, setGenShowWindow] = useState(false);
  const [present] = useIonToast();

  // Sharing this device's QR only makes sense with a usable token — hide it when
  // the key is absent or the service rejected it (corrupted/expired → unauthorized).
  const canShare = !!apiKey.trim() && connState !== 'unauthorized';

  useEffect(() => {
    loadConfig().then((c) => {
      setBaseUrl(c.baseUrl);
      setApiKey(c.apiKey);
    });
    loadGenerateShowWindow().then(setGenShowWindow);
  }, []);

  const toggleGenShowWindow = async (on: boolean) => {
    setGenShowWindow(on); // optimistic
    await setGenerateShowWindow(on);
  };

  // A device token belongs to the account key it was minted under, so a *different* key
  // means the old token names a device on someone else's fleet. Dropping it here turns
  // what would be a 401-then-recover cycle into a clean re-enrollment. Re-entering the
  // same key keeps the enrollment, which is what avoids orphaning records server-side.
  const forgetTokenIfKeyChanged = async (nextKey: string) => {
    if (nextKey.trim() && nextKey.trim() !== config.apiKey) await clearDeviceToken();
  };

  const save = async () => {
    await forgetTokenIfKeyChanged(apiKey);
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
      const secret = await loadSecret(); // re-share the session secret + vault key we hold
      const vaultKey = await loadVaultKey();
      setQr(await makeQrDataUrl({ baseUrl, apiKey, secret: secret || undefined, vault: vaultKey || undefined }));
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
      await forgetTokenIfKeyChanged(cfg.apiKey);
      await saveConfig({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, secret: cfg.secret, vaultKey: cfg.vault });
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

        {/* Which credential this phone actually presents (issue #12). "Account key" is
            not a fault — it is how every Keeper worked before per-device tokens, and how
            this one keeps working against a service that doesn't issue them. */}
        <IonNote className="rb-note" style={{ display: 'block', marginTop: 8 }}>
          {config.deviceToken
            ? 'Enrolled: this phone connects with its own token, so it can be revoked on its own without affecting your other devices or your API key.'
            : 'This phone connects with the shared account key. It enrolls for a token of its own automatically if the service offers one.'}
        </IonNote>

        <IonButton expand="block" style={{ marginTop: 16 }} onClick={save}>
          Save &amp; connect
        </IonButton>

        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <IonButton fill="outline" expand="block" style={{ flex: 1 }} onClick={scan}>
            <IonIcon slot="start" icon={scanOutline} />
            Scan QR
          </IonButton>
          {/* Only offer to share this device's QR when there's a usable token to share —
              not when it's missing or the service rejected it (unauthorized). */}
          {canShare && (
            <IonButton fill="outline" expand="block" style={{ flex: 1 }} onClick={showQr}>
              <IonIcon slot="start" icon={qrCodeOutline} />
              {qr ? 'Hide QR' : 'Show QR'}
            </IonButton>
          )}
        </div>

        {canShare && qr && (
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

        <div style={{ marginTop: 22 }}>
          <div style={{ fontSize: 12.5, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.6, margin: '0 0 6px 4px' }}>
            Password generation
          </div>
          <IonItem>
            <IonLabel className="ion-text-wrap">
              Show the password window when generating
              <IonNote className="rb-note" style={{ display: 'block', marginTop: 4 }}>
                Off: a new password is generated, filled, and saved automatically — you're never asked. On: the Keeper
                opens the prompt with the generated password so you can review, edit, or regenerate it before it fills.
              </IonNote>
            </IonLabel>
            <IonToggle
              slot="end"
              checked={genShowWindow}
              onIonChange={(e) => toggleGenShowWindow(e.detail.checked)}
            />
          </IonItem>
        </div>

        {/* Who this device is and which vault it holds — answerable without the service.
            The same report is what goes on the wire (src/lib/device.ts); nothing here is
            secret: no vault password, no derived key, and no vault id for a legacy key. */}
        {deviceReport && (
          <div style={{ marginTop: 22 }}>
            <div style={{ fontSize: 12.5, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.6, margin: '0 0 6px 4px' }}>
              This device
            </div>
            <IonItem>
              <IonLabel className="ion-text-wrap">
                {deviceReport.device.name}
                <IonNote className="rb-note" style={{ display: 'block', marginTop: 4 }}>
                  {deviceReport.device.platform} · v{deviceReport.device.app_version}
                </IonNote>
                <IonNote className="rb-note" style={{ display: 'block', marginTop: 2 }}>
                  Device ID {deviceReport.device.id}
                </IonNote>
              </IonLabel>
            </IonItem>
            <IonItem>
              <IonLabel className="ion-text-wrap">
                Vault
                <IonNote className="rb-note" style={{ display: 'block', marginTop: 4 }}>
                  {deviceReport.vault.has_key
                    ? `schema ${deviceReport.vault.schema} · ${deviceReport.vault.key_format}` +
                      (deviceReport.vault.version != null ? ` · version ${deviceReport.vault.version}` : ' · not synced yet')
                    : 'No vault key held'}
                </IonNote>
                {/* v2 only: under legacy v1 this id IS the encryption key, so there is
                    none to show (src/lib/vaultCrypto.ts's vaultKeyReport). */}
                {deviceReport.vault.secret_id && (
                  <IonNote className="rb-note" style={{ display: 'block', marginTop: 2 }}>
                    Vault ID {deviceReport.vault.secret_id}
                  </IonNote>
                )}
                <IonNote
                  className="rb-note"
                  style={{
                    display: 'block',
                    marginTop: 6,
                    ...(VAULT_STATE_TEXT[deviceReport.vault.state]?.bad ? { color: 'var(--ion-color-danger, #eb445a)' } : {}),
                  }}
                >
                  {VAULT_STATE_TEXT[deviceReport.vault.state]?.text || deviceReport.vault.state}
                </IonNote>
              </IonLabel>
            </IonItem>
          </div>
        )}

        <p className="rb-note" style={{ marginTop: 12 }}>
          Status: {connState}
        </p>
      </IonContent>
    </IonPage>
  );
}
