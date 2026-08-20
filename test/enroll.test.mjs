// Device enrollment (issue #12), run against the REAL src/lib/enroll.ts rather than a
// mirror of it. The rules under test are the ones the issue calls non-negotiable: this
// app reaches users by sideload, so an install may lag for months and must keep working
// against every service, old or new, and must never be talked into an auth-failure loop.
//
// enroll.ts imports nothing at module scope (the Capacitor HTTP call is a lazy import
// behind an injectable `post`), so stripping its types with the TypeScript compiler
// already in devDependencies is enough to import it under Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const SRC = new URL('../src/lib/enroll.ts', import.meta.url);
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rbenroll-')), 'enroll.mjs');
fs.writeFileSync(tmp, js);
const e = await import(tmp);

test('a service that has never heard of enrollment is a capability gap, not an error', () => {
  assert.equal(e.classifyEnrollStatus(404), 'unsupported'); // predates the feature
  assert.equal(e.classifyEnrollStatus(503), 'unsupported'); // feature present, unwired
  assert.equal(e.classifyEnrollStatus(200), 'ok');
  assert.equal(e.classifyEnrollStatus(401), 'unauthorized');
  assert.equal(e.classifyEnrollStatus(500), 'error');       // transient — worth retrying
});

test('the device token wins when present; the account key is always the fallback', () => {
  assert.deepEqual(e.pickCredential({ deviceToken: 'dt', apiKey: 'ak' }), { token: 'dt', kind: 'device' });
  assert.deepEqual(e.pickCredential({ apiKey: 'ak' }), { token: 'ak', kind: 'account' });
  assert.deepEqual(e.pickCredential({ deviceToken: '   ', apiKey: 'ak' }), { token: 'ak', kind: 'account' });
  assert.deepEqual(e.pickCredential({}), { token: '', kind: 'none' });
});

test('a 401 on the ACCOUNT key never discards a device token', () => {
  // The same status means opposite things depending on what we presented. Treating a
  // wrong account key as a revoke would throw away a valid enrollment; treating a revoke
  // as a wrong key would park the phone on "Auth failed — open Settings" forever.
  assert.equal(e.isRevocationSignal({ kind: 'account', httpStatus: 401 }), false);
  assert.equal(e.isRevocationSignal({ kind: 'device', httpStatus: 401 }), true);
  assert.equal(e.isRevocationSignal({ kind: 'device', code: 1008, reason: 'Device token revoked' }), true);
  // An ordinary disconnect is not a revoke — otherwise every tunnel drop or Doze-killed
  // socket would silently un-enroll the phone.
  assert.equal(e.isRevocationSignal({ kind: 'device', code: 1006 }), false);
  assert.equal(e.isRevocationSignal({ kind: 'device', code: 1000 }), false);
  assert.equal(e.isRevocationSignal({ kind: 'none', httpStatus: 401 }), false);
});

test('enrollment is attempted only when there is something to upgrade, and with room to breathe', () => {
  const st = e.enrollmentState();
  assert.equal(e.shouldEnroll(st, { hasDeviceToken: false, hasApiKey: true }), true);
  assert.equal(e.shouldEnroll(st, { hasDeviceToken: true, hasApiKey: true }), false);   // already enrolled
  assert.equal(e.shouldEnroll(st, { hasDeviceToken: false, hasApiKey: false }), false); // nothing to present

  const now = 1_000_000;
  const tried = { ...e.enrollmentState(), lastAttempt: now };
  assert.equal(e.shouldEnroll(tried, { hasDeviceToken: false, hasApiKey: true, now: now + 1000 }), false);
  assert.equal(e.shouldEnroll(tried, { hasDeviceToken: false, hasApiKey: true, now: now + e.RETRY_AFTER_MS }), true);

  // An old service said no once; don't ask again this run (it is asked again next launch,
  // because this state is deliberately not persisted).
  const old = { ...e.enrollmentState(), supported: false };
  assert.equal(e.shouldEnroll(old, { hasDeviceToken: false, hasApiKey: true }), false);
});

