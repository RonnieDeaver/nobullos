-- Task #4292: operator concern intel for the Churn Command Center.
--
-- Append-only log of operator responses to daily-judgment concerns:
-- "Add context" or "Mark resolved", with a required note. Written from the
-- leaderboard concern dialog (director-gated POST /api/churn/concern-intel),
-- embedded in the leaderboard payload, and fed into every future judgment
-- for the client (last 90 days) so a human-addressed concern stops being
-- re-flagged as unaddressed.
--
-- judgment_id is deliberately NOT a foreign key: judgments are superseded
-- daily and older rows can be cleaned up, but the operator's note must
-- outlive the specific judgment row it was filed against (concern TEXT is
-- what carries meaning across regenerations).
--
-- The composite index backs both hot reads (leaderboard embed across active
-- clients, per-client judgment build): client_id equality + created_at range,
-- newest first. Idempotent throughout (the replay test applies twice).

CREATE TABLE IF NOT EXISTS client_concern_intel (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  judgment_id varchar,
  concern_text text NOT NULL,
  intel_type varchar NOT NULL,
  note text NOT NULL,
  created_by varchar NOT NULL REFERENCES users(id),
  created_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_concern_intel_client_created_idx
  ON client_concern_intel (client_id, created_at);
