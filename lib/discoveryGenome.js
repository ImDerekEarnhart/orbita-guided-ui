"use strict";

const crypto = require("node:crypto");
const db = require("./db");

const OPERATOR_STATUSES = new Set(["draft", "review_needed", "frozen", "retired"]);
const VERDICTS = new Set(["survived", "refuted", "inconclusive"]);
const INDEPENDENCE_LEVELS = new Set(["same_case", "same_family", "cross_domain", "external"]);
const HOLE_CLASSIFICATIONS = new Set(["HOLE", "NO_HOLE"]);
const PREDICTION_BUNDLE_SCHEMA = "orbita.discovery-tournament-prediction-bundle.v1";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hashJson(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function requireHash(value, field) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} must be a SHA-256 hash`);
  }
  return value;
}

function requireHashMatch(expected, actual, label) {
  requireHash(expected, "expected_review_hash");
  const matches = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  if (!matches) throw new Error(`${label} review hash mismatch`);
}

function buildTournamentResultReceipt({ tournamentId, entryId, verdict, result }) {
  return canonicalize({
    schema: "orbita.discovery-tournament-result.v1",
    tournament_id: tournamentId,
    entry_id: entryId,
    verdict,
    result,
  });
}

function nonEmptyString(value, field, max = 4000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  if (value.length > max) throw new Error(`${field} is too long`);
  return value.trim();
}

function stringArray(value, field) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be an array of nonblank strings`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

function validateOperatorContract(input) {
  const contract = canonicalize(input || {});
  const required = [
    "required_conditions",
    "intervention",
    "kill_switch",
    "recovery_test",
    "held_out_prediction",
    "expected_failure_signature",
    "domains_tested",
    "independence_level",
    "claims_affected",
  ];
  for (const field of required) {
    if (!(field in contract)) throw new Error(`contract.${field} is required`);
  }
  contract.required_conditions = stringArray(contract.required_conditions, "contract.required_conditions");
  contract.domains_tested = stringArray(contract.domains_tested, "contract.domains_tested");
  contract.claims_affected = stringArray(contract.claims_affected, "contract.claims_affected");
  if (!INDEPENDENCE_LEVELS.has(contract.independence_level)) {
    throw new Error("contract.independence_level is invalid");
  }
  for (const field of ["intervention", "kill_switch", "recovery_test", "held_out_prediction", "expected_failure_signature"]) {
    if (!contract[field] || typeof contract[field] !== "object" || Array.isArray(contract[field])) {
      throw new Error(`contract.${field} must be an object`);
    }
  }
  return contract;
}

function validatePrediction(input) {
  const prediction = canonicalize(input || {});
  const required = [
    "target",
    "expected_pattern",
    "vanish_condition",
    "restoration_condition",
    "permanent_refuter",
    "claims_affected",
  ];
  for (const field of required) {
    if (!(field in prediction)) throw new Error(`prediction.${field} is required`);
  }
  for (const field of ["target", "expected_pattern", "vanish_condition", "restoration_condition", "permanent_refuter"]) {
    prediction[field] = nonEmptyString(prediction[field], `prediction.${field}`);
  }
  prediction.claims_affected = stringArray(prediction.claims_affected, "prediction.claims_affected");
  return prediction;
}

