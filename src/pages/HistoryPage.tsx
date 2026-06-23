import { useEffect, useState } from 'react';
import {
  IonCard,
  IonCardContent,
  IonChip,
  IonContent,
  IonHeader,
  IonNote,
  IonButton,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
  IonTitle,
  IonToolbar,
  useIonToast,
} from '@ionic/react';
import type { RefresherEventDetail } from '@ionic/react';
import { useApp } from '../App';
import { fetchHistory, readScreenshot, reconcileScreenshots, type HistoryItem } from '../lib/history';
import { fmtTime, shortUrl } from '../lib/format';
import ImageModal from '../components/ImageModal';

const STATUS_COLOR: Record<string, string> = {
  filled: 'success',
  pending: 'primary',
  cancelled: 'warning',
  timeout: 'warning',
  no_keeper: 'medium',
  error: 'danger',
};

export default function HistoryPage() {
  const { config } = useApp();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState<string | null>(null);
  const [present] = useIonToast();

  const load = async () => {
    if (!config.apiKey) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const list = await fetchHistory(config.baseUrl, config.apiKey);
      setItems(list);
      void reconcileScreenshots(new Set(list.map((i) => i.request_id)));
    } catch (e: any) {
      setError(e?.message || 'Failed to load history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.apiKey, config.baseUrl]);

  const openShot = async (id: string) => {
    const d = await readScreenshot(id);
    if (d) setZoom(d);
    else present({ message: 'Screenshot not stored on this device', duration: 1500, position: 'bottom' });
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>History</IonTitle>
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

        {loading && items.length === 0 && (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IonSpinner />
          </div>
        )}
        {error && <IonNote color="danger">{error}</IonNote>}
        {!loading && items.length === 0 && !error && (
          <p className="rb-note" style={{ textAlign: 'center', padding: 24 }}>
            No requests yet.
          </p>
        )}

        {items.map((it, i) => {
          const names = (it.fields || []).map((f) => f.label || f.field || f.selector || 'field');
          return (
            <IonCard key={it.request_id || i}>
              <IonCardContent>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <IonChip color={STATUS_COLOR[it.status || ''] || 'medium'}>{it.status || 'unknown'}</IonChip>
                  {it.session_id && <span className="rb-chip">session: {it.session_id}</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--rb-muted)' }}>
                    {fmtTime(it.created_at)}
                  </span>
                </div>
                {it.url && (
                  <div style={{ marginTop: 6 }}>
                    <span className="rb-chip url" title={it.url}>
                      {shortUrl(it.url)}
                    </span>
                  </div>
                )}
                {names.length > 0 && (
                  <div style={{ marginTop: 6, fontSize: 13 }}>
                    <span style={{ color: 'var(--rb-muted2)' }}>
                      {names.length === 1 ? 'field: ' : `${names.length} fields: `}
                    </span>
                    {names.join(', ')}
                  </div>
                )}
                {it.message && (
                  <div className="rb-note" style={{ marginTop: 6 }}>
                    {it.message}
                  </div>
                )}
                <IonButton size="small" fill="outline" style={{ marginTop: 8 }} onClick={() => openShot(it.request_id)}>
                  View screenshot
                </IonButton>
              </IonCardContent>
            </IonCard>
          );
        })}

        <ImageModal src={zoom} onClose={() => setZoom(null)} />
      </IonContent>
    </IonPage>
  );
}
