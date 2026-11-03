// Saved payment cards in the synced vault — the mobile half of the desktop Keeper's card
// store (remote-browser-keeper src/cards.js + ui/apps/CardsApp.jsx), same data model:
//   blob.cards     = { <id>: { holder, number, cvv?, exp_month, exp_year, billing, domains?, updated_at }
//                      | { deleted: true, updated_at } }          // tombstone, so a delete syncs
//   blob.cardsMeta = { autofill?, default: <id> | "", updated_at }  // merged as one unit by updated_at
//
// Mobile keeps NO card store of its own (desktop neither — its store is in-memory, hydrated
// from the vault). Every edit is a pure function of the freshly pulled remote blob, applied
// inside syncVault's pull → merge → push loop (src/lib/vault.ts), so a 409 retry re-applies
// it on top of whatever another device just wrote: other cards, `fields`, unknown
// collections and card keys this form doesn't edit (e.g. desktop's `domains`) all survive.
//
// Imports nothing (no Capacitor), so test/cards.test.mjs runs the real source under Node.
// Never log anything from here: these are card values.

export interface Billing {
  address_line1?: string; address_line2?: string; city?: string; zip?: string; state?: string; country?: string;
}
export interface Card {
  holder?: string; number?: string; cvv?: string; exp_month?: string; exp_year?: string;
  billing?: Billing; domains?: string[]; updated_at?: string; deleted?: false;
}
export type CardTombstone = { deleted: true; updated_at: string };
export type CardEntry = Card | CardTombstone;
export interface CardsMeta { autofill?: boolean; default?: string; updated_at?: string; [k: string]: any }
export interface CardsBlob { cards?: Record<string, CardEntry>; cardsMeta?: CardsMeta; [k: string]: any }

export type CardOp =
  | { kind: 'upsert'; id: string; card: Card; makeDefault?: boolean }
  | { kind: 'delete'; id: string }
  | { kind: 'setDefault'; id: string; on: boolean };

export const BILLING_KEYS: Array<[keyof Billing, string]> = [
  ['address_line1', 'Address line 1'], ['address_line2', 'Address line 2'],
  ['city', 'City'], ['zip', 'ZIP / Postcode'], ['state', 'State / Region'], ['country', 'Country'],
];

export const isLive = (e: CardEntry | undefined | null): e is Card => !!e && typeof e === 'object' && !e.deleted;

// Live cards in vault key order — the same order desktop's Object.keys(store.cards) sees.
export function liveCards(blob: CardsBlob | null | undefined): Array<{ id: string } & Card> {
  const map = (blob && blob.cards) || {};
  return Object.keys(map).filter((id) => isLive(map[id])).map((id) => ({ id, ...(map[id] as Card) }));
}

// The default card id, or "" when none is set or it no longer names a live card.
export function defaultCardId(blob: CardsBlob | null | undefined): string {
  const id = blob && blob.cardsMeta && blob.cardsMeta.default;
  return typeof id === 'string' && id && isLive(((blob && blob.cards) || {})[id]) ? id : '';
}

// Desktop's uniqueId (card, card2, card3, …), also skipping tombstoned ids so a new card
// never reuses the key of a deleted one.
export function uniqueCardId(blob: CardsBlob | null | undefined): string {
  const map = (blob && blob.cards) || {};
  let n = 1;
  let id = 'card';
  while (map[id]) { n += 1; id = 'card' + n; }
  return id;
}

