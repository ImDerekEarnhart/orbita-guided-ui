"use strict";

const { Pool } = require("pg");

async function main() {
  const id = process.argv[2];
  if (!id) { console.error("Usage: node scripts/disable-invite.js <invitation-id>"); process.exit(1); }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.APP_ENV === "development" ? false : { rejectUnauthorized: false }
  });

  const { rowCount } = await pool.query(
    "UPDATE invitations SET status = 'disabled' WHERE id = $1", [id]
  );
  await pool.end();

  if (rowCount === 0) { console.error("Invitation not found:", id); process.exit(1); }
  console.log(`Invitation ${id} disabled.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
