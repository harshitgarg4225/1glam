import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from "pdf-lib";
import { fetchWithTimeout, isPublicHttpUrl } from "./http.js";
import QRCode from "qrcode";
import type { Credentials } from "google-auth-library";
import { buildPublicDocumentUrl, buildInvoicePageUrl, buildQuoteViewUrl } from "./document-links.js";
import { getDocumentTheme, type DocumentTheme } from "./document-themes.js";
import type { WorkspaceRecord } from "../types.js";
import { computeAdvanceAmount, depositPercentForEvent, parsePaymentsLog, paymentsTotal, type BookingRecord, type LeadRecord } from "./booking.js";

// Sequential, human-friendly document numbers (Q-2026-0007, INV-2026-0012).
// Scans the numbers already issued this year and returns the next in sequence —
// what an accountant or GST audit expects, instead of random record ids.
export function nextDocumentNumber(prefix: string, existing: (string | undefined | null)[], now = new Date(), timeZone = "Asia/Kolkata"): string {
  // Bucket by the business's calendar year, not the server's local year —
  // otherwise a document issued at 23:30 local on Dec 31 (still that year) is
  // filed under the next year on a UTC host, corrupting the sequential GST number.
  const year = Number(now.toLocaleString("en-US", { timeZone, year: "numeric" }));
  const pattern = new RegExp(`^${prefix}-${year}-(\\d{1,6})$`);
  let max = 0;
  for (const value of existing) {
    const match = pattern.exec(String(value || "").trim());
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${year}-${String(max + 1).padStart(4, "0")}`;
}

type UploadedDriveFile = {
  fileId: string;
  fileName: string;
  fileUrl: string;
};

// Stamps a large diagonal "VOID" across the page so a voided document is
// unmistakable if it was already shared or downloaded before being voided.
function drawVoidWatermark(page: PDFPage, font: PDFFont) {
  page.drawText("VOID", {
    x: 110,
    y: 360,
    size: 150,
    font,
    color: rgb(0.85, 0.16, 0.16),
    rotate: degrees(30),
    opacity: 0.16,
  });
}

type InvoiceStage = {
  label: string;
  amount: number;
};

// Owner-supplied edits to a document, persisted as JSON on the lead/booking row.
// Lets an owner override the headline amount, add custom line items, and attach
// a note — without changing the underlying lead/booking pricing.
export type DocumentAdjustments = {
  amountOverride?: number;
  lineItems?: { label: string; amount: number }[];
  note?: string;
  // Percentage discount applied to the (possibly overridden) amount + line
  // items, rendered as an explicit "Discount (10%) -Rs X" line so the client
  // sees the original value and what they're saving.
  discountPercent?: number;
  // Range estimate mode ("Rs 12,000 – 15,000, finalized after consultation").
  // When both are set the quote shows the range instead of one fixed amount;
  // the advance is computed on the low end so confirming stays easy.
  priceRangeLow?: number;
  priceRangeHigh?: number;
};

export type DocumentRenderOptions = {
  voided?: boolean;
  adjustments?: DocumentAdjustments;
  // When the client has accepted via the built-in signing page, the contract
  // PDF carries a digital-acceptance block instead of a blank signature line.
  signedBy?: string;
  signedAt?: string;
};

// Tolerant parser: bad/empty JSON yields no adjustments rather than throwing.
export function parseDocumentAdjustments(raw: string | undefined | null): DocumentAdjustments {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as DocumentAdjustments;
    const lineItems = Array.isArray(parsed.lineItems)
      ? parsed.lineItems
          .map((item) => ({ label: String(item?.label ?? "").slice(0, 80), amount: Number(item?.amount) || 0 }))
          .filter((item) => item.label && item.amount)
      : undefined;
    const amountOverride =
      Number.isFinite(Number(parsed.amountOverride)) && Number(parsed.amountOverride) > 0
        ? Number(parsed.amountOverride)
        : undefined;
    const note = typeof parsed.note === "string" ? parsed.note.slice(0, 600) : undefined;
    const rawDiscount = Number(parsed.discountPercent);
    const discountPercent =
      Number.isFinite(rawDiscount) && rawDiscount > 0 && rawDiscount < 100
        ? Math.round(rawDiscount * 100) / 100
        : undefined;
    const low = Number(parsed.priceRangeLow);
    const high = Number(parsed.priceRangeHigh);
    const hasRange = Number.isFinite(low) && Number.isFinite(high) && low > 0 && high > low;
    return {
      amountOverride,
      lineItems,
      note,
      discountPercent,
      priceRangeLow: hasRange ? low : undefined,
      priceRangeHigh: hasRange ? high : undefined,
    };
  } catch {
    return {};
  }
}

// A reusable quote bundle from the quotePackages config — one per line:
//   "Bridal Classic: HD Makeup=12000, Hair=3000, Draping=800"
export type QuotePackage = {
  name: string;
  items: { label: string; amount: number }[];
  total: number;
};

export function parseQuotePackages(raw: string | undefined | null): QuotePackage[] {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon < 1) return null;
      const name = line.slice(0, colon).trim().slice(0, 60);
      if (!name) return null;
      const items = line
        .slice(colon + 1)
        .split(",")
        .map((entry) => {
          const [label, amount] = entry.split("=").map((s) => s.trim());
          const value = Number(amount);
          if (!label || !Number.isFinite(value) || value <= 0) return null;
          return { label: label.slice(0, 80), amount: Math.round(value) };
        })
        .filter((item): item is { label: string; amount: number } => item !== null);
      if (!items.length) return null;
      return { name, items, total: items.reduce((sum, item) => sum + item.amount, 0) };
    })
    .filter((pkg): pkg is QuotePackage => pkg !== null)
    .slice(0, 20);
}

// A single line of the itemized order, edited in the lead drawer.
export type OrderItem = { label: string; quantity: number; unitPrice: number };

// Parses the persisted order-items JSON into clean rows plus the rolled-up
// total and the pre-formatted pricing lines used on every document.
export function parseOrderItems(raw: string | undefined | null): {
  items: (OrderItem & { amount: number })[];
  total: number;
  lines: [string, string][];
} {
  if (!raw) return { items: [], total: 0, lines: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { items: [], total: 0, lines: [] };
  }
  const source = Array.isArray(parsed) ? parsed : [];
  const items = source
    .map((item) => {
      const it = (item ?? {}) as { label?: unknown; quantity?: unknown; unitPrice?: unknown };
      const label = String(it.label ?? "").slice(0, 80);
      const quantity = Number(it.quantity) || 0;
      const unitPrice = Number(it.unitPrice) || 0;
      return { label, quantity, unitPrice, amount: quantity * unitPrice };
    })
    .filter((it) => it.label && it.quantity > 0);
  const total = items.reduce((sum, it) => sum + it.amount, 0);
  const lines: [string, string][] = items.map((it) => [
    `${it.label}  (${it.quantity} × ${inr(it.unitPrice)})`,
    inr(it.amount),
  ]);
  return { items, total, lines };
}

// Given an auto-derived base amount and the owner's adjustments, returns the
// effective total and the extra pricing lines to render. amountOverride replaces
// the base; line items are added on top.
function applyAdjustments(base: number, adj: DocumentAdjustments | undefined) {
  const effectiveBase = adj?.amountOverride && adj.amountOverride > 0 ? adj.amountOverride : base;
  const items = adj?.lineItems ?? [];
  const itemsTotal = items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const extraLines: [string, string][] = items.map((item) => [item.label, inr(item.amount)]);
  let total = effectiveBase + itemsTotal;
  if (adj?.discountPercent) {
    const discount = Math.round((total * adj.discountPercent) / 100);
    extraLines.push([`Discount (${adj.discountPercent}%)`, `- ${inr(discount)}`]);
    total -= discount;
  }
  return { total, extraLines, note: adj?.note?.trim() || "" };
}

// The travel/conveyance line for a document. Travel is a real, separate cost the
// client is paying for, so it's always itemised explicitly rather than folded
// silently into the headline. Returns [] when there's no travel fee. The km is
// shown when known (leads carry distanceKm; bookings don't) so the client can see
// the basis for the charge.
export function travelLineItem(travelCost: number, distanceKm?: number): [string, string][] {
  const cost = Math.max(0, Math.round(Number(travelCost) || 0));
  if (cost <= 0) return [];
  const km = Number(distanceKm) > 0 ? ` (~${Math.round(Number(distanceKm))} km)` : "";
  return [[`Travel & Conveyance${km}`, inr(cost)]];
}

// The "Date" line for a document — a single date, or a range for a multi-day
// event (e.g. "2026-12-24 – 2026-12-26").
function eventDateLine(start: string, end: string): string {
  if (!start) return "";
  return end && end > start ? `Date: ${start} – ${end}` : `Date: ${start}`;
}

// Builds the quote PDF bytes in memory (no Drive upload). Used for both the
// in-app preview and the Drive-backed shareable document.
export async function buildQuotePdfBytes(
  workspace: WorkspaceRecord,
  lead: LeadRecord,
  options: DocumentRenderOptions = {},
): Promise<Uint8Array> {
  const quoteNumber = lead.quoteNumber || `Q-${lead.leadId}`;
  const order = parseOrderItems(lead.orderItems);
  const travelCost = Math.max(0, Math.round(Number(lead.travelCost) || 0));
  // The folded price (finalApprovedPrice) already includes travel; the itemised
  // order total does NOT (the order editor covers the service only), so we add
  // travel back on top in order mode. Either way travel ends up inside the
  // quoted amount AND shown as its own line below — no double counting, nothing
  // dropped.
  const autoQuoted = order.total > 0 ? order.total + travelCost : lead.finalApprovedPrice || lead.initialAiPrice;
  const { total: quotedAmount, extraLines, note } = applyAdjustments(autoQuoted, options.adjustments);
  // Range mode: the quote presents an estimate band instead of one number, and
  // the advance is computed on the low end so the client can still confirm.
  const range =
    options.adjustments?.priceRangeLow && options.adjustments.priceRangeHigh
      ? { low: options.adjustments.priceRangeLow, high: options.adjustments.priceRangeHigh }
      : null;
  // Resolve the advance the SAME way the booking does — per-service deposit % if
  // configured, else the flat advance % — so the quote's "advance to confirm"
  // matches what's actually charged on the invoice/booking. (Previously the quote
  // used a flat % over the quoted amount and could disagree with the booking.)
  const advancePct = depositPercentForEvent(
    workspace.config.depositPercentByService,
    Number(workspace.config.advancePercentage) || 30,
    lead.eventType,
  );
  const advanceAmount = computeAdvanceAmount(range ? range.low : quotedAmount, advancePct);

  // Lead-level discount the owner approved (folded mode only): surface the
  // standard price and the saving so the client sees the value of the deal. The
  // discount amount is travel-independent (travel is equal in both initial and
  // final), so the breakdown still reconciles to the quoted amount. Skipped when
  // a document-level override/discount drives its own lines, or when itemised
  // order lines already define the breakdown.
  const leadDiscountLines: [string, string][] = [];
  if (
    !range &&
    order.total === 0 &&
    !options.adjustments?.amountOverride &&
    !options.adjustments?.discountPercent &&
    lead.discountPercent > 0 &&
    lead.initialAiPrice > lead.finalApprovedPrice &&
    lead.finalApprovedPrice > 0
  ) {
    const discountAmount = Math.round(lead.initialAiPrice - lead.finalApprovedPrice);
    const standardService = Math.round(lead.initialAiPrice) - travelCost;
    if (discountAmount > 0 && standardService > 0) {
      leadDiscountLines.push(["Standard Price", inr(standardService)]);
      leadDiscountLines.push([`Discount (${lead.discountPercent}%)`, `- ${inr(discountAmount)}`]);
    }
  }

  const theme = getDocumentTheme(workspace.config.documentTemplate, workspace.config.brandColor);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const logo = await embedLogo(pdf, workspace.config.logoUrl);
  drawDocumentFrame(page, workspace, theme);
  drawHeader(page, {
    title: "Luxury Quote",
    subtitle: workspace.config.businessName || workspace.config.ownerName,
    docNumber: quoteNumber,
    docDate: new Date().toLocaleDateString("en-IN", { timeZone: workspace.config.timezone || "Asia/Kolkata" }),
    gstNumber: workspace.config.gstNumber,
  }, bold, regular, theme, logo);

  let y = 650;
  y = drawSection(page, "Prepared For", [
    lead.clientName || "Valued Client",
    lead.clientWhatsApp ? `WhatsApp: ${lead.clientWhatsApp}` : "",
    lead.clientInstagram ? `Instagram: ${lead.clientInstagram}` : "",
  ].filter(Boolean), y, bold, regular, theme);

  // A blank field is omitted rather than printed as "To be confirmed" — an
  // estimate with a missing line reads as professional; a placeholder does not.
  y = drawSection(page, "Event Details", [
    `Event: ${lead.eventType}`,
    eventDateLine(lead.eventDate, lead.eventEndDate),
    lead.eventTime ? `Time: ${lead.eventTime}` : "",
    lead.locationText ? `Location: ${lead.locationText}` : "",
  ].filter(Boolean), y - 12, bold, regular, theme);

  y = drawPricingBlock(page, {
    heading: "Quote Summary",
    lines: [
      ...order.lines,
      ...leadDiscountLines,
      ...(range ? [] : travelLineItem(travelCost, lead.distanceKm)),
      ...(range ? [] : gstLines(quotedAmount, workspace.config.gstPercentage)),
      ...extraLines,
      range
        ? (["Estimated Range", `${inr(range.low)} - ${inr(range.high)}`] as [string, string])
        : (["Quoted Amount", inr(quotedAmount)] as [string, string]),
      ...(range ? [["Final Amount", "Confirmed after consultation"] as [string, string]] : []),
      [`Advance To Confirm (${workspace.config.advancePercentage || 0}%)`, inr(advanceAmount)],
      ["Hold Expires", lead.holdExpiresAt ? formatDateTime(lead.holdExpiresAt) : "On request"],
    ],
    y: y - 16,
  }, bold, regular, theme);

  const quoteParts = [
    note,
    workspace.config.quoteIntro,
    workspace.config.paymentTerms,
    workspace.config.cancellationPolicy,
  ].filter(Boolean).join("\n\n");

  drawParagraph(
    page,
    quoteParts || "Payment terms as agreed.",
    { x: 56, y: y - 30, size: 11, font: regular, color: theme.paragraph, maxWidth: 480 },
  );

  if (options.voided) drawVoidWatermark(page, bold);
  drawFooter(page, workspace, regular, theme);
  return pdf.save();
}

// Produces the client-facing quote link. The PDF is served by the app itself
// (see the /d/:type/... route) and regenerated on demand, so this never touches
// Google Drive and can't fail on a Drive permission/scope misconfiguration.
export async function generateQuoteDocument(
  workspace: WorkspaceRecord,
  _tokens: Credentials,
  lead: LeadRecord,
): Promise<UploadedDriveFile> {
  const quoteNumber = lead.quoteNumber || `Q-${lead.leadId}`;
  return {
    fileId: "",
    fileName: `${safeName(workspace.config.businessName || workspace.name)}-${quoteNumber}.pdf`,
    // Clients land on the branded quote page (PDF embedded + Accept button),
    // which gives WhatsApp a rich link preview instead of a bare PDF URL.
    fileUrl: buildQuoteViewUrl(workspace.workspaceId, lead.leadId),
  };
}

// Builds the invoice PDF bytes in memory (no Drive upload). Used for both the
// in-app preview and the Drive-backed shareable document.
export async function buildInvoicePdfBytes(
  workspace: WorkspaceRecord,
  booking: BookingRecord,
  options: DocumentRenderOptions = {},
): Promise<Uint8Array> {
  const invoiceNumber = booking.invoiceNumber || `INV-${booking.bookingId}`;
  const order = parseOrderItems(booking.orderItems);
  const baseStage = resolveInvoiceStage(booking);
  const adjusted = applyAdjustments(baseStage.amount, options.adjustments);
  const stage: InvoiceStage = { label: baseStage.label, amount: adjusted.total };
  const { extraLines, note } = adjusted;
  const theme = getDocumentTheme(workspace.config.documentTemplate, workspace.config.brandColor);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const logo = await embedLogo(pdf, workspace.config.logoUrl);
  drawDocumentFrame(page, workspace, theme);
  drawHeader(page, {
    title: "Booking Invoice",
    subtitle: workspace.config.businessName || workspace.config.ownerName,
    docNumber: invoiceNumber,
    docDate: new Date().toLocaleDateString("en-IN", { timeZone: workspace.config.timezone || "Asia/Kolkata" }),
    gstNumber: workspace.config.gstNumber,
  }, bold, regular, theme, logo);

  let y = 650;
  y = drawSection(page, "Billed To", [
    booking.clientName || "Valued Client",
    booking.clientWhatsApp ? `WhatsApp: ${booking.clientWhatsApp}` : "",
  ].filter(Boolean), y, bold, regular, theme);

  y = drawSection(page, "Booking Details", [
    `Event: ${booking.eventType}`,
    eventDateLine(booking.eventDate, booking.eventEndDate),
    booking.eventTime ? `Time: ${booking.eventTime}` : "",
    booking.venue ? `Venue: ${booking.venue}` : "",
    booking.assignedArtist ? `Assigned Artist: ${booking.assignedArtist}` : "",
  ].filter(Boolean), y - 12, bold, regular, theme);

  // Payment history: each recorded instalment appears on the invoice so the
  // client sees exactly what's been received and what remains — no confusion
  // about whether the advance was counted.
  const payments = parsePaymentsLog(booking.paymentsLog);
  const received = paymentsTotal(payments);
  const paymentLines: [string, string][] = payments.map((p) => [
    `Received${p.method ? ` via ${p.method}` : ""} on ${formatDateOnly(p.at)}`,
    inr(p.amount),
  ]);
  if (received > 0) {
    paymentLines.push(["Total Received", inr(received)]);
  }

  y = drawPricingBlock(page, {
    heading: `${stage.label} Invoice`,
    lines: [
      ...order.lines,
      ...travelLineItem(booking.travelCost),
      ...gstLines(stage.amount, workspace.config.gstPercentage),
      ...extraLines,
      ["Invoice Amount", inr(stage.amount)],
      ["Total Booking Value", inr(booking.finalPrice)],
      ...paymentLines,
      ["Balance Due", inr(booking.balanceDue)],
    ],
    y: y - 16,
  }, bold, regular, theme);

  if (workspace.config.upiId) {
    const qrBytes = await buildUpiQrPng(
      workspace,
      stage.amount,
      invoiceNumber,
    );
    if (qrBytes) {
      const image = await pdf.embedPng(qrBytes);
      const dimensions = image.scale(0.45);
      page.drawImage(image, {
        x: 56,
        y: y - 200,
        width: dimensions.width,
        height: dimensions.height,
      });
      drawParagraph(
        page,
        `Pay via UPI: ${workspace.config.upiId}`,
        { x: 220, y: y - 70, size: 12, font: bold, color: theme.blockValue, maxWidth: 260 },
      );
      drawParagraph(
        page,
        [note, workspace.config.paymentTerms].filter(Boolean).join("\n\n"),
        { x: 220, y: y - 100, size: 11, font: regular, color: theme.paragraph, maxWidth: 300 },
      );
    }
  } else {
    drawParagraph(
      page,
      [note, workspace.config.paymentTerms].filter(Boolean).join("\n\n"),
      { x: 56, y: y - 40, size: 11, font: regular, color: theme.paragraph, maxWidth: 480 },
    );
  }

  if (options.voided) drawVoidWatermark(page, bold);
  drawFooter(page, workspace, regular, theme);
  return pdf.save();
}

// Produces the client-facing invoice link. Points to the branded invoice page
// (/i/:wid/:bid) which embeds the PDF and shows a Pay Now button, giving
// clients a much better experience than a bare PDF URL.
export async function generateInvoiceDocument(
  workspace: WorkspaceRecord,
  _tokens: Credentials,
  booking: BookingRecord,
): Promise<UploadedDriveFile> {
  const invoiceNumber = booking.invoiceNumber || `INV-${booking.bookingId}`;
  return {
    fileId: "",
    fileName: `${safeName(workspace.config.businessName || workspace.name)}-${invoiceNumber}.pdf`,
    fileUrl: buildInvoicePageUrl(workspace.workspaceId, booking.bookingId),
  };
}

export async function generateContractPdfBytes(
  workspace: WorkspaceRecord,
  lead: LeadRecord,
  booking: BookingRecord,
  options: DocumentRenderOptions = {},
) {
  const contractNumber = `CTR-${booking.bookingId}`;
  const order = parseOrderItems(booking.orderItems);
  const travelCost = Math.max(0, Math.round(Number(booking.travelCost) || 0));
  // Order lines cover the service only — add travel so the booking value matches
  // finalPrice (which includes it) instead of silently dropping travel.
  const adjusted = applyAdjustments(order.total > 0 ? order.total + travelCost : booking.finalPrice, options.adjustments);
  const theme = getDocumentTheme(workspace.config.documentTemplate, workspace.config.brandColor);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const logo = await embedLogo(pdf, workspace.config.logoUrl);
  drawDocumentFrame(page, workspace, theme);
  drawHeader(page, {
    title: "Booking Agreement",
    subtitle: workspace.config.businessName || workspace.config.ownerName,
    docNumber: contractNumber,
    docDate: new Date().toLocaleDateString("en-IN", { timeZone: workspace.config.timezone || "Asia/Kolkata" }),
    gstNumber: workspace.config.gstNumber,
  }, bold, regular, theme, logo);

  let y = 650;
  y = drawSection(page, "Client", [
    lead.clientName || "Valued Client",
    lead.clientWhatsApp ? `WhatsApp: ${lead.clientWhatsApp}` : "",
    lead.clientInstagram ? `Instagram: ${lead.clientInstagram}` : "",
  ].filter(Boolean), y, bold, regular, theme);

  y = drawSection(page, "Booking Details", [
    `Booking ID: ${booking.bookingId}`,
    `Event: ${booking.eventType}`,
    eventDateLine(booking.eventDate, booking.eventEndDate),
    booking.eventTime ? `Time: ${booking.eventTime}` : "",
    booking.venue ? `Venue: ${booking.venue}` : "",
    `Artist: ${booking.assignedArtist || workspace.config.ownerName}`,
  ].filter(Boolean), y - 12, bold, regular, theme);

  y = drawPricingBlock(page, {
    heading: "Commercial Terms",
    lines: [
      ...order.lines,
      ...travelLineItem(travelCost),
      ["Booking Value", inr(adjusted.total)],
      ...adjusted.extraLines,
      ["Advance", inr(booking.advanceAmount)],
      ["Balance", inr(booking.balanceDue)],
      ["Payment Terms", workspace.config.advancePercentage ? `${workspace.config.advancePercentage}% advance` : "As agreed"],
    ],
    y: y - 16,
  }, bold, regular, theme);

  const contractBody = [
    adjusted.note,
    workspace.config.contractTerms ||
      `${workspace.config.businessName || workspace.config.ownerName} agrees to provide professional services for the booking described above.`,
    workspace.config.paymentTerms,
    workspace.config.cancellationPolicy,
    "By signing this agreement, the client confirms the booking details and accepts the terms above.",
  ].filter(Boolean).join("\n\n");

  const bodyBottom = drawParagraph(
    page,
    contractBody,
    { x: 56, y: y - 32, size: 11, font: regular, color: theme.paragraph, maxWidth: 480 },
  );

  if (options.signedBy) {
    const sigY = Math.max(70, (typeof bodyBottom === "number" ? bodyBottom : 140) - 28);
    const when = options.signedAt
      ? new Date(options.signedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
      : "";
    page.drawText("DIGITALLY ACCEPTED", { x: 56, y: sigY, size: 10, font: bold, color: rgb(0.09, 0.4, 0.2) });
    page.drawText(`Accepted by ${options.signedBy}${when ? ` on ${when}` : ""} via secure signing link.`, {
      x: 56, y: sigY - 14, size: 10, font: regular, color: theme.paragraph,
    });
  }

  if (options.voided) drawVoidWatermark(page, bold);
  drawFooter(page, workspace, regular, theme);
  return pdf.save();
}

function resolveInvoiceStage(booking: BookingRecord): InvoiceStage {
  if (booking.paymentStatus === "Advance Due") {
    return { label: "Advance", amount: booking.advanceAmount };
  }

  if (booking.paymentStatus === "Advance Paid") {
    return { label: "Balance", amount: booking.balanceDue };
  }

  return {
    label: booking.paymentStatus === "Paid in Full" ? "Paid" : "Booking",
    amount: booking.balanceDue > 0 ? booking.balanceDue : booking.finalPrice,
  };
}

function drawDocumentFrame(page: PDFDocument["addPage"] extends (...args: any[]) => infer T ? T : never, workspace: WorkspaceRecord, theme: DocumentTheme) {
  page.drawRectangle({
    x: 24,
    y: 24,
    width: 547,
    height: 794,
    borderColor: theme.frameBorder,
    borderWidth: 1,
  });
  page.drawRectangle({
    x: 0,
    y: 770,
    width: 595,
    height: 72,
    color: theme.bandBg,
  });
  page.drawText((workspace.config.businessName || workspace.name).toUpperCase(), {
    x: 56,
    y: 790,
    size: 12,
    color: theme.bandText,
  });
}

function drawHeader(
  page: PDFDocument["addPage"] extends (...args: any[]) => infer T ? T : never,
  input: { title: string; subtitle: string; docNumber: string; docDate: string; gstNumber?: string },
  bold: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  regular: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  theme: DocumentTheme,
  logo?: { image: PdfImage; width: number; height: number } | null,
) {
  page.drawText(input.title, {
    x: 56,
    y: 720,
    size: 28,
    font: bold,
    color: theme.title,
  });
  page.drawText(input.subtitle, {
    x: 56,
    y: 690,
    size: 13,
    font: regular,
    color: theme.subtitle,
  });
  if (input.gstNumber) {
    page.drawText(`GSTIN: ${input.gstNumber}`, {
      x: 56,
      y: 674,
      size: 10,
      font: regular,
      color: theme.meta,
    });
  }
  // Logo sits in the top-right, vertically aligned with the title.
  if (logo) {
    page.drawImage(logo.image, {
      x: 595 - 56 - logo.width,
      y: 690,
      width: logo.width,
      height: logo.height,
    });
  } else {
    // No logo: a monogram badge with the brand's initials so the header never
    // looks unfinished. Built from the subtitle (business or owner name).
    const initials = input.subtitle
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join("");
    if (initials) {
      const cx = 595 - 56 - 22;
      const cy = 716;
      page.drawEllipse({ x: cx, y: cy, xScale: 22, yScale: 22, color: theme.title });
      const textWidth = bold.widthOfTextAtSize(initials, 16);
      page.drawText(initials, {
        x: cx - textWidth / 2,
        y: cy - 6,
        size: 16,
        font: bold,
        color: rgb(1, 1, 1),
      });
    }
    page.drawText(`No. ${input.docNumber}`, {
      x: 400,
      y: 720,
      size: 11,
      font: bold,
      color: theme.meta,
    });
    page.drawText(input.docDate, {
      x: 400,
      y: 702,
      size: 11,
      font: regular,
      color: theme.meta,
    });
    return;
  }
  // With a logo present, put the doc number/date just under it.
  page.drawText(`No. ${input.docNumber}`, {
    x: 595 - 56 - logo.width,
    y: 678,
    size: 10,
    font: bold,
    color: theme.meta,
  });
  page.drawText(input.docDate, {
    x: 595 - 56 - logo.width,
    y: 664,
    size: 10,
    font: regular,
    color: theme.meta,
  });
}

type PdfImage = Awaited<ReturnType<PDFDocument["embedPng"]>>;

// Fetches and embeds the artist's logo, scaled to fit a tidy header box. Returns
// null on any failure so document generation never breaks over a bad logo URL.
async function embedLogo(
  pdf: PDFDocument,
  logoUrl: string,
): Promise<{ image: PdfImage; width: number; height: number } | null> {
  // SSRF guard: only fetch logos from public hosts (the URL is owner-supplied).
  if (!logoUrl || !isPublicHttpUrl(logoUrl)) return null;
  try {
    const res = await fetchWithTimeout(logoUrl);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const isPng = contentType.includes("png") || /\.png(\?|$)/i.test(logoUrl);
    const image = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    // Fit within a 120×56 box, preserving aspect ratio.
    const maxW = 120;
    const maxH = 56;
    const scale = Math.min(maxW / image.width, maxH / image.height, 1);
    return { image, width: image.width * scale, height: image.height * scale };
  } catch {
    return null;
  }
}

// Builds the optional GST breakdown lines, treating `amount` as GST-inclusive
// (the common case for Indian service pricing). Returns [] when no rate is set.
function gstLines(amount: number, gstPercentage: number): [string, string][] {
  if (!gstPercentage || gstPercentage <= 0) return [];
  const total = Math.round(amount);
  const base = Math.round(amount / (1 + gstPercentage / 100));
  // Derive GST as the remainder so base + GST always equals the displayed total
  // exactly (no ±1 rounding drift that a client verifying the math would notice).
  const gst = total - base;
  return [
    ["Taxable Value", inr(base)],
    [`GST @ ${gstPercentage}%`, inr(gst)],
  ];
}

function drawSection(
  page: PDFDocument["addPage"] extends (...args: any[]) => infer T ? T : never,
  heading: string,
  lines: string[],
  startY: number,
  bold: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  regular: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  theme: DocumentTheme,
) {
  page.drawText(heading, {
    x: 56,
    y: startY,
    size: 12,
    font: bold,
    color: theme.sectionHeading,
  });

  let y = startY - 24;
  for (const line of lines) {
    page.drawText(line, {
      x: 56,
      y,
      size: 11,
      font: regular,
      color: theme.bodyText,
    });
    y -= 18;
  }

  return y;
}

function drawPricingBlock(
  page: PDFDocument["addPage"] extends (...args: any[]) => infer T ? T : never,
  input: { heading: string; lines: [string, string][]; y: number },
  bold: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  regular: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  theme: DocumentTheme,
) {
  // Height adapts to the number of rows so GST/extra lines never overflow.
  const blockHeight = 34 + input.lines.length * 20 + 10;
  page.drawRectangle({
    x: 56,
    y: input.y - blockHeight + 10,
    width: 483,
    height: blockHeight,
    color: theme.blockBg,
    borderColor: theme.blockBorder,
    borderWidth: 1,
  });

  page.drawText(input.heading, {
    x: 72,
    y: input.y - 18,
    size: 12,
    font: bold,
    color: theme.blockHeading,
  });

  let y = input.y - 42;
  for (const [label, value] of input.lines) {
    page.drawText(label, {
      x: 72,
      y,
      size: 11,
      font: regular,
      color: theme.blockLabel,
    });
    page.drawText(value, {
      x: 400,
      y,
      size: 11,
      font: bold,
      color: theme.blockValue,
    });
    y -= 20;
  }

  return input.y - blockHeight + 10;
}

function drawFooter(
  page: PDFDocument["addPage"] extends (...args: any[]) => infer T ? T : never,
  workspace: WorkspaceRecord,
  regular: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  theme: DocumentTheme,
) {
  const footer = [
    workspace.config.businessName || workspace.name,
    workspace.config.ownerWhatsApp ? `WhatsApp ${workspace.config.ownerWhatsApp}` : "",
    workspace.config.instagramHandle ? `Instagram @${workspace.config.instagramHandle}` : "",
  ].filter(Boolean).join("  •  ");

  page.drawText(footer, {
    x: 56,
    y: 44,
    size: 10,
    font: regular,
    color: theme.footer,
  });
}

function drawParagraph(
  page: PDFDocument["addPage"] extends (...args: any[]) => infer T ? T : never,
  text: string,
  input: { x: number; y: number; size: number; font: Awaited<ReturnType<PDFDocument["embedFont"]>>; color: ReturnType<typeof rgb>; maxWidth: number },
) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (input.font.widthOfTextAtSize(candidate, input.size) > input.maxWidth) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);

  let y = input.y;
  for (const entry of lines) {
    page.drawText(entry, {
      x: input.x,
      y,
      size: input.size,
      font: input.font,
      color: input.color,
    });
    y -= input.size + 4;
  }
  return y;
}

async function buildUpiQrPng(
  workspace: WorkspaceRecord,
  amount: number,
  invoiceNumber: string,
) {
  if (!workspace.config.upiId) return null;
  const upiLink =
    `upi://pay?pa=${encodeURIComponent(workspace.config.upiId)}` +
    `&pn=${encodeURIComponent(workspace.config.businessName || workspace.config.ownerName)}` +
    `&am=${encodeURIComponent(amount.toFixed(2))}` +
    `&cu=INR&tn=${encodeURIComponent(invoiceNumber)}`;
  const dataUrl = await QRCode.toDataURL(upiLink, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 280,
  });
  return Uint8Array.from(Buffer.from(dataUrl.split(",")[1], "base64"));
}

// Note: pdf-lib's standard Helvetica is WinAnsi-encoded and can't render the
// rupee sign (U+20B9), so documents use "Rs." — the conventional ASCII form.
function inr(amount: number) {
  return `Rs. ${Math.round(amount).toLocaleString("en-IN")}`;
}

function formatDateOnly(value: string) {
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return value;
  }
}

function safeName(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "busydays";
}

function formatDateTime(value: string) {
  try {
    return new Date(value).toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return value;
  }
}
