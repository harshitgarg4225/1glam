import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import type { Credentials } from "google-auth-library";
import { buildPublicDocumentUrl } from "./document-links.js";
import { getDocumentTheme, type DocumentTheme } from "./document-themes.js";
import type { WorkspaceRecord } from "../types.js";
import type { BookingRecord, LeadRecord } from "./booking.js";

type UploadedDriveFile = {
  fileId: string;
  fileName: string;
  fileUrl: string;
};

type InvoiceStage = {
  label: string;
  amount: number;
};

// Builds the quote PDF bytes in memory (no Drive upload). Used for both the
// in-app preview and the Drive-backed shareable document.
export async function buildQuotePdfBytes(
  workspace: WorkspaceRecord,
  lead: LeadRecord,
): Promise<Uint8Array> {
  const quoteNumber = `Q-${lead.leadId}`;
  const quotedAmount = lead.finalApprovedPrice || lead.initialAiPrice;
  const advanceAmount = premiumRound(
    (quotedAmount * workspace.config.advancePercentage) / 100,
  );

  const theme = getDocumentTheme(workspace.config.documentTemplate);
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
    docDate: new Date().toLocaleDateString("en-IN"),
    gstNumber: workspace.config.gstNumber,
  }, bold, regular, theme, logo);

  let y = 650;
  y = drawSection(page, "Prepared For", [
    lead.clientName || "Valued Client",
    lead.clientWhatsApp ? `WhatsApp: ${lead.clientWhatsApp}` : "",
    lead.clientInstagram ? `Instagram: ${lead.clientInstagram}` : "",
  ].filter(Boolean), y, bold, regular, theme);

  y = drawSection(page, "Event Details", [
    `Event: ${lead.eventType}`,
    `Date: ${lead.eventDate || "To be confirmed"}`,
    `Time: ${lead.eventTime || "To be confirmed"}`,
    `Location: ${lead.locationText || "To be confirmed"}`,
  ], y - 12, bold, regular, theme);

  y = drawPricingBlock(page, {
    heading: "Quote Summary",
    lines: [
      ...gstLines(quotedAmount, workspace.config.gstPercentage),
      ["Quoted Amount", inr(quotedAmount)],
      ["Advance To Confirm", inr(advanceAmount)],
      ["Hold Expires", lead.holdExpiresAt ? formatDateTime(lead.holdExpiresAt) : "On request"],
    ],
    y: y - 16,
  }, bold, regular, theme);

  const quoteParts = [
    workspace.config.quoteIntro,
    workspace.config.paymentTerms,
    workspace.config.cancellationPolicy,
  ].filter(Boolean).join("\n\n");

  drawParagraph(
    page,
    quoteParts || "Payment terms as agreed.",
    { x: 56, y: y - 30, size: 11, font: regular, color: theme.paragraph, maxWidth: 480 },
  );

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
  const quoteNumber = `Q-${lead.leadId}`;
  return {
    fileId: "",
    fileName: `${safeName(workspace.config.businessName || workspace.name)}-${quoteNumber}.pdf`,
    fileUrl: buildPublicDocumentUrl("quote", workspace.workspaceId, lead.leadId),
  };
}

