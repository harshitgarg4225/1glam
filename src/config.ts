import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  APP_ENV: z.enum(["development", "staging", "production"]).optional(),
  NODE_ENV: z.string().optional(),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(8),
  // Soft cap on NEW signups (0 = unlimited). Existing users always get in. Use
  // this to stay under Google's ~100-user cap for unverified sensitive scopes,
  // or to throttle a launch so provisioning doesn't stampede.
  MAX_WORKSPACES: z.coerce.number().int().min(0).optional().default(0),
  DATABASE_URL: z.string().optional().default(""),
  // Comma-separated emails allowed into the /admin control dashboard (manual
  // wallet top-ups, workspace overview). Empty = admin surface disabled.
  ADMIN_EMAILS: z.string().optional().default(""),
  // Platform support WhatsApp number (digits, with country code). When set,
  // artists get a one-tap "request a top-up" button in the Wallet tab.
  SUPPORT_WHATSAPP: z.string().optional().default(""),
  // Optional PEM CA bundle for the Postgres connection. When set, the pool
  // VERIFIES the server certificate against it (rejectUnauthorized: true) instead
  // of the encrypt-but-don't-verify default — closes an MITM gap to the DB.
  DATABASE_CA_CERT: z.string().optional().default(""),
  // Where operational data (leads, bookings, payments) lives. "sheets" keeps the
  // legacy Google-Sheets-as-datastore behavior; "dual" makes Postgres the source
  // of truth while best-effort mirroring to the artist's sheet (the safe cutover
  // mode); "postgres" is Postgres-only. "dual"/"postgres" require DATABASE_URL.
  OPERATIONAL_STORE: z.enum(["sheets", "dual", "postgres"]).optional().default("sheets"),
  TOKEN_ENCRYPTION_KEY: z.string().optional().default(""),
  SENTRY_DSN: z.string().optional().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  // iOS OAuth client ID (same GCP project). The iOS app's native Google
  // Sign-In mints ID tokens with THIS audience, so token verification must
  // accept it alongside the web client ID. Empty = iOS tokens rejected.
  GOOGLE_IOS_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_REDIRECT_PATH: z.string().default("/auth/google/callback"),
  GOOGLE_MAPS_API_KEY: z.string().optional().default(""),
  WATI_WEBHOOK_SECRET: z.string().optional().default(""),
  // Gupshup as the WhatsApp send pipe: an approved Meta BSP with pure
  // per-message pricing (no upfront/monthly fee) and self-serve signup — no
  // Meta app review on our side. When all three are set, outbound WhatsApp
  // falls back to Gupshup whenever no direct Meta credentials are available.
  GUPSHUP_API_KEY: z.string().optional().default(""),
  GUPSHUP_APP_NAME: z.string().optional().default(""),
  GUPSHUP_SOURCE_NUMBER: z.string().optional().default(""),
  // Shared secret for Gupshup's inbound message callback — set the callback URL
  // in the Gupshup dashboard to /webhooks/gupshup?token=<this>. Empty disables
  // the inbound webhook entirely.
  GUPSHUP_WEBHOOK_SECRET: z.string().optional().default(""),
  MANYCHAT_WEBHOOK_SECRET: z.string().optional().default(""),
  XAI_API_KEY: z.string().optional().default(""),
  XAI_MODEL: z.string().default("grok-4.20-reasoning"),
  // Google Business Profile API is allowlist-gated (zero quota by default).
  // Flip to "1" only after the GCP project is approved AND artists grant the
  // business.manage scope — until then the GMB agent runs in assisted mode.
  GMB_API_ENABLED: z.string().optional().default(""),
  // Razorpay credits wallet. Test keys (rzp_test_...) until you go live.
  RAZORPAY_KEY_ID: z.string().optional().default(""),
  RAZORPAY_KEY_SECRET: z.string().optional().default(""),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(""),
  // When "1", metered actions (messages, AI) are blocked once credits run out.
  // Default off: usage is still tracked, but nothing is blocked — so existing
  // workspaces are never cut off before you intentionally turn billing on.
  BILLING_ENFORCED: z.string().optional().default(""),
  META_APP_ID: z.string().optional().default(""),
  META_APP_SECRET: z.string().optional().default(""),
  META_REDIRECT_PATH: z.string().default("/auth/meta/callback"),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional().default(""),
  META_INSTAGRAM_CONFIG_ID: z.string().optional().default(""),
  META_WHATSAPP_CONFIG_ID: z.string().optional().default(""),
  WA_PHONE_NUMBER_ID: z.string().optional().default(""),
  WA_BUSINESS_ACCOUNT_ID: z.string().optional().default(""),
  WA_ACCESS_TOKEN: z.string().optional().default(""),
  LEEGALITY_CREATE_URL: z
    .string()
    .default("https://app1.leegality.com/api/v3.0/sign/request"),
  LEEGALITY_DETAILS_URL: z.string().optional().default(""),
  LEEGALITY_API_KEY: z.string().optional().default(""),
  LEEGALITY_API_KEY_HEADER: z.string().default("X-Auth-Token"),
  LEEGALITY_WEBHOOK_SECRET: z.string().optional().default(""),
  // Web push (PWA notifications). Generate once with: npx web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: z.string().optional().default(""),
  VAPID_PRIVATE_KEY: z.string().optional().default(""),
  // Native push (iOS/Android app via FCM). Paste the Firebase service-account
  // JSON (raw or base64) from Project Settings → Service accounts. Optional —
  // without it the app silently skips native push and web push still works.
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional().default(""),
  GOOGLE_OAUTH_SCOPES: z
    .string()
    .default(
      [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        // No auth/spreadsheets: the Sheets API accepts drive.file for files
        // the app itself created — which is our only Sheets usage (the one
        // workspace sheet we provision). Dropping the sensitive scope was
        // requested by Google verification and leaves calendar as the only
        // sensitive scope. Tokens granted earlier keep their wider scopes.
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/drive.file",
      ].join(","),
    ),
});

