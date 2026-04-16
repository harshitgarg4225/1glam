import type { WorkspaceRecord } from "../types.js";
import type { BookingRecord, LeadRecord } from "./booking.js";
import { appConfig } from "../config.js";

type LeegalityCreateResult = {
  contractUrl: string;
  contractStatus: string;
  referenceId: string;
  rawResponse: unknown;
};

export type LeegalityWebhookEvent = {
  referenceId: string;
  contractStatus: string;
  contractUrl: string;
  rawPayload: unknown;
};

export async function createLeegalityContract(
  workspace: WorkspaceRecord,
  lead: LeadRecord,
  booking: BookingRecord,
): Promise<LeegalityCreateResult> {
  if (!appConfig.leegalityCreateUrl || !appConfig.leegalityApiKey) {
    throw new Error(
      "Leegality is not configured. Set LEEGALITY_CREATE_URL and LEEGALITY_API_KEY first.",
    );
  }

  if (!workspace.config.contractTemplateUrl) {
    throw new Error(
      "Add the Leegality template ID or template URL in Owner Configuration before creating a contract.",
    );
  }

  const payload = {
    templateId: workspace.config.contractTemplateUrl,
    referenceId: booking.bookingId,
    title: `${workspace.config.businessName || workspace.name} Booking Contract`,
    callbackUrl: `${appConfig.baseUrl}/webhooks/leegality`,
    customer: {
      name: lead.clientName,
      mobile: lead.clientWhatsApp,
      email: "",
    },
    booking: {
      bookingId: booking.bookingId,
      leadId: lead.leadId,
      eventType: booking.eventType,
      eventDate: booking.eventDate,
      eventTime: booking.eventTime,
      venue: booking.venue,
      finalPrice: booking.finalPrice,
      advanceAmount: booking.advanceAmount,
      balanceDue: booking.balanceDue,
    },
    mergeFields: {
      client_name: lead.clientName,
      client_mobile: lead.clientWhatsApp,
      event_type: booking.eventType,
      event_date: booking.eventDate,
      event_time: booking.eventTime,
      venue: booking.venue,
      final_price: booking.finalPrice,
      advance_amount: booking.advanceAmount,
      balance_due: booking.balanceDue,
      business_name: workspace.config.businessName || workspace.name,
      owner_name: workspace.config.ownerName,
    },
  };

  const response = await fetch(appConfig.leegalityCreateUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [appConfig.leegalityApiKeyHeader]: appConfig.leegalityApiKey,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const parsed = safeJsonParse(text);
  if (!response.ok) {
    throw new Error(
      `Leegality create request failed: ${
        typeof parsed === "object" && parsed && "message" in parsed
          ? String((parsed as { message?: unknown }).message)
          : text || response.statusText
      }`,
    );
  }

  const contractUrl = pickFirstString(parsed, [
    "signUrl",
    "documentUrl",
    "document_url",
    "url",
    "sign_url",
  ]);
  const contractStatus = pickFirstString(parsed, ["status"]) || "Sent";
  const referenceId = pickFirstString(parsed, ["referenceId", "reference_id", "requestId", "request_id"]) || booking.bookingId;

  return {
    contractUrl,
    contractStatus,
    referenceId,
    rawResponse: parsed,
  };
}

export function verifyLeegalityWebhookSecret(
  providedValues: Array<string | undefined>,
) {
  if (!appConfig.leegalityWebhookSecret) {
    return true;
  }

  return providedValues.some(
    (value) => typeof value === "string" && value.trim() === appConfig.leegalityWebhookSecret,
  );
}

export function parseLeegalityWebhook(body: unknown): LeegalityWebhookEvent {
  const referenceId = pickDeepString(body, [
    ["referenceId"],
    ["reference_id"],
    ["requestId"],
    ["request_id"],
    ["documentId"],
    ["document_id"],
    ["data", "referenceId"],
    ["data", "reference_id"],
    ["data", "requestId"],
    ["data", "request_id"],
    ["document", "referenceId"],
    ["document", "reference_id"],
    ["event", "referenceId"],
    ["event", "reference_id"],
    ["payload", "referenceId"],
    ["payload", "reference_id"],
  ]);

  if (!referenceId) {
    throw new Error("Leegality webhook did not include a referenceId");
  }

  const rawStatus =
    pickDeepString(body, [
      ["status"],
      ["event"],
      ["action"],
      ["documentStatus"],
      ["document_status"],
      ["data", "status"],
      ["data", "event"],
      ["document", "status"],
      ["payload", "status"],
    ]) || "received";

  const contractUrl = pickDeepString(body, [
    ["signUrl"],
    ["sign_url"],
    ["documentUrl"],
    ["document_url"],
    ["url"],
    ["data", "signUrl"],
    ["data", "documentUrl"],
    ["document", "signUrl"],
    ["document", "documentUrl"],
  ]);

  return {
    referenceId,
    contractStatus: normalizeLeegalityStatus(rawStatus),
    contractUrl,
    rawPayload: body,
  };
}

export function normalizeLeegalityStatus(rawStatus: string) {
  const normalized = rawStatus.trim().toLowerCase();

  if (
    normalized.includes("signed") ||
    normalized.includes("executed") ||
    normalized.includes("completed")
  ) {
    return "Signed";
  }

  if (
    normalized.includes("declin") ||
    normalized.includes("reject") ||
    normalized.includes("cancel")
  ) {
    return "Declined";
  }

  if (
    normalized.includes("sent") ||
    normalized.includes("share") ||
    normalized.includes("created") ||
    normalized.includes("pending")
  ) {
    return "Sent";
  }

  return rawStatus;
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}

function pickFirstString(source: unknown, keys: string[]) {
  if (!source || typeof source !== "object") return "";
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function pickDeepString(source: unknown, paths: string[][]) {
  for (const path of paths) {
    let current: unknown = source;
    for (const key of path) {
      if (!current || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }

    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
  }

  return "";
}
