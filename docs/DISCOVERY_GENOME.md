# Orbita Discovery Genome

The Discovery Genome turns repeated research strategies into versioned, executable operator contracts and tests them in blind, hash-frozen tournaments.

It does **not** treat an operator proposal as a discovery law. An operator becomes reusable only after a person supplies its intervention, kill switch, recovery test, held-out prediction, failure signature, tested domains, independence level, and affected claims.

## Product role

The public SaaS has three distinct layers:

1. **Cases and memory graphs** store observations, findings, counterexamples, and claim history.
2. **Discovery operators** describe reusable methods for producing decisive tests.
3. **Blind tournaments** compare frozen operators on unseen targets before confirmation results are revealed.

The initial Derek Blind Discovery Challenge will compare:

- Kill-switch validation
- Boundary-first discovery
- Forcing-versus-capacity

across a physical system, a public scientific dataset, and an exact mathematical or computational system.

## Operator contract

Every version requires:

- `required_conditions`
- `intervention`
- `kill_switch`
- `recovery_test`
- `held_out_prediction`
- `expected_failure_signature`
- `domains_tested`
- `independence_level`
- `claims_affected`

Freezing canonicalizes this JSON and stores a SHA-256 receipt. Frozen versions are immutable. A changed method must become a new operator version.

## Tournament prediction

Every operator entry requires:

- target
- expected pattern
- exact vanish condition
- restoration condition
- permanent refuter
- claims affected if transfer fails

A tournament needs at least two frozen operators. Freezing creates a canonical manifest containing the exact operator contract hashes and prediction hashes. Result fields are deliberately excluded from the frozen manifest.

Tournament entries support two versioned prediction forms. Existing transfer tournaments may use the original single-target vanish/recovery/refuter prediction. Multi-world representational-hole benchmarks use `orbita.discovery-tournament-prediction-bundle.v1`, containing one prediction for every world declared by the frozen tournament target. Each world prediction must include an exact `HOLE` or `NO_HOLE` classification, a factorization claim, a candidate recovery primitive or explicit refusal, a permanent refuter, and a scope boundary. Missing, duplicate, or invented world IDs are rejected before insertion.

After freezing:

- operators cannot be swapped;
- predictions cannot be edited;
- confirmation results may be recorded only once per entry;
- verdicts are limited to survived, refuted, or inconclusive;
- no result automatically promotes a global research policy or rewrites a claim.

## Browser workspace

Authenticated users can open `/discovery-genome.html` from the primary Orbita navigation. The workspace can:

- load the seven cross-domain seed families as review-needed drafts;
- display the exact kill switch, recovery test, held-out requirement, and refuter;
- freeze reviewed operator versions and show their SHA-256 receipts;
- select two or more frozen operators;
- capture one complete prediction contract per operator;
- create and freeze a blind tournament;
- list frozen tournament manifests and evaluation progress.

The seed action is idempotent by operator key. It never freezes an operator or labels one as validated.

## Authenticated API

All routes require a valid, email-verified Orbita session. Write routes also require the session CSRF token.

- `GET /api/discovery-genome/operators`
- `POST /api/discovery-genome/operators`
- `POST /api/discovery-genome/operators/seed`
- `POST /api/discovery-genome/operators/:operatorId/freeze`
- `POST /api/discovery-genome/operators/:operatorId/evidence`
- `GET /api/discovery-genome/tournaments`
- `GET /api/discovery-genome/tournaments/:tournamentId`
- `POST /api/discovery-genome/tournaments`
- `POST /api/discovery-genome/tournaments/:tournamentId/entries`
- `POST /api/discovery-genome/tournaments/:tournamentId/freeze`
- `POST /api/discovery-genome/tournaments/:tournamentId/entries/:entryId/result`

Every database query is scoped to the authenticated user's UUID. The migration uses cascading ownership for user deletion and preserves receipt hashes for frozen records.

## Railway preview

Ready-for-review pull-request environments run `npm run migrate` before application startup. A PostgreSQL advisory lock serializes the web and worker migration steps, so concurrent preview deployments cannot apply the same migration twice.

## Scientific boundary

A tournament survivor means only that a preregistered operator survived the declared target and controls. It is not universal proof that the method transfers to every field. Cross-domain reliability must be earned through independent targets, explicit counterexamples, and mapped failure boundaries.
