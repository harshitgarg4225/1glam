import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import path from "node:path";
import { readFileSync } from "node:fs";
import { nanoid } from "nanoid";
import type { Credentials } from "google-auth-library";
import { appConfig, assertDeploymentConfig } from "./config.js";
import { createLeadSchema, ownerDecisionSchema, paymentStatusSchema, publicBookingSchema } from "./api-schema.js";
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
  type BookingRecord,
  type LeadRecord,
  updateLeadRecord,
  updatePaymentStatus,
} from "./services/booking.js";
import { getWorkspaceCredentials } from "./services/auth-store.js";
import { buildOutboundReplyPayload, normalizeManychatPayload, normalizeWatiPayload } from "./services/channel-adapters.js";
import { findWorkspaceByMetaAsset, findWorkspaceByMetaUserId, listWorkspaces } from "./services/database.js";
import { createGoogleClients, exchangeCodeForTokens, fetchGoogleProfile, getAuthUrl } from "./services/google.js";
import {
  extractInboundTextFromMetaWebhook,
  ingestNormalizedLead,
  listInteractions,
  logInteractionForWorkspace,
  parseInstagramLeadSignalsFromMessage,
  parseWhatsAppLeadSignalsFromMessage,
} from "./services/integrations.js";
import { deactivateArtist, listArtists, upsertArtist } from "./services/team.js";
import { createPublicBookingRequest, getPublicBusinessProfile, getPublicPaymentDetails, submitPaymentScreenshot } from "./services/public-booking.js";
import { buildGoogleReviewLink, findBusinessCandidates, placesConfigured } from "./services/places.js";
import { DOCUMENT_THEME_LIST } from "./services/document-themes.js";
import { loadConversationMemory, saveConversationMemory } from "./services/conversation-memory.js";
import {
  exchangeForLongLivedToken,
  exchangeMetaCode,
  fetchInstagramLoginConnectionProfile,
  fetchMetaConnectionProfile,
  fetchWhatsAppCloudConnectionProfile,
  getMetaConnectUrl,
  parseMetaState,
  subscribePageToWebhooks,
  subscribeWabaToWebhooks,
  verifyAndParseMetaSignedRequest,
  verifyMetaWebhook,
  verifyMetaWebhookSignature,
} from "./services/meta.js";
import { generateConversationReply } from "./services/grok.js";
import { sendChannelMessage, sendBusinessMessage } from "./services/messaging.js";
import { startReminderScheduler } from "./services/reminders.js";
import { logger, captureException } from "./services/logger.js";
import { encryptionEnabled } from "./services/crypto.js";
import { generateInvoiceDocument, generateQuoteDocument } from "./services/documents.js";
import {
  checkLeegalityDocumentDetails,
  createLeegalityContract,
  parseLeegalityWebhook,
  verifyLeegalityWebhookRequest,
} from "./services/contracts.js";
import { sheetNames } from "./services/sheet-definitions.js";
import type { MetaChannel, WorkspaceRecord } from "./types.js";
import {
  addPortfolioImage,
  disconnectMetaConnection,
  getWorkspaceByEmail,
  persistWorkspaceTokens,
  provisionWorkspace,
  recoverSheet,
  setSheetProtection,
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

// Image uploads (payment screenshots, portfolio) — images only, max 10 MB.
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only image files (JPG, PNG, WEBP, HEIC) are allowed."));
    }
  },
});

// Throttle unauthenticated public endpoints to curb abuse / DoS.
const publicWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a minute and try again." },
});

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
const PgSession = connectPgSimple(session);
const sessionStore = appConfig.databaseUrl
  ? new PgSession({
      conString: appConfig.databaseUrl,
      tableName: "user_sessions",
      createTableIfMissing: true,
    })
  : undefined;

app.set("trust proxy", 1);
app.use(
  session({
    store: sessionStore,
    secret: appConfig.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: appConfig.baseUrl.startsWith("https://"),
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  }),
);

// Auto-restore Google tokens into session from persisted workspace store.
// This heals sessions after server restarts: profile comes back from the
// session cookie, tokens come from the workspace record.
app.use(async (req, _res, next) => {
  if (req.session.profile && !req.session.googleTokens) {
    try {
      req.session.googleTokens = await getWorkspaceCredentials(req.session.profile.email);
    } catch {
      // No workspace yet — user is mid-signup; route guards will handle it.
    }
  }
  next();
});

app.use(express.static(path.join(process.cwd(), "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    codePrivate: true,
    oauthConfigured: Boolean(appConfig.googleClientId && appConfig.googleClientSecret),
  });
});

