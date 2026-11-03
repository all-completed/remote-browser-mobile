// Card editing on the phone (src/lib/cards.ts), run against the REAL source — and through
// the REAL syncVault (src/lib/vault.ts) against a fake /api/vault — because the rules that
// matter are sync rules: a phone edit must land in the exact shape the desktop Keeper's
// src/cards.js merges (per-card updated_at, {deleted,updated_at} tombstones, cardsMeta
// {autofill, default, updated_at}), and must never drop what another device wrote, even
// when that device writes in between the phone's pull and push (409 → retry).
//
// cards.ts and vaultCrypto.ts import nothing; vault.ts imports CapacitorHttp only as its
// default transport, which every call here replaces with an injected fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodeCrypto from 'node:crypto';
import ts from 'typescript';

globalThis.crypto ??= nodeCrypto.webcrypto;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbcards-'));
for (const name of ['cards', 'vaultCrypto', 'vault']) {
  let js = ts.transpileModule(fs.readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  js = js.replace(/import \{ CapacitorHttp \} from '@capacitor\/core';/, 'const CapacitorHttp = null;')
    .replace(/from '\.\/vaultCrypto'/g, "from './vaultCrypto.mjs'");
  fs.writeFileSync(path.join(dir, `${name}.mjs`), js);
}
const cards = await import(path.join(dir, 'cards.mjs'));
const vc = await import(path.join(dir, 'vaultCrypto.mjs'));
const vault = await import(path.join(dir, 'vault.mjs'));
const { applyCardOp, defaultCardId, liveCards, uniqueCardId, luhnValid, validateCardForm, cardFromForm } = cards;

const T1 = '2026-11-01T10:00:00.000Z';
const T2 = '2026-11-02T10:00:00.000Z';
const T3 = '2026-11-03T10:00:00.000Z';
const VISA = { holder: 'JOHN DOE', number: '4111111111111111', cvv: '123', exp_month: '12', exp_year: '2030', billing: { city: 'SF' } };
const MC = { holder: 'JOHN DOE', number: '5555555555554444', exp_month: '01', exp_year: '2031', billing: {} };

// ---- desktop side: remote-browser-keeper src/cards.js mergeRemoteCards + pickCard +
// cardOptions, verbatim in logic, over a plain in-memory store ----
function desktopMerge(store, remoteCards, remoteMeta) {
  const at = (e) => (e && typeof e.updated_at === 'string' ? e.updated_at : '');
  const localMap = { ...(store.cards || {}) };
  for (const [id, ts] of Object.entries(store._tombstones || {})) if (!(id in localMap)) localMap[id] = { deleted: true, updated_at: ts };
  const lm = { updated_at: store._meta_updated_at };
  if (store.autofill !== undefined) lm.autofill = store.autofill;
  if (store.default !== undefined) lm.default = store.default;
  const map = {};
  for (const k of new Set([...Object.keys(remoteCards || {}), ...Object.keys(localMap)])) {
    const r = (remoteCards || {})[k]; const l = localMap[k];
    map[k] = r && l ? (at(l) > at(r) ? l : r) : r || l;
  }
  const rm = remoteMeta || {};
  const mergedMeta = at(rm) > at(lm) ? { ...rm } : { ...lm };
  store.cards = {}; store._tombstones = {};
  for (const [id, e] of Object.entries(map)) { if (e && e.deleted) store._tombstones[id] = e.updated_at; else if (e) store.cards[id] = e; }
  store._meta_updated_at = mergedMeta.updated_at;
  if (mergedMeta.autofill !== undefined) store.autofill = mergedMeta.autofill;
  if (mergedMeta.default !== undefined) store.default = mergedMeta.default;
  return { cards: map, cardsMeta: mergedMeta };
}
const desktopPick = (store) => { const ids = Object.keys(store.cards || {}); if (!ids.length) return null; return store.cards[store.default && store.cards[store.default] ? store.default : ids[0]]; };
const desktopOptions = (store) => Object.keys(store.cards || {}).map((id) => ({ id, isDefault: id === store.default }));

// ---- unit: the edit ops ----
test('adding the first card stamps it and makes it the default', () => {
  const out = applyCardOp({ schema: 1, fields: {}, cards: {}, cardsMeta: {} }, { kind: 'upsert', id: 'visa', card: VISA }, T1);
  assert.deepEqual(out.cards.visa, { ...VISA, updated_at: T1 });
  assert.deepEqual(out.cardsMeta, { default: 'visa', updated_at: T1 });
});

test('a second card does not steal the default unless asked; "make default" moves it in one step', () => {
  const b = { cards: { visa: { ...VISA, updated_at: T1 } }, cardsMeta: { autofill: true, default: 'visa', updated_at: T1 } };
  const plain = applyCardOp(b, { kind: 'upsert', id: 'mc', card: MC }, T2);
  assert.equal(defaultCardId(plain), 'visa');
  assert.deepEqual(plain.cardsMeta, b.cardsMeta, 'meta untouched (no new timestamp) when the default does not move');
  const made = applyCardOp(b, { kind: 'upsert', id: 'mc', card: MC, makeDefault: true }, T2);
  assert.deepEqual(made.cardsMeta, { autofill: true, default: 'mc', updated_at: T2 }, 'autofill kept, one default');
  assert.equal(made.cards.visa.updated_at, T1, 'the other card is not re-stamped');
});

test('a card added while the default names a deleted card becomes the default', () => {
  const b = { cards: { old: { deleted: true, updated_at: T1 } }, cardsMeta: { default: 'old', updated_at: T1 } };
  assert.equal(defaultCardId(b), '');
  assert.equal(defaultCardId(applyCardOp(b, { kind: 'upsert', id: 'visa', card: VISA }, T2)), 'visa');
});

test('edit keeps keys the phone form does not own (desktop domains) and re-stamps only that card', () => {
  const b = { cards: { visa: { ...VISA, domains: ['amazon.com'], updated_at: T1 }, mc: { ...MC, updated_at: T1 } }, cardsMeta: { default: 'visa', updated_at: T1 } };
  const out = applyCardOp(b, { kind: 'upsert', id: 'visa', card: { ...VISA, holder: 'JANE DOE' } }, T2);
  assert.deepEqual(out.cards.visa.domains, ['amazon.com']);
  assert.equal(out.cards.visa.holder, 'JANE DOE');
  assert.equal(out.cards.visa.updated_at, T2);
  assert.equal(out.cards.mc.updated_at, T1);
  assert.deepEqual(b.cards.visa.holder, 'JOHN DOE', 'input blob not mutated');
});

test('delete writes a tombstone; deleting the default moves it to the next card, then to none', () => {
  let b = { cards: { visa: { ...VISA, updated_at: T1 }, mc: { ...MC, updated_at: T1 } }, cardsMeta: { autofill: false, default: 'visa', updated_at: T1 } };
  b = applyCardOp(b, { kind: 'delete', id: 'visa' }, T2);
  assert.deepEqual(b.cards.visa, { deleted: true, updated_at: T2 });
  assert.deepEqual(b.cardsMeta, { autofill: false, default: 'mc', updated_at: T2 });
  assert.deepEqual(liveCards(b).map((c) => c.id), ['mc']);
  b = applyCardOp(b, { kind: 'delete', id: 'mc' }, T3);
  assert.deepEqual(b.cardsMeta, { autofill: false, default: '', updated_at: T3 });
  assert.equal(liveCards(b).length, 0);
});

test('deleting a non-default card leaves the default and its timestamp alone', () => {
  const b = { cards: { visa: { ...VISA, updated_at: T1 }, mc: { ...MC, updated_at: T1 } }, cardsMeta: { default: 'visa', updated_at: T1 } };
  const out = applyCardOp(b, { kind: 'delete', id: 'mc' }, T2);
  assert.deepEqual(out.cardsMeta, b.cardsMeta);
});

test('the Default toggle: on moves the single default, off clears it, off on a non-default is a no-op', () => {
  const b = { cards: { visa: { ...VISA, updated_at: T1 }, mc: { ...MC, updated_at: T1 } }, cardsMeta: { default: 'visa', updated_at: T1 } };
  assert.deepEqual(applyCardOp(b, { kind: 'setDefault', id: 'mc', on: true }, T2).cardsMeta, { default: 'mc', updated_at: T2 });
  assert.deepEqual(applyCardOp(b, { kind: 'setDefault', id: 'visa', on: false }, T2).cardsMeta, { default: '', updated_at: T2 });
  assert.deepEqual(applyCardOp(b, { kind: 'setDefault', id: 'mc', on: false }, T2).cardsMeta, b.cardsMeta);
  const gone = { ...b, cards: { ...b.cards, mc: { deleted: true, updated_at: T1 } } };
  assert.equal(defaultCardId(applyCardOp(gone, { kind: 'setDefault', id: 'mc', on: true }, T2)), 'visa', 'a tombstone cannot become the default');
});

test('new ids follow desktop uniqueId and never reuse a tombstoned id', () => {
  assert.equal(uniqueCardId({ cards: {} }), 'card');
  assert.equal(uniqueCardId({ cards: { card: { deleted: true, updated_at: T1 }, card2: { ...VISA } } }), 'card3');
});

// ---- unit: form validation ----
test('validation: Luhn number, a real unexpired expiry, CVV length by brand; blanks on edit keep saved values', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  const f = (o) => ({ holder: '', number: '4111 1111 1111 1111', cvv: '', exp_month: '12', exp_year: '2030', billing: {}, ...o });
  assert.equal(luhnValid('4111111111111111'), true);
  assert.equal(luhnValid('4111111111111112'), false);
  assert.deepEqual(validateCardForm(f({}), null, now), {});
  assert.ok(validateCardForm(f({ number: '4111111111111112' }), null, now).number);
  assert.ok(validateCardForm(f({ number: '' }), null, now).number);
  assert.ok(validateCardForm(f({ exp_month: '' }), null, now).exp);
  assert.ok(validateCardForm(f({ exp_month: '10', exp_year: '2026' }), null, now).exp, 'last month = expired');
  assert.deepEqual(validateCardForm(f({ exp_month: '11', exp_year: '2026' }), null, now), {}, 'this month still valid');
  assert.ok(validateCardForm(f({ cvv: '12' }), null, now).cvv);
  assert.ok(validateCardForm(f({ cvv: '1234' }), null, now).cvv, 'visa CVV is 3');
  assert.deepEqual(validateCardForm(f({ number: '378282246310005', cvv: '1234' }), null, now), {}, 'amex CVV is 4');
  const saved = { ...VISA };
  assert.deepEqual(validateCardForm(f({ number: '', cvv: '' }), saved, now), {});
  const card = cardFromForm(f({ number: '', cvv: '', holder: ' JANE ', billing: { city: ' SF ', zip: '' } }), saved);
  assert.deepEqual(card, { holder: 'JANE', number: '4111111111111111', cvv: '123', exp_month: '12', exp_year: '2030', billing: { city: 'SF' } });
});

