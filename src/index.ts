import express from "express";
import session from "express-session";
import path from "node:path";
import type { Credentials } from "google-auth-library";
import { appConfig } from "./config.js";
import { createLeadSchema, ownerDecisionSchema, paymentStatusSchema } from "./api-schema.js";
import { workspaceConfigSchema } from "./schema.js";
import {
  applyOwnerDecision,
  confirmLeadBooking,
  createLeadForWorkspace,
  findLatestLeadByActor,
  getBookingRecord,
  getLeadRecord,
  getDashboardData,
  updateBookingRecord,
  type LeadRecord,
  updateLeadRecord,
  updatePaymentStatus,
} from "./services/booking.js";
import { getWorkspaceCredentials } from "./services/auth-store.js";
import { buildOutboundReplyPayload, normalizeManychatPayload, normalizeWatiPayload } from "./services/channel-adapters.js";
import { findWorkspaceByMetaAsset, findWorkspaceByMetaUserId, listWorkspaces } from "./services/database.js";
import { exchangeCodeForTokens, fetchGoogleProfile, getAuthUrl } from "./services/google.js";
import {
  extractInboundTextFromMetaWebhook,
  ingestNormalizedLead,
  logInteractionForWorkspace,
  parseInstagramLeadSignalsFromMessage,
  parseWhatsAppLeadSignalsFromMessage,
} from "./services/integrations.js";
import { loadConversationMemory, saveConversationMemory } from "./services/conversation-memory.js";
import {
  exchangeMetaCode,
  fetchInstagramLoginConnectionProfile,
  fetchMetaConnectionProfile,
  fetchWhatsAppCloudConnectionProfile,
  getMetaConnectUrl,
  parseMetaState,
  verifyAndParseMetaSignedRequest,
  verifyMetaWebhook,
} from "./services/meta.js";
import { generateConversationReply } from "./services/grok.js";
import { sendChannelMessage } from "./services/messaging.js";
import { generateInvoiceDocument, generateQuoteDocument } from "./services/documents.js";
import {
  createLeegalityContract,
  parseLeegalityWebhook,
  verifyLeegalityWebhookSecret,
} from "./services/contracts.js";
import {
  disconnectMetaConnection,
  getWorkspaceByEmail,
  persistWorkspaceTokens,
  provisionWorkspace,
  upsertMetaConnection,
  updateWorkspaceConfig,
} from "./services/workspace.js";

declare module "express-session" {
  interface SessionData {
    googleTokens?: Credentials;
    profile?: {
      email: string;
      name: string;
      picture?: string;
    };
  }
}

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: appConfig.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  }),
);

app.use(express.static(path.join(process.cwd(), "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    codePrivate: true,
    oauthConfigured: Boolean(appConfig.googleClientId && appConfig.googleClientSecret),
  });
});

app.get("/auth/google", (_req, res) => {
  if (!appConfig.googleClientId || !appConfig.googleClientSecret) {
    return res.status(500).send("Google OAuth is not configured. Add env vars first.");
  }

  res.redirect(getAuthUrl());
});

app.get("/auth/meta/start", (req, res, next) => {
  try {
    const channel = req.query.channel;
    const workspaceEmail =
      typeof req.query.workspaceEmail === "string"
        ? req.query.workspaceEmail
        : req.session.profile?.email;

    if ((channel !== "instagram" && channel !== "whatsapp") || !workspaceEmail) {
      return res.status(400).send("Missing or invalid Meta connect parameters.");
    }

    res.redirect(getMetaConnectUrl({ workspaceEmail, channel }));
  } catch (error) {
    next(error);
  }
});

