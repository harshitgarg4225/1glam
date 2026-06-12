import type { CapacitorConfig } from "@capacitor/cli";

// The shell loads the deployed web app directly — one codebase for web and
// mobile, and every server deploy updates the app instantly with no store
// review. Point CAP_SERVER_URL at a staging URL for test builds, or update
// the default when the app moves to a custom domain.
const SERVER_URL = process.env.CAP_SERVER_URL || "https://1glam-production.up.railway.app";

const config: CapacitorConfig = {
  appId: "in.busydays.app",
  appName: "BusyDays",
  // Bundled fallback page (mobile/www) — shown only if the remote app can't
  // load; it retries the connection.
  webDir: "www",
  server: {
    url: SERVER_URL,
    // The webview treats the remote origin as the app origin; cookies and
    // same-origin fetches to /api/* work exactly as in the browser.
    cleartext: false,
  },
  ios: {
    // Matches the deep-link scheme registered in Info.plist (busydays://).
    scheme: "BusyDays",
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: "#FAF8F5",
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
