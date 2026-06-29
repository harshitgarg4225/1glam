import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";

const { workspaceConfigSchema } = await import("../src/schema.ts");

// Each optional field carries its own default; parsing `undefined` against the
// field schema yields that default. This verifies the new template-compliance
// fields are wired with safe defaults without building a full valid config.
test("new WhatsApp-template fields default to empty (free-text fallback)", () => {
  const shape = workspaceConfigSchema.shape;
  assert.equal(shape.quoteTemplate.parse(undefined), "");
  assert.equal(shape.invoiceTemplate.parse(undefined), "");
  assert.equal(shape.contractTemplate.parse(undefined), "");
  assert.equal(shape.collectionTemplate.parse(undefined), "");
  assert.equal(shape.teamNotifyTemplate.parse(undefined), "");
});

test("UPI id: empty ok, valid VPA ok, junk rejected", () => {
  const f = workspaceConfigSchema.shape.upiId;
  assert.equal(f.parse(""), "");
  assert.equal(f.parse("aisha@okhdfcbank"), "aisha@okhdfcbank");
  assert.throws(() => f.parse("aisha")); // no @ → dead QR
  assert.throws(() => f.parse("aisha bank"));
});

test("GSTIN: empty ok, 15-char ok (uppercased), wrong length rejected", () => {
  const f = workspaceConfigSchema.shape.gstNumber;
  assert.equal(f.parse(""), "");
  assert.equal(f.parse("22aaaaa0000a1z5"), "22AAAAA0000A1Z5"); // normalised
  assert.throws(() => f.parse("22AAAAA")); // too short
});

test("time slots: free text is normalised to clean HH:MM, junk dropped", () => {
  const f = workspaceConfigSchema.shape.bookingTimeSlots;
  assert.equal(f.parse("9:00, 11:00 , 14:00"), "09:00,11:00,14:00");
  assert.equal(f.parse("9am, noon, 25:00, 14:00"), "14:00"); // only the valid one survives
  assert.equal(f.parse("09:00,09:00"), "09:00"); // de-duped
});

test("sensible non-empty defaults are preserved", () => {
  const shape = workspaceConfigSchema.shape;
  assert.equal(shape.notifyTeamOnBooking.parse(undefined), "Yes");
  assert.equal(shape.documentTemplate.parse(undefined), "classic");
  assert.equal(shape.quoteTemplateLang.parse(undefined), "en");
  assert.equal(shape.collectionTemplateLang.parse(undefined), "en");
});

test("config schema rejects an empty object (required fields enforced)", () => {
  assert.throws(() => workspaceConfigSchema.parse({}));
});
