"use strict";

/**
 * Integration tests for lib/ownership.js.
 * Requires a live DATABASE_URL environment variable pointing to a PostgreSQL
 * database that has been migrated (node scripts/migrate.js).
 *
 * Run with:
 *   DATABASE_URL=postgres://... node --test tests/ownership.test.js
 *
 * These tests create their own isolated test user and clean up afterward.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

if (!process.env.DATABASE_URL) {
  console.log("⚠  Skipping ownership integration tests — DATABASE_URL not set.");
  process.exit(0);
}

const db        = require("../lib/db.js");
const ownership = require("../lib/ownership.js");
const crypto    = require("node:crypto");

// Helpers
function uid()  { return `test_user_${crypto.randomBytes(6).toString("hex")}`; }
function cid()  { return `case_${crypto.randomBytes(8).toString("hex")}`; }
function rid()  { return `res_${crypto.randomBytes(8).toString("hex")}`; }

// Create a minimal test user directly in the DB (bypasses bcrypt for speed)
async function createTestUser(label = "tester") {
  const email    = `${uid()}@orbita-test.internal`;
  const username = uid();
  const { rows } = await db.query(
    `INSERT INTO users (email, username, password_hash, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [email, username, "$2a$12$placeholder_not_used_in_these_tests"]
  );
  return rows[0].id;
}

async function deleteTestUser(userId) {
  await db.query("DELETE FROM orbita_resources WHERE user_id = $1", [userId]);
  await db.query("DELETE FROM orbita_cases    WHERE user_id = $1", [userId]);
  await db.query("DELETE FROM users           WHERE id      = $1", [userId]);
}

describe("ownership — case recording", () => {
  let userA, userB;

  before(async () => {
    userA = await createTestUser("userA");
    userB = await createTestUser("userB");
  });

  after(async () => {
    await deleteTestUser(userA);
    await deleteTestUser(userB);
  });

  it("recordCase succeeds for a new case", async () => {
    const caseId = cid();
    await assert.doesNotReject(ownership.recordCase(userA, caseId, "Test case"));
  });

  it("checkCaseOwnership returns true for the owning user", async () => {
    const caseId = cid();
    await ownership.recordCase(userA, caseId, "Owned by A");
    const owned = await ownership.checkCaseOwnership(userA, caseId);
    assert.equal(owned, true);
  });

  it("checkCaseOwnership returns false for a different user", async () => {
    const caseId = cid();
    await ownership.recordCase(userA, caseId, "Owned by A only");
    const owned = await ownership.checkCaseOwnership(userB, caseId);
    assert.equal(owned, false);
  });

  it("checkCaseOwnership returns false for an unknown caseId", async () => {
    const owned = await ownership.checkCaseOwnership(userA, cid());
    assert.equal(owned, false);
  });

  it("recordCase is idempotent (ON CONFLICT DO NOTHING)", async () => {
    const caseId = cid();
    await ownership.recordCase(userA, caseId, "First write");
    await assert.doesNotReject(ownership.recordCase(userA, caseId, "Second write (no-op)"));
  });

  it("two different users may NOT own the same backend case", async () => {
    const caseId = cid();
    await ownership.recordCase(userA, caseId, "Claimed by A");
    // Second insert should silently no-op (UNIQUE on orbita_case_id)
    await assert.doesNotReject(ownership.recordCase(userB, caseId, "Attempted by B"));
    // userB must still not own it
    assert.equal(await ownership.checkCaseOwnership(userB, caseId), false);
    // userA's ownership must be intact
    assert.equal(await ownership.checkCaseOwnership(userA, caseId), true);
  });
});

describe("ownership — case listing", () => {
  let userA, userB;

  before(async () => {
    userA = await createTestUser("lister_A");
    userB = await createTestUser("lister_B");
  });

  after(async () => {
    await deleteTestUser(userA);
    await deleteTestUser(userB);
  });

  it("getUserCases returns only the requesting user's cases", async () => {
    const caseA1 = cid(), caseA2 = cid(), caseB1 = cid();
    await ownership.recordCase(userA, caseA1, "A-case-1");
    await ownership.recordCase(userA, caseA2, "A-case-2");
    await ownership.recordCase(userB, caseB1, "B-case-1");

    const casesA = await ownership.getUserCases(userA);
    const casesB = await ownership.getUserCases(userB);

    const idsA = casesA.map(c => c.orbita_case_id);
    const idsB = casesB.map(c => c.orbita_case_id);

    assert.ok(idsA.includes(caseA1), "A should see caseA1");
    assert.ok(idsA.includes(caseA2), "A should see caseA2");
    assert.ok(!idsA.includes(caseB1), "A must not see B's case");

    assert.ok(idsB.includes(caseB1), "B should see caseB1");
    assert.ok(!idsB.includes(caseA1), "B must not see A's cases");
    assert.ok(!idsB.includes(caseA2), "B must not see A's cases");
  });

  it("getUserCases returns an empty array for a user with no cases", async () => {
    const fresh = await createTestUser("empty_user");
    try {
      const cases = await ownership.getUserCases(fresh);
      assert.deepEqual(cases, []);
    } finally {
      await deleteTestUser(fresh);
    }
  });
});

describe("ownership — resource recording", () => {
  let userId;

  before(async () => { userId = await createTestUser("res_owner"); });
  after(async ()  => { await deleteTestUser(userId); });

  it("recordResource succeeds", async () => {
    const caseId = cid(), resId = rid();
    await ownership.recordCase(userId, caseId, "parent case");
    await assert.doesNotReject(ownership.recordResource(userId, caseId, "run", resId));
  });

  it("checkResourceOwnership returns true for the owning user", async () => {
    const caseId = cid(), resId = rid();
    await ownership.recordCase(userId, caseId, "parent");
    await ownership.recordResource(userId, caseId, "run", resId);
    assert.equal(await ownership.checkResourceOwnership(userId, "run", resId), true);
  });

  it("checkResourceOwnership returns false for a different user", async () => {
    const other  = await createTestUser("non_owner");
    const caseId = cid(), resId = rid();
    await ownership.recordCase(userId, caseId, "parent");
    await ownership.recordResource(userId, caseId, "run", resId);
    try {
      assert.equal(await ownership.checkResourceOwnership(other, "run", resId), false);
    } finally {
      await deleteTestUser(other);
    }
  });

  it("checkResourceOwnership returns false for unknown resource", async () => {
    assert.equal(await ownership.checkResourceOwnership(userId, "run", rid()), false);
  });

  it("recordResource is idempotent", async () => {
    const caseId = cid(), resId = rid();
    await ownership.recordCase(userId, caseId, "parent");
    await ownership.recordResource(userId, caseId, "run", resId);
    await assert.doesNotReject(ownership.recordResource(userId, caseId, "run", resId));
  });
});
