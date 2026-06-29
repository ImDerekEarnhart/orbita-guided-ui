"use strict";

const bcrypt  = require("bcryptjs");
const crypto  = require("node:crypto");

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 12;
const USERNAME_RE = /^[a-z0-9_-]{3,30}$/;

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function hashInviteCode(code) {
  return crypto.createHash("sha256").update(code.trim()).digest("hex");
}

/** Timing-safe comparison of two hex strings. */
function safeHexEqual(a, b) {
  try {
    const ba = Buffer.from(a.padEnd(64, "0").slice(0, 64), "hex");
    const bb = Buffer.from(b.padEnd(64, "0").slice(0, 64), "hex");
    return crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

function generateCsrfToken() {
  return crypto.randomBytes(32).toString("hex");
}

function verifyCsrfToken(session, token) {
  if (!session?.csrfToken || !token) return false;
  return safeHexEqual(session.csrfToken, token);
}

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

function normalizeUsername(username) {
  return (username || "").trim().toLowerCase();
}

function validateSignupInput({ email, username, password, confirmPassword }) {
  const errors = [];
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.push("A valid email address is required.");
  if (!username || !USERNAME_RE.test(normalizeUsername(username)))
    errors.push("Username must be 3–30 characters: letters, numbers, _ or -.");
  if (!password || password.length < MIN_PASSWORD_LENGTH)
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (password !== confirmPassword)
    errors.push("Passwords do not match.");
  return errors;
}

module.exports = {
  hashPassword,
  verifyPassword,
  hashInviteCode,
  safeHexEqual,
  generateCsrfToken,
  verifyCsrfToken,
  normalizeEmail,
  normalizeUsername,
  validateSignupInput,
  MIN_PASSWORD_LENGTH,
};
