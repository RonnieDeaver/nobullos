-- Task #3695: going-quiet client detector — daily per-client engagement
-- snapshots (counts, own-baseline comparison, quiet score, flag, reasons).
-- Constraint names match Drizzle's conventions (shared/models/engagement.ts)
-- so a later `db:push` introspection sees no rename. Idempotent.
CREATE TABLE IF NOT EXISTS client_engagement_snapshots (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL,
  snapshot_date varchar NOT NULL,
  inbound_recent integer NOT NULL DEFAULT 0,
  outbound_recent integer NOT NULL DEFAULT 0,
  inbound_30d integer NOT NULL DEFAULT 0,
  outbound_30d integer NOT NULL DEFAULT 0,
  baseline_weekly_inbound real,
  recent_weekly_inbound real,
  drop_pct real,
  days_since_last_inbound integer,
  days_since_last_call_meeting integer,
  days_since_last_viewed integer,
  history_days integer,
  quiet_score real NOT NULL DEFAULT 0,
  is_flagged boolean NOT NULL DEFAULT false,
  insufficient_history boolean NOT NULL DEFAULT false,
  reasons_json jsonb,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now(),
  CONSTRAINT client_engagement_snapshots_client_id_snapshot_date_unique UNIQUE (client_id, snapshot_date),
  CONSTRAINT client_engagement_snapshots_client_id_clients_id_fk
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS client_engagement_snapshots_client_idx
  ON client_engagement_snapshots (client_id);
CREATE INDEX IF NOT EXISTS client_engagement_snapshots_date_idx
  ON client_engagement_snapshots (snapshot_date);
CREATE INDEX IF NOT EXISTS client_engagement_snapshots_client_date_idx
  ON client_engagement_snapshots (client_id, snapshot_date);
CREATE INDEX IF NOT EXISTS client_engagement_snapshots_flagged_date_idx
  ON client_engagement_snapshots (is_flagged, snapshot_date);
