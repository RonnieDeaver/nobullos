/**
 * Canonical SEMrush Location Mapping Write Helper (Task #920B).
 *
 * Single entry point for inserting rows into `semrush_location_campaigns` from
 * any import / sync surface (auto-match endpoint, queue-driven apply handler,
 * inventory sync worker). Centralising the lookup → policy → dedup → write flow
 * here keeps the three call sites from diverging on dedup rules, stale-row
 * handling, or policy branching.
 *
 * The helper enforces the import write policy in `importWritePolicy.ts`:
 *  - parent `(clientId, locationId)` configured in `client_locations`
 *      → policy returns `allow_link_existing` → dedup-check + insert
 *  - parent NOT configured (or lookup fails)
 *      → policy returns `allow_review_suggestion` → enqueue suggestion
 *  - any blocked decision (`drop_unknown` / `flag_warning` / `reject_write`)
 *      → returns `blocked` outcome; caller decides how to log
 *
 * Stale rows are NEVER auto-revived: if the only row for the
 * `(clientId, locationId, semrushCampaignId)` triple is `isStale=true`, the
 * helper returns `stale_conflict` and does not write. Callers that want to
 * surface a "stale-only" UI signal can branch on this outcome.
 *
 * Idempotency: dedup is performed on the `(clientId, locationId,
 * semrushCampaignId)` triple inside a transaction so concurrent callers cannot
 * insert duplicates. Callers already in a transaction can pass their `tx`
 * handle via the optional `opts.tx` parameter; otherwise the helper opens its
 * own transaction.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  clientLocations,
  importEntitySuggestions,
  semrushLocationCampaigns,
  type ImportEntitySuggestion,
  type SemrushLocationCampaign,
} from "@shared/schema";
import {
  evaluateImportWrite,
  type ImportSurface,
  type ImportWriteOutcome,
} from "./importWritePolicy";
import { storage } from "../storage";

/** Surface that produced the candidate mapping. */
export type SemrushMappingSurface = Extract<
  ImportSurface,
  "semrush_inventory" | "local_dominance_sync"
>;

/** Structured input for {@link applySemrushLocationMapping}. */
export interface MappingWriteInput {
  clientId: string;
  locationId: string;
  semrushCampaignId: string;
  semrushCampaignName?: string | null;
  source: {
    surface: SemrushMappingSurface;
    /** Free-form provenance forwarded to `import_entity_suggestions.sourceRef`. */
    sourceRef?: Record<string, unknown> | null;
    /** Optional candidate metadata mirrored into the suggestion payload. */
    matchType?: string | null;
  };
}

/**
 * Outcome variants returned by {@link applySemrushLocationMapping}.
 *
 * - `saved`             — a new mapping row was inserted (returns `row`)
 * - `already_mapped`    — a non-stale row with the same triple already
 *                         exists; no write performed (returns `row`)
 * - `queued_for_review` — the candidate was routed to the review queue;
 *                         a suggestion row was created (returns
 *                         `suggestionId`)
 * - `stale_conflict`    — the only row for the triple is `isStale=true`;
 *                         the helper does NOT auto-revive stale rows, so
 *                         no write was performed (returns the stale `row`
 *                         for caller-side observability)
 * - `invalid_parent`    — `(clientId, locationId)` was not found in
 *                         `client_locations`; behaviourally identical to
 *                         `queued_for_review` but distinguishable for
 *                         callers that want to log it differently
 *                         (returns `suggestionId`)
 * - `blocked`           — the policy returned a blocked decision
 *                         (`drop_unknown` / `flag_warning` /
 *                         `reject_write`); no write performed
 */
export type MappingWriteOutcome =
  | { kind: "saved"; row: SemrushLocationCampaign }
  | { kind: "already_mapped"; row: SemrushLocationCampaign }
  | { kind: "queued_for_review"; suggestionId: string }
  | { kind: "stale_conflict"; row: SemrushLocationCampaign }
  | { kind: "invalid_parent"; suggestionId: string }
  | {
      kind: "blocked";
      decision: string;
      reason: string;
    };

