"use strict";

const express      = require("express");
const session      = require("express-session");
const rateLimit    = require("express-rate-limit");
const pgSession    = require("connect-pg-simple")(session);
const crypto       = require("node:crypto");
const path         = require("node:path");
const fs           = require("node:fs");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const db        = require("./lib/db");
const authLib   = require("./lib/auth");
const ownership = require("./lib/ownership");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT            = parseInt(process.env.PORT || "3000", 10);
const ORBITA_API_BASE = (process.env.ORBITA_API_BASE || "").replace(/\/$/, "");
const ORBITA_API_USER = process.env.ORBITA_API_USERNAME || "";
const ORBITA_API_PASS = process.env.ORBITA_API_PASSWORD || "";
const SESSION_SECRET  = process.env.SESSION_SECRET || process.env.ALPHA_SESSION_SECRET
  || crypto.randomBytes(32).toString("hex");
const APP_ENV         = process.env.APP_ENV || "development";
const GIT_COMMIT      = process.env.GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || "unknown";
const VERSION         = process.env.npm_package_version || "2.0.0";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const SESSION_TTL_MS   = 8 * 60 * 60 * 1000;
const PROXY_TIMEOUT_MS = 300_000;
const MAX_CASES_PER_USER = 20;

// Backend Authorization header — constructed server-side, never sent to browser
const BACKEND_AUTH = "Basic " + Buffer.from(`${ORBITA_API_USER}:${ORBITA_API_PASS}`).toString("base64");

if (!process.env.DATABASE_URL) { console.error("[orbita] DATABASE_URL is required"); process.exit(1); }
if (!ORBITA_API_BASE) console.warn("[orbita] ORBITA_API_BASE not set — proxy will fail");

