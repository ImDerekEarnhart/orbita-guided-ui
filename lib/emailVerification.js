"use strict";

const tokens = require("./tokens");
const emailLib = require("./email");

const EMAIL_SEND_FAILED_CODE = "email_send_failed";
const SIGNUP_EMAIL_SEND_FAILED_MESSAGE =
  "Account created, but verification email could not be sent. Please try resend or contact support.";

function emailDomain(email) {
  const raw = String(email || "").trim();
  const at = raw.lastIndexOf("@");
  if (at < 0) return "";
  return raw.slice(at + 1).toLowerCase();
}

function shouldLogFallbackUrl() {
  return (process.env.APP_ENV || "development") !== "production";
}

function cleanLogValue(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/re_[A-Za-z0-9_]+/g, "[redacted]")
    .slice(0, 300);
}

function logDelivery(logger, level, fields) {
  const sink = logger?.[level] || logger?.log || console.log;
  sink.call(logger || console, `[email-verification] ${JSON.stringify(fields)}`);
}

async function deliverVerificationEmail({
  userId,
  username,
  email,
  action = "signup",
  tokenStore = tokens,
  mailer = emailLib,
  logger = console,
} = {}) {
  let rawToken = "";
  try {
    rawToken = await tokenStore.createVerificationToken(userId);
  } catch (err) {
    logDelivery(logger, "error", {
      action,
      user_id: userId || null,
      email_domain: emailDomain(email) || null,
      provider: "unknown",
      token_created: "no",
      resend_attempted: action === "resend" ? "yes" : "no",
      message_accepted: "no",
      provider_status: null,
      provider_error: cleanLogValue(err?.message || "token_create_failed"),
    });
    return { ok: false, reason: "token_create_failed", tokenCreated: false };
  }

  const { subject, html, text } = mailer.verificationEmail(username, rawToken);
  let sendResult;
  try {
    sendResult = await mailer.sendEmail({ to: email, subject, html, text });
  } catch (err) {
    sendResult = {
      ok: false,
      provider: "unknown",
      error: err?.message || "email_send_failed",
      statusCode: null,
      accepted: false,
    };
  }

  const config = typeof mailer.getEmailConfig === "function" ? mailer.getEmailConfig() : {};
  const ok = sendResult?.ok === true;
  const provider = sendResult?.provider || config.provider || "unknown";
  const statusCode = sendResult?.statusCode ?? null;
  const fromDomain = sendResult?.fromDomain || config.fromDomain || null;

  logDelivery(logger, ok ? "log" : "error", {
    action,
    user_id: userId || null,
    email_domain: emailDomain(email) || null,
    provider,
    from_domain: fromDomain,
    token_created: "yes",
    resend_attempted: action === "resend" ? "yes" : "no",
    message_accepted: ok ? "yes" : "no",
    provider_status: statusCode,
    provider_error: ok ? null : cleanLogValue(sendResult?.error || "email_send_failed"),
  });

  if (!ok && shouldLogFallbackUrl() && typeof mailer.verificationUrl === "function") {
    logDelivery(logger, "error", {
      action,
      user_id: userId || null,
      staging_fallback_verification_url: mailer.verificationUrl(rawToken),
    });
  }

  return {
    ok,
    reason: ok ? "sent" : "send_failed",
    tokenCreated: true,
    provider,
    statusCode,
    messageIdPresent: Boolean(sendResult?.id),
    simulated: Boolean(sendResult?.simulated),
  };
}

module.exports = {
  EMAIL_SEND_FAILED_CODE,
  SIGNUP_EMAIL_SEND_FAILED_MESSAGE,
  deliverVerificationEmail,
  emailDomain,
};
