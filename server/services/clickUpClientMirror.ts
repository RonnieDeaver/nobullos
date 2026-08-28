/**
 * Task #5245 — durable canonical ClickUp Client List lifecycle mirror.
 * Claims in short worker transactions, performs vendor I/O without a DB lease,
 * and finalizes with lease+revision CAS.
 */
// @db-pool-intent: worker
import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  cuClientListMappings,
  cuClientMirrorCommands,
  type WorkQueueJob,
} from "@shared/schema";
import { getDb, runWithWorkerDb, withDbAttribution } from "../db";
import { ensureKillSwitchesLoaded, isKillSwitchEnabled } from "./killSwitches";
import { CANONICAL_PRODUCTION_LIST_ID } from "./adsOs/paidSearchRoleContract";
import {
  ClientMirrorVendorError,
  clientIdentityMarker,
  createClientParent,
  findParentsByMarker,
  getClientParent,
  updateClientParent,
  type RemoteClientParent,
} from "./clickUpClientMirrorClient";
import { CLICKUP_CLIENT_MIRROR_QUEUE } from "./clickUpClientMirrorKick";
import { isRunningInDeployment } from "../lib/deploymentEnv";

const LEASE_MS = 5 * 60_000;
const MAX_DRAIN = 50;
const SAFE_RETRY_CODES = new Set(["auth", "rate_limited", "timeout", "vendor_5xx", "exhausted"]);

export interface ClaimedClientMirrorCommand {
  id: string;
  clientId: string;
  desiredName: string;
  desiredArchived: boolean;
  mergedIntoClientId: string | null;
  revision: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  leaseToken: string;
}

export interface ClientMirrorDeps {
  findByMarker: typeof findParentsByMarker;
  getParent: typeof getClientParent;
  createParent: typeof createClientParent;
  updateParent: typeof updateClientParent;
  killSwitchActive: () => Promise<boolean>;
}

const defaults: ClientMirrorDeps = {
  findByMarker: findParentsByMarker,
  getParent: getClientParent,
  createParent: createClientParent,
  updateParent: updateClientParent,
  killSwitchActive: async () => {
    await ensureKillSwitchesLoaded();
    return isKillSwitchEnabled("clickup_role_projection");
  },
};
let testDeps: ClientMirrorDeps | null = null;
export function __test_setClientMirrorDeps(deps: ClientMirrorDeps | null): void {
  testDeps = deps;
}

function mapClaim(rows: any[]): ClaimedClientMirrorCommand | null {
  const row = rows[0];
  return row ? {
    id: String(row.id),
    clientId: String(row.client_id),
    desiredName: String(row.desired_name),
    desiredArchived: row.desired_archived === true,
    mergedIntoClientId: row.merged_into_client_id ? String(row.merged_into_client_id) : null,
    revision: String(row.revision),
    status: String(row.status),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    leaseToken: String(row.lease_token),
  } : null;
}

export async function claimClientMirrorCommand(): Promise<ClaimedClientMirrorCommand | null> {
  const now = new Date();
  const result = await withDbAttribution("cuClientMirror:claim", () => getDb().execute(sql`
    UPDATE cu_client_mirror_commands SET
      lease_owner = ${process.env.REPL_ID ?? "worker"},
      lease_token = ${crypto.randomUUID()},
      lease_expires_at = ${new Date(now.getTime() + LEASE_MS)},
      attempt_count = attempt_count + 1,
      updated_at = now()
    WHERE id IN (
      SELECT id FROM cu_client_mirror_commands
      WHERE status IN ('pending', 'ambiguous', 'failed')
        AND terminal_at IS NULL
        AND attempt_count < max_attempts
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
        AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING *
  `));
  return mapClaim(result.rows as any[]);
}

function cas(command: ClaimedClientMirrorCommand) {
  return sql`id = ${command.id} AND revision = ${command.revision} AND lease_token = ${command.leaseToken}`;
}

async function stop(
  command: ClaimedClientMirrorCommand,
  status: "blocked" | "drift",
  code: string,
  message: string,
): Promise<void> {
  await withDbAttribution("cuClientMirror:review", () => getDb().execute(sql`
    UPDATE cu_client_mirror_commands SET status=${status}, last_error_code=${code},
      last_error=${message.slice(0, 2000)}, terminal_at=now(),
      lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
      next_attempt_at=NULL, updated_at=now()
    WHERE ${cas(command)}
  `));
}