// Booking page is served with per-artist Open Graph tags injected server-side
// so shared links (WhatsApp, Instagram DM, Facebook) preview the artist's name,
// intro, and first portfolio image. The template is read once at boot.
const bookingPageTemplate = readFileSync(
  path.join(process.cwd(), "public", "book.html"),
  "utf8",
);

function escapeAttr(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildBookingMeta(
  workspaceId: string,
  profile: Awaited<ReturnType<typeof getPublicBusinessProfile>>,
): string {
  const url = `${appConfig.baseUrl}/book/${encodeURIComponent(workspaceId)}`;
  const title = profile ? `Book with ${profile.businessName}` : "Book an Appointment";
  const rawDesc =
    profile && profile.aboutText
      ? profile.aboutText
      : "Check availability and request your booking date.";
  const desc = rawDesc.length > 200 ? `${rawDesc.slice(0, 197)}…` : rawDesc;
  const image = profile?.portfolioImages?.[0] || "";
  return [
    `<title>${escapeAttr(title)}</title>`,
    `<meta name="description" content="${escapeAttr(desc)}" />`,
    `<meta property="og:title" content="${escapeAttr(title)}" />`,
    `<meta property="og:description" content="${escapeAttr(desc)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeAttr(url)}" />`,
    image ? `<meta property="og:image" content="${escapeAttr(image)}" />` : "",
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${escapeAttr(title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(desc)}" />`,
    image ? `<meta name="twitter:image" content="${escapeAttr(image)}" />` : "",
    `<meta name="theme-color" content="#C26B45" />`,
  ]
    .filter(Boolean)
    .join("\n    ");
}

app.get("/book/:workspaceId", async (req, res, next) => {
  try {
    let profile: Awaited<ReturnType<typeof getPublicBusinessProfile>> = null;
    try {
      profile = await getPublicBusinessProfile(req.params.workspaceId);
    } catch {
      profile = null;
    }
    const html = bookingPageTemplate.replace(
      "<!--OG_META-->",
      buildBookingMeta(req.params.workspaceId, profile),
    );
    res.type("html").send(html);
  } catch (error) {
    next(error);
  }
});

app.get("/api/public/:workspaceId/profile", async (req, res, next) => {
  try {
    const profile = await getPublicBusinessProfile(req.params.workspaceId);
    if (!profile) {
      return res.status(404).json({ error: "Booking page not found" });
    }
    res.json({ ok: true, profile });
  } catch (error) {
    next(error);
  }
});

app.post("/api/public/:workspaceId/book", publicWriteLimiter, async (req, res, next) => {
  try {
    const parsed = publicBookingSchema.parse(req.body);
    const result = await createPublicBookingRequest(String(req.params.workspaceId), parsed);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.get("/pay/:workspaceId/:leadId", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "pay.html"));
});

app.get("/api/public/:workspaceId/payment/:leadId", async (req, res, next) => {
  try {
    const details = await getPublicPaymentDetails(req.params.workspaceId, req.params.leadId);
    if (!details) return res.status(404).json({ error: "Payment details not found" });
    res.json({ ok: true, details });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/public/:workspaceId/payment/:leadId/screenshot",
  publicWriteLimiter,
  (req, res, next) => {
    upload.single("screenshot")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || "Upload failed" });
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const result = await submitPaymentScreenshot(
        String(req.params.workspaceId),
        String(req.params.leadId),
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname,
      );
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json({ ok: true, fileUrl: result.fileUrl });
    } catch (error) {
      next(error);
    }
  },
);

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

    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
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
    const shortLived = await exchangeMetaCode(code);
    const longLived = await exchangeForLongLivedToken(shortLived.access_token).catch(
      () => shortLived,
    );
    const connection = await fetchMetaConnectionProfile({
      accessToken: longLived.access_token,
      channel: parsedState.channel,
    });

    await upsertMetaConnection(parsedState.workspaceEmail, parsedState.channel, {
      ...connection,
      accessToken: longLived.access_token,
      tokenExpiresAt: longLived.expires_in
        ? Date.now() + longLived.expires_in * 1000
        : null,
    });

    if (parsedState.channel === "instagram" && connection.pageId) {
      await subscribePageToWebhooks(
        connection.pageId,
        connection.pageAccessToken ?? longLived.access_token,
      ).catch((error) => console.error("Page webhook subscription failed", error));
    }
    if (parsedState.channel === "whatsapp" && connection.wabaId) {
      await subscribeWabaToWebhooks(connection.wabaId, longLived.access_token).catch((error) =>
        console.error("WABA webhook subscription failed", error),
      );
    }

    res.redirect(`/?meta_connected=${parsedState.channel}`);
  } catch (error) {
    next(error);
  }
});

