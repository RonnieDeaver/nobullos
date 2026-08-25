-- Migration 0107: NoBull Sheets — role-based workbook grants.
-- Allows owners to grant access to all users with a given app role
-- (e.g. "all team_leads can view this workbook").

CREATE TABLE IF NOT EXISTS sheet_workbook_role_grants (
  id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  workbook_id VARCHAR NOT NULL REFERENCES sheet_workbooks(id) ON DELETE CASCADE,
  role        VARCHAR NOT NULL,  -- 'account_manager' | 'team_lead' | 'ceo'
  access_level VARCHAR NOT NULL DEFAULT 'viewer', -- 'viewer' | 'editor'
  granted_by  VARCHAR REFERENCES users(id),
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT sheet_workbook_role_grants_workbook_role_unique UNIQUE (workbook_id, role)
);

CREATE INDEX IF NOT EXISTS sheet_workbook_role_grants_workbook_id_idx ON sheet_workbook_role_grants(workbook_id);
