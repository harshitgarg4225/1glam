import { test } from "node:test";
import assert from "node:assert/strict";

// Config reads env at import time, so set required vars before importing modules
// that transitively pull it in (booking.ts → config.ts).
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";

const { isPublicHttpUrl } = await import("../src/services/http.ts");
const { roundToPremiumNumber } = await import("../src/services/booking.ts");
const { parseDocumentAdjustments, parseOrderItems } = await import("../src/services/documents.ts");
const { buildAssistantSnapshot } = await import("../src/services/assistant.ts");
const { quickBookingSchema } = await import("../src/api-schema.ts");

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

// --- AI assistant snapshot (buildAssistantSnapshot) ----------------------------

function leadFixture(over = {}) {
  return {
    leadId: "L1", createdAt: "2026-06-01T00:00:00Z", source: "Instagram",
    clientName: "Priya", clientWhatsApp: "+919900112233", clientInstagram: "",
    eventType: "Bridal", eventDate: "2026-07-01", eventTime: "", locationText: "Mumbai",
    distanceKm: 0, travelTimeMin: 0, outstationFlag: "No", profileTier: "Mid",
    followers: 0, clientTags: "", aiInsight: "", suggestedReply: "", demandCount: 0,
    scarcityTag: "", holdExpiresAt: "", initialAiPrice: 20000, finalApprovedPrice: 25000,
    discountPercent: 0, ownerDecision: "", ownerNotes: "", status: "New",
    assignedArtist: "", lastContactedAt: "2026-06-05T00:00:00Z",
    tentativeCalendarEventId: "", confirmedCalendarEventId: "", bookingId: "",
    paymentStatus: "Not Started", quoteUrl: "", quoteGeneratedAt: "", quoteVoidedAt: "",
    quoteAdjustments: "", orderItems: "", ...over,
  };
}

function bookingFixture(over = {}) {
  return {
    bookingId: "B1", leadId: "L1", bookedAt: "2026-06-02T00:00:00Z",
    clientName: "Priya", clientWhatsApp: "+919900112233", eventType: "Bridal",
    eventDate: "2026-07-01", eventTime: "10:00", venue: "Taj, Mumbai",
    assignedArtist: "", finalPrice: 25000, advanceAmount: 7500, balanceDue: 17500,
    tentativeCalendarEventId: "", confirmedCalendarEventId: "", contractUrl: "",
    invoiceUrl: "", paymentStatus: "Advance Due", status: "Confirmed",
    contractStatus: "", contractSentAt: "", invoiceGeneratedAt: "", remindersSent: "",
    invoiceVoidedAt: "", contractVoidedAt: "", invoiceAdjustments: "",
    contractAdjustments: "", orderItems: "", ...over,
  };
}

test("buildAssistantSnapshot computes totals and filters closed leads", () => {
  const leads = [
    leadFixture(),
    leadFixture({ leadId: "L2", status: "Lost" }),
    leadFixture({ leadId: "L3", status: "Completed" }),
  ];
  const bookings = [
    bookingFixture(),
    bookingFixture({ bookingId: "B2", eventDate: "2020-01-01", finalPrice: 9000, paymentStatus: "Paid in Full" }),
  ];
  const snap = buildAssistantSnapshot(leads, bookings, new Date("2026-06-10T00:00:00Z"));
  assert.equal(snap.today, "2026-06-10");
  assert.equal(snap.openLeads.length, 1); // Lost + Completed excluded
  assert.equal(snap.totals.openLeadCount, 1);
  assert.equal(snap.totals.bookingCount, 2);
  // Only the future booking counts toward upcoming revenue.
  assert.equal(snap.totals.confirmedUpcomingRevenue, 25000);
  // Only the Advance Due booking contributes to pending advances.
  assert.equal(snap.totals.advancesPending, 7500);
});

test("buildAssistantSnapshot caps rows so a huge workspace can't blow up the prompt", () => {
  const leads = Array.from({ length: 80 }, (_, i) => leadFixture({ leadId: `L${i}` }));
  const bookings = Array.from({ length: 80 }, (_, i) => bookingFixture({ bookingId: `B${i}` }));
  const snap = buildAssistantSnapshot(leads, bookings);
  assert.ok(snap.openLeads.length <= 40);
  assert.ok(snap.bookings.length <= 40);
  assert.equal(snap.totals.openLeadCount, 80); // totals still reflect everything
});

