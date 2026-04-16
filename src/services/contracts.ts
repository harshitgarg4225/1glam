import { createHmac, timingSafeEqual } from "node:crypto";
import type { WorkspaceRecord } from "../types.js";
import type { BookingRecord, LeadRecord } from "./booking.js";
import { appConfig } from "../config.js";
import { generateContractPdfBytes } from "./documents.js";

type LeegalityCreateResult = {
  contractUrl: string;
  contractStatus: string;
  referenceId: string;
  documentId: string;
  rawResponse: unknown;
};

export type LeegalityWebhookEvent = {
  referenceId: string;
  contractStatus: string;
  contractUrl: string;
  documentId: string;
  rawPayload: unknown;
};

export type LeegalityDetailsResult = {
  referenceId: string;
  contractStatus: string;
  contractUrl: string;
  documentId: string;
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
      "Add the Leegality workflow/profile ID in Owner Configuration before creating a contract.",
    );
  }

  const contractPdfBytes = await generateContractPdfBytes(workspace, lead, booking);
  const contractBase64 = Buffer.from(contractPdfBytes).toString("base64");

  const payload = {
    profileId: workspace.config.contractTemplateUrl,
    file: {
      name: `${workspace.config.businessName || workspace.name} Booking Contract ${booking.bookingId}`,
      file: contractBase64,
    },
    invitees: [
      {
        name: lead.clientName,
        email: "",
        phone: lead.clientWhatsApp,
      },
    ],
    irn: booking.bookingId,
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
  const referenceId =
    pickFirstString(parsed, ["irn", "referenceId", "reference_id", "requestId", "request_id"]) ||
    booking.bookingId;
  const documentId = pickFirstString(parsed, ["documentId", "document_id", "id"]);

  return {
    contractUrl,
    contractStatus,
    referenceId,
    documentId,
    rawResponse: parsed,
  };
}

export async function checkLeegalityDocumentDetails(referenceId: string): Promise<LeegalityDetailsResult> {
  if (!appConfig.leegalityDetailsUrl || !appConfig.leegalityApiKey) {
    throw new Error(
      "Leegality details sync is not configured. Set LEEGALITY_DETAILS_URL and LEEGALITY_API_KEY first.",
    );
  }

  const response = await fetch(appConfig.leegalityDetailsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [appConfig.leegalityApiKeyHeader]: appConfig.leegalityApiKey,
    },
    body: JSON.stringify({
      irn: referenceId,
    }),
  });

  const text = await response.text();
  const parsed = safeJsonParse(text);
  if (!response.ok) {
    throw new Error(
      `Leegality details request failed: ${
        typeof parsed === "object" && parsed && "message" in parsed
          ? String((parsed as { message?: unknown }).message)
          : text || response.statusText
      }`,
    );
  }

  const resolvedReferenceId =
    pickDeepString(parsed, [
      ["irn"],
      ["referenceId"],
      ["reference_id"],
      ["requestId"],
      ["request_id"],
      ["data", "irn"],
      ["data", "referenceId"],
      ["document", "irn"],
      ["document", "referenceId"],
    ]) || referenceId;

  const rawStatus =
    pickDeepString(parsed, [
      ["documentStatus"],
      ["document_status"],
      ["status"],
      ["event"],
      ["data", "documentStatus"],
      ["document", "documentStatus"],
      ["document", "status"],
    ]) || "received";

  const contractUrl =
    pickDeepString(parsed, [
      ["url"],
      ["signUrl"],
      ["documentUrl"],
      ["request", "0", "url"],
      ["data", "url"],
      ["data", "signUrl"],
      ["document", "url"],
    ]) || "";

  const documentId = pickDeepString(parsed, [
    ["documentId"],
    ["document_id"],
    ["data", "documentId"],
    ["document", "documentId"],
  ]);

  return {
    referenceId: resolvedReferenceId,
    contractStatus: normalizeLeegalityStatus(rawStatus),
    contractUrl,
    documentId,
    rawResponse: parsed,
  };
}

export function verifyLeegalityWebhookRequest(
  body: unknown,
  providedValues: Array<string | undefined>,
) {
  if (!appConfig.leegalityWebhookSecret) {
    return true;
  }

  const documentId = pickDeepString(body, [
    ["documentId"],
    ["document_id"],
    ["data", "documentId"],
  ]);
  const mac = pickDeepString(body, [
    ["mac"],
    ["data", "mac"],
  ]);

  if (documentId && mac) {
    const expected = createHmac("sha1", appConfig.leegalityWebhookSecret).update(documentId).digest("hex");
    if (safeCompare(expected, mac)) {
      return true;
    }
  }

  return providedValues.some(
    (value) => typeof value === "string" && value.trim() === appConfig.leegalityWebhookSecret,
  );
}

export function parseLeegalityWebhook(body: unknown): LeegalityWebhookEvent {
  const referenceId = pickDeepString(body, [
    ["irn"],
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
    ["request", "0", "url"],
    ["data", "signUrl"],
    ["data", "documentUrl"],
    ["data", "url"],
    ["document", "signUrl"],
    ["document", "documentUrl"],
  ]);
  const documentId = pickDeepString(body, [
    ["documentId"],
    ["document_id"],
    ["data", "documentId"],
    ["document", "documentId"],
  ]);

  return {
    referenceId,
    contractStatus: normalizeLeegalityStatus(rawStatus),
    contractUrl,
    documentId,
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

function safeCompare(expected: string, actual: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
