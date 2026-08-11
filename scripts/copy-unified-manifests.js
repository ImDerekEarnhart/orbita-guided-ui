"use strict";

const crypto = require("node:crypto");
const db = require("../lib/db");
const { createOrbitaBackend } = require("../lib/orbitaBackend");

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function fetchReport(backend, legacyCaseId, role) {
  const response = await fetch(
    backend.legacyUrl(`/cases/${encodeURIComponent(legacyCaseId)}/download/${role}`),
    { headers: backend.legacyHeaders() },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`legacy_${role}_http_${response.status}`);
  const content = await response.text();
  return {
    filename: role === "markdown" ? "legacy_research_dossier.md" : "legacy_research_dossier.json",
    content,
    sha256: sha256(content),
  };
}

async function coreJson(backend, userId, path, { method = "GET", body } = {}) {
  const response = await fetch(backend.url(path), {
    method,
    headers: backend.headers(userId, body ? { "content-type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch (_) { parsed = { error: `non_json_http_${response.status}` }; }
  return { ok: response.ok, status: response.status, body: parsed };
}

async function deleteCoreCase(backend, userId, caseId) {
  return coreJson(backend, userId, `/cases/${encodeURIComponent(caseId)}`, {
    method: "DELETE",
    body: { confirmation: backend.deletionPhrase },
  });
}

async function main() {
  const backend = createOrbitaBackend();
  if (backend.mode !== "unified" || !backend.legacyConfigured) {
    throw new Error("Unified and legacy backends must both be configured.");
  }
  const requestedLimit = Number(process.argv.find(arg => arg.startsWith("--limit="))?.split("=")[1] || 0);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 10000;
  const { rows } = await db.query(
    `SELECT legacy_case_id, user_id, manifest_hash, manifest_json
     FROM unified_case_migrations
     WHERE status='inventoried' AND core_case_id IS NULL
     ORDER BY legacy_case_id LIMIT $1`,
    [limit],
  );
  const summary = { selected: rows.length, verified: 0, failed: 0, reports: 0 };
  for (const row of rows) {
    let coreCaseId = null;
    try {
      await db.query(
        "UPDATE unified_case_migrations SET status='copying', error_code=NULL, updated_at=NOW() WHERE legacy_case_id=$1",
        [row.legacy_case_id],
      );
      const manifest = typeof row.manifest_json === "string" ? JSON.parse(row.manifest_json) : row.manifest_json;
      const reports = (await Promise.all([
        fetchReport(backend, row.legacy_case_id, "markdown"),
        fetchReport(backend, row.legacy_case_id, "json"),
      ])).filter(Boolean);
      const created = await coreJson(backend, row.user_id, "/cases", {
        method: "POST",
        body: {
          name: `[Inherited] ${manifest.case?.name || row.legacy_case_id}`,
          goal: `Immutable inherited Guided case. No rerun or reinterpretation.\n\n${manifest.case?.goal || ""}`,
          domain_hint: manifest.case?.domain_hint || "inherited-guided-case",
        },
      });
      if (!created.ok || !(created.body.case_id || created.body.id)) {
        throw new Error(`core_create_http_${created.status}`);
      }
      coreCaseId = created.body.case_id || created.body.id;
      const inherited = await coreJson(backend, row.user_id, `/cases/${encodeURIComponent(coreCaseId)}/inherit`, {
        method: "POST",
        body: {
          manifest,
          expected_manifest_hash: row.manifest_hash,
          artifacts: reports,
        },
      });
      if (!inherited.ok || inherited.body.semantic_manifest_hash !== row.manifest_hash || inherited.body.execution_performed !== false) {
        throw new Error(`core_inherit_http_${inherited.status}`);
      }
      await db.query(
        `UPDATE unified_case_migrations SET core_case_id=$1, status='manifest_verified',
         error_code=NULL, updated_at=NOW() WHERE legacy_case_id=$2`,
        [coreCaseId, row.legacy_case_id],
      );
      summary.verified += 1;
      summary.reports += reports.length;
    } catch (err) {
      if (coreCaseId) await deleteCoreCase(backend, row.user_id, coreCaseId).catch(() => {});
      await db.query(
        `UPDATE unified_case_migrations SET core_case_id=NULL, status='failed', error_code=$1,
         updated_at=NOW() WHERE legacy_case_id=$2`,
        [String(err.message || "manifest_copy_failed").slice(0, 120), row.legacy_case_id],
      );
      summary.failed += 1;
    }
  }
  console.log(JSON.stringify(summary));
  await db.end();
}

main().catch(async err => {
  console.error(`Unified manifest copy failed: ${String(err.message || err).slice(0, 200)}`);
  await db.end().catch(() => {});
  process.exit(1);
});
