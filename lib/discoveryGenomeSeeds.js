"use strict";

const genome = require("./discoveryGenome");

const DEFAULT_OPERATORS = [
  {
    operator_key: "kill-switch-validation",
    name: "Kill-Switch Validation",
    description: "Disable the suspected mechanism, require the effect to vanish, then restore the mechanism and require recovery.",
    contract: {
      required_conditions: ["A manipulable candidate mechanism", "A measurable response", "A reversible disable/restore operation"],
      intervention: { action: "Enable or strengthen the candidate mechanism under a preregistered condition." },
      kill_switch: { action: "Disable, disconnect, terminate, block, or remove the candidate mechanism.", required_observation: "The predicted effect should materially weaken or vanish." },
      recovery_test: { action: "Restore the original mechanism without changing the primary measurement rule.", required_observation: "The effect should return in the preregistered direction." },
      held_out_prediction: { requirement: "Predict the enabled, disabled, and restored ordering before confirmation data are revealed." },
      expected_failure_signature: { permanent_refuter: "The response persists unchanged under a valid kill switch, or fails to recover after restoration." },
      domains_tested: ["electromagnetic hardware", "physical reservoir computing"],
      independence_level: "same_family",
      claims_affected: [],
    },
  },
  {
    operator_key: "boundary-first-discovery",
    name: "Boundary-First Discovery",
    description: "Search for the smallest counterexample or exact transition where a proposed rule stops working.",
    contract: {
      required_conditions: ["An ordered size, scale, or parameter axis", "An exact pass/fail predicate", "A bounded search or measurement protocol"],
      intervention: { action: "Move systematically toward the smallest failing instance or sharp transition boundary." },
      kill_switch: { action: "Cross the candidate boundary while holding the remaining protocol fixed.", required_observation: "The proposed property should change state at or near the preregistered boundary." },
      recovery_test: { action: "Return to the last passing side of the boundary.", required_observation: "The property should recover." },
      held_out_prediction: { requirement: "Predict an unseen boundary interval or minimal obstruction before evaluation." },
      expected_failure_signature: { permanent_refuter: "A smaller valid counterexample exists, or the predicted transition does not replicate." },
      domains_tested: ["finite graph theory", "algorithmic search"],
      independence_level: "same_family",
      claims_affected: [],
    },
  },
  {
    operator_key: "local-to-global-forcing",
    name: "Local-to-Global Forcing",
    description: "Test when accumulated local constraints force a global structure or invariant.",
    contract: {
      required_conditions: ["Explicit local constraints", "A measurable global structure", "A proof or falsification search over admissible configurations"],
      intervention: { action: "Increase or combine locally verified constraints while preserving admissibility." },
      kill_switch: { action: "Remove one necessary local constraint family.", required_observation: "The global conclusion should cease to be forced." },
      recovery_test: { action: "Restore the removed constraint family.", required_observation: "The forcing conclusion should return." },
      held_out_prediction: { requirement: "Predict a new admissible class where the local constraints force the global structure." },
      expected_failure_signature: { permanent_refuter: "An admissible counterexample satisfies every declared local constraint but lacks the global structure." },
      domains_tested: ["finite graph theory", "constraint systems", "cipher structure"],
      independence_level: "cross_domain",
      claims_affected: [],
    },
  },
  {
    operator_key: "forcing-versus-capacity",
    name: "Forcing-versus-Capacity",
    description: "Test whether transition or failure occurs when accumulated forcing exceeds recovery capacity.",
    contract: {
      required_conditions: ["A forcing or burden measure", "A recovery or reset capacity measure", "A declared transition outcome"],
      intervention: { action: "Vary forcing while independently measuring or manipulating recovery capacity." },
      kill_switch: { action: "Reduce forcing below capacity or increase recovery capacity above forcing.", required_observation: "Transition risk should materially weaken." },
      recovery_test: { action: "Restore the preregistered forcing-to-capacity ratio.", required_observation: "The transition signature should return." },
      held_out_prediction: { requirement: "Predict the held-out transition boundary using a normalized forcing/capacity relation." },
      expected_failure_signature: { permanent_refuter: "The transition is unrelated to the preregistered forcing/capacity ordering after artifact controls." },
      domains_tested: ["cross-domain early warning", "dynamical systems", "physical memory"],
      independence_level: "cross_domain",
      claims_affected: [],
    },
  },
  {
    operator_key: "executable-meaning",
    name: "Executable Meaning",
    description: "Treat a proposed symbol interpretation as meaningful only when it performs the predicted operation on unseen material.",
    contract: {
      required_conditions: ["A symbolic representation", "A proposed operational interpretation", "An unseen execution or transformation target"],
      intervention: { action: "Execute the proposed symbolic operator on a preregistered unseen target." },
      kill_switch: { action: "Shuffle, substitute, or structurally corrupt the operator while preserving superficial frequencies.", required_observation: "Operational performance should collapse." },
      recovery_test: { action: "Restore the original operator mapping.", required_observation: "Performance should recover." },
      held_out_prediction: { requirement: "Predict the output, transition, or constraint produced by unseen symbolic input." },
      expected_failure_signature: { permanent_refuter: "Corrupted or random mappings perform equally well, or the prediction fails on held-out symbols." },
      domains_tested: ["Voynich structure", "Maya calendar algebra", "cipher analysis"],
      independence_level: "cross_domain",
      claims_affected: [],
    },
  },
  {
    operator_key: "artifact-mimicry-detection",
    name: "Artifact Mimicry Detection",
    description: "Construct controlled fake versions of a pattern and require the discovery procedure to reject them.",
    contract: {
      required_conditions: ["A candidate pattern", "A plausible artifact-generating process", "A blinded discrimination metric"],
      intervention: { action: "Generate matched artifact mimics that preserve superficial structure but remove the proposed mechanism." },
      kill_switch: { action: "Replace genuine data with artifact mimics.", required_observation: "The discovery score or survival verdict should fall." },
      recovery_test: { action: "Restore independently collected or mechanism-preserving data.", required_observation: "The genuine pattern should recover." },
      held_out_prediction: { requirement: "Predict which blinded samples are genuine versus artifact-generated before labels are revealed." },
      expected_failure_signature: { permanent_refuter: "Artifact mimics survive at the same rate or score as genuine data." },
      domains_tested: ["tabular discovery", "cross-domain memory graphs", "signal analysis"],
      independence_level: "cross_domain",
      claims_affected: [],
    },
  },
  {
    operator_key: "scale-normalized-invariance",
    name: "Scale-Normalized Invariance",
    description: "Search for a relationship that remains stable after changing size, units, domain, or geometry.",
    contract: {
      required_conditions: ["A declared scale variable", "A dimensionless or normalized representation", "At least two independent scales or geometries"],
      intervention: { action: "Change physical size, units, sampling scale, or geometry while preserving the proposed normalized relation." },
      kill_switch: { action: "Use the raw unnormalized quantity or violate the proposed normalization.", required_observation: "Cross-scale stability should weaken." },
      recovery_test: { action: "Reapply the preregistered normalization.", required_observation: "Cross-scale agreement should recover." },
      held_out_prediction: { requirement: "Predict a normalized relation on an unseen scale, unit system, geometry, or domain." },
      expected_failure_signature: { permanent_refuter: "The normalized relation drifts systematically across held-out scales after measurement artifacts are controlled." },
      domains_tested: ["orbital scaling", "pendulum physics", "finite graph families", "hardware geometry"],
      independence_level: "cross_domain",
      claims_affected: [],
    },
  },
];

async function seedDefaultOperators(userId) {
  const existing = await genome.listOperators(userId);
  const keys = new Set(existing.map(item => item.operator_key));
  const created = [];
  const skipped = [];
  for (const item of DEFAULT_OPERATORS) {
    if (keys.has(item.operator_key)) {
      skipped.push(item.operator_key);
      continue;
    }
    created.push(await genome.createOperator(userId, {
      ...item,
      status: "review_needed",
      evidence: {
        provenance: "orbita_cross_domain_synthesis_seed_v1",
        caution: "Seeded as a review-needed operator. It is not validated or frozen.",
      },
    }));
  }
  return { created, skipped };
}

module.exports = { DEFAULT_OPERATORS, seedDefaultOperators };
