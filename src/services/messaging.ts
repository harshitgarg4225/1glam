import { appConfig } from "../config.js";
import { fetchWithTimeout } from "./http.js";
import { buildAppSecretProof } from "./meta.js";
import { meterUsage } from "./wallet.js";
import type { MetaChannelConnection, WorkspaceRecord } from "../types.js";

// Actually dispatches the message to the channel. No metering here so the two
// public senders below can each meter exactly once without double-counting.
async function dispatchChannelMessage(input: {
  connection: MetaChannelConnection;
  channel: "Instagram" | "WhatsApp";
  actorId: string;
  message: string;
  imageUrl?: string;
}) {
  if (input.channel === "Instagram") {
    return sendInstagramMessage(input.connection, input.actorId, input.message, input.imageUrl);
  }
  return sendWhatsAppMessage(input.connection, input.actorId, input.message, input.imageUrl);
}

export async function sendChannelMessage(input: {
  workspace: WorkspaceRecord;
  connection: MetaChannelConnection;
  channel: "Instagram" | "WhatsApp";
  actorId: string;
  message: string;
  imageUrl?: string;
}) {
  const result = await dispatchChannelMessage(input);
  await meterUsage(
    input.workspace.email,
    input.channel === "Instagram" ? "instagramMessage" : "whatsappMessage",
  );
  return result;
}

// Sends an owner-initiated message the WhatsApp-compliant way. Business-initiated
// WhatsApp messages outside the 24-hour customer-care window MUST use a
// pre-approved template — so when a template is configured for this message type
// we send through it. We fall back to free text only when no template is set
// (still valid inside the 24h window) or on Instagram, where templates don't apply.
export async function sendBusinessMessage(input: {
  workspace: WorkspaceRecord;
  connection: MetaChannelConnection;
  channel: "Instagram" | "WhatsApp";
  actorId: string;
  message: string;
  template?: { name?: string; lang?: string; params: string[] };
}): Promise<{ via: "template" | "freetext" }> {
  const templateName = String(input.template?.name || "").trim();
  if (input.channel === "WhatsApp" && templateName) {
    const phone = String(input.actorId).replace(/[^\d]/g, "");
    await sendWhatsAppTemplate(
      { accessToken: input.connection.accessToken, phoneNumberId: input.connection.phoneNumberId },
      phone,
      templateName,
      String(input.template?.lang || "en"),
      input.template?.params ?? [],
    );
    await meterUsage(input.workspace.email, "whatsappMessage");
    return { via: "template" };
  }

  await dispatchChannelMessage({
    connection: input.connection,
    channel: input.channel,
    actorId: input.actorId,
    message: input.message,
  });
  await meterUsage(
    input.workspace.email,
    input.channel === "Instagram" ? "instagramMessage" : "whatsappMessage",
  );
  return { via: "freetext" };
}

async function sendInstagramMessage(
  connection: MetaChannelConnection,
  recipientId: string,
  message: string,
  imageUrl?: string,
) {
  // Instagram messages carry either text or an attachment, not both — when an
  // image is included it goes first, followed by the caption as its own message.
  const payloads: Array<Record<string, unknown>> = [];
  if (imageUrl) {
    payloads.push({ attachment: { type: "image", payload: { url: imageUrl } } });
  }
  if (message) {
    payloads.push({ text: message });
  }
  if (!payloads.length) throw new Error("Nothing to send");

  // Business Login (Facebook) connections send through the Graph API using the
  // page token; direct Instagram Login connections use the Instagram Graph host.
  if (connection.pageAccessToken && connection.instagramBusinessAccountId) {
    const url = new URL(
      `https://graph.facebook.com/v23.0/${connection.instagramBusinessAccountId}/messages`,
    );
    url.searchParams.set("access_token", connection.pageAccessToken);
    const proof = buildAppSecretProof(connection.pageAccessToken);
    if (proof) {
      url.searchParams.set("appsecret_proof", proof);
    }

    let last: unknown;
    for (const msg of payloads) {
      const response = await fetchWithTimeout(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: recipientId }, message: msg }),
      });
      if (!response.ok) {
        throw new Error(`Instagram send failed: ${await response.text()}`);
      }
      last = await response.json();
    }
    return last;
  }

  if (!connection.accessToken) {
    throw new Error("Instagram access token is missing");
  }

  let last: unknown;
  for (const msg of payloads) {
    const response = await fetchWithTimeout("https://graph.instagram.com/v25.0/me/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.accessToken}`,
      },
      body: JSON.stringify({ recipient: { id: recipientId }, message: msg }),
    });
    if (!response.ok) {
      throw new Error(`Instagram send failed: ${await response.text()}`);
    }
    last = await response.json();
  }
  return last;
}

// Which pipe an outbound WhatsApp goes through. Direct Meta credentials
// (workspace connection or env) win; otherwise Gupshup — a Meta BSP with pure
// per-message pricing whose API needs NO Meta app review on our side — carries
// the send; null means neither is configured (callers fall back to wa.me
// links). Pure for testability.
export function resolveWaTransport(input: {
  connectionToken?: string;
  connectionPhoneId?: string;
  envToken?: string;
  envPhoneId?: string;
  gupshupKey?: string;
  gupshupApp?: string;
  gupshupSource?: string;
}): "meta" | "gupshup" | null {
  const token = input.connectionToken || input.envToken;
  const phoneId = input.connectionPhoneId || input.envPhoneId;
  if (token && phoneId) return "meta";
  if (input.gupshupKey && input.gupshupApp && input.gupshupSource) return "gupshup";
  return null;
}

