// @db-pool-intent: worker
/**
 * Prod-action domain module (F7, Task #4154): Front historical recovery — checkpoint unblock/cancel/reset levers, dedupe-key backfills, re-match drains, and the 2025-11 window rerun.
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
import { storage } from "../../storage";
import { bindArrayParam } from "../../utils/sqlArray";
import {
  setPoolEpicSwitch,
  isPoolEpicSwitchEnabled,
  ensurePoolEpicSwitchesLoaded,
} from "../poolEpicKillSwitches";
import {
  startBackgroundDrain,
  getDrainState,
  formatDrainProgress,
  isDrainRunning,
} from "../prodActionBackgroundDrain";
import {
  FAILED_RETRO_CLEANUP_CHUNK,
  countFailedNoHandlerRows,
  getAffectedActiveClientIds,
  enqueueReprocessForAffectedClients,
  deleteFailedNoHandlerChunk,
} from "../failedRetroactiveBacklogCleanup";
import {
  evaluateFrontMirrorFreshness,
  getFrontMirrorFreshnessConfig,
} from "../frontMirrorFreshnessAlerts";
import {
  type ProdAction,
  type ProdActionDomain,
  type ProdActionOutcome,
  type ProdActionStatus,
} from "./kernel";


// ─── Front backlog cancel action (Task #1803 Stage 2) ────────────────
//
// Cancels stale rows in three Front queues:
//   - front_webhook_apply
//   - front_webhook_normalize
//   - front_sync_reprocess
//
// Statuses targeted: `failed` and `dead_letter` in all three queues
// only. Per Task #1787 Stage 2 and the canonical
// `scripts/cancel-stale-front-backlog.ts`, **pending and processing
// rows are NEVER touched** — they can still drain on their own and
// cancelling them risks discarding live recoverable work. Each
// cancelled row gets `error_message` prefixed with `[task-1804] ` so
// the cancellation is auditable. Idempotent: re-running finds zero
// candidates because cancelled rows no longer match the WHERE filter.
const FRONT_CANCEL_QUEUES = [
  "front_webhook_apply",
  "front_webhook_normalize",
  "front_sync_reprocess",
] as const;

const FRONT_CANCEL_REASON_PREFIX = "[task-1804] ";


// ─── Task #1869 Step 3 — Manual unblock pass for poisoned recovery checkpoints ───
//
// One-press operator escape hatch that runs the same logic the auto-
// closure tick now executes every cycle, but with `force=true` so the
// `front_auto_unblock_enabled` kill switch is bypassed. Useful when an
// operator wants to drain poison rows immediately without flipping the
// kill switch on. Idempotent: once Front is healthy and the rows are
// rewritten to `partial`, a second press reports `not-needed`.
export const unblockPoisonedFrontRecoveryCheckpointsAction: ProdAction = {
  id: "unblock_poisoned_front_recovery_checkpoints",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Unblock poisoned Front recovery checkpoints (Task #1869)",
  description:
    "Scans `front_recovery_checkpoint_*` system settings for rows stuck `blocked` with an OAuth-race reason (`front_auth_unauthorized_after_refresh`, `front_not_connected`, `front_auth_refresh_failed`), runs one shared `/me` probe, and if Front is healthy rewrites them to `status='partial'` so auto-closure resumes them from the saved page cursor. Forces past the `front_auto_unblock_enabled` kill switch. Skips the `2999_*` test-poison windows (use the dedicated cancel action for those).",
  change:
    "UPDATE system_settings → status='partial' for poisoned Front recovery checkpoint rows when /me probe confirms the connection is healthy.",
  // Task #2281 — idempotent (a second press once Front is healthy reports
  // not-needed) and breaker-aware (blocks, not errors, while Front auth is
  // dead), so it opts into the self-heal scheduler: one press hands off and
  // the auto-healer drains the poison rows the moment Front reconnects
  // instead of sitting perpetually in the panel's "remaining" bucket.
  selfHeal: { cadenceMs: 30 * 60_000, backoffMs: 2 * 60 * 60_000 },
  async status() {
    const result = await withDbAttribution(
      "maintenance:prod-actions-unblock-poisoned-front-recovery-count",
      () =>
        getDb().execute(sql`
          SELECT key, value
          FROM system_settings
          WHERE key LIKE 'front_recovery_checkpoint_%'
        `),
    );
    let n = 0;
    for (const row of result.rows as Array<{ key: string; value: string | null }>) {
      if (!row.value) continue;
      try {
        const cp = JSON.parse(row.value);
        if (cp?.status !== "blocked") continue;
        const reason = String(cp?.statusReason ?? "");
        if (
          reason !== "front_auth_unauthorized_after_refresh" &&
          reason !== "front_not_connected" &&
          reason !== "front_auth_refresh_failed"
        ) continue;
        if (typeof cp?.windowLabel === "string" && /(^|[:_])2999[_-]/.test(cp.windowLabel)) continue;
        n++;
      } catch { /* skip unparseable */ }
    }
    if (n === 0) {
      return { state: "not-needed", detail: "No poisoned Front recovery checkpoints to unblock." };
    }
    // Task #2281 — there IS work, but a press would only return `blocked`
    // while Front auth is dead. Use the cheap in-memory breaker (no `/me`
    // probe — status() loads on every panel poll) to report amber "needs
    // reconnect" naming Front instead of a misleading red/manual "pending".
    // Once Front reconnects the self-heal tick converges it automatically.
    const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
    if (frontAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "Front",
        detail: `Front login is not connected — ${n} poisoned checkpoint(s) are waiting. Reconnect Front in the Integrations Hub and this converges automatically.`,
      };
    }
    return { state: "pending", detail: `${n} poisoned Front recovery checkpoint(s) would be re-probed and unblocked.` };
  },
  async apply(actorId) {
    const { tryAutoUnblockPoisonedCheckpoints } = await import("../frontHistoricalRecovery");
    const summary = await tryAutoUnblockPoisonedCheckpoints({
      force: true,
      actorId: actorId ?? undefined,
    });
    if (summary.scanned === 0) {
      return { state: "not-needed", detail: "No poisoned Front recovery checkpoints to unblock." };
    }
    if (summary.unblocked === 0) {
      // Task #2111 — the dominant reason nothing unblocked is that the
      // shared `/me` probe came back not-connected (expired/disconnected
      // Front login). That is operator-recoverable, not a bug: report it
      // as blocked (amber, "needs reconnect"), not a red error. A probe
      // that DID connect but still unblocked nothing is a genuine error.
      if (summary.probeOutcome !== "connected") {
        return {
          state: "blocked",
          integration: "Front",
          detail: `Front login is not connected (probe=${summary.probeOutcome}). ${summary.scanned} poisoned checkpoint(s) are waiting — reconnect Front in the Integrations Hub, then this will resume automatically.`,
        };
      }
      return {
        state: "error",
        detail: `Probe outcome=${summary.probeOutcome}. Scanned ${summary.scanned}, none unblocked.`,
      };
    }
    return {
      state: "applied",
      detail: `Unblocked ${summary.unblocked} of ${summary.scanned} poisoned checkpoint(s) — probe=${summary.probeOutcome}.`,
      rowsAffected: summary.unblocked,
    };
  },
};


