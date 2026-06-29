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
import { OAuth2Client } from "google-auth-library";
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
  deleteBookingPaymentEntry,
  findLatestLeadByActor,
  getBookingRecord,
  getLeadRecord,
  getDashboardData,
  getMonthlyRecap,
  importClients,
  listActiveBookings,
  markBookingReminderSent,
  parsePaymentsLog,
  paymentsTotal,
  recordBookingPayment,
  rescheduleBooking,
  toggleLeadUrgency,
  updateBookingRecord,
  type BookingRecord,
  type LeadRecord,
  updateLeadRecord,
  updatePaymentStatus,
  travelCostForDistance,
} from "./services/booking.js";
import { getWorkspaceCredentials } from "./services/auth-store.js";
import { buildOutboundReplyPayload, normalizeManychatPayload, normalizeWatiPayload } from "./services/channel-adapters.js";
import { cleanupOldWebhookEvents, closePool, countWorkspaces, deleteWorkspace, findWorkspaceByMetaAsset, findWorkspaceByMetaUserId, findWorkspaceByWorkspaceId, isPhoneOptedOut, listOptedOutPhones, listWorkspaces, markPhoneOptedOut, markWebhookEventProcessed, pingDatabase, removePhoneOptOut, saveWorkspace } from "./services/database.js";
import {
  createOrderWithKeys,
  createRazorpayOrder,
  fetchOrderWithKeys,
  fetchRazorpayOrder,
  createRefundWithKeys,
  razorpayConfigured,
  razorpayTestMode,
  verifyCheckoutSignature,
  verifyCheckoutSignatureWithSecret,
  verifyWebhookSignature,
} from "./services/razorpay.js";
import { CREDIT_PACKS, USAGE_COSTS, USAGE_LABELS, findPack, getWallet, creditWallet, meterUsage, isLowBalance, canAfford, type UsageKind } from "./services/wallet.js";
import { createGoogleClients, exchangeCodeForTokens, exchangeNativeAuthCode, fetchGoogleProfile, getAuthUrl } from "./services/google.js";
import {
  buildImageMarker,
  extractInboundMediaFromMetaWebhook,
  extractInboundTextFromMetaWebhook,
  extractMetaMessageId,
  ingestNormalizedLead,
  listInteractions,
  logInteractionForWorkspace,
  parseInstagramLeadSignalsFromMessage,
  parseWhatsAppLeadSignalsFromMessage,
} from "./services/integrations.js";
import { deactivateArtist, reactivateArtist, listArtists, upsertArtist } from "./services/team.js";
import { buildAvailability, createPublicBookingRequest, getPublicBusinessProfile, getPublicPaymentDetails, getPublicSlotsForDate, submitPaymentScreenshot, checkPublicAvailability, getPublicArtists } from "./services/public-booking.js";
import { buildServicesContext, computeInsights } from "./services/insights.js";
import { buildGoogleReviewLink, findBusinessCandidates, placesConfigured, estimateDistance, suggestCities, suggestPlaces } from "./services/places.js";
import { resolveTravelIntelligence } from "./services/maps.js";
import { BUSINESS_MANAGE_SCOPE, VERIFICATION_LABELS, createBusinessProfile, getGmbCreateStatus, getGmbStatus, draftReviewReplies, listGmbReviews, postGmbReply, listGmbPosts, createGmbPost, getReputationSummary } from "./services/gmb.js";
import { replyIsSafeToAutoSend } from "./services/auto-reply.js";
import { DOCUMENT_THEME_LIST } from "./services/document-themes.js";
import { loadConversationMemory, saveConversationMemory } from "./services/conversation-memory.js";
import { loadClientNotes, saveClientNotes } from "./services/client-notes.js";
import { ensureSheetTab } from "./services/sheets-util.js";
import { generatePromoCode, parsePromoCode, promoCodeToRow, promoCodeHeaders, validatePromo, type PromoCode } from "./services/promo-codes.js";
import { parseClientPackage, clientPackageToRow, packageHeaders, remainingSessions, isRedeemable, type ClientPackage } from "./services/packages.js";
import { parseClientPhoto, clientPhotoToRow, clientPhotoHeaders, type ClientPhoto } from "./services/client-photos.js";
import { parseProduct, productToRow, productHeaders, isLowStock, parseProductSale, productSaleToRow, productSaleHeaders, type Product, type ProductSale } from "./services/inventory.js";
import { addDeviceToken, addPushSubscription, pushConfigured, removeDeviceToken, removePushSubscription, sendPushToWorkspace } from "./services/push.js";
import { fcmConfigured } from "./services/fcm.js";
import { createMobileLoginToken, redeemMobileLoginToken } from "./services/mobile-auth.js";
import {
  createWhatsAppTemplate,
  exchangeForLongLivedToken,
  exchangeMetaCode,
  fetchInstagramLoginConnectionProfile,
  fetchMetaConnectionProfile,
  fetchWhatsAppCloudConnectionProfile,
  buildAppSecretProof,
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
import { fetchWithTimeout, isPublicHttpUrl } from "./services/http.js";
import { encryptionEnabled } from "./services/crypto.js";
import {
  generateInvoiceDocument,
  generateQuoteDocument,
  buildInvoicePdfBytes,
  buildQuotePdfBytes,
  generateContractPdfBytes,
  nextDocumentNumber,
  parseDocumentAdjustments,
  parseQuotePackages,
} from "./services/documents.js";
import { buildPublicDocumentUrl, buildRescheduleUrl, buildCancelUrl, isDocumentType, signDocumentToken, verifyDocumentToken, verifyRescheduleToken, verifyCancelToken } from "./services/document-links.js";
import { estimateCampaignReach, getCampaignJob, rehydrateInterruptedCampaigns, startCampaignBroadcast, type CampaignSegment } from "./services/campaigns.js";
import {
  checkLeegalityDocumentDetails,
  createLeegalityContract,
  parseLeegalityWebhook,
  verifyLeegalityWebhookRequest,
} from "./services/contracts.js";
import { sheetNames } from "./services/sheet-definitions.js";
import { computeLoyaltyStatuses, loyaltyForPhone } from "./services/loyalty.js";
import { generateGiftCode, parseGiftCard, giftCardToRow } from "./services/gift-cards.js";
import { emailEnabled, sendEmail, wrapEmailHtml } from "./services/email.js";
import { TtlCache } from "./services/cache.js";
import type { MetaChannel, WorkspaceConfig, WorkspaceRecord } from "./types.js";
import {
  addPortfolioImage,
  disconnectMetaConnection,
  getWorkspaceByEmail,
  persistWorkspaceTokens,
  provisionWorkspace,
  recoverSheet,
  setSheetProtection,
  uploadLogoImage,
  uploadCoverImage,
  uploadPublicImage,
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

  if (req.path === "/api/health" || req.path === "/api/ready") return next();

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

// Public read endpoints (booking pages, pay pages, reschedule links) get a
// looser limit — legit clients refresh these freely — but still enough to stop
// workspace/lead enumeration sweeps.
const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a minute and try again." },
});

