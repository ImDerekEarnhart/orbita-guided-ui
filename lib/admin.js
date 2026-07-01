"use strict";

const db    = require("./db");
const quota = require("./quota");

/** Set an admin flag. */
async function setFlag(key, value, updatedBy) {
  await db.query(
    `INSERT INTO admin_flags (key, value, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (key) DO UPDATE
     SET value=$2, updated_at=NOW(), updated_by=$3`,
    [key, String(value), updatedBy || null]
  );
  // Bust the flag cache
  const qmod = require("./quota");
  qmod._flagCacheAt = 0;
}

/** List all admin flags. */
async function listFlags() {
  const { rows } = await db.query("SELECT * FROM admin_flags ORDER BY key");
  return rows;
}

/** Suspend a user account. */
async function suspendUser(userId, reason, adminId) {
  const { rowCount } = await db.query(
    `UPDATE users SET status='suspended', suspended_reason=$2, updated_at=NOW()
     WHERE id=$1 AND status='active'`,
    [userId, reason || "Suspended by administrator."]
  );
  if (adminId) {
    await db.query(
      `INSERT INTO audit_events (user_id, event_type, meta)
       VALUES ($1, 'admin_suspend_user', $2)`,
      [adminId, JSON.stringify({ target_user_id: userId, reason })]
    );
  }
  return rowCount > 0;
}

/** Reactivate a suspended or disabled user. */
async function reactivateUser(userId, adminId) {
  const { rowCount } = await db.query(
    `UPDATE users SET status='active', suspended_reason=NULL, updated_at=NOW()
     WHERE id=$1 AND status IN ('suspended','disabled')`,
    [userId]
  );
  if (adminId) {
    await db.query(
      `INSERT INTO audit_events (user_id, event_type, meta)
       VALUES ($1, 'admin_reactivate_user', $2)`,
      [adminId, JSON.stringify({ target_user_id: userId })]
    );
  }
  return rowCount > 0;
}

/** Delete a user's cases and data (proxy layer only; backend data separate). */
async function deleteUserData(userId, adminId) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: cases } = await client.query(
      "SELECT orbita_case_id FROM orbita_cases WHERE user_id=$1",
      [userId]
    );
    // Cancel and delete any pending/running jobs before removing records
    await client.query(
      `UPDATE run_jobs SET status='cancelled', completed_at=NOW()
       WHERE user_id=$1 AND status IN ('queued','running')`,
      [userId]
    );
    await client.query("DELETE FROM run_jobs WHERE user_id=$1", [userId]);
    await client.query(
      "DELETE FROM orbita_resources WHERE user_id=$1", [userId]
    );
    await client.query(
      "DELETE FROM orbita_cases WHERE user_id=$1", [userId]
    );
    await client.query(
      "DELETE FROM user_quota WHERE user_id=$1", [userId]
    );
    await client.query(
      "DELETE FROM email_verifications WHERE user_id=$1", [userId]
    );
    await client.query(
      "DELETE FROM password_resets WHERE user_id=$1", [userId]
    );
    await client.query(
      `UPDATE users SET status='deleted', deleted_at=NOW(),
       email=concat('deleted_', id, '@deleted'),
       username=concat('deleted_', id), updated_at=NOW()
       WHERE id=$1`,
      [userId]
    );
    if (adminId) {
      await client.query(
        `INSERT INTO audit_events (user_id, event_type, meta)
         VALUES ($1, 'admin_delete_user', $2)`,
        [adminId, JSON.stringify({ target_user_id: userId, case_count: cases.length })]
      );
    }
    await client.query("COMMIT");
    return { deletedCases: cases.map(c => c.orbita_case_id) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Block or unblock an IP. */
async function blockIp(ip, reason, expiresAt) {
  await db.query(
    `INSERT INTO ip_blocks (ip, reason, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (ip) DO UPDATE SET reason=$2, expires_at=$3, blocked_at=NOW()`,
    [ip, reason || null, expiresAt || null]
  );
}

async function unblockIp(ip) {
  await db.query("DELETE FROM ip_blocks WHERE ip=$1", [ip]);
}

async function isIpBlocked(ip) {
  const { rows } = await db.query(
    `SELECT 1 FROM ip_blocks
     WHERE ip=$1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [ip]
  );
  return rows.length > 0;
}

/** Usage summary for admin dashboard. */
async function getUsageSummary() {
  const [users, quota_, jobs, queue] = await Promise.all([
    db.query(`SELECT status, COUNT(*) AS n FROM users GROUP BY status`),
    db.query(`SELECT
      SUM(runs_today) AS runs_today,
      SUM(concurrent_runs) AS concurrent_runs,
      SUM(total_storage_bytes) AS total_storage_bytes
      FROM user_quota`),
    db.query(`SELECT status, COUNT(*) AS n FROM run_jobs
      WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY status`),
    db.query(`SELECT COUNT(*) AS n FROM run_jobs WHERE status IN ('queued','running')`),
  ]);
  return {
    users:    Object.fromEntries(users.rows.map(r => [r.status, parseInt(r.n)])),
    quota:    quota_.rows[0] || {},
    jobs_24h: Object.fromEntries(jobs.rows.map(r => [r.status, parseInt(r.n)])),
    queue_depth: parseInt(queue.rows[0].n, 10),
  };
}

/** List all users for admin. */
async function listUsers({ limit = 100, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.email, u.status, u.email_verified_at, u.created_at, u.last_login_at,
            q.runs_today, q.concurrent_runs, q.total_storage_bytes
     FROM users u
     LEFT JOIN user_quota q ON q.user_id = u.id
     WHERE u.status != 'deleted'
     ORDER BY u.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

module.exports = {
  setFlag,
  listFlags,
  suspendUser,
  reactivateUser,
  deleteUserData,
  blockIp,
  unblockIp,
  isIpBlocked,
  getUsageSummary,
  listUsers,
};
