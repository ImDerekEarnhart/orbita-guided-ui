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
    const claims = [
      { claim_id: "c1", case_id: "case_a", finding_type: "robust_relation" },
      { claim_id: "c2", case_id: "case_b", finding_type: "robust_relation" },
    ];
    const proposals = proposeOperators({
      graphId: "graph_two",
      claims,
      counterexamples: [],
      summary: {
        observations_by_case: { case_a: 4, case_b: 4 },
        claims_by_verdict: { committed: 2 },
      },
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].status, "review_needed");
    assert.deepEqual(proposals[0].supporting_case_ids, ["case_a", "case_b"]);
    assert.deepEqual(proposals[0].supporting_claim_ids, ["c1", "c2"]);
    assert.ok(proposals[0].operator_id.startsWith("op_"));
    assert.equal(claims[0].finding_type, "robust_relation", "proposal generation must not mutate claims");
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

  it("merges same-name proposals into one clearer card", () => {
    const proposals = proposeOperators({
      graphId: "graph_merge",
      claims: [
        { claim_id: "c1", case_id: "case_a", finding_type: "robust_relation" },
        { claim_id: "c2", case_id: "case_b", finding_type: "robust_relation" },
        { claim_id: "c3", case_id: "case_c", finding_type: "supported_association_candidate" },
        { claim_id: "c4", case_id: "case_d", finding_type: "supported_association_candidate" },
      ],
      counterexamples: [],
      summary: { observations_by_case: { case_a: 4, case_b: 4, case_c: 4, case_d: 4 } },
    });
    const local = proposals.filter(op => op.name === "Local-to-Global Forcing");
    assert.equal(local.length, 1);
    assert.deepEqual(local[0].supporting_case_ids, ["case_a", "case_b", "case_c", "case_d"]);
    assert.equal(local[0].supporting_claim_ids.length, 4);
    assert.equal(local[0].provenance.rule, "merged_same_name_operator_family");
  });

  it("uses non-constant scores and penalizes high counterexample load", () => {
    const goodClaims = Array.from({ length: 80 }, (_, i) => ({
      claim_id: `g${i}`,
      case_id: `case_${i % 5}`,
      finding_type: "ablation_performance",
    }));
    const weakClaims = Array.from({ length: 8 }, (_, i) => ({
      claim_id: `w${i}`,
      case_id: `case_${i % 5}`,
      finding_type: "artifact_guard",
    }));
    const manyCx = Array.from({ length: 60 }, (_, i) => ({
      id: `cx${i}`,
      case_id: `case_${i % 5}`,
      claim_id: `w${i % weakClaims.length}`,
      found_by: "artifact_leakage",
    }));
    const proposals = proposeOperators({
      graphId: "graph_scores",
      claims: [...goodClaims, ...weakClaims],
      counterexamples: manyCx,
      summary: { observations_by_case: { case_0: 4, case_1: 4, case_2: 4, case_3: 4, case_4: 4 } },
    });
    const constraint = proposals.find(op => op.name === "Constraint Amplification");
    const artifact = proposals.find(op => op.name === "Artifact Mimicry");
    assert.ok(constraint && artifact);
    assert.notEqual(constraint.score, artifact.score);
    assert.ok(constraint.score > artifact.score, `${constraint.score} should beat ${artifact.score}`);
    assert.equal(constraint.confidence, "strong candidate");
    assert.equal(artifact.confidence, "weak candidate");
    assert.ok(artifact.caution_labels.some(label => label.includes("High counterexample load")));
    assert.ok(artifact.caution_labels.some(label => label.includes("contamination")));
  });

  it("assigns moderate confidence to mixed evidence", () => {
    const proposals = proposeOperators({
      graphId: "graph_mixed",
      claims: Array.from({ length: 20 }, (_, i) => ({
        claim_id: `m${i}`,
        case_id: `case_${i % 3}`,
        finding_type: "reset_failure_signal",
      })),
      counterexamples: Array.from({ length: 10 }, (_, i) => ({
        id: `mcx${i}`,
        case_id: `case_${i % 3}`,
        found_by: "baseline",
      })),
      summary: { observations_by_case: { case_0: 4, case_1: 4, case_2: 4 } },
    });
    const reset = proposals.find(op => op.name === "Reset Bottleneck");
    assert.ok(reset);
    assert.equal(reset.confidence, "moderate candidate");
    assert.ok(reset.why_proposed.includes("across 3 cases"));
    assert.equal(reset.status, "review_needed");
  });
});
