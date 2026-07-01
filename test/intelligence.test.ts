import { test } from "node:test";
import assert from "node:assert/strict";

// Config reads env at import time, so set required vars before importing
// modules that transitively pull it in.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";

const { computeSlotAvailability, travelCostForDistance, computeAdvanceAmount, depositPercentForEvent, paymentsTotal, tipsTotal, parsePaymentsLog } = await import("../src/services/booking.ts");
const { parseQuotePackages, parseDocumentAdjustments } = await import("../src/services/documents.ts");
const { computeInsights, buildDigestSummary, buildServicesContext } = await import("../src/services/insights.ts");
const { matchSelectedAddons, parseBlockedDates } = await import("../src/services/public-booking.ts");
const { buildDefaultConfig } = await import("../src/defaults.ts");

const baseConfig = () =>
  buildDefaultConfig({ email: "aisha@example.com", name: "Aisha Khan" });

// --- Duration-aware slot availability -----------------------------------------

test("a 4-hour bridal at 09:00 blocks the 11:00 slot but not 14:00", () => {
  const slots = computeSlotAvailability({
    timeSlots: ["09:00", "11:00", "14:00", "16:00"],
    serviceDurations: "Bridal=4, Party=2",
    requestedEventType: "Party",
    busy: [{ eventTime: "09:00", eventType: "Bridal" }],
  });
  assert.deepEqual(
    slots.map((s) => [s.time, s.available]),
    [["09:00", false], ["11:00", false], ["14:00", true], ["16:00", true]],
  );
});

test("a long requested service is blocked when it would run into an existing job", () => {
  // Bridal at 14:00 requested; party at 16:00 already booked — 14:00+4h overlaps 16:00.
  const slots = computeSlotAvailability({
    timeSlots: ["09:00", "14:00"],
    serviceDurations: "Bridal=4, Party=2",
    requestedEventType: "Bridal",
    busy: [{ eventTime: "16:00", eventType: "Party" }],
  });
  assert.equal(slots.find((s) => s.time === "14:00")?.available, false);
  assert.equal(slots.find((s) => s.time === "09:00")?.available, true);
});

test("jobs without a time never block specific slots", () => {
  const slots = computeSlotAvailability({
    timeSlots: ["09:00", "11:00"],
    serviceDurations: "",
    requestedEventType: "Party",
    busy: [{ eventTime: "", eventType: "Bridal" }],
  });
  assert.ok(slots.every((s) => s.available));
});

test("cleanup buffer keeps the slot right after a job free", () => {
  // Party at 09:00 runs 2h (→11:00). With a 60-min buffer the 11:00 slot is
  // blocked (needs cleanup), but 14:00 stays open.
  const withBuffer = computeSlotAvailability({
    timeSlots: ["09:00", "11:00", "14:00"],
    serviceDurations: "Party=2",
    requestedEventType: "Party",
    busy: [{ eventTime: "09:00", eventType: "Party" }],
    bufferMinutes: 60,
  });
  assert.equal(withBuffer.find((s) => s.time === "11:00")?.available, false);
  assert.equal(withBuffer.find((s) => s.time === "14:00")?.available, true);
  // Without a buffer the same 11:00 slot is bookable (back-to-back allowed).
  const noBuffer = computeSlotAvailability({
    timeSlots: ["09:00", "11:00"],
    serviceDurations: "Party=2",
    requestedEventType: "Party",
    busy: [{ eventTime: "09:00", eventType: "Party" }],
  });
  assert.equal(noBuffer.find((s) => s.time === "11:00")?.available, true);
});

test("travel time after a job pushes the next bookable slot later", () => {
  // Party at 09:00 (2h → 11:00) + 90 min travel blocks an 11:00 start.
  const slots = computeSlotAvailability({
    timeSlots: ["11:00", "14:00"],
    serviceDurations: "Party=2",
    requestedEventType: "Party",
    busy: [{ eventTime: "09:00", eventType: "Party", travelMinutes: 90 }],
  });
  assert.equal(slots.find((s) => s.time === "11:00")?.available, false);
  assert.equal(slots.find((s) => s.time === "14:00")?.available, true);
});

// --- Per-service deposit % -----------------------------------------------------

