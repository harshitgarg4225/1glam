import { nanoid } from "nanoid";
import type { Credentials } from "google-auth-library";
import { buildDefaultConfig } from "../defaults.js";
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
    const merged = {
      ...existing,
      googleTokens: {
        ...existing.googleTokens,
        access_token: tokens.access_token ?? existing.googleTokens?.access_token,
        refresh_token: tokens.refresh_token ?? existing.googleTokens?.refresh_token,
        scope: tokens.scope ?? existing.googleTokens?.scope,
        token_type: tokens.token_type ?? existing.googleTokens?.token_type,
        expiry_date: tokens.expiry_date ?? existing.googleTokens?.expiry_date ?? null,
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
