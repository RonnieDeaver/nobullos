// @db-pool-intent: ambient
/**
 * Task #4333 — deterministic deal & lead scoring engine (fit + engagement).
 *
 * HubSpot-style manual scoring, no AI:
 *   fitScore        = Σ points of fit rules whose CriteriaSet matches the
 *                     record (shared/criteria.ts — same evaluator as tags &
 *                     segments; extractor reused from tagSegmentEngine so
 *                     registry keys stay in lockstep in ONE place),
 *   engagementScore = Σ points of engagement rules satisfied by captured
 *                     activity: ≥ minCount events of eventType (optionally
 *                     direction-filtered) within the last windowDays days,
 *                     counted from the timeline sources of record
 *                     (Task #4328): email → raw_communication_records
 *                     ('front_email', direct client_id OR non-rejected
 *                     communication_client_links, orphaned excluded — same
 *                     ownership scope as the timeline/Comms tab), sms →
 *                     twilio_messages ⋈ twilio_conversations, call →
 *                     twilio_calls, meeting → scheduled_meetings (HELD
 *                     meetings only: started in the past, status not
 *                     creating/failed/canceled),
 *   score           = clamp(fit + engagement, config.scoreMin, config.scoreMax).
 *
 * Entities link to activity via their client: deal engagement rides
 * deals.client_id (client-less prospect deals score 0 engagement until
 * linked). Entity-generic throughout — "lead" joins scoringEntityTypes when
 * the lead entity lands (Task #4330) by adding its loaders here.
 *
 * Surfaces (mirrors tagSegmentEngine):
 *   - recomputeEntityScoreSafe: on-write bump awaited inline by deal write
 *     routes — never throws (a scoring hiccup must not fail the user's
 *     write; the sweep heals),
 *   - queueClientActivityScoreBump: fire-and-forget hook in the raw-comm
 *     writers (recent activity only, per-client debounced so Front bulk
 *     backfills can't stampede; nightly sweep covers everything skipped),
 *   - recomputeScoresForEntityType: full convergence for one entity type —
 *     run synchronously after config/rule mutations (instant re-rank) and
 *     by the sweep,
 *   - runScoringSweep: the `score_recompute` work-queue job body. Pure
 *     convergence — replays land on identical state (P5: no step chains).
 *
 * Semantics when there is nothing to score:
 *   - config disabled  → scores FREEZE (sweep + bumps skip; UI labels it),
 *   - zero rules       → score rows are CLEARED (no rules ⇒ no scores, not
 *     a wall of zero badges).
 *
 * Pool intent is ambient: routes call this in API-request context; the
 * work-queue handler runs it inside the scheduler's worker-pool context.
 * Every DB touch is lexically inside its own `withDbAttribution` label.
 */
import { asc, eq, gt, sql, type SQL } from "drizzle-orm";
import {
  communicationClientLinks,
  deals,
  dealStages,
  entityScores,
  rawCommunicationRecords,
  scheduledMeetings,
  scoringEntityTypes,
  twilioCalls,
  twilioConversations,
  twilioMessages,
  type CreateScoreRuleBody,
  type EngagementEventType,
  type ScoreBreakdownEntry,
  type ScoreConfig,
  type ScoreRule,
  type ScoringEntityType,
} from "@shared/schema";
import { evaluateCriteriaSet, type CriteriaRecord } from "@shared/criteria";
import { getDb, withDbAttribution } from "../db";
import { dealToCriteriaRecord } from "./tagSegmentEngine";
import { ensureScoreConfig, listScoreRules } from "../storage/scoringStorage";
import { setSystemSetting } from "../storage/settingsStorage";
import { registerModuleStateResetForTest } from "./moduleStateReset";

export const SCORE_RECOMPUTE_QUEUE = "score_recompute";
export const SCORING_SWEEP_STATUS_SETTING = "scoring_sweep_status";

/** Records per keyset page while scanning an entity population. */
const RECORD_BATCH_SIZE = 500;
/** Rows per INSERT … ON CONFLICT DO UPDATE statement. */
const WRITE_CHUNK_SIZE = 500;
/** Activity bumps ignore records older than this — historical backfills
 * (Front full sweeps re-materialize months) ride the nightly sweep. */
const BUMP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Per-client debounce for activity bumps: a webhook burst recomputes once
 * (the recompute reads live DB state, so it sees the whole burst). */
