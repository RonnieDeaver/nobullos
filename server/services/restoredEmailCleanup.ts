// @db-pool-intent: worker
// @cross-instance-safe: enqueue-only tick — enqueues a dedupe-keyed work_queue job; the handler runs once per claim and duplicate enqueues collapse via wq_dedupe_key_idx.
//
// All DB work in this module flows through the storage helpers
// (`getAllUsers`, `updateUserEmail`, `insertActivityLogs`,
// `get/setSystemSetting`), which call `getDb()`. The only caller of
// `runRestoredEmailCleanupTick()` is the `restored_email_cleanup`
// work-queue handler, which wraps it in `runWithWorkerDb(...)` so
// `getDb()` resolves to the worker pool.
/**
 * Task #2029 — Automatically clean up restored-fallback emails.
 *
 * Task #1910 added a suffix-fallback restore path: when a soft-deleted
 * user is restored but their original email collides with another active
 * account, the row is restored with a synthetic
 * `<original>.restored.<ts>` address so it stays recoverable without
 * forcing the CEO to touch the colliding account first. Task #2012
 * surfaced these accounts in User Management with a one-click "Restore
 * original email" button.
 *
 * A fallback-email account fails its next login until the original
 * address is restored, so leaving the cleanup to a manual click is a
 * standing login-failure risk. This module turns that click into an
 * automatic, scheduled repair: it periodically scans active users whose
 * email matches the `.restored.<ts>` pattern and, for each one whose
 * stripped original address is now free, auto-updates the email back to
 * the original via the same `storage.updateUserEmail` uniqueness check
 * the manual button uses, writing a `user_email_updated` activity log
 * entry attributed to "system" (null userId).
 *
 * Accounts whose original address still collides with another active
 * user are left untouched for manual cleanup — they remain surfaced by
 * the existing User Management badge.
 *
 * Gating (default OFF — opt-in because it mutates authoritative user
 * email rows):
 *   1. `restored_email_cleanup_enabled` system setting (master switch).
 *   2. `restored_email_cleanup` queue-drain pause.
 *   3. `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
 *
 * DB pool tenancy: all DB work runs in the worker pool. The work-queue
 * handler wraps `runRestoredEmailCleanupTick()` in `runWithWorkerDb` so
 * the `getDb()` calls inside `getAllUsers` / `updateUserEmail` resolve
 * to the worker pool.
 */
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { isQueuePaused } from "./queueDrainControl";

export const QUEUE_NAME = "restored_email_cleanup";

/** Master enable switch. Default OFF — opt-in because the tick mutates
 * authoritative `users.email` rows, not just measurement. */
export const SETTING_ENABLED = "restored_email_cleanup_enabled";

/** Per-tick budget: how many fallback-email accounts to repair per tick
 * so a large backlog can never fan out an unbounded number of writes in
 * a single pass. Bounded 1..MAX. */
export const SETTING_MAX_PER_TICK = "restored_email_cleanup_max_per_tick";

const DEFAULT_MAX_PER_TICK = 25;
export const MAX_PER_TICK_CAP = 500;

/** Persisted JSON summary of the most recent tick so operators get a
 * live readout of what the cleanup last repaired/skipped (and why)
 * without scraping worker logs. */
export const SETTING_LAST_RUN = "restored_email_cleanup_last_run";

/** Task #2044 — alert threshold (count). Once this many restored accounts
 * have been stuck on a `.restored.<ts>` fallback for longer than
 * {@link SETTING_COLLISION_STUCK_HOURS} because the original address is
 * owned by another active user (a collision the auto-cleanup can never
 * resolve), the tick escalates to the responsible admins. Bounded 1..MAX. */
export const SETTING_COLLISION_ALERT_THRESHOLD =
  "restored_email_cleanup_collision_alert_threshold";

/** Task #2044 — minimum age (hours, derived from the `.restored.<ts>`
 * suffix) a collision must have before it counts toward the alert. Gives
 * the auto-cleanup time to clear a transient collision (e.g. the colliding
 * account is removed soon after) before paging a human. Bounded 1..MAX. */
export const SETTING_COLLISION_STUCK_HOURS =
  "restored_email_cleanup_collision_stuck_hours";

