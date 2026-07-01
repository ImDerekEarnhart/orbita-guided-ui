"use strict";

const PgBoss = require("pg-boss");
const db     = require("./db");
const quota  = require("./quota");

const ORBITA_API_BASE = (process.env.ORBITA_API_BASE || "").replace(/\/$/, "");
const ORBITA_API_USER = process.env.ORBITA_API_USERNAME || "";
const ORBITA_API_PASS = process.env.ORBITA_API_PASSWORD || "";
const BACKEND_AUTH    = "Basic " + Buffer.from(`${ORBITA_API_USER}:${ORBITA_API_PASS}`).toString("base64");

const JOB_NAME        = "orbita-run";
const RUN_TIMEOUT_MS  = 10 * 60_000;  // 10 minutes per run

let _boss = null;

async function getBoss() {
  if (_boss) return _boss;
  _boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.APP_ENV === "development" ? false : { rejectUnauthorized: false },
    schema: "pgboss",
    monitorStateIntervalMinutes: 1,
    maintenanceIntervalMinutes: 10,
    deleteAfterDays: 7,
    archiveFailedAfterSeconds: 3600,
    retentionDays: 7,
  });
  await _boss.start();
  console.log("[queue] pg-boss started");
  return _boss;
}

/**
 * Enqueue a discovery run job.
 * Returns the pg-boss job ID.
 */
async function enqueueRun(userId, orbitaCaseId, runOptions) {
  const boss = await getBoss();
  const jobId = await boss.send(JOB_NAME, {
    userId,
    orbitaCaseId,
    runOptions,
  }, {
    expireInSeconds: Math.floor(RUN_TIMEOUT_MS / 1000),
    retryLimit: 0,  // No automatic retries for scientific runs
    singletonKey: `user-run-${userId}`,  // One queued job per user at a time
  });
  return jobId;
}

/**
 * Start the job worker. Call once at server startup.
 * The worker processes one job at a time globally (enforced by pg-boss team size).
 */
async function startWorker() {
  const flags = await quota.getFlags();
  const globalMax = quota.flag(flags, "global_max_concurrent_runs", 5);

  const boss = await getBoss();
  await boss.work(JOB_NAME, {
    teamSize: globalMax,
    teamConcurrency: globalMax,
    teamRefill: true,
  }, processRunJob);

  console.log(`[queue] worker started (teamSize=${globalMax})`);
}

async function processRunJob(job) {
  const { userId, orbitaCaseId, runOptions } = job.data;

  // Mark run as running in our DB
  await db.query(
    `UPDATE run_jobs SET status='running', started_at=NOW(), pgboss_job_id=$1
     WHERE orbita_case_id=$2 AND user_id=$3 AND status='queued'
     ORDER BY created_at DESC LIMIT 1`,
    [job.id, orbitaCaseId, userId]
  );

  await quota.incrementConcurrentRuns(userId);

  let runId = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);

    const resp = await fetch(`${ORBITA_API_BASE}/cases/${encodeURIComponent(orbitaCaseId)}/run`, {
      method: "POST",
      headers: {
        Authorization: BACKEND_AUTH,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(runOptions),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const result = await resp.json();
    runId = result.id || result.run_id;

    if (resp.ok) {
      await db.query(
        `UPDATE run_jobs
         SET status='completed', result_json=$1, completed_at=NOW()
         WHERE orbita_case_id=$2 AND user_id=$3 AND status='running'`,
        [JSON.stringify(result), orbitaCaseId, userId]
      );
    } else {
      const errMsg = result.detail || result.error || `Backend returned HTTP ${resp.status}`;
      await db.query(
        `UPDATE run_jobs
         SET status='failed', error_message=$1, completed_at=NOW()
         WHERE orbita_case_id=$2 AND user_id=$3 AND status='running'`,
        [errMsg, orbitaCaseId, userId]
      );
    }
  } catch (err) {
    const errMsg = err.name === "AbortError" ? "Run timed out after 10 minutes." : err.message;
    await db.query(
      `UPDATE run_jobs
       SET status='failed', error_message=$1, completed_at=NOW()
       WHERE orbita_case_id=$2 AND user_id=$3 AND status='running'`,
      [errMsg, orbitaCaseId, userId]
    );
  } finally {
    await quota.finishRun(userId);
  }

  return runId;
}

/**
 * Look up a run job by run_id (our ID, not pg-boss ID).
 * Returns the run_jobs row or null.
 */
async function getRunJob(runId) {
  const { rows } = await db.query(
    "SELECT * FROM run_jobs WHERE id = $1",
    [runId]
  );
  return rows[0] || null;
}

/**
 * Look up the most recent run job for a user + case.
 */
async function getLatestRunJob(userId, orbitaCaseId) {
  const { rows } = await db.query(
    `SELECT * FROM run_jobs
     WHERE user_id=$1 AND orbita_case_id=$2
     ORDER BY created_at DESC LIMIT 1`,
    [userId, orbitaCaseId]
  );
  return rows[0] || null;
}

/** Create a run_jobs record when a run is enqueued. */
async function createRunJob(runId, userId, orbitaCaseId) {
  await db.query(
    `INSERT INTO run_jobs (id, user_id, orbita_case_id, status, timeout_at)
     VALUES ($1, $2, $3, 'queued', NOW() + INTERVAL '12 minutes')`,
    [runId, userId, orbitaCaseId]
  );
}

/** Cancel a queued/running job for a user. */
async function cancelRunJob(runId, userId) {
  const boss = await getBoss();
  const { rows } = await db.query(
    "SELECT pgboss_job_id FROM run_jobs WHERE id=$1 AND user_id=$2",
    [runId, userId]
  );
  if (rows[0]?.pgboss_job_id) {
    await boss.cancel(rows[0].pgboss_job_id).catch(() => {});
  }
  await db.query(
    `UPDATE run_jobs SET status='cancelled', completed_at=NOW()
     WHERE id=$1 AND user_id=$2 AND status IN ('queued','running')`,
    [runId, userId]
  );
}

/** Clean up stale jobs that passed their timeout. */
async function cleanupTimedOutJobs() {
  const { rows } = await db.query(
    `UPDATE run_jobs SET status='failed', error_message='Timed out', completed_at=NOW()
     WHERE status IN ('queued','running') AND timeout_at < NOW()
     RETURNING id, user_id`
  );
  for (const row of rows) {
    await quota.finishRun(row.user_id).catch(() => {});
    console.log(`[queue] timed out run ${row.id} for user ${row.user_id}`);
  }
}

module.exports = {
  getBoss,
  enqueueRun,
  startWorker,
  getRunJob,
  getLatestRunJob,
  createRunJob,
  cancelRunJob,
  cleanupTimedOutJobs,
};
