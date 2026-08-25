import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OsTable } from "@/components/ui/os-table";
import { Link } from "wouter";
import { ArrowLeft, AlertTriangle, Search, RefreshCw } from "lucide-react";

type LimiterConfig = {
  windowMs: number;
  max: number;
  roleAware: boolean;
  category: string;
};

type RouteRow = {
  method: string;
  path: string;
  file: string;
  line: number;
  protection: string;
  limiters: string[];
  notes: string[];
};

type Response = {
  total: number;
  routes: RouteRow[];
  limiterConfigs: Record<string, LimiterConfig>;
  summary: { byLimiter: Record<string, number>; unprotectedCount: number };
  generatedAt?: string;
  expiresAt?: string;
  cacheTtlMs?: number;
  cached?: boolean;
};

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ${diffSec % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

const LIMITER_COLORS: Record<string, string> = {
  apiLimiter: "bg-muted text-foreground",
  authLimiter: "bg-indigo-100 text-indigo-700",
  webhookLimiter: "bg-purple-100 text-purple-700",
  writeLimiter: "bg-blue-100 text-blue-700",
  uploadLimiter: "bg-amber-100 text-amber-700",
  adminLimiter: "bg-red-100 text-red-700",
  sensitiveWriteLimiter: "bg-rose-100 text-rose-700",
  aiLimiter: "bg-emerald-100 text-emerald-700",
};

function formatWindow(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

export function RouteCoverageSection() {
  const { user, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showOnlyUnprotected, setShowOnlyUnprotected] = useState(false);
  const [limiterFilter, setLimiterFilter] = useState<string>("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [, setNowTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const { data, isLoading, error } = useQuery<Response>({
    queryKey: ["/api/admin/route-limiters"],
    queryFn: async () => {
      const res = await fetch("/api/admin/route-limiters", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!user && (user.role === "ceo" || user.role === "team_lead"),
  });

  const handleRefreshNow = async () => {
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch("/api/admin/route-limiters?refresh=1", { credentials: "include" });
      if (!res.ok) {
        throw new Error(`Refresh failed (${res.status})`);
      }
      const fresh = await res.json();
      queryClient.setQueryData(["/api/admin/route-limiters"], fresh);
    } catch (err: any) {
      setRefreshError(err?.message || "Failed to refresh");
    } finally {
      setIsRefreshing(false);
    }
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.routes.filter((r) => {
      if (showOnlyUnprotected && r.limiters.length > 0) return false;
      if (limiterFilter && !r.limiters.includes(limiterFilter)) return false;
      if (q && !r.path.toLowerCase().includes(q) && !r.method.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, search, showOnlyUnprotected, limiterFilter]);

  if (authLoading) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-bold text-red-600" data-testid="text-access-denied">Access Denied</h1>
        <p className="text-muted-foreground">Admin access required</p>
        <Link href="/">
          <Button variant="outline" data-testid="button-back-dashboard">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to Dashboard
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div data-testid="section-route-coverage">
      <div>
        <p className="text-muted-foreground mb-6" data-testid="text-description">
          Every API route and the rate limiter categories that apply to it. Routes with no coverage
          are highlighted so you can decide whether to protect them.
        </p>

        {isLoading && (
          <div className="flex items-center justify-center py-12" data-testid="status-loading">
            <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700" data-testid="status-error">
            Failed to load route limiter data.
          </div>
        )}

        {data && (
          <div className="space-y-4">
            <div className="bg-card rounded-lg border shadow-sm p-4">
              <h2 className="text-sm font-semibold text-foreground mb-3">Limiter Configurations</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {Object.entries(data.limiterConfigs).map(([name, cfg]) => (
                  <button
                    key={name}
                    onClick={() => setLimiterFilter(limiterFilter === name ? "" : name)}
                    className={`text-left rounded-lg border p-3 hover-elevate active-elevate-2 ${
                      limiterFilter === name ? "ring-2 ring-primary" : ""
                    }`}
                    data-testid={`card-limiter-${name}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs px-2 py-0.5 rounded ${LIMITER_COLORS[name] || "bg-muted text-foreground"}`}>
                        {name}
                      </span>
                    </div>
                    <div className="text-sm text-foreground" data-testid={`text-limiter-config-${name}`}>
                      {cfg.max} per {formatWindow(cfg.windowMs)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {data.summary.byLimiter[name] || 0} routes
                      {cfg.roleAware ? " · role-aware" : ""}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-card rounded-lg border shadow-sm p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[240px]">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search by path or method..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9"
                    data-testid="input-search"
                  />
                </div>
                <Button
                  variant={showOnlyUnprotected ? "default" : "outline"}
                  size="sm"
                  onClick={() => setShowOnlyUnprotected((v) => !v)}
                  data-testid="button-toggle-unprotected"
                >
                  <AlertTriangle className="w-4 h-4 mr-2" />
                  Unprotected only ({data.summary.unprotectedCount})
                </Button>
                {limiterFilter && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setLimiterFilter("")}
                    data-testid="button-clear-limiter-filter"
                  >
                    Clear "{limiterFilter}" filter
                  </Button>
                )}
                <div className="flex items-center gap-3 ml-auto">
                  <div className="text-sm text-muted-foreground" data-testid="text-result-count">
                    {filtered.length} of {data.total} routes
                  </div>
                  {data.generatedAt && (
                    <div
                      className="text-xs text-muted-foreground hidden sm:block"
                      title={`Snapshot generated at ${new Date(data.generatedAt).toLocaleString()}${
                        data.cacheTtlMs ? ` · cached for ${Math.round(data.cacheTtlMs / 1000)}s` : ""
                      }`}
                      data-testid="text-last-refreshed"
                    >
                      Last refreshed: {formatRelativeTime(data.generatedAt)}
                      {data.cacheTtlMs ? ` (cache ${Math.round(data.cacheTtlMs / 1000)}s)` : ""}
                    </div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefreshNow}
                    disabled={isRefreshing}
                    data-testid="button-refresh-now"
                  >
                    <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
                    {isRefreshing ? "Refreshing..." : "Refresh now"}
                  </Button>
                </div>
              </div>
              {refreshError && (
                <div className="mt-2 text-xs text-red-600" data-testid="text-refresh-error">
                  {refreshError}
                </div>
              )}
            </div>

            {/* Task #4348 — OsTable refit: ~600 route rows virtualize above
                the 100-row threshold with a sticky header instead of one
                unbounded flat table. Cell testids keep the legacy
                filtered-index scheme (`text-method-${i}` …). Virtualized
                rows are fixed-height/single-line, so limiter badges render
                in a nowrap strip and long paths x-scroll rather than wrap. */}
            <OsTable
              data-testid="table-route-limiters"
              rows={filtered}
              stickyFirstColumn={false}
              rowKey={(r, i) => `${r.method}-${r.path}-${i}`}
              rowClassName={(r) => (r.limiters.length === 0 ? "bg-amber-50" : undefined)}
              emptyState={
                <span data-testid="text-no-routes">No routes match the current filters.</span>
              }
              columns={[
                {
                  key: "method",
                  header: "Method",
                  width: 90,
                  cell: (r, i) => (
                    <span className="font-mono text-xs" data-testid={`text-method-${i}`}>
                      {r.method}
                    </span>
                  ),
                },
                {
                  key: "path",
                  header: "Path",
                  width: 360,
                  cell: (r, i) => (
                    <span className="font-mono text-xs" data-testid={`text-path-${i}`}>
                      {r.path}
                    </span>
                  ),
                },
                {
                  key: "protection",
                  header: "Protection",
                  width: 220,
                  cell: (r, i) => (
                    <span className="text-xs text-muted-foreground" data-testid={`text-protection-${i}`}>
                      {r.protection}
                    </span>
                  ),
                },
                {
                  key: "limiters",
                  header: "Rate Limiters",
                  width: 280,
                  cell: (r, i) =>
                    r.limiters.length === 0 ? (
                      <span
                        className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded"
                        data-testid={`text-limiters-${i}`}
                      >
                        <AlertTriangle className="w-3 h-3" /> No limiter
                      </span>
                    ) : (
                      <span className="inline-flex gap-1" data-testid={`text-limiters-${i}`}>
                        {r.limiters.map((l) => (
                          <span
                            key={l}
                            className={`text-xs px-2 py-0.5 rounded ${LIMITER_COLORS[l] || "bg-muted text-foreground"}`}
                            data-testid={`badge-limiter-${i}-${l}`}
                          >
                            {l}
                          </span>
                        ))}
                      </span>
                    ),
                },
                {
                  key: "file",
                  header: "File",
                  width: 300,
                  cell: (r, i) => (
                    <span className="font-mono text-[11px] text-muted-foreground" data-testid={`text-file-${i}`}>
                      {r.file}:{r.line}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}

