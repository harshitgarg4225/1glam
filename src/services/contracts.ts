import type { WorkspaceRecord } from "../types.js";
import type { BookingRecord, LeadRecord } from "./booking.js";
import { appConfig } from "../config.js";

type LeegalityCreateResult = {
  contractUrl: string;
  contractStatus: string;
  referenceId: string;
  rawResponse: unknown;
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
