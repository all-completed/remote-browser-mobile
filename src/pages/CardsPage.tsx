import { useCallback, useEffect, useState } from 'react';
import {
  IonButton, IonCard, IonCardContent, IonChip, IonContent, IonHeader, IonPage,
  IonRefresher, IonRefresherContent, IonTitle, IonToolbar,
} from '@ionic/react';
import type { RefresherEventDetail } from '@ionic/react';
import { useApp } from '../App';
import { pullVault } from '../lib/vault';

// Read-only view of the saved cards synced in the vault. Cards are created/managed on the
// desktop Keeper; here we just pull the vault, decrypt it with the device's vault key, and
// show the `cards` collection. Numbers/CVV are masked until the user taps Reveal, and the
// values never leave the device / never reach any model.
type Card = {
  holder?: string; number?: string; cvv?: string; exp_month?: string; exp_year?: string;
  domains?: string[]; deleted?: boolean; updated_at?: string;
};

export default function CardsPage() {
  const { config } = useApp();
  const [cards, setCards] = useState<Array<{ id: string } & Card>>([]);
  const [status, setStatus] = useState<'loading' | 'ok' | 'nokey' | 'error'>('loading');
  const [shown, setShown] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const { baseUrl, apiKey, credential, vaultKey } = config;
    if (!baseUrl || !apiKey || !vaultKey) { setStatus('nokey'); setCards([]); return; }
    setStatus('loading');
    try {
      const { data } = await pullVault({ baseUrl, apiKey: credential }, vaultKey);
      const map = ((data as any) && (data as any).cards) || {};
      const live = Object.entries(map)
        .filter(([, e]) => e && !(e as Card).deleted)
        .map(([id, e]) => ({ id, ...(e as Card) }));
      setCards(live);
      setStatus('ok');
    } catch {
      setStatus('error'); // wrong key (re-pair) or offline
    }
  }, [config]);

  useEffect(() => { void load(); }, [load]);

  const digits = (n?: string) => String(n || '').replace(/\D/g, '');
  const mask = (n?: string) => { const d = digits(n); return d ? '•••• •••• •••• ' + d.slice(-4) : '—'; };
  const exp = (c: Card) => (c.exp_month || c.exp_year)
    ? `${String(c.exp_month || '').padStart(2, '0')}/${String(c.exp_year || '').slice(-2)}` : '';

  return (
    <IonPage>
      <IonHeader><IonToolbar><IonTitle>Cards</IonTitle></IonToolbar></IonHeader>
      <IonContent className="ion-padding">
        <IonRefresher slot="fixed" onIonRefresh={async (e: CustomEvent<RefresherEventDetail>) => { await load(); e.detail.complete(); }}>
          <IonRefresherContent />
        </IonRefresher>

        <p className="rb-note">
          Saved cards from your synced vault (read-only here — manage them on the desktop Keeper).
          End-to-end encrypted; card numbers show only when you tap <b>Reveal</b>.
        </p>

        {status === 'loading' && <p className="rb-note" style={{ textAlign: 'center', padding: 24 }}>Loading…</p>}
        {status === 'nokey' && <p className="rb-note" style={{ textAlign: 'center', padding: 24 }}>Pair this device (Settings → Scan) to load the vault.</p>}
        {status === 'error' && <p className="rb-note" style={{ textAlign: 'center', padding: 24 }}>Couldn’t load the vault — re-pair if the password changed, or pull to retry.</p>}
        {status === 'ok' && cards.length === 0 && <p className="rb-note" style={{ textAlign: 'center', padding: 24 }}>No saved cards.</p>}

        {cards.map((c) => (
          <IonCard key={c.id}>
            <IonCardContent>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <IonChip color="tertiary">{c.id}</IonChip>
                {c.holder && <span className="rb-chip">{c.holder}</span>}
                <IonButton size="small" fill="outline" style={{ marginLeft: 'auto' }} onClick={() => setShown((s) => ({ ...s, [c.id]: !s[c.id] }))}>
                  {shown[c.id] ? 'Hide' : 'Reveal'}
                </IonButton>
              </div>
              <div style={{ marginTop: 8, fontSize: 15 }}>
                <code style={{ userSelect: 'all', letterSpacing: 0.5 }}>{shown[c.id] ? (digits(c.number) || '—') : mask(c.number)}</code>
                {exp(c) && <span style={{ marginLeft: 12, color: 'var(--rb-muted2)' }}>exp {exp(c)}</span>}
                {shown[c.id] && c.cvv && <span style={{ marginLeft: 12 }}>cvv <code style={{ userSelect: 'all' }}>{c.cvv}</code></span>}
              </div>
              {Array.isArray(c.domains) && c.domains.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--rb-muted2)' }}>
                  auto-fill: {c.domains.map((d) => (d === '*' ? 'all sites' : d)).join(', ')}
                </div>
              )}
            </IonCardContent>
          </IonCard>
        ))}
      </IonContent>
    </IonPage>
  );
}
