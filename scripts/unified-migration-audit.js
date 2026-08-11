"use strict";

const crypto = require("node:crypto");
const db = require("../lib/db");
const { createOrbitaBackend } = require("../lib/orbitaBackend");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function publicFile(file) {
  return {
    id: file.id || file.file_id || null,
    original_name: file.original_name || file.filename || null,
    media_type: file.media_type || null,
    size_bytes: file.size_bytes ?? null,
    sha256: file.sha256 || file.content_hash || null,
    parse_status: file.parse_status || null,
    artifact_kind: file.artifact_kind || null,
  };
}

function publicPlan(plan) {
  return {
    id: plan.id || plan.plan_id || null,
    plan_hash: plan.plan_hash || null,
    status: plan.status || null,
    compiler: plan.compiler || null,
  };
}

function publicRun(run) {
  const reports = run?.result?.reports || {};
  return {
    id: run.id || run.run_id || null,
    status: run.status || null,
    plan_id: run.plan_id || null,
    reports: Object.fromEntries(Object.entries(reports).map(([role, item]) => [role, {
      sha256: item?.sha256 || item?.content_hash || null,
      size_bytes: item?.size_bytes ?? null,
    }])),
  };
}

async function legacyJson(backend, path) {
  const response = await fetch(backend.legacyUrl(path), { headers: backend.legacyHeaders() });
  if (response.status === 404) return { status: 404, body: null };
  if (!response.ok) throw new Error(`legacy_http_${response.status}`);
  return { status: response.status, body: await response.json() };
}

async function main() {
  const backend = createOrbitaBackend();
  if (!backend.legacyConfigured) throw new Error("Legacy backend is not configured.");
  const runId = crypto.randomUUID();
  await db.query(
    "INSERT INTO unified_migration_runs (id, mode, status) VALUES ($1, 'audit', 'running')",
    [runId],
  );
  const { rows: cases } = await db.query(
    "SELECT user_id, orbita_case_id FROM orbita_cases ORDER BY created_at, orbita_case_id",
  );
  const summary = { total: cases.length, inventoried: 0, missing_legacy: 0, failed: 0, files: 0, plans: 0, runs: 0, claims: 0 };
  const receipts = [];
  try {
    for (const item of cases) {
      try {
        const casePath = `/cases/${encodeURIComponent(item.orbita_case_id)}`;
        const detail = await legacyJson(backend, casePath);
        if (detail.status === 404) {
          await db.query(
            `INSERT INTO unified_case_migrations
             (legacy_case_id, user_id, status, manifest_json, error_code)
             VALUES ($1, $2, 'missing_legacy', '{}'::jsonb, 'legacy_404')
             ON CONFLICT (legacy_case_id) DO UPDATE SET
               user_id=EXCLUDED.user_id, status='missing_legacy', manifest_json='{}'::jsonb,
               manifest_hash=NULL, error_code='legacy_404', updated_at=NOW()`,
            [item.orbita_case_id, item.user_id],
          );
          summary.missing_legacy += 1;
          continue;
        }
        const claimsResponse = await legacyJson(backend, `${casePath}/claims`);
        const body = detail.body || {};
        const claims = claimsResponse.body?.claims || [];
        const manifest = {
          schema: "orbita.unified-legacy-case-manifest.v1",
          legacy_case_id: item.orbita_case_id,
          case: {
            name: body.name || null,
            goal: body.goal || null,
            domain_hint: body.domain_hint || null,
            status: body.status || null,
            created_at: body.created_at || null,
            updated_at: body.updated_at || null,
          },
          files: (body.files || []).map(publicFile),
          plans: (body.plans || []).map(publicPlan),
          runs: (body.runs || []).map(publicRun),
          claims: claims.map(claim => ({
            claim_id: claim.claim_id || claim.id || null,
            support_state: claim.support_state || claim.status || null,
            content_hash: hash({
              statement: claim.statement || claim.canonical_text || null,
              payload: claim.payload || claim.detail || null,
            }),
          })),
        };
        const manifestHash = hash(manifest);
        await db.query(
          `INSERT INTO unified_case_migrations
           (legacy_case_id, user_id, status, manifest_hash, manifest_json, error_code)
           VALUES ($1, $2, 'inventoried', $3, $4, NULL)
           ON CONFLICT (legacy_case_id) DO UPDATE SET
             user_id=EXCLUDED.user_id, status='inventoried', manifest_hash=EXCLUDED.manifest_hash,
             manifest_json=EXCLUDED.manifest_json, error_code=NULL, updated_at=NOW()`,
          [item.orbita_case_id, item.user_id, manifestHash, JSON.stringify(manifest)],
        );
        summary.inventoried += 1;
        summary.files += manifest.files.length;
        summary.plans += manifest.plans.length;
        summary.runs += manifest.runs.length;
        summary.claims += manifest.claims.length;
        receipts.push({ legacy_case_id: item.orbita_case_id, manifest_hash: manifestHash });
      } catch (err) {
        summary.failed += 1;
        await db.query(
          `INSERT INTO unified_case_migrations
           (legacy_case_id, user_id, status, manifest_json, error_code)
           VALUES ($1, $2, 'failed', '{}'::jsonb, $3)
           ON CONFLICT (legacy_case_id) DO UPDATE SET
             user_id=EXCLUDED.user_id, status='failed', error_code=EXCLUDED.error_code, updated_at=NOW()`,
          [item.orbita_case_id, item.user_id, String(err.message || "audit_failed").slice(0, 120)],
        );
      }
    }
    const manifestHash = hash(receipts.sort((a, b) => a.legacy_case_id.localeCompare(b.legacy_case_id)));
    await db.query(
      `UPDATE unified_migration_runs SET status='completed', manifest_hash=$1,
       summary_json=$2, completed_at=NOW() WHERE id=$3`,
      [manifestHash, JSON.stringify(summary), runId],
    );
    console.log(JSON.stringify({ ...summary, manifest_hash: manifestHash }));
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

main().catch(err => {
  console.error(`Unified migration audit failed: ${String(err.message || err).slice(0, 200)}`);
  process.exit(1);
});