const parsed = envSchema.parse(process.env);

// Resolve the deployment environment. Prefer the explicit APP_ENV; fall back to
// NODE_ENV ("production" → production), else development. "staging" and
// "production" are both treated as deployed environments that require full config.
function resolveAppEnv(): "development" | "staging" | "production" {
  if (parsed.APP_ENV) return parsed.APP_ENV;
  if (parsed.NODE_ENV === "production") return "production";
  if (parsed.NODE_ENV === "staging") return "staging";
  return "development";
}

const appEnv = resolveAppEnv();

export const appConfig = {
  appEnv,
  isDeployed: appEnv === "staging" || appEnv === "production",
  port: parsed.PORT,
  baseUrl: parsed.APP_BASE_URL,
  sessionSecret: parsed.SESSION_SECRET,
  maxWorkspaces: parsed.MAX_WORKSPACES,
  databaseUrl: parsed.DATABASE_URL,
  databaseCaCert: parsed.DATABASE_CA_CERT,
  adminEmails: parsed.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  supportWhatsApp: parsed.SUPPORT_WHATSAPP.replace(/\D/g, ""),
  // "dual"/"postgres" only take effect when a database is configured; otherwise
  // we transparently stay on the Sheets path (see operational-store.ts).
  operationalStore: parsed.OPERATIONAL_STORE,
  tokenEncryptionKey: parsed.TOKEN_ENCRYPTION_KEY,
  sentryDsn: parsed.SENTRY_DSN,
  logLevel: parsed.LOG_LEVEL,
  googleClientId: parsed.GOOGLE_CLIENT_ID,
  googleIosClientId: parsed.GOOGLE_IOS_CLIENT_ID,
  googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
  googleRedirectPath: parsed.GOOGLE_REDIRECT_PATH,
  googleRedirectUrl: new URL(parsed.GOOGLE_REDIRECT_PATH, parsed.APP_BASE_URL).toString(),
  googleMapsApiKey: parsed.GOOGLE_MAPS_API_KEY,
  watiWebhookSecret: parsed.WATI_WEBHOOK_SECRET,
  gupshupApiKey: parsed.GUPSHUP_API_KEY,
  gupshupAppName: parsed.GUPSHUP_APP_NAME,
  gupshupSourceNumber: parsed.GUPSHUP_SOURCE_NUMBER.replace(/\D/g, ""),
  gupshupWebhookSecret: parsed.GUPSHUP_WEBHOOK_SECRET,
  manychatWebhookSecret: parsed.MANYCHAT_WEBHOOK_SECRET,
  xaiApiKey: parsed.XAI_API_KEY,
  xaiModel: parsed.XAI_MODEL,
  gmbApiEnabled: parsed.GMB_API_ENABLED === "1" || parsed.GMB_API_ENABLED === "true",
  razorpayKeyId: parsed.RAZORPAY_KEY_ID,
  razorpayKeySecret: parsed.RAZORPAY_KEY_SECRET,
  razorpayWebhookSecret: parsed.RAZORPAY_WEBHOOK_SECRET,
  billingEnforced: parsed.BILLING_ENFORCED === "1" || parsed.BILLING_ENFORCED === "true",
  metaAppId: parsed.META_APP_ID,
  metaAppSecret: parsed.META_APP_SECRET,
  metaRedirectPath: parsed.META_REDIRECT_PATH,
  metaRedirectUrl: new URL(parsed.META_REDIRECT_PATH, parsed.APP_BASE_URL).toString(),
  metaWebhookVerifyToken: parsed.META_WEBHOOK_VERIFY_TOKEN,
  metaInstagramConfigId: parsed.META_INSTAGRAM_CONFIG_ID,
  metaWhatsappConfigId: parsed.META_WHATSAPP_CONFIG_ID,
  waPhoneNumberId: parsed.WA_PHONE_NUMBER_ID,
  waBusinessAccountId: parsed.WA_BUSINESS_ACCOUNT_ID,
  waAccessToken: parsed.WA_ACCESS_TOKEN,
  leegalityCreateUrl: parsed.LEEGALITY_CREATE_URL,
  leegalityDetailsUrl: parsed.LEEGALITY_DETAILS_URL,
  leegalityApiKey: parsed.LEEGALITY_API_KEY,
  leegalityApiKeyHeader: parsed.LEEGALITY_API_KEY_HEADER,
  leegalityWebhookSecret: parsed.LEEGALITY_WEBHOOK_SECRET,
  googleScopes: parsed.GOOGLE_OAUTH_SCOPES.split(",").map((scope) => scope.trim()).filter(Boolean),
  vapidPublicKey: parsed.VAPID_PUBLIC_KEY,
  vapidPrivateKey: parsed.VAPID_PRIVATE_KEY,
  fcmServiceAccountJson: parsed.FCM_SERVICE_ACCOUNT_JSON,
  workspaceDbPath: path.join(process.cwd(), "data", "workspaces.json"),
};