// Mounted via app.use (rather than inline per-route) so Express keeps the
// path-literal param typing on the handlers below. Prefix matching also
// covers the POST variants of these public surfaces.
app.use(
  [
    "/book/:workspaceId",
    "/reschedule/:workspaceId/:bookingId",
    "/api/public/:workspaceId/profile",
    "/api/public/:workspaceId/payment/:leadId",
    "/api/public/:workspaceId/reschedule/:bookingId",
    "/api/public/contract/:workspaceId/:bookingId",
  ],
  publicReadLimiter,
);

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
    req.path === "/api/health" ||
    req.path === "/api/ready",
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
    rolling: true, // reset the 7-day window on each active request
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: appConfig.baseUrl.startsWith("https://"),
      maxAge: 1000 * 60 * 60 * 24 * 7,
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
const PUBLIC_API_PATHS = new Set(["/api/health", "/api/ready", "/api/session", "/api/document-templates", "/api/logout", "/api/auth/mobile/exchange", "/api/auth/google/id-token", "/api/auth/google/native-code", "/api/config/phone-codes", "/api/push/config"]);
app.use((req, res, next) => {
  if (req.path !== "/api" && !req.path.startsWith("/api/")) return next();
  if (PUBLIC_API_PATHS.has(req.path) || req.path.startsWith("/api/public/")) return next();
  if (!req.session.profile) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Liveness: instant, no dependencies. A platform health probe hitting this
// should never recycle the instance just because Postgres had a blip — that's
// what /api/health (deep check, for dashboards/alerts) is for.
app.get("/api/ready", (_req, res) => {
  res.json({ ok: true });
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
  // Prefer the wide cover photo for social cards (it's designed to be the
  // banner); fall back to the first portfolio image.
  const image = profile?.coverImageUrl || profile?.portfolioImages?.[0] || "";
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

// Live travel-fee estimate for the public booking page. Called when the client
// types their venue so the sticky price bar can show "Incl. ₹X travel" before
// they submit — no surprises in the quote. Returns 0 when travel isn't
// configured or the venue string is too vague to geocode.
app.get("/api/public/:workspaceId/travel", publicReadLimiter, async (req, res, next) => {
  try {
    const workspace = await findWorkspaceByWorkspaceId(String(req.params.workspaceId));
    if (!workspace) return res.json({ ok: true, travelFee: 0 });
    // Cap length before it reaches the external Maps API — a multi-KB "venue"
    // is never a real address and would just burn quota.
    const venue = String(req.query.venue ?? "").trim().slice(0, 200);
    if (venue.length < 3) return res.json({ ok: true, travelFee: 0 });
    const { config } = workspace;
    const originCity = config.city || "";
    if (!originCity) return res.json({ ok: true, travelFee: 0 });
    const outstationThresholdKm = Number(config.travelOutstationThresholdKm) || 100;
    const travel = await resolveTravelIntelligence({ originCity, destinationText: venue, outstationThresholdKm });
    const travelFee = travelCostForDistance(config, travel.distanceKm);
    res.json({ ok: true, travelFee, distanceKm: Math.round(travel.distanceKm) });
  } catch (error) {
    next(error);
  }
});

// Venue autocomplete for the public booking page. Public (the page is
// unauthenticated) and rate-limited; returns [] without a Maps key so the field
// stays a plain input. Only resolves for a real workspace so it can't be abused
// as an open Places proxy.
app.get("/api/public/:workspaceId/places", publicReadLimiter, async (req, res, next) => {
  try {
    const workspace = await findWorkspaceByWorkspaceId(String(req.params.workspaceId));
    if (!workspace) return res.json({ ok: true, suggestions: [] });
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const suggestions = await suggestPlaces(q).catch(() => []);
    res.json({ ok: true, suggestions });
  } catch (error) {
    next(error);
  }
});

// Live time-slot availability for a date: each configured slot, marked taken
// when an existing job (with its configured service duration) overlaps it.
app.get("/api/public/:workspaceId/slots", publicReadLimiter, async (req, res, next) => {
  try {
    const result = await getPublicSlotsForDate(
      String(req.params.workspaceId),
      String(req.query.date ?? ""),
      String(req.query.eventType ?? ""),
    );
    if (!result) return res.status(404).json({ error: "Booking page not found" });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.get("/api/public/:workspaceId/artists", publicReadLimiter, async (req, res, next) => {
  try {
    const artists = await getPublicArtists(String(req.params.workspaceId));
    res.json({ ok: true, artists });
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

// Client appointment hub — unified page showing booking summary, payment status,
// and links to pay / sign / reschedule / cancel.
app.get("/appointment/:workspaceId/:leadId", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "appointment.html"));
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
    if (details.paymentStatus === "Paid in Full") {
      return res.status(409).json({ error: "This booking is already fully paid." });
    }
    // Stage-aware: before the advance is in, collect the advance; after it,
    // the same page collects the (usually larger) balance.
    const stage = details.paymentStatus === "Advance Paid" ? "balance" : "advance";
    const amountInr = stage === "balance" ? details.balanceDue : details.advanceAmount;
    if (!(amountInr > 0)) {
      return res.status(400).json({ error: "There's nothing due on this booking right now." });
    }
    // Optional tip the client added on the pay page. Charge it on top of what's
    // due and stamp it in the order notes so /verify can record it as a tip
    // (separate from the service payment, so it never skews the balance).
    const tipRaw = Number(req.body?.tipAmount);
    const tipInr = details.tipsEnabled && Number.isFinite(tipRaw)
      ? Math.max(0, Math.min(1000000, Math.round(tipRaw)))
      : 0;

    const order = await createOrderWithKeys(
      { keyId: razorpayKeyId, keySecret: razorpayKeySecret },
      {
        amountInr: amountInr + tipInr,
        receipt: leadId.slice(0, 40),
        notes: { workspaceId, leadId, purpose: stage, tip: String(tipInr) },
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
      purpose: stage,
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
    const purpose = order.notes.purpose === "balance" ? "balance" : "advance";
    if (order.notes.leadId !== leadId || order.notes.workspaceId !== workspaceId || !["advance", "balance"].includes(String(order.notes.purpose))) {
      return res.status(400).json({ error: "Payment doesn't match this booking." });
    }

    const tokens = await getWorkspaceCredentials(workspace.email);
    const lead = await getLeadRecord(workspace.email, tokens, leadId);
    if (!lead) return res.status(404).json({ error: "Booking not found" });
    const targetStatus = purpose === "balance" ? "Paid in Full" : "Advance Paid";
    // Idempotent: a retried verify (or webhook race) never double-processes.
    const alreadyThere =
      lead.paymentStatus === "Paid in Full" ||
      (purpose === "advance" && lead.paymentStatus === "Advance Paid");
    if (!alreadyThere) {
      const grossInr = Math.round(Number(order.amount) / 100);
      const tipInr = Math.max(0, Math.round(Number(order.notes.tip) || 0));
      const serviceInr = Math.max(0, grossInr - tipInr);
      // Prefer the per-booking ledger (keeps collected/outstanding exact);
      // fall back to the coarse status flip for leads without a booking row.
      if (lead.bookingId && serviceInr > 0) {
        const paidBooking = await recordBookingPayment(workspace.email, tokens, lead.bookingId, {
          amount: serviceInr,
          method: "Razorpay",
          note: `Online ${purpose} payment`,
          ref: paymentId,
        }).catch(async () => {
          await updatePaymentStatus(workspace.email, tokens, leadId, targetStatus);
          return null;
        });
        // Same branded receipt (WhatsApp template + email) a manually-recorded
        // payment gets — an online payer shouldn't be the only one left without
        // a confirmation showing what's paid and what's still due.
        if (paidBooking) {
          sendPaymentReceipt(workspace, tokens, paidBooking, serviceInr).catch(() => undefined);
        }
      } else {
        await updatePaymentStatus(workspace.email, tokens, leadId, targetStatus);
      }
      // Record the tip as its own ledger line so the artist sees it but the
      // booking balance stays based purely on the service price.
      if (lead.bookingId && tipInr > 0) {
        await recordBookingPayment(workspace.email, tokens, lead.bookingId, {
          amount: tipInr,
          method: "Razorpay",
          note: "Tip 💛",
          type: "tip",
          ref: paymentId,
        }).catch(() => {});
      }
      await logInteractionForWorkspace(workspace.email, tokens, {
        leadId,
        direction: "Inbound",
        channel: "WhatsApp",
        actor: lead.clientWhatsApp || leadId,
        message: `${purpose === "balance" ? "Balance" : "Advance"} paid online via Razorpay (payment ${paymentId})`,
        aiSummary: `${purpose === "balance" ? "Balance" : "Advance"} payment received and auto-confirmed via Razorpay`,
      }).catch(() => {});
    }
    res.json({ ok: true, paymentStatus: targetStatus });
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
      leadId: booking.leadId || "",
      eventType: booking.eventType,
      eventDate: booking.eventDate,
      eventTime: booking.eventTime,
      venue: booking.venue,
      finalPrice: booking.finalPrice,
      advanceAmount: booking.advanceAmount,
      signed: Boolean(booking.contractSignedAt),
      signedAt: booking.contractSignedAt,
      signerName: booking.contractSignerName,
      sentAt: booking.contractSentAt,
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

// Rate-limited: this returns client name + amounts due, and lead ids must not
// be enumerable at network speed. (The page itself is reached via links we
// send the client, so a modest per-IP budget never affects real users.)
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

app.get("/auth/google", (req, res) => {
  if (!appConfig.googleClientId || !appConfig.googleClientSecret) {
    return res.status(500).send("Google OAuth is not configured. Add env vars first.");
  }

  // ?mobile=1 — the native app runs OAuth in the system browser (Google blocks
  // webview sign-in); "mobile" state makes the callback finish with a deep link.
  res.redirect(getAuthUrl([], req.query.mobile === "1" ? "mobile" : undefined));
});

// Incremental consent: re-runs Google sign-in asking additionally for Business
// Profile access, so the artist can create/manage her Google listing in-app.
// include_granted_scopes keeps her existing Sheets/Calendar grants intact.
app.get("/auth/google/business", (_req, res) => {
  if (!appConfig.googleClientId || !appConfig.googleClientSecret) {
    return res.status(500).send("Google OAuth is not configured. Add env vars first.");
  }
  res.redirect(getAuthUrl([BUSINESS_MANAGE_SCOPE]));
});

app.get("/auth/meta/start", (req, res, next) => {
  try {
    const channel = req.query.channel;
    // Bind the connection to the *authenticated* account only. Trusting a
    // ?workspaceEmail query param would let anyone start an OAuth flow that
    // links a Meta account to a workspace they don't own.
    const workspaceEmail = req.session.profile?.email;
    if (!workspaceEmail) {
      return res.status(401).send("Please sign in before connecting a channel.");
    }
    if (channel !== "instagram" && channel !== "whatsapp") {
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

    // Signup cap: keep existing users flowing, but queue brand-new signups once
    // we hit the configured limit (protects the ~100-user Google sensitive-scope
    // cap and stops a launch stampede of Sheet/Calendar provisioning). Checked
    // before we create a session so a queued user lands cleanly on the waitlist.
    if (appConfig.maxWorkspaces > 0) {
      const alreadyHasWorkspace = await getWorkspaceByEmail(profile.email);
      if (!alreadyHasWorkspace) {
        const count = await countWorkspaces();
        if (count >= appConfig.maxWorkspaces) {
          logger.info("signup_capped", { email: profile.email, count, cap: appConfig.maxWorkspaces });
          return res.redirect("/?waitlist=1");
        }
      }
    }

    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.googleTokens = tokens;
    req.session.profile = profile;

    await provisionWorkspace(profile, tokens);
    await persistWorkspaceTokens(profile.email, tokens);

    if (req.query.state === "mobile") {
      // Native-app flow: the callback runs inside a Chrome Custom Tab. Issue a
      // 302 redirect to the busydays:// custom scheme so the OS routes it back
      // to the app and the Custom Tab closes automatically. The webview's
      // appUrlOpen listener (mobile-bridge.js) picks up the OTT and exchanges
      // it for a real session via POST /api/auth/mobile/exchange.
      const ott = await createMobileLoginToken(profile.email);
      res.redirect(`busydays://auth?ott=${encodeURIComponent(ott)}`);
      return;
    }

    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

// Native-app login completion: the webview posts the one-time token from the
// deep link and receives a real session cookie. Public by necessity (it's how a
// session is obtained); the token itself is the credential — 256-bit, hashed at
// rest, 5-minute TTL, single use — and the endpoint is rate-limited.
app.post("/api/auth/mobile/exchange", publicWriteLimiter, async (req, res, next) => {
  try {
    const ott = String(req.body?.ott ?? "");
    const email = await redeemMobileLoginToken(ott);
    if (!email) return res.status(401).json({ error: "Login link expired — please sign in again." });

    const workspace = await getWorkspaceByEmail(email);
    if (!workspace) return res.status(401).json({ error: "Workspace not found — please sign in again." });

    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.profile = { email: workspace.email, name: workspace.name };
    try {
      req.session.googleTokens = await getWorkspaceCredentials(email);
    } catch {
      // Tokens restore lazily via the session-heal middleware on the next request.
    }
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Native-app Google Sign-In (Android/iOS): the native plugin returns a Google
// ID token which we verify server-side and convert to a session. This avoids
// the system-browser OAuth flow for users who already have a workspace — they
// get a native account-picker bottom sheet without leaving the app.
// For first-time users (no workspace yet) we return requiresFullAuth:true and
// the bridge falls back to Chrome Custom Tab OAuth (needed for Sheets scopes).
app.post("/api/auth/google/id-token", publicWriteLimiter, async (req, res, next) => {
  try {
    const idToken = String(req.body?.idToken ?? "");
    if (!idToken) return res.status(400).json({ error: "idToken required" });
    if (!appConfig.googleClientId) return res.status(503).json({ error: "Google Sign-In not configured" });

    let email: string;
    let name: string;
    try {
      const oauthClient = new OAuth2Client(appConfig.googleClientId);
      const ticket = await oauthClient.verifyIdToken({ idToken, audience: appConfig.googleClientId });
      const payload = ticket.getPayload();
      if (!payload?.email) throw new Error("no email in token");
      email = payload.email.toLowerCase();
      name = payload.name ?? email;
    } catch {
      return res.status(401).json({ error: "Invalid or expired Google ID token" });
    }

    const workspace = await getWorkspaceByEmail(email);
    if (!workspace) {
      // New user — must go through full OAuth to provision Google Sheets/Calendar.
      return res.json({ ok: false, requiresFullAuth: true });
    }

    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.profile = { email: workspace.email, name: workspace.name };
    try {
      req.session.googleTokens = await getWorkspaceCredentials(email);
    } catch {
      // Restored lazily on next Google API call.
    }
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Native mobile sign-in for FIRST-TIME users without a browser tab. The native
// Google SDK returns a one-time server auth code (with offline access + our
// scopes); we exchange it, provision the workspace, and open a session — all
// server-side. Strictly fail-safe: if the code doesn't yield offline tokens with
// the Sheets/Calendar/Drive scopes we need (or the signup cap is hit), we return
// requiresFullAuth so the app falls back to the existing Custom Tab flow. So this
// can only ever REMOVE the tab, never break sign-in.
app.post("/api/auth/google/native-code", publicWriteLimiter, async (req, res, next) => {
  try {
    const code = String(req.body?.code ?? "");
    if (!code) return res.status(400).json({ error: "code required" });
    if (!appConfig.googleClientId || !appConfig.googleClientSecret) {
      return res.status(503).json({ error: "Google Sign-In not configured" });
    }

    let tokens;
    try {
      tokens = await exchangeNativeAuthCode(code);
    } catch {
      // Bad/expired code or a plugin that didn't request offline access → tab.
      return res.json({ ok: false, requiresFullAuth: true });
    }

    // Must have offline tokens AND the sensitive scopes, or provisioning (which
    // creates a Google Sheet/Calendar) would fail. Otherwise → Custom Tab.
    const granted = String(tokens.scope || "");
    const hasScopes = ["spreadsheets", "calendar", "drive.file"].every((s) => granted.includes(s));
    if (!tokens.access_token || !tokens.refresh_token || !hasScopes) {
      return res.json({ ok: false, requiresFullAuth: true });
    }

    const profile = await fetchGoogleProfile(tokens);

    // Respect the signup cap; a capped new user falls back to the tab, which
    // routes them to the waitlist page — no cap bypass here.
    if (appConfig.maxWorkspaces > 0) {
      const already = await getWorkspaceByEmail(profile.email);
      if (!already && (await countWorkspaces()) >= appConfig.maxWorkspaces) {
        return res.json({ ok: false, requiresFullAuth: true });
      }
    }

    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.googleTokens = tokens;
    req.session.profile = profile;
    await provisionWorkspace(profile, tokens);
    await persistWorkspaceTokens(profile.email, tokens);
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
    res.json({ ok: true });
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
      // Same session-fixation defense as the real OAuth callback: a fresh
      // session id on every privilege change, even in dev.
      req.session.regenerate((regenErr) => {
        if (regenErr) return next(regenErr);
        req.session.profile = profile;
        req.session.save((err) => {
          if (err) return next(err);
          res.type("text").send("dev login ok");
        });
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
    // Defence in depth: even with a validly signed state, only the signed-in
    // owner of that workspace may complete the binding. This closes the OAuth
    // CSRF where a victim is tricked into finishing an attacker-started flow.
    if (!req.session.profile || req.session.profile.email !== parsedState.workspaceEmail) {
      return res
        .status(403)
        .send("This connection link doesn't match your signed-in account. Please sign in and try connecting again.");
    }
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
  // Never ship stored credentials to the browser; the frontend only needs to
  // know whether one is set. Both the Razorpay key secret and the SMTP password
  // are masked here (and preserved on save when the masked value comes back).
  const safeConfig = {
    ...rest.config,
    razorpayKeySecret: rest.config?.razorpayKeySecret ? "********" : "",
    smtpPass: rest.config?.smtpPass ? "********" : "",
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
    // The browser only ever sees masked secrets (Razorpay key, SMTP password) —
    // a blank or masked value on save means "keep what's stored", never "erase
    // it". One workspace fetch covers both.
    if (
      !parsed.razorpayKeySecret || parsed.razorpayKeySecret === "********" ||
      !parsed.smtpPass || parsed.smtpPass === "********"
    ) {
      const existing = await getWorkspaceByEmail(req.session.profile.email);
      if (!parsed.razorpayKeySecret || parsed.razorpayKeySecret === "********") {
        parsed.razorpayKeySecret = existing?.config.razorpayKeySecret || "";
      }
      if (!parsed.smtpPass || parsed.smtpPass === "********") {
        parsed.smtpPass = existing?.config.smtpPass || "";
      }
    }
    // Pretty booking slug: normalized, validated, and unique across all
    // workspaces — it becomes a top-level public URL.
    if (parsed.bookingSlug) {
      const slug = normalizeSlug(parsed.bookingSlug);
      if (!slug) {
        return res.status(400).json({ error: "Booking link names use 3-40 letters, numbers or dashes (e.g. glow-by-aisha)." });
      }
      if (RESERVED_SLUGS.has(slug)) {
        return res.status(400).json({ error: `"${slug}" is reserved — pick another booking link name.` });
      }
      const all = await listWorkspaces();
      const taken = all.some(
        (w) => w.email !== req.session.profile!.email && normalizeSlug(w.config?.bookingSlug || "") === slug,
      );
      if (taken) {
        return res.status(409).json({ error: `"${slug}" is already taken — try another name.` });
      }
      parsed.bookingSlug = slug;
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

// Live slug-availability check so the booking-page slug input gives instant
// feedback before the artist saves — avoids the frustrating "name taken" error
// only appearing on submit.
app.get("/api/workspace/slug-check", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    const raw = String(req.query.slug ?? "");
    const slug = normalizeSlug(raw);
    if (!slug) return res.json({ ok: true, available: false, reason: "invalid" });
    if (RESERVED_SLUGS.has(slug)) return res.json({ ok: true, available: false, reason: "reserved" });
    const all = await listWorkspaces();
    const taken = all.some(
      (w) => w.email !== req.session.profile!.email && normalizeSlug(w.config?.bookingSlug || "") === slug,
    );
    res.json({ ok: true, available: !taken });
  } catch (error) {
    next(error);
  }
});

// Chat image upload: returns a public URL to attach to a client reply.
app.post(
  "/api/uploads/chat-image",
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
      const result = await uploadPublicImage(req.session.profile.email, req.session.googleTokens, {
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

// WhatsApp media proxy: client-sent photos arrive as media ids that need the
// WABA token to fetch (Meta's lookaside URLs are short-lived). The owner's
// session streams them through here so the inbox can render them.
app.get("/api/media/whatsapp/:mediaId", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    const accessToken = workspace?.metaConnections?.whatsapp?.accessToken || appConfig.waAccessToken;
    if (!workspace || !accessToken) return res.status(404).json({ error: "Media not available" });
    const mediaId = String(req.params.mediaId ?? "").replace(/[^\w.-]/g, "");
    if (!mediaId) return res.status(400).json({ error: "Bad media id" });

    const metaRes = await fetchWithTimeout(`https://graph.facebook.com/v23.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaRes.ok) return res.status(404).json({ error: "Media not available" });
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url) return res.status(404).json({ error: "Media not available" });

    const fileRes = await fetchWithTimeout(meta.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!fileRes.ok) return res.status(404).json({ error: "Media not available" });
    res.setHeader("Content-Type", meta.mime_type || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(Buffer.from(await fileRes.arrayBuffer()));
  } catch (error) {
    next(error);
  }
});

// Logo upload: same Drive-backed flow as portfolio images, saved to logoUrl.
app.post(
  "/api/workspace/logo/upload",
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
      const result = await uploadLogoImage(req.session.profile.email, req.session.googleTokens, {
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

// Cover photo upload: same Drive-backed flow, saved to coverImageUrl.
app.post(
  "/api/workspace/cover/upload",
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
      const result = await uploadCoverImage(req.session.profile.email, req.session.googleTokens, {
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

// ---- Custom domain ----
app.post("/api/workspace/custom-domain", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const domain = typeof req.body?.domain === "string" ? req.body.domain.trim().toLowerCase() : "";
    if (!domain) return res.status(400).json({ error: "Domain is required" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    workspace.config = { ...workspace.config, customDomain: domain };
    workspace.updatedAt = new Date().toISOString();
    await saveWorkspace(workspace);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspace/custom-domain/verify", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const domain = typeof req.query.domain === "string" ? req.query.domain.trim() : "";
    if (!domain) return res.status(400).json({ error: "Domain required" });
    // Simple DNS verification: try to resolve the domain and check it points to us
    const dns = await import("node:dns/promises");
    try {
      const records = await dns.resolveCname(domain);
      const live = records.some((r) => r.includes("busydays"));
      res.json({ ok: true, live, records });
    } catch {
      res.json({ ok: true, live: false });
    }
  } catch (error) {
    next(error);
  }
});

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

    // Snapshot her Google rating for the booking-page trust badge.
    const rating = Number(req.body?.rating);
    const reviewCount = Number(req.body?.userRatingsTotal);
    const googleReviewLink = buildGoogleReviewLink(placeId);
    const updated = await updateWorkspaceConfig(
      req.session.profile.email,
      {
        ...workspace.config,
        googleReviewLink,
        googleRating: Number.isFinite(rating) && rating > 0 && rating <= 5 ? String(rating) : workspace.config.googleRating,
        googleReviewCount: Number.isFinite(reviewCount) && reviewCount > 0 ? String(Math.round(reviewCount)) : workspace.config.googleReviewCount,
      },
      req.session.googleTokens,
    );
    res.json({ ok: true, googleReviewLink, workspace: scrubWorkspaceTokens(updated) });
  } catch (error) {
    next(error);
  }
});

// Paste-your-own-link path: the artist already has a Google review/Maps/Business
// link and just wants reviews pointed at it. Accept any Google URL, normalise a
// couple of common forms, and save it as the review link — no Maps API needed.
app.post("/api/gmb/set-link", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    let raw = typeof req.body?.link === "string" ? req.body.link.trim() : "";
    if (!raw) return res.status(400).json({ error: "Paste your Google link first." });
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return res.status(400).json({ error: "That doesn't look like a valid link. Copy it straight from Google." });
    }
    // Only accept Google-owned hosts so we never point clients somewhere wrong.
    const host = parsed.hostname.toLowerCase();
    const isGoogle =
      /(^|\.)google\.[a-z.]+$/.test(host) ||
      host === "g.page" ||
      host === "g.co" ||
      host === "goo.gl" ||
      host === "maps.app.goo.gl" ||
      host === "search.google.com";
    if (!isGoogle) {
      return res.status(400).json({ error: "Please paste a Google link (Maps, g.page, or your Google review link)." });
    }

    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const updated = await updateWorkspaceConfig(
      req.session.profile.email,
      { ...workspace.config, googleReviewLink: parsed.toString().slice(0, 600) },
      req.session.googleTokens,
    );
    res.json({ ok: true, googleReviewLink: updated.config.googleReviewLink, workspace: scrubWorkspaceTokens(updated) });
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

// ---- In-app Google Business Profile creation ----
// Whether she has granted the business.manage scope yet, and where to grant it.
app.get("/api/gmb/create-status", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    res.json({ ok: true, ...getGmbCreateStatus(workspace) });
  } catch (error) {
    next(error);
  }
});

// Creates her Google Business listing (service-area, "Make-up artist") from
// inside the product, and returns Google's verification options. Falls back
// with a clear reason when the scope or Google's API approval is missing.
app.post("/api/gmb/create-profile", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const body = (req.body ?? {}) as { businessName?: unknown; phone?: unknown; serviceAreas?: unknown; website?: unknown };
    const businessName = String(body.businessName ?? "").trim().slice(0, 120);
    const phone = String(body.phone ?? "").trim().slice(0, 25);
    const serviceAreas = Array.isArray(body.serviceAreas)
      ? body.serviceAreas.map((a) => String(a ?? "").trim()).filter(Boolean).slice(0, 20)
      : String(body.serviceAreas ?? "").split(",").map((a) => a.trim()).filter(Boolean).slice(0, 20);
    const website = String(body.website ?? "").trim().slice(0, 300) || undefined;
    if (!businessName || !phone || !serviceAreas.length) {
      return res.status(400).json({ error: "Business name, phone, and at least one city are required." });
    }

    const result = await createBusinessProfile(workspace, req.session.googleTokens, {
      businessName,
      phone,
      serviceAreas,
      website,
    });
    if (!result.ok) {
      return res.json({ ok: false, reason: result.reason, error: result.message });
    }
    res.json({
      ok: true,
      locationName: result.locationName,
      verificationOptions: result.verificationOptions.map((method) => ({
        method,
        label: VERIFICATION_LABELS[method] || method,
      })),
    });
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

// Reputation summary: aggregate rating, total reviews, unanswered count and response rate.
// Returns data from GMB API when available; falls back to cached Places rating.
app.get("/api/gmb/reputation", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const summary = await getReputationSummary(workspace, req.session.googleTokens);
    res.json({ ok: true, summary });
  } catch (error) {
    next(error);
  }
});

// Lists recent GMB Posts (updates/offers/events). Auto mode only.
app.get("/api/gmb/posts", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const result = await listGmbPosts(workspace, req.session.googleTokens);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Creates a new GMB Post (update, offer, or event). Auto mode only.
app.post("/api/gmb/post", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const summary = typeof req.body?.summary === "string" ? req.body.summary.trim() : "";
    if (summary.length < 10) {
      return res.status(400).json({ error: "Write at least a sentence for the post." });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const result = await createGmbPost(workspace, req.session.googleTokens, {
      summary,
      topicType: req.body?.topicType || "STANDARD",
      callToActionType: req.body?.callToActionType,
      callToActionUrl: req.body?.callToActionUrl,
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
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
      servicesContext: buildServicesContext(workspace.config),
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
    // Itemized usage for the current calendar month: count + credits per action,
    // so the artist can see exactly what the service is costing them (how many
    // WhatsApps, emails, e-sign documents, AI calls, etc.).
    const monthPrefix = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const usageMap: Record<string, { label: string; count: number; credits: number }> = {};
    for (const entry of wallet.ledger) {
      if (entry.type !== "debit") continue;
      if (!String(entry.createdAt || "").startsWith(monthPrefix)) continue;
      const label = entry.reason || "Other";
      if (!usageMap[label]) usageMap[label] = { label, count: 0, credits: 0 };
      usageMap[label].count += 1;
      usageMap[label].credits += entry.credits;
    }
    const usageThisMonth = Object.values(usageMap).sort((a, b) => b.credits - a.credits);
    const creditsUsedThisMonth = usageThisMonth.reduce((s, u) => s + u.credits, 0);
    res.json({
      ok: true,
      balanceCredits: wallet.balanceCredits,
      lowBalance: isLowBalance(wallet.balanceCredits),
      ledger: wallet.ledger.slice(0, 50),
      usageThisMonth,
      creditsUsedThisMonth,
      packs: CREDIT_PACKS,
      // What each automated action costs, so the artist can see where credits go
      // instead of running out without warning.
      costs: (Object.keys(USAGE_COSTS) as UsageKind[]).map((k) => ({
        label: USAGE_LABELS[k], credits: USAGE_COSTS[k],
      })),
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

// Venue autocomplete while typing. Quietly returns [] without a Maps key so
// the location fields degrade to plain inputs.
app.get("/api/maps/places", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const suggestions = await suggestPlaces(q).catch(() => []);
    res.json({ ok: true, suggestions });
  } catch (error) {
    next(error);
  }
});

// City autocomplete for the "your city" / base-location field. Cities only, so
// the artist picks a clean place name instead of typing it. [] without a key.
app.get("/api/maps/cities", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const suggestions = await suggestCities(q).catch(() => []);
    res.json({ ok: true, suggestions });
  } catch (error) {
    next(error);
  }
});

// Country dialling codes for the phone-number fields. Public (the booking page
// is unauthenticated) and tiny — India is the default since this is an India-first
// product. A curated short list covers the common diaspora; the field still
// accepts any typed number.
app.get("/api/config/phone-codes", (_req, res) => {
  res.json({
    ok: true,
    default: "+91",
    codes: [
      { code: "+91", label: "🇮🇳 India +91" },
      { code: "+1", label: "🇺🇸 USA/Canada +1" },
      { code: "+44", label: "🇬🇧 UK +44" },
      { code: "+971", label: "🇦🇪 UAE +971" },
      { code: "+61", label: "🇦🇺 Australia +61" },
      { code: "+65", label: "🇸🇬 Singapore +65" },
      { code: "+966", label: "🇸🇦 Saudi Arabia +966" },
      { code: "+60", label: "🇲🇾 Malaysia +60" },
      { code: "+64", label: "🇳🇿 New Zealand +64" },
      { code: "+974", label: "🇶🇦 Qatar +974" },
      { code: "+973", label: "🇧🇭 Bahrain +973" },
      { code: "+968", label: "🇴🇲 Oman +968" },
    ],
  });
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
      bio: typeof req.body.bio === "string" ? req.body.bio : undefined,
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

app.post("/api/team/:artistId/reactivate", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const artist = await reactivateArtist(
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

// Toggle the urgency flag on a lead (Urgent ↔ normal) — lets the owner star
// high-priority enquiries so they don't get buried in a long pipeline.
app.post("/api/leads/:leadId/flag", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const updated = await toggleLeadUrgency(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.leadId,
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
      parsed.lostReason,
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
      if (parsed.advanceAmount > 0 && result.booking?.bookingId) {
        // Record the actual rupees in the ledger so "collected" is right from day one.
        await recordBookingPayment(email, tokens, result.booking.bookingId, {
          amount: parsed.advanceAmount,
          method: "UPI",
          note: "Advance (recorded at booking)",
        });
      } else {
        await updatePaymentStatus(email, tokens, lead.leadId, "Advance Paid");
      }
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
    // Auto-tell the client the new details instead of leaving it to the artist.
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    const notified = workspace
      ? await notifyClientOfReschedule(req.session.profile.email, req.session.googleTokens, workspace, booking)
      : false;
    res.json({ ok: true, booking, notified });
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

    let notified = false;
    if (before.bookingId) {
      const scheduleChanged =
        (parsed.eventDate && parsed.eventDate !== before.eventDate) ||
        (parsed.eventTime !== undefined && parsed.eventTime !== before.eventTime) ||
        (parsed.locationText && parsed.locationText !== before.locationText);
      if (scheduleChanged) {
        // Reads the just-updated lead, so the recreated calendar event carries
        // the new venue/time even when only one of them changed.
        const movedBooking = await rescheduleBooking(email, tokens, before.bookingId, {
          eventDate: updated.eventDate,
          eventTime: updated.eventTime,
          venue: updated.locationText,
        }).catch(() => null);
        // A date/venue edit is a reschedule from the client's side — notify them.
        if (movedBooking) {
          const ws = await getWorkspaceByEmail(email);
          if (ws) notified = await notifyClientOfReschedule(email, tokens, ws, movedBooking).catch(() => false);
        }
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

    res.json({ ok: true, lead: updated, notified });
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

    // A cancellation frees the date — if anyone is waitlisted for it, surface
    // them immediately (in the response for the UI, and as a push so she sees
    // it even if she cancelled from elsewhere). Best-effort: a hiccup here
    // never undoes the cancellation.
    let waitlistCandidates: { leadId: string; clientName: string; eventType: string }[] = [];
    try {
      const workspace = await getWorkspaceByEmail(req.session.profile.email);
      if (workspace && booking.eventDate) {
        const { leads } = await getDashboardData(req.session.profile.email, req.session.googleTokens);
        waitlistCandidates = leads
          .filter(
            (lead) =>
              lead.source === "Waitlist" &&
              lead.eventDate === booking.eventDate &&
              !["Lost", "Completed"].includes(lead.status),
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((lead) => ({ leadId: lead.leadId, clientName: lead.clientName, eventType: lead.eventType }));
        if (waitlistCandidates.length) {
          await sendPushToWorkspace(workspace, {
            title: `A slot opened on ${booking.eventDate}`,
            body: `${waitlistCandidates[0].clientName || "A client"} is waiting for this date${waitlistCandidates.length > 1 ? ` (+${waitlistCandidates.length - 1} more)` : ""}. Offer them the slot?`,
            url: "/",
          });
        }
      }
    } catch {
      // Waitlist surfacing is best-effort.
    }

    res.json({ ok: true, booking, waitlistCandidates });
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
      servicesContext: buildServicesContext(workspace.config),
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
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    const booking = await recordBookingPayment(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
      parsed,
    );
    // Fire-and-forget: send payment receipt to the client on WhatsApp and email.
    if (workspace && parsed.type !== "refund") {
      sendPaymentReceipt(workspace, req.session.googleTokens, booking, parsed.amount).catch(() => undefined);
    }
    res.json({ ok: true, booking });
  } catch (error) {
    next(error);
  }
});

// Removes a mis-entered payment line. The index matches the modal's display
// order, which the client converts back to the stored (chronological) position.
app.delete("/api/bookings/:bookingId/payments/:index", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) {
      return res.status(400).json({ error: "Invalid payment entry." });
    }
    const booking = await deleteBookingPaymentEntry(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
      index,
    );
    res.json({ ok: true, booking });
  } catch (error) {
    next(error);
  }
});

// Refund an online (Razorpay) payment entry back to the client's card/UPI.
// Targets a ledger entry by index; the entry must carry a gateway ref. Records
// the refund as a ledger line so the balance reopens correctly.
app.post("/api/bookings/:bookingId/payments/:index/refund", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) {
      return res.status(400).json({ error: "Invalid payment entry." });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { razorpayKeyId, razorpayKeySecret } = workspace.config;
    if (!razorpayKeyId || !razorpayKeySecret) {
      return res.status(400).json({ error: "Online payments aren't set up, so this can't be auto-refunded. Record a manual refund instead." });
    }
    const booking = await getBookingRecord(req.session.profile.email, req.session.googleTokens, req.params.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const ledger = parsePaymentsLog(booking.paymentsLog);
    const entry = ledger[index];
    if (!entry) return res.status(404).json({ error: "That payment entry no longer exists — refresh and try again." });
    if (entry.kind === "refund") return res.status(400).json({ error: "That entry is already a refund." });
    if (!entry.ref) return res.status(400).json({ error: "This entry has no online payment reference, so it can't be auto-refunded. Record a manual refund instead." });

    // Optional partial amount; defaults to the full entry amount.
    const requested = Number(req.body?.amount);
    const amountInr = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.round(requested), entry.amount)
      : entry.amount;

    const refund = await createRefundWithKeys(
      { keyId: razorpayKeyId, keySecret: razorpayKeySecret },
      entry.ref,
      amountInr,
    );

    const updated = await recordBookingPayment(req.session.profile.email, req.session.googleTokens, req.params.bookingId, {
      amount: amountInr,
      method: "Razorpay",
      note: `Refund of ${entry.kind === "tip" ? "tip" : "payment"} (${refund.id})`,
      type: "refund",
      ref: refund.id,
    });
    res.json({ ok: true, booking: updated, refundId: refund.id, amount: amountInr, status: refund.status });
  } catch (error) {
    next(error);
  }
});

// Sends a payment receipt to the client via WhatsApp template (if configured)
// and email (if SMTP is set up). Fire-and-forget from the payments endpoint.
async function sendPaymentReceipt(
  workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceByEmail>>>,
  tokens: Credentials,
  booking: BookingRecord,
  paidAmount: number,
) {
  const templateName = String(workspace.config.receiptTemplate || "").trim();
  const clientPhone = String(booking.clientWhatsApp || "").replace(/[^\d]/g, "");
  if (templateName && clientPhone) {
    const whatsapp = workspace.metaConnections?.whatsapp;
    try {
      await sendWhatsAppTemplate(
        { accessToken: whatsapp?.accessToken, phoneNumberId: whatsapp?.phoneNumberId },
        clientPhone,
        templateName,
        String(workspace.config.receiptTemplateLang || "en"),
        [booking.clientName, `Rs. ${Math.round(paidAmount).toLocaleString("en-IN")}`, booking.eventType, booking.eventDate],
      );
    } catch (err) {
      logger.warn("Payment receipt WhatsApp send failed", { err: String(err), bookingId: booking.bookingId });
    }
  }
  if (emailEnabled(workspace.config) && booking.clientWhatsApp) {
    try {
      const payments = parsePaymentsLog(booking.paymentsLog);
      const totalPaid = paymentsTotal(payments);
      await sendEmail(workspace.config, {
        to: String(workspace.config.smtpFrom || workspace.config.smtpUser),
        subject: `Payment received: ${booking.clientName} — ${booking.eventType}`,
        html: wrapEmailHtml(
          workspace.config,
          `<h2>Payment Received</h2>
           <p>Hi ${esc(booking.clientName)},</p>
           <p>We've received your payment of <strong>Rs. ${Math.round(paidAmount).toLocaleString("en-IN")}</strong> for your ${esc(booking.eventType)} booking on ${esc(booking.eventDate)}.</p>
           <p>Total received so far: <strong>Rs. ${Math.round(totalPaid).toLocaleString("en-IN")}</strong> of Rs. ${Math.round(booking.finalPrice).toLocaleString("en-IN")}.</p>
           <p>Balance due: <strong>Rs. ${Math.round(Math.max(0, booking.balanceDue)).toLocaleString("en-IN")}</strong></p>
           <p>Thank you — ${esc(workspace.config.businessName || workspace.config.ownerName)}</p>`,
        ),
      });
    } catch (err) {
      logger.warn("Payment receipt email failed", { err: String(err), bookingId: booking.bookingId });
    }
  }
}

function esc(v: string) {
  return String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- Push notifications (web push for PWA, FCM for the native app) ----
// Public on purpose: the native app reads googleClientId here BEFORE sign-in to
// drive the native Google account picker (no browser tab). Every field is
// non-secret — a VAPID *public* key, feature booleans, and the OAuth client ID
// that already appears in every consent URL.
app.get("/api/push/config", (_req, res) => {
  res.json({ ok: true, enabled: pushConfigured(), publicKey: appConfig.vapidPublicKey, fcmEnabled: fcmConfigured(), googleClientId: appConfig.googleClientId || null, googleScopes: appConfig.googleScopes });
});

app.post("/api/push/subscribe", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    const sub = req.body?.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return res.status(400).json({ error: "Invalid subscription" });
    }
    await addPushSubscription(req.session.profile.email, {
      endpoint: String(sub.endpoint),
      keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/push/unsubscribe", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    await removePushSubscription(req.session.profile.email, String(req.body?.endpoint ?? ""));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// FCM device tokens from the native app. The app re-registers on every launch
// (tokens rotate), which addDeviceToken treats as an upsert.
app.post("/api/push/register-device", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    const token = String(req.body?.token ?? "").trim();
    const platform = String(req.body?.platform ?? "");
    if (!token || token.length > 4096) return res.status(400).json({ error: "Invalid device token" });
    if (platform !== "ios" && platform !== "android") return res.status(400).json({ error: "platform must be ios or android" });
    await addDeviceToken(req.session.profile.email, token, platform);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/push/unregister-device", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    await removeDeviceToken(req.session.profile.email, String(req.body?.token ?? ""));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ---- One-tap WhatsApp template setup ----
// Creates the full standard template pack on her connected WABA and wires the
// names into config — replacing the "go to Meta Business Manager and create
// these by hand" chore. Re-runnable: existing templates are left alone.
const WHATSAPP_TEMPLATE_PACK: Array<{ configKey: keyof WorkspaceConfig; langKey: keyof WorkspaceConfig; name: string; body: string; examples: string[] }> = [
  { configKey: "bookingConfirmTemplate", langKey: "bookingConfirmTemplateLang", name: "busydays_booking_request", body: "Hi {{1}}, we've received your {{2}} booking request for {{3}}. We'll confirm availability and get back to you shortly. Thank you!", examples: ["Priya", "Bridal Makeup", "2026-11-21"] },
  { configKey: "approvalTemplate", langKey: "approvalTemplateLang", name: "busydays_booking_approved", body: "Hi {{1}}, great news — your date {{2}} is available! Your personalised quote total is Rs {{3}}. Reply here and we'll lock it in.", examples: ["Priya", "2026-11-21", "18000"] },
  { configKey: "teamNotifyTemplate", langKey: "teamNotifyTemplateLang", name: "busydays_team_alert", body: "New job for you, {{1}}: a {{2}} on {{3}} at {{4}}. Please check the details with the studio.", examples: ["Pooja", "Bridal Makeup", "2026-11-21", "Taj Lands End"] },
  { configKey: "quoteTemplate", langKey: "quoteTemplateLang", name: "busydays_quote", body: "Hi {{1}}, your quote for {{2}} on {{3}} is ready. View and accept it here: {{4}}", examples: ["Priya", "Bridal Makeup", "2026-11-21", "https://example.com/q/abc"] },
  { configKey: "invoiceTemplate", langKey: "invoiceTemplateLang", name: "busydays_invoice", body: "Hi {{1}}, your invoice for {{2}} on {{3}} is ready here: {{4}}. Thank you!", examples: ["Priya", "Bridal Makeup", "2026-11-21", "https://example.com/d/invoice/abc"] },
  { configKey: "contractTemplate", langKey: "contractTemplateLang", name: "busydays_contract", body: "Hi {{1}}, your booking agreement for {{2}} on {{3}} is ready to review and sign: {{4}}", examples: ["Priya", "Bridal Makeup", "2026-11-21", "https://example.com/sign/abc"] },
  { configKey: "reminderTemplate", langKey: "reminderTemplateLang", name: "busydays_event_reminder", body: "Hi {{1}}, a quick reminder about your booking on {{2}} at {{3}}. We're looking forward to it!", examples: ["Priya", "2026-11-21", "10:00"] },
  { configKey: "collectionTemplate", langKey: "collectionTemplateLang", name: "busydays_payment_reminder", body: "Hi {{1}}, a gentle reminder: your {{2}} payment of Rs {{3}} for the booking on {{4}} is pending. Thank you!", examples: ["Priya", "advance", "5000", "2026-11-21"] },
  { configKey: "reviewTemplate", langKey: "reviewTemplateLang", name: "busydays_review_request", body: "Hi {{1}}, thank you for choosing {{2}}! If you loved your look, it would mean the world if you left us a quick review: {{3}}", examples: ["Priya", "Glow by Aisha", "https://g.page/review"] },
  { configKey: "rebookTemplate", langKey: "rebookTemplateLang", name: "busydays_rebook_nudge", body: "Hi {{1}}, it's been a while since your last visit to {{2}} — we'd love to see you again! Reply here to book your next look. 💕", examples: ["Priya", "Glow by Aisha"] },
  { configKey: "ownerAlertTemplate", langKey: "ownerAlertTemplateLang", name: "busydays_owner_alert", body: "BusyDays update: {{1}} — {{2}} on {{3}}.", examples: ["New request from Priya", "Bridal Makeup", "2026-11-21"] },
  { configKey: "waitlistOfferTemplate", langKey: "waitlistOfferTemplateLang", name: "busydays_waitlist_offer", body: "Hi {{1}}, good news — a slot just opened up on {{2}} for {{3}}! Reply here to claim it before it's gone.", examples: ["Priya", "2026-11-21", "Bridal Makeup"] },
];

app.post("/api/channels/whatsapp/templates/setup", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const whatsapp = workspace.metaConnections?.whatsapp;
    if (whatsapp?.status !== "connected" || !whatsapp.accessToken || !whatsapp.wabaId) {
      return res.status(400).json({ error: "Connect WhatsApp first (Channels tab), then run template setup." });
    }

    const results = [];
    // All the pack's config keys are string fields, so this patch is safe to
    // spread over the full config.
    const configPatch: Partial<WorkspaceConfig> = {};
    for (const tpl of WHATSAPP_TEMPLATE_PACK) {
      const result = await createWhatsAppTemplate(whatsapp.accessToken, whatsapp.wabaId, {
        name: tpl.name,
        body: tpl.body,
        examples: tpl.examples,
      });
      results.push(result);
      if (result.status !== "failed") {
        (configPatch as Record<string, string>)[tpl.configKey] = tpl.name;
        (configPatch as Record<string, string>)[tpl.langKey] = "en";
      }
    }

    // Wire the successfully created/existing template names into her config so
    // sends start using them immediately (once Meta approves).
    if (Object.keys(configPatch).length) {
      await updateWorkspaceConfig(
        req.session.profile.email,
        { ...workspace.config, ...configPatch },
        req.session.googleTokens,
      );
    }

    res.json({ ok: true, results });
  } catch (error) {
    next(error);
  }
});

// ---- Client profiles: private notes + bulk import ----
app.get("/api/clients/:phone/notes", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const notes = await loadClientNotes(workspace.workspaceId, String(req.params.phone ?? ""));
    res.json({ ok: true, ...notes });
  } catch (error) {
    next(error);
  }
});

app.post("/api/clients/:phone/notes", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const saved = await saveClientNotes(workspace.workspaceId, String(req.params.phone ?? ""), {
      notes: String(req.body?.notes ?? ""),
      birthday: typeof req.body?.birthday === "string" ? req.body.birthday : "",
    });
    res.json({ ok: true, ...saved });
  } catch (error) {
    next(error);
  }
});

// Unified client profile — aggregates all data we have on a single client by phone.
// Returns: basic info, all their leads + bookings, total revenue, loyalty status,
// and saved notes. Powers the "Client profile" drawer in the dashboard.
app.get("/api/clients/:phone/profile", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const phone = String(req.params.phone ?? "").replace(/\D/g, "");
    if (!phone) return res.status(400).json({ error: "Invalid phone" });

    const [{ leads, bookings }, notes] = await Promise.all([
      getDashboardData(req.session.profile.email, req.session.googleTokens),
      loadClientNotes(workspace.workspaceId, phone),
    ]);

    const clientLeads = leads.filter((l) => l.clientWhatsApp?.replace(/\D/g, "") === phone);
    const clientBookings = bookings.filter((b) => b.clientWhatsApp?.replace(/\D/g, "") === phone);

    const totalRevenue = clientBookings
      .filter((b) => b.status === "Confirmed" || b.status === "Completed")
      .reduce((s, b) => s + (b.finalPrice || 0), 0);

    const loyalty = loyaltyForPhone(workspace.config, bookings, phone);

    const clientName = clientBookings[0]?.clientName || clientLeads[0]?.clientName || "Client";
    const clientInstagram = clientLeads[0]?.clientInstagram || "";
    const firstBookingDate = [...clientLeads.map((l) => l.createdAt), ...clientBookings.map((b) => b.bookedAt)]
      .sort()[0] || "";

    res.json({
      ok: true,
      phone,
      clientName,
      clientInstagram,
      firstSeenAt: firstBookingDate,
      totalLeads: clientLeads.length,
      totalBookings: clientBookings.length,
      totalRevenue,
      leads: clientLeads.slice(0, 20),
      bookings: clientBookings.slice(0, 20),
      loyalty,
      notes: notes.notes || "",
      birthday: notes.birthday || "",
      tags: clientLeads[0]?.clientTags || "",
    });
  } catch (error) {
    next(error);
  }
});

// Bulk-imports existing clients (paste from Excel / CSV) as past clients.
app.post("/api/clients/import", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "Nothing to import — add at least one client." });
    if (rows.length > 500) return res.status(400).json({ error: "Import up to 500 clients at a time." });
    const result = await importClients(
      req.session.profile.email,
      req.session.googleTokens,
      rows.map((row: Record<string, unknown>) => ({
        clientName: String(row?.clientName ?? ""),
        clientWhatsApp: String(row?.clientWhatsApp ?? ""),
        eventType: String(row?.eventType ?? ""),
        eventDate: String(row?.eventDate ?? ""),
        locationText: String(row?.locationText ?? ""),
        clientTags: String(row?.clientTags ?? ""),
      })),
    );
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

// ---- Accountant / GST export ----
// One CSV with every invoice and its payments for a date range (defaults to
// the current Indian financial year) — what she hands to her accountant at
// tax time instead of reconstructing the year from WhatsApp chats.
app.get("/api/export/accountant", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    // Default: current Indian FY (1 April – 31 March).
    const now = new Date();
    const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
      ? req.query.from
      : `${fyStartYear}-04-01`;
    const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
      ? req.query.to
      : `${fyStartYear + 1}-03-31`;

    const { bookings } = await getDashboardData(req.session.profile.email, req.session.googleTokens);
    const gstPct = Number(workspace.config.gstPercentage) || 0;
    const esc = (value: unknown) => {
      const s = String(value ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const rows: string[] = [
      [
        "Invoice Number", "Invoice Date", "Client", "Client Phone", "Event Type", "Event Date",
        "Total (INR)", "Taxable Value (INR)", `GST @ ${gstPct}% (INR)`,
        "Received (INR)", "Refunded (INR)", "Balance Due (INR)", "Payment Status", "Booking Status", "Payments Detail",
      ].join(","),
    ];

    for (const booking of bookings) {
      const invoiceDate = (booking.invoiceGeneratedAt || booking.bookedAt || "").slice(0, 10);
      if (!invoiceDate || invoiceDate < from || invoiceDate > to) continue;
      if (!booking.invoiceUrl && !booking.invoiceGeneratedAt) continue;
      const log = parsePaymentsLog(booking.paymentsLog);
      const received = log.filter((p) => p.kind !== "refund").reduce((s, p) => s + p.amount, 0);
      const refunded = log.filter((p) => p.kind === "refund").reduce((s, p) => s + p.amount, 0);
      const total = Math.round(Number(booking.finalPrice) || 0);
      const taxable = gstPct > 0 ? Math.round(total / (1 + gstPct / 100)) : total;
      const gstAmount = total - taxable;
      const detail = log
        .map((p) => `${p.kind === "refund" ? "-" : ""}${p.amount} ${p.method} ${(p.at || "").slice(0, 10)}${p.note ? ` (${p.note})` : ""}`)
        .join("; ");
      rows.push([
        esc(booking.invoiceNumber || `INV-${booking.bookingId}`),
        esc(invoiceDate),
        esc(booking.clientName),
        esc(booking.clientWhatsApp),
        esc(booking.eventType),
        esc(booking.eventDate),
        String(total),
        String(taxable),
        String(gstAmount),
        String(received),
        String(refunded),
        String(Math.max(0, total - received + refunded)),
        esc(booking.paymentStatus),
        esc(booking.status),
        esc(detail),
      ].join(","));
    }

    const filename = `busydays-invoices-${from}-to-${to}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // UTF-8 BOM so Excel opens ₹/Indian names correctly.
    res.send("\uFEFF" + rows.join("\n"));
  } catch (error) {
    next(error);
  }
});

// ── Personal data export (GDPR / DPDPA right to portability) ─────────────────
// Returns a JSON bundle of everything BusyDays holds for this workspace.
// The artist's client data lives in their own Google Sheet; this covers what
// we store in our own database (workspace config, wallet, meta connections).
app.get("/api/export/my-data", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) return res.status(401).json({ error: "Unauthorized" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    // Scrub secrets before export — tokens and API keys are not personal data,
    // and sending them in a download would be a credential leak.
    const safe = scrubWorkspaceTokens(workspace);
    const optedOutPhones = await listOptedOutPhones(workspace.workspaceId);

    const exportBundle = {
      exportedAt: new Date().toISOString(),
      email: req.session.profile.email,
      workspaceId: workspace.workspaceId,
      config: safe?.config ?? {},
      wallet: safe?.wallet ?? null,
      metaConnections: safe?.metaConnections ?? {},
      whatsappOptouts: optedOutPhones,
      note: "Your leads, bookings and client records are stored in your own Google Sheet. Open it from Google Drive to export that data.",
    };

    const filename = `busydays-my-data-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(JSON.stringify(exportBundle, null, 2));
  } catch (error) {
    next(error);
  }
});

// ── Self-service workspace deletion ──────────────────────────────────────────
// GDPR / DPDPA Art. 17 right to erasure. Requires the artist to be signed in
// and to confirm deletion in the request body (prevents accidental deletes from
// e.g. a rogue prefetch). Session is destroyed afterward.
app.delete("/api/workspace", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    // Require explicit confirmation string to prevent accidental deletion.
    if (req.body?.confirm !== "DELETE MY WORKSPACE") {
      return res.status(400).json({ error: 'Send { "confirm": "DELETE MY WORKSPACE" } to confirm.' });
    }
    const email = req.session.profile.email;
    const deleted = await deleteWorkspace(email);
    if (!deleted) return res.status(404).json({ error: "Workspace not found." });

    // Destroy the session so the browser is immediately signed out.
    req.session.destroy(() => {
      res.json({ ok: true, message: "Your workspace has been permanently deleted. You have been signed out." });
    });
  } catch (error) {
    next(error);
  }
});

// ── WhatsApp opt-out management (artist view) ────────────────────────────────
// Artists can see who has opted out and re-add contacts who have re-consented.
app.get("/api/optouts/whatsapp", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const phones = await listOptedOutPhones(workspace.workspaceId);
    res.json({ ok: true, optedOut: phones });
  } catch (error) {
    next(error);
  }
});

// Re-opt-in: only the artist can do this, and only after the contact has
// confirmed they want to receive messages again (best handled via WhatsApp DM).
app.delete("/api/optouts/whatsapp/:phone", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const phone = String(req.params.phone ?? "").replace(/\D/g, "");
    if (!phone || phone.length < 8) return res.status(400).json({ error: "Invalid phone number." });
    await removePhoneOptOut(workspace.workspaceId, phone);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ── Re-engagement campaigns ─────────────────────────────────────────────────

app.get("/api/campaigns/reach", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) return res.status(401).json({ error: "Unauthorized" });
    const segment = (req.query.segment as CampaignSegment) || "past-clients";
    const count = await estimateCampaignReach(req.session.profile.email, req.session.googleTokens, segment);
    res.json({ ok: true, count });
  } catch (error) { next(error); }
});

// Starts the broadcast in the background and returns the job id right away —
// a 200-contact send takes ~3 minutes and must not hold a request open.
app.post("/api/campaigns/broadcast", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) return res.status(401).json({ error: "Unauthorized" });
    const { segment, message, imageUrl } = req.body as { segment: CampaignSegment; message: string; imageUrl?: string };
    if (!segment || !message?.trim()) return res.status(400).json({ error: "segment and message are required" });
    // Only forward a clean, public https image URL to WhatsApp — never a
    // file:/data:/javascript: scheme or a private-network address.
    if (imageUrl && !isPublicHttpUrl(imageUrl)) {
      return res.status(400).json({ error: "Image link must be a public https URL." });
    }
    const job = startCampaignBroadcast(req.session.profile.email, req.session.googleTokens, { segment, message: message.trim(), imageUrl });
    res.status(202).json({ ok: true, jobId: job.id });
  } catch (error) { next(error); }
});

app.get("/api/campaigns/jobs/:jobId", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    const job = await getCampaignJob(req.session.profile.email, req.params.jobId);
    if (!job) return res.status(404).json({ error: "Broadcast not found — it may have been interrupted by a restart. Check WhatsApp for what was delivered." });
    res.json({ ok: true, status: job.status, error: job.error, ...job.result });
  } catch (error) { next(error); }
});

// ── Birthday prompts ─────────────────────────────────────────────────────────
// Returns clients whose stored birthday falls in the next `days` days (default 7),
// so the dashboard can show a proactive "wish [Name] happy birthday" nudge.
// Computing it scans every client's notes record, so the result is cached for
// an hour — birthdays don't move, and this runs on every dashboard load.
const birthdaysSoonCache = new TtlCache<{ name: string; phone: string; birthday: string; daysUntil: number }[]>(60 * 60 * 1000);
app.get("/api/clients/birthdays-soon", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) return res.status(401).json({ error: "Unauthorized" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const daysAhead = Math.min(Math.max(Number(req.query.days) || 7, 1), 30);

    const cacheKey = `${workspace.workspaceId}:${daysAhead}:${new Date().toDateString()}`;
    const cached = birthdaysSoonCache.get(cacheKey);
    if (cached) return res.json({ ok: true, upcoming: cached });

    // Collect unique phones from leads.
    const { sheets } = createGoogleClients(req.session.googleTokens);
    const leadRes = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.leads}!A2:E`,
    });
    const leadRows = leadRes.data.values ?? [];
    const phoneNameMap = new Map<string, string>();
    for (const row of leadRows) {
      const name = String(row[3] ?? "").trim();
      const phone = String(row[4] ?? "").replace(/\D/g, "");
      if (phone.length >= 8 && name) phoneNameMap.set(phone, name);
    }

    const phones = Array.from(phoneNameMap.keys()).slice(0, 300);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const results: { name: string; phone: string; birthday: string; daysUntil: number }[] = [];

    await Promise.all(
      phones.map(async (phone) => {
        const notes = await loadClientNotes(workspace.workspaceId, phone);
        if (!notes.birthday) return;
        const [, mm, dd] = notes.birthday.split("-").map(Number);
        if (!mm || !dd) return;
        const next = new Date(today.getFullYear(), mm - 1, dd);
        if (next < today) next.setFullYear(today.getFullYear() + 1);
        const daysUntil = Math.round((next.getTime() - today.getTime()) / 86400000);
        if (daysUntil <= daysAhead) {
          results.push({ name: phoneNameMap.get(phone) ?? "Client", phone, birthday: notes.birthday, daysUntil });
        }
      }),
    );
    results.sort((a, b) => a.daysUntil - b.daysUntil);
    birthdaysSoonCache.set(cacheKey, results);
    res.json({ ok: true, upcoming: results });
  } catch (error) { next(error); }
});

// ── GST / tax summary (JSON) ──────────────────────────────────────────────────
// Returns a structured summary of bookings with GST breakdown for the Analytics
// tab. The CSV version (/api/export/accountant) is for accountants; this is
// for the in-app tax overview widget.
app.get("/api/reports/gst", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) return res.status(401).json({ error: "Unauthorized" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const now = new Date();
    const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const defaultFrom = `${fyStartYear}-04-01`;
    const defaultTo = `${fyStartYear + 1}-03-31`;
    const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : defaultFrom;
    const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : defaultTo;

    const { bookings } = await getDashboardData(req.session.profile.email, req.session.googleTokens);
    const gstPct = Number(workspace.config.gstPercentage) || 0;
    const gstNumber = workspace.config.gstNumber || "";

    const rows: {
      invoiceNumber: string; invoiceDate: string; clientName: string;
      eventType: string; eventDate: string; total: number; taxable: number;
      gstAmount: number; received: number; paymentStatus: string; bookingStatus: string;
    }[] = [];

    for (const booking of bookings) {
      const invoiceDate = (booking.invoiceGeneratedAt || booking.bookedAt || "").slice(0, 10);
      if (!invoiceDate || invoiceDate < from || invoiceDate > to) continue;
      const log = parsePaymentsLog(booking.paymentsLog);
      const received = log.filter((p: { kind?: string }) => p.kind !== "refund").reduce((s: number, p: { amount?: number }) => s + (p.amount || 0), 0);
      const total = Math.round(Number(booking.finalPrice) || 0);
      const taxable = gstPct > 0 ? Math.round(total / (1 + gstPct / 100)) : total;
      const gstAmount = total - taxable;
      rows.push({
        invoiceNumber: booking.invoiceNumber || `INV-${booking.bookingId}`,
        invoiceDate,
        clientName: booking.clientName,
        eventType: booking.eventType,
        eventDate: booking.eventDate,
        total,
        taxable,
        gstAmount,
        received,
        paymentStatus: booking.paymentStatus,
        bookingStatus: booking.status,
      });
    }
    rows.sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));

    const totalGross = rows.reduce((s, r) => s + r.total, 0);
    const totalTaxable = rows.reduce((s, r) => s + r.taxable, 0);
    const totalGst = rows.reduce((s, r) => s + r.gstAmount, 0);
    const totalReceived = rows.reduce((s, r) => s + r.received, 0);

    res.json({ ok: true, from, to, gstPct, gstNumber, rows, totals: { gross: totalGross, taxable: totalTaxable, gst: totalGst, received: totalReceived } });
  } catch (error) { next(error); }
});

// ── Monthly business recap ───────────────────────────────────────────────────

app.get("/api/recap/monthly", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) return res.status(401).json({ error: "Unauthorized" });
    const now = new Date();
    // Default: previous month so the month is complete.
    const year = req.query.year ? Number(req.query.year) : (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());
    const month = req.query.month !== undefined ? Number(req.query.month) : (now.getMonth() === 0 ? 11 : now.getMonth() - 1);
    const recap = await getMonthlyRecap(req.session.profile.email, req.session.googleTokens, year, month);
    res.json({ ok: true, recap });
  } catch (error) { next(error); }
});

app.post("/api/recap/send-whatsapp", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) return res.status(401).json({ error: "Unauthorized" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const now = new Date();
    const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const month = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    const recap = await getMonthlyRecap(req.session.profile.email, req.session.googleTokens, year, month);

    const ownerPhone = String(workspace.config.ownerWhatsApp || "").replace(/\D/g, "");
    if (!ownerPhone || ownerPhone.length < 8) return res.status(400).json({ error: "Set your WhatsApp number in Settings first." });

    const msg = [
      `📊 *${recap.month} Business Recap — ${workspace.config.businessName || "BusyDays"}*`,
      ``,
      `💌 New enquiries: *${recap.newLeads}*`,
      `📅 Bookings confirmed: *${recap.confirmedBookings}*`,
      recap.newClients > 0 ? `🆕 New clients: *${recap.newClients}*` : null,
      ``,
      `💰 Revenue booked: *₹${recap.totalRevenue.toLocaleString("en-IN")}*`,
      `✅ Collected: *₹${recap.collected.toLocaleString("en-IN")}*`,
      recap.avgBookingValue > 0 ? `📈 Avg booking: *₹${recap.avgBookingValue.toLocaleString("en-IN")}*` : null,
      recap.topEventType && recap.topEventType !== "—" ? `🏆 Top occasion: *${recap.topEventType}*` : null,
    ].filter(Boolean).join("\n");

    const connection = workspace.metaConnections?.whatsapp;
    const accessToken = connection?.accessToken || appConfig.waAccessToken;
    const phoneNumberId = connection?.phoneNumberId || appConfig.waPhoneNumberId;
    if (!accessToken || !phoneNumberId) {
      return res.status(400).json({ error: "Connect WhatsApp first to send this recap." });
    }

    const waUrl = new URL(`https://graph.facebook.com/v23.0/${phoneNumberId}/messages`);
    const proof = buildAppSecretProof(accessToken);
    if (proof) waUrl.searchParams.set("appsecret_proof", proof);
    const waResp = await fetch(waUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to: ownerPhone, type: "text", text: { body: msg } }),
    });
    if (!waResp.ok) {
      const errText = await waResp.text();
      return res.status(502).json({ ok: false, error: `WhatsApp delivery failed: ${errText}` });
    }
    res.json({ ok: true, month: recap.month });
  } catch (error) { next(error); }
});

// ── Client self-service reschedule links ─────────────────────────────────────

app.post("/api/bookings/:bookingId/reschedule-link", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) return res.status(401).json({ error: "Unauthorized" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const booking = await getBookingRecord(req.session.profile.email, req.session.googleTokens, req.params.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const url = buildRescheduleUrl(workspace.workspaceId, req.params.bookingId);

    if (req.body?.send && booking.clientWhatsApp) {
      const phone = String(booking.clientWhatsApp).replace(/\D/g, "");
      const connection = workspace.metaConnections?.whatsapp;
      const accessToken = connection?.accessToken || appConfig.waAccessToken;
      const phoneNumberId = connection?.phoneNumberId || appConfig.waPhoneNumberId;
      if (accessToken && phoneNumberId) {
        const msg = `Hi ${booking.clientName} 🙏\n\nNeed to change the date for your ${booking.eventType} booking? Use this link to pick a new date that works for you:\n${url}\n\n— ${workspace.config.businessName || workspace.config.ownerName}`;
        const waUrl = `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`;
        await fetch(waUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "text", text: { body: msg } }),
        }).catch(() => null);
      }
    }
    res.json({ ok: true, url });
  } catch (error) { next(error); }
});

// Public reschedule page.
app.get("/reschedule/:workspaceId/:bookingId", async (req, res, next) => {
  try {
    const { workspaceId, bookingId } = req.params;
    const { sig, exp } = req.query as { sig?: string; exp?: string };
    if (!verifyRescheduleToken(workspaceId, bookingId, exp ?? "", sig ?? "")) {
      return res.status(410).send("<html><body style='font-family:sans-serif;padding:40px;max-width:480px;margin:auto'><h2>Link expired</h2><p>This reschedule link has expired or is invalid. Ask the studio to send you a new one.</p></body></html>");
    }
    // Serve the reschedule page — workspace and booking details fetched client-side.
    const path = await import("node:path");
    res.sendFile(path.join(process.cwd(), "public", "reschedule.html"));
  } catch (error) { next(error); }
});

// API endpoint the reschedule page calls to load workspace + booking details.
app.get("/api/public/:workspaceId/reschedule/:bookingId", async (req, res, next) => {
  try {
    const { workspaceId, bookingId } = req.params;
    const { sig, exp } = req.query as { sig?: string; exp?: string };
    if (!verifyRescheduleToken(workspaceId, bookingId, exp ?? "", sig ?? "")) {
      return res.status(410).json({ error: "Link expired" });
    }
    const workspace = await findWorkspaceByWorkspaceId(workspaceId);
    if (!workspace) return res.status(404).json({ error: "Not found" });

    const tokens = await getWorkspaceCredentials(workspace.email);
    if (!tokens) return res.status(503).json({ error: "Service temporarily unavailable" });

    const booking = await getBookingRecord(workspace.email, tokens, bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    res.json({
      ok: true,
      businessName: workspace.config.businessName || workspace.config.ownerName,
      brandColor: workspace.config.brandColor || "#C26B45",
      booking: {
        bookingId: booking.bookingId,
        leadId: booking.leadId || "",
        clientName: booking.clientName,
        eventType: booking.eventType,
        eventDate: booking.eventDate,
        eventTime: booking.eventTime,
        venue: booking.venue,
      },
      availability: buildAvailability(workspace.config),
    });
  } catch (error) { next(error); }
});

// Client submits their chosen new date on the reschedule page.
app.post("/api/public/:workspaceId/reschedule/:bookingId", publicWriteLimiter, async (req, res, next) => {
  try {
    const workspaceId = String(req.params.workspaceId);
    const bookingId = String(req.params.bookingId);
    const { sig, exp } = req.query as { sig?: string; exp?: string };
    if (!verifyRescheduleToken(workspaceId, bookingId, exp ?? "", sig ?? "")) {
      return res.status(410).json({ error: "Link expired" });
    }
    const { eventDate, eventTime } = req.body as { eventDate?: string; eventTime?: string };
    if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return res.status(400).json({ error: "A valid date is required (YYYY-MM-DD)." });
    }

    const workspace = await findWorkspaceByWorkspaceId(workspaceId);
    if (!workspace) return res.status(404).json({ error: "Not found" });

    const tokens = await getWorkspaceCredentials(workspace.email);
    if (!tokens) return res.status(503).json({ error: "Service temporarily unavailable" });

    // Guard the new date against the same availability rules the booking page
    // enforces — previously the reschedule flow accepted any future date,
    // letting clients land on blocked, off, or already-full days.
    const existing = await getBookingRecord(workspace.email, tokens, bookingId);
    if (!existing) return res.status(404).json({ error: "Booking not found" });
    const check = await checkPublicAvailability(workspaceId, existing.eventType, eventDate, eventTime);
    if (!check.ok) return res.status(409).json({ error: check.error });

    await rescheduleBooking(workspace.email, tokens, bookingId, { eventDate, eventTime });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ── Client self-service cancellation ─────────────────────────────────────────

// Today's date in the studio's operating zone (IST), as "YYYY-MM-DD". Anchoring
// to IST rather than UTC matters: for the last 5.5h of an IST day a UTC "today"
// is already tomorrow, which would flip cancellation-fee windows and overdue
// tags a day early for everyone in India. en-CA formats as ISO YYYY-MM-DD.
function istToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// Days between today and the event (date-only, IST-anchored), floored at 0.
function daysUntilEvent(eventDate: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return Number.POSITIVE_INFINITY;
  const today = new Date(istToday() + "T00:00:00Z").getTime();
  const event = new Date(eventDate + "T00:00:00Z").getTime();
  return Math.max(0, Math.round((event - today) / 86_400_000));
}

// The cancellation fee this booking would incur right now: a percentage of the
// price, but only when cancelling inside the late-cancellation window.
function cancellationFeeFor(config: WorkspaceConfig, finalPrice: number, eventDate: string) {
  const windowDays = Math.max(0, Number(config.cancellationWindowDays) || 0);
  const feePercent = Math.max(0, Math.min(100, Number(config.cancellationFeePercent) || 0));
  const days = daysUntilEvent(eventDate);
  const withinWindow = days <= windowDays;
  const feeAmount = withinWindow ? Math.round((Number(finalPrice) || 0) * feePercent / 100) : 0;
  return { windowDays, feePercent, daysUntil: days, withinWindow, feeAmount };
}

app.post("/api/bookings/:bookingId/cancel-link", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) return res.status(401).json({ error: "Unauthorized" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const booking = await getBookingRecord(req.session.profile.email, req.session.googleTokens, req.params.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const url = buildCancelUrl(workspace.workspaceId, req.params.bookingId);

    if (req.body?.send && booking.clientWhatsApp) {
      const phone = String(booking.clientWhatsApp).replace(/\D/g, "");
      const connection = workspace.metaConnections?.whatsapp;
      const accessToken = connection?.accessToken || appConfig.waAccessToken;
      const phoneNumberId = connection?.phoneNumberId || appConfig.waPhoneNumberId;
      if (accessToken && phoneNumberId) {
        const msg = `Hi ${booking.clientName} 🙏\n\nNeed to cancel your ${booking.eventType} booking? You can do it here:\n${url}\n\n— ${workspace.config.businessName || workspace.config.ownerName}`;
        const waUrl = `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`;
        await fetch(waUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "text", text: { body: msg } }),
        }).catch(() => null);
      }
    }
    res.json({ ok: true, url });
  } catch (error) { next(error); }
});

// Public cancel page (token-gated).
app.get("/cancel/:workspaceId/:bookingId", async (req, res, next) => {
  try {
    const { workspaceId, bookingId } = req.params;
    const { sig, exp } = req.query as { sig?: string; exp?: string };
    if (!verifyCancelToken(workspaceId, bookingId, exp ?? "", sig ?? "")) {
      return res.status(410).send("<html><body style='font-family:sans-serif;padding:40px;max-width:480px;margin:auto'><h2>Link expired</h2><p>This cancellation link has expired or is invalid. Please contact the studio directly.</p></body></html>");
    }
    const path = await import("node:path");
    res.sendFile(path.join(process.cwd(), "public", "cancel.html"));
  } catch (error) { next(error); }
});

// Details for the cancel page: booking summary + what cancelling now would cost.
app.get("/api/public/:workspaceId/cancel/:bookingId", async (req, res, next) => {
  try {
    const { workspaceId, bookingId } = req.params;
    const { sig, exp } = req.query as { sig?: string; exp?: string };
    if (!verifyCancelToken(workspaceId, bookingId, exp ?? "", sig ?? "")) {
      return res.status(410).json({ error: "Link expired" });
    }
    const workspace = await findWorkspaceByWorkspaceId(workspaceId);
    if (!workspace) return res.status(404).json({ error: "Not found" });
    const tokens = await getWorkspaceCredentials(workspace.email);
    if (!tokens) return res.status(503).json({ error: "Service temporarily unavailable" });
    const booking = await getBookingRecord(workspace.email, tokens, bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const alreadyCancelled = booking.status === "Cancelled";
    const paid = paymentsTotal(parsePaymentsLog(booking.paymentsLog));
    const fee = cancellationFeeFor(workspace.config, booking.finalPrice, booking.eventDate);
    res.json({
      ok: true,
      businessName: workspace.config.businessName || workspace.config.ownerName,
      brandColor: workspace.config.brandColor || "#C26B45",
      alreadyCancelled,
      cancellationPolicy: workspace.config.cancellationPolicy || "",
      booking: {
        clientName: booking.clientName,
        leadId: booking.leadId || "",
        eventType: booking.eventType,
        eventDate: booking.eventDate,
        eventTime: booking.eventTime,
        venue: booking.venue,
        finalPrice: booking.finalPrice,
      },
      paidSoFar: paid,
      ...fee,
    });
  } catch (error) { next(error); }
});

// Client confirms the cancellation.
app.post("/api/public/:workspaceId/cancel/:bookingId", publicWriteLimiter, async (req, res, next) => {
  try {
    const workspaceId = String(req.params.workspaceId ?? "");
    const bookingId = String(req.params.bookingId ?? "");
    const { sig, exp } = req.query as { sig?: string; exp?: string };
    if (!verifyCancelToken(workspaceId, bookingId, exp ?? "", sig ?? "")) {
      return res.status(410).json({ error: "Link expired" });
    }
    const workspace = await findWorkspaceByWorkspaceId(workspaceId);
    if (!workspace) return res.status(404).json({ error: "Not found" });
    const tokens = await getWorkspaceCredentials(workspace.email);
    if (!tokens) return res.status(503).json({ error: "Service temporarily unavailable" });

    const existing = await getBookingRecord(workspace.email, tokens, bookingId);
    if (!existing) return res.status(404).json({ error: "Booking not found" });
    const fee = cancellationFeeFor(workspace.config, existing.finalPrice, existing.eventDate);

    if (existing.status !== "Cancelled") {
      await cancelBooking(workspace.email, tokens, bookingId);
      // Log who cancelled, and flag the fee so the artist can follow up.
      await logInteractionForWorkspace(workspace.email, tokens, {
        leadId: existing.leadId || bookingId,
        direction: "Inbound",
        channel: "WhatsApp",
        actor: existing.clientWhatsApp || bookingId,
        message: `Client cancelled their ${existing.eventType} on ${existing.eventDate} via the cancellation link.${fee.feeAmount > 0 ? ` Late-cancellation fee applies: ₹${fee.feeAmount} (${fee.feePercent}%).` : ""}`,
        aiSummary: "Client self-cancelled the booking",
      }).catch(() => {});
      // A freed date may have waiting clients — nudge the artist.
      try {
        const { leads } = await getDashboardData(workspace.email, tokens);
        const waiting = leads.filter(
          (lead) => lead.source === "Waitlist" && lead.eventDate === existing.eventDate && !["Lost", "Completed"].includes(lead.status),
        );
        if (waiting.length) {
          await sendPushToWorkspace(workspace, {
            title: `A slot opened on ${existing.eventDate}`,
            body: `${waiting[0].clientName || "A client"} is waiting for this date${waiting.length > 1 ? ` (+${waiting.length - 1} more)` : ""}. Offer them the slot?`,
            url: "/",
          });
        }
      } catch { /* best-effort */ }
    }
    res.json({ ok: true, feeAmount: fee.feeAmount, feePercent: fee.feePercent, withinWindow: fee.withinWindow });
  } catch (error) { next(error); }
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
    if (lead.quoteVoidedAt) {
      return res.status(400).json({ error: "This quote is voided — clear the void before regenerating it." });
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

    // Generate the quote PDF first, regardless of how it's delivered — so the
    // artist always has a shareable document even without a connected Meta
    // channel (the common case).
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
    const channelContext = resolveLeadMessagingContext(workspace, lead);

    if (!channelContext) {
      // No connected WhatsApp/Instagram → hand the artist a ready-to-send wa.me
      // link with the quote message; the PDF is already generated above.
      const waLink = buildWaMeReminderLink(currentLead.clientWhatsApp, message);
      if (!waLink) {
        return res.status(400).json({ error: "This client has no WhatsApp number on file — add one to share the quote." });
      }
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
      await appendFollowUpLog(req.session.profile.email, req.session.googleTokens, {
        leadId: currentLead.leadId,
        type: "Quote Shared",
        channel: "WhatsApp",
        messagePreview: message,
        status: "Sent",
      }).catch(() => {});
      return res.json({ ok: true, lead: currentLead, waLink, manual: true });
    }

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
    if (booking.invoiceVoidedAt) {
      return res.status(400).json({ error: "This invoice is voided — clear the void before regenerating it." });
    }

    booking = await ensureInvoiceNumber(req.session.profile.email, req.session.googleTokens, booking);
    const invoice = await generateInvoiceDocument(workspace, req.session.googleTokens, booking);
    const dueDays = Number(workspace.config.invoiceDueDays) || 0;
    // Anchor the due date to the IST calendar day, not UTC — otherwise a "due in
    // N days" set late in the IST evening lands a day early.
    const dueBase = new Date(`${istToday()}T00:00:00+05:30`);
    const invoiceDueDate = booking.invoiceDueDate || (dueDays > 0
      ? new Date(dueBase.getTime() + dueDays * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
      : "");
    const updatedBooking = await updateBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
      (current) => ({
        ...current,
        invoiceUrl: invoice.fileUrl,
        invoiceGeneratedAt: new Date().toISOString(),
        invoiceDueDate: current.invoiceDueDate || invoiceDueDate,
      }),
    );

    res.json({ ok: true, booking: updatedBooking, invoice });
  } catch (error) {
    next(error);
  }
});

// Set or update the invoice due date independently of regenerating the invoice.
app.post("/api/bookings/:bookingId/due-date", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) return res.status(401).json({ error: "Unauthorized" });
    const dueDate = String(req.body?.dueDate ?? "").trim();
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return res.status(400).json({ error: "dueDate must be YYYY-MM-DD" });
    }
    const updated = await updateBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
      (current) => ({ ...current, invoiceDueDate: dueDate }),
    );
    res.json({ ok: true, booking: updated });
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

    // Generate the invoice PDF first regardless of delivery channel.
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
    const channelContext = resolveLeadMessagingContext(workspace, lead);

    if (!channelContext) {
      // No connected channel → wa.me fallback with the invoice already generated.
      const waLink = buildWaMeReminderLink(currentBooking.clientWhatsApp, message);
      if (!waLink) {
        return res.status(400).json({ error: "This client has no WhatsApp number on file — add one to share the invoice." });
      }
      await appendFollowUpLog(req.session.profile.email, req.session.googleTokens, {
        leadId: lead.leadId,
        type: "Invoice Shared",
        channel: "WhatsApp",
        messagePreview: message,
        status: "Sent",
      }).catch(() => {});
      return res.json({ ok: true, booking: currentBooking, waLink, manual: true });
    }

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

    // Also send via email when SMTP is configured — client gets both channels.
    if (emailEnabled(workspace.config)) {
      sendEmail(workspace.config, {
        to: String(lead.clientInstagram || lead.clientWhatsApp || ""),
        subject: `Your invoice from ${workspace.config.businessName || workspace.config.ownerName} — ${currentBooking.invoiceNumber || ""}`,
        html: wrapEmailHtml(workspace.config, `
          <h2>Your Invoice</h2>
          <p>Hi ${esc(currentBooking.clientName)},</p>
          <p>Please find your invoice for your <strong>${esc(currentBooking.eventType)}</strong> booking on <strong>${esc(currentBooking.eventDate)}</strong>.</p>
          <p style="margin:16px 0;"><a href="${esc(currentBooking.invoiceUrl || "")}" style="background:${workspace.config.brandColor || "#C26B45"};color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">View & Pay Invoice</a></p>
          <p>Amount due: <strong>Rs. ${Math.round(currentBooking.balanceDue).toLocaleString("en-IN")}</strong></p>
          <p>Thank you — ${esc(workspace.config.businessName || workspace.config.ownerName)}</p>
        `),
      })
        .then((r) => { if (r?.ok) meterUsage(workspace.email, "email").catch(() => {}); })
        .catch(() => undefined);
    }

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
    discountPercent?: unknown;
    priceRangeLow?: unknown;
    priceRangeHigh?: unknown;
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
  const discountRaw = Number(input.discountPercent);
  const rangeLowRaw = Number(input.priceRangeLow);
  const rangeHighRaw = Number(input.priceRangeHigh);
  const hasRange =
    Number.isFinite(rangeLowRaw) && Number.isFinite(rangeHighRaw) && rangeLowRaw > 0 && rangeHighRaw > rangeLowRaw;
  const adjustments = {
    amountOverride: Number.isFinite(amountOverrideRaw) && amountOverrideRaw > 0 ? amountOverrideRaw : undefined,
    lineItems: lineItems.length ? lineItems : undefined,
    note: typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 600) : undefined,
    discountPercent:
      Number.isFinite(discountRaw) && discountRaw > 0 && discountRaw < 100
        ? Math.round(discountRaw * 100) / 100
        : undefined,
    // Range estimate ("Rs 12,000 – 15,000"); only stored as a valid pair.
    priceRangeLow: hasRange ? Math.round(rangeLowRaw) : undefined,
    priceRangeHigh: hasRange ? Math.round(rangeHighRaw) : undefined,
  };
  // Empty edit clears the adjustments entirely.
  if (
    !adjustments.amountOverride &&
    !adjustments.lineItems &&
    !adjustments.note &&
    !adjustments.discountPercent &&
    !adjustments.priceRangeLow
  ) return "";
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
    // Range-mode quotes show the estimate band, not a single number.
    const quoteAdj = parseDocumentAdjustments(lead.quoteAdjustments);
    const amountLabel =
      quoteAdj.priceRangeLow && quoteAdj.priceRangeHigh
        ? `₹${Math.round(quoteAdj.priceRangeLow).toLocaleString("en-IN")} – ₹${Math.round(quoteAdj.priceRangeHigh).toLocaleString("en-IN")}`
        : `₹${Math.round(quoteAdj.amountOverride || amount).toLocaleString("en-IN")}`;

    // Link to the pay.html page for deposit capture — only shown when Razorpay keys are configured.
    const hasRazorpay = Boolean(workspace.config.razorpayKeyId && workspace.config.razorpayKeySecret);
    const payUrl = hasRazorpay && !accepted && !voided
      ? `/pay/${encodeURIComponent(workspaceId)}/${encodeURIComponent(leadId)}`
      : undefined;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderQuotePage({
      brand,
      brandColor,
      clientName: lead.clientName,
      eventType: lead.eventType,
      eventDate: lead.eventDate,
      amountLabel,
      holdExpiresAt: lead.holdExpiresAt || undefined,
      pdfUrl,
      payUrl,
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

    const clientNote = typeof req.body?.clientNote === "string" ? req.body.clientNote.slice(0, 500).trim() : "";
    if (!lead.quoteAcceptedAt) {
      await updateLeadRecord(workspace.email, workspace.googleTokens, leadId, (current) => ({
        ...current,
        quoteAcceptedAt: current.quoteAcceptedAt || new Date().toISOString(),
        clientNote: current.clientNote || clientNote,
      }));
      await logInteractionForWorkspace(workspace.email, workspace.googleTokens, {
        leadId,
        direction: "Inbound",
        channel: "WhatsApp",
        actor: lead.clientWhatsApp || lead.clientName || "client",
        message: `${lead.clientName || "Client"} accepted the quote for ${lead.eventType} on ${lead.eventDate}.${clientNote ? ` Client note: "${clientNote}"` : ""}`,
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
  amountLabel: string;
  holdExpiresAt?: string;
  pdfUrl: string;
  payUrl?: string;
  accepted: boolean;
  voided: boolean;
  acceptUrl: string;
  ownerWhatsApp: string;
}): string {
  const escQ = (v: string) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  const title = `Quote from ${escQ(input.brand)}`;
  const desc = `${escQ(input.eventType)} on ${escQ(input.eventDate)} — ${escQ(input.amountLabel)}`;
  let expiryBlock = "";
  if (input.holdExpiresAt) {
    try {
      const exp = new Date(input.holdExpiresAt);
      if (!Number.isNaN(exp.getTime())) {
        const formatted = exp.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
        const isExpired = exp < new Date();
        expiryBlock = isExpired
          ? `<div class="expiry expired">⏰ This quote expired on ${escQ(formatted)}</div>`
          : `<div class="expiry">🕐 Valid until ${escQ(formatted)}</div>`;
      }
    } catch { /* ignore */ }
  }
  const noteField = `<textarea id="client-note" placeholder="Any questions or special requests? (optional)" rows="3" style="width:100%;margin-top:12px;padding:10px 12px;border:1.5px solid #eee3da;border-radius:10px;font-size:14px;font-family:inherit;resize:vertical;"></textarea>`;
  const payBtn = input.payUrl
    ? `<a href="${escQ(input.payUrl)}" class="pay-btn">💳 Pay Deposit Now</a>`
    : "";
  const acceptedBlock = `<div class="accepted">💚 You've accepted this quote. ${escQ(input.brand)} will be in touch to confirm your booking!</div>`;
  const voidedBlock = `<div class="voided">This quote has been updated — please ask ${escQ(input.brand)} for the latest version.</div>`;
  const actionBlock = input.voided
    ? voidedBlock
    : input.accepted
      ? acceptedBlock
      : `${noteField}
         <button id="accept-btn" type="button">💖 Looks perfect — I accept</button>
         ${payBtn}
         <p class="hint">Accepting lets ${escQ(input.brand)} know you're ready. She'll confirm your date right after.</p>`;
  const waLink = input.ownerWhatsApp
    ? `<a class="wa" href="https://wa.me/${escQ(input.ownerWhatsApp)}" target="_blank" rel="noreferrer">💬 Questions? WhatsApp ${escQ(input.brand)}</a>`
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
  .expiry { background: #fff8ef; border: 1px solid #f5d9a8; border-radius: 10px; padding: 10px 14px; font-size: 13px; color: #7a5c20; margin-bottom: 14px; }
  .expiry.expired { background: #fdf1ef; border-color: #f3cdc5; color: #9a3c2e; }
  iframe { width: 100%; height: 70vh; border: 1px solid #eee3da; border-radius: 12px; background: #fff; }
  #accept-btn { display: block; width: 100%; margin-top: 12px; padding: 15px; font-size: 16.5px; font-weight: 600; color: #fff; background: var(--brand); border: 0; border-radius: 12px; cursor: pointer; }
  #accept-btn:disabled { opacity: .6; }
  .pay-btn { display: block; width: 100%; margin-top: 10px; padding: 13px; font-size: 15px; font-weight: 600; color: var(--brand); background: #fff; border: 2px solid var(--brand); border-radius: 12px; cursor: pointer; text-align: center; text-decoration: none; }
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
  <p>Hi ${escQ(input.clientName || "there")} — here's your personalised quote ✨</p>
</header>
<main>
  <div class="summary">
    <div class="row"><span>Occasion</span><b>${escQ(input.eventType)}</b></div>
    <div class="row"><span>Date</span><b>${escQ(input.eventDate)}</b></div>
    <div class="row"><span>Quoted amount</span><b class="amount">${escQ(input.amountLabel)}</b></div>
  </div>
  ${expiryBlock}
  <iframe src="${escQ(input.pdfUrl)}" title="Quote PDF"></iframe>
  <div id="action-area">${actionBlock}</div>
  ${waLink}
</main>
<footer>Powered by BusyDays</footer>
<script>
  const btn = document.getElementById("accept-btn");
  if (btn) btn.addEventListener("click", async () => {
    btn.disabled = true; btn.textContent = "Sending…";
    const note = document.getElementById("client-note")?.value || "";
    try {
      const res = await fetch(${JSON.stringify(input.acceptUrl)}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientNote: note }),
      });
      if (!res.ok) throw new Error();
      document.getElementById("action-area").innerHTML = '<div class="accepted">💚 Accepted! ${escQ(input.brand)} has been notified and will confirm your booking shortly.</div>';
    } catch {
      btn.disabled = false; btn.textContent = "💖 Looks perfect — I accept";
      alert("Couldn't send just now — please try again in a moment.");
    }
  });
</script>
</body>
</html>`;
}

// ---- Public invoice page (/i/:wid/:bid) ----
// Branded HTML page: shows the invoice PDF + payment summary + "Pay Now" button.
// This is the link we send to clients instead of the raw PDF URL.
app.get("/i/:workspaceId/:bookingId", async (req, res, next) => {
  try {
    const workspaceId = String(req.params.workspaceId ?? "");
    const bookingId = String(req.params.bookingId ?? "");
    const workspace = await findWorkspaceByWorkspaceId(workspaceId);
    if (!workspace || !workspace.googleTokens) return res.status(404).send("Invoice not found.");
    const booking = await getBookingRecord(workspace.email, workspace.googleTokens, bookingId);
    if (!booking || !booking.invoiceUrl) return res.status(410).send("This invoice is no longer available.");

    const sig = signDocumentToken("invoice", workspaceId, bookingId);
    const pdfUrl = `/d/invoice/${encodeURIComponent(workspaceId)}/${encodeURIComponent(bookingId)}?sig=${encodeURIComponent(sig)}`;
    const brand = workspace.config.businessName || workspace.config.ownerName || "Your artist";
    const brandColor = /^#[0-9a-fA-F]{3,6}$/.test(workspace.config.brandColor) ? workspace.config.brandColor : "#C26B45";
    const payments = parsePaymentsLog(booking.paymentsLog);
    const totalPaid = paymentsTotal(payments);
    const balanceDue = Math.max(0, booking.balanceDue);
    const isPaid = booking.paymentStatus === "Paid in Full" || balanceDue === 0;
    const isVoided = Boolean(booking.invoiceVoidedAt);
    const hasRazorpay = Boolean(workspace.config.razorpayKeyId && workspace.config.razorpayKeySecret);
    const payOrderUrl = hasRazorpay && !isPaid && !isVoided ? `/api/public/${encodeURIComponent(workspaceId)}/payment/${encodeURIComponent(booking.leadId)}/order` : "";

    const escI = (v: string) => String(v || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
    const fmtInr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
    const title = `Invoice from ${escI(brand)}`;

    const paymentRows = payments.map(p =>
      `<div class="pay-row"><span>Received${p.method ? ` via ${escI(p.method)}` : ""}</span><span class="green">${fmtInr(p.amount)}</span></div>`
    ).join("");

    const dueDateRow = booking.invoiceDueDate
      ? `<div class="pay-row"><span>Due Date</span><span>${escI(booking.invoiceDueDate)}</span></div>`
      : "";

    // Overdue starts the day AFTER the due date, in IST. A date-only due date
    // compared against a full `new Date()` timestamp would otherwise flash
    // "Overdue" to the client from 05:30 IST on the morning it's actually due.
    const isOverdue = Boolean(booking.invoiceDueDate) && !isPaid &&
      (/^\d{4}-\d{2}-\d{2}$/.test(booking.invoiceDueDate)
        ? booking.invoiceDueDate < istToday()
        : new Date(booking.invoiceDueDate) < new Date());
    const overdueTag = isOverdue ? `<div class="overdue-tag">⚠️ Overdue</div>` : "";

    const paidBlock = `<div class="paid-block">✅ Paid in full — thank you, ${escI(booking.clientName)}!</div>`;
    const payBlock = payOrderUrl
      ? `<button id="pay-btn" class="pay-btn-primary" type="button">💳 Pay ${fmtInr(balanceDue)} Now</button>
         <p class="hint">Secure online payment via Razorpay</p>`
      : workspace.config.upiId
        ? `<div class="upi-block">Pay via UPI: <b>${escI(workspace.config.upiId)}</b></div>`
        : "";

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${escI(booking.eventType)} on ${escI(booking.eventDate)}" />
<meta name="robots" content="noindex" />
<style>
  :root { --brand: ${brandColor}; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #faf7f4; color: #2a2421; }
  header { background: var(--brand); color: #fff; padding: 20px 18px; text-align: center; }
  header h1 { font-size: 19px; font-weight: 600; }
  header p { font-size: 13px; opacity: .92; margin-top: 4px; }
  main { max-width: 680px; margin: 0 auto; padding: 18px; }
  .card { background: #fff; border: 1px solid #eee3da; border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
  .pay-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; border-bottom: 1px solid #f5f0eb; }
  .pay-row:last-child { border: none; }
  .pay-row b, .total-row { font-weight: 700; }
  .total-row { display: flex; justify-content: space-between; font-size: 16px; font-weight: 700; padding-top: 10px; color: var(--brand); }
  .green { color: #1e6b3a; }
  .overdue-tag { background: #fdf1ef; color: #9a3c2e; border: 1px solid #f3cdc5; border-radius: 8px; padding: 6px 12px; font-size: 13px; margin-bottom: 12px; }
  iframe { width: 100%; height: 65vh; border: 1px solid #eee3da; border-radius: 12px; background: #fff; margin-top: 4px; }
  .pay-btn-primary { display: block; width: 100%; margin-top: 16px; padding: 15px; font-size: 16px; font-weight: 600; color: #fff; background: var(--brand); border: 0; border-radius: 12px; cursor: pointer; }
  .pay-btn-primary:disabled { opacity: .6; }
  .upi-block { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 12px 14px; font-size: 14px; margin-top: 14px; }
  .paid-block { background: #e8f7ee; color: #1e6b3a; border: 1px solid #bfe6cd; border-radius: 12px; padding: 14px; text-align: center; font-size: 15px; margin-top: 14px; }
  .hint { text-align: center; font-size: 12px; color: #8a7f78; margin-top: 6px; }
  footer { text-align: center; font-size: 12px; color: #a79c94; padding: 18px; }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <p>Hi ${escI(booking.clientName)} — your invoice for ${escI(booking.eventType)}</p>
</header>
<main>
  ${overdueTag}
  <div class="card">
    <div class="pay-row"><span>Event</span><b>${escI(booking.eventType)}</b></div>
    <div class="pay-row"><span>Date</span><b>${escI(booking.eventDate)}</b></div>
    <div class="pay-row"><span>Artist</span><b>${escI(booking.assignedArtist || brand)}</b></div>
    ${dueDateRow}
    <div class="pay-row"><span>Booking Value</span><b>${fmtInr(booking.finalPrice)}</b></div>
    ${paymentRows}
    <div class="pay-row"><span>Total Paid</span><span class="green">${fmtInr(totalPaid)}</span></div>
    <div class="total-row"><span>Balance Due</span><span>${fmtInr(balanceDue)}</span></div>
  </div>
  <iframe src="${escI(pdfUrl)}" title="Invoice PDF"></iframe>
  ${isPaid || isVoided ? paidBlock : payBlock}
</main>
<footer>Powered by BusyDays</footer>
${payOrderUrl ? `<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  document.getElementById("pay-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("pay-btn");
    btn.disabled = true; btn.textContent = "Loading…";
    try {
      const r = await fetch(${JSON.stringify(payOrderUrl)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Could not create order");
      const rzp = new Razorpay({
        key: d.keyId,
        order_id: d.orderId,
        amount: d.amountPaise,
        currency: "INR",
        name: ${JSON.stringify(brand)},
        description: ${JSON.stringify(`${booking.eventType} · ${booking.eventDate}`)},
        handler: () => { document.getElementById("pay-btn").replaceWith(Object.assign(document.createElement("div"), { className: "paid-block", textContent: "✅ Payment received! Thank you." })); },
        modal: { ondismiss: () => { btn.disabled = false; btn.textContent = "💳 Pay " + ${JSON.stringify(fmtInr(balanceDue))} + " Now"; } },
      });
      rzp.open();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "💳 Pay ${fmtInr(balanceDue)} Now";
      alert(err.message || "Payment error — please try again.");
    }
  });
</script>` : ""}
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
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
    if (booking.contractVoidedAt) {
      return res.status(400).json({ error: "This contract is voided — clear the void before regenerating it." });
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

      await meterUsage(req.session.profile.email, "esignDocument").catch(() => {});
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

    await meterUsage(req.session.profile.email, "esignDocument").catch(() => {});
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

    // Prepare/generate the contract first, regardless of delivery channel.
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
    const channelContext = resolveLeadMessagingContext(workspace, lead);

    if (!channelContext) {
      // No connected channel → wa.me fallback; the contract link is ready.
      const waLink = buildWaMeReminderLink(currentBooking.clientWhatsApp, message);
      if (!waLink) {
        return res.status(400).json({ error: "This client has no WhatsApp number on file — add one to share the contract." });
      }
      await appendFollowUpLog(req.session.profile.email, req.session.googleTokens, {
        leadId: lead.leadId,
        type: "Contract Shared",
        channel: "WhatsApp",
        messagePreview: message,
        status: "Sent",
      }).catch(() => {});
      return res.json({ ok: true, booking: currentBooking, waLink, manual: true });
    }

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
      // No automated WhatsApp pipe yet → hand the artist a ready-to-send wa.me
      // link. Tapping it opens WhatsApp with the message filled in, and we record
      // the request as done so it stops surfacing.
      const message = buildReviewRequestMessage(workspace, booking);
      const waLink = buildWaMeReminderLink(booking.clientWhatsApp, message);
      if (!waLink) {
        return res.status(400).json({ error: "This client has no WhatsApp number on file." });
      }
      await markBookingReminderSent(req.session.profile.email, req.session.googleTokens, booking.bookingId, "review").catch(() => {});
      await upsertReviewRequest(req.session.profile.email, req.session.googleTokens, {
        leadId: lead.leadId,
        clientName: booking.clientName,
        eventDate: booking.eventDate,
        type: "request",
      }).catch(() => {});
      await logInteractionForWorkspace(req.session.profile.email, req.session.googleTokens, {
        leadId: lead.leadId,
        direction: "Outbound",
        channel: "WhatsApp",
        actor: booking.clientWhatsApp,
        message,
        aiSummary: "Review request — opened via WhatsApp link (manual)",
      }).catch(() => {});
      return res.json({ ok: true, waLink, manual: true });
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
      reviewNote: row[8] ?? "",
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

// Save a private note against a review (visible only to the owner).
app.post("/api/reviews/:reviewId/note", async (req, res, next) => {
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
    while (row.length < 9) row.push("");
    row[8] = String(req.body.note ?? "");
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

// Check-in / mark client as arrived.
app.post("/api/bookings/:bookingId/checkin", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { updateBookingRecord } = await import("./services/booking.js");
    const updated = await updateBookingRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.bookingId,
      (b) => ({ ...b, arrivedAt: new Date().toISOString() }),
    );
    res.json({ ok: true, booking: updated });
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

    // Cancelled bookings are not income. Every money figure below is computed
    // over real (non-cancelled) bookings so Insights never overstates earnings,
    // matching the dashboard's Booked-vs-Collected discipline.
    const realBookings = bookings.filter((b) => b.status !== "Cancelled");

    for (const b of realBookings) {
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
    for (const b of realBookings) {
      const t = b.eventType || "Unknown";
      eventTypeRevenue[t] = (eventTypeRevenue[t] || 0) + (Number(b.finalPrice) || 0);
    }

    // Booked = total value of confirmed (non-cancelled) work.
    // Collected = rupees actually received (payments ledger, minus refunds).
    const totalRevenue = realBookings.reduce((s, b) => s + (Number(b.finalPrice) || 0), 0);
    const totalCollected = realBookings.reduce(
      (s, b) => s + Math.max(0, paymentsTotal(parsePaymentsLog(b.paymentsLog))),
      0,
    );
    const totalOutstanding = Math.max(0, totalRevenue - totalCollected);
    const totalExpenses = realBookings.reduce((s, b) => s + sumExpenses(b.expenses), 0);
    const totalProfit = totalRevenue - totalExpenses;
    const totalBookings = realBookings.length;
    const totalLeads = leads.length;
    // Conversion = share of all enquiries that became real bookings.
    const conversionRate = totalLeads > 0 ? Math.round((totalBookings / totalLeads) * 100) : 0;
    const avgBookingValue = totalBookings > 0 ? Math.round(totalRevenue / totalBookings) : 0;

    // ---- Client-level intelligence (retention, CLV, busiest times) ----
    const byClient = new Map<string, { name: string; count: number; revenue: number; firstAt: string; lastAt: string }>();
    for (const b of realBookings) {
      const phone = String(b.clientWhatsApp || "").replace(/\D/g, "");
      if (!phone) continue;
      const when = b.eventDate || b.bookedAt || "";
      const existing = byClient.get(phone);
      if (existing) {
        existing.count += 1;
        existing.revenue += Number(b.finalPrice) || 0;
        if (when && when < existing.firstAt) existing.firstAt = when;
        if (when && when > existing.lastAt) existing.lastAt = when;
        if (b.clientName) existing.name = b.clientName;
      } else {
        byClient.set(phone, {
          name: b.clientName || "Client",
          count: 1,
          revenue: Number(b.finalPrice) || 0,
          firstAt: when,
          lastAt: when,
        });
      }
    }
    const uniqueClients = byClient.size;
    const repeatClients = [...byClient.values()].filter((c) => c.count > 1).length;
    const repeatClientRate = uniqueClients > 0 ? Math.round((repeatClients / uniqueClients) * 100) : 0;
    const avgClientValue = uniqueClients > 0 ? Math.round(totalRevenue / uniqueClients) : 0;

    // Lapsed = no booking in 90+ days. Active = booked within 90 days.
    const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let activeClients = 0;
    let lapsedClients = 0;
    for (const c of byClient.values()) {
      if (c.lastAt && c.lastAt >= cutoff) activeClients += 1;
      else lapsedClients += 1;
    }

    // Top clients by lifetime value.
    const topClients = [...byClient.entries()]
      .map(([phone, c]) => ({ phone, name: c.name, bookings: c.count, revenue: c.revenue }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);

    // Busiest day-of-week and time-of-day, from confirmed event dates/times.
    const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const byWeekday = Object.fromEntries(WEEKDAYS.map((d) => [d, 0])) as Record<string, number>;
    const byHour: Record<string, number> = {};
    for (const b of realBookings) {
      if (b.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(b.eventDate)) {
        const wd = WEEKDAYS[new Date(`${b.eventDate}T00:00:00Z`).getUTCDay()];
        byWeekday[wd] += 1;
      }
      const hm = String(b.eventTime || "").match(/^(\d{1,2}):/);
      if (hm) {
        const hour = `${hm[1].padStart(2, "0")}:00`;
        byHour[hour] = (byHour[hour] || 0) + 1;
      }
    }
    const busiestDay = Object.entries(byWeekday).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
    const busiestHour = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";

    res.json({
      ok: true,
      summary: {
        totalRevenue, totalCollected, totalOutstanding, totalExpenses, totalProfit, totalBookings, totalLeads, conversionRate, avgBookingValue,
        uniqueClients, repeatClients, repeatClientRate, avgClientValue, activeClients, lapsedClients,
        busiestDay, busiestHour,
      },
      months: months.map((m) => ({
        ...m,
        revenue: revenueByMonth[m.key],
        bookings: bookingsByMonth[m.key],
        leads: leadsByMonth[m.key],
      })),
      bySource: Object.entries(sourceCount).sort((a, b) => b[1] - a[1]).map(([source, count]) => ({ source, count })),
      byEventType: Object.entries(eventTypeRevenue).sort((a, b) => b[1] - a[1]).map(([type, revenue]) => ({ type, revenue })),
      topClients,
      byWeekday: WEEKDAYS.map((d) => ({ day: d, count: byWeekday[d] })),
      byHour: Object.entries(byHour).sort((a, b) => a[0].localeCompare(b[0])).map(([hour, count]) => ({ hour, count })),
    });
  } catch (error) {
    next(error);
  }
});

// Proactive intelligence for the dashboard: open waitlist slots, quotes gone
// quiet, overdue advances, demand the pricing hasn't caught up with. Pure
// computation over data the workspace already has.
app.get("/api/insights", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { leads, bookings } = await getDashboardData(req.session.profile.email, req.session.googleTokens);
    res.json({ ok: true, insights: computeInsights({ config: workspace.config, leads, bookings }) });
  } catch (error) {
    next(error);
  }
});

// Waitlist queue, grouped by date: who's waiting, since when, and how full the
// date currently is — so a freed slot can be offered to the first in line.
app.get("/api/waitlist", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { leads } = await getDashboardData(req.session.profile.email, req.session.googleTokens);
    const today = new Date().toISOString().slice(0, 10);

    const activeByDate = new Map<string, number>();
    const waitingByDate = new Map<string, typeof leads>();
    for (const lead of leads) {
      if (!lead.eventDate || lead.eventDate < today) continue;
      if (["Lost", "Completed"].includes(lead.status)) continue;
      if (lead.source === "Waitlist") {
        waitingByDate.set(lead.eventDate, [...(waitingByDate.get(lead.eventDate) ?? []), lead]);
      } else {
        activeByDate.set(lead.eventDate, (activeByDate.get(lead.eventDate) ?? 0) + 1);
      }
    }

    const maxPerDay = Number(workspace.config.bookingMaxPerDay) || 0;
    const dates = [...waitingByDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, waiting]) => ({
      date,
      booked: activeByDate.get(date) ?? 0,
      maxPerDay,
      slotOpen: maxPerDay > 0 ? (activeByDate.get(date) ?? 0) < maxPerDay : false,
      waiting: waiting
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((lead, i) => ({
          leadId: lead.leadId,
          position: i + 1,
          clientName: lead.clientName,
          clientWhatsApp: lead.clientWhatsApp,
          eventType: lead.eventType,
          eventTime: lead.eventTime,
          joinedAt: lead.createdAt,
        })),
    }));
    res.json({ ok: true, dates });
  } catch (error) {
    next(error);
  }
});

// One-tap waitlist offer: WhatsApp the waiting client that the date opened up.
// Business-initiated message → needs the approved waitlist template (falls
// back to the generic booking-approved template if that's all she has).
app.post("/api/waitlist/:leadId/offer", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    const lead = await getLeadRecord(req.session.profile.email, req.session.googleTokens, req.params.leadId);
    if (!workspace || !lead) return res.status(404).json({ error: "Lead not found" });
    if (!lead.clientWhatsApp) return res.status(400).json({ error: "This client has no WhatsApp number." });

    const whatsapp = workspace.metaConnections?.whatsapp;
    const connectionCanSend = whatsapp?.status === "connected" && Boolean(whatsapp.accessToken && whatsapp.phoneNumberId);
    const envCanSend = Boolean(appConfig.waAccessToken && appConfig.waPhoneNumberId);
    if (!connectionCanSend && !envCanSend) {
      return res.status(400).json({ error: "Connect WhatsApp first (Channels tab) to send offers." });
    }

    const templateName = String(workspace.config.waitlistOfferTemplate || "").trim()
      || String(workspace.config.approvalTemplate || "").trim();
    if (!templateName) {
      return res.status(400).json({ error: "Set up WhatsApp templates first (Channels tab → Create templates)." });
    }
    const templateLang = String(workspace.config.waitlistOfferTemplate || "").trim()
      ? String(workspace.config.waitlistOfferTemplateLang || "en")
      : String(workspace.config.approvalTemplateLang || "en");
    const usingWaitlistTemplate = Boolean(String(workspace.config.waitlistOfferTemplate || "").trim());

    await sendWhatsAppTemplate(
      { accessToken: whatsapp?.accessToken, phoneNumberId: whatsapp?.phoneNumberId },
      lead.clientWhatsApp.replace(/[^\d]/g, ""),
      templateName,
      templateLang,
      usingWaitlistTemplate
        ? [lead.clientName || "there", lead.eventDate, lead.eventType]
        : [lead.clientName || "there", lead.eventDate, String(lead.finalApprovedPrice || lead.initialAiPrice || "")],
    );

    // Promote the lead out of the waitlist so the slot math counts them and the
    // normal request flow (quote → confirm) takes over.
    const updated = await updateLeadRecord(
      req.session.profile.email,
      req.session.googleTokens,
      lead.leadId,
      (current) => ({
        ...current,
        source: "Booking Page",
        ownerNotes: [current.ownerNotes, `Waitlist slot offered on ${new Date().toISOString().slice(0, 10)}`]
          .filter(Boolean).join(" | "),
        lastContactedAt: new Date().toISOString(),
      }),
    );

    await logInteractionForWorkspace(req.session.profile.email, req.session.googleTokens, {
      leadId: lead.leadId,
      direction: "Outbound",
      channel: "WhatsApp",
      actor: lead.clientWhatsApp.replace(/[^\d]/g, ""),
      message: `Waitlist offer template "${templateName}" sent — the date opened up`,
      aiSummary: "Waitlist slot offered to client",
    });

    res.json({ ok: true, lead: updated });
  } catch (error) {
    next(error);
  }
});

// ---- Loyalty program ----

app.get("/api/loyalty", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { bookings } = await getDashboardData(req.session.profile.email, req.session.googleTokens);
    const statuses = computeLoyaltyStatuses(workspace.config, bookings);
    res.json({ ok: true, statuses, enabled: workspace.config.loyaltyEnabled === "Yes" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/loyalty/:phone", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { bookings } = await getDashboardData(req.session.profile.email, req.session.googleTokens);
    const status = loyaltyForPhone(workspace.config, bookings, req.params.phone);
    res.json({ ok: true, status });
  } catch (error) {
    next(error);
  }
});

// Send loyalty reward WhatsApp to client
app.post("/api/loyalty/:phone/send-reward", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { bookings } = await getDashboardData(req.session.profile.email, req.session.googleTokens);
    const status = loyaltyForPhone(workspace.config, bookings, req.params.phone);
    if (!status) return res.status(404).json({ error: "Client not found in loyalty program" });

    const rewardNote = status.rewardNote;
    const brandName = workspace.config.businessName || workspace.name;
    const message = `Hi ${status.clientName} 🌟 You've completed ${status.visits} bookings with ${brandName}! Your loyalty has earned you: ${rewardNote}. Mention this on your next booking. Thank you for being an amazing client! ${workspace.config.aiSignOff || ""}`.trim();

    const connection = workspace.metaConnections?.whatsapp;
    if (connection?.accessToken && connection?.phoneNumberId) {
      await sendChannelMessage({
        workspace,
        connection,
        channel: "WhatsApp",
        actorId: req.params.phone,
        message,
      });
    }
    res.json({ ok: true, message });
  } catch (error) {
    next(error);
  }
});

// ---- Gift cards ----

app.get("/api/gift-cards", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { sheets } = createGoogleClients(req.session.googleTokens);
    const res2 = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.giftCards}!A2:K`,
    });
    const cards = (res2.data.values ?? []).map(parseGiftCard);
    res.json({ ok: true, cards });
  } catch (error) {
    next(error);
  }
});

app.post("/api/gift-cards", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const amount = Number(req.body?.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Amount is required" });

    const card = {
      cardId: `GC-${Date.now()}`,
      code: generateGiftCode(),
      amount,
      message: String(req.body?.message || ""),
      purchaserName: String(req.body?.purchaserName || ""),
      purchaserEmail: String(req.body?.purchaserEmail || ""),
      purchaserWhatsApp: String(req.body?.purchaserWhatsApp || ""),
      redeemedByLeadId: "",
      redeemedAt: "",
      createdAt: new Date().toISOString(),
      status: "Active" as const,
    };
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await sheets.spreadsheets.values.append({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.giftCards}!A:K`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [giftCardToRow(card)] },
    });
    res.json({ ok: true, card });
  } catch (error) {
    next(error);
  }
});

app.post("/api/gift-cards/:code/deactivate", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { sheets } = createGoogleClients(req.session.googleTokens);
    const res2 = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.giftCards}!A2:K`,
    });
    const rows = res2.data.values ?? [];
    const idx = rows.findIndex((r) => r[1] === req.params.code);
    if (idx < 0) return res.status(404).json({ error: "Gift card not found" });
    await sheets.spreadsheets.values.update({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.giftCards}!K${idx + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Deactivated"]] },
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Public: validate a gift card code before booking
app.get("/api/public/:workspaceId/gift-cards/:code", publicReadLimiter, async (req, res, next) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const workspace = await findWorkspaceByWorkspaceId(String(req.params.workspaceId));
    if (!workspace || workspace.config.giftCardsEnabled !== "Yes") {
      return res.status(404).json({ error: "Gift cards not available" });
    }
    const tokens = await getWorkspaceCredentials(workspace.email).catch(() => null);
    if (!tokens) return res.status(503).json({ error: "Service unavailable" });
    const { sheets } = createGoogleClients(tokens);
    const res2 = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.giftCards}!A2:K`,
    });
    const rows = res2.data.values ?? [];
    const row = rows.find((r) => String(r[1] || "").toUpperCase() === code);
    if (!row) return res.json({ ok: false, error: "Invalid gift card code" });
    const card = parseGiftCard(row);
    if (card.status !== "Active") return res.json({ ok: false, error: "Gift card already used or deactivated" });
    res.json({ ok: true, amount: card.amount, message: card.message });
  } catch (error) {
    next(error);
  }
});

// ---- Promo codes ----
// Discount codes the owner creates and clients enter on the booking page.
// Backed by a lazily-created PromoCodes sheet tab.

app.get("/api/promo-codes", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.promoCodes, promoCodeHeaders);
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.promoCodes}!A2:J`,
    });
    const codes = (got.data.values ?? []).map(parsePromoCode);
    res.json({ ok: true, codes });
  } catch (error) {
    next(error);
  }
});

app.post("/api/promo-codes", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const type = req.body?.type === "flat" ? "flat" : "percent";
    const value = Number(req.body?.value);
    if (!value || value <= 0) return res.status(400).json({ error: "A discount value is required." });
    if (type === "percent" && value > 90) return res.status(400).json({ error: "Percentage discount can't exceed 90%." });

    const promo: PromoCode = {
      codeId: `PC-${Date.now()}`,
      code: String(req.body?.code || "").trim().toUpperCase() || generatePromoCode(),
      type,
      value,
      minAmount: Math.max(0, Number(req.body?.minAmount) || 0),
      maxRedemptions: Math.max(0, Number(req.body?.maxRedemptions) || 0),
      timesRedeemed: 0,
      expiresAt: typeof req.body?.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.expiresAt) ? req.body.expiresAt : "",
      createdAt: new Date().toISOString(),
      status: "Active",
    };
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.promoCodes, promoCodeHeaders);
    // Reject a duplicate code so two codes can't collide at redemption.
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.promoCodes}!A2:J`,
    });
    if ((existing.data.values ?? []).some((r) => String(r[1] || "").toUpperCase() === promo.code)) {
      return res.status(400).json({ error: `Code "${promo.code}" already exists.` });
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.promoCodes}!A:J`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [promoCodeToRow(promo)] },
    });
    res.json({ ok: true, promo });
  } catch (error) {
    next(error);
  }
});

app.post("/api/promo-codes/:code/deactivate", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.promoCodes, promoCodeHeaders);
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.promoCodes}!A2:J`,
    });
    const rows = got.data.values ?? [];
    const idx = rows.findIndex((r) => String(r[1] || "").toUpperCase() === String(req.params.code).toUpperCase());
    if (idx < 0) return res.status(404).json({ error: "Promo code not found" });
    await sheets.spreadsheets.values.update({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.promoCodes}!J${idx + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Deactivated"]] },
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Public: validate a promo code against an order amount before booking.
app.get("/api/public/:workspaceId/promo/:code", publicReadLimiter, async (req, res, next) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const amount = Number(req.query.amount) || 0;
    const workspace = await findWorkspaceByWorkspaceId(String(req.params.workspaceId));
    if (!workspace || workspace.config.promoCodesEnabled !== "Yes") {
      return res.status(404).json({ error: "Promo codes not available" });
    }
    const tokens = await getWorkspaceCredentials(workspace.email).catch(() => null);
    if (!tokens) return res.status(503).json({ error: "Service unavailable" });
    const { sheets } = createGoogleClients(tokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.promoCodes, promoCodeHeaders);
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.promoCodes}!A2:J`,
    });
    const row = (got.data.values ?? []).find((r) => String(r[1] || "").toUpperCase() === code);
    const result = validatePromo(row ? parsePromoCode(row) : undefined, amount);
    if (!result.ok) return res.json({ ok: false, error: result.reason });
    res.json({ ok: true, discount: result.discount, finalAmount: result.finalAmount, label: result.label, code });
  } catch (error) {
    next(error);
  }
});

// ---- Prepaid packages / memberships ----
// A client buys a bundle of sessions; each redemption decrements the balance.

app.get("/api/packages", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.clientPackages, packageHeaders);
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.clientPackages}!A2:J`,
    });
    const packages = (got.data.values ?? []).map(parseClientPackage).map((p) => ({ ...p, remaining: remainingSessions(p) }));
    res.json({ ok: true, packages });
  } catch (error) {
    next(error);
  }
});

