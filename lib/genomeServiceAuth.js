"use strict";

const crypto = require("node:crypto");

function allowedUserSet(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function bearerMatches(header, expectedToken) {
  const prefix = "Bearer ";
  if (typeof header !== "string" || !header.startsWith(prefix)) return false;
  const supplied = header.slice(prefix.length);
  const expected = String(expectedToken || "");
  if (!supplied || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function coreTenantId(userId) {
  return `g-${crypto.createHash("sha256").update(String(userId), "ascii").digest("hex").slice(0, 32)}`;
}

function createGenomeServiceAuth({
  db,
  token = process.env.ORBITA_GENOME_SERVICE_TOKEN,
  allowedUsers = process.env.ORBITA_GENOME_SERVICE_ALLOWED_USERS,
} = {}) {
  if (!db || typeof db.query !== "function") throw new Error("db.query is required");
  const users = allowedUserSet(allowedUsers);
  const configured = typeof token === "string" && token.length >= 32 && users.size > 0;

  return async function genomeServiceAuth(req, res, next) {
    if (!configured) {
      return res.status(503).json({ error: "Discovery Genome service API is not configured." });
    }
    if (!bearerMatches(req.get("authorization"), token)) {
      res.set("WWW-Authenticate", 'Bearer realm="orbita-discovery-genome"');
      return res.status(401).json({ error: "Unauthorized." });
    }

    const username = String(req.get("x-orbita-genome-user") || "").trim().toLowerCase();
    if (!username || !users.has(username)) {
      return res.status(403).json({ error: "Discovery Genome identity is not allowed." });
    }

    try {
      const { rows } = await db.query(
        `SELECT id, username, email, status, email_verified_at, role
         FROM users
         WHERE lower(username) = $1 AND status = 'active'`,
        [username]
      );
      if (!rows.length) {
        return res.status(403).json({ error: "Discovery Genome identity is unavailable." });
      }
      req.user = rows[0];
      req.genomeService = { username: rows[0].username };
      next();
    } catch (err) {
      console.error("[genome-service-auth]", String(err?.message || err).slice(0, 200));
      res.status(500).json({ error: "Discovery Genome identity check failed." });
    }
  };
}

module.exports = { allowedUserSet, bearerMatches, coreTenantId, createGenomeServiceAuth };
