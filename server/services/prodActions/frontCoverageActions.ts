// @db-pool-intent: worker
/**
 * Prod-action domain module (F7, Task #4154): Front message-grain coverage program — coverage repairs/backfills, the Bring-it-to-100% drivers, and their exported wrappers/seams.
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
import { getDb, withDbAttribution, withDbHoldLabel } from "../../db";
import { storage } from "../../storage";
import { bindArrayParam } from "../../utils/sqlArray";
import { isPoolEpicSwitchEnabled } from "../poolEpicKillSwitches";
import {
  countPendingMaterializedMessageStudy,
  studyMaterializedMessageChunk,
  isMaterializedMessageStudyEnabled,
} from "../frontMaterializedMessageStudy";
import {
  startBackgroundDrain,
  getDrainState,
  formatDrainProgress,
  isDrainRunning,
  type DrainChunkResult,
} from "../prodActionBackgroundDrain";
import { SETTING_ENABLED as SELF_HEAL_SETTING_ENABLED } from "../prodActionSelfHeal";
import {
  type ProdAction,
  type ProdActionDomain,
  type ProdActionOutcome,
  type ProdActionStatus,
} from "./kernel";
import { killSwitchAction } from "./helpers";
import {
  markLegacyFrontEmailPendingTerminalAction,
  resetStuckFrontRecoveryCheckpointsAction,
} from "./frontRecoveryActions";


// ─── Task #2662 — Front message attribution to 100% ──────────────────
//
// One idempotent, breaker-aware CEO prod-action (worker pool) that closes
// the residual Front-message attribution gap in three convergent phases,
// all pure DB writes on the `front_sync_emails` mirror + `client_id`
// stamp on `raw_communication_records`. It NEVER calls the Front API and
// NEVER re-runs a matcher — every phase only propagates state that already
// exists or reconciles a row to its already-determined terminal.
//
// Prior tasks consulted (replit.md prior-task rule): #2089 (discovered
// apply-tail reconcile-or-close shape + fail reason), #2637 (deterministic
// + manual-filter-only matching; the operational classifier was removed),
// #2602 (materialized per-message rows; attribution is a separate opt-in
// driver, never the coverage path), #1969 (one-and-done drain policy),
// #2293/#2363 (cross-instance advisory lock), #2281/#2111 (Front auth
// breaker → amber `blocked`, not error/pending).
//
// Public-doc note: this action touches no Front (or any third-party) HTTP
// endpoint — it is internal data convergence plus the in-memory Front auth
// breaker check — so there is no external endpoint contract to cite beyond
// the breaker semantics already documented in FRONT.md.
//
// Phase 1 — per-message client_id backfill. ~8,920 `front_email` message
//   rows whose conversation IS matched (`front_sync_emails.match_status`
//   auto/manually_matched, `matched_client_id` set) but whose message row
//   `client_id` is still NULL. We propagate the conversation's matched
//   client onto every such row (rollup + per-message, both keyed by
//   external_thread_id === conversation_id), JOINing `clients` with
//   is_archived=false so the orphaned-client guard (same as
//   stampThreadWideClientAttribution) is preserved. Bulk select-then-
//   VALUES-UPDATE in 500-row chunks; idempotent via `client_id IS NULL`.
// Phase 2 — reconcile the stuck `failed` discovered-apply-tail rows. The
//   235 rows the #2089 drain closed terminally to `failed` are re-checked:
//   if a `raw_communication_record` now exists for the conversation, the
//   apply DID happen so we reconcile the mirror FORWARD to `applied`
//   (backfilling ingested_record_id). Rows with no record stay terminally
//   `failed` and are excluded from the count, so the phase converges.
// Phase 3 — reset legacy dismissed/blocked. The 26 `dismissed`/`blocked`
//   conversations created 2026-04-01..14 (before the auto-filters were
//   removed) are reset to `unmatched` — but ONLY after confirming no
//   active manual filter rule still fires for them. Rule-protected rows
//   are left as-is and stop counting, so the phase converges and never
//   overrides a live operator block.
//
// The combined `runChunk` drives Phase 1 to exhaustion, then Phase 2, then
// Phase 3, returning processed>0 until all three are empty; the shared
// drain framework supplies the cross-instance lock, single-flight, and the
// terminal `prod_action_runs` before/after audit.
const BACKFILL_FRONT_MSG_ATTRIBUTION_ID = "backfill_front_message_attribution";

const BACKFILL_FRONT_MSG_BATCH = 500;

// Inclusive start / exclusive end of the legacy dismissed/blocked window.
const LEGACY_DISMISSED_WINDOW_START = "2026-04-01";

const LEGACY_DISMISSED_WINDOW_END = "2026-04-15";

const LEGACY_DISMISSED_RESET_REASON =
  "[task-2662] legacy dismissed/blocked reset to unmatched — no active manual filter rule targets this conversation (auto-filters removed per Task #2637)";

// Substring of the #2089 terminal-close reason; identifies the failed
// discovered-apply-tail cohort without coupling to its full text.
const DISCOVERED_TAIL_REASON_FRAGMENT =
  "discovered_apply_tail: no raw_communication_record";


interface BackfillFrontMsgBreakdown {
  attribution: number;
  reconcile: number;
  legacyReset: number;
  total: number;
}


// ── Phase 1 — per-message client_id backfill ─────────────────────────
async function countAttributionBackfillPending(): Promise<number> {
  const result = await withDbHoldLabel(
    "maintenance:prod-actions-front-attribution-backfill-count",
    () =>
      getDb().execute(sql`
        SELECT COUNT(*)::int AS n
        FROM raw_communication_records r
        JOIN front_sync_emails f ON f.conversation_id = r.external_thread_id
        JOIN clients c ON c.id = f.matched_client_id
          AND COALESCE(c.is_archived, false) = false
        WHERE r.source_type = 'front_email'
          AND r.client_id IS NULL
          AND f.match_status IN ('auto_matched', 'manually_matched')
          AND f.matched_client_id IS NOT NULL
      `),
  );
  return Number((result.rows as any[])[0]?.n ?? 0);
}


async function runAttributionBackfillChunk(): Promise<number> {
  const claimed = await withDbHoldLabel(
    "front_attribution_backfill:select",
    () =>
      getDb().execute(sql`
        SELECT r.id AS rid, f.matched_client_id AS cid
        FROM raw_communication_records r
        JOIN front_sync_emails f ON f.conversation_id = r.external_thread_id
        JOIN clients c ON c.id = f.matched_client_id
          AND COALESCE(c.is_archived, false) = false
        WHERE r.source_type = 'front_email'
          AND r.client_id IS NULL
          AND f.match_status IN ('auto_matched', 'manually_matched')
          AND f.matched_client_id IS NOT NULL
        LIMIT ${BACKFILL_FRONT_MSG_BATCH}
      `),
  );
  const rows = claimed.rows as Array<{ rid: string; cid: string }>;
  if (rows.length === 0) return 0;
  const pairs = rows.map((r) => sql`(${r.rid}, ${r.cid})`);
  const valuesSql = sql.join(pairs, sql`, `);
  const res = await withDbHoldLabel(
    "front_attribution_backfill:stamp",
    () =>
      getDb().execute(sql`
        UPDATE raw_communication_records AS r
        SET client_id = v.cid, updated_at = NOW()
        FROM (VALUES ${valuesSql}) AS v(id, cid)
        WHERE r.id = v.id AND r.client_id IS NULL
      `),
  );
  return res.rowCount ?? rows.length;
}


// ── Phase 2 — reconcile stuck `failed` discovered-apply-tail rows ─────
async function countReconcileFailedTailPending(): Promise<number> {
  const result = await withDbHoldLabel(
    "maintenance:prod-actions-front-reconcile-failed-tail-count",
    () =>
      getDb().execute(sql`
        SELECT COUNT(DISTINCT f.id)::int AS n
        FROM front_sync_emails f
        JOIN raw_communication_records r
          ON r.source_type = 'front_email'
          AND r.external_source_id = f.conversation_id
        WHERE f.pipeline_state = 'failed'
          AND f.pipeline_error LIKE ${"%" + DISCOVERED_TAIL_REASON_FRAGMENT + "%"}
      `),
  );
  return Number((result.rows as any[])[0]?.n ?? 0);
}


async function runReconcileFailedTailChunk(): Promise<number> {
  const claimed = await withDbHoldLabel(
    "front_reconcile_failed_tail:select",
    () =>
      getDb().execute(sql`
        SELECT DISTINCT ON (f.id) f.id AS fid, r.id AS rid
        FROM front_sync_emails f
        JOIN raw_communication_records r
          ON r.source_type = 'front_email'
          AND r.external_source_id = f.conversation_id
        WHERE f.pipeline_state = 'failed'
          AND f.pipeline_error LIKE ${"%" + DISCOVERED_TAIL_REASON_FRAGMENT + "%"}
        LIMIT ${BACKFILL_FRONT_MSG_BATCH}
      `),
  );
  const rows = claimed.rows as Array<{ fid: string; rid: string }>;
  if (rows.length === 0) return 0;
  const pairs = rows.map((r) => sql`(${r.fid}, ${r.rid})`);
  const valuesSql = sql.join(pairs, sql`, `);
  const res = await withDbHoldLabel(
    "front_reconcile_failed_tail:reconcile-applied",
    () =>
      getDb().execute(sql`
        UPDATE front_sync_emails AS f
        SET pipeline_state = 'applied',
            ingested_record_id = v.rid,
            processed_at = NOW(),
            state_changed_at = NOW(),
            pipeline_error = NULL
        FROM (VALUES ${valuesSql}) AS v(id, rid)
        WHERE f.id = v.id AND f.pipeline_state = 'failed'
      `),
  );
  return res.rowCount ?? rows.length;
}


// ── Phase 3 — reset legacy dismissed/blocked (no active rule) ─────────
async function legacyRowHasNoActiveRule(row: {
  id: string;
  conversation_id: string | null;
  subject: string | null;
  participants_json: unknown;
}): Promise<boolean> {
  const { evaluateFilterRules } = await import("../frontFilterRules");
  const participants =
    (row.participants_json as Array<{
      name?: string;
      email?: string;
      role?: string;
    }>) || [];
  const channels = participants
    .filter((p) => (p?.role || "").toLowerCase() === "recipient")
    .map((p) => (p?.email || "").toLowerCase())
    .filter((e) => e.length > 0);
  const result = await evaluateFilterRules({
    subject: row.subject,
    participants,
    channels,
  });
  return !result.matched;
}


async function selectLegacyDismissedCohort(): Promise<
  Array<{
    id: string;
    conversation_id: string | null;
    subject: string | null;
    participants_json: unknown;
  }>
> {
  const result = await withDbHoldLabel(
    "front_legacy_dismissed_reset:select",
    () =>
      getDb().execute(sql`
        SELECT id, conversation_id, subject, participants_json
        FROM front_sync_emails
        WHERE match_status IN ('dismissed', 'blocked')
          AND created_at >= ${LEGACY_DISMISSED_WINDOW_START}::date
          AND created_at < ${LEGACY_DISMISSED_WINDOW_END}::date
        ORDER BY created_at ASC
        LIMIT ${BACKFILL_FRONT_MSG_BATCH}
      `),
  );
  return result.rows as Array<{
    id: string;
    conversation_id: string | null;
    subject: string | null;
    participants_json: unknown;
  }>;
}


async function countLegacyDismissedResetPending(): Promise<number> {
  const cohort = await selectLegacyDismissedCohort();
  let n = 0;
  for (const row of cohort) {
    if (await legacyRowHasNoActiveRule(row)) n++;
  }
  return n;
}


async function runLegacyDismissedResetChunk(): Promise<number> {
  const cohort = await selectLegacyDismissedCohort();
  if (cohort.length === 0) return 0;
  const resettable: string[] = [];
  for (const row of cohort) {
    if (await legacyRowHasNoActiveRule(row)) resettable.push(row.id);
  }
  if (resettable.length === 0) return 0;
  const res = await withDbHoldLabel(
    "front_legacy_dismissed_reset:reset",
    () =>
      getDb().execute(sql`
        UPDATE front_sync_emails
        SET match_status = 'unmatched',
            dismissed_by = NULL,
            match_reason = ${LEGACY_DISMISSED_RESET_REASON},
            state_changed_at = NOW()
        WHERE id = ANY(${bindArrayParam(resettable, "text")})
          AND match_status IN ('dismissed', 'blocked')
      `),
  );
  return res.rowCount ?? resettable.length;
}


async function countBackfillFrontMsgBreakdown(): Promise<BackfillFrontMsgBreakdown> {
  const attribution = await countAttributionBackfillPending();
  const reconcile = await countReconcileFailedTailPending();
  const legacyReset = await countLegacyDismissedResetPending();
  return {
    attribution,
    reconcile,
    legacyReset,
    total: attribution + reconcile + legacyReset,
  };
}


export const backfillFrontMessageAttributionAction: ProdAction = {
  id: BACKFILL_FRONT_MSG_ATTRIBUTION_ID,
  title: "Backfill Front message attribution to 100% (Task #2662)",
  description:
    "Closes the residual Front-message attribution gap in three idempotent, convergent phases — all pure DB writes, no Front API call, no re-matching. (1) Stamps `raw_communication_records.client_id` for every `front_email` message whose conversation is matched (`front_sync_emails.match_status` auto/manually_matched, `matched_client_id` set) but whose message row client_id is still NULL, JOINing non-archived `clients` so the orphaned-client guard is preserved. (2) Reconciles the stuck `failed` discovered-apply-tail rows FORWARD to `applied` (backfilling ingested_record_id) when a raw_communication_record now exists — rows with no record stay terminally failed and stop counting. (3) Resets the legacy `dismissed`/`blocked` conversations created 2026-04-01..14 to `unmatched`, but ONLY when no active manual filter rule still fires for them (rule-protected rows are left as-is). One press starts a worker-pool background drain that converges all three; a second press is a no-op. Degrades to a blocked (amber, reconnect-required) state when the Front auth breaker is tripped.",
  change:
    "Background-drain: (1) bulk-stamp matched-conversation client_id onto null-client front_email message rows (non-archived clients only), (2) reconcile failed discovered-apply-tail rows with an existing raw record to 'applied', (3) reset no-active-rule legacy dismissed/blocked (2026-04-01..14) to 'unmatched'. 500-row chunks on the worker pool until all three are exhausted.",
  // Task #4054 — new Front messages on already-matched conversations are
  // now attributed at ingest (frontWebhookIngestion resolves the matched
  // client before insert), but conversations that become matched AFTER
  // their messages landed still leave a residue this drain mops up. That
  // residue is routine inflow, so the action is continuous: the self-heal
  // scheduler runs the same idempotent drain hourly.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  selfHeal: { cadenceMs: 60 * 60_000, backoffMs: 6 * 60 * 60_000 },
  async status() {
    if (isDrainRunning(BACKFILL_FRONT_MSG_ATTRIBUTION_ID)) {
      const s = getDrainState(BACKFILL_FRONT_MSG_ATTRIBUTION_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const b = await withDbAttribution(
      "maintenance:prod-actions-front-attribution-backfill-status",
      () => countBackfillFrontMsgBreakdown(),
    );
    if (b.total === 0) {
      return {
        state: "not-needed",
        detail:
          "Front message attribution is fully converged — no unattributed matched messages, no reconcilable stuck-failed rows, no resettable legacy dismissed/blocked rows.",
      };
    }
    // Task #2281/#2111 — there is work, but the phases reflect Front state.
    // When the cheap in-memory Front auth breaker is tripped, report amber
    // "needs reconnect" naming Front rather than a misleading pending.
    const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
    if (frontAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "Front",
        detail: `Front login is not connected — ${b.total} attribution item(s) waiting (${b.attribution} message backfill, ${b.reconcile} stuck-failed reconcile, ${b.legacyReset} legacy reset). Reconnect Front in the Integrations Hub to run the backfill.`,
      };
    }
    // Task #4054 — manual-nudge rule (drain_stale_zoom_apply_events
    // precedent): attribution is now stamped at ingest, and this same
    // idempotent drain is enrolled in the hourly self-heal loop. A small
    // residual count while that loop is armed is normal race-window
    // inflow (conversations matched after their messages landed), not
    // operator work — report not-needed so the badge stays at zero.
    const selfHealSetting = await storage
      .getSystemSetting(SELF_HEAL_SETTING_ENABLED)
      .catch(() => null);
    if (selfHealSetting?.value === "true") {
      return {
        state: "not-needed",
        detail: `${b.total} residual item(s) (${b.attribution} message attribution, ${b.reconcile} stuck-failed reconcile, ${b.legacyReset} legacy reset) — the enrolled self-heal loop drains these automatically on its hourly cadence, and new messages on matched conversations are attributed at ingest. No operator action needed; the button stays available to run the drain immediately.`,
      };
    }
    return {
      state: "pending",
      detail: `${b.total} item(s): ${b.attribution} message attribution backfill(s), ${b.reconcile} stuck-failed reconcile(s), ${b.legacyReset} legacy dismissed/blocked reset(s) — a single press converges all of them via a background drain (${BACKFILL_FRONT_MSG_BATCH} per chunk). The hourly self-heal loop is currently OFF (${SELF_HEAL_SETTING_ENABLED}), so this residue only drains manually.`,
    };
  },
  async apply(actorId) {
    const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
    if (frontAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "Front",
        detail:
          "Front login is not connected — reconnect Front in the Integrations Hub to run the attribution backfill.",
      };
    }
    const out = await startBackgroundDrain(
      {
        actionId: BACKFILL_FRONT_MSG_ATTRIBUTION_ID,
        actionTitle: "Backfill Front message attribution to 100%",
        attributionLabel:
          "maintenance:prod-actions-front-attribution-backfill-drain",
        unit: "item(s)",
        countPending: async () => {
          const b = await countBackfillFrontMsgBreakdown();
          return b.total;
        },
        runChunk: async (): Promise<{
          processed: number;
          perKey?: Record<string, number>;
        }> => {
          const attributed = await runAttributionBackfillChunk();
          if (attributed > 0) {
            return { processed: attributed, perKey: { attributed } };
          }
          const reconciled = await runReconcileFailedTailChunk();
          if (reconciled > 0) {
            return {
              processed: reconciled,
              perKey: { reconciled_applied: reconciled },
            };
          }
          const legacyReset = await runLegacyDismissedResetChunk();
          if (legacyReset > 0) {
            return { processed: legacyReset, perKey: { legacy_reset: legacyReset } };
          }
          return { processed: 0 };
        },
        formatSummary: (s) => {
          const k = s.perKey;
          return (
            `Front message attribution converged — ` +
            `${k.attributed ?? 0} message(s) attributed, ` +
            `${k.reconciled_applied ?? 0} stuck-failed row(s) reconciled to applied, ` +
            `${k.legacy_reset ?? 0} legacy dismissed/blocked row(s) reset to unmatched ` +
            `(of ${s.totalAtStart} ${s.unit} at start, across ${s.chunks} chunk(s)).`
          );
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Task #1963 — Relabel coverage denominator units to conversations_all ─
//
// `front_analytics_monthly_coverage` rows pulled before Task #1837
// carry `denominator_unit='inbound_conversations'`. As the comment at
// `frontAnalyticsCoverage.ts:58-65` documents, Task #1709 already
// proved that historical search query was counting *all* directions
// (Front search ignored the unsupported `is:inbound` modifier), so the
// stored values are equivalent to `conversations_all` — a free relabel
// (no Front API call). This unblocks unitsMatch() on read paths that
// require strict equality. Idempotent: a second press matches zero
// rows because the WHERE clause requires the legacy value.
export const relabelFrontCoverageUnitsAction: ProdAction = {
  id: "relabel_front_coverage_units_to_conversations_all",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot metadata relabel of legacy coverage rows — a re-arm means a writer is still emitting the legacy unit label, a regression to investigate rather than auto-relabel.",
  },
  title: "Relabel Front coverage units → conversations_all (Task #1963)",
  description:
    "UPDATE front_analytics_monthly_coverage SET denominator_unit='conversations_all', numerator_unit='conversations_all' WHERE denominator_unit='inbound_conversations'. The legacy value is already equivalent (see frontAnalyticsCoverage.ts comment block) — this is a free relabel with no Front API call, so callers using strict-equality unit matching see consistent rows. Idempotent: subsequent presses match zero rows.",
  change:
    "UPDATE front_analytics_monthly_coverage SET denominator_unit/numerator_unit='conversations_all' for legacy 'inbound_conversations' rows.",
  async status() {
    const result = await withDbAttribution(
      "maintenance:prod-actions-relabel-front-coverage-count",
      () =>
        getDb().execute(sql`
          SELECT COUNT(*)::int AS n
          FROM front_analytics_monthly_coverage
          WHERE denominator_unit = 'inbound_conversations'
             OR (numerator_unit = 'inbound_conversations' AND denominator_unit = 'inbound_conversations')
        `),
    );
    const n = Number((result.rows as any[])[0]?.n ?? 0);
    if (n === 0) {
      return { state: "not-needed", detail: "No legacy 'inbound_conversations' coverage rows to relabel." };
    }
    return { state: "pending", detail: `${n} coverage row(s) would be relabeled to conversations_all.` };
  },
  async apply() {
    const updated = await withDbAttribution(
      "maintenance:prod-actions-relabel-front-coverage-update",
      () =>
        getDb().execute(sql`
          UPDATE front_analytics_monthly_coverage
          SET denominator_unit = 'conversations_all',
              numerator_unit = CASE
                WHEN numerator_unit = 'inbound_conversations' THEN 'conversations_all'
                ELSE numerator_unit
              END,
              updated_at = NOW()
          WHERE denominator_unit = 'inbound_conversations'
          RETURNING id
        `),
    );
    const rowsAffected = updated.rowCount ?? (updated.rows as any[]).length;
    if (rowsAffected === 0) {
      return { state: "not-needed", detail: "No legacy 'inbound_conversations' coverage rows to relabel." };
    }
    return {
      state: "applied",
      detail: `Relabeled ${rowsAffected} coverage row(s) to conversations_all.`,
      rowsAffected,
    };
  },
};


// ─── Task #2436 — purge pre-adoption-floor Front coverage rows ───────
//
// The "All-time coverage" card overflowed (numerator > denominator) partly
// because pre-adoption-floor historical-recovery months — labeled
// `conversations_all` but storing message-count numerators — were summed
// into the all-time totals. The durable fix is the consumer-side floor +
// grain filter in `getFrontAnalyticsCoverageSummary`; this action is the
// physical cleanup that removes the stale pre-floor rows from prod so they
// can never resurface. Strictly scoped to months BEFORE the adoption floor
// (the hard-coded `FRONT_ADOPTION_DATE` → YYYY-MM prefix, Task #2481) and
// idempotent: once purged, a second run matches zero rows.
export const purgePreFloorFrontCoverageRowsAction: ProdAction = {
  id: "purge_pre_floor_front_coverage_rows",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Purge pre-adoption-floor Front coverage rows (Task #2436)",
  description:
    "DELETEs front_analytics_monthly_coverage rows for months strictly BEFORE the adoption floor (the hard-coded FRONT_ADOPTION_DATE → YYYY-MM, Task #2481). These pre-floor historical-recovery months are the worst-overflow rows (message-count numerators labeled conversations_all) and the all-time coverage card excludes them anyway via the consumer-side floor + grain filter; this removes them physically so they never resurface. Idempotent (a second run deletes zero rows). ZERO Front API calls — pure cache-table cleanup. See FRONT_ANALYTICS_COVERAGE.md.",
  change:
    "DELETE FROM front_analytics_monthly_coverage WHERE month < <adoption-floor YYYY-MM>. Idempotent.",
  // Idempotent, Front-free cache cleanup that becomes not-needed after one
  // apply. Opt into self-heal on a slow cadence so prod converges without a
  // manual press; once the pre-floor rows are gone it stays not-needed.
  selfHeal: { cadenceMs: 6 * 60 * 60_000, backoffMs: 24 * 60 * 60_000 },
  async status() {
    const { countPreFloorCoverageRows } = await import(
      "../frontAnalyticsCoverage"
    );
    const { floorMonth, count } = await countPreFloorCoverageRows();
    if (count === 0) {
      return {
        state: "not-needed",
        detail: `No coverage rows before the adoption floor (${floorMonth}) to purge.`,
      };
    }
    return {
      state: "pending",
      detail: `${count} coverage row(s) before the adoption floor (${floorMonth}) would be purged.`,
    };
  },
  async apply() {
    const { deletePreFloorCoverageRows } = await import(
      "../frontAnalyticsCoverage"
    );
    const { floorMonth, deleted } = await deletePreFloorCoverageRows();
    if (deleted === 0) {
      return {
        state: "not-needed",
        detail: `No coverage rows before the adoption floor (${floorMonth}) to purge.`,
      };
    }
    return {
      state: "applied",
      detail: `Purged ${deleted} pre-floor coverage row(s) before ${floorMonth}.`,
      rowsAffected: deleted,
    };
  },
};


// ─── Task #2801 — repair stale Front coverage denominator-floor rows ─────
//
// The Task #2795 denominator floor (`front_total_messages` ≥ local message
// count for message-grain rows) is applied at every write path AND by the
// in-memory read-time safety net in `getFrontAnalyticsCoverageSummary`. But
// a DB row written before the floor shipped can still store
// `front_total_messages < applied_into_nobull` until its next write — a
// latent violation only the in-memory net hides. This action repairs those
// rows in place: every violating message-grain row is re-upserted through
// `applyMessageGrainDenominatorFloor` so the STORED denominator satisfies
// the invariant permanently. Convergent (repaired rows leave the WHERE
// clause), idempotent, and ZERO Front API calls — pure cache-table repair.
// The in-memory safety net stays in place as the last-resort guard.
export const repairFrontCoverageDenominatorFloorAction: ProdAction = {
  id: "repair_front_coverage_denominator_floor",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Repair stale Front coverage denominator-floor rows (Task #2801)",
  description:
    "Re-upserts every message-grain front_analytics_monthly_coverage row whose stored front_total_messages is below applied_into_nobull (the local unique-message count) through applyMessageGrainDenominatorFloor, so the STORED denominator satisfies the Task #2795 floor invariant instead of relying on the read-time in-memory safety net. Preserves all other columns; records the excess in denominator_floor_excess for the Advanced panel's reconciliation note. Idempotent and convergent (repaired rows no longer match). ZERO Front API calls. See FRONT_ANALYTICS_COVERAGE.md.",
  change:
    "For message-grain coverage rows where front_total_messages < applied_into_nobull: raise front_total_messages to applied_into_nobull, recompute derived gap/% fields, stamp denominator_floor_excess. Idempotent.",
  // Recurring, idempotent, Front-free repair — eligible for self-heal so a
  // stale row surfacing later (e.g. restored from a backup) is repaired on
  // the nightly-ish cadence without a manual press.
  selfHeal: { cadenceMs: 6 * 60 * 60_000, backoffMs: 24 * 60 * 60_000 },
  async status() {
    const { countMessageGrainFloorViolations } = await import(
      "../frontAnalyticsCoverage"
    );
    const n = await countMessageGrainFloorViolations();
    if (n === 0) {
      return {
        state: "not-needed",
        detail:
          "No message-grain coverage rows violate the denominator floor (front_total_messages ≥ applied_into_nobull everywhere).",
      };
    }
    return {
      state: "pending",
      detail: `${n} message-grain coverage row(s) store front_total_messages < applied_into_nobull and would be floor-repaired.`,
    };
  },
  async apply() {
    const { repairMessageGrainFloorViolations } = await import(
      "../frontAnalyticsCoverage"
    );
    const { scanned, repaired, errors } =
      await repairMessageGrainFloorViolations();
    if (scanned === 0) {
      return {
        state: "not-needed",
        detail:
          "No message-grain coverage rows violate the denominator floor (front_total_messages ≥ applied_into_nobull everywhere).",
      };
    }
    const repairedDetail = repaired
      .map(
        (r) =>
          `${r.month}: ${r.previousFrontTotal} → ${r.flooredFrontTotal} (excess ${r.floorExcess})`,
      )
      .join("; ");
    if (errors.length > 0) {
      const errDetail = errors
        .map((e) => `${e.month}: ${e.errorMessage}`)
        .join("; ");
      return {
        state: "error",
        detail: `Repaired ${repaired.length}/${scanned} row(s)${repairedDetail ? ` [${repairedDetail}]` : ""}; ${errors.length} failed: ${errDetail}`,
        rowsAffected: repaired.length,
      };
    }
    return {
      state: "applied",
      detail: `Floor-repaired ${repaired.length} coverage row(s): ${repairedDetail}.`,
      rowsAffected: repaired.length,
    };
  },
};


// ─── Task #2483 — purge the dead front_adoption_date system_settings row ──
//
// Task #2481 made the Front coverage floor a hard-coded constant
// (`FRONT_ADOPTION_DATE`). The old mutable `system_settings.front_adoption_date`
// row is now completely ignored — no code path reads or writes it — but a
// lingering row may still exist in prod (and dev). This one-off action
// deletes it so the dead key stops surfacing in settings dumps and can never
// be mistaken for a live control. Idempotent: once gone, the next run is
// not-needed. Pure single-row delete — ZERO Front / external API calls — and
// safe to drive from a read-only-prod dev workspace via the CEO panel
// (Task #1969 background-drain-free; the delete itself is the whole effect).
export const purgeDeadFrontAdoptionDateSettingAction: ProdAction = {
  id: "purge_dead_front_adoption_date_setting",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Purge dead front_adoption_date setting row (Task #2483)",
  description:
    "DELETEs the stale `system_settings.front_adoption_date` row. Task #2481 made the Front coverage floor a hard-coded constant (FRONT_ADOPTION_DATE = 2025-07-01), so this key is no longer read or written by any code path — a leftover row is pure dead plumbing. Removing it stops the dead key from appearing in settings dumps and prevents it being mistaken for a live floor control. Idempotent (a second run finds nothing) and a no-op when the row is already absent. ZERO Front / external API calls — a single-row delete. See FRONT_ANALYTICS_COVERAGE.md.",
  change:
    "DELETE FROM system_settings WHERE key = 'front_adoption_date'. Idempotent; no-op when the row is already absent.",
  // One-off cleanup that becomes not-needed after one apply. Opt into
  // self-heal on a slow cadence so prod converges without a manual press
  // (and re-purges if some legacy path ever recreates the row); once gone it
  // stays not-needed.
  selfHeal: { cadenceMs: 6 * 60 * 60_000, backoffMs: 24 * 60 * 60_000 },
  async status() {
    const { getSystemSettingFresh } = await import(
      "../../storage/settingsStorage"
    );
    const { SETTING_ADOPTION_DATE } = await import("../frontAnalyticsCoverage");
    const row = await getSystemSettingFresh(SETTING_ADOPTION_DATE).catch(
      () => undefined,
    );
    if (!row) {
      return {
        state: "not-needed",
        detail:
          "No dead system_settings.front_adoption_date row to purge (already absent).",
      };
    }
    return {
      state: "pending",
      detail: `The dead system_settings.front_adoption_date row (value=${JSON.stringify(row.value)}) would be deleted.`,
    };
  },
  async apply() {
    const { getSystemSettingFresh, deleteSystemSetting } = await import(
      "../../storage/settingsStorage"
    );
    const { SETTING_ADOPTION_DATE } = await import("../frontAnalyticsCoverage");
    const row = await getSystemSettingFresh(SETTING_ADOPTION_DATE).catch(
      () => undefined,
    );
    if (!row) {
      return {
        state: "not-needed",
        detail:
          "No dead system_settings.front_adoption_date row to purge (already absent).",
      };
    }
    await deleteSystemSetting(SETTING_ADOPTION_DATE);
    return {
      state: "applied",
      detail: `Deleted the dead system_settings.front_adoption_date row (value=${JSON.stringify(row.value)}).`,
      rowsAffected: 1,
    };
  },
};


// ─── Task #2145 — refresh finalized-month coverage local counts ──────
//
// The cache rows for finalized historical months (e.g. 2026-01..04) were
// last pulled on 2026-05-20 — before the `front_sync_emails` mirror
// finished backfilling those months — so their cached `fetched`/`applied`
// numbers badly undercount the now-complete local data. The
// finalized-month-skip cadence (Task #1787) then treats them as done, so
// the normal refresh never revisits them. This action re-counts the
// now-complete local mirror (ZERO Front API calls — it reuses each row's
// existing Front-side denominator) so the dashboard's older-month
// coverage % reflects live data. Bounded to finalized, non-current rows
// and idempotent: once counts match, subsequent presses are not-needed.
export const refreshFinalizedFrontCoverageLocalCountsAction: ProdAction = {
  id: "refresh_finalized_front_coverage_local_counts",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title:
    "Refresh finalized-month Front coverage local counts (Task #2145)",
  description:
    "Recomputes the cached `fetched` / `applied` (and per-direction local) counts for every finalized historical month in front_analytics_monthly_coverage from the now-complete local mirror (front_sync_emails / raw_communication_records), keeping each row's existing Front-side denominator untouched. ZERO Front API calls — it never submits an Analytics report or hits Conversations Search, so it cannot re-trigger the firehose the de-cadencing work (Task #1787) tamed. Needed because the early-2026 rows were last pulled on 2026-05-20, before the mirror finished backfilling, so they undercount live data (e.g. 2026-03: ~4,179 cached vs ~7,903 live). Bounded to finalized, non-current months; idempotent (rows already matching live counts are left untouched). See FRONT_ANALYTICS_COVERAGE.md.",
  change:
    "Recompute fetched/applied/per-direction local counts for finalized historical front_analytics_monthly_coverage rows from the local mirror; preserve the existing Front denominator (no Front API call).",
  // Task #2175 — finalized-month counts drift stale only as future
  // backfills / gap-drains keep filling the local mirror for closed
  // months, so a few times a day is plenty. Idempotent (rows already
  // matching live counts are left untouched) and makes ZERO Front API
  // calls, so the auto-healer can re-count freely. Once everything
  // matches, the tick returns not-needed and backs off.
  selfHeal: { cadenceMs: 6 * 60 * 60_000, backoffMs: 24 * 60 * 60_000 },
  async status() {
    const { recomputeLocalCountsAllMonths } = await import(
      "../frontAnalyticsCoverage"
    );
    const r = await recomputeLocalCountsAllMonths({ dryRun: true });
    if (r.changed === 0) {
      return {
        state: "not-needed",
        detail: `All ${r.attempted} finalized month(s) already match the live local mirror.`,
      };
    }
    const sample = r.results
      .filter((m) => m.changed)
      .slice(0, 4)
      .map(
        (m) =>
          `${m.month}: fetched ${m.before.fetched}→${m.after.fetched}, applied ${m.before.applied}→${m.after.applied}`,
      )
      .join("; ");
    return {
      state: "pending",
      detail: `${r.changed} of ${r.attempted} finalized month(s) would be refreshed. ${sample}`,
    };
  },
  async apply() {
    const { recomputeLocalCountsAllMonths } = await import(
      "../frontAnalyticsCoverage"
    );
    const r = await recomputeLocalCountsAllMonths({ dryRun: false });
    if (r.changed === 0) {
      return {
        state: "not-needed",
        detail: `All ${r.attempted} finalized month(s) already match the live local mirror.`,
      };
    }
    const sample = r.results
      .filter((m) => m.changed)
      .slice(0, 6)
      .map(
        (m) =>
          `${m.month}: fetched ${m.before.fetched}→${m.after.fetched}, applied ${m.before.applied}→${m.after.applied}`,
      )
      .join("; ");
    return {
      state: "applied",
      detail: `Refreshed ${r.changed} of ${r.attempted} finalized month(s) from the local mirror. ${sample}`,
      rowsAffected: r.changed,
    };
  },
};


// ─── Task #1963 — Per-message materialization kill-switch action ─────
export const enableFrontRecoveryPerMessageMaterializationAction = killSwitchAction({
  id: "enable_front_recovery_per_message_materialization",
  switchName: "front_recovery_per_message_materialization_enabled",
  targetValue: true,
  title: "Enable Front recovery per-message materialization (Task #1963)",
  description:
    "Flips `front_recovery_per_message_materialization_enabled` ON so `normalizeReconciliationEvent` hydrates the full message list for every `historical_recovery` source event and writes one `raw_communication_records` row per `msg_*` id (best-effort dedupe on external_source_id, status='processed', no classifier reprocessing). Default OFF so the deploy is behavior-neutral; flip ON after the reset step has refilled the queue from the search endpoint and a sample shows conversation envelopes are landing. Reading site: `server/services/frontWebhookIngestion.ts` inside `normalizeReconciliationEvent`.",
});


// ─── Task #1963 — One-button combined drain action ───────────────────
//
// Runs all four Task #1963 steps in the recommended apply order:
//   1) reset_stuck_front_recovery_checkpoints
//   2) mark_legacy_front_email_pending_terminal
//   3) relabel_front_coverage_units_to_conversations_all
//   4) enable_front_recovery_per_message_materialization (flip ON last)
//
// Each step is independently idempotent and individually registered,
// so an operator can still run them one-by-one for fine-grained
// control. This combined action exists so the CEO doesn't have to
// press four buttons in order: one press, one audit row (with the
// per-step detail concatenated into `detail`), one rollback path
// (flipping the kill switches OFF).
//
// Failure semantics: each step runs sequentially. A step that errors
// is reported in the combined detail but does NOT halt the next
// steps — the four steps are independent (they touch different
// tables / switches) and partial progress is still useful. The
// combined outcome is `applied` if any step changed something,
// `not-needed` if every step short-circuited, `error` only if every
// step errored.
export const drainFront122kBacklogAction: ProdAction = {
  id: "drain_front_122k_backlog",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Drain Front 122k-conversation backlog — run all four steps (Task #1963)",
  description:
    "One-button operator runner that applies the four Task #1963 backlog-drain steps in the recommended order: (1) reset stuck `partial` recovery checkpoints back to the search endpoint, (2) mark legacy `pending` front_email rows terminal (rows >1 hour old, excluding `source_subtype='email_message'`; `failed` with `[backlog-drain 2026-05]` prefix on `operational_classification_reason`), (3) relabel `front_analytics_monthly_coverage` legacy `inbound_conversations` units to `conversations_all`, then (4) flip ON `front_recovery_per_message_materialization_enabled` so subsequent historical_recovery events hydrate per-message rows. Each underlying step is independently idempotent, so this combined action is also safe to apply repeatedly. Detail breakdown for every press lands in the prod-action audit log. See FRONT.md § 122k-conversation backlog drain.",
  change:
    "Sequentially: reset stuck Front recovery checkpoints → mark legacy front_email pending rows terminal → relabel coverage units → enable per-message materialization.",
  // Task #2086 — combined drain re-checks every hour while the big
  // backlog is still working down.
  selfHeal: { cadenceMs: 60 * 60_000, backoffMs: 4 * 60 * 60_000 },
  async status() {
    const steps = [
      resetStuckFrontRecoveryCheckpointsAction,
      markLegacyFrontEmailPendingTerminalAction,
      relabelFrontCoverageUnitsAction,
      enableFrontRecoveryPerMessageMaterializationAction,
    ];
    const parts: string[] = [];
    let anyPending = false;
    let anyError = false;
    let anyBlocked = false;
    for (const step of steps) {
      try {
        const s = await step.status();
        parts.push(`${step.id}=${s.state}`);
        if (s.state === "pending") anyPending = true;
        else if (s.state === "blocked") anyBlocked = true;
      } catch (err: any) {
        parts.push(`${step.id}=error(${err?.message ?? err})`);
        anyError = true;
      }
    }
    const detail = parts.join("; ");
    if (anyPending) return { state: "pending", detail };
    if (anyError) return { state: "error", detail };
    // Task #2111 — a reconnect-required step is not an error; surface the
    // combined action as blocked so it reports amber, not red.
    if (anyBlocked) return { state: "blocked", integration: "Front", detail };
    return { state: "not-needed", detail };
  },
  async apply(actorId) {
    const steps: Array<{ label: string; action: ProdAction }> = [
      { label: "1.reset_checkpoints", action: resetStuckFrontRecoveryCheckpointsAction },
      { label: "2.mark_pending_terminal", action: markLegacyFrontEmailPendingTerminalAction },
      { label: "3.relabel_coverage_units", action: relabelFrontCoverageUnitsAction },
      { label: "4.enable_per_message", action: enableFrontRecoveryPerMessageMaterializationAction },
    ];
    const parts: string[] = [];
    let totalRowsAffected = 0;
    let anyApplied = false;
    let anyError = false;
    let anyBlocked = false;
    for (const { label, action } of steps) {
      try {
        const outcome = await action.apply(actorId ?? undefined);
        if (outcome.state === "applied") {
          anyApplied = true;
          const rows = "rowsAffected" in outcome ? outcome.rowsAffected ?? 0 : 0;
          totalRowsAffected += rows;
          parts.push(`${label}=applied(${outcome.detail})`);
        } else if (outcome.state === "not-needed") {
          parts.push(`${label}=not-needed(${outcome.detail})`);
        } else if (outcome.state === "blocked") {
          anyBlocked = true;
          parts.push(`${label}=blocked(${outcome.detail})`);
        } else {
          anyError = true;
          parts.push(`${label}=error(${outcome.detail})`);
        }
      } catch (err: any) {
        anyError = true;
        parts.push(`${label}=error(${err?.message ?? err})`);
      }
    }
    const detail = parts.join(" | ");
    // Precedence: real work wins; then a true error; then a
    // reconnect-required (Task #2111) blocked; otherwise nothing to do.
    if (anyApplied) return { state: "applied", detail, rowsAffected: totalRowsAffected };
    if (anyError) return { state: "error", detail };
    if (anyBlocked) return { state: "blocked", integration: "Front", detail };
    return { state: "not-needed", detail };
  },
};


// ──────────── Task #1920: drive Front coverage to 100% (message grain) ────────────
//
// Step 3/4 of "Front coverage: reach 100% of messages, for good". One
// worker-pool background drain that, for every finalized historical
// month still short of full coverage, converges it on 100% of MESSAGES
// (not conversations) in three steps per month:
//   1. Re-probe the denominator via the Conversations Search fallback
//      (`refreshMonth` forceSearchFallback+forceRerun). This clears a
//      stale `auth_blocked` flag — but ONLY when Front auth is healthy,
//      via the Step-1 classifier — and, when per-message enumeration
//      completes, republishes the row at message grain (Step 2).
//   2. Drive the recovery NUMERATOR for the month under the search
//      strategy (`runTargetedWindowBackfill`, resume:false) so missing
//      conversations/messages are fetched + applied. Idempotent via the
//      per-conversation recovery dedupe keys.
//   3. Recompute that month's local counts (onlyMonths, ZERO Front
//      calls) so the after-snapshot reflects rows the recovery just
//      applied, and record the per-month before→after coverage delta in
//      the drain tally.
// One month per chunk on the worker pool; the drain runs continuously
// in rounds — after all candidate months in one round have been
// processed it immediately starts the next — with rate-limit headers
// (already paced inside `reachFrontCoverageFullForMonth`) as the natural
// throttle governor. Between every chunk the Front auth breaker and the
// search-strategy kill switch are re-checked so a mid-drain disconnect
// or operator stop halts cleanly. Two consecutive rounds that make zero
// combined progress signal convergence and terminate the drain; the
// self-heal cadence then serves as a crash-recovery / resume mechanism
// rather than the primary pacing tick. The search-strategy switch must
// be ON; otherwise the action reports not-needed when it is OFF.
const REACH_FRONT_COVERAGE_FULL_ID = "reach_front_coverage_full_message_grain";


interface FrontCoverageSubFloorMonth {
  month: string;
  monthStart: Date;
  monthEnd: Date;
  appliedCoveragePct: number;
  completenessStatus: string;
  // Task #2369 — the row's denominator unit + the derived "needs a
  // message-grain re-measure" flag, surfaced so the status sample can
  // explain why an already-≥100% month is still a candidate.
  denominatorUnit: string | null;
  needsMessageGrainRemeasure: boolean;
}


// Task #2369 — pure per-month sweep-candidate decision, extracted so it
// can be unit-tested without a DB / Front round-trip. Returns whether the
// month should be processed by the convergence drain.
//
// Two refinements over the original "sub-floor only" set:
//   1. **Adoption floor.** Months before `front_adoption_date` (passed as
//      a `YYYY-MM` prefix) are excluded — legitimately empty / pre-adoption.
//      The coverage summary returns every cached row regardless of the
//      floor, so the floor filter lives in the sweep to stay aligned with
//      the operator-set value. `adoptionMonth = null` disables the filter.
//   2. **Wrong-grain ≥100% months.** A month whose denominator is NOT
//      message grain (`messages_all` — e.g. `conversations_all` or NULL) is
//      kept even when it already classifies as `covered`/≥100%. Such a
//      month reads ≥100% only because a small conversation-grain
//      denominator divides an all-messages numerator; re-measuring it to
//      message grain corrects the inflated reading. Measurement-only —
//      message writes still flow through the recovery subsystem.
//
// The live current month (still accumulating) and rows whose measurement
// is in-progress are always excluded so the drain only chases months that
// can actually converge.
//
// Task #2387 — when the dedicated #2365 message-grain auto-upgrade driver
// (`frontMessageGrainUpgrader.ts`, switch `front_message_grain_upgrade_enabled`)
// is enabled it owns the measurement-only re-measure of refinement (2) — the
// covered-but-wrong-grain ≥100% months. To avoid duplicating that work (and to
// let this action converge to not-needed once only grain re-measures remain),
// those months are delegated to the driver and stop being candidates here.
// Genuinely sub-floor months are NOT delegated: the driver is measurement-only
// and cannot drive the recovery numerator, which is this action's distinct job.
export function shouldSweepFrontCoverageMonth(input: {
  month: string;
  currentMonth: string;
  adoptionMonth: string | null;
  completenessStatus: string;
  /** Caller computes this via the shared `isMessageGrainDenominator`. */
  isMessageGrainDenominator: boolean;
  /**
   * Task #2434 — true when the month has spent its convergence budget
   * (`coverageConvergenceAttempts >= FRONT_COVERAGE_CONVERGENCE_CAP`): a
   * clean drive made no further progress, so it can never reach
   * 100%-of-messages. Excluded terminally so the action converges. Defaults
   * to false (omitted) for callers/tests that predate the budget.
   */
  convergenceExhausted?: boolean;
  /**
   * Task #2387 — whether the #2365 message-grain upgrade driver is ON. When
   * true, covered-but-wrong-grain months are delegated to that driver and
   * excluded here. Defaults to false (driver off → prior behavior preserved).
   */
  messageGrainUpgradeDriverEnabled?: boolean;
  /**
   * Task #2499 — true when the month carries a non-null `analyticsPlanLimitedAt`
   * memo: Front's analytics plan does not expose message grain for it, so it is
   * TERMINALLY stuck at conversation grain and no re-measure (Analytics OR the
   * forced per-message enumeration) can ever lift it to `messages_all`. When its
   * convergence budget is ALSO spent, the month is genuinely done — retiring it
   * lets the action converge to not-needed instead of re-sweeping a permanently
   * stuck month on every poll forever. Defaults to false (omitted), so Task
   * #2482 callers/tests (which keep convergence-exhausted wrong-grain months as
   * candidates) are unchanged.
   */
  planLimited?: boolean;
  /**
   * Task #2745 — true when the row carries a non-null `deep_search_exhausted_at`
   * marker: reach's deep per-message search enumeration ran to exhaustion for
   * this month and still left an un-fetchable ingest gap. Only consulted for a
   * convergence-exhausted, message-grain, NON-plan-limited month. The #2434
   * budget alone is NOT proof the deep search walk actually ran (it can be spent
   * by grain-only re-measures / recovery passes), so such a month is KEPT a
   * candidate — letting reach re-run the deep walk — until this marker proves
   * the walk is exhausted, at which point it is retired so the action converges.
   * Defaults to false (omitted), preserving prior #2434 behavior for callers /
   * tests that predate the marker.
   */
  deepSearchExhausted?: boolean;
}): boolean {
  if (input.month === input.currentMonth) return false;
  if (input.adoptionMonth && input.month < input.adoptionMonth) return false;
  if (input.completenessStatus === "in-progress") return false;
  if (input.completenessStatus === "covered") {
    // A covered month already on message grain has nothing left to do.
    if (input.isMessageGrainDenominator) return false;
    // A covered-but-wrong-grain month only needs a message-grain re-measure.
    // When the #2365 upgrade driver is enabled it owns that re-measure, so
    // delegate to it; otherwise keep the month so this drain re-measures it.
    if (input.messageGrainUpgradeDriverEnabled) return false;
    // Task #2499 — a covered-but-wrong-grain month that is PLAN-LIMITED to
    // conversation grain can never be lifted to message grain (Front's
    // analytics plan does not expose it), so once its convergence budget is
    // also spent it is genuinely terminal. Retire it instead of re-measuring
    // it on every poll forever. A NON-plan-limited wrong-grain month is still
    // kept below (Task #2482) — that one can still be lifted.
    if (input.convergenceExhausted && input.planLimited) return false;
    // Task #2482 — a covered-but-wrong-grain month still needs the grain
    // re-measure regardless of the convergence budget. Convergence (#2434)
    // is a NUMERATOR concern (proven-unfillable rows); the denominator GRAIN
    // is a separate axis. Keep it a candidate so the forced per-message
    // enumeration this action drives can re-measure it to message grain.
    return true;
  }
  // Sub-floor month (apply-gap / ingest-gap / not-measured).
  //
  // Task #2434 — a month that exhausted its convergence budget is excluded so
  // the drain stops re-counting it and the action converges — but ONLY once it
  // is already at message grain, where a spent budget means the numerator is
  // genuinely unfillable. A wrong-grain sub-floor month is NOT locked out by
  // the budget: it still needs a message-grain re-measure (a different axis),
  // which the forced per-message enumeration walk can deliver (Task #2482).
  // This mirrors the #2365 message-grain upgrade driver, whose selector
  // re-measures every sub-`messages_all` month regardless of the budget.
  //
  // Task #2499 — EXCEPT when the month is PLAN-LIMITED to conversation grain.
  // Front's analytics plan does not expose message grain for it, so no
  // re-measure can ever lift it and a spent budget is terminal at conversation
  // grain too. Retire it (like a message-grain exhausted month) so the action
  // converges instead of re-sweeping a permanently-stuck month forever. The
  // plan-limited search-recovery driver (Task #2705) owns that residue.
  if (input.convergenceExhausted && input.planLimited) return false;
  // Task #2745 — a message-grain, NON-plan-limited month whose convergence
  // budget is spent was previously retired here (#2434, "budget spent ⇒ nothing
  // left to fetch"). But the budget can be spent by grain-only re-measures or
  // recovery passes that never actually ran the deep `/conversations/search` +
  // per-message walk, leaving a REAL ingest gap that no driver drains (reach
  // retired it; the plan-limited driver skips non-plan-limited months). So keep
  // it a candidate — letting reach itself re-run the deep search walk — UNTIL
  // that walk is proven exhausted (`deepSearchExhausted`), at which point the
  // residual gap is genuinely un-fetchable and the month is retired so the
  // action converges. A wrong-grain sub-floor month still falls through to the
  // grain re-measure (Task #2482), unaffected by this marker.
  if (input.convergenceExhausted && input.isMessageGrainDenominator) {
    return input.deepSearchExhausted !== true;
  }
  return true;
}


