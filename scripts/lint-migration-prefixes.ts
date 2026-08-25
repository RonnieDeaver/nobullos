/**
 * Pre-merge / pre-deploy lint guard against migration filename prefix
 * collisions (Task #1868, reworked by Task #3786).
 *
 * Background — the 2026-05-26 prod incident (Task #1867):
 *   Two migration files shipped in the same release sharing the `0076`
 *   numeric prefix. The deploy path silently applied only one of them and
 *   left a critical table uncreated in prod. There was no automated check
 *   that would have caught the collision at PR time.
 *
 * Why sequential prefixes kept colliding (Task #3786):
 *   With `NNNN_` numbering, "pick the next free number" is a read of shared
 *   mutable state — two concurrent tasks branched from the same main both
 *   see the same "next" number and collide on merge, guaranteed. The 19
 *   historical collision prefixes inside the frozen snapshot below are
 *   exactly that failure repeating. Uniqueness must come by construction,
 *   not by coordination.
 *
 * The convention (from Task #3786 on):
 *   NEW migrations use a UTC timestamp prefix:
 *
 *       YYYYMMDDHHMMSS_short_description.sql
 *       e.g. 20260804153012_add_widget_flags.sql
 *
 *   Generate the prefix with:  date -u +%Y%m%d%H%M%S
 *   Rules enforced here:
 *     - exactly 14 digits, starting with `20` (so every new name sorts
 *       AFTER the legacy 0000–0155 range in the lexicographic order
 *       server/devMigrations.ts applies, and a malformed prefix like
 *       `00000000000001_` can never sort into the middle of history);
 *     - `_snake_case` description after the prefix;
 *     - two files may never share a timestamp prefix — there is NO
 *       allow-list for timestamp collisions (re-run `date -u` and rename;
 *       a same-second collision between two tasks is not a coordination
 *       problem, it is an accident that takes seconds to fix).
 *
 * The legacy namespace is FROZEN (ratcheted by Task #3944):
 *   Every numeric-prefix file that existed at the Task #3786 cutover is
 *   listed in FROZEN_LEGACY_MIGRATIONS below. Renaming or renumbering any
 *   of them is destructive (the dev ledger and post-merge tooling reference
 *   them by exact name), so they stay as they are — including the 19
 *   historical collision prefixes, whose allowance is now DERIVED from the
 *   frozen snapshot itself (see frozenCollisionGroups). Any numeric-prefix
 *   file NOT in the frozen snapshot fails this lint with the instruction to
 *   use the timestamp convention instead, and the error names the exact
 *   colliding prefix and filenames when the new file lands on an occupied
 *   prefix.
 *
 * Why there is no separate collision allow-list (Task #3944):
 *   The pre-#3944 shape kept a second hand-maintained ALLOWLISTED_COLLISIONS
 *   map next to the frozen set. Its git history shows post-guard collisions
 *   (0107, 0109, 0112, 0120, 0121, 0122, 0129, 0142, 0146) being absorbed by
 *   editing that map — allow-list growth WAS the normal pass path — and two
 *   keys (0142, 0146) had gone stale, still "allowing" collisions whose
 *   files were long since renamed (so re-introducing them would have passed).
 *   Deriving collision knowledge from the single frozen snapshot removes the
 *   second source of truth entirely: the ONLY way to widen what passes is to
 *   edit FROZEN_LEGACY_MIGRATIONS, and tests/lint-migration-prefixes.test.ts
 *   pins that snapshot by content hash, so any edit fails the always-core
 *   guard test until the test's pinned hash is changed in the same reviewed
 *   diff. This lint never writes any file and accepts no update/refresh
 *   style flag; there is no regeneration path.
 *
 * The frozen snapshot passes only while unchanged or shrinking:
 *   deleting a historical duplicate from disk passes (the snapshot entry
 *   simply no longer matches a file); adding ANY numeric-prefix file that is
 *   not byte-for-byte in the snapshot fails.
 *
 * Exit code:
 *   0 — no new collisions, no new legacy-style names, all names well-formed.
 *   1 — at least one violation; the message names every offending file.
 *
 * Emergency escape hatch:
 *   Set LINT_MIGRATION_PREFIXES_SKIP=1 to skip the check entirely. Use
 *   only when you're certain the violation is intentional and documented.
 */
import { readdirSync } from "node:fs";

// Scope intentionally fixed (Task #2846): migration files live only in
// migrations/ by project convention; there is no other tree to discover.
const MIGRATIONS_DIR = "migrations";