app.get("/api/clients/:phone/packages", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const phone = String(req.params.phone ?? "").replace(/\D/g, "");
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.clientPackages, packageHeaders);
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.clientPackages}!A2:J`,
    });
    const packages = (got.data.values ?? [])
      .map(parseClientPackage)
      .filter((p) => p.clientWhatsApp.replace(/\D/g, "") === phone)
      .map((p) => ({ ...p, remaining: remainingSessions(p) }));
    res.json({ ok: true, packages });
  } catch (error) {
    next(error);
  }
});

app.post("/api/packages", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const clientWhatsApp = String(req.body?.clientWhatsApp || "").trim();
    const name = String(req.body?.name || "").trim();
    const totalSessions = Number(req.body?.totalSessions);
    if (!clientWhatsApp || !name || !totalSessions || totalSessions < 1) {
      return res.status(400).json({ error: "Client, package name, and session count are required." });
    }
    const pkg: ClientPackage = {
      packageId: `PKG-${Date.now()}`,
      clientWhatsApp,
      clientName: String(req.body?.clientName || ""),
      name,
      totalSessions: Math.round(totalSessions),
      usedSessions: 0,
      price: Math.max(0, Number(req.body?.price) || 0),
      purchasedAt: new Date().toISOString(),
      expiresAt: typeof req.body?.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.expiresAt) ? req.body.expiresAt : "",
      status: "Active",
    };
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.clientPackages, packageHeaders);
    await sheets.spreadsheets.values.append({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.clientPackages}!A:J`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [clientPackageToRow(pkg)] },
    });
    res.json({ ok: true, package: pkg });
  } catch (error) {
    next(error);
  }
});

