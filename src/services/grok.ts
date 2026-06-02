import { appConfig } from "../config.js";

export type GrokLeadIntelligence = {
  profileTier: "Low" | "Mid" | "High";
  clientTags: string;
  aiInsight: string;
  suggestedReply: string;
};

export type GrokConversationReply = {
  reply: string;
  ownerSummary: string;
  memorySummary: string;
  openQuestions: string[];
};

export async function enrichLeadWithGrok(input: {
  ownerName: string;
  brandName: string;
  city: string;
  source: string;
  clientName: string;
  clientInstagram?: string;
  eventType: string;
  eventDate: string;
  eventTime?: string;
  locationText: string;
  followers?: number;
  inboundMessage?: string;
}): Promise<GrokLeadIntelligence | null> {
  if (!appConfig.xaiApiKey) {
    return null;
  }

  const systemPrompt =
    "You are an operations intelligence assistant for a luxury Indian makeup artist booking business. " +
    "Return strict JSON only with keys: profileTier, clientTags, aiInsight, suggestedReply. " +
    "profileTier must be one of Low, Mid, High. clientTags must be a comma-separated short tag list. " +
    "aiInsight must be a concise internal summary for the owner. suggestedReply must be a polished luxury client reply.";

  const userPrompt = JSON.stringify(input, null, 2);

  const response = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${appConfig.xaiApiKey}`,
    },
    body: JSON.stringify({
      model: appConfig.xaiModel,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { output_text?: string };
  if (!payload.output_text) {
    return null;
  }

  const parsed = safeParseJson(payload.output_text);
  if (!parsed) {
    return null;
  }

  const profileTier = normalizeProfileTier(parsed.profileTier);
  return {
    profileTier,
    clientTags: String(parsed.clientTags ?? "").trim(),
    aiInsight: String(parsed.aiInsight ?? "").trim(),
    suggestedReply: String(parsed.suggestedReply ?? "").trim(),
  };
}

export async function generateConversationReply(input: {
  ownerName: string;
  brandName: string;
  city: string;
  channel: "Instagram" | "WhatsApp";
  clientName: string;
  leadStatus: string;
  eventType: string;
  eventDate: string;
  eventTime?: string;
  locationText: string;
  suggestedReply?: string;
  currentPrice?: number;
  ownerDecision?: string;
  paymentStatus?: string;
  quoteUrl?: string;
  invoiceUrl?: string;
  contractUrl?: string;
  holdExpiresAt?: string;
  latestMessage: string;
  memorySummary?: string;
}): Promise<GrokConversationReply> {
  if (!appConfig.xaiApiKey) {
    return fallbackConversationReply(input);
  }

  const systemPrompt =
    "You are a luxury makeup artist booking conversation agent for an Indian beauty business. " +
    "Return strict JSON only with keys: reply, ownerSummary, memorySummary, openQuestions. " +
    "reply should be warm, polished, concise, and client-facing. " +
    "ownerSummary should be brief internal context. " +
    "memorySummary should be a compact rolling summary for future turns. " +
    "openQuestions must be an array of concise strings for missing information. " +
    "If ownerDecision is empty, do not promise a final quote, payment request, or booking confirmation. " +
    "If a quoteUrl exists after owner approval, you may guide the client to review it. " +
    "If an invoiceUrl exists for a confirmed booking, you may guide the client to payment. " +
    "If a contractUrl exists, you may guide the client to sign it.";

  const response = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${appConfig.xaiApiKey}`,
    },
    body: JSON.stringify({
      model: appConfig.xaiModel,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(input, null, 2) },
      ],
    }),
  });

  if (!response.ok) {
    return fallbackConversationReply(input);
  }

  const payload = (await response.json()) as { output_text?: string };
  const parsed = payload.output_text ? safeParseJson(payload.output_text) : null;
  if (!parsed) {
    return fallbackConversationReply(input);
  }

  return {
    reply: String(parsed.reply ?? "").trim() || fallbackConversationReply(input).reply,
    ownerSummary: String(parsed.ownerSummary ?? "").trim(),
    memorySummary: String(parsed.memorySummary ?? "").trim(),
    openQuestions: Array.isArray(parsed.openQuestions)
      ? parsed.openQuestions.map((value) => String(value).trim()).filter(Boolean)
      : [],
  };
}

export type GrokReviewReplies = {
  sentiment: "positive" | "neutral" | "negative";
  replies: string[];
};

