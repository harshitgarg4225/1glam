import express from "express";
import session from "express-session";
import helmet from "helmet";
import connectPgSimple from "connect-pg-simple";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { nanoid } from "nanoid";
import type { Credentials } from "google-auth-library";
import { appConfig, assertDeploymentConfig } from "./config.js";
import { createLeadSchema, editLeadDetailsSchema, ownerDecisionSchema, paymentStatusSchema, publicBookingSchema, quickBookingSchema, recordPaymentSchema } from "./api-schema.js";
import { askBusinessAssistant, buildAssistantSnapshot } from "./services/assistant.js";
import { workspaceConfigSchema } from "./schema.js";
import {
  applyOwnerDecision,
  cancelBooking,
  completeBooking,
  confirmLeadBooking,
  createLeadForWorkspace,
  findLatestLeadByActor,
  getBookingRecord,
  getLeadRecord,
  getDashboardData,
  recordBookingPayment,
  rescheduleBooking,
  updateBookingRecord,
  type BookingRecord,
  type LeadRecord,
  updateLeadRecord,
  updatePaymentStatus,
} from "./services/booking.js";
import { getWorkspaceCredentials } from "./services/auth-store.js";
import { buildOutboundReplyPayload, normalizeManychatPayload, normalizeWatiPayload } from "./services/channel-adapters.js";
import { closePool, findWorkspaceByMetaAsset, findWorkspaceByMetaUserId, findWorkspaceByWorkspaceId, listWorkspaces, markWebhookEventProcessed, pingDatabase, saveWorkspace } from "./services/database.js";
import {
  createOrderWithKeys,
  createRazorpayOrder,
  fetchOrderWithKeys,
  fetchRazorpayOrder,
  razorpayConfigured,
  razorpayTestMode,
  verifyCheckoutSignature,
  verifyCheckoutSignatureWithSecret,
  verifyWebhookSignature,
} from "./services/razorpay.js";
import { CREDIT_PACKS, findPack, getWallet, creditWallet, meterUsage, isLowBalance, canAfford } from "./services/wallet.js";
import { createGoogleClients, exchangeCodeForTokens, fetchGoogleProfile, getAuthUrl } from "./services/google.js";
import {
  extractInboundTextFromMetaWebhook,
  extractMetaMessageId,
  ingestNormalizedLead,
  listInteractions,
  logInteractionForWorkspace,
  parseInstagramLeadSignalsFromMessage,
  parseWhatsAppLeadSignalsFromMessage,
} from "./services/integrations.js";
import { deactivateArtist, listArtists, upsertArtist } from "./services/team.js";
import { createPublicBookingRequest, getPublicBusinessProfile, getPublicPaymentDetails, submitPaymentScreenshot } from "./services/public-booking.js";
import { buildGoogleReviewLink, findBusinessCandidates, placesConfigured, estimateDistance } from "./services/places.js";
import { getGmbStatus, draftReviewReplies, listGmbReviews, postGmbReply } from "./services/gmb.js";
import { replyIsSafeToAutoSend } from "./services/auto-reply.js";
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
import { generateConversationReply, deriveToneProfile } from "./services/grok.js";
import { sendChannelMessage, sendBusinessMessage, sendWhatsAppTemplate } from "./services/messaging.js";
import { startReminderScheduler } from "./services/reminders.js";
import { logger, captureException } from "./services/logger.js";
import { encryptionEnabled } from "./services/crypto.js";
import {
  generateInvoiceDocument,
  generateQuoteDocument,
  buildInvoicePdfBytes,
  buildQuotePdfBytes,
  generateContractPdfBytes,
  nextDocumentNumber,
  parseDocumentAdjustments,
} from "./services/documents.js";
import { buildPublicDocumentUrl, isDocumentType, signDocumentToken, verifyDocumentToken } from "./services/document-links.js";
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

// Public contact for privacy/data requests, shown on the legal pages. Override
// with LEGAL_CONTACT_EMAIL once a branded support inbox exists.
const LEGAL_CONTACT_EMAIL = process.env.LEGAL_CONTACT_EMAIL || "harshitgarg4225@gmail.com";

// Security headers. CSP is tuned to the app's real dependencies: it serves
// inline scripts/styles (so 'unsafe-inline' is required), loads Razorpay
// Checkout, embeds the Google Calendar iframe and the same-origin booking-page
// preview, and renders arbitrary https logo/cover images and QR codes. HSTS,
// nosniff, frame-ancestors (anti-clickjacking) and referrer policy come from
// helmet's defaults.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'", "https://checkout.razorpay.com"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "https:"],
        "font-src": ["'self'", "data:"],
        "connect-src": ["'self'", "https://api.razorpay.com", "https://lumberjack.razorpay.com"],
        "frame-src": [
          "'self'",
          "https://calendar.google.com",
          "https://api.razorpay.com",
          "https://*.razorpay.com",
        ],
        "frame-ancestors": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        // Let the browser upgrade any stray http subresource to https in prod.
        "upgrade-insecure-requests": appConfig.baseUrl.startsWith("https://") ? [] : null,
      },
    },
    // Booking-page links are shared cross-site (WhatsApp/IG); COEP would block
    // third-party images/embeds, so leave it off.
    crossOriginEmbedderPolicy: false,
    // Allow the booking page's images/QR to be loaded by link-preview crawlers.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// Per-request access log with a correlation id. Logs once on response finish so
// each line carries method, path, status and latency — enough to trace a single
// request through the aggregator. Health checks are skipped to avoid noise.
app.use((req, res, next) => {
  const requestId = (req.headers["x-request-id"] as string) || nanoid(10);
  res.setHeader("x-request-id", requestId);
  (req as express.Request & { requestId?: string }).requestId = requestId;

  if (req.path === "/api/health") return next();

  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level]("http_request", {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
    });
  });
  next();
});

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

// Constant-time secret comparison for shared-secret webhooks (WATI/Manychat),
// so a plain `!==` can't be used as a timing oracle to recover the secret.
function secretsMatch(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Throttle unauthenticated public endpoints to curb abuse / DoS.
const publicWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a minute and try again." },
});

// Throttle authenticated API endpoints — 300 req/min per IP covers normal
// single-user sessions with headroom for burst, while blocking credential
// stuffing and naive scrapers. Webhooks and public routes are excluded below.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
  skip: (req) =>
    req.path.startsWith("/webhooks/") ||
    req.path.startsWith("/api/public/") ||
    req.path === "/api/health",
});
app.use("/api", apiLimiter);

app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
const PgSession = connectPgSimple(session);
const sessionStore = appConfig.databaseUrl
  ? new PgSession({
      conString: appConfig.databaseUrl,
      tableName: "user_sessions",
      createTableIfMissing: true,
    })
  : undefined;

if (!sessionStore && appConfig.isDeployed) {
  // Without a persistent store, express-session falls back to MemoryStore, which
  // leaks memory and drops every session on restart/scale-out. In production this
  // is already fatal via assertDeploymentConfig (DATABASE_URL required); this warns
  // for staging so it never goes unnoticed.
  logger.warn("session_store_memory_fallback", {
    message: "No DATABASE_URL — using in-memory session store (not safe for multi-instance or restarts).",
  });
}

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
      path: "/",
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

// Defense-in-depth auth guard for the whole /api surface. Individual handlers
// still do their own (and often stricter, e.g. googleTokens) checks; this is a
// backstop so a newly-added authenticated endpoint can never accidentally ship
// without protection. Only the genuinely public endpoints are allowlisted.
// /api/session is intentionally public: it reports authenticated:false for
// logged-out visitors so the landing page can render without bouncing them (and
// Google's OAuth-verification crawler) to a login screen.
const PUBLIC_API_PATHS = new Set(["/api/health", "/api/session", "/api/document-templates", "/api/logout"]);
app.use((req, res, next) => {
  if (req.path !== "/api" && !req.path.startsWith("/api/")) return next();
  if (PUBLIC_API_PATHS.has(req.path) || req.path.startsWith("/api/public/")) return next();
  if (!req.session.profile) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/api/health", async (_req, res) => {
  const checks: Record<string, string> = {
    app: "ok",
    db: "unconfigured",
  };

  if (appConfig.databaseUrl) {
    try {
      await pingDatabase(2000);
      checks.db = "ok";
    } catch {
      checks.db = "error";
    }
  }

  const allOk = Object.values(checks).every((v) => v === "ok" || v === "unconfigured");
  res.status(allOk ? 200 : 503).json({
    ok: allOk,
    uptimeSeconds: Math.floor(process.uptime()),
    encryptionEnabled: encryptionEnabled(),
    oauthConfigured: Boolean(appConfig.googleClientId && appConfig.googleClientSecret),
    checks,
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
    if (error instanceof Error && error.message === "Booking page not found") {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

app.get("/pay/:workspaceId/:leadId", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "pay.html"));
});

// Built-in contract signing page (no Leegality needed). The link carries the
// same HMAC token as the public contract PDF, so only the client who received
// the contract can open or sign it.
app.get("/sign/:workspaceId/:bookingId", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "sign.html"));
});

