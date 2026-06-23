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
  useIonToast,
} from '@ionic/react';
import type { RefresherEventDetail } from '@ionic/react';
import { forgetAll, forgetMeta, listSaved, type SavedMeta } from '../lib/fieldStore';

// Management screen: lists values kept on this device and lets the user forget any
// (or all). Only metadata is shown — the value itself is never displayed or sent to
// any model.
export default function SavedFieldsPage() {
  const [items, setItems] = useState<SavedMeta[]>([]);
  const [present] = useIonToast();

  const load = async () => {
    setItems(await listSaved());
  };

  useEffect(() => {
    void load();
  }, []);

  const onForget = async (m: SavedMeta) => {
    await forgetMeta(m);
    await load();
    present({ message: 'Forgotten', duration: 1200, position: 'bottom' });
  };

  const onForgetAll = async () => {
    await forgetAll();
    await load();
    present({ message: 'All saved fields forgotten', duration: 1400, position: 'bottom' });
  };

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
          Values you chose to keep on this device. They are stored locally, never shown here, and never sent to the AI model.
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
                  <IonChip color={m.scope === 'forever' ? 'success' : 'medium'}>
                    {m.scope === 'forever' ? 'on this device' : 'until restart'}
                  </IonChip>
                  {m.auto && <IonChip color="primary">auto-fill</IonChip>}
                  <IonButton size="small" fill="outline" color="danger" style={{ marginLeft: 'auto' }} onClick={() => onForget(m)}>
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
              </IonCardContent>
            </IonCard>
          ))
        )}
      </IonContent>
    </IonPage>
  );
}
