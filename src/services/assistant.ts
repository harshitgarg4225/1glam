import { appConfig } from "../config.js";
import { fetchWithTimeout } from "./http.js";
import type { BookingRecord, LeadRecord } from "./booking.js";

// Compact, token-efficient snapshot of the owner's live business data that we
// hand to the AI alongside her question. Caps row counts and trims fields so a
// big workspace can't blow the prompt up.
export type AssistantSnapshot = {
  today: string;
  openLeads: Array<{
    id: string;
    name: string;
    event: string;
    date: string;
    status: string;
    price: number;
    lastContact: string;
    place: string;
  }>;
  bookings: Array<{
    id: string;
    name: string;
    event: string;
    date: string;
    status: string;
    price: number;
    advance: number;
    balance: number;
    payment: string;
    venue: string;
  }>;
  totals: {
    openLeadCount: number;
    bookingCount: number;
    confirmedUpcomingRevenue: number;
    advancesPending: number;
  };
};

// An action the assistant PROPOSES. The model only ever suggests {type, id};
// the server validates both against the snapshot and builds the label, and the
// UI renders them as ordinary action buttons the owner taps — the AI never
// executes anything itself.
export type AssistantAction = {
  type:
    | "record_payment"
    | "send_advance_reminder"
    | "send_balance_reminder"
    | "send_invoice"
    | "send_contract"
    | "ask_review"
    | "mark_completed"
    | "open_booking"
    | "open_lead";
  id: string;
  label: string;
};

const ASSISTANT_ACTION_TYPES = new Set([
  "record_payment", "send_advance_reminder", "send_balance_reminder",
  "send_invoice", "send_contract", "ask_review", "mark_completed",
  "open_booking", "open_lead",
]);

const ACTION_VERB: Record<AssistantAction["type"], string> = {
  record_payment: "💰 Record payment",
  send_advance_reminder: "Send advance reminder",
  send_balance_reminder: "Send balance reminder",
  send_invoice: "📤 Send invoice",
  send_contract: "✍️ Send contract",
  ask_review: "⭐ Ask for a review",
  mark_completed: "🎉 Mark completed",
  open_booking: "Open booking",
  open_lead: "Open request",
};

// Validates model-proposed actions against the snapshot: whitelist the type,
// require the id to exist in the right collection, gate on record state (so a
// paid-up booking can't get a payment reminder), and build labels server-side.
// Anything invalid is silently dropped — a hallucinated id must never become a
// button. Capped so a runaway list can't flood the UI.
export function validateAssistantActions(
  raw: unknown,
  snapshot: AssistantSnapshot,
): AssistantAction[] {
  if (!Array.isArray(raw)) return [];
  const bookingsById = new Map(snapshot.bookings.map((b) => [b.id, b]));
  const leadsById = new Map(snapshot.openLeads.map((l) => [l.id, l]));
  const out: AssistantAction[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= 8) break;
    const type = String((entry as { type?: unknown })?.type ?? "");
    const id = String((entry as { id?: unknown })?.id ?? "");
    if (!ASSISTANT_ACTION_TYPES.has(type) || !id || seen.has(`${type}:${id}`)) continue;
    const t = type as AssistantAction["type"];
    if (t === "open_lead") {
      const lead = leadsById.get(id);
      if (!lead) continue;
      out.push({ type: t, id, label: `${ACTION_VERB[t]} — ${lead.name}` });
    } else {
      const booking = bookingsById.get(id);
      if (!booking) continue;
      const active = !["Cancelled", "Completed"].includes(booking.status);
      const paidFull = booking.payment === "Paid in Full";
      if (t === "record_payment" && (paidFull || booking.status === "Cancelled")) continue;
      if (t === "send_advance_reminder" && !(active && booking.payment === "Advance Due")) continue;
      if (t === "send_balance_reminder" && !(active && booking.payment === "Advance Paid" && booking.balance > 0)) continue;
      if ((t === "send_invoice" || t === "send_contract" || t === "mark_completed") && !active) continue;
      if (t === "ask_review" && booking.status === "Cancelled") continue;
      out.push({ type: t, id, label: `${ACTION_VERB[t]} — ${booking.name}` });
    }
    seen.add(`${type}:${id}`);
  }
  return out;
}

const MAX_ROWS = 40;

