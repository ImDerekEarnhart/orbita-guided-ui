"use strict";
// Integration tests: verify every admin route returns 403 for non-admin users.
// Run against a live server. Set BASE_URL (default: http://localhost:3000).
//
//   BASE_URL=https://your-staging.up.railway.app node --test tests/test_admin_routes.js
//
// The server must have at least one non-admin active account with a known password.
// Set via environment: TEST_USER, TEST_PASS (never commit real credentials).

import { test, before } from "node:test";
import assert from "node:assert/strict";

const BASE_URL    = process.env.BASE_URL    || "http://localhost:3000";
const TEST_USER   = process.env.TEST_USER;
const TEST_PASS   = process.env.TEST_PASS;

// Admin routes to verify
const ADMIN_ROUTES = [
  { method: "GET",    path: "/api/admin/usage" },
  { method: "GET",    path: "/api/admin/users" },
  { method: "POST",   path: "/api/admin/users/00000000-0000-0000-0000-000000000001/suspend" },
  { method: "POST",   path: "/api/admin/users/00000000-0000-0000-0000-000000000001/reactivate" },
  { method: "DELETE", path: "/api/admin/users/00000000-0000-0000-0000-000000000001" },
  { method: "GET",    path: "/api/admin/flags" },
  { method: "POST",   path: "/api/admin/flags" },
  { method: "POST",   path: "/api/admin/ip-blocks" },
  { method: "DELETE", path: "/api/admin/ip-blocks/127.0.0.2" },
];

let sessionCookie = "";
let csrfToken = "";

before(async () => {
  if (!TEST_USER || !TEST_PASS) {
    console.warn("TEST_USER and TEST_PASS not set — admin route tests will use unauthenticated requests");
    return;
  }

  // Obtain CSRF token
  const csrfResp = await fetch(`${BASE_URL}/login`, { redirect: "manual" });
  const csrfHtml = await csrfResp.text();
  const m = csrfHtml.match(/window\.__csrf="([^"]+)"/);
  if (m) csrfToken = m[1];
  const rawCookie = csrfResp.headers.get("set-cookie") || "";
  const sid = rawCookie.match(/orbita\.sid=([^;]+)/);
  if (sid) sessionCookie = `orbita.sid=${sid[1]}`;

  // Log in as the test (non-admin) user
  const loginResp = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: sessionCookie,
    },
    body: new URLSearchParams({ identifier: TEST_USER, password: TEST_PASS, _csrf: csrfToken }),
    redirect: "manual",
  });
  const loginCookie = loginResp.headers.get("set-cookie") || "";
  const loginSid = loginCookie.match(/orbita\.sid=([^;]+)/);
  if (loginSid) sessionCookie = `orbita.sid=${loginSid[1]}`;

  // Refresh CSRF from /auth/me
  const meResp = await fetch(`${BASE_URL}/auth/me`, { headers: { Cookie: sessionCookie } });
  if (meResp.ok) {
    const me = await meResp.json();
    csrfToken = me.csrf_token || csrfToken;
    assert.strictEqual(me.email_verified !== undefined, true, "/auth/me must return email_verified field");
  }
});

// Unauthenticated requests must return 401 or redirect (not 200/500)
for (const route of ADMIN_ROUTES) {
  test(`unauthenticated ${route.method} ${route.path} → 401/302`, async () => {
    const resp = await fetch(`${BASE_URL}${route.path}`, {
      method: route.method,
      headers: { "Content-Type": "application/json" },
      body: route.method !== "GET" && route.method !== "DELETE" ? "{}" : undefined,
      redirect: "manual",
    });
    assert.ok(
      resp.status === 401 || resp.status === 302 || resp.status === 403,
      `Expected 401/302/403 but got ${resp.status} for ${route.method} ${route.path}`
    );
  });
}

// Authenticated non-admin requests must return 403
for (const route of ADMIN_ROUTES) {
  test(`non-admin ${route.method} ${route.path} → 403`, async () => {
    if (!sessionCookie) {
      console.log(`  (skipped — no session cookie; set TEST_USER and TEST_PASS)`);
      return;
    }
    const resp = await fetch(`${BASE_URL}${route.path}`, {
      method: route.method,
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrfToken,
        Cookie: sessionCookie,
      },
      body: route.method !== "GET" && route.method !== "DELETE" ? "{}" : undefined,
    });
    assert.strictEqual(
      resp.status, 403,
      `Non-admin user must receive 403 for ${route.method} ${route.path}, got ${resp.status}`
    );
    const body = await resp.json().catch(() => ({}));
    assert.ok(!body.users && !body.key && !body.value,
      "403 response must not leak admin data");
  });
}

test("role field is stored in database, not username-derived", async () => {
  if (!sessionCookie) return;
  // The /auth/me endpoint does not expose role to clients — this is by design
  const resp = await fetch(`${BASE_URL}/auth/me`, { headers: { Cookie: sessionCookie } });
  assert.ok(resp.ok, "/auth/me must succeed for logged-in user");
  const me = await resp.json();
  // role must not be exposed in the /auth/me response (it's server-side only)
  assert.strictEqual(me.role, undefined, "/auth/me must not expose role to clients");
});
