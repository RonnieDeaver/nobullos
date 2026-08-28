CREATE TABLE IF NOT EXISTS clickup_webhook_receipts (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_key varchar NOT NULL,
  webhook_id varchar NOT NULL,
  workspace_id varchar NOT NULL,
  service_user_id varchar NOT NULL,
  event_type varchar NOT NULL,
  provider_event_id varchar,
  task_id varchar NOT NULL,
  list_id varchar NOT NULL,
  body_sha256 varchar NOT NULL,
  queue_job_id varchar,
  received_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS clickup_webhook_receipts_delivery_key_idx
  ON clickup_webhook_receipts (delivery_key);
CREATE INDEX IF NOT EXISTS clickup_webhook_receipts_queue_job_idx
  ON clickup_webhook_receipts (queue_job_id);
CREATE INDEX IF NOT EXISTS clickup_webhook_receipts_task_received_idx
  ON clickup_webhook_receipts (task_id, received_at);

ALTER TABLE clickup_webhooks
  ADD COLUMN IF NOT EXISTS location_type varchar;