test("per-service deposit overrides the default, else falls back", () => {
  const json = '{"Bridal":50,"Party":0}';
  assert.equal(depositPercentForEvent(json, 30, "Bridal"), 50); // override wins
  assert.equal(depositPercentForEvent(json, 30, "Party"), 30);  // 0 is ignored → default
  assert.equal(depositPercentForEvent(json, 30, "Shoot"), 30);  // unlisted → default
  assert.equal(depositPercentForEvent("", 30, "Bridal"), 30);   // no overrides
  assert.equal(depositPercentForEvent("not json", 30, "Bridal"), 30); // malformed → default
  assert.equal(depositPercentForEvent("", 0, "Bridal"), 30);    // 0 default → 30 floor
});

// --- Tips are tracked but never move the balance -------------------------------

test("tips are excluded from the paid total but summed separately", () => {
  const log = parsePaymentsLog(JSON.stringify([
    { amount: 3000, method: "Razorpay", note: "Online advance payment", kind: "payment" },
    { amount: 500, method: "Razorpay", note: "Tip", kind: "tip" },
    { amount: 200, method: "UPI", note: "overpaid", kind: "refund" },
  ]));
  assert.equal(paymentsTotal(log), 2800); // 3000 - 200 refund; tip excluded
  assert.equal(tipsTotal(log), 500);
});

test("the gateway ref survives a ledger round-trip (needed for refunds)", () => {
  const log = parsePaymentsLog(JSON.stringify([
    { amount: 3000, method: "Razorpay", note: "Online advance payment", kind: "payment", ref: "pay_ABC123" },
  ]));
  assert.equal(log[0].ref, "pay_ABC123");
});

// --- Travel pricing ------------------------------------------------------------

test("travel tiers respect configured boundaries (no hardcoded 25km)", () => {
  const config = {
    travelWithinCity: 0,
    travelNearbyCity: 2000,
    travelOutstation: 5000,
    travelOutstationThresholdKm: 100,
    travelNearbyThresholdKm: 40,
    travelPerKmRate: 0,
  };
  assert.equal(travelCostForDistance(config, 30), 0); // within her custom 40km
  assert.equal(travelCostForDistance(config, 60), 2000);
  assert.equal(travelCostForDistance(config, 100), 5000);
});

test("travel falls back to 25km when threshold missing (older records)", () => {
  const config = {
    travelWithinCity: 0,
    travelNearbyCity: 2000,
    travelOutstation: 5000,
    travelOutstationThresholdKm: 100,
    travelNearbyThresholdKm: 0 as number,
    travelPerKmRate: 0,
  };
  assert.equal(travelCostForDistance(config, 20), 0);
  assert.equal(travelCostForDistance(config, 30), 2000);
});

test("per-km mode replaces flat tiers and rounds to Rs 50", () => {
  const config = {
    travelWithinCity: 0,
    travelNearbyCity: 2000,
    travelOutstation: 5000,
    travelOutstationThresholdKm: 100,
    travelNearbyThresholdKm: 25,
    travelPerKmRate: 18,
  };
  assert.equal(travelCostForDistance(config, 38), 700); // 684 → 700
  assert.equal(travelCostForDistance(config, 0), 0);
});

test("travel tier boundary is inclusive at the nearby threshold (no off-by-one)", () => {
  const config = {
    travelWithinCity: 0,
    travelNearbyCity: 2000,
    travelOutstation: 5000,
    travelOutstationThresholdKm: 100,
    travelNearbyThresholdKm: 25,
    travelPerKmRate: 0,
  };
  assert.equal(travelCostForDistance(config, 24), 0);    // just inside city
  assert.equal(travelCostForDistance(config, 25), 2000); // exactly at threshold → nearby fee
  assert.equal(travelCostForDistance(config, 100), 5000); // exactly at outstation threshold
});

test("computeAdvanceAmount never rounds a small advance to zero and clamps to [0, total]", () => {
  assert.equal(computeAdvanceAmount(1000, 30), 300);
  assert.ok(computeAdvanceAmount(500, 30) > 0);      // premium rounding used to yield 0 here
  assert.equal(computeAdvanceAmount(300, 100), 300); // never exceeds the total
  assert.equal(computeAdvanceAmount(0, 30), 0);
  assert.equal(computeAdvanceAmount(10000, 0), 0);
  // The advance scales with the percentage (premium rounding flattened 30% vs 50%).
  assert.ok(computeAdvanceAmount(10000, 50) > computeAdvanceAmount(10000, 30));
});

