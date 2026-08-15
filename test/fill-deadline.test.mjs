// The countdown's arithmetic (src/lib/deadline.ts), run against the REAL source — not a
// mirror of it — because the rule that matters here is a behavioural one: the service
// REPLAYS a pending `fill_request` frame verbatim to a Keeper that reconnects, so a
// deadline derived from frame-arrival time would show a phone that woke with 30s left a
// full five minutes. Every case below pins that: same frame, later arrival, same instant.
//
// deadline.ts imports nothing (by design), so stripping its types with the TypeScript
// compiler already in devDependencies is enough to import it under Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const SRC = new URL('../src/lib/deadline.ts', import.meta.url);
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rbdeadline-')), 'deadline.mjs');
fs.writeFileSync(tmp, js);
const { deadlineFromFrame, formatRemaining, remainingMs, toEpochMs } = await import(tmp);

const T0 = Date.parse('2026-08-14T12:00:00Z'); // "now" for every test, in ms
const SEC = (ms) => Math.round(ms / 1000);

test('epoch seconds, epoch ms and ISO-8601 all parse to the same instant', () => {
  assert.equal(toEpochMs(SEC(T0)), T0);
  assert.equal(toEpochMs(T0), T0);
  assert.equal(toEpochMs('2026-08-14T12:00:00Z'), T0);
  assert.equal(toEpochMs(String(SEC(T0))), T0); // numeric string (some JSON encoders)
});

test('unusable values are "unknown", never 1970', () => {
  for (const v of [undefined, null, 0, -1, NaN, Infinity, '', '   ', 'soon', {}, []]) {
    assert.equal(toEpochMs(v), null, `${JSON.stringify(v)} should be null`);
  }
});

test('REPLAY: the same frame arriving later yields the SAME deadline, not a fresh one', () => {
  const frame = { expires_at: SEC(T0 + 300_000) }; // 5:00 from T0
  const first = deadlineFromFrame(frame, T0);
  const replay = deadlineFromFrame(frame, T0 + 270_000); // phone reconnects with 0:30 left
  assert.equal(first, T0 + 300_000);
  assert.equal(replay, first);
  assert.equal(remainingMs(replay, T0 + 270_000), 30_000); // 0:30, not 5:00
  assert.equal(formatRemaining(remainingMs(replay, T0 + 270_000)), '0:30');
});

test('created_at + timeout_s is an equally absolute second form', () => {
  const frame = { created_at: SEC(T0 - 100_000), timeout_s: 300 };
  assert.equal(deadlineFromFrame(frame, T0), T0 + 200_000);
  // …and it too survives replay.
  assert.equal(deadlineFromFrame(frame, T0 + 150_000), T0 + 200_000);
  // expires_at wins when both are present.
  assert.equal(deadlineFromFrame({ ...frame, expires_at: SEC(T0 + 60_000) }, T0), T0 + 60_000);
});

test('server_now cancels a device clock that is wrong', () => {
  // Service says: now = T0, expires at T0+300s. This device thinks it is T0+2h.
  const skewed = T0 + 2 * 3600_000;
  const at = deadlineFromFrame({ expires_at: SEC(T0 + 300_000), server_now: SEC(T0) }, skewed);
  assert.equal(remainingMs(at, skewed), 300_000); // still five minutes, not "expired"
  // Without server_now the same frame would look long dead — and is then reported as
  // "no trustworthy deadline" rather than killing a request the service still holds.
  assert.equal(deadlineFromFrame({ expires_at: SEC(T0 + 300_000) }, skewed), null);
});

test('no deadline is invented, and neither past nor absurd ones are believed', () => {
  assert.equal(deadlineFromFrame({}, T0), null); // today's frames: nothing on the wire
  assert.equal(deadlineFromFrame(null, T0), null);
  assert.equal(deadlineFromFrame({ expires_at: SEC(T0 - 1) }, T0), null); // already past
  assert.equal(deadlineFromFrame({ expires_at: SEC(T0 + 48 * 3600_000) }, T0), null); // runaway
  assert.equal(deadlineFromFrame({ created_at: SEC(T0), timeout_s: 0 }, T0), null);
  assert.equal(deadlineFromFrame({ created_at: SEC(T0) }, T0), null); // anchor without a length
  assert.equal(deadlineFromFrame({ timeout_s: 300 }, T0), null); // length without an anchor
});

test('remaining is clamped at zero and stays null when unknown', () => {
  assert.equal(remainingMs(null, T0), null);
  assert.equal(remainingMs(undefined, T0), null);
  assert.equal(remainingMs(T0 - 60_000, T0), 0); // never negative
  assert.equal(remainingMs(T0 + 1_500, T0), 1_500);
});

test('formatting rounds up, pads, and grows an hours field', () => {
  assert.equal(formatRemaining(300_000), '5:00');
  assert.equal(formatRemaining(252_000), '4:12');
  assert.equal(formatRemaining(6_400), '0:07'); // rounds up: there is still time left
  assert.equal(formatRemaining(1), '0:01');
  assert.equal(formatRemaining(0), '0:00'); // only zero reads zero
  assert.equal(formatRemaining(-5_000), '0:00');
  assert.equal(formatRemaining(3_852_000), '1:04:12');
});
