-- Ensure the authentication abuse-control table exists in fresh preview databases.
-- This migration is idempotent and does not modify existing rows or production data.

CREATE TABLE IF NOT EXISTS ip_blocks (
  ip         TEXT        PRIMARY KEY,
  reason     TEXT,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ip_blocks_expires_at_idx
  ON ip_blocks (expires_at)
  WHERE expires_at IS NOT NULL;
