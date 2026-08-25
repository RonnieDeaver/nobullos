-- Task #3152 — keep the published-dashboards table publish-safe.
-- sheet_workbook_dashboards is created lazily at runtime by
-- ensureWorkbookDashboardsTable() in server/storage/sheetsStorage.ts and is
-- deliberately NOT in shared/schema.ts. Because Publish diffs the dev DB
-- against prod, the table must always exist in dev or a publish proposes
-- DROPPING it from production. This migration mirrors the runtime DDL
-- exactly. Fully idempotent; safe to re-apply.

CREATE TABLE IF NOT EXISTS sheet_workbook_dashboards (
  workbook_id varchar PRIMARY KEY REFERENCES sheet_workbooks(id) ON DELETE CASCADE,
  title text NOT NULL,
  published_by varchar NOT NULL REFERENCES users(id),
  published_at timestamp NOT NULL DEFAULT now(),
  tabs jsonb NOT NULL DEFAULT '[]'::jsonb,
  audience_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  audience_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sheet_workbook_dashboards_published_by_idx
  ON sheet_workbook_dashboards (published_by);
