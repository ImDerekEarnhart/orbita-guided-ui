"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DISCOVERY_SCAN,
  TARGETED_PREDICTION,
  applyDiscoveryScan,
  applyTargetSelection,
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
});
