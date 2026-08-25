// Rate Limits admin — blocked-events time-series charts (per-user / per-IP) with interval + range controls and CSV export.
// Extracted VERBATIM from the former 5.9k-line RateLimitUsers.tsx monolith
// (house aggregator pattern, cf. ClickUpModule / Task #3787; this split:
// F11C / Task #4159). The page composition root is
// client/src/pages/admin/RateLimitUsers.tsx — new rate-limit admin UI
// belongs here (or in a new sibling module), never in the aggregator.

import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Download } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { format } from "date-fns";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { type RateLimitEvent, getCategoryHex, INTERVAL_OPTIONS, type TimeSeriesResponse, downloadCsv, intervalSlug, safeFilenamePart } from "./shared";

export function UserTimeSeriesChart({
  userId,
  displayName,
  recentEvents: _recentEvents,
}: {
  userId: string;
  displayName: string;
  recentEvents: RateLimitEvent[];
}) {
  return (
    <RateLimitTimeSeriesChart
      id={userId}
      url={`/api/health/rate-limits/by-user/${encodeURIComponent(userId)}/timeseries`}
      queryKey={["/api/health/rate-limits/by-user", userId, "timeseries"]}
      renderActions={({ data, intervalMs, range }) => {
        const handleDownloadBuckets = () => {
          if (!data) return;
          const cats = data.categories;
          const header = ["bucket_start_iso", "bucket_start_ms", "total", ...cats];
          const rows: (string | number)[][] = [header];
          for (const b of data.buckets) {
            const row: (string | number)[] = [
              new Date(b.bucketStart).toISOString(),
              b.bucketStart,
              b.total,
            ];
            for (const c of cats) row.push(b.categories[c] || 0);
            rows.push(row);
          }
          downloadCsv(
            `rate-limit-buckets-${safeFilenamePart(displayName)}-${intervalSlug(intervalMs)}.csv`,
            rows,
          );
        };

        const handleDownloadEvents = () => {
          const params = new URLSearchParams();
          if (range) {
            params.set("rangeStart", String(range.start));
            params.set("rangeEnd", String(range.end));
          }
          const qs = params.toString();
          const url = `/api/health/rate-limits/by-user/${encodeURIComponent(userId)}/events.csv${qs ? `?${qs}` : ""}`;
          const a = document.createElement("a");
          a.href = url;
          a.download = `rate-limit-events-${safeFilenamePart(displayName)}.csv`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        };

        return (
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={handleDownloadBuckets}
              disabled={!data || data.buckets.length === 0}
              data-testid={`button-download-buckets-csv-${userId}`}
              className="h-7 text-xs"
            >
              <Download className="w-3 h-3 mr-1" />
              Buckets CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleDownloadEvents}
              data-testid={`button-download-events-csv-${userId}`}
              className="h-7 text-xs"
            >
              <Download className="w-3 h-3 mr-1" />
              Events CSV{range ? " (range)" : ""}
            </Button>
          </div>
        );
      }}
    />
  );
}

export function IpTimeSeriesChart({ ip }: { ip: string }) {
  return (
    <RateLimitTimeSeriesChart
      id={ip}
      url={`/api/health/rate-limits/by-ip/${encodeURIComponent(ip)}/timeseries`}
      queryKey={["/api/health/rate-limits/by-ip", ip, "timeseries"]}
    />
  );
}

type RangePreset = "all" | "1h" | "24h" | "7d" | "custom";

