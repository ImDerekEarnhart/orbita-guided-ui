"use strict";

const { Resend } = require("resend");

const DEFAULT_FROM_ADDRESS = "Orbita <noreply@orbita.research>";

// Lazy-init the Resend client so the module can be imported without a key.
let _resend = null;
let _resendKey = "";
let _testClient = null;

function getResend() {
  if (_testClient) return _testClient;
  const apiKey = process.env.RESEND_API_KEY || "";
  if ((!_resend || _resendKey !== apiKey) && apiKey) {
    _resend = new Resend(apiKey);
    _resendKey = apiKey;
  }
  return _resend;
}

function getAppBaseUrl() {
  return (process.env.APP_BASE_URL || process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || "").replace(/\/$/, "");
}

function getFromAddress() {
  return process.env.EMAIL_FROM || process.env.MAIL_FROM || DEFAULT_FROM_ADDRESS;
}

function extractEmailAddress(value) {
  const raw = String(value || "").trim();
  const angle = raw.match(/<([^>]+)>/);
  return (angle ? angle[1] : raw).trim();
}

function domainFromAddress(value) {
  const address = extractEmailAddress(value);
  const at = address.lastIndexOf("@");
  if (at < 0) return "";
  return address.slice(at + 1).toLowerCase();
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function safeProviderMessage(value) {
  return String(value || "email_provider_error")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/re_[A-Za-z0-9_]+/g, "[redacted]")
    .slice(0, 300);
}

function getEmailConfig() {
  const apiKey = process.env.RESEND_API_KEY || "";
  const appBaseUrl = getAppBaseUrl();
  const fromAddress = getFromAddress();
  const fromConfigured = Boolean(process.env.EMAIL_FROM || process.env.MAIL_FROM);
  const disabledTestKey = apiKey.startsWith("re_test_DISABLED");
  const enabled = Boolean(apiKey && !disabledTestKey && fromConfigured && appBaseUrl);
  return {
    provider: "resend",
    enabled,
    apiKeyPresent: Boolean(apiKey),
    disabledTestKey,
    fromConfigured,
    fromDomain: domainFromAddress(fromAddress),
    appBaseUrlConfigured: Boolean(appBaseUrl),
    appBaseHost: hostFromUrl(appBaseUrl),
    environment: process.env.APP_ENV || "development",
  };
}

function emailDisabledReason(config) {
  if (!config.apiKeyPresent) return "missing_api_key";
  if (config.disabledTestKey) return "disabled_test_key";
  if (!config.fromConfigured) return "missing_from_address";
  if (!config.appBaseUrlConfigured) return "missing_app_base_url";
  return "email_not_configured";
}

/**
 * Send an email via Resend.
 * Returns a structured result and never logs secrets or recipient addresses.
 * Local development without email configuration is simulated; staging and
 * production fail closed so signup/resend cannot show a false success.
 */
async function sendEmail({ to, subject, html, text, client }) {
  const config = getEmailConfig();
  if (!config.enabled) {
    const reason = emailDisabledReason(config);
    if (config.environment === "development") {
      console.log(`[email] simulated provider=${config.provider} reason=${reason} from_domain=${config.fromDomain || "missing"}`);
      return { ok: true, simulated: true, provider: config.provider, accepted: true, fromDomain: config.fromDomain };
    }
    console.error(`[email] delivery disabled provider=${config.provider} reason=${reason} from_domain=${config.fromDomain || "missing"}`);
    return {
      ok: false,
      provider: config.provider,
      error: reason,
      statusCode: null,
      accepted: false,
      fromDomain: config.fromDomain,
    };
  }

  try {
    const resend = client || getResend();
    const { data, error } = await resend.emails.send({
      from: getFromAddress(),
      to: [to],
      subject,
      html,
      text,
    });
    if (error) {
      const statusCode = error.statusCode || error.status || null;
      const message = safeProviderMessage(error.message || error.name || error);
      console.error(`[email] provider rejected provider=${config.provider} status=${statusCode || "unknown"} error=${message} from_domain=${config.fromDomain || "missing"}`);
      return {
        ok: false,
        provider: config.provider,
        error: message,
        statusCode,
        accepted: false,
        fromDomain: config.fromDomain,
      };
    }
    console.log(`[email] provider accepted provider=${config.provider} id_present=${data?.id ? "yes" : "no"} from_domain=${config.fromDomain || "missing"}`);
    return {
      ok: true,
      provider: config.provider,
      id: data?.id,
      statusCode: 202,
      accepted: true,
      fromDomain: config.fromDomain,
    };
  } catch (err) {
    const statusCode = err.statusCode || err.status || null;
    const message = safeProviderMessage(err.message || err);
    console.error(`[email] send failed provider=${config.provider} status=${statusCode || "unknown"} error=${message} from_domain=${config.fromDomain || "missing"}`);
    return {
      ok: false,
      provider: config.provider,
      error: message,
      statusCode,
      accepted: false,
      fromDomain: config.fromDomain,
    };
  }
}

function verificationUrl(token) {
  const base = getAppBaseUrl();
  return `${base}/auth/verify-email?token=${encodeURIComponent(token)}`;
}

function verificationEmail(username, token) {
  const url = verificationUrl(token);
  return {
    subject: "Verify your Orbita account",
    html: `
<p>Hello ${escHtml(username)},</p>
<p>Please verify your email address to activate your Orbita account. This link expires in 24 hours and can only be used once.</p>
<p><a href="${escAttr(url)}" style="font-size:16px;font-weight:bold;">Verify my email address</a></p>
<p>If you did not create an Orbita account, ignore this email.</p>
<p>- The Orbita Research Team</p>
<hr/>
<p style="font-size:12px;color:#666;">If the link above does not work, copy and paste this URL: ${escHtml(url)}</p>
<p style="font-size:11px;color:#999;">Orbita produces experimental research findings. Do not use Orbita as the sole basis for medical, legal, financial, or safety-critical decisions.</p>
    `.trim(),
    text: `Hello ${username}\n\nPlease verify your email address to activate your Orbita account.\n\nVerification link (expires in 24 hours):\n${url}\n\nIf you did not create an Orbita account, ignore this email.\n\n- The Orbita Research Team\n\nOrbita produces experimental research findings and must not be used as the sole basis for medical, legal, financial, or safety-critical decisions.`,
  };
}

function passwordResetEmail(username, token) {
  const url = `${getAppBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    subject: "Reset your Orbita password",
    html: `
<p>Hello ${escHtml(username)},</p>
<p>We received a request to reset the password for your Orbita account. This link expires in 1 hour and can only be used once.</p>
<p><a href="${escAttr(url)}" style="font-size:16px;font-weight:bold;">Reset my password</a></p>
<p>If you did not request a password reset, ignore this email. Your password has not changed.</p>
<p>- The Orbita Research Team</p>
<hr/>
<p style="font-size:12px;color:#666;">If the link above does not work, copy and paste this URL: ${escHtml(url)}</p>
    `.trim(),
    text: `Hello ${username}\n\nWe received a request to reset your Orbita password.\n\nReset link (expires in 1 hour, single-use):\n${url}\n\nIf you did not request this, ignore this email.\n\n- The Orbita Research Team`,
  };
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(s) {
  return escHtml(s);
}

function _setResendClientForTest(client) {
  _testClient = client;
}

function _resetResendClientForTest() {
  _testClient = null;
  _resend = null;
  _resendKey = "";
}

module.exports = {
  sendEmail,
  verificationEmail,
  verificationUrl,
  passwordResetEmail,
  getEmailConfig,
  domainFromAddress,
  _setResendClientForTest,
  _resetResendClientForTest,
};
