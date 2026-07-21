"use strict";

const state = {
  csrf: "",
  user: null,
  operators: [],
  tournaments: [],
  preparedOperatorIds: [],
};

const $ = id => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function notice(message, error = false) {
  const node = $("notice");
  node.textContent = message;
  node.className = error ? "notice error" : "notice";
  node.hidden = false;
  window.clearTimeout(notice.timer);
  notice.timer = window.setTimeout(() => { node.hidden = true; }, 7000);
}

async function api(path, options = {}) {
  const init = { credentials: "same-origin", ...options };
  init.headers = { Accept: "application/json", ...(options.headers || {}) };
  if (init.body && typeof init.body !== "string") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(init.body);
  }
  if (init.method && init.method !== "GET") init.headers["x-csrf-token"] = state.csrf;
  const response = await fetch(path, init);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : { error: await response.text() };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function contractLine(term, value) {
  const row = el("div");
  row.append(el("dt", "", term), el("dd", "", value || "Not declared"));
  return row;
}

function summarizeObject(value) {
  if (!value || typeof value !== "object") return "Not declared";
  return Object.values(value).filter(item => typeof item === "string").join(" · ") || JSON.stringify(value);
}

function renderOperators() {
  const root = $("operators");
  root.replaceChildren();
  const frozen = state.operators.filter(item => item.status === "frozen");
  $("operatorCount").textContent = state.operators.length;
  $("frozenCount").textContent = frozen.length;

  if (!state.operators.length) {
    root.append(el("div", "empty", "No operators yet. Load the seven cross-domain candidates to begin."));
  }

  for (const operator of state.operators) {
    const card = el("article", "operator-card");
    const top = el("div", "operator-top");
    const titleWrap = el("div");
    titleWrap.append(el("h3", "", operator.name), el("p", "", `Version ${operator.version} · ${operator.operator_key}`));
    top.append(titleWrap, el("span", `badge ${operator.status}`, operator.status.replaceAll("_", " ")));

    const description = el("p", "", operator.description || "No description.");
    const dl = el("dl", "contract");
    dl.append(
      contractLine("Kill switch", summarizeObject(operator.contract?.kill_switch)),
      contractLine("Recovery", summarizeObject(operator.contract?.recovery_test)),
      contractLine("Held out", summarizeObject(operator.contract?.held_out_prediction)),
      contractLine("Refuter", summarizeObject(operator.contract?.expected_failure_signature)),
      contractLine("Domains", (operator.contract?.domains_tested || []).join(", "))
    );
    card.append(top, description, dl);

    if (operator.contract_hash) {
      card.append(el("div", "hash", `SHA-256 ${operator.contract_hash}`));
    } else {
      const freeze = el("button", "secondary", "Freeze reviewed version");
      freeze.type = "button";
      freeze.addEventListener("click", () => freezeOperator(operator));
      card.append(freeze);
    }
    root.append(card);
  }
  renderOperatorChoices();
}

function renderOperatorChoices() {
  const root = $("operatorChoices");
  root.replaceChildren();
  const frozen = state.operators.filter(item => item.status === "frozen");
  if (frozen.length < 2) {
    root.append(el("p", "", "Freeze at least two reviewed operators first."));
    return;
  }
  for (const operator of frozen) {
    const label = el("label", "choice");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "tournamentOperator";
    input.value = operator.id;
    label.append(input, el("span", "", `${operator.name} · v${operator.version}`));
    root.append(label);
  }
}

function renderPredictionForms(operatorIds) {
  const root = $("predictionForms");
  root.replaceChildren();
  state.preparedOperatorIds = operatorIds;
  for (const operatorId of operatorIds) {
    const operator = state.operators.find(item => item.id === operatorId);
    const card = el("article", "prediction-card");
    card.dataset.operatorId = operatorId;
    card.append(el("h3", "", operator.name));

    const fields = el("div", "prediction-fields");
    const specs = [
      ["expectedPattern", "Expected pattern", "What should happen on the unseen target?"],
      ["vanishCondition", "Exact vanish condition", "Where should the effect disappear?"],
      ["restorationCondition", "Restoration condition", "How should the effect return?"],
      ["permanentRefuter", "Permanent refuter", "What result would permanently defeat this transfer?"],
      ["claimsAffected", "Claims affected", "Comma-separated claim IDs or short labels weakened by failure."],
    ];
    for (const [key, labelText, placeholder] of specs) {
      const label = el("label", key === "claimsAffected" ? "wide" : "");
      label.append(el("span", "", labelText));
      const textarea = document.createElement("textarea");
      textarea.rows = key === "claimsAffected" ? 2 : 3;
      textarea.placeholder = placeholder;
      textarea.dataset.field = key;
      textarea.required = key !== "claimsAffected";
      label.append(textarea);
      fields.append(label);
    }
    card.append(fields);
    root.append(card);
  }
  $("freezeTournamentButton").disabled = operatorIds.length < 2;
}

