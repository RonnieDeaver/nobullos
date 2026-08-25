// @db-pool-intent: ambient
//
// MCU cache helpers are called from both API request handlers (e.g.
// `/api/mcu/cache/clear`) AND from background MCU compute / hydration
// paths (startMcuWorker → loadFromDbCache, runComputation → setCache).
// We deliberately route through `getDb()` so the pool tenant matches
// whichever AsyncLocalStorage context the caller installed:
//   • Request handlers run without `runWithWorkerDb(...)` → api pool.
//   • The MCU worker wraps its entry points in `runWithWorkerDb(...)`
//     so these helpers land on the worker pool.
// Each public function wraps its own DB work in `withDbAttribution()`
// so the slow-query dashboard can identify the cache surface even when
// the caller did not establish its own attribution scope.
// See `server/mcu/worker.ts` for the wrap sites.
import { getDb, dbRetry, withDbAttribution } from "../db";
import { mcuCache } from "@shared/schema";
import { eq, and, gt, lt } from "drizzle-orm";

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const TEN_YEARS = 10 * 365 * 24 * 60 * 60 * 1000;

const CACHE_TTLS: Record<string, number> = {
  geocode: TEN_YEARS,
  fips: TEN_YEARS,
  census: TEN_YEARS,
  places: TEN_YEARS,
  probe_search: TEN_YEARS,
  trends: THIRTY_DAYS,
  h3fips: TEN_YEARS,
  density: TEN_YEARS,
  marketpop: TEN_YEARS,
  mcu_summary: TEN_YEARS,
};

export async function getCached<T>(cacheType: string, cacheKey: string): Promise<T | null> {
  try {
    return await withDbAttribution(`mcu_cache:get:${cacheType}`, () =>
      dbRetry(async () => {
        const result = await getDb()
          .select()
          .from(mcuCache)
          .where(
            and(
              eq(mcuCache.cacheType, cacheType),
              eq(mcuCache.cacheKey, cacheKey),
              gt(mcuCache.expiresAt, new Date())
            )
          )
          .limit(1);

        if (result.length > 0) {
          return result[0].data as T;
        }
        return null;
      }, `cache-get:${cacheType}`),
    );
  } catch (error) {
    console.error("Cache get error:", error);
    return null;
  }
}

export async function setCache<T>(cacheType: string, cacheKey: string, data: T): Promise<void> {
  try {
    const ttl = CACHE_TTLS[cacheType] || TEN_YEARS;
    const expiresAt = new Date(Date.now() + ttl);

    await withDbAttribution(`mcu_cache:set:${cacheType}`, () =>
      dbRetry(async () => {
        await getDb()
          .insert(mcuCache)
          .values({
            cacheType,
            cacheKey,
            data: data as any,
            expiresAt,
          })
          .onConflictDoUpdate({
            target: [mcuCache.cacheType, mcuCache.cacheKey],
            set: {
              data: data as any,
              expiresAt,
            },
          });
      }, `cache-set:${cacheType}`),
    );
  } catch (error) {
    console.error("Cache set error:", error);
  }
}

export async function clearCacheForLocation(lat: number, lng: number): Promise<void> {
  const prefix = `probe-v1:${lat.toFixed(4)},${lng.toFixed(4)}`;
  try {
    await withDbAttribution("mcu_cache:clear_for_location", async () => {
      const db = getDb();
      const rows = await db
        .select({ id: mcuCache.id, cacheKey: mcuCache.cacheKey })
        .from(mcuCache)
        .where(eq(mcuCache.cacheType, "probe_search"));

      for (const row of rows) {
        if (row.cacheKey.startsWith(prefix)) {
          await db.delete(mcuCache).where(eq(mcuCache.id, row.id));
        }
      }
    });
  } catch (error) {
    console.error("Clear location cache error:", error);
  }
}

export async function clearAllProbeCache(): Promise<void> {
  try {
    await withDbAttribution("mcu_cache:clear_all_probe", async () => {
      await getDb().delete(mcuCache).where(eq(mcuCache.cacheType, "probe_search"));
    });
  } catch (error) {
    console.error("Clear all probe cache error:", error);
  }
}

export async function clearExpiredCache(): Promise<number> {
  try {
    await withDbAttribution("mcu_cache:clear_expired", async () => {
      await getDb()
        .delete(mcuCache)
        .where(lt(mcuCache.expiresAt, new Date()));
    });
    return 0;
  } catch (error) {
    console.error("Cache clear error:", error);
    return 0;
  }
}
