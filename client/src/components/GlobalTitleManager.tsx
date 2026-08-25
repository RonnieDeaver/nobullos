/**
 * Writes `document.title` from one place: count prefix + current page title.
 * Must be mounted inside QueryClientProvider, TitleProvider, and CommsProvider.
 *
 * Bell count sourcing is self-contained (Task #3354): this component
 * subscribes to the shared unread-count cache entry AND triggers its own
 * boot fetch when the cache is empty — it does NOT rely on NotificationBell
 * having mounted first. When the bell IS mounted, both subscribers share the
 * same query (UNREAD_COUNT_KEY from lib/notificationsQuery), so React Query
 * dedupes the boot fetch into a single network request, and the bell's SSE
 * handler keeps the cached count fresh afterwards. Until the first response
 * arrives the count is treated as unknown (no badge), never an authoritative
 * zero. Chat count is sourced from CommsContext (totalUnread +
 * totalThreadUnread), which is already app-wide.
 */

import { useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { isPublicPath } from "@/lib/publicPaths";
import { useTitleContext } from "@/contexts/TitleContext";
import { useCommsSelector } from "@/contexts/CommsContext";
import { composeTitleWithCounts } from "@/lib/titleComposer";
import { UNREAD_COUNT_KEY, fetchUnreadCount } from "@/lib/notificationsQuery";

export function GlobalTitleManager() {
  const { pageTitle } = useTitleContext();
  // Narrow selector subscription (Task #3838): this component mounts globally,
  // so it must only re-render when the combined chat count actually changes —
  // not on every SSE event the comms provider processes.
  const chatCount = useCommsSelector((s) => s.totalUnread + s.totalThreadUnread);

  // useQuery here is both the cache subscription AND the boot fetch: with a
  // queryFn attached, React Query fetches on mount whenever the cache entry
  // is missing, and staleTime: Infinity means an already-populated entry
  // (seeded by NotificationBell or a previous mount) is reused without a
  // duplicate request.
  const [location] = useLocation();
  const { data: unreadData } = useQuery<{ count: number }>({
    queryKey: UNREAD_COUNT_KEY,
    queryFn: fetchUnreadCount,
    // Task #4225 — the unread-count probe is authenticated; on public
    // surfaces (share/demo report, booking, …) it 401s in the console on
    // every load and the badge is meaningless there anyway.
    enabled: !isPublicPath(location),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  // Unknown (pre-first-response) renders no badge — composeTitleWithCounts
  // suppresses zero counts, so "unknown" and "confirmed zero" both show a
  // clean title, and a non-zero count appears as soon as the boot fetch or
  // the shared cache provides it.
  const bellCount = unreadData?.count ?? 0;

  useEffect(() => {
    document.title = composeTitleWithCounts(pageTitle, bellCount, chatCount);
  }, [pageTitle, bellCount, chatCount]);

  return null;
}
