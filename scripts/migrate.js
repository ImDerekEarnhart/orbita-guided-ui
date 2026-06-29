"use strict";

const { Pool } = require("pg");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) { console.error("DATABASE_URL is not set"); process.exit(1); }

  const ssl = process.env.APP_ENV === "development" ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: connStr, ssl });

  // Ensure migrations table exists first (idempotent)
  await pool.query(`
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
    const { rows } = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1", [version]
    );
    if (rows.length) { console.log(`[skip] ${version}`); continue; }

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    console.log(`[run ] ${version}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)", [version]
      );
      await client.query("COMMIT");
      console.log(`[done] ${version}`);
      ran++;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log(`\nMigrations complete. ${ran} new migration(s) applied.`);
}

main().catch(err => { console.error("Migration failed:", err.message); process.exit(1); });
