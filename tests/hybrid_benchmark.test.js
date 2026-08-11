"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildManifest, gradeAnswer, summarize } = require("../lib/hybridBenchmark");

test("benchmark manifest freezes public tasks separately from private graders", () => {
  const tasks = [{ id: "t1", category: "logic", prompt: "Public prompt", grader: { type: "exact", value: "unknown" } }];
  const manifest = buildManifest({ tasks, model: "gpt-5.6", maxOutputTokens: 500 });
  assert.equal(manifest.task_count, 1);
  assert.equal(manifest.fairness_controls.gold_hidden_from_model, true);
  assert.notEqual(manifest.public_dataset_hash, manifest.private_grader_hash);
});

test("deterministic graders support exact final answers and required phrases", () => {
  assert.equal(gradeAnswer("Reasoning\nFINAL: unknown", { type: "exact", value: "unknown" }).correct, true);
  assert.equal(gradeAnswer("The claim is blocked by leakage.", { type: "contains", values: ["blocked", "leakage"] }).correct, true);
  assert.equal(gradeAnswer('Reasoning\nFINAL_JSON: {"c1":"unknown"}', { type: "target_states", states: { c1: "unknown" } }).correct, true);
});

test("summary reports accuracy, tokens, and actual Orbita use", () => {
  const results = [
    { arm: "llm_only", grade: { correct: false }, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, tool_receipts: [], orbita_used: false },
    { arm: "hybrid", grade: { correct: true }, usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 }, tool_receipts: [{ tool: "x" }], orbita_used: true },
  ];
  const value = summarize(results);
  assert.equal(value.hybrid_minus_llm_accuracy, 1);
  assert.equal(value.hybrid_minus_llm_tokens, -2);
  assert.equal(value.arms.hybrid.orbita_task_use_rate, 1);
});
