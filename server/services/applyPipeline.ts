import { workerDb } from "../db";
import {
  applyState,
  workResultLog,
  sourceEventLog,
  workQueue,
  type ApplyOutcome,
  type WorkResultLogRow,
  type ApplyStateRow,
} from "@shared/schema";
import { eq, and, sql, ne, inArray, isNull, isNotNull } from "drizzle-orm";
import { createHash } from "crypto";

export interface ApplyInput {
  workResultId: string;
  sourceEventId: string;
  sourceSystem: string;
  resultType: string;
  resultJson: unknown;
  rulesetVersion?: string | null;
  correlationId?: string | null;
}

export interface ApplyResult {
  outcome: ApplyOutcome;
  applyTarget: string;
  appliedVersion?: string;
  responseJson?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface ApplyHandler {
  applyTarget: string;
  handle(input: ApplyInput): Promise<ApplyResult>;
}

export function computeInputHash(resultJson: unknown): string {
  const raw = typeof resultJson === "string" ? resultJson : JSON.stringify(resultJson);
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export function isVersionStale(
  incomingVersion: string | undefined | null,
  appliedVersion: string | undefined | null,
): boolean {
  if (!incomingVersion || !appliedVersion) return false;

  const incomingNum = Number(incomingVersion);
  const appliedNum = Number(appliedVersion);
  if (!isNaN(incomingNum) && !isNaN(appliedNum)) {
    return incomingNum < appliedNum;
  }

  const incomingDate = Date.parse(incomingVersion);
  const appliedDate = Date.parse(appliedVersion);
  if (!isNaN(incomingDate) && !isNaN(appliedDate)) {
    return incomingDate < appliedDate;
  }

  return incomingVersion < appliedVersion;
}

export async function loadWorkResult(workResultId: string): Promise<WorkResultLogRow | null> {
  const [row] = await workerDb
    .select()
    .from(workResultLog)
    .where(eq(workResultLog.id, workResultId))
    .limit(1);
  return row ?? null;
}

/**
 * Task #1836 — Canonical writer for `apply_state` rows.
 *
 * The table carries a UNIQUE constraint on (work_result_id, apply_target)
 * (`as_work_result_target_idx`). Historically two independent writers
 * inserted rows for that key:
 *
 *   1. `getOrCreateApplyState` (applyPipeline driver) used
 *      `.onConflictDoNothing()` and was safe.
 *   2. `recordApplyOutcome` in `pipelineProcessor.ts` did a plain
 *      `.insert(...)` with no conflict handling. When path #1 (or a
 *      concurrent #2 in another worker) had already inserted a pending
 *      row for the same (work_result_id, apply_target), the second
 *      INSERT crashed with `duplicate key value violates unique
 *      constraint "as_work_result_target_idx"` and the work item was
 *      dead-lettered. Warp-drain in May 2026 surfaced ~700 such
 *      dead-letters in `front_webhook_apply`.
 *
 * `upsertApplyState` is the single canonical writer. Every other module
 * MUST go through it — enforced by `scripts/lint-apply-state-writers.ts`.
 *
 * Semantics on conflict:
 *
 *   - If the existing row already has `outcome = 'success'` and the
 *     incoming outcome is non-success, we DO NOT downgrade. We only
 *     bump `attempt_count` and refresh `updated_at`. This prevents a
 *     late-arriving retry or a concurrent failed attempt from
 *     clobbering a real success.
 *
 *   - Otherwise we replace the metadata columns with the incoming
 *     values, bump `attempt_count`, refresh `attempted_at`, and set
 *     `completed_at = now()` iff the new outcome is `success` or
 *     `skipped` (else NULL).
 *
 *   - `created_at`, `id`, `source_event_id`, `source_system` are
 *     preserved on update (Postgres preserves any column not listed in
 *     the SET clause).
 */
export async function upsertApplyState(params: {
  workResultId: string;
  sourceEventId: string;
  sourceSystem: string;
  applyTarget: string;
  outcome: ApplyOutcome;
  rulesetVersion?: string | null;
  appliedVersion?: string | null;
  inputHash?: string | null;
  responseJson?: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
  /** Bump `attempt_count` on conflict. Default true. Set false for
   *  "create-or-fetch" callers (e.g. getOrCreateApplyState) that
   *  haven't actually attempted anything yet. */
  incrementAttemptOnConflict?: boolean;
}): Promise<ApplyStateRow> {
  const bump = params.incrementAttemptOnConflict ?? true;
  const incomingOutcome = params.outcome;
  const completedAtForNew =
    incomingOutcome === "success" || incomingOutcome === "skipped"
      ? new Date()
      : null;

  // Fetch-or-create mode (incrementAttemptOnConflict=false, caller hasn't
  // actually attempted yet — e.g. getOrCreateApplyState). On conflict we
  // must NOT mutate the existing row at all, otherwise a concurrently
  // recorded `failed` or `success` row could be silently clobbered back
  // to `pending`. ON CONFLICT DO NOTHING + fallback SELECT preserves the
  // existing row verbatim.
  if (!bump) {
    const inserted = await workerDb
      .insert(applyState)
      .values({
        workResultId: params.workResultId,
        sourceEventId: params.sourceEventId,
        sourceSystem: params.sourceSystem,
        applyTarget: params.applyTarget,
        outcome: incomingOutcome,
        rulesetVersion: params.rulesetVersion ?? null,
        appliedVersion: params.appliedVersion ?? null,
        inputHash: params.inputHash ?? null,
        responseJson:
          (params.responseJson as Record<string, unknown> | undefined) ?? null,
        errorCode: params.errorCode ?? null,
        errorMessage: params.errorMessage ?? null,
        attemptCount: 0,
        attemptedAt: null,
        completedAt: completedAtForNew,
      })
      .onConflictDoNothing({
        target: [applyState.workResultId, applyState.applyTarget],
      })
      .returning();
    if (inserted.length > 0) return inserted[0]!;
    const [existing] = await workerDb
      .select()
      .from(applyState)
      .where(
        and(
          eq(applyState.workResultId, params.workResultId),
          eq(applyState.applyTarget, params.applyTarget),
        ),
      )
      .limit(1);
    return existing!;
  }

  // Record-outcome mode (caller did attempt work). On conflict we update
  // metadata + bump attempt_count, but a prior `success` is never
  // downgraded by a later non-success retry.
  // `EXCLUDED` refers to the row proposed by INSERT; columns prefixed
  // with the table name refer to the existing row.
  const preserveSuccess = sql`(${applyState.outcome} = 'success' AND EXCLUDED.outcome <> 'success')`;

  const [row] = await workerDb
    .insert(applyState)
    .values({
      workResultId: params.workResultId,
      sourceEventId: params.sourceEventId,
      sourceSystem: params.sourceSystem,
      applyTarget: params.applyTarget,
      outcome: incomingOutcome,
      rulesetVersion: params.rulesetVersion ?? null,
      appliedVersion: params.appliedVersion ?? null,
      inputHash: params.inputHash ?? null,
      responseJson:
        (params.responseJson as Record<string, unknown> | undefined) ?? null,
      errorCode: params.errorCode ?? null,
      errorMessage: params.errorMessage ?? null,
      attemptCount: 1,
      attemptedAt: new Date(),
      completedAt: completedAtForNew,
    })
    .onConflictDoUpdate({
      target: [applyState.workResultId, applyState.applyTarget],
      set: {
        outcome: sql`CASE WHEN ${preserveSuccess} THEN ${applyState.outcome} ELSE EXCLUDED.outcome END`,
        rulesetVersion: sql`CASE WHEN ${preserveSuccess} THEN ${applyState.rulesetVersion} ELSE EXCLUDED.ruleset_version END`,
        appliedVersion: sql`CASE WHEN ${preserveSuccess} THEN ${applyState.appliedVersion} ELSE EXCLUDED.applied_version END`,
        inputHash: sql`CASE WHEN ${preserveSuccess} THEN ${applyState.inputHash} ELSE EXCLUDED.input_hash END`,
        responseJson: sql`CASE WHEN ${preserveSuccess} THEN ${applyState.responseJson} ELSE EXCLUDED.response_json END`,
        errorCode: sql`CASE WHEN ${preserveSuccess} THEN ${applyState.errorCode} ELSE EXCLUDED.error_code END`,
        errorMessage: sql`CASE WHEN ${preserveSuccess} THEN ${applyState.errorMessage} ELSE EXCLUDED.error_message END`,
        attemptCount: sql`${applyState.attemptCount} + 1`,
        attemptedAt: sql`now()`,
        completedAt: sql`CASE WHEN ${applyState.outcome} = 'success' THEN ${applyState.completedAt} WHEN EXCLUDED.outcome IN ('success','skipped') THEN now() ELSE NULL END`,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  return row!;
}

export async function getOrCreateApplyState(
  input: ApplyInput,
  applyTarget: string,
): Promise<ApplyStateRow> {
  const [existing] = await workerDb
    .select()
    .from(applyState)
    .where(
      and(
        eq(applyState.workResultId, input.workResultId),
        eq(applyState.applyTarget, applyTarget),
      ),
    )
    .limit(1);

  if (existing) return existing;

  const hash = computeInputHash(input.resultJson);
  return upsertApplyState({
    workResultId: input.workResultId,
    sourceEventId: input.sourceEventId,
    sourceSystem: input.sourceSystem,
    applyTarget,
    outcome: "pending",
    inputHash: hash,
    rulesetVersion: input.rulesetVersion ?? null,
    incrementAttemptOnConflict: false,
  });
}

export async function isAlreadyApplied(
  workResultId: string,
  applyTarget: string,
  currentInputHash: string,
): Promise<{ skip: boolean; reason?: string }> {
  const [row] = await workerDb
    .select()
    .from(applyState)
    .where(
      and(
        eq(applyState.workResultId, workResultId),
        eq(applyState.applyTarget, applyTarget),
      ),
    )
    .limit(1);

  if (!row) return { skip: false };

  if (row.outcome === "success" && row.inputHash === currentInputHash) {
    return { skip: true, reason: "already_applied_same_hash" };
  }

  if (row.outcome === "skipped" && row.inputHash === currentInputHash) {
    return { skip: true, reason: "previously_skipped" };
  }

  return { skip: false };
}

async function checkVersionStaleness(
  sourceEventId: string,
  applyTarget: string,
  rulesetVersion: string | null | undefined,
): Promise<{ stale: boolean; currentVersion?: string }> {
  if (!rulesetVersion) return { stale: false };

  const [latestApplied] = await workerDb
    .select({ appliedVersion: applyState.appliedVersion })
    .from(applyState)
    .where(
      and(
        eq(applyState.sourceEventId, sourceEventId),
        eq(applyState.applyTarget, applyTarget),
        eq(applyState.outcome, "success"),
      ),
    )
    .orderBy(sql`${applyState.completedAt} DESC NULLS LAST`)
    .limit(1);

  if (!latestApplied?.appliedVersion) return { stale: false };

  if (isVersionStale(rulesetVersion, latestApplied.appliedVersion)) {
    return { stale: true, currentVersion: latestApplied.appliedVersion };
  }

  return { stale: false };
}

export async function recordApplyOutcome(
  applyStateId: string,
  result: ApplyResult,
  inputHash: string,
): Promise<void> {
  const now = new Date();

  await workerDb
    .update(applyState)
    .set({
      outcome: result.outcome,
      appliedVersion: result.appliedVersion ?? null,
      responseJson: result.responseJson ?? null,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
      inputHash,
      attemptCount: sql`${applyState.attemptCount} + 1`,
      attemptedAt: now,
      completedAt: result.outcome === "success" || result.outcome === "skipped" ? now : null,
      updatedAt: now,
    })
    .where(eq(applyState.id, applyStateId));
}

async function tryMarkSourceEventApplied(sourceEventId: string): Promise<void> {
  const [event] = await workerDb
    .select({
      expectedResultCount: sourceEventLog.expectedResultCount,
      resultsFinalizedAt: sourceEventLog.resultsFinalizedAt,
      status: sourceEventLog.status,
    })
    .from(sourceEventLog)
    .where(eq(sourceEventLog.id, sourceEventId))
    .limit(1);

  if (!event) return;
  if (event.status === "applied") return;

  if (event.expectedResultCount != null && !event.resultsFinalizedAt) {
    return;
  }

  const completedResults = await workerDb
    .select({ id: workResultLog.id })
    .from(workResultLog)
    .where(
      and(
        eq(workResultLog.sourceEventId, sourceEventId),
        eq(workResultLog.status, "completed"),
      ),
    );

  if (completedResults.length === 0) return;

  if (event.expectedResultCount != null && completedResults.length < event.expectedResultCount) {
    return;
  }

  const resultIds = completedResults.map((r) => r.id);

  const terminalApplyStates = await workerDb
    .select({ workResultId: applyState.workResultId })
    .from(applyState)
    .where(
      and(
        inArray(applyState.workResultId, resultIds),
        inArray(applyState.outcome, ["success", "skipped"]),
      ),
    );

  const terminalResultIds = new Set(terminalApplyStates.map((a) => a.workResultId));

  for (const rid of resultIds) {
    if (!terminalResultIds.has(rid)) {
      return;
    }
  }

  const now = new Date();
  await workerDb
    .update(sourceEventLog)
    .set({
      status: "applied",
      appliedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(sourceEventLog.id, sourceEventId),
        sql`${sourceEventLog.status} != 'applied'`,
      ),
    );
}

export async function runApply(
  handler: ApplyHandler,
  input: ApplyInput,
): Promise<ApplyResult> {
  const inputHash = computeInputHash(input.resultJson);

  const versionCheck = await checkVersionStaleness(
    input.sourceEventId,
    handler.applyTarget,
    input.rulesetVersion,
  );

  if (versionCheck.stale) {
    console.log(
      `[ApplyPipeline] Version stale for ${handler.applyTarget}: incoming=${input.rulesetVersion} current=${versionCheck.currentVersion}`,
    );

    const state = await getOrCreateApplyState(input, handler.applyTarget);
    const staleResult: ApplyResult = {
      outcome: "skipped",
      applyTarget: handler.applyTarget,
      responseJson: {
        reason: "stale_version",
        incomingVersion: input.rulesetVersion,
        currentVersion: versionCheck.currentVersion,
      },
    };
    await recordApplyOutcome(state.id, staleResult, inputHash);
    return staleResult;
  }

  const idempotencyCheck = await isAlreadyApplied(
    input.workResultId,
    handler.applyTarget,
    inputHash,
  );

  if (idempotencyCheck.skip) {
    console.log(
      `[ApplyPipeline] Skipping ${handler.applyTarget} for workResult=${input.workResultId}: ${idempotencyCheck.reason}`,
    );

    const state = await getOrCreateApplyState(input, handler.applyTarget);
    const skipResult: ApplyResult = {
      outcome: "skipped",
      applyTarget: handler.applyTarget,
      responseJson: { reason: idempotencyCheck.reason },
    };
    await recordApplyOutcome(state.id, skipResult, inputHash);

    return skipResult;
  }

  const state = await getOrCreateApplyState(input, handler.applyTarget);

  try {
    const result = await handler.handle(input);

    if (!result.appliedVersion && input.rulesetVersion) {
      result.appliedVersion = input.rulesetVersion;
    }

    await recordApplyOutcome(state.id, result, inputHash);

    if (result.outcome === "success" || result.outcome === "skipped") {
      await tryMarkSourceEventApplied(input.sourceEventId);
    }

    console.log(
      `[ApplyPipeline] ${handler.applyTarget} outcome=${result.outcome} workResult=${input.workResultId}`,
    );

    return result;
  } catch (err: any) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const failResult: ApplyResult = {
      outcome: "failed",
      applyTarget: handler.applyTarget,
      errorCode: "APPLY_ERROR",
      errorMessage,
    };

    await recordApplyOutcome(state.id, failResult, inputHash);

    console.error(
      `[ApplyPipeline] ${handler.applyTarget} FAILED workResult=${input.workResultId}: ${errorMessage}`,
    );

    throw err;
  }
}

export async function runApplyForWorkResult(
  workResultId: string,
  handlers: ApplyHandler[],
): Promise<ApplyResult[]> {
  const wr = await loadWorkResult(workResultId);
  if (!wr) {
    throw new Error(`[ApplyPipeline] WorkResult not found: ${workResultId}`);
  }

  const input: ApplyInput = {
    workResultId: wr.id,
    sourceEventId: wr.sourceEventId,
    sourceSystem: wr.sourceSystem,
    resultType: wr.resultType,
    resultJson: wr.resultJson,
    rulesetVersion: wr.rulesetVersion,
    correlationId: wr.correlationId,
  };

  const results: ApplyResult[] = [];
  for (const handler of handlers) {
    const result = await runApply(handler, input);
    results.push(result);
  }
  return results;
}

export async function enqueueApplyJob(
  workResultId: string,
  resultType: string,
  opts?: {
    priority?: number;
    maxAttempts?: number;
    dedupeKey?: string;
  },
): Promise<string> {
  const dedupeKey = opts?.dedupeKey ?? `apply:${resultType}:${workResultId}`;

  const [inserted] = await workerDb
    .insert(workQueue)
    .values({
      queueName: resultType,
      jobType: resultType,
      workloadClass: "ingestion",
      priority: opts?.priority ?? 5,
      status: "pending",
      payload: { workResultId },
      maxAttempts: opts?.maxAttempts ?? 3,
      dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: workQueue.id });

  if (inserted) {
    console.log(
      `[ApplyPipeline] Enqueued apply job: type=${resultType} workResult=${workResultId} jobId=${inserted.id}`,
    );
    return inserted.id;
  }

  const [existing] = await workerDb
    .select({ id: workQueue.id })
    .from(workQueue)
    .where(
      and(
        eq(workQueue.dedupeKey, dedupeKey),
        inArray(workQueue.status, ["pending", "leased", "processing"]),
      ),
    )
    .limit(1);

  return existing?.id ?? dedupeKey;
}

export async function ensureDurablePipelineTables(): Promise<void> {
  const summary: { created: string[]; alreadyPresent: string[]; columnsAdded: string[]; errors: string[] } = {
    created: [],
    alreadyPresent: [],
    columnsAdded: [],
    errors: [],
  };

  const requiredTables = ["source_event_log", "work_result_log", "apply_state", "front_hydrate_snapshots"];

  const existingTablesResult = await workerDb.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(ARRAY['source_event_log', 'work_result_log', 'apply_state', 'front_hydrate_snapshots'])
  `);
  const existingRows = Array.isArray(existingTablesResult) ? existingTablesResult : existingTablesResult.rows ?? [];
  const existingTables = new Set(existingRows.map((r: any) => r.table_name));

  // --- source_event_log ---
  if (!existingTables.has("source_event_log")) {
    await workerDb.execute(sql`
      CREATE TABLE IF NOT EXISTS source_event_log (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        source_system varchar NOT NULL CHECK (source_system IN ('front', 'zoom', 'semrush')),
        source_event_type varchar NOT NULL,
        source_object_id varchar NOT NULL,
        dedupe_key varchar NOT NULL,
        payload_json jsonb NOT NULL,
        normalized_identity_keys_json jsonb,
        ruleset_version varchar,
        status varchar DEFAULT 'received' NOT NULL CHECK (status IN ('received', 'normalized', 'ready_to_apply', 'applied', 'failed', 'dead_lettered', 'ignored')),
        replayable boolean DEFAULT true NOT NULL,
        correlation_id varchar,
        attempt_count integer DEFAULT 0 NOT NULL,
        max_attempts integer DEFAULT 5 NOT NULL,
        error_code varchar,
        error_message text,
        retry_at timestamp,
        received_at timestamp DEFAULT now() NOT NULL,
        normalized_at timestamp,
        applied_at timestamp,
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL,
        expected_result_count integer,
        results_finalized_at timestamp
      )
    `);
    await workerDb.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS sel_dedupe_key_idx ON source_event_log (dedupe_key)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS sel_status_idx ON source_event_log (status)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS sel_status_retry_at_idx ON source_event_log (status, retry_at)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS sel_source_system_idx ON source_event_log (source_system)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS sel_source_system_type_idx ON source_event_log (source_system, source_event_type)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS sel_correlation_id_idx ON source_event_log (correlation_id)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS sel_received_at_idx ON source_event_log (received_at)`);
    summary.created.push("source_event_log");
  } else {
    summary.alreadyPresent.push("source_event_log");
  }

  await workerDb.execute(sql`ALTER TABLE source_event_log ADD COLUMN IF NOT EXISTS expected_result_count INTEGER`);
  await workerDb.execute(sql`ALTER TABLE source_event_log ADD COLUMN IF NOT EXISTS results_finalized_at TIMESTAMP`);

  // --- work_result_log ---
  if (!existingTables.has("work_result_log")) {
    await workerDb.execute(sql`
      CREATE TABLE IF NOT EXISTS work_result_log (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        source_event_id varchar NOT NULL REFERENCES source_event_log (id) ON DELETE CASCADE,
        source_system varchar NOT NULL CHECK (source_system IN ('front', 'zoom', 'semrush')),
        result_type varchar NOT NULL,
        result_json jsonb NOT NULL,
        status varchar DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'dead_lettered')),
        ruleset_version varchar,
        correlation_id varchar,
        error_code varchar,
        error_message text,
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL
      )
    `);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS wrl_source_event_id_idx ON work_result_log (source_event_id)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS wrl_status_idx ON work_result_log (status)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS wrl_source_system_idx ON work_result_log (source_system)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS wrl_correlation_id_idx ON work_result_log (correlation_id)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS wrl_result_type_idx ON work_result_log (result_type)`);
    summary.created.push("work_result_log");
  } else {
    summary.alreadyPresent.push("work_result_log");
  }

  // --- apply_state ---
  if (!existingTables.has("apply_state")) {
    await workerDb.execute(sql`
      CREATE TABLE IF NOT EXISTS apply_state (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        work_result_id varchar NOT NULL REFERENCES work_result_log (id) ON DELETE CASCADE,
        source_event_id varchar NOT NULL REFERENCES source_event_log (id) ON DELETE CASCADE,
        source_system varchar NOT NULL CHECK (source_system IN ('front', 'zoom', 'semrush')),
        apply_target varchar NOT NULL,
        outcome varchar DEFAULT 'pending' NOT NULL CHECK (outcome IN ('pending', 'success', 'partial', 'conflict', 'failed', 'skipped')),
        attempt_count integer DEFAULT 0 NOT NULL,
        max_attempts integer DEFAULT 3 NOT NULL,
        ruleset_version varchar,
        applied_version varchar,
        input_hash varchar,
        response_json jsonb,
        error_code varchar,
        error_message text,
        retry_at timestamp,
        attempted_at timestamp,
        completed_at timestamp,
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL
      )
    `);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS as_work_result_id_idx ON apply_state (work_result_id)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS as_source_event_id_idx ON apply_state (source_event_id)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS as_outcome_idx ON apply_state (outcome)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS as_outcome_retry_at_idx ON apply_state (outcome, retry_at)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS as_source_system_idx ON apply_state (source_system)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS as_apply_target_idx ON apply_state (apply_target)`);
    await workerDb.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS as_work_result_target_idx ON apply_state (work_result_id, apply_target)`);
    summary.created.push("apply_state");
  } else {
    summary.alreadyPresent.push("apply_state");
    await workerDb.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS as_work_result_target_idx ON apply_state (work_result_id, apply_target)`);
  }

