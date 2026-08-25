/**
 * Task #1686 — Notification bell + dropdown for GlobalAppNav.
 *
 * Task #3570 — Two-bucket split: "For you" (personal) and "System".
 * The main bell badge is driven only by the "For you" (personal) count.
 * System alerts appear in a separate tab with a muted secondary indicator
 * and are collapsed/bundled by type so 14× the same alert shows as one
 * row with a repeat count.
 *
 * Real-time updates come from `/api/notifications/events` (SSE) which
 * pushes `notification:new`, `notification:read`, `notification:unread`,
 * `notification:archived`, and `notification:count_updated` events
 * scoped to the current user. The count_updated event now includes
 * { count, personal, system } so both indicators update atomically.
 *
 * Task #2880 — polling is gated by SSE health:
 * - While SSE is connected, polling is disabled entirely.
 * - When SSE is down a 60 s safety-net poll resumes.
 * - After SSE_MAX_CONSECUTIVE_FAILURES rapid failures, auth is probed;
 *   a 401 routes to the session-expiry handler.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Bell, AlertTriangle } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// Popover, not DropdownMenu (Task #4659): the panel is interactive UI — tab
// switchers, mark-all buttons, focusable rows — and the ARIA menu pattern
// (which Radix DropdownMenu implements faithfully) closes on Tab, making that
// content keyboard-unreachable. Popover keeps Escape-to-close + focus-return
// while letting Tab walk the panel.
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { UNREAD_COUNT_KEY, fetchUnreadCount } from "@/lib/notificationsQuery";
import { Button } from "@/components/ui/button";
import { NotificationRow, notificationClientHref } from "@/components/NotificationRow";
import {
  nextSseReconnectState,
  SSE_MAX_CONSECUTIVE_FAILURES,
} from "@/lib/sseReconnect";
import { queryClient as globalQueryClient, markSessionExpired } from "@/lib/queryClient";

type UserNotification = {
  id: string;
  category: string;
  title: string;
  body: string | null;
  deepLink: string | null;
  metadata: unknown;
  readAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Task #4472 — display-ready client name resolved server-side from
   *  metadata.clientId; null when the notification isn't client-scoped. */
  clientName?: string | null;
};

type BundledSystemNotification = {
  ids: string[];
  category: string;
  title: string;
  notificationId: string | null;
  count: number;
  latestAt: string;
  hasUnread: boolean;
  body: string | null;
  deepLink: string | null;
  /** Task #4512 — client name for client-scoped bundles; null when mixed/absent. */
  clientName?: string | null;
};

type ListResponse = {
  notifications: UserNotification[];
  items?: UserNotification[];
  total: number;
  hasMore: boolean;
};

type BundledResponse = {
  bundles: BundledSystemNotification[];
};

const PERSONAL_KEY = ["/api/notifications", { scope: "bell-personal" }] as const;
const SYSTEM_BUNDLED_KEY = ["/api/notifications/system-bundled", { scope: "bell" }] as const;

