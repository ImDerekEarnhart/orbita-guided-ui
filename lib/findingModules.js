"use strict";

const crypto = require("node:crypto");

/**
 * Phase 2D-A finding summaries — group raw findings into readable modules.
 *
 * Turns 80–140 raw case findings into a handful of thematic "candidate
 * modules" (e.g. a mass/chirp-mass formula module, a distance/redshift
 * module) plus scientific warning badges (derived/near-copy/proxy features,
 * informative missingness, influence outliers, regime dependence).
 *
 * STRICTLY READ-ONLY: consumes claims/findings as returned by the backend and
 * never mutates them or any claim status. Grouping is presentation-layer
 * clustering, not an epistemic judgement — every module card carries its raw
 * member findings so nothing is hidden behind the summary.
 *
 * Grouping model (matches how a scientist reads these cases):
 *  - PRIMARY: group by the outcome/target a finding explains (mass module,
 *    distance module). log_X folds onto X. This is what the black-hole run
 *    wants — everything predicting `mass` together, everything predicting
 *    `distance` together.
 *  - SUBDIVIDE: when one target dominates the whole case (the T-cell
 *    exhaustion run — a single outcome with 80+ predictors), that one giant
 *    group is split into predictor-theme sub-modules via shared-column
 *    connected components, so "immune-exhaustion / adenosine" separates from
 *    "stimulation / proliferation".
 *  - CAVEATS: artifact / data-quality findings go into one dedicated
 *    "Data caveats & artifact warnings" module, never mixed into science.
 *
 * Every module carries its raw member findings; nothing is hidden and no
 * verdict is changed.
 */

const DOMINANT_FRACTION = 0.55;  // an outcome over this share of the case is subdivided
const DOMINANT_MIN_FINDINGS = 6; // ...but only when the case is big enough to be noisy
const MAX_LABEL_COLUMNS = 3;

const SUPPORTING_VERDICTS = new Set(["committed", "supported_association", "provisional"]);
const CAVEAT_VERDICTS = new Set(["artifact"]);

function baseColumn(name) {
  const s = String(name || "").trim();
  return s.replace(/^log[_ ]/i, "");
}

function stableModuleId({ label, theme, contextColumns = [], entries = [] }) {
  const memberRefs = entries.map(e => e.claim_id || e.candidate_id || e.hypothesis || String(e.index)).sort();
  const key = JSON.stringify({
    label,
    theme: theme || null,
    contextColumns: [...contextColumns].sort(),
    memberRefs,
  });
  return `module_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 14)}`;
}

function findingColumns(payload, detail) {
  const cols = [];
  if (payload) {
    for (const key of ["predictor", "outcome", "group"]) {
      if (payload[key]) cols.push(payload[key]);
    }
    for (const p of payload.predictors || []) cols.push(p);
  }
  if (!cols.length && detail?.missingness?.missing_fraction_by_variable) {
    cols.push(...Object.keys(detail.missingness.missing_fraction_by_variable));
  }
  if (!cols.length && detail?.artifact_warning) {
    const aw = detail.artifact_warning;
    for (const list of [aw.columns, aw.member_columns, aw.inputs]) {
      if (Array.isArray(list)) cols.push(...list);
    }
  }
  return [...new Set(cols.map(baseColumn).filter(Boolean))];
}

/** Warning badges for one finding, from its structured detail fields only. */
function findingBadges(detail, verdict) {
  const badges = new Set();
  const aw = detail?.artifact_warning;
  if (aw) {
    const type = String(aw.type || "");
    if (/near_copy|leakage/.test(type)) badges.add("near-copy / leakage risk");
    else if (/derived/.test(type)) badges.add("derived-feature risk");
    else badges.add("artifact risk");
  }
  if (detail?.informative_missingness_warning) badges.add("informative missingness");
  if (detail?.missingness?.substantial_missingness) badges.add("substantial missingness");
  if (detail?.influence_warning) badges.add("influence outliers");
  if (detail?.subgroup_warning || verdict === "regime_dependent") badges.add("regime dependent");
  if (verdict === "inconclusive") badges.add("small-sample caution");
  if (detail?.is_predictive_claim && verdict !== "committed") badges.add("unproven predictive claim");
  return [...badges];
}

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) { this.parent.set(this.find(a), this.find(b)); }
}

