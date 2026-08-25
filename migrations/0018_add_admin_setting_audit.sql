-- Generic audit trail for admin-tunable settings (Task #466)
-- One row per change. settingKey identifies the setting family; scope optionally
-- narrows it (e.g. category name for per-category settings).
CREATE TABLE IF NOT EXISTS admin_setting_audit (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key varchar(128) NOT NULL,
  scope varchar(128),
  changed_by varchar REFERENCES users(id),
  old_values jsonb,
  new_values jsonb,
  changed_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_setting_audit_key_time_idx
  ON admin_setting_audit (setting_key, changed_at DESC);

CREATE INDEX IF NOT EXISTS admin_setting_audit_key_scope_time_idx
  ON admin_setting_audit (setting_key, scope, changed_at DESC);
