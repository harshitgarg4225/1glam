import { getWorkspaceCredentials } from "./auth-store.js";
import { getDashboardData, listActiveBookings, markBookingReminderSent, recordReviewRequest } from "./booking.js";
import { listWorkspaces, withDistributedLock } from "./database.js";
import { buildDigestSummary } from "./insights.js";
import { logInteractionForWorkspace } from "./integrations.js";
import { logger, captureException } from "./logger.js";
import { sendWhatsAppTemplate } from "./messaging.js";
import { sendPushToWorkspace } from "./push.js";
import { appConfig } from "../config.js";

// Stable advisory-lock keys so only one instance runs each daily job.
const REMINDER_LOCK_KEY = 918_273_001;
const REVIEW_LOCK_KEY = 918_273_002;
const PAYMENT_LOCK_KEY = 918_273_003;
const DIGEST_LOCK_KEY = 918_273_004;

// Spread per-workspace Sheets reads across time so a large fleet doesn't
// burst the Google Sheets API all at once at 8 UTC. 200 ms × 500 workspaces
// ≈ 100 s — well within the hour window, nearly invisible to users.
const WORKSPACE_STAGGER_MS = 200;
const stagger = (i: number): Promise<void> =>
  i > 0 ? new Promise((r) => setTimeout(r, WORKSPACE_STAGGER_MS)) : Promise.resolve();

export function startReminderScheduler() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setUTCHours(8, 0, 0, 0);
  if (nextRun <= now) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }

  const msUntilFirst = nextRun.getTime() - now.getTime();

  const tick = () => {
    // Each job is guarded by a distributed lock: with multiple instances, only
    // the one that acquires the lock sends; the rest skip, so no double-sends.
    withDistributedLock(REMINDER_LOCK_KEY, runReminderJob)
      .then((r) => { if (!r.ran) logger.info("[reminders] skipped — another instance holds the lock"); })
      .catch((err) => captureException(err, { job: "reminders" }));
    withDistributedLock(REVIEW_LOCK_KEY, runReviewRequestJob)
      .then((r) => { if (!r.ran) logger.info("[reviews] skipped — another instance holds the lock"); })
      .catch((err) => captureException(err, { job: "reviews" }));
    withDistributedLock(PAYMENT_LOCK_KEY, runPaymentReminderJob)
      .then((r) => { if (!r.ran) logger.info("[payments] skipped — another instance holds the lock"); })
      .catch((err) => captureException(err, { job: "payments" }));
    setTimeout(tick, 24 * 60 * 60 * 1000);
  };

  setTimeout(tick, msUntilFirst);
  logger.info("[reminders] scheduler started", { firstRun: nextRun.toISOString() });

  // Morning digest runs on its own clock: 02:30 UTC = 08:00 IST, the start of
  // her day, not the 13:30 IST slot the maintenance jobs use.
  const digestNext = new Date(now);
  digestNext.setUTCHours(2, 30, 0, 0);
  if (digestNext <= now) digestNext.setUTCDate(digestNext.getUTCDate() + 1);

  const digestTick = () => {
    withDistributedLock(DIGEST_LOCK_KEY, runMorningDigestJob)
      .then((r) => { if (!r.ran) logger.info("[digest] skipped — another instance holds the lock"); })
      .catch((err) => captureException(err, { job: "digest" }));
    setTimeout(digestTick, 24 * 60 * 60 * 1000);
  };
  setTimeout(digestTick, digestNext.getTime() - now.getTime());
  logger.info("[digest] scheduler started", { firstRun: digestNext.toISOString() });
}

// Morning digest: one push per workspace at 8 AM IST with today's jobs and the
// action items the insights engine found (stale quotes, pending advances, open
// waitlist slots). Skips workspaces with nothing to say or digests turned off;
// sendPushToWorkspace already no-ops when no device/subscription is registered.
async function runMorningDigestJob() {
  logger.info("[digest] running morning digest job");
  const workspaces = await listWorkspaces();

  for (let i = 0; i < workspaces.length; i++) {
    await stagger(i);
    const workspace = workspaces[i];
    if (String(workspace.config.dailyDigest || "Yes").toLowerCase() === "no") continue;
    const hasDevices =
      (workspace.pushSubscriptions?.length ?? 0) > 0 || (workspace.deviceTokens?.length ?? 0) > 0;
    if (!hasDevices) continue;

    try {
      const tokens = await getWorkspaceCredentials(workspace.email);
      const { leads, bookings } = await getDashboardData(workspace.email, tokens);
      const digest = buildDigestSummary({ config: workspace.config, leads, bookings });
      if (!digest) continue;
      await sendPushToWorkspace(workspace, { title: digest.title, body: digest.body, url: "/" });
    } catch (err) {
      captureException(err, { workspace: workspace.email, job: "digest" });
    }
  }

  logger.info("[digest] morning digest job complete");
}

