-- Task #4328 — Unified client activity timeline.
-- Additive only; idempotent (safe under the dev-migration replay seam).
-- The timeline's ticket arm queries sd_ticket_mapping by client_uuid
-- (NoBull clients.id) ordered newest-first, but only the legacy integer
-- client_id column was indexed. Composite (client_uuid, created_at) serves
-- the per-client filter, the (created_at, id) keyset predicate, and the
-- DESC ordering directly.
CREATE INDEX IF NOT EXISTS sd_ticket_mapping_client_uuid_created_idx
  ON sd_ticket_mapping (client_uuid, created_at);