/** Task #2044 — persisted JSON streak state for the stuck-collision alert
 * so the tick pages the admins exactly once per stuck streak and re-arms
 * when the stuck count falls back below the threshold. Not
 * operator-configurable. */
export const SETTING_COLLISION_ALERT_STATE =
  "restored_email_cleanup_collision_alert_state";

export const TICK_INTERVAL_MS = Number(
  process.env.RESTORED_EMAIL_CLEANUP_INTERVAL_MS || 60 * 60_000,
);

let interval: ReturnType<typeof setInterval> | null = null;

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

const DEFAULT_COLLISION_ALERT_THRESHOLD = 1;
export const COLLISION_ALERT_THRESHOLD_CAP = 10_000;
const DEFAULT_COLLISION_STUCK_HOURS = 24;
export const COLLISION_STUCK_HOURS_CAP = 24 * 30; // 30 days

/** How many affected accounts to name inline in the alert body / persist
 * in the last-run summary. The full count is always reported; this caps
 * only the named sample so a large backlog can't bloat the notification. */
const COLLISION_DETAIL_CAP = 25;

async function loadMaxPerTick(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_MAX_PER_TICK).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_PER_TICK;
  return Math.min(MAX_PER_TICK_CAP, Math.floor(n));
}

async function loadCollisionAlertThreshold(): Promise<number> {
  const raw = (
    await getSystemSetting(SETTING_COLLISION_ALERT_THRESHOLD).catch(() => null)
  )?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COLLISION_ALERT_THRESHOLD;
  return Math.min(COLLISION_ALERT_THRESHOLD_CAP, Math.floor(n));
}

async function loadCollisionStuckHours(): Promise<number> {
  const raw = (
    await getSystemSetting(SETTING_COLLISION_STUCK_HOURS).catch(() => null)
  )?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COLLISION_STUCK_HOURS;
  return Math.min(COLLISION_STUCK_HOURS_CAP, Math.floor(n));
}

/**
 * Parse the epoch-ms timestamp embedded in a `<original>.restored.<ts>`
 * fallback email (written by `restoreUser({ emailConflictStrategy:
 * "suffix" })` as `Date.now()`). Returns null when the address has no
 * parseable suffix — the caller treats that as "age unknown".
 */
export function parseRestoredFallbackTimestamp(
  email: string | null | undefined,
): number | null {
  if (!email) return null;
  const m = /\.restored\.(\d+)$/.exec(email);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type CleanupOutcome = "repaired" | "collision" | "error";

export interface CleanupAttempt {
  userId: string;
  outcome: CleanupOutcome;
  /** The synthetic fallback address the row had before repair. */
  priorEmail: string;
  /** The stripped original address (the repair target). */
  targetEmail: string;
  /** Populated when `outcome === "error"`. */
  error?: string;
}

/**
 * Task #2044 — one restored account stuck on a fallback email because
 * the original address is owned by another active user (a collision the
 * auto-cleanup can never resolve on its own). Surfaced in the alert and
 * the last-run summary so an operator knows exactly which accounts /
 * addresses to reconcile by hand.
 */
export interface StuckCollision {
  userId: string;
  /** The synthetic `<original>.restored.<ts>` address the row sits on. */
  fallbackEmail: string;
  /** The original address an active `collidingUserId` already owns. */
  originalEmail: string;
  /** The active user holding `originalEmail` (the blocker). */
  collidingUserId: string;
  /** When the fallback was minted (from the `.restored.<ts>` suffix). */
  stuckSince: string | null;
  /** Whole hours stuck, or null when the suffix had no parseable ts. */
  stuckHours: number | null;
}

export interface RestoredEmailCleanupTickResult {
  ranAt: string;
  enabled: boolean;
  /**
   * True when an operator forced this tick on demand (Task #2043), which
   * bypasses the `enabled` master switch but still honors the
   * queue-drain pause and kill switch. Absent/false for scheduled ticks.
   */
  forced?: boolean;
  paused: boolean;
  maxPerTick: number;
  /** Active users matching the `.restored.<ts>` fallback pattern. */
  candidates: number;
  attempted: CleanupAttempt[];
  repaired: number;
  collisions: number;
  errors: number;
  /** Task #2044 — count threshold a stuck-collision streak must reach to
   * page the responsible admins. */
  collisionAlertThreshold: number;
  /** Task #2044 — minimum age (hours) a collision must have to count. */
  collisionStuckHours: number;
  /** Task #2044 — total collisions older than `collisionStuckHours` that
   * the auto-cleanup cannot resolve (computed across ALL candidates, not
   * just the per-tick repair slice). */
  stuckCollisions: number;
  /** Task #2044 — a bounded named sample of `stuckCollisions` so an
   * operator can see which accounts/addresses to reconcile by hand. */
  stuckCollisionSample: StuckCollision[];
  /** Task #2044 — true when this tick fired a fresh stuck-collision alert
   * (i.e. the streak just crossed the threshold). */
  collisionAlertFired: boolean;
  reason?: string;
}

/**
 * Persist the most recent tick summary as a JSON `system_settings`
 * value so an operator status surface can read what the cleanup last
 * did without scraping worker logs. Never throws — a persistence
 * failure must not fail the tick.
 */
async function persistLastRun(
  result: RestoredEmailCleanupTickResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.warn(
      `[RestoredEmailCleanup] Failed to persist last-run summary: ${
        err?.message ?? err
      }`,
    );
  }
}

