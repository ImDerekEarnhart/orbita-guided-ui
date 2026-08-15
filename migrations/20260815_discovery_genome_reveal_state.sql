-- Add the explicit frozen -> revealed tournament lifecycle transition.
-- This does not alter frozen manifests, prediction hashes, operator contracts,
-- or tournament manifest hashes. It only records an external reveal receipt.

ALTER TABLE discovery_tournaments
  ADD COLUMN IF NOT EXISTS reveal_json JSONB,
  ADD COLUMN IF NOT EXISTS reveal_hash TEXT;

ALTER TABLE discovery_tournaments
  DROP CONSTRAINT IF EXISTS discovery_tournaments_status_check;

ALTER TABLE discovery_tournaments
  ADD CONSTRAINT discovery_tournaments_status_check
  CHECK (status IN ('draft', 'frozen', 'revealed', 'running', 'completed', 'cancelled'));

ALTER TABLE discovery_tournaments
  DROP CONSTRAINT IF EXISTS discovery_tournaments_reveal_hash_check;

ALTER TABLE discovery_tournaments
  ADD CONSTRAINT discovery_tournaments_reveal_hash_check
  CHECK (reveal_hash IS NULL OR reveal_hash ~ '^[0-9a-f]{64}$');
