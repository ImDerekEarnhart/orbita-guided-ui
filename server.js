"use strict";

const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

// ── Environment ──────────────────────────────────────────────────────────────
const PORT              = parseInt(process.env.PORT || "3000", 10);
const ORBITA_API_BASE   = (process.env.ORBITA_API_BASE || "").replace(/\/$/, "");
const ORBITA_API_USER   = process.env.ORBITA_API_USERNAME || "";
const ORBITA_API_PASS   = process.env.ORBITA_API_PASSWORD || "";
const SESSION_SECRET    = process.env.ALPHA_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const INVITE_HASH       = process.env.ALPHA_INVITE_CODE_HASH || "";
const APP_ENV           = process.env.APP_ENV || "development";
const GIT_COMMIT        = process.env.GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || "unknown";
const VERSION           = process.env.npm_package_version || "1.0.0";
const MAX_UPLOAD_BYTES  = 100 * 1024 * 1024; // 100 MB
const SESSION_TTL_MS    = 8 * 60 * 60 * 1000; // 8 hours
const PROXY_TIMEOUT_MS  = 300_000; // 5 min for long discovery runs

// Backend Authorization header — never sent to browser
const BACKEND_AUTH = "Basic " + Buffer.from(`${ORBITA_API_USER}:${ORBITA_API_PASS}`).toString("base64");

// ── Validate config ──────────────────────────────────────────────────────────
if (!ORBITA_API_BASE) console.warn("[orbita-alpha] ORBITA_API_BASE not set — proxy will fail");
if (!INVITE_HASH)     console.warn("[orbita-alpha] ALPHA_INVITE_CODE_HASH not set — all logins will fail");

// ── App setup ────────────────────────────────────────────────────────────────
const app = express();

app.set("trust proxy", 1); // Railway sits behind a proxy

// Session
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: APP_ENV !== "development",
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashInviteCode(code) {
  return crypto.createHash("sha256").update(code.trim()).digest("hex");
}

function requireSession(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Session expired. Please log in again." });
  return res.redirect("/login");
}

function safeError(err) {
  const msg = String(err?.message || err || "An unexpected error occurred.");
  // Strip any path fragments, credentials, or stack traces
  return msg.replace(/\/[a-zA-Z0-9/_.-]{10,}/g, "[path]").replace(/Basic \S+/g, "[redacted]").slice(0, 300);
}

async function proxyToOrbita(req, res, backendPath) {
  if (!ORBITA_API_BASE) return res.status(503).json({ error: "Backend not configured." });

  const backendUrl = `${ORBITA_API_BASE}${backendPath}`;
  const isUpload = req.headers["content-type"]?.includes("multipart/form-data");

  // Build headers — never forward Authorization from client
  const headers = { Authorization: BACKEND_AUTH };
  if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
  if (req.headers["accept"]) headers["Accept"] = req.headers["accept"];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    let bodyToSend = undefined;

    if (!["GET", "HEAD"].includes(req.method)) {
      // Buffer the body with size enforcement
      const chunks = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_UPLOAD_BYTES) {
          res.status(413).json({ error: `File too large. Maximum upload size is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.` });
          return;
        }
        chunks.push(chunk);
      }
      bodyToSend = chunks.length ? Buffer.concat(chunks) : undefined;

      // Check available disk via /health before forwarding uploads
      if (isUpload) {
        try {
          const hRes = await fetch(`${ORBITA_API_BASE}/health`, { headers: { Authorization: BACKEND_AUTH }, signal: AbortSignal.timeout(5000) });
          const health = await hRes.json();
          if (health.status !== "ok") {
            res.status(503).json({ error: "The Orbita service is temporarily unavailable. Please try again shortly." });
            return;
          }
        } catch (_) { /* health check optional — proceed */ }
      }
    }

    const response = await fetch(backendUrl, {
      method: req.method,
      headers,
      body: bodyToSend,
      signal: controller.signal,
    });

    // Forward safe headers only — never expose internals
    const ct = response.headers.get("content-type");
    const cd = response.headers.get("content-disposition");
    res.status(response.status);
    if (ct) res.set("Content-Type", ct);
    if (cd) res.set("Content-Disposition", cd);

    // Stream response body
    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body);
      await pipeline(nodeStream, res);
    } else {
      res.end();
    }
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return res.status(504).json({ error: "The request timed out. Long discovery runs may take a few minutes — please wait and refresh the case page." });
    }
    console.error("[proxy error]", err.message);
    return res.status(502).json({ error: "Could not reach the Orbita backend. Please try again in a moment." });
  } finally {
    clearTimeout(timer);
  }
}

// ── Public routes (no session required) ──────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "orbita-guided-ui",
    version: VERSION,
    git_commit: GIT_COMMIT,
    environment: APP_ENV,
  });
});

// Login page (self-contained HTML)
app.get("/login", (req, res) => {
  if (req.session?.authenticated) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Rate-limited login submission
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait 15 minutes and try again." },
});

app.use(express.urlencoded({ extended: false, limit: "2kb" }));

app.post("/login", loginLimiter, (req, res) => {
  const code = (req.body.invite_code || "").trim();
  if (!code) return res.redirect("/login?error=1");

  const provided = hashInviteCode(code);
  if (!INVITE_HASH || !crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(INVITE_HASH.padEnd(64, "0").slice(0, 64), "hex"))) {
    return res.redirect("/login?error=1");
  }

  req.session.regenerate((err) => {
    if (err) return res.redirect("/login?error=1");
    req.session.authenticated = true;
    req.session.loginAt = Date.now();
    res.redirect("/");
  });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
});

// ── Protected static files ───────────────────────────────────────────────────
app.use(requireSession);
app.use(express.static(path.join(__dirname, "public")));

// ── API proxy routes ─────────────────────────────────────────────────────────
// Map /api/orbita/* → ORBITA_API_BASE/*

app.all("/api/orbita/*", async (req, res) => {
  // Strip /api/orbita prefix
  const backendPath = req.path.replace(/^\/api\/orbita/, "") || "/";
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  await proxyToOrbita(req, res, backendPath + qs);
});

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get("*", requireSession, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[orbita-alpha] ${APP_ENV} — http://localhost:${PORT}  commit=${GIT_COMMIT.slice(0, 7)}`);
});
