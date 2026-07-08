# Phase 2D-B / 2F-A Handoff: Review Trace Frontier

## Branches
- Frontend: `saas/phase2d-review-trace-frontier`
- Backend: `saas/phase2d-review-trace-frontier` (unchanged from `11778f8`)
- Production: untouched

## Scope
- Review-only operator/module workflow.
- Research programme trace at project graph level.
- Conservative admissible next-question candidates.
- No chat, no operator execution, no claim mutation, no auto-promotion.

## Schema
- Added `migrations/006_review_trace_frontier.sql`.
- New tables: `review_items`, `review_events`, `research_trace_events`, `admissible_questions`.
- All rows are `graph_id` + `user_id` scoped and cascade with deleted memory graphs.

## API
- `GET|POST /api/graphs/:graphId/trace`
- `GET /api/graphs/:graphId/trace/:eventId`
- `GET|PATCH /api/graphs/:graphId/operators/:operatorId/review`
- `GET|PATCH /api/graphs/:graphId/modules/:moduleId/review`
- `GET /api/graphs/:graphId/questions`
- `POST /api/graphs/:graphId/questions/generate`
- `PATCH /api/graphs/:graphId/questions/:questionId/review`
- All routes use `guardGraph`; operator review verifies the operator belongs to the owned graph.

## UI
- Project graph page now shows Research Trace and Admissible Next Questions.
- Users can add graph-level trace notes.
- Users can generate conservative next-question cards.
- Operator cards include review status, notes, and checklist controls.
- Copy states that accepted candidates are not proven and admissible questions are not answers.

## Review Semantics
- Statuses: `proposed`, `under_review`, `accepted_candidate`, `rejected`, `needs_more_evidence`, `deprecated`.
- `accepted_candidate` means worth testing, not true/proven.
- `rejected` preserves the object and blocks stronger promotion.
- Reviews do not mutate backend claims or proposal `status`.

## Trace / Question Heuristics
- Artifact Mimicry becomes an artifact-risk audit question.
- Accepted candidates produce independent-test questions.
- Rejected candidates produce blocked questions.
- High counterexample load and one-case dominance require more evidence.
- Traceability gaps produce `needs_traceability_repair` questions.

## Tests Run
- `node --check server.js` PASS
- `node --check public/app.js` PASS
- `node --check lib/reviewTrace.js` PASS
- `node --test tests/review_trace.test.js` PASS (8/8)
- `node --test tests/operator_proposals.test.js` PASS (7/7)
- `node --test tests/finding_modules.test.js` PASS (11/11)
- `node --test tests/investigation_config.test.js` PASS (5/5)
- `node --test tests/auth.test.js tests/data_lifecycle.test.js tests/test_data_lifecycle.js tests/upload_safety.test.js` PASS (51/51)
- `node --test tests/test_graphs.js` SKIPPED live graph tests because `DATABASE_URL` not set.
- `node --test tests\\*.js` mostly PASS; existing admin HTTP tests failed because no local server was running on port 3000.

## Staging
- Migration 006 was applied to staging successfully.
- Frontend staging deploy was attempted for `orbita-guided-ui`.
- Deploy is blocked by Railway: `You have used all your available resources`.
- Current live staging still predates this branch until resources are freed.

## Remaining Risks
- Run-completed trace auto-events are not wired yet; current auto-events are case created, dataset added, and operator proposal pass.
- Finding module review is API-backed with deterministic IDs, but no case-page module review UI yet.
- Question generation is heuristic and intentionally conservative.

## Next Step
Free/upgrade Railway resources, rerun `railway up --service orbita-guided-ui --environment staging --detach`, then validate trace/review/questions on the existing BuildingTheBrain/T-cell/black-hole/QM9 graphs.