/**
 * Why the last-run summary could not be returned as a parsed object:
 *   - "ok"         — a well-formed summary was read.
 *   - "never_run"  — the key is absent/empty; normal on a fresh deploy.
 *   - "unreadable" — the stored value (or the settings read itself)
 *     failed to produce a summary; signals a real persistence bug, not
 *     a fresh deploy.
 */
export type LastRestoredEmailCleanupRunStatus =
  | "ok"
  | "never_run"
  | "unreadable";

export interface LastRestoredEmailCleanupRunRead {
  /** The parsed summary, or null when status is not "ok". */
  lastRun: RestoredEmailCleanupTickResult | null;
  status: LastRestoredEmailCleanupRunStatus;
  /** Plain-English reason present only when status === "unreadable". */
  error?: string;
}

/**
 * Read the persisted last-run summary and classify the outcome so an
 * operator status route can tell "never ran" (normal) apart from
 * "stored value was unreadable" (a persistence regression). Never
 * throws — a settings-read failure is reported as `unreadable` with the
 * error message rather than masquerading as `never_run`.
 */
export async function readLastRestoredEmailCleanupRun(): Promise<LastRestoredEmailCleanupRunRead> {
  let raw: string | undefined;
  try {
    const row = await getSystemSetting(SETTING_LAST_RUN);
    raw = row?.value?.trim();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[RestoredEmailCleanup] Failed to read last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }

  if (!raw) return { lastRun: null, status: "never_run" };

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { lastRun: parsed as RestoredEmailCleanupTickResult, status: "ok" };
    }
    const message = "stored last-run value was not a JSON object";
    console.warn(`[RestoredEmailCleanup] ${message}`);
    return { lastRun: null, status: "unreadable", error: message };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[RestoredEmailCleanup] Failed to parse last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }
}

/**
 * Read the persisted last-run summary, or null if the cleanup has not
 * run yet (or the stored value is unparseable). Thin back-compat wrapper
 * over {@link readLastRestoredEmailCleanupRun} that preserves the
 * original "null for both never-run and unreadable" contract.
 */
export async function getLastRestoredEmailCleanupRun(): Promise<RestoredEmailCleanupTickResult | null> {
  return (await readLastRestoredEmailCleanupRun()).lastRun;
}

/** The current restored-email cleanup config (master switch + bounding
 * knobs) so an operator status surface can show what the scheduler will
 * do on its next tick without scraping `system_settings`. */
export interface RestoredEmailCleanupConfig {
  /** Master switch — scheduled ticks no-op while false (an operator-forced
   * run still proceeds). */
  enabled: boolean;
  /** Per-tick repair budget. */
  maxPerTick: number;
  /** Count a stuck-collision streak must reach to page the admins. */
  collisionAlertThreshold: number;
  /** Minimum age (hours) a collision must have to count toward the alert. */
  collisionStuckHours: number;
  /** Scheduled tick cadence in minutes (derived from TICK_INTERVAL_MS). */
  tickIntervalMinutes: number;
}

