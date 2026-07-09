# Phase 2F-B Handoff: Programme State Compiler

## Branches
- Frontend: `saas/phase2f-programme-state-compiler`
- Backend: `saas/phase2f-programme-state-compiler` (unchanged)
- Production: untouched
- Staging deploy: not attempted; Railway resources remain the known blocker

## Scope
- Adds a review-only programme-state compiler above the Phase 2D-B / 2F-A trace layer.
- No claim verdict mutation, no operator execution, no auto-promotion, no MCP work.
- All generated next-question cards remain `review_needed: true`.

## Schema
- Added `migrations/007_programme_state_snapshots.sql`.
- New table: `programme_state_snapshots`.
- Additive `admissible_questions` columns:
  - `question_class`
  - `what_would_make_it_admissible`
  - `trace_event_refs_json`
  - `programme_state_snapshot_id`
  - `review_needed`

## Trace Capture
- Existing: case created, dataset uploaded, operator proposed, operator/module reviewed, manual trace notes.
- Added summary capture:
  - run completed
  - finding modules available
  - artifact/derived/near-copy module warning
  - graph counterexamples available during proposal pass
- Capture is deduped by event/source ref where routes may be called repeatedly.

## Compiler Logic
- New `lib/programmeState.js`.
- Inputs: trace events, reviews, stored operator proposals, existing questions.
- Outputs: carry-forward objects, blockers, active operators/modules, artifact warnings, traceability gaps, counterexample clusters, stopping rules, replication/independent-dataset needs, blocked claim classes, and allowed question classes.

## Admissibility Rules
- Unresolved traceability gaps require repair before dependent questions.
- Artifact/derived/near-copy warnings block stronger science claims but allow artifact-audit questions.
- Counterexamples make narrowing/boundary questions admissible while broad generalization remains blocked.
- Multi-case manageable operators produce replication/generalization candidates.
- Dominated-by-one-case operators need more evidence.
- `accepted_candidate` yields next-test questions only.
- Rejected objects block promotion.
- Stopping rules permit smaller/narrower carry-forward questions.

## UI
- Project graph page now fetches and displays Programme State.
- Added "Compile programme state" action.
- Admissible Question Frontier is grouped by:
  - Admissible
  - Needs More Evidence
  - Needs Traceability Repair
  - Blocked
  - Possible / Interesting
- Question cards show class, reason, blockers, what would make admissible, refs, and review-needed status.

## Tests Run
- `node --check server.js` PASS
- `node --check public/app.js` PASS
- `node --check lib/programmeState.js` PASS
- `node --check lib/reviewTrace.js` PASS
- `node --test tests/programme_state.test.js` PASS (9/9)
- `node --test tests/review_trace.test.js` PASS (8/8)
- `node --test tests/operator_proposals.test.js` PASS (7/7)
- `node --test tests/finding_modules.test.js` PASS (11/11)
- `node --test tests/investigation_config.test.js` PASS (5/5)
- `node --test tests/auth.test.js tests/data_lifecycle.test.js tests/test_data_lifecycle.js tests/upload_safety.test.js` PASS (51/51)
- `node --test tests/test_graphs.js` SKIPPED live graph tests because `DATABASE_URL` not set.
- `node --test tests/test_data_lifecycle_http.js` SKIPPED because staging env not set.
- `node --test tests/test_upload_safety_http.js` SKIPPED because `DATABASE_URL` not set.
- `node --test tests/ownership.test.js` SKIPPED because `DATABASE_URL` not set.

## Remaining Risks
- Migration 007 is local only until staging resources are available.
- Staging live app still predates Phase 2D-B/2F-A and Phase 2F-B code.
- Compiler is conservative and heuristic; it needs live graph validation once deploy capacity returns.

## Next Step
Free/upgrade Railway resources, apply migration 007 to staging, deploy frontend staging only, then validate programme-state snapshots and question-frontier grouping on BuildingTheBrain/T-cell/black-hole/QM9 graphs.