// ─── Online advance payment (client pays into the OWNER's Razorpay account,
// payment auto-confirmed — no screenshot, no manual marking) ───
app.post("/api/public/:workspaceId/payment/:leadId/order", publicWriteLimiter, async (req, res, next) => {
  try {
    const workspaceId = String(req.params.workspaceId ?? "");
    const leadId = String(req.params.leadId ?? "");
    const workspace = await findWorkspaceByWorkspaceId(workspaceId);
    if (!workspace) return res.status(404).json({ error: "Payment details not found" });
    const { razorpayKeyId, razorpayKeySecret } = workspace.config;
    if (!razorpayKeyId || !razorpayKeySecret) {
      return res.status(400).json({ error: "Online payment isn't enabled for this business." });
    }
    const details = await getPublicPaymentDetails(workspaceId, leadId);
    if (!details) return res.status(404).json({ error: "Payment details not found" });
    if (["Advance Paid", "Paid in Full"].includes(details.paymentStatus)) {
      return res.status(409).json({ error: "This advance has already been paid." });
    }
    if (!(details.advanceAmount > 0)) {
      return res.status(400).json({ error: "There's no advance due on this booking." });
    }

    const order = await createOrderWithKeys(
      { keyId: razorpayKeyId, keySecret: razorpayKeySecret },
      {
        amountInr: details.advanceAmount,
        receipt: leadId.slice(0, 40),
        notes: { workspaceId, leadId, purpose: "advance" },
      },
    );
    res.json({
      ok: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: razorpayKeyId,
      businessName: details.businessName,
      clientName: details.clientName,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/public/:workspaceId/payment/:leadId/verify", publicWriteLimiter, async (req, res, next) => {
  try {
    const workspaceId = String(req.params.workspaceId ?? "");
    const leadId = String(req.params.leadId ?? "");
    const orderId = typeof req.body?.orderId === "string" ? req.body.orderId : "";
    const paymentId = typeof req.body?.paymentId === "string" ? req.body.paymentId : "";
    const signature = typeof req.body?.signature === "string" ? req.body.signature : "";
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ error: "Missing payment confirmation fields." });
    }

    const workspace = await findWorkspaceByWorkspaceId(workspaceId);
    if (!workspace) return res.status(404).json({ error: "Payment details not found" });
    const { razorpayKeyId, razorpayKeySecret } = workspace.config;
    if (!razorpayKeyId || !razorpayKeySecret) {
      return res.status(400).json({ error: "Online payment isn't enabled for this business." });
    }

    if (!verifyCheckoutSignatureWithSecret(razorpayKeySecret, { orderId, paymentId, signature })) {
      return res.status(400).json({ error: "Payment signature didn't verify. If money was deducted it will be auto-refunded by Razorpay." });
    }
    // Trust the order's own notes (set server-side at creation), never the client.
    const order = await fetchOrderWithKeys({ keyId: razorpayKeyId, keySecret: razorpayKeySecret }, orderId);
    if (order.notes.leadId !== leadId || order.notes.workspaceId !== workspaceId || order.notes.purpose !== "advance") {
      return res.status(400).json({ error: "Payment doesn't match this booking." });
    }

    const tokens = await getWorkspaceCredentials(workspace.email);
    const lead = await getLeadRecord(workspace.email, tokens, leadId);
    if (!lead) return res.status(404).json({ error: "Booking not found" });
    // Idempotent: a retried verify (or webhook race) never double-processes.
    if (!["Advance Paid", "Paid in Full"].includes(lead.paymentStatus)) {
      await updatePaymentStatus(workspace.email, tokens, leadId, "Advance Paid");
      await logInteractionForWorkspace(workspace.email, tokens, {
        leadId,
        direction: "Inbound",
        channel: "WhatsApp",
        actor: lead.clientWhatsApp || leadId,
        message: `Advance paid online via Razorpay (payment ${paymentId})`,
        aiSummary: "Advance payment received and auto-confirmed via Razorpay",
      }).catch(() => {});
    }
    res.json({ ok: true, paymentStatus: "Advance Paid" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/public/contract/:workspaceId/:bookingId", async (req, res, next) => {
  try {
    const { workspaceId, bookingId } = req.params;
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    if (!verifyDocumentToken("contract", workspaceId, bookingId, sig)) {
      return res.status(404).json({ error: "Contract not found" });
    }
    const workspace = await findWorkspaceByWorkspaceId(workspaceId);
    if (!workspace || !workspace.googleTokens) {
      return res.status(404).json({ error: "Contract not found" });
    }
    const booking = await getBookingRecord(workspace.email, workspace.googleTokens, bookingId);
    if (!booking) return res.status(404).json({ error: "Contract not found" });
    if (booking.contractVoidedAt) return res.status(410).json({ error: "This contract has been voided." });

    res.json({
      ok: true,
      businessName: workspace.config.businessName || workspace.name,
      clientName: booking.clientName,
      eventType: booking.eventType,
      eventDate: booking.eventDate,
      eventTime: booking.eventTime,
      venue: booking.venue,
      finalPrice: booking.finalPrice,
      advanceAmount: booking.advanceAmount,
      signed: Boolean(booking.contractSignedAt),
      signedAt: booking.contractSignedAt,
      signerName: booking.contractSignerName,
      pdfUrl: buildPublicDocumentUrl("contract", workspaceId, bookingId),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/public/contract/:workspaceId/:bookingId/sign", publicWriteLimiter, async (req, res, next) => {
  try {
    const workspaceId = String(req.params.workspaceId ?? "");
    const bookingId = String(req.params.bookingId ?? "");
    const sig = typeof req.body?.sig === "string" ? req.body.sig : "";
    const signerName = typeof req.body?.signerName === "string" ? req.body.signerName.trim().slice(0, 120) : "";
    if (!verifyDocumentToken("contract", workspaceId, bookingId, sig)) {
      return res.status(404).json({ error: "Contract not found" });
    }
    if (signerName.length < 2) {
      return res.status(400).json({ error: "Please type your full name to sign." });
    }
    const workspace = await findWorkspaceByWorkspaceId(workspaceId);
    if (!workspace || !workspace.googleTokens) {
      return res.status(404).json({ error: "Contract not found" });
    }
    const booking = await getBookingRecord(workspace.email, workspace.googleTokens, bookingId);
    if (!booking) return res.status(404).json({ error: "Contract not found" });
    if (booking.contractVoidedAt) return res.status(410).json({ error: "This contract has been voided." });
    // Idempotent: a second tap (or a re-opened page) doesn't overwrite the record.
    if (booking.contractSignedAt) {
      return res.json({ ok: true, alreadySigned: true, signedAt: booking.contractSignedAt, signerName: booking.contractSignerName });
    }

    const signedAt = new Date().toISOString();
    const updated = await updateBookingRecord(workspace.email, workspace.googleTokens, bookingId, (current) => ({
      ...current,
      contractStatus: "Signed",
      contractSignedAt: signedAt,
      contractSignerName: signerName,
    }));

    await logInteractionForWorkspace(workspace.email, workspace.googleTokens, {
      leadId: booking.leadId,
      direction: "Inbound",
      channel: "WhatsApp",
      actor: booking.clientWhatsApp || bookingId,
      message: `Contract digitally accepted by ${signerName}`,
      aiSummary: "Client signed the booking contract via the secure signing link",
    }).catch(() => {});

    res.json({ ok: true, signedAt: updated.contractSignedAt, signerName: updated.contractSignerName });
  } catch (error) {
    next(error);
  }
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

// Dev-only login + seed. Triple-gated: only mounts when APP_ENV=development,
// NODE_ENV is not production, AND DEV_LOGIN=1. Used to drive the authenticated UI
// locally without Google OAuth. Never available in staging/production — the extra
// NODE_ENV check stops a misconfigured APP_ENV from exposing it in prod.
if (
  appConfig.appEnv === "development" &&
  process.env.NODE_ENV !== "production" &&
  process.env.DEV_LOGIN === "1"
) {
  app.get("/dev/login", async (req, res, next) => {
    try {
      const profile = { email: "aisha@glowbyaisha.test", name: "Aisha Khan" };
      const existing = await getWorkspaceByEmail(profile.email);
      if (!existing) {
        const { buildDefaultConfig } = await import("./defaults.js");
        const config = buildDefaultConfig(profile);
        config.businessName = "Glow by Aisha";
        config.city = "Mumbai";
        config.ownerWhatsApp = "+919812345678";
        config.instagramHandle = "glowbyaisha";
        await saveWorkspace({
          workspaceId: "dev-aisha",
          email: profile.email,
          name: profile.name,
          spreadsheetId: "dev-sheet",
          spreadsheetUrl: "https://example.com",
          spreadsheetName: "Glow by Aisha",
          confirmedCalendarId: "dev-confirmed",
          tentativeCalendarId: "dev-tentative",
          tentativeCalendarName: "Tentative",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          config,
        });
      }
      req.session.profile = profile;
      req.session.save((err) => {
        if (err) return next(err);
        res.type("text").send("dev login ok");
      });
    } catch (error) {
      next(error);
    }
  });
}

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
  // Never ship the Razorpay key secret to the browser; the frontend only needs
  // to know whether one is set.
  const safeConfig = {
    ...rest.config,
    razorpayKeySecret: rest.config?.razorpayKeySecret ? "********" : "",
  };
  const base = { ...rest, config: safeConfig } as WorkspaceRecord;
  if (!base.metaConnections) return base;
  const scrubbed: typeof base.metaConnections = {};
  for (const [ch, conn] of Object.entries(base.metaConnections)) {
    if (!conn) continue;
    const { accessToken: _at, pageAccessToken: _pt, ...safeConn } = conn;
    scrubbed[ch as MetaChannel] = safeConn as typeof conn;
  }
  return { ...base, metaConnections: scrubbed };
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
    // The browser only ever sees a masked Razorpay secret — a blank or masked
    // value on save means "keep what's stored", never "erase it".
    if (!parsed.razorpayKeySecret || parsed.razorpayKeySecret === "********") {
      const existing = await getWorkspaceByEmail(req.session.profile.email);
      parsed.razorpayKeySecret = existing?.config.razorpayKeySecret || "";
    }
    const workspace = await updateWorkspaceConfig(
      req.session.profile.email,
      parsed,
      req.session.googleTokens,
    );

    res.json({ ok: true, workspace: scrubWorkspaceTokens(workspace) });
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

// ---- GMB review agent ----
// Reports whether the agent is running in assisted (AI-draft) or auto (API)
// mode, so the UI can explain what's happening to the artist.
app.get("/api/gmb/status", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    res.json({ ok: true, status: getGmbStatus(workspace) });
  } catch (error) {
    next(error);
  }
});

// Drafts two AI reply options for a review in the artist's brand voice.
app.post("/api/gmb/draft-reply", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const reviewText = typeof req.body?.reviewText === "string" ? req.body.reviewText.trim() : "";
    if (reviewText.length < 3) {
      return res.status(400).json({ error: "Paste the review text first." });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const rating = Number(req.body?.rating);
    const result = await draftReviewReplies(workspace, {
      reviewText,
      rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
      reviewerName: typeof req.body?.reviewerName === "string" ? req.body.reviewerName.trim() : undefined,
      tone: typeof req.body?.tone === "string" ? req.body.tone : undefined,
    });
    // Only meter when real AI ran (the fallback has no API cost).
    let balanceCredits: number | null = null;
    if (appConfig.xaiApiKey) {
      balanceCredits = await meterUsage(req.session.profile.email, "aiReviewReply");
    }
    res.json({ ok: true, ...result, balanceCredits, lowBalance: balanceCredits !== null && isLowBalance(balanceCredits) });
  } catch (error) {
    next(error);
  }
});

// "Ask BusyDays": answers the owner's natural-language question about her own
// leads, bookings, and money from a compact snapshot of her live data.
app.post("/api/assistant/ask", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const question = typeof req.body?.question === "string" ? req.body.question.trim().slice(0, 500) : "";
    if (question.length < 3) {
      return res.status(400).json({ error: "Type a question first." });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const { leads, bookings } = await getDashboardData(req.session.profile.email, req.session.googleTokens);
    const snapshot = buildAssistantSnapshot(leads, bookings);
    const answer = await askBusinessAssistant({
      ownerName: workspace.config.ownerName,
      brandName: workspace.config.businessName,
      city: workspace.config.city,
      question,
      snapshot,
    });
    if (!answer) {
      return res.status(503).json({ error: "The AI assistant isn't available right now. Please try again in a moment." });
    }
    let balanceCredits: number | null = null;
    if (appConfig.xaiApiKey) {
      balanceCredits = await meterUsage(req.session.profile.email, "aiAssistant");
    }
    res.json({ ok: true, answer, balanceCredits, lowBalance: balanceCredits !== null && isLowBalance(balanceCredits) });
  } catch (error) {
    next(error);
  }
});

// Auto mode only: lists live reviews from Google Business Profile. Returns
// apiAvailable:false (so the UI shows assisted mode) until the project is
// allowlisted and the artist has granted the business.manage scope.
app.get("/api/gmb/reviews", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const result = await listGmbReviews(workspace, req.session.googleTokens);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Auto mode only: posts a reply to a live Google review.
app.post("/api/gmb/post-reply", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const reviewName = typeof req.body?.reviewName === "string" ? req.body.reviewName.trim() : "";
    const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
    if (!reviewName || !comment) {
      return res.status(400).json({ error: "A review and a reply are both required." });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const posted = await postGmbReply(workspace, req.session.googleTokens, reviewName, comment);
    if (!posted) {
      return res.status(400).json({ error: "Couldn't post automatically. Copy the reply and post it on Google instead." });
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ---- AI voice training ----
// Learns the owner's writing tone from sample messages they select/paste (e.g.
// 10 past client replies), distils a reusable style guide, and saves both the
// samples and the derived profile so every future AI reply sounds like them.
app.post("/api/ai/train-tone", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    // Accept either an array of messages or a single newline-separated blob.
    const raw = req.body?.samples;
    const samples: string[] = Array.isArray(raw)
      ? raw.map((s: unknown) => String(s))
      : String(raw || "").split(/\n{2,}|\r?\n/);
    const cleaned = samples.map((s) => s.trim()).filter(Boolean);
    if (cleaned.length < 3) {
      return res.status(400).json({ error: "Add at least 3 sample messages so the AI has enough to learn from." });
    }

    const profile = await deriveToneProfile({
      samples: cleaned,
      language: workspace.config.aiLanguage,
      signOff: workspace.config.aiSignOff,
    });
    if (!profile) {
      return res.status(502).json({ error: "Couldn't analyse your tone right now. Please try again in a moment." });
    }

    const updated = await updateWorkspaceConfig(
      req.session.profile.email,
      {
        ...workspace.config,
        aiToneSamples: cleaned.join("\n\n"),
        aiToneProfile: profile,
      },
      req.session.googleTokens,
    );

    res.json({ ok: true, toneProfile: updated.config.aiToneProfile });
  } catch (error) {
    next(error);
  }
});

// Sends a test customer message through the full AI reply pipeline using the
// owner's trained tone so they can verify how the AI sounds before going live.
app.post("/api/ai/preview-tone", async (req, res, next) => {
  try {
    const workspace = await getWorkspaceByEmail(req.session.profile!.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { customerMessage } = req.body as { customerMessage?: string };
    if (!customerMessage?.trim()) {
      return res.status(400).json({ error: "customerMessage is required" });
    }

    const result = await generateConversationReply({
      ownerName: workspace.config.ownerName,
      brandName: workspace.config.businessName,
      city: workspace.config.city,
      channel: "WhatsApp",
      clientName: "Test Client",
      leadStatus: "New Lead",
      eventType: "Bridal",
      eventDate: "TBD",
      locationText: workspace.config.city,
      latestMessage: customerMessage.trim(),
      language: workspace.config.aiLanguage,
      signOff: workspace.config.aiSignOff,
      toneProfile: workspace.config.aiToneProfile,
      servicesContext: workspace.config.aiServicesContext,
      personaName: workspace.config.aiPersonaName,
    });

    res.json({ reply: result.reply });
  } catch (error) {
    next(error);
  }
});

// ---- Credits wallet (Razorpay) ----
// Returns balance, recent ledger, and the buyable credit packs. Includes the
// Razorpay key id (publishable) so the browser can open Checkout.
app.get("/api/wallet", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const wallet = getWallet(workspace);
    res.json({
      ok: true,
      balanceCredits: wallet.balanceCredits,
      lowBalance: isLowBalance(wallet.balanceCredits),
      ledger: wallet.ledger.slice(0, 50),
      packs: CREDIT_PACKS,
      configured: razorpayConfigured(),
      testMode: razorpayTestMode(),
      enforced: appConfig.billingEnforced,
      keyId: appConfig.razorpayKeyId,
    });
  } catch (error) {
    next(error);
  }
});

// Creates a Razorpay order for the chosen credit pack. The pack details are
// stamped into the order notes so the verify + webhook paths know what to credit.
app.post("/api/wallet/order", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!razorpayConfigured()) {
      return res.status(400).json({ error: "Payments aren't set up yet. Ask the admin to add Razorpay keys." });
    }
    const pack = findPack(String(req.body?.packId || ""));
    if (!pack) return res.status(400).json({ error: "Pick a credit pack first." });

    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const order = await createRazorpayOrder({
      amountInr: pack.amountInr,
      receipt: `cr_${workspace.workspaceId}_${Date.now()}`.slice(0, 40),
      notes: {
        workspaceId: workspace.workspaceId,
        email: workspace.email,
        packId: pack.id,
        credits: String(pack.credits),
      },
    });

    res.json({
      ok: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: appConfig.razorpayKeyId,
      pack,
      prefill: {
        name: workspace.config.ownerName || workspace.config.businessName,
        email: workspace.email,
        contact: workspace.config.ownerWhatsApp || "",
      },
    });
  } catch (error) {
    next(error);
  }
});

// Confirms a Checkout payment: verifies the signature, then credits the wallet
// idempotently (the webhook is a backup for the same payment id).
app.post("/api/wallet/verify", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const orderId = String(req.body?.razorpay_order_id || "");
    const paymentId = String(req.body?.razorpay_payment_id || "");
    const signature = String(req.body?.razorpay_signature || "");
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ error: "Missing payment details." });
    }
    if (!verifyCheckoutSignature({ orderId, paymentId, signature })) {
      return res.status(400).json({ error: "Payment could not be verified." });
    }

    // SECURITY: never trust the pack the client claims to have bought. Re-read
    // the order from Razorpay and derive the pack from the notes WE set at
    // creation, validating the amount actually charged. Otherwise a client
    // could pay for a small pack and replay the signature with a bigger packId.
    const order = await fetchRazorpayOrder(orderId);
    const pack = findPack(String(order.notes?.packId || ""));
    if (!pack) {
      return res.status(400).json({ error: "Could not match this payment to a credit pack." });
    }
    if (order.amount !== Math.round(pack.amountInr * 100)) {
      return res.status(400).json({ error: "Payment amount mismatch." });
    }
    if (order.notes?.email && order.notes.email !== req.session.profile.email) {
      return res.status(403).json({ error: "This payment belongs to a different account." });
    }

    const result = await creditWallet(req.session.profile.email, {
      credits: pack.credits,
      reason: `${pack.label} pack top-up`,
      ref: paymentId,
      amountInr: pack.amountInr,
    });
    if (!result) return res.status(404).json({ error: "Workspace not found" });
    res.json({ ok: true, balanceCredits: result.wallet.balanceCredits, applied: result.applied });
  } catch (error) {
    next(error);
  }
});

