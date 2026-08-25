-- Secure paid-book delivery: private asset registry, one-time link evidence,
-- browser-session evidence, and append-only safe delivery audit.
-- Never stores a raw buyer token, permanent object URL, card data, or intake.

CREATE TABLE IF NOT EXISTS book_delivery_assets (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_code varchar(64) NOT NULL,
  object_key text NOT NULL,
  filename varchar(255) NOT NULL,
  content_type varchar(128) NOT NULL,
  max_bytes integer NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'disabled',
  created_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT book_delivery_assets_status_check
    CHECK (status IN ('active','disabled','retired')),
  CONSTRAINT book_delivery_assets_key_check
    CHECK (length(object_key) > 0 AND left(object_key, 1) <> '/' AND position('..' in object_key) = 0),
  CONSTRAINT book_delivery_assets_max_bytes_check CHECK (max_bytes > 0)
);
CREATE INDEX IF NOT EXISTS book_delivery_assets_entitlement_idx
  ON book_delivery_assets (entitlement_code);
CREATE UNIQUE INDEX IF NOT EXISTS book_delivery_assets_active_entitlement_uniq
  ON book_delivery_assets (entitlement_code) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS book_delivery_links (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id varchar NOT NULL REFERENCES book_entitlements(id) ON DELETE CASCADE,
  token_hash varchar(64) NOT NULL,
  purpose varchar(32) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  expires_at timestamp NOT NULL,
  consumed_at timestamp,
  revoked_at timestamp,
  created_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT book_delivery_links_purpose_check
    CHECK (purpose IN ('initial','resend','reissue'))
);
CREATE UNIQUE INDEX IF NOT EXISTS book_delivery_links_token_hash_uniq
  ON book_delivery_links (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS book_delivery_links_idempotency_uniq
  ON book_delivery_links (idempotency_key);
CREATE INDEX IF NOT EXISTS book_delivery_links_entitlement_expiry_idx
  ON book_delivery_links (entitlement_id, expires_at);

CREATE TABLE IF NOT EXISTS book_delivery_sessions (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id varchar NOT NULL REFERENCES book_entitlements(id) ON DELETE CASCADE,
  session_hash varchar(64) NOT NULL,
  expires_at timestamp NOT NULL,
  revoked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS book_delivery_sessions_session_hash_uniq
  ON book_delivery_sessions (session_hash);
CREATE INDEX IF NOT EXISTS book_delivery_sessions_entitlement_expiry_idx
  ON book_delivery_sessions (entitlement_id, expires_at);

CREATE TABLE IF NOT EXISTS book_delivery_audit (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id varchar NOT NULL REFERENCES book_entitlements(id) ON DELETE CASCADE,
  asset_id varchar REFERENCES book_delivery_assets(id) ON DELETE SET NULL,
  actor_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  event_type varchar(64) NOT NULL,
  outcome varchar(32) NOT NULL,
  detail varchar(400),
  idempotency_key varchar(128),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT book_delivery_audit_outcome_check
    CHECK (outcome IN ('accepted','denied','completed','unavailable','failed'))
);
CREATE INDEX IF NOT EXISTS book_delivery_audit_entitlement_idx
  ON book_delivery_audit (entitlement_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS book_delivery_audit_idempotency_uniq
  ON book_delivery_audit (idempotency_key) WHERE idempotency_key IS NOT NULL;