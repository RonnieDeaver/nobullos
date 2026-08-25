/**
 * Task #5156 — ClickUp role projection: durable WORKER / lifecycle.
 *
 * Extracted from clickUpRoleProjection.ts (which remains the staging + barrel
 * module) to keep every module under 1000 lines and to expose an explicit,
 * injectable execution seam for hermetic behavioral tests.
 *
 * Execution-time safety (architect review #1/#3/#5):
 *   Before ANY vendor read or write, processOneCommand loads the CURRENT
 *   destination row + current client-target mapping in a short attributed DB
 *   query, then releases the DB. It re-validates env/enabled/maxPeople/field/
 *   list/target/approvals and (for direct_task) the owning list, and re-reads
 *   the PERSISTED kill switch immediately before every mutation (including the
 *   repeat after an ambiguity). Only the current exact IDs — proven equal to the
 *   claimed snapshot — are handed to the adapter.
 *
 * @db-pool-intent: worker
 */
// @db-pool-intent: worker

import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  cuRoleProjectionCommands,
  cuRoleProjectionDestinations,
  cuRoleProjectionClientTargets,
  type CuRoleProjectionErrorCode,
  type WorkQueueJob,
} from "@shared/schema";
import { getDb, runWithWorkerDb, withDbAttribution } from "../db";
import { isKillSwitchEnabled, ensureKillSwitchesLoaded } from "./killSwitches";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import {
  applyProjectionDelta as defaultApplyProjectionDelta,
  readBackProjectionField as defaultReadBackProjectionField,
  CANONICAL_PRODUCTION_LIST_ID,
  isValidClickUpUserId,
  type ProjectionWriteOutcome,
  type ProjectionReadBackResult,
} from "./clickUpRoleProjectionClient";
import {
  enqueueClickUpRoleProjectionJob,
  enqueueProjectionWakeInTx,
} from "./clickUpRoleProjectionKick";
import {
  resolveProjectionEnvironment,
  type ProjectionEnvironment,
  projectionRetryDelayMs,
} from "./clickUpRoleProjectionEnv";
import { evaluatePaidSearchProjectionGate } from "./adsOs/paidSearchCutoverGate";

const LEASE_MS = 5 * 60_000;
const MAX_DRAIN_PER_INVOCATION = 50;

// ─── Claimed command shape ────────────────────────────────────────────────────

export interface ClaimedCommand {
  id: string;
  clientId: string;
  destinationId: string;
  desiredUserId: string | null;
  desiredClickupUserId: string | null;
  revision: string;
  targetSnapshot: Record<string, unknown> | null;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  mutationAttempts: number;
  leaseToken: string;
  leaseExpiresAt: string;
}

// ─── Injectable execution seam (architect review #7) ──────────────────────────
//
// The default deps route to the real persisted kill switch + vendor adapter +
// current-gate DB loader. Tests inject fakes so the SAME processOneCommand
// executes with no network and a deterministic DB/current-config surface.

/** Snapshot of the CURRENT destination + client-target, loaded just-in-time. */
export interface CurrentProjectionConfig {
  destination: {
    id: string;
    environment: string;
    enabled: boolean;
    targetKind: string;
    listId: string | null;
    targetId: string | null;
    peopleFieldId: string;
    maxPeople: number;
    sandboxExitApprovedAt: Date | null;
    ownerApprovedAt: Date | null;
    // Destination scope carried so the execution gate can fail closed on the
    // canonical Paid Search production destination unless the cutover setting
    // authorizes writes fresh (Task #5157). Never used to auto-enable a
    // destination; only ever to BLOCK a governed one. Optional so existing
    // injected test configs remain valid; absent ⇒ treated as null.
    departmentId?: string | null;
    responsibility?: string | null;
  } | null;
  /** null for direct_task (company-scope) — no per-client target row. */
  clientTarget: {
    targetId: string;
    resolvedListId: string | null;
  } | null;
}

export interface ProjectionWorkerDeps {
  /** Persisted kill-switch read: true = paused/revoked. Awaited before mutation. */
  isKillSwitchActive: () => Promise<boolean>;
  /** Load the CURRENT destination + client-target in a short attributed query. */
  loadCurrentConfig: (cmd: ClaimedCommand) => Promise<CurrentProjectionConfig>;
  applyProjectionDelta: typeof defaultApplyProjectionDelta;
  readBackProjectionField: typeof defaultReadBackProjectionField;
  retryDelayMs: (attempt: number) => number;
}

/**
 * Persisted kill-switch read. ensureKillSwitchesLoaded() forces a DB read of the
 * override so a switch toggled after claim is honored before the next mutation.
 */
async function defaultIsKillSwitchActive(): Promise<boolean> {
  await ensureKillSwitchesLoaded();
  return isKillSwitchEnabled("clickup_role_projection");
}

