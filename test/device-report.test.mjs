// The device report's vault half (src/lib/vaultCrypto.ts: vaultKeyReport / vaultState),
// run against the REAL source — not a mirror of it — because one of these rules is a
// security rule: under legacy aesgcm-sha256-v1 the secret_id IS the AES key, so a v1
// device must report its format and no id (src/lib/vaultCrypto.ts's expectedSecretId).
//
// vaultCrypto.ts imports nothing (no Capacitor, by design), so stripping its types with
// the TypeScript compiler already in devDependencies is enough to import it under Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodeCrypto from 'node:crypto';
import ts from 'typescript';

globalThis.crypto ??= nodeCrypto.webcrypto; // present since Node 19; explicit for older runners

const SRC = new URL('../src/lib/vaultCrypto.ts', import.meta.url);
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rbvault-')), 'vaultCrypto.mjs');
fs.writeFileSync(tmp, js);
const vc = await import(tmp);

const V1 = 'aesgcm-sha256-v1';
const PW = 'a'.repeat(43);
const legacySecretId = (pw) => nodeCrypto.createHash('sha256').update(pw, 'utf8').digest('hex'); // == the v1 AES key

test('SECURITY: a legacy v1 device reports its format and NOT its secret_id', async () => {
  const r = await vc.vaultKeyReport({ password: PW, format: V1 });
  assert.equal(r.has_key, true);
  assert.equal(r.key_format, V1);
  assert.equal(r.format, V1); // the name the service reads
  assert.equal(r.legacy, true);
  assert.equal(r.secret_id, null);
  // The v1 id is hex(sha256(password)), which under v1 is the encryption key itself.
  assert.doesNotMatch(JSON.stringify(r), new RegExp(legacySecretId(PW)));
  assert.doesNotMatch(JSON.stringify(r), /a{43}/); // and never the password
  assert.equal(vc.vaultState(r), 'legacy_v1');
});

test('v2 reports the domain-separated secret_id, equal to the one the vault is stored under', async () => {
  const key = { password: PW, format: vc.FORMAT_SHA256_V2 };
  const r = await vc.vaultKeyReport(key);
  assert.equal(r.has_key, true);
  assert.equal(r.key_format, vc.FORMAT_SHA256_V2);
  assert.equal(r.legacy, false);
  assert.equal(r.secret_id, (await vc.encryptVault(key, { schema: 1 })).secret_id); // groups devices by vault
  assert.notEqual(r.secret_id, legacySecretId(PW)); // never the key
  assert.equal(vc.vaultState(r), 'ok');
});

test('pbkdf2-v2 reports the id derived from its own salt', async () => {
  const key = vc.userVaultKey('correct horse battery staple');
  const r = await vc.vaultKeyReport(key);
  assert.equal(r.key_format, vc.FORMAT_PBKDF2_V2);
  assert.equal(r.secret_id, (await vc.encryptVault(key, { schema: 1 })).secret_id);
  assert.equal(vc.vaultState(r), 'ok');
});

test('a pbkdf2 key with a lost salt still reports its format, with no id', async () => {
  const r = await vc.vaultKeyReport({ password: PW, format: vc.FORMAT_PBKDF2_V2 }); // salt missing
  assert.equal(r.has_key, true);
  assert.equal(r.key_format, vc.FORMAT_PBKDF2_V2);
  assert.equal(r.secret_id, null);
});

test('no key at all is distinguishable from a key that cannot decrypt the vault', async () => {
  const none = await vc.vaultKeyReport(null);
  assert.deepEqual(none, { schema: vc.VAULT_SCHEMA, has_key: false, format: null, key_format: null, legacy: false, secret_id: null });
  assert.equal(vc.vaultState(none), 'no_key');
  assert.equal(vc.vaultState(none, true), 'no_key'); // holding nothing is never "needs_repair"

  const held = await vc.vaultKeyReport({ password: PW, format: vc.FORMAT_SHA256_V2 });
  assert.equal(vc.vaultState(held, true), 'needs_repair'); // has_key true, but VaultKeyMismatch
  assert.equal(held.has_key, true); // …and that's what tells the two apart on the wire
});

test('an empty password is not a held key', async () => {
  assert.equal((await vc.vaultKeyReport({ password: '', format: vc.FORMAT_SHA256_V2 })).has_key, false);
  assert.equal((await vc.vaultKeyReport(undefined)).has_key, false);
});