function validateWorldPredictionBundle(input, target) {
  const prediction = canonicalize(input || {});
  if (prediction.schema && prediction.schema !== PREDICTION_BUNDLE_SCHEMA) {
    throw new Error(`prediction.schema must equal ${PREDICTION_BUNDLE_SCHEMA}`);
  }
  if (!Array.isArray(prediction.world_predictions) || !prediction.world_predictions.length) {
    throw new Error("prediction.world_predictions must be a nonempty array");
  }
  const targetWorlds = Array.isArray(target?.worlds) ? target.worlds : [];
  if (!targetWorlds.length) {
    throw new Error("tournament target does not declare worlds for a prediction bundle");
  }
  const targetIds = targetWorlds.map(world => nonEmptyString(world?.world_id, "target.world_id", 160));
  if (new Set(targetIds).size !== targetIds.length) {
    throw new Error("tournament target world identifiers must be unique");
  }

  const seen = new Set();
  const worldPredictions = prediction.world_predictions.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`prediction.world_predictions[${index}] must be an object`);
    }
    const worldId = nonEmptyString(raw.world_id, `prediction.world_predictions[${index}].world_id`, 160);
    if (seen.has(worldId)) throw new Error(`prediction world_id ${worldId} is duplicated`);
    seen.add(worldId);
    const classification = nonEmptyString(
      raw.classification ?? raw.hole_classification,
      `prediction.world_predictions[${index}].classification`,
      40
    ).toUpperCase();
    if (!HOLE_CLASSIFICATIONS.has(classification)) {
      throw new Error(`prediction.world_predictions[${index}].classification must be HOLE or NO_HOLE`);
    }
    const confidence = raw.confidence;
    if (confidence !== undefined &&
        (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new Error(`prediction.world_predictions[${index}].confidence must be between 0 and 1`);
    }
    return {
      world_id: worldId,
      classification,
      factorization_claim: nonEmptyString(
        raw.factorization_claim,
        `prediction.world_predictions[${index}].factorization_claim`
      ),
      candidate_recovery_primitive: nonEmptyString(
        raw.candidate_recovery_primitive ?? raw.recovery_primitive,
        `prediction.world_predictions[${index}].candidate_recovery_primitive`
      ),
      permanent_refuter: nonEmptyString(
        raw.permanent_refuter ?? raw.kill_switch,
        `prediction.world_predictions[${index}].permanent_refuter`
      ),
      scope_boundary: nonEmptyString(
        raw.scope_boundary,
        `prediction.world_predictions[${index}].scope_boundary`
      ),
      ...(confidence === undefined ? {} : { confidence }),
    };
  });
  const missing = targetIds.filter(id => !seen.has(id));
  const extra = [...seen].filter(id => !targetIds.includes(id));
  if (missing.length || extra.length) {
    throw new Error(
      `prediction world coverage must exactly match the tournament target; missing=${missing.join(",") || "none"}; ` +
      `extra=${extra.join(",") || "none"}`
    );
  }
  worldPredictions.sort((a, b) => targetIds.indexOf(a.world_id) - targetIds.indexOf(b.world_id));
  return canonicalize({
    schema: PREDICTION_BUNDLE_SCHEMA,
    world_predictions: worldPredictions,
    claims_affected: stringArray(prediction.claims_affected || [], "prediction.claims_affected"),
  });
}

function validatePredictionForTournament(input, target) {
  if (input && Array.isArray(input.world_predictions)) {
    return validateWorldPredictionBundle(input, target);
  }
  return validatePrediction(input);
}

function classifyTournamentEntryError(err) {
  const detail = String(err?.message || err || "");
  if (err?.code === "23505") {
    return { status: 409, code: "duplicate_operator_entry", error: "This operator is already attached to the tournament." };
  }
  if (/^prediction\.|prediction world|tournament target|target\.world_id/i.test(detail)) {
    return { status: 422, code: "invalid_prediction", error: detail.slice(0, 300) };
  }
  if (/not found/i.test(detail)) {
    return { status: 404, code: "attachment_target_not_found", error: "Draft tournament or frozen operator not found." };
  }
  return { status: 409, code: "attachment_conflict", error: "The operator cannot be attached in the tournament's current state." };
}

function buildTournamentManifest({ tournament, entries }) {
  return canonicalize({
    schema: "orbita.discovery-tournament.v1",
    tournament_id: tournament.id,
    name: tournament.name,
    target: tournament.target_json,
    entries: entries
      .map(entry => ({
        entry_id: entry.id,
        operator_id: entry.operator_id,
        operator_key: entry.operator_key,
        operator_version: entry.operator_version,
        operator_contract_hash: entry.contract_hash,
        prediction_hash: entry.prediction_hash,
        prediction: entry.prediction_json,
      }))
      .sort((a, b) => a.operator_id.localeCompare(b.operator_id)),
  });
}

