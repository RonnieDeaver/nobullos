/**
 * Task #1686 — Per-user notification inbox page.
 * Task #3570 — Two-bucket split: "For you" (personal) and "System".
 *
 * Full-page list of the current user's notifications with bucket tabs
 * (For you / System), read-state filters (Unread / All / Archived),
 * category filter, server-side pagination, per-row mark-read / unread /
 * archive actions, bulk "Mark all read" per-bucket, and an admin-only
 * "Send test notification" button.
 *
 * The System tab shows bundled alerts collapsed by type with repeat counts.
 *
 * Real-time updates flow through the same SSE stream as the bell.
 */

import { useEffect, useMemo, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Bell,
  Check,
  Inbox,
  Archive as ArchiveIcon,
  RotateCcw,
  Send,
  AlertTriangle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/kit/EmptyState";
import { notificationTypeMeta } from "@/lib/notificationTypeMeta";
import { NotificationRow, notificationClientHref } from "@/components/NotificationRow";
import { nextSseReconnectState } from "@/lib/sseReconnect";
import { UNREAD_COUNT_KEY } from "@/lib/notificationsQuery";

const PERSONAL_CATEGORIES = [
  "comms.sms",
  "comms.call",
  "comms.voicemail",
  "booking",
  "mention",
  "assignment",
  "agent",
  "feedback",
  "service_desk",
  "crm",
] as const;

const SYSTEM_CATEGORIES = ["system", "queue_health"] as const;

type BucketTab = "personal" | "system";
type Filter = "unread" | "all" | "archived";

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
  limit: number;
  offset: number;
  hasMore: boolean;
};

type BundledResponse = {
  bundles: BundledSystemNotification[];
};

const PAGE_SIZE = 25;

async function fetchPage(args: {
  bucket: BucketTab;
  filter: Filter;
  category: string | null;
  offset: number;
}): Promise<ListResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(args.offset));
  params.set("bucket", args.bucket);
  if (args.filter === "unread") params.set("unreadOnly", "1");
  if (args.filter === "archived") params.set("archivedOnly", "1");
  if (args.category) params.set("category", args.category);
  const res = await fetch(`/api/notifications?${params.toString()}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`list ${res.status}`);
  const body = (await res.json()) as ListResponse | UserNotification[];
  if (Array.isArray(body)) {
    return {
      notifications: body,
      total: body.length,
      limit: PAGE_SIZE,
      offset: args.offset,
      hasMore: false,
    };
  }
  return {
    ...body,
    notifications: body.notifications ?? body.items ?? [],
  };
}

async function fetchSystemBundled(opts: {
  includeArchived: boolean;
}): Promise<BundledSystemNotification[]> {
  const params = new URLSearchParams();
  params.set("limit", "100");
  if (opts.includeArchived) params.set("includeArchived", "1");
  const res = await fetch(`/api/notifications/system-bundled?${params.toString()}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`bundled ${res.status}`);
  const body = (await res.json()) as BundledResponse;
  return body.bundles ?? [];
}

const ADMIN_ROLES = new Set(["ceo", "team_lead", "admin", "superadmin"]);

