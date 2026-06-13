import { createHmac, timingSafeEqual } from "node:crypto";
import { appConfig } from "../config.js";

// Client-facing documents (quote / invoice / contract) are served directly by
// the app instead of Google Drive. This removes Drive from the critical sharing
// path entirely, so a misconfigured Drive scope can never break "send quote".
//
// Each public link carries an HMAC signature over (type, workspaceId, recordId)
// so the URLs are unguessable and tamper-proof, yet need no client login. The
// PDF itself is regenerated deterministically on each view from the workspace +
// lead/booking data, so nothing has to be stored.

export type DocumentType = "quote" | "invoice" | "contract";

export const DOCUMENT_TYPES: DocumentType[] = ["quote", "invoice", "contract"];

export function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as string[]).includes(value);
}

function signature(type: DocumentType, workspaceId: string, recordId: string): string {
  return createHmac("sha256", appConfig.sessionSecret)
    .update(`${type}:${workspaceId}:${recordId}`)
    .digest("hex");
}

export function signDocumentToken(
  type: DocumentType,
  workspaceId: string,
  recordId: string,
): string {
  return signature(type, workspaceId, recordId);
}

export function verifyDocumentToken(
  type: DocumentType,
  workspaceId: string,
  recordId: string,
  token: string,
): boolean {
  if (!token) return false;
  const expected = signature(type, workspaceId, recordId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Full public URL the client receives, e.g. in a WhatsApp message.
export function buildPublicDocumentUrl(
  type: DocumentType,
  workspaceId: string,
  recordId: string,
): string {
  const sig = signDocumentToken(type, workspaceId, recordId);
  const url = new URL(`/d/${type}/${encodeURIComponent(workspaceId)}/${encodeURIComponent(recordId)}`, appConfig.baseUrl);
  url.searchParams.set("sig", sig);
  return url.toString();
}

// Quote links go to a branded view page (with an Accept button and a WhatsApp
// link preview) that embeds the PDF, rather than the bare PDF stream. Uses the
// same signature as the underlying document so one token covers both.
export function buildQuoteViewUrl(workspaceId: string, leadId: string): string {
  const sig = signDocumentToken("quote", workspaceId, leadId);
  const url = new URL(`/q/${encodeURIComponent(workspaceId)}/${encodeURIComponent(leadId)}`, appConfig.baseUrl);
  url.searchParams.set("sig", sig);
  return url.toString();
}

// Invoice links go to a branded page (with payment summary + Pay Now button)
// that embeds the PDF, rather than the bare PDF stream. The page is public
// (no sig required on the page itself; the embedded PDF URL is sig-protected).
export function buildInvoicePageUrl(workspaceId: string, bookingId: string): string {
  return new URL(`/i/${encodeURIComponent(workspaceId)}/${encodeURIComponent(bookingId)}`, appConfig.baseUrl).toString();
}

// Reschedule links are time-limited (72 hours) and signed over (workspaceId, bookingId, expiry).
const RESCHEDULE_TTL_MS = 72 * 60 * 60 * 1000;

function rescheduleSignature(workspaceId: string, bookingId: string, exp: number): string {
  return createHmac("sha256", appConfig.sessionSecret)
    .update(`reschedule:${workspaceId}:${bookingId}:${exp}`)
    .digest("hex");
}

export function buildRescheduleUrl(workspaceId: string, bookingId: string): string {
  const exp = Date.now() + RESCHEDULE_TTL_MS;
  const sig = rescheduleSignature(workspaceId, bookingId, exp);
  const url = new URL(`/reschedule/${encodeURIComponent(workspaceId)}/${encodeURIComponent(bookingId)}`, appConfig.baseUrl);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return url.toString();
}

export function verifyRescheduleToken(
  workspaceId: string,
  bookingId: string,
  exp: string,
  sig: string,
): boolean {
  if (!exp || !sig) return false;
  const expNum = Number(exp);
  if (Number.isNaN(expNum) || Date.now() > expNum) return false;
  const expected = rescheduleSignature(workspaceId, bookingId, expNum);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

