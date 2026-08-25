-- Task #4023 — In-app client file storage: per-client folders, files,
-- prior versions, and an activity log.
--
-- Content model: `client_files.object_key` always points at the CURRENT
-- bytes; `client_file_versions` rows hold PRIOR bytes only. Version restore
-- SWAPS keys between the two tables, so every object-storage key appears in
-- exactly one row across both — the purge sweep and the abandoned-upload
-- cleanup treat the union of both columns as "referenced".
--
-- Live-name uniqueness is enforced with partial expression indexes (Drive
-- semantics: a live file/folder name is unique within its folder, per
-- client; trashed files don't hold their name slot). folder_id NULL means
-- "client root", hence the COALESCE sentinel in the index expressions.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS client_file_folders (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  parent_id varchar REFERENCES client_file_folders(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_file_folders_client_parent_idx
  ON client_file_folders (client_id, parent_id);

CREATE UNIQUE INDEX IF NOT EXISTS client_file_folders_live_name_unique
  ON client_file_folders (client_id, COALESCE(parent_id, ''), lower(name));

CREATE TABLE IF NOT EXISTS client_files (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  folder_id varchar REFERENCES client_file_folders(id) ON DELETE SET NULL,
  name text NOT NULL,
  mime_type varchar NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0,
  object_key text NOT NULL,
  uploaded_by varchar REFERENCES users(id) ON DELETE SET NULL,
  trashed_at timestamp,
  trashed_by varchar REFERENCES users(id) ON DELETE SET NULL,
  trashed_from_folder_id varchar,
  created_at timestamp NOT NULL DEFAULT now(),
  content_updated_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_files_client_folder_idx
  ON client_files (client_id, folder_id);

CREATE INDEX IF NOT EXISTS client_files_client_trashed_idx
  ON client_files (client_id, trashed_at);

-- A live file name occupies its (client, folder) slot; trashed files don't.
CREATE UNIQUE INDEX IF NOT EXISTS client_files_live_name_unique
  ON client_files (client_id, COALESCE(folder_id, ''), lower(name))
  WHERE trashed_at IS NULL;

-- The purge sweep scans for expired trash across all clients.
CREATE INDEX IF NOT EXISTS client_files_trashed_at_idx
  ON client_files (trashed_at)
  WHERE trashed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS client_file_versions (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id varchar NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  mime_type varchar NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0,
  object_key text NOT NULL,
  uploaded_by varchar REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at timestamp NOT NULL,
  superseded_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_file_versions_file_version_idx
  ON client_file_versions (file_id, version_number);

CREATE INDEX IF NOT EXISTS client_file_versions_client_idx
  ON client_file_versions (client_id);

CREATE TABLE IF NOT EXISTS client_file_activity (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  file_id varchar REFERENCES client_files(id) ON DELETE CASCADE,
  folder_id varchar,
  action varchar NOT NULL,
  actor_id varchar REFERENCES users(id) ON DELETE SET NULL,
  actor_name text NOT NULL DEFAULT '',
  detail jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_file_activity_client_created_idx
  ON client_file_activity (client_id, created_at);

CREATE INDEX IF NOT EXISTS client_file_activity_file_created_idx
  ON client_file_activity (file_id, created_at);