app.get("/auth/instagram/callback", (_req, res) => {
  res.redirect("/?instagram_login_ready=1");
});

function scrubWorkspaceTokens(workspace: WorkspaceRecord | null): WorkspaceRecord | null {
  if (!workspace) return null;
  const { googleTokens: _gt, ...rest } = workspace;
  if (!rest.metaConnections) return rest as WorkspaceRecord;
  const scrubbed: typeof rest.metaConnections = {};
  for (const [ch, conn] of Object.entries(rest.metaConnections)) {
    if (!conn) continue;
    const { accessToken: _at, pageAccessToken: _pt, ...safeConn } = conn;
    scrubbed[ch as MetaChannel] = safeConn as typeof conn;
  }
  return { ...rest, metaConnections: scrubbed } as WorkspaceRecord;
}

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
      workspace: scrubWorkspaceTokens(workspace),
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

app.post(
  "/api/workspace/portfolio/upload",
  (req, res, next) => {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    upload.single("image")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || "Upload failed" });
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!req.session.profile || !req.session.googleTokens) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (!req.file) return res.status(400).json({ error: "No image uploaded" });
      const result = await addPortfolioImage(req.session.profile.email, req.session.googleTokens, {
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        originalName: req.file.originalname,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  },
);

// ---- Google Business Profile (reviews) setup ----
// Finds the artist's business on Google so we can generate their direct
// "write a review" link without the restricted Business Profile API.
app.get("/api/gmb/search", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!placesConfigured()) {
      return res.status(400).json({ error: "Google search isn't configured yet. Ask the admin to add a Maps API key." });
    }
    const query = typeof req.query.q === "string" ? req.query.q : "";
    const candidates = await findBusinessCandidates(query);
    res.json({ ok: true, candidates });
  } catch (error) {
    next(error);
  }
});

// Saves the chosen place's review link into the workspace config.
app.post("/api/gmb/select", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const placeId = typeof req.body?.placeId === "string" ? req.body.placeId.trim() : "";
    if (!placeId) return res.status(400).json({ error: "Pick your business from the list first." });

    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const googleReviewLink = buildGoogleReviewLink(placeId);
    const updated = await updateWorkspaceConfig(
      req.session.profile.email,
      { ...workspace.config, googleReviewLink },
      req.session.googleTokens,
    );
    res.json({ ok: true, googleReviewLink, workspace: updated });
  } catch (error) {
    next(error);
  }
});

// Lists the available document design themes for the picker.
app.get("/api/document-templates", (req, res) => {
  if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
  res.json({ ok: true, templates: DOCUMENT_THEME_LIST });
});

app.post("/api/workspace/protect-sheet", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const protect = req.body?.protect === true || req.body?.protect === "true";
    const workspace = await setSheetProtection(req.session.profile.email, protect, req.session.googleTokens);
    res.json({ ok: true, workspace });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspace/recover-sheet", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await recoverSheet(req.session.profile, req.session.googleTokens);
    res.json({ ok: true, workspace });
  } catch (error) {
    next(error);
  }
});

app.get("/api/team", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const artists = await listArtists(req.session.profile.email, req.session.googleTokens);
    res.json({ ok: true, artists });
  } catch (error) {
    next(error);
  }
});

app.post("/api/team", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      return res.status(400).json({ error: "Artist name is required" });
    }
    // The price multiplier feeds directly into quote math — reject anything
    // that isn't a sane positive number so a typo can't corrupt pricing.
    let priceMultiplier: number | undefined;
    if (req.body.priceMultiplier !== undefined && req.body.priceMultiplier !== "") {
      const parsedMultiplier = Number(req.body.priceMultiplier);
      if (!Number.isFinite(parsedMultiplier) || parsedMultiplier <= 0 || parsedMultiplier > 10) {
        return res.status(400).json({ error: "Price multiplier must be a number between 0 and 10." });
      }
      priceMultiplier = parsedMultiplier;
    }
    const artist = await upsertArtist(req.session.profile.email, req.session.googleTokens, {
      artistId: typeof req.body.artistId === "string" ? req.body.artistId : undefined,
      name,
      whatsApp: req.body.whatsApp,
      email: req.body.email,
      city: req.body.city,
      skillLevel: req.body.skillLevel,
      priceMultiplier,
      luxuryEligible: req.body.luxuryEligible,
      primaryCalendarId: req.body.primaryCalendarId,
      active: req.body.active,
    });
    res.json({ ok: true, artist });
  } catch (error) {
    next(error);
  }
});

app.post("/api/team/:artistId/deactivate", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const artist = await deactivateArtist(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.artistId,
    );
    res.json({ ok: true, artist });
  } catch (error) {
    next(error);
  }
});

