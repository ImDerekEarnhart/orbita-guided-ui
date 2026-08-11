"use strict";

// Read-only deployment check: prove an inherited Guided ID is absent from the
// fresh core and still readable from the legacy store. Never print the IDs.
const db = require("../lib/db");
const { createOrbitaBackend } = require("../lib/orbitaBackend");

async function main() {
  const backend = createOrbitaBackend();
  if (backend.mode !== "unified" || !backend.legacyConfigured) {
    throw new Error("Unified and legacy backends must both be configured.");
  }
  const { rows } = await db.query(
    "SELECT user_id, orbita_case_id FROM orbita_cases ORDER BY created_at DESC LIMIT 250",
  );
  let inherited = null;
  let legacy = null;
  for (const candidate of rows) {
    const path = `/cases/${encodeURIComponent(candidate.orbita_case_id)}`;
    const response = await fetch(backend.legacyUrl(path), { headers: backend.legacyHeaders() });
    if (response.ok) {
      inherited = candidate;
      legacy = response;
      break;
    }
  }
  if (!inherited) throw new Error("No readable inherited case is available for the check.");
  const path = `/cases/${encodeURIComponent(inherited.orbita_case_id)}`;
  const core = await fetch(backend.url(path), { headers: backend.headers(inherited.user_id) });
  console.log(JSON.stringify({
    inherited_core_status: core.status,
    inherited_legacy_status: legacy.status,
    fallback_required: core.status === 404 && legacy.ok,
  }));
  await db.end();
}

main().catch(async err => {
  console.error(`Unified federation check failed: ${err.message}`);
  await db.end().catch(() => {});
  process.exit(1);
});
