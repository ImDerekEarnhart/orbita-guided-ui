-- Migration 006: Phase 2D-B / 2F-A review workflow and research trace.
-- Additive, graph-scoped, and review-only. No claim/operator execution state is mutated.

CREATE TABLE IF NOT EXISTS review_items (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id                    UUID        NOT NULL REFERENCES memory_graphs(id) ON DELETE CASCADE,
  user_id                     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type                 TEXT        NOT NULL CHECK (target_type IN ('operator', 'module', 'question')),
  target_id                   TEXT        NOT NULL,
  review_status               TEXT        NOT NULL DEFAULT 'proposed'
                                          CHECK (review_status IN (
                                            'proposed',
                                            'under_review',
                                            'accepted_candidate',
                                            'rejected',
                                            'needs_more_evidence',
                                            'deprecated'
                                          )),
  review_notes                TEXT,
  reviewed_by                 UUID        REFERENCES users(id),
  reviewed_at                 TIMESTAMPTZ,
  promotion_criteria_json     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  evidence_requirements_json  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  checklist_json              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (graph_id, user_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS review_items_graph_user_idx
  ON review_items (graph_id, user_id, target_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS review_events (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  review_item_id    UUID        NOT NULL REFERENCES review_items(id) ON DELETE CASCADE,
  graph_id          UUID        NOT NULL REFERENCES memory_graphs(id) ON DELETE CASCADE,
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type       TEXT        NOT NULL,
  target_id         TEXT        NOT NULL,
  from_status       TEXT,
  to_status         TEXT        NOT NULL,
  notes             TEXT,
  checklist_json    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS review_events_graph_user_idx
  ON review_events (graph_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS research_trace_events (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id                    UUID        NOT NULL REFERENCES memory_graphs(id) ON DELETE CASCADE,
  user_id                     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id                     TEXT,
  run_id                      TEXT,
  parent_event_id             UUID        REFERENCES research_trace_events(id) ON DELETE SET NULL,
  event_type                  TEXT        NOT NULL,
  title                       TEXT        NOT NULL,
  description                 TEXT,
  source_type                 TEXT,
  source_ref_id               TEXT,
  evidence_refs_json          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  claim_refs_json             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  counterexample_refs_json    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  module_refs_json            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  operator_refs_json          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  traceability_status         TEXT        NOT NULL DEFAULT 'open',
  decision_status             TEXT        NOT NULL DEFAULT 'review_needed',
  stopping_rule_json          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  carry_forward_object_json   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  admissibility_effect        TEXT        NOT NULL DEFAULT 'none'
                                          CHECK (admissibility_effect IN (
                                            'permits_question',
                                            'blocks_question',
                                            'narrows_question',
                                            'requires_more_evidence',
                                            'requires_traceability_repair',
                                            'records_stopping_point',
                                            'none'
                                          )),
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS research_trace_events_graph_user_idx
  ON research_trace_events (graph_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admissible_questions (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id                    UUID        NOT NULL REFERENCES memory_graphs(id) ON DELETE CASCADE,
  user_id                     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id                 TEXT        NOT NULL,
  question_text               TEXT        NOT NULL,
  status                      TEXT        NOT NULL
                                          CHECK (status IN (
                                            'admissible',
                                            'possible',
                                            'interesting',
                                            'blocked',
                                            'needs_more_evidence',
                                            'needs_traceability_repair'
                                          )),
  why_allowed                 TEXT,
  why_blocked                 TEXT,
  evidence_refs_json          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  counterexample_refs_json    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  related_module_refs_json    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  related_operator_refs_json  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  suggested_next_action       TEXT,
  provenance_json             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  review_status               TEXT        NOT NULL DEFAULT 'proposed'
                                          CHECK (review_status IN (
                                            'proposed',
                                            'under_review',
                                            'accepted_candidate',
                                            'rejected',
                                            'needs_more_evidence',
                                            'deprecated'
                                          )),
  review_notes                TEXT,
  reviewed_by                 UUID        REFERENCES users(id),
  reviewed_at                 TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (graph_id, user_id, question_id)
);

CREATE INDEX IF NOT EXISTS admissible_questions_graph_user_idx
  ON admissible_questions (graph_id, user_id, created_at DESC);
