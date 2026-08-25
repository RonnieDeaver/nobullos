// @db-pool-intent: ambient
//
// Task #2367 — RIS QA Layer storage. Thin DB access over the two RIS
// tables. Rollup / applicable-instance computation lives in
// server/services/ris/risService.ts (it needs client products +
// locations); this module only touches ris_checks / ris_check_results.

import { and, eq, inArray, sql, asc, isNull, like, or } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import {
  risChecks,
  risCheckResults,
  risAutoSourceMappings,
  risClientAutoSourceOverrides,
  type RisCheck,
  type InsertRisCheck,
  type UpdateRisCheck,
  type RisCheckResult,
  type InsertRisCheckResult,
  type RisAutoSourceMapping,
  type UpsertRisAutoSourceMapping,
  type UpdateRisAutoSourceMapping,
  updateRisAutoSourceMappingSchema,
  type RisClientAutoSourceOverride,
  type UpsertRisClientAutoSourceOverride,
  type UpdateRisClientAutoSourceOverride,
} from "@shared/schema";

export interface ListRisChecksFilters {
  activeOnly?: boolean;
  layer?: string;
  product?: string;
}

export async function listRisChecks(
  filters: ListRisChecksFilters = {},
): Promise<RisCheck[]> {
  return withDbAttribution("ris:listChecks", async () => {
    const conds = [] as any[];
    if (filters.activeOnly) conds.push(eq(risChecks.active, true));
    if (filters.layer) conds.push(eq(risChecks.layer, filters.layer));
    if (filters.product) conds.push(eq(risChecks.product, filters.product));
    const base = getDb().select().from(risChecks);
    return conds.length
      ? base.where(and(...conds)).orderBy(asc(risChecks.sortOrder), asc(risChecks.label))
      : base.orderBy(asc(risChecks.sortOrder), asc(risChecks.label));
  });
}

export async function getRisCheck(id: string): Promise<RisCheck | undefined> {
  return withDbAttribution("ris:getCheck", async () => {
    const [row] = await getDb().select().from(risChecks).where(eq(risChecks.id, id));
    return row;
  });
}

export async function getRisCheckByKey(
  key: string,
): Promise<RisCheck | undefined> {
  return withDbAttribution("ris:getCheckByKey", async () => {
    const [row] = await getDb().select().from(risChecks).where(eq(risChecks.key, key));
    return row;
  });
}

export async function createRisCheck(data: InsertRisCheck): Promise<RisCheck> {
  return withDbAttribution("ris:createCheck", async () => {
    // New admin-authored checks default to the end of the sort order.
    let sortOrder = data.sortOrder;
    if (sortOrder == null) {
      const [{ max }] = await getDb()
        .select({ max: sql<number>`COALESCE(MAX(${risChecks.sortOrder}), 0)` })
        .from(risChecks);
      sortOrder = Number(max) + 10;
    }
    const [row] = await getDb()
      .insert(risChecks)
      .values({ ...data, sortOrder, isSystem: false })
      .returning();
    return row;
  });
}

export async function updateRisCheck(
  id: string,
  patch: UpdateRisCheck,
): Promise<RisCheck | undefined> {
  return withDbAttribution("ris:updateCheck", async () => {
    const [row] = await getDb()
      .update(risChecks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(risChecks.id, id))
      .returning();
    return row;
  });
}

export async function reorderRisChecks(orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  await withDbAttribution("ris:reorderChecks", async () => {
    await getDb().transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx
          .update(risChecks)
          .set({ sortOrder: (i + 1) * 10, updatedAt: new Date() })
          .where(eq(risChecks.id, orderedIds[i]));
      }
    });
  });
}

// ─── Results ──────────────────────────────────────────────────────────

// Launch-only checks key their period to a scope signature (e.g.
// `launch:<sig>` / `launch:loc:<id>`) so they re-open when the client's
// product mix or locations change. The fetch therefore matches the exact
// month period(s) requested OR any launch-prefixed period — a single
// LIKE keeps the query bounded without enumerating every scope epoch.
const LAUNCH_PERIOD_PATTERN = "launch%";

/** Results for a single client across the month period AND launch periods. */
export async function getRisResultsForClient(
  clientId: string,
  periods: string[],
): Promise<RisCheckResult[]> {
  return withDbAttribution("ris:resultsForClient", async () =>
    getDb()
      .select()
      .from(risCheckResults)
      .where(
        and(
          eq(risCheckResults.clientId, clientId),
          or(
            inArray(risCheckResults.period, periods),
            like(risCheckResults.period, LAUNCH_PERIOD_PATTERN),
          ),
        ),
      ),
  );
}

