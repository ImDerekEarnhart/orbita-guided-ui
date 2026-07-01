"use strict";

const crypto = require("node:crypto");
const db     = require("./db");

const TOKEN_BYTES       = 32;
const VERIFY_TTL_MIN    = 24 * 60;  // 24 hours
const RESET_TTL_MIN     = 60;       // 1 hour

/** Generate a cryptographically random URL-safe token and its SHA-256 hash. */
function generateToken() {
  const raw  = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

/** Hash a raw token (for lookup). */
function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// ── Email verification ────────────────────────────────────────────────────────

/** Create a new verification token for a user. Invalidates previous unused tokens. */
async function createVerificationToken(userId) {
  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MIN * 60_000);

  // Delete any existing unused tokens for this user
  await db.query(
    "DELETE FROM email_verifications WHERE user_id = $1 AND used_at IS NULL",
    [userId]
  );

  await db.query(
    `INSERT INTO email_verifications (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hash, expiresAt]
  );

  await db.query(
    "UPDATE users SET verification_sent_at = NOW() WHERE id = $1",
    [userId]
  );

  return raw;
}

/**
 * Verify an email verification token.
 * Returns { ok: true, userId } or { ok: false, reason }.
 */
async function consumeVerificationToken(raw) {
  const hash = hashToken(raw);
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT id, user_id, expires_at, used_at
       FROM email_verifications
       WHERE token_hash = $1
       FOR UPDATE`,
      [hash]
    );

    if (!rows.length)     { await client.query("ROLLBACK"); return { ok: false, reason: "invalid" }; }
    const token = rows[0];
    if (token.used_at)    { await client.query("ROLLBACK"); return { ok: false, reason: "used" }; }
    if (new Date(token.expires_at) < new Date()) {
      await client.query("ROLLBACK"); return { ok: false, reason: "expired" };
    }

    await client.query(
      "UPDATE email_verifications SET used_at = NOW() WHERE id = $1",
      [token.id]
    );
    await client.query(
      "UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1",
      [token.user_id]
    );

    await client.query("COMMIT");
    return { ok: true, userId: token.user_id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ── Password reset ────────────────────────────────────────────────────────────

/** Create a new password reset token for a user. Invalidates previous unused tokens. */
async function createPasswordResetToken(userId) {
  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MIN * 60_000);

  await db.query(
    "DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL",
    [userId]
  );
  await db.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hash, expiresAt]
  );

  return raw;
}

/**
 * Verify a password reset token.
 * Returns { ok: true, userId } or { ok: false, reason }.
 */
async function consumePasswordResetToken(raw) {
  const hash = hashToken(raw);
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT id, user_id, expires_at, used_at
       FROM password_resets
       WHERE token_hash = $1
       FOR UPDATE`,
      [hash]
    );

    if (!rows.length)     { await client.query("ROLLBACK"); return { ok: false, reason: "invalid" }; }
    const token = rows[0];
    if (token.used_at)    { await client.query("ROLLBACK"); return { ok: false, reason: "used" }; }
    if (new Date(token.expires_at) < new Date()) {
      await client.query("ROLLBACK"); return { ok: false, reason: "expired" };
    }

    await client.query(
      "UPDATE password_resets SET used_at = NOW() WHERE id = $1",
      [token.id]
    );

    await client.query("COMMIT");
    return { ok: true, userId: token.user_id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  generateToken,
  hashToken,
  createVerificationToken,
  consumeVerificationToken,
  createPasswordResetToken,
  consumePasswordResetToken,
  VERIFY_TTL_MIN,
  RESET_TTL_MIN,
};
