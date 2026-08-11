"use strict";

const GUIDED_PREFIX = "/guided/v1";
const PLAN_APPROVAL_PHRASE = "I reviewed this exact frozen plan";
const CASE_DELETION_PHRASE = "I permanently delete this case and its files";

function createOrbitaBackend(env = process.env) {
  const unifiedBase = String(env.ORBITA_UNIFIED_CORE_URL || "").replace(/\/$/, "");
  const unifiedToken = String(env.ORBITA_UNIFIED_CORE_TOKEN || "");
  const legacyBase = String(env.ORBITA_API_BASE || "").replace(/\/$/, "");
  const legacyUser = String(env.ORBITA_API_USERNAME || "");
  const legacyPass = String(env.ORBITA_API_PASSWORD || "");
  const migrationToken = String(env.ORBITA_MIGRATION_SERVICE_TOKEN || "");
  const mode = unifiedBase ? "unified" : "legacy";

  if (mode === "unified" && unifiedToken.length < 32) {
    throw new Error("ORBITA_UNIFIED_CORE_TOKEN must be at least 32 characters.");
  }

  const baseUrl = mode === "unified" ? unifiedBase : legacyBase;
  const legacyAuth = "Basic " + Buffer.from(`${legacyUser}:${legacyPass}`).toString("base64");

  function path(apiPath) {
    const normalized = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
    return mode === "unified" ? `${GUIDED_PREFIX}${normalized}` : normalized;
  }

  function headers(userId, incoming = {}) {
    const result = {};
    if (mode === "unified") {
      if (!userId) throw new Error("A Guided user ID is required for the unified Orbita core.");
      result.Authorization = `Bearer ${unifiedToken}`;
      result["X-Orbita-User-Id"] = String(userId);
    } else {
      result.Authorization = legacyAuth;
    }
    if (incoming["content-type"]) result["Content-Type"] = incoming["content-type"];
    if (incoming.accept) result.Accept = incoming.accept;
    return result;
  }

  function url(apiPath) {
    return `${baseUrl}${path(apiPath)}`;
  }

  function legacyUrl(apiPath) {
    const normalized = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
    return `${legacyBase}${normalized}`;
  }

  function legacyHeaders(incoming = {}) {
    const result = { Authorization: legacyAuth };
    if (incoming["content-type"]) result["Content-Type"] = incoming["content-type"];
    if (incoming.accept) result.Accept = incoming.accept;
    return result;
  }

  function migrationHeaders() {
    if (migrationToken.length < 32) {
      throw new Error("ORBITA_MIGRATION_SERVICE_TOKEN must be at least 32 characters.");
    }
    return { Authorization: `Bearer ${migrationToken}`, Accept: "application/octet-stream" };
  }

  return {
    mode,
    baseUrl,
    configured: Boolean(baseUrl),
    url,
    headers,
    legacyConfigured: Boolean(legacyBase),
    legacyUrl,
    legacyHeaders,
    migrationConfigured: migrationToken.length >= 32,
    migrationHeaders,
    approvalPhrase: PLAN_APPROVAL_PHRASE,
    deletionPhrase: CASE_DELETION_PHRASE,
  };
}

module.exports = {
  CASE_DELETION_PHRASE,
  GUIDED_PREFIX,
  PLAN_APPROVAL_PHRASE,
  createOrbitaBackend,
};