/** All results for the given periods + launch periods (portfolio rollup). */
export async function getRisResultsForPeriods(
  periods: string[],
): Promise<RisCheckResult[]> {
  if (periods.length === 0) return [];
  return withDbAttribution("ris:resultsForPeriods", async () =>
    getDb()
      .select()
      .from(risCheckResults)
      .where(
        or(
          inArray(risCheckResults.period, periods),
          like(risCheckResults.period, LAUNCH_PERIOD_PATTERN),
        ),
      ),
  );
}

export async function getRisResultById(
  id: string,
): Promise<RisCheckResult | undefined> {
  return withDbAttribution("ris:getResultById", async () => {
    const [row] = await getDb()
      .select()
      .from(risCheckResults)
      .where(eq(risCheckResults.id, id));
    return row;
  });
}

export interface SetRisResultInput
  extends Omit<InsertRisCheckResult, "checkedBy" | "checkedAt"> {}

export interface SetRisResultOutcome {
  result: RisCheckResult;
  previousStatus: string | null;
  created: boolean;
}

/**
 * Find-then-update-else-insert keyed on the logical scope
 * (check, client, COALESCE(location,''), period). We avoid drizzle
 * onConflict here because the uniqueness target is an expression index
 * over a nullable column; manual volume makes the read-then-write race
 * window acceptable, and the unique index is the backstop.
 */
export async function setRisCheckResult(
  input: SetRisResultInput,
  actorId: string | null,
): Promise<SetRisResultOutcome> {
  return withDbAttribution("ris:setResult", async () => {
    const db = getDb();
    const scopeCond = and(
      eq(risCheckResults.checkId, input.checkId),
      eq(risCheckResults.clientId, input.clientId),
      input.locationId
        ? eq(risCheckResults.locationId, input.locationId)
        : isNull(risCheckResults.locationId),
      eq(risCheckResults.period, input.period),
    );
    const [existing] = await db.select().from(risCheckResults).where(scopeCond);

    const now = new Date();
    const source = input.source ?? "manual";
    // A manual write (override) clears the auto bookkeeping so a later
    // auto-pull treats it as human-owned (it skips manual rows anyway) and
    // the dashboard stops showing a stale auto error.
    const clearAuto = source !== "auto";
    if (existing) {
      const [row] = await db
        .update(risCheckResults)
        .set({
          status: input.status,
          observedValue: input.observedValue ?? null,
          // Task #2371 — Performance numeric provenance (NULL for QA rows).
          currentValue: input.currentValue ?? null,
          previousValue: input.previousValue ?? null,
          targetValue: input.targetValue ?? null,
          changePct: input.changePct ?? null,
          notes: input.notes ?? null,
          evidenceUrl: input.evidenceUrl ?? null,
          failureReason: input.failureReason ?? null,
          correctiveAction: input.correctiveAction ?? null,
          severityOverride: input.severityOverride ?? null,
          source,
          ...(clearAuto
            ? { autoError: null, confirmedAt: null, confirmedBy: null }
            : {}),
          checkedBy: actorId,
          checkedAt: now,
          updatedAt: now,
        })
        .where(eq(risCheckResults.id, existing.id))
        .returning();
      return { result: row, previousStatus: existing.status, created: false };
    }

    const [row] = await db
      .insert(risCheckResults)
      .values({
        ...input,
        source: input.source ?? "manual",
        checkedBy: actorId,
        checkedAt: now,
      })
      .returning();
    return { result: row, previousStatus: null, created: true };
  });
}

// ─── Task #2368 — Auto-pull result writer + confirm ───────────────────

export interface SetRisAutoResultInput {
  checkId: string;
  clientId: string;
  locationId: string | null;
  period: string;
  status: string;
  observedValue: string | null;
  autoError: string | null;
  // Task #2371 — Performance numeric provenance. Omitted (undefined) by the
  // QA auto-pull; populated by the Performance pull. Stored as text.
  currentValue?: string | null;
  previousValue?: string | null;
  targetValue?: string | null;
  changePct?: string | null;
}

export type SetRisAutoResultOutcome =
  | { kind: "skipped"; reason: "manual" | "confirmed" }
  | { kind: "written"; result: RisCheckResult; previousStatus: string | null; created: boolean };

