"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../lib/db");

const {
  addTournamentEntry,
  buildTournamentManifest,
  canonicalJson,
  classifyTournamentEntryError,
  hashJson,
  PREDICTION_BUNDLE_SCHEMA,
  validateOperatorContract,
  validatePrediction,
  validatePredictionForTournament,
} = require("../lib/discoveryGenome");

function contract(overrides = {}) {
  return {
    required_conditions: ["observable response", "repeatable intervention"],
    intervention: { action: "enable suspected mechanism" },
    kill_switch: { action: "disable suspected mechanism", expected: "effect vanishes" },
    recovery_test: { action: "restore mechanism", expected: "effect returns" },
    held_out_prediction: { metric: "effect_size", direction: "positive" },
    expected_failure_signature: { signature: "no restoration after re-enable" },
    domains_tested: ["physical hardware"],
    independence_level: "cross_domain",
    claims_affected: ["claim_a"],
    ...overrides,
  };
}

function prediction(overrides = {}) {
  return {
    target: "unseen sensor system",
    expected_pattern: "response rises when pathway is enabled",
    vanish_condition: "pathway is physically disconnected",
    restoration_condition: "pathway is reconnected",
    permanent_refuter: "held-out response persists unchanged while disconnected",
    claims_affected: ["claim_a", "claim_b"],
    ...overrides,
  };
}

function sixWorldTarget() {
  return {
    benchmark_version: "0.1",
    worlds: Array.from({ length: 6 }, (_, index) => ({
      world_id: `RH-0${index + 1}`,
      visible_problem: `Visible problem ${index + 1}`,
    })),
  };
}

function predictionBundle(overrides = {}) {
  return {
    schema: PREDICTION_BUNDLE_SCHEMA,
    world_predictions: sixWorldTarget().worlds.map((world, index) => ({
      world_id: world.world_id,
      classification: index < 4 ? "HOLE" : "NO_HOLE",
      factorization_claim: "The target is tested against the frozen visible language.",
      candidate_recovery_primitive: index < 4 ? "Add one preregistered separating primitive." : "REFUSE_NEW_PRIMITIVE",
      permanent_refuter: "A held-out same-language test contradicts this classification.",
      scope_boundary: "This is a language-relative claim and not a metaphysical conclusion.",
      confidence: 0.7,
    })),
    claims_affected: [],
    ...overrides,
  };
}

