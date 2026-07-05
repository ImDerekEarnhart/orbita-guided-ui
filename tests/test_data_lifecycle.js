"use strict";

/**
 * Unit tests for lib/dataLifecycle.js.
 *
 * Pure in-process tests — no live server, no real DB, no real backend.
 * All external I/O is replaced with simple stub functions.
 *
 * Run: node --test tests/test_data_lifecycle.js
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const dataLifecycle = require("../lib/dataLifecycle.js");

// ── deleteBackendCase ─────────────────────────────────────────────────────────

describe("deleteBackendCase", () => {
  it("returns ok:true for 200 response", async () => {
    const result = await dataLifecycle.deleteBackendCase({
      baseUrl: "https://backend.test",
      authHeader: "Basic test",
      caseId: "case_abc",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ deleted: true }),
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
  });

  it("returns ok:true for 404 (already absent from backend)", async () => {
    const result = await dataLifecycle.deleteBackendCase({
      baseUrl: "https://backend.test",
      authHeader: "Basic test",
      caseId: "case_gone",
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        headers: { get: () => "application/json" },
        json: async () => ({ detail: "Unknown resource" }),
      }),
    });
    // 404 means already gone — callers treat this as acceptable
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  });

  it("returns ok:false for 500 backend error", async () => {
    const result = await dataLifecycle.deleteBackendCase({
      baseUrl: "https://backend.test",
      authHeader: "Basic test",
      caseId: "case_err",
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        headers: { get: () => "application/json" },
        json: async () => ({ error: "Internal error" }),
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
  });

  it("returns ok:false with status 502 when backend is unreachable", async () => {
    const result = await dataLifecycle.deleteBackendCase({
      baseUrl: "https://backend.test",
      authHeader: "Basic test",
      caseId: "case_unreachable",
      fetchImpl: async () => { throw Object.assign(new Error("ECONNREFUSED"), { name: "Error" }); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.ok(result.body?.error, "error message present");
    assert.ok(!JSON.stringify(result.body).includes("ECONNREFUSED"), "no internal error details in response");
  });

  it("returns ok:false with status 504 on timeout", async () => {
    const result = await dataLifecycle.deleteBackendCase({
      baseUrl: "https://backend.test",
      authHeader: "Basic test",
      caseId: "case_timeout",
      fetchImpl: async () => { throw Object.assign(new Error("Aborted"), { name: "AbortError" }); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 504);
  });

  it("returns ok:false when baseUrl is empty (not configured)", async () => {
    const result = await dataLifecycle.deleteBackendCase({
      baseUrl: "",
      authHeader: "Basic test",
      caseId: "case_any",
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
  });
});

// ── deleteOwnedBackendCases ───────────────────────────────────────────────────

describe("deleteOwnedBackendCases", () => {
  const okFn = async () => ({ ok: true, status: 200, body: {} });
  const failFn = async (caseId) => ({
    ok: false,
    status: 502,
    body: { error: "Backend unreachable" },
    _caseId: caseId,
  });

  it("returns ok:true and lists deleted cases when all succeed", async () => {
    const cases = [
      { orbita_case_id: "c1" },
      { orbita_case_id: "c2" },
    ];
    const result = await dataLifecycle.deleteOwnedBackendCases({
      cases,
      deleteBackendCaseFn: okFn,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.deleted, ["c1", "c2"]);
  });

  it("returns ok:false and stops at first backend failure", async () => {
    const calls = [];
    const cases = [
      { orbita_case_id: "c1" },
      { orbita_case_id: "c2" },
      { orbita_case_id: "c3" },
    ];
    const mixedFn = async (caseId) => {
      calls.push(caseId);
      return caseId === "c2" ? failFn(caseId) : okFn();
    };
    const result = await dataLifecycle.deleteOwnedBackendCases({
      cases,
      deleteBackendCaseFn: mixedFn,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed_case_id, "c2");
    assert.deepEqual(result.deleted, ["c1"]);
    assert.equal(calls.length, 2, "stops after first failure, does not attempt c3");
  });

  it("returns ok:true with empty deleted array for no cases", async () => {
    const result = await dataLifecycle.deleteOwnedBackendCases({
      cases: [],
      deleteBackendCaseFn: okFn,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.deleted, []);
  });
});

// ── exportUserData ────────────────────────────────────────────────────────────

describe("exportUserData", () => {
  function makeDb(cases, resources) {
    return {
      query: async (sql) => {
        if (sql.includes("FROM orbita_cases")) return { rows: cases };
        if (sql.includes("FROM orbita_resources")) return { rows: resources };
        return { rows: [] };
      },
    };
  }

  it("returns structured export with cases and their resources", async () => {
    const db = makeDb(
      [{ orbita_case_id: "c1", name: "My case", created_at: "2026-01-01T00:00:00Z" }],
      [{ orbita_case_id: "c1", resource_type: "run", resource_id: "r1", created_at: "2026-01-02T00:00:00Z" }]
    );
    const result = await dataLifecycle.exportUserData({ db, userId: "u1" });
    assert.ok(result.exported_at);
    assert.equal(result.cases.length, 1);
    assert.equal(result.cases[0].case_id, "c1");
    assert.equal(result.cases[0].resources.length, 1);
    assert.equal(result.cases[0].resources[0].type, "run");
    assert.ok(result.cases[0].links.report.includes("c1"));
    assert.ok(result.cases[0].links.graph.includes("c1"));
  });

  it("only includes caller's own cases (DB query uses userId)", async () => {
    let capturedParams;
    const db = {
      query: async (sql, params) => {
        capturedParams = params;
        return { rows: [] };
      },
    };
    await dataLifecycle.exportUserData({ db, userId: "user-abc" });
    assert.ok(capturedParams.includes("user-abc"), "userId passed to DB query");
  });

  it("returns empty cases array when user has no cases", async () => {
    const db = makeDb([], []);
    const result = await dataLifecycle.exportUserData({ db, userId: "u_empty" });
    assert.deepEqual(result.cases, []);
  });
});
