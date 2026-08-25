/**
 * Rate Limits admin page — COMPOSITION ROOT (thin aggregator).
 *
 * This file was a 5,898-line monolith — the 4th-largest client file and a
 * whole-file merge-conflict hotspot. It was split per the house aggregator
 * pattern (F11C / Task #4159, cf. ClickUpModule / Task #3787): every
 * section now lives in a per-responsibility module under
 * client/src/pages/adminRateLimit/ (shared, timeSeries, breakdowns,
 * blockedEventHistory, warningPercents, notifyConfig, retention,
 * deliveryOps, notificationHistory), and this file keeps only the page
 * state + section composition: tab/expand/deep-link state, the dashboard
 * queries (alerts / by-user / summary / digest pill + growth banner) and
 * the admin role gate.
 *
 * Do NOT add section/feature code here — put it in the matching
 * client/src/pages/adminRateLimit/ module (or a new sibling module) and
 * compose it below. Behavior contract: F0 baseline
 * audits/program-baseline-2026-08/frontend-manifest.json (RateLimitUsers).
 */

import { useAuth } from "@/hooks/use-auth";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { usePageTitle } from "@/hooks/use-page-title";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/admin/PageHeader";
import { ShieldAlert, Users, Globe, Clock, AlertTriangle, BellRing, X, History, ArrowRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { ResetSavedViewButton } from "@/components/ResetSavedViewButton";
import { useToast } from "@/hooks/use-toast";
import { type ByUserResponse, type RateLimitSummary, type UsageAlert, type DbUser, formatDigestCountdown, scrollToNotifyConfigCard, getCategoryColor, formatTime, getUserDisplayName, type TabType } from "@/pages/adminRateLimit/shared";
import { UserBreakdown, AnonymousBreakdown, CategoryOverview } from "@/pages/adminRateLimit/breakdowns";
import { BlockedEventHistory } from "@/pages/adminRateLimit/blockedEventHistory";
import { WarningPercentsEditor } from "@/pages/adminRateLimit/warningPercents";
import { NotifyConfigEditor } from "@/pages/adminRateLimit/notifyConfig";
import { PendingDigestRetentionEditor } from "@/pages/adminRateLimit/retention";
import { type DigestGrowthInfo, DeliveryOpsPanel } from "@/pages/adminRateLimit/deliveryOps";
import { NotificationHistoryPanel } from "@/pages/adminRateLimit/notificationHistory";

export default function RateLimitUsers() {
  const { user, isLoading: authLoading } = useAuth();
  usePageTitle("Rate Limit — Per-User Tracking");
  const validTab = (v: unknown): v is TabType =>
    v === "users" || v === "anonymous" || v === "overview" || v === "history";
  const persistKey = user?.id ? `admin.rateLimitUsers.${user.id}` : null;
  const [activeTab, setActiveTab] = usePersistentState<TabType>(
    persistKey ? `${persistKey}.activeTab` : null,
    "users",
    validTab,
  );
  const isNullableString = (v: unknown): v is string | null =>
    v === null || typeof v === "string";
  const [expandedUser, setExpandedUser] = usePersistentState<string | null>(
    persistKey ? `${persistKey}.expandedUser` : null,
    null,
    isNullableString,
  );
  const [expandedIp, setExpandedIp] = usePersistentState<string | null>(
    persistKey ? `${persistKey}.expandedIp` : null,
    null,
    isNullableString,
  );
  const [scrollTarget, setScrollTarget] = useState<{ kind: "user" | "ip"; key: string; nonce: number } | null>(null);
  const { toast: scrollToast } = useToast();
  const persistedViewKeys = useMemo(
    () =>
      persistKey
        ? [
            `${persistKey}.activeTab`,
            `${persistKey}.expandedUser`,
            `${persistKey}.expandedIp`,
          ]
        : [],
    [persistKey],
  );
  const persistedViewPrefixes = useMemo(
    () =>
      user?.id
        ? [
            `admin.rateLimitTimeSeries.${user.id}.`,
            `admin.rateLimitNotifHistory.${user.id}.`,
          ]
        : [],
    [user?.id],
  );
  const handleResetSavedView = () => {
    setActiveTab("users");
    setExpandedUser(null);
    setExpandedIp(null);
  };
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!scrollTarget) return;
    const id =
      scrollTarget.kind === "user"
        ? `rl-user-anchor-${scrollTarget.key}`
        : `rl-ip-anchor-${scrollTarget.key}`;
    let removeTimer: ReturnType<typeof setTimeout> | null = null;
    const tryScroll = (attempt: number) => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
        el.classList.remove("rl-flash-highlight");
        // force reflow so re-adding the class re-triggers the animation
        void (el as HTMLElement).offsetWidth;
        el.classList.add("rl-flash-highlight");
        removeTimer = setTimeout(() => {
          el.classList.remove("rl-flash-highlight");
        }, 1600);
        return;
      }
      if (attempt < 10) {
        setTimeout(() => tryScroll(attempt + 1), 60);
        return;
      }
      const label =
        scrollTarget.kind === "user"
          ? `user ${scrollTarget.key}`
          : `IP ${scrollTarget.key}`;
      scrollToast({
        title: "No active aggregate found",
        description: `No active aggregate for ${label} — showing tab anyway. The user/IP may have aged out of current blocked-event aggregates.`,
      });
    };
    tryScroll(0);
    return () => {
      if (removeTimer) clearTimeout(removeTimer);
    };
  }, [scrollTarget, scrollToast]);

  const jumpToUser = (userId: string) => {
    setExpandedUser(userId);
    setActiveTab("users");
    setScrollTarget({ kind: "user", key: userId, nonce: Date.now() });
  };
  const jumpToIp = (ip: string) => {
    setExpandedIp(ip);
    setActiveTab("anonymous");
    setScrollTarget({ kind: "ip", key: ip, nonce: Date.now() });
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab");
    const userIdParam = params.get("userId");
    const ipParam = params.get("ip");
    let consumed = false;
    if (userIdParam) {
      jumpToUser(userIdParam);
      consumed = true;
    } else if (ipParam) {
      jumpToIp(ipParam);
      consumed = true;
    } else if (tabParam && validTab(tabParam)) {
      setActiveTab(tabParam);
      consumed = true;
    }
    if (consumed) {
      params.delete("tab");
      params.delete("userId");
      params.delete("ip");
      const remaining = params.toString();
      const next =
        window.location.pathname + (remaining ? `?${remaining}` : "") + window.location.hash;
      window.history.replaceState({}, "", next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const isTabVisible = useTabVisibility();

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState !== "hidden") {
        void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/alerts"] }); // fire-and-forget: cache refresh only
        void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/by-user"] }); // fire-and-forget: cache refresh only
        void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits"] }); // fire-and-forget: cache refresh only
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [queryClient]);

  const { data: alertsData } = useQuery<{ alerts: UsageAlert[] }>({
    queryKey: ["/api/health/rate-limits/alerts"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits/alerts", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch alerts");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
    refetchInterval: isTabVisible ? 15000 : false,
    refetchIntervalInBackground: false,
  });

  const clearAlertsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/health/rate-limits/alerts/clear", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to clear alerts");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/alerts"] }); // fire-and-forget: cache refresh only
    },
  });

  const BY_USER_POLL_MS = 30000;
  const { data: byUserData, isLoading: byUserLoading, dataUpdatedAt: byUserUpdatedAt } = useQuery<ByUserResponse>({
    queryKey: ["/api/health/rate-limits/by-user"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits/by-user", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch per-user rate limits");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
    refetchInterval: isTabVisible ? BY_USER_POLL_MS : false,
    refetchIntervalInBackground: false,
  });

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secondsSinceUpdate = byUserUpdatedAt ? Math.max(0, Math.floor((nowMs - byUserUpdatedAt) / 1000)) : null;
  const secondsUntilRefresh = byUserUpdatedAt && isTabVisible
    ? Math.max(0, Math.ceil((byUserUpdatedAt + BY_USER_POLL_MS - nowMs) / 1000))
    : null;

  const { data: summaryData } = useQuery<RateLimitSummary>({
    queryKey: ["/api/health/rate-limits"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch rate limit summary");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
    refetchInterval: isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });

  const isDashDigestEnabled = !!user && (user.role === "team_lead" || user.role === "ceo");
  const { data: dashDigestStatus } = useQuery<{
    pending: number;
    lastFlushAt: number | null;
    cadence: "realtime" | "hourly" | "daily";
    intervalMs: number;
    nextFlushAt: number | null;
  }>({
    queryKey: ["/api/health/rate-limits/digest-status"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits/digest-status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch digest status");
      return res.json();
    },
    enabled: isDashDigestEnabled,
    refetchInterval: isDashDigestEnabled && isTabVisible ? 15000 : false,
    refetchIntervalInBackground: false,
  });
  const { data: dashDigestGrowth } = useQuery<DigestGrowthInfo>({
    queryKey: ["/api/health/rate-limits/digest-growth"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits/digest-growth", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch digest growth info");
      return res.json();
    },
    enabled: isDashDigestEnabled,
    refetchInterval: isDashDigestEnabled && isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });
  const isDashDigestActive =
    dashDigestStatus?.cadence === "hourly" || dashDigestStatus?.cadence === "daily";
  const [digestTickNow, setDigestTickNow] = useState(Date.now());
  useEffect(() => {
    if (!isDashDigestActive) return;
    const id = setInterval(() => setDigestTickNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isDashDigestActive]);

  const { data: allUsers } = useQuery<DbUser[]>({
    queryKey: ["/api/users"],
    queryFn: async () => {
      const res = await fetch("/api/users", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
  });

  useEffect(() => {
    if (!byUserData || expandedUser === null) return;
    const stillExists = byUserData.users.some((u) => u.userId === expandedUser);
    if (!stillExists) setExpandedUser(null);
  }, [byUserData, expandedUser, setExpandedUser]);

  if (authLoading) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <div className="animate-pulse text-foreground">Loading...</div>
      </div>
    );
  }

  if (!user || (user.role !== "team_lead" && user.role !== "ceo")) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <div className="text-foreground" data-testid="text-access-denied">Access denied. Team Lead or CEO access required.</div>
      </div>
    );
  }

  const users = byUserData?.users || [];
  const anonymous = byUserData?.anonymous || [];
  const dbUsers = allUsers || [];
  const totalUserBlocked = users.reduce((sum, u) => sum + u.totalBlocked, 0);
  const totalAnonBlocked = anonymous.reduce((sum, a) => sum + a.totalBlocked, 0);
  const totalBlocked = summaryData?.totalBlocked || 0;
  const alerts = alertsData?.alerts || [];
  const alertsByUser = new Map<string, UsageAlert[]>();
  for (const a of alerts) {
    const arr = alertsByUser.get(a.userId) || [];
    arr.push(a);
    alertsByUser.set(a.userId, arr);
  }

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      <main className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
        {/* Task #4355 — burgundy band → shared PageHeader (audit §6.1-B / P1-4). */}
        <PageHeader
          title="Rate Limits — Per-User Tracking"
          backHref="/"
          actions={
            <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-4">
              {secondsSinceUpdate !== null && (
                <span className="text-xs text-muted-foreground hidden sm:inline" data-testid="text-last-updated">
                  Updated {secondsSinceUpdate}s ago
                  {isTabVisible
                    ? secondsUntilRefresh !== null && ` · next in ${secondsUntilRefresh}s`
                    : " · paused (tab hidden)"}
                </span>
              )}
              <ResetSavedViewButton
                storageKeys={persistedViewKeys}
                storagePrefixes={persistedViewPrefixes}
                onReset={handleResetSavedView}
                testId="button-reset-saved-view-rate-limits"
              />
            </div>
          }
        />
        {dashDigestGrowth &&
          (dashDigestGrowth.triggered ||
            (dashDigestGrowth.overdue && dashDigestGrowth.pending > 0)) && (
          <Card
            className="border-amber-300 bg-amber-50"
            data-testid="banner-digest-growth-warning"
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1">
                  <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div
                      className="font-semibold text-amber-900 mb-1"
                      data-testid="text-digest-growth-warning-title"
                    >
                      {dashDigestGrowth.triggered
                        ? `Digest queue is backing up — ${dashDigestGrowth.pending} pending (threshold ${dashDigestGrowth.config.warnAt})`
                        : `Digest flush is overdue — last flush ${
                            dashDigestGrowth.lastFlushAt
                              ? formatTime(dashDigestGrowth.lastFlushAt)
                              : "never recorded"
                          }${
                            dashDigestGrowth.overdueByMs != null
                              ? ` (${Math.round(
                                  dashDigestGrowth.overdueByMs / 60_000,
                                )} min past expected)`
                              : ""
                          }, ${dashDigestGrowth.pending} pending`}
                    </div>
                    <div
                      className="text-xs text-amber-800"
                      data-testid="text-digest-growth-warning-detail"
                    >
                      {dashDigestGrowth.triggered
                        ? "Either the digest cadence isn't keeping up, the destination is failing, or there's a flood of new warnings."
                        : "The destination may be failing or the scheduler may be stuck — try flushing the digest now to see the error."}
                      {dashDigestGrowth.state.lastWarningAt ? (
                        <>
                          {" "}
                          Last operator warning sent{" "}
                          {formatTime(dashDigestGrowth.state.lastWarningAt)} (
                          {dashDigestGrowth.state.lastWarningStatus ?? "—"}
                          {dashDigestGrowth.state.lastWarningReason
                            ? ` · ${dashDigestGrowth.state.lastWarningReason}`
                            : ""}
                          ).
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={scrollToNotifyConfigCard}
                  data-testid="button-digest-growth-warning-open"
                  className="text-amber-900 border-amber-300 hover:bg-amber-100"
                >
                  Open settings
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
        {isDashDigestActive && dashDigestStatus && (
          <button
            type="button"
            onClick={scrollToNotifyConfigCard}
            data-testid="pill-digest-status"
            title="Open Warning Notifications to send the digest now"
            className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-card px-3 py-1.5 text-xs text-primary-ink hover:border-primary/50 hover:bg-primary/5 transition-colors"
          >
            <Clock className="w-3.5 h-3.5" />
            {dashDigestStatus.nextFlushAt ? (
              <span data-testid="text-pill-digest-next">
                Next digest in{" "}
                <span className="font-semibold">
                  {formatDigestCountdown(dashDigestStatus.nextFlushAt - digestTickNow)}
                </span>
              </span>
            ) : (
              <span data-testid="text-pill-digest-next">Next digest not yet scheduled</span>
            )}
            <span className="text-primary/40">·</span>
            <span data-testid="text-pill-digest-pending">
              <span className="font-semibold">{dashDigestStatus.pending}</span>{" "}
              queued
            </span>
            <ArrowRight className="w-3 h-3 opacity-60" />
          </button>
        )}

        {alerts.length > 0 && (
          <Card className="border-orange-300 bg-orange-50" data-testid="alert-banner-warnings">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1">
                  <BellRing className="w-5 h-5 text-orange-600 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="font-semibold text-orange-900 mb-2" data-testid="text-alert-count">
                      {alerts.length} active rate-limit warning{alerts.length === 1 ? "" : "s"}
                    </div>
                    <div className="space-y-1.5">
                      {alerts.slice(0, 5).map((a) => {
                        const pct = Math.round((a.count / a.max) * 100);
                        return (
                          <div
                            key={`${a.userId}:${a.category}`}
                            className="text-sm text-orange-900"
                            data-testid={`alert-row-${a.userId}-${a.category}`}
                          >
                            <span className="font-medium">{getUserDisplayName(a.userId, dbUsers)}</span>{" "}
                            on <Badge className={`${getCategoryColor(a.category)} text-xs`}>{a.category}</Badge>{" "}
                            <span className="font-mono">{a.count}/{a.max}</span>{" "}
                            <span className="text-orange-700">({pct}%, threshold {a.warningPercent}%)</span>{" "}
                            <span className="text-orange-600 text-xs">— since {formatTime(a.triggeredAt)}</span>
                          </div>
                        );
                      })}
                      {alerts.length > 5 && (
                        <div className="text-xs text-orange-700">…and {alerts.length - 5} more</div>
                      )}
                    </div>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => clearAlertsMutation.mutate()}
                  disabled={clearAlertsMutation.isPending}
                  data-testid="button-clear-alerts"
                  className="text-orange-900 border-orange-300 hover:bg-orange-100"
                >
                  <X className="w-4 h-4 mr-1" />
                  Clear
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card data-testid="card-stat-total-blocked">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <ShieldAlert className="w-4 h-4" />
                Total Blocked
              </div>
              <div className="text-2xl font-bold text-foreground">{totalBlocked}</div>
            </CardContent>
          </Card>
          <Card data-testid="card-stat-user-blocked">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Users className="w-4 h-4" />
                User Blocked
              </div>
              <div className="text-2xl font-bold text-foreground">{totalUserBlocked}</div>
              <div className="text-xs text-muted-foreground">{users.length} unique users</div>
            </CardContent>
          </Card>
          <Card data-testid="card-stat-anon-blocked">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Globe className="w-4 h-4" />
                Anonymous Blocked
              </div>
              <div className="text-2xl font-bold text-foreground">{totalAnonBlocked}</div>
              <div className="text-xs text-muted-foreground">{anonymous.length} unique IPs</div>
            </CardContent>
          </Card>
          <Card data-testid="card-stat-since">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <Clock className="w-4 h-4" />
                Tracking Since
              </div>
              <div className="text-sm font-medium text-foreground">
                {summaryData?.collectedSince ? formatTime(summaryData.collectedSince) : "No events yet"}
              </div>
            </CardContent>
          </Card>
        </div>

        <WarningPercentsEditor />

        <NotifyConfigEditor />

        <DeliveryOpsPanel />

        <NotificationHistoryPanel dbUsers={dbUsers} />
        <PendingDigestRetentionEditor />

        <div className="flex gap-2 border-b border-primary/20 pb-0">
          {(["users", "anonymous", "overview", "history"] as TabType[]).map((tab) => (
            <button
              key={tab}
              data-testid={`tab-${tab}`}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-primary-ink text-primary-ink"
                  : "border-transparent text-muted-foreground hover:text-primary-ink"
              }`}
            >
              {tab === "users"
                ? `By User (${users.length})`
                : tab === "anonymous"
                ? `By IP (${anonymous.length})`
                : tab === "overview"
                ? "Category Overview"
                : "Blocked Event History"}
            </button>
          ))}
        </div>

        {byUserLoading ? (
          <div className="text-center py-12 text-muted-foreground">Loading rate limit data...</div>
        ) : activeTab === "users" ? (
          <UserBreakdown
            users={users}
            dbUsers={dbUsers}
            alertsByUser={alertsByUser}
            expandedUser={expandedUser}
            setExpandedUser={setExpandedUser}
          />
        ) : activeTab === "anonymous" ? (
          <AnonymousBreakdown
            anonymous={anonymous}
            expandedIp={expandedIp}
            setExpandedIp={setExpandedIp}
          />
        ) : activeTab === "overview" ? (
          <CategoryOverview summary={summaryData} dbUsers={dbUsers} />
        ) : (
          <BlockedEventHistory
            dbUsers={dbUsers}
            summary={summaryData}
            onJumpToUser={jumpToUser}
            onJumpToIp={jumpToIp}
          />
        )}
      </main>
    </div>
  );
}


export { BlockedEventHistory } from "@/pages/adminRateLimit/blockedEventHistory";