app.get("/auth/google/callback", async (req, res, next) => {
  try {
    const code = req.query.code;
    if (typeof code !== "string") {
      return res.status(400).send("Missing OAuth code.");
    }

    const tokens = await exchangeCodeForTokens(code);
    const profile = await fetchGoogleProfile(tokens);

    req.session.googleTokens = tokens;
    req.session.profile = profile;

    await provisionWorkspace(profile, tokens);
    await persistWorkspaceTokens(profile.email, tokens);
    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.get("/auth/meta/callback", async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !state) {
      return res.status(400).send("Missing Meta OAuth callback parameters.");
    }

    const parsedState = parseMetaState(state);
    const tokenResponse = await exchangeMetaCode(code);
    const connection = await fetchMetaConnectionProfile({
      accessToken: tokenResponse.access_token,
      channel: parsedState.channel,
    });

    await upsertMetaConnection(parsedState.workspaceEmail, parsedState.channel, {
      ...connection,
      accessToken: tokenResponse.access_token,
      tokenExpiresAt: tokenResponse.expires_in
        ? Date.now() + tokenResponse.expires_in * 1000
        : null,
    });

    res.redirect(`/?meta_connected=${parsedState.channel}`);
  } catch (error) {
    next(error);
  }
});

app.get("/auth/instagram/callback", (_req, res) => {
  res.redirect("/?instagram_login_ready=1");
});

app.get("/api/session", async (req, res, next) => {
  try {
    if (!req.session.profile) {
      return res.json({ authenticated: false });
    }

    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    const dashboard =
      req.session.googleTokens && workspace
        ? await getDashboardData(req.session.profile.email, req.session.googleTokens)
        : { leads: [], bookings: [] };
    return res.json({
      authenticated: true,
      profile: req.session.profile,
      workspace,
      dashboard,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspace/config", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = workspaceConfigSchema.parse(req.body);
    const workspace = await updateWorkspaceConfig(
      req.session.profile.email,
      parsed,
      req.session.googleTokens,
    );

    res.json({ ok: true, workspace });
  } catch (error) {
    next(error);
  }
});

app.post("/api/leads", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = createLeadSchema.parse(req.body);
    const result = await createLeadForWorkspace(
      req.session.profile.email,
      req.session.googleTokens,
      parsed,
    );

    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/leads/:leadId/decision", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = ownerDecisionSchema.parse(req.body);
    const result = await applyOwnerDecision(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.leadId,
      parsed.decision,
      parsed.approvedPrice,
      parsed.ownerNotes,
    );

    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/leads/:leadId/confirm", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await confirmLeadBooking(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.leadId,
    );

    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/leads/:leadId/payment", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = paymentStatusSchema.parse(req.body);
    const result = await updatePaymentStatus(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.leadId,
      parsed.paymentStatus,
    );

    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/leads/:leadId/quote", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    const lead = await getLeadRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.leadId,
    );
    if (!workspace || !lead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const quote = await generateQuoteDocument(workspace, req.session.googleTokens, lead);
    const updatedLead = await updateLeadRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.leadId,
      (current) => ({
        ...current,
        quoteUrl: quote.fileUrl,
        quoteGeneratedAt: new Date().toISOString(),
        lastContactedAt: new Date().toISOString(),
      }),
    );

    res.json({ ok: true, lead: updatedLead, quote });
  } catch (error) {
    next(error);
  }
});

app.post("/api/bookings/:bookingId/invoice", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    const booking = await getBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
    );
    if (!workspace || !booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const invoice = await generateInvoiceDocument(workspace, req.session.googleTokens, booking);
    const updatedBooking = await updateBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
      (current) => ({
        ...current,
        invoiceUrl: invoice.fileUrl,
        invoiceGeneratedAt: new Date().toISOString(),
      }),
    );

    res.json({ ok: true, booking: updatedBooking, invoice });
  } catch (error) {
    next(error);
  }
});

app.post("/api/bookings/:bookingId/contract", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    const booking = await getBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
    );
    if (!workspace || !booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const lead = await getLeadRecord(
      req.session.profile.email,
      req.session.googleTokens,
      booking.leadId,
    );
    if (!lead) {
      return res.status(404).json({ error: "Lead not found for booking" });
    }

    const contract = await createLeegalityContract(workspace, lead, booking);
    const updatedBooking = await updateBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
      (current) => ({
        ...current,
        contractUrl: contract.contractUrl || current.contractUrl,
        contractStatus: contract.contractStatus || "Sent",
        contractSentAt: new Date().toISOString(),
      }),
    );

    res.json({ ok: true, booking: updatedBooking, contract });
  } catch (error) {
    next(error);
  }
});

