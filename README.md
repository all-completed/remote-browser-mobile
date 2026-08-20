# Remote Browser Keeper — mobile (Android)

A Capacitor + React + Ionic port of the desktop [`remote-browser-keeper`](../remote-browser-keeper).

Repository: **https://github.com/all-completed/remote-browser-mobile** (public).

## Goal

Passwords and other credentials are **never passed to the AI model**. An agent
asks the Remote Browser Service to fill a field; this app signals the user, who
enters the value; the value flows **user → app → service → form field** directly.
The model only ever learns the request *status*, never the value.

## How it works

- Holds a reconnecting **WebSocket** to the service `…/api/keeper/ws` while the app
  is open (foreground). The API key is sent in the WebSocket **subprotocol**
  (`["bearer", <key>]`), never in the URL.
- On a `fill_request`, shows a prompt with the proof **screenshot**, the page URL,
  the agent's message, and one masked input per field (with `length`/`format`
  constraints). The values are sent back over the same socket; the **service**
  types them into the page.
- **Declining** stays one tap (**Cancel**). **Cancel with reason…** opens a panel that
  attaches a short note — five one-tap presets ("Wrong account", "Not now", "I'll do
  this myself", …) or free text — so the agent learns *why* instead of seeing a bare
  `cancelled` and guessing between retrying and giving up. The note rides back on the
  same `fill_response` frame as `reason` (max 200 chars; whitespace-only means no
  note, i.e. an ordinary cancel). It is ordinary user-typed text — never a field or
  vault value — so it is safe to show to the model. **Carrying it through to the agent
  is the service's half**: until `get_fill_status` exposes a `cancelled` request's
  `reason`, a service that ignores the field makes the decline behave exactly as
  before (all-completed/remote-browser-mobile#7). Declining stays available **even at
  0:00** — unlike Send, it costs nothing if the service has already stopped listening.
- A pending request **counts down** to the moment the service stops waiting (it then
  times out on its own), and the prompt closes itself when the time is gone instead of
  lingering as a prompt that can no longer be answered. The countdown comes from an
  **absolute deadline on the wire** — never from when the frame arrived, because the
  service replays a pending `fill_request` verbatim to a Keeper that reconnects, and a
  timer restarted on that replay would promise five fresh minutes to a phone that woke
  with thirty seconds left. A frame carrying no deadline shows **no countdown at all**
  rather than an invented one (`src/lib/deadline.ts`; `npm test`). The accepted fields,
  any of which may be epoch seconds, epoch milliseconds or ISO-8601:

  | field | meaning |
  | --- | --- |
  | `expires_at` | when the service stops waiting — the deadline itself |
  | `created_at` + `timeout_s` | an equally absolute second form, used when `expires_at` is absent |
  | `server_now` | the service's clock as it sent the frame; optional. Stamped once, so a replayed frame carries a stale one — it is read as a second, never-more-generous reading of the deadline, so it can correct a device clock that is behind but can never restart the countdown |
- **History** lists past requests (status + field metadata only — never values)
  from `GET /api/sessions/fill-history`. A proof screenshot opens full-size from the
  local cache when this device captured one, otherwise from
  `GET /api/sessions/fill-history/{request_id}/screenshot` — so a fill performed on
  another Keeper (or one whose local cache was pruned) is still viewable. The record's
  `has_screenshot` flag decides whether the button is offered at all.
- **Saved fields** can be kept in three scopes: *until the app restarts* (memory),
  *keep on this device* (`@capacitor/preferences`), or **Save to vault (synced
  across devices)** — end-to-end encrypted with the session `secret` and synced to
  every paired Keeper through `…/api/vault`. The service stores only opaque
  ciphertext and holds no key (see the service repo `docs/vault-sync.md`). The vault
  blob is byte-for-byte interoperable with the desktop Keeper (AES-256-GCM, key =
  `sha256(secret)`, `format = aesgcm-sha256-v1`); the session secret is provisioned
  by the desktop **pair QR**. `src/lib/vaultCrypto.ts` (WebCrypto) + `src/lib/vault.ts`
  (sync); `test/vault-interop.test.mjs` proves cross-device interop (`npm test`).

See [`../remote-browser-service/docs/keeper-protocol.md`](../remote-browser-service/docs/keeper-protocol.md)
for the wire protocol.

## Develop

```bash
npm install
npm run dev            # web preview at http://localhost:3000 (point Settings at the service)
```

## Build & run on Android

```bash
npm run build          # type-check + vite build -> www/
npx cap add android    # first time only
npx cap sync           # copy www/ + plugins into android/
npx cap open android   # build & run from Android Studio (emulator or device)
```

Requires Android Studio + an SDK/emulator. `appId` is `com.allcompleted.rbkeeper`.

> **JDK note:** build from **Android Studio** (it bundles JDK 17). The Capacitor
> Gradle CLI fails with `Unsupported class file major version` if your system
> `java` is newer than Gradle supports — Android Studio sidesteps this. The
> `android/` platform and `npx cap sync` work regardless.

### CI

[`.github/workflows/build.yml`](.github/workflows/build.yml) builds the **Android
debug APK** on every push (ubuntu + JDK 17 + Android SDK → Vite build → `cap sync`
→ `gradlew assembleDebug`) and uploads it as the `remote-browser-keeper-android`
artifact. Doc-only pushes are skipped.

### Install & auto-update on your phone (Obtainium)

[`.github/workflows/release.yml`](.github/workflows/release.yml) additionally
publishes the APK to a GitHub Release tagged **`v1.0.<run>`** on every push to `main`,
so [Obtainium](https://github.com/ImranR98/Obtainium) can install and **auto-update**
the app in place — no Play Store, no manual reinstall.

- The APK is signed with the repo's **committed `debug.keystore`** (this project
  commits it on purpose so every build shares a signature and updates don't wipe
  the on-device token), so no signing secrets are needed.
- **Every release gets a unique tag** (`v1.0.<run>`, matching `versionName`). This is
  what makes auto-update work: Obtainium reads an app's version from the release
  **tag name**, so a rolling/reused tag looks like the same version forever and no
  update is ever offered. Releases are never deleted, so previous APKs stay
  installable if a build turns out bad.
- `versionCode` is bumped to the CI run number as well, but that is for **Android**:
  it lets each build install over the last one and blocks downgrades. Obtainium does
  not read it — it never opens the APK.

**Set up Obtainium once:** Add app → URL `https://github.com/all-completed/remote-browser-mobile`
(public repo, no token needed) → it tracks the newest release; install once, then
every push to `main` offers a one-tap update.

## Configuration

Open **Settings** in the app and set the service URL (e.g.
`https://rb.all-completed.com`) and your API key — or scan the desktop Keeper's pairing
QR, which carries both. The URL lives in `@capacitor/preferences`; the key, the session
secret and the vault key live in Android Keystore-backed secure storage.

### This phone's own token (issue #12)

Once connected, the app asks the service for a token belonging to **this device alone**
(`POST /api/keeper/devices/enroll`, service repo issue #33) and uses it from then on. The
point is revocability: before per-device tokens, cutting this phone off meant rotating the
account key, which cut off the desktop Keeper and every script with it.

It is additive, and on this app that matters more than usual — updates arrive by manual
sideload, so an installed version may lag for months:

- The account key keeps working forever, and stays the fallback. A service that predates
  the feature answers 404/503; that is capability negotiation, not an error, and the app
  says so once and carries on.
- An existing install needs no re-pairing and no user action: it enrolls itself on the
  next connect, or doesn't, and works either way.
- The token goes to secure storage (never `Preferences`) and is presented in the WS
  subprotocol, never a query param — the service refuses device tokens on the URL by
  design, so they can't leak through access logs.
- Revoked from the Devices page, the service hangs up (close 1008) or refuses the
  handshake (401). The app drops the token, reconnects on the account key, and re-enrolls
  once. It never parks on "Auth failed" for a revoke it can recover from by itself.
- Changing the account key in Settings (or scanning a QR for a *different* account) drops
  the token first: it was minted under the old key. Re-entering the same key keeps it, so
  ordinary re-pairing doesn't orphan a record server-side.

Two things this deliberately does **not** change, both flagged in the issue:

- **The pairing QR still carries the account key.** The service's design has no
  enrollment-code concept — enrollment is authenticated by whatever credential you already
  hold — so a QR that carried a device token instead would be unreadable to any older APK,
  which is exactly the compatibility break the issue rules out. Scan-then-enroll gets the
  phone to its own token by a route that every app version survives.
- **FCM registration stays account-wide.** The `fcm_token` frame is unchanged, so wake
  pushes still fan out. Revoking a device therefore stops it *connecting* but does not
  drop its push registration; making pushes per-device is a service-side change (the
  registry keys tokens by user, not device) and belongs with that work.

## Status / out of scope (v1)

- Delivery is **foreground only** — requests arrive while the app is open. Push
  (FCM/APNs) for background wake-up is a future addition (needs Google/Apple
  developer accounts).
- iOS is not set up yet (`npx cap add ios`).
- The **countdown needs the service half**: at the time of writing, the `fill_request`
  frame documented in `remote-browser-service` `docs/keeper-protocol.md` carries no
  deadline (only `type, request_id, session_id, url, message, screenshot, fields`), so
  the request expires silently after `DEFAULT_FILL_TIMEOUT_S` with nothing on the wire
  to count down to. The client above is ready and degrades to today's behaviour — no
  timer, no local expiry — until the service adds `expires_at` (or `created_at` +
  `timeout_s`).
