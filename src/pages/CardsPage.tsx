import { useCallback, useEffect, useState } from 'react';
import {
  IonButton, IonButtons, IonCard, IonCardContent, IonChip, IonContent, IonHeader, IonPage,
  IonRefresher, IonRefresherContent, IonTitle, IonToggle, IonToolbar, useIonAlert, useIonToast,
} from '@ionic/react';
import type { RefresherEventDetail } from '@ionic/react';
import { useApp } from '../App';
import CardFormModal, { type CardFormResult } from '../components/CardFormModal';
import { pullVault, syncVault, VaultKeyMismatch } from '../lib/vault';
import type { VaultBlob } from '../lib/vaultCrypto';
import {
  applyCardOp, defaultCardId, digitsOnly, liveCards, uniqueCardId, type Card, type CardOp,
} from '../lib/cards';

// Saved cards in the synced vault: list, add, edit, delete, and pick the default — the
// same data model as the desktop Keeper's Cards window (src/lib/cards.ts). The vault is
// pulled and decrypted with the device's vault key; every change is written back through
// syncVault's pull → merge → push (409 retry), applied to the freshly pulled blob so
// nothing another device wrote is lost. Numbers/CVV are masked until the user taps
// Reveal; values are only ever sent encrypted, never reach any model, and are never logged.
type Row = { id: string } & Card;