// ─── Task #1869 Step 4 — Cancel `2999_*` test-poison checkpoint rows ───
export const cancelFront2999PoisonCheckpointsAction: ProdAction = {
  id: "cancel_front_recovery_2999_poison_checkpoints",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot cleanup of three known test-poison rows, already settled in production — a re-arm means new far-future checkpoints appeared, a bug to investigate rather than routine mop-up.",
  },
  title: "Cancel Front recovery 2999_* test-poison checkpoints (Task #1869)",
  description:
    "Transitions the three far-future test-poison checkpoint rows (`front_recovery_checkpoint_auto_closure_2999_01/02/03`) from `blocked` → `cancelled` with a `[backlog-cleanup 2026-05]` prefix on the statusReason. These rows are leftovers from a long-ago test run and have polluted blocked-count alerting forever. Idempotent: a second press reports `not-needed`.",
  change:
    "UPDATE system_settings → status='cancelled' for the three known `_2999_*` poison checkpoint rows.",
  async status() {
    let pending = 0;
    for (const key of [
      "front_recovery_checkpoint_auto_closure_2999_01",
      "front_recovery_checkpoint_auto_closure_2999_02",
      "front_recovery_checkpoint_auto_closure_2999_03",
    ]) {
      const setting = await storage.getSystemSetting(key);
      if (!setting?.value) continue;
      try {
        const cp = JSON.parse(setting.value);
        if (cp?.status && cp.status !== "cancelled") pending++;
      } catch { /* unparseable counts as needing cleanup */ pending++; }
    }
    if (pending === 0) {
      return { state: "not-needed", detail: "No 2999_* test-poison checkpoints need cancellation." };
    }
    return { state: "pending", detail: `${pending} test-poison checkpoint row(s) would be cancelled.` };
  },
  async apply(actorId) {
    const { cancelFront2999PoisonCheckpoints } = await import("../frontHistoricalRecovery");
    const out = await cancelFront2999PoisonCheckpoints({ actorId: actorId ?? undefined });
    if (out.cancelled === 0 && out.alreadyCancelled > 0) {
      return { state: "not-needed", detail: `All ${out.alreadyCancelled} 2999_* row(s) already cancelled.` };
    }
    if (out.cancelled === 0) {
      return { state: "not-needed", detail: "No 2999_* test-poison checkpoints found." };
    }
    return {
      state: "applied",
      detail: `Cancelled ${out.cancelled} 2999_* checkpoint row(s) (already=${out.alreadyCancelled}, missing=${out.missing}).`,
      rowsAffected: out.cancelled,
    };
  },
};


export const cancelStaleFrontBacklogAction: ProdAction = {
  id: "cancel_stale_front_backlog",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Cancel stale Front backlog rows",
  description:
    "Cancels failed + dead_letter rows in front_webhook_apply, front_webhook_normalize, and front_sync_reprocess. Pending and processing rows are NEVER touched (Task #1787 Stage 2 constraint).",
  change:
    "UPDATE work_queue SET status='cancelled' for failed+dead_letter Front rows across the three Front queues.",
  // Task #2086 — backlog accumulates continuously; check often.
  selfHeal: { cadenceMs: 30 * 60_000, backoffMs: 2 * 60 * 60_000 },
  async status() {
    const result = await withDbAttribution(
      "maintenance:prod-actions-front-backlog-count",
      () =>
        getDb().execute(sql`
          SELECT COUNT(*)::int AS n
          FROM work_queue
          WHERE queue_name = ANY(${bindArrayParam([...FRONT_CANCEL_QUEUES], "text")})
            AND status IN ('failed', 'dead_letter')
        `),
    );
    const n = Number((result.rows as any[])[0]?.n ?? 0);
    if (n === 0) {
      return { state: "not-needed", detail: "No stale Front backlog rows to cancel." };
    }
    return { state: "pending", detail: `${n} stale Front backlog row(s) would be cancelled.` };
  },
  async apply() {
    const updated = await withDbAttribution(
      "maintenance:prod-actions-front-backlog-cancel",
      () =>
        getDb().execute(sql`
          UPDATE work_queue
          SET status = 'cancelled',
              error_message = CASE
                WHEN error_message IS NULL OR error_message = ''
                  THEN ${FRONT_CANCEL_REASON_PREFIX} || status
                ELSE ${FRONT_CANCEL_REASON_PREFIX} || error_message
              END,
              updated_at = NOW()
          WHERE queue_name = ANY(${bindArrayParam([...FRONT_CANCEL_QUEUES], "text")})
            AND status IN ('failed', 'dead_letter')
          RETURNING queue_name
        `),
    );
    const rowsAffected = updated.rowCount ?? (updated.rows as any[]).length;
    if (rowsAffected === 0) {
      return { state: "not-needed", detail: "No stale Front backlog rows to cancel." };
    }
    const tally: Record<string, number> = {};
    for (const r of updated.rows as any[]) {
      tally[r.queue_name] = (tally[r.queue_name] ?? 0) + 1;
    }
    const summary = Object.entries(tally)
      .map(([q, n]) => `${q}: ${n}`)
      .join(", ");
    return {
      state: "applied",
      detail: `Cancelled ${rowsAffected} row(s) — ${summary}.`,
      rowsAffected,
    };
  },
};


// ─── Auto-recover the Front email mirror when it freezes (Task #2172) ───
//
// Task #2146's freshness watcher (`frontMirrorFreshnessAlerts.ts`) only
// DETECTS a frozen `front_sync_emails` mirror — webhooks arriving but the
// mirror's newest row falling behind — and pages an operator. The single
// operator-recoverable cause is the `front_sync_emails_mirror_enabled`
// pool-epic kill switch being OFF (writer intentionally/accidentally
// disabled). This action re-enables that switch, but ONLY when the shared
// detection core (`evaluateFrontMirrorFreshness`) reports state="frozen"
// with live webhooks AND the switch is currently OFF. It opts into Task
// #2086 self-heal so the CEO no longer has to flip it by hand after a
// freeze.
//
// Deliberate guards keep it from acting outside that exact condition:
//   * Planned-maintenance lever: if the operator silenced detection via
//     `front_mirror_freshness_alert_enabled = false` (the documented way
//     to disable the mirror for maintenance), this stands down — never
//     fights an intentional disable.
//   * Quiet periods / upstream stalls (state="no_webhook_traffic") and a
//     healthy keeping-up mirror (state="mirror_fresh") → not-needed.
//   * Writer switch already ON but still frozen → a BROKEN writer, not a
//     disabled one. Re-enabling can't help, so it reports not-needed and
//     leaves it for the alert + human investigation. This also keeps the
//     action idempotent: a second run after a successful flip sees the
//     switch ON and does nothing.
export const recoverFrozenFrontMirrorAction: ProdAction = {
  id: "recover_frozen_front_mirror",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Auto-recover frozen Front email mirror",
  description:
    "Re-enables the front_sync_emails_mirror_enabled pool-epic kill switch when the Task #2146 freshness watcher detects a frozen mirror (live Front webhooks arriving but the mirror's newest row far behind) AND the writer switch is currently OFF. No-op during quiet periods, when the mirror is keeping up, when the writer is already ON (a broken writer needs human investigation, not a re-enable), or when freshness detection is disabled for planned maintenance (front_mirror_freshness_alert_enabled=false).",
  change:
    "Set front_sync_emails_mirror_enabled = true (only when the mirror is frozen with live webhooks and the switch is currently OFF).",
  // Task #2172 — a freeze is rare; the steady state is not-needed. Check
  // soon after a recovery (cadence) to confirm the switch held, back off
  // for an hour otherwise so an idle/healthy mirror isn't probed every
  // tick.
  selfHeal: { cadenceMs: 15 * 60_000, backoffMs: 60 * 60_000 },
  async status() {
    const config = await getFrontMirrorFreshnessConfig();
    if (!config.enabled) {
      return {
        state: "not-needed",
        detail:
          "Front mirror freshness detection is disabled (front_mirror_freshness_alert_enabled=false) — planned maintenance; auto-recovery stands down.",
      };
    }
    await ensurePoolEpicSwitchesLoaded();
    const ev = await evaluateFrontMirrorFreshness(Date.now(), config);
    if (ev.state !== "frozen") {
      return {
        state: "not-needed",
        detail:
          ev.state === "no_webhook_traffic"
            ? `No live Front webhook traffic — quiet period or upstream stall (${ev.reason}); nothing to recover.`
            : `Mirror is keeping up with live intake (${ev.reason}).`,
      };
    }
    if (ev.mirrorSwitchEnabled) {
      return {
        state: "not-needed",
        detail:
          "Mirror frozen but front_sync_emails_mirror_enabled is already ON — the writer is broken (not disabled). Re-enabling can't help; needs investigation. See the freshness alert.",
      };
    }
    return {
      state: "pending",
      detail: `Mirror frozen with live Front webhooks (${ev.reason}) and front_sync_emails_mirror_enabled is OFF — will re-enable the writer.`,
    };
  },
  async apply(actorId) {
    const config = await getFrontMirrorFreshnessConfig();
    if (!config.enabled) {
      return {
        state: "not-needed",
        detail:
          "Front mirror freshness detection is disabled (front_mirror_freshness_alert_enabled=false) — planned maintenance; auto-recovery stands down.",
      };
    }
    await ensurePoolEpicSwitchesLoaded();
    const ev = await evaluateFrontMirrorFreshness(Date.now(), config);
    if (ev.state !== "frozen") {
      return {
        state: "not-needed",
        detail:
          ev.state === "no_webhook_traffic"
            ? `No live Front webhook traffic — quiet period or upstream stall (${ev.reason}); nothing to recover.`
            : `Mirror is keeping up with live intake (${ev.reason}).`,
      };
    }
    if (ev.mirrorSwitchEnabled) {
      return {
        state: "not-needed",
        detail:
          "Mirror frozen but front_sync_emails_mirror_enabled is already ON — the writer is broken (not disabled). Re-enabling can't help; needs investigation. See the freshness alert.",
      };
    }
    await setPoolEpicSwitch(
      "front_sync_emails_mirror_enabled",
      true,
      actorId ?? undefined,
    );
    return {
      state: "applied",
      detail: `Re-enabled front_sync_emails_mirror_enabled — mirror was frozen with live Front webhooks (${ev.reason}). The writer resumes on the next normalize-stage run.`,
      rowsAffected: 1,
    };
  },
};


