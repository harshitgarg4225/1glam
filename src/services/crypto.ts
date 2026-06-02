import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { appConfig } from "../config.js";
import type { WorkspaceRecord } from "../types.js";

// Envelope encryption for secrets at rest (Google + Meta OAuth tokens).
//
// Format: "enc:v1:" + base64( iv[12] | authTag[16] | ciphertext )
// Cipher: AES-256-GCM. The 32-byte key is derived from TOKEN_ENCRYPTION_KEY via
// SHA-256 so any sufficiently-random secret works as the key material.
//
// Design goals:
//  - Backward compatible: decryptSecret() passes through legacy plaintext (any
//    value without the "enc:v1:" prefix), so existing rows keep working and get
//    encrypted the next time they're saved.
//  - Fail-safe reads: a value that looks encrypted but can't be decrypted is
//    returned as-is rather than throwing, so one bad row can't brick a login.

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer | null {
  if (!appConfig.tokenEncryptionKey) return null;
  if (!cachedKey) {
    cachedKey = createHash("sha256").update(appConfig.tokenEncryptionKey).digest();
  }
  return cachedKey;
}

export function encryptionEnabled(): boolean {
  return Boolean(appConfig.tokenEncryptionKey);
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  // No key configured → store as-is (dev convenience; production boot requires a key).
  if (!key || !plaintext) return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already encrypted, don't double-wrap

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptSecret(value: string): string {
  const key = getKey();
  if (!isEncrypted(value)) return value; // legacy plaintext
  if (!key) return value; // can't decrypt without a key; surface as-is rather than throw

  try {
    const raw = Buffer.from(value.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return value;
  }
}

// The exact set of token fields we protect. Everything else in the record
// (calendar ids, config, page names, expiry timestamps) is non-secret.
function transformWorkspaceSecrets(
  record: WorkspaceRecord,
  fn: (value: string) => string,
): WorkspaceRecord {
  // Shallow structured clone is enough; we only rewrite leaf string fields.
  const next: WorkspaceRecord = JSON.parse(JSON.stringify(record));

  if (next.googleTokens) {
    if (next.googleTokens.access_token) next.googleTokens.access_token = fn(next.googleTokens.access_token);
    if (next.googleTokens.refresh_token) next.googleTokens.refresh_token = fn(next.googleTokens.refresh_token);
  }

  for (const channel of ["instagram", "whatsapp"] as const) {
    const connection = next.metaConnections?.[channel];
    if (!connection) continue;
    if (connection.accessToken) connection.accessToken = fn(connection.accessToken);
    if (connection.pageAccessToken) connection.pageAccessToken = fn(connection.pageAccessToken);
  }

  return next;
}

export function encryptWorkspaceSecrets(record: WorkspaceRecord): WorkspaceRecord {
  return transformWorkspaceSecrets(record, encryptSecret);
}

export function decryptWorkspaceSecrets(record: WorkspaceRecord): WorkspaceRecord {
  return transformWorkspaceSecrets(record, decryptSecret);
}
