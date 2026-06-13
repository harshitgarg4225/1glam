import { randomBytes } from "crypto";

export type GiftCard = {
  cardId: string;
  code: string;
  amount: number;
  message: string;
  purchaserName: string;
  purchaserEmail: string;
  purchaserWhatsApp: string;
  redeemedByLeadId: string;
  redeemedAt: string;
  createdAt: string;
  status: "Active" | "Redeemed" | "Deactivated";
};

export const giftCardHeaders = [
  "Card ID",
  "Code",
  "Amount",
  "Message",
  "Purchaser Name",
  "Purchaser Email",
  "Purchaser WhatsApp",
  "Redeemed By Lead ID",
  "Redeemed At",
  "Created At",
  "Status",
] as const;

export function generateGiftCode(): string {
  // 8-char alphanumeric uppercase, easy to read aloud/type
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

export function parseGiftCard(row: string[]): GiftCard {
  return {
    cardId: row[0] || "",
    code: row[1] || "",
    amount: Number(row[2]) || 0,
    message: row[3] || "",
    purchaserName: row[4] || "",
    purchaserEmail: row[5] || "",
    purchaserWhatsApp: row[6] || "",
    redeemedByLeadId: row[7] || "",
    redeemedAt: row[8] || "",
    createdAt: row[9] || "",
    status: (row[10] as GiftCard["status"]) || "Active",
  };
}

export function giftCardToRow(card: GiftCard): string[] {
  return [
    card.cardId,
    card.code,
    String(card.amount),
    card.message,
    card.purchaserName,
    card.purchaserEmail,
    card.purchaserWhatsApp,
    card.redeemedByLeadId,
    card.redeemedAt,
    card.createdAt,
    card.status,
  ];
}