async function defaultLoadCurrentConfig(
  cmd: ClaimedCommand,
): Promise<CurrentProjectionConfig> {
  return withDbAttribution("cuRoleProjection:loadCurrent", async () => {
    const db = getDb();
    const [dest] = await db
      .select()
      .from(cuRoleProjectionDestinations)
      .where(eq(cuRoleProjectionDestinations.id, cmd.destinationId))
      .limit(1);

    let clientTarget: CurrentProjectionConfig["clientTarget"] = null;
    if (dest && dest.targetKind !== "direct_task") {
      const [ct] = await db
        .select()
        .from(cuRoleProjectionClientTargets)
        .where(
          and(
            eq(cuRoleProjectionClientTargets.clientId, cmd.clientId),
            eq(cuRoleProjectionClientTargets.destinationId, cmd.destinationId),
          ),
        )
        .limit(1);
      clientTarget = ct
        ? { targetId: ct.targetId, resolvedListId: ct.resolvedListId ?? null }
        : null;
    }

    return {
      destination: dest
        ? {
            id: dest.id,
            environment: dest.environment,
            enabled: dest.enabled,
            targetKind: dest.targetKind,
            listId: dest.listId ?? null,
            targetId: dest.targetId ?? null,
            peopleFieldId: dest.peopleFieldId,
            maxPeople: dest.maxPeople ?? 1,
            sandboxExitApprovedAt: dest.sandboxExitApprovedAt ?? null,
            ownerApprovedAt: dest.ownerApprovedAt ?? null,
            departmentId: dest.departmentId ?? null,
            responsibility: dest.responsibility ?? null,
          }
        : null,
      clientTarget,
    };
  });
}

function defaultDeps(): ProjectionWorkerDeps {
  return {
    isKillSwitchActive: defaultIsKillSwitchActive,
    loadCurrentConfig: defaultLoadCurrentConfig,
    applyProjectionDelta: defaultApplyProjectionDelta,
    readBackProjectionField: defaultReadBackProjectionField,
    retryDelayMs: projectionRetryDelayMs,
  };
}

// Test-only override seam. Production always passes explicit deps or the default.
let __depsOverride: ProjectionWorkerDeps | null = null;
/** TEST-ONLY: install worker deps used by processOneCommand's default path. */
export function __test_setProjectionWorkerDeps(
  deps: ProjectionWorkerDeps | null,
): void {
  __depsOverride = deps;
}
function activeDeps(explicit?: ProjectionWorkerDeps): ProjectionWorkerDeps {
  return explicit ?? __depsOverride ?? defaultDeps();
}

// ─── Lease claim (FOR UPDATE SKIP LOCKED) ────────────────────────────────────

export async function claimProjectionCommand(
  db: ReturnType<typeof getDb>,
): Promise<ClaimedCommand | null> {
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + LEASE_MS);
  const leaseToken = crypto.randomUUID();
  const leaseOwner = process.env.REPL_ID ?? "worker";

  const result = await withDbAttribution("cuRoleProjection:claim", async () =>
    db.execute(sql`
      UPDATE cu_role_projection_commands
      SET
        lease_owner = ${leaseOwner},
        lease_token = ${leaseToken},
        lease_expires_at = ${leaseExpiry},
        attempt_count = attempt_count + 1,
        updated_at = now()
      WHERE id IN (
        SELECT id FROM cu_role_projection_commands
        WHERE status IN ('pending', 'drift', 'ambiguous', 'failed')
          AND terminal_at IS NULL
          AND attempt_count < max_attempts
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING
        id, client_id, destination_id,
        desired_user_id, desired_clickup_user_id,
        revision, target_snapshot, status,
        attempt_count, max_attempts, mutation_attempts,
        lease_token, lease_expires_at
    `),
  );

  return mapClaimedRow(result.rows as Array<Record<string, unknown>>);
}

export async function claimProjectionCommandForTarget(
  db: ReturnType<typeof getDb>,
  clientId: string,
  destinationId: string,
): Promise<ClaimedCommand | null> {
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + LEASE_MS);
  const leaseToken = crypto.randomUUID();
  const leaseOwner = process.env.REPL_ID ?? "worker";

  const result = await withDbAttribution("cuRoleProjection:claimTarget", async () =>
    db.execute(sql`
      UPDATE cu_role_projection_commands
      SET
        lease_owner = ${leaseOwner},
        lease_token = ${leaseToken},
        lease_expires_at = ${leaseExpiry},
        attempt_count = attempt_count + 1,
        updated_at = now()
      WHERE id IN (
        SELECT id FROM cu_role_projection_commands
        WHERE client_id = ${clientId}
          AND destination_id = ${destinationId}
          AND status IN ('pending', 'drift', 'ambiguous', 'failed')
          AND terminal_at IS NULL
          AND attempt_count < max_attempts
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING
        id, client_id, destination_id,
        desired_user_id, desired_clickup_user_id,
        revision, target_snapshot, status,
        attempt_count, max_attempts, mutation_attempts,
        lease_token, lease_expires_at
    `),
  );

  return mapClaimedRow(result.rows as Array<Record<string, unknown>>);
}

function mapClaimedRow(rows: Array<Record<string, unknown>>): ClaimedCommand | null {
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    destinationId: String(r.destination_id),
    desiredUserId: r.desired_user_id ? String(r.desired_user_id) : null,
    desiredClickupUserId: r.desired_clickup_user_id ? String(r.desired_clickup_user_id) : null,
    revision: String(r.revision),
    targetSnapshot: (r.target_snapshot as Record<string, unknown>) ?? null,
    status: String(r.status),
    attemptCount: Number(r.attempt_count ?? 0),
    maxAttempts: Number(r.max_attempts ?? 5),
    mutationAttempts: Number(r.mutation_attempts ?? 0),
    leaseToken: String(r.lease_token),
    leaseExpiresAt:
      r.lease_expires_at instanceof Date
        ? r.lease_expires_at.toISOString()
        : new Date(String(r.lease_expires_at)).toISOString(),
  };
}

