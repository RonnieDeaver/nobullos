// @db-pool-intent: worker
/**
 * Prod-action domain module (F7, Task #4154): Platform operations — DB extensions/maintenance switches, notification dedupe, user backfills, self-heal & misc kill switches.
 *
 * Split verbatim out of the monolithic server/services/prodActionsRegistry.ts.
 * Every action definition, helper, and comment below is a byte-for-byte
 * relocation (the only mechanical changes: `export ` added where the
 * composition root or a sibling module now imports a symbol, and inline
 * PROD_ACTIONS array entries hoisted into named consts). Do NOT add new
 * behavior here without the usual prod-action review gates; registration
 * order lives in ./composition.ts, not in this file.
 */

import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../../db";
import { bindArrayParam } from "../../utils/sqlArray";
import {
  startBackgroundDrain,
  getDrainState,
  formatDrainProgress,
  isDrainRunning,
} from "../prodActionBackgroundDrain";
import {
  DEEP_PRUNE_ACTION_ID,
  BACKLOG_PENDING_THRESHOLD,
  BACKLOG_COUNT_CAP,
  countPruneBacklog,
  findOverBandTables,
  runDeepPruneChunk,
  formatDeepPruneSummary,
} from "../tableDeepPruneReclaim";
import { COVERED_TABLE_NAMES, bytesToMb } from "../tableMaintenancePolicy";
import { registerModuleStateResetForTest } from "../moduleStateReset";
import {
  applyPiiPurge,
  probePiiPurgeState,
  PURGED_PII_PATHS,
} from "../gitPiiPurge";
import { type ProdAction, type ProdActionDomain } from "./kernel";
import { killSwitchAction, systemSettingAction } from "./helpers";
import {
  getCriteriaStrict,
  listCriteriaKeysStrict,
  patchCriteriaPracticeAreasStrict,
  putCriteria,
  type PracticeAreaCriteriaPatchResult,
} from "../adsOs/store";
import {
  directoryHealth,
  getClientDirectory,
  type DirectoryBundle,
} from "../adsOs/clickUpDirectory";
import {
  isSeededMinimal,
  isOverdue,
} from "../adsOs/criteriaCompletenessHelpers";


// ─── Dedupe user_notifications so Publish can build unread unique index ───
//
// The Replit Publish pipeline diffs the Drizzle schema in
// `shared/models/notifications.ts` and runs its own CREATE UNIQUE INDEX
// for `user_notifications_user_dedupe_unread_uniq` — it does NOT execute
// the DELETE in migrations/0067_add_user_notifications.sql, so live
// duplicate unread rows make every deploy fail validation. This action
// runs the same partition-rank DELETE the migration does (newest
// per (user_id, dedupe_key) survives, older unread dupes removed). It
// is read-only with respect to the schema and idempotent: re-pressing
// after a successful run reports `not-needed` because the dedupe scan
// finds zero candidates. Operator workflow: press once → re-publish.
export const dedupeUserNotificationsUnreadAction: ProdAction = {
  id: "dedupe_user_notifications_unread",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Dedupe user_notifications unread duplicates",
  description:
    "Removes older duplicate unread rows in user_notifications (same user_id + dedupe_key, both read_at and archived_at NULL), keeping the most recent. Required before Replit Publish can build the user_notifications_user_dedupe_unread_uniq partial unique index when prod has pre-existing duplicates.",
  change:
    "DELETE older unread duplicate rows from user_notifications, keeping the newest per (user_id, dedupe_key). Read + archived rows are NEVER touched.",
  // Task #2086 — duplicates appear gradually; an hourly check is ample.
  selfHeal: { cadenceMs: 60 * 60_000, backoffMs: 6 * 60 * 60_000 },
  async status() {
    const result = await withDbAttribution(
      "maintenance:prod-actions-user-notifications-dedupe-count",
      () =>
        getDb().execute(sql`
          SELECT COUNT(*)::int AS n
          FROM (
            SELECT id,
                   row_number() OVER (
                     PARTITION BY user_id, dedupe_key
                     ORDER BY created_at DESC, id DESC
                   ) AS rn
            FROM user_notifications
            WHERE dedupe_key IS NOT NULL
              AND read_at IS NULL
              AND archived_at IS NULL
          ) ranked
          WHERE ranked.rn > 1
        `),
    );
    const n = Number((result.rows as any[])[0]?.n ?? 0);
    if (n === 0) {
      return {
        state: "not-needed",
        detail: "No duplicate unread user_notifications rows.",
      };
    }
    return {
      state: "pending",
      detail: `${n} duplicate unread row(s) would be deleted (newest per user+dedupe_key kept).`,
    };
  },
  async apply() {
    const deleted = await withDbAttribution(
      "maintenance:prod-actions-user-notifications-dedupe-delete",
      () =>
        getDb().execute(sql`
          DELETE FROM user_notifications u
          USING (
            SELECT id
            FROM (
              SELECT id,
                     row_number() OVER (
                       PARTITION BY user_id, dedupe_key
                       ORDER BY created_at DESC, id DESC
                     ) AS rn
              FROM user_notifications
              WHERE dedupe_key IS NOT NULL
                AND read_at IS NULL
                AND archived_at IS NULL
            ) ranked
            WHERE ranked.rn > 1
          ) dups
          WHERE u.id = dups.id
          RETURNING u.id
        `),
    );
    const rowsAffected = deleted.rowCount ?? (deleted.rows as any[]).length;
    if (rowsAffected === 0) {
      return {
        state: "not-needed",
        detail: "No duplicate unread user_notifications rows.",
      };
    }
    return {
      state: "applied",
      detail: `Deleted ${rowsAffected} duplicate unread row(s). Re-publish to let the migrator build user_notifications_user_dedupe_unread_uniq.`,
      rowsAffected,
    };
  },
};


// ─── Task #1810: CREATE EXTENSION pg_stat_statements ─────────────────
//
// One-shot bootstrap of the `pg_stat_statements` extension on the
// connected database. `shared_preload_libraries` already includes the
// extension in prod (per `replit.md` Runtime Truth Table); this action
// runs the `CREATE EXTENSION IF NOT EXISTS` that the regression
// scanner in `scripts/pg-stat-statements-regression.ts` waits on.
//
// Idempotent: re-pressing finds the extension installed and returns
// `not-needed`. Graceful: if the connecting role lacks CREATE on the
// database (the prod Neon `neondb_owner` role typically can; a
// reduced-privilege role can't), the apply returns an `error` outcome
// with the Postgres error message — it never throws past the apply
// path, so an "Apply all" press is unaffected.
// Task #1814 follow-up: the dev workspace runs Helium with
// `shared_preload_libraries = timescaledb,helium` only — installing
// the extension catalogs the views without making them queryable, and
// drizzle-kit's deploy-time introspection then emits a `CREATE VIEW
// pg_stat_statements_info` migration that prod can't apply (the
// extension's function doesn't exist on prod yet). Refuse to install
// unless the cluster actually preloads the library.
async function clusterPreloadsPgStatStatements(): Promise<boolean> {
  try {
    const res = await withDbAttribution(
      "maintenance:prod-actions-pg-stat-statements-preload",
      () => getDb().execute(sql`SHOW shared_preload_libraries`),
    );
    const value = String(
      (res.rows as any[])[0]?.shared_preload_libraries ?? "",
    ).toLowerCase();
    return value.split(/[\s,]+/).filter(Boolean).includes("pg_stat_statements");
  } catch {
    return false;
  }
}


