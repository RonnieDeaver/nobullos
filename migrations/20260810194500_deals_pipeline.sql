-- Task #4327 — Deals pipeline foundation.
-- Additive only; idempotent (safe under the dev-migration replay seam).
-- Seed rows here cover dev/test databases; production receives structure via
-- the Publish diff and rows via the lazy runtime ensure in
-- server/storage/dealsStorage.ts (lockstep with shared/models/deals.ts).

CREATE TABLE IF NOT EXISTS deal_pipelines (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(80) NOT NULL,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS deal_pipelines_slug_uq ON deal_pipelines (slug);

CREATE TABLE IF NOT EXISTS deal_stages (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id varchar NOT NULL REFERENCES deal_pipelines(id) ON DELETE CASCADE,
  slug varchar(80) NOT NULL,
  name text NOT NULL,
  position integer NOT NULL,
  win_probability integer NOT NULL DEFAULT 0,
  stage_type varchar(10) NOT NULL DEFAULT 'open',
  required_fields text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS deal_stages_pipeline_slug_uq ON deal_stages (pipeline_id, slug);
CREATE INDEX IF NOT EXISTS deal_stages_pipeline_position_idx ON deal_stages (pipeline_id, position);

CREATE TABLE IF NOT EXISTS deals (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id varchar NOT NULL REFERENCES deal_pipelines(id),
  stage_id varchar NOT NULL REFERENCES deal_stages(id),
  name text NOT NULL,
  client_id varchar REFERENCES clients(id) ON DELETE SET NULL,
  amount real,
  expected_close_date date,
  owner_id varchar REFERENCES users(id) ON DELETE SET NULL,
  lost_reason text,
  notes text,
  is_archived boolean NOT NULL DEFAULT false,
  stage_entered_at timestamp NOT NULL DEFAULT now(),
  created_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deals_pipeline_stage_idx ON deals (pipeline_id, stage_id);
CREATE INDEX IF NOT EXISTS deals_client_id_idx ON deals (client_id);
CREATE INDEX IF NOT EXISTS deals_owner_id_idx ON deals (owner_id);

CREATE TABLE IF NOT EXISTS deal_contacts (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id varchar NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id varchar NOT NULL REFERENCES client_contacts(id) ON DELETE CASCADE,
  created_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS deal_contacts_deal_contact_uq ON deal_contacts (deal_id, contact_id);
CREATE INDEX IF NOT EXISTS deal_contacts_deal_id_idx ON deal_contacts (deal_id);

CREATE TABLE IF NOT EXISTS deal_stage_history (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id varchar NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  from_stage_id varchar REFERENCES deal_stages(id),
  to_stage_id varchar NOT NULL REFERENCES deal_stages(id),
  moved_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  moved_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_stage_history_deal_moved_idx ON deal_stage_history (deal_id, moved_at);

-- Seed the default "Sales" pipeline (dev/test; prod self-seeds at runtime).
INSERT INTO deal_pipelines (slug, name, is_default, position)
VALUES ('sales', 'Sales', true, 0)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO deal_stages (pipeline_id, slug, name, position, win_probability, stage_type, required_fields)
SELECT p.id, s.slug, s.name, s.position, s.win_probability, s.stage_type, s.required_fields::text[]
FROM deal_pipelines p
CROSS JOIN (
  VALUES
    ('new-opportunity', 'New Opportunity', 1, 10, 'open', '{}'),
    ('discovery-call', 'Discovery Call', 2, 25, 'open', '{}'),
    ('proposal-sent', 'Proposal Sent', 3, 50, 'open', '{amount}'),
    ('negotiation', 'Negotiation', 4, 75, 'open', '{amount,expected_close_date}'),
    ('closed-won', 'Closed Won', 5, 100, 'won', '{amount}'),
    ('closed-lost', 'Closed Lost', 6, 0, 'lost', '{lost_reason}')
) AS s(slug, name, position, win_probability, stage_type, required_fields)
WHERE p.slug = 'sales'
ON CONFLICT (pipeline_id, slug) DO NOTHING;
