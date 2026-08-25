// @db-pool-intent: ambient
/**
 * Task #4331 — deal stage automation execution engine.
 *
 * `processDealStageEvent` is the single consumer of `deal_stage_events`
 * rows (emitted in-transaction by dealsStorage.createDeal/moveDealStage);
 * the `deal_stage_automation` work-queue handler in dealAutomationQueue.ts
 * is its only production caller, so the ambient getDb() here inherits the
 * scheduler's worker context. Every DB touch is lexically inside its own
 * `withDbAttribution` label.
 *
 * Exactly-once contract (layered):
 *   1. event rows are UNIQUE per stage-history row — one event per move;
 *   2. jobs dedupe on `deal_stage_automation:<eventId>` while pending;
 *   3. events flip pending → processed once every matching rule has a
 *      terminal run row — replayed jobs no-op on processed events;
 *   4. run rows are UNIQUE per (rule, event) — the INSERT … ON CONFLICT DO
 *      NOTHING claim means a rule can never double-fire for one move. A
 *      claim that finds an existing TERMINAL run skips; an existing
 *      `running` run (crash mid-run) resumes with per-action gating:
 *      actions already terminal keep their outcome, a `clickup_task` stuck
 *      at `attempting` (write-ahead marker set BEFORE the vendor call)
 *      records failed/unknown instead of re-calling ClickUp — replaying
 *      never duplicates tasks. The three local actions are idempotent
 *      (notify dedupes while unread, set_property converges, lifecycle is
 *      forward-only) so re-attempting them is safe.
 *
 * Failure semantics: each action gets ONE attempt (no in-run retries — a
 * duplicate ClickUp task is worse than a logged failure). Any failed
 * action marks the run failed, lands in the run log, and alerts via
 * `workflow.deal_automation.run_failed` (per-rule dedupeKey, house
 * suppression window). Handler-level throws are reserved for infra errors
 * around the bookkeeping itself — those ride the queue's retry machinery.
 *
 * Kill switch: `deal_automation_enabled` system setting, read FRESH per
 * event (no cache latch — an operator flip takes effect on the next
 * event). Missing = enabled; false/0/off/no = disabled. When disabled,
 * matching enabled rules get `skipped`/`killswitch` run rows (visible in
 * history) and the event is marked processed — nothing executes.
 */
import { and, asc, eq, isNull, or } from "drizzle-orm";
import {
  clients,
  clickupUserTokens,
  dealAutomationRules,
  dealAutomationRuns,
  dealPipelines,
  dealStageEvents,
  dealStages,
  deals,
  users,
  type Deal,
  type DealAutomationAction,
  type DealAutomationActionResult,
  type DealAutomationRule,
  type DealAutomationRun,
  type DealStageEvent,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { getSystemSettingFresh } from "../storage/settingsStorage";
import { updateDeal, type UpdateDealInput } from "../storage/dealsStorage";
import { advanceClientLifecycle } from "../storage/leadLifecycleStorage";
import { notifyUser } from "./notifications/userInbox";
import { notifyByType } from "./notifications/dispatcher";
import { getAccessToken } from "./clickUpIntegration";
import { createTask } from "./clickUpClient";
import { evaluateRecordWriteSafe } from "./tagSegmentEngine";

export const DEAL_AUTOMATION_KILL_SWITCH_KEY = "deal_automation_enabled";
export const DEAL_AUTOMATION_RUN_FAILED_NOTIFICATION_ID =
  "workflow.deal_automation.run_failed";

/**
 * Global automations kill switch. Missing = enabled (kill switches are
 * explicit opt-OUT, mirroring the notifications dispatcher); read errors
 * fail open the same way. Read fresh per event — deal moves are
 * human-scale, so the extra read is negligible and flips are immediate.
 */
export async function isDealAutomationEnabled(): Promise<boolean> {
  try {
    const row = await getSystemSettingFresh(DEAL_AUTOMATION_KILL_SWITCH_KEY);
    if (row?.value == null) return true;
    const v = row.value.trim().toLowerCase();
    return !(v === "false" || v === "0" || v === "off" || v === "no");
  } catch {
    return true;
  }
}

// ── Template rendering ───────────────────────────────────────────────────────

export interface DealAutomationContext {
  deal: Deal;
  pipelineName: string;
  stageName: string;
  fromStageName: string | null;
  clientName: string | null;
  ownerName: string | null;
}

/**
 * Replaces {{token}} placeholders (see shared/models/dealAutomation.ts for
 * the documented set). Unknown tokens are left verbatim — visible beats
 * silently vanishing when an operator typos a template.
 */
export function renderAutomationTemplate(
  template: string,
  ctx: DealAutomationContext,
): string {
  const tokens: Record<string, string> = {
    deal_name: ctx.deal.name,
    pipeline_name: ctx.pipelineName,
    stage_name: ctx.stageName,
    from_stage_name: ctx.fromStageName ?? "(created)",
    client_name: ctx.clientName ?? "(no client)",
    owner_name: ctx.ownerName ?? "(no owner)",
    amount: ctx.deal.amount != null ? String(ctx.deal.amount) : "(no amount)",
  };
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : match,
  );
}

