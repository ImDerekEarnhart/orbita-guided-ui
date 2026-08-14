"use strict";

const crypto = require("node:crypto");

const DEFAULT_MODEL = "gpt-5.6";
const DEFAULT_MAX_OUTPUT_TOKENS = 1_200;
const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_OUTPUT_CHARACTERS = 60_000;

const HYBRID_INSTRUCTIONS = `You are the conversational layer for Orbita, a governed research system.
Use ordinary language, but keep epistemic boundaries exact.
Use an Orbita tool whenever the user asks Orbita to inspect, adjudicate, compress, remember, or retrieve governed evidence.
Never say Orbita tested, found, remembered, or proved something unless a tool receipt in this response supports it.
Treat associations as non-causal unless the evidence design warrants causality.
If a task is outside a tool's structured schema, explain what fields are missing and ask one focused follow-up question.
Do not approve plans, delete data, freeze operators, or record results. Those actions require the existing human review controls.
Treat semantic repair candidates as proposals. Never claim that an inert language snapshot changed the production runtime.
Keep the answer concise and distinguish the model's explanation from Orbita's deterministic result.`;

const BASELINE_INSTRUCTIONS = `Answer the user's task using only the supplied conversation and context.
You do not have Orbita tools in this arm. Do not imply that Orbita inspected, tested, compressed, remembered, or verified anything.
Keep epistemic boundaries exact, avoid unsupported causal claims, and keep the answer concise.`;

class HybridChatError extends Error {}

function safeJson(value, maximum = MAX_TOOL_OUTPUT_CHARACTERS) {
  const encoded = JSON.stringify(value);
  if (encoded.length <= maximum) return encoded;
  return JSON.stringify({
    truncated: true,
    original_characters: encoded.length,
    preview: encoded.slice(0, maximum),
  });
}

function outputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  return (response?.output || [])
    .filter(item => item.type === "message")
    .flatMap(item => item.content || [])
    .filter(item => item.type === "output_text" && typeof item.text === "string")
    .map(item => item.text)
    .join("\n")
    .trim();
}

function usageOf(response) {
  return {
    input_tokens: Number(response?.usage?.input_tokens || 0),
    output_tokens: Number(response?.usage?.output_tokens || 0),
    total_tokens: Number(response?.usage?.total_tokens || 0),
  };
}

function addUsage(total, next) {
  total.input_tokens += next.input_tokens;
  total.output_tokens += next.output_tokens;
  total.total_tokens += next.total_tokens;
}

function openAIToolDefinition(tool) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

function createOpenAIProvider(env = process.env, fetchImpl = globalThis.fetch) {
  const apiKey = String(env.OPENAI_API_KEY || "");
  const model = String(env.ORBITA_CHAT_MODEL || DEFAULT_MODEL);
  if (!apiKey) throw new HybridChatError("The conversational model is not configured.");
  if (typeof fetchImpl !== "function") throw new HybridChatError("No HTTP provider is available.");

  return {
    model,
    async create(payload) {
      const response = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ store: false, ...payload }),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; }
      catch (_) { body = { error: { message: `Non-JSON provider response (HTTP ${response.status}).` } }; }
      if (!response.ok) {
        throw new HybridChatError(String(body?.error?.message || `Model request failed (${response.status}).`).slice(0, 300));
      }
      return body;
    },
  };
}

