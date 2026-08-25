// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import {
  agentMatchSettings,
  agentMatchSettingHistory,
  type AgentMatchSetting,
  type AgentMatchSettingHistory,
} from "@shared/schema";
import { getDb } from "../db";
import { and, desc, eq, gte, lte, or, sql } from "drizzle-orm";

let agentMatchSettingHistoryColumnsReady: Promise<void> | null = null;

/**
 * Ensure the resend + auto-retry tracking columns exist on
 * `agent_match_setting_history`. Mirrors the runtime ALTER pattern used by
 * `ensureAdminSettingAuditTable`. The auto-retry counters (Task #672) default
 * to 0 so legacy rows enter the retry loop fresh.
 */
async function ensureAgentMatchSettingHistoryResendColumns(): Promise<void> {
  if (!agentMatchSettingHistoryColumnsReady) {
    agentMatchSettingHistoryColumnsReady = (async () => {
      await getDb().execute(sql`
        ALTER TABLE "agent_match_setting_history"
          ADD COLUMN IF NOT EXISTS "last_resend_at" timestamp,
          ADD COLUMN IF NOT EXISTS "last_resend_by" varchar REFERENCES users(id),
          ADD COLUMN IF NOT EXISTS "last_resend_source" varchar,
          ADD COLUMN IF NOT EXISTS "restore_from_history_id" varchar,
          ADD COLUMN IF NOT EXISTS "restore_from_changed_at" timestamp,
          ADD COLUMN IF NOT EXISTS "slack_attempt_count" integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS "email_attempt_count" integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS "last_auto_retry_at" timestamp,
          ADD COLUMN IF NOT EXISTS "auto_retry_giveup_notified_at" timestamp
      `);
    })().catch((err) => {
      agentMatchSettingHistoryColumnsReady = null;
      throw err;
    });
  }
  return agentMatchSettingHistoryColumnsReady;
}

export async function ensureAgentMatchSettingHistoryAutoRetryColumns(): Promise<void> {
  await ensureAgentMatchSettingHistoryResendColumns();
}

export async function listAgentMatchSettings(): Promise<AgentMatchSetting[]> {
  return getDb().select().from(agentMatchSettings);
}

export async function getAgentMatchSetting(
  source: string,
  settingKey: string,
): Promise<AgentMatchSetting | undefined> {
  const [row] = await getDb()
    .select()
    .from(agentMatchSettings)
    .where(and(eq(agentMatchSettings.source, source), eq(agentMatchSettings.settingKey, settingKey)));
  return row;
}

export async function upsertAgentMatchSetting(params: {
  source: string;
  settingKey: string;
  value: number;
  updatedBy?: string | null;
  restoreFromHistoryId?: string | null;
  restoreFromChangedAt?: Date | null;
}): Promise<{ row: AgentMatchSetting; previousValue: number | null; historyId: string }> {
  await ensureAgentMatchSettingHistoryResendColumns();
  return getDb().transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(agentMatchSettings)
      .where(and(eq(agentMatchSettings.source, params.source), eq(agentMatchSettings.settingKey, params.settingKey)));
    const previousValue = existing ? existing.value : null;

    let row: AgentMatchSetting;
    if (existing) {
      const [updated] = await tx
        .update(agentMatchSettings)
        .set({
          value: params.value,
          updatedBy: params.updatedBy ?? null,
          updatedAt: new Date(),
        })
        .where(eq(agentMatchSettings.id, existing.id))
        .returning();
      row = updated;
    } else {
      const [inserted] = await tx
        .insert(agentMatchSettings)
        .values({
          source: params.source,
          settingKey: params.settingKey,
          value: params.value,
          updatedBy: params.updatedBy ?? null,
        })
        .returning();
      row = inserted;
    }

    const [historyRow] = await tx.insert(agentMatchSettingHistory).values({
      source: params.source,
      settingKey: params.settingKey,
      oldValue: previousValue,
      newValue: params.value,
      changedBy: params.updatedBy ?? null,
      restoreFromHistoryId: params.restoreFromHistoryId ?? null,
      restoreFromChangedAt: params.restoreFromChangedAt ?? null,
    }).returning({ id: agentMatchSettingHistory.id });

    return { row, previousValue, historyId: historyRow.id };
  });
}

export async function deleteAgentMatchSetting(params: {
  source: string;
  settingKey: string;
  changedBy?: string | null;
  restoreFromHistoryId?: string | null;
  restoreFromChangedAt?: Date | null;
}): Promise<{ previousValue: number; historyId: string } | null> {
  await ensureAgentMatchSettingHistoryResendColumns();
  return getDb().transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(agentMatchSettings)
      .where(and(eq(agentMatchSettings.source, params.source), eq(agentMatchSettings.settingKey, params.settingKey)));
    if (!existing) return null;

    await tx.delete(agentMatchSettings).where(eq(agentMatchSettings.id, existing.id));

    const [historyRow] = await tx.insert(agentMatchSettingHistory).values({
      source: params.source,
      settingKey: params.settingKey,
      oldValue: existing.value,
      newValue: null,
      changedBy: params.changedBy ?? null,
      restoreFromHistoryId: params.restoreFromHistoryId ?? null,
      restoreFromChangedAt: params.restoreFromChangedAt ?? null,
    }).returning({ id: agentMatchSettingHistory.id });

    return { previousValue: existing.value, historyId: historyRow.id };
  });
}

