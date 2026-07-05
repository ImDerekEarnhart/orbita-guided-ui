-- Migration 005: Phase 2D-A reviewable cross-domain operator proposals.
-- Additive and idempotent. Proposals are scoped to private memory graphs.

CREATE TABLE IF NOT EXISTS operator_proposals (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id              UUID        NOT NULL REFERENCES memory_graphs(id) ON DELETE CASCADE,
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operator_id           TEXT        NOT NULL,
  name                  TEXT        NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'proposed'
                                      CHECK (status IN ('proposed', 'review_needed', 'dismissed')),
  description           TEXT        NOT NULL,
  pattern_json          JSONB       NOT NULL DEFAULT '{}',
  evidence_json         JSONB       NOT NULL DEFAULT '{}',
  counterexample_json   JSONB       NOT NULL DEFAULT '{}',
  supporting_case_ids   TEXT[]      NOT NULL DEFAULT '{}',
  supporting_claim_ids  TEXT[]      NOT NULL DEFAULT '{}',
  counterexample_ids    TEXT[]      NOT NULL DEFAULT '{}',
  score                 NUMERIC     NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (graph_id, user_id, operator_id)
);

CREATE INDEX IF NOT EXISTS operator_proposals_graph_user_idx
  ON operator_proposals (graph_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS operator_proposals_supporting_cases_idx
  ON operator_proposals USING GIN (supporting_case_ids);
