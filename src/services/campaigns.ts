import type { Credentials } from "google-auth-library";
import type { WorkspaceRecord } from "../types.js";
import { getWorkspaceByEmail } from "./workspace.js";
import { createGoogleClients } from "./google.js";
import { bookingHeaders, leadHeaders, sheetNames } from "./sheet-definitions.js";
import { fetchWithTimeout } from "./http.js";
import { appConfig } from "../config.js";
import { buildAppSecretProof } from "./meta.js";
import { loadClientNotes } from "./client-notes.js";
import { isPhoneOptedOut, listOptedOutPhones, loadCampaignBroadcast, markInterruptedCampaigns, saveCampaignBroadcast } from "./database.js";
import { captureException, logger } from "./logger.js";

export type CampaignSegment =
  | "past-clients"         // all completed bookings (deduplicated by phone)
  | "confirmed-this-year"  // bookings confirmed/ongoing this calendar year
  | "pending-leads"        // leads with New / Hold / Awaiting Client status
  | "all-past-leads"       // every lead that ever arrived (deduplicated)
  | "slipping-away"        // last completed booking was 90+ days ago
  | "birthday-this-month"  // client has birthday stored in notes in current month
  | "vip-clients"          // 3+ completed bookings
  | "new-clients";         // first booking within last 60 days

type Contact = { name: string; phone: string };

function toCol(n: number): string {
  let col = "";
  for (let d = n; d > 0; ) { const r = (d - 1) % 26; col = String.fromCharCode(65 + r) + col; d = Math.floor((d - r) / 26); }
  return col;
}
type ContactStatus = { name: string; phone: string; status: "sent" | "failed" | "skipped"; error?: string };

export type BroadcastResult = {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  contacts: ContactStatus[];
};

