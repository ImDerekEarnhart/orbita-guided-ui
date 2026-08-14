"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createOrbitaTools, runConversation } = require("../lib/hybridChat");

test("LLM-alone arm never receives Orbita tools", async () => {
  const calls = [];
  const provider = {
    model: "fixed-test-model",
    async create(payload) {
      calls.push(payload);
      return { id: "r1", model: this.model, output_text: "Baseline answer", output: [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
    },
  };
  const result = await runConversation({
    provider, mode: "llm_only", messages: [{ role: "user", content: "Assess this" }],
    tools: [{ name: "should_not_appear", execute: async () => ({}) }],
  });
  assert.equal(result.orbita_used, false);
  assert.equal(calls[0].tools, undefined);
  assert.equal(result.usage.total_tokens, 12);
});

test("hybrid arm executes a bounded tool and returns a hashed receipt", async () => {
  let round = 0;
  const provider = {
    model: "fixed-test-model",
    async create() {
      round++;
      if (round === 1) {
        return {
          id: "r1", model: this.model,
          output: [{ type: "function_call", name: "orbita_memory_status", arguments: "{}", call_id: "c1" }],
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        };
      }
      return { id: "r2", model: this.model, output_text: "Orbita reports no imported memory.", output: [], usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 } };
    },
  };
  const result = await runConversation({
    provider, mode: "hybrid", messages: [{ role: "user", content: "Check memory" }],
    tools: [{
      name: "orbita_memory_status", description: "status", parameters: { type: "object", properties: {} },
      execute: async () => ({ message_count: 0 }), summarize: value => `${value.message_count} messages`,
    }],
  });
  assert.equal(result.orbita_used, true);
  assert.equal(result.tool_receipts[0].tool, "orbita_memory_status");
  assert.match(result.tool_receipts[0].result_hash, /^[a-f0-9]{64}$/);
  assert.equal(result.usage.total_tokens, 26);
});

test("Orbita tool adapter sends the Guided user identity to the shared core", async () => {
  const requests = [];
  const backend = {
    url: path => `https://core.example/guided/v1${path}`,
    headers: userId => ({ Authorization: "Bearer test", "X-Orbita-User-Id": userId }),
  };
  const tools = createOrbitaTools({
    backend, userId: "user-1",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, text: async () => JSON.stringify({ cases: [] }) };
    },
  });
  await tools.find(tool => tool.name === "orbita_list_cases").execute({});
  assert.equal(requests[0].options.headers["X-Orbita-User-Id"], "user-1");
});

test("Guided hybrid exposes semantic audits but no semantic activation tool", async () => {
  const requests = [];
  const backend = {
    url: path => `https://core.example/guided/v1${path}`,
    headers: userId => ({ Authorization: "Bearer test", "X-Orbita-User-Id": userId }),
  };
  const tools = createOrbitaTools({
    backend, userId: "user-1",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, text: async () => JSON.stringify({ present_only_collision_count: 1, admission_decision: "none" }) };
    },
  });
  const names = new Set(tools.map(tool => tool.name));
  assert.ok(names.has("orbita_build_language_snapshot"));
  assert.ok(names.has("orbita_audit_representation"));
  assert.ok(names.has("orbita_audit_temporal_unaskability"));
  assert.ok(names.has("orbita_build_capability_component_graph"));
  assert.ok(names.has("orbita_executor_registry_status"));
  assert.ok(names.has("orbita_list_candidate_execution_receipts"));
  assert.ok(names.has("orbita_get_candidate_execution_receipt"));
  assert.ok(names.has("orbita_verify_candidate_execution_receipt"));
  assert.ok(names.has("orbita_evidence_normalization_status"));
  assert.ok(names.has("orbita_list_normalized_evidence"));
  assert.ok(names.has("orbita_get_normalized_evidence"));
  assert.ok(names.has("orbita_verify_normalized_evidence"));
  assert.ok(names.has("orbita_check_evidence_eligibility"));
  assert.ok(names.has("orbita_normalize_discovery_run_evidence"));
  assert.ok(names.has("orbita_normalize_external_experiment_evidence"));
  assert.ok(names.has("orbita_create_general_problem_loop"));
  assert.ok(names.has("orbita_get_general_problem_loop"));
  assert.ok(names.has("orbita_advance_general_problem_loop"));
  assert.ok(names.has("orbita_verify_general_problem_loop"));
  assert.equal(names.has("orbita_activate_language_transition"), false);
  await tools.find(tool => tool.name === "orbita_audit_temporal_unaskability").execute({
    histories: [{ world_id: "a", values: [0, 1], outcome: 0 }, { world_id: "b", values: [2, 1], outcome: 1 }],
    candidates: [{ name: "lag", operator: "lag", parameters: { lag: 1 } }],
  });
  assert.equal(requests[0].url, "https://core.example/guided/v1/semantic/temporal-audit");
  assert.equal(requests[0].options.method, "POST");
});
