# BusyDays mobile (iOS + Android)

Native shell around the deployed BusyDays web app, built with
[Capacitor](https://capacitorjs.com). The webview loads the production site
directly (`server.url` in `capacitor.config.ts`), so **the web app is the app**
— every server deploy updates mobile instantly, with no store re-submission.

The shell adds the two things a webview can't do alone:

| Capability | How |
|---|---|
| **Native push** | FCM device tokens, registered via `POST /api/push/register-device`; the server fans out every notification to web-push *and* FCM (`src/services/push.ts` + `src/services/fcm.ts`). |
| **Google sign-in** | Google blocks OAuth in webviews, so login opens the **system browser** (`/auth/google?mobile=1`), and the callback deep-links back with a single-use token (`busydays://auth?ott=…`) that the webview exchanges for a session (`POST /api/auth/mobile/exchange`). |

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

### iOS capabilities (in Xcode, once)

Open the project (`npm run open:ios`), select the App target → *Signing &
Capabilities*:

- Add **Push Notifications**
- Add **Background Modes** → check *Remote notifications* (Info.plist already
  declares it; the capability adds the entitlement)
- Set your team for automatic signing

### App URL

`capacitor.config.ts` points the webview at `https://busydays.in`. Override per
build with `CAP_SERVER_URL`:

```bash
CAP_SERVER_URL=https://staging.busydays.in npx cap sync
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

- [ ] Fresh install → "Get started with Google" → system browser opens →
      finish OAuth → app returns automatically and lands logged-in
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
