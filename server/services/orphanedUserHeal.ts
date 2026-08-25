// @db-pool-intent: worker
// @cross-instance-safe: enqueue-only tick — enqueues a dedupe-keyed work_queue job; the handler runs once per claim and duplicate enqueues collapse via wq_dedupe_key_idx.
//
// The candidate SELECT and the per-row profile upsert both resolve their
// handle via `getDb()`. The only caller of `runOrphanedUserHealTick()` is
// the `orphaned_user_heal` work-queue handler, which wraps it in
// `runWithWorkerDb(...)` so `getDb()` resolves to the worker pool. (Note:
// we deliberately do NOT call `authStorage.upsertUser`, which is bound to
// the static `db`/api pool — that would violate DB pool tenancy from a
// worker context.)
/**
 * Task #2203 — Periodically heal logged-in users still missing their
 * `users` profile row.
 *
 * ── RETIRED (Task #4554 — closed admission) ────────────────────────────
 * The tick now short-circuits unconditionally (before the enable switch)
 * and NEVER creates users rows: the `users` table became the sign-in
 * allowlist, rows are created only via admin approval, and healing a
 * session-with-no-row from its claims would resurrect exactly the
 * auto-provisioned accounts closed admission keeps out. Config/status
 * surfaces (queue handler, prod action, last-run readout, budget
 * setting) are kept so operators see the retirement reason instead of a
 * vanished feature. The history below documents what the sweep used to
 * do in the Replit-Auth era.
 * ───────────────────────────────────────────────────────────────────────
 *
 * Task #2078 made `runOidcVerify` fail open when the first-login profile
 * upsert hits a transient DB blip, so the session is admitted from the
 * fresh token claims even though no `users` row was written. Task #2129
 * then reconciles that missing row on the user's *next authenticated
 * request* (`reconcileUserRow` in `replitAuth.ts`). But a user who is
 * admitted with no profile row and then never makes another request (or
 * whose every reconcile attempt keeps hitting a DB blip) stays
 * unreconciled indefinitely — the reconcile is purely request-driven.
 *
 * This module closes that residual gap with a background sweep that does
 * not depend on user traffic. It scans live (non-expired) `sessions`
 * rows, extracts each session's passport user claims (stored under
 * `sess->'passport'->'user'->'claims'`), and for any `sub` that has no
 * matching `users` row, best-effort re-upserts the profile from those
 * claims — the same idempotent write the request-time reconcile and the
 * OIDC login path perform.
 *
 * Why soft-deleted / revoked users are safe: a soft-deleted user retains
 * their `users` row (only `deleted_at` is set), so the `LEFT JOIN users …
 * WHERE u.id IS NULL` candidate filter never matches them. Their sessions
 * are also purged at delete time. A `sub` with NO row at all is therefore
 * never a revoked user, so re-upserting it cannot resurrect a deleted
 * account (mirroring the "revocation gate before upsert" invariant).
 *
 * Gating (default OFF — opt-in because the tick writes authoritative
 * `users` rows, not just measurement):
 *   1. `orphaned_user_heal_enabled` system setting (master switch).
 *   2. `orphaned_user_heal` queue-drain pause.
 *   3. `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
 *
 * Fail-open + idempotent + bounded: each tick heals at most `maxPerTick`
 * orphans (so a large backlog can never fan out unbounded writes in one
 * pass), the upsert is `onConflictDoUpdate` (so a concurrent login/request
 * reconcile racing the same `sub` is harmless), and a per-row failure is
 * logged and skipped so the next tick retries.
 */
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { isQueuePaused } from "./queueDrainControl";

export const QUEUE_NAME = "orphaned_user_heal";

/** Master enable switch. Default OFF — opt-in because the tick writes
 * authoritative `users` rows, not just measurement. */
export const SETTING_ENABLED = "orphaned_user_heal_enabled";

/** Per-tick budget: how many orphaned sessions to heal per tick so a
 * large backlog can never fan out an unbounded number of writes in a
 * single pass. Bounded 1..MAX. */
export const SETTING_MAX_PER_TICK = "orphaned_user_heal_max_per_tick";