/** Drizzle transaction handle (loosely typed to avoid generic plumbing). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ApplySemrushLocationMappingOpts {
  /**
   * Optional Drizzle transaction handle. When provided, the helper performs
   * the dedup-check + insert inside the caller's transaction instead of
   * opening its own.
   */
  tx?: Tx;
  /**
   * Test seam: inject a synthetic policy outcome instead of consulting
   * `evaluateImportWrite`. This lets regression tests exercise helper
   * branches that the current production policy table would never reach
   * (e.g. `queued_for_review` requires `entityExists=true` paired with
   * `allow_review_suggestion`, which the policy currently does not emit).
   *
   * NOT for production use — surface name is underscore-prefixed and
   * documented as test-only. MUST NEVER be plumbed from request bodies,
   * queue payloads, worker inputs, or any external/runtime source — only
   * inline test scaffolding may set this field.
   */
  _policyOverride?: ImportWriteOutcome;
}

/**
 * Apply one SEMrush location-mapping candidate. See module-level docs for the
 * full lookup → policy → write flow.
 *
 * Callers are responsible for any UI signalling beyond the returned outcome —
 * e.g. surfacing `stale_conflict` as a "stale only" badge, or aggregating
 * `queued_for_review` outcomes into an operator-visible drop summary.
 */
export async function applySemrushLocationMapping(
  input: MappingWriteInput,
  opts: ApplySemrushLocationMappingOpts = {},
): Promise<MappingWriteOutcome> {
  const {
    clientId,
    locationId,
    semrushCampaignId,
    semrushCampaignName,
    source,
  } = input;

  const candidateLabel = `client=${clientId} location=${locationId} campaign=${semrushCampaignId}`;

  // 1. Look up the parent client_locations row to determine entityExists.
  //    A missing row is reported as `invalid_parent` after the helper still
  //    routes the candidate through the review queue.
  const dbHandle = opts.tx ?? db;
  const [parent] = await dbHandle
    .select({ id: clientLocations.id, clientId: clientLocations.clientId })
    .from(clientLocations)
    .where(
      and(
        eq(clientLocations.id, locationId),
        eq(clientLocations.clientId, clientId),
      ),
    )
    .limit(1);

  const entityExists = !!parent;

  // 2. Ask the policy what to do with this candidate (or honour the
  //    test-only override so regression tests can drive otherwise-
  //    unreachable branches).
  const decision = opts._policyOverride ?? evaluateImportWrite(
    source.surface,
    "location_mapping",
    "create",
    { entityExists, candidateLabel },
  );

  if (decision.blocked) {
    logOutcome("blocked", input, { decision: decision.decision });
    return {
      kind: "blocked",
      decision: decision.decision,
      reason: decision.reason,
    };
  }

  // 3a. Configured parent → link existing entities (dedup + insert).
  //     The literal compare is widened to `string` because 920A introduces
  //     `allow_link_existing` into the policy union; this helper is written
  //     to consume that decision the moment 920A lands without any further
  //     edits here.
  if ((decision.decision as string) === "allow_link_existing") {
    const result = await runWithTx(opts.tx, async (tx) =>
      dedupAndInsert(tx, input),
    );
    logOutcome(result.kind, input, {});
    return result;
  }

  // 3b. Unconfigured parent (or any other allow-suggestion path) → enqueue
  //     a suggestion. We treat a missing parent specially so callers can
  //     differentiate a genuinely unknown location from one that simply
  //     hasn't been linked yet. Re-running the helper for the same
  //     (clientId, locationId, semrushCampaignId) triple while a pending
  //     suggestion already exists returns the existing suggestion id
  //     instead of stacking duplicates.
  if (decision.decision === "allow_review_suggestion") {
    const suggestion = await findOrCreateSuggestion(input, decision.reason, entityExists, opts.tx);
    const kind: "queued_for_review" | "invalid_parent" = entityExists
      ? "queued_for_review"
      : "invalid_parent";
    logOutcome(kind, input, { suggestionId: suggestion.id });
    return { kind, suggestionId: suggestion.id };
  }

  // Defensive: any other non-blocked decision is unexpected for this entity
  // kind. Surface it as `blocked` rather than silently writing.
  logOutcome("blocked", input, { decision: decision.decision, unexpected: true });
  return {
    kind: "blocked",
    decision: decision.decision,
    reason: `unexpected non-blocked decision '${decision.decision}' for location_mapping create`,
  };
}

