// Rate Limits admin — Blocked Event History tab — filterable, paginated event log with CSV export.
// Extracted VERBATIM from the former 5.9k-line RateLimitUsers.tsx monolith
// (house aggregator pattern, cf. ClickUpModule / Task #3787; this split:
// F11C / Task #4159). The page composition root is
// client/src/pages/admin/RateLimitUsers.tsx — new rate-limit admin UI
// belongs here (or in a new sibling module), never in the aggregator.

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, History, ExternalLink } from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import { type RateLimitSummary, type DbUser, CATEGORY_COLORS, getUserDisplayName } from "./shared";
import { fromLocalInput } from "./timeSeries";

type BlockedEventHistoryRow = {
  id: number;
  timestamp: number;
  category: string;
  method: string;
  path: string;
  ip: string;
  userId: string | null;
};

type BlockedEventHistoryResponse = {
  events: BlockedEventHistoryRow[];
  total: number;
  limit: number;
  offset: number;
};

const HISTORY_PAGE_SIZE = 50;
const CSV_EXPORT_CONFIRM_THRESHOLD = 50000;
const HISTORY_RANGE_PRESETS: { value: "all" | "1h" | "24h" | "7d" | "30d" | "custom"; label: string; ms: number | null }[] = [
  { value: "all", label: "All (30d)", ms: null },
  { value: "1h", label: "Last 1h", ms: 60 * 60 * 1000 },
  { value: "24h", label: "Last 24h", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "custom", label: "Custom", ms: null },
];