// ── Helpers ───────────────────────────────────────────────────────────────────
function audit(userId, eventType, req, meta) {
  db.query(
    `INSERT INTO audit_events (user_id, event_type, ip, user_agent, meta)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId || null, eventType, req.ip,
     req.get("user-agent") || null,
     meta ? JSON.stringify(meta) : null]
  ).catch(err => console.error("[audit]", err.message));
}

function safeError(err) {
  return String(err?.message || err || "An unexpected error occurred.")
    .replace(/Basic \S+/g, "[redacted]").slice(0, 300);
}

// Cache static HTML files (avoids repeated disk reads)
const _htmlCache = {};
function getHtml(name) {
  if (!_htmlCache[name]) {
    _htmlCache[name] = fs.readFileSync(path.join(__dirname, "public", name), "utf8");
  }
  return _htmlCache[name];
}

function injectScript(html, js) {
  return html.replace("</head>", `<script>${js}</script></head>`);
}

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ── Session (PostgreSQL-backed — survives restarts) ───────────────────────────
app.use(session({
  store: new pgSession({
    pool: db,
    tableName: "session",
    pruneSessionInterval: 3600,  // prune expired sessions every hour
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: "orbita.sid",
  cookie: {
    httpOnly: true,
    secure: APP_ENV !== "development",
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/",
  },
}));

// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; font-src 'self'",
  });
  next();
});

// ── CSRF helpers ──────────────────────────────────────────────────────────────
function ensureCsrf(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = authLib.generateCsrfToken();
  }
  return req.session.csrfToken;
}

function checkCsrf(req, res, next) {
  const token = req.body?._csrf || req.get("x-csrf-token");
  if (!authLib.verifyCsrfToken(req.session, token)) {
    return res.status(403).send("Invalid or missing CSRF token.");
  }
  next();
}

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use("/auth", express.urlencoded({ extended: false, limit: "4kb" }));

// ── Rate limiters ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many attempts. Please wait 15 minutes." },
  skipSuccessfulRequests: true,
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many registrations from this IP." },
});

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Session expired. Please log in again." });
    return res.redirect("/login");
  }
  try {
    const { rows } = await db.query(
      "SELECT id, username, email, status FROM users WHERE id = $1",
      [req.session.userId]
    );
    if (!rows.length || rows[0].status !== "active") {
      req.session.destroy(() => {});
      if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Account disabled." });
      return res.redirect("/login?reason=disabled");
    }
    req.user = rows[0];
    next();
  } catch (err) {
    console.error("[requireAuth]", err.message);
    res.status(500).json({ error: "Authentication check failed." });
  }
}

// ── Public routes ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok", service: "orbita-guided-ui",
    version: VERSION, git_commit: GIT_COMMIT, environment: APP_ENV,
  });
});

app.get("/login", (req, res) => {
  if (req.session?.userId) return res.redirect("/");
  const csrf = ensureCsrf(req);
  res.send(injectScript(getHtml("login.html"), `window.__csrf=${JSON.stringify(csrf)};`));
});

app.get("/signup", (req, res) => {
  if (req.session?.userId) return res.redirect("/");
  const csrf = ensureCsrf(req);
  res.send(injectScript(getHtml("signup.html"), `window.__csrf=${JSON.stringify(csrf)};`));
});

// ── POST /auth/signup ─────────────────────────────────────────────────────────
app.post("/auth/signup", signupLimiter, checkCsrf, async (req, res) => {
  const email      = authLib.normalizeEmail(req.body.email || "");
  const username   = authLib.normalizeUsername(req.body.username || "");
  const password   = req.body.password || "";
  const confirm    = req.body.confirm_password || "";
  const inviteRaw  = (req.body.invite_code || "").trim();

  const errors = authLib.validateSignupInput({ email, username, password, confirmPassword: confirm });
  if (errors.length) return res.redirect(`/signup?error=${encodeURIComponent(errors[0])}`);
  if (!inviteRaw)    return res.redirect("/signup?error=An+invite+code+is+required.");

  const INVALID = "Invite+code+is+invalid%2C+expired%2C+or+already+used.";
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Lock the invitation row to prevent concurrent double-use
    const codeHash = authLib.hashInviteCode(inviteRaw);
    const { rows: invRows } = await client.query(
      `SELECT id, invited_email, expires_at, use_count, max_uses, status
       FROM invitations WHERE code_hash = $1 FOR UPDATE`,
      [codeHash]
    );
    if (!invRows.length) {
      await client.query("ROLLBACK");
      audit(null, "signup_invalid_invite", req);
      return res.redirect(`/signup?error=${INVALID}`);
    }
    const inv = invRows[0];
    if (inv.status !== "active"
      || (inv.expires_at && new Date(inv.expires_at) < new Date())
      || inv.use_count >= inv.max_uses) {
      await client.query("ROLLBACK");
      return res.redirect(`/signup?error=${INVALID}`);
    }
    if (inv.invited_email && inv.invited_email.toLowerCase() !== email) {
      await client.query("ROLLBACK");
      audit(null, "signup_invite_email_mismatch", req);
      return res.redirect(`/signup?error=${INVALID}`);
    }

    // Check uniqueness
    const { rows: dupe } = await client.query(
      "SELECT lower(email) = $1 AS dup_email, lower(username) = $2 AS dup_user FROM users WHERE lower(email) = $1 OR lower(username) = $2",
      [email, username]
    );
    for (const row of dupe) {
      if (row.dup_email) { await client.query("ROLLBACK"); return res.redirect("/signup?error=That+email+is+already+registered."); }
      if (row.dup_user)  { await client.query("ROLLBACK"); return res.redirect("/signup?error=That+username+is+already+taken."); }
    }

    // Create user
    const passwordHash = await authLib.hashPassword(password);
    const { rows: newRows } = await client.query(
      `INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id, username`,
      [email, username, passwordHash]
    );
    const newUser = newRows[0];

    // Mark invite used
    const newCount  = inv.use_count + 1;
    const newStatus = newCount >= inv.max_uses ? "exhausted" : "active";
    await client.query(
      `UPDATE invitations SET use_count=$1, used_at=NOW(), used_by_user_id=$2, status=$3 WHERE id=$4`,
      [newCount, newUser.id, newStatus, inv.id]
    );

    await client.query("COMMIT");
    audit(newUser.id, "signup", req);

    req.session.regenerate(err => {
      if (err) return res.redirect("/login");
      req.session.userId   = newUser.id;
      req.session.username = newUser.username;
      req.session.csrfToken = authLib.generateCsrfToken();
      res.redirect("/");
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[signup]", err.message);
    res.redirect("/signup?error=Registration+failed.+Please+try+again.");
  } finally {
    client.release();
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
app.post("/auth/login", loginLimiter, checkCsrf, async (req, res) => {
  const identifier = authLib.normalizeEmail(req.body.identifier || "");
  const password   = req.body.password || "";

  if (!identifier || !password) return res.redirect("/login?error=Invalid+credentials.");

  try {
    const { rows } = await db.query(
      `SELECT id, username, email, password_hash, status
       FROM users WHERE lower(email) = $1 OR lower(username) = $1`,
      [identifier]
    );
    // Always run bcrypt to prevent timing-based user enumeration
    const dummyHash = "$2a$12$KIXLzGNVD9oFP5AqA0AuUeeFHq5l8yUFST93xCVOFKJ8MxiVqW7Sm";
    const found = rows.length > 0;
    const valid = await authLib.verifyPassword(password, found ? rows[0].password_hash : dummyHash);

    if (!found || !valid) {
      audit(found ? rows[0].id : null, "login_failure", req);
      return res.redirect("/login?error=Invalid+credentials.");
    }
    const user = rows[0];
    if (user.status !== "active") {
      audit(user.id, "login_disabled", req);
      return res.redirect("/login?error=Account+is+disabled.+Contact+the+administrator.");
    }

    await db.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);
    audit(user.id, "login_success", req);

    req.session.regenerate(err => {
      if (err) return res.redirect("/login?error=Login+failed.");
      req.session.userId   = user.id;
      req.session.username = user.username;
      req.session.csrfToken = authLib.generateCsrfToken();
      res.redirect("/");
    });
  } catch (err) {
    console.error("[login]", err.message);
    res.redirect("/login?error=Login+failed.+Please+try+again.");
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
app.post("/auth/logout", (req, res) => {
  const userId = req.session?.userId;
  req.session.destroy(err => {
    if (err) console.error("[logout]", err.message);
    if (userId) audit(userId, "logout", req);
    res.clearCookie("orbita.sid");
    res.redirect("/login");
  });
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
app.get("/auth/me", requireAuth, (req, res) => {
  res.json({
    id:         req.user.id,
    username:   req.user.username,
    email:      req.user.email,
    csrf_token: ensureCsrf(req),
  });
});

// ── POST /auth/change-password ────────────────────────────────────────────────
app.post("/auth/change-password", requireAuth, express.json({ limit: "4kb" }), loginLimiter, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password)
    return res.status(400).json({ error: "current_password and new_password are required." });
  if (new_password.length < authLib.MIN_PASSWORD_LENGTH)
    return res.status(400).json({ error: `Password must be at least ${authLib.MIN_PASSWORD_LENGTH} characters.` });
  try {
    const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
    const valid = await authLib.verifyPassword(current_password, rows[0].password_hash);
    if (!valid) return res.status(403).json({ error: "Current password is incorrect." });
    const newHash = await authLib.hashPassword(new_password);
    await db.query("UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2", [newHash, req.user.id]);
    audit(req.user.id, "password_changed", req);
    res.json({ ok: true });
  } catch (err) {
    console.error("[change-password]", err.message);
    res.status(500).json({ error: "Failed to update password." });
  }
});

// ── Protected static assets ───────────────────────────────────────────────────
app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

// ── Backend proxy helpers ─────────────────────────────────────────────────────
async function bufferBody(req, res) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: `File too large. Max is ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB.` });
      return null;
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function buildProxyHeaders(req) {
  const h = { Authorization: BACKEND_AUTH };
  if (req.headers["content-type"]) h["Content-Type"] = req.headers["content-type"];
  if (req.headers["accept"])       h["Accept"]       = req.headers["accept"];
  return h;
}

async function proxyStream(req, res, backendPath, body) {
  if (!ORBITA_API_BASE) return res.status(503).json({ error: "Backend not configured." });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const response = await fetch(`${ORBITA_API_BASE}${backendPath}`, {
      method: req.method, headers: buildProxyHeaders(req),
      body: body?.length ? body : undefined,
      signal: controller.signal,
    });
    res.status(response.status);
    const ct = response.headers.get("content-type");
    const cd = response.headers.get("content-disposition");
    if (ct) res.set("Content-Type", ct);
    if (cd) res.set("Content-Disposition", cd);
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError" || err.name === "TimeoutError")
      return res.status(504).json({ error: "Request timed out. Check the case page." });
    console.error("[proxy stream]", err.message);
    return res.status(502).json({ error: "Could not reach the Orbita backend." });
  } finally { clearTimeout(timer); }
}

async function proxyJson(req, res, backendPath, body) {
  if (!ORBITA_API_BASE) { res.status(503).json({ error: "Backend not configured." }); return { status: 503, body: null }; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const response = await fetch(`${ORBITA_API_BASE}${backendPath}`, {
      method: req.method, headers: buildProxyHeaders(req),
      body: body?.length ? body : undefined,
      signal: controller.signal,
    });
    const ct   = response.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await response.json() : await response.text();
    res.status(response.status);
    if (ct) res.set("Content-Type", ct);
    if (typeof data === "object") res.json(data); else res.send(data);
    return { status: response.status, body: data };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") { res.status(504).json({ error: "Request timed out." }); return { status: 504, body: null }; }
    console.error("[proxy json]", err.message);
    res.status(502).json({ error: "Could not reach the Orbita backend." });
    return { status: 502, body: null };
  } finally { clearTimeout(timer); }
}

// ── Ownership guard ───────────────────────────────────────────────────────────
async function guardCase(req, res, next) {
  const caseId = req.params.caseId;
  if (!caseId) return res.status(400).json({ error: "Case ID is required." });
  req.orbitaCaseId = caseId;
  try {
    const owned = await ownership.checkCaseOwnership(req.user.id, caseId);
    if (!owned) {
      audit(req.user.id, "unauthorized_case_access", req, { case_id: caseId });
      return res.status(403).json({ error: "Access denied." });
    }
    next();
  } catch (err) {
    console.error("[guardCase]", err.message);
    res.status(500).json({ error: "Authorization check failed." });
  }
}

// ── API proxy routes ──────────────────────────────────────────────────────────

// Case list — filtered to this user's ownership
app.get("/api/orbita/cases", async (req, res) => {
  try {
    const userCases = await ownership.getUserCases(req.user.id);
    if (!userCases.length) return res.json([]);

    const ownedIds = new Set(userCases.map(c => c.orbita_case_id));

    // Fetch all cases from backend and filter (single round-trip)
    let backendAll = [];
    try {
      const r = await fetch(`${ORBITA_API_BASE}/cases`, {
        headers: { Authorization: BACKEND_AUTH },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) {
        const raw = await r.json();
        backendAll = Array.isArray(raw) ? raw : raw.cases || raw.items || [];
      }
    } catch (_) { /* fall back to DB-only data */ }

    const backendMap = {};
    for (const c of backendAll) { const id = c.case_id || c.id; if (id) backendMap[id] = c; }

    const result = userCases.map(oc => {
      const be = backendMap[oc.orbita_case_id] || {};
      return {
        case_id:    oc.orbita_case_id,
        name:       be.name  || oc.name  || "Untitled discovery",
        status:     be.status || "available",
        updated_at: be.updated_at || oc.created_at,
        goal:       be.goal || "",
      };
    });

    res.json(result);
  } catch (err) {
    console.error("[GET /cases]", err.message);
    res.status(500).json({ error: "Failed to load cases." });
  }
});

// Case creation — create on backend then record ownership
app.post("/api/orbita/cases", async (req, res) => {
  const userCases = await ownership.getUserCases(req.user.id);
  if (userCases.length >= MAX_CASES_PER_USER)
    return res.status(429).json({ error: `Case limit reached (${MAX_CASES_PER_USER} max).` });

  const body = await bufferBody(req, res);
  if (body === null) return;

  let parsedName = null;
  try { parsedName = JSON.parse(body.toString()).name || null; } catch (_) {}

  const { status, body: resp } = await proxyJson(req, res, "/cases", body);
  if (status >= 200 && status < 300 && resp) {
    const caseId = resp.case_id || resp.id;
    if (caseId) {
      await ownership.recordCase(req.user.id, caseId, parsedName).catch(err => {
        console.error("[ownership] case record failed:", err.message);
        audit(req.user.id, "case_ownership_record_failed", req, { case_id: caseId });
      });
      audit(req.user.id, "case_created", req, { case_id: caseId });
    }
  }
});

// Case detail
app.get("/api/orbita/cases/:caseId", guardCase, async (req, res) => {
  await proxyStream(req, res, `/cases/${encodeURIComponent(req.orbitaCaseId)}`);
});

// File upload
app.post("/api/orbita/cases/:caseId/files", guardCase, async (req, res) => {
  const body = await bufferBody(req, res);
  if (body === null) return;
  const { status, body: resp } = await proxyJson(req, res, `/cases/${encodeURIComponent(req.orbitaCaseId)}/files`, body);
  if (status >= 200 && status < 300 && resp) {
    const fileId = resp.file_id || resp.id;
    if (fileId) await ownership.recordResource(req.user.id, req.orbitaCaseId, "file", fileId).catch(console.error);
  }
});

// Compile plan
app.post("/api/orbita/cases/:caseId/compile", guardCase, async (req, res) => {
  const body = await bufferBody(req, res);
  if (body === null) return;
  const { status, body: resp } = await proxyJson(req, res, `/cases/${encodeURIComponent(req.orbitaCaseId)}/compile`, body);
  if (status >= 200 && status < 300 && resp) {
    const planId = resp.plan_id || resp.id || resp.plan?.plan_id;
    if (planId) await ownership.recordResource(req.user.id, req.orbitaCaseId, "plan", planId).catch(console.error);
  }
});

// Start run
app.post("/api/orbita/cases/:caseId/run", guardCase, async (req, res) => {
  const body = await bufferBody(req, res);
  if (body === null) return;
  const { status, body: resp } = await proxyJson(req, res, `/cases/${encodeURIComponent(req.orbitaCaseId)}/run`, body);
  if (status >= 200 && status < 300 && resp) {
    const runId = resp.id || resp.run_id;
    if (runId) {
      await ownership.recordResource(req.user.id, req.orbitaCaseId, "run", runId).catch(console.error);
      audit(req.user.id, "run_started", req, { case_id: req.orbitaCaseId, run_id: runId });
    }
  }
});

// Graph, claims, and any other case sub-resources
app.get("/api/orbita/cases/:caseId/*", guardCase, async (req, res) => {
  const sub = req.params[0] ? `/${req.params[0]}` : "";
  await proxyStream(req, res, `/cases/${encodeURIComponent(req.orbitaCaseId)}${sub}`);
});

// Run polling — ownership via resource table
app.get("/api/orbita/runs/:runId", async (req, res) => {
  const runId = req.params.runId;
  try {
    const owned = await ownership.checkResourceOwnership(req.user.id, "run", runId);
    if (!owned) {
      audit(req.user.id, "unauthorized_run_access", req, { run_id: runId });
      return res.status(403).json({ error: "Access denied." });
    }
    await proxyStream(req, res, `/runs/${encodeURIComponent(runId)}`);
  } catch (err) {
    console.error("[GET /runs]", err.message);
    res.status(500).json({ error: "Authorization check failed." });
  }
});

// Reject all other proxy paths to prevent bypass attempts
app.all("/api/orbita/*", (req, res) => {
  res.status(403).json({ error: "Operation not permitted." });
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  try {
    await db.query("SELECT 1");
    console.log("[orbita] PostgreSQL connection OK");
  } catch (err) {
    console.error("[orbita] Cannot connect to PostgreSQL:", err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`[orbita] ${APP_ENV} — http://localhost:${PORT}  commit=${GIT_COMMIT.slice(0, 7)}`);
  });
}

start();
