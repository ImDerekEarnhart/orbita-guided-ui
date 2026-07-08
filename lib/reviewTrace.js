"use strict";

const crypto = require("node:crypto");
const db = require("./db");

const REVIEW_STATUSES = new Set([
  "proposed",
  "under_review",
  "accepted_candidate",
  "rejected",
  "needs_more_evidence",
  "deprecated",
]);

const TARGET_TYPES = new Set(["operator", "module", "question"]);

const TRACE_EVENT_TYPES = new Set([
  "question_asked",
  "method_chosen",
  "dataset_added",
  "case_created",
  "run_completed",
  "claim_survived",
  "claim_refuted",
  "counterexample_found",
  "module_formed",
  "artifact_warning",
  "operator_proposed",
  "operator_reviewed",
  "module_reviewed",
  "traceability_gap_found",
  "traceability_repaired",
  "stopping_rule_invoked",
  "carry_forward_object_selected",
  "richer_object_rejected",
  "next_question_candidate",
  "evidence_note",
  "blocked_direction",
]);

const ADMISSIBILITY_EFFECTS = new Set([
  "permits_question",
  "blocks_question",
  "narrows_question",
  "requires_more_evidence",
  "requires_traceability_repair",
  "records_stopping_point",
  "none",
]);

const QUESTION_STATUSES = new Set([
  "admissible",
  "possible",
  "interesting",
  "blocked",
  "needs_more_evidence",
  "needs_traceability_repair",
]);

const DEFAULT_CHECKLIST = {
  appears_in_2_plus_cases: false,
  has_supporting_claims: false,
  has_counterexamples_considered: false,
  no_unresolved_artifact_only_explanation: false,
  has_domain_case_diversity: false,
  has_repeatable_pattern_shape: false,
  needs_independent_dataset: true,
  needs_holdout_validation: true,
  needs_traceability_repair: false,
  needs_human_domain_review: true,
  blocked_from_stronger_claim: true,
  allowed_only_as_candidate: true,
};

function stableHash(value, length = 16) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
}

function stableQuestionId(graphId, questionText, refs = {}) {
  return `q_${stableHash({ graphId, questionText, refs }, 18)}`;
}

function normalizeStatus(status, fallback = "proposed") {
  const value = String(status || fallback);
  if (!REVIEW_STATUSES.has(value)) {
    throw new Error(`Invalid review status: ${value}`);
  }
  return value;
}

function normalizeQuestionStatus(status) {
  const value = String(status || "possible");
  if (!QUESTION_STATUSES.has(value)) {
    throw new Error(`Invalid question status: ${value}`);
  }
  return value;
}

function normalizeTargetType(targetType) {
  const value = String(targetType || "");
  if (!TARGET_TYPES.has(value)) throw new Error(`Invalid review target type: ${value}`);
  return value;
}

function normalizeTraceType(eventType) {
  const value = String(eventType || "");
  if (!TRACE_EVENT_TYPES.has(value)) throw new Error(`Invalid trace event type: ${value}`);
  return value;
}

function normalizeAdmissibilityEffect(effect) {
  const value = String(effect || "none");
  if (!ADMISSIBILITY_EFFECTS.has(value)) throw new Error(`Invalid admissibility effect: ${value}`);
  return value;
}