async function runConversation({
  provider,
  messages,
  tools = [],
  mode = "hybrid",
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  metadata = {},
}) {
  if (!provider?.create || !provider.model) throw new HybridChatError("A model provider is required.");
  if (!Array.isArray(messages) || !messages.length) throw new HybridChatError("At least one message is required.");
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 8_000) {
    throw new HybridChatError("maxOutputTokens must be between 64 and 8000.");
  }
  const hybrid = mode === "hybrid";
  const offeredTools = hybrid ? tools : [];
  const instructions = hybrid ? HYBRID_INSTRUCTIONS : BASELINE_INSTRUCTIONS;
  const input = messages.map(item => ({ role: item.role, content: String(item.content || "") }));
  const receipts = [];
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let nextInput = input;
  let finalResponse = null;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await provider.create({
      model: provider.model,
      instructions,
      input: nextInput,
      ...(offeredTools.length ? { tools: offeredTools.map(openAIToolDefinition), tool_choice: "auto" } : {}),
      max_output_tokens: maxOutputTokens,
      metadata,
    });
    addUsage(usage, usageOf(response));
    finalResponse = response;
    const calls = (response.output || []).filter(item => item.type === "function_call");
    if (!calls.length) break;
    if (!hybrid || round === MAX_TOOL_ROUNDS) {
      throw new HybridChatError("The model exceeded the governed tool-call limit.");
    }

    const outputs = [];
    for (const call of calls) {
      const tool = offeredTools.find(candidate => candidate.name === call.name);
      if (!tool) throw new HybridChatError(`The model requested an unavailable tool: ${call.name}`);
      let args;
      try { args = JSON.parse(call.arguments || "{}"); }
      catch (_) { args = {}; }
      const started = Date.now();
      let result;
      let ok = true;
      try { result = await tool.execute(args); }
      catch (error) {
        ok = false;
        result = { ok: false, error: String(error?.message || error).slice(0, 300) };
      }
      const receipt = {
        tool: tool.name,
        call_id: call.call_id,
        ok,
        duration_ms: Date.now() - started,
        result_hash: crypto.createHash("sha256").update(safeJson(result, 1_000_000)).digest("hex"),
        summary: tool.summarize ? tool.summarize(result) : undefined,
      };
      receipts.push(receipt);
      outputs.push({ type: "function_call_output", call_id: call.call_id, output: safeJson(result) });
    }
    // Keep the tool exchange in the next request. This works with store:false
    // and avoids relying on provider-side conversation storage.
    nextInput = [...nextInput, ...(response.output || []), ...outputs];
  }

  const text = outputText(finalResponse);
  if (!text) throw new HybridChatError("The model returned no readable answer.");
  return {
    id: finalResponse.id,
    model: finalResponse.model || provider.model,
    mode,
    text,
    usage,
    tool_receipts: receipts,
    orbita_used: receipts.length > 0,
  };
}

function jsonTool({ name, description, properties, required = [], execute, summarize }) {
  return {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    execute,
    summarize,
  };
}

