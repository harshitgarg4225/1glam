import { createHash, randomBytes } from "node:crypto";
import { consumeMobileLoginToken, storeMobileLoginToken } from "./database.js";

// OAuth handoff for the native app. Google blocks sign-in inside webviews, so
// the app runs OAuth in the system browser. The callback can't set a cookie in
// the app's webview directly — instead it mints a one-time token, deep-links
// back into the app (busydays://auth?ott=...), and the webview exchanges the
// token for a real session via POST /api/auth/mobile/exchange.
//
// Token properties: 256 bits of randomness, hashed (SHA-256) at rest so a DB
// leak can't replay logins, 5-minute TTL, strictly single-use.

const TOKEN_TTL_MS = 5 * 60 * 1000;

export function hashLoginToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function createMobileLoginToken(
  email: string,
  ttlMs: number = TOKEN_TTL_MS,
): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await storeMobileLoginToken(hashLoginToken(raw), email, new Date(Date.now() + ttlMs));
  return raw;
}

// Returns the email exactly once for a valid token; null for expired, unknown,
// malformed, or already-used tokens.
export async function redeemMobileLoginToken(raw: string): Promise<string | null> {
  if (typeof raw !== "string" || raw.length < 20 || raw.length > 200) return null;
  return consumeMobileLoginToken(hashLoginToken(raw));
}
