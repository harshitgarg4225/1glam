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
    "openQuestions must be an array of concise strings for missing information.";

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
  latestMessage: string;
  memorySummary?: string;
}): GrokConversationReply {
  const missing = [];
  if (!input.eventTime) missing.push("event time");
  if (!input.locationText || input.locationText === "Unknown") missing.push("venue");
  const replyBase =
    input.suggestedReply?.trim() ||
    `Hi ${input.clientName || "love"}, thank you for reaching out to ${input.brandName}.`;
  const questionLine = missing.length
    ? ` Could you please share your ${missing.join(" and ")} so we can guide you properly?`
    : " We’d love to help you with the next steps.";

  return {
    reply: `${replyBase}${questionLine}`.trim(),
    ownerSummary: `Latest ${input.channel} message reviewed. Lead is in ${input.leadStatus}.`,
    memorySummary:
      input.memorySummary ||
      `Client asked about ${input.eventType} on ${input.eventDate} in ${input.locationText}.`,
    openQuestions: missing,
  };
}