// Razorpay webhook backup: credits the wallet on payment.captured, idempotent
// by payment id. Uses the raw body captured by the json verify hook for HMAC.
app.post("/webhooks/razorpay", async (req, res, next) => {
  try {
    const signature = String(req.headers["x-razorpay-signature"] || "");
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
    if (!signature || !rawBody || !verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: "Invalid signature" });
    }
    const event = req.body?.event;
    if (event === "payment.captured" || event === "order.paid") {
      const payment = req.body?.payload?.payment?.entity;
      const notes = payment?.notes || {};
      const email = String(notes.email || "");
      const credits = Number(notes.credits);
      const paymentId = String(payment?.id || "");
      if (email && Number.isFinite(credits) && credits > 0 && paymentId) {
        await creditWallet(email, {
          credits,
          reason: `${notes.packId || "Credit"} pack top-up`,
          ref: paymentId,
          amountInr: payment?.amount ? payment.amount / 100 : undefined,
        });
      }
    }
    // Always 200 on a verified event so Razorpay stops retrying.
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Estimates driving distance + travel time from the artist's base city to the
// event location so the lead form's distance/travel fields can auto-fill.
app.get("/api/maps/distance", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!placesConfigured()) {
      return res.status(400).json({ error: "Distance lookup isn't configured yet. Ask the admin to add a Maps API key." });
    }
    const destination = typeof req.query.to === "string" ? req.query.to : "";
    if (destination.trim().length < 3) {
      return res.status(400).json({ error: "Enter the event location first." });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    const origin = (typeof req.query.from === "string" && req.query.from.trim())
      || workspace?.config.city
      || "";
    if (!origin) {
      return res.status(400).json({ error: "Set your city in Settings so we can estimate distance." });
    }
    const result = await estimateDistance(origin, destination);
    if (!result) {
      return res.status(404).json({ error: "Couldn't find a driving route for that location." });
    }
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Lists the available document design themes for the picker.
app.get("/api/document-templates", (_req, res) => {
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

    // Lead creation runs AI enrichment (profile tier, tags, insight, reply).
    if (appConfig.xaiApiKey) {
      await meterUsage(req.session.profile.email, "aiLeadEnrichment");
    }

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

// One-tap walk-in booking: lead + confirm in a single call. For the client who
// booked over the phone or in person — the owner shouldn't have to walk her
// through the request pipeline.
app.post("/api/bookings/quick", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const parsed = quickBookingSchema.parse(req.body);
    const email = req.session.profile.email;
    const tokens = req.session.googleTokens;

    const { lead } = await createLeadForWorkspace(email, tokens, {
      source: "Manual",
      clientName: parsed.clientName,
      clientWhatsApp: parsed.clientWhatsApp,
      eventType: parsed.eventType,
      eventDate: parsed.eventDate,
      eventTime: parsed.eventTime,
      locationText: parsed.locationText,
    });

    // The price she actually agreed with the client beats the AI estimate.
    await updateLeadRecord(email, tokens, lead.leadId, (record) => ({
      ...record,
      finalApprovedPrice: parsed.price,
      ownerDecision: "YES",
    }));

    const result = await confirmLeadBooking(email, tokens, lead.leadId);

    if (parsed.advancePaid) {
      await updatePaymentStatus(email, tokens, lead.leadId, "Advance Paid");
    }

    res.json({ ok: true, booking: result.booking, leadId: lead.leadId });
  } catch (error) {
    next(error);
  }
});

// Move a booking to a new date/time/venue. Calendar event, booking row, and
// lead row all stay in lockstep.
app.post("/api/bookings/:bookingId/reschedule", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const eventDate = typeof req.body?.eventDate === "string" ? req.body.eventDate : "";
    const eventTime = typeof req.body?.eventTime === "string" ? req.body.eventTime : undefined;
    const venue = typeof req.body?.venue === "string" && req.body.venue.trim() ? req.body.venue.trim().slice(0, 200) : undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return res.status(400).json({ error: "Pick the new date first." });
    }
    const booking = await rescheduleBooking(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
      { eventDate, eventTime, venue },
    );
    res.json({ ok: true, booking });
  } catch (error) {
    next(error);
  }
});

