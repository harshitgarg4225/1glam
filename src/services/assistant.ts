import { appConfig } from "../config.js";
import { fetchWithTimeout } from "./http.js";
import type { BookingRecord, LeadRecord } from "./booking.js";

// Compact, token-efficient snapshot of the owner's live business data that we
// hand to the AI alongside her question. Caps row counts and trims fields so a
// big workspace can't blow the prompt up.
export type AssistantSnapshot = {
  today: string;
  openLeads: Array<{
    name: string;
    event: string;
    date: string;
    status: string;
    price: number;
    lastContact: string;
    place: string;
  }>;
  bookings: Array<{
    name: string;
    event: string;
    date: string;
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
      name: l.clientName,
      event: l.eventType,
      date: l.eventDate,
      status: l.status,
      price: Number(l.finalApprovedPrice) || Number(l.initialAiPrice) || 0,
      lastContact: (l.lastContactedAt || "").slice(0, 10),
      place: l.locationText,
    })),
    bookings: bookings.slice(0, MAX_ROWS).map((b) => ({
      name: b.clientName,
      event: b.eventType,
      date: b.eventDate,
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
// the snapshot above. Returns null when AI isn't configured or the call fails —
// the route turns that into a friendly "not available" message.
export async function askBusinessAssistant(input: {
  ownerName: string;
  brandName: string;
  city: string;
  question: string;
  snapshot: AssistantSnapshot;
}): Promise<string | null> {
  if (!appConfig.xaiApiKey) {
    return null;
  }

  const systemPrompt =
    "You are the in-app assistant for an Indian beauty-business booking CRM. " +
    "The user is the business owner. Answer her question using ONLY the JSON business data provided. " +
    "Be concise and concrete: name the specific clients, dates, and rupee amounts that answer the question. " +
    "Use ₹ with Indian digit grouping for money. Dates in the data are YYYY-MM-DD; refer to them in a friendly way (e.g. 'Sat 14 Jun'). " +
    "If the data doesn't contain the answer, say so plainly and suggest where in the app to look. " +
    "Never invent clients, bookings, or numbers. Reply in plain text (no markdown tables), at most a short paragraph or a few short lines.";

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
  const answer = String(payload.output_text ?? "").trim();
  return answer || null;
}
