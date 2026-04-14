import { google } from "googleapis";
import type { Credentials } from "google-auth-library";
import { appConfig } from "../config.js";
import type { GoogleProfile, StoredGoogleTokens } from "../types.js";

export function createOAuthClient() {
  return new google.auth.OAuth2(
    appConfig.googleClientId,
    appConfig.googleClientSecret,
    appConfig.googleRedirectUrl,
  );
}

export function getAuthUrl() {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: appConfig.googleScopes,
  });
}

export async function exchangeCodeForTokens(code: string) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
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
