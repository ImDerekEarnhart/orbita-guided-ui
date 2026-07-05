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
  const score = Math.min(0.95, 0.25 + caseIds.length * 0.18 + evidenceCount * 0.04 + counterexampleCount * 0.03);
  const status = counterexampleCount > 0 ? "review_needed" : "proposed";
  const operatorId = stableId(graphId, name, [kind, signal, ...claimIds, ...cxIds, ...caseIds]);
  return {
    operator_id: operatorId,
    graph_id: graphId,
    name,
    status,
    description: `Candidate ${name.toLowerCase()} pattern across ${caseIds.length} cases in this memory graph.`,
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
    },
  };
}

function proposeOperators({ graphId, claims = [], counterexamples = [], summary = {} }) {
  const graphCaseIds = uniq([
    ...claims.map(claim => claim.case_id),
    ...counterexamples.map(cx => cx.case_id),
    ...Object.keys(summary.observations_by_case || {}),
  ]);
  if (graphCaseIds.length < 2) return [];

  const proposals = [];
  const counterexamplesByCase = bucketBy(counterexamples, row => row.case_id);
  const counterexamplesByFoundBy = bucketBy(counterexamples, row => row.found_by || "unknown_counterexample");

  for (const [findingType, rows] of bucketBy(claims, row => row.finding_type || row.verdict || "unknown_finding")) {
    const caseIds = uniq(rows.map(row => row.case_id));
    if (caseIds.length < 2) continue;
    const relatedCx = rows.flatMap(row => counterexamplesByCase.get(row.case_id) || []);
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
    const relatedClaims = claims.filter(claim => caseIds.includes(claim.case_id));
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

  const deduped = new Map();
  for (const proposal of proposals) {
    if (!deduped.has(proposal.operator_id) || deduped.get(proposal.operator_id).score < proposal.score) {
      deduped.set(proposal.operator_id, proposal);
    }
  }
  return [...deduped.values()]
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
          JSON.stringify({ ...proposal.pattern, provenance: proposal.provenance }),
          JSON.stringify(proposal.evidence),
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
