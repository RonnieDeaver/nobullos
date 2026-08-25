/**
 * Stale-deploy chunk-load error detection and reload-loop guard.
 *
 * After a Vite publish, old fingerprinted asset filenames disappear.  Users
 * with suspended/backgrounded tabs hit "Importing a module script failed"
 * (and similar browser variants) when a lazy route chunk resolves to a dead
 * filename.  This module provides:
 *
 *   isChunkLoadError(err)  — returns true when the error looks like a
 *                            stale-build chunk-load failure across browsers.
 *
 *   canAutoReload()        — returns true when no auto-reload has been
 *                            attempted for the current URL in the last
 *                            GUARD_WINDOW_MS milliseconds (loop-guard).
 *
 *   markAutoReloaded()     — records that an auto-reload was triggered for
 *                            the current URL so canAutoReload() returns false
 *                            until the guard window expires.
 *
 *   clearAutoReloadGuard() — removes the guard for the current URL; call
 *                            this on successful app startup so future
 *                            stale-deploy events get one auto-reload again.
 */

const STALE_CHUNK_PATTERNS: RegExp[] = [
  /importing a module script failed/i,
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /loading chunk \S+ failed/i,
  /loading css chunk \S+ failed/i,
  /chunkloaderror/i,
  /dynamically imported module/i,
];

/**
 * Returns true when `error` looks like a stale-deploy chunk / module load
 * failure rather than a genuine runtime error.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const name = error instanceof Error ? (error.name ?? "") : "";
  if (name === "ChunkLoadError") return true;
  const msg = error instanceof Error ? error.message : String(error);
  return STALE_CHUNK_PATTERNS.some((p) => p.test(msg));
}

// --------------------------------------------------------------------------
// Reload-loop guard — at most one auto-reload per URL per GUARD_WINDOW_MS.
// Stored in sessionStorage so it survives the reload itself.
// --------------------------------------------------------------------------

const GUARD_KEY_PREFIX = "__nobull_stale_chunk_reload_guard";
const GUARD_WINDOW_MS = 30_000;

function currentGuardKey(): string {
  try {
    const path =
      typeof window !== "undefined" ? window.location.pathname : "/";
    return `${GUARD_KEY_PREFIX}:${path}`;
  } catch {
    return GUARD_KEY_PREFIX;
  }
}

/**
 * Returns true when it is safe to trigger an automatic reload (i.e. no
 * auto-reload has been triggered for the current URL within the guard window).
 */
export function canAutoReload(): boolean {
  try {
    const stored = sessionStorage.getItem(currentGuardKey());
    if (!stored) return true;
    const ts = parseInt(stored, 10);
    return isNaN(ts) || Date.now() - ts > GUARD_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Records that an auto-reload is being triggered for the current URL.
 * Subsequent calls to canAutoReload() return false until the guard expires.
 */
export function markAutoReloaded(): void {
  try {
    sessionStorage.setItem(currentGuardKey(), String(Date.now()));
  } catch {
    // sessionStorage may be unavailable (private mode, quota exceeded, etc.)
  }
}

/**
 * Clears the guard for the current URL.  Call this after a successful app
 * startup so future stale-deploy events get exactly one auto-reload.
 */
export function clearAutoReloadGuard(): void {
  try {
    sessionStorage.removeItem(currentGuardKey());
  } catch {
    // ignore
  }
}
