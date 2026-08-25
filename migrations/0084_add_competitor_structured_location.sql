-- Task #2020 — show real city/street labels for duplicate competitor
-- locations.
--
-- The Local Dominance "Market Share Leaderboard" disambiguates rows for
-- the same firm with multiple GBP locations via
-- `deriveCompetitorLocationLabel`. Until now the only stored input was
-- `competitor_gbp_url`, so when the GBP `/place/` fragment was absent the
-- label degraded to an opaque short-code hash ("GBP 3f2a1").
--
-- The SEMrush Map Rank Tracker top-competitors endpoint exposes each
-- business's location as a single free-text `address` string (e.g.
-- "123 W Madison St, Chicago, IL 60601, USA") — it does NOT break it
-- into locality/street sub-fields. We parse it best-effort at ingestion
-- (first comma segment → street, second → locality) and persist the
-- result so the leaderboard can render "Chicago / W Madison St".
--
-- Both columns are nullable and additive. Rows that pre-date this
-- migration (and rows whose source provided no address) keep the
-- existing GBP-URL-derived label.

ALTER TABLE heatmap_competitor_snapshots
  ADD COLUMN IF NOT EXISTS competitor_locality text,
  ADD COLUMN IF NOT EXISTS competitor_street text;