// ─── Finalize helpers (CAS on leaseToken + revision) ──────────────────────────

// CAS guard: id + lease_token + the exact revision claimed. A concurrent staging
// that superseded the desired intent (new revision) invalidates this predicate,
// so a stale worker can never overwrite the newer desired state.
function casPredicate(cmd: ClaimedCommand) {
  return sql`id = ${cmd.id} AND lease_token = ${cmd.leaseToken} AND revision = ${cmd.revision}`;
}

async function finalizeCommandSynced(cmd: ClaimedCommand, observedIds: string[]): Promise<void> {
  await withDbAttribution("cuRoleProjection:synced", () =>
    getDb().execute(sql`
      UPDATE cu_role_projection_commands
      SET status = 'synced',
          mutation_attempts = ${cmd.mutationAttempts + 1},
          observed_clickup_user_ids = ${JSON.stringify(observedIds)}::jsonb,
          verified_at = now(),
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          next_attempt_at = NULL, last_error = NULL, last_error_code = NULL,
          terminal_at = NULL,
          updated_at = now()
      WHERE ${casPredicate(cmd)}
    `),
  );
}

/**
 * Retryable/ambiguous finalize that writes `next_attempt_at`. To close the
 * crash/restart gap WITHOUT a periodic ClickUp/full-reconciliation scan, the
 * CAS update AND a durable delayed work_queue wake (retry_at = nextRetryAt)
 * commit ATOMICALLY in one short transaction. The wake is inserted ONLY when
 * the CAS update actually changed this command (rowCount > 0) — a stale worker
 * whose revision/lease was superseded neither rewrites the row nor schedules a
 * spurious wake. No vendor call happens inside this transaction.
 */
async function finalizeRetryableWithWake(
  attribution: "cuRoleProjection:ambiguous" | "cuRoleProjection:failed",
  status: "ambiguous" | "failed",
  cmd: ClaimedCommand,
  error: string,
  errorCode: CuRoleProjectionErrorCode | null,
  nextRetryAt: Date,
): Promise<void> {
  const bounded = error.slice(0, 2000);
  await withDbAttribution(attribution, () =>
    getDb().transaction(async (tx) => {
      const updated = await tx.execute(sql`
        UPDATE cu_role_projection_commands
        SET status = ${status},
            mutation_attempts = ${cmd.mutationAttempts + 1},
            last_error = ${bounded},
            last_error_code = ${errorCode ?? null},
            next_attempt_at = ${nextRetryAt},
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            updated_at = now()
        WHERE ${casPredicate(cmd)}
      `);
      // Only enqueue a durable wake if the CAS update took effect. This makes
      // the wake causally tied to the persisted retry schedule and avoids
      // waking for a row a newer revision already superseded.
      if (((updated as any).rowCount ?? 0) > 0) {
        await enqueueProjectionWakeInTx(tx, nextRetryAt, {
          commandId: cmd.id,
          revision: cmd.revision,
          attemptCount: cmd.attemptCount,
        });
      }
    }),
  );
}

async function finalizeCommandAmbiguous(
  cmd: ClaimedCommand,
  error: string,
  errorCode: CuRoleProjectionErrorCode | null,
  nextRetryAt: Date,
): Promise<void> {
  if (cmd.attemptCount >= cmd.maxAttempts) {
    await terminalWithAlert(cmd, error, "exhausted");
    return;
  }
  await finalizeRetryableWithWake(
    "cuRoleProjection:ambiguous",
    "ambiguous",
    cmd,
    error,
    errorCode,
    nextRetryAt,
  );
}

async function finalizeCommandFailed(
  cmd: ClaimedCommand,
  error: string,
  errorCode: CuRoleProjectionErrorCode | null,
  nextRetryAt: Date,
): Promise<void> {
  if (cmd.attemptCount >= cmd.maxAttempts) {
    await terminalWithAlert(cmd, error, "exhausted");
    return;
  }
  await finalizeRetryableWithWake(
    "cuRoleProjection:failed",
    "failed",
    cmd,
    error,
    errorCode,
    nextRetryAt,
  );
}

/**
 * Non-mutation blocked/disabled finalizer used by the execution-time gate: no
 * vendor egress occurred so mutation_attempts is NOT incremented. Terminal
 * (terminal_at set) so it is not auto-reclaimed; a manual resync can revive it.
 */
async function finalizeCommandGateStop(
  cmd: ClaimedCommand,
  status: "blocked" | "disabled",
  error: string,
  errorCode: CuRoleProjectionErrorCode | null,
): Promise<void> {
  const bounded = error.slice(0, 2000);
  await withDbAttribution("cuRoleProjection:gateStop", () =>
    getDb().execute(sql`
      UPDATE cu_role_projection_commands
      SET status = ${status},
          last_error = ${bounded},
          last_error_code = ${errorCode ?? null},
          terminal_at = now(),
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          next_attempt_at = NULL, updated_at = now()
      WHERE ${casPredicate(cmd)}
    `),
  );
}

/**
 * Transition to terminal. Returns true only if THIS call performed the
 * transition (terminal_at was NULL) — a CAS rowcount gate so the terminal alert
 * fires exactly once per terminal transition.
 */
