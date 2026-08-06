// Transactional email templates.
//
// Email HTML is not web HTML. Outlook renders through Word, Gmail strips
// <style> blocks and anything it does not recognise, and several clients
// block remote images by default. So: table layout, every style inline, no
// external assets, and the brand rendered as text rather than a logo image
// that would show as a broken placeholder for most recipients.
//
// Every template returns BOTH a plain-text and an HTML body. The text part is
// not a courtesy - it is what text-only clients show, what some spam filters
// score against, and the fallback when HTML is stripped. It has to carry the
// full message and the link on its own.

// Two forms on purpose: the letterspaced wordmark in the header, and normal
// title case everywhere it appears mid-sentence. "Thank you for registering
// with OPTION DECODE" reads like shouting.
const WORDMARK = "OPTION DECODE";
const BRAND = "Option Decode";
const SUPPORT_EMAIL = "support@pytrade.co.in";
const COMPANY = "PyTrade";

// Slate/emerald, matching the app's own palette. Kept as constants so the two
// templates cannot drift apart.
const INK = "#0f172a";
const BODY_TEXT = "#334155";
const MUTED = "#64748b";
const ACCENT = "#059669";
const BORDER = "#e2e8f0";
const CANVAS = "#f1f5f9";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function greetingName(displayName?: string) {
  const trimmed = displayName?.trim();
  return trimmed ? trimmed : "there";
}

/**
 * Escapes text interpolated into the HTML body. A display name is
 * user-supplied and goes into the markup verbatim otherwise - someone
 * registering as `<img onerror=...>` should not have that rendered in an
 * email that carries an account-verification link.
 */
function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(options: { heading: string; intro: string; bodyHtml: string; ctaLabel: string; ctaUrl: string; footerNote: string }) {
  const { heading, intro, bodyHtml, ctaLabel, ctaUrl, footerNote } = options;
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background-color:${CANVAS};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CANVAS};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border:1px solid ${BORDER};border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

<tr><td style="background-color:${INK};padding:20px 28px;">
<span style="color:#ffffff;font-size:15px;font-weight:600;letter-spacing:2.5px;">${WORDMARK}</span>
<div style="color:#94a3b8;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;margin-top:4px;">Premium fintech trading analytics</div>
</td></tr>

<tr><td style="padding:32px 28px 8px 28px;">
<h1 style="margin:0;color:${INK};font-size:22px;font-weight:600;line-height:1.3;">${heading}</h1>
<p style="margin:16px 0 0 0;color:${BODY_TEXT};font-size:15px;line-height:1.6;">${intro}</p>
${bodyHtml}
</td></tr>

<tr><td align="center" style="padding:28px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" style="background-color:${ACCENT};border-radius:6px;">
<a href="${ctaUrl}" style="display:inline-block;padding:13px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${ctaLabel}</a>
</td></tr></table>
</td></tr>

<tr><td style="padding:0 28px 28px 28px;">
<p style="margin:0;color:${MUTED};font-size:13px;line-height:1.6;">
If the button does not work, copy this link into your browser:
</p>
<p style="margin:8px 0 0 0;word-break:break-all;">
<a href="${ctaUrl}" style="color:${ACCENT};font-size:13px;text-decoration:underline;">${ctaUrl}</a>
</p>
<p style="margin:20px 0 0 0;color:${MUTED};font-size:13px;line-height:1.6;">${footerNote}</p>
</td></tr>

<tr><td style="background-color:#f8fafc;border-top:1px solid ${BORDER};padding:20px 28px;">
<p style="margin:0;color:${MUTED};font-size:12px;line-height:1.6;">
Questions? Write to <a href="mailto:${SUPPORT_EMAIL}" style="color:${ACCENT};text-decoration:none;">${SUPPORT_EMAIL}</a>.
</p>
<p style="margin:10px 0 0 0;color:#94a3b8;font-size:11px;line-height:1.6;">
&copy; ${new Date().getFullYear()} ${COMPANY}. All rights reserved.<br />
This is an automated message sent because someone used this address to ${footerNote.includes("reset") ? "request a password reset" : "create an account"} on ${BRAND}. If that was not you, you can ignore it.
</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export function buildVerificationEmail(displayName: string | undefined, verifyUrl: string): RenderedEmail {
  const name = greetingName(displayName);
  const safeName = escapeHtml(name);

  const text = [
    `Hi ${name},`,
    "",
    `Thank you for registering with ${BRAND} and for taking the time to evaluate the platform.`,
    "",
    "One step remains: confirm this email address so we know we can reach you about your account.",
    "",
    "Verify your email:",
    verifyUrl,
    "",
    "This link is valid for 24 hours. Until it is used, the account cannot sign in.",
    "",
    "Once verified you will have access to the live option chain, Strike Matrix, Elliott Wave analysis, paper trading and alerts.",
    "",
    `Questions? Write to ${SUPPORT_EMAIL}.`,
    "",
    `— The ${COMPANY} Team`,
    "",
    `(c) ${new Date().getFullYear()} ${COMPANY}. This is an automated message sent because someone used this address to create an account. If that was not you, you can ignore it.`
  ].join("\n");

  const html = shell({
    heading: `Welcome, ${safeName}`,
    intro: `Thank you for registering with ${BRAND} and for taking the time to evaluate the platform.`,
    bodyHtml: `
<p style="margin:16px 0 0 0;color:${BODY_TEXT};font-size:15px;line-height:1.6;">
One step remains: confirm this email address so we know we can reach you about your account.
</p>
<p style="margin:16px 0 0 0;color:${BODY_TEXT};font-size:15px;line-height:1.6;">
Once verified you will have access to the live option chain, Strike Matrix, Elliott Wave analysis, paper trading and alerts.
</p>`,
    ctaLabel: "Verify my email",
    ctaUrl: verifyUrl,
    footerNote: "This link is valid for 24 hours. Until it is used, the account cannot sign in."
  });

  return { subject: `Verify your ${BRAND} account`, text, html };
}

export function buildPasswordResetEmail(displayName: string | undefined, resetUrl: string): RenderedEmail {
  const name = greetingName(displayName);
  const safeName = escapeHtml(name);

  const text = [
    `Hi ${name},`,
    "",
    `We received a request to reset the password for your ${BRAND} account.`,
    "",
    "Set a new password:",
    resetUrl,
    "",
    "This link is valid for 1 hour and can only be used once.",
    "",
    "If you did not request this, no action is needed - your password has not changed.",
    "",
    `Questions? Write to ${SUPPORT_EMAIL}.`,
    "",
    `— The ${COMPANY} Team`,
    "",
    `(c) ${new Date().getFullYear()} ${COMPANY}. This is an automated message sent because someone used this address to request a password reset. If that was not you, you can ignore it.`
  ].join("\n");

  const html = shell({
    heading: `Reset your password`,
    intro: `Hi ${safeName}, we received a request to reset the password for your ${BRAND} account.`,
    bodyHtml: `
<p style="margin:16px 0 0 0;color:${BODY_TEXT};font-size:15px;line-height:1.6;">
If you did not request this, no action is needed &mdash; your password has not changed.
</p>`,
    ctaLabel: "Set a new password",
    ctaUrl: resetUrl,
    footerNote: "This link is valid for 1 hour and can only be used once, to reset your password."
  });

  return { subject: `Reset your ${BRAND} password`, text, html };
}
