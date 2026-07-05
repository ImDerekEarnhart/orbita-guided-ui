-- Migration 004: Phase 2A memory-graph foundation (private-only MVP)
-- Additive and idempotent. No existing tables are modified.

-- ── Memory graphs ─────────────────────────────────────────────────────────────
-- A governed claim scope. MVP: private scope only, case/project kinds only.
CREATE TABLE IF NOT EXISTS memory_graphs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   UUID        NOT NULL REFERENCES users(id),
  name            TEXT        NOT NULL,
  description     TEXT,
  scope           TEXT        NOT NULL DEFAULT 'private'
                              CHECK (scope IN ('private')),
  kind            TEXT        NOT NULL DEFAULT 'case'
                              CHECK (kind IN ('case', 'project')),
  parent_graph_id UUID        REFERENCES memory_graphs(id),
  is_locked       BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS memory_graphs_owner_idx
  ON memory_graphs (owner_user_id) WHERE deleted_at IS NULL;

-- ── Promotion policy per graph ────────────────────────────────────────────────
-- Gates for claims entering this graph. Enforced in later phases; recorded now.
CREATE TABLE IF NOT EXISTS graph_scope_policy (
  graph_id                UUID    PRIMARY KEY REFERENCES memory_graphs(id) ON DELETE CASCADE,
  min_verdict             TEXT    NOT NULL DEFAULT 'committed',
  require_manual_approval BOOLEAN NOT NULL DEFAULT true,
  allow_provisional       BOOLEAN NOT NULL DEFAULT false
);

-- ── Case ↔ graph links ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS graph_case_links (
  graph_id   UUID        NOT NULL REFERENCES memory_graphs(id) ON DELETE CASCADE,
  case_id    TEXT        NOT NULL,
  user_id    UUID        NOT NULL REFERENCES users(id),
  mode       TEXT        NOT NULL DEFAULT 'home'
                         CHECK (mode IN ('home', 'contributes', 'reference')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (case_id, graph_id)
);

CREATE INDEX IF NOT EXISTS graph_case_links_graph_idx ON graph_case_links (graph_id);
CREATE INDEX IF NOT EXISTS graph_case_links_case_idx  ON graph_case_links (case_id);

-- ── Dataset registry ──────────────────────────────────────────────────────────
-- One row per uploaded dataset, with its epistemic role for the case.
CREATE TABLE IF NOT EXISTS datasets (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id),
  case_id         TEXT        NOT NULL,
  graph_id        UUID        REFERENCES memory_graphs(id),
  backend_file_id TEXT        NOT NULL,
  role            TEXT        NOT NULL DEFAULT 'primary'
                              CHECK (role IN ('primary', 'confirmation', 'counterexample', 'regime', 'benchmark')),
  source          TEXT        NOT NULL DEFAULT 'upload',
  profile_json    JSONB,
  sha256          TEXT,
  size_bytes      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS datasets_user_case_idx ON datasets (user_id, case_id);
CREATE INDEX IF NOT EXISTS datasets_graph_idx     ON datasets (graph_id);

-- ── Operator registry (PLACEHOLDER — no routes, no execution in Phase 2A) ─────
-- Reserved for the versioned plugin/operator architecture (Phase 2D).
CREATE TABLE IF NOT EXISTS operators (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id     TEXT        NOT NULL,
  version         TEXT        NOT NULL,
  spec_json       JSONB       NOT NULL,
  artifact_sha256 TEXT,
  status          TEXT        NOT NULL DEFAULT 'proposed'
                              CHECK (status IN ('proposed', 'benchmarked', 'enabled', 'disabled', 'rolled_back')),
  created_by      UUID        REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (operator_id, version)
);
