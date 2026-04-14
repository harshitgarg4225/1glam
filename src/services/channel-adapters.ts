import { normalizedWebhookSchema, type NormalizedWebhookPayload } from "../webhook-schema.js";

type GenericPayload = Record<string, unknown>;

export function normalizeWatiPayload(payload: GenericPayload): NormalizedWebhookPayload {
  const direct = tryNormalizedPayload(payload);
  if (direct) return direct;

  return normalizedWebhookSchema.parse({
    secret: readString(payload, ["secret"]),
    workspaceEmail: readString(payload, ["workspaceEmail", "workspace_email", "ownerEmail"]),
    clientName: readString(payload, ["clientName", "contactName", "name", "senderName"]),
    clientWhatsApp: normalizePhone(readString(payload, ["clientWhatsApp", "waId", "phone", "from"])),
    clientInstagram: readString(payload, ["clientInstagram", "instagramHandle"]),
    eventType: readString(payload, ["eventType", "event_type"]),
    eventDate: readString(payload, ["eventDate", "event_date"]),
    eventTime: readString(payload, ["eventTime", "event_time"]),
    locationText: readString(payload, ["locationText", "venue", "location"]),
    distanceKm: readNumber(payload, ["distanceKm", "distance_km"]),
    travelTimeMin: readNumber(payload, ["travelTimeMin", "travel_time_min"]),
    profileTier: readProfileTier(payload, ["profileTier", "profile_tier"]),
    followers: readNumber(payload, ["followers", "instagramFollowers"]),
    clientTags: readString(payload, ["clientTags", "client_tags"]),
    messageText: readString(payload, ["messageText", "text", "message", "lastMessage"]),
    actorId: readString(payload, ["contactId", "senderId", "waId", "phone"]),
  });
}

export function normalizeManychatPayload(payload: GenericPayload): NormalizedWebhookPayload {
  const direct = tryNormalizedPayload(payload);
  if (direct) return direct;

  const subscriber = readObject(payload, ["subscriber", "contact"]);
  const customFields = readObject(payload, ["custom_fields", "customFields", "fields"]);

  return normalizedWebhookSchema.parse({
    secret: readString(payload, ["secret"]),
    workspaceEmail:
      readString(payload, ["workspaceEmail", "workspace_email", "ownerEmail"]) ||
      readString(customFields, ["workspaceEmail", "workspace_email"]),
    clientName:
      readString(payload, ["clientName", "name"]) ||
      readString(subscriber, ["name", "full_name"]),
    clientWhatsApp:
      normalizePhone(
        readString(payload, ["clientWhatsApp", "phone"]) ||
          readString(subscriber, ["phone"]) ||
          readString(customFields, ["clientWhatsApp", "phone"]),
      ),
    clientInstagram:
      readString(payload, ["clientInstagram", "instagramHandle"]) ||
      readString(subscriber, ["instagram_username", "username"]),
    eventType:
      readString(payload, ["eventType"]) ||
      readString(customFields, ["eventType", "event_type"]),
    eventDate:
      readString(payload, ["eventDate"]) ||
      readString(customFields, ["eventDate", "event_date"]),
    eventTime:
      readString(payload, ["eventTime"]) ||
      readString(customFields, ["eventTime", "event_time"]),
    locationText:
      readString(payload, ["locationText", "venue"]) ||
      readString(customFields, ["locationText", "venue"]),
    distanceKm:
      readNumber(payload, ["distanceKm"]) ??
      readNumber(customFields, ["distanceKm", "distance_km"]),
    travelTimeMin:
      readNumber(payload, ["travelTimeMin"]) ??
      readNumber(customFields, ["travelTimeMin", "travel_time_min"]),
    profileTier:
      readProfileTier(payload, ["profileTier"]) ??
      readProfileTier(customFields, ["profileTier", "profile_tier"]),
    followers:
      readNumber(payload, ["followers"]) ??
      readNumber(subscriber, ["followers"]) ??
      readNumber(customFields, ["followers"]),
    clientTags:
      readString(payload, ["clientTags"]) ||
      readString(customFields, ["clientTags", "client_tags"]),
    messageText:
      readString(payload, ["messageText", "text", "message"]) ||
      readString(payload, ["last_input_text"]) ||
      readString(subscriber, ["last_input_text"]),
    actorId:
      readString(payload, ["instagramUserId", "userId"]) ||
      readString(subscriber, ["id", "user_id", "instagram_id"]),
  });
}

export function buildOutboundReplyPayload(input: {
  channel: "WhatsApp" | "Instagram";
  actorId: string;
  message: string;
}) {
  if (input.channel === "WhatsApp") {
    return {
      channel: "WhatsApp",
      payload: {
        receiver: input.actorId,
        messageText: input.message,
      },
    };
  }

  return {
    channel: "Instagram",
    payload: {
      subscriberId: input.actorId,
      messageText: input.message,
    },
  };
}

function tryNormalizedPayload(payload: GenericPayload) {
  const result = normalizedWebhookSchema.safeParse(payload);
  return result.success ? result.data : null;
}

function readObject(payload: GenericPayload | null | undefined, keys: string[]) {
  if (!payload) return {};
  for (const key of keys) {
    const value = payload[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as GenericPayload;
    }
  }
  return {};
}

function readString(payload: GenericPayload | null | undefined, keys: string[]) {
  if (!payload) return "";
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function readNumber(payload: GenericPayload | null | undefined, keys: string[]) {
  const raw = readString(payload, keys);
  if (!raw) return undefined;
  const number = Number(raw);
  return Number.isFinite(number) ? number : undefined;
}

function readProfileTier(payload: GenericPayload | null | undefined, keys: string[]) {
  const raw = readString(payload, keys).toLowerCase();
  if (raw === "low") return "Low";
  if (raw === "high") return "High";
  if (raw === "mid" || raw === "medium") return "Mid";
  return undefined;
}

function normalizePhone(value: string) {
  const digits = value.replace(/[^\d]/g, "");
  return digits || value;
}