async function pauseForKillSwitch(command: ClaimedClientMirrorCommand): Promise<void> {
  await withDbAttribution("cuClientMirror:paused", () => getDb().execute(sql`
    UPDATE cu_client_mirror_commands SET status='pending',
      lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
      next_attempt_at=NULL, last_error_code=NULL, last_error=NULL, updated_at=now()
    WHERE ${cas(command)}
  `));
}

async function retry(
  command: ClaimedClientMirrorCommand,
  error: ClientMirrorVendorError,
): Promise<void> {
  if (command.attemptCount >= command.maxAttempts || error.code === "vendor_4xx") {
    await withDbAttribution("cuClientMirror:terminal", () => getDb().execute(sql`
      UPDATE cu_client_mirror_commands SET status='failed',
        last_error_code=${error.code === "vendor_4xx" ? "vendor_4xx" : "exhausted"},
        last_error=${error.message.slice(0, 2000)}, terminal_at=now(),
        lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
        next_attempt_at=NULL, updated_at=now()
      WHERE ${cas(command)}
    `));
    return;
  }
  const retryAt = new Date(Date.now() + Math.min(10 * 60_000, 10_000 * 2 ** (command.attemptCount - 1)));
  await withDbAttribution("cuClientMirror:retry", () => getDb().transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE cu_client_mirror_commands SET status=${error.ambiguous ? "ambiguous" : "failed"},
        last_error_code=${error.code}, last_error=${error.message.slice(0, 2000)},
        next_attempt_at=${retryAt}, lease_owner=NULL, lease_token=NULL,
        lease_expires_at=NULL, updated_at=now()
      WHERE ${cas(command)} RETURNING id
    `);
    if (((updated as any).rowCount ?? 0) > 0) {
      const { workQueue } = await import("@shared/schema");
      await tx.insert(workQueue).values({
        queueName: CLICKUP_CLIENT_MIRROR_QUEUE,
        jobType: CLICKUP_CLIENT_MIRROR_QUEUE,
        workloadClass: "maintenance",
        status: "pending",
        maxAttempts: 3,
        retryAt,
        dedupeKey: `clickup_client_mirror:${command.clientId}:${command.revision}:${command.attemptCount}`,
      }).onConflictDoNothing();
    }
  }));
}

async function persistMapping(
  command: ClaimedClientMirrorCommand,
  remote: RemoteClientParent,
): Promise<void> {
  await withDbAttribution("cuClientMirror:synced", () => getDb().transaction(async (tx) => {
    await tx.insert(cuClientListMappings).values({
      clientId: command.clientId,
      listId: CANONICAL_PRODUCTION_LIST_ID,
      taskId: remote.id,
      remoteTaskName: command.desiredName,
      ownedName: command.desiredName,
      ownedArchived: command.desiredArchived,
      provenance: {
        source: "client_lifecycle_mirror",
        marker: clientIdentityMarker(command.clientId),
        adoptedAt: new Date().toISOString(),
      },
      syncState: "verified",
      ownershipVerifiedAt: new Date(),
    }).onConflictDoUpdate({
      target: cuClientListMappings.clientId,
      set: {
        taskId: remote.id,
        listId: CANONICAL_PRODUCTION_LIST_ID,
        remoteTaskName: command.desiredName,
        ownedName: command.desiredName,
        ownedArchived: command.desiredArchived,
        syncState: "verified",
        ownershipVerifiedAt: new Date(),
        conflictEvidence: null,
        lastError: null,
        updatedAt: new Date(),
      },
    });
    await tx.execute(sql`
      UPDATE cu_client_mirror_commands SET status='synced', verified_at=now(),
        terminal_at=NULL, last_error_code=NULL, last_error=NULL,
        next_attempt_at=NULL, lease_owner=NULL, lease_token=NULL,
        lease_expires_at=NULL, updated_at=now()
      WHERE ${cas(command)}
    `);
  }));
}

export async function processClientMirrorCommand(
  command: ClaimedClientMirrorCommand,
  explicitDeps?: ClientMirrorDeps,
): Promise<void> {
  const deps = explicitDeps ?? testDeps ?? defaults;
  if (await deps.killSwitchActive()) {
    await pauseForKillSwitch(command);
    return;
  }
  try {
    const [mapping] = await withDbAttribution("cuClientMirror:mapping", () =>
      getDb().select().from(cuClientListMappings)
        .where(eq(cuClientListMappings.clientId, command.clientId)).limit(1));
    if (mapping && mapping.listId !== CANONICAL_PRODUCTION_LIST_ID) {
      await stop(command, "blocked", "wrong_list", "Existing mapping belongs to a non-canonical list");
      return;
    }

    // An unmapped or ambiguity-marked command ALWAYS performs a fresh complete
    // marker lookup before it is allowed to create.
    let remote: RemoteClientParent | null = null;
    const candidates = await deps.findByMarker(command.clientId);
    if (candidates.length > 1) {
      await stop(command, "drift", "duplicate_marker", `Found ${candidates.length} canonical parents with the same NoBull marker`);
      return;
    }
    if (candidates.length === 1) {
      remote = candidates[0];
      if (mapping && mapping.taskId !== remote.id) {
        await stop(command, "drift", "identity_drift", "Stable marker resolves to a task other than the authoritative mapping");
        return;
      }
    } else if (mapping) {
      // Fetching the mapped task makes marker removal distinguishable from a
      // transiently empty list page and produces a reviewable identity drift.
      remote = await deps.getParent(mapping.taskId);
    }

    if (remote && (remote.listId !== CANONICAL_PRODUCTION_LIST_ID || remote.parentId !== null)) {
      await stop(command, "blocked", "wrong_list", "Mapped ClickUp row is not a canonical parent task");
      return;
    }
    if (remote && !remote.description.includes(clientIdentityMarker(command.clientId))) {
      await stop(command, "drift", "identity_drift", "Stable NoBull client marker was removed or changed in ClickUp");
      return;
    }

    if (!remote) {
      if (command.desiredArchived) {
        await stop(command, "blocked", "missing_mapping", "Archived/merged client has no canonical ClickUp parent");
        return;
      }
      await deps.createParent(command.clientId, command.desiredName);
      // Do not trust a create response as ownership evidence. A fresh paginated
      // lookup also resolves timeout-after-success on the next attempt.
      const created = await deps.findByMarker(command.clientId);
      if (created.length !== 1) {
        throw new ClientMirrorVendorError(
          created.length > 1 ? "Create produced duplicate marked parents" : "Created parent was not visible in fresh lookup",
          "timeout",
          true,
        );
      }
      remote = created[0];
      if (remote.listId !== CANONICAL_PRODUCTION_LIST_ID || remote.parentId !== null) {
        await stop(command, "blocked", "wrong_list", "Created/adopted ClickUp row is not a canonical parent task");
        return;
      }
    }

    if (mapping) {
      const priorOwnedName = mapping.ownedName ?? mapping.remoteTaskName;
      if (priorOwnedName !== null && remote.name !== priorOwnedName && remote.name !== command.desiredName) {
        await stop(command, "drift", "name_drift", "ClickUp parent name changed outside NoBull");
        return;
      }
      if (mapping.ownedArchived === null && remote.archived !== command.desiredArchived) {
        await stop(command, "drift", "lifecycle_drift", "Legacy mapping has no NoBull-owned archive baseline");
        return;
      }
      if (mapping.ownedArchived !== null && remote.archived !== mapping.ownedArchived && remote.archived !== command.desiredArchived) {
        await stop(command, "drift", "lifecycle_drift", "ClickUp archive state changed outside NoBull");
        return;
      }
    }
    if (!remote) {
      throw new Error("Client mirror could not resolve a canonical parent after reconciliation");
    }
    const canonicalRemote = remote;
    const [taskOwner] = await withDbAttribution("cuClientMirror:taskOwner", () =>
      getDb().select({ clientId: cuClientListMappings.clientId })
        .from(cuClientListMappings)
        .where(and(
          eq(cuClientListMappings.listId, CANONICAL_PRODUCTION_LIST_ID),
          eq(cuClientListMappings.taskId, canonicalRemote.id),
        ))
        .limit(1));
    if (taskOwner && taskOwner.clientId !== command.clientId) {
      await stop(command, "drift", "duplicate_identity", "ClickUp parent is already mapped to another NoBull client");
      return;
    }
    const patch: { name?: string; archived?: boolean } = {};
    if (remote.name !== command.desiredName) patch.name = command.desiredName;
    if (remote.archived !== command.desiredArchived) patch.archived = command.desiredArchived;
    if (Object.keys(patch).length > 0) {
      if (await deps.killSwitchActive()) {
        await pauseForKillSwitch(command);
        return;
      }
      await deps.updateParent(remote.id, patch);
      remote = { ...remote, ...patch };
    }
    await persistMapping(command, remote);
  } catch (error) {
    await retry(
      command,
      error instanceof ClientMirrorVendorError
        ? error
        : new ClientMirrorVendorError(error instanceof Error ? error.message : "Unknown mirror failure", "vendor_5xx"),
    );
  }
}

export async function handleClickUpClientMirrorJob(_job: WorkQueueJob): Promise<{ cursor: string }> {
  return runWithWorkerDb(async () => {
    await ensureKillSwitchesLoaded();
    if (isKillSwitchEnabled("clickup_role_projection")) {
      return { cursor: "kill_switch:clickup_role_projection:paused" };
    }
    let drained = 0;
    while (drained < MAX_DRAIN) {
      const command = await claimClientMirrorCommand();
      if (!command) break;
      await processClientMirrorCommand(command);
      drained++;
    }
    return { cursor: `drained:${drained}` };
  });
}

/** One-shot deployment recovery for an expired lease whose wake was lost. */
export function scheduleClickUpClientMirrorBootCatchup(): void {
  if (!isRunningInDeployment()) return;
  setTimeout(() => {
    void runWithWorkerDb(async () => {
      await ensureKillSwitchesLoaded();
      if (isKillSwitchEnabled("clickup_role_projection")) return;
      const rows = await withDbAttribution("cuClientMirror:bootCatchup", () =>
        getDb().execute(sql`
          SELECT id FROM cu_client_mirror_commands
          WHERE status IN ('pending','ambiguous','failed')
            AND terminal_at IS NULL AND attempt_count < max_attempts
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
            AND (lease_expires_at IS NULL OR lease_expires_at <= now())
            AND created_at < now() - interval '30 seconds'
          LIMIT 500
        `));
      if ((rows.rows ?? []).length === 0) return;
      const { enqueueJob } = await import("./workScheduler");
      await enqueueJob({
        queueName: CLICKUP_CLIENT_MIRROR_QUEUE,
        workloadClass: "maintenance",
        dedupeKey: "clickup_client_mirror:boot_catchup",
        maxAttempts: 3,
      });
    }).catch((error) => {
      console.error("[ClickUpClientMirror] boot catch-up failed:", error);
    });
  }, 30_000);
}

export interface ClientMirrorStatusRow {
  id: string;
  clientId: string;
  status: string;
  attemptCount: number;
  lastErrorCode: string | null;
  lastError: string | null;
  retryEligible: boolean;
}

export async function listClientMirrorStatuses(limit = 200): Promise<ClientMirrorStatusRow[]> {
  const rows = await withDbAttribution("cuClientMirror:listStatus", () =>
    getDb().select().from(cuClientMirrorCommands)
      .orderBy(sql`${cuClientMirrorCommands.updatedAt} DESC`)
      .limit(Math.min(Math.max(limit, 1), 500)));
  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    status: row.status,
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode ?? null,
    lastError: row.lastError ?? null,
    retryEligible: row.status === "failed" && row.terminalAt !== null &&
      row.leaseToken === null && SAFE_RETRY_CODES.has(row.lastErrorCode ?? ""),
  }));
}

/** Atomic safe-terminal retry. Never clears ambiguity, review drift, or a lease. */
export async function retryClientMirrorCommand(commandId: string): Promise<boolean> {
  await ensureKillSwitchesLoaded();
  if (isKillSwitchEnabled("clickup_role_projection")) return false;
  const result = await withDbAttribution("cuClientMirror:manualRetry", () => getDb().transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE cu_client_mirror_commands SET status='pending', attempt_count=0,
        next_attempt_at=NULL, terminal_at=NULL, last_error=NULL,
        last_error_code=NULL, updated_at=now()
      WHERE id=${commandId} AND status='failed' AND terminal_at IS NOT NULL
        AND lease_token IS NULL
        AND last_error_code IN ('auth','rate_limited','timeout','vendor_5xx','exhausted')
      RETURNING client_id, revision
    `);
    const row = (updated.rows as any[])[0];
    if (!row) return false;
    const { workQueue } = await import("@shared/schema");
    await tx.insert(workQueue).values({
      queueName: CLICKUP_CLIENT_MIRROR_QUEUE,
      jobType: CLICKUP_CLIENT_MIRROR_QUEUE,
      workloadClass: "maintenance",
      status: "pending",
      maxAttempts: 3,
      retryAt: new Date(),
      dedupeKey: `clickup_client_mirror:${row.client_id}:${row.revision}:manual`,
    }).onConflictDoNothing();
    return true;
  }));
  return result;
}
