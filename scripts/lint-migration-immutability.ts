/**
 * lint-migration-immutability — Architecture Governor hardening, first-wave
 * guard #1 (Task #4179; §8 candidate 1 of
 * audits/architecture-governor-bootstrap-report.md; activation approved in
 * audits/architecture-governor-hardening-epic-approval.md).
 *
 * Old migration files could be silently edited, renamed, or deleted — the
 * dev ledger, the hermetic template hash, prod's post-merge SAFE re-apply
 * path, and every environment's replay history all reference them by exact
 * name+content, so silent mutation causes schema divergence or replay
 * failure. This lint freezes every migrations/*.sql file present at
 * activation into the sha-256 hash ledger below and fails when any ledger
 * entry is missing (deleted or renamed) or its content hash differs
 * (edited).
 *
 * Rules:
 *   1. Every FROZEN_MIGRATION_HASHES entry must exist on disk with exactly
 *      the recorded sha-256. Missing = deleted/renamed; mismatch = edited.
 *      Both fail. History is append-only — fix forward with a NEW
 *      timestamp-prefixed migration, never by rewriting an old one.
 *   2. Files NOT in the ledger are new migrations: allowed (append-only by
 *      design — adding a migration must not edit this shared file, the
 *      same no-shared-file-edit property lint-migration-prefixes has), but
 *      scanned for destructive/incompatible SQL (rule 3).
 *   3. Destructive/incompatible SQL in a NEW migration (DROP TABLE,
 *      DROP COLUMN, SET NOT NULL, ALTER COLUMN … TYPE rewrites, TRUNCATE)
 *      requires an explicit in-file owner-approval marker line:
 *          -- destructive-approved: <who/why + rewrite/lock strategy>
 *      per the epic's open-decision record ("case-by-case with owner
 *      approval for destructive schema changes"). The marker is an
 *      advisory approval flag: it forces the approval + strategy note into
 *      the reviewed diff. Heuristics supplement, never replace, replay
 *      testing (tests/migration-replay.test.ts is the replay seam).
 *
 * What this is NOT:
 *   - Not tamper-proof: a repository-local ledger is deterrence/evidence
 *     (the ledger serialization is content-hash-pinned by
 *     tests/lint-migration-immutability.test.ts, so widening what passes
 *     requires editing BOTH files in one reviewed diff).
 *   - Not a regenerable baseline: there is deliberately no update/refresh
 *     style flag and no write path. Normal agent work may not
 *     regenerate the ledger; a deliberate owner-approved re-freeze edits
 *     the ledger and the test's pinned hash together.
 *   - Deleting a migration file is NEVER a routine pass path. If the owner
 *     genuinely retires a file, the reviewed diff removes its ledger entry
 *     too (and the pinned hash), leaving an audit trail.
 *
 * Clean-schema replay note (evidence, 2026-08-09): the migration files are
 * NOT a self-contained genesis path — e.g. 0033 ALTERs
 * `semrush_location_sync_state`, a push-only table (re-verified in this
 * task on a disposable Postgres: clean replay fails exactly there; also
 * documented in tests/hermetic/bootstrap-db.ts). Genesis is push-first;
 * therefore the replay seam verifies NEW (non-frozen) migrations against
 * the current post-push schema — the exact semantics of the dev pending
 * apply and prod SAFE re-apply paths — not a from-empty replay of history.
 *
 * Escape hatch (emergency only, documented in the same change):
 *   LINT_MIGRATION_IMMUTABILITY_SKIP=1 skips entirely.
 * Report-only seam (used during the pre-activation false-positive review):
 *   LINT_MIGRATION_IMMUTABILITY_REPORT_ONLY=1 prints violations, exits 0.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const MIGRATIONS_DIR = "migrations";

/**
 * The frozen ledger: sha-256 of every migrations/*.sql file at activation
 * (2026-08-09, 190 files), extended by owner-approved re-freezes
 * (re-freeze #1: 2026-08-10, +2 files, 192 total — Task #4190). Write-once
 * between re-freezes — new migrations are NOT added here (rule 2 above);
 * only a deliberate owner-approved re-freeze may edit it, together with the
 * pinned hash + count in tests/lint-migration-immutability.test.ts. The
 * re-freeze procedure is documented in
 * audits/migration-immutability-activation-report.md ("Scheduled re-freeze
 * procedure").
 */
