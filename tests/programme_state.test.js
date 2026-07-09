"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  compileProgrammeState,
  generateQuestionsFromSnapshot,
} = require("../lib/programmeState.js");

function op(overrides = {}) {
  return {
    operator_id: "op_reset",
    name: "Reset Bottleneck",
    supporting_case_ids: ["case_a", "case_b", "case_c"],
    supporting_claim_ids: ["claim_a", "claim_b", "claim_c"],
    counterexample_ids: [],
    evidence_count: 3,
    counterexample_count: 0,
    suspicion_flags: [],
    ...overrides,
  };
}

function compile(input = {}) {
  return compileProgrammeState({
    graphId: "graph_programme",
    traceEvents: [],
    reviews: [],
    operators: [],
    questions: [],
    ...input,
  });
}

describe("Phase 2F-B programme-state compiler", () => {
  it("blocks promotion of failed/rejected naive hypotheses", () => {
    const snapshot = compile({
      operators: [op()],
      reviews: [{ target_type: "operator", target_id: "op_reset", review_status: "rejected" }],
    });
    const questions = generateQuestionsFromSnapshot(snapshot);
    assert.ok(snapshot.rejected_objects.some(item => item.id === "op_reset"));
    assert.ok(snapshot.blocked_claim_classes.some(item => item.class === "promotion_of_rejected_object"));
    assert.ok(questions.some(q => q.status === "blocked" && /rejected/.test(q.why_blocked)));
  });

  it("turns artifact-derived QM9-style warnings into artifact-audit questions, not stronger science claims", () => {
    const snapshot = compile({
      operators: [op({
        operator_id: "op_artifact",
        name: "Artifact Mimicry",
        supporting_case_ids: ["case_qm9", "case_benchmark"],
        supporting_claim_ids: ["claim_formula", "claim_proxy"],
        evidence_count: 68,
        counterexample_count: 0,
        suspicion_flags: ["Artifact-risk operator"],
      })],
    });
    const questions = generateQuestionsFromSnapshot(snapshot);
    assert.ok(snapshot.unresolved_artifact_warnings.length >= 1);
    assert.ok(snapshot.blocked_claim_classes.some(item => item.class === "strong_scientific_claim_from_artifact_risk_object"));
    assert.ok(questions.some(q => q.question_class === "artifact_audit" && q.status === "admissible"));
    assert.ok(!questions.some(q => q.status === "admissible" && /prove|truth|law/i.test(q.question_text)));
  });

  it("makes strong repeated operators admissible as replication/generalization questions", () => {
    const snapshot = compile({ operators: [op({ operator_id: "op_strong", name: "Local-to-Global Forcing" })] });
    const questions = generateQuestionsFromSnapshot(snapshot);
    assert.ok(snapshot.allowed_question_classes.includes("replication"));
    assert.ok(questions.some(q => q.status === "admissible" && ["generalization", "replication"].includes(q.question_class)));
  });

  it("marks dominated-by-one-case operators as needing more evidence", () => {
    const snapshot = compile({
      operators: [op({
        operator_id: "op_dominated",
        supporting_case_ids: ["case_a", "case_b"],
        suspicion_flags: ["Dominated by one case"],
      })],
    });
    const questions = generateQuestionsFromSnapshot(snapshot);
    assert.ok(snapshot.needs_replication.some(item => item.id === "op_dominated"));
    assert.ok(questions.some(q => q.status === "needs_more_evidence" && /dominant/.test(q.question_text)));
  });

  it("blocks dependent questions behind unresolved traceability gaps", () => {
    const snapshot = compile({
      traceEvents: [{
        id: "event_gap",
        event_type: "traceability_gap_found",
        title: "Object has no source lineage",
        source_type: "module",
        source_ref_id: "module_gap",
        module_refs: ["module_gap"],
        admissibility_effect: "requires_traceability_repair",
      }],
    });
    const questions = generateQuestionsFromSnapshot(snapshot);
    assert.equal(snapshot.needs_traceability_repair.length, 1);
    assert.ok(questions.some(q => q.status === "needs_traceability_repair" && q.question_class === "traceability_repair"));
  });

  it("lets traceability repairs close matching gaps", () => {
    const snapshot = compile({
      traceEvents: [
        { id: "event_gap", event_type: "traceability_gap_found", source_type: "module", source_ref_id: "module_gap", module_refs: ["module_gap"], admissibility_effect: "requires_traceability_repair" },
        { id: "event_repair", event_type: "traceability_repaired", source_type: "module", source_ref_id: "module_gap", module_refs: ["module_gap"], admissibility_effect: "permits_question" },
      ],
    });
    assert.equal(snapshot.unresolved_traceability_gaps.length, 0);
  });

  it("accepted_candidate creates next-test questions only", () => {
    const snapshot = compile({
      operators: [op()],
      reviews: [{ target_type: "operator", target_id: "op_reset", review_status: "accepted_candidate" }],
    });
    const questions = generateQuestionsFromSnapshot(snapshot);
    const nextTest = questions.find(q => q.question_class === "replication");
    assert.ok(nextTest);
    assert.equal(nextTest.status, "admissible");
    assert.match(nextTest.why_blocked, /Truth|execution/);
    assert.match(nextTest.provenance.caution, /not true/);
  });

  it("stopping rules narrow allowed next questions", () => {
    const snapshot = compile({
      traceEvents: [{
        id: "event_stop",
        event_type: "stopping_rule_invoked",
        title: "No richer object justified",
        source_type: "programme",
        source_ref_id: "stop_rome",
        admissibility_effect: "records_stopping_point",
      }],
    });
    const questions = generateQuestionsFromSnapshot(snapshot);
    assert.ok(snapshot.blocked_claim_classes.some(item => item.class === "richer_object_beyond_stopping_rule"));
    assert.ok(questions.some(q => q.question_class === "stopping_rule" && q.status === "admissible"));
  });

  it("does not mutate input operators, reviews, trace events, or questions", () => {
    const input = {
      operators: [op()],
      reviews: [{ target_type: "operator", target_id: "op_reset", review_status: "under_review" }],
      traceEvents: [{ id: "event_note", event_type: "method_chosen", title: "Use R2", admissibility_effect: "none" }],
      questions: [],
    };
    const snapshot = JSON.stringify(input);
    const state = compile(input);
    generateQuestionsFromSnapshot(state);
    assert.equal(JSON.stringify(input), snapshot);
  });
});
