"use strict";

// Read-only migration inventory. It deliberately prints aggregate counts only;
// user UUIDs and scientific case IDs stay out of deployment logs.
const db = require("../lib/db");

async function scalar(sql) {
  const { rows } = await db.query(sql);
  return Number(rows[0]?.count || 0);
}

async function main() {
  const [cases, users, resources, datasets, graphLinks, runs] = await Promise.all([
    scalar("SELECT COUNT(*) AS count FROM orbita_cases"),
    scalar("SELECT COUNT(DISTINCT user_id) AS count FROM orbita_cases"),
    scalar("SELECT COUNT(*) AS count FROM orbita_resources"),
    scalar("SELECT COUNT(*) AS count FROM datasets"),
    scalar("SELECT COUNT(*) AS count FROM graph_case_links"),
    scalar("SELECT COUNT(*) AS count FROM run_jobs"),
  ]);
  const { rows: resourceRows } = await db.query(
    "SELECT resource_type, COUNT(*)::int AS count FROM orbita_resources GROUP BY resource_type ORDER BY resource_type",
  );
  console.log(JSON.stringify({
    cases,
    users,
    resources,
    datasets,
    graph_case_links: graphLinks,
    run_jobs: runs,
    resources_by_type: Object.fromEntries(resourceRows.map(row => [row.resource_type, Number(row.count)])),
  }));
  await db.end();
}

main().catch(async err => {
  console.error(`Unified migration inventory failed: ${err.message}`);
  await db.end().catch(() => {});
  process.exit(1);
});