// Builds the invoice PDF bytes in memory (no Drive upload). Used for both the
// in-app preview and the Drive-backed shareable document.
export async function buildInvoicePdfBytes(
  workspace: WorkspaceRecord,
  booking: BookingRecord,
): Promise<Uint8Array> {
  const invoiceNumber = `INV-${booking.bookingId}`;
  const stage = resolveInvoiceStage(booking);
  const theme = getDocumentTheme(workspace.config.documentTemplate);
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
    docDate: new Date().toLocaleDateString("en-IN"),
    gstNumber: workspace.config.gstNumber,
  }, bold, regular, theme, logo);

  let y = 650;
  y = drawSection(page, "Billed To", [
    booking.clientName || "Valued Client",
    booking.clientWhatsApp ? `WhatsApp: ${booking.clientWhatsApp}` : "",
  ].filter(Boolean), y, bold, regular, theme);

  y = drawSection(page, "Booking Details", [
    `Event: ${booking.eventType}`,
    `Date: ${booking.eventDate || "To be confirmed"}`,
    `Time: ${booking.eventTime || "To be confirmed"}`,
    `Venue: ${booking.venue || "To be confirmed"}`,
    `Assigned Artist: ${booking.assignedArtist || "To be assigned"}`,
  ], y - 12, bold, regular, theme);

  y = drawPricingBlock(page, {
    heading: `${stage.label} Invoice`,
    lines: [
      ...gstLines(stage.amount, workspace.config.gstPercentage),
      ["Invoice Amount", inr(stage.amount)],
      ["Total Booking Value", inr(booking.finalPrice)],
      ["Advance", inr(booking.advanceAmount)],
      ["Balance", inr(booking.balanceDue)],
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
        workspace.config.paymentTerms,
        { x: 220, y: y - 100, size: 11, font: regular, color: theme.paragraph, maxWidth: 300 },
      );
    }
  } else {
    drawParagraph(
      page,
      workspace.config.paymentTerms,
      { x: 56, y: y - 40, size: 11, font: regular, color: theme.paragraph, maxWidth: 480 },
    );
  }

  drawFooter(page, workspace, regular, theme);
  return pdf.save();
}

// Produces the client-facing invoice link, served by the app (no Drive).
export async function generateInvoiceDocument(
  workspace: WorkspaceRecord,
  _tokens: Credentials,
  booking: BookingRecord,
): Promise<UploadedDriveFile> {
  const invoiceNumber = `INV-${booking.bookingId}`;
  return {
    fileId: "",
    fileName: `${safeName(workspace.config.businessName || workspace.name)}-${invoiceNumber}.pdf`,
    fileUrl: buildPublicDocumentUrl("invoice", workspace.workspaceId, booking.bookingId),
  };
}

export async function generateContractPdfBytes(
  workspace: WorkspaceRecord,
  lead: LeadRecord,
  booking: BookingRecord,
) {
  const contractNumber = `CTR-${booking.bookingId}`;
  const theme = getDocumentTheme(workspace.config.documentTemplate);
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
    docDate: new Date().toLocaleDateString("en-IN"),
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
    `Date: ${booking.eventDate || "To be confirmed"}`,
    `Time: ${booking.eventTime || "To be confirmed"}`,
    `Venue: ${booking.venue || "To be confirmed"}`,
    `Artist: ${booking.assignedArtist || workspace.config.ownerName}`,
  ], y - 12, bold, regular, theme);

  y = drawPricingBlock(page, {
    heading: "Commercial Terms",
    lines: [
      ["Booking Value", inr(booking.finalPrice)],
      ["Advance", inr(booking.advanceAmount)],
      ["Balance", inr(booking.balanceDue)],
      ["Payment Terms", workspace.config.advancePercentage ? `${workspace.config.advancePercentage}% advance` : "As agreed"],
    ],
    y: y - 16,
  }, bold, regular, theme);

  const contractBody = [
    workspace.config.contractTerms ||
      `${workspace.config.businessName || workspace.config.ownerName} agrees to provide professional makeup services for the booking described above.`,
    workspace.config.paymentTerms,
    workspace.config.cancellationPolicy,
    "By signing this agreement, the client confirms the booking details and accepts the terms above.",
  ].filter(Boolean).join("\n\n");

  drawParagraph(
    page,
    contractBody,
    { x: 56, y: y - 32, size: 11, font: regular, color: theme.paragraph, maxWidth: 480 },
  );

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
  if (!logoUrl || !/^https?:\/\//i.test(logoUrl)) return null;
  try {
    const res = await fetch(logoUrl);
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
  const base = amount / (1 + gstPercentage / 100);
  const gst = amount - base;
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

function inr(amount: number) {
  return `INR ${Math.round(amount).toLocaleString("en-IN")}`;
}

function safeName(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "1glam";
}

function premiumRound(value: number) {
  const rounded = Math.round(value / 500) * 500;
  const premium = rounded - 200;
  return premium > 0 ? premium : rounded;
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
