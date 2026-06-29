"use strict";

const { Pool } = require("pg");

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.APP_ENV === "development" ? false : { rejectUnauthorized: false }
  });

  const { rows } = await pool.query(`
    SELECT i.id, i.invited_email, i.expires_at, i.use_count, i.max_uses,
           i.status, i.note, i.created_at,
           u.username AS used_by
    FROM invitations i
    LEFT JOIN users u ON u.id = i.used_by_user_id
    ORDER BY i.created_at DESC
  `);

  await pool.end();

  if (!rows.length) { console.log("No invitations found."); return; }

  console.log("\nInvitations:");
  console.log("─".repeat(80));
  for (const r of rows) {
    const expired = r.expires_at && new Date(r.expires_at) < new Date();
    const state = r.status === "disabled" ? "DISABLED"
      : expired ? "EXPIRED"
      : r.use_count >= r.max_uses ? "EXHAUSTED"
      : "OPEN";
    console.log(`[${state.padEnd(8)}] ${r.id.slice(0, 8)}…  email=${r.invited_email || "any"
    }  uses=${r.use_count}/${r.max_uses}  expires=${r.expires_at ? new Date(r.expires_at).toISOString().slice(0, 10) : "never"
    }  usedBy=${r.used_by || "-"}  note=${r.note || "-"}`);
  }
  console.log("─".repeat(80) + "\n");
}

main().catch(err => { console.error(err.message); process.exit(1); });
