import type { WorkspaceConfig } from "../types.js";
import type { BookingRecord } from "./booking.js";

export type LoyaltyStatus = {
  phone: string;
  clientName: string;
  visits: number;
  milestoneAt: number;
  nextMilestone: number;
  rewardEarned: boolean;
  rewardNote: string;
};

export function computeLoyaltyStatuses(
  config: WorkspaceConfig,
  bookings: BookingRecord[],
): LoyaltyStatus[] {
  if (config.loyaltyEnabled !== "Yes") return [];

  const milestone = config.loyaltyVisitsForReward || 5;
  const rewardNote =
    config.loyaltyRewardNote || `₹${config.loyaltyRewardValue || 500} off your next booking`;

  const clientMap = new Map<string, { name: string; count: number }>();
  for (const b of bookings) {
    if (b.status !== "Confirmed" && b.status !== "Completed") continue;
    if (!b.clientWhatsApp) continue;
    const existing = clientMap.get(b.clientWhatsApp);
    if (existing) {
      existing.count++;
      if (b.clientName) existing.name = b.clientName;
    } else {
      clientMap.set(b.clientWhatsApp, { name: b.clientName || "Client", count: 1 });
    }
  }

  return Array.from(clientMap.entries()).map(([phone, { name, count }]) => {
    const completedCycles = Math.floor(count / milestone);
    const remainder = count % milestone;
    const rewardEarned = completedCycles > 0 && remainder === 0;
    const nextMilestone = (completedCycles + 1) * milestone;
    return { phone, clientName: name, visits: count, milestoneAt: milestone, nextMilestone, rewardEarned, rewardNote };
  });
}

export function loyaltyForPhone(
  config: WorkspaceConfig,
  bookings: BookingRecord[],
  phone: string,
): LoyaltyStatus | null {
  const all = computeLoyaltyStatuses(config, bookings);
  return all.find((s) => s.phone === phone) ?? null;
}
