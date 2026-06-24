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

// Generate a strong value in the Keeper (never produced by the agent). Honors a
// numeric format and an optional length; defaults to 20 chars of an unambiguous set.
export function generatePassword(field?: { length?: number; format?: string }): string {
  const f = field || {};
  const numeric = isNumericFormat(f.format);
  const charset = numeric
    ? '0123456789'
    : 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*-_=+';
  const len = Number.isInteger(f.length) && (f.length as number) > 0 ? Math.min(f.length as number, 64) : 20;
  const arr = new Uint32Array(len);
  (globalThis.crypto || (window as any).crypto).getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += charset[arr[i] % charset.length];
  return out;
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
