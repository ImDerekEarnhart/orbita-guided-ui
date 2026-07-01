"use strict";
// Grant admin role to a user account.
// Looks up by username for convenience, grants by immutable user ID.
// Usernames do NOT control admin access at runtime.
//
// Usage (from orbita-alpha directory, never paste DATABASE_URL into chat):
//   DATABASE_URL="$(railway variables get DATABASE_URL)" node scripts/grant-admin.js <username>

const { Pool } = require("pg");

const username = (process.argv[2] || "").trim().toLowerCase();
if (!username) {
  console.error("Usage: node scripts/grant-admin.js <username>");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.APP_ENV === "development" ? false : { rejectUnauthorized: false },
});

async function main() {
  const { rows } = await pool.query(
    `SELECT id, username, role, status FROM users
     WHERE lower(username) = $1 AND status != 'deleted'`,
    [username]
  );
  if (!rows.length) {
    console.error(`No active user found with username: ${username}`);
    process.exit(1);
  }
  const user = rows[0];
  if (user.role === "admin") {
    console.log(`User ${user.id} already has role=admin. No change.`);
    return;
  }
  await pool.query(
    "UPDATE users SET role='admin', updated_at=NOW() WHERE id=$1",
    [user.id]
  );
  // Print only the ID, never the username or any secret
  console.log(`admin role granted to user id=${user.id}`);
  console.log("Note: admin access is verified by user ID in the database, not by username.");
}

main()
  .catch(err => { console.error("Failed:", err.message); process.exit(1); })
  .finally(() => pool.end());