export const createPgStatStatementsExtensionAction: ProdAction = {
  id: "create_pg_stat_statements_extension",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Database catalog change on production (CREATE EXTENSION) — a deliberate operator step on the correct database; it refuses to run where the preload is absent.",
  },
  title: "Create pg_stat_statements extension",
  description:
    "Idempotent `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` on the connected database. Refuses to run unless `shared_preload_libraries` includes `pg_stat_statements` (i.e. prod Neon, NOT dev Helium) — installing the catalog row on dev makes drizzle-kit emit a CREATE VIEW migration that breaks the prod deploy (Task #1814). The regression scanner in scripts/pg-stat-statements-regression.ts exits cleanly when the extension is missing; this action is the operator surface to install it once on prod. Graceful on permission-denied — surfaces the Postgres error instead of throwing.",
  change: "CREATE EXTENSION IF NOT EXISTS pg_stat_statements",
  async status() {
    try {
      const res = await withDbAttribution(
        "maintenance:prod-actions-pg-stat-statements-check",
        () =>
          getDb().execute(sql`
            SELECT 1 AS present
            FROM pg_extension
            WHERE extname = 'pg_stat_statements'
            LIMIT 1
          `),
      );
      const present = (res.rows as any[]).length > 0;
      if (present) {
        return { state: "not-needed", detail: "Extension already installed." };
      }
      if (!(await clusterPreloadsPgStatStatements())) {
        return {
          state: "not-needed",
          detail:
            "Cluster does not preload pg_stat_statements (likely dev Helium). Refusing to install — would break the next prod deploy (Task #1814).",
        };
      }
      return {
        state: "pending",
        detail: "Extension missing; CREATE EXTENSION IF NOT EXISTS pg_stat_statements will run.",
      };
    } catch (err: any) {
      return {
        state: "error",
        detail: `Failed to probe pg_extension: ${err?.message ?? String(err)}`,
      };
    }
  },
  async apply() {
    try {
      // Probe first so an already-installed extension reports
      // `not-needed` without needing CREATE privilege on the DB.
      const before = await withDbAttribution(
        "maintenance:prod-actions-pg-stat-statements-check",
        () =>
          getDb().execute(sql`
            SELECT 1 AS present
            FROM pg_extension
            WHERE extname = 'pg_stat_statements'
            LIMIT 1
          `),
      );
      if ((before.rows as any[]).length > 0) {
        return { state: "not-needed", detail: "Extension already installed." };
      }
      // Hard gate: never CREATE EXTENSION on a cluster that doesn't
      // preload pg_stat_statements — see Task #1814.
      if (!(await clusterPreloadsPgStatStatements())) {
        return {
          state: "not-needed",
          detail:
            "Cluster does not preload pg_stat_statements (likely dev Helium). Refused: installing here would create the extension's catalog views in public, and the next prod deploy diff would emit CREATE VIEW pg_stat_statements_info that prod can't apply.",
        };
      }
      await withDbAttribution(
        "maintenance:prod-actions-pg-stat-statements-create",
        () => getDb().execute(sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`),
      );
      return {
        state: "applied",
        detail: "Installed pg_stat_statements extension.",
      };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // Common shape: `permission denied to create extension "pg_stat_statements"`.
      return {
        state: "error",
        detail: `CREATE EXTENSION failed: ${msg}`,
      };
    }
  },
};


// ─── Task #1758 follow-up: backfill users.authority_level from legacy role ───
// One-way *elevation-only* backfill. The legacy bridge in
// `deriveLegacyRole()` is lossy on the way down — both `lead` AND
// `director` map to `role='team_lead'` — so we cannot use a naive
// reverse CASE as the WHERE clause: it would silently demote any
// legitimate `director` to `lead` on every press. Instead this action
// ONLY upgrades rows that are clearly the column default (`core` or
// NULL) when the legacy `role` indicates a higher authority:
//   role='ceo'       AND authority_level IN ('core', NULL) → 'ceo'
//   role='team_lead' AND authority_level IN ('core', NULL) → 'lead'
// `director` rows are never touched (they sit above 'lead' and there's
// no way to recover them from `role` alone — they must be set
// editorially). Idempotent: once core→ceo/lead is done, subsequent
// presses match 0 rows → `not-needed`. Does NOT touch `users.functions`
// (per-user editorial) and does NOT touch `users.role` (the bridge
// stays).
export const backfillUserAuthorityFromLegacyRoleAction: ProdAction = {
  id: "backfill_user_authority_from_legacy_role",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Elevation-only permissions backfill — changing user authority levels is an operator-reviewed security action, never auto-fired.",
  },
  title: "Backfill users.authority_level from legacy role",
  description:
    "Task #1758 follow-up. Elevation-only backfill of `users.authority_level` from the legacy `users.role` column. For users whose `authority_level` is still the column default (`core` or NULL), set it from `role`: `ceo` → `ceo`, `team_lead` → `lead`. Director rows and any already-elevated rows are never touched (the legacy `role` column cannot represent `director`, so a director with role='team_lead' is legitimate and must stay). Idempotent — second press reports `not-needed`. Does NOT touch `users.functions` (per-user editorial decision) and does NOT touch `users.role` (the bridge stays). Fixes the legacy CEO 403 on /admin/prod-actions.",
  change:
    "UPDATE users SET authority_level = CASE role WHEN 'ceo' THEN 'ceo' WHEN 'team_lead' THEN 'lead' END WHERE (authority_level IS NULL OR authority_level = 'core') AND role IN ('ceo','team_lead')",
  async status() {
    try {
      const res = await withDbAttribution(
        "maintenance:prod-actions-authority-backfill-check",
        () =>
          getDb().execute(sql`
            SELECT COUNT(*)::int AS n
            FROM users
            WHERE (authority_level IS NULL OR authority_level = 'core')
              AND role IN ('ceo', 'team_lead')
          `),
      );
      const n = Number((res.rows as any[])[0]?.n ?? 0);
      if (n === 0) {
        return {
          state: "not-needed",
          detail: "No core/NULL users have an elevated legacy role.",
        };
      }
      return {
        state: "pending",
        detail: `${n} user row(s) have legacy role ceo/team_lead but authority_level core/NULL.`,
      };
    } catch (err: any) {
      return {
        state: "error",
        detail: `Failed to probe users: ${err?.message ?? String(err)}`,
      };
    }
  },
  async apply() {
    try {
      const res = await withDbAttribution(
        "maintenance:prod-actions-authority-backfill-apply",
        () =>
          getDb().execute(sql`
            UPDATE users
            SET authority_level = CASE role
                  WHEN 'ceo' THEN 'ceo'
                  WHEN 'team_lead' THEN 'lead'
                END,
                updated_at = NOW()
            WHERE (authority_level IS NULL OR authority_level = 'core')
              AND role IN ('ceo', 'team_lead')
          `),
      );
      const rowsAffected = Number((res as any)?.rowCount ?? 0);
      if (rowsAffected === 0) {
        return {
          state: "not-needed",
          detail: "All users.authority_level values already match their legacy role.",
        };
      }
      return {
        state: "applied",
        detail: `Backfilled authority_level for ${rowsAffected} user row(s).`,
        rowsAffected,
      };
    } catch (err: any) {
      return {
        state: "error",
        detail: `UPDATE failed: ${err?.message ?? String(err)}`,
      };
    }
  },
};


// ─── Task #4777: repair feedback submitter names mis-filed as "Unknown" ─
//
// The Clerk cutover (2026-08-13) reduced the legacy-compat req.user.claims
// to { sub, role }, so POST /api/feedback — which snapshotted its
// denormalized user_name from the retired claims.first_name/claims.email
// fields — filed every human submission as "Unknown" until the same-change
// route fix (server/routes/feedback.ts now derives from req.dbUser).
// user_id was never wrong, so the repair is a pure rename: copy the display
// name from the matching live users row into rows still carrying the
// 'Unknown' sentinel. Scope guards:
//   - user_id NOT LIKE 'system:%' — system-filed items (regression sweep,
//     post-merge canary) own their user_name sentinels and are never
//     touched;
//   - only rows whose user_id matches a NON-DELETED users row that actually
//     has a name or email are renamed; 'Unknown' rows with no such match
//     (deleted users, truly anonymous legacy data) are left alone and
//     surfaced in the status/apply detail;
//   - the name derivation mirrors deriveFeedbackSubmitterName in
//     server/routes/feedback.ts (first+last name, else email) — the shared
//     fixtures in tests/feedback-submitter-name.test.ts pin both paths to
//     identical output.
// Idempotent + concurrency-safe via the CAS guard (WHERE user_name =
// 'Unknown'): renamed rows leave the predicate, an operator's manual rename
// wins over a concurrent apply, and a second press reports not-needed.
// Converging: the feeder is closed at ingest by the route fix shipped in
// the same change, so a later non-zero pending count is a genuine new
// incident (an auth-shape regression), not routine inflow.
const FEEDBACK_UNKNOWN_NAME_FROM_USERS_SQL = sql`
  COALESCE(
    NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
    NULLIF(TRIM(u.email), '')
  )
`;

export const repairFeedbackUnknownSubmitterNamesAction: ProdAction = {
  id: "repair_feedback_unknown_submitter_names",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot repair of display-name snapshots mis-filed during the 2026-08-13 Clerk cutover — rewriting stored submitter names is an operator-reviewed data fix, never auto-fired.",
  },
  title: "Repair feedback submitter names mis-filed as \"Unknown\"",
  description:
    "Task #4777. The Clerk cutover (2026-08-13) retired the legacy claim fields POST /api/feedback used for its submitter display-name snapshot, so every human feedback row filed since then carries user_name = 'Unknown' (prod ids 52–53 verified) even though user_id still resolves to the right users row. The route now derives the name from the users row at submit time; this action renames the already-mis-filed rows the same way: non-system rows (user_id NOT LIKE 'system:%') still named 'Unknown' whose user_id matches a non-deleted users row get that row's first+last name, falling back to its email. Rows with no matching live user (deleted or truly anonymous) are left alone and reported in the detail. One atomic idempotent UPDATE — a second press reports not-needed. Pre-cutover rows that stored an email as the name are deliberately untouched (accurate for their era).",
  change:
    "UPDATE user_feedback SET user_name = COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), NULLIF(TRIM(u.email), '')) FROM users u WHERE user_feedback.user_name = 'Unknown' AND user_feedback.user_id NOT LIKE 'system:%' AND u.id = user_feedback.user_id AND u.deleted_at IS NULL AND <derived name IS NOT NULL>",
  async status() {
    try {
      const res = await withDbAttribution(
        "maintenance:prod-actions-feedback-name-repair-check",
        () =>
          getDb().execute(sql`
            SELECT
              COUNT(*) FILTER (WHERE u.id IS NOT NULL)::int AS renameable,
              COUNT(*) FILTER (WHERE u.id IS NULL)::int AS unmatched
            FROM user_feedback uf
            LEFT JOIN users u
              ON u.id = uf.user_id
             AND u.deleted_at IS NULL
             AND ${FEEDBACK_UNKNOWN_NAME_FROM_USERS_SQL} IS NOT NULL
            WHERE uf.user_name = 'Unknown'
              AND uf.user_id NOT LIKE 'system:%'
          `),
      );
      const row = (res.rows as any[])[0] ?? {};
      const renameable = Number(row.renameable ?? 0);
      const unmatched = Number(row.unmatched ?? 0);
      const unmatchedNote =
        unmatched > 0
          ? ` ${unmatched} 'Unknown' row(s) have no matching live users row (deleted or truly anonymous) and are deliberately left alone.`
          : "";
      if (renameable === 0) {
        return {
          state: "not-needed",
          detail: `No non-system feedback rows named 'Unknown' match a live users row.${unmatchedNote}`,
        };
      }
      return {
        state: "pending",
        detail: `${renameable} non-system feedback row(s) are named 'Unknown' but resolve to a live users row with a name/email.${unmatchedNote}`,
      };
    } catch (err: any) {
      return {
        state: "error",
        detail: `Failed to probe user_feedback: ${err?.message ?? String(err)}`,
      };
    }
  },
  async apply() {
    try {
      const res = await withDbAttribution(
        "maintenance:prod-actions-feedback-name-repair-apply",
        () =>
          getDb().execute(sql`
            UPDATE user_feedback uf
            SET user_name = ${FEEDBACK_UNKNOWN_NAME_FROM_USERS_SQL}
            FROM users u
            WHERE uf.user_name = 'Unknown'
              AND uf.user_id NOT LIKE 'system:%'
              AND u.id = uf.user_id
              AND u.deleted_at IS NULL
              AND ${FEEDBACK_UNKNOWN_NAME_FROM_USERS_SQL} IS NOT NULL
          `),
      );
      const rowsAffected = Number((res as any)?.rowCount ?? 0);
      // Post-repair residue count so the applied detail honestly reports the
      // rows this action deliberately does NOT converge on.
      let unmatchedNote = "";
      try {
        const residue = await withDbAttribution(
          "maintenance:prod-actions-feedback-name-repair-check",
          () =>
            getDb().execute(sql`
              SELECT COUNT(*)::int AS unmatched
              FROM user_feedback uf
              WHERE uf.user_name = 'Unknown'
                AND uf.user_id NOT LIKE 'system:%'
            `),
        );
        const unmatched = Number((residue.rows as any[])[0]?.unmatched ?? 0);
        if (unmatched > 0) {
          unmatchedNote = ` ${unmatched} 'Unknown' row(s) remain — no matching live users row (deleted or truly anonymous); deliberately left alone.`;
        }
      } catch {
        // Best-effort residue report only — the rename outcome above stands.
      }
      if (rowsAffected === 0) {
        return {
          state: "not-needed",
          detail: `No non-system 'Unknown' feedback rows match a live users row.${unmatchedNote}`,
        };
      }
      return {
        state: "applied",
        detail: `Renamed ${rowsAffected} feedback row(s) from their matching users row.${unmatchedNote}`,
        rowsAffected,
      };
    } catch (err: any) {
      return {
        state: "error",
        detail: `UPDATE failed: ${err?.message ?? String(err)}`,
      };
    }
  },
};


// ─── Task #3814: deep prune + space reclamation for oversized tables ─
//
// Production measurements (2026-08-05): work_queue 809,610 rows / 693 MB,
// front_hydrate_snapshots 1,050 MB for 31 live rows, source_event_log
// 399 MB, work_result_log 294 MB, call_analysis_jobs 238 MB, apply_state
// 128 MB, mcu_cache 56 MB. Row DELETEs alone never return disk space —
// this action clears the historical backlog through the same batched
// prune units the hourly scheduler uses (unbounded, 5000-row chunks),
// then reclaims disk with per-table `VACUUM (FULL, ANALYZE)` on a
// dedicated worker-pool client (`lock_timeout='5s'` — a contended table
// is skipped and stays retryable, never blocked on). One press kicks a
// background drain; the final chunk writes per-table reclaim stamps
// ({at, bytesBefore, bytesAfter}) to `table_reclaim_state`, which is
// what makes status() converge to not-needed after a successful run
// (a fresh stamp on an over-band table means the band needs retuning,
// not another run). Steady-state coverage afterwards belongs to the
// scheduled pruner + size watchdog, not this action.
export const deepPruneReclaimOversizedTablesAction: ProdAction = {
  id: DEEP_PRUNE_ACTION_ID,
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Destructive deep-prune of oversized tables (permanent deletion beyond routine retention) — an operator confirms scope and timing before firing.",
  },
  title: "Deep prune + reclaim oversized DB tables",
  description:
    "One-time backlog cleanup for the high-churn operational tables covered by the table-maintenance policy (work_queue, source_event_log → cascades to work_result_log/apply_state, call_analysis_jobs, mcu_cache, table_size_samples). Phase 1 deletes every prune-eligible row (terminal + older than the declared retention windows) in 5000-row background-drain chunks; phase 2 runs VACUUM (FULL, ANALYZE) per covered table to return the dead space to the OS (this is what row-pruning alone never does — front_hydrate_snapshots held 1,050 MB for 31 live rows). Locked tables are skipped after 5s and reported as retryable. Safe to run repeatedly: work converges and a completed reclaim reports not-needed for 7 days.",
  change:
    "Batched DELETEs of prune-eligible rows per tableMaintenancePolicy unit, then per-table VACUUM (FULL, ANALYZE) on a dedicated worker-pool connection (lock_timeout 5s, session destroyed after use); writes per-table reclaim stamps to system_settings.table_reclaim_state.",
  async status() {
    if (isDrainRunning(DEEP_PRUNE_ACTION_ID)) {
      const s = getDrainState(DEEP_PRUNE_ACTION_ID)!;
      return {
        state: "pending",
        detail: `Deep prune/reclaim running: ${formatDrainProgress(s)}.`,
      };
    }
    const backlog = await countPruneBacklog();
    const overBand = await findOverBandTables();
    const staleOverBand = overBand.filter((t) => !t.stampFresh);
    const parts: string[] = [];
    if (backlog.total >= BACKLOG_PENDING_THRESHOLD) {
      const top = Object.entries(backlog.perUnit)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, n]) => `${k}: ${n >= BACKLOG_COUNT_CAP ? `${BACKLOG_COUNT_CAP.toLocaleString()}+` : n.toLocaleString()}`)
        .join(", ");
      parts.push(`${backlog.total.toLocaleString()}${backlog.total >= BACKLOG_COUNT_CAP ? "+" : ""} prune-eligible row(s) (${top})`);
    }
    if (staleOverBand.length > 0) {
      parts.push(
        `${staleOverBand.length} table(s) over size band without a recent reclaim (${staleOverBand
          .map((t) => `${t.table} ${bytesToMb(t.totalBytes)} MB > ${bytesToMb(t.bandBytes)} MB`)
          .join("; ")})`,
      );
    }
    if (parts.length === 0) {
      const freshNote =
        overBand.length > 0
          ? ` ${overBand.length} table(s) still over band but reclaimed within the last 7 days — retune \`table_size_watchdog_bands_mb\` if the new steady state is legitimate.`
          : "";
      return {
        state: "not-needed",
        detail: `Backlog below ${BACKLOG_PENDING_THRESHOLD.toLocaleString()} rows and no table needs reclamation; the hourly retention pruner handles residual churn.${freshNote}`,
      };
    }
    return { state: "pending", detail: `Needs deep prune/reclaim: ${parts.join("; ")}.` };
  },
  async apply(actorId) {
    const out = await startBackgroundDrain(
      {
        actionId: DEEP_PRUNE_ACTION_ID,
        actionTitle: "Deep prune + reclaim oversized DB tables",
        attributionLabel: "maintenance:prod-actions-deep-prune-reclaim",
        unit: "operations",
        countPending: async () => {
          // Progress denominator: capped eligible rows + one vacuum step
          // per covered table. The drain framework only needs a rough
          // total; chunk accounting reports the real per-key tallies.
          const backlog = await countPruneBacklog();
          return backlog.total + COVERED_TABLE_NAMES.length;
        },
        runChunk: () => runDeepPruneChunk(actorId ?? null),
        formatSummary: (state) => formatDeepPruneSummary(state.perKey),
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Task #4037 — Hard-delete the 7 archived Speedwell Law PLLC duplicate client rows ───
//
// Context: On 2026-02-11 a bulk-import double-fire created 8 client rows all
// named "Speedwell Law PLLC" (client codes NB-0036…NB-0043). The team
// immediately archived 7 of them (NB-0036, NB-0038…NB-0043) the same day.
// They have zero unique data: no comms, no reports, no heatmap snapshots.
// The canonical live row is cc20a7b1…(NB-0037). On 2026-04-08 a command-panel
// sweep auto-seeded panels for ALL clients including the archived duplicates,
// which is why they resurface in the missing-budget audit. This action
// permanently removes them so they can never appear in future sweeps.
//
// Safety guards (idempotent):
//   status() verifies every target is still archived AND carries no real
//   data (no raw_communication_records, reports, or heatmap_snapshots);
//   a row that has somehow acquired real data is excluded from deletion and
//   surfaces a warning so an operator can investigate before proceeding.
//
// Deletion order respects FK constraints (no CASCADE on most child tables):
//   command_panel_key_calls → command_panel_rer_recordings →
//   command_panel_history → command_panel_versions → command_panels →
//   client_data_access → client_locations → client_contacts → clients
const SPEEDWELL_DUPLICATE_IDS: string[] = [
  "bb19e86d-f144-4a6d-9f99-8a01005ebe5c", // NB-0036
  "3d75b94c-e2bc-4d90-ac16-2ab2b0f82417", // NB-0038
  "3f35fbfa-252a-41ea-ad9e-b35d69a17df8", // NB-0039
  "c0609c24-c746-4364-b045-43f6dff85a54", // NB-0040
  "3f5f4a43-a1db-4182-a20a-c62c20d96ddb", // NB-0041
  "3d28a92f-de29-4c13-80e7-f7ea77ef813d", // NB-0042
  "42c1cfe9-81d8-4eda-b2b3-a55cf49bba61", // NB-0043
];


export const deleteSpeedwellDuplicateClientsAction: ProdAction = {
  id: "delete_speedwell_duplicate_clients",
  // One-shot cleanup of 7 fixed archived duplicate rows — settles after one
  // apply (second press reports not-needed once the rows are gone).
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Hard-deletes specific archived client rows — permanent data deletion is operator-confirmed, never auto-fired.",
  },
  title: "Hard-delete 7 archived Speedwell Law PLLC duplicate client rows",
  description:
    "Permanently removes the 7 archived import-artifact duplicates of Speedwell Law PLLC (NB-0036, NB-0038…NB-0043) that were created by a 2026-02-11 bulk-import double-fire and archived the same day. They carry no unique data — only auto-seeded scaffolding. Deletion cascades through command_panel_*, client_data_access, client_locations, and client_contacts rows for those IDs. The canonical live row (NB-0037, cc20a7b1…) is untouched. Idempotent: a second press reports not-needed once the rows are gone. Blocks (does not delete) any row that has unexpectedly acquired real data (comms/reports/heatmap).",
  change:
    "DELETE FROM command_panel_key_calls, command_panel_rer_recordings, command_panel_history, command_panel_versions, command_panels, client_data_access, client_locations, client_contacts, clients WHERE client_id IN (NB-0036, NB-0038…NB-0043).",

  async status() {
    const result = await withDbAttribution(
      "maintenance:prod-actions-speedwell-dup-status",
      () =>
        getDb().execute(sql`
          SELECT
            c.id,
            c.client_code,
            c.is_archived,
            (SELECT COUNT(*) FROM raw_communication_records WHERE client_id = c.id) AS comms_count,
            (SELECT COUNT(*) FROM reports WHERE client_id = c.id)                   AS reports_count,
            (SELECT COUNT(*) FROM heatmap_snapshots WHERE client_id = c.id)         AS heatmap_count
          FROM clients c
          WHERE c.id = ANY(${bindArrayParam(SPEEDWELL_DUPLICATE_IDS)})
        `),
    );
    const rows = result.rows as Array<{
      id: string;
      client_code: string;
      is_archived: boolean;
      comms_count: string;
      reports_count: string;
      heatmap_count: string;
    }>;

    if (rows.length === 0) {
      return { state: "not-needed", detail: "All 7 archived Speedwell duplicate rows have already been deleted." };
    }

    // Flag any row that is unexpectedly NOT archived or has acquired real data.
    const flagged: string[] = [];
    for (const row of rows) {
      const hasData =
        parseInt(row.comms_count, 10) > 0 ||
        parseInt(row.reports_count, 10) > 0 ||
        parseInt(row.heatmap_count, 10) > 0;
      if (!row.is_archived || hasData) {
        flagged.push(
          `${row.client_code} (${row.id}): archived=${row.is_archived}, comms=${row.comms_count}, reports=${row.reports_count}, heatmap=${row.heatmap_count}`,
        );
      }
    }
    if (flagged.length > 0) {
      // Task #4840 — deliberately NO `integration` here: this is a
      // precondition wait-state (manual data review), not an auth-dead
      // reconnect. Naming a pseudo-integration made the panel render
      // "Manual review required login expired…" and paged admins falsely.
      return {
        state: "blocked",
        detail: `${flagged.length} row(s) have unexpected data and will NOT be deleted — investigate before proceeding:\n${flagged.join("\n")}`,
      };
    }

    return {
      state: "pending",
      detail: `${rows.length} archived Speedwell duplicate row(s) remain and are safe to delete (no comms, reports, or heatmap snapshots).`,
    };
  },

  async apply(actorId) {
    // Re-read current state to ensure nothing has changed since status().
    const checkResult = await withDbAttribution(
      "maintenance:prod-actions-speedwell-dup-apply-check",
      () =>
        getDb().execute(sql`
          SELECT
            c.id,
            c.client_code,
            c.is_archived,
            (SELECT COUNT(*) FROM raw_communication_records WHERE client_id = c.id) AS comms_count,
            (SELECT COUNT(*) FROM reports WHERE client_id = c.id)                   AS reports_count,
            (SELECT COUNT(*) FROM heatmap_snapshots WHERE client_id = c.id)         AS heatmap_count
          FROM clients c
          WHERE c.id = ANY(${bindArrayParam(SPEEDWELL_DUPLICATE_IDS)})
        `),
    );
    const rows = checkResult.rows as Array<{
      id: string;
      client_code: string;
      is_archived: boolean;
      comms_count: string;
      reports_count: string;
      heatmap_count: string;
    }>;

    if (rows.length === 0) {
      return { state: "not-needed", detail: "All 7 archived Speedwell duplicate rows are already gone." };
    }

    // Partition: safe-to-delete vs unexpected-data (skip those).
    const safeIds: string[] = [];
    const skipped: string[] = [];
    for (const row of rows) {
      const hasData =
        parseInt(row.comms_count, 10) > 0 ||
        parseInt(row.reports_count, 10) > 0 ||
        parseInt(row.heatmap_count, 10) > 0;
      if (!row.is_archived || hasData) {
        skipped.push(`${row.client_code} (${row.id})`);
      } else {
        safeIds.push(row.id);
      }
    }

    if (safeIds.length === 0) {
      // Task #4840 — see status(): no `integration` on manual-review waits.
      return {
        state: "blocked",
        detail: `All remaining rows have unexpected data — nothing deleted. Review: ${skipped.join(", ")}`,
      };
    }

    // Delete in FK-safe order (child tables first, clients last).
    // command_panels' own children first (command_panel_id FK), then
    // command_panels itself, then the remaining client-scoped child tables.
    await withDbAttribution(
      "maintenance:prod-actions-speedwell-dup-delete",
      async () => {
        const db = getDb();
        await db.execute(sql`
          DELETE FROM command_panel_key_calls
          WHERE client_id = ANY(${bindArrayParam(safeIds)})
        `);
        await db.execute(sql`
          DELETE FROM command_panel_rer_recordings
          WHERE client_id = ANY(${bindArrayParam(safeIds)})
        `);
        await db.execute(sql`
          DELETE FROM command_panel_history
          WHERE client_id = ANY(${bindArrayParam(safeIds)})
        `);
        await db.execute(sql`
          DELETE FROM command_panel_versions
          WHERE client_id = ANY(${bindArrayParam(safeIds)})
        `);
        await db.execute(sql`
          DELETE FROM command_panels
          WHERE client_id = ANY(${bindArrayParam(safeIds)})
        `);
        await db.execute(sql`
          DELETE FROM client_data_access
          WHERE client_id = ANY(${bindArrayParam(safeIds)})
        `);
        await db.execute(sql`
          DELETE FROM client_locations
          WHERE client_id = ANY(${bindArrayParam(safeIds)})
        `);
        await db.execute(sql`
          DELETE FROM client_contacts
          WHERE client_id = ANY(${bindArrayParam(safeIds)})
        `);
        await db.execute(sql`
          DELETE FROM clients
          WHERE id = ANY(${bindArrayParam(safeIds)})
            AND is_archived = true
        `);
      },
    );

    const skipSuffix = skipped.length > 0
      ? ` Skipped ${skipped.length} row(s) with unexpected data: ${skipped.join(", ")}.`
      : "";
    return {
      state: "applied",
      detail: `Deleted ${safeIds.length} archived Speedwell duplicate client row(s) and their scaffolding (command_panel_*, client_data_access, client_locations, client_contacts).${skipSuffix}`,
      rowsAffected: safeIds.length,
    };
  },
};

const COMPANY_OPS_DEPARTMENTS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "a1cddd74-6e6d-45f9-a6cf-465fae94031e", name: "Company Ops – Sales (New Business)" },
  { id: "16139020-81f8-40fd-b808-4fc60af3e72f", name: "Company Ops – Marketing" },
  { id: "12f1963f-dd58-4f50-8847-0e666fd4b580", name: "Company Ops – Operations" },
  { id: "0385e5ef-aff9-4d8c-bf54-c8310c2d676f", name: "Company Ops – HR / People" },
  { id: "c234e3e0-d1b1-499f-abb7-8fddeb0c1613", name: "Company Ops – Finance / Accounting" },
  { id: "9b6fa86c-3693-406d-8e81-551a042046a1", name: "Company Ops – IT / Systems" },
];
const _LEGACY_GCP_KEY_URL =
  "https://iam.googleapis.com/v1/projects/core-respect-369420/serviceAccounts/" +
  "nobull-os%40core-respect-369420.iam.gserviceaccount.com/keys/" +
  "43d3ab85b5596ea3e8f822b4e5c007b47b7eb8de";


// ─── Task #4762 — shared B-008 closure probe ─────────────────────────
// status() and servedPurpose() both need the same three facts (env var,
// DB setting, GCP key state), and the GCP fact costs an external IAM
// call — so one probe runs per panel pass via a short TTL memo. The GCP
// outcome is CLASSIFIED, not a bare boolean: "unknown" always names its
// cause (403 missing-permission vs dead clone credentials vs transport)
// so the panel surfaces honesty instead of a perpetual "Pending".

interface DriveLegacyKeyClosureProbe {
  envKeyPresent: boolean;
  /** null = the settings read itself failed (state unknown). */
  dbSettingPresent: boolean | null;
  gcpKey: "deleted" | "exists" | "unknown";
  /** Why the key state is unknown (only set when gcpKey === "unknown"). */
  gcpUnknownReason: string | null;
}

let _driveClosureProbeMemo: { at: number; result: DriveLegacyKeyClosureProbe } | null =
  null;
const DRIVE_CLOSURE_PROBE_TTL_MS = 30_000;

export function __resetDriveClosureProbeMemoForTest(): void {
  _driveClosureProbeMemo = null;
}
registerModuleStateResetForTest(
  "platformOpsActions.driveClosureProbe",
  __resetDriveClosureProbeMemoForTest,
);

async function probeDriveLegacyKeyClosure(): Promise<DriveLegacyKeyClosureProbe> {
  if (
    _driveClosureProbeMemo &&
    Date.now() - _driveClosureProbeMemo.at < DRIVE_CLOSURE_PROBE_TTL_MS
  ) {
    return _driveClosureProbeMemo.result;
  }
  const { getSystemSettingFresh } = await import("../../storage/settingsStorage");

  const envKeyPresent = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  let dbSettingPresent: boolean | null = null;
  try {
    const row = await getSystemSettingFresh("google_service_account_key");
    dbSettingPresent = !!row?.value?.trim();
  } catch {
    dbSettingPresent = null;
  }

  let gcpKey: "deleted" | "exists" | "unknown" = "unknown";
  let gcpUnknownReason: string | null = null;
  try {
    const { getIamAccessTokenFromSheetsKey } = await import(
      "../googleDriveIntegration"
    );
    const token = await getIamAccessTokenFromSheetsKey();
    const r = await fetch(_LEGACY_GCP_KEY_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 404) {
      gcpKey = "deleted";
    } else if (r.ok) {
      gcpKey = "exists";
    } else if (r.status === 403) {
      gcpUnknownReason =
        "IAM probe got 403 — the Sheets SA lacks IAM key-viewer permission on the legacy SA, so key state cannot be verified from here; verify/delete in Google Cloud Console (IAM & Admin → Service Accounts → nobull-os@core-respect-369420 → Keys → 43d3ab85…)";
    } else {
      const body = await r.text().catch(() => "");
      gcpUnknownReason = `IAM probe got HTTP ${r.status}${
        body ? ` (${body.slice(0, 160)})` : ""
      } — key state unverified`;
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    gcpUnknownReason = /invalid_grant/i.test(msg)
      ? "IAM probe could not authenticate (invalid_grant — the Google service-account credentials available to this environment are dead), so key state cannot be verified from here"
      : `IAM probe threw (${msg.slice(0, 160)}) — key state unverified`;
  }

  const result: DriveLegacyKeyClosureProbe = {
    envKeyPresent,
    dbSettingPresent,
    gcpKey,
    gcpUnknownReason,
  };
  _driveClosureProbeMemo = { at: Date.now(), result };
  return result;
}

export const deleteGoogleDriveLegacyKeyAction: ProdAction = {
  id: "delete_google_drive_legacy_sa_key",
  title: "Delete legacy Google Drive service-account key (B-008 closure)",
  description:
    "Task #4107 / audit finding B-008 — the legacy SA key " +
    "(nobull-os@core-respect-369420.iam.gserviceaccount.com, key 43d3ab85…) " +
    "held the full `drive` scope; a leaked key could reach every shared file. " +
    "Task #4084 retired the Drive integration; the Sheets read lane now uses the " +
    "dedicated GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY secret. This action (1) verifies " +
    "the Sheets lane works, (2) calls the Google Cloud IAM API to delete the legacy " +
    "key, (3) verifies IAM now returns 404, and only then (4) clears the stale " +
    "`google_service_account_key` DB setting and re-verifies Sheets. " +
    "See GOOGLE_DRIVE.md § Operator follow-through.",
  change:
    "Google Cloud IAM DELETE + GET verification for …/keys/43d3ab85…; " +
    "only after verified 404, DELETE system_settings WHERE key = 'google_service_account_key'.",
  // Manual lever: this is a one-time, irreversible credential-revocation
  // operation. Excluding it from Apply-all prevents an accidental global
  // "apply all" from revoking the key unintentionally.
  manualLever: true,
  convergence: { kind: "converging" },

  async status() {
    // Task #4762 — lever contract: a manual lever NEVER reads pending. A
    // lever is availability, not work — this row previously returned
    // pending on remaining facts (and even on a failed DB read), which
    // held the needs-attention badge hostage forever behind an IAM probe
    // that cannot succeed from here. The remaining-closure facts now live
    // in the detail, honestly classified, while the state stays synthetic
    // not-needed like every other lever.
    const probe = await probeDriveLegacyKeyClosure();

    if (
      !probe.envKeyPresent &&
      probe.dbSettingPresent === false &&
      probe.gcpKey === "deleted"
    ) {
      return {
        state: "not-needed",
        detail:
          "Legacy SA key is already deleted from Google Cloud, the env var is absent, " +
          "and the DB setting is cleared. B-008 fully closed.",
      };
    }

    const parts: string[] = [];
    if (probe.gcpKey === "exists") {
      parts.push("GCP key still exists (IAM probe saw it)");
    } else if (probe.gcpKey === "unknown") {
      parts.push(probe.gcpUnknownReason ?? "GCP key state unknown");
    }
    if (probe.dbSettingPresent === true) {
      parts.push("google_service_account_key setting still in DB");
    } else if (probe.dbSettingPresent === null) {
      parts.push(
        "DB setting state unknown (settings read failed — re-check when the DB is healthy)",
      );
    }
    if (probe.envKeyPresent) {
      parts.push("GOOGLE_SERVICE_ACCOUNT_KEY env var still set");
    }
    return {
      state: "not-needed",
      detail:
        "Manual lever — remaining B-008 closure state: " +
        parts.join("; ") +
        ". Fire this lever (or use the Google Cloud Console path above) to finish closure.",
    };
  },

  // Task #4762 — served-purpose probe: once closure is VERIFIED (IAM probe
  // confirms 404, DB setting cleared, env var absent) the lever retires to
  // History. "Unknown" never retires — an unverifiable key state keeps the
  // lever visible so closure is proven, not assumed.
  async servedPurpose() {
    const probe = await probeDriveLegacyKeyClosure();
    const served =
      !probe.envKeyPresent &&
      probe.dbSettingPresent === false &&
      probe.gcpKey === "deleted";
    return {
      served,
      note: served
        ? "Legacy Drive SA key deleted (IAM probe verified 404), DB setting cleared, env var absent — B-008 closed."
        : undefined,
    };
  },

  async apply(actorId) {
    const { getIamAccessTokenFromSheetsKey, getSheetsAccessToken } = await import(
      "../googleDriveIntegration"
    );
    const { deleteSystemSetting, getSystemSettingFresh } = await import(
      "../../storage/settingsStorage"
    );
    _driveClosureProbeMemo = null;

    // Step 1: verify Sheets lane works before touching anything.
    try {
      await getSheetsAccessToken();
    } catch (err: any) {
      return {
        state: "error",
        detail:
          "Sheets lane verification FAILED before deletion — aborting to avoid " +
          "breaking the Ads OS client-log reader. " +
          `Error: ${err?.message ?? String(err)}. ` +
          "Confirm GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY is set and valid.",
      };
    }

    // Step 2: call the GCP IAM API to delete the legacy key.
    let gcpDetail: string;
    let iamToken: string;
    try {
      iamToken = await getIamAccessTokenFromSheetsKey();
      const r = await fetch(_LEGACY_GCP_KEY_URL, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${iamToken}` },
      });
      if (r.ok || r.status === 204) {
        gcpDetail = "GCP IAM accepted the key deletion.";
      } else if (r.status === 404) {
        gcpDetail = "GCP key was already absent at deletion time (404).";
      } else {
        const body = await r.text().catch(() => "");
        if (r.status === 403) {
          return {
            state: "blocked",
            detail:
              "GCP IAM denied deletion with 403 Forbidden. B-008 remains OPEN and " +
              "google_service_account_key was preserved for recovery. With owner/security " +
              "approval, prefer owner-admin deletion in Google Cloud Console → IAM & Admin → " +
              "Service Accounts → nobull-os@core-respect-369420 → Keys → delete key 43d3ab85…. " +
              "For automated retry, grant the Sheets service account a resource-scoped custom " +
              "role on that target service account containing only iam.serviceAccountKeys.delete " +
              "and iam.serviceAccountKeys.get. Do not grant key-create permission or the predefined " +
              "Service Account Key Admin role. Revoke the resource-scoped custom grant after the " +
              `lever verifies closure. Provider detail: ${body.slice(0, 300)}`,
          };
        }
        return {
          state: "error",
          detail:
            `GCP IAM deletion returned HTTP ${r.status}: ${body.slice(0, 300)}. ` +
            "Deletion was not verified, B-008 remains OPEN, and google_service_account_key " +
            "was preserved for recovery.",
        };
      }
    } catch (err: any) {
      return {
        state: "error",
        detail:
          `GCP IAM deletion could not be completed: ${err?.message ?? String(err)}. ` +
          "Deletion was not verified, B-008 remains OPEN, and google_service_account_key " +
          "was preserved for recovery.",
      };
    }

    // Step 3: prove the key is absent. A successful DELETE response is not
    // enough: timeout/proxy/provider ambiguity must never erase the recovery
    // setting or claim closure.
    try {
      const verify = await fetch(_LEGACY_GCP_KEY_URL, {
        headers: { Authorization: `Bearer ${iamToken}` },
      });
      if (verify.status !== 404) {
        const body = await verify.text().catch(() => "");
        return {
          state: verify.status === 403 ? "blocked" : "error",
          detail:
            `${gcpDetail} Follow-up IAM verification returned HTTP ${verify.status}${
              body ? `: ${body.slice(0, 300)}` : ""
            }. Key absence is unverified, B-008 remains OPEN, and ` +
            "google_service_account_key was preserved for recovery. Confirm the key is absent " +
            "in Google Cloud Console, or apply the resource-scoped IAM remediation and run this lever again.",
        };
      }
      gcpDetail += " Follow-up IAM GET verified 404 (key absent).";
    } catch (err: any) {
      return {
        state: "error",
        detail:
          `${gcpDetail} Follow-up IAM verification failed: ${err?.message ?? String(err)}. ` +
          "Key absence is ambiguous, B-008 remains OPEN, and google_service_account_key " +
          "was preserved for recovery.",
      };
    }

    // Step 4: clear and verify the DB setting only after IAM absence is proven.
    let dbDetail: string;
    try {
      await deleteSystemSetting("google_service_account_key");
    } catch (err: any) {
      const remaining = await getSystemSettingFresh("google_service_account_key").catch(
        () => undefined,
      );
      if (remaining?.value?.trim()) {
        return {
          state: "error",
          detail:
            `${gcpDetail} The IAM key is verified absent, but removing ` +
            `google_service_account_key failed: ${err?.message ?? String(err)}. ` +
            "B-008 is not reported closed until the stale setting is cleared.",
        };
      }
    }
    const remainingSetting = await getSystemSettingFresh(
      "google_service_account_key",
    ).catch(() => null);
    if (remainingSetting === null) {
      return {
        state: "error",
        detail:
          `${gcpDetail} DB setting verification failed after cleanup. ` +
          "The IAM key is absent, but B-008 closure remains unverified until the setting can be re-read.",
      };
    }
    if (remainingSetting?.value?.trim()) {
      return {
        state: "error",
        detail:
          `${gcpDetail} google_service_account_key still exists after the cleanup attempt. ` +
          "The IAM key is absent, but B-008 is not closed until the stale setting is cleared.",
      };
    }
    dbDetail = "google_service_account_key verified absent.";

    // Step 5: confirm Sheets lane still works after deletion.
    try {
      await getSheetsAccessToken();
    } catch (err: any) {
      return {
        state: "error",
        detail:
          `${gcpDetail} ${dbDetail} BUT Sheets lane verification FAILED after deletion: ` +
          `${err?.message ?? String(err)}. Investigate immediately — ` +
          "GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY may be missing or invalid.",
      };
    }

    return {
      state: "applied",
      detail:
        `${gcpDetail} ${dbDetail} Follow-up Sheets lane ` +
        "(GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY) verified working. B-008 fully closed.",
    };
  },
};

// ─── Inline PROD_ACTIONS entries hoisted to named consts (F7) ────────
// These were inline `killSwitchAction({...})` / object-literal entries in
// the monolithic PROD_ACTIONS array; hoisting is argument-verbatim so the
// composition root can reference them by name.

export const enableDbHoldRollupAction = killSwitchAction({
  id: "enable_db_hold_rollup",
  switchName: "db_hold_rollup_enabled",
  targetValue: true,
  title: "Enable DB hold attribution rollups",
  description:
    "Turns on the hourly rollup that populates db_hold_label_rollups so /admin/db-attribution/trends can show real data.",
});

export const enableExternalCallAuditAction = killSwitchAction({
  id: "enable_external_call_audit",
  switchName: "external_call_audit_enabled",
  targetValue: true,
  title: "Enable external-call audit",
  description:
    "Turns on hashes-only audit of outbound SEMrush / Front / Zoom / OpenAI / Twilio / Google calls so noisy endpoints are visible on the attribution dashboard.",
});

export const enableDbPoolTenancyEnforcementAction = killSwitchAction({
  id: "enable_db_pool_tenancy_enforcement",
  switchName: "db_pool_tenancy_enforcement_enabled",
  targetValue: true,
  title: "Enable DB pool tenancy enforcement",
  description:
    "Pool Epic Phase 4 — turns on the runtime enforcement of the documented `api` / `worker` / `probe` pool tenancy rules. The lint guard (`lint-db-pool-tenancy`) already prevents new violations; this switch promotes runtime violations from a structured warning to a refused acquire.",
});

export const enableRedisCacheGloballyAction = killSwitchAction({
  id: "enable_redis_cache_globally",
  switchName: "redis_cache_enabled",
  targetValue: true,
  title: "Enable Redis cache (global)",
  description:
    "DB Scale Layer epic Phase 1 — flips the global Redis read-through cache ON. Requires UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN env vars; without them the cache silently bypasses and the flip is a no-op. Phase 1 ships the foundation only — no routes are cached yet, so flipping ON has zero behavioural impact until Phase 2 wires call sites. Fail-open: a Redis outage never breaks core flows.",
});

export const enableProdActionSelfHealAction = systemSettingAction({
  id: "enable_prod_action_self_heal",
  key: "prod_action_self_heal_enabled",
  targetValue: "true",
  title: "Enable maintenance prod-action self-heal",
  description:
    "Task #2086 — turns ON the worker-pool scheduler that automatically applies every idempotent, recurring maintenance prod-action that opts in via `ProdAction.selfHeal` (the current enrolled set is listed in PROD_ACTION_SELF_HEAL.md) on each action's own cadence/backoff, so they no longer have to be applied by hand. Each underlying action is the same idempotent apply the panel calls, so flipping ON can never do anything an operator could not already do manually. Default OFF (behaviour-neutral). The scheduler also honors the `prod_action_self_heal` queue-drain pause and KILL_SWITCH_NON_CRITICAL_SWEEPS. See PROD_ACTION_SELF_HEAL.md.",
});

export const enableProdActionSelfHealFailureAlertAction = systemSettingAction({
  id: "enable_prod_action_self_heal_failure_alert",
  key: "prod_action_self_heal_failure_alert_enabled",
  targetValue: "true",
  title: "Enable self-heal persistent-failure alert",
  description:
    "Task #2154 — turns ON the persistent-failure alert for the maintenance prod-action self-healer (Task #2096). Once ON, the self-heal tick pages the responsible admins (CEO / team-lead) via `notifyUser()` when one self-heal action records `prod_action_self_heal_failure_alert_threshold` consecutive `error` outcomes (default 3), de-duped until that action succeeds again. With it OFF the consecutive-failure streak is still tracked, so the alert works the moment it is turned on, but no notification is sent. Default OFF (behaviour-neutral). See PROD_ACTION_SELF_HEAL.md.",
});

export const enableProdActionSelfHealReconnectAlertAction = systemSettingAction({
  id: "enable_prod_action_self_heal_reconnect_alert",
  key: "prod_action_self_heal_reconnect_alert_enabled",
  targetValue: "true",
  title: "Enable self-heal reconnect-required alert",
  description:
    "Task #2201 — turns ON the reconnect-required (auth-dead) alert for the maintenance prod-action self-healer (Task #2124). Once ON, the self-heal tick pages the responsible admins (CEO / team-lead) via `notifyUser()` the first time a self-heal action records a `blocked` outcome that NAMES the integration to re-link — de-duped until a healthy run re-arms it (no consecutive-count threshold, unlike the persistent-failure alert). Blocked outcomes that name no integration are precondition wait-states (e.g. the Zoom legacy-retirement soak) and never page (Task #4840). With it OFF the `reconnectAlertSent` de-dupe flag is still tracked, so the alert works the moment it is turned on, but no notification is sent. Default OFF (behaviour-neutral). See PROD_ACTION_SELF_HEAL.md.",
});

export const enableFeedbackSlackRetryAction = systemSettingAction({
  id: "enable_feedback_slack_retry",
  key: "feedback_slack_retry_enabled",
  targetValue: "true",
  title: "Enable feedback → Slack auto-resend + give-up",
  description:
    "Task #2207 — turns ON the worker-pool scheduler that re-drives un-delivered in-app feedback through Slack once it reconnects (Task #2066) and, past the give-up thresholds, marks a row terminally `undeliverable` and escalates to the responsible admins (Task #2131). The give-up thresholds keep their sane defaults (`feedback_slack_retry_max_attempts` = 10, `feedback_slack_retry_max_stuck_hours` = 48h); this action only flips the `feedback_slack_retry_enabled` master switch so the loop can be enabled without hand-editing `system_settings`. Each tick is bounded (`feedback_slack_retry_max_per_tick`, backoff `feedback_slack_retry_backoff_minutes`) and honors the `feedback_slack_retry` queue-drain pause. Default OFF (behaviour-neutral). See WORKERS_QUEUES_RUNBOOK.md § Feedback → Slack auto-resend.",
});

export const enableOrphanedUserHealAction = systemSettingAction({
  id: "enable_orphaned_user_heal",
  key: "orphaned_user_heal_enabled",
  targetValue: "true",
  title: "Enable orphaned-user profile-row auto-heal (RETIRED — inert)",
  description:
    "RETIRED by Task #4554 (closed admission): the heal tick now short-circuits unconditionally — before this enable switch is even consulted — and never scans sessions or creates `users` rows, because rows are created only via admin approval (POST /api/users) and re-upserting a session-with-no-row would resurrect exactly the auto-provisioned accounts the allowlist keeps out. Pressing this only flips the now-inert `orphaned_user_heal_enabled` switch (its sole remaining effect is allowing no-op jobs to be enqueued); the last-run readout will show the retirement reason. Kept for status-surface coherence. Historical behaviour (Tasks #2203/#2244): scanned live sessions for subs missing a `users` row and re-upserted profiles from passport claims. See WORKERS_QUEUES_RUNBOOK.md § Orphaned-user profile-row heal.",
});

export const enableAdsOsPacingRefreshAction = systemSettingAction({
  id: "enable_ads_os_pacing_refresh",
  key: "ads_os_pacing_refresh_enabled",
  targetValue: "true",
  title: "Enable Ads OS morning refresh — pacing + account alerts (~6am ET)",
  description:
    "Task #3612 — turns ON the Ads OS (rebuild) morning refresh scheduler (Phases 2+6, `morningPacingScheduler.ts`): a deployment-gated cross-instance singleton that, once per day after 6am ET, re-runs GAds + LSA budget pacing for every ENROLLED account (including Off) and persists each summary, then recomputes every account's alerts — the dashboards' ⚠ badges and the \"Need attention\" tile read that store, so until this is ON they only refresh when someone presses Refresh (Task #3685) — reconciles open ClickUp alert tickets, and sends the only-on-change Slack digest of NEW critical/high alerts. Heads-up: the FIRST enabled run has no notified-fingerprint baseline, so it sends one initial catch-up digest listing every current critical/high alert; later mornings stay quiet unless something changes. Same code path as POST /api/ads-os/cron/refresh-pacing. The setting is re-checked live at every 15-min tick, so this takes effect without a restart; `ads_os_pacing_refresh_last_run_date` records each completed run. Default OFF (behaviour-neutral until pressed). See ADS_OS.md § Morning refresh scheduler.",
});

export const enableTableRetentionPrunerAction = systemSettingAction({
  id: "enable_table_retention_pruner",
  key: "table_retention_pruner_enabled",
  targetValue: "true",
  title: "Enable table-retention pruner",
  description:
    "Task #3814 — turns on the hourly pruner for the high-churn operational tables in the table-maintenance policy: work_queue completed/cancelled (7d) and failed/dead_letter (30d), source_event_log terminal rows (90d, cascades to work_result_log + apply_state), call_analysis_jobs complete/failed (90d), expired mcu_cache rows, table_size_samples (180d). Windows tunable via the per-table `*_retention_days` system settings. Batched DELETEs (LIMIT 2000) on the `worker` pool; also gated by the global `non_critical_sweeps` kill switch.",
});

export const enableTableSizeWatchdogAction = systemSettingAction({
  id: "enable_table_size_watchdog",
  key: "table_size_watchdog_enabled",
  targetValue: "true",
  title: "Enable table-size watchdog",
  description:
    "Task #3814 — turns on the 6-hourly sampler that records per-table size trends (admin health dashboard → DB Server Metrics → Size Trend) and alerts when any covered table grows past its expected size band (bands tunable via `table_size_watchdog_bands_mb` JSON). Runs under a cross-instance singleton lock; also gated by the global `non_critical_sweeps` kill switch.",
});

// ─── Purge swept-in PII screenshots from git history (Task #4776) ───
//
// The platform's pre-merge auto-commit swept two browser screenshots
// showing staff names/emails/photos into main's history (commit
// d75aab30, "Git commit prior to merge"). The Task #4776 completion
// review classified that as a data-exposure blocker whose only fix is a
// history rewrite — an operation a task environment must never perform
// (force-rewriting main mid-pipeline corrupts merges). This lever is the
// operator-owned form of that purge; all mechanics live in
// server/services/gitPiiPurge.ts (env guards, bounded filter-branch,
// reflog expiry + gc, disk deletion, blob-level verification).
export const purgeSweptPiiScreenshotsAction: ProdAction = {
  id: "purge_swept_pii_screenshots",
  title: "Purge swept-in PII screenshots from git history",
  description:
    "Task #4776 — the platform's pre-merge auto-commits swept four browser screenshots " +
    "showing staff names, email addresses, and profile photos into the repository " +
    "history (attached_assets/Screenshot_2026-08-14_at_9.23.36/9.25.34/11.10.42/11.13.32_AM_….png, " +
    "two separate sweeps). " +
    "The PII exposure remains OPEN until this lever has been fired and its " +
    "verification passes. It rewrites the two paths out of EVERY local branch and tag " +
    "(bounded git filter-branch from the sweep commit), expires reflogs, " +
    "garbage-collects the blobs, deletes any on-disk copies, then verifies the hard " +
    "conditions — path unreachability from EVERY ref and reflog (incl. stash), " +
    "blob-by-blob unreachability, AND disk absence (a retained disk copy, failed " +
    "delete, or any retaining ref/reflog keeps the remediation PENDING). Residual refs are handled by ownership: stale " +
    "remote-tracking caches (remote no longer configured) are deleted; refs backed by " +
    "a LIVE remote or platform are never touched — deleting the local copy would only " +
    "hide the exposure until the next fetch — so the outcome names them for " +
    "source-side purging and the lever stays visible. Fire it ONCE from the CEO panel " +
    "in the DEV WORKSPACE app: that workspace's repository is the authoritative " +
    "source task environments clone from, so a clean verification there IS the " +
    "authoritative purge. In the deployment it reports blocked with these same " +
    "instructions. Replit platform-side checkpoint snapshots live outside the " +
    "repository and are not touched.",
  change:
    "git filter-branch --index-filter 'git rm --cached' across all local branches/tags " +
    "over the sweep range; delete stale remote-tracking refs; reflog expire " +
    "--expire=now --all; gc --prune=now; delete on-disk copies. No database changes.",
  // Manual lever: an irreversible history rewrite must be a deliberate
  // individual press, never a side effect of a routine Apply-all.
  manualLever: true,
  convergence: { kind: "converging" },

  // Lever contract (Task #4762): status is ALWAYS synthetic not-needed —
  // the live environment + reachability facts ride in the detail.
  async status() {
    const probe = await probePiiPurgeState();
    if (probe.env === "deployment") {
      return {
        state: "not-needed",
        detail:
          "Manual lever — the deployment has no git repository, so the purge can neither " +
          "run nor be verified from here. Open the CEO panel in the dev-workspace app and " +
          "fire the lever there once.",
      };
    }
    if (probe.env === "no_repo") {
      return {
        state: "not-needed",
        detail:
          "Manual lever — no git repository found at the app root; fire the lever from the " +
          "dev-workspace app where the repository lives.",
      };
    }
    const still = probe.reachable.filter((r) => r.reachable);
    const onDisk = probe.onDisk.filter((d) => d.exists);
    if (still.length === 0 && onDisk.length === 0) {
      return {
        state: "not-needed",
        detail:
          "All PII screenshot paths are already unreachable from every ref in this " +
          "repository and verified absent from disk — the purge is complete here.",
      };
    }
    const retainers = [...new Set(still.flatMap((r) => r.retainedBy))].slice(0, 6);
    return {
      state: "not-needed",
      detail:
        `Manual lever — PII remediation still PENDING: ${still.length} of ` +
        `${PURGED_PII_PATHS.length} swept-in screenshot path(s) remain reachable in this ` +
        `repository's history${retainers.length > 0 ? ` (retained by: ${retainers.join(", ")})` : ""}` +
        `${onDisk.length > 0 ? ` and ${onDisk.length} still sit on disk` : ""}. ` +
        "Fire this lever once to rewrite them out of every local " +
        "branch/tag, prune the blobs, delete the disk copies, and verify both conditions.",
    };
  },

  async apply() {
    return applyPiiPurge();
  },

  // Retires the lever to History once the purge is VERIFIED in an
  // environment that can see the repository. Deployment/no-repo reads
  // never retire (fail toward visibility — unverified is not purged).
  async servedPurpose() {
    const probe = await probePiiPurgeState();
    if (probe.env !== "workspace") return { served: false };
    const still = probe.reachable.filter((r) => r.reachable);
    if (still.length > 0) return { served: false };
    // Disk absence is a HARD retirement condition alongside history: a
    // clean history with bytes still on disk is NOT a remediation.
    const onDisk = probe.onDisk.filter((d) => d.exists);
    if (onDisk.length > 0) return { served: false };
    return {
      served: true,
      note:
        "All swept-in PII screenshot paths are unreachable from every ref and reflog " +
        "(incl. stash) in this repository AND verified absent from disk " +
        "(for-each-ref enumeration + per-ref path scans + reflog catch-all + stat).",
    };
  },
};


// ─── Sync per-client Ads OS schedule_days from the authoritative JSON ────────
//
// Task #4818: brings every enrolled client's stored criteria in line with the
// schedule list in attached_assets/ads-os-schedules_*.json. Only touches
// `schedule_days` (Google Ads) and `lsa_schedule_days` (LSA); all other
// criteria fields are preserved verbatim (raw-doc patch — no toCriteria
// normalisation, no metadata loss). Clients with no stored criteria doc are
// skipped: a null from getCriteriaStrict means genuinely absent (not a DB
// error — the strict reader throws on failure, so null is unambiguous).
// Clients already matching their target are skipped (idempotent, converges to
// not-needed after a successful run).

export interface ScheduleSyncEntry {
  /** Normalized (digits-only) customer ID that keys the criteria store. */
  cid: string;
  /** Target Google Ads schedule_days ([] = every day). null = skip GAds. */
  gads: string[] | null;
  /** Target lsa_schedule_days ([] = every day). null = skip LSA. */
  lsa: string[] | null;
  /** Human label for detail strings. */
  client: string;
}

// Inlined from attached_assets/ads-os-schedules_1786957311876.json.
// Only entries where criteria_saved: true are listed; criteria_saved: false
// clients all have empty (every-day) schedules which are the default, so they
// are omitted — there is nothing to sync for them.
export const SCHEDULE_SYNC_TARGETS: ScheduleSyncEntry[] = [
  { cid: "6320038010", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: null, client: "Ackah Law" },
  { cid: "1818611005", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: null, client: "Andrew Thomas Law" },
  { cid: "5036860353", gads: ["Mon","Tue","Wed","Thu","Fri","Sun"], lsa: [], client: "April Jones Law" },
  { cid: "9590510207", gads: null, lsa: [], client: "Bledsoe Law" },
  { cid: "8010814496", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: [], client: "Burns Smith Law" },
  { cid: "6083427412", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: [], client: "Cambridge Law" },
  { cid: "2705737266", gads: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], lsa: [], client: "Cates & Reed Law" },
  { cid: "9446178488", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: ["Mon","Tue","Wed","Thu","Fri"], client: "Dellutri Law" },
  { cid: "4333959201", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: null, client: "Ebbert Law" },
  { cid: "1668823783", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: null, client: "Equal Justice Law" },
  { cid: "4428699921", gads: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], lsa: [], client: "Family First Law" },
  { cid: "3966261854", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: [], client: "Flanigan Law" },
  { cid: "3447889098", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: [], client: "Grace Law" },
  { cid: "2521864966", gads: ["Mon","Tue","Wed","Thu","Fri","Sat"], lsa: ["Mon","Tue","Wed","Thu","Fri","Sat"], client: "Haque Law" },
  { cid: "4309084652", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: null, client: "Integrity Law" },
  { cid: "3197485605", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: [], client: "Ivan Guerrero Law" },
  { cid: "7640290354", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: [], client: "Jarvis Law" },
  { cid: "8379375117", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: null, client: "Jurist Law" },
  { cid: "4225256139", gads: [], lsa: ["Mon","Tue","Wed","Thu","Fri"], client: "Krystina Tran Law" },
  { cid: "2146364898", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: [], client: "MJ Law" },
  { cid: "1142840199", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: ["Mon","Tue","Wed","Thu","Fri"], client: "O'Brien Law" },
  { cid: "6837251501", gads: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], lsa: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], client: "Paxton Law" },
  { cid: "5480315617", gads: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], lsa: ["Mon","Tue","Wed","Thu","Fri"], client: "Presti Law" },
  { cid: "4985087323", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: null, client: "ProVet Law" },
  { cid: "3084663670", gads: [], lsa: ["Mon","Tue","Wed","Thu","Fri"], client: "Sands Law" },
  { cid: "5637627539", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: [], client: "Shields & Boris Law" },
  { cid: "7591197086", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: [], client: "Syverson Law" },
  { cid: "4134818123", gads: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], lsa: null, client: "Wanta Thome Law" },
  { cid: "9142004511", gads: ["Mon","Tue","Wed","Thu","Fri"], lsa: null, client: "White & Jocham Law" },
];

