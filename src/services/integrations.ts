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

type ParsedInstagramSignals = {
  eventType: string;
  eventDate: string;
  locationText: string;
  clientTags: string;
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

export function parseInstagramLeadSignalsFromMessage(message: string): ParsedInstagramSignals {
  const text = message.trim();
  const lower = text.toLowerCase();
  const eventType =
    lower.includes("bridal") || lower.includes("bride")
      ? "Bridal"
      : lower.includes("engagement")
        ? "Engagement"
        : lower.includes("reception")
          ? "Reception"
          : lower.includes("party")
            ? "Party"
            : lower.includes("shoot")
              ? "Shoot"
              : "Other";

  const locationMatch = text.match(/\b(?:in|at)\s+([A-Za-z][A-Za-z\s,-]{2,60})$/i);
  const locationText = locationMatch?.[1]?.trim() || "Unknown";

  const eventDate = extractDate(text) || new Date().toISOString().slice(0, 10);

  const tags = [];
  if (eventType !== "Other") tags.push(eventType.toUpperCase());
  if (locationText !== "Unknown") tags.push("LOCATION_CAPTURED");
  if (eventDate !== new Date().toISOString().slice(0, 10)) tags.push("DATE_CAPTURED");

  return {
    eventType,
    eventDate,
    locationText,
    clientTags: tags.join(", "),
  };
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

function extractDate(text: string) {
  const numericMatch = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (numericMatch) {
    const day = Number(numericMatch[1]);
    const month = Number(numericMatch[2]);
    const year = normalizeYear(numericMatch[3], month, day);
    if (isValidDateParts(year, month, day)) {
      return `${year}-${pad(month)}-${pad(day)}`;
    }
  }

  const monthMatch = text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:[a-z]*)\s*(\d{2,4})?\b/i,
  );
  if (monthMatch) {
    const day = Number(monthMatch[1]);
    const month = monthNameToNumber(monthMatch[2]);
    const year = normalizeYear(monthMatch[3], month, day);
    if (month && isValidDateParts(year, month, day)) {
      return `${year}-${pad(month)}-${pad(day)}`;
    }
  }

  return "";
}

function normalizeYear(rawYear: string | undefined, month: number, day: number) {
  if (rawYear) {
    const year = Number(rawYear.length === 2 ? `20${rawYear}` : rawYear);
    return year;
  }

  const now = new Date();
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), month - 1, day));
  const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return candidate < current ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

function monthNameToNumber(month: string) {
  const normalized = month.toLowerCase();
  return {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    sept: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  }[normalized] ?? 0;
}

function isValidDateParts(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    Number.isFinite(year) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
