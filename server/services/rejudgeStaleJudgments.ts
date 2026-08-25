// @db-pool-intent: worker
//
// Task #4048 — "Re-judge stale client judgments" prod action internals.
//
// The daily-judgment prompt was rewritten (single comm grain, full-window
// representation, no-data-aware report block — FINGERPRINT_REVISION
// "4048.1"), but the leaderboard shows each client's LATEST judgment, and a
// judgment generated under an older prompt keeps its fabricated claims
// ("GBP is at 0 leads") until something regenerates it. Carry-forward makes
// that worse: narratives echo forward through the prior-judgments prompt
// section. This module finds every active client whose latest judgment was
// generated under an older prompt revision and force-regenerates today's
// judgment for each (force=true bypasses the carry-forward fingerprint
// short-circuit), draining one client per chunk on the worker pool.
//
// Convergence: each successful generation writes a judgment whose inventory
// stamps the CURRENT promptRevision, removing that client from the pending
// set. Stale clients with no remaining usable data source can never be
// re-judged (generation would throw JudgmentSkippedError), so they are
// excluded from the pending count and reported separately — the nightly
// cron picks them up automatically if data ever returns.

import { sql } from "drizzle-orm";
import { workerDb as db, runWithWorkerDb, withDbAttribution } from "../db";
import {
  FINGERPRINT_REVISION,
  JudgmentSkippedError,
  assessClientJudgeableTier,
  generateDailyJudgmentDetailed,
} from "./dailyJudgment";
import {
  TIER_GATE_VERSION,
  acceptedEvidenceSeverity,
  type ValidatedEvidenceItem,
} from "./judgmentTierGate";
import {
  FRESH_SLATE_DESTRUCTIVE_CONFIRMATION,
  isAccountHealthStatus,
  isRelationshipRead,
  riskMatchesAccountHealthStatus,
  type AccountHealthStatus,
} from "@shared/clientRating";
import {
  isDrainRunning,
  startBackgroundDrain,
  type DrainChunkResult,
  type StartDrainOutcome,
} from "./prodActionBackgroundDrain";
import { isProdActionDrainLockHeld } from "./crossInstanceLock";

export const REJUDGE_STALE_JUDGMENTS_ACTION_ID = "rejudge_stale_client_judgments";
export { FRESH_SLATE_DESTRUCTIVE_CONFIRMATION };

export interface StaleJudgmentClient {
  clientId: string;
  firmName: string;
  judgmentDate: string;
  promptRevision: string | null;
}

function currentRepairedContractSql() {
  const currentVersion = String(TIER_GATE_VERSION);
  return sql`
    COALESCE(lj.data_sources_summary ->> 'promptRevision', '') = ${FINGERPRINT_REVISION}
    AND COALESCE(lj.data_sources_summary ->> 'tierGateVersion', '') = ${currentVersion}
    AND (
      (
        COALESCE(lj.data_sources_summary #>> '{tierGate,version}', '') = ${currentVersion}
        AND COALESCE(lj.data_sources_summary #>> '{tierGate,judgmentDate}', '') <> ''
        AND COALESCE(lj.data_sources_summary #>> '{tierGate,proposedStatus}', '') IN ('Healthy', 'Watch', 'At Risk', 'Critical')
        AND COALESCE(lj.data_sources_summary #>> '{tierGate,finalStatus}', '') IN ('Healthy', 'Watch', 'At Risk', 'Critical')
        AND (
          COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,proposedRelationshipStatus}'), '') = 'null'
          OR COALESCE(lj.data_sources_summary #>> '{tierGate,proposedRelationshipStatus}', '') IN ('Strong', 'Stable', 'Strained', 'At Risk')
        )
        AND COALESCE(lj.data_sources_summary #>> '{tierGate,finalRelationshipStatus}', '') IN ('Strong', 'Stable', 'Strained', 'At Risk')
        AND COALESCE(lj.data_sources_summary #>> '{tierGate,cap}', '') IN ('Healthy', 'Watch', 'At Risk', 'Critical')
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,overridden}'), '') = 'boolean'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,healthyForced}'), '') = 'boolean'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,proposedOverallRisk}'), '') IN ('null', 'number')
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,finalOverallRisk}'), '') = 'number'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,riskDrivers}'), '') = 'array'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,capReasons}'), '') = 'array'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,silenceExceeded}'), '') = 'boolean'
        AND COALESCE(lj.data_sources_summary #>> '{tierGate,deliveryStability}', '') IN ('stable', 'declining', 'unknown')
        AND COALESCE(lj.data_sources_summary #>> '{tierGate,deliveryStabilitySource}', '') IN ('entered_reports', 'measured_live_data', 'none')
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,evidence}'), '') = 'object'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,evidence,validCount}'), '') = 'number'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,evidence,rejectedCount}'), '') = 'number'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,evidence,reclassifiedCount}'), '') = 'number'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{tierGate,evidence,items}'), '') = 'array'
      )
      OR
      (
        COALESCE(lj.data_sources_summary #>> '{carriedForward,rootDate}', '') <> ''
        AND COALESCE(lj.data_sources_summary #>> '{carriedForward,rootJudgmentId}', '') <> ''
        AND COALESCE(lj.data_sources_summary #>> '{carriedForward,rootTierGate,version}', '') = ${currentVersion}
        AND COALESCE(lj.data_sources_summary #>> '{carriedForward,rootTierGate,judgmentDate}', '') <> ''
        AND COALESCE(lj.data_sources_summary #>> '{carriedForward,rootTierGate,proposedStatus}', '') IN ('Healthy', 'Watch', 'At Risk', 'Critical')
        AND COALESCE(lj.data_sources_summary #>> '{carriedForward,rootTierGate,finalStatus}', '') IN ('Healthy', 'Watch', 'At Risk', 'Critical')
        AND (
          COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,proposedRelationshipStatus}'), '') = 'null'
          OR COALESCE(lj.data_sources_summary #>> '{carriedForward,rootTierGate,proposedRelationshipStatus}', '') IN ('Strong', 'Stable', 'Strained', 'At Risk')
        )
        AND COALESCE(lj.data_sources_summary #>> '{carriedForward,rootTierGate,finalRelationshipStatus}', '') IN ('Strong', 'Stable', 'Strained', 'At Risk')
        AND COALESCE(lj.data_sources_summary #>> '{carriedForward,rootTierGate,cap}', '') IN ('Healthy', 'Watch', 'At Risk', 'Critical')
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,overridden}'), '') = 'boolean'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,healthyForced}'), '') = 'boolean'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,proposedOverallRisk}'), '') IN ('null', 'number')
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,finalOverallRisk}'), '') = 'number'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,riskDrivers}'), '') = 'array'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,capReasons}'), '') = 'array'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,silenceExceeded}'), '') = 'boolean'
        AND COALESCE(lj.data_sources_summary #>> '{carriedForward,rootTierGate,deliveryStability}', '') IN ('stable', 'declining', 'unknown')
        AND COALESCE(lj.data_sources_summary #>> '{carriedForward,rootTierGate,deliveryStabilitySource}', '') IN ('entered_reports', 'measured_live_data', 'none')
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,evidence}'), '') = 'object'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,evidence,validCount}'), '') = 'number'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,evidence,rejectedCount}'), '') = 'number'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,evidence,reclassifiedCount}'), '') = 'number'
        AND COALESCE(jsonb_typeof(lj.data_sources_summary #> '{carriedForward,rootTierGate,evidence,items}'), '') = 'array'
      )
    )
  `;
}