function renderTournaments() {
  const root = $("tournaments");
  root.replaceChildren();
  $("tournamentCount").textContent = state.tournaments.length;
  if (!state.tournaments.length) {
    root.append(el("div", "empty", "No tournaments yet. Freeze operators and create the first blind challenge."));
    return;
  }
  for (const tournament of state.tournaments) {
    const row = el("article", "tournament-row");
    const main = el("div");
    main.append(
      el("h3", "", tournament.name),
      el("p", "", `${tournament.target_json?.domain || "Unspecified domain"} · ${tournament.entry_count} operator entries · ${tournament.evaluated_count} evaluated`)
    );
    if (tournament.manifest_hash) main.append(el("div", "hash", `Manifest ${tournament.manifest_hash}`));
    const meta = el("div", "tournament-meta");
    meta.append(el("span", `badge ${tournament.status}`, tournament.status));
    row.append(main, meta);
    root.append(row);
  }
}

async function loadAll() {
  const me = await api("/auth/me");
  state.user = me;
  state.csrf = me.csrf_token;
  $("userLabel").textContent = me.username;
  const [operators, tournaments] = await Promise.all([
    api("/api/discovery-genome/operators"),
    api("/api/discovery-genome/tournaments"),
  ]);
  state.operators = operators.operators || [];
  state.tournaments = tournaments.tournaments || [];
  renderOperators();
  renderTournaments();
}

async function seedOperators() {
  const button = $("seedButton");
  button.disabled = true;
  try {
    const result = await api("/api/discovery-genome/operators/seed", { method: "POST", body: {} });
    notice(result.created.length
      ? `Loaded ${result.created.length} review-needed operators.`
      : "The seven operator families are already present.");
    await loadAll();
  } catch (err) {
    notice(err.message, true);
  } finally {
    button.disabled = false;
  }
}

async function freezeOperator(operator) {
  const accepted = window.confirm(
    `Freeze ${operator.name} version ${operator.version}? Its executable contract cannot be edited after freezing.`
  );
  if (!accepted) return;
  try {
    const result = await api(`/api/discovery-genome/operators/${encodeURIComponent(operator.id)}/freeze`, {
      method: "POST",
      body: {},
    });
    notice(`${result.operator.name} frozen with receipt ${result.operator.contract_hash.slice(0, 12)}…`);
    await loadAll();
  } catch (err) {
    notice(err.message, true);
  }
}

function selectedOperatorIds() {
  return [...document.querySelectorAll('input[name="tournamentOperator"]:checked')].map(input => input.value);
}

function preparePredictions() {
  const ids = selectedOperatorIds();
  if (ids.length < 2) {
    notice("Select at least two frozen operators.", true);
    return;
  }
  renderPredictionForms(ids);
  $("predictionForms").scrollIntoView({ behavior: "smooth", block: "start" });
}

function predictionFromCard(card, target) {
  const read = field => card.querySelector(`[data-field="${field}"]`).value.trim();
  const required = ["expectedPattern", "vanishCondition", "restorationCondition", "permanentRefuter"];
  for (const field of required) {
    if (!read(field)) throw new Error("Complete every prediction and refutation field before freezing.");
  }
  return {
    target,
    expected_pattern: read("expectedPattern"),
    vanish_condition: read("vanishCondition"),
    restoration_condition: read("restorationCondition"),
    permanent_refuter: read("permanentRefuter"),
    claims_affected: read("claimsAffected").split(",").map(value => value.trim()).filter(Boolean),
  };
}

async function createFrozenTournament(event) {
  event.preventDefault();
  if (state.preparedOperatorIds.length < 2) {
    notice("Prepare predictions for at least two frozen operators.", true);
    return;
  }
  const button = $("freezeTournamentButton");
  button.disabled = true;
  try {
    const target = {
      domain: $("targetDomain").value.trim(),
      description: $("targetDescription").value.trim(),
      answer_visibility: "hidden_until_confirmation",
    };
    if (!target.domain || !target.description) throw new Error("Challenge domain and hidden target are required.");

    const cards = [...document.querySelectorAll(".prediction-card")];
    const prepared = cards.map(card => ({
      operator_id: card.dataset.operatorId,
      prediction: predictionFromCard(card, target.description),
    }));

    const created = await api("/api/discovery-genome/tournaments", {
      method: "POST",
      body: { name: $("tournamentName").value.trim(), target },
    });
    const tournamentId = created.tournament.id;
    for (const entry of prepared) {
      await api(`/api/discovery-genome/tournaments/${encodeURIComponent(tournamentId)}/entries`, {
        method: "POST",
        body: entry,
      });
    }
    const frozen = await api(`/api/discovery-genome/tournaments/${encodeURIComponent(tournamentId)}/freeze`, {
      method: "POST",
      body: {},
    });
    notice(`Tournament frozen. Manifest ${frozen.tournament.manifest_hash.slice(0, 16)}…`);
    renderPredictionForms([]);
    document.querySelectorAll('input[name="tournamentOperator"]').forEach(input => { input.checked = false; });
    await loadAll();
  } catch (err) {
    notice(err.message, true);
  } finally {
    button.disabled = state.preparedOperatorIds.length < 2;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  $("seedButton").addEventListener("click", seedOperators);
  $("prepareButton").addEventListener("click", preparePredictions);
  $("tournamentForm").addEventListener("submit", createFrozenTournament);
  try {
    await loadAll();
  } catch (err) {
    notice(err.message, true);
    if (/session|login|unauth/i.test(err.message)) window.location.href = "/login";
  }
});
