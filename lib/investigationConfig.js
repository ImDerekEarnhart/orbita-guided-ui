"use strict";

const DISCOVERY_SCAN = "discovery_scan";
const TARGETED_PREDICTION = "targeted_prediction";

function inferColumnProfile(rows = [], column) {
  const values = rows
    .map(row => row?.[column])
    .filter(value => value !== undefined && value !== null && String(value).trim() !== "");
  if (!column || !values.length) return { type: "unknown", numeric: false, nonNegative: false };
  const numbers = values.map(value => Number(String(value).replace(/,/g, "")));
  const numericCount = numbers.filter(Number.isFinite).length;
  const numeric = numericCount >= Math.max(3, Math.ceil(values.length * 0.9));
  if (!numeric) {
    const distinct = new Set(values.map(value => String(value).trim())).size;
    return { type: "categorical", numeric: false, nonNegative: false, distinct };
  }
  const nonNegative = numbers.filter(Number.isFinite).every(value => value >= 0);
  return { type: "numeric", numeric: true, nonNegative, min: Math.min(...numbers.filter(Number.isFinite)) };
}

function validateInvestigationConfig(config, rows = []) {
  const mode = config.mode || (config.exploreAll ? DISCOVERY_SCAN : TARGETED_PREDICTION);
  if (mode === DISCOVERY_SCAN) {
    return { ok: true, mode, target: "", metric: null, warnings: [] };
  }
  const target = config.target || "";
  const metric = config.metric || "";
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
  };
}

module.exports = {
  DISCOVERY_SCAN,
  TARGETED_PREDICTION,
  applyDiscoveryScan,
  applyTargetSelection,
  inferColumnProfile,
  validateInvestigationConfig,
};
