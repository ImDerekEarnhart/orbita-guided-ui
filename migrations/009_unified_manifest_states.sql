ALTER TABLE unified_case_migrations
  DROP CONSTRAINT IF EXISTS unified_case_migrations_status_check;

ALTER TABLE unified_case_migrations
  ADD CONSTRAINT unified_case_migrations_status_check CHECK (status IN (
    'inventoried', 'missing_legacy', 'copying', 'manifest_copied',
    'manifest_verified', 'evidence_copied', 'verified', 'failed'
  ));
