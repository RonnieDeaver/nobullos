-- Enforce at most one active channel per client. The WHERE clause makes this a
-- partial index so archived channels are excluded and old-archive / new-active
-- pairs are allowed. provisionClientChannel uses ON CONFLICT DO NOTHING + re-read
-- so concurrent provisioning is safe under autoscale.
CREATE UNIQUE INDEX IF NOT EXISTS comms_channels_unique_active_client
  ON comms_channels(client_id)
  WHERE client_id IS NOT NULL AND archived_at IS NULL;
