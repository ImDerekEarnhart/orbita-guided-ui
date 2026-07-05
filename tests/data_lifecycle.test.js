"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const lifecycle = require("../lib/dataLifecycle.js");

describe("data lifecycle helpers", () => {
  it("deleteBackendCase calls backend DELETE and returns parsed JSON", async () => {
    const calls = [];
    const result = await lifecycle.deleteBackendCase({
      baseUrl: "https://backend.test/",
      authHeader: "Basic redacted",
      caseId: "case_123",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ deleted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { deleted: true });
    assert.equal(calls[0].url, "https://backend.test/cases/case_123");
    assert.equal(calls[0].options.method, "DELETE");
  });

  it("deleteOwnedBackendCases stops on first backend failure", async () => {
    const seen = [];
    const result = await lifecycle.deleteOwnedBackendCases({
      cases: [{ orbita_case_id: "case_a" }, { orbita_case_id: "case_b" }],
      deleteBackendCaseFn: async caseId => {
        seen.push(caseId);
        return caseId === "case_a"
          ? { ok: true, status: 200 }
          : { ok: false, status: 500, body: { error: "nope" } };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.failed_case_id, "case_b");
    assert.deepEqual(result.deleted, ["case_a"]);
    assert.deepEqual(seen, ["case_a", "case_b"]);
  });

  it("cleanupFrontendCase removes rows inside a transaction", async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rowCount: sql.startsWith("DELETE") ? 1 : 0 };
      },
      release() {
        queries.push({ sql: "RELEASE" });
      },
    };
    const db = { connect: async () => client };

    const result = await lifecycle.cleanupFrontendCase({ db, userId: "user_1", caseId: "case_1" });

    assert.equal(result.run_jobs, 1);
    assert.equal(result.resources, 1);
    assert.equal(result.operator_proposals, 1);
    assert.equal(result.datasets, 1);
    assert.equal(result.graph_case_links, 1);
    assert.equal(result.cases, 1);
    assert.equal(queries[0].sql, "BEGIN");
    assert.equal(queries.at(-2).sql, "COMMIT");
    assert.equal(queries.at(-1).sql, "RELEASE");
  });

  it("recordResourceOrFail throws a safe error and audits on failure", async () => {
    const auditEvents = [];
    await assert.rejects(
      lifecycle.recordResourceOrFail({
        ownership: { recordResource: async () => { throw new Error("database detail"); } },
        audit: (...args) => auditEvents.push(args),
        req: { id: "request" },
        userId: "user_1",
        caseId: "case_1",
        resourceType: "file",
        resourceId: "file_1",
      }),
      /Resource ownership recording failed\./,
    );
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0][1], "resource_ownership_record_failed");
  });

  it("exportUserData returns only the user's case/resource metadata", async () => {
    const db = {
      async query(sql) {
        if (sql.includes("FROM orbita_cases")) {
          return { rows: [{ orbita_case_id: "case_a", name: "A", created_at: "now" }] };
        }
        if (sql.includes("FROM orbita_resources")) {
          return {
            rows: [
              { orbita_case_id: "case_a", resource_type: "file", resource_id: "file_a", created_at: "now" },
              { orbita_case_id: "case_other", resource_type: "file", resource_id: "file_other", created_at: "now" },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const result = await lifecycle.exportUserData({ db, userId: "user_1" });
    assert.equal(result.cases.length, 1);
    assert.equal(result.cases[0].case_id, "case_a");
    assert.deepEqual(result.cases[0].resources, [{ type: "file", id: "file_a", created_at: "now" }]);
    assert.ok(result.cases[0].links.report.includes("case_a"));
  });
});
