-- Migration 007: Phase 2F-B programme-state compiler snapshots.
-- Additive and review-only. No claims, verdicts, or executable operators are mutated.

CREATE TABLE IF NOT EXISTS programme_state_snapshots (
  id                                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id                            UUID        NOT NULL REFERENCES memory_graphs(id) ON DELETE CASCADE,
  user_id                             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_trace_event_count            INTEGER     NOT NULL DEFAULT 0,
  open_questions_json                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
  closed_questions_json               JSONB       NOT NULL DEFAULT '[]'::jsonb,
  active_modules_json                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
  active_operators_json               JSONB       NOT NULL DEFAULT '[]'::jsonb,
  accepted_candidate_objects_json     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  rejected_objects_json               JSONB       NOT NULL DEFAULT '[]'::jsonb,
  unresolved_artifact_warnings_json   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  unresolved_traceability_gaps_json   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  open_counterexample_clusters_json   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  active_stopping_rules_json          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  carry_forward_objects_json          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  blocked_claim_classes_json          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  allowed_question_classes_json       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  needs_replication_json              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  needs_independent_dataset_json      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  needs_traceability_repair_json      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  provenance_json                     JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS programme_state_snapshots_graph_user_idx
  ON programme_state_snapshots (graph_id, user_id, created_at DESC);

ALTER TABLE admissible_questions
  ADD COLUMN IF NOT EXISTS question_class TEXT NOT NULL DEFAULT 'generalization';

ALTER TABLE admissible_questions
  ADD COLUMN IF NOT EXISTS what_would_make_it_admissible TEXT;

ALTER TABLE admissible_questions
  ADD COLUMN IF NOT EXISTS trace_event_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE admissible_questions
  ADD COLUMN IF NOT EXISTS programme_state_snapshot_id UUID REFERENCES programme_state_snapshots(id) ON DELETE SET NULL;

ALTER TABLE admissible_questions
  ADD COLUMN IF NOT EXISTS review_needed BOOLEAN NOT NULL DEFAULT true;
