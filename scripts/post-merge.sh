#!/bin/bash
set -e

# Task #4617: per-phase instrumentation + fingerprint-keyed skips.
# scripts/post-merge-instrument.mjs is node-builtins-only, so it works BEFORE
# npm install. Instrumentation calls are best-effort (|| true) — they must
# never break environment setup. Skip decisions FALL OPEN: `should-skip-*`
# exits 0 only when skipping is provably safe (fingerprint matches the last
# SUCCESSFUL completion in this environment); any doubt/error means run.
# Phase-start stamps are WRITE-AHEAD: an outer-timeout SIGKILL (untrappable)
# still attributes the in-flight phase in .local/runs/post-merge-last-run.json.
# Escape lever: POST_MERGE_FORCE_ALL=1 runs every phase unconditionally.
INSTR="scripts/post-merge-instrument.mjs"

# Task #4501 — capture the task-merge SHA and its parent BEFORE any post-merge
# auto-commits (route-inventory refresh, generated-artifact refresh, etc.) shift
# HEAD. The canary reads these via CANARY_MERGE_SHA / CANARY_MERGE_BASE so it
# always diffs the actual task merge, not a subsequent auto-commit.
# (Task #4617 moved the capture ahead of npm install — strictly earlier is
# strictly safer for the same guarantee.)
CANARY_MERGE_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
CANARY_MERGE_BASE=$(git rev-parse HEAD~1 2>/dev/null || echo "")
export CANARY_MERGE_SHA CANARY_MERGE_BASE

node "$INSTR" begin-run --merge-sha="$CANARY_MERGE_SHA" --merge-base="$CANARY_MERGE_BASE" || true
trap 'node "$INSTR" end-run --exit=$? || true' EXIT

# --- Phase: npm-install (fingerprint-skippable; retry once — Task #4617) ---
node "$INSTR" phase-start --phase=npm-install || true
if node "$INSTR" should-skip-npm; then
  echo ">>> npm install skipped (inputs unchanged since last successful run)"
  node "$INSTR" phase-end --phase=npm-install --exit=0 --skipped || true
else
  if npm install --no-fund --no-audit; then npm_ec=0; else npm_ec=$?; fi
  if [ "$npm_ec" -ne 0 ]; then
    echo "!!! npm install failed (exit $npm_ec) — retrying once (transient registry/network failures dominate; Task #4617)"
    if npm install --no-fund --no-audit; then npm_ec=0; else npm_ec=$?; fi
  fi
  node "$INSTR" phase-end --phase=npm-install --exit="$npm_ec" || true
  if [ "$npm_ec" -ne 0 ]; then exit "$npm_ec"; fi
  node "$INSTR" record-npm-success || true
fi

# Sweep root junk + prune stale scratch zones (Task #3794 policy). Main's
# worktree is the template every task environment (and the publish image) is
# cloned from: merge waves deposit git-ignored debris (*_block.txt dumps,
# one-off root .html, tmp_* scripts) that resurrects lint-worktree-hygiene
# failures in every clone until MAIN itself is cleaned. --stale-only keeps
# the junk sweep + TTL/size-cap zone pruning but never full-wipes a live
# session's fresh .local/scratch. Non-fatal: the hygiene lint stays the gate.
node "$INSTR" phase-start --phase=clean-scratch || true
if npx tsx scripts/clean-scratch.ts --stale-only; then cs_ec=0; else
  cs_ec=$?
  echo "WARN: clean-scratch --stale-only failed (non-fatal; lint-worktree-hygiene will flag residue)"
fi
node "$INSTR" phase-end --phase=clean-scratch --exit="$cs_ec" || true

