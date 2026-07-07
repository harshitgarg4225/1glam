import { z } from "zod";

export const createLeadSchema = z.object({
  source: z.string().min(1).default("Instagram"),
  clientName: z.string().trim().min(1),
  clientWhatsApp: z.string().trim().regex(/^\+?[\d\s\-()+]{8,20}$/, "Invalid phone number"),
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
  // .trim() before .min(1) rejects whitespace-only input ("   ") that would
  // otherwise pass length checks and create a junk lead with a blank name.
  clientName: z.string().trim().min(1).max(120),
  clientWhatsApp: z.string().trim().regex(/^\+?[\d\s\-()+]{8,20}$/, "Invalid phone number"),
  clientInstagram: z.string().max(120).optional(),
  clientEmail: z.string().trim().email().max(160).optional().or(z.literal("")),
  eventType: z.string().trim().min(1).max(40),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  // Optional end date for a multi-day event; must be a valid ISO date. The
  // handler ignores it unless it's strictly after eventDate.
  eventEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD").optional(),
  eventTime: z.string().max(20).optional(),
  // Optional block end clock-time ("HH:MM"). The handler keeps it only when it's
  // later than eventTime; otherwise the block falls back to the service length.
  eventEndTime: z.string().regex(/^\d{1,2}:\d{2}$/, "Time must be HH:MM").optional().or(z.literal("")),
  // Venue is often unknown when a bride first requests a date; the artist
  // confirms it on WhatsApp anyway. Accept a blank and default to a clear
  // placeholder rather than blocking the request.
  locationText: z.string().trim().max(200).optional().default("To be decided"),
  addons: z.string().max(500).optional(),
  notes: z.string().max(1000).optional(),
  promoCode: z.string().max(40).optional(),
  preferredArtist: z.string().max(80).optional(),
});

// One-shot walk-in/phone booking: creates the lead and confirms it in a single
// call so the owner never has to walk the pipeline for a client she already
// said yes to.
export const quickBookingSchema = z.object({
  clientName: z.string().trim().min(1).max(120),
  clientWhatsApp: z.string().trim().regex(/^\+?[\d\s\-()+]{8,20}$/, "Invalid phone number"),
  eventType: z.string().trim().min(1).max(40),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  // Optional multi-day end date and client email — blank ("") tolerated because
  // the form submits every named field.
  eventEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD").optional().or(z.literal("")),
  clientEmail: z.string().trim().email().max(160).optional().or(z.literal("")),
  eventTime: z.string().max(20).optional(),
  eventEndTime: z.string().regex(/^\d{1,2}:\d{2}$/, "Time must be HH:MM").optional().or(z.literal("")),
  // Venue and price are optional — artists often block the date first and
  // settle details after a trial or a call.
  locationText: z.string().max(200).optional().default("To be decided"),
  price: z.coerce.number().min(0).max(100000000).optional().default(0),
  advancePaid: z.coerce.boolean().optional().default(false),
  // How much was actually received — recorded as the first ledger entry.
  advanceAmount: z.coerce.number().min(0).max(100000000).optional().default(0),
}).refine((d) => !(d.price > 0) || d.advanceAmount <= d.price, {
  message: "The advance can't be more than the booking price.",
  path: ["advanceAmount"],
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
  decision: z.enum(["YES", "NO", "EDIT", "REOPEN"]),
  approvedPrice: z.coerce.number().optional(),
  ownerNotes: z.string().optional(),
  lostReason: z.string().max(100).optional(),
  // For REOPEN (undo a decline): the status to restore. Whitelisted to the
  // open states so a reopen can't fabricate an arbitrary status; defaults to
  // "New" server-side when absent or not in the list.
  reopenStatus: z.enum(["New", "Awaiting Client", "Confirmed"]).optional(),
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
  // "refund" records money returned to the client (subtracts from the total);
  // "tip" records a gratuity (recordBookingPayment already handles this kind).
  type: z.enum(["payment", "refund", "tip"]).optional().default("payment"),
  // Client-generated idempotency key so a double-tap / retried request records
  // the payment once, not twice (recordBookingPayment dedupes on ref).
  ref: z.string().max(80).optional(),
});
