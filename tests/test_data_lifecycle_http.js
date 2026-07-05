"use strict";

/**
 * Live HTTP data lifecycle tests.
 *
 * Requirements:
 *   DATABASE_URL           same Postgres the server uses
 *   BASE_URL               live frontend server
 *   ORBITA_API_BASE        live backend server
 *   ORBITA_API_USERNAME    backend Basic Auth username
 *   ORBITA_API_PASSWORD    backend Basic Auth password
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const REQUIRED = ["DATABASE_URL", "ORBITA_API_BASE", "ORBITA_API_USERNAME", "ORBITA_API_PASSWORD"];
if (REQUIRED.some(name => !process.env[name])) {
  console.log("Skipping data lifecycle HTTP tests - required staging env not set.");
  process.exit(0);
}

const db = require("../lib/db.js");
const authLib = require("../lib/auth.js");

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const BACKEND_URL = process.env.ORBITA_API_BASE.replace(/\/$/, "");
const BACKEND_AUTH = "Basic " + Buffer.from(
  `${process.env.ORBITA_API_USERNAME}:${process.env.ORBITA_API_PASSWORD}`,
).toString("base64");

const users = [];
const caseIds = new Set();

function suffix() { return crypto.randomBytes(6).toString("hex"); }

function cookieOf(resp) {
  const raw = typeof resp.headers.getSetCookie === "function"
    ? resp.headers.getSetCookie()
    : [resp.headers.get("set-cookie")].filter(Boolean);
  const sid = raw.find(c => c.startsWith("orbita.sid="));
  return sid ? sid.split(";")[0] : null;
}

async function createTestUser(label = "lifecycle") {
  const s = suffix();
  const user = {
    email: `${label}_${s}@orbita-test.internal`,
    username: `${label}_${s}`,
    password: `Lifecycle_${s}_pw`,
  };
  const hash = await authLib.hashPassword(user.password);
  const { rows } = await db.query(
    `INSERT INTO users (email, username, password_hash, status, email_verified_at)
     VALUES ($1, $2, $3, 'active', NOW()) RETURNING id`,
    [user.email, user.username, hash],
  );
  user.id = rows[0].id;
  users.push(user);
  return user;
}

async function cleanupUser(user) {
  if (!user?.id) return;
  for (const sql of [
    "DELETE FROM datasets            WHERE user_id = $1",
    "DELETE FROM graph_case_links    WHERE user_id = $1",
    "DELETE FROM graph_scope_policy  WHERE graph_id IN (SELECT id FROM memory_graphs WHERE owner_user_id = $1)",
    "DELETE FROM memory_graphs       WHERE owner_user_id = $1",
    "DELETE FROM run_jobs            WHERE user_id = $1",
    "DELETE FROM orbita_resources    WHERE user_id = $1",
    "DELETE FROM orbita_cases        WHERE user_id = $1",
    "DELETE FROM user_quota          WHERE user_id = $1",
    "DELETE FROM email_verifications WHERE user_id = $1",
    "DELETE FROM password_resets     WHERE user_id = $1",
    "DELETE FROM audit_events        WHERE user_id = $1",
    `DELETE FROM "session"           WHERE sess->>'userId' = $1`,
    "DELETE FROM users               WHERE id = $1",
  ]) await db.query(sql, [user.id]);
}

async function login(user) {
  const page = await fetch(`${BASE_URL}/login`, { redirect: "manual" });
  const preCookie = cookieOf(page);
  const html = await page.text();
  const match = /window\.__csrf="([0-9a-f]+)"/.exec(html);
  assert.ok(preCookie && match, "login page must yield a session cookie and CSRF token");

  const resp = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: preCookie },
    body: new URLSearchParams({ identifier: user.username, password: user.password, _csrf: match[1] }),
  });
  assert.equal(resp.status, 302);
  const cookie = cookieOf(resp);
  assert.ok(cookie, "login must set a regenerated session cookie");
  return cookie;
}

function api(cookie, method, path, jsonBody) {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Cookie: cookie,
      ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
    redirect: "manual",
  });
}

async function createCase(cookie, name) {
  const resp = await api(cookie, "POST", "/api/orbita/cases", { name, goal: "" });
  const text = await resp.text();
  assert.ok(resp.status >= 200 && resp.status < 300, `case creation failed: ${resp.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  const caseId = body.case_id || body.id;
  assert.ok(caseId, "case creation must return an id");
  caseIds.add(caseId);
  return caseId;
}

async function backendStatus(caseId) {
  const resp = await fetch(`${BACKEND_URL}/cases/${encodeURIComponent(caseId)}`, {
    headers: { Authorization: BACKEND_AUTH },
    redirect: "manual",
  });
  return resp.status;
}

async function backendDelete(caseId) {
  return fetch(`${BACKEND_URL}/cases/${encodeURIComponent(caseId)}`, {
    method: "DELETE",
    headers: { Authorization: BACKEND_AUTH },
    redirect: "manual",
  }).catch(() => null);
}

async function expectStatus(resp, statuses, label) {
  const text = await resp.text().catch(() => "");
  assert.ok(statuses.includes(resp.status), `${label}: expected ${statuses.join("/")} got ${resp.status}: ${text.slice(0, 200)}`);
}

after(async () => {
  for (const caseId of caseIds) await backendDelete(caseId);
  for (const user of users) await cleanupUser(user);
  await db.end();
});

describe("data lifecycle (live HTTP)", () => {
  it("user can export only owned case/resource metadata", async () => {
    const user = await createTestUser("export");
    const cookie = await login(user);
    const caseId = await createCase(cookie, "export-case");

    const resp = await api(cookie, "GET", "/api/user/export");
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.ok(body.cases.some(c => c.case_id === caseId));
    assert.ok(body.cases.every(c => c.case_id === caseId));
    assert.ok(body.cases[0].links.report.includes(caseId));
  });

  it("User A cannot delete User B's case", async () => {
    const userA = await createTestUser("del_a");
    const userB = await createTestUser("del_b");
    const cookieA = await login(userA);
    const cookieB = await login(userB);
    const bCase = await createCase(cookieB, "b-owned");

    await expectStatus(await api(cookieA, "DELETE", `/api/orbita/cases/${bCase}`), [403], "cross-user delete");
    assert.equal((await api(cookieB, "GET", `/api/orbita/cases/${bCase}`)).status, 200);
  });

  it("own case deletion removes frontend ownership and backend case", async () => {
    const user = await createTestUser("own_delete");
    const cookie = await login(user);
    const caseId = await createCase(cookie, "delete-owned");

    assert.equal(await backendStatus(caseId), 200);
    const del = await api(cookie, "DELETE", `/api/orbita/cases/${caseId}`);
    assert.equal(del.status, 200, await del.text());
    caseIds.delete(caseId);

    await expectStatus(await api(cookie, "GET", `/api/orbita/cases/${caseId}`), [403, 404], "deleted frontend case");
    assert.equal(await backendStatus(caseId), 404);
  });

  it("account deletion deletes all owned backend cases before frontend cleanup", async () => {
    const user = await createTestUser("acct_delete");
    const cookie = await login(user);
    const caseOne = await createCase(cookie, "account-delete-1");
    const caseTwo = await createCase(cookie, "account-delete-2");

    const resp = await api(cookie, "POST", "/api/user/delete", { password: user.password });
    assert.equal(resp.status, 200, await resp.text());
    caseIds.delete(caseOne);
    caseIds.delete(caseTwo);

    assert.equal(await backendStatus(caseOne), 404);
    assert.equal(await backendStatus(caseTwo), 404);
    const { rows: caseRows } = await db.query("SELECT 1 FROM orbita_cases WHERE user_id=$1", [user.id]);
    assert.equal(caseRows.length, 0);
  });
});
