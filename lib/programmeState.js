"use strict";

const crypto = require("node:crypto");
const db = require("./db");

const COMPILER_VERSION = "phase2f_b_programme_state_compiler_v1";

function stableHash(value, length = 18) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
}

function stableQuestionId(graphId, questionText, refs = {}) {
  return `q_${stableHash({ graphId, questionText, refs })}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items.filter(Boolean)) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function refIntersects(a = [], b = []) {
  const set = new Set(asArray(a).filter(Boolean));
  return asArray(b).some(value => set.has(value));
}

function reviewRef(review) {
  return {
    type: review.target_type,
    id: review.target_id,
    review_status: review.review_status,
    notes: review.review_notes || null,
  };
}

function operatorReview(operators, reviews) {
  const byTarget = new Map(reviews.map(r => [`${r.target_type}:${r.target_id}`, r]));
  return operators.map(op => ({
    ...op,
    review_status: byTarget.get(`operator:${op.operator_id}`)?.review_status || op.review_status || "proposed",
    review: byTarget.get(`operator:${op.operator_id}`) || op.review || null,
  }));
}

function operatorEvidence(op) {
  const evidenceCount = count(op.evidence_count ?? op.evidence?.evidence_count ?? asArray(op.supporting_claim_ids).length);
  const counterexampleCount = count(op.counterexample_count ?? op.counterexamples?.counterexample_count ?? asArray(op.counterexample_ids).length);
  const caseIds = asArray(op.supporting_case_ids || op.evidence?.supporting_case_ids);
  const flags = asArray(op.suspicion_flags || op.evidence?.suspicion_flags);
  const manageableCounterexamples = counterexampleCount === 0 || counterexampleCount <= Math.max(2, evidenceCount * 0.5);
  return {
    evidenceCount,
    counterexampleCount,
    caseIds,
    caseCount: caseIds.length,
    flags,
    manageableCounterexamples,
    dominatedByOneCase: flags.includes("Dominated by one case"),
    artifactRisk: op.name === "Artifact Mimicry" || flags.includes("Artifact-risk operator"),
  };
}

function traceRef(event) {
  return {
    id: event.id,
    event_type: event.event_type,
    title: event.title,
    source_type: event.source_type || null,
    source_ref_id: event.source_ref_id || null,
    module_refs: asArray(event.module_refs),
    operator_refs: asArray(event.operator_refs),
    claim_refs: asArray(event.claim_refs),
    counterexample_refs: asArray(event.counterexample_refs),
    admissibility_effect: event.admissibility_effect || "none",
  };
}

function isTraceabilityRepairFor(gap, repair) {
  if (!repair || repair.event_type !== "traceability_repaired") return false;
  if (gap.source_ref_id && repair.source_ref_id === gap.source_ref_id) return true;
  if (refIntersects(gap.module_refs, repair.module_refs)) return true;
  if (refIntersects(gap.operator_refs, repair.operator_refs)) return true;
  if (refIntersects(gap.claim_refs, repair.claim_refs)) return true;
  return false;
}

function unresolvedTraceabilityGaps(traceEvents) {
  const gaps = traceEvents.filter(event =>
    event.event_type === "traceability_gap_found" ||
    event.admissibility_effect === "requires_traceability_repair"
  );
  const repairs = traceEvents.filter(event => event.event_type === "traceability_repaired");
  return gaps.filter(gap => !repairs.some(repair => isTraceabilityRepairFor(gap, repair))).map(traceRef);
}

function artifactWarnings(traceEvents, operators) {
  const fromTrace = traceEvents
    .filter(event => event.event_type === "artifact_warning")
    .map(traceRef);
  const fromOperators = operators
    .filter(op => operatorEvidence(op).artifactRisk)
    .map(op => ({
      id: op.operator_id,
      source_type: "operator",
      source_ref_id: op.operator_id,
      title: `${op.name} artifact-risk warning`,
      operator_refs: [op.operator_id],
      claim_refs: asArray(op.supporting_claim_ids),
      counterexample_refs: asArray(op.counterexample_ids),
    }));
  return uniqueBy([...fromTrace, ...fromOperators], item => `${item.source_type}:${item.source_ref_id}:${item.id}`);
}

function compileProgrammeState({ graphId, traceEvents = [], reviews = [], operators = [], questions = [] } = {}) {
  const reviewedOperators = operatorReview(asArray(operators), asArray(reviews));
  const accepted = reviews.filter(review => review.review_status === "accepted_candidate").map(reviewRef);
  const rejected = reviews.filter(review => review.review_status === "rejected").map(reviewRef);
  const needsMoreEvidence = reviews.filter(review => review.review_status === "needs_more_evidence").map(reviewRef);
  const gaps = unresolvedTraceabilityGaps(asArray(traceEvents));
  const artifacts = artifactWarnings(asArray(traceEvents), reviewedOperators);
  const stoppingRules = traceEvents
    .filter(event => event.event_type === "stopping_rule_invoked" || event.admissibility_effect === "records_stopping_point")
    .map(traceRef);
  const carryForwardTrace = traceEvents
    .filter(event => event.event_type === "carry_forward_object_selected")
    .map(event => ({
      id: event.source_ref_id || event.id,
      type: event.source_type || "trace_object",
      title: event.title,
      trace_event_id: event.id,
      carry_forward_object: event.carry_forward_object || {},
    }));

  const activeOperators = reviewedOperators.map(op => {
    const ev = operatorEvidence(op);
    return {
      type: "operator",
      id: op.operator_id,
      name: op.name,
      review_status: op.review_status,
      evidence_count: ev.evidenceCount,
      counterexample_count: ev.counterexampleCount,
      case_count: ev.caseCount,
      flags: ev.flags,
      artifact_risk: ev.artifactRisk,
      dominated_by_one_case: ev.dominatedByOneCase,
      manageable_counterexamples: ev.manageableCounterexamples,
      supporting_claim_ids: asArray(op.supporting_claim_ids),
      counterexample_ids: asArray(op.counterexample_ids),
    };
  });

  const activeModules = reviews
    .filter(review => review.target_type === "module" && !["rejected", "deprecated"].includes(review.review_status))
    .map(reviewRef);

  const openCounterexampleClusters = activeOperators
    .filter(op => op.counterexample_count > 0)
    .map(op => ({
      type: "operator",
      id: op.id,
      name: op.name,
      counterexample_count: op.counterexample_count,
      evidence_count: op.evidence_count,
      counterexample_refs: op.counterexample_ids,
    }));

  const needsReplication = activeOperators
    .filter(op => op.review_status === "accepted_candidate" || op.dominated_by_one_case || op.case_count < 3)
    .map(op => ({
      type: "operator",
      id: op.id,
      name: op.name,
      reason: op.dominated_by_one_case ? "Dominated by one case" : "Needs independent replication",
    }));

  const needsIndependentDataset = activeOperators
    .filter(op => op.review_status === "accepted_candidate" || op.artifact_risk || op.dominated_by_one_case)
    .map(op => ({
      type: "operator",
      id: op.id,
      name: op.name,
      reason: op.artifact_risk ? "Artifact/proxy risk requires independent audit data" : "Candidate requires independent dataset",
    }));

  const blockedClaimClasses = [
    ...gaps.map(gap => ({
      class: "stronger_question_dependent_on_unrepaired_trace",
      blocked_by: gap.id,
      why: "Traceability gap must be repaired before carrying this object forward.",
    })),
    ...artifacts.map(warning => ({
      class: "strong_scientific_claim_from_artifact_risk_object",
      blocked_by: warning.id,
      why: "Artifact/derived/near-copy risk blocks stronger scientific interpretation until audited.",
    })),
    ...rejected.map(item => ({
      class: "promotion_of_rejected_object",
      blocked_by: item.id,
      why: "Rejected objects remain stored but cannot be promoted.",
    })),
    ...stoppingRules.map(rule => ({
      class: "richer_object_beyond_stopping_rule",
      blocked_by: rule.id,
      why: "Stopping rule only permits narrower/carry-forward questions.",
    })),
  ];

  const allowedClasses = new Set(["carry_forward"]);
  if (activeOperators.some(op => op.case_count >= 2 && op.manageable_counterexamples)) allowedClasses.add("replication");
  if (activeOperators.some(op => op.counterexample_count > 0)) allowedClasses.add("narrowing");
  if (artifacts.length) allowedClasses.add("artifact_audit");
  if (gaps.length) allowedClasses.add("traceability_repair");
  if (stoppingRules.length) allowedClasses.add("stopping_rule");

  return {
    graph_id: graphId,
    source_trace_event_count: traceEvents.length,
    open_questions: questions.filter(q => !["rejected", "deprecated"].includes(q.review_status || "proposed")),
    closed_questions: questions.filter(q => ["rejected", "deprecated"].includes(q.review_status || "proposed")),
    active_modules: activeModules,
    active_operators: activeOperators,
    accepted_candidate_objects: accepted,
    rejected_objects: rejected,
    unresolved_artifact_warnings: artifacts,
    unresolved_traceability_gaps: gaps,
    open_counterexample_clusters: openCounterexampleClusters,
    active_stopping_rules: stoppingRules,
    carry_forward_objects: [...carryForwardTrace, ...accepted],
    blocked_claim_classes: blockedClaimClasses,
    allowed_question_classes: [...allowedClasses].sort(),
    needs_replication: uniqueBy(needsReplication, item => `${item.type}:${item.id}`),
    needs_independent_dataset: uniqueBy(needsIndependentDataset, item => `${item.type}:${item.id}`),
    needs_traceability_repair: gaps,
    needs_more_evidence: needsMoreEvidence,
    provenance: {
      generated_by: COMPILER_VERSION,
      generated_at: new Date().toISOString(),
      hard_rules: [
        "admissible_does_not_mean_true",
        "accepted_candidate_does_not_mean_proven",
        "no_claim_mutation",
        "no_operator_execution",
      ],
    },
  };
}

function questionBase(snapshot, questionText, questionClass, refs = {}) {
  return {
    question_id: stableQuestionId(snapshot.graph_id, questionText, refs),
    graph_id: snapshot.graph_id,
    question_text: questionText,
    question_class: questionClass,
    evidence_refs: asArray(refs.evidence_refs),
    counterexample_refs: asArray(refs.counterexample_refs),
    trace_event_refs: asArray(refs.trace_event_refs),
    related_module_refs: asArray(refs.related_module_refs),
    related_operator_refs: asArray(refs.related_operator_refs),
    review_needed: true,
    provenance: {
      generated_by: COMPILER_VERSION,
      source_snapshot_id: snapshot.id || null,
      caution: "admissible means justified as a next question, not true",
    },
  };
}

function generateQuestionsFromSnapshot(snapshot) {
  const questions = [];

  for (const gap of snapshot.unresolved_traceability_gaps || []) {
    questions.push({
      ...questionBase(snapshot, "What traceability repair is required before carrying this object forward?", "traceability_repair", {
        trace_event_refs: [gap.id],
        related_module_refs: gap.module_refs,
        related_operator_refs: gap.operator_refs,
      }),
      status: "needs_traceability_repair",
      why_allowed: "The programme trace identifies a concrete repair task.",
      why_blocked: "Stronger dependent questions are blocked until this traceability gap is repaired.",
      what_would_make_it_admissible: "Add a traceability_repaired event that links the object back to source evidence.",
      suggested_next_action: "Repair or discard the carry-forward object before asking stronger questions.",
    });
  }

  for (const warning of snapshot.unresolved_artifact_warnings || []) {
    questions.push({
      ...questionBase(snapshot, "Which relationships are independent structure versus leakage, derived variables, contamination, or repeated benchmark artifacts?", "artifact_audit", {
        trace_event_refs: warning.id?.startsWith("op_") ? [] : [warning.id],
        related_operator_refs: warning.operator_refs || [warning.source_ref_id].filter(Boolean),
        evidence_refs: warning.claim_refs,
        counterexample_refs: warning.counterexample_refs,
      }),
      status: "admissible",
      why_allowed: "Artifact risk makes an audit question admissible.",
      why_blocked: "A stronger scientific claim is blocked until artifact/proxy explanations are ruled out.",
      what_would_make_it_admissible: "Independent audit data, feature-lineage checks, or holdout validation that separates artifact from structure.",
      suggested_next_action: "Audit source columns, derived features, duplicate benchmarks, and leakage paths.",
    });
  }

  for (const op of snapshot.active_operators || []) {
    if (op.review_status === "rejected") {
      questions.push({
        ...questionBase(snapshot, `Can ${op.name} be promoted beyond a rejected candidate?`, "generalization", {
          related_operator_refs: [op.id],
        }),
        status: "blocked",
        why_allowed: "",
        why_blocked: "Human review rejected this object; promotion remains blocked.",
        what_would_make_it_admissible: "New evidence plus an explicit review note reopening the rejected object.",
        suggested_next_action: "Keep the failure as programme memory or ask a narrower failure-analysis question.",
      });
      continue;
    }

    if (op.review_status === "accepted_candidate") {
      questions.push({
        ...questionBase(snapshot, `What independent dataset would test whether ${op.name} survives outside the current graph?`, "replication", {
          related_operator_refs: [op.id],
          evidence_refs: op.supporting_claim_ids,
          counterexample_refs: op.counterexample_ids,
        }),
        status: "admissible",
        why_allowed: "The object is accepted only as a candidate, so the valid next move is a test.",
        why_blocked: "Truth or execution remains blocked until independent replication/falsification.",
        what_would_make_it_admissible: "A separate dataset or case with the same predeclared falsifier.",
        suggested_next_action: "Run or attach an independent replication case.",
      });
    } else if (op.dominated_by_one_case) {
      questions.push({
        ...questionBase(snapshot, `Does ${op.name} replicate outside the dominant supporting case?`, "replication", {
          related_operator_refs: [op.id],
          evidence_refs: op.supporting_claim_ids,
          counterexample_refs: op.counterexample_ids,
        }),
        status: "needs_more_evidence",
        why_allowed: "The pattern is visible but dominated by one case.",
        why_blocked: "Generalization is blocked until more cases contribute evidence.",
        what_would_make_it_admissible: "Evidence from another independent case or dataset.",
        suggested_next_action: "Add a contrasting case and rerun the same falsifier.",
      });
    } else if (op.counterexample_count > 0) {
      questions.push({
        ...questionBase(snapshot, `Under what boundary conditions does ${op.name} fail or survive?`, "narrowing", {
          related_operator_refs: [op.id],
          evidence_refs: op.supporting_claim_ids,
          counterexample_refs: op.counterexample_ids,
        }),
        status: "admissible",
        why_allowed: "Mixed support and counterexamples justify a narrowing question.",
        why_blocked: "A broad generalization is blocked until counterexamples are explained.",
        what_would_make_it_admissible: "Clustered counterexamples and a narrower condition that predicts failures.",
        suggested_next_action: "Group counterexamples by case/regime and state the boundary condition.",
      });
    } else if (op.case_count >= 2 && op.manageable_counterexamples) {
      questions.push({
        ...questionBase(snapshot, `Does ${op.name} generalize across a fresh linked case?`, "generalization", {
          related_operator_refs: [op.id],
          evidence_refs: op.supporting_claim_ids,
          counterexample_refs: op.counterexample_ids,
        }),
        status: op.case_count >= 3 ? "admissible" : "possible",
        why_allowed: "The operator appears across multiple cases with manageable counterexamples.",
        why_blocked: "It is still only a review-needed candidate, not a proven operator.",
        what_would_make_it_admissible: "Predeclared replication on an independent case.",
        suggested_next_action: "Choose a fresh case and test the same pattern shape.",
      });
    }
  }

  for (const rule of snapshot.active_stopping_rules || []) {
    questions.push({
      ...questionBase(snapshot, "What smaller or narrower carry-forward object is still permitted by the stopping rule?", "stopping_rule", {
        trace_event_refs: [rule.id],
        related_module_refs: rule.module_refs,
        related_operator_refs: rule.operator_refs,
      }),
      status: "admissible",
      why_allowed: "The stopping rule permits narrower or carry-forward questions.",
      why_blocked: "Richer object construction is blocked by the recorded stopping rule.",
      what_would_make_it_admissible: "A smaller object with explicit carry-forward criteria.",
      suggested_next_action: "Write the minimal carry-forward object and its stopping condition.",
    });
  }

  return uniqueBy(questions, q => q.question_id).slice(0, 24);
}

function rowToSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    graph_id: row.graph_id,
    user_id: row.user_id,
    created_at: row.created_at,
    source_trace_event_count: row.source_trace_event_count,
    open_questions: row.open_questions_json || [],
    closed_questions: row.closed_questions_json || [],
    active_modules: row.active_modules_json || [],
    active_operators: row.active_operators_json || [],
    accepted_candidate_objects: row.accepted_candidate_objects_json || [],
    rejected_objects: row.rejected_objects_json || [],
    unresolved_artifact_warnings: row.unresolved_artifact_warnings_json || [],
    unresolved_traceability_gaps: row.unresolved_traceability_gaps_json || [],
    open_counterexample_clusters: row.open_counterexample_clusters_json || [],
    active_stopping_rules: row.active_stopping_rules_json || [],
    carry_forward_objects: row.carry_forward_objects_json || [],
    blocked_claim_classes: row.blocked_claim_classes_json || [],
    allowed_question_classes: row.allowed_question_classes_json || [],
    needs_replication: row.needs_replication_json || [],
    needs_independent_dataset: row.needs_independent_dataset_json || [],
    needs_traceability_repair: row.needs_traceability_repair_json || [],
    provenance: row.provenance_json || {},
  };
}

async function saveProgrammeStateSnapshot(userId, graphId, snapshot) {
  const { rows } = await db.query(
    `INSERT INTO programme_state_snapshots
       (graph_id, user_id, source_trace_event_count, open_questions_json, closed_questions_json,
        active_modules_json, active_operators_json, accepted_candidate_objects_json, rejected_objects_json,
        unresolved_artifact_warnings_json, unresolved_traceability_gaps_json, open_counterexample_clusters_json,
        active_stopping_rules_json, carry_forward_objects_json, blocked_claim_classes_json,
        allowed_question_classes_json, needs_replication_json, needs_independent_dataset_json,
        needs_traceability_repair_json, provenance_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING *`,
    [
      graphId,
      userId,
      snapshot.source_trace_event_count || 0,
      JSON.stringify(snapshot.open_questions || []),
      JSON.stringify(snapshot.closed_questions || []),
      JSON.stringify(snapshot.active_modules || []),
      JSON.stringify(snapshot.active_operators || []),
      JSON.stringify(snapshot.accepted_candidate_objects || []),
      JSON.stringify(snapshot.rejected_objects || []),
      JSON.stringify(snapshot.unresolved_artifact_warnings || []),
      JSON.stringify(snapshot.unresolved_traceability_gaps || []),
      JSON.stringify(snapshot.open_counterexample_clusters || []),
      JSON.stringify(snapshot.active_stopping_rules || []),
      JSON.stringify(snapshot.carry_forward_objects || []),
      JSON.stringify(snapshot.blocked_claim_classes || []),
      JSON.stringify(snapshot.allowed_question_classes || []),
      JSON.stringify(snapshot.needs_replication || []),
      JSON.stringify(snapshot.needs_independent_dataset || []),
      JSON.stringify(snapshot.needs_traceability_repair || []),
      JSON.stringify(snapshot.provenance || {}),
    ]
  );
  return rowToSnapshot(rows[0]);
}

async function latestProgrammeStateSnapshot(userId, graphId) {
  const { rows } = await db.query(
    `SELECT * FROM programme_state_snapshots
     WHERE user_id = $1 AND graph_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, graphId]
  );
  return rowToSnapshot(rows[0]);
}

module.exports = {
  COMPILER_VERSION,
  compileProgrammeState,
  generateQuestionsFromSnapshot,
  latestProgrammeStateSnapshot,
  saveProgrammeStateSnapshot,
  stableQuestionId,
};