export function buildAssistantSnapshot(
  leads: LeadRecord[],
  bookings: BookingRecord[],
  now: Date = new Date(),
): AssistantSnapshot {
  const today = now.toISOString().slice(0, 10);
  const open = leads.filter((l) => !["Lost", "Completed"].includes(l.status));

  const upcomingRevenue = bookings
    .filter((b) => b.eventDate >= today)
    .reduce((sum, b) => sum + (Number(b.finalPrice) || 0), 0);
  const advancesPending = bookings
    .filter((b) => b.paymentStatus === "Advance Due")
    .reduce((sum, b) => sum + (Number(b.advanceAmount) || 0), 0);

  return {
    today,
    openLeads: open.slice(0, MAX_ROWS).map((l) => ({
      id: l.leadId,
      name: l.clientName,
      event: l.eventType,
      date: l.eventDate,
      status: l.status,
      price: Number(l.finalApprovedPrice) || Number(l.initialAiPrice) || 0,
      lastContact: (l.lastContactedAt || "").slice(0, 10),
      place: l.locationText,
    })),
    bookings: bookings.slice(0, MAX_ROWS).map((b) => ({
      id: b.bookingId,
      name: b.clientName,
      event: b.eventType,
      date: b.eventDate,
      status: b.status || "Confirmed",
      price: Number(b.finalPrice) || 0,
      advance: Number(b.advanceAmount) || 0,
      balance: Number(b.balanceDue) || 0,
      payment: b.paymentStatus || b.status,
      venue: b.venue,
    })),
    totals: {
      openLeadCount: open.length,
      bookingCount: bookings.length,
      confirmedUpcomingRevenue: upcomingRevenue,
      advancesPending,
    },
  };
}

// Answers the owner's natural-language question about her own business using
// the snapshot above, and may PROPOSE actions ({type, id} pairs referencing
// snapshot rows) that the UI renders as tappable buttons — the model never
// executes anything, and every proposal is validated server-side. Returns null
// when AI isn't configured or the call fails — the route turns that into a
// friendly "not available" message.
export async function askBusinessAssistant(input: {
  ownerName: string;
  brandName: string;
  city: string;
  question: string;
  snapshot: AssistantSnapshot;
}): Promise<{ answer: string; actions: AssistantAction[] } | null> {
  if (!appConfig.xaiApiKey) {
    return null;
  }

  const systemPrompt =
    "You are the in-app assistant for an Indian beauty-business booking CRM. " +
    "The user is the business owner. Answer her question using ONLY the JSON business data provided. " +
    "Be concise and concrete: name the specific clients, dates, and rupee amounts that answer the question. " +
    "Use ₹ with Indian digit grouping for money. Dates in the data are YYYY-MM-DD; refer to them in a friendly way (e.g. 'Sat 14 Jun'). " +
    "If the data doesn't contain the answer, say so plainly and suggest where in the app to look. " +
    "Never invent clients, bookings, or numbers. The answer is plain text (no markdown tables), at most a short paragraph or a few short lines. " +
    'Return STRICT JSON only: {"answer": string, "actions": [{"type": string, "id": string}]}. ' +
    "actions lets you propose next steps the owner can tap to run — use it when she asks you to DO something " +
    "(remind, send, chase, collect) or when one obvious follow-up exists; otherwise return an empty array. " +
    "Allowed types: record_payment, send_advance_reminder, send_balance_reminder, send_invoice, send_contract, " +
    "ask_review, mark_completed, open_booking (all with a booking id) and open_lead (with a lead id). " +
    "Use ids EXACTLY as they appear in the data. At most 5 actions. Never propose an action for a record not in the data.";

  const response = await fetchWithTimeout("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${appConfig.xaiApiKey}`,
    },
    body: JSON.stringify({
      model: appConfig.xaiModel,
      input: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            owner: input.ownerName,
            business: input.brandName,
            city: input.city,
            question: input.question,
            data: input.snapshot,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { output_text?: string };
  const text = String(payload.output_text ?? "").trim();
  if (!text) return null;

  // Strict-JSON reply expected; if the model returned plain prose (or wrapped
  // the JSON in a code fence), degrade gracefully to answer-only.
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned) as { answer?: unknown; actions?: unknown };
    const answer = String(parsed.answer ?? "").trim();
    if (!answer) return { answer: text, actions: [] };
    return { answer, actions: validateAssistantActions(parsed.actions, input.snapshot) };
  } catch {
    return { answer: text, actions: [] };
  }
}