export const FROZEN_MIGRATION_HASHES: ReadonlyMap<string, string> = new Map<string, string>([
  ["0000_concerned_reptil.sql", "ecfa9f280cd9431be9ad26635d3e4127e84f50be634ef0c8b8bda23227ca05e9"],
  ["0001_faulty_moira_mactaggert.sql", "ded15b3ae02a546d93d4c86b153efd145fd0f46f78be721ca859aa85a121669e"],
  ["0002_green_power_man.sql", "68116757b4574bf3b065bc816b8114048b4dfe613f2d9b5357b485ff8b9be134"],
  ["0003_add_webhook_reimport_fields.sql", "56a441d9567f0c5fc699179c0c17376cadd0e1f9f8722566742f62826aa04b03"],
  ["0003_yielding_ben_parker.sql", "ea010c6cac63f10f7160c7fc26e4f188fbfeddc4b8c70c3b9587db033b7767a3"],
  ["0004_known_norrin_radd.sql", "0be76c0a7d94be61a32c964f4d702de05f6ca8128b07fad977b939f87be03bee"],
  ["0005_round_iron_fist.sql", "104df67a0bba49cc68799d164c5263e720da0cfabe1a8aa034403daa8dfaefa2"],
  ["0006_add_conversation_group_fields.sql", "cebf148b02b464e37b6d476bb750315605217c72309e413e5e7410e708b1a63c"],
  ["0007_add_communication_client_links.sql", "0b1d2f32bad98dbf3087ed3c90f549bed997c746ae5980340246bf917e330d21"],
  ["0007_add_user_activity_logs.sql", "7c4f8d67018b3336044de1d10bc8ec7fff0bcf8c1ec18f60b1372d54e3265b1b"],
  ["0008_add_user_timezone.sql", "22a94f9986fae1ee7b3cfdd039c0d27de5c54b92da4a664fd37cfc25ee280a45"],
  ["0009_add_is_touchpoint.sql", "e554169357be5693098ad2b839ed9273e202640d4c634767520d185304b004ae"],
  ["0010_add_sync_progress.sql", "e9d7c47a715e08480e2e8793477ba12177575ae05b2f842aaa41dcf2c797ce8f"],
  ["0011_add_work_queue.sql", "b0223507753aa0bdfcb341d40266d038832de536aea894fd43a4c6443cbc1ecc"],
  ["0012_consolidate_work_queue_class.sql", "9798123b50f4f72ba03eb2dace29db7ec8e781631f4ddeadef6f7f85c2f67978"],
  ["0013_add_durable_pipeline.sql", "3f43e31c64e8d78392bbe880ae894100871e6549fc3ce2d96f8735d683963f13"],
  ["0014_backfill_command_panel_product_types.sql", "27d76a10b071b374c78e6d6fd47d5fa515892b70e0a6aaed7b1bf55c578f72a2"],
  ["0015_add_blocked_ips.sql", "6e9e39ebeca9cdcc5200c4c43ae921fb4ae3d27e7fc39836aa6b23b6c96c27d7"],
  ["0016_add_match_settings.sql", "44c124b0f106d3fddd640d4a8ce06807ce8ba321f1c84b5e23358107cf238495"],
  ["0016_add_zoom_review_queue_columns.sql", "3cd4a8d0cc398ba4f55d3bff5359fcbca8c0d969e7dc6b56ba2050533d02f73c"],
  ["0017_add_stale_lease_threshold_audit.sql", "2897106e6bc5800148ba1e58748a77e1ca0e0e521e3187dea6f6ca4b4c43198f"],
  ["0018_add_admin_setting_audit.sql", "f7a46317c1941d51ab6041237a4bb1d8cd838c242cdd0f494ed4d28c53667f28"],
  ["0019_add_queue_timing_audit.sql", "e7fb2ffad2b902ca806613f2a8f16381f7c36d900655f80b6ca12cf0662080e5"],
  ["0020_add_dismiss_reason_columns.sql", "0a9b19e23c373da9e0e9947096cb32fe83256926dfd8a50cc91c0e959d82b5f9"],
  ["0021_add_blocked_rate_limit_events.sql", "d5d1b6a607c786fad0d837b8be7df08f916e9af197e30bc443000c4adfc376f8"],
  ["0021_add_match_setting_alert_status.sql", "e8a19fee2ab766ad6808ef117270933ccdb9398208749adffe45a8708b256af3"],
  ["0022_add_zoom_review_reopen_audit.sql", "039414dac288e66f0228702e675cfa7b3155f66e922d3089ea28741c2ea978c4"],
  ["0023_backfill_legacy_explanation_summary_prefix.sql", "7a2e0bbd5a3fc7209fbe34f8cc2606621bb3922c4157f47bad38f393fd3425fc"],
  ["0024_add_rer_recordings_unique_constraint.sql", "65fb5efe6f11a7d1442a56d7e042236d0a641b4d3f218b07846389a44444ab4c"],
  ["0025_add_key_calls_unique_constraint.sql", "f09415cb24418cc2bfb1e9f96ec0d43c922de9c53d8726a14845e88d7a0f385d"],
  ["0026_add_match_setting_alert_failure_reason.sql", "ba9c5aa460fc7ea22f2faa2cc4004d23ac17263ab4bfe1548a2219e194a1e56f"],
  ["0027_add_admin_setting_audit_alert_status.sql", "582db6334061a8bc0ebadf15bf8263af331d2a68de78db48415b447987ed7993"],
  ["0027_add_comparative_metrics_snapshots.sql", "175c69bb2d59e8c92c3b2798a9302b942619872259e0d0f9e193d2c4d194820d"],
  ["0028_add_semrush_sync_outcome.sql", "b34d94b48a5d2379bf776875e6ba0980309fc755ce94730d73d952afd1647ead"],
  ["0029_add_import_entity_suggestions.sql", "d15ace22de0c19cad6e4f59ebe48fe331c7ae588afda1be6245c428ffc3292b4"],
  ["0030_add_front_filter_rules.sql", "a0c780bb5fc9d5438b53a571a130537e3ec804b5c486150cf99968ae8e0d1cea"],
  ["0031_add_report_section_history.sql", "18e3c0742a7c589cd40d8aca60bda7d4b5662c331645b6724e30836743385c58"],
  ["0032_add_backfill_jobs.sql", "c80568c3edfb7661595044182aaa4eaf48832c50e0b43581f3570abcc53224a6"],
  ["0033_add_semrush_location_sync_attempts.sql", "80c70a59b95bc31bf6a65c1261ae7463fb8218f130e5b75e611a5c63cd6e1016"],
  ["0034_add_booking_tables.sql", "91697e094b4cb609fb85dc16c3ddd6a39f3c75023c8e095e3a9016a260fa8153"],
  ["0035_add_booking_pages_account_manager_unique.sql", "1b945b9c49ca1e92035e046a0c5b054e339b386db5cd51b68818bb7413dc98df"],
  ["0036_add_scheduled_meetings_no_overlap.sql", "ab519ab1f9d37cbe2125c54b4e0a6ced551766c66db26189b8252f50ef20f2e3"],
  ["0037_conversation_hub_perf.sql", "9279953c2a8948ba8b145c8906f448ae3ee1aac5d47f9833595f0c4622d04608"],
  ["0038_add_twilio_message_status_fields.sql", "6cd71fe10e4786873c527b6654e9b5f9631f76e893a4843787c0f8a21b51643f"],
  ["0038_add_user_call_mode.sql", "ea4b35b016a51aa707d9d209b0c59ab2d6f80c514521beb61b708fc1d300b681"],
  ["0039_add_twilio_message_updated_at.sql", "f7cbf706fa7081a9ee22806de49441fb5970ceb0d9435f8a2a4393f89279e770"],
  ["0040_add_twilio_call_recording_fields.sql", "4aa93677212ae07fc8f9d41ad1f383604337186d3a0dafbea53bdb689ae47582"],
  ["0041_add_call_archive_pipeline.sql", "26d0510e5e6f5b6cdb617116be0b250f672bfa83958e59548fdaeec47676427c"],
  ["0042_add_ceo_pulse_include_graphs.sql", "0be8b3bd1f3e863323ffb69bf73ffbf0b564e1e7cd4b21f9ae471fffc3cefb20"],
  ["0043_add_user_zoom_host_override.sql", "3e88f52679a83a10476eca6a7a5a1e69e8235661514571304b08994d95a29330"],
  ["0044_add_booking_meeting_types.sql", "92ce1de1ab9a8ac240d98fc4faf4167204a2e345cf525fef1d99b469e1911805"],
  ["0045_add_client_contacts_audit.sql", "b33ab5d9b46d7ba4299c96db74614e36d632aaa92900900ac45fe4b757c27b7a"],
  ["0046_zoom_review_nullable_client_id.sql", "56b4bf428a17c88f133f6a89008b5c7240168fb56eee1410f86638a32c52c215"],
  ["0047_add_notification_registry.sql", "c7fc0a2d15261e90f861ce1eade4d247197eb0a797b8ca78a9fa36d6970cce83"],
  ["0048_add_client_locations_audit.sql", "e94116cacc5e347f5839d4a749b22b32cfab713501481fe5f4dc6e94d2f1a298"],
  ["0049_backfill_empty_report_sections.sql", "a87a05bb09853a7816607bb20c7470ff34e72f2c2499e2e011c256ffa00d32a7"],
  ["0050_add_user_display_timezone_source.sql", "1f3184c5061771ca0cecb5b4183531c9c9c968ee805e9ac8f1d5d2fe9e31d876"],
  ["0051_add_call_analysis_slow_lane.sql", "35cc6b0bbae630b09ffec0dc09d80ee984824ae492630b065dae6880fa4e0bdb"],
  ["0051_add_front_sync_pipeline_state.sql", "f9f9b5a95f353e7106e006fd167ed07472f53c6176fac24a67c5031767b821be"],
  ["0052_add_meeting_recurrence.sql", "f53c5598c59a74be03cfdefe0e290d4c4458708b357a2d51815eabd08fb10565"],
  ["0053_add_booking_pages_allow_recurring.sql", "f8a0533ed3419ffbe42e155c14c535c4bdd90c0566b538f8beaabb70bcad78f3"],
  ["0054_seed_recurring_meeting_feature_flags.sql", "44f0d9e17d6afc3ea7ec0578dd5206b898cc3568dc06d250ef5dd0d04833f5dc"],
  ["0055_add_thread_notes_and_assignments.sql", "177ab79c2196ea2a40b031d986166310d818ace636b53e1d259ed8725e727497"],
  ["0055_add_twilio_voicemail_fields.sql", "69734a947f185fb7eccadd56475739be0a4322dd383806eda4936ecd4c01c502"],
  ["0056_add_communication_orphan_events.sql", "40c50776e46b204e0a5b865db06eee0e6084d27d9808818f7bf1ec34c01836cb"],
  ["0056_add_twilio_message_messaging_service_sid.sql", "6ad388e5e7be63277a8d03d9b9e076417e2a52d11bceee2d593bb72dec966289"],
  ["0057_add_call_archive_requeue_audit.sql", "7cc62d746b620f1ae6904ec38532320828fab77b1bd2563e2fb731dc4befd1d9"],
  ["0058_add_call_archive_health_snapshots.sql", "c6550833a588645d650a2c8fa1ed3a8d442c74cbad45be18dc559ac23ddb58f3"],
  ["0058_add_call_archive_leased_at.sql", "dbfc29313d8c4cf119573fc2d5f30955abea61e8a4a03f336cdd2ae24273e53c"],
  ["0059_add_rate_limit_notification_prune_history.sql", "5dd1bbb322f2e28aaa6c1c6ef17fbf4d5099f0d25dcd8c955c1ce868d6a412d7"],
  ["0059_add_semrush_campaign_metadata_cache.sql", "2694566ef67e75688b3e5d860b423ebf8df571516a247e2e435a3b25d3cd0709"],
  ["0060_add_notifications_metadata.sql", "11109a8ea7ed1ab25a93e9095b9aacd0f78f6253968a7cf9b1131c0ac899e7f8"],
  ["0061_heatmap_keyword_canonical_check.sql", "3efc59652361edcce4fe05fe441b900050c2f49f1e506e91870c0b1a7f350c47"],
  ["0062_add_front_filter_rule_hits.sql", "dc55d987c9875cbf1e76117512d5e7d2b39813b598b13e90667477485734050d"],
  ["0063_add_thread_assignment_notifications.sql", "4da0eb1cd6bc9058900dd6ac7e8d956a4852f166302f015b4ecc0529e69c4790"],
  ["0064_add_perf_indexes.sql", "c4667f0b2cdd2d14763f4aa46076f07fe42e6a12da9a032e7dc8edcb56597afd"],
  ["0065_add_front_analytics_monthly_coverage.sql", "489da0d8c5aa40139edceec02d632c8ea8f53d5f62728d71c4e2ed7baa24c9db"],
  ["0066_add_front_analytics_unrecoverable.sql", "797279be52ed1ec9a53348d1879226cc713b5922bea08fbeb26e5ebaaaaf8adc"],
  ["0067_add_front_analytics_search_fallback.sql", "b37fc7e0ff375b40aeb764932abb85312dd060882a4533724ad01d6f0f8c556e"],
  ["0067_add_thread_read_states.sql", "7ccb7f04cbdc51c9f8dbe5e6b337e023ad25d1765f2e35907cb9727f195dfd89"],
  ["0067_add_user_notifications.sql", "d79b64538dafc8ad70ef7c910cd94df9001160dc3ed3b5776ed777dc2b213c08"],
  ["0068_add_user_slack_preferences.sql", "6a697115d74a2e1bc858693fbe94bd5458b2cac9a0f7c1a738625575bd491f24"],
  ["0069_drop_legacy_notifications.sql", "0e6e3d71e941cb726c153c6f7ca7b630490c3295188ce3bfa695ebe851a43741"],
  ["0069_drop_legacy_notifications_table.sql", "72d189e4f9589c9a8169c70b15dc6453d6ac04a87fa2f4b71b26045349c174ca"],
  ["0070_pool_epic_phase15_audits.sql", "078a1f8cd16783737044994cd779d18035eb298167fa155337c5ec2b7572930f"],
  ["0071_add_google_ads_tables.sql", "91d42943a7044f85f43bd2a77decc1eaf558a3db5673bed5c9cbbd45bff2807c"],
  ["0071_add_user_functions_and_authority.sql", "8d60d8bde57b2d2ca68c681ceda6916fc9531ae82c4dfdb75aed8928d3775dc4"],
  ["0072_google_ads_budget_and_dollars.sql", "ae53897670789ddd7c57d44554bac5db2d7bcca7ea57c379f10f53494522467d"],
  ["0073_semrush_demand_driven_cadence.sql", "40715c63918d4a520da7bd8af1ae0b26ca1c56cfb41b44ddf1a61d3d2e9f3c2d"],
  ["0074_add_prod_action_runs.sql", "07fcef2ae5cd1c6919b9180e9469ba1c4802a563a072d0a16e18ead2a5fcfc93"],
  ["0075_add_semrush_enrichment_cache.sql", "a2b55d4be8987c31e0b15f4e43bf063e1314e70640486b2b06e1814463d8f390"],
  ["0076_add_front_analytics_unit_columns.sql", "4bf5eb096c6272c9df9f7731e50b040d60e084ad79bca27870e4f85b31c2d70a"],
  ["0077_add_front_operational_rules.sql", "9a05de68176c698baa4e6c56de4b679f3d27db66811d0c60efca0c9abfde5e42"],
  ["0077_add_users_deleted_at.sql", "5a1f348494502cacbbdb9675bf6149289dfc50995346ceaf0fbb5accc2f03fe8"],
  ["0078_add_dedupe_drop_verdict_rollups.sql", "1c51383d0cd5e2ef88ce0664a43d9fd66f23c0b6ddd9c182f865caa902e3241b"],
  ["0079_add_front_rule_hits_prev_reason.sql", "ec7bfc3a130404264547e2daf348c5b28a60fe902bf2f48d4a769d7b0ced5f58"],
  ["0080_add_front_analytics_closed_via.sql", "a16917e17cab31d61340681428d1a9b6c8caf978fcd050f654412068b72b13da"],
  ["0081_add_front_analytics_per_direction.sql", "eb0d19238f31182f45773c68ae7f7a859f5b828eeb0c5a3216ddb4d465be1a6a"],
  ["0082_semrush_enrichment_cache_complete_flag.sql", "e62f1e26205748650d062240bd172f868daf032220fa962a0e32b24de6b02a0b"],
  ["0083_add_front_operational_rule_deletions.sql", "7a071968c26530d97853fc98fb1fe4269fa2e2916f9a935b0ea24da6b7ea5a92"],
  ["0084_add_competitor_structured_location.sql", "3fed7855a7e717f72646bf1c6dcff8d53fe1889ee846ec031ab4d829cff1e0cc"],
  ["0085_readd_user_notifications_dedupe_unique_index.sql", "374f15e1462878daa0300ade1beec270dc58d55683ff28b08b5fd4a5fca9b792"],
  ["0086_add_competitor_gbp_backfill_attempted_at.sql", "35f8839506cc10ec1454dbf65e2d62e061f151abc38dee7855f23f50e0853182"],
  ["0087_add_competitor_structured_location_backfill_attempted_at.sql", "0e50386f6170a2162334040bd106037913f9a80bf85a236ad038eaaeb7f608ed"],
  ["0088_add_ris_qa_layer.sql", "50cb9614171512e93e91b0e9bb8106e1e53e0ad4606d1ceb87e47ea77f521bfd"],
  ["0089_add_competitor_locality_relabel_attempted_at.sql", "f9cdb21a8bd0408df595e196d7752b98fd9a3da1d4e39dde48294b72293b288c"],
  ["0090_add_ris_bigquery_autopull.sql", "e8ab13b96e8d4e31fe0d678175c6790f138eb2a5e3031471e6f2b870c505d59b"],
  ["0091_add_ris_performance_layer.sql", "1af8d4ff1d96b9e25de8fbadb9fc11813bda2159044eaa7f4387b2ce3cd52a6e"],
  ["0092_add_feedback_video_analysis.sql", "209f01c45e0dc83ed718dc81c83708a72ebccd49ad3ac57ef689d253d2948881"],
  ["0093_add_competitor_backfill_retry_counts.sql", "6d0ea9181549ad0795e6bf189e72e56aacdc6ce9d2c5c368f30651db17f3806d"],
  ["0094_add_front_coverage_convergence_attempts.sql", "61df9dc970eec50f72c9a140e174af301e5d3b3f808df09f3fe166ad059e4ceb"],
  ["0095_add_ris_client_auto_source_overrides.sql", "bbd61f9377a367f48ec8fc191cfc0c02ffe58762ddc30a8db8ec13e7d63d52d0"],
  ["0096_add_client_monthly_review_target.sql", "90d944f2adfa63f76e4a8f24e7e6e35a715722903072da11ba51ffbac75afb45"],
  ["0097_add_reports_source_pdf_storage_key.sql", "c3dc39a9f8bb46eb9ed5e2aa33f72a10d5bc3d1253aaf2c6fb13b9301ff2a2f2"],
  ["0098_add_client_hide_other_leads.sql", "0781852851e88a6e85606f873abc2c54ffdc131b54b78bbb78492b61aac8660c"],
  ["0099_add_live_data_snapshots.sql", "11418dd15d55df3e5868cf6148505ac76168ede0d3952d2121f1f055a0022af3"],
  ["0100_add_app_backup_runs.sql", "9b1da68e1f54c5b9c24887b23e3168d3a633aa63e1a06ad62f76e2c7354752e6"],
  ["0101_add_front_coverage_deep_search_exhausted.sql", "351a2f8d2b7a161b165d51cf1c3256ad9c75b7a9b60269f7a027054104c92eb8"],
  ["0102_add_front_coverage_denominator_floor.sql", "b1263db57bbf247898989a38558752cd64786953f94fb3c3844e90bb1e9201a5"],
  ["0103_add_google_ads_audit.sql", "425947e4d368c7e0660809be0e54d0507a558fc3ab35f560cc5bcfb868509d52"],
  ["0104_rename_ris_checks_key_unique.sql", "81a7c07f804a6b49e6e1c7fddddb10ba0f53eb2db86d79825f380c5cf676aa7d"],
  ["0105_add_sheets_tables.sql", "cae19300b503f33b0791175eef62d9e88cbd16c741a72318a94c18331fda57e4"],
  ["0106_add_sheet_workbook_locks.sql", "56972bb65026271b2e78a87830ed5d41290009c1fa4a97bb6abdfc3be17ed576"],
  ["0107_add_clickup_filter_presets.sql", "d2aa3fd107adfbaaaa5fc478ded1beeb8fbd24ba21ee85806143e243193a1268"],
  ["0107_add_nobull_comms.sql", "dac6f8932039c9e2baa2ba9fc5011d354f808d62b3ea98306fd4725bac05f8a7"],
  ["0108_add_google_ads_os.sql", "8fb8733e723d1424a2194a1a839d4c88a6f054659689f35fcd9dc3db88408fa6"],
  ["0109_add_clickup_workspace_plan.sql", "76445bbd5540ec0a156e5e2140e67e0a134b080cda3e30f948cdf82b42aec2ee"],
  ["0109_add_sheet_templates.sql", "865b1481e55b8d1d91385f44d5948b9783bac98a7bb515bc6be111bcf4f0333f"],
  ["0110_add_sheets_role_grants.sql", "cfc0b56826cd986c4df869f2aad6048d15fb1ec9b80cb4ff27d6c413ca7312db"],
  ["0111_add_sheet_workbook_versions.sql", "3c8553a98f9a12b27730bd5e405c287d956ece17bbb748a685aaf87595806588"],
  ["0112_add_service_desk_foundation.sql", "8afda155b9ab10c96fcf94d5d80fedbbefc9efb07adac68fe510ed1902e0411b"],
  ["0112_add_sheet_workbook_activity.sql", "594aee2106e9aab65ed3d04fe6f6f0d126efe718e2991c6550922302d521039a"],
  ["0113_add_sd_ticket_events.sql", "89a71f8723ed8a5aba0692546abe85546cd3befea6667b0848361ec18eb44a29"],
  ["0114_add_clickup_mirror_tables.sql", "1b668f97747a967335645cb12c3e193417d25fcafd8f457589fef28eab951e07"],
  ["0115_comms_unique_active_client_channel.sql", "98ed663aaaa790168477afeef6232433406def94e0a33441ce66d6625e0aec70"],
  ["0116_comms_calls_call_type.sql", "81896db66b80008ba2ab967949f92d9bdd08322401b22ae7a721e8ae25298755"],
  ["0117_add_sheet_workbook_dashboards.sql", "36ef29c753dbff240c3c58ab53006fcf0100f29f335b1f0699d181c94bee506c"],
  ["0118_comms_calls_recording.sql", "23865b8843546e46915d616b23922a85af8171a4e5a054fe6a80f7193667c09d"],
  ["0119_comms_daily_driver.sql", "8801314ab454a1cb7420410a05a82f8e15c100089287ddd2dd61ba036772c28b"],
  ["0120_comms_user_status.sql", "1886e58f2bc2013d85f027929b657f7008e7ba6c9f4fb7c3902e054549acd565"],
  ["0121_comms_webhooks.sql", "b15d76a89a4f902c5eebb7de0a7a4b6176af034c2595fff5c6326a25850dd984"],
  ["0122_comms_bookmarks.sql", "2e183356f31dd172f3e86b494691eace906f348c1ebebe0a52977061900d0e14"],
  ["0122_comms_drafts_scheduled.sql", "08f11513fad4d9477e5a26ccb844db63e0480b6f13c4771a2ce9ea2001b55135"],
  ["0122_comms_sidebar_categories.sql", "35e7dabc7e51b92842aa352a31e99b05134d1c736f2eea84449f0ce13537987e"],
  ["0123_comms_notification_settings.sql", "aecdc6952c396f601a0600d75c51f49bc2bd5128a3fc761608937b91c14da31b"],
  ["0124_comms_thread_members.sql", "b42d9f11b256201b87f6d7df0e12e53ec83f4696ccc4a796e6f2f3fdd54f2ea3"],
  ["0125_comms_edit_history_reminders.sql", "35c48c415a0b20378579db3fdde14a47bf6426b1b96cfa19288c3b7c172ce6a7"],
  ["0126_comms_link_previews_thumbnails.sql", "e81386a5e9a162236a2650edf32de162ccc1c37ea9f1f5d8b4fe0b4c95bb8363"],
  ["0127_comms_custom_emoji.sql", "8c44337d91bfe0ac9cd154083ae2f7e836e63ae2b0b542a8c7a05f519c944921"],
  ["0128_add_sd_request_type_templates.sql", "832b5dbde5efa4bcf889aee1c74cda01a7d38201e1184541c0d35fdd7fa56648"],
  ["0130_add_sd_question_answers.sql", "159e695839e5a917b70b0cf571b3bf0954c4475ae34fa14309333a251f046fbc"],
  ["0131_sd_client_option_ids.sql", "6fb6074f59b33b9b42076acde8e502f06a61d05e553c9c9e8dacbbeb5e00448e"],
  ["0132_clickup_authorized_workspaces.sql", "555cc4c2851ecb07b2de308188402429ac726a58aea18484b8df33b60bf6bd70"],
  ["0133_sidebar_category_client_subgroup_collapsed.sql", "f2380e76427ea123116188008b3930b7d0837e2ebf4b2bef108c4e9659604832"],
  ["0134_sd_client_option_names.sql", "3d9a885140c8579e70c843dc86c73288edef45b95163767fe4457637ff4c43d9"],
  ["0135_sd_client_dept_assignments.sql", "29b65d1ca7762c488c5f8244392c4fd68164973ef13c0396fc1f473b960fd7ea"],
  ["0136_ads_os_stores.sql", "d1a3c018f50493b21ec039634be18428eba86a6186c208d28e1f094b43c5ec10"],
  ["0137_sd_role_assignments.sql", "5f5abca51403c3c165b6890308fbc0de3db21154ffa0941a4d8181624727952d"],
  ["0138_drop_legacy_google_ads_os_tables.sql", "56241460bd83c5120dc67f67b610588ea5aebad15224de1c6e67b0f9793ac015"],
  ["0139_sd_template_step_assignees_richer_questions.sql", "eb69b8618729c21d138b8f724b1d005a523089a5e25b8a5f4351832e791e629f"],
  ["0140_sd_step_assignee_department_override.sql", "dab39912fc72d34858a714973eaf239c431e9f6d87b0e714718d91f56d462cc8"],
  ["0141_client_engagement_snapshots.sql", "500c45fb2e6a518b2ba0943b0e164b988c3c4b34abf9c372e6f83e3ba25d81c8"],
  ["0144_churn_radar.sql", "4c5c1215d788d92aec6cd6a00cc85eb879ea12ecc4b694d4db8e57ab2ca3dc8c"],
  ["0145_client_offboardings.sql", "cba06703c538ee3f9e41c959117a9977dfc352034e63b86652c38c20c800ba14"],
  ["0146_add_client_save_plays.sql", "8ba2ab23c5aaa54dbc3434111079457705d31637150447fd5c5415aa47689018"],
  ["0147_client_agent_chats_created_by.sql", "35216304198852fe51c8ba50cbe7a4fbea42fa2a02abf25ea2c72533f4446f59"],
  ["0148_publish_intel_notes_directly.sql", "cb34b3edfaca7050e444324dbad044d2ec6f869eb197e47ec07078d51e73b20e"],
  ["0149_restore_raw_comm_external_source_id_unique_idx.sql", "a001e09fe6b57f11e337143641f732a70aa55ccbf49dbfe98f38c3ac9f13c77b"],
  ["0150_roadmap.sql", "25e1d529fcb9cde05ae26f737df165913551f4e3222514745f9f1cfa8a7eeb3b"],
  ["0151_website_inquiries.sql", "dab9f5a69c7e1fa0a54e0ff96c3566c3b9b907ea48c2c0fdc191762f43d6b7a4"],
  ["0155_am_coaching.sql", "079683af59d24003341fc4d388ec314f9734274d62006b99f264b8426fa3161f"],
  ["20260805025824_table_size_samples.sql", "d2f608a26244472eab83bd1388f247f4411b8606a87151b982a068f9b0b36308"],
  ["20260805125801_api_route_stats_windows.sql", "a69a20f5ee73baf16d972afbb1c625e9772e3b57a3a8782bd02c31a8b61d30ca"],
  ["20260806180000_going_quiet_data_gap.sql", "0936aea1f5dab742b6319cc6cbac8dba3080f38f13340bdeddfa1f0cf940b013"],
  ["20260806182338_call_analysis_jobs_lease.sql", "b0c8efded3c4b8ca7b98f04f8ad1594c241c80340855669d4266d91148b5e7ec"],
  ["20260806182339_twilio_calls_archive_failure_reason.sql", "2421256f315c5d500c41e8c6c72874e0f2b3be07d2a26036b9266a363f0c2c45"],
  ["20260806191859_twilio_outbound_dispatch_claims.sql", "fd3137f9fcb3ff1568a3fe637896da5dbafd5a102e724c381ae99e2cb0156e71"],
  ["20260807040000_client_semrush_integrations_error_category.sql", "1fb1476293859d0a7e952d94a573868cd15b62200bb4f9474dc34552cc27d1f6"],
  ["20260807053000_ats_transcription_callback_fields.sql", "ac79d2f0cf98eded2214732bb2f01f4849796aadb76ff5518effe2d4f10df657"],
  ["20260807095500_ads_os_status_checks.sql", "aedd237fb31342212f4a81482d7dc2eada80b2cd3eede3038bbe9fd0e5baa712"],
  ["20260807145036_sel_front_webhook_received_at_idx.sql", "e808216bba0ec9d3009ea993bb68a479d1f7ba58bd8c1c966aed396a377a4043"],
  ["20260807152551_drop_google_ads_connection.sql", "cb1fb6c55de0f0856657d113d7ed309d6b44b2d60b7fc5b02b6ea12c5de71b5e"],
  ["20260807173000_client_files.sql", "1e29f216630c52c05992e57ade31bb4b162ed79e893c1e25c06614e5a6e75325"],
  ["20260807192809_drive_import_and_client_file_delivery.sql", "9f7c8027955023a64ad025a1299525a53492649a4bfe466f56b323b03e99c365"],
  ["20260807193500_nobull_docs_tables.sql", "a06918b0ee93a8553b983dcac92459afb98ec3bebc52d61482ab009a5908cf8d"],
  ["20260807194500_client_file_share_links.sql", "e33d385c31976c505cae778d277b699e821b93f8828447884f7947b0002994e6"],
  ["20260807214500_doc_document_permissions.sql", "0df9333f943a86c9d4f3bdb33db1d2cf1a9d65f9bb40f894125c7e92b9861a29"],
  ["20260807214943_zoom_match_assistant.sql", "c36d00bdfdf2584bbe84d6f6335604e92cb4712233a7d361c1e7a5c976186c23"],
  ["20260808204207_retire_google_drive_integration.sql", "d622061c07961c607a3d5913ad2470e241b8e84ce13c1a97279d2718228db15d"],
  ["20260808224900_delete_legacy_google_sa_key_setting.sql", "e81b2bfd40f57e60dece3d6b72f7fc6a61472cbe9bf61d41b95eca0f9609caf9"],
  // --- re-freeze #1 (2026-08-10, Task #4190): post-activation migrations ---
  ["20260809202505_sd_department_scope_and_role_defaults.sql", "c6c9c116223adea63680e468e93ebf773fe92229547ddef5d060456c1dc05ff3"],
  ["20260810005717_drop_comparative_metrics_tables.sql", "d098f16affa087bf9b4521dcfdf22e0fca63cfd6945aabcd65aa8f710d1388d4"],
]);