// Apply one edit to a pulled blob; returns a new blob (the input is not mutated). Each
// touched card gets its own `updated_at`; any default change rewrites `cardsMeta` with a
// fresh `updated_at`, keeping the keys we don't own (autofill, …). Default rules mirror
// CardsApp.jsx: one default; a card added while none exists becomes it; deleting the
// default moves it to the first remaining card, or to "" when none is left.
export function applyCardOp<B extends CardsBlob>(blob: B, op: CardOp, now: string = new Date().toISOString()): B {
  const cards: Record<string, CardEntry> = { ...((blob && blob.cards) || {}) };
  const meta: CardsMeta = { ...((blob && blob.cardsMeta) || {}) };
  const current = defaultCardId({ cards, cardsMeta: meta });
  let nextDefault = current;

  if (op.kind === 'upsert') {
    const prev = cards[op.id];
    cards[op.id] = { ...(isLive(prev) ? prev : {}), ...op.card, updated_at: now };
    if (op.makeDefault || !current) nextDefault = op.id;
  } else if (op.kind === 'delete') {
    cards[op.id] = { deleted: true, updated_at: now };
    if (current === op.id) nextDefault = liveCards({ cards })[0]?.id || '';
  } else if (op.kind === 'setDefault') {
    if (op.on && isLive(cards[op.id])) nextDefault = op.id;
    else if (!op.on && current === op.id) nextDefault = '';
  }

  const out: CardsBlob = { ...blob, cards };
  // Rewrite meta only when the default actually moves, so an edit that leaves it alone
  // can't beat a later desktop change to `autofill` on timestamp alone.
  out.cardsMeta = nextDefault !== current ? { ...meta, default: nextDefault, updated_at: now } : meta;
  return out as B;
}

// ---- form validation (CardsApp.jsx's fields; values never leave this module) ----
export const digitsOnly = (v: unknown) => String(v == null ? '' : v).replace(/\D/g, '');
export const last4 = (n: unknown) => digitsOnly(n).slice(-4);
export const groupCardNumber = (v: unknown) => digitsOnly(v).slice(0, 19).replace(/(.{4})/g, '$1 ').trim();

export function luhnValid(num: unknown): boolean {
  const d = digitsOnly(num);
  if (d.length < 12 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; }
    sum += x;
  }
  return sum % 10 === 0;
}

// American Express (34/37) has a 4-digit CVV; everyone else 3.
export const cvvLength = (num: unknown) => (/^3[47]/.test(digitsOnly(num)) ? 4 : 3);

export interface CardForm {
  holder: string; number: string; cvv: string; exp_month: string; exp_year: string; billing: Billing;
}
export type CardFormErrors = Partial<Record<'id' | 'number' | 'exp' | 'cvv', string>>;

// `existing` = the card being edited: a blank number/CVV there means "keep the saved one"
// (the form never shows a saved number or CVV again, like desktop).
export function validateCardForm(f: CardForm, existing?: Card | null, now: Date = new Date()): CardFormErrors {
  const errs: CardFormErrors = {};
  const num = digitsOnly(f.number) || (existing ? digitsOnly(existing.number) : '');
  if (!num) errs.number = 'Enter the card number';
  else if (digitsOnly(f.number) && !luhnValid(f.number)) errs.number = 'That card number isn’t valid';

  const m = Number(f.exp_month);
  const y = Number(f.exp_year);
  if (!f.exp_month || !f.exp_year || !(m >= 1 && m <= 12) || !(y >= 2000)) errs.exp = 'Pick the expiry month and year';
  else if (y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1)) errs.exp = 'This card has expired';

  const cvv = String(f.cvv || '');
  if (cvv) {
    const want = cvvLength(num);
    if (!/^\d+$/.test(cvv) || cvv.length !== want) errs.cvv = `CVV is ${want} digits`;
  }
  return errs;
}

// The card to store from a validated form. Blank number/CVV on an edit keep the saved
// values; blank billing lines are dropped. Keys the form doesn't own (domains, …) are
// kept by applyCardOp's merge onto the stored card.
export function cardFromForm(f: CardForm, existing?: Card | null): Card {
  const card: Card = {
    holder: String(f.holder || '').trim(),
    number: digitsOnly(f.number) || (existing ? digitsOnly(existing.number) : ''),
    exp_month: String(f.exp_month).padStart(2, '0').slice(-2),
    exp_year: String(f.exp_year),
  };
  const cvv = String(f.cvv || '') || (existing && existing.cvv) || '';
  if (cvv) card.cvv = cvv; // optional: desktop prompts for it at fill time when absent
  const billing: Billing = {};
  for (const [k] of BILLING_KEYS) {
    const v = String((f.billing && f.billing[k]) || '').trim();
    if (v) billing[k] = v;
  }
  card.billing = billing;
  return card;
}