/**
 * Read the current cleanup config (master switch + bounding knobs) so an
 * operator surface can show what the next scheduled tick will do without
 * querying `system_settings` directly. Mirrors
 * `getFeedbackSlackRetryConfig()`.
 */
export async function getRestoredEmailCleanupConfig(): Promise<RestoredEmailCleanupConfig> {
  const [enabled, maxPerTick, collisionAlertThreshold, collisionStuckHours] =
    await Promise.all([
      Promise.resolve(
        parseBool(
          (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
          false,
        ),
      ),
      loadMaxPerTick(),
      loadCollisionAlertThreshold(),
      loadCollisionStuckHours(),
    ]);
  return {
    enabled,
    maxPerTick,
    collisionAlertThreshold,
    collisionStuckHours,
    tickIntervalMinutes: Math.round(TICK_INTERVAL_MS / 60_000),
  };
}

/**
 * Whether a previewed candidate would be repaired or is blocked:
 *   - "restorable" — the stripped original address is free, so a run
 *     would restore the row to it.
 *   - "collision"  — another active user already owns the original
 *     address, so the row is left for manual cleanup.
 */
export type PreviewOutcome = "restorable" | "collision";

export interface CleanupPreviewItem {
  userId: string;
  /** Best-effort display name (falls back to the email, then the id). */
  userName: string;
  /** The synthetic `.restored.<ts>` fallback address the row has now. */
  priorEmail: string;
  /** The stripped original address a run would restore it to. */
  targetEmail: string;
  outcome: PreviewOutcome;
  /** Active user that owns `targetEmail` — only when outcome === "collision". */
  collidingUserId?: string;
}

export interface RestoredEmailCleanupPreview {
  generatedAt: string;
  /** Current master-switch state (a forced run ignores it; shown for context). */
  enabled: boolean;
  /** Queue-drain pause — a run (even forced) no-ops while paused. */
  paused: boolean;
  /** KILL_SWITCH_NON_CRITICAL_SWEEPS — a run (even forced) no-ops while set. */
  killSwitch: boolean;
  /** Active users matching the `.restored.<ts>` fallback pattern. */
  candidates: number;
  /** How many candidates a run would restore. */
  restorable: number;
  /** How many candidates are blocked by an active collision. */
  collisions: number;
  items: CleanupPreviewItem[];
}

/**
 * Task #2043 — dry-run preview of what a cleanup run would do. Read-only:
 * scans active users for the `.restored.<ts>` fallback pattern and, for
 * each, predicts whether the stripped original address is free
 * ("restorable") or still owned by another active user ("collision"),
 * mirroring `updateUserEmail`'s case-insensitive uniqueness check WITHOUT
 * mutating anything. Also surfaces the pause / kill-switch gates so an
 * operator can tell whether a real run would actually proceed.
 */
export async function previewRestoredEmailCleanup(opts?: {
  now?: Date;
}): Promise<RestoredEmailCleanupPreview> {
  const now = opts?.now ?? new Date();
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    false,
  );
  const paused = isQueuePaused(QUEUE_NAME);
  const killSwitch = PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS;

  const { getAllUsers, isRestoredFallbackEmail, stripRestoredFallbackSuffix } =
    await import("../storage/clientStorage");

  const users = await getAllUsers();

  // Lowercased active-email → userId map mirrors the server-side
  // uniqueness check so a collision can be predicted without mutating.
  const activeEmail = new Map<string, string>();
  for (const u of users) {
    if (u.email) activeEmail.set(u.email.toLowerCase(), u.id);
  }

  const candidates = users.filter((u) => isRestoredFallbackEmail(u.email));
  const items: CleanupPreviewItem[] = [];
  let restorable = 0;
  let collisions = 0;

  for (const u of candidates) {
    const priorEmail = u.email as string;
    const targetEmail = stripRestoredFallbackSuffix(priorEmail);
    const userName =
      [u.firstName, u.lastName].filter(Boolean).join(" ") || priorEmail || u.id;
    const owner = activeEmail.get(targetEmail.toLowerCase());
    if (owner && owner !== u.id) {
      collisions += 1;
      items.push({
        userId: u.id,
        userName,
        priorEmail,
        targetEmail,
        outcome: "collision",
        collidingUserId: owner,
      });
    } else {
      restorable += 1;
      items.push({
        userId: u.id,
        userName,
        priorEmail,
        targetEmail,
        outcome: "restorable",
      });
    }
  }

  return {
    generatedAt: now.toISOString(),
    enabled,
    paused,
    killSwitch,
    candidates: candidates.length,
    restorable,
    collisions,
    items,
  };
}

