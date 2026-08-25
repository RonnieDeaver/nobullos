// @db-pool-intent: ambient
//
// Task #4331 — storage helpers for the deal automation admin surface
// (deal_automation_rules CRUD + run/event history reads). All callers are
// request-scoped routes, so getDb() here lands on the ambient api pool;
// execution-side writes live in server/services/dealAutomationEngine.ts.
//
// Invariants owned here:
//   - A rule's pipelineId is DERIVED from its trigger stage (never
//     client-supplied), and fromStageId must belong to the same pipeline
//     and differ from the trigger stage — a cross-pipeline or self-loop
//     filter can never be persisted.
//   - Reads are bounded: run history is limit-capped, rule stats use the
//     (rule_id, started_at) index, pending-event counts cap at 500.

import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  dealAutomationRules,
  dealAutomationRuns,
  dealStageEvents,
  dealStages,
  type DealAutomationAction,
  type DealAutomationRule,
  type DealAutomationRun,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";

export class AutomationStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationStageError";
  }
}

// ── Rules CRUD ───────────────────────────────────────────────────────────────

export interface DealAutomationRuleStats {
  totalRuns: number;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
}

export type DealAutomationRuleWithStats = DealAutomationRule & {
  stats: DealAutomationRuleStats;
};

export async function listAutomationRulesWithStats(
  pipelineId?: string,
): Promise<DealAutomationRuleWithStats[]> {
  return withDbAttribution("dealAutomation:listRules", async () => {
    const db = getDb();
    const where = pipelineId
      ? eq(dealAutomationRules.pipelineId, pipelineId)
      : undefined;
    const rules = await db
      .select()
      .from(dealAutomationRules)
      .where(where)
      .orderBy(
        asc(dealAutomationRules.stageId),
        asc(dealAutomationRules.position),
        asc(dealAutomationRules.createdAt),
      );
    if (rules.length === 0) return [];

    // Rules are operator-created (dozens at most) — a per-rule latest-run
    // lookup on the (rule_id, started_at) index beats a DISTINCT ON over
    // the whole runs table and stays trivially bounded.
    const out: DealAutomationRuleWithStats[] = [];
    for (const rule of rules) {
      const [agg] = await db
        .select({
          totalRuns: sql<number>`count(*)::int`,
        })
        .from(dealAutomationRuns)
        .where(eq(dealAutomationRuns.ruleId, rule.id));
      const [last] = await db
        .select({
          startedAt: dealAutomationRuns.startedAt,
          status: dealAutomationRuns.status,
        })
        .from(dealAutomationRuns)
        .where(eq(dealAutomationRuns.ruleId, rule.id))
        .orderBy(desc(dealAutomationRuns.startedAt))
        .limit(1);
      out.push({
        ...rule,
        stats: {
          totalRuns: agg?.totalRuns ?? 0,
          lastRunAt: last?.startedAt ?? null,
          lastRunStatus: last?.status ?? null,
        },
      });
    }
    return out;
  });
}

export async function getAutomationRule(
  id: string,
): Promise<DealAutomationRule | undefined> {
  return withDbAttribution("dealAutomation:getRule", async () => {
    const [row] = await getDb()
      .select()
      .from(dealAutomationRules)
      .where(eq(dealAutomationRules.id, id))
      .limit(1);
    return row;
  });
}

async function assertFromStageValid(
  stagePipelineId: string,
  stageId: string,
  fromStageId: string,
): Promise<void> {
  if (fromStageId === stageId) {
    throw new AutomationStageError(
      "From-stage filter cannot equal the trigger stage",
    );
  }
  const [fromStage] = await withDbAttribution(
    "dealAutomation:assertFromStage",
    async () => {
      return getDb()
        .select({ id: dealStages.id, pipelineId: dealStages.pipelineId })
        .from(dealStages)
        .where(eq(dealStages.id, fromStageId))
        .limit(1);
    },
  );
  if (!fromStage) throw new AutomationStageError("From-stage not found");
  if (fromStage.pipelineId !== stagePipelineId) {
    throw new AutomationStageError(
      "From-stage belongs to a different pipeline",
    );
  }
}

export interface CreateAutomationRuleInput {
  stageId: string;
  fromStageId: string | null;
  name: string;
  enabled: boolean;
  actions: DealAutomationAction[];
  createdBy: string;
}

