-- Task #4028 — external share links for client files.
--
-- One row per minted link. The URL carries a random 256-bit token; only its
-- sha256 hex lands in token_hash, so a DB leak never exposes a working link.
-- Links die by expiry (expires_at) or explicit revocation (revoked_at); the
-- public route treats trashed/purged files as gone (file rows cascade).
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS client_file_share_links (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  file_id varchar NOT NULL REFERENCES client_files(id) ON DELETE CASCADE,
  token_hash varchar(64) NOT NULL,
  created_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_by_name text NOT NULL DEFAULT '',
  expires_at timestamp NOT NULL,
  revoked_at timestamp,
  revoked_by varchar REFERENCES users(id) ON DELETE SET NULL,
  access_count integer NOT NULL DEFAULT 0,
  last_accessed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS client_file_share_links_token_hash_unique
  ON client_file_share_links (token_hash);

CREATE INDEX IF NOT EXISTS client_file_share_links_file_idx
  ON client_file_share_links (file_id);
