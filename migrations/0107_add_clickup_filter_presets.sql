CREATE TABLE IF NOT EXISTS "clickup_filter_presets" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" varchar NOT NULL,
  "name" text NOT NULL,
  "workspace_id" varchar NOT NULL,
  "filters" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "clickup_filter_presets_user_idx" ON "clickup_filter_presets" ("user_id");
CREATE INDEX IF NOT EXISTS "clickup_filter_presets_workspace_idx" ON "clickup_filter_presets" ("workspace_id");
