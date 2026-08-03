"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../lib/db");
const quota = require("../lib/quota");
const queue = require("../lib/queue");

test("enqueue rejects a pg-boss singleton collision instead of creating a ghost run", async () => {
  const queries = [];
  const originalQuery = db.query;
  db.query = async (...args) => { queries.push(args); return { rowCount: 1, rows: [] }; };
  queue._setBossForTests({ send: async () => null });

  try {
    await assert.rejects(
      queue.enqueueRun("run-2", "user-1", "case-2", {}),
      /already queued/
    );
    assert.equal(queries.length, 0);
  } finally {
    db.query = originalQuery;
    queue._setBossForTests(null);
  }
});

test("enqueue binds the pg-boss job id and payload to the exact frontend run id", async () => {
  const queries = [];
  let sent;
  const originalQuery = db.query;
  db.query = async (...args) => { queries.push(args); return { rowCount: 1, rows: [] }; };
  queue._setBossForTests({
    send: async (...args) => { sent = args; return "boss-123"; },
  });

  try {
    const jobId = await queue.enqueueRun("run-123", "user-1", "case-1", { graph_id: "g-1" });
    assert.equal(jobId, "boss-123");
    assert.equal(sent[1].runId, "run-123");
    assert.deepEqual(queries[0][1], ["boss-123", "run-123", "user-1"]);
  } finally {
    db.query = originalQuery;
    queue._setBossForTests(null);
  }
});

test("worker updates only the run id carried by the claimed job", async () => {
  const queries = [];
  const originalQuery = db.query;
  const originalIncrement = quota.incrementConcurrentRuns;
  const originalFinish = quota.finishRun;
  const originalFetch = global.fetch;

  db.query = async (...args) => {
    queries.push(args);
    return { rowCount: 1, rows: [] };
  };
  quota.incrementConcurrentRuns = async () => {};
  quota.finishRun = async () => {};
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ run_id: "backend-run", findings: [] }),
  });

  try {
    const result = await queue._processRunJob({
      id: "boss-123",
      data: { runId: "run-123", userId: "user-1", orbitaCaseId: "case-1", runOptions: {} },
    });
    assert.equal(result, "backend-run");
    assert.deepEqual(queries[0][1], ["boss-123", "run-123", "case-1", "user-1"]);
    assert.deepEqual(queries[1][1].slice(1), ["run-123", "user-1"]);
  } finally {
    db.query = originalQuery;
    quota.incrementConcurrentRuns = originalIncrement;
    quota.finishRun = originalFinish;
    global.fetch = originalFetch;
  }
});