async function runReminderJob() {
  logger.info("[reminders] running daily job");
  const workspaces = await listWorkspaces();

  for (let i = 0; i < workspaces.length; i++) {
    await stagger(i);
    const workspace = workspaces[i];
    const templateName = String(workspace.config.reminderTemplate || "").trim();
    if (!templateName) continue;

    const whatsapp = workspace.metaConnections?.whatsapp;
    const connectionCanSend =
      whatsapp?.status === "connected" && Boolean(whatsapp.accessToken && whatsapp.phoneNumberId);
    const envCanSend = Boolean(appConfig.waAccessToken && appConfig.waPhoneNumberId);
    if (!connectionCanSend && !envCanSend) continue;

    const daysBefore = parseReminderDays(workspace.config.reminderDaysBefore);
    if (!daysBefore.length) continue;

    try {
      const tokens = await getWorkspaceCredentials(workspace.email);
      const bookings = await listActiveBookings(workspace.email, tokens);

      for (const booking of bookings) {
        if (!booking.clientWhatsApp || !booking.eventDate) continue;

        for (const day of daysBefore) {
          const targetDate = addDaysToIso(day);
          if (booking.eventDate !== targetDate) continue;

          const alreadySent = (booking.remindersSent || "")
            .split(",")
            .map((s) => s.trim())
            .includes(String(day));
          if (alreadySent) continue;

          const recipientPhone = booking.clientWhatsApp.replace(/[^\d]/g, "");
          const eventTime = booking.eventTime || "TBD";

          try {
            await sendWhatsAppTemplate(
              { accessToken: whatsapp?.accessToken, phoneNumberId: whatsapp?.phoneNumberId },
              recipientPhone,
              templateName,
              String(workspace.config.reminderTemplateLang || "en"),
              [booking.clientName, booking.eventDate, eventTime],
            );

            await markBookingReminderSent(workspace.email, tokens, booking.bookingId, String(day));

            await logInteractionForWorkspace(workspace.email, tokens, {
              leadId: booking.leadId,
              direction: "Outbound",
              channel: "WhatsApp",
              actor: recipientPhone,
              message: `T-${day} reminder template "${templateName}" sent`,
              aiSummary: `Automated ${day}-day pre-event reminder`,
            });
          } catch (err) {
            captureException(err, { bookingId: booking.bookingId, day });
          }
        }
      }
    } catch (err) {
      captureException(err, { workspace: workspace.email });
    }
  }

  logger.info("[reminders] daily job complete");
}

// Automated post-event review requests. For each booking whose event was N days
// ago (N = reviewRequestDaysAfter), send the review template once and record it
// in the Reviews sheet. Deduplicated via the booking's remindersSent marker.
async function runReviewRequestJob() {
  const REVIEW_MARKER = "review";
  const workspaces = await listWorkspaces();

  for (let i = 0; i < workspaces.length; i++) {
    await stagger(i);
    const workspace = workspaces[i];
    const daysAfter = parseFirstPositiveInt(workspace.config.reviewRequestDaysAfter);
    if (daysAfter === null) continue;

    const templateName = String(workspace.config.reviewTemplate || "").trim();
    if (!templateName) continue;

    const whatsapp = workspace.metaConnections?.whatsapp;
    const connectionCanSend =
      whatsapp?.status === "connected" && Boolean(whatsapp.accessToken && whatsapp.phoneNumberId);
    const envCanSend = Boolean(appConfig.waAccessToken && appConfig.waPhoneNumberId);
    if (!connectionCanSend && !envCanSend) continue;

    const targetDate = addDaysToIso(-daysAfter);

    try {
      const tokens = await getWorkspaceCredentials(workspace.email);
      const bookings = await listActiveBookings(workspace.email, tokens);

      for (const booking of bookings) {
        if (!booking.clientWhatsApp || booking.eventDate !== targetDate) continue;

        const alreadySent = (booking.remindersSent || "")
          .split(",")
          .map((s) => s.trim())
          .includes(REVIEW_MARKER);
        if (alreadySent) continue;

        const recipientPhone = booking.clientWhatsApp.replace(/[^\d]/g, "");
        const reviewLink = String(workspace.config.googleReviewLink || "");

        try {
          await sendWhatsAppTemplate(
            { accessToken: whatsapp?.accessToken, phoneNumberId: whatsapp?.phoneNumberId },
            recipientPhone,
            templateName,
            String(workspace.config.reviewTemplateLang || "en"),
            [booking.clientName, workspace.config.businessName || workspace.name, reviewLink],
          );

          await markBookingReminderSent(workspace.email, tokens, booking.bookingId, REVIEW_MARKER);
          await recordReviewRequest(workspace.email, tokens, {
            leadId: booking.leadId,
            clientName: booking.clientName,
            eventDate: booking.eventDate,
            type: "request",
          });

          await logInteractionForWorkspace(workspace.email, tokens, {
            leadId: booking.leadId,
            direction: "Outbound",
            channel: "WhatsApp",
            actor: recipientPhone,
            message: `Automated review request template "${templateName}" sent`,
            aiSummary: `Automated post-event review request (T+${daysAfter})`,
          });
        } catch (err) {
          captureException(err, { bookingId: booking.bookingId });
        }
      }
    } catch (err) {
      captureException(err, { workspace: workspace.email });
    }
  }
}

