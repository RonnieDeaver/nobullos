-- Task #4330 — Lead intake and lifecycle stages.
--
-- Adds the account lifecycle stage to clients (lead → session_booked →
-- opportunity → customer, forward-only automatic advancement). The
-- DEFAULT 'customer' IS the backfill: every pre-existing row becomes a
-- customer atomically with the column add, and every pre-existing write
-- path keeps producing operational (customer) rows unchanged. Prospect
-- rows are created only by the lead-intake paths.
--
-- client_lifecycle_history mirrors deal_stage_history: append-only audit
-- of every transition (changed_by_user_id null = system hook, set =
-- manual correction). Backfilled customers have no history rows.
--
-- website_inquiries.lead_client_id links a contact inquiry to the lead
-- record it created or matched.
--
-- Idempotent (IF NOT EXISTS everywhere) — safe under the post-merge
-- replay seam. Structure-only: no INSERTs (Publish diffs are
-- structure-only; there is no seed data here anyway).

ALTER TABLE clients ADD COLUMN IF NOT EXISTS lifecycle_stage varchar NOT NULL DEFAULT 'customer';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS lead_source varchar;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS lead_last_activity_at timestamp;

-- Prospects are a tiny minority of rows; a partial index keeps Leads-view
-- scans indexed without bloating the customer-majority table.
CREATE INDEX IF NOT EXISTS clients_lifecycle_prospect_idx
  ON clients (lifecycle_stage)
  WHERE lifecycle_stage <> 'customer';

CREATE TABLE IF NOT EXISTS client_lifecycle_history (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  from_stage varchar,
  to_stage varchar NOT NULL,
  changed_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  source varchar(32) NOT NULL,
  reason text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_lifecycle_history_client_created_idx
  ON client_lifecycle_history (client_id, created_at);

ALTER TABLE website_inquiries ADD COLUMN IF NOT EXISTS lead_client_id varchar REFERENCES clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_website_inquiries_lead_client
  ON website_inquiries (lead_client_id);
