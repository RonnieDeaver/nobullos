ALTER TABLE "front_sync_emails" ADD COLUMN "bulk_classifier_version" integer;--> statement-breakpoint
ALTER TABLE "raw_communication_records" ADD COLUMN "bulk_classifier_version" integer;