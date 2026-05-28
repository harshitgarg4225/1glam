import { getWorkspaceCredentials } from "./auth-store.js";
import { countActiveLeadsForDate, createLeadForWorkspace } from "./booking.js";
import { findWorkspaceByWorkspaceId } from "./database.js";
import { logInteractionForWorkspace } from "./integrations.js";
import type { WorkspaceConfig, WorkspaceRecord } from "../types.js";

export type PublicEventType = {
  key: string;
  label: string;
  startingPrice: number;
};

export type PublicAvailability = {
  enabled: boolean;
  minDate: string;
  maxDate: string;
  offWeekdays: number[];
  blockedDates: string[];
};

export type PublicBusinessProfile = {
  workspaceId: string;
  businessName: string;
  city: string;
  instagramHandle: string;
  advancePercentage: number;
  eventTypes: PublicEventType[];
  availability: PublicAvailability;
};

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseOffWeekdays(raw: string): number[] {
  return [
    ...new Set(
      String(raw || "")
        .split(",")
        .map((value) => WEEKDAY_INDEX[value.trim().toLowerCase()])
        .filter((value): value is number => value !== undefined),
    ),
  ];
}

function parseBlockedDates(raw: string): string[] {
  return [
    ...new Set(
      String(raw || "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
    ),
  ];
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildAvailability(config: WorkspaceConfig): PublicAvailability {
  const leadTime = Math.max(0, Number(config.bookingLeadTimeDays) || 0);
  const maxAdvance = Number(config.bookingMaxAdvanceDays) > 0 ? Number(config.bookingMaxAdvanceDays) : 365;
  return {
    enabled: String(config.bookingPageEnabled || "Yes").toLowerCase() !== "no",
    minDate: addDaysIso(leadTime),
    maxDate: addDaysIso(maxAdvance),
    offWeekdays: parseOffWeekdays(config.bookingWeeklyOffDays),
    blockedDates: parseBlockedDates(config.bookingBlockedDates),
  };
}

export type PublicBookingInput = {
  clientName: string;
  clientWhatsApp: string;
  clientInstagram?: string;
  eventType: string;
  eventDate: string;
  eventTime?: string;
  locationText: string;
  notes?: string;
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  Bridal: "Bridal Makeup",
  Engagement: "Engagement Makeup",
  Reception: "Reception Makeup",
  Party: "Party / Event Makeup",
  Shoot: "Photoshoot Makeup",
  Other: "Other",
};

function buildPublicProfile(workspace: WorkspaceRecord): PublicBusinessProfile {
  const { config } = workspace;
  const eventTypes: PublicEventType[] = [
    { key: "Bridal", startingPrice: config.basePriceBridal },
    { key: "Engagement", startingPrice: config.basePriceEngagement },
    { key: "Reception", startingPrice: config.basePriceReception },
    { key: "Party", startingPrice: config.basePriceParty },
    { key: "Shoot", startingPrice: config.basePriceShoot },
    { key: "Other", startingPrice: config.basePriceOther },
  ].map((entry) => ({
    key: entry.key,
    label: EVENT_TYPE_LABELS[entry.key] ?? entry.key,
    startingPrice: Number(entry.startingPrice) || 0,
  }));

  return {
    workspaceId: workspace.workspaceId,
    businessName: config.businessName || workspace.name || "1Glam Artist",
    city: config.city || "",
    instagramHandle: config.instagramHandle || "",
    advancePercentage: Number(config.advancePercentage) || 0,
    eventTypes,
    availability: buildAvailability(config),
  };
}

export async function getPublicBusinessProfile(workspaceId: string): Promise<PublicBusinessProfile | null> {
  const workspace = await findWorkspaceByWorkspaceId(workspaceId);
  if (!workspace) return null;
  return buildPublicProfile(workspace);
}

export async function createPublicBookingRequest(workspaceId: string, input: PublicBookingInput) {
  const workspace = await findWorkspaceByWorkspaceId(workspaceId);
  if (!workspace) throw new Error("Booking page not found");

  const availability = buildAvailability(workspace.config);
  if (!availability.enabled) {
    throw new Error("This artist is not accepting online bookings right now.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.eventDate)) {
    throw new Error("Please choose a valid event date.");
  }
  if (input.eventDate < availability.minDate) {
    throw new Error(`Please choose a date on or after ${availability.minDate}.`);
  }
  if (input.eventDate > availability.maxDate) {
    throw new Error(`Please choose a date on or before ${availability.maxDate}.`);
  }
  const weekday = new Date(`${input.eventDate}T00:00:00Z`).getUTCDay();
  if (availability.offWeekdays.includes(weekday)) {
    throw new Error(`The artist is not available on ${WEEKDAY_LABELS[weekday]}s.`);
  }
  if (availability.blockedDates.includes(input.eventDate)) {
    throw new Error("That date is unavailable. Please choose another.");
  }

  const tokens = await getWorkspaceCredentials(workspace.email);

  const maxPerDay = Number(workspace.config.bookingMaxPerDay) || 0;
  if (maxPerDay > 0) {
    const activeCount = await countActiveLeadsForDate(workspace.email, tokens, input.eventDate);
    if (activeCount >= maxPerDay) {
      throw new Error("That date is fully booked. Please choose another.");
    }
  }

  const inboundMessage = buildInboundMessage(input);

  const result = await createLeadForWorkspace(workspace.email, tokens, {
    source: "Booking Page",
    clientName: input.clientName,
    clientWhatsApp: input.clientWhatsApp,
    clientInstagram: input.clientInstagram,
    eventType: input.eventType,
    eventDate: input.eventDate,
    eventTime: input.eventTime,
    locationText: input.locationText,
    inboundMessage,
  });

  await logInteractionForWorkspace(workspace.email, tokens, {
    leadId: result.lead.leadId,
    direction: "Inbound",
    channel: "Booking Page",
    actor: input.clientWhatsApp,
    message: inboundMessage,
    aiSummary: `Lead ${result.lead.leadId} created from public booking page`,
  });

  return {
    leadId: result.lead.leadId,
    businessName: workspace.config.businessName || workspace.name,
    eventType: result.lead.eventType,
    eventDate: result.lead.eventDate,
    eventTime: result.lead.eventTime,
  };
}

function buildInboundMessage(input: PublicBookingInput) {
  return [
    `Booking request via website for ${input.eventType}.`,
    `Date: ${input.eventDate}${input.eventTime ? ` at ${input.eventTime}` : ""}.`,
    `Location: ${input.locationText}.`,
    input.clientInstagram ? `Instagram: ${input.clientInstagram}.` : "",
    input.notes ? `Notes: ${input.notes}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}
