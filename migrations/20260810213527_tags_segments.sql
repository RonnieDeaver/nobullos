-- Task #4329 — Tags & segments engine.
-- Additive only; idempotent (safe under the dev-migration replay seam).
-- No seed rows: tags/segments are all operator-created, so production needs
-- only the structure (Publish diff) and dev/test only these CREATEs.
-- Lockstep with shared/models/tagsSegments.ts.

CREATE TABLE IF NOT EXISTS tags (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type varchar(10) NOT NULL,
  name varchar(80) NOT NULL,
  color varchar(7) NOT NULL,
  description text,
  criteria jsonb,
  last_evaluated_at timestamp,
  created_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tags_entity_type_name_uq ON tags (entity_type, name);

CREATE TABLE IF NOT EXISTS deal_tags (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id varchar NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  tag_id varchar NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source varchar(10) NOT NULL,
  applied_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS deal_tags_deal_tag_uq ON deal_tags (deal_id, tag_id);
CREATE INDEX IF NOT EXISTS deal_tags_tag_id_idx ON deal_tags (tag_id);

CREATE TABLE IF NOT EXISTS client_tags (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tag_id varchar NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source varchar(10) NOT NULL,
  applied_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS client_tags_client_tag_uq ON client_tags (client_id, tag_id);
CREATE INDEX IF NOT EXISTS client_tags_tag_id_idx ON client_tags (tag_id);

CREATE TABLE IF NOT EXISTS segments (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type varchar(10) NOT NULL,
  name varchar(80) NOT NULL,
  description text,
  criteria jsonb NOT NULL,
  member_count integer NOT NULL DEFAULT 0,
  last_evaluated_at timestamp,
  created_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS segments_entity_type_name_uq ON segments (entity_type, name);

CREATE TABLE IF NOT EXISTS segment_members (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id varchar NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  entity_id varchar NOT NULL,
  added_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS segment_members_segment_entity_uq ON segment_members (segment_id, entity_id);
CREATE INDEX IF NOT EXISTS segment_members_entity_id_idx ON segment_members (entity_id);