function createOrbitaTools({ backend, userId, fetchImpl = globalThis.fetch }) {
  if (!backend?.url || !backend?.headers || !userId) throw new HybridChatError("Orbita tool identity is required.");

  async function request(pathname, { method = "GET", body } = {}) {
    const response = await fetchImpl(backend.url(pathname), {
      method,
      headers: { ...backend.headers(userId), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : {}; }
    catch (_) { value = { error: `Orbita returned non-JSON (HTTP ${response.status}).` }; }
    if (!response.ok) throw new HybridChatError(String(value.error || value.detail || `Orbita failed (${response.status}).`));
    return value;
  }

  return [
    jsonTool({
      name: "orbita_list_cases",
      description: "List this user's governed Orbita research cases.",
      properties: {},
      execute: () => request("/cases"),
      summarize: value => `${(value.cases || value || []).length || 0} case(s) returned`,
    }),
    jsonTool({
      name: "orbita_case_context",
      description: "Read compact profiles, plans, and run state for one Orbita case before discussing it.",
      properties: { case_id: { type: "string" } },
      required: ["case_id"],
      execute: args => request(`/cases/${encodeURIComponent(args.case_id)}/context`),
      summarize: value => `Context read for ${value?.case?.name || "case"}`,
    }),
    jsonTool({
      name: "orbita_adjudicate",
      description: "Apply Orbita's deterministic evidence rules to a structured epistemic task. Gold labels are forbidden.",
      properties: { task: { type: "object" } },
      required: ["task"],
      execute: args => request("/adjudicate", { method: "POST", body: { task: args.task } }),
      summarize: value => `Deterministic verdict: ${value?.verdict || value?.status || "returned"}`,
    }),
    jsonTool({
      name: "orbita_compress_evidence",
      description: "Select target-relevant items from a structured evidence task and return retained/dropped receipts.",
      properties: {
        task: { type: "object" },
        max_context_items: { type: "integer", minimum: 1, maximum: 64 },
      },
      required: ["task"],
      execute: args => request("/compress/evidence", { method: "POST", body: args }),
      summarize: value => `${value?.receipt?.retained_context_items ?? "?"} evidence item(s) retained`,
    }),
    jsonTool({
      name: "orbita_compress_code",
      description: "Select issue-relevant code files from user-supplied file contents without filesystem or model access.",
      properties: {
        issue: { type: "string" },
        files: { type: "array", items: { type: "object" } },
        max_files: { type: "integer", minimum: 1, maximum: 32 },
        max_characters: { type: "integer", minimum: 1000, maximum: 500000 },
      },
      required: ["issue", "files"],
      execute: args => request("/compress/code", { method: "POST", body: args }),
      summarize: value => `${value?.receipt?.retained_files ?? "?"}/${value?.receipt?.original_files ?? "?"} code files retained`,
    }),
    jsonTool({
      name: "orbita_build_language_snapshot",
      description: "Create an inert, hash-bound description of a finite language's primitives, observables, epistemic boundaries, permissions, and invariants.",
      properties: { spec: { type: "object" } },
      required: ["spec"],
      execute: args => request("/semantic/language-snapshot", { method: "POST", body: args }),
      summarize: value => `Inert language snapshot ${String(value?.snapshot_hash || "").slice(0, 12) || "returned"}`,
    }),
    jsonTool({
      name: "orbita_audit_representation",
      description: "Find exact finite representation collisions and nuisance overseparation under a hash-bound language snapshot.",
      properties: {
        snapshot: { type: "object" },
        cases: { type: "array", items: { type: "object" } },
      },
      required: ["snapshot", "cases"],
      execute: args => request("/semantic/representation-audit", { method: "POST", body: args }),
      summarize: value => `${(value?.collisions || []).length} collision(s); verdict ${value?.verdict || "returned"}`,
    }),
    jsonTool({
      name: "orbita_audit_temporal_unaskability",
      description: "Compare fixed present, lag, window, EWMA, linear, crossings, hysteresis, and State-Inertia operators on histories that collide at the present value.",
      properties: {
        histories: { type: "array", items: { type: "object" } },
        candidates: { type: "array", items: { type: "object" } },
        tolerance: { type: "number", minimum: 0 },
      },
      required: ["histories", "candidates"],
      execute: args => request("/semantic/temporal-audit", { method: "POST", body: args }),
      summarize: value => `${value?.present_only_collision_count ?? "?"} present-only collision(s) compared; no admission performed`,
    }),
    jsonTool({
      name: "orbita_build_capability_component_graph",
      description: "Connect archived capability primitives by exact output-to-input and capability-to-need matches; edges are hypotheses, not validated discoveries.",
      properties: { components: { type: "array", items: { type: "object" } } },
      required: ["components"],
      execute: args => request("/semantic/component-graph", { method: "POST", body: args }),
      summarize: value => `${(value?.components || []).length} component(s), ${(value?.edges || []).length} interface match(es)`,
    }),
    jsonTool({
      name: "orbita_memory_status",
      description: "Report how much of this user's imported conversation memory is indexed.",
      properties: {},
      execute: () => request("/memory/status"),
      summarize: value => `${value?.message_count ?? value?.messages ?? 0} indexed message(s)`,
    }),
    jsonTool({
      name: "orbita_search_memory",
      description: "Search this user's imported archive memory. Hits are quotations with provenance, not truth claims.",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        case_id: { type: "string" },
        role: { type: "string" },
      },
      required: ["query"],
      execute: args => request("/memory/search", { method: "POST", body: args }),
      summarize: value => `${value?.hit_count ?? (value?.hits || []).length ?? 0} memory hit(s)`,
    }),
    jsonTool({
      name: "orbita_find_reversals",
      description: "Surface possible changes of position from imported memory for human review; candidates are not contradictions.",
      properties: {
        case_id: { type: "string" }, role: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        min_days_apart: { type: "number", minimum: 0 },
      },
      execute: args => request("/memory/reversals", { method: "POST", body: args }),
      summarize: value => `${value?.candidate_count ?? (value?.candidates || []).length ?? 0} reversal candidate(s)`,
    }),
  ];
}

module.exports = {
  BASELINE_INSTRUCTIONS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MODEL,
  HYBRID_INSTRUCTIONS,
  HybridChatError,
  createOpenAIProvider,
  createOrbitaTools,
  runConversation,
};
