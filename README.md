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
- **History** lists past requests (status + field metadata only — never values)
  from `GET /api/sessions/fill-history`; proof screenshots are cached locally and
  can be opened full-size.

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
artifact. Doc-only pushes are skipped. The signed release build is a future step.

## Configuration

Open **Settings** in the app and set the service URL (e.g.
`https://rb.all-completed.com`) and your API key. Stored locally via
`@capacitor/preferences`.

## Status / out of scope (v1)

- Delivery is **foreground only** — requests arrive while the app is open. Push
  (FCM/APNs) for background wake-up is a future addition (needs Google/Apple
  developer accounts).
- iOS is not set up yet (`npx cap add ios`).
