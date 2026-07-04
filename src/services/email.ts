import type { WorkspaceConfig } from "../types.js";

// Nodemailer is an optional dependency. If the user has configured SMTP it will
// be imported at send-time; otherwise email is silently skipped so WhatsApp-only
// workspaces work without installing extra packages.

export type EmailPayload = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export function emailEnabled(config: WorkspaceConfig): boolean {
  return (
    config.emailEnabled === "Yes" &&
    Boolean(config.smtpHost) &&
    Boolean(config.smtpUser) &&
    Boolean(config.smtpPass)
  );
}

export async function sendEmail(
  config: WorkspaceConfig,
  payload: EmailPayload,
): Promise<{ ok: boolean; error?: string }> {
  if (!emailEnabled(config)) return { ok: false, error: "Email not configured" };
  try {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.default.createTransport({
      host: config.smtpHost,
      port: config.smtpPort || 587,
      secure: (config.smtpPort || 587) === 465,
      auth: { user: config.smtpUser, pass: config.smtpPass },
    });
    await transporter.sendMail({
      from: config.smtpFrom || config.smtpUser,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Minimal branded HTML wrapper for transactional emails.
export function wrapEmailHtml(config: WorkspaceConfig, body: string): string {
  const brand = config.businessName || "BusyDays";
  const color = config.brandColor || "#71121F";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f5f5f5;font-family:sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;">
<tr><td style="background:${color};padding:20px 32px;"><span style="color:#fff;font-size:20px;font-weight:700;">${brand}</span></td></tr>
<tr><td style="padding:28px 32px;color:#1a1a1a;font-size:15px;line-height:1.6;">${body}</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #eee;color:#888;font-size:12px;">You're receiving this because you booked with ${brand}. Reply to this email if you have questions.</td></tr>
</table></td></tr></table></body></html>`;
}
