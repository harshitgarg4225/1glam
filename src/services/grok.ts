import { appConfig } from "../config.js";

export type GrokLeadIntelligence = {
  profileTier: "Low" | "Mid" | "High";
  clientTags: string;
  aiInsight: string;
  suggestedReply: string;
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
