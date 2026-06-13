import { Readable } from "node:stream";
import { appConfig } from "../config.js";
import { getWorkspaceCredentials } from "./auth-store.js";
import { computeSlotAvailability, countActiveLeadsForDate, createLeadForWorkspace, getLeadRecord, listActiveLeadsForDate, updateLeadRecord, updateBookingRecord, roundToPremiumNumber } from "./booking.js";
import { findWorkspaceByWorkspaceId, withSerializedLock, lockKeyFromString } from "./database.js";
import { createGoogleClients } from "./google.js";
import { logInteractionForWorkspace } from "./integrations.js";
import { sendWhatsAppTemplate } from "./messaging.js";
import type { WorkspaceConfig, WorkspaceRecord } from "../types.js";

export type PublicAddon = {
  name: string;
  price: number;
};

export type ServiceVariant = {
  name: string;
  price: number;
  description?: string;
};

export type PublicEventType = {
  key: string;
  label: string;
  startingPrice: number;
  description: string;
  addons: PublicAddon[];
  variants: ServiceVariant[];
};

export type PublicAvailability = {
  enabled: boolean;
  minDate: string;
  maxDate: string;
  offWeekdays: number[];
  blockedDates: string[];
  timeSlots: string[];
  waitlistEnabled: boolean;
};

export type PublicBusinessProfile = {
  workspaceId: string;
  businessName: string;
  city: string;
  instagramHandle: string;
  ownerWhatsApp: string;
  advancePercentage: number;
  upiId: string;
  aboutText: string;
  portfolioImages: string[];
  brandColor: string;
  coverImageUrl: string;
  headline: string;
  tagline: string;
  eventTypes: PublicEventType[];
  availability: PublicAvailability;
  // Trust badge: Google rating snapshot + the public review-page link.
  googleRating: number;
  googleReviewCount: number;
  googleReviewLink: string;
};