export default function Notifications() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth() as { user?: { role?: string | null } | null };
  const isAdmin = !!user?.role && ADMIN_ROLES.has(String(user.role));

  const [bucket, setBucket] = useState<BucketTab>("personal");
  const [filter, setFilter] = useState<Filter>("unread");
  const [category, setCategory] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  // Reset offset whenever the bucket, filter, or category changes.
  useEffect(() => {
    setOffset(0);
  }, [bucket, filter, category]);

  // System bundled view: show unread by default (archived = only when filter=archived)
  const systemIncludeArchived = filter === "archived";

  const personalQueryKey = useMemo(
    () => ["/api/notifications", { bucket: "personal", filter, category, offset }] as const,
    [filter, category, offset],
  );
  const systemBundledQueryKey = useMemo(
    () => ["/api/notifications/system-bundled", { includeArchived: systemIncludeArchived }] as const,
    [systemIncludeArchived],
  );

  const {
    data: personalData,
    isLoading: personalLoading,
    isError: personalError,
  } = useQuery({
    queryKey: personalQueryKey,
    queryFn: () => fetchPage({ bucket: "personal", filter, category, offset }),
    refetchOnWindowFocus: true,
    staleTime: 15_000,
    enabled: bucket === "personal",
  });

  const {
    data: systemBundles = [],
    isLoading: systemLoading,
    isError: systemError,
  } = useQuery({
    queryKey: systemBundledQueryKey,
    queryFn: () => fetchSystemBundled({ includeArchived: systemIncludeArchived }),
    refetchOnWindowFocus: true,
    staleTime: 15_000,
    enabled: bucket === "system",
  });

  const rows = useMemo(() => personalData?.notifications ?? [], [personalData?.notifications]);
  const total = personalData?.total ?? 0;
  const hasMore = personalData?.hasMore ?? false;

  // Filter system bundles for unread-only view
  const filteredBundles = useMemo(() => {
    if (filter === "unread") return systemBundles.filter((b) => b.hasUnread);
    return systemBundles;
  }, [systemBundles, filter]);

  // SSE — mirror the bell so multi-tab actions reflect here too.
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    let openedAt = 0;
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/notifications/system-bundled"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_KEY }); // fire-and-forget: cache refresh only
    };
    const connect = () => {
      if (cancelled) return;
      openedAt = Date.now();
      es = new EventSource("/api/notifications/events", { withCredentials: true });
      const handler = () => invalidate();
      es.addEventListener("notification:new", handler);
      es.addEventListener("notification:read", handler);
      es.addEventListener("notification:unread", handler);
      es.addEventListener("notification:archived", handler);
      es.addEventListener("notification:count_updated", handler);
      es.onerror = () => {
        es?.close();
        es = null;
        if (cancelled) return;
        const next = nextSseReconnectState(
          consecutiveFailures,
          Date.now() - openedAt,
        );
        consecutiveFailures = next.consecutiveFailures;
        reconnectTimer = setTimeout(connect, next.delayMs);
      };
    };
    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [queryClient]);

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/notifications/system-bundled"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_KEY }); // fire-and-forget: cache refresh only
  };

  const markRead = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, {
        method: "PATCH",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`markRead ${res.status}`);
    },
    onSuccess: invalidateAll,
  });

  const markUnread = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/notifications/${encodeURIComponent(id)}/unread`, {
        method: "PATCH",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`markUnread ${res.status}`);
    },
    onSuccess: invalidateAll,
  });

  const markAllRead = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/notifications/mark-all-read", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucket }),
      });
      if (!res.ok) throw new Error(`markAllRead ${res.status}`);
    },
    onSuccess: invalidateAll,
  });

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
    onSuccess: invalidateAll,
  });

  const archive = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/notifications/${encodeURIComponent(id)}/archive`,
        {
          method: "PATCH",
          credentials: "include",
        },
      );
      if (!res.ok) throw new Error(`archive ${res.status}`);
    },
    onSuccess: invalidateAll,
  });

  const sendTest = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/notifications/test", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "system",
          title: "Test notification",
          body: "Pipeline verification — fired from the inbox page.",
          deepLink: "/notifications",
        }),
      });
      if (!res.ok) {
        if (res.status === 403)
          throw new Error("You do not have permission to send test notifications.");
        throw new Error(`test ${res.status}`);
      }
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Test notification sent", description: "Check your bell." });
    },
    onError: (err: any) => {
      toast({
        title: "Test failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const hasUnread = useMemo(() => rows.some((r) => !r.readAt), [rows]);
  const hasSystemUnread = useMemo(() => systemBundles.some((b) => b.hasUnread), [systemBundles]);
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const isLoading = bucket === "personal" ? personalLoading : systemLoading;
  const isError = bucket === "personal" ? personalError : systemError;

  const activeCategories = bucket === "personal" ? PERSONAL_CATEGORIES : SYSTEM_CATEGORIES;

  return (
    <div className="container mx-auto px-4 py-6 max-w-3xl" data-testid="page-notifications">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-heading">
              <Bell className="w-5 h-5" />
              Notifications
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={() => markAllRead.mutate()}
                disabled={
                  markAllRead.isPending ||
                  (bucket === "personal" ? !hasUnread : !hasSystemUnread)
                }
                data-testid="button-mark-all-read"
              >
                <Check className="w-4 h-4 mr-1" />
                Mark all read
              </Button>
              {isAdmin && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sendTest.mutate()}
                  disabled={sendTest.isPending}
                  data-testid="button-send-test-notification"
                >
                  <Send className="w-4 h-4 mr-1" />
                  Send test notification
                </Button>
              )}
            </div>
          </div>

          {/* Bucket tabs */}
          <div className="flex gap-0 border-b">
            <button
              type="button"
              onClick={() => setBucket("personal")}
              className={`text-body px-4 py-2 border-b-2 font-medium transition-colors ${
                bucket === "personal"
                  ? "border-primary-ink text-primary-ink"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              data-testid="tab-bucket-personal"
              data-active={bucket === "personal" ? "true" : undefined}
            >
              For you
            </button>
            <button
              type="button"
              onClick={() => setBucket("system")}
              className={`text-body px-4 py-2 border-b-2 font-medium transition-colors flex items-center gap-1.5 ${
                bucket === "system"
                  ? "border-primary-ink text-primary-ink"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              data-testid="tab-bucket-system"
              data-active={bucket === "system" ? "true" : undefined}
            >
              <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
              System
            </button>
          </div>

          {/* Filter pills and category select */}
          <div className="flex flex-wrap items-center gap-2">
            <FilterPill active={filter === "unread"} onClick={() => setFilter("unread")} testId="filter-unread">
              Unread
            </FilterPill>
            <FilterPill active={filter === "all"} onClick={() => setFilter("all")} testId="filter-all">
              All
            </FilterPill>
            <FilterPill active={filter === "archived"} onClick={() => setFilter("archived")} testId="filter-archived">
              Archived
            </FilterPill>
            {bucket === "personal" && (
              <div className="ml-2 min-w-[180px]">
                <Select
                  value={category ?? "__all__"}
                  onValueChange={(v) => setCategory(v === "__all__" ? null : v)}
                >
                  <SelectTrigger className="h-8 text-caption" data-testid="select-category">
                    <SelectValue placeholder="All categories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__" data-testid="category-option-all">
                      All categories
                    </SelectItem>
                    {activeCategories.map((c) => (
                      <SelectItem key={c} value={c} data-testid={`category-option-${c}`}>
                        {notificationTypeMeta(c).label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-body text-muted-foreground py-8 text-center" data-testid="text-loading">
              Loading…
            </div>
          ) : isError ? (
            <div className="text-body text-status-critical py-8 text-center" data-testid="text-error">
              Failed to load notifications. Try refreshing.
            </div>
          ) : bucket === "system" ? (
            /* ── System bucket: bundled view ── */
            filteredBundles.length === 0 ? (
              <EmptyState
                testId="text-empty"
                icon={<AlertTriangle />}
                title={
                  filter === "archived"
                    ? "No archived system alerts"
                    : filter === "unread"
                      ? "No unread system alerts"
                      : "No system alerts"
                }
                description={
                  filter === "archived"
                    ? "System alerts you archive are kept here."
                    : "Operational alerts land here, bundled by type, when the system needs attention."
                }
              />
            ) : (
              <ul className="-mx-4 divide-y divide-border" data-testid="list-system-notifications">
                {filteredBundles.map((b, i) => (
                  <NotificationRow
                    key={`${b.notificationId ?? b.title}-${i}`}
                    variant="full"
                    category={b.category}
                    title={b.title}
                    body={b.body}
                    timestamp={b.latestAt}
                    unread={b.hasUnread}
                    unreadTone="warn"
                    count={b.count}
                    clientName={b.clientName}
                    deepLink={b.deepLink}
                    onDeepLinkClick={() => {
                      if (b.hasUnread) markBundleRead.mutate(b.ids);
                    }}
                    testIds={{
                      root: `system-bundle-item-${i}`,
                      icon: `icon-bundle-type-${i}`,
                      deepLink: `link-deeplink-bundle-${i}`,
                      dot: `dot-unread-bundle-${i}`,
                      count: `bundle-count-${i}`,
                      body: `text-body-bundle-${i}`,
                      meta: `meta-bundle-${i}`,
                    }}
                    actions={
                      b.hasUnread && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Mark read"
                          onClick={() => markBundleRead.mutate(b.ids)}
                          disabled={markBundleRead.isPending}
                          data-testid={`button-mark-bundle-read-${i}`}
                        >
                          <Check className="w-4 h-4" />
                        </Button>
                      )
                    }
                  />
                ))}
              </ul>
            )
          ) : /* ── Personal bucket: individual rows ── */
          rows.length === 0 ? (
            <EmptyState
              testId="text-empty"
              icon={<Inbox />}
              title={
                category
                  ? `No ${categoryEmptyLabel(category)} notifications`
                  : filter === "archived"
                    ? "No archived notifications"
                    : filter === "unread"
                      ? "You're all caught up"
                      : "No notifications yet"
              }
              description={
                filter === "archived"
                  ? "Notifications you archive are kept here."
                  : "Mentions, assignments, bookings, and comms alerts for you land here as they happen."
              }
            />
          ) : (
            <ul className="-mx-4 divide-y divide-border" data-testid="list-notifications">
              {rows.map((n) => (
                <NotificationRow
                  key={n.id}
                  variant="full"
                  category={n.category}
                  title={n.title}
                  body={n.body}
                  timestamp={n.createdAt}
                  unread={!n.readAt}
                  unreadTone="primary"
                  clientName={n.clientName}
                  clientHref={notificationClientHref(n.metadata)}
                  deepLink={n.deepLink}
                  onDeepLinkClick={() => {
                    if (!n.readAt) markRead.mutate(n.id);
                  }}
                  archived={!!n.archivedAt}
                  testIds={{
                    root: `notification-item-${n.id}`,
                    icon: `icon-notification-type-${n.id}`,
                    title: `text-title-${n.id}`,
                    deepLink: `link-deeplink-${n.id}`,
                    dot: `dot-unread-${n.id}`,
                    body: `text-body-${n.id}`,
                    meta: `text-meta-${n.id}`,
                    client: `text-client-${n.id}`,
                  }}
                  actions={
                    <>
                      {!n.readAt ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Mark read"
                          onClick={() => markRead.mutate(n.id)}
                          disabled={markRead.isPending}
                          data-testid={`button-mark-read-${n.id}`}
                        >
                          <Check className="w-4 h-4" />
                        </Button>
                      ) : !n.archivedAt ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Mark unread"
                          onClick={() => markUnread.mutate(n.id)}
                          disabled={markUnread.isPending}
                          data-testid={`button-mark-unread-${n.id}`}
                        >
                          <RotateCcw className="w-4 h-4" />
                        </Button>
                      ) : null}
                      {!n.archivedAt && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Archive"
                          onClick={() => archive.mutate(n.id)}
                          disabled={archive.isPending}
                          data-testid={`button-archive-${n.id}`}
                        >
                          <ArchiveIcon className="w-4 h-4" />
                        </Button>
                      )}
                    </>
                  }
                />
              ))}
            </ul>
          )}

          {/* Pagination — only for personal bucket */}
          {bucket === "personal" && total > PAGE_SIZE && (
            <div
              className="flex items-center justify-between pt-4 mt-2 border-t border-border text-caption text-muted-foreground"
              data-testid="pagination-controls"
            >
              <div data-testid="text-pagination-summary">
                Page {page} of {totalPages} · {total} total
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  data-testid="button-page-prev"
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!hasMore}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  data-testid="button-page-next"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Lowercased category label for empty-state copy; acronym labels (SMS, CRM) stay uppercase. */
function categoryEmptyLabel(category: string): string {
  const label = notificationTypeMeta(category).label;
  return /^[A-Z]{2,}$/.test(label) ? label : label.toLowerCase();
}

function FilterPill({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-caption font-medium px-2.5 py-1 rounded-pill border transition-colors ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-foreground/30"
      }`}
      data-testid={`button-${testId}`}
      data-active={active ? "true" : undefined}
    >
      {children}
    </button>
  );
}
