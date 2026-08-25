-- Audit trail for stale lease alert threshold changes (Task #401)
CREATE TABLE IF NOT EXISTS stale_lease_threshold_audit (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  changed_by varchar REFERENCES users(id),
  old_values jsonb,
  new_values jsonb NOT NULL,
  changed_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stale_lease_threshold_audit_changed_at_idx
  ON stale_lease_threshold_audit (changed_at DESC);
