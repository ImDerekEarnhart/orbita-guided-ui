"use strict";
const { Pool } = require("pg");
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows: tables } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `);
  console.log("Tables:", tables.map(r => r.table_name).join(", "));

  for (const { table_name } of tables) {
    const { rows: cols } = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position
    `, [table_name]);
    console.log(`\n-- ${table_name}`);
    cols.forEach(c => console.log(`   ${c.column_name.padEnd(30)} ${c.data_type}${c.is_nullable==='NO'?' NOT NULL':''}`));
  }

  const { rows: migs } = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
  console.log("\nApplied migrations:", migs.map(r => r.version).join(", ") || "(none)");
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
