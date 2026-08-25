// Rate Limits admin — sent-notification history panel with filters, bulk retry and CSV export.
// Extracted VERBATIM from the former 5.9k-line RateLimitUsers.tsx monolith
// (house aggregator pattern, cf. ClickUpModule / Task #3787; this split:
// F11C / Task #4159). The page composition root is
// client/src/pages/admin/RateLimitUsers.tsx — new rate-limit admin UI
// belongs here (or in a new sibling module), never in the aggregator.

import { useAuth } from "@/hooks/use-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Download, History, ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { type DbUser, getCategoryColor, formatTime, getUserDisplayName, statusBadgeClass } from "./shared";
import { NotificationRetentionEditor } from "./retention";

type AlertNotification = {
  id: string;
  channel: string;
  destination: string;
  status: string;
  errorMessage: string | null;
  userId: string | null;
  userLabel: string | null;
  category: string;
  count: number;
  maxRequests: number;
  warningPercent: number;
  windowMs: number;
  windowStart: number;
  triggeredAt: number;
  attemptedAt: number;
  triggerSource?: string | null;
  triggerActorId?: string | null;
  latencyMs?: number | null;
  attemptNumber?: number | null;
  parentNotificationId?: string | null;
  hasChildren?: boolean | null;
  // Task #1251: true when this row's retry chain has hit the auto-retry cap
  // and the latest attempt still failed. Drives the "Exhausted" badge + the
  // "Exhausted only" quick-filter in the notification history panel.
  chainExhausted?: boolean | null;
};


const STATUS_OPTIONS = ["sent", "failed", "skipped"] as const;
const CHANNEL_OPTIONS = ["slack", "email"] as const;
const TRIGGER_OPTIONS = ["scheduled", "manual", "config_change"] as const;
const ALL_VALUE = "__all__";
const DEFAULT_EXPORT_LIMIT = 5000;
const MAX_EXPORT_LIMIT = 100_000;


function highlightMatches(text: string, query: string): ReactNode {
  if (!query) return text;
  const trimmed = query.trim();
  if (!trimmed) return text;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark
        key={i}
        className="bg-yellow-200 text-inherit rounded px-0.5"
        data-testid="text-match-highlight"
      >
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}


