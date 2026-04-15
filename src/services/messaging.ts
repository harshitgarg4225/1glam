import { appConfig } from "../config.js";
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

  const response = await fetch(`https://graph.facebook.com/v23.0/${phoneNumberId}/messages`, {
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
