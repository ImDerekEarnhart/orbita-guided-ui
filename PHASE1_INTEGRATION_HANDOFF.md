# Phase 1 — Integration Baseline Handoff

**Integration branches (local only, not pushed, not deployed):**
- Frontend: `staging/phase1-hardened` @ `85ba1ce` (from `saas/phase1-data-lifecycle-hardening` `f2fc7ac`)
- Backend:  `staging/phase1-hardened` @ `eda2a81` (from `saas/phase1-data-lifecycle-hardening`)

Branches are stacked, so each tip contains all Phase 1 work:
auth isolation → upload safety → backend hardening → data lifecycle.

## Cleanup performed
- `tests/test_data_lifecycle.js` (previously untracked) committed as `85ba1ce`.
  Decision: keep as complementary suite — it covers deleteBackendCase error paths
  (404/500/502/503/504) and export edge cases; `data_lifecycle.test.js` covers
  transactions + recordResourceOrFail. One overlapping test, acceptable.

## Verification (2026-07-05)
Frontend:
- `node --check server.js` — OK
- `data_lifecycle.test.js` + `test_data_lifecycle.js` + `upload_safety.test.js` — 23/23 pass
- `test_data_lifecycle_http.js` vs staging — 4/4 pass (cross-user delete denied,
  own delete removes backend case, account deletion backend-first)

Backend:
- `py_compile api.py service.py storage.py` — OK
- `test_data_lifecycle.py` + `test_backend_direct_access_hardening.py` — 10/10 pass

## Status
Phase 1 baseline is CLEAN. Phase 2A branches from these tips.

## Not done (needs approval)
- Push/merge of integration branches
- Staging deploy of this baseline (staging still runs earlier commits)
- Production anything