export function NotificationHistoryPanel({ dbUsers }: { dbUsers: DbUser[] }) {
  const isTabVisible = useTabVisibility();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const ns = user?.id ? `admin.rateLimitNotifHistory.${user.id}` : null;
  const validStatus = (v: unknown): v is string =>
    typeof v === "string" && (v === "" || (STATUS_OPTIONS as readonly string[]).includes(v));
  const validChannel = (v: unknown): v is string =>
    typeof v === "string" && (v === "" || (CHANNEL_OPTIONS as readonly string[]).includes(v));
  const isString = (v: unknown): v is string => typeof v === "string";
  const [statusFilter, setStatusFilter] = usePersistentState<string>(
    ns ? `${ns}.status` : null,
    "",
    validStatus,
  );
  const [channelFilter, setChannelFilter] = usePersistentState<string>(
    ns ? `${ns}.channel` : null,
    "",
    validChannel,
  );
  const [categoryFilter, setCategoryFilter] = usePersistentState<string>(
    ns ? `${ns}.category` : null,
    "",
    isString,
  );
  const validTrigger = (v: unknown): v is string =>
    typeof v === "string" &&
    (v === "" || (TRIGGER_OPTIONS as readonly string[]).includes(v));
  const [triggerFilter, setTriggerFilter] = usePersistentState<string>(
    ns ? `${ns}.trigger` : null,
    "",
    validTrigger,
  );
  const isBool = (v: unknown): v is boolean => typeof v === "boolean";
  const [exhaustedOnly, setExhaustedOnly] = usePersistentState<boolean>(
    ns ? `${ns}.exhaustedOnly` : null,
    false,
    isBool,
  );
  const [searchFilter, setSearchFilter] = usePersistentState<string>(
    ns ? `${ns}.search` : null,
    "",
    isString,
  );
  const validDate = (v: unknown): v is string =>
    typeof v === "string" && (v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v));
  const [startDate, setStartDate] = usePersistentState<string>(
    ns ? `${ns}.startDate` : null,
    "",
    validDate,
  );
  const [endDate, setEndDate] = usePersistentState<string>(
    ns ? `${ns}.endDate` : null,
    "",
    validDate,
  );
  const validDatePreset = (v: unknown): v is string =>
    typeof v === "string" &&
    (v === "" || v === "today" || v === "last24h" || v === "last7d" || v === "last30d");
  const [datePreset, setDatePreset] = usePersistentState<string>(
    ns ? `${ns}.datePreset` : null,
    "",
    validDatePreset,
  );
  const formatLocalDate = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const computePresetRange = (preset: string): { start: string; end: string } | null => {
    const now = new Date();
    const end = formatLocalDate(now);
    if (preset === "today") return { start: end, end };
    if (preset === "last24h") {
      const s = new Date(now);
      s.setDate(s.getDate() - 1);
      return { start: formatLocalDate(s), end };
    }
    if (preset === "last7d") {
      const s = new Date(now);
      s.setDate(s.getDate() - 6);
      return { start: formatLocalDate(s), end };
    }
    if (preset === "last30d") {
      const s = new Date(now);
      s.setDate(s.getDate() - 29);
      return { start: formatLocalDate(s), end };
    }
    return null;
  };
  const applyDatePreset = (preset: string) => {
    const range = computePresetRange(preset);
    if (!range) return;
    setStartDate(range.start);
    setEndDate(range.end);
    setDatePreset(preset);
  };
  const onStartDateChange = (v: string) => {
    setStartDate(v);
    setIncompleteRangeError(null);
    if (datePreset) setDatePreset("");
  };
  const onEndDateChange = (v: string) => {
    setEndDate(v);
    setIncompleteRangeError(null);
    if (datePreset) setDatePreset("");
  };
  const DATE_PRESETS: { value: string; label: string }[] = [
    { value: "today", label: "Today" },
    { value: "last24h", label: "Last 24h" },
    { value: "last7d", label: "Last 7 days" },
    { value: "last30d", label: "Last 30 days" },
  ];
  const dateRangeError = useMemo(() => {
    if (!startDate || !endDate) return null;
    return startDate > endDate ? "Start date must be on or before end date" : null;
  }, [startDate, endDate]);
  const startMs = useMemo(() => {
    if (!startDate) return null;
    const d = new Date(`${startDate}T00:00:00`);
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  }, [startDate]);
  const endMs = useMemo(() => {
    if (!endDate) return null;
    const d = new Date(`${endDate}T23:59:59.999`);
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  }, [endDate]);
  const dateRangeReady = !dateRangeError && (
    (startDate === "" && endDate === "") ||
    (startDate !== "" && endDate !== "")
  );
  const [exportLimitInput, setExportLimitInput] = useState<string>(
    String(DEFAULT_EXPORT_LIMIT),
  );
  // Task #4420 — field validation is inline (FormField), never a toast.
  const [exportLimitError, setExportLimitError] = useState<string | null>(null);
  const [incompleteRangeError, setIncompleteRangeError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(searchFilter);
  useEffect(() => {
    setSearchInput(searchFilter);
  }, [searchFilter]);
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === searchFilter) return;
    const handle = setTimeout(() => setSearchFilter(trimmed), 300);
    return () => clearTimeout(handle);
  }, [searchInput, searchFilter, setSearchFilter]);

  const filterParams = new URLSearchParams({ limit: "50" });
  if (statusFilter) filterParams.set("status", statusFilter);
  if (channelFilter) filterParams.set("channel", channelFilter);
  if (categoryFilter) filterParams.set("category", categoryFilter);
  if (searchFilter) filterParams.set("search", searchFilter);
  if (triggerFilter) filterParams.set("triggerSource", triggerFilter);
  if (exhaustedOnly) filterParams.set("exhaustedOnly", "1");
  if (dateRangeReady && startMs != null && endMs != null) {
    filterParams.set("start", String(startMs));
    filterParams.set("end", String(endMs));
  }
  const filteredUrl = `/api/health/rate-limits/notifications?${filterParams.toString()}`;

  const { data, isLoading, error } = useQuery<{ notifications: AlertNotification[] }>({
    queryKey: [
      "/api/health/rate-limits/notifications",
      statusFilter,
      channelFilter,
      categoryFilter,
      searchFilter,
      triggerFilter,
      exhaustedOnly,
      dateRangeReady ? startMs : null,
      dateRangeReady ? endMs : null,
    ],
    queryFn: async () => {
      const res = await fetch(filteredUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch notification history");
      return res.json();
    },
    enabled: dateRangeReady,
    refetchInterval: isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });

  // Separate unfiltered fetch to populate the category dropdown options.
  const { data: optionsData } = useQuery<{ notifications: AlertNotification[] }>({
    queryKey: ["/api/health/rate-limits/notifications", "options"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits/notifications?limit=200", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch notification options");
      return res.json();
    },
    refetchInterval: isTabVisible ? 60000 : false,
    refetchIntervalInBackground: false,
  });

  const notifications = data?.notifications ?? [];
  const categoryOptions = Array.from(
    new Set((optionsData?.notifications ?? []).map((n) => n.category)),
  ).sort();
  useEffect(() => {
    if (!optionsData) return;
    if (categoryFilter && !categoryOptions.includes(categoryFilter)) {
      setCategoryFilter("");
    }
  }, [optionsData, categoryFilter, categoryOptions, setCategoryFilter]);
  const hasDateRange = Boolean(startDate || endDate);
  const hasActiveFilters = Boolean(
    statusFilter || channelFilter || categoryFilter || searchFilter || triggerFilter || exhaustedOnly || hasDateRange,
  );
  const clearAllFilters = () => {
    setStatusFilter("");
    setChannelFilter("");
    setCategoryFilter("");
    setSearchFilter("");
    setSearchInput("");
    setTriggerFilter("");
    setExhaustedOnly(false);
    setStartDate("");
    setEndDate("");
    setDatePreset("");
  };

  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [isBulkRetrying, setIsBulkRetrying] = useState(false);
  const [expandedChainRowId, setExpandedChainRowId] = useState<string | null>(null);
  const [chainCache, setChainCache] = useState<
    Record<string, { loading: boolean; error: string | null; rows: AlertNotification[] }>
  >({});
  const handleToggleChain = async (n: AlertNotification) => {
    if (expandedChainRowId === n.id) {
      setExpandedChainRowId(null);
      return;
    }
    setExpandedChainRowId(n.id);
    if (chainCache[n.id]?.rows && !chainCache[n.id]?.error) return;
    setChainCache((prev) => ({
      ...prev,
      [n.id]: { loading: true, error: null, rows: [] },
    }));
    try {
      const res = await fetch(
        `/api/health/rate-limits/notifications/${n.id}/chain`,
        { credentials: "include" },
      );
      const json = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        throw new Error(json?.error || `Request failed (${res.status})`);
      }
      const rows: AlertNotification[] = Array.isArray(json?.chain)
        ? (json.chain as AlertNotification[])
        : [];
      setChainCache((prev) => ({
        ...prev,
        [n.id]: { loading: false, error: null, rows },
      }));
    } catch (err: unknown) {
      setChainCache((prev) => ({
        ...prev,
        [n.id]: {
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load chain",
          rows: [],
        },
      }));
    }
  };
  const handleRetryNotification = async (id: string) => {
    setRetryingId(id);
    try {
      const res = await fetch(`/api/health/rate-limits/notifications/${id}/retry`, {
        method: "POST",
        credentials: "include",
      });
      const json = await res.json().catch(() => ({} as any));
      if (!res.ok && res.status !== 409) throw new Error(json?.error || `Request failed (${res.status})`);
      const status = (json?.outcome?.status as string | undefined) ?? "failed";
      const attempt = json?.outcome?.attemptNumber as number | undefined;
      toast({
        title: status === "sent" ? "Notification resent" : `Retry ${status}`,
        description:
          status === "sent"
            ? `Attempt #${attempt ?? "?"} delivered successfully.`
            : json?.outcome?.errorMessage || json?.error || "See history for details.",
        variant: status === "sent" ? "default" : "destructive",
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/notifications"] }); // fire-and-forget: cache refresh only
    } catch (err: unknown) {
      toast({
        title: "Retry failed",
        description: err instanceof Error ? err.message : "Could not retry notification.",
        variant: "destructive",
      });
    } finally {
      setRetryingId(null);
    }
  };
  const handleBulkRetry = async () => {
    setIsBulkRetrying(true);
    try {
      const body: Record<string, unknown> = { limit: 50 };
      if (channelFilter) body.channel = channelFilter;
      if (categoryFilter) body.category = categoryFilter;
      if (searchFilter) body.search = searchFilter;
      const res = await fetch("/api/health/rate-limits/notifications/bulk-retry", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      const sent = (json.outcomes ?? []).filter((o: any) => o.status === "sent").length;
      toast({
        title: "Bulk retry complete",
        description: `Attempted ${json.attempted ?? 0}, ${sent} delivered.`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/notifications"] }); // fire-and-forget: cache refresh only
    } catch (err: unknown) {
      toast({
        title: "Bulk retry failed",
        description: err instanceof Error ? err.message : "Could not bulk retry.",
        variant: "destructive",
      });
    } finally {
      setIsBulkRetrying(false);
    }
  };
  const handleExportCsv = async () => {
    // Task #4420 — field validation renders inline next to the date inputs
    // (FormField / the existing dateRangeError line), never as a toast.
    if (dateRangeError) {
      return;
    }
    if ((startDate && !endDate) || (!startDate && endDate)) {
      setIncompleteRangeError("Select both a start and an end date.");
      return;
    }
    setIncompleteRangeError(null);
    setIsExporting(true);
    try {
      const exportParams = new URLSearchParams();
      if (statusFilter) exportParams.set("status", statusFilter);
      if (channelFilter) exportParams.set("channel", channelFilter);
      if (categoryFilter) exportParams.set("category", categoryFilter);
      if (searchFilter) exportParams.set("search", searchFilter);
      if (triggerFilter) exportParams.set("triggerSource", triggerFilter);
      if (startMs != null && endMs != null) {
        exportParams.set("start", String(startMs));
        exportParams.set("end", String(endMs));
      }
      const trimmedLimit = exportLimitInput.trim();
      if (trimmedLimit) {
        const n = Number(trimmedLimit);
        if (!Number.isInteger(n) || n < 1) {
          setExportLimitError("Row cap must be a positive whole number.");
          setIsExporting(false);
          return;
        }
        setExportLimitError(null);
        const capped = Math.min(n, MAX_EXPORT_LIMIT);
        exportParams.set("limit", String(capped));
      }
      const qs = exportParams.toString();
      const res = await fetch(
        `/api/health/rate-limits/notifications.csv${qs ? `?${qs}` : ""}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const blob = await res.blob();
      const count = Number(res.headers.get("X-Notification-Export-Count") || "0");
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const stamp = format(new Date(), "yyyyMMdd-HHmmss");
      const filename = match?.[1] || `notification-history_${stamp}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({
        title: "Export ready",
        description: `Exported ${count} notification${count === 1 ? "" : "s"} to CSV.`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not export notification history.";
      toast({
        title: "Export failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Card data-testid="card-notification-history">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <History className="w-4 h-4" />
          Notification History
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Last 50 attempts to push rate-limit warnings to Slack or email.
        </p>
        <NotificationRetentionEditor />
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3 mb-4" data-testid="filters-notification-history">
          <div className="flex flex-col gap-1">
            <label htmlFor="input-search-notifications" className="text-caption uppercase tracking-wide text-muted-foreground">Search</label>
            <div className="relative">
              <Input
                id="input-search-notifications"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="User or destination…"
                aria-label="Search notifications by user or destination"
                className="h-8 w-64 text-xs pr-7"
                data-testid="input-search-notifications"
              />
              {searchInput ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput("");
                    setSearchFilter("");
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-red-600 dark:hover:text-red-400"
                  data-testid="button-clear-search-input"
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-caption uppercase tracking-wide text-muted-foreground">Status</label>
            <Select
              value={statusFilter || ALL_VALUE}
              onValueChange={(v) => setStatusFilter(v === ALL_VALUE ? "" : v)}
            >
              <SelectTrigger aria-label="Filter by status" className="h-8 w-36 text-xs" data-testid="select-filter-status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE} data-testid="option-status-all">All statuses</SelectItem>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s} data-testid={`option-status-${s}`}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-caption uppercase tracking-wide text-muted-foreground">Channel</label>
            <Select
              value={channelFilter || ALL_VALUE}
              onValueChange={(v) => setChannelFilter(v === ALL_VALUE ? "" : v)}
            >
              <SelectTrigger aria-label="Filter by channel" className="h-8 w-36 text-xs" data-testid="select-filter-channel">
                <SelectValue placeholder="All channels" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE} data-testid="option-channel-all">All channels</SelectItem>
                {CHANNEL_OPTIONS.map((c) => (
                  <SelectItem key={c} value={c} data-testid={`option-channel-${c}`}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-caption uppercase tracking-wide text-muted-foreground">Category</label>
            <Select
              value={categoryFilter || ALL_VALUE}
              onValueChange={(v) => setCategoryFilter(v === ALL_VALUE ? "" : v)}
            >
              <SelectTrigger aria-label="Filter by category" className="h-8 w-44 text-xs" data-testid="select-filter-category">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE} data-testid="option-category-all">All categories</SelectItem>
                {categoryOptions.map((c) => (
                  <SelectItem key={c} value={c} data-testid={`option-category-${c}`}>
                    {c}
                  </SelectItem>
                ))}
                {categoryFilter && !categoryOptions.includes(categoryFilter) ? (
                  <SelectItem value={categoryFilter} data-testid={`option-category-${categoryFilter}`}>
                    {categoryFilter}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-caption uppercase tracking-wide text-muted-foreground">Trigger</label>
            <Select
              value={triggerFilter || ALL_VALUE}
              onValueChange={(v) => setTriggerFilter(v === ALL_VALUE ? "" : v)}
            >
              <SelectTrigger aria-label="Filter by trigger" className="h-8 w-36 text-xs" data-testid="select-filter-trigger">
                <SelectValue placeholder="All triggers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE} data-testid="option-trigger-all">All triggers</SelectItem>
                {TRIGGER_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t} data-testid={`option-trigger-${t}`}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-caption uppercase tracking-wide text-muted-foreground">
              Retry state
            </label>
            <Button
              type="button"
              size="sm"
              variant={exhaustedOnly ? "default" : "outline"}
              className="h-8 text-xs px-2"
              onClick={() => setExhaustedOnly(!exhaustedOnly)}
              data-testid="button-filter-exhausted-only"
              title="Show only retry chains that have hit the auto-retry cap"
              aria-pressed={exhaustedOnly}
            >
              Exhausted only
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-caption uppercase tracking-wide text-muted-foreground">
              Quick range
            </label>
            <div className="flex flex-wrap gap-1" data-testid="group-date-presets">
              {DATE_PRESETS.map((p) => (
                <Button
                  key={p.value}
                  type="button"
                  size="sm"
                  variant={datePreset === p.value ? "default" : "outline"}
                  className="h-8 text-xs px-2"
                  onClick={() => applyDatePreset(p.value)}
                  data-testid={`button-date-preset-${p.value}`}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>
          <FormField
            label="From"
            htmlFor="input-start-date"
            labelClassName="text-caption uppercase tracking-wide text-muted-foreground"
            error={incompleteRangeError && !startDate ? incompleteRangeError : undefined}
            className="flex flex-col gap-1 space-y-0"
          >
            <Input
              type="date"
              value={startDate}
              max={endDate || undefined}
              onChange={(e) => onStartDateChange(e.target.value)}
              className="h-8 w-40 text-xs"
              data-testid="input-filter-start-date"
            />
          </FormField>
          <FormField
            label="To"
            htmlFor="input-end-date"
            labelClassName="text-caption uppercase tracking-wide text-muted-foreground"
            error={incompleteRangeError && !endDate ? incompleteRangeError : undefined}
            className="flex flex-col gap-1 space-y-0"
          >
            <Input
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(e) => onEndDateChange(e.target.value)}
              className="h-8 w-40 text-xs"
              data-testid="input-filter-end-date"
            />
          </FormField>
          {dateRangeError ? (
            <div
              className="text-caption text-red-600 dark:text-red-300 self-end pb-1"
              data-testid="text-date-range-error"
            >
              {dateRangeError}
            </div>
          ) : null}
          <FormField
            label={`Export rows (max ${MAX_EXPORT_LIMIT.toLocaleString()})`}
            htmlFor="input-export-limit"
            labelClassName="text-caption uppercase tracking-wide text-muted-foreground"
            error={exportLimitError}
            className="flex flex-col gap-1 space-y-0"
          >
            <Input
              type="number"
              min={1}
              max={MAX_EXPORT_LIMIT}
              value={exportLimitInput}
              onChange={(e) => {
                setExportLimitInput(e.target.value);
                setExportLimitError(null);
              }}
              className="h-8 w-28 text-xs"
              placeholder={String(DEFAULT_EXPORT_LIMIT)}
              data-testid="input-export-limit"
            />
          </FormField>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={handleExportCsv}
            disabled={isExporting}
            data-testid="button-export-notifications-csv"
          >
            <Download className="w-3.5 h-3.5 mr-1" />
            {isExporting ? "Exporting…" : "Export CSV"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={handleBulkRetry}
            disabled={isBulkRetrying}
            data-testid="button-bulk-retry-notifications"
            title="Retry up to 50 failed notifications matching the current filters"
          >
            {isBulkRetrying ? "Retrying…" : "Retry failed (bulk)"}
          </Button>
          {hasActiveFilters ? (
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <span className="text-caption text-muted-foreground">Active:</span>
              {statusFilter ? (
                <Badge
                  variant="outline"
                  className="text-caption flex items-center gap-1"
                  data-testid="badge-active-status"
                >
                  status: {statusFilter}
                  <button
                    type="button"
                    onClick={() => setStatusFilter("")}
                    className="hover:text-red-600 dark:hover:text-red-400"
                    data-testid="button-clear-status"
                    aria-label="Clear status filter"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ) : null}
              {channelFilter ? (
                <Badge
                  variant="outline"
                  className="text-caption flex items-center gap-1"
                  data-testid="badge-active-channel"
                >
                  channel: {channelFilter}
                  <button
                    type="button"
                    onClick={() => setChannelFilter("")}
                    className="hover:text-red-600 dark:hover:text-red-400"
                    data-testid="button-clear-channel"
                    aria-label="Clear channel filter"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ) : null}
              {searchFilter ? (
                <Badge
                  variant="outline"
                  className="text-caption flex items-center gap-1"
                  data-testid="badge-active-search"
                >
                  search: {searchFilter}
                  <button
                    type="button"
                    onClick={() => {
                      setSearchFilter("");
                      setSearchInput("");
                    }}
                    className="hover:text-red-600 dark:hover:text-red-400"
                    data-testid="button-clear-search"
                    aria-label="Clear search filter"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ) : null}
              {categoryFilter ? (
                <Badge
                  variant="outline"
                  className="text-caption flex items-center gap-1"
                  data-testid="badge-active-category"
                >
                  category: {categoryFilter}
                  <button
                    type="button"
                    onClick={() => setCategoryFilter("")}
                    className="hover:text-red-600 dark:hover:text-red-400"
                    data-testid="button-clear-category"
                    aria-label="Clear category filter"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ) : null}
              {triggerFilter ? (
                <Badge
                  variant="outline"
                  className="text-caption flex items-center gap-1"
                  data-testid="badge-active-trigger"
                >
                  trigger: {triggerFilter}
                  <button
                    type="button"
                    onClick={() => setTriggerFilter("")}
                    className="hover:text-red-600 dark:hover:text-red-400"
                    data-testid="button-clear-trigger"
                    aria-label="Clear trigger filter"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ) : null}
              {exhaustedOnly ? (
                <Badge
                  variant="outline"
                  className="text-caption flex items-center gap-1 border-red-300 text-red-700 dark:border-red-800 dark:text-red-300"
                  data-testid="badge-active-exhausted-only"
                >
                  exhausted only
                  <button
                    type="button"
                    onClick={() => setExhaustedOnly(false)}
                    className="hover:text-red-600 dark:hover:text-red-400"
                    data-testid="button-clear-exhausted-only"
                    aria-label="Clear exhausted-only filter"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ) : null}
              {hasDateRange ? (
                <Badge
                  variant="outline"
                  className={`text-caption flex items-center gap-1 ${dateRangeError ? "border-red-500 text-red-700 dark:border-red-800 dark:text-red-300" : ""}`}
                  data-testid="badge-active-date-range"
                  title={dateRangeError ?? undefined}
                >
                  range: {startDate || "…"} → {endDate || "…"}
                  <button
                    type="button"
                    onClick={() => {
                      setStartDate("");
                      setEndDate("");
                    }}
                    className="hover:text-red-600 dark:hover:text-red-400"
                    data-testid="button-clear-date-range"
                    aria-label="Clear date range filter"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-caption"
                onClick={clearAllFilters}
                data-testid="button-clear-all-filters"
              >
                Clear all
              </Button>
            </div>
          ) : null}
        </div>
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-4" data-testid="text-notifications-loading">
            Loading notification history…
          </div>
        ) : error ? (
          <div className="text-sm text-red-600 dark:text-red-400 py-4" data-testid="text-notifications-error">
            Failed to load notification history: {(error as Error).message}
          </div>
        ) : notifications.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4" data-testid="text-no-notifications">
            No notification attempts recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto" data-testid="list-notification-history">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left p-2 font-medium text-muted-foreground">When</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Status</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Channel</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Destination</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">User</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Category</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Usage</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Delivery</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Detail</th>
                  <th className="text-right p-2 font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {notifications.map((n) => {
                  const usagePct =
                    n.maxRequests > 0 ? Math.round((n.count / n.maxRequests) * 100) : 0;
                  const userDisplay = n.userId
                    ? getUserDisplayName(n.userId, dbUsers)
                    : n.userLabel || "—";
                  const isManual = n.triggerSource === "manual";
                  const isConfigChange = n.triggerSource === "config_change";
                  const actorDisplay = n.triggerActorId
                    ? getUserDisplayName(n.triggerActorId, dbUsers)
                    : null;
                  const hasChain =
                    !!n.parentNotificationId ||
                    (n.attemptNumber ?? 1) > 1 ||
                    !!n.hasChildren;
                  const isChainExpanded = expandedChainRowId === n.id;
                  const chainState = chainCache[n.id];
                  return (
                    <Fragment key={n.id}>
                    <tr
                      className="border-b last:border-0 align-top"
                      data-testid={`row-notification-${n.id}`}
                    >
                      <td className="p-2 whitespace-nowrap text-muted-foreground">
                        <div className="flex items-center gap-1">
                          {hasChain ? (
                            <button
                              type="button"
                              onClick={() => handleToggleChain(n)}
                              className="text-muted-foreground hover:text-primary-ink"
                              aria-label={
                                isChainExpanded ? "Hide retry chain" : "Show retry chain"
                              }
                              aria-expanded={isChainExpanded}
                              data-testid={`button-toggle-chain-${n.id}`}
                              title="View retry chain"
                            >
                              {isChainExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </button>
                          ) : (
                            <span className="inline-block w-3.5" />
                          )}
                          <span>{formatTime(n.attemptedAt)}</span>
                        </div>
                      </td>
                      <td className="p-2">
                        <div className="flex flex-col gap-1">
                          <Badge
                            className={`text-caption ${statusBadgeClass(n.status)}`}
                            data-testid={`badge-notification-status-${n.id}`}
                          >
                            {n.status}
                          </Badge>
                          {isManual ? (
                            <Badge
                              className="text-caption bg-blue-100 text-blue-800 w-fit"
                              data-testid={`badge-notification-manual-${n.id}`}
                              title={
                                actorDisplay
                                  ? `Manually flushed by ${actorDisplay}`
                                  : "Manually flushed"
                              }
                            >
                              manual{actorDisplay ? ` · ${actorDisplay}` : ""}
                            </Badge>
                          ) : isConfigChange ? (
                            <Badge
                              className="text-caption bg-purple-100 text-purple-800 w-fit"
                              data-testid={`badge-notification-config-change-${n.id}`}
                              title={
                                actorDisplay
                                  ? `Flushed by cadence change from ${actorDisplay}`
                                  : "Flushed by cadence change"
                              }
                            >
                              config change{actorDisplay ? ` · ${actorDisplay}` : ""}
                            </Badge>
                          ) : null}
                          {n.chainExhausted ? (
                            <button
                              type="button"
                              onClick={() => handleToggleChain(n)}
                              className="w-fit"
                              data-testid={`button-exhausted-badge-${n.id}`}
                              title="Auto-retry cap reached — click to view the retry chain"
                              aria-label="Auto-retry exhausted — open chain"
                            >
                              <Badge
                                className="text-caption bg-red-100 text-red-800 border border-red-300 hover:bg-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800 dark:hover:bg-red-950/60 cursor-pointer"
                                data-testid={`badge-notification-exhausted-${n.id}`}
                              >
                                Exhausted
                              </Badge>
                            </button>
                          ) : null}
                        </div>
                      </td>
                      <td className="p-2 capitalize">{n.channel}</td>
                      <td className="p-2 font-mono break-all max-w-[180px]">
                        {highlightMatches(n.destination, searchFilter)}
                      </td>
                      <td className="p-2 text-foreground">
                        {typeof userDisplay === "string"
                          ? highlightMatches(userDisplay, searchFilter)
                          : userDisplay}
                      </td>
                      <td className="p-2">
                        <Badge className={`text-caption ${getCategoryColor(n.category)}`}>
                          {highlightMatches(n.category, searchFilter)}
                        </Badge>
                      </td>
                      <td className="p-2 font-mono whitespace-nowrap">
                        {n.count}/{n.maxRequests}{" "}
                        <span className="text-muted-foreground">({usagePct}%)</span>
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        <div
                          className="flex flex-col gap-0.5 text-caption"
                          data-testid={`text-notification-delivery-${n.id}`}
                        >
                          <span>
                            <span className="text-muted-foreground">attempt</span>{" "}
                            <span className="font-mono">#{n.attemptNumber ?? 1}</span>
                          </span>
                          <span>
                            <span className="text-muted-foreground">latency</span>{" "}
                            <span className="font-mono">
                              {typeof n.latencyMs === "number" ? `${n.latencyMs}ms` : "—"}
                            </span>
                          </span>
                          {n.triggerSource && n.triggerSource !== "scheduled" ? (
                            <Badge
                              variant="outline"
                              className="text-caption w-fit"
                              data-testid={`badge-notification-trigger-${n.id}`}
                            >
                              via {n.triggerSource}
                            </Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="p-2 text-muted-foreground max-w-[260px]">
                        {n.status === "failed" || n.status === "skipped" ? (
                          <span
                            className={n.status === "failed" ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300"}
                            data-testid={`text-notification-error-${n.id}`}
                          >
                            {n.errorMessage || "—"}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            Triggered {formatTime(n.triggeredAt)}
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-right">
                        {n.status === "failed" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 text-caption"
                            onClick={() => handleRetryNotification(n.id)}
                            disabled={retryingId === n.id}
                            data-testid={`button-retry-notification-${n.id}`}
                          >
                            {retryingId === n.id ? "Retrying…" : "Retry"}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                    {isChainExpanded ? (
                      <tr
                        className="border-b last:border-0 bg-muted/20"
                        data-testid={`row-notification-chain-${n.id}`}
                      >
                        <td colSpan={10} className="p-3">
                          {chainState?.loading ? (
                            <div
                              className="text-caption text-muted-foreground"
                              data-testid={`text-chain-loading-${n.id}`}
                            >
                              Loading retry chain…
                            </div>
                          ) : chainState?.error ? (
                            <div
                              className="text-caption text-red-600 dark:text-red-300"
                              data-testid={`text-chain-error-${n.id}`}
                            >
                              Failed to load chain: {chainState.error}
                            </div>
                          ) : chainState?.rows && chainState.rows.length > 0 ? (
                            <div className="flex flex-col gap-1">
                              <div className="text-caption font-medium text-muted-foreground">
                                Retry chain ({chainState.rows.length} attempt
                                {chainState.rows.length === 1 ? "" : "s"})
                                {chainState.rows[0]?.id ? (
                                  <span className="ml-2 text-caption">
                                    root:{" "}
                                    <code className="font-mono" title={chainState.rows[0].id}>
                                      {chainState.rows[0].id.slice(0, 8)}…
                                    </code>
                                  </span>
                                ) : null}
                              </div>
                              <ol className="flex flex-col gap-1">
                                {chainState.rows.map((c) => {
                                  const isCurrent = c.id === n.id;
                                  return (
                                    <li
                                      key={c.id}
                                      className={`flex flex-wrap items-center gap-2 text-caption rounded px-2 py-1 ${
                                        isCurrent ? "bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-800" : "bg-card border dark:bg-transparent"
                                      }`}
                                      data-testid={`item-chain-attempt-${c.id}`}
                                    >
                                      <span className="font-mono">
                                        #{c.attemptNumber ?? 1}
                                      </span>
                                      <Badge
                                        className={`text-caption ${statusBadgeClass(c.status)}`}
                                      >
                                        {c.status}
                                      </Badge>
                                      <span className="text-muted-foreground whitespace-nowrap">
                                        {formatTime(c.attemptedAt)}
                                      </span>
                                      {c.triggerSource && c.triggerSource !== "scheduled" ? (
                                        <Badge variant="outline" className="text-caption">
                                          via {c.triggerSource}
                                        </Badge>
                                      ) : null}
                                      {c.errorMessage ? (
                                        <span className="text-red-700 dark:text-red-300 truncate max-w-[360px]">
                                          {c.errorMessage}
                                        </span>
                                      ) : null}
                                      <code className="font-mono text-caption text-muted-foreground" title={c.id}>
                                        {c.id.slice(0, 8)}…
                                      </code>
                                      {c.parentNotificationId ? (
                                        <span className="text-caption text-muted-foreground">
                                          ← parent{" "}
                                          <code className="font-mono" title={c.parentNotificationId}>
                                            {c.parentNotificationId.slice(0, 8)}…
                                          </code>
                                        </span>
                                      ) : (
                                        <Badge variant="outline" className="text-caption">
                                          chain root
                                        </Badge>
                                      )}
                                      {isCurrent ? (
                                        <Badge className="text-caption bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                                          this row
                                        </Badge>
                                      ) : null}
                                    </li>
                                  );
                                })}
                              </ol>
                            </div>
                          ) : (
                            <div
                              className="text-caption text-muted-foreground"
                              data-testid={`text-chain-empty-${n.id}`}
                            >
                              No prior attempts found in this chain.
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
