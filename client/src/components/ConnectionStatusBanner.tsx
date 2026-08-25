/**
 * Task #4791 — the single connection-lost indicator.
 *
 * Subscribes to the connection-lost tracker (lib/connectionLost.ts) and shows
 * ONE persistent pill while the server is unreachable, then a brief
 * "Connection restored" confirmation that dismisses itself. Deliberately a
 * banner rather than a toast: TOAST_LIMIT is 1, so any later toast would
 * evict a "persistent" connection toast, and the destructive toast's
 * TOAST_REMOVE_DELAY (~17 min) is exactly the lingering behavior this
 * replaces. Renders nothing in the ok phase.
 */
import { useSyncExternalStore } from "react";
import { Loader2, Wifi, WifiOff } from "lucide-react";
import { connectionLostTracker } from "@/lib/connectionLost";

const PILL_BASE_CLASSES =
  "fixed left-1/2 top-3 z-[var(--z-toast)] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 " +
  "rounded-full border px-4 py-2 text-sm font-medium shadow-lg";

export function ConnectionStatusBanner() {
  const state = useSyncExternalStore(
    connectionLostTracker.subscribe,
    connectionLostTracker.getState,
    connectionLostTracker.getState,
  );

  if (state.phase === "ok") return null;

  if (state.phase === "lost") {
    const offline = state.cause === "offline";
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="banner-connection-lost"
        className={`${PILL_BASE_CLASSES} border-destructive/40 bg-destructive text-destructive-foreground`}
      >
        {offline ? (
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
        )}
        <span className="truncate">
          {offline
            ? "You're offline — waiting for your connection…"
            : "Connection problem — trying to reconnect…"}
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="banner-connection-restored"
      className={`${PILL_BASE_CLASSES} border-border bg-background text-foreground`}
    >
      <Wifi className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span className="truncate">Connection restored</span>
    </div>
  );
}

export default ConnectionStatusBanner;
