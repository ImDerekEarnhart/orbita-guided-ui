"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildQuestionCandidates,
  normalizeStatus,
  stableQuestionId,
} = require("../lib/reviewTrace.js");

function op(overrides = {}) {
  return {
    operator_id: "op_reset",
    graph_id: "graph_a",
    name: "Reset Bottleneck",
    supporting_case_ids: ["case_a", "case_b"],
    supporting_claim_ids: ["claim_a", "claim_b", "claim_c"],
    counterexample_ids: [],
    evidence_count: 3,
    counterexample_count: 0,
    suspicion_flags: [],
    ...overrides,
  };
}

describe("Phase 2D-B / 2F-A review trace heuristics", () => {
  it("accepts only review statuses that remain candidate/review semantics", () => {
    assert.equal(normalizeStatus("accepted_candidate"), "accepted_candidate");
    assert.throws(() => normalizeStatus("proven"), /Invalid review status/);
  });

  it("frames Artifact Mimicry as an artifact-risk audit question", () => {
    const questions = buildQuestionCandidates({
      graphId: "graph_artifact",
      operators: [op({
        operator_id: "op_artifact",
        name: "Artifact Mimicry",
        evidence_count: 68,
        counterexample_count: 0,
        supporting_claim_ids: ["claim_1", "claim_2"],
      })],
    });
    assert.equal(questions.length, 1);
    assert.equal(questions[0].status, "admissible");
    assert.match(questions[0].question_text, /leakage|derived variables|contamination/);
    assert.match(questions[0].why_blocked, /Do not promote/);
  });

  it("turns accepted_candidate into an admissible follow-up test, not proof", () => {
    const questions = buildQuestionCandidates({
      graphId: "graph_reviewed",
      operators: [op()],
      reviews: [{ target_type: "operator", target_id: "op_reset", review_status: "accepted_candidate" }],
    });
    assert.equal(questions[0].status, "admissible");
    assert.match(questions[0].why_allowed, /accepted only as a candidate/);
    assert.match(questions[0].provenance.caution, /not true/);
  });

  it("blocks rejected operators from stronger promotion", () => {
    const questions = buildQuestionCandidates({
      graphId: "graph_rejected",
      operators: [op()],
      reviews: [{ target_type: "operator", target_id: "op_reset", review_status: "rejected" }],
    });
    assert.equal(questions[0].status, "blocked");
    assert.match(questions[0].why_blocked, /rejected/);
  });

  it("uses counterexample load and dominance flags to require more evidence", () => {
    const highCx = buildQuestionCandidates({
      graphId: "graph_cx",
      operators: [op({ counterexample_count: 3, counterexample_ids: ["cx1", "cx2", "cx3"] })],
    });
    assert.equal(highCx[0].status, "needs_more_evidence");
    assert.match(highCx[0].why_blocked, /counterexamples/);

    const dominated = buildQuestionCandidates({
      graphId: "graph_dom",
      operators: [op({ operator_id: "op_dom", suspicion_flags: ["Dominated by one case"] })],
    });
    assert.equal(dominated[0].status, "needs_more_evidence");
    assert.match(dominated[0].question_text, /dominant/);
  });

  it("turns traceability gaps into repair questions", () => {
    const questions = buildQuestionCandidates({
      graphId: "graph_trace",
      traceEvents: [{
        id: "event_gap",
        event_type: "traceability_gap_found",
        admissibility_effect: "requires_traceability_repair",
        module_refs: ["module_a"],
      }],
    });
    assert.equal(questions[0].status, "needs_traceability_repair");
    assert.deepEqual(questions[0].related_module_refs, ["module_a"]);
  });

  it("does not mutate operators or reviews while generating questions", () => {
    const operators = [op()];
    const reviews = [{ target_type: "operator", target_id: "op_reset", review_status: "under_review" }];
    const snapshot = JSON.stringify({ operators, reviews });
    buildQuestionCandidates({ graphId: "graph_readonly", operators, reviews });
    assert.equal(JSON.stringify({ operators, reviews }), snapshot);
  });

  it("uses stable question ids", () => {
    const a = stableQuestionId("graph_a", "Does X replicate?", { related_operator_refs: ["op_a"] });
    const b = stableQuestionId("graph_a", "Does X replicate?", { related_operator_refs: ["op_a"] });
    assert.equal(a, b);
    assert.ok(a.startsWith("q_"));
  });
});