function schedSorted(days: string[] | undefined): string {
  return [...(days ?? [])].sort().join(",");
}

/** Injectable types for testing without a real DB. */
export type ScheduleSyncReadFn = (cid: string) => Promise<Record<string, any> | null>;
export type ScheduleSyncWriteFn = (cid: string, data: Record<string, any>) => Promise<void>;

export type SchedulePatchResult =
  | { outcome: "updated" }
  | { outcome: "seeded" }
  | { outcome: "skipped-match" }
  | { outcome: "skipped-absent" };

/**
 * Apply the schedule patch for one entry.
 *
 * Uses a STRICT read (`read` must throw on DB failure — not return null).
 * Null from read = genuinely absent doc.
 *   - seedIfAbsent=false (default, used by status probe): returns skipped-absent, no write.
 *   - seedIfAbsent=true (used by apply): seeds a minimal doc containing only
 *     the schedule fields so the pacing engine gets the correct schedule even
 *     before the operator saves full criteria (Task #4827).
 * Patches only schedule fields in the RAW stored doc (spread-preserve all
 * other keys including metadata like updated_at and any legacy fields).
 * Exported so tests can inject stub read/write without a real DB.
 */
export async function patchClientSchedule(
  entry: ScheduleSyncEntry,
  read: ScheduleSyncReadFn,
  write: ScheduleSyncWriteFn,
  seedIfAbsent = false,
): Promise<SchedulePatchResult> {
  const rawDoc = await read(entry.cid); // strict: throws on DB error, null = absent
  if (rawDoc === null) {
    if (!seedIfAbsent) return { outcome: "skipped-absent" };
    // Seed a minimal criteria doc (schedule fields only) so the pacing engine
    // gets the correct schedule_days / lsa_schedule_days rather than treating
    // every day as a run day. Non-schedule fields are intentionally absent from
    // this seed; a later "Edit criteria" save will add them without clobbering
    // the seeded schedule (the edit UI merges into the stored doc).
    const seedDoc: Record<string, any> = { updated_at: new Date().toISOString() };
    if (entry.gads !== null) seedDoc.schedule_days = entry.gads;
    if (entry.lsa !== null) seedDoc.lsa_schedule_days = entry.lsa;
    await write(entry.cid, seedDoc);
    return { outcome: "seeded" };
  }

  const changed =
    (entry.gads !== null && schedSorted(rawDoc.schedule_days) !== schedSorted(entry.gads)) ||
    (entry.lsa !== null && schedSorted(rawDoc.lsa_schedule_days) !== schedSorted(entry.lsa));
  if (!changed) return { outcome: "skipped-match" };

  // Spread the raw doc first — preserves ALL stored fields (including
  // updated_at, unknown/legacy keys, store metadata). Only schedule fields
  // are overwritten.
  const next: Record<string, any> = { ...rawDoc, updated_at: new Date().toISOString() };
  if (entry.gads !== null) next.schedule_days = entry.gads;
  if (entry.lsa !== null) next.lsa_schedule_days = entry.lsa;
  await write(entry.cid, next);
  return { outcome: "updated" };
}

