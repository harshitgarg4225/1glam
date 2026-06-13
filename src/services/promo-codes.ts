import { randomBytes } from "crypto";

export type PromoCode = {
  codeId: string;
  code: string;
  // "percent" → value is 0-100; "flat" → value is a rupee amount.
  type: "percent" | "flat";
  value: number;
  // Minimum order value (₹) for the code to apply. 0 = no minimum.
  minAmount: number;
  // 0 = unlimited redemptions.
  maxRedemptions: number;
  timesRedeemed: number;
  // YYYY-MM-DD; empty = never expires.
  expiresAt: string;
  createdAt: string;
  status: "Active" | "Deactivated";
};

export const promoCodeHeaders = [
  "Code ID",
  "Code",
  "Type",
  "Value",
  "Min Amount",
  "Max Redemptions",
  "Times Redeemed",
  "Expires At",
  "Created At",
  "Status",
] as const;

export function generatePromoCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

export function parsePromoCode(row: string[]): PromoCode {
  return {
    codeId: row[0] || "",
    code: row[1] || "",
    type: (row[2] as PromoCode["type"]) || "percent",
    value: Number(row[3]) || 0,
    minAmount: Number(row[4]) || 0,
    maxRedemptions: Number(row[5]) || 0,
    timesRedeemed: Number(row[6]) || 0,
    expiresAt: row[7] || "",
    createdAt: row[8] || "",
    status: (row[9] as PromoCode["status"]) || "Active",
  };
}

export function promoCodeToRow(promo: PromoCode): string[] {
  return [
    promo.codeId,
    promo.code,
    promo.type,
    String(promo.value),
    String(promo.minAmount),
    String(promo.maxRedemptions),
    String(promo.timesRedeemed),
    promo.expiresAt,
    promo.createdAt,
    promo.status,
  ];
}

export type PromoValidation =
  | { ok: true; discount: number; finalAmount: number; label: string }
  | { ok: false; reason: string };

// Validates a promo against an order amount and returns the discount it grants.
// Pure function — callers handle persistence (incrementing timesRedeemed).
export function validatePromo(promo: PromoCode | undefined, amount: number): PromoValidation {
  if (!promo) return { ok: false, reason: "That code isn't valid." };
  if (promo.status !== "Active") return { ok: false, reason: "This code is no longer active." };
  if (promo.expiresAt) {
    const today = new Date().toISOString().slice(0, 10);
    if (promo.expiresAt < today) return { ok: false, reason: "This code has expired." };
  }
  if (promo.maxRedemptions > 0 && promo.timesRedeemed >= promo.maxRedemptions) {
    return { ok: false, reason: "This code has reached its redemption limit." };
  }
  if (promo.minAmount > 0 && amount < promo.minAmount) {
    return { ok: false, reason: `This code applies to bookings of ₹${promo.minAmount.toLocaleString("en-IN")} or more.` };
  }
  const rawDiscount = promo.type === "percent" ? (amount * promo.value) / 100 : promo.value;
  const discount = Math.min(Math.round(rawDiscount), amount); // never exceed the order
  const label = promo.type === "percent" ? `${promo.value}% off` : `₹${promo.value.toLocaleString("en-IN")} off`;
  return { ok: true, discount, finalAmount: Math.max(0, amount - discount), label };
}
