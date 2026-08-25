-- Source-aware matching threshold settings layer (Task #417)
CREATE TABLE IF NOT EXISTS agent_match_settings (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  source varchar NOT NULL DEFAULT 'default',
  setting_key varchar NOT NULL,
  value real NOT NULL,
  updated_by varchar REFERENCES users(id),
  updated_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT agent_match_settings_source_key_uq UNIQUE (source, setting_key)
);

CREATE TABLE IF NOT EXISTS agent_match_setting_history (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  source varchar NOT NULL,
  setting_key varchar NOT NULL,
  old_value real,
  new_value real,
  changed_by varchar REFERENCES users(id),
  changed_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_match_setting_history_source_key_idx
  ON agent_match_setting_history (source, setting_key);

CREATE INDEX IF NOT EXISTS agent_match_setting_history_changed_at_idx
  ON agent_match_setting_history (changed_at);
