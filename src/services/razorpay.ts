import crypto from "node:crypto";
import { appConfig } from "../config.js";

// Thin Razorpay client over fetch + node:crypto — no SDK dependency. Handles
// order creation and the two signature checks (checkout callback + webhook)
// following Razorpay's documented HMAC-SHA256 scheme with timing-safe compares.

export function razorpayConfigured(): boolean {
  return Boolean(appConfig.razorpayKeyId && appConfig.razorpayKeySecret);
}

// True when running against Razorpay test keys (no real money moves).
export function razorpayTestMode(): boolean {
  return appConfig.razorpayKeyId.startsWith("rzp_test_");
}

export type RazorpayOrder = {
  id: string;
  amount: number; // in paise
  currency: string;
  status: string;
};

export async function createRazorpayOrder(input: {
  amountInr: number;
  receipt: string;
  notes: Record<string, string>;
}): Promise<RazorpayOrder> {
  if (!razorpayConfigured()) {
    throw new Error("Payments aren't set up yet. Add your Razorpay keys to enable top-ups.");
  }
  const auth = Buffer.from(
    `${appConfig.razorpayKeyId}:${appConfig.razorpayKeySecret}`,
  ).toString("base64");

  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: Math.round(input.amountInr * 100), // paise
      currency: "INR",
      receipt: input.receipt,
      notes: input.notes,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Couldn't start the payment (Razorpay ${response.status}). ${detail.slice(0, 120)}`);
  }
  return (await response.json()) as RazorpayOrder;
}

// Verifies the signature returned by Razorpay Checkout after a successful
// payment: HMAC-SHA256(order_id|payment_id, key_secret).
export function verifyCheckoutSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  if (!appConfig.razorpayKeySecret) return false;
  const expected = crypto
    .createHmac("sha256", appConfig.razorpayKeySecret)
    .update(`${input.orderId}|${input.paymentId}`)
    .digest("hex");
  return timingSafeEqualHex(expected, input.signature);
}

// Verifies a Razorpay webhook: HMAC-SHA256(rawBody, webhook_secret).
export function verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
  if (!appConfig.razorpayWebhookSecret) return false;
  const expected = crypto
    .createHmac("sha256", appConfig.razorpayWebhookSecret)
    .update(rawBody)
    .digest("hex");
  return timingSafeEqualHex(expected, signature);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
