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
