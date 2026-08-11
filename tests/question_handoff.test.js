"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildQuestionCase, handoffHash } = require("../lib/questionHandoff");

function acceptedQuestion(overrides = {}) {
  return {
    question_id: "q_artifact_independence",
    question_text: "Which retained relationship survives an independent holdout test?",
    question_class: "replication",
    status: "admissible",
    review_status: "accepted_candidate",
    programme_state_snapshot_id: "snap_1",
    evidence_refs: ["claim_1"],
    counterexample_refs: ["cx_1"],
    trace_event_refs: ["trace_1"],
    related_operator_refs: ["artifact_mimicry"],
    ...overrides,
  };
}

test("buildQuestionCase freezes an accepted admissible question into a bounded case goal", () => {
  const question = acceptedQuestion();
  const result = buildQuestionCase(question, "graph_1", { domainHint: "blind reconstruction" });
  assert.match(result.backend.name, /^Question:/);
  assert.match(result.backend.goal, /question to test, not as an established claim/);
  assert.match(result.backend.goal, /Counterexample references: cx_1/);
  assert.match(result.backend.goal, new RegExp(handoffHash(question, "graph_1")));
  assert.equal(result.backend.domain_hint, "blind reconstruction");
  assert.equal(result.provenance.question_id, question.question_id);
});

test("buildQuestionCase rejects questions that are blocked or not human-accepted", () => {
  assert.throws(
    () => buildQuestionCase(acceptedQuestion({ status: "blocked" }), "graph_1"),
    /classified as admissible/
  );
  assert.throws(
    () => buildQuestionCase(acceptedQuestion({ review_status: "proposed" }), "graph_1"),
    /Accept this question/
  );
});
