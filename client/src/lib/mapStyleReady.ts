// Task #2874 — guard MapLibre style-dependent mutations against the
// transient "Style is not done loading" throw.
//
// Both map components (InteractiveHeatmap, HexGridMap) mutate sources /
// layers / paint properties from React effects. MapLibre throws
// "Style is not done loading" if a mutation lands while the style is
// transiently not ready (style swap, slow tile/style fetch, resize churn).
// An effect throw propagates to the global error boundary and replaces the
// WHOLE page with the "Something went wrong" screen.
//
// runWhenMapStyleReady() runs the update immediately when the style is
// ready, and otherwise defers + retries on the map's own readiness events
// ("idle" / "styledata") with a timer backstop. Any style-not-ready throw
// from the update itself is caught and retried the same way; other errors
// are logged and swallowed (a map-paint failure must never take down the
// page). Returns a cancel function suitable as a React effect cleanup.

// Structural type so the helper works with both the real maplibregl.Map and
// the test stub without importing maplibre-gl here.
export interface StyleReadyMapLike {
  isStyleLoaded?: () => boolean | void;
  once?: (event: string, cb: () => void) => unknown;
}

const MAX_RETRIES = 30;
const RETRY_BACKSTOP_MS = 250;

export function isStyleNotReadyError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  return /style is not done loading|style is not loaded/i.test(msg);
}

export function runWhenMapStyleReady(
  map: StyleReadyMapLike,
  update: () => void,
  label = "map-update",
): () => void {
  let cancelled = false;
  let retries = 0;

  const isReady = (): boolean => {
    // A map without isStyleLoaded (older stub / unexpected shape) is treated
    // as ready — the try/catch around update() still contains any throw.
    if (typeof map.isStyleLoaded !== "function") return true;
    try {
      // MapLibre types isStyleLoaded() as boolean | void; treat a void
      // return as "not ready" only when it is explicitly false.
      return map.isStyleLoaded() !== false;
    } catch {
      return false;
    }
  };

  const attempt = (): void => {
    if (cancelled) return;
    if (!isReady()) {
      defer();
      return;
    }
    try {
      update();
    } catch (err) {
      if (isStyleNotReadyError(err)) {
        defer();
      } else {
        // Never let a map mutation error reach the React error boundary.
        console.error(`[${label}] map update failed:`, err);
      }
    }
  };

  const defer = (): void => {
    if (cancelled) return;
    if (retries >= MAX_RETRIES) {
      console.error(
        `[${label}] map style never became ready after ${MAX_RETRIES} retries; giving up on this update.`,
      );
      return;
    }
    retries++;

    let fired = false;
    const onReady = () => {
      if (fired || cancelled) return;
      fired = true;
      clearTimeout(timer);
      attempt();
    };

    // Retry on the map's own readiness signals; the timer is a backstop in
    // case neither event fires (e.g. style load stalled).
    try {
      map.once?.("idle", onReady);
      map.once?.("styledata", onReady);
    } catch {
      // fall through to the timer backstop
    }
    const timer = setTimeout(onReady, RETRY_BACKSTOP_MS);
  };

  attempt();

  return () => {
    cancelled = true;
  };
}