# Pre-create tables that would otherwise trigger drizzle-kit push's
# interactive create-vs-rename prompt (which hangs the non-interactive
# post-merge run). Only ADD entries here whose SQL is fully idempotent
# (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / etc).
# Older auto-generated migrations (0000-0005) are NOT idempotent and
# must NOT be listed here.
SAFE_MIGRATIONS=(
  "migrations/0029_add_import_entity_suggestions.sql"
  "migrations/0030_add_front_filter_rules.sql"
  "migrations/0031_add_report_section_history.sql"
  "migrations/0032_add_backfill_jobs.sql"
  "migrations/0033_add_semrush_location_sync_attempts.sql"
  "migrations/0034_add_booking_tables.sql"
  "migrations/0035_add_booking_pages_account_manager_unique.sql"
  "migrations/0036_add_scheduled_meetings_no_overlap.sql"
  "migrations/0037_conversation_hub_perf.sql"
  "migrations/0046_zoom_review_nullable_client_id.sql"
  "migrations/0049_backfill_empty_report_sections.sql"
  "migrations/0062_add_front_filter_rule_hits.sql"
  "migrations/0063_add_thread_assignment_notifications.sql"
  "migrations/0066_add_front_analytics_unrecoverable.sql"
  "migrations/0067_add_thread_read_states.sql"
  "migrations/0067_add_user_notifications.sql"
  "migrations/0069_drop_legacy_notifications.sql"
  "migrations/0070_pool_epic_phase15_audits.sql"
  "migrations/0077_add_front_operational_rules.sql"
  "migrations/0078_add_dedupe_drop_verdict_rollups.sql"
  # 0085: the user_notifications unread-dedupe partial UNIQUE index is raw
  # SQL, NOT in shared/schema.ts (same class as 0117/0149) — drizzle push
  # drops it, and 0085's own comments say it is "applied by the post-merge
  # psql step", but it was never actually listed here. Dev has been silently
  # missing the index since (prod HAS it — a Publish diff could propose
  # dropping the DB-level dedupe guarantee from production). Fully
  # idempotent (LOCK + no-op DELETE + CREATE IF NOT EXISTS). Found by the
  # Task #4617 trio sentinel probe on its first live run.
  "migrations/0085_readd_user_notifications_dedupe_unique_index.sql"
  "migrations/0092_add_feedback_video_analysis.sql"
  "migrations/0103_add_google_ads_audit.sql"
  "migrations/0108_add_google_ads_os.sql"
  "migrations/0104_rename_ris_checks_key_unique.sql"
  # 0114 intentionally excludes clickup_filter_presets (owned by 0107 above via
  # the drizzle push path; it already exists in dev).
  "migrations/0114_add_clickup_mirror_tables.sql"
  # 0117: sheet_workbook_dashboards is runtime-ensured by sheetsStorage.ts
  # (not in shared/schema.ts), so it must be re-created after every push or
  # the next Publish diff proposes dropping it from PRODUCTION.
  "migrations/0117_add_sheet_workbook_dashboards.sql"
  # 0136: the Ads OS jsonb stores are runtime-ensured by adsOs/storeSchema.ts
  # (not in shared/schema.ts) — same class as 0117. Losing them silently
  # blanked Budget Pacing/Hygiene/Traffic Quality once (Task #3706); keep them
  # pre-created AND re-applied post-push so a Publish diff never drops them.
  "migrations/0136_ads_os_stores.sql"
  # 0138: drops the RETIRED legacy Ads OS tables (google_ads_pacing_store
  # etc., Task #3603). The migration was baselined-as-applied on dev without
  # ever executing, so the orphans lingered in dev AND prod — a stale
  # `google_ads_pacing_store.max(updated_at)` (frozen 2026-07-17) was then
  # mistaken for a stalled pacing refresh (Task #4036; the LIVE store is
  # ads_os_budget_pacing). Idempotent DROP IF EXISTS; re-applying keeps dev
  # clean so the Publish diff drops them from production.
  "migrations/0138_drop_legacy_google_ads_os_tables.sql"
  # 0143: the ON CONFLICT arbiter index on raw_communication_records
  # (external_source_id, partial) is bootstrap-managed raw SQL, NOT in
  # shared/schema.ts — drizzle push drops it, and NODE_ENV=test skips the
  # bootstrap self-heal, so it must be re-created here or the Front
  # materializer suites fail with "no unique or exclusion constraint"
  # (Task #3698 gate breakage).
  "migrations/0149_restore_raw_comm_external_source_id_unique_idx.sql"
  # 20260806180000: the two partial freshness-probe indexes on
  # raw_communication_records (Task #3889 going-quiet feed guard + rolling
  # -window prod action) are raw SQL, NOT in shared/schema.ts — same class
  # as 0149: drizzle push drops them, and without them the probes seq-scan
  # a 1M+-row table on every tab load / prod-action status poll. The
  # data_gap column itself is schema-owned; re-adding it here is a no-op.
  "migrations/20260806180000_going_quiet_data_gap.sql"
  # 20260807152551: Task #4008 — google_ads_connection is retired (env-only
  # credentials). The DROP IF EXISTS is idempotent; keeping it here makes the
  # table vanish BEFORE drizzle push diffs the schema (the table left
  # shared/schema.ts in the same task, so push would otherwise hit the
  # interactive drop prompt on environments that still have the row).
  "migrations/20260807152551_drop_google_ads_connection.sql"
  # 20260807214943: Task #4057 — zoom_match_sweeps + zoom_transcript_match_
  # analyses are raw SQL, NOT in shared/schema.ts (same class as 0117/0149):
  # drizzle push won't create them, so without this entry fresh hermetic
  # templates, post-merge dev DBs, and the Publish diff all lack the
  # Transcript Match Assistant tables and its route seeding 42P01s.
  # CREATE TABLE IF NOT EXISTS — idempotent. (Registered by Task #4050's
  # rebase repair; #4057 shipped the file without the metadata entry.)
  "migrations/20260807214943_zoom_match_assistant.sql"
  # 20260808204207: Task #4084 — the Google Drive integration is retired
  # (in-app client files are the only pipeline sink; only the Sheets token
  # lane survives). Same class as the google_ads_connection drop above: the
  # drive tables left shared/schema.ts in the same task, so this DROP must
  # run BEFORE drizzle push diffs the schema or push hits the interactive
  # drop prompt. Also deletes the retired Drive settings keys and the two
  # retired alert ids' live notification state. Idempotent.
  "migrations/20260808204207_retire_google_drive_integration.sql"
  # 20260810005717: Task #4202 — drops the two orphaned comparative-metrics
  # tables from the retired Zoom comparative-semantic card (same class as the
  # google_ads_connection / drive drops above: the tables left
  # shared/schema.ts in the same task, so this DROP must run BEFORE drizzle
  # push diffs the schema or push hits the interactive drop prompt). Also
  # deletes the stale zoom_comparative_reset_alert_slack_channel_id settings
  # row. Idempotent.
  "migrations/20260810005717_drop_comparative_metrics_tables.sql"
  # 20260810012532: Task #4181 — drops the abandoned industry_trends table
  # (zero live readers/writers; the practice-area trends endpoint computes
  # fresh per request and never persisted here). Same class as the drops
  # above: the table leaves shared/schema.ts in the same task, so this DROP
  # must run BEFORE drizzle push diffs the schema or push hits the
  # interactive drop prompt. Idempotent.
  "migrations/20260810012532_drop_industry_trends.sql"
  # 20260808224900: Task #4107 — deletes the stored legacy Google SA key
  # (google_service_account_key). The Sheets lane authenticates with the
  # GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY secret; the legacy key is being
  # deleted in Google Cloud (B-008 closure). DELETE WHERE — idempotent.
  "migrations/20260808224900_delete_legacy_google_sa_key_setting.sql"
  "migrations/20260811155925_drop_legacy_chat_and_intake_stats.sql"
  # 20260813161020: Task #4705 — collapses any historical duplicate
  # ats_submissions rows per (candidate_id, question_id) BEFORE drizzle push
  # creates the schema-declared unique index
  # (ats_submissions_candidate_question_unique_idx); without the pre-apply, a
  # lingering duplicate would make push fail on index creation. Idempotent
  # (no-op DELETE on replay + CREATE UNIQUE INDEX IF NOT EXISTS).
  "migrations/20260813161020_ats_submissions_candidate_question_unique.sql"
)

