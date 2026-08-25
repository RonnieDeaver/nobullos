-- Task #4024 — NoBull Docs (in-app document editor).
--
-- Word-processing documents edited with Univer's document preset. The
-- persistence stack mirrors NoBull Sheets: JSONB snapshot + revision guard,
-- single-active-editor lock with heartbeat, version snapshots with restore
-- points, and a per-document activity log. `client_id` optionally links a
-- document to a client so it surfaces in that client's Files tab.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS doc_documents (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id varchar NOT NULL REFERENCES users(id),
  client_id varchar REFERENCES clients(id) ON DELETE SET NULL,
  snapshot jsonb,
  snapshot_size_bytes integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS doc_documents_owner_id_idx
  ON doc_documents (owner_id);

CREATE INDEX IF NOT EXISTS doc_documents_client_id_idx
  ON doc_documents (client_id);

CREATE TABLE IF NOT EXISTS doc_document_locks (
  document_id varchar PRIMARY KEY REFERENCES doc_documents(id) ON DELETE CASCADE,
  holder_user_id varchar NOT NULL REFERENCES users(id),
  holder_name text NOT NULL,
  acquired_at timestamp NOT NULL DEFAULT now(),
  heartbeat_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS doc_document_locks_expires_at_idx
  ON doc_document_locks (expires_at);

CREATE TABLE IF NOT EXISTS doc_document_versions (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id varchar NOT NULL REFERENCES doc_documents(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL,
  snapshot_size_bytes integer NOT NULL DEFAULT 0,
  created_by varchar REFERENCES users(id),
  label text,
  is_restore_point boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS doc_document_versions_document_id_idx
  ON doc_document_versions (document_id);

CREATE INDEX IF NOT EXISTS doc_document_versions_document_created_at_idx
  ON doc_document_versions (document_id, created_at);

CREATE TABLE IF NOT EXISTS doc_document_activity (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id varchar NOT NULL REFERENCES doc_documents(id) ON DELETE CASCADE,
  actor_id varchar REFERENCES users(id) ON DELETE SET NULL,
  actor_name text NOT NULL DEFAULT '',
  action varchar NOT NULL,
  detail jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS doc_document_activity_document_id_idx
  ON doc_document_activity (document_id);

CREATE INDEX IF NOT EXISTS doc_document_activity_document_created_at_idx
  ON doc_document_activity (document_id, created_at);
