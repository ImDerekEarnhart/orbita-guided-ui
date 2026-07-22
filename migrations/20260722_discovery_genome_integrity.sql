-- Persist the exact tenant-scoped tournament result operation reviewed by MCP.
-- Existing rows remain nullable; all new MCP/browser result writes persist a SHA-256 receipt.

ALTER TABLE discovery_tournament_entries
  ADD COLUMN IF NOT EXISTS result_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'discovery_tournament_entries_result_hash_check'
      AND conrelid = 'discovery_tournament_entries'::regclass
  ) THEN
    ALTER TABLE discovery_tournament_entries
      ADD CONSTRAINT discovery_tournament_entries_result_hash_check
      CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;