/** Marker a NEW migration must carry when it contains destructive SQL. */
export const DESTRUCTIVE_APPROVAL_MARKER = /^\s*--\s*destructive-approved:\s*\S+/m;

interface DestructivePattern {
  label: string;
  re: RegExp;
}

/**
 * Destructive / incompatible-SQL heuristics (advisory approval flag — see
 * header rule 3). Deliberately tight to avoid false positives: plain
 * CREATE INDEX is NOT flagged (this repo's migrations run inside
 * transactions where CONCURRENTLY is impossible; index lock cost is part
 * of the reviewed strategy note when relevant), and DROP INDEX / DROP
 * CONSTRAINT are routine forward fixes.
 */
export const DESTRUCTIVE_PATTERNS: readonly DestructivePattern[] = [
  { label: "DROP TABLE", re: /\bdrop\s+table\b/i },
  { label: "DROP COLUMN", re: /\bdrop\s+column\b/i },
  { label: "SET NOT NULL (incompatible without backfilled default)", re: /\bset\s+not\s+null\b/i },
  { label: "ALTER COLUMN … TYPE (table rewrite risk)", re: /\balter\s+column\s+[\w"]+\s+(?:set\s+data\s+)?type\b/i },
  { label: "TRUNCATE", re: /\btruncate\b/i },
];

/** Strip `-- …` line comments so commented-out SQL never trips the scan. */
export function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

export function findDestructiveStatements(sql: string): string[] {
  const stripped = stripLineComments(sql);
  return DESTRUCTIVE_PATTERNS.filter((p) => p.re.test(stripped)).map((p) => p.label);
}

export interface MigrationImmutabilityResult {
  ok: boolean;
  skipped: boolean;
  reportOnly: boolean;
  violations: string[];
  /** Approved-destructive notices (marker present) — informational only. */
  notices: string[];
  summaryLine: string;
}

export interface MigrationImmutabilityOptions {
  /** Directory to scan (default: the repo's migrations/). */
  migrationsDir?: string;
  /** Ledger to judge against (default: FROZEN_MIGRATION_HASHES). */
  ledger?: ReadonlyMap<string, string>;
  /** Value of LINT_MIGRATION_IMMUTABILITY_SKIP (default: process.env). */
  skipEnv?: string | undefined;
  /** Value of LINT_MIGRATION_IMMUTABILITY_REPORT_ONLY (default: process.env). */
  reportOnlyEnv?: string | undefined;
}

export function runLint(opts: MigrationImmutabilityOptions = {}): MigrationImmutabilityResult {
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const ledger = opts.ledger ?? FROZEN_MIGRATION_HASHES;
  const skipEnv = "skipEnv" in opts ? opts.skipEnv : process.env.LINT_MIGRATION_IMMUTABILITY_SKIP;
  const reportOnly =
    ("reportOnlyEnv" in opts
      ? opts.reportOnlyEnv
      : process.env.LINT_MIGRATION_IMMUTABILITY_REPORT_ONLY) === "1";

  if (skipEnv === "1") {
    return {
      ok: true,
      skipped: true,
      reportOnly,
      violations: [],
      notices: [],
      summaryLine: "lint-migration-immutability: SKIPPED (LINT_MIGRATION_IMMUTABILITY_SKIP=1)",
    };
  }

  const onDisk = new Set(readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")));
  const violations: string[] = [];
  const notices: string[] = [];

  // Rule 1: every ledger entry present + byte-identical.
  for (const [name, expected] of ledger) {
    if (!onDisk.has(name)) {
      violations.push(
        `migrations/${name}: frozen migration MISSING (deleted or renamed). ` +
          `Migration history is append-only — restore the file exactly as committed ` +
          `and ship any fix as a NEW timestamp-prefixed migration.`,
      );
      continue;
    }
    const actual = createHash("sha256")
      .update(readFileSync(join(migrationsDir, name)))
      .digest("hex");
    if (actual !== expected) {
      violations.push(
        `migrations/${name}: frozen migration EDITED (sha-256 ${actual.slice(0, 12)}… != ` +
          `ledger ${expected.slice(0, 12)}…). Applied migrations are immutable — revert the ` +
          `edit and ship the change as a NEW timestamp-prefixed migration.`,
      );
    }
  }

  // Rules 2+3: new (non-ledger) files — destructive-SQL advisory approval.
  let newCount = 0;
  for (const name of [...onDisk].sort()) {
    if (ledger.has(name)) continue;
    newCount++;
    const raw = readFileSync(join(migrationsDir, name), "utf8");
    const destructive = findDestructiveStatements(raw);
    if (destructive.length === 0) continue;
    if (DESTRUCTIVE_APPROVAL_MARKER.test(raw)) {
      notices.push(
        `migrations/${name}: destructive SQL (${destructive.join("; ")}) with ` +
          `in-file "-- destructive-approved:" marker — approved, verify the noted ` +
          `rewrite/lock strategy in review.`,
      );
    } else {
      violations.push(
        `migrations/${name}: NEW migration contains destructive/incompatible SQL ` +
          `(${destructive.join("; ")}) without an approval marker. Destructive schema ` +
          `changes are case-by-case with owner approval (hardening-epic decision record): ` +
          `add a line "-- destructive-approved: <who/why + rewrite/lock/index-build strategy>" ` +
          `after obtaining approval, or restructure as an additive expand-contract change.`,
      );
    }
  }

  const summaryLine =
    `lint-migration-immutability: ${violations.length === 0 ? "OK" : "FAIL"} ` +
    `(${ledger.size} frozen ledger entries verified, ${newCount} new migration(s), ` +
    `${notices.length} approved-destructive notice(s)${reportOnly ? "; REPORT-ONLY" : ""})`;

  return { ok: violations.length === 0, skipped: false, reportOnly, violations, notices, summaryLine };
}

export function cliMain(): number {
  const result = runLint();
  if (result.skipped) {
    console.log(result.summaryLine);
    return 0;
  }
  for (const n of result.notices) console.log(`  note: ${n}`);
  if (!result.ok) {
    console.error("");
    console.error("✗ lint-migration-immutability: migration immutability violation(s)");
    console.error("");
    console.error("  Applied migration files are immutable history: the dev ledger, the");
    console.error("  hermetic template hash, and prod's SAFE re-apply path reference them");
    console.error("  by exact name+content. Fix forward with NEW migrations, never by");
    console.error("  editing, renaming, or deleting an old file.");
    console.error("");
    for (const v of result.violations) console.error(`  - ${v}`);
    console.error("");
    console.error("  The ledger in scripts/lint-migration-immutability.ts is write-once");
    console.error("  (content-hash-pinned by tests/lint-migration-immutability.test.ts).");
    console.error("  Emergency override: LINT_MIGRATION_IMMUTABILITY_SKIP=1 (only if the");
    console.error("  violation is intentional and documented in the same change).");
    console.error("");
    if (result.reportOnly) {
      console.error("  REPORT-ONLY mode: violations reported, exit 0.");
      console.error("");
      return 0;
    }
    return 1;
  }
  console.log(result.summaryLine);
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-migration-immutability.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
