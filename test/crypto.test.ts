import { test } from "node:test";
import assert from "node:assert/strict";

// Config reads env at import time, so set required vars before importing.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
process.env.TOKEN_ENCRYPTION_KEY = "unit-test-encryption-key-abcdefghijklmnop";

const {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  encryptionEnabled,
  encryptWorkspaceSecrets,
  decryptWorkspaceSecrets,
} = await import("../src/services/crypto.ts");

test("encryption is enabled when a key is configured", () => {
  assert.equal(encryptionEnabled(), true);
});

test("encrypt → decrypt round-trips the original value", () => {
  const secret = "ya29.super-secret-refresh-token";
  const enc = encryptSecret(secret);
  assert.ok(isEncrypted(enc), "ciphertext should carry the enc:v1: prefix");
  assert.notEqual(enc, secret, "ciphertext should not equal plaintext");
  assert.equal(decryptSecret(enc), secret);
});

test("each encryption uses a fresh IV (ciphertexts differ)", () => {
  const a = encryptSecret("same-value");
  const b = encryptSecret("same-value");
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), "same-value");
  assert.equal(decryptSecret(b), "same-value");
});

test("legacy plaintext passes through decryptSecret unchanged", () => {
  // Rows written before encryption existed have no prefix.
  assert.equal(decryptSecret("legacy-plaintext-token"), "legacy-plaintext-token");
});

test("empty values are not encrypted", () => {
  assert.equal(encryptSecret(""), "");
});

test("tampered ciphertext fails closed (returns value as-is, never throws)", () => {
  const enc = encryptSecret("token");
  const tampered = enc.slice(0, -4) + "AAAA";
  // GCM auth fails → we return the value rather than crashing a login.
  assert.doesNotThrow(() => decryptSecret(tampered));
});

test("workspace secret transform encrypts only token fields, leaves rest intact", () => {
  const record: any = {
    workspaceId: "W1",
    email: "a@b.com",
    confirmedCalendarId: "primary",
    googleTokens: { access_token: "atk", refresh_token: "rtk", scope: "x", expiry_date: 123 },
    metaConnections: {
      whatsapp: { channel: "whatsapp", status: "connected", accessToken: "wa-tok", phoneNumberId: "PN1" },
    },
    config: { businessName: "Glow" },
  };

  const enc = encryptWorkspaceSecrets(record);
  // Secrets are encrypted...
  assert.ok(isEncrypted(enc.googleTokens.access_token));
  assert.ok(isEncrypted(enc.googleTokens.refresh_token));
  assert.ok(isEncrypted(enc.metaConnections.whatsapp.accessToken));
  // ...non-secrets are untouched...
  assert.equal(enc.confirmedCalendarId, "primary");
  assert.equal(enc.googleTokens.scope, "x");
  assert.equal(enc.metaConnections.whatsapp.phoneNumberId, "PN1");
  assert.equal(enc.config.businessName, "Glow");
  // ...and the original object is not mutated.
  assert.equal(record.googleTokens.access_token, "atk");

  // Decrypting restores everything.
  const dec = decryptWorkspaceSecrets(enc);
  assert.equal(dec.googleTokens.access_token, "atk");
  assert.equal(dec.googleTokens.refresh_token, "rtk");
  assert.equal(dec.metaConnections.whatsapp.accessToken, "wa-tok");
});
