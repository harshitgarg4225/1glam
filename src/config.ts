import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(8, "SESSION_SECRET must be at least 8 characters"),
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

export const appConfig = {
  port: parsed.PORT,
  baseUrl: parsed.APP_BASE_URL,
  sessionSecret: parsed.SESSION_SECRET,
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
  leegalityApiKey: parsed.LEEGALITY_API_KEY,
  leegalityApiKeyHeader: parsed.LEEGALITY_API_KEY_HEADER,
  leegalityWebhookSecret: parsed.LEEGALITY_WEBHOOK_SECRET,
  googleScopes: parsed.GOOGLE_OAUTH_SCOPES.split(",").map((scope) => scope.trim()).filter(Boolean),
  workspaceDbPath: path.join(process.cwd(), "data", "workspaces.json"),
};
