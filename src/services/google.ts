import { google } from "googleapis";
import type { Credentials } from "google-auth-library";
import { appConfig } from "../config.js";
import type { GoogleProfile, StoredGoogleTokens } from "../types.js";

// Retry transient Google API failures (429 rate-limit, 5xx) with exponential
// backoff so a quota burst or a blip degrades gracefully instead of hard-failing
// a dashboard read or a calendar write. httpMethodsToRetry deliberately EXCLUDES
// POST, so non-idempotent Sheets appends (new lead/booking rows) are never
// retried — that would duplicate rows. GET reads and PUT updates are safe.
google.options({
  retry: true,
  retryConfig: {
    retry: 4,
    retryDelay: 300,
    httpMethodsToRetry: ["GET", "PUT", "HEAD", "OPTIONS", "DELETE"],
    statusCodesToRetry: [
      [429, 429],
      [500, 599],
    ],
  },
});

export function createOAuthClient() {
  return new google.auth.OAuth2(
    appConfig.googleClientId,
    appConfig.googleClientSecret,
    appConfig.googleRedirectUrl,
  );
}

export function getAuthUrl(extraScopes: string[] = [], state?: string) {
  const client = createOAuthClient();
  const scope = [...new Set([...appConfig.googleScopes, ...extraScopes])];
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope,
    // Keep previously granted scopes when asking for new ones, so adding
    // Business Profile access never drops Sheets/Calendar permissions.
    include_granted_scopes: true,
    // Round-trips through Google so the callback knows the flow's origin
    // (e.g. "mobile" → finish with a deep link instead of a redirect to /).
    ...(state ? { state } : {}),
  });
}

export async function exchangeCodeForTokens(code: string) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// Exchanges a one-time server auth code from the NATIVE Google Sign-In SDK
// (mobile app) for tokens. The SDK handled the redirect natively, so the
// exchange uses an empty redirect_uri rather than the web callback URL. This
// lets a first-time mobile user be provisioned without bouncing to a browser
// tab — provided the SDK requested offline access and the app's scopes.
export async function exchangeNativeAuthCode(serverAuthCode: string) {
  const client = new google.auth.OAuth2(
    appConfig.googleClientId,
    appConfig.googleClientSecret,
    "",
  );
  const { tokens } = await client.getToken({ code: serverAuthCode, redirect_uri: "" });
  return tokens;
}

export function createGoogleClients(tokens: Credentials) {
  const auth = createOAuthClient();
  auth.setCredentials(tokens);

  return {
    auth,
    oauth2: google.oauth2({ version: "v2", auth }),
    sheets: google.sheets({ version: "v4", auth }),
    calendar: google.calendar({ version: "v3", auth }),
    drive: google.drive({ version: "v3", auth }),
  };
}

export async function fetchGoogleProfile(tokens: Credentials): Promise<GoogleProfile> {
  const { oauth2 } = createGoogleClients(tokens);
  const response = await oauth2.userinfo.get();
  return {
    email: response.data.email ?? "",
    name: response.data.name ?? response.data.email ?? "Owner",
    picture: response.data.picture ?? undefined,
  };
}

export function normalizeStoredTokens(tokens: Credentials | StoredGoogleTokens): StoredGoogleTokens {
  return {
    access_token: tokens.access_token ?? undefined,
    refresh_token: tokens.refresh_token ?? undefined,
    scope: tokens.scope ?? undefined,
    token_type: tokens.token_type ?? undefined,
    expiry_date: tokens.expiry_date ?? null,
  };
}

export async function refreshStoredTokens(
  tokens: StoredGoogleTokens,
  onRefresh?: (tokens: StoredGoogleTokens) => Promise<void>,
) {
  const client = createOAuthClient();
  client.setCredentials(tokens);

  client.on("tokens", async (nextTokens) => {
    const merged = normalizeStoredTokens({
      ...tokens,
      ...nextTokens,
      refresh_token: nextTokens.refresh_token ?? tokens.refresh_token,
    });
    if (onRefresh) {
      await onRefresh(merged);
    }
  });

  const shouldRefresh =
    !tokens.access_token ||
    !tokens.expiry_date ||
    tokens.expiry_date <= Date.now() + 60_000;

  if (shouldRefresh && tokens.refresh_token) {
    const { credentials } = await client.refreshAccessToken();
    return normalizeStoredTokens({
      ...tokens,
      ...credentials,
      refresh_token: credentials.refresh_token ?? tokens.refresh_token,
    });
  }

  return normalizeStoredTokens(tokens);
}
