import { useEffect, useState } from 'react';
import { IonButton, IonCheckbox, IonInput, IonSelect, IonSelectOption, IonTextarea } from '@ionic/react';
import type { FillField, FillRequest } from '../lib/keeperClient';
import {
  fieldHint,
  fieldInputMode,
  fieldMaxLen,
  formatFieldInput,
  isMultilineField,
  isSecretField,
  shortUrl,
  submitValue,
} from '../lib/format';
import { getSaved, hostFromUrl, saveValue, forget, type Scope } from '../lib/fieldStore';
import ImageModal from './ImageModal';

interface Props {
  request: FillRequest;
  baseUrl: string;
  onSubmit: (values: { selector: string; value: string }[]) => void;
  onCancel: () => void;
}

const isCard = (field?: string) => String(field || '').toLowerCase().startsWith('card-');

// Full-screen prompt (plain overlay; not an IonModal, so it always renders).
export default function PromptModal({ request, baseUrl, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<number, boolean>>({});
  const [zoom, setZoom] = useState<string | null>(null);
  const [saveScope, setSaveScope] = useState<'' | Scope | 'forget'>('');
  const [savedExisting, setSavedExisting] = useState(false); // a stored value was prefilled
  const [dontAsk, setDontAsk] = useState(false); // fill automatically next time

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
    let cancelled = false;
    (async () => {
      const prefill: Record<string, string> = {};
      let firstScope: Scope | '' = '';
      let firstAuto = false;
      let any = false;
      for (const f of fields) {
        if (isCard(f.field)) continue;
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
      if (cancelled || !any) return;
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
      <div className="rb-prompt-head">A remote session needs a value</div>

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
          const secret = isSecretField(f.field);
          const masked = secret && !reveal[i];
          const multiline = isMultilineField(f.field, f.format);
          const ml = fieldMaxLen(f.field, f.length, f.format);
          const hint = [fieldHint(f.field, f.format), ml ? `max ${ml}` : ''].filter(Boolean).join(' · ');
          const capitalize = (f.field || '').toLowerCase() === 'card-holder-name' ? 'words' : 'off';
          return (
            <div key={f.selector + i} style={{ marginTop: 14 }}>
              <label className="rb-flabel">{f.label || 'Enter value'}</label>
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
                {secret && !multiline && (
                  <IonButton fill="outline" onClick={() => setReveal((r) => ({ ...r, [i]: !r[i] }))} aria-label="Show or hide">
                    👁
                  </IonButton>
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
                setDontAsk(v === 'session' || v === 'forever');
              }}
            >
              {!savedExisting && <IonSelectOption value="">Don't save</IonSelectOption>}
              <IonSelectOption value="session">Until the app restarts</IonSelectOption>
              <IonSelectOption value="forever">Keep on this device</IonSelectOption>
              {savedExisting && <IonSelectOption value="forget">Forget saved value</IonSelectOption>}
            </IonSelect>
            {(saveScope === 'session' || saveScope === 'forever') && (
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

      <div className="rb-prompt-foot">
        <IonButton fill="clear" onClick={onCancel}>
          Cancel
        </IonButton>
        <IonButton onClick={send}>Send</IonButton>
      </div>

      <ImageModal src={zoom} onClose={() => setZoom(null)} />
    </div>
  );
}