async function finalizeCommandTerminal(
  cmd: ClaimedCommand,
  error: string,
  errorCode: CuRoleProjectionErrorCode | null,
): Promise<boolean> {
  const bounded = error.slice(0, 2000);
  const result = await withDbAttribution("cuRoleProjection:terminal", () =>
    getDb().execute(sql`
      UPDATE cu_role_projection_commands
      SET status = 'failed',
          last_error = ${bounded},
          last_error_code = ${errorCode ?? "exhausted"},
          terminal_at = now(),
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          next_attempt_at = NULL, updated_at = now()
      WHERE ${casPredicate(cmd)} AND terminal_at IS NULL
    `),
  );
  return ((result as any).rowCount ?? 0) > 0;
}

async function finalizeCommandDrift(
  cmd: ClaimedCommand,
  observedIds: string[],
  nextRetryAt: Date,
): Promise<void> {
  if (cmd.attemptCount >= cmd.maxAttempts) {
    await terminalWithAlert(
      cmd,
      `ClickUp read-back remained drifted after ${cmd.attemptCount} attempts`,
      "exhausted",
    );
    return;
  }
  await withDbAttribution("cuRoleProjection:drift", () =>
    getDb().transaction(async (tx) => {
      const updated = await tx.execute(sql`
        UPDATE cu_role_projection_commands
        SET status = 'drift',
            mutation_attempts = ${cmd.mutationAttempts + 1},
            observed_clickup_user_ids = ${JSON.stringify(observedIds)}::jsonb,
            drift_detected_at = now(),
            next_attempt_at = ${nextRetryAt},
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            updated_at = now()
        WHERE ${casPredicate(cmd)}
      `);
      if (((updated as any).rowCount ?? 0) > 0) {
        await enqueueProjectionWakeInTx(tx, nextRetryAt, {
          commandId: cmd.id,
          revision: cmd.revision,
          attemptCount: cmd.attemptCount,
        });
      }
    }),
  );
}

// ─── Terminal alert ────────────────────────────────────────────────────────────

