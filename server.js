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
const tokens    = require("./lib/tokens");
const emailLib  = require("./lib/email");
const emailVerification = require("./lib/emailVerification");
const quota     = require("./lib/quota");
const queue     = require("./lib/queue");
const admin     = require("./lib/admin");
const uploadSafety = require("./lib/uploadSafety");
const dataLifecycle = require("./lib/dataLifecycle");
const graphs = require("./lib/graphs");
const operatorProposals = require("./lib/operatorProposals");
const findingModules = require("./lib/findingModules");
const reviewTrace = require("./lib/reviewTrace");
const programmeState = require("./lib/programmeState");
const createDiscoveryGenomeRouter = require("./routes/discoveryGenome");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT            = parseInt(process.env.PORT || "3000", 10);
const ORBITA_API_BASE = (process.env.ORBITA_API_BASE || "").replace(/\/$/, "");
const ORBITA_API_USER = process.env.ORBITA_API_USERNAME || "";
const ORBITA_API_PASS = process.env.ORBITA_API_PASSWORD || "";
const SESSION_SECRET  = process.env.SESSION_SECRET || process.env.ALPHA_SESSION_SECRET
  || crypto.randomBytes(32).toString("hex");
const APP_ENV            = process.env.APP_ENV || "development";
const DEPLOYMENT_ENV     = process.env.RAILWAY_ENVIRONMENT_NAME || APP_ENV;
const IS_RAILWAY_PR_ENV  = /-pr-\d+$/.test(DEPLOYMENT_ENV);
const SESSION_TABLE      = process.env.SESSION_TABLE_NAME || (IS_RAILWAY_PR_ENV ? "session_pr_preview" : "session");
const GIT_COMMIT         = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "unknown";
const VERSION            = process.env.npm_package_version || "2.0.0";
const MAX_UPLOAD_BYTES   = uploadSafety.MAX_CSV_UPLOAD_BYTES;
const SESSION_TTL_MS     = 8 * 60 * 60 * 1000;
const PROXY_TIMEOUT_MS   = 300_000;
const CF_TURNSTILE_SECRET = process.env.CF_TURNSTILE_SECRET || "";

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

