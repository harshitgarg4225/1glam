import { Readable } from "node:stream";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import type { Credentials } from "google-auth-library";
import { createGoogleClients } from "./google.js";
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

  drawDocumentFrame(page, workspace, theme);
  drawHeader(page, {
    title: "Luxury Quote",
    subtitle: workspace.config.businessName || workspace.config.ownerName,
    docNumber: quoteNumber,
    docDate: new Date().toLocaleDateString("en-IN"),
  }, bold, regular, theme);

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
      ["Quoted Amount", inr(quotedAmount)],
      ["Advance To Confirm", inr(advanceAmount)],
      ["Demand Signal", lead.scarcityTag || "Open"],
      ["Hold Expires", lead.holdExpiresAt ? formatDateTime(lead.holdExpiresAt) : "On request"],
    ],
    y: y - 16,
  }, bold, regular, theme);

  drawParagraph(
    page,
    workspace.config.paymentTerms,
    { x: 56, y: y - 30, size: 11, font: regular, color: theme.paragraph, maxWidth: 480 },
  );

  drawFooter(page, workspace, regular, theme);
  return pdf.save();
}

export async function generateQuoteDocument(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  lead: LeadRecord,
) {
  const quoteNumber = `Q-${lead.leadId}`;
  const pdfBytes = await buildQuotePdfBytes(workspace, lead);
  return uploadPdfToDrive(tokens, {
    fileName: `${safeName(workspace.config.businessName || workspace.name)}-${quoteNumber}.pdf`,
    title: `${workspace.config.businessName || workspace.name} Quote ${quoteNumber}`,
    pdfBytes,
  });
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

  drawDocumentFrame(page, workspace, theme);
  drawHeader(page, {
    title: "Booking Invoice",
    subtitle: workspace.config.businessName || workspace.config.ownerName,
    docNumber: invoiceNumber,
    docDate: new Date().toLocaleDateString("en-IN"),
  }, bold, regular, theme);

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

export async function generateInvoiceDocument(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  booking: BookingRecord,
) {
  const invoiceNumber = `INV-${booking.bookingId}`;
  const pdfBytes = await buildInvoicePdfBytes(workspace, booking);
  return uploadPdfToDrive(tokens, {
    fileName: `${safeName(workspace.config.businessName || workspace.name)}-${invoiceNumber}.pdf`,
    title: `${workspace.config.businessName || workspace.name} Invoice ${invoiceNumber}`,
    pdfBytes,
  });
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

  drawDocumentFrame(page, workspace, theme);
  drawHeader(page, {
    title: "Booking Agreement",
    subtitle: workspace.config.businessName || workspace.config.ownerName,
    docNumber: contractNumber,
    docDate: new Date().toLocaleDateString("en-IN"),
  }, bold, regular, theme);

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

  drawParagraph(
    page,
    [
      `${workspace.config.businessName || workspace.config.ownerName} agrees to provide professional makeup services for the booking described above.`,
      workspace.config.paymentTerms,
      "By signing this agreement, the client confirms the booking details and accepts the quoted payment terms.",
    ].join(" "),
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

async function uploadPdfToDrive(
  tokens: Credentials,
  input: { fileName: string; title: string; pdfBytes: Uint8Array },
): Promise<UploadedDriveFile> {
  const { drive } = createGoogleClients(tokens);
  const response = await drive.files.create({
    requestBody: {
      name: input.fileName,
      mimeType: "application/pdf",
      description: input.title,
    },
    media: {
      mimeType: "application/pdf",
      body: Readable.from(Buffer.from(input.pdfBytes)),
    },
    fields: "id, webViewLink, webContentLink",
  });

  const fileId = response.data.id;
  if (!fileId) {
    throw new Error("Google Drive upload failed");
  }

  try {
    await drive.permissions.create({
      fileId,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
    });
  } catch {
    // If public sharing is blocked, keep the owner-visible Drive link.
  }

  const refreshed = await drive.files.get({
    fileId,
    fields: "id, webViewLink, webContentLink",
  });

  return {
    fileId,
    fileName: input.fileName,
    fileUrl:
      refreshed.data.webViewLink ||
      refreshed.data.webContentLink ||
      `https://drive.google.com/file/d/${fileId}/view`,
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
  input: { title: string; subtitle: string; docNumber: string; docDate: string },
  bold: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  regular: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  theme: DocumentTheme,
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
  page.drawRectangle({
    x: 56,
    y: input.y - 100,
    width: 483,
    height: 110,
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

  return input.y - 100;
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
