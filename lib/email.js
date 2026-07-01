"use strict";

const { Resend } = require("resend");

const RESEND_API_KEY  = process.env.RESEND_API_KEY || "";
const FROM_ADDRESS    = process.env.EMAIL_FROM || "Orbita <noreply@orbita.research>";
const APP_BASE_URL    = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const EMAIL_ENABLED   = Boolean(RESEND_API_KEY && !RESEND_API_KEY.startsWith("re_test_DISABLED"));

// Lazy-init the Resend client so the module can be imported without a key
let _resend = null;
function getResend() {
  if (!_resend && RESEND_API_KEY) _resend = new Resend(RESEND_API_KEY);
  return _resend;
}

/**
 * Send an email via Resend.
 * Returns { ok: true } or { ok: false, error }.
 * In development (no API key) or when RESEND_API_KEY starts with "re_test_",
 * the email is logged but not sent.
 */
async function sendEmail({ to, subject, html, text }) {
  if (!EMAIL_ENABLED) {
    console.log(`[email] DISABLED — would send to ${to}: ${subject}`);
    if (process.env.APP_ENV === "development") console.log(`[email] text: ${text}`);
    return { ok: true, simulated: true };
  }
  try {
    const client = getResend();
    const { data, error } = await client.emails.send({
      from: FROM_ADDRESS,
      to: [to],
      subject,
      html,
      text,
    });
    if (error) {
      console.error("[email] Resend error:", error);
      return { ok: false, error: error.message };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error("[email] Send failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// ── Email templates ───────────────────────────────────────────────────────────

function verificationEmail(username, token) {
  const url = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  return {
    subject: "Verify your Orbita account",
    html: `
<p>Hello ${escHtml(username)},</p>
<p>Please verify your email address to activate your Orbita account. This link expires in 24 hours and can only be used once.</p>
<p><a href="${escAttr(url)}" style="font-size:16px;font-weight:bold;">Verify my email address</a></p>
<p>If you did not create an Orbita account, ignore this email.</p>
<p>— The Orbita Research Team</p>
<hr/>
<p style="font-size:12px;color:#666;">If the link above does not work, copy and paste this URL: ${escHtml(url)}</p>
<p style="font-size:11px;color:#999;">Orbita produces experimental research findings. Do not use Orbita as the sole basis for medical, legal, financial, or safety-critical decisions.</p>
    `.trim(),
    text: `Hello ${username},\n\nPlease verify your email address to activate your Orbita account.\n\nVerification link (expires in 24 hours):\n${url}\n\nIf you did not create an Orbita account, ignore this email.\n\n— The Orbita Research Team\n\nOrbita produces experimental research findings and must not be used as the sole basis for medical, legal, financial, or safety-critical decisions.`,
  };
}

function passwordResetEmail(username, token) {
  const url = `${APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    subject: "Reset your Orbita password",
    html: `
<p>Hello ${escHtml(username)},</p>
<p>We received a request to reset the password for your Orbita account. This link expires in 1 hour and can only be used once.</p>
<p><a href="${escAttr(url)}" style="font-size:16px;font-weight:bold;">Reset my password</a></p>
<p>If you did not request a password reset, ignore this email. Your password has not changed.</p>
<p>— The Orbita Research Team</p>
<hr/>
<p style="font-size:12px;color:#666;">If the link above does not work, copy and paste this URL: ${escHtml(url)}</p>
    `.trim(),
    text: `Hello ${username},\n\nWe received a request to reset your Orbita password.\n\nReset link (expires in 1 hour, single-use):\n${url}\n\nIf you did not request this, ignore this email.\n\n— The Orbita Research Team`,
  };
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escAttr(s) { return escHtml(s); }

module.exports = {
  sendEmail,
  verificationEmail,
  passwordResetEmail,
  EMAIL_ENABLED,
};