/**
 * Active (non-archived, non-demo) clients whose LATEST judgment row was
 * generated under a prompt revision other than the current one. Clients with
 * no judgment rows at all are NOT stale — there is nothing misleading on the
 * leaderboard for them, and the nightly cron owns first-time generation.
 */
export async function listStaleJudgmentClients(): Promise<StaleJudgmentClient[]> {
  const res = await db.execute(sql`
    SELECT
      c.id AS client_id,
      c.firm_name,
      lj.judgment_date,
       lj.data_sources_summary ->> 'promptRevision' AS prompt_revision
    FROM clients c
    JOIN LATERAL (
      SELECT j.judgment_date, j.data_sources_summary
      FROM client_daily_judgments j
      WHERE j.client_id = c.id
      ORDER BY j.judgment_date DESC
      LIMIT 1
    ) lj ON TRUE
    WHERE (c.is_archived IS NOT TRUE)
      AND (c.is_demo IS NOT TRUE)
      AND NOT (${currentRepairedContractSql()})
    ORDER BY c.firm_name ASC
  `);
  return (res.rows as any[]).map((r) => ({
    clientId: String(r.client_id),
    firmName: String(r.firm_name ?? ""),
    judgmentDate: String(r.judgment_date ?? ""),
    promptRevision: r.prompt_revision == null ? null : String(r.prompt_revision),
  }));
}

export interface RejudgePendingCounts {
  /** Active clients whose latest judgment predates the current prompt revision. */
  stale: number;
  /** Stale clients that still have a usable data source (the pending set). */
  regenerable: number;
  /** Stale clients with NO usable data source — excluded, cron-owned. */
  unjudgeable: number;
}

// Injectable seams so the convergence test can avoid real OpenAI calls and
// the per-generation pacing sleep.
let generateImpl = generateDailyJudgmentDetailed;
let sleepImpl = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function __test_setRejudgeGenerator(fn: typeof generateDailyJudgmentDetailed | null): void {
  generateImpl = fn ?? generateDailyJudgmentDetailed;
}
export function __test_setRejudgeSleep(fn: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = fn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
}

export async function countRejudgePending(): Promise<RejudgePendingCounts> {
  return withDbAttribution("maintenance:prod-actions-rejudge-stale-count", () =>
    runWithWorkerDb(async () => {
      const stale = await listStaleJudgmentClients();
      let regenerable = 0;
      for (const row of stale) {
        if ((await assessClientJudgeableTier(row.clientId)) !== null) regenerable++;
      }
      return {
        stale: stale.length,
        regenerable,
        unjudgeable: stale.length - regenerable,
      };
    }),
  );
}

// ── Task #4812 — re-score progress for the surfaces the CEO actually looks at ──

export interface RejudgeRescoreProgress {
  /**
   * True while a re-judge drain is running anywhere in the cluster: on THIS
   * instance (in-memory drain state) or on another one (the cross-instance
   * advisory lock is held). On autoscale the board request routinely lands
   * on a different instance than the press did, so the lock probe — not
   * local memory — is what makes this honest.
   */
  running: boolean;
  /** Which signal answered `running`: local drain state or the cluster lock. */
  runningSource: "local" | "cross-instance" | null;
  /** The prompt revision fresh judgments are stamped with. */
  currentRevision: string;
  /** Active (non-archived, non-demo) clients with at least one judgment row. */
  totalJudged: number;
  /** Of those, latest judgment already generated under the current revision. */
  fresh: number;
  /** Of those, latest judgment still on an older revision (the re-score gap). */
  stale: number;
  /** ISO time of the newest current-revision generation, null when fresh=0. */
  lastFreshGeneratedAt: string | null;
}

/**
 * One cheap aggregate over the SAME latest-judgment-per-active-client shape
 * as `listStaleJudgmentClients` (fresh + stale must sum to that universe),
 * plus the cluster-wide running signal. No per-client judgeability assess
 * here — this is polled by the churn board while a drain is running, and
 * the fresh/stale split is the progress story the board needs.
 */