/**
 * The frozen legacy namespace: every `*.sql` file present in migrations/ at
 * the Task #3786 cutover. Write-once — this list is never edited again (new
 * migrations use the timestamp convention and never touch this file, which
 * is the point: adding a migration must not edit any shared file).
 */
export const FROZEN_LEGACY_MIGRATIONS: ReadonlySet<string> = new Set<string>([
  "0000_concerned_reptil.sql",
  "0001_faulty_moira_mactaggert.sql",
  "0002_green_power_man.sql",
  "0003_add_webhook_reimport_fields.sql",
  "0003_yielding_ben_parker.sql",
  "0004_known_norrin_radd.sql",
  "0005_round_iron_fist.sql",
  "0006_add_conversation_group_fields.sql",
  "0007_add_communication_client_links.sql",
  "0007_add_user_activity_logs.sql",
  "0008_add_user_timezone.sql",
  "0009_add_is_touchpoint.sql",
  "0010_add_sync_progress.sql",
  "0011_add_work_queue.sql",
  "0012_consolidate_work_queue_class.sql",
  "0013_add_durable_pipeline.sql",
  "0014_backfill_command_panel_product_types.sql",
  "0015_add_blocked_ips.sql",
  "0016_add_match_settings.sql",
  "0016_add_zoom_review_queue_columns.sql",
  "0017_add_stale_lease_threshold_audit.sql",
  "0018_add_admin_setting_audit.sql",
  "0019_add_queue_timing_audit.sql",
  "0020_add_dismiss_reason_columns.sql",
  "0021_add_blocked_rate_limit_events.sql",
  "0021_add_match_setting_alert_status.sql",
  "0022_add_zoom_review_reopen_audit.sql",
  "0023_backfill_legacy_explanation_summary_prefix.sql",
  "0024_add_rer_recordings_unique_constraint.sql",
  "0025_add_key_calls_unique_constraint.sql",
  "0026_add_match_setting_alert_failure_reason.sql",
  "0027_add_admin_setting_audit_alert_status.sql",
  "0027_add_comparative_metrics_snapshots.sql",
  "0028_add_semrush_sync_outcome.sql",
  "0029_add_import_entity_suggestions.sql",
  "0030_add_front_filter_rules.sql",
  "0031_add_report_section_history.sql",
  "0032_add_backfill_jobs.sql",
  "0033_add_semrush_location_sync_attempts.sql",
  "0034_add_booking_tables.sql",
  "0035_add_booking_pages_account_manager_unique.sql",
  "0036_add_scheduled_meetings_no_overlap.sql",
  "0037_conversation_hub_perf.sql",
  "0038_add_twilio_message_status_fields.sql",
  "0038_add_user_call_mode.sql",
  "0039_add_twilio_message_updated_at.sql",
  "0040_add_twilio_call_recording_fields.sql",
  "0041_add_call_archive_pipeline.sql",
  "0042_add_ceo_pulse_include_graphs.sql",
  "0043_add_user_zoom_host_override.sql",
  "0044_add_booking_meeting_types.sql",
  "0045_add_client_contacts_audit.sql",
  "0046_zoom_review_nullable_client_id.sql",
  "0047_add_notification_registry.sql",
  "0048_add_client_locations_audit.sql",
  "0049_backfill_empty_report_sections.sql",
  "0050_add_user_display_timezone_source.sql",
  "0051_add_call_analysis_slow_lane.sql",
  "0051_add_front_sync_pipeline_state.sql",
  "0052_add_meeting_recurrence.sql",
  "0053_add_booking_pages_allow_recurring.sql",
  "0054_seed_recurring_meeting_feature_flags.sql",
  "0055_add_thread_notes_and_assignments.sql",
  "0055_add_twilio_voicemail_fields.sql",
  "0056_add_communication_orphan_events.sql",
  "0056_add_twilio_message_messaging_service_sid.sql",
  "0057_add_call_archive_requeue_audit.sql",
  "0058_add_call_archive_health_snapshots.sql",
  "0058_add_call_archive_leased_at.sql",
  "0059_add_rate_limit_notification_prune_history.sql",
  "0059_add_semrush_campaign_metadata_cache.sql",
  "0060_add_notifications_metadata.sql",
  "0061_heatmap_keyword_canonical_check.sql",
  "0062_add_front_filter_rule_hits.sql",
  "0063_add_thread_assignment_notifications.sql",
  "0064_add_perf_indexes.sql",
  "0065_add_front_analytics_monthly_coverage.sql",
  "0066_add_front_analytics_unrecoverable.sql",
  "0067_add_front_analytics_search_fallback.sql",
  "0067_add_thread_read_states.sql",
  "0067_add_user_notifications.sql",
  "0068_add_user_slack_preferences.sql",
  "0069_drop_legacy_notifications.sql",
  "0069_drop_legacy_notifications_table.sql",
  "0070_pool_epic_phase15_audits.sql",
  "0071_add_google_ads_tables.sql",
  "0071_add_user_functions_and_authority.sql",
  "0072_google_ads_budget_and_dollars.sql",
  "0073_semrush_demand_driven_cadence.sql",
  "0074_add_prod_action_runs.sql",
  "0075_add_semrush_enrichment_cache.sql",
  "0076_add_front_analytics_unit_columns.sql",
  "0077_add_front_operational_rules.sql",
  "0077_add_users_deleted_at.sql",
  "0078_add_dedupe_drop_verdict_rollups.sql",
  "0079_add_front_rule_hits_prev_reason.sql",
  "0080_add_front_analytics_closed_via.sql",
  "0081_add_front_analytics_per_direction.sql",
  "0082_semrush_enrichment_cache_complete_flag.sql",
  "0083_add_front_operational_rule_deletions.sql",
  "0084_add_competitor_structured_location.sql",
  "0085_readd_user_notifications_dedupe_unique_index.sql",
  "0086_add_competitor_gbp_backfill_attempted_at.sql",
  "0087_add_competitor_structured_location_backfill_attempted_at.sql",
  "0088_add_ris_qa_layer.sql",
  "0089_add_competitor_locality_relabel_attempted_at.sql",
  "0090_add_ris_bigquery_autopull.sql",
  "0091_add_ris_performance_layer.sql",
  "0092_add_feedback_video_analysis.sql",
  "0093_add_competitor_backfill_retry_counts.sql",
  "0094_add_front_coverage_convergence_attempts.sql",
  "0095_add_ris_client_auto_source_overrides.sql",
  "0096_add_client_monthly_review_target.sql",
  "0097_add_reports_source_pdf_storage_key.sql",
  "0098_add_client_hide_other_leads.sql",
  "0099_add_live_data_snapshots.sql",
  "0100_add_app_backup_runs.sql",
  "0101_add_front_coverage_deep_search_exhausted.sql",
  "0102_add_front_coverage_denominator_floor.sql",
  "0103_add_google_ads_audit.sql",
  "0104_rename_ris_checks_key_unique.sql",
  "0105_add_sheets_tables.sql",
  "0106_add_sheet_workbook_locks.sql",
  "0107_add_clickup_filter_presets.sql",
  "0107_add_nobull_comms.sql",
  "0108_add_google_ads_os.sql",
  "0109_add_clickup_workspace_plan.sql",
  "0109_add_sheet_templates.sql",
  "0110_add_sheets_role_grants.sql",
  "0111_add_sheet_workbook_versions.sql",
  "0112_add_service_desk_foundation.sql",
  "0112_add_sheet_workbook_activity.sql",
  "0113_add_sd_ticket_events.sql",
  "0114_add_clickup_mirror_tables.sql",
  "0115_comms_unique_active_client_channel.sql",
  "0116_comms_calls_call_type.sql",
  "0117_add_sheet_workbook_dashboards.sql",
  "0118_comms_calls_recording.sql",
  "0119_comms_daily_driver.sql",
  "0120_comms_user_status.sql",
  "0121_comms_webhooks.sql",
  "0122_comms_bookmarks.sql",
  "0122_comms_drafts_scheduled.sql",
  "0122_comms_sidebar_categories.sql",
  "0123_comms_notification_settings.sql",
  "0124_comms_thread_members.sql",
  "0125_comms_edit_history_reminders.sql",
  "0126_comms_link_previews_thumbnails.sql",
  "0127_comms_custom_emoji.sql",
  "0128_add_sd_request_type_templates.sql",
  "0130_add_sd_question_answers.sql",
  "0131_sd_client_option_ids.sql",
  "0132_clickup_authorized_workspaces.sql",
  "0133_sidebar_category_client_subgroup_collapsed.sql",
  "0134_sd_client_option_names.sql",
  "0135_sd_client_dept_assignments.sql",
  "0136_ads_os_stores.sql",
  "0137_sd_role_assignments.sql",
  "0138_drop_legacy_google_ads_os_tables.sql",
  "0139_sd_template_step_assignees_richer_questions.sql",
  "0140_sd_step_assignee_department_override.sql",
  "0141_client_engagement_snapshots.sql",
  "0144_churn_radar.sql",
  "0145_client_offboardings.sql",
  "0146_add_client_save_plays.sql",
  "0147_client_agent_chats_created_by.sql",
  "0148_publish_intel_notes_directly.sql",
  "0149_restore_raw_comm_external_source_id_unique_idx.sql",
  "0150_roadmap.sql",
  "0151_website_inquiries.sql",
  "0155_am_coaching.sql",
]);

