"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DISCOVERY_SCAN,
  TARGETED_PREDICTION,
  PREDECLARED_CONTRAST,
  applyDiscoveryScan,
  applyTargetSelection,
  applyPredeclaredContrast,
  validateInvestigationConfig,
} = require("../lib/investigationConfig.js");

describe("investigation mode config", () => {
  const rows = [
    { action_description: "move left", y: "1.2", debt: "-1" },
    { action_description: "move right", y: "2.5", debt: "0" },
    { action_description: "attack", y: "3.1", debt: "2" },
  ];

  it("Discovery scan clears target and metric", () => {
    const config = applyDiscoveryScan({ target: "action_description", metric: "rmsle" });
    assert.equal(config.mode, DISCOVERY_SCAN);
    assert.equal(config.exploreAll, true);
    assert.equal(config.target, "");
    assert.equal(config.metric, "");
    const validation = validateInvestigationConfig(config, rows);
    assert.equal(validation.ok, true);
    assert.equal(validation.target, "");
    assert.equal(validation.metric, null);
  });

  it("Targeted prediction requires target column", () => {
    const validation = validateInvestigationConfig({ mode: TARGETED_PREDICTION, metric: "r2" }, rows);
    assert.equal(validation.ok, false);
    assert.match(validation.error, /Choose a target column/);
  });

  it("blocks RMSLE for text/categorical targets", () => {
    const validation = validateInvestigationConfig({
      mode: TARGETED_PREDICTION,
      target: "action_description",
      metric: "rmsle",
    }, rows);
    assert.equal(validation.ok, false);
    assert.match(validation.error, /RMSLE requires a numeric target/);
  });

  it("blocks RMSLE for negative numeric targets", () => {
    const validation = validateInvestigationConfig({
      mode: TARGETED_PREDICTION,
      target: "debt",
      metric: "rmsle",
    }, rows);
    assert.equal(validation.ok, false);
    assert.match(validation.error, /non-negative target/);
  });

  it("choosing a target switches to targeted mode", () => {
    const config = applyTargetSelection(applyDiscoveryScan({}), "y");
    assert.equal(config.mode, TARGETED_PREDICTION);
    assert.equal(config.exploreAll, false);
    assert.equal(config.target, "y");
    assert.match(config.goal, /for y/);
    assert.equal(validateInvestigationConfig(config, rows).ok, true);
  });

  it("accepts explicit predictor interpretation for targeted mode", () => {
    const validation = validateInvestigationConfig({
      mode: TARGETED_PREDICTION,
      target: "y",
      metric: "r2",
      predictorInterpretation: "binary_indicator",
    }, rows);
    assert.equal(validation.ok, true);
  });

  it("validates predeclared contrast mode", () => {
    const config = applyPredeclaredContrast({}, {
      outcomeColumn: "y",
      contrastColumn: "action_description",
      positiveLevel: "move left",
      referenceLevel: "move right",
      blockColumn: "",
    });
    assert.equal(config.mode, PREDECLARED_CONTRAST);
    assert.equal(config.predictorInterpretation, "predeclared_contrast");
    const validation = validateInvestigationConfig(config, rows);
    assert.equal(validation.ok, true);
    assert.equal(validation.target, "y");
    assert.equal(validation.metric, "r2");
  });

  it("rejects invalid predeclared contrast configs", () => {
    const nonNumeric = validateInvestigationConfig({
      mode: PREDECLARED_CONTRAST,
      contrast: {
        outcomeColumn: "action_description",
        contrastColumn: "y",
        positiveLevel: "1.2",
        referenceLevel: "2.5",
      },
    }, rows);
    assert.equal(nonNumeric.ok, false);
    assert.match(nonNumeric.error, /numeric outcome/);

    const sameLevel = validateInvestigationConfig({
      mode: PREDECLARED_CONTRAST,
      contrast: {
        outcomeColumn: "y",
        contrastColumn: "action_description",
        positiveLevel: "move left",
        referenceLevel: "move left",
      },
    }, rows);
    assert.equal(sameLevel.ok, false);
    assert.match(sameLevel.error, /must differ/);
  });
});
