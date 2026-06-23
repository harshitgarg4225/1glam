// Prepaid packages / memberships: a client buys a bundle of sessions up front
// (e.g. "5 makeup sessions" or a "Bridal package: trial + wedding + reception")
// and each redemption decrements the remaining count. Distinct from quote
// packages, which are reusable line-item templates with no balance tracking.

export type ClientPackage = {
  packageId: string;
  clientWhatsApp: string;
  clientName: string;
  name: string;
  totalSessions: number;
  usedSessions: number;
  price: number;
  purchasedAt: string;
  // YYYY-MM-DD; empty = never expires.
  expiresAt: string;
  status: "Active" | "Completed" | "Expired" | "Cancelled";
};

export const packageHeaders = [
  "Package ID",
  "Client WhatsApp",
  "Client Name",
  "Name",
  "Total Sessions",
  "Used Sessions",
  "Price",
  "Purchased At",
  "Expires At",
  "Status",
] as const;

export function parseClientPackage(row: string[]): ClientPackage {
  return {
    packageId: row[0] || "",
    clientWhatsApp: row[1] || "",
    clientName: row[2] || "",
    name: row[3] || "",
    totalSessions: Number(row[4]) || 0,
    usedSessions: Number(row[5]) || 0,
    price: Number(row[6]) || 0,
    purchasedAt: row[7] || "",
    expiresAt: row[8] || "",
    status: (row[9] as ClientPackage["status"]) || "Active",
  };
}

export function clientPackageToRow(pkg: ClientPackage): string[] {
  return [
    pkg.packageId,
    pkg.clientWhatsApp,
    pkg.clientName,
    pkg.name,
    String(pkg.totalSessions),
    String(pkg.usedSessions),
    String(pkg.price),
    pkg.purchasedAt,
    pkg.expiresAt,
    pkg.status,
  ];
}

export function remainingSessions(pkg: ClientPackage): number {
  return Math.max(0, pkg.totalSessions - pkg.usedSessions);
}

// Whether a session can be redeemed against this package right now.
export function isRedeemable(pkg: ClientPackage): { ok: boolean; reason?: string } {
  if (pkg.status !== "Active") return { ok: false, reason: "This package is no longer active." };
  if (remainingSessions(pkg) <= 0) return { ok: false, reason: "No sessions left on this package." };
  if (pkg.expiresAt && pkg.expiresAt < new Date().toISOString().slice(0, 10)) {
    return { ok: false, reason: "This package has expired." };
  }
  return { ok: true };
}