const RANGE_PRESETS: { value: Exclude<RangePreset, "all" | "custom">; label: string; ms: number }[] = [
  { value: "1h", label: "Last 1h", ms: 60 * 60 * 1000 },
  { value: "24h", label: "Last 24h", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
];

function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(s: string): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

function RateLimitTimeSeriesChart({
  id,
  url,
  queryKey,
  renderActions,
}: {
  id: string;
  url: string;
  queryKey: unknown[];
  renderActions?: (ctx: {
    data: TimeSeriesResponse | undefined;
    intervalMs: number;
    range: { start: number; end: number } | null;
  }) => React.ReactNode;
}) {
  const { user } = useAuth();
  const chartNs = user?.id ? `admin.rateLimitTimeSeries.${user.id}.${id}` : null;
  const validInterval = (v: unknown): v is number =>
    typeof v === "number" && INTERVAL_OPTIONS.some((o) => o.ms === v);
  const validPreset = (v: unknown): v is RangePreset =>
    v === "all" || v === "custom" || RANGE_PRESETS.some((p) => p.value === v);
  const [intervalMs, setIntervalMs] = usePersistentState<number>(
    chartNs ? `${chartNs}.intervalMs` : null,
    5 * 60 * 1000,
    validInterval,
  );
  const isTabVisible = useTabVisibility();
  const [preset, setPreset] = usePersistentState<RangePreset>(
    chartNs ? `${chartNs}.preset` : null,
    "all",
    validPreset,
  );
  const [customStart, setCustomStart] = useState<string>(() => toLocalInput(Date.now() - 24 * 60 * 60 * 1000));
  const [customEnd, setCustomEnd] = useState<string>(() => toLocalInput(Date.now()));
  // Anchor "now" for sliding presets. Refreshed every 30s to match the
  // refetch interval, so the queryKey is stable between ticks instead of
  // changing on every render.
  const [presetAnchor, setPresetAnchor] = useState<number>(() => Date.now());

  useEffect(() => {
    if (preset !== "1h" && preset !== "24h" && preset !== "7d") return;
    setPresetAnchor(Date.now());
    const id = setInterval(() => setPresetAnchor(Date.now()), 30000);
    return () => clearInterval(id);
  }, [preset]);

  let range: { start: number; end: number } | null = null;
  if (preset === "custom") {
    const s = fromLocalInput(customStart);
    const e = fromLocalInput(customEnd);
    if (s !== null && e !== null && e > s) range = { start: s, end: e };
  } else if (preset !== "all") {
    const ms = RANGE_PRESETS.find((p) => p.value === preset)!.ms;
    range = { start: presetAnchor - ms, end: presetAnchor };
  }

  const customInvalid = preset === "custom" && range === null;
  const rangeKey = range ? `${range.start}-${range.end}` : "all";

  const { data, isLoading } = useQuery<TimeSeriesResponse>({
    queryKey: [...queryKey, intervalMs, rangeKey],
    queryFn: async () => {
      const params = new URLSearchParams({ intervalMs: String(intervalMs) });
      if (range) {
        params.set("rangeStart", String(range.start));
        params.set("rangeEnd", String(range.end));
      }
      const res = await fetch(`${url}?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch time series");
      return res.json();
    },
    enabled: !customInvalid,
    refetchInterval: isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });

  const chartData = (data?.buckets || []).map((b) => {
    const row: Record<string, number | string> = {
      bucketStart: b.bucketStart,
      label: formatBucketLabel(b.bucketStart, intervalMs),
    };
    for (const cat of data?.categories || []) {
      row[cat] = b.categories[cat] || 0;
    }
    return row;
  });

  return (
    <div data-testid={`chart-timeseries-${id}`}>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="text-sm font-medium text-muted-foreground">Blocked Requests Over Time</div>
        {renderActions ? renderActions({ data, intervalMs, range }) : null}
      </div>
      <div className="flex items-center justify-end mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-1 flex-wrap" data-testid={`range-selector-${id}`}>
          <span className="text-xs text-muted-foreground mr-1">Range:</span>
          {(["all", ...RANGE_PRESETS.map((p) => p.value), "custom"] as RangePreset[]).map((p) => {
            const label = p === "all" ? "All" : p === "custom" ? "Custom" : RANGE_PRESETS.find((rp) => rp.value === p)!.label;
            return (
              <button
                key={p}
                onClick={() => setPreset(p)}
                data-testid={`button-range-${p}-${id}`}
                className={`text-xs px-2 py-1 rounded border transition-colors ${
                  preset === p
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card text-muted-foreground border-primary/20 hover:border-primary/50"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      {preset === "custom" && (
        <div className="flex items-center justify-end mb-2 flex-wrap gap-2" data-testid={`custom-range-${id}`}>
          <label className="text-xs text-muted-foreground flex items-center gap-1">
            From
            <Input
              type="datetime-local"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              data-testid={`input-range-start-${id}`}
              className="h-7 text-xs w-44"
            />
          </label>
          <label className="text-xs text-muted-foreground flex items-center gap-1">
            To
            <Input
              type="datetime-local"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              data-testid={`input-range-end-${id}`}
              className="h-7 text-xs w-44"
            />
          </label>
          {preset === "custom" && range === null && (
            <span className="text-xs text-red-600 dark:text-red-300" data-testid={`text-range-error-${id}`}>
              Pick a valid From/To range
            </span>
          )}
        </div>
      )}
      <div className="flex items-center justify-end mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-1" data-testid={`interval-selector-${id}`}>
          <span className="text-xs text-muted-foreground mr-1">Interval:</span>
          {INTERVAL_OPTIONS.map((opt) => (
            <button
              key={opt.ms}
              onClick={() => setIntervalMs(opt.ms)}
              data-testid={`button-interval-${opt.ms}-${id}`}
              className={`text-xs px-2 py-1 rounded border transition-colors ${
                intervalMs === opt.ms
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground border-primary/20 hover:border-primary/50"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground py-8 text-center">Loading chart...</div>
      ) : chartData.length === 0 ? (
        <div className="text-xs text-muted-foreground py-8 text-center" data-testid={`text-no-timeseries-${id}`}>
          No events to chart yet.
        </div>
      ) : (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
              <Tooltip
                contentStyle={{ fontSize: 12 }}
                labelFormatter={(label, payload) => {
                  const raw = payload?.[0]?.payload?.bucketStart;
                  return typeof raw === "number" ? formatBucketTooltip(raw, intervalMs) : String(label);
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {(data?.categories || []).map((cat, idx) => (
                <Bar key={cat} dataKey={cat} stackId="cat" fill={getCategoryHex(cat, idx)} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}


function formatBucketLabel(ts: number, intervalMs: number): string {
  if (intervalMs >= 24 * 60 * 60 * 1000) return format(new Date(ts), "MMM d");
  if (intervalMs >= 60 * 60 * 1000) return format(new Date(ts), "MMM d HH:mm");
  return format(new Date(ts), "HH:mm");
}

function formatBucketTooltip(ts: number, intervalMs: number): string {
  const start = new Date(ts);
  const end = new Date(ts + intervalMs);
  if (intervalMs >= 24 * 60 * 60 * 1000) {
    return `${format(start, "MMM d, yyyy")}`;
  }
  return `${format(start, "MMM d HH:mm")} – ${format(end, "HH:mm")}`;
}
