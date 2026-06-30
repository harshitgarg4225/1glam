import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";

const { scrubFields } = await import("../src/services/logger.ts");

test("log fields mask emails to a***@domain", () => {
  const out = scrubFields({ workspace: "priya.sharma@gmail.com" });
  assert.equal(out.workspace, "p***@gmail.com");
});

test("log fields keep only the last 4 digits of phone numbers", () => {
  assert.equal(scrubFields({ phone: "919876543210" }).phone, "***3210");
  assert.equal(scrubFields({ note: "call +91 98765 43210 today" }).note, "call ***3210 today");
});

test("log fields fully redact credential-looking keys", () => {
  const out = scrubFields({ access_token: "ya29.secret", refreshToken: "1//abc", apiKey: "k", password: "p", normal: "ok" });
  assert.equal(out.access_token, "[redacted]");
  assert.equal(out.refreshToken, "[redacted]");
  assert.equal(out.apiKey, "[redacted]");
  assert.equal(out.password, "[redacted]");
  assert.equal(out.normal, "ok");
});

test("log redaction recurses into nested objects/arrays", () => {
  const out = scrubFields({ ctx: { client: "a@b.com", phones: ["12345678901"] } });
  assert.deepEqual(out.ctx, { client: "a***@b.com", phones: ["***8901"] });
});

test("log redaction leaves non-PII values untouched", () => {
  const out = scrubFields({ count: 5, status: "Confirmed", ok: true });
  assert.deepEqual(out, { count: 5, status: "Confirmed", ok: true });
});