// --- Quote packages -------------------------------------------------------------

test("parseQuotePackages parses named bundles with line items and totals", () => {
  const packages = parseQuotePackages(
    "Bridal Classic: HD Makeup=12000, Hair=3000, Draping=800\nParty Glam: Makeup=4000",
  );
  assert.equal(packages.length, 2);
  assert.equal(packages[0].name, "Bridal Classic");
  assert.equal(packages[0].items.length, 3);
  assert.equal(packages[0].total, 15800);
  assert.equal(packages[1].total, 4000);
});

test("parseQuotePackages drops junk lines and junk items", () => {
  const packages = parseQuotePackages("no colon here\nOk: Good=100, Bad=, =5, Neg=-3");
  assert.equal(packages.length, 1);
  assert.deepEqual(packages[0].items, [{ label: "Good", amount: 100 }]);
});

// --- Booking-page add-ons price into the quote ------------------------------------

test("selected add-ons resolve to priced quote line items", () => {
  const config = { ...baseConfig(), serviceBridalAddons: "Airbrush:2000, Saree Draping:800, Free Touch-up:0" };
  const lines = matchSelectedAddons(config, "Bridal", "airbrush, Saree Draping, Unknown Thing, Free Touch-up");
  assert.deepEqual(lines, [
    { label: "Airbrush (add-on)", amount: 2000 },
    { label: "Saree Draping (add-on)", amount: 800 },
  ]);
  assert.deepEqual(matchSelectedAddons(config, "Bridal", ""), []);
  assert.deepEqual(matchSelectedAddons(config, "Party", "Airbrush"), []);
});

// --- Range estimates -------------------------------------------------------------

test("parseDocumentAdjustments keeps a valid price range and drops inverted ones", () => {
  const ok = parseDocumentAdjustments(JSON.stringify({ priceRangeLow: 12000, priceRangeHigh: 15000 }));
  assert.equal(ok.priceRangeLow, 12000);
  assert.equal(ok.priceRangeHigh, 15000);
  const inverted = parseDocumentAdjustments(JSON.stringify({ priceRangeLow: 15000, priceRangeHigh: 12000 }));
  assert.equal(inverted.priceRangeLow, undefined);
});

// --- Insights --------------------------------------------------------------------

const futureDate = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const pastIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const leadStub = (over: Record<string, unknown>) => ({
  leadId: "L1", createdAt: pastIso(1), source: "Booking Page", clientName: "Priya",
  clientWhatsApp: "919999999999", clientInstagram: "", eventType: "Bridal",
  eventDate: futureDate(10), eventTime: "", locationText: "", distanceKm: 0,
  travelTimeMin: 0, outstationFlag: "No", profileTier: "Mid", followers: 0,
  clientTags: "", aiInsight: "", suggestedReply: "", demandCount: 0, scarcityTag: "",
  holdExpiresAt: "", initialAiPrice: 0, finalApprovedPrice: 0, discountPercent: 0,
  ownerDecision: "", ownerNotes: "", status: "New Lead", assignedArtist: "",
  lastContactedAt: "", tentativeCalendarEventId: "", confirmedCalendarEventId: "",
  bookingId: "", paymentStatus: "", quoteUrl: "", quoteGeneratedAt: "", quoteVoidedAt: "",
  quoteAdjustments: "", orderItems: "", quoteNumber: "", quoteViewedAt: "", quoteAcceptedAt: "",
  ...over,
});

test("an open slot with someone waiting produces an action insight", () => {
  const config = { ...baseConfig(), bookingMaxPerDay: 2 };
  const date = futureDate(7);
  const insights = computeInsights({
    config,
    leads: [
      leadStub({ leadId: "L1", eventDate: date, status: "Confirmed" }),
      leadStub({ leadId: "L2", eventDate: date, source: "Waitlist", clientName: "Sneha" }),
    ],
    bookings: [],
  });
  const slotOpen = insights.find((i) => i.kind === "slot_open_waitlist");
  assert.ok(slotOpen, "expected a slot_open_waitlist insight");
  assert.match(slotOpen!.title, /Sneha/);
  assert.deepEqual(slotOpen!.leadIds, ["L2"]);
});