// ---- end-to-end: the real syncVault over a fake /api/vault, with a desktop Keeper ----
async function fakeVault(key) {
  const st = { version: 0, ciphertext: null, secret_id: null, format: null, puts: 0, beforePut: null };
  const http = async (req) => {
    if (req.method === 'GET') {
      if (!st.version) return { status: 404, data: {} };
      return { status: 200, data: { version: st.version, ciphertext: st.ciphertext, secret_id: st.secret_id, format: st.format } };
    }
    st.puts++;
    if (st.beforePut) { const f = st.beforePut; st.beforePut = null; await f(); }
    if (req.body.base_version !== st.version) return { status: 409, data: { detail: { current: { version: st.version } } } };
    Object.assign(st, { ciphertext: req.body.ciphertext, secret_id: req.body.secret_id, format: req.body.format });
    st.version += 1;
    return { status: 200, data: { metadata: { version: st.version } } };
  };
  const read = async () => vc.decryptVault(key, st.ciphertext, st.format);
  const write = async (blob) => { const e = await vc.encryptVault(key, blob); Object.assign(st, e); st.version += 1; };
  return { st, http, read, write };
}
const CFG = { baseUrl: 'https://rb.example', apiKey: 'k' };

test('sync both ways: a phone-added default shows on desktop as "(default)" and desktop auto-fill picks it; a desktop default change shows on the phone', async () => {
  const key = vc.generateVaultKey();
  const v = await fakeVault(key);
  // Desktop already holds a card + a saved field.
  const desktop = { cards: { visa: { ...VISA, updated_at: T1 } }, _tombstones: {}, autofill: true, default: 'visa', _meta_updated_at: T1 };
  const field = { 's|example.com|#pw': { value: 'x', auto: true, updated_at: T1 } };
  await v.write({ schema: 1, fields: field, ...desktopMerge(desktop, {}, {}) });

  // Phone adds mc and makes it the default in one step.
  await vault.syncVault(CFG, key, (remote) => applyCardOp(remote, { kind: 'upsert', id: 'mc', card: MC, makeDefault: true }), { http: v.http });
  let blob = await v.read();
  assert.deepEqual(blob.fields, field, 'fields survive');
  assert.equal(blob.cards.visa.number, VISA.number, 'desktop card survives');

  // Desktop syncs: merge, then its picker and auto-fill choose mc.
  desktopMerge(desktop, blob.cards, blob.cardsMeta);
  assert.deepEqual(desktopOptions(desktop), [{ id: 'visa', isDefault: false }, { id: 'mc', isDefault: true }]);
  assert.equal(desktopPick(desktop).number, MC.number);
  assert.equal(desktop.autofill, true, 'desktop autofill flag preserved');

  // Desktop switches the default back (CardsApp checkbox → saveCards bumps _meta_updated_at) and pushes.
  desktop.default = 'visa'; desktop._meta_updated_at = '2099-01-01T00:00:00.000Z';
  blob = await v.read();
  await v.write({ ...blob, ...desktopMerge(desktop, blob.cards, blob.cardsMeta) });
  // Phone refresh = pullVault.
  const { data } = await vault.pullVault(CFG, key, v.http);
  assert.equal(defaultCardId(data), 'visa');
});

