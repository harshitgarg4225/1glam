import { Readable } from "node:stream";
import { appConfig } from "../config.js";
import { getWorkspaceCredentials } from "./auth-store.js";
import { computeSlotAvailability, countActiveLeadsForDate, createLeadForWorkspace, getLeadRecord, busySlotsForDate, updateLeadRecord, roundToPremiumNumber, durationHoursForEvent, depositPercentForEvent } from "./booking.js";
import { findWorkspaceByWorkspaceId, withSerializedLock, lockKeyFromString } from "./database.js";
import { createGoogleClients } from "./google.js";
import { logInteractionForWorkspace } from "./integrations.js";
import { sendWhatsAppTemplate } from "./messaging.js";
import { ensureSheetTab } from "./sheets-util.js";
import { sheetNames } from "./sheet-definitions.js";
import { parsePromoCode, promoCodeToRow, promoCodeHeaders, validatePromo } from "./promo-codes.js";
import { buildRescheduleUrl, buildCancelUrl, signDocumentToken } from "./document-links.js";
import { listArtists } from "./team.js";
import { TtlCache } from "./cache.js";
import type { Credentials } from "google-auth-library";
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
  // Highest variant price, so the page can show a "₹X–₹Y" range when tiers vary.
  maxPrice: number;
  // Approximate hours this service takes — shown on the booking page so the
  // client knows to set aside the time (Booksy shows this on every service).
  durationHours: number;
  description: string;
  addons: PublicAddon[];
  variants: ServiceVariant[];
  // Optional cover image URL displayed on the service card.
  imageUrl: string;
};

export type PublicAvailability = {
  enabled: boolean;
  minDate: string;
  maxDate: string;
  offWeekdays: number[];
  blockedDates: string[];
  timeSlots: string[];
  waitlistEnabled: boolean;
  // Per-event-type time slots; keyed by event key (e.g. "Bridal"). When
  // present for a given key, overrides the global timeSlots for that service.
  timeSlotsByEvent: Record<string, string[]>;
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
  // Whether to show the "Have a promo code?" field on the booking page.
  promoCodesEnabled: boolean;
};

