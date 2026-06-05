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
}) {
  if (input.channel === "Instagram") {
    return sendInstagramMessage(input.connection, input.actorId, input.message);
  }
  return sendWhatsAppMessage(input.connection, input.actorId, input.message);
}

export async function sendChannelMessage(input: {
  workspace: WorkspaceRecord;
  connection: MetaChannelConnection;
  channel: "Instagram" | "WhatsApp";
  actorId: string;
  message: string;
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
) {
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

    const response = await fetchWithTimeout(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: message },
      }),
    });

    if (!response.ok) {
      throw new Error(`Instagram send failed: ${await response.text()}`);
    }
    return response.json();
  }

  if (!connection.accessToken) {
    throw new Error("Instagram access token is missing");
  }

  const response = await fetchWithTimeout("https://graph.instagram.com/v25.0/me/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${connection.accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text: message },
    }),
  });

  if (!response.ok) {
    throw new Error(`Instagram send failed: ${await response.text()}`);
  }

  return response.json();
}

export async function sendWhatsAppTemplate(
  connection: { accessToken?: string; phoneNumberId?: string },
  recipientPhone: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[],
) {
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
) {
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

  const response = await fetchWithTimeout(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipientPhone,
      type: "text",
      text: { body: message },
    }),
  });

  if (!response.ok) {
    throw new Error(`WhatsApp send failed: ${await response.text()}`);
  }

  return response.json();
}
