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
  getDashboardData,
  updatePaymentStatus,
} from "./services/booking.js";
import { getWorkspaceCredentials } from "./services/auth-store.js";
import { buildOutboundReplyPayload, normalizeManychatPayload, normalizeWatiPayload } from "./services/channel-adapters.js";
import { findWorkspaceByMetaAsset, findWorkspaceByMetaUserId } from "./services/database.js";
import { exchangeCodeForTokens, fetchGoogleProfile, getAuthUrl } from "./services/google.js";
import { extractInboundTextFromMetaWebhook, ingestNormalizedLead, logInteractionForWorkspace } from "./services/integrations.js";
import {
  exchangeMetaCode,
  fetchMetaConnectionProfile,
  getMetaConnectUrl,
  parseMetaState,
  verifyAndParseMetaSignedRequest,
  verifyMetaWebhook,
} from "./services/meta.js";
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
    let workspace = null;
    let channel: "WhatsApp" | "Instagram" | null = null;
    let actorId = "";

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
    }

    if (workspace && channel) {
      const tokens = await getWorkspaceCredentials(workspace.email);
      await logInteractionForWorkspace(workspace.email, tokens, {
        direction: "Inbound",
        channel,
        actor: actorId || "meta-user",
        message: extractInboundTextFromMetaWebhook(body) || JSON.stringify(body).slice(0, 500),
        aiSummary: "Direct Meta webhook received",
      });
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