async function listCampaignContacts(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  segment: CampaignSegment,
): Promise<Contact[]> {
  const { sheets } = createGoogleClients(tokens);
  const now = new Date();
  const thisYear = now.getFullYear().toString();

  if (segment === "pending-leads" || segment === "all-past-leads") {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.leads}!A2:${toCol(leadHeaders.length)}`,
    });
    const rows = res.data.values ?? [];
    const seen = new Set<string>();
    const contacts: Contact[] = [];
    const iStatus = leadHeaders.indexOf("Status");
    const iPhone = leadHeaders.indexOf("Client WhatsApp");
    const iName = leadHeaders.indexOf("Client Name");
    for (const row of rows) {
      if (!row[0]) continue;
      const status = String(row[iStatus] ?? "");
      const phone = String(row[iPhone] ?? "").replace(/\D/g, "");
      const name = String(row[iName] ?? "Unknown");
      if (!phone || phone.length < 8) continue;
      if (segment === "pending-leads" && !["New", "Hold", "Awaiting Client"].includes(status)) continue;
      if (!seen.has(phone)) { seen.add(phone); contacts.push({ name, phone }); }
    }
    return contacts;
  }

  // booking-based segments
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: workspace.spreadsheetId,
    range: `${sheetNames.bookings}!A2:${toCol(bookingHeaders.length)}`,
  });
  const rows = res.data.values ?? [];
  const iStatus = bookingHeaders.indexOf("Status");
  const iDate = bookingHeaders.indexOf("Event Date");
  const iBookedAt = bookingHeaders.indexOf("Booked At");
  const iPhone = bookingHeaders.indexOf("Client WhatsApp");
  const iName = bookingHeaders.indexOf("Client Name");

  // Build per-phone aggregates for smart segments
  const phoneMap = new Map<string, { name: string; completedCount: number; lastCompletedDate: Date | null; firstBookingDate: Date | null }>();
  for (const row of rows) {
    if (!row[0]) continue;
    const status = String(row[iStatus] ?? "");
    if (status === "Cancelled") continue;
    const phone = String(row[iPhone] ?? "").replace(/\D/g, "");
    const name = String(row[iName] ?? "Unknown");
    if (!phone || phone.length < 8) continue;
    const eventDate = row[iDate] ? new Date(String(row[iDate])) : null;
    const bookedAt = row[iBookedAt] ? new Date(String(row[iBookedAt])) : null;
    const existing = phoneMap.get(phone);
    if (!existing) {
      phoneMap.set(phone, {
        name,
        completedCount: status === "Completed" ? 1 : 0,
        lastCompletedDate: status === "Completed" && eventDate && !isNaN(eventDate.getTime()) ? eventDate : null,
        firstBookingDate: bookedAt && !isNaN(bookedAt.getTime()) ? bookedAt : null,
      });
    } else {
      if (status === "Completed") {
        existing.completedCount++;
        if (eventDate && !isNaN(eventDate.getTime())) {
          if (!existing.lastCompletedDate || eventDate > existing.lastCompletedDate) {
            existing.lastCompletedDate = eventDate;
          }
        }
      }
      if (bookedAt && !isNaN(bookedAt.getTime())) {
        if (!existing.firstBookingDate || bookedAt < existing.firstBookingDate) {
          existing.firstBookingDate = bookedAt;
        }
      }
    }
  }

  if (segment === "birthday-this-month") {
    const currentMonth = now.getMonth() + 1; // 1-12
    const phones = Array.from(phoneMap.keys());
    const notesEntries = await Promise.all(
      phones.map(async (phone) => {
        const notes = await loadClientNotes(workspace.workspaceId, phone);
        return { phone, notes };
      }),
    );
    const contacts: Contact[] = [];
    for (const { phone, notes } of notesEntries) {
      if (!notes.birthday) continue;
      const [, mm] = notes.birthday.split("-");
      if (parseInt(mm, 10) !== currentMonth) continue;
      const entry = phoneMap.get(phone);
      contacts.push({ name: entry?.name ?? "Client", phone });
    }
    return contacts;
  }

  const cutoff90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const cutoff60 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const seen = new Set<string>();
  const contacts: Contact[] = [];
  for (const row of rows) {
    if (!row[0]) continue;
    const status = String(row[iStatus] ?? "");
    const eventDate = String(row[iDate] ?? "");
    const phone = String(row[iPhone] ?? "").replace(/\D/g, "");
    const name = String(row[iName] ?? "Unknown");
    if (!phone || phone.length < 8) continue;
    if (status === "Cancelled") continue;

    if (segment === "past-clients" && status !== "Completed") continue;
    if (segment === "confirmed-this-year" && !eventDate.startsWith(thisYear)) continue;

    if (!seen.has(phone)) {
      if (segment === "slipping-away") {
        const agg = phoneMap.get(phone);
        if (!agg || agg.completedCount === 0) continue;
        if (agg.lastCompletedDate && agg.lastCompletedDate > cutoff90) continue;
      }
      if (segment === "vip-clients") {
        const agg = phoneMap.get(phone);
        if (!agg || agg.completedCount < 3) continue;
      }
      if (segment === "new-clients") {
        const agg = phoneMap.get(phone);
        if (!agg || !agg.firstBookingDate || agg.firstBookingDate < cutoff60) continue;
        if (agg.completedCount < 1) continue;
      }
      seen.add(phone);
      contacts.push({ name, phone });
    }
  }
  return contacts;
}

async function sendOneWhatsApp(
  workspace: WorkspaceRecord,
  phone: string,
  message: string,
  imageUrl?: string,
): Promise<void> {
  const connection = workspace.metaConnections?.whatsapp;
  const accessToken = connection?.accessToken || appConfig.waAccessToken;
  const phoneNumberId = connection?.phoneNumberId || appConfig.waPhoneNumberId;
  if (!accessToken || !phoneNumberId) throw new Error("WhatsApp not configured");

  const url = new URL(`https://graph.facebook.com/v23.0/${phoneNumberId}/messages`);
  const proof = buildAppSecretProof(accessToken);
  if (proof) url.searchParams.set("appsecret_proof", proof);

  const body = imageUrl
    ? { messaging_product: "whatsapp", to: phone, type: "image", image: { link: imageUrl, ...(message ? { caption: message } : {}) } }
    : { messaging_product: "whatsapp", to: phone, type: "text", text: { body: message } };

  const resp = await fetchWithTimeout(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(await resp.text());
}

// WhatsApp Business Policy requires an opt-out instruction in every marketing
// message. Append a standard footer so contacts always know how to stop.
function withOptOutFooter(message: string, businessName: string): string {
  const name = businessName.trim() || "this business";
  const footer = `\n\nReply STOP to stop receiving messages from ${name}.`;
  // Don't duplicate if the artist already wrote their own footer.
  if (/\bSTOP\b/i.test(message)) return message;
  return message + footer;
}

export async function broadcastCampaign(
  email: string,
  tokens: Credentials,
  input: { segment: CampaignSegment; message: string; imageUrl?: string },
  onProgress?: (partial: BroadcastResult) => void,
): Promise<BroadcastResult> {
  const workspace = await getWorkspaceByEmail(email);
  if (!workspace) throw new Error("Workspace not found");

  const allContacts = await listCampaignContacts(workspace, tokens, input.segment);

  // Filter out contacts who have opted out of receiving campaign messages.
  const optedOutPhones = new Set(await listOptedOutPhones(workspace.workspaceId));
  const eligible = allContacts.filter((c) => !optedOutPhones.has(c.phone.replace(/\D/g, "")));
  const capped = eligible.slice(0, 200);
  const totalSkipped = allContacts.length - eligible.length + Math.max(0, eligible.length - 200);

  // Ensure every campaign message carries an opt-out instruction (WhatsApp
  // Business Policy §4.2 / Meta Messaging Guidelines). Append footer unless the
  // artist already included "STOP" in their message.
  const messageWithFooter = withOptOutFooter(
    input.message,
    workspace.config?.ownerName || workspace.config?.businessName || "",
  );

  const results: ContactStatus[] = [];
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < capped.length; i++) {
    const c = capped[i];
    // Throttle: 1 message per second to stay within API rate limits.
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      await sendOneWhatsApp(workspace, c.phone, messageWithFooter, input.imageUrl);
      results.push({ name: c.name, phone: c.phone, status: "sent" });
      sent++;
    } catch (err) {
      results.push({ name: c.name, phone: c.phone, status: "failed", error: String(err) });
      failed++;
    }
    onProgress?.({ total: allContacts.length, sent, failed, skipped: totalSkipped, contacts: results });
  }

  return { total: allContacts.length, sent, failed, skipped: totalSkipped, contacts: results };
}