/** Persisted JSON summary of the most recent tick so operators get a
 * live readout of what the sweep last healed/skipped (and why) without
 * scraping worker logs. */
export const SETTING_LAST_RUN = "orphaned_user_heal_last_run";

const DEFAULT_MAX_PER_TICK = 25;
export const MAX_PER_TICK_CAP = 500;

export const TICK_INTERVAL_MS = Number(
  process.env.ORPHANED_USER_HEAL_INTERVAL_MS || 60 * 60_000,
);

let interval: ReturnType<typeof setInterval> | null = null;

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

async function loadMaxPerTick(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_MAX_PER_TICK).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_PER_TICK;
  return Math.min(MAX_PER_TICK_CAP, Math.floor(n));
}

export type HealOutcome = "healed" | "error";

export interface HealAttempt {
  sub: string;
  outcome: HealOutcome;
  /** Populated when `outcome === "error"`. */
  error?: string;
}

export interface OrphanedUserHealTickResult {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  maxPerTick: number;
  /** Distinct `sub`s with a live session but no `users` row at scan time. */
  candidates: number;
  attempted: HealAttempt[];
  healed: number;
  errors: number;
  reason?: string;
}

/**
 * Persist the most recent tick summary as a JSON `system_settings` value
 * so an operator status surface can read what the sweep last did without
 * scraping worker logs. Never throws — a persistence failure must not
 * fail the tick.
 */
async function persistLastRun(
  result: OrphanedUserHealTickResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.warn(
      `[OrphanedUserHeal] Failed to persist last-run summary: ${
        err?.message ?? err
      }`,
    );
  }
}

/**
 * Read the persisted last-run summary, or null if the sweep has not run
 * yet (or the stored value is unparseable).
 */
export async function getLastOrphanedUserHealRun(): Promise<OrphanedUserHealTickResult | null> {
  try {
    const row = await getSystemSetting(SETTING_LAST_RUN);
    const raw = row?.value?.trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as OrphanedUserHealTickResult;
    }
    return null;
  } catch (err: any) {
    console.warn(
      `[OrphanedUserHeal] Failed to read last-run summary: ${
        err?.message ?? err
      }`,
    );
    return null;
  }
}

/** Live config the next tick will use — master switch, per-tick budget,
 * and cadence — so an operator status surface can confirm the sweep is
 * enabled and how often it runs without reading `system_settings`. */
export interface OrphanedUserHealConfig {
  enabled: boolean;
  maxPerTick: number;
  tickIntervalMinutes: number;
}

/**
 * Read the live orphaned-user-heal config (master switch + per-tick
 * budget + cadence) the next tick will actually use. Mirrors the
 * defaulting the tick itself applies so the readout never diverges from
 * runtime behavior.
 */
export async function getOrphanedUserHealConfig(): Promise<OrphanedUserHealConfig> {
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    false,
  );
  const maxPerTick = await loadMaxPerTick();
  return {
    enabled,
    maxPerTick,
    tickIntervalMinutes: Math.round(TICK_INTERVAL_MS / 60_000),
  };
}

/**
 * Why the last-run summary could not be returned as a parsed object:
 *   - "ok"         — a well-formed summary was read.
 *   - "never_run"  — the key is absent/empty; normal on a fresh deploy.
 *   - "unreadable" — the stored value (or the settings read itself)
 *     failed to produce a summary; signals a real persistence bug, not
 *     a fresh deploy.
 */
export type LastOrphanedUserHealRunStatus = "ok" | "never_run" | "unreadable";

export interface LastOrphanedUserHealRunRead {
  /** The parsed summary, or null when status is not "ok". */
  lastRun: OrphanedUserHealTickResult | null;
  status: LastOrphanedUserHealRunStatus;
  /** Plain-English reason present only when status === "unreadable". */
  error?: string;
}

/**
 * Read the persisted last-run summary and classify the outcome so the
 * operator status route can tell "never ran" (normal) apart from
 * "stored value was unreadable" (a persistence regression). Never
 * throws — a settings-read failure is reported as `unreadable` with the
 * error message rather than masquerading as `never_run`.
 */