function gupshupTransportInput() {
  return {
    gupshupKey: appConfig.gupshupApiKey,
    gupshupApp: appConfig.gupshupAppName,
    gupshupSource: appConfig.gupshupSourceNumber,
  };
}

async function postGupshup(path: string, form: Record<string, string>) {
  const response = await fetchWithTimeout(`https://api.gupshup.io/wa/api/v1/${path}`, {
    method: "POST",
    headers: { apikey: appConfig.gupshupApiKey, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      channel: "whatsapp",
      source: appConfig.gupshupSourceNumber,
      "src.name": appConfig.gupshupAppName,
      ...form,
    }).toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as { status?: unknown; message?: unknown };
  // Gupshup can 200 with status:"error" (bad template id, opted-out number…).
  if (!response.ok || payload.status === "error") {
    throw new Error(`WhatsApp send failed (Gupshup): ${payload.message || response.status}`);
  }
  return payload;
}

// Gupshup template send. Templates are created in the Gupshup dashboard and
// referenced by their template ID — put that ID in the app's template-name
// settings fields when running on Gupshup. Params are positional, matching ours.
function sendGupshupTemplate(recipientPhone: string, templateId: string, bodyParams: string[]) {
  return postGupshup("template/msg", {
    destination: recipientPhone.replace(/\D/g, ""),
    template: JSON.stringify({ id: templateId, params: bodyParams }),
  });
}

// Free-text (session) send — valid inside WhatsApp's 24h customer-service
// window, which is when we use free-text (replies to an inbound conversation).
function sendGupshupSessionMessage(recipientPhone: string, message: string, imageUrl?: string) {
  return postGupshup("msg", {
    destination: recipientPhone.replace(/\D/g, ""),
    message: JSON.stringify(
      imageUrl
        ? { type: "image", originalUrl: imageUrl, previewUrl: imageUrl, ...(message ? { caption: message } : {}) }
        : { type: "text", text: message },
    ),
  });
}

export async function sendWhatsAppTemplate(
  connection: { accessToken?: string; phoneNumberId?: string },
  recipientPhone: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[],
) {
  const transport = resolveWaTransport({
    connectionToken: connection.accessToken,
    connectionPhoneId: connection.phoneNumberId,
    envToken: appConfig.waAccessToken,
    envPhoneId: appConfig.waPhoneNumberId,
    ...gupshupTransportInput(),
  });
  if (transport === "gupshup") {
    return sendGupshupTemplate(recipientPhone, templateName, bodyParams);
  }
  const accessToken = connection.accessToken || appConfig.waAccessToken;
  const phoneNumberId = connection.phoneNumberId || appConfig.waPhoneNumberId;
  if (!accessToken || !phoneNumberId) {
    throw new Error("WhatsApp sender is not configured");
  }

  const url = new URL(`https://graph.facebook.com/v23.0/${phoneNumberId}/messages`);
  const proof = buildAppSecretProof(accessToken);
  if (proof) {
    url.searchParams.set("appsecret_proof", proof);
  }

  const components = bodyParams.length
    ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }]
    : [];

  const response = await fetchWithTimeout(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipientPhone,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode || "en" },
        components,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`WhatsApp template send failed: ${await response.text()}`);
  }

  return response.json();
}

async function sendWhatsAppMessage(
  connection: MetaChannelConnection,
  recipientPhone: string,
  message: string,
  imageUrl?: string,
) {
  const transport = resolveWaTransport({
    connectionToken: connection.accessToken,
    connectionPhoneId: connection.phoneNumberId,
    envToken: appConfig.waAccessToken,
    envPhoneId: appConfig.waPhoneNumberId,
    ...gupshupTransportInput(),
  });
  if (transport === "gupshup") {
    return sendGupshupSessionMessage(recipientPhone, message, imageUrl);
  }
  const accessToken = connection.accessToken || appConfig.waAccessToken;
  const phoneNumberId = connection.phoneNumberId || appConfig.waPhoneNumberId;
  if (!accessToken || !phoneNumberId) {
    throw new Error("WhatsApp sender is not configured");
  }

  const url = new URL(`https://graph.facebook.com/v23.0/${phoneNumberId}/messages`);
  const proof = buildAppSecretProof(accessToken);
  if (proof) {
    url.searchParams.set("appsecret_proof", proof);
  }

  // WhatsApp supports an image with its caption in a single message.
  const body = imageUrl
    ? {
        messaging_product: "whatsapp",
        to: recipientPhone,
        type: "image",
        image: { link: imageUrl, ...(message ? { caption: message } : {}) },
      }
    : {
        messaging_product: "whatsapp",
        to: recipientPhone,
        type: "text",
        text: { body: message },
      };

  const response = await fetchWithTimeout(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`WhatsApp send failed: ${await response.text()}`);
  }

  return response.json();
}
