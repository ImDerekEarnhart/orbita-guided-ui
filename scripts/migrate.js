"use strict";

const { Pool } = require("pg");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_LOCK_KEY = "orbita-guided-ui:migrations";

async function main() {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) { console.error("DATABASE_URL is not set"); process.exit(1); }

  const ssl = process.env.APP_ENV === "development" ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: connStr, ssl });
  const lockClient = await pool.connect();

  try {
    // Railway can start the web and worker pre-deploy steps together. Keep one
    // session-level lock for the entire migration run so they cannot race.
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);

    await lockClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        run_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(__dirname, "..", "migrations");
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith(".sql"))
      .sort();

    let ran = 0;
    for (const file of files) {
      const version = file.replace(".sql", "");
      const { rows } = await lockClient.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1", [version]
      );
      if (rows.length) { console.log(`[skip] ${version}`); continue; }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      console.log(`[run ] ${version}`);
      try {
        await lockClient.query("BEGIN");
        await lockClient.query(sql);
        await lockClient.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)", [version]
        );
        await lockClient.query("COMMIT");
        console.log(`[done] ${version}`);
        ran++;
      } catch (err) {
        await lockClient.query("ROLLBACK");
        throw err;
      }
    }

    console.log(`\nMigrations complete. ${ran} new migration(s) applied.`);
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    } finally {
      lockClient.release();
      await pool.end();
    }
  }
}

main().catch(err => { console.error("Migration failed:", err.message); process.exit(1); });