async function fireTerminalAlert(
  cmd: ClaimedCommand,
  error: string,
  errorCode: CuRoleProjectionErrorCode | null,
): Promise<void> {
  try {
    const { notifyByType } = await import("./notifications/dispatcher");
    await notifyByType(
      "integration.clickup.role_projection_terminal",
      {
        text: `ClickUp role projection terminal failure: client=${cmd.clientId} dest=${cmd.destinationId} code=${errorCode ?? "unknown"} — ${error.slice(0, 200)}`,
        preview: { clientId: cmd.clientId, destinationId: cmd.destinationId, errorCode, error },
      },
      {
        triggerSource: "alert_service",
        dedupeKey: `cu_proj_terminal:${cmd.clientId}:${cmd.destinationId}`,
      },
    );
  } catch (err: unknown) {
    console.warn(
      "[ClickUpRoleProjection] Terminal alert delivery failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}

async function terminalWithAlert(
  cmd: ClaimedCommand,
  error: string,
  errorCode: CuRoleProjectionErrorCode | null,
): Promise<void> {
  const transitioned = await finalizeCommandTerminal(cmd, error, errorCode);
  if (transitioned) void fireTerminalAlert(cmd, error, errorCode ?? "exhausted");
}

async function stampClientTargetOwnershipVerified(cmd: ClaimedCommand): Promise<void> {
  try {
    await withDbAttribution("cuRoleProjection:stampOwnership", () =>
      getDb().execute(sql`
        UPDATE cu_role_projection_client_targets
        SET ownership_verified_at = now(), updated_at = now()
        WHERE client_id = ${cmd.clientId} AND destination_id = ${cmd.destinationId}
      `),
    );
  } catch (err: unknown) {
    console.warn(
      "[ClickUpRoleProjection] ownership stamp failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── Execution-time gate ──────────────────────────────────────────────────────

interface ResolvedTarget {
  taskId: string;
  listId: string;
  peopleFieldId: string;
  sandboxMode: boolean;
  // Destination scope carried so the pre-mutation cutover gate (Task #5157)
  // can fail closed on the canonical Paid Search production destination.
  environment: string;
  departmentId: string | null;
  responsibility: string | null;
}

type GateResult =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; stop: "blocked" | "disabled" | "terminal"; error: string; code: CuRoleProjectionErrorCode | null };

/**
 * Load the CURRENT config and validate it against the claimed snapshot and the
 * environment. Runs before the INITIAL read AND before every mutation. No vendor
 * egress. Returns the exact current IDs to use, or a stop verdict.
 */
async function runExecutionGate(
  cmd: ClaimedCommand,
  env: ProjectionEnvironment,
  deps: ProjectionWorkerDeps,
): Promise<GateResult> {
  const snapshot = cmd.targetSnapshot;
  if (!snapshot) {
    return { ok: false, stop: "terminal", error: "No target snapshot — command staged without mapping", code: "missing_target" };
  }

  const cfg = await deps.loadCurrentConfig(cmd);
  const dest = cfg.destination;
  if (!dest) {
    return { ok: false, stop: "blocked", error: "Destination no longer exists", code: "missing_target" };
  }
  // Stored legacy destinations are never executable. This precedes every
  // vendor read/write, including ambiguous-command read-back, so migration
  // cleanup is not relied upon as an egress control.
  if (dest.responsibility !== "doer" && dest.responsibility !== "checker") {
    return {
      ok: false,
      stop: "blocked",
      error: `Unsupported destination responsibility: ${String(dest.responsibility ?? "missing")}`,
      code: "invalid_field",
    };
  }

  // Current env must equal the selected env.
  if (dest.environment !== env) {
    return { ok: false, stop: "disabled", error: `Destination environment ${dest.environment} != active env ${env}`, code: "config_mismatch" };
  }
  // Destination must currently be enabled.
  if (!dest.enabled) {
    return { ok: false, stop: "disabled", error: "Destination is disabled", code: "config_mismatch" };
  }
  // Single-person cardinality contract.
  if ((dest.maxPeople ?? 1) !== 1) {
    return { ok: false, stop: "blocked", error: `maxPeople must be 1; got ${dest.maxPeople}`, code: "invalid_field" };
  }
  // Owning list required for ALL destinations (every task write needs live
  // owning-list proof) — architect review #3.
  const listId = dest.listId ?? "";
  if (!listId) {
    return { ok: false, stop: "blocked", error: "Destination has no owning listId", code: "missing_target" };
  }
  // Sandbox must never target the canonical production list.
  if (env === "sandbox" && listId === CANONICAL_PRODUCTION_LIST_ID) {
    return { ok: false, stop: "blocked", error: `sandbox must not target canonical production list ${CANONICAL_PRODUCTION_LIST_ID}`, code: "config_mismatch" };
  }
  // Production requires both approvals present.
  if (env === "production") {
    if (!dest.sandboxExitApprovedAt || !dest.ownerApprovedAt) {
      return { ok: false, stop: "disabled", error: "Production destination missing sandbox-exit/owner approval", code: "config_mismatch" };
    }
  }

  const peopleFieldId = dest.peopleFieldId ?? "";
  if (!peopleFieldId) {
    return { ok: false, stop: "blocked", error: "Destination has no peopleFieldId", code: "invalid_field" };
  }

  // Resolve the CURRENT exact task target by kind.
  let currentTargetId: string | null;
  if (dest.targetKind === "direct_task") {
    currentTargetId = dest.targetId ?? null;
  } else {
    currentTargetId = cfg.clientTarget?.targetId ?? null;
  }
  if (!currentTargetId) {
    return { ok: false, stop: "blocked", error: "No current target task for this client/destination", code: "missing_target" };
  }

  // Snapshot/current equality: the claimed snapshot must still match current.
  const snapTargetId = snapshot.targetId != null ? String(snapshot.targetId) : "";
  const snapFieldId = snapshot.peopleFieldId != null ? String(snapshot.peopleFieldId) : "";
  const snapListId = snapshot.listId != null ? String(snapshot.listId) : "";
  if (snapTargetId !== currentTargetId || snapFieldId !== peopleFieldId || snapListId !== listId) {
    return {
      ok: false,
      stop: "blocked",
      error: `Snapshot != current config (target/list/field drift); superseded — awaiting re-stage`,
      code: "config_mismatch",
    };
  }

  return {
    ok: true,
    target: {
      taskId: currentTargetId,
      listId,
      peopleFieldId,
      sandboxMode: env === "sandbox",
      environment: dest.environment,
      departmentId: dest.departmentId ?? null,
      responsibility: dest.responsibility ?? null,
    },
  };
}

/**
 * Task #5157 — pre-mutation fail-closed gate for the canonical Paid Search
 * production destination. Reads the cutover setting FRESH immediately before
 * the mutation. NON-governed destinations pass through unchanged (sandbox
 * behavior and all other destinations are untouched). Governed destinations
 * require read approval + projection-write approval + projectionWritesEnabled
 * (and, when scoped, a matching department) — otherwise the mutation aborts
 * with zero egress. Never auto-enables a destination.
 */
async function checkPaidSearchCutoverGate(target: ResolvedTarget): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const verdict = await evaluatePaidSearchProjectionGate({
    listId: target.listId,
    peopleFieldId: target.peopleFieldId,
    environment: target.environment,
    departmentId: target.departmentId,
    responsibility: target.responsibility,
  });
  if (verdict.allowed) return { ok: true };
  return { ok: false, error: verdict.reason };
}

// ─── Process one command ──────────────────────────────────────────────────────

/**
 * Process a single claimed command. No DB connection is held across vendor
 * calls. The execution gate runs before the initial read and before every
 * mutation; the persisted kill switch is re-checked before every mutation.
 */
export async function processOneCommand(
  cmd: ClaimedCommand,
  explicitDeps?: ProjectionWorkerDeps,
): Promise<void> {
  const deps = activeDeps(explicitDeps);
  const env = resolveProjectionEnvironment();
  if (env === "unconfigured") return;

  // Missing ClickUp identity: desired NoBull user present but no ClickUp ID.
  if (cmd.desiredUserId !== null && cmd.desiredClickupUserId === null) {
    await finalizeCommandGateStop(
      cmd,
      "blocked",
      "Desired NoBull user has no ClickUp identity configured",
      "missing_identity",
    );
    return;
  }
  // ClickUp ID format (digits only).
  if (cmd.desiredClickupUserId !== null && !isValidClickUpUserId(cmd.desiredClickupUserId)) {
    await terminalWithAlert(
      cmd,
      `ClickUp user ID must be digits only: ${String(cmd.desiredClickupUserId).slice(0, 50)}`,
      "invalid_field",
    );
    return;
  }

  // ── Gate BEFORE the initial read (architect review #5). ──
  const gate1 = await runExecutionGate(cmd, env, deps);
  if (!gate1.ok) {
    if (gate1.stop === "terminal") await terminalWithAlert(cmd, gate1.error, gate1.code);
    else await finalizeCommandGateStop(cmd, gate1.stop, gate1.error, gate1.code);
    return;
  }
  const target = gate1.target;
  const now = Date.now();

  // ── Ambiguous: direct read BEFORE any repeat write. ──
  if (cmd.status === "ambiguous") {
    const readBack = await deps.readBackProjectionField({
      taskId: target.taskId,
      expectedListId: target.listId,
      peopleFieldId: target.peopleFieldId,
      desiredClickupUserId: cmd.desiredClickupUserId,
      sandboxMode: target.sandboxMode,
    });

    if (!readBack.ok) {
      const rbCode = (readBack as any).errorCode ?? null;
      if (readBack.retryable) {
        if (cmd.attemptCount >= cmd.maxAttempts) {
          await terminalWithAlert(cmd, readBack.error, "exhausted");
          return;
        }
        await finalizeCommandAmbiguous(cmd, readBack.error, rbCode, new Date(now + deps.retryDelayMs(cmd.attemptCount)));
        return;
      }
      await terminalWithAlert(cmd, readBack.error, rbCode);
      return;
    }
    if (readBack.matchesDesired) {
      await finalizeCommandSynced(cmd, readBack.currentIds);
      return;
    }
    // Proven mismatch — a repeat mutation is required. Re-run the gate AND the
    // persisted kill switch + live ownership read before that mutation
    // (architect review #5). applyProjectionDelta below performs the live GET.
    const gate2 = await runExecutionGate(cmd, env, deps);
    if (!gate2.ok) {
      if (gate2.stop === "terminal") await terminalWithAlert(cmd, gate2.error, gate2.code);
      else await finalizeCommandGateStop(cmd, gate2.stop, gate2.error, gate2.code);
      return;
    }
  }

  // ── Persisted kill switch re-check immediately before mutation. ──
  if (await deps.isKillSwitchActive()) {
    await finalizeCommandGateStop(cmd, "disabled", "Kill switch active — mutation aborted with zero egress", "config_mismatch");
    return;
  }

  // ── Task #5157: cutover fail-closed gate (fresh read) immediately before
  //    mutation. Governs only the canonical Paid Search production destination;
  //    all other destinations pass through unchanged. ──
  const cutoverGate = await checkPaidSearchCutoverGate(target);
  if (!cutoverGate.ok) {
    await finalizeCommandGateStop(cmd, "disabled", cutoverGate.error, "config_mismatch");
    return;
  }

  // ── Apply delta. applyProjectionDelta performs a live GET immediately before
  //    any POST/DELETE, proving owning-list ownership and failing closed against
  //    the canonical production list in sandbox. ──
  const writeResult: ProjectionWriteOutcome = await deps.applyProjectionDelta({
    taskId: target.taskId,
    expectedListId: target.listId,
    peopleFieldId: target.peopleFieldId,
    desiredClickupUserId: cmd.desiredClickupUserId,
    sandboxMode: target.sandboxMode,
  });

  if (!writeResult.ok) {
    const wErr = writeResult as any;
    if (wErr.cardinalityViolation) {
      await terminalWithAlert(cmd, writeResult.error, "invalid_cardinality");
      return;
    }
    if (wErr.ambiguous) {
      if (cmd.attemptCount >= cmd.maxAttempts) {
        await terminalWithAlert(cmd, writeResult.error, "exhausted");
        return;
      }
      await finalizeCommandAmbiguous(cmd, writeResult.error, wErr.errorCode ?? null, new Date(now + deps.retryDelayMs(cmd.attemptCount)));
      return;
    }
    if (writeResult.retryable) {
      if (cmd.attemptCount >= cmd.maxAttempts) {
        await terminalWithAlert(cmd, writeResult.error, "exhausted");
        return;
      }
      await finalizeCommandFailed(cmd, writeResult.error, wErr.errorCode ?? null, new Date(now + deps.retryDelayMs(cmd.attemptCount)));
      return;
    }
    await terminalWithAlert(cmd, writeResult.error, wErr.errorCode ?? null);
    return;
  }

  // ── Gate AGAIN immediately before the confirmation read (architect review
  //    #B). Config may have been revoked/re-pointed during the mutation window.
  //    Use the NEW exact current target/field/list for the read — never query
  //    the stale target, and never mark synced against a changed destination.
  //    If the gate now stops, finalize blocked/disabled; if the current target
  //    diverged from the one we just wrote, treat as ambiguous (we cannot prove
  //    the write landed on the now-current target) and retry — never synced. ──
  const gate3 = await runExecutionGate(cmd, env, deps);
  if (!gate3.ok) {
    if (gate3.stop === "terminal") await terminalWithAlert(cmd, gate3.error, gate3.code);
    else await finalizeCommandGateStop(cmd, gate3.stop, gate3.error, gate3.code);
    return;
  }
  const confirmTarget = gate3.target;
  if (
    confirmTarget.taskId !== target.taskId ||
    confirmTarget.listId !== target.listId ||
    confirmTarget.peopleFieldId !== target.peopleFieldId
  ) {
    // The destination changed between our write and the confirmation read. The
    // write we performed may not reflect the now-current target — never synced.
    await finalizeCommandAmbiguous(
      cmd,
      "Destination changed after mutation, before confirmation read; cannot confirm — will retry against current target",
      "config_mismatch",
      new Date(now + deps.retryDelayMs(cmd.attemptCount)),
    );
    return;
  }

  // ── Read back to confirm exact IDs against the CURRENT (re-gated) target.
  //    Every synced path — including noop — requires a direct GET; a failed
  //    read-back is ambiguous, never synced. ──
  const readBack: ProjectionReadBackResult = await deps.readBackProjectionField({
    taskId: confirmTarget.taskId,
    expectedListId: confirmTarget.listId,
    peopleFieldId: confirmTarget.peopleFieldId,
    desiredClickupUserId: cmd.desiredClickupUserId,
    sandboxMode: confirmTarget.sandboxMode,
  });

  if (!readBack.ok) {
    await finalizeCommandAmbiguous(
      cmd,
      `Read-back failed after ${writeResult.action}: ${readBack.error}`,
      (readBack as any).errorCode ?? null,
      new Date(now + deps.retryDelayMs(cmd.attemptCount)),
    );
    return;
  }
  if (!readBack.matchesDesired) {
    await finalizeCommandDrift(
      cmd,
      readBack.currentIds,
      new Date(now + deps.retryDelayMs(cmd.attemptCount)),
    );
    return;
  }

  // Confirmed synced via direct GET. For a real write, stamp ownership.
  if (writeResult.action !== "noop") {
    await stampClientTargetOwnershipVerified(cmd);
  }
  await finalizeCommandSynced(cmd, readBack.currentIds);
}

// ─── Single immediate attempt ─────────────────────────────────────────────────

export async function attemptProjectionCommandNow(
  clientId: string,
  destinationId: string,
): Promise<void> {
  try {
    if (isKillSwitchEnabled("clickup_role_projection")) return;
    const env = resolveProjectionEnvironment();
    if (env === "unconfigured") return;

    await runWithWorkerDb(async () => {
      const cmd = await withDbAttribution("cuRoleProjection:immediateAttempt", async () => {
        const db = getDb();
        return claimProjectionCommandForTarget(db, clientId, destinationId);
      });
      if (!cmd) return;
      // DB released before vendor calls inside processOneCommand.
      await processOneCommand(cmd);
    });
  } catch (err: unknown) {
    console.error(
      "[ClickUpRoleProjection] Immediate attempt failed (safe — assignment already committed):",
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── Work queue handler ───────────────────────────────────────────────────────

export async function handleClickUpRoleProjectionJob(
  job?: WorkQueueJob,
): Promise<{ cursor?: string }> {
  if (isKillSwitchEnabled("clickup_role_projection")) {
    return { cursor: "kill_switch:clickup_role_projection:aborted" };
  }
  const env = resolveProjectionEnvironment();
  if (env === "unconfigured") {
    return { cursor: "unconfigured:no_projection_environment" };
  }

  let totalProcessed = 0;
  for (let i = 0; i < MAX_DRAIN_PER_INVOCATION; i++) {
    if (isKillSwitchEnabled("clickup_role_projection")) break;

    const claimed = await runWithWorkerDb(async () =>
      withDbAttribution("cuRoleProjection:drain", async () => {
        const db = getDb();
        return claimProjectionCommand(db);
      }),
    );
    if (!claimed) break;

    await processOneCommand(claimed);
    totalProcessed++;
  }

  if (totalProcessed === MAX_DRAIN_PER_INVOCATION) {
    // Cap reached — there may be more due commands. Durably enqueue an
    // IMMEDIATE continuation so the remainder drains even if this process
    // crashes right after returning. A unique deterministic dedupe key derived
    // from the current job id keeps successive continuations distinct (the
    // fixed producer-drain key would otherwise coalesce them into a no-op),
    // while still coalescing exact retries of THIS continuation. If the enqueue
    // fails we throw so the current queue job retries and does not silently
    // strand the remainder.
    const continuationKey =
      `clickup_role_projection:continuation:${job?.id ?? crypto.randomUUID()}`;
    await enqueueClickUpRoleProjectionJob({ dedupeKey: continuationKey });
    return { cursor: `processed:${totalProcessed}:continuation` };
  }
  return { cursor: `processed:${totalProcessed}` };
}

// ─── Boot catch-up (LOSS-RECOVERY backstop — NOT the retry driver) ────────────
//
// The normal retry driver is the durable work_queue wake inserted atomically by
// the retryable/ambiguous finalizers (see finalizeRetryableWithWake): every row
// that gets a `next_attempt_at` also gets a `pending` work_queue wake with
// `retry_at = next_attempt_at`, so a delayed retry re-runs on schedule even
// across a crash/restart — without any periodic ClickUp scan.
//
// This boot catch-up exists ONLY to recover rows that never received a durable
// wake at all: e.g. a producer post-commit kick that failed, or a process that
// died between the finalize CAS update and (in an older code path) its wake
// insert. It re-enqueues an immediate drain for any old, un-leased, due command
// on deploy. It is a safety net, not the mechanism relied on for ordinary
// retries.

const BOOT_CATCHUP_DELAY_MS = 30_000;
const CATCHUP_MIN_AGE_MS = 2 * 60_000;
const CATCHUP_LIMIT = 100;

export function scheduleClickUpRoleProjectionBootCatchup(): void {
  if (!isRunningInDeployment()) return;

  setTimeout(async () => {
    try {
      if (isKillSwitchEnabled("clickup_role_projection")) return;
      const cutoff = new Date(Date.now() - CATCHUP_MIN_AGE_MS);
      const now = new Date();

      const stuckCommands = await runWithWorkerDb(() =>
        withDbAttribution("cuRoleProjection:bootCatchup", async () => {
          const db = getDb();
          const res = await db.execute(sql`
            SELECT id FROM cu_role_projection_commands
            WHERE status IN ('pending', 'drift', 'ambiguous', 'failed')
              AND terminal_at IS NULL
              AND attempt_count < max_attempts
              AND created_at < ${cutoff}
              AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
              AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
            LIMIT ${CATCHUP_LIMIT}
          `);
          return res.rows as Array<{ id: string }>;
        }),
      );

      if (stuckCommands.length > 0) {
        console.log(
          `[ClickUpRoleProjection] Boot catch-up: found ${stuckCommands.length} stuck commands — enqueueing.`,
        );
        await enqueueClickUpRoleProjectionJob();
      } else {
        console.log("[ClickUpRoleProjection] Boot catch-up: no stuck commands.");
      }
    } catch (err: unknown) {
      console.error(
        "[ClickUpRoleProjection] Boot catch-up failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }, BOOT_CATCHUP_DELAY_MS);
}

// ─── Post-attempt status read (honest response, architect review #4) ──────────

export interface ProjectionRefStatus {
  clientId: string;
  destinationId: string;
  status: string;
  verifiedAt: Date | null;
}

/**
 * Re-read the exact command statuses for a bounded set of refs AFTER awaited
 * immediate attempts, so callers can return an honest post-attempt summary
 * rather than the pre-attempt staging summary. One bounded attributed query.
 */
export async function readProjectionCommandStatuses(
  refs: Array<{ clientId: string; destinationId: string }>,
): Promise<ProjectionRefStatus[]> {
  if (refs.length === 0) return [];
  return withDbAttribution("cuRoleProjection:readRefStatuses", async () => {
    const db = getDb();
    const out: ProjectionRefStatus[] = [];
    for (const ref of refs) {
      const [row] = await db
        .select({
          clientId: cuRoleProjectionCommands.clientId,
          destinationId: cuRoleProjectionCommands.destinationId,
          status: cuRoleProjectionCommands.status,
          verifiedAt: cuRoleProjectionCommands.verifiedAt,
        })
        .from(cuRoleProjectionCommands)
        .where(
          and(
            eq(cuRoleProjectionCommands.clientId, ref.clientId),
            eq(cuRoleProjectionCommands.destinationId, ref.destinationId),
          ),
        )
        .limit(1);
      if (row) {
        out.push({
          clientId: row.clientId,
          destinationId: row.destinationId,
          status: String(row.status),
          verifiedAt: row.verifiedAt ?? null,
        });
      }
    }
    return out;
  });
}

// ─── Manual resync ────────────────────────────────────────────────────────────

export async function manualResyncProjectionCommand(
  clientId: string,
  destinationId: string,
): Promise<{ ok: boolean; message: string }> {
  const env = resolveProjectionEnvironment();
  if (env === "unconfigured") {
    return { ok: false, message: "Projection environment not configured" };
  }

  return withDbAttribution("cuRoleProjection:manualResync", async () => {
    const db = getDb();
    const reset = await db.transaction(async (tx) => {
      const updated = await tx.execute(sql`
        UPDATE cu_role_projection_commands
        SET status = 'pending',
            next_attempt_at = NULL,
            last_error = NULL,
            last_error_code = NULL,
            terminal_at = NULL,
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            attempt_count = 0,
            mutation_attempts = 0,
            updated_at = now()
        WHERE client_id = ${clientId}
          AND destination_id = ${destinationId}
          AND (
            (status = 'failed' AND terminal_at IS NOT NULL)
            OR status = 'blocked'
          )
          AND lease_owner IS NULL
          AND lease_token IS NULL
          AND lease_expires_at IS NULL
        RETURNING id, revision, attempt_count
      `);
      const row = (updated.rows as Array<{
        id: string;
        revision: string;
        attempt_count: number;
      }>)[0];
      if (!row) return false;
      await enqueueProjectionWakeInTx(tx, new Date(), {
        commandId: row.id,
        revision: row.revision,
        attemptCount: Number(row.attempt_count),
      });
      return true;
    });
    if (!reset) {
      return {
        ok: false,
        message:
          "Command is not eligible for Re-sync. Only failed or blocked commands with no lease may be reset.",
      };
    }

    await enqueueClickUpRoleProjectionJob().catch((e) =>
      console.warn("[ClickUpRoleProjection] Manual resync accelerator kick failed:", e),
    );
    return { ok: true, message: "Command reset to pending with a durable wake" };
  });
}
