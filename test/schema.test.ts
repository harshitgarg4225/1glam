import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

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