/**
 * One cleanup pass. Scans active users for the `.restored.<ts>`
 * fallback pattern and repairs each whose stripped original address is
 * free, bounded by the per-tick budget. Collisions are left for manual
 * cleanup. Never throws on a per-user failure — the next tick retries.
 * Persists the summary as the last-run readout before returning.
 */
export async function runRestoredEmailCleanupTick(opts?: {
  now?: Date;
  /**
   * Task #2043 — operator on-demand run. Bypasses the `enabled` master
   * switch (so a sweep can be triggered without flipping the persistent
   * setting) while still honoring the queue-drain pause and kill switch.
   */
  force?: boolean;
}): Promise<RestoredEmailCleanupTickResult> {
  const result = await computeRestoredEmailCleanupTick(opts);
  await persistLastRun(result);
  return result;
}

async function computeRestoredEmailCleanupTick(opts?: {
  now?: Date;
  force?: boolean;
}): Promise<RestoredEmailCleanupTickResult> {
  const now = opts?.now ?? new Date();
  const force = opts?.force ?? false;
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    false,
  );
  const paused = isQueuePaused(QUEUE_NAME);
  const maxPerTick = await loadMaxPerTick();
  const collisionAlertThreshold = await loadCollisionAlertThreshold();
  const collisionStuckHours = await loadCollisionStuckHours();
  const result: RestoredEmailCleanupTickResult = {
    ranAt: now.toISOString(),
    enabled,
    forced: force,
    paused,
    maxPerTick,
    candidates: 0,
    attempted: [],
    repaired: 0,
    collisions: 0,
    errors: 0,
    collisionAlertThreshold,
    collisionStuckHours,
    stuckCollisions: 0,
    stuckCollisionSample: [],
    collisionAlertFired: false,
  };

  // The `enabled` master switch only gates the scheduled cadence. An
  // operator-forced run (Task #2043) is allowed to proceed regardless so
  // the cleanup is operable without flipping the persistent setting; the
  // pause and kill-switch gates below still apply to a forced run.
  if (!enabled && !force) {
    result.reason = "cleanup disabled in system_settings";
    return result;
  }
  if (paused) {
    result.reason = "queue paused via queue_drain_state";
    return result;
  }
  if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
    result.reason = "KILL_SWITCH_NON_CRITICAL_SWEEPS=true";
    return result;
  }

  const {
    getAllUsers,
    updateUserEmail,
    isRestoredFallbackEmail,
    stripRestoredFallbackSuffix,
    RestoreEmailConflictError,
  } = await import("../storage/clientStorage");
  const { insertActivityLogs } = await import("../storage/activityStorage");

  const users = await getAllUsers();
  const candidates = users.filter((u) => isRestoredFallbackEmail(u.email));
  result.candidates = candidates.length;
  if (candidates.length === 0) {
    result.reason = "no active users with a .restored.<ts> fallback email";
    return result;
  }

  for (const user of candidates.slice(0, maxPerTick)) {
    const priorEmail = user.email as string;
    const targetEmail = stripRestoredFallbackSuffix(priorEmail);
    try {
      const updated = await updateUserEmail(user.id, targetEmail);
      if (!updated) {
        // User vanished between scan and update — treat as a no-op error.
        result.attempted.push({
          userId: user.id,
          outcome: "error",
          priorEmail,
          targetEmail,
          error: "user not found at update time",
        });
        result.errors += 1;
        continue;
      }
      result.attempted.push({
        userId: user.id,
        outcome: "repaired",
        priorEmail,
        targetEmail: updated.email ?? targetEmail,
      });
      result.repaired += 1;

      try {
        const targetName =
          [updated.firstName, updated.lastName].filter(Boolean).join(" ") ||
          updated.email ||
          updated.id;
        await insertActivityLogs([
          {
            // null userId => "system"-attributed (matches the
            // systemOnly activity-log filter).
            userId: null,
            actionType: "user_email_updated",
            route: "/system/restored-email-cleanup",
            actionDetail: `Auto-restored original email for ${targetName}`,
            metadata: {
              targetUserId: updated.id,
              targetUserName: targetName,
              priorEmail,
              newEmail: updated.email,
              source: "restored_email_cleanup",
            },
            sessionId: null,
            duration: null,
            timestamp: new Date(),
          },
        ]);
      } catch (logErr: any) {
        console.error(
          `[RestoredEmailCleanup] Audit log failed for user=${user.id}: ${
            logErr?.message ?? logErr
          }`,
        );
      }
    } catch (err: any) {
      if (err instanceof RestoreEmailConflictError) {
        // Original address still owned by another active user — leave
        // for manual cleanup (still surfaced by the badge).
        result.attempted.push({
          userId: user.id,
          outcome: "collision",
          priorEmail,
          targetEmail,
        });
        result.collisions += 1;
        continue;
      }
      console.warn(
        `[RestoredEmailCleanup] user=${user.id} repair failed: ${
          err?.message ?? err
        }`,
      );
      result.attempted.push({
        userId: user.id,
        outcome: "error",
        priorEmail,
        targetEmail,
        error: err?.message ?? String(err),
      });
      result.errors += 1;
    }
  }

  // Task #2044 — compute the full stuck-collision set across ALL
  // candidates (not just the bounded repair slice above) so the alert
  // count is accurate even when the backlog exceeds `maxPerTick`. A
  // candidate is "stuck on a collision" when another active user already
  // owns its stripped-original address — exactly the
  // `RestoreEmailConflictError` condition, computed read-only from the
  // in-memory snapshot we already loaded (no extra DB round-trip).
  //
  // Fold this tick's own repairs into the snapshot first: a repair frees
  // the candidate from the fallback AND makes that user the new owner of
  // the original address, which can newly block another fallback aimed at
  // the same original. Without this the freshly-blocked collision would be
  // undercounted until the next tick.
  const repairedEmailById = new Map<string, string>();
  for (const a of result.attempted) {
    if (a.outcome === "repaired") repairedEmailById.set(a.userId, a.targetEmail);
  }
  const usersAfter = repairedEmailById.size
    ? users.map((u) =>
        repairedEmailById.has(u.id)
          ? { ...u, email: repairedEmailById.get(u.id)! }
          : u,
      )
    : users;

  const stuck = computeStuckCollisions({
    users: usersAfter,
    candidates,
    now,
    stuckHours: collisionStuckHours,
    stripRestoredFallbackSuffix,
  });
  result.stuckCollisions = stuck.length;
  result.stuckCollisionSample = stuck.slice(0, COLLISION_DETAIL_CAP);

  // Fire (or re-arm) the stuck-collision alert. Best-effort — a
  // notification/persistence failure never fails the tick.
  result.collisionAlertFired = await maybeAlertStuckCollisions({
    stuck,
    threshold: collisionAlertThreshold,
    stuckHours: collisionStuckHours,
    users: usersAfter,
  });

  return result;
}

