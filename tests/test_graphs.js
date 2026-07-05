"use strict";

/**
 * Phase 2A memory-graph tests — live HTTP + DB.
 *
 * Requires DATABASE_URL (migrated with 004_memory_graphs) and a live server at
 * BASE_URL running THIS branch's code (staging does not have graph routes until
 * deployed — run a local server pointed at the same DB).
 *
 * Users are created by direct DB INSERT (signup gated by CAPTCHA/flags) and log
 * in through the real /auth/login flow, same pattern as tests/test_isolation.js.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

if (!process.env.DATABASE_URL) {
  console.log("⚠  Skipping graph tests — DATABASE_URL not set.");
  process.exit(0);
}

const db      = require("../lib/db.js");
const authLib = require("../lib/auth.js");
const graphs  = require("../lib/graphs.js");

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

function suffix() { return crypto.randomBytes(6).toString("hex"); }

function cookieOf(resp) {
  const raw = typeof resp.headers.getSetCookie === "function"
    ? resp.headers.getSetCookie()
    : [resp.headers.get("set-cookie")].filter(Boolean);
  const sid = raw.find(c => c.startsWith("orbita.sid="));
  return sid ? sid.split(";")[0] : null;
}

async function createTestUser() {
  const s = suffix();
  const user = { email: `graph_${s}@orbita-test.internal`, username: `graph_${s}`, password: `GraphTest_${s}_pw` };
  const hash = await authLib.hashPassword(user.password);
  const { rows } = await db.query(
    `INSERT INTO users (email, username, password_hash, status, email_verified_at)
     VALUES ($1, $2, $3, 'active', NOW()) RETURNING id`,
    [user.email, user.username, hash]
  );
  user.id = rows[0].id;
  return user;
}

async function login(user) {
  const page = await fetch(`${BASE_URL}/login`, { redirect: "manual", headers: { "X-Forwarded-Proto": "https" } });
  const preCookie = cookieOf(page);
  const m = /window\.__csrf="([0-9a-f]+)"/.exec(await page.text());
  assert.ok(preCookie && m, "login page must yield session cookie and CSRF token");
  const resp = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: preCookie, "X-Forwarded-Proto": "https" },
    body: new URLSearchParams({ identifier: user.username, password: user.password, _csrf: m[1] }),
  });
  assert.equal(resp.status, 302);
  assert.equal(new URL(resp.headers.get("location"), BASE_URL).pathname, "/", "login must succeed");
  return cookieOf(resp);
}

function api(cookie, method, path, jsonBody) {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Cookie: cookie, "X-Forwarded-Proto": "https", ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
    redirect: "manual",
  });
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
    "DELETE FROM audit_events        WHERE user_id = $1",
    `DELETE FROM "session"           WHERE sess->>'userId' = $1`,
    "DELETE FROM users               WHERE id = $1",
  ]) await db.query(sql, [user.id]);
}

describe("memory graphs (Phase 2A)", () => {
  let userA, userB, cookieA, cookieB, aGraphId, bGraphId, aCaseId, bCaseId;

  before(async () => {
    userA = await createTestUser();
    userB = await createTestUser();
    cookieA = await login(userA);
    cookieB = await login(userB);

    // Explicit graphs for each user
    const gA = await api(cookieA, "POST", "/api/graphs", { name: "A project graph", kind: "project" });
    assert.equal(gA.status, 201);
    aGraphId = (await gA.json()).id;
    const gB = await api(cookieB, "POST", "/api/graphs", { name: "B project graph", kind: "project" });
    assert.equal(gB.status, 201);
    bGraphId = (await gB.json()).id;

    // Real cases through the proxy (backend is live)
    const cA = await api(cookieA, "POST", "/api/orbita/cases", { name: "graph-test-A", goal: "" });
    assert.ok(cA.status >= 200 && cA.status < 300, `case A creation failed: ${cA.status}`);
    const cABody = await cA.json();
    aCaseId = cABody.case_id || cABody.id;
    const cB = await api(cookieB, "POST", "/api/orbita/cases", { name: "graph-test-B", goal: "" });
    assert.ok(cB.status >= 200 && cB.status < 300, `case B creation failed: ${cB.status}`);
    const cBBody = await cB.json();
    bCaseId = cBBody.case_id || cBBody.id;
  });

  after(async () => {
    await cleanupUser(userA);
    await cleanupUser(userB);
    await db.end();
  });

  it("case creation auto-creates a private home graph and returns graph_id", async () => {
    const { rows } = await db.query(
      `SELECT g.id, g.scope, g.kind, l.mode FROM graph_case_links l
       JOIN memory_graphs g ON g.id = l.graph_id
       WHERE l.case_id = $1 AND l.user_id = $2`,
      [aCaseId, userA.id]
    );
    assert.equal(rows.length, 1, "exactly one home link");
    assert.equal(rows[0].scope, "private");
    assert.equal(rows[0].kind, "case");
    assert.equal(rows[0].mode, "home");
  });

  it("user can list own graphs; list omits other users' graphs", async () => {
    const resp = await api(cookieA, "GET", "/api/graphs");
    assert.equal(resp.status, 200);
    const list = await resp.json();
    const ids = list.map(g => g.id);
    assert.ok(ids.includes(aGraphId), "A's own graph listed");
    assert.ok(!ids.includes(bGraphId), "B's graph must not leak into A's list");
  });

  it("A cannot GET B's graph (guardGraph)", async () => {
    assert.equal((await api(cookieA, "GET", `/api/graphs/${bGraphId}`)).status, 403);
  });

  it("A cannot attach a case to B's graph", async () => {
    const resp = await api(cookieA, "POST", `/api/graphs/${bGraphId}/cases/${aCaseId}`, { mode: "contributes" });
    assert.equal(resp.status, 403);
  });

  it("A cannot attach B's case to A's own graph (both ownerships required)", async () => {
    const resp = await api(cookieA, "POST", `/api/graphs/${aGraphId}/cases/${bCaseId}`, { mode: "contributes" });
    assert.equal(resp.status, 403);
  });

  it("A cannot DELETE or export B's graph", async () => {
    assert.equal((await api(cookieA, "DELETE", `/api/graphs/${bGraphId}`)).status, 403);
    assert.equal((await api(cookieA, "GET", `/api/graphs/${bGraphId}/export`)).status, 403);
  });

  it("owner can attach own case, read detail, export, and delete", async () => {
    const attach = await api(cookieA, "POST", `/api/graphs/${aGraphId}/cases/${aCaseId}`, { mode: "contributes" });
    assert.equal(attach.status, 200);

    const detail = await api(cookieA, "GET", `/api/graphs/${aGraphId}`);
    assert.equal(detail.status, 200);
    const graph = await detail.json();
    assert.ok(graph.cases.some(c => c.case_id === aCaseId));
    assert.equal(graph.scope, "private");

    const exp = await api(cookieA, "GET", `/api/graphs/${aGraphId}/export`);
    assert.equal(exp.status, 200);
    const exported = await exp.json();
    assert.equal(exported.graph.id, aGraphId);
    assert.ok(exported.cases.some(c => c.case_id === aCaseId));

    const del = await api(cookieA, "DELETE", `/api/graphs/${aGraphId}`);
    assert.equal(del.status, 200);
    // Cascade removes links only — the case itself must survive.
    assert.equal((await api(cookieA, "GET", `/api/orbita/cases/${aCaseId}`)).status, 200);
    assert.equal((await api(cookieA, "GET", `/api/graphs/${aGraphId}`)).status, 403, "deleted graph no longer owned/visible");
  });

  it("case creation with a graph_id the user does not own is denied", async () => {
    const resp = await api(cookieA, "POST", "/api/orbita/cases", { name: "sneaky", goal: "", graph_id: bGraphId });
    assert.equal(resp.status, 403);
  });

  it("lib-level ownership check mirrors HTTP behavior", async () => {
    assert.equal(await graphs.checkGraphOwnership(userA.id, bGraphId), false);
    assert.equal(await graphs.checkGraphOwnership(userB.id, bGraphId), true);
  });
});