/**
 * Write (or refresh) an AUTO result. Unlike the manual path this NEVER
 * overwrites a human-owned row: it skips when an existing row is
 * source='manual' or has been confirmed. The auto write always stamps
 * source='auto', leaves confirmedAt null, and clears checkedBy (system).
 */
export async function setRisAutoResult(
  input: SetRisAutoResultInput,
): Promise<SetRisAutoResultOutcome> {
  return withDbAttribution("ris:setAutoResult", async () => {
    const db = getDb();
    const scopeCond = and(
      eq(risCheckResults.checkId, input.checkId),
      eq(risCheckResults.clientId, input.clientId),
      input.locationId
        ? eq(risCheckResults.locationId, input.locationId)
        : isNull(risCheckResults.locationId),
      eq(risCheckResults.period, input.period),
    );
    const [existing] = await db.select().from(risCheckResults).where(scopeCond);

    if (existing) {
      if (existing.source === "manual") return { kind: "skipped", reason: "manual" };
      if (existing.confirmedAt) return { kind: "skipped", reason: "confirmed" };
    }

    const now = new Date();
    if (existing) {
      const [row] = await db
        .update(risCheckResults)
        .set({
          status: input.status,
          observedValue: input.observedValue,
          // Task #2371 — Performance numeric provenance (undefined for QA auto-pull).
          currentValue: input.currentValue ?? null,
          previousValue: input.previousValue ?? null,
          targetValue: input.targetValue ?? null,
          changePct: input.changePct ?? null,
          autoError: input.autoError,
          source: "auto",
          confirmedAt: null,
          confirmedBy: null,
          checkedBy: null,
          checkedAt: now,
          updatedAt: now,
        })
        .where(eq(risCheckResults.id, existing.id))
        .returning();
      return { kind: "written", result: row, previousStatus: existing.status, created: false };
    }

    const [row] = await db
      .insert(risCheckResults)
      .values({
        checkId: input.checkId,
        clientId: input.clientId,
        locationId: input.locationId,
        period: input.period,
        status: input.status,
        observedValue: input.observedValue,
        // Task #2371 — Performance numeric provenance (undefined for QA auto-pull).
        currentValue: input.currentValue ?? null,
        previousValue: input.previousValue ?? null,
        targetValue: input.targetValue ?? null,
        changePct: input.changePct ?? null,
        autoError: input.autoError,
        source: "auto",
        checkedAt: now,
      })
      .returning();
    return { kind: "written", result: row, previousStatus: null, created: true };
  });
}

/** Stamp an auto result as human-confirmed so the auto-pull stops touching
 *  it. Keeps source='auto' (it is still an auto-sourced value, just
 *  pinned). Returns undefined when the id is unknown. */
export async function confirmRisResult(
  id: string,
  actorId: string | null,
): Promise<RisCheckResult | undefined> {
  return withDbAttribution("ris:confirmResult", async () => {
    const now = new Date();
    const [row] = await getDb()
      .update(risCheckResults)
      .set({ confirmedAt: now, confirmedBy: actorId, updatedAt: now })
      .where(eq(risCheckResults.id, id))
      .returning();
    return row;
  });
}

// ─── Task #2368 — Auto-source mapping registry CRUD ───────────────────

export async function listRisAutoSourceMappings(): Promise<RisAutoSourceMapping[]> {
  return withDbAttribution("ris:listAutoMappings", async () =>
    getDb()
      .select()
      .from(risAutoSourceMappings)
      .orderBy(asc(risAutoSourceMappings.autoSource)),
  );
}

export async function getRisAutoSourceMapping(
  autoSource: string,
): Promise<RisAutoSourceMapping | undefined> {
  return withDbAttribution("ris:getAutoMapping", async () => {
    const [row] = await getDb()
      .select()
      .from(risAutoSourceMappings)
      .where(eq(risAutoSourceMappings.autoSource, autoSource));
    return row;
  });
}

/** Insert-or-update a mapping keyed on its autoSource. Used by the seed
 *  (which never clobbers an operator's edits — see seedRisAutoSourceMappings)
 *  and the admin PATCH endpoint. */