// The job's done — mark it Completed (booking + lead) so the list stays clean.
app.post("/api/bookings/:bookingId/complete", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const booking = await completeBooking(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
    );
    res.json({ ok: true, booking });
  } catch (error) {
    next(error);
  }
});

// Day-to-day corrections on a lead: typo in the number, venue change, new
// time. When the lead already has a confirmed booking and date/time/venue
// changed, the booking row and calendar event move with it; name/number
// changes propagate too.
app.post("/api/leads/:leadId/details", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const email = req.session.profile.email;
    const tokens = req.session.googleTokens;
    const parsed = editLeadDetailsSchema.parse(req.body);

    const before = await getLeadRecord(email, tokens, req.params.leadId);
    if (!before) return res.status(404).json({ error: "Lead not found" });

    const updated = await updateLeadRecord(email, tokens, req.params.leadId, (lead) => ({
      ...lead,
      clientName: parsed.clientName ?? lead.clientName,
      clientWhatsApp: parsed.clientWhatsApp ?? lead.clientWhatsApp,
      clientInstagram: parsed.clientInstagram ?? lead.clientInstagram,
      eventType: parsed.eventType ?? lead.eventType,
      eventDate: parsed.eventDate ?? lead.eventDate,
      eventTime: parsed.eventTime ?? lead.eventTime,
      locationText: parsed.locationText ?? lead.locationText,
      clientTags: parsed.clientTags ?? lead.clientTags,
    }));

    if (before.bookingId) {
      const scheduleChanged =
        (parsed.eventDate && parsed.eventDate !== before.eventDate) ||
        (parsed.eventTime !== undefined && parsed.eventTime !== before.eventTime) ||
        (parsed.locationText && parsed.locationText !== before.locationText);
      if (scheduleChanged) {
        // Reads the just-updated lead, so the recreated calendar event carries
        // the new venue/time even when only one of them changed.
        await rescheduleBooking(email, tokens, before.bookingId, {
          eventDate: updated.eventDate,
          eventTime: updated.eventTime,
          venue: updated.locationText,
        }).catch(() => {});
      }
      if ((parsed.clientName && parsed.clientName !== before.clientName) ||
          (parsed.clientWhatsApp && parsed.clientWhatsApp !== before.clientWhatsApp)) {
        await updateBookingRecord(email, tokens, before.bookingId, (b) => ({
          ...b,
          clientName: updated.clientName,
          clientWhatsApp: updated.clientWhatsApp,
        })).catch(() => {});
      }
    }

    res.json({ ok: true, lead: updated });
  } catch (error) {
    next(error);
  }
});

// Cancel a booking: frees the calendar date, keeps the financial record.
app.post("/api/bookings/:bookingId/cancel", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const booking = await cancelBooking(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
    );
    res.json({ ok: true, booking });
  } catch (error) {
    next(error);
  }
});

// Track expenses against a booking (travel, assistants, products) so Insights
// can show profit, not just revenue.
app.post("/api/bookings/:bookingId/expenses", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const raw = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = raw
      .slice(0, 30)
      .map((it: { label?: unknown; amount?: unknown }) => ({
        label: String(it?.label ?? "").trim().slice(0, 80),
        amount: Number(it?.amount) || 0,
      }))
      .filter((it: { label: string; amount: number }) => it.label && it.amount > 0);
    const booking = await updateBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
      (current) => ({ ...current, expenses: items.length ? JSON.stringify(items) : "" }),
    );
    res.json({ ok: true, booking });
  } catch (error) {
    next(error);
  }
});

// AI-drafts a warm follow-up nudge for a lead that's gone quiet, in the
// owner's trained voice. Human-in-the-loop: the draft fills her reply box —
// nothing is sent until she taps send.
app.post("/api/leads/:leadId/draft-followup", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const lead = await getLeadRecord(req.session.profile.email, req.session.googleTokens, req.params.leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const daysQuiet = lead.lastContactedAt
      ? Math.max(1, Math.floor((Date.now() - new Date(lead.lastContactedAt).getTime()) / 86_400_000))
      : 3;
    const memory = await loadConversationMemory(workspace.workspaceId, lead.leadId).catch(() => "");
    const result = await generateConversationReply({
      ownerName: workspace.config.ownerName,
      brandName: workspace.config.businessName,
      city: workspace.config.city,
      channel: lead.source === "Instagram" ? "Instagram" : "WhatsApp",
      clientName: lead.clientName,
      leadStatus: lead.status,
      eventType: lead.eventType,
      eventDate: lead.eventDate,
      eventTime: lead.eventTime,
      locationText: lead.locationText,
      currentPrice: lead.finalApprovedPrice || lead.initialAiPrice,
      ownerDecision: lead.ownerDecision,
      paymentStatus: lead.paymentStatus,
      quoteUrl: lead.quoteUrl,
      latestMessage: `(The client hasn't replied in ${daysQuiet} days. Write a short, warm follow-up nudge — no pressure, just keeping the conversation alive and offering to help with next steps.)`,
      memorySummary: memory || undefined,
      language: workspace.config.aiLanguage,
      signOff: workspace.config.aiSignOff,
      toneProfile: workspace.config.aiToneProfile,
      servicesContext: workspace.config.aiServicesContext,
      personaName: workspace.config.aiPersonaName,
    });

    let balanceCredits: number | null = null;
    if (appConfig.xaiApiKey) {
      balanceCredits = await meterUsage(req.session.profile.email, "aiReply");
    }
    res.json({ ok: true, reply: result.reply, balanceCredits });
  } catch (error) {
    next(error);
  }
});

// Update payment status via bookingId (convenience endpoint used from bookings table).
app.post("/api/bookings/:bookingId/payment", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { bookingId } = req.params;
    const parsed = paymentStatusSchema.parse(req.body);
    const booking = await getBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      bookingId,
    );
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const result = await updatePaymentStatus(
      req.session.profile.email,
      req.session.googleTokens,
      booking.leadId,
      parsed.paymentStatus,
    );
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Records a payment instalment against a booking (advance, partial, balance —
// however the client actually pays). Status and balance are derived from the
// ledger so they always reflect the real money received.
app.post("/api/bookings/:bookingId/payments", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const parsed = recordPaymentSchema.parse(req.body);
    const booking = await recordBookingPayment(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
      parsed,
    );
    res.json({ ok: true, booking });
  } catch (error) {
    next(error);
  }
});

// Assigns the next sequential quote number (Q-2026-0007) the first time a
// quote is generated for a lead; the number is stable for the lead's lifetime.
async function ensureQuoteNumber(email: string, tokens: Credentials, lead: LeadRecord): Promise<LeadRecord> {
  if (lead.quoteNumber) return lead;
  const data = await getDashboardData(email, tokens);
  const number = nextDocumentNumber("Q", data.leads.map((l) => l.quoteNumber));
  return updateLeadRecord(email, tokens, lead.leadId, (current) => ({
    ...current,
    quoteNumber: current.quoteNumber || number,
  }));
}

// Same for invoices: INV-2026-0012, assigned at first invoice generation.
async function ensureInvoiceNumber(email: string, tokens: Credentials, booking: BookingRecord): Promise<BookingRecord> {
  if (booking.invoiceNumber) return booking;
  const data = await getDashboardData(email, tokens);
  const number = nextDocumentNumber("INV", data.bookings.map((b) => b.invoiceNumber));
  return updateBookingRecord(email, tokens, booking.bookingId, (current) => ({
    ...current,
    invoiceNumber: current.invoiceNumber || number,
  }));
}

app.post("/api/leads/:leadId/quote", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    let lead = await getLeadRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.leadId,
    );
    if (!workspace || !lead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    lead = await ensureQuoteNumber(req.session.profile.email, req.session.googleTokens, lead);
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

    if (lead.quoteVoidedAt) {
      return res.status(400).json({ error: "This quote is voided. Clear the void or regenerate before sending." });
    }

    const channelContext = resolveLeadMessagingContext(workspace, lead);
    if (!channelContext) {
      return res.status(400).json({ error: "Lead does not have a connected messaging channel." });
    }

    let currentLead = lead;
    if (!currentLead.quoteUrl) {
      currentLead = await ensureQuoteNumber(req.session.profile.email, req.session.googleTokens, currentLead);
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
    let booking = await getBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
    );
    if (!workspace || !booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    booking = await ensureInvoiceNumber(req.session.profile.email, req.session.googleTokens, booking);
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

    if (booking.invoiceVoidedAt) {
      return res.status(400).json({ error: "This invoice is voided. Clear the void or regenerate before sending." });
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
      currentBooking = await ensureInvoiceNumber(req.session.profile.email, req.session.googleTokens, currentBooking);
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

// ---- In-app document previews (no Google Drive needed) ----
// These stream the generated PDF straight to the browser so the artist can SEE
// exactly what their client will receive — invoice, contract, or quote — before
// anything is sent. They render the PDF in memory and never touch Drive, so they
// keep working even if Google sharing permissions are misconfigured.
function streamPdfInline(res: express.Response, bytes: Uint8Array, filename: string) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(Buffer.from(bytes));
}

app.get("/api/bookings/:bookingId/invoice/preview", async (req, res, next) => {
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
    const bytes = await buildInvoicePdfBytes(workspace, booking, {
      adjustments: parseDocumentAdjustments(booking.invoiceAdjustments),
      voided: Boolean(booking.invoiceVoidedAt),
    });
    streamPdfInline(res, bytes, `invoice-${booking.bookingId}.pdf`);
  } catch (error) {
    next(error);
  }
});

app.get("/api/bookings/:bookingId/contract/preview", async (req, res, next) => {
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
    const bytes = await generateContractPdfBytes(workspace, lead, booking, {
      adjustments: parseDocumentAdjustments(booking.contractAdjustments),
      voided: Boolean(booking.contractVoidedAt),
    });
    streamPdfInline(res, bytes, `contract-${booking.bookingId}.pdf`);
  } catch (error) {
    next(error);
  }
});

app.get("/api/leads/:leadId/quote/preview", async (req, res, next) => {
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
    const bytes = await buildQuotePdfBytes(workspace, lead, {
      adjustments: parseDocumentAdjustments(lead.quoteAdjustments),
      voided: Boolean(lead.quoteVoidedAt),
    });
    streamPdfInline(res, bytes, `quote-${lead.leadId}.pdf`);
  } catch (error) {
    next(error);
  }
});