test("a full date with a waitlist produces demand-pressure info", () => {
  const config = { ...baseConfig(), bookingMaxPerDay: 1 };
  const date = futureDate(7);
  const insights = computeInsights({
    config,
    leads: [
      leadStub({ leadId: "L1", eventDate: date, status: "Confirmed" }),
      leadStub({ leadId: "L2", eventDate: date, source: "Waitlist" }),
      leadStub({ leadId: "L3", eventDate: date, source: "Waitlist" }),
    ],
    bookings: [],
  });
  const pressure = insights.find((i) => i.kind === "waitlist_pressure");
  assert.ok(pressure);
  assert.match(pressure!.title, /1 booked \+ 2 waiting/);
});

test("a quote quiet for 4 days produces a nudge; a fresh one does not", () => {
  const insights = computeInsights({
    config: baseConfig(),
    leads: [
      leadStub({
        leadId: "STALE", status: "Awaiting Client", quoteUrl: "https://x/q",
        quoteGeneratedAt: pastIso(4), quoteViewedAt: pastIso(3),
      }),
      leadStub({
        leadId: "FRESH", status: "Awaiting Client", quoteUrl: "https://x/q",
        quoteGeneratedAt: pastIso(1),
      }),
    ],
    bookings: [],
  });
  const stale = insights.filter((i) => i.kind === "stale_quote");
  assert.equal(stale.length, 1);
  assert.deepEqual(stale[0].leadIds, ["STALE"]);
});

test("digest summarizes today's jobs and stays quiet when there's nothing", () => {
  const today = new Date().toISOString().slice(0, 10);
  const booking = {
    bookingId: "B1", leadId: "L1", bookedAt: pastIso(5), clientName: "Sneha",
    clientWhatsApp: "", eventType: "Bridal", eventDate: today, eventTime: "09:00",
    venue: "Bandra", assignedArtist: "", finalPrice: 15000, advanceAmount: 5000,
    balanceDue: 10000, tentativeCalendarEventId: "", confirmedCalendarEventId: "",
    contractUrl: "", invoiceUrl: "", paymentStatus: "Advance Paid", status: "Confirmed",
    contractStatus: "", contractSentAt: "", invoiceGeneratedAt: "", remindersSent: "",
    invoiceVoidedAt: "", contractVoidedAt: "", invoiceAdjustments: "", contractAdjustments: "",
    orderItems: "", contractSignedAt: "", contractSignerName: "", expenses: "",
    invoiceNumber: "", paymentsLog: "", invoiceViewedAt: "", contractViewedAt: "",
  };
  const digest = buildDigestSummary({ config: baseConfig(), leads: [], bookings: [booking] });
  assert.ok(digest);
  assert.match(digest!.body, /Bridal for Sneha at 09:00/);

  const quiet = buildDigestSummary({ config: baseConfig(), leads: [], bookings: [] });
  assert.equal(quiet, null);
});

// --- Live services context for the AI -------------------------------------------

test("buildServicesContext reflects current prices, durations and travel", () => {
  const config = {
    ...baseConfig(),
    basePriceBridal: 15000,
    serviceDurations: "Bridal=4",
    city: "Mumbai",
    travelNearbyCity: 2000,
    travelOutstation: 5000,
    aiServicesContext: "I only take one bridal per day.",
  };
  const text = buildServicesContext(config);
  assert.match(text, /Bridal Makeup: from Rs 15,000 \(about 4h\)/);
  assert.match(text, /Mumbai/);
  assert.match(text, /Owner notes: I only take one bridal per day\./);
});

test("parseBlockedDates keeps single dates and expands inclusive ranges", () => {
  // Single dates unchanged.
  assert.deepEqual(parseBlockedDates("2026-12-25"), ["2026-12-25"]);
  // Range (colon separator) expands inclusively.
  assert.deepEqual(
    parseBlockedDates("2026-12-24:2026-12-27"),
    ["2026-12-24", "2026-12-25", "2026-12-26", "2026-12-27"],
  );
  // ".." and "to" separators, mixed with a single date; deduped.
  const mixed = parseBlockedDates("2026-01-01, 2026-06-10..2026-06-11, 2026-07-01 to 2026-07-01");
  assert.ok(mixed.includes("2026-01-01"));
  assert.ok(mixed.includes("2026-06-10") && mixed.includes("2026-06-11"));
  assert.ok(mixed.includes("2026-07-01"));
  // Junk and reversed ranges are ignored, not thrown.
  assert.deepEqual(parseBlockedDates("garbage, 2026-12-31:2026-12-01"), []);
});
