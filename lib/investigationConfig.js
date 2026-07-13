"use strict";

const DISCOVERY_SCAN = "discovery_scan";
const TARGETED_PREDICTION = "targeted_prediction";
const PREDECLARED_CONTRAST = "predeclared_contrast";
const PREDICTOR_INTERPRETATIONS = new Set(["auto", "numeric", "categorical", "binary_indicator"]);

function inferColumnProfile(rows = [], column) {
  const values = rows
    .map(row => row?.[column])
    .filter(value => value !== undefined && value !== null && String(value).trim() !== "");
  if (!column || !values.length) return { type: "unknown", numeric: false, nonNegative: false, values: [] };
  const numbers = values.map(value => Number(String(value).replace(/,/g, "")));
  const numericCount = numbers.filter(Number.isFinite).length;
  const numeric = numericCount >= Math.max(3, Math.ceil(values.length * 0.9));
  if (!numeric) {
    const distinct = new Set(values.map(value => String(value).trim())).size;
    return { type: "categorical", numeric: false, nonNegative: false, distinct, values: [...new Set(values.map(String))] };
  }
  const nonNegative = numbers.filter(Number.isFinite).every(value => value >= 0);
  return { type: "numeric", numeric: true, nonNegative, min: Math.min(...numbers.filter(Number.isFinite)), values: [...new Set(values.map(String))] };
}

function validateInvestigationConfig(config, rows = []) {
  const mode = config.mode || (config.exploreAll ? DISCOVERY_SCAN : TARGETED_PREDICTION);
  if (mode === DISCOVERY_SCAN) {
    return { ok: true, mode, target: "", metric: null, warnings: [] };
  }
  if (mode === PREDECLARED_CONTRAST) {
    const contrast = config.contrast || {};
    const required = ["outcomeColumn", "contrastColumn", "positiveLevel", "referenceLevel"];
    const missing = required.find(key => contrast[key] === undefined || contrast[key] === null || String(contrast[key]).trim() === "");
    if (missing) return { ok: false, mode, error: "Complete the outcome, contrast, positive-level, and reference-level fields." };
    if (String(contrast.positiveLevel) === String(contrast.referenceLevel)) {
      return { ok: false, mode, error: "Positive and reference levels must differ." };
    }
    const outcomeProfile = inferColumnProfile(rows, contrast.outcomeColumn);
    if (!outcomeProfile.numeric) {
      return { ok: false, mode, error: "Predeclared contrast requires a numeric outcome column." };
    }
    return { ok: true, mode, target: contrast.outcomeColumn, metric: "r2", contrast, warnings: [] };
  }
  const target = config.target || "";
  const metric = config.metric || "";
  const predictorInterpretation = config.predictorInterpretation || "auto";
  if (!PREDICTOR_INTERPRETATIONS.has(predictorInterpretation)) {
    return { ok: false, mode, error: "Choose a valid predictor interpretation." };
  }
  if (!target) {
    return { ok: false, mode, error: "Choose a target column for targeted prediction." };
  }
  const profile = inferColumnProfile(rows, target);
  if (["rmsle", "rmse", "mae", "r2"].includes(metric) && !profile.numeric) {
    return {
      ok: false,
      mode,
      error: `${metric.toUpperCase()} requires a numeric target. ${target} appears to be text/categorical. Switch to Discovery scan.`,
      profile,
    };
  }
  if (metric === "rmsle" && profile.numeric && !profile.nonNegative) {
    return {
      ok: false,
      mode,
      error: `RMSLE requires a numeric non-negative target. ${target} appears to include negative values.`,
      profile,
    };
  }
  if (profile.type === "unknown") {
    return { ok: true, mode, target, metric, warning: `Target type for ${target} is unknown. Review the metric before running.`, profile };
  }
  return { ok: true, mode, target, metric, warnings: [], profile };
}

function applyDiscoveryScan(config) {
  return {
    ...config,
    mode: DISCOVERY_SCAN,
    exploreAll: true,
    target: "",
    metric: "",
    transform: "none",
    outcomeDomain: "unbounded",
    goal: "Discover and falsify reproducible structures across this dataset.",
  };
}

function applyTargetSelection(config, target) {
  return {
    ...config,
    mode: TARGETED_PREDICTION,
    exploreAll: false,
    target,
    metric: config.metric || "r2",
    goal: `Discover and falsify predictive structures for ${target}.`,
    predictorInterpretation: config.predictorInterpretation || "auto",
  };
}

function applyPredeclaredContrast(config, contrast = {}) {
  return {
    ...config,
    mode: PREDECLARED_CONTRAST,
    exploreAll: false,
    target: contrast.outcomeColumn || config.target || "",
    metric: "r2",
    transform: "none",
    outcomeDomain: "unbounded",
    predictorInterpretation: "predeclared_contrast",
    contrast,
    goal: "Evaluate a predeclared simulation contrast with conservative validation.",
  };
}

module.exports = {
  DISCOVERY_SCAN,
  TARGETED_PREDICTION,
  PREDECLARED_CONTRAST,
  applyDiscoveryScan,
  applyTargetSelection,
  applyPredeclaredContrast,
  inferColumnProfile,
  validateInvestigationConfig,
};
