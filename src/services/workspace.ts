import { nanoid } from "nanoid";
import type { Credentials } from "google-auth-library";
import { buildDefaultConfig } from "../defaults.js";
import { workspaceConfigSchema } from "../schema.js";
import { findWorkspaceByEmail, saveWorkspace, updateWorkspaceByEmail } from "./database.js";
import { createGoogleClients } from "./google.js";
import {
  artistHeaders,
  bookingHeaders,
  followUpHeaders,
  interactionHeaders,
  leadHeaders,
  reviewHeaders,
  sheetNames,
} from "./sheet-definitions.js";
import type { MetaChannel, MetaChannelConnection, WorkspaceConfig, WorkspaceRecord } from "../types.js";

export async function getWorkspaceByEmail(email: string) {
  return findWorkspaceByEmail(email);
}

export async function provisionWorkspace(profile: { email: string; name: string }, tokens: Credentials) {
  const existing = await findWorkspaceByEmail(profile.email);
  if (existing) {
    const recovered = await recoverBestWorkspaceForProfile(profile, tokens, existing);
    const baseWorkspace = recovered ?? existing;
    const merged = {
      ...baseWorkspace,
      googleTokens: {
        ...baseWorkspace.googleTokens,
        access_token: tokens.access_token ?? baseWorkspace.googleTokens?.access_token,
        refresh_token: tokens.refresh_token ?? baseWorkspace.googleTokens?.refresh_token,
        scope: tokens.scope ?? baseWorkspace.googleTokens?.scope,
        token_type: tokens.token_type ?? baseWorkspace.googleTokens?.token_type,
        expiry_date: tokens.expiry_date ?? baseWorkspace.googleTokens?.expiry_date ?? null,
      },
      updatedAt: new Date().toISOString(),
    };
    await saveWorkspace(merged);
    return merged;
  }

  const recovered = await recoverBestWorkspaceForProfile(profile, tokens);
  if (recovered) {
    const merged = {
      ...recovered,
      googleTokens: {
        ...recovered.googleTokens,
        access_token: tokens.access_token ?? recovered.googleTokens?.access_token,
        refresh_token: tokens.refresh_token ?? recovered.googleTokens?.refresh_token,
        scope: tokens.scope ?? recovered.googleTokens?.scope,
        token_type: tokens.token_type ?? recovered.googleTokens?.token_type,
        expiry_date: tokens.expiry_date ?? recovered.googleTokens?.expiry_date ?? null,
      },
      updatedAt: new Date().toISOString(),
    };
    await saveWorkspace(merged);
    return merged;
  }

  const config = buildDefaultConfig(profile);
  const { sheets, calendar } = createGoogleClients(tokens);

  const spreadsheetTitle = `1Glam Booking OS - ${profile.name}`;
  const spreadsheet = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: spreadsheetTitle, locale: "en_US", timeZone: "Asia/Kolkata" },
      sheets: [
        { properties: { title: sheetNames.config } },
        { properties: { title: sheetNames.leads } },
        { properties: { title: sheetNames.bookings } },
        { properties: { title: sheetNames.artists } },
        { properties: { title: sheetNames.followUps } },
        { properties: { title: sheetNames.interactionLog } },
        { properties: { title: sheetNames.reviews } },
      ],
    },
  });

  const spreadsheetId = spreadsheet.data.spreadsheetId;
  const spreadsheetUrl = spreadsheet.data.spreadsheetUrl;

  if (!spreadsheetId || !spreadsheetUrl) {
    throw new Error("Google Sheets provisioning failed");
  }

  const tentativeCalendar = await calendar.calendars.insert({
    requestBody: {
      summary: "1Glam Tentative Bookings",
      timeZone: "Asia/Kolkata",
    },
  });

  const tentativeCalendarId = tentativeCalendar.data.id;
  if (!tentativeCalendarId) {
    throw new Error("Tentative calendar provisioning failed");
  }

  config.tentativeCalendarId = tentativeCalendarId;
  config.confirmedCalendarId = "primary";

  await seedSpreadsheet(spreadsheetId, config, tokens);

  const now = new Date().toISOString();
  const workspace: WorkspaceRecord = {
    workspaceId: nanoid(12),
    email: profile.email,
    name: profile.name,
    spreadsheetId,
    spreadsheetUrl,
    spreadsheetName: spreadsheetTitle,
    confirmedCalendarId: "primary",
    tentativeCalendarId,
    tentativeCalendarName: "1Glam Tentative Bookings",
    createdAt: now,
    updatedAt: now,
    googleTokens: {
      access_token: tokens.access_token ?? undefined,
      refresh_token: tokens.refresh_token ?? undefined,
      scope: tokens.scope ?? undefined,
      token_type: tokens.token_type ?? undefined,
      expiry_date: tokens.expiry_date ?? null,
    },
    metaConnections: {},
    config,
  };

  await saveWorkspace(workspace);
  return workspace;
}

