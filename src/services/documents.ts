import { Readable } from "node:stream";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import type { Credentials } from "google-auth-library";
import { createGoogleClients } from "./google.js";
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

export async function generateQuoteDocument(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  lead: LeadRecord,
) {
  const quoteNumber = `Q-${lead.leadId}`;
  const quotedAmount = lead.finalApprovedPrice || lead.initialAiPrice;
  const advanceAmount = premiumRound(
    (quotedAmount * workspace.config.advancePercentage) / 100,
  );

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  drawDocumentFrame(page, workspace);
  drawHeader(page, {
    title: "Luxury Quote",
    subtitle: workspace.config.businessName || workspace.config.ownerName,
    docNumber: quoteNumber,
    docDate: new Date().toLocaleDateString("en-IN"),
  }, bold, regular);

  let y = 650;
  y = drawSection(page, "Prepared For", [
    lead.clientName || "Valued Client",
    lead.clientWhatsApp ? `WhatsApp: ${lead.clientWhatsApp}` : "",
    lead.clientInstagram ? `Instagram: ${lead.clientInstagram}` : "",
  ].filter(Boolean), y, bold, regular);

  y = drawSection(page, "Event Details", [
    `Event: ${lead.eventType}`,
    `Date: ${lead.eventDate || "To be confirmed"}`,
    `Time: ${lead.eventTime || "To be confirmed"}`,
    `Location: ${lead.locationText || "To be confirmed"}`,
  ], y - 12, bold, regular);

  y = drawPricingBlock(page, {
    heading: "Quote Summary",
    lines: [
      ["Quoted Amount", inr(quotedAmount)],
      ["Advance To Confirm", inr(advanceAmount)],
      ["Demand Signal", lead.scarcityTag || "Open"],
      ["Hold Expires", lead.holdExpiresAt ? formatDateTime(lead.holdExpiresAt) : "On request"],
    ],
    y: y - 16,
  }, bold, regular);

  drawParagraph(
    page,
    workspace.config.paymentTerms,
    { x: 56, y: y - 30, size: 11, font: regular, color: rgb(0.2, 0.2, 0.2), maxWidth: 480 },
  );

  drawFooter(page, workspace, regular);

  const pdfBytes = await pdf.save();
  return uploadPdfToDrive(tokens, {
    fileName: `${safeName(workspace.config.businessName || workspace.name)}-${quoteNumber}.pdf`,
    title: `${workspace.config.businessName || workspace.name} Quote ${quoteNumber}`,
    pdfBytes,
  });
}

export async function generateInvoiceDocument(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  booking: BookingRecord,
) {
  const invoiceNumber = `INV-${booking.bookingId}`;
  const stage = resolveInvoiceStage(booking);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  drawDocumentFrame(page, workspace);
  drawHeader(page, {
    title: "Booking Invoice",
    subtitle: workspace.config.businessName || workspace.config.ownerName,
    docNumber: invoiceNumber,
    docDate: new Date().toLocaleDateString("en-IN"),
  }, bold, regular);

  let y = 650;
  y = drawSection(page, "Billed To", [
    booking.clientName || "Valued Client",
    booking.clientWhatsApp ? `WhatsApp: ${booking.clientWhatsApp}` : "",
  ].filter(Boolean), y, bold, regular);

  y = drawSection(page, "Booking Details", [
    `Event: ${booking.eventType}`,
    `Date: ${booking.eventDate || "To be confirmed"}`,
    `Time: ${booking.eventTime || "To be confirmed"}`,
    `Venue: ${booking.venue || "To be confirmed"}`,
    `Assigned Artist: ${booking.assignedArtist || "To be assigned"}`,
  ], y - 12, bold, regular);

  y = drawPricingBlock(page, {
    heading: `${stage.label} Invoice`,
    lines: [
      ["Invoice Amount", inr(stage.amount)],
      ["Total Booking Value", inr(booking.finalPrice)],
      ["Advance", inr(booking.advanceAmount)],
      ["Balance", inr(booking.balanceDue)],
    ],
    y: y - 16,
  }, bold, regular);

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
        { x: 220, y: y - 70, size: 12, font: bold, color: rgb(0.18, 0.18, 0.18), maxWidth: 260 },
      );
      drawParagraph(
        page,
        workspace.config.paymentTerms,
        { x: 220, y: y - 100, size: 11, font: regular, color: rgb(0.24, 0.24, 0.24), maxWidth: 300 },
      );
    }
  } else {
    drawParagraph(
      page,
      workspace.config.paymentTerms,
      { x: 56, y: y - 40, size: 11, font: regular, color: rgb(0.24, 0.24, 0.24), maxWidth: 480 },
    );
  }

  drawFooter(page, workspace, regular);

  const pdfBytes = await pdf.save();
  return uploadPdfToDrive(tokens, {
    fileName: `${safeName(workspace.config.businessName || workspace.name)}-${invoiceNumber}.pdf`,
    title: `${workspace.config.businessName || workspace.name} Invoice ${invoiceNumber}`,
    pdfBytes,
  });
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

