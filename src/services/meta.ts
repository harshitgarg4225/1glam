import crypto from "node:crypto";
import { fetchWithTimeout } from "./http.js";
import { appConfig } from "../config.js";
import type { MetaChannel, MetaChannelConnection } from "../types.js";

const INSTAGRAM_LOGIN_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
];

const INSTAGRAM_SCOPES = [
  "pages_show_list",
  "pages_manage_metadata",
  "instagram_basic",
  "instagram_manage_messages",
  "business_management",
];

const WHATSAPP_SCOPES = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
  "business_management",
];

export function getMetaConnectUrl(input: { workspaceEmail: string; channel: MetaChannel }) {
  if (!appConfig.metaAppId) {
    throw new Error("META_APP_ID is not configured");
  }

  const url = new URL("https://www.facebook.com/v23.0/dialog/oauth");
  url.searchParams.set("client_id", appConfig.metaAppId);
  url.searchParams.set("redirect_uri", appConfig.metaRedirectUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", encodeState(input));

  const configurationId =
    input.channel === "instagram"
      ? appConfig.metaInstagramConfigId
      : appConfig.metaWhatsappConfigId;

  // Meta Business Login prefers configuration_id-based auth for business asset onboarding.
  if (configurationId) {
    url.searchParams.set("config_id", configurationId);
  } else {
    // Fallback for development only. Raw scopes may not work for all Meta business login setups.
    url.searchParams.set("scope", getMetaScopes(input.channel).join(","));
  }

  return url.toString();
}

export async function exchangeMetaCode(code: string) {
  if (!appConfig.metaAppId || !appConfig.metaAppSecret) {
    throw new Error("Meta app credentials are not configured");
  }

  const url = new URL("https://graph.facebook.com/v23.0/oauth/access_token");
  url.searchParams.set("client_id", appConfig.metaAppId);
  url.searchParams.set("client_secret", appConfig.metaAppSecret);
  url.searchParams.set("redirect_uri", appConfig.metaRedirectUrl);
  url.searchParams.set("code", code);

  const response = await fetchWithTimeout(url.toString());
  if (!response.ok) {
    throw new Error("Meta token exchange failed");
  }

  return (await response.json()) as {
    access_token: string;
    token_type?: string;
    expires_in?: number;
  };
}

// Short-lived user tokens (~1h) must be swapped for long-lived ones (~60d)
// before we store them, otherwise outbound sends start failing within the hour.
export async function exchangeForLongLivedToken(shortLivedToken: string) {
  if (!appConfig.metaAppId || !appConfig.metaAppSecret) {
    throw new Error("Meta app credentials are not configured");
  }

  const url = new URL("https://graph.facebook.com/v23.0/oauth/access_token");
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appConfig.metaAppId);
  url.searchParams.set("client_secret", appConfig.metaAppSecret);
  url.searchParams.set("fb_exchange_token", shortLivedToken);

  const response = await fetchWithTimeout(url.toString());
  if (!response.ok) {
    throw new Error(`Long-lived token exchange failed: ${await response.text()}`);
  }

  return (await response.json()) as {
    access_token: string;
    token_type?: string;
    expires_in?: number;
  };
}

