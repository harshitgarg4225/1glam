import crypto from "node:crypto";
import { fetchWithTimeout } from "./http.js";
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

  const response = await fetchWithTimeout("https://api.razorpay.com/v1/orders", {
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

// Fetches an order straight from Razorpay so the server can trust its amount
// and notes (which we set at creation) instead of believing the client. Used
// to bind a verified payment to the exact pack that was actually paid for.
export async function fetchRazorpayOrder(orderId: string): Promise<{
  id: string;
  amount: number; // paise
  amountPaid: number; // paise
  currency: string;
  status: string;
  notes: Record<string, string>;
}> {
  if (!razorpayConfigured()) {
    throw new Error("Payments aren't set up yet.");
  }
  const auth = Buffer.from(
    `${appConfig.razorpayKeyId}:${appConfig.razorpayKeySecret}`,
  ).toString("base64");
  const response = await fetchWithTimeout(
    `https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  if (!response.ok) {
    throw new Error(`Couldn't verify the order with Razorpay (${response.status}).`);
  }
  const order = (await response.json()) as {
    id: string;
    amount: number;
    amount_paid?: number;
    currency: string;
    status: string;
    notes?: Record<string, string>;
  };
  return {
    id: order.id,
    amount: order.amount,
    amountPaid: order.amount_paid ?? 0,
    currency: order.currency,
    status: order.status,
    notes: order.notes ?? {},
  };
}

// ─── Per-workspace variants ───
// Client advances are collected into the OWNER's Razorpay account, not the
// platform's, so these take her keys (stored encrypted in workspace config).

export async function createOrderWithKeys(
  keys: { keyId: string; keySecret: string },
  input: { amountInr: number; receipt: string; notes: Record<string, string> },
): Promise<RazorpayOrder> {
  if (!keys.keyId || !keys.keySecret) {
    throw new Error("Online payments aren't set up. Add Razorpay keys in Settings.");
  }
  const auth = Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64");
  const response = await fetchWithTimeout("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: Math.round(input.amountInr * 100),
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

export async function fetchOrderWithKeys(
  keys: { keyId: string; keySecret: string },
  orderId: string,
): Promise<{ id: string; amount: number; currency: string; status: string; notes: Record<string, string> }> {
  const auth = Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64");
  const response = await fetchWithTimeout(
    `https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  if (!response.ok) {
    throw new Error(`Couldn't confirm the payment (Razorpay ${response.status}).`);
  }
  const order = (await response.json()) as {
    id: string; amount: number; currency: string; status: string; notes?: Record<string, string>;
  };
  return { id: order.id, amount: order.amount, currency: order.currency, status: order.status, notes: order.notes ?? {} };
}

export function verifyCheckoutSignatureWithSecret(
  keySecret: string,
  input: { orderId: string; paymentId: string; signature: string },
): boolean {
  if (!keySecret) return false;
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${input.orderId}|${input.paymentId}`)
    .digest("hex");
  return timingSafeEqualHex(expected, input.signature);
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
