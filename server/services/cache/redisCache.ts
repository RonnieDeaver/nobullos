/**
 * DB Scale Layer epic — Phase 1 Redis cache service.
 * Spec: `.local/tasks/db-scale-layer-redis-pgbouncer.md`
 *
 * Thin typed wrapper around @upstash/redis (HTTPS, stateless — works
 * natively in autoscale). Phase 1 lands the infra + service + metrics
 * with NO call sites wired yet. Phase 2 caches the approved hot reads
 * (system_settings, user perms, client list summary, integration
 * status, queue/health rollups) on top of this surface.
 *
 * Architectural contract (must observe):
 *  • Fail-open. Any Redis error logs and returns null/loader result —
 *    never throws past the helper.
 *  • Hard-required TTL. Every cached entry must declare its TTL in
 *    seconds at set time; we do not allow set-without-expiry.
 *  • One global kill switch (`redis_cache_enabled`, default OFF). Read
 *    through `../poolEpicSwitchState.ts` — the dependency-free leaf
 *    split out of `poolEpicKillSwitches.ts` by Task #3947 so this cache
 *    never imports the storage-backed loader (that import closed the
 *    storage → settingsStorage → redisCache → poolEpicKillSwitches
 *    boot-time cycle). When off OR when env vars are missing, every
 *    operation short-circuits as "bypassed" and `cacheGetOrSet` runs
 *    the loader directly.
 *  • No truth in Redis. Reports, revenue, pipeline state, raw
 *    messages, OAuth tokens, work-queue rows are explicitly excluded
 *    at the call site — there is no allow-list here.
 *  • Namespaced keys. Every key is prefixed with
 *    `${KEY_PREFIX}:${namespace}:` so we can `delByPrefix` per
 *    namespace and so an environment collision in a shared Upstash
 *    instance is impossible.
 */
import { Redis } from "@upstash/redis";
import { isPoolEpicSwitchEnabled } from "../poolEpicSwitchState";
import { isRunningInDeployment } from "../../lib/deploymentEnv";

// Derive the namespace from the canonical deployment helper, not from the
// nonexistent REPL_DEPLOYMENT variable (the correct Replit env var is
// REPLIT_DEPLOYMENT=1; the old expression was always falsy in both envs).
// This ensures dev writes to nobull:dev:* and prod writes to nobull:prod:*
// on the same shared Upstash instance, eliminating the cross-env bleed path.
const ENV_KEY = isRunningInDeployment() ? "prod" : "dev";
// Task #3797 (hermetic test isolation): test children run against a private
// per-run Postgres, so they must ALSO read/write a private per-run Redis
// namespace — otherwise a cached row from the live dev server (or a previous
// run) could contradict hermetic DB state. The runner sets
// NOBULL_TEST_CACHE_NAMESPACE=<runId> on every child; keys land under
// `nobull:test:<runId>:…` and expire via their mandatory TTLs. Never set in
// dev/prod server processes.
const TEST_CACHE_NS = process.env.NOBULL_TEST_CACHE_NAMESPACE;
const KEY_PREFIX = TEST_CACHE_NS ? `nobull:test:${TEST_CACHE_NS}` : `nobull:${ENV_KEY}`;

// ─── Lazy singleton client ──────────────────────────────────────────
//
// The Upstash REST client itself is cheap to construct and stateless,
// but we only want to construct it once and only if both env vars are
// present. A missing env var puts the service in "configured: false"
// state — every op short-circuits as bypassed.
let client: Redis | null = null;
let configured: boolean | null = null;

function getClient(): Redis | null {
  if (configured === false) return null;
  if (client) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    configured = false;
    return null;
  }
  try {
    client = new Redis({ url, token });
    configured = true;
    return client;
  } catch (err: any) {
    console.warn("[RedisCache] Failed to construct client:", err?.message ?? err);
    configured = false;
    return null;
  }
}

/** Test-only visibility (hermetic isolation guard test): the active key prefix. */
export function __getCacheKeyPrefixForTest(): string {
  return KEY_PREFIX;
}

export function isRedisConfigured(): boolean {
  if (configured === null) getClient();
  return configured === true;
}

// ─── Metrics ────────────────────────────────────────────────────────
//
// Per-process counters surfaced through `/api/_internal/redis-metrics`
// in Phase 3. Bypassed = kill switch off OR not configured. Errors are
// counted but never thrown.
interface CacheCounters {
  hit: number;
  miss: number;
  set: number;
  del: number;
  error: number;
  bypassed: number;
}

