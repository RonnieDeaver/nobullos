-- Task #4392: expression index backing the client_file_share_links_dead
-- retention unit in server/services/tableMaintenancePolicy.ts. The pruner's
-- eligibility predicate is LEAST(expires_at, COALESCE(revoked_at, expires_at))
-- < cutoff (a link is dead at min(expiry, revocation)); without this index
-- every capped count and batch-delete subselect is a seq scan. Idempotent
-- (replay-safe).
CREATE INDEX IF NOT EXISTS idx_client_file_share_links_dead_at
  ON client_file_share_links (LEAST(expires_at, COALESCE(revoked_at, expires_at)));