// --- Quick walk-in booking schema (quickBookingSchema) -------------------------

test("quickBookingSchema accepts a valid walk-in booking and coerces types", () => {
  const parsed = quickBookingSchema.parse({
    clientName: "Meera", clientWhatsApp: "+91 98765 43210", eventType: "Party",
    eventDate: "2026-08-15", locationText: "Bandra, Mumbai", price: "12000",
  });
  assert.equal(parsed.price, 12000);
  assert.equal(parsed.advancePaid, false);
});

test("quickBookingSchema rejects missing price, bad phone, and bad date", () => {
  const base = {
    clientName: "Meera", clientWhatsApp: "+919876543210", eventType: "Party",
    eventDate: "2026-08-15", locationText: "Mumbai", price: 5000,
  };
  assert.throws(() => quickBookingSchema.parse({ ...base, price: 0 }));
  assert.throws(() => quickBookingSchema.parse({ ...base, clientWhatsApp: "abc" }));
  assert.throws(() => quickBookingSchema.parse({ ...base, eventDate: "15-08-2026" }));
});

// --- Automatic payment reminders (dueAdvanceMarker / balanceReminderDue) -------

const { dueAdvanceMarker, balanceReminderDue } = await import("../src/services/reminders.ts");

test("dueAdvanceMarker nudges at 2/5/8 days and never repeats a sent marker", () => {
  const now = new Date("2026-06-10T12:00:00Z");
  const bookedAt = (daysAgo) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  // Too fresh — no nudge yet.
  assert.equal(dueAdvanceMarker(bookedAt(1), "", now), null);
  // First nudge at 2 days.
  assert.equal(dueAdvanceMarker(bookedAt(2), "", now), "payadv1");
  // 6 days old with nothing sent: sends the latest eligible nudge only.
  assert.equal(dueAdvanceMarker(bookedAt(6), "", now), "payadv2");
  // 9 days old, third nudge — unless already sent.
  assert.equal(dueAdvanceMarker(bookedAt(9), "", now), "payadv3");
  assert.equal(dueAdvanceMarker(bookedAt(9), "7, payadv3", now), null);
  // Junk bookedAt never throws.
  assert.equal(dueAdvanceMarker("not a date", "", now), null);
});

test("balanceReminderDue fires within 2 days of the event, once", () => {
  const now = new Date("2026-06-10T12:00:00Z");
  assert.equal(balanceReminderDue("2026-06-12", "", now), true);
  assert.equal(balanceReminderDue("2026-06-11", "7,1", now), true);
  // Already sent / too far away / past event / junk → no.
  assert.equal(balanceReminderDue("2026-06-12", "paybal", now), false);
  assert.equal(balanceReminderDue("2026-06-20", "", now), false);
  assert.equal(balanceReminderDue("2026-06-01", "", now), false);
  assert.equal(balanceReminderDue("", "", now), false);
});

// --- Lead detail edits (editLeadDetailsSchema) ---------------------------------

const { editLeadDetailsSchema } = await import("../src/api-schema.ts");

test("editLeadDetailsSchema accepts partial updates and rejects bad formats", () => {
  // Only what's provided is validated — a venue-only fix is fine.
  const venueOnly = editLeadDetailsSchema.parse({ locationText: "Taj Lands End, Mumbai" });
  assert.equal(venueOnly.locationText, "Taj Lands End, Mumbai");
  assert.equal(venueOnly.clientName, undefined);
  // Bad phone / date are rejected even in partial updates.
  assert.throws(() => editLeadDetailsSchema.parse({ clientWhatsApp: "abc" }));
  assert.throws(() => editLeadDetailsSchema.parse({ eventDate: "15-08-2026" }));
  // Empty object is a valid no-op payload.
  assert.deepEqual(Object.keys(editLeadDetailsSchema.parse({})).length, 0);
});
