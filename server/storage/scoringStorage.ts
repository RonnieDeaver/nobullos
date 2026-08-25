// @db-pool-intent: ambient
//
// Task #4333 — deal & lead scoring: score-config + score-rule persistence.
// Compute/write of entity_scores rows lives in services/scoringEngine.ts
// (the engine is the sole writer of that table); this module owns the
// operator-editable config surface.
//
// The default config row per entity type is LAZILY ensured at read time
// (single-flight + ON CONFLICT DO NOTHING) — the sanctioned prod-seed
// pattern: Publish diffs are structure-only, so migration INSERTs would
// never reach production.

import { asc, eq } from "drizzle-orm";
import {
  defaultScoreConfigSeed,
  scoreConfigs,
  scoreRules,
  type ScoreConfig,
  type ScoreConfigWithRules,
  type ScoreRule,
  type ScoringEntityType,
  type UpdateScoreConfigBody,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";

const ensureInFlight = new Map<string, Promise<ScoreConfig>>();

/**
 * Fetch-or-create the score config row for an entity type. Race-safe:
 * concurrent callers share one in-flight promise per process, and the
 * INSERT is ON CONFLICT DO NOTHING against the entity_type unique index
 * (cross-instance races collapse to one row).
 */
export async function ensureScoreConfig(
  entityType: ScoringEntityType,
): Promise<ScoreConfig> {
  const existing = ensureInFlight.get(entityType);
  if (existing) return existing;
  const p = doEnsureScoreConfig(entityType).finally(() => {
    ensureInFlight.delete(entityType);
  });
  ensureInFlight.set(entityType, p);
  return p;
}

async function doEnsureScoreConfig(
  entityType: ScoringEntityType,
): Promise<ScoreConfig> {
  return withDbAttribution("scoring:ensure-config", async () => {
    const db = getDb();
    const [row] = await db
      .select()
      .from(scoreConfigs)
      .where(eq(scoreConfigs.entityType, entityType))
      .limit(1);
    if (row) return row;
    await db
      .insert(scoreConfigs)
      .values({
        entityType,
        scoreMin: defaultScoreConfigSeed.scoreMin,
        scoreMax: defaultScoreConfigSeed.scoreMax,
        isEnabled: defaultScoreConfigSeed.isEnabled,
      })
      .onConflictDoNothing();
    const [created] = await db
      .select()
      .from(scoreConfigs)
      .where(eq(scoreConfigs.entityType, entityType))
      .limit(1);
    if (!created) {
      throw new Error(`score config ensure failed for entity type ${entityType}`);
    }
    return created;
  });
}

export async function getScoreConfigWithRules(
  entityType: ScoringEntityType,
): Promise<ScoreConfigWithRules> {
  const config = await ensureScoreConfig(entityType);
  const rules = await listScoreRules(config.id);
  return { ...config, rules };
}

export async function updateScoreConfig(
  entityType: ScoringEntityType,
  patch: UpdateScoreConfigBody,
): Promise<ScoreConfig | undefined> {
  return withDbAttribution("scoring:update-config", async () => {
    const [row] = await getDb()
      .update(scoreConfigs)
      .set({ ...patch, updatedAt: new Date() }) // spread-write-approved: patch is zod-parsed updateScoreConfigBodySchema output (range/enabled columns only; no ownership/audit fields in the schema)
      .where(eq(scoreConfigs.entityType, entityType))
      .returning();
    return row;
  });
}

/** Rules in evaluation/display order: position, then age, then id. */
export async function listScoreRules(configId: string): Promise<ScoreRule[]> {
  return withDbAttribution("scoring:list-rules", async () => {
    return getDb()
      .select()
      .from(scoreRules)
      .where(eq(scoreRules.configId, configId))
      .orderBy(asc(scoreRules.position), asc(scoreRules.createdAt), asc(scoreRules.id));
  });
}

export async function getScoreRule(id: string): Promise<ScoreRule | undefined> {
  return withDbAttribution("scoring:get-rule", async () => {
    const [row] = await getDb()
      .select()
      .from(scoreRules)
      .where(eq(scoreRules.id, id))
      .limit(1);
    return row;
  });
}

export async function countScoreRules(configId: string): Promise<number> {
  return withDbAttribution("scoring:count-rules", async () => {
    const rows = await getDb()
      .select({ id: scoreRules.id })
      .from(scoreRules)
      .where(eq(scoreRules.configId, configId));
    return rows.length;
  });
}

/** Values are route-assembled from a zod-parsed body (kind-discriminated). */
export async function createScoreRule(
  values: typeof scoreRules.$inferInsert,
): Promise<ScoreRule> {
  return withDbAttribution("scoring:create-rule", async () => {
    const [row] = await getDb().insert(scoreRules).values(values).returning();
    return row;
  });
}

export async function updateScoreRule(
  id: string,
  patch: Partial<typeof scoreRules.$inferInsert>,
): Promise<ScoreRule | undefined> {
  return withDbAttribution("scoring:update-rule", async () => {
    const [row] = await getDb()
      .update(scoreRules)
      .set({ ...patch, updatedAt: new Date() }) // spread-write-approved: patch is route-assembled from zod-parsed updateScoreRuleBodySchema output, kind-checked against the stored rule; configId/kind are never in it
      .where(eq(scoreRules.id, id))
      .returning();
    return row;
  });
}

export async function deleteScoreRule(id: string): Promise<boolean> {
  return withDbAttribution("scoring:delete-rule", async () => {
    const rows = await getDb()
      .delete(scoreRules)
      .where(eq(scoreRules.id, id))
      .returning({ id: scoreRules.id });
    return rows.length > 0;
  });
}
