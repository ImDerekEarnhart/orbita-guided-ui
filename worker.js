"use strict";
// Standalone worker process — deploy as a separate Railway service.
// Processes queued discovery runs from pg-boss.
// Exposes a minimal /health HTTP endpoint so Railway's health check passes.
//
// Environment variables required (same as web service except PORT not needed):
//   DATABASE_URL, ORBITA_API_BASE, ORBITA_API_USERNAME, ORBITA_API_PASSWORD

const http  = require("http");
const db    = require("./lib/db");
const queue = require("./lib/queue");

const GIT_COMMIT = process.env.GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || "unknown";
const APP_ENV    = process.env.APP_ENV || "development";
const CLEANUP_INTERVAL_MS = 2 * 60_000;

if (!process.env.DATABASE_URL) {
  console.error("[worker] DATABASE_URL is required");
  process.exit(1);
}
if (!process.env.ORBITA_API_BASE) {
  console.error("[worker] ORBITA_API_BASE is required");
  process.exit(1);
}

// Verify ORBITA_API_BASE actually points at the Orbita research backend, not
// back at this app's own frontend. A misconfigured URL here makes every
// discovery run silently fail with "Unexpected token '<' ... is not valid
// JSON" once the worker starts POSTing to a route that doesn't exist on the
// frontend and gets HTML back instead of JSON.
async function assertBackendReachable() {
  const base = (process.env.ORBITA_API_BASE || "").replace(/\/$/, "");
  const url = `${base}/health`;
  let resp, body;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    body = await resp.json();
  } catch (err) {
    console.error(`[worker] ORBITA_API_BASE health check failed: could not reach ${url} (${err.message})`);
    process.exit(1);
  }
  if (!resp.ok) {
    console.error(`[worker] ORBITA_API_BASE health check failed: ${url} returned HTTP ${resp.status}`);
    process.exit(1);
  }
  if (body.service === "orbita-guided-ui") {
    console.error(
      `[worker] ORBITA_API_BASE (${base}) points at the guided-ui frontend, not the Orbita ` +
      `research backend. Fix the ORBITA_API_BASE env var on this service.`
    );
    process.exit(1);
  }
  if (!body.plan_schema) {
    console.error(
      `[worker] ORBITA_API_BASE (${base}) did not return the expected backend /health shape ` +
      `(missing plan_schema). Got: ${JSON.stringify(body).slice(0, 200)}`
    );
    process.exit(1);
  }
  console.log(`[worker] ORBITA_API_BASE verified: ${base} (backend git_commit=${(body.git_commit || "unknown").toString().slice(0, 7)})`);
}

async function start() {
  console.log(`[worker] starting — env=${APP_ENV} commit=${GIT_COMMIT.slice(0, 7)}`);

  await assertBackendReachable();

  try {
    await db.query("SELECT 1");
    console.log("[worker] PostgreSQL OK");
  } catch (err) {
    console.error("[worker] Cannot connect to PostgreSQL:", err.message);
    process.exit(1);
  }

  try {
    await queue.startWorker();
    console.log("[worker] pg-boss worker started");
  } catch (err) {
    console.error("[worker] Failed to start worker:", err.message);
    process.exit(1);
  }

  // Clean up timed-out jobs every 2 minutes
  const cleanupTimer = setInterval(() => {
    queue.cleanupTimedOutJobs().catch(err =>
      console.error("[worker] cleanup error:", err.message)
    );
  }, CLEANUP_INTERVAL_MS);

  // Minimal health check server so Railway's healthcheck passes
  const PORT = parseInt(process.env.PORT || "8080", 10);
  http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", worker: true }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(PORT, () => {
    console.log(`[worker] health check server on :${PORT}`);
  });

  console.log("[worker] ready");

  // Graceful shutdown — allow in-flight jobs to drain
  async function shutdown(signal) {
    console.log(`[worker] ${signal} — stopping cleanly`);
    clearInterval(cleanupTimer);
    // Give in-flight work up to 30 seconds before hard exit
    const deadline = setTimeout(() => process.exit(0), 30_000);
    deadline.unref();
    try {
      const boss = await queue.getBoss();
      await boss.stop({ graceful: true, timeout: 25_000 });
    } catch (_) {}
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

start();
