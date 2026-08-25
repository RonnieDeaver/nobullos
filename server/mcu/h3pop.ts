// @db-pool-intent: ambient
//
// H3 population helpers are called from both API request handlers
// (radius computations triggered by /api/mcu/*) and from the MCU
// background worker (seedH3Population during startup, getPopulationInCells
// inside runComputation). Route through `getDb()` so the pool tenant
// matches whatever AsyncLocalStorage context the caller installed.
// See `server/mcu/worker.ts` for the wrap sites.
import { getDb, withDbAttribution } from "../db";
import { h3Population, censusTracts } from "@shared/schema";
import * as h3 from "h3-js";
import { sql } from "drizzle-orm";

let memoryCache: Map<string, number> | null = null;
let memoryCacheLoading: Promise<Map<string, number>> | null = null;

async function loadMemoryCache(): Promise<Map<string, number>> {
  if (memoryCache) return memoryCache;
  if (memoryCacheLoading) return memoryCacheLoading;

  memoryCacheLoading = (async () => {
    try {
      console.log("[H3Pop] Loading h3_population into memory cache...");
      const start = Date.now();
      const rows = await withDbAttribution("mcu_h3pop:load_memory_cache", () =>
        getDb().select({
          h3Index: h3Population.h3Index,
          population: h3Population.population,
        }).from(h3Population),
      );

      const cache = new Map<string, number>();
      for (const r of rows) {
        cache.set(r.h3Index, r.population);
      }
      console.log(`[H3Pop] Memory cache loaded: ${cache.size} cells in ${Date.now() - start}ms`);
      memoryCache = cache;
      memoryCacheLoading = null;
      return cache;
    } catch (err) {
      memoryCacheLoading = null;
      console.error("[H3Pop] Failed to load memory cache:", err);
      throw err;
    }
  })();

  return memoryCacheLoading;
}

export function invalidateH3Cache(): void {
  memoryCache = null;
  memoryCacheLoading = null;
}

export async function seedH3Population(): Promise<number> {
  console.log("[H3Pop] Reading census tracts...");
  const tracts = await withDbAttribution("mcu_h3pop:seed_read_tracts", () =>
    getDb().select({
      geoid: censusTracts.geoid,
      population: censusTracts.population,
      centroidLat: censusTracts.centroidLat,
      centroidLng: censusTracts.centroidLng,
    }).from(censusTracts),
  );

  console.log(`[H3Pop] Processing ${tracts.length} tracts...`);

  const cellPop = new Map<string, number>();

  for (let i = 0; i < tracts.length; i++) {
    const t = tracts[i];
    if (t.centroidLat == null || t.centroidLng == null) continue;
    const cell = h3.latLngToCell(t.centroidLat, t.centroidLng, 8);
    cellPop.set(cell, (cellPop.get(cell) || 0) + t.population);

    if ((i + 1) % 10000 === 0) {
      console.log(`[H3Pop] Processed ${i + 1} / ${tracts.length} tracts...`);
    }
  }

  console.log(`[H3Pop] Aggregated into ${cellPop.size} H3 cells. Inserting...`);

  const entries = Array.from(cellPop.entries());
  const BATCH_SIZE = 1000;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE).map(([idx, pop]) => ({
      h3Index: idx,
      population: pop,
    }));

    await withDbAttribution("mcu_h3pop:seed_insert_batch", () =>
      getDb().insert(h3Population).values(batch).onConflictDoUpdate({
        target: h3Population.h3Index,
        set: { population: sql`${h3Population.population} + excluded.population` },
      }),
    );
  }

  console.log(`[H3Pop] Seeding complete: ${cellPop.size} cells created.`);
  invalidateH3Cache();
  return cellPop.size;
}

export async function getPopulationWithinRadius(
  lat: number,
  lng: number,
  radiusMiles: number,
): Promise<number> {
  const { totalPop } = await getPopulationWithinRadiusDetailed(lat, lng, radiusMiles);
  return totalPop;
}

export async function getPopulationWithinRadiusDetailed(
  lat: number,
  lng: number,
  radiusMiles: number,
): Promise<{ totalPop: number; cellsWithPop: number }> {
  const cache = await loadMemoryCache();
  const radiusKm = radiusMiles * 1.60934;
  const centerCell = h3.latLngToCell(lat, lng, 8);
  const k = Math.ceil(radiusKm / 0.461);
  const cells = h3.gridDisk(centerCell, k);

  let totalPop = 0;
  let cellsWithPop = 0;
  for (const c of cells) {
    const pop = cache.get(c) || 0;
    totalPop += pop;
    if (pop > 0) cellsWithPop++;
  }

  return { totalPop, cellsWithPop };
}

export async function getPopulationInCells(
  cells: string[],
): Promise<Map<string, number>> {
  const cache = await loadMemoryCache();
  const result = new Map<string, number>();

  for (const c of cells) {
    const pop = cache.get(c);
    if (pop !== undefined) {
      result.set(c, pop);
    }
  }

  return result;
}

export async function isH3PopulationSeeded(): Promise<boolean> {
  return withDbAttribution("mcu_h3pop:is_seeded", async () => {
    const rows = await getDb()
      .select({ h3Index: h3Population.h3Index })
      .from(h3Population)
      .limit(1);
    return rows.length > 0;
  });
}