export async function updateAgentMatchSettingHistoryDelivery(params: {
  id: string;
  slackStatus?: string | null;
  emailStatus?: string | null;
  slackFailureReason?: string | null;
  emailFailureReason?: string | null;
  lastResendAt?: Date | null;
  lastResendBy?: string | null;
  lastResendSource?: string | null;
  slackAttemptCount?: number | null;
  emailAttemptCount?: number | null;
  lastAutoRetryAt?: Date | null;
  autoRetryGiveupNotifiedAt?: Date | null;
}): Promise<void> {
  await ensureAgentMatchSettingHistoryResendColumns();
  const patch: Record<string, string | number | Date | null> = {};
  if (params.slackStatus !== undefined) patch.slackStatus = params.slackStatus;
  if (params.emailStatus !== undefined) patch.emailStatus = params.emailStatus;
  if (params.slackFailureReason !== undefined) patch.slackFailureReason = params.slackFailureReason;
  if (params.emailFailureReason !== undefined) patch.emailFailureReason = params.emailFailureReason;
  if (params.lastResendAt !== undefined) patch.lastResendAt = params.lastResendAt;
  if (params.lastResendBy !== undefined) patch.lastResendBy = params.lastResendBy;
  if (params.lastResendSource !== undefined) patch.lastResendSource = params.lastResendSource;
  if (params.slackAttemptCount !== undefined) patch.slackAttemptCount = params.slackAttemptCount;
  if (params.emailAttemptCount !== undefined) patch.emailAttemptCount = params.emailAttemptCount;
  if (params.lastAutoRetryAt !== undefined) patch.lastAutoRetryAt = params.lastAutoRetryAt;
  if (params.autoRetryGiveupNotifiedAt !== undefined)
    patch.autoRetryGiveupNotifiedAt = params.autoRetryGiveupNotifiedAt;
  if (Object.keys(patch).length === 0) return;
  await getDb()
    .update(agentMatchSettingHistory)
    .set(patch)
    .where(eq(agentMatchSettingHistory.id, params.id));
}

/**
 * Returns recent `agent_match_setting_history` rows whose Slack or email
 * delivery is currently `failed` and that still have remaining auto-retry
 * budget. The auto-retry scheduler iterates these and decides per-row
 * whether the configured backoff has elapsed before re-broadcasting.
 *
 * `withinMs` bounds how far back the scheduler looks so a long-stale
 * change we've already given up on doesn't keep getting scanned forever.
 */
export async function listAgentMatchSettingHistoryForAutoRetry(params: {
  withinMs: number;
  maxAttempts: number;
  limit?: number;
}): Promise<AgentMatchSettingHistory[]> {
  await ensureAgentMatchSettingHistoryResendColumns();
  const cutoff = new Date(Date.now() - params.withinMs);
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  return getDb()
    .select()
    .from(agentMatchSettingHistory)
    .where(
      and(
        gte(agentMatchSettingHistory.changedAt, cutoff),
        or(
          and(
            eq(agentMatchSettingHistory.slackStatus, "failed"),
            lte(agentMatchSettingHistory.slackAttemptCount, params.maxAttempts - 1),
          )!,
          and(
            eq(agentMatchSettingHistory.emailStatus, "failed"),
            lte(agentMatchSettingHistory.emailAttemptCount, params.maxAttempts - 1),
          )!,
        )!,
      ),
    )
    .orderBy(desc(agentMatchSettingHistory.changedAt))
    .limit(limit);
}

export async function getAgentMatchSettingHistoryById(
  id: string,
): Promise<AgentMatchSettingHistory | undefined> {
  await ensureAgentMatchSettingHistoryResendColumns();
  const [row] = await getDb()
    .select()
    .from(agentMatchSettingHistory)
    .where(eq(agentMatchSettingHistory.id, id));
  return row;
}

export async function recordAgentMatchSettingHistory(params: {
  source: string;
  settingKey: string;
  oldValue: number | null;
  newValue: number | null;
  changedBy?: string | null;
}): Promise<AgentMatchSettingHistory> {
  const [row] = await getDb()
    .insert(agentMatchSettingHistory)
    .values({
      source: params.source,
      settingKey: params.settingKey,
      oldValue: params.oldValue,
      newValue: params.newValue,
      changedBy: params.changedBy ?? null,
    })
    .returning();
  return row;
}

export async function listAgentMatchSettingHistory(
  filters?: { source?: string; settingKey?: string; limit?: number },
): Promise<AgentMatchSettingHistory[]> {
  await ensureAgentMatchSettingHistoryResendColumns();
  const limit = filters?.limit ?? 100;
  const conds = [];
  if (filters?.source) conds.push(eq(agentMatchSettingHistory.source, filters.source));
  if (filters?.settingKey) conds.push(eq(agentMatchSettingHistory.settingKey, filters.settingKey));

  const query = getDb()
    .select()
    .from(agentMatchSettingHistory)
    .orderBy(desc(agentMatchSettingHistory.changedAt))
    .limit(limit);

  if (conds.length > 0) {
    return query.where(conds.length === 1 ? conds[0] : and(...conds));
  }
  return query;
}