// Meta validates X-Hub-Signature-256 against the raw request body. Without this,
// anyone who learns the webhook URL can inject fabricated leads and messages.
export function verifyMetaWebhookSignature(rawBody: Buffer | undefined, signatureHeader?: string) {
  if (!appConfig.metaAppSecret) {
    return false;
  }
  if (!rawBody || !signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const expected = crypto
    .createHmac("sha256", appConfig.metaAppSecret)
    .update(rawBody)
    .digest();

  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

// Inbound webhooks only flow once the app is explicitly subscribed to the asset.
export async function subscribePageToWebhooks(pageId: string, pageAccessToken: string) {
  const url = new URL(`https://graph.facebook.com/v23.0/${pageId}/subscribed_apps`);
  url.searchParams.set("subscribed_fields", "messages,messaging_postbacks,message_reactions");
  url.searchParams.set("access_token", pageAccessToken);
  url.searchParams.set("appsecret_proof", buildAppSecretProof(pageAccessToken));

  const response = await fetchWithTimeout(url.toString(), { method: "POST" });
  if (!response.ok) {
    throw new Error(`Page webhook subscription failed: ${await response.text()}`);
  }
  return (await response.json()) as { success?: boolean };
}

export async function subscribeWabaToWebhooks(wabaId: string, accessToken: string) {
  const url = new URL(`https://graph.facebook.com/v23.0/${wabaId}/subscribed_apps`);
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("appsecret_proof", buildAppSecretProof(accessToken));

  const response = await fetchWithTimeout(url.toString(), { method: "POST" });
  if (!response.ok) {
    throw new Error(`WABA webhook subscription failed: ${await response.text()}`);
  }
  return (await response.json()) as { success?: boolean };
}

export function buildAppSecretProof(accessToken: string) {
  if (!appConfig.metaAppSecret) {
    return "";
  }
  return crypto
    .createHmac("sha256", appConfig.metaAppSecret)
    .update(accessToken)
    .digest("hex");
}

export async function fetchMetaConnectionProfile(input: {
  accessToken: string;
  channel: MetaChannel;
}): Promise<MetaChannelConnection> {
  const [me, pages] = await Promise.all([
    graphGet("me?fields=id,name", input.accessToken),
    graphGet(
      "me/accounts?fields=id,name,access_token,instagram_business_account{id,username}",
      input.accessToken,
    ),
  ]);

  const firstPage = Array.isArray(pages?.data)
    ? (pages.data[0] as Record<string, unknown> | undefined)
    : undefined;
  const firstInstagram = firstPage?.instagram_business_account as
    | Record<string, unknown>
    | undefined;

  return {
    channel: input.channel,
    status: "connected",
    connectedAt: new Date().toISOString(),
    metaUserId: String(me?.id ?? ""),
    metaUserName: String(me?.name ?? ""),
    accessToken: input.accessToken,
    pageAccessToken:
      typeof firstPage?.access_token === "string" ? firstPage.access_token : undefined,
    tokenExpiresAt: null,
    scopes: getMetaScopes(input.channel),
    pageId: typeof firstPage?.id === "string" ? firstPage.id : undefined,
    pageName: typeof firstPage?.name === "string" ? firstPage.name : undefined,
    instagramBusinessAccountId:
      typeof firstInstagram?.id === "string" ? firstInstagram.id : undefined,
    instagramUsername:
      typeof firstInstagram?.username === "string" ? firstInstagram.username : undefined,
    dataIsolationKey: crypto
      .createHash("sha256")
      .update(`${input.channel}:${String(me?.id ?? "")}:${String(firstPage?.id ?? "")}`)
      .digest("hex"),
  };
}

export async function fetchInstagramLoginConnectionProfile(
  accessToken: string,
): Promise<MetaChannelConnection> {
  const me = await instagramGraphGet(
    "me?fields=id,user_id,username,name,account_type,profile_picture_url",
    accessToken,
  );
  const profile = Array.isArray(me?.data) ? me.data[0] : me;
  if (!profile || (typeof profile !== "object")) {
    throw new Error("Instagram token lookup failed");
  }

  const appScopedId = normalizeStringValue(profile.id);
  const professionalAccountId = normalizeStringValue(profile.user_id) || appScopedId;
  const username = typeof profile.username === "string" ? profile.username : "";
  const displayName =
    typeof profile.name === "string" && profile.name.trim().length > 0
      ? profile.name
      : username;

  if (!professionalAccountId || !username) {
    throw new Error("Instagram account details are incomplete");
  }

  return {
    channel: "instagram",
    status: "connected",
    connectedAt: new Date().toISOString(),
    metaUserId: appScopedId || professionalAccountId,
    metaUserName: displayName,
    accessToken,
    tokenExpiresAt: null,
    scopes: INSTAGRAM_LOGIN_SCOPES,
    instagramBusinessAccountId: professionalAccountId,
    instagramUsername: username,
    dataIsolationKey: crypto
      .createHash("sha256")
      .update(`instagram-login:${professionalAccountId}`)
      .digest("hex"),
  };
}

export async function fetchWhatsAppCloudConnectionProfile(input: {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
}): Promise<MetaChannelConnection> {
  const [phoneNumber, businessAccount] = await Promise.all([
    graphGet(`${input.phoneNumberId}?fields=id,display_phone_number,verified_name`, input.accessToken),
    graphGet(`${input.wabaId}?fields=id,name`, input.accessToken),
  ]);

  const phoneNumberId =
    normalizeStringValue(phoneNumber?.id) || input.phoneNumberId;
  const businessName =
    normalizeStringValue(businessAccount?.name) ||
    normalizeStringValue(phoneNumber?.verified_name) ||
    "WhatsApp Test Number";
  const displayPhone = normalizeStringValue(phoneNumber?.display_phone_number);

  return {
    channel: "whatsapp",
    status: "connected",
    connectedAt: new Date().toISOString(),
    metaUserId: normalizeStringValue(businessAccount?.id) || input.wabaId,
    metaUserName: businessName,
    accessToken: input.accessToken,
    tokenExpiresAt: null,
    scopes: WHATSAPP_SCOPES,
    wabaId: input.wabaId,
    phoneNumberId,
    businessAccountName: displayPhone ? `${businessName} (${displayPhone})` : businessName,
    dataIsolationKey: crypto
      .createHash("sha256")
      .update(`whatsapp:${input.wabaId}:${phoneNumberId}`)
      .digest("hex"),
  };
}

export function verifyMetaWebhook(mode?: string, token?: string, challenge?: string) {
  return (
    mode === "subscribe" &&
    token &&
    appConfig.metaWebhookVerifyToken &&
    token === appConfig.metaWebhookVerifyToken
      ? challenge ?? ""
      : null
  );
}

export function parseMetaState(state: string) {
  const decoded = Buffer.from(state, "base64url").toString("utf8");
  const parsed = JSON.parse(decoded) as { workspaceEmail: string; channel: MetaChannel };
  if (!parsed.workspaceEmail || !parsed.channel) {
    throw new Error("Invalid Meta state");
  }
  return parsed;
}

export function verifyAndParseMetaSignedRequest(signedRequest: string) {
  if (!appConfig.metaAppSecret) {
    throw new Error("META_APP_SECRET is not configured");
  }

  const [encodedSignature, payload] = signedRequest.split(".");
  if (!encodedSignature || !payload) {
    throw new Error("Invalid signed request");
  }

  const expected = crypto
    .createHmac("sha256", appConfig.metaAppSecret)
    .update(payload)
    .digest();
  const provided = base64UrlDecode(encodedSignature);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    throw new Error("Signed request verification failed");
  }

  return JSON.parse(base64UrlDecode(payload).toString("utf8")) as {
    user_id?: string;
    algorithm?: string;
  };
}

function encodeState(input: { workspaceEmail: string; channel: MetaChannel }) {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

function getMetaScopes(channel: MetaChannel) {
  return channel === "instagram" ? INSTAGRAM_SCOPES : WHATSAPP_SCOPES;
}

async function graphGet(path: string, accessToken: string) {
  const url = new URL(`https://graph.facebook.com/v23.0/${path}`);
  url.searchParams.set("access_token", accessToken);
  const proof = buildAppSecretProof(accessToken);
  if (proof) {
    url.searchParams.set("appsecret_proof", proof);
  }
  const response = await fetchWithTimeout(url.toString());
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as Record<string, unknown>;
}

async function instagramGraphGet(path: string, accessToken: string) {
  const url = new URL(`https://graph.instagram.com/${path}`);
  url.searchParams.set("access_token", accessToken);
  const response = await fetchWithTimeout(url.toString());
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Instagram token lookup failed: ${message}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function base64UrlDecode(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64");
}

function normalizeStringValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}
