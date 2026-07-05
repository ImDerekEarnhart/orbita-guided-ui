# Phase 2A — Memory Graph Foundation (Frontend)

**Branch:** `saas/phase2a-memory-graphs` (base: `staging/phase1-hardened` @ 85ba1ce)
Not pushed, not deployed, not merged.

## Files changed
- `migrations/004_memory_graphs.sql` — memory_graphs, graph_scope_policy,
  graph_case_links, datasets, operators (placeholder). Additive/idempotent;
  applied to staging PG (new tables only — invisible to running staging code).
- `lib/graphs.js` — graph/dataset helpers (ownership.js style)
- `server.js` — guardGraph middleware + graph routes + case/upload integration
- `tests/test_graphs.js`, `PHASE1_INTEGRATION_HANDOFF.md`

## Behavior
- Graphs: private-only, kinds case/project. POST/GET /api/graphs,
  GET/DELETE /api/graphs/:id, POST /api/graphs/:id/cases/:caseId
  (guardGraph + guardCase), GET /api/graphs/:id/claims (proxied),
  GET /api/graphs/:id/export. Delete cascades links only, never cases.
- Case creation: optional graph_id validated BEFORE backend call (403 if not
  owned); otherwise auto-creates a private kind=case home graph; link mode=home.
  Graph/ownership failure → backend case compensated (deleted) + 500.
- Uploads: optional `?role=` (primary/confirmation/counterexample/regime/benchmark);
  datasets row required — failure returns 500, never swallowed.
- Operators table: placeholder only. No routes, no execution.

## Tests (all pass)
- `tests/test_graphs.js` — 9/9 vs local server on this branch (staging PG +
  staging backend; local because staging deploy lacks graph routes).
  Covers: auto home graph, list isolation, A↛B get/attach/delete/export,
  dual-ownership attach, owner CRUD+export, hostile graph_id on case create.
- Regression: ownership/data-lifecycle/upload-safety/auth — 52/52.
- Migration idempotency: migrate.js run twice → second run no-ops.

## Out of scope (later phases)
Observation ledger behavior, counterexample screening, operator
execution/benchmarking, curriculum queues, chat translator, external
retrieval, any deployment.

## Next step
Review → approve staging deploy of phase1-hardened + phase2a, then run
test_graphs.js against staging directly.