app.post("/api/leads/:leadId/reply", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const lead = await getLeadRecord(req.session.profile.email, req.session.googleTokens, req.params.leadId);
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!lead || !workspace) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const channel = lead.source === "WhatsApp" ? "WhatsApp" : "Instagram";
    const connection =
      channel === "WhatsApp"
        ? workspace.metaConnections?.whatsapp
        : workspace.metaConnections?.instagram;
    if (!connection || connection.status !== "connected") {
      return res.status(400).json({ error: `${channel} is not connected` });
    }

    const message =
      typeof req.body?.message === "string" && req.body.message.trim().length > 0
        ? req.body.message.trim()
        : lead.suggestedReply;
    if (!message) {
      return res.status(400).json({ error: "Reply message is empty" });
    }

    const actorId = channel === "WhatsApp" ? lead.clientWhatsApp : lead.clientInstagram;
    if (!actorId) {
      return res.status(400).json({ error: "Lead does not have a channel actor id" });
    }

    await sendChannelMessage({
      workspace,
      connection,
      channel,
      actorId,
      message,
    });

    const updatedLead = await updateLeadRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.leadId,
      (current) => ({
        ...current,
        suggestedReply: message,
        lastContactedAt: new Date().toISOString(),
      }),
    );

    const existingMemory = await loadConversationMemory(workspace.workspaceId, updatedLead.leadId);
    await saveConversationMemory({
      workspaceId: workspace.workspaceId,
      leadId: updatedLead.leadId,
      clientName: updatedLead.clientName,
      channel,
      summary: updatedLead.aiInsight || extractSummaryFromMemory(existingMemory),
      knownDetails: buildKnownDetails(updatedLead),
      openQuestions: inferOpenQuestions(updatedLead),
      lastInboundMessage: extractLastInboundFromMemory(existingMemory),
      lastOutboundMessage: message,
    });

    await logInteractionForWorkspace(req.session.profile.email, req.session.googleTokens, {
      leadId: updatedLead.leadId,
      direction: "Outbound",
      channel,
      actor: actorId,
      message,
      aiSummary: "Reply sent from dashboard",
    });

    res.json({ ok: true, lead: updatedLead });
  } catch (error) {
    next(error);
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.post("/api/meta/connections/:channel/assets", async (req, res, next) => {
  try {
    if (!req.session.profile) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const channel = req.params.channel;
    if (channel !== "instagram" && channel !== "whatsapp") {
      return res.status(400).json({ error: "Invalid channel" });
    }

    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    const existing = workspace.metaConnections?.[channel];
    if (!existing) {
      return res.status(400).json({ error: "Connect Meta first for this channel" });
    }

    const next = {
      ...existing,
      pageId: typeof req.body.pageId === "string" ? req.body.pageId : existing.pageId,
      pageName: typeof req.body.pageName === "string" ? req.body.pageName : existing.pageName,
      instagramBusinessAccountId:
        typeof req.body.instagramBusinessAccountId === "string"
          ? req.body.instagramBusinessAccountId
          : existing.instagramBusinessAccountId,
      instagramUsername:
        typeof req.body.instagramUsername === "string"
          ? req.body.instagramUsername
          : existing.instagramUsername,
      wabaId: typeof req.body.wabaId === "string" ? req.body.wabaId : existing.wabaId,
      phoneNumberId:
        typeof req.body.phoneNumberId === "string"
          ? req.body.phoneNumberId
          : existing.phoneNumberId,
      businessAccountName:
        typeof req.body.businessAccountName === "string"
          ? req.body.businessAccountName
          : existing.businessAccountName,
    };

    await upsertMetaConnection(req.session.profile.email, channel, next);
    res.json({ ok: true, connection: next });
  } catch (error) {
    next(error);
  }
});

app.post("/api/meta/instagram/token", async (req, res, next) => {
  try {
    if (!req.session.profile) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const accessToken =
      typeof req.body?.accessToken === "string" ? req.body.accessToken.trim() : "";
    if (!accessToken) {
      return res.status(400).json({ error: "Instagram access token is required" });
    }

    const connection = await fetchInstagramLoginConnectionProfile(accessToken);
    const workspace = await upsertMetaConnection(req.session.profile.email, "instagram", connection);
    res.json({ ok: true, connection, workspace });
  } catch (error) {
    next(error);
  }
});

app.post("/api/meta/whatsapp/test-connect", async (req, res, next) => {
  try {
    if (!req.session.profile) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!appConfig.waAccessToken || !appConfig.waPhoneNumberId || !appConfig.waBusinessAccountId) {
      return res.status(400).json({
        error: "WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, and WA_BUSINESS_ACCOUNT_ID must be configured",
      });
    }

    const connection = await fetchWhatsAppCloudConnectionProfile({
      accessToken: appConfig.waAccessToken,
      phoneNumberId: appConfig.waPhoneNumberId,
      wabaId: appConfig.waBusinessAccountId,
    });

    const workspace = await upsertMetaConnection(req.session.profile.email, "whatsapp", connection);
    res.json({ ok: true, connection, workspace });
  } catch (error) {
    next(error);
  }
});

