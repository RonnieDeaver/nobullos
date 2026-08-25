-- Task #4333 — Deal & lead scoring (deterministic fit + engagement).
-- Additive only; idempotent (safe under the dev-migration replay seam).
-- No seed rows: the default score config is lazily ensured at runtime by
-- server/storage/scoringStorage.ts (Publish diffs are structure-only, so
-- migration INSERTs would never reach production anyway).

CREATE TABLE IF NOT EXISTS score_configs (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type varchar(20) NOT NULL,
  score_min integer NOT NULL DEFAULT 0,
  score_max integer NOT NULL DEFAULT 100,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS score_configs_entity_type_uq ON score_configs (entity_type);

CREATE TABLE IF NOT EXISTS score_rules (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id varchar NOT NULL REFERENCES score_configs(id) ON DELETE CASCADE,
  kind varchar(12) NOT NULL,
  name text NOT NULL,
  points integer NOT NULL,
  position integer NOT NULL DEFAULT 0,
  criteria jsonb,
  event_type varchar(20),
  direction varchar(10),
  window_days integer,
  min_count integer,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now(),
  -- Rule shape is kind-discriminated: fit rules carry criteria, engagement
  -- rules carry an event spec. The zod schemas enforce this at the routes;
  -- this CHECK keeps hand-planted garbage out of the engine.
  CONSTRAINT score_rules_kind_shape CHECK (
    (kind = 'fit' AND criteria IS NOT NULL AND event_type IS NULL
      AND window_days IS NULL AND min_count IS NULL)
    OR (kind = 'engagement' AND criteria IS NULL AND event_type IS NOT NULL
      AND window_days IS NOT NULL AND min_count IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS score_rules_config_id_idx ON score_rules (config_id, position);

CREATE TABLE IF NOT EXISTS entity_scores (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type varchar(20) NOT NULL,
  entity_id varchar NOT NULL,
  score integer NOT NULL,
  fit_score integer NOT NULL,
  engagement_score integer NOT NULL,
  breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_scores_entity_uq ON entity_scores (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS entity_scores_type_score_idx ON entity_scores (entity_type, score);
