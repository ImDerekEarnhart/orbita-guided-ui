"use strict";
const { Pool } = require("pg");
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r1 = await pool.query("UPDATE invitations SET status='disabled' WHERE status='active'");
  console.log("Disabled invitations: " + r1.rowCount);
  const r2 = await pool.query("UPDATE users SET status='disabled' WHERE username IN ('user_a_test','user_b_test') RETURNING username");
  r2.rows.forEach(r => console.log("Disabled user: " + r.username));
  const r3 = await pool.query("SELECT id, invited_email, status, note, use_count FROM invitations ORDER BY created_at DESC");
  console.log("\nAll invitations:");
  r3.rows.forEach(r => console.log("  " + r.status.padEnd(10) + r.id.slice(0,8) + "  " + (r.note||"-")));
  const r4 = await pool.query("SELECT username, status FROM users ORDER BY created_at DESC");
  console.log("\nAll users:");
  r4.rows.forEach(r => console.log("  " + r.status.padEnd(10) + r.username));
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