export async function readLastOrphanedUserHealRun(): Promise<LastOrphanedUserHealRunRead> {
  let raw: string | undefined;
  try {
    const row = await getSystemSetting(SETTING_LAST_RUN);
    raw = row?.value?.trim();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[OrphanedUserHeal] Failed to read last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }

  if (!raw) return { lastRun: null, status: "never_run" };

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { lastRun: parsed as OrphanedUserHealTickResult, status: "ok" };
    }
    const message = "stored last-run value was not a JSON object";
    console.warn(`[OrphanedUserHeal] ${message}`);
    return { lastRun: null, status: "unreadable", error: message };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[OrphanedUserHeal] Failed to parse last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }
}

/**
 * One heal pass — RETIRED (Task #4554). Always short-circuits with a
 * retirement reason before any gate; never scans sessions and never
 * writes users rows (closed admission: rows are created only via admin
 * approval). Persists the summary as the last-run readout before
 * returning so operator status surfaces show the retirement.
 */
export async function runOrphanedUserHealTick(opts?: {
  now?: Date;
}): Promise<OrphanedUserHealTickResult> {
  const result = await computeOrphanedUserHealTick(opts);
  await persistLastRun(result);
  return result;
}

async function computeOrphanedUserHealTick(opts?: {
  now?: Date;
}): Promise<OrphanedUserHealTickResult> {
  const now = opts?.now ?? new Date();
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    false,
  );
  const paused = isQueuePaused(QUEUE_NAME);
  const maxPerTick = await loadMaxPerTick();
  const result: OrphanedUserHealTickResult = {
    ranAt: now.toISOString(),
    enabled,
    paused,
    maxPerTick,
    candidates: 0,
    attempted: [],
    healed: 0,
    errors: 0,
  };

  // Task #4554 — RETIRED unconditionally (checked before every other gate,
  // including the enable switch, so flipping `orphaned_user_heal_enabled`
  // back on can never resurrect the write path). Closed admission made the
  // `users` table the sign-in allowlist: rows are created ONLY via admin
  // approval (POST /api/users). Healing a session-with-no-row from its
  // claims would re-create exactly the auto-provisioned accounts the
  // allowlist exists to keep out. Any remaining orphaned sessions are
  // legacy Replit-Auth-era passport rows; they now correctly deny at the
  // admission gate. The module keeps its config/status surfaces (queue
  // handler, prod action, last-run readout) so operators see this reason
  // instead of a vanished feature.
  result.reason =
    "retired (Task #4554): closed admission — users rows are created only via admin approval; the sweep never scans or writes";
  return result;
}

async function enqueueScheduledTick(): Promise<void> {
  try {
    if (isQueuePaused(QUEUE_NAME)) {
      console.log(
        `[OrphanedUserHeal] enqueue_skipped_queue_paused queue=${QUEUE_NAME} reason=queue_drain_state ts=${new Date().toISOString()}`,
      );
      return;
    }
    // Cheap due-check: skip enqueue entirely when disabled so a default-
    // OFF deploy never piles up no-op jobs.
    const enabled = parseBool(
      (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
      false,
    );
    if (!enabled) return;
    const { enqueueJob } = await import("./workScheduler");
    const bucket = Math.floor(Date.now() / TICK_INTERVAL_MS);
    await enqueueJob({
      queueName: QUEUE_NAME,
      workloadClass: "maintenance",
      priority: 200,
      payload: { trigger: "scheduled", bucket },
      dedupeKey: `${QUEUE_NAME}:scheduled:${bucket}`,
      maxAttempts: 2,
    });
  } catch (err: any) {
    console.warn(
      `[OrphanedUserHeal] enqueue scheduled tick failed: ${
        err?.message ?? err
      }`,
    );
  }
}

export function startOrphanedUserHealScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void enqueueScheduledTick();
  }, TICK_INTERVAL_MS);
  console.log(
    `[OrphanedUserHeal] enqueue scheduler started (every ${
      TICK_INTERVAL_MS / 60_000
    }min; default OFF via ${SETTING_ENABLED}) — work runs in worker pool via ${QUEUE_NAME} queue`,
  );
}

export function stopOrphanedUserHealScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __orphanedUserHealTestHelpers = {
  enqueueScheduledTick,
  loadMaxPerTick,
};
