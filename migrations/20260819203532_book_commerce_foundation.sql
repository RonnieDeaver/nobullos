-- Task #5096 — Book Commerce Foundation (revised).
--
-- Creates the durable record set for the book sales surface:
--   book_contacts              — purchaser/prospect contacts with first/latest
--                                UTM, referrer, and click-ID attribution; consent
--                                evidence reference; retention metadata.
--   book_checkout_sessions     — ephemeral checkout intent; provider session
--                                correlation; idempotency key.
--   book_orders                — authoritative order record post-payment; full
--                                first/latest attribution snapshot.
--   book_order_items           — immutable financial snapshot; exactly ONE item
--                                per order (unique on order_id alone); catalog-
--                                price CHECK ($4.99=499¢ digital/$19.99=1999¢ complete).
--   book_payment_events        — append-only provider webhook log; composite
--                                (provider, provider_event_id) partial unique
--                                for per-provider replay dedup.
--   book_lifecycle_events      — append-only state-transition/event audit;
--                                globally unique idempotency_key.
--   book_entitlements          — order-anchored entitlements (order_id NOT NULL);
--                                entitlement_code-level active unique per order;
--                                supports multiple entitlement types per order.
--   book_audit_applications    — buyer bonus-qualification intake application;
--                                required globally unique idempotency_key;
--                                state machine: draft→submitted→qualified|not_qualified|withdrawn.
--   book_appointments          — post-purchase sessions; unique per audit
--                                application (reschedule via status transitions);
--                                cross-domain nullable FK to scheduled_meetings (SET NULL).
--   book_provider_correlations — bidirectional external provider ID ↔ local ID.
--   book_outbox                — transactional outbox; globally unique
--                                idempotency_key; operational index (status, next_retry_at).
--
-- Prices:
--   digital  = $4.99  →  499 cents
--   complete = $19.99 → 1999 cents
--
-- Design rules applied:
--   • Timestamps stored without timezone (UTC assumed, matching codebase convention).
--   • Monetary amounts are integer cents with non-negative CHECK constraints.
--   • Status/currency/package/entitlement_code columns carry DB CHECK constraints.
--   • Idempotency-key uniqueness: partial (WHERE NOT NULL) for session-scoped
--     keys; globally unique for application, lifecycle-event, and outbox keys.
--   • Cross-domain FK to scheduled_meetings is nullable SET NULL throughout.
--   • Idempotent throughout (IF NOT EXISTS everywhere).
--
-- Never edit applied migrations; add forward-fix migrations only.

