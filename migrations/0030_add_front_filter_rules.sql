CREATE TABLE IF NOT EXISTS "front_filter_rules" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "type" varchar NOT NULL,
  "scope" varchar NOT NULL,
  "value" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_by" varchar REFERENCES "users"("id"),
  "last_applied_at" timestamp,
  "affected_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "front_filter_rules_type_scope_value_uniq"
  ON "front_filter_rules" ("type", "scope", "value");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "front_filter_rules_enabled_idx"
  ON "front_filter_rules" ("enabled");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "front_filter_rules_scope_idx"
  ON "front_filter_rules" ("scope");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "front_filter_rules_type_idx"
  ON "front_filter_rules" ("type");