// Task #2387 — read the #2365 message-grain upgrade driver's master switch
// (`front_message_grain_upgrade_enabled`). When ON, the driver handles the
// grain-only re-measure of covered months automatically, so this action
// delegates those months to it (see `shouldSweepFrontCoverageMonth`).
async function isMessageGrainUpgradeDriverEnabled(): Promise<boolean> {
  try {
    const { SETTING_ENABLED } = await import("../frontMessageGrainUpgrader");
    const row = await storage.getSystemSetting(SETTING_ENABLED);
    return row?.value === "true";
  } catch {
    return false;
  }
}


async function listFrontCoverageSubFloorMonths(): Promise<
  FrontCoverageSubFloorMonth[]
> {
  const {
    getFrontAnalyticsCoverageSummary,
    currentMonthLabel,
    isMessageGrainDenominator,
    FRONT_COVERAGE_CONVERGENCE_CAP,
  } = await import("../frontAnalyticsCoverage");
  const summary = await getFrontAnalyticsCoverageSummary();
  const current = currentMonthLabel();
  // Adoption floor as a YYYY-MM prefix for lexical comparison; null when
  // no floor is set (then no floor filtering, preserving prior behavior).
  const adoptionMonth = summary.adoptionDate
    ? summary.adoptionDate.slice(0, 7)
    : null;
  // Task #2387 — when the #2365 driver is ON, delegate covered-but-wrong-grain
  // months to it so this action does not duplicate the grain re-measure.
  const messageGrainUpgradeDriverEnabled =
    await isMessageGrainUpgradeDriverEnabled();
  const out: FrontCoverageSubFloorMonth[] = [];
  for (const m of summary.months) {
    const isMsgGrain = isMessageGrainDenominator(m.denominatorUnit);
    if (
      !shouldSweepFrontCoverageMonth({
        month: m.month,
        currentMonth: current,
        adoptionMonth,
        completenessStatus: m.completenessStatus,
        isMessageGrainDenominator: isMsgGrain,
        convergenceExhausted:
          (m.coverageConvergenceAttempts ?? 0) >= FRONT_COVERAGE_CONVERGENCE_CAP,
        messageGrainUpgradeDriverEnabled,
        // Task #2499 — a plan-limited month is terminally conversation-grain;
        // paired with a spent convergence budget it is retired below so the
        // action converges instead of re-sweeping it forever.
        planLimited: !!m.analyticsPlanLimitedAt,
        // Task #2745 — a message-grain, non-plan-limited month whose budget is
        // spent stays a candidate (reach re-runs the deep search walk) UNTIL its
        // deep walk is proven exhausted, at which point it is retired.
        deepSearchExhausted: m.deepSearchExhausted,
      })
    ) {
      continue;
    }
    const [y, mo] = m.month.split("-").map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(mo)) continue;
    out.push({
      month: m.month,
      monthStart: new Date(Date.UTC(y, mo - 1, 1)),
      monthEnd: new Date(Date.UTC(y, mo, 1)),
      appliedCoveragePct: m.appliedCoveragePct,
      completenessStatus: m.completenessStatus,
      denominatorUnit: m.denominatorUnit,
      needsMessageGrainRemeasure: !isMsgGrain,
    });
  }
  out.sort((a, b) => a.month.localeCompare(b.month));
  return out;
}


