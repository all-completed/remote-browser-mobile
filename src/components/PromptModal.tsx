import { useEffect, useState } from 'react';
import { IonButton, IonCheckbox, IonInput, IonSelect, IonSelectOption, IonTextarea } from '@ionic/react';
import type { FillField, FillRequest } from '../lib/keeperClient';
import {
  MAX_DECLINE_REASON,
  fieldHint,
  fieldInputMode,
  fieldMaxLen,
  formatFieldInput,
  generateSharedPasswords,
  isMultilineField,
  isSecretField,
  normalizeDeclineReason,
  shortUrl,
  submitValue,
} from '../lib/format';
import { getSaved, hostFromUrl, saveValue, forget, type Scope } from '../lib/fieldStore';
import { loadVaultKey } from '../lib/config';
import { formatRemaining, remainingMs } from '../lib/deadline';
import ImageModal from './ImageModal';

interface Props {
  request: FillRequest;
  baseUrl: string;
  onSubmit: (values: { selector: string; value: string }[]) => void;
  onCancel: (reason?: string) => void;
}

const isCard = (field?: string) => String(field || '').toLowerCase().startsWith('card-');
const URGENT_MS = 60_000; // last minute — the chip turns red

// Time left before the service stops waiting, or null when this request has no
// trustworthy deadline (then nothing is shown — we never invent one). Re-derived from
// Date.now() on every tick rather than decremented, so the value is right again the
// instant the app comes back from background/sleep, however long the OS froze the timer.
function useRemaining(deadline: number | undefined): number | null {
  const [ms, setMs] = useState<number | null>(() => remainingMs(deadline ?? null));
  useEffect(() => {
    const refresh = () => setMs(remainingMs(deadline ?? null));
    refresh();
    if (deadline == null) return;
    const id = setInterval(refresh, 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [deadline]);
  return ms;
}

// One-tap answers to "why not?", covering the declines that call for different agent
// behaviour (issue #7): retry with another identity, retry later, stop entirely, fix
// the target, or give up on this credential. Free text stays available for the rest.
const DECLINE_PRESETS = [
  'Wrong account — use the other one',
  'Not now — ask again later',
  "I'll do this myself — don't retry",
  'Wrong field or wrong site',
  "I don't have that credential",
];

// Full-screen prompt (plain overlay; not an IonModal, so it always renders).
export default function PromptModal({ request, baseUrl, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<number, boolean>>({});
  const [zoom, setZoom] = useState<string | null>(null);
  const [saveScope, setSaveScope] = useState<'' | Scope | 'forget'>('');
  const [savedExisting, setSavedExisting] = useState(false); // a stored value was prefilled
  const [dontAsk, setDontAsk] = useState(false); // fill automatically next time
  const [declining, setDeclining] = useState(false); // the "why?" panel is open
  const [reason, setReason] = useState(''); // free-text decline note (never a field value)
  const remaining = useRemaining(request._deadline_ms);

  const fields = request.fields || [];
  const host = hostFromUrl(request.url);
  const session = request.session_id || '';
  // Card values live with the card, not the field store — only offer to save others.
  const hasNonCard = fields.some((f) => !isCard(f.field));

  // Reset per request, then prefill any values the user previously saved.
  useEffect(() => {
    setValues({});
    setReveal({});
    setZoom(null);
    setSaveScope('');
    setSavedExisting(false);
    setDontAsk(false);
    setDeclining(false);
    setReason('');
    // Generate fresh strong values for generate-fields; default to saving them.
    // Shared per kind, so a "Confirm password" field gets the SAME value as the
    // password it confirms (otherwise the form rejects every submission).
    const genInit = generateSharedPasswords(fields.filter((f) => !isCard(f.field)));
    const hasGen = Object.keys(genInit).length > 0;
    if (hasGen) {
      setValues((m) => ({ ...m, ...genInit }));
      setDontAsk(true);
      // A generated password is never shown, so back it up / sync it: default to the vault
      // when a vault key is held, otherwise on-device ("forever").
      setSaveScope('forever');
      loadVaultKey().then((k) => { if (k) setSaveScope('vault'); }).catch(() => {});
    }
    let cancelled = false;
    (async () => {
      const prefill: Record<string, string> = {};
      let firstScope: Scope | '' = '';
      let firstAuto = false;
      let any = false;
      for (const f of fields) {
        if (isCard(f.field) || f.generate) continue; // keep generated values
        const s = await getSaved(baseUrl, session, host, f.selector);
        if (s && s.value != null) {
          prefill[f.selector] = formatFieldInput(f.field, f.format, s.value);
          if (!any) {
            firstScope = s.scope;
            firstAuto = s.auto;
          }
          any = true;
        }
      }
      if (cancelled) return;
      if (!any) {
        // No previously-saved value: default a (non-generate) field to the synced vault
        // when a vault key is held. The user can still change it in the prompt.
        if (!hasGen) { const k = await loadVaultKey(); if (!cancelled && k) { setSaveScope('vault'); setDontAsk(true); } }
        return;
      }
      setValues((m) => ({ ...m, ...prefill }));
      setSavedExisting(true);
      setSaveScope(firstScope);
      setDontAsk(firstAuto);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.request_id]);

  const setVal = (field: FillField, raw: string) => {
    let v = formatFieldInput(field.field, field.format, raw);
    const ml = fieldMaxLen(field.field, field.length, field.format);
    if (ml && v.length > ml) v = v.slice(0, ml);
    setValues((m) => ({ ...m, [field.selector]: v }));
  };

  const send = async () => {
    const out = fields.map((f) => ({ selector: f.selector, value: submitValue(f.field, values[f.selector] || '') }));
    // Persist (or forget) the non-card values on this device before responding.
    if (saveScope) {
      for (const f of fields) {
        if (isCard(f.field)) continue;
        if (saveScope === 'forget') await forget(baseUrl, session, host, f.selector);
        else {
          const v = submitValue(f.field, values[f.selector] || '');
          if (v) await saveValue(baseUrl, session, host, f.selector, v, saveScope, dontAsk);
        }
      }
    }
    onSubmit(out);
  };

  const validProof = !!request.screenshot && /^data:image\//.test(request.screenshot);

  return (
    <div className="rb-prompt">
      <div className="rb-prompt-head">
        <span>A remote session needs a value</span>
        {/* Only when the service told us when it stops waiting — never a guessed clock. */}
        {remaining !== null && (
          <span
            className={`rb-timer${remaining <= URGENT_MS ? ' urgent' : ''}`}
            title="Time left before the service stops waiting and the request times out"
          >
            ⏳ {formatRemaining(remaining)} left
          </span>
        )}
      </div>

      <div className="rb-prompt-body">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <span className="rb-chip">session: {request.session_id || '?'}</span>
          {request.url && (
            <span className="rb-chip url" title={request.url}>
              {shortUrl(request.url)}
            </span>
          )}
        </div>

        {request.message && <div className="rb-msg">{request.message}</div>}

        {validProof && (
          <figure className="rb-proof" style={{ margin: '0 0 14px' }} onClick={() => setZoom(request.screenshot!)}>
            <img src={request.screenshot} alt="Proof" />
            <figcaption>The fields the service will fill — proof · tap to enlarge</figcaption>
          </figure>
        )}

        {fields.map((f, i) => {
          const isGen = !!f.generate;
          const secret = isSecretField(f.field);
          const masked = secret && !reveal[i] && !isGen; // generated value is shown in clear to review
          const multiline = isMultilineField(f.field, f.format) && !isGen;
          const ml = fieldMaxLen(f.field, f.length, f.format);
          const hint = [
            isGen ? 'generated in the Keeper — review, then Send' : fieldHint(f.field, f.format),
            ml ? `max ${ml}` : '',
          ].filter(Boolean).join(' · ');
          const capitalize = (f.field || '').toLowerCase() === 'card-holder-name' ? 'words' : 'off';
          return (
            <div key={f.selector + i} style={{ marginTop: 14 }}>
              <label className="rb-flabel">{f.label || 'Enter value'}</label>
              {f.selector && (
                <div
                  title="The exact element the service will fill"
                  style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: 'var(--rb-muted)', wordBreak: 'break-all', margin: '1px 0 3px' }}
                >
                  {f.selector}
                </div>
              )}
              <div className="rb-inputrow">
                {multiline ? (
                  <IonTextarea
                    className="rb-input"
                    fill="outline"
                    autoGrow
                    rows={3}
                    value={values[f.selector] || ''}
                    autocapitalize="sentences"
                    spellcheck={false}
                    placeholder="Type here…"
                    onIonInput={(e) => setVal(f, e.detail.value || '')}
                  />
                ) : (
                  <IonInput
                    className="rb-input"
                    fill="outline"
                    type={masked ? 'password' : 'text'}
                    value={values[f.selector] || ''}
                    inputmode={fieldInputMode(f.field, f.format)}
                    autocapitalize={capitalize}
                    autocomplete="off"
                    spellcheck={false}
                    placeholder="Type here…"
                    onIonInput={(e) => setVal(f, e.detail.value || '')}
                  />
                )}
                {isGen ? (
                  <IonButton
                    fill="outline"
                    // Regenerate the whole group: a password and its confirmation
                    // must stay identical or the form rejects the submit.
                    onClick={() => setValues((m) => ({
                      ...m, ...generateSharedPasswords(fields.filter((x) => !isCard(x.field))),
                    }))}
                    aria-label="Generate a new one"
                  >
                    ↻
                  </IonButton>
                ) : (
                  secret && !multiline && (
                    <IonButton fill="outline" onClick={() => setReveal((r) => ({ ...r, [i]: !r[i] }))} aria-label="Show or hide">
                      👁
                    </IonButton>
                  )
                )}
              </div>
              {hint && <div className="rb-hint">{hint}</div>}
            </div>
          );
        })}

        {hasNonCard && (
          <div style={{ marginTop: 18 }}>
            <label className="rb-flabel">{savedExisting ? 'Saved value' : 'Save these values'}</label>
            <IonSelect
              className="rb-input"
              fill="outline"
              interface="action-sheet"
              value={saveScope}
              placeholder="Don't save"
              onIonChange={(e) => {
                const v = e.detail.value as '' | Scope | 'forget';
                setSaveScope(v);
                setDontAsk(v === 'session' || v === 'forever' || v === 'vault');
              }}
            >
              {!savedExisting && <IonSelectOption value="">Don't save</IonSelectOption>}
              <IonSelectOption value="session">Until the app restarts</IonSelectOption>
              <IonSelectOption value="forever">Keep on this device</IonSelectOption>
              <IonSelectOption value="vault">Save to vault (synced across devices)</IonSelectOption>
              {savedExisting && <IonSelectOption value="forget">Forget saved value</IonSelectOption>}
            </IonSelect>
            {(saveScope === 'session' || saveScope === 'forever' || saveScope === 'vault') && (
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 13.5, color: 'var(--rb-muted2)' }}
              >
                <IonCheckbox checked={dontAsk} onIonChange={(e) => setDontAsk(e.detail.checked)} />
                <span>Don't ask again — fill automatically next time</span>
              </label>
            )}
          </div>
        )}

        <p className="rb-note" style={{ marginTop: 16 }}>
          Sent to the service and typed into the form for you. Never shown to the AI model. Saved values stay on this device.
        </p>
      </div>

      {declining ? (
        // Declining WITH a reason: presets answer the common cases in one tap, free
        // text covers the rest. Whatever is sent is plain text the agent may read —
        // it is typed here and never sourced from a field value or the vault.
        <div className="rb-decline">
          <label className="rb-flabel">Why? — the agent sees this text (never a value)</label>
          <div className="rb-presets">
            {DECLINE_PRESETS.map((p) => (
              <button type="button" key={p} className="rb-preset" onClick={() => onCancel(p)}>
                {p}
              </button>
            ))}
          </div>
          <IonInput
            className="rb-input"
            fill="outline"
            value={reason}
            maxlength={MAX_DECLINE_REASON}
            autocapitalize="sentences"
            autocomplete="off"
            spellcheck={false}
            placeholder="…or type a short reason"
            onIonInput={(e) => setReason((e.detail.value || '').slice(0, MAX_DECLINE_REASON))}
          />
          <div className="rb-prompt-foot">
            <IonButton fill="clear" onClick={() => setDeclining(false)}>
              Back
            </IonButton>
            {/* An empty (or whitespace-only) note declines exactly like plain Cancel. */}
            <IonButton color="danger" onClick={() => onCancel(normalizeDeclineReason(reason))}>
              Decline
            </IonButton>
          </div>
        </div>
      ) : (
        <div className="rb-prompt-foot">
          <IonButton fill="clear" onClick={() => onCancel()}>
            Cancel
          </IonButton>
          <IonButton fill="clear" onClick={() => setDeclining(true)}>
            Cancel with reason…
          </IonButton>
          {/* Out of time: the service has stopped waiting, so sending would only lose the
              value. App.tsx drops the prompt within the second — this closes the gap.
              Only Send is disabled: declining still carries information the service may
              record, and costs nothing if it doesn't, whereas a Send at 0:00 spends a
              secret on a request nobody is listening for any more. */}
          <IonButton onClick={send} disabled={remaining === 0}>Send</IonButton>
        </div>
      )}

      <ImageModal src={zoom} onClose={() => setZoom(null)} />
    </div>
  );
}