export async function getRejudgeRescoreProgress(): Promise<RejudgeRescoreProgress> {
  return withDbAttribution("maintenance:rejudge-rescore-progress", () =>
    runWithWorkerDb(async () => {
      const res = await db.execute(sql`
        SELECT
          COUNT(*)::int AS total_judged,
          COUNT(*) FILTER (
            WHERE ${currentRepairedContractSql()}
          )::int AS fresh,
          MAX(lj.data_sources_summary ->> 'generatedAt') FILTER (
            WHERE ${currentRepairedContractSql()}
          ) AS last_fresh_generated_at
        FROM clients c
        JOIN LATERAL (
          SELECT j.data_sources_summary
          FROM client_daily_judgments j
          WHERE j.client_id = c.id
          ORDER BY j.judgment_date DESC
          LIMIT 1
        ) lj ON TRUE
        WHERE (c.is_archived IS NOT TRUE)
          AND (c.is_demo IS NOT TRUE)
      `);
      const row = (res.rows as any[])[0] ?? {};
      const totalJudged = Number(row.total_judged ?? 0);
      const fresh = Number(row.fresh ?? 0);

      const localRunning = isDrainRunning(REJUDGE_STALE_JUDGMENTS_ACTION_ID);
      const lockHeld = localRunning
        ? true
        : await isProdActionDrainLockHeld(REJUDGE_STALE_JUDGMENTS_ACTION_ID);
      return {
        running: localRunning || lockHeld,
        runningSource: localRunning ? "local" as const : lockHeld ? "cross-instance" as const : null,
        currentRevision: FINGERPRINT_REVISION,
        totalJudged,
        fresh,
        stale: totalJudged - fresh,
        lastFreshGeneratedAt:
          row.last_fresh_generated_at == null ? null : String(row.last_fresh_generated_at),
      };
    }),
  );
}

export type RatingPortfolioViolationCode =
  | "missing_judgment"
  | "revision_mismatch"
  | "contract_incomplete"
  | "stored_status_mismatch"
  | "relationship_mismatch"
  | "stored_risk_mismatch"
  | "risk_outside_status_band"
  | "healthy_with_validated_risk"
  | "critical_without_first_party_evidence"
  | "carry_forward_missing_lineage"
  | "carry_forward_status_mismatch"
  | "carry_forward_risk_mismatch";

export interface RatingPortfolioViolation {
  clientId: string;
  firmName: string;
  judgmentId: string | null;
  judgmentDate: string | null;
  codes: RatingPortfolioViolationCode[];
}

export interface RatingPortfolioVerification {
  checkedAt: string;
  currentRevision: string;
  currentPolicyVersion: number;
  running: boolean;
  runningSource: "local" | "cross-instance" | null;
  activeAccounts: number;
  latestJudgments: number;
  repairedRevisionRows: number;
  statusCounts: Record<AccountHealthStatus, number>;
  violations: RatingPortfolioViolation[];
  passed: boolean;
}

export interface RatingPortfolioRow {
  clientId: string;
  firmName: string;
  judgmentId: string | null;
  judgmentDate: string | null;
  status: unknown;
  relationship: unknown;
  riskScore: unknown;
  dataSourcesSummary: unknown;
  /** Total judgment rows for this active client, including the latest row. */
  judgmentCount?: number;
}

function record(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) {
    return null;
  }
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStrictNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasCurrentTierGateShape(value: unknown): boolean {
  const audit = record(value);
  if (!audit) return false;
  const evidence = record(audit.evidence);
  return (
    audit.version === TIER_GATE_VERSION &&
    isNonEmptyString(audit.judgmentDate) &&
    isAccountHealthStatus(audit.proposedStatus) &&
    isAccountHealthStatus(audit.finalStatus) &&
    (audit.proposedRelationshipStatus === null || isRelationshipRead(audit.proposedRelationshipStatus)) &&
    isRelationshipRead(audit.finalRelationshipStatus) &&
    isAccountHealthStatus(audit.cap) &&
    typeof audit.overridden === "boolean" &&
    typeof audit.healthyForced === "boolean" &&
    (audit.proposedOverallRisk === null || isStrictNumber(audit.proposedOverallRisk)) &&
    isStrictNumber(audit.finalOverallRisk) &&
    Array.isArray(audit.riskDrivers) &&
    Array.isArray(audit.capReasons) &&
    typeof audit.silenceExceeded === "boolean" &&
    ["stable", "declining", "unknown"].includes(audit.deliveryStability) &&
    ["entered_reports", "measured_live_data", "none"].includes(audit.deliveryStabilitySource) &&
    evidence !== null &&
    isStrictNumber(evidence.validCount) &&
    isStrictNumber(evidence.rejectedCount) &&
    isStrictNumber(evidence.reclassifiedCount) &&
    Array.isArray(evidence.items)
  );
}

function hasCurrentRepairedContract(
  inventory: Record<string, any> | null,
  carried: Record<string, any> | null,
): boolean {
  if (
    !inventory ||
    inventory.promptRevision !== FINGERPRINT_REVISION ||
    inventory.tierGateVersion !== TIER_GATE_VERSION
  ) {
    return false;
  }
  if (inventory.carriedForward !== undefined && inventory.carriedForward !== null) {
    return (
      carried !== null &&
      isNonEmptyString(carried.fromDate) &&
      isNonEmptyString(carried.fromJudgmentId) &&
      isNonEmptyString(carried.rootDate) &&
      isNonEmptyString(carried.rootJudgmentId) &&
      hasCurrentTierGateShape(carried.rootTierGate)
    );
  }
  return hasCurrentTierGateShape(inventory.tierGate);
}

/**
 * Pure invariant evaluator for the final portfolio check. It intentionally
 * reports an evidence-driven distribution instead of enforcing quotas.
 */
