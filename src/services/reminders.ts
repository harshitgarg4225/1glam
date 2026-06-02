import { getWorkspaceCredentials } from "./auth-store.js";
import { listActiveBookings, markBookingReminderSent, recordReviewRequest } from "./booking.js";
import { listWorkspaces, withDistributedLock } from "./database.js";
import { logInteractionForWorkspace } from "./integrations.js";
import { logger, captureException } from "./logger.js";
import { sendWhatsAppTemplate } from "./messaging.js";
import { appConfig } from "../config.js";

// Stable advisory-lock keys so only one instance runs each daily job.
const REMINDER_LOCK_KEY = 918_273_001;
const REVIEW_LOCK_KEY = 918_273_002;

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
    setTimeout(tick, 24 * 60 * 60 * 1000);
  };

  setTimeout(tick, msUntilFirst);
  logger.info("[reminders] scheduler started", { firstRun: nextRun.toISOString() });
}

async function runReminderJob() {
  logger.info("[reminders] running daily job");
  const workspaces = await listWorkspaces();

  for (const workspace of workspaces) {
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

  for (const workspace of workspaces) {
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
