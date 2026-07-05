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
    "DELETE FROM operator_proposals WHERE user_id = $1",
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

  // ── Phase 2B: memory summaries + counterexamples ──────────────────────────
  // The summary/counterexample routes proxy the backend; these tests need a
  // backend running the Phase 2B branch (local uvicorn is fine).

  it("A cannot access B's memory summary or counterexamples (Phase 2B)", async () => {
    assert.equal((await api(cookieA, "GET", `/api/graphs/${bGraphId}/summary`)).status, 403);
    assert.equal((await api(cookieA, "GET", `/api/graphs/${bGraphId}/counterexamples`)).status, 403);
  });

  it("owner can read own graph memory summary (Phase 2B)", async () => {
    const created = await api(cookieA, "POST", "/api/graphs", { name: "A 2B summary graph", kind: "project" });
    assert.equal(created.status, 201);
    const graphId = (await created.json()).id;

    const resp = await api(cookieA, "GET", `/api/graphs/${graphId}/summary`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.graph_id, graphId);
    assert.equal(body.summary.claim_count, 0, "fresh graph has no claims");
    assert.equal(body.summary.counterexample_count, 0);
    assert.equal(body.summary.observation_count, 0);
    assert.deepEqual(body.summary.dataset_relations, {});

    const cx = await api(cookieA, "GET", `/api/graphs/${graphId}/counterexamples`);
    assert.equal(cx.status, 200);
    assert.deepEqual((await cx.json()).counterexamples, []);
  });

  it("graph export includes memory summary and Phase 2B links", async () => {
    const created = await api(cookieA, "POST", "/api/graphs", { name: "A 2B export graph", kind: "project" });
    assert.equal(created.status, 201);
    const graphId = (await created.json()).id;

    const resp = await api(cookieA, "GET", `/api/graphs/${graphId}/export`);
    assert.equal(resp.status, 200);
    const exported = await resp.json();
    assert.ok("memory_summary" in exported, "export must carry memory_summary");
    assert.ok(exported.memory_summary, "backend on the 2B branch must supply the summary");
    assert.equal(exported.memory_summary.counterexample_count, 0);
    assert.equal(exported.memory_summary.observation_count, 0);
    assert.ok(exported.links.summary.includes(`/api/graphs/${graphId}/summary`));
    assert.ok(exported.links.counterexamples.includes(`/api/graphs/${graphId}/counterexamples`));
    assert.ok(exported.links.operators.includes(`/api/graphs/${graphId}/operators`));
  });

  it("operator proposal routes require graph ownership and empty evidence produces no proposals", async () => {
    assert.equal((await api(cookieA, "GET", `/api/graphs/${bGraphId}/operators`)).status, 403);
    assert.equal((await api(cookieA, "POST", `/api/graphs/${bGraphId}/operators/propose`, {})).status, 403);

    const created = await api(cookieA, "POST", "/api/graphs", { name: "A 2D operator graph", kind: "project" });
    assert.equal(created.status, 201);
    const graphId = (await created.json()).id;

    const propose = await api(cookieA, "POST", `/api/graphs/${graphId}/operators/propose`, {});
    assert.equal(propose.status, 200);
    const body = await propose.json();
    assert.equal(body.status, "candidate_operator_review_required");
    assert.deepEqual(body.operators, []);

    const list = await api(cookieA, "GET", `/api/graphs/${graphId}/operators`);
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).operators, []);
  });

  it("operator proposals are graph-scoped and readable only by the owner", async () => {
    const created = await api(cookieA, "POST", "/api/graphs", { name: "A stored operator graph", kind: "project" });
    assert.equal(created.status, 201);
    const graphId = (await created.json()).id;
    const evidenceJson = {
      evidence_count: 2,
      case_breakdown: [{
        case_id: aCaseId,
        evidence_count: 2,
        counterexample_count: 1,
        signal_tags: ["boundary"],
        claim_ids: ["claim_a", "claim_b"],
        counterexample_ids: ["cx_a"],
      }],
      score_components: { case_diversity: 0.08, evidence_ratio: 0.2 },
      score_explanation: "Score rewards case diversity.",
    };
    const { rows } = await db.query(
      `INSERT INTO operator_proposals
         (graph_id, user_id, operator_id, name, status, description,
          pattern_json, evidence_json, counterexample_json,
          supporting_case_ids, supporting_claim_ids, counterexample_ids, score)
       VALUES ($1,$2,'op_test_boundary','Boundary Concentration','review_needed',
          'Candidate boundary concentration pattern.',
          '{"kind":"test","signals":["boundary"]}',
          $5,
          '{"counterexample_count":1}',
          ARRAY[$3,$4], ARRAY['claim_a','claim_b'], ARRAY['cx_a'], 0.72)
       RETURNING operator_id`,
      [graphId, userA.id, aCaseId, "case_extra", JSON.stringify(evidenceJson)]
    );
    const operatorId = rows[0].operator_id;

    const list = await api(cookieA, "GET", `/api/graphs/${graphId}/operators`);
    assert.equal(list.status, 200);
    const listed = await list.json();
    assert.equal(listed.operators.length, 1);
    assert.equal(listed.operators[0].status, "review_needed");
    assert.equal(listed.operators[0].name, "Boundary Concentration");
    assert.ok(listed.operators[0].case_labels.some(item => item.label.includes("graph-test-A")));
    assert.ok(listed.operators[0].case_labels.some(item => item.label === "case_extra"));
    assert.ok(listed.operators[0].score_components);
    assert.ok(listed.operators[0].score_explanation.includes("case diversity"));

    const detail = await api(cookieA, "GET", `/api/graphs/${graphId}/operators/${operatorId}`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.operator_id, operatorId);
    assert.ok(detailBody.case_labels.some(item => item.label.includes("graph-test-A")));
    assert.ok(detailBody.case_breakdown.some(row => row.claim_ids.includes("claim_a") && row.counterexample_ids.includes("cx_a")));

    assert.equal((await api(cookieB, "GET", `/api/graphs/${graphId}/operators`)).status, 403);
    assert.equal((await api(cookieB, "GET", `/api/graphs/${graphId}/operators/${operatorId}`)).status, 403);
  });
});