// Automatic payment collection. Two cases, both deduplicated through the
// booking's remindersSent markers so the daily job never nags twice:
//   - Advance still due: gentle nudges 2, 5, and 8 days after booking.
//   - Balance still due: one reminder 2 days before the event.
// Gated per workspace by autoPaymentReminders (on by default) and, like every
// business-initiated WhatsApp message, requires an approved template.
const ADVANCE_NUDGE_DAYS = [2, 5, 8];

export function dueAdvanceMarker(bookedAt: string, remindersSent: string, now: Date = new Date()): string | null {
  const booked = new Date(bookedAt);
  if (isNaN(booked.getTime())) return null;
  const daysSince = Math.floor((now.getTime() - booked.getTime()) / 86_400_000);
  const sent = (remindersSent || "").split(",").map((s) => s.trim());
  // Highest eligible nudge not yet sent — so a booking that's 9 days old with
  // no nudges sent gets one message (the latest), not three at once.
  for (let i = ADVANCE_NUDGE_DAYS.length - 1; i >= 0; i--) {
    if (daysSince >= ADVANCE_NUDGE_DAYS[i]) {
      const marker = `payadv${i + 1}`;
      return sent.includes(marker) ? null : marker;
    }
  }
  return null;
}

export function balanceReminderDue(eventDate: string, remindersSent: string, now: Date = new Date()): boolean {
  if (!eventDate) return false;
  const sent = (remindersSent || "").split(",").map((s) => s.trim());
  if (sent.includes("paybal")) return false;
  const event = new Date(`${eventDate}T00:00:00Z`);
  if (isNaN(event.getTime())) return false;
  const daysUntil = Math.ceil((event.getTime() - now.getTime()) / 86_400_000);
  return daysUntil >= 0 && daysUntil <= 2;
}

async function runPaymentReminderJob() {
  logger.info("[payments] running daily payment-reminder job");
  const workspaces = await listWorkspaces();

  for (let i = 0; i < workspaces.length; i++) {
    await stagger(i);
    const workspace = workspaces[i];
    if (String(workspace.config.autoPaymentReminders || "Yes") === "No") continue;

    const templateName = String(workspace.config.collectionTemplate || "").trim();
    if (!templateName) continue;

    const whatsapp = workspace.metaConnections?.whatsapp;
    const connectionCanSend =
      whatsapp?.status === "connected" && Boolean(whatsapp.accessToken && whatsapp.phoneNumberId);
    const envCanSend = Boolean(appConfig.waAccessToken && appConfig.waPhoneNumberId);
    if (!connectionCanSend && !envCanSend) continue;

    try {
      const tokens = await getWorkspaceCredentials(workspace.email);
      const bookings = await listActiveBookings(workspace.email, tokens);

      for (const booking of bookings) {
        if (!booking.clientWhatsApp) continue;
        const recipientPhone = booking.clientWhatsApp.replace(/[^\d]/g, "");

        let kind: "advance" | "balance" | null = null;
        let marker = "";
        if (booking.paymentStatus === "Advance Due" && booking.advanceAmount > 0) {
          const m = dueAdvanceMarker(booking.bookedAt, booking.remindersSent);
          if (m) { kind = "advance"; marker = m; }
        } else if (booking.paymentStatus === "Advance Paid" && booking.balanceDue > 0) {
          if (balanceReminderDue(booking.eventDate, booking.remindersSent)) {
            kind = "balance"; marker = "paybal";
          }
        }
        if (!kind) continue;

        const amount = kind === "balance" ? booking.balanceDue : booking.advanceAmount;
        try {
          await sendWhatsAppTemplate(
            { accessToken: whatsapp?.accessToken, phoneNumberId: whatsapp?.phoneNumberId },
            recipientPhone,
            templateName,
            String(workspace.config.collectionTemplateLang || "en"),
            [booking.clientName, kind, String(amount), booking.eventDate],
          );

          await markBookingReminderSent(workspace.email, tokens, booking.bookingId, marker);

          await logInteractionForWorkspace(workspace.email, tokens, {
            leadId: booking.leadId,
            direction: "Outbound",
            channel: "WhatsApp",
            actor: recipientPhone,
            message: `Automatic ${kind} payment reminder sent (₹${amount})`,
            aiSummary: `Automated ${kind} collection reminder (${marker})`,
          });
        } catch (err) {
          captureException(err, { bookingId: booking.bookingId, kind });
        }
      }
    } catch (err) {
      captureException(err, { workspace: workspace.email });
    }
  }

  logger.info("[payments] daily payment-reminder job complete");
}

function parseFirstPositiveInt(raw: string): number | null {
  const n = parseInt(String(raw || "").split(",")[0]?.trim(), 10);
  return !isNaN(n) && n > 0 ? n : null;
}

function parseReminderDays(raw: string): number[] {
  return [
    ...new Set(
      String(raw || "7,1")
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0),
    ),
  ];
}

function addDaysToIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
