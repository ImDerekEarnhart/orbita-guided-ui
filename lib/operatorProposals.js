"use strict";

const crypto = require("node:crypto");
const db = require("./db");

const NAME_BY_SIGNAL = [
  [/artifact|leak|contamin|derived|proxy/i, "Artifact Mimicry"],
  [/subgroup|regime|boundary|interaction|reversal/i, "Boundary Concentration"],
  [/held|cross|split|seed|resample|validation/i, "Transient Warning"],
  [/ablation|incremental|improvement|predict|performance/i, "Constraint Amplification"],
  [/memory|lag|history|state/i, "Hidden State Memory"],
  [/reset|failure|bottleneck|threshold/i, "Reset Bottleneck"],
];

function stableId(graphId, name, evidenceIds) {
  const key = JSON.stringify({ graphId, name, evidenceIds: [...new Set(evidenceIds)].sort() });
  return `op_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function chooseName(text, fallback = "Local-to-Global Forcing") {
  for (const [pattern, name] of NAME_BY_SIGNAL) {
    if (pattern.test(text || "")) return name;
  }
  return fallback;
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scoreProposal({ caseCount, evidenceCount, counterexampleCount }) {
  const total = evidenceCount + counterexampleCount;
  const evidenceRatio = total ? evidenceCount / total : 0;
  const caseReward = clamp(caseCount / 6, 0, 1);
  const evidenceReward = clamp(Math.log10(evidenceCount + 1) / Math.log10(601), 0, 1);
  const counterexampleRatio = total ? counterexampleCount / total : 0;
  const overloadPenalty = counterexampleCount > evidenceCount ? 0.2 : 0;
  const heavyPenalty = counterexampleCount >= 50 ? 0.12 : counterexampleCount >= 20 ? 0.06 : 0;
  const score = 0.1
    + caseReward * 0.25
    + evidenceReward * 0.25
    + evidenceRatio * 0.35
    - counterexampleRatio * 0.18
    - overloadPenalty
    - heavyPenalty;
  return Number(clamp(score, 0.05, 0.95).toFixed(3));
}

function confidenceLabel({ caseCount, evidenceCount, counterexampleCount }) {
  const total = evidenceCount + counterexampleCount;
  const evidenceRatio = total ? evidenceCount / total : 0;
  if (counterexampleCount > evidenceCount) return "weak candidate";
  if (caseCount >= 4 && evidenceCount >= 50 && evidenceRatio >= 0.75 && counterexampleCount <= evidenceCount * 0.5) {
    return "strong candidate";
  }
  return "moderate candidate";
}

function cautionLabels(name, { evidenceCount, counterexampleCount }) {
  const cautions = [];
  if (counterexampleCount > evidenceCount || counterexampleCount >= 50) {
    cautions.push("High counterexample load - review carefully.");
  }
  if (name === "Artifact Mimicry") {
    cautions.push("May indicate contamination, leakage, derived variables, or artifact structure rather than a real cross-domain law.");
  }
  return cautions;
}

function whyProposed(name, { caseCount, evidenceCount, counterexampleCount, signals = [] }) {
  const signalText = signals.length ? ` Signals: ${signals.slice(0, 4).join(", ")}.` : "";
  if (name === "Artifact Mimicry") {
    return `Proposed because artifact-like signatures appeared across ${caseCount} cases, with ${evidenceCount} evidence items and ${counterexampleCount} counterexamples.${signalText}`;
  }
  if (name === "Reset Bottleneck") {
    return `Proposed because repeated reset, capacity, or failure-bottleneck patterns appeared across ${caseCount} cases, with ${evidenceCount} evidence items and ${counterexampleCount} counterexamples.${signalText}`;
  }
  if (name === "Transient Warning") {
    return `Proposed because warning or validation-sensitive patterns appeared across ${caseCount} cases, with ${evidenceCount} evidence items and ${counterexampleCount} counterexamples.${signalText}`;
  }
  if (name === "Constraint Amplification") {
    return `Proposed because repeated constraint or performance-amplification patterns appeared across ${caseCount} cases, with ${evidenceCount} evidence items and ${counterexampleCount} counterexamples.${signalText}`;
  }
  return `Proposed because similar evidence/counterexample patterns appeared across ${caseCount} cases, with ${evidenceCount} evidence items and ${counterexampleCount} counterexamples.${signalText}`;
}

function bucketBy(rows, keyFn) {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return buckets;
}

function buildProposal({ graphId, name, signal, rows, counterexamples = [], kind, summary }) {
  const claimIds = uniq(rows.map(row => row.claim_id));
  const caseIds = uniq([...rows.map(row => row.case_id), ...counterexamples.map(row => row.case_id)]);
  const cxIds = uniq(counterexamples.map(row => row.id));
  const evidenceCount = claimIds.length || rows.length;
  const counterexampleCount = cxIds.length;
  const status = "review_needed";
  const score = scoreProposal({ caseCount: caseIds.length, evidenceCount, counterexampleCount });
  const evidenceRatio = evidenceCount + counterexampleCount
    ? Number((evidenceCount / (evidenceCount + counterexampleCount)).toFixed(3))
    : 0;
  const confidence = confidenceLabel({ caseCount: caseIds.length, evidenceCount, counterexampleCount });
  const cautions = cautionLabels(name, { evidenceCount, counterexampleCount });
  const why = whyProposed(name, { caseCount: caseIds.length, evidenceCount, counterexampleCount, signals: [signal] });
  const operatorId = stableId(graphId, name, [kind, signal, ...claimIds, ...cxIds, ...caseIds]);
  return {
    operator_id: operatorId,
    graph_id: graphId,
    name,
    status,
    description: `Candidate ${name.toLowerCase()} pattern across ${caseIds.length} cases in this memory graph.`,
    confidence,
    caution_labels: cautions,
    why_proposed: why,
    evidence_ratio: evidenceRatio,
    pattern: {
      kind,
      signal,
      summary: `${signal} recurs across ${caseIds.length} linked cases.`,
      supporting_case_ids: caseIds,
      claims_by_verdict: summary?.claims_by_verdict || {},
    },
    evidence: {
      supporting_case_ids: caseIds,
      supporting_claim_ids: claimIds,
      evidence_count: evidenceCount,
      evidence_ratio: evidenceRatio,
    },
    counterexamples: {
      counterexample_ids: cxIds,
      counterexample_count: counterexampleCount,
      found_by: uniq(counterexamples.map(row => row.found_by)),
    },
    supporting_case_ids: caseIds,
    supporting_claim_ids: claimIds,
    counterexample_ids: cxIds,
    evidence_count: evidenceCount,
    counterexample_count: counterexampleCount,
    score,
    provenance: {
      generated_by: "phase2d_cross_domain_operator_heuristics_v1",
      epistemic_status: "candidate_operator_review_required",
      rule: kind,
      signal,
      signals: [signal],
      raw_evidence_count: evidenceCount,
      raw_counterexample_count: counterexampleCount,
    },
  };
}

function mergeSameNameProposals(graphId, proposals) {
  const byName = bucketBy(proposals, proposal => proposal.name);
  const merged = [];
  for (const [name, rows] of byName) {
    const claimIds = uniq(rows.flatMap(row => row.supporting_claim_ids || []));
    const caseIds = uniq(rows.flatMap(row => row.supporting_case_ids || []));
    const cxIds = uniq(rows.flatMap(row => row.counterexample_ids || []));
    const signals = uniq(rows.flatMap(row => row.provenance?.signals || [row.provenance?.signal]));
    const rules = uniq(rows.map(row => row.provenance?.rule));
    const evidenceCount = claimIds.length;
    const counterexampleCount = cxIds.length;
    const evidenceRatio = evidenceCount + counterexampleCount
      ? Number((evidenceCount / (evidenceCount + counterexampleCount)).toFixed(3))
      : 0;
    const score = scoreProposal({ caseCount: caseIds.length, evidenceCount, counterexampleCount });
    const confidence = confidenceLabel({ caseCount: caseIds.length, evidenceCount, counterexampleCount });
    const caution_labels = cautionLabels(name, { evidenceCount, counterexampleCount });
    const why_proposed = whyProposed(name, { caseCount: caseIds.length, evidenceCount, counterexampleCount, signals });
    merged.push({
      operator_id: stableId(graphId, name, ["merged", ...signals, ...claimIds, ...cxIds, ...caseIds]),
      graph_id: graphId,
      name,
      status: "review_needed",
      description: `Candidate ${name.toLowerCase()} pattern across ${caseIds.length} cases in this memory graph.`,
      confidence,
      caution_labels,
      why_proposed,
      evidence_ratio: evidenceRatio,
      pattern: {
        kind: "merged_operator_family",
        signal: signals.join(", "),
        signals,
        source_rules: rules,
        summary: `${name} recurs across ${caseIds.length} linked cases.`,
        supporting_case_ids: caseIds,
        claims_by_verdict: rows[0]?.pattern?.claims_by_verdict || {},
      },
      evidence: {
        supporting_case_ids: caseIds,
        supporting_claim_ids: claimIds,
        evidence_count: evidenceCount,
        evidence_ratio: evidenceRatio,
      },
      counterexamples: {
        counterexample_ids: cxIds,
        counterexample_count: counterexampleCount,
        found_by: uniq(rows.flatMap(row => row.counterexamples?.found_by || [])),
      },
      supporting_case_ids: caseIds,
      supporting_claim_ids: claimIds,
      counterexample_ids: cxIds,
      evidence_count: evidenceCount,
      counterexample_count: counterexampleCount,
      score,
      provenance: {
        generated_by: "phase2d_cross_domain_operator_heuristics_v2",
        epistemic_status: "candidate_operator_review_required",
        rule: "merged_same_name_operator_family",
        source_operator_ids: rows.map(row => row.operator_id),
        signals,
        source_count: rows.length,
      },
    });
  }
  return merged;
}

function proposeOperators({ graphId, claims = [], counterexamples = [], summary = {} }) {
  const graphCaseIds = uniq([
    ...claims.map(claim => claim.case_id),
    ...counterexamples.map(cx => cx.case_id),
    ...Object.keys(summary.observations_by_case || {}),
  ]);
  if (graphCaseIds.length < 2) return [];

  const proposals = [];
  const counterexamplesByFoundBy = bucketBy(counterexamples, row => row.found_by || "unknown_counterexample");
  const counterexamplesByClaim = bucketBy(counterexamples, row => row.claim_id);

  for (const [findingType, rows] of bucketBy(claims, row => row.finding_type || row.verdict || "unknown_finding")) {
    const caseIds = uniq(rows.map(row => row.case_id));
    if (caseIds.length < 2) continue;
    const relatedCx = rows.flatMap(row => counterexamplesByClaim.get(row.claim_id) || []);
    proposals.push(buildProposal({
      graphId,
      name: chooseName(findingType),
      signal: findingType,
      rows,
      counterexamples: relatedCx,
      kind: "repeated_relationship_shape",
      summary,
    }));
  }

  for (const [foundBy, rows] of counterexamplesByFoundBy) {
    const caseIds = uniq(rows.map(row => row.case_id));
    if (caseIds.length < 2) continue;
    const claimIds = new Set(rows.map(row => row.claim_id).filter(Boolean));
    const relatedClaims = claims.filter(claim => claimIds.has(claim.claim_id));
    proposals.push(buildProposal({
      graphId,
      name: chooseName(foundBy, "Reset Bottleneck"),
      signal: foundBy,
      rows: relatedClaims,
      counterexamples: rows,
      kind: "repeated_counterexample_signature",
      summary,
    }));
  }

  return mergeSameNameProposals(graphId, proposals)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 12);
}

function rowToProposal(row) {
  return {
    id: row.id,
    operator_id: row.operator_id,
    graph_id: row.graph_id,
    user_id: row.user_id,
    name: row.name,
    status: row.status,
    description: row.description,
    pattern: row.pattern_json,
    evidence: row.evidence_json,
    counterexamples: row.counterexample_json,
    supporting_case_ids: row.supporting_case_ids || [],
    supporting_claim_ids: row.supporting_claim_ids || [],
    counterexample_ids: row.counterexample_ids || [],
    evidence_count: (row.supporting_claim_ids || []).length,
    counterexample_count: (row.counterexample_ids || []).length,
    score: Number(row.score || 0),
    confidence: row.evidence_json?.confidence || row.pattern_json?.confidence || null,
    caution_labels: row.evidence_json?.caution_labels || row.pattern_json?.caution_labels || [],
    why_proposed: row.evidence_json?.why_proposed || row.pattern_json?.why_proposed || row.description,
    evidence_ratio: row.evidence_json?.evidence_ratio ?? null,
    case_labels: row.evidence_json?.case_labels || [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listProposals(userId, graphId) {
  const { rows } = await db.query(
    `SELECT * FROM operator_proposals
     WHERE user_id = $1 AND graph_id = $2
     ORDER BY score DESC, created_at DESC`,
    [userId, graphId]
  );
  return rows.map(rowToProposal);
}

async function getProposal(userId, graphId, operatorId) {
  const { rows } = await db.query(
    `SELECT * FROM operator_proposals
     WHERE user_id = $1 AND graph_id = $2 AND operator_id = $3`,
    [userId, graphId, operatorId]
  );
  return rows[0] ? rowToProposal(rows[0]) : null;
}

async function replaceGraphProposals(userId, graphId, proposals) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM operator_proposals WHERE user_id = $1 AND graph_id = $2",
      [userId, graphId]
    );
    for (const proposal of proposals) {
      await client.query(
        `INSERT INTO operator_proposals
           (graph_id, user_id, operator_id, name, status, description,
            pattern_json, evidence_json, counterexample_json,
            supporting_case_ids, supporting_claim_ids, counterexample_ids, score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          graphId,
          userId,
          proposal.operator_id,
          proposal.name,
          proposal.status,
          proposal.description,
          JSON.stringify({ ...proposal.pattern, confidence: proposal.confidence, caution_labels: proposal.caution_labels, why_proposed: proposal.why_proposed, provenance: proposal.provenance }),
          JSON.stringify({ ...proposal.evidence, confidence: proposal.confidence, caution_labels: proposal.caution_labels, why_proposed: proposal.why_proposed }),
          JSON.stringify(proposal.counterexamples),
          proposal.supporting_case_ids,
          proposal.supporting_claim_ids,
          proposal.counterexample_ids,
          proposal.score,
        ]
      );
    }
    await client.query("COMMIT");
    return listProposals(userId, graphId);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getProposal,
  listProposals,
  proposeOperators,
  replaceGraphProposals,
};
