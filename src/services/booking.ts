import { nanoid } from "nanoid";
import type { Credentials } from "google-auth-library";
import type { calendar_v3 } from "googleapis";
import { appConfig } from "../config.js";
import { createGoogleClients } from "./google.js";
import { enrichLeadWithGrok } from "./grok.js";
import { logInteractionForWorkspace } from "./integrations.js";
import { resolveTravelIntelligence } from "./maps.js";
import { sendWhatsAppTemplate } from "./messaging.js";
import { sendPushToWorkspace } from "./push.js";
import { listArtists } from "./team.js";
import { getWorkspaceByEmail } from "./workspace.js";
import { lockKeyFromString, withSerializedLock } from "./database.js";
import { TtlCache } from "./cache.js";
import { bookingHeaders, leadHeaders, sheetNames } from "./sheet-definitions.js";

// Raw sheet-scan cache. Google Sheets allows ~60 reads/min per user, and
// every dashboard refresh, webhook, and scheduler pass scans the full Leads
// and Bookings sheets — so this cache is what lets one artist's busy day (or
// many artists on one instance) stay inside quota. Row numbers are stable
// (rows are only appended or updated in place, never deleted), so cached row
// positions remain valid for the cache's lifetime. Every write below
// invalidates the relevant sheet's entry.
const SHEET_CACHE_TTL_MS = 20_000;
const leadSheetCache = new TtlCache<string[][]>(SHEET_CACHE_TTL_MS);
const bookingSheetCache = new TtlCache<string[][]>(SHEET_CACHE_TTL_MS);

async function readLeadSheetRows(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  opts?: { fresh?: boolean },
): Promise<string[][]> {
  const key = workspace.spreadsheetId;
  if (opts?.fresh) leadSheetCache.delete(key);
  return leadSheetCache.getOrLoad(key, async () => {
    const { sheets } = createGoogleClients(tokens);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.leads}!A2:${toColumn(leadHeaders.length)}`,
    });
    return response.data.values ?? [];
  });
}

async function readBookingSheetRows(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  opts?: { fresh?: boolean },
): Promise<string[][]> {
  const key = workspace.spreadsheetId;
  if (opts?.fresh) bookingSheetCache.delete(key);
  return bookingSheetCache.getOrLoad(key, async () => {
    const { sheets } = createGoogleClients(tokens);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.bookings}!A2:${toColumn(bookingHeaders.length)}`,
    });
    return response.data.values ?? [];
  });
}

function invalidateLeadSheet(spreadsheetId: string) {
  leadSheetCache.delete(spreadsheetId);
}
function invalidateBookingSheet(spreadsheetId: string) {
  bookingSheetCache.delete(spreadsheetId);
}
import type { WorkspaceRecord } from "../types.js";

export type LeadStatus =
  | "New"
  | "Awaiting Client"
  | "Confirmed"
  | "Payment Pending"
  | "Payment Received"
  | "Completed"
  | "Lost";

export type LeadRecord = {
  leadId: string;
  createdAt: string;
  source: string;
  clientName: string;
  clientWhatsApp: string;
  clientInstagram: string;
  eventType: string;
  eventDate: string;
  eventTime: string;
  locationText: string;
  distanceKm: number;
  travelTimeMin: number;
  outstationFlag: string;
  profileTier: string;
  followers: number;
  clientTags: string;
  aiInsight: string;
  suggestedReply: string;
  demandCount: number;
  scarcityTag: string;
  holdExpiresAt: string;
  initialAiPrice: number;
  finalApprovedPrice: number;
  discountPercent: number;
  ownerDecision: string;
  ownerNotes: string;
  status: LeadStatus;
  assignedArtist: string;
  lastContactedAt: string;
  tentativeCalendarEventId: string;
  confirmedCalendarEventId: string;
  bookingId: string;
  paymentStatus: string;
  quoteUrl: string;
  quoteGeneratedAt: string;
  quoteVoidedAt: string;
  quoteAdjustments: string;
  orderItems: string;
  // Sequential, human-friendly document number (e.g. Q-2026-0007), assigned
  // the first time a quote is generated and stable thereafter.
  quoteNumber: string;
  // First time the client opened the public quote link.
  quoteViewedAt: string;
  // Set when the client taps "Accept" on the public quote page.
  quoteAcceptedAt: string;
};

export type BookingRecord = {
  bookingId: string;
  leadId: string;
  bookedAt: string;
  clientName: string;
  clientWhatsApp: string;
  eventType: string;
  eventDate: string;
  eventTime: string;
  venue: string;
  assignedArtist: string;
  finalPrice: number;
  advanceAmount: number;
  balanceDue: number;
  tentativeCalendarEventId: string;
  confirmedCalendarEventId: string;
  contractUrl: string;
  invoiceUrl: string;
  paymentStatus: string;
  status: string;
  contractStatus: string;
  contractSentAt: string;
  invoiceGeneratedAt: string;
  remindersSent: string;
  invoiceVoidedAt: string;
  contractVoidedAt: string;
  invoiceAdjustments: string;
  contractAdjustments: string;
  orderItems: string;
  contractSignedAt: string;
  contractSignerName: string;
  expenses: string;
  // Sequential invoice number (e.g. INV-2026-0012), assigned at first invoice.
  invoiceNumber: string;
  // JSON array of recorded payments: [{amount, method, note, at}]. The source
  // of truth for how much has actually been received against this booking.
  paymentsLog: string;
  invoiceViewedAt: string;
  contractViewedAt: string;
};

export type DashboardData = {
  leads: LeadRecord[];
  bookings: BookingRecord[];
};

type PricingResult = {
  basePrice: number;
  seasonMultiplier: number;
  demandMultiplier: number;
  profileMultiplier: number;
  travelCost: number;
  finalPrice: number;
  scarcityTag: string;
  travelSource: "google_maps" | "fallback" | "manual";
};

export type CreateLeadInput = {
  source: string;
  clientName: string;
  clientWhatsApp: string;
  clientInstagram?: string;
  eventType: string;
  eventDate: string;
  eventTime?: string;
  locationText: string;
  distanceKm?: number;
  travelTimeMin?: number;
  profileTier?: string;
  followers?: number;
  clientTags?: string;
  inboundMessage?: string;
};