// ─── Task #1911: Backfill Front recovery legacy dedupe keys ──────────
//
// Single source of truth for rewriting legacy Front recovery dedupe keys.
// (The old `scripts/backfill-front-recovery-dedupe-keys.ts` CLI was
// retired once this one-press background drain took over the job.)
// Rewrites legacy `source_event_log` rows whose `dedupe_key` ends in a
// trailing empty colon (`front:recovery:cnv_xxx:`, `front:reconcile:cnv_xxx:`,
// `front:backfill:cnv_xxx:`) to the new versioned shape using
// `extractFrontConvMessageVersion` against the stored `payload_json`.
// If the rewritten key collides with an already-present row (recovery
// re-traversed the conv post-fix), the legacy row is DELETEd instead so
// the unique index is freed for future version-bumped re-ingest.
//
// Done row-by-row because each row may either UPDATE or DELETE based on
// a per-row unique-violation outcome. One-and-done (Task #1969): a
// single press starts a background drain that processes
// BACKFILL_DEDUPE_KEYS_PER_PRESS rows per chunk (keeping each chunk
// well under the 10s DB-hold cap) on the worker pool until exhausted,
// then writes the final tally to History. Idempotent.
const BACKFILL_DEDUPE_KEYS_PER_PRESS = 2000;

const BACKFILL_DEDUPE_LEGACY_PREFIXES = [
  "front:recovery:",
  "front:reconcile:",
  "front:backfill:",
] as const;


function rewriteLegacyDedupeKey(
  dedupeKey: string,
  payload: any,
  extractVersion: (conv: any) => string,
): string | null {
  for (const prefix of BACKFILL_DEDUPE_LEGACY_PREFIXES) {
    if (!dedupeKey.startsWith(prefix)) continue;
    const inner = dedupeKey.slice(prefix.length);
    if (!inner.endsWith(":")) return null;
    const convId = inner.slice(0, -1);
    if (convId.length === 0) return null;
    // extractFrontConvMessageVersion always returns a non-empty string
    // (falls back to a timestamp, then to the `"noversion"` sentinel).
    const version = extractVersion(payload);
    if (!version) return null;
    return `${prefix}${convId}:${version}`;
  }
  return null;
}


function isUniqueViolation(err: unknown): boolean {
  const code = (err as any)?.code ?? (err as any)?.cause?.code;
  return code === "23505";
}


