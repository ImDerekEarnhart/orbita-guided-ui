"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.APP_ENV === "production" || process.env.APP_ENV === "staging")
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", err => console.error("[db] pool error:", err.message));

module.exports = pool;
