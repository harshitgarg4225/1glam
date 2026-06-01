import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  APP_ENV: z.enum(["development", "staging", "production"]).optional(),
  NODE_ENV: z.string().optional(),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(8, "SESSION_SECRET must be at least 8 characters"),
  DATABASE_URL: z.string().optional().default(""),
  TOKEN_ENCRYPTION_KEY: z.string().optional().default(""),
  SENTRY_DSN: z.string().optional().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  GOOGLE_REDIRECT_PATH: z.string().default("/auth/google/callback"),
  GOOGLE_MAPS_API_KEY: z.string().optional().default(""),
  WATI_WEBHOOK_SECRET: z.string().optional().default(""),
  MANYCHAT_WEBHOOK_SECRET: z.string().optional().default(""),
  XAI_API_KEY: z.string().optional().default(""),
  XAI_MODEL: z.string().default("grok-4.20-reasoning"),
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
  GOOGLE_OAUTH_SCOPES: z
    .string()
    .default(
      [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/spreadsheets",
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
  databaseUrl: parsed.DATABASE_URL,
  tokenEncryptionKey: parsed.TOKEN_ENCRYPTION_KEY,
  sentryDsn: parsed.SENTRY_DSN,
  logLevel: parsed.LOG_LEVEL,
  googleClientId: parsed.GOOGLE_CLIENT_ID,
  googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
  googleRedirectPath: parsed.GOOGLE_REDIRECT_PATH,
  googleRedirectUrl: new URL(parsed.GOOGLE_REDIRECT_PATH, parsed.APP_BASE_URL).toString(),
  googleMapsApiKey: parsed.GOOGLE_MAPS_API_KEY,
  watiWebhookSecret: parsed.WATI_WEBHOOK_SECRET,
  manychatWebhookSecret: parsed.MANYCHAT_WEBHOOK_SECRET,
  xaiApiKey: parsed.XAI_API_KEY,
  xaiModel: parsed.XAI_MODEL,
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

// Throws a clear, actionable error if the deployed environment is misconfigured.
// Call this once at boot, before binding the port.
export function assertDeploymentConfig(): void {
  const errors = findDeploymentConfigErrors(appConfig);
  if (errors.length) {
    throw new Error(
      `Refusing to start in "${appConfig.appEnv}" with an unsafe configuration:\n` +
        errors.map((e) => `  • ${e}`).join("\n"),
    );
  }
}
