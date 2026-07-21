"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_OPERATORS } = require("../lib/discoveryGenomeSeeds");
const { hashJson, validateOperatorContract } = require("../lib/discoveryGenome");

describe("Discovery Genome seed library", () => {
  it("contains exactly the seven cross-domain operator families", () => {
    assert.equal(DEFAULT_OPERATORS.length, 7);
    assert.deepEqual(
      DEFAULT_OPERATORS.map(item => item.operator_key).sort(),
      [
        "artifact-mimicry-detection",
        "boundary-first-discovery",
        "executable-meaning",
        "forcing-versus-capacity",
        "kill-switch-validation",
        "local-to-global-forcing",
        "scale-normalized-invariance",
      ]
    );
  });

  it("uses unique stable keys and names", () => {
    assert.equal(new Set(DEFAULT_OPERATORS.map(item => item.operator_key)).size, 7);
    assert.equal(new Set(DEFAULT_OPERATORS.map(item => item.name)).size, 7);
  });

  it("gives every operator an executable, hashable contract", () => {
    for (const operator of DEFAULT_OPERATORS) {
      const contract = validateOperatorContract(operator.contract);
      assert.ok(contract.required_conditions.length > 0, operator.operator_key);
      assert.ok(contract.kill_switch.action, operator.operator_key);
      assert.ok(contract.recovery_test.action, operator.operator_key);
      assert.ok(contract.held_out_prediction.requirement, operator.operator_key);
      assert.ok(contract.expected_failure_signature.permanent_refuter, operator.operator_key);
      assert.match(hashJson(contract), /^[0-9a-f]{64}$/);
    }
  });

  it("does not seed any operator as proven or already frozen", () => {
    for (const operator of DEFAULT_OPERATORS) {
      assert.equal(operator.status, undefined);
      assert.equal(operator.contract_hash, undefined);
    }
  });
});