# --- Atomic trio: SAFE_MIGRATIONS pre-apply → drizzle push → re-apply -------
# Skippable ONLY as a unit (Task #4617): the skip is honored when the trio
# fingerprint (migrations/** + shared/** + drizzle.config.ts + package-lock +
# this script + DATABASE_URL hash) matches the last SUCCESSFUL trio AND the
# sentinel probe confirms every raw-SQL object the SAFE_MIGRATIONS protect is
# still present in the dev DB (to_regclass) — a manual bare `drizzle-kit push`
# between merges would otherwise leave dev drifted and feed a WRONG Publish
# diff (the 0117/0136 prod-drop incident class). Any doubt ⇒ run all three.
# An interrupted trio never records a fingerprint, so it re-runs next time.
POST_MERGE_PSQL_MAX_ATTEMPTS=3
POST_MERGE_PSQL_CONNECT_TIMEOUT_SECONDS=10

apply_safe_migration() {
  local migration_file="$1"
  local attempt=1
  local exit_code=0
  local retry_delay_seconds=0

  while [ "$attempt" -le "$POST_MERGE_PSQL_MAX_ATTEMPTS" ]; do
    if PGCONNECT_TIMEOUT="$POST_MERGE_PSQL_CONNECT_TIMEOUT_SECONDS" \
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration_file" > /dev/null; then
      return 0
    else
      exit_code=$?
    fi

    if [ "$attempt" -lt "$POST_MERGE_PSQL_MAX_ATTEMPTS" ]; then
      retry_delay_seconds=$((attempt * 5))
      echo "WARN: migration apply attempt ${attempt}/${POST_MERGE_PSQL_MAX_ATTEMPTS} failed for $migration_file (exit $exit_code); retrying in ${retry_delay_seconds}s"
      sleep "$retry_delay_seconds"
    fi
    attempt=$((attempt + 1))
  done

  return "$exit_code"
}

