# Phase 2D-A — Scientific Finding Summaries / Derived-Feature Warnings (Frontend)

**Branch:** `saas/phase2d-finding-summaries` (base: `saas/phase2d-cross-domain-operators` @ 90e70de)
Not pushed, not deployed, not merged. Production untouched.

## Goal
Turn 80–140 noisy raw findings on a case page into a handful of readable
candidate modules with scientific warning badges — without mutating any claim
status. Motivated by the black-hole and T-cell staging runs.

## Files changed
- `lib/findingModules.js` (new) — `buildFindingModules({findings, claims})`.
  Read-only grouping:
  - PRIMARY: group by outcome/target column (log_X folds onto X), so the
    black-hole case yields a `final_mass` module, a `distance` module, and an
    `uncertainty_bound` module.
  - SUBDIVIDE: when one target dominates the whole case (≥55% and ≥6 findings —
    the single-outcome T-cell exhaustion regime), split that group into
    predictor-theme sub-modules by shared-column connected components.
  - CAVEATS: artifact / data-quality findings collect into one
    "Data caveats & artifact warnings" module.
  - Warning badges per finding/module from structured detail only:
    derived-feature / near-copy-leakage / artifact risk, informative &
    substantial missingness, influence outliers, regime dependence,
    small-sample caution, unproven predictive claim.
- `server.js` — `GET /api/orbita/cases/:caseId/modules` behind `guardCase`,
  registered BEFORE the wildcard proxy. Builds from the backend case detail
  (last run findings) + `/claims`; pure computation, no backend mutation.
- `public/app.js` — case page renders a "Finding modules" section above the
  raw findings list: per-module verdict summary, warning-badge chips, and an
  expandable member list. Raw findings list is unchanged and still present.
- `tests/finding_modules.test.js` (new)

## Guarantees
- No claim status mutation (a test asserts inputs are byte-identical after).
- No new backend route, no migration, no DB write.
- Ownership-enforced (`guardCase`); one user cannot read another's case modules.

## Tests
- `tests/finding_modules.test.js` — 10/10: outcome grouping (black-hole),
  dominant-target subdivision (T-cell), caveats module, warning-badge
  extraction, read-only invariant, claims-only input, empty case, small
  multi-target case, column helpers.
- Frontend unit regression (finding_modules + operator_proposals +
  investigation_config + data_lifecycle suites) — 39/39.
- Visual: module cards rendered from a representative black-hole payload and
  screenshot-verified to match the intended module breakdown.

## Out of scope (later)
Phase 2D-B operator review workflow, chat translator, operator execution,
automatic promotion, production launch.

## Next step
Review → approve staging deploy of `saas/phase2d-finding-summaries`, then
verify module summaries on a real staging case (black-hole / T-cell run).
