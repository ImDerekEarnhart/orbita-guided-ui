#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createOpenAIProvider, createOrbitaTools, runConversation } = require("../lib/hybridChat");
const { createOrbitaBackend } = require("../lib/orbitaBackend");
const { buildManifest, compactAdjudication, gradeAnswer, publicTask, sha256, stableJson, summarize } = require("../lib/hybridBenchmark");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readJsonl(filename) {
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`Invalid JSON on dataset line ${index + 1}: ${error.message}`); }
  });
}

async function main() {
  const datasetArg = argument("--dataset");
  const outputArg = argument("--out");
  const limit = Number(argument("--limit", "0"));
  const maxOutputTokens = Number(argument("--max-output-tokens", "600"));
  if (!datasetArg || !outputArg) {
    throw new Error("Usage: npm run benchmark:hybrid -- --dataset tasks.jsonl --out results-directory [--limit N]");
  }
  const dataset = path.resolve(datasetArg);
  const output = path.resolve(outputArg);
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing benchmark output: ${output}`);
  let tasks = readJsonl(dataset);
  if (limit > 0) tasks = tasks.slice(0, limit);
  if (!tasks.length) throw new Error("The benchmark dataset is empty.");
  for (const task of tasks) {
    if (!task.id || !task.grader) throw new Error("Every task needs id and grader fields.");
  }

  const provider = createOpenAIProvider();
  const backend = createOrbitaBackend();
  if (backend.mode !== "unified" || !backend.configured) throw new Error("Hybrid benchmarking requires ORBITA_UNIFIED_CORE_URL and ORBITA_UNIFIED_CORE_TOKEN.");
  const benchmarkUserId = process.env.ORBITA_BENCHMARK_USER_ID || "00000000-0000-4000-8000-000000000001";
  const tools = createOrbitaTools({ backend, userId: benchmarkUserId });
  const manifest = buildManifest({ tasks, model: provider.model, maxOutputTokens });

  fs.mkdirSync(output, { recursive: false });
  // The preregistration is written before the first model call.
  fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  const resultFile = path.join(output, "results.jsonl");
  const results = [];

  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
    const task = tasks[taskIndex];
    const armOrder = taskIndex % 2 ? ["hybrid", "llm_only"] : ["llm_only", "hybrid"];
    for (const arm of armOrder) {
      const started = Date.now();
      let messages = publicTask(task).messages;
      let offeredTools = arm === "hybrid" ? tools : [];
      let preprocessingReceipt = null;
      if (arm === "hybrid" && task.orbita_preprocess === "adjudicate") {
        const adjudicator = tools.find(tool => tool.name === "orbita_adjudicate");
        if (!adjudicator || !task.orbita_task) throw new Error(`Task ${task.id} cannot use adjudication preprocessing.`);
        const toolStarted = Date.now();
        const governedResult = await adjudicator.execute({ task: task.orbita_task });
        const compact = compactAdjudication(governedResult);
        preprocessingReceipt = {
          tool: adjudicator.name,
          call_id: `preprocess:${task.id}`,
          ok: true,
          duration_ms: Date.now() - toolStarted,
          result_hash: sha256(stableJson(governedResult)),
          summary: adjudicator.summarize(governedResult),
          routing: "gold_free_pre_model",
        };
        messages = [{
          role: "user",
          content: `Orbita has already adjudicated the public structured task. Explain the governed result briefly, then end with exactly one FINAL_JSON line containing every target state.\n\nORBITA_COMPACT_RESULT:\n${JSON.stringify(compact)}`,
        }];
        offeredTools = [];
      }
      const response = await runConversation({
        provider,
        messages,
        tools: offeredTools,
        mode: arm,
        maxOutputTokens,
        metadata: { surface: "orbita_benchmark", arm },
      });
      const row = {
        task_id: task.id,
        category: task.category || "uncategorized",
        arm,
        model: response.model,
        answer: response.text,
        grade: gradeAnswer(response.text, task.grader),
        usage: response.usage,
        orbita_used: Boolean(preprocessingReceipt) || response.orbita_used,
        tool_receipts: [...(preprocessingReceipt ? [preprocessingReceipt] : []), ...response.tool_receipts],
        duration_ms: Date.now() - started,
      };
      results.push(row);
      fs.appendFileSync(resultFile, `${JSON.stringify(row)}\n`);
      process.stdout.write(`${task.id} ${arm}: ${row.grade.correct ? "correct" : "incorrect"} (${row.usage.total_tokens} tokens)\n`);
    }
  }

  const summary = { ...summarize(results), completed_at: new Date().toISOString(), manifest: "manifest.json", results: "results.jsonl" };
  fs.writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