// Task #2705 — candidate months for the plan-limited search recovery step.
//
// These are months `reach_front_coverage_full` deliberately STOPS chasing: a
// plan-limited month that already reached a message-grain (`messages_all`)
// denominator via the search workaround but spent its convergence budget is
// excluded by `shouldSweepFrontCoverageMonth` (convergenceExhausted &&
// messageGrain). Front's analytics PLAN limit blocks the Analytics-Reports
// denominator for these months, NOT the Conversations Search API, so the
// search + per-message enumeration workaround can still drive their ingest gap
// down. We therefore (re-)offer them here regardless of the convergence budget,
// as long as search itself has not hard-failed for the month
// (`isFrontMonthSearchRecoverable`) and there is still an ingest gap to close.
// A month where search ITSELF plan-limits/fails stays honestly excluded — we
// never fabricate a denominator. Reuses `reachFrontCoverageFullForMonth` so no
// Front I/O is duplicated.
export async function listFrontPlanLimitedSearchRecoverableMonths(): Promise<
  FrontCoverageSubFloorMonth[]
> {
  const {
    getFrontAnalyticsCoverageSummary,
    currentMonthLabel,
    isMessageGrainDenominator,
    FRONT_COVERAGE_CONVERGENCE_CAP,
  } = await import("../frontAnalyticsCoverage");
  const { isFrontMonthSearchRecoverable } = await import(
    "@shared/frontConsoleMetrics"
  );
  const summary = await getFrontAnalyticsCoverageSummary();
  const current = currentMonthLabel();
  const adoptionMonth = summary.adoptionDate
    ? summary.adoptionDate.slice(0, 7)
    : null;
  const out: FrontCoverageSubFloorMonth[] = [];
  for (const m of summary.months) {
    if (!m.analyticsPlanLimitedAt) continue; // plan-limited only
    if (m.month === current) continue; // never the still-accumulating month
    if (adoptionMonth != null && m.month < adoptionMonth) continue; // floor
    const isMsgGrain = isMessageGrainDenominator(m.denominatorUnit);
    if (!isMsgGrain) continue; // need a real message denominator to drive toward
    if ((m.ingestGap ?? 0) <= 0) continue; // nothing left to ingest
    // Only pick up months `reach_front_coverage_full` has already RETIRED
    // (convergence budget spent) so the two drivers never drive the same month
    // in one button run — reach owns not-yet-exhausted months; this owns the
    // plan-limited residue it gives up on. Honors the Front API-load caution.
    if ((m.coverageConvergenceAttempts ?? 0) < FRONT_COVERAGE_CONVERGENCE_CAP) {
      continue;
    }
    if (
      !isFrontMonthSearchRecoverable({
        frontAnalyticsStatus: m.frontAnalyticsStatus,
        frontAnalyticsError: m.frontAnalyticsError,
      })
    ) {
      continue; // search itself plan-limits/fails → honestly unreachable
    }
    const [y, mo] = m.month.split("-").map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(mo)) continue;
    out.push({
      month: m.month,
      monthStart: new Date(Date.UTC(y, mo - 1, 1)),
      monthEnd: new Date(Date.UTC(y, mo, 1)),
      appliedCoveragePct: m.appliedCoveragePct,
      completenessStatus: m.completenessStatus,
      denominatorUnit: m.denominatorUnit,
      needsMessageGrainRemeasure: false,
    });
  }
  out.sort((a, b) => a.month.localeCompare(b.month));
  return out;
}


