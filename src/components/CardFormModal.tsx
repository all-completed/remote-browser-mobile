import { useState } from 'react';
import { IonButton, IonCheckbox, IonInput, IonSelect, IonSelectOption } from '@ionic/react';
import {
  BILLING_KEYS, cardFromForm, cvvLength, digitsOnly, groupCardNumber, last4, validateCardForm,
  type Billing, type Card, type CardForm, type CardFormErrors,
} from '../lib/cards';

// Add / edit one saved card — the desktop CardsApp.jsx form on a phone. Full-screen plain
// overlay (like PromptModal; not an IonModal, so it always renders). A saved card's number
// and CVV are never put back into an input: blank means "keep the saved one", typing
// replaces it. Values stay in this component until onSave hands the card to the caller,
// which encrypts it into the vault; nothing here is logged.
export interface CardFormResult { id: string; card: Card; makeDefault: boolean }

interface Props {
  editing: ({ id: string } & Card) | null; // null = adding a new card
  isDefault: boolean;                      // the edited card is the current default
  suggestedId: string;                     // id used when the name is left blank (add only)
  takenIds: string[];                      // live card ids a new card may not reuse
  defaultOnAdd: boolean;                   // no default yet → the new card becomes it anyway
  busy: boolean;
  onSave: (r: CardFormResult) => void;
  onClose: () => void;
}

const monthOpts = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
function yearOpts(selected?: string): string[] {
  const now = new Date().getFullYear();
  const ys = Array.from({ length: 13 }, (_, i) => String(now + i));
  if (selected && !ys.includes(String(selected))) ys.unshift(String(selected));
  return ys;
}

