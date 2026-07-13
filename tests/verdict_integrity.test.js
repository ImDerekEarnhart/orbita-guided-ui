"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const verdict = require("../public/verdictPresentation.js");

function finding(overrides = {}) {
  return {
    id: "finding_1",
    final_status: "challenged",
    public_verdict: "provisional",
    selection_metric_score: null,
    final_validation_metric_score: null,
    candidate: {
      id: "cand_1",
      payload: {
        kind: "predeclared_contrast",
        outcome: "y",
        predictor: "is_t63",
      },
      statement: "is_t63 -> y",
    },
    finding_detail: {
      verdict_presentation: {
        label: "Provisional",
        headline: "Candidate remains provisional",
        summary: "Review-only simulation contrast.",
        detail_heading: "Why review is still required",
        survivor_language: false,
      },
      contrast_analysis: {
        validation_status: "validated_in_dataset",
        groups: {
          T63: { count: 16, mean: 18.1 },
          control: { count: 16, mean: 46.63 },
        },
      },
    },
    ...overrides,
  };
}

describe("verdict presentation integrity", () => {
  it("formats unavailable scores without turning null into zero", () => {
    assert.equal(verdict.formatScore(null), "Not available");
    assert.equal(verdict.formatScore(undefined), "Not available");
    assert.equal(verdict.formatScore(""), "Not available");
    assert.equal(verdict.formatScore(0), "0.000");
  });

  it("does not use survivor language for refuted or provisional findings", () => {
    const refuted = verdict.normalizeFinding({
      ...finding({ public_verdict: "rejected", final_status: "refuted" }),
      finding_detail: {
        verdict_presentation: {
          label: "Refuted",
          headline: "Candidate refuted",
          summary: "The stored verdict rejected this candidate under the configured checks.",
          detail_heading: "Why it was refuted",
          survivor_language: false,
        },
      },
    });
    assert.equal(refuted.status, "rejected");
    assert.doesNotMatch(refuted.presentation.summary, /surviv/i);

    assert.throws(() => verdict.normalizeFinding({
      ...finding(),
      finding_detail: {
        verdict_presentation: {
          label: "Refuted",
          headline: "Candidate refuted",
          summary: "This survived checks.",
          detail_heading: "Bad copy",
          survivor_language: false,
        },
      },
    }), /survivor language/);
  });

  it("selects only exact target selected models and otherwise stays review-only", () => {
    const payload = {
      result: {
        run_id: "run_1",
        selected_models: {
          other_target: {
            selected_model_id: "cand_other",
            evaluation_metric: "r2",
            selection_metric_score: 0.91,
          },
        },
        findings: [finding()],
      },
    };
    const normalized = verdict.normalizeRunResult(payload, { target: "y", metric: "r2" });
    assert.equal(normalized.hasSelectedModel, false);
    assert.equal(normalized.selected.id, "cand_1");
    assert.equal(normalized.selected.selectionScore, null);
  });

  it("preserves backend presentation, contrast analysis, and source predictors", () => {
    const normalized = verdict.normalizeRunResult({
      result: {
        findings: [finding({
          predictors: ["fallback_predictor"],
          candidate: {
            id: "cand_1",
            payload: { outcome: "y", predictors: [] },
            statement: "fallback_predictor -> y",
          },
        })],
      },
    }, { target: "y" });
    assert.equal(normalized.selected.presentation.headline, "Candidate remains provisional");
    assert.equal(normalized.selected.contrast.validation_status, "validated_in_dataset");
    assert.deepEqual(normalized.selected.predictors, ["fallback_predictor"]);
  });

  it("keeps supported association copy distinct from committed survivor language", () => {
    const supported = verdict.fallbackPresentation("supported_association");
    assert.equal(supported.survivor_language, false);
    assert.doesNotMatch(supported.summary, /surviv/i);
    assert.equal(verdict.fallbackPresentation("committed").survivor_language, true);
  });
});