/**
 * Historical prefix collisions inside the frozen namespace, DERIVED from the
 * snapshot above (Task #3944) — there is deliberately no second
 * hand-maintained collision list to grow or go stale. A prefix "allows" a
 * collision exactly when the frozen snapshot itself contains two or more
 * filenames with that prefix; nothing outside the snapshot can widen it.
 */
export function frozenCollisionGroups(
  frozen: ReadonlySet<string> = FROZEN_LEGACY_MIGRATIONS,
): Map<string, string[]> {
  const byPrefix = new Map<string, string[]>();
  for (const name of frozen) {
    const m = name.match(/^(\d+)_/);
    if (!m) continue;
    const arr = byPrefix.get(m[1]) ?? [];
    arr.push(name);
    byPrefix.set(m[1], arr);
  }
  for (const [prefix, files] of byPrefix) {
    if (files.length < 2) byPrefix.delete(prefix);
    else files.sort();
  }
  return byPrefix;
}

export const TIMESTAMP_RE = /^(20\d{12})_[a-z0-9_]+\.sql$/;

export interface MigrationPrefixLintResult {
  ok: boolean;
  skipped: boolean;
  violations: string[];
  summaryLine: string;
}

export interface MigrationPrefixLintOptions {
  /** Directory to scan (default: the repo's migrations/). */
  migrationsDir?: string;
  /** Frozen snapshot to judge against (default: FROZEN_LEGACY_MIGRATIONS). */
  frozenSet?: ReadonlySet<string>;
  /** Value of LINT_MIGRATION_PREFIXES_SKIP (default: process.env). */
  skipEnv?: string | undefined;
}