// Redeem one session against a package (decrements remaining; marks Completed at 0).
app.post("/api/packages/:packageId/redeem", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.clientPackages, packageHeaders);
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.clientPackages}!A2:J`,
    });
    const rows = got.data.values ?? [];
    const idx = rows.findIndex((r) => r[0] === req.params.packageId);
    if (idx < 0) return res.status(404).json({ error: "Package not found" });
    const pkg = parseClientPackage(rows[idx]);
    const usable = isRedeemable(pkg);
    if (!usable.ok) return res.status(400).json({ error: usable.reason });
    pkg.usedSessions += 1;
    if (remainingSessions(pkg) <= 0) pkg.status = "Completed";
    await sheets.spreadsheets.values.update({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.clientPackages}!A${idx + 2}:J${idx + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [clientPackageToRow(pkg)] },
    });
    res.json({ ok: true, package: { ...pkg, remaining: remainingSessions(pkg) } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/packages/:packageId/cancel", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.clientPackages, packageHeaders);
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.clientPackages}!A2:J`,
    });
    const rows = got.data.values ?? [];
    const idx = rows.findIndex((r) => r[0] === req.params.packageId);
    if (idx < 0) return res.status(404).json({ error: "Package not found" });
    await sheets.spreadsheets.values.update({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.clientPackages}!J${idx + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Cancelled"]] },
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ---- Per-client photos (before/after gallery) ----

app.get("/api/clients/:phone/photos", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const phone = String(req.params.phone ?? "").replace(/\D/g, "");
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.clientPhotos, clientPhotoHeaders);
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.clientPhotos}!A2:G`,
    });
    const photos = (got.data.values ?? [])
      .map(parseClientPhoto)
      .filter((p) => p.clientWhatsApp.replace(/\D/g, "") === phone)
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    res.json({ ok: true, photos });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/clients/:phone/photos",
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
      const workspace = await getWorkspaceByEmail(req.session.profile.email);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      const phone = String(req.params.phone ?? "").replace(/\D/g, "");
      if (!phone) return res.status(400).json({ error: "Invalid client" });

      const uploaded = await uploadPublicImage(req.session.profile.email, req.session.googleTokens, {
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        originalName: req.file.originalname,
      });
      const kindRaw = String(req.body?.kind || "look");
      const photo: ClientPhoto = {
        photoId: `PH-${Date.now()}`,
        clientWhatsApp: phone,
        bookingId: String(req.body?.bookingId || ""),
        url: uploaded.imageUrl,
        caption: String(req.body?.caption || ""),
        kind: kindRaw === "before" || kindRaw === "after" ? kindRaw : "look",
        uploadedAt: new Date().toISOString(),
      };
      const { sheets } = createGoogleClients(req.session.googleTokens);
      await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.clientPhotos, clientPhotoHeaders);
      await sheets.spreadsheets.values.append({
        spreadsheetId: workspace.spreadsheetId,
        range: `${sheetNames.clientPhotos}!A:G`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [clientPhotoToRow(photo)] },
      });
      res.json({ ok: true, photo });
    } catch (error) {
      next(error);
    }
  },
);

app.delete("/api/clients/:phone/photos/:photoId", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.clientPhotos, clientPhotoHeaders);
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.clientPhotos}!A2:G`,
    });
    const rows = got.data.values ?? [];
    const idx = rows.findIndex((r) => r[0] === req.params.photoId);
    if (idx < 0) return res.status(404).json({ error: "Photo not found" });
    // Soft-delete by blanking the row's URL/caption (Sheets has no cheap row delete here).
    const cleared = parseClientPhoto(rows[idx]);
    cleared.url = "";
    cleared.caption = "(deleted)";
    await sheets.spreadsheets.values.update({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.clientPhotos}!A${idx + 2}:G${idx + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [clientPhotoToRow(cleared)] },
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ---- Retail inventory ----
// Products the artist sells alongside services, with stock and sales tracking.

app.get("/api/products", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.products, productHeaders);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.productSales, productSaleHeaders);
    const [prodRes, salesRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: workspace.spreadsheetId, range: `${sheetNames.products}!A2:J` }),
      sheets.spreadsheets.values.get({ spreadsheetId: workspace.spreadsheetId, range: `${sheetNames.productSales}!A2:H` }),
    ]);
    const products = (prodRes.data.values ?? []).map(parseProduct).map((p) => ({ ...p, lowStock: isLowStock(p) }));
    const sales = (salesRes.data.values ?? []).map(parseProductSale);
    const retailRevenue = sales.reduce((s, x) => s + (x.total || 0), 0);
    const unitsSold = sales.reduce((s, x) => s + (x.quantity || 0), 0);
    res.json({
      ok: true,
      products,
      summary: { retailRevenue, unitsSold, lowStockCount: products.filter((p) => p.lowStock).length },
      recentSales: sales.sort((a, b) => b.soldAt.localeCompare(a.soldAt)).slice(0, 20),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/products", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Product name is required." });
    const product: Product = {
      productId: `PRD-${Date.now()}`,
      name,
      sku: String(req.body?.sku || "").trim(),
      price: Math.max(0, Number(req.body?.price) || 0),
      cost: Math.max(0, Number(req.body?.cost) || 0),
      stock: Math.max(0, Math.round(Number(req.body?.stock) || 0)),
      lowStockThreshold: Math.max(0, Math.round(Number(req.body?.lowStockThreshold) || 0)),
      category: String(req.body?.category || "").trim(),
      status: "Active",
      createdAt: new Date().toISOString(),
    };
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.products, productHeaders);
    await sheets.spreadsheets.values.append({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.products}!A:J`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [productToRow(product)] },
    });
    res.json({ ok: true, product });
  } catch (error) {
    next(error);
  }
});

// Loads a product row by id, mutates it, and writes it back. Shared by the
// edit / restock / sell / archive endpoints so the read-modify-write is in one place.
async function withProductRow(
  email: string,
  tokens: import("google-auth-library").Credentials,
  spreadsheetId: string,
  productId: string,
  mutate: (p: Product) => Product | { error: string },
): Promise<{ ok: true; product: Product } | { ok: false; status: number; error: string }> {
  const { sheets } = createGoogleClients(tokens);
  await ensureSheetTab(sheets, spreadsheetId, sheetNames.products, productHeaders);
  const got = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetNames.products}!A2:J` });
  const rows = got.data.values ?? [];
  const idx = rows.findIndex((r) => r[0] === productId);
  if (idx < 0) return { ok: false, status: 404, error: "Product not found" };
  const result = mutate(parseProduct(rows[idx]));
  if ("error" in result) return { ok: false, status: 400, error: result.error };
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetNames.products}!A${idx + 2}:J${idx + 2}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [productToRow(result)] },
  });
  return { ok: true, product: result };
}

