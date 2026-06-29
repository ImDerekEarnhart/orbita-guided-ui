"use strict";

const db = require("./db");

/** Record that a user owns a backend Orbita case. ON CONFLICT DO NOTHING is safe — idempotent. */
async function recordCase(userId, orbitaCaseId, name) {
  await db.query(
    `INSERT INTO orbita_cases (user_id, orbita_case_id, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (orbita_case_id) DO NOTHING`,
    [userId, orbitaCaseId, name || null]
  );
}

/** Returns true iff userId owns the given orbitaCaseId and it is not deleted. */
async function checkCaseOwnership(userId, orbitaCaseId) {
  const { rows } = await db.query(
    `SELECT id FROM orbita_cases
     WHERE user_id = $1 AND orbita_case_id = $2 AND deleted_at IS NULL`,
    [userId, orbitaCaseId]
  );
  return rows.length > 0;
}

/** Returns all cases owned by the user (not deleted), newest first. */
async function getUserCases(userId) {
  const { rows } = await db.query(
    `SELECT orbita_case_id, name, created_at
     FROM orbita_cases
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

/** Record a file, run, or plan resource for a case. */
async function recordResource(userId, orbitaCaseId, resourceType, resourceId) {
  await db.query(
    `INSERT INTO orbita_resources (user_id, orbita_case_id, resource_type, resource_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (resource_type, resource_id) DO NOTHING`,
    [userId, orbitaCaseId, resourceType, resourceId]
  );
}

/** Returns true iff userId owns the given resource. */
async function checkResourceOwnership(userId, resourceType, resourceId) {
  const { rows } = await db.query(
    `SELECT id FROM orbita_resources
     WHERE user_id = $1 AND resource_type = $2 AND resource_id = $3`,
    [userId, resourceType, resourceId]
  );
  return rows.length > 0;
}

module.exports = {
  recordCase,
  checkCaseOwnership,
  getUserCases,
  recordResource,
  checkResourceOwnership,
};
