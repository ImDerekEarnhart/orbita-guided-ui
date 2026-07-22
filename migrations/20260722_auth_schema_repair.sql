-- Repair drifted preview/staging auth schemas whose migration ledger may
-- record 002/003 even when individual columns or tables are absent.
-- The source migrations are idempotent; reapplying them preserves existing data.

-- Migration 002: public-beta additions
-- Adds email verification, password reset, quota tracking, run jobs,
-- IP blocks, and new user status values.

-- ── Extend users table ────────────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_reason   TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at         TIMESTAMPTZ;

-- Extend status domain to include 'suspended'
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active','disabled','suspended','deleted'));

-- ── Email verification tokens ─────────────────────────────────────────────────
-- Only the SHA-256 hash is stored; plaintext is emailed and discarded.
CREATE TABLE IF NOT EXISTS email_verifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_verifications_user_idx
  ON email_verifications (user_id, created_at DESC);

-- ── Password reset tokens ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_resets (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx
  ON password_resets (user_id, created_at DESC);

-- ── Per-user quota tracking ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_quota (
  user_id             UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  runs_today          INTEGER     NOT NULL DEFAULT 0,
  runs_today_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
  concurrent_runs     INTEGER     NOT NULL DEFAULT 0,
  total_cases         INTEGER     NOT NULL DEFAULT 0,
  total_storage_bytes BIGINT      NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Async run jobs ────────────────────────────────────────────────────────────
-- Tracks each discovery run: queued → running → completed/failed.
-- pg-boss handles the actual job queue; this table stores results for polling.
CREATE TABLE IF NOT EXISTS run_jobs (
  id             TEXT        PRIMARY KEY,  -- matches Orbita backend run_id
  user_id        UUID        NOT NULL REFERENCES users(id),
  orbita_case_id TEXT        NOT NULL,
  pgboss_job_id  UUID,
  status         TEXT        NOT NULL DEFAULT 'queued'
                             CHECK (status IN ('queued','running','completed','failed','cancelled')),
  result_json    JSONB,
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  timeout_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS run_jobs_user_idx    ON run_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS run_jobs_case_idx    ON run_jobs (orbita_case_id);
CREATE INDEX IF NOT EXISTS run_jobs_status_idx  ON run_jobs (status) WHERE status IN ('queued','running');

-- ── IP blocks / signup blocks ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_blocks (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ip         TEXT        NOT NULL UNIQUE,
  reason     TEXT,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- ── Admin flags (feature switches) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_flags (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL DEFAULT 'false',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID        REFERENCES users(id)
);

-- Seed conservative defaults (all paused until admin enables)
INSERT INTO admin_flags (key, value) VALUES
  ('registrations_open',  'false'),
  ('uploads_open',        'true'),
  ('runs_open',           'true'),
  ('max_cases_per_user',  '3'),
  ('max_runs_per_day',    '2'),
  ('max_concurrent_runs', '1'),
  ('max_csv_bytes',       '52428800'),
  ('max_csv_rows',        '250000'),
  ('max_storage_bytes',   '524288000'),
  ('global_max_concurrent_runs', '5')
ON CONFLICT (key) DO NOTHING;


-- Add role column for database-backed admin authorization.
-- Usernames must not grant admin access.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

-- Add constraint only if it does not already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_role_check' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);


-- Earlier PR-preview startup hardening may have created ip_blocks without the
-- canonical surrogate id. Add it non-destructively for schema compatibility.
ALTER TABLE ip_blocks
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

UPDATE ip_blocks SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE ip_blocks ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ip_blocks_id_idx ON ip_blocks (id);