export const syncAdsOsClientSchedulesAction: ProdAction = {
  id: "ads-os-sync-client-schedules",
  convergence: { kind: "converging" },
  humanGate: {
    reason:
      "This one-shot sync can overwrite deliberate edits to live ad-pacing schedules made after " +
      "the authoritative list was compiled — review the pending schedule diff before applying. " +
      "It is never auto-run.",
  },
  title: "Sync Ads OS client schedules from authoritative list",
  description:
    "Updates `schedule_days` (Google Ads) and `lsa_schedule_days` (LSA) in the per-client " +
    "criteria store to match the authoritative schedule list (Task #4818). Only these two fields " +
    "are touched; all other criteria (keywords, service area, metadata) are preserved verbatim " +
    "via a raw-doc patch (no normalisation, no field loss). " +
    "Clients with no stored criteria doc are skipped. " +
    "Converges: once all stored schedules match the target list the action reports not-needed.",
  change:
    "Reads each listed client's raw criteria doc via a STRICT store read (throws on DB " +
    "failure, returns null only for a genuinely absent doc), patches `schedule_days` / " +
    "`lsa_schedule_days` where they differ, and re-saves the patched raw doc via the strict " +
    "criteria put path.",

  async status() {
    const diffClients: string[] = [];
    const absentClients: string[] = [];
    const readErrors: string[] = [];
    await Promise.all(
      SCHEDULE_SYNC_TARGETS.map(async (entry) => {
        try {
          // seedIfAbsent=false: probe-only, no writes during status check.
          const result = await patchClientSchedule(entry, getCriteriaStrict, async () => {});
          if (result.outcome === "updated") diffClients.push(entry.client);
          else if (result.outcome === "skipped-absent") absentClients.push(entry.client);
        } catch {
          readErrors.push(entry.client);
        }
      }),
    );
    const total = diffClients.length + absentClients.length + readErrors.length;
    if (total === 0) {
      return {
        state: "not-needed",
        detail: `All ${SCHEDULE_SYNC_TARGETS.length} listed client schedules already match the authoritative list.`,
      };
    }
    const parts: string[] = [];
    if (diffClients.length > 0) {
      parts.push(
        `${diffClients.length} schedule(s) differ: ` +
        diffClients.slice(0, 6).join(", ") +
        (diffClients.length > 6 ? ` (+${diffClients.length - 6} more)` : ""),
      );
    }
    if (absentClients.length > 0) {
      // Absent clients are included in "pending" because apply() will seed them
      // (Task #4827). Surfacing them here lets operators know which clients
      // still have no criteria doc at all.
      parts.push(
        `${absentClients.length} client(s) have no stored criteria doc (will be seeded on Apply): ` +
        absentClients.slice(0, 4).join(", ") +
        (absentClients.length > 4 ? ` (+${absentClients.length - 4} more)` : ""),
      );
    }
    if (readErrors.length > 0) {
      parts.push(`${readErrors.length} store read error(s): ${readErrors.slice(0, 3).join(", ")}`);
    }
    return { state: "pending", detail: parts.join("; ") + ". Press Apply to sync." };
  },

  async apply(_actorId) {
    let updated = 0;
    let seeded = 0;
    let skippedMatch = 0;
    const errors: string[] = [];

    // Serial to avoid concurrent-write races between our own passes.
    for (const entry of SCHEDULE_SYNC_TARGETS) {
      try {
        // seedIfAbsent=true: absent docs get a minimal schedule-only seed so
        // the pacing engine gets the correct schedule_days (Task #4827).
        const result = await patchClientSchedule(entry, getCriteriaStrict, putCriteria, true);
        if (result.outcome === "updated") updated++;
        else if (result.outcome === "seeded") seeded++;
        else if (result.outcome === "skipped-match") skippedMatch++;
        // skipped-absent cannot occur when seedIfAbsent=true
      } catch (err: any) {
        errors.push(`${entry.client}: ${err?.message ?? String(err)}`);
      }
    }

    const writes = updated + seeded;
    if (errors.length > 0) {
      return {
        state: "error",
        detail:
          `Updated ${updated}, seeded ${seeded}, skipped ${skippedMatch} matching, ` +
          `but ${errors.length} failed: ${errors.slice(0, 3).join("; ")}`,
      };
    }
    if (writes === 0) {
      return {
        state: "not-needed",
        detail:
          `All ${SCHEDULE_SYNC_TARGETS.length} listed client schedules already match the authoritative list.`,
      };
    }
    const parts: string[] = [];
    if (updated > 0) parts.push(`updated schedule for ${updated} client(s)`);
    if (seeded > 0) parts.push(`seeded minimal criteria doc for ${seeded} previously-absent client(s)`);
    return {
      state: "applied",
      detail: parts.join("; ") + `; ${skippedMatch} already matched.`,
      rowsAffected: writes,
    };
  },
};

