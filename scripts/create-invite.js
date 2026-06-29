"use strict";

/**
 * Admin CLI — create an invitation code.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/create-invite.js [options]
 *
 * Options:
 *   --email <addr>        Bind to a specific email (optional)
 *   --expires-days <n>    Days until expiration (default: 30)
 *   --uses <n>            Max redemptions (default: 1)
 *   --note <text>         Admin label (e.g. "Diya's invite")
 *
 * The plaintext code is printed ONCE. Only its SHA-256 hash is stored.
 */

const { Pool } = require("pg");
const crypto = require("node:crypto");

async function main() {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) { console.error("DATABASE_URL is not set"); process.exit(1); }

  const ssl = process.env.APP_ENV === "development" ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: connStr, ssl });

  const args = process.argv.slice(2);
  const get = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

  const email     = get("--email");
  const expiryDays = parseInt(get("--expires-days") || "30", 10);
  const maxUses   = parseInt(get("--uses") || "1", 10);
  const note      = get("--note");

  if (isNaN(maxUses) || maxUses < 1) { console.error("--uses must be a positive integer"); process.exit(1); }

  // Generate a URL-safe 128-bit random code
  const rawCode = crypto.randomBytes(16).toString("base64url");
  const codeHash = crypto.createHash("sha256").update(rawCode).digest("hex");
  const expiresAt = new Date(Date.now() + expiryDays * 86_400_000).toISOString();

  const { rows } = await pool.query(
    `INSERT INTO invitations (code_hash, invited_email, expires_at, max_uses, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at, expires_at`,
    [codeHash, email || null, expiresAt, maxUses, note || null]
  );
  const inv = rows[0];

  await pool.end();

  // Print the plaintext code ONCE — never stored
  console.log("\n╔══════════════════════════════════╗");
  console.log("║     ORBITA INVITATION CREATED    ║");
  console.log("╚══════════════════════════════════╝");
  console.log(`  ID:        ${inv.id}`);
  console.log(`  Code:      ${rawCode}`);
  console.log(`  Email:     ${email || "(any)"}`);
  console.log(`  Max uses:  ${maxUses}`);
  console.log(`  Expires:   ${inv.expires_at}`);
  console.log(`  Note:      ${note || "(none)"}`);
  console.log("────────────────────────────────────");
  console.log("  Send only the Code to the invitee.");
  console.log("  It will NOT be shown again.\n");
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