app.get("/api/conversations", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const interactions = await listInteractions(req.session.profile.email, req.session.googleTokens);
    res.json({ ok: true, interactions });
  } catch (error) {
    next(error);
  }
});

app.post("/api/leads/:leadId/assign", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const assignedArtist = typeof req.body?.assignedArtist === "string" ? req.body.assignedArtist : "";
    const updated = await updateLeadRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.leadId,
      (current) => ({ ...current, assignedArtist }),
    );
    res.json({ ok: true, lead: updated });
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

app.post("/api/leads/:leadId/send-quote", async (req, res, next) => {
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

    if (!["YES", "EDIT"].includes(lead.ownerDecision)) {
      return res.status(400).json({ error: "Approve the lead before sending a quote." });
    }

    const channelContext = resolveLeadMessagingContext(workspace, lead);
    if (!channelContext) {
      return res.status(400).json({ error: "Lead does not have a connected messaging channel." });
    }

    let currentLead = lead;
    if (!currentLead.quoteUrl) {
      const quote = await generateQuoteDocument(workspace, req.session.googleTokens, currentLead);
      currentLead = await updateLeadRecord(
        req.session.profile.email,
        req.session.googleTokens,
        req.params.leadId,
        (existing) => ({
          ...existing,
          quoteUrl: quote.fileUrl,
          quoteGeneratedAt: new Date().toISOString(),
          lastContactedAt: new Date().toISOString(),
        }),
      );
    }

    const message = buildQuoteShareMessage(workspace, currentLead);
    await sendBusinessMessage({
      workspace,
      connection: channelContext.connection,
      channel: channelContext.channel,
      actorId: channelContext.actorId,
      message,
      template: {
        name: workspace.config.quoteTemplate,
        lang: workspace.config.quoteTemplateLang,
        params: [currentLead.clientName, currentLead.eventType, currentLead.eventDate, currentLead.quoteUrl || ""],
      },
    });

    currentLead = await updateLeadRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.leadId,
      (existing) => ({
        ...existing,
        suggestedReply: message,
        status: existing.status === "New" ? "Awaiting Client" : existing.status,
        lastContactedAt: new Date().toISOString(),
      }),
    );

    await logInteractionForWorkspace(req.session.profile.email, req.session.googleTokens, {
      leadId: currentLead.leadId,
      direction: "Outbound",
      channel: channelContext.channel,
      actor: channelContext.actorId,
      message,
      aiSummary: "Quote shared with client",
    });

    await appendFollowUpLog(req.session.profile.email, req.session.googleTokens, {
      leadId: currentLead.leadId,
      type: "Quote Shared",
      channel: channelContext.channel,
      messagePreview: message,
      status: "Sent",
    });

    res.json({ ok: true, lead: currentLead });
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

app.post("/api/bookings/:bookingId/send-invoice", async (req, res, next) => {
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

    const channelContext = resolveLeadMessagingContext(workspace, lead);
    if (!channelContext) {
      return res.status(400).json({ error: "Booking client does not have a connected messaging channel." });
    }

    let currentBooking = booking;
    if (!currentBooking.invoiceUrl) {
      const invoice = await generateInvoiceDocument(workspace, req.session.googleTokens, currentBooking);
      currentBooking = await updateBookingRecord(
        req.session.profile.email,
        req.session.googleTokens,
        req.params.bookingId,
        (existing) => ({
          ...existing,
          invoiceUrl: invoice.fileUrl,
          invoiceGeneratedAt: new Date().toISOString(),
        }),
      );
    }

    const message = buildInvoiceShareMessage(workspace, currentBooking);
    await sendBusinessMessage({
      workspace,
      connection: channelContext.connection,
      channel: channelContext.channel,
      actorId: channelContext.actorId,
      message,
      template: {
        name: workspace.config.invoiceTemplate,
        lang: workspace.config.invoiceTemplateLang,
        params: [currentBooking.clientName, currentBooking.eventType, currentBooking.eventDate, currentBooking.invoiceUrl || ""],
      },
    });

    await logInteractionForWorkspace(req.session.profile.email, req.session.googleTokens, {
      leadId: lead.leadId,
      direction: "Outbound",
      channel: channelContext.channel,
      actor: channelContext.actorId,
      message,
      aiSummary: "Invoice shared with client",
    });

    await appendFollowUpLog(req.session.profile.email, req.session.googleTokens, {
      leadId: lead.leadId,
      type: "Invoice Shared",
      channel: channelContext.channel,
      messagePreview: message,
      status: "Sent",
    });

    res.json({ ok: true, booking: currentBooking });
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

    await logInteractionForWorkspace(req.session.profile.email, req.session.googleTokens, {
      leadId: lead.leadId,
      direction: "Outbound",
      channel: "Leegality",
      actor: booking.bookingId,
      message: `Contract create request sent to Leegality for booking ${booking.bookingId}`,
      aiSummary: `Leegality create sent${contract.documentId ? ` (documentId ${contract.documentId})` : ""}`,
    });

    res.json({ ok: true, booking: updatedBooking, contract });
  } catch (error) {
    next(error);
  }
});