export async function createAutomationRule(
  input: CreateAutomationRuleInput,
): Promise<DealAutomationRule> {
  return withDbAttribution("dealAutomation:createRule", async () => {
    const db = getDb();
    const [stage] = await db
      .select({ id: dealStages.id, pipelineId: dealStages.pipelineId })
      .from(dealStages)
      .where(eq(dealStages.id, input.stageId))
      .limit(1);
    if (!stage) throw new AutomationStageError("Trigger stage not found");
    if (input.fromStageId) {
      await assertFromStageValid(stage.pipelineId, stage.id, input.fromStageId);
    }
    const [{ maxPosition }] = await db
      .select({
        maxPosition: sql<number>`coalesce(max(${dealAutomationRules.position}), 0)::int`,
      })
      .from(dealAutomationRules)
      .where(eq(dealAutomationRules.stageId, input.stageId));
    const [rule] = await db
      .insert(dealAutomationRules)
      .values({
        pipelineId: stage.pipelineId,
        stageId: input.stageId,
        fromStageId: input.fromStageId,
        name: input.name,
        enabled: input.enabled,
        actions: input.actions,
        position: (maxPosition ?? 0) + 1,
        createdBy: input.createdBy,
        updatedBy: input.createdBy,
      })
      .returning();
    return rule;
  });
}

export interface UpdateAutomationRuleInput {
  name?: string;
  fromStageId?: string | null;
  enabled?: boolean;
  actions?: DealAutomationAction[];
  position?: number;
}

export async function updateAutomationRule(
  id: string,
  patch: UpdateAutomationRuleInput,
  updatedBy: string,
): Promise<DealAutomationRule | undefined> {
  return withDbAttribution("dealAutomation:updateRule", async () => {
    const db = getDb();
    const [existing] = await db
      .select()
      .from(dealAutomationRules)
      .where(eq(dealAutomationRules.id, id))
      .limit(1);
    if (!existing) return undefined;
    if (patch.fromStageId) {
      await assertFromStageValid(
        existing.pipelineId,
        existing.stageId,
        patch.fromStageId,
      );
    }
    const [updated] = await db
      .update(dealAutomationRules)
      .set({ ...patch, updatedBy, updatedAt: new Date() }) // spread-write-approved: patch is zod-parsed updateDealAutomationRuleBodySchema output (stageId/pipelineId immutable — absent from the schema; audit columns set explicitly here)
      .where(eq(dealAutomationRules.id, id))
      .returning();
    return updated;
  });
}

export async function deleteAutomationRule(id: string): Promise<boolean> {
  return withDbAttribution("dealAutomation:deleteRule", async () => {
    const rows = await getDb()
      .delete(dealAutomationRules)
      .where(eq(dealAutomationRules.id, id))
      .returning({ id: dealAutomationRules.id });
    return rows.length > 0;
  });
}

// ── Run history ──────────────────────────────────────────────────────────────

export const AUTOMATION_RUNS_DEFAULT_LIMIT = 50;
export const AUTOMATION_RUNS_MAX_LIMIT = 200;

export async function listAutomationRuns(opts: {
  ruleId?: string;
  dealId?: string;
  limit?: number;
}): Promise<DealAutomationRun[]> {
  const limit = Math.min(
    Math.max(opts.limit ?? AUTOMATION_RUNS_DEFAULT_LIMIT, 1),
    AUTOMATION_RUNS_MAX_LIMIT,
  );
  return withDbAttribution("dealAutomation:listRuns", async () => {
    const clauses: SQL[] = [];
    if (opts.ruleId) clauses.push(eq(dealAutomationRuns.ruleId, opts.ruleId));
    if (opts.dealId) clauses.push(eq(dealAutomationRuns.dealId, opts.dealId));
    return getDb()
      .select()
      .from(dealAutomationRuns)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(dealAutomationRuns.startedAt))
      .limit(limit);
  });
}

// ── Event backlog (status surface) ───────────────────────────────────────────

export interface PendingEventStats {
  /** Capped at 500 — "500+" is already an incident, exact size irrelevant. */
  pendingCount: number;
  oldestPendingAt: Date | null;
}

export async function getPendingEventStats(): Promise<PendingEventStats> {
  return withDbAttribution("dealAutomation:pendingStats", async () => {
    const db = getDb();
    const [row] = await db
      .select({
        pendingCount: sql<number>`count(*)::int`,
        oldestPendingAt: sql<Date | null>`min(${dealStageEvents.createdAt})`,
      })
      .from(
        sql`(select ${dealStageEvents.createdAt} as created_at from ${dealStageEvents} where ${dealStageEvents.status} = 'pending' order by ${dealStageEvents.createdAt} asc limit 500) as pending_capped`,
      );
    return {
      pendingCount: row?.pendingCount ?? 0,
      oldestPendingAt: row?.oldestPendingAt ?? null,
    };
  });
}