export function runLint(opts: MigrationPrefixLintOptions = {}): MigrationPrefixLintResult {
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const frozen = opts.frozenSet ?? FROZEN_LEGACY_MIGRATIONS;
  const skipEnv = "skipEnv" in opts ? opts.skipEnv : process.env.LINT_MIGRATION_PREFIXES_SKIP;

  if (skipEnv === "1") {
    return {
      ok: true,
      skipped: true,
      violations: [],
      summaryLine: "lint-migration-prefixes: SKIPPED (LINT_MIGRATION_PREFIXES_SKIP=1)",
    };
  }

  const entries = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

  const violations: string[] = [];
  const timestampByPrefix = new Map<string, string[]>();
  const legacyOnDiskByPrefix = new Map<string, string[]>();
  const frozenGroups = frozenCollisionGroups(frozen);

  // First pass: bucket every on-disk file so collision messages can name the
  // exact set of files occupying a prefix.
  const nonFrozenNumeric: string[] = [];
  for (const name of entries) {
    if (frozen.has(name)) {
      const m = name.match(/^(\d+)_/);
      if (m) {
        const arr = legacyOnDiskByPrefix.get(m[1]) ?? [];
        arr.push(name);
        legacyOnDiskByPrefix.set(m[1], arr);
      }
      continue;
    }
    const ts = name.match(TIMESTAMP_RE);
    if (ts) {
      const arr = timestampByPrefix.get(ts[1]) ?? [];
      arr.push(name);
      timestampByPrefix.set(ts[1], arr);
      continue;
    }
    if (/^\d/.test(name)) {
      nonFrozenNumeric.push(name);
    } else {
      violations.push(
        `migrations/${name}: migration filename must start with a UTC timestamp ` +
          `prefix (YYYYMMDDHHMMSS_, from \`date -u +%Y%m%d%H%M%S\`) followed by a ` +
          `snake_case description, e.g. 20260804153012_add_widget_flags.sql`,
      );
    }
  }

  // Numeric names outside the frozen snapshot: always a violation. When the
  // prefix is already occupied (on disk or in the snapshot), the error names
  // the exact collision so the fix is unambiguous.
  for (const name of nonFrozenNumeric) {
    const prefix = name.match(/^(\d+)/)?.[1] ?? "";
    const occupants = new Set<string>([
      ...(legacyOnDiskByPrefix.get(prefix) ?? []),
      ...(frozenGroups.get(prefix) ?? []),
      ...[...frozen].filter((f) => f.startsWith(`${prefix}_`)),
      ...nonFrozenNumeric.filter((f) => f !== name && f.startsWith(`${prefix}_`)),
    ]);
    const base =
      `migrations/${name}: new migration with a non-timestamp numeric name. ` +
      `Sequential NNNN_ prefixes are frozen as of Task #3786 (two concurrent ` +
      `tasks always pick the same "next" number). Rename it to the timestamp ` +
      `convention: $(date -u +%Y%m%d%H%M%S)_${name.replace(/^\d+_/, "").replace(/\.sql$/, "")}.sql`;
    if (occupants.size > 0) {
      violations.push(
        `${base} — prefix ${prefix} COLLISION with: ${[...occupants]
          .sort()
          .map((f) => `migrations/${f}`)
          .join(", ")}`,
      );
    } else {
      violations.push(base);
    }
  }

  // Timestamp collisions: never allowed, no allow-list.
  for (const [prefix, files] of timestampByPrefix) {
    if (files.length < 2) continue;
    violations.push(
      `timestamp prefix ${prefix} used by ${files.length} files (${files
        .sort()
        .map((f) => `migrations/${f}`)
        .join(", ")}). Timestamp prefixes must be unique — regenerate with ` +
        `\`date -u +%Y%m%d%H%M%S\` and rename.`,
    );
  }

  // Defensive: an on-disk legacy collision group must be a subset of the
  // group the frozen snapshot models for that prefix. By construction this
  // holds (membership above required frozen.has), so a failure here means
  // the snapshot or the bucketing logic was corrupted — fail loudly rather
  // than silently allowing it.
  for (const [prefix, files] of legacyOnDiskByPrefix) {
    if (files.length < 2) continue;
    const modeled = frozenGroups.get(prefix) ?? [];
    const unmodeled = files.filter((f) => !modeled.includes(f));
    if (unmodeled.length > 0) {
      violations.push(
        `legacy prefix ${prefix} collision includes files the frozen snapshot does not model: ${unmodeled
          .sort()
          .map((f) => `migrations/${f}`)
          .join(", ")} (modeled: ${modeled.map((f) => `migrations/${f}`).join(", ")})`,
      );
    }
  }

  const legacyOnDisk = [...legacyOnDiskByPrefix.values()].reduce((n, v) => n + v.length, 0);
  const summaryLine =
    `lint-migration-prefixes: OK (${entries.length} migration files: ` +
    `${legacyOnDisk} frozen legacy on disk of ${frozen.size} snapshot entries, ` +
    `${timestampByPrefix.size} timestamp-named, ` +
    `${frozenGroups.size} historical collision prefixes derived from the frozen snapshot)`;

  return { ok: violations.length === 0, skipped: false, violations, summaryLine };
}

export function cliMain(): number {
  const result = runLint();
  if (result.skipped) {
    console.log(result.summaryLine);
    return 0;
  }

  if (!result.ok) {
    console.error("");
    console.error("✗ lint-migration-prefixes: migration naming violation(s) detected");
    console.error("");
    console.error("  Colliding prefixes make the deploy path silently apply only one");
    console.error("  file (Task #1867 prod incident). Since Task #3786, new migrations");
    console.error("  use a UTC timestamp prefix that is unique by construction:");
    console.error("");
    console.error("    $(date -u +%Y%m%d%H%M%S)_short_description.sql");
    console.error("");
    for (const v of result.violations) console.error(`  - ${v}`);
    console.error("");
    console.error("  There is NO allow-list to grow: the frozen legacy snapshot in this");
    console.error("  file is write-once (content-hash-pinned by tests/lint-migration-");
    console.error("  prefixes.test.ts) and new names must use the timestamp convention.");
    console.error("  Emergency override: LINT_MIGRATION_PREFIXES_SKIP=1 (only if the");
    console.error("  violation is intentional and documented in the same change).");
    console.error("");
    return 1;
  }

  console.log(result.summaryLine);
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-migration-prefixes.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