export default function CardFormModal({ editing, isDefault, suggestedId, takenIds, defaultOnAdd, busy, onSave, onClose }: Props) {
  const [name, setName] = useState('');
  const [form, setForm] = useState<CardForm>(() => ({
    holder: editing?.holder || '',
    number: '',
    cvv: '',
    exp_month: editing?.exp_month ? String(editing.exp_month).padStart(2, '0').slice(-2) : '',
    exp_year: editing?.exp_year ? String(editing.exp_year) : '',
    billing: { ...(editing?.billing || {}) },
  }));
  const [makeDefault, setMakeDefault] = useState(defaultOnAdd);
  const [showCvv, setShowCvv] = useState(false);
  const [tried, setTried] = useState(false); // show errors only after the first Save

  const id = editing ? editing.id : (name.trim() || suggestedId);
  const errs: CardFormErrors = validateCardForm(form, editing);
  if (!editing && takenIds.includes(id)) errs.id = 'A card with this name already exists';
  const ok = Object.keys(errs).length === 0;

  const set = (patch: Partial<CardForm>) => setForm((f) => ({ ...f, ...patch }));
  const setBilling = (k: keyof Billing, v: string) => setForm((f) => ({ ...f, billing: { ...f.billing, [k]: v } }));
  const save = () => {
    setTried(true);
    if (!ok || busy) return;
    onSave({ id, card: cardFromForm(form, editing), makeDefault: makeDefault && !isDefault });
  };
  const err = (k: keyof CardFormErrors) => tried && errs[k] && <div className="rb-hint rb-err">{errs[k]}</div>;
  const savedL4 = editing ? last4(editing.number) : '';
  const cvvLen = cvvLength(digitsOnly(form.number) || editing?.number);

  return (
    <div className="rb-prompt">
      <div className="rb-prompt-head"><span>{editing ? `Edit card “${editing.id}”` : 'Add a card'}</span></div>

      <div className="rb-prompt-body">
        {!editing && (
          <div className="rb-ffield">
            <label className="rb-flabel">Name</label>
            <IonInput className="rb-input" fill="outline" value={name} placeholder={suggestedId}
              autocomplete="off" spellcheck={false} onIonInput={(e) => setName(e.detail.value || '')} />
            {err('id')}
          </div>
        )}

        <div className="rb-ffield">
          <label className="rb-flabel">Cardholder</label>
          <IonInput className="rb-input" fill="outline" value={form.holder} placeholder="JOHN Q DOE"
            autocapitalize="characters" autocomplete="off" spellcheck={false}
            onIonInput={(e) => set({ holder: e.detail.value || '' })} />
        </div>

        <div className="rb-ffield">
          <label className="rb-flabel">Card number</label>
          <IonInput className="rb-input" fill="outline" inputmode="numeric" maxlength={23}
            value={groupCardNumber(form.number)} placeholder={savedL4 ? `•••• ${savedL4}` : '#### #### #### ####'}
            autocomplete="off" spellcheck={false}
            onIonInput={(e) => set({ number: digitsOnly(e.detail.value) })} />
          {savedL4 && !form.number && <div className="rb-hint">Saved card ending {savedL4} — leave blank to keep it, or type to replace</div>}
          {err('number')}
        </div>

        <div className="rb-fgrid">
          <div className="rb-ffield">
            <label className="rb-flabel">Exp month</label>
            <IonSelect className="rb-input" fill="outline" interface="action-sheet" placeholder="MM"
              value={form.exp_month} onIonChange={(e) => set({ exp_month: e.detail.value || '' })}>
              {monthOpts.map((m) => <IonSelectOption key={m} value={m}>{m}</IonSelectOption>)}
            </IonSelect>
          </div>
          <div className="rb-ffield">
            <label className="rb-flabel">Exp year</label>
            <IonSelect className="rb-input" fill="outline" interface="action-sheet" placeholder="YYYY"
              value={form.exp_year} onIonChange={(e) => set({ exp_year: e.detail.value || '' })}>
              {yearOpts(editing?.exp_year).map((y) => <IonSelectOption key={y} value={y}>{y}</IonSelectOption>)}
            </IonSelect>
          </div>
        </div>
        {err('exp')}

        <div className="rb-ffield">
          <label className="rb-flabel">CVV (optional)</label>
          <div className="rb-inputrow">
            <IonInput className="rb-input" fill="outline" type={showCvv ? 'text' : 'password'} inputmode="numeric"
              maxlength={4} value={form.cvv} placeholder={'•'.repeat(cvvLen)} autocomplete="off" spellcheck={false}
              onIonInput={(e) => set({ cvv: digitsOnly(e.detail.value) })} />
            <IonButton fill="outline" onClick={() => setShowCvv((v) => !v)} aria-label="Show or hide">👁</IonButton>
          </div>
          <div className="rb-hint">
            {editing?.cvv && !form.cvv ? 'Saved — hidden; leave blank to keep it, or type to replace' : 'Leave it out to be asked for it at each payment'}
          </div>
          {err('cvv')}
        </div>

        <label className="rb-flabel" style={{ marginTop: 18 }}>Billing address</label>
        {BILLING_KEYS.slice(0, 2).map(([k, label]) => (
          <div className="rb-ffield" key={k}>
            <IonInput className="rb-input" fill="outline" placeholder={label} aria-label={label} value={form.billing[k] || ''}
              autocomplete="off" onIonInput={(e) => setBilling(k, e.detail.value || '')} />
          </div>
        ))}
        {[BILLING_KEYS.slice(2, 4), BILLING_KEYS.slice(4, 6)].map((pair) => (
          <div className="rb-fgrid" key={pair[0][0]}>
            {pair.map(([k, label]) => (
              <div className="rb-ffield" key={k}>
                <IonInput className="rb-input" fill="outline" placeholder={k === 'country' ? 'Country (US)' : label} aria-label={label}
                  value={form.billing[k] || ''} autocomplete="off" onIonInput={(e) => setBilling(k, e.detail.value || '')} />
              </div>
            ))}
          </div>
        ))}

        {isDefault ? (
          <p className="rb-note" style={{ marginTop: 16 }}>★ This is your default card.</p>
        ) : (
          <label className="rb-check">
            <IonCheckbox checked={makeDefault} disabled={!editing && defaultOnAdd}
              onIonChange={(e) => setMakeDefault(e.detail.checked)} />
            <span>Make this my default card{!editing && defaultOnAdd ? ' — you have none yet, so it will be' : ''}</span>
          </label>
        )}

        <p className="rb-note" style={{ marginTop: 16 }}>
          Encrypted on this phone before it syncs to your other Keepers. Never shown to the AI model.
        </p>
      </div>

      <div className="rb-prompt-foot">
        <IonButton fill="clear" onClick={onClose} disabled={busy}>Cancel</IonButton>
        <IonButton onClick={save} disabled={busy || (tried && !ok)}>{busy ? 'Saving…' : 'Save'}</IonButton>
      </div>
    </div>
  );
}