// ─── Reconcile Ads OS Practice Areas from canonical ClickUp parents ──────────
//
// One-shot rollout lever. ClickUp is the authority; the criteria-store field is
// only a local mirror. Every pass takes ONE forced-fresh directory snapshot
// before touching the local store, then walks a bounded, deterministic CID
// snapshot. The lever is deliberately absent from Apply all and every
// scheduler.

export const PRACTICE_AREA_RECONCILIATION_MAX_CIDS = 5_000;
export const PRACTICE_AREA_RECONCILIATION_MAX_SNAPSHOT_AGE_MS = 60_000;

export interface PracticeAreaReconciliationTarget {
  cid: string;
  parentTaskId: string;
  client: string;
  labels: string[];
}

export interface PracticeAreaReconciliationParentTarget {
  parentTaskId: string;
  client: string;
  cids: string[];
  labels: string[];
}

export interface PracticeAreaReconciliationDeps {
  loadDirectory(): Promise<DirectoryBundle>;
  listCriteriaCids(): Promise<string[]>;
  readCriteria(cid: string): Promise<Record<string, any> | null>;
  patchCriteria(
    cid: string,
    labels: string[],
    updatedAt: Date,
  ): Promise<PracticeAreaCriteriaPatchResult>;
  now(): Date;
}