export async function createLeadForWorkspace(
  email: string,
  tokens: Credentials,
  input: CreateLeadInput,
) {
  const workspace = await getRequiredWorkspace(email);
  const { sheets } = createGoogleClients(tokens);
  const demandCount = await getDemandCountForDate(workspace, tokens, input.eventDate);
  const travel = await resolveTravelIntelligence({
    originCity: workspace.config.city,
    destinationText: input.locationText,
    manualDistanceKm: input.distanceKm,
    manualTravelTimeMin: input.travelTimeMin,
    outstationThresholdKm: workspace.config.travelOutstationThresholdKm,
  });
  const aiLeadIntel = await enrichLeadWithGrok({
    ownerName: workspace.config.ownerName,
    brandName: workspace.config.businessName,
    city: workspace.config.city,
    source: input.source,
    clientName: input.clientName,
    clientInstagram: input.clientInstagram,
    eventType: input.eventType,
    eventDate: input.eventDate,
    eventTime: input.eventTime,
    locationText: input.locationText,
    followers: input.followers,
    inboundMessage: input.inboundMessage,
  });
  const resolvedProfileTier = input.profileTier ?? aiLeadIntel?.profileTier ?? "Mid";
  const pricing = calculatePricing(workspace, { ...input, profileTier: resolvedProfileTier }, demandCount, travel);
  const createdAt = new Date().toISOString();

  const lead: LeadRecord = {
    leadId: buildId("L"),
    createdAt,
    source: input.source,
    clientName: input.clientName,
    clientWhatsApp: input.clientWhatsApp,
    clientInstagram: input.clientInstagram ?? "",
    eventType: input.eventType,
    eventDate: input.eventDate,
    eventTime: input.eventTime ?? "",
    locationText: travel.normalizedDestination || input.locationText,
    distanceKm: travel.distanceKm,
    travelTimeMin: travel.travelTimeMin,
    outstationFlag: travel.outstation ? "Yes" : "No",
    profileTier: resolvedProfileTier,
    followers: input.followers ?? 0,
    clientTags: input.clientTags ?? aiLeadIntel?.clientTags ?? "",
    aiInsight: aiLeadIntel?.aiInsight ?? "",
    suggestedReply: aiLeadIntel?.suggestedReply ?? "",
    demandCount,
    scarcityTag: pricing.scarcityTag,
    holdExpiresAt: "",
    initialAiPrice: pricing.finalPrice,
    finalApprovedPrice: pricing.finalPrice,
    discountPercent: 0,
    ownerDecision: "",
    ownerNotes: "",
    status: "New",
    assignedArtist: workspace.config.ownerName || "Owner",
    lastContactedAt: createdAt,
    tentativeCalendarEventId: "",
    confirmedCalendarEventId: "",
    bookingId: "",
    paymentStatus: "Not Started",
    quoteUrl: "",
    quoteGeneratedAt: "",
    quoteVoidedAt: "",
    quoteAdjustments: "",
    orderItems: "",
    quoteNumber: "",
    quoteViewedAt: "",
    quoteAcceptedAt: "",
  };

  await sheets.spreadsheets.values.append({
    spreadsheetId: workspace.spreadsheetId,
    range: `${sheetNames.leads}!A:${toColumn(leadHeaders.length)}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [leadToRow(lead)],
    },
  });
  invalidateLeadSheet(workspace.spreadsheetId);

  // Ping the owner about client-initiated requests (booking page, DMs,
  // webhooks) so nothing sits unseen until she opens the app. Her own manual
  // adds don't need an alert.
  if (input.source !== "Manual") {
    void notifyOwnerOfNewLead(workspace, lead);
  }

  return {
    lead,
    pricing,
    travel,
    aiLeadIntel,
  };
}

// Fire-and-forget WhatsApp alert to the owner's own number when a new request
// lands. Same template-gating as every business-initiated message: silently
// skips (and shows as "needs setup" in the automation panel) until the owner
// alert template is configured and WhatsApp can send.
async function notifyOwnerOfNewLead(workspace: WorkspaceRecord, lead: LeadRecord) {
  // Device push first (works with zero WhatsApp setup, even app-closed on PWA).
  sendPushToWorkspace(workspace, {
    title: `New request: ${lead.clientName}`,
    body: `${lead.eventType} on ${lead.eventDate}${lead.locationText ? ` · ${lead.locationText}` : ""}`,
    url: "/",
  }).catch(() => undefined);

  try {
    const templateName = String(workspace.config.ownerAlertTemplate || "").trim();
    if (!templateName) return;

    const whatsapp = workspace.metaConnections?.whatsapp;
    const connectionCanSend = whatsapp?.status === "connected" && Boolean(whatsapp.accessToken && whatsapp.phoneNumberId);
    const envCanSend = Boolean(appConfig.waAccessToken && appConfig.waPhoneNumberId);
    if (!connectionCanSend && !envCanSend) return;

    const ownerPhone = String(workspace.config.ownerWhatsApp || "").replace(/[^\d]/g, "");
    if (!ownerPhone) return;

    await sendWhatsAppTemplate(
      { accessToken: whatsapp?.accessToken, phoneNumberId: whatsapp?.phoneNumberId },
      ownerPhone,
      templateName,
      String(workspace.config.ownerAlertTemplateLang || "en"),
      [lead.clientName, lead.eventType, lead.eventDate],
    );
  } catch (error) {
    console.error("Owner new-lead alert failed", error);
  }
}

export async function applyOwnerDecision(
  email: string,
  tokens: Credentials,
  leadId: string,
  decision: "YES" | "NO" | "EDIT",
  approvedPrice?: number,
  ownerNotes?: string,
) {
  const workspace = await getRequiredWorkspace(email);
  const lead = await findLeadById(workspace, tokens, leadId);
  if (!lead) {
    throw new Error("Lead not found");
  }

  if (decision === "NO") {
    const updated: LeadRecord = {
      ...lead.record,
      ownerDecision: "NO",
      ownerNotes: ownerNotes ?? "",
      status: "Lost",
      lastContactedAt: new Date().toISOString(),
    };
    await updateLeadRow(workspace, tokens, lead.rowNumber, updated);
    return { lead: updated };
  }

  const finalApprovedPrice = approvedPrice ?? lead.record.initialAiPrice;
  const discountPercent =
    lead.record.initialAiPrice > 0
      ? Math.max(0, Math.round(((lead.record.initialAiPrice - finalApprovedPrice) / lead.record.initialAiPrice) * 100))
      : 0;
  const holdExpiresAt = new Date(
    Date.now() + workspace.config.holdExpiryHours * 60 * 60 * 1000,
  ).toISOString();

  const tentativeEventId = await upsertTentativeCalendarEvent(workspace, tokens, {
    ...lead.record,
    finalApprovedPrice,
    holdExpiresAt,
    status: "Awaiting Client",
  });

  const updated: LeadRecord = {
    ...lead.record,
    ownerDecision: decision,
    ownerNotes: ownerNotes ?? "",
    finalApprovedPrice,
    discountPercent,
    holdExpiresAt,
    status: "Awaiting Client",
    lastContactedAt: new Date().toISOString(),
    tentativeCalendarEventId: tentativeEventId,
  };

  await updateLeadRow(workspace, tokens, lead.rowNumber, updated);

  void sendApprovalNotification(workspace, tokens, updated);

  return { lead: updated };
}

async function sendApprovalNotification(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  lead: LeadRecord,
) {
  const templateName = String(workspace.config.approvalTemplate || "").trim();
  if (!templateName) return;

  const whatsapp = workspace.metaConnections?.whatsapp;
  const connectionCanSend = whatsapp?.status === "connected" && Boolean(whatsapp.accessToken && whatsapp.phoneNumberId);
  const envCanSend = Boolean(appConfig.waAccessToken && appConfig.waPhoneNumberId);
  if (!connectionCanSend && !envCanSend) return;

  const recipientPhone = String(lead.clientWhatsApp || "").replace(/[^\d]/g, "");
  if (!recipientPhone) return;

  try {
    await sendWhatsAppTemplate(
      { accessToken: whatsapp?.accessToken, phoneNumberId: whatsapp?.phoneNumberId },
      recipientPhone,
      templateName,
      String(workspace.config.approvalTemplateLang || "en"),
      [lead.clientName, lead.eventDate, String(lead.finalApprovedPrice)],
    );

    await logInteractionForWorkspace(workspace.email, tokens, {
      leadId: lead.leadId,
      direction: "Outbound",
      channel: "WhatsApp",
      actor: recipientPhone,
      message: `Approval notification template "${templateName}" sent`,
      aiSummary: "Automated lead-approval notification",
    });
  } catch (error) {
    console.error("Approval notification send failed", error);
  }
}

export async function confirmLeadBooking(email: string, tokens: Credentials, leadId: string) {
  const workspace = await getRequiredWorkspace(email);
  const lead = await findLeadById(workspace, tokens, leadId);
  if (!lead) {
    throw new Error("Lead not found");
  }

  const bookingId = buildId("B");
  const advanceAmount = roundToPremiumNumber(
    (lead.record.finalApprovedPrice * (Number(workspace.config.advancePercentage) || 30)) / 100,
  );
  const balanceDue = Math.max(0, lead.record.finalApprovedPrice - advanceAmount);
  const confirmedEventId = await createConfirmedCalendarEvent(workspace, tokens, {
    ...lead.record,
    bookingId,
  });

  const booking: BookingRecord = {
    bookingId,
    leadId: lead.record.leadId,
    bookedAt: new Date().toISOString(),
    clientName: lead.record.clientName,
    clientWhatsApp: lead.record.clientWhatsApp,
    eventType: lead.record.eventType,
    eventDate: lead.record.eventDate,
    eventTime: lead.record.eventTime,
    venue: lead.record.locationText,
    assignedArtist: lead.record.assignedArtist,
    finalPrice: lead.record.finalApprovedPrice,
    advanceAmount,
    balanceDue,
    tentativeCalendarEventId: lead.record.tentativeCalendarEventId,
    confirmedCalendarEventId: confirmedEventId,
    contractUrl: "",
    invoiceUrl: "",
    paymentStatus: "Advance Due",
    status: "Confirmed",
    contractStatus: "Draft",
    contractSentAt: "",
    invoiceGeneratedAt: "",
    remindersSent: "",
    invoiceVoidedAt: "",
    contractVoidedAt: "",
    invoiceAdjustments: "",
    contractAdjustments: "",
    orderItems: lead.record.orderItems || "",
    contractSignedAt: "",
    contractSignerName: "",
    expenses: "",
    invoiceNumber: "",
    paymentsLog: "",
    invoiceViewedAt: "",
    contractViewedAt: "",
  };

  const updatedLead: LeadRecord = {
    ...lead.record,
    status: "Confirmed",
    bookingId,
    paymentStatus: "Advance Due",
    lastContactedAt: new Date().toISOString(),
    confirmedCalendarEventId: confirmedEventId,
    tentativeCalendarEventId: "",
  };

  // Commit the booking row (the source of truth) BEFORE any destructive
  // calendar change. If the append fails, roll back the confirmed event we just
  // created so a retry starts from a clean state — no orphaned events, and the
  // tentative hold is still intact because we haven't touched it yet.
  const { sheets } = createGoogleClients(tokens);
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.bookings}!A:${toColumn(bookingHeaders.length)}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [bookingToRow(booking)],
      },
    });
    invalidateBookingSheet(workspace.spreadsheetId);
  } catch (error) {
    await deleteCalendarEvent(tokens, workspace.confirmedCalendarId, confirmedEventId).catch(() => {});
    throw error;
  }

  // Booking is now persisted. Releasing the tentative hold and updating the lead
  // are best-effort cleanups — a failure here leaves a recoverable, non-destructive
  // state (a stale tentative event) rather than a lost booking.
  if (lead.record.tentativeCalendarEventId) {
    await deleteCalendarEvent(
      tokens,
      workspace.tentativeCalendarId,
      lead.record.tentativeCalendarEventId,
    ).catch(() => {});
  }

  await updateLeadRow(workspace, tokens, lead.rowNumber, updatedLead);

  void notifyTeamOfBooking(workspace, tokens, booking);

  return { lead: updatedLead, booking };
}

// Tells the artist's freelance team a booking just landed. Fire-and-forget,
// mirroring sendApprovalNotification: it never throws into the confirm flow.
// Targets the assigned specialist if one is set, otherwise every active team
// member. Only sends when a team template is configured and WhatsApp can send.
async function notifyTeamOfBooking(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  booking: BookingRecord,
) {
  if (String(workspace.config.notifyTeamOnBooking || "").toLowerCase() === "no") return;

  const templateName = String(workspace.config.teamNotifyTemplate || "").trim();
  if (!templateName) return;

  const whatsapp = workspace.metaConnections?.whatsapp;
  const connectionCanSend =
    whatsapp?.status === "connected" && Boolean(whatsapp.accessToken && whatsapp.phoneNumberId);
  const envCanSend = Boolean(appConfig.waAccessToken && appConfig.waPhoneNumberId);
  if (!connectionCanSend && !envCanSend) return;

  let artists;
  try {
    artists = await listArtists(workspace.email, tokens);
  } catch (error) {
    console.error("Team notify: could not load artists", error);
    return;
  }

  const active = artists.filter((a) => a.active !== "No" && String(a.whatsApp || "").trim());
  const assignedName = String(booking.assignedArtist || "").trim();
  const recipients = assignedName
    ? active.filter((a) => a.name === assignedName)
    : active;
  if (!recipients.length) return;

  const lang = String(workspace.config.teamNotifyTemplateLang || "en");
  for (const artist of recipients) {
    const phone = String(artist.whatsApp || "").replace(/[^\d]/g, "");
    if (!phone) continue;
    try {
      await sendWhatsAppTemplate(
        { accessToken: whatsapp?.accessToken, phoneNumberId: whatsapp?.phoneNumberId },
        phone,
        templateName,
        lang,
        [artist.name, booking.eventType, booking.eventDate, booking.venue || "—"],
      );
      await logInteractionForWorkspace(workspace.email, tokens, {
        leadId: booking.leadId,
        direction: "Outbound",
        channel: "WhatsApp",
        actor: phone,
        message: `Team booking alert "${templateName}" sent to ${artist.name}`,
        aiSummary: "Automated team booking notification",
      });
    } catch (error) {
      console.error(`Team notify send failed for ${artist.name}`, error);
    }
  }
}

// Wedding dates move constantly. Reschedule keeps the booking, the lead, and
// the Google Calendar event in lockstep: the old event is removed and a fresh
// one created on the new date (delete+create is simpler and as reliable as a
// patch for all-day-style events).
export async function rescheduleBooking(
  email: string,
  tokens: Credentials,
  bookingId: string,
  input: { eventDate: string; eventTime?: string; venue?: string },
) {
  const workspace = await getRequiredWorkspace(email);
  const booking = await findBookingById(workspace, tokens, bookingId);
  if (!booking) throw new Error("Booking not found");
  if (booking.record.status === "Cancelled") throw new Error("This booking is cancelled — create a new one instead.");
  const lead = await findLeadById(workspace, tokens, booking.record.leadId);

  const eventTime = input.eventTime ?? booking.record.eventTime;
  const venue = input.venue ?? booking.record.venue;
  if (booking.record.confirmedCalendarEventId) {
    await deleteCalendarEvent(tokens, workspace.confirmedCalendarId, booking.record.confirmedCalendarEventId);
  }
  const leadForEvent: LeadRecord & { bookingId: string } = {
    ...(lead?.record ?? leadFromBooking(booking.record)),
    eventDate: input.eventDate,
    eventTime,
    locationText: venue,
    bookingId,
  };
  const newEventId = await createConfirmedCalendarEvent(workspace, tokens, leadForEvent);

  const updatedBooking: BookingRecord = {
    ...booking.record,
    eventDate: input.eventDate,
    eventTime,
    venue,
    confirmedCalendarEventId: newEventId,
  };
  await updateBookingRow(workspace, tokens, booking.rowNumber, updatedBooking);

  if (lead) {
    await updateLeadRow(workspace, tokens, lead.rowNumber, {
      ...lead.record,
      eventDate: input.eventDate,
      eventTime,
      locationText: venue,
      confirmedCalendarEventId: newEventId,
      lastContactedAt: new Date().toISOString(),
    });
  }
  return updatedBooking;
}

// The job's done: mark both rows Completed so the list stays clean and the
// post-event automations (review requests) can key off it.
export async function completeBooking(email: string, tokens: Credentials, bookingId: string) {
  const workspace = await getRequiredWorkspace(email);
  const booking = await findBookingById(workspace, tokens, bookingId);
  if (!booking) throw new Error("Booking not found");
  if (booking.record.status === "Cancelled") throw new Error("This booking was cancelled.");
  if (booking.record.status === "Completed") return booking.record;

  const updatedBooking: BookingRecord = { ...booking.record, status: "Completed" };
  await updateBookingRow(workspace, tokens, booking.rowNumber, updatedBooking);

  const lead = await findLeadById(workspace, tokens, booking.record.leadId);
  if (lead && !["Lost", "Completed"].includes(lead.record.status)) {
    await updateLeadRow(workspace, tokens, lead.rowNumber, { ...lead.record, status: "Completed" });
  }
  return updatedBooking;
}

// Cancel keeps the financial record (advance received stays on the row) but
// frees the date: calendar event removed, booking marked Cancelled, lead Lost.
export async function cancelBooking(email: string, tokens: Credentials, bookingId: string) {
  const workspace = await getRequiredWorkspace(email);
  const booking = await findBookingById(workspace, tokens, bookingId);
  if (!booking) throw new Error("Booking not found");
  if (booking.record.status === "Cancelled") return booking.record;

  if (booking.record.confirmedCalendarEventId) {
    await deleteCalendarEvent(tokens, workspace.confirmedCalendarId, booking.record.confirmedCalendarEventId);
  }

  const updatedBooking: BookingRecord = {
    ...booking.record,
    status: "Cancelled",
    confirmedCalendarEventId: "",
  };
  await updateBookingRow(workspace, tokens, booking.rowNumber, updatedBooking);

  const lead = await findLeadById(workspace, tokens, booking.record.leadId);
  if (lead && lead.record.status !== "Lost") {
    await updateLeadRow(workspace, tokens, lead.rowNumber, {
      ...lead.record,
      status: "Lost",
      ownerNotes: [lead.record.ownerNotes, `Booking cancelled on ${new Date().toISOString().slice(0, 10)}`]
        .filter(Boolean)
        .join(" | "),
      lastContactedAt: new Date().toISOString(),
    });
  }
  return updatedBooking;
}

// Minimal lead-shaped record for the calendar event when the original lead row
// is missing (e.g. manually deleted from the sheet).
function leadFromBooking(booking: BookingRecord): LeadRecord {
  return {
    leadId: booking.leadId, createdAt: booking.bookedAt, source: "Manual",
    clientName: booking.clientName, clientWhatsApp: booking.clientWhatsApp, clientInstagram: "",
    eventType: booking.eventType, eventDate: booking.eventDate, eventTime: booking.eventTime,
    locationText: booking.venue, distanceKm: 0, travelTimeMin: 0, outstationFlag: "No",
    profileTier: "Mid", followers: 0, clientTags: "", aiInsight: "", suggestedReply: "",
    demandCount: 0, scarcityTag: "", holdExpiresAt: "", initialAiPrice: booking.finalPrice,
    finalApprovedPrice: booking.finalPrice, discountPercent: 0, ownerDecision: "YES",
    ownerNotes: "", status: "Confirmed", assignedArtist: booking.assignedArtist,
    lastContactedAt: "", tentativeCalendarEventId: "", confirmedCalendarEventId: "",
    bookingId: booking.bookingId, paymentStatus: booking.paymentStatus, quoteUrl: "",
    quoteGeneratedAt: "", quoteVoidedAt: "", quoteAdjustments: "", orderItems: booking.orderItems,
    quoteNumber: "", quoteViewedAt: "", quoteAcceptedAt: "",
  };
}

export async function updatePaymentStatus(
  email: string,
  tokens: Credentials,
  leadId: string,
  paymentStatus: "Advance Paid" | "Paid in Full",
) {
  const workspace = await getRequiredWorkspace(email);
  const lead = await findLeadById(workspace, tokens, leadId);
  if (!lead) {
    throw new Error("Lead not found");
  }

  const nextLead: LeadRecord = {
    ...lead.record,
    paymentStatus,
    status: paymentStatus === "Paid in Full" ? "Payment Received" : lead.record.status,
    lastContactedAt: new Date().toISOString(),
  };

  await updateLeadRow(workspace, tokens, lead.rowNumber, nextLead);
  await updateBookingPaymentStatus(workspace, tokens, lead.record.bookingId, paymentStatus);
  return { lead: nextLead };
}

// ---- Partial payment ledger ----
// Indian clients commonly pay in 2-3 instalments (advance, mid, balance). The
// ledger records each payment with amount/method/date so the artist always
// knows exactly how much has landed, and the status is derived from the math
// instead of being a binary toggle.

export type PaymentEntry = {
  amount: number;
  method: string;
  note: string;
  at: string;
  // "refund" entries subtract from the running total (cancelled weddings are
  // a fact of life); everything else counts as money received.
  kind?: "payment" | "refund";
};

// Tolerant parser: bad/empty JSON yields an empty ledger rather than throwing.
export function parsePaymentsLog(raw: string | undefined | null): PaymentEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        const e = (entry ?? {}) as Partial<PaymentEntry>;
        return {
          amount: Number(e.amount) || 0,
          method: String(e.method ?? "").slice(0, 30),
          note: String(e.note ?? "").slice(0, 120),
          at: String(e.at ?? ""),
          kind: e.kind === "refund" ? ("refund" as const) : ("payment" as const),
        };
      })
      .filter((entry) => entry.amount > 0);
  } catch {
    return [];
  }
}

export function paymentsTotal(log: PaymentEntry[]): number {
  return log.reduce((sum, entry) => sum + (entry.kind === "refund" ? -entry.amount : entry.amount), 0);
}

// Payment status derived from how much has actually been received.
export function derivePaymentStatus(
  finalPrice: number,
  advanceAmount: number,
  paidTotal: number,
): "Advance Due" | "Advance Paid" | "Paid in Full" {
  if (paidTotal <= 0) return "Advance Due";
  if (finalPrice > 0 && paidTotal >= finalPrice) return "Paid in Full";
  if (advanceAmount > 0 && paidTotal >= advanceAmount) return "Advance Paid";
  return "Advance Due";
}

// Records a payment against a booking, recomputes the derived status and the
// true balance still owed, and keeps the linked lead's pipeline state in sync.
export async function recordBookingPayment(
  email: string,
  tokens: Credentials,
  bookingId: string,
  input: { amount: number; method?: string; note?: string; type?: "payment" | "refund" },
) {
  let derived: "Advance Due" | "Advance Paid" | "Paid in Full" = "Advance Due";
  const booking = await updateBookingRecord(email, tokens, bookingId, (current) => {
    const log = parsePaymentsLog(current.paymentsLog);
    log.push({
      amount: Math.round(input.amount),
      method: String(input.method ?? "UPI").slice(0, 30),
      note: String(input.note ?? "").slice(0, 120),
      at: new Date().toISOString(),
      kind: input.type === "refund" ? "refund" : "payment",
    });
    const paidTotal = paymentsTotal(log);
    derived = derivePaymentStatus(current.finalPrice, current.advanceAmount, paidTotal);
    return {
      ...current,
      paymentsLog: JSON.stringify(log),
      paymentStatus: derived,
      balanceDue: Math.max(0, current.finalPrice - paidTotal),
    };
  });

  if (booking.leadId) {
    await updateLeadRecord(email, tokens, booking.leadId, (lead) => ({
      ...lead,
      paymentStatus: derived,
      status: derived === "Paid in Full" ? "Payment Received" : lead.status,
      lastContactedAt: new Date().toISOString(),
    })).catch(() => undefined);
  }

  return booking;
}

// ---- Client import ----
// Brings her existing client list in (from a notebook, Excel, or another app)
// as completed past clients: they appear in the Clients directory and power
// repeat-client insights, without cluttering the active pipeline. One bulk
// sheet append for the whole batch — no per-row AI or pricing.
export type ImportClientRow = {
  clientName: string;
  clientWhatsApp: string;
  eventType?: string;
  eventDate?: string;
  locationText?: string;
  clientTags?: string;
};

export async function importClients(
  email: string,
  tokens: Credentials,
  rows: ImportClientRow[],
): Promise<{ imported: number; skipped: number }> {
  const workspace = await getRequiredWorkspace(email);
  const existing = await listLeadRows(workspace, tokens);
  const knownPhones = new Set(
    existing.map((l) => l.clientWhatsApp.replace(/\D/g, "")).filter((p) => p.length >= 8),
  );

  const now = new Date().toISOString();
  const records: LeadRecord[] = [];
  let skipped = 0;
  for (const row of rows) {
    const phone = String(row.clientWhatsApp || "").replace(/\D/g, "");
    const name = String(row.clientName || "").trim().slice(0, 120);
    if (!name || phone.length < 8 || knownPhones.has(phone)) {
      skipped += 1;
      continue;
    }
    knownPhones.add(phone);
    records.push({
      leadId: buildId("L"),
      createdAt: now,
      source: "Import",
      clientName: name,
      clientWhatsApp: row.clientWhatsApp.trim().slice(0, 25),
      clientInstagram: "",
      eventType: String(row.eventType || "Other").trim().slice(0, 40) || "Other",
      eventDate: /^\d{4}-\d{2}-\d{2}$/.test(String(row.eventDate || "")) ? String(row.eventDate) : "",
      eventTime: "",
      locationText: String(row.locationText || "").trim().slice(0, 200),
      distanceKm: 0,
      travelTimeMin: 0,
      outstationFlag: "No",
      profileTier: "Mid",
      followers: 0,
      clientTags: String(row.clientTags || "").trim().slice(0, 200),
      aiInsight: "",
      suggestedReply: "",
      demandCount: 0,
      scarcityTag: "",
      holdExpiresAt: "",
      initialAiPrice: 0,
      finalApprovedPrice: 0,
      discountPercent: 0,
      ownerDecision: "",
      ownerNotes: "Imported past client",
      status: "Completed",
      assignedArtist: "",
      lastContactedAt: "",
      tentativeCalendarEventId: "",
      confirmedCalendarEventId: "",
      bookingId: "",
      paymentStatus: "Not Started",
      quoteUrl: "",
      quoteGeneratedAt: "",
      quoteVoidedAt: "",
      quoteAdjustments: "",
      orderItems: "",
      quoteNumber: "",
      quoteViewedAt: "",
      quoteAcceptedAt: "",
    });
  }

  if (records.length) {
    const { sheets } = createGoogleClients(tokens);
    await sheets.spreadsheets.values.append({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.leads}!A:${toColumn(leadHeaders.length)}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: records.map((record) => leadToRow(record).map(String)) },
    });
    invalidateLeadSheet(workspace.spreadsheetId);
  }

  return { imported: records.length, skipped };
}

export async function countActiveLeadsForDate(
  email: string,
  tokens: Credentials,
  eventDate: string,
) {
  const workspace = await getRequiredWorkspace(email);
  return getDemandCountForDate(workspace, tokens, eventDate);
}

export async function getDashboardData(email: string, tokens: Credentials): Promise<DashboardData> {
  const workspace = await getRequiredWorkspace(email);
  const leads = await listLeadRows(workspace, tokens);
  const bookings = await listBookingRows(workspace, tokens);

  return {
    leads: leads.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    bookings: bookings.sort((a, b) => b.bookedAt.localeCompare(a.bookedAt)),
  };
}

export async function findLatestLeadByActor(
  email: string,
  tokens: Credentials,
  input: { channel: "Instagram" | "WhatsApp"; actorId: string },
) {
  const workspace = await getRequiredWorkspace(email);
  const rows = await readLeadSheetRows(workspace, tokens);
  const matches = rows
    .map((row, index) => ({ rowNumber: index + 2, record: rowToLead(row) }))
    .filter(({ record }) => {
      if (["Lost", "Completed"].includes(record.status)) return false;
      return input.channel === "Instagram"
        ? record.clientInstagram === input.actorId
        : record.clientWhatsApp === input.actorId;
    })
    .sort((a, b) =>
      (b.record.lastContactedAt || b.record.createdAt).localeCompare(
        a.record.lastContactedAt || a.record.createdAt,
      ),
    );

  return matches[0] ?? null;
}

export async function updateLeadRecord(
  email: string,
  tokens: Credentials,
  leadId: string,
  updater: (lead: LeadRecord) => LeadRecord,
) {
  const workspace = await getRequiredWorkspace(email);
  // Serialize the read-modify-write so two concurrent updates (e.g. a webhook
  // racing a manual edit) can't both read the same row and clobber each other.
  // The fresh read inside the lock guarantees we modify the latest version.
  return withSerializedLock(lockKeyFromString(`lead:${leadId}`), async () => {
    const lead = await findLeadById(workspace, tokens, leadId, { fresh: true });
    if (!lead) {
      throw new Error("Lead not found");
    }

    const updated = updater(lead.record);
    await updateLeadRow(workspace, tokens, lead.rowNumber, updated);
    return updated;
  });
}

export async function getLeadRecord(email: string, tokens: Credentials, leadId: string) {
  const workspace = await getRequiredWorkspace(email);
  const lead = await findLeadById(workspace, tokens, leadId);
  return lead?.record ?? null;
}

export async function getBookingRecord(email: string, tokens: Credentials, bookingId: string) {
  const workspace = await getRequiredWorkspace(email);
  const booking = await findBookingById(workspace, tokens, bookingId);
  return booking?.record ?? null;
}

export async function listActiveBookings(email: string, tokens: Credentials): Promise<BookingRecord[]> {
  const workspace = await getRequiredWorkspace(email);
  const bookings = await listBookingRows(workspace, tokens);
  return bookings.filter((b) => !["Completed", "Cancelled"].includes(b.status));
}

export async function markBookingReminderSent(
  email: string,
  tokens: Credentials,
  bookingId: string,
  dayLabel: string,
) {
  return updateBookingRecord(email, tokens, bookingId, (booking) => {
    const existing = booking.remindersSent ? booking.remindersSent.split(",").map((s) => s.trim()) : [];
    if (!existing.includes(dayLabel)) {
      existing.push(dayLabel);
    }
    return { ...booking, remindersSent: existing.join(",") };
  });
}

// Append (or update) a row in the Reviews sheet so both manual and automated
// review requests show up in the owner's Reviews tab. Deduplicated by leadId.
export async function recordReviewRequest(
  email: string,
  tokens: Credentials,
  input: { leadId: string; clientName: string; eventDate: string; type: "request" | "reminder" },
) {
  const workspace = await getRequiredWorkspace(email);
  const { sheets } = createGoogleClients(tokens);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: workspace.spreadsheetId,
    range: `${sheetNames.reviews}!A2:I`,
  });
  const rows = response.data.values ?? [];
  const existingIndex = rows.findIndex((row) => row[1] === input.leadId);
  const now = new Date().toISOString();

  if (existingIndex >= 0) {
    const row = [...rows[existingIndex]];
    row[4] = input.type === "request" ? now : row[4] || "";
    row[5] = input.type === "reminder" ? now : row[5] || "";
    row[8] = row[8] || "Sent from BusyDays";
    await sheets.spreadsheets.values.update({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.reviews}!A${existingIndex + 2}:I${existingIndex + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[...row]] },
    });
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: workspace.spreadsheetId,
    range: `${sheetNames.reviews}!A:I`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        `REV_${nanoid(10)}`,
        input.leadId,
        input.clientName,
        input.eventDate,
        input.type === "request" ? now : "",
        input.type === "reminder" ? now : "",
        "No",
        "No",
        "Sent from BusyDays",
      ]],
    },
  });
}

export async function updateBookingRecord(
  email: string,
  tokens: Credentials,
  bookingId: string,
  updater: (booking: BookingRecord) => BookingRecord,
) {
  const workspace = await getRequiredWorkspace(email);
  // Same serialization as updateLeadRecord: payments-log appends from the
  // Razorpay webhook and a manual "record payment" tap must not interleave.
  return withSerializedLock(lockKeyFromString(`booking:${bookingId}`), async () => {
    const booking = await findBookingById(workspace, tokens, bookingId, { fresh: true });
    if (!booking) {
      throw new Error("Booking not found");
    }

    const updated = updater(booking.record);
    await updateBookingRow(workspace, tokens, booking.rowNumber, updated);
    return updated;
  });
}

async function getRequiredWorkspace(email: string) {
  const workspace = await getWorkspaceByEmail(email);
  if (!workspace) {
    throw new Error("Workspace not found");
  }
  return workspace;
}

async function getDemandCountForDate(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  eventDate: string,
) {
  const leads = await listLeadRows(workspace, tokens);
  return leads.filter(
    (lead) =>
      lead.eventDate === eventDate &&
      !["Lost", "Completed"].includes(lead.status),
  ).length;
}

function calculatePricing(
  workspace: WorkspaceRecord,
  input: CreateLeadInput,
  demandCount: number,
  travel: Awaited<ReturnType<typeof resolveTravelIntelligence>>,
): PricingResult {
  const basePriceMap: Record<string, number> = {
    Bridal: workspace.config.basePriceBridal,
    Engagement: workspace.config.basePriceEngagement,
    Reception: workspace.config.basePriceReception,
    Party: workspace.config.basePriceParty,
    Shoot: workspace.config.basePriceShoot,
    Other: workspace.config.basePriceOther,
  };

  const eventMonth = new Date(input.eventDate).getMonth();
  const seasonKeys = [
    workspace.config.multiplierJan,
    workspace.config.multiplierFeb,
    workspace.config.multiplierMar,
    workspace.config.multiplierApr,
    workspace.config.multiplierMay,
    workspace.config.multiplierJun,
    workspace.config.multiplierJul,
    workspace.config.multiplierAug,
    workspace.config.multiplierSep,
    workspace.config.multiplierOct,
    workspace.config.multiplierNov,
    workspace.config.multiplierDec,
  ];

  const basePrice = basePriceMap[input.eventType] ?? workspace.config.basePriceOther;
  const seasonMultiplier = seasonKeys[eventMonth] ?? 1;
  const demandMultiplier = demandCount >= workspace.config.scarcityThresholdHard
    ? 1.2
    : demandCount >= workspace.config.scarcityThresholdSoft
      ? 1.1
      : demandCount >= 1
        ? 1.05
        : 1;
  const profileMultiplier =
    input.profileTier === "High"
      ? workspace.config.profileHighMultiplier
      : input.profileTier === "Low"
        ? workspace.config.profileLowMultiplier
        : workspace.config.profileMidMultiplier;

  const travelCost =
    travel.distanceKm >= workspace.config.travelOutstationThresholdKm
      ? workspace.config.travelOutstation
      : travel.distanceKm > 25
        ? workspace.config.travelNearbyCity
        : workspace.config.travelWithinCity;

  const rawPrice = basePrice * seasonMultiplier * demandMultiplier * profileMultiplier + travelCost;
  const finalPrice = roundToPremiumNumber(rawPrice);
  const scarcityTag =
    demandCount >= workspace.config.scarcityThresholdHard
      ? "High"
      : demandCount >= workspace.config.scarcityThresholdSoft
        ? "Warm"
        : "Open";

  return {
    basePrice,
    seasonMultiplier,
    demandMultiplier,
    profileMultiplier,
    travelCost,
    finalPrice,
    scarcityTag,
    travelSource: travel.source,
  };
}

export function roundToPremiumNumber(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const rounded = Math.round(value / 500) * 500;
  const premium = rounded - 200;
  return premium > 0 ? premium : rounded;
}

export type MonthlyRecap = {
  month: string;
  year: number;
  monthNum: number;
  newLeads: number;
  confirmedBookings: number;
  completedBookings: number;
  totalRevenue: number;
  collected: number;
  avgBookingValue: number;
  topEventType: string;
  newClients: number;
};

export async function getMonthlyRecap(
  email: string,
  tokens: Credentials,
  year?: number,
  monthNum?: number,
): Promise<MonthlyRecap> {
  const workspace = await getRequiredWorkspace(email);
  const now = new Date();
  const targetYear = year ?? now.getFullYear();
  const targetMonth = monthNum ?? now.getMonth(); // 0-based; default to previous month
  const prefix = `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}`;

  const leads = await listLeadRows(workspace, tokens);
  const bookings = await listBookingRows(workspace, tokens);

  const monthLeads = leads.filter((l) => l.createdAt.startsWith(prefix));
  const monthBookings = bookings.filter((b) => b.bookedAt.startsWith(prefix));

  const confirmed = monthBookings.filter((b) => !["Cancelled"].includes(b.status));
  const completed = monthBookings.filter((b) => b.status === "Completed");

  const totalRevenue = confirmed.reduce((s, b) => s + (b.finalPrice || 0), 0);
  const collected = confirmed.reduce((s, b) => s + paymentsTotal(parsePaymentsLog(b.paymentsLog)), 0);

  const eventCounts: Record<string, number> = {};
  for (const b of confirmed) {
    const t = b.eventType || "Other";
    eventCounts[t] = (eventCounts[t] ?? 0) + 1;
  }
  const topEventType = Object.entries(eventCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";

  const existingPhones = new Set(
    bookings
      .filter((b) => b.bookedAt < prefix)
      .map((b) => String(b.clientWhatsApp || "").replace(/\D/g, ""))
      .filter(Boolean),
  );
  const newClients = monthBookings.filter((b) => {
    const p = String(b.clientWhatsApp || "").replace(/\D/g, "");
    return p && !existingPhones.has(p);
  }).length;

  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  return {
    month: `${MONTH_NAMES[targetMonth]} ${targetYear}`,
    year: targetYear,
    monthNum: targetMonth,
    newLeads: monthLeads.length,
    confirmedBookings: confirmed.length,
    completedBookings: completed.length,
    totalRevenue,
    collected,
    avgBookingValue: confirmed.length ? Math.round(totalRevenue / confirmed.length) : 0,
    topEventType,
    newClients,
  };
}

async function listLeadRows(workspace: WorkspaceRecord, tokens: Credentials) {
  const rows = await readLeadSheetRows(workspace, tokens);
  return rows
    .filter((row) => row[0])
    .map((row) => rowToLead(row));
}

async function findLeadById(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  leadId: string,
  opts?: { fresh?: boolean },
) {
  const rows = await readLeadSheetRows(workspace, tokens, opts);
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index][0] === leadId) {
      return {
        rowNumber: index + 2,
        record: rowToLead(rows[index]),
      };
    }
  }

  return null;
}

async function listBookingRows(workspace: WorkspaceRecord, tokens: Credentials) {
  const rows = await readBookingSheetRows(workspace, tokens);
  return rows
    .filter((row) => row[0])
    .map((row) => rowToBooking(row));
}

async function findBookingById(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  bookingId: string,
  opts?: { fresh?: boolean },
) {
  const rows = await readBookingSheetRows(workspace, tokens, opts);
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index][0] === bookingId) {
      return {
        rowNumber: index + 2,
        record: rowToBooking(rows[index]),
      };
    }
  }

  return null;
}

async function updateLeadRow(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  rowNumber: number,
  lead: LeadRecord,
) {
  const { sheets } = createGoogleClients(tokens);
  await sheets.spreadsheets.values.update({
    spreadsheetId: workspace.spreadsheetId,
    range: `${sheetNames.leads}!A${rowNumber}:${toColumn(leadHeaders.length)}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [leadToRow(lead)],
    },
  });
  invalidateLeadSheet(workspace.spreadsheetId);
}

