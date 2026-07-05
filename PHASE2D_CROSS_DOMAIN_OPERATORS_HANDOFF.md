# Phase 2D-A - Cross-Domain Operator Proposals (Frontend)

Branch: `saas/phase2d-cross-domain-operators`
Base: Phase 2B staging-green frontend `1689d6a2aeffd93b6d05c05c362774a83cce7335`

## Files Changed
- `migrations/005_operator_proposals.sql`
- `lib/operatorProposals.js`
- `lib/dataLifecycle.js`
- `server.js`
- `public/index.html`
- `public/app.js`
- `tests/operator_proposals.test.js`
- `tests/data_lifecycle.test.js`
- `tests/test_graphs.js`

## Schema
Adds `operator_proposals`, scoped by `graph_id` + `user_id`, with candidate-only statuses:
`proposed`, `review_needed`, `dismissed`. Stores pattern/evidence/counterexample JSON plus supporting case/claim/counterexample IDs.

## API Routes
- `GET /api/graphs/:graphId/operators`
- `GET /api/graphs/:graphId/operators/:operatorId`
- `POST /api/graphs/:graphId/operators/propose`

All routes use `guardGraph`; User A cannot access User B's graph proposals.

## UI Behavior
Adds `Projects` page:
- create/select project memory graph
- create a new case inside selected graph
- attach existing owned case to owned graph
- run "Find discovery operators"
- show candidate operator cards with review-required warning

Wizard now includes a project graph selector. Queued runs inherit the case home graph so claims/counterexamples write to the selected project graph.

## Operator Rules
Heuristic-only. Requires evidence from 2+ cases. Proposals never mutate claims, execute operators, or promote anything to truth.

## Tests
- `node --check server.js`
- `node --check public/app.js`
- `node --test tests/auth.test.js tests/data_lifecycle.test.js tests/test_data_lifecycle.js tests/upload_safety.test.js tests/operator_proposals.test.js`
- Local live-style graph suite against temporary server: `node --test tests/test_graphs.js`
- Live staging graph suite: `node --test tests/test_graphs.js` => 14/14 passed
- Live staging lifecycle suite: `node --test tests/test_data_lifecycle_http.js` => 4/4 passed
- Live staging upload suite: `node --test tests/test_upload_safety_http.js` => 6/6 passed
- Live product smoke: 2 project-graph cases, 2 completed runs, 24 graph claims, 2 operator proposals
- Backend local hardening/scoping: `python -m pytest tests/test_phase2b_memory.py tests/test_graph_scoping.py tests/test_backend_direct_access_hardening.py` => 25/25 passed

## Staging
Migration `005_operator_proposals` applied to staging Postgres.
Frontend staging deploy: `fedae7ae-b78c-4c98-80d1-302bd3382c4c`.
Backend runtime unchanged from Phase 2B staging deploy; backend handoff only documents reused APIs.
Phase 2D-A is staging-green. Production untouched.

## Out of Scope
Chat translator, operator execution, benchmark promotion, external retrieval, blockchain/crypto, production launch.