export async function updateWorkspaceConfig(
  email: string,
  nextConfig: WorkspaceConfig,
  tokens: Credentials,
) {
  const workspace = await findWorkspaceByEmail(email);
  if (!workspace) throw new Error("Workspace not found");

  workspace.config = nextConfig;
  workspace.confirmedCalendarId = nextConfig.confirmedCalendarId;
  workspace.tentativeCalendarId = nextConfig.tentativeCalendarId;
  workspace.updatedAt = new Date().toISOString();

  await seedSpreadsheet(workspace.spreadsheetId, nextConfig, tokens, { includeSampleArtist: false });
  await saveWorkspace(workspace);
  return workspace;
}

export async function persistWorkspaceTokens(email: string, tokens: Credentials) {
  return updateWorkspaceByEmail(email, (workspace) => ({
    ...workspace,
    googleTokens: {
      access_token: tokens.access_token ?? workspace.googleTokens?.access_token,
      refresh_token: tokens.refresh_token ?? workspace.googleTokens?.refresh_token,
      scope: tokens.scope ?? workspace.googleTokens?.scope,
      token_type: tokens.token_type ?? workspace.googleTokens?.token_type,
      expiry_date: tokens.expiry_date ?? workspace.googleTokens?.expiry_date ?? null,
    },
    updatedAt: new Date().toISOString(),
  }));
}

export async function upsertMetaConnection(
  email: string,
  channel: MetaChannel,
  connection: MetaChannelConnection,
) {
  return updateWorkspaceByEmail(email, (workspace) => ({
    ...workspace,
    metaConnections: {
      ...workspace.metaConnections,
      [channel]: connection,
    },
    updatedAt: new Date().toISOString(),
  }));
}

export async function setSheetProtection(email: string, protect: boolean, tokens: Credentials) {
  const workspace = await findWorkspaceByEmail(email);
  if (!workspace) throw new Error("Workspace not found");

  const { drive } = createGoogleClients(tokens);
  await drive.files.update({
    fileId: workspace.spreadsheetId,
    requestBody: {
      contentRestrictions: protect
        ? [{ readOnly: true, reason: "Protected by 1Glam Booking OS" }]
        : [],
    },
  });

  return updateWorkspaceByEmail(email, (ws) => ({
    ...ws,
    sheetProtected: protect,
    updatedAt: new Date().toISOString(),
  }));
}

export async function recoverSheet(profile: { email: string; name: string }, tokens: Credentials) {
  const existing = await findWorkspaceByEmail(profile.email);
  return provisionWorkspace(profile, tokens);
}

export async function disconnectMetaConnection(email: string, channel: MetaChannel) {
  return updateWorkspaceByEmail(email, (workspace) => ({
    ...workspace,
    metaConnections: {
      ...workspace.metaConnections,
      [channel]: {
        channel,
        status: "disconnected",
        disconnectedAt: new Date().toISOString(),
        dataIsolationKey: workspace.metaConnections?.[channel]?.dataIsolationKey ?? `${workspace.workspaceId}:${channel}`,
      },
    },
    updatedAt: new Date().toISOString(),
  }));
}

