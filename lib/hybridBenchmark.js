"use strict";

const crypto = require("node:crypto");

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function normalizeAnswer(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function gradeAnswer(text, grader) {
  const answer = normalizeAnswer(text);
  if (!grader || typeof grader !== "object") throw new Error("Every benchmark task needs a deterministic grader.");
  if (grader.type === "contains") {
    const expected = (grader.values || [grader.value]).filter(Boolean).map(normalizeAnswer);
    return { correct: expected.every(value => answer.includes(value)), expected };
  }
  if (grader.type === "exact") {
    const expected = normalizeAnswer(grader.value);
    const match = answer.match(/final\s*:\s*([^\n]+)/i);
    const observed = normalizeAnswer(match ? match[1] : answer);
    return { correct: observed === expected, expected, observed };
  }
  if (grader.type === "regex") {
    const expression = new RegExp(grader.pattern, grader.flags || "i");
    return { correct: expression.test(String(text || "")), expected: grader.pattern };
  }
  if (grader.type === "target_states") {
    const marker = String(text || "").match(/FINAL_JSON\s*:\s*(```json\s*)?(\{[^]*?\})(\s*```)?\s*$/i);
    let observed = {};
    try { observed = marker ? JSON.parse(marker[2]) : {}; }
    catch (_) { observed = {}; }
    const expected = grader.states || {};
    const correct = Object.keys(observed).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => normalizeAnswer(observed[key]) === normalizeAnswer(value));
    return { correct, expected, observed };
  }
  throw new Error(`Unsupported grader type: ${grader.type}`);
}

function publicTask(task) {
  return {
    id: task.id,
    category: task.category || "uncategorized",
    ...(task.orbita_preprocess ? { orbita_preprocess: task.orbita_preprocess, orbita_task: task.orbita_task } : {}),
    messages: Array.isArray(task.messages)
      ? task.messages.map(item => ({ role: item.role, content: String(item.content || "") }))
      : [{ role: "user", content: String(task.prompt || "") }],
  };
}

function buildManifest({ tasks, model, maxOutputTokens }) {
  const publicTasks = tasks.map(publicTask);
  return {
    schema_version: "orbita-hybrid-benchmark/1.0",
    frozen_at: new Date().toISOString(),
    model,
    max_output_tokens: maxOutputTokens,
    arms: ["llm_only", "hybrid"],
    fairness_controls: {
      same_model: true,
      same_public_task_to_system: true,
      same_output_limit: true,
      gold_hidden_from_model: true,
      deterministic_grading: true,
      counterbalanced_arm_order: true,
      provider_storage: false,
      hybrid_model_receives_compact_orbita_result: tasks.some(task => Boolean(task.orbita_preprocess)),
    },
    task_count: tasks.length,
    public_dataset_hash: sha256(publicTasks),
    private_grader_hash: sha256(tasks.map(task => ({ id: task.id, grader: task.grader }))),
    task_hashes: publicTasks.map(task => ({ id: task.id, hash: sha256(task) })),
  };
}

function compactAdjudication(result) {
  const states = {};
  for (const [listName, idName] of [
    ["claim_judgments", "claim_id"],
    ["action_judgments", "action_id"],
    ["discovery_judgments", "hypothesis_id"],
  ]) {
    for (const item of result?.[listName] || []) states[item[idName]] = item.state;
  }
  return {
    schema_version: result?.schema_version,
    task_id: result?.task_id,
    task_hash: result?.task_hash,
    states,
    covered: result?.decision_basis?.coverage?.covered,
    coverage_reason: result?.decision_basis?.coverage?.reason,
    limitations: result?.limitations || [],
  };
}

function summarize(results) {
  const byArm = {};
  for (const arm of ["llm_only", "hybrid"]) {
    const rows = results.filter(row => row.arm === arm);
    const correct = rows.filter(row => row.grade.correct).length;
    const input = rows.reduce((sum, row) => sum + row.usage.input_tokens, 0);
    const output = rows.reduce((sum, row) => sum + row.usage.output_tokens, 0);
    const total = rows.reduce((sum, row) => sum + row.usage.total_tokens, 0);
    byArm[arm] = {
      tasks: rows.length,
      correct,
      accuracy: rows.length ? correct / rows.length : 0,
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      average_tokens: rows.length ? total / rows.length : 0,
      orbita_tool_calls: rows.reduce((sum, row) => sum + row.tool_receipts.length, 0),
      orbita_task_use_rate: rows.length ? rows.filter(row => row.orbita_used).length / rows.length : 0,
    };
  }
  return {
    arms: byArm,
    hybrid_minus_llm_accuracy: byArm.hybrid.accuracy - byArm.llm_only.accuracy,
    hybrid_minus_llm_tokens: byArm.hybrid.total_tokens - byArm.llm_only.total_tokens,
    hybrid_token_ratio: byArm.llm_only.total_tokens ? byArm.hybrid.total_tokens / byArm.llm_only.total_tokens : null,
  };
}

module.exports = { buildManifest, compactAdjudication, gradeAnswer, publicTask, sha256, stableJson, summarize };