test('enrollDevice sends the key in a header, never the URL', async () => {
  let seen = null;
  const post = async (o) => {
    seen = o;
    // `device_id` is what the service actually returns (public_device_record) — reading
    // `id` here is what shipped first, and it silently left every device unadopted.
    return { status: 200, data: { token: 'dev-token', device: { device_id: 'd1' }, secret_bound: true } };
  };
  const res = await e.enrollDevice({
    baseUrl: 'https://rb.example.com/',
    apiKey: 'SHARED-KEY',
    identity: { name: 'Pixel 7', platform: 'Android', app_version: '0.1.0' },
    post,
  });
  assert.equal(res.ok, true);
  assert.equal(res.token, 'dev-token');
  assert.equal(res.deviceId, 'd1');
  assert.equal(res.secretBound, true);
  assert.equal(seen.url, 'https://rb.example.com/api/keeper/devices/enroll');
  assert.ok(!seen.url.includes('SHARED-KEY')); // the service rejects tokens on the URL
  assert.equal(seen.headers.Authorization, 'Bearer SHARED-KEY');
  assert.deepEqual(seen.data, { device_name: 'Pixel 7', platform: 'Android', app_version: '0.1.0' });
});

test('a JSON body that arrived as a string is still parsed', async () => {
  // CapacitorHttp usually parses JSON, but a proxy or an odd content-type can hand back
  // the raw text — dropping the enrollment over that would leave the phone unenrolled
  // for no reason.
  const res = await e.enrollDevice({
    baseUrl: 'https://x', apiKey: 'k',
    post: async () => ({ status: 200, data: '{"token":"t2","device":{"device_id":"d2"},"secret_bound":false}' }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.token, 't2');
  assert.equal(res.secretBound, false);
});

test('an old service, a broken one, and a hung one all leave us on the account key', async () => {
  assert.deepEqual(
    await e.enrollDevice({ baseUrl: 'https://x', apiKey: 'k', post: async () => ({ status: 404 }) }),
    { ok: false, reason: 'unsupported', status: 404 },
  );
  const thrown = await e.enrollDevice({
    baseUrl: 'https://x', apiKey: 'k',
    post: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reason, 'error'); // never propagates: a phone that works keeps working

  // A 200 with no token is not an enrollment, however cheerful the body is.
  const empty = await e.enrollDevice({
    baseUrl: 'https://x', apiKey: 'k',
    post: async () => ({ status: 200, data: { status: 'success' } }),
  });
  assert.equal(empty.ok, false);
});

// The one contract that spans two repos, and the one that already broke once (reading
// `id` where the service writes `device_id`). This body is the verbatim shape of
// remote-browser-service `POST /api/keeper/devices/enroll` at 7f4e984 — the deployed
// build — including the `public_device_record` fields we don't read and the `message`
// and `status` keys. If the service ever changes it, this fails here rather than on a
// phone that silently stops adopting its own id.
test('the deployed service response shape parses, extra keys and all', async () => {
  const res = await e.enrollDevice({
    baseUrl: 'https://rb.all-completed.com', apiKey: 'SHARED-KEY',
    post: async () => ({
      status: 200,
      data: {
        status: 'success',
        device: {
          device_id: 'dev-abc123', device_name: 'Pixel 7', platform: 'Android',
          app_version: '0.1.0', created_at: '2026-08-20T00:00:00Z',
          last_seen_at: '2026-08-20T00:00:00Z', enrolled: true,
        },
        token: 'eyJhbGciOiJIUzI1NiJ9.device.token',
        secret_bound: true,
        message: "Copy the token now — only its hash is stored and it won't be shown again.",
      },
    }),
  });
  assert.deepEqual(res, {
    ok: true,
    token: 'eyJhbGciOiJIUzI1NiJ9.device.token',
    deviceId: 'dev-abc123',
    secretBound: true,
  });
});

test('no account key means no enrollment attempt at all', async () => {
  let called = false;
  const res = await e.enrollDevice({
    baseUrl: 'https://x', apiKey: '',
    post: async () => { called = true; return { status: 200 }; },
  });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});
