import { appConfig } from "../config.js";
import { buildAppSecretProof } from "./meta.js";
import type { MetaChannelConnection, WorkspaceRecord } from "../types.js";

export async function sendChannelMessage(input: {
  workspace: WorkspaceRecord;
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

    const response = await fetch(url.toString(), {
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

  const response = await fetch("https://graph.instagram.com/v25.0/me/messages", {
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

  const response = await fetch(url.toString(), {
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