function text(value, max = 2000) {
  if (value === undefined || value === null) return null;
  return String(value).trim().slice(0, max);
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function jsonArray(value) {
  return Array.isArray(value) ? value.filter(v => v !== undefined && v !== null).slice(0, 200) : [];
}

function rowToReview(row) {
  if (!row) return null;
  return {
    id: row.id,
    graph_id: row.graph_id,
    user_id: row.user_id,
    target_type: row.target_type,
    target_id: row.target_id,
    review_status: row.review_status,
    review_notes: row.review_notes,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    promotion_criteria: row.promotion_criteria_json || {},
    evidence_requirements: row.evidence_requirements_json || {},
    checklist: row.checklist_json || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToTraceEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    graph_id: row.graph_id,
    user_id: row.user_id,
    case_id: row.case_id,
    run_id: row.run_id,
    parent_event_id: row.parent_event_id,
    event_type: row.event_type,
    title: row.title,
    description: row.description,
    source_type: row.source_type,
    source_ref_id: row.source_ref_id,
    evidence_refs: row.evidence_refs_json || [],
    claim_refs: row.claim_refs_json || [],
    counterexample_refs: row.counterexample_refs_json || [],
    module_refs: row.module_refs_json || [],
    operator_refs: row.operator_refs_json || [],
    traceability_status: row.traceability_status,
    decision_status: row.decision_status,
    stopping_rule: row.stopping_rule_json || {},
    carry_forward_object: row.carry_forward_object_json || {},
    admissibility_effect: row.admissibility_effect,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToQuestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    graph_id: row.graph_id,
    user_id: row.user_id,
    question_id: row.question_id,
    question_text: row.question_text,
    status: row.status,
    why_allowed: row.why_allowed,
    why_blocked: row.why_blocked,
    evidence_refs: row.evidence_refs_json || [],
    counterexample_refs: row.counterexample_refs_json || [],
    related_module_refs: row.related_module_refs_json || [],
    related_operator_refs: row.related_operator_refs_json || [],
    suggested_next_action: row.suggested_next_action,
    provenance: row.provenance_json || {},
    review_status: row.review_status,
    review_notes: row.review_notes,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listReviewItems(userId, graphId, targetType = null) {
  const params = [userId, graphId];
  let where = "WHERE user_id = $1 AND graph_id = $2";
  if (targetType) {
    where += " AND target_type = $3";
    params.push(normalizeTargetType(targetType));
  }
  const { rows } = await db.query(
    `SELECT * FROM review_items ${where} ORDER BY updated_at DESC`,
    params
  );
  return rows.map(rowToReview);
}

async function getReviewItem(userId, graphId, targetType, targetId) {
  const { rows } = await db.query(
    `SELECT * FROM review_items
     WHERE user_id = $1 AND graph_id = $2 AND target_type = $3 AND target_id = $4`,
    [userId, graphId, normalizeTargetType(targetType), String(targetId || "")]
  );
  return rowToReview(rows[0]);
}

async function upsertReviewItem(userId, graphId, targetType, targetId, input = {}) {
  const normalizedTargetType = normalizeTargetType(targetType);
  const normalizedStatus = normalizeStatus(input.review_status || input.status || "proposed");
  const normalizedTargetId = String(targetId || "").slice(0, 240);
  if (!normalizedTargetId) throw new Error("target_id is required");

  const previous = await getReviewItem(userId, graphId, normalizedTargetType, normalizedTargetId);
  const checklist = { ...DEFAULT_CHECKLIST, ...jsonObject(input.checklist || input.checklist_json) };
  const notes = text(input.review_notes ?? input.notes, 2000);
  const promotionCriteria = jsonObject(input.promotion_criteria || input.promotion_criteria_json);
  const evidenceRequirements = jsonObject(input.evidence_requirements || input.evidence_requirements_json);

  const { rows } = await db.query(
    `INSERT INTO review_items
       (graph_id, user_id, target_type, target_id, review_status, review_notes,
        reviewed_by, reviewed_at, promotion_criteria_json, evidence_requirements_json, checklist_json)
     VALUES ($1,$2,$3,$4,$5,$6,$2,NOW(),$7,$8,$9)
     ON CONFLICT (graph_id, user_id, target_type, target_id) DO UPDATE SET
       review_status = EXCLUDED.review_status,
       review_notes = EXCLUDED.review_notes,
       reviewed_by = EXCLUDED.reviewed_by,
       reviewed_at = NOW(),
       promotion_criteria_json = EXCLUDED.promotion_criteria_json,
       evidence_requirements_json = EXCLUDED.evidence_requirements_json,
       checklist_json = EXCLUDED.checklist_json,
       updated_at = NOW()
     RETURNING *`,
    [
      graphId,
      userId,
      normalizedTargetType,
      normalizedTargetId,
      normalizedStatus,
      notes,
      JSON.stringify(promotionCriteria),
      JSON.stringify(evidenceRequirements),
      JSON.stringify(checklist),
    ]
  );
  const review = rowToReview(rows[0]);
  await db.query(
    `INSERT INTO review_events
       (review_item_id, graph_id, user_id, target_type, target_id, from_status, to_status, notes, checklist_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      review.id,
      graphId,
      userId,
      normalizedTargetType,
      normalizedTargetId,
      previous?.review_status || null,
      normalizedStatus,
      notes,
      JSON.stringify(checklist),
    ]
  );

  await createTraceEvent(userId, graphId, {
    event_type: normalizedTargetType === "operator" ? "operator_reviewed" : normalizedTargetType === "module" ? "module_reviewed" : "next_question_candidate",
    title: `${normalizedTargetType} review: ${normalizedStatus.replaceAll("_", " ")}`,
    description: notes || "Review status changed. This does not promote the object into truth.",
    source_type: normalizedTargetType,
    source_ref_id: normalizedTargetId,
    operator_refs: normalizedTargetType === "operator" ? [normalizedTargetId] : [],
    module_refs: normalizedTargetType === "module" ? [normalizedTargetId] : [],
    admissibility_effect: normalizedStatus === "needs_more_evidence" ? "requires_more_evidence"
      : normalizedStatus === "rejected" ? "blocks_question"
      : normalizedStatus === "accepted_candidate" ? "permits_question"
      : "none",
  }).catch(err => console.error("[review trace event]", err.message));

  return review;
}

async function createTraceEvent(userId, graphId, input = {}) {
  const eventType = normalizeTraceType(input.event_type);
  const title = text(input.title, 240);
  if (!title) throw new Error("Trace event title is required");
  const effect = normalizeAdmissibilityEffect(input.admissibility_effect || "none");
  const { rows } = await db.query(
    `INSERT INTO research_trace_events
       (graph_id, user_id, case_id, run_id, parent_event_id, event_type, title,
        description, source_type, source_ref_id, evidence_refs_json, claim_refs_json,
        counterexample_refs_json, module_refs_json, operator_refs_json, traceability_status,
        decision_status, stopping_rule_json, carry_forward_object_json, admissibility_effect, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [
      graphId,
      userId,
      text(input.case_id, 160),
      text(input.run_id, 160),
      input.parent_event_id || null,
      eventType,
      title,
      text(input.description, 2000),
      text(input.source_type, 80),
      text(input.source_ref_id, 240),
      JSON.stringify(jsonArray(input.evidence_refs || input.evidence_refs_json)),
      JSON.stringify(jsonArray(input.claim_refs || input.claim_refs_json)),
      JSON.stringify(jsonArray(input.counterexample_refs || input.counterexample_refs_json)),
      JSON.stringify(jsonArray(input.module_refs || input.module_refs_json)),
      JSON.stringify(jsonArray(input.operator_refs || input.operator_refs_json)),
      text(input.traceability_status, 80) || "open",
      text(input.decision_status, 80) || "review_needed",
      JSON.stringify(jsonObject(input.stopping_rule || input.stopping_rule_json)),
      JSON.stringify(jsonObject(input.carry_forward_object || input.carry_forward_object_json)),
      effect,
      text(input.notes, 2000),
    ]
  );
  return rowToTraceEvent(rows[0]);
}

async function listTraceEvents(userId, graphId, limit = 80) {
  const { rows } = await db.query(
    `SELECT * FROM research_trace_events
     WHERE user_id = $1 AND graph_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [userId, graphId, Math.min(Math.max(Number(limit) || 80, 1), 200)]
  );
  return rows.map(rowToTraceEvent);
}

async function getTraceEvent(userId, graphId, eventId) {
  const { rows } = await db.query(
    `SELECT * FROM research_trace_events
     WHERE user_id = $1 AND graph_id = $2 AND id = $3`,
    [userId, graphId, eventId]
  );
  return rowToTraceEvent(rows[0]);
}

function reviewMap(reviews = []) {
  const map = new Map();
  for (const review of reviews) map.set(`${review.target_type}:${review.target_id}`, review);
  return map;
}

function attachOperatorReviews(operators = [], reviews = []) {
  const byTarget = reviewMap(reviews);
  return operators.map(op => {
    const review = byTarget.get(`operator:${op.operator_id}`);
    return {
      ...op,
      review_status: review?.review_status || "proposed",
      review_notes: review?.review_notes || "",
      review_checklist: review?.checklist || DEFAULT_CHECKLIST,
      review: review || null,
    };
  });
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function operatorRefs(op) {
  return {
    related_operator_refs: [op.operator_id].filter(Boolean),
    evidence_refs: (op.supporting_claim_ids || op.evidence?.supporting_claim_ids || []).slice(0, 30),
    counterexample_refs: (op.counterexample_ids || op.counterexamples?.counterexample_ids || []).slice(0, 30),
  };
}

function candidateFromOperator(graphId, op, review) {
  const evidenceCount = count(op.evidence_count ?? op.evidence?.evidence_count);
  const counterexampleCount = count(op.counterexample_count ?? op.counterexamples?.counterexample_count);
  const caseCount = (op.supporting_case_ids || op.evidence?.supporting_case_ids || []).length;
  const flags = op.suspicion_flags || op.evidence?.suspicion_flags || [];
  const reviewStatus = review?.review_status || op.review_status || "proposed";
  const refs = operatorRefs(op);
  const name = op.name || "candidate operator";

  let questionText;
  let status = "possible";
  let whyAllowed = "";
  let whyBlocked = "";
  let suggested = "Review the operator evidence drilldown and choose the next validation dataset.";

  if (reviewStatus === "rejected") {
    questionText = `Can ${name} be promoted beyond a rejected candidate?`;
    status = "blocked";
    whyBlocked = "Human review rejected this candidate. Rejection preserves the record but blocks stronger promotion.";
    suggested = "Only reopen with new evidence and an explicit review note.";
  } else if (name === "Artifact Mimicry") {
    questionText = "Which linked datasets show leakage, derived variables, contamination, or repeated benchmark structure behind Artifact Mimicry?";
    status = evidenceCount >= 2 ? "admissible" : "needs_more_evidence";
    whyAllowed = "Artifact Mimicry is an artifact-risk diagnostic, so the next safe question is an audit, not a scientific law claim.";
    whyBlocked = "Do not promote this into a discovery operator without independent artifact/proxy validation.";
    suggested = "Audit feature derivations, duplicated benchmark structure, source leakage, and metadata columns.";
  } else if (reviewStatus === "accepted_candidate") {
    questionText = `What independent dataset would test whether ${name} survives outside the current graph?`;
    status = "admissible";
    whyAllowed = "The operator was accepted only as a candidate; the admissible next move is independent testing, not execution or proof.";
    suggested = "Create a replication case with independent data and pre-register the falsifier.";
  } else if (counterexampleCount >= evidenceCount && counterexampleCount > 0) {
    questionText = `Under what conditions does ${name} fail across the linked cases?`;
    status = "needs_more_evidence";
    whyAllowed = "The counterexample load is high, so the useful next question is boundary narrowing.";
    whyBlocked = "A stronger generalization is blocked until counterexamples are explained.";
    suggested = "Group counterexamples by case and isolate the boundary condition.";
  } else if (flags.includes("Dominated by one case")) {
    questionText = `Does ${name} replicate outside the dominant supporting case?`;
    status = "needs_more_evidence";
    whyAllowed = "The pattern is interesting, but current evidence is concentrated in one case.";
    whyBlocked = "Cross-domain generalization is blocked until independent cases contribute evidence.";
    suggested = "Add or run a second independent case with the same falsifier shape.";
  } else if (caseCount >= 2 && evidenceCount > 0) {
    questionText = `Which boundary conditions make ${name} hold across ${caseCount} linked cases?`;
    status = caseCount >= 3 && counterexampleCount <= evidenceCount ? "admissible" : "possible";
    whyAllowed = "The operator has reviewable cross-case support and recorded counterexamples.";
    suggested = "Turn the operator into a written candidate hypothesis and test its falsifiers.";
  } else {
    questionText = `What evidence would make ${name} reviewable across more than one case?`;
    status = "interesting";
    whyAllowed = "The pattern is tracked, but the graph does not yet justify a stronger next question.";
    suggested = "Attach another case or collect supporting claims before reviewing.";
  }

  return {
    question_id: stableQuestionId(graphId, questionText, refs),
    graph_id: graphId,
    question_text: questionText,
    status,
    why_allowed: whyAllowed,
    why_blocked: whyBlocked,
    suggested_next_action: suggested,
    provenance: {
      generated_by: "phase2d_2f_review_trace_frontier_v1",
      source: "operator_review",
      operator_name: name,
      review_status: reviewStatus,
      evidence_count: evidenceCount,
      counterexample_count: counterexampleCount,
      case_count: caseCount,
      caution: "admissible means justified as a next question, not true",
    },
    ...refs,
  };
}

function traceQuestionCandidates(graphId, traceEvents = []) {
  const out = [];
  const gaps = traceEvents.filter(event =>
    event.event_type === "traceability_gap_found" ||
    event.admissibility_effect === "requires_traceability_repair"
  );
  if (gaps.length) {
    const questionText = "What traceability repair is required before carrying this object forward?";
    out.push({
      question_id: stableQuestionId(graphId, questionText, { trace_event_ids: gaps.map(e => e.id).sort() }),
      graph_id: graphId,
      question_text: questionText,
      status: "needs_traceability_repair",
      why_allowed: "The research trace records a gap that can be repaired explicitly.",
      why_blocked: "Carrying the object forward is blocked until the gap is repaired.",
      evidence_refs: [],
      counterexample_refs: [],
      related_module_refs: gaps.flatMap(e => e.module_refs || []).slice(0, 30),
      related_operator_refs: gaps.flatMap(e => e.operator_refs || []).slice(0, 30),
      suggested_next_action: "Add a traceability repair event linking source evidence to the carried-forward object.",
      provenance: { generated_by: "phase2d_2f_review_trace_frontier_v1", source: "traceability_gap" },
    });
  }
  return out;
}

function buildQuestionCandidates({ graphId, operators = [], reviews = [], traceEvents = [] } = {}) {
  const byTarget = reviewMap(reviews);
  const candidates = [];
  for (const op of operators) {
    candidates.push(candidateFromOperator(graphId, op, byTarget.get(`operator:${op.operator_id}`)));
  }
  candidates.push(...traceQuestionCandidates(graphId, traceEvents));
  const seen = new Set();
  return candidates
    .filter(q => {
      if (seen.has(q.question_id)) return false;
      seen.add(q.question_id);
      return true;
    })
    .slice(0, 16);
}

async function listQuestions(userId, graphId) {
  const { rows } = await db.query(
    `SELECT * FROM admissible_questions
     WHERE user_id = $1 AND graph_id = $2
     ORDER BY created_at DESC`,
    [userId, graphId]
  );
  return rows.map(rowToQuestion);
}

async function saveGeneratedQuestions(userId, graphId, questions = []) {
  const saved = [];
  for (const question of questions) {
    const status = normalizeQuestionStatus(question.status);
    const { rows } = await db.query(
      `INSERT INTO admissible_questions
         (graph_id, user_id, question_id, question_text, status, why_allowed, why_blocked,
          evidence_refs_json, counterexample_refs_json, related_module_refs_json,
          related_operator_refs_json, suggested_next_action, provenance_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (graph_id, user_id, question_id) DO UPDATE SET
         question_text = EXCLUDED.question_text,
         status = EXCLUDED.status,
         why_allowed = EXCLUDED.why_allowed,
         why_blocked = EXCLUDED.why_blocked,
         evidence_refs_json = EXCLUDED.evidence_refs_json,
         counterexample_refs_json = EXCLUDED.counterexample_refs_json,
         related_module_refs_json = EXCLUDED.related_module_refs_json,
         related_operator_refs_json = EXCLUDED.related_operator_refs_json,
         suggested_next_action = EXCLUDED.suggested_next_action,
         provenance_json = EXCLUDED.provenance_json,
         updated_at = NOW()
       RETURNING *`,
      [
        graphId,
        userId,
        question.question_id,
        question.question_text,
        status,
        text(question.why_allowed, 2000),
        text(question.why_blocked, 2000),
        JSON.stringify(jsonArray(question.evidence_refs)),
        JSON.stringify(jsonArray(question.counterexample_refs)),
        JSON.stringify(jsonArray(question.related_module_refs)),
        JSON.stringify(jsonArray(question.related_operator_refs)),
        text(question.suggested_next_action, 1000),
        JSON.stringify(jsonObject(question.provenance)),
      ]
    );
    saved.push(rowToQuestion(rows[0]));
  }
  return saved;
}

async function generateAndSaveQuestions(userId, graphId, { operators = [], reviews = [], traceEvents = [] } = {}) {
  const questions = buildQuestionCandidates({ graphId, operators, reviews, traceEvents });
  const saved = await saveGeneratedQuestions(userId, graphId, questions);
  if (saved.length) {
    await createTraceEvent(userId, graphId, {
      event_type: "next_question_candidate",
      title: `Generated ${saved.length} admissible next question candidate${saved.length === 1 ? "" : "s"}`,
      description: "Question generation is conservative and review-needed. It does not execute operators or mutate claims.",
      source_type: "question_generator",
      source_ref_id: "phase2d_2f_review_trace_frontier_v1",
      admissibility_effect: "permits_question",
    }).catch(err => console.error("[question trace event]", err.message));
  }
  return saved;
}

async function updateQuestionReview(userId, graphId, questionId, input = {}) {
  const reviewStatus = normalizeStatus(input.review_status || input.status || "under_review");
  const notes = text(input.review_notes ?? input.notes, 2000);
  const { rows } = await db.query(
    `UPDATE admissible_questions
     SET review_status = $4, review_notes = $5, reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND graph_id = $2 AND question_id = $3
     RETURNING *`,
    [userId, graphId, questionId, reviewStatus, notes]
  );
  if (!rows[0]) return null;
  await upsertReviewItem(userId, graphId, "question", questionId, { review_status: reviewStatus, review_notes: notes });
  return rowToQuestion(rows[0]);
}

module.exports = {
  ADMISSIBILITY_EFFECTS,
  DEFAULT_CHECKLIST,
  QUESTION_STATUSES,
  REVIEW_STATUSES,
  TARGET_TYPES,
  TRACE_EVENT_TYPES,
  attachOperatorReviews,
  buildQuestionCandidates,
  createTraceEvent,
  generateAndSaveQuestions,
  getReviewItem,
  getTraceEvent,
  listQuestions,
  listReviewItems,
  listTraceEvents,
  normalizeAdmissibilityEffect,
  normalizeStatus,
  normalizeTargetType,
  normalizeTraceType,
  saveGeneratedQuestions,
  stableQuestionId,
  updateQuestionReview,
  upsertReviewItem,
};
