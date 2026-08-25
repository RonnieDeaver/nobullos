// Task #3962 / #3979 — client side of the cursor-paginated ATS admin lists
// (audit C-U2/C-U3).
//
// The ATS jobs / submissions / interviews list endpoints return bounded
// keyset pages as `{ <items>, nextCursor, limit }` envelopes instead of
// bare unbounded arrays. Task #3962 originally walked EVERY continuation
// page up-front (fetchAllAtsListPages) to preserve the "show everything"
// UX, but that re-created the growth problem client-side for huge tenants
// (long initial loads, large payloads, silent truncation at the safety
// cap). Task #3979 replaces the walk with on-demand paging: the page's
// useInfiniteQuery fetches one page at a time and loads more when the
// operator asks, and route prefetchers prime only the FIRST page.
// Query keys are unchanged, so existing invalidations keep working.

import {
  useInfiniteQuery,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

export type AtsListItemsKey = "jobs" | "submissions" | "interviews" | "candidates";

export type AtsListPage<T> = { items: T[]; nextCursor: string | null };

/**
 * Fetch ONE page of a cursor-paginated ATS list endpoint. Tolerates the
 * legacy bare-array shape (a stale server during a deploy overlap) by
 * treating it as a single terminal page.
 */
export async function fetchAtsListPage<T>(
  basePath: string,
  itemsKey: AtsListItemsKey,
  cursor: string | null,
): Promise<AtsListPage<T>> {
  const sep = basePath.includes("?") ? "&" : "?";
  const url = cursor ? `${basePath}${sep}cursor=${encodeURIComponent(cursor)}` : basePath;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch ${itemsKey}`);
  const body: unknown = await res.json();
  if (Array.isArray(body)) {
    return { items: body as T[], nextCursor: null };
  }
  const envelope = (body ?? {}) as { [k: string]: unknown; nextCursor?: unknown };
  const rawItems = envelope[itemsKey];
  const items = Array.isArray(rawItems) ? (rawItems as T[]) : [];
  const next = envelope.nextCursor;
  return { items, nextCursor: typeof next === "string" && next.length > 0 ? next : null };
}

/**
 * On-demand paged consumption of a cursor-paginated ATS list. Returns the
 * accumulated items across the pages fetched SO FAR plus the load-more
 * controls the UI needs. The query key must stay identical to the old
 * accumulated-array query's key so existing invalidations keep working.
 */
export function useAtsInfiniteList<T>(options: {
  queryKey: QueryKey;
  basePath: string;
  itemsKey: AtsListItemsKey;
  enabled?: boolean;
}) {
  const { queryKey, basePath, itemsKey, enabled } = options;
  const query = useInfiniteQuery<AtsListPage<T>>({
    queryKey,
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      fetchAtsListPage<T>(basePath, itemsKey, (pageParam as string | null) ?? null),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const items: T[] = query.data ? query.data.pages.flatMap((p) => p.items) : [];
  return {
    items,
    isLoading: query.isLoading,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
  };
}

/**
 * Query keys whose endpoint returns a cursor envelope, mapped to a
 * prefetcher that primes ONLY the first page in the infinite-query cache
 * shape the page's useInfiniteQuery expects. The route prefetchers
 * (App.tsx RoutePrefetcher and PrefetchLink) consult this map — a default
 * queryFn prefetch would cache the raw envelope object under the same key
 * and hand the page's useInfiniteQuery a shape it cannot consume (default
 * staleTime keeps it live for minutes).
 */
export const ATS_PAGINATED_PREFETCHERS: Partial<
  Record<string, (queryClient: QueryClient) => Promise<void>>
> = {
  "/api/ats/jobs": (queryClient) =>
    queryClient.prefetchInfiniteQuery({
      queryKey: ["/api/ats/jobs"],
      initialPageParam: null as string | null,
      queryFn: ({ pageParam }) =>
        fetchAtsListPage("/api/ats/jobs", "jobs", (pageParam as string | null) ?? null),
      staleTime: 30_000,
    }),
};