async function verifyTurnstile(token, ip) {
  if (process.env.CF_TURNSTILE_BYPASS === "true") return { ok: true };
  // Skip only in local development with no secret configured.
  // In staging/production: no secret = fail closed (no silent bypass).
  if (APP_ENV === "development" && !CF_TURNSTILE_SECRET) return { ok: true };
  if (!CF_TURNSTILE_SECRET) {
    console.error("[turnstile] CF_TURNSTILE_SECRET is not set — CAPTCHA required but not configured; blocking request");
    return { ok: false, reason: "captcha_not_configured" };
  }
  if (!token) {
    console.error("[turnstile] no cf-turnstile-response token in request body");
    return { ok: false, reason: "no_token" };
  }
  try {
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: CF_TURNSTILE_SECRET, response: token, remoteip: ip || "" }),
      signal: AbortSignal.timeout(5_000),
    });
    const data = await resp.json();
    if (data.success !== true) {
      console.error("[turnstile] siteverify rejected token:", JSON.stringify(data["error-codes"] || data));
    }
    return { ok: data.success === true };
  } catch (err) {
    console.error("[turnstile] siteverify request failed:", err.message);
    return { ok: false, reason: "verification_error" };
  }
}

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ── Session (PostgreSQL-backed — survives restarts) ───────────────────────────
app.use(session({
  store: new pgSession({
    pool: db,
    tableName: SESSION_TABLE,
    // PR environments can use a fresh or inherited database. Let the store
    // create an isolated, connector-compatible table instead of assuming the
    // production session migration already exists and has the expected shape.
    createTableIfMissing: IS_RAILWAY_PR_ENV || process.env.SESSION_CREATE_TABLE === "true",
    pruneSessionInterval: 3600,
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
const CF_SRC = CF_TURNSTILE_SECRET
  ? " https://challenges.cloudflare.com"
  : "";

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy":
      `default-src 'self'; script-src 'self' 'unsafe-inline'${CF_SRC}; ` +
      `style-src 'self' 'unsafe-inline'; img-src 'self' data:; ` +
      `connect-src 'self'${CF_SRC}; font-src 'self'; ` +
      `frame-src${CF_SRC || " 'none'"};`,
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

const verificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 3,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many verification email requests. Please wait an hour." },
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 3,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many password reset requests. Please wait an hour." },
});

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  // /auth/me is polled by the SPA and must answer with JSON, never an HTML redirect.
  const wantsJson = req.path.startsWith("/api/") || req.path === "/auth/me";
  if (!req.session?.userId) {
    if (wantsJson) return res.status(401).json({ error: "Session expired. Please log in again." });
    return res.redirect("/login");
  }
  try {
    const { rows } = await db.query(
      "SELECT id, username, email, status, email_verified_at, role FROM users WHERE id = $1",
      [req.session.userId]
    );
    if (!rows.length || rows[0].status !== "active") {
      req.session.destroy(() => {});
      if (wantsJson) return res.status(401).json({ error: "Account disabled." });
      return res.redirect("/login?reason=disabled");
    }
    req.user = rows[0];
    next();
  } catch (err) {
    console.error("[requireAuth]", err.message);
    res.status(500).json({ error: "Authentication check failed." });
  }
}

function requireEmailVerified(req, res, next) {
  if (!req.user?.email_verified_at) {
    return res.status(403).json({
      error: "Email address not verified. Please check your inbox or resend the verification link.",
      code: "EMAIL_NOT_VERIFIED",
    });
  }
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated." });
  try {
    // Verify role from DB on every request — username cannot grant admin access
    const { rows } = await db.query(
      "SELECT role FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!rows.length || rows[0].role !== "admin") {
      return res.status(403).json({ error: "Forbidden." });
    }
    next();
  } catch (err) {
    console.error("[requireAdmin]", err.message);
    res.status(500).json({ error: "Authorization check failed." });
  }
}

// ── Public routes ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok", service: "orbita-guided-ui",
    version: VERSION, git_commit: GIT_COMMIT, environment: DEPLOYMENT_ENV,
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

app.get("/verify-email", (req, res) => {
  const csrf = ensureCsrf(req);
  res.send(injectScript(getHtml("verify-email.html"), `window.__csrf=${JSON.stringify(csrf)};`));
});

app.get("/forgot-password", (req, res) => {
  const csrf = ensureCsrf(req);
  res.send(injectScript(getHtml("forgot-password.html"), `window.__csrf=${JSON.stringify(csrf)};`));
});

app.get("/reset-password", (req, res) => {
  const csrf = ensureCsrf(req);
  res.send(injectScript(getHtml("reset-password.html"), `window.__csrf=${JSON.stringify(csrf)};`));
});

// ── POST /auth/signup ─────────────────────────────────────────────────────────
app.post("/auth/signup", signupLimiter, checkCsrf, async (req, res) => {
  // IP block check
  if (await admin.isIpBlocked(req.ip)) {
    return res.redirect("/signup?error=Registration+is+not+available+from+this+location.");
  }

  // Registration open flag
  const regCheck = await quota.checkRegistrationAllowed();
  if (!regCheck.allowed) {
    return res.redirect(`/signup?error=${encodeURIComponent(regCheck.reason)}`);
  }

  // Turnstile CAPTCHA
  const turnstileToken = req.body["cf-turnstile-response"] || "";
  const captcha = await verifyTurnstile(turnstileToken, req.ip);
  if (!captcha.ok) {
    return res.redirect("/signup?error=CAPTCHA+verification+failed.+Please+try+again.");
  }

  const email    = authLib.normalizeEmail(req.body.email || "");
  const username = authLib.normalizeUsername(req.body.username || "");
  const password = req.body.password || "";
  const confirm  = req.body.confirm_password || "";

  const errors = authLib.validateSignupInput({ email, username, password, confirmPassword: confirm });
  if (errors.length) return res.redirect(`/signup?error=${encodeURIComponent(errors[0])}`);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows: dupe } = await client.query(
      "SELECT lower(email) = $1 AS dup_email, lower(username) = $2 AS dup_user FROM users WHERE lower(email) = $1 OR lower(username) = $2",
      [email, username]
    );
    for (const row of dupe) {
      if (row.dup_email) { await client.query("ROLLBACK"); return res.redirect("/signup?error=That+email+is+already+registered."); }
      if (row.dup_user)  { await client.query("ROLLBACK"); return res.redirect("/signup?error=That+username+is+already+taken."); }
    }

    const passwordHash = await authLib.hashPassword(password);
    const { rows: newRows } = await client.query(
      `INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id, username`,
      [email, username, passwordHash]
    );
    const newUser = newRows[0];

    await client.query("COMMIT");
    audit(newUser.id, "signup", req);

    const delivery = await emailVerification.deliverVerificationEmail({
      userId: newUser.id,
      username: newUser.username,
      email,
      action: "signup",
    });
    if (!delivery.ok) {
      audit(newUser.id, "verification_email_failed", req, {
        action: "signup",
        provider: delivery.provider || null,
        status_code: delivery.statusCode || null,
        reason: delivery.reason || "send_failed",
      });
      return res.redirect(`/verify-email?error=${emailVerification.EMAIL_SEND_FAILED_CODE}`);
    }

    res.redirect("/verify-email?sent=1");
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
  // IP block check
  if (await admin.isIpBlocked(req.ip)) {
    return res.redirect("/login?error=Login+is+not+available+from+this+location.");
  }

  // Turnstile CAPTCHA
  const turnstileToken = req.body["cf-turnstile-response"] || "";
  const captcha = await verifyTurnstile(turnstileToken, req.ip);
  if (!captcha.ok) {
    return res.redirect("/login?error=CAPTCHA+verification+failed.+Please+try+again.");
  }

  const identifier = authLib.normalizeEmail(req.body.identifier || "");
  const password   = req.body.password || "";

  if (!identifier || !password) return res.redirect("/login?error=Invalid+credentials.");

  try {
    const { rows } = await db.query(
      `SELECT id, username, email, password_hash, status, email_verified_at
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
      return res.redirect("/login?error=Invalid+credentials.");  // generic — don't reveal disabled state
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

// ── GET /auth/verify-email?token=... — consume link from email ────────────────
app.get("/auth/verify-email", async (req, res) => {
  const raw = (req.query.token || "").trim();
  if (!raw) return res.redirect("/verify-email?error=missing");
  try {
    const result = await tokens.consumeVerificationToken(raw);
    if (!result.ok) {
      audit(null, "verify_email_failed", req, { reason: result.reason });
      return res.redirect(`/verify-email?error=${result.reason}`);
    }
    audit(result.userId, "email_verified", req);
    // If user is already logged in, update their session view
    res.redirect("/login?verified=1");
  } catch (err) {
    console.error("[verify-email]", err.message);
    res.redirect("/verify-email?error=server");
  }
});

// ── POST /auth/resend-verification ───────────────────────────────────────────
app.post("/auth/resend-verification", verificationLimiter, checkCsrf, async (req, res) => {
  // Can be called by logged-in or logged-out user (provides email)
  let userId = req.session?.userId || null;
  let email  = "";
  let username = "";

  if (userId) {
    const { rows } = await db.query("SELECT email, username, email_verified_at FROM users WHERE id=$1", [userId]);
    if (!rows.length || rows[0].email_verified_at) {
      return res.redirect("/verify-email?error=already_verified");
    }
    email    = rows[0].email;
    username = rows[0].username;
  } else {
    email = authLib.normalizeEmail(req.body.email || "");
    if (!email) return res.redirect("/verify-email?error=missing_email");
    const { rows } = await db.query(
      "SELECT id, username, email_verified_at FROM users WHERE lower(email) = $1",
      [email]
    );
    if (!rows.length) {
      // Don't reveal whether email exists
      return res.redirect("/verify-email?sent=1");
    }
    if (rows[0].email_verified_at) return res.redirect("/verify-email?error=already_verified");
    userId   = rows[0].id;
    username = rows[0].username;
  }

  try {
    const delivery = await emailVerification.deliverVerificationEmail({
      userId,
      username,
      email,
      action: "resend",
    });
    if (!delivery.ok) {
      audit(userId, "verification_email_failed", req, {
        action: "resend",
        provider: delivery.provider || null,
        status_code: delivery.statusCode || null,
        reason: delivery.reason || "send_failed",
      });
      return res.redirect(`/verify-email?error=${emailVerification.EMAIL_SEND_FAILED_CODE}`);
    }
    audit(userId, "verification_resent", req);
  } catch (err) {
    console.error("[resend-verification]", err.message);
    return res.redirect(`/verify-email?error=${emailVerification.EMAIL_SEND_FAILED_CODE}`);
  }
  res.redirect("/verify-email?sent=1");
});

// ── POST /auth/forgot-password ────────────────────────────────────────────────
app.post("/auth/forgot-password", resetLimiter, checkCsrf, async (req, res) => {
  const email = authLib.normalizeEmail(req.body.email || "");
  // Always redirect with success to avoid user enumeration
  if (email) {
    try {
      const { rows } = await db.query(
        "SELECT id, username FROM users WHERE lower(email) = $1 AND status = 'active'",
        [email]
      );
      if (rows.length) {
        const user = rows[0];
        const resetToken = await tokens.createPasswordResetToken(user.id);
        const { subject, html, text } = emailLib.passwordResetEmail(user.username, resetToken);
        await emailLib.sendEmail({ to: email, subject, html, text });
        audit(user.id, "password_reset_requested", req);
      }
    } catch (err) {
      console.error("[forgot-password]", err.message);
    }
  }
  res.redirect("/forgot-password?sent=1");
});

// ── POST /auth/reset-password — consume token and set new password ────────────
app.post("/auth/reset-password", resetLimiter, checkCsrf, async (req, res) => {
  const raw         = (req.body.token || "").trim();
  const newPassword = req.body.new_password || "";
  const confirm     = req.body.confirm_password || "";

  if (!raw) return res.redirect("/reset-password?error=missing_token");

  if (newPassword.length < authLib.MIN_PASSWORD_LENGTH)
    return res.redirect(`/reset-password?token=${encodeURIComponent(raw)}&error=too_short`);
  if (newPassword !== confirm)
    return res.redirect(`/reset-password?token=${encodeURIComponent(raw)}&error=mismatch`);

  try {
    const result = await tokens.consumePasswordResetToken(raw);
    if (!result.ok) {
      return res.redirect(`/forgot-password?error=${result.reason}`);
    }
    const newHash = await authLib.hashPassword(newPassword);
    await db.query(
      "UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2",
      [newHash, result.userId]
    );
    audit(result.userId, "password_reset_completed", req);
    // Destroy any existing sessions for this user
    await db.query("DELETE FROM session WHERE sess::jsonb->>'userId' = $1", [result.userId]);
    res.redirect("/login?reset=1");
  } catch (err) {
    console.error("[reset-password]", err.message);
    res.redirect("/forgot-password?error=server");
  }
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
app.get("/auth/me", requireAuth, (req, res) => {
  res.json({
    id:             req.user.id,
    username:       req.user.username,
    email:          req.user.email,
    email_verified: Boolean(req.user.email_verified_at),
    csrf_token:     ensureCsrf(req),
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

// ── Self-service account deletion ─────────────────────────────────────────────
app.post("/api/user/delete", requireAuth, express.json({ limit: "4kb" }), async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "Password required to delete account." });
  try {
    const { rows } = await db.query("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
    const valid = await authLib.verifyPassword(password, rows[0].password_hash);
    if (!valid) return res.status(403).json({ error: "Incorrect password." });

    audit(req.user.id, "account_deletion_requested", req);
    const cases = await ownership.getUserCases(req.user.id);
    const backendResult = await dataLifecycle.deleteOwnedBackendCases({
      cases,
      deleteBackendCaseFn: deleteBackendCase,
    });
    if (!backendResult.ok) {
      audit(req.user.id, "account_backend_deletion_failed", req, {
        failed_case_id: backendResult.failed_case_id,
        backend_status: backendResult.status,
      });
      return res.status(502).json({
        ok: false,
        error: "Account deletion incomplete. Backend case deletion failed.",
        failed_case_id: backendResult.failed_case_id,
        deleted_backend_cases: backendResult.deleted.length,
      });
    }

    const { deletedCases } = await admin.deleteUserData(req.user.id, null);

    req.session.destroy(() => {});
    res.json({ ok: true, deleted_cases: deletedCases.length, deleted_backend_cases: backendResult.deleted.length });
  } catch (err) {
    console.error("[delete-account]", err.message);
    res.status(500).json({ error: "Account deletion failed." });
  }
});

// ── Protected static assets ───────────────────────────────────────────────────
app.get("/api/user/export", requireAuth, async (req, res) => {
  try {
    const data = await dataLifecycle.exportUserData({ db, userId: req.user.id });
    res.json(data);
  } catch (err) {
    console.error("[export-user]", err.message);
    res.status(500).json({ error: "User export failed." });
  }
});

app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    // The SPA shell and its script must never be served stale, or client-side
    // fixes silently fail to reach the browser.
    if (/\.(html|js)$/.test(filePath)) {
      res.set("Cache-Control", "no-cache, must-revalidate");
    }
  },
}));

// Discovery Genome: authenticated, email-verified, user-scoped operator contracts
// and blind tournaments. Write routes enforce the session CSRF token.
app.use(
  "/api/discovery-genome",
  requireEmailVerified,
  createDiscoveryGenomeRouter({ checkCsrf, audit })
);

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

async function fetchBackendJson(req, backendPath, body) {
  if (!ORBITA_API_BASE) return { status: 503, body: { error: "Backend not configured." }, contentType: "application/json" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const response = await fetch(`${ORBITA_API_BASE}${backendPath}`, {
      method: req.method, headers: buildProxyHeaders(req),
      body: body?.length ? body : undefined,
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();
    return { status: response.status, body: data, contentType };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError" || err.name === "TimeoutError")
      return { status: 504, body: { error: "Request timed out." }, contentType: "application/json" };
    console.error("[backend json]", err.message);
    return { status: 502, body: { error: "Could not reach the Orbita backend." }, contentType: "application/json" };
  } finally { clearTimeout(timer); }
}

function sendBackendJson(res, result) {
  res.status(result.status);
  if (result.contentType) res.set("Content-Type", result.contentType);
  if (typeof result.body === "object") res.json(result.body); else res.send(result.body);
}

async function deleteBackendCase(caseId) {
  return dataLifecycle.deleteBackendCase({
    baseUrl: ORBITA_API_BASE,
    authHeader: BACKEND_AUTH,
    caseId,
    timeoutMs: 10_000,
  });
}

async function cleanupFrontendCase(userId, caseId) {
  return dataLifecycle.cleanupFrontendCase({ db, userId, caseId });
}

async function recordResourceRequired(req, resourceType, resourceId) {
  try {
    await dataLifecycle.recordResourceOrFail({
      ownership,
      audit,
      req,
      userId: req.user.id,
      caseId: req.orbitaCaseId,
      resourceType,
      resourceId,
    });
  } catch (err) {
    console.error("[ownership] resource record failed:", err.message);
    throw new Error("Resource ownership recording failed.");
  }
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
  const result = await fetchBackendJson(req, backendPath, body);
  sendBackendJson(res, result);
  return { status: result.status, body: result.body };
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

// Graph ownership guard — mirrors guardCase.
async function guardGraph(req, res, next) {
  const graphId = req.params.graphId;
  if (!graphId) return res.status(400).json({ error: "Graph ID is required." });
  req.graphId = graphId;
  try {
    const owned = await graphs.checkGraphOwnership(req.user.id, graphId);
    if (!owned) {
      audit(req.user.id, "unauthorized_graph_access_registry", req, { graph_id: graphId });
      return res.status(403).json({ error: "Access denied." });
    }
    next();
  } catch (err) {
    console.error("[guardGraph]", err.message);
    res.status(500).json({ error: "Authorization check failed." });
  }
}

function shortCaseId(caseId) {
  const id = String(caseId || "");
  return id.length > 14 ? `${id.slice(0, 14)}...` : id;
}

async function enrichOperatorCaseLabels(userId, proposals) {
  const caseIds = [...new Set((proposals || []).flatMap(op =>
    op.supporting_case_ids || op.evidence?.supporting_case_ids || []
  ))].filter(Boolean);
  if (!caseIds.length) return proposals;
  const { rows } = await db.query(
    `SELECT c.orbita_case_id, c.name,
            d.backend_file_id, d.role, d.profile_json
       FROM orbita_cases c
       LEFT JOIN LATERAL (
         SELECT backend_file_id, role, profile_json
         FROM datasets
         WHERE user_id = c.user_id AND case_id = c.orbita_case_id
         ORDER BY created_at DESC
         LIMIT 1
       ) d ON true
      WHERE c.user_id = $1 AND c.orbita_case_id = ANY($2::text[])`,
    [userId, caseIds]
  );
  const labelsById = new Map(rows.map(row => {
    const name = row.name || shortCaseId(row.orbita_case_id);
    return [row.orbita_case_id, {
      case_id: row.orbita_case_id,
      label: `${name} - ${shortCaseId(row.orbita_case_id)}`,
      name,
      dataset_role: row.role || null,
      backend_file_id: row.backend_file_id || null,
    }];
  }));
  return proposals.map(op => {
    const ids = op.supporting_case_ids || op.evidence?.supporting_case_ids || [];
    const labelFor = id => labelsById.get(id) || {
      case_id: id,
      label: shortCaseId(id),
      name: null,
      dataset_role: null,
      backend_file_id: null,
    };
    const caseBreakdown = (op.case_breakdown || op.evidence?.case_breakdown || []).map(item => ({
      ...item,
      ...labelFor(item.case_id),
    }));
    return {
      ...op,
      case_labels: ids.map(labelFor),
      case_breakdown: caseBreakdown,
      evidence: op.evidence ? { ...op.evidence, case_breakdown: caseBreakdown } : op.evidence,
    };
  });
}

// ── Memory graph routes (Phase 2A: private graphs only) ──────────────────────

async function homeGraphForCase(userId, caseId) {
  const { rows } = await db.query(
    `SELECT graph_id FROM graph_case_links
     WHERE case_id = $1 AND user_id = $2 AND mode = 'home'
     ORDER BY created_at DESC LIMIT 1`,
    [caseId, userId]
  );
  return rows[0]?.graph_id || null;
}

async function compileAndSaveProgrammeState(userId, graphId) {
  const [operators, reviews, traceEvents, questions] = await Promise.all([
    operatorProposals.listProposals(userId, graphId),
    reviewTrace.listReviewItems(userId, graphId),
    reviewTrace.listTraceEvents(userId, graphId, 200),
    reviewTrace.listQuestions(userId, graphId),
  ]);
  const snapshot = programmeState.compileProgrammeState({
    graphId,
    operators: reviewTrace.attachOperatorReviews(operators, reviews),
    reviews,
    traceEvents,
    questions,
  });
  return programmeState.saveProgrammeStateSnapshot(userId, graphId, snapshot);
}

app.post("/api/graphs", express.json({ limit: "8kb" }), async (req, res) => {
  const { name, description, kind } = req.body || {};
  if (!name || typeof name !== "string" || !name.trim())
    return res.status(400).json({ error: "Graph name is required." });
  if (kind !== undefined && !["case", "project"].includes(kind))
    return res.status(400).json({ error: "kind must be 'case' or 'project'." });
  try {
    const graph = await graphs.createGraph(req.user.id, {
      name: name.trim().slice(0, 200),
      description: typeof description === "string" ? description.slice(0, 2000) : null,
      kind: kind || "project",
    });
    audit(req.user.id, "graph_created", req, { graph_id: graph.id, kind: graph.kind });
    res.status(201).json(graph);
  } catch (err) {
    console.error("[create-graph]", err.message);
    res.status(500).json({ error: "Failed to create graph." });
  }
});

app.get("/api/graphs", async (req, res) => {
  try {
    res.json(await graphs.getUserGraphs(req.user.id));
  } catch (err) {
    console.error("[list-graphs]", err.message);
    res.status(500).json({ error: "Failed to list graphs." });
  }
});

app.get("/api/graphs/:graphId", guardGraph, async (req, res) => {
  try {
    const graph = await graphs.getGraph(req.user.id, req.graphId);
    if (!graph) return res.status(404).json({ error: "Graph not found." });
    graph.cases = await graphs.getGraphCases(req.graphId);
    res.json(graph);
  } catch (err) {
    console.error("[get-graph]", err.message);
    res.status(500).json({ error: "Failed to load graph." });
  }
});

// Attach a case — requires ownership of BOTH the graph and the case.
app.post("/api/graphs/:graphId/cases/:caseId", guardGraph, guardCase, express.json({ limit: "4kb" }), async (req, res) => {
  const mode = req.body?.mode || "contributes";
  if (!["home", "contributes", "reference"].includes(mode))
    return res.status(400).json({ error: "mode must be home, contributes, or reference." });
  try {
    await graphs.attachCase(req.user.id, req.graphId, req.orbitaCaseId, mode);
    audit(req.user.id, "graph_case_attached", req, { graph_id: req.graphId, case_id: req.orbitaCaseId, mode });
    res.json({ ok: true, graph_id: req.graphId, case_id: req.orbitaCaseId, mode });
  } catch (err) {
    console.error("[attach-case]", err.message);
    res.status(500).json({ error: "Failed to attach case to graph." });
  }
});

// Graph-scoped claims — proxied to the backend scoped query.
app.get("/api/graphs/:graphId/claims", guardGraph, async (req, res) => {
  await proxyStream(req, res, `/graphs/${encodeURIComponent(req.graphId)}/claims`);
});

// Phase 2B: graph-scoped counterexamples — proxied, guardGraph enforces ownership.
app.get("/api/graphs/:graphId/counterexamples", guardGraph, async (req, res) => {
  await proxyStream(req, res, `/graphs/${encodeURIComponent(req.graphId)}/counterexamples`);
});

// Phase 2B: graph memory summary (observations, counterexamples, dataset relations).
app.get("/api/graphs/:graphId/summary", guardGraph, async (req, res) => {
  await proxyStream(req, res, `/graphs/${encodeURIComponent(req.graphId)}/summary`);
});

// Delete graph — cascades links only, never cases (cases keep their own lifecycle).
app.get("/api/graphs/:graphId/operators", guardGraph, async (req, res) => {
  try {
    const stored = await operatorProposals.listProposals(req.user.id, req.graphId);
    const reviews = await reviewTrace.listReviewItems(req.user.id, req.graphId, "operator");
    const proposals = await enrichOperatorCaseLabels(
      req.user.id,
      reviewTrace.attachOperatorReviews(stored, reviews)
    );
    res.json({ graph_id: req.graphId, operators: proposals });
  } catch (err) {
    console.error("[list-operators]", err.message);
    res.status(500).json({ error: "Failed to list operator proposals." });
  }
});

app.get("/api/graphs/:graphId/operators/:operatorId", guardGraph, async (req, res) => {
  try {
    const proposal = await operatorProposals.getProposal(req.user.id, req.graphId, req.params.operatorId);
    if (!proposal) return res.status(404).json({ error: "Operator proposal not found." });
    const review = await reviewTrace.getReviewItem(req.user.id, req.graphId, "operator", req.params.operatorId);
    const [enriched] = await enrichOperatorCaseLabels(
      req.user.id,
      reviewTrace.attachOperatorReviews([proposal], review ? [review] : [])
    );
    res.json(enriched);
  } catch (err) {
    console.error("[get-operator]", err.message);
    res.status(500).json({ error: "Failed to load operator proposal." });
  }
});

app.post("/api/graphs/:graphId/operators/propose", guardGraph, async (req, res) => {
  try {
    const backendReadReq = { method: "GET", headers: req.headers };
    const [claimsResult, counterexampleResult, summaryResult] = await Promise.all([
      fetchBackendJson(backendReadReq, `/graphs/${encodeURIComponent(req.graphId)}/claims`),
      fetchBackendJson(backendReadReq, `/graphs/${encodeURIComponent(req.graphId)}/counterexamples`),
      fetchBackendJson(backendReadReq, `/graphs/${encodeURIComponent(req.graphId)}/summary`),
    ]);
    if (claimsResult.status !== 200 || counterexampleResult.status !== 200 || summaryResult.status !== 200) {
      return res.status(502).json({ error: "Graph memory is unavailable for operator proposal." });
    }
    const graph = await graphs.getGraph(req.user.id, req.graphId);
    const cases = await graphs.getGraphCases(req.graphId);
    const datasets = [];
    for (const link of cases) {
      const rows = await graphs.getCaseDatasets(req.user.id, link.case_id);
      datasets.push(...rows.map(row => ({ ...row, case_id: link.case_id })));
    }
    const proposed = operatorProposals.proposeOperators({
      graphId: req.graphId,
      graph,
      cases,
      datasets,
      claims: claimsResult.body?.claims || [],
      counterexamples: counterexampleResult.body?.counterexamples || [],
      summary: summaryResult.body?.summary || {},
    });
    const graphCounterexamples = counterexampleResult.body?.counterexamples || [];
    if (graphCounterexamples.length) {
      await reviewTrace.createTraceEventOnce(req.user.id, req.graphId, {
        event_type: "counterexample_found",
        title: `Counterexamples recorded: ${graphCounterexamples.length}`,
        description: "Graph-scoped counterexamples were available during operator proposal generation.",
        source_type: "graph_counterexamples",
        source_ref_id: `${req.graphId}:${graphCounterexamples.length}`,
        counterexample_refs: graphCounterexamples.map(cx => cx.id || cx.counterexample_id).filter(Boolean),
        admissibility_effect: "narrows_question",
      }).catch(err => console.error("[counterexample trace event]", err.message));
    }
    const saved = await operatorProposals.replaceGraphProposals(req.user.id, req.graphId, proposed);
    const reviews = await reviewTrace.listReviewItems(req.user.id, req.graphId, "operator");
    const enriched = await enrichOperatorCaseLabels(req.user.id, reviewTrace.attachOperatorReviews(saved, reviews));
    await reviewTrace.createTraceEvent(req.user.id, req.graphId, {
      event_type: "operator_proposed",
      title: `Operator proposal pass: ${enriched.length} candidate${enriched.length === 1 ? "" : "s"}`,
      description: "Candidate discovery operators were generated for review. This does not execute or prove an operator.",
      source_type: "operator_proposals",
      source_ref_id: "phase2d_cross_domain_operator_heuristics",
      operator_refs: enriched.map(op => op.operator_id),
      admissibility_effect: enriched.length ? "permits_question" : "none",
    }).catch(err => console.error("[operator trace event]", err.message));
    audit(req.user.id, "graph_operator_proposals_generated", req, {
      graph_id: req.graphId,
      proposal_count: enriched.length,
    });
    res.json({
      graph_id: req.graphId,
      status: "candidate_operator_review_required",
      operators: enriched,
    });
  } catch (err) {
    console.error("[propose-operators]", err.message);
    res.status(500).json({ error: "Failed to propose discovery operators." });
  }
});

app.get("/api/graphs/:graphId/operators/:operatorId/review", guardGraph, async (req, res) => {
  try {
    const proposal = await operatorProposals.getProposal(req.user.id, req.graphId, req.params.operatorId);
    if (!proposal) return res.status(404).json({ error: "Operator proposal not found." });
    const review = await reviewTrace.getReviewItem(req.user.id, req.graphId, "operator", req.params.operatorId);
    res.json({ graph_id: req.graphId, operator_id: req.params.operatorId, review: review || null });
  } catch (err) {
    console.error("[get-operator-review]", err.message);
    res.status(500).json({ error: "Failed to load operator review." });
  }
});

app.patch("/api/graphs/:graphId/operators/:operatorId/review", guardGraph, express.json({ limit: "16kb" }), async (req, res) => {
  try {
    const proposal = await operatorProposals.getProposal(req.user.id, req.graphId, req.params.operatorId);
    if (!proposal) return res.status(404).json({ error: "Operator proposal not found." });
    const review = await reviewTrace.upsertReviewItem(req.user.id, req.graphId, "operator", req.params.operatorId, req.body || {});
    audit(req.user.id, "operator_review_updated", req, {
      graph_id: req.graphId,
      operator_id: req.params.operatorId,
      review_status: review.review_status,
    });
    res.json({ graph_id: req.graphId, operator_id: req.params.operatorId, review });
  } catch (err) {
    console.error("[patch-operator-review]", err.message);
    res.status(400).json({ error: safeError(err) });
  }
});

app.get("/api/graphs/:graphId/modules/:moduleId/review", guardGraph, async (req, res) => {
  try {
    const review = await reviewTrace.getReviewItem(req.user.id, req.graphId, "module", req.params.moduleId);
    res.json({ graph_id: req.graphId, module_id: req.params.moduleId, review: review || null });
  } catch (err) {
    console.error("[get-module-review]", err.message);
    res.status(500).json({ error: "Failed to load module review." });
  }
});

app.patch("/api/graphs/:graphId/modules/:moduleId/review", guardGraph, express.json({ limit: "16kb" }), async (req, res) => {
  try {
    const review = await reviewTrace.upsertReviewItem(req.user.id, req.graphId, "module", req.params.moduleId, req.body || {});
    audit(req.user.id, "module_review_updated", req, {
      graph_id: req.graphId,
      module_id: req.params.moduleId,
      review_status: review.review_status,
    });
    res.json({ graph_id: req.graphId, module_id: req.params.moduleId, review });
  } catch (err) {
    console.error("[patch-module-review]", err.message);
    res.status(400).json({ error: safeError(err) });
  }
});

app.get("/api/graphs/:graphId/trace", guardGraph, async (req, res) => {
  try {
    const events = await reviewTrace.listTraceEvents(req.user.id, req.graphId);
    res.json({ graph_id: req.graphId, events });
  } catch (err) {
    console.error("[list-trace]", err.message);
    res.status(500).json({ error: "Failed to load research trace." });
  }
});

app.post("/api/graphs/:graphId/trace", guardGraph, express.json({ limit: "16kb" }), async (req, res) => {
  try {
    const event = await reviewTrace.createTraceEvent(req.user.id, req.graphId, req.body || {});
    audit(req.user.id, "research_trace_event_created", req, { graph_id: req.graphId, event_type: event.event_type });
    res.status(201).json({ graph_id: req.graphId, event });
  } catch (err) {
    console.error("[create-trace]", err.message);
    res.status(400).json({ error: safeError(err) });
  }
});

app.get("/api/graphs/:graphId/trace/:eventId", guardGraph, async (req, res) => {
  try {
    const event = await reviewTrace.getTraceEvent(req.user.id, req.graphId, req.params.eventId);
    if (!event) return res.status(404).json({ error: "Trace event not found." });
    res.json({ graph_id: req.graphId, event });
  } catch (err) {
    console.error("[get-trace]", err.message);
    res.status(500).json({ error: "Failed to load trace event." });
  }
});

app.get("/api/graphs/:graphId/programme-state", guardGraph, async (req, res) => {
  try {
    const snapshot = await programmeState.latestProgrammeStateSnapshot(req.user.id, req.graphId);
    res.json({ graph_id: req.graphId, snapshot });
  } catch (err) {
    console.error("[programme-state]", err.message);
    res.status(500).json({ error: "Failed to load programme state." });
  }
});

app.post("/api/graphs/:graphId/programme-state/compile", guardGraph, async (req, res) => {
  try {
    const snapshot = await compileAndSaveProgrammeState(req.user.id, req.graphId);
    audit(req.user.id, "programme_state_compiled", req, {
      graph_id: req.graphId,
      snapshot_id: snapshot.id,
      trace_event_count: snapshot.source_trace_event_count,
    });
    res.json({ graph_id: req.graphId, snapshot });
  } catch (err) {
    console.error("[compile-programme-state]", err.message);
    res.status(500).json({ error: "Failed to compile programme state." });
  }
});

app.get("/api/graphs/:graphId/questions", guardGraph, async (req, res) => {
  try {
    const questions = await reviewTrace.listQuestions(req.user.id, req.graphId);
    res.json({ graph_id: req.graphId, questions });
  } catch (err) {
    console.error("[list-questions]", err.message);
    res.status(500).json({ error: "Failed to load admissible questions." });
  }
});

app.post("/api/graphs/:graphId/questions/generate", guardGraph, async (req, res) => {
  try {
    const snapshot = await compileAndSaveProgrammeState(req.user.id, req.graphId);
    const proposed = programmeState.generateQuestionsFromSnapshot(snapshot).map(question => ({
      ...question,
      programme_state_snapshot_id: snapshot.id,
      provenance: { ...(question.provenance || {}), source_snapshot_id: snapshot.id },
    }));
    const questions = await reviewTrace.saveGeneratedQuestions(req.user.id, req.graphId, proposed);
    await reviewTrace.createTraceEvent(req.user.id, req.graphId, {
      event_type: "next_question_candidate",
      title: `Generated ${questions.length} programme-state question candidate${questions.length === 1 ? "" : "s"}`,
      description: "Question generation used the compiled programme state. Cards remain review-needed and do not mutate claims.",
      source_type: "programme_state_snapshot",
      source_ref_id: snapshot.id,
      admissibility_effect: questions.length ? "permits_question" : "none",
    }).catch(err => console.error("[programme question trace event]", err.message));
    audit(req.user.id, "admissible_questions_generated", req, {
      graph_id: req.graphId,
      snapshot_id: snapshot.id,
      question_count: questions.length,
    });
    res.json({ graph_id: req.graphId, snapshot, questions });
  } catch (err) {
    console.error("[generate-questions]", err.message);
    res.status(500).json({ error: "Failed to generate admissible questions." });
  }
});

app.patch("/api/graphs/:graphId/questions/:questionId/review", guardGraph, express.json({ limit: "8kb" }), async (req, res) => {
  try {
    const question = await reviewTrace.updateQuestionReview(req.user.id, req.graphId, req.params.questionId, req.body || {});
    if (!question) return res.status(404).json({ error: "Question not found." });
    audit(req.user.id, "admissible_question_review_updated", req, {
      graph_id: req.graphId,
      question_id: req.params.questionId,
      review_status: question.review_status,
    });
    res.json({ graph_id: req.graphId, question });
  } catch (err) {
    console.error("[patch-question-review]", err.message);
    res.status(400).json({ error: safeError(err) });
  }
});

app.delete("/api/graphs/:graphId", guardGraph, async (req, res) => {
  try {
    const result = await graphs.deleteGraph(req.user.id, req.graphId);
    audit(req.user.id, "graph_deleted", req, { graph_id: req.graphId, links_removed: result.links_removed });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[delete-graph]", err.message);
    res.status(500).json({ error: "Graph deletion failed." });
  }
});

// Graph export — registry metadata + linked cases/datasets (no other users' data).
app.get("/api/graphs/:graphId/export", guardGraph, async (req, res) => {
  try {
    const graph = await graphs.getGraph(req.user.id, req.graphId);
    if (!graph) return res.status(404).json({ error: "Graph not found." });
    const cases = await graphs.getGraphCases(req.graphId);
    const datasets = [];
    for (const link of cases) {
      const rows = await graphs.getCaseDatasets(req.user.id, link.case_id);
      datasets.push(...rows.map(d => ({ ...d, case_id: link.case_id })));
    }
    // Phase 2B: backend memory summary (observation/counterexample counts,
    // dataset relations). Enrichment only — export still succeeds without it.
    let memorySummary = null;
    try {
      const result = await fetchBackendJson(req, `/graphs/${encodeURIComponent(req.graphId)}/summary`);
      if (result.status === 200 && result.body && typeof result.body === "object")
        memorySummary = result.body.summary || null;
    } catch (err) {
      console.error("[export-graph] memory summary unavailable:", err.message);
    }
    res.json({
      exported_at: new Date().toISOString(),
      graph: {
        id: graph.id, name: graph.name, description: graph.description,
        scope: graph.scope, kind: graph.kind, created_at: graph.created_at,
        policy: {
          min_verdict: graph.min_verdict,
          require_manual_approval: graph.require_manual_approval,
          allow_provisional: graph.allow_provisional,
        },
      },
      cases,
      datasets,
      memory_summary: memorySummary,
      links: {
        claims: `/api/graphs/${encodeURIComponent(graph.id)}/claims`,
        counterexamples: `/api/graphs/${encodeURIComponent(graph.id)}/counterexamples`,
        summary: `/api/graphs/${encodeURIComponent(graph.id)}/summary`,
        operators: `/api/graphs/${encodeURIComponent(graph.id)}/operators`,
        trace: `/api/graphs/${encodeURIComponent(graph.id)}/trace`,
        programme_state: `/api/graphs/${encodeURIComponent(graph.id)}/programme-state`,
        questions: `/api/graphs/${encodeURIComponent(graph.id)}/questions`,
      },
    });
  } catch (err) {
    console.error("[export-graph]", err.message);
    res.status(500).json({ error: "Graph export failed." });
  }
});

// ── API proxy routes ──────────────────────────────────────────────────────────

// Case list — filtered to this user's ownership
app.get("/api/orbita/cases", async (req, res) => {
  try {
    const userCases = await ownership.getUserCases(req.user.id);
    if (!userCases.length) return res.json([]);

    const ownedIds = new Set(userCases.map(c => c.orbita_case_id));

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

// Case creation — quota-checked, then proxy
app.post("/api/orbita/cases", requireEmailVerified, async (req, res) => {
  const uploadCheck = await quota.checkUploadAllowed();
  if (!uploadCheck.allowed) return res.status(503).json({ error: uploadCheck.reason });

  const userCases = await ownership.getUserCases(req.user.id);
  const caseCheck = await quota.checkCaseQuota(req.user.id, userCases.length);
  if (!caseCheck.allowed) return res.status(429).json({ error: caseCheck.reason });

  const body = await bufferBody(req, res);
  if (body === null) return;

  let parsedName = null;
  let requestedGraphId = null;
  try {
    const parsed = JSON.parse(body.toString());
    parsedName = parsed.name || null;
    requestedGraphId = parsed.graph_id || null;
  } catch (_) {}

  // Graph scope is validated BEFORE the backend case exists — never widen implicitly.
  if (requestedGraphId) {
    const ownsGraph = await graphs.checkGraphOwnership(req.user.id, requestedGraphId).catch(() => false);
    if (!ownsGraph) {
      audit(req.user.id, "unauthorized_graph_access_registry", req, { graph_id: requestedGraphId });
      return res.status(403).json({ error: "Access denied." });
    }
  }

  const backendResult = await fetchBackendJson(req, "/cases", body);
  const resp = backendResult.body;
  if (backendResult.status >= 200 && backendResult.status < 300 && resp) {
    const caseId = resp.case_id || resp.id;
    if (caseId) {
      try {
        await ownership.recordCase(req.user.id, caseId, parsedName);
        // Home graph: user's chosen graph, or a fresh private case graph.
        let graphId = requestedGraphId;
        if (!graphId) {
          const graph = await graphs.createGraph(req.user.id, {
            name: parsedName || "Untitled discovery",
            kind: "case",
          });
          graphId = graph.id;
        }
        await graphs.attachCase(req.user.id, graphId, caseId, "home");
        resp.graph_id = graphId;
        await reviewTrace.createTraceEvent(req.user.id, graphId, {
          event_type: "case_created",
          title: `Case created: ${parsedName || shortCaseId(caseId)}`,
          description: "A case was created and linked to this memory graph.",
          case_id: caseId,
          source_type: "case",
          source_ref_id: caseId,
          admissibility_effect: "none",
        }).catch(err => console.error("[case trace event]", err.message));
      } catch (err) {
        console.error("[ownership/graph] case record failed:", err.message);
        audit(req.user.id, "case_ownership_record_failed", req, { case_id: caseId });
        await deleteBackendCase(caseId).catch(() => {});
        return res.status(500).json({ error: "Case ownership recording failed. Please retry." });
      }
      await db.query(
        `INSERT INTO user_quota (user_id, total_cases) VALUES ($1, 1)
         ON CONFLICT (user_id) DO UPDATE SET total_cases = user_quota.total_cases + 1`,
        [req.user.id]
      ).catch(() => {});
      audit(req.user.id, "case_created", req, { case_id: caseId });
    }
  }
  sendBackendJson(res, backendResult);
});

// Case detail
app.get("/api/orbita/cases/:caseId", guardCase, async (req, res) => {
  await proxyStream(req, res, `/cases/${encodeURIComponent(req.orbitaCaseId)}`);
});

// Case deletion (self-service)
app.delete("/api/orbita/cases/:caseId", guardCase, async (req, res) => {
  const caseId = req.orbitaCaseId;
  const userId = req.user.id;
  try {
    const backendResult = await deleteBackendCase(caseId);
    if (!backendResult.ok) {
      audit(userId, "case_backend_delete_failed", req, {
        case_id: caseId,
        backend_status: backendResult.status,
      });
      return res.status(502).json({
        ok: false,
        error: "Case deletion incomplete. Backend deletion failed.",
        backend_status: backendResult.status,
      });
    }

    await cleanupFrontendCase(userId, caseId);

    audit(userId, "case_deleted", req, { case_id: caseId });
    res.json({ ok: true, backend: backendResult.body });
  } catch (err) {
    console.error("[delete-case]", err.message);
    res.status(500).json({ error: "Case deletion failed." });
  }
});

// File upload — quota-checked
app.post("/api/orbita/cases/:caseId/files", guardCase, requireEmailVerified, async (req, res) => {
  const uploadCheck = await quota.checkUploadAllowed();
  if (!uploadCheck.allowed) return res.status(503).json({ error: uploadCheck.reason });

  const body = await bufferBody(req, res);
  if (body === null) return;

  const validation = uploadSafety.validateCsvUpload({ headers: req.headers, body });
  if (!validation.ok) {
    audit(req.user.id, "upload_rejected", req, { case_id: req.orbitaCaseId, reason: validation.error });
    return res.status(validation.status).json({ error: validation.error });
  }

  const sizeCheck = await quota.checkUploadSize(validation.bytes, validation.rowCount);
  if (!sizeCheck.allowed) return res.status(413).json({ error: sizeCheck.reason });

  // Dataset role (Phase 2A) — optional query param, validated against the registry enum.
  const datasetRole = req.query.role ? String(req.query.role) : "primary";
  if (!["primary", "confirmation", "counterexample", "regime", "benchmark"].includes(datasetRole)) {
    return res.status(400).json({ error: "Invalid dataset role." });
  }

  const backendResult = await fetchBackendJson(req, `/cases/${encodeURIComponent(req.orbitaCaseId)}/files`, body);
  const resp = backendResult.body;
  if (backendResult.status >= 200 && backendResult.status < 300 && resp) {
    const fileId = resp.file_id || resp.id;
    if (fileId) {
      try {
        await recordResourceRequired(req, "file", fileId);
        // Dataset registry row — required, same no-swallow rule as resource ownership.
        const { rows: homeLink } = await db.query(
          `SELECT graph_id FROM graph_case_links WHERE case_id = $1 AND user_id = $2 AND mode = 'home' LIMIT 1`,
          [req.orbitaCaseId, req.user.id]
        );
        const graphId = homeLink[0]?.graph_id || null;
        await graphs.recordDataset(req.user.id, {
          caseId: req.orbitaCaseId,
          graphId,
          backendFileId: fileId,
          role: datasetRole,
          profile: resp.profile_json || resp.profile || null,
          sha256: resp.sha256 || null,
          sizeBytes: validation.bytes ?? null,
        });
        if (graphId) {
          await reviewTrace.createTraceEvent(req.user.id, graphId, {
            event_type: "dataset_added",
            title: `Dataset uploaded (${datasetRole})`,
            description: "A dataset was uploaded and recorded in the project registry.",
            case_id: req.orbitaCaseId,
            source_type: "file",
            source_ref_id: fileId,
            evidence_refs: [fileId],
            admissibility_effect: "none",
          }).catch(err => console.error("[dataset trace event]", err.message));
        }
      } catch (err) {
        console.error("[dataset-registry]", err.message);
        audit(req.user.id, "dataset_registry_record_failed", req, { case_id: req.orbitaCaseId, file_id: fileId });
        return res.status(500).json({ error: "Resource ownership recording failed." });
      }
    }
  }
  sendBackendJson(res, backendResult);
});

// Compile plan
app.post("/api/orbita/cases/:caseId/compile", guardCase, requireEmailVerified, async (req, res) => {
  const body = await bufferBody(req, res);
  if (body === null) return;
  const backendResult = await fetchBackendJson(req, `/cases/${encodeURIComponent(req.orbitaCaseId)}/compile`, body);
  const resp = backendResult.body;
  if (backendResult.status >= 200 && backendResult.status < 300 && resp) {
    const planId = resp.plan_id || resp.id || resp.plan?.plan_id;
    if (planId) {
      try {
        await recordResourceRequired(req, "plan", planId);
      } catch (_) {
        return res.status(500).json({ error: "Resource ownership recording failed." });
      }
    }
  }
  sendBackendJson(res, backendResult);
});

// Start run — now async via job queue
app.post("/api/orbita/cases/:caseId/run", guardCase, requireEmailVerified, express.json({ limit: "4kb" }), async (req, res) => {
  const runCheck = await quota.checkRunAllowed();
  if (!runCheck.allowed) return res.status(503).json({ error: runCheck.reason });

  await quota.ensureUserQuota(req.user.id);
  const quotaCheck = await quota.checkRunQuota(req.user.id);
  if (!quotaCheck.allowed) return res.status(429).json({ error: quotaCheck.reason });

  const runOptions = { ...(req.body || {}) };
  const runId = crypto.randomUUID();

  try {
    if (!runOptions.graph_id) {
      const { rows: homeLink } = await db.query(
        `SELECT graph_id FROM graph_case_links
         WHERE case_id = $1 AND user_id = $2 AND mode = 'home'
         ORDER BY created_at DESC LIMIT 1`,
        [req.orbitaCaseId, req.user.id]
      );
      if (homeLink[0]?.graph_id) runOptions.graph_id = homeLink[0].graph_id;
    }
    await queue.createRunJob(runId, req.user.id, req.orbitaCaseId);
    await recordResourceRequired(req, "run", runId);
    await queue.enqueueRun(req.user.id, req.orbitaCaseId, runOptions);
    audit(req.user.id, "run_queued", req, { case_id: req.orbitaCaseId, run_id: runId });
    res.json({ run_id: runId, status: "queued" });
  } catch (err) {
    console.error("[run]", err.message);
    await db.query("DELETE FROM run_jobs WHERE id=$1 AND user_id=$2 AND status='queued'", [runId, req.user.id]).catch(() => {});
    await db.query(
      "DELETE FROM orbita_resources WHERE user_id=$1 AND resource_type='run' AND resource_id=$2",
      [req.user.id, runId],
    ).catch(() => {});
    res.status(500).json({ error: "Failed to queue run." });
  }
});

// Cancel run
app.post("/api/orbita/cases/:caseId/runs/:runId/cancel", guardCase, async (req, res) => {
  const runId = req.params.runId;
  try {
    const owned = await ownership.checkResourceOwnership(req.user.id, "run", runId);
    if (!owned) return res.status(403).json({ error: "Access denied." });
    await queue.cancelRunJob(runId, req.user.id);
    audit(req.user.id, "run_cancelled", req, { run_id: runId });
    res.json({ ok: true });
  } catch (err) {
    console.error("[cancel-run]", err.message);
    res.status(500).json({ error: "Failed to cancel run." });
  }
});

// Phase 2D-A finding summaries — group raw findings into readable candidate
// modules with scientific warning badges. Read-only presentation layer:
// computed on the fly from backend data, never mutates claims or verdicts.
app.get("/api/orbita/cases/:caseId/modules", guardCase, async (req, res) => {
  if (!ORBITA_API_BASE) return res.status(503).json({ error: "Backend not configured." });
  try {
    const [detailResult, claimsResult] = await Promise.all([
      fetchBackendJson({ method: "GET", headers: {} }, `/cases/${encodeURIComponent(req.orbitaCaseId)}`),
      fetchBackendJson({ method: "GET", headers: {} }, `/cases/${encodeURIComponent(req.orbitaCaseId)}/claims`),
    ]);
    if (detailResult.status !== 200 && claimsResult.status !== 200) {
      return res.status(502).json({ error: "Could not load case data from the backend." });
    }
    const runs = detailResult.status === 200 ? (detailResult.body?.runs || []) : [];
    const lastRun = runs[runs.length - 1];
    const findings = lastRun?.result?.findings || [];
    const claims = claimsResult.status === 200 ? (claimsResult.body?.claims || []) : [];
    const moduleSummary = findingModules.buildFindingModules({ findings, claims });
    const graphId = await homeGraphForCase(req.user.id, req.orbitaCaseId).catch(() => null);
    if (graphId && moduleSummary.modules.length) {
      await reviewTrace.createTraceEventOnce(req.user.id, graphId, {
        event_type: "module_formed",
        title: `Finding modules available: ${moduleSummary.modules.length}`,
        description: `Grouped ${moduleSummary.total_findings} findings into ${moduleSummary.modules.length} reviewable modules.`,
        case_id: req.orbitaCaseId,
        source_type: "case_modules",
        source_ref_id: `${req.orbitaCaseId}:${moduleSummary.modules.length}:${moduleSummary.total_findings}`,
        module_refs: moduleSummary.modules.map(m => m.id),
        admissibility_effect: "permits_question",
      }).catch(err => console.error("[module trace event]", err.message));
      const artifactModules = moduleSummary.modules.filter(m =>
        (m.warning_badges || []).some(badge => /artifact|derived|near-copy|leakage/i.test(badge))
      );
      if (artifactModules.length) {
        await reviewTrace.createTraceEventOnce(req.user.id, graphId, {
          event_type: "artifact_warning",
          title: `Artifact warnings in ${artifactModules.length} module${artifactModules.length === 1 ? "" : "s"}`,
          description: "Derived, near-copy, leakage, or artifact-risk warnings were raised in finding modules.",
          case_id: req.orbitaCaseId,
          source_type: "case_artifact_modules",
          source_ref_id: `${req.orbitaCaseId}:artifact:${artifactModules.map(m => m.id).sort().join(",")}`,
          module_refs: artifactModules.map(m => m.id),
          admissibility_effect: "blocks_question",
        }).catch(err => console.error("[artifact trace event]", err.message));
      }
    }
    res.json(moduleSummary);
  } catch (err) {
    console.error("[case-modules]", err.message);
    res.status(500).json({ error: "Failed to build finding modules." });
  }
});

// Claim history/impact — proxied for drawer links inside the graph viewer.
// Case-scoped: verifies the claim actually belongs to a case the requester owns
// before proxying, by checking it against the backend's own claims list for
// that case. Prevents pulling any other user's claim by ID (IDOR). Registered
// BEFORE the generic wildcard below, since Express matches route order and the
// wildcard would otherwise swallow this more specific path first.
app.get("/api/orbita/cases/:caseId/claims/:claimId/:sub", guardCase, async (req, res) => {
  const { claimId, sub } = req.params;
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(claimId) || !["history", "impact"].includes(sub)) {
    return res.status(400).json({ error: "Invalid claim path." });
  }
  if (!ORBITA_API_BASE) return res.status(503).json({ error: "Backend not configured." });
  try {
    const listResp = await fetch(`${ORBITA_API_BASE}/cases/${encodeURIComponent(req.orbitaCaseId)}/claims`, {
      headers: { Authorization: BACKEND_AUTH },
      signal: AbortSignal.timeout(10_000),
    });
    if (!listResp.ok) return res.status(502).json({ error: "Could not verify claim ownership." });
    const listData = await listResp.json();
    const claims = listData.claims || [];
    const belongs = claims.some(c => (c.claim_id || c.id) === claimId);
    if (!belongs) {
      audit(req.user.id, "unauthorized_claim_access", req, { case_id: req.orbitaCaseId, claim_id: claimId });
      return res.status(403).json({ error: "Access denied." });
    }
  } catch (err) {
    console.error("[claims ownership check]", err.message);
    return res.status(502).json({ error: "Could not verify claim ownership." });
  }
  await proxyStream(req, res, `/claims/${encodeURIComponent(claimId)}/${sub}`);
});

// Graph, claims, and any other case sub-resources
app.get("/api/orbita/cases/:caseId/*", guardCase, async (req, res) => {
  const sub = req.params[0] ? `/${req.params[0]}` : "";
  await proxyStream(req, res, `/cases/${encodeURIComponent(req.orbitaCaseId)}${sub}`);
});

// Run polling — check run_jobs first, fall back to proxy for legacy runs
app.get("/api/orbita/runs/:runId", async (req, res) => {
  const runId = req.params.runId;
  try {
    const owned = await ownership.checkResourceOwnership(req.user.id, "run", runId);
    if (!owned) {
      audit(req.user.id, "unauthorized_run_access", req, { run_id: runId });
      return res.status(403).json({ error: "Access denied." });
    }

    // Check our job queue table first
    const job = await queue.getRunJob(runId);
    if (job) {
      if (job.status === "completed" && job.result_json) {
        const graphId = await homeGraphForCase(req.user.id, job.orbita_case_id).catch(() => null);
        let result = job.result_json;
        if (typeof result === "string") {
          try { result = JSON.parse(result); } catch (_) { result = {}; }
        }
        const findings = result?.findings || result?.result?.findings || [];
        if (graphId) {
          await reviewTrace.createTraceEventOnce(req.user.id, graphId, {
            event_type: "run_completed",
            title: `Run completed: ${shortCaseId(runId)}`,
            description: `Discovery run completed with ${findings.length} finding${findings.length === 1 ? "" : "s"}.`,
            case_id: job.orbita_case_id,
            run_id: runId,
            source_type: "run",
            source_ref_id: runId,
            admissibility_effect: findings.length ? "permits_question" : "none",
          }).catch(err => console.error("[run trace event]", err.message));
        }
        return res.json(job.result_json);
      }
      if (job.status === "failed") {
        return res.status(500).json({ error: job.error_message || "Run failed." });
      }
      if (job.status === "cancelled") {
        return res.status(410).json({ error: "Run was cancelled." });
      }
      // queued or running
      return res.json({ run_id: runId, status: job.status });
    }

    // Legacy: fall back to backend proxy
    await proxyStream(req, res, `/runs/${encodeURIComponent(runId)}`);
  } catch (err) {
    console.error("[GET /runs]", err.message);
    res.status(500).json({ error: "Authorization check failed." });
  }
});

// Belief graph viewer — proxies the backend HTML with case-scope enforcement.
// Rewrites relative fetches so /cases/* and /claims/* go through this proxy.
app.get("/api/orbita/graph-viewer", async (req, res) => {
  const caseId = String(req.query.case_id || "");
  if (!caseId) return res.status(400).send("case_id required");
  try {
    const owned = await ownership.checkCaseOwnership(req.user.id, caseId);
    if (!owned) {
      audit(req.user.id, "unauthorized_graph_access", req, { case_id: caseId });
      return res.status(403).send("Access denied.");
    }
    if (!ORBITA_API_BASE) return res.status(503).send("Backend not configured.");

    const backendUrl = `${ORBITA_API_BASE}/graph?case_id=${encodeURIComponent(caseId)}`;
    const resp = await fetch(backendUrl, {
      headers: { Authorization: BACKEND_AUTH },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.error("[graph-viewer] backend returned", resp.status);
      return res.status(502).send("Backend graph unavailable.");
    }
    let html = await resp.text();

    // Inject fetch/URL patch so relative /cases and /claims calls route through the proxy.
    const patch = `
<script>
(function(){
  var CASE_ID = ${JSON.stringify(caseId)};
  // /claims/{id}/{sub} must be case-scoped: /api/orbita/cases/{caseId}/claims/{id}/{sub}.
  // Everything else relative just gets the generic /api/orbita prefix.
  function rewrite(path){
    var m = /^\\/claims\\/([^/]+)\\/(.+)$/.exec(path);
    if (m) return "/api/orbita/cases/" + encodeURIComponent(CASE_ID) + "/claims/" + m[1] + "/" + m[2];
    return "/api/orbita" + path;
  }
  var orig = window.fetch;
  window.fetch = function(input, init){
    if (typeof input === "string" && input.charAt(0) === "/" && input.indexOf("/api/") !== 0) {
      input = rewrite(input);
    } else if (input && typeof input === "object" && input.url && input.url.charAt(0) === "/" && input.url.indexOf("/api/") !== 0) {
      input = new Request(rewrite(input.url), input);
    }
    return orig.call(this, input, init);
  };
  // Fix anchor links (claim history/impact) to route through the case-scoped proxy.
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest && e.target.closest("a[href^='/claims/']");
    if (a) a.setAttribute("href", rewrite(a.getAttribute("href")));
  }, true);
})();
</script>`;
    html = html.replace("</head>", patch + "\n</head>");

    // The vis-network script comes from unpkg.com — override CSP for this route only.
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://unpkg.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "connect-src 'self'; " +
      "font-src 'self' data:; " +
      "frame-src 'none';"
    );
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error("[graph-viewer]", err.message);
    res.status(502).send("Failed to load graph viewer.");
  }
});

// Reject all other proxy paths to prevent bypass attempts
app.all("/api/orbita/*", (req, res) => {
  res.status(403).json({ error: "Operation not permitted." });
});

// ── Admin API routes ──────────────────────────────────────────────────────────

app.use("/api/admin", requireAdmin);
app.use("/api/admin", express.json({ limit: "16kb" }));

app.get("/api/admin/usage", async (req, res) => {
  try {
    const summary = await admin.getUsageSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// Admin diagnostic: pg-boss queue state + flags + user quota
app.get("/api/admin/queue-debug", async (req, res) => {
  try {
    const bossState = await db.query(
      `SELECT name, state, COUNT(*)::int n FROM pgboss.job GROUP BY 1,2 ORDER BY 1,2`
    );
    const flags = await db.query(`SELECT key, value FROM admin_flags ORDER BY key`);
    const runJobs = await db.query(
      `SELECT id, status, pgboss_job_id, created_at, completed_at, error_message
       FROM run_jobs ORDER BY created_at DESC LIMIT 10`
    );
    const quotas = await db.query(
      `SELECT user_id, total_cases, runs_today, runs_today_date, concurrent_runs
       FROM user_quota WHERE user_id=$1`,
      [req.user.id]
    );
    const caseCount = await db.query(
      `SELECT COUNT(*)::int n FROM orbita_cases WHERE user_id=$1`,
      [req.user.id]
    );
    res.json({
      pgboss_state: bossState.rows,
      admin_flags: flags.rows,
      run_jobs: runJobs.rows,
      my_quota: quotas.rows[0] || null,
      my_case_count: caseCount.rows[0].n,
      user_id: req.user.id,
      now: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: safeError(err), stack: err.stack });
  }
});

// Admin: bump a flag
app.post("/api/admin/set-flag", async (req, res) => {
  try {
    const key = String(req.body?.key || "");
    const value = String(req.body?.value ?? "");
    if (!/^[a-z0-9_]{1,60}$/.test(key)) return res.status(400).json({ error: "bad key" });
    await admin.setFlag(key, value, null);
    res.json({ ok: true, key, value });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// Admin: reset a user's runs_today counter
app.post("/api/admin/reset-quota", async (req, res) => {
  try {
    await db.query(
      `UPDATE user_quota SET runs_today = 0, runs_today_date = CURRENT_DATE,
                             concurrent_runs = 0, updated_at = NOW()
       WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

app.get("/api/admin/users", async (req, res) => {
  try {
    const users = await admin.listUsers({
      limit:  parseInt(req.query.limit  || "100", 10),
      offset: parseInt(req.query.offset || "0",   10),
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

app.post("/api/admin/users/:userId/suspend", async (req, res) => {
  try {
    const ok = await admin.suspendUser(req.params.userId, req.body?.reason || null, req.user.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

app.post("/api/admin/users/:userId/reactivate", async (req, res) => {
  try {
    const ok = await admin.reactivateUser(req.params.userId, req.user.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

app.delete("/api/admin/users/:userId", async (req, res) => {
  try {
    const cases = await ownership.getUserCases(req.params.userId);
    const backendResult = await dataLifecycle.deleteOwnedBackendCases({
      cases,
      deleteBackendCaseFn: deleteBackendCase,
    });
    if (!backendResult.ok) {
      return res.status(502).json({
        ok: false,
        error: "User deletion incomplete. Backend case deletion failed.",
        failed_case_id: backendResult.failed_case_id,
        deleted_backend_cases: backendResult.deleted.length,
      });
    }
    const result = await admin.deleteUserData(req.params.userId, req.user.id);
    res.json({ ok: true, ...result, deleted_backend_cases: backendResult.deleted.length });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

app.get("/api/admin/flags", async (req, res) => {
  try {
    const flags = await admin.listFlags();
    res.json(flags);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

app.post("/api/admin/flags", async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || value === undefined) return res.status(400).json({ error: "key and value are required." });
  try {
    await admin.setFlag(key, value, req.user.id);
    audit(req.user.id, "admin_flag_set", req, { key, value });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

app.post("/api/admin/ip-blocks", async (req, res) => {
  const { ip, reason, expires_at } = req.body || {};
  if (!ip) return res.status(400).json({ error: "ip is required." });
  try {
    await admin.blockIp(ip, reason, expires_at || null);
    audit(req.user.id, "admin_ip_block", req, { ip, reason });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

app.delete("/api/admin/ip-blocks/:ip", async (req, res) => {
  try {
    await admin.unblockIp(req.params.ip);
    audit(req.user.id, "admin_ip_unblock", req, { ip: req.params.ip });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  // Data-style requests must never receive the SPA HTML shell — that produces
  // "unexpected token DOCTYPE" when the client calls response.json().
  const p = req.path;
  const looksLikeData =
    p.startsWith("/api/") || p.startsWith("/auth/") ||
    p.startsWith("/cases") || p.startsWith("/claims") ||
    p.startsWith("/runs") || p.startsWith("/health") ||
    (req.get("accept") || "").includes("application/json");
  if (looksLikeData) {
    console.warn(`[spa-fallback] JSON 404 for unmatched data path: ${req.method} ${p}`);
    return res.status(404).json({ error: "Not found", path: p });
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function ensurePreviewAuthSchema() {
  if (!IS_RAILWAY_PR_ENV) return;
  // Railway preview databases are not guaranteed to run the service-level
  // pre-deploy migration hook. Keep the minimal pre-auth dependency available
  // so a missing table cannot terminate an async Express 4 login request.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ip_blocks (
      ip         TEXT        PRIMARY KEY,
      reason     TEXT,
      blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS ip_blocks_expires_at_idx
      ON ip_blocks (expires_at)
      WHERE expires_at IS NOT NULL
  `);
}

async function seedStagingFlags() {
  if (APP_ENV !== "staging") return;
  const seeds = [
    ["max_cases_per_user", "50"],
    ["max_runs_per_day",   "50"],
  ];
  for (const [key, value] of seeds) {
    try {
      await admin.setFlag(key, value, null);
      console.log(`[orbita] staging flag seeded: ${key}=${value}`);
    } catch (err) {
      console.error(`[orbita] flag seed failed for ${key}:`, err.message);
    }
  }
  // Clear stuck per-user counters left behind by runs that crashed mid-flight.
  try {
    await db.query(
      `UPDATE user_quota SET runs_today = 0, runs_today_date = CURRENT_DATE,
                             concurrent_runs = 0, updated_at = NOW()`
    );
    console.log("[orbita] staging quota counters reset");
  } catch (err) {
    console.error("[orbita] quota reset failed:", err.message);
  }
}

async function start() {
  try {
    await db.query("SELECT 1");
    console.log("[orbita] PostgreSQL connection OK");
  } catch (err) {
    console.error("[orbita] Cannot connect to PostgreSQL:", err.message);
    process.exit(1);
  }

  await ensurePreviewAuthSchema();
  await seedStagingFlags();

  app.listen(PORT, () => {
    console.log(`[orbita] ${APP_ENV} — http://localhost:${PORT}  commit=${GIT_COMMIT.slice(0, 7)}`);
  });
}

start();
