import { test } from "node:test";
import assert from "node:assert/strict";

// Config reads env at import time, so set required vars before importing.
// No DATABASE_URL → the token store runs in its in-memory (file) mode.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";
process.env.DATABASE_URL = "";

const { createMobileLoginToken, redeemMobileLoginToken, hashLoginToken } = await import(
  "../src/services/mobile-auth.ts"
);

test("a fresh mobile login token redeems exactly once", async () => {
  const raw = await createMobileLoginToken("artist@example.com");
  assert.equal(await redeemMobileLoginToken(raw), "artist@example.com");
  // Single use: the second redemption must fail.
  assert.equal(await redeemMobileLoginToken(raw), null);
});

test("an expired token does not redeem", async () => {
  const raw = await createMobileLoginToken("artist@example.com", 1);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(await redeemMobileLoginToken(raw), null);
});

test("garbage and truncated tokens are rejected without hitting the store", async () => {
  assert.equal(await redeemMobileLoginToken(""), null);
  assert.equal(await redeemMobileLoginToken("short"), null);
  assert.equal(await redeemMobileLoginToken("x".repeat(500)), null);
  assert.equal(await redeemMobileLoginToken("a-plausible-but-unknown-token-value-123456"), null);
});

test("tokens are unique and long enough to resist brute force", async () => {
  const a = await createMobileLoginToken("a@example.com");
  const b = await createMobileLoginToken("a@example.com");
  assert.notEqual(a, b);
  // 32 random bytes base64url-encoded = 43 chars.
  assert.ok(a.length >= 43);
});

test("redeeming returns the email normalized to lowercase", async () => {
  const raw = await createMobileLoginToken("Artist@Example.COM");
  assert.equal(await redeemMobileLoginToken(raw), "artist@example.com");
});

test("hashLoginToken is deterministic and one-way shaped (hex sha256)", () => {
  assert.equal(hashLoginToken("abc"), hashLoginToken("abc"));
  assert.match(hashLoginToken("abc"), /^[0-9a-f]{64}$/);
  assert.notEqual(hashLoginToken("abc"), hashLoginToken("abd"));
});