export type PublicPaymentDetails = {
  businessName: string;
  clientName: string;
  eventType: string;
  eventDate: string;
  finalApprovedPrice: number;
  advanceAmount: number;
  balanceDue: number;
  upiId: string;
  upiDeepLink: string;
  paymentTerms: string;
  leadStatus: string;
  paymentStatus: string;
  // True when the owner has her own Razorpay keys configured, enabling
  // pay-online with automatic confirmation. keyId is public by design
  // (Razorpay Checkout needs it client-side); the secret never leaves the server.
  onlinePayAvailable: boolean;
  razorpayKeyId: string;
  tipsEnabled: boolean;
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

function sanitizePhone(raw: string) {
  return String(raw || "").replace(/[^\d]/g, "");
}

function parseAddons(raw: string): PublicAddon[] {
  return String(raw || "")
    .split(",")
    .map((entry) => {
      const colonIndex = entry.lastIndexOf(":");
      if (colonIndex < 1) return null;
      const name = entry.slice(0, colonIndex).trim();
      const price = parseInt(entry.slice(colonIndex + 1).trim(), 10);
      if (!name) return null;
      return { name, price: isNaN(price) ? 0 : price };
    })
    .filter((a): a is PublicAddon => a !== null);
}


function addDaysIso(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseTimeSlots(raw: string): string[] {
  return [
    ...new Set(
      String(raw || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d{2}:\d{2}$/.test(s)),
    ),
  ].sort();
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
    timeSlots: parseTimeSlots(config.bookingTimeSlots),
    waitlistEnabled: String(config.bookingWaitlistEnabled || "No").toLowerCase() === "yes",
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
  addons?: string;
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

function parseServiceVariants(config: WorkspaceConfig): Record<string, ServiceVariant[]> {
  try {
    const raw = config.serviceVariantsJson || "{}";
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, ServiceVariant[]> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (!Array.isArray(val)) continue;
      result[key] = val
        .filter((v): v is Record<string, unknown> => v && typeof v === "object")
        .map((v) => ({
          name: String(v.name || ""),
          price: Number(v.price) || 0,
          description: v.description ? String(v.description) : undefined,
        }))
        .filter((v) => v.name);
    }
    return result;
  } catch {
    return {};
  }
}

function buildPublicProfile(workspace: WorkspaceRecord): PublicBusinessProfile {
  const { config } = workspace;
  const allVariants = parseServiceVariants(config);
  const eventTypes: PublicEventType[] = [
    { key: "Bridal", startingPrice: config.basePriceBridal, descKey: "serviceBridalDesc" as const, addonsKey: "serviceBridalAddons" as const },
    { key: "Engagement", startingPrice: config.basePriceEngagement, descKey: "serviceEngagementDesc" as const, addonsKey: "serviceEngagementAddons" as const },
    { key: "Reception", startingPrice: config.basePriceReception, descKey: "serviceReceptionDesc" as const, addonsKey: "serviceReceptionAddons" as const },
    { key: "Party", startingPrice: config.basePriceParty, descKey: "servicePartyDesc" as const, addonsKey: "servicePartyAddons" as const },
    { key: "Shoot", startingPrice: config.basePriceShoot, descKey: "serviceShootDesc" as const, addonsKey: "serviceShootAddons" as const },
    { key: "Other", startingPrice: config.basePriceOther, descKey: "serviceOtherDesc" as const, addonsKey: "serviceOtherAddons" as const },
  ].map((entry) => {
    const variants = allVariants[entry.key] ?? [];
    const basePrice = Number(entry.startingPrice) || 0;
    const startingPrice = variants.length > 0 ? Math.min(...variants.map((v) => v.price)) || basePrice : basePrice;
    return {
      key: entry.key,
      label: EVENT_TYPE_LABELS[entry.key] ?? entry.key,
      startingPrice,
      description: String(config[entry.descKey] || ""),
      addons: parseAddons(String(config[entry.addonsKey] || "")),
      variants,
    };
  });

  return {
    workspaceId: workspace.workspaceId,
    businessName: config.businessName || workspace.name || "BusyDays",
    city: config.city || "",
    instagramHandle: config.instagramHandle || "",
    ownerWhatsApp: sanitizePhone(config.ownerWhatsApp),
    advancePercentage: Number(config.advancePercentage) || 0,
    upiId: config.upiId || "",
    aboutText: String(config.aboutText || ""),
    portfolioImages: parseImageList(config.portfolioImages),
    brandColor: sanitizeHexColor(config.brandColor),
    coverImageUrl: sanitizeUrl(config.coverImageUrl),
    headline: String(config.headline || ""),
    tagline: String(config.tagline || ""),
    eventTypes,
    availability: buildAvailability(config),
    googleRating: Math.min(5, Math.max(0, Number(config.googleRating) || 0)),
    googleReviewCount: Math.max(0, Math.round(Number(config.googleReviewCount) || 0)),
    googleReviewLink: sanitizeUrl(config.googleReviewLink),
  };
}

// Only allow a valid #RGB / #RRGGBB hex so a bad value can't break the page CSS.
function sanitizeHexColor(raw: unknown): string {
  const value = String(raw || "").trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : "";
}

function sanitizeUrl(raw: unknown): string {
  const value = String(raw || "").trim();
  return /^https?:\/\//i.test(value) ? value : "";
}

function parseImageList(raw: string): string[] {
  return String(raw || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s))
    .slice(0, 12);
}

export async function getPublicBusinessProfile(workspaceId: string): Promise<PublicBusinessProfile | null> {
  const workspace = await findWorkspaceByWorkspaceId(workspaceId);
  if (!workspace) return null;
  return buildPublicProfile(workspace);
}

// True when the artist's confirmed calendar has an all-day event on the date.
async function hasAllDayCalendarEvent(
  workspace: WorkspaceRecord,
  tokens: Awaited<ReturnType<typeof getWorkspaceCredentials>>,
  eventDate: string,
): Promise<boolean> {
  const calendarId = workspace.config.confirmedCalendarId || "primary";
  const { calendar } = createGoogleClients(tokens);
  const response = await calendar.events.list({
    calendarId,
    timeMin: `${eventDate}T00:00:00Z`,
    timeMax: `${eventDate}T23:59:59Z`,
    singleEvents: true,
    maxResults: 20,
  });
  return (response.data.items ?? []).some(
    (event) => Boolean(event.start?.date) && event.status !== "cancelled",
  );
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

  const timeSlots = parseTimeSlots(workspace.config.bookingTimeSlots);
  if (timeSlots.length > 0 && input.eventTime) {
    if (!timeSlots.includes(input.eventTime)) {
      throw new Error("Please choose one of the available time slots.");
    }
  }

  const tokens = await getWorkspaceCredentials(workspace.email);

  // Duration-aware slot conflict: a 4-hour bridal at 09:00 occupies 09:00-13:00,
  // so an 11:00 request must be refused (or waitlisted) even when the day-level
  // capacity isn't reached yet. Fails open on a Sheets hiccup — the artist can
  // still resolve a rare double-request manually, but a flaky read should never
  // block a client from booking.
  let slotConflict = false;
  if (timeSlots.length > 0 && input.eventTime) {
    const busy = await listActiveLeadsForDate(workspace.email, tokens, input.eventDate).catch(() => []);
    const slots = computeSlotAvailability({
      timeSlots,
      serviceDurations: workspace.config.serviceDurations,
      requestedEventType: input.eventType,
      busy: busy.map((lead) => ({ eventTime: lead.eventTime, eventType: lead.eventType })),
    });
    const requested = slots.find((slot) => slot.time === input.eventTime);
    if (requested && !requested.available) {
      const waitlistEnabled = String(workspace.config.bookingWaitlistEnabled || "No").toLowerCase() === "yes";
      if (!waitlistEnabled) {
        throw new Error("That time slot was just taken. Please pick another time.");
      }
      slotConflict = true;
    }
  }

  // Personal-calendar guard: an all-day event on her confirmed Google Calendar
  // ("OUT OF TOWN", a family wedding) blocks the date even if she forgot to
  // block it in the app. Timed events don't block — a 1-hour errand shouldn't
  // kill a whole day. Fails open so a calendar hiccup never breaks bookings.
  const busyAllDay = await hasAllDayCalendarEvent(workspace, tokens, input.eventDate).catch(() => false);
  if (busyAllDay) {
    throw new Error("That date is unavailable. Please choose another.");
  }

  const maxPerDay = Number(workspace.config.bookingMaxPerDay) || 0;
  const inboundMessage = buildInboundMessage(input);

  // Serialize the capacity check + lead creation per (workspace, date) so two
  // simultaneous requests for the same fully-booked date can't both slip past
  // the max-per-day cap. The lock is a no-op in single-instance/file mode.
  const lockKey = lockKeyFromString(`book:${workspace.workspaceId}:${input.eventDate}`);
  const { waitlisted, result } = await withSerializedLock(lockKey, async () => {
    let waitlisted = slotConflict;
    if (maxPerDay > 0) {
      const activeCount = await countActiveLeadsForDate(workspace.email, tokens, input.eventDate);
      if (activeCount >= maxPerDay) {
        const waitlistEnabled = String(workspace.config.bookingWaitlistEnabled || "No").toLowerCase() === "yes";
        if (!waitlistEnabled) {
          throw new Error("That date is fully booked. Please choose another.");
        }
        waitlisted = true;
      }
    }

    const result = await createLeadForWorkspace(workspace.email, tokens, {
      source: waitlisted ? "Waitlist" : "Booking Page",
      clientName: input.clientName,
      clientWhatsApp: input.clientWhatsApp,
      clientInstagram: input.clientInstagram,
      eventType: input.eventType,
      eventDate: input.eventDate,
      eventTime: input.eventTime,
      locationText: input.locationText,
      inboundMessage,
    });
    return { waitlisted, result };
  });

  // Selected add-ons price themselves into the quote: matched against the
  // service's configured "Name:Price" list and stored as quote line items, so
  // the PDF shows "Airbrush (add-on)  +Rs 2,000" on top of the base price
  // instead of the add-ons silently vanishing into the notes. Best-effort.
  try {
    const addonLines = matchSelectedAddons(workspace.config, input.eventType, input.addons);
    if (addonLines.length) {
      await updateLeadRecord(workspace.email, tokens, result.lead.leadId, (lead) => ({
        ...lead,
        quoteAdjustments: JSON.stringify({ lineItems: addonLines }),
      }));
    }
  } catch {
    // The add-on names are still in the inbound message for manual handling.
  }

  await logInteractionForWorkspace(workspace.email, tokens, {
    leadId: result.lead.leadId,
    direction: "Inbound",
    channel: "Booking Page",
    actor: input.clientWhatsApp,
    message: inboundMessage,
    aiSummary: `Lead ${result.lead.leadId} created from public booking page`,
  });

  if (!waitlisted) {
    await sendBookingConfirmationTemplate(workspace, result.lead.leadId, input, tokens);
  }

  return {
    leadId: result.lead.leadId,
    businessName: workspace.config.businessName || workspace.name,
    eventType: result.lead.eventType,
    eventDate: result.lead.eventDate,
    eventTime: result.lead.eventTime,
    waitlisted,
  };
}

// Best-effort WhatsApp template confirmation. A booking-page client has no open
// 24h session, so only an approved template can be delivered business-initiated.
// Failures are swallowed so a template/config issue never blocks the booking.
async function sendBookingConfirmationTemplate(
  workspace: WorkspaceRecord,
  leadId: string,
  input: PublicBookingInput,
  tokens: Awaited<ReturnType<typeof getWorkspaceCredentials>>,
) {
  const templateName = String(workspace.config.bookingConfirmTemplate || "").trim();
  if (!templateName) return;

  const whatsapp = workspace.metaConnections?.whatsapp;
  const connectionCanSend = whatsapp?.status === "connected" && Boolean(whatsapp.accessToken && whatsapp.phoneNumberId);
  const envCanSend = Boolean(appConfig.waAccessToken && appConfig.waPhoneNumberId);
  if (!connectionCanSend && !envCanSend) return;

  try {
    await sendWhatsAppTemplate(
      {
        accessToken: whatsapp?.accessToken,
        phoneNumberId: whatsapp?.phoneNumberId,
      },
      sanitizePhone(input.clientWhatsApp),
      templateName,
      String(workspace.config.bookingConfirmTemplateLang || "en"),
      [input.clientName, input.eventType, input.eventDate],
    );

    await logInteractionForWorkspace(workspace.email, tokens, {
      leadId,
      direction: "Outbound",
      channel: "WhatsApp",
      actor: sanitizePhone(input.clientWhatsApp),
      message: `Booking confirmation template "${templateName}" sent`,
      aiSummary: "Automated booking-page confirmation",
    });
  } catch (error) {
    console.error("Booking confirmation template send failed", error);
  }
}

export async function getPublicPaymentDetails(
  workspaceId: string,
  leadId: string,
): Promise<PublicPaymentDetails | null> {
  const workspace = await findWorkspaceByWorkspaceId(workspaceId);
  if (!workspace) return null;

  const tokens = await getWorkspaceCredentials(workspace.email);
  const lead = await getLeadRecord(workspace.email, tokens, leadId);
  if (!lead) return null;

  const eligibleStatuses = ["Awaiting Client", "Payment Pending", "Confirmed", "Payment Received"];
  if (!eligibleStatuses.includes(lead.status)) return null;

  const { config } = workspace;
  // Use the SAME rounding the booking confirmation uses (roundToPremiumNumber),
  // otherwise the advance shown on the pay page would differ from the amount
  // stored on the booking and printed on the invoice.
  const advanceAmount = roundToPremiumNumber(
    (lead.finalApprovedPrice * (Number(config.advancePercentage) || 30)) / 100,
  );
  const balanceDue = Math.max(0, lead.finalApprovedPrice - advanceAmount);

  const upiId = config.upiId || "";
  const upiDeepLink = upiId
    ? `upi://pay?pa=${encodeURIComponent(upiId)}` +
      `&pn=${encodeURIComponent(config.businessName || config.ownerName)}` +
      `&am=${advanceAmount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(leadId)}`
    : "";

  return {
    businessName: config.businessName || workspace.name,
    clientName: lead.clientName,
    eventType: lead.eventType,
    eventDate: lead.eventDate,
    finalApprovedPrice: lead.finalApprovedPrice,
    advanceAmount,
    balanceDue,
    upiId,
    upiDeepLink,
    paymentTerms: config.paymentTerms || "",
    leadStatus: lead.status,
    paymentStatus: lead.paymentStatus || "",
    onlinePayAvailable: Boolean(config.razorpayKeyId && config.razorpayKeySecret),
    razorpayKeyId: config.razorpayKeyId || "",
    tipsEnabled: config.tipsEnabled === "Yes",
  };
}

export async function submitPaymentScreenshot(
  workspaceId: string,
  leadId: string,
  fileBuffer: Buffer,
  mimeType: string,
  originalName: string,
): Promise<{ ok: true; fileUrl: string } | { ok: false; error: string }> {
  const workspace = await findWorkspaceByWorkspaceId(workspaceId);
  if (!workspace) return { ok: false, error: "Workspace not found" };

  const tokens = await getWorkspaceCredentials(workspace.email);
  const lead = await getLeadRecord(workspace.email, tokens, leadId);
  if (!lead) return { ok: false, error: "Lead not found" };

  const eligible = ["Awaiting Client", "Payment Pending", "Confirmed"];
  if (!eligible.includes(lead.status)) return { ok: false, error: "Payment not expected for this booking" };

  const { drive } = createGoogleClients(tokens);
  const ext = originalName.split(".").pop() || "jpg";
  const fileName = `payment-screenshot-${leadId}.${ext}`;

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType,
      description: `Payment screenshot for ${lead.clientName} — ${leadId}`,
    },
    media: { mimeType, body: Readable.from(fileBuffer) },
    fields: "id, webViewLink",
  });

  const fileId = response.data.id;
  if (!fileId) return { ok: false, error: "Drive upload failed" };

  try {
    await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } });
  } catch { /* keep private if sharing is blocked */ }

  const fileUrl =
    response.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

  // A screenshot at this stage means the client has paid the advance to lock
  // the slot. Mark the lead "Advance Paid" / "Payment Received" and keep a
  // note pointing at the proof so the artist can verify.
  const noteLine = `Payment screenshot uploaded ${new Date().toISOString().slice(0, 10)}: ${fileUrl}`;
  await updateLeadRecord(workspace.email, tokens, leadId, (l) => ({
    ...l,
    paymentStatus: "Advance Paid",
    status: "Payment Received" as typeof l.status,
    ownerNotes: l.ownerNotes ? `${l.ownerNotes}\n${noteLine}` : noteLine,
    lastContactedAt: new Date().toISOString(),
  }));

  // Keep the booking record in sync when the lead has already been confirmed.
  if (lead.bookingId) {
    try {
      await updateBookingRecord(workspace.email, tokens, lead.bookingId, (b) => ({
        ...b,
        paymentStatus: "Advance Paid",
      }));
    } catch {
      // Booking row may not exist yet — lead-level status is the source of truth.
    }
  }

  // Audit trail so the upload is visible in the Conversations/activity view.
  try {
    await logInteractionForWorkspace(workspace.email, tokens, {
      leadId,
      direction: "Inbound",
      channel: "Booking Page",
      actor: lead.clientName || "Client",
      message: `Uploaded payment screenshot. Proof: ${fileUrl}`,
      aiSummary: "Client submitted payment proof — verify and confirm the slot.",
    });
  } catch {
    // Logging is best-effort; never fail the client's upload because of it.
  }

  return { ok: true, fileUrl };
}

