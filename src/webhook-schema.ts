import { z } from "zod";

export const normalizedWebhookSchema = z.object({
  secret: z.string().optional(),
  workspaceEmail: z.string().email(),
  clientName: z.string().min(1),
  clientWhatsApp: z.string().min(8),
  clientInstagram: z.string().optional(),
  eventType: z.string().min(1),
  eventDate: z.string().min(1),
  eventTime: z.string().optional(),
  locationText: z.string().min(1),
  distanceKm: z.coerce.number().optional(),
  travelTimeMin: z.coerce.number().optional(),
  profileTier: z.enum(["Low", "Mid", "High"]).optional(),
  followers: z.coerce.number().optional(),
  clientTags: z.string().optional(),
  messageText: z.string().min(1),
  actorId: z.string().optional(),
});

export type NormalizedWebhookPayload = z.infer<typeof normalizedWebhookSchema>;
