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

## Staging
Migration `005_operator_proposals` applied to staging Postgres. Deploy/test pending.

## Out of Scope
Chat translator, operator execution, benchmark promotion, external retrieval, blockchain/crypto, production launch.
