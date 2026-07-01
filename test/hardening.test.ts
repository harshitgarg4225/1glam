import { test } from "node:test";
import assert from "node:assert/strict";

// Config reads env at import time, so set required vars before importing modules
// that transitively pull it in (booking.ts → config.ts).
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";

const { isPublicHttpUrl, isPrivateIp, isPublicHttpUrlResolved } = await import("../src/services/http.ts");
const { roundToPremiumNumber } = await import("../src/services/booking.ts");
const { parseDocumentAdjustments, parseOrderItems, travelLineItem } = await import("../src/services/documents.ts");
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

// --- Travel itemisation (travelLineItem) -------------------------------------

test("travelLineItem renders a labelled line with the km when known", () => {
  const lines = travelLineItem(1500, 18);
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], "Travel & Conveyance (~18 km)");
  assert.match(lines[0][1], /1,500/);
});

test("travelLineItem omits the km when distance is unknown (bookings)", () => {
  const lines = travelLineItem(1500);
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], "Travel & Conveyance");
});

test("travelLineItem returns nothing for zero/negative/NaN travel (no phantom line)", () => {
  assert.deepEqual(travelLineItem(0, 10), []);
  assert.deepEqual(travelLineItem(-5), []);
  assert.deepEqual(travelLineItem(NaN), []);
  assert.deepEqual(travelLineItem(undefined as unknown as number), []);
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

test("quickBookingSchema rejects bad phone and bad date, allows decide-later price/venue", () => {
  const base = {
    clientName: "Meera", clientWhatsApp: "+919876543210", eventType: "Party",
    eventDate: "2026-08-15", locationText: "Mumbai", price: 5000,
  };
  assert.throws(() => quickBookingSchema.parse({ ...base, price: -1 }));
  assert.throws(() => quickBookingSchema.parse({ ...base, clientWhatsApp: "abc" }));
  assert.throws(() => quickBookingSchema.parse({ ...base, eventDate: "15-08-2026" }));
  // Price 0 and a missing venue mean "block the date now, settle details later".
  assert.equal(quickBookingSchema.parse({ ...base, price: 0 }).price, 0);
  const noExtras = quickBookingSchema.parse({
    clientName: "Meera", clientWhatsApp: "+919876543210", eventType: "Party", eventDate: "2026-08-15",
  });
  assert.equal(noExtras.price, 0);
  assert.equal(noExtras.locationText, "To be decided");
});

// --- Per-occasion calendar durations (durationHoursForEvent) -------------------

const { durationHoursForEvent } = await import("../src/services/booking.ts");

test("durationHoursForEvent reads config, falls back per occasion, ignores junk", () => {
  const cfg = "Bridal=5, Party=1.5, Shoot=abc, Reception=0";
  assert.equal(durationHoursForEvent(cfg, "Bridal"), 5);          // configured
  assert.equal(durationHoursForEvent(cfg, "bridal"), 5);          // case-insensitive
  assert.equal(durationHoursForEvent(cfg, "Party"), 1.5);         // decimals fine
  assert.equal(durationHoursForEvent(cfg, "Shoot"), 1);           // junk value → default (1h)
  assert.equal(durationHoursForEvent(cfg, "Reception"), 1);       // zero → default (1h)
  assert.equal(durationHoursForEvent(cfg, "Engagement"), 1);      // unconfigured → default (1h)
  assert.equal(durationHoursForEvent("", "Bridal"), 3);           // empty config → Bridal default 3h
  assert.equal(durationHoursForEvent(undefined, "Mystery"), 1);   // unknown occasion → 1h
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

// --- Reschedule re-arms event-date reminders (remindersSentAfterReschedule) ----

const { remindersSentAfterReschedule } = await import("../src/services/booking.ts");

test("remindersSentAfterReschedule clears event-date markers, keeps the rest", () => {
  // Pre-event reminders (numeric) and the balance reminder must re-arm…
  assert.equal(remindersSentAfterReschedule("7,1,paybal"), "");
  // …while advance nudges (booking-date) and rebook (post-event) survive.
  assert.equal(remindersSentAfterReschedule("7,payadv1,payadv2,paybal"), "payadv1,payadv2");
  assert.equal(remindersSentAfterReschedule("1,rebook"), "rebook");
  // Whitespace tolerant; empty stays empty.
  assert.equal(remindersSentAfterReschedule(" 7 , payadv3 "), "payadv3");
  assert.equal(remindersSentAfterReschedule(""), "");
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

// --- Sequential document numbers (nextDocumentNumber) ---------------------------

const { nextDocumentNumber } = await import("../src/services/documents.ts");

test("nextDocumentNumber issues professional, year-scoped sequences", () => {
  const now = new Date("2026-06-10T12:00:00Z");
  // First document of the year.
  assert.equal(nextDocumentNumber("Q", [], now), "Q-2026-0001");
  // Continues past the highest issued number, ignoring junk and other years.
  assert.equal(
    nextDocumentNumber("Q", ["Q-2026-0001", "Q-2026-0007", "Q-2025-0042", "", null, "garbage"], now),
    "Q-2026-0008",
  );
  // Separate sequence per prefix.
  assert.equal(nextDocumentNumber("INV", ["Q-2026-0007"], now), "INV-2026-0001");
  // New year restarts at 0001.
  assert.equal(
    nextDocumentNumber("INV", ["INV-2026-0031"], new Date("2027-01-02T08:00:00Z")),
    "INV-2027-0001",
  );
});

test("nextDocumentNumber buckets by the IST calendar year, not the server's UTC year", () => {
  // 18:29 UTC on Dec 31 is 23:59 IST the SAME day — still 2026 in India.
  assert.equal(nextDocumentNumber("INV", [], new Date("2026-12-31T18:29:00Z")), "INV-2026-0001");
  // 18:30 UTC on Dec 31 is 00:00 IST on Jan 1 — the new year's sequence. A UTC
  // host would have kept this in 2026 and corrupted the GST invoice sequence.
  assert.equal(nextDocumentNumber("INV", ["INV-2026-0031"], new Date("2026-12-31T18:30:00Z")), "INV-2027-0001");
});

test("nextDocumentNumber buckets by the workspace timezone", () => {
  // 18:30 UTC on Dec 31 = Jan 1 in IST, but still Dec 31 (13:30) in New York.
  const t = new Date("2026-12-31T18:30:00Z");
  assert.equal(nextDocumentNumber("INV", [], t, "Asia/Kolkata"), "INV-2027-0001");
  assert.equal(nextDocumentNumber("INV", [], t, "America/New_York"), "INV-2026-0001");
});

// --- Partial payment ledger (parsePaymentsLog / derivePaymentStatus) ------------

const { parsePaymentsLog, paymentsTotal, derivePaymentStatus } = await import("../src/services/booking.ts");

test("parsePaymentsLog tolerates junk and keeps only positive amounts", () => {
  assert.deepEqual(parsePaymentsLog(""), []);
  assert.deepEqual(parsePaymentsLog("not json"), []);
  assert.deepEqual(parsePaymentsLog('{"amount":5}'), []);
  const log = parsePaymentsLog(JSON.stringify([
    { amount: 5000, method: "UPI", note: "advance", at: "2026-06-01T10:00:00Z" },
    { amount: -100, method: "Cash" },
    { amount: "3000", method: "Cash", note: "", at: "" },
  ]));
  assert.equal(log.length, 2);
  assert.equal(paymentsTotal(log), 8000);
});

test("paymentsTotal excludes no-show/cancellation fee entries (not collected income)", () => {
  const log = parsePaymentsLog(JSON.stringify([
    { amount: 9000, method: "UPI", note: "advance", kind: "payment", at: "2026-06-01T10:00:00Z" },
    { amount: 15000, method: "", note: "No-show fee (50%)", kind: "fee", at: "2026-06-02T00:00:00Z" },
    { amount: 500, method: "UPI", note: "", kind: "tip", at: "2026-06-03T00:00:00Z" },
  ]));
  assert.equal(log.length, 3);
  assert.equal(log[1].kind, "fee"); // the parser preserves the fee kind (doesn't coerce to payment)
  // Only the real ₹9,000 payment counts as collected — the fee and tip don't.
  assert.equal(paymentsTotal(log), 9000);
});

test("derivePaymentStatus reflects the money actually received", () => {
  // Nothing received yet.
  assert.equal(derivePaymentStatus(50000, 15000, 0), "Advance Due");
  // Partial advance is still due.
  assert.equal(derivePaymentStatus(50000, 15000, 5000), "Advance Due");
  // Advance covered.
  assert.equal(derivePaymentStatus(50000, 15000, 15000), "Advance Paid");
  assert.equal(derivePaymentStatus(50000, 15000, 30000), "Advance Paid");
  // Fully paid (including overpayment).
  assert.equal(derivePaymentStatus(50000, 15000, 50000), "Paid in Full");
  assert.equal(derivePaymentStatus(50000, 15000, 55000), "Paid in Full");
});

// --- Recorded payment input (recordPaymentSchema) --------------------------------

const { recordPaymentSchema } = await import("../src/api-schema.ts");

test("recordPaymentSchema accepts instalments and rejects bad amounts", () => {
  const ok = recordPaymentSchema.parse({ amount: "5000", method: "Cash", note: "mid payment" });
  assert.equal(ok.amount, 5000);
  assert.equal(ok.method, "Cash");
  const defaulted = recordPaymentSchema.parse({ amount: 1200 });
  assert.equal(defaulted.method, "UPI");
  assert.equal(defaulted.note, "");
  assert.throws(() => recordPaymentSchema.parse({ amount: 0 }));
  assert.throws(() => recordPaymentSchema.parse({ amount: -50 }));
  assert.throws(() => recordPaymentSchema.parse({ amount: 100, method: "Cheque" }));
});

// --- Brand colour on documents (parseHexColor) -----------------------------------

const { parseHexColor, getDocumentTheme } = await import("../src/services/document-themes.ts");

test("parseHexColor accepts #RGB/#RRGGBB and rejects junk and near-white", () => {
  const terracotta = parseHexColor("#C26B45");
  assert.ok(terracotta);
  assert.ok(Math.abs(terracotta.red - 0xc2 / 255) < 1e-6);
  assert.ok(parseHexColor("#abc"));
  assert.equal(parseHexColor(""), null);
  assert.equal(parseHexColor("red"), null);
  assert.equal(parseHexColor("#12345"), null);
  // Near-white would be unreadable on paper — fall back to stock theme.
  assert.equal(parseHexColor("#ffffff"), null);
  assert.equal(parseHexColor("#fefefe"), null);
});

test("getDocumentTheme tints with the brand colour but keeps body text readable", () => {
  const stock = getDocumentTheme("classic");
  const branded = getDocumentTheme("classic", "#C26B45");
  // Headings take the brand hue.
  assert.notDeepEqual(branded.title, stock.title);
  assert.deepEqual(branded.title, branded.sectionHeading);
  // Body copy unchanged for readability.
  assert.deepEqual(branded.bodyText, stock.bodyText);
  // A bad brand colour falls back to the stock theme untouched.
  assert.deepEqual(getDocumentTheme("classic", "not-a-colour"), stock);
});

// --- Discounts on documents (parseDocumentAdjustments) ---------------------------

test("parseDocumentAdjustments keeps a valid discount and drops junk ones", () => {
  assert.equal(parseDocumentAdjustments(JSON.stringify({ discountPercent: 10 })).discountPercent, 10);
  assert.equal(parseDocumentAdjustments(JSON.stringify({ discountPercent: 12.5 })).discountPercent, 12.5);
  // 0, negative, ≥100 and non-numeric are all ignored.
  assert.equal(parseDocumentAdjustments(JSON.stringify({ discountPercent: 0 })).discountPercent, undefined);
  assert.equal(parseDocumentAdjustments(JSON.stringify({ discountPercent: -5 })).discountPercent, undefined);
  assert.equal(parseDocumentAdjustments(JSON.stringify({ discountPercent: 100 })).discountPercent, undefined);
  assert.equal(parseDocumentAdjustments(JSON.stringify({ discountPercent: "lots" })).discountPercent, undefined);
});

// --- Refunds in the payment ledger -----------------------------------------------

test("refund entries subtract from the total and statuses reflect net money", () => {
  const log = parsePaymentsLog(JSON.stringify([
    { amount: 15000, method: "UPI", kind: "payment", at: "2026-01-05" },
    { amount: 5000, method: "Bank Transfer", kind: "refund", at: "2026-02-01", note: "date changed" },
  ]));
  assert.equal(log.length, 2);
  assert.equal(log[1].kind, "refund");
  assert.equal(paymentsTotal(log), 10000);
  // Net of the refund the advance (15k) is no longer fully covered.
  assert.equal(derivePaymentStatus(50000, 15000, paymentsTotal(log)), "Advance Due");
  // Entries without a kind default to payments (backwards compatible).
  const legacy = parsePaymentsLog(JSON.stringify([{ amount: 5000, method: "Cash" }]));
  assert.equal(legacy[0].kind, "payment");
  assert.equal(paymentsTotal(legacy), 5000);
});

test("recordPaymentSchema accepts refunds and defaults to payment", () => {
  assert.equal(recordPaymentSchema.parse({ amount: 100 }).type, "payment");
  assert.equal(recordPaymentSchema.parse({ amount: 100, type: "refund" }).type, "refund");
  assert.throws(() => recordPaymentSchema.parse({ amount: 100, type: "chargeback" }));
});

test("isPrivateIp flags loopback / private / link-local / metadata ranges", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "224.0.0.1"]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "173.0.0.1", "20.20.20.20"]) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test("isPublicHttpUrlResolved rejects private literals/schemes and allows public literals", async () => {
  assert.equal(await isPublicHttpUrlResolved("http://169.254.169.254/latest/meta-data"), false); // cloud metadata
  assert.equal(await isPublicHttpUrlResolved("http://127.0.0.1/x"), false);
  assert.equal(await isPublicHttpUrlResolved("http://localhost/x"), false);
  assert.equal(await isPublicHttpUrlResolved("file:///etc/passwd"), false); // non-http scheme
  assert.equal(await isPublicHttpUrlResolved("https://8.8.8.8/logo.png"), true); // public IP literal (no DNS needed)
});
