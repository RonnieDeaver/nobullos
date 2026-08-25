CREATE TABLE "twilio_calls" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar,
	"client_contact_id" varchar,
	"twilio_sid" varchar,
	"direction" varchar NOT NULL,
	"from_number" varchar NOT NULL,
	"to_number" varchar NOT NULL,
	"status" varchar DEFAULT 'initiated' NOT NULL,
	"duration" integer,
	"initiated_by_user_id" varchar,
	"raw_communication_record_id" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "twilio_conversations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar,
	"client_contact_id" varchar,
	"contact_phone" varchar NOT NULL,
	"contact_name" varchar,
	"twilio_phone_number" varchar NOT NULL,
	"status" varchar DEFAULT 'active' NOT NULL,
	"last_message_at" timestamp,
	"last_message_preview" text,
	"unread_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "twilio_messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" varchar NOT NULL,
	"twilio_sid" varchar,
	"direction" varchar NOT NULL,
	"from_number" varchar NOT NULL,
	"to_number" varchar NOT NULL,
	"body" text NOT NULL,
	"status" varchar DEFAULT 'queued' NOT NULL,
	"sent_by_user_id" varchar,
	"raw_communication_record_id" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "caller_id_name" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_sign_off" text;--> statement-breakpoint
ALTER TABLE "webhook_import_logs" ADD COLUMN "pdf_extracted_text" text;--> statement-breakpoint
ALTER TABLE "command_panels" ADD COLUMN "google_drive_folder_name" text;--> statement-breakpoint
ALTER TABLE "command_panels" ADD COLUMN "zoom_recordings_folder_id" text;--> statement-breakpoint
ALTER TABLE "command_panels" ADD COLUMN "zoom_recordings_folder_link" text;--> statement-breakpoint
ALTER TABLE "command_panels" ADD COLUMN "zoom_recordings_folder_name" text;--> statement-breakpoint
ALTER TABLE "command_panels" ADD COLUMN "rer_reports_folder_id" text;--> statement-breakpoint
ALTER TABLE "command_panels" ADD COLUMN "rer_reports_folder_link" text;--> statement-breakpoint
ALTER TABLE "command_panels" ADD COLUMN "rer_reports_folder_name" text;--> statement-breakpoint
ALTER TABLE "twilio_calls" ADD CONSTRAINT "twilio_calls_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_calls" ADD CONSTRAINT "twilio_calls_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_conversations" ADD CONSTRAINT "twilio_conversations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_messages" ADD CONSTRAINT "twilio_messages_conversation_id_twilio_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."twilio_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_messages" ADD CONSTRAINT "twilio_messages_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "twilio_call_client_id_idx" ON "twilio_calls" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "twilio_call_twilio_sid_idx" ON "twilio_calls" USING btree ("twilio_sid");--> statement-breakpoint
CREATE INDEX "twilio_conv_client_id_idx" ON "twilio_conversations" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "twilio_conv_contact_phone_idx" ON "twilio_conversations" USING btree ("contact_phone");--> statement-breakpoint
CREATE INDEX "twilio_conv_last_message_idx" ON "twilio_conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "twilio_msg_conversation_id_idx" ON "twilio_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "twilio_msg_twilio_sid_idx" ON "twilio_messages" USING btree ("twilio_sid");--> statement-breakpoint
CREATE INDEX "twilio_msg_created_at_idx" ON "twilio_messages" USING btree ("created_at");