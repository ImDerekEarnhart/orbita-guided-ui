(() => {
  "use strict";

  // Localhost → dev/demo mode; deployed → always live via server-side proxy
  const DEV_MODE = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const verdictUi = window.OrbitaVerdictPresentation;

  const state = {
    cases:  [],
    graphs: [],
    selectedGraphId: null,
    wizard: freshWizard(),
    busy:   false,   // prevents duplicate run submissions
    me:     null,    // populated by /auth/me on first use
    systemHealth: null,
    chat: { conversations: [], activeId: null, messages: [], status: null, busy: false },
  };

  const app   = document.getElementById("app");
  const toast = makeToast(document.getElementById("toast"));

  window.addEventListener("hashchange", router);

  function freshWizard() {
    return {
      step: 1, file: null, parsed: null,
      caseName: "", goal: "", target: "",
      investigationMode: "discovery_scan", exploreAll: true, wizardError: "",
      predictorInterpretation: "auto",
      contrast: {
        outcomeColumn: "", contrastColumn: "", positiveLevel: "", referenceLevel: "",
        blockColumn: "", direction: "two_sided", primaryEffect: "mean_difference",
        validationMethod: "automatic_conservative",
      },
      metric: "rmsle", transform: "log1p", outcomeDomain: "nonneg",
      graphId: null, caseId: null, fileId: null, planId: null, runId: null,
      result: null, technical: {}
    };
  }

  function inferColumnProfile(rows = [], column) {
    const values = rows.map(row => row?.[column]).filter(value => value !== undefined && value !== null && String(value).trim() !== "");
    if (!column || !values.length) return { type: "unknown", numeric: false, nonNegative: false };
    const numbers = values.map(value => Number(String(value).replace(/,/g, "")));
    const numericCount = numbers.filter(Number.isFinite).length;
    const numeric = numericCount >= Math.max(3, Math.ceil(values.length * 0.9));
    if (!numeric) return { type: "categorical", numeric: false, nonNegative: false };
    return { type: "numeric", numeric: true, nonNegative: numbers.filter(Number.isFinite).every(value => value >= 0) };
  }

  function validateWizardConfig(w) {
    const mode = w.investigationMode || (w.exploreAll ? "discovery_scan" : "targeted_prediction");
    if (mode === "discovery_scan") return { ok: true, mode, target: "", metric: null };
    if (mode === "predeclared_contrast") {
      const c = w.contrast || {};
      if (!c.outcomeColumn || !c.contrastColumn || c.positiveLevel === "" || c.referenceLevel === "") {
        return { ok: false, error: "Complete the outcome, contrast, positive-level, and reference-level fields." };
      }
      if (String(c.positiveLevel) === String(c.referenceLevel)) {
        return { ok: false, error: "Positive and reference levels must differ." };
      }
      const profile = inferColumnProfile(w.parsed?.rows || [], c.outcomeColumn);
      if (!profile.numeric) return { ok: false, error: "Predeclared contrast requires a numeric outcome column." };
      return { ok: true, mode, target: c.outcomeColumn, metric: "r2" };
    }
    if (!w.target) return { ok: false, error: "Choose a target column for targeted prediction." };
    const profile = inferColumnProfile(w.parsed?.rows || [], w.target);
    if (["rmsle", "rmse", "mae", "r2"].includes(w.metric) && !profile.numeric) {
      return { ok: false, error: `${w.metric.toUpperCase()} requires a numeric target. ${w.target} appears to be text/categorical. Switch to Discovery scan.` };
    }
    if (w.metric === "rmsle" && profile.numeric && !profile.nonNegative) {
      return { ok: false, error: `RMSLE requires a numeric non-negative target. ${w.target} appears to include negative values.` };
    }
    if (profile.type === "unknown") return { ok: true, warning: `Target type for ${w.target} is unknown. Review the metric before running.` };
    return { ok: true };
  }

  function setDiscoveryScanMode(w) {
    w.investigationMode = "discovery_scan";
    w.exploreAll = true;
    w.target = "";
    w.metric = "";
    w.transform = "none";
    w.outcomeDomain = "unbounded";
    w.goal = "Discover and falsify reproducible structures across this dataset.";
  }

  function setTargetedMode(w, target = w.target) {
    w.investigationMode = "targeted_prediction";
    w.exploreAll = false;
    w.target = target || "";
    if (!w.metric) w.metric = "r2";
    if (!w.predictorInterpretation || w.predictorInterpretation === "predeclared_contrast") w.predictorInterpretation = "auto";
    if (w.target) w.goal = `Discover and falsify predictive structures for ${w.target}.`;
  }

  function setPredeclaredContrastMode(w) {
    const headers = w.parsed?.headers || [];
    w.investigationMode = "predeclared_contrast";
    w.exploreAll = false;
    w.metric = "r2";
    w.transform = "none";
    w.outcomeDomain = "unbounded";
    w.predictorInterpretation = "predeclared_contrast";
    w.contrast ||= {};
    w.contrast.outcomeColumn ||= w.target || headers.at(-1) || "";
    w.contrast.contrastColumn ||= headers.find(header => /^is_|group|regime|condition|treatment/i.test(header)) || headers[0] || "";
    const levels = columnLevels(w, w.contrast.contrastColumn);
    w.contrast.referenceLevel ||= levels[0] || "";
    w.contrast.positiveLevel ||= levels[1] || "";
    w.target = w.contrast.outcomeColumn;
    w.goal = "Evaluate a predeclared simulation contrast with conservative validation.";
  }

  function columnLevels(w, column) {
    return [...new Set((w.parsed?.rows || [])
      .map(row => row?.[column])
      .filter(value => value !== undefined && value !== null && String(value).trim() !== "")
      .map(String))];
  }

  // ── API ───────────────────────────────────────────────────────────────────────
  // All real calls go through /api/orbita/* on the same origin.
  // Credentials are added server-side — never sent to the browser.

  async function api(path, options = {}) {
    if (DEV_MODE) return mockApi(path, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(`/api/orbita${path}`, {
        ...options,
        headers: {
          ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      if (response.status === 401) { window.location.href = "/login"; return; }
      if (response.status === 403) throw new Error("Access denied.");
      const ct   = response.headers.get("content-type") || "";
      const body = ct.includes("application/json") ? await response.json() : await response.text();
      if (!response.ok) {
        const msg = typeof body === "string" ? body : body.detail || body.message || body.error || JSON.stringify(body);
        throw new Error(msg || `Request failed (${response.status})`);
      }
      return body;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Orbita took longer than two minutes to respond. The work may still be running, so check My cases before trying again.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadSystemHealth() {
    if (state.systemHealth) return state.systemHealth;
    try {
      const response = await fetch("/health", { headers: { Accept: "application/json" } });
      state.systemHealth = response.ok ? await response.json() : { status: "degraded" };
    } catch {
      state.systemHealth = { status: "unreachable" };
    }
    return state.systemHealth;
  }

  async function graphApi(path, options = {}) {
    if (DEV_MODE) return mockGraphApi(path, options);
    const response = await fetch(`/api/graphs${path}`, {
      ...options,
      headers: {
        ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(options.headers || {}),
      },
      redirect: "manual",
    });
    if (response.status === 401) { window.location.href = "/login"; return; }
    if (response.status === 403) throw new Error("Access denied.");
    const ct = response.headers.get("content-type") || "";
    const body = ct.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) throw new Error(typeof body === "string" ? body : body.error || body.detail || `Request failed (${response.status})`);
    return body;
  }

  // ── Mock API (localhost dev only) ─────────────────────────────────────────────
  async function chatApi(path, options = {}) {
    if (DEV_MODE) {
      if (path === "/status") return { configured: true, model: "gpt-5.6", default_mode: "hybrid" };
      if (path === "/conversations") return { conversations: state.chat.conversations };
      throw new Error("Chat persistence needs the running local server, not static preview mode.");
    }
    const response = await fetch(`/api/chat${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": state.me?.csrf_token || "" } : {}),
        ...(options.headers || {}),
      },
      redirect: "manual",
    });
    if (response.status === 401) { window.location.href = "/login"; return; }
    const ct = response.headers.get("content-type") || "";
    const body = ct.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) throw new Error(typeof body === "string" ? body : body.error || `Request failed (${response.status})`);
    return body;
  }

  async function mockApi(path, options = {}) {
    await wait(350);
    const method = (options.method || "GET").toUpperCase();
    if (path === "/health") return { status: "ok", version: "demo" };
    if (path === "/cases" && method === "GET") {
      return [
        { case_id: "case_demo_001", name: "Calorie expenditure", status: "completed", updated_at: new Date(Date.now() - 45 * 60000).toISOString() },
        { case_id: "case_demo_002", name: "Animal allometry",    status: "completed", updated_at: new Date(Date.now() - 2 * 86400000).toISOString() },
        { case_id: "case_demo_003", name: "Battery discharge",   status: "plan_ready", updated_at: new Date(Date.now() - 6 * 86400000).toISOString() },
      ];
    }
    if (path === "/cases" && method === "POST") return { case_id: `case_demo_${Date.now()}`, status: "created" };
    if (/\/files$/.test(path)   && method === "POST") return { file_id: `file_demo_${Date.now()}` };
    if (/\/compile$/.test(path) && method === "POST") return { plan_id: `plan_demo_${Date.now()}`, plan_hash: randomHash() };
    if (/\/run$/.test(path)     && method === "POST") return { run_id: `run_demo_${Date.now()}`, status: "queued" };
    if (/\/runs\//.test(path)  && method === "GET")  return demoRunResult();
    return { ok: true };
  }

  async function mockGraphApi(path, options = {}) {
    await wait(180);
    const method = (options.method || "GET").toUpperCase();
    state.graphs = state.graphs.length ? state.graphs : [
      { id: "graph_demo_project", name: "Cross-domain Reset Bottleneck Study", kind: "project", cases: [] },
    ];
    if (path === "" && method === "GET") return state.graphs;
    if (path === "" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const graph = { id: `graph_demo_${Date.now()}`, name: body.name || "Project graph", kind: "project", cases: [] };
      state.graphs.unshift(graph);
      return graph;
    }
    if (/\/operators\/propose$/.test(path) && method === "POST") {
      return { operators: demoOperators() };
    }
    if (/\/operators$/.test(path) && method === "GET") return { operators: demoOperators() };
    if (/\/operators\/[^/]+\/review$/.test(path)) {
      return { review: { review_status: "under_review", review_notes: "Demo review", checklist: {} } };
    }
    if (/\/trace$/.test(path) && method === "GET") {
      return { events: [{ event_type: "operator_proposed", title: "Demo operator proposed", admissibility_effect: "permits_question", description: "Candidate only; review required." }] };
    }
    if (/\/trace$/.test(path) && method === "POST") {
      return { event: { event_type: "method_chosen", title: "Demo trace note", admissibility_effect: "none" } };
    }
    if (/\/programme-state$/.test(path) && method === "GET") return { snapshot: demoProgrammeState() };
    if (/\/programme-state\/compile$/.test(path) && method === "POST") return { snapshot: demoProgrammeState() };
    if (/\/questions$/.test(path) && method === "GET") return { questions: demoQuestions() };
    if (/\/questions\/generate$/.test(path) && method === "POST") return { snapshot: demoProgrammeState(), questions: demoQuestions() };
    if (/\/questions\/[^/]+\/review$/.test(path) && method === "PATCH") return { question: { review_status: "accepted_candidate" } };
    if (/\/questions\/[^/]+\/materialize$/.test(path) && method === "POST") return { case_id: `case_demo_${Date.now()}` };
    return { id: path.split("/")[1], name: "Project graph", cases: [] };
  }

  function demoOperators() {
    return [{
      operator_id: "op_demo_reset",
      name: "Reset Bottleneck",
      status: "review_needed",
      description: "Candidate reset bottleneck pattern across linked cases.",
      evidence_count: 4,
      counterexample_count: 2,
      evidence_ratio: 0.667,
      confidence: "moderate candidate",
      why_proposed: "Proposed because repeated reset, capacity, or failure-bottleneck patterns appeared across 2 cases, with 4 evidence items and 2 counterexamples.",
      caution_labels: [],
      suspicion_flags: [],
      score_components: { case_diversity: 0.08, evidence_volume: 0.05, evidence_ratio: 0.23, counterexample_ratio_penalty: -0.06 },
      score_explanation: "Score rewards case diversity, evidence volume, and evidence ratio, then subtracts counterexample-load penalties.",
      case_breakdown: [
        { case_id: "case_demo_001", label: "Battery Demo - case_demo_001", evidence_count: 3, counterexample_count: 1, signal_tags: ["baseline"], claim_ids: ["claim_demo_1"], counterexample_ids: ["cx_demo_1"] },
        { case_id: "case_demo_003", label: "Grid Demo - case_demo_003", evidence_count: 1, counterexample_count: 1, signal_tags: ["held_out"], claim_ids: ["claim_demo_2"], counterexample_ids: ["cx_demo_2"] },
      ],
      supporting_case_ids: ["case_demo_001", "case_demo_003"],
      case_labels: [
        { case_id: "case_demo_001", label: "Battery Demo - case_demo_001" },
        { case_id: "case_demo_003", label: "Grid Demo - case_demo_003" },
      ],
      score: 0.62,
    }];
  }

  function demoQuestions() {
    return [{
      question_id: "q_demo_reset",
      question_text: "Does Reset Bottleneck replicate outside the dominant supporting case?",
      status: "needs_more_evidence",
      question_class: "replication",
      why_allowed: "The graph records a candidate pattern worth narrowing.",
      why_blocked: "A stronger claim is blocked until independent replication.",
      what_would_make_it_admissible: "Evidence from another independent case.",
      suggested_next_action: "Run a second independent case with the same falsifier shape.",
      trace_event_refs: ["event_demo"],
      related_operator_refs: ["op_demo_reset"],
      review_needed: true,
      review_status: "proposed",
    }];
  }

  function demoProgrammeState() {
    return {
      id: "snapshot_demo",
      source_trace_event_count: 3,
      carry_forward_objects: [{ type: "operator", id: "op_demo_reset", review_status: "accepted_candidate" }],
      unresolved_traceability_gaps: [],
      unresolved_artifact_warnings: [],
      active_stopping_rules: [],
      needs_replication: [{ type: "operator", id: "op_demo_reset", name: "Reset Bottleneck", reason: "Needs independent replication" }],
      needs_independent_dataset: [{ type: "operator", id: "op_demo_reset", name: "Reset Bottleneck" }],
      blocked_claim_classes: [{ class: "stronger_truth_claim", why: "Candidate only." }],
      allowed_question_classes: ["replication", "narrowing", "carry_forward"],
    };
  }

  function randomHash() {
    return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  }

  function demoRunResult() {
    return {
      run_id: `run_demo_${Date.now()}`, status: "completed",
      selected_models: { y: { selected_model_id: "composite:y:demo123", evaluation_metric: state.wizard.metric, selection_metric_score: .203 } },
      findings: [
        { candidate_id: "linear:x5_y", status: "supported", selection_metric_score: .328 },
        { candidate_id: "linear:x6_y", status: "supported", selection_metric_score: .454 },
        { candidate_id: "linear:x7_y", status: "supported", selection_metric_score: .293 },
        { candidate_id: "composite:y:demo123", status: "supported", predictors: ["x5", "x6", "x7"], selection_metric_score: .203, final_validation_metric_score: .202 },
      ],
    };
  }

  // ── User info ─────────────────────────────────────────────────────────────────
  async function getMe() {
    if (state.me) return state.me;
    if (DEV_MODE) { state.me = { username: "demo", email: "demo@localhost", id: "dev", email_verified: true }; return state.me; }
    try {
      const r = await fetch("/auth/me", { redirect: "manual" });
      const ct = r.headers.get("content-type") || "";
      // 401, an opaque redirect, or any non-JSON body all mean "not logged in".
      if (r.status === 401 || r.type === "opaqueredirect" || r.redirected || !ct.includes("application/json")) {
        window.location.href = "/login";
        return null;
      }
      state.me = await r.json();
      return state.me;
    } catch { window.location.href = "/login"; return null; }
  }

  function showVerificationBanner(me) {
    if (!me || me.email_verified) return;
    const existing = document.getElementById("verifyBanner");
    if (existing) return;
    const banner = document.createElement("div");
    banner.id = "verifyBanner";
    banner.style.cssText = "background:#fffbeb;border-bottom:1px solid #fcd34d;padding:10px 20px;font-size:13px;color:#92400e;display:flex;align-items:center;gap:12px;flex-wrap:wrap";
    banner.innerHTML = `<span>⚠ Your email address has not been verified. You won't be able to upload data or run discoveries until you verify it.</span><a href="/verify-email" style="font-weight:700;color:#92400e;white-space:nowrap">Verify now</a>`;
    document.body.insertBefore(banner, document.body.firstChild);
  }

  // ── Router ────────────────────────────────────────────────────────────────────
  async function router() {
    updateNav();
    const [me] = await Promise.all([getMe(), loadSystemHealth()]);
    showVerificationBanner(me);
    const hash = location.hash || "#/cases";
    if (hash === "#/new")        return renderWizard();
    if (hash === "#/account")    return renderAccount();
    if (hash === "#/projects")   return renderProjects();
    if (hash === "#/guide")      return renderGuide();
    if (hash === "#/chat" || hash.startsWith("#/chat/")) return renderChat();
    if (hash.startsWith("#/case/")) return renderCase(hash.split("/").pop());
    return renderCases();
  }

  function updateNav() {
    const hash = location.hash || "#/cases";
    document.querySelectorAll("[data-nav]").forEach(link => {
      const n = link.dataset.nav;
      const active = n === "new"     ? hash === "#/new"
        : n === "account" ? hash === "#/account"
        : n === "projects" ? hash === "#/projects"
        : n === "guide" ? hash === "#/guide"
        : n === "chat" ? hash === "#/chat" || hash.startsWith("#/chat/")
        : hash.startsWith("#/cases") || hash.startsWith("#/case/");
      link.classList.toggle("active", active);
    });
  }

  // ── Cases list ────────────────────────────────────────────────────────────────
  async function renderChat() {
    showLoading();
    try {
      const [status, list] = await Promise.all([chatApi("/status"), chatApi("/conversations")]);
      state.chat.status = status;
      state.chat.conversations = list.conversations || [];
      const requestedId = location.hash.startsWith("#/chat/") ? location.hash.split("/").pop() : null;
      state.chat.activeId = requestedId || state.chat.conversations[0]?.id || null;
      if (state.chat.activeId) {
        const detail = await chatApi(`/conversations/${encodeURIComponent(state.chat.activeId)}/messages`);
        state.chat.messages = detail.messages || [];
      } else state.chat.messages = [];
    } catch (error) {
      toast(error.message, true);
      state.chat.messages = [];
    }
    drawChat();
  }

  function drawChat() {
    const current = state.chat.conversations.find(item => item.id === state.chat.activeId);
    const messages = state.chat.messages.map(message => {
      const receipts = Array.isArray(message.tool_receipts) ? message.tool_receipts : [];
      return `<article class="chat-message ${message.role}">
        <div class="chat-role">${message.role === "assistant" ? "Orbita" : "You"}</div>
        <div class="chat-copy">${escapeHtml(message.content).replace(/\n/g, "<br>")}</div>
        ${message.role === "assistant" ? `<div class="chat-meta">
          <span>${message.mode === "hybrid" ? "Hybrid: model + Orbita" : "Model-only control"}</span>
          ${message.total_tokens ? `<span>${Number(message.total_tokens).toLocaleString()} model tokens</span>` : ""}
          ${receipts.length ? `<details><summary>${receipts.length} Orbita receipt${receipts.length === 1 ? "" : "s"}</summary><ul>${receipts.map(r => `<li><strong>${escapeHtml(r.tool)}</strong>: ${escapeHtml(r.summary || (r.ok ? "completed" : "failed"))}<br><code>${escapeHtml(String(r.result_hash || "").slice(0, 16))}</code></li>`).join("")}</ul></details>` : ""}
        </div>` : ""}
      </article>`;
    }).join("");

    app.innerHTML = `<section class="chat-shell">
      <aside class="chat-history">
        <button class="button accent" id="newChat">+ New conversation</button>
        <div class="chat-history-list">${state.chat.conversations.map(item => `<a href="#/chat/${escapeAttr(item.id)}" class="${item.id === state.chat.activeId ? "active" : ""}">${escapeHtml(item.title)}</a>`).join("") || '<p class="muted">No conversations yet.</p>'}</div>
      </aside>
      <div class="chat-main">
        <header class="chat-heading">
          <div><p class="eyebrow">Conversational research</p><h1>${escapeHtml(current?.title || "Ask Orbita")}</h1></div>
          <label class="chat-mode">How should I answer?<select id="chatMode"><option value="hybrid">Orbita + model (recommended)</option><option value="llm_only">Model only (benchmark control)</option></select></label>
        </header>
        ${!state.chat.status?.configured ? '<div class="chat-warning">Chat is built, but the model connection has not been enabled on this deployment.</div>' : ""}
        <div class="chat-quick" aria-label="Suggested prompts">${["What can Orbita help me do?", "List my research cases", "Check my imported memory", "Help me structure an adjudication task", "Help me compress code context"].map(prompt => `<button data-chat-prompt="${escapeAttr(prompt)}">${escapeHtml(prompt)}</button>`).join("")}</div>
        <div class="chat-stream" id="chatStream">${messages || `<div class="chat-welcome"><span class="brand-mark">O</span><h2>What are you trying to investigate?</h2><p>Use ordinary language. In Hybrid mode, the model explains your request and calls Orbita's governed tools when evidence needs to be checked.</p></div>`}</div>
        <form class="chat-composer" id="chatForm">
          <textarea id="chatInput" maxlength="100000" placeholder="Ask a question, describe evidence, or paste code..." ${state.chat.busy ? "disabled" : ""}></textarea>
          <div class="chat-composer-actions"><label class="file-button">Attach text <input id="chatFile" type="file" accept=".txt,.md,.json,.csv,.js,.jsx,.ts,.tsx,.py,.sql" /></label><span class="muted" id="chatFileName">Text/code files up to 100,000 characters</span><button class="button accent" type="submit" ${state.chat.busy || !state.chat.status?.configured ? "disabled" : ""}>${state.chat.busy ? "Thinking..." : "Send"}</button></div>
        </form>
      </div>
    </section>`;

    document.getElementById("newChat")?.addEventListener("click", createChat);
    document.querySelectorAll("[data-chat-prompt]").forEach(button => button.addEventListener("click", () => {
      document.getElementById("chatInput").value = button.dataset.chatPrompt;
      document.getElementById("chatInput").focus();
    }));
    document.getElementById("chatFile")?.addEventListener("change", attachChatFile);
    document.getElementById("chatForm")?.addEventListener("submit", sendChatMessage);
    const stream = document.getElementById("chatStream");
    if (stream) stream.scrollTop = stream.scrollHeight;
  }

  async function createChat() {
    try {
      const conversation = await chatApi("/conversations", { method: "POST", body: JSON.stringify({ title: "New conversation" }) });
      location.hash = `#/chat/${conversation.id}`;
    } catch (error) { toast(error.message, true); }
  }

  async function attachChatFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      if (text.length > 90_000) throw new Error("That file is too large for chat. Use New discovery for large datasets.");
      const input = document.getElementById("chatInput");
      input.value = `${input.value}${input.value ? "\n\n" : ""}--- ${file.name} ---\n${text}`.slice(0, 100_000);
      document.getElementById("chatFileName").textContent = file.name;
    } catch (error) { toast(error.message, true); }
  }

  async function sendChatMessage(event) {
    event.preventDefault();
    if (state.chat.busy) return;
    const content = document.getElementById("chatInput")?.value.trim();
    if (!content) return;
    if (!state.chat.activeId) {
      try {
        const conversation = await chatApi("/conversations", { method: "POST", body: JSON.stringify({ title: "New conversation" }) });
        state.chat.activeId = conversation.id;
        state.chat.conversations.unshift(conversation);
      } catch (error) { toast(error.message, true); return; }
    }
    state.chat.busy = true;
    const mode = document.getElementById("chatMode")?.value || "hybrid";
    state.chat.messages.push({ role: "user", content, mode, tool_receipts: [] });
    drawChat();
    try {
      const answer = await chatApi(`/conversations/${encodeURIComponent(state.chat.activeId)}/messages`, { method: "POST", body: JSON.stringify({ content, mode }) });
      state.chat.messages.push(answer);
      if (!location.hash.endsWith(state.chat.activeId)) history.replaceState(null, "", `#/chat/${state.chat.activeId}`);
    } catch (error) { toast(error.message, true); }
    finally { state.chat.busy = false; drawChat(); }
  }

  async function renderCases() {
    showLoading();
    try {
      const cases = await api("/cases");
      state.cases = normalizeCases(cases);
    } catch (error) {
      state.cases = [];
      toast(error.message, true);
    }

    app.innerHTML = `
      <div class="system-strip ${state.systemHealth?.status === "ok" ? "healthy" : "degraded"}" role="status">
        <span class="system-dot" aria-hidden="true"></span>
        <strong>${state.systemHealth?.status === "ok" ? "Orbita is ready" : "Orbita status needs attention"}</strong>
        <span>${state.systemHealth?.orbita_core_mode === "unified" ? "Guided and MCP are using the same governed core." : "Checking the unified core connection."}</span>
        ${state.systemHealth?.run_worker?.status && state.systemHealth.run_worker.status !== "ready" ? `<span class="system-warning">New discovery runs may wait in the queue because the run worker is ${escapeHtml(state.systemHealth.run_worker.status)}.</span>` : ""}
      </div>
      <section class="hero">
        <div class="hero-card">
          <p class="eyebrow">Discovery without the maze</p>
          <h1>Find what survives.</h1>
          <p>Upload a dataset, tell Orbita what you want to learn, and get a clear record of what held up — and what failed.</p>
          <div class="actions">
            <a class="button accent" href="#/new">Start a discovery</a>
            <button class="button ghost" id="refreshCases">Refresh</button>
          </div>
        </div>
        <aside class="hero-card hero-aside">
          <p class="eyebrow">How it works</p>
          <h2 style="color:white">One guided path</h2>
          <p>Orbita proposes relationships, challenges them on unseen data, removes weak predictors, and preserves the complete evidence trail.</p>
          <ul class="check-list" style="list-style:none;padding:0">
            <li><span class="check">✓</span><span>Plain-language findings</span></li>
            <li><span class="check">✓</span><span>Rejected alternatives preserved</span></li>
            <li><span class="check">✓</span><span>Technical receipts when you need them</span></li>
          </ul>
        </aside>
      </section>

      <section aria-labelledby="choosePathTitle">
        <div class="section-head">
          <div><p class="eyebrow">Choose the right path</p><h2 id="choosePathTitle">What do you want Orbita to do?</h2></div>
          <a href="#/guide">See the beginner guide</a>
        </div>
        <div class="grid three capability-grid">
          <a class="card clickable capability-card" href="#/new">
            <span class="capability-number">1</span><h3>Analyze one dataset</h3>
            <p>Upload a CSV, choose a question, review the frozen plan, and see what survives Orbita's checks.</p>
            <strong>Use Guided discovery →</strong>
          </a>
          <a class="card clickable capability-card" href="#/projects">
            <span class="capability-number">2</span><h3>Connect several studies</h3>
            <p>Combine case histories, preserve counterexamples, and generate review-needed follow-up questions.</p>
            <strong>Use Projects →</strong>
          </a>
          <a class="card clickable capability-card" href="/discovery-genome.html">
            <span class="capability-number">3</span><h3>Run a controlled comparison</h3>
            <p>Freeze operators and predictions before revealing results, with hashes and explicit approval gates.</p>
            <strong>Open the advanced lab →</strong>
          </a>
        </div>
      </section>

      <section>
        <div class="section-head">
          <div><p class="eyebrow">Workspace</p><h2>My cases</h2></div>
          <p class="muted">${DEV_MODE ? "Demo data (localhost)" : "Live Orbita API"}</p>
        </div>
        ${state.cases.length ? `<div class="case-list">${state.cases.map(caseRow).join("")}</div>` : emptyCases()}
      </section>`;

    document.getElementById("refreshCases")?.addEventListener("click", renderCases);
    document.querySelectorAll("[data-case-id]").forEach(el =>
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-delete-case]")) return;
        location.hash = `#/case/${el.dataset.caseId}`;
      })
    );
    document.querySelectorAll("[data-delete-case]").forEach(btn =>
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const caseId = btn.dataset.deleteCase;
        const name   = btn.dataset.caseName || "this case";
        if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
        btn.disabled = true;
        btn.textContent = "Deleting…";
        try {
          await api(`/cases/${encodeURIComponent(caseId)}`, { method: "DELETE" });
          toast("Case deleted.");
          renderCases();
        } catch (err) {
          alert("Delete failed: " + (err.message || "unknown error"));
          btn.disabled = false;
          btn.textContent = "Delete";
        }
      })
    );
  }

  function renderGuide() {
    app.innerHTML = `
      <section class="page-intro">
        <p class="eyebrow">Beginner guide</p>
        <h1>One Orbita, two ways to use it.</h1>
        <p>The Guided website and the MCP connection are two doors into the same governed research core. The website walks you through the choices. MCP lets an AI assistant call the same tools while preserving your cases, evidence, approvals, and receipts.</p>
      </section>
      <section class="grid two guide-grid">
        <article class="card"><p class="eyebrow">Guided website</p><h2>Best when you want a clear walkthrough</h2><p>Use it to upload a CSV, select a discovery mode, review the exact plan, run the checks, and read plain-English results.</p><div class="actions"><a class="button primary" href="#/new">Start Guided discovery</a></div></article>
        <article class="card"><p class="eyebrow">MCP access</p><h2>Best when an AI assistant is helping</h2><p>The assistant can prepare cases, compress evidence, adjudicate bounded tasks, search memory, inspect claim history, and work with the same project graphs. Orbita supplies rules and receipts; the AI supplies flexible language reasoning.</p></article>
      </section>
      <section class="section-spaced">
        <div class="section-head"><div><p class="eyebrow">Capability map</p><h2>Five jobs Orbita can do</h2></div></div>
        <div class="grid three">
          ${[
            ["Discover", "Test relationships in tabular data and preserve both supported and rejected candidates."],
            ["Adjudicate", "Apply deterministic evidence rules to a bounded task without spending model tokens."],
            ["Compress", "Select relevant evidence or code context before an AI model reads it."],
            ["Remember", "Search imported research/chat history and surface possible changes of position for human review."],
            ["Govern", "Freeze plans, predictions, operators, and result receipts so conclusions cannot quietly move after the fact."],
          ].map(([title, copy]) => `<article class="card"><h3>${title}</h3><p>${copy}</p></article>`).join("")}
        </div>
      </section>
      <section class="card boundary-card section-spaced">
        <p class="eyebrow">Important boundary</p><h2>Orbita does not understand every raw archive by itself.</h2>
        <p>It is strongest when the evidence and question are made explicit. An AI model can interpret messy language and propose a question; Orbita can then constrain, test, audit, and remember the work. A refusal or an inconclusive result is a valid outcome—not a system failure.</p>
      </section>`;
  }

  function normalizeCases(payload) {
    const list = Array.isArray(payload) ? payload : payload.cases || payload.items || [];
    return list.map(item => ({
      id:      item.case_id || item.id,
      name:    item.name    || item.title || "Untitled discovery",
      status:  item.status  || "created",
      updated: item.updated_at || item.created_at || new Date().toISOString(),
      goal:    item.goal    || item.description || "",
    }));
  }

  function caseRow(c) {
    return `<article class="case-row" data-case-id="${escapeHtml(c.id)}" role="button" tabindex="0">
      <div><h3>${escapeHtml(c.name)}</h3><p>${escapeHtml(c.goal || "Open this case to review findings and evidence.")}</p></div>
      <div><small>Case ID</small><p>${escapeHtml(shortId(c.id))}</p></div>
      <div><span class="status ${escapeHtml(c.status)}">${escapeHtml(c.status.replaceAll("_", " "))}</span></div>
      <div style="display:flex;gap:6px">
        <button class="button ghost small">Open</button>
        <button class="button ghost small" data-delete-case="${escapeHtml(c.id)}" data-case-name="${escapeHtml(c.name)}" style="color:#b91c1c">Delete</button>
      </div>
    </article>`;
  }

  function emptyCases() {
    return `<div class="empty-state card"><div><h3>No cases yet</h3><p>Start with a simple CSV and one numeric target.</p><div class="actions" style="justify-content:center"><a class="button primary" href="#/new">Start a discovery</a></div></div></div>`;
  }

  // ── Account page ──────────────────────────────────────────────────────────────
  async function loadGraphs() {
    const list = await graphApi("");
    state.graphs = Array.isArray(list) ? list : [];
    if (!state.selectedGraphId && state.graphs[0]) state.selectedGraphId = state.graphs[0].id;
    return state.graphs;
  }

  async function renderProjects() {
    showLoading();
    try {
      await Promise.all([
        loadGraphs(),
        (async () => { if (!state.cases.length) state.cases = normalizeCases(await api("/cases")); })(),
      ]);
    } catch (err) {
      toast(err.message, true);
    }

    const selectedId = state.selectedGraphId || state.graphs[0]?.id || "";
    let detail = null, operators = [], traceEvents = [], questions = [], programme = null;
    if (selectedId) {
      try {
        const [graphDetail, op, trace, stateResp, qs] = await Promise.all([
          graphApi(`/${encodeURIComponent(selectedId)}`),
          graphApi(`/${encodeURIComponent(selectedId)}/operators`),
          graphApi(`/${encodeURIComponent(selectedId)}/trace`),
          graphApi(`/${encodeURIComponent(selectedId)}/programme-state`),
          graphApi(`/${encodeURIComponent(selectedId)}/questions`),
        ]);
        detail = graphDetail;
        operators = op.operators || [];
        traceEvents = trace.events || [];
        programme = stateResp.snapshot || null;
        questions = qs.questions || [];
      } catch (err) {
        toast(err.message, true);
      }
    }

    app.innerHTML = `
      <section class="hero-card">
        <p class="eyebrow">Project memory graphs</p>
        <h1 style="font-size:38px;margin:8px 0 10px">Cross-domain discovery workspace</h1>
        <p>Cross-case pattern proposals are review cards Orbita derives from evidence in this memory graph. They are not executable Discovery Genome operators and are not committed discoveries.</p>
      </section>

      <div class="grid two" style="margin-top:16px;align-items:start">
        <section class="card">
          <div class="section-head" style="margin-bottom:12px">
            <div><p class="eyebrow">Projects</p><h2>Memory graphs</h2></div>
          </div>
          <form id="createGraphForm" class="form-stack" style="margin-bottom:16px">
            <label>Project name<input id="graphName" placeholder="Cross-domain Reset Bottleneck Study" /></label>
            <label>Description<textarea id="graphDescription" rows="2" placeholder="Optional project scope"></textarea></label>
            <button class="button primary" type="submit">Create project graph</button>
          </form>
          ${state.graphs.length ? `<div class="case-list">${state.graphs.map(g => graphRow(g, selectedId)).join("")}</div>` : `<p class="muted">No project graphs yet.</p>`}
        </section>

        <section class="card">
          ${detail ? projectDetail(detail, operators, traceEvents, programme, questions) : `<p class="muted">Create or select a project graph.</p>`}
        </section>
      </div>`;

    document.getElementById("createGraphForm")?.addEventListener("submit", async e => {
      e.preventDefault();
      const name = document.getElementById("graphName").value.trim();
      const description = document.getElementById("graphDescription").value.trim();
      if (!name) return toast("Project name is required.", true);
      try {
        const graph = await graphApi("", { method: "POST", body: JSON.stringify({ name, description, kind: "project" }) });
        state.selectedGraphId = graph.id;
        toast("Project graph created.");
        renderProjects();
      } catch (err) { toast(err.message, true); }
    });
    document.querySelectorAll("[data-select-graph]").forEach(btn => btn.addEventListener("click", () => {
      state.selectedGraphId = btn.dataset.selectGraph;
      renderProjects();
    }));
    document.getElementById("createCaseInGraph")?.addEventListener("click", () => {
      state.wizard = freshWizard();
      state.wizard.graphId = selectedId;
      location.hash = "#/new";
      renderWizard();
    });
    document.getElementById("attachCaseForm")?.addEventListener("submit", async e => {
      e.preventDefault();
      const caseId = document.getElementById("attachCaseId").value;
      if (!caseId) return;
      try {
        await graphApi(`/${encodeURIComponent(selectedId)}/cases/${encodeURIComponent(caseId)}`, {
          method: "POST",
          body: JSON.stringify({ mode: "contributes" }),
        });
        toast("Case attached to project graph.");
        renderProjects();
      } catch (err) { toast(err.message, true); }
    });
    document.getElementById("findOperators")?.addEventListener("click", async () => {
      const btn = document.getElementById("findOperators");
      btn.disabled = true; btn.textContent = "Finding candidates...";
      try {
        const result = await graphApi(`/${encodeURIComponent(selectedId)}/operators/propose`, { method: "POST", body: "{}" });
        toast(result.operators?.length ? "Cross-case pattern proposals refreshed." : "No cross-case pattern proposals yet.");
        renderProjects();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false; btn.textContent = "Find cross-case patterns";
      }
    });
    document.getElementById("traceNoteForm")?.addEventListener("submit", async e => {
      e.preventDefault();
      const form = e.currentTarget;
      const title = form.querySelector("[name=title]").value.trim();
      if (!title) return toast("Trace note title is required.", true);
      try {
        await graphApi(`/${encodeURIComponent(selectedId)}/trace`, {
          method: "POST",
          body: JSON.stringify({
            title,
            event_type: form.querySelector("[name=event_type]").value,
            description: form.querySelector("[name=description]").value.trim(),
            admissibility_effect: form.querySelector("[name=admissibility_effect]").value,
          }),
        });
        toast("Trace note added.");
        renderProjects();
      } catch (err) { toast(err.message, true); }
    });
    document.getElementById("generateQuestions")?.addEventListener("click", async () => {
      const btn = document.getElementById("generateQuestions");
      btn.disabled = true; btn.textContent = "Generating...";
      try {
        const result = await graphApi(`/${encodeURIComponent(selectedId)}/questions/generate`, { method: "POST", body: "{}" });
        toast(result.questions?.length ? "Next-question candidates refreshed." : "No admissible question candidates yet.");
        renderProjects();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false; btn.textContent = "Generate question candidates";
      }
    });
    document.querySelectorAll("[data-question-materialize]").forEach(button => {
      button.addEventListener("click", async () => {
        const questionId = button.dataset.questionMaterialize;
        button.disabled = true; button.textContent = "Opening case...";
        try {
          const result = await graphApi(`/${encodeURIComponent(selectedId)}/questions/${encodeURIComponent(questionId)}/materialize`, {
            method: "POST",
            body: "{}",
          });
          toast(result.already_materialized ? "This question already has an Orbita case." : "Orbita case created from the accepted question.");
          renderProjects();
        } catch (err) {
          toast(err.message, true);
          button.disabled = false; button.textContent = "Open as Orbita case";
        }
      });
    });
    document.querySelectorAll("[data-question-review-form]").forEach(form => {
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const questionId = form.dataset.questionReviewForm;
        const submit = form.querySelector("button[type=submit]");
        submit.disabled = true;
        try {
          await graphApi(`/${encodeURIComponent(selectedId)}/questions/${encodeURIComponent(questionId)}/review`, {
            method: "PATCH",
            body: JSON.stringify({
              review_status: form.querySelector("[name=review_status]").value,
              review_notes: form.querySelector("[name=review_notes]").value.trim(),
            }),
          });
          toast("Question review saved.");
          renderProjects();
        } catch (err) {
          toast(err.message, true);
          submit.disabled = false;
        }
      });
    });
    document.getElementById("compileProgrammeState")?.addEventListener("click", async () => {
      const btn = document.getElementById("compileProgrammeState");
      btn.disabled = true; btn.textContent = "Compiling...";
      try {
        await graphApi(`/${encodeURIComponent(selectedId)}/programme-state/compile`, { method: "POST", body: "{}" });
        toast("Programme state compiled.");
        renderProjects();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false; btn.textContent = "Compile programme state";
      }
    });
    document.querySelectorAll("[data-operator-review-form]").forEach(form => {
      form.addEventListener("submit", async e => {
        e.preventDefault();
        const operatorId = form.dataset.operatorReviewForm;
        const checklist = {};
        form.querySelectorAll("[data-review-check]").forEach(input => { checklist[input.value] = input.checked; });
        try {
          await graphApi(`/${encodeURIComponent(selectedId)}/operators/${encodeURIComponent(operatorId)}/review`, {
            method: "PATCH",
            body: JSON.stringify({
              review_status: form.querySelector("[name=review_status]").value,
              review_notes: form.querySelector("[name=review_notes]").value.trim(),
              checklist,
            }),
          });
          toast("Operator review saved.");
          renderProjects();
        } catch (err) { toast(err.message, true); }
      });
    });
  }

  function graphRow(g, selectedId) {
    return `<article class="case-row ${g.id === selectedId ? "active" : ""}" style="grid-template-columns:1fr auto" data-select-graph="${escapeHtml(g.id)}" role="button" tabindex="0">
      <div><h3>${escapeHtml(g.name)}</h3><p>${escapeHtml(g.description || `${g.kind || "project"} memory graph`)}</p></div>
      <button class="button ghost small" type="button">Open</button>
    </article>`;
  }

  function projectDetail(graph, operators, traceEvents = [], programme = null, questions = []) {
    const linkedCases = graph.cases || [];
    const caseOptions = state.cases
      .filter(c => !linkedCases.some(link => link.case_id === c.id))
      .map(c => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.name)} (${escapeHtml(shortId(c.id))})</option>`)
      .join("");
    return `
      <p class="eyebrow">Selected project</p>
      <h2 style="font-size:24px;margin:6px 0 8px">${escapeHtml(graph.name)}</h2>
      <p class="muted">This case writes discoveries/counterexamples to this memory graph when created inside the project or attached as a contributor.</p>
      <div class="grid three" style="margin:14px 0">
        <div class="metric"><strong>${linkedCases.length}</strong><span>Linked cases</span></div>
        <div class="metric"><strong>${operators.length}</strong><span>Pattern proposals</span></div>
        <div class="metric"><strong>${escapeHtml(graph.kind || "project")}</strong><span>Graph kind</span></div>
      </div>
      <div class="actions" style="margin-bottom:14px">
        <button class="button primary" id="createCaseInGraph">New case in this project</button>
        <button class="button accent" id="findOperators">Find cross-case patterns</button>
      </div>
      <form id="attachCaseForm" class="form-stack" style="margin-bottom:18px">
        <label>Attach an existing owned case
          <select id="attachCaseId">${caseOptions || `<option value="">No unattached cases available</option>`}</select>
        </label>
        <button class="button ghost" type="submit" ${caseOptions ? "" : "disabled"}>Attach case</button>
      </form>
      <section style="margin-top:16px">
        <p class="eyebrow">Linked cases</p>
        ${linkedCases.length ? linkedCases.map(link => `<p style="font-size:13px;margin:8px 0"><strong>${escapeHtml(shortId(link.case_id))}</strong> · ${escapeHtml(link.mode)} · <a href="#/case/${encodeURIComponent(link.case_id)}">open case</a></p>`).join("") : `<p class="muted">No cases linked yet.</p>`}
      </section>
      <section style="margin-top:18px">
        <p class="eyebrow">Cross-case pattern proposals</p>
        <p class="muted" style="font-size:12px;margin:4px 0 10px">Review-only hypotheses from this project graph. The separate Discovery Genome contains frozen executable falsification operators.</p>
        ${operators.length ? operators.map(operatorCard).join("") : `<p class="muted">No proposals yet. Add evidence from at least two cases, then run the proposal pass.</p>`}
      </section>
      ${programmeStatePanel(programme)}
      ${researchTracePanel(traceEvents)}
      ${questionsPanel(questions)}`;
  }

  function programmeStatePanel(snapshot) {
    const list = (items = [], empty = "None recorded") => items.length
      ? items.slice(0, 5).map(item => `<li>${escapeHtml(item.name || item.title || item.class || item.id || item.type || "object")}${item.reason ? ` - ${escapeHtml(item.reason)}` : ""}</li>`).join("")
      : `<li class="muted">${escapeHtml(empty)}</li>`;
    return `
      <section style="margin-top:18px">
        <div class="section-head" style="margin-bottom:8px">
          <div><p class="eyebrow">Programme State</p></div>
          <button class="button ghost small" id="compileProgrammeState" type="button">Compile programme state</button>
        </div>
        <p class="muted" style="font-size:12px;margin:4px 0 10px">Compiled from trace events, reviews, operators, modules, and counterexamples. It is a review-needed state summary, not an autonomous plan.</p>
        ${snapshot ? `
          <div class="grid three" style="margin-top:10px">
            <div><small>Trace events</small><p>${escapeHtml(String(snapshot.source_trace_event_count || 0))}</p></div>
            <div><small>Allowed question classes</small><p>${escapeHtml((snapshot.allowed_question_classes || []).join(", ") || "-")}</p></div>
            <div><small>Snapshot</small><p>${escapeHtml(shortId(snapshot.id || ""))}</p></div>
          </div>
          <div class="grid two" style="margin-top:10px;align-items:start">
            <div><h3 style="font-size:14px;margin:0 0 6px">Carry-forward objects</h3><ul style="margin:0;padding-left:18px;font-size:13px">${list(snapshot.carry_forward_objects)}</ul></div>
            <div><h3 style="font-size:14px;margin:0 0 6px">Unresolved blockers</h3><ul style="margin:0;padding-left:18px;font-size:13px">${list([...(snapshot.unresolved_traceability_gaps || []), ...(snapshot.unresolved_artifact_warnings || [])])}</ul></div>
            <div><h3 style="font-size:14px;margin:0 0 6px">Needs replication</h3><ul style="margin:0;padding-left:18px;font-size:13px">${list(snapshot.needs_replication)}</ul></div>
            <div><h3 style="font-size:14px;margin:0 0 6px">Blocked claim classes</h3><ul style="margin:0;padding-left:18px;font-size:13px">${list(snapshot.blocked_claim_classes)}</ul></div>
            <div><h3 style="font-size:14px;margin:0 0 6px">Active stopping rules</h3><ul style="margin:0;padding-left:18px;font-size:13px">${list(snapshot.active_stopping_rules)}</ul></div>
            <div><h3 style="font-size:14px;margin:0 0 6px">Needs independent dataset</h3><ul style="margin:0;padding-left:18px;font-size:13px">${list(snapshot.needs_independent_dataset)}</ul></div>
          </div>
        ` : `<p class="muted">No compiled programme state yet.</p>`}
      </section>`;
  }

  function researchTracePanel(events = []) {
    const rows = events.slice(0, 10).map(event => `
      <div style="border-top:1px solid var(--line);padding:10px 0">
        <div style="display:flex;gap:8px;align-items:baseline;justify-content:space-between">
          <strong style="font-size:13px">${escapeHtml(event.title || event.event_type)}</strong>
          <span class="status ${escapeHtml(event.admissibility_effect || "none")}">${escapeHtml(String(event.admissibility_effect || "none").replaceAll("_", " "))}</span>
        </div>
        <p class="muted" style="font-size:12px;margin:4px 0 0">${escapeHtml(String(event.event_type || "").replaceAll("_", " "))}${event.source_ref_id ? ` · ${escapeHtml(shortId(event.source_ref_id))}` : ""}</p>
        ${event.description ? `<p style="font-size:13px;margin:6px 0 0">${escapeHtml(event.description)}</p>` : ""}
      </div>`).join("");
    return `
      <section style="margin-top:18px">
        <p class="eyebrow">Research Trace</p>
        <p class="muted" style="font-size:12px;margin:4px 0 10px">Trace events record questions, methods, reviews, stopping points, and carry-forward decisions. They do not change claim verdicts.</p>
        ${rows || `<p class="muted">No trace events recorded yet.</p>`}
        <details class="details" style="margin-top:10px">
          <summary>Add trace note</summary>
          <form id="traceNoteForm" class="form-stack" style="padding-top:10px">
            <label>Title<input name="title" maxlength="240" placeholder="Why this direction is blocked or worth carrying forward" /></label>
            <label>Event type
              <select name="event_type">
                <option value="method_chosen">method chosen</option>
                <option value="traceability_repaired">traceability repaired</option>
                <option value="traceability_gap_found">traceability gap found</option>
                <option value="stopping_rule_invoked">stopping rule invoked</option>
                <option value="carry_forward_object_selected">carry-forward object selected</option>
                <option value="richer_object_rejected">richer object rejected</option>
                <option value="next_question_candidate">next question candidate</option>
                <option value="evidence_note">evidence note</option>
                <option value="blocked_direction">blocked direction</option>
              </select>
            </label>
            <label>Admissibility effect
              <select name="admissibility_effect">
                <option value="none">none</option>
                <option value="permits_question">permits question</option>
                <option value="blocks_question">blocks question</option>
                <option value="narrows_question">narrows question</option>
                <option value="requires_more_evidence">requires more evidence</option>
                <option value="requires_traceability_repair">requires traceability repair</option>
                <option value="records_stopping_point">records stopping point</option>
              </select>
            </label>
            <label>Description<textarea name="description" rows="3" maxlength="2000"></textarea></label>
            <button class="button ghost" type="submit">Add trace note</button>
          </form>
        </details>
      </section>`;
  }

  function questionsPanel(questions = []) {
    const groups = [
      ["Admissible", questions.filter(q => q.status === "admissible")],
      ["Needs More Evidence", questions.filter(q => q.status === "needs_more_evidence")],
      ["Needs Traceability Repair", questions.filter(q => q.status === "needs_traceability_repair")],
      ["Blocked", questions.filter(q => q.status === "blocked")],
      ["Possible / Interesting", questions.filter(q => !["admissible", "needs_more_evidence", "needs_traceability_repair", "blocked"].includes(q.status))],
    ].filter(([, rows]) => rows.length);
    const cards = groups.map(([label, rows]) => `
      <div style="margin-top:12px">
        <h3 style="font-size:14px;margin:0 0 6px">${escapeHtml(label)}</h3>
        ${rows.map(questionCard).join("")}
      </div>`).join("");
    return `
      <section style="margin-top:18px">
        <div class="section-head" style="margin-bottom:8px">
          <div><p class="eyebrow">Admissible Next Questions</p></div>
          <button class="button accent small" id="generateQuestions" type="button">Generate question candidates</button>
        </div>
        <p class="muted" style="font-size:12px;margin:4px 0 10px">Admissible means justified as a next question by the current trace. It does not mean the answer is known.</p>
        ${cards || `<p class="muted">No question candidates yet.</p>`}
      </section>`;
  }

  function questionCard(q) {
    const refs = [
      ...(q.trace_event_refs || []).map(id => `trace:${shortId(id)}`),
      ...(q.related_operator_refs || []).map(id => `op:${shortId(id)}`),
      ...(q.related_module_refs || []).map(id => `module:${shortId(id)}`),
      ...(q.counterexample_refs || []).slice(0, 3).map(id => `cx:${shortId(id)}`),
    ];
    return `<article style="border:1px solid var(--line);border-radius:8px;padding:12px;margin-top:10px">
      <div style="display:flex;gap:10px;justify-content:space-between;align-items:start">
        <h3 style="font-size:15px;margin:0">${escapeHtml(q.question_text)}</h3>
        <span class="status ${escapeHtml(q.status || "possible")}">${escapeHtml(String(q.status || "possible").replaceAll("_", " "))}</span>
      </div>
      <p class="muted" style="font-size:11px;margin:6px 0 0">Class: ${escapeHtml(String(q.question_class || "generalization").replaceAll("_", " "))} · Review needed: ${q.review_needed === false ? "no" : "yes"}</p>
      ${q.why_allowed ? `<p style="font-size:13px;margin:8px 0 0"><strong>Why allowed:</strong> ${escapeHtml(q.why_allowed)}</p>` : ""}
      ${q.why_blocked ? `<p style="font-size:13px;margin:8px 0 0"><strong>Why blocked:</strong> ${escapeHtml(q.why_blocked)}</p>` : ""}
      ${q.what_would_make_it_admissible ? `<p style="font-size:13px;margin:8px 0 0"><strong>What would make it admissible:</strong> ${escapeHtml(q.what_would_make_it_admissible)}</p>` : ""}
      ${q.suggested_next_action ? `<p class="muted" style="font-size:12px;margin:8px 0 0"><strong>Next action:</strong> ${escapeHtml(q.suggested_next_action)}</p>` : ""}
      ${refs.length ? `<p class="muted" style="font-size:11px;margin:8px 0 0">Refs: ${escapeHtml(refs.slice(0, 8).join(", "))}${refs.length > 8 ? `, +${refs.length - 8}` : ""}</p>` : ""}
      <p class="muted" style="font-size:11px;margin:8px 0 0">Review status: ${escapeHtml(String(q.review_status || "proposed").replaceAll("_", " "))}</p>
      <form data-question-review-form="${escapeHtml(q.question_id)}" style="display:grid;gap:6px;margin-top:8px">
        <label style="font-size:12px">Human review
          <select name="review_status">
            ${["proposed", "under_review", "accepted_candidate", "needs_more_evidence", "rejected", "deprecated"].map(status =>
              `<option value="${status}" ${q.review_status === status ? "selected" : ""}>${escapeHtml(status.replaceAll("_", " "))}</option>`
            ).join("")}
          </select>
        </label>
        <label style="font-size:12px">Notes
          <input name="review_notes" maxlength="1000" value="${escapeHtml(q.review_notes || "")}" placeholder="Why this question should or should not advance">
        </label>
        <button class="button ghost small" type="submit">Save question review</button>
      </form>
      ${q.status === "admissible" && q.review_status === "accepted_candidate"
        ? `<button class="button ghost small" type="button" data-question-materialize="${escapeHtml(q.question_id)}">Open as Orbita case</button>`
        : ""}
    </article>`;
  }

  function operatorCard(op) {
    const cases = op.supporting_case_ids || op.evidence?.supporting_case_ids || [];
    const caseLabels = op.case_labels?.length
      ? op.case_labels
      : cases.map(id => ({ case_id: id, label: shortId(id) }));
    const evidenceCount = op.evidence_count ?? op.evidence?.evidence_count ?? 0;
    const counterexampleCount = op.counterexample_count ?? op.counterexamples?.counterexample_count ?? 0;
    const ratio = op.evidence_ratio ?? op.evidence?.evidence_ratio;
    const cautions = op.caution_labels || op.evidence?.caution_labels || [];
    const confidence = op.name === "Artifact Mimicry"
      ? (op.confidence && op.confidence.includes("artifact") ? op.confidence : "artifact-risk candidate")
      : (op.confidence || op.evidence?.confidence || "candidate");
    const why = op.why_proposed || op.evidence?.why_proposed || op.description || "";
    const ratioText = ratio == null ? "-" : `${Math.round(Number(ratio) * 100)}%`;
    const breakdown = op.case_breakdown || op.evidence?.case_breakdown || [];
    const flags = op.suspicion_flags || op.evidence?.suspicion_flags || [];
    const scoreComponents = op.score_components || op.evidence?.score_components || {};
    const scoreExplanation = op.score_explanation || op.evidence?.score_explanation || "";
    const reviewStatus = op.review_status || op.review?.review_status || "proposed";
    const reviewNotes = op.review_notes || op.review?.review_notes || "";
    const reviewChecklist = op.review_checklist || op.review?.checklist || {};
    const idList = ids => (ids || []).slice(0, 6).map(shortId).map(escapeHtml).join(", ") + ((ids || []).length > 6 ? `, +${(ids || []).length - 6}` : "");
    const componentRows = Object.entries(scoreComponents).map(([key, value]) =>
      `<div><small>${escapeHtml(key.replaceAll("_", " "))}</small><p>${formatScore(value)}</p></div>`
    ).join("");
    const breakdownRows = breakdown.length ? breakdown.map(row => `
      <tr>
        <td>${escapeHtml(row.label || shortId(row.case_id))}</td>
        <td>${escapeHtml(String(row.evidence_count || 0))}</td>
        <td>${escapeHtml(String(row.counterexample_count || 0))}</td>
        <td>${escapeHtml((row.signal_tags || []).join(", ") || "-")}</td>
      </tr>
      <tr>
        <td colspan="4" style="color:var(--muted);font-size:12px;padding-bottom:10px">
          Claim IDs: ${idList(row.claim_ids) || "-"}<br/>
          Counterexample IDs: ${idList(row.counterexample_ids) || "-"}
        </td>
      </tr>
    `).join("") : "";
    return `<article class="card" style="margin-top:10px;border-color:#f59e0b">
      <div style="display:flex;gap:10px;justify-content:space-between;align-items:start">
        <div><h3 style="margin:0 0 4px">${escapeHtml(op.name)}</h3><p class="muted" style="margin:0">${escapeHtml(op.description || "")}</p></div>
        <span class="status ${escapeHtml(op.status || "proposed")}">${escapeHtml((op.status || "proposed").replaceAll("_", " "))}</span>
      </div>
      <p style="font-size:12px;color:#92400e;margin:10px 0 0"><strong>Candidate operator - review required.</strong> This is not a committed discovery.</p>
      <p style="font-size:13px;margin:8px 0 0"><strong>${escapeHtml(confidence)}</strong></p>
      <div class="grid three" style="margin-top:10px">
        <div><small>Evidence</small><p>${evidenceCount}</p></div>
        <div><small>Counterexamples</small><p>${counterexampleCount}</p></div>
        <div><small>Score</small><p>${formatScore(op.score)}</p></div>
      </div>
      <div class="grid three" style="margin-top:8px">
        <div><small>Evidence ratio</small><p>${escapeHtml(ratioText)}</p></div>
      </div>
      <p style="font-size:13px;margin:10px 0 0"><strong>Why proposed:</strong> ${escapeHtml(why)}</p>
      ${cautions.length ? `<div style="margin-top:8px">${cautions.map(c => `<p style="font-size:12px;color:#92400e;margin:4px 0"><strong>Caution:</strong> ${escapeHtml(c)}</p>`).join("")}</div>` : ""}
      ${flags.length ? `<p style="font-size:12px;color:#92400e;margin:8px 0 0"><strong>Flags:</strong> ${flags.map(escapeHtml).join(", ")}</p>` : ""}
      <p class="muted" style="font-size:12px">Supporting cases: ${caseLabels.map(item => escapeHtml(item.label || shortId(item.case_id))).join("; ") || "-"}</p>
      <details class="details" style="margin-top:10px">
        <summary>Evidence drilldown</summary>
        <div style="padding-top:10px">
          <p class="muted" style="font-size:12px;margin-top:0">Signal tags: ${escapeHtml((op.pattern?.signals || op.provenance?.signals || []).join(", ") || "-")}</p>
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr><th align="left">Case</th><th align="left">Evidence</th><th align="left">Counterexamples</th><th align="left">Main signal tags</th></tr></thead>
            <tbody>${breakdownRows || `<tr><td colspan="4" class="muted">No per-case drilldown stored for this proposal yet.</td></tr>`}</tbody>
          </table>
          <p style="font-size:13px;margin:12px 0 6px"><strong>Score explanation:</strong> ${escapeHtml(scoreExplanation || "Score combines case diversity, evidence volume, evidence ratio, and counterexample penalties.")}</p>
          ${componentRows ? `<div class="grid three" style="margin-top:8px">${componentRows}</div>` : ""}
        </div>
      </details>
      <details class="details" style="margin-top:10px">
        <summary>Review workflow</summary>
        <form data-operator-review-form="${escapeAttr(op.operator_id)}" class="form-stack" style="padding-top:10px">
          <label>Review status
            <select name="review_status">
              ${reviewStatusOptions(reviewStatus)}
            </select>
          </label>
          <p class="muted" style="font-size:12px;margin:0">Accepted candidate does not mean proven. It means this operator is worth future testing.</p>
          <label>Review notes<textarea name="review_notes" rows="3" maxlength="2000">${escapeHtml(reviewNotes)}</textarea></label>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:6px;font-size:12px">
            ${reviewChecklistControls(reviewChecklist)}
          </div>
          <button class="button ghost" type="submit">Save review</button>
        </form>
      </details>
    </article>`;
  }

  function reviewStatusOptions(current) {
    return ["proposed", "under_review", "accepted_candidate", "rejected", "needs_more_evidence", "deprecated"]
      .map(value => `<option value="${escapeAttr(value)}" ${current === value ? "selected" : ""}>${escapeHtml(value.replaceAll("_", " "))}</option>`)
      .join("");
  }

  function reviewChecklistControls(checklist = {}) {
    const labels = {
      appears_in_2_plus_cases: "appears in 2+ cases",
      has_supporting_claims: "has supporting claims",
      has_counterexamples_considered: "counterexamples considered",
      no_unresolved_artifact_only_explanation: "no artifact-only explanation",
      has_domain_case_diversity: "domain/case diversity",
      has_repeatable_pattern_shape: "repeatable pattern shape",
      needs_independent_dataset: "needs independent dataset",
      needs_holdout_validation: "needs holdout validation",
      needs_traceability_repair: "needs traceability repair",
      needs_human_domain_review: "needs human/domain review",
      blocked_from_stronger_claim: "blocked from stronger claim",
      allowed_only_as_candidate: "allowed only as candidate",
    };
    return Object.entries(labels).map(([key, label]) =>
      `<label style="display:flex;gap:6px;align-items:center;margin:0">
        <input type="checkbox" data-review-check value="${escapeAttr(key)}" ${checklist[key] ? "checked" : ""} />
        <span>${escapeHtml(label)}</span>
      </label>`
    ).join("");
  }

  async function renderAccount() {
    showLoading();
    const me = await getMe();
    if (!me) return;

    app.innerHTML = `
      <section class="hero-card" style="max-width:640px;margin:0 auto">
        <p class="eyebrow">Your account</p>
        <h1 style="font-size:36px;margin:8px 0 24px">@${escapeHtml(me.username)}</h1>

        <div class="grid two" style="margin-bottom:24px">
          <div class="card">
            <p class="eyebrow">Email</p>
            <p style="margin-top:6px;word-break:break-all">${escapeHtml(me.email)}</p>
            ${me.email_verified
              ? `<p style="font-size:12px;color:#166534;margin-top:4px">✓ Verified</p>`
              : `<p style="font-size:12px;color:#92400e;margin-top:4px">Not verified — <a href="/verify-email" style="color:#92400e;font-weight:700">Verify now</a></p>`}
          </div>
          <div class="card"><p class="eyebrow">Username</p><p style="margin-top:6px">${escapeHtml(me.username)}</p></div>
        </div>

        <details class="details" id="changePasswordDetails">
          <summary>Change password</summary>
          <div>
            <div id="pwdError"   class="pw-error"   style="display:none"></div>
            <div id="pwdSuccess" class="pw-success"  style="display:none">Password updated successfully.</div>
            <div class="form-stack" style="margin-top:0">
              <label>Current password<input type="password" id="currentPwd" autocomplete="current-password" /></label>
              <label>New password <span class="muted" style="font-weight:400;font-size:12px">(min 12 characters)</span>
                <input type="password" id="newPwd" autocomplete="new-password" /></label>
              <label>Confirm new password<input type="password" id="confirmPwd" autocomplete="new-password" /></label>
            </div>
            <div class="actions" style="margin-top:16px">
              <button class="button primary" id="savePwd">Update password</button>
            </div>
          </div>
        </details>

        <div class="actions" style="margin-top:28px;flex-wrap:wrap">
          <form method="POST" action="/auth/logout" id="acctLogoutForm" style="display:inline">
            <input type="hidden" name="_csrf" id="acctLogoutCsrf" />
            <button type="submit" class="button ghost">Sign out</button>
          </form>
          <button type="button" class="button ghost" id="deleteAccountBtn" style="color:#b91c1c;border-color:#fca5a5">
            Delete my account
          </button>
        </div>

        <div id="deleteAccountSection" style="display:none;margin-top:20px;padding:16px;background:#fef2f2;border-radius:10px;border:1.5px solid #fca5a5">
          <p style="font-size:13px;color:#b91c1c;margin-bottom:12px"><strong>This is permanent.</strong> All your cases and data will be deleted and cannot be recovered.</p>
          <div id="deleteError" class="error-msg" style="display:none;margin-bottom:12px"></div>
          <label style="display:block;font-size:13px;font-weight:600;color:#444;margin-bottom:5px">Confirm by entering your password</label>
          <input type="password" id="deletePassword" style="width:100%;padding:10px;font-size:14px;border:1.5px solid #fca5a5;border-radius:8px;margin-bottom:10px" placeholder="Your current password" />
          <div style="display:flex;gap:10px">
            <button type="button" class="button primary" id="confirmDeleteBtn" style="background:#b91c1c;flex:1">Delete my account</button>
            <button type="button" class="button ghost" id="cancelDeleteBtn">Cancel</button>
          </div>
        </div>
      </section>`;

    // Wire CSRF for the logout form on the account page
    if (me.csrf_token) document.getElementById("acctLogoutCsrf").value = me.csrf_token;

    document.getElementById("deleteAccountBtn")?.addEventListener("click", () => {
      document.getElementById("deleteAccountSection").style.display = "block";
      document.getElementById("deleteAccountBtn").style.display = "none";
    });
    document.getElementById("cancelDeleteBtn")?.addEventListener("click", () => {
      document.getElementById("deleteAccountSection").style.display = "none";
      document.getElementById("deleteAccountBtn").style.display = "";
      document.getElementById("deletePassword").value = "";
    });
    document.getElementById("confirmDeleteBtn")?.addEventListener("click", async () => {
      const password = document.getElementById("deletePassword").value;
      const errEl    = document.getElementById("deleteError");
      errEl.style.display = "none";
      if (!password) { errEl.textContent = "Please enter your password."; errEl.style.display = "block"; return; }
      const btn = document.getElementById("confirmDeleteBtn");
      btn.disabled = true; btn.textContent = "Deleting…";
      try {
        const csrf = me.csrf_token || "";
        const r = await fetch("/api/user/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
          body: JSON.stringify({ password }),
        });
        if (r.status === 401) { window.location.href = "/login"; return; }
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Deletion failed.");
        window.location.href = "/login?reason=deleted";
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = "block";
        btn.disabled = false; btn.textContent = "Delete my account";
      }
    });

    document.getElementById("savePwd")?.addEventListener("click", async () => {
      const current = document.getElementById("currentPwd").value;
      const next    = document.getElementById("newPwd").value;
      const confirm = document.getElementById("confirmPwd").value;
      const errEl   = document.getElementById("pwdError");
      const okEl    = document.getElementById("pwdSuccess");
      errEl.style.display = "none";
      okEl.style.display  = "none";

      if (!current || !next) { errEl.textContent = "All fields are required."; errEl.style.display = "block"; return; }
      if (next.length < 12)  { errEl.textContent = "New password must be at least 12 characters."; errEl.style.display = "block"; return; }
      if (next !== confirm)  { errEl.textContent = "Passwords do not match."; errEl.style.display = "block"; return; }

      const btn = document.getElementById("savePwd");
      btn.disabled = true; btn.textContent = "Updating…";
      try {
        const r = await fetch("/auth/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current_password: current, new_password: next }),
        });
        if (r.status === 401) { window.location.href = "/login"; return; }
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Failed.");
        okEl.style.display = "block";
        document.getElementById("currentPwd").value = "";
        document.getElementById("newPwd").value     = "";
        document.getElementById("confirmPwd").value = "";
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = "block";
      } finally {
        btn.disabled = false; btn.textContent = "Update password";
      }
    });
  }

  // ── Wizard ────────────────────────────────────────────────────────────────────
  function renderWizard() {
    if (!DEV_MODE && !state.graphs.length) loadGraphs().then(() => {
      if ((location.hash || "#/cases") === "#/new") renderWizard();
    }).catch(() => {});
    const w = state.wizard;
    app.innerHTML = `
      <section class="wizard-shell">
        <aside class="stepper" aria-label="Discovery steps">
          ${["Upload data", "Set the goal", "Review plan", "Run discovery", "Understand results"].map((label, i) => {
            const n = i + 1;
            return `<div class="step ${w.step === n ? "active" : ""} ${w.step > n ? "done" : ""}">
              <span class="step-index">${w.step > n ? "✓" : n}</span><span>${label}</span>
            </div>`;
          }).join("")}
        </aside>
        <section class="wizard-panel" id="wizardPanel"></section>
      </section>`;
    renderWizardStep();
  }

  function renderWizardStep() {
    const panel = document.getElementById("wizardPanel");
    if (!panel) return;
    const renderers = { 1: uploadStep, 2: goalStepV2, 3: planStep, 4: runStep, 5: resultsStep };
    panel.innerHTML = renderers[state.wizard.step]();
    bindWizardStep();
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function uploadStep() {
    const w = state.wizard;
    return `
      <p class="eyebrow">Step 1 of 5</p>
      <h1>Upload your dataset</h1>
      <p>Start with one CSV. Orbita will inspect the structure before anything is run. CSV only · max 100 MB.</p>
      <label class="dropzone" id="dropzone">
        <input id="fileInput" type="file" accept=".csv,text/csv" />
        <span class="dropzone-icon">↥</span>
        <strong>${w.file ? escapeHtml(w.file.name) : "Drop a CSV here or click to browse"}</strong>
        <span>${w.file ? formatBytes(w.file.size) : "CSV only · max 100 MB"}</span>
      </label>
      ${w.parsed ? dataPreview(w.parsed) : ""}
      <div class="actions">
        <a class="button ghost" href="#/cases">Cancel</a>
        <button class="button primary" id="nextStep" ${w.parsed ? "" : "disabled"}>Continue</button>
      </div>`;
  }

  function dataPreview(parsed) {
    const sample = parsed.rows.slice(0, 5);
    return `
      <div class="data-summary">
        <div class="metric"><strong>${parsed.totalRows.toLocaleString()}</strong><span>Rows detected</span></div>
        <div class="metric"><strong>${parsed.headers.length}</strong><span>Columns detected</span></div>
        <div class="metric"><strong>${parsed.missingCount.toLocaleString()}</strong><span>Blank cells (preview)</span></div>
        <div class="metric"><strong>${parsed.headers.find(h => /(^id$|_id$|row_id)/i.test(h)) ? "1" : "0"}</strong><span>Likely ID columns</span></div>
      </div>
      <div class="table-wrap"><table><thead><tr>${parsed.headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
      <tbody>${sample.map(row => `<tr>${parsed.headers.map(h => `<td>${escapeHtml(String(row[h] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function goalStep() {
    const w = state.wizard;
    const headers = w.parsed?.headers || [];
    const likelyTarget = w.target || headers.find(h => /^y$/i.test(h)) || headers.at(-1) || "";
    w.target = likelyTarget;
    const graphOptions = state.graphs
      .filter(g => (g.kind || "project") === "project")
      .map(g => `<option value="${escapeAttr(g.id)}" ${w.graphId === g.id ? "selected" : ""}>${escapeHtml(g.name)}</option>`)
      .join("");
    return `
      <p class="eyebrow">Step 2 of 5</p>
      <h1>What should Orbita investigate?</h1>
      <p>Give the case a clear name, choose the outcome, and describe what success means.</p>
      <div class="form-stack">
        <label>Case name<input id="caseName" value="${escapeAttr(w.caseName || `${stripCsv(w.file?.name || "Dataset")} discovery`)}" /></label>
        <label>Project memory graph<select id="graphId">
          <option value="">Create a private case graph</option>
          ${graphOptions}
        </select></label>
        <p class="muted" style="margin:0;font-size:13px">This case writes discoveries/counterexamples to the selected memory graph.</p>
        <label>What do you want to learn?<textarea id="goal" placeholder="Example: Find the strongest reproducible predictors of y." ${w.exploreAll ? "disabled" : ""}>${w.exploreAll ? "" : escapeHtml(w.goal || `Discover and falsify reproducible predictive structures for ${likelyTarget || "the selected target"}.`)}</textarea></label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:600">
          <input type="checkbox" id="exploreAll" ${w.exploreAll ? "checked" : ""} style="width:auto" />
          Search all possible connections (no single target — explore every column pair)
        </label>
        <div class="two-col">
          <label>Target column<select id="target" ${w.exploreAll ? "disabled" : ""}>${headers.map(h => `<option ${h === likelyTarget ? "selected" : ""}>${escapeHtml(h)}</option>`).join("")}</select></label>
          <label>Evaluation metric<select id="metric">
            <option value="rmsle" ${w.metric === "rmsle" ? "selected" : ""}>RMSLE — relative error</option>
            <option value="rmse"  ${w.metric === "rmse"  ? "selected" : ""}>RMSE — absolute error</option>
            <option value="mae"   ${w.metric === "mae"   ? "selected" : ""}>MAE — average error</option>
            <option value="r2"    ${w.metric === "r2"    ? "selected" : ""}>R² — explained variance</option>
          </select></label>
        </div>
        <details class="details"><summary>Advanced settings</summary><div class="two-col">
          <label>Target transform<select id="transform">
            <option value="log1p" ${w.transform === "log1p" ? "selected" : ""}>log1p</option>
            <option value="none"  ${w.transform === "none"  ? "selected" : ""}>None</option>
          </select></label>
          <label>Outcome domain<select id="domain">
            <option value="nonneg"    ${w.outcomeDomain === "nonneg"    ? "selected" : ""}>Nonnegative</option>
            <option value="unbounded" ${w.outcomeDomain === "unbounded" ? "selected" : ""}>Unbounded</option>
          </select></label>
        </div></details>
      </div>
      <div class="actions"><button class="button ghost" id="backStep">Back</button><button class="button primary" id="nextStep">Review plan</button></div>`;
  }

  function goalStepV2() {
    const w = state.wizard;
    const headers = w.parsed?.headers || [];
    const mode = w.investigationMode || (w.exploreAll ? "discovery_scan" : "targeted_prediction");
    const isScan = mode === "discovery_scan";
    const isTargeted = mode === "targeted_prediction";
    const isContrast = mode === "predeclared_contrast";
    const likelyTarget = isScan ? "" : (w.target || headers.find(h => /^y$/i.test(h)) || headers.at(-1) || "");
    if (isTargeted) w.target = likelyTarget;
    if (isContrast) setPredeclaredContrastMode(w);
    const levels = columnLevels(w, w.contrast?.contrastColumn);
    if (isContrast) {
      if (!levels.includes(String(w.contrast.referenceLevel))) w.contrast.referenceLevel = levels[0] || "";
      if (!levels.includes(String(w.contrast.positiveLevel))) w.contrast.positiveLevel = levels.find(value => value !== w.contrast.referenceLevel) || "";
    }
    const validation = validateWizardConfig(w);
    const graphOptions = state.graphs
      .filter(g => (g.kind || "project") === "project")
      .map(g => `<option value="${escapeAttr(g.id)}" ${w.graphId === g.id ? "selected" : ""}>${escapeHtml(g.name)}</option>`)
      .join("");
    const headerOptions = selected => headers.map(header =>
      `<option value="${escapeAttr(header)}" ${header === selected ? "selected" : ""}>${escapeHtml(header)}</option>`
    ).join("");
    const levelOptions = selected => levels.map(level =>
      `<option value="${escapeAttr(level)}" ${String(level) === String(selected) ? "selected" : ""}>${escapeHtml(level)}</option>`
    ).join("");
    const modeFields = isScan
      ? `<p class="muted" style="margin:0;font-size:13px">Orbita will scan column relationships and try to falsify candidate structures.</p>`
      : isTargeted
        ? `<div class="two-col">
            <label>Target column<select id="target">${headerOptions(likelyTarget)}</select></label>
            <label>Evaluation metric<select id="metric">
              <option value="r2" ${w.metric === "r2" ? "selected" : ""}>R2 - explained variance</option>
              <option value="rmse" ${w.metric === "rmse" ? "selected" : ""}>RMSE - absolute error</option>
              <option value="mae" ${w.metric === "mae" ? "selected" : ""}>MAE - average error</option>
              <option value="rmsle" ${w.metric === "rmsle" ? "selected" : ""}>RMSLE - relative error</option>
            </select></label>
          </div>
          <details class="details"><summary>Advanced settings</summary><div class="two-col">
            <label>Predictor interpretation<select id="predictorInterpretation">
              <option value="auto" ${w.predictorInterpretation === "auto" ? "selected" : ""}>Auto</option>
              <option value="numeric" ${w.predictorInterpretation === "numeric" ? "selected" : ""}>Numeric</option>
              <option value="categorical" ${w.predictorInterpretation === "categorical" ? "selected" : ""}>Categorical</option>
              <option value="binary_indicator" ${w.predictorInterpretation === "binary_indicator" ? "selected" : ""}>Binary indicator</option>
            </select></label>
            <label>Target transform<select id="transform">
              <option value="none" ${w.transform === "none" ? "selected" : ""}>None</option>
              <option value="log1p" ${w.transform === "log1p" ? "selected" : ""}>log1p</option>
            </select></label>
            <label>Outcome domain<select id="domain">
              <option value="unbounded" ${w.outcomeDomain === "unbounded" ? "selected" : ""}>Unbounded</option>
              <option value="nonneg" ${w.outcomeDomain === "nonneg" ? "selected" : ""}>Nonnegative</option>
            </select></label>
          </div></details>`
        : `<div class="two-col">
            <label>Outcome column<select id="contrastOutcome">${headerOptions(w.contrast.outcomeColumn)}</select></label>
            <label>Contrast column<select id="contrastColumn">${headerOptions(w.contrast.contrastColumn)}</select></label>
            <label>Positive level<select id="positiveLevel">${levelOptions(w.contrast.positiveLevel)}</select></label>
            <label>Reference level<select id="referenceLevel">${levelOptions(w.contrast.referenceLevel)}</select></label>
            <label>Matched/block column<select id="blockColumn"><option value="">None</option>${headerOptions(w.contrast.blockColumn)}</select></label>
            <label>Direction hypothesis<select id="contrastDirection">
              <option value="two_sided" ${w.contrast.direction === "two_sided" ? "selected" : ""}>Two-sided</option>
              <option value="positive_greater_than_reference" ${w.contrast.direction === "positive_greater_than_reference" ? "selected" : ""}>Positive greater than reference</option>
              <option value="positive_less_than_reference" ${w.contrast.direction === "positive_less_than_reference" ? "selected" : ""}>Positive less than reference</option>
            </select></label>
            <label>Primary effect<select id="primaryEffect">
              <option value="mean_difference" ${w.contrast.primaryEffect === "mean_difference" ? "selected" : ""}>Mean difference</option>
              <option value="ratio" ${w.contrast.primaryEffect === "ratio" ? "selected" : ""}>Ratio</option>
              <option value="percentage_change" ${w.contrast.primaryEffect === "percentage_change" ? "selected" : ""}>Percentage change</option>
              <option value="standardized_effect" ${w.contrast.primaryEffect === "standardized_effect" ? "selected" : ""}>Standardized effect</option>
            </select></label>
            <label>Validation method<select id="validationMethod">
              <option value="automatic_conservative" ${w.contrast.validationMethod === "automatic_conservative" ? "selected" : ""}>Automatic conservative</option>
              <option value="blocked_holdout" ${w.contrast.validationMethod === "blocked_holdout" ? "selected" : ""}>Blocked holdout</option>
              <option value="paired_permutation_exact" ${w.contrast.validationMethod === "paired_permutation_exact" ? "selected" : ""}>Paired permutation/exact</option>
              <option value="bootstrap_by_block" ${w.contrast.validationMethod === "bootstrap_by_block" ? "selected" : ""}>Bootstrap by block</option>
            </select></label>
          </div>`;
    return `
      <p class="eyebrow">Step 2 of 5</p>
      <h1>What should Orbita investigate?</h1>
      <p>Choose a discovery scan, targeted prediction, or a predeclared contrast.</p>
      <div class="form-stack">
        <label>Case name<input id="caseName" value="${escapeAttr(w.caseName || `${stripCsv(w.file?.name || "Dataset")} discovery`)}" /></label>
        <label>Project memory graph<select id="graphId">
          <option value="">Create a private case graph</option>
          ${graphOptions}
        </select></label>
        <p class="muted" style="margin:0;font-size:13px">This case writes discoveries/counterexamples to the selected memory graph. Use the same project graph when multiple cases should contribute to review-only cross-case pattern proposals.</p>
        <div class="grid three">
          <label class="card" style="cursor:pointer;border-color:${isScan ? "#111827" : "var(--line)"}">
            <input type="radio" name="investigationMode" value="discovery_scan" ${isScan ? "checked" : ""} style="width:auto" />
            <strong>Discovery scan</strong>
            <p class="muted" style="font-size:13px;margin:6px 0 0">Explore relationships across columns. No single target required.</p>
          </label>
          <label class="card" style="cursor:pointer;border-color:${isTargeted ? "#111827" : "var(--line)"}">
            <input type="radio" name="investigationMode" value="targeted_prediction" ${isTargeted ? "checked" : ""} style="width:auto" />
            <strong>Targeted prediction</strong>
            <p class="muted" style="font-size:13px;margin:6px 0 0">Choose one outcome column and test predictive structures against it.</p>
          </label>
          <label class="card" style="cursor:pointer;border-color:${isContrast ? "#111827" : "var(--line)"}">
            <input type="radio" name="investigationMode" value="predeclared_contrast" ${isContrast ? "checked" : ""} style="width:auto" />
            <strong>Predeclared contrast</strong>
            <p class="muted" style="font-size:13px;margin:6px 0 0">Compare declared groups with optional matched/block validation.</p>
          </label>
        </div>
        <label>What do you want to learn?<textarea id="goal" placeholder="Example: Find reproducible structures across this dataset.">${escapeHtml(w.goal || (isScan ? "Discover and falsify reproducible structures across this dataset." : `Discover and falsify predictive structures for ${likelyTarget || "the selected target"}.`))}</textarea></label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:600">
          <input type="checkbox" id="exploreAll" ${isScan ? "checked" : ""} style="width:auto" />
          Search all possible connections (no single target - explore every column pair)
        </label>
        ${modeFields}
        ${(w.wizardError || !validation.ok || validation.warning) ? `<div class="${(!validation.ok || w.wizardError) ? "pw-error" : "pw-success"}" style="display:block">${escapeHtml(w.wizardError || validation.error || validation.warning)}</div>` : ""}
      </div>
      <div class="actions"><button class="button ghost" id="backStep">Back</button><button class="button primary" id="nextStep">Review plan</button></div>`;
  }

  function planStep() {
    const w = state.wizard;
    const mode = w.investigationMode || (w.exploreAll ? "discovery_scan" : "targeted_prediction");
    const isScan = mode === "discovery_scan";
    const isContrast = mode === "predeclared_contrast";
    return `
      <p class="eyebrow">Step 3 of 5</p>
      <h1>Review the discovery plan</h1>
      <p>Orbita will use a strict, reproducible workflow.</p>
      <ul class="plan-list">
        ${["Inspect the dataset and generate candidate relationships",
           "Challenge candidates on unseen selection data",
           "Combine useful predictors into composite models",
           isScan ? "Scan column relationships without choosing a single target" : isContrast ? "Keep matched conditions together across validation partitions" : "Remove predictors that do not improve the chosen metric",
           "Repeat stability checks across multiple data splits",
           "Freeze the selected model before report-only final validation",
           "Preserve supported and rejected findings in the evidence graph",
          ].map((x, i) => `<li><span class="num">${i + 1}</span><span>${x}</span></li>`).join("")}
      </ul>
      <div class="grid three">
        <div class="card"><p class="eyebrow">Discovery</p><h3>60%</h3><p>Candidate generation only</p></div>
        <div class="card"><p class="eyebrow">Selection</p><h3>25%</h3><p>Falsification and model choice</p></div>
        <div class="card"><p class="eyebrow">Final validation</p><h3>15%</h3><p>Report-only confirmation</p></div>
      </div>
      <details class="details"><summary>Technical receipt</summary>
        <div class="code-receipt">mode=${escapeHtml(mode)}\n${isScan ? "target_column=<none>\\nevaluation_metric=<backend default>" : isContrast ? `outcome_column=${escapeHtml(w.contrast.outcomeColumn)}\\ncontrast_column=${escapeHtml(w.contrast.contrastColumn)}\\nblock_column=${escapeHtml(w.contrast.blockColumn || "<none>")}\\nvalidation_method=${escapeHtml(w.contrast.validationMethod)}` : `target_column=${escapeHtml(w.target)}\\npredictor_interpretation=${escapeHtml(w.predictorInterpretation)}\\nmetric=${escapeHtml(w.metric)}\\ntarget_transform=${escapeHtml(w.transform)}\\noutcome_domain=${escapeHtml(w.outcomeDomain)}`}\ncomposition_strategy=composition_v1_1_backward_elimination\nplan_schema=orbita-research-plan/0.3</div>
      </details>
      <div class="actions">
        <button class="button ghost" id="backStep">Back</button>
        <button class="button primary" id="startRun" ${state.busy ? "disabled" : ""}>Run discovery</button>
      </div>`;
  }

  function runStep() {
    return `
      <p class="eyebrow">Step 4 of 5</p>
      <h1>Orbita is challenging the data</h1>
      <p id="progressMessage">Preparing a reproducible case…</p>
      <div class="progress-wrap">
        <div class="progress-bar"><span id="progressBar"></span></div>
        <div class="progress-steps" id="progressSteps">
          ${["Create case", "Upload and profile data", "Compile immutable plan", "Generate and falsify candidates", "Freeze artifacts and build evidence graph"]
            .map((x, i) => `<div class="progress-item" data-progress="${i}"><span>○</span><span>${x}</span></div>`).join("")}
        </div>
      </div>`;
  }

  function resultsStep() {
    const result   = normalizeResult(state.wizard.result || demoRunResult());
    const selected = result.selected;
    if (!selected) {
      return `
      <p class="eyebrow">Step 5 of 5</p>
      <h1>No governed result returned</h1>
      <p>Orbita finished the run, but the backend did not return an evaluable finding.</p>
      <details class="details"><summary>Technical receipt</summary>
        <div class="code-receipt">case_id=${escapeHtml(state.wizard.caseId || "demo")}\nplan_id=${escapeHtml(state.wizard.planId || "demo")}\nrun_id=${escapeHtml(state.wizard.runId || result.runId || "demo")}\nselected_model_id=<none>\nfinal_validation_report_only=true</div>
      </details>
      <div class="actions">
        <a class="button ghost" href="#/cases">Back to cases</a>
        <button class="button accent" id="newDiscovery">Start another discovery</button>
      </div>`;
    }
    const presentation = selected.presentation || verdictUi.fallbackPresentation(selected.status);
    const contrast = selected.contrast || null;
    const groupRows = Object.entries(contrast?.groups || {}).map(([name, group]) => `
      <tr><td>${escapeHtml(name)}</td><td>${escapeHtml(group.count ?? "")}</td><td>${formatScore(group.mean)}</td></tr>`
    ).join("");
    const matched = contrast?.matched_pairs || {};
    const contrastDetails = contrast ? `
      <section class="card" style="margin-top:18px">
        <p class="eyebrow">Predeclared contrast</p>
        <h3>${escapeHtml(contrast.simulation_finding || "Finite-dataset contrast")}</h3>
        <p>${escapeHtml(contrast.interpretation_scope || "Review this as a dataset-scoped contrast, not as a physics claim.")}</p>
        <div class="data-summary">
          <div class="metric"><strong>${formatScore(contrast.difference)}</strong><span>Mean difference</span></div>
          <div class="metric"><strong>${formatScore(contrast.ratio)}</strong><span>Mean ratio</span></div>
          <div class="metric"><strong>${formatScore(contrast.percent_change)}</strong><span>Percent change</span></div>
          <div class="metric"><strong>${escapeHtml(contrast.validation_status || "review")}</strong><span>Validation status</span></div>
        </div>
        <div style="overflow:auto;margin-top:12px">
          <table class="data-table">
            <thead><tr><th>Group</th><th>Rows</th><th>Mean outcome</th></tr></thead>
            <tbody>${groupRows || `<tr><td colspan="3">No group summary returned.</td></tr>`}</tbody>
          </table>
        </div>
        ${matched.complete_pairs !== undefined ? `<p class="muted">Matched blocks: ${escapeHtml(matched.complete_pairs)} complete, ${escapeHtml(matched.dropped_blocks || 0)} dropped.</p>` : ""}
        ${Array.isArray(contrast.cautions) && contrast.cautions.length ? `<ul class="check-list">${contrast.cautions.map(item => `<li><span class="check">!</span><span>${escapeHtml(item)}</span></li>`).join("")}</ul>` : ""}
      </section>` : "";
    const reviewItems = [
      `Verdict: ${presentation.label}`,
      result.hasSelectedModel ? "A frozen deployable model was selected for this target." : "No deployable model was selected; this result stays review-only.",
      contrast ? "Contrast details are finite-dataset evidence and do not establish causality or novelty." : "Review the evidence graph before treating this as reusable knowledge.",
    ];
    return `
      <p class="eyebrow">Step 5 of 5</p>
      <h1>${escapeHtml(presentation.headline)}</h1>
      <p>${escapeHtml(presentation.summary)}</p>
      <section class="result-hero">
        <span class="model-pill">${escapeHtml(presentation.label)}</span>
        <h2>${escapeHtml(selected.title)}</h2>
        <p>${escapeHtml(selected.hypothesis || selected.summary || presentation.summary)}</p>
        <div class="data-summary">
          <div class="metric"><strong>${formatScore(selected.selectionScore)}</strong><span>Selection ${escapeHtml(selected.metric.toUpperCase())}</span></div>
          <div class="metric"><strong>${formatScore(selected.finalScore)}</strong><span>Final validation</span></div>
          <div class="metric"><strong>${selected.predictors.length}</strong><span>Retained predictors</span></div>
          <div class="metric"><strong>${result.rejectedCount}</strong><span>Rejected alternatives</span></div>
        </div>
      </section>
      <div class="result-grid">
        <section class="card">
          <p class="eyebrow">${escapeHtml(presentation.detail_heading || "Review details")}</p>
          <ul class="check-list">
            ${reviewItems.map(item => `<li><span class="check">i</span><span>${escapeHtml(item)}</span></li>`).join("")}
          </ul>
        </section>
        <section class="card">
          <p class="eyebrow">What next?</p>
          <h3>Review, share, or predict</h3>
          <p>Use the evidence view for technical review. Generate predictions only from the frozen artifact.</p>
          <div class="actions">
            <button class="button primary" id="openGraph">Open evidence graph</button>
            <button class="button ghost" id="downloadSummary">Download summary</button>
          </div>
        </section>
      </div>
      ${contrastDetails}
      <section class="card" style="margin-top:18px">
        <p class="eyebrow">Evidence graph</p>
        <div id="graphContainer" style="min-height:48px"></div>
        <div class="graph-detail" style="font-size:13px;padding:8px 0 0;min-height:36px;color:var(--ink)"></div>
      </section>
      <details class="details"><summary>View rejected alternatives</summary><div>
        ${result.findings.filter(f => f.id !== selected.id).map(f =>
          `<p><strong>${escapeHtml(f.id)}</strong> — ${escapeHtml(f.status)}${f.score != null ? ` · ${formatScore(f.score)}` : ""}</p>`
        ).join("") || "No alternatives were returned."}
      </div></details>
      <details class="details"><summary>Technical receipt</summary>
        <div class="code-receipt">case_id=${escapeHtml(state.wizard.caseId || "demo")}\nplan_id=${escapeHtml(state.wizard.planId || "demo")}\nrun_id=${escapeHtml(state.wizard.runId || result.runId || "demo")}\nselected_model_id=${escapeHtml(result.hasSelectedModel ? selected.id : "<none>")}\nfinding_id=${escapeHtml(selected.id)}\nmetric=${escapeHtml(selected.metric)}\npublic_verdict=${escapeHtml(selected.status)}\nfinal_validation_report_only=true</div>
      </details>
      <div class="actions">
        <a class="button ghost" href="#/cases">Back to cases</a>
        <button class="button accent" id="newDiscovery">Start another discovery</button>
      </div>`;
  }

  // ── Wizard bindings ───────────────────────────────────────────────────────────
  function bindWizardStep() {
    const w = state.wizard;
    document.getElementById("backStep")?.addEventListener("click", () => { w.step -= 1; renderWizard(); });
    document.getElementById("nextStep")?.addEventListener("click", () => {
      if (w.step === 1 && !w.parsed) return;
      if (w.step === 2 && !captureGoalFormV2()) return;
      w.step += 1;
      renderWizard();
    });

    document.getElementById("exploreAll")?.addEventListener("change", e => {
      if (e.target.checked) setDiscoveryScanMode(w);
      else setTargetedMode(w, w.parsed?.headers?.find(h => /^y$/i.test(h)) || w.parsed?.headers?.at(-1) || "");
      w.wizardError = "";
      renderWizard();
    });
    document.querySelectorAll("input[name='investigationMode']").forEach(el => {
      el.addEventListener("change", e => {
        if (e.target.value === "discovery_scan") setDiscoveryScanMode(w);
        else if (e.target.value === "predeclared_contrast") setPredeclaredContrastMode(w);
        else setTargetedMode(w, w.parsed?.headers?.find(h => /^y$/i.test(h)) || w.parsed?.headers?.at(-1) || "");
        w.wizardError = "";
        renderWizard();
      });
    });
    document.getElementById("target")?.addEventListener("change", e => {
      setTargetedMode(w, e.target.value);
      w.wizardError = "";
      renderWizard();
    });
    document.getElementById("contrastColumn")?.addEventListener("change", e => {
      w.contrast.contrastColumn = e.target.value;
      const levels = columnLevels(w, e.target.value);
      w.contrast.referenceLevel = levels[0] || "";
      w.contrast.positiveLevel = levels[1] || "";
      renderWizard();
    });

    const fileInput = document.getElementById("fileInput");
    const dropzone  = document.getElementById("dropzone");
    fileInput?.addEventListener("change", e => handleFile(e.target.files?.[0]));
    dropzone?.addEventListener("dragover",  e => { e.preventDefault(); dropzone.classList.add("dragover"); });
    dropzone?.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone?.addEventListener("drop", e => { e.preventDefault(); dropzone.classList.remove("dragover"); handleFile(e.dataTransfer.files?.[0]); });

    const runBtn = document.getElementById("startRun");
    if (runBtn) {
      runBtn.addEventListener("click", async () => {
        if (state.busy) return;
        const validation = validateWizardConfig(w);
        if (!validation.ok) {
          w.wizardError = validation.error;
          w.step = 2;
          renderWizard();
          return;
        }
        state.busy    = true;
        runBtn.disabled = true;
        w.step = 4;
        renderWizard();
        try { await executeDiscovery(); }
        finally { state.busy = false; }
      });
    }

    document.getElementById("newDiscovery")?.addEventListener("click", () => {
      state.wizard = freshWizard();
      location.hash = "#/new";
      renderWizard();
    });
    document.getElementById("openGraph")?.addEventListener("click", () => {
      if (!w.caseId || DEV_MODE) return toast("Evidence graph available after a live discovery.");
      window.open(`/api/orbita/graph-viewer?case_id=${encodeURIComponent(w.caseId)}`, "_blank", "noopener,noreferrer");
    });
    document.getElementById("downloadSummary")?.addEventListener("click", downloadSummary);
    if (state.wizard.step === 5 && state.wizard.caseId) loadGraphInto("graphContainer", state.wizard.caseId);
  }

  function captureGoalForm() {
    const w = state.wizard;
    w.caseName      = document.getElementById("caseName").value.trim();
    w.graphId       = document.getElementById("graphId")?.value || null;
    w.exploreAll    = document.getElementById("exploreAll").checked;
    // A non-blank goal narrows candidate columns via substring match against
    // the goal text — force blank in explore-all mode so nothing is filtered out.
    w.goal          = w.exploreAll ? "" : document.getElementById("goal").value.trim();
    w.target        = w.exploreAll ? "" : document.getElementById("target").value;
    w.metric        = document.getElementById("metric").value;
    w.transform     = document.getElementById("transform").value;
    w.outcomeDomain = document.getElementById("domain").value;
  }

  function captureGoalFormV2() {
    const w = state.wizard;
    w.caseName = document.getElementById("caseName").value.trim();
    w.graphId = document.getElementById("graphId")?.value || null;
    w.investigationMode = document.querySelector("input[name='investigationMode']:checked")?.value
      || (document.getElementById("exploreAll")?.checked ? "discovery_scan" : "targeted_prediction");
    w.exploreAll = w.investigationMode === "discovery_scan";
    w.goal = document.getElementById("goal")?.value.trim()
      || (w.exploreAll ? "Discover and falsify reproducible structures across this dataset." : "");
    if (w.investigationMode === "predeclared_contrast") {
      w.contrast = {
        outcomeColumn: document.getElementById("contrastOutcome")?.value || "",
        contrastColumn: document.getElementById("contrastColumn")?.value || "",
        positiveLevel: document.getElementById("positiveLevel")?.value || "",
        referenceLevel: document.getElementById("referenceLevel")?.value || "",
        blockColumn: document.getElementById("blockColumn")?.value || "",
        direction: document.getElementById("contrastDirection")?.value || "two_sided",
        primaryEffect: document.getElementById("primaryEffect")?.value || "mean_difference",
        validationMethod: document.getElementById("validationMethod")?.value || "automatic_conservative",
      };
      w.target = w.contrast.outcomeColumn;
      w.metric = "r2";
      w.transform = "none";
      w.outcomeDomain = "unbounded";
      w.predictorInterpretation = "predeclared_contrast";
    } else {
      w.target = w.exploreAll ? "" : (document.getElementById("target")?.value || "");
      w.metric = w.exploreAll ? "" : (document.getElementById("metric")?.value || "r2");
      w.transform = w.exploreAll ? "none" : (document.getElementById("transform")?.value || "none");
      w.outcomeDomain = w.exploreAll ? "unbounded" : (document.getElementById("domain")?.value || "unbounded");
      w.predictorInterpretation = w.exploreAll ? "auto" : (document.getElementById("predictorInterpretation")?.value || "auto");
    }
    const validation = validateWizardConfig(w);
    if (!validation.ok) {
      w.wizardError = validation.error;
      renderWizard();
      return false;
    }
    w.wizardError = "";
    return true;
  }

  async function handleFile(file) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) return toast("Please choose a CSV file.", true);
    const MAX_HARD = 100 * 1024 * 1024;
    const MAX_WARN =  50 * 1024 * 1024;
    if (file.size > MAX_HARD) return toast(`File too large (${formatBytes(file.size)}). Maximum is 100 MB.`, true);
    if (file.size > MAX_WARN)  toast(`Large file (${formatBytes(file.size)}). Discovery may take several minutes.`);
    state.wizard.file = file;
    try {
      state.wizard.parsed = parseCsvPreview(await file.text());
      renderWizard();
    } catch (error) {
      toast(`Could not read CSV: ${error.message}`, true);
    }
  }

  function parseCsvPreview(text) {
    const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n").filter((l, i, a) => i < a.length - 1 || l.trim());
    if (!lines.length) throw new Error("The file is empty.");
    const headers = parseCsvLine(lines[0]);
    if (headers.length < 2) throw new Error("Orbita needs at least two columns.");
    const rows = lines.slice(1, 101).filter(Boolean).map(line => {
      const vals = parseCsvLine(line);
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
    });
    const missingCount = rows.reduce((s, r) => s + headers.filter(h => r[h] === "").length, 0);
    return { headers, rows, totalRows: Math.max(0, lines.length - 1), missingCount };
  }

  function parseCsvLine(line) {
    const vals = []; let val = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (quoted && line[i+1] === '"') { val += '"'; i++; } else quoted = !quoted; }
      else if (c === "," && !quoted) { vals.push(val.trim()); val = ""; }
      else val += c;
    }
    vals.push(val.trim());
    return vals;
  }

  // ── Discovery execution ───────────────────────────────────────────────────────
  async function executeDiscovery() {
    const steps   = [...document.querySelectorAll("[data-progress]")];
    const bar     = document.getElementById("progressBar");
    const message = document.getElementById("progressMessage");

    function progress(index, text, fn) {
      steps.forEach((s, i) => {
        s.classList.toggle("done",   i < index);
        s.classList.toggle("active", i === index);
        s.querySelector("span").textContent = i < index ? "✓" : i === index ? "●" : "○";
      });
      if (bar)     bar.style.width   = `${index * 20}%`;
      if (message) message.textContent = text;
      return fn();
    }

    try {
      const w = state.wizard;
      const validation = validateWizardConfig(w);
      if (!validation.ok) throw new Error(validation.error);
      const investigationMode = w.investigationMode || (w.exploreAll ? "discovery_scan" : "targeted_prediction");
      const isScan = investigationMode === "discovery_scan";
      const isContrast = investigationMode === "predeclared_contrast";

      const created = await progress(0, "Creating a clean case…", () =>
        api("/cases", { method: "POST", body: JSON.stringify({ name: w.caseName, goal: w.goal, graph_id: w.graphId || undefined }) })
      );
      w.caseId = created.case_id || created.id;
      w.graphId = created.graph_id || w.graphId;

      const uploaded = await progress(1, "Uploading and profiling your dataset…", async () => {
        const form = new FormData();
        form.append("file", w.file, w.file.name);
        return api(`/cases/${encodeURIComponent(w.caseId)}/files`, { method: "POST", body: form });
      });
      w.fileId = uploaded.file_id || uploaded.id;

      const compiled = await progress(2, "Freezing an immutable discovery plan…", () =>
        api(`/cases/${encodeURIComponent(w.caseId)}/compile`, {
          method: "POST",
          body: JSON.stringify({
            max_candidates: 60,
            evaluation_metric: isScan ? undefined : w.metric,
            target_transform: isScan || w.transform === "none" ? null : w.transform,
            outcome_domain: isScan ? null : w.outcomeDomain,
            confirmation_fraction: .25,
            final_validation_fraction: .15,
            target_column: isScan ? null : (w.target || null),
            investigation_mode: investigationMode,
            predictor_interpretation: isContrast ? "predeclared_contrast" : (w.predictorInterpretation || "auto"),
            contrast: isContrast ? {
              outcome_column: w.contrast.outcomeColumn,
              contrast_column: w.contrast.contrastColumn,
              positive_level: w.contrast.positiveLevel,
              reference_level: w.contrast.referenceLevel,
              block_column: w.contrast.blockColumn || null,
              direction: w.contrast.direction,
              primary_effect: w.contrast.primaryEffect,
              validation_method: w.contrast.validationMethod,
            } : null,
          }),
        })
      );
      w.planId = compiled.plan_id || compiled.id || compiled.plan?.plan_id;
      w.technical.planHash = compiled.plan_hash || compiled.plan?.plan_hash;

      if (!w.planId || !w.technical.planHash) {
        throw new Error("Orbita did not return a frozen plan ID and hash.");
      }
      const approved = window.confirm(
        "Orbita has frozen the exact discovery plan below.\n\n" +
        `Plan hash: ${w.technical.planHash}\n\n` +
        "Approve this exact plan and begin the governed run?"
      );
      if (!approved) throw new Error("Run cancelled before plan approval. The frozen plan was not executed.");
      await api(
        `/cases/${encodeURIComponent(w.caseId)}/plans/${encodeURIComponent(w.planId)}/approve`,
        { method: "POST", body: JSON.stringify({ plan_hash: w.technical.planHash }) }
      );

      const runStarted = await progress(3, "Generating candidates and trying to disprove them…", () =>
        api(`/cases/${encodeURIComponent(w.caseId)}/run`, {
          method: "POST",
          body: JSON.stringify({ plan_id: w.planId, graph_id: w.graphId || undefined }),
        })
      );
      w.runId = runStarted.id || runStarted.run_id;

      // Poll until terminal state (up to 10 minutes)
      let run = runStarted;
      const TERMINAL = ["completed", "failed", "error", "refuted", "done"];
      if (!TERMINAL.includes(run.status)) {
        for (let poll = 0; poll < 200; poll++) {
          await wait(3000);
          run = await api(`/runs/${encodeURIComponent(w.runId)}`);
          if (message) {
            const elapsed = Math.round((poll + 1) * 3 / 60);
            const statusLabel = run.status === "queued" ? "Waiting in queue…" : "Challenging the data…";
            if (poll % 5 === 4) message.textContent = `${statusLabel} (${elapsed} min elapsed)`;
          }
          if (TERMINAL.includes(run.status)) break;
        }
        if (!TERMINAL.includes(run.status))
          throw new Error("Discovery is taking longer than expected. Refresh the case page to monitor progress.");
        if (run.status === "failed" || run.status === "error")
          throw new Error(run.error || run.error_message || "Discovery failed. See the case page for details.");
      }
      w.result = run;

      await progress(4, "Freezing artifacts and building the evidence graph…", () => wait(700));
      if (bar) bar.style.width = "100%";
      steps.forEach(s => { s.classList.add("done"); s.classList.remove("active"); s.querySelector("span").textContent = "✓"; });
      if (message) message.textContent = "Discovery complete.";
      await wait(500);
      if (w.exploreAll) {
        // No single target — the case page already lists every finding across
        // every outcome column, so skip the single-target hero step.
        toast("Discovery complete. Showing every finding across all columns.");
        location.hash = `#/case/${w.caseId}`;
        return;
      }
      w.step = 5;
      renderWizard();
    } catch (error) {
      toast(error.message, true);
      if (message) message.textContent = "Orbita stopped safely. Review the error and try again.";
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.innerHTML = `<button class="button ghost" id="returnPlan">Return to plan</button>`;
      document.getElementById("wizardPanel")?.appendChild(actions);
      document.getElementById("returnPlan")?.addEventListener("click", () => { state.wizard.step = 3; renderWizard(); });
    }
  }

  // ── Result normalization ──────────────────────────────────────────────────────
  function normalizeResult(payload) {
    const requestedTarget = state.wizard.target || "";
    const authoritative = verdictUi.normalizeRunResult(payload, {
      target: requestedTarget,
      metric: state.wizard.metric,
    });
    if (requestedTarget && authoritative.selected?.predictors.includes(requestedTarget)) {
      throw new Error(
        `Target leakage detected in results: column "${requestedTarget}" appears as a predictor. ` +
        "This indicates a data or configuration error; the target column must not be used to predict itself."
      );
    }
    return authoritative;

    /* Legacy normalizer retained below only as unreachable migration context.
       The authoritative module above owns all runtime verdict presentation. */
    const data = payload.result || payload;
    const target = state.wizard.target || "";
    const findings = (data.findings || data.claims || data.results || []).map(f => ({
      id:         f.candidate?.id || f.candidate_id || f.claim_id || f.id || "finding",
      status:     f.final_status  || f.status || f.verdict || "unknown",
      score:      f.selection_metric_score ?? f.metric_score ?? f.score,
      finalScore: f.final_validation_metric_score,
      outcome:    f.candidate?.payload?.outcome || f.outcome || "",
      predictors: f.candidate?.payload?.predictors
        || (f.candidate?.payload?.predictor ? [f.candidate.payload.predictor] : null)
        || f.predictors || f.scope?.predictors || [],
    }));

    const selectedMap = data.selected_models || data.engine_result?.selected_models || {};

    // Guard: only accept the model keyed exactly to the user's target.
    // If the key is missing the backend found no model for this target —
    // do NOT fall through to Object.values()[0] which may have the target as a predictor.
    const selectedInfo = (target && selectedMap[target]) ? selectedMap[target] : {};
    const missingTarget = target && !selectedMap[target] && Object.keys(selectedMap).length > 0;

    const selectedId = selectedInfo.selected_model_id || payload.selected_model_id
      || findings.find(f => /composite/.test(f.id) && f.outcome === target)?.id
      || findings.find(f => f.outcome === target)?.id
      || findings[0]?.id || "selected model";

    const selectedFinding = findings.find(f => f.id === selectedId) || findings[0] || { id: selectedId, predictors: [], outcome: "" };
    const metric = selectedInfo.evaluation_metric || state.wizard.metric;

    // Derive predictor list from the finding payload.
    let predictors = selectedFinding.predictors.length ? selectedFinding.predictors
      : selectedId.includes("composite") ? []
      : [];

    // Hard leakage check: the target column must never appear in the predictor list.
    if (target && predictors.includes(target)) {
      throw new Error(
        `Target leakage detected in results: column "${target}" appears as a predictor. ` +
        `This indicates a data or configuration error — the target column must not be used to predict itself.`
      );
    }

    // Warn if the model's outcome doesn't match the user's target.
    if (missingTarget) {
      console.warn(
        `[Orbita] selected_models does not contain target "${target}". ` +
        `Keys present: ${Object.keys(selectedMap).join(", ")}. Outcome may not match.`
      );
    }

    // Friendly title: "predictor1 + predictor2 → target"
    const predictorLabel = predictors.length ? predictors.join(" + ") : selectedId.split(":").slice(0, 2).join(":");
    const outcomeLabel = selectedFinding.outcome || target || "target";
    const title = `${predictorLabel} → ${outcomeLabel}`;

    return {
      runId: data.run_id || payload.id,
      findings,
      rejectedCount: findings.filter(f => /refut|reject|kill/i.test(f.status)).length,
      selected: {
        id: selectedId,
        title,
        summary: "This structure is shown with the backend's authoritative verdict presentation.",
        predictors, metric,
        selectionScore: selectedInfo.selection_metric_score ?? selectedFinding.score ?? null,
        finalScore: selectedFinding.finalScore ?? null,
      },
    };
  }

  // ── Case detail ───────────────────────────────────────────────────────────────
  async function renderCase(caseId) {
    showLoading();
    let detail = null;
    let claims = [];
    try { detail = DEV_MODE ? null : await api(`/cases/${encodeURIComponent(caseId)}`); } catch (_) {}
    try {
      const claimsResp = DEV_MODE ? null : await api(`/cases/${encodeURIComponent(caseId)}/claims`);
      claims = claimsResp?.claims || [];
    } catch (_) {}
    let moduleSummary = null;
    try { moduleSummary = DEV_MODE ? null : await api(`/cases/${encodeURIComponent(caseId)}/modules`); } catch (_) {}

    const local  = state.cases.find(c => c.id === caseId);
    const name   = detail?.name   || local?.name   || "Discovery case";
    const goal   = detail?.goal   || local?.goal   || "";
    const status = detail?.status || local?.status || "available";
    const runs   = detail?.runs   || [];
    const lastRun = runs[runs.length - 1];
    const findings       = lastRun?.result?.findings || [];
    const selectedModels = lastRun?.result?.selected_models || {};
    const runId          = lastRun?.id;

    // Claims carry the enriched verdict (not_supported / inconclusive /
    // functional_form_rejected / refuted / committed / provisional / artifact /
    // unresolved) plus the diagnostic fields for the drawer. Raw findings only
    // ever report the engine's collapsed final_status, so prefer claims when
    // available and fall back to raw findings only if the claims fetch failed.
    const claimByCandidateId = {};
    claims.forEach(c => { if (c.source_candidate_id) claimByCandidateId[c.source_candidate_id] = c; });

    const rows = findings.length ? findings : claims.map(c => ({ candidate: { id: c.source_candidate_id } }));

    const findingRows = rows.length
      ? rows.map((f, i) => {
          const cid = f.candidate?.id || f.id;
          const claim = claimByCandidateId[cid];
          const fd = claim?.finding_detail || {};
          const s = claim?.verdict || f.final_status || f.verdict || "unknown";
          const label = f.candidate?.payload?.predictor
            ? `${f.candidate.payload.predictor} → ${f.candidate.payload.outcome || "target"}`
            : claim?.canonical_text || cid || f.id || "finding";
          const rowId = `finding-row-${i}`;
          const hasDetail = claim != null;
          return `<div class="finding-row" style="border-bottom:1px solid var(--line)">
            <div style="display:flex;gap:12px;align-items:baseline;padding:8px 0;${hasDetail ? "cursor:pointer" : ""}"
                 ${hasDetail ? `data-finding-toggle="${rowId}"` : ""}>
              <span class="status ${escapeHtml(s)}" style="flex-shrink:0">${escapeHtml(String(s).replaceAll("_"," "))}</span>
              <span>${escapeHtml(label)}</span>
              <span style="margin-left:auto;color:var(--muted);font-size:13px">${formatScore(f.selection_metric_score ?? fd.candidate_score)}</span>
              ${hasDetail ? `<span style="color:var(--muted);font-size:11px">▾</span>` : ""}
            </div>
            ${hasDetail ? `<div id="${rowId}" style="display:none;padding:4px 0 12px 0;font-size:13px;color:var(--muted);line-height:1.7">
              ${fd.metric_name ? `<div><strong>Metric:</strong> ${escapeHtml(fd.metric_name)}</div>` : ""}
              ${fd.held_out_score != null ? `<div><strong>Held-out score:</strong> ${formatScore(fd.held_out_score)}${fd.held_out_n != null ? ` (n=${escapeHtml(String(fd.held_out_n))})` : ""}</div>` : ""}
              ${fd.full_data_score_diagnostic != null ? `<div><strong>Full-data fit (diagnostic only):</strong> ${formatScore(fd.full_data_score_diagnostic)}</div>` : ""}
              <div><strong>Verdict reason:</strong> ${escapeHtml(fd.rejection_reason || fd.verdict_reason || "—")}</div>
              <div><strong>Predictive claim:</strong> ${fd.is_predictive_claim ? "Yes — this candidate asserts predictive performance above baseline" : "No — this is a general association/relationship claim"}</div>
              ${fd.alternative_candidate_id ? `<div><strong>Alternative candidate:</strong> <span style="font-family:monospace">${escapeHtml(fd.alternative_candidate_id)}</span></div>` : ""}
            </div>` : ""}
          </div>`;
        }).join("")
      : `<p style="color:var(--muted)">No findings yet — run a discovery to see results.</p>`;

    // Phase 2D-A: module summary — group raw findings into readable candidate
    // modules with warning badges. Presentation only; every module lists its
    // raw member findings and no verdict is changed or hidden.
    const badgeChip = (text) =>
      `<span style="display:inline-block;background:#fff3e0;color:#8a4b00;border:1px solid #f3c98b;border-radius:10px;padding:1px 8px;font-size:11px;margin:2px 4px 2px 0">${escapeHtml(text)}</span>`;
    const verdictSummary = (counts) => Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => `${n} ${String(v).replaceAll("_", " ")}`)
      .join(" · ");
    const moduleCards = (moduleSummary?.modules || []).map((m, mi) => {
      const memberId = `module-members-${mi}`;
      const memberRows = m.members.slice(0, 40).map(member => `
        <div style="display:flex;gap:10px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--line)">
          <span class="status ${escapeHtml(member.verdict)}" style="flex-shrink:0;font-size:11px">${escapeHtml(String(member.verdict).replaceAll("_", " "))}</span>
          <span style="font-size:13px">${escapeHtml(member.hypothesis || member.candidate_id || "finding")}</span>
          ${member.score != null ? `<span style="margin-left:auto;color:var(--muted);font-size:12px">${formatScore(member.score)}</span>` : ""}
        </div>`).join("");
      return `<div class="card" style="margin-top:8px">
        <div style="display:flex;gap:12px;align-items:baseline;cursor:pointer" data-finding-toggle="${memberId}">
          <h3 style="font-size:15px;margin:0">${escapeHtml(m.label)}</h3>
          <span style="color:var(--muted);font-size:12px">${m.finding_count} finding${m.finding_count === 1 ? "" : "s"}${m.supporting_count ? ` · ${m.supporting_count} supporting` : ""}</span>
          <span style="margin-left:auto;color:var(--muted);font-size:11px">▾</span>
        </div>
        <div style="color:var(--muted);font-size:12px;margin-top:4px">${escapeHtml(verdictSummary(m.verdict_counts))}</div>
        ${m.warning_badges.length ? `<div style="margin-top:6px">${m.warning_badges.map(badgeChip).join("")}</div>` : ""}
        <div id="${memberId}" style="display:none;margin-top:8px">${memberRows}
          ${m.members.length > 40 ? `<p style="color:var(--muted);font-size:12px">…and ${m.members.length - 40} more in the findings list below.</p>` : ""}
        </div>
      </div>`;
    }).join("");
    const moduleSection = moduleCards ? `
      <section class="card" style="margin-top:12px">
        <p class="eyebrow">Finding modules — grouped view of ${moduleSummary.total_findings} findings</p>
        ${moduleSummary.case_badges.length ? `<div style="margin:4px 0 2px">${moduleSummary.case_badges.map(badgeChip).join("")}</div>` : ""}
        <p style="color:var(--muted);font-size:12px;margin:4px 0 0">Modules are a readable grouping of the raw findings below — verdicts are unchanged, and every module expands to its member findings.</p>
        ${moduleCards}
      </section>` : "";

    const selectedSummary = Object.entries(selectedModels).map(([col, info]) =>
      `<div class="card"><p class="eyebrow">Selected model · ${escapeHtml(col)}</p>
       <h3 style="font-size:16px;word-break:break-all">${escapeHtml(shortId(info.selected_model_id||""))}</h3>
       <p>${escapeHtml(info.evaluation_metric||"")} · score ${formatScore(info.selection_metric_score)}</p></div>`
    ).join("") || "";

    app.innerHTML = `
      <section class="hero-card">
        <p class="eyebrow">Case overview</p>
        <h1 style="font-size:40px;margin:8px 0 12px">${escapeHtml(name)}</h1>
        ${goal ? `<p>${escapeHtml(goal)}</p>` : ""}
        <div class="actions">
          <a class="button ghost" href="#/cases">Back to my cases</a>
          <button class="button primary" id="caseGraph">Open full graph</button>
        </div>
      </section>

      <div class="grid three" style="margin-top:18px">
        <section class="card"><p class="eyebrow">Status</p><h3>${escapeHtml(status.replaceAll("_"," "))}</h3></section>
        <section class="card"><p class="eyebrow">Runs</p><h3>${runs.length}</h3></section>
        <section class="card"><p class="eyebrow">Findings</p><h3>${findings.length}</h3></section>
      </div>

      ${selectedSummary ? `<div class="grid three" style="margin-top:12px">${selectedSummary}</div>` : ""}

      ${moduleSection}

      <section class="card" style="margin-top:12px">
        <p class="eyebrow">Findings from last run</p>
        ${findingRows}
      </section>

      <section class="card" style="margin-top:12px">
        <p class="eyebrow">Evidence graph</p>
        <div id="caseGraphContainer" style="min-height:48px"></div>
        <div class="graph-detail" style="font-size:13px;padding:8px 0 0;min-height:36px;color:var(--ink)"></div>
      </section>

      <details class="details"><summary>Technical receipt</summary>
        <div class="code-receipt">case_id=${escapeHtml(caseId)}\n${runId ? `run_id=${escapeHtml(runId)}\n` : ""}mode=${DEV_MODE ? "demo" : "live"}</div>
      </details>`;

    document.getElementById("caseGraph").addEventListener("click", () => {
      if (DEV_MODE) return toast("Graph available after a live discovery.");
      window.open(`/api/orbita/graph-viewer?case_id=${encodeURIComponent(caseId)}`, "_blank", "noopener,noreferrer");
    });
    document.querySelectorAll("[data-finding-toggle]").forEach(el => {
      el.addEventListener("click", () => {
        const panel = document.getElementById(el.dataset.findingToggle);
        if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
      });
    });
    loadGraphInto("caseGraphContainer", caseId);
  }

  // ── Graph ─────────────────────────────────────────────────────────────────────
  function graphNodeFill(node) {
    if (node.type === "analysis_run")  return "#1b4332";
    if (node.type === "source")        return "#1565c0";
    if (node.type === "evidence")      return "#6a0dad";
    if (node.type === "reexamination") return "#e65100";
    const s = (node.status || node.public_state || "").toLowerCase();
    // Check exact new-status values first — several contain substrings ("reject"
    // in functional_form_rejected, "support" in supported_association) that the
    // generic regexes below would misclassify, defeating the distinction.
    if (s === "functional_form_rejected") return "#d97706";  // amber
    if (s === "not_supported")            return "#94a3b8";  // slate
    if (s === "inconclusive")             return "#475569";  // dark slate
    if (s === "supported_association")    return "#14b8a6";  // teal
    if (s === "regime_dependent")         return "#a855f7";  // purple
    if (/commit|surviv|support/.test(s))  return "#2d6a4f";
    if (/refut|reject|kill|fail/.test(s)) return "#b71c1c";
    return "#546e7a";
  }

  function layoutGraph(nodes, edges, W, H) {
    if (!nodes.length) return [];
    const pos = nodes.map(() => ({ x: W/2+(Math.random()-.5)*W*.5, y: H/2+(Math.random()-.5)*H*.5, vx:0, vy:0 }));
    const idx = Object.fromEntries(nodes.map((n, i) => [n.id, i]));
    for (let t = 0; t < 300; t++) {
      const cool = Math.max(0, 1 - t/300);
      for (let i = 0; i < nodes.length; i++)
        for (let j = i+1; j < nodes.length; j++) {
          const dx=pos[i].x-pos[j].x, dy=pos[i].y-pos[j].y, d2=dx*dx+dy*dy||1, d=Math.sqrt(d2), f=4000/d2;
          pos[i].vx+=f*dx/d; pos[i].vy+=f*dy/d; pos[j].vx-=f*dx/d; pos[j].vy-=f*dy/d;
        }
      for (const e of edges) {
        const si=idx[e.from], ti=idx[e.to]; if(si===undefined||ti===undefined) continue;
        const dx=pos[ti].x-pos[si].x, dy=pos[ti].y-pos[si].y, d=Math.sqrt(dx*dx+dy*dy)||1, f=(d-80)*.05;
        pos[si].vx+=f*dx/d; pos[si].vy+=f*dy/d; pos[ti].vx-=f*dx/d; pos[ti].vy-=f*dy/d;
      }
      for (const p of pos) {
        p.vx+=(W/2-p.x)*.012; p.vy+=(H/2-p.y)*.012;
        p.x+=p.vx*cool; p.y+=p.vy*cool; p.vx*=.7; p.vy*=.7;
        p.x=Math.max(18,Math.min(W-18,p.x)); p.y=Math.max(18,Math.min(H-18,p.y));
      }
    }
    return pos;
  }

  function renderGraphSvg(nodes, edges) {
    if (!nodes.length) return `<p style="color:var(--muted);font-size:13px;padding:12px 0">No graph data.</p>`;
    const W=680, H=360, pos=layoutGraph(nodes, edges, W, H), idx=Object.fromEntries(nodes.map((n,i)=>[n.id,i]));
    const edgeSvg = edges.map(e => {
      const si=idx[e.from], ti=idx[e.to]; if(si===undefined||ti===undefined) return "";
      const {x:sx,y:sy}=pos[si], {x:tx,y:ty}=pos[ti], dx=tx-sx, dy=ty-sy, d=Math.sqrt(dx*dx+dy*dy)||1;
      return `<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${(tx-dx/d*11).toFixed(1)}" y2="${(ty-dy/d*11).toFixed(1)}" stroke="#cbd5e1" stroke-width="1.2" marker-end="url(#garr)"><title>${escapeHtml(e.label||e.type)}</title></line>`;
    }).join("");
    const nodeSvg = nodes.map((n,i) => {
      const {x,y}=pos[i], fill=graphNodeFill(n), label=(n.display_label||n.label||n.id).slice(0,20);
      return `<g class="gnode" data-nidx="${i}" style="cursor:pointer">
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="${fill}" stroke="#fff" stroke-width="1.5"/>
        <text x="${x.toFixed(1)}" y="${(y+20).toFixed(1)}" text-anchor="middle" font-size="9" fill="#64748b" font-family="system-ui,sans-serif">${escapeHtml(label)}</text>
        <title>${escapeHtml(n.full_text||n.label||n.id)}</title>
      </g>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;background:#f8fafc;border-radius:8px;display:block" xmlns="http://www.w3.org/2000/svg">
      <defs><marker id="garr" markerWidth="5" markerHeight="5" refX="4.5" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="#cbd5e1"/></marker></defs>
      ${edgeSvg}${nodeSvg}</svg>`;
  }

  async function loadGraphInto(containerId, caseId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!caseId || DEV_MODE) { el.innerHTML = `<p style="color:var(--muted);font-size:13px;padding:12px 0">Evidence graph available after a live discovery.</p>`; return; }
    el.innerHTML = `<p style="color:var(--muted);font-size:13px;padding:12px 0">Loading evidence graph…</p>`;
    try {
      const g = await api(`/cases/${encodeURIComponent(caseId)}/graph`);
      const nodes=g.nodes||[], edges=g.edges||[];
      el.innerHTML = renderGraphSvg(nodes, edges);
      const detail = el.nextElementSibling;
      el.querySelectorAll(".gnode").forEach(gEl => {
        const i = parseInt(gEl.dataset.nidx, 10);
        gEl.addEventListener("click", () => {
          if (!detail) return;
          const n = nodes[i];
          const aw = n.artifact_warning;
          if (aw && aw.type === "likely_derived_variable") {
            // Display-only: a near-deterministic dependency cluster, not an
            // every-member-is-an-artifact claim.
            const br = aw.best_reconstruction || {};
            const rows = [
              ["Cluster members", (aw.member_columns || []).join(", ")],
              ["Derivation direction", aw.derivation_direction || "undetermined"],
              ["Reconstruction metric", (br.reconstruction_metric || "held_out_r2") + (br.construction ? ` (${br.construction})` : "")],
              ["Held-out reconstruction", br.held_out_r2 != null ? (+br.held_out_r2).toFixed(6) : "—"],
              ["Residual variance ratio", br.residual_variance_ratio != null ? (+br.residual_variance_ratio).toExponential(2) : "—"],
              ["Valid repeated-refits", br.valid_refit_count != null ? (br.valid_refit_count + (br.refit_attempts ? ` of ${br.refit_attempts}` : "")) : "—"],
            ].map(([k, v]) => `<p style="margin:3px 0;font-size:12px"><span style="color:var(--muted)">${escapeHtml(k)}:</span> ${escapeHtml(String(v))}</p>`).join("");
            detail.innerHTML = `<strong>Near-deterministic dependency cluster</strong> <span style="font-size:12px;color:var(--muted)">${escapeHtml(n.id)}</span>${rows}<p style="margin:6px 0 0;font-size:12px;color:var(--muted)">The data cannot determine which member was constructed, so the whole set is flagged; no single member is singled out.</p>`;
            return;
          }
          detail.innerHTML = `<strong>${escapeHtml(n.display_label||n.type)}</strong> <span style="font-size:12px;color:var(--muted)">${escapeHtml(n.id)}</span><p style="margin:6px 0 0">${escapeHtml(n.full_text||n.label||"")}</p>${n.verdict_reason?`<p style="margin:4px 0 0;font-size:12px;color:var(--muted)">${escapeHtml(n.verdict_reason)}</p>`:""}`;
        });
      });
    } catch (err) {
      el.innerHTML = `<p style="color:var(--muted);font-size:13px;padding:12px 0">Graph unavailable: ${escapeHtml(err.message)}</p>`;
    }
  }

  // ── Download summary ──────────────────────────────────────────────────────────
  function downloadSummary() {
    const result  = normalizeResult(state.wizard.result || demoRunResult());
    const content = JSON.stringify({ case_id:state.wizard.caseId, plan_id:state.wizard.planId, run_id:state.wizard.runId, target:state.wizard.target, selected_model:result.selected, findings:result.findings }, null, 2);
    const url = URL.createObjectURL(new Blob([content], { type:"application/json" }));
    const a = Object.assign(document.createElement("a"), { href:url, download:"orbita-discovery-summary.json" });
    a.click(); URL.revokeObjectURL(url);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────
  function showLoading() { app.innerHTML = document.getElementById("loadingTemplate").innerHTML; }

  function makeToast(el) {
    function show(msg, error=false) {
      el.textContent = msg; el.classList.toggle("error", error); el.classList.add("show");
      clearTimeout(show._t); show._t = setTimeout(() => el.classList.remove("show"), 4200);
    }
    return show;
  }

  function escapeHtml(v="") { return String(v).replace(/[&<>'"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]); }
  function escapeAttr(v="") { return escapeHtml(v); }
  function shortId(v="") { return v.length>24?`${v.slice(0,12)}…${v.slice(-6)}`:v; }
  function stripCsv(n) { return n.replace(/\.csv$/i,"").replace(/[_-]+/g," ").replace(/\b\w/g,m=>m.toUpperCase()); }
  function formatBytes(b) { if(!Number.isFinite(b))return""; const u=["B","KB","MB","GB"]; let i=0,v=b; while(v>=1024&&i<u.length-1){v/=1024;i++;} return `${v.toFixed(i?1:0)} ${u[i]}`; }
  function formatScore(v) { return verdictUi.formatScore(v); }
  function wait(ms) { return new Promise(r=>setTimeout(r,ms)); }

  router();
})();
