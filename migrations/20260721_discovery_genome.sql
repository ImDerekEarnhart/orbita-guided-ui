-- Orbita Discovery Genome foundation
-- Versioned executable discovery operators and hash-frozen blind tournaments.
-- All records are scoped to one authenticated user; no operator can promote
-- a research policy or alter a claim automatically.

CREATE TABLE IF NOT EXISTS discovery_operators (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operator_key       TEXT        NOT NULL,
  version            INTEGER     NOT NULL CHECK (version > 0),
  name               TEXT        NOT NULL,
  description        TEXT,
  status             TEXT        NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'review_needed', 'frozen', 'retired')),
  source_graph_id    TEXT,
  source_operator_id TEXT,
  contract_json      JSONB       NOT NULL,
  evidence_json      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  contract_hash      TEXT,
  frozen_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, operator_key, version),
  CHECK (contract_hash IS NULL OR contract_hash ~ '^[0-9a-f]{64}$'),
  CHECK (
    (status IN ('draft', 'review_needed') AND frozen_at IS NULL AND contract_hash IS NULL)
    OR
    (status IN ('frozen', 'retired') AND frozen_at IS NOT NULL AND contract_hash IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS discovery_operators_user_idx
  ON discovery_operators (user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS discovery_operators_source_idx
  ON discovery_operators (user_id, source_graph_id, source_operator_id);

CREATE TABLE IF NOT EXISTS discovery_operator_evidence (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operator_id        UUID        NOT NULL REFERENCES discovery_operators(id) ON DELETE CASCADE,
  case_id            TEXT        NOT NULL,
  domain             TEXT        NOT NULL,
  outcome            TEXT        NOT NULL
                                 CHECK (outcome IN ('supported', 'refuted', 'inconclusive', 'artifact')),
  independence_level TEXT        NOT NULL
                                 CHECK (independence_level IN ('same_case', 'same_family', 'cross_domain', 'external')),
  evidence_json      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  receipt_hash       TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (receipt_hash IS NULL OR receipt_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS discovery_operator_evidence_user_idx
  ON discovery_operator_evidence (user_id, operator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS discovery_operator_evidence_case_idx
  ON discovery_operator_evidence (user_id, case_id);

CREATE TABLE IF NOT EXISTS discovery_tournaments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'frozen', 'running', 'completed', 'cancelled')),
  target_json   JSONB       NOT NULL,
  manifest_json JSONB,
  manifest_hash TEXT,
  frozen_at     TIMESTAMPTZ,
  revealed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (manifest_hash IS NULL OR manifest_hash ~ '^[0-9a-f]{64}$'),
  CHECK (
    (status = 'draft' AND frozen_at IS NULL AND manifest_hash IS NULL)
    OR
    (status <> 'draft' AND frozen_at IS NOT NULL AND manifest_hash IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS discovery_tournaments_user_idx
  ON discovery_tournaments (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS discovery_tournament_entries (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id      UUID        NOT NULL REFERENCES discovery_tournaments(id) ON DELETE CASCADE,
  operator_id        UUID        NOT NULL REFERENCES discovery_operators(id),
  prediction_json    JSONB       NOT NULL,
  prediction_hash    TEXT        NOT NULL CHECK (prediction_hash ~ '^[0-9a-f]{64}$'),
  verdict            TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (verdict IN ('pending', 'survived', 'refuted', 'inconclusive')),
  result_json         JSONB,
  claims_affected     TEXT[]      NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluated_at        TIMESTAMPTZ,
  UNIQUE (tournament_id, operator_id)
);

CREATE INDEX IF NOT EXISTS discovery_tournament_entries_tournament_idx
  ON discovery_tournament_entries (tournament_id, verdict);
