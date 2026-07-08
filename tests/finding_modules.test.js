"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildFindingModules, findingColumns, baseColumn } = require("../lib/findingModules.js");

// Build a raw engine finding + its enriched claim, the shape renderCase sees.
function pair(candidateId, { predictor, outcome, predictors, group, verdict = "committed",
                            finding_type = "robust_relation", score = 0.8, detail = {} } = {}) {
  const payload = { kind: predictors ? "composite_linear" : "linear_association" };
  if (predictor) payload.predictor = predictor;
  if (outcome) payload.outcome = outcome;
  if (predictors) payload.predictors = predictors;
  if (group) { payload.group = group; payload.kind = "group_difference"; }
  return {
    finding: { candidate: { id: candidateId, payload, statement: `${predictor || (predictors || []).join("+")} → ${outcome || group}` },
               selection_metric_score: score, final_status: verdict },
    claim: { claim_id: `claim_${candidateId}`, source_candidate_id: candidateId,
             finding_type, verdict, finding_detail: { hypothesis_text: `hyp ${candidateId}`, candidate_score: score, ...detail } },
  };
}

function split(pairs) {
  return { findings: pairs.map(p => p.finding), claims: pairs.map(p => p.claim) };
}

describe("Phase 2D-A finding module summaries", () => {
  it("baseColumn folds log_ columns onto their base", () => {
    assert.equal(baseColumn("log_mass"), "mass");
    assert.equal(baseColumn("mass"), "mass");
  });

  it("findingColumns reads payload columns and de-dups log/raw", () => {
    const cols = findingColumns({ predictor: "log_x", outcome: "y", predictors: ["x", "z"] }, {});
    assert.deepEqual([...cols].sort(), ["x", "y", "z"]);
  });

  it("groups a black-hole-like case by outcome/target (mass module, distance module)", () => {
    const pairs = [
      pair("m1", { predictor: "chirp_mass", outcome: "mass" }),
      pair("m2", { predictor: "log_chirp_mass", outcome: "mass" }),
      pair("m3", { predictor: "spin", outcome: "mass" }),
      pair("d1", { predictor: "redshift", outcome: "distance" }),
      pair("d2", { predictor: "log_redshift", outcome: "distance" }),
      pair("d3", { predictor: "luminosity", outcome: "distance" }),
    ];
    const out = buildFindingModules(split(pairs));
    // Everything predicting mass is one module; everything predicting distance another.
    const massModule = out.modules.find(m => m.label.startsWith("mass"));
    const distModule = out.modules.find(m => m.label.startsWith("distance"));
    assert.ok(massModule && distModule, `got ${out.modules.map(m => m.label).join(" | ")}`);
    assert.equal(massModule.finding_count, 3, "all three mass predictors grouped together");
    assert.equal(distModule.finding_count, 3);
    assert.equal(out.total_findings, 6);
  });

  it("subdivides a single-dominant-target case (T-cell) into predictor-theme modules", () => {
    // One outcome (exhaustion) with predictors in two disjoint themes linked by
    // a shared secondary column each — the noisy single-target regime.
    const immune = ["cd8", "pd1", "adenosine"].map((p, i) =>
      pair(`i${i}`, { predictors: [p, "immune_axis"], outcome: "exhaustion" }));
    const metabolic = ["atp", "ros", "mito"].map((p, i) =>
      pair(`m${i}`, { predictors: [p, "metabolic_axis"], outcome: "exhaustion" }));
    const out = buildFindingModules(split([...immune, ...metabolic]));
    const science = out.modules.filter(m => m.theme !== "caveats");
    assert.ok(science.length >= 2, `single target must subdivide, got ${science.map(m => m.label).join(" | ")}`);
    // Each sub-module names exhaustion as its predictive context.
    assert.ok(science.every(m => m.context_columns.includes("exhaustion")));
  });

  it("collects artifact / data-quality findings into one caveats module with badges", () => {
    const pairs = [
      pair("g1", { predictor: "cd8", outcome: "exhaustion" }),
      pair("g2", { predictor: "adenosine", outcome: "exhaustion" }),
      pair("a1", { predictor: "ratio_x", outcome: "exhaustion", verdict: "artifact",
                   finding_type: "artifact",
                   detail: { artifact_warning: { type: "derived_dependency_field", inputs: ["x", "total"] } } }),
    ];
    const out = buildFindingModules(split(pairs));
    const caveats = out.modules.find(m => m.theme === "caveats");
    assert.ok(caveats, "a caveats module must exist");
    assert.equal(caveats.finding_count, 1);
    assert.ok(caveats.warning_badges.includes("derived-feature risk"));
    assert.ok(out.case_badges.includes("derived-feature risk"));
  });

  it("surfaces scientific warning badges from structured detail fields", () => {
    const pairs = [
      pair("w1", { predictor: "flux", outcome: "signal",
                   detail: { influence_warning: { type: "high_leverage" },
                             missingness: { substantial_missingness: true } } }),
      pair("w2", { predictor: "flux2", outcome: "signal",
                   detail: { informative_missingness_warning: { type: "informative_missingness" } } }),
    ];
    const out = buildFindingModules(split(pairs));
    assert.ok(out.case_badges.includes("influence outliers"));
    assert.ok(out.case_badges.includes("substantial missingness"));
    assert.ok(out.case_badges.includes("informative missingness"));
  });

  it("never mutates the input claims or findings (read-only presentation)", () => {
    const pairs = [pair("m1", { predictor: "a", outcome: "b" }), pair("m2", { predictor: "a", outcome: "c" })];
    const { findings, claims } = split(pairs);
    const snapshot = JSON.stringify({ findings, claims });
    buildFindingModules({ findings, claims });
    assert.equal(JSON.stringify({ findings, claims }), snapshot, "inputs must be untouched");
  });

  it("generates deterministic module IDs for review references", () => {
    const pairs = [
      pair("m1", { predictor: "chirp", outcome: "mass" }),
      pair("m2", { predictor: "spin", outcome: "mass" }),
    ];
    const first = buildFindingModules(split(pairs));
    const second = buildFindingModules(split(pairs));
    assert.equal(first.modules[0].id, second.modules[0].id);
    assert.ok(first.modules[0].id.startsWith("module_"));
  });

  it("handles claims-only input (no raw findings) without throwing", () => {
    const claims = [
      { claim_id: "c1", source_candidate_id: "c1", finding_type: "robust_relation", verdict: "committed",
        finding_detail: { hypothesis_text: "x drives y",
                          missingness: { missing_fraction_by_variable: { x: 0.1, y: 0.0 } } } },
    ];
    const out = buildFindingModules({ findings: [], claims });
    assert.equal(out.total_findings, 1);
    assert.ok(out.modules.length >= 1);
  });

  it("returns an empty structure for an empty case", () => {
    const out = buildFindingModules({ findings: [], claims: [] });
    assert.deepEqual(out.modules, []);
    assert.equal(out.total_findings, 0);
    assert.deepEqual(out.case_badges, []);
  });

  it("does not subdivide a small multi-target case (keeps clean outcome modules)", () => {
    // Below the dominant-subdivision threshold: two targets, three findings
    // each — should stay two tidy outcome modules, no predictor splitting.
    const pairs = [
      pair("m1", { predictor: "chirp", outcome: "mass" }),
      pair("m2", { predictor: "spin", outcome: "mass" }),
      pair("d1", { predictor: "z", outcome: "distance" }),
      pair("d2", { predictor: "lum", outcome: "distance" }),
    ];
    const out = buildFindingModules(split(pairs));
    assert.equal(out.modules.length, 2);
    assert.ok(out.modules.every(m => m.context_columns.length === 0));
  });
});
