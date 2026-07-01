"use strict";

const db = require("./db");

// Staging bypasses per-user run/case ceilings for smoke testing.
// Global concurrency is still enforced as a safety valve.
const RUN_QUOTA_BYPASS = process.env.APP_ENV === "staging" || process.env.RUN_QUOTA_BYPASS === "true";

// ── Admin flags cache ─────────────────────────────────────────────────────────
// Refreshed every 60 seconds to avoid a DB hit on every request.
let _flagCache = {};
let _flagCacheAt = 0;
const FLAG_TTL_MS = 60_000;

async function getFlags() {
  if (Date.now() - _flagCacheAt < FLAG_TTL_MS) return _flagCache;
  try {
    const { rows } = await db.query("SELECT key, value FROM admin_flags");
    const m = {};
    for (const r of rows) m[r.key] = r.value;
    _flagCache = m;
    _flagCacheAt = Date.now();
  } catch (_) { /* use last known */ }
  return _flagCache;
}

function flag(flags, key, def) {
  const v = flags[key];
  if (v === undefined) return def;
  if (v === "true") return true;
  if (v === "false") return false;
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

/** Returns { allowed: false, reason: string } or { allowed: true }. */
async function checkRegistrationAllowed() {
  const flags = await getFlags();
  if (!flag(flags, "registrations_open", false))
    return { allowed: false, reason: "New registrations are temporarily paused. Please check back soon." };
  return { allowed: true };
}

async function checkUploadAllowed() {
  const flags = await getFlags();
  if (!flag(flags, "uploads_open", true))
    return { allowed: false, reason: "File uploads are temporarily paused for maintenance." };
  return { allowed: true };
}

async function checkRunAllowed() {
  const flags = await getFlags();
  if (!flag(flags, "runs_open", true))
    return { allowed: false, reason: "Discovery runs are temporarily paused for maintenance." };
  return { allowed: true };
}

/** Ensures user quota record exists, resets daily counter if date changed. */
async function ensureUserQuota(userId) {
  await db.query(
    `INSERT INTO user_quota (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  // Reset daily counter if date has changed
  await db.query(
    `UPDATE user_quota
     SET runs_today = 0, runs_today_date = CURRENT_DATE, updated_at = NOW()
     WHERE user_id = $1 AND runs_today_date < CURRENT_DATE`,
    [userId]
  );
}

/** Get current quota state for a user. */
async function getUserQuota(userId) {
  await ensureUserQuota(userId);
  const { rows } = await db.query(
    "SELECT * FROM user_quota WHERE user_id = $1",
    [userId]
  );
  return rows[0] || {};
}

/** Check if a new run is allowed for this user. Returns { allowed, reason }. */
async function checkRunQuota(userId) {
  const flags = await getFlags();
  const quota = await getUserQuota(userId);

  const maxRunsPerDay     = flag(flags, "max_runs_per_day",    50);
  const maxConcurrent     = flag(flags, "max_concurrent_runs", 1);
  const globalMaxConc     = flag(flags, "global_max_concurrent_runs", 5);

  if (!RUN_QUOTA_BYPASS) {
    if (quota.runs_today >= maxRunsPerDay)
      return { allowed: false, reason: `Daily run limit reached (${maxRunsPerDay} per day). Try again tomorrow.` };
    if (quota.concurrent_runs >= maxConcurrent)
      return { allowed: false, reason: "You already have a discovery run in progress. Wait for it to complete." };
  }

  // Global concurrency check
  const { rows } = await db.query(
    "SELECT COALESCE(SUM(concurrent_runs), 0) AS total FROM user_quota"
  );
  const globalConc = parseInt(rows[0].total, 10) || 0;
  if (globalConc >= globalMaxConc)
    return { allowed: false, reason: "The system is at capacity right now. Please try again in a few minutes." };

  return { allowed: true };
}

/** Check if user can create another case. */
async function checkCaseQuota(userId, currentCount) {
  const flags = await getFlags();
  const max = flag(flags, "max_cases_per_user", 50);
  if (RUN_QUOTA_BYPASS) return { allowed: true };
  if (currentCount >= max)
    return { allowed: false, reason: `Case limit reached (${max} maximum). Delete an existing case to create a new one.` };
  return { allowed: true };
}

/** Check if an uploaded file is within size limits. */
async function checkUploadSize(bytes, rowCount) {
  const flags = await getFlags();
  const maxBytes = flag(flags, "max_csv_bytes",  52_428_800);
  const maxRows  = flag(flags, "max_csv_rows",   250_000);
  if (bytes > maxBytes)
    return { allowed: false, reason: `File too large. Maximum is ${Math.round(maxBytes / 1_048_576)} MB.` };
  if (rowCount && rowCount > maxRows)
    return { allowed: false, reason: `Too many rows. Maximum is ${maxRows.toLocaleString()} rows.` };
  return { allowed: true };
}

/** Increment concurrent run counter (called when run starts). */
async function incrementConcurrentRuns(userId) {
  await db.query(
    `UPDATE user_quota SET concurrent_runs = concurrent_runs + 1, updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );
}

/** Decrement concurrent run counter and increment daily counter (called when run completes/fails). */
async function finishRun(userId) {
  await db.query(
    `UPDATE user_quota
     SET concurrent_runs = GREATEST(0, concurrent_runs - 1),
         runs_today      = runs_today + 1,
         updated_at      = NOW()
     WHERE user_id = $1`,
    [userId]
  );
}

/** Update storage usage for a user. */
async function updateStorageUsage(userId, deltaBytes) {
  await db.query(
    `UPDATE user_quota
     SET total_storage_bytes = GREATEST(0, total_storage_bytes + $2),
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId, deltaBytes]
  );
}

module.exports = {
  getFlags,
  flag,
  checkRegistrationAllowed,
  checkUploadAllowed,
  checkRunAllowed,
  checkRunQuota,
  checkCaseQuota,
  checkUploadSize,
  ensureUserQuota,
  getUserQuota,
  incrementConcurrentRuns,
  finishRun,
  updateStorageUsage,
};
