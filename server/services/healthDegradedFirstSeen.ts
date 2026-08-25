/**
 * Task #1074: persist first-seen timestamps for degraded `/api/health`
 * sub-check keys across server restarts. Without this, every deploy
 * resets the "degraded for Xm" tracker (Task #1070) to 0, so an
 * operator triaging right after a deploy sees "degraded for 5s" for
 * something that has actually been broken for hours.
 *
 * Storage: a single JSON document in `system_settings` under
 * `health_degraded_first_seen`. Shape: `{ [key: string]: number }`
 * where the value is the epoch-ms first-seen timestamp. The document
 * only ever contains keys that were degraded as of the last persist —
 * recovered keys are removed, so the store cannot grow forever.
 *
 * Hot-path semantics:
 *  - The `/api/health` handler awaits `loadDegradedFirstSeen()` once on
 *    its first invocation; subsequent requests reuse the in-memory Map.
 *  - Persistence is only triggered when the set of degraded keys
 *    actually changes (key added or recovered) so the steady-state hot
 *    path is a no-op.
 */
import { storage } from "../storage";

const SETTING_KEY = "health_degraded_first_seen";

let inMemory: Map<string, number> | null = null;
let loadingPromise: Promise<Map<string, number>> | null = null;

export async function loadDegradedFirstSeen(): Promise<Map<string, number>> {
  if (inMemory) return inMemory;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const map = new Map<string, number>();
    try {
      const row = await storage.getSystemSetting(SETTING_KEY);
      if (row?.value) {
        try {
          const parsed = JSON.parse(row.value) as Record<string, unknown>;
          if (parsed && typeof parsed === "object") {
            for (const [k, v] of Object.entries(parsed)) {
              if (typeof v === "number" && Number.isFinite(v) && v > 0) {
                map.set(k, v);
              }
            }
          }
        } catch (err: any) {
          console.warn(
            `[HealthDegradedFirstSeen] failed to parse persisted state: ${err?.message || err}`,
          );
        }
      }
    } catch (err: any) {
      console.warn(
        `[HealthDegradedFirstSeen] failed to load persisted state: ${err?.message || err}`,
      );
    } finally {
      loadingPromise = null;
    }
    inMemory = map;
    return map;
  })();
  return loadingPromise;
}

// Serialize persist writes so concurrent /api/health requests can't
// race and leave a stale snapshot in `system_settings`. Each call
// chains onto the previous write, and the in-memory Map is
// re-serialized at write time so the most recent reconcile state
// always wins.
let persistChain: Promise<void> = Promise.resolve();

export function persistDegradedFirstSeen(
  map: Map<string, number>,
): Promise<void> {
  const next = persistChain.then(async () => {
    const obj: Record<string, number> = {};
    for (const [k, v] of map) obj[k] = v;
    try {
      await storage.setSystemSetting(SETTING_KEY, JSON.stringify(obj), "system");
    } catch (err: any) {
      console.warn(
        `[HealthDegradedFirstSeen] failed to persist state: ${err?.message || err}`,
      );
    }
  });
  persistChain = next;
  return next;
}

/**
 * Reconcile the persisted Map against the current set of degraded
 * keys. Returns a `degradedSince` snapshot for the response and
 * triggers an async persist when anything changed (key added or
 * recovered). Safe to call on every `/api/health` request — the
 * persist is a no-op when nothing changed.
 */
export async function reconcileDegradedFirstSeen(
  degraded: string[],
  now: number,
): Promise<Record<string, number>> {
  const map = await loadDegradedFirstSeen();
  const degradedSet = new Set(degraded);
  let changed = false;

  for (const key of degradedSet) {
    if (!map.has(key)) {
      map.set(key, now);
      changed = true;
    }
  }
  for (const key of Array.from(map.keys())) {
    if (!degradedSet.has(key)) {
      map.delete(key);
      changed = true;
    }
  }

  if (changed) {
    void persistDegradedFirstSeen(map);
  }

  const out: Record<string, number> = {};
  for (const key of degraded) out[key] = map.get(key) ?? now;
  return out;
}

/** Test/diagnostic helper. Clears in-memory cache so the next call reloads. */
export function _resetDegradedFirstSeenForTests(): void {
  inMemory = null;
  loadingPromise = null;
}
