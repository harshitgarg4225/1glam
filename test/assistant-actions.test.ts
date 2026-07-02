import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";

const { buildAssistantSnapshot, validateAssistantActions } = await import("../src/services/assistant.ts");

// Minimal snapshot for validator tests — the validator only reads id/name/
// status/payment/balance, so this stays small and explicit.
const snapshot = {
  today: "2026-07-01",
  openLeads: [
    { id: "L1", name: "Priya", event: "Bridal", date: "2026-08-01", status: "New", price: 30000, lastContact: "", place: "Bandra" },
  ],
  bookings: [
    { id: "B_DUE", name: "Asha", event: "Bridal", date: "2026-08-10", status: "Confirmed", price: 30000, advance: 9000, balance: 30000, payment: "Advance Due", venue: "" },
    { id: "B_PART", name: "Meera", event: "Party", date: "2026-08-12", status: "Confirmed", price: 10000, advance: 3000, balance: 7000, payment: "Advance Paid", venue: "" },
    { id: "B_PAID", name: "Zoya", event: "Shoot", date: "2026-08-15", status: "Confirmed", price: 8000, advance: 0, balance: 0, payment: "Paid in Full", venue: "" },
    { id: "B_CANC", name: "Rhea", event: "Party", date: "2026-08-20", status: "Cancelled", price: 5000, advance: 0, balance: 0, payment: "Advance Due", venue: "" },
  ],
  totals: { openLeadCount: 1, bookingCount: 4, confirmedUpcomingRevenue: 0, advancesPending: 0 },
};

test("assistant actions: hallucinated ids and unknown types are dropped", () => {
  const out = validateAssistantActions(
    [
      { type: "send_advance_reminder", id: "B_NOPE" },   // id not in snapshot
      { type: "delete_everything", id: "B_DUE" },        // type not whitelisted
      { type: "open_lead", id: "B_DUE" },                // booking id used as lead
      "garbage",
      null,
    ],
    snapshot,
  );
  assert.deepEqual(out, []);
});

test("assistant actions: state gates block invalid proposals", () => {
  const out = validateAssistantActions(
    [
      { type: "send_advance_reminder", id: "B_PAID" },   // paid in full → no
      { type: "send_advance_reminder", id: "B_PART" },   // advance already paid → no
      { type: "send_balance_reminder", id: "B_DUE" },    // advance not yet paid → no
      { type: "record_payment", id: "B_PAID" },          // nothing to record → no
      { type: "record_payment", id: "B_CANC" },          // cancelled → no
      { type: "send_invoice", id: "B_CANC" },            // cancelled → no
      { type: "ask_review", id: "B_CANC" },              // cancelled → no
    ],
    snapshot,
  );
  assert.deepEqual(out, []);
});

test("assistant actions: valid proposals pass with server-built labels", () => {
  const out = validateAssistantActions(
    [
      { type: "send_advance_reminder", id: "B_DUE" },
      { type: "send_balance_reminder", id: "B_PART" },
      { type: "record_payment", id: "B_DUE" },
      { type: "open_lead", id: "L1" },
      { type: "send_advance_reminder", id: "B_DUE" },    // duplicate → dropped
    ],
    snapshot,
  );
  assert.equal(out.length, 4);
  assert.equal(out[0].label, "Send advance reminder — Asha");
  assert.equal(out[3].type, "open_lead");
  assert.ok(out[3].label.includes("Priya"));
});

test("assistant actions: capped at 8 even with many valid proposals", () => {
  const many = Array.from({ length: 20 }, (_, i) => (
    [{ type: "record_payment", id: "B_DUE" }, { type: "send_advance_reminder", id: "B_DUE" },
     { type: "open_booking", id: "B_DUE" }, { type: "send_invoice", id: "B_DUE" },
     { type: "send_contract", id: "B_DUE" }, { type: "mark_completed", id: "B_DUE" },
     { type: "ask_review", id: "B_DUE" }, { type: "open_booking", id: "B_PART" },
     { type: "record_payment", id: "B_PART" }, { type: "send_balance_reminder", id: "B_PART" }][i % 10]
  ));
  const out = validateAssistantActions(many, snapshot);
  assert.ok(out.length <= 8, `expected <=8, got ${out.length}`);
});

test("snapshot rows carry the ids the action layer needs", () => {
  const lead = {
    leadId: "L9", clientName: "Nia", eventType: "Bridal", eventDate: "2026-09-01", status: "New",
    finalApprovedPrice: 20000, initialAiPrice: 20000, lastContactedAt: "", locationText: "Juhu",
  };
  const booking = {
    bookingId: "B9", clientName: "Nia", eventType: "Bridal", eventDate: "2026-09-01", status: "Confirmed",
    finalPrice: 20000, advanceAmount: 6000, balanceDue: 20000, paymentStatus: "Advance Due", venue: "Juhu",
  };
  const snap = buildAssistantSnapshot([lead as never], [booking as never]);
  assert.equal(snap.openLeads[0].id, "L9");
  assert.equal(snap.bookings[0].id, "B9");
  assert.equal(snap.bookings[0].status, "Confirmed");
});