app.post("/api/bookings/:bookingId/send-contract", async (req, res, next) => {
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

    const channelContext = resolveLeadMessagingContext(workspace, lead);
    if (!channelContext) {
      return res.status(400).json({ error: "Booking client does not have a connected messaging channel." });
    }

    let currentBooking = booking;
    if (!currentBooking.contractUrl && currentBooking.contractStatus !== "Signed") {
      const contract = await createLeegalityContract(workspace, lead, currentBooking);
      currentBooking = await updateBookingRecord(
        req.session.profile.email,
        req.session.googleTokens,
        req.params.bookingId,
        (existing) => ({
          ...existing,
          contractUrl: contract.contractUrl || existing.contractUrl,
          contractStatus: contract.contractStatus || "Sent",
          contractSentAt: existing.contractSentAt || new Date().toISOString(),
        }),
      );
    }

    const message = buildContractShareMessage(workspace, currentBooking);
    await sendBusinessMessage({
      workspace,
      connection: channelContext.connection,
      channel: channelContext.channel,
      actorId: channelContext.actorId,
      message,
      template: {
        name: workspace.config.contractTemplate,
        lang: workspace.config.contractTemplateLang,
        params: [currentBooking.clientName, currentBooking.eventType, currentBooking.eventDate, currentBooking.contractUrl || ""],
      },
    });

    await logInteractionForWorkspace(req.session.profile.email, req.session.googleTokens, {
      leadId: lead.leadId,
      direction: "Outbound",
      channel: channelContext.channel,
      actor: channelContext.actorId,
      message,
      aiSummary: "Contract shared with client",
    });

    await appendFollowUpLog(req.session.profile.email, req.session.googleTokens, {
      leadId: lead.leadId,
      type: "Contract Shared",
      channel: channelContext.channel,
      messagePreview: message,
      status: "Sent",
    });

    res.json({ ok: true, booking: currentBooking });
  } catch (error) {
    next(error);
  }
});

app.post("/api/bookings/:bookingId/contract/sync", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const booking = await getBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
    );
    if (!booking) {
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

    const details = await checkLeegalityDocumentDetails(booking.bookingId);
    const updatedBooking = await updateBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
      (current) => ({
        ...current,
        contractUrl: details.contractUrl || current.contractUrl,
        contractStatus: details.contractStatus || current.contractStatus,
        contractSentAt: current.contractSentAt || new Date().toISOString(),
      }),
    );

    await logInteractionForWorkspace(req.session.profile.email, req.session.googleTokens, {
      leadId: lead.leadId,
      direction: "Inbound",
      channel: "Leegality",
      actor: booking.bookingId,
      message: `Manual contract sync completed for booking ${booking.bookingId}`,
      aiSummary: `Details API status: ${updatedBooking.contractStatus}`,
    });

    res.json({ ok: true, booking: updatedBooking, details });
  } catch (error) {
    next(error);
  }
});

app.post("/api/bookings/:bookingId/send-review", async (req, res, next) => {
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
    if (!workspace.config.googleReviewLink) {
      return res.status(400).json({ error: "Add a Google review link in Owner Configuration first." });
    }

    const lead = await getLeadRecord(
      req.session.profile.email,
      req.session.googleTokens,
      booking.leadId,
    );
    if (!lead) {
      return res.status(404).json({ error: "Lead not found for booking" });
    }
    const channelContext = resolveLeadMessagingContext(workspace, lead);
    if (!channelContext) {
      return res.status(400).json({ error: "Booking client does not have a connected messaging channel." });
    }

    const message = buildReviewRequestMessage(workspace, booking);
    await sendBusinessMessage({
      workspace,
      connection: channelContext.connection,
      channel: channelContext.channel,
      actorId: channelContext.actorId,
      message,
      template: {
        name: workspace.config.reviewTemplate,
        lang: workspace.config.reviewTemplateLang,
        params: [booking.clientName, workspace.config.businessName || workspace.name, workspace.config.googleReviewLink || ""],
      },
    });

    await logInteractionForWorkspace(req.session.profile.email, req.session.googleTokens, {
      leadId: lead.leadId,
      direction: "Outbound",
      channel: channelContext.channel,
      actor: channelContext.actorId,
      message,
      aiSummary: "Review request sent",
    });

    await upsertReviewRequest(req.session.profile.email, req.session.googleTokens, {
      leadId: lead.leadId,
      clientName: booking.clientName,
      eventDate: booking.eventDate,
      type: "request",
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/reviews", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const { sheets } = createGoogleClients(req.session.googleTokens);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.reviews}!A2:I`,
    });
    const rows = (response.data.values ?? []).filter((row) => row[0]);
    const reviews = rows.map((row) => ({
      reviewId: row[0] ?? "",
      leadId: row[1] ?? "",
      clientName: row[2] ?? "",
      eventDate: row[3] ?? "",
      requestSentAt: row[4] ?? "",
      reminderSentAt: row[5] ?? "",
      reviewLinkClicked: row[6] ?? "No",
      reviewConfirmed: row[7] ?? "No",
      notes: row[8] ?? "",
    }));
    res.json({ ok: true, reviews });
  } catch (error) {
    next(error);
  }
});

