import { z } from "zod";

export const createLeadSchema = z.object({
  source: z.string().min(1).default("Instagram"),
  clientName: z.string().min(1),
  clientWhatsApp: z.string().regex(/^\+?[\d\s\-()+]{8,20}$/, "Invalid phone number"),
  clientInstagram: z.string().optional(),
  eventType: z.string().min(1),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  eventTime: z.string().optional(),
  locationText: z.string().optional().default("To be decided"),
  distanceKm: z.coerce.number().optional(),
  travelTimeMin: z.coerce.number().optional(),
  profileTier: z.enum(["Low", "Mid", "High"]).optional(),
  followers: z.coerce.number().optional(),
  clientTags: z.string().optional(),
  referredBy: z.string().max(120).optional(),
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
  promoCode: z.string().max(40).optional(),
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
  // Venue and price are optional — artists often block the date first and
  // settle details after a trial or a call.
  locationText: z.string().max(200).optional().default("To be decided"),
  price: z.coerce.number().min(0).max(100000000).optional().default(0),
  advancePaid: z.coerce.boolean().optional().default(false),
  // How much was actually received — recorded as the first ledger entry.
  advanceAmount: z.coerce.number().min(0).max(100000000).optional().default(0),
});

// Day-to-day corrections: venue changed, typo in the number, new time. All
// fields optional — only what's provided is updated.
export const editLeadDetailsSchema = z.object({
  clientName: z.string().min(1).max(120).optional(),
  clientWhatsApp: z.string().regex(/^\+?[\d\s\-()+]{8,20}$/, "Invalid phone number").optional(),
  clientInstagram: z.string().max(120).optional(),
  eventType: z.string().min(1).max(40).optional(),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD").optional(),
  eventTime: z.string().max(20).optional(),
  locationText: z.string().min(1).max(200).optional(),
  clientTags: z.string().max(500).optional(),
});

export const ownerDecisionSchema = z.object({
  decision: z.enum(["YES", "NO", "EDIT"]),
  approvedPrice: z.coerce.number().optional(),
  ownerNotes: z.string().optional(),
});

export const paymentStatusSchema = z.object({
  paymentStatus: z.enum(["Advance Paid", "Paid in Full"]),
});

// A recorded payment instalment. Indian clients usually pay in parts (advance,
// mid, balance), so the ledger accepts any positive amount with how it arrived.
export const recordPaymentSchema = z.object({
  amount: z.coerce.number().positive().max(100000000),
  method: z.enum(["UPI", "Cash", "Bank Transfer", "Card", "Razorpay", "Other"]).optional().default("UPI"),
  note: z.string().max(120).optional().default(""),
  // "refund" records money returned to the client (subtracts from the total).
  type: z.enum(["payment", "refund"]).optional().default("payment"),
});
