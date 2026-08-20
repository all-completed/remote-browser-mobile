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

// The regression this pins: `server_now` is stamped ONCE, when the frame is built, and
// pending_payloads() replays that frame verbatim — so on a later arrival it is stale.
// Read as "the service's clock right now" it makes `at - server_now` a frozen interval,
// and `now +` that interval restarts the countdown on every reconnect. The test above
// missed it because `{ expires_at }` alone is the one replay-safe form, and the E2E missed
// it because App.tsx's request_id dedup keeps the first copy's deadline for as long as the
// app process survives. Neither holds on a FRESH instance — the app killed by the OS and
// woken by a push, a reboot, or a hand-off to a second device — which is what this is.
test('REPLAY with server_now: a stale frame does not restart the countdown', () => {
  for (const frame of [
    { expires_at: SEC(T0 + 300_000), server_now: SEC(T0) },
    { created_at: SEC(T0), timeout_s: 300, server_now: SEC(T0) },
  ]) {
    const label = JSON.stringify(frame);
    // First arrival, on a device whose clock is right: the full five minutes.
    const first = deadlineFromFrame(frame, T0);
    assert.equal(remainingMs(first, T0), 300_000, label);
    // The SAME frame object 4:30 later, resolved by an app that has just started and has
    // never seen this request before. 0:30 is the truth; 5:00 would be the old lie.
    const replay = deadlineFromFrame(frame, T0 + 270_000);
    assert.equal(replay, first, `${label}: same frame ⇒ same absolute instant`);
    assert.equal(formatRemaining(remainingMs(replay, T0 + 270_000)), '0:30', label);
    // And once the deadline itself has passed, the replay yields no deadline at all
    // (⇒ no countdown, no local expiry) rather than a fresh five minutes.
    assert.equal(deadlineFromFrame(frame, T0 + 400_000), null, label);
  }
});

test('created_at + timeout_s is an equally absolute second form', () => {
  const frame = { created_at: SEC(T0 - 100_000), timeout_s: 300 };
  assert.equal(deadlineFromFrame(frame, T0), T0 + 200_000);
  // …and it too survives replay.
  assert.equal(deadlineFromFrame(frame, T0 + 150_000), T0 + 200_000);
  // expires_at wins when both are present.
  assert.equal(deadlineFromFrame({ ...frame, expires_at: SEC(T0 + 60_000) }, T0), T0 + 60_000);
});

test('server_now cancels a device clock that is BEHIND, and never inflates the countdown', () => {
  const frame = { expires_at: SEC(T0 + 300_000), server_now: SEC(T0) }; // service: 5:00 left
  // A device two hours behind. Its own reading of `expires_at` is 2:05:00 out — over the
  // horizon — but the corrected reading is the shorter one, so it wins and is exact.
  const behind = T0 - 2 * 3600_000;
  assert.equal(remainingMs(deadlineFromFrame(frame, behind), behind), 300_000);
  // A device two hours AHEAD reads `expires_at` as long past. That cannot be corrected
  // without trusting the (replayable, therefore stale-able) `server_now` as "now", so the
  // answer is "no trustworthy deadline" — no countdown AND no local expiry, leaving the
  // prompt for the service's own `request_resolved` — rather than a number we can't stand
  // behind or a request killed locally on the strength of a bad clock.
  const ahead = T0 + 2 * 3600_000;
  assert.equal(deadlineFromFrame(frame, ahead), null);
  assert.equal(deadlineFromFrame({ expires_at: SEC(T0 + 300_000) }, ahead), null); // as without it
  // Residual, and deliberate: a clock that is badly BEHIND still leans on `server_now`,
  // so a replay to such a device over-reads by the frame's age (300s shown, 30s true) —
  // bounded by the clock error, and the price of showing that device anything at all.
  // A correct clock — the case that matters — is exact at any age (see the REPLAY test).
  assert.equal(remainingMs(deadlineFromFrame(frame, behind + 270_000), behind + 270_000), 300_000);
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