export function evaluateRatingPortfolioRows(
  rows: readonly RatingPortfolioRow[],
  runningState: Pick<RatingPortfolioVerification, "running" | "runningSource"> = {
    running: false,
    runningSource: null,
  },
): RatingPortfolioVerification {
  const statusCounts: Record<AccountHealthStatus, number> = {
    Healthy: 0,
    Watch: 0,
    "At Risk": 0,
    Critical: 0,
  };
  const violations: RatingPortfolioViolation[] = [];
  let latestJudgments = 0;
  let repairedRevisionRows = 0;

  for (const row of rows) {
    const codes = new Set<RatingPortfolioViolationCode>();
    if (!row.judgmentId || !row.judgmentDate) {
      codes.add("missing_judgment");
    } else {
      latestJudgments++;
    }
    const inventory = record(row.dataSourcesSummary);
    const carried = record(inventory?.carriedForward);
    const audit = record(carried?.rootTierGate ?? inventory?.tierGate);
    const revisionCurrent =
      inventory?.promptRevision === FINGERPRINT_REVISION &&
      inventory?.tierGateVersion === TIER_GATE_VERSION &&
      audit?.version === TIER_GATE_VERSION;
    if (!revisionCurrent) codes.add("revision_mismatch");

    const contractComplete =
      Boolean(row.judgmentId && row.judgmentDate) &&
      hasCurrentRepairedContract(inventory, carried) &&
      isAccountHealthStatus(row.status) &&
      isRelationshipRead(row.relationship) &&
      finiteNumber(row.riskScore) !== null;
    if (!contractComplete) {
      codes.add("contract_incomplete");
    } else {
      repairedRevisionRows++;
    }

    if (isAccountHealthStatus(row.status)) {
      statusCounts[row.status]++;
      const risk = finiteNumber(row.riskScore);
      if (!riskMatchesAccountHealthStatus(risk, row.status)) {
        codes.add("risk_outside_status_band");
      }
      if (audit && audit.finalStatus !== row.status) {
        codes.add("stored_status_mismatch");
      }
      const auditedRisk = finiteNumber(audit?.finalOverallRisk);
      if (audit && (risk === null || auditedRisk === null || risk !== auditedRisk)) {
        codes.add("stored_risk_mismatch");
      }
      const evidence = record(audit?.evidence);
      const acceptedItems = Array.isArray(evidence?.items)
        ? evidence!.items
            .filter((item: unknown) => record(item)?.valid === true)
            .map((item: unknown) => item as ValidatedEvidenceItem)
        : [];
      const auditDate = typeof audit?.judgmentDate === "string"
        ? audit.judgmentDate
        : row.judgmentDate ?? "";
      if (
        row.status === "Healthy" &&
        acceptedItems.some(item => {
          const severity = acceptedEvidenceSeverity(item, auditDate);
          return severity === "at_risk" || severity === "critical";
        })
      ) {
        codes.add("healthy_with_validated_risk");
      }
      if (
        row.status === "Critical" &&
        !acceptedItems.some(item =>
          item.provenance === "client_authored" &&
          acceptedEvidenceSeverity(item, auditDate) === "critical"
        )
      ) {
        codes.add("critical_without_first_party_evidence");
      }
    } else if (row.judgmentId) {
      codes.add("contract_incomplete");
    }

    if (row.judgmentId) {
      if (
        !isRelationshipRead(row.relationship) ||
        !audit ||
        audit.finalRelationshipStatus !== row.relationship
      ) {
        codes.add("relationship_mismatch");
      }
    }

    if (inventory?.carriedForward !== undefined && inventory.carriedForward !== null) {
      const completeLineage =
        typeof carried?.fromDate === "string" &&
        typeof carried?.fromJudgmentId === "string" &&
        typeof carried?.rootDate === "string" &&
        typeof carried?.rootJudgmentId === "string" &&
        record(carried?.rootTierGate) !== null;
      if (!completeLineage) {
        codes.add("carry_forward_missing_lineage");
      } else {
        if (audit?.finalStatus !== row.status) codes.add("carry_forward_status_mismatch");
        const rootRisk = finiteNumber(audit?.finalOverallRisk);
        const storedRisk = finiteNumber(row.riskScore);
        if (rootRisk === null || storedRisk === null || rootRisk !== storedRisk) {
          codes.add("carry_forward_risk_mismatch");
        }
      }
    }

    if (codes.size > 0) {
      violations.push({
        clientId: row.clientId,
        firmName: row.firmName,
        judgmentId: row.judgmentId,
        judgmentDate: row.judgmentDate,
        codes: [...codes],
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    currentRevision: FINGERPRINT_REVISION,
    currentPolicyVersion: TIER_GATE_VERSION,
    running: runningState.running,
    runningSource: runningState.runningSource,
    activeAccounts: rows.length,
    latestJudgments,
    repairedRevisionRows,
    statusCounts,
    violations,
    passed: !runningState.running && violations.length === 0,
  };
}

/**
 * Read-only final convergence check over each active customer account's
 * latest judgment. This never starts a drain, acquires a lock, or writes an
 * audit row; operators can run it after the existing re-judge action settles.
 */
async function loadActiveRatingPortfolioRows(): Promise<RatingPortfolioRow[]> {
  const result = await db.execute(sql`
    SELECT
      c.id AS client_id,
      c.firm_name,
      lj.judgment_id,
      lj.judgment_date,
      lj.status,
      COALESCE(lj.relationship_health, lj.relationship_status) AS relationship,
      lj.risk_score,
      lj.data_sources_summary,
      COALESCE(jc.judgment_count, 0)::int AS judgment_count
    FROM clients c
    LEFT JOIN LATERAL (
      SELECT
        j.id AS judgment_id,
        j.judgment_date,
        j.status,
        j.relationship_health,
        j.relationship_status,
        j.risk_score,
        j.data_sources_summary
      FROM client_daily_judgments j
      WHERE j.client_id = c.id
      ORDER BY j.judgment_date DESC, j.created_at DESC
      LIMIT 1
    ) lj ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS judgment_count
      FROM client_daily_judgments j
      WHERE j.client_id = c.id
    ) jc ON TRUE
    WHERE (c.is_archived IS NOT TRUE)
      AND (c.is_demo IS NOT TRUE)
      AND COALESCE(c.lifecycle_stage, 'customer') = 'customer'
    ORDER BY c.firm_name ASC
  `);
  return (result.rows as any[]).map(row => ({
    clientId: String(row.client_id),
    firmName: String(row.firm_name ?? ""),
    judgmentId: row.judgment_id == null ? null : String(row.judgment_id),
    judgmentDate: row.judgment_date == null ? null : String(row.judgment_date),
    status: row.status,
    relationship: row.relationship,
    riskScore: row.risk_score,
    dataSourcesSummary: row.data_sources_summary,
    judgmentCount: Number(row.judgment_count ?? 0),
  }));
}

async function verifyRepairedRatingPortfolioWithoutRunState(): Promise<RatingPortfolioVerification> {
  return evaluateRatingPortfolioRows(await loadActiveRatingPortfolioRows());
}

export async function verifyRepairedRatingPortfolio(): Promise<RatingPortfolioVerification> {
  return withDbAttribution("maintenance:verify-repaired-rating-portfolio", () =>
    runWithWorkerDb(async () => {
      const rows = await loadActiveRatingPortfolioRows();
      const localRunning = isDrainRunning(REJUDGE_STALE_JUDGMENTS_ACTION_ID);
      const lockHeld = localRunning
        ? true
        : await isProdActionDrainLockHeld(REJUDGE_STALE_JUDGMENTS_ACTION_ID);
      const runningSource = localRunning
        ? "local" as const
        : lockHeld
          ? "cross-instance" as const
          : null;
      return evaluateRatingPortfolioRows(
        rows,
        {
          running: localRunning || lockHeld,
          runningSource,
        },
      );
    }),
  );
}

export interface FreshSlatePortfolioVerification {
  checkedAt: string;
  portfolio: RatingPortfolioVerification;
  historyRows: number;
  supersededRows: number;
  activeAccountsWithExactlyOne: number;
  activeAccountsWithMultiple: number;
  carriedForwardLatestRows: number;
  passed: boolean;
}

function evaluateFreshSlatePortfolioRows(
  rows: readonly RatingPortfolioRow[],
  portfolio = evaluateRatingPortfolioRows(rows),
): FreshSlatePortfolioVerification {
  const historyRows = rows.reduce((sum, row) => sum + (row.judgmentCount ?? 0), 0);
  const supersededRows = rows.reduce(
    (sum, row) => sum + Math.max(0, (row.judgmentCount ?? 0) - 1),
    0,
  );
  const activeAccountsWithExactlyOne = rows.filter(
    row => row.judgmentCount === 1,
  ).length;
  const activeAccountsWithMultiple = rows.filter(
    row => (row.judgmentCount ?? 0) > 1,
  ).length;
  const carriedForwardLatestRows = rows.filter(row => {
    const inventory = record(row.dataSourcesSummary);
    return inventory?.carriedForward != null;
  }).length;
  return {
    checkedAt: new Date().toISOString(),
    portfolio,
    historyRows,
    supersededRows,
    activeAccountsWithExactlyOne,
    activeAccountsWithMultiple,
    carriedForwardLatestRows,
    passed:
      portfolio.passed &&
      activeAccountsWithExactlyOne === portfolio.activeAccounts &&
      historyRows === portfolio.activeAccounts &&
      carriedForwardLatestRows === 0,
  };
}

/**
 * Read-only certification for the destructive operation's final state.
 * Unlike the repaired-contract verifier, this also proves exactly one row per
 * active account and forbids a retained carry-forward that would point at a
 * deleted lineage root.
 */
export async function verifyActiveRatingFreshSlate(): Promise<FreshSlatePortfolioVerification> {
  return withDbAttribution("maintenance:verify-active-rating-fresh-slate", () =>
    runWithWorkerDb(async () => {
      const rows = await loadActiveRatingPortfolioRows();
      const localRunning = isDrainRunning(REJUDGE_STALE_JUDGMENTS_ACTION_ID);
      const lockHeld = localRunning
        ? true
        : await isProdActionDrainLockHeld(REJUDGE_STALE_JUDGMENTS_ACTION_ID);
      const portfolio = evaluateRatingPortfolioRows(rows, {
        running: localRunning || lockHeld,
        runningSource: localRunning
          ? "local"
          : lockHeld
            ? "cross-instance"
            : null,
      });
      return evaluateFreshSlatePortfolioRows(rows, portfolio);
    }),
  );
}

async function listFreshSlateReplacementClients(): Promise<StaleJudgmentClient[]> {
  const rows = await loadActiveRatingPortfolioRows();
  const portfolio = evaluateRatingPortfolioRows(rows);
  const violationClientIds = new Set(
    portfolio.violations
      .filter(violation => violation.judgmentId !== null)
      .map(violation => violation.clientId),
  );
  return rows
    .filter(row => {
      const inventory = record(row.dataSourcesSummary);
      return (
        row.judgmentId !== null &&
        (violationClientIds.has(row.clientId) || inventory?.carriedForward != null)
      );
    })
    .map(row => ({
      clientId: row.clientId,
      firmName: row.firmName,
      judgmentDate: row.judgmentDate ?? "",
      promptRevision:
        record(row.dataSourcesSummary)?.promptRevision == null
          ? null
          : String(record(row.dataSourcesSummary)?.promptRevision),
    }));
}

export type FreshSlateReadiness =
  | {
      state: "settled";
      verification: FreshSlatePortfolioVerification;
      replacementClients: number;
      cleanupClients: number;
    }
  | {
      state: "ready";
      verification: FreshSlatePortfolioVerification;
      replacementClients: number;
      cleanupClients: number;
    }
  | {
      state: "blocked";
      verification: FreshSlatePortfolioVerification;
      replacementClients: number;
      cleanupClients: number;
      detail: string;
    };

async function getFreshSlateReadinessInternal(): Promise<FreshSlateReadiness> {
  const rows = await loadActiveRatingPortfolioRows();
  const portfolio = evaluateRatingPortfolioRows(rows);
  const verification = evaluateFreshSlatePortfolioRows(rows, portfolio);
  const replacements = await listFreshSlateReplacementClients();
  const cleanupClients = rows.filter(row => (row.judgmentCount ?? 0) > 1).length;
  if (verification.passed) {
    return {
      state: "settled",
      verification,
      replacementClients: 0,
      cleanupClients: 0,
    };
  }

  const missing = portfolio.violations.filter(violation =>
    violation.codes.includes("missing_judgment")
  );
  if (missing.length > 0) {
    return {
      state: "blocked",
      verification,
      replacementClients: replacements.length,
      cleanupClients,
      detail:
        `Blocked before deletion: ${missing.length} active client(s) have no rating. ` +
        "Run active client ratings first; no history was removed.",
    };
  }

  const unjudgeable: StaleJudgmentClient[] = [];
  for (const replacement of replacements) {
    if ((await assessClientJudgeableTier(replacement.clientId)) === null) {
      unjudgeable.push(replacement);
    }
  }
  if (unjudgeable.length > 0) {
    return {
      state: "blocked",
      verification,
      replacementClients: replacements.length,
      cleanupClients,
      detail:
        `Blocked before deletion: ${unjudgeable.length} replacement rating(s) ` +
        "cannot be generated from current evidence. No history was removed.",
    };
  }

  return {
    state: "ready",
    verification,
    replacementClients: replacements.length,
    cleanupClients,
  };
}

export async function getFreshSlateReadiness(): Promise<FreshSlateReadiness> {
  return withDbAttribution("maintenance:active-rating-fresh-slate-readiness", () =>
    runWithWorkerDb(getFreshSlateReadinessInternal),
  );
}

interface FreshSlateCleanupResult {
  clientsCleaned: number;
  judgmentsDeleted: number;
  relationshipSignalsDeleted: number;
  savePlayLinksCleared: number;
  concernIntelPreserved: number;
  verification: FreshSlatePortfolioVerification;
}

const FRESH_SLATE_MAX_ACTIVE_CLIENTS = 2_000;
const FRESH_SLATE_MAX_SUPERSEDED_JUDGMENTS = 100_000;

let cleanupLockHook: (() => Promise<void>) | null = null;
export function __test_setFreshSlateCleanupLockHook(
  hook: (() => Promise<void>) | null,
): void {
  cleanupLockHook = hook;
}

/**
 * The irreversible phase is one bounded transaction over the whole active
 * portfolio. Table locks exclude normal client-scope changes and judgment
 * inserts/updates until the exact verified snapshot has been reduced to one
 * row per client. A failure at any point rolls back every deletion.
 */
async function cleanupActiveClientHistoryAtomically(): Promise<FreshSlateCleanupResult> {
  return db.transaction(async tx => {
    // SHARE blocks INSERT/UPDATE/DELETE on the active-client universe;
    // SHARE ROW EXCLUSIVE blocks all concurrent judgment writers while still
    // allowing normal reads. Keep this section DB-only and bounded.
    await tx.execute(sql`LOCK TABLE clients IN SHARE MODE`);
    await tx.execute(sql`
      LOCK TABLE client_daily_judgments IN SHARE ROW EXCLUSIVE MODE
    `);
    await tx.execute(sql`
      LOCK TABLE
        client_relationship_signals,
        client_save_plays,
        client_concern_intel
      IN SHARE ROW EXCLUSIVE MODE
    `);
    if (cleanupLockHook) await cleanupLockHook();

    const portfolioResult = await tx.execute(sql`
      SELECT
        c.id AS client_id,
        c.firm_name,
        lj.judgment_id,
        lj.judgment_date,
        lj.status,
        COALESCE(lj.relationship_health, lj.relationship_status) AS relationship,
        lj.risk_score,
        lj.data_sources_summary,
        COALESCE(jc.judgment_count, 0)::int AS judgment_count
      FROM clients c
      LEFT JOIN LATERAL (
        SELECT
          j.id AS judgment_id,
          j.judgment_date,
          j.status,
          j.relationship_health,
          j.relationship_status,
          j.risk_score,
          j.data_sources_summary
        FROM client_daily_judgments j
        WHERE j.client_id = c.id
        ORDER BY j.judgment_date DESC, j.created_at DESC
        LIMIT 1
      ) lj ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS judgment_count
        FROM client_daily_judgments j
        WHERE j.client_id = c.id
      ) jc ON TRUE
      WHERE (c.is_archived IS NOT TRUE)
        AND (c.is_demo IS NOT TRUE)
        AND COALESCE(c.lifecycle_stage, 'customer') = 'customer'
      ORDER BY c.firm_name ASC
    `);
    const rows: RatingPortfolioRow[] = (portfolioResult.rows as any[]).map(row => ({
      clientId: String(row.client_id),
      firmName: String(row.firm_name ?? ""),
      judgmentId: row.judgment_id == null ? null : String(row.judgment_id),
      judgmentDate: row.judgment_date == null ? null : String(row.judgment_date),
      status: row.status,
      relationship: row.relationship,
      riskScore: row.risk_score,
      dataSourcesSummary: row.data_sources_summary,
      judgmentCount: Number(row.judgment_count ?? 0),
    }));
    const portfolio = evaluateRatingPortfolioRows(rows);
    if (!portfolio.passed) {
      throw new Error(
        `Fresh-slate locked portfolio failed verification for ${portfolio.violations.length} active client(s)`,
      );
    }
    if (rows.some(row => record(row.dataSourcesSummary)?.carriedForward != null)) {
      throw new Error("Fresh-slate locked portfolio contains carried-forward lineage");
    }
    const supersededRows = rows.reduce(
      (sum, row) => sum + Math.max(0, (row.judgmentCount ?? 0) - 1),
      0,
    );
    if (rows.length > FRESH_SLATE_MAX_ACTIVE_CLIENTS) {
      throw new Error(
        `Fresh-slate bound exceeded: ${rows.length} active clients > ${FRESH_SLATE_MAX_ACTIVE_CLIENTS}`,
      );
    }
    if (supersededRows > FRESH_SLATE_MAX_SUPERSEDED_JUDGMENTS) {
      throw new Error(
        `Fresh-slate bound exceeded: ${supersededRows} superseded judgments > ${FRESH_SLATE_MAX_SUPERSEDED_JUDGMENTS}`,
      );
    }

    const dependentCounts = await tx.execute(sql`
      WITH ranked AS (
        SELECT
          j.id,
          ROW_NUMBER() OVER (
            PARTITION BY j.client_id
            ORDER BY j.judgment_date DESC, j.created_at DESC
          ) AS rn
        FROM client_daily_judgments j
        JOIN clients c ON c.id = j.client_id
        WHERE (c.is_archived IS NOT TRUE)
          AND (c.is_demo IS NOT TRUE)
          AND COALESCE(c.lifecycle_stage, 'customer') = 'customer'
      ),
      doomed AS (
        SELECT id FROM ranked WHERE rn > 1
      )
      SELECT
        (
          SELECT COUNT(*)::int
          FROM client_relationship_signals s JOIN doomed d ON d.id = s.judgment_id
        ) AS relationship_signals,
        (
          SELECT COUNT(*)::int
          FROM client_save_plays p JOIN doomed d ON d.id = p.source_judgment_id
        ) AS save_play_links,
        (
          SELECT COUNT(*)::int
          FROM client_concern_intel i JOIN doomed d ON d.id = i.judgment_id
        ) AS concern_intel
    `);
    const dependent = (dependentCounts.rows as any[])[0] ?? {};
    const deleted = await tx.execute(sql`
      WITH ranked AS (
        SELECT
          j.id,
          ROW_NUMBER() OVER (
            PARTITION BY j.client_id
            ORDER BY j.judgment_date DESC, j.created_at DESC
          ) AS rn
        FROM client_daily_judgments j
        JOIN clients c ON c.id = j.client_id
        WHERE (c.is_archived IS NOT TRUE)
          AND (c.is_demo IS NOT TRUE)
          AND COALESCE(c.lifecycle_stage, 'customer') = 'customer'
      )
      DELETE FROM client_daily_judgments j
      USING ranked r
      WHERE j.id = r.id
        AND r.rn > 1
      RETURNING j.id
    `);
    const finalRows = rows.map(row => ({ ...row, judgmentCount: 1 }));
    const finalVerification = evaluateFreshSlatePortfolioRows(
      finalRows,
      evaluateRatingPortfolioRows(finalRows),
    );
    if (!finalVerification.passed || deleted.rows.length !== supersededRows) {
      throw new Error(
        "Fresh-slate locked cleanup did not settle at exactly one verified rating per active client",
      );
    }
    return {
      clientsCleaned: rows.filter(row => (row.judgmentCount ?? 0) > 1).length,
      judgmentsDeleted: deleted.rows.length,
      relationshipSignalsDeleted: Number(dependent.relationship_signals ?? 0),
      savePlayLinksCleared: Number(dependent.save_play_links ?? 0),
      concernIntelPreserved: Number(dependent.concern_intel ?? 0),
      verification: finalVerification,
    };
  });
}

let cleanupImpl = cleanupActiveClientHistoryAtomically;
export function __test_setFreshSlateCleanup(
  fn: typeof cleanupActiveClientHistoryAtomically | null,
): void {
  cleanupImpl = fn ?? cleanupActiveClientHistoryAtomically;
}

function statusDistributionSummary(
  counts: Record<AccountHealthStatus, number>,
): string {
  return `Healthy ${counts.Healthy}, Watch ${counts.Watch}, ` +
    `At Risk ${counts["At Risk"]}, Critical ${counts.Critical}`;
}

export function formatFreshSlateDrainSummary(state: {
  perKey: Record<string, number>;
  chunks: number;
}): string {
  const parts = [
    `regenerated ${state.perKey.regenerated ?? 0} replacement rating(s)`,
    `cleaned ${state.perKey.clients_cleaned ?? 0} active client(s)`,
    `permanently deleted ${state.perKey.judgments_deleted ?? 0} superseded judgment(s)`,
    `cascaded ${state.perKey.relationship_signals_deleted ?? 0} relationship signal(s)`,
    `cleared ${state.perKey.save_play_links_cleared ?? 0} save-play link(s)`,
    `preserved ${state.perKey.concern_intel_preserved ?? 0} concern-intel reference(s)`,
  ];
  if ((state.perKey.portfolio_verified ?? 0) > 0) {
    parts.push(
      `post-run verified ${state.perKey.active_accounts ?? 0} active client(s): ` +
      `Healthy ${state.perKey.status_healthy ?? 0}, ` +
      `Watch ${state.perKey.status_watch ?? 0}, ` +
      `At Risk ${state.perKey.status_at_risk ?? 0}, ` +
      `Critical ${state.perKey.status_critical ?? 0}`,
    );
  }
  return `${parts.join("; ")} across ${state.chunks} chunk(s)`;
}

export type StartFreshSlateOutcome =
  | StartDrainOutcome
  | { state: "blocked"; detail: string };

/**
 * Irreversible fresh-slate operation. Replacement generation always settles
 * first. Cleanup then handles one active client per transaction, re-locking
 * and re-verifying the retained row immediately before deleting older rows.
 */
export async function startActiveRatingFreshSlateDrain(
  actorId: string | null,
): Promise<StartFreshSlateOutcome> {
  const preflight = await getFreshSlateReadiness();
  if (preflight.state === "blocked") {
    return { state: "blocked", detail: preflight.detail };
  }
  if (preflight.state === "settled") {
    return {
      state: "nothing-to-do",
      detail:
        `Fresh slate already settled for ${preflight.verification.portfolio.activeAccounts} active client(s); no history was removed.`,
      totalAtStart: 0,
    };
  }

  const attemptedReplacements = new Set<string>();
  let postRunVerified = false;
  return startBackgroundDrain(
    {
      actionId: REJUDGE_STALE_JUDGMENTS_ACTION_ID,
      actionTitle: "Reset active client rating history",
      attributionLabel: "maintenance:active-rating-fresh-slate",
      unit: "client operation(s)",
      countPending: async () => {
        const rows = await loadActiveRatingPortfolioRows();
        const replacements = await listFreshSlateReplacementClients();
        const cleanupClients = rows.filter(
          row => (row.judgmentCount ?? 0) > 1,
        ).length;
        return replacements.length + cleanupClients;
      },
      runChunk: async (): Promise<DrainChunkResult> => {
        const replacements = await runWithWorkerDb(
          listFreshSlateReplacementClients,
        );
        for (const replacement of replacements) {
          if (attemptedReplacements.has(replacement.clientId)) continue;
          attemptedReplacements.add(replacement.clientId);
          if (
            await runWithWorkerDb(
              () => assessClientJudgeableTier(replacement.clientId),
            ) === null
          ) {
            throw new Error(
              `Fresh-slate replacement for client ${replacement.clientId} became blocked by missing evidence`,
            );
          }
          await generateImpl(replacement.clientId, { force: true });
          await sleepImpl(1000);
          return { processed: 1, perKey: { regenerated: 1 } };
        }
        if (replacements.length > 0) {
          throw new Error(
            `${replacements.length} replacement rating(s) failed to settle; no history was removed`,
          );
        }

        const portfolio = await runWithWorkerDb(
          verifyRepairedRatingPortfolioWithoutRunState,
        );
        if (!portfolio.passed) {
          throw new Error(
            `Replacement portfolio verification failed for ${portfolio.violations.length} active client(s); no further history was removed`,
          );
        }

        if (!postRunVerified) {
          const cleaned = await runWithWorkerDb(cleanupImpl);
          postRunVerified = true;
          return {
            processed: Math.max(1, cleaned.clientsCleaned),
            perKey: {
              clients_cleaned: cleaned.clientsCleaned,
              judgments_deleted: cleaned.judgmentsDeleted,
              relationship_signals_deleted:
                cleaned.relationshipSignalsDeleted,
              save_play_links_cleared: cleaned.savePlayLinksCleared,
              concern_intel_preserved: cleaned.concernIntelPreserved,
              portfolio_verified: 1,
              active_accounts: cleaned.verification.portfolio.activeAccounts,
              status_healthy:
                cleaned.verification.portfolio.statusCounts.Healthy,
              status_watch:
                cleaned.verification.portfolio.statusCounts.Watch,
              status_at_risk:
                cleaned.verification.portfolio.statusCounts["At Risk"],
              status_critical:
                cleaned.verification.portfolio.statusCounts.Critical,
            },
          };
        }
        return { processed: 0, perKey: {} };
      },
      formatSummary: formatFreshSlateDrainSummary,
    },
    actorId,
  );
}

/**
 * Plain-English drain summary. `processed` counts DISPOSITIONS (re-judged +
 * excluded + errored), which can exceed `totalAtStart` (= regenerable-only),
 * so the generic "N / M processed" ratio would read as a bug — render the
 * per-outcome story instead. Used for both live progress and the audit row.
 */
export function formatRejudgeDrainSummary(state: {
  totalAtStart: number;
  perKey: Record<string, number>;
  chunks: number;
}): string {
  const regenerated = state.perKey.regenerated ?? 0;
  const excluded = state.perKey.no_usable_data_left_to_cron ?? 0;
  const errors = state.perKey.errors ?? 0;
  const parts = [
    `re-judged ${regenerated} of ${state.totalAtStart} stale client(s) pending at start`,
  ];
  if (excluded > 0) parts.push(`${excluded} unjudgeable (no usable data sources left — left to cron if data ever appears)`);
  if (errors > 0) parts.push(`${errors} generation error(s) (still pending; re-press to retry)`);
  return `${parts.join("; ")} across ${state.chunks} chunk(s)`;
}

/**
 * One press → one background drain, one fresh AI generation per chunk.
 * Errored clients stay in the pending set (they remain stale), and the
 * per-press attempted-set stops the SAME drain from spinning on a
 * persistently failing client; the self-serve fix is simply that the drain
 * ends and the action reports the residue honestly.
 */
export async function startRejudgeStaleJudgmentsDrain(actorId: string | null): Promise<StartDrainOutcome> {
  const attempted = new Set<string>();
  return startBackgroundDrain(
    {
      actionId: REJUDGE_STALE_JUDGMENTS_ACTION_ID,
      actionTitle: "Re-judge stale client judgments",
      attributionLabel: "maintenance:prod-actions-rejudge-stale-judgments",
      unit: "client(s)",
      countPending: async () => (await countRejudgePending()).regenerable,
      runChunk: async (): Promise<DrainChunkResult> => {
        const perKey: Record<string, number> = {};
        const bump = (k: string) => {
          perKey[k] = (perKey[k] ?? 0) + 1;
        };
        const stale = await runWithWorkerDb(() => listStaleJudgmentClients());
        for (const row of stale) {
          if (attempted.has(row.clientId)) continue;
          attempted.add(row.clientId);
          const tier = await runWithWorkerDb(() => assessClientJudgeableTier(row.clientId));
          if (tier === null) {
            // Excluded from countPending too — scanning past it is not
            // progress against the pending set, so keep looking for a
            // regenerable client within this same chunk.
            bump("no_usable_data_left_to_cron");
            continue;
          }
          try {
            // force=true bypasses the carry-forward fingerprint
            // short-circuit — the entire point is a fresh AI call on the
            // fixed prompt. (Belt and braces anyway: the revision lives in
            // the fingerprint, so a stale row could never carry forward.)
            await generateImpl(row.clientId, { force: true });
            bump("regenerated");
          } catch (err) {
            if (err instanceof JudgmentSkippedError) {
              // Raced to unjudgeable between assess and generate.
              bump("no_usable_data_left_to_cron");
              continue;
            }
            console.error(
              `[rejudge-stale] generation failed for client ${row.clientId} (${row.firmName}):`,
              err,
            );
            bump("errors");
          }
          // Gentle pacing between OpenAI calls (no-op when the chunk found
          // nothing to generate).
          await sleepImpl(1000);
          return { processed: 1, perKey };
        }
        // Scan exhausted without a generation. The drain kit drops the
        // per-key tallies of a `processed: 0` chunk (it breaks before
        // merging), so trailing unjudgeable exclusions recorded here must
        // count as dispositions to survive into the audit row — the NEXT
        // chunk finds nothing new and terminates with a genuinely bare 0.
        const dispositions = Object.values(perKey).reduce((a, b) => a + b, 0);
        return { processed: dispositions, perKey };
      },
      formatSummary: formatRejudgeDrainSummary,
    },
    actorId,
  );
}