// Task #2710 — surface the Step 2.5 materializer's live progress in the
// action detail so an operator can see materialization advancing instead of a
// stale coverage % until the self-heal cadence finishes. Reads the per-month
// `applied_conv_materializer_checkpoint:` rows and formats them; swallows any
// read error to "" so this can never break the status poll.
async function getMaterializationProgressDetailForStatus(): Promise<string> {
  try {
    const { listActiveMaterializationProgress, formatMaterializationProgressDetail } =
      await import("../frontAppliedConvMaterializer");
    const rows = await withDbAttribution(
      "maintenance:prod-actions-front-materializer-progress",
      () => listActiveMaterializationProgress(getDb()),
    );
    return formatMaterializationProgressDetail(rows);
  } catch {
    return "";
  }
}


// Process a single below-floor month: re-probe denominator (Step 1+2) →
// drive recovery numerator under the search strategy (Step 3) →
// recompute the month's local counts so the after-snapshot is live.
async function reachFrontCoverageFullForMonth(
  month: FrontCoverageSubFloorMonth,
): Promise<{ before: number; after: number; ingested: number; status: string }> {
  const {
    refreshMonth,
    getExistingMonth,
    recomputeLocalCountsAllMonths,
    nextCoverageConvergenceAttempts,
    deriveCoverageConvergenceOutcome,
    setCoverageConvergenceAttempts,
    setCoverageDeepSearchExhausted,
    isMessageGrainDenominator,
    FRONT_ANALYTICS_STATUS_AUTH_BLOCKED,
  } = await import("../frontAnalyticsCoverage");
  const { runTargetedWindowBackfill, runKnownConversationMessageBackfill } =
    await import("../frontHistoricalRecovery");
  const { frontAuthBreakerActive } = await import("../frontAuthBreaker");

  const beforeRow = await getExistingMonth(month.month);
  const before = beforeRow?.appliedCoveragePct ?? 0;

  // Step 1+2 — re-probe the denominator via the search fallback. This
  // clears a stale auth_blocked flag (auth-healthy only, via the Step-1
  // classifier) and republishes at message grain when enumeration
  // completes. forceRerun bypasses the finalized-row short-circuit.
  //
  // Task #2482 — force the per-message enumeration walk even when the global
  // `front_analytics_per_message_enum_enabled` switch is OFF. This is what
  // re-measures the in-scope dropped-history months (e.g. 2025-07→2026-03)
  // from conversation grain up to message grain (`messages_all`) so the
  // all-time #2436 headline (which sums only message-grain rows) stops
  // reading ~0. A single operator press therefore fully restores the
  // headline without also flipping the heavy global enumeration switch.
  await refreshMonth({
    month: month.month,
    monthStart: month.monthStart,
    monthEnd: month.monthEnd,
    isCurrentMonth: false,
    forceSearchFallback: true,
    forceRerun: true,
    forcePerMessageEnum: true,
  });

  // Step 2.5 — Task #2708: materialize individual messages for already-applied
  // conversations. runTargetedWindowBackfill (Step 3) finds 100% `duplicate_ignored`
  // for months where all conversations are already `applied` in front_sync_emails,
  // because it dedupes at the CONVERSATION level — the individual messages inside
  // those conversations were never written to raw_communication_records.
  //
  // Fix: walk the same conversations via the enumeration search with
  // `collectAllMessages: true`, then write each missing per-message row via the
  // shared materializeFrontMessageRecord helper (dedupes on external_source_id).
  // One bounded tick per call; the checkpoint is persisted in system_settings so
  // large months (e.g. 3,737 conversations) resume across self-heal cycles.
  let materializeInserted = 0;
  // Tracks whether the materializer walk exhausted all conversations for the
  // month. Step 3 (conversation recovery) is gated on this: while the
  // materializer is still in progress every conversation in the search window
  // is already `applied` in front_sync_emails, so runTargetedWindowBackfill
  // would return 100% duplicate_ignored (the `coverage_denominator_likely_wrong`
  // condition). Running Step 3 in that state burns Front API quota for zero
  // gain; gate it until the materializer reports done on a later self-heal tick.
  let materializeDone = true; // default true: if Step 2.5 throws, fall through
  const matCpKey = `applied_conv_materializer_checkpoint:${month.month}`;
  try {
    // Task #2713 — serialize materialization of THIS month across concurrent
    // self-heal ticks AND across autoscale instances with a cluster-wide
    // advisory lock keyed by the month. Without it, two ticks/instances each
    // load the SAME checkpoint, walk the SAME conversations, and collide on the
    // per-message unique index — burning ~all the Front/DB budget on duplicate
    // re-walk instead of advancing the un-materialized tail. The lock is
    // self-healing (Postgres drops it if the holder crashes) and bounded by a
    // watchdog so a hung Front page-walk cannot wedge the month forever.
    const { withWorkerSingletonLock } = await import("../crossInstanceLock");
    const lockName = `front_applied_conv_materializer:${month.month}`;
    const lockOutcome = await withWorkerSingletonLock(
      lockName,
      async () => {
        const { getSystemSetting, setSystemSetting } = await import(
          "../../storage/settingsStorage"
        );
        const { materializeAppliedConvMessagesForMonthTick } = await import(
          "../frontAppliedConvMaterializer"
        );
        const rawCp = (
          await getSystemSetting(matCpKey).catch(() => null)
        )?.value?.trim();
        let checkpoint:
          | import("../frontAnalyticsClient").EnumerationCheckpoint
          | null = null;
        if (rawCp) {
          try {
            const parsed = JSON.parse(rawCp);
            if (parsed && typeof parsed === "object") checkpoint = parsed;
          } catch {
            // corrupt checkpoint — restart from scratch (idempotent)
          }
        }
        const matResult = await materializeAppliedConvMessagesForMonthTick(
          month.month,
          month.monthStart,
          month.monthEnd,
          checkpoint,
        );
        if (matResult.done) {
          await setSystemSetting(matCpKey, "").catch(() => undefined);
        } else {
          await setSystemSetting(
            matCpKey,
            JSON.stringify(matResult.checkpoint),
          ).catch(() => undefined);
        }
        return { inserted: matResult.inserted, done: matResult.done };
      },
      "[reachFrontCoverageFullForMonth]",
      // 15 min ceiling: one tick is bounded by the per-tick conversation /
      // message-page budgets, so a longer hold means a stalled Front call —
      // force-release so another instance can resume from the checkpoint.
      { maxHoldMs: 15 * 60_000 },
    );
    if (lockOutcome.ran && lockOutcome.result) {
      materializeInserted = lockOutcome.result.inserted;
      materializeDone = lockOutcome.result.done;
    } else {
      // Another tick/instance holds the lock and is materializing this month.
      // Skip Step 3 this tick (gate on materializeDone=false) so we neither
      // double-walk nor burn Front quota; the holder advances the checkpoint
      // and the next self-heal tick continues from there.
      materializeDone = false;
    }
  } catch (matErr: any) {
    // Non-fatal: log and continue to Step 3 so the action does not halt.
    console.warn(
      `[reachFrontCoverageFullForMonth] month=${month.month} materializer tick failed: ${
        matErr?.message ?? matErr
      }`,
    );
  }

  // Step 2.6 — Task #2716: backfill per-message rows for KNOWN conversations
  // sourced DIRECTLY from front_sync_emails. Step 2.5's materializer re-walks
  // the month via Front's Conversations Search, but front_sync_emails tracks
  // MORE conversations for a month than search `_total` returns (search is
  // plan-/window-capped). Those extra conversations are already known, so we do
  // not need search to re-discover them — we enumerate them from
  // front_sync_emails and fetch each one's messages. Per-message writes dedupe
  // on external_source_id, so this is idempotent and complements (does not
  // double) Step 2.5. Same advisory-lock + persisted-checkpoint pattern so a
  // large month resumes across self-heal ticks and never double-walks across
  // autoscale instances.
  let knownConvInserted = 0;
  let knownConvDone = true; // default true: a throw must fall through to Step 3
  const knownCpKey = `known_conv_msg_backfill_checkpoint:${month.month}`;
  try {
    const { withWorkerSingletonLock } = await import("../crossInstanceLock");
    const lockName = `front_known_conv_backfill:${month.month}`;
    const lockOutcome = await withWorkerSingletonLock(
      lockName,
      async () => {
        const { getSystemSetting, setSystemSetting } = await import(
          "../../storage/settingsStorage"
        );
        const rawCp = (
          await getSystemSetting(knownCpKey).catch(() => null)
        )?.value?.trim();
        let checkpoint:
          | import("../frontHistoricalRecovery").KnownConvBackfillCheckpoint
          | null = null;
        if (rawCp) {
          try {
            const parsed = JSON.parse(rawCp);
            if (parsed && typeof parsed === "object") checkpoint = parsed;
          } catch {
            // corrupt checkpoint — restart from scratch (idempotent)
          }
        }
        const result = await runKnownConversationMessageBackfill(
          {
            label: month.month,
            monthStart: month.monthStart,
            monthEnd: month.monthEnd,
          },
          checkpoint,
        );
        // Only clear the checkpoint on a clean, exhausted walk. On `blocked`
        // (auth down) leave the checkpoint so the next tick resumes from the
        // same cursor; on `done` reset so a later run re-walks the window and
        // retries any conversations skipped on a transient error.
        if (result.done && result.status === "ok") {
          await setSystemSetting(knownCpKey, "").catch(() => undefined);
        } else {
          await setSystemSetting(
            knownCpKey,
            JSON.stringify(result.checkpoint),
          ).catch(() => undefined);
        }
        return {
          inserted: result.inserted,
          // A blocked/disabled tick is NOT a finished walk — keep the month
          // non-terminal so Step 3 stays gated and the sweep can't retire it.
          done: result.done && result.status === "ok",
        };
      },
      "[reachFrontCoverageFullForMonth:knownConv]",
      { maxHoldMs: 15 * 60_000 },
    );
    if (lockOutcome.ran && lockOutcome.result) {
      knownConvInserted = lockOutcome.result.inserted;
      knownConvDone = lockOutcome.result.done;
    } else {
      // Another tick/instance is walking this month — gate Step 3 this tick.
      knownConvDone = false;
    }
  } catch (knownErr: any) {
    console.warn(
      `[reachFrontCoverageFullForMonth] month=${month.month} known-conv backfill tick failed: ${
        knownErr?.message ?? knownErr
      }`,
    );
  }

  // Fold the known-conversation backfill into the materializer accounting so the
  // numerator/convergence logic below treats both walks as one materialization
  // phase: Step 3 runs only once BOTH walks are exhausted, and the inserts both
  // count as progress.
  materializeInserted += knownConvInserted;
  materializeDone = materializeDone && knownConvDone;

  // Step 3 — drive the recovery numerator under the search strategy.
  // resume:false starts a fresh pass; the per-conversation recovery
  // dedupe keys keep it idempotent so applied rows are never doubled.
  // Skipped while the materializer is still in progress — see materializeDone
  // comment above. On the final tick (materializeDone=true) Step 3 runs to
  // ingest any genuinely new conversations that arrived after the month closed.
  let ingested = materializeInserted;
  let status = "skipped";
  if (materializeDone) {
    try {
      const cp = await runTargetedWindowBackfill(
        {
          label: month.month,
          afterTimestamp: Math.floor(month.monthStart.getTime() / 1000),
          beforeTimestamp: Math.floor(month.monthEnd.getTime() / 1000),
        },
        { resume: false },
      );
      ingested += cp.ingested ?? 0;
      status = cp.status;
    } catch (err: any) {
      status = `recovery_error: ${(err?.message ?? String(err)).slice(0, 160)}`;
    }
  } else {
    status = "materializer_in_progress";
  }

  // Recompute just this month's local counts (ZERO Front calls) so the
  // after-snapshot reflects the rows the recovery just applied. The
  // Front-side denominator is preserved verbatim by this recompute.
  await recomputeLocalCountsAllMonths({
    dryRun: false,
    onlyMonths: [month.month],
  }).catch(() => undefined);

  const afterRow = await getExistingMonth(month.month);
  const after = afterRow?.appliedCoveragePct ?? before;

  // Task #2434 — advance the per-month convergence budget so the sweep can
  // terminally exclude a month that can never reach 100%-of-messages, and
  // the action converges instead of re-counting it on every self-heal tick:
  //   progress (coverage advanced, rows ingested, or grain re-measured) ⇒ reset
  //   Front auth down (breaker active or row=auth_blocked) ⇒ leave unchanged
  //   materializer_in_progress (Step 2.5 not yet done) ⇒ leave unchanged
  //   recovery threw (recovery_error) ⇒ bounded +1
  //   clean drive, no progress ⇒ jump to the cap (nothing left to fetch)
  //
  // Task #2482 — the forced per-message enumeration walk flips a wrong-grain
  // row to message grain (`messages_all`). That is real progress even when the
  // applied % drops (a message-grain denominator is larger than the old
  // conversation-grain one), so count the grain advance as progress; otherwise
  // the row would jump straight to the cap the moment it finally reaches
  // message grain and never get a fair numerator drive afterward.
  //
  // Task #2708 — materializer_in_progress is non-terminal: the conversation walk
  // has not yet finished so messages are still being written; a tick that inserts
  // 0 rows is not evidence of "nothing left to fetch" — it just means the
  // current page budget is exhausted. Treat it like auth_blocked (leave attempts
  // unchanged) so the sweep cannot retire the month while materialization is live.
  const grainAdvanced =
    !isMessageGrainDenominator(beforeRow?.denominatorUnit) &&
    isMessageGrainDenominator(afterRow?.denominatorUnit);
  const authBlocked =
    frontAuthBreakerActive() ||
    afterRow?.frontAnalyticsStatus === FRONT_ANALYTICS_STATUS_AUTH_BLOCKED;
  // Task #2711 — `ingested` accumulates BOTH halves of progress: Step 2.5's
  // materialized per-message rows (materializeInserted) AND Step 3's recovery
  // ingest (cp.ingested). So a month whose materializer inserted rows counts as
  // "progress" even when Step 3 returned ingested=0 (every conversation already
  // applied) — it must NOT be retired as "unreachable" while it is still making
  // real per-message progress. The outcome precedence lives in the pure,
  // unit-tested deriveCoverageConvergenceOutcome helper.
  const outcome = deriveCoverageConvergenceOutcome({
    before,
    after,
    ingested,
    grainAdvanced,
    authBlocked,
    status,
  });
  const current = afterRow?.coverageConvergenceAttempts ?? 0;
  const nextAttempts = nextCoverageConvergenceAttempts(current, outcome);
  if (nextAttempts !== null && nextAttempts !== current) {
    await setCoverageConvergenceAttempts(month.month, nextAttempts).catch(
      () => undefined,
    );
  }

  // Task #2745 — maintain the terminal deep-search-exhausted marker so the sweep
  // can distinguish "budget spent but the deep per-message search walk never
  // actually ran" (keep chasing) from "the deep walk RAN to exhaustion and the
  // ingest gap is genuinely un-fetchable" (retire + park out of reachable work).
  //   - "unreachable" outcome ⇒ a clean drive (materializer DONE, per the
  //     precedence in deriveCoverageConvergenceOutcome) made no progress. If a
  //     real ingest gap remains, the deep walk is exhausted: stamp the marker.
  //   - "progress" ⇒ the month advanced this tick, so any prior exhaustion no
  //     longer holds: clear the marker so the month re-opens.
  // Auth-blocked / in-progress / transient-error outcomes leave it unchanged
  // (they are not proof of exhaustion). Best-effort: never break the drive.
  const afterExhausted = afterRow?.deepSearchExhaustedAt != null;
  if (outcome === "unreachable" && materializeDone) {
    const residualIngestGap = (afterRow?.ingestGap ?? 0) > 0;
    if (residualIngestGap && !afterExhausted) {
      await setCoverageDeepSearchExhausted(month.month, true).catch(
        () => undefined,
      );
    }
  } else if (outcome === "progress" && afterExhausted) {
    await setCoverageDeepSearchExhausted(month.month, false).catch(
      () => undefined,
    );
  }
  return { before, after, ingested, status };
}


