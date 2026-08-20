// When a pending fill request expires — the absolute deadline, resolved onto THIS
// device's clock. Imports nothing (like vaultCrypto.ts), so test/fill-deadline.test.mjs
// can run the real source under Node.
//
// A fill request dies on its own: the service times it out (default 300s) and the status
// flips to `timeout` (remote-browser-service docs/keeper-protocol.md, status table). The
// Keeper may only show a countdown it can PROVE, because the service **replays the same
// `fill_request` frame verbatim** to a Keeper that reconnects (a phone just woken by a
// push). A timer started at frame arrival would promise a fresh five minutes to a device
// that reconnected with thirty seconds left — a countdown that lies is worse than none,
// since the user trusts it and loses the request. So everything here derives from an
// absolute deadline carried BY THE FRAME; when the frame carries none we show nothing
// rather than invent one.

export interface DeadlineFrame {
  expires_at?: number | string; // absolute: when the service stops waiting
  created_at?: number | string; // absolute: when the request was started
  timeout_s?: number | string; // relative to created_at (the service's fill timeout)
  server_now?: number | string; // the service's clock at send time (cancels device skew)
}

// The longest deadline we will believe. A frame further out than this is a clock
// disagreement, not a real wait — render nothing instead of a runaway timer.
const MAX_HORIZON_MS = 24 * 60 * 60 * 1000;

// Epoch milliseconds from epoch seconds, epoch milliseconds or an ISO-8601 string.
// Returns null for anything unusable — including 0/negative, which mean "unset" on the
// wire far more often than they mean 1970.
export function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v < 1e11 ? v * 1000 : v; // < 1e11 can't be milliseconds (that's 1973) → seconds
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return toEpochMs(Number(s));
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t > 0 ? t : null;
  }
  return null;
}

// The frame's deadline expressed on this device's clock (epoch ms), or null when the
// frame doesn't carry a usable one. Call this ONCE, when the frame lands, passing the
// local arrival time as `now` — that pins the answer to an instant, so a replay of the
// same frame later resolves to the same instant instead of a fresh countdown.
//
// null (⇒ no countdown, no auto-expiry) when the frame carries no deadline, or when the
// deadline it carries is already past / further out than MAX_HORIZON_MS at arrival. Both
// mean our clock and the service's disagree, and a request the service still considers
// pending must not be killed locally on the strength of a bad clock: the service sends
// `request_resolved` when it really times out, which dismisses the prompt anyway.
export function deadlineFromFrame(frame: DeadlineFrame | null | undefined, now: number = Date.now()): number | null {
  if (!frame) return null;
  let at = toEpochMs(frame.expires_at);
  if (at == null) {
    // Second form: an absolute anchor plus the service's timeout. Still absolute — it
    // survives replay — unlike timing from when this frame happened to arrive.
    const created = toEpochMs(frame.created_at);
    const secs = typeof frame.timeout_s === 'string' ? Number(frame.timeout_s) : frame.timeout_s;
    if (created == null || typeof secs !== 'number' || !Number.isFinite(secs) || secs <= 0) return null;
    at = created + secs * 1000;
  }
  // `server_now` gives a second reading of the same deadline, on this device's clock:
  //
  //   absolute   `at` as it stands            — wrong only by this device's clock error
  //   corrected  now + (at - server_now)      — wrong only by the frame's time in flight
  //
  // Neither is knowable alone: a device can't measure its own clock error, and a REPLAYED
  // frame can't tell how long it has been in flight — `server_now` is stamped once, when
  // the frame is built, so on a later arrival it is stale and reading it as "the service's
  // clock right now" turns `at - server_now` into a frozen interval. `now +` that interval
  // is exactly the timer-from-arrival the issue forbids: it restarts the countdown on
  // every reconnect, and a freshly started app (killed by the OS, woken by a push, or a
  // second device) has no earlier copy of the request to dedup against, so nothing else
  // catches it.
  //
  // Time in flight is never negative, so the corrected reading can only ever be too
  // GENEROUS. Believing whichever reading promises LESS therefore never inflates the
  // countdown — and when the device clock is right the absolute reading is exact at any
  // age, which is the case that matters: a frame replayed 4:30 late reads 0:30, not 5:00.
  // A device clock that is BEHIND is still corrected exactly on a fresh frame (there the
  // corrected reading is the smaller one). A device clock that is AHEAD cannot be
  // corrected at all without trusting `server_now` as "now", so it under-reads and, once
  // the skew passes the remaining time, falls off the `local <= now` guard below into
  // null — no countdown and no local expiry, i.e. today's behaviour, rather than a lie.
  const serverNow = toEpochMs(frame.server_now);
  const local = serverNow == null ? at : Math.min(at, now + (at - serverNow));
  if (local <= now || local - now > MAX_HORIZON_MS) return null;
  return local;
}

// Milliseconds left, never negative. null in, null out — "unknown" stays unknown.
export function remainingMs(deadline: number | null | undefined, now: number = Date.now()): number | null {
  if (deadline == null) return null;
  return Math.max(0, deadline - now);
}

// "4:12" / "0:07", or "1:04:12" past an hour. Rounds up, so the last second reads 0:01
// and 0:00 means the time really is gone.
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
