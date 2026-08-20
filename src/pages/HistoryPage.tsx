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
import {
  fetchHistory,
  fetchScreenshot,
  getAutofilledIds,
  listCachedScreenshotIds,
  readScreenshot,
  reconcileScreenshots,
  saveScreenshot,
  type HistoryItem,
} from '../lib/history';
import { relTime, absTime, shortUrl } from '../lib/format';
import ImageModal from '../components/ImageModal';

const STATUS_COLOR: Record<string, string> = {
  filled: 'success',
  autofilled: 'success', // keeper filled it silently — a success, like the desktop
  pending: 'primary',
  cancelled: 'warning',
  timeout: 'warning',
  no_keeper: 'medium',
  error: 'danger',
};

function hostOf(u?: string): string {
  try { return u ? new URL(u).host : ''; } catch { return ''; }
}

export default function HistoryPage() {
  const { config } = useApp();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState<string | null>(null);
  const [autoIds, setAutoIds] = useState<Set<string>>(new Set());
  // request_ids with a screenshot cached on this device. Needed alongside the
  // server's `has_screenshot` flag: records written before the service retained
  // proofs carry no flag, yet this device may still hold the image it captured.
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const [shotBusy, setShotBusy] = useState<string | null>(null); // request_id being fetched
  // Tap a session/host chip to narrow the list; tap the active one to clear.
  // Purely client-side over the already-fetched page — no refetch.
  const [filter, setFilter] = useState<{ session: string | null; host: string | null }>({ session: null, host: null });
  const onFilter = (key: 'session' | 'host', value: string | null) =>
    setFilter((f) => ({ ...f, [key]: value }));
  // No hover on a phone, so the exact timestamp is revealed by TAPPING the
  // relative one (per request id) instead of living in a title attribute.
  const [absShown, setAbsShown] = useState<Record<string, boolean>>({});
  const visible = items.filter((it) => (
    (!filter.session || it.session_id === filter.session)
    && (!filter.host || hostOf(it.url) === filter.host)
  ));
  const [present] = useIonToast();

  const load = async () => {
    if (!config.apiKey) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      setAutoIds(await getAutofilledIds());
      const list = await fetchHistory(config.baseUrl, config.credential);
      setItems(list);
      // Off the critical path, but ordered: prune first, then record what survived.
      void (async () => {
        await reconcileScreenshots(new Set(list.map((i) => i.request_id)));
        setCachedIds(await listCachedScreenshotIds());
      })();
    } catch (e: any) {
      setError(e?.message || 'Failed to load history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.apiKey, config.credential, config.baseUrl]);

  // Local cache first (instant, works offline), then the service's proof endpoint —
  // which is the only way to see a fill performed on another device.
  const openShot = async (id: string) => {
    const local = await readScreenshot(id);
    if (local) {
      setZoom(local);
      return;
    }
    setShotBusy(id);
    try {
      const r = await fetchScreenshot(config.baseUrl, config.credential, id);
      if (r.ok) {
        setZoom(r.dataUrl);
        void saveScreenshot(id, r.dataUrl); // cache it — next view is instant and offline
        setCachedIds((s) => new Set(s).add(id));
      } else {
        present({
          message: r.reason === 'absent'
            ? 'No screenshot was captured for this request'
            : "Couldn't load screenshot — check your connection",
          duration: 2000,
          position: 'bottom',
        });
      }
    } finally {
      setShotBusy(null);
    }
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

        {(filter.session || filter.host) && (
          <div className="rb-filterbar">
            <span className="rb-note">Filtered by</span>
            {filter.session && <IonChip color="primary" onClick={() => onFilter('session', null)}>session: {filter.session} ✕</IonChip>}
            {filter.host && <IonChip color="primary" onClick={() => onFilter('host', null)}>{filter.host} ✕</IonChip>}
            <IonNote style={{ marginLeft: 'auto' }}>{visible.length} of {items.length}</IonNote>
          </div>
        )}
        {items.length > 0 && visible.length === 0 && (
          <p className="rb-note" style={{ textAlign: 'center', padding: 16 }}>No requests match this filter.</p>
        )}

        {visible.map((it, i) => {
          const names = (it.fields || []).map((f) => f.label || f.field || f.selector || 'field');
          // The server reports "filled" for a silent auto-fill too; relabel ours.
          const label = it.status === 'filled' && autoIds.has(it.request_id) ? 'autofilled' : it.status || 'unknown';
          return (
            <IonCard key={it.request_id || i}>
              <IonCardContent>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <IonChip color={STATUS_COLOR[label] || 'medium'}>{label}</IonChip>
                  {it.session_id && (
                    <span
                      className={'rb-chip' + (filter.session === it.session_id ? ' rb-chip-active' : '')}
                      onClick={() => onFilter('session', filter.session === it.session_id ? null : it.session_id!)}
                    >session: {it.session_id}</span>
                  )}
                  {/* Tap to swap between "2w ago" and the exact timestamp —
                      phones have no hover, so a title attribute would be dead weight. */}
                  <span
                    style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--rb-muted)' }}
                    title={absTime(it.created_at)}
                    onClick={() => setAbsShown((m) => ({ ...m, [it.request_id]: !m[it.request_id] }))}
                  >
                    {absShown[it.request_id] ? absTime(it.created_at) : relTime(it.created_at)}
                  </span>
                </div>
                {it.url && (
                  <div style={{ marginTop: 6 }}>
                    <span
                      className={'rb-chip url' + (filter.host === hostOf(it.url) ? ' rb-chip-active' : '')}
                      onClick={() => onFilter('host', filter.host === hostOf(it.url) ? null : hostOf(it.url))}
                    >
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
                {/* Only offered when an image actually exists somewhere — the server
                    says so, or we still hold the one this device captured. */}
                {(it.has_screenshot || cachedIds.has(it.request_id)) && (
                  <IonButton
                    size="small"
                    fill="outline"
                    style={{ marginTop: 8 }}
                    disabled={shotBusy === it.request_id}
                    onClick={() => openShot(it.request_id)}
                  >
                    {shotBusy === it.request_id ? <IonSpinner name="dots" style={{ height: 16 }} /> : 'View screenshot'}
                  </IonButton>
                )}
              </IonCardContent>
            </IonCard>
          );
        })}

        <ImageModal src={zoom} onClose={() => setZoom(null)} />
      </IonContent>
    </IonPage>
  );
}