// ── Action executors ─────────────────────────────────────────────────────────

type ActionOutcome = Pick<
  DealAutomationActionResult,
  "status" | "detail" | "error"
>;

async function executeNotifyAction(
  action: Extract<DealAutomationAction, { type: "notify" }>,
  rule: DealAutomationRule,
  event: DealStageEvent,
  ctx: DealAutomationContext,
  actionIndex: number,
): Promise<ActionOutcome> {
  const targetUserId =
    action.target === "owner" ? ctx.deal.ownerId : (action.userId ?? null);
  if (!targetUserId) {
    return {
      status: "skipped",
      detail:
        action.target === "owner"
          ? "deal has no owner"
          : "no target user configured",
    };
  }
  const result = await notifyUser(targetUserId, {
    category: "crm",
    title: renderAutomationTemplate(action.title, ctx),
    body: action.body ? renderAutomationTemplate(action.body, ctx) : undefined,
    deepLink: `/deals/${ctx.deal.id}`,
    dedupeKey: `deal_automation:${rule.id}:${event.id}:${actionIndex}`,
    metadata: { ruleId: rule.id, eventId: event.id, dealId: ctx.deal.id },
  });
  if (!result) {
    return { status: "failed", error: "notifyUser rejected the notification" };
  }
  return {
    status: "succeeded",
    detail: result.deduped ? "notified (deduped)" : "notified",
  };
}

/** Deal owner's ClickUp connection, else any connected user's (Service
 * Desk precedent) — automation runs without a request context, so there
 * is no "current user" to prefer. */
async function resolveClickUpToken(
  ownerId: string | null,
): Promise<string | null> {
  if (ownerId) {
    const ownerToken = await getAccessToken(ownerId);
    if (ownerToken) return ownerToken;
  }
  const fallbackUserId = await withDbAttribution(
    "dealAutomation:clickupFallbackToken",
    async () => {
      const [row] = await getDb()
        .select({ userId: clickupUserTokens.userId })
        .from(clickupUserTokens)
        .where(eq(clickupUserTokens.status, "connected"))
        .limit(1);
      return row?.userId ?? null;
    },
  );
  return fallbackUserId ? getAccessToken(fallbackUserId) : null;
}

