CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"role" varchar DEFAULT 'account_manager',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_contacts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"name" text NOT NULL,
	"emails" text[] DEFAULT '{}',
	"phones" text[] DEFAULT '{}',
	"role_title" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "client_data_access" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"category" varchar NOT NULL,
	"status" varchar DEFAULT 'unknown',
	"notes" text,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "client_data_access_client_id_category_unique" UNIQUE("client_id","category")
);
--> statement-breakpoint
CREATE TABLE "client_locations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"lat" real,
	"lng" real,
	"radius_core" real,
	"radius_extended" real,
	"radius_fringe" real,
	"competitors_in_r2" integer,
	"radius_market" real,
	"r2_algo_version" varchar,
	"state_fips" varchar,
	"county_fips" varchar,
	"is_active" boolean DEFAULT true,
	"geocoded_at" timestamp,
	"radius_computed_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_code" varchar(10),
	"firm_name" text NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"contact_phone" text,
	"consult_type" varchar DEFAULT 'free',
	"practice_areas" text[],
	"products" text[] DEFAULT ARRAY['gbp']::text[],
	"average_case_value" real,
	"initial_leads" integer DEFAULT 0,
	"initial_reviews" integer DEFAULT 0,
	"initial_cases" integer DEFAULT 0,
	"is_demo" boolean DEFAULT false,
	"is_archived" boolean DEFAULT false,
	"terminology" jsonb,
	"client_start_date" timestamp,
	"has_post_consult_review_access" boolean DEFAULT false,
	"has_post_case_closed_review_access" boolean DEFAULT false,
	"owner_id" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "clients_client_code_unique" UNIQUE("client_code")
);
--> statement-breakpoint
CREATE TABLE "ceo_pulses" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"month_key" varchar NOT NULL,
	"title" text,
	"raw_content" text NOT NULL,
	"ai_analysis" jsonb,
	"full_letter_html" text,
	"is_published" boolean DEFAULT false,
	"share_token" varchar,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "ceo_pulses_month_key_unique" UNIQUE("month_key"),
	CONSTRAINT "ceo_pulses_share_token_unique" UNIQUE("share_token")
);
--> statement-breakpoint
CREATE TABLE "industry_trends" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_month" text NOT NULL,
	"raw_content" text NOT NULL,
	"ai_analysis" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "intake_stats" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_month" text NOT NULL,
	"missed_call_rate" real NOT NULL,
	"avg_time_to_answer" real NOT NULL,
	"quality_score" integer NOT NULL,
	"common_issue" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"type" varchar NOT NULL,
	"message" text NOT NULL,
	"is_read" boolean DEFAULT false,
	"related_report_id" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "report_sections" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" varchar NOT NULL,
	"section_key" varchar NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "report_sections_report_id_section_key_unique" UNIQUE("report_id","section_key")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"report_month" varchar NOT NULL,
	"status" varchar DEFAULT 'draft',
	"ceo_pulse_id" varchar,
	"share_token" varchar,
	"privacy_mode" boolean DEFAULT false,
	"hide_lead_quality" boolean DEFAULT false,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "reports_share_token_unique" UNIQUE("share_token"),
	CONSTRAINT "reports_client_id_report_month_unique" UNIQUE("client_id","report_month")
);
--> statement-breakpoint
CREATE TABLE "phase_settings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phase" text NOT NULL,
	"actions" text[] NOT NULL,
	"updated_by" varchar,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "phase_settings_phase_unique" UNIQUE("phase")
);
--> statement-breakpoint
CREATE TABLE "practice_area_settings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_area" text NOT NULL,
	"search_term" text NOT NULL,
	"monthly_data" jsonb,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "practice_area_settings_practice_area_unique" UNIQUE("practice_area")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" varchar PRIMARY KEY NOT NULL,
	"value" text,
	"updated_by" varchar,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "census_tracts" (
	"geoid" varchar(11) PRIMARY KEY NOT NULL,
	"state_fips" varchar(2) NOT NULL,
	"county_fips" varchar(5) NOT NULL,
	"tract_code" varchar(6) NOT NULL,
	"population" integer DEFAULT 0 NOT NULL,
	"land_area_sq_m" real DEFAULT 0,
	"centroid_lat" real NOT NULL,
	"centroid_lng" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "h3_population" (
	"h3_index" varchar(20) PRIMARY KEY NOT NULL,
	"population" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcu_cache" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cache_type" varchar NOT NULL,
	"cache_key" text NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "mcu_cache_cache_type_cache_key_unique" UNIQUE("cache_type","cache_key")
);
--> statement-breakpoint
CREATE TABLE "mcu_evaluations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"evaluation_type" varchar NOT NULL,
	"practice_area" varchar NOT NULL,
	"addresses" jsonb NOT NULL,
	"results" jsonb NOT NULL,
	"verdict" varchar,
	"mcu_total" real,
	"mcu_allocated" real,
	"mcu_remaining" real,
	"overlap_risk" varchar,
	"scarcity_label" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "call_analysis_jobs" (
	"analysis_id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" varchar NOT NULL,
	"idempotency_key" varchar NOT NULL,
	"audio_url" text,
	"rev_transcript_json" jsonb,
	"max_listen_seconds" integer DEFAULT 60,
	"status" varchar DEFAULT 'queued' NOT NULL,
	"result_json" jsonb,
	"error_message" text,
	"created_at" timestamp DEFAULT now(),
	"started_at" timestamp,
	"completed_at" timestamp,
	"attempt_count" integer DEFAULT 0,
	CONSTRAINT "call_analysis_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "webhook_import_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar,
	"client_name" varchar,
	"report_month" varchar,
	"report_id" varchar,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"sections_created" jsonb,
	"field_confidence" jsonb,
	"pdf_file_name" varchar,
	"pdf_size_bytes" integer,
	"pdf_source_type" varchar,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ats_ai_runs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" varchar,
	"candidate_id" varchar,
	"stage_name" varchar NOT NULL,
	"input_refs" jsonb,
	"output_json" jsonb,
	"started_at" timestamp,
	"finished_at" timestamp,
	"success" boolean,
	"error_message" text,
	"model_id" varchar,
	"ai_spec_version" varchar,
	"prompt_hash" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ats_candidates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" varchar NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"stage" varchar DEFAULT 'applied' NOT NULL,
	"access_token" varchar NOT NULL,
	"tags" text[],
	"notes" text,
	"total_score" real,
	"ai_score_json" jsonb,
	"evidence_json" jsonb,
	"hiring_card_json" jsonb,
	"risk_tier" varchar,
	"fit_delta" real,
	"language_agency_score" real,
	"agency_under_pressure" real,
	"agency_consistency" real,
	"ai_likelihood_score" real,
	"ai_assistance_flag" varchar,
	"resume_text" text,
	"resume_profile_json" jsonb,
	"resume_consistency_json" jsonb,
	"ai_spec_version" varchar,
	"model_id" varchar,
	"invited_at" timestamp,
	"screening_completed_at" timestamp,
	"video_completed_at" timestamp,
	"ai_scored_at" timestamp,
	"reviewed_at" timestamp,
	"rejected_at" timestamp,
	"assessment_base_score" real,
	"interview_multiplier" real,
	"interview_adjustment_percent" real,
	"final_display_score" real,
	"score_change_summary" text,
	"interview_adjustment_summary" text,
	"cohort_adjustment_summary" text,
	"calibrated_score" real,
	"calibration_multiplier" real,
	"pairwise_win_rate" real,
	"cohort_rank" integer,
	"cohort_percentile" real,
	"cohort_size" integer,
	"comparative_summary" text,
	"last_calibrated_at" timestamp,
	"dimension_history" jsonb,
	"evidence_stage_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "ats_candidates_access_token_unique" UNIQUE("access_token")
);
--> statement-breakpoint
CREATE TABLE "ats_email_templates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"template_type" varchar NOT NULL,
	"job_id" varchar,
	"is_global" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ats_final_decisions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" varchar NOT NULL,
	"job_id" varchar NOT NULL,
	"generated_at" timestamp DEFAULT now(),
	"based_on_stages_completed" text[],
	"decision_json" jsonb,
	"final_recommendation" varchar,
	"confidence" real,
	"next_step" varchar,
	"approved_by" varchar,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ats_interviews" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" varchar NOT NULL,
	"job_id" varchar NOT NULL,
	"interview_type" varchar NOT NULL,
	"transcript" text,
	"interview_notes" text,
	"uploaded_at" timestamp,
	"uploaded_by" varchar,
	"analysis_json" jsonb,
	"analysis_status" varchar DEFAULT 'pending' NOT NULL,
	"manual_ratings" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ats_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" varchar DEFAULT 'draft' NOT NULL,
	"screening_questions" jsonb,
	"video_tasks" jsonb,
	"rubric" jsonb,
	"hard_fails" jsonb,
	"clarification_questions" jsonb,
	"clarification_answers" jsonb,
	"role_source_of_truth" jsonb,
	"cognitive_profile" jsonb,
	"assessment_json" jsonb,
	"rubric_json" jsonb,
	"assessment_meta" jsonb,
	"ai_spec_version" varchar,
	"model_id" varchar,
	"ai_generated_at" timestamp,
	"scorecard_text" text,
	"scorecard_json" jsonb,
	"invite_token" varchar,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "ats_jobs_invite_token_unique" UNIQUE("invite_token")
);
--> statement-breakpoint
CREATE TABLE "ats_pairwise_comparisons" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" varchar NOT NULL,
	"candidate_a_id" varchar NOT NULL,
	"candidate_b_id" varchar NOT NULL,
	"winner" varchar NOT NULL,
	"confidence" varchar NOT NULL,
	"decisive_factors" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ats_submissions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" varchar NOT NULL,
	"job_id" varchar NOT NULL,
	"question_id" varchar NOT NULL,
	"question_type" varchar NOT NULL,
	"question_layer" varchar,
	"response_text" text,
	"video_url" text,
	"video_object_key" text,
	"video_duration_sec" real,
	"is_timed" boolean DEFAULT false,
	"time_limit_sec" integer,
	"time_used_sec" real,
	"no_redo" boolean DEFAULT false,
	"locked_at" timestamp,
	"contradiction_pair_id" varchar,
	"contradiction_role" varchar,
	"trait_target" varchar,
	"paste_events" integer DEFAULT 0,
	"time_to_first_keystroke_sec" real,
	"total_typing_time_sec" real,
	"evidence_markers" jsonb,
	"transcription_status" varchar,
	"transcript_json" jsonb,
	"transcript_text" text,
	"rev_job_id" varchar,
	"ai_score" real,
	"ai_score_json" jsonb,
	"ai_feedback" text,
	"manual_score" real,
	"manual_feedback" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "action_log_entries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"created_by" varchar NOT NULL,
	"action_type" varchar NOT NULL,
	"title" text NOT NULL,
	"what_changed" text,
	"why_changed" text,
	"impacted_systems" text[],
	"related_objective" text,
	"related_product_type" text,
	"related_campaign" text,
	"source_references" jsonb,
	"rollback_note" text,
	"linked_intelligence_entry_ids" text[],
	"linked_command_panel_fields" text[],
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "command_panel_history" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_panel_id" varchar NOT NULL,
	"client_id" varchar NOT NULL,
	"field_name" varchar NOT NULL,
	"old_value" text,
	"new_value" text,
	"changed_by" varchar NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "command_panel_key_calls" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_panel_id" varchar NOT NULL,
	"client_id" varchar NOT NULL,
	"call_type" varchar NOT NULL,
	"raw_communication_record_id" varchar,
	"assigned_by" varchar,
	"assigned_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "command_panel_rer_recordings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_panel_id" varchar NOT NULL,
	"client_id" varchar NOT NULL,
	"raw_communication_record_id" varchar NOT NULL,
	"reporting_month" varchar NOT NULL,
	"assigned_by" varchar,
	"assigned_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "command_panel_versions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"field_name" varchar NOT NULL,
	"previous_value" text,
	"new_value" text,
	"changed_by" varchar NOT NULL,
	"changed_at" timestamp DEFAULT now(),
	"source_reference" text,
	"change_reason" text
);
--> statement-breakpoint
CREATE TABLE "command_panels" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"account_owner_id" varchar,
	"secondary_owner_ids" text[],
	"product_types" text[],
	"product_status_notes" text,
	"google_ads_budget" real,
	"webinar_budget" real,
	"lsa_budget" real,
	"quarter_primary_objective" text,
	"annual_goals" text,
	"long_term_goals" text,
	"success_definition_quarter" text,
	"growth_strategy" text,
	"current_bottleneck" varchar,
	"budget_posture" varchar,
	"priority_markets" jsonb,
	"secondary_markets" jsonb,
	"geographic_expansion_notes" text,
	"active_campaign_focus" text,
	"active_offers" text,
	"key_active_initiatives" text,
	"current_risk_flags" text,
	"current_opportunities" text,
	"client_preferences" text,
	"internal_handling_notes" text,
	"google_drive_folder_link" text,
	"external_system_links" jsonb,
	"last_reviewed_at" timestamp,
	"last_reviewed_by" varchar,
	"last_updated_at" timestamp DEFAULT now(),
	"last_updated_by" varchar,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "command_panels_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "intelligence_feed_entries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"created_by" varchar NOT NULL,
	"entry_type" varchar NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"tags" text[],
	"source_references" jsonb,
	"ai_confidence" varchar,
	"status" varchar DEFAULT 'draft' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"linked_action_log_ids" text[],
	"linked_command_panel_fields" text[],
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "client_semrush_integrations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"integration_enabled" boolean DEFAULT true NOT NULL,
	"semrush_campaign_id" text,
	"business_name" text,
	"business_location_id" text,
	"default_grid_size" text DEFAULT '9x9',
	"default_keywords" text[],
	"sync_status" text DEFAULT 'idle',
	"last_successful_sync_at" timestamp,
	"last_failed_sync_at" timestamp,
	"error_message" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "client_semrush_integrations_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "heatmap_competitor_snapshots" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" varchar NOT NULL,
	"client_id" varchar,
	"campaign_id" text NOT NULL,
	"keyword" text NOT NULL,
	"scan_date" timestamp NOT NULL,
	"competitor_name" text NOT NULL,
	"competitor_rank_position" integer,
	"competitor_share_of_voice" double precision,
	"competitor_average_rank" double precision,
	"competitor_review_count" integer,
	"competitor_review_rating" double precision,
	"competitor_gbp_url" text,
	"is_subject_business" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "heatmap_metrics" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" varchar NOT NULL,
	"avg_rank" double precision,
	"median_rank" double precision,
	"best_rank" integer,
	"worst_rank" integer,
	"top_3_coverage_pct" double precision,
	"top_10_coverage_pct" double precision,
	"ranked_points_count" integer,
	"unranked_points_count" integer,
	"share_of_voice_90d_avg" double precision,
	"share_of_voice_anchor_increase" double precision,
	"band_top_3_pct" double precision,
	"band_4_to_10_pct" double precision,
	"band_11_to_20_pct" double precision,
	"band_out_of_top_20_pct" double precision,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "heatmap_overrides" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" text NOT NULL,
	"template" text,
	"unit" text,
	"distance" double precision,
	"base_lat" double precision,
	"base_lng" double precision,
	"market_type" text,
	"notes" text,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "heatmap_points" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" varchar NOT NULL,
	"point_id" text NOT NULL,
	"point_index" integer,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"position" integer,
	"diff" integer,
	"is_enabled" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "heatmap_snapshots" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar,
	"location_id" text NOT NULL,
	"location_name" text NOT NULL,
	"business_name" text,
	"campaign_id" text NOT NULL,
	"keyword_id" text,
	"keyword_name" text NOT NULL,
	"report_date" timestamp NOT NULL,
	"business_lat" double precision NOT NULL,
	"business_lng" double precision NOT NULL,
	"grid_template" text NOT NULL,
	"grid_unit" text NOT NULL,
	"grid_distance" double precision NOT NULL,
	"base_lat" double precision NOT NULL,
	"base_lng" double precision NOT NULL,
	"points_number" integer,
	"share_of_voice_raw" double precision,
	"raw_payload" jsonb NOT NULL,
	"geojson_cache" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "semrush_location_campaigns" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"location_id" varchar NOT NULL,
	"semrush_campaign_id" text NOT NULL,
	"semrush_campaign_name" text,
	"is_stale" boolean DEFAULT false NOT NULL,
	"stale_since" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ai_suggestions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"raw_communication_record_id" varchar NOT NULL,
	"destination_type" varchar NOT NULL,
	"suggested_title" text NOT NULL,
	"suggested_body" text,
	"suggested_field_changes_json" jsonb,
	"confidence_score" real,
	"priority" varchar DEFAULT 'normal' NOT NULL,
	"reason_for_recommendation" text,
	"citation_snippets_json" jsonb,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"assigned_to_user_id" varchar,
	"resolved_at" timestamp,
	"resolution_notes" text,
	"resulting_record_id" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "client_conversation_summaries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"summary_json" jsonb NOT NULL,
	"generated_at" timestamp NOT NULL,
	"window_start" timestamp NOT NULL,
	"window_end" timestamp NOT NULL,
	"comm_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "client_conversation_summaries_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "front_sync_emails" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"subject" text,
	"snippet" text,
	"participants_json" jsonb,
	"front_status" varchar,
	"last_message_at" timestamp,
	"matched_client_id" varchar,
	"match_status" varchar DEFAULT 'unmatched' NOT NULL,
	"match_confidence" real,
	"match_reason" text,
	"ingested_record_id" varchar,
	"operational_classification_reason" text,
	"dismissed_by" varchar,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "front_sync_emails_conversation_id_unique" UNIQUE("conversation_id")
);
--> statement-breakpoint
CREATE TABLE "raw_communication_records" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar,
	"source_type" varchar NOT NULL,
	"source_subtype" varchar,
	"title" text NOT NULL,
	"timestamp" timestamp NOT NULL,
	"direction" varchar,
	"participants_json" jsonb,
	"external_source_id" text,
	"external_thread_id" text,
	"external_url" text,
	"content_text" text,
	"content_preview" text,
	"raw_payload_json" jsonb,
	"processing_status" varchar DEFAULT 'pending' NOT NULL,
	"ai_summary" text,
	"ai_signals" jsonb,
	"ai_processed_at" timestamp,
	"review_status" varchar DEFAULT 'unreviewed' NOT NULL,
	"has_suggestions" boolean DEFAULT false,
	"google_drive_file_url" text,
	"match_method" varchar,
	"match_confidence" real,
	"match_status" varchar,
	"operational_classification_reason" text,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "slack_channel_mappings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" varchar NOT NULL,
	"channel_name" varchar NOT NULL,
	"mapped_client_id" varchar,
	"auto_created" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "slack_channel_mappings_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE "slack_sync_history" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"triggered_by" varchar,
	"status" varchar DEFAULT 'running' NOT NULL,
	"channels_processed" integer DEFAULT 0,
	"messages_created" integer DEFAULT 0,
	"messages_skipped" integer DEFAULT 0,
	"errors" jsonb,
	"started_at" timestamp DEFAULT now(),
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "agent_feedback" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_type" varchar NOT NULL,
	"target_record_id" varchar NOT NULL,
	"target_record_type" varchar NOT NULL,
	"client_id" varchar,
	"feedback_type" varchar NOT NULL,
	"corrected_value" text,
	"user_id" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agent_knowledge_base" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"fact_category" varchar NOT NULL,
	"fact_text" text NOT NULL,
	"confidence" real DEFAULT 0.7 NOT NULL,
	"source_agent" varchar NOT NULL,
	"source_record_id" varchar,
	"first_seen_at" timestamp DEFAULT now(),
	"last_seen_at" timestamp DEFAULT now(),
	"usage_count" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agent_match_decisions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"communication_id" varchar NOT NULL,
	"communication_type" varchar NOT NULL,
	"client_id" varchar NOT NULL,
	"confidence_score" real NOT NULL,
	"status" varchar NOT NULL,
	"explanation_summary" text,
	"supporting_signals_json" jsonb,
	"semantic_reasoning_summary" text,
	"evidence_type" varchar DEFAULT 'structured' NOT NULL,
	"reviewed_by_human" boolean DEFAULT false NOT NULL,
	"corrected_by_human" boolean DEFAULT false NOT NULL,
	"corrected_to_client_id" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "client_agent_chats" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"role" varchar NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "client_agent_memory" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"identifier_type" varchar NOT NULL,
	"identifier_value" text NOT NULL,
	"source" varchar DEFAULT 'seeded' NOT NULL,
	"confidence_weight" real DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp DEFAULT now(),
	"last_seen_at" timestamp DEFAULT now(),
	"learned_from_match_id" varchar,
	"manually_added" boolean DEFAULT false NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "client_communication_insights" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"raw_communication_record_id" varchar NOT NULL,
	"overall_sentiment" real,
	"sentiment_trend" varchar,
	"per_person_sentiment" jsonb,
	"trust_level" real,
	"urgency_level" real,
	"frustration_level" real,
	"gratitude_level" real,
	"confusion_level" real,
	"disappointment_level" real,
	"complaint_themes" jsonb,
	"extracted_asks" jsonb,
	"extracted_promises" jsonb,
	"enrichment_model" varchar,
	"enriched_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "client_comm_insights_unique_comm" UNIQUE("raw_communication_record_id")
);
--> statement-breakpoint
CREATE TABLE "client_daily_judgments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"judgment_date" varchar NOT NULL,
	"status" varchar NOT NULL,
	"relationship_health" varchar,
	"confidence" varchar DEFAULT 'Medium',
	"overall_sentiment" real,
	"sentiment_trend" varchar,
	"headline" text,
	"narrative_summary" text,
	"key_risks" jsonb,
	"key_opportunities" jsonb,
	"unresolved_ask_count" integer DEFAULT 0,
	"communications_analyzed" integer DEFAULT 0,
	"data_sources_summary" jsonb,
	"overall_status" varchar,
	"relationship_status" varchar,
	"confidence_level" varchar,
	"summary_text" text,
	"sentiment_summary" text,
	"change_summary" text,
	"concerns_json" jsonb,
	"unresolved_asks_json" jsonb,
	"wins_json" jsonb,
	"actions_json" jsonb,
	"relationship_health_score" real,
	"sentiment_score" real,
	"complaint_score" real,
	"risk_score" real,
	"generated_from_start_at" timestamp,
	"generated_from_end_at" timestamp,
	"model_version" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "client_daily_judgments_client_id_judgment_date_unique" UNIQUE("client_id","judgment_date")
);
--> statement-breakpoint
CREATE TABLE "client_open_asks" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"ask_type" varchar NOT NULL,
	"ask_text" text,
	"ask_category" varchar,
	"summary" text NOT NULL,
	"detail" text,
	"status" varchar DEFAULT 'open' NOT NULL,
	"concern_score" real DEFAULT 1,
	"confidence" real,
	"first_mentioned_at" timestamp DEFAULT now(),
	"last_referenced_at" timestamp DEFAULT now(),
	"mention_count" integer DEFAULT 1,
	"source_type" varchar,
	"source_record_id" varchar,
	"source_record_ids" text[],
	"created_from_timestamp" timestamp,
	"requested_by" varchar,
	"assigned_to" varchar,
	"likely_resolved" boolean DEFAULT false,
	"likely_resolved_at" timestamp,
	"related_promise_text" text,
	"resolved_at" timestamp,
	"resolved_by" varchar,
	"resolution_note" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "client_relationship_signals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar NOT NULL,
	"signal_date" varchar NOT NULL,
	"judgment_id" varchar,
	"avg_trust" real,
	"avg_urgency" real,
	"avg_frustration" real,
	"avg_gratitude" real,
	"avg_confusion" real,
	"avg_disappointment" real,
	"overall_sentiment" real,
	"sentiment_trend" varchar,
	"communication_count" integer DEFAULT 0,
	"top_complaint_themes" jsonb,
	"relationship_health_score" real,
	"sentiment_score" real,
	"complaint_score" real,
	"trust_score" real,
	"responsiveness_risk_score" real,
	"execution_risk_score" real,
	"lead_volume_concern_score" real,
	"unresolved_task_score" real,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "client_relationship_signals_client_id_signal_date_unique" UNIQUE("client_id","signal_date")
);
--> statement-breakpoint
CREATE TABLE "pandadoc_documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"created_date" timestamp,
	"completed_date" timestamp,
	"expiration_date" timestamp,
	"recipients_json" jsonb,
	"content_text" text,
	"linked_client_id" varchar,
	"last_synced_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "pandadoc_documents_document_id_unique" UNIQUE("document_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contacts" ADD CONSTRAINT "client_contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_data_access" ADD CONSTRAINT "client_data_access_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_locations" ADD CONSTRAINT "client_locations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceo_pulses" ADD CONSTRAINT "ceo_pulses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_related_report_id_reports_id_fk" FOREIGN KEY ("related_report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sections" ADD CONSTRAINT "report_sections_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_ceo_pulse_id_ceo_pulses_id_fk" FOREIGN KEY ("ceo_pulse_id") REFERENCES "public"."ceo_pulses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_settings" ADD CONSTRAINT "phase_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcu_evaluations" ADD CONSTRAINT "mcu_evaluations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_ai_runs" ADD CONSTRAINT "ats_ai_runs_job_id_ats_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ats_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_ai_runs" ADD CONSTRAINT "ats_ai_runs_candidate_id_ats_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."ats_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_candidates" ADD CONSTRAINT "ats_candidates_job_id_ats_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ats_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_email_templates" ADD CONSTRAINT "ats_email_templates_job_id_ats_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ats_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_final_decisions" ADD CONSTRAINT "ats_final_decisions_candidate_id_ats_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."ats_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_final_decisions" ADD CONSTRAINT "ats_final_decisions_job_id_ats_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ats_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_interviews" ADD CONSTRAINT "ats_interviews_candidate_id_ats_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."ats_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_interviews" ADD CONSTRAINT "ats_interviews_job_id_ats_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ats_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_jobs" ADD CONSTRAINT "ats_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_pairwise_comparisons" ADD CONSTRAINT "ats_pairwise_comparisons_job_id_ats_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ats_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_pairwise_comparisons" ADD CONSTRAINT "ats_pairwise_comparisons_candidate_a_id_ats_candidates_id_fk" FOREIGN KEY ("candidate_a_id") REFERENCES "public"."ats_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_pairwise_comparisons" ADD CONSTRAINT "ats_pairwise_comparisons_candidate_b_id_ats_candidates_id_fk" FOREIGN KEY ("candidate_b_id") REFERENCES "public"."ats_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_submissions" ADD CONSTRAINT "ats_submissions_candidate_id_ats_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."ats_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_submissions" ADD CONSTRAINT "ats_submissions_job_id_ats_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ats_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_log_entries" ADD CONSTRAINT "action_log_entries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_log_entries" ADD CONSTRAINT "action_log_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_history" ADD CONSTRAINT "command_panel_history_command_panel_id_command_panels_id_fk" FOREIGN KEY ("command_panel_id") REFERENCES "public"."command_panels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_history" ADD CONSTRAINT "command_panel_history_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_history" ADD CONSTRAINT "command_panel_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_key_calls" ADD CONSTRAINT "command_panel_key_calls_command_panel_id_command_panels_id_fk" FOREIGN KEY ("command_panel_id") REFERENCES "public"."command_panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_key_calls" ADD CONSTRAINT "command_panel_key_calls_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_key_calls" ADD CONSTRAINT "command_panel_key_calls_raw_communication_record_id_raw_communication_records_id_fk" FOREIGN KEY ("raw_communication_record_id") REFERENCES "public"."raw_communication_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_key_calls" ADD CONSTRAINT "command_panel_key_calls_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_rer_recordings" ADD CONSTRAINT "command_panel_rer_recordings_command_panel_id_command_panels_id_fk" FOREIGN KEY ("command_panel_id") REFERENCES "public"."command_panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_rer_recordings" ADD CONSTRAINT "command_panel_rer_recordings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_rer_recordings" ADD CONSTRAINT "command_panel_rer_recordings_raw_communication_record_id_raw_communication_records_id_fk" FOREIGN KEY ("raw_communication_record_id") REFERENCES "public"."raw_communication_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_rer_recordings" ADD CONSTRAINT "command_panel_rer_recordings_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_versions" ADD CONSTRAINT "command_panel_versions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panel_versions" ADD CONSTRAINT "command_panel_versions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panels" ADD CONSTRAINT "command_panels_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panels" ADD CONSTRAINT "command_panels_account_owner_id_users_id_fk" FOREIGN KEY ("account_owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panels" ADD CONSTRAINT "command_panels_last_reviewed_by_users_id_fk" FOREIGN KEY ("last_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_panels" ADD CONSTRAINT "command_panels_last_updated_by_users_id_fk" FOREIGN KEY ("last_updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_feed_entries" ADD CONSTRAINT "intelligence_feed_entries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_feed_entries" ADD CONSTRAINT "intelligence_feed_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_semrush_integrations" ADD CONSTRAINT "client_semrush_integrations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heatmap_competitor_snapshots" ADD CONSTRAINT "heatmap_competitor_snapshots_snapshot_id_heatmap_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."heatmap_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heatmap_competitor_snapshots" ADD CONSTRAINT "heatmap_competitor_snapshots_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heatmap_metrics" ADD CONSTRAINT "heatmap_metrics_snapshot_id_heatmap_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."heatmap_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heatmap_points" ADD CONSTRAINT "heatmap_points_snapshot_id_heatmap_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."heatmap_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heatmap_snapshots" ADD CONSTRAINT "heatmap_snapshots_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semrush_location_campaigns" ADD CONSTRAINT "semrush_location_campaigns_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semrush_location_campaigns" ADD CONSTRAINT "semrush_location_campaigns_location_id_client_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."client_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_raw_communication_record_id_raw_communication_records_id_fk" FOREIGN KEY ("raw_communication_record_id") REFERENCES "public"."raw_communication_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_conversation_summaries" ADD CONSTRAINT "client_conversation_summaries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "front_sync_emails" ADD CONSTRAINT "front_sync_emails_matched_client_id_clients_id_fk" FOREIGN KEY ("matched_client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "front_sync_emails" ADD CONSTRAINT "front_sync_emails_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_communication_records" ADD CONSTRAINT "raw_communication_records_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_communication_records" ADD CONSTRAINT "raw_communication_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_channel_mappings" ADD CONSTRAINT "slack_channel_mappings_mapped_client_id_clients_id_fk" FOREIGN KEY ("mapped_client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_sync_history" ADD CONSTRAINT "slack_sync_history_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_feedback" ADD CONSTRAINT "agent_feedback_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_feedback" ADD CONSTRAINT "agent_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_base" ADD CONSTRAINT "agent_knowledge_base_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_match_decisions" ADD CONSTRAINT "agent_match_decisions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_agent_chats" ADD CONSTRAINT "client_agent_chats_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_agent_memory" ADD CONSTRAINT "client_agent_memory_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_communication_insights" ADD CONSTRAINT "client_communication_insights_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_communication_insights" ADD CONSTRAINT "client_communication_insights_raw_communication_record_id_raw_communication_records_id_fk" FOREIGN KEY ("raw_communication_record_id") REFERENCES "public"."raw_communication_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_daily_judgments" ADD CONSTRAINT "client_daily_judgments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_open_asks" ADD CONSTRAINT "client_open_asks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_open_asks" ADD CONSTRAINT "client_open_asks_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_relationship_signals" ADD CONSTRAINT "client_relationship_signals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_relationship_signals" ADD CONSTRAINT "client_relationship_signals_judgment_id_client_daily_judgments_id_fk" FOREIGN KEY ("judgment_id") REFERENCES "public"."client_daily_judgments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pandadoc_documents" ADD CONSTRAINT "pandadoc_documents_linked_client_id_clients_id_fk" FOREIGN KEY ("linked_client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "client_contacts_client_id_idx" ON "client_contacts" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_locations_client_id_idx" ON "client_locations" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "clients_owner_id_idx" ON "clients" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "notifications_user_id_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reports_client_id_idx" ON "reports" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ats_submissions_candidate_id_idx" ON "ats_submissions" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "action_log_client_id_idx" ON "action_log_entries" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "action_log_created_by_idx" ON "action_log_entries" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "command_panel_history_panel_idx" ON "command_panel_history" USING btree ("command_panel_id");--> statement-breakpoint
CREATE INDEX "command_panel_history_client_idx" ON "command_panel_history" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "key_calls_client_id_idx" ON "command_panel_key_calls" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "key_calls_unique_type_idx" ON "command_panel_key_calls" USING btree ("command_panel_id","call_type");--> statement-breakpoint
CREATE INDEX "rer_recordings_client_id_idx" ON "command_panel_rer_recordings" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "rer_recordings_month_idx" ON "command_panel_rer_recordings" USING btree ("client_id","reporting_month");--> statement-breakpoint
CREATE INDEX "command_panel_versions_client_id_idx" ON "command_panel_versions" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "command_panel_versions_changed_by_idx" ON "command_panel_versions" USING btree ("changed_by");--> statement-breakpoint
CREATE INDEX "command_panels_client_id_idx" ON "command_panels" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "intelligence_feed_client_id_idx" ON "intelligence_feed_entries" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "intelligence_feed_created_by_idx" ON "intelligence_feed_entries" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "client_semrush_integrations_client_id_idx" ON "client_semrush_integrations" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "heatmap_competitor_snapshots_snapshot_id_idx" ON "heatmap_competitor_snapshots" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "heatmap_competitor_snapshots_client_id_idx" ON "heatmap_competitor_snapshots" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "heatmap_competitor_snapshots_campaign_keyword_idx" ON "heatmap_competitor_snapshots" USING btree ("campaign_id","keyword");--> statement-breakpoint
CREATE INDEX "heatmap_metrics_snapshot_id_idx" ON "heatmap_metrics" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "heatmap_overrides_location_id_idx" ON "heatmap_overrides" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "heatmap_points_snapshot_id_idx" ON "heatmap_points" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "heatmap_snapshots_location_id_idx" ON "heatmap_snapshots" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "heatmap_snapshots_report_date_idx" ON "heatmap_snapshots" USING btree ("report_date");--> statement-breakpoint
CREATE INDEX "heatmap_snapshots_campaign_id_idx" ON "heatmap_snapshots" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "heatmap_snapshots_client_id_idx" ON "heatmap_snapshots" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "semrush_loc_campaigns_client_id_idx" ON "semrush_location_campaigns" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "semrush_loc_campaigns_location_id_idx" ON "semrush_location_campaigns" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "semrush_loc_campaigns_unique_idx" ON "semrush_location_campaigns" USING btree ("client_id","location_id","semrush_campaign_id");--> statement-breakpoint
CREATE INDEX "ai_suggestions_client_id_idx" ON "ai_suggestions" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ai_suggestions_raw_comm_id_idx" ON "ai_suggestions" USING btree ("raw_communication_record_id");--> statement-breakpoint
CREATE INDEX "ai_suggestions_status_idx" ON "ai_suggestions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "client_conv_summary_client_id_idx" ON "client_conversation_summaries" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "front_sync_match_status_idx" ON "front_sync_emails" USING btree ("match_status");--> statement-breakpoint
CREATE INDEX "front_sync_matched_client_idx" ON "front_sync_emails" USING btree ("matched_client_id");--> statement-breakpoint
CREATE INDEX "front_sync_conversation_id_idx" ON "front_sync_emails" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "raw_comm_client_id_idx" ON "raw_communication_records" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "raw_comm_source_type_idx" ON "raw_communication_records" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "raw_comm_timestamp_idx" ON "raw_communication_records" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "raw_comm_review_status_idx" ON "raw_communication_records" USING btree ("review_status");--> statement-breakpoint
CREATE INDEX "raw_comm_match_status_idx" ON "raw_communication_records" USING btree ("match_status");--> statement-breakpoint
CREATE INDEX "slack_channel_mappings_channel_id_idx" ON "slack_channel_mappings" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "slack_channel_mappings_client_id_idx" ON "slack_channel_mappings" USING btree ("mapped_client_id");--> statement-breakpoint
CREATE INDEX "agent_feedback_agent_type_idx" ON "agent_feedback" USING btree ("agent_type");--> statement-breakpoint
CREATE INDEX "agent_feedback_target_idx" ON "agent_feedback" USING btree ("target_record_id");--> statement-breakpoint
CREATE INDEX "agent_feedback_client_id_idx" ON "agent_feedback" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "agent_feedback_type_idx" ON "agent_feedback" USING btree ("feedback_type");--> statement-breakpoint
CREATE INDEX "agent_kb_client_id_idx" ON "agent_knowledge_base" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "agent_kb_category_idx" ON "agent_knowledge_base" USING btree ("fact_category");--> statement-breakpoint
CREATE INDEX "agent_kb_client_category_idx" ON "agent_knowledge_base" USING btree ("client_id","fact_category");--> statement-breakpoint
CREATE INDEX "agent_kb_source_agent_idx" ON "agent_knowledge_base" USING btree ("source_agent");--> statement-breakpoint
CREATE INDEX "agent_kb_active_idx" ON "agent_knowledge_base" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "agent_match_decisions_comm_id_idx" ON "agent_match_decisions" USING btree ("communication_id");--> statement-breakpoint
CREATE INDEX "agent_match_decisions_client_id_idx" ON "agent_match_decisions" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "agent_match_decisions_status_idx" ON "agent_match_decisions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "client_agent_chats_client_id_idx" ON "client_agent_chats" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_agent_memory_client_id_idx" ON "client_agent_memory" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_agent_memory_type_idx" ON "client_agent_memory" USING btree ("identifier_type");--> statement-breakpoint
CREATE INDEX "client_agent_memory_value_idx" ON "client_agent_memory" USING btree ("identifier_value");--> statement-breakpoint
CREATE INDEX "client_comm_insights_client_id_idx" ON "client_communication_insights" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_comm_insights_comm_id_idx" ON "client_communication_insights" USING btree ("raw_communication_record_id");--> statement-breakpoint
CREATE INDEX "client_daily_judgments_client_id_idx" ON "client_daily_judgments" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_daily_judgments_date_idx" ON "client_daily_judgments" USING btree ("judgment_date");--> statement-breakpoint
CREATE INDEX "client_daily_judgments_status_idx" ON "client_daily_judgments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "client_daily_judgments_client_date_idx" ON "client_daily_judgments" USING btree ("client_id","judgment_date");--> statement-breakpoint
CREATE INDEX "client_open_asks_client_id_idx" ON "client_open_asks" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_open_asks_status_idx" ON "client_open_asks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "client_open_asks_client_status_idx" ON "client_open_asks" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "client_relationship_signals_client_id_idx" ON "client_relationship_signals" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_relationship_signals_date_idx" ON "client_relationship_signals" USING btree ("signal_date");--> statement-breakpoint
CREATE INDEX "client_relationship_signals_client_date_idx" ON "client_relationship_signals" USING btree ("client_id","signal_date");--> statement-breakpoint
CREATE UNIQUE INDEX "pandadoc_documents_document_id_idx" ON "pandadoc_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "pandadoc_documents_client_id_idx" ON "pandadoc_documents" USING btree ("linked_client_id");