export async function upsertRisAutoSourceMapping(
  data: UpsertRisAutoSourceMapping,
): Promise<RisAutoSourceMapping> {
  return withDbAttribution("ris:upsertAutoMapping", async () => {
    const [row] = await getDb()
      .insert(risAutoSourceMappings)
      .values(data)
      .onConflictDoUpdate({
        target: risAutoSourceMappings.autoSource,
        set: { ...data, updatedAt: new Date() },
      })
      .returning();
    return row;
  });
}

export async function updateRisAutoSourceMapping(
  autoSource: string,
  patch: UpdateRisAutoSourceMapping,
): Promise<RisAutoSourceMapping | undefined> {
  return withDbAttribution("ris:updateAutoMapping", async () => {
    // Task #4200 (F8 follow-up) — latent cat-6 boundary hardened. Runtime
    // parse through the focused update schema (already omits id/autoSource/
    // createdAt/updatedAt) strips unknown keys so a future caller cannot
    // forward a raw request body into the spread. The immutable autoSource
    // key comes only from the first argument; `updatedAt` stays server-stamped.
    const parsed = updateRisAutoSourceMappingSchema.parse(patch);
    const [row] = await getDb()
      .update(risAutoSourceMappings)
      .set({ ...parsed, updatedAt: new Date() })
      .where(eq(risAutoSourceMappings.autoSource, autoSource))
      .returning();
    return row;
  });
}

/** Seed a disabled, blank-SQL mapping row for an autoSource if none exists.
 *  Idempotent and edit-preserving: an existing row (operator-configured) is
 *  left untouched. */
export async function ensureRisAutoSourceMapping(
  data: UpsertRisAutoSourceMapping,
): Promise<void> {
  await withDbAttribution("ris:ensureAutoMapping", async () => {
    await getDb()
      .insert(risAutoSourceMappings)
      .values(data)
      .onConflictDoNothing({ target: risAutoSourceMappings.autoSource });
  });
}

// ─── Task #2485 — Per-client auto-source override CRUD ────────────────
//
// Each override row layers over the global mapping for a single
// (client_id, auto_source) pair. Every override field is nullable and means
// "inherit the global value"; the pulls merge these via resolveRisRule.

/** List overrides, optionally scoped to a single client (the auto-pulls pass
 *  their `clientId` filter through so a single-client refresh only loads that
 *  client's rows). */
export async function listRisClientAutoSourceOverrides(
  clientId?: string,
): Promise<RisClientAutoSourceOverride[]> {
  return withDbAttribution("ris:listClientOverrides", async () => {
    const base = getDb().select().from(risClientAutoSourceOverrides);
    const rows = clientId
      ? await base.where(eq(risClientAutoSourceOverrides.clientId, clientId))
      : await base;
    return rows;
  });
}

/** Insert-or-update an override keyed on (client_id, auto_source). */
export async function upsertRisClientAutoSourceOverride(
  data: UpsertRisClientAutoSourceOverride,
): Promise<RisClientAutoSourceOverride> {
  return withDbAttribution("ris:upsertClientOverride", async () => {
    const [row] = await getDb()
      .insert(risClientAutoSourceOverrides)
      .values(data)
      .onConflictDoUpdate({
        target: [
          risClientAutoSourceOverrides.clientId,
          risClientAutoSourceOverrides.autoSource,
        ],
        set: { ...data, updatedAt: new Date() },
      })
      .returning();
    return row;
  });
}

/** Patch an existing override by (client_id, auto_source). */
export async function updateRisClientAutoSourceOverride(
  clientId: string,
  autoSource: string,
  patch: UpdateRisClientAutoSourceOverride,
): Promise<RisClientAutoSourceOverride | undefined> {
  return withDbAttribution("ris:updateClientOverride", async () => {
    const [row] = await getDb()
      .update(risClientAutoSourceOverrides)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(risClientAutoSourceOverrides.clientId, clientId),
          eq(risClientAutoSourceOverrides.autoSource, autoSource),
        ),
      )
      .returning();
    return row;
  });
}

/** Remove an override (reverting the (client, auto-source) pair to the global
 *  mapping). Idempotent — deleting a non-existent row is a no-op. */
export async function deleteRisClientAutoSourceOverride(
  clientId: string,
  autoSource: string,
): Promise<void> {
  await withDbAttribution("ris:deleteClientOverride", async () => {
    await getDb()
      .delete(risClientAutoSourceOverrides)
      .where(
        and(
          eq(risClientAutoSourceOverrides.clientId, clientId),
          eq(risClientAutoSourceOverrides.autoSource, autoSource),
        ),
      );
  });
}