-- ── book_contacts ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS book_contacts (
  id                          varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  email                       varchar(320) NOT NULL,
  name                        text,
  phone                       varchar(50),
  client_id                   varchar REFERENCES clients(id) ON DELETE SET NULL,
  scheduled_meeting_id        varchar REFERENCES scheduled_meetings(id) ON DELETE SET NULL,
  -- First-touch attribution (server-owned, write-once at contact creation).
  first_touch_utm_source      varchar(200),
  first_touch_utm_medium      varchar(200),
  first_touch_utm_campaign    varchar(200),
  first_touch_utm_term        varchar(200),
  first_touch_utm_content     varchar(200),
  first_touch_referrer        text,
  first_touch_landing_url     text,
  first_touch_gclid           varchar(200),
  first_touch_gbraid          varchar(200),
  first_touch_wbraid          varchar(200),
  first_touch_fbclid          varchar(200),
  first_touch_click_id        varchar(200),
  first_touch_session_id      varchar(200),
  first_touch_device_id       varchar(200),
  -- Latest-touch attribution (updated on each new session / checkout).
  latest_touch_utm_source     varchar(200),
  latest_touch_utm_medium     varchar(200),
  latest_touch_utm_campaign   varchar(200),
  latest_touch_utm_term       varchar(200),
  latest_touch_utm_content    varchar(200),
  latest_touch_referrer       text,
  latest_touch_landing_url    text,
  latest_touch_gclid          varchar(200),
  latest_touch_gbraid         varchar(200),
  latest_touch_wbraid         varchar(200),
  latest_touch_fbclid         varchar(200),
  latest_touch_click_id       varchar(200),
  latest_touch_session_id     varchar(200),
  latest_touch_device_id      varchar(200),
  -- SMS consent snapshot (authority: sms_consent_ledger). No raw IP/user-agent;
  -- sms_consent_evidence_ref points at the authoritative ledger/evidence record.
  sms_consent_state              varchar(16) NOT NULL DEFAULT 'unknown',
  -- Nullable FK to the single consent authority (sms_consent_ledger); RESTRICT
  -- so evidence is never silently orphaned. Sibling columns are snapshots only.
  sms_consent_evidence_ref       varchar(256) REFERENCES sms_consent_ledger(id) ON DELETE RESTRICT,
  sms_consent_captured_at        timestamp,
  sms_consent_copy_version       varchar(64),
  sms_consent_source_url         text,
  sms_consent_confirmation_status varchar(16) NOT NULL DEFAULT 'not_requested',
  sms_consent_confirmed_at       timestamp,
  -- Email marketing subscription state snapshot.
  email_marketing_status      varchar(16) NOT NULL DEFAULT 'unknown',
  -- Retention metadata.
  retention_until             timestamp,
  retention_reason            varchar(200),
  created_at                  timestamp NOT NULL DEFAULT now(),
  updated_at                  timestamp NOT NULL DEFAULT now(),
  CONSTRAINT book_contacts_sms_consent_state_check
    CHECK (sms_consent_state IN ('unknown','opted_in','opted_out')),
  CONSTRAINT book_contacts_sms_consent_confirmation_check
    CHECK (sms_consent_confirmation_status IN ('not_requested','pending','confirmed','declined','revoked')),
  CONSTRAINT book_contacts_email_marketing_status_check
    CHECK (email_marketing_status IN ('unknown','subscribed','unsubscribed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS book_contacts_email_uniq
  ON book_contacts (email);
CREATE INDEX IF NOT EXISTS book_contacts_client_id_idx
  ON book_contacts (client_id);
CREATE INDEX IF NOT EXISTS book_contacts_meeting_id_idx
  ON book_contacts (scheduled_meeting_id);
CREATE INDEX IF NOT EXISTS book_contacts_retention_until_idx
  ON book_contacts (retention_until);
CREATE INDEX IF NOT EXISTS book_contacts_created_at_idx
  ON book_contacts (created_at);

-- ── book_checkout_sessions ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS book_checkout_sessions (
  id                   varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id           varchar REFERENCES book_contacts(id) ON DELETE SET NULL,
  package_code         varchar(32) NOT NULL,
  status               varchar(32) NOT NULL DEFAULT 'pending',
  provider_session_id  varchar(256),
  currency             varchar(3)  NOT NULL DEFAULT 'USD',
  amount_total_cents   integer     NOT NULL,
  idempotency_key      varchar(128),
  resume_token_hash    varchar(256),
  -- Current-touch attribution snapshot at session start.
  current_touch_utm_source   varchar(200),
  current_touch_utm_medium   varchar(200),
  current_touch_utm_campaign varchar(200),
  current_touch_utm_term     varchar(200),
  current_touch_utm_content  varchar(200),
  current_touch_referrer     text,
  current_touch_landing_url  text,
  current_touch_gclid        varchar(200),
  current_touch_gbraid       varchar(200),
  current_touch_wbraid       varchar(200),
  current_touch_fbclid       varchar(200),
  current_touch_click_id     varchar(200),
  current_touch_session_id   varchar(200),
  current_touch_device_id    varchar(200),
  expires_at           timestamp,
  completed_at         timestamp,
  retention_until      timestamp,
  retention_reason     varchar(200),
  created_at           timestamp NOT NULL DEFAULT now(),
  updated_at           timestamp NOT NULL DEFAULT now(),
  CONSTRAINT book_checkout_sessions_status_check
    CHECK (status IN ('pending','completed','expired','abandoned')),
  CONSTRAINT book_checkout_sessions_currency_check
    CHECK (currency = upper(currency) AND length(currency) = 3),
  CONSTRAINT book_checkout_sessions_amount_check
    CHECK (amount_total_cents >= 0),
  CONSTRAINT book_checkout_sessions_package_check
    CHECK (package_code IN ('digital','complete')),
  -- Catalog guard: currency USD and price locked to the package's catalog price.
  CONSTRAINT book_checkout_sessions_catalog_guard_check
    CHECK (
      currency = 'USD' AND (
        (package_code = 'digital'  AND amount_total_cents =  499) OR
        (package_code = 'complete' AND amount_total_cents = 1999)
      )
    )
);

CREATE INDEX IF NOT EXISTS book_checkout_sessions_contact_id_idx
  ON book_checkout_sessions (contact_id);
CREATE INDEX IF NOT EXISTS book_checkout_sessions_status_idx
  ON book_checkout_sessions (status);
CREATE UNIQUE INDEX IF NOT EXISTS book_checkout_sessions_provider_session_uniq
  ON book_checkout_sessions (provider_session_id)
  WHERE provider_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS book_checkout_sessions_idempotency_uniq
  ON book_checkout_sessions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS book_checkout_sessions_resume_token_uniq
  ON book_checkout_sessions (resume_token_hash)
  WHERE resume_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS book_checkout_sessions_created_at_idx
  ON book_checkout_sessions (created_at);
CREATE INDEX IF NOT EXISTS book_checkout_sessions_retention_until_idx
  ON book_checkout_sessions (retention_until);

-- ── book_orders ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS book_orders (
  id                          varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id                  varchar REFERENCES book_contacts(id) ON DELETE SET NULL,
  -- Authority link: every order originates from a checkout session.
  checkout_session_id         varchar NOT NULL REFERENCES book_checkout_sessions(id) ON DELETE RESTRICT,
  order_number                varchar(64) NOT NULL,
  status                      varchar(32) NOT NULL DEFAULT 'pending_payment',
  package_code                varchar(32) NOT NULL,
  currency                    varchar(3)  NOT NULL DEFAULT 'USD',
  -- Financial snapshot (integer cents): total = subtotal - discount + shipping + tax.
  subtotal_amount_cents       integer     NOT NULL,
  discount_amount_cents       integer     NOT NULL DEFAULT 0,
  shipping_amount_cents       integer     NOT NULL DEFAULT 0,
  tax_amount_cents            integer     NOT NULL DEFAULT 0,
  total_amount_cents          integer     NOT NULL,
  refunded_amount_cents       integer     NOT NULL DEFAULT 0,
  created_by_user_id          varchar REFERENCES users(id) ON DELETE SET NULL,
  -- Full first/latest attribution snapshot at order-creation time (server-stamped).
  first_touch_utm_source      varchar(200),
  first_touch_utm_medium      varchar(200),
  first_touch_utm_campaign    varchar(200),
  first_touch_utm_term        varchar(200),
  first_touch_utm_content     varchar(200),
  first_touch_referrer        text,
  first_touch_landing_url     text,
  first_touch_gclid           varchar(200),
  first_touch_gbraid          varchar(200),
  first_touch_wbraid          varchar(200),
  first_touch_fbclid          varchar(200),
  first_touch_click_id        varchar(200),
  first_touch_session_id      varchar(200),
  first_touch_device_id       varchar(200),
  latest_touch_utm_source     varchar(200),
  latest_touch_utm_medium     varchar(200),
  latest_touch_utm_campaign   varchar(200),
  latest_touch_utm_term       varchar(200),
  latest_touch_utm_content    varchar(200),
  latest_touch_referrer       text,
  latest_touch_landing_url    text,
  latest_touch_gclid          varchar(200),
  latest_touch_gbraid         varchar(200),
  latest_touch_wbraid         varchar(200),
  latest_touch_fbclid         varchar(200),
  latest_touch_click_id       varchar(200),
  latest_touch_session_id     varchar(200),
  latest_touch_device_id      varchar(200),
  -- SMS consent snapshot at purchase time (authority: sms_consent_ledger).
  -- Preserves purchase-time evidence even if the contact changes/deletes.
  sms_consent_state              varchar(16) NOT NULL DEFAULT 'unknown',
  -- Nullable FK to the single consent authority (sms_consent_ledger); RESTRICT
  -- so evidence is never silently orphaned. Sibling columns are snapshots only.
  sms_consent_evidence_ref       varchar(256) REFERENCES sms_consent_ledger(id) ON DELETE RESTRICT,
  sms_consent_captured_at        timestamp,
  sms_consent_copy_version       varchar(64),
  sms_consent_source_url         text,
  sms_consent_confirmation_status varchar(16) NOT NULL DEFAULT 'not_requested',
  sms_consent_confirmed_at       timestamp,
  retention_until             timestamp,
  retention_reason            varchar(200),
  created_at                  timestamp NOT NULL DEFAULT now(),
  updated_at                  timestamp NOT NULL DEFAULT now(),
  CONSTRAINT book_orders_status_check
    CHECK (status IN ('pending_payment','payment_captured','fulfillment_queued','fulfilled','refunded','partially_refunded','cancelled','disputed')),
  CONSTRAINT book_orders_currency_check
    CHECK (currency = upper(currency) AND length(currency) = 3),
  CONSTRAINT book_orders_subtotal_check
    CHECK (subtotal_amount_cents >= 0),
  CONSTRAINT book_orders_discount_check
    CHECK (discount_amount_cents >= 0 AND discount_amount_cents <= subtotal_amount_cents),
  CONSTRAINT book_orders_shipping_check
    CHECK (shipping_amount_cents >= 0),
  CONSTRAINT book_orders_tax_check
    CHECK (tax_amount_cents >= 0),
  CONSTRAINT book_orders_total_amount_check
    CHECK (total_amount_cents >= 0),
  CONSTRAINT book_orders_total_formula_check
    CHECK (total_amount_cents = subtotal_amount_cents - discount_amount_cents + shipping_amount_cents + tax_amount_cents),
  CONSTRAINT book_orders_refunded_amount_check
    CHECK (refunded_amount_cents >= 0 AND refunded_amount_cents <= total_amount_cents),
  CONSTRAINT book_orders_package_check
    CHECK (package_code IN ('digital','complete')),
  CONSTRAINT book_orders_catalog_subtotal_check
    CHECK (
      (package_code = 'digital'  AND subtotal_amount_cents =  499) OR
      (package_code = 'complete' AND subtotal_amount_cents = 1999)
    ),
  CONSTRAINT book_orders_sms_consent_state_check
    CHECK (sms_consent_state IN ('unknown','opted_in','opted_out')),
  CONSTRAINT book_orders_sms_consent_confirmation_check
    CHECK (sms_consent_confirmation_status IN ('not_requested','pending','confirmed','declined','revoked')),
  -- Composite UNIQUE CONSTRAINT backing the book_order_items composite FK.
  -- Declared inline (a table constraint, not a separate unique index) so the
  -- referenced key exists at FK-creation time under push-first (avoids 42830).
  CONSTRAINT book_orders_package_snapshot_uniq
    UNIQUE (id, package_code, currency, subtotal_amount_cents)
);

CREATE UNIQUE INDEX IF NOT EXISTS book_orders_order_number_uniq
  ON book_orders (order_number);
CREATE INDEX IF NOT EXISTS book_orders_contact_id_idx
  ON book_orders (contact_id);
CREATE INDEX IF NOT EXISTS book_orders_status_idx
  ON book_orders (status);
CREATE INDEX IF NOT EXISTS book_orders_checkout_session_id_idx
  ON book_orders (checkout_session_id);
-- One order per checkout session (partial unique on non-NULL).
CREATE UNIQUE INDEX IF NOT EXISTS book_orders_checkout_session_uniq
  ON book_orders (checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;
-- (book_orders_package_snapshot_uniq is declared inline as a UNIQUE CONSTRAINT
--  in CREATE TABLE book_orders above so the FK-referenced key exists at FK
--  creation time under push-first.)
CREATE INDEX IF NOT EXISTS book_orders_created_at_idx
  ON book_orders (created_at);
CREATE INDEX IF NOT EXISTS book_orders_retention_until_idx
  ON book_orders (retention_until);

-- ── book_order_items ──────────────────────────────────────────────────────────
-- Exactly ONE item per order (unique on order_id alone).
-- Prices: digital = $4.99 = 499 cents; complete = $19.99 = 1999 cents.

CREATE TABLE IF NOT EXISTS book_order_items (
  id                    varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              varchar NOT NULL REFERENCES book_orders(id) ON DELETE CASCADE,
  package_code          varchar(32) NOT NULL,
  package_label         text        NOT NULL,
  quantity              integer     NOT NULL DEFAULT 1,
  unit_price_cents      integer     NOT NULL,
  line_total_cents      integer     NOT NULL,
  currency              varchar(3)  NOT NULL DEFAULT 'USD',
  discount_label        text,
  discount_amount_cents integer     NOT NULL DEFAULT 0,
  metadata              jsonb,
  created_at            timestamp   NOT NULL DEFAULT now(),
  CONSTRAINT book_order_items_package_check
    CHECK (package_code IN ('digital','complete')),
  -- Fixed catalog: exactly one unit.
  CONSTRAINT book_order_items_quantity_check
    CHECK (quantity = 1),
  CONSTRAINT book_order_items_unit_price_check
    CHECK (unit_price_cents >= 0),
  CONSTRAINT book_order_items_line_total_check
    CHECK (line_total_cents >= 0),
  -- line_total = quantity × unit_price (with quantity = 1 → line_total = unit_price).
  CONSTRAINT book_order_items_line_total_formula_check
    CHECK (line_total_cents = quantity * unit_price_cents),
  -- Fixed catalog: no discount, and discount label must be NULL.
  CONSTRAINT book_order_items_discount_check
    CHECK (discount_amount_cents = 0 AND discount_label IS NULL),
  CONSTRAINT book_order_items_currency_check
    CHECK (currency = upper(currency) AND length(currency) = 3),
  -- Catalog price guard: digital = $4.99 (499¢), complete = $19.99 (1999¢).
  CONSTRAINT book_order_items_catalog_price_check
    CHECK (
      (package_code = 'digital'  AND unit_price_cents =  499) OR
      (package_code = 'complete' AND unit_price_cents = 1999)
    ),
  -- Composite FK to the parent order snapshot: the item's
  -- (order_id, package_code, currency, line_total_cents) must match the order's
  -- (id, package_code, currency, subtotal_amount_cents), so item and parent
  -- package/currency/amount cannot diverge. References
  -- the book_orders_package_snapshot_uniq UNIQUE CONSTRAINT declared above.
  CONSTRAINT book_order_items_package_snapshot_fk
    FOREIGN KEY (order_id, package_code, currency, line_total_cents)
    REFERENCES book_orders (id, package_code, currency, subtotal_amount_cents)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS book_order_items_order_id_idx
  ON book_order_items (order_id);
-- Exactly one item per order.
CREATE UNIQUE INDEX IF NOT EXISTS book_order_items_order_uniq
  ON book_order_items (order_id);

-- ── book_payment_events ───────────────────────────────────────────────────────
-- Composite (provider, provider_event_id) partial unique for per-provider replay dedup.

CREATE TABLE IF NOT EXISTS book_payment_events (
  id                  varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            varchar REFERENCES book_orders(id) ON DELETE SET NULL,
  checkout_session_id varchar REFERENCES book_checkout_sessions(id) ON DELETE SET NULL,
  provider            varchar(64)  NOT NULL,
  provider_event_id   varchar(256),
  event_type          varchar(128) NOT NULL,
  amount_cents        integer,
  currency            varchar(3),
  raw_payload         jsonb,
  processed_at        timestamp,
  retention_until     timestamp,
  retention_reason    varchar(200),
  created_at          timestamp NOT NULL DEFAULT now(),
  CONSTRAINT book_payment_events_amount_check
    CHECK (amount_cents IS NULL OR amount_cents >= 0)
);

CREATE INDEX IF NOT EXISTS book_payment_events_order_id_idx
  ON book_payment_events (order_id);
CREATE INDEX IF NOT EXISTS book_payment_events_checkout_session_id_idx
  ON book_payment_events (checkout_session_id);
-- Composite: same provider_event_id from the same provider is a replay.
CREATE UNIQUE INDEX IF NOT EXISTS book_payment_events_provider_event_uniq
  ON book_payment_events (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS book_payment_events_created_at_idx
  ON book_payment_events (created_at);
CREATE INDEX IF NOT EXISTS book_payment_events_retention_until_idx
  ON book_payment_events (retention_until);

-- ── book_lifecycle_events ─────────────────────────────────────────────────────
-- Globally unique idempotency_key (when non-NULL).

CREATE TABLE IF NOT EXISTS book_lifecycle_events (
  id                  varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id          varchar REFERENCES book_contacts(id) ON DELETE SET NULL,
  order_id            varchar REFERENCES book_orders(id) ON DELETE SET NULL,
  checkout_session_id varchar REFERENCES book_checkout_sessions(id) ON DELETE SET NULL,
  event_type          varchar(64) NOT NULL,
  from_status         varchar(64),
  to_status           varchar(64),
  actor_user_id       varchar REFERENCES users(id) ON DELETE SET NULL,
  reason              text,
  metadata            jsonb,
  idempotency_key     varchar(128),
  retention_until     timestamp,
  retention_reason    varchar(200),
  created_at          timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS book_lifecycle_events_contact_id_idx
  ON book_lifecycle_events (contact_id);
CREATE INDEX IF NOT EXISTS book_lifecycle_events_order_id_idx
  ON book_lifecycle_events (order_id);
CREATE INDEX IF NOT EXISTS book_lifecycle_events_event_type_idx
  ON book_lifecycle_events (event_type);
CREATE INDEX IF NOT EXISTS book_lifecycle_events_created_at_idx
  ON book_lifecycle_events (created_at);
CREATE INDEX IF NOT EXISTS book_lifecycle_events_retention_until_idx
  ON book_lifecycle_events (retention_until);
-- Globally unique — retry storms cannot insert duplicate lifecycle entries.
CREATE UNIQUE INDEX IF NOT EXISTS book_lifecycle_events_idempotency_uniq
  ON book_lifecycle_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── book_entitlements ─────────────────────────────────────────────────────────
-- order_id NOT NULL; active unique on (order_id, entitlement_code).
-- Supports multiple entitlement types per order (digital_book, audiobook, print_fulfillment).

CREATE TABLE IF NOT EXISTS book_entitlements (
  id               varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id       varchar REFERENCES book_contacts(id) ON DELETE SET NULL,
  order_id         varchar NOT NULL REFERENCES book_orders(id) ON DELETE RESTRICT,
  package_code     varchar(32) NOT NULL,
  entitlement_code varchar(64) NOT NULL,
  status           varchar(32) NOT NULL DEFAULT 'active',
  expires_at       timestamp,
  granted_at       timestamp   NOT NULL DEFAULT now(),
  revoked_at       timestamp,
  revoked_reason   text,
  actor_user_id    varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamp NOT NULL DEFAULT now(),
  updated_at       timestamp NOT NULL DEFAULT now(),
  CONSTRAINT book_entitlements_package_check
    CHECK (package_code IN ('digital','complete')),
  CONSTRAINT book_entitlements_entitlement_code_check
    CHECK (entitlement_code IN ('digital_book','audiobook','print_fulfillment')),
  CONSTRAINT book_entitlements_status_check
    CHECK (status IN ('active','revoked','expired'))
);

CREATE INDEX IF NOT EXISTS book_entitlements_contact_id_idx
  ON book_entitlements (contact_id);
CREATE INDEX IF NOT EXISTS book_entitlements_order_id_idx
  ON book_entitlements (order_id);
CREATE INDEX IF NOT EXISTS book_entitlements_status_idx
  ON book_entitlements (status);
-- Idempotent grant: at most one active entitlement per entitlement_code per order.
CREATE UNIQUE INDEX IF NOT EXISTS book_entitlements_order_entitlement_active_uniq
  ON book_entitlements (order_id, entitlement_code)
  WHERE status = 'active';

-- ── book_audit_applications ───────────────────────────────────────────────────
-- Buyer bonus-qualification intake application.
-- contact_id required; idempotency_key required globally unique.

CREATE TABLE IF NOT EXISTS book_audit_applications (
  id                   varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id           varchar NOT NULL REFERENCES book_contacts(id) ON DELETE RESTRICT,
  order_id             varchar REFERENCES book_orders(id) ON DELETE SET NULL,
  idempotency_key      varchar(128) NOT NULL,
  status               varchar(32)  NOT NULL DEFAULT 'draft',
  answers              jsonb,
  submitted_at         timestamp,
  decided_at           timestamp,
  decision_reason      text,
  consent_evidence_ref varchar(256),
  retention_until      timestamp,
  retention_reason     varchar(200),
  created_at           timestamp NOT NULL DEFAULT now(),
  updated_at           timestamp NOT NULL DEFAULT now(),
  CONSTRAINT book_audit_applications_status_check
    CHECK (status IN ('draft','submitted','qualified','not_qualified','withdrawn'))
);

-- Globally unique idempotency_key for applications.
CREATE UNIQUE INDEX IF NOT EXISTS book_audit_applications_idempotency_uniq
  ON book_audit_applications (idempotency_key);
CREATE INDEX IF NOT EXISTS book_audit_applications_contact_id_idx
  ON book_audit_applications (contact_id);
CREATE INDEX IF NOT EXISTS book_audit_applications_order_id_idx
  ON book_audit_applications (order_id);
CREATE INDEX IF NOT EXISTS book_audit_applications_status_created_idx
  ON book_audit_applications (status, created_at);
CREATE INDEX IF NOT EXISTS book_audit_applications_retention_until_idx
  ON book_audit_applications (retention_until);

-- ── book_appointments ─────────────────────────────────────────────────────────
-- Unique per audit_application_id (WHERE NOT NULL): rescheduling flows through
-- status transitions (no_show → scheduled), not new rows.
-- Cross-domain nullable FK to scheduled_meetings (SET NULL).

CREATE TABLE IF NOT EXISTS book_appointments (
  id                    varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id            varchar REFERENCES book_contacts(id) ON DELETE SET NULL,
  order_id              varchar REFERENCES book_orders(id) ON DELETE SET NULL,
  entitlement_id        varchar REFERENCES book_entitlements(id) ON DELETE SET NULL,
  -- Authority link: an appointment always belongs to an audit application.
  audit_application_id  varchar NOT NULL REFERENCES book_audit_applications(id) ON DELETE RESTRICT,
  -- Cross-domain nullable FK to scheduled_meetings (SET NULL — booking domain owns it).
  scheduled_meeting_id  varchar REFERENCES scheduled_meetings(id) ON DELETE SET NULL,
  status                varchar(32) NOT NULL DEFAULT 'pending',
  scheduled_at          timestamp,
  timezone              varchar(64),
  notes                 text,
  cancelled_at          timestamp,
  cancelled_reason      text,
  retention_until       timestamp,
  retention_reason      varchar(200),
  created_at            timestamp NOT NULL DEFAULT now(),
  updated_at            timestamp NOT NULL DEFAULT now(),
  CONSTRAINT book_appointments_status_check
    CHECK (status IN ('pending','scheduled','completed','cancelled','no_show'))
);

CREATE INDEX IF NOT EXISTS book_appointments_contact_id_idx
  ON book_appointments (contact_id);
CREATE INDEX IF NOT EXISTS book_appointments_order_id_idx
  ON book_appointments (order_id);
CREATE INDEX IF NOT EXISTS book_appointments_status_idx
  ON book_appointments (status);
CREATE INDEX IF NOT EXISTS book_appointments_scheduled_at_idx
  ON book_appointments (scheduled_at);
CREATE INDEX IF NOT EXISTS book_appointments_meeting_id_idx
  ON book_appointments (scheduled_meeting_id);
CREATE INDEX IF NOT EXISTS book_appointments_retention_until_idx
  ON book_appointments (retention_until);
-- One appointment per application — reschedule via status transitions, not new rows.
CREATE UNIQUE INDEX IF NOT EXISTS book_appointments_audit_application_uniq
  ON book_appointments (audit_application_id)
  WHERE audit_application_id IS NOT NULL;

-- ── book_provider_correlations ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS book_provider_correlations (
  id                   varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             varchar(64)  NOT NULL,
  provider_entity_type varchar(128) NOT NULL,
  provider_entity_id   varchar(256) NOT NULL,
  local_entity_type    varchar(64)  NOT NULL,
  local_entity_id      varchar(128) NOT NULL,
  metadata             jsonb,
  retention_until      timestamp,
  retention_reason     varchar(200),
  created_at           timestamp NOT NULL DEFAULT now(),
  updated_at           timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS book_provider_correlations_provider_entity_uniq
  ON book_provider_correlations (provider, provider_entity_type, provider_entity_id);
CREATE INDEX IF NOT EXISTS book_provider_correlations_local_entity_idx
  ON book_provider_correlations (local_entity_type, local_entity_id);
CREATE INDEX IF NOT EXISTS book_provider_correlations_provider_idx
  ON book_provider_correlations (provider);
CREATE INDEX IF NOT EXISTS book_provider_correlations_created_at_idx
  ON book_provider_correlations (created_at);
CREATE INDEX IF NOT EXISTS book_provider_correlations_retention_until_idx
  ON book_provider_correlations (retention_until);

-- ── book_outbox ───────────────────────────────────────────────────────────────
-- Globally unique idempotency_key (when non-NULL).
-- Operational polling index: (status, next_retry_at).

CREATE TABLE IF NOT EXISTS book_outbox (
  id               varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type       varchar(128) NOT NULL,
  source_type      varchar(64)  NOT NULL,
  source_id        varchar(128) NOT NULL,
  status           varchar(32)  NOT NULL DEFAULT 'pending',
  payload          jsonb,
  attempt_count    integer      NOT NULL DEFAULT 0,
  max_attempts     integer      NOT NULL DEFAULT 5,
  last_attempt_at  timestamp,
  next_retry_at    timestamp,
  delivered_at     timestamp,
  error_message    text,
  idempotency_key  varchar(128),
  created_at       timestamp NOT NULL DEFAULT now(),
  updated_at       timestamp NOT NULL DEFAULT now(),
  CONSTRAINT book_outbox_status_check
    CHECK (status IN ('pending','delivered','failed','dead_letter')),
  CONSTRAINT book_outbox_attempt_check
    CHECK (attempt_count >= 0)
);

-- Operational polling index: worker leases pending rows ordered by retry time.
CREATE INDEX IF NOT EXISTS book_outbox_status_next_retry_idx
  ON book_outbox (status, next_retry_at);
CREATE INDEX IF NOT EXISTS book_outbox_source_idx
  ON book_outbox (source_type, source_id);
CREATE INDEX IF NOT EXISTS book_outbox_created_at_idx
  ON book_outbox (created_at);
-- Globally unique: prevents re-entry of the same logical event at any point.
CREATE UNIQUE INDEX IF NOT EXISTS book_outbox_idempotency_uniq
  ON book_outbox (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── Financial snapshot immutability (DB-level enforcement) ─────────────────────
--
-- Orders and order items carry the authoritative financial snapshot. To keep
-- that snapshot trustworthy independent of any application bug, the database
-- itself rejects post-insert mutation of the financial fields:
--
--   book_orders     — package_code, currency, subtotal_amount_cents,
--                     discount_amount_cents, shipping_amount_cents,
--                     tax_amount_cents, and total_amount_cents are frozen after
--                     insert. status and refunded_amount_cents remain
--                     legitimately mutable (refund/lifecycle transitions), as
--                     do the operational/attribution/consent/retention columns.
--   book_order_items — the entire row is an insert-only snapshot; ANY UPDATE
--                      OR DELETE is rejected.
--
-- Rejections raise SQLSTATE 23514 (check_violation) so callers treat them the
-- same as the inline CHECK constraints above.
--
-- Idempotent pattern: CREATE OR REPLACE FUNCTION / TRIGGER is replay-safe and
-- converges to exactly one definition without destructive DDL.

-- Reject changes to frozen financial columns on book_orders.
CREATE OR REPLACE FUNCTION book_orders_freeze_financials()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.package_code IS DISTINCT FROM OLD.package_code THEN
    RAISE EXCEPTION 'book_orders.package_code is immutable after insert'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'book_orders.currency is immutable after insert'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.subtotal_amount_cents IS DISTINCT FROM OLD.subtotal_amount_cents THEN
    RAISE EXCEPTION 'book_orders.subtotal_amount_cents is immutable after insert'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.discount_amount_cents IS DISTINCT FROM OLD.discount_amount_cents THEN
    RAISE EXCEPTION 'book_orders.discount_amount_cents is immutable after insert'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.shipping_amount_cents IS DISTINCT FROM OLD.shipping_amount_cents THEN
    RAISE EXCEPTION 'book_orders.shipping_amount_cents is immutable after insert'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.tax_amount_cents IS DISTINCT FROM OLD.tax_amount_cents THEN
    RAISE EXCEPTION 'book_orders.tax_amount_cents is immutable after insert'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.total_amount_cents IS DISTINCT FROM OLD.total_amount_cents THEN
    RAISE EXCEPTION 'book_orders.total_amount_cents is immutable after insert'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER book_orders_freeze_financials_trg
  BEFORE UPDATE ON book_orders
  FOR EACH ROW
  EXECUTE FUNCTION book_orders_freeze_financials();

-- Reject ANY update or delete of book_order_items (insert-only financial
-- snapshot). The function always raises, so it is correct for both events.
CREATE OR REPLACE FUNCTION book_order_items_reject_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'book_order_items rows are insert-only financial snapshots and cannot be updated or deleted'
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER book_order_items_reject_update_trg
  BEFORE UPDATE OR DELETE ON book_order_items
  FOR EACH ROW
  EXECUTE FUNCTION book_order_items_reject_update();

-- ── DB-level state machine + audit/outbox protocol enforcement ─────────────────
--
-- These triggers move the authoritative status state machine and the
-- same-transaction audit/outbox protocol into the database, so no application
-- bug can transition an entity illegally or without the mandated evidence rows.
--
-- LOCKSTEP INVARIANT: the legal-edge maps encoded in the plpgsql below MUST
-- match the exported TS maps in shared/models/bookCommerce.ts EXACTLY —
-- bookOrderTransitions / bookAuditApplicationTransitions /
-- bookAppointmentTransitions (and the isValid* validators). Same-state edges are
-- rejected; terminal states have no outbound edges. When one side changes the
-- other must change in the same reviewed diff. (This is a documentation-level
-- lockstep note; it deliberately introduces NO new test-policy mechanism.)
--
-- Deterministic protocol keys (must match storage):
--   order-transition:<id>:<old>:<new>
--   application-transition:<id>:<old>:<new>
--   appointment-transition:<id>:<old>:<new>
--
-- Two layers per stateful table:
--   1. BEFORE UPDATE OF status row trigger — rejects illegal/same-state edges
--      immediately with SQLSTATE 23514.
--   2. DEFERRABLE INITIALLY DEFERRED AFTER UPDATE OF status constraint trigger —
--      at COMMIT, requires the matching book_lifecycle_events row (always) and
--      the matching book_outbox row (per the protocol rules) to exist, proving
--      storage wrote them in the same transaction. Also 23514 on failure.
--
-- Replay-safety: normal functions/triggers use CREATE OR REPLACE. Constraint
-- triggers cannot be CREATE OR REPLACE, so each is created inside a
-- pg_trigger-catalog-guarded DO block (create only when absent) — no DROP,
-- replay converges to exactly one definition.

-- ---- 1a. book_orders status edge validator (BEFORE UPDATE) -------------------
CREATE OR REPLACE FUNCTION book_orders_status_edge_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ok boolean := false;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'book_orders: same-state status transition (% -> %) is not allowed',
      OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  ok := CASE OLD.status
    WHEN 'pending_payment'    THEN NEW.status IN ('payment_captured','cancelled')
    WHEN 'payment_captured'   THEN NEW.status IN ('fulfillment_queued','partially_refunded','refunded','disputed')
    WHEN 'fulfillment_queued' THEN NEW.status IN ('fulfilled','partially_refunded','refunded','disputed')
    WHEN 'fulfilled'          THEN NEW.status IN ('partially_refunded','refunded','disputed')
    WHEN 'partially_refunded' THEN NEW.status IN ('refunded','disputed')
    WHEN 'disputed'           THEN NEW.status IN ('payment_captured','refunded')
    ELSE false  -- refunded, cancelled: terminal (no outbound edges)
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'book_orders: illegal status transition (% -> %)',
      OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER book_orders_status_edge_guard_trg
  BEFORE UPDATE OF status ON book_orders
  FOR EACH ROW
  EXECUTE FUNCTION book_orders_status_edge_guard();

-- ---- 1b. book_audit_applications status edge validator (BEFORE UPDATE) -------
CREATE OR REPLACE FUNCTION book_audit_applications_status_edge_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ok boolean := false;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'book_audit_applications: same-state status transition (% -> %) is not allowed',
      OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  ok := CASE OLD.status
    WHEN 'draft'     THEN NEW.status IN ('submitted','withdrawn')
    WHEN 'submitted' THEN NEW.status IN ('qualified','not_qualified','withdrawn')
    ELSE false  -- qualified, not_qualified, withdrawn: terminal
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'book_audit_applications: illegal status transition (% -> %)',
      OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER book_audit_applications_status_edge_guard_trg
  BEFORE UPDATE OF status ON book_audit_applications
  FOR EACH ROW
  EXECUTE FUNCTION book_audit_applications_status_edge_guard();

-- ---- 1c. book_appointments status edge validator (BEFORE UPDATE) -------------
CREATE OR REPLACE FUNCTION book_appointments_status_edge_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ok boolean := false;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'book_appointments: same-state status transition (% -> %) is not allowed',
      OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  ok := CASE OLD.status
    WHEN 'pending'   THEN NEW.status IN ('scheduled','cancelled')
    WHEN 'scheduled' THEN NEW.status IN ('completed','cancelled','no_show')
    WHEN 'no_show'   THEN NEW.status IN ('scheduled')
    ELSE false  -- completed, cancelled: terminal
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'book_appointments: illegal status transition (% -> %)',
      OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER book_appointments_status_edge_guard_trg
  BEFORE UPDATE OF status ON book_appointments
  FOR EACH ROW
  EXECUTE FUNCTION book_appointments_status_edge_guard();

-- ---- 2a. book_orders protocol verifier (DEFERRED constraint trigger) ---------
CREATE OR REPLACE FUNCTION book_orders_protocol_verify()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  k text := 'order-transition:' || NEW.id || ':' || OLD.status || ':' || NEW.status;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  -- Lifecycle audit row required for every order status change.
  IF NOT EXISTS (
    SELECT 1 FROM book_lifecycle_events le
    WHERE le.idempotency_key = k
      AND le.from_status = OLD.status
      AND le.to_status   = NEW.status
  ) THEN
    RAISE EXCEPTION 'book_orders: missing lifecycle event for transition % -> % (key %)',
      OLD.status, NEW.status, k USING ERRCODE = '23514';
  END IF;
  -- Outbox row required for every order status change.
  IF NOT EXISTS (
    SELECT 1 FROM book_outbox ob
    WHERE ob.idempotency_key = k
      AND ob.source_type = 'order'
      AND ob.source_id   = NEW.id
  ) THEN
    RAISE EXCEPTION 'book_orders: missing outbox row for transition % -> % (key %)',
      OLD.status, NEW.status, k USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'book_orders_protocol_verify_trg'
      AND tgrelid = 'book_orders'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER book_orders_protocol_verify_trg
      AFTER UPDATE OF status ON book_orders
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION book_orders_protocol_verify();
  END IF;
END;
$$;

-- ---- 2b. book_audit_applications protocol verifier (DEFERRED) ----------------
CREATE OR REPLACE FUNCTION book_audit_applications_protocol_verify()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  k text := 'application-transition:' || NEW.id || ':' || OLD.status || ':' || NEW.status;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM book_lifecycle_events le
    WHERE le.idempotency_key = k
      AND le.from_status = OLD.status
      AND le.to_status   = NEW.status
  ) THEN
    RAISE EXCEPTION 'book_audit_applications: missing lifecycle event for transition % -> % (key %)',
      OLD.status, NEW.status, k USING ERRCODE = '23514';
  END IF;
  -- Outbox required only for submitted / qualified / not_qualified.
  IF NEW.status IN ('submitted','qualified','not_qualified') THEN
    IF NOT EXISTS (
      SELECT 1 FROM book_outbox ob
      WHERE ob.idempotency_key = k
        AND ob.source_type = 'application'
        AND ob.source_id   = NEW.id
    ) THEN
      RAISE EXCEPTION 'book_audit_applications: missing outbox row for transition % -> % (key %)',
        OLD.status, NEW.status, k USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'book_audit_applications_protocol_verify_trg'
      AND tgrelid = 'book_audit_applications'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER book_audit_applications_protocol_verify_trg
      AFTER UPDATE OF status ON book_audit_applications
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION book_audit_applications_protocol_verify();
  END IF;
END;
$$;

-- ---- 2c. book_appointments protocol verifier (DEFERRED) ----------------------
CREATE OR REPLACE FUNCTION book_appointments_protocol_verify()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  k text := 'appointment-transition:' || NEW.id || ':' || OLD.status || ':' || NEW.status;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM book_lifecycle_events le
    WHERE le.idempotency_key = k
      AND le.from_status = OLD.status
      AND le.to_status   = NEW.status
  ) THEN
    RAISE EXCEPTION 'book_appointments: missing lifecycle event for transition % -> % (key %)',
      OLD.status, NEW.status, k USING ERRCODE = '23514';
  END IF;
  -- Outbox required only for scheduled / cancelled.
  IF NEW.status IN ('scheduled','cancelled') THEN
    IF NOT EXISTS (
      SELECT 1 FROM book_outbox ob
      WHERE ob.idempotency_key = k
        AND ob.source_type = 'appointment'
        AND ob.source_id   = NEW.id
    ) THEN
      RAISE EXCEPTION 'book_appointments: missing outbox row for transition % -> % (key %)',
        OLD.status, NEW.status, k USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'book_appointments_protocol_verify_trg'
      AND tgrelid = 'book_appointments'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER book_appointments_protocol_verify_trg
      AFTER UPDATE OF status ON book_appointments
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION book_appointments_protocol_verify();
  END IF;
END;
$$;

-- ---- 3. book_lifecycle_events append-only (audit evidence) -------------------
-- The lifecycle log is audit evidence; it may only ever be inserted. Reject
-- UPDATE or DELETE. The function always raises, so it is correct for both.
CREATE OR REPLACE FUNCTION book_lifecycle_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'book_lifecycle_events is append-only audit evidence and cannot be updated or deleted'
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER book_lifecycle_events_append_only_trg
  BEFORE UPDATE OR DELETE ON book_lifecycle_events
  FOR EACH ROW
  EXECUTE FUNCTION book_lifecycle_events_append_only();
