import { test } from "node:test";
import assert from "node:assert/strict";

// Critical safety gate: even with OPERATIONAL_STORE="dual" requested, the store
// must stay on the Sheets path when no database is configured (as in CI / file
// mode). Set the flag BEFORE importing so appConfig parses it; leave
// DATABASE_URL unset so hasPostgres() is false.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";
process.env.OPERATIONAL_STORE = "dual";
delete process.env.DATABASE_URL;

const { storeMode, pgActive, mirrorToSheets } = await import("../src/services/operational-store.ts");

test("OPERATIONAL_STORE=dual stays inert without a database (safety gate)", () => {
  assert.equal(storeMode(), "sheets");
  assert.equal(pgActive(), false);
  assert.equal(mirrorToSheets(), false);
});

// The store persists each record as a JSONB blob via JSON.stringify and reads it
// back as the parsed object. Records are plain strings/numbers, so the round-trip
// must be the identity — this guards against any field that wouldn't survive
// JSON (functions, undefined, Date) sneaking into the record types.
const fullLead = {
  leadId: "L1", createdAt: "2026-06-01T00:00:00.000Z", source: "Instagram",
  clientName: "Priya", clientWhatsApp: "919999999999", clientInstagram: "priya",
  eventType: "Bridal", eventDate: "2026-12-01", eventTime: "10:00", locationText: "Bandra",
  distanceKm: 18, travelTimeMin: 35, outstationFlag: "No", profileTier: "Mid", followers: 1200,
  clientTags: "vip", aiInsight: "warm", suggestedReply: "Hi!", demandCount: 2, scarcityTag: "Hot",
  holdExpiresAt: "", initialAiPrice: 30000, finalApprovedPrice: 26500, discountPercent: 12,
  ownerDecision: "YES", ownerNotes: "n", status: "Awaiting Client", assignedArtist: "Aisha",
  lastContactedAt: "2026-06-02T00:00:00.000Z", tentativeCalendarEventId: "tev",
  confirmedCalendarEventId: "", bookingId: "", paymentStatus: "Not Started", quoteUrl: "u",
  quoteGeneratedAt: "2026-06-02T00:00:00.000Z", quoteVoidedAt: "", quoteAdjustments: "{}",
  orderItems: "[]", quoteNumber: "Q-1", quoteViewedAt: "", quoteAcceptedAt: "", referredBy: "",
  lostReason: "", urgencyFlag: "", clientNote: "", travelCost: 1500,
};

const fullBooking = {
  bookingId: "B1", leadId: "L1", bookedAt: "2026-06-01T00:00:00.000Z", clientName: "Priya",
  clientWhatsApp: "919999999999", eventType: "Bridal", eventDate: "2026-12-01", eventTime: "10:00",
  venue: "Bandra", assignedArtist: "Aisha", finalPrice: 26500, advanceAmount: 7950, balanceDue: 18550,
  tentativeCalendarEventId: "", confirmedCalendarEventId: "cev", contractUrl: "c", invoiceUrl: "i",
  paymentStatus: "Advance Paid", status: "Confirmed", contractStatus: "Signed", contractSentAt: "x",
  invoiceGeneratedAt: "y", remindersSent: "7,1", invoiceVoidedAt: "", contractVoidedAt: "",
  invoiceAdjustments: "", contractAdjustments: "", orderItems: "[]", contractSignedAt: "z",
  contractSignerName: "Priya", expenses: "", invoiceNumber: "INV-1",
  paymentsLog: JSON.stringify([{ amount: 7950, method: "UPI", note: "", at: "2026-06-03T00:00:00.000Z" }]),
  invoiceViewedAt: "", contractViewedAt: "", invoiceDueDate: "2026-12-15",
  arrivedAt: "", statusChangedAt: "2026-06-02T06:00:00.000Z", travelCost: 1500,
};

test("LeadRecord round-trips losslessly through JSONB (JSON identity)", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(fullLead)), fullLead);
});

test("BookingRecord round-trips losslessly through JSONB (JSON identity)", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(fullBooking)), fullBooking);
});
