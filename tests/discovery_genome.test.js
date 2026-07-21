"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildTournamentManifest,
  canonicalJson,
  hashJson,
  validateOperatorContract,
  validatePrediction,
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
