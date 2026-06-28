import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";

const { bookingToRow, rowToBooking } = await import("../src/services/booking.ts");
const { bookingHeaders } = await import("../src/services/sheet-definitions.ts");

const fullBooking = {
  bookingId: "B1", leadId: "L1", bookedAt: "2026-06-01T00:00:00.000Z",
  clientName: "Priya", clientWhatsApp: "919999999999",
  eventType: "Bridal", eventDate: "2026-12-01", eventTime: "09:00",
  venue: "Bandra", assignedArtist: "Aisha", finalPrice: 15000,
  advanceAmount: 5000, balanceDue: 10000,
  tentativeCalendarEventId: "tev", confirmedCalendarEventId: "cev",
  contractUrl: "c", invoiceUrl: "i", paymentStatus: "Advance Paid",
  status: "Completed", contractStatus: "Signed", contractSentAt: "x",
  invoiceGeneratedAt: "y", remindersSent: "review", invoiceVoidedAt: "",
  contractVoidedAt: "", invoiceAdjustments: "", contractAdjustments: "",
  orderItems: "", contractSignedAt: "z", contractSignerName: "Priya",
  expenses: "", invoiceNumber: "INV-1", paymentsLog: "[]", invoiceViewedAt: "",
  contractViewedAt: "", invoiceDueDate: "2026-12-15",
  arrivedAt: "2026-12-01T03:30:00.000Z",
  statusChangedAt: "2026-12-02T06:00:00.000Z",
};

// The bug this guards: a booking row written wider than the sheet's column range
// (bookingHeaders) silently truncates on read and can 400 on update. The row
// array and the header list MUST stay the same width.
test("bookingToRow width matches bookingHeaders (no sheet truncation)", () => {
  assert.equal(bookingToRow(fullBooking).length, bookingHeaders.length);
});

test("statusChangedAt and arrivedAt round-trip through the sheet row", () => {
  const row = bookingToRow(fullBooking).map((v) => String(v ?? ""));
  const back = rowToBooking(row);
  assert.equal(back.statusChangedAt, fullBooking.statusChangedAt);
  assert.equal(back.arrivedAt, fullBooking.arrivedAt);
  assert.equal(back.status, "Completed");
});

test("legacy rows missing the new trailing columns still read safely", () => {
  // An old 36-column row (no arrivedAt / statusChangedAt) must not throw and
  // should default the missing fields to "".
  const legacy = bookingToRow(fullBooking).map((v) => String(v ?? "")).slice(0, 36);
  const back = rowToBooking(legacy);
  assert.equal(back.arrivedAt, "");
  assert.equal(back.statusChangedAt, "");
  assert.equal(back.bookingId, "B1");
});
