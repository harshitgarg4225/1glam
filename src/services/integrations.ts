import { nanoid } from "nanoid";
import type { Credentials } from "google-auth-library";
import { createLeadForWorkspace } from "./booking.js";
import { createGoogleClients } from "./google.js";
import { sheetNames } from "./sheet-definitions.js";
import { getWorkspaceByEmail } from "./workspace.js";

export type NormalizedInboundLead = {
  workspaceEmail: string;
  source: "WhatsApp" | "Instagram";
  clientName: string;
  clientWhatsApp: string;
  clientInstagram?: string;
  eventType: string;
  eventDate: string;
  eventTime?: string;
  locationText: string;
  distanceKm?: number;
  travelTimeMin?: number;
  profileTier?: "Low" | "Mid" | "High";
  followers?: number;
  clientTags?: string;
  inboundMessage: string;
  actorId: string;
};

export async function logInteractionForWorkspace(
  workspaceEmail: string,
  tokens: Credentials,
  input: {
    leadId?: string;
    direction: "Inbound" | "Outbound";
    channel: "WhatsApp" | "Instagram";
    actor: string;
    message: string;
    aiSummary?: string;
  },
) {
  const workspace = await getWorkspaceByEmail(workspaceEmail);
  if (!workspace) throw new Error("Workspace not found");

  const { sheets } = createGoogleClients(tokens);
  await sheets.spreadsheets.values.append({
    spreadsheetId: workspace.spreadsheetId,
    range: `${sheetNames.interactionLog}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        `MSG_${nanoid(10)}`,
        input.leadId ?? "",
        input.direction,
        input.channel,
        input.actor,
        input.message,
        input.aiSummary ?? "",
        new Date().toISOString(),
      ]],
    },
  });
}

export async function ingestNormalizedLead(tokens: Credentials, input: NormalizedInboundLead) {
  const result = await createLeadForWorkspace(input.workspaceEmail, tokens, {
    source: input.source,
    clientName: input.clientName,
    clientWhatsApp: input.clientWhatsApp,
    clientInstagram: input.clientInstagram,
    eventType: input.eventType,
    eventDate: input.eventDate,
    eventTime: input.eventTime,
    locationText: input.locationText,
    distanceKm: input.distanceKm,
    travelTimeMin: input.travelTimeMin,
    profileTier: input.profileTier,
    followers: input.followers,
    clientTags: input.clientTags,
    inboundMessage: input.inboundMessage,
  });

  await logInteractionForWorkspace(input.workspaceEmail, tokens, {
    leadId: result.lead.leadId,
    direction: "Inbound",
    channel: input.source,
    actor: input.actorId,
    message: input.inboundMessage,
    aiSummary: `Lead ${result.lead.leadId} created from ${input.source}`,
  });

  return result;
}

export function extractInboundTextFromMetaWebhook(payload: Record<string, unknown>) {
  const object = typeof payload.object === "string" ? payload.object : "";
  const field = typeof payload.field === "string" ? payload.field : "";

  if (object === "whatsapp_business_account") {
    const entry = Array.isArray(payload.entry) ? payload.entry[0] : undefined;
    const change = entry && Array.isArray((entry as Record<string, unknown>).changes)
      ? ((entry as Record<string, unknown>).changes as Array<Record<string, unknown>>)[0]
      : undefined;
    const value = change?.value as Record<string, unknown> | undefined;
    const message = Array.isArray(value?.messages)
      ? (value?.messages as Array<Record<string, unknown>>)[0]
      : undefined;
    const text = message?.text as Record<string, unknown> | undefined;
    return typeof text?.body === "string" ? text.body : "";
  }

  if (object === "page") {
    const entry = Array.isArray(payload.entry) ? payload.entry[0] : undefined;
    const messaging = entry && Array.isArray((entry as Record<string, unknown>).messaging)
      ? ((entry as Record<string, unknown>).messaging as Array<Record<string, unknown>>)[0]
      : undefined;
    const message = messaging?.message as Record<string, unknown> | undefined;
    return typeof message?.text === "string" ? message.text : "";
  }

  if (object === "instagram") {
    const entry = Array.isArray(payload.entry) ? payload.entry[0] : undefined;
    const messaging = entry && Array.isArray((entry as Record<string, unknown>).messaging)
      ? ((entry as Record<string, unknown>).messaging as Array<Record<string, unknown>>)[0]
      : undefined;
    const message = messaging?.message as Record<string, unknown> | undefined;
    return typeof message?.text === "string" ? message.text : "";
  }

  if (field === "messages") {
    const value = payload.value as Record<string, unknown> | undefined;
    const message = value?.message as Record<string, unknown> | undefined;
    return typeof message?.text === "string" ? message.text : "";
  }

  return "";
}
