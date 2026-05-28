import { appConfig } from "../config.js";
import { getWorkspaceCredentials } from "./auth-store.js";
import { listActiveBookings, markBookingReminderSent } from "./booking.js";
import { listWorkspaces } from "./database.js";
import { logInteractionForWorkspace } from "./integrations.js";
import { sendWhatsAppTemplate } from "./messaging.js";

export function startReminderScheduler() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setUTCHours(8, 0, 0, 0);
  if (nextRun <= now) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }

  const msUntilFirst = nextRun.getTime() - now.getTime();

  const tick = () => {
    runReminderJob().catch((err) => console.error("[reminders] job failed:", err));
    setTimeout(tick, 24 * 60 * 60 * 1000);
  };

  setTimeout(tick, msUntilFirst);
  console.log(`[reminders] scheduler started. First run at ${nextRun.toISOString()}`);
}

async function runReminderJob() {
  console.log("[reminders] running daily job");
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
            console.error(
              `[reminders] send failed for booking ${booking.bookingId} (T-${day}):`,
              err,
            );
          }
        }
      }
    } catch (err) {
      console.error(`[reminders] workspace ${workspace.email} failed:`, err);
    }
  }

  console.log("[reminders] daily job complete");
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