describe("Discovery Genome canonical receipts", () => {
  it("hashes semantically identical objects identically regardless of key order", () => {
    const a = { z: 2, a: { y: 3, x: 1 } };
    const b = { a: { x: 1, y: 3 }, z: 2 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(hashJson(a), hashJson(b));
    assert.match(hashJson(a), /^[0-9a-f]{64}$/);
  });

  it("changes the receipt when a frozen prediction changes", () => {
    assert.notEqual(
      hashJson(prediction()),
      hashJson(prediction({ permanent_refuter: "a different decisive failure" }))
    );
  });
});

describe("Discovery Genome operator contracts", () => {
  it("accepts the executable operator fields needed for transfer tests", () => {
    const normalized = validateOperatorContract(contract());
    assert.equal(normalized.independence_level, "cross_domain");
    assert.deepEqual(normalized.domains_tested, ["physical hardware"]);
  });

  it("rejects a prose-only operator with no kill switch", () => {
    const invalid = contract();
    delete invalid.kill_switch;
    assert.throws(() => validateOperatorContract(invalid), /kill_switch is required/);
  });

  it("rejects unknown independence labels", () => {
    assert.throws(
      () => validateOperatorContract(contract({ independence_level: "universal" })),
      /independence_level is invalid/
    );
  });

  it("deduplicates string-list fields without changing their order", () => {
    const normalized = validateOperatorContract(contract({
      domains_tested: ["hardware", "biology", "hardware"],
    }));
    assert.deepEqual(normalized.domains_tested, ["hardware", "biology"]);
  });
});

describe("Discovery Genome blind predictions", () => {
  it("requires an exact vanish, restoration, and permanent-refutation condition", () => {
    const normalized = validatePrediction(prediction());
    assert.match(normalized.vanish_condition, /disconnected/);
    assert.match(normalized.restoration_condition, /reconnected/);
    assert.match(normalized.permanent_refuter, /persists unchanged/);
  });

  it("rejects a prediction that cannot permanently fail", () => {
    const invalid = prediction();
    delete invalid.permanent_refuter;
    assert.throws(() => validatePrediction(invalid), /permanent_refuter is required/);
  });

  it("accepts and canonically orders a complete target-bound six-world bundle", () => {
    const input = predictionBundle();
    input.world_predictions.reverse();
    input.world_predictions[0].hole_classification = input.world_predictions[0].classification;
    delete input.world_predictions[0].classification;
    const normalized = validatePredictionForTournament(input, sixWorldTarget());
    assert.equal(normalized.schema, PREDICTION_BUNDLE_SCHEMA);
    assert.equal(normalized.world_predictions.length, 6);
    assert.equal(normalized.world_predictions[0].world_id, "RH-01");
    assert.equal(normalized.world_predictions[5].classification, "NO_HOLE");
  });

  it("fails closed when a prediction bundle omits or invents a target world", () => {
    const input = predictionBundle();
    input.world_predictions.pop();
    input.world_predictions.push({
      ...input.world_predictions[0],
      world_id: "RH-99",
    });
    assert.throws(
      () => validatePredictionForTournament(input, sixWorldTarget()),
      /coverage must exactly match.*missing=RH-06.*extra=RH-99/
    );
  });

  it("fails closed on duplicate worlds and non-binary hole classifications", () => {
    const duplicate = predictionBundle();
    duplicate.world_predictions[1].world_id = "RH-01";
    assert.throws(
      () => validatePredictionForTournament(duplicate, sixWorldTarget()),
      /world_id RH-01 is duplicated/
    );
    const invalid = predictionBundle();
    invalid.world_predictions[0].classification = "MAYBE";
    assert.throws(
      () => validatePredictionForTournament(invalid, sixWorldTarget()),
      /must be HOLE or NO_HOLE/
    );
  });

  it("distinguishes invalid prediction payloads from real attachment conflicts", () => {
    assert.deepEqual(
      classifyTournamentEntryError(new Error("prediction.world_predictions[0].scope_boundary is required")),
      {
        status: 422,
        code: "invalid_prediction",
        error: "prediction.world_predictions[0].scope_boundary is required",
      }
    );
    assert.deepEqual(classifyTournamentEntryError({ code: "23505" }), {
      status: 409,
      code: "duplicate_operator_entry",
      error: "This operator is already attached to the tournament.",
    });
  });

  it("attaches a complete world bundle after binding it to the draft tournament target", async () => {
    const originalQuery = db.query;
    const originalConnect = db.connect;
    const queries = [];
    const transactionQueries = [];
    db.query = async (sql, values) => {
      queries.push({ sql, values });
      return { rows: [{ target_json: sixWorldTarget() }] };
    };
    db.connect = async () => ({
      async query(sql, values) {
        transactionQueries.push({ sql, values });
        if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [] };
        if (/SELECT id FROM discovery_tournaments/.test(sql)) {
          return { rows: [{ id: "tournament-1" }] };
        }
        const stored = JSON.parse(values[3]);
        return {
          rows: [{
            id: "entry-1",
            tournament_id: values[0],
            operator_id: values[2],
            prediction_json: stored,
            prediction_hash: values[4],
            claims_affected: values[5],
          }],
        };
      },
      release() {},
    });
    try {
      const entry = await addTournamentEntry("user-1", "tournament-1", {
        operator_id: "operator-1",
        prediction: predictionBundle(),
      });
      assert.equal(queries.length, 1);
      assert.match(queries[0].sql, /t\.status = 'draft'.*o\.status = 'frozen'/s);
      assert.match(transactionQueries[1].sql, /status = 'draft' FOR UPDATE/);
      assert.equal(entry.prediction_json.world_predictions.length, 6);
      assert.equal(entry.prediction_json.schema, PREDICTION_BUNDLE_SCHEMA);
      assert.match(entry.prediction_hash, /^[0-9a-f]{64}$/);
    } finally {
      db.query = originalQuery;
      db.connect = originalConnect;
    }
  });

  it("builds a deterministic manifest ordered by operator identity", () => {
    const tournament = {
      id: "tournament_1",
      name: "Derek Blind Discovery Challenge",
      target_json: { dataset: "hidden", domain: "mechanical" },
    };
    const entryA = {
      id: "entry_a",
      operator_id: "operator_a",
      operator_key: "kill-switch-validation",
      operator_version: 1,
      contract_hash: "a".repeat(64),
      prediction_hash: "b".repeat(64),
      prediction_json: prediction(),
      verdict: "pending",
      result_json: null,
    };
    const entryB = {
      ...entryA,
      id: "entry_b",
      operator_id: "operator_b",
      operator_key: "boundary-first-discovery",
      contract_hash: "c".repeat(64),
      prediction_hash: "d".repeat(64),
    };
    const forward = buildTournamentManifest({ tournament, entries: [entryA, entryB] });
    const reverse = buildTournamentManifest({ tournament, entries: [entryB, entryA] });
    assert.deepEqual(forward, reverse);
    assert.equal(forward.entries[0].operator_id, "operator_a");
    assert.equal("verdict" in forward.entries[0], false);
    assert.equal("result_json" in forward.entries[0], false);
    assert.equal(hashJson(forward), hashJson(reverse));
  });
});
