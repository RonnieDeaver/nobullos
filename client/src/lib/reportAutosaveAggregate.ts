/**
 * Aggregate autosave state across concurrently-saving form sections.
 *
 * ReportForm runs one debounced autosave watcher per section (intake,
 * sales, marketing, nextActions); their network saves overlap freely.
 * A single scalar "saving/saved/error" state lies under concurrency:
 * the first save to settle would claim "All changes saved" while
 * sibling sections are still in flight (or about to fail).
 *
 * This module tracks per-section in-flight counts and failure flags so
 * the indicator only reports "saved" when NO section is dirty, in
 * flight, or sitting on an unresolved failure.
 *
 * Semantics:
 * - "start" increments the section's in-flight count and clears its
 *   failure flag (a new attempt supersedes the old outcome).
 * - "success" / "failure" decrement the count; failure marks the flag.
 *   Within one section, whichever settlement arrives LAST determines
 *   that section's face (payload versions are not observable here, so
 *   settlement order is the only defensible tiebreak).
 * - A failed section keeps the aggregate in "error" until a NEW save of
 *   that same section starts — other sections saving successfully must
 *   not mask it, because the failed section's edits remain unsaved
 *   (the debounce only re-arms on the next edit of that section).
 */

export type AutosaveSectionEvent = "start" | "success" | "failure";

export interface AutosaveAggregateSnapshot {
  /** At least one section save is currently on the network. */
  anyInFlight: boolean;
  /** At least one section's most recent settlement was a failure. */
  anyFailed: boolean;
  /** At least one save has ever succeeded since mount/reset. */
  everSucceeded: boolean;
}

export type AutosaveIndicatorStatus =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "error";

export interface AutosaveAggregator {
  record(section: string, event: AutosaveSectionEvent): void;
  /**
   * Returns the current aggregate. The returned object is CACHED and only
   * replaced when a mutation actually changes the derived flags, so it is a
   * valid `getSnapshot` for React's useSyncExternalStore (referential
   * stability between changes — no infinite re-render loop, no version-tick
   * dependency needed in consumers).
   */
  snapshot(): AutosaveAggregateSnapshot;
  /**
   * Subscribe to changes (useSyncExternalStore contract). The listener fires
   * after every record()/reset(); returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
  /** Forget everything (e.g. when switching to a different report). */
  reset(): void;
}

export function createAutosaveAggregator(
  onChange?: () => void,
): AutosaveAggregator {
  const inFlight = new Map<string, number>();
  const failed = new Set<string>();
  let everSucceeded = false;
  const listeners = new Set<() => void>();
  let cached: AutosaveAggregateSnapshot = {
    anyInFlight: false,
    anyFailed: false,
    everSucceeded: false,
  };

  function refreshSnapshot(): void {
    const next: AutosaveAggregateSnapshot = {
      anyInFlight: inFlight.size > 0,
      anyFailed: failed.size > 0,
      everSucceeded,
    };
    if (
      next.anyInFlight !== cached.anyInFlight ||
      next.anyFailed !== cached.anyFailed ||
      next.everSucceeded !== cached.everSucceeded
    ) {
      cached = next;
    }
  }

  function notify(): void {
    refreshSnapshot();
    onChange?.();
    for (const l of listeners) l();
  }

  return {
    record(section: string, event: AutosaveSectionEvent): void {
      if (event === "start") {
        inFlight.set(section, (inFlight.get(section) ?? 0) + 1);
        failed.delete(section);
      } else {
        const remaining = (inFlight.get(section) ?? 0) - 1;
        if (remaining > 0) inFlight.set(section, remaining);
        else inFlight.delete(section);
        if (event === "failure") {
          failed.add(section);
        } else {
          everSucceeded = true;
          failed.delete(section);
        }
      }
      notify();
    },
    snapshot(): AutosaveAggregateSnapshot {
      return cached;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset(): void {
      inFlight.clear();
      failed.clear();
      everSucceeded = false;
      notify();
    },
  };
}

/**
 * Collapse the aggregate + the "any debounce pending" flag into the
 * single indicator status. Precedence: dirty > saving > error > saved.
 * "saved" therefore requires: nothing dirty, nothing in flight, and no
 * unresolved failure — the exact truth condition for "All changes
 * saved" on a multi-section form.
 */
export function deriveAutosaveIndicator(
  snap: AutosaveAggregateSnapshot,
  anyDirty: boolean,
): AutosaveIndicatorStatus {
  if (anyDirty) return "dirty";
  if (snap.anyInFlight) return "saving";
  if (snap.anyFailed) return "error";
  if (snap.everSucceeded) return "saved";
  return "idle";
}