// Drafts on-brand replies to a Google review in the artist's voice. Returns two
// ready-to-post options plus a sentiment read. Falls back to sensible non-AI
// templates when Grok is unavailable so the feature always works.
export async function generateReviewReplies(input: {
  brandName: string;
  ownerName: string;
  city: string;
  signOff?: string;
  tone: string;
  reviewerName?: string;
  rating?: number;
  reviewText: string;
}): Promise<GrokReviewReplies> {
  if (!appConfig.xaiApiKey) {
    return fallbackReviewReplies(input);
  }

  const systemPrompt =
    "You write Google review replies for a luxury Indian makeup artist business. " +
    "Return strict JSON only with keys: sentiment, replies. " +
    "sentiment must be one of positive, neutral, negative. " +
    "replies must be an array of exactly two distinct reply options. " +
    "Each reply: warm, gracious, personal, on-brand, 2-4 sentences, no hashtags, no emojis unless natural. " +
    "Address the reviewer by name when provided. Thank them specifically for what they mention. " +
    "For negative reviews, be empathetic, take responsibility gracefully, and invite them to connect privately — never defensive. " +
    "Match the requested tone. End in the brand's voice; use the sign-off only if it fits naturally.";

  try {
    const response = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${appConfig.xaiApiKey}`,
      },
      body: JSON.stringify({
        model: appConfig.xaiModel,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(input, null, 2) },
        ],
      }),
    });

    if (!response.ok) return fallbackReviewReplies(input);
    const payload = (await response.json()) as { output_text?: string };
    const parsed = payload.output_text ? safeParseJson(payload.output_text) : null;
    if (!parsed) return fallbackReviewReplies(input);

    const replies = Array.isArray(parsed.replies)
      ? parsed.replies.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (!replies.length) return fallbackReviewReplies(input);

    return {
      sentiment: normalizeSentiment(parsed.sentiment),
      replies: replies.slice(0, 3),
    };
  } catch {
    return fallbackReviewReplies(input);
  }
}

function normalizeSentiment(value: unknown): "positive" | "neutral" | "negative" {
  const v = String(value ?? "").toLowerCase();
  if (v === "negative") return "negative";
  if (v === "neutral") return "neutral";
  return "positive";
}

function fallbackReviewReplies(input: {
  brandName: string;
  ownerName: string;
  signOff?: string;
  rating?: number;
  reviewerName?: string;
}): GrokReviewReplies {
  const who = input.reviewerName ? input.reviewerName.split(/\s+/)[0] : "";
  const hi = who ? `Thank you so much, ${who}!` : "Thank you so much!";
  const signOff = input.signOff ? ` — ${input.signOff}` : ` — Team ${input.brandName}`;
  const negative = (input.rating ?? 5) <= 3;

  if (negative) {
    return {
      sentiment: "negative",
      replies: [
        `${who ? `Hi ${who}, ` : ""}thank you for sharing this honest feedback. I’m truly sorry your experience didn’t meet the standard we hold ourselves to. I’d love to understand what happened and make it right — please reach out to us directly so we can connect personally.${signOff}`,
        `${who ? `${who}, ` : ""}I really appreciate you taking the time to tell us this, and I’m sorry we let you down. Your experience matters to us deeply. Could we connect privately so I can listen and put things right?${signOff}`,
      ],
    };
  }

  return {
    sentiment: "positive",
    replies: [
      `${hi} It was an absolute joy creating your look, and it means the world that you took the time to share this. We can’t wait to glam you up again.${signOff}`,
      `${hi} Reviews like yours make our day. Thank you for trusting ${input.brandName} for your special moment — see you again soon!${signOff}`,
    ],
  };
}

function safeParseJson(input: string) {
  const trimmed = input.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return tryParse(fenced[1].trim());
  }

  return null;
}

function tryParse(input: string) {
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeProfileTier(value: unknown): "Low" | "Mid" | "High" {
  const normalized = String(value ?? "Mid").toLowerCase();
  if (normalized === "low") return "Low";
  if (normalized === "high") return "High";
  return "Mid";
}

function fallbackConversationReply(input: {
  ownerName: string;
  brandName: string;
  city: string;
  channel: "Instagram" | "WhatsApp";
  clientName: string;
  leadStatus: string;
  eventType: string;
  eventDate: string;
  eventTime?: string;
  locationText: string;
  suggestedReply?: string;
  currentPrice?: number;
  ownerDecision?: string;
  paymentStatus?: string;
  quoteUrl?: string;
  invoiceUrl?: string;
  contractUrl?: string;
  holdExpiresAt?: string;
  latestMessage: string;
  memorySummary?: string;
}): GrokConversationReply {
  const missing = [];
  if (!input.eventTime) missing.push("event time");
  if (!input.locationText || input.locationText === "Unknown") missing.push("venue");

  const greeting =
    input.suggestedReply?.trim() ||
    `Hi ${input.clientName || "love"}, thank you for reaching out to ${input.brandName}.`;
  const approved =
    input.ownerDecision === "YES" || input.ownerDecision === "EDIT";
  const holdLine = input.holdExpiresAt
    ? ` We can tentatively hold the date until ${formatHoldExpiry(input.holdExpiresAt)}.`
    : "";

  let reply = greeting;
  if (missing.length) {
    reply = `${greeting} Could you please share your ${missing.join(
      " and ",
    )} so we can guide you properly?`.trim();
  } else if (!approved && input.leadStatus !== "Confirmed") {
    reply = `${greeting} I’ve noted the details and I’m checking availability for you now. I’ll share the next step shortly once everything is aligned.`.trim();
  } else if (input.quoteUrl && input.leadStatus === "Awaiting Client") {
    reply = `${greeting} Your quote is ready here: ${input.quoteUrl}.${holdLine} Once you’re happy, we can move ahead with confirmation.`.trim();
  } else if (input.contractUrl && input.leadStatus === "Confirmed") {
    reply = `${greeting} Your booking agreement is ready here: ${input.contractUrl}. Please review and sign it when convenient, and I’ll take care of the rest.`.trim();
  } else if (input.invoiceUrl && input.leadStatus === "Confirmed") {
    const paymentLabel =
      input.paymentStatus === "Advance Due" ? "advance invoice" : "invoice";
    reply = `${greeting} Your ${paymentLabel} is ready here: ${input.invoiceUrl}. Once payment is done, just send me a quick confirmation and I’ll update everything on my end.`.trim();
  } else {
    reply = `${greeting} We’d love to help you with the next steps.`.trim();
  }

  return {
    reply,
    ownerSummary: `Latest ${input.channel} message reviewed. Lead is in ${input.leadStatus}. Owner decision: ${input.ownerDecision || "Pending"}.`,
    memorySummary:
      input.memorySummary ||
      `Client asked about ${input.eventType} on ${input.eventDate} in ${input.locationText}. Owner decision: ${input.ownerDecision || "Pending"}.`,
    openQuestions: missing,
  };
}

function formatHoldExpiry(value: string) {
  try {
    return new Date(value).toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return value;
  }
}