// Resolves the client's selected add-on names (comma-joined from the booking
// form) to priced line items using the service's configured add-on list.
// Unknown names and zero-priced add-ons are skipped.
export function matchSelectedAddons(
  config: WorkspaceConfig,
  eventType: string,
  selectedRaw: string | undefined,
): { label: string; amount: number }[] {
  if (!selectedRaw) return [];
  const addonsKey = (
    {
      Bridal: "serviceBridalAddons",
      Engagement: "serviceEngagementAddons",
      Reception: "serviceReceptionAddons",
      Party: "servicePartyAddons",
      Shoot: "serviceShootAddons",
      Other: "serviceOtherAddons",
    } as const
  )[eventType];
  if (!addonsKey) return [];
  const configured = parseAddons(String(config[addonsKey] || ""));
  const selected = String(selectedRaw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return configured
    .filter((addon) => addon.price > 0 && selected.includes(addon.name.toLowerCase()))
    .map((addon) => ({ label: `${addon.name} (add-on)`, amount: addon.price }));
}

// Time slots for a date with real availability: each configured slot, greyed
// out when an existing job (with its service duration) overlaps it. Powers the
// public booking page so two 4-hour bridals can't be booked into each other.
export async function getPublicSlotsForDate(
  workspaceId: string,
  eventDate: string,
  eventType: string,
): Promise<{ slots: { time: string; available: boolean }[] } | null> {
  const workspace = await findWorkspaceByWorkspaceId(workspaceId);
  if (!workspace) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return { slots: [] };

  const timeSlots = parseTimeSlots(workspace.config.bookingTimeSlots);
  if (!timeSlots.length) return { slots: [] };

  const tokens = await getWorkspaceCredentials(workspace.email);
  const busy = await listActiveLeadsForDate(workspace.email, tokens, eventDate).catch(() => []);
  return {
    slots: computeSlotAvailability({
      timeSlots,
      serviceDurations: workspace.config.serviceDurations,
      requestedEventType: eventType || "Other",
      busy: busy.map((lead) => ({ eventTime: lead.eventTime, eventType: lead.eventType })),
    }),
  };
}

function buildInboundMessage(input: PublicBookingInput) {
  return [
    `Booking request via website for ${input.eventType}.`,
    `Date: ${input.eventDate}${input.eventTime ? ` at ${input.eventTime}` : ""}.`,
    `Location: ${input.locationText}.`,
    input.addons ? `Addons: ${input.addons}.` : "",
    input.clientInstagram ? `Instagram: ${input.clientInstagram}.` : "",
    input.notes ? `Notes: ${input.notes}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}