// Pure guard used at boot. In a deployed environment (staging/production) we must
// NOT silently fall back to the ephemeral JSON file or store tokens in plaintext —
// a missing DATABASE_URL would mean data loss on the next container restart, and a
// missing TOKEN_ENCRYPTION_KEY would leave OAuth tokens unencrypted at rest.
// Returns the list of fatal problems (empty = ok) so it's trivially testable.
export function findDeploymentConfigErrors(cfg: {
  appEnv: string;
  databaseUrl: string;
  tokenEncryptionKey: string;
}): string[] {
  const errors: string[] = [];
  const deployed = cfg.appEnv === "staging" || cfg.appEnv === "production";
  if (!deployed) return errors;

  if (!cfg.databaseUrl) {
    errors.push(
      "DATABASE_URL is required in staging/production — without it the app would store data on an ephemeral disk and lose everything on restart.",
    );
  }
  if (!cfg.tokenEncryptionKey) {
    errors.push(
      "TOKEN_ENCRYPTION_KEY is required in staging/production — without it Google/Meta OAuth tokens would be stored unencrypted at rest.",
    );
  }
  return errors;
}

// Validates configuration at boot. In PRODUCTION these are fatal — we refuse to
// start with a misconfiguration that would silently lose data, store OAuth tokens
// in plaintext, or sign sessions/documents with a weak secret. In staging/dev we
// only warn, so local work and previews stay frictionless.
export function assertDeploymentConfig(): void {
  const errors = findDeploymentConfigErrors(appConfig);
  if (appConfig.sessionSecret.length < 32) {
    errors.push(
      "SESSION_SECRET must be at least 32 characters — it signs session cookies and document URLs. Generate one with: openssl rand -base64 32",
    );
  }
  // Without Google OAuth credentials no one can sign in — the entire product is
  // gated behind "Sign in with Google". Fatal in a deployed environment.
  if (appConfig.isDeployed && (!appConfig.googleClientId || !appConfig.googleClientSecret)) {
    errors.push(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required — without them the 'Sign in with Google' flow returns an error and no one can log in.",
    );
  }

  // Non-fatal heads-up: the Google consent screen and all app links use the
  // APP_BASE_URL host. If that's still the platform's auto-generated domain
  // (e.g. *.up.railway.app), users see THAT on the OAuth screen instead of your
  // brand domain. Point APP_BASE_URL at your custom domain and register its
  // /auth/google/callback as an authorized redirect URI.
  if (appConfig.isDeployed && /\.(up\.railway\.app|onrender\.com|herokuapp\.com|fly\.dev|vercel\.app)$/i.test(new URL(appConfig.baseUrl).hostname)) {
    console.warn(
      `[config] APP_BASE_URL is "${appConfig.baseUrl}" — the Google sign-in screen and your app links will show this host, not your brand domain. ` +
        "Set APP_BASE_URL to your custom domain (e.g. https://busydays.co) and add <domain>/auth/google/callback as an authorized redirect URI in the OAuth client.",
    );
  }

  // Non-fatal heads-up (not fatal — we won't brick a running deploy whose key is
  // already short): TOKEN_ENCRYPTION_KEY is stretched with bare SHA-256, so its
  // own entropy is the encryption floor. A short/guessable key is brute-forceable
  // against a DB leak. Use 32+ random bytes (openssl rand -base64 32).
  if (appConfig.isDeployed && appConfig.tokenEncryptionKey && appConfig.tokenEncryptionKey.length < 32) {
    console.warn(
      "[config] TOKEN_ENCRYPTION_KEY is shorter than 32 characters — it's the encryption floor for OAuth tokens at rest. Rotate to 32+ random bytes (openssl rand -base64 32).",
    );
  }

  if (!errors.length) return;

  const summary =
    `Configuration problems detected in "${appConfig.appEnv}":\n` +
    errors.map((e) => `  • ${e}`).join("\n");

  if (appConfig.appEnv === "production") {
    // Fail fast — never serve traffic from a misconfigured production instance.
    throw new Error(summary);
  }
  console.warn(`[config] ${summary}`);
}