async function seedSpreadsheet(
  spreadsheetId: string,
  config: WorkspaceConfig,
  tokens?: Credentials,
  options: { includeSampleArtist?: boolean } = {},
) {
  const { sheets } = createGoogleClients(tokens ?? ({} as Credentials));

  const configRows = [
    ["Key", "Value", "Description"],
    ["business_name", config.businessName, "Your business or brand name"],
    ["owner_name", config.ownerName, "Owner name"],
    ["owner_email", config.ownerEmail, "Google sign-in email"],
    ["owner_whatsapp", config.ownerWhatsApp, "WhatsApp number with country code"],
    ["city", config.city, "Primary operating city"],
    ["instagram_handle", config.instagramHandle, "Instagram handle without @"],
    ["ai_language", config.aiLanguage, "AI response language"],
    ["ai_sign_off", config.aiSignOff, "Message sign-off"],
    ["base_price_bridal", config.basePriceBridal, "Base bridal price"],
    ["base_price_engagement", config.basePriceEngagement, "Base engagement price"],
    ["base_price_reception", config.basePriceReception, "Base reception price"],
    ["base_price_party", config.basePriceParty, "Base party price"],
    ["base_price_shoot", config.basePriceShoot, "Base shoot price"],
    ["base_price_other", config.basePriceOther, "Base other price"],
    ["hold_expiry_hours", config.holdExpiryHours, "Hours to hold date after quote"],
    ["scarcity_threshold_soft", config.scarcityThresholdSoft, "Soft scarcity trigger"],
    ["scarcity_threshold_hard", config.scarcityThresholdHard, "Hard scarcity trigger"],
    ["travel_within_city", config.travelWithinCity, "Travel fee within city"],
    ["travel_nearby_city", config.travelNearbyCity, "Travel fee nearby city"],
    ["travel_outstation", config.travelOutstation, "Travel fee outstation"],
    ["travel_outstation_threshold_km", config.travelOutstationThresholdKm, "Outstation threshold"],
    ["profile_low_multiplier", config.profileLowMultiplier, "Low profile multiplier"],
    ["profile_mid_multiplier", config.profileMidMultiplier, "Mid profile multiplier"],
    ["profile_high_multiplier", config.profileHighMultiplier, "High profile multiplier"],
    ["profile_high_min_followers", config.profileHighMinFollowers, "High profile follower threshold"],
    ["advance_percentage", config.advancePercentage, "Advance percentage"],
    ["upi_id", config.upiId, "UPI ID"],
    ["qr_image_url", config.qrImageUrl, "QR image URL"],
    ["payment_terms", config.paymentTerms, "Payment terms"],
    ["google_review_link", config.googleReviewLink, "Google review link"],
    ["contract_template_url", config.contractTemplateUrl, "Leegality template URL"],
    ["confirmed_calendar_id", config.confirmedCalendarId, "Confirmed calendar ID"],
    ["tentative_calendar_id", config.tentativeCalendarId, "Tentative calendar ID"],
    ["booking_page_enabled", config.bookingPageEnabled, "Accept public bookings (Yes/No)"],
    ["booking_lead_time_days", config.bookingLeadTimeDays, "Minimum days notice for bookings"],
    ["booking_max_advance_days", config.bookingMaxAdvanceDays, "How far ahead clients can book"],
    ["booking_weekly_off_days", config.bookingWeeklyOffDays, "Days off, e.g. Sun, Mon"],
    ["booking_blocked_dates", config.bookingBlockedDates, "Blocked dates, comma separated YYYY-MM-DD"],
    ["booking_max_per_day", config.bookingMaxPerDay, "Max bookings per day (0 = unlimited)"],
    ["booking_confirm_template", config.bookingConfirmTemplate, "Approved WhatsApp template name for booking confirmation"],
    ["booking_confirm_template_lang", config.bookingConfirmTemplateLang, "WhatsApp template language code (e.g. en)"],
    ["approval_template", config.approvalTemplate, "Approved WhatsApp template name sent when owner approves a lead"],
    ["approval_template_lang", config.approvalTemplateLang, "Language code for the approval template (e.g. en)"],
    ["reminder_template", config.reminderTemplate, "Approved WhatsApp template name for pre-event reminders"],
    ["reminder_template_lang", config.reminderTemplateLang, "Language code for the reminder template (e.g. en)"],
    ["reminder_days_before", config.reminderDaysBefore, "Days before event to send reminders, comma-separated (e.g. 7,1)"],
    ["service_bridal_desc", config.serviceBridalDesc, "Description shown on booking page for Bridal"],
    ["service_engagement_desc", config.serviceEngagementDesc, "Description shown on booking page for Engagement"],
    ["service_reception_desc", config.serviceReceptionDesc, "Description shown on booking page for Reception"],
    ["service_party_desc", config.servicePartyDesc, "Description shown on booking page for Party"],
    ["service_shoot_desc", config.serviceShootDesc, "Description shown on booking page for Shoot"],
    ["service_other_desc", config.serviceOtherDesc, "Description shown on booking page for Other"],
    ["service_bridal_addons", config.serviceBridalAddons, "Addons for Bridal, format: name:price, e.g. Hair Styling:2000"],
    ["service_engagement_addons", config.serviceEngagementAddons, "Addons for Engagement"],
    ["service_reception_addons", config.serviceReceptionAddons, "Addons for Reception"],
    ["service_party_addons", config.servicePartyAddons, "Addons for Party"],
    ["service_shoot_addons", config.serviceShootAddons, "Addons for Shoot"],
    ["service_other_addons", config.serviceOtherAddons, "Addons for Other"],
    ["booking_time_slots", config.bookingTimeSlots, "Available time slots, comma-separated (e.g. 09:00,11:00,14:00,16:00)"],
    ["booking_waitlist_enabled", config.bookingWaitlistEnabled, "Allow waitlist when date is fully booked (Yes/No)"],
    ["portfolio_images", config.portfolioImages, "Portfolio image URLs shown on booking page, comma-separated"],
    ["about_text", config.aboutText, "Short intro/bio shown on your public booking page"],
    ["review_request_days_after", config.reviewRequestDaysAfter, "Days after event to auto-send a review request (blank = off)"],
    ["review_template", config.reviewTemplate, "Approved WhatsApp template name for automated review requests"],
    ["review_template_lang", config.reviewTemplateLang, "Language code for the review template (e.g. en)"],
  ];

  const artistsRows = [[
    ...artistHeaders,
  ], [
    "A001", config.ownerName || "Owner", config.ownerWhatsApp, config.ownerEmail, config.city, "Senior", 1, "Yes", config.confirmedCalendarId, "Yes"
  ]];

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `${sheetNames.config}!A1:C${configRows.length}`, values: configRows },
        { range: `${sheetNames.leads}!A1:${toColumn(leadHeaders.length)}1`, values: [[...leadHeaders]] },
        { range: `${sheetNames.bookings}!A1:${toColumn(bookingHeaders.length)}1`, values: [[...bookingHeaders]] },
        {
          range: `${sheetNames.artists}!A1:${toColumn(artistHeaders.length)}${options.includeSampleArtist === false ? 1 : 2}`,
          values: options.includeSampleArtist === false ? [[...artistHeaders]] : artistsRows,
        },
        { range: `${sheetNames.followUps}!A1:${toColumn(followUpHeaders.length)}1`, values: [[...followUpHeaders]] },
        { range: `${sheetNames.interactionLog}!A1:${toColumn(interactionHeaders.length)}1`, values: [[...interactionHeaders]] },
        { range: `${sheetNames.reviews}!A1:${toColumn(reviewHeaders.length)}1`, values: [[...reviewHeaders]] },
      ],
    },
  });
}

