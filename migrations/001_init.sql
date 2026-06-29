-- Orbita Alpha — initial schema
-- All timestamps are TIMESTAMPTZ (UTC). gen_random_uuid() requires pgcrypto (available by default in Railway Postgres 14+).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL,
  username      TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx    ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

-- ── Invitations ───────────────────────────────────────────────────────────────
-- Only the SHA-256 hash of the code is stored; the plaintext is shown once on creation.
CREATE TABLE IF NOT EXISTS invitations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash        TEXT        NOT NULL UNIQUE,
  invited_email    TEXT,                        -- if set, only this email may use it
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ,
  used_at          TIMESTAMPTZ,
  used_by_user_id  UUID        REFERENCES users(id),
  max_uses         INTEGER     NOT NULL DEFAULT 1,
  use_count        INTEGER     NOT NULL DEFAULT 0,
  status           TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'disabled', 'exhausted')),
  note             TEXT                         -- admin label, e.g. "Diya's invite"
);

-- ── Case ownership ────────────────────────────────────────────────────────────
-- Maps frontend users to backend Orbita case IDs.
CREATE TABLE IF NOT EXISTS orbita_cases (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id),
  orbita_case_id TEXT        NOT NULL UNIQUE,
  name           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS orbita_cases_user_idx    ON orbita_cases (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS orbita_cases_case_id_idx ON orbita_cases (orbita_case_id);

-- ── Resource ownership (files, runs, plans) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS orbita_resources (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id),
  orbita_case_id TEXT        NOT NULL,
  resource_type  TEXT        NOT NULL,   -- 'file' | 'run' | 'plan'
  resource_id    TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS orbita_resources_user_case_idx ON orbita_resources (user_id, orbita_case_id);

-- ── Session store (connect-pg-simple) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR     NOT NULL COLLATE "default",
  "sess"   JSON        NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL,
  PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
) WITH (OIDS=FALSE);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- ── Audit events ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_events (
  id         BIGSERIAL   PRIMARY KEY,
  user_id    UUID        REFERENCES users(id),
  event_type TEXT        NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_user_idx  ON audit_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_type_idx  ON audit_events (event_type, created_at DESC);

-- ── Schema migrations tracker ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT        PRIMARY KEY,
  run_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