function rowOperator(row) {
  return {
    id: row.id,
    operator_key: row.operator_key,
    version: row.version,
    name: row.name,
    description: row.description,
    status: row.status,
    source_graph_id: row.source_graph_id,
    source_operator_id: row.source_operator_id,
    contract: row.contract_json,
    evidence: row.evidence_json,
    contract_hash: row.contract_hash,
    review_hash: hashJson(row.contract_json),
    frozen_at: row.frozen_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listOperators(userId) {
  const { rows } = await db.query(
    `SELECT * FROM discovery_operators
     WHERE user_id = $1
     ORDER BY operator_key, version DESC`,
    [userId]
  );
  return rows.map(rowOperator);
}

async function createOperator(userId, input) {
  const operatorKey = nonEmptyString(input?.operator_key, "operator_key", 120)
    .toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!operatorKey) throw new Error("operator_key must contain letters or numbers");
  const name = nonEmptyString(input?.name, "name", 200);
  const description = typeof input?.description === "string" ? input.description.trim().slice(0, 4000) : null;
  const contract = validateOperatorContract(input?.contract);
  const status = input?.status || "draft";
  if (!OPERATOR_STATUSES.has(status) || !["draft", "review_needed"].includes(status)) {
    throw new Error("new operators must be draft or review_needed");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: versionRows } = await client.query(
      `SELECT COALESCE(MAX(version), 0)::int + 1 AS version
       FROM discovery_operators WHERE user_id = $1 AND operator_key = $2`,
      [userId, operatorKey]
    );
    const { rows } = await client.query(
      `INSERT INTO discovery_operators
         (user_id, operator_key, version, name, description, status,
          source_graph_id, source_operator_id, contract_json, evidence_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        userId,
        operatorKey,
        versionRows[0].version,
        name,
        description,
        status,
        input?.source_graph_id || null,
        input?.source_operator_id || null,
        JSON.stringify(contract),
        JSON.stringify(input?.evidence || {}),
      ]
    );
    await client.query("COMMIT");
    return rowOperator(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function freezeOperator(userId, operatorId, expectedReviewHash) {
  requireHash(expectedReviewHash, "expected_review_hash");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM discovery_operators
       WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [operatorId, userId]
    );
    if (!rows.length) throw new Error("Operator not found");
    const current = rows[0];
    const contract = validateOperatorContract(current.contract_json);
    const currentReviewHash = hashJson(contract);
    requireHashMatch(expectedReviewHash, currentReviewHash, "Operator");
    if (current.status === "frozen") {
      await client.query("COMMIT");
      return rowOperator(current);
    }
    if (!["draft", "review_needed"].includes(current.status)) {
      throw new Error("Only draft or review-needed operators can be frozen");
    }
    const { rows: updated } = await client.query(
      `UPDATE discovery_operators
       SET status = 'frozen', contract_json = $1, contract_hash = $2,
           frozen_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND user_id = $4
       RETURNING *`,
      [JSON.stringify(contract), currentReviewHash, operatorId, userId]
    );
    await client.query("COMMIT");
    return rowOperator(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function addOperatorEvidence(userId, operatorId, input) {
  const domain = nonEmptyString(input?.domain, "domain", 160);
  const caseId = nonEmptyString(input?.case_id, "case_id", 200);
  const outcome = input?.outcome;
  const independence = input?.independence_level;
  if (!["supported", "refuted", "inconclusive", "artifact"].includes(outcome)) {
    throw new Error("outcome is invalid");
  }
  if (!INDEPENDENCE_LEVELS.has(independence)) throw new Error("independence_level is invalid");
  const { rows } = await db.query(
    `INSERT INTO discovery_operator_evidence
       (user_id, operator_id, case_id, domain, outcome, independence_level, evidence_json, receipt_hash)
     SELECT $1, id, $3, $4, $5, $6, $7, $8
     FROM discovery_operators
     WHERE id = $2 AND user_id = $1
     RETURNING *`,
    [
      userId,
      operatorId,
      caseId,
      domain,
      outcome,
      independence,
      JSON.stringify(input?.evidence || {}),
      input?.receipt_hash || null,
    ]
  );
  if (!rows.length) throw new Error("Operator not found");
  return rows[0];
}

async function listTournaments(userId) {
  const { rows } = await db.query(
    `SELECT t.*,
            COUNT(e.id)::int AS entry_count,
            COUNT(e.id) FILTER (WHERE e.verdict <> 'pending')::int AS evaluated_count
     FROM discovery_tournaments t
     LEFT JOIN discovery_tournament_entries e ON e.tournament_id = t.id
     WHERE t.user_id = $1
     GROUP BY t.id
     ORDER BY t.created_at DESC`,
    [userId]
  );
  return rows;
}

async function createTournament(userId, input) {
  const name = nonEmptyString(input?.name, "name", 200);
  if (!input?.target || typeof input.target !== "object" || Array.isArray(input.target)) {
    throw new Error("target must be an object");
  }
  const { rows } = await db.query(
    `INSERT INTO discovery_tournaments (user_id, name, target_json)
     VALUES ($1, $2, $3) RETURNING *`,
    [userId, name, JSON.stringify(canonicalize(input.target))]
  );
  return rows[0];
}

async function addTournamentEntry(userId, tournamentId, input) {
  const { rows: contexts } = await db.query(
    `SELECT t.target_json
     FROM discovery_tournaments t
     JOIN discovery_operators o ON o.id = $3 AND o.user_id = t.user_id
     WHERE t.id = $1 AND t.user_id = $2 AND t.status = 'draft' AND o.status = 'frozen'`,
    [tournamentId, userId, input?.operator_id]
  );
  if (!contexts.length) throw new Error("Draft tournament or frozen operator not found");
  const prediction = validatePredictionForTournament(input?.prediction, contexts[0].target_json);
  const predictionHash = hashJson(prediction);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: tournaments } = await client.query(
      `SELECT id FROM discovery_tournaments
       WHERE id = $1 AND user_id = $2 AND status = 'draft' FOR UPDATE`,
      [tournamentId, userId]
    );
    if (!tournaments.length) throw new Error("Draft tournament not found");
    const { rows } = await client.query(
      `INSERT INTO discovery_tournament_entries
         (tournament_id, operator_id, prediction_json, prediction_hash, claims_affected)
       SELECT $1, o.id, $4, $5, $6
       FROM discovery_operators o
       WHERE o.id = $3 AND o.user_id = $2 AND o.status = 'frozen'
       RETURNING *`,
      [tournamentId, userId, input?.operator_id, JSON.stringify(prediction), predictionHash, prediction.claims_affected]
    );
    if (!rows.length) throw new Error("Frozen operator not found");
    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function freezeTournament(userId, tournamentId, expectedReviewHash) {
  requireHash(expectedReviewHash, "expected_review_hash");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: tournaments } = await client.query(
      `SELECT * FROM discovery_tournaments
       WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [tournamentId, userId]
    );
    if (!tournaments.length) throw new Error("Tournament not found");
    const tournament = tournaments[0];
    if (tournament.status === "frozen") {
      requireHashMatch(expectedReviewHash, tournament.manifest_hash, "Tournament");
      await client.query("COMMIT");
      return tournament;
    }
    if (tournament.status !== "draft") throw new Error("Only a draft tournament can be frozen");
    const { rows: entries } = await client.query(
      `SELECT e.*, o.operator_key, o.version AS operator_version, o.contract_hash
       FROM discovery_tournament_entries e
       JOIN discovery_operators o ON o.id = e.operator_id
       WHERE e.tournament_id = $1
       ORDER BY e.operator_id`,
      [tournamentId]
    );
    if (entries.length < 2) throw new Error("A tournament requires at least two frozen operator entries");
    if (entries.some(entry => !entry.contract_hash)) throw new Error("Every tournament operator must be frozen");
    const manifest = buildTournamentManifest({ tournament, entries });
    const manifestHash = hashJson(manifest);
    requireHashMatch(expectedReviewHash, manifestHash, "Tournament");
    const { rows: updated } = await client.query(
      `UPDATE discovery_tournaments
       SET status = 'frozen', manifest_json = $1, manifest_hash = $2,
           frozen_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND user_id = $4
       RETURNING *`,
      [JSON.stringify(manifest), manifestHash, tournamentId, userId]
    );
    await client.query("COMMIT");
    return updated[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getTournament(userId, tournamentId) {
  const { rows: tournaments } = await db.query(
    `SELECT * FROM discovery_tournaments WHERE id = $1 AND user_id = $2`,
    [tournamentId, userId]
  );
  if (!tournaments.length) throw new Error("Tournament not found");
  const { rows: entries } = await db.query(
    `SELECT e.*, o.operator_key, o.version AS operator_version, o.name AS operator_name,
            o.contract_hash
     FROM discovery_tournament_entries e
     JOIN discovery_operators o ON o.id = e.operator_id
     WHERE e.tournament_id = $1
     ORDER BY o.name, o.version`,
    [tournamentId]
  );
  const reviewManifest = buildTournamentManifest({ tournament: tournaments[0], entries });
  return {
    ...tournaments[0],
    entries,
    review_manifest: reviewManifest,
    review_hash: hashJson(reviewManifest),
  };
}

async function recordTournamentResult(userId, tournamentId, entryId, input) {
  if (!VERDICTS.has(input?.verdict)) throw new Error("verdict is invalid");
  if (!input?.result || typeof input.result !== "object" || Array.isArray(input.result)) {
    throw new Error("result must be an object");
  }
  const expectedResultHash = requireHash(input?.expected_result_hash, "expected_result_hash");
  const normalizedResult = canonicalize(input.result);
  const receipt = buildTournamentResultReceipt({
    tournamentId,
    entryId,
    verdict: input.verdict,
    result: normalizedResult,
  });
  const resultHash = hashJson(receipt);
  requireHashMatch(expectedResultHash, resultHash, "Tournament result");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: currentRows } = await client.query(
      `SELECT e.*, t.status AS tournament_status
       FROM discovery_tournament_entries e
       JOIN discovery_tournaments t ON t.id = e.tournament_id
       WHERE e.id = $1 AND e.tournament_id = $2 AND t.user_id = $3
       FOR UPDATE OF e, t`,
      [entryId, tournamentId, userId]
    );
    if (!currentRows.length) throw new Error("Tournament entry not found");
    const current = currentRows[0];
    if (!["frozen", "running"].includes(current.tournament_status) || current.verdict !== "pending") {
      throw new Error("Pending frozen tournament entry not found");
    }
    const { rows } = await client.query(
      `UPDATE discovery_tournament_entries
       SET verdict = $1, result_json = $2, result_hash = $3, evaluated_at = NOW()
       WHERE id = $4 AND tournament_id = $5 AND verdict = 'pending'
       RETURNING *`,
      [input.verdict, JSON.stringify(normalizedResult), resultHash, entryId, tournamentId]
    );
    if (!rows.length) throw new Error("Pending frozen tournament entry not found");
    await client.query(
      `UPDATE discovery_tournaments t
       SET status = CASE
             WHEN EXISTS (
               SELECT 1 FROM discovery_tournament_entries e
               WHERE e.tournament_id = t.id AND e.verdict = 'pending'
             ) THEN 'running' ELSE 'completed' END,
           revealed_at = COALESCE(revealed_at, NOW()),
           updated_at = NOW()
       WHERE t.id = $1 AND t.user_id = $2`,
      [tournamentId, userId]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  addOperatorEvidence,
  addTournamentEntry,
  buildTournamentManifest,
  buildTournamentResultReceipt,
  canonicalJson,
  createOperator,
  createTournament,
  freezeOperator,
  freezeTournament,
  getTournament,
  hashJson,
  listOperators,
  listTournaments,
  recordTournamentResult,
  validateOperatorContract,
  validatePrediction,
  validatePredictionForTournament,
  validateWorldPredictionBundle,
  classifyTournamentEntryError,
  PREDICTION_BUNDLE_SCHEMA,
};