app.post("/api/reviews/:reviewId/confirm", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const { sheets } = createGoogleClients(req.session.googleTokens);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.reviews}!A2:I`,
    });
    const rows = response.data.values ?? [];
    const index = rows.findIndex((row) => row[0] === req.params.reviewId);
    if (index < 0) return res.status(404).json({ error: "Review not found" });

    const row = [...rows[index]];
    row[7] = "Yes";
    await sheets.spreadsheets.values.update({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.reviews}!A${index + 2}:I${index + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/analytics", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const data = await getDashboardData(req.session.profile.email, req.session.googleTokens);
    const leads = data.leads;
    const bookings = data.bookings;

    const now = new Date();
    const months: { key: string; label: string }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        label: d.toLocaleString("en-IN", { month: "short", year: "2-digit" }),
      });
    }

    const revenueByMonth = Object.fromEntries(months.map((m) => [m.key, 0]));
    const bookingsByMonth = Object.fromEntries(months.map((m) => [m.key, 0]));
    const leadsByMonth = Object.fromEntries(months.map((m) => [m.key, 0]));

    for (const b of bookings) {
      const key = (b.bookedAt || "").slice(0, 7);
      if (key in revenueByMonth) revenueByMonth[key] += Number(b.finalPrice) || 0;
      if (key in bookingsByMonth) bookingsByMonth[key] += 1;
    }
    for (const l of leads) {
      const key = (l.createdAt || "").slice(0, 7);
      if (key in leadsByMonth) leadsByMonth[key] += 1;
    }

    const sourceCount: Record<string, number> = {};
    for (const l of leads) {
      const s = l.source || "Unknown";
      sourceCount[s] = (sourceCount[s] || 0) + 1;
    }

    const eventTypeRevenue: Record<string, number> = {};
    for (const b of bookings) {
      const t = b.eventType || "Unknown";
      eventTypeRevenue[t] = (eventTypeRevenue[t] || 0) + (Number(b.finalPrice) || 0);
    }

    const totalRevenue = bookings.reduce((s, b) => s + (Number(b.finalPrice) || 0), 0);
    const totalBookings = bookings.length;
    const totalLeads = leads.length;
    const conversionRate = totalLeads > 0 ? Math.round((totalBookings / totalLeads) * 100) : 0;
    const avgBookingValue = totalBookings > 0 ? Math.round(totalRevenue / totalBookings) : 0;

    res.json({
      ok: true,
      summary: { totalRevenue, totalBookings, totalLeads, conversionRate, avgBookingValue },
      months: months.map((m) => ({
        ...m,
        revenue: revenueByMonth[m.key],
        bookings: bookingsByMonth[m.key],
        leads: leadsByMonth[m.key],
      })),
      bySource: Object.entries(sourceCount).sort((a, b) => b[1] - a[1]).map(([source, count]) => ({ source, count })),
      byEventType: Object.entries(eventTypeRevenue).sort((a, b) => b[1] - a[1]).map(([type, revenue]) => ({ type, revenue })),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/bookings/:bookingId/send-collection", async (req, res, next) => {
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
    const channelContext = resolveLeadMessagingContext(workspace, lead);
    if (!channelContext) {
      return res.status(400).json({ error: "Booking client does not have a connected messaging channel." });
    }

    const kind = req.body?.kind === "balance" ? "balance" : "advance";
    const message = buildCollectionReminderMessage(workspace, booking, kind);
    const dueAmount = kind === "balance" ? booking.balanceDue : booking.advanceAmount;
    await sendBusinessMessage({
      workspace,
      connection: channelContext.connection,
      channel: channelContext.channel,
      actorId: channelContext.actorId,
      message,
      template: {
        name: workspace.config.collectionTemplate,
        lang: workspace.config.collectionTemplateLang,
        params: [booking.clientName, kind, String(dueAmount ?? ""), booking.eventDate],
      },
    });

    await logInteractionForWorkspace(req.session.profile.email, req.session.googleTokens, {
      leadId: lead.leadId,
      direction: "Outbound",
      channel: channelContext.channel,
      actor: channelContext.actorId,
      message,
      aiSummary: `${kind === "balance" ? "Balance" : "Advance"} reminder sent`,
    });

    await appendFollowUpLog(req.session.profile.email, req.session.googleTokens, {
      leadId: lead.leadId,
      type: kind === "balance" ? "Balance Reminder" : "Advance Reminder",
      channel: channelContext.channel,
      messagePreview: message,
      status: "Sent",
    });

    res.json({ ok: true });
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
    if (!appConfig.watiWebhookSecret || parsed.secret !== appConfig.watiWebhookSecret) {
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
    if (!appConfig.manychatWebhookSecret || parsed.secret !== appConfig.manychatWebhookSecret) {
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
    const signatureValid = verifyMetaWebhookSignature(
      (req as express.Request & { rawBody?: Buffer }).rawBody,
      typeof req.headers["x-hub-signature-256"] === "string"
        ? req.headers["x-hub-signature-256"]
        : undefined,
    );
    if (!signatureValid) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

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
              eventTime: current.eventTime || parsedLead.eventTime,
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
            eventTime: parsedLead.eventTime,
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
              eventTime: current.eventTime || parsedLead.eventTime,
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
            eventTime: parsedLead.eventTime,
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
            ownerDecision: lead.ownerDecision,
            paymentStatus: lead.paymentStatus,
            quoteUrl: lead.quoteUrl,
            holdExpiresAt: lead.holdExpiresAt,
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
    const secretOk = verifyLeegalityWebhookRequest(req.body, [
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

    await logInteractionForWorkspace(resolved.workspace.email, resolved.tokens, {
      leadId: resolved.booking.leadId,
      direction: "Inbound",
      channel: "Leegality",
      actor: updatedBooking.bookingId,
      message: `Leegality webhook received for booking ${updatedBooking.bookingId}`,
      aiSummary: `Webhook status: ${updatedBooking.contractStatus}${event.documentId ? ` (documentId ${event.documentId})` : ""}`,
    });

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

app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Always log the full error server-side for debugging (structured + captured).
  captureException(error, { method: req.method, path: req.path });

  // Validation errors are safe to surface and help the user fix their input.
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const field = first?.path?.join(".");
    return res.status(400).json({
      error: field ? `${field}: ${first.message}` : first?.message || "Invalid request data.",
    });
  }

  // Known, intentionally-thrown business errors carry user-safe messages.
  // Anything else is treated as an internal fault and kept generic.
  const message = error instanceof Error ? error.message : "";
  const isUserSafe = Boolean(message) && message.length < 200 && !/\b(at |\/home\/|\/usr\/|node_modules|ECONN|ETIMEDOUT|ENOTFOUND)\b/.test(message);
  res.status(500).json({ error: isUserSafe ? message : "Something went wrong on our end. Please try again." });
});

// Fail closed: refuse to boot a deployed environment without a database and a
// token-encryption key, rather than silently using ephemeral/plaintext storage.
assertDeploymentConfig();

app.listen(appConfig.port, () => {
  logger.info("1Glam app listening", {
    baseUrl: appConfig.baseUrl,
    env: appConfig.appEnv,
    persistence: appConfig.databaseUrl ? "postgres" : "file",
    tokenEncryption: encryptionEnabled() ? "on" : "off",
  });
  startReminderScheduler();
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

function resolveLeadMessagingContext(workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceByEmail>>>, lead: LeadRecord) {
  if (lead.source === "WhatsApp" && lead.clientWhatsApp && workspace.metaConnections?.whatsapp?.status === "connected") {
    return {
      channel: "WhatsApp" as const,
      connection: workspace.metaConnections.whatsapp,
      actorId: lead.clientWhatsApp,
    };
  }

  if (lead.clientInstagram && workspace.metaConnections?.instagram?.status === "connected") {
    return {
      channel: "Instagram" as const,
      connection: workspace.metaConnections.instagram,
      actorId: lead.clientInstagram,
    };
  }

  if (lead.clientWhatsApp && workspace.metaConnections?.whatsapp?.status === "connected") {
    return {
      channel: "WhatsApp" as const,
      connection: workspace.metaConnections.whatsapp,
      actorId: lead.clientWhatsApp,
    };
  }

  return null;
}

async function appendFollowUpLog(
  workspaceEmail: string,
  tokens: Credentials,
  input: {
    leadId: string;
    type: string;
    channel: "WhatsApp" | "Instagram";
    messagePreview: string;
    status: string;
  },
) {
  const workspace = await getWorkspaceByEmail(workspaceEmail);
  if (!workspace) {
    throw new Error("Workspace not found");
  }

  const { sheets } = createGoogleClients(tokens);
  await sheets.spreadsheets.values.append({
    spreadsheetId: workspace.spreadsheetId,
    range: `${sheetNames.followUps}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        `FU_${nanoid(10)}`,
        input.leadId,
        new Date().toISOString(),
        new Date().toISOString(),
        input.type,
        input.channel,
        input.messagePreview.slice(0, 250),
        input.status,
      ]],
    },
  });
}