if node "$INSTR" should-skip-trio; then
  echo ">>> schema trio skipped (inputs unchanged since last successful run; sentinel verified protected objects)"
  node "$INSTR" phase-start --phase=schema-trio || true
  node "$INSTR" phase-end --phase=schema-trio --exit=0 --skipped || true
else
  node "$INSTR" phase-start --phase=migrations-pre-apply || true
  for f in "${SAFE_MIGRATIONS[@]}"; do
    if [ -f "$f" ]; then
      echo ">>> applying $f"
      apply_safe_migration "$f" || {
        mig_ec=$?
        echo "!!! migration apply FAILED: $f (exit $mig_ec)"
        node "$INSTR" phase-end --phase=migrations-pre-apply --exit="$mig_ec" || true
        exit "$mig_ec"
      }
    fi
  done
  node "$INSTR" phase-end --phase=migrations-pre-apply --exit=0 || true

  node "$INSTR" phase-start --phase=drizzle-push || true
  push_started=$(date +%s)
  if npx drizzle-kit push --force; then push_ec=0; else push_ec=$?; fi
  push_elapsed=$(( $(date +%s) - push_started ))
  echo ">>> drizzle-kit push took ${push_elapsed}s (diagnostic only — never auto-killed; Task #4617)"
  node "$INSTR" phase-end --phase=drizzle-push --exit="$push_ec" || true
  if [ "$push_ec" -ne 0 ]; then exit "$push_ec"; fi

  # drizzle-kit push --force DROPS any dev-DB objects that are not in
  # shared/schema.ts — including the raw-SQL tables/columns created by the
  # SAFE_MIGRATIONS above. Re-apply them AFTER the push so they survive;
  # otherwise the next Publish diff proposes dropping them from PRODUCTION
  # (this happened with dedupe_drop_verdict_rollups + user_feedback.video_analysis).
  node "$INSTR" phase-start --phase=migrations-re-apply || true
  for f in "${SAFE_MIGRATIONS[@]}"; do
    if [ -f "$f" ]; then
      echo ">>> re-applying $f (post-push)"
      apply_safe_migration "$f" || {
        mig_ec=$?
        echo "!!! migration apply FAILED: $f (exit $mig_ec)"
        node "$INSTR" phase-end --phase=migrations-re-apply --exit="$mig_ec" || true
        exit "$mig_ec"
      }
    fi
  done
  node "$INSTR" phase-end --phase=migrations-re-apply --exit=0 || true
  node "$INSTR" record-trio-success || true
fi

# Merge-integrity verification + TypeScript cache pre-warm (Task #3922,
# absorbing the Task #3808 pre-warm). verify-merge-integrity runs
# `npm run check` itself — seeding .cache/typescript/tsbuildinfo exactly like
# the old standalone pre-warm did, so the first gate typecheck stays warm
# (~11-35s instead of ~90s) — and, when HEAD is a merge commit (i.e. a system
# merge just landed), compares the merged tree against the upstream tip to
# flag files the merge changed that no task commit touched (smears /
# resurrected ancestor content) plus typecheck errors in files the task never
# touched. Loud console warnings + machine-readable report at
# .local/runs/merge-integrity.json. Best-effort: NEVER breaks environment
# setup — the gate reports typecheck authoritatively later.
echo ">>> merge-integrity verification + TypeScript cache pre-warm (best-effort)"
node "$INSTR" phase-start --phase=merge-integrity || true
if npx tsx scripts/verify-merge-integrity.ts; then mi_ec=0; else
  mi_ec=$?
  echo ">>> merge-integrity check crashed (non-fatal); run 'npx tsx scripts/verify-merge-integrity.ts' by hand"