export const backfillFrontRecoveryDedupeKeysAction: ProdAction = {
  id: "backfill_front_recovery_dedupe_keys",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot legacy dedupe-key rewrite, settled once applied — a re-arm means legacy-shaped keys are being written again (a writer regression to investigate, not silently rewrite).",
  },
  title: "Backfill Front recovery legacy dedupe keys (Task #1911)",
  description:
    "Rewrites `source_event_log` rows whose `dedupe_key` is the legacy trailing-empty-colon shape (`front:recovery:cnv_xxx:`, `front:reconcile:cnv_xxx:`, `front:backfill:cnv_xxx:`) to the post-Task-#1887 versioned shape using `extractFrontConvMessageVersion` against the stored `payload_json`. If the rewritten key collides with an already-present row (recovery re-traversed post-fix), the legacy row is DELETEd so the UNIQUE index is freed. While legacy rows remain, any new inbound message on those threads collides on the conv-level key and is silently dropped — this action unblocks ingest for them. One-and-done: a single press starts a background drain that processes " +
    String(BACKFILL_DEDUPE_KEYS_PER_PRESS) +
    " rows per chunk on the worker pool until exhausted, then writes the final tally to History. Idempotent.",
  change:
    "UPDATE source_event_log.dedupe_key with rewritten versioned key per row, or DELETE the legacy row on unique-violation collision. Only touches `source_system='front'` rows with `dedupe_key LIKE '%:'` matching one of the three legacy Front prefixes.",
  async status() {
    const result = await withDbAttribution(
      "maintenance:prod-actions-backfill-front-dedupe-count",
      () =>
        getDb().execute(sql`
          SELECT COUNT(*)::int AS n
          FROM source_event_log
          WHERE source_system = 'front'
            AND dedupe_key LIKE '%:'
            AND (
              dedupe_key LIKE 'front:recovery:%'
              OR dedupe_key LIKE 'front:reconcile:%'
              OR dedupe_key LIKE 'front:backfill:%'
            )
        `),
    );
    const n = Number((result.rows as any[])[0]?.n ?? 0);
    if (n === 0) {
      return {
        state: "not-needed",
        detail: "No legacy trailing-empty-colon Front dedupe keys remain.",
      };
    }
    return {
      state: "pending",
      detail: `${n} legacy Front dedupe-key row(s) would be rewritten via background drain (${BACKFILL_DEDUPE_KEYS_PER_PRESS} per chunk).`,
    };
  },
  async apply(actorId) {
    const { extractFrontConvMessageVersion } = await import(
      "../frontConvMessageVersion"
    );
    const out = await startBackgroundDrain(
      {
        actionId: "backfill_front_recovery_dedupe_keys",
        actionTitle: "Backfill Front recovery legacy dedupe keys",
        attributionLabel: "maintenance:prod-actions-backfill-front-dedupe",
        countPending: async () => {
          const r = await withDbAttribution(
            "maintenance:prod-actions-backfill-front-dedupe-count",
            () => getDb().execute(sql`
              SELECT COUNT(*)::int AS n
              FROM source_event_log
              WHERE source_system = 'front'
                AND dedupe_key LIKE '%:'
                AND (
                  dedupe_key LIKE 'front:recovery:%'
                  OR dedupe_key LIKE 'front:reconcile:%'
                  OR dedupe_key LIKE 'front:backfill:%'
                )
            `),
          );
          return Number((r.rows as any[])[0]?.n ?? 0);
        },
        runChunk: async () => {
          const rows = await withDbAttribution(
            "maintenance:prod-actions-backfill-front-dedupe-fetch",
            () => getDb().execute<{
              id: string;
              dedupe_key: string;
              payload_json: any;
            }>(sql`
              SELECT id, dedupe_key, payload_json
              FROM source_event_log
              WHERE source_system = 'front'
                AND dedupe_key LIKE '%:'
                AND (
                  dedupe_key LIKE 'front:recovery:%'
                  OR dedupe_key LIKE 'front:reconcile:%'
                  OR dedupe_key LIKE 'front:backfill:%'
                )
              ORDER BY id ASC
              LIMIT ${BACKFILL_DEDUPE_KEYS_PER_PRESS}
            `),
          );
          const batch = (rows.rows as Array<{
            id: string;
            dedupe_key: string;
            payload_json: any;
          }>) ?? [];
          if (batch.length === 0) return { processed: 0 };
          let rewritten = 0;
          let deletedConflict = 0;
          let skipped = 0;
          for (const row of batch) {
            const next = rewriteLegacyDedupeKey(
              row.dedupe_key,
              row.payload_json,
              extractFrontConvMessageVersion,
            );
            if (!next) {
              skipped++;
              continue;
            }
            try {
              await withDbAttribution(
                "maintenance:prod-actions-backfill-front-dedupe-update",
                () => getDb().execute(sql`
                  UPDATE source_event_log
                  SET dedupe_key = ${next},
                      updated_at = NOW()
                  WHERE id = ${row.id}
                `),
              );
              rewritten++;
            } catch (err) {
              if (!isUniqueViolation(err)) {
                throw err;
              }
              await withDbAttribution(
                "maintenance:prod-actions-backfill-front-dedupe-delete",
                () => getDb().execute(sql`
                  DELETE FROM source_event_log WHERE id = ${row.id}
                `),
              );
              deletedConflict++;
            }
          }
          return {
            processed: rewritten + deletedConflict,
            perKey: {
              rewritten,
              deletedConflict,
              ...(skipped > 0 ? { skipped } : {}),
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


// ─── Task #1963 — Reset stuck Front recovery checkpoints ─────────────
//
// Companion to `unblockPoisonedFrontRecoveryCheckpointsAction`. That
// one targets `status='blocked'` rows poisoned by the OAuth race.
// This one targets `status='partial'` rows that hit the 500-page
// safety cap on the legacy `/conversations?` enumeration — clearing
// `lastPageUrl` so the next auto-closure tick re-enters
// `buildInitialPath` and (with the Task #1963 gate lift) picks the
// search endpoint. See `resetStuckRecoveryCheckpoints` in
// `frontHistoricalRecovery.ts` for the filter + idempotency contract.
export const resetStuckFrontRecoveryCheckpointsAction: ProdAction = {
  id: "reset_stuck_front_recovery_checkpoints",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot repair for a legacy stuck-checkpoint shape (safety_max_pages_reached on the legacy endpoint) — a re-arm means that legacy shape reappeared; investigate before clearing checkpoints again.",
  },
  title: "Reset stuck Front recovery checkpoints (Task #1963)",
  description:
    "Scans `front_recovery_checkpoint_*` system settings for windows stuck `status='partial' statusReason~'safety_max_pages_reached*' lastPageUrl~'/conversations?...'` and clears their lastPageUrl / scanned / skipped / pages so the next auto-closure tick rebuilds the path on the `/conversations/search/<query>` endpoint. Window bounds and cumulative ingest counters are preserved. Forces past the `front_recovery_checkpoint_reset_enabled` kill switch. Idempotent: a checkpoint with empty lastPageUrl no longer matches.",
  change:
    "UPDATE system_settings → clear lastPageUrl/scanned/skipped/pages on stuck partial Front recovery checkpoint rows.",
  async status() {
    const result = await withDbAttribution(
      "maintenance:prod-actions-reset-stuck-front-recovery-count",
      () =>
        getDb().execute(sql`
          SELECT key, value
          FROM system_settings
          WHERE key LIKE 'front_recovery_checkpoint_%'
        `),
    );
    let n = 0;
    for (const row of result.rows as Array<{ key: string; value: string | null }>) {
      if (!row.value) continue;
      try {
        const cp = JSON.parse(row.value);
        if (cp?.status !== "partial") continue;
        const reason = String(cp?.statusReason ?? "");
        if (!reason.includes("safety_max_pages_reached")) continue;
        const lastPageUrl = String(cp?.lastPageUrl ?? "");
        if (!lastPageUrl) continue;
        if (!/\/conversations\?/.test(lastPageUrl)) continue;
        if (typeof cp?.windowLabel === "string" && /(^|[:_])2999[_-]/.test(cp.windowLabel)) continue;
        n++;
      } catch { /* skip unparseable */ }
    }
    if (n === 0) {
      return { state: "not-needed", detail: "No stuck Front recovery checkpoints to reset." };
    }
    return { state: "pending", detail: `${n} stuck Front recovery checkpoint(s) would be reset to the search endpoint.` };
  },
  async apply(actorId) {
    const { resetStuckRecoveryCheckpoints } = await import("../frontHistoricalRecovery");
    const summary = await resetStuckRecoveryCheckpoints({
      force: true,
      actorId: actorId ?? undefined,
    });
    if (summary.scanned === 0) {
      return { state: "not-needed", detail: "No stuck Front recovery checkpoints to reset." };
    }
    return {
      state: "applied",
      detail: `Reset ${summary.reset} of ${summary.scanned} stuck checkpoint(s); skipped=${summary.skipped}.`,
      rowsAffected: summary.reset,
    };
  },
};


// ─── Task #1963 — Mark legacy front_email pending rows terminal ──────
//
// `raw_communication_records` has ~35k `pending` `front_email` rows
// that no worker advances (the path was deprecated when the live
// pipeline moved to `front_sync_emails`). They inflate every
// pending-rows dashboard forever. This action transitions every
// `source_type='front_email' AND processing_status='pending' AND
// created_at < NOW() - INTERVAL '30 days'` row to `failed` with an
// `operational_classification_reason` prefixed `[backlog-drain 2026-05]` so they stop
// counting as live work. Idempotent: a second press matches zero
// rows because the WHERE clause requires `pending`.
//
// Task #3533 — the 30-day age floor is GONE. It existed to protect
// genuinely-recent rows a (possibly-revived) classifier might still pick
// up, but it also meant the daily webhook-ingest 'pending' stream (100–450
// rows/day, no consumer) aged into "legacy" work forever, so this action
// never converged. The feeder is now fixed at source
// (frontWebhookIngestion writes thread envelopes 'processed' at ingest),
// so the remaining pool is finite and one press drains it. Two guards
// replace the floor:
//   - a 1-hour freshness guard, so a manual-ingest row whose immediate
//     analyzeCommunication call is still in flight (or briefly failed and
//     retried) is never yanked out from under it;
//   - sourceSubtype 'email_message' is excluded, because the opt-in
//     materialized-message study driver transiently flips those rows to
//     'pending' while an `analyze_communication` job is queued.
const LEGACY_FRONT_EMAIL_DRAIN_PREFIX = "[backlog-drain 2026-05] deprecated_path: ";

export const markLegacyFrontEmailPendingTerminalAction: ProdAction = {
  id: "mark_legacy_front_email_pending_terminal",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Mark legacy front_email pending rows terminal (Task #1963)",
  description:
    "Transitions `raw_communication_records` rows where source_type='front_email' AND processing_status='pending' AND created_at < NOW() - INTERVAL '1 hour' AND source_subtype IS DISTINCT FROM 'email_message' to processing_status='failed' with `operational_classification_reason` prefixed '[backlog-drain 2026-05] deprecated_path: …' (this table has no `error_message` column). These rows are leftovers from a decommissioned classifier path; no worker advances them and they inflate pending-row dashboards. Task #3533 removed the old 30-day age floor (the webhook feeder that justified it now writes terminal at ingest) and excluded 'email_message' rows (transiently pending while the study driver's analyze job runs). Idempotent: subsequent presses match zero rows.",
  change:
    "UPDATE raw_communication_records SET processing_status='failed', operational_classification_reason=prefix||... WHERE source_type='front_email' AND processing_status='pending' AND created_at < NOW() - INTERVAL '1 hour' AND source_subtype IS DISTINCT FROM 'email_message'.",
  // Task #2086 — legacy rows age in slowly; a few times a day is enough.
  selfHeal: { cadenceMs: 6 * 60 * 60_000, backoffMs: 24 * 60 * 60_000 },
  async status() {
    const result = await withDbAttribution(
      "maintenance:prod-actions-legacy-front-email-pending-count",
      () =>
        getDb().execute(sql`
          SELECT COUNT(*)::int AS n
          FROM raw_communication_records
          WHERE source_type = 'front_email'
            AND processing_status = 'pending'
            AND created_at < NOW() - INTERVAL '1 hour'
            AND source_subtype IS DISTINCT FROM 'email_message'
        `),
    );
    const n = Number((result.rows as any[])[0]?.n ?? 0);
    if (n === 0) {
      return { state: "not-needed", detail: "No legacy pending front_email rows to mark terminal." };
    }
    return { state: "pending", detail: `${n} legacy pending front_email row(s) would be marked failed.` };
  },
  async apply() {
    const updated = await withDbAttribution(
      "maintenance:prod-actions-legacy-front-email-pending-update",
      () =>
        getDb().execute(sql`
          UPDATE raw_communication_records
          SET processing_status = 'failed',
              operational_classification_reason = CASE
                WHEN operational_classification_reason IS NULL OR operational_classification_reason = ''
                  THEN ${LEGACY_FRONT_EMAIL_DRAIN_PREFIX} || 'no_worker_advances_front_email_pending'
                ELSE ${LEGACY_FRONT_EMAIL_DRAIN_PREFIX} || operational_classification_reason
              END,
              updated_at = NOW()
          WHERE source_type = 'front_email'
            AND processing_status = 'pending'
            AND created_at < NOW() - INTERVAL '1 hour'
            AND source_subtype IS DISTINCT FROM 'email_message'
          RETURNING id
        `),
    );
    const rowsAffected = updated.rowCount ?? (updated.rows as any[]).length;
    if (rowsAffected === 0) {
      return { state: "not-needed", detail: "No legacy pending front_email rows to mark terminal." };
    }
    return {
      state: "applied",
      detail: `Marked ${rowsAffected} legacy pending front_email row(s) as failed with the [backlog-drain 2026-05] prefix.`,
      rowsAffected,
    };
  },
};


// ──────────── Task #2085: re-arm parked Front recovery windows ────────────
//
// The Front auto-closure loop parks a recovery window after a streak of
// page-cap "dead runs" (scanned thousands, ingested zero). Phase 1 added
// an automatic pre-park search escalation, but windows that were ALREADY
// parked under the old legacy-strategy behavior never get that second
// chance. This action gives the operator a single throttled press that
// re-runs every parked window once under the search strategy:
//   • windows that ingest rows or prove fully-covered are unparked.
//   • windows that still hit the page cap with 0 ingested stay parked,
//     with the outcome stamped onto the parked entry (Phase 3 telemetry).
// One window per chunk on the worker pool; each window's own page budget
// and inter-page throttle bound the Front API load.
export const rearmParkedFrontRecoveryWindowsAction: ProdAction = {
  id: "rearm_parked_front_recovery_windows",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Costly Front-API re-scan of every parked window under the search strategy — the operator decides when to spend that budget (and the strategy switch must be deliberately ON first).",
  },
  title: "Re-arm parked Front recovery windows under search strategy (Task #2085)",
  description:
    "Re-runs every parked Front auto-closure recovery window once under the search strategy (the `front_recovery_sparse_month_search_strategy_enabled` switch must be ON). A single press starts a background drain on the worker pool that processes one parked window per chunk: windows that ingest new conversations or walk fully clean are unparked; windows that still saturate the page cap with zero ingested stay parked with the re-arm outcome stamped on. Idempotent within a drain — each window is re-armed at most once per run, so the drain terminates.",
  change:
    "Background-drain re-run of each parked window via runTargetedWindowBackfill({resume:false}) (rebuilds under the search strategy), one window/chunk on the worker pool. Unparks windows on ingested/resolved_covered; stamps reArmOutcome on windows that stay parked. No schema change.",
  async status() {
    if (isDrainRunning("rearm_parked_front_recovery_windows")) {
      const s = getDrainState("rearm_parked_front_recovery_windows")!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    if (!isPoolEpicSwitchEnabled("front_recovery_sparse_month_search_strategy_enabled")) {
      return {
        state: "not-needed",
        detail:
          "The search strategy switch (front_recovery_sparse_month_search_strategy_enabled) is OFF — turn it on first, otherwise re-arming would just rebuild the legacy enumeration.",
      };
    }
    const { listReArmableParkedWindows } = await import("../frontAutoClosure");
    const months = await listReArmableParkedWindows(new Date().toISOString());
    if (months.length === 0) {
      return {
        state: "not-needed",
        detail: "No parked Front recovery windows to re-arm.",
      };
    }
    return {
      state: "pending",
      detail: `${months.length} parked window(s) (${months.join(", ")}); a single press re-runs each once under the search strategy, one per chunk.`,
    };
  },
  async apply(actorId) {
    const { startParkedWindowReArmDrain } = await import("../frontAutoClosure");
    const out = await startParkedWindowReArmDrain(actorId ?? null);
    if (out.state === "switch_off") {
      return { state: "not-needed", detail: out.detail };
    }
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Task #2637 — Re-match the dismissed_operational Front backlog ────
//
// The operational classifier was removed (Task #2637). Every Front message it
// auto-dismissed must go back up for deterministic-only matching. One press
// enqueues a durable, fanned-out `work_queue` drain (Task #2641) that re-runs
// the new deterministic triage over the `front_sync_emails` rows still in
// `match_status='dismissed_operational'`. An enumerate job pages the cohort
// (cursor-ordered, no overlap) into distinct id batches; each batch runs the
// convergent per-row attempt via `rematchDismissedOperationalByIds` on the
// worker `repair` class, so the work fans out across instances and survives
// autoscale recycles (any instance claims the next queued job) instead of dying
// with a single serial loop. Each batch's DB work is a sequence of short per-row
// ops, well under the 10 s hold cap. Idempotent + self-healing: `apply` is a
// no-op while a chain is already in flight (no second overlapping chain), a
// converged cohort reports "not needed", and the fast self-heal cadence re-seeds
// a fully-dead chain (or mops up rows a later ingestion path re-dismisses).
export const rematchDismissedOperationalBacklogAction: ProdAction = {
  id: "rematch_dismissed_operational_front_backlog",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Re-match dismissed-operational Front backlog (Task #2637)",
  description:
    "Re-runs the new deterministic-only Front triage over every `front_sync_emails` row still in `match_status='dismissed_operational'` — the cohort the removed operational classifier auto-dismissed. Each row is re-bucketed to auto_matched (deterministic participant match → thread-wide client attribution), unmatched, or blocked/dismissed (operator manual filter rule). A single press enqueues a durable, fanned-out `work_queue` drain (Task #2641): an enumerate job pages the cohort into distinct id batches that run in parallel on the worker `repair` class, converging match_status='dismissed_operational' to 0 within hours and surviving autoscale recycles (any instance claims the next queued job). Idempotent and self-healing: while a chain is already in flight `apply` is a no-op, and a converged cohort reports not-needed.",
  change:
    "Enqueue a fanned-out work_queue drain that re-triages front_sync_emails WHERE match_status='dismissed_operational' → auto_matched / unmatched / blocked / dismissed via the deterministic-only path, in parallel id batches on the worker repair class until the cohort is empty.",
  // Task #2641 — fast re-arm. The old serial drain only re-kicked on a 6h
  // cadence, so after each autoscale recycle killed the loop nothing resumed
  // for hours. The fan-out chain is durable on its own (any instance claims
  // the next queued job), so self-heal is now just a backstop that re-seeds a
  // fully-dead chain quickly; a short cadence keeps a stalled cohort moving
  // without waiting 6h.
  selfHeal: { cadenceMs: 10 * 60_000, backoffMs: 60 * 60_000 },
  async status() {
    const { countDismissedOperationalSyncEmails, isDismissedOperationalDrainActive } =
      await import("../frontIntegration");
    const n = await withDbAttribution(
      "maintenance:prod-actions-rematch-dismissed-operational-count",
      () => countDismissedOperationalSyncEmails(),
    );
    if (n === 0) {
      return {
        state: "not-needed",
        detail: "No dismissed-operational Front messages remain — nothing to re-match.",
      };
    }
    const active = await isDismissedOperationalDrainActive();
    if (active) {
      return {
        state: "pending",
        detail: `${n} dismissed-operational Front message(s) remaining — fanned-out work_queue drain in flight, converging the cohort.`,
      };
    }
    // Watchdog signal: rows remain but no drain chain is running. The next
    // apply / self-heal tick re-seeds the fan-out (≤10 min), so a stalled
    // cohort is visible here rather than looking silently idle.
    return {
      state: "pending",
      detail: `${n} dismissed-operational Front message(s) remaining — no drain chain currently in flight; will re-arm on the next apply / self-heal tick.`,
    };
  },
  async apply() {
    const {
      countDismissedOperationalSyncEmails,
      isDismissedOperationalDrainActive,
      rematchDismissedOperationalDrainProducer,
    } = await import("../frontIntegration");
    const n = await withDbAttribution(
      "maintenance:prod-actions-rematch-dismissed-operational-count",
      () => countDismissedOperationalSyncEmails(),
    );
    if (n === 0) {
      return {
        state: "not-needed",
        detail: "No dismissed-operational Front messages remain — nothing to re-match.",
      };
    }
    // Idempotent: if a fan-out chain is already converging the cohort, do NOT
    // seed a second overlapping chain (which would double-process rows). A
    // re-apply (manual or self-heal) is a safe no-op that reports progress.
    const active = await isDismissedOperationalDrainActive();
    if (active) {
      return {
        state: "applied",
        detail: `Fanned-out drain already in flight — ${n} dismissed-operational message(s) remaining; work_queue batches are converging the cohort.`,
        rowsAffected: 0,
      };
    }
    const { jobId, version } = await rematchDismissedOperationalDrainProducer();
    return {
      state: "applied",
      detail: `Enqueued fanned-out work_queue drain (producer job ${jobId}, v${version}) for ${n} dismissed-operational message(s); parallel batches will converge match_status='dismissed_operational' to 0. Each row gets the same deterministic match attempt (operator filter rules + participant/domain hard-match + thread-wide attribution).`,
      rowsAffected: 0,
    };
  },
};

export const seedClientTrustedEmailDomainsAction: ProdAction = {
  id: "seed_client_trusted_email_domains",
  // Operator-reviewed config bootstrap: settles once the previewed plan is
  // written; deliberately NO auto-loop (domain trust needs human review), so
  // a later re-arm (new client evidence crossing thresholds) is a genuine
  // operator-attention state, not routine mop-up.
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Trusting a domain changes matching behavior for a whole client — the operator reviews the derived seed plan before committing it; a re-arm means new evidence crossed thresholds and needs the same review.",
  },
  title: "Seed trusted email domains onto client records (Task #4049)",
  description:
    "Derives a reviewable set of trusted email domains for every active client and writes them to `clients.email_domains` — the field the deterministic matcher's domain tier (Task #867) reads, which has sat empty since launch. Evidence sources: (1) contact emails on file (`client_contacts.emails` + the client's own contact_email), (2) domains that HUMAN senders used across ≥3 distinct already-matched conversations of that client. Refused outright and listed for manual review: public/free-mail domains incl. subdomains (txt.voice.google.com), the company's own domains, vendor platforms (CallRail, Clio, …), competitor firms (participant evidence only), and any domain claimed by more than one client. `status()` previews the full per-client plan before anything is written; the lists stay operator-editable per client in Client Detail afterwards. Note: a website-domain source was planned but clients carry no website/URL column, so contact + participant evidence are the derivation sources.",
  change:
    "UPDATE clients SET email_domains = existing ∪ derived (normalized) for each active client with new, unambiguous, non-public domain evidence; hard-match indexes invalidated.",
  async status() {
    const { deriveClientDomainSeedPlan } = await import("../clientDomainSeeding");
    const plan = await deriveClientDomainSeedPlan();
    if (plan.totals.domainsToAdd === 0) {
      const ambig = plan.excluded.ambiguous.length;
      return {
        state: "not-needed",
        detail:
          `All derivable trusted domains are already on client records (${plan.totals.clientsWithExistingDomains}/${plan.totals.activeClients} active clients have domains).` +
          (ambig > 0
            ? ` ${ambig} domain(s) remain refused as multi-client-ambiguous: ${plan.excluded.ambiguous.map((a) => a.domain).join(", ")} — attach manually per client if one truly owns them.`
            : ""),
      };
    }
    const lines: string[] = [];
    for (const entry of plan.entries.slice(0, 40)) {
      const parts = entry.additions.map((a) => {
        const why: string[] = [];
        if (a.contactEmails > 0) why.push(`${a.contactEmails} contact${a.contactEmails === 1 ? "" : "s"}`);
        if (a.matchedConversations > 0) why.push(`${a.matchedConversations} matched convs`);
        return `${a.domain} (${why.join(", ") || "evidence"})`;
      });
      lines.push(`${entry.firmName}: ${parts.join(", ")}`);
    }
    if (plan.entries.length > 40) lines.push(`…and ${plan.entries.length - 40} more client(s)`);
    const exclusions: string[] = [];
    if (plan.excluded.ambiguous.length > 0) {
      exclusions.push(
        `refused ${plan.excluded.ambiguous.length} multi-client domain(s): ${plan.excluded.ambiguous
          .slice(0, 10)
          .map((a) => `${a.domain} → ${a.firmNames.join(" / ")}`)
          .join("; ")}${plan.excluded.ambiguous.length > 10 ? "; …" : ""}`,
      );
    }
    if (plan.excluded.filteredDomains.length > 0) {
      exclusions.push(`dropped public/vendor/company domains incl. ${plan.excluded.filteredDomains.slice(0, 8).join(", ")}`);
    }
    if (plan.excluded.belowThreshold > 0) {
      exclusions.push(`${plan.excluded.belowThreshold} participant domain(s) below the ${MIN_SEED_CONVS_LABEL}-conversation threshold`);
    }
    if (plan.excluded.automatedOnly > 0) {
      exclusions.push(`${plan.excluded.automatedOnly} domain(s) seen only via automated senders`);
    }
    return {
      state: "pending",
      detail:
        `Would seed ${plan.totals.domainsToAdd} trusted domain(s) across ${plan.totals.clientsGainingDomains}/${plan.totals.activeClients} active clients — ` +
        `${lines.join(" · ")}` +
        (exclusions.length > 0 ? ` — Exclusions: ${exclusions.join("; ")}.` : ""),
    };
  },
  async apply() {
    const { applyClientDomainSeedPlan } = await import("../clientDomainSeeding");
    const result = await applyClientDomainSeedPlan();
    if (result.domainsAdded === 0) {
      return {
        state: "not-needed",
        detail: "No new unambiguous trusted domains to seed — client records already carry all derivable domains.",
      };
    }
    return {
      state: "applied",
      detail:
        `Seeded ${result.domainsAdded} trusted domain(s) across ${result.clientsUpdated} client(s); hard-match indexes invalidated so the matcher sees them immediately.` +
        (result.ambiguousRefused > 0
          ? ` ${result.ambiguousRefused} domain(s) refused as multi-client-ambiguous (${result.plan.excluded.ambiguous
              .slice(0, 8)
              .map((a) => a.domain)
              .join(", ")}${result.ambiguousRefused > 8 ? ", …" : ""}) — review manually in Client Detail.`
          : "") +
        ` Lists remain operator-editable per client. The scoped deterministic re-match was auto-enqueued for each updated client (Task #4762 — the 6h self-heal re-match is the backstop), so the existing backlog drains without another press.`,
      rowsAffected: result.clientsUpdated,
    };
  },
};

const FRONT_RECOVERY_2025_11_WINDOW = {
  label: "2025-11",
  afterTimestamp: 1761955200,
  beforeTimestamp: 1764547200,
} as const;


// checkpointKey("2025-11") → non-alphanumerics become "_" (see
// frontHistoricalRecovery.checkpointKey). Confirmed against PROD.
const FRONT_RECOVERY_2025_11_CHECKPOINT_KEY = "front_recovery_checkpoint_2025_11";


interface Front202511Checkpoint {
  status?: string;
  scanned?: number;
  ingested?: number;
  pages?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  statusReason?: string | null;
}


async function loadFront202511Checkpoint(): Promise<Front202511Checkpoint | null> {
  const setting = await storage.getSystemSetting(FRONT_RECOVERY_2025_11_CHECKPOINT_KEY);
  if (!setting?.value) return null;
  try {
    return JSON.parse(setting.value) as Front202511Checkpoint;
  } catch {
    return null;
  }
}


// Test-only seam: the launcher that actually spawns the canonical recovery job.
// Production delegates to runHistoricalRecovery (real Front I/O); tests install
// a stub so the status/apply contract can be asserted without hitting Front.
type Front202511RecoveryLauncher = (window: {
  label: string;
  afterTimestamp: number;
  beforeTimestamp: number;
}) => Promise<{ jobId: string }>;


let _front202511RecoveryLauncherOverride: Front202511RecoveryLauncher | null = null;

export function __setFront202511RecoveryLauncherOverrideForTest(
  fn: Front202511RecoveryLauncher | null,
): void {
  _front202511RecoveryLauncherOverride = fn;
}


export async function getRerunFront202511RecoveryStatus(): Promise<ProdActionStatus> {
  const cp = await loadFront202511Checkpoint();
  const scanned = Number(cp?.scanned ?? 0);
  if (cp?.status === "complete" && scanned > 0) {
    return {
      state: "not-needed",
      detail: `2025-11 Front recovery already complete — ${scanned.toLocaleString()} conversation(s) scanned.`,
    };
  }
  if (cp?.status === "running") {
    return {
      state: "pending",
      detail: `A 2025-11 Front recovery run is already in progress (started ${cp.startedAt ?? "?"}); it will drive the checkpoint to complete.`,
    };
  }
  // Cheap in-memory breaker check (status() loads on every panel poll — no live
  // /me probe). Amber "needs reconnect" beats a misleading red/manual pending.
  const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
  if (frontAuthBreakerActive()) {
    return {
      state: "blocked",
      integration: "Front",
      detail:
        "Front login is not connected — the 2025-11 window cannot be re-scanned. Reconnect Front in the Integrations Hub to clear this.",
    };
  }
  const reason = cp
    ? `${cp.status ?? "missing"}, scanned=${scanned}${cp.statusReason ? `, ${cp.statusReason}` : ""}`
    : "no checkpoint stored";
  return {
    state: "pending",
    detail: `The 2025-11 recovery window has not completed a real scan [${reason}]; a press clears the poisoned checkpoint and re-runs it from page 1 on the Front search endpoint.`,
  };
}


export async function applyRerunFront202511Recovery(
  actorId: string | null,
): Promise<ProdActionOutcome> {
  const cp = await loadFront202511Checkpoint();
  const scanned = Number(cp?.scanned ?? 0);
  if (cp?.status === "complete" && scanned > 0) {
    return {
      state: "not-needed",
      detail: `2025-11 Front recovery already complete — ${scanned.toLocaleString()} conversation(s) scanned.`,
    };
  }
  // Don't start a second run while one is already in flight (the checkpoint
  // flips to `running` and persists per page once a job starts).
  if (cp?.status === "running") {
    return {
      state: "not-needed",
      detail: `A 2025-11 Front recovery run is already in progress (started ${cp.startedAt ?? "?"}); no new run started.`,
    };
  }
  // Cheap in-memory breaker check first so we never spawn a doomed run while
  // Front auth is dead (report amber blocked, not red error).
  const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
  if (frontAuthBreakerActive()) {
    return {
      state: "blocked",
      integration: "Front",
      detail:
        "Front login is not connected — reconnect Front in the Integrations Hub to re-run the 2025-11 window.",
    };
  }

  const launcher: Front202511RecoveryLauncher =
    _front202511RecoveryLauncherOverride ??
    (async (window) => {
      const { runHistoricalRecovery } = await import("../frontHistoricalRecovery");
      const jobId = await runHistoricalRecovery({
        customWindows: [window],
        resumeMode: "clear_checkpoints",
      });
      return { jobId };
    });

  try {
    const { jobId } = await launcher({ ...FRONT_RECOVERY_2025_11_WINDOW });
    void actorId; // attribution is handled inside runHistoricalRecovery's job log
    return {
      state: "applied",
      detail: `Started Front historical recovery job ${jobId} for the 2025-11 window (afterTimestamp=${FRONT_RECOVERY_2025_11_WINDOW.afterTimestamp}, beforeTimestamp=${FRONT_RECOVERY_2025_11_WINDOW.beforeTimestamp}). The poisoned checkpoint was cleared; it re-scans from page 1 on the search endpoint and drives the checkpoint to complete. Status reports not-needed once the checkpoint reaches complete with scanned>0.`,
      rowsAffected: 0,
    };
  } catch (err: any) {
    // The recovery worker concurrency cap is transient, not a failure.
    const { RecoveryConcurrencyCapError } = await import("../frontHistoricalRecovery");
    if (err instanceof RecoveryConcurrencyCapError) {
      return {
        state: "not-needed",
        detail: `Recovery worker is at capacity (${err.runningCount}/${err.cap} jobs running) — nothing started; status stays pending until a slot frees up.`,
      };
    }
    return {
      state: "error",
      detail: `Failed to start 2025-11 Front recovery: ${err?.message ?? String(err)}`,
    };
  }
}


// ---------------------------------------------------------------------------
// Task #2832 — prune the failed no-handler `retroactive_reprocess` backlog.
//
// Task #2824 restored the queue's handler, but production accumulated ~112k
// terminal `failed` rows with error_message 'No handler registered for queue
// "retroactive_reprocess"' from the months the handler was missing. Dedupe
// ignores failed rows, so they are inert — they never re-run, but they
// pollute queue metrics and represent clients whose unmatched communications
// were never re-evaluated. Decision recorded on Task #2832: prune the
// no-handler failed rows AND enqueue one fresh reprocess per affected active
// client, as a single manual CEO action (no selfHeal — one-time cleanup; the
// periodic client-matching sweep keeps coverage healthy going forward).
//
// Order matters: affected clientIds are computed from the failed rows BEFORE
// the delete drain starts, and the fresh enqueues land first so a client's
// re-evaluation is queued even if the drain is interrupted mid-way. Failed
// rows with other error reasons (stale_lease_exhaustion, startup_stale_recovery,
// pipeline_state, max_processing) keep their diagnostic value and are never
// touched.
export const pruneFailedRetroactiveReprocessBacklogAction: ProdAction = {
  id: "prune_failed_retroactive_reprocess_backlog",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Deletes a known poison backlog (no-handler failures) with compensating re-enqueues — deleting failed queue rows is an operator-reviewed cleanup, never auto-fired.",
  },
  title: "Prune failed no-handler retroactive_reprocess backlog (Task #2832)",
  description:
    "Cleans up the terminal `failed` rows the `retroactive_reprocess` queue accumulated while its handler was missing (restored by Task #2824): every row whose error_message starts with 'No handler registered for queue' is deleted, and each affected still-active client gets ONE fresh `retroactive_reprocess` job through the Task #1025 safe-enqueue path (per-client pending ceiling + version-agnostic periodic dedupe key), so their unmatched communications finally get re-evaluated. One-and-done: a single press performs the per-client enqueues synchronously, then starts a background drain that deletes the failed rows in chunks on the worker pool until none remain. Idempotent: the dedupe key collapses onto any already-pending periodic row per client, the ceiling refuses to over-enqueue, and deleted rows stop counting. Failed rows with OTHER error reasons (stale_lease_exhaustion, startup_stale_recovery, …) and all pending/processing/completed/dead_letter rows are never touched.",
  change:
    "One enqueueRetroactiveReprocessSafe per affected active client (periodic dedupe key, source='failed_backlog_cleanup'), then background-drain DELETE of work_queue rows WHERE queue_name='retroactive_reprocess' AND status='failed' AND error_message LIKE 'No handler registered for queue%' in " +
    String(FAILED_RETRO_CLEANUP_CHUNK) +
    "-row chunks until none remain. No schema change.",
  async status() {
    if (isDrainRunning("prune_failed_retroactive_reprocess_backlog")) {
      const s = getDrainState("prune_failed_retroactive_reprocess_backlog")!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const n = await countFailedNoHandlerRows();
    if (n === 0) {
      return {
        state: "not-needed",
        detail:
          "No failed no-handler retroactive_reprocess rows remain in work_queue.",
      };
    }
    const affected = await getAffectedActiveClientIds();
    return {
      state: "pending",
      detail: `${n} failed no-handler retroactive_reprocess row(s) would be deleted via background drain (${FAILED_RETRO_CLEANUP_CHUNK} per chunk), and ${affected.length} affected active client(s) would get one fresh reprocess job each (periodic dedupe key — already-pending clients are not duplicated).`,
    };
  },
  async apply(actorId) {
    // 1. Compute affected clients from the failed rows BEFORE any deletion.
    const affectedClientIds = await getAffectedActiveClientIds();
    // 2. Enqueue one fresh reprocess per affected active client (idempotent
    //    via periodic dedupe key + per-client pending ceiling).
    const enq = await enqueueReprocessForAffectedClients(affectedClientIds);
    const enqueueSummary = `Enqueued fresh reprocess for ${enq.enqueued} of ${enq.affectedClients} affected active client(s)` +
      (enq.skippedCeiling > 0
        ? ` (${enq.skippedCeiling} already at the per-client pending ceiling — re-evaluation already queued)`
        : "") +
      ".";
    // 3. Background drain deletes the failed no-handler rows in chunks.
    const out = await startBackgroundDrain(
      {
        actionId: "prune_failed_retroactive_reprocess_backlog",
        actionTitle: "Prune failed no-handler retroactive_reprocess backlog",
        attributionLabel: "maintenance:prod-actions-prune-failed-retro",
        countPending: () => countFailedNoHandlerRows(),
        runChunk: async () => {
          const deleted = await deleteFailedNoHandlerChunk();
          return { processed: deleted, perKey: { deleted } };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return {
        state: enq.affectedClients > 0 ? "applied" : "not-needed",
        detail: `${enqueueSummary} ${out.detail}`,
        ...(enq.affectedClients > 0 ? { rowsAffected: 0 } : {}),
      };
    }
    return {
      state: "applied",
      detail: `${enqueueSummary} ${out.detail}`,
      rowsAffected: 0,
    };
  },
};


export const rerunFront202511RecoveryAction: ProdAction = {
  id: "rerun_front_recovery_2025_11",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Deliberate historical re-scan: clears and re-drives the 2025-11 checkpoint through Front's API — the operator times it around Front auth health and API budget (production verification is tracked separately).",
  },
  title: "Re-run Front historical recovery for 2025-11 (Task #2717)",
  description:
    "Re-drives the single 2025-11 Front historical-recovery window (afterTimestamp=1761955200, beforeTimestamp=1764547200) through the canonical `runHistoricalRecovery` engine with `resumeMode='clear_checkpoints'`, so the checkpoint that stuck `partial` scanned=0 after a page-1 OAuth-rotation 401 is cleared and re-scanned from page 1 on the `/conversations/search` endpoint. A single press starts a background job on the worker pool and returns its job id; the per-message materializer then fills `messages_all` rows as conversations land, raising 2025-11 coverage. Neither `unblock_poisoned_front_recovery_checkpoints` (needs status=blocked) nor `reset_stuck_front_recovery_checkpoints` (needs safety_max_pages_reached + legacy `/conversations?` URL) matches this checkpoint, which is why a dedicated action exists. Idempotent: reports not-needed once the checkpoint is complete with scanned>0, starts nothing while a run is in flight, and reports blocked (not error) while Front auth is disconnected. See FRONT.md § 2025-11 historical-recovery re-run.",
  change:
    "Background re-run of the 2025-11 Front recovery window via runHistoricalRecovery({ customWindows:[2025-11], resumeMode:'clear_checkpoints' }) — clears the poisoned checkpoint and re-scans from page 1. No schema change.",
  status: () => getRerunFront202511RecoveryStatus(),
  apply: (actorId) => applyRerunFront202511Recovery(actorId ?? null),
};


// (Moved above the PROD_ACTIONS array — the Task #4049 completion merge
// left this const stranded after the array that references it, a TDZ
// crash on every registry import; same scramble class the Zoom S2S
// rollback commit repaired once before.)
export const rematchUnmatchedFrontBacklogAction: ProdAction = {
  id: "rematch_unmatched_front_backlog",
  // Historical-backlog mop-up: new mail is deterministically triaged at
  // ingest, so this settles once pressed; it only re-arms when an operator
  // deliberately edits trusted domains (config change, not routine inflow).
  convergence: { kind: "converging" },
  // Task #4762 — self-drains: deterministic-only (no AI spend), idempotent
  // (never seeds a second overlapping chain; already-matched rows are
  // skipped), and safe to auto-fire. Domain edits also enqueue a scoped
  // re-match directly at the trigger point (clients routes / domain
  // seeding); this enrollment is the backstop that catches anything those
  // feeders miss. 6h cadence matches the other backlog mop-ups.
  selfHeal: { cadenceMs: 6 * 60 * 60 * 1000, backoffMs: 6 * 60 * 60 * 1000 },
  title: "Re-match unmatched Front backlog (deterministic)",
  description:
    "Re-runs deterministic-only matching (operator filter rules + exact-contact + trusted-domain hard-match, no AI) across every `front_sync_emails` row still `unmatched` — the backlog that accumulated while clients had no trusted domains. One press enqueues a durable fanned-out `work_queue` drain (same machinery as the dismissed-operational drain): an enumerate job pages the cohort into id batches that run in parallel on the worker repair class, surviving autoscale recycles. Matches stamp attribution thread-wide and promote domain contacts; ambiguous evidence and automated-sender-only traffic (no-reply/notification mail riding a client domain) stay unmatched by design. The chain's final continuation records the before/after matched-count lift in the prod-action run history. Idempotent — running it again after editing client domains is safe: already-matched rows are skipped and refreshed verdicts overwrite stale reasons.",
  change:
    "Enqueue a fanned-out work_queue drain that re-runs deterministic triage over front_sync_emails WHERE match_status='unmatched'; matches → auto_matched + thread-wide attribution, everything ambiguous/automated stays unmatched.",
  async status() {
    const { countRematchableUnmatchedSyncEmails, isUnmatchedBacklogRematchActive } =
      await import("../frontIntegration");
    const active = await isUnmatchedBacklogRematchActive();
    if (active) {
      return {
        state: "pending",
        working: true,
        detail:
          "Fanned-out re-match chain in flight — batches are walking the unmatched backlog; the completion run in the action history will report the matched-count lift.",
      };
    }
    const estimate = await withDbAttribution(
      "maintenance:prod-actions-unmatched-rematch-estimate",
      () => countRematchableUnmatchedSyncEmails(),
    );
    if (estimate.trustedDomains === 0) {
      return {
        state: "pending",
        detail:
          "No client has trusted email domains yet — press “Seed trusted email domains onto client records” first, then run this re-match.",
      };
    }
    if (estimate.count === 0) {
      return {
        state: "not-needed",
        detail: `No unmatched conversations are currently claimable under the ${estimate.trustedDomains} trusted domain(s) on record (human senders only; resolver-adjudicated shared-domain collisions excluded).`,
      };
    }
    return {
      state: "pending",
      detail: `${estimate.capped ? `${estimate.count}+` : estimate.count} unmatched conversation(s) carry a human sender on a trusted client domain — press to re-run the deterministic backlog re-match (${estimate.trustedDomains} trusted domains active).`,
    };
  },
  async apply() {
    const {
      countRematchableUnmatchedSyncEmails,
      isUnmatchedBacklogRematchActive,
      rematchUnmatchedBacklogDrainProducer,
    } = await import("../frontIntegration");
    // Idempotent: never seed a second overlapping chain.
    const active = await isUnmatchedBacklogRematchActive();
    if (active) {
      return {
        state: "applied",
        detail: "Fanned-out re-match chain already in flight — not seeding a second chain; the running drain will finish and report its lift.",
        rowsAffected: 0,
      };
    }
    const estimate = await withDbAttribution(
      "maintenance:prod-actions-unmatched-rematch-estimate",
      () => countRematchableUnmatchedSyncEmails(),
    );
    if (estimate.count === 0) {
      return {
        state: "not-needed",
        detail:
          estimate.trustedDomains === 0
            ? "No client has trusted email domains yet — seed domains first."
            : "No unmatched conversations are currently claimable under the trusted domains on record.",
      };
    }
    const { jobId, version, baselineUnmatched, baselineAutoMatched } =
      await rematchUnmatchedBacklogDrainProducer();
    return {
      state: "applied",
      detail:
        `Enqueued fanned-out re-match drain (producer job ${jobId}, v${version}). Baseline: ${baselineUnmatched} unmatched / ${baselineAutoMatched} auto-matched; ~${estimate.capped ? `${estimate.count}+` : estimate.count} conversation(s) claimable under ${estimate.trustedDomains} trusted domain(s). ` +
        `Matches stamp thread-wide attribution; the chain's completion writes the before/after lift to the action run history.`,
      rowsAffected: 0,
    };
  },
};

const MIN_SEED_CONVS_LABEL = 3;

// ─── Domain collection (F7) ──────────────────────────────────────────
// Membership list for the composition-root guard: every registry action
// this module defines. Operator-facing order lives in ./composition.ts.
export const frontRecoveryDomain: ProdActionDomain = {
  name: "frontRecovery",
  actions: [
    cancelStaleFrontBacklogAction,
    recoverFrozenFrontMirrorAction,
    unblockPoisonedFrontRecoveryCheckpointsAction,
    cancelFront2999PoisonCheckpointsAction,
    resetStuckFrontRecoveryCheckpointsAction,
    markLegacyFrontEmailPendingTerminalAction,
    rematchDismissedOperationalBacklogAction,
    seedClientTrustedEmailDomainsAction,
    rematchUnmatchedFrontBacklogAction,
    backfillFrontRecoveryDedupeKeysAction,
    rerunFront202511RecoveryAction,
    pruneFailedRetroactiveReprocessBacklogAction,
    rearmParkedFrontRecoveryWindowsAction,
  ],
};