export type PublicPaymentDetails = {
  businessName: string;
  clientName: string;
  eventType: string;
  eventDate: string;
  eventTime: string;
  venue: string;
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
  // bookingId if the lead has been confirmed into a booking.
  bookingId: string;
  // Pre-signed action URLs so the appointment hub can link straight to the
  // sign / reschedule / cancel pages, which each require their own HMAC token.
  // Empty until the lead becomes a booking (bookingId set).
  signUrl: string;
  rescheduleUrl: string;
  cancelUrl: string;
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

// Returns event-specific time slots for a given event type, falling back to
// an empty array when no per-event override is configured (caller should then
// use the global bookingTimeSlots).
function getEventTimeSlots(config: WorkspaceConfig, eventType: string): string[] {
  const fieldKey = ({
    Bridal: "timeSlotsBridal",
    Engagement: "timeSlotsEngagement",
    Reception: "timeSlotsReception",
    Party: "timeSlotsParty",
    Shoot: "timeSlotsShoot",
    Other: "timeSlotsOther",
  } as Record<string, keyof WorkspaceConfig>)[eventType];
  if (!fieldKey) return [];
  return parseTimeSlots(String(config[fieldKey] || ""));
}

export function buildAvailability(config: WorkspaceConfig): PublicAvailability {
  const leadTime = Math.max(0, Number(config.bookingLeadTimeDays) || 0);
  const maxAdvance = Number(config.bookingMaxAdvanceDays) > 0 ? Number(config.bookingMaxAdvanceDays) : 365;

  const timeSlotsByEvent: Record<string, string[]> = {};
  for (const event of ["Bridal", "Engagement", "Reception", "Party", "Shoot", "Other"]) {
    const slots = getEventTimeSlots(config, event);
    if (slots.length > 0) timeSlotsByEvent[event] = slots;
  }

  return {
    enabled: String(config.bookingPageEnabled || "Yes").toLowerCase() !== "no",
    minDate: addDaysIso(leadTime),
    maxDate: addDaysIso(maxAdvance),
    offWeekdays: parseOffWeekdays(config.bookingWeeklyOffDays),
    blockedDates: parseBlockedDates(config.bookingBlockedDates),
    timeSlots: parseTimeSlots(config.bookingTimeSlots),
    waitlistEnabled: String(config.bookingWaitlistEnabled || "No").toLowerCase() === "yes",
    timeSlotsByEvent,
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
  promoCode?: string;
  preferredArtist?: string;
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
    { key: "Bridal", startingPrice: config.basePriceBridal, descKey: "serviceBridalDesc" as const, addonsKey: "serviceBridalAddons" as const, imageUrlKey: "serviceBridalImageUrl" as const },
    { key: "Engagement", startingPrice: config.basePriceEngagement, descKey: "serviceEngagementDesc" as const, addonsKey: "serviceEngagementAddons" as const, imageUrlKey: "serviceEngagementImageUrl" as const },
    { key: "Reception", startingPrice: config.basePriceReception, descKey: "serviceReceptionDesc" as const, addonsKey: "serviceReceptionAddons" as const, imageUrlKey: "serviceReceptionImageUrl" as const },
    { key: "Party", startingPrice: config.basePriceParty, descKey: "servicePartyDesc" as const, addonsKey: "servicePartyAddons" as const, imageUrlKey: "servicePartyImageUrl" as const },
    { key: "Shoot", startingPrice: config.basePriceShoot, descKey: "serviceShootDesc" as const, addonsKey: "serviceShootAddons" as const, imageUrlKey: "serviceShootImageUrl" as const },
    { key: "Other", startingPrice: config.basePriceOther, descKey: "serviceOtherDesc" as const, addonsKey: "serviceOtherAddons" as const, imageUrlKey: "serviceOtherImageUrl" as const },
  ].map((entry) => {
    const variants = allVariants[entry.key] ?? [];
    const basePrice = Number(entry.startingPrice) || 0;
    const variantPrices = variants.map((v) => v.price).filter((p) => p > 0);
    const startingPrice = variantPrices.length > 0 ? Math.min(...variantPrices) : basePrice;
    const maxPrice = variantPrices.length > 0 ? Math.max(...variantPrices) : basePrice;
    return {
      key: entry.key,
      label: EVENT_TYPE_LABELS[entry.key] ?? entry.key,
      startingPrice,
      maxPrice,
      durationHours: durationHoursForEvent(config.serviceDurations, entry.key),
      description: String(config[entry.descKey] || ""),
      addons: parseAddons(String(config[entry.addonsKey] || "")),
      variants,
      // sanitizeUrl enforces http(s) so a malformed value can't break out of the
      // <img src> attribute or smuggle a javascript: URL onto the public page.
      imageUrl: sanitizeUrl(config[entry.imageUrlKey]),
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
    promoCodesEnabled: config.promoCodesEnabled === "Yes",
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

  const eventSlots = getEventTimeSlots(workspace.config, input.eventType);
  const timeSlots = eventSlots.length > 0 ? eventSlots : parseTimeSlots(workspace.config.bookingTimeSlots);
  if (timeSlots.length > 0 && input.eventTime) {
    if (!timeSlots.includes(input.eventTime)) {
      throw new Error("Please choose one of the available time slots.");
    }
  }

  const tokens = await getWorkspaceCredentials(workspace.email);

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

  // Serialize the slot-conflict check + capacity check + lead creation per
  // (workspace, date) so two simultaneous requests for the same date can't both
  // slip past the max-per-day cap OR both grab the same time slot. The check
  // MUST run inside the lock: done outside it, two clients racing for 09:00 each
  // read the slot as free before either commits, and both double-book. The lock
  // is a no-op in single-instance/file mode.
  const lockKey = lockKeyFromString(`book:${workspace.workspaceId}:${input.eventDate}`);
  const { waitlisted, result } = await withSerializedLock(lockKey, async () => {
    let waitlisted = false;

    // Duration-aware slot conflict: a 4-hour bridal at 09:00 occupies
    // 09:00-13:00, so an 11:00 request must be refused (or waitlisted) even when
    // the day-level capacity isn't reached yet. Fails open on a Sheets hiccup —
    // a flaky read should never block a client from booking.
    if (timeSlots.length > 0 && input.eventTime) {
      const busy = await busySlotsForDate(workspace.email, tokens, input.eventDate).catch(() => []);
      const slots = computeSlotAvailability({
        timeSlots,
        serviceDurations: workspace.config.serviceDurations,
        requestedEventType: input.eventType,
        busy,
        bufferMinutes: Number(workspace.config.bufferMinutes) || 0,
      });
      const requested = slots.find((slot) => slot.time === input.eventTime);
      if (requested && !requested.available) {
        const waitlistEnabled = String(workspace.config.bookingWaitlistEnabled || "No").toLowerCase() === "yes";
        if (!waitlistEnabled) {
          throw new Error("That time slot was just taken. Please pick another time.");
        }
        waitlisted = true;
      }
    }

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
      preferredArtist: input.preferredArtist,
    });
    return { waitlisted, result };
  });

  // Selected add-ons price themselves into the quote: matched against the
  // service's configured "Name:Price" list and stored as quote line items, so
  // the PDF shows "Airbrush (add-on)  +Rs 2,000" on top of the base price
  // instead of the add-ons silently vanishing into the notes. A valid promo
  // code joins them as a negative line item. Best-effort.
  try {
    const addonLines = matchSelectedAddons(workspace.config, input.eventType, input.addons);
    const promoLine = await applyPromoCode(workspace, tokens, input.promoCode, result.lead.finalApprovedPrice);
    const lineItems = [...addonLines, ...(promoLine ? [promoLine] : [])];
    if (lineItems.length) {
      await updateLeadRecord(workspace.email, tokens, result.lead.leadId, (lead) => ({
        ...lead,
        quoteAdjustments: JSON.stringify({ lineItems }),
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
  const advancePct = depositPercentForEvent(
    config.depositPercentByService,
    Number(config.advancePercentage) || 30,
    lead.eventType,
  );
  const advanceAmount = roundToPremiumNumber(
    (lead.finalApprovedPrice * advancePct) / 100,
  );
  const balanceDue = Math.max(0, lead.finalApprovedPrice - advanceAmount);

  const upiId = config.upiId || "";
  const upiDeepLink = upiId
    ? `upi://pay?pa=${encodeURIComponent(upiId)}` +
      `&pn=${encodeURIComponent(config.businessName || config.ownerName)}` +
      `&am=${advanceAmount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(leadId)}`
    : "";

  // Once the lead is a confirmed booking, the appointment hub needs correctly
  // signed links for the sign / reschedule / cancel pages (each route enforces
  // its own HMAC token). Sign reuses the same "contract" document token the
  // sign page already verifies; reschedule/cancel use their time-limited tokens.
  const bookingId = lead.bookingId || "";
  let signUrl = "";
  let rescheduleUrl = "";
  let cancelUrl = "";
  if (bookingId) {
    const contractSig = signDocumentToken("contract", workspaceId, bookingId);
    const signPath = new URL(
      `/sign/${encodeURIComponent(workspaceId)}/${encodeURIComponent(bookingId)}`,
      appConfig.baseUrl,
    );
    signPath.searchParams.set("sig", contractSig);
    signUrl = signPath.toString();
    rescheduleUrl = buildRescheduleUrl(workspaceId, bookingId);
    cancelUrl = buildCancelUrl(workspaceId, bookingId);
  }

  return {
    businessName: config.businessName || workspace.name,
    clientName: lead.clientName,
    eventType: lead.eventType,
    eventDate: lead.eventDate,
    eventTime: lead.eventTime || "",
    venue: lead.locationText || "",
    finalApprovedPrice: lead.finalApprovedPrice,
    advanceAmount,
    balanceDue,
    upiId,
    upiDeepLink,
    paymentTerms: config.paymentTerms || "",
    leadStatus: lead.status,
    paymentStatus: lead.paymentStatus || "",
    onlinePayAvailable: Boolean(config.razorpayKeyId && config.razorpayKeySecret),
    // Only expose the publishable key when online pay is actually enabled — no
    // reason to hand a client the owner's processor identity otherwise.
    razorpayKeyId: config.razorpayKeyId && config.razorpayKeySecret ? config.razorpayKeyId : "",
    tipsEnabled: config.tipsEnabled === "Yes",
    bookingId,
    signUrl,
    rescheduleUrl,
    cancelUrl,
  };
}

export type PublicArtist = {
  name: string;
  skillLevel: string;
  bio: string;
};

// The booking page is the app's hottest public surface and the artist list lives
// in Google Sheets (~60 reads/min/user). A 60s read-through cache with request
// coalescing keeps the page fast and the owner's Sheets quota safe under traffic;
// the only cost is a newly added/removed specialist taking up to a minute to
// appear to clients, which is acceptable for a public listing.
const publicArtistsCache = new TtlCache<PublicArtist[]>(60 * 1000);

export async function getPublicArtists(workspaceId: string): Promise<PublicArtist[]> {
  const workspace = await findWorkspaceByWorkspaceId(workspaceId);
  if (!workspace) return [];
  return publicArtistsCache.getOrLoad(workspace.workspaceId, async () => {
    try {
      const tokens = await getWorkspaceCredentials(workspace.email);
      const artists = await listArtists(workspace.email, tokens);
      return artists
        .filter((a) => a.active !== "No")
        .map((a) => ({ name: a.name, skillLevel: a.skillLevel, bio: a.bio }));
    } catch {
      return [];
    }
  });
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

  // A screenshot is *unverified* proof — anyone can upload any image. We must
  // NOT mark the booking paid on the client's word alone (that would let a
  // client lock a slot with a blank screenshot). Move it to "Payment Pending"
  // so it surfaces in the artist's queue for verification, and leave the
  // authoritative paymentStatus untouched until a human confirms.
  const istDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const noteLine = `Payment screenshot uploaded ${istDate} — VERIFY before confirming: ${fileUrl}`;
  await updateLeadRecord(workspace.email, tokens, leadId, (l) => ({
    ...l,
    // Only advance the workflow status, never the payment status. Don't
    // downgrade a lead that's already further along (e.g. "Confirmed").
    status: (l.status === "Awaiting Client" ? "Payment Pending" : l.status) as typeof l.status,
    ownerNotes: l.ownerNotes ? `${l.ownerNotes}\n${noteLine}` : noteLine,
    lastContactedAt: new Date().toISOString(),
  }));

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

// Validates and redeems a promo code at booking time. On success it increments
// the code's redemption counter and returns the discount as a negative quote
// line item; returns null when no code, codes are disabled, or it's invalid.
async function applyPromoCode(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  rawCode: string | undefined,
  baseAmount: number,
): Promise<{ label: string; amount: number } | null> {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code || workspace.config.promoCodesEnabled !== "Yes") return null;

  // Serialize the whole read → validate → increment per (workspace, code) so two
  // concurrent bookings can't both pass the redemption-cap check and over-redeem.
  const lockKey = lockKeyFromString(`promo:${workspace.workspaceId}:${code}`);
  return withSerializedLock(lockKey, async () => {
    const { sheets } = createGoogleClients(tokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.promoCodes, promoCodeHeaders);
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.promoCodes}!A2:J`,
    });
    const rows = got.data.values ?? [];
    const idx = rows.findIndex((r) => String(r[1] || "").toUpperCase() === code);
    if (idx < 0) return null;

    const promo = parsePromoCode(rows[idx]);
    const result = validatePromo(promo, baseAmount);
    if (!result.ok) return null;

    // Increment the redemption counter while still holding the lock.
    promo.timesRedeemed += 1;
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: workspace.spreadsheetId,
        range: `${sheetNames.promoCodes}!A${idx + 2}:J${idx + 2}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [promoCodeToRow(promo)] },
      });
    } catch (error) {
      // Counter is advisory; never block the booking on a write hiccup — but make
      // the failure visible so a stuck counter can be noticed.
      console.error(`Promo redemption counter write failed for ${code}:`, error);
    }
    return { label: `Promo ${code} (${result.label})`, amount: -result.discount };
  });
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

  const eventSlots = getEventTimeSlots(workspace.config, eventType);
  const timeSlots = eventSlots.length > 0 ? eventSlots : parseTimeSlots(workspace.config.bookingTimeSlots);
  if (!timeSlots.length) return { slots: [] };

  const tokens = await getWorkspaceCredentials(workspace.email);
  const busy = await busySlotsForDate(workspace.email, tokens, eventDate).catch(() => []);
  return {
    slots: computeSlotAvailability({
      timeSlots,
      serviceDurations: workspace.config.serviceDurations,
      requestedEventType: eventType || "Other",
      busy,
      bufferMinutes: Number(workspace.config.bufferMinutes) || 0,
    }),
  };
}

// Validates a date/time against the artist's public availability — lead time,
// max-advance window, weekly days off, blocked dates, an all-day calendar
// block, and duration-aware slot conflicts (with buffer). Used by the
// self-service reschedule flow, which previously skipped every one of these.
export async function checkPublicAvailability(
  workspaceId: string,
  eventType: string,
  eventDate: string,
  eventTime: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const workspace = await findWorkspaceByWorkspaceId(workspaceId);
  if (!workspace) return { ok: false, error: "Not found" };
  // Guard the date format before any Date math — a non-ISO value like "2026-6-5"
  // yields a NaN weekday that wrongly passes as available and then persists a
  // malformed date that breaks slot/reminder logic downstream.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    return { ok: false, error: "Please pick a valid date." };
  }
  const availability = buildAvailability(workspace.config);
  if (availability.minDate && eventDate < availability.minDate) {
    return { ok: false, error: "That date is too soon — please pick a later one." };
  }
  if (availability.maxDate && eventDate > availability.maxDate) {
    return { ok: false, error: "That date is too far ahead. Please pick an earlier one." };
  }
  const weekday = new Date(eventDate + "T00:00:00Z").getUTCDay();
  if (availability.offWeekdays.includes(weekday)) {
    return { ok: false, error: "The artist isn't available on that day of the week." };
  }
  if (availability.blockedDates.includes(eventDate)) {
    return { ok: false, error: "That date is unavailable. Please choose another." };
  }
  const tokens = await getWorkspaceCredentials(workspace.email);
  const busyAllDay = await hasAllDayCalendarEvent(workspace, tokens, eventDate).catch(() => false);
  if (busyAllDay) {
    return { ok: false, error: "That date is unavailable. Please choose another." };
  }
  const eventSlots = getEventTimeSlots(workspace.config, eventType);
  const timeSlots = eventSlots.length > 0 ? eventSlots : parseTimeSlots(workspace.config.bookingTimeSlots);
  if (timeSlots.length > 0 && eventTime) {
    if (!timeSlots.includes(eventTime)) {
      return { ok: false, error: "Please choose one of the available time slots." };
    }
    const busy = await busySlotsForDate(workspace.email, tokens, eventDate).catch(() => []);
    const slots = computeSlotAvailability({
      timeSlots,
      serviceDurations: workspace.config.serviceDurations,
      requestedEventType: eventType || "Other",
      busy,
      bufferMinutes: Number(workspace.config.bufferMinutes) || 0,
    });
    const requested = slots.find((slot) => slot.time === eventTime);
    if (requested && !requested.available) {
      return { ok: false, error: "That time is no longer free. Please pick another." };
    }
  }
  return { ok: true };
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