app.post("/api/products/:productId/update", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const r = await withProductRow(req.session.profile.email, req.session.googleTokens, workspace.spreadsheetId, req.params.productId, (p) => ({
      ...p,
      name: req.body?.name !== undefined ? String(req.body.name).trim() || p.name : p.name,
      sku: req.body?.sku !== undefined ? String(req.body.sku).trim() : p.sku,
      price: req.body?.price !== undefined ? Math.max(0, Number(req.body.price) || 0) : p.price,
      cost: req.body?.cost !== undefined ? Math.max(0, Number(req.body.cost) || 0) : p.cost,
      stock: req.body?.stock !== undefined ? Math.max(0, Math.round(Number(req.body.stock) || 0)) : p.stock,
      lowStockThreshold: req.body?.lowStockThreshold !== undefined ? Math.max(0, Math.round(Number(req.body.lowStockThreshold) || 0)) : p.lowStockThreshold,
      category: req.body?.category !== undefined ? String(req.body.category).trim() : p.category,
    }));
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, product: { ...r.product, lowStock: isLowStock(r.product) } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/products/:productId/restock", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const qty = Math.round(Number(req.body?.quantity) || 0);
    if (!qty || qty <= 0) return res.status(400).json({ error: "Restock quantity must be positive." });
    const r = await withProductRow(req.session.profile.email, req.session.googleTokens, workspace.spreadsheetId, req.params.productId, (p) => ({
      ...p,
      stock: p.stock + qty,
    }));
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, product: { ...r.product, lowStock: isLowStock(r.product) } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/products/:productId/archive", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const r = await withProductRow(req.session.profile.email, req.session.googleTokens, workspace.spreadsheetId, req.params.productId, (p) => ({
      ...p,
      status: "Archived" as const,
    }));
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Bring an archived product back — archiving was previously a one-way trip with
// no UI path to recover a mis-archived item.
app.post("/api/products/:productId/restore", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const r = await withProductRow(req.session.profile.email, req.session.googleTokens, workspace.spreadsheetId, req.params.productId, (p) => ({
      ...p,
      status: "Active" as const,
    }));
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Record a retail sale: decrement stock and log it to ProductSales.
app.post("/api/products/:productId/sell", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const qty = Math.round(Number(req.body?.quantity) || 1);
    if (qty <= 0) return res.status(400).json({ error: "Quantity must be positive." });

    let soldProduct: Product | null = null;
    const r = await withProductRow(req.session.profile.email, req.session.googleTokens, workspace.spreadsheetId, req.params.productId, (p) => {
      if (p.status !== "Active") return { error: "This product is archived." };
      if (p.stock < qty) return { error: `Only ${p.stock} in stock.` };
      soldProduct = p;
      return { ...p, stock: p.stock - qty };
    });
    if (!r.ok) return res.status(r.status).json({ error: r.error });

    const unitPrice = req.body?.unitPrice !== undefined ? Math.max(0, Number(req.body.unitPrice) || 0) : r.product.price;
    const sale: ProductSale = {
      saleId: `SALE-${Date.now()}`,
      productId: r.product.productId,
      productName: r.product.name,
      quantity: qty,
      unitPrice,
      total: unitPrice * qty,
      clientWhatsApp: String(req.body?.clientWhatsApp || "").replace(/\D/g, ""),
      soldAt: new Date().toISOString(),
    };
    const { sheets } = createGoogleClients(req.session.googleTokens);
    await ensureSheetTab(sheets, workspace.spreadsheetId, sheetNames.productSales, productSaleHeaders);
    await sheets.spreadsheets.values.append({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.productSales}!A:H`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [productSaleToRow(sale)] },
    });
    res.json({ ok: true, sale, product: { ...r.product, lowStock: isLowStock(r.product) } });
  } catch (error) {
    next(error);
  }
});

// ---- Client win-back ----
// Lapsed clients (no completed booking in N days) with the data needed to
// re-engage them: last seen, lifetime value, and a ready-to-send message.
app.get("/api/winback", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const days = Math.max(30, Number(req.query.days) || 90);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { bookings } = await getDashboardData(req.session.profile.email, req.session.googleTokens);
    const byClient = new Map<string, { name: string; phone: string; lastAt: string; bookings: number; revenue: number }>();
    for (const b of bookings) {
      if (b.status === "Cancelled" || b.status === "No Show") continue;
      const phone = String(b.clientWhatsApp || "").replace(/\D/g, "");
      if (!phone) continue;
      const when = b.eventDate || b.bookedAt || "";
      const existing = byClient.get(phone);
      if (existing) {
        existing.bookings += 1;
        existing.revenue += Number(b.finalPrice) || 0;
        if (when > existing.lastAt) existing.lastAt = when;
        if (b.clientName) existing.name = b.clientName;
      } else {
        byClient.set(phone, { name: b.clientName || "Client", phone, lastAt: when, bookings: 1, revenue: Number(b.finalPrice) || 0 });
      }
    }
    const lapsed = [...byClient.values()]
      .filter((c) => c.lastAt && c.lastAt < cutoff)
      .map((c) => ({
        ...c,
        daysSince: c.lastAt ? Math.floor((Date.now() - new Date(`${c.lastAt}T00:00:00Z`).getTime()) / (24 * 60 * 60 * 1000)) : null,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({ ok: true, cutoffDays: days, count: lapsed.length, clients: lapsed });
  } catch (error) {
    next(error);
  }
});

// ---- Commission report ----

app.get("/api/team/commission-report", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const { bookings } = await getDashboardData(req.session.profile.email, req.session.googleTokens);
    const { sheets } = createGoogleClients(req.session.googleTokens);
    const artistsRes = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.artists}!A2:J`,
    });
    const artistRows = artistsRes.data.values ?? [];
    const defaultCommission = workspace.config.commissionDefaultPercent || 0;

    const artistMap = new Map<string, { name: string; commissionPercent: number }>();
    for (const r of artistRows) {
      const name = String(r[1] || "");
      // priceMultiplier is at index 6; store it for reference
      if (name) artistMap.set(name, { name, commissionPercent: defaultCommission });
    }

    const reportMap = new Map<string, { artistName: string; bookingCount: number; totalRevenue: number; commissionAmount: number }>();
    for (const b of bookings) {
      if (!b.assignedArtist || b.status === "Cancelled") continue;
      const artist = artistMap.get(b.assignedArtist) || { name: b.assignedArtist, commissionPercent: defaultCommission };
      const existing = reportMap.get(b.assignedArtist) || { artistName: b.assignedArtist, bookingCount: 0, totalRevenue: 0, commissionAmount: 0 };
      existing.bookingCount++;
      existing.totalRevenue += b.finalPrice || 0;
      existing.commissionAmount += Math.round((b.finalPrice || 0) * artist.commissionPercent / 100);
      reportMap.set(b.assignedArtist, existing);
    }

    res.json({ ok: true, report: Array.from(reportMap.values()), defaultCommissionPercent: defaultCommission });
  } catch (error) {
    next(error);
  }
});