async function dedupAndInsert(
  tx: Tx,
  input: MappingWriteInput,
): Promise<MappingWriteOutcome> {
  const { clientId, locationId, semrushCampaignId, semrushCampaignName } = input;

  // Race-safe idempotent insert: rely on the unique index over the
  // (clientId, locationId, semrushCampaignId) triple and ON CONFLICT DO
  // NOTHING. Two concurrent callers will both attempt the insert, but only
  // one row materialises; the loser sees a 0-row `returning()` result and
  // re-selects the existing row to classify the outcome (already_mapped vs
  // stale_conflict). No exceptions are surfaced to the caller for the
  // duplicate case.
  const inserted = await tx
    .insert(semrushLocationCampaigns)
    .values({
      clientId,
      locationId,
      semrushCampaignId,
      semrushCampaignName: semrushCampaignName ?? null,
      isStale: false,
      staleSince: null,
    })
    .onConflictDoNothing({
      target: [
        semrushLocationCampaigns.clientId,
        semrushLocationCampaigns.locationId,
        semrushLocationCampaigns.semrushCampaignId,
      ],
    })
    .returning();

  if (inserted.length > 0) {
    return { kind: "saved", row: inserted[0] };
  }

  // Conflict path: a row already exists for the triple. Re-select to
  // classify it. Stale rows are NEVER auto-revived — return
  // `stale_conflict` if the only row is stale.
  const existingRows = await tx
    .select()
    .from(semrushLocationCampaigns)
    .where(
      and(
        eq(semrushLocationCampaigns.clientId, clientId),
        eq(semrushLocationCampaigns.locationId, locationId),
        eq(semrushLocationCampaigns.semrushCampaignId, semrushCampaignId),
      ),
    );

  const liveRow = existingRows.find((r) => !r.isStale);
  if (liveRow) {
    return { kind: "already_mapped", row: liveRow };
  }
  return { kind: "stale_conflict", row: existingRows[0] };
}