export default function CardsPage() {
  const { config } = useApp();
  const [blob, setBlob] = useState<VaultBlob | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'nokey' | 'error'>('loading');
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<{ editing: Row | null } | null>(null); // open add/edit form
  const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState(0); // bumped per write, so a toggle whose write failed snaps back
  const [present] = useIonToast();
  const [presentAlert] = useIonAlert();

  const load = useCallback(async () => {
    const { baseUrl, apiKey, credential, vaultKey } = config;
    if (!baseUrl || !apiKey || !vaultKey) { setStatus('nokey'); setBlob(null); return; }
    setStatus('loading');
    try {
      const { data } = await pullVault({ baseUrl, apiKey: credential }, vaultKey);
      setBlob(data);
      setStatus('ok');
    } catch {
      setStatus('error'); // wrong key (re-pair) or offline
    }
  }, [config]);

  useEffect(() => { void load(); }, [load]);

  // One change → the vault. Returns true once it is stored (the form closes only then).
  const write = async (op: CardOp, done: string): Promise<boolean> => {
    const { baseUrl, credential, vaultKey } = config;
    if (!baseUrl || !credential || !vaultKey) return false;
    setBusy(true);
    try {
      const next = await syncVault({ baseUrl, apiKey: credential }, vaultKey, (remote) => applyCardOp(remote, op));
      setBlob(next);
      setStatus('ok');
      void present({ message: done, duration: 1500, position: 'top' });
      return true;
    } catch (e) {
      const message = e instanceof VaultKeyMismatch
        ? 'Not saved — the vault password changed. Re-pair this device (Settings → Scan).'
        : 'Not saved — couldn’t reach the vault. Check the connection and try again.';
      void present({ message, duration: 3500, position: 'top', color: 'danger' });
      return false;
    } finally {
      setBusy(false);
      setRev((n) => n + 1);
    }
  };

  const cards = liveCards(blob);
  const def = defaultCardId(blob);

  const onSave = async (r: CardFormResult) => {
    const ok = await write({ kind: 'upsert', id: r.id, card: r.card, makeDefault: r.makeDefault }, form?.editing ? 'Card saved ✓' : 'Card added ✓');
    if (ok) setForm(null);
  };
  const onDelete = (c: Row) => {
    void presentAlert({
      header: `Delete “${c.id}”?`,
      message: c.id === def
        ? 'This is your default card — the next card becomes the default. Removed from every paired Keeper.'
        : 'Removed from every paired Keeper.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => { void write({ kind: 'delete', id: c.id }, 'Card deleted'); } },
      ],
    });
  };

  const mask = (n?: string) => { const d = digitsOnly(n); return d ? '•••• •••• •••• ' + d.slice(-4) : '—'; };
  const exp = (c: Card) => (c.exp_month || c.exp_year)
    ? `${String(c.exp_month || '').padStart(2, '0')}/${String(c.exp_year || '').slice(-2)}` : '';
  const canWrite = status === 'ok';

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Cards</IonTitle>
          <IonButtons slot="end">
            <IonButton disabled={!canWrite || busy} onClick={() => setForm({ editing: null })}>+ Add</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <IonRefresher slot="fixed" onIonRefresh={async (e: CustomEvent<RefresherEventDetail>) => { await load(); e.detail.complete(); }}>
          <IonRefresherContent />
        </IonRefresher>

        <p className="rb-note">
          Saved cards from your synced vault, shared with your other Keepers. The <b>default</b> card
          is the one auto-fill tries first. End-to-end encrypted; card numbers show only when you tap <b>Reveal</b>.
        </p>

        {status === 'loading' && <p className="rb-note" style={{ textAlign: 'center', padding: 24 }}>Loading…</p>}
        {status === 'nokey' && <p className="rb-note" style={{ textAlign: 'center', padding: 24 }}>Pair this device (Settings → Scan) to load the vault.</p>}
        {status === 'error' && <p className="rb-note" style={{ textAlign: 'center', padding: 24 }}>Couldn’t load the vault — re-pair if the password changed, or pull to retry.</p>}
        {status === 'ok' && cards.length === 0 && <p className="rb-note" style={{ textAlign: 'center', padding: 24 }}>No saved cards yet. Tap <b>+ Add</b> to add one.</p>}

        {cards.map((c) => (
          <IonCard key={c.id} className={c.id === def ? 'rb-card-default' : undefined}>
            <IonCardContent>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <IonChip color="tertiary">{c.id}</IonChip>
                {c.id === def && <IonChip color="success">★ Default</IonChip>}
                {c.holder && <span className="rb-chip">{c.holder}</span>}
                <IonButton size="small" fill="outline" style={{ marginLeft: 'auto' }} onClick={() => setShown((s) => ({ ...s, [c.id]: !s[c.id] }))}>
                  {shown[c.id] ? 'Hide' : 'Reveal'}
                </IonButton>
              </div>
              <div style={{ marginTop: 8, fontSize: 15 }}>
                <code style={{ userSelect: 'all', letterSpacing: 0.5 }}>{shown[c.id] ? (digitsOnly(c.number) || '—') : mask(c.number)}</code>
                {exp(c) && <span style={{ marginLeft: 12, color: 'var(--rb-muted2)' }}>exp {exp(c)}</span>}
                {shown[c.id] && c.cvv && <span style={{ marginLeft: 12 }}>cvv <code style={{ userSelect: 'all' }}>{c.cvv}</code></span>}
              </div>
              {Array.isArray(c.domains) && c.domains.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--rb-muted2)' }}>
                  auto-fill: {c.domains.map((d) => (d === '*' ? 'all sites' : d)).join(', ')}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <IonToggle
                  key={`${def}|${rev}`}
                  checked={c.id === def}
                  disabled={busy}
                  labelPlacement="end"
                  onIonChange={(e) => {
                    if (e.detail.checked === (c.id === def)) return;
                    void write({ kind: 'setDefault', id: c.id, on: e.detail.checked },
                      e.detail.checked ? `“${c.id}” is now your default card` : 'No default card');
                  }}
                >
                  Default
                </IonToggle>
                <IonButton size="small" fill="clear" style={{ marginLeft: 'auto' }} disabled={busy}
                  onClick={() => setForm({ editing: c })}>Edit</IonButton>
                <IonButton size="small" fill="clear" color="danger" disabled={busy} onClick={() => onDelete(c)}>Delete</IonButton>
              </div>
            </IonCardContent>
          </IonCard>
        ))}
      </IonContent>

      {form && (
        <CardFormModal
          key={form.editing ? form.editing.id : '+new'}
          editing={form.editing}
          isDefault={!!form.editing && form.editing.id === def}
          suggestedId={uniqueCardId(blob)}
          takenIds={cards.map((c) => c.id)}
          defaultOnAdd={!form.editing && !def}
          busy={busy}
          onSave={(r) => { void onSave(r); }}
          onClose={() => setForm(null)}
        />
      )}
    </IonPage>
  );
}