export function BlockedEventHistory({
  dbUsers,
  summary,
  onJumpToUser,
  onJumpToIp,
}: {
  dbUsers: DbUser[];
  summary: RateLimitSummary | undefined;
  onJumpToUser: (userId: string) => void;
  onJumpToIp: (ip: string) => void;
}) {
  const [userIdFilter, setUserIdFilter] = useState("");
  const [ipFilter, setIpFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [preset, setPreset] = useState<typeof HISTORY_RANGE_PRESETS[number]["value"]>("24h");
  const [customStart, setCustomStart] = useState<string>("");
  const [customEnd, setCustomEnd] = useState<string>("");
  const [page, setPage] = useState(0);
  const [csvConfirmOpen, setCsvConfirmOpen] = useState(false);

  const startCsvExport = () => {
    const params = new URLSearchParams();
    if (appliedFilters.userId) params.set("userId", appliedFilters.userId);
    if (appliedFilters.ip) params.set("ip", appliedFilters.ip);
    if (appliedFilters.category && appliedFilters.category !== "all") {
      params.set("category", appliedFilters.category);
    }
    if (appliedFilters.rangeStart !== null && appliedFilters.rangeEnd !== null) {
      params.set("rangeStart", String(appliedFilters.rangeStart));
      params.set("rangeEnd", String(appliedFilters.rangeEnd));
    }
    const href = `/api/health/rate-limits/events.csv?${params.toString()}`;
    window.location.href = href;
  };

  const [appliedFilters, setAppliedFilters] = useState<{
    userId: string;
    ip: string;
    category: string;
    rangeStart: number | null;
    rangeEnd: number | null;
  }>(() => {
    const ms = HISTORY_RANGE_PRESETS.find((p) => p.value === "24h")?.ms ?? null;
    const now = Date.now();
    return {
      userId: "",
      ip: "",
      category: "all",
      rangeStart: ms ? now - ms : null,
      rangeEnd: ms ? now : null,
    };
  });

  const categoriesFromSummary = summary ? Object.keys(summary.categories).sort() : [];

  const customRangeError = (() => {
    if (preset !== "custom") return null;
    const s = fromLocalInput(customStart);
    const e = fromLocalInput(customEnd);
    if (s === null || e === null) return "Please pick both a start and end date";
    if (e <= s) return "End must be after start";
    return null;
  })();

  const applyFilters = () => {
    let rangeStart: number | null = null;
    let rangeEnd: number | null = null;
    const now = Date.now();
    if (preset === "custom") {
      if (customRangeError) return;
      rangeStart = fromLocalInput(customStart);
      rangeEnd = fromLocalInput(customEnd);
    } else {
      const presetDef = HISTORY_RANGE_PRESETS.find((p) => p.value === preset);
      if (presetDef && presetDef.ms !== null) {
        rangeStart = now - presetDef.ms;
        rangeEnd = now;
      }
    }
    setPage(0);
    setAppliedFilters({
      userId: userIdFilter.trim(),
      ip: ipFilter.trim(),
      category: categoryFilter,
      rangeStart,
      rangeEnd,
    });
  };

  const resetFilters = () => {
    setUserIdFilter("");
    setIpFilter("");
    setCategoryFilter("all");
    setPreset("24h");
    setCustomStart("");
    setCustomEnd("");
    setPage(0);
    const ms = HISTORY_RANGE_PRESETS.find((p) => p.value === "24h")?.ms ?? null;
    const now = Date.now();
    setAppliedFilters({
      userId: "",
      ip: "",
      category: "all",
      rangeStart: ms ? now - ms : null,
      rangeEnd: ms ? now : null,
    });
  };

  const queryParams = new URLSearchParams();
  if (appliedFilters.userId) queryParams.set("userId", appliedFilters.userId);
  if (appliedFilters.ip) queryParams.set("ip", appliedFilters.ip);
  if (appliedFilters.category && appliedFilters.category !== "all") {
    queryParams.set("category", appliedFilters.category);
  }
  if (appliedFilters.rangeStart !== null && appliedFilters.rangeEnd !== null) {
    queryParams.set("rangeStart", String(appliedFilters.rangeStart));
    queryParams.set("rangeEnd", String(appliedFilters.rangeEnd));
  }
  queryParams.set("limit", String(HISTORY_PAGE_SIZE));
  queryParams.set("offset", String(page * HISTORY_PAGE_SIZE));

  const url = `/api/health/rate-limits/events?${queryParams.toString()}`;

  const { data, isLoading, isFetching, error, refetch } = useQuery<BlockedEventHistoryResponse>({
    queryKey: ["/api/health/rate-limits/events", appliedFilters, page],
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Failed to fetch blocked events");
      }
      return res.json();
    },
    placeholderData: (prev) => prev,
  });

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const showingStart = total === 0 ? 0 : page * HISTORY_PAGE_SIZE + 1;
  const showingEnd = Math.min(total, (page + 1) * HISTORY_PAGE_SIZE);

  return (
    <Card data-testid="card-blocked-event-history">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <History className="w-5 h-5" />
          Blocked Event History
          <span className="text-xs font-normal text-muted-foreground">
            (persisted for 30 days)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label htmlFor="input-history-user-id" className="text-xs font-medium text-muted-foreground block mb-1">User ID</label>
            <Input
              id="input-history-user-id"
              data-testid="input-history-user-id"
              value={userIdFilter}
              placeholder="exact user id"
              onChange={(e) => setUserIdFilter(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <label htmlFor="input-history-ip" className="text-xs font-medium text-muted-foreground block mb-1">IP Address</label>
            <Input
              id="input-history-ip"
              data-testid="input-history-ip"
              value={ipFilter}
              placeholder="exact IP"
              onChange={(e) => setIpFilter(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Category</label>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger aria-label="Filter by category" className="h-8 text-sm" data-testid="select-history-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categoriesFromSummary.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Range</label>
            <Select value={preset} onValueChange={(v) => setPreset(v as typeof preset)}>
              <SelectTrigger aria-label="Filter by time range" className="h-8 text-sm" data-testid="select-history-range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HISTORY_RANGE_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {preset === "custom" && (
          <div className="space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor="input-history-range-start" className="text-xs font-medium text-muted-foreground block mb-1">Start</label>
                <Input
                  id="input-history-range-start"
                  type="datetime-local"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="h-8 text-sm"
                  data-testid="input-history-range-start"
                />
              </div>
              <div>
                <label htmlFor="input-history-range-end" className="text-xs font-medium text-muted-foreground block mb-1">End</label>
                <Input
                  id="input-history-range-end"
                  type="datetime-local"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="h-8 text-sm"
                  data-testid="input-history-range-end"
                />
              </div>
            </div>
            {customRangeError && (
              <div className="text-xs text-red-600 dark:text-red-300" data-testid="text-history-range-error">
                {customRangeError}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={applyFilters}
            disabled={!!customRangeError}
            data-testid="button-history-apply"
          >
            Apply filters
          </Button>
          <Button size="sm" variant="outline" onClick={resetFilters} data-testid="button-history-reset">
            Reset
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-history-refresh"
          >
            Refresh
          </Button>
          <ConfirmActionDialog
            open={csvConfirmOpen}
            onOpenChange={setCsvConfirmOpen}
            title="Download a large CSV export?"
            description={`This export will include ${total.toLocaleString()} rows, which may take a while to generate and download. Narrow the filters or date range first if you only need a subset.`}
            confirmLabel="Download CSV"
            onConfirm={() => {
              setCsvConfirmOpen(false);
              startCsvExport();
            }}
            testId="dialog-history-export-csv"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (total > CSV_EXPORT_CONFIRM_THRESHOLD) {
                setCsvConfirmOpen(true);
                return;
              }
              startCsvExport();
            }}
            disabled={total === 0 || isLoading || isFetching}
            data-testid="button-history-export-csv"
            title={
              isFetching
                ? "Updating count…"
                : total > 0
                ? `Download ${total.toLocaleString()} matching event${total === 1 ? "" : "s"} as CSV`
                : "No matching events to download"
            }
          >
            <Download className="w-3.5 h-3.5 mr-1" />
            {isLoading || isFetching
              ? "Download CSV (updating…)"
              : total === 0
              ? "Download CSV"
              : `Download CSV (${total.toLocaleString()} row${total === 1 ? "" : "s"})`}
          </Button>
          <div className="ml-auto text-xs text-muted-foreground" data-testid="text-history-count">
            {isLoading
              ? "Loading…"
              : total === 0
              ? "No matching events"
              : `Showing ${showingStart}–${showingEnd} of ${total.toLocaleString()}`}
          </div>
        </div>

        {error ? (
          <div className="text-sm text-red-600 dark:text-red-400" data-testid="text-history-error">
            {(error as Error).message}
          </div>
        ) : null}

        <div className="border rounded-md overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-blocked-event-history">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-3 py-2">Category</th>
                <th className="text-left px-3 py-2">Method</th>
                <th className="text-left px-3 py-2">Path</th>
                <th className="text-left px-3 py-2">IP</th>
                <th className="text-left px-3 py-2">User</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && !isLoading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="text-center py-8 text-muted-foreground"
                    data-testid="text-history-empty"
                  >
                    No blocked events match these filters.
                  </td>
                </tr>
              ) : (
                events.map((ev) => {
                  const filterToIp = () => {
                    setIpFilter(ev.ip);
                    setUserIdFilter("");
                    setPage(0);
                    setAppliedFilters((prev) => ({
                      ...prev,
                      ip: ev.ip,
                      userId: "",
                    }));
                  };
                  const filterToUser = () => {
                    if (!ev.userId) return;
                    setUserIdFilter(ev.userId);
                    setIpFilter("");
                    setPage(0);
                    setAppliedFilters((prev) => ({
                      ...prev,
                      userId: ev.userId!,
                      ip: "",
                    }));
                  };
                  const jumpIp = () => onJumpToIp(ev.ip);
                  const jumpUser = () => {
                    if (ev.userId) onJumpToUser(ev.userId);
                  };
                  return (
                    <tr key={ev.id} className="border-t" data-testid={`row-history-event-${ev.id}`}>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                        {format(new Date(ev.timestamp), "yyyy-MM-dd HH:mm:ss")}
                      </td>
                      <td className="px-3 py-2">
                        <Badge className={`${CATEGORY_COLORS[ev.category] ?? "bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300"} text-xs`}>
                          {ev.category}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{ev.method}</td>
                      <td className="px-3 py-2 font-mono text-xs break-all max-w-xs">{ev.path}</td>
                      <td className="px-3 py-2 font-mono text-xs">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={jumpIp}
                            className="text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                            title={`Jump to ${ev.ip} in the By IP tab`}
                            data-testid={`button-history-jump-ip-${ev.id}`}
                          >
                            {ev.ip}
                          </button>
                          <button
                            type="button"
                            onClick={filterToIp}
                            className="text-xs uppercase tracking-wide text-muted-foreground hover:text-primary-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                            title={`Filter the history to events from ${ev.ip}`}
                            data-testid={`button-history-filter-ip-${ev.id}`}
                          >
                            filter
                          </button>
                          <a
                            href={`/admin/rate-limits?tab=anonymous&ip=${encodeURIComponent(ev.ip)}`}
                            onClick={(e) => {
                              if (
                                e.metaKey ||
                                e.ctrlKey ||
                                e.shiftKey ||
                                e.altKey ||
                                e.button !== 0
                              ) {
                                return;
                              }
                              e.preventDefault();
                              jumpIp();
                            }}
                            className="inline-flex items-center gap-0.5 text-xs uppercase tracking-wide text-muted-foreground hover:text-primary-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                            title={`Open ${ev.ip}'s per-IP rate-limit dashboard (shareable URL — cmd/ctrl-click for new tab)`}
                            data-testid={`link-history-open-ip-${ev.id}`}
                          >
                            <ExternalLink className="w-3 h-3" />
                            open details
                          </a>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {ev.userId ? (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={jumpUser}
                              className="text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                              title="Jump to this user in the By User tab"
                              data-testid={`button-history-jump-user-${ev.id}`}
                            >
                              {getUserDisplayName(ev.userId, dbUsers)}
                            </button>
                            <button
                              type="button"
                              onClick={filterToUser}
                              className="text-xs uppercase tracking-wide text-muted-foreground hover:text-primary-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                              title="Filter the history to events from this user"
                              data-testid={`button-history-filter-user-${ev.id}`}
                            >
                              filter
                            </button>
                            <a
                              href={`/admin/rate-limits?tab=users&userId=${encodeURIComponent(ev.userId)}`}
                              onClick={(e) => {
                                if (
                                  e.metaKey ||
                                  e.ctrlKey ||
                                  e.shiftKey ||
                                  e.altKey ||
                                  e.button !== 0
                                ) {
                                  return;
                                }
                                e.preventDefault();
                                jumpUser();
                              }}
                              className="inline-flex items-center gap-0.5 text-xs uppercase tracking-wide text-muted-foreground hover:text-primary-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                              title="Open this user's per-user rate-limit dashboard (shareable URL — cmd/ctrl-click for new tab)"
                              data-testid={`link-history-open-user-${ev.id}`}
                            >
                              <ExternalLink className="w-3 h-3" />
                              open details
                            </a>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">anonymous</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground" data-testid="text-history-page">
            Page {page + 1} of {totalPages}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0 || isFetching}
              data-testid="button-history-prev"
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPage((p) => p + 1)}
              disabled={page + 1 >= totalPages || isFetching}
              data-testid="button-history-next"
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
