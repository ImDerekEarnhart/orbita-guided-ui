(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OrbitaVerdictPresentation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FALLBACK = {
    committed: ["Supported", "Finding supported", "This finding survived the configured falsification checks.", "Why it was supported", true],
    supported_association: ["Supported association", "Association supported", "Association evidence is supported; standalone predictive utility is limited.", "What the evidence supports", false],
    provisional: ["Provisional", "Candidate remains provisional", "The candidate has encouraging evidence but is not a committed finding.", "Why review is still required", false],
    rejected: ["Refuted", "Candidate refuted", "The stored verdict rejected this candidate under the configured checks.", "Why it was refuted", false],
    not_supported: ["Not supported", "Candidate not supported", "The evidence did not clear the configured support threshold.", "Why support was not established", false],
    inconclusive: ["Inconclusive", "Result is inconclusive", "The available validation partition was too limited for a reliable verdict.", "Why this was not evaluable", false],
    unresolved: ["Not evaluable", "Result not evaluable", "Orbita could not produce a valid governed test for this candidate.", "What prevented evaluation", false],
    functional_form_rejected: ["Form rejected", "Tested form rejected", "This functional form failed; that alone does not refute the underlying relationship.", "Why this form failed", false],
    artifact: ["Artifact", "Artifact or dependency signal", "This result is treated as an artifact, not an independent finding.", "Why it is an artifact", false],
    regime_dependent: ["Regime dependent", "Relationship depends on subgroup", "The pooled relationship is not valid as a universal directional finding.", "Where the relationship changes", false],
  };

  function finiteScore(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function fallbackPresentation(state) {
    const row = FALLBACK[state] || FALLBACK.unresolved;
    return { label: row[0], headline: row[1], summary: row[2], detail_heading: row[3], survivor_language: row[4] };
  }

  function publicState(finding) {
    const detail = finding.finding_detail || {};
    const explicit = finding.public_verdict || detail.verdict;
    if (typeof explicit === "string") return explicit;
    const raw = finding.final_status || finding.status;
    if (raw === "refuted") return "rejected";
    if (raw === "supported") return "committed";
    if (raw === "provisional" || raw === "challenged") return "provisional";
    return "unresolved";
  }

  function normalizeFinding(finding) {
    const payload = finding.candidate?.payload || finding.scope || {};
    const state = publicState(finding);
    const presentation = finding.verdict_presentation
      || finding.finding_detail?.verdict_presentation
      || fallbackPresentation(state);
    if (state !== "committed" && /surviv/i.test(`${presentation.headline || ""} ${presentation.summary || ""}`)) {
      throw new Error(`Verdict integrity violation: ${state} finding contains survivor language.`);
    }
    return {
      id: finding.candidate?.id || finding.candidate_id || finding.claim_id || finding.id || "finding",
      status: state,
      presentation,
      score: finiteScore(finding.selection_metric_score ?? finding.finding_detail?.selection_metric_score),
      finalScore: finiteScore(finding.final_validation_metric_score ?? finding.finding_detail?.final_validation_metric_score),
      outcome: payload.outcome || finding.outcome || "",
      predictors: Array.isArray(payload.predictors) && payload.predictors.length
        ? payload.predictors
        : payload.predictor
          ? [payload.predictor]
          : Array.isArray(finding.predictors)
            ? finding.predictors
            : [],
      contrast: finding.finding_detail?.contrast_analysis || null,
      hypothesis: finding.candidate?.statement || finding.finding_detail?.hypothesis_text || "",
    };
  }

  function normalizeRunResult(payload, options = {}) {
    const data = payload.result || payload;
    const target = options.target || "";
    const findings = (data.findings || data.claims || data.results || []).map(normalizeFinding);
    const selectedMap = data.selected_models || data.engine_result?.selected_models || {};
    const selectedInfo = target && selectedMap[target] ? selectedMap[target] : null;
    const selectedFinding = selectedInfo
      ? findings.find(finding => finding.id === selectedInfo.selected_model_id) || null
      : null;
    const primary = selectedFinding || findings[0] || null;
    const predictors = primary?.predictors || [];
    const predictorLabel = predictors.length ? predictors.join(" + ") : primary?.id || "No evaluated finding";
    const outcomeLabel = primary?.outcome || target || "outcome";
    return {
      runId: data.run_id || payload.id,
      findings,
      rejectedCount: findings.filter(finding => ["rejected", "functional_form_rejected"].includes(finding.status)).length,
      hasSelectedModel: Boolean(selectedFinding),
      selected: primary ? {
        ...primary,
        title: `${predictorLabel} -> ${outcomeLabel}`,
        summary: primary.presentation.summary,
        metric: selectedInfo?.evaluation_metric || options.metric || data.evaluation_metric || "r2",
        selectionScore: finiteScore(selectedInfo?.selection_metric_score ?? primary.score),
      } : null,
    };
  }

  function formatScore(value) {
    const numeric = finiteScore(value);
    return numeric === null ? "Not available" : numeric.toFixed(3);
  }

  return { finiteScore, fallbackPresentation, normalizeFinding, normalizeRunResult, formatScore };
});
