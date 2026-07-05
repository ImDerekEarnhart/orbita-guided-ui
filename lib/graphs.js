"use strict";

const db = require("./db");

/**
 * Create a memory graph owned by a user. MVP: scope is always 'private'.
 * Also seeds the default scope policy row.
 * Returns the created graph row.
 */
async function createGraph(userId, { name, description = null, kind = "case", parentGraphId = null } = {}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO memory_graphs (owner_user_id, name, description, scope, kind, parent_graph_id)
       VALUES ($1, $2, $3, 'private', $4, $5)
       RETURNING *`,
      [userId, name, description, kind, parentGraphId]
    );
    const graph = rows[0];
    await client.query(
      `INSERT INTO graph_scope_policy (graph_id) VALUES ($1)
       ON CONFLICT (graph_id) DO NOTHING`,
      [graph.id]
    );
    await client.query("COMMIT");
    return graph;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Returns all non-deleted graphs owned by the user, newest first. */
async function getUserGraphs(userId) {
  const { rows } = await db.query(
    `SELECT id, name, description, scope, kind, parent_graph_id, is_locked, created_at
     FROM memory_graphs
     WHERE owner_user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

/** Returns true iff userId owns the given graph and it is not deleted. */
async function checkGraphOwnership(userId, graphId) {
  const { rows } = await db.query(
    `SELECT id FROM memory_graphs
     WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
    [graphId, userId]
  );
  return rows.length > 0;
}

/** Returns the graph row (with policy) if owned by the user, else null. */
async function getGraph(userId, graphId) {
  const { rows } = await db.query(
    `SELECT g.*, p.min_verdict, p.require_manual_approval, p.allow_provisional
     FROM memory_graphs g
     LEFT JOIN graph_scope_policy p ON p.graph_id = g.id
     WHERE g.id = $1 AND g.owner_user_id = $2 AND g.deleted_at IS NULL`,
    [graphId, userId]
  );
  return rows[0] || null;
}

/** Link a case to a graph. Idempotent per (case, graph). */
async function attachCase(userId, graphId, caseId, mode = "home") {
  await db.query(
    `INSERT INTO graph_case_links (graph_id, case_id, user_id, mode)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (case_id, graph_id) DO NOTHING`,
    [graphId, caseId, userId, mode]
  );
}

/** Returns case links for a graph, newest first. */
async function getGraphCases(graphId) {
  const { rows } = await db.query(
    `SELECT case_id, user_id, mode, created_at
     FROM graph_case_links
     WHERE graph_id = $1
     ORDER BY created_at DESC`,
    [graphId]
  );
  return rows;
}

/**
 * Soft-delete a private graph and cascade its links only (never cases).
 * Returns counts of removed link rows.
 */
async function deleteGraph(userId, graphId) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const links = await client.query(
      "DELETE FROM graph_case_links WHERE graph_id = $1",
      [graphId]
    );
    await client.query(
      "UPDATE datasets SET graph_id = NULL WHERE graph_id = $1",
      [graphId]
    );
    const { rowCount } = await client.query(
      `UPDATE memory_graphs SET deleted_at = NOW()
       WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
      [graphId, userId]
    );
    await client.query("COMMIT");
    return { deleted: rowCount > 0, links_removed: links.rowCount || 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Record a dataset registry row. Throws on failure — callers must not swallow. */
async function recordDataset(userId, { caseId, graphId = null, backendFileId, role = "primary", profile = null, sha256 = null, sizeBytes = null }) {
  const { rows } = await db.query(
    `INSERT INTO datasets (user_id, case_id, graph_id, backend_file_id, role, profile_json, sha256, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [userId, caseId, graphId, backendFileId, role, profile ? JSON.stringify(profile) : null, sha256, sizeBytes]
  );
  return rows[0].id;
}

/** Returns dataset registry rows for a case owned by the user. */
async function getCaseDatasets(userId, caseId) {
  const { rows } = await db.query(
    `SELECT id, graph_id, backend_file_id, role, source, sha256, size_bytes, created_at
     FROM datasets
     WHERE user_id = $1 AND case_id = $2
     ORDER BY created_at DESC`,
    [userId, caseId]
  );
  return rows;
}

module.exports = {
  createGraph,
  getUserGraphs,
  checkGraphOwnership,
  getGraph,
  attachCase,
  getGraphCases,
  deleteGraph,
  recordDataset,
  getCaseDatasets,
};