async function updateBookingRow(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  rowNumber: number,
  booking: BookingRecord,
) {
  const { sheets } = createGoogleClients(tokens);
  await sheets.spreadsheets.values.update({
    spreadsheetId: workspace.spreadsheetId,
    range: `${sheetNames.bookings}!A${rowNumber}:${toColumn(bookingHeaders.length)}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [bookingToRow(booking)],
    },
  });
  invalidateBookingSheet(workspace.spreadsheetId);
}

async function updateBookingPaymentStatus(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  bookingId: string,
  paymentStatus: string,
) {
  if (!bookingId) return;

  await withSerializedLock(lockKeyFromString(`booking:${bookingId}`), async () => {
    const found = await findBookingById(workspace, tokens, bookingId, { fresh: true });
    if (!found) return;
    const booking = found.record;
    booking.paymentStatus = paymentStatus;
    booking.status = paymentStatus === "Paid in Full" ? "Paid" : booking.status;
    await updateBookingRow(workspace, tokens, found.rowNumber, booking);
  });
}

async function upsertTentativeCalendarEvent(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  lead: LeadRecord,
) {
  const { calendar } = createGoogleClients(tokens);
  const requestBody = buildCalendarEventBody({
    title: `Tentative: ${lead.eventType} - ${lead.clientName}`,
    description: [
      `Lead ID: ${lead.leadId}`,
      `Client: ${lead.clientName}`,
      `WhatsApp: ${lead.clientWhatsApp}`,
      `Approved Price: INR ${lead.finalApprovedPrice}`,
      `Venue: ${lead.locationText}`,
      `Event Time: ${lead.eventTime || "To be confirmed"}`,
      `Hold Expires: ${lead.holdExpiresAt}`,
      `Status: Awaiting Client`,
    ].join("\n"),
    location: lead.locationText,
    eventDate: lead.eventDate,
    eventTime: lead.eventTime,
    durationHours: durationHoursForEvent(workspace.config.serviceDurations, lead.eventType),
  });

  if (lead.tentativeCalendarEventId) {
    const response = await calendar.events.update({
      calendarId: workspace.tentativeCalendarId,
      eventId: lead.tentativeCalendarEventId,
      requestBody,
    });
    return response.data.id ?? lead.tentativeCalendarEventId;
  }

  const response = await calendar.events.insert({
    calendarId: workspace.tentativeCalendarId,
    requestBody,
  });

  if (!response.data.id) {
    throw new Error("Calendar did not return an event id while creating the tentative hold.");
  }
  return response.data.id;
}

async function createConfirmedCalendarEvent(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  lead: LeadRecord & { bookingId: string },
) {
  const { calendar } = createGoogleClients(tokens);
  const response = await calendar.events.insert({
    calendarId: workspace.confirmedCalendarId,
    requestBody: buildCalendarEventBody({
      title: `Confirmed: ${lead.eventType} - ${lead.clientName}`,
      description: [
        `Booking ID: ${lead.bookingId}`,
        `Lead ID: ${lead.leadId}`,
        `Client: ${lead.clientName}`,
        `Artist: ${lead.assignedArtist}`,
        `Final Price: INR ${lead.finalApprovedPrice}`,
        `Venue: ${lead.locationText}`,
        `Event Time: ${lead.eventTime || "To be confirmed"}`,
        `Status: Confirmed`,
      ].join("\n"),
      location: lead.locationText,
      eventDate: lead.eventDate,
      eventTime: lead.eventTime,
      durationHours: durationHoursForEvent(workspace.config.serviceDurations, lead.eventType),
    }),
  });

  if (!response.data.id) {
    throw new Error("Calendar did not return an event id while creating the confirmed booking.");
  }
  return response.data.id;
}

async function deleteCalendarEvent(tokens: Credentials, calendarId: string, eventId: string) {
  const { calendar } = createGoogleClients(tokens);
  try {
    await calendar.events.delete({
      calendarId,
      eventId,
    });
  } catch {
    // Calendar event may already be removed. Keep the workflow idempotent.
  }
}

function buildCalendarEventBody(input: {
  title: string;
  description: string;
  location: string;
  eventDate: string;
  eventTime?: string;
  durationHours?: number;
}): calendar_v3.Schema$Event {
  const { start, end } = buildEventWindow(input.eventDate, input.eventTime, input.durationHours ?? 4);
  return {
    summary: input.title,
    description: input.description,
    location: input.location,
    start: {
      dateTime: start.toISOString(),
      timeZone: "Asia/Kolkata",
    },
    end: {
      dateTime: end.toISOString(),
      timeZone: "Asia/Kolkata",
    },
  };
}

// Fallback durations when the artist hasn't configured her own — a bridal
// look genuinely takes ~4 hours; a party look doesn't.
const DEFAULT_DURATIONS: Record<string, number> = {
  Bridal: 4, Engagement: 3, Reception: 3, Party: 2, Shoot: 3, Other: 2,
};

// Parses "Bridal=4, Party=2.5" (the service_durations config) and returns the
// hours this occasion blocks on the calendar.
export function durationHoursForEvent(raw: string | undefined, eventType: string): number {
  const fallback = DEFAULT_DURATIONS[eventType] ?? 3;
  for (const pair of String(raw || "").split(",")) {
    const [key, value] = pair.split("=").map((s) => s.trim());
    if (key && key.toLowerCase() === String(eventType).toLowerCase()) {
      const hours = Number(value);
      if (Number.isFinite(hours) && hours > 0 && hours <= 24) return hours;
    }
  }
  return fallback;
}

function buildEventWindow(eventDate: string, eventTime: string | undefined, durationHours: number) {
  const time = normalizeEventTime(eventTime);
  const ms = durationHours * 60 * 60 * 1000;
  if (!time) {
    const start = new Date(`${eventDate}T06:00:00+05:30`);
    return { start, end: new Date(start.getTime() + ms) };
  }

  const start = new Date(`${eventDate}T${time}:00+05:30`);
  const end = new Date(start.getTime() + ms);
  return { start, end };
}

function normalizeEventTime(eventTime?: string) {
  if (!eventTime) return "";
  const trimmed = eventTime.trim();
  if (/^\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{1}:\d{2}$/.test(trimmed)) return `0${trimmed}`;
  return "";
}

function leadToRow(lead: LeadRecord) {
  return [
    lead.leadId,
    lead.createdAt,
    lead.source,
    lead.clientName,
    lead.clientWhatsApp,
    lead.clientInstagram,
    lead.eventType,
    lead.eventDate,
    lead.eventTime,
    lead.locationText,
    lead.distanceKm,
    lead.travelTimeMin,
    lead.outstationFlag,
    lead.profileTier,
    lead.followers,
    lead.clientTags,
    lead.aiInsight,
    lead.suggestedReply,
    lead.demandCount,
    lead.scarcityTag,
    lead.holdExpiresAt,
    lead.initialAiPrice,
    lead.finalApprovedPrice,
    lead.discountPercent,
    lead.ownerDecision,
    lead.ownerNotes,
    lead.status,
    lead.assignedArtist,
    lead.lastContactedAt,
    lead.tentativeCalendarEventId,
    lead.confirmedCalendarEventId,
    lead.bookingId,
    lead.paymentStatus,
    lead.quoteUrl,
    lead.quoteGeneratedAt,
    lead.quoteVoidedAt,
    lead.quoteAdjustments,
    lead.orderItems,
    lead.quoteNumber,
    lead.quoteViewedAt,
    lead.quoteAcceptedAt,
  ];
}

function rowToLead(row: string[]): LeadRecord {
  return {
    leadId: row[0] ?? "",
    createdAt: row[1] ?? "",
    source: row[2] ?? "",
    clientName: row[3] ?? "",
    clientWhatsApp: row[4] ?? "",
    clientInstagram: row[5] ?? "",
    eventType: row[6] ?? "",
    eventDate: row[7] ?? "",
    eventTime: row[8] ?? "",
    locationText: row[9] ?? "",
    distanceKm: Number(row[10] ?? 0),
    travelTimeMin: Number(row[11] ?? 0),
    outstationFlag: row[12] ?? "No",
    profileTier: row[13] ?? "Mid",
    followers: Number(row[14] ?? 0),
    clientTags: row[15] ?? "",
    aiInsight: row[16] ?? "",
    suggestedReply: row[17] ?? "",
    demandCount: Number(row[18] ?? 0),
    scarcityTag: row[19] ?? "",
    holdExpiresAt: row[20] ?? "",
    initialAiPrice: Number(row[21] ?? 0),
    finalApprovedPrice: Number(row[22] ?? 0),
    discountPercent: Number(row[23] ?? 0),
    ownerDecision: row[24] ?? "",
    ownerNotes: row[25] ?? "",
    status: (row[26] ?? "New") as LeadStatus,
    assignedArtist: row[27] ?? "",
    lastContactedAt: row[28] ?? "",
    tentativeCalendarEventId: row[29] ?? "",
    confirmedCalendarEventId: row[30] ?? "",
    bookingId: row[31] ?? "",
    paymentStatus: row[32] ?? "Not Started",
    quoteUrl: row[33] ?? "",
    quoteGeneratedAt: row[34] ?? "",
    quoteVoidedAt: row[35] ?? "",
    quoteAdjustments: row[36] ?? "",
    orderItems: row[37] ?? "",
    quoteNumber: row[38] ?? "",
    quoteViewedAt: row[39] ?? "",
    quoteAcceptedAt: row[40] ?? "",
  };
}

function bookingToRow(booking: BookingRecord) {
  return [
    booking.bookingId,
    booking.leadId,
    booking.bookedAt,
    booking.clientName,
    booking.clientWhatsApp,
    booking.eventType,
    booking.eventDate,
    booking.eventTime,
    booking.venue,
    booking.assignedArtist,
    booking.finalPrice,
    booking.advanceAmount,
    booking.balanceDue,
    booking.tentativeCalendarEventId,
    booking.confirmedCalendarEventId,
    booking.contractUrl,
    booking.invoiceUrl,
    booking.paymentStatus,
    booking.status,
    booking.contractStatus,
    booking.contractSentAt,
    booking.invoiceGeneratedAt,
    booking.remindersSent,
    booking.invoiceVoidedAt,
    booking.contractVoidedAt,
    booking.invoiceAdjustments,
    booking.contractAdjustments,
    booking.orderItems,
    booking.contractSignedAt,
    booking.contractSignerName,
    booking.expenses,
    booking.invoiceNumber,
    booking.paymentsLog,
    booking.invoiceViewedAt,
    booking.contractViewedAt,
  ];
}

function rowToBooking(row: string[]): BookingRecord {
  return {
    bookingId: row[0] ?? "",
    leadId: row[1] ?? "",
    bookedAt: row[2] ?? "",
    clientName: row[3] ?? "",
    clientWhatsApp: row[4] ?? "",
    eventType: row[5] ?? "",
    eventDate: row[6] ?? "",
    eventTime: row[7] ?? "",
    venue: row[8] ?? "",
    assignedArtist: row[9] ?? "",
    finalPrice: Number(row[10] ?? 0),
    advanceAmount: Number(row[11] ?? 0),
    balanceDue: Number(row[12] ?? 0),
    tentativeCalendarEventId: row[13] ?? "",
    confirmedCalendarEventId: row[14] ?? "",
    contractUrl: row[15] ?? "",
    invoiceUrl: row[16] ?? "",
    paymentStatus: row[17] ?? "",
    status: row[18] ?? "",
    contractStatus: row[19] ?? "Draft",
    contractSentAt: row[20] ?? "",
    invoiceGeneratedAt: row[21] ?? "",
    remindersSent: row[22] ?? "",
    invoiceVoidedAt: row[23] ?? "",
    contractVoidedAt: row[24] ?? "",
    invoiceAdjustments: row[25] ?? "",
    contractAdjustments: row[26] ?? "",
    orderItems: row[27] ?? "",
    contractSignedAt: row[28] ?? "",
    contractSignerName: row[29] ?? "",
    expenses: row[30] ?? "",
    invoiceNumber: row[31] ?? "",
    paymentsLog: row[32] ?? "",
    invoiceViewedAt: row[33] ?? "",
    contractViewedAt: row[34] ?? "",
  };
}

function buildId(prefix: "L" | "B") {
  return `${prefix}${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}${nanoid(4)}`;
}

function toColumn(columnNumber: number) {
  let dividend = columnNumber;
  let columnName = "";
  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    columnName = String.fromCharCode(65 + modulo) + columnName;
    dividend = Math.floor((dividend - modulo) / 26);
  }
  return columnName;
}
