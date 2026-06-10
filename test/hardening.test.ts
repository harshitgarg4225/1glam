import { test } from "node:test";
import assert from "node:assert/strict";

// Config reads env at import time, so set required vars before importing modules
// that transitively pull it in (booking.ts → config.ts).
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";

const { isPublicHttpUrl } = await import("../src/services/http.ts");
const { roundToPremiumNumber } = await import("../src/services/booking.ts");
const { parseDocumentAdjustments, parseOrderItems } = await import("../src/services/documents.ts");

// --- SSRF guard (isPublicHttpUrl) ---------------------------------------------

test("isPublicHttpUrl allows ordinary public https/http URLs", () => {
  assert.equal(isPublicHttpUrl("https://cdn.example.com/logo.png"), true);
  assert.equal(isPublicHttpUrl("http://images.example.org/a.jpg"), true);
  assert.equal(isPublicHttpUrl("https://1glam.app/assets/logo.png"), true);
});

test("isPublicHttpUrl blocks the cloud metadata endpoint", () => {
  assert.equal(isPublicHttpUrl("http://169.254.169.254/latest/meta-data/"), false);
});

test("isPublicHttpUrl blocks loopback and private ranges", () => {
  assert.equal(isPublicHttpUrl("http://127.0.0.1/x"), false);
  assert.equal(isPublicHttpUrl("http://localhost:3000/x"), false);
  assert.equal(isPublicHttpUrl("http://10.0.0.5/x"), false);
  assert.equal(isPublicHttpUrl("http://192.168.1.1/x"), false);
  assert.equal(isPublicHttpUrl("http://172.16.0.9/x"), false);
  assert.equal(isPublicHttpUrl("http://172.31.255.255/x"), false);
  assert.equal(isPublicHttpUrl("http://[::1]/x"), false);
});

test("isPublicHttpUrl allows a public IP inside 172 but outside 16-31", () => {
  assert.equal(isPublicHttpUrl("http://172.32.0.1/x"), true);
  assert.equal(isPublicHttpUrl("http://172.15.0.1/x"), true);
});

test("isPublicHttpUrl rejects non-http(s) schemes and junk", () => {
  assert.equal(isPublicHttpUrl("file:///etc/passwd"), false);
  assert.equal(isPublicHttpUrl("ftp://example.com/x"), false);
  assert.equal(isPublicHttpUrl("javascript:alert(1)"), false);
  assert.equal(isPublicHttpUrl("not a url"), false);
  assert.equal(isPublicHttpUrl(""), false);
});

// --- Advance rounding consistency (roundToPremiumNumber) -----------------------

test("roundToPremiumNumber is deterministic and >= 0", () => {
  // (10000 * 30%) = 3000 -> nearest 500 = 3000 -> premium 2800
  assert.equal(roundToPremiumNumber(3000), 2800);
  // Small values floor to 0 rather than going negative.
  assert.equal(roundToPremiumNumber(100), 0);
});

test("roundToPremiumNumber guards against NaN / non-finite input", () => {
  assert.equal(roundToPremiumNumber(NaN), 0);
  assert.equal(roundToPremiumNumber(Number.POSITIVE_INFINITY), 0);
  // This is the exact failure mode the advancePercentage guard prevents:
  // price * undefined / 100 = NaN.
  const price = 50000;
  const pct = undefined as unknown as number;
  assert.equal(roundToPremiumNumber((price * pct) / 100), 0);
});

// --- Document edit adjustments parser (parseDocumentAdjustments) --------------

test("parseDocumentAdjustments returns empty object for blank/invalid input", () => {
  assert.deepEqual(parseDocumentAdjustments(""), {});
  assert.deepEqual(parseDocumentAdjustments(undefined), {});
  assert.deepEqual(parseDocumentAdjustments("not json"), {});
});

test("parseDocumentAdjustments keeps a valid amount override and drops bad ones", () => {
  assert.equal(parseDocumentAdjustments(JSON.stringify({ amountOverride: 12000 })).amountOverride, 12000);
  // Zero / negative / non-numeric overrides are ignored (fall back to auto price).
  assert.equal(parseDocumentAdjustments(JSON.stringify({ amountOverride: 0 })).amountOverride, undefined);
  assert.equal(parseDocumentAdjustments(JSON.stringify({ amountOverride: -5 })).amountOverride, undefined);
  assert.equal(parseDocumentAdjustments(JSON.stringify({ amountOverride: "abc" })).amountOverride, undefined);
});

test("parseDocumentAdjustments filters out line items missing a label or amount", () => {
  const parsed = parseDocumentAdjustments(
    JSON.stringify({
      lineItems: [
        { label: "Trial session", amount: 2000 },
        { label: "", amount: 500 },
        { label: "No price", amount: 0 },
      ],
    }),
  );
  assert.deepEqual(parsed.lineItems, [{ label: "Trial session", amount: 2000 }]);
});

// --- Itemized order parser (parseOrderItems) ---------------------------------

test("parseOrderItems computes line totals and the rolled-up order total", () => {
  const parsed = parseOrderItems(
    JSON.stringify([
      { label: "Bridal makeup", quantity: 1, unitPrice: 25000 },
      { label: "Bridesmaids", quantity: 3, unitPrice: 5000 },
    ]),
  );
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[1].amount, 15000);
  assert.equal(parsed.total, 40000);
  assert.equal(parsed.lines.length, 2);
});

test("parseOrderItems drops rows with no label or zero quantity, and tolerates junk", () => {
  assert.deepEqual(parseOrderItems("").items, []);
  assert.deepEqual(parseOrderItems("not json").items, []);
  const parsed = parseOrderItems(
    JSON.stringify([
      { label: "Valid", quantity: 2, unitPrice: 100 },
      { label: "", quantity: 5, unitPrice: 100 },
      { label: "Zero qty", quantity: 0, unitPrice: 100 },
    ]),
  );
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.total, 200);
});
