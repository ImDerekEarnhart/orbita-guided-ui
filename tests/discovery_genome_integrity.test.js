"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const db = require("../lib/db");
const {
  buildTournamentManifest,
  buildTournamentRevealReceipt,
  buildTournamentResultReceipt,
  freezeOperator,
  freezeTournament,
  hashJson,
  markTournamentRevealed,
  recordTournamentResult,
} = require("../lib/discoveryGenome");

function contract(overrides = {}) {
  return {
    required_conditions: ["observable response"],
    intervention: { action: "enable" },
    kill_switch: { action: "disable" },
    recovery_test: { action: "restore" },
    held_out_prediction: { metric: "effect" },
    expected_failure_signature: { signature: "no restoration" },
    domains_tested: ["hardware"],
    independence_level: "cross_domain",
    claims_affected: ["claim-a"],
    ...overrides,
  };
}

function prediction() {
  return {
    target: "hidden target",
    expected_pattern: "effect appears",
    vanish_condition: "mechanism disabled",
    restoration_condition: "mechanism restored",
    permanent_refuter: "effect never changes",
    claims_affected: ["claim-a"],
  };
}

async function withClient(client, fn) {
  const original = db.connect;
  db.connect = async () => client;
  try {
    await fn();
  } finally {
    db.connect = original;
  }
}

