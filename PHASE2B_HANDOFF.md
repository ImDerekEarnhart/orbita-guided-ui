# Phase 2B — Memory Summaries + Counterexample Access (Frontend)

**Branch:** `saas/phase2b-observation-counterexamples` (base: `saas/phase2a-memory-graphs` @ eb506a7)
Not pushed, not deployed, not merged.

## Files changed
- `server.js` — two new proxied routes, both behind `guardGraph`:
  `GET /api/graphs/:id/summary` and `GET /api/graphs/:id/counterexamples`.
  Graph export now fetches the backend memory summary and attaches it as
  `memory_summary` (enrichment only — export still succeeds when the backend
  lacks the endpoint) plus `links.summary` / `links.counterexamples`.
- `tests/test_graphs.js` — 3 new Phase 2B tests appended to the Phase 2A suite.

## Behavior
- All counterexample/observation data flows through the backend summary
  endpoints; the frontend adds ownership enforcement only. A cannot reach B's
  summaries or counterexamples (guardGraph → 403 + audit).
- No new tables, no migration; datasets/operators tables unchanged.

## Tests (all pass)
- `tests/test_graphs.js` — 12/12 vs local frontend (staging PG) + local
  backend on the 2B branch: all 9 Phase 2A tests unchanged, plus
  A↛B summary/counterexamples (403), owner reads empty summary (200),
  export carries memory_summary + 2B links.
- Regression: data lifecycle / upload safety / ownership / auth — 52/52.

## Out of scope (later phases)
Operator execution, self-improvement queues, chat translator, external
retrieval, shared/org graphs, any deployment.

## Next step
Review → approve push + staging deploy of both 2B branches, re-run
test_graphs.js and test_phase2b_memory.py against staging.