  // --- front_hydrate_snapshots ---
  if (!existingTables.has("front_hydrate_snapshots")) {
    await workerDb.execute(sql`
      CREATE TABLE IF NOT EXISTS front_hydrate_snapshots (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id text NOT NULL,
        version_key text NOT NULL UNIQUE,
        conversation_json jsonb NOT NULL,
        messages_json jsonb NOT NULL,
        message_count integer NOT NULL,
        hydrated_at timestamp NOT NULL DEFAULT now(),
        expires_at timestamp
      )
    `);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS front_hydrate_conversation_id_idx ON front_hydrate_snapshots (conversation_id)`);
    await workerDb.execute(sql`CREATE INDEX IF NOT EXISTS front_hydrate_version_key_idx ON front_hydrate_snapshots (version_key)`);
    summary.created.push("front_hydrate_snapshots");
  } else {
    summary.alreadyPresent.push("front_hydrate_snapshots");
  }

  // --- Post-create verification ---
  const verifyResult = await workerDb.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(ARRAY['source_event_log', 'work_result_log', 'apply_state', 'front_hydrate_snapshots'])
  `);
  const verifyRows = Array.isArray(verifyResult) ? verifyResult : verifyResult.rows ?? [];
  const verifiedTables = new Set(verifyRows.map((r: any) => r.table_name));