/**
 * Task #2044 — given the in-memory user snapshot and the fallback-email
 * candidates, return every candidate the auto-cleanup can never resolve
 * because another active user owns its stripped-original address, filtered
 * to those stuck for at least `stuckHours`. Mirrors `updateUserEmail`'s
 * uniqueness check (lower-cased email, a *different* active user) without a
 * DB round-trip. A candidate whose suffix carries no parseable timestamp
 * is treated as "definitely stuck" (age unknown but the address has been
 * sitting on the fallback) so it is never silently excluded.
 */
function computeStuckCollisions(args: {
  users: Array<{ id: string; email: string | null }>;
  candidates: Array<{ id: string; email: string | null }>;
  now: Date;
  stuckHours: number;
  stripRestoredFallbackSuffix: (email: string) => string;
}): StuckCollision[] {
  const { users, candidates, now, stuckHours, stripRestoredFallbackSuffix } =
    args;
  // lower-cased active email -> owning user id (mirrors updateUserEmail).
  const ownerByEmail = new Map<string, string>();
  for (const u of users) {
    if (!u.email) continue;
    ownerByEmail.set(u.email.trim().toLowerCase(), u.id);
  }

  const out: StuckCollision[] = [];
  for (const c of candidates) {
    const fallbackEmail = c.email as string;
    const originalEmail = stripRestoredFallbackSuffix(fallbackEmail)
      .trim()
      .toLowerCase();
    const ownerId = ownerByEmail.get(originalEmail);
    // Collision only when a DIFFERENT active user owns the original.
    if (!ownerId || ownerId === c.id) continue;

    const ts = parseRestoredFallbackTimestamp(fallbackEmail);
    const stuckHoursElapsed =
      ts != null ? (now.getTime() - ts) / 3_600_000 : null;
    // Age-gate: skip transient collisions younger than the threshold.
    // Unknown age (ts === null) is treated as eligible.
    if (stuckHoursElapsed != null && stuckHoursElapsed < stuckHours) continue;

    out.push({
      userId: c.id,
      fallbackEmail,
      originalEmail,
      collidingUserId: ownerId,
      stuckSince: ts != null ? new Date(ts).toISOString() : null,
      stuckHours: stuckHoursElapsed != null ? Math.floor(stuckHoursElapsed) : null,
    });
  }
  // Longest-stuck first so the named sample surfaces the worst offenders.
  out.sort((a, b) => (b.stuckHours ?? Infinity) - (a.stuckHours ?? Infinity));
  return out;
}

