CREATE TABLE IF NOT EXISTS "communication_client_links" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_communication_record_id" varchar NOT NULL,
	"client_id" varchar NOT NULL,
	"match_method" varchar,
	"match_confidence" real,
	"relevant_segments" jsonb,
	"per_client_summary" text,
	"is_primary" boolean DEFAULT false,
	"status" varchar DEFAULT 'detected' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "comm_client_link_unique" UNIQUE("raw_communication_record_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "communication_client_links" ADD CONSTRAINT "communication_client_links_raw_communication_record_id_raw_communication_records_id_fk" FOREIGN KEY ("raw_communication_record_id") REFERENCES "public"."raw_communication_records"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "communication_client_links" ADD CONSTRAINT "communication_client_links_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comm_client_link_record_idx" ON "communication_client_links" USING btree ("raw_communication_record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comm_client_link_client_idx" ON "communication_client_links" USING btree ("client_id");