// ── Background broadcast jobs ────────────────────────────────────────────────
// A 200-contact broadcast takes ~200s (1 msg/s throttle) — far too long to hold
// an HTTP request open. The route starts a job, returns the id immediately, and
// the UI polls for progress. Jobs are in-process: if the instance restarts
// mid-broadcast the job is lost, but every message already sent has been sent —
// the status endpoint reporting "job not found" tells the UI to say exactly that.

export type CampaignJob = {
  id: string;
  email: string; // owner — status reads are scoped to the requesting account
  status: "running" | "done" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result: BroadcastResult;
};

const campaignJobs = new Map<string, CampaignJob>();
const MAX_FINISHED_JOBS = 50;

function pruneFinishedJobs() {
  const finished = [...campaignJobs.values()].filter((j) => j.status !== "running");
  if (finished.length <= MAX_FINISHED_JOBS) return;
  finished
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""))
    .slice(0, finished.length - MAX_FINISHED_JOBS)
    .forEach((j) => campaignJobs.delete(j.id));
}

export function startCampaignBroadcast(
  email: string,
  tokens: Credentials,
  input: { segment: CampaignSegment; message: string; imageUrl?: string },
): CampaignJob {
  // One broadcast at a time per account — double-tapping "Send" must not
  // double-message every client.
  const running = [...campaignJobs.values()].find((j) => j.email === email && j.status === "running");
  if (running) throw new Error("A broadcast is already in progress. Wait for it to finish.");

  const job: CampaignJob = {
    id: `CMP_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    email,
    status: "running",
    startedAt: new Date().toISOString(),
    result: { total: 0, sent: 0, failed: 0, skipped: 0, contacts: [] },
  };
  campaignJobs.set(job.id, job);

  // Persist immediately so the job is visible if the instance restarts.
  void saveCampaignBroadcast(job).catch((err) => captureException(err, { jobId: job.id }));

  let lastDbSave = Date.now();
  const DB_SAVE_INTERVAL_MS = 5_000;

  void broadcastCampaign(email, tokens, input, (partial) => {
    job.result = partial;
    // Checkpoint to Postgres every 5 s so progress survives a restart.
    const now = Date.now();
    if (now - lastDbSave >= DB_SAVE_INTERVAL_MS) {
      lastDbSave = now;
      void saveCampaignBroadcast(job).catch((err) => captureException(err, { jobId: job.id }));
    }
  })
    .then((result) => {
      job.result = result;
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      void saveCampaignBroadcast(job).catch((err) => captureException(err, { jobId: job.id }));
    })
    .catch((err) => {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
      void saveCampaignBroadcast(job).catch((e) => captureException(e, { jobId: job.id }));
    })
    .finally(pruneFinishedJobs);

  return job;
}

export async function getCampaignJob(email: string, jobId: string): Promise<CampaignJob | null> {
  const job = campaignJobs.get(jobId);
  if (job) {
    if (job.email !== email) return null;
    return job;
  }
  // Fall back to Postgres — the job may be from a previous instance.
  const persisted = await loadCampaignBroadcast(jobId, email);
  if (!persisted) return null;
  return {
    id: persisted.id,
    email: persisted.email,
    status: persisted.status as CampaignJob["status"],
    startedAt: persisted.startedAt,
    finishedAt: persisted.finishedAt,
    error: persisted.error,
    result: persisted.result as BroadcastResult,
  };
}

// Called once at startup. Any broadcast still "running" in the DB is an
// interrupted job from the previous instance — surface it as "interrupted"
// so the UI can inform the user rather than reporting "job not found".
export async function rehydrateInterruptedCampaigns(): Promise<void> {
  const count = await markInterruptedCampaigns();
  if (count > 0) {
    logger.warn("[campaigns] interrupted_on_restart", { count });
  }
}

export async function estimateCampaignReach(
  email: string,
  tokens: Credentials,
  segment: CampaignSegment,
): Promise<number> {
  const workspace = await getWorkspaceByEmail(email);
  if (!workspace) throw new Error("Workspace not found");
  const contacts = await listCampaignContacts(workspace, tokens, segment);
  return contacts.length;
}