  const missingTables = requiredTables.filter(t => !verifiedTables.has(t));
  if (missingTables.length > 0) {
    const errMsg = `[DurablePipeline] FATAL: verification failed — missing tables after bootstrap: ${missingTables.join(", ")}`;
    console.error(errMsg);
    throw new Error(errMsg);
  }

  const requiredColumns: Record<string, string[]> = {
    source_event_log: ["id", "source_system", "source_event_type", "source_object_id", "dedupe_key", "payload_json", "status", "expected_result_count", "results_finalized_at"],
    work_result_log: ["id", "source_event_id", "source_system", "result_type", "result_json", "status"],
    apply_state: ["id", "work_result_id", "source_event_id", "source_system", "apply_target", "outcome"],
    front_hydrate_snapshots: ["id", "conversation_id", "version_key", "conversation_json", "messages_json"],
  };

  const colResult = await workerDb.execute(sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY(ARRAY['source_event_log', 'work_result_log', 'apply_state', 'front_hydrate_snapshots'])
  `);
  const colRows = Array.isArray(colResult) ? colResult : colResult.rows ?? [];
  const columnsByTable = new Map<string, Set<string>>();
  for (const row of colRows as any[]) {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Set());
    columnsByTable.get(row.table_name)!.add(row.column_name);
  }

  for (const [table, cols] of Object.entries(requiredColumns)) {
    const tableCols = columnsByTable.get(table);
    if (!tableCols) {
      summary.errors.push(`${table}: no columns found`);
      continue;
    }
    const missingCols = cols.filter(c => !tableCols.has(c));
    if (missingCols.length > 0) {
      summary.errors.push(`${table}: missing columns [${missingCols.join(", ")}]`);
    }
  }

  if (summary.errors.length > 0) {
    const errMsg = `[DurablePipeline] FATAL: column verification failed — ${summary.errors.join("; ")}`;
    console.error(errMsg);
    throw new Error(errMsg);
  }

  console.log(
    `[DurablePipeline] Bootstrap complete — created: [${summary.created.join(", ") || "none"}], already present: [${summary.alreadyPresent.join(", ") || "none"}], verification: PASSED`
  );
}

export async function enqueueApplyJobsForEvent(
  sourceEventId: string,
  handlerMapping: Record<string, string>,
): Promise<string[]> {
  const results = await workerDb
    .select()
    .from(workResultLog)
    .where(
      and(
        eq(workResultLog.sourceEventId, sourceEventId),
        eq(workResultLog.status, "completed"),
      ),
    );

  const jobIds: string[] = [];
  for (const wr of results) {
    const applyType = handlerMapping[wr.resultType];
    if (applyType) {
      const jobId = await enqueueApplyJob(wr.id, applyType);
      jobIds.push(jobId);
    }
  }
  return jobIds;
}
