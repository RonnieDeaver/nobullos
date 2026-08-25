/**
 * Global unhandledrejection handler for stale-deploy chunk-load failures.
 *
 * The GlobalErrorBoundary only catches chunk errors that surface as React
 * render failures (lazy route components).  A stale chunk error inside an
 * async data fetch or event handler surfaces as an unhandled promise
 * rejection instead — invisible to the boundary.  This handler applies the
 * same isChunkLoadError + loop-guard logic to that second path.
 */

import {
  isChunkLoadError,
  canAutoReload,
  markAutoReloaded,
} from "./chunkLoadError";

let installed = false;

/**
 * Attaches a single window `unhandledrejection` listener that auto-reloads
 * the page (at most once per URL per guard window) when the rejection looks
 * like a stale-build chunk-load failure.  Idempotent — safe to call more
 * than once.
 */
export function initChunkLoadErrorHandler(options?: {
  /** Test seam — jsdom's location.reload is non-configurable. */
  reload?: () => void;
}): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const doReload = options?.reload ?? (() => window.location.reload());

  window.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    if (!isChunkLoadError(reason)) return;
    if (!canAutoReload()) return;
    // Prevent the default "Uncaught (in promise)" console noise for the
    // rejection we are handling by reloading.
    event.preventDefault?.();
    markAutoReloaded();
    doReload();
  });
}

/**
 * Test-only: allows re-installation after a jsdom window swap.  It resets the
 * install flag but does NOT detach the previous listener — the old listener
 * dies with the discarded jsdom window, so detaching is unnecessary.
 */
export function __test_resetChunkLoadErrorHandler(): void {
  installed = false;
}