async function fetchPersonal(): Promise<UserNotification[]> {
  const res = await fetch("/api/notifications?limit=10&bucket=personal", {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`list ${res.status}`);
  const body = (await res.json()) as ListResponse | UserNotification[];
  if (Array.isArray(body)) return body;
  return body.notifications ?? body.items ?? [];
}

async function fetchSystemBundled(): Promise<BundledSystemNotification[]> {
  const res = await fetch("/api/notifications/system-bundled?limit=20", {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`bundled ${res.status}`);
  const body = (await res.json()) as BundledResponse;
  return body.bundles ?? [];
}

type BellTab = "personal" | "system";

export function NotificationBell() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<BellTab>("personal");

  // Task #2880 — track SSE connection health so polling can be suppressed
  // while the stream is live. When SSE is healthy, refetchInterval is false
  // (no polling); when SSE is down, it falls back to the 60 s safety net.
  const [sseConnected, setSseConnected] = useState(false);
  const pollInterval = sseConnected ? false : (60_000 as const);

  const { data: unreadData } = useQuery({
    queryKey: UNREAD_COUNT_KEY,
    queryFn: fetchUnreadCount,
    refetchInterval: pollInterval,
    refetchOnWindowFocus: !sseConnected,
    staleTime: 30_000,
  });
  // Personal count drives the main red badge; system drives the muted indicator.
  const personalCount = unreadData?.personal ?? unreadData?.count ?? 0;
  const systemCount = unreadData?.system ?? 0;

  const { data: personal = [] } = useQuery({
    queryKey: PERSONAL_KEY,
    queryFn: fetchPersonal,
    refetchInterval: pollInterval,
    refetchOnWindowFocus: !sseConnected,
    staleTime: 30_000,
  });

  const { data: systemBundles = [] } = useQuery({
    queryKey: SYSTEM_BUNDLED_KEY,
    queryFn: fetchSystemBundled,
    refetchInterval: pollInterval,
    refetchOnWindowFocus: !sseConnected,
    staleTime: 30_000,
  });

  // SSE subscription — push-driven real-time bell updates.
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    let openedAt = 0;

    const invalidateAll = () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: SYSTEM_BUNDLED_KEY }); // fire-and-forget: cache refresh only
    };

    const connect = () => {
      if (cancelled) return;
      openedAt = Date.now();
      es = new EventSource("/api/notifications/events", { withCredentials: true });

      es.addEventListener("open", () => {
        setSseConnected(true);
      });

      es.addEventListener("notification:new", () => {
        void queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_KEY }); // fire-and-forget: cache refresh only
        invalidateAll();
      });
      const onStateChange = () => invalidateAll();
      es.addEventListener("notification:read", onStateChange);
      es.addEventListener("notification:unread", onStateChange);
      es.addEventListener("notification:archived", onStateChange);
      es.addEventListener("notification:count_updated", (evt: MessageEvent) => {
        try {
          const data = JSON.parse(evt.data) as { count?: number; personal?: number; system?: number };
          if (typeof data?.count === "number" || typeof data?.personal === "number") {
            const personal = data.personal ?? data.count ?? 0;
            const system = data.system ?? 0;
            queryClient.setQueryData(UNREAD_COUNT_KEY, {
              count: personal,
              personal,
              system,
            });
          } else {
            void queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_KEY }); // fire-and-forget: cache refresh only
          }
        } catch {
          void queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_KEY }); // fire-and-forget: cache refresh only
        }
      });
      es.onerror = () => {
        es?.close();
        es = null;
        setSseConnected(false);
        if (cancelled) return;
        const next = nextSseReconnectState(
          consecutiveFailures,
          Date.now() - openedAt,
        );
        consecutiveFailures = next.consecutiveFailures;

        if (consecutiveFailures >= SSE_MAX_CONSECUTIVE_FAILURES) {
          void probeAuthAndStopIfDead().then((isDead) => {
            if (isDead || cancelled) return;
            reconnectTimer = setTimeout(connect, next.delayMs);
          });
          return;
        }

        reconnectTimer = setTimeout(connect, next.delayMs);
      };
    };

    connect();
    return () => {
      cancelled = true;
      setSseConnected(false);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [queryClient]);

  const markRead = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, {
        method: "PATCH",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`markRead ${res.status}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_KEY }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }); // fire-and-forget: cache refresh only
    },
  });

  // Mark all personal notifications read.
  const markPersonalRead = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/notifications/mark-all-read", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucket: "personal" }),
      });
      if (!res.ok) throw new Error(`markPersonalRead ${res.status}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_KEY }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }); // fire-and-forget: cache refresh only
    },
  });

  // Mark all system alerts read.
  const markSystemRead = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/notifications/mark-all-read", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucket: "system" }),
      });
      if (!res.ok) throw new Error(`markSystemRead ${res.status}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_KEY }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: SYSTEM_BUNDLED_KEY }); // fire-and-forget: cache refresh only
    },
  });

  // Mark one bundled system group read.
  const markBundleRead = useMutation({
    mutationFn: async (ids: string[]) => {
      const res = await fetch("/api/notifications/mark-bundle-read", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error(`markBundleRead ${res.status}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_KEY }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: SYSTEM_BUNDLED_KEY }); // fire-and-forget: cache refresh only
    },
  });

  const personalBadge = useMemo(
    () => (personalCount > 99 ? "99+" : String(personalCount)),
    [personalCount],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          // Chrome-band tokens, not white literals — `.dark .bg-card` remaps
          // would erase the badge on the charcoal band (Task #4659).
          className="text-chrome-foreground hover:bg-chrome-foreground/10 hover:text-chrome-foreground relative px-2"
          aria-label={
            personalCount > 0
              ? `Notifications, ${personalCount} unread`
              : "Notifications"
          }
          data-testid="button-notification-bell"
        >
          <Bell className="w-5 h-5" aria-hidden="true" />
          {/* Main badge — personal bucket only */}
          {personalCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-pill bg-chrome-foreground text-chrome text-caption font-bold flex items-center justify-center leading-none"
              data-testid="badge-notification-unread"
            >
              {personalBadge}
            </span>
          )}
          {/* Secondary dot for system alerts (only when the personal badge is
              absent) — solid fill like the main badge (a translucent fill
              can't carry AA digits on the band); hierarchy comes from the
              smaller size and lighter weight. */}
          {personalCount === 0 && systemCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-0.5 rounded-pill bg-chrome-foreground text-chrome text-caption font-semibold flex items-center justify-center leading-none"
              data-testid="badge-system-unread"
            >
              {systemCount > 9 ? "9+" : systemCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-h-[520px] overflow-hidden flex flex-col p-0"
        data-testid="dropdown-notifications"
      >
        {/* Tab headers */}
        <div className="flex items-center border-b">
          <button
            onClick={() => setActiveTab("personal")}
            aria-pressed={activeTab === "personal"}
            className={`flex-1 text-xs px-3 py-2 font-medium border-b-2 transition-colors ${
              activeTab === "personal"
                ? "border-primary-ink text-primary-ink"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            data-testid="tab-personal"
          >
            For you
            {personalCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-pill bg-primary text-primary-foreground text-caption font-bold leading-none">
                {personalCount > 99 ? "99+" : personalCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("system")}
            aria-pressed={activeTab === "system"}
            className={`flex-1 text-xs px-3 py-2 font-medium border-b-2 transition-colors ${
              activeTab === "system"
                ? "border-primary-ink text-primary-ink"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            data-testid="tab-system"
          >
            System
            {systemCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-pill bg-muted text-muted-foreground text-caption font-semibold leading-none">
                {systemCount > 99 ? "99+" : systemCount}
              </span>
            )}
          </button>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "personal" ? (
            <PersonalTab
              items={personal}
              onMarkRead={(id) => markRead.mutate(id)}
              onMarkAllRead={() => markPersonalRead.mutate()}
              markAllPending={markPersonalRead.isPending}
              hasUnread={personalCount > 0}
            />
          ) : (
            <SystemTab
              bundles={systemBundles}
              onMarkBundleRead={(ids) => markBundleRead.mutate(ids)}
              onMarkAllRead={() => markSystemRead.mutate()}
              markAllPending={markSystemRead.isPending}
              hasUnread={systemCount > 0}
            />
          )}
        </div>

        <div role="separator" aria-orientation="horizontal" className="h-px bg-border" />
        <div className="p-2 text-center">
          <Link href="/notifications">
            <span
              className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
              data-testid="link-view-all-notifications"
            >
              View all notifications
            </span>
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PersonalTab({
  items,
  onMarkRead,
  onMarkAllRead,
  markAllPending,
  hasUnread,
}: {
  items: UserNotification[];
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  markAllPending: boolean;
  hasUnread: boolean;
}) {
  return (
    <div>
      <div className="px-2 py-2 text-sm font-semibold flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Recent</span>
        {hasUnread && (
          <button
            onClick={onMarkAllRead}
            disabled={markAllPending}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            data-testid="button-mark-all-personal-read"
          >
            Mark all read
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p
          className="text-body text-muted-foreground text-center py-6"
          data-testid="text-no-personal-notifications"
        >
          No notifications yet
        </p>
      ) : (
        items.map((n) => (
          <NotificationRow
            key={n.id}
            variant="compact"
            category={n.category}
            title={n.title}
            body={n.body}
            timestamp={n.createdAt}
            unread={!n.readAt}
            unreadTone="primary"
            clientName={n.clientName}
            clientHref={notificationClientHref(n.metadata)}
            onRowClick={() => {
              if (!n.readAt) onMarkRead(n.id);
              if (n.deepLink) window.location.assign(n.deepLink);
            }}
            testIds={{ root: `notification-item-${n.id}` }}
          />
        ))
      )}
    </div>
  );
}

function SystemTab({
  bundles,
  onMarkBundleRead,
  onMarkAllRead,
  markAllPending,
  hasUnread,
}: {
  bundles: BundledSystemNotification[];
  onMarkBundleRead: (ids: string[]) => void;
  onMarkAllRead: () => void;
  markAllPending: boolean;
  hasUnread: boolean;
}) {
  return (
    <div>
      <div className="px-2 py-2 text-sm font-semibold flex items-center justify-between">
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" aria-hidden="true" />
          System alerts
        </span>
        {hasUnread && (
          <button
            onClick={onMarkAllRead}
            disabled={markAllPending}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            data-testid="button-mark-all-system-read"
          >
            Mark all read
          </button>
        )}
      </div>
      {bundles.length === 0 ? (
        <p
          className="text-body text-muted-foreground text-center py-6"
          data-testid="text-no-system-notifications"
        >
          No system alerts
        </p>
      ) : (
        bundles.map((b, i) => (
          <NotificationRow
            key={`${b.notificationId ?? b.title}-${i}`}
            variant="compact"
            category={b.category}
            title={b.title}
            body={b.body}
            timestamp={b.latestAt}
            unread={b.hasUnread}
            unreadTone="warn"
            count={b.count}
            clientName={b.clientName}
            onRowClick={() => {
              if (b.hasUnread) onMarkBundleRead(b.ids);
              if (b.deepLink) window.location.assign(b.deepLink);
            }}
            testIds={{ root: `system-bundle-${i}`, count: `bundle-count-${i}` }}
          />
        ))
      )}
    </div>
  );
}

/**
 * Task #2880 — Probe the auth endpoint to detect a dead session after
 * repeated SSE failures. Returns true if the session is confirmed dead
 * (401), which tells the SSE connect loop to stop retrying. Any other
 * outcome (200, 5xx, network error) returns false so the exponential
 * backoff continues normally.
 */
async function probeAuthAndStopIfDead(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/user", { credentials: "include" });
    if (res.status === 401) {
      globalQueryClient.setQueryData(["/api/auth/user"], null);
      markSessionExpired();
      if (typeof window !== "undefined") {
        window.location.assign("/");
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