async function executeClickUpAction(
  action: Extract<DealAutomationAction, { type: "clickup_task" }>,
  ctx: DealAutomationContext,
): Promise<ActionOutcome> {
  const token = await resolveClickUpToken(ctx.deal.ownerId);
  if (!token) {
    // Graceful degradation, not a failure: the rule keeps working for the
    // other actions and starts creating tasks as soon as someone connects.
    return { status: "skipped", detail: "no ClickUp connection available" };
  }
  const body: Parameters<typeof createTask>[2] = {
    name: renderAutomationTemplate(action.nameTemplate, ctx),
  };
  if (action.descriptionTemplate) {
    body.description = renderAutomationTemplate(action.descriptionTemplate, ctx);
  }
  if (action.dueInDays != null) {
    body.due_date = Date.now() + action.dueInDays * 24 * 60 * 60 * 1000;
  }
  const json: any = await createTask(token, action.listId, body);
  const taskId = json?.id ? String(json.id) : "?";
  const url = json?.url ? ` — ${String(json.url)}` : "";
  return { status: "succeeded", detail: `created task ${taskId}${url}` };
}

async function executeSetPropertyAction(
  action: Extract<DealAutomationAction, { type: "set_property" }>,
  ctx: DealAutomationContext,
): Promise<ActionOutcome> {
  const patch: UpdateDealInput = {};
  switch (action.property) {
    case "amount":
      patch.amount = action.value as number;
      break;
    case "expectedCloseDate":
      patch.expectedCloseDate = action.value as string;
      break;
    case "ownerId": {
      const ownerId = action.value as string;
      const exists = await withDbAttribution(
        "dealAutomation:setPropertyOwnerCheck",
        async () => {
          const [row] = await getDb()
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, ownerId))
            .limit(1);
          return Boolean(row);
        },
      );
      if (!exists) {
        return { status: "failed", error: `owner user ${ownerId} not found` };
      }
      patch.ownerId = ownerId;
      break;
    }
    case "notes":
      patch.notes = action.value as string;
      break;
    case "lostReason":
      patch.lostReason = action.value as string;
      break;
  }
  const updated = await updateDeal(ctx.deal.id, patch);
  if (!updated) return { status: "failed", error: "deal no longer exists" };
  // Mirror the deals routes: tag/segment rules re-evaluate on every deal
  // write (non-throwing; the sweep heals on hiccup).
  await evaluateRecordWriteSafe("deal", ctx.deal.id);
  return {
    status: "succeeded",
    detail: `${action.property} = ${String(action.value)}`,
  };
}

async function executeAdvanceLifecycleAction(
  action: Extract<DealAutomationAction, { type: "advance_lifecycle" }>,
  rule: DealAutomationRule,
  ctx: DealAutomationContext,
): Promise<ActionOutcome> {
  if (!ctx.deal.clientId) {
    return { status: "skipped", detail: "deal has no linked client" };
  }
  const result = await advanceClientLifecycle(
    ctx.deal.clientId,
    action.targetStage,
    {
      source: "automation",
      actorUserId: null,
      reason: `Deal automation rule "${rule.name}"`,
    },
  );
  if (!result.client && result.fromStage === null) {
    return { status: "failed", error: "linked client no longer exists" };
  }
  return {
    status: "succeeded",
    detail: result.changed
      ? `${result.fromStage} → ${result.toStage}`
      : `already at/past ${action.targetStage}`,
  };
}

async function executeAction(
  action: DealAutomationAction,
  rule: DealAutomationRule,
  event: DealStageEvent,
  ctx: DealAutomationContext,
  actionIndex: number,
): Promise<ActionOutcome> {
  switch (action.type) {
    case "notify":
      return executeNotifyAction(action, rule, event, ctx, actionIndex);
    case "clickup_task":
      return executeClickUpAction(action, ctx);
    case "set_property":
      return executeSetPropertyAction(action, ctx);
    case "advance_lifecycle":
      return executeAdvanceLifecycleAction(action, rule, ctx);
  }
}

// ── Run bookkeeping ──────────────────────────────────────────────────────────

async function persistRunProgress(
  runId: string,
  actionResults: DealAutomationActionResult[],
): Promise<void> {
  await withDbAttribution("dealAutomation:persistRunProgress", async () => {
    await getDb()
      .update(dealAutomationRuns)
      .set({ actionResults })
      .where(eq(dealAutomationRuns.id, runId));
  });
}

