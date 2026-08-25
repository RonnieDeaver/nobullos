-- Task #4053: per-user sharing grants for NoBull Docs.
-- Mirrors sheet_workbook_permissions (Task #4024's Sheets counterpart),
-- minus the "owner" grant level: role is 'viewer' | 'editor' only.
-- Idempotent so a manual psql -f apply and the boot-time migration runner
-- can both run it safely.

CREATE TABLE IF NOT EXISTS doc_document_permissions (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id varchar NOT NULL REFERENCES doc_documents(id) ON DELETE CASCADE,
  user_id varchar NOT NULL REFERENCES users(id),
  role varchar NOT NULL DEFAULT 'viewer',
  granted_by varchar REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT doc_document_permissions_document_user_unique UNIQUE (document_id, user_id)
);

CREATE INDEX IF NOT EXISTS doc_document_permissions_document_id_idx
  ON doc_document_permissions (document_id);

CREATE INDEX IF NOT EXISTS doc_document_permissions_user_id_idx
  ON doc_document_permissions (user_id);
