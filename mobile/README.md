# BusyDays mobile (iOS + Android)

Native shell around the deployed BusyDays web app, built with
[Capacitor](https://capacitorjs.com). The webview loads the production site
directly (`server.url` in `capacitor.config.ts`), so **the web app is the app**
— every server deploy updates mobile instantly, with no store re-submission.

The shell adds the two things a webview can't do alone:

| Capability | How |
|---|---|
| **Native push** | FCM device tokens, registered via `POST /api/push/register-device`; the server fans out every notification to web-push *and* FCM (`src/services/push.ts` + `src/services/fcm.ts`). |
| **Google sign-in** | The **native account sheet** (no browser). `NativeGoogleSignInPlugin` (Android/iOS) returns an ID token — verified at `POST /api/auth/google/id-token` for returning users — plus a one-time `serverAuthCode` for first-timers, exchanged at `POST /api/auth/google/native-code` to provision the workspace in-app. If the native path can't complete (missing config, cancelled, Play Services absent) it **falls back to the system browser** (`/auth/google?mobile=1` → `busydays://auth?ott=…` → `POST /api/auth/mobile/exchange`), so sign-in always works. |

All app-side logic lives in `public/mobile-bridge.js` (served by the main app;
inert in normal browsers, active only inside this shell).

---

## 1. One-time setup

### Prerequisites

- Node 20+, then `cd mobile && npm install`
- **Android**: Android Studio (bundles SDK + JDK)
- **iOS**: a Mac with Xcode 15+, CocoaPods (`sudo gem install cocoapods`), and an
  [Apple Developer Program](https://developer.apple.com/programs/) membership (₹/y, required for push + App Store)
- **Google Play Console** account (one-time fee)

### Firebase (push notifications, both platforms)

1. Create a Firebase project at <https://console.firebase.google.com> (e.g. "BusyDays").
2. **Android app**: add app with package `in.busydays.app` → download
   `google-services.json` → place at `mobile/android/app/google-services.json`.
   (Gradle picks it up automatically; it is gitignored.)
3. **iOS app**: add app with bundle ID `in.busydays.app` → download
   `GoogleService-Info.plist` → add it to the App target in Xcode
   (drag into `ios/App/App/`; it is gitignored).
4. **APNs key** (iOS): Apple Developer portal → Keys → create an APNs key →
   upload the `.p8` to Firebase → Project settings → Cloud Messaging → iOS app.
5. **Server credential**: Firebase → Project settings → Service accounts →
   *Generate new private key*. Set the JSON (raw, or base64 if your platform's
   env UI mangles newlines) as `FCM_SERVICE_ACCOUNT_JSON` on the server.
   Without it the server simply skips native push.

### Native Google Sign-In (in-app account sheet)

The app signs users in **without a browser** using the native Google account
sheet. It needs OAuth client IDs from the **same** Google Cloud project as your
web `GOOGLE_CLIENT_ID`:

1. **Android OAuth client** — Cloud Console → *Credentials → Create credentials
   → OAuth client ID → Android*. Package `in.busydays.app`; SHA-1 from your
   signing key:
   - debug: `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`
   - release: the SHA-1 of your upload keystore (and, once on Play, the
     **Play App Signing** SHA-1 from Play Console → Setup → App integrity).
   No code change — Android sends the *web* client ID as `webClientId` (already
   fetched from `/api/push/config`); Google matches the request by package+SHA-1.
2. **iOS OAuth client** — Cloud Console → *OAuth client ID → iOS*, bundle
   `in.busydays.app`. Put the client ID in **two** places in
   `ios/App/App/Info.plist` (replace both `YOUR_IOS_CLIENT_ID` placeholders):
   `GIDClientID` = the client ID; and the reversed form
   `com.googleusercontent.apps.<CLIENT_NUMBER>` as a URL scheme.
3. **Server** — set `GOOGLE_IOS_CLIENT_ID` on the server to that iOS client ID
   so iOS ID tokens (whose audience is the iOS client) pass verification. Android
   tokens use the web client ID and already verify. Leave it blank and iOS simply
   falls back to the browser flow — nothing breaks.

Until steps 1–3 are done the apps build and run; sign-in transparently uses the
browser fallback.

### iOS capabilities (in Xcode, once)

Open the project (`npm run open:ios`), select the App target → *Signing &
Capabilities*:

- Add **Push Notifications**
- Add **Background Modes** → check *Remote notifications* (Info.plist already
  declares it; the capability adds the entitlement)
- Set your team for automatic signing

### App URL

`capacitor.config.ts` points the webview at `https://www.busydays.co`. Override
per build with `CAP_SERVER_URL`:

```bash
CAP_SERVER_URL=https://staging.busydays.co npx cap sync
```

### Icons & splash screens

Put a 1024×1024 `icon.png` and 2732×2732 `splash.png` in `mobile/assets/`, then:

```bash
npx @capacitor/assets generate
```

---

## 2. Day-to-day workflow

```bash
cd mobile
npx cap sync          # after changing capacitor.config.ts or updating plugins
npm run run:android   # build + run on connected device/emulator
npm run open:ios      # open Xcode, run from there
```

There is no web build step — the app content is the deployed site.

## 3. Release

### Android (Play Store)

1. Create an upload keystore (once): `keytool -genkey -v -keystore busydays.keystore -alias busydays -keyalg RSA -keysize 2048 -validity 10000`
   — **back it up; it is gitignored and unrecoverable**.
2. Android Studio → *Build → Generate Signed App Bundle* → `.aab`.
3. Play Console → create app → upload to Internal testing first; promote to
   Production after a test pass. Data-safety form: declare collection of
   email + booking/business data, encrypted in transit, not sold.

### iOS (App Store)

1. Xcode → *Product → Archive* → Distribute → App Store Connect.
2. TestFlight first; submit for review when the smoke tests below pass.
3. **Review notes**: Apple rejects bare website wrappers (guideline 4.2).
   This app registers for native push, uses native sign-in handoff, and is a
   business tool for a logged-in user base — say so in the notes, and provide a
   demo login (a seeded workspace) for the reviewer.

### Smoke test before every release

- [ ] Fresh install → "Get started with Google" → **native account sheet**
      appears in-app (no browser) → pick account → lands logged-in. New account
      → provisioned in-app; returning account → straight in.
- [ ] With native client IDs NOT yet configured → same button falls back to the
      system browser and still completes sign-in
- [ ] Settings → enable notifications → permission prompt → "✓ Notifications are on"
- [ ] Create a test lead (public booking page) → push arrives on the phone;
      tapping it opens the app on the dashboard
- [ ] Kill the app, reopen — still logged in (7-day rolling session)
- [ ] Airplane mode → open app → offline fallback page appears; Retry recovers

## 4. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Login button does nothing in app | `mobile-bridge.js` not loaded — check the `<script>` tag in `public/index.html` and that `Capacitor.isNativePlatform()` is true. |
| OAuth finishes but app doesn't resume | Deep-link scheme not registered — `busydays` intent-filter (AndroidManifest.xml) / CFBundleURLTypes (Info.plist). |
| Native sheet appears then errors, falls to browser | Android: SHA-1 + package not registered on the Android OAuth client (status code 10 = DEVELOPER_ERROR). iOS: `GIDClientID`/URL-scheme placeholders not replaced, or `GOOGLE_IOS_CLIENT_ID` unset on the server (token audience rejected). |
| iOS build fails on `GoogleSignIn` | Run `pod install` in `mobile/ios/App` after `cap sync` so the new pod resolves. |
| "Login link expired" | The one-time token is single-use with a 5-minute TTL — just sign in again. Repeated failures: check server clock and `mobile_login_tokens` table. |
| No push on Android | `google-services.json` missing from `android/app/`, or notification permission denied (Android 13+). |
| No push on iOS | Push capability not added in Xcode, APNs key not uploaded to Firebase, or `GoogleService-Info.plist` missing from the target. |
| Push works in debug, not in TestFlight | APNs environment mismatch — make sure the APNs **key** (not a dev cert) is uploaded to Firebase; keys cover both environments. |
| Blank screen on launch | `server.url` unreachable from the device, or the domain serves an invalid TLS cert. |

## 5. Server-side pieces (already implemented)

- `src/services/fcm.ts` — FCM HTTP v1 sender (service-account auth)
- `src/services/push.ts` — token registry + dual web/FCM fan-out with pruning
- `src/services/mobile-auth.ts` + `mobile_login_tokens` table — single-use,
  hashed, 5-minute login tokens
- `src/index.ts` — `/auth/google?mobile=1`, mobile callback page,
  `POST /api/auth/mobile/exchange`, `POST /api/push/register-device`,
  `POST /api/push/unregister-device`
- `public/mobile-bridge.js` — in-app glue (login interception, deep-link
  return, native push panel)

Env var to add in production: `FCM_SERVICE_ACCOUNT_JSON`.