interface CollisionAlertState {
  alerted: boolean;
  lastFiredAt?: string;
  lastCount?: number;
}

async function readCollisionAlertState(): Promise<CollisionAlertState> {
  try {
    const raw = (
      await getSystemSetting(SETTING_COLLISION_ALERT_STATE).catch(() => null)
    )?.value?.trim();
    if (!raw) return { alerted: false };
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { ...parsed, alerted: !!(parsed as any).alerted };
    }
  } catch {
    // Treat an unreadable state as "not yet alerted" — at worst we send
    // one extra (deduped) alert, never suppress a real one.
  }
  return { alerted: false };
}

async function writeCollisionAlertState(
  state: CollisionAlertState,
): Promise<void> {
  try {
    await setSystemSetting(
      SETTING_COLLISION_ALERT_STATE,
      JSON.stringify(state),
    );
  } catch (err: any) {
    console.warn(
      `[RestoredEmailCleanup] Failed to persist collision-alert state: ${
        err?.message ?? err
      }`,
    );
  }
}

/**
 * Task #2044 — escalate (or re-arm) the stuck-collision alert. Pages the
 * responsible admins exactly ONCE per stuck streak: it fires only on the
 * tick where the stuck count first reaches the threshold, and re-arms
 * (clears the persisted streak flag) once the count falls back below it,
 * so a chronic-but-known backlog does not page every hour. Best-effort
 * throughout — never throws. Returns true when it fired a fresh alert.
 */
