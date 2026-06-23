import { durationHoursForEvent } from "./booking.js";
import type { BookingRecord, LeadRecord } from "./booking.js";
import type { WorkspaceConfig } from "../types.js";

// Proactive intelligence: turns the lead/booking data the app already has into
// things the artist should act on, in plain words. Used by the dashboard
// (GET /api/insights) and the morning digest push — one source of truth.

export type InsightItem = {
  id: string;
  kind:
    | "slot_open_waitlist"
    | "waitlist_pressure"
    | "stale_quote"
    | "advance_overdue"
    | "demand_month"
    | "below_base";
  severity: "action" | "info";
  title: string;
  body: string;
  // Deep-link hints for the UI: leads to open, or a date to show.
  leadIds?: string[];
  date?: string;
};

const ACTIVE_STATUSES_EXCLUDED = ["Lost", "Completed"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, now: Date): number {
  const from = new Date(fromIso);
  if (isNaN(from.getTime())) return 0;
  return Math.floor((now.getTime() - from.getTime()) / 86_400_000);
}

function formatDay(dateIso: string): string {
  try {
    return new Date(`${dateIso}T00:00:00Z`).toLocaleDateString("en-IN", {
      day: "numeric", month: "short", timeZone: "UTC",
    });
  } catch {
    return dateIso;
  }
}

