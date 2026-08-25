/**
 * Shared React Query config for the notifications unread count.
 *
 * Every subscriber (NotificationBell, GlobalTitleManager, future consumers)
 * must import the key + fetcher from here so they all share ONE cache entry
 * and React Query dedupes their concurrent boot fetches into a single
 * network request. Kept in lib/ (not a UI component file) so non-UI modules
 * can depend on it without pulling in component code.
 *
 * The response now includes per-bucket counts:
 *   - `count`    — personal bucket unread count (main bell badge)
 *   - `personal` — same as count
 *   - `system`   — system bucket unread count (muted secondary indicator)
 */

export const UNREAD_COUNT_KEY = ["/api/notifications/unread-count"] as const;

export interface UnreadCountData {
  count: number;
  personal: number;
  system: number;
}

export async function fetchUnreadCount(): Promise<UnreadCountData> {
  const res = await fetch("/api/notifications/unread-count", {
    credentials: "include",
  });
  if (res.status === 401) {
    return { count: 0, personal: 0, system: 0 };
  }
  if (!res.ok) throw new Error(`unread-count ${res.status}`);
  const data = await res.json();
  return {
    count: data.count ?? 0,
    personal: data.personal ?? data.count ?? 0,
    system: data.system ?? 0,
  };
}