async function maybeAlertStuckCollisions(args: {
  stuck: StuckCollision[];
  threshold: number;
  stuckHours: number;
  users: Array<{ id: string; email: string | null; firstName?: string | null; lastName?: string | null }>;
  // Test seams — default to the real dynamic imports in production.
  resolveAdmins?: () => Promise<string[]>;
  notify?: (typeof import("./notifications/userInbox"))["notifyUser"];
}): Promise<boolean> {
  const { stuck, threshold, stuckHours, users } = args;
  const count = stuck.length;
  const prior = await readCollisionAlertState();

  // Below threshold — re-arm so the next breach pages again.
  if (count < threshold) {
    if (prior.alerted) {
      await writeCollisionAlertState({ alerted: false });
    }
    return false;
  }

  // At/over threshold but we already paged this streak — stay quiet.
  if (prior.alerted) return false;

  // First tick of a new stuck streak — page the admins.
  try {
    const resolveAdmins =
      args.resolveAdmins ??
      (await import("./notifications/recipients"))
        .getResponsibleAdminsForAlert;
    const notifyUser =
      args.notify ?? (await import("./notifications/userInbox")).notifyUser;
    const admins = await resolveAdmins();
    if (admins.length === 0) {
      // `getResponsibleAdminsForAlert()` returns [] both when no admins
      // are configured AND when its DB read fails (it swallows the error),
      // so we cannot tell "nobody to page" from "lookup failed". Either
      // way we have NOT delivered the alert — do NOT arm the streak, or a
      // transient lookup blip would permanently suppress the alert until
      // the count drops below threshold. Leave it un-armed so the next
      // tick retries while the breach persists.
      console.warn(
        "[RestoredEmailCleanup] could not resolve responsible admins to alert about stuck restored-email collisions; will retry next tick",
      );
      return false;
    }

    const nameById = new Map<string, string>();
    for (const u of users) {
      const name =
        [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id;
      nameById.set(u.id, name);
    }
    // Name the affected users inline (not just their original addresses)
    // so the alert is actionable straight from the bell without expanding
    // metadata: "Jane Doe (jane@firm.com)".
    const sample = stuck
      .slice(0, 5)
      .map((s) => `${nameById.get(s.userId) ?? s.userId} (${s.originalEmail})`)
      .join(", ");
    const more = count > 5 ? ` (+${count - 5} more)` : "";
    const body =
      `${count} restored user account${count > 1 ? "s" : ""} can't be auto-cleaned ` +
      `because another active user owns the original address (stuck > ${stuckHours}h): ` +
      `${sample}${more}. Reassign or remove the colliding account, then use ` +
      `"Restore original email" in User Management.`;

    for (const uid of admins) {
      await notifyUser(
        uid,
        {
          category: "system",
          title: "Restored emails stuck on collisions",
          body,
          deepLink: "/admin/users",
          // Stable key collapses re-fires while unread, so a long streak
          // never floods the bell (we also gate on the streak flag above).
          dedupeKey: "restored-email-collision-stuck",
          metadata: {
            stuckCollisions: count,
            stuckHours,
            affected: stuck.slice(0, COLLISION_DETAIL_CAP).map((s) => ({
              userId: s.userId,
              userName: nameById.get(s.userId) ?? s.userId,
              originalEmail: s.originalEmail,
              collidingUserName:
                nameById.get(s.collidingUserId) ?? s.collidingUserId,
              stuckHours: s.stuckHours,
            })),
          },
        },
        { source: "worker:restoredEmailCleanup" },
      );
    }

    await writeCollisionAlertState({
      alerted: true,
      lastFiredAt: new Date().toISOString(),
      lastCount: count,
    });
    return true;
  } catch (err: any) {
    console.warn(
      `[RestoredEmailCleanup] stuck-collision alert fan-out failed: ${
        err?.message ?? err
      }`,
    );
    return false;
  }
}

async function enqueueScheduledTick(): Promise<void> {
  try {
    if (isQueuePaused(QUEUE_NAME)) {
      console.log(
        `[RestoredEmailCleanup] enqueue_skipped_queue_paused queue=${QUEUE_NAME} reason=queue_drain_state ts=${new Date().toISOString()}`,
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
      `[RestoredEmailCleanup] enqueue scheduled tick failed: ${
        err?.message ?? err
      }`,
    );
  }
}

export function startRestoredEmailCleanupScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void enqueueScheduledTick();
  }, TICK_INTERVAL_MS);
  console.log(
    `[RestoredEmailCleanup] enqueue scheduler started (every ${
      TICK_INTERVAL_MS / 60_000
    }min; default OFF via ${SETTING_ENABLED}) — work runs in worker pool via ${QUEUE_NAME} queue`,
  );
}

export function stopRestoredEmailCleanupScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __restoredEmailCleanupTestHelpers = {
  enqueueScheduledTick,
  loadMaxPerTick,
  loadCollisionAlertThreshold,
  loadCollisionStuckHours,
  computeStuckCollisions,
  readCollisionAlertState,
  writeCollisionAlertState,
  maybeAlertStuckCollisions,
};