export function computeInsights(input: {
  config: WorkspaceConfig;
  leads: LeadRecord[];
  bookings: BookingRecord[];
  now?: Date;
}): InsightItem[] {
  const now = input.now ?? new Date();
  const today = isoDate(now);
  const insights: InsightItem[] = [];
  const { config, leads } = input;

  // ── Waitlist: open slots and demand pressure per date ─────────────────────
  const waitlistedByDate = new Map<string, LeadRecord[]>();
  const activeCountByDate = new Map<string, number>();
  for (const lead of leads) {
    if (!lead.eventDate || lead.eventDate < today) continue;
    if (ACTIVE_STATUSES_EXCLUDED.includes(lead.status)) continue;
    if (lead.source === "Waitlist") {
      waitlistedByDate.set(lead.eventDate, [...(waitlistedByDate.get(lead.eventDate) ?? []), lead]);
    } else {
      activeCountByDate.set(lead.eventDate, (activeCountByDate.get(lead.eventDate) ?? 0) + 1);
    }
  }

  const maxPerDay = Number(config.bookingMaxPerDay) || 0;
  for (const [date, waiting] of [...waitlistedByDate.entries()].sort()) {
    const active = activeCountByDate.get(date) ?? 0;
    const names = waiting.map((l) => l.clientName || "a client");
    if (maxPerDay > 0 && active < maxPerDay) {
      insights.push({
        id: `slot-open:${date}`,
        kind: "slot_open_waitlist",
        severity: "action",
        title: `A slot is open on ${formatDay(date)} — ${names[0]} is waiting`,
        body:
          waiting.length === 1
            ? `${names[0]} joined the waitlist for ${formatDay(date)} and the date now has space. Offer them the slot before they book elsewhere.`
            : `${waiting.length} people are waiting for ${formatDay(date)} and the date now has space. Offer the slot to ${names[0]} (first in line).`,
        leadIds: waiting.map((l) => l.leadId),
        date,
      });
    } else {
      insights.push({
        id: `waitlist:${date}`,
        kind: "waitlist_pressure",
        severity: "info",
        title: `${formatDay(date)} is in demand: ${active} booked + ${waiting.length} waiting`,
        body: `Demand for ${formatDay(date)} exceeds your capacity. You could raise your price for this date, or offer the waitlist a nearby date.`,
        leadIds: waiting.map((l) => l.leadId),
        date,
      });
    }
  }

  // ── Quotes that went quiet ────────────────────────────────────────────────
  for (const lead of leads) {
    if (lead.status !== "Awaiting Client" || !lead.quoteUrl || lead.quoteAcceptedAt || lead.quoteVoidedAt) continue;
    const sentDays = lead.quoteGeneratedAt ? daysBetween(lead.quoteGeneratedAt, now) : 0;
    if (sentDays < 3) continue;
    const viewed = Boolean(lead.quoteViewedAt);
    insights.push({
      id: `quote:${lead.leadId}`,
      kind: "stale_quote",
      severity: "action",
      title: `${lead.clientName || "A client"}'s quote has been quiet for ${sentDays} days`,
      body: viewed
        ? `They opened the quote but haven't accepted. A friendly nudge usually closes it — send one in your voice with one tap.`
        : `The quote hasn't been opened yet. A short follow-up message can bring it back to the top of their chat.`,
      leadIds: [lead.leadId],
    });
  }

  // ── Advances pending too long ─────────────────────────────────────────────
  for (const booking of input.bookings) {
    if (booking.status === "Cancelled" || booking.paymentStatus !== "Advance Due") continue;
    if (!booking.advanceAmount || booking.advanceAmount <= 0) continue;
    const waitingDays = booking.bookedAt ? daysBetween(booking.bookedAt, now) : 0;
    if (waitingDays < 3) continue;
    insights.push({
      id: `advance:${booking.bookingId}`,
      kind: "advance_overdue",
      severity: "action",
      title: `₹${Math.round(booking.advanceAmount).toLocaleString("en-IN")} advance pending from ${booking.clientName || "a client"}`,
      body: `Booked ${waitingDays} days ago for ${formatDay(booking.eventDate)} and the advance hasn't landed. The date stays at risk until it's paid.`,
      leadIds: booking.leadId ? [booking.leadId] : undefined,
      date: booking.eventDate,
    });
  }

  // ── Months that are hotter than her pricing assumes ───────────────────────
  const monthMultipliers = [
    config.multiplierJan, config.multiplierFeb, config.multiplierMar, config.multiplierApr,
    config.multiplierMay, config.multiplierJun, config.multiplierJul, config.multiplierAug,
    config.multiplierSep, config.multiplierOct, config.multiplierNov, config.multiplierDec,
  ];
  const upcomingDemand = new Map<number, number>();
  for (const lead of leads) {
    if (!lead.eventDate || lead.eventDate < today) continue;
    if (ACTIVE_STATUSES_EXCLUDED.includes(lead.status)) continue;
    const month = new Date(`${lead.eventDate}T00:00:00Z`).getUTCMonth();
    if (Number.isInteger(month)) upcomingDemand.set(month, (upcomingDemand.get(month) ?? 0) + 1);
  }
  for (const [month, count] of upcomingDemand) {
    const multiplier = Number(monthMultipliers[month]) || 1;
    if (count >= 4 && multiplier <= 1) {
      insights.push({
        id: `demand-month:${month}`,
        kind: "demand_month",
        severity: "info",
        title: `${MONTH_NAMES[month]} is filling up (${count} enquiries) but priced like a quiet month`,
        body: `Your ${MONTH_NAMES[month]} season multiplier is ${multiplier}×. With this much demand you could raise it — Settings → Your prices.`,
      });
    }
  }

  // ── Quoting below her own base price ──────────────────────────────────────
  const basePriceByType: Record<string, number> = {
    Bridal: config.basePriceBridal, Engagement: config.basePriceEngagement,
    Reception: config.basePriceReception, Party: config.basePriceParty,
    Shoot: config.basePriceShoot, Other: config.basePriceOther,
  };
  const belowBase = leads.filter((lead) => {
    if (!lead.createdAt || daysBetween(lead.createdAt, now) > 30) return false;
    const base = Number(basePriceByType[lead.eventType]) || 0;
    return base > 0 && lead.finalApprovedPrice > 0 && lead.finalApprovedPrice < base;
  });
  if (belowBase.length >= 2) {
    insights.push({
      id: "below-base",
      kind: "below_base",
      severity: "info",
      title: `You priced below your own base ${belowBase.length} times this month`,
      body: `If discounts have become the norm, consider lowering the base price honestly — or holding the line. Your base prices are in Settings → Your prices.`,
      leadIds: belowBase.map((l) => l.leadId),
    });
  }

  // Action items first, then info; stable order within each group.
  return insights.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "action" ? -1 : 1));
}

