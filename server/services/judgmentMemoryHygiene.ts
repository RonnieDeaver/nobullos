// @db-pool-intent: worker
//
// Task #4846 — "Deactivate fabricated zero-metric memory facts" prod action
// internals.
//
// The daily-judgment agent spent months asserting "0 intake / 0 sales"
// narratives for clients who structurally never report those metrics. Each
// judgment's concerns/unresolvedAsks/sentimentSummary were re-persisted as
// agent_knowledge_base facts (source_agent daily_judgment), which re-entered
// the next day's prompt as top-scored "recurring concerns" — a
// self-reinforcing loop (verified in prod 2026-08-17: ~1.5k active poisoned
// rows across ~55 clients; reference client Ashley Andrews Law with 59).
//
// This module deactivates (is_active=false — never deletes) every active
// daily_judgment-sourced fact that asserts a zero/failed-conversion outcome
// for a metric family the client has NEVER entered in any report month.
// Tracked clients' zero claims are kept — for them a zero may be a real
// measurement, so the per-family gate in shouldSuppressFabricatedZeroClaim
// is the false-positive guard (calibrated two-sided on the prod corpus:
// 1,902 suppressed / 248 kept-matched / healthy controls untouched).
//
// Convergence: each drained client's poisoned rows flip to inactive,
// removing them from the pending set. The extraction guard in
// agentKnowledgeService.ts is what makes this durable — the knowledge
// upsert RESURRECTS deactivated rows on exact-text match, so blocking
// re-persistence at the source is the invariant, and this drain is the
// one-shot mop-up of the backlog.

import { sql } from "drizzle-orm";
import { workerDb as db, runWithWorkerDb, withDbAttribution } from "../db";
import { bindArrayParam } from "../utils/sqlArray";
import {
  getClientMetricTracking,
  matchFabricatedZeroClaim,
  shouldSuppressFabricatedZeroClaim,
  type ClientMetricTracking,
} from "./judgmentMetricTracking";
import {
  startBackgroundDrain,
  type DrainChunkResult,
  type StartDrainOutcome,
} from "./prodActionBackgroundDrain";

export const FABRICATED_ZERO_FACTS_ACTION_ID = "deactivate_fabricated_zero_metric_facts";

export interface FabricatedZeroFactCandidate {
  id: string;
  clientId: string;
  factText: string;
}

/**
 * Every active daily_judgment-sourced knowledge fact, portfolio-wide. No
 * textual SQL prefilter: the TS predicate is the single source of truth for
 * what counts as poisoned (a SQL approximation would have to be PROVEN a
 * superset of seven regexes across unicode-dash spellings — cheaper and
 * safer to scan; the corpus is a few thousand short rows).
 */
async function listActiveJudgmentFacts(): Promise<FabricatedZeroFactCandidate[]> {
  const res = await db.execute(sql`
    SELECT id, client_id, fact_text
    FROM agent_knowledge_base
    WHERE source_agent = 'daily_judgment'
      AND is_active = TRUE
  `);
  return (res.rows as any[]).map((r) => ({
    id: String(r.id),
    clientId: String(r.client_id),
    factText: String(r.fact_text ?? ""),
  }));
}

/**
 * The deactivatable set, grouped per client: active daily_judgment facts
 * matching the fabricated-zero predicate where EVERY asserted metric family
 * is never_entered for that client. Metric tracking is fetched once per
 * distinct client (only for clients that have at least one text-matching
 * row) and cached for the duration of the call.
 */
export async function listDeactivatableFactsByClient(): Promise<
  Map<string, FabricatedZeroFactCandidate[]>
> {
  const candidates = await listActiveJudgmentFacts();
  const byClient = new Map<string, FabricatedZeroFactCandidate[]>();
  const trackingCache = new Map<string, ClientMetricTracking>();
  for (const fact of candidates) {
    // Cheap text probe first; the DB tracking read only happens for
    // clients with at least one vocabulary hit.
    if (!matchFabricatedZeroClaim(fact.factText).matched) continue;
    let tracking = trackingCache.get(fact.clientId);
    if (!tracking) {
      tracking = await getClientMetricTracking(fact.clientId);
      trackingCache.set(fact.clientId, tracking);
    }
    if (shouldSuppressFabricatedZeroClaim(fact.factText, tracking)) {
      const list = byClient.get(fact.clientId) ?? [];
      list.push(fact);
      byClient.set(fact.clientId, list);
    }
  }
  return byClient;
}

