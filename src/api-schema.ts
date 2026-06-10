import { z } from "zod";

export const createLeadSchema = z.object({
  source: z.string().min(1).default("Instagram"),
  clientName: z.string().min(1),
  clientWhatsApp: z.string().regex(/^\+?[\d\s\-()+]{8,20}$/, "Invalid phone number"),
  clientInstagram: z.string().optional(),
  eventType: z.string().min(1),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  eventTime: z.string().optional(),
  locationText: z.string().min(1),
  distanceKm: z.coerce.number().optional(),
  travelTimeMin: z.coerce.number().optional(),
  profileTier: z.enum(["Low", "Mid", "High"]).optional(),
  followers: z.coerce.number().optional(),
  clientTags: z.string().optional(),
});

export const publicBookingSchema = z.object({
  clientName: z.string().min(1).max(120),
  clientWhatsApp: z.string().regex(/^\+?[\d\s\-()+]{8,20}$/, "Invalid phone number"),
  clientInstagram: z.string().max(120).optional(),
  eventType: z.string().min(1).max(40),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  eventTime: z.string().max(20).optional(),
  locationText: z.string().min(1).max(200),
  addons: z.string().max(500).optional(),
  notes: z.string().max(1000).optional(),
});

// One-shot walk-in/phone booking: creates the lead and confirms it in a single
// call so the owner never has to walk the pipeline for a client she already
// said yes to.
export const quickBookingSchema = z.object({
  clientName: z.string().min(1).max(120),
  clientWhatsApp: z.string().regex(/^\+?[\d\s\-()+]{8,20}$/, "Invalid phone number"),
  eventType: z.string().min(1).max(40),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  eventTime: z.string().max(20).optional(),
  locationText: z.string().min(1).max(200),
  price: z.coerce.number().positive().max(100000000),
  advancePaid: z.coerce.boolean().optional().default(false),
});

export const ownerDecisionSchema = z.object({
  decision: z.enum(["YES", "NO", "EDIT"]),
  approvedPrice: z.coerce.number().optional(),
  ownerNotes: z.string().optional(),
});

export const paymentStatusSchema = z.object({
  paymentStatus: z.enum(["Advance Paid", "Paid in Full"]),
});