const BUMP_SUPPRESS_MS = 15_000;
/** Deals recomputed per client-activity bump — safety cap, not a page. */
const BUMP_CLIENT_DEAL_LIMIT = 100;

// ── Pure compute ─────────────────────────────────────────────────────────────

export interface ComputedScore {
  score: number;
  fitScore: number;
  engagementScore: number;
  breakdown: ScoreBreakdownEntry[];
}

function eventNoun(type: EngagementEventType, count: number): string {
  switch (type) {
    case "email":
      return count === 1 ? "email" : "emails";
    case "sms":
      return count === 1 ? "SMS message" : "SMS messages";
    case "call":
      return count === 1 ? "call" : "calls";
    case "meeting":
      return count === 1 ? "meeting held" : "meetings held";
  }
}

function engagementDetail(rule: ScoreRule, count: number): string {
  const dir =
    rule.direction && rule.direction !== "any" ? `${rule.direction} ` : "";
  const noun = eventNoun(rule.eventType ?? "email", count);
  const days = rule.windowDays ?? 0;
  return `${count} ${dir}${noun} in the last ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Deterministic score for ONE record. Pure — inputs fully determine the
 * output. `engagementCountByRule` maps rule id → event count for THIS
 * entity's client within the rule's window (0 / absent both mean none).
 */
export function computeScoreForRecord(
  config: Pick<ScoreConfig, "scoreMin" | "scoreMax">,
  rules: ScoreRule[],
  record: CriteriaRecord,
  engagementCountByRule: ReadonlyMap<string, number>,
): ComputedScore {
  let fit = 0;
  let engagement = 0;
  const breakdown: ScoreBreakdownEntry[] = [];
  for (const rule of rules) {
    if (rule.kind === "fit") {
      if (rule.criteria && evaluateCriteriaSet(rule.criteria, record)) {
        fit += rule.points;
        breakdown.push({
          ruleId: rule.id,
          name: rule.name,
          kind: "fit",
          points: rule.points,
          detail: null,
        });
      }
    } else {
      const count = engagementCountByRule.get(rule.id) ?? 0;
      const minCount = rule.minCount ?? 1;
      if (count >= minCount) {
        engagement += rule.points;
        breakdown.push({
          ruleId: rule.id,
          name: rule.name,
          kind: "engagement",
          points: rule.points,
          detail: engagementDetail(rule, count),
        });
      }
    }
  }
  const raw = fit + engagement;
  const score = Math.min(Math.max(raw, config.scoreMin), config.scoreMax);
  return { score, fitScore: fit, engagementScore: engagement, breakdown };
}

// ── Population / record loaders ──────────────────────────────────────────────
// Criteria extraction reuses tagSegmentEngine.dealToCriteriaRecord — the ONE
// place whose keys are asserted against the shared/criteria.ts registry.

interface ScorableRecord {
  id: string;
  clientId: string | null;
  record: CriteriaRecord;
}

const SCORING_DEAL_COLUMNS = {
  id: deals.id,
  name: deals.name,
  amount: deals.amount,
  expectedCloseDate: deals.expectedCloseDate,
  lostReason: deals.lostReason,
  clientId: deals.clientId,
  isArchived: deals.isArchived,
  createdAt: deals.createdAt,
  stageName: dealStages.name,
} as const;

/** Whole deal population, archived included (scores follow the record —
 * archived deals keep a stale-but-explainable score, and the board hides
 * archived rows anyway). */
async function loadDealPopulationForScoring(): Promise<ScorableRecord[]> {
  return withDbAttribution("scoring:load-deals", async () => {
    const db = getDb();
    const out: ScorableRecord[] = [];
    let cursor = "";
    for (;;) {
      const batch = await db
        .select(SCORING_DEAL_COLUMNS)
        .from(deals)
        .leftJoin(dealStages, eq(deals.stageId, dealStages.id))
        .where(gt(deals.id, cursor))
        .orderBy(asc(deals.id))
        .limit(RECORD_BATCH_SIZE);
      for (const row of batch) {
        out.push({
          id: row.id,
          clientId: row.clientId ?? null,
          record: dealToCriteriaRecord(row),
        });
      }
      if (batch.length < RECORD_BATCH_SIZE) return out;
      cursor = batch[batch.length - 1].id;
    }
  });
}

async function loadOneDealForScoring(id: string): Promise<ScorableRecord | null> {
  return withDbAttribution("scoring:load-one-deal", async () => {
    const db = getDb();
    const [row] = await db
      .select(SCORING_DEAL_COLUMNS)
      .from(deals)
      .leftJoin(dealStages, eq(deals.stageId, dealStages.id))
      .where(eq(deals.id, id))
      .limit(1);
    return row
      ? { id: row.id, clientId: row.clientId ?? null, record: dealToCriteriaRecord(row) }
      : null;
  });
}

async function loadPopulation(entityType: ScoringEntityType): Promise<ScorableRecord[]> {
  switch (entityType) {
    case "deal":
      return loadDealPopulationForScoring();
  }
}

async function loadOneRecord(
  entityType: ScoringEntityType,
  entityId: string,
): Promise<ScorableRecord | null> {
  switch (entityType) {
    case "deal":
      return loadOneDealForScoring(entityId);
  }
}

// ── Engagement counting ──────────────────────────────────────────────────────
// One grouped aggregate per rule per sweep (client_id → count), or the same
// query pinned to a single client for the bump path. All windows ride
// existing per-source client/timestamp indexes.

function windowCutoff(rule: ScoreRule, now: Date): Date {
  const days = rule.windowDays ?? 1;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

interface CountRow {
  cid: string;
  n: number;
}

function toCountMap(rows: CountRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.cid, Number(row.n));
  return map;
}

/**
 * Count qualifying activity events per client for one engagement rule.
 * When `clientId` is given the scan is pinned to that client (bump path);
 * otherwise it groups over all clients (sweep path).
 */
async function countEngagement(
  rule: ScoreRule,
  now: Date,
  clientId?: string,
): Promise<Map<string, number>> {
  const cutoff = windowCutoff(rule, now);
  const direction = rule.direction ?? "any";
  switch (rule.eventType) {
    case "email":
      return countEmailEngagement(cutoff, direction, clientId);
    case "sms":
      return countSmsEngagement(cutoff, direction, clientId);
    case "call":
      return countCallEngagement(cutoff, direction, clientId);
    case "meeting":
      return countMeetingEngagement(cutoff, now, clientId);
    default:
      // fit rules never reach here (caller filters by kind)
      return new Map();
  }
}

/**
 * Emails: raw_communication_records 'front_email' rows owned directly
 * (client_id) or via a non-rejected communication_client_links row — the
 * same ownership scope the timeline/Comms tab uses. UNION dedupes a record
 * that is both direct and linked to the same client.
 */
async function countEmailEngagement(
  cutoff: Date,
  direction: string,
  clientId?: string,
): Promise<Map<string, number>> {
  return withDbAttribution("scoring:count-emails", async () => {
    const db = getDb();
    const dirClause: SQL =
      direction === "any"
        ? sql`TRUE`
        : sql`${rawCommunicationRecords.direction} = ${direction}`;
    const directScope: SQL = clientId
      ? sql`${rawCommunicationRecords.clientId} = ${clientId}`
      : sql`${rawCommunicationRecords.clientId} IS NOT NULL`;
    const linkScope: SQL = clientId
      ? sql`${communicationClientLinks.clientId} = ${clientId}`
      : sql`TRUE`;
    const result = await db.execute(sql`
      SELECT cid, COUNT(*)::int AS n FROM (
        SELECT ${rawCommunicationRecords.clientId} AS cid, ${rawCommunicationRecords.id} AS rid
        FROM ${rawCommunicationRecords}
        WHERE ${rawCommunicationRecords.sourceType} = 'front_email'
          AND ${directScope}
          AND (${rawCommunicationRecords.matchStatus} IS NULL OR ${rawCommunicationRecords.matchStatus} <> 'orphaned')
          AND ${rawCommunicationRecords.timestamp} >= ${cutoff}
          AND ${dirClause}
        UNION
        SELECT ${communicationClientLinks.clientId} AS cid, ${rawCommunicationRecords.id} AS rid
        FROM ${rawCommunicationRecords}
        JOIN ${communicationClientLinks}
          ON ${communicationClientLinks.rawCommunicationRecordId} = ${rawCommunicationRecords.id}
        WHERE ${communicationClientLinks.status} <> 'rejected'
          AND ${linkScope}
          AND ${rawCommunicationRecords.sourceType} = 'front_email'
          AND (${rawCommunicationRecords.matchStatus} IS NULL OR ${rawCommunicationRecords.matchStatus} <> 'orphaned')
          AND ${rawCommunicationRecords.timestamp} >= ${cutoff}
          AND ${dirClause}
      ) t GROUP BY cid
    `);
    return toCountMap(result.rows as unknown as CountRow[]);
  });
}

async function countSmsEngagement(
  cutoff: Date,
  direction: string,
  clientId?: string,
): Promise<Map<string, number>> {
  return withDbAttribution("scoring:count-sms", async () => {
    const db = getDb();
    const dirClause: SQL =
      direction === "any" ? sql`TRUE` : sql`${twilioMessages.direction} = ${direction}`;
    const scope: SQL = clientId
      ? sql`${twilioConversations.clientId} = ${clientId}`
      : sql`${twilioConversations.clientId} IS NOT NULL`;
    const result = await db.execute(sql`
      SELECT ${twilioConversations.clientId} AS cid, COUNT(*)::int AS n
      FROM ${twilioMessages}
      JOIN ${twilioConversations}
        ON ${twilioMessages.conversationId} = ${twilioConversations.id}
      WHERE ${scope}
        AND ${twilioMessages.createdAt} IS NOT NULL
        AND ${twilioMessages.createdAt} >= ${cutoff}
        AND ${dirClause}
      GROUP BY ${twilioConversations.clientId}
    `);
    return toCountMap(result.rows as unknown as CountRow[]);
  });
}

async function countCallEngagement(
  cutoff: Date,
  direction: string,
  clientId?: string,
): Promise<Map<string, number>> {
  return withDbAttribution("scoring:count-calls", async () => {
    const db = getDb();
    const dirClause: SQL =
      direction === "any" ? sql`TRUE` : sql`${twilioCalls.direction} = ${direction}`;
    const scope: SQL = clientId
      ? sql`${twilioCalls.clientId} = ${clientId}`
      : sql`${twilioCalls.clientId} IS NOT NULL`;
    const result = await db.execute(sql`
      SELECT ${twilioCalls.clientId} AS cid, COUNT(*)::int AS n
      FROM ${twilioCalls}
      WHERE ${scope}
        AND ${twilioCalls.createdAt} IS NOT NULL
        AND ${twilioCalls.createdAt} >= ${cutoff}
        AND ${dirClause}
      GROUP BY ${twilioCalls.clientId}
    `);
    return toCountMap(result.rows as unknown as CountRow[]);
  });
}

/** Meetings HELD: started within the window, already in the past, and not
 * a transient/failed/canceled booking. Direction never applies. */
async function countMeetingEngagement(
  cutoff: Date,
  now: Date,
  clientId?: string,
): Promise<Map<string, number>> {
  return withDbAttribution("scoring:count-meetings", async () => {
    const db = getDb();
    const scope: SQL = clientId
      ? sql`${scheduledMeetings.clientId} = ${clientId}`
      : sql`${scheduledMeetings.clientId} IS NOT NULL`;
    const result = await db.execute(sql`
      SELECT ${scheduledMeetings.clientId} AS cid, COUNT(*)::int AS n
      FROM ${scheduledMeetings}
      WHERE ${scope}
        AND ${scheduledMeetings.startTimeUtc} >= ${cutoff}
        AND ${scheduledMeetings.startTimeUtc} <= ${now}
        AND ${scheduledMeetings.status} NOT IN ('creating', 'failed', 'canceled')
      GROUP BY ${scheduledMeetings.clientId}
    `);
    return toCountMap(result.rows as unknown as CountRow[]);
  });
}

/** Per-rule counts for ONE entity's client (bump/preview path). */
async function engagementCountsForClient(
  rules: ScoreRule[],
  clientId: string | null,
  now: Date,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const rule of rules) {
    if (rule.kind !== "engagement") continue;
    if (!clientId) {
      counts.set(rule.id, 0);
      continue;
    }
    const byClient = await countEngagement(rule, now, clientId);
    counts.set(rule.id, byClient.get(clientId) ?? 0);
  }
  return counts;
}

// ── entity_scores writes (engine is the sole writer) ────────────────────────

interface ScoreRowToWrite {
  entityType: ScoringEntityType;
  entityId: string;
  computed: ComputedScore;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function upsertScoreRows(rows: ScoreRowToWrite[]): Promise<number> {
  if (rows.length === 0) return 0;
  return withDbAttribution("scoring:upsert-scores", async () => {
    const db = getDb();
    let written = 0;
    for (const batch of chunk(rows, WRITE_CHUNK_SIZE)) {
      const computedAt = new Date();
      const inserted = await db
        .insert(entityScores)
        .values(
          batch.map((r) => ({
            entityType: r.entityType,
            entityId: r.entityId,
            score: r.computed.score,
            fitScore: r.computed.fitScore,
            engagementScore: r.computed.engagementScore,
            breakdown: r.computed.breakdown,
            computedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [entityScores.entityType, entityScores.entityId],
          set: {
            score: sql`excluded.score`,
            fitScore: sql`excluded.fit_score`,
            engagementScore: sql`excluded.engagement_score`,
            breakdown: sql`excluded.breakdown`,
            computedAt: sql`excluded.computed_at`,
          },
        })
        .returning({ id: entityScores.id });
      written += inserted.length;
    }
    return written;
  });
}

async function deleteScoreRow(
  entityType: ScoringEntityType,
  entityId: string,
): Promise<void> {
  await withDbAttribution("scoring:delete-score", async () => {
    const db = getDb();
    await db.execute(sql`
      DELETE FROM ${entityScores}
      WHERE ${entityScores.entityType} = ${entityType}
        AND ${entityScores.entityId} = ${entityId}
    `);
  });
}

/** Remove every score row for an entity type (zero-rules convergence). */
async function clearScoresForEntityType(
  entityType: ScoringEntityType,
): Promise<number> {
  return withDbAttribution("scoring:clear-scores", async () => {
    const db = getDb();
    const result = await db.execute(sql`
      DELETE FROM ${entityScores}
      WHERE ${entityScores.entityType} = ${entityType}
    `);
    return result.rowCount ?? 0;
  });
}

/** Reap score rows whose entity no longer exists (no FK — polymorphic). */
async function reapOrphanScores(entityType: ScoringEntityType): Promise<number> {
  return withDbAttribution("scoring:orphan-reap", async () => {
    const db = getDb();
    switch (entityType) {
      case "deal": {
        const result = await db.execute(sql`
          DELETE FROM ${entityScores}
          WHERE ${entityScores.entityType} = 'deal'
            AND NOT EXISTS (
              SELECT 1 FROM ${deals} WHERE ${deals.id} = ${entityScores.entityId}
            )
        `);
        return result.rowCount ?? 0;
      }
    }
  });
}

// ── Full recompute (config edits, manual trigger, sweep) ────────────────────

export interface EntityTypeRecomputeResult {
  entityType: ScoringEntityType;
  scored: number;
  written: number;
  orphansReaped: number;
  /** Rows deleted because the config has no rules. */
  cleared: number;
  note: string | null;
}

/**
 * Converge every score row for one entity type to the current config.
 * Disabled configs freeze (nothing recomputed); rule-less configs clear.
 * Safe to re-run at any time — pure convergence.
 */
export async function recomputeScoresForEntityType(
  entityType: ScoringEntityType,
): Promise<EntityTypeRecomputeResult> {
  const result: EntityTypeRecomputeResult = {
    entityType,
    scored: 0,
    written: 0,
    orphansReaped: 0,
    cleared: 0,
    note: null,
  };
  const config = await ensureScoreConfig(entityType);
  if (!config.isEnabled) {
    result.note = "disabled — existing scores frozen";
    return result;
  }
  const rules = await listScoreRules(config.id);
  if (rules.length === 0) {
    result.cleared = await clearScoresForEntityType(entityType);
    result.note = "no rules — score rows cleared";
    return result;
  }

  const population = await loadPopulation(entityType);
  const now = new Date();

  // One grouped aggregate per engagement rule (client → count).
  const engagementByRule = new Map<string, Map<string, number>>();
  for (const rule of rules) {
    if (rule.kind !== "engagement") continue;
    engagementByRule.set(rule.id, await countEngagement(rule, now));
  }

  const rows: ScoreRowToWrite[] = population.map(({ id, clientId, record }) => {
    const counts = new Map<string, number>();
    for (const [ruleId, byClient] of engagementByRule) {
      counts.set(ruleId, clientId ? (byClient.get(clientId) ?? 0) : 0);
    }
    return {
      entityType,
      entityId: id,
      computed: computeScoreForRecord(config, rules, record, counts),
    };
  });

  result.scored = rows.length;
  result.written = await upsertScoreRows(rows);
  result.orphansReaped = await reapOrphanScores(entityType);
  return result;
}

// ── On-write bump surfaces ───────────────────────────────────────────────────

/**
 * Recompute ONE entity's score (stage move, deal create/edit). Awaited
 * inline by write routes; never throws — a scoring failure must not fail
 * the user's write (the sweep heals drift).
 */
export async function recomputeEntityScoreSafe(
  entityType: ScoringEntityType,
  entityId: string,
): Promise<void> {
  try {
    const config = await ensureScoreConfig(entityType);
    if (!config.isEnabled) return;
    const rules = await listScoreRules(config.id);
    if (rules.length === 0) {
      await deleteScoreRow(entityType, entityId);
      return;
    }
    const row = await loadOneRecord(entityType, entityId);
    if (!row) {
      // Entity deleted between write and bump — drop any stale score row.
      await deleteScoreRow(entityType, entityId);
      return;
    }
    const counts = await engagementCountsForClient(rules, row.clientId, new Date());
    const computed = computeScoreForRecord(config, rules, row.record, counts);
    await upsertScoreRows([{ entityType, entityId, computed }]);
  } catch (err: any) {
    console.error(
      `[Scoring] on-write recompute failed for ${entityType} ${entityId}:`,
      err?.message ?? err,
    );
  }
}

const lastBumpByClient = new Map<string, number>();
const pendingBumps = new Set<Promise<void>>();

/**
 * Fire-and-forget hook for the raw-communication writers: new captured
 * activity for a client re-scores that client's deals. Recent activity
 * only (historical backfills ride the nightly sweep) and per-client
 * debounced (a burst recomputes once — the recompute reads live DB state,
 * so it sees the whole burst; anything clipped heals nightly).
 */
export function queueClientActivityScoreBump(
  clientId: string,
  activityAt: Date | string | null | undefined,
): void {
  const ts =
    activityAt instanceof Date
      ? activityAt.getTime()
      : activityAt
        ? new Date(activityAt).getTime()
        : Date.now();
  if (!Number.isFinite(ts) || Date.now() - ts > BUMP_MAX_AGE_MS) return;
  const last = lastBumpByClient.get(clientId);
  if (last !== undefined && Date.now() - last < BUMP_SUPPRESS_MS) return;
  lastBumpByClient.set(clientId, Date.now());
  const p = bumpScoresForClientSafe(clientId).finally(() => {
    pendingBumps.delete(p);
  });
  pendingBumps.add(p);
}

/** Recompute every deal attached to a client. Never throws. */
export async function bumpScoresForClientSafe(clientId: string): Promise<void> {
  try {
    const dealRows = await withDbAttribution("scoring:client-deals", async () => {
      const db = getDb();
      return db
        .select({ id: deals.id })
        .from(deals)
        .where(eq(deals.clientId, clientId))
        .limit(BUMP_CLIENT_DEAL_LIMIT);
    });
    for (const d of dealRows) {
      await recomputeEntityScoreSafe("deal", d.id);
    }
  } catch (err: any) {
    console.error(
      `[Scoring] client activity bump failed for ${clientId}:`,
      err?.message ?? err,
    );
  }
}

/** Tests: await queued fire-and-forget bumps before asserting. */
export async function __test_drainPendingScoreBumps(): Promise<void> {
  // The ingest hook (communicationStorage.queueScoreBumpForNewActivity)
  // fires through a dynamic import().then() chain it registers on
  // globalThis.__scoringBumpImportChains (globalThis instead of an import
  // so there is no storage→services static cycle and no module-instance
  // divergence). Await those chains FIRST — queueClientActivityScoreBump
  // runs inside them, so pendingBumps is only populated once they settle —
  // then drain the bump promises themselves.
  const chains = (globalThis as unknown as {
    __scoringBumpImportChains?: Set<Promise<unknown>>;
  }).__scoringBumpImportChains;
  while ((chains !== undefined && chains.size > 0) || pendingBumps.size > 0) {
    if (chains !== undefined && chains.size > 0) {
      await Promise.allSettled([...chains]);
    }
    while (pendingBumps.size > 0) {
      await Promise.allSettled([...pendingBumps]);
    }
    // One macrotask so any follow-on registrations land before we re-check.
    await new Promise((r) => setImmediate(r));
  }
}

// ── Preview (admin config UI) ────────────────────────────────────────────────

export interface ScorePreviewResult {
  found: boolean;
  computed: ComputedScore | null;
  /** Rules the preview evaluated (saved or draft-overlaid). */
  ruleCount: number;
}

/** Draft rules get synthetic ids so breakdown entries stay addressable. */
function draftToRule(
  body: CreateScoreRuleBody,
  configId: string,
  index: number,
): ScoreRule {
  const now = new Date();
  return {
    id: `draft-${index + 1}`,
    configId,
    kind: body.kind,
    name: body.name,
    points: body.points,
    position: index,
    criteria: body.kind === "fit" ? body.criteria : null,
    eventType: body.kind === "engagement" ? body.eventType : null,
    direction: body.kind === "engagement" ? body.direction : null,
    windowDays: body.kind === "engagement" ? body.windowDays : null,
    minCount: body.kind === "engagement" ? body.minCount : null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Score one record without persisting anything — the config UI's sample
 * preview. `draftRules`, when given, replaces the saved rule set entirely
 * (preview-what-you're-about-to-save).
 */
export async function previewScoreForEntity(
  entityType: ScoringEntityType,
  entityId: string,
  draftRules?: CreateScoreRuleBody[],
): Promise<ScorePreviewResult> {
  const config = await ensureScoreConfig(entityType);
  const rules =
    draftRules !== undefined
      ? draftRules.map((body, i) => draftToRule(body, config.id, i))
      : await listScoreRules(config.id);
  const row = await loadOneRecord(entityType, entityId);
  if (!row) return { found: false, computed: null, ruleCount: rules.length };
  const counts = await engagementCountsForClient(rules, row.clientId, new Date());
  return {
    found: true,
    computed: computeScoreForRecord(config, rules, row.record, counts),
    ruleCount: rules.length,
  };
}

// ── Sweep (work-queue job body) ──────────────────────────────────────────────

export interface ScoringSweepSummary {
  startedAt: string;
  durationMs: number;
  recordsScored: number;
  rowsWritten: number;
  orphansReaped: number;
  cleared: number;
  notes: string[];
  errors: string[];
}

/**
 * Recompute every entity type's scores. Pure convergence — a replayed or
 * concurrent sweep lands on identical state (upserts + reaps, no steps).
 */
export async function runScoringSweep(): Promise<ScoringSweepSummary> {
  const startedAtMs = Date.now();
  const summary: ScoringSweepSummary = {
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: 0,
    recordsScored: 0,
    rowsWritten: 0,
    orphansReaped: 0,
    cleared: 0,
    notes: [],
    errors: [],
  };

  for (const entityType of scoringEntityTypes) {
    try {
      const result = await recomputeScoresForEntityType(entityType);
      summary.recordsScored += result.scored;
      summary.rowsWritten += result.written;
      summary.orphansReaped += result.orphansReaped;
      summary.cleared += result.cleared;
      if (result.note) summary.notes.push(`${entityType}: ${result.note}`);
    } catch (err: any) {
      summary.errors.push(`${entityType}: ${err?.message ?? String(err)}`);
    }
  }

  summary.durationMs = Date.now() - startedAtMs;

  // Best-effort status stamp for the admin view; never fails the sweep.
  // updatedBy stays undefined — background writes have no acting user
  // (system_settings.updated_by is a users FK; markers would 23503).
  try {
    await setSystemSetting(
      SCORING_SWEEP_STATUS_SETTING,
      JSON.stringify(summary),
      undefined,
    );
  } catch (err: any) {
    console.warn("[Scoring] failed to record sweep status:", err?.message ?? err);
  }

  return summary;
}

// Between-suite hygiene: the batched test runner sweeps registered resets
// before each suite so debounce timestamps / pending bumps from one suite
// can't leak into the next.
registerModuleStateResetForTest("scoringEngine", () => {
  lastBumpByClient.clear();
  pendingBumps.clear();
});
