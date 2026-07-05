"use strict";

async function readBackendBody(response) {
  const contentType = response.headers?.get?.("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

async function deleteBackendCase({ baseUrl, authHeader, caseId, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (!baseUrl) return { ok: false, status: 503, body: { error: "Backend not configured." } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/cases/${encodeURIComponent(caseId)}`, {
      method: "DELETE",
      headers: { Authorization: authHeader },
      signal: controller.signal,
    });
    const body = await readBackendBody(response);
    return { ok: response.ok, status: response.status, body };
  } catch (err) {
    const timedOut = err.name === "AbortError" || err.name === "TimeoutError";
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      body: { error: timedOut ? "Backend deletion timed out." : "Could not reach the Orbita backend." },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupFrontendCase({ db, userId, caseId }) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const runJobs = await client.query(
      "DELETE FROM run_jobs WHERE user_id=$1 AND orbita_case_id=$2",
      [userId, caseId],
    );
    const resources = await client.query(
      "DELETE FROM orbita_resources WHERE user_id=$1 AND orbita_case_id=$2",
      [userId, caseId],
    );
    const proposals = await client.query(
      "DELETE FROM operator_proposals WHERE user_id=$1 AND $2 = ANY(supporting_case_ids)",
      [userId, caseId],
    );
    const datasets = await client.query(
      "DELETE FROM datasets WHERE user_id=$1 AND case_id=$2",
      [userId, caseId],
    );
    const graphLinks = await client.query(
      "DELETE FROM graph_case_links WHERE user_id=$1 AND case_id=$2",
      [userId, caseId],
    );
    const cases = await client.query(
      "DELETE FROM orbita_cases WHERE user_id=$1 AND orbita_case_id=$2",
      [userId, caseId],
    );
    await client.query(
      "UPDATE user_quota SET total_cases = GREATEST(0, total_cases - 1) WHERE user_id=$1",
      [userId],
    );
    await client.query("COMMIT");
    return {
      run_jobs: runJobs.rowCount || 0,
      resources: resources.rowCount || 0,
      operator_proposals: proposals.rowCount || 0,
      datasets: datasets.rowCount || 0,
      graph_case_links: graphLinks.rowCount || 0,
      cases: cases.rowCount || 0,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function deleteOwnedBackendCases({ cases, deleteBackendCaseFn }) {
  const deleted = [];
  for (const item of cases) {
    const caseId = item.orbita_case_id || item.case_id || item.id;
    if (!caseId) continue;
    const result = await deleteBackendCaseFn(caseId);
    if (!result.ok) {
      return { ok: false, failed_case_id: caseId, status: result.status, deleted, body: result.body };
    }
    deleted.push(caseId);
  }
  return { ok: true, deleted };
}

async function recordResourceOrFail({ ownership, audit, req, userId, caseId, resourceType, resourceId }) {
  try {
    await ownership.recordResource(userId, caseId, resourceType, resourceId);
  } catch (err) {
    if (typeof audit === "function") {
      audit(userId, "resource_ownership_record_failed", req, {
        case_id: caseId,
        resource_type: resourceType,
        resource_id: resourceId,
      });
    }
    const safe = new Error("Resource ownership recording failed.");
    safe.cause = err;
    throw safe;
  }
}

async function exportUserData({ db, userId }) {
  const { rows: cases } = await db.query(
    `SELECT orbita_case_id, name, created_at
     FROM orbita_cases
     WHERE user_id=$1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  const { rows: resources } = await db.query(
    `SELECT orbita_case_id, resource_type, resource_id, created_at
     FROM orbita_resources
     WHERE user_id=$1
     ORDER BY created_at DESC`,
    [userId],
  );
  const byCase = new Map(cases.map(item => [item.orbita_case_id, { ...item, resources: [] }]));
  for (const resource of resources) {
    const item = byCase.get(resource.orbita_case_id);
    if (item) item.resources.push(resource);
  }
  const exportedCases = [...byCase.values()].map(item => ({
    case_id: item.orbita_case_id,
    name: item.name,
    created_at: item.created_at,
    resources: item.resources.map(resource => ({
      type: resource.resource_type,
      id: resource.resource_id,
      created_at: resource.created_at,
    })),
    links: {
      case: `/api/orbita/cases/${encodeURIComponent(item.orbita_case_id)}`,
      report: `/api/orbita/cases/${encodeURIComponent(item.orbita_case_id)}/report`,
      downloads: {
        html: `/api/orbita/cases/${encodeURIComponent(item.orbita_case_id)}/download/html`,
        markdown: `/api/orbita/cases/${encodeURIComponent(item.orbita_case_id)}/download/markdown`,
        json: `/api/orbita/cases/${encodeURIComponent(item.orbita_case_id)}/download/json`,
      },
      graph: `/api/orbita/graph-viewer?case_id=${encodeURIComponent(item.orbita_case_id)}`,
    },
  }));
  return {
    exported_at: new Date().toISOString(),
    cases: exportedCases,
  };
}

module.exports = {
  cleanupFrontendCase,
  deleteBackendCase,
  deleteOwnedBackendCases,
  exportUserData,
  recordResourceOrFail,
};
