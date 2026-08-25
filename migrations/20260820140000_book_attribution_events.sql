-- Task #5106 — Book Attribution Event Ledger + Per-Provider Delivery State.
--
-- Creates two tables:
--
--   book_attribution_events
--     Append-only book-specific attribution event ledger. One row per
--     meaningful funnel measurement moment. Closed vocabulary of event_name
--     values aligned to the blueprint GA4/Meta/Google Ads event map.
--     Carries: stable durable eventId (UUID PK), closed-vocabulary event_name,
--     source authority + source IDs (contact/checkout/order/application/
--     appointment/opportunity), order/item context (package_code,
--     amount_cents, currency, item_sku), privacy classification
--     (public/pii_contact/sensitive), attribution_snapshot (JSONB allow-list),
--     occurred_at (authoritative business timestamp), globally unique
--     required idempotency_key, created_at.
--
--   book_attribution_event_deliveries
--     Per-provider delivery state for each attribution event row.
--     One row per (event_id, provider) pair. Providers: ga4, meta_capi,
--     google_ads. Status machine: pending/deferred/sent/retry/dead/disabled.
--     Carries: attempts, max_attempts, next_attempt_at, lease_token,
--     lease_expires_at, external_receipt_id, external_idempotency_key,
--     sanitized error_class, created_at, updated_at, sent_at.
--     Unique constraint on (event_id, provider).
--     Claims index on (provider, status, next_attempt_at) for worker polling.
--
-- Design rules:
--   • IF NOT EXISTS throughout — idempotent migration replay.
--   • No destructive changes (no DROP TABLE / DROP COLUMN / ALTER TYPE).
--   • Timestamps without timezone (UTC assumed; matches codebase convention).
--   • Monetary amounts integer cents with non-negative CHECK.
--   • Status / event_name / provider / privacy_class columns carry DB CHECK.
--   • Idempotency key: required and globally unique.
--   • Source IDs are immutable scalar snapshots (not FKs), so parent privacy
--     deletion cannot rewrite or block deletion on historical ledger facts.
--   • delivery → event FK is CASCADE (delivery state orphan is useless).
--   • Worker polling index covers (provider, status, next_attempt_at).
--   • Lease expiry index covers non-null lease_expires_at rows only.
--
-- Never edit applied migrations; add forward-fix migrations only.

-- ── book_attribution_events ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS book_attribution_events (
  id                    varchar          PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name            varchar(64)      NOT NULL,
  source_authority      varchar(32)      NOT NULL,

  -- Immutable source references (nullable scalar snapshots; intentionally no FK)
  contact_id            varchar,
  checkout_session_id   varchar,
  order_id              varchar,
  application_id        varchar,
  appointment_id        varchar,
  -- External CRM opportunity reference (no FK — cross-system)
  opportunity_ref       varchar(256),

  -- Order / item context (nullable — not all events have order context)
  package_code          varchar(32),
  amount_cents          integer,
  currency              varchar(3),
  item_sku              varchar(64),

  -- Privacy classification
  privacy_class         varchar(16)      NOT NULL DEFAULT 'public',

  -- Attribution context JSONB snapshot (allow-listed facts; no raw PII)
  attribution_snapshot  jsonb,

  -- Business timestamp (authoritative; may predate insert)
  occurred_at           timestamp        NOT NULL,

  -- Globally unique logical idempotency key (required for every event)
  idempotency_key       varchar(256)     NOT NULL,

  created_at            timestamp        NOT NULL DEFAULT now(),

  CONSTRAINT book_attribution_events_event_name_check
    CHECK (event_name IN (
      'view_item','select_item','begin_checkout','add_shipping_info',
      'add_payment_info','purchase','refund','book_video_start',
      'book_video_complete','bump_view','bump_accept','bonus_offer_view',
      'audit_application_start','audit_application_submit',
      'audit_application_qualified','audit_application_not_qualified',
      'scheduler_view','appointment_booked','appointment_attended',
      'appointment_no_show','qualified_opportunity','client_closed',
      'access_ready','book_download','complete_collection_purchased',
      'audiobook_start'
    )),
  CONSTRAINT book_attribution_events_source_authority_check
    CHECK (source_authority IN ('book_commerce','stripe_webhook','ghl_webhook','manual_import')),
  CONSTRAINT book_attribution_events_privacy_class_check
    CHECK (privacy_class IN ('public','pii_contact','sensitive')),
  CONSTRAINT book_attribution_events_package_code_check
    CHECK (package_code IS NULL OR package_code IN ('digital','complete')),
  CONSTRAINT book_attribution_events_amount_cents_check
    CHECK (amount_cents IS NULL OR amount_cents >= 0),
  CONSTRAINT book_attribution_events_currency_check
    CHECK (currency IS NULL OR (currency = upper(currency) AND length(currency) = 3))
);

CREATE INDEX IF NOT EXISTS book_attribution_events_event_name_idx
  ON book_attribution_events (event_name);
CREATE INDEX IF NOT EXISTS book_attribution_events_contact_id_idx
  ON book_attribution_events (contact_id);
CREATE INDEX IF NOT EXISTS book_attribution_events_checkout_session_id_idx
  ON book_attribution_events (checkout_session_id);
CREATE INDEX IF NOT EXISTS book_attribution_events_order_id_idx
  ON book_attribution_events (order_id);
CREATE INDEX IF NOT EXISTS book_attribution_events_application_id_idx
  ON book_attribution_events (application_id);
CREATE INDEX IF NOT EXISTS book_attribution_events_appointment_id_idx
  ON book_attribution_events (appointment_id);
