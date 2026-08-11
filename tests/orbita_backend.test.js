"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CASE_DELETION_PHRASE,
  PLAN_APPROVAL_PHRASE,
  createOrbitaBackend,
} = require("../lib/orbitaBackend");

test("unified backend sends each Guided user through the shared core tenant boundary", () => {
  const backend = createOrbitaBackend({
    ORBITA_UNIFIED_CORE_URL: "https://core.example/",
    ORBITA_UNIFIED_CORE_TOKEN: "a-secure-service-token-longer-than-32-bytes",
    ORBITA_API_BASE: "https://legacy.example/",
    ORBITA_API_USERNAME: "old",
    ORBITA_API_PASSWORD: "secret",
    ORBITA_MIGRATION_SERVICE_TOKEN: "migration-service-token-longer-than-32-bytes",
  });
  assert.equal(backend.mode, "unified");
  assert.equal(backend.url("/cases"), "https://core.example/guided/v1/cases");
  assert.deepEqual(backend.headers("9e6c186e-6c49-4775-bcad-050d01685968"), {
    Authorization: "Bearer a-secure-service-token-longer-than-32-bytes",
    "X-Orbita-User-Id": "9e6c186e-6c49-4775-bcad-050d01685968",
  });
  assert.equal(backend.approvalPhrase, PLAN_APPROVAL_PHRASE);
  assert.equal(backend.deletionPhrase, CASE_DELETION_PHRASE);
  assert.equal(backend.legacyConfigured, true);
  assert.equal(backend.legacyUrl("/cases/old"), "https://legacy.example/cases/old");
  assert.equal(backend.legacyHeaders().Authorization, `Basic ${Buffer.from("old:secret").toString("base64")}`);
  assert.equal(backend.migrationConfigured, true);
  assert.deepEqual(backend.migrationHeaders(), {
    Authorization: "Bearer migration-service-token-longer-than-32-bytes",
    Accept: "application/octet-stream",
  });
});

test("legacy backend remains available until staged cases are migrated", () => {
  const backend = createOrbitaBackend({
    ORBITA_API_BASE: "https://legacy.example/",
    ORBITA_API_USERNAME: "orbita",
    ORBITA_API_PASSWORD: "secret",
  });
  assert.equal(backend.mode, "legacy");
  assert.equal(backend.url("/cases"), "https://legacy.example/cases");
  assert.equal(backend.headers(null).Authorization, `Basic ${Buffer.from("orbita:secret").toString("base64")}`);
});

test("unified backend fails closed without a strong service token or user identity", () => {
  assert.throws(
    () => createOrbitaBackend({ ORBITA_UNIFIED_CORE_URL: "https://core.example", ORBITA_UNIFIED_CORE_TOKEN: "short" }),
    /at least 32 characters/,
  );
  const backend = createOrbitaBackend({
    ORBITA_UNIFIED_CORE_URL: "https://core.example",
    ORBITA_UNIFIED_CORE_TOKEN: "a-secure-service-token-longer-than-32-bytes",
  });
  assert.throws(() => backend.headers(null), /user ID is required/);
  assert.throws(() => backend.migrationHeaders(), /at least 32 characters/);
});
