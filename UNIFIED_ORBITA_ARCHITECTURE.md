# Unified Orbita architecture

## Product boundary

Orbita is one governed research system with two interfaces:

1. **Guided Orbita** is the human-facing workflow. It owns login, projects, review cards,
   follow-up-question presentation, quotas, and the visual Discovery Genome experience.
2. **Orbita MCP** is the agent-facing workflow. It exposes the same research cases,
   evidence, plans, runs, claims, reports, memory, knowledge, and improvement controls to
   an authorized model or coding agent.
3. **Orbita Unified Core** is the source of truth for scientific execution. Both interfaces
   use `AgentGateway`; they do not run separate discovery engines.

Guided users are mapped to isolated core tenants using their opaque database UUID. Email,
username, cookies, and browser credentials are never sent to the core. The frontend server
authenticates to the core with `ORBITA_UNIFIED_CORE_TOKEN` and sends the user UUID in
`X-Orbita-User-Id`.

## Shared workflow

`create case -> upload evidence -> compile immutable plan -> show exact SHA-256 hash ->
human approval -> execute -> retain claims/counterexamples -> render report/claim graph`

The unified core rejects `auto_approve`. MCP and Guided therefore cross the same approval
boundary and write compatible case, plan, run, claim, and report records.

## Guided-only presentation layer

The existing Guided PostgreSQL records remain a product/project layer during migration:

- accounts, sessions, email verification, quotas, and audit events;
- project graph layout and case-to-project links;
- human reviews of operator proposals;
- programme-state compilation and follow-up-question cards;
- asynchronous job tracking.

These records may refer to unified-core IDs, but they do not replace the core's scientific
ledger. A later schema migration can promote reviewed question/operator records into the
core as first-class shared objects without changing the case execution path implemented here.

## Configuration and rollback

Set both web and worker services to:

```text
ORBITA_UNIFIED_CORE_URL=https://<unified-core-host>
ORBITA_UNIFIED_CORE_TOKEN=<same random secret of at least 32 characters>
```

Set the core to the same `ORBITA_GUIDED_SERVICE_TOKEN` value. When
`ORBITA_UNIFIED_CORE_URL` is absent, Guided continues using the legacy
`ORBITA_API_BASE`/Basic-auth backend. This provides a rollback path while existing cases are
migrated and verified.

When both backends are configured, Guided runs in **federated migration mode**. New cases
are created only in the unified core. Requests for an existing case try the core first and
fall back to the legacy store only after a 404. Case lists merge both sources and are still
filtered through Guided's ownership registry. Legacy fallback is never used for a failed
new-case creation, so an unhealthy core cannot silently send new science back to the old
engine.

## Migration rule

Do not silently reinterpret old case IDs. Inventory the Guided ownership registry, copy each
legacy case into the matching UUID-derived tenant, verify file and report hashes, record an
old-to-new ID manifest, and only then switch that deployment to unified mode. New unified
cases require no translation: Guided and MCP already address the same stored record.

## Deployment gate

Before staging switches to unified mode:

- deploy a non-production unified-core service with persistent storage;
- configure the shared service token on core, web, and worker;
- exercise two real test users and prove cross-user case IDs return 404/403;
- complete create/upload/compile/hash approval/run/report/claim-graph flows;
- verify Guided follow-up questions still reference the correct unified case and claim IDs;
- test legacy rollback without deleting or rewriting either datastore;
- migrate existing cases with a hash-verifiable manifest.