// ---- Document management: edit / void / delete + unified list ----
// Sanitizes an owner-supplied document edit into the JSON we persist on the
// lead/booking row. Round-trips through the same parser the renderer uses so
// what we store is exactly what will render.
function sanitizeAdjustmentsInput(body: unknown): string {
  const input = (body ?? {}) as {
    amountOverride?: unknown;
    lineItems?: unknown;
    note?: unknown;
  };
  const lineItems = Array.isArray(input.lineItems)
    ? input.lineItems
        .map((item) => {
          const it = (item ?? {}) as { label?: unknown; amount?: unknown };
          return { label: String(it.label ?? "").slice(0, 80), amount: Number(it.amount) || 0 };
        })
        .filter((item) => item.label && item.amount)
        .slice(0, 20)
    : [];
  const amountOverrideRaw = Number(input.amountOverride);
  const adjustments = {
    amountOverride: Number.isFinite(amountOverrideRaw) && amountOverrideRaw > 0 ? amountOverrideRaw : undefined,
    lineItems: lineItems.length ? lineItems : undefined,
    note: typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 600) : undefined,
  };
  // Empty edit clears the adjustments entirely.
  if (!adjustments.amountOverride && !adjustments.lineItems && !adjustments.note) return "";
  return JSON.stringify(adjustments);
}

async function requireDocSession(
  req: express.Request,
  res: express.Response,
): Promise<{ email: string; tokens: NonNullable<typeof req.session.googleTokens> } | null> {
  if (!req.session.profile || !req.session.googleTokens) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return { email: req.session.profile.email, tokens: req.session.googleTokens };
}

const DOC_ACTIONS = new Set(["edit", "void", "delete"]);

// Quote: edit / void / delete (operates on the lead row)
app.post("/api/leads/:leadId/quote/:action", async (req, res, next) => {
  try {
    const ctx = await requireDocSession(req, res);
    if (!ctx) return;
    const action = req.params.action;
    if (!DOC_ACTIONS.has(action)) return next();
    const adjustments = action === "edit" ? sanitizeAdjustmentsInput(req.body) : undefined;
    const updated = await updateLeadRecord(ctx.email, ctx.tokens, req.params.leadId, (current) => {
      if (action === "edit") return { ...current, quoteAdjustments: adjustments ?? "" };
      if (action === "void") return { ...current, quoteVoidedAt: new Date().toISOString() };
      // delete: clear every quote field so the public link 410s
      return { ...current, quoteUrl: "", quoteGeneratedAt: "", quoteVoidedAt: "", quoteAdjustments: "" };
    });
    if (!updated) return res.status(404).json({ error: "Lead not found" });
    res.json({ ok: true, lead: updated });
  } catch (error) {
    next(error);
  }
});

// Itemized order editor (lead drawer): line item / quantity / price / total.
// Saving keeps the lead's headline price in sync with the order total so the
// advance, booking value, and every document reflect what was entered.
app.post("/api/leads/:leadId/order", async (req, res, next) => {
  try {
    const ctx = await requireDocSession(req, res);
    if (!ctx) return;
    const rawItems = Array.isArray((req.body as { items?: unknown })?.items)
      ? ((req.body as { items: unknown[] }).items)
      : [];
    const clean = rawItems
      .map((item) => {
        const it = (item ?? {}) as { label?: unknown; quantity?: unknown; unitPrice?: unknown };
        return {
          label: String(it.label ?? "").slice(0, 80),
          quantity: Number(it.quantity) || 0,
          unitPrice: Number(it.unitPrice) || 0,
        };
      })
      .filter((it) => it.label && it.quantity > 0)
      .slice(0, 50);
    const total = clean.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0);
    const orderItems = clean.length ? JSON.stringify(clean) : "";
    const updated = await updateLeadRecord(ctx.email, ctx.tokens, req.params.leadId, (current) => ({
      ...current,
      orderItems,
      finalApprovedPrice: clean.length ? total : current.finalApprovedPrice,
    }));
    if (!updated) return res.status(404).json({ error: "Lead not found" });
    res.json({ ok: true, lead: updated, total });
  } catch (error) {
    next(error);
  }
});

// Invoice: edit / void / delete (operates on the booking row)
app.post("/api/bookings/:bookingId/invoice/:action", async (req, res, next) => {
  try {
    const ctx = await requireDocSession(req, res);
    if (!ctx) return;
    const action = req.params.action;
    if (!DOC_ACTIONS.has(action)) return next();
    const adjustments = action === "edit" ? sanitizeAdjustmentsInput(req.body) : undefined;
    const updated = await updateBookingRecord(ctx.email, ctx.tokens, req.params.bookingId, (current) => {
      if (action === "edit") return { ...current, invoiceAdjustments: adjustments ?? "" };
      if (action === "void") return { ...current, invoiceVoidedAt: new Date().toISOString() };
      return { ...current, invoiceUrl: "", invoiceGeneratedAt: "", invoiceVoidedAt: "", invoiceAdjustments: "" };
    });
    if (!updated) return res.status(404).json({ error: "Booking not found" });
    res.json({ ok: true, booking: updated });
  } catch (error) {
    next(error);
  }
});

// Contract: edit / void / delete (operates on the booking row)
app.post("/api/bookings/:bookingId/contract/:action", async (req, res, next) => {
  try {
    const ctx = await requireDocSession(req, res);
    if (!ctx) return;
    const action = req.params.action;
    if (!DOC_ACTIONS.has(action)) return next();
    const adjustments = action === "edit" ? sanitizeAdjustmentsInput(req.body) : undefined;
    const updated = await updateBookingRecord(ctx.email, ctx.tokens, req.params.bookingId, (current) => {
      if (action === "edit") return { ...current, contractAdjustments: adjustments ?? "" };
      if (action === "void") return { ...current, contractVoidedAt: new Date().toISOString(), contractStatus: "Voided" };
      return {
        ...current,
        contractUrl: "",
        contractSentAt: "",
        contractStatus: "Draft",
        contractVoidedAt: "",
        contractAdjustments: "",
      };
    });
    if (!updated) return res.status(404).json({ error: "Booking not found" });
    res.json({ ok: true, booking: updated });
  } catch (error) {
    next(error);
  }
});

// Unified document list across all leads (quotes) and bookings (invoices,
// contracts). One row per issued document, with derived status for the table.
// Sample document preview: lets the owner SEE her quote/invoice/contract design
// (theme, logo, intro, terms, GST) with realistic dummy data — no real lead
// needed. Used from Settings while she's tweaking the design.
app.get("/api/documents/sample/:type", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const type = String(req.params.type ?? "");
    if (!isDocumentType(type)) return res.status(404).json({ error: "Unknown document type" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const eventDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const price = Number(workspace.config.basePriceBridal) || 25000;
    const advance = Math.round((price * (Number(workspace.config.advancePercentage) || 30)) / 100);
    const sampleLead = {
      leadId: "SAMPLE", createdAt: new Date().toISOString(), source: "Instagram",
      clientName: "Priya Sharma (Sample)", clientWhatsApp: "+91 98765 43210", clientInstagram: "priya.sample",
      eventType: "Bridal", eventDate, eventTime: "10:00", locationText: `${workspace.config.city || "Your city"}`,
      distanceKm: 0, travelTimeMin: 0, outstationFlag: "No", profileTier: "Mid", followers: 0,
      clientTags: "", aiInsight: "", suggestedReply: "", demandCount: 0, scarcityTag: "",
      holdExpiresAt: "", initialAiPrice: price, finalApprovedPrice: price, discountPercent: 0,
      ownerDecision: "YES", ownerNotes: "", status: "Confirmed", assignedArtist: workspace.config.ownerName,
      lastContactedAt: "", tentativeCalendarEventId: "", confirmedCalendarEventId: "", bookingId: "SAMPLE-B",
      paymentStatus: "Advance Due", quoteUrl: "sample", quoteGeneratedAt: new Date().toISOString(),
      quoteVoidedAt: "", quoteAdjustments: "", orderItems: "",
    } as LeadRecord;
    const sampleBooking = {
      bookingId: "SAMPLE-B", leadId: "SAMPLE", bookedAt: new Date().toISOString(),
      clientName: sampleLead.clientName, clientWhatsApp: sampleLead.clientWhatsApp,
      eventType: "Bridal", eventDate, eventTime: "10:00", venue: sampleLead.locationText,
      assignedArtist: workspace.config.ownerName, finalPrice: price, advanceAmount: advance,
      balanceDue: Math.max(0, price - advance), tentativeCalendarEventId: "", confirmedCalendarEventId: "",
      contractUrl: "sample", invoiceUrl: "sample", paymentStatus: "Advance Due", status: "Confirmed",
      contractStatus: "Draft", contractSentAt: "", invoiceGeneratedAt: new Date().toISOString(),
      remindersSent: "", invoiceVoidedAt: "", contractVoidedAt: "", invoiceAdjustments: "",
      contractAdjustments: "", orderItems: "", contractSignedAt: "", contractSignerName: "",
    } as BookingRecord;

    const bytes =
      type === "quote"
        ? await buildQuotePdfBytes(workspace, sampleLead)
        : type === "invoice"
          ? await buildInvoicePdfBytes(workspace, sampleBooking)
          : await generateContractPdfBytes(workspace, sampleLead, sampleBooking);
    return streamPdfInline(res, bytes, `sample-${type}.pdf`);
  } catch (error) {
    next(error);
  }
});

app.get("/api/documents", async (req, res, next) => {
  try {
    const ctx = await requireDocSession(req, res);
    if (!ctx) return;
    const { leads, bookings } = await getDashboardData(ctx.email, ctx.tokens);

    type DocRow = {
      kind: "quote" | "invoice" | "contract";
      recordId: string;
      leadId: string;
      number: string;
      client: string;
      eventType: string;
      eventDate: string;
      amount: number;
      status: string;
      generatedAt: string;
      url: string;
      edited: boolean;
      payable: boolean;
      viewedAt: string;
      acceptedAt: string;
    };
    const docs: DocRow[] = [];

    for (const lead of leads) {
      if (!lead.quoteUrl && !lead.quoteGeneratedAt) continue;
      const voided = Boolean(lead.quoteVoidedAt);
      const sent = lead.status !== "New" && Boolean(lead.lastContactedAt);
      docs.push({
        kind: "quote",
        recordId: lead.leadId,
        leadId: lead.leadId,
        number: lead.quoteNumber || `Q-${lead.leadId}`,
        client: lead.clientName,
        eventType: lead.eventType,
        eventDate: lead.eventDate,
        amount: lead.finalApprovedPrice || lead.initialAiPrice,
        status: voided ? "Voided" : lead.quoteAcceptedAt ? "Accepted" : sent ? "Sent" : "Draft",
        generatedAt: lead.quoteGeneratedAt,
        url: lead.quoteUrl,
        edited: Boolean(lead.quoteAdjustments),
        payable: false,
        viewedAt: lead.quoteViewedAt,
        acceptedAt: lead.quoteAcceptedAt,
      });
    }

    for (const booking of bookings) {
      if (booking.invoiceUrl || booking.invoiceGeneratedAt) {
        const voided = Boolean(booking.invoiceVoidedAt);
        const paid = booking.paymentStatus === "Paid in Full";
        docs.push({
          kind: "invoice",
          recordId: booking.bookingId,
          leadId: booking.leadId,
          number: booking.invoiceNumber || `INV-${booking.bookingId}`,
          client: booking.clientName,
          eventType: booking.eventType,
          eventDate: booking.eventDate,
          amount: booking.finalPrice,
          status: voided ? "Voided" : paid ? "Paid" : booking.paymentStatus || "Issued",
          generatedAt: booking.invoiceGeneratedAt,
          url: booking.invoiceUrl,
          edited: Boolean(booking.invoiceAdjustments),
          payable: !voided && !paid,
          viewedAt: booking.invoiceViewedAt,
          acceptedAt: "",
        });
      }
      if (booking.contractUrl || booking.contractSentAt) {
        const voided = Boolean(booking.contractVoidedAt);
        docs.push({
          kind: "contract",
          recordId: booking.bookingId,
          leadId: booking.leadId,
          number: `CTR-${booking.bookingId}`,
          client: booking.clientName,
          eventType: booking.eventType,
          eventDate: booking.eventDate,
          amount: booking.finalPrice,
          status: voided ? "Voided" : booking.contractStatus || "Draft",
          generatedAt: booking.contractSentAt,
          url: booking.contractUrl,
          edited: Boolean(booking.contractAdjustments),
          payable: false,
          viewedAt: booking.contractViewedAt,
          acceptedAt: booking.contractSignedAt,
        });
      }
    }

    docs.sort((a, b) => (b.generatedAt || "").localeCompare(a.generatedAt || ""));
    res.json({ documents: docs });
  } catch (error) {
    next(error);
  }
});

