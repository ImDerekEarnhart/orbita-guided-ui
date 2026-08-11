"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const db = require("../lib/db");
const { createOrbitaBackend } = require("../lib/orbitaBackend");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function coreJson(backend, userId, apiPath) {
  const response = await fetch(backend.url(apiPath), { headers: backend.headers(userId) });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { error: `non_json_http_${response.status}` }; }
  if (!response.ok) throw new Error(`core_http_${response.status}`);
  return body;
}

async function downloadLegacyFile(backend, legacyCaseId, file) {
  const response = await fetch(
    backend.legacyUrl(
      `/internal/migration/cases/${encodeURIComponent(legacyCaseId)}/files/${encodeURIComponent(file.id)}`,
    ),
    { headers: backend.migrationHeaders() },
  );
  if (!response.ok) throw new Error(`legacy_file_http_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  const announced = response.headers.get("x-orbita-content-sha256") || "";
  if (actual !== file.sha256 || announced !== file.sha256) throw new Error("legacy_file_hash_mismatch");
  if (file.size_bytes != null && bytes.length !== Number(file.size_bytes)) throw new Error("legacy_file_size_mismatch");
  return bytes;
}

async function uploadCoreFile(backend, userId, coreCaseId, file, bytes) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: file.media_type || "application/octet-stream" }),
    file.original_name,
  );
  const response = await fetch(backend.url(`/cases/${encodeURIComponent(coreCaseId)}/files`), {
    method: "POST",
    headers: backend.headers(userId),
    body: form,
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = {}; }
  if (!response.ok) throw new Error(`core_upload_http_${response.status}`);
  if (body.sha256 !== file.sha256) throw new Error("core_upload_hash_mismatch");
  return body;
}

function validateFileRecord(file) {
  if (!file || !file.id || !file.original_name || !/^[a-f0-9]{64}$/.test(String(file.sha256 || ""))) {
    throw new Error("invalid_manifest_file_record");
  }
  const extension = path.extname(file.original_name).toLowerCase();
  if (![".csv", ".tsv"].includes(extension)) throw new Error(`unsupported_evidence_type_${extension || "none"}`);
}

function coreFilename(originalName) {
  const name = path.basename(String(originalName));
  let cleaned = Array.from(name)
    .filter(character => /[\p{L}\p{N}._-]/u.test(character))
    .join("")
    .replace(/^[._]+|[._]+$/g, "");
  if (!cleaned) throw new Error("invalid_core_filename");
  if (Array.from(cleaned).length > 120) {
    const extension = path.extname(cleaned).slice(0, 16);
    const stem = cleaned.slice(0, cleaned.length - path.extname(cleaned).length);
    cleaned = Array.from(stem).slice(0, 100).join("") + extension;
  }
  return cleaned;
}

function matchingFile(files, expected) {
  return files.find(item => item.original_name === coreFilename(expected.original_name) && item.sha256 === expected.sha256);
}

async function main() {
  const backend = createOrbitaBackend();
  if (backend.mode !== "unified" || !backend.legacyConfigured || !backend.migrationConfigured) {
    throw new Error("Unified core, legacy backend, and migration token must be configured.");
  }
  const requestedLimit = Number(process.argv.find(arg => arg.startsWith("--limit="))?.split("=")[1] || 0);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 10000;
  const runId = crypto.randomUUID();
  await db.query(
    "INSERT INTO unified_migration_runs (id, mode, status) VALUES ($1, 'copy', 'running')",
    [runId],
  );
  const { rows } = await db.query(
    `SELECT legacy_case_id, core_case_id, user_id, manifest_hash, manifest_json
     FROM unified_case_migrations
     WHERE status='manifest_verified' AND core_case_id IS NOT NULL
     ORDER BY legacy_case_id LIMIT $1`,
    [limit],
  );
  const summary = {
    selected: rows.length,
    verified: 0,
    failed: 0,
    copied_files: 0,
    already_present: 0,
    failures: [],
  };
  const receipts = [];
  try {
    for (const row of rows) {
      try {
        const manifest = typeof row.manifest_json === "string" ? JSON.parse(row.manifest_json) : row.manifest_json;
        const expectedFiles = manifest.files || [];
        expectedFiles.forEach(validateFileRecord);
        let coreCase = await coreJson(backend, row.user_id, `/cases/${encodeURIComponent(row.core_case_id)}`);
        for (const file of expectedFiles) {
          if (matchingFile(coreCase.files || [], file)) {
            summary.already_present += 1;
            continue;
          }
          if ((coreCase.files || []).some(item => item.original_name === coreFilename(file.original_name))) {
            throw new Error("core_filename_conflict");
          }
          const bytes = await downloadLegacyFile(backend, row.legacy_case_id, file);
          await uploadCoreFile(backend, row.user_id, row.core_case_id, file, bytes);
          summary.copied_files += 1;
          coreCase = await coreJson(backend, row.user_id, `/cases/${encodeURIComponent(row.core_case_id)}`);
        }
        const missing = expectedFiles.filter(file => !matchingFile(coreCase.files || [], file));
        if (missing.length) throw new Error("core_evidence_verification_failed");
        const evidenceReceipt = expectedFiles.map(file => ({
          file_id: file.id,
          source_original_name: file.original_name,
          core_original_name: coreFilename(file.original_name),
          sha256: file.sha256,
          size_bytes: file.size_bytes,
        }));
        const receiptHash = sha256(Buffer.from(JSON.stringify(evidenceReceipt), "utf8"));
        await db.query(
          `UPDATE unified_case_migrations SET status='verified', error_code=NULL, updated_at=NOW()
           WHERE legacy_case_id=$1`,
          [row.legacy_case_id],
        );
        receipts.push({ legacy_case_id: row.legacy_case_id, manifest_hash: row.manifest_hash, evidence_hash: receiptHash });
        summary.verified += 1;
      } catch (err) {
        const errorCode = String(err.message || "evidence_copy_failed").slice(0, 120);
        await db.query(
          `UPDATE unified_case_migrations SET status='manifest_verified', error_code=$1, updated_at=NOW()
           WHERE legacy_case_id=$2`,
          [errorCode, row.legacy_case_id],
        );
        summary.failed += 1;
        summary.failures.push({ legacy_case_id: row.legacy_case_id, error_code: errorCode });
      }
    }
    const receiptHash = sha256(Buffer.from(JSON.stringify(receipts), "utf8"));
    await db.query(
      `UPDATE unified_migration_runs SET status='completed', manifest_hash=$1, summary_json=$2,
       completed_at=NOW() WHERE id=$3`,
      [receiptHash, JSON.stringify(summary), runId],
    );
    console.log(JSON.stringify({ ...summary, receipt_hash: receiptHash }));
  } catch (err) {
    await db.query(
      "UPDATE unified_migration_runs SET status='failed', summary_json=$1, completed_at=NOW() WHERE id=$2",
      [JSON.stringify(summary), runId],
    );
    throw err;
  } finally {
    await db.end();
  }
}

main().catch(async err => {
  console.error(`Unified evidence copy failed: ${String(err.message || err).slice(0, 200)}`);
  await db.end().catch(() => {});
  process.exit(1);
});