// Test-only seam used by both `reachFrontCoverageFullAction` (continuous-round
// drain) and `applyRecoverFrontPlanLimitedMessages` (single-pass drain) so
// their end-to-end tests can exercise the background drain without real Front
// I/O. Production always falls back to the real `reachFrontCoverageFullForMonth`.
let __reachFrontCoverageFullForMonthOverrideForTest:
  | typeof reachFrontCoverageFullForMonth
  | null = null;


export const reachFrontCoverageFullAction: ProdAction = {
  id: REACH_FRONT_COVERAGE_FULL_ID,
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title:
    "Drive Front coverage to 100% of messages for every sub-floor month (Task #1920)",
  description:
    "One worker-pool background drain that converges every finalized historical month still short of full coverage onto 100% of MESSAGES. Per month it (1) re-probes the denominator via the Conversations Search fallback — which also clears a stale `auth_blocked` flag only when Front auth is healthy and republishes the row at message grain — then (2) drives the recovery numerator for that month under the search strategy via runTargetedWindowBackfill (resume:false, idempotent on the per-conversation dedupe keys) so missing conversations/messages are fetched + applied, then (3) recomputes that month's local counts (zero extra Front calls) so the recorded before→after delta is live. One month per chunk; each candidate month is processed at most once per run so the drain terminates even when a month is still short afterwards (the self-heal cadence or a later run finishes the remainder). The search-strategy switch (`front_recovery_sparse_month_search_strategy_enabled`) must be ON, otherwise re-running would rebuild the legacy enumeration. Idempotent and breaker-aware: months already fully covered are skipped, and Front auth/rate-limit guards in the recovery worker bound the API load. See FRONT_ANALYTICS_COVERAGE.md.",
  change:
    "Background-drain over finalized sub-floor front_analytics_monthly_coverage months: refreshMonth(forceSearchFallback+forceRerun) re-probes the message-grain denominator and clears auth-healthy auth_blocked flags, runTargetedWindowBackfill(resume:false) drives the recovery numerator under the search strategy, then recomputeLocalCountsAllMonths(onlyMonths) refreshes the local counts. One month/chunk on the worker pool; each month at most once per run.",
  // Task #2281 — a single press processes each sub-floor month at most once
  // per run, so a month still short afterwards is re-offered on the next
  // poll and the action would otherwise sit perpetually `pending`. It is
  // idempotent (covered months are skipped; per-conversation dedupe keys
  // stop double-applies) and breaker-aware (blocks, not errors, while Front
  // auth is dead), so it opts into the self-heal scheduler: one press hands
  // off and the auto-healer keeps driving each month toward 100% on a
  // cadence until every finalized month is fully covered.
  selfHeal: { cadenceMs: 60 * 60_000, backoffMs: 6 * 60 * 60_000 },
  async status() {
    if (isDrainRunning(REACH_FRONT_COVERAGE_FULL_ID)) {
      const s = getDrainState(REACH_FRONT_COVERAGE_FULL_ID)!;
      const matDetail = await getMaterializationProgressDetailForStatus();
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.${
          matDetail ? ` ${matDetail}.` : ""
        }`,
      };
    }
    if (
      !isPoolEpicSwitchEnabled(
        "front_recovery_sparse_month_search_strategy_enabled",
      )
    ) {
      return {
        state: "not-needed",
        detail:
          "The search strategy switch (front_recovery_sparse_month_search_strategy_enabled) is OFF — turn it on first, otherwise driving recovery would just rebuild the legacy enumeration.",
      };
    }
    // Task #2387 — surface the relationship with the #2365 driver in the
    // panel detail. When the driver is ON, grain-only re-measures of covered
    // months are excluded from the candidate list (handled automatically),
    // so any remaining months are genuinely sub-floor (numerator) work.
    const driverEnabled = await isMessageGrainUpgradeDriverEnabled();
    const driverNote = driverEnabled
      ? " Grain-only re-measures of already-covered months are handled automatically by the message-grain upgrade driver (front_message_grain_upgrade_enabled)."
      : "";
    const months = await listFrontCoverageSubFloorMonths();
    if (months.length === 0) {
      return {
        state: "not-needed",
        detail: `Every finalized Front coverage month is already fully covered.${driverNote}`,
      };
    }
    // Task #2281 — work exists but every re-drive needs Front. Use the
    // cheap in-memory breaker (no Front call on every panel poll) to report
    // amber "needs reconnect" naming Front instead of a misleading
    // "pending"; the self-heal tick converges it once Front reconnects.
    const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
    if (frontAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "Front",
        detail: `Front login is not connected — ${months.length} finalized month(s) are below full coverage and waiting. Reconnect Front in the Integrations Hub and this converges automatically.`,
      };
    }
    const sample = months
      .slice(0, 6)
      .map((m) => `${m.month} (${m.appliedCoveragePct}%)`)
      .join(", ");
    const matDetail = await getMaterializationProgressDetailForStatus();
    return {
      state: "pending",
      detail: `${months.length} finalized month(s) below full coverage (${sample}); a single press drives each toward 100% of messages, one month per chunk.${driverNote}${
        matDetail ? ` ${matDetail}.` : ""
      }`,
    };
  },
  async apply(actorId) {
    if (
      !isPoolEpicSwitchEnabled(
        "front_recovery_sparse_month_search_strategy_enabled",
      )
    ) {
      return {
        state: "not-needed",
        detail:
          "The search strategy switch (front_recovery_sparse_month_search_strategy_enabled) is OFF — turn it on first.",
      };
    }
    // Task #2281 — short-circuit to `blocked` (not a failed/empty drain)
    // when Front auth is dead so the self-heal tick fires a reconnect alert
    // and converges once Front is back, rather than starting a drain that
    // would just error per month.
    const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
    if (frontAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "Front",
        detail:
          "Front login is not connected — reconnect Front in the Integrations Hub, then this converges automatically.",
      };
    }
    // Task #2761 — continuous-round drain: rather than touching each candidate
    // month at most once per run and waiting 60 min for the next self-heal tick,
    // the drain loops over the candidate set in rounds, using Front's
    // x-ratelimit-* headers (paced inside `reachFrontCoverageFullForMonth`) as
    // the natural throttle governor.  Between every chunk the breaker and the
    // search-strategy switch are re-checked so a mid-drain disconnect or
    // operator stop halts cleanly.  Two consecutive rounds with zero combined
    // progress signal convergence and terminate the drain; the 60-min self-heal
    // then serves as a crash-recovery / resume mechanism, not as pacing.
    let roundVisited = new Set<string>();
    let roundProgress = 0;
    let consecutiveZeroProgressRounds = 0;
    const out = await startBackgroundDrain(
      {
        actionId: REACH_FRONT_COVERAGE_FULL_ID,
        actionTitle: "Drive Front coverage to 100% of messages",
        attributionLabel:
          "maintenance:prod-actions-reach-front-coverage-full",
        unit: "month(s)",
        countPending: async () => {
          const months = await listFrontCoverageSubFloorMonths();
          return months.length;
        },
        runChunk: async (): Promise<DrainChunkResult> => {
          // Pre-chunk guards: breaker or kill switch → halt cleanly.
          if (frontAuthBreakerActive()) return { processed: 0 };
          if (
            !isPoolEpicSwitchEnabled(
              "front_recovery_sparse_month_search_strategy_enabled",
            )
          ) {
            return { processed: 0 };
          }
          const months = await listFrontCoverageSubFloorMonths();
          let next = months.find((m) => !roundVisited.has(m.month));
          if (!next) {
            // Round complete — check zero-progress convergence.
            if (roundProgress === 0) {
              consecutiveZeroProgressRounds++;
            } else {
              consecutiveZeroProgressRounds = 0;
            }
            if (consecutiveZeroProgressRounds >= 2 || months.length === 0) {
              return { processed: 0 };
            }
            // Start a new round using the already-fetched month list.
            roundVisited = new Set<string>();
            roundProgress = 0;
            next = months[0];
            if (!next) return { processed: 0 };
          }
          roundVisited.add(next.month);
          const r = await (
            __reachFrontCoverageFullForMonthOverrideForTest ??
            reachFrontCoverageFullForMonth
          )(next);
          const advanced = r.after > r.before ? 1 : 0;
          roundProgress += r.ingested + advanced;
          return {
            processed: 1,
            perKey: {
              months_processed: 1,
              months_advanced: advanced,
              messages_ingested: r.ingested,
            },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Task #3889: keep the rolling recent window message-grain fresh ────────
//
// The Going Quiet detector (plus daily judgment / timelines / coverage)
// reads per-message inbound truth from `raw_communication_records`, but
// per-message rows were historically only written by month-scoped BACKFILL
// drivers. When those stopped (dead Front token, Jun 2026) the current
// months silently collapsed to near-zero inbound and the Going Quiet tab
// flagged 54/56 active clients at once. This action owns the ROLLING window
// (previous + current month): it measures each month's message-grain
// completeness against Front's own conversation tracker
// (`front_sync_emails`, fed by the reconciliation poller — the most durable
// feed we have) and, when a month is behind, walks the shared
// applied-conversation materializer over it using the SAME checkpoint keys
// and cross-instance advisory lock as `reach_front_coverage_full_message_grain`,
// so the two drivers cooperate instead of colliding. Finalized older months
// stay with the reach / plan-limited family — this action never touches them.
//
// Perpetual-pending honesty (Task #2925 lesson): after a walk completes, a
// durable per-month marker (`front_recent_window_walked:<month>`) records
// the completion time. A month only counts as pending again when Front
// shows NEW activity after that marker — a fully-walked month whose
// residual shortfall Front's search simply does not expose (deleted/spam
// conversations) reads "not-needed", not forever-"pending".

const FRONT_RECENT_WINDOW_FRESHNESS_ID = "front_recent_window_message_freshness";

/** Stale when materialized conversations cover less than this % of Front-active conversations… */
const RECENT_WINDOW_STALE_RATIO_PCT = 90;

/** …or when the newest materialized message lags Front's newest activity by more days than this. */
const RECENT_WINDOW_LAG_DAYS = 3;

/** Ignore months with almost no Front activity (day-one month / quiet fleet). */
const RECENT_WINDOW_MIN_ACTIVE_CONVS = 20;

const recentWindowWalkedKey = (month: string) =>
  `front_recent_window_walked:${month}`;


interface RecentWindowMonthFreshness {
  month: string;
  monthStart: Date;
  monthEnd: Date;
  /** Conversations Front itself shows active in the month (front_sync_emails). */
  activeConvs: number;
  /** Distinct conversations with materialized per-message rows in the month. */
  materializedConvs: number;
  /** materialized/active as a % (null when the month has no activity). */
  coveragePct: number | null;
  newestSyncAt: Date | null;
  newestMsgAt: Date | null;
  lagDays: number | null;
  stale: boolean;
  /** stale AND Front shows activity newer than the last completed walk. */
  pendingWalk: boolean;
}


function listRecentWindowMonths(
  now: Date = new Date(),
): Array<{ month: string; monthStart: Date; monthEnd: Date }> {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const mk = (yy: number, mm: number) => {
    const monthStart = new Date(Date.UTC(yy, mm, 1));
    const monthEnd = new Date(Date.UTC(yy, mm + 1, 1));
    return { month: monthStart.toISOString().slice(0, 7), monthStart, monthEnd };
  };
  return [mk(y, m - 1), mk(y, m)];
}


async function measureRecentWindowMonthFreshness(m: {
  month: string;
  monthStart: Date;
  monthEnd: Date;
}): Promise<RecentWindowMonthFreshness> {
  // Index-backed (Task #2925 lesson): front_sync_last_message_at_idx covers
  // the tracker side; the partial raw_comm_front_email_message_ts_idx
  // (migration 20260806180000) covers the materialized side — status() runs
  // on every panel poll and must never seq-scan raw_communication_records.
  const result = await withDbAttribution(
    "maintenance:prod-actions-front-recent-window",
    () =>
      getDb().execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM front_sync_emails
            WHERE last_message_at >= ${m.monthStart} AND last_message_at < ${m.monthEnd}) AS active_convs,
          (SELECT MAX(last_message_at) FROM front_sync_emails
            WHERE last_message_at >= ${m.monthStart} AND last_message_at < ${m.monthEnd}) AS newest_sync_at,
          (SELECT COUNT(DISTINCT external_thread_id)::int FROM raw_communication_records
            WHERE source_type = 'front_email' AND source_subtype = 'email_message'
              AND timestamp >= ${m.monthStart} AND timestamp < ${m.monthEnd}) AS materialized_convs,
          (SELECT MAX(timestamp) FROM raw_communication_records
            WHERE source_type = 'front_email' AND source_subtype = 'email_message'
              AND timestamp >= ${m.monthStart} AND timestamp < ${m.monthEnd}) AS newest_msg_at
      `),
  );
  const row: any = (result as any).rows?.[0] ?? {};
  const toDate = (v: unknown): Date | null => {
    if (!v) return null;
    const d = new Date(v as any);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const activeConvs = Number(row.active_convs ?? 0);
  const materializedConvs = Number(row.materialized_convs ?? 0);
  const newestSyncAt = toDate(row.newest_sync_at);
  const newestMsgAt = toDate(row.newest_msg_at);
  const coveragePct =
    activeConvs > 0
      ? Math.round((materializedConvs / activeConvs) * 1000) / 10
      : null;
  const lagDays =
    newestSyncAt !== null && newestMsgAt !== null
      ? Math.round(((newestSyncAt.getTime() - newestMsgAt.getTime()) / 86_400_000) * 10) / 10
      : null;
  const hasActivity =
    activeConvs >= RECENT_WINDOW_MIN_ACTIVE_CONVS && newestSyncAt !== null;
  const stale =
    hasActivity &&
    (newestMsgAt === null ||
      (coveragePct !== null && coveragePct < RECENT_WINDOW_STALE_RATIO_PCT) ||
      (lagDays !== null && lagDays > RECENT_WINDOW_LAG_DAYS));
  let pendingWalk = false;
  if (stale) {
    try {
      const raw = (
        await storage.getSystemSetting(recentWindowWalkedKey(m.month))
      )?.value?.trim();
      const walkedAt = raw ? new Date(raw) : null;
      pendingWalk =
        walkedAt === null ||
        Number.isNaN(walkedAt.getTime()) ||
        (newestSyncAt !== null && walkedAt.getTime() < newestSyncAt.getTime());
    } catch {
      pendingWalk = true; // unreadable marker → err toward walking
    }
  }
  return {
    month: m.month,
    monthStart: m.monthStart,
    monthEnd: m.monthEnd,
    activeConvs,
    materializedConvs,
    coveragePct,
    newestSyncAt,
    newestMsgAt,
    lagDays,
    stale,
    pendingWalk,
  };
}


/** One bounded materializer tick for a rolling-window month, sharing the
 *  reach action's per-month checkpoint key AND cross-instance advisory lock
 *  (`front_applied_conv_materializer:<month>`) so concurrent drivers resume
 *  each other instead of re-walking the same pages. */
async function runRecentWindowMaterializerTick(m: {
  month: string;
  monthStart: Date;
  monthEnd: Date;
}): Promise<{ ran: boolean; inserted: number; skipped: number; done: boolean }> {
  const matCpKey = `applied_conv_materializer_checkpoint:${m.month}`;
  const { withWorkerSingletonLock } = await import("../crossInstanceLock");
  const lockOutcome = await withWorkerSingletonLock(
    `front_applied_conv_materializer:${m.month}`,
    async () => {
      const { getSystemSetting, setSystemSetting } = await import(
        "../../storage/settingsStorage"
      );
      const { materializeAppliedConvMessagesForMonthTick } = await import(
        "../frontAppliedConvMaterializer"
      );
      const rawCp = (
        await getSystemSetting(matCpKey).catch(() => null)
      )?.value?.trim();
      let checkpoint:
        | import("../frontAnalyticsClient").EnumerationCheckpoint
        | null = null;
      if (rawCp) {
        try {
          const parsed = JSON.parse(rawCp);
          if (parsed && typeof parsed === "object") checkpoint = parsed;
        } catch {
          // corrupt checkpoint — restart from scratch (idempotent)
        }
      }
      const r = await materializeAppliedConvMessagesForMonthTick(
        m.month,
        m.monthStart,
        m.monthEnd,
        checkpoint,
      );
      if (r.done) {
        await setSystemSetting(matCpKey, "").catch(() => undefined);
      } else {
        await setSystemSetting(matCpKey, JSON.stringify(r.checkpoint)).catch(
          () => undefined,
        );
      }
      return { inserted: r.inserted, skipped: r.skipped, done: r.done };
    },
    "[frontRecentWindowFreshness]",
    // Same 15-min ceiling as the reach action: a tick is budget-bounded, so
    // a longer hold means a stalled Front call — force-release so another
    // instance resumes from the checkpoint.
    { maxHoldMs: 15 * 60_000 },
  );
  if (lockOutcome.ran && lockOutcome.result) {
    return { ran: true, ...lockOutcome.result };
  }
  return { ran: false, inserted: 0, skipped: 0, done: false };
}


// Test-only seams: registry tests exercise the drain loop and status shapes
// without real Front I/O or a populated DB.
let __recentWindowMeasureOverrideForTest:
  | typeof measureRecentWindowMonthFreshness
  | null = null;

let __recentWindowTickOverrideForTest:
  | typeof runRecentWindowMaterializerTick
  | null = null;

export function __setFrontRecentWindowFreshnessOverridesForTest(overrides: {
  measure?: typeof measureRecentWindowMonthFreshness | null;
  tick?: typeof runRecentWindowMaterializerTick | null;
}): void {
  if (overrides.measure !== undefined) {
    __recentWindowMeasureOverrideForTest = overrides.measure;
  }
  if (overrides.tick !== undefined) {
    __recentWindowTickOverrideForTest = overrides.tick;
  }
}


async function listRecentWindowFreshness(): Promise<RecentWindowMonthFreshness[]> {
  const measure =
    __recentWindowMeasureOverrideForTest ?? measureRecentWindowMonthFreshness;
  const out: RecentWindowMonthFreshness[] = [];
  for (const m of listRecentWindowMonths()) {
    out.push(await measure(m));
  }
  return out;
}


function formatRecentWindowMonth(f: RecentWindowMonthFreshness): string {
  const cov = f.coveragePct !== null ? `${f.coveragePct}%` : "no activity";
  const lag =
    f.newestMsgAt === null
      ? "no message rows yet"
      : f.lagDays !== null
        ? `${f.lagDays}d lag`
        : "lag n/a";
  return `${f.month}: ${f.materializedConvs}/${f.activeConvs} conversations materialized (${cov}, ${lag})`;
}


export const frontRecentWindowMessageFreshnessAction: ProdAction = {
  id: FRONT_RECENT_WINDOW_FRESHNESS_ID,
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Keep the rolling recent window message-grain fresh (Task #3889)",
  description:
    "Owns per-message freshness for the previous + current month — the window the Going Quiet detector and daily judgment read. Measures each month's materialized conversations against Front's own tracker (front_sync_emails) and, when a month falls behind (coverage below 90% or newest message lagging Front activity by 3+ days), walks the shared applied-conversation materializer over it in budget-bounded ticks (same per-month checkpoint + cross-instance lock as the reach-coverage action, so the drivers cooperate). One press starts a worker-pool background drain that converges the window; the hourly self-heal cadence then keeps it fresh permanently with no operator involvement — this is the automation that replaces manual coverage-recovery for recent months. Idempotent (per-message dedupe on external_source_id), breaker-aware (blocks while Front auth is dead), and honest about Front's visibility limit: a fully-walked month with residual shortfall reads not-needed until Front shows NEW activity.",
  change:
    "Worker-pool background drain over the previous + current month: per chunk, one materializeAppliedConvMessagesForMonthTick(month) under the shared front_applied_conv_materializer:<month> advisory lock, resuming the shared applied_conv_materializer_checkpoint:<month> checkpoint, writing missing per-message rows via materializeFrontMessageRecord (ON CONFLICT-safe). Completed walks stamp front_recent_window_walked:<month> in system_settings.",
  // One press hands off: the drain converges the window now, and the hourly
  // self-heal cadence re-arms whenever Front shows new activity a walk has
  // not covered — the rolling window stays fresh with no operator action.
  selfHeal: { cadenceMs: 60 * 60_000, backoffMs: 6 * 60 * 60_000 },
  async status() {
    if (isDrainRunning(FRONT_RECENT_WINDOW_FRESHNESS_ID)) {
      const s = getDrainState(FRONT_RECENT_WINDOW_FRESHNESS_ID)!;
      const matDetail = await getMaterializationProgressDetailForStatus();
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.${
          matDetail ? ` ${matDetail}.` : ""
        }`,
      };
    }
    const all = await listRecentWindowFreshness();
    const summary = all.map(formatRecentWindowMonth).join("; ");
    const pending = all.filter((f) => f.pendingWalk);
    if (pending.length === 0) {
      const staleButWalked = all.some((f) => f.stale && !f.pendingWalk);
      return {
        state: "not-needed",
        detail: staleButWalked
          ? `Rolling window walked to Front's visible limit — the remaining shortfall is not exposed by Front search; re-arms automatically when Front shows new activity (${summary}).`
          : `Rolling recent window is message-grain fresh (${summary}).`,
      };
    }
    const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
    if (frontAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "Front",
        detail: `Front login is not connected — the rolling window is behind (${summary}). Reconnect Front in the Integrations Hub and this converges automatically.`,
      };
    }
    return {
      state: "pending",
      detail: `${pending.length} rolling-window month(s) behind Front's own activity (${summary}); a single press walks the shared materializer until message-grain rows agree with Front's tracker, then the hourly cadence keeps the window fresh.`,
    };
  },
  async apply(actorId) {
    const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
    if (frontAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "Front",
        detail:
          "Front login is not connected — reconnect Front in the Integrations Hub, then the rolling window converges automatically.",
      };
    }
    // Convergence guard: a tick that neither inserted rows, nor advanced a
    // walk to done, nor even ran (lock held elsewhere) is a no-progress
    // tick; three in a row ⇒ terminate the drain and let the hourly
    // self-heal resume from the shared checkpoint (crash-recovery role).
    let consecutiveNoProgress = 0;
    const out = await startBackgroundDrain(
      {
        actionId: FRONT_RECENT_WINDOW_FRESHNESS_ID,
        actionTitle: "Keep the rolling recent window message-grain fresh",
        attributionLabel: "maintenance:prod-actions-front-recent-window",
        unit: "month(s)",
        countPending: async () =>
          (await listRecentWindowFreshness()).filter((f) => f.pendingWalk)
            .length,
        runChunk: async (): Promise<DrainChunkResult> => {
          if (frontAuthBreakerActive()) return { processed: 0 };
          const pending = (await listRecentWindowFreshness())
            .filter((f) => f.pendingWalk)
            .sort((a, b) => (a.coveragePct ?? 0) - (b.coveragePct ?? 0));
          const next = pending[0];
          if (!next) return { processed: 0 };
          const tick =
            __recentWindowTickOverrideForTest ?? runRecentWindowMaterializerTick;
          const r = await tick(next);
          if (r.ran && r.done) {
            // Walk complete — stamp the durable marker so the month stays
            // not-needed until Front shows activity NEWER than this walk.
            const { setSystemSetting } = await import(
              "../../storage/settingsStorage"
            );
            await setSystemSetting(
              recentWindowWalkedKey(next.month),
              new Date().toISOString(),
            ).catch(() => undefined);
          }
          const madeProgress =
            r.ran && (r.inserted > 0 || r.skipped > 0 || r.done);
          consecutiveNoProgress = madeProgress ? 0 : consecutiveNoProgress + 1;
          if (consecutiveNoProgress >= 3) return { processed: 0 };
          return {
            processed: 1,
            perKey: {
              ticks: 1,
              messages_inserted: r.inserted,
              messages_already_present: r.skipped,
              months_walk_completed: r.done ? 1 : 0,
            },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Task #2705: recover plan-limited months via conversation search ───────
//
// Front's analytics PLAN limit blocks the Analytics-Reports denominator for the
// older months (≈Jul–Oct 2025), so `reach_front_coverage_full` retires them once
// their convergence budget is spent and the "Bring it to 100%" math parks their
// ingest gap as a plan-upgrade remainder. But the plan limit does NOT block the
// Conversations Search API + per-message enumeration workaround (#1681/#1983),
// which can still fetch + apply those months' messages. This action (re-)drives
// the SAME search recovery helper (`reachFrontCoverageFullForMonth`) for every
// plan-limited, message-grain, search-recoverable month with an ingest gap that
// `reach_front_coverage_full` has already RETIRED (convergence budget spent) —
// so the two drivers never drive the same month in one button run. It's an
// approximation ("close enough") that chases the parked remainder instead of
// permanently walling it behind a Front plan upgrade. Reuses the existing helper (zero duplicated Front I/O), runs as a
// resumable worker-pool background drain (one month per chunk, each month at most
// once per run so it always terminates), and is breaker-aware (blocks, not
// errors, while Front auth is dead). The search-strategy switch
// (`front_recovery_sparse_month_search_strategy_enabled`) must be ON. See
// FRONT_ANALYTICS_COVERAGE.md.
const RECOVER_FRONT_PLAN_LIMITED_ID = "recover_front_plan_limited_messages";


export function __setReachFrontCoverageFullForMonthOverrideForTest(
  fn: typeof reachFrontCoverageFullForMonth | null,
): void {
  __reachFrontCoverageFullForMonthOverrideForTest = fn;
}


export async function getRecoverFrontPlanLimitedMessagesStatus(): Promise<ProdActionStatus> {
  if (isDrainRunning(RECOVER_FRONT_PLAN_LIMITED_ID)) {
    const s = getDrainState(RECOVER_FRONT_PLAN_LIMITED_ID)!;
    return {
      state: "pending",
      working: true,
      detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
    };
  }
  if (
    !isPoolEpicSwitchEnabled(
      "front_recovery_sparse_month_search_strategy_enabled",
    )
  ) {
    return {
      state: "not-needed",
      detail:
        "The search strategy switch (front_recovery_sparse_month_search_strategy_enabled) is OFF — turn it on first, otherwise driving recovery would just rebuild the legacy enumeration.",
    };
  }
  const months = await listFrontPlanLimitedSearchRecoverableMonths();
  if (months.length === 0) {
    return {
      state: "not-needed",
      detail:
        "No plan-limited month is recoverable via conversation search right now (each is either fully covered, not yet at message grain, or search itself is plan-limited for it).",
    };
  }
  const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
  if (frontAuthBreakerActive()) {
    return {
      state: "blocked",
      integration: "Front",
      detail: `Front login is not connected — ${months.length} plan-limited month(s) are waiting on the conversation-search recovery. Reconnect Front in the Integrations Hub and this converges automatically.`,
    };
  }
  const sample = months
    .slice(0, 6)
    .map((m) => `${m.month} (${m.appliedCoveragePct}%)`)
    .join(", ");
  return {
    state: "pending",
    detail: `${months.length} plan-limited month(s) can still be recovered via conversation search (${sample}); a single press drives each via the search + per-message enumeration workaround, one month per chunk (an approximation toward 100%).`,
  };
}


export async function applyRecoverFrontPlanLimitedMessages(
  actorId: string | null,
): Promise<ProdActionOutcome> {
  if (
    !isPoolEpicSwitchEnabled(
      "front_recovery_sparse_month_search_strategy_enabled",
    )
  ) {
    return {
      state: "not-needed",
      detail:
        "The search strategy switch (front_recovery_sparse_month_search_strategy_enabled) is OFF — turn it on first.",
    };
  }
  const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
  if (frontAuthBreakerActive()) {
    return {
      state: "blocked",
      integration: "Front",
      detail:
        "Front login is not connected — reconnect Front in the Integrations Hub, then this converges automatically.",
    };
  }
  // Per-run guard: each candidate month is processed at most once so the drain
  // terminates even when a month is still short of 100% afterwards (the
  // approximation may need several passes / a self-heal tick to finish).
  const processed = new Set<string>();
  const out = await startBackgroundDrain(
    {
      actionId: RECOVER_FRONT_PLAN_LIMITED_ID,
      actionTitle: "Recover plan-limited Front months via conversation search",
      attributionLabel:
        "maintenance:prod-actions-recover-front-plan-limited",
      unit: "month(s)",
      countPending: async () => {
        const months = await listFrontPlanLimitedSearchRecoverableMonths();
        return months.filter((m) => !processed.has(m.month)).length;
      },
      runChunk: async (): Promise<DrainChunkResult> => {
        const months = await listFrontPlanLimitedSearchRecoverableMonths();
        const next = months.find((m) => !processed.has(m.month));
        if (!next) return { processed: 0 };
        processed.add(next.month);
        const r = await (
          __reachFrontCoverageFullForMonthOverrideForTest ??
          reachFrontCoverageFullForMonth
        )(next);
        const advanced = r.after > r.before ? 1 : 0;
        return {
          processed: 1,
          perKey: {
            months_processed: 1,
            months_advanced: advanced,
            messages_ingested: r.ingested,
          },
        };
      },
    },
    actorId ?? null,
  );
  if (out.state === "nothing-to-do") {
    return { state: "not-needed", detail: out.detail };
  }
  return { state: "applied", detail: out.detail, rowsAffected: 0 };
}


export const recoverFrontPlanLimitedMessagesAction: ProdAction = {
  id: RECOVER_FRONT_PLAN_LIMITED_ID,
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title:
    "Recover plan-limited Front months via conversation search (Task #2705)",
  description:
    "Drives the conversation-search + per-message enumeration workaround (#1681/#1983) for every plan-limited, message-grain Front coverage month that still has an ingest gap and whose search has NOT hard-failed — the months reach_front_coverage_full retires once their convergence budget is spent. Front's analytics PLAN limit blocks only the Analytics-Reports denominator, not the Conversations Search API, so this fetches + applies those months' messages (an approximation, \"close enough\", until per-message enumeration completes) instead of permanently parking them behind a Front plan upgrade. Reuses reachFrontCoverageFullForMonth (zero duplicated Front I/O), worker-pool background drain, one month per chunk, each month at most once per run so it terminates; idempotent (per-conversation dedupe keys) and breaker-aware (blocks while Front auth is dead). Requires the search strategy switch (front_recovery_sparse_month_search_strategy_enabled) ON. Months where search ITSELF plan-limits/fails stay honestly excluded. See FRONT_ANALYTICS_COVERAGE.md.",
  change:
    "Background-drain over plan-limited, message-grain, search-recoverable front_analytics_monthly_coverage months with an ingest gap that reach_front_coverage_full has already retired (convergence budget spent), so the two drivers never overlap in one run: reachFrontCoverageFullForMonth re-probes via search + drives runTargetedWindowBackfill + recomputes local counts. One month/chunk on the worker pool; each month at most once per run.",
  // Idempotent + breaker-aware + recurring until each recoverable plan-limited
  // month is as complete as conversation search allows, so it opts into the
  // self-heal scheduler: one press hands off and the auto-healer keeps driving
  // each remaining month on a cadence (and converges once Front reconnects).
  selfHeal: { cadenceMs: 60 * 60_000, backoffMs: 6 * 60 * 60_000 },
  status: () => getRecoverFrontPlanLimitedMessagesStatus(),
  apply: (actorId) => applyRecoverFrontPlanLimitedMessages(actorId ?? null),
};


// ──── Task #2511: finish Front message-grain coverage (single control) ────
//
// The single, consolidated operator control that drives EVERY in-scope Front
// coverage month (at/after the hard-coded FRONT_ADOPTION_DATE floor) to a real
// message-grain (`messages_all`) denominator, so the all-time headline — which
// sums ONLY message-grain months (Task #2436) — reports honest message
// coverage. "Done" is `inScopeExcludedMonths === 0`
// (`listInScopeNonMessageGrainMonths()` returns no months).
//
// One press does two things in order:
//   1. FREE relabel first — `backfillInScopeMessageGrain()` converts every
//      in-scope row that already carries per-direction Front counts to message
//      grain in place with ZERO Front calls (Task #2290 conversion). Idempotent
//      and Front-free, so it runs even when Front auth is down.
//   2. ENUMERATION for the rest — a worker-pool background drain that, one month
//      per chunk, forces the per-message enumeration walk
//      (`refreshMonth({forceSearchFallback, forceRerun, forcePerMessageEnum})`)
//      to RE-MEASURE the denominator up to message grain, then recomputes that
//      month's local counts (zero extra Front calls). This is GRAIN-ONLY: it does
//      NOT drive the recovery numerator — improving the coverage *value* is the
//      job of `reach_front_coverage_full_message_grain` (Task #1920), which this
//      complements. The scheduled, switch-gated #2365 driver
//      (`front_message_grain_upgrade_enabled`) does the same grain re-measure on
//      a cadence; this action is the operator's one-press "make the headline
//      honest now" surface and needs no global switch flipped (it forces the
//      enumeration past `front_analytics_per_message_enum_enabled`).
//
// Each candidate month is processed at most once per run so the drain always
// terminates; a month whose enumeration walk needs several bounded passes is
// finished by the self-heal cadence or a later press. Breaker-aware: when Front
// auth is dead the free relabel still runs, but months still needing a Front
// re-pull report `blocked` (reconnect Front) and converge once auth heals. This
// folds in the proposed #2467 control — there is ONE button, not two.
const FINISH_FRONT_MESSAGE_GRAIN_ID = "finish_front_message_grain_coverage";


function monthBoundsFromYearMonth(
  month: string,
): { monthStart: Date; monthEnd: Date } | null {
  const [y, mo] = month.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(mo)) return null;
  return {
    monthStart: new Date(Date.UTC(y, mo - 1, 1)),
    monthEnd: new Date(Date.UTC(y, mo, 1)),
  };
}


// Grain-only re-measure of ONE in-scope month: force the per-message
// enumeration walk to lift the denominator toward message grain, then refresh
// the month's local counts (zero extra Front calls). Returns whether the row is
// at message grain afterwards. NO numerator recovery (that is reach's job).
async function finishMessageGrainForMonth(
  month: string,
  monthStart: Date,
  monthEnd: Date,
): Promise<{ reachedMessageGrain: boolean }> {
  const {
    refreshMonth,
    getExistingMonth,
    recomputeLocalCountsAllMonths,
    isMessageGrainDenominator,
  } = await import("../frontAnalyticsCoverage");
  await refreshMonth({
    month,
    monthStart,
    monthEnd,
    isCurrentMonth: false,
    forceSearchFallback: true,
    forceRerun: true,
    forcePerMessageEnum: true,
  });
  await recomputeLocalCountsAllMonths({
    dryRun: false,
    onlyMonths: [month],
  }).catch(() => undefined);
  const afterRow = await getExistingMonth(month);
  return {
    reachedMessageGrain: isMessageGrainDenominator(afterRow?.denominatorUnit),
  };
}


export async function getFinishFrontMessageGrainCoverageStatus(): Promise<
  ProdActionStatus & { running?: boolean }
> {
  // `running` distinguishes an ACTIVE background drain (re-press must be blocked,
  // show live progress) from the much more common "work remains, nothing started
  // yet" case below — which is ALSO `state: "pending"` but is the operator's cue
  // to press the button, so it must stay clickable.
  if (isDrainRunning(FINISH_FRONT_MESSAGE_GRAIN_ID)) {
    const s = getDrainState(FINISH_FRONT_MESSAGE_GRAIN_ID)!;
    return {
      state: "pending",
      running: true,
      detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
    };
  }
  const { listInScopeNonMessageGrainMonths } = await import(
    "../frontAnalyticsCoverage"
  );
  const { floorMonth, months, terminalPlanLimitedMonths } =
    await listInScopeNonMessageGrainMonths();
  if (months.length === 0) {
    // Task #2674 — when the only remaining non-message-grain in-scope months
    // are terminally plan-limited (Front's plan blocks their per-message
    // history, so they can NEVER reach message grain), the action is done:
    // there is no convertible work left. Word the done-state honestly rather
    // than claiming every in-scope month is message-grain. These months revive
    // automatically if a Front plan upgrade later clears the plan-limit memo.
    if (terminalPlanLimitedMonths.length > 0) {
      const sample = terminalPlanLimitedMonths.slice(0, 6).join(", ");
      return {
        state: "not-needed",
        detail: `Every convertible in-scope Front coverage month (at/after the ${floorMonth} adoption floor) carries a message-grain (messages_all) denominator. ${terminalPlanLimitedMonths.length} month(s) remain at conversation grain because Front's analytics plan does not expose their per-message history (${sample}) — they cannot be converted and revive only if a Front plan upgrade exposes that history.`,
      };
    }
    return {
      state: "not-needed",
      detail: `Every in-scope Front coverage month (at/after the ${floorMonth} adoption floor) already carries a message-grain (messages_all) denominator, so the all-time headline counts all of them.`,
    };
  }
  // Work exists. The free relabel needs no Front, but the months still listed
  // here lack per-direction counts and need a Front re-pull to re-measure. Use
  // the cheap in-memory breaker (no Front call on every panel poll) to report
  // amber "needs reconnect" naming Front; the self-heal tick converges it once
  // Front reconnects.
  const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
  if (frontAuthBreakerActive()) {
    return {
      state: "blocked",
      integration: "Front",
      detail: `Front login is not connected — ${months.length} in-scope month(s) are not yet at message grain. The free relabel still runs, but the rest need a Front re-pull. Reconnect Front in the Integrations Hub and this converges automatically.`,
    };
  }
  const sample = months
    .slice(0, 6)
    .map((m) => `${m.month} (${m.denominatorUnit ?? "no denominator"})`)
    .join(", ");
  return {
    state: "pending",
    detail: `${months.length} in-scope month(s) are not yet at message grain (${sample}); a single press relabels the free-convertible ones with zero Front calls, then re-pulls the rest to message grain, one month per chunk.`,
  };
}


export async function applyFinishFrontMessageGrainCoverage(
  actorId: string | null,
): Promise<ProdActionOutcome> {
  const { listInScopeNonMessageGrainMonths, backfillInScopeMessageGrain } =
    await import("../frontAnalyticsCoverage");

  // Phase 1 — FREE relabel first (zero Front calls). Converts every in-scope
  // row that already carries per-direction Front counts to message grain. Runs
  // regardless of Front auth state because it makes no Front calls.
  const relabel = await backfillInScopeMessageGrain();
  const relabelNote =
    relabel.upgraded > 0
      ? `Relabeled ${relabel.upgraded} in-scope month(s) to message grain for free. `
      : "";

  // Phase 2 — anything still excluded lacks per-direction counts and needs a
  // Front re-pull to re-measure the denominator.
  const remaining = relabel.stillExcludedMonths;
  if (remaining.length === 0) {
    if (relabel.upgraded > 0) {
      return {
        state: "applied",
        detail: `${relabelNote}Every in-scope month now carries a message-grain denominator.`,
        rowsAffected: relabel.upgraded,
      };
    }
    return {
      state: "not-needed",
      detail:
        "Every in-scope Front coverage month already carries a message-grain denominator.",
    };
  }

  const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
  if (frontAuthBreakerActive()) {
    return {
      state: "blocked",
      integration: "Front",
      detail: `${relabelNote}${remaining.length} in-scope month(s) still need a Front re-pull, but Front login is not connected. Reconnect Front in the Integrations Hub, then this converges automatically.`,
    };
  }

  // Drain the remaining months grain-only. Each month is processed at most once
  // per run (the enumeration walk advances one bounded chunk per month) so the
  // drain terminates even when a month is still sub-message-grain afterwards;
  // the self-heal cadence finishes any month whose walk needs more passes.
  const processed = new Set<string>();
  const out = await startBackgroundDrain(
    {
      actionId: FINISH_FRONT_MESSAGE_GRAIN_ID,
      actionTitle: "Finish Front message-grain coverage",
      attributionLabel: "maintenance:prod-actions-finish-front-message-grain",
      unit: "month(s)",
      countPending: async () => {
        const { months } = await listInScopeNonMessageGrainMonths();
        return months.filter((m) => !processed.has(m.month)).length;
      },
      runChunk: async (): Promise<DrainChunkResult> => {
        const { months } = await listInScopeNonMessageGrainMonths();
        const next = months.find((m) => !processed.has(m.month));
        if (!next) return { processed: 0 };
        processed.add(next.month);
        const bounds = monthBoundsFromYearMonth(next.month);
        if (!bounds) {
          return { processed: 1, perKey: { months_skipped_bad_label: 1 } };
        }
        const r = await finishMessageGrainForMonth(
          next.month,
          bounds.monthStart,
          bounds.monthEnd,
        );
        return {
          processed: 1,
          perKey: {
            months_processed: 1,
            months_reached_message_grain: r.reachedMessageGrain ? 1 : 0,
          },
        };
      },
    },
    actorId ?? null,
  );
  if (out.state === "nothing-to-do") {
    return {
      state: "applied",
      detail: `${relabelNote}${out.detail}`,
      rowsAffected: relabel.upgraded,
    };
  }
  return {
    state: "applied",
    detail: `${relabelNote}${out.detail}`,
    rowsAffected: relabel.upgraded,
  };
}


export const finishFrontMessageGrainCoverageAction: ProdAction = {
  id: FINISH_FRONT_MESSAGE_GRAIN_ID,
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Finish Front message-grain coverage (Task #2511)",
  description:
    "The single consolidated control that drives every in-scope Front coverage month (at/after the hard-coded FRONT_ADOPTION_DATE floor) to a real message-grain (messages_all) denominator so the all-time headline reports honest message coverage. One press (1) relabels every free-convertible month to message grain with ZERO Front calls (backfillInScopeMessageGrain — idempotent, runs even when Front auth is down), then (2) starts a worker-pool background drain that, one month per chunk, forces the per-message enumeration walk to RE-MEASURE the denominator up to message grain and recomputes that month's local counts (zero extra Front calls). GRAIN-ONLY — it does NOT drive the recovery numerator (that is reach_front_coverage_full_message_grain's job, Task #1920); it complements that action and the scheduled #2365 message-grain upgrade driver. Done when listInScopeNonMessageGrainMonths returns no months (inScopeExcludedMonths === 0). Idempotent, resumable (each month processed at most once per run; self-heal finishes multi-pass walks), and breaker-aware (free relabel still runs while Front auth is dead; the rest report blocked until Front reconnects). See FRONT_ANALYTICS_COVERAGE.md.",
  change:
    "Run backfillInScopeMessageGrain() (free, 0 Front calls) to relabel every convertible in-scope month to message grain, then background-drain the remaining in-scope non-message-grain months on the worker pool: refreshMonth(forceSearchFallback+forceRerun+forcePerMessageEnum) re-measures the denominator to message grain (no numerator recovery), then recomputeLocalCountsAllMonths(onlyMonths) refreshes local counts. One month/chunk; each month at most once per run.",
  // Idempotent + breaker-aware + recurring until every in-scope month is at
  // message grain, so it opts into the self-heal scheduler: one press hands off
  // and the auto-healer keeps driving each remaining month toward message grain
  // on a cadence (and converges once Front reconnects after an auth outage).
  selfHeal: { cadenceMs: 60 * 60_000, backoffMs: 6 * 60 * 60_000 },
  status: () => getFinishFrontMessageGrainCoverageStatus(),
  apply: (actorId) => applyFinishFrontMessageGrainCoverage(actorId ?? null),
};


// ─── Task #2691: exported wrappers for the "Bring it to 100%" orchestrator ──
//
// The "Bring it to 100%" Front Console button (server/services/frontBringTo100.ts)
// orchestrates these existing, individually-idempotent Front coverage drivers in
// order. Their ProdAction objects are module-local; these thin wrappers expose
// their breaker-aware `.apply()` / `.status()` so the orchestrator drives the
// SAME convergent logic the Prod Actions panel does (no duplicated drain logic,
// no `applyAllProdActions` over-broad apply). Each underlying action already
// short-circuits to `blocked` when the Front auth breaker is tripped.
export function applyBackfillFrontMessageAttribution(
  actorId: string | null,
): Promise<ProdActionOutcome> {
  return backfillFrontMessageAttributionAction.apply(actorId ?? undefined);
}

export function getBackfillFrontMessageAttributionStatus(): Promise<ProdActionStatus> {
  return backfillFrontMessageAttributionAction.status();
}

export function applyReachFrontCoverageFull(
  actorId: string | null,
): Promise<ProdActionOutcome> {
  return reachFrontCoverageFullAction.apply(actorId ?? undefined);
}

export function getReachFrontCoverageFullStatus(): Promise<ProdActionStatus> {
  return reachFrontCoverageFullAction.status();
}

/** Live drain-running flags for the three Front coverage actions the button drives. */
export function getFrontBringTo100DrainRunning(): {
  finish: boolean;
  attribution: boolean;
  reach: boolean;
  planLimited: boolean;
} {
  return {
    finish: isDrainRunning(FINISH_FRONT_MESSAGE_GRAIN_ID),
    attribution: isDrainRunning(BACKFILL_FRONT_MSG_ATTRIBUTION_ID),
    reach: isDrainRunning(REACH_FRONT_COVERAGE_FULL_ID),
    planLimited: isDrainRunning(RECOVER_FRONT_PLAN_LIMITED_ID),
  };
}


// ─── Task #2602: AI-study the materialized Front messages ───────────────
//
// The per-message materialization path (`materializeFrontMessageRecord`)
// writes one `raw_communication_records` row per historical Front message at
// `processing_status:'processed'` with NO `clientId`. Those two facts mean
// such a row never enters the classifier queue and is never studied into
// `agent_knowledge_base` (analyzeCommunication only persists client knowledge
// when a clientId is set). This action closes that gap: it walks the
// materialized rows that have not yet been studied (ai_processed_at IS NULL),
// resolves each to a client via the SAME deterministic hard-match index Front
// uses elsewhere, and for a confident match persists the clientId, CLAIMS the
// row (status → 'pending', which removes it from the candidate set), and
// enqueues the existing `analyze_communication` job so the message is
// AI-studied. Messages with no confident client are stamped terminal
// (ai_processed_at = now) — there is no client knowledge target, so studying
// them would be pure OpenAI spend.
//
// Gated behind the default-OFF `front_materialized_message_study_enabled`
// switch (studying ~100% of historical Front messages through GPT-4o is real,
// unbounded spend): when the switch is OFF the action reports `not-needed` so
// it never runs by surprise. One press starts a worker-pool background drain;
// idempotent + convergent (claiming/stamping each row removes it from
// `countPending`), and self-heal eligible so the queue keeps draining on a
// cadence once enabled.
const STUDY_MATERIALIZED_FRONT_MESSAGES_ID = "study_materialized_front_messages";

const STUDY_MATERIALIZED_FRONT_MESSAGES_CHUNK = 50; // rows per chunk — gentle on the analyze queue


export const studyMaterializedFrontMessagesAction: ProdAction = {
  id: STUDY_MATERIALIZED_FRONT_MESSAGES_ID,
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "AI-study materialized Front messages (Task #2602)",
  description:
    "Ensures every materialized historical Front message (one raw_communication_records row per message, source_subtype='email_message', at/after the FRONT_ADOPTION_DATE floor) is AI-studied like any other communication. The materialization path writes these rows as processed with NO clientId, so they never reached the classifier queue and were never studied into agent_knowledge_base. One press starts a worker-pool background drain that, " +
    String(STUDY_MATERIALIZED_FRONT_MESSAGES_CHUNK) +
    " rows per chunk, resolves each message to a client via the deterministic Front hard-match index: a confident match persists the clientId, claims the row, and enqueues the existing analyze_communication job (so it is studied via analyzeCommunication → agent_knowledge_base); a message with no confident client is stamped terminal (no client knowledge target, no OpenAI spend). Gated behind the default-OFF front_materialized_message_study_enabled switch — reports not-needed while OFF. Idempotent (each row is claimed/stamped, removing it from the pending set), convergent, and self-healing.",
  change:
    "Background-drain the materialized Front message rows (source_type='front_email', source_subtype='email_message', ai_processed_at IS NULL, processing_status='processed', direction IN inbound/outbound, timestamp >= FRONT_ADOPTION_DATE), " +
    String(STUDY_MATERIALIZED_FRONT_MESSAGES_CHUNK) +
    " rows/chunk on the worker pool: matched → set client_id + processing_status='pending' + enqueue analyze_communication (dedupeKey analyze_<id>); unmatched → stamp ai_processed_at terminal.",
  // Idempotent + convergent + recurring until every materialized message is
  // studied (or terminally stamped), so it opts into the self-heal scheduler:
  // one press hands off and the auto-healer keeps draining the queue on a
  // cadence while the switch is ON.
  selfHeal: { cadenceMs: 60 * 60_000, backoffMs: 6 * 60 * 60_000 },
  async status() {
    if (!isMaterializedMessageStudyEnabled()) {
      return {
        state: "not-needed",
        detail:
          "The front_materialized_message_study_enabled switch is OFF; enable it first to AI-study the materialized Front messages.",
      };
    }
    if (isDrainRunning(STUDY_MATERIALIZED_FRONT_MESSAGES_ID)) {
      const s = getDrainState(STUDY_MATERIALIZED_FRONT_MESSAGES_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const pending = await countPendingMaterializedMessageStudy();
    if (pending === 0) {
      return {
        state: "not-needed",
        detail:
          "Every materialized Front message has already been AI-studied or terminally stamped.",
      };
    }
    return {
      state: "pending",
      detail: `${pending} materialized Front message(s) awaiting AI study; a single press drains them ${STUDY_MATERIALIZED_FRONT_MESSAGES_CHUNK} row(s) per chunk on the worker pool.`,
    };
  },
  async apply(actorId) {
    if (!isMaterializedMessageStudyEnabled()) {
      return {
        state: "not-needed",
        detail:
          "The front_materialized_message_study_enabled switch is OFF; enable it first to AI-study the materialized Front messages.",
      };
    }
    const out = await startBackgroundDrain(
      {
        actionId: STUDY_MATERIALIZED_FRONT_MESSAGES_ID,
        actionTitle: "AI-study materialized Front messages",
        attributionLabel: "maintenance:prod-actions-front-materialized-study",
        unit: "message(s)",
        countPending: () => countPendingMaterializedMessageStudy(),
        runChunk: async (): Promise<DrainChunkResult> => {
          const r = await studyMaterializedMessageChunk(
            STUDY_MATERIALIZED_FRONT_MESSAGES_CHUNK,
          );
          return {
            processed: r.examined,
            perKey: {
              enqueued: r.enqueued,
              matched_existing: r.matchedExisting,
              unmatched_stamped: r.unmatchedStamped,
            },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};

// ─── Domain collection (F7) ──────────────────────────────────────────
// Membership list for the composition-root guard: every registry action
// this module defines. Operator-facing order lives in ./composition.ts.
export const frontCoverageDomain: ProdActionDomain = {
  name: "frontCoverage",
  actions: [
    drainFront122kBacklogAction,
    relabelFrontCoverageUnitsAction,
    purgePreFloorFrontCoverageRowsAction,
    repairFrontCoverageDenominatorFloorAction,
    refreshFinalizedFrontCoverageLocalCountsAction,
    enableFrontRecoveryPerMessageMaterializationAction,
    backfillFrontMessageAttributionAction,
    reachFrontCoverageFullAction,
    frontRecentWindowMessageFreshnessAction,
    recoverFrontPlanLimitedMessagesAction,
    finishFrontMessageGrainCoverageAction,
    studyMaterializedFrontMessagesAction,
    purgeDeadFrontAdoptionDateSettingAction,
  ],
};