async function recoverBestWorkspaceForProfile(
  profile: { email: string; name: string },
  tokens: Credentials,
  existing?: WorkspaceRecord,
) {
  const candidates = await listRecoverableSheets(profile, tokens);
  if (!candidates.length) {
    return null;
  }

  const currentScore = existing
    ? await scoreSpreadsheet(tokens, existing.spreadsheetId)
    : null;
  const best = candidates[0];

  const shouldRecover =
    !existing ||
    (existing.spreadsheetId !== best.spreadsheetId &&
      best.score.total > (currentScore?.total ?? 0) + 2);

  if (!shouldRecover) {
    return null;
  }

  const config = await loadConfigFromSpreadsheet(profile, tokens, best.spreadsheetId);
  const now = new Date().toISOString();

  return {
    workspaceId: existing?.workspaceId ?? nanoid(12),
    email: profile.email,
    name: profile.name,
    spreadsheetId: best.spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${best.spreadsheetId}/edit`,
    spreadsheetName: best.name,
    confirmedCalendarId: config.confirmedCalendarId,
    tentativeCalendarId: config.tentativeCalendarId,
    tentativeCalendarName: existing?.tentativeCalendarName ?? "1Glam Tentative Bookings",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    googleTokens: existing?.googleTokens,
    metaConnections: existing?.metaConnections ?? {},
    config,
  };
}

async function listRecoverableSheets(profile: { email: string; name: string }, tokens: Credentials) {
  const { drive } = createGoogleClients(tokens);
  const response = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: "files(id,name,owners(emailAddress),modifiedTime)",
    pageSize: 100,
    orderBy: "modifiedTime desc",
  });

  const files = response.data.files ?? [];
  const matches = files.filter((file) => {
    const name = file.name ?? "";
    const ownerEmails = (file.owners ?? [])
      .map((owner) => owner.emailAddress?.toLowerCase())
      .filter(Boolean);
    return (
      name.includes("1Glam Booking OS") &&
      (ownerEmails.length === 0 || ownerEmails.includes(profile.email.toLowerCase()))
    );
  });

  const scored = [];
  for (const file of matches) {
    if (!file.id || !file.name) continue;
    const score = await scoreSpreadsheet(tokens, file.id);
    scored.push({
      spreadsheetId: file.id,
      name: file.name,
      score,
    });
  }

  return scored.sort((a, b) => b.score.total - a.score.total);
}

async function scoreSpreadsheet(tokens: Credentials, spreadsheetId: string) {
  const { sheets } = createGoogleClients(tokens);
  try {
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [
        `${sheetNames.leads}!A2:A`,
        `${sheetNames.bookings}!A2:A`,
        `${sheetNames.interactionLog}!A2:A`,
      ],
    });

    const [leadRange, bookingRange, interactionRange] = response.data.valueRanges ?? [];
    const leads = countNonEmptyRows((leadRange?.values as string[][] | undefined) ?? []);
    const bookings = countNonEmptyRows((bookingRange?.values as string[][] | undefined) ?? []);
    const interactions = countNonEmptyRows((interactionRange?.values as string[][] | undefined) ?? []);

    return {
      leads,
      bookings,
      interactions,
      total: bookings * 100 + leads * 10 + interactions,
    };
  } catch {
    return { leads: 0, bookings: 0, interactions: 0, total: 0 };
  }
}

async function loadConfigFromSpreadsheet(
  profile: { email: string; name: string },
  tokens: Credentials,
  spreadsheetId: string,
) {
  const { sheets } = createGoogleClients(tokens);
  const base = buildDefaultConfig(profile);

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetNames.config}!A2:B200`,
    });
    const rows = response.data.values ?? [];
    const values = Object.fromEntries(
      rows
        .filter((row) => row[0] && row[1] !== undefined)
        .map((row) => [String(row[0]), row[1]]),
    );

    const parsed = workspaceConfigSchema.safeParse({
      businessName: String(values.business_name ?? base.businessName),
      ownerName: String(values.owner_name ?? base.ownerName),
      ownerEmail: String(values.owner_email ?? base.ownerEmail),
      ownerWhatsApp: String(values.owner_whatsapp ?? (base.ownerWhatsApp || "00000000")),
      city: String(values.city ?? (base.city || "Unknown")),
      instagramHandle: String(values.instagram_handle ?? base.instagramHandle),
      aiLanguage: String(values.ai_language ?? base.aiLanguage),
      aiSignOff: String(values.ai_sign_off ?? base.aiSignOff),
      basePriceBridal: values.base_price_bridal ?? base.basePriceBridal,
      basePriceEngagement: values.base_price_engagement ?? base.basePriceEngagement,
      basePriceReception: values.base_price_reception ?? base.basePriceReception,
      basePriceParty: values.base_price_party ?? base.basePriceParty,
      basePriceShoot: values.base_price_shoot ?? base.basePriceShoot,
      basePriceOther: values.base_price_other ?? base.basePriceOther,
      multiplierJan: values.multiplier_jan ?? base.multiplierJan,
      multiplierFeb: values.multiplier_feb ?? base.multiplierFeb,
      multiplierMar: values.multiplier_mar ?? base.multiplierMar,
      multiplierApr: values.multiplier_apr ?? base.multiplierApr,
      multiplierMay: values.multiplier_may ?? base.multiplierMay,
      multiplierJun: values.multiplier_jun ?? base.multiplierJun,
      multiplierJul: values.multiplier_jul ?? base.multiplierJul,
      multiplierAug: values.multiplier_aug ?? base.multiplierAug,
      multiplierSep: values.multiplier_sep ?? base.multiplierSep,
      multiplierOct: values.multiplier_oct ?? base.multiplierOct,
      multiplierNov: values.multiplier_nov ?? base.multiplierNov,
      multiplierDec: values.multiplier_dec ?? base.multiplierDec,
      holdExpiryHours: values.hold_expiry_hours ?? base.holdExpiryHours,
      scarcityThresholdSoft: values.scarcity_threshold_soft ?? base.scarcityThresholdSoft,
      scarcityThresholdHard: values.scarcity_threshold_hard ?? base.scarcityThresholdHard,
      travelWithinCity: values.travel_within_city ?? base.travelWithinCity,
      travelNearbyCity: values.travel_nearby_city ?? base.travelNearbyCity,
      travelOutstation: values.travel_outstation ?? base.travelOutstation,
      travelOutstationThresholdKm:
        values.travel_outstation_threshold_km ?? base.travelOutstationThresholdKm,
      profileLowMultiplier: values.profile_low_multiplier ?? base.profileLowMultiplier,
      profileMidMultiplier: values.profile_mid_multiplier ?? base.profileMidMultiplier,
      profileHighMultiplier: values.profile_high_multiplier ?? base.profileHighMultiplier,
      profileHighMinFollowers: values.profile_high_min_followers ?? base.profileHighMinFollowers,
      advancePercentage: values.advance_percentage ?? base.advancePercentage,
      upiId: String(values.upi_id ?? base.upiId),
      qrImageUrl: String(values.qr_image_url ?? base.qrImageUrl),
      paymentTerms: String(values.payment_terms ?? base.paymentTerms),
      googleReviewLink: String(values.google_review_link ?? base.googleReviewLink),
      contractTemplateUrl: String(values.contract_template_url ?? base.contractTemplateUrl),
      confirmedCalendarId: String(values.confirmed_calendar_id ?? base.confirmedCalendarId),
      tentativeCalendarId: String(values.tentative_calendar_id ?? (base.tentativeCalendarId || "primary")),
      bookingPageEnabled: String(values.booking_page_enabled ?? base.bookingPageEnabled),
      bookingLeadTimeDays: values.booking_lead_time_days ?? base.bookingLeadTimeDays,
      bookingMaxAdvanceDays: values.booking_max_advance_days ?? base.bookingMaxAdvanceDays,
      bookingWeeklyOffDays: String(values.booking_weekly_off_days ?? base.bookingWeeklyOffDays),
      bookingBlockedDates: String(values.booking_blocked_dates ?? base.bookingBlockedDates),
      bookingMaxPerDay: values.booking_max_per_day ?? base.bookingMaxPerDay,
      bookingConfirmTemplate: String(values.booking_confirm_template ?? base.bookingConfirmTemplate),
      bookingConfirmTemplateLang: String(values.booking_confirm_template_lang ?? base.bookingConfirmTemplateLang),
      approvalTemplate: String(values.approval_template ?? base.approvalTemplate),
      approvalTemplateLang: String(values.approval_template_lang ?? base.approvalTemplateLang),
      reminderTemplate: String(values.reminder_template ?? base.reminderTemplate),
      reminderTemplateLang: String(values.reminder_template_lang ?? base.reminderTemplateLang),
      reminderDaysBefore: String(values.reminder_days_before ?? base.reminderDaysBefore),
      serviceBridalDesc: String(values.service_bridal_desc ?? base.serviceBridalDesc),
      serviceEngagementDesc: String(values.service_engagement_desc ?? base.serviceEngagementDesc),
      serviceReceptionDesc: String(values.service_reception_desc ?? base.serviceReceptionDesc),
      servicePartyDesc: String(values.service_party_desc ?? base.servicePartyDesc),
      serviceShootDesc: String(values.service_shoot_desc ?? base.serviceShootDesc),
      serviceOtherDesc: String(values.service_other_desc ?? base.serviceOtherDesc),
      serviceBridalAddons: String(values.service_bridal_addons ?? base.serviceBridalAddons),
      serviceEngagementAddons: String(values.service_engagement_addons ?? base.serviceEngagementAddons),
      serviceReceptionAddons: String(values.service_reception_addons ?? base.serviceReceptionAddons),
      servicePartyAddons: String(values.service_party_addons ?? base.servicePartyAddons),
      serviceShootAddons: String(values.service_shoot_addons ?? base.serviceShootAddons),
      serviceOtherAddons: String(values.service_other_addons ?? base.serviceOtherAddons),
      bookingTimeSlots: String(values.booking_time_slots ?? base.bookingTimeSlots),
      bookingWaitlistEnabled: String(values.booking_waitlist_enabled ?? base.bookingWaitlistEnabled),
      portfolioImages: String(values.portfolio_images ?? base.portfolioImages),
      aboutText: String(values.about_text ?? base.aboutText),
      reviewRequestDaysAfter: String(values.review_request_days_after ?? base.reviewRequestDaysAfter),
      reviewTemplate: String(values.review_template ?? base.reviewTemplate),
      reviewTemplateLang: String(values.review_template_lang ?? base.reviewTemplateLang),
    });

    return parsed.success ? parsed.data : base;
  } catch {
    return base;
  }
}

function countNonEmptyRows(rows: string[][]) {
  return rows.filter((row) => row.some((cell) => String(cell || "").trim())).length;
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
