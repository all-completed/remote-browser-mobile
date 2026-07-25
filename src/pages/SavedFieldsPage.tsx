import { useEffect, useState } from 'react';
import {
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonChip,
  IonContent,
  IonHeader,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonTitle,
  IonToolbar,
  useIonAlert,
  useIonToast,
} from '@ionic/react';
import type { RefresherEventDetail } from '@ionic/react';
import { forgetAll, forgetMeta, getSaved, listSaved, type SavedMeta } from '../lib/fieldStore';

// Management screen: lists values kept on this device and lets the user forget any
// (or all). A value is shown only when the user taps Reveal (e.g. to read a generated
// password); it is never sent to any model.
export default function SavedFieldsPage() {
  const [items, setItems] = useState<SavedMeta[]>([]);
  const [shown, setShown] = useState<Record<string, string>>({}); // key -> revealed value
  const [present] = useIonToast();
  const [presentAlert] = useIonAlert();

  const keyOf = (m: SavedMeta) => `${m.baseUrl}|${m.session}|${m.host}|${m.selector}`;
  const toggleReveal = async (m: SavedMeta) => {
    const k = keyOf(m);
    if (shown[k] != null) { setShown((s) => { const n = { ...s }; delete n[k]; return n; }); return; }
    const v = await getSaved(m.baseUrl, m.session, m.host, m.selector);
    if (v && v.value != null) setShown((s) => ({ ...s, [k]: v.value }));
    else present({ message: 'No value found', duration: 1200, position: 'bottom' });
  };

  const load = async () => {
    setItems(await listSaved());
    setShown({});
  };

  useEffect(() => {
    void load();
  }, []);

  // The actual deletes run only after the user approves the confirmation alert.
  const doForget = async (m: SavedMeta) => {
    await forgetMeta(m);
    await load();
    present({ message: 'Forgotten', duration: 1200, position: 'bottom' });
  };
  const doForgetAll = async () => {
    await forgetAll();
    await load();
    present({ message: 'All saved fields forgotten', duration: 1400, position: 'bottom' });
  };

  const onForget = (m: SavedMeta) =>
    presentAlert({
      header: 'Forget saved field?',
      message: `Forget the saved value for ${m.host}? This can't be undone.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Forget', role: 'destructive', handler: () => void doForget(m) },
      ],
    });

  const onForgetAll = () =>
    presentAlert({
      header: 'Forget all?',
      message: `Forget all ${items.length} saved field${items.length === 1 ? '' : 's'}? This can't be undone.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Forget all', role: 'destructive', handler: () => void doForgetAll() },
      ],
    });

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Saved fields</IonTitle>
          {items.length > 0 && (
            <IonButtons slot="end">
              <IonButton color="danger" onClick={onForgetAll}>
                Forget all
              </IonButton>
            </IonButtons>
          )}
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <IonRefresher
          slot="fixed"
          onIonRefresh={async (e: CustomEvent<RefresherEventDetail>) => {
            await load();
            e.detail.complete();
          }}
        >
          <IonRefresherContent />
        </IonRefresher>

        <p className="rb-note">
          Values you chose to keep. Never sent to the AI model; shown only when you tap <b>Reveal</b>.
        </p>

        {items.length === 0 ? (
          <p className="rb-note" style={{ textAlign: 'center', padding: 24 }}>
            No saved fields.
          </p>
        ) : (
          items.map((m, i) => (
            <IonCard key={m.baseUrl + '|' + m.session + '|' + m.host + '|' + m.selector + '|' + i}>
              <IonCardContent>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <IonChip color={m.scope === 'vault' ? 'tertiary' : m.scope === 'forever' ? 'success' : 'warning'}>
                    {m.scope === 'vault' ? 'vault · synced' : m.scope === 'forever' ? 'on this device' : 'until restart'}
                  </IonChip>
                  {m.auto && <IonChip color="primary">auto-fill</IonChip>}
                  <IonButton size="small" fill="outline" style={{ marginLeft: 'auto' }} onClick={() => void toggleReveal(m)}>
                    {shown[keyOf(m)] != null ? 'Hide' : 'Reveal'}
                  </IonButton>
                  <IonButton size="small" fill="outline" color="danger" onClick={() => onForget(m)}>
                    Forget
                  </IonButton>
                </div>
                <div style={{ marginTop: 6 }}>
                  <span className="rb-chip url" title={m.host}>
                    {m.host || '—'}
                  </span>
                  <span className="rb-chip" style={{ marginLeft: 6 }}>
                    session: {m.session || '—'}
                  </span>
                </div>
                <div style={{ marginTop: 6, fontSize: 13, wordBreak: 'break-all' }}>
                  <span style={{ color: 'var(--rb-muted2)' }}>selector: </span>
                  {m.selector}
                </div>
                {shown[keyOf(m)] != null && (
                  <div style={{ marginTop: 8, fontSize: 14, wordBreak: 'break-all' }}>
                    <span style={{ color: 'var(--rb-muted2)' }}>value: </span>
                    <code style={{ userSelect: 'all', background: 'rgba(255,255,255,.07)', padding: '2px 6px', borderRadius: 5 }}>
                      {shown[keyOf(m)]}
                    </code>
                  </div>
                )}
              </IonCardContent>
            </IonCard>
          ))
        )}
      </IonContent>
    </IonPage>
  );
}
