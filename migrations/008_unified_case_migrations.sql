-- Durable, non-destructive receipts for moving inherited Guided cases into the
-- unified Orbita core. Legacy rows and files remain immutable source evidence.
CREATE TABLE IF NOT EXISTS unified_case_migrations (
  legacy_case_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  core_case_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'inventoried', 'missing_legacy', 'copying', 'copied', 'verified', 'failed'
  )),
  manifest_hash TEXT,
  manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS unified_case_migrations_user_idx
  ON unified_case_migrations(user_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS unified_case_migrations_core_case_idx
  ON unified_case_migrations(core_case_id)
  WHERE core_case_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS unified_migration_runs (
  id UUID PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('audit', 'copy', 'verify')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  manifest_hash TEXT,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
