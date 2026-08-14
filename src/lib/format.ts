export function shortUrl(u?: string): string {
  if (!u) return '';
  try {
    const x = new URL(u);
    const s = x.host + (x.pathname === '/' ? '' : x.pathname);
    return s.length > 48 ? s.slice(0, 47) + '…' : s;
  } catch {
    return u.length > 48 ? u.slice(0, 47) + '…' : u;
  }
}

export function fmtTime(ts?: number | string): string {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

// Masked fields (treated as secrets): password, code, card-number, card-cvv.
// Plain: text, login, email, card-holder-name, card-exp, card-billing-address.
export function isSecretField(field?: string): boolean {
  const f = (field || '').toLowerCase();
  return !(
    f === 'text' || f === 'login' || f === 'email' ||
    f === 'card-holder-name' || f === 'card-exp' || f === 'card-billing-address'
  );
}

// Generate a strong value in the Keeper (never produced by the agent). Mirrors the
// desktop genpassword.js policy so both keepers produce the same kind of password:
//   - non-numeric: length >= 14 (agent may raise, never lower), capped at 128, with at
//     least one a-z, A-Z and 0-9 guaranteed; symbols included unless `symbols: false`;
//   - numeric (format numeric/digits/number): digits only at the requested length (the
//     14 minimum does not apply — for PINs/codes).
export const MIN_PASSWORD_LEN = 14;
const _LOWER = 'abcdefghijklmnopqrstuvwxyz';
const _UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const _DIGITS = '0123456789';
const _SYMBOLS = '!@#$%^&*-_=+';
// Unbiased index in [0, n) from crypto bytes (rejection sampling).
function _randInt(n: number): number {
  const a = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / n) * n;
  const c = globalThis.crypto || (window as any).crypto;
  do { c.getRandomValues(a); } while (a[0] >= limit);
  return a[0] % n;
}
const _pick = (s: string) => s[_randInt(s.length)];
// One value per KIND across a request, so "Password" + "Confirm password" match.
// Mirrors the desktop keeper's generateSharedValues: if each field generated its
// own value the confirmation could never match and the form would reject the
// submit. Returns { [selector]: value } for the request's `generate` fields only.
export function generateSharedPasswords(
  fields: { selector: string; generate?: boolean; length?: number; format?: string; symbols?: boolean }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const perKind: Record<string, string> = {};
  for (const f of fields || []) {
    if (!f || !f.generate) continue;
    const kind = isNumericFormat(f.format) ? 'numeric' : 'text';
    if (!(kind in perKind)) perKind[kind] = generatePassword(f);
    out[f.selector] = perKind[kind];
  }
  return out;
}