const counters: CacheCounters = {
  hit: 0,
  miss: 0,
  set: 0,
  del: 0,
  error: 0,
  bypassed: 0,
};

// Per-namespace hit/miss so the dashboard can show which cache is
// actually doing work and which is just adding latency.
interface NamespaceCounters {
  hit: number;
  miss: number;
}
const byNamespace = new Map<string, NamespaceCounters>();

function bump(ns: string, key: keyof NamespaceCounters): void {
  let row = byNamespace.get(ns);
  if (!row) {
    row = { hit: 0, miss: 0 };
    byNamespace.set(ns, row);
  }
  row[key]++;
}

export function getRedisCacheMetrics(): {
  configured: boolean;
  enabled: boolean;
  totals: CacheCounters;
  namespaces: Array<{ namespace: string; hit: number; miss: number; hitRate: number }>;
} {
  const enabled = isPoolEpicSwitchEnabled("redis_cache_enabled");
  const namespaces = Array.from(byNamespace.entries())
    .map(([namespace, row]) => {
      const total = row.hit + row.miss;
      return {
        namespace,
        hit: row.hit,
        miss: row.miss,
        hitRate: total === 0 ? 0 : Math.round((row.hit / total) * 1000) / 10,
      };
    })
    .sort((a, b) => b.hit + b.miss - (a.hit + a.miss));
  return {
    configured: isRedisConfigured(),
    enabled,
    totals: { ...counters },
    namespaces,
  };
}

// Test seam.
export function __resetRedisCacheMetricsForTest(): void {
  counters.hit = 0;
  counters.miss = 0;
  counters.set = 0;
  counters.del = 0;
  counters.error = 0;
  counters.bypassed = 0;
  byNamespace.clear();
}

// Test seam: clear the cached client + configured flag so a test can
// flip env vars between scenarios within a single process. Not part
// of any public registry.
export function __resetRedisCacheClientForTest(): void {
  client = null;
  configured = null;
}

// Test seam: when set (e.g. by tests/db-sandbox.ts), every cache op
// short-circuits as "bypassed" whenever the resolver returns true.
// This lets per-test isolated-schema scopes opt out of the process-
// shared Upstash cache for the lifetime of the scope without having
// to enumerate which keys/namespaces the test will touch. Production
// code never sets this.
let testBypassResolver: (() => boolean) | null = null;

export function __setTestBypassResolver(
  resolver: (() => boolean) | null,
): void {
  testBypassResolver = resolver;
}

// ─── Key shaping ────────────────────────────────────────────────────

function fullKey(namespace: string, key: string): string {
  return `${KEY_PREFIX}:${namespace}:${key}`;
}

function isActive(): boolean {
  if (testBypassResolver && testBypassResolver()) return false;
  if (!isPoolEpicSwitchEnabled("redis_cache_enabled")) return false;
  return getClient() !== null;
}

// ─── Public API ─────────────────────────────────────────────────────

export interface CacheSetOptions {
  /** TTL in seconds. REQUIRED — we do not allow non-expiring entries. */
  ttlSeconds: number;
}

export async function cacheGet<T = unknown>(
  namespace: string,
  key: string,
): Promise<T | null> {
  if (!isActive()) {
    counters.bypassed++;
    return null;
  }
  const c = getClient()!;
  try {
    // @upstash/redis auto-parses JSON for `get` so the consumer gets
    // back the same type they put in via `cacheSet`.
    const raw = await c.get<T>(fullKey(namespace, key));
    if (raw === null || raw === undefined) {
      counters.miss++;
      bump(namespace, "miss");
      return null;
    }
    counters.hit++;
    bump(namespace, "hit");
    return raw as T;
  } catch (err: any) {
    counters.error++;
    console.warn(`[RedisCache] get error ns=${namespace}: ${err?.message ?? err}`);
    return null;
  }
}