function drawDocumentFrame(page: PDFDocument["addPage"] extends (...args: any[]) => infer T ? T : never, workspace: WorkspaceRecord) {
  page.drawRectangle({
    x: 24,
    y: 24,
    width: 547,
    height: 794,
    borderColor: rgb(0.77, 0.66, 0.53),
    borderWidth: 1,
  });
  page.drawRectangle({
    x: 0,
    y: 770,
    width: 595,
    height: 72,
    color: rgb(0.97, 0.95, 0.92),
  });
  page.drawText((workspace.config.businessName || workspace.name).toUpperCase(), {
    x: 56,
    y: 790,
    size: 12,
    color: rgb(0.39, 0.29, 0.18),
  });
}

function drawHeader(
  page: PDFDocument["addPage"] extends (...args: any[]) => infer T ? T : never,
  input: { title: string; subtitle: string; docNumber: string; docDate: string },
  bold: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  regular: Awaited<ReturnType<PDFDocument["embedFont"]>>,
) {
  page.drawText(input.title, {
    x: 56,
    y: 720,
    size: 28,
    font: bold,
    color: rgb(0.14, 0.1, 0.08),
  });
  page.drawText(input.subtitle, {
    x: 56,
    y: 690,
    size: 13,
    font: regular,
    color: rgb(0.32, 0.25, 0.2),
  });
  page.drawText(`No. ${input.docNumber}`, {
    x: 400,
    y: 720,
    size: 11,
    font: bold,
    color: rgb(0.2, 0.2, 0.2),
  });
  page.drawText(input.docDate, {
    x: 400,
    y: 702,
    size: 11,
    font: regular,
    color: rgb(0.3, 0.3, 0.3),
  });
}

function drawSection(
  page: PDFDocument["addPage"] extends (...args: any[]) => infer T ? T : never,
  heading: string,
  lines: string[],
  startY: number,
  bold: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  regular: Awaited<ReturnType<PDFDocument["embedFont"]>>,
) {
  page.drawText(heading, {
    x: 56,
    y: startY,
    size: 12,
    font: bold,
    color: rgb(0.23, 0.17, 0.12),
  });

  let y = startY - 24;
  for (const line of lines) {
    page.drawText(line, {
      x: 56,
      y,
      size: 11,
      font: regular,
      color: rgb(0.2, 0.2, 0.2),
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
) {
  page.drawRectangle({
    x: 56,
    y: input.y - 100,
    width: 483,
    height: 110,
    color: rgb(0.985, 0.972, 0.955),
    borderColor: rgb(0.9, 0.82, 0.7),
    borderWidth: 1,
  });

  page.drawText(input.heading, {
    x: 72,
    y: input.y - 18,
    size: 12,
    font: bold,
    color: rgb(0.23, 0.17, 0.12),
  });

  let y = input.y - 42;
  for (const [label, value] of input.lines) {
    page.drawText(label, {
      x: 72,
      y,
      size: 11,
      font: regular,
      color: rgb(0.25, 0.25, 0.25),
    });
    page.drawText(value, {
      x: 400,
      y,
      size: 11,
      font: bold,
      color: rgb(0.16, 0.16, 0.16),
    });
    y -= 20;
  }

  return input.y - 100;
}

function drawFooter(
  page: PDFDocument["addPage"] extends (...args: any[]) => infer T ? T : never,
  workspace: WorkspaceRecord,
  regular: Awaited<ReturnType<PDFDocument["embedFont"]>>,
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
    color: rgb(0.45, 0.45, 0.45),
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