app.post("/api/meta/disconnect/:channel", async (req, res, next) => {
  try {
    if (!req.session.profile) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const channel = req.params.channel;
    if (channel !== "instagram" && channel !== "whatsapp") {
      return res.status(400).json({ error: "Invalid channel" });
    }

    const workspace = await disconnectMetaConnection(req.session.profile.email, channel);
    res.json({ ok: true, workspace });
  } catch (error) {
    next(error);
  }
});

app.post("/webhooks/wati", async (req, res, next) => {
  try {
    const parsed = normalizeWatiPayload(req.body as Record<string, unknown>);
    if (appConfig.watiWebhookSecret && parsed.secret !== appConfig.watiWebhookSecret) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }

    const workspaceTokens = await getWorkspaceCredentials(parsed.workspaceEmail);

    const result = await ingestNormalizedLead(workspaceTokens, {
      workspaceEmail: parsed.workspaceEmail,
      source: "WhatsApp",
      clientName: parsed.clientName,
      clientWhatsApp: parsed.clientWhatsApp,
      clientInstagram: parsed.clientInstagram,
      eventType: parsed.eventType,
      eventDate: parsed.eventDate,
      eventTime: parsed.eventTime,
      locationText: parsed.locationText,
      distanceKm: parsed.distanceKm,
      travelTimeMin: parsed.travelTimeMin,
      profileTier: parsed.profileTier,
      followers: parsed.followers,
      clientTags: parsed.clientTags,
      inboundMessage: parsed.messageText,
      actorId: parsed.actorId || parsed.clientWhatsApp,
    });

    res.json({
      ok: true,
      leadId: result.lead.leadId,
      outboundTemplate: buildOutboundReplyPayload({
        channel: "WhatsApp",
        actorId: parsed.actorId || parsed.clientWhatsApp,
        message: result.lead.suggestedReply || `Hi ${result.lead.clientName}, thank you for reaching out.`,
      }),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/webhooks/manychat", async (req, res, next) => {
  try {
    const parsed = normalizeManychatPayload(req.body as Record<string, unknown>);
    if (appConfig.manychatWebhookSecret && parsed.secret !== appConfig.manychatWebhookSecret) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }

    const workspaceTokens = await getWorkspaceCredentials(parsed.workspaceEmail);

    const result = await ingestNormalizedLead(workspaceTokens, {
      workspaceEmail: parsed.workspaceEmail,
      source: "Instagram",
      clientName: parsed.clientName,
      clientWhatsApp: parsed.clientWhatsApp,
      clientInstagram: parsed.clientInstagram,
      eventType: parsed.eventType,
      eventDate: parsed.eventDate,
      eventTime: parsed.eventTime,
      locationText: parsed.locationText,
      distanceKm: parsed.distanceKm,
      travelTimeMin: parsed.travelTimeMin,
      profileTier: parsed.profileTier,
      followers: parsed.followers,
      clientTags: parsed.clientTags,
      inboundMessage: parsed.messageText,
      actorId: parsed.actorId || parsed.clientInstagram || parsed.clientName,
    });

    res.json({
      ok: true,
      leadId: result.lead.leadId,
      outboundTemplate: buildOutboundReplyPayload({
        channel: "Instagram",
        actorId: parsed.actorId || parsed.clientInstagram || parsed.clientName,
        message: result.lead.suggestedReply || `Hi ${result.lead.clientName}, thank you for reaching out.`,
      }),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/webhooks/meta", (req, res) => {
  const challenge = verifyMetaWebhook(
    typeof req.query["hub.mode"] === "string" ? req.query["hub.mode"] : undefined,
    typeof req.query["hub.verify_token"] === "string" ? req.query["hub.verify_token"] : undefined,
    typeof req.query["hub.challenge"] === "string" ? req.query["hub.challenge"] : undefined,
  );

  if (challenge === null) {
    return res.status(403).send("Meta webhook verification failed");
  }

  return res.status(200).send(challenge);
});

app.post("/webhooks/meta", async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const object = typeof body.object === "string" ? body.object : "";
    const field = typeof body.field === "string" ? body.field : "";
    let workspace = null;
    let channel: "WhatsApp" | "Instagram" | null = null;
    let actorId = "";
    let recipientId = "";

    if (object === "whatsapp_business_account") {
      const entry = Array.isArray(body.entry) ? (body.entry[0] as Record<string, unknown>) : undefined;
      const change = entry && Array.isArray(entry.changes) ? (entry.changes[0] as Record<string, unknown>) : undefined;
      const value = change?.value as Record<string, unknown> | undefined;
      const metadata = value?.metadata as Record<string, unknown> | undefined;
      const phoneNumberId =
        typeof metadata?.phone_number_id === "string" ? metadata.phone_number_id : undefined;
      const wabaId = typeof entry?.id === "string" ? entry.id : undefined;
      const message = Array.isArray(value?.messages) ? (value?.messages[0] as Record<string, unknown>) : undefined;
      actorId = typeof message?.from === "string" ? message.from : "";
      workspace = await findWorkspaceByMetaAsset({ channel: "whatsapp", phoneNumberId, wabaId });
      channel = "WhatsApp";
    } else if (object === "page") {
      const entry = Array.isArray(body.entry) ? (body.entry[0] as Record<string, unknown>) : undefined;
      const pageId = typeof entry?.id === "string" ? entry.id : undefined;
      const messaging = entry && Array.isArray(entry.messaging) ? (entry.messaging[0] as Record<string, unknown>) : undefined;
      const sender = messaging?.sender as Record<string, unknown> | undefined;
      actorId = typeof sender?.id === "string" ? sender.id : "";
      workspace = await findWorkspaceByMetaAsset({ channel: "instagram", pageId });
      channel = "Instagram";
    } else if (object === "instagram") {
      const entry = Array.isArray(body.entry) ? (body.entry[0] as Record<string, unknown>) : undefined;
      const instagramBusinessAccountId =
        typeof entry?.id === "string" ? entry.id : undefined;
      const messaging =
        entry && Array.isArray(entry.messaging) ? (entry.messaging[0] as Record<string, unknown>) : undefined;
      const sender = messaging?.sender as Record<string, unknown> | undefined;
      const recipient = messaging?.recipient as Record<string, unknown> | undefined;
      actorId = typeof sender?.id === "string" ? sender.id : "";
      recipientId = typeof recipient?.id === "string" ? recipient.id : "";
      workspace = await findWorkspaceByMetaAsset({
        channel: "instagram",
        instagramBusinessAccountId: instagramBusinessAccountId ?? recipientId,
      });
      channel = "Instagram";
    } else if (field === "messages") {
      const value = body.value as Record<string, unknown> | undefined;
      const sender = value?.sender as Record<string, unknown> | undefined;
      const recipient = value?.recipient as Record<string, unknown> | undefined;
      actorId = typeof sender?.id === "string" ? sender.id : "";
      recipientId = typeof recipient?.id === "string" ? recipient.id : "";
      workspace = await findWorkspaceByMetaAsset({
        channel: "instagram",
        instagramBusinessAccountId: recipientId,
      });
      channel = workspace ? "Instagram" : null;
    }

    if (workspace && channel) {
      const tokens = await getWorkspaceCredentials(workspace.email);
      const inboundText = extractInboundTextFromMetaWebhook(body);
      let leadCreated = false;
      let resolvedLeadId = "";

      if (channel === "Instagram" && inboundText) {
        const existingLead = actorId
          ? await findLatestLeadByActor(workspace.email, tokens, { channel, actorId })
          : null;
        const parsedLead = parseInstagramLeadSignalsFromMessage(inboundText);
        if (existingLead) {
          const updatedLead = await updateLeadRecord(
            workspace.email,
            tokens,
            existingLead.record.leadId,
            (current) => ({
              ...current,
              clientName: current.clientName || (actorId ? `Instagram ${actorId}` : "Instagram Lead"),
              eventType: current.eventType === "Other" ? parsedLead.eventType : current.eventType,
              eventDate: current.eventDate || parsedLead.eventDate,
              locationText:
                current.locationText === "Unknown" ? parsedLead.locationText : current.locationText,
              clientTags: mergeTags(current.clientTags, parsedLead.clientTags),
              lastContactedAt: new Date().toISOString(),
            }),
          );
          resolvedLeadId = updatedLead.leadId;
          await logInteractionForWorkspace(workspace.email, tokens, {
            leadId: updatedLead.leadId,
            direction: "Inbound",
            channel,
            actor: actorId || "instagram-user",
            message: inboundText,
            aiSummary: "Existing Instagram lead updated",
          });
        } else {
          const result = await ingestNormalizedLead(tokens, {
            workspaceEmail: workspace.email,
            source: "Instagram",
            clientName: actorId ? `Instagram ${actorId}` : "Instagram Lead",
            clientWhatsApp: "",
            clientInstagram: actorId || undefined,
            eventType: parsedLead.eventType,
            eventDate: parsedLead.eventDate,
            locationText: parsedLead.locationText,
            clientTags: parsedLead.clientTags,
            inboundMessage: inboundText,
            actorId: actorId || "instagram-user",
          });
          resolvedLeadId = result.lead.leadId;
          leadCreated = true;
        }
      } else if (channel === "WhatsApp" && inboundText) {
        const entry = Array.isArray(body.entry) ? (body.entry[0] as Record<string, unknown>) : undefined;
        const change = entry && Array.isArray(entry.changes) ? (entry.changes[0] as Record<string, unknown>) : undefined;
        const value = change?.value as Record<string, unknown> | undefined;
        const contacts = Array.isArray(value?.contacts) ? (value?.contacts[0] as Record<string, unknown>) : undefined;
        const profile = contacts?.profile as Record<string, unknown> | undefined;
        const senderName =
          typeof profile?.name === "string" && profile.name.trim().length > 0
            ? profile.name.trim()
            : actorId
              ? `WhatsApp ${actorId}`
              : "WhatsApp Lead";
        const parsedLead = parseWhatsAppLeadSignalsFromMessage(inboundText);
        const existingLead = actorId
          ? await findLatestLeadByActor(workspace.email, tokens, { channel, actorId })
          : null;

        if (existingLead) {
          const updatedLead = await updateLeadRecord(
            workspace.email,
            tokens,
            existingLead.record.leadId,
            (current) => ({
              ...current,
              clientName: current.clientName || senderName,
              eventType: current.eventType === "Other" ? parsedLead.eventType : current.eventType,
              eventDate: current.eventDate || parsedLead.eventDate,
              locationText:
                current.locationText === "Unknown" ? parsedLead.locationText : current.locationText,
              clientTags: mergeTags(current.clientTags, parsedLead.clientTags),
              lastContactedAt: new Date().toISOString(),
            }),
          );
          resolvedLeadId = updatedLead.leadId;
          await logInteractionForWorkspace(workspace.email, tokens, {
            leadId: updatedLead.leadId,
            direction: "Inbound",
            channel,
            actor: actorId || "whatsapp-user",
            message: inboundText,
            aiSummary: "Existing WhatsApp lead updated",
          });
        } else {
          const result = await ingestNormalizedLead(tokens, {
            workspaceEmail: workspace.email,
            source: "WhatsApp",
            clientName: senderName,
            clientWhatsApp: actorId || "",
            eventType: parsedLead.eventType,
            eventDate: parsedLead.eventDate,
            locationText: parsedLead.locationText,
            clientTags: parsedLead.clientTags,
            inboundMessage: inboundText,
            actorId: actorId || "whatsapp-user",
          });
          resolvedLeadId = result.lead.leadId;
          leadCreated = true;
        }
      }

      if ((channel === "Instagram" || channel === "WhatsApp") && inboundText && resolvedLeadId) {
        const lead = await getLeadRecord(workspace.email, tokens, resolvedLeadId);
        if (lead) {
          const memory = await loadConversationMemory(workspace.workspaceId, lead.leadId);
          const conversation = await generateConversationReply({
            ownerName: workspace.config.ownerName,
            brandName: workspace.config.businessName,
            city: workspace.config.city,
            channel,
            clientName: lead.clientName,
            leadStatus: lead.status,
            eventType: lead.eventType,
            eventDate: lead.eventDate,
            eventTime: lead.eventTime,
            locationText: lead.locationText,
            suggestedReply: lead.suggestedReply,
            currentPrice: lead.finalApprovedPrice || lead.initialAiPrice,
            latestMessage: inboundText,
            memorySummary: extractSummaryFromMemory(memory),
          });

          await updateLeadRecord(workspace.email, tokens, lead.leadId, (current) => ({
            ...current,
            aiInsight: conversation.ownerSummary || current.aiInsight,
            suggestedReply: conversation.reply || current.suggestedReply,
            lastContactedAt: new Date().toISOString(),
          }));

          await saveConversationMemory({
            workspaceId: workspace.workspaceId,
            leadId: lead.leadId,
            clientName: lead.clientName,
            channel,
            summary: conversation.memorySummary || conversation.ownerSummary || buildLeadSummary(lead),
            knownDetails: buildKnownDetails(lead),
            openQuestions: conversation.openQuestions.length
              ? conversation.openQuestions
              : inferOpenQuestions(lead),
            lastInboundMessage: inboundText,
            lastOutboundMessage: "",
          });
        }
      } else if (!leadCreated) {
        await logInteractionForWorkspace(workspace.email, tokens, {
          direction: "Inbound",
          channel,
          actor: actorId || "meta-user",
          message: inboundText || JSON.stringify(body).slice(0, 500),
          aiSummary: "Direct Meta webhook received",
        });
      }
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/compliance/meta/data-deletion", async (req, res, next) => {
  try {
    const signedRequest = typeof req.body?.signed_request === "string" ? req.body.signed_request : "";
    if (!signedRequest) {
      return res.status(400).json({ error: "Missing signed_request" });
    }

    const parsed = verifyAndParseMetaSignedRequest(signedRequest);
    const workspace = parsed.user_id ? await findWorkspaceByMetaUserId(parsed.user_id) : null;
    if (workspace) {
      await disconnectMetaConnection(workspace.email, "instagram");
      await disconnectMetaConnection(workspace.email, "whatsapp");
    }

    res.json({
      url: `${appConfig.baseUrl}/legal/data-deletion`,
      confirmation_code: `meta-delete-${Date.now()}`,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/webhooks/leegality", async (req, res, next) => {
  try {
    const secretOk = verifyLeegalityWebhookSecret([
      typeof req.headers["x-leegality-secret"] === "string" ? req.headers["x-leegality-secret"] : undefined,
      typeof req.headers["x-webhook-secret"] === "string" ? req.headers["x-webhook-secret"] : undefined,
      typeof req.query.secret === "string" ? req.query.secret : undefined,
      typeof req.body?.secret === "string" ? req.body.secret : undefined,
    ]);

    if (!secretOk) {
      return res.status(401).json({ error: "Invalid Leegality webhook secret" });
    }

    const event = parseLeegalityWebhook(req.body);
    const resolved = await findBookingAcrossWorkspaces(event.referenceId);

    if (!resolved) {
      return res.status(404).json({ error: `No booking found for reference ${event.referenceId}` });
    }

    const updatedBooking = await updateBookingRecord(
      resolved.workspace.email,
      resolved.tokens,
      resolved.booking.bookingId,
      (current) => ({
        ...current,
        contractStatus: event.contractStatus || current.contractStatus,
        contractUrl: event.contractUrl || current.contractUrl,
        contractSentAt: current.contractSentAt || new Date().toISOString(),
      }),
    );

    res.json({
      ok: true,
      bookingId: updatedBooking.bookingId,
      contractStatus: updatedBooking.contractStatus,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/legal/privacy", (_req, res) => {
  res.type("html").send(`<!doctype html><html><body><h1>1Glam Privacy Policy</h1><p>1Glam stores each artist's Google and Meta connection data separately. Client messages, lead records, bookings, and operational data are isolated per workspace and used only to provide booking, communication, and fulfillment automation for that workspace.</p><p>To request deletion or disconnection, use the in-app disconnect flow or the Meta data deletion callback.</p></body></html>`);
});

app.get("/legal/data-deletion", (_req, res) => {
  res.type("html").send(`<!doctype html><html><body><h1>1Glam Data Deletion</h1><p>Users can disconnect Meta integrations from within the app, which removes active channel access for that workspace. Meta-originated deletion callbacks are processed through the platform's data deletion endpoint, and connection records are marked disconnected per workspace.</p></body></html>`);
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  res.status(500).json({ error: message });
});

app.listen(appConfig.port, () => {
  console.log(`1Glam app listening on ${appConfig.baseUrl}`);
});

function mergeTags(existing: string, incoming: string) {
  const values = [...existing.split(","), ...incoming.split(",")]
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)].join(", ");
}

function buildKnownDetails(lead: LeadRecord) {
  return [
    `Lead ID: ${lead.leadId}`,
    `Source: ${lead.source}`,
    `Event Type: ${lead.eventType}`,
    `Event Date: ${lead.eventDate}`,
    `Event Time: ${lead.eventTime || "Not shared"}`,
    `Location: ${lead.locationText || "Unknown"}`,
    `Status: ${lead.status}`,
    `Price: ${lead.finalApprovedPrice || lead.initialAiPrice || 0}`,
  ];
}

function inferOpenQuestions(lead: LeadRecord) {
  const questions = [];
  if (!lead.eventTime) questions.push("What time is the event?");
  if (!lead.locationText || lead.locationText === "Unknown") {
    questions.push("What is the venue or exact location?");
  }
  return questions;
}

function extractSummaryFromMemory(memory: string) {
  const match = memory.match(/## Summary\s+([\s\S]*?)(?:\n## |\s*$)/);
  return match?.[1]?.trim() || "";
}

function extractLastInboundFromMemory(memory: string) {
  const match = memory.match(/## Last Inbound Message\s+([\s\S]*?)(?:\n## |\s*$)/);
  return match?.[1]?.trim() || "";
}

function buildLeadSummary(lead: LeadRecord) {
  return `Client ${lead.clientName} is discussing a ${lead.eventType} booking for ${lead.eventDate} in ${lead.locationText}. Current status: ${lead.status}.`;
}

async function findBookingAcrossWorkspaces(referenceId: string) {
  const workspaces = await listWorkspaces();

  for (const workspace of workspaces) {
    try {
      const tokens = await getWorkspaceCredentials(workspace.email);
      const booking = await getBookingRecord(workspace.email, tokens, referenceId);
      if (booking) {
        return { workspace, tokens, booking };
      }
    } catch {
      // Ignore individual workspace lookup failures and continue scanning.
    }
  }

  return null;
}