export function generatePassword(field?: { length?: number; format?: string; symbols?: boolean }): string {
  const f = field || {};
  if (isNumericFormat(f.format)) {
    const len = Math.max(1, Math.min(Number.isInteger(f.length) && (f.length as number) > 0 ? (f.length as number) : 6, 64));
    let out = '';
    for (let i = 0; i < len; i++) out += _pick(_DIGITS);
    return out;
  }
  const pools = [_LOWER, _UPPER, _DIGITS, ...(f.symbols !== false ? [_SYMBOLS] : [])];
  const all = pools.join('');
  const len = Math.max(MIN_PASSWORD_LEN, Math.min(Number.isInteger(f.length) && (f.length as number) > 0 ? (f.length as number) : 20, 128));
  const chars = pools.map(_pick); // one guaranteed from each mandatory pool
  while (chars.length < len) chars.push(_pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = _randInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

export function isNumericFormat(format?: string): boolean {
  const f = (format || '').toLowerCase();
  return f === 'numeric' || f === 'digits' || f === 'number';
}

// ---- Card formatting templates ----
// A template is a string of slot chars (letters or '#') with literal separators
// (spaces, '/'). Digits fill the slots; separators auto-appear as you type.
const CARD_NUMBER_DEFAULT = '################'; // 16 digits, no grouping
const CARD_EXP_DEFAULT = 'MM/YY';

function templateSlots(t: string): number {
  return (t.match(/[A-Za-z#]/g) || []).length;
}

export function fillTemplate(template: string, raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, templateSlots(template));
  let out = '';
  let di = 0;
  for (const ch of template) {
    if (/[A-Za-z#]/.test(ch)) {
      if (di < digits.length) out += digits[di++];
      else break;
    } else if (di < digits.length) {
      out += ch; // separator, only while more digits remain to place
    } else break;
  }
  return out;
}

// Card-number mask: an agent-supplied '#'-mask (e.g. "#### #### #### ####") or the default.
function cardNumberMask(format?: string): string {
  return format && format.includes('#') ? format : CARD_NUMBER_DEFAULT;
}
// Card-exp template: "MM/YY" (default), "MM/YYYY", "YY", "MM", etc.
function cardExpTemplate(format?: string): string {
  return format && /[MY]/i.test(format) ? format : CARD_EXP_DEFAULT;
}

// Billing-address sub-component tokens → human label.
const BILLING_TOKENS: Record<string, string> = {
  ADDRESS_LINE1: 'address line 1',
  ADDRESS_LINE2: 'address line 2',
  CITY: 'city',
  ZIP: 'ZIP',
  STATE: 'state',
  COUNTRY: 'country',
};
function humanizeBilling(format?: string): string {
  if (!format) return '';
  return format
    .split(',')
    .map((t) => BILLING_TOKENS[t.trim().toUpperCase()] || t.trim())
    .filter(Boolean)
    .join(', ');
}

// Multi-line only for a whole billing address (no specific component format).
export function isMultilineField(field?: string, format?: string): boolean {
  return (field || '').toLowerCase() === 'card-billing-address' && !(format && format.trim());
}

export function fieldInputMode(field?: string, format?: string): 'numeric' | 'email' | 'text' {
  const f = (field || '').toLowerCase();
  if (f === 'card-number' || f === 'card-cvv' || f === 'card-exp') return 'numeric';
  if (isNumericFormat(format)) return 'numeric';
  if (f === 'email' || (format || '').toLowerCase() === 'email') return 'email';
  return 'text';
}

// Default max length when the agent didn't specify one (card fields have known sizes).
export function fieldMaxLen(field?: string, length?: number, format?: string): number | undefined {
  if (Number.isInteger(length) && (length as number) > 0) return length as number;
  switch ((field || '').toLowerCase()) {
    case 'card-number': return cardNumberMask(format).length;
    case 'card-exp': return cardExpTemplate(format).length;
    case 'card-cvv': return 4;
    default: return undefined;
  }
}

// Transform raw keystrokes into the display value (digit grouping, MM/YY, etc.).
export function formatFieldInput(field: string | undefined, format: string | undefined, raw: string): string {
  switch ((field || '').toLowerCase()) {
    case 'card-number': return fillTemplate(cardNumberMask(format), raw);
    case 'card-exp': return fillTemplate(cardExpTemplate(format), raw);
    case 'card-cvv': return raw.replace(/\D/g, '').slice(0, 4);
    default:
      return isNumericFormat(format) ? raw.replace(/[^0-9]/g, '') : raw;
  }
}

// The value actually sent to the page (strip display-only formatting).
export function submitValue(field: string | undefined, display: string): string {
  // Card number is grouped for readability; submit digits only.
  if ((field || '').toLowerCase() === 'card-number') return display.replace(/\D/g, '');
  return display;
}

// Short hint shown under the input.
export function fieldHint(field?: string, format?: string): string {
  switch ((field || '').toLowerCase()) {
    case 'card-number': return 'card number · digits only';
    case 'card-cvv': return 'CVV';
    case 'card-exp': return cardExpTemplate(format);
    case 'card-holder-name': return 'name on card';
    case 'card-billing-address': return humanizeBilling(format) || 'billing address';
  }
  if (!format) return '';
  const f = format.toLowerCase();
  if (f === 'email') return 'email';
  if (isNumericFormat(f)) return 'digits only';
  return `format: ${format}`;
}

// Back-compat alias (format-only hint).
export function formatHint(format?: string): string {
  return fieldHint(undefined, format);
}

// ---- Decline reason ----------------------------------------------------------
// The optional short note a user may attach when dismissing a prompt, so the agent
// learns WHY instead of seeing a bare `cancelled` ("wrong account" and "I already
// did it myself" call for opposite next moves). It is ordinary user-typed text —
// never a field value, never a vault value — and it is the only free text this app
// ever sends onward, so it is normalised hard: control characters and newlines
// collapse to spaces and the length is capped. A hint for the agent, not a channel.
export const MAX_DECLINE_REASON = 200;

/**
 * Collapse whitespace/control characters, trim, and cap at MAX_DECLINE_REASON.
 * Whitespace-only input normalises to '' — i.e. exactly "no reason", so a stray
 * space can never turn a plain dismiss into a decline carrying an empty note.
 */
export function normalizeDeclineReason(raw?: string | null): string {
  const s = String(raw ?? '').replace(/[\s\p{Cc}]+/gu, ' ').trim();
  return s.length > MAX_DECLINE_REASON ? s.slice(0, MAX_DECLINE_REASON).trim() : s;
}

// ---- Relative timestamps -----------------------------------------------------
// "2w ago" answers "is this recent?" at a glance where a full timestamp has to be
// decoded. On mobile there is no hover, so callers pair this with absTime() behind
// a TAP rather than a title attribute.
const _SECONDS_CUTOFF = 1e11;
export function toDate(ts?: string | number | Date | null): Date | null {
  if (ts == null || ts === '') return null;
  if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
  if (typeof ts === 'number') return new Date(ts < _SECONDS_CUTOFF ? ts * 1000 : ts);
  const n = Number(ts);
  if (!Number.isNaN(n) && String(ts).trim() !== '') return new Date(n < _SECONDS_CUTOFF ? n * 1000 : n);
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}
const _UNITS: [string, number][] = [['y', 365 * 24 * 3600], ['mo', 30 * 24 * 3600], ['w', 7 * 24 * 3600],
  ['d', 24 * 3600], ['h', 3600], ['m', 60]];
export function relTime(ts?: string | number | Date | null, now: number = Date.now()): string {
  const d = toDate(ts);
  if (!d) return '';
  const diff = (now - d.getTime()) / 1000;
  const future = diff < 0, abs = Math.abs(diff);
  if (abs < 45) return future ? 'in a moment' : 'just now';
  for (const [suffix, secs] of _UNITS) {
    if (abs >= secs) { const n = Math.floor(abs / secs); return future ? `in ${n}${suffix}` : `${n}${suffix} ago`; }
  }
  return future ? 'in a moment' : 'just now';
}
export function absTime(ts?: string | number | Date | null): string {
  const d = toDate(ts);
  return d ? d.toLocaleString() : '';
}