describe("Discovery Genome irreversible-action integrity", { concurrency: false }, () => {
  it("rejects a changed operator hash under the same lock before UPDATE", async () => {
    const sql = [];
    const client = {
      async query(statement) {
        sql.push(statement);
        if (/SELECT \* FROM discovery_operators/.test(statement)) {
          return { rows: [{
            id: "operator-1",
            user_id: "user-1",
            status: "review_needed",
            contract_json: contract({ domains_tested: ["changed"] }),
          }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const reviewedHash = hashJson(contract());

    await withClient(client, async () => {
      await assert.rejects(
        freezeOperator("user-1", "operator-1", reviewedHash),
        /Operator review hash mismatch/
      );
    });

    assert.equal(sql.some(statement => /UPDATE discovery_operators/.test(statement)), false);
    assert.equal(sql.at(-1), "ROLLBACK");
  });

  it("rejects a changed tournament manifest under the lock before UPDATE", async () => {
    const tournament = {
      id: "tournament-1",
      user_id: "user-1",
      name: "Blind challenge",
      status: "draft",
      target_json: { domain: "hardware" },
    };
    const entries = ["a", "b"].map(key => ({
      id: `entry-${key}`,
      operator_id: `operator-${key}`,
      operator_key: `operator-${key}`,
      operator_version: 1,
      contract_hash: key.repeat(64),
      prediction_hash: key.repeat(64),
      prediction_json: prediction(),
    }));
    const reviewed = buildTournamentManifest({ tournament, entries });
    const changedEntries = entries.map((entry, index) => (
      index ? entry : { ...entry, prediction_json: { ...prediction(), expected_pattern: "changed" } }
    ));
    const sql = [];
    const client = {
      async query(statement) {
        sql.push(statement);
        if (/SELECT \* FROM discovery_tournaments/.test(statement)) return { rows: [tournament] };
        if (/FROM discovery_tournament_entries e/.test(statement)) return { rows: changedEntries };
        return { rows: [] };
      },
      release() {},
    };

    await withClient(client, async () => {
      await assert.rejects(
        freezeTournament("user-1", "tournament-1", hashJson(reviewed)),
        /Tournament review hash mismatch/
      );
    });

    assert.equal(sql.some(statement => /UPDATE discovery_tournaments/.test(statement)), false);
    assert.equal(sql.at(-1), "ROLLBACK");
  });

  it("binds a result receipt to tournament and entry IDs", () => {
    const common = { verdict: "survived", result: { observed: "effect vanished" } };
    const first = hashJson(buildTournamentResultReceipt({
      tournamentId: "tournament-1",
      entryId: "entry-1",
      ...common,
    }));
    const otherEntry = hashJson(buildTournamentResultReceipt({
      tournamentId: "tournament-1",
      entryId: "entry-2",
      ...common,
    }));
    const otherTournament = hashJson(buildTournamentResultReceipt({
      tournamentId: "tournament-2",
      entryId: "entry-1",
      ...common,
    }));

    assert.notEqual(first, otherEntry);
    assert.notEqual(first, otherTournament);
  });

  it("persists and returns the exact target-bound result hash", async () => {
    const result = { observed: "effect vanished" };
    const expected = hashJson(buildTournamentResultReceipt({
      tournamentId: "tournament-1",
      entryId: "entry-1",
      verdict: "survived",
      result,
    }));
    const queries = [];
    const client = {
      async query(statement, values) {
        queries.push({ statement, values });
        if (/SELECT e\.\*, t\.status/.test(statement)) {
          return { rows: [{
            id: "entry-1",
            tournament_id: "tournament-1",
            verdict: "pending",
            tournament_status: "revealed",
          }] };
        }
        if (/UPDATE discovery_tournament_entries/.test(statement)) {
          return { rows: [{
            id: "entry-1",
            tournament_id: "tournament-1",
            verdict: "survived",
            result_json: result,
            result_hash: values[2],
          }] };
        }
        return { rows: [] };
      },
      release() {},
    };

    let saved;
    await withClient(client, async () => {
      saved = await recordTournamentResult("user-1", "tournament-1", "entry-1", {
        verdict: "survived",
        result,
        expected_result_hash: expected,
      });
    });

    assert.equal(saved.result_hash, expected);
    const update = queries.find(item => /UPDATE discovery_tournament_entries/.test(item.statement));
    assert.equal(update.values[2], expected);
    assert.deepEqual(update.values.slice(3), ["entry-1", "tournament-1"]);
  });

  it("marks a frozen tournament revealed without changing the manifest hash", async () => {
    const reveal = { external_commitment: "benchmark revealed and scored", revealed_by: "admin" };
    const manifestHash = "7".repeat(64);
    const expectedRevealHash = hashJson(buildTournamentRevealReceipt({
      tournamentId: "tournament-1",
      manifestHash,
      reveal,
    }));
    const queries = [];
    const client = {
      async query(statement, values) {
        queries.push({ statement, values });
        if (/SELECT \* FROM discovery_tournaments/.test(statement)) {
          return { rows: [{
            id: "tournament-1",
            user_id: "user-1",
            status: "frozen",
            manifest_hash: manifestHash,
            reveal_hash: null,
          }] };
        }
        if (/UPDATE discovery_tournaments/.test(statement)) {
          return { rows: [{
            id: "tournament-1",
            user_id: "user-1",
            status: "revealed",
            manifest_hash: manifestHash,
            reveal_json: reveal,
            reveal_hash: values[1],
            revealed_at: "2026-08-15T00:00:00.000Z",
          }] };
        }
        return { rows: [] };
      },
      release() {},
    };

    let saved;
    await withClient(client, async () => {
      saved = await markTournamentRevealed("user-1", "tournament-1", {
        expected_manifest_hash: manifestHash,
        reveal,
        expected_reveal_hash: expectedRevealHash,
      });
    });

    assert.equal(saved.status, "revealed");
    assert.equal(saved.manifest_hash, manifestHash);
    assert.equal(saved.reveal_hash, expectedRevealHash);
    const update = queries.find(item => /UPDATE discovery_tournaments/.test(item.statement));
    assert.match(update.statement, /status = CASE WHEN status = 'frozen' THEN 'revealed'/);
    assert.deepEqual(update.values.slice(2), ["tournament-1", "user-1"]);
  });

  it("fails closed when recording a result before the explicit reveal transition", async () => {
    const result = { observed: "effect vanished" };
    const expected = hashJson(buildTournamentResultReceipt({
      tournamentId: "tournament-1",
      entryId: "entry-1",
      verdict: "refuted",
      result,
    }));
    const queries = [];
    const client = {
      async query(statement, values) {
        queries.push({ statement, values });
        if (/SELECT e\.\*, t\.status/.test(statement)) {
          return { rows: [{
            id: "entry-1",
            tournament_id: "tournament-1",
            verdict: "pending",
            tournament_status: "frozen",
          }] };
        }
        return { rows: [] };
      },
      release() {},
    };

    await withClient(client, async () => {
      await assert.rejects(
        recordTournamentResult("user-1", "tournament-1", "entry-1", {
          verdict: "refuted",
          result,
          expected_result_hash: expected,
        }),
        /Pending revealed tournament entry not found/
      );
    });

    assert.equal(
      queries.some(item => /UPDATE discovery_tournament_entries/.test(item.statement)),
      false
    );
  });

  it("records reviewed results after an explicit revealed state", async () => {
    const result = { observed: "effect vanished" };
    const expected = hashJson(buildTournamentResultReceipt({
      tournamentId: "tournament-1",
      entryId: "entry-1",
      verdict: "refuted",
      result,
    }));
    const client = {
      async query(statement, values) {
        if (/SELECT e\.\*, t\.status/.test(statement)) {
          return { rows: [{
            id: "entry-1",
            tournament_id: "tournament-1",
            verdict: "pending",
            tournament_status: "revealed",
          }] };
        }
        if (/UPDATE discovery_tournament_entries/.test(statement)) {
          return { rows: [{
            id: "entry-1",
            tournament_id: "tournament-1",
            verdict: "refuted",
            result_json: result,
            result_hash: values[2],
          }] };
        }
        return { rows: [] };
      },
      release() {},
    };

    let saved;
    await withClient(client, async () => {
      saved = await recordTournamentResult("user-1", "tournament-1", "entry-1", {
        verdict: "refuted",
        result,
        expected_result_hash: expected,
      });
    });

    assert.equal(saved.result_hash, expected);
  });
});