async function finalizeRun(
  runId: string,
  actionResults: DealAutomationActionResult[],
  error: string | null,
): Promise<void> {
  const failed = actionResults.some((r) => r.status === "failed");
  await withDbAttribution("dealAutomation:finalizeRun", async () => {
    await getDb()
      .update(dealAutomationRuns)
      .set({
        status: failed ? "failed" : "succeeded",
        actionResults,
        error,
        finishedAt: new Date(),
      })
      .where(eq(dealAutomationRuns.id, runId));
  });
}

/**
 * Executes one rule for one event behind the (rule, event) claim row.
 * Returns the terminal status, or "already_ran" when a terminal run
 * already existed (idempotent replay).
 */
async function executeRuleForEvent(
  rule: DealAutomationRule,
  event: DealStageEvent,
  ctx: DealAutomationContext,
): Promise<"succeeded" | "failed" | "already_ran"> {
  // Claim: the UNIQUE (rule_id, event_id) insert IS the idempotency gate.
  const claimed = await withDbAttribution("dealAutomation:claimRun", async () => {
    const [row] = await getDb()
      .insert(dealAutomationRuns)
      .values({
        ruleId: rule.id,
        eventId: event.id,
        dealId: ctx.deal.id,
        ruleName: rule.name,
        dealName: ctx.deal.name,
        status: "running",
        actionResults: [],
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  });

  let run: DealAutomationRun | null = claimed;
  let priorResults: DealAutomationActionResult[] = [];
  if (!run) {
    const existing = await withDbAttribution(
      "dealAutomation:loadExistingRun",
      async () => {
        const [row] = await getDb()
          .select()
          .from(dealAutomationRuns)
          .where(
            and(
              eq(dealAutomationRuns.ruleId, rule.id),
              eq(dealAutomationRuns.eventId, event.id),
            ),
          )
          .limit(1);
        return row ?? null;
      },
    );
    if (!existing) {
      // Conflict without a row means a concurrent claimer holds it; that
      // sibling finishes the work — treat as already handled.
      return "already_ran";
    }
    if (existing.status !== "running") return "already_ran";
    // Crash-resume: keep terminal action outcomes, never re-fire attempts.
    run = existing;
    priorResults = Array.isArray(existing.actionResults)
      ? existing.actionResults
      : [];
  }

  const actions = Array.isArray(rule.actions) ? rule.actions : [];
  const results: DealAutomationActionResult[] = [];
  let firstError: string | null = null;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const prior = priorResults.find((r) => r.index === i);
    if (prior && prior.status !== "attempting") {
      results.push(prior);
      if (prior.status === "failed" && !firstError) {
        firstError = prior.error ?? "action failed";
      }
      continue;
    }
    if (prior && prior.status === "attempting") {
      // Write-ahead marker survived a crash: the vendor call may or may
      // not have landed. Never re-fire (P11 — a duplicate ClickUp task is
      // worse than a logged unknown); record the uncertainty instead.
      const unknown: DealAutomationActionResult = {
        index: i,
        type: action.type,
        status: "failed",
        error: "outcome unknown — interrupted mid-attempt; not re-fired",
      };
      results.push(unknown);
      if (!firstError) firstError = unknown.error ?? null;
      continue;
    }

    if (action.type === "clickup_task") {
      // Persist the attempting marker BEFORE the non-idempotent vendor call.
      const attempting: DealAutomationActionResult = {
        index: i,
        type: action.type,
        status: "attempting",
      };
      await persistRunProgress(run.id, [...results, attempting]);
    }

    let outcome: ActionOutcome;
    try {
      outcome = await executeAction(action, rule, event, ctx, i);
    } catch (err: any) {
      outcome = {
        status: "failed",
        error: String(err?.message ?? err).slice(0, 500),
      };
    }
    const result: DealAutomationActionResult = {
      index: i,
      type: action.type,
      ...outcome,
    };
    results.push(result);
    if (result.status === "failed" && !firstError) {
      firstError = result.error ?? "action failed";
    }
    await persistRunProgress(run.id, results);
  }

  await finalizeRun(run.id, results, firstError);
  const failed = results.some((r) => r.status === "failed");

  if (failed) {
    // House alerting: never gate on promise resolution — notifyByType
    // resolves for skips/failures too; the delivery row is the evidence.
    await notifyByType(
      DEAL_AUTOMATION_RUN_FAILED_NOTIFICATION_ID,
      {
        text:
          `Deal automation rule "${rule.name}" failed for deal ` +
          `"${ctx.deal.name}": ${firstError ?? "action failed"} ` +
          `(run history: /admin/deal-automation)`,
      },
      {
        dedupeKey: `rule:${rule.id}`,
        failureType: results.find((r) => r.status === "failed")?.type ?? null,
        metadata: { ruleId: rule.id, eventId: event.id, dealId: ctx.deal.id },
        mirrorDeepLink: "/admin/deal-automation",
      },
    );
  }

  return failed ? "failed" : "succeeded";
}

// ── Event processing (the queue handler's body) ──────────────────────────────

export interface ProcessEventSummary {
  outcome:
    | "processed"
    | "already_processed"
    | "missing_event"
    | "missing_deal"
    | "same_stage"
    | "killswitch";
  rulesMatched: number;
  runsSucceeded: number;
  runsFailed: number;
  runsSkipped: number;
}

async function markEventProcessed(eventId: string): Promise<void> {
  await withDbAttribution("dealAutomation:markProcessed", async () => {
    await getDb()
      .update(dealStageEvents)
      .set({ status: "processed", processedAt: new Date() })
      .where(
        and(
          eq(dealStageEvents.id, eventId),
          eq(dealStageEvents.status, "pending"),
        ),
      );
  });
}

async function loadMatchingEnabledRules(
  event: DealStageEvent,
): Promise<DealAutomationRule[]> {
  return withDbAttribution("dealAutomation:matchRules", async () => {
    // "Enters stage X (optionally only from stage Y)": a from-filtered
    // rule matches only the exact prior stage; creation rows (from null)
    // match only unfiltered rules.
    const fromFilter = event.fromStageId
      ? or(
          isNull(dealAutomationRules.fromStageId),
          eq(dealAutomationRules.fromStageId, event.fromStageId),
        )
      : isNull(dealAutomationRules.fromStageId);
    return getDb()
      .select()
      .from(dealAutomationRules)
      .where(
        and(
          eq(dealAutomationRules.stageId, event.toStageId),
          eq(dealAutomationRules.enabled, true),
          fromFilter,
        ),
      )
      .orderBy(asc(dealAutomationRules.position), asc(dealAutomationRules.createdAt));
  });
}

async function loadContext(
  event: DealStageEvent,
): Promise<DealAutomationContext | null> {
  return withDbAttribution("dealAutomation:loadContext", async () => {
    const db = getDb();
    const [deal] = await db
      .select()
      .from(deals)
      .where(eq(deals.id, event.dealId))
      .limit(1);
    if (!deal) return null;

    const stageIds = [event.toStageId, event.fromStageId].filter(
      (v): v is string => Boolean(v),
    );
    const stageRows = await db
      .select({ id: dealStages.id, name: dealStages.name })
      .from(dealStages)
      .where(
        stageIds.length === 1
          ? eq(dealStages.id, stageIds[0])
          : or(...stageIds.map((id) => eq(dealStages.id, id))),
      );
    const stageName =
      stageRows.find((s) => s.id === event.toStageId)?.name ?? "(stage)";
    const fromStageName = event.fromStageId
      ? (stageRows.find((s) => s.id === event.fromStageId)?.name ?? null)
      : null;

    const [pipeline] = await db
      .select({ name: dealPipelines.name })
      .from(dealPipelines)
      .where(eq(dealPipelines.id, event.pipelineId))
      .limit(1);

    let clientName: string | null = null;
    if (deal.clientId) {
      const [client] = await db
        .select({ firmName: clients.firmName })
        .from(clients)
        .where(eq(clients.id, deal.clientId))
        .limit(1);
      clientName = client?.firmName ?? null;
    }

    let ownerName: string | null = null;
    if (deal.ownerId) {
      const [owner] = await db
        .select({
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        })
        .from(users)
        .where(eq(users.id, deal.ownerId))
        .limit(1);
      if (owner) {
        ownerName =
          [owner.firstName, owner.lastName].filter(Boolean).join(" ") ||
          owner.email ||
          null;
      }
    }

    return {
      deal,
      pipelineName: pipeline?.name ?? "(pipeline)",
      stageName,
      fromStageName,
      clientName,
      ownerName,
    };
  });
}

/**
 * Consumes one deal_stage_events row. Idempotent at every layer (see the
 * module header); safe to call with stale/duplicate/unknown event ids.
 */
export async function processDealStageEvent(
  eventId: string,
): Promise<ProcessEventSummary> {
  const summary: ProcessEventSummary = {
    outcome: "processed",
    rulesMatched: 0,
    runsSucceeded: 0,
    runsFailed: 0,
    runsSkipped: 0,
  };

  const event = await withDbAttribution("dealAutomation:loadEvent", async () => {
    const [row] = await getDb()
      .select()
      .from(dealStageEvents)
      .where(eq(dealStageEvents.id, eventId))
      .limit(1);
    return row ?? null;
  });
  if (!event) {
    // Phantom job (event pruned/rolled back) — harmless no-op.
    summary.outcome = "missing_event";
    return summary;
  }
  if (event.status === "processed") {
    summary.outcome = "already_processed";
    return summary;
  }
  if (event.fromStageId && event.fromStageId === event.toStageId) {
    // Same-stage history row — the deal did not ENTER anything.
    await markEventProcessed(event.id);
    summary.outcome = "same_stage";
    return summary;
  }

  const rules = await loadMatchingEnabledRules(event);
  summary.rulesMatched = rules.length;

  if (rules.length === 0) {
    await markEventProcessed(event.id);
    return summary;
  }

  const ctx = await loadContext(event);
  if (!ctx) {
    // Deal deleted between the move and processing (its events cascade
    // away with it, so this is a narrow race) — nothing to act on.
    await markEventProcessed(event.id);
    summary.outcome = "missing_deal";
    return summary;
  }

  const enabled = await isDealAutomationEnabled();
  if (!enabled) {
    // Global kill switch: durable, visible skips — one per matched rule —
    // then the event is done. Nothing executes, nothing re-fires later.
    for (const rule of rules) {
      const inserted = await withDbAttribution(
        "dealAutomation:killswitchSkipRun",
        async () => {
          const [row] = await getDb()
            .insert(dealAutomationRuns)
            .values({
              ruleId: rule.id,
              eventId: event.id,
              dealId: ctx.deal.id,
              ruleName: rule.name,
              dealName: ctx.deal.name,
              status: "skipped",
              skipReason: "killswitch",
              actionResults: [],
              finishedAt: new Date(),
            })
            .onConflictDoNothing()
            .returning({ id: dealAutomationRuns.id });
          return Boolean(row);
        },
      );
      if (inserted) summary.runsSkipped++;
    }
    await markEventProcessed(event.id);
    summary.outcome = "killswitch";
    console.log(
      `[dealAutomation] kill switch OFF — recorded ${summary.runsSkipped} skipped run(s) for event ${event.id}`,
    );
    return summary;
  }

  for (const rule of rules) {
    const result = await executeRuleForEvent(rule, event, ctx);
    if (result === "succeeded") summary.runsSucceeded++;
    else if (result === "failed") summary.runsFailed++;
  }

  await markEventProcessed(event.id);
  return summary;
}