export interface FabricatedZeroPendingCounts {
  /** Active poisoned rows still to deactivate. */
  facts: number;
  /** Distinct clients those rows belong to. */
  clients: number;
}

export async function countFabricatedZeroFactsPending(): Promise<FabricatedZeroPendingCounts> {
  return withDbAttribution("maintenance:prod-actions-fabricated-zero-facts-count", () =>
    runWithWorkerDb(async () => {
      const byClient = await listDeactivatableFactsByClient();
      let facts = 0;
      for (const list of byClient.values()) facts += list.length;
      return { facts, clients: byClient.size };
    }),
  );
}

/**
 * Plain-English drain summary. `processed` counts deactivated rows (plus
 * raced already-inactive dispositions on the final scan), so the per-outcome
 * story is clearer than the generic ratio. Used for live progress and the
 * audit row.
 */
export function formatFabricatedZeroDrainSummary(state: {
  totalAtStart: number;
  perKey: Record<string, number>;
  chunks: number;
}): string {
  const deactivated = state.perKey.deactivated_facts ?? 0;
  const clients = state.perKey.clients_drained ?? 0;
  const raced = state.perKey.raced_already_inactive ?? 0;
  const parts = [
    `deactivated ${deactivated} of ${state.totalAtStart} poisoned fact(s) pending at start across ${clients} client(s)`,
  ];
  if (raced > 0) parts.push(`${raced} client scan(s) found rows already inactive (raced — nothing rewritten)`);
  return `${parts.join("; ")} across ${state.chunks} chunk(s)`;
}

/**
 * One press → one background drain, one client's poisoned rows per chunk
 * (a single atomic UPDATE … WHERE id = ANY(…) AND is_active = TRUE — the
 * re-check makes a concurrent manual deactivation a no-op, never an error).
 * The per-press attempted-set stops the SAME drain from spinning on a
 * client whose rows keep re-qualifying; anything left pending is reported
 * honestly and a re-press retries it.
 */
export async function startFabricatedZeroFactsDrain(
  actorId: string | null,
): Promise<StartDrainOutcome> {
  const attempted = new Set<string>();
  return startBackgroundDrain(
    {
      actionId: FABRICATED_ZERO_FACTS_ACTION_ID,
      actionTitle: "Deactivate fabricated zero-metric memory facts",
      attributionLabel: "maintenance:prod-actions-fabricated-zero-facts",
      unit: "fact(s)",
      countPending: async () => (await countFabricatedZeroFactsPending()).facts,
      runChunk: async (): Promise<DrainChunkResult> => {
        const perKey: Record<string, number> = {};
        const bump = (k: string, n = 1) => {
          perKey[k] = (perKey[k] ?? 0) + n;
        };
        const byClient = await runWithWorkerDb(() => listDeactivatableFactsByClient());
        for (const [clientId, facts] of byClient) {
          if (attempted.has(clientId)) continue;
          attempted.add(clientId);
          const ids = facts.map((f) => f.id);
          const res = await runWithWorkerDb(() =>
            db.execute(sql`
              UPDATE agent_knowledge_base
              SET is_active = FALSE, updated_at = NOW()
              WHERE id = ANY(${bindArrayParam(ids, "text")})
                AND is_active = TRUE
            `),
          );
          const deactivated = Number((res as any).rowCount ?? 0);
          if (deactivated > 0) {
            bump("deactivated_facts", deactivated);
            bump("clients_drained");
            return { processed: deactivated, perKey };
          }
          // Raced: every selected row went inactive between scan and
          // UPDATE. Not progress against the pending set — keep scanning
          // for a client with live rows within this same chunk.
          bump("raced_already_inactive");
        }
        // Scan exhausted without a deactivation. The drain kit drops the
        // per-key tallies of a `processed: 0` chunk (it breaks before
        // merging), so trailing raced dispositions must count as processed
        // to survive into the audit row — the NEXT chunk finds nothing new
        // and terminates with a genuinely bare 0.
        const dispositions = Object.values(perKey).reduce((a, b) => a + b, 0);
        return { processed: dispositions, perKey };
      },
      formatSummary: formatFabricatedZeroDrainSummary,
    },
    actorId,
  );
}
