(() => {
  "use strict";

  // Localhost → dev/demo mode; deployed → always live via server-side proxy
  const DEV_MODE = location.hostname === "localhost" || location.hostname === "127.0.0.1";

  const state = {
    cases:  [],
    wizard: freshWizard(),
    busy:   false,   // prevents duplicate run submissions
    me:     null,    // populated by /auth/me on first use
  };

  const app   = document.getElementById("app");
  const toast = makeToast(document.getElementById("toast"));

  window.addEventListener("hashchange", router);

  function freshWizard() {
    return {
      step: 1, file: null, parsed: null,
      caseName: "", goal: "", target: "",
      metric: "rmsle", transform: "log1p", outcomeDomain: "nonneg",
      caseId: null, fileId: null, planId: null, runId: null,
      result: null, technical: {}
    };
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
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Mock API (localhost dev only) ─────────────────────────────────────────────
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
      const r = await fetch("/auth/me");
      if (r.status === 401) { window.location.href = "/login"; return null; }
      state.me = await r.json();
      return state.me;
    } catch { return null; }
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
    const me = await getMe();
    showVerificationBanner(me);
    const hash = location.hash || "#/cases";
    if (hash === "#/new")        return renderWizard();
    if (hash === "#/account")    return renderAccount();
    if (hash.startsWith("#/case/")) return renderCase(hash.split("/").pop());
    return renderCases();
  }

  function updateNav() {
    const hash = location.hash || "#/cases";
    document.querySelectorAll("[data-nav]").forEach(link => {
      const n = link.dataset.nav;
      const active = n === "new"     ? hash === "#/new"
        : n === "account" ? hash === "#/account"
        : hash.startsWith("#/cases") || hash.startsWith("#/case/");
      link.classList.toggle("active", active);
    });
  }

  // ── Cases list ────────────────────────────────────────────────────────────────
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
            <li><span class="check">✓</span><span style="color:rgba(255,255,255,.85)">Plain-language findings</span></li>
            <li><span class="check">✓</span><span style="color:rgba(255,255,255,.85)">Rejected alternatives preserved</span></li>
            <li><span class="check">✓</span><span style="color:rgba(255,255,255,.85)">Technical receipts when you need them</span></li>
          </ul>
        </aside>
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
    const renderers = { 1: uploadStep, 2: goalStep, 3: planStep, 4: runStep, 5: resultsStep };
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
    return `
      <p class="eyebrow">Step 2 of 5</p>
      <h1>What should Orbita investigate?</h1>
      <p>Give the case a clear name, choose the outcome, and describe what success means.</p>
      <div class="form-stack">
        <label>Case name<input id="caseName" value="${escapeAttr(w.caseName || `${stripCsv(w.file?.name || "Dataset")} discovery`)}" /></label>
        <label>What do you want to learn?<textarea id="goal" placeholder="Example: Find the strongest reproducible predictors of y.">${escapeHtml(w.goal || `Discover and falsify reproducible predictive structures for ${likelyTarget || "the selected target"}.`)}</textarea></label>
        <div class="two-col">
          <label>Target column<select id="target">${headers.map(h => `<option ${h === likelyTarget ? "selected" : ""}>${escapeHtml(h)}</option>`).join("")}</select></label>
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

  function planStep() {
    const w = state.wizard;
    return `
      <p class="eyebrow">Step 3 of 5</p>
      <h1>Review the discovery plan</h1>
      <p>Orbita will use a strict, reproducible workflow.</p>
      <ul class="plan-list">
        ${["Inspect the dataset and generate candidate relationships",
           "Challenge candidates on unseen selection data",
           "Combine useful predictors into composite models",
           "Remove predictors that do not improve the chosen metric",
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
        <div class="code-receipt">metric=${escapeHtml(w.metric)}\ntarget_transform=${escapeHtml(w.transform)}\noutcome_domain=${escapeHtml(w.outcomeDomain)}\ncomposition_strategy=composition_v1_1_backward_elimination\nplan_schema=orbita-research-plan/0.3</div>
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
    return `
      <p class="eyebrow">Step 5 of 5</p>
      <h1>Here is what survived</h1>
      <p>Start with the conclusion. Open the technical evidence only when you need it.</p>
      <section class="result-hero">
        <span class="model-pill">Supported</span>
        <h2>${escapeHtml(selected.title)}</h2>
        <p>${escapeHtml(selected.summary)}</p>
        <div class="data-summary">
          <div class="metric"><strong>${formatScore(selected.selectionScore)}</strong><span>Selection ${escapeHtml(selected.metric.toUpperCase())}</span></div>
          <div class="metric"><strong>${formatScore(selected.finalScore)}</strong><span>Final validation</span></div>
          <div class="metric"><strong>${selected.predictors.length}</strong><span>Retained predictors</span></div>
          <div class="metric"><strong>${result.rejectedCount}</strong><span>Rejected alternatives</span></div>
        </div>
      </section>
      <div class="result-grid">
        <section class="card">
          <p class="eyebrow">Why it survived</p>
          <ul class="check-list">
            <li><span class="check">✓</span><span>Beat the strongest single-variable model</span></li>
            <li><span class="check">✓</span><span>Every retained predictor improved ${escapeHtml(selected.metric.toUpperCase())}</span></li>
            <li><span class="check">✓</span><span>Remained stable across repeated splits</span></li>
            <li><span class="check">✓</span><span>Held up on untouched final-validation data</span></li>
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
        <div class="code-receipt">case_id=${escapeHtml(state.wizard.caseId || "demo")}\nplan_id=${escapeHtml(state.wizard.planId || "demo")}\nrun_id=${escapeHtml(state.wizard.runId || result.runId || "demo")}\nselected_model_id=${escapeHtml(selected.id)}\nmetric=${escapeHtml(selected.metric)}\nfinal_validation_report_only=true</div>
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
      if (w.step === 2) captureGoalForm();
      w.step += 1;
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
    w.goal          = document.getElementById("goal").value.trim();
    w.target        = document.getElementById("target").value;
    w.metric        = document.getElementById("metric").value;
    w.transform     = document.getElementById("transform").value;
    w.outcomeDomain = document.getElementById("domain").value;
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

      const created = await progress(0, "Creating a clean case…", () =>
        api("/cases", { method: "POST", body: JSON.stringify({ name: w.caseName, goal: w.goal }) })
      );
      w.caseId = created.case_id || created.id;

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
            evaluation_metric: w.metric,
            target_transform: w.transform === "none" ? null : w.transform,
            outcome_domain: w.outcomeDomain,
            confirmation_fraction: .25,
            final_validation_fraction: .15,
            target_column: w.target || null,
          }),
        })
      );
      w.planId = compiled.plan_id || compiled.id || compiled.plan?.plan_id;
      w.technical.planHash = compiled.plan_hash || compiled.plan?.plan_hash;

      const runStarted = await progress(3, "Generating candidates and trying to disprove them…", () =>
        api(`/cases/${encodeURIComponent(w.caseId)}/run`, {
          method: "POST",
          body: JSON.stringify({ plan_id: w.planId, auto_approve: true }),
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
        summary: "This structure beat the strongest simpler alternative and survived Orbita's falsification checks.",
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
    try { detail = DEV_MODE ? null : await api(`/cases/${encodeURIComponent(caseId)}`); } catch (_) {}

    const local  = state.cases.find(c => c.id === caseId);
    const name   = detail?.name   || local?.name   || "Discovery case";
    const goal   = detail?.goal   || local?.goal   || "";
    const status = detail?.status || local?.status || "available";
    const runs   = detail?.runs   || [];
    const lastRun = runs[runs.length - 1];
    const findings       = lastRun?.result?.findings || [];
    const selectedModels = lastRun?.result?.selected_models || {};
    const runId          = lastRun?.id;

    const findingRows = findings.length
      ? findings.map(f => {
          const s     = f.final_status || f.verdict || "unknown";
          const label = f.candidate?.payload?.predictor
            ? `${f.candidate.payload.predictor} → ${f.candidate.payload.outcome || "target"}`
            : f.candidate?.id || f.id || "finding";
          return `<div style="display:flex;gap:12px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--line)">
            <span class="status ${escapeHtml(s)}" style="flex-shrink:0">${escapeHtml(s.replaceAll("_"," "))}</span>
            <span>${escapeHtml(label)}</span>
            <span style="margin-left:auto;color:var(--muted);font-size:13px">${formatScore(f.selection_metric_score)}</span>
          </div>`;
        }).join("")
      : `<p style="color:var(--muted)">No findings yet — run a discovery to see results.</p>`;

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
    loadGraphInto("caseGraphContainer", caseId);
  }

  // ── Graph ─────────────────────────────────────────────────────────────────────
  function graphNodeFill(node) {
    if (node.type === "analysis_run")  return "#1b4332";
    if (node.type === "source")        return "#1565c0";
    if (node.type === "evidence")      return "#6a0dad";
    if (node.type === "reexamination") return "#e65100";
    const s = (node.status || node.public_state || "").toLowerCase();
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
  function formatScore(v) { return Number.isFinite(Number(v))?Number(v).toFixed(3):"—"; }
  function wait(ms) { return new Promise(r=>setTimeout(r,ms)); }

  router();
})();
