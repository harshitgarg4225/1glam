import { test } from "node:test";
import assert from "node:assert/strict";

// Real-Postgres integration test for the operational store (the system of record
// for leads/bookings/payments). It SKIPS when DATABASE_URL is unset — so local
// `npm test` and the file-mode CI job are unaffected — and RUNS in the dedicated
// Postgres CI job, where it exercises the SQL paths that file mode never touches:
// upsert, workspace scoping, idempotent backfill, migration markers, and the
// money flows (refund clamp, no-show fee). Without this the money datastore
// ships with zero CI coverage.
const HAS_DB = !!process.env.DATABASE_URL;

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";
if (HAS_DB) process.env.OPERATIONAL_STORE = "postgres";

const db = HAS_DB ? await import("../src/services/database.ts") : null;
const store = HAS_DB ? await import("../src/services/operational-store.ts") : null;
const booking = HAS_DB ? await import("../src/services/booking.ts") : null;
const defaults = HAS_DB ? await import("../src/defaults.ts") : null;

const WS = "ws_pgtest_1";
const T = { access_token: "X", refresh_token: "X" } as const;
const EMAIL = "pgtest@example.com";

function mkLead(id: string, over: Record<string, unknown> = {}) {
  return {
    leadId: id, createdAt: "2026-06-01T00:00:00Z", source: "IG", clientName: "Priya",
    clientWhatsApp: "9199", clientInstagram: "", eventType: "Bridal", eventDate: "2026-12-01",
    eventTime: "10:00", locationText: "Bandra", distanceKm: 18, travelTimeMin: 35, outstationFlag: "No",
    profileTier: "Mid", followers: 0, clientTags: "", aiInsight: "", suggestedReply: "", demandCount: 0,
    scarcityTag: "", holdExpiresAt: "", initialAiPrice: 30000, finalApprovedPrice: 26500, discountPercent: 12,
    ownerDecision: "YES", ownerNotes: "", status: "Awaiting Client", assignedArtist: "Aisha",
    lastContactedAt: "", tentativeCalendarEventId: "", confirmedCalendarEventId: "", bookingId: "",
    paymentStatus: "Not Started", quoteUrl: "", quoteGeneratedAt: "", quoteVoidedAt: "", quoteAdjustments: "",
    orderItems: "", quoteNumber: "Q-1", quoteViewedAt: "", quoteAcceptedAt: "", referredBy: "",
    lostReason: "", urgencyFlag: "", clientNote: "", travelCost: 1500, ...over,
  };
}

function mkBooking(id: string, over: Record<string, unknown> = {}) {
  return {
    bookingId: id, leadId: "L1", bookedAt: "", clientName: "Priya", clientWhatsApp: "9199",
    eventType: "Bridal", eventDate: "2026-12-01", eventTime: "10:00", venue: "V", assignedArtist: "Aisha",
    finalPrice: 30000, advanceAmount: 9000, balanceDue: 21000, tentativeCalendarEventId: "",
    confirmedCalendarEventId: "", contractUrl: "", invoiceUrl: "", paymentStatus: "Advance Paid",
    status: "Confirmed", contractStatus: "Draft", contractSentAt: "", invoiceGeneratedAt: "",
    remindersSent: "", invoiceVoidedAt: "", contractVoidedAt: "", invoiceAdjustments: "",
    contractAdjustments: "", orderItems: "", contractSignedAt: "", contractSignerName: "", expenses: "",
    invoiceNumber: "", paymentsLog: "[]", invoiceViewedAt: "", contractViewedAt: "", invoiceDueDate: "",
    arrivedAt: "", statusChangedAt: "", travelCost: 0, ...over,
  };
}

test("operational store: upsert / scoping / idempotent backfill / markers", { skip: !HAS_DB }, async () => {
  await db!.ensurePostgres();
  await store!.upsertLead(WS, mkLead("L1") as never);
  const got = await store!.findLead(WS, "L1");
  assert.equal(got?.leadId, "L1");
  await store!.upsertLead(WS, mkLead("L1", { status: "Confirmed" }) as never);
  assert.equal((await store!.findLead(WS, "L1"))?.status, "Confirmed");
  assert.equal((await store!.listLeads(WS)).length, 1, "upsert must not duplicate");
  assert.equal((await store!.listLeads("ws_other")).length, 0, "workspace scoping");

  await store!.bulkInsertLeadsIfAbsent(WS, [mkLead("L1", { clientName: "NOPE" }), mkLead("L2"), mkLead("L3")] as never);
  assert.equal((await store!.findLead(WS, "L1"))?.clientName, "Priya", "backfill must not overwrite");
  assert.equal((await store!.listLeads(WS)).length, 3);

  assert.equal(await store!.hasMigrationMarker(WS, "leads"), false);
  await store!.writeMigrationMarker(WS, "leads");
  assert.equal(await store!.hasMigrationMarker(WS, "leads"), true);
});

test("operational store: refund clamp + no-show fee through the real booking path", { skip: !HAS_DB }, async () => {
  await db!.ensurePostgres();
  await db!.saveWorkspace({
    workspaceId: WS, email: EMAIL, name: "A", spreadsheetId: "S", spreadsheetUrl: "", spreadsheetName: "",
    confirmedCalendarId: "c", tentativeCalendarId: "t", tentativeCalendarName: "", createdAt: "", updatedAt: "",
    googleTokens: { access_token: "X", refresh_token: "X" }, config: defaults!.buildDefaultConfig({ email: EMAIL, name: "A" }),
  } as never);
  await store!.writeMigrationMarker(WS, "leads");
  await store!.writeMigrationMarker(WS, "bookings");

  // Refund clamp: ₹9,000 collected, a ₹20,000 refund must clamp to net 0 (never negative).
  await store!.upsertBooking(WS, mkBooking("BR", { paymentsLog: JSON.stringify([{ amount: 9000, method: "UPI", kind: "payment", at: "x" }]) }) as never);
  await booking!.recordBookingPayment(EMAIL, T as never, "BR", { amount: 20000, type: "refund", method: "Cash" });
  const br = await store!.findBooking(WS, "BR");
  assert.equal(booking!.paymentsTotal(booking!.parsePaymentsLog(br!.paymentsLog)), 0, "net collected never negative");

  // No-show fee: recorded as a non-income "fee" entry; collected unchanged, balance closed.
  await store!.upsertBooking(WS, mkBooking("BN", { paymentsLog: JSON.stringify([{ amount: 9000, method: "UPI", kind: "payment", at: "x" }]) }) as never);
  await booking!.markBookingNoShow(EMAIL, T as never, "BN", 50);
  const bn = await store!.findBooking(WS, "BN");
  const log = booking!.parsePaymentsLog(bn!.paymentsLog);
  assert.equal(bn!.status, "No Show");
  assert.ok(log.some((e) => e.kind === "fee" && e.amount === 15000), "fee recorded");
  assert.equal(booking!.paymentsTotal(log), 9000, "fee not counted as collected income");
  assert.equal(bn!.balanceDue, 0, "balance closed");
});