CREATE INDEX IF NOT EXISTS book_attribution_events_occurred_at_idx
  ON book_attribution_events (occurred_at);
CREATE INDEX IF NOT EXISTS book_attribution_events_created_at_idx
  ON book_attribution_events (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS book_attribution_events_idempotency_uniq
  ON book_attribution_events (idempotency_key);

-- Append-only database guard. Source IDs are non-FK snapshots specifically so
-- parent retention/privacy operations never need to mutate these rows.
CREATE OR REPLACE FUNCTION prevent_book_attribution_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'book_attribution_events is append-only'
    USING ERRCODE = '55000';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'book_attribution_events_append_only'
      AND tgrelid = 'book_attribution_events'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER book_attribution_events_append_only
      BEFORE UPDATE OR DELETE ON book_attribution_events
      FOR EACH ROW
      EXECUTE FUNCTION prevent_book_attribution_event_mutation();
  END IF;
END;
$$;

COMMENT ON TABLE book_attribution_events IS
  'Task #5106 — Append-only book-specific attribution event ledger. One row per meaningful funnel measurement moment. Closed event_name vocabulary aligned to blueprint GA4/Meta/Google Ads event map.';
COMMENT ON COLUMN book_attribution_events.event_name IS
  'Closed vocabulary blueprint-aligned event name (GA4/Meta/Google Ads).';
COMMENT ON COLUMN book_attribution_events.source_authority IS
  'System that originated the business fact: book_commerce / stripe_webhook / ghl_webhook / manual_import.';
COMMENT ON COLUMN book_attribution_events.privacy_class IS
  'Privacy classification: public (no PII), pii_contact (hash before send), sensitive (policy gate).';
COMMENT ON COLUMN book_attribution_events.attribution_snapshot IS
  'Allow-listed attribution facts snapshot (UTM, approved click IDs, session ID). No raw PII.';
COMMENT ON COLUMN book_attribution_events.occurred_at IS
  'Authoritative business timestamp — when the fact occurred (may predate row insert).';
COMMENT ON COLUMN book_attribution_events.idempotency_key IS
  'Required globally unique logical dedup key. Prevents duplicate ledger rows on retry/import.';

-- ── book_attribution_event_deliveries ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS book_attribution_event_deliveries (
  id                        varchar      PRIMARY KEY DEFAULT gen_random_uuid(),
  -- FK to ledger row (CASCADE — delivery state orphan is useless without event)
  event_id                  varchar      NOT NULL
                              REFERENCES book_attribution_events(id) ON DELETE CASCADE,
  provider                  varchar(16)  NOT NULL,

  -- Delivery status + attempt tracking
  status                    varchar(16)  NOT NULL DEFAULT 'pending',
  attempts                  integer      NOT NULL DEFAULT 0,
  max_attempts              integer      NOT NULL DEFAULT 5,
  -- When the next delivery attempt should be made (NULL = immediately eligible)
  next_attempt_at           timestamp,

  -- Lease fields (worker safety — atomic claim/finalize protocol)
  lease_token               varchar(64),
  lease_expires_at          timestamp,

  -- External platform receipt
  external_receipt_id       varchar(256),
  -- Idempotency key sent to the platform; stable across retries for same row
  external_idempotency_key  varchar(256),

  -- Sanitized error classification (no raw PII/stacks/secrets)
  error_class               varchar(64),

  created_at                timestamp    NOT NULL DEFAULT now(),
  updated_at                timestamp    NOT NULL DEFAULT now(),
  sent_at                   timestamp,

  CONSTRAINT book_attribution_event_deliveries_status_check
    CHECK (status IN ('pending','deferred','sent','retry','dead','disabled')),
  CONSTRAINT book_attribution_event_deliveries_provider_check
    CHECK (provider IN ('ga4','meta_capi','google_ads')),
  CONSTRAINT book_attribution_event_deliveries_attempts_check
    CHECK (attempts >= 0 AND max_attempts >= 1)
);

-- Unique: at most one delivery row per (event, provider)
CREATE UNIQUE INDEX IF NOT EXISTS book_attribution_event_deliveries_event_provider_uniq
  ON book_attribution_event_deliveries (event_id, provider);

-- Worker polling index: find pending/retry rows eligible for claiming
CREATE INDEX IF NOT EXISTS book_attribution_event_deliveries_pending_claims_idx
  ON book_attribution_event_deliveries (provider, status, next_attempt_at);

-- Lease expiry sweep: reclaim rows with expired leases
CREATE INDEX IF NOT EXISTS book_attribution_event_deliveries_lease_expires_idx
  ON book_attribution_event_deliveries (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

COMMENT ON TABLE book_attribution_event_deliveries IS
  'Task #5106 — Per-provider delivery state for book attribution events. One row per (event_id, provider). Status: pending/deferred/sent/retry/dead/disabled.';
COMMENT ON COLUMN book_attribution_event_deliveries.status IS
  'Delivery state machine: pending/deferred/sent/retry/dead/disabled.';
COMMENT ON COLUMN book_attribution_event_deliveries.lease_token IS
  'Random token set by claiming worker. Cleared on finalize. Allows safe reclaim after lease_expires_at.';
COMMENT ON COLUMN book_attribution_event_deliveries.external_idempotency_key IS
  'Idempotency key sent to the external platform. Stable across retries for the same delivery row.';
COMMENT ON COLUMN book_attribution_event_deliveries.error_class IS
  'Sanitized error classification. No raw PII, stack traces, or secrets. Examples: network_timeout, rate_limited.';