// ---- Public, client-facing document links (no login, no Google Drive) ----
// This is the URL the client actually opens from their WhatsApp/Instagram
// message. The link is HMAC-signed over (type, workspaceId, recordId) so it's
// unguessable and tamper-proof, and the PDF is regenerated on demand from the
// workspace's own stored Google tokens — so sharing never depends on a Drive
// scope or public-sharing permission being configured correctly.
app.get("/d/:type/:workspaceId/:recordId", async (req, res, next) => {
  try {
    const { type, workspaceId, recordId } = req.params;
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";

    if (!isDocumentType(type) || !verifyDocumentToken(type, workspaceId, recordId, sig)) {
      return res.status(404).send("Document not found.");
    }

    const workspace = await findWorkspaceByWorkspaceId(workspaceId);
    if (!workspace || !workspace.googleTokens) {
      return res.status(404).send("Document not found.");
    }

    // First-view tracking: record when the client first opens the document so
    // the artist can see "sent → viewed" instead of following up blind. The
    // owner's own session is excluded, and failures never block the document.
    const isOwnerViewing = req.session?.profile?.email === workspace.email;

    if (type === "quote") {
      const lead = await getLeadRecord(workspace.email, workspace.googleTokens, recordId);
      if (!lead) return res.status(404).send("Document not found.");
      // A deleted document has its URL field cleared — revoke the public link.
      if (!lead.quoteUrl) return res.status(410).send("This document is no longer available.");
      if (!isOwnerViewing && !lead.quoteViewedAt) {
        updateLeadRecord(workspace.email, workspace.googleTokens, recordId, (current) => ({
          ...current,
          quoteViewedAt: current.quoteViewedAt || new Date().toISOString(),
        })).catch(() => undefined);
      }
      const bytes = await buildQuotePdfBytes(workspace, lead, {
        adjustments: parseDocumentAdjustments(lead.quoteAdjustments),
        voided: Boolean(lead.quoteVoidedAt),
      });
      return streamPdfInline(res, bytes, `quote-${recordId}.pdf`);
    }

    const booking = await getBookingRecord(workspace.email, workspace.googleTokens, recordId);
    if (!booking) return res.status(404).send("Document not found.");

    if (type === "invoice") {
      if (!booking.invoiceUrl) return res.status(410).send("This document is no longer available.");
      if (!isOwnerViewing && !booking.invoiceViewedAt) {
        updateBookingRecord(workspace.email, workspace.googleTokens, recordId, (current) => ({
          ...current,
          invoiceViewedAt: current.invoiceViewedAt || new Date().toISOString(),
        })).catch(() => undefined);
      }
      const bytes = await buildInvoicePdfBytes(workspace, booking, {
        adjustments: parseDocumentAdjustments(booking.invoiceAdjustments),
        voided: Boolean(booking.invoiceVoidedAt),
      });
      return streamPdfInline(res, bytes, `invoice-${recordId}.pdf`);
    }

    // contract
    const lead = await getLeadRecord(workspace.email, workspace.googleTokens, booking.leadId);
    if (!lead) return res.status(404).send("Document not found.");
    if (!booking.contractUrl) return res.status(410).send("This document is no longer available.");
    if (!isOwnerViewing && !booking.contractViewedAt) {
      updateBookingRecord(workspace.email, workspace.googleTokens, recordId, (current) => ({
        ...current,
        contractViewedAt: current.contractViewedAt || new Date().toISOString(),
      })).catch(() => undefined);
    }
    const bytes = await generateContractPdfBytes(workspace, lead, booking, {
      adjustments: parseDocumentAdjustments(booking.contractAdjustments),
      voided: Boolean(booking.contractVoidedAt),
      signedBy: booking.contractSignerName || undefined,
      signedAt: booking.contractSignedAt || undefined,
    });
    return streamPdfInline(res, bytes, `contract-${recordId}.pdf`);
  } catch (error) {
    next(error);
  }
});

// ---- Branded public quote page ----
// The link the client receives. Shows the artist's brand, the embedded quote
// PDF, and a one-tap "Accept" button — and gives WhatsApp a rich link preview
// (og: tags) so the message looks trustworthy instead of a bare PDF URL.
app.get("/q/:workspaceId/:leadId", async (req, res, next) => {
  try {
    const workspaceId = String(req.params.workspaceId ?? "");
    const leadId = String(req.params.leadId ?? "");
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    if (!verifyDocumentToken("quote", workspaceId, leadId, sig)) {
      return res.status(404).send("Quote not found.");
    }
    const workspace = await findWorkspaceByWorkspaceId(workspaceId);
    if (!workspace || !workspace.googleTokens) return res.status(404).send("Quote not found.");
    const lead = await getLeadRecord(workspace.email, workspace.googleTokens, leadId);
    if (!lead || !lead.quoteUrl) return res.status(410).send("This quote is no longer available.");

    if (req.session?.profile?.email !== workspace.email && !lead.quoteViewedAt) {
      updateLeadRecord(workspace.email, workspace.googleTokens, leadId, (current) => ({
        ...current,
        quoteViewedAt: current.quoteViewedAt || new Date().toISOString(),
      })).catch(() => undefined);
    }

    const brand = workspace.config.businessName || workspace.config.ownerName || "Your artist";
    const brandColor = /^#[0-9a-fA-F]{3,6}$/.test(workspace.config.brandColor) ? workspace.config.brandColor : "#C26B45";
    const pdfUrl = `/d/quote/${encodeURIComponent(workspaceId)}/${encodeURIComponent(leadId)}?sig=${encodeURIComponent(sig)}`;
    const accepted = Boolean(lead.quoteAcceptedAt);
    const voided = Boolean(lead.quoteVoidedAt);
    const amount = lead.finalApprovedPrice || lead.initialAiPrice;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderQuotePage({
      brand,
      brandColor,
      clientName: lead.clientName,
      eventType: lead.eventType,
      eventDate: lead.eventDate,
      amount,
      pdfUrl,
      accepted,
      voided,
      acceptUrl: `/api/public/quote/${encodeURIComponent(workspaceId)}/${encodeURIComponent(leadId)}/accept?sig=${encodeURIComponent(sig)}`,
      ownerWhatsApp: String(workspace.config.ownerWhatsApp || "").replace(/[^\d]/g, ""),
    }));
  } catch (error) {
    next(error);
  }
});