function verdictOf(claim, finding) {
  return claim?.verdict || finding?.final_status || "unknown";
}

function outcomeColumn(payload, columns) {
  const out = payload?.outcome || payload?.group;
  if (out) return baseColumn(out);
  return columns[0] || null;   // fall back to any touched column
}

function labelForColumns(columns, contextColumns = []) {
  const shown = columns.slice(0, MAX_LABEL_COLUMNS).join(" · ") || "findings";
  const suffix = contextColumns.length ? ` (predicting ${contextColumns.slice(0, 2).join(", ")})` : "";
  return `${shown}${suffix} module`;
}

/**
 * @param {object} input
 * @param {Array} input.findings  raw engine findings (candidate.payload etc.), may be []
 * @param {Array} input.claims    enriched claims from /cases/{id}/claims, may be []
 * @returns {{modules: Array, case_badges: Array, total_findings: number, grouped_findings: number}}
 */
function buildFindingModules({ findings = [], claims = [] } = {}) {
  const claimByCandidate = new Map();
  for (const c of claims) {
    if (c.source_candidate_id) claimByCandidate.set(c.source_candidate_id, c);
  }
  // Prefer raw findings (payload columns); claims without a matching raw
  // finding (older runs, scoped/quality claims) are still included.
  const seen = new Set();
  const items = [];
  for (const f of findings) {
    const cid = f.candidate?.id;
    const claim = cid ? claimByCandidate.get(cid) : undefined;
    if (cid) seen.add(cid);
    items.push({ finding: f, claim, payload: f.candidate?.payload || null });
  }
  for (const c of claims) {
    if (c.source_candidate_id && seen.has(c.source_candidate_id)) continue;
    items.push({ finding: null, claim: c, payload: null });
  }

  const enriched = items.map((item, index) => {
    const detail = item.claim?.finding_detail || {};
    const verdict = verdictOf(item.claim, item.finding);
    const columns = findingColumns(item.payload, detail);
    return {
      index,
      verdict,
      finding_type: item.claim?.finding_type || null,
      hypothesis: detail.hypothesis_text || item.claim?.hypothesis_text
        || item.finding?.candidate?.statement || item.claim?.canonical_text || "",
      candidate_id: item.finding?.candidate?.id || item.claim?.source_candidate_id || null,
      claim_id: item.claim?.claim_id || null,
      score: item.finding?.selection_metric_score ?? detail.candidate_score ?? null,
      columns,
      outcome: outcomeColumn(item.payload, columns),
      predictorColumns: columns.filter(c => c !== outcomeColumn(item.payload, columns)),
      badges: findingBadges(detail, verdict),
      is_caveat: CAVEAT_VERDICTS.has(verdict)
        || ["data_quality", "data_error", "artifact", "structural_relation", "artifact_guard"]
             .includes(item.claim?.finding_type),
    };
  });

  const caveats = enriched.filter(e => e.is_caveat);
  const groupable = enriched.filter(e => !e.is_caveat);

  const verdictPriority = ["committed", "supported_association", "provisional", "regime_dependent",
                           "functional_form_rejected", "inconclusive", "not_supported", "rejected",
                           "unresolved", "unknown"];

  // PRIMARY grouping: by outcome/target column.
  const byOutcome = new Map();
  const noOutcome = [];
  for (const e of groupable) {
    if (!e.outcome) { noOutcome.push(e); continue; }
    if (!byOutcome.has(e.outcome)) byOutcome.set(e.outcome, []);
    byOutcome.get(e.outcome).push(e);
  }

  // A "group" here is a set of entries plus how to label it.
  const groups = []; // { entries, label, contextColumns }

  function subdivideByPredictorTheme(entries, outcome) {
    // Connected components over shared predictor columns (excluding the shared
    // outcome). Findings with no predictor column fall into one remainder set.
    const uf = new UnionFind();
    for (const e of entries) {
      const cols = e.predictorColumns;
      for (let i = 1; i < cols.length; i++) uf.union(cols[0], cols[i]);
    }
    const buckets = new Map();
    const remainder = [];
    for (const e of entries) {
      if (!e.predictorColumns.length) { remainder.push(e); continue; }
      const root = uf.find(e.predictorColumns[0]);
      if (!buckets.has(root)) buckets.set(root, []);
      buckets.get(root).push(e);
    }
    for (const bucketEntries of buckets.values()) {
      const colCounts = new Map();
      for (const e of bucketEntries) e.predictorColumns.forEach(c => colCounts.set(c, (colCounts.get(c) || 0) + 1));
      const topCols = [...colCounts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
      groups.push({ entries: bucketEntries, label: labelForColumns(topCols, [outcome]), contextColumns: [outcome] });
    }
    if (remainder.length) {
      groups.push({ entries: remainder, label: `${outcome} module`, contextColumns: [] });
    }
  }

  for (const [outcome, entries] of byOutcome) {
    const dominant = entries.length >= DOMINANT_MIN_FINDINGS
      && entries.length >= groupable.length * DOMINANT_FRACTION;
    if (dominant) {
      subdivideByPredictorTheme(entries, outcome);
    } else {
      groups.push({ entries, label: `${outcome} module`, contextColumns: [] });
    }
  }
  if (noOutcome.length) {
    groups.push({ entries: noOutcome, label: "Ungrouped findings", contextColumns: [], theme: "ungrouped" });
  }

  function makeModule(entries, { label, theme = null, contextColumns = [] }) {
    const verdicts = {};
    const badges = new Set();
    const colCounts = new Map();
    for (const e of entries) {
      verdicts[e.verdict] = (verdicts[e.verdict] || 0) + 1;
      e.badges.forEach(b => badges.add(b));
      e.columns.forEach(c => colCounts.set(c, (colCounts.get(c) || 0) + 1));
    }
    const supporting = entries.filter(e => SUPPORTING_VERDICTS.has(e.verdict)).length;
    const members = [...entries].sort((a, b) =>
      verdictPriority.indexOf(a.verdict) - verdictPriority.indexOf(b.verdict)
      || (b.score ?? -Infinity) - (a.score ?? -Infinity)
    ).map(e => ({
      hypothesis: e.hypothesis, verdict: e.verdict, score: e.score,
      candidate_id: e.candidate_id, claim_id: e.claim_id, badges: e.badges,
    }));
    return {
      id: stableModuleId({ label, theme, contextColumns, entries }),
      label,
      theme,
      columns: [...colCounts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c),
      context_columns: contextColumns,
      finding_count: entries.length,
      supporting_count: supporting,
      verdict_counts: verdicts,
      warning_badges: [...badges].sort(),
      members,
    };
  }

  const scienceModules = groups
    .map(g => makeModule(g.entries, { label: g.label, theme: g.theme || null, contextColumns: g.contextColumns }))
    .sort((a, b) => b.supporting_count - a.supporting_count || b.finding_count - a.finding_count);

  const modules = [...scienceModules];
  if (caveats.length) {
    modules.push(makeModule(caveats, {
      label: "Data caveats & artifact warnings", theme: "caveats",
    }));
  }

  const caseBadges = new Set();
  for (const m of modules) m.warning_badges.forEach(b => caseBadges.add(b));

  return {
    modules,
    case_badges: [...caseBadges].sort(),
    total_findings: enriched.length,
    grouped_findings: enriched.length - noOutcome.length,
  };
}

module.exports = { buildFindingModules, findingColumns, findingBadges, baseColumn, stableModuleId };