test('a phone delete tombstones the card so a desktop sync does not bring it back', async () => {
  const key = vc.generateVaultKey();
  const v = await fakeVault(key);
  const desktop = { cards: { visa: { ...VISA, updated_at: T1 }, mc: { ...MC, updated_at: T1 } }, _tombstones: {}, default: 'visa', _meta_updated_at: T1 };
  await v.write({ schema: 1, fields: {}, ...desktopMerge(desktop, {}, {}) });
  await vault.syncVault(CFG, key, (remote) => applyCardOp(remote, { kind: 'delete', id: 'visa' }), { http: v.http });
  const blob = await v.read();
  const merged = desktopMerge(desktop, blob.cards, blob.cardsMeta); // desktop still holds visa locally (T1)
  assert.deepEqual(Object.keys(desktop.cards), ['mc']);
  assert.equal(desktop.default, 'mc');
  assert.equal(merged.cards.visa.deleted, true, 'desktop pushes the tombstone back, not the card');
});

test('409: another device writes between the phone pull and push → the edit is re-applied on the newer blob, nothing dropped', async () => {
  const key = vc.generateVaultKey();
  const v = await fakeVault(key);
  await v.write({ schema: 1, fields: {}, cards: { visa: { ...VISA, updated_at: T1 } }, cardsMeta: { default: 'visa', updated_at: T1 }, extra: { keep: 1 } });
  v.st.beforePut = async () => {
    const b = await v.read();
    await v.write({ ...b, fields: { f: { value: 'y', auto: false, updated_at: T2 } }, cards: { ...b.cards, amex: { number: '378282246310005', updated_at: T2 } } });
  };
  await vault.syncVault(CFG, key, (remote) => applyCardOp(remote, { kind: 'upsert', id: 'mc', card: MC, makeDefault: true }), { http: v.http });
  const blob = await v.read();
  assert.equal(v.st.puts, 2, 'first PUT conflicted, second landed');
  assert.deepEqual(Object.keys(blob.cards).sort(), ['amex', 'mc', 'visa']);
  assert.equal(blob.fields.f.value, 'y');
  assert.deepEqual(blob.extra, { keep: 1 }, 'unknown collections kept');
  assert.equal(blob.cardsMeta.default, 'mc');
});
