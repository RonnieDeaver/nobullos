-- Audit trail for work-queue timing setting changes (Task #485)
CREATE TABLE IF NOT EXISTS queue_timing_audit (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  changed_by varchar REFERENCES users(id),
  old_values jsonb,
  new_values jsonb NOT NULL,
  changed_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS queue_timing_audit_changed_at_idx
  ON queue_timing_audit (changed_at DESC);