export async function cacheSet<T = unknown>(
  namespace: string,
  key: string,
  value: T,
  opts: CacheSetOptions,
): Promise<void> {
  if (!isActive()) {
    counters.bypassed++;
    return;
  }
  if (!opts || !Number.isFinite(opts.ttlSeconds) || opts.ttlSeconds <= 0) {
    counters.error++;
    console.warn(`[RedisCache] set rejected — TTL must be > 0 (ns=${namespace})`);
    return;
  }
  const c = getClient()!;
  try {
    await c.set(fullKey(namespace, key), value as any, { ex: Math.floor(opts.ttlSeconds) });
    counters.set++;
  } catch (err: any) {
    counters.error++;
    console.warn(`[RedisCache] set error ns=${namespace}: ${err?.message ?? err}`);
  }
}

export async function cacheDel(namespace: string, key: string): Promise<void> {
  if (!isActive()) {
    counters.bypassed++;
    return;
  }
  const c = getClient()!;
  try {
    await c.del(fullKey(namespace, key));
    counters.del++;
  } catch (err: any) {
    counters.error++;
    console.warn(`[RedisCache] del error ns=${namespace}: ${err?.message ?? err}`);
  }
}

/**
 * Delete every key under a namespace prefix using SCAN+DEL in
 * batches. Safe against large keyspaces — never blocks Redis on a
 * KEYS *. Returns the number of keys deleted (best-effort; failures
 * are absorbed into the error counter).
 */
export async function cacheDelByPrefix(
  namespace: string,
  keyPrefix = "",
): Promise<number> {
  if (!isActive()) {
    counters.bypassed++;
    return 0;
  }
  const c = getClient()!;
  const match = `${fullKey(namespace, keyPrefix)}*`;
  let cursor = 0;
  let deleted = 0;
  try {
    do {
      // @upstash/redis returns [cursor, keys] as [string, string[]]
      const res = (await c.scan(cursor, { match, count: 200 })) as [number | string, string[]];
      const nextCursor = typeof res[0] === "string" ? parseInt(res[0], 10) : res[0];
      const keys = res[1] ?? [];
      if (keys.length > 0) {
        await c.del(...keys);
        deleted += keys.length;
        counters.del += keys.length;
      }
      cursor = Number.isFinite(nextCursor) ? (nextCursor as number) : 0;
    } while (cursor !== 0);
    return deleted;
  } catch (err: any) {
    counters.error++;
    console.warn(`[RedisCache] delByPrefix error ns=${namespace}: ${err?.message ?? err}`);
    return deleted;
  }
}

/**
 * One-time boot flush for the integration_status and sys_setting
 * namespaces in this environment. Called on server startup to evict
 * any stale entries that were written by the OTHER environment before
 * the env-namespace fix landed (when both dev and prod mistakenly
 * shared nobull:dev:* keys). Fails open — Redis errors are absorbed.
 *
 * After the fix this is belt-and-suspenders: prod starts under a
 * brand-new nobull:prod:* namespace (no old keys to flush), and dev
 * clears whatever pre-fix prod-written values may still be present.
 */
export async function flushEnvNamespacesOnBoot(): Promise<void> {
  if (!isActive()) return;
  const namespaces = [
    "integration_status",
    "integration_status_epoch",
    "system_settings", // must match SYSTEM_SETTINGS_NS in server/storage/settingsStorage.ts
  ];
  for (const ns of namespaces) {
    try {
      const n = await cacheDelByPrefix(ns, "");
      if (n > 0) {
        console.log(`[RedisCache] boot flush: cleared ${n} stale key(s) in ${KEY_PREFIX}:${ns}:*`);
      }
    } catch {
      // fail-open
    }
  }
}

/**
 * Read-through cache. On hit returns the cached value; on miss runs
 * the loader, caches the result with the given TTL, and returns the
 * fresh value. Loader errors propagate (caller's responsibility); a
 * Redis-layer error never blocks the loader call.
 */
export async function cacheGetOrSet<T = unknown>(
  namespace: string,
  key: string,
  loader: () => Promise<T>,
  opts: CacheSetOptions,
): Promise<T> {
  if (!isActive()) {
    counters.bypassed++;
    return loader();
  }
  const cached = await cacheGet<T>(namespace, key);
  if (cached !== null) return cached;
  const fresh = await loader();
  // Skip caching null/undefined to avoid negative-cache footguns at
  // the foundation layer. Phase 2 call sites that genuinely want a
  // negative-cache TTL should wrap their value in `{ found: false }`.
  if (fresh !== null && fresh !== undefined) {
    await cacheSet(namespace, key, fresh, opts);
  }
  return fresh;
}
