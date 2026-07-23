// Proves the mobile Keeper's WebCrypto vault envelope (src/lib/vaultCrypto.ts) is
// byte-for-byte interoperable with the desktop Keeper's node:crypto envelope
// (remote-browser-keeper src/vault.js): a blob encrypted on one side decrypts on
// the other. Both use AES-256-GCM, key = sha256(secret), envelope iv(12)‖ct‖tag(16).
//
// The two implementations below MUST mirror the shipping code:
//   - nodeEncrypt / nodeDecrypt  == desktop src/vault.js
//   - webEncrypt  / webDecrypt   == mobile  src/lib/vaultCrypto.ts (inlined; the app
//     builds it as TS, so we re-express the identical WebCrypto calls here in JS).
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

const SECRET = 'correct horse battery staple — high entropy session secret';
const webcrypto = nodeCrypto.webcrypto; // the same SubtleCrypto the webview exposes

// ---- desktop side (node:crypto) ----
function nodeKey(secret) {
  return nodeCrypto.createHash('sha256').update(String(secret), 'utf8').digest();
}
function nodeEncrypt(secret, obj) {
  const iv = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', nodeKey(secret), iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}
function nodeDecrypt(secret, b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', nodeKey(secret), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

// ---- mobile side (WebCrypto) — identical operations to vaultCrypto.ts ----
async function webKey(secret) {
  const raw = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return webcrypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function webEncrypt(secret, obj) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await webKey(secret);
  const ctTag = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const env = new Uint8Array(iv.length + ctTag.length);
  env.set(iv, 0);
  env.set(ctTag, iv.length);
  return Buffer.from(env).toString('base64');
}
async function webDecrypt(secret, b64) {
  const env = new Uint8Array(Buffer.from(b64, 'base64'));
  const iv = env.subarray(0, 12);
  const ctTag = env.subarray(12);
  const key = await webKey(secret);
  const pt = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctTag);
  return JSON.parse(new TextDecoder().decode(pt));
}

const BLOB = { schema: 1, fields: { 's|example.com|#pw': { value: 'hunter2', auto: true, updated_at: '2026-01-01T00:00:00Z' } } };

test('desktop-encrypted vault decrypts on mobile', async () => {
  const ct = nodeEncrypt(SECRET, BLOB);
  assert.deepEqual(await webDecrypt(SECRET, ct), BLOB);
});

test('mobile-encrypted vault decrypts on desktop', async () => {
  const ct = await webEncrypt(SECRET, BLOB);
  assert.deepEqual(nodeDecrypt(SECRET, ct), BLOB);
});

test('a wrong secret fails authentication both ways', async () => {
  await assert.rejects(() => webDecrypt('nope', nodeEncrypt(SECRET, BLOB)));
  assert.throws(() => nodeDecrypt('nope', BLOB_CT_PLACEHOLDER()));
  function BLOB_CT_PLACEHOLDER() {
    // encrypt synchronously on the node side for the throws() check
    return nodeEncrypt(SECRET, BLOB);
  }
});
