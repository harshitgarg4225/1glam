import { test } from "node:test";
import assert from "node:assert/strict";

// Config reads env at import time, so set required vars before importing.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";
process.env.APP_BASE_URL = "https://app.example.com";

const {
  signDocumentToken,
  verifyDocumentToken,
  buildPublicDocumentUrl,
  isDocumentType,
} = await import("../src/services/document-links.ts");

test("a freshly signed token verifies for the same (type, workspace, record)", () => {
  const token = signDocumentToken("quote", "ws_1", "LEAD-9");
  assert.equal(verifyDocumentToken("quote", "ws_1", "LEAD-9", token), true);
});

test("a token does not verify if the type, workspace, or record is changed", () => {
  const token = signDocumentToken("invoice", "ws_1", "BKG-5");
  assert.equal(verifyDocumentToken("quote", "ws_1", "BKG-5", token), false, "type swap rejected");
  assert.equal(verifyDocumentToken("invoice", "ws_2", "BKG-5", token), false, "workspace swap rejected");
  assert.equal(verifyDocumentToken("invoice", "ws_1", "BKG-6", token), false, "record swap rejected");
});

test("an empty or garbage signature is rejected", () => {
  assert.equal(verifyDocumentToken("quote", "ws_1", "LEAD-9", ""), false);
  assert.equal(verifyDocumentToken("quote", "ws_1", "LEAD-9", "deadbeef"), false);
});

test("the public URL embeds the signature and points at the right path", () => {
  const url = new URL(buildPublicDocumentUrl("contract", "ws_1", "BKG-5"));
  assert.equal(url.pathname, "/d/contract/ws_1/BKG-5");
  const sig = url.searchParams.get("sig") || "";
  assert.equal(verifyDocumentToken("contract", "ws_1", "BKG-5", sig), true);
});

test("isDocumentType guards the route param", () => {
  assert.equal(isDocumentType("quote"), true);
  assert.equal(isDocumentType("invoice"), true);
  assert.equal(isDocumentType("contract"), true);
  assert.equal(isDocumentType("../etc/passwd"), false);
  assert.equal(isDocumentType("receipt"), false);
});