export interface PracticeAreaReconciliationProbe {
  fetchedAt: number;
  parents: PracticeAreaReconciliationParentTarget[];
  targets: PracticeAreaReconciliationTarget[];
  matching: PracticeAreaReconciliationTarget[];
  mismatched: PracticeAreaReconciliationTarget[];
  missingNonEmpty: PracticeAreaReconciliationTarget[];
  missingEmpty: PracticeAreaReconciliationTarget[];
  unmappedCriteriaCids: string[];
  ambiguousCids: string[];
  unsafeCids: string[];
  readErrors: Array<{ cid: string; client: string; error: string }>;
}

class PracticeAreaSnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PracticeAreaSnapshotUnavailableError";
  }
}

function sameStringArray(left: unknown, right: string[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function describeCidList(cids: string[], max = 20): string {
  if (cids.length === 0) return "none";
  const visible = cids.slice(0, max).join(", ");
  return cids.length > max ? `${visible} (+${cids.length - max} more)` : visible;
}

function describeTargetList(
  targets: PracticeAreaReconciliationTarget[],
  max = 12,
): string {
  if (targets.length === 0) return "none";
  const visible = targets
    .slice(0, max)
    .map((target) => `${target.client} (${target.cid})`)
    .join(", ");
  return targets.length > max
    ? `${visible} (+${targets.length - max} more)`
    : visible;
}

/**
 * Convert the already-validated directory projection into one bounded,
 * parent-aware reconciliation target set. Ambiguous/structurally incomplete
 * CIDs are diagnosed and excluded; callers must block the whole write pass
 * whenever either list is non-empty.
 */
export function buildPracticeAreaReconciliationTargets(
  directory: DirectoryBundle,
  localCriteriaCids: string[],
  observedAtMs = Date.now(),
): Pick<
  PracticeAreaReconciliationProbe,
  | "parents"
  | "targets"
  | "unmappedCriteriaCids"
  | "ambiguousCids"
  | "unsafeCids"
> {
  if (
    directory.fetchedAt <= 0 ||
    observedAtMs - directory.fetchedAt >
      PRACTICE_AREA_RECONCILIATION_MAX_SNAPSHOT_AGE_MS ||
    directory.fetchedAt - observedAtMs > 5_000 ||
    directory.practiceAreaField === null ||
    directory.practiceAreaOptions.length === 0
  ) {
    throw new PracticeAreaSnapshotUnavailableError(
      "The ClickUp directory snapshot was stale, future-dated, or missing a validated Practice Area contract.",
    );
  }

  const optionLabels = new Set(
    directory.practiceAreaOptions.map((option) => option.label),
  );
  const mappingCids = new Set([
    ...Object.keys(directory.cidParentTaskIds),
    ...Object.keys(directory.cidPracticeAreas),
  ]);
  if (mappingCids.size > PRACTICE_AREA_RECONCILIATION_MAX_CIDS) {
    throw new PracticeAreaSnapshotUnavailableError(
      `ClickUp returned ${mappingCids.size} mapped CIDs, above the reconciliation safety bound of ${PRACTICE_AREA_RECONCILIATION_MAX_CIDS}.`,
    );
  }

  const targets: PracticeAreaReconciliationTarget[] = [];
  const ambiguousCids: string[] = [];
  const unsafeCids: string[] = [];
  const parentsById = new Map<string, PracticeAreaReconciliationParentTarget>();

  for (const cid of [...mappingCids].sort()) {
    const parentTaskIds = directory.cidParentTaskIds[cid] ?? [];
    if (parentTaskIds.length > 1) {
      ambiguousCids.push(cid);
      continue;
    }
    const labels = directory.cidPracticeAreas[cid];
    const clientKey = directory.cidClient[cid];
    const client = clientKey ? directory.clients[clientKey] : undefined;
    if (
      parentTaskIds.length !== 1 ||
      !Array.isArray(labels) ||
      !client ||
      labels.some(
        (label) => typeof label !== "string" || !optionLabels.has(label),
      )
    ) {
      unsafeCids.push(cid);
      continue;
    }

    const target: PracticeAreaReconciliationTarget = {
      cid,
      parentTaskId: parentTaskIds[0],
      client: client.name,
      labels: [...labels],
    };
    targets.push(target);

    const existingParent = parentsById.get(target.parentTaskId);
    if (!existingParent) {
      parentsById.set(target.parentTaskId, {
        parentTaskId: target.parentTaskId,
        client: target.client,
        cids: [target.cid],
        labels: [...target.labels],
      });
    } else if (
      existingParent.client !== target.client ||
      !sameStringArray(existingParent.labels, target.labels)
    ) {
      unsafeCids.push(target.cid);
    } else {
      existingParent.cids.push(target.cid);
    }
  }

  const unsafeSet = new Set(unsafeCids);
  const safeTargets = targets.filter((target) => !unsafeSet.has(target.cid));
  const safeTargetCids = new Set(safeTargets.map((target) => target.cid));
  const ambiguousSet = new Set(ambiguousCids);
  const unmappedCriteriaCids = [...new Set(localCriteriaCids)]
    .filter((cid) => !safeTargetCids.has(cid) && !ambiguousSet.has(cid))
    .sort();

  const parents = [...parentsById.values()]
    .map((parent) => ({
      ...parent,
      cids: parent.cids
        .filter((cid) => !unsafeSet.has(cid))
        .sort(),
    }))
    .filter((parent) => parent.cids.length > 0)
    .sort((a, b) => a.client.localeCompare(b.client));

  return {
    parents,
    targets: safeTargets,
    unmappedCriteriaCids,
    ambiguousCids: [...new Set(ambiguousCids)].sort(),
    unsafeCids: [...unsafeSet].sort(),
  };
}

/**
 * Take one fresh ClickUp snapshot and compare it with the bounded local
 * criteria-store key set. Per-CID strict read failures are retained as
 * diagnostics instead of being confused with absent documents.
 */
export async function probePracticeAreaReconciliation(
  deps: PracticeAreaReconciliationDeps,
): Promise<PracticeAreaReconciliationProbe> {
  let directory: DirectoryBundle;
  try {
    directory = await deps.loadDirectory();
  } catch (error: any) {
    throw new PracticeAreaSnapshotUnavailableError(
      error?.message ?? String(error),
    );
  }

  const localCriteriaCids = await deps.listCriteriaCids();
  if (localCriteriaCids.length > PRACTICE_AREA_RECONCILIATION_MAX_CIDS) {
    throw new Error(
      `Criteria store exceeds the reconciliation safety bound of ${PRACTICE_AREA_RECONCILIATION_MAX_CIDS} documents.`,
    );
  }
  const built = buildPracticeAreaReconciliationTargets(
    directory,
    localCriteriaCids,
    deps.now().getTime(),
  );
  const matching: PracticeAreaReconciliationTarget[] = [];
  const mismatched: PracticeAreaReconciliationTarget[] = [];
  const missingNonEmpty: PracticeAreaReconciliationTarget[] = [];
  const missingEmpty: PracticeAreaReconciliationTarget[] = [];
  const readErrors: Array<{ cid: string; client: string; error: string }> = [];

  // Serial by design: this is an operator-triggered bounded probe, and serial
  // reads keep it from becoming a second fleet workload fan-out.
  for (const target of built.targets) {
    try {
      const rawDoc = await deps.readCriteria(target.cid);
      if (rawDoc === null) {
        if (target.labels.length > 0) missingNonEmpty.push(target);
        else missingEmpty.push(target);
      } else if (sameStringArray(rawDoc.practice_areas, target.labels)) {
        matching.push(target);
      } else {
        mismatched.push(target);
      }
    } catch (error: any) {
      readErrors.push({
        cid: target.cid,
        client: target.client,
        error: error?.message ?? String(error),
      });
    }
  }

  return {
    fetchedAt: directory.fetchedAt,
    ...built,
    matching,
    mismatched,
    missingNonEmpty,
    missingEmpty,
    readErrors,
  };
}

function formatPracticeAreaProbe(probe: PracticeAreaReconciliationProbe): string {
  const parts = [
    `ClickUp: fresh validated snapshot ${new Date(probe.fetchedAt).toISOString()} with ${probe.parents.length} live parent(s) / ${probe.targets.length} eligible CID(s)`,
    `criteria store: ${probe.matching.length} matching, ${probe.mismatched.length} mismatch(es), ${probe.missingNonEmpty.length + probe.missingEmpty.length} missing document(s), ${probe.unmappedCriteriaCids.length} unmapped stored account(s), ${probe.readErrors.length} read error(s)`,
  ];
  if (probe.mismatched.length > 0) {
    parts.push(`mismatches: ${describeTargetList(probe.mismatched)}`);
  }
  if (probe.missingNonEmpty.length > 0) {
    parts.push(
      `missing with non-empty authority (will seed): ${describeTargetList(probe.missingNonEmpty)}`,
    );
  }
  if (probe.missingEmpty.length > 0) {
    parts.push(
      `missing with empty authority (will remain absent): ${describeTargetList(probe.missingEmpty)}`,
    );
  }
  if (probe.unmappedCriteriaCids.length > 0) {
    parts.push(
      `unmapped stored CIDs (skipped, never cleared): ${describeCidList(probe.unmappedCriteriaCids)}`,
    );
  }
  if (probe.ambiguousCids.length > 0) {
    parts.push(
      `ambiguous ClickUp parent mappings (blocking): ${describeCidList(probe.ambiguousCids)}`,
    );
  }
  if (probe.unsafeCids.length > 0) {
    parts.push(
      `unsafe/incomplete ClickUp mappings (blocking): ${describeCidList(probe.unsafeCids)}`,
    );
  }
  if (probe.readErrors.length > 0) {
    parts.push(
      `criteria read failures: ${probe.readErrors
        .slice(0, 12)
        .map((failure) => `${failure.client} (${failure.cid}): ${failure.error}`)
        .join("; ")}${probe.readErrors.length > 12 ? ` (+${probe.readErrors.length - 12} more)` : ""}`,
    );
  }
  return `${parts.join(". ")}.`;
}

function practiceAreaSnapshotBlockedDetail(error: unknown): string {
  const health = directoryHealth();
  const reason =
    error instanceof Error ? error.message : String(error);
  const healthReason = health.reason && health.reason !== reason
    ? ` Directory health: ${health.reason}`
    : "";
  return (
    `Practice Area reconciliation blocked: a forced-fresh validated ClickUp snapshot was unavailable (${reason}).` +
    `${healthReason} No criteria were changed.`
  );
}

const DEFAULT_PRACTICE_AREA_RECONCILIATION_DEPS: PracticeAreaReconciliationDeps = {
  loadDirectory: () =>
    getClientDirectory({ force: true, throwOnError: true }),
  listCriteriaCids: () =>
    listCriteriaKeysStrict(PRACTICE_AREA_RECONCILIATION_MAX_CIDS),
  readCriteria: getCriteriaStrict,
  patchCriteria: patchCriteriaPracticeAreasStrict,
  now: () => new Date(),
};

let _practiceAreaReconciliationDeps =
  DEFAULT_PRACTICE_AREA_RECONCILIATION_DEPS;

/** Test-only seam used to keep registry-wide route tests free of vendor egress. */
export function __setPracticeAreaReconciliationDepsForTest(
  deps: PracticeAreaReconciliationDeps | null,
): void {
  _practiceAreaReconciliationDeps =
    deps ?? DEFAULT_PRACTICE_AREA_RECONCILIATION_DEPS;
}
registerModuleStateResetForTest(
  "platformOpsActions.practiceAreaReconciliationDeps",
  () => __setPracticeAreaReconciliationDepsForTest(null),
);

function createPracticeAreaReconciliationAction(
  getDeps: () => PracticeAreaReconciliationDeps,
): ProdAction {
  return {
    id: "ads-os-reconcile-practice-areas",
    convergence: { kind: "converging" },
    manualLever: true,
    title: "Ads OS: reconcile stored Practice Areas from ClickUp",
    description:
      "One-shot fleet reconciliation of the criteria-store Practice Areas mirror from one forced-fresh canonical ClickUp Client List snapshot. The live detail reports mismatches, missing documents, unmapped stored accounts, ClickUp health, and criteria-store read failures without creating a Pending action. It is never included in Apply all or any scheduler.",
    change:
      "For every safely mapped Google Ads/LSA CID, strictly reads the raw criteria document and changes only `practice_areas` plus `updated_at`; preserves every unrelated/unknown JSON key; seeds an absent document only when ClickUp's canonical selection is non-empty.",

    async status() {
      try {
        const probe = await probePracticeAreaReconciliation(getDeps());
        const detail = formatPracticeAreaProbe(probe);
        if (probe.ambiguousCids.length > 0 || probe.unsafeCids.length > 0) {
          return { state: "blocked", detail };
        }
        if (probe.readErrors.length > 0) {
          return { state: "error", detail };
        }
        // Manual-lever availability is not pending work. Drift is carried in
        // the live detail while the dedicated button remains the only drain.
        return { state: "not-needed", detail };
      } catch (error) {
        if (error instanceof PracticeAreaSnapshotUnavailableError) {
          return {
            state: "blocked",
            detail: practiceAreaSnapshotBlockedDetail(error),
          };
        }
        return {
          state: "error",
          detail: `Practice Area criteria-store probe failed: ${
            error instanceof Error ? error.message : String(error)
          }. No criteria were changed.`,
        };
      }
    },

    async apply() {
      let probe: PracticeAreaReconciliationProbe;
      try {
        probe = await probePracticeAreaReconciliation(getDeps());
      } catch (error) {
        if (error instanceof PracticeAreaSnapshotUnavailableError) {
          return {
            state: "blocked",
            detail: practiceAreaSnapshotBlockedDetail(error),
          };
        }
        return {
          state: "error",
          detail: `Practice Area reconciliation could not read the criteria store: ${
            error instanceof Error ? error.message : String(error)
          }. No criteria were changed.`,
        };
      }

      if (probe.ambiguousCids.length > 0 || probe.unsafeCids.length > 0) {
        return {
          state: "blocked",
          detail:
            `${formatPracticeAreaProbe(probe)} Unsafe ClickUp mappings block the entire write pass; fix the directory and retry. No criteria were changed.`,
        };
      }

      const deps = getDeps();
      const candidates = [
        ...probe.mismatched,
        ...probe.missingNonEmpty,
      ];
      let updated = 0;
      let seeded = 0;
      let skippedConcurrent = 0;
      const writeErrors: Array<{ target: PracticeAreaReconciliationTarget; error: string }> = [];
      const appliedAt = deps.now();

      // Serial and per-CID isolated: one failed local write never rolls back or
      // prevents the remaining independent CIDs from converging.
      for (const target of candidates) {
        try {
          const result = await deps.patchCriteria(
            target.cid,
            target.labels,
            appliedAt,
          );
          if (result === "updated") updated++;
          else if (result === "seeded") seeded++;
          else skippedConcurrent++;
        } catch (error: any) {
          writeErrors.push({
            target,
            error: error?.message ?? String(error),
          });
        }
      }

      const failures = [
        ...probe.readErrors.map(
          (failure) =>
            `${failure.client} (${failure.cid}) read failed: ${failure.error}`,
        ),
        ...writeErrors.map(
          (failure) =>
            `${failure.target.client} (${failure.target.cid}) write failed: ${failure.error}`,
        ),
      ];
      const base =
        `Fresh ClickUp snapshot ${new Date(probe.fetchedAt).toISOString()}: ` +
        `updated ${updated}, seeded ${seeded}, already matching ${probe.matching.length}, ` +
        `skipped ${skippedConcurrent} concurrently converged/removed document(s), ` +
        `left ${probe.missingEmpty.length} absent document(s) with an authoritative empty selection, ` +
        `skipped ${probe.unmappedCriteriaCids.length} unmapped stored account(s).`;
      if (failures.length > 0) {
        return {
          state: "error",
          detail:
            `${base} ${failures.length} per-CID failure(s) remain retryable: ` +
            failures.slice(0, 12).join("; ") +
            (failures.length > 12 ? ` (+${failures.length - 12} more)` : ""),
        };
      }
      const writes = updated + seeded;
      return writes > 0
        ? {
            state: "applied",
            detail: `${base} Rerun is idempotent.`,
            rowsAffected: writes,
          }
        : {
            state: "not-needed",
            detail: `${base} Every eligible stored document already matches.`,
          };
    },

    async servedPurpose() {
      try {
        // Retirement always owns an independent forced-fresh snapshot. Never
        // reuse status() data across requests or retire on a stale handoff.
        const probe = await probePracticeAreaReconciliation(getDeps());
        const served =
          probe.targets.length > 0 &&
          probe.mismatched.length === 0 &&
          probe.missingNonEmpty.length === 0 &&
          probe.ambiguousCids.length === 0 &&
          probe.unsafeCids.length === 0 &&
          probe.readErrors.length === 0;
        return served
          ? {
              served: true,
              note:
                `Fresh ClickUp snapshot verified ${probe.matching.length} stored criteria document(s) converged across ${probe.parents.length} parent client(s); ` +
                `${probe.missingEmpty.length} empty-selection document(s) correctly remain absent.`,
            }
          : { served: false };
      } catch {
        return { served: false };
      }
    },
  };
}

/** Injectable action factory for isolated/no-egress convergence tests. */
export function makePracticeAreaReconciliationAction(
  deps: PracticeAreaReconciliationDeps,
): ProdAction {
  return createPracticeAreaReconciliationAction(() => deps);
}

export const reconcileAdsOsPracticeAreasAction =
  createPracticeAreaReconciliationAction(
    () => _practiceAreaReconciliationDeps,
  );

// ─── Task #4839: Ads OS incomplete criteria status ───────────────────
//
// Operators have no in-app way to see which Ads OS clients still have
// seeded-minimal criteria docs (no business_name / service_area) without
// waiting for the next daily Slack alert (Task #4832). This action scans
// SCHEDULE_SYNC_TARGETS on demand and surfaces the complete sorted client
// list in the prod-actions admin panel. It has no automated remediation —
// operators must open the Edit Criteria panel for each listed client.
//
// Strict reads: uses getCriteriaStrict (throws on DB failure, null = genuinely
// absent) so store outages are recorded as readErrors and never silently
// treated as "doc absent / all complete". Any readErrors with no overdue
// clients block a clean not-needed result.
//
// Converging: transitions from pending → not-needed once every listed client
// has a criteria doc with a non-empty business_name or service_area. Apply()
// re-scans so operators can use it as a refresh after fixing clients.

/** Result of one incomplete-criteria scan pass (exported for unit tests). */
export interface IncompleteCriteriaScanResult {
  /** Client names from SCHEDULE_SYNC_TARGETS that are seeded-minimal + overdue, in target order. */
  overdueClients: string[];
  /** Client names where getCriteriaStrict threw (DB/store failure). */
  readErrors: string[];
}

/**
 * Scans SCHEDULE_SYNC_TARGETS in authoritative order using the supplied read
 * function. Callers should pass getCriteriaStrict so DB failures throw and land
 * in `readErrors` rather than being silently treated as absent docs.
 *
 * Exported so tests can inject a stub read function without touching the DB.
 */
export async function scanIncompleteCriteriaTargets(
  read: (cid: string) => Promise<Record<string, any> | null>,
  now: number,
): Promise<IncompleteCriteriaScanResult> {
  const overdueClients: string[] = [];
  const readErrors: string[] = [];
  // Serial: preserves SCHEDULE_SYNC_TARGETS authoritative (alphabetical) order.
  for (const entry of SCHEDULE_SYNC_TARGETS) {
    try {
      const rawDoc = await read(entry.cid);
      if (rawDoc === null) continue; // genuinely absent — not yet seeded, covered by sync action
      if (!isSeededMinimal(rawDoc)) continue; // operator has already filled it in
      if (!isOverdue(rawDoc, now)) continue; // within 7-day grace window
      overdueClients.push(entry.client);
    } catch {
      readErrors.push(entry.client);
    }
  }
  return { overdueClients, readErrors };
}

export const adsOsIncompleteCriteriaStatusAction: ProdAction = {
  id: "ads-os-incomplete-criteria-status",
  convergence: { kind: "converging" },
  // Drain path: pending clears only when operators fill in the missing
  // criteria fields via the Edit Criteria panel — the action itself is a
  // read-only re-scan and writes nothing, so no automatic press can drain it.
  humanGate: {
    reason:
      "Each listed client needs an operator to save business_name and/or service_area via the " +
      "Edit Criteria panel — this action only re-scans (read-only) and cannot fix the docs itself.",
  },
  title: "Ads OS: incomplete criteria status",
  description:
    "Scans all Ads OS schedule-sync target clients (SCHEDULE_SYNC_TARGETS) and lists any whose " +
    "stored criteria doc is still seeded-minimal (no business_name and no service_area) and " +
    "older than 7 days. These docs were created by the schedule-sync action (Task #4827) and " +
    "need an operator to fill in the missing fields via the Edit Criteria panel before the " +
    "pacing engine can use full client context. No automated fix is applied — this action is a " +
    "self-serve status check that mirrors the daily Slack alert (Task #4832) so operators can " +
    "audit the list without waiting for the next notification. Uses strict reads " +
    "(getCriteriaStrict) so a store outage is surfaced as an error rather than silently " +
    "reported as all-complete. The action converges to not-needed once every listed client has " +
    "at least one of business_name or service_area saved. Clients with no criteria doc at all " +
    "(not yet seeded) are not counted — they appear as absent in the schedule-sync action.",
  change:
    "Read-only scan of the per-client criteria store (getCriteriaStrict) — no data is written.",

  async status() {
    const { overdueClients, readErrors } = await scanIncompleteCriteriaTargets(
      getCriteriaStrict,
      Date.now(),
    );

    // Any read failure with no confirmed overdue clients means we cannot report clean.
    if (readErrors.length > 0 && overdueClients.length === 0) {
      return {
        state: "error",
        detail:
          `Store read failed for ${readErrors.length} client(s): ${readErrors.join(", ")}. ` +
          `Cannot confirm whether criteria are complete — retry once the store is healthy.`,
      };
    }

    if (overdueClients.length === 0) {
      return {
        state: "not-needed",
        detail:
          `All ${SCHEDULE_SYNC_TARGETS.length} listed clients have complete criteria ` +
          `(or are within the 7-day grace window).`,
      };
    }

    const parts: string[] = [
      `${overdueClients.length} client(s) have seeded-minimal criteria older than 7 days: ` +
      overdueClients.join(", "),
    ];
    if (readErrors.length > 0) {
      // Overdue clients found AND some reads failed — surface both.
      parts.push(
        `${readErrors.length} additional client(s) could not be read (store error): ${readErrors.join(", ")}`,
      );
    }
    return {
      state: "pending",
      detail:
        parts.join("; ") +
        ". Open the Edit Criteria panel for each client listed and save business_name and service_area.",
    };
  },

  async apply() {
    // Re-scan on press so the operator gets a refreshed picture after fixing
    // one or more clients. No data is written — confirms the scan ran.
    const { overdueClients, readErrors } = await scanIncompleteCriteriaTargets(
      getCriteriaStrict,
      Date.now(),
    );

    // Cannot confirm clean if reads failed and nothing was confirmed overdue.
    if (readErrors.length > 0 && overdueClients.length === 0) {
      return {
        state: "error",
        detail:
          `Store read failed for ${readErrors.length} client(s): ${readErrors.join(", ")}. ` +
          `Cannot confirm whether criteria are complete — retry once the store is healthy.`,
      };
    }

    if (overdueClients.length === 0) {
      return {
        state: "not-needed",
        detail:
          `All ${SCHEDULE_SYNC_TARGETS.length} listed clients have complete criteria ` +
          `(or are within the 7-day grace window).` +
          (readErrors.length > 0
            ? ` Note: ${readErrors.length} client(s) could not be read (store error): ${readErrors.join(", ")}.`
            : ""),
      };
    }

    const parts: string[] = [
      `Scan complete — ${overdueClients.length} client(s) still have seeded-minimal criteria ` +
      `older than 7 days: ${overdueClients.join(", ")}`,
    ];
    if (readErrors.length > 0) {
      parts.push(
        `${readErrors.length} additional client(s) could not be read (store error): ${readErrors.join(", ")}`,
      );
    }
    return {
      state: "applied",
      detail:
        parts.join("; ") +
        ". Open the Edit Criteria panel for each client listed and save business_name and service_area. No data was written by this action.",
    };
  },
};

/**
 * created_by_user_id has been stamped at write time since the Internal
 * Usage tracker launched on 2026-08-03 (Task #3721). This backfill repairs
 * strictly PRE-launch history; the eligibility boundary is the first UTC
 * midnight after launch day. A NULL sender on a row created at/after this
 * cutoff is a NEW write-path defect — it must stay visible for
 * investigation and must never be stamped from coincidental activity
 * evidence (that would silently mask the regression). Exported so the
 * backfill suite anchors its fixtures on the real boundary.
 */
export const AGENT_CHAT_SENDER_TRACKING_LIVE_SINCE = "2026-08-04T00:00:00Z";

const AGENT_CHAT_SENDER_EVIDENCE_CTES = sql`
  nullchats AS (
    SELECT id, client_id, created_at
    FROM client_agent_chats
    WHERE role = 'user' AND created_by_user_id IS NULL
      AND created_at < ${AGENT_CHAT_SENDER_TRACKING_LIVE_SINCE}::timestamptz
  ),
  surface_rows AS (
    SELECT nc.id AS chat_id,
           nc.created_at AS chat_created_at,
           l.user_id, l.session_id, l.timestamp, l.action_type, l.duration
    FROM nullchats nc
    JOIN user_activity_logs l
      ON l.user_id IS NOT NULL
     AND (l.route = '/clients/' || nc.client_id
          OR l.route LIKE '/clients/' || nc.client_id || '/%'
          OR l.route LIKE '/clients/' || nc.client_id || '?%')
     AND l.timestamp BETWEEN nc.created_at - interval '60 minutes'
                         AND nc.created_at + interval '60 minutes'
    WHERE nc.created_at IS NOT NULL
  ),
  straddle AS (
    SELECT chat_id, user_id
    FROM surface_rows
    GROUP BY chat_id, chat_created_at, user_id, session_id
    HAVING bool_or(timestamp <= chat_created_at)
       AND bool_or(timestamp >= chat_created_at)
  ),
  containment AS (
    SELECT chat_id, user_id
    FROM surface_rows
    WHERE action_type = 'page_view'
      AND duration IS NOT NULL
      AND duration BETWEEN 1 AND 43200
      AND timestamp >= chat_created_at
      AND timestamp - make_interval(secs => duration) <= chat_created_at
    GROUP BY chat_id, user_id
  ),
  candidates AS (
    SELECT chat_id, user_id FROM straddle
    UNION
    SELECT chat_id, user_id FROM containment
  ),
  verdicts AS (
    SELECT chat_id,
           COUNT(DISTINCT user_id)::int AS candidate_count,
           MIN(user_id) AS sole_candidate
    FROM candidates
    GROUP BY chat_id
  ),
  stampable AS (
    SELECT v.chat_id, v.sole_candidate AS user_id
    FROM verdicts v
    JOIN users u ON u.id = v.sole_candidate AND u.deleted_at IS NULL
    WHERE v.candidate_count = 1
  )
`;
export const backfillAgentChatSendersFromActivityAction: ProdAction = {
  id: "backfill_agent_chat_senders_from_activity",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Evidence-based attribution backfill — rewriting who is credited with historical client communications is an operator-reviewed data fix, never auto-fired.",
  },
  title: "Attribute historical agent-chat senders from activity-log evidence",
  description:
    "Task #4872. User-role client_agent_chats rows written before the usage tracker launched (2026-08-03) have created_by_user_id = NULL and appear only in the per-client historical bucket on /admin/internal-usage. This action stamps a sender ONLY when user_activity_logs evidence identifies exactly one plausible sender for the row: the same user's activity on that client's surface (/clients/<id>) either straddles the chat timestamp within ±60 minutes, or a page_view dwell interval (leave-time minus recorded duration) contains it. Rows with zero evidence or two-plus plausible senders are never guessed — they stay in the historical bucket and are counted in the audit detail. Eligibility is strictly pre-launch: only rows created before 2026-08-04T00:00:00Z (the first UTC midnight after the tracker launch) are examined — senders have been stamped at write time since launch, so a NULL sender on any later row signals a write-path defect, which this action surfaces in its detail and never stamps. Stamps are CAS-guarded (only-if-still-NULL), restricted to live users rows, and applied in one atomic set-based UPDATE; a second press reports not-needed. Evidence erodes (user_activity_logs has 365-day retention), so run promptly. Verify afterwards against the prod replica: examined/stamped/ambiguous counts plus the stamped chat ids are in the run detail.",
  change:
    "UPDATE client_agent_chats SET created_by_user_id = <sole evidence candidate> FROM <±60min straddle/containment evidence over user_activity_logs, exactly one candidate, live users row> WHERE role = 'user' AND created_by_user_id IS NULL AND created_at < '2026-08-04T00:00:00Z' (pre-launch rows only)",
  async status() {
    try {
      const res = await withDbAttribution(
        "maintenance:prod-actions-agent-chat-sender-backfill-check",
        () => getDb().execute(sql`WITH ${AGENT_CHAT_SENDER_EVIDENCE_CTES} ${AGENT_CHAT_SENDER_STATS_SQL}`),
      );
      const stats = readAgentChatSenderStats(res.rows as any[]);
      if (stats.examined === 0) {
        return {
          state: "not-needed",
          detail:
            "No pre-launch user-role agent-chat rows have a NULL sender — historical attribution is complete." +
            describePostLaunchNulls(stats),
        };
      }
      if (stats.stampable === 0) {
        return {
          state: "not-needed",
          detail:
            `${stats.examined} pre-launch user-role chat row(s) have no sender, but none meet the evidence bar.` +
            describeAgentChatSenderResidual(stats) +
            describePostLaunchNulls(stats),
        };
      }
      return {
        state: "pending",
        detail:
          `${stats.stampable} of ${stats.examined} pre-launch NULL-sender user-role chat row(s) have exactly one evidence-backed sender and will be stamped.` +
          describeAgentChatSenderResidual(stats) +
          describePostLaunchNulls(stats),
      };
    } catch (err: any) {
      return {
        state: "error",
        detail: `Failed to probe agent-chat sender evidence: ${err?.message ?? String(err)}`,
      };
    }
  },
  async apply() {
    try {
      // Snapshot the audit counters first (examined/ambiguous/no-evidence
      // are not derivable from the UPDATE result), then stamp. The CAS
      // guard makes the tiny statement gap harmless: rows attributed in
      // between simply match 0 rows here and surface as conflicts.
      const statsRes = await withDbAttribution(
        "maintenance:prod-actions-agent-chat-sender-backfill-apply",
        () => getDb().execute(sql`WITH ${AGENT_CHAT_SENDER_EVIDENCE_CTES} ${AGENT_CHAT_SENDER_STATS_SQL}`),
      );
      const stats = readAgentChatSenderStats(statsRes.rows as any[]);
      if (stats.examined === 0) {
        return {
          state: "not-needed",
          detail:
            "No pre-launch user-role agent-chat rows have a NULL sender — historical attribution is complete." +
            describePostLaunchNulls(stats),
        };
      }
      const updateRes = await withDbAttribution(
        "maintenance:prod-actions-agent-chat-sender-backfill-apply",
        () =>
          getDb().execute(sql`
            WITH ${AGENT_CHAT_SENDER_EVIDENCE_CTES}
            UPDATE client_agent_chats cac
            SET created_by_user_id = s.user_id
            FROM stampable s
            WHERE cac.id = s.chat_id
              AND cac.role = 'user'
              AND cac.created_by_user_id IS NULL
              AND cac.created_at < ${AGENT_CHAT_SENDER_TRACKING_LIVE_SINCE}::timestamptz
            RETURNING cac.id, s.user_id
          `),
      );
      const stampedRows = (updateRes.rows as any[]) ?? [];
      const stamped = stampedRows.length;
      const conflicts = Math.max(0, stats.stampable - stamped);
      const stampedIds = stampedRows
        .slice(0, 20)
        .map((r) => String(r.id))
        .join(", ");
      const detailParts = [
        `Examined ${stats.examined} pre-launch NULL-sender user-role chat row(s); stamped ${stamped} with an evidence-backed sender.`,
      ];
      if (stamped > 0) {
        detailParts.push(
          `Stamped chat id(s): ${stampedIds}${stamped > 20 ? ` (+${stamped - 20} more)` : ""}.`,
        );
      }
      const residual = describeAgentChatSenderResidual(stats);
      if (residual) detailParts.push(residual.trim());
      const postLaunch = describePostLaunchNulls(stats);
      if (postLaunch) detailParts.push(postLaunch.trim());
      if (conflicts > 0) {
        detailParts.push(
          `${conflicts} row(s) were attributed concurrently between probe and stamp (CAS guard skipped them — the existing value wins).`,
        );
      }
      if (stamped === 0) {
        return {
          state: "not-needed",
          detail: detailParts.join(" "),
        };
      }
      return {
        state: "applied",
        detail: detailParts.join(" "),
        rowsAffected: stamped,
      };
    } catch (err: any) {
      return {
        state: "error",
        detail: `Agent-chat sender backfill failed: ${err?.message ?? String(err)}`,
      };
    }
  },
};

function readAgentChatSenderStats(rows: any[]): AgentChatSenderStats {
  const row = rows[0] ?? {};
  return {
    examined: Number(row.examined ?? 0),
    stampable: Number(row.stampable ?? 0),
    ambiguous: Number(row.ambiguous ?? 0),
    soleNotLive: Number(row.sole_not_live ?? 0),
    noEvidence: Number(row.no_evidence ?? 0),
    postLaunchNulls: Number(row.post_launch_nulls ?? 0),
  };
}

type AgentChatSenderStats = {
  examined: number;
  stampable: number;
  ambiguous: number;
  soleNotLive: number;
  noEvidence: number;
  postLaunchNulls: number;
};

/** Shared status/apply audit counters over the evidence CTEs (Task #4872). */
const AGENT_CHAT_SENDER_STATS_SQL = sql`
  SELECT
    (SELECT COUNT(*)::int FROM nullchats) AS examined,
    (SELECT COUNT(*)::int FROM stampable) AS stampable,
    (SELECT COUNT(*)::int FROM verdicts WHERE candidate_count > 1) AS ambiguous,
    (SELECT COUNT(*)::int FROM verdicts v
       WHERE v.candidate_count = 1
         AND NOT EXISTS (
           SELECT 1 FROM users u
           WHERE u.id = v.sole_candidate AND u.deleted_at IS NULL
         )
    ) AS sole_not_live,
    (SELECT COUNT(*)::int FROM nullchats nc
       WHERE NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.chat_id = nc.id)
    ) AS no_evidence,
    (SELECT COUNT(*)::int FROM client_agent_chats
       WHERE role = 'user' AND created_by_user_id IS NULL
         AND created_at >= ${AGENT_CHAT_SENDER_TRACKING_LIVE_SINCE}::timestamptz
    ) AS post_launch_nulls
`;

function describeAgentChatSenderResidual(stats: AgentChatSenderStats): string {
  const residuals: string[] = [];
  if (stats.ambiguous > 0) {
    residuals.push(`${stats.ambiguous} ambiguous (≥2 plausible senders in evidence)`);
  }
  if (stats.noEvidence > 0) {
    residuals.push(`${stats.noEvidence} with no activity-log evidence in the ±60min window`);
  }
  if (stats.soleNotLive > 0) {
    residuals.push(`${stats.soleNotLive} whose sole candidate is not a live users row`);
  }
  return residuals.length > 0
    ? ` Unattributable rows stay in the clearly-labeled historical bucket by design: ${residuals.join("; ")}.`
    : "";
}

/**
 * Post-launch NULL-sender rows are OUTSIDE this backfill's eligibility by
 * design (see AGENT_CHAT_SENDER_TRACKING_LIVE_SINCE): sender stamping has
 * been a write-time invariant since launch, so such rows indicate a NEW
 * write-path defect. Surface them loudly in every status/apply detail —
 * stamping them from coincidental evidence would mask the regression.
 */
function describePostLaunchNulls(stats: AgentChatSenderStats): string {
  return stats.postLaunchNulls > 0
    ? ` NOTE: ${stats.postLaunchNulls} user-role chat row(s) created on/after the sender-tracking launch cutoff (${AGENT_CHAT_SENDER_TRACKING_LIVE_SINCE}) also have a NULL sender. Senders are stamped at write time since launch, so this indicates a write-path defect — this action deliberately refuses to backfill them; investigate the write path instead.`
    : "";
}

const COMPANY_OPS_NAME_PREFIX = "Company Ops";

interface CompanyOpsDeptRow {
  id: string;
  name: string;
  assignment_scope: string;
}

/**
 * Partition the pinned ids against the rows currently in the DB:
 *  - `flippable`      — still per_client AND still named "Company Ops…" (safe to flip)
 *  - `renamed`        — still per_client but renamed away from the prefix (skip + report)
 *  - `alreadyCompany` — converged (no touch; name irrelevant once company)
 *  - `missing`        — pinned id no longer exists (report as already removed)
 */
function partitionCompanyOpsRows(rows: CompanyOpsDeptRow[]): {
  flippable: CompanyOpsDeptRow[];
  renamed: CompanyOpsDeptRow[];
  alreadyCompany: CompanyOpsDeptRow[];
  missing: Array<{ id: string; name: string }>;
} {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const flippable: CompanyOpsDeptRow[] = [];
  const renamed: CompanyOpsDeptRow[] = [];
  const alreadyCompany: CompanyOpsDeptRow[] = [];
  const missing: Array<{ id: string; name: string }> = [];
  for (const pinned of COMPANY_OPS_DEPARTMENTS) {
    const row = byId.get(pinned.id);
    if (!row) {
      missing.push(pinned);
      continue;
    }
    if (row.assignment_scope === "company") {
      alreadyCompany.push(row);
      continue;
    }
    if (!row.name.startsWith(COMPANY_OPS_NAME_PREFIX)) {
      renamed.push(row);
      continue;
    }
    flippable.push(row);
  }
  return { flippable, renamed, alreadyCompany, missing };
}

async function readCompanyOpsRows(attribution: string): Promise<CompanyOpsDeptRow[]> {
  const result = await withDbAttribution(attribution, () =>
    getDb().execute(sql`
      SELECT id, name, assignment_scope
      FROM sd_departments
      WHERE id = ANY(${bindArrayParam(COMPANY_OPS_DEPARTMENTS.map((d) => d.id))})
    `),
  );
  return result.rows as unknown as CompanyOpsDeptRow[];
}

/** Human-readable residue notes shared by status() and apply() details. */
function companyOpsResidueNotes(parts: {
  renamed: CompanyOpsDeptRow[];
  missing: Array<{ id: string; name: string }>;
}): string {
  const notes: string[] = [];
  if (parts.renamed.length > 0) {
    notes.push(
      ` Skipped ${parts.renamed.length} pinned row(s) renamed away from "${COMPANY_OPS_NAME_PREFIX}" (repurposed — left untouched): ${parts.renamed
        .map((r) => `"${r.name}" (${r.id})`)
        .join(", ")}.`,
    );
  }
  if (parts.missing.length > 0) {
    notes.push(
      ` ${parts.missing.length} pinned row(s) no longer exist: ${parts.missing
        .map((r) => `"${r.name}" (${r.id})`)
        .join(", ")}.`,
    );
  }
  return notes.join("");
}

export const makeCompanyOpsDepartmentsCompanyWideAction: ProdAction = {
  id: "make_company_ops_departments_company_wide",
  // One-shot scope fix for six fixed rows — settles after one apply (a
  // second press reports not-needed once none of the six remain per_client;
  // renamed/repurposed pinned rows are excluded from convergence).
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Flipping the six Company Ops departments to company-wide removes their rows from every client's Role Assignments grid, coverage panel, and the Add Client form at once — the owner confirms the timing of that all-clients-visible change.",
  },
  title: "Make the six Company Ops departments company-wide",
  description:
    "Sets assignment_scope='company' on the six pinned \"Company Ops – …\" departments (Sales (New Business), Marketing, Operations, HR / People, Finance / Accounting, IT / Systems) created per_client by the 2026-07-24 taxonomy re-org. Company-ops departments hold Doer/Checker responsibilities company-wide and never appear on per-client surfaces — today every client shows six all-gap Company Ops rows and the Add Client form asks for picks. After the flip they appear only in the console's company-roles section (staff their role holders there). Idempotent: a second press reports not-needed. A pinned id renamed away from \"Company Ops\" is skipped and reported, never flipped. Reversible per department via the Scope toggle in Service Desk Settings; existing per-client assignment rows are left in place while company-scoped.",
  change:
    "UPDATE sd_departments SET assignment_scope = 'company', updated_at = NOW() WHERE id IN (six pinned Company Ops ids) AND assignment_scope = 'per_client' AND name LIKE 'Company Ops%'.",

  async status() {
    const rows = await readCompanyOpsRows(
      "maintenance:prod-actions-company-ops-scope-status",
    );
    const parts = partitionCompanyOpsRows(rows);
    const notes = companyOpsResidueNotes(parts);

    if (parts.flippable.length === 0) {
      return {
        state: "not-needed",
        detail: `None of the ${COMPANY_OPS_DEPARTMENTS.length} pinned Company Ops departments remain per_client (${parts.alreadyCompany.length} already company-wide).${notes}`,
      };
    }
    return {
      state: "pending",
      detail: `${parts.flippable.length} of ${COMPANY_OPS_DEPARTMENTS.length} pinned Company Ops department(s) still per_client: ${parts.flippable
        .map((r) => `"${r.name}"`)
        .join(", ")}.${notes}`,
    };
  },

  async apply() {
    // Re-read current state to ensure nothing has changed since status().
    const rows = await readCompanyOpsRows(
      "maintenance:prod-actions-company-ops-scope-apply-check",
    );
    const parts = partitionCompanyOpsRows(rows);
    const notes = companyOpsResidueNotes(parts);

    if (parts.flippable.length === 0) {
      return {
        state: "not-needed",
        detail: `None of the ${COMPANY_OPS_DEPARTMENTS.length} pinned Company Ops departments remain per_client — nothing to flip.${notes}`,
      };
    }

    // Belt-and-braces: the UPDATE re-asserts every predicate so a concurrent
    // rename/flip between the re-read and this write narrows (never widens)
    // the effect.
    const updated = await withDbAttribution(
      "maintenance:prod-actions-company-ops-scope-apply",
      () =>
        getDb().execute(sql`
          UPDATE sd_departments
          SET assignment_scope = 'company', updated_at = NOW()
          WHERE id = ANY(${bindArrayParam(parts.flippable.map((r) => r.id))})
            AND assignment_scope = 'per_client'
            AND name LIKE ${COMPANY_OPS_NAME_PREFIX + "%"}
          RETURNING id, name
        `),
    );
    const flipped = updated.rows as Array<{ id: string; name: string }>;

    return {
      state: "applied",
      detail: `Set assignment_scope='company' on ${flipped.length} Company Ops department(s): ${flipped
        .map((r) => `"${r.name}"`)
        .join(", ")}. They now hold their Doer/Checker responsibilities company-wide and no longer appear on per-client surfaces (staff the role holders in the console's company-roles section).${notes}`,
      rowsAffected: flipped.length,
    };
  },
};

