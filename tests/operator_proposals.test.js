"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { proposeOperators } = require("../lib/operatorProposals.js");

describe("Phase 2D-A operator proposal heuristics", () => {
  it("returns no proposals with evidence from fewer than two cases", () => {
    const proposals = proposeOperators({
      graphId: "graph_one",
      claims: [
        { claim_id: "c1", case_id: "case_a", finding_type: "robust_relation" },
      ],
      counterexamples: [],
      summary: { observations_by_case: { case_a: 4 } },
    });
    assert.deepEqual(proposals, []);
  });

  it("proposes reviewable candidates for repeated cross-case claim patterns", () => {
    const proposals = proposeOperators({
      graphId: "graph_two",
      claims: [
        { claim_id: "c1", case_id: "case_a", finding_type: "robust_relation" },
        { claim_id: "c2", case_id: "case_b", finding_type: "robust_relation" },
      ],
      counterexamples: [],
      summary: {
        observations_by_case: { case_a: 4, case_b: 4 },
        claims_by_verdict: { committed: 2 },
      },
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].status, "proposed");
    assert.deepEqual(proposals[0].supporting_case_ids, ["case_a", "case_b"]);
    assert.deepEqual(proposals[0].supporting_claim_ids, ["c1", "c2"]);
    assert.ok(proposals[0].operator_id.startsWith("op_"));
  });

  it("marks repeated counterexample signatures as review_needed", () => {
    const proposals = proposeOperators({
      graphId: "graph_three",
      claims: [
        { claim_id: "c1", case_id: "case_a", finding_type: "not_supported_candidate" },
        { claim_id: "c2", case_id: "case_b", finding_type: "not_supported_candidate" },
      ],
      counterexamples: [
        { id: "cx1", case_id: "case_a", claim_id: "c1", found_by: "held_out_resample" },
        { id: "cx2", case_id: "case_b", claim_id: "c2", found_by: "held_out_resample" },
      ],
      summary: { observations_by_case: { case_a: 4, case_b: 4 } },
    });
    assert.ok(proposals.some(op => op.status === "review_needed"));
    assert.ok(proposals.some(op => op.counterexample_ids.includes("cx1") && op.counterexample_ids.includes("cx2")));
  });
});
