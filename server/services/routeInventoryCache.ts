import type { RouteEntry } from "../../tests/route-inventory";

const TTL_MS = 60_000;

let cache: { routes: RouteEntry[]; generatedAt: number; expiresAt: number } | null = null;
let inFlight: Promise<{ routes: RouteEntry[]; generatedAt: number }> | null = null;

export type CachedRouteInventory = {
  routes: RouteEntry[];
  generatedAt: number;
  expiresAt: number;
  ttlMs: number;
  cached: boolean;
};

export async function getCachedRouteInventory(options?: { forceRefresh?: boolean }): Promise<CachedRouteInventory> {
  const now = Date.now();
  if (!options?.forceRefresh && cache && cache.expiresAt > now) {
    return {
      routes: cache.routes,
      generatedAt: cache.generatedAt,
      expiresAt: cache.expiresAt,
      ttlMs: TTL_MS,
      cached: true,
    };
  }
  if (options?.forceRefresh) {
    cache = null;
    inFlight = null;
  }
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const { parseRoutes } = await import("../../tests/route-inventory");
        const routes = parseRoutes();
        const generatedAt = Date.now();
        cache = { routes, generatedAt, expiresAt: generatedAt + TTL_MS };
        return { routes, generatedAt };
      } finally {
        inFlight = null;
      }
    })();
  }
  const result = await inFlight;
  return {
    routes: result.routes,
    generatedAt: result.generatedAt,
    expiresAt: result.generatedAt + TTL_MS,
    ttlMs: TTL_MS,
    cached: false,
  };
}

export function invalidateRouteInventoryCache(): void {
  cache = null;
}