export const platformOpsDomain: ProdActionDomain = {
  name: "platformOps",
  actions: [
    enableDbHoldRollupAction,
    enableExternalCallAuditAction,
    dedupeUserNotificationsUnreadAction,
    enableDbPoolTenancyEnforcementAction,
    createPgStatStatementsExtensionAction,
    backfillUserAuthorityFromLegacyRoleAction,
    repairFeedbackUnknownSubmitterNamesAction,
    backfillAgentChatSendersFromActivityAction,
    enableRedisCacheGloballyAction,
    enableProdActionSelfHealAction,
    enableProdActionSelfHealFailureAlertAction,
    enableProdActionSelfHealReconnectAlertAction,
    enableFeedbackSlackRetryAction,
    enableOrphanedUserHealAction,
    enableAdsOsPacingRefreshAction,
    enableTableRetentionPrunerAction,
    enableTableSizeWatchdogAction,
    deepPruneReclaimOversizedTablesAction,
    deleteSpeedwellDuplicateClientsAction,
    makeCompanyOpsDepartmentsCompanyWideAction,
    deleteGoogleDriveLegacyKeyAction,
    purgeSweptPiiScreenshotsAction,
    syncAdsOsClientSchedulesAction,
    reconcileAdsOsPracticeAreasAction,
    adsOsIncompleteCriteriaStatusAction,
  ],
};

