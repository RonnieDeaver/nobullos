-- Task #4337 — Campaigns, UTM capture and attribution.
--
-- Additive only:
--   1. Raw UTM/referrer capture columns on the two public intake tables
--      (website_inquiries, scheduled_meetings).
--   2. Immutable first-touch stamps on clients and deals (server-owned,
--      written once at creation; NULL = pre-feature/operator-created rows,
--      rendered as "Unknown").
--   3. marketing_campaigns + campaign_links. Attribution joins campaigns by
--      the normalized utm_campaign STRING key (not FK) so late-created
--      campaigns claim existing history and deletes never orphan leads.
--
-- Idempotent throughout (replay seam re-applies migrations).

ALTER TABLE website_inquiries
  ADD COLUMN IF NOT EXISTS utm_source varchar(200),
  ADD COLUMN IF NOT EXISTS utm_medium varchar(200),
  ADD COLUMN IF NOT EXISTS utm_campaign varchar(200),
  ADD COLUMN IF NOT EXISTS utm_term varchar(200),
  ADD COLUMN IF NOT EXISTS utm_content varchar(200),
  ADD COLUMN IF NOT EXISTS referrer text;

ALTER TABLE scheduled_meetings
  ADD COLUMN IF NOT EXISTS utm_source varchar(200),
  ADD COLUMN IF NOT EXISTS utm_medium varchar(200),
  ADD COLUMN IF NOT EXISTS utm_campaign varchar(200),
  ADD COLUMN IF NOT EXISTS utm_term varchar(200),
  ADD COLUMN IF NOT EXISTS utm_content varchar(200),
  ADD COLUMN IF NOT EXISTS referrer text;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS first_touch_source varchar(80),
  ADD COLUMN IF NOT EXISTS first_touch_campaign varchar(120);

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS first_touch_source varchar(80),
  ADD COLUMN IF NOT EXISTS first_touch_campaign varchar(120);

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  utm_campaign varchar(120) NOT NULL,
  start_date date,
  end_date date,
  notes text,
  is_archived boolean NOT NULL DEFAULT false,
  created_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS marketing_campaigns_utm_campaign_key
  ON marketing_campaigns (utm_campaign);

CREATE TABLE IF NOT EXISTS campaign_links (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id varchar NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  label text,
  destination_url text NOT NULL,
  utm_source varchar(200),
  utm_medium varchar(200),
  utm_term varchar(200),
  utm_content varchar(200),
  created_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_links_campaign_idx
  ON campaign_links (campaign_id);

-- Campaign detail lookups by key; stamped rows are a minority → partial.
CREATE INDEX IF NOT EXISTS clients_first_touch_campaign_idx
  ON clients (first_touch_campaign) WHERE first_touch_campaign IS NOT NULL;

CREATE INDEX IF NOT EXISTS deals_first_touch_campaign_idx
  ON deals (first_touch_campaign) WHERE first_touch_campaign IS NOT NULL;
