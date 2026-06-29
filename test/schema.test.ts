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

test("UPI/GST fields NORMALISE but never throw (must not block a settings save)", () => {
  const upi = workspaceConfigSchema.shape.upiId;
  assert.equal(upi.parse(""), "");
  assert.equal(upi.parse("  aisha@okhdfcbank  "), "aisha@okhdfcbank"); // trimmed
  assert.doesNotThrow(() => upi.parse("aisha")); // legacy junk kept, not a 400
  const gst = workspaceConfigSchema.shape.gstNumber;
  assert.equal(gst.parse("22aaaaa0000a1z5"), "22AAAAA0000A1Z5"); // uppercased
  assert.equal(gst.parse("22 AAAAA 0000 A1Z5"), "22AAAAA0000A1Z5"); // inner spaces stripped
  assert.doesNotThrow(() => gst.parse("22AAAAA")); // short legacy value kept
});

test("UPI/GST warn-helpers accept real-world formats, flag junk", async () => {
  const { isValidUpi, isValidGstin } = await import("../src/schema.ts");
  assert.equal(isValidUpi("aisha@okhdfcbank"), true);
  assert.equal(isValidUpi("9876543210@paytm"), true);
  assert.equal(isValidUpi("name@paytm.bank"), true); // dotted PSP now accepted
  assert.equal(isValidUpi("aisha"), false);
  assert.equal(isValidGstin("22AAAAA0000A1Z5"), true);
  assert.equal(isValidGstin("22 AAAAA 0000 A1Z5"), true); // spaces ok for the check
  assert.equal(isValidGstin("22AAAAA"), false);
});

test("time slots: free text is normalised to clean HH:MM, junk dropped", () => {
  const f = workspaceConfigSchema.shape.bookingTimeSlots;
  assert.equal(f.parse("9:00, 11:00 , 14:00"), "09:00,11:00,14:00");
  assert.equal(f.parse("9am, noon, 25:00, 14:00"), "14:00");
  assert.equal(f.parse("09:00,09:00"), "09:00");
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
