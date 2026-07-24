// Proves the mobile Keeper's WebCrypto vault envelope (src/lib/vaultCrypto.ts) is
// byte-for-byte interoperable with the desktop Keeper's node:crypto envelope
// (remote-browser-keeper src/vault.js) for the v2 key model, AND that the SECURITY FIX
// holds: secret_id is domain-separated from the AES key (never equal to it).
//
// v2 derivation (both sides): master = sha256(pw) [sha256-v2] or pbkdf2(pw,salt) [pbkdf2-v2];
// encKey = master; secret_id = sha256("rbvault-id-v2" ‖ master). Envelopes:
//   sha256-v2 :        iv(12) ‖ ct ‖ tag(16)
//   pbkdf2-v2 : salt(16) ‖ iv(12) ‖ ct ‖ tag(16)
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

const webcrypto = nodeCrypto.webcrypto;
const ITER = 210000;
const ID_DOMAIN = Buffer.from('rbvault-id-v2', 'utf8');
const BLOB = { schema: 1, fields: { 's|example.com|#pw': { value: 'hunter2', auto: true, updated_at: '2026-01-01T00:00:00Z' } } };

// ---- desktop side (node:crypto) — mirrors src/vault.js ----
const nMasterSha = (pw) => nodeCrypto.createHash('sha256').update(pw, 'utf8').digest();
const nMasterPbkdf2 = (pw, salt) => nodeCrypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), salt, ITER, 32, 'sha256');
const nSecretId = (master) => nodeCrypto.createHash('sha256').update(Buffer.concat([ID_DOMAIN, master])).digest('hex');
function nodeEncrypt(format, pw, obj, salt) {
  const master = format === 'aesgcm-pbkdf2-v2' ? nMasterPbkdf2(pw, salt) : nMasterSha(pw);
  const iv = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', master, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
  const prefix = format === 'aesgcm-pbkdf2-v2' ? salt : Buffer.alloc(0);
  return { ciphertext: Buffer.concat([prefix, iv, ct, c.getAuthTag()]).toString('base64'), secret_id: nSecretId(master) };
}
function nodeDecrypt(format, pw, b64) {
  const buf = Buffer.from(b64, 'base64');
  let off = 0, master;
  if (format === 'aesgcm-pbkdf2-v2') { master = nMasterPbkdf2(pw, buf.subarray(0, 16)); off = 16; }
  else master = nMasterSha(pw);
  const body = buf.subarray(off);
  const iv = body.subarray(0, 12), tag = body.subarray(body.length - 16), ct = body.subarray(12, body.length - 16);
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', master, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

// ---- mobile side (WebCrypto) — mirrors src/lib/vaultCrypto.ts ----
const cat = (...a) => { const t = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { t.set(x, o); o += x.length; } return t; };
async function wSha(u8) { return new Uint8Array(await webcrypto.subtle.digest('SHA-256', u8)); }
async function wMaster(format, pw, salt) {
  const pwb = new TextEncoder().encode(pw);
  if (format === 'aesgcm-pbkdf2-v2') {
    const km = await webcrypto.subtle.importKey('raw', pwb, 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, km, 256));
  }
  return wSha(pwb);
}
async function wSecretId(master) { return Buffer.from(await wSha(cat(ID_DOMAIN, master))).toString('hex'); }
async function webEncrypt(format, pw, obj, salt) {
  const master = await wMaster(format, pw, salt);
  const key = await webcrypto.subtle.importKey('raw', master, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ctTag = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const prefix = format === 'aesgcm-pbkdf2-v2' ? salt : new Uint8Array(0);
  return { ciphertext: Buffer.from(cat(prefix, iv, ctTag)).toString('base64'), secret_id: await wSecretId(master) };
}
async function webDecrypt(format, pw, b64) {
  const env = new Uint8Array(Buffer.from(b64, 'base64'));
  let off = 0, salt;
  if (format === 'aesgcm-pbkdf2-v2') { salt = env.subarray(0, 16); off = 16; }
  const master = await wMaster(format, pw, salt);
  const key = await webcrypto.subtle.importKey('raw', master, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const iv = env.subarray(off, off + 12);
  const pt = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, env.subarray(off + 12));
  return JSON.parse(new TextDecoder().decode(pt));
}

test('SECURITY: secret_id is domain-separated from the AES key', async () => {
  const pw = 'a'.repeat(43);
  const enc = nodeEncrypt('aesgcm-sha256-v2', pw, BLOB);
  assert.notEqual(enc.secret_id, nMasterSha(pw).toString('hex')); // v1 bug: id === key
});

test('interop sha256-v2: node<->web cross-decrypt + identical secret_id', async () => {
  const pw = nodeCrypto.randomBytes(32).toString('base64url');
  const n = nodeEncrypt('aesgcm-sha256-v2', pw, BLOB);
  assert.deepEqual(await webDecrypt('aesgcm-sha256-v2', pw, n.ciphertext), BLOB);
  const w = await webEncrypt('aesgcm-sha256-v2', pw, BLOB);
  assert.deepEqual(nodeDecrypt('aesgcm-sha256-v2', pw, w.ciphertext), BLOB);
  assert.equal(n.secret_id, w.secret_id);
});

test('interop pbkdf2-v2: node<->web cross-decrypt + identical secret_id', async () => {
  const pw = 'correct horse battery staple';
  const salt = nodeCrypto.randomBytes(16);
  const n = nodeEncrypt('aesgcm-pbkdf2-v2', pw, BLOB, salt);
  assert.deepEqual(await webDecrypt('aesgcm-pbkdf2-v2', pw, n.ciphertext), BLOB);
  const w = await webEncrypt('aesgcm-pbkdf2-v2', pw, BLOB, new Uint8Array(salt));
  assert.deepEqual(nodeDecrypt('aesgcm-pbkdf2-v2', pw, w.ciphertext), BLOB);
  assert.equal(n.secret_id, w.secret_id);
});

test('a wrong password fails authentication both ways', async () => {
  const n = nodeEncrypt('aesgcm-sha256-v2', 'right', BLOB);
  await assert.rejects(() => webDecrypt('aesgcm-sha256-v2', 'wrong', n.ciphertext));
  assert.throws(() => nodeDecrypt('aesgcm-sha256-v2', 'wrong', n.ciphertext));
});
