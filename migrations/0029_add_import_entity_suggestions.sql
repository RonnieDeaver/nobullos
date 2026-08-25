CREATE TABLE IF NOT EXISTS "import_entity_suggestions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id" varchar NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "entity_kind" varchar NOT NULL,
  "surface" varchar NOT NULL,
  "candidate" jsonb NOT NULL,
  "source_ref" jsonb,
  "reason" text,
  "status" varchar NOT NULL DEFAULT 'pending',
  "reviewed_by_user_id" varchar REFERENCES "users"("id"),
  "reviewed_at" timestamp,
  "promoted_entity_id" varchar,
  "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "import_entity_suggestions_client_id_idx"
  ON "import_entity_suggestions" ("client_id");
CREATE INDEX IF NOT EXISTS "import_entity_suggestions_status_idx"
  ON "import_entity_suggestions" ("status");