// Client taps "Accept" on the quote page: records the acceptance, tells the
// owner on WhatsApp, and logs it on the lead's timeline. The owner still
// confirms the booking herself — accepting never moves money or the calendar.
app.post("/api/public/quote/:workspaceId/:leadId/accept", publicWriteLimiter, async (req, res, next) => {
  try {
    const workspaceId = String(req.params.workspaceId ?? "");
    const leadId = String(req.params.leadId ?? "");
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    if (!verifyDocumentToken("quote", workspaceId, leadId, sig)) {
      return res.status(404).json({ error: "Quote not found" });
    }
    const workspace = await findWorkspaceByWorkspaceId(workspaceId);
    if (!workspace || !workspace.googleTokens) return res.status(404).json({ error: "Quote not found" });
    const lead = await getLeadRecord(workspace.email, workspace.googleTokens, leadId);
    if (!lead || !lead.quoteUrl) return res.status(410).json({ error: "This quote is no longer available" });
    if (lead.quoteVoidedAt) return res.status(410).json({ error: "This quote has been withdrawn" });

    if (!lead.quoteAcceptedAt) {
      await updateLeadRecord(workspace.email, workspace.googleTokens, leadId, (current) => ({
        ...current,
        quoteAcceptedAt: current.quoteAcceptedAt || new Date().toISOString(),
      }));
      await logInteractionForWorkspace(workspace.email, workspace.googleTokens, {
        leadId,
        direction: "Inbound",
        channel: "WhatsApp",
        actor: lead.clientWhatsApp || lead.clientName || "client",
        message: `${lead.clientName || "Client"} accepted the quote for ${lead.eventType} on ${lead.eventDate}.`,
        aiSummary: "Quote accepted via public quote page",
      }).catch(() => undefined);
      notifyOwnerQuoteAccepted(workspace, lead).catch(() => undefined);
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Fire-and-forget WhatsApp ping to the owner when a client accepts a quote.
async function notifyOwnerQuoteAccepted(workspace: Awaited<ReturnType<typeof findWorkspaceByWorkspaceId>>, lead: LeadRecord) {
  if (!workspace) return;
  const templateName = String(workspace.config.ownerAlertTemplate || "").trim();
  if (!templateName) return;
  const ownerPhone = String(workspace.config.ownerWhatsApp || "").replace(/[^\d]/g, "");
  if (!ownerPhone) return;
  const whatsapp = workspace.metaConnections?.whatsapp;
  try {
    await sendWhatsAppTemplate(
      { accessToken: whatsapp?.accessToken, phoneNumberId: whatsapp?.phoneNumberId },
      ownerPhone,
      templateName,
      String(workspace.config.ownerAlertTemplateLang || "en"),
      [`${lead.clientName} ACCEPTED your quote`, lead.eventType, lead.eventDate],
    );
  } catch (error) {
    logger.warn("Owner quote-accept alert failed", { err: String(error), leadId: lead.leadId });
  }
}

// Minimal, branded, mobile-first HTML for the public quote page.
function renderQuotePage(input: {
  brand: string;
  brandColor: string;
  clientName: string;
  eventType: string;
  eventDate: string;
  amount: number;
  pdfUrl: string;
  accepted: boolean;
  voided: boolean;
  acceptUrl: string;
  ownerWhatsApp: string;
}): string {
  const esc = (v: string) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  const title = `Quote from ${esc(input.brand)}`;
  const desc = `${esc(input.eventType)} on ${esc(input.eventDate)} — ₹${Math.round(input.amount).toLocaleString("en-IN")}`;
  const acceptedBlock = `<div class="accepted">💚 You've accepted this quote. ${esc(input.brand)} will be in touch to confirm your booking!</div>`;
  const voidedBlock = `<div class="voided">This quote has been updated — please ask ${esc(input.brand)} for the latest version.</div>`;
  const actionBlock = input.voided
    ? voidedBlock
    : input.accepted
      ? acceptedBlock
      : `<button id="accept-btn" type="button">💖 Looks perfect — I accept</button>
         <p class="hint">Accepting lets ${esc(input.brand)} know you're ready. She'll confirm your date right after.</p>`;
  const waLink = input.ownerWhatsApp
    ? `<a class="wa" href="https://wa.me/${esc(input.ownerWhatsApp)}" target="_blank" rel="noreferrer">💬 Questions? WhatsApp ${esc(input.brand)}</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${desc}" />
<meta property="og:type" content="website" />
<meta name="robots" content="noindex" />
<style>
  :root { --brand: ${input.brandColor}; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #faf7f4; color: #2a2421; }
  header { background: var(--brand); color: #fff; padding: 22px 18px; text-align: center; }
  header h1 { font-size: 19px; font-weight: 600; }
  header p { font-size: 13.5px; opacity: .92; margin-top: 4px; }
  main { max-width: 680px; margin: 0 auto; padding: 18px; }
  .summary { background: #fff; border: 1px solid #eee3da; border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
  .summary .row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 14.5px; }
  .summary .row b { font-weight: 600; }
  .amount { font-size: 18px; color: var(--brand); font-weight: 700; }
  iframe { width: 100%; height: 70vh; border: 1px solid #eee3da; border-radius: 12px; background: #fff; }
  #accept-btn { display: block; width: 100%; margin-top: 16px; padding: 15px; font-size: 16.5px; font-weight: 600; color: #fff; background: var(--brand); border: 0; border-radius: 12px; cursor: pointer; }
  #accept-btn:disabled { opacity: .6; }
  .hint { text-align: center; font-size: 12.5px; color: #8a7f78; margin-top: 8px; }
  .accepted, .voided { margin-top: 16px; padding: 15px; border-radius: 12px; text-align: center; font-size: 15px; }
  .accepted { background: #e8f7ee; color: #1e6b3a; border: 1px solid #bfe6cd; }
  .voided { background: #fdf1ef; color: #9a3c2e; border: 1px solid #f3cdc5; }
  .wa { display: block; text-align: center; margin: 18px 0 8px; color: var(--brand); font-size: 14px; text-decoration: none; font-weight: 600; }
  footer { text-align: center; font-size: 12px; color: #a79c94; padding: 18px; }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <p>Hi ${esc(input.clientName || "there")} — here's your personalised quote ✨</p>
</header>
<main>
  <div class="summary">
    <div class="row"><span>Occasion</span><b>${esc(input.eventType)}</b></div>
    <div class="row"><span>Date</span><b>${esc(input.eventDate)}</b></div>
    <div class="row"><span>Quoted amount</span><b class="amount">₹${Math.round(input.amount).toLocaleString("en-IN")}</b></div>
  </div>
  <iframe src="${esc(input.pdfUrl)}" title="Quote PDF"></iframe>
  <div id="action-area">${actionBlock}</div>
  ${waLink}
</main>
<footer>Powered by BusyDays</footer>
<script>
  const btn = document.getElementById("accept-btn");
  if (btn) btn.addEventListener("click", async () => {
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const res = await fetch(${JSON.stringify(input.acceptUrl)}, { method: "POST" });
      if (!res.ok) throw new Error();
      document.getElementById("action-area").innerHTML = '<div class="accepted">💚 Accepted! ${esc(input.brand)} has been notified and will confirm your booking shortly.</div>';
    } catch {
      btn.disabled = false; btn.textContent = "💖 Looks perfect — I accept";
      alert("Couldn't send just now — please try again in a moment.");
    }
  });
</script>
</body>
</html>`;
}

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

    // Leegality is the premium e-sign path when configured; otherwise the
    // built-in signing page makes contracts work with zero external setup.
    if (leegalityAvailable(workspace)) {
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

      return res.json({ ok: true, booking: updatedBooking, contract });
    }

    const signingUrl = buildContractSigningUrl(workspace.workspaceId, booking.bookingId);
    const updatedBooking = await updateBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
      (current) => ({
        ...current,
        contractUrl: current.contractUrl || signingUrl,
        contractStatus: current.contractStatus === "Signed" ? "Signed" : "Sent",
        contractSentAt: current.contractSentAt || new Date().toISOString(),
      }),
    );

    res.json({ ok: true, booking: updatedBooking });
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

    if (booking.contractVoidedAt) {
      return res.status(400).json({ error: "This contract is voided. Clear the void or regenerate before sending." });
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
      if (leegalityAvailable(workspace)) {
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
      } else {
        const signingUrl = buildContractSigningUrl(workspace.workspaceId, currentBooking.bookingId);
        currentBooking = await updateBookingRecord(
          req.session.profile.email,
          req.session.googleTokens,
          req.params.bookingId,
          (existing) => ({
            ...existing,
            contractUrl: existing.contractUrl || signingUrl,
            contractStatus: existing.contractStatus === "Signed" ? "Signed" : "Sent",
            contractSentAt: existing.contractSentAt || new Date().toISOString(),
          }),
        );
      }
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

    // Built-in contracts update live when the client signs — nothing to pull.
    const syncWorkspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!syncWorkspace || !leegalityAvailable(syncWorkspace)) {
      return res.json({ ok: true, booking });
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
    const totalExpenses = bookings.reduce((s, b) => s + sumExpenses(b.expenses), 0);
    const totalProfit = totalRevenue - totalExpenses;
    const totalBookings = bookings.length;
    const totalLeads = leads.length;
    const conversionRate = totalLeads > 0 ? Math.round((totalBookings / totalLeads) * 100) : 0;
    const avgBookingValue = totalBookings > 0 ? Math.round(totalRevenue / totalBookings) : 0;

    res.json({
      ok: true,
      summary: { totalRevenue, totalExpenses, totalProfit, totalBookings, totalLeads, conversionRate, avgBookingValue },
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
    const rawSecret = String((req.body as Record<string, unknown>)?.secret ?? "");
    if (!secretsMatch(rawSecret, appConfig.watiWebhookSecret)) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }
    const parsed = normalizeWatiPayload(req.body as Record<string, unknown>);

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
    const rawSecret = String((req.body as Record<string, unknown>)?.secret ?? "");
    if (!secretsMatch(rawSecret, appConfig.manychatWebhookSecret)) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }
    const parsed = normalizeManychatPayload(req.body as Record<string, unknown>);

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
      // Idempotency: Meta redelivers webhooks until they're acked, so dedup on the
      // provider's message id. A redelivery is acked with 200 but skips all work,
      // preventing duplicate leads, duplicate AI replies, and double-charged credits.
      const metaMessageId = extractMetaMessageId(body);
      if (metaMessageId) {
        const fresh = await markWebhookEventProcessed("meta", metaMessageId);
        if (!fresh) {
          return res.json({ ok: true, deduped: true });
        }
      }

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
            language: workspace.config.aiLanguage,
            signOff: workspace.config.aiSignOff,
            toneProfile: workspace.config.aiToneProfile,
            servicesContext: workspace.config.aiServicesContext,
            personaName: workspace.config.aiPersonaName,
          });

          // Meter the AI reply when real AI ran (not the templated fallback).
          if (appConfig.xaiApiKey) {
            await meterUsage(workspace.email, "aiReply");
          }

          // AI auto-reply (opt-in). Sends the drafted reply to the client only
          // when the owner has enabled it, the reply passes the price/commitment
          // guardrail, a channel is connected, and billing (if enforced) allows.
          let autoSentReply = "";
          if (
            workspace.config.autoReplyEnabled === "Yes" &&
            conversation.reply &&
            replyIsSafeToAutoSend(conversation.reply, lead.ownerDecision)
          ) {
            const ctx = resolveLeadMessagingContext(workspace, lead);
            const messageKind = channel === "Instagram" ? "instagramMessage" : "whatsappMessage";
            if (ctx && canAfford(workspace, messageKind)) {
              try {
                await sendBusinessMessage({
                  workspace,
                  connection: ctx.connection,
                  channel: ctx.channel,
                  actorId: ctx.actorId,
                  message: conversation.reply,
                });
                autoSentReply = conversation.reply;
                await logInteractionForWorkspace(workspace.email, tokens, {
                  leadId: lead.leadId,
                  direction: "Outbound",
                  channel: ctx.channel,
                  actor: "AI",
                  message: conversation.reply,
                  aiSummary: "AI auto-reply sent",
                });
              } catch (sendError) {
                captureException(sendError, { scope: "auto-reply", leadId: lead.leadId });
              }
            }
          }

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
            lastOutboundMessage: autoSentReply,
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

    // Validate the reference id format before using it to scan every workspace —
    // a junk/oversized value should be a cheap 400, not a full booking sweep.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(event.referenceId)) {
      return res.status(400).json({ error: "Invalid reference id" });
    }

    // Dedup redelivered Leegality webhooks (same document + status) so we don't
    // re-log / re-notify on every retry. Acked with 200 either way.
    if (event.documentId) {
      const fresh = await markWebhookEventProcessed(
        "leegality",
        `${event.documentId}:${event.contractStatus || ""}`,
      );
      if (!fresh) {
        return res.json({ ok: true, deduped: true });
      }
    }

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

// Shared, styled wrapper for the public legal pages. These are required for the
// Meta app review (privacy + data deletion) and to set commercial terms.
function legalPage(title: string, bodyHtml: string): string {
  const lastUpdated = "5 June 2026";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)} · BusyDays</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    max-width: 760px; margin: 0 auto; padding: 40px 20px 80px; color: #1c1c28; line-height: 1.65; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  h2 { font-size: 18px; margin-top: 32px; }
  .muted { color: #6b6b80; font-size: 14px; }
  a { color: #b3005e; }
  nav { margin: 24px 0 8px; font-size: 14px; }
  nav a { margin-right: 16px; }
  ul { padding-left: 20px; }
  footer { margin-top: 48px; font-size: 13px; color: #6b6b80; border-top: 1px solid #eee; padding-top: 16px; }
</style></head><body>
<nav><a href="/legal/privacy">Privacy</a><a href="/legal/terms">Terms</a><a href="/legal/data-deletion">Data Deletion</a><a href="/">Home</a></nav>
<h1>${escapeAttr(title)}</h1>
<p class="muted">Last updated: ${lastUpdated}</p>
${bodyHtml}
<footer>BusyDays — booking and client-communication automation for appointment-based professionals. For privacy or data requests, email <a href="mailto:${escapeAttr(LEGAL_CONTACT_EMAIL)}">${escapeAttr(LEGAL_CONTACT_EMAIL)}</a>.</footer>
</body></html>`;
}

app.get("/legal/privacy", (_req, res) => {
  res.type("html").send(
    legalPage(
      "Privacy Policy",
      `<p>BusyDays ("we", "us") provides booking and client-communication automation to independent appointment-based professionals and studios ("artists"). This policy explains what we collect, why, and your choices. Each artist's data is isolated in its own workspace and never shared with other workspaces.</p>

<h2>1. Information we process</h2>
<ul>
  <li><strong>Account &amp; profile:</strong> your name, email, and profile photo from Google Sign-In.</li>
  <li><strong>Google Workspace data:</strong> with your consent, we access Google Sheets (to store your leads, bookings and settings in a spreadsheet you own), Google Calendar (to create and read booking events), and Drive file access limited to files the app creates.</li>
  <li><strong>Meta platform data:</strong> if you connect WhatsApp Business or Instagram, we process the messages your clients send you and the tokens needed to reply on your behalf.</li>
  <li><strong>Client &amp; booking records:</strong> client names, contact handles, event details, quotes, invoices and payment status that you or your clients enter.</li>
  <li><strong>Payments:</strong> credit-pack purchases are processed by Razorpay; we store only the resulting payment reference, never card details.</li>
</ul>

<h2>2. How we use it</h2>
<ul>
  <li>To run your booking pipeline: capturing leads, scheduling, generating quotes/invoices/contracts, and sending messages you authorise.</li>
  <li>To provide AI assistance (drafting replies, enriching leads, drafting review responses) using the xAI Grok API.</li>
  <li>To meter usage and process credit-pack purchases.</li>
  <li>We do <strong>not</strong> sell your data or your clients' data, and we do not use it for advertising.</li>
</ul>

<h2>3. Third parties we share with</h2>
<p>We share data only with the processors needed to deliver the service: Google (Sheets, Calendar, Drive), Meta (WhatsApp/Instagram messaging), xAI (AI generation), Razorpay (payments), and Leegality (e-signature, when you send a contract). Each receives only what is necessary for its function.</p>

<h2>4. Storage &amp; security</h2>
<p>Operational records are stored in your own Google Sheet plus our database. OAuth tokens are encrypted at rest using AES-256-GCM. Sessions are stored server-side and transmitted over HTTPS. Access is restricted to the authenticated workspace owner.</p>

<h2>5. Retention</h2>
<p>We retain workspace data for as long as your account is active. When you disconnect an integration, the related access tokens are revoked and marked disconnected. When you delete your workspace, associated records are removed from our database; data you stored in your own Google Sheet remains under your control in your Google account.</p>

<h2>6. Your rights &amp; choices</h2>
<ul>
  <li>Disconnect Google or Meta at any time from Settings; this revokes our access.</li>
  <li>Request deletion of your data — see our <a href="/legal/data-deletion">Data Deletion</a> page.</li>
  <li>Access or export your records directly from the Google Sheet you own.</li>
</ul>

<h2>7. Contact</h2>
<p>Questions or requests: <a href="mailto:${escapeAttr(LEGAL_CONTACT_EMAIL)}">${escapeAttr(LEGAL_CONTACT_EMAIL)}</a>.</p>`,
    ),
  );
});

app.get("/legal/terms", (_req, res) => {
  res.type("html").send(
    legalPage(
      "Terms of Service",
      `<p>These terms govern your use of BusyDays. By creating a workspace you agree to them.</p>

<h2>1. The service</h2>
<p>BusyDays helps appointment-based professionals capture leads, schedule bookings, generate documents, and communicate with clients across WhatsApp, Instagram and a public booking page. Features depend on the integrations you choose to connect.</p>

<h2>2. Your responsibilities</h2>
<ul>
  <li>You are responsible for the accuracy of content you send to clients and for complying with WhatsApp/Instagram platform policies and applicable messaging laws.</li>
  <li>You must have the right to contact the clients whose details you enter, and to send them messages.</li>
  <li>You are responsible for the security of your Google and Meta accounts.</li>
</ul>

<h2>3. AI-generated content</h2>
<p>AI suggestions (replies, drafts, enrichment) are provided as assistance and may contain errors. You are responsible for reviewing content before it is sent. Messages that mention price or commitments are never auto-sent without your approval.</p>

<h2>4. Credits &amp; payments</h2>
<p>Certain actions consume prepaid credits purchased via Razorpay. Credit purchases are final except where required by law. Prices and credit costs may change with notice.</p>

<h2>5. Availability</h2>
<p>We aim for high availability but the service is provided "as is" without warranty. We are not liable for losses arising from third-party outages (Google, Meta, Razorpay) or from your use of AI-generated content, to the maximum extent permitted by law.</p>

<h2>6. Termination</h2>
<p>You may stop using BusyDays and delete your workspace at any time. We may suspend accounts that abuse the service or violate platform policies.</p>

<h2>7. Contact</h2>
<p><a href="mailto:${escapeAttr(LEGAL_CONTACT_EMAIL)}">${escapeAttr(LEGAL_CONTACT_EMAIL)}</a>.</p>`,
    ),
  );
});

app.get("/legal/data-deletion", (_req, res) => {
  res.type("html").send(
    legalPage(
      "Data Deletion",
      `<p>You can remove your data from BusyDays at any time. We offer three paths:</p>

<h2>1. Disconnect an integration</h2>
<p>In <strong>Settings</strong>, disconnect Google or any Meta channel (WhatsApp/Instagram). This immediately revokes the stored access tokens and marks that connection deleted, so we can no longer access the corresponding account.</p>

<h2>2. Delete your workspace</h2>
<p>To delete your entire workspace and the records we hold for it, email <a href="mailto:${escapeAttr(LEGAL_CONTACT_EMAIL)}">${escapeAttr(LEGAL_CONTACT_EMAIL)}</a> from your account email with the subject "Delete my workspace". We will remove your workspace records from our database within 30 days and confirm by email. Data stored in the Google Sheet you own remains in your Google account for you to delete directly.</p>

<h2>3. Meta data deletion callback</h2>
<p>If you remove BusyDays from your Facebook/Instagram account, Meta sends us a signed data-deletion request. We verify it, disconnect the associated channels, and return a confirmation code and this status URL, as required by Meta Platform policy. The callback endpoint is <code>/compliance/meta/data-deletion</code>.</p>

<h2>What gets deleted</h2>
<ul>
  <li>OAuth access and refresh tokens (revoked and removed).</li>
  <li>Meta channel connection records for your workspace.</li>
  <li>On full workspace deletion: lead, booking, interaction, wallet and conversation-memory records in our database.</li>
</ul>`,
    ),
  );
});

app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Always log the full error server-side for debugging (structured + captured).
  captureException(error, {
    method: req.method,
    path: req.path,
    requestId: (req as express.Request & { requestId?: string }).requestId,
  });

  // Validation errors are safe to surface and help the user fix their input.
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const field = first?.path?.join(".");
    return res.status(400).json({
      error: field ? `${field}: ${first.message}` : first?.message || "Invalid request data.",
    });
  }

  // Google API permission/auth failures ("caller does not have permission",
  // "insufficient permission", 401/403) usually mean the connected Google
  // account is missing a scope or the token went stale. Surface a clear,
  // actionable message with a reconnect hint instead of a generic 500.
  const message = error instanceof Error ? error.message : "";
  const googleAuthError =
    /caller does not have permission|insufficient permission|insufficientPermissions|invalid_grant|Login Required|PERMISSION_DENIED|forbidden|access.{0,12}not.{0,12}configured/i.test(message);
  if (googleAuthError) {
    return res.status(403).json({
      error: "Google access issue — please reconnect your Google account from Settings, and make sure you allow Sheets, Drive and Calendar access.",
      reconnect: true,
    });
  }

  // Known, intentionally-thrown business errors carry user-safe messages.
  // Anything else is treated as an internal fault and kept generic.
  const isUserSafe = Boolean(message) && message.length < 200 && !/\b(at |\/home\/|\/usr\/|node_modules|ECONN|ETIMEDOUT|ENOTFOUND)\b/.test(message);
  res.status(500).json({ error: isUserSafe ? message : "Something went wrong on our end. Please try again." });
});

// Exported so integration tests can boot the fully-wired app on an ephemeral
// port without the side effects below (listen, schedulers, signal handlers).
export { app };

// Only start the server, schedulers, and signal handlers when run directly
// (node dist/index.js) — not when imported by a test.
const isMainModule =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  // Fail closed: refuse to boot a deployed environment without a database and a
  // token-encryption key, rather than silently using ephemeral/plaintext storage.
  assertDeploymentConfig();

  const server = app.listen(appConfig.port, () => {
    logger.info("BusyDays app listening", {
      baseUrl: appConfig.baseUrl,
      env: appConfig.appEnv,
      persistence: appConfig.databaseUrl ? "postgres" : "file",
      tokenEncryption: encryptionEnabled() ? "on" : "off",
    });
    startReminderScheduler();
  });

  // Graceful shutdown: on a deploy/restart Railway sends SIGTERM. Stop accepting
  // new connections, let in-flight requests finish, close the DB pool, then exit.
  // A hard 10s timeout guarantees we never hang the platform's shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_initiated", { signal });

    const forceExit = setTimeout(() => {
      logger.error("shutdown_forced", { signal });
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(async () => {
      try {
        await closePool();
      } catch (error) {
        captureException(error, { phase: "shutdown_close_pool" });
      }
      clearTimeout(forceExit);
      logger.info("shutdown_complete", { signal });
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

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

// Tolerant expense parser: bad JSON or junk rows count as zero.
function sumExpenses(raw: string): number {
  if (!raw) return 0;
  try {
    const items = JSON.parse(raw) as Array<{ amount?: unknown }>;
    if (!Array.isArray(items)) return 0;
    return items.reduce((s, it) => s + (Number(it?.amount) > 0 ? Number(it.amount) : 0), 0);
  } catch {
    return 0;
  }
}

// Built-in e-sign is the default; Leegality is used only when fully configured
// (env keys + per-workspace profile ID).
function leegalityAvailable(workspace: { config: { contractTemplateUrl: string } }) {
  return Boolean(appConfig.leegalityCreateUrl && appConfig.leegalityApiKey && workspace.config.contractTemplateUrl);
}

// The signing page link a client receives. Same HMAC token as the public
// document URL, so possession of the contract link is what authorizes signing.
function buildContractSigningUrl(workspaceId: string, bookingId: string) {
  const sig = signDocumentToken("contract", workspaceId, bookingId);
  const url = new URL(`/sign/${encodeURIComponent(workspaceId)}/${encodeURIComponent(bookingId)}`, appConfig.baseUrl);
  url.searchParams.set("sig", sig);
  return url.toString();
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
