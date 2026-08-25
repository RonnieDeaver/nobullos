/**
 * Task #4215 — shared "current time" ticker.
 *
 * Roadmap progress percentages are pure date math (shared/roadmapProgress.ts)
 * computed at render time; this hook re-renders subscribers on an interval so
 * bars visibly stay current without any background job or refetch.
 */
import { useEffect, useState } from "react";

export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