// ---- Intake forms ----

app.get("/api/intake-forms", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const c = workspace.config;
    res.json({
      ok: true,
      forms: {
        Bridal: c.intakeFormBridal,
        Engagement: c.intakeFormEngagement,
        Reception: c.intakeFormReception,
        Party: c.intakeFormParty,
        Shoot: c.intakeFormShoot,
        Other: c.intakeFormOther,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Public: get intake form questions for a service type
app.get("/api/public/:workspaceId/intake-form/:eventType", publicReadLimiter, async (req, res, next) => {
  try {
    const workspace = await findWorkspaceByWorkspaceId(String(req.params.workspaceId));
    if (!workspace) return res.status(404).json({ error: "Not found" });
    const c = workspace.config;
    const et = req.params.eventType;
    const formKey = `intakeForm${et}` as keyof typeof c;
    const raw = typeof c[formKey] === "string" ? (c[formKey] as string) : "";
    const questions = raw
      .split(",")
      .map((q) => q.trim())
      .filter(Boolean);
    res.json({ ok: true, questions });
  } catch (error) {
    next(error);
  }
});

// ---- Email test ----

app.post("/api/email/test", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    if (!emailEnabled(workspace.config)) {
      return res.status(400).json({ error: "Email not configured. Add SMTP settings first." });
    }
    const result = await sendEmail(workspace.config, {
      to: workspace.config.ownerEmail,
      subject: `Test email from ${workspace.config.businessName || "BusyDays"}`,
      html: wrapEmailHtml(workspace.config, `<h2>Test email working! ✅</h2><p>Your email notifications are configured correctly. Clients will receive booking confirmations, quotes, invoices and reminders via email when it's enabled.</p>`),
    });
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json({ ok: true, message: `Test email sent to ${workspace.config.ownerEmail}` });
  } catch (error) {
    next(error);
  }
});

// ---- No-show tracking ----

app.post("/api/bookings/:bookingId/no-show", async (req, res, next) => {
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
    if (!workspace || !booking) return res.status(404).json({ error: "Booking not found" });

    await updateBookingRecord(req.session.profile.email, req.session.googleTokens, req.params.bookingId, (current) => ({
      ...current,
      status: "No Show",
    }));

    res.json({ ok: true, noShowFeePercent: workspace.config.noShowFeePercent || 0 });
  } catch (error) {
    next(error);
  }
});

// ---- Recurring appointments ----
// Creates a series of bookings (via leads) for a recurring appointment.
// Each occurrence gets its own lead with a shared recurringGroupId in the notes.
app.post("/api/recurring", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    if (workspace.config.recurringEnabled !== "Yes") {
      return res.status(400).json({ error: "Recurring appointments are not enabled." });
    }

    const { clientName, clientWhatsApp, eventType, startDate, eventTime, locationText,
      frequency, sessionCount } = req.body;
    if (!clientName || !clientWhatsApp || !eventType || !startDate || !frequency) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    const count = Math.min(Math.max(Number(sessionCount) || 4, 1), 52);
    const FREQ_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, monthly: 30 };
    const stepDays = FREQ_DAYS[frequency] ?? 7;

    const groupId = `REC-${Date.now()}`;
    const leads: Array<{ leadId: string; eventDate: string }> = [];

    for (let i = 0; i < count; i++) {
      const eventDate = new Date(startDate);
      eventDate.setUTCDate(eventDate.getUTCDate() + i * stepDays);
      const dateStr = eventDate.toISOString().slice(0, 10);
      try {
        const result = await createLeadForWorkspace(
          req.session.profile.email,
          req.session.googleTokens,
          {
            clientName: String(clientName),
            clientWhatsApp: String(clientWhatsApp),
            eventType: String(eventType),
            eventDate: dateStr,
            eventTime: eventTime ? String(eventTime) : undefined,
            locationText: locationText ? String(locationText) : workspace.config.city || "",
            source: "Manual" as const,
            inboundMessage: `Recurring series: ${groupId} (${i + 1}/${count}, ${frequency})`,
          },
        );
        leads.push({ leadId: result.lead.leadId, eventDate: dateStr });
      } catch {
        // Skip dates that fail (e.g. blocked); continue with the rest.
      }
    }

    res.json({ ok: true, groupId, created: leads.length, leads });
  } catch (error) {
    next(error);
  }
});

