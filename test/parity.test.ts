import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";

const { computeLoyaltyStatuses, loyaltyForPhone } = await import("../src/services/loyalty.ts");
const { generateGiftCode, parseGiftCard, giftCardToRow } = await import("../src/services/gift-cards.ts");
const { buildDefaultConfig } = await import("../src/defaults.ts");

const baseConfig = () =>
  buildDefaultConfig({ email: "aisha@example.com", name: "Aisha Khan" });

const bookingStub = (over: Record<string, unknown>) => ({
  bookingId: "B1", leadId: "L1", bookedAt: new Date().toISOString(),
  clientName: "Priya", clientWhatsApp: "919999999999",
  eventType: "Bridal", eventDate: "2026-12-01", eventTime: "09:00",
  venue: "Bandra", assignedArtist: "Aisha", finalPrice: 15000,
  advanceAmount: 5000, balanceDue: 10000,
  tentativeCalendarEventId: "", confirmedCalendarEventId: "",
  contractUrl: "", invoiceUrl: "", paymentStatus: "Advance Paid",
  status: "Confirmed", contractStatus: "", contractSentAt: "",
  invoiceGeneratedAt: "", remindersSent: "", invoiceVoidedAt: "",
  contractVoidedAt: "", invoiceAdjustments: "", contractAdjustments: "",
  orderItems: "", contractSignedAt: "", contractSignerName: "",
  expenses: "", invoiceNumber: "", paymentsLog: "", invoiceViewedAt: "",
  contractViewedAt: "",
  ...over,
});

// --- Loyalty program -------------------------------------------------------

test("loyalty is off when disabled, on when enabled", () => {
  const cfg = { ...baseConfig(), loyaltyEnabled: "No" };
  assert.deepEqual(computeLoyaltyStatuses(cfg, [bookingStub({})]), []);

  const cfg2 = { ...baseConfig(), loyaltyEnabled: "Yes", loyaltyVisitsForReward: 3 };
  const result = computeLoyaltyStatuses(cfg2, [bookingStub({})]);
  assert.equal(result.length, 1);
});

test("visit counter accumulates correctly per phone", () => {
  const cfg = { ...baseConfig(), loyaltyEnabled: "Yes", loyaltyVisitsForReward: 3 };
  const bookings = [
    bookingStub({ clientWhatsApp: "91111", clientName: "Priya" }),
    bookingStub({ clientWhatsApp: "91111", clientName: "Priya" }),
    bookingStub({ clientWhatsApp: "91222", clientName: "Neha" }),
  ];
  const result = computeLoyaltyStatuses(cfg, bookings);
  const priya = result.find((r) => r.phone === "91111");
  assert.equal(priya?.visits, 2);
  assert.equal(priya?.rewardEarned, false);

  const neha = result.find((r) => r.phone === "91222");
  assert.equal(neha?.visits, 1);
});

test("reward is earned exactly at milestone, not before", () => {
  const cfg = { ...baseConfig(), loyaltyEnabled: "Yes", loyaltyVisitsForReward: 3 };
  const bookings = Array.from({ length: 3 }, () => bookingStub({ clientWhatsApp: "91111" }));
  const [status] = computeLoyaltyStatuses(cfg, bookings);
  assert.equal(status.rewardEarned, true);
  assert.equal(status.visits, 3);
});

test("cancelled bookings do not count toward loyalty", () => {
  const cfg = { ...baseConfig(), loyaltyEnabled: "Yes", loyaltyVisitsForReward: 2 };
  const bookings = [
    bookingStub({ clientWhatsApp: "91111", status: "Cancelled" }),
    bookingStub({ clientWhatsApp: "91111", status: "Confirmed" }),
  ];
  const [status] = computeLoyaltyStatuses(cfg, bookings);
  assert.equal(status.visits, 1);
  assert.equal(status.rewardEarned, false);
});

test("loyaltyForPhone returns null for unknown phone", () => {
  const cfg = { ...baseConfig(), loyaltyEnabled: "Yes" };
  const result = loyaltyForPhone(cfg, [bookingStub({})], "99999");
  assert.equal(result, null);
});

test("loyaltyForPhone returns correct status for known phone", () => {
  const cfg = { ...baseConfig(), loyaltyEnabled: "Yes", loyaltyVisitsForReward: 5, loyaltyRewardValue: 1000 };
  const bookings = Array.from({ length: 5 }, () => bookingStub({ clientWhatsApp: "91111", clientName: "Priya" }));
  const status = loyaltyForPhone(cfg, bookings, "91111");
  assert.ok(status);
  assert.equal(status.rewardEarned, true);
  assert.match(status.rewardNote, /1,000|1000/);
});

test("reward cycles reset correctly after milestone — 6 visits with milestone=5", () => {
  const cfg = { ...baseConfig(), loyaltyEnabled: "Yes", loyaltyVisitsForReward: 5 };
  const bookings = Array.from({ length: 6 }, () => bookingStub({ clientWhatsApp: "91111" }));
  const [status] = computeLoyaltyStatuses(cfg, bookings);
  assert.equal(status.rewardEarned, false);
  assert.equal(status.nextMilestone, 10);
});

// --- Gift cards ------------------------------------------------------------

test("generateGiftCode produces 8-char uppercase alphanumeric string", () => {
  const code = generateGiftCode();
  assert.equal(code.length, 8);
  assert.match(code, /^[A-Z2-9]+$/);
});

test("gift code uniqueness — 100 codes all distinct", () => {
  const codes = new Set(Array.from({ length: 100 }, generateGiftCode));
  assert.equal(codes.size, 100);
});

test("parseGiftCard round-trips through giftCardToRow", () => {
  const original = {
    cardId: "GC-1",
    code: "ABCD1234",
    amount: 5000,
    message: "Happy birthday!",
    purchaserName: "Priya",
    purchaserEmail: "priya@example.com",
    purchaserWhatsApp: "919999",
    redeemedByLeadId: "",
    redeemedAt: "",
    createdAt: "2026-06-01T00:00:00.000Z",
    status: "Active" as const,
  };
  const row = giftCardToRow(original);
  const parsed = parseGiftCard(row);
  assert.deepEqual(parsed, original);
});

test("parseGiftCard handles empty/short rows gracefully", () => {
  const card = parseGiftCard([]);
  assert.equal(card.amount, 0);
  assert.equal(card.status, "Active");
  assert.equal(card.code, "");
});
