"use strict";
// Usage: node set_user_status.js <username> <status>
//   status: active | disabled

const { Pool } = require("pg");

async function main() {
  const [,, username, status] = process.argv;
  if (!username || !["active", "disabled"].includes(status)) {
    console.error("Usage: node set_user_status.js <username> active|disabled");
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const { rowCount } = await pool.query(
    "UPDATE users SET status=$1 WHERE username=$2",
    [status, username]
  );
  await pool.end();
  if (rowCount === 0) {
    console.error(`No user found with username '${username}'`);
    process.exit(1);
  }
  console.log(`Set '${username}' status → ${status} (${rowCount} row updated)`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
