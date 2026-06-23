import { useEffect, useState } from 'react';
import { IonButton, IonInput, IonTextarea } from '@ionic/react';
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
import ImageModal from './ImageModal';

interface Props {
  request: FillRequest;
  onSubmit: (values: { selector: string; value: string }[]) => void;
  onCancel: () => void;
}

// Full-screen prompt (plain overlay; not an IonModal, so it always renders).
export default function PromptModal({ request, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<number, boolean>>({});
  const [zoom, setZoom] = useState<string | null>(null);

  useEffect(() => {
    setValues({});
    setReveal({});
    setZoom(null);
  }, [request.request_id]);

  const fields = request.fields || [];

  const setVal = (field: FillField, raw: string) => {
    let v = formatFieldInput(field.field, field.format, raw);
    const ml = fieldMaxLen(field.field, field.length, field.format);
    if (ml && v.length > ml) v = v.slice(0, ml);
    setValues((m) => ({ ...m, [field.selector]: v }));
  };

  const send = () =>
    onSubmit(fields.map((f) => ({ selector: f.selector, value: submitValue(f.field, values[f.selector] || '') })));

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

        <p className="rb-note" style={{ marginTop: 16 }}>
          Sent to the service and typed into the form for you. Never shown to the AI model.
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
