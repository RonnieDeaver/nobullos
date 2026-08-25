/**
 * Ads OS — per-key single-flight locks (port of backend/app/singleflight.py).
 *
 * KeyedLocks hands out one mutex per cache key so concurrent requests for the
 * SAME dashboard range serialize (first one builds, the rest reuse its result
 * via double-checked locking), while different ranges build in parallel.
 *
 * TS port: a per-key promise chain acts as the mutex. `withLock` waits for the
 * previous holder, runs `fn`, then releases regardless of outcome. Entries are
 * cleaned up when no waiters remain, so the map can't grow unboundedly.
 */

/**
 * Bounded-concurrency map (port of the bundle's ThreadPoolExecutor usage):
 * runs `fn` over `items` with at most `limit` in flight, preserving order.
 * Any rejection propagates (matching pool.map raising in the caller).
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class KeyedLocks {
  private chains = new Map<string, Promise<unknown>>();
  private waiters = new Map<string, number>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    this.waiters.set(key, (this.waiters.get(key) ?? 0) + 1);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // The next caller waits for our gate (never rejects — errors flow to OUR caller).
    this.chains.set(key, prev.then(() => gate, () => gate));

    // Wait for the previous holder (ignore its outcome — its error belongs to it).
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      const n = (this.waiters.get(key) ?? 1) - 1;
      if (n <= 0) {
        this.waiters.delete(key);
        this.chains.delete(key);
      } else {
        this.waiters.set(key, n);
      }
    }
  }
}