// ── Morning digest ───────────────────────────────────────────────────────────
// One short push at the start of her day: today's jobs + what needs attention.
// Returns null when there's nothing worth waking her phone for.
export function buildDigestSummary(input: {
  config: WorkspaceConfig;
  leads: LeadRecord[];
  bookings: BookingRecord[];
  now?: Date;
}): { title: string; body: string } | null {
  const now = input.now ?? new Date();
  const today = isoDate(now);

  const todaysJobs = input.bookings
    .filter((b) => b.eventDate === today && b.status !== "Cancelled" && b.status !== "Completed")
    .sort((a, b) => (a.eventTime || "99").localeCompare(b.eventTime || "99"));

  const insights = computeInsights(input);
  const actions = insights.filter((i) => i.severity === "action");

  if (!todaysJobs.length && !actions.length) return null;

  const jobLines = todaysJobs.map((b) => {
    const time = b.eventTime ? ` at ${b.eventTime}` : "";
    const venue = b.venue ? ` (${b.venue})` : "";
    return `${b.eventType} for ${b.clientName}${time}${venue}`;
  });

  const parts: string[] = [];
  if (jobLines.length) {
    parts.push(jobLines.length === 1 ? `Today: ${jobLines[0]}.` : `Today: ${jobLines.join(" · ")}.`);
  } else {
    parts.push("No jobs today.");
  }
  if (actions.length) {
    parts.push(actions.length === 1 ? actions[0].title + "." : `${actions.length} things need you: ${actions.slice(0, 2).map((a) => a.title).join("; ")}.`);
  }

  return {
    title: todaysJobs.length
      ? `Good morning ☀️ ${todaysJobs.length} job${todaysJobs.length > 1 ? "s" : ""} today`
      : "Good morning ☀️",
    body: parts.join(" ").slice(0, 480),
  };
}

// ── AI services context, always current ──────────────────────────────────────
// The AI used to rely on a hand-maintained "services & pricing" text the owner
// had to keep in sync with her actual price settings. Now it's composed from
// the live config on every reply; her aiServicesContext field is extra notes.
export function buildServicesContext(config: WorkspaceConfig): string {
  const services: { key: string; label: string; price: number; addons: string }[] = [
    { key: "Bridal", label: "Bridal Makeup", price: config.basePriceBridal, addons: config.serviceBridalAddons },
    { key: "Engagement", label: "Engagement Makeup", price: config.basePriceEngagement, addons: config.serviceEngagementAddons },
    { key: "Reception", label: "Reception Makeup", price: config.basePriceReception, addons: config.serviceReceptionAddons },
    { key: "Party", label: "Party / Event Makeup", price: config.basePriceParty, addons: config.servicePartyAddons },
    { key: "Shoot", label: "Photoshoot Makeup", price: config.basePriceShoot, addons: config.serviceShootAddons },
  ];

  const serviceLines = services
    .filter((s) => Number(s.price) > 0)
    .map((s) => {
      const hours = durationHoursForEvent(config.serviceDurations, s.key);
      const addons = s.addons ? ` Add-ons: ${s.addons}.` : "";
      return `${s.label}: from Rs ${Math.round(Number(s.price)).toLocaleString("en-IN")} (about ${hours}h).${addons}`;
    });

  const nearbyFrom = Number(config.travelNearbyThresholdKm) > 0 ? Number(config.travelNearbyThresholdKm) : 25;
  const outstationFrom = Number(config.travelOutstationThresholdKm) > 0 ? Number(config.travelOutstationThresholdKm) : 100;
  const perKm = Number(config.travelPerKmRate) || 0;
  const travelLine = perKm > 0
    ? `Travel: Rs ${perKm}/km from ${config.city || "the studio"}.`
    : [
        `Travel: within ${config.city || "the city"} ${Number(config.travelWithinCity) > 0 ? `Rs ${config.travelWithinCity}` : "free"}`,
        Number(config.travelNearbyCity) > 0 ? `nearby cities (${nearbyFrom}–${outstationFrom} km) Rs ${config.travelNearbyCity}` : "",
        Number(config.travelOutstation) > 0 ? `outstation (${outstationFrom}+ km) Rs ${config.travelOutstation}` : "",
      ].filter(Boolean).join("; ") + ".";

  const advanceLine = Number(config.advancePercentage) > 0
    ? `A ${config.advancePercentage}% advance confirms a booking.`
    : "";

  const ownerNotes = String(config.aiServicesContext || "").trim();

  return [
    serviceLines.join(" "),
    travelLine,
    advanceLine,
    ownerNotes ? `Owner notes: ${ownerNotes}` : "",
  ].filter(Boolean).join(" ");
}