async function upsertReviewRequest(
  workspaceEmail: string,
  tokens: Credentials,
  input: {
    leadId: string;
    clientName: string;
    eventDate: string;
    type: "request" | "reminder";
  },
) {
  const workspace = await getWorkspaceByEmail(workspaceEmail);
  if (!workspace) {
    throw new Error("Workspace not found");
  }

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
    row[8] = row[8] || "Sent from 1Glam";
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
        "Sent from 1Glam",
      ]],
    },
  });
}

function buildQuoteShareMessage(workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceByEmail>>>, lead: LeadRecord) {
  const quotedAmount = lead.finalApprovedPrice || lead.initialAiPrice;
  const holdLine = lead.holdExpiresAt
    ? `I can tentatively hold the date until ${formatFriendlyDateTime(lead.holdExpiresAt)}. `
    : "";
  return [
    `Hi ${lead.clientName || "love"}, your quote for the ${lead.eventType.toLowerCase()} booking is ready.`,
    holdLine.trim(),
    `Amount: ${formatMoney(quotedAmount)}.`,
    lead.quoteUrl ? `Quote link: ${lead.quoteUrl}` : "",
    workspace.config.paymentTerms ? `Payment terms: ${workspace.config.paymentTerms}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function buildInvoiceShareMessage(workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceByEmail>>>, booking: BookingRecord) {
  const label = booking.paymentStatus === "Advance Due" ? "advance invoice" : "invoice";
  const amount =
    booking.paymentStatus === "Advance Due"
      ? booking.advanceAmount
      : booking.balanceDue > 0
        ? booking.balanceDue
        : booking.finalPrice;
  return [
    `Hi ${booking.clientName || "love"}, your ${label} is ready.`,
    `Amount due: ${formatMoney(amount)}.`,
    booking.invoiceUrl ? `Invoice link: ${booking.invoiceUrl}` : "",
    workspace.config.paymentTerms ? `Payment terms: ${workspace.config.paymentTerms}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function buildContractShareMessage(_workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceByEmail>>>, booking: BookingRecord) {
  if (booking.contractUrl) {
    return `Hi ${booking.clientName || "love"}, your booking agreement is ready here: ${booking.contractUrl}. Please review and sign it when convenient.`;
  }

  return `Hi ${booking.clientName || "love"}, your booking agreement has been initiated through Leegality. Please check the contract link shared with you there and sign it when convenient.`;
}

function buildReviewRequestMessage(workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceByEmail>>>, booking: BookingRecord) {
  return [
    `Hi ${booking.clientName || "love"}, it was lovely being part of your ${booking.eventType.toLowerCase()} booking.`,
    "If you have a minute, I’d be so grateful for a short review.",
    workspace.config.googleReviewLink,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function buildCollectionReminderMessage(
  workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceByEmail>>>,
  booking: BookingRecord,
  kind: "advance" | "balance",
) {
  const amount = kind === "balance" ? booking.balanceDue : booking.advanceAmount;
  const label = kind === "balance" ? "balance" : "advance";
  const payUrl = `${appConfig.baseUrl}/pay/${workspace.workspaceId}/${booking.leadId}`;
  return [
    `Hi ${booking.clientName || "love"}, sharing a gentle reminder for the ${label} payment for your ${booking.eventType.toLowerCase()} booking.`,
    `Amount due: ${formatMoney(amount)}.`,
    booking.invoiceUrl ? `Invoice: ${booking.invoiceUrl}` : "",
    workspace.config.upiId ? `Pay here: ${payUrl}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function formatFriendlyDateTime(value: string) {
  try {
    return new Date(value).toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return value;
  }
}

function formatMoney(value: number) {
  return `₹${Number(value || 0).toLocaleString("en-IN")}`;
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
