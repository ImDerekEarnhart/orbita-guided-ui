"use strict";

/**
 * Live HTTP upload-safety tests.
 *
 * Requirements:
 *   DATABASE_URL  same Postgres the server uses
 *   BASE_URL      live server (default http://localhost:3000)
 *   APP_ENV=staging when targeting Railway
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

if (!process.env.DATABASE_URL) {
  console.log("Skipping upload safety HTTP tests - DATABASE_URL not set.");
  process.exit(0);
}

const db = require("../lib/db.js");
const authLib = require("../lib/auth.js");
const { MAX_CSV_UPLOAD_BYTES } = require("../lib/uploadSafety.js");

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
  const user = {
    email: `upload_${s}@orbita-test.internal`,
    username: `upload_${s}`,
    password: `UploadSafety_${s}_pw`,
  };
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
  const page = await fetch(`${BASE_URL}/login`, { redirect: "manual" });
  const preCookie = cookieOf(page);
  const html = await page.text();
  const m = /window\.__csrf="([0-9a-f]+)"/.exec(html);
  assert.ok(preCookie && m, "login page must yield a session cookie and CSRF token");

  const resp = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: preCookie },
    body: new URLSearchParams({ identifier: user.username, password: user.password, _csrf: m[1] }),
  });
  assert.equal(resp.status, 302);
  assert.equal(new URL(resp.headers.get("location"), BASE_URL).pathname, "/");
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
  assert.ok(resp.status >= 200 && resp.status < 300, `case creation failed: ${resp.status}`);
  const body = await resp.json();
  const caseId = body.case_id || body.id;
  assert.ok(caseId, "case creation must return an id");
  return caseId;
}

async function upload(cookie, caseId, filename, content = "a,b\n1,2\n", type = "text/csv") {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), filename);
  return fetch(`${BASE_URL}/api/orbita/cases/${encodeURIComponent(caseId)}/files`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
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
    "DELETE FROM email_verifications WHERE user_id = $1",
    "DELETE FROM password_resets     WHERE user_id = $1",
    "DELETE FROM audit_events        WHERE user_id = $1",
    `DELETE FROM "session"           WHERE sess->>'userId' = $1`,
    "DELETE FROM users               WHERE id = $1",
  ]) await db.query(sql, [user.id]);
}

async function expectStatus(resp, statuses, label) {
  const text = await resp.text().catch(() => "");
  assert.ok(statuses.includes(resp.status), `${label}: expected ${statuses.join("/")} got ${resp.status}: ${text.slice(0, 200)}`);
}

describe("upload safety (live HTTP)", () => {
  let userA, userB, cookieA, cookieB, aCaseId, bCaseId, bFileId;

  before(async () => {
    userA = await createTestUser();
    userB = await createTestUser();
    cookieA = await login(userA);
    cookieB = await login(userB);
    aCaseId = await createCase(cookieA, "upload-safety-A");
    bCaseId = await createCase(cookieB, "upload-safety-B");
  });

  after(async () => {
    if (cookieA && aCaseId) await api(cookieA, "DELETE", `/api/orbita/cases/${aCaseId}`).catch(() => {});
    if (cookieB && bCaseId) await api(cookieB, "DELETE", `/api/orbita/cases/${bCaseId}`).catch(() => {});
    await cleanupUser(userA);
    await cleanupUser(userB);
    await db.end();
  });

  it("B can upload a tiny valid CSV to B's case", async () => {
    const resp = await upload(cookieB, bCaseId, "tiny.csv");
    assert.ok(resp.status >= 200 && resp.status < 300, `valid CSV upload failed: ${resp.status}`);
    const body = await resp.json();
    bFileId = body.file_id || body.id;
    assert.ok(bFileId, "valid upload must return a file id");
  });

  it("invalid, archive, executable, script, and traversal filenames are rejected", async () => {
    const names = [
      "../evil.csv",
      "..\\evil.csv",
      "/tmp/evil.csv",
      "C:\\evil.csv",
      "evil.exe",
      "evil.csv.exe",
      "evil.zip",
      "evil.sh",
      "evil.js",
    ];
    for (const name of names) {
      await expectStatus(await upload(cookieB, bCaseId, name), [400], name);
    }
  });

  it("CSV extension cannot hide executable, archive, or script content", async () => {
    const cases = [
      { label: "pe", content: Buffer.from([0x4d, 0x5a, 0x00, 0x01]), type: "application/octet-stream" },
      { label: "zip", content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), type: "application/zip" },
      { label: "script", content: "#!/bin/sh\necho nope\n", type: "text/plain" },
      { label: "js-mime", content: "a,b\n1,2\n", type: "application/javascript" },
    ];
    for (const c of cases) {
      await expectStatus(await upload(cookieB, bCaseId, `${c.label}.csv`, c.content, c.type), [400], c.label);
    }
  });

  it("oversized uploads are rejected cleanly", async () => {
    const tooBig = Buffer.alloc(MAX_CSV_UPLOAD_BYTES + 1, "a");
    const resp = await upload(cookieB, bCaseId, "too-big.csv", tooBig, "text/csv");
    await expectStatus(resp, [413], "oversized CSV");
  });

  it("A cannot upload to B's case", async () => {
    const resp = await upload(cookieA, bCaseId, "a-to-b.csv");
    await expectStatus(resp, [403], "cross-user upload");
  });

  it("A cannot access B's uploaded file through direct or mixed case paths", async () => {
    assert.ok(bFileId, "valid upload test must run first");
    const probes = [
      `/api/orbita/cases/${bCaseId}/files/${bFileId}`,
      `/api/orbita/cases/${bCaseId}/files/${bFileId}/download`,
      `/api/orbita/files/${bFileId}`,
      `/api/orbita/cases/${aCaseId}/files/${bFileId}`,
      `/api/orbita/cases/${aCaseId}/files/${bFileId}/download`,
    ];
    for (const path of probes) {
      await expectStatus(await api(cookieA, "GET", path), [403, 404, 405], path);
    }
  });
});