fi
node "$INSTR" phase-end --phase=merge-integrity --exit="$mi_ec" || true

# Route-inventory auto-refresh (Task #4111). Two independently-green tasks
# can merge with line-number-only drift in tests/route-inventory.json (each
# passed alone; the combined merge shifted route line numbers with nobody
# regenerating) — leaving EVERY nightly lint-route-inventory-freshness run
# red until someone regenerates by hand. This detects staleness right after
# the merge, auto-runs scripts/regen-route-inventory.mjs, and commits ONLY
# the two inventory artifacts. Non-zero exit = needs human attention (regen
# crashed, commit failed, or the lint is still red after regen — e.g.
# duplicate live registrations, a source bug regen cannot fix); surfaced as
# a loud warning but non-fatal, matching merge-integrity above — the gate /
# nightly lint stays the authoritative enforcement.
echo ">>> route-inventory freshness auto-refresh (Task #4111)"
node "$INSTR" phase-start --phase=route-inventory-refresh || true
ri_ec=0
npx tsx scripts/post-merge-route-inventory-refresh.ts || {
  ri_ec=$?
  echo "!!! WARN: route-inventory refresh needs attention — see output above."
  echo "!!!       Run 'npx tsx scripts/regen-route-inventory.mjs' + commit, or fix duplicate registrations."
}
node "$INSTR" phase-end --phase=route-inventory-refresh --exit="$ri_ec" || true

# Generated-artifact auto-refresh (Task #4115), generalizing #4111 to the
# remaining committed generated artifacts with freshness lints. MUST run
# AFTER the route-inventory refresh above: the endpoint contract table
# (audits/D-endpoint-contract-table.{md,json}) is generated FROM
# tests/route-inventory.json, so an inventory auto-regen immediately stales
# the contract table (exactly the repeat lint-contract-table-freshness reds
# of 2026-08-08). Also covers website/public (input-fingerprint stamp can
# mismatch the merged UNION of inputs even when both sides regenerated), and
# (Task #4189) the four generated governance inventories in
# audits/governance/ (data-ownership, integration-reliability,
# async-topology, test-portfolio-baseline) whose freshness smoke tests would
# otherwise turn the next gate/nightly red after merge-shifted drift.
# Detect → regen → commit ONLY the artifact paths; loud non-fatal warning on
# anything regen can't fix — the gate/nightly lints stay authoritative.
echo ">>> generated-artifact freshness auto-refresh (Tasks #4115 + #4189)"
node "$INSTR" phase-start --phase=generated-artifact-refresh || true
ga_ec=0
npx tsx scripts/post-merge-generated-artifact-refresh.ts || {
  ga_ec=$?
  echo "!!! WARN: generated-artifact refresh needs attention — see output above."
  echo "!!!       Regen by hand with the generator named in the output above, then commit the artifact."
}
node "$INSTR" phase-end --phase=generated-artifact-refresh --exit="$ga_ec" || true

# Post-merge canary (Task #4501): run the blast-radius smoke slice for this
# merge on main, partial-publish any new reds to tests/red-manifest.json with
# the culprit commit stamped, and write .local/runs/post-merge-canary.json.
# Always exits 0 (advisory; never blocks the post-merge pipeline). The result
# is consumed by attribution: a new red in the manifest with a culprit stamp
# lets the NEXT task gate auto-excuse it instead of burning hours on manual
# innocence proofs.  Kill switch: POST_MERGE_CANARY=0.
# Task #4617: the canary now pre-computes its slice in-process via the
# runner's own exported selection code and spawns `npm test -- --file=<list>`
# — the disclosed set IS the executed set; empty/unrunnable slices skip
# honestly without booting the runner.
echo ">>> post-merge canary (Task #4501)"
node "$INSTR" phase-start --phase=canary || true
ca_ec=0
npx tsx scripts/post-merge-canary.ts || {
  ca_ec=$?
  echo "!!! WARN: post-merge canary script itself crashed with a non-zero exit — this should not happen (it always exits 0). Ignoring."
}
node "$INSTR" phase-end --phase=canary --exit="$ca_ec" || true

# Note: full test suite (`npx tsx tests/run-all.ts`) intentionally NOT run here.
# It takes 8+ minutes and exceeds the post-merge timeout, which caused the
# Task #836 merge to log "Error in river, code: CANCEL". Run tests manually
# with `npx tsx tests/run-all.ts` or as a validation step instead.
