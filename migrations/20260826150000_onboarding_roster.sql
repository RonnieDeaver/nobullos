-- Task #5295 — Onboarding roster & default person (stage 1 of the New Client
-- Onboarding epic). Company-wide list of onboarding assignees; at most one
-- may be the default, enforced by a partial unique index.
CREATE TABLE IF NOT EXISTS onboarding_assignees (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL,
  active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS onboarding_assignees_user_uniq
  ON onboarding_assignees (user_id);
CREATE INDEX IF NOT EXISTS onboarding_assignees_active_idx
  ON onboarding_assignees (active);
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_assignees_default_uniq
  ON onboarding_assignees (is_default)
  WHERE is_default = true;
