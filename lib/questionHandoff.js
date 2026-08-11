"use strict";

const crypto = require("node:crypto");

function compactText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function assertMaterializable(question) {
  if (!question || !String(question.question_text || "").trim()) {
    throw new Error("Question not found.");
  }
  if (question.status !== "admissible") {
    throw new Error("Only a question classified as admissible can become an Orbita case.");
  }
  if (question.review_status !== "accepted_candidate") {
    throw new Error("Accept this question as a candidate before creating an Orbita case.");
  }
}

function handoffHash(question, graphId) {
  const frozen = {
    graph_id: graphId,
    question_id: question.question_id,
    question_text: question.question_text,
    question_class: question.question_class || "generalization",
    programme_state_snapshot_id: question.programme_state_snapshot_id || null,
    evidence_refs: question.evidence_refs || [],
    counterexample_refs: question.counterexample_refs || [],
    trace_event_refs: question.trace_event_refs || [],
    operator_refs: question.related_operator_refs || [],
  };
  return crypto.createHash("sha256").update(JSON.stringify(frozen)).digest("hex");
}

function buildQuestionCase(question, graphId, { domainHint = null } = {}) {
  assertMaterializable(question);
  const hash = handoffHash(question, graphId);
  const provenance = {
    source: "guided_programme_state",
    graph_id: graphId,
    question_id: question.question_id,
    question_class: question.question_class || "generalization",
    programme_state_snapshot_id: question.programme_state_snapshot_id || null,
    handoff_sha256: hash,
  };
  const goal = [
    question.question_text.trim(),
    "",
    "Guided Orbita handoff constraints:",
    `- Treat this as a question to test, not as an established claim.`,
    `- Preserve counterexamples and report a stopping boundary when the available evidence is insufficient.`,
    `- Source graph: ${graphId}`,
    `- Source question: ${question.question_id}`,
    `- Question class: ${provenance.question_class}`,
    `- Evidence references: ${(question.evidence_refs || []).join(", ") || "none recorded"}`,
    `- Counterexample references: ${(question.counterexample_refs || []).join(", ") || "none recorded"}`,
    `- Trace references: ${(question.trace_event_refs || []).join(", ") || "none recorded"}`,
    `- Operator references: ${(question.related_operator_refs || []).join(", ") || "none recorded"}`,
    `- Frozen handoff SHA-256: ${hash}`,
  ].join("\n");
  return {
    backend: {
      name: compactText(`Question: ${question.question_text}`, 200),
      goal: compactText(goal, 4000),
      domain_hint: compactText(domainHint, 200) || null,
    },
    provenance,
  };
}

module.exports = { assertMaterializable, buildQuestionCase, handoffHash };
