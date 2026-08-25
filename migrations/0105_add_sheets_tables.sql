-- Migration 0105: NoBull Sheets — workbook folders, workbooks, and per-workbook permissions.

CREATE TABLE IF NOT EXISTS sheet_folders (
  id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT    NOT NULL,
  owner_id    VARCHAR NOT NULL REFERENCES users(id),
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sheet_workbooks (
  id                  VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT    NOT NULL,
  folder_id           VARCHAR REFERENCES sheet_folders(id),
  owner_id            VARCHAR NOT NULL REFERENCES users(id),
  snapshot            JSONB,
  snapshot_size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sheet_workbooks_owner_id_idx  ON sheet_workbooks(owner_id);
CREATE INDEX IF NOT EXISTS sheet_workbooks_folder_id_idx ON sheet_workbooks(folder_id);

CREATE TABLE IF NOT EXISTS sheet_workbook_permissions (
  id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  workbook_id VARCHAR NOT NULL REFERENCES sheet_workbooks(id) ON DELETE CASCADE,
  user_id     VARCHAR NOT NULL REFERENCES users(id),
  role        VARCHAR NOT NULL DEFAULT 'viewer',
  granted_by  VARCHAR REFERENCES users(id),
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT sheet_workbook_permissions_workbook_user_unique UNIQUE (workbook_id, user_id)
);

CREATE INDEX IF NOT EXISTS sheet_workbook_permissions_workbook_id_idx ON sheet_workbook_permissions(workbook_id);
CREATE INDEX IF NOT EXISTS sheet_workbook_permissions_user_id_idx     ON sheet_workbook_permissions(user_id);