// ---- Saved quote packages, parsed from the quotePackages config — one-tap line
// items when building a quote.
app.get("/api/quote-packages", async (req, res, next) => {
  try {
    if (!req.session.profile) return res.status(401).json({ error: "Unauthorized" });
    const workspace = await getWorkspaceByEmail(req.session.profile.email);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    res.json({ ok: true, packages: parseQuotePackages(workspace.config.quotePackages) });
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
    const kind = req.body?.kind === "balance" ? "balance" : "advance";
    const channelContext = resolveLeadMessagingContext(workspace, lead);
    if (!channelContext) {
      // No automated WhatsApp pipe yet → return a ready-to-send wa.me link and
      // log the reminder as sent so it isn't re-surfaced.
      const message = buildCollectionReminderMessage(workspace, booking, kind);
      const waLink = buildWaMeReminderLink(booking.clientWhatsApp, message);
      if (!waLink) {
        return res.status(400).json({ error: "This client has no WhatsApp number on file." });
      }
      await appendFollowUpLog(req.session.profile.email, req.session.googleTokens, {
        leadId: lead.leadId,
        type: kind === "balance" ? "Balance Reminder" : "Advance Reminder",
        channel: "WhatsApp",
        messagePreview: message,
        status: "Sent",
      }).catch(() => {});
      await logInteractionForWorkspace(req.session.profile.email, req.session.googleTokens, {
        leadId: lead.leadId,
        direction: "Outbound",
        channel: "WhatsApp",
        actor: booking.clientWhatsApp,
        message,
        aiSummary: `${kind === "balance" ? "Balance" : "Advance"} reminder — opened via WhatsApp link (manual)`,
      }).catch(() => {});
      return res.json({ ok: true, waLink, manual: true });
    }

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

// One-tap "I've left them a message, reaching out shortly". Records the contact
// (so the lead stops showing as "quiet" / overdue) without needing a connected
// WhatsApp/Instagram channel — the artist messages from their own phone via the
// wa.me deep link the UI opens alongside this call.
app.post("/api/leads/:leadId/mark-contacted", async (req, res, next) => {
  try {
    if (!req.session.profile || !req.session.googleTokens) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const stamp = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short",
    });
    const note = `Left a message — reaching out shortly (${stamp})`;
    const updated = await updateLeadRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.leadId,
      (current) => ({
        ...current,
        ownerNotes: current.ownerNotes ? `${current.ownerNotes}\n${note}` : note,
        lastContactedAt: new Date().toISOString(),
      }),
    );
    res.json({ ok: true, lastContactedAt: updated.lastContactedAt });
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

    // Optional image attachment (e.g. a look reference back to the client).
    // Must be a public https URL — produced by our own chat-image upload.
    const imageUrl =
      typeof req.body?.imageUrl === "string" && /^https:\/\/\S+$/.test(req.body.imageUrl)
        ? req.body.imageUrl.slice(0, 600)
        : "";
    const message =
      typeof req.body?.message === "string" && req.body.message.trim().length > 0
        ? req.body.message.trim()
        : imageUrl
          ? ""
          : lead.suggestedReply;
    if (!message && !imageUrl) {
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
      imageUrl: imageUrl || undefined,
    });

    const updatedLead = await updateLeadRecord(
      req.session.profile.email,
      req.session.googleTokens,
      req.params.leadId,
      (current) => ({
        ...current,
        suggestedReply: message || current.suggestedReply,
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
      message: imageUrl ? `[img:url:${imageUrl}]${message ? ` ${message}` : ""}` : message,
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
      // Reference photos are first-class: a photo-only message still creates/
      // updates the lead and lands in the inbox with the image attached.
      const rawInboundText = extractInboundTextFromMetaWebhook(body);
      const inboundMedia = extractInboundMediaFromMetaWebhook(body);
      const inboundText =
        rawInboundText || (inboundMedia ? inboundMedia.caption || "📷 (Client sent a photo)" : "");
      const inboundLogMessage = inboundMedia
        ? buildImageMarker({ ref: inboundMedia.ref, caption: rawInboundText || inboundMedia.caption })
        : inboundText;
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
            message: inboundLogMessage,
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
            interactionMessage: inboundLogMessage,
            actorId: actorId || "instagram-user",
          });
          resolvedLeadId = result.lead.leadId;
          leadCreated = true;
        }
      } else if (channel === "WhatsApp" && inboundText) {
        // ── WhatsApp opt-out: honour STOP / UNSUBSCRIBE / OPT OUT ────────────
        // WhatsApp Business Policy and many national anti-spam laws (TCPA, PDPA,
        // TRAI) require that a STOP request is processed immediately and silently.
        // We mark the phone opted-out and skip all further processing so no
        // lead is created and no auto-reply is sent (which would be a second
        // unwanted message).
        const stopKeywords = /^\s*(stop|unsubscribe|opt.?out|end|quit|cancel)\s*$/i;
        if (stopKeywords.test(inboundText) && actorId) {
          const senderPhone = actorId.replace(/\D/g, "");
          await markPhoneOptedOut(workspace.workspaceId, senderPhone).catch(() => null);
          logger.info("whatsapp_optout", { workspaceId: workspace.workspaceId, phone: senderPhone });
          // Do NOT send any reply — sending even an "unsubscribed" confirmation
          // to someone who said STOP would be a compliance violation in some
          // jurisdictions. The artist can see the event in the Conversations tab.
          res.sendStatus(200);
          return;
        }

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
            message: inboundLogMessage,
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
            interactionMessage: inboundLogMessage,
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
            servicesContext: buildServicesContext(workspace.config),
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
          message: inboundLogMessage || JSON.stringify(body).slice(0, 500),
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
  a { color: #C26B45; }
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

<h2>2a. Google API Limited Use disclosure</h2>
<p>BusyDays' use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements. Specifically:</p>
<ul>
  <li>We use Google Sheets access only to read and write the booking/lead spreadsheet we create in your own Drive. We do not read any other spreadsheets.</li>
  <li>We use Google Calendar access only to create, update and delete booking events we create on your behalf. We do not read events we did not create, except to check free/busy availability at your explicit request.</li>
  <li>We use Drive file access (drive.file scope) only to upload files our app generates — payment screenshots, portfolio photos, and your business logo. We cannot see or access other files in your Drive.</li>
  <li>We do not use data obtained via Google APIs to serve advertisements, and we do not transfer it to any third party except as necessary to provide the features you explicitly activate.</li>
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
  <li>Export your personal data at any time from Settings → Account → Export my data.</li>
  <li>Delete your workspace instantly via Settings → Account → Delete workspace, or by emailing us.</li>
  <li>Access or export your records directly from the Google Sheet you own.</li>
</ul>

<h2>7. WhatsApp messaging opt-out</h2>
<p>Clients who receive WhatsApp messages through BusyDays may reply <strong>STOP</strong> (or UNSUBSCRIBE / OPT OUT) at any time. We record the opt-out immediately and exclude that contact from all future campaign messages sent by that artist. Artists can view opted-out contacts in Settings → Campaigns → Opt-outs.</p>

<h2>8. Contact</h2>
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

<h2>3. Self-service workspace deletion</h2>
<p>Sign in and go to <strong>Settings → Account → Delete workspace</strong> to permanently delete your entire workspace immediately. This removes your leads, bookings, payment records, and all stored tokens from our database. Data in your own Google Sheet (which you own) is not affected.</p>

<h2>4. WhatsApp opt-out</h2>
<p>If a client replies <strong>STOP</strong> to a WhatsApp message sent via BusyDays, they are automatically added to the opt-out list and will not receive future campaign messages from that artist. Artists can view and manage opt-outs in Settings → Campaigns → Opt-outs. To request removal of a specific client's opt-out record (e.g. they have re-consented), email us at <a href="mailto:${escapeAttr(LEGAL_CONTACT_EMAIL)}">${escapeAttr(LEGAL_CONTACT_EMAIL)}</a>.</p>

<h2>5. Meta data deletion callback</h2>
<p>If you remove BusyDays from your Facebook/Instagram account, Meta sends us a signed data-deletion request. We verify it, disconnect the associated channels, and return a confirmation code and this status URL, as required by Meta Platform policy. The callback endpoint is <code>/compliance/meta/data-deletion</code>.</p>

<h2>What gets deleted</h2>
<ul>
  <li>OAuth access and refresh tokens (revoked and removed).</li>
  <li>Meta channel connection records for your workspace.</li>
  <li>On full workspace deletion: lead, booking, interaction, wallet and conversation-memory records in our database.</li>
  <li>WhatsApp opt-out records for your workspace are also purged on deletion.</li>
</ul>`,
    ),
  );
});

// ---- Pretty booking links: /glowbyaisha → her booking page ----
// Registered last so it can never shadow a real route; the reserved list
// protects future top-level paths too. The pretty link is what goes in her
// Instagram bio; it resolves to the canonical /book/:workspaceId page.
function normalizeSlug(raw: string): string {
  const slug = String(raw || "").trim().toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug) ? slug : "";
}

const RESERVED_SLUGS = new Set([
  "api", "auth", "book", "pay", "sign", "dev", "webhooks", "compliance", "legal",
  "d", "q", "b", "app", "admin", "login", "logout", "static", "assets", "public",
  "healthz", "health", "status", "privacy", "terms", "about", "help", "support",
  "settings", "dashboard", "index", "manifest.json", "sw.js", "favicon.ico", "robots.txt",
]);

// The pretty link is a public, unauthenticated route hit by bots and crawlers.
// listWorkspaces() scans every workspace, so a per-request scan is a needless
// load multiplier. Slugs change rarely, so cache the slug→workspaceId map for a
// short window; the worst case is a freshly-set slug taking up to a minute to
// resolve, which is invisible for a redirect.
let slugMapCache: { map: Map<string, string>; expires: number } | null = null;
const SLUG_CACHE_TTL_MS = 60_000;

async function resolveSlugToWorkspaceId(slug: string): Promise<string | null> {
  const now = Date.now();
  if (!slugMapCache || slugMapCache.expires < now) {
    const all = await listWorkspaces();
    const map = new Map<string, string>();
    for (const w of all) {
      const s = normalizeSlug(w.config?.bookingSlug || "");
      if (s) map.set(s, w.workspaceId);
    }
    slugMapCache = { map, expires: now + SLUG_CACHE_TTL_MS };
  }
  return slugMapCache.map.get(slug) ?? null;
}

app.get("/:slug", async (req, res, next) => {
  try {
    const slug = normalizeSlug(String(req.params.slug ?? ""));
    if (!slug || RESERVED_SLUGS.has(slug)) return next();
    const workspaceId = await resolveSlugToWorkspaceId(slug);
    if (!workspaceId) return next();
    res.redirect(302, `/book/${encodeURIComponent(workspaceId)}`);
  } catch {
    next();
  }
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

  // A rejected promise nobody awaited (fire-and-forget notifications, scheduler
  // ticks) must be visible in logs/Sentry, not silently swallowed — and on
  // modern Node it would otherwise crash the process.
  process.on("unhandledRejection", (reason) => {
    captureException(reason, { phase: "unhandledRejection" });
  });
  // After a truly unexpected synchronous throw the process state is undefined;
  // log it and exit so the platform restarts us clean rather than limping on.
  process.on("uncaughtException", (error) => {
    captureException(error, { phase: "uncaughtException" });
    process.exit(1);
  });

  const server = app.listen(appConfig.port, () => {
    logger.info("BusyDays app listening", {
      baseUrl: appConfig.baseUrl,
      env: appConfig.appEnv,
      persistence: appConfig.databaseUrl ? "postgres" : "file",
      tokenEncryption: encryptionEnabled() ? "on" : "off",
    });
    startReminderScheduler();
    void rehydrateInterruptedCampaigns();
    // Housekeeping: trim the webhook dedup ledger now and once a day so it
    // never grows unbounded. unref() keeps it from holding the process open.
    void cleanupOldWebhookEvents();
    const webhookCleanup = setInterval(() => void cleanupOldWebhookEvents(), 24 * 60 * 60 * 1000);
    webhookCleanup.unref();
  });

  // Graceful shutdown: on a deploy/restart Railway sends SIGTERM. Stop accepting
  // new connections, let in-flight requests finish, close the DB pool, then exit.
  // A hard 10s timeout guarantees we never hang the platform's shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_initiated", { signal });

    // 30s drain window: long enough for slow Sheets/PDF requests to finish,
    // still well inside typical platform kill timeouts.
    const forceExit = setTimeout(() => {
      logger.error("shutdown_forced", { signal });
      process.exit(1);
    }, 30_000);
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

function buildRescheduleNotice(workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceByEmail>>>, booking: BookingRecord) {
  const biz = workspace.config.businessName || workspace.config.ownerName || "your artist";
  // Parse the date at local midnight so the weekday/day never shifts across the
  // UTC boundary the way `new Date("YYYY-MM-DD")` (which is UTC) would.
  const parsed = new Date(`${booking.eventDate}T00:00:00`);
  const dateStr = Number.isNaN(parsed.getTime())
    ? booking.eventDate
    : parsed.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const timeStr = booking.eventTime ? ` at ${booking.eventTime}` : "";
  const venueStr = booking.venue ? `\n📍 ${booking.venue}` : "";
  return [
    `Hi ${booking.clientName || "love"} 🙏`,
    "",
    `Your ${booking.eventType} booking has been updated. Here are the new details:`,
    "",
    `📅 ${dateStr}${timeStr}${venueStr}`,
    "",
    `See you then!\n— ${biz}`,
  ].join("\n");
}

// Tell the client when their booking moves. The artist just changed the one
// thing the client most needs to know (date/time/venue), so send it through the
// same compliant path used for invoices/contracts instead of a "remember to
// tell the client" prompt. Best-effort: a messaging failure never blocks the
// reschedule. Returns whether a message was actually dispatched.
async function notifyClientOfReschedule(
  email: string,
  tokens: Credentials,
  workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceByEmail>>>,
  booking: BookingRecord,
): Promise<boolean> {
  try {
    if (!booking.leadId) return false;
    const lead = await getLeadRecord(email, tokens, booking.leadId);
    if (!lead) return false;
    const ctx = resolveLeadMessagingContext(workspace, lead);
    if (!ctx) return false;
    const message = buildRescheduleNotice(workspace, booking);
    await sendBusinessMessage({
      workspace,
      connection: ctx.connection,
      channel: ctx.channel,
      actorId: ctx.actorId,
      message,
    });
    await logInteractionForWorkspace(email, tokens, {
      leadId: lead.leadId,
      direction: "Outbound",
      channel: ctx.channel,
      actor: ctx.actorId,
      message,
      aiSummary: "Reschedule notice sent",
    });
    return true;
  } catch {
    return false;
  }
}

// wa.me deep link with the message prefilled. Used as the manual fallback for
// business-initiated reminders before the WhatsApp API pipe is connected: the
// artist taps it, WhatsApp opens with the message ready, and the reminder is
// recorded as handled. Returns "" when there's no usable phone number.
function buildWaMeReminderLink(phone: string, message: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
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
