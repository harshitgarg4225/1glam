import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Config reads env at import time, so set required vars before importing.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";
process.env.RAZORPAY_KEY_ID = "rzp_test_abc123";
process.env.RAZORPAY_KEY_SECRET = "razorpay-secret-key-for-tests-000";
process.env.RAZORPAY_WEBHOOK_SECRET = "razorpay-webhook-secret-for-tests";

const { verifyCheckoutSignature, verifyWebhookSignature, razorpayConfigured, razorpayTestMode } =
  await import("../src/services/razorpay.ts");
const { CREDIT_PACKS, findPack, USAGE_COSTS } = await import("../src/services/wallet.ts");

test("checkout signature verifies a genuine Razorpay signature", () => {
  const orderId = "order_ABC123";
  const paymentId = "pay_XYZ789";
  const signature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET as string)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature }), true);
});

test("checkout signature rejects a forged signature", () => {
  assert.equal(
    verifyCheckoutSignature({ orderId: "order_ABC123", paymentId: "pay_XYZ789", signature: "forged" }),
    false,
  );
});

test("checkout signature rejects a tampered order id", () => {
  const signature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET as string)
    .update(`order_REAL|pay_X`)
    .digest("hex");
  assert.equal(verifyCheckoutSignature({ orderId: "order_HACKED", paymentId: "pay_X", signature }), false);
});

test("webhook signature verifies over the raw body", () => {
  const body = JSON.stringify({ event: "payment.captured", payload: {} });
  const signature = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET as string)
    .update(body)
    .digest("hex");
  assert.equal(verifyWebhookSignature(body, signature), true);
});

test("webhook signature rejects a body that was modified in transit", () => {
  const signature = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET as string)
    .update(JSON.stringify({ event: "payment.captured" }))
    .digest("hex");
  assert.equal(verifyWebhookSignature(JSON.stringify({ event: "payment.failed" }), signature), false);
});

test("razorpay reports configured and test mode from test keys", () => {
  assert.equal(razorpayConfigured(), true);
  assert.equal(razorpayTestMode(), true);
});

test("credit packs are internally consistent", () => {
  assert.ok(CREDIT_PACKS.length >= 2);
  for (const pack of CREDIT_PACKS) {
    assert.ok(pack.amountInr > 0, `${pack.id} must cost more than 0`);
    // Credits should never be worth less than rupees paid (1 credit >= ₹1).
    assert.ok(pack.credits >= pack.amountInr, `${pack.id} must give at least 1 credit per rupee`);
  }
});

test("findPack resolves known packs and rejects unknown ones", () => {
  assert.equal(findPack("starter")?.id, "starter");
  assert.equal(findPack("does-not-exist"), undefined);
});

test("usage costs are all positive integers", () => {
  for (const [kind, cost] of Object.entries(USAGE_COSTS)) {
    assert.ok(Number.isInteger(cost) && cost > 0, `${kind} cost must be a positive integer`);
  }
});
