CREATE TABLE "operational_filter_memory" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier_type" varchar NOT NULL,
	"identifier_value" text NOT NULL,
	"source" varchar DEFAULT 'auto_dismissed' NOT NULL,
	"confidence_weight" real DEFAULT 0.5 NOT NULL,
	"first_seen_at" timestamp DEFAULT now(),
	"last_seen_at" timestamp DEFAULT now(),
	"learned_from_id" varchar,
	"usage_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "ats_final_decisions" ADD COLUMN "last_feedback" text;--> statement-breakpoint
ALTER TABLE "ats_jobs" ADD COLUMN "last_feedback" text;--> statement-breakpoint
CREATE INDEX "op_filter_mem_type_idx" ON "operational_filter_memory" USING btree ("identifier_type");--> statement-breakpoint
CREATE INDEX "op_filter_mem_value_idx" ON "operational_filter_memory" USING btree ("identifier_value");--> statement-breakpoint
CREATE INDEX "op_filter_mem_type_value_idx" ON "operational_filter_memory" USING btree ("identifier_type","identifier_value");--> statement-breakpoint
CREATE INDEX "raw_comm_client_timestamp_idx" ON "raw_communication_records" USING btree ("client_id","timestamp");