async function findOrCreateSuggestion(
  input: MappingWriteInput,
  reason: string,
  isConfigured: boolean,
  tx?: Tx,
): Promise<ImportEntitySuggestion> {
  // Idempotency: if a pending suggestion for the same (clientId, locationId,
  // semrushCampaignId, location_mapping) triple already exists, reuse it
  // instead of stacking duplicates. The candidate JSONB column carries the
  // locationId + semrushCampaignId, so we filter on those keys via SQL JSONB
  // operators. Only `pending` suggestions are matched — promoted/rejected
  // rows are historical and a fresh suggestion should be created.
  const dbHandle = tx ?? db;
  const existing = await dbHandle
    .select()
    .from(importEntitySuggestions)
    .where(
      and(
        eq(importEntitySuggestions.clientId, input.clientId),
        eq(importEntitySuggestions.entityKind, "location_mapping"),
        eq(importEntitySuggestions.status, "pending"),
        sql`${importEntitySuggestions.candidate}->>'locationId' = ${input.locationId}`,
        sql`${importEntitySuggestions.candidate}->>'semrushCampaignId' = ${input.semrushCampaignId}`,
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const candidate: Record<string, unknown> = {
    locationId: input.locationId,
    semrushCampaignId: input.semrushCampaignId,
    semrushCampaignName: input.semrushCampaignName ?? null,
    isConfigured,
  };
  if (input.source.matchType) candidate.matchType = input.source.matchType;

  const values = {
    clientId: input.clientId,
    entityKind: "location_mapping",
    surface: input.source.surface,
    candidate,
    sourceRef: input.source.sourceRef ?? null,
    reason,
  };

  // Honour the caller's transaction when supplied so suggestion writes
  // share the same atomic boundary as the rest of the helper's work.
  // Otherwise route through the storage facade so existing tooling /
  // observability around `createImportEntitySuggestion` keeps working.
  if (tx) {
    const [row] = await tx.insert(importEntitySuggestions).values(values).returning();
    return row;
  }
  return storage.createImportEntitySuggestion(values);
}

async function runWithTx<T>(
  tx: Tx | undefined,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (tx) return fn(tx);
  return db.transaction(fn);
}

/**
 * One auto-match candidate that needs to be persisted by the helper.
 * Mirrors the shape produced by the heatmap auto-match endpoint.
 */
export interface AutoMatchCandidate {
  locationId: string;
  campaignId: string;
  campaignName: string;
  matchType: "proximity" | "name" | "location";
}

/**
 * Aggregated outcome from running a batch of auto-match candidates through
 * {@link applySemrushLocationMapping}. Pinned by regression tests so the
 * heatmap auto-match route's response counters cannot drift away from the
 * helper's outcome variants.
 */
export interface AutoMatchAggregate {
  savedCount: number;
  alreadyMappedCount: number;
  queuedForReviewCount: number;
  staleConflictCount: number;
  droppedWarnings: Array<{ locationId: string; campaignId: string; reason: string }>;
  queuedSuggestions: Array<{ locationId: string; campaignId: string; reason: string }>;
}

/**
 * Drive a batch of auto-match candidates through the canonical write helper
 * and aggregate the per-outcome counters. Extracted from the heatmap
 * `auto-match` route handler so the count aggregation is regression-testable
 * independently of the HTTP plumbing.
 */
export async function applyAutoMatchCandidates(
  clientId: string,
  matched: readonly AutoMatchCandidate[],
  opts: ApplySemrushLocationMappingOpts = {},
): Promise<AutoMatchAggregate> {
  const agg: AutoMatchAggregate = {
    savedCount: 0,
    alreadyMappedCount: 0,
    queuedForReviewCount: 0,
    staleConflictCount: 0,
    droppedWarnings: [],
    queuedSuggestions: [],
  };
  for (const m of matched) {
    try {
      const outcome = await applySemrushLocationMapping(
        {
          clientId,
          locationId: m.locationId,
          semrushCampaignId: m.campaignId,
          semrushCampaignName: m.campaignName,
          source: {
            surface: "semrush_inventory",
            sourceRef: { route: "heatmap.auto-match", matchType: m.matchType },
            matchType: m.matchType,
          },
        },
        opts,
      );
      switch (outcome.kind) {
        case "saved":
          agg.savedCount++;
          break;
        case "already_mapped":
          agg.alreadyMappedCount++;
          break;
        case "queued_for_review":
          agg.queuedForReviewCount++;
          agg.queuedSuggestions.push({ locationId: m.locationId, campaignId: m.campaignId, reason: "queued_for_review" });
          break;
        case "invalid_parent":
          agg.queuedForReviewCount++;
          agg.droppedWarnings.push({ locationId: m.locationId, campaignId: m.campaignId, reason: "unconfigured_location" });
          break;
        case "stale_conflict":
          agg.staleConflictCount++;
          agg.droppedWarnings.push({ locationId: m.locationId, campaignId: m.campaignId, reason: "stale_conflict" });
          break;
        case "blocked":
          agg.droppedWarnings.push({ locationId: m.locationId, campaignId: m.campaignId, reason: outcome.reason });
          break;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : "helper_error";
      console.error(`[AutoMatch] Helper failed for location=${m.locationId} campaign=${m.campaignId}:`, err);
      agg.droppedWarnings.push({ locationId: m.locationId, campaignId: m.campaignId, reason });
    }
  }
  return agg;
}

function logOutcome(
  kind: MappingWriteOutcome["kind"],
  input: MappingWriteInput,
  extra: Record<string, unknown>,
) {
  const tail = Object.entries(extra)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(
    `[SemrushMappingWriter] outcome=${kind} client=${input.clientId} location=${input.locationId} campaign=${input.semrushCampaignId} source=${input.source.surface}${tail ? ` ${tail}` : ""}`,
  );
}
