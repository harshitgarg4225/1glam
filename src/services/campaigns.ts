import type { Credentials } from "google-auth-library";
import type { WorkspaceRecord } from "../types.js";
import { getWorkspaceByEmail } from "./workspace.js";
import { createGoogleClients } from "./google.js";
import { bookingHeaders, leadHeaders, sheetNames } from "./sheet-definitions.js";
import { fetchWithTimeout } from "./http.js";
import { appConfig } from "../config.js";
import { buildAppSecretProof } from "./meta.js";

export type CampaignSegment =
  | "past-clients"         // all completed bookings (deduplicated by phone)
  | "confirmed-this-year"  // bookings confirmed/ongoing this calendar year
  | "pending-leads"        // leads with New / Hold / Awaiting Client status
  | "all-past-leads";      // every lead that ever arrived (deduplicated)

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
  const seen = new Set<string>();
  const contacts: Contact[] = [];
  const iStatus = bookingHeaders.indexOf("Status");
  const iDate = bookingHeaders.indexOf("Event Date");
  const iPhone = bookingHeaders.indexOf("Client WhatsApp");
  const iName = bookingHeaders.indexOf("Client Name");

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

    if (!seen.has(phone)) { seen.add(phone); contacts.push({ name, phone }); }
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

export async function broadcastCampaign(
  email: string,
  tokens: Credentials,
  input: { segment: CampaignSegment; message: string; imageUrl?: string },
): Promise<BroadcastResult> {
  const workspace = await getWorkspaceByEmail(email);
  if (!workspace) throw new Error("Workspace not found");

  const contacts = await listCampaignContacts(workspace, tokens, input.segment);
  const capped = contacts.slice(0, 200);

  const results: ContactStatus[] = [];
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < capped.length; i++) {
    const c = capped[i];
    // Throttle: 1 message per second to stay within API rate limits.
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      await sendOneWhatsApp(workspace, c.phone, input.message, input.imageUrl);
      results.push({ name: c.name, phone: c.phone, status: "sent" });
      sent++;
    } catch (err) {
      results.push({ name: c.name, phone: c.phone, status: "failed", error: String(err) });
      failed++;
    }
  }

  return { total: contacts.length, sent, failed, skipped: contacts.length - capped.length, contacts: results };
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
