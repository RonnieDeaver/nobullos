// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { XCircle, BellOff, Bell } from "lucide-react";
import { useState, useEffect } from "react";
import type { ManualReserveAlertDispatch } from "./types";

function nextLocalMidnightMs(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

function formatMuteRemaining(mutedUntil: number, now: number): string {
  const ms = Math.max(0, mutedUntil - now);
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "less than a minute";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function SuppressedDuringMuteSection({
  windowMs,
  enabled,
  isTabVisible,
  pollingInterval,
  onJumpToAudit,
}: {
  windowMs: number;
  enabled: boolean;
  isTabVisible: boolean;
  pollingInterval: number;
  onJumpToAudit: () => void;
}) {
  const { data, isLoading, error, refetch } = useQuery<{
    dispatches: ManualReserveAlertDispatch[];
  }>({
    queryKey: ["/api/health/manual-reserve-alerts", "suppressed", windowMs],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("since", String(Date.now() - windowMs));
      params.set("limit", "50");
      params.set("eventType", "muted");
      const res = await fetch(`/api/health/manual-reserve-alerts?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return res.json();
    },
    enabled,
    refetchInterval: isTabVisible ? pollingInterval : false,
    refetchIntervalInBackground: false,
  });

  const rows = data?.dispatches ?? [];

  if (!enabled) return null;

  return (
    <div
      className="mb-4 rounded-md border border-border bg-card p-3"
      data-testid="section-suppressed-during-mute"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <BellOff className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground" data-testid="text-suppressed-during-mute-title">
            Suppressed during mute
          </span>
          <Badge
            variant="outline"
            className="bg-muted/50 text-foreground border-border"
            data-testid="badge-suppressed-count"
          >
            {rows.length}
          </Badge>
        </div>
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={onJumpToAudit}
          data-testid="button-jump-to-audit"
        >
          View full audit
        </button>
      </div>
      {isLoading && !data && (
        <div className="text-xs text-muted-foreground" data-testid="text-suppressed-loading">
          Loading suppressed alerts…
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md p-2" data-testid="text-suppressed-error">
          <XCircle className="w-3 h-3 shrink-0" />
          <span>Failed to load suppressed alerts.</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() => refetch()}
            data-testid="button-retry-suppressed"
          >
            Retry
          </Button>
        </div>
      )}
      {!isLoading && !error && rows.length === 0 && (
        <div className="text-xs text-muted-foreground" data-testid="text-suppressed-empty">
          No alerts have been suppressed by an active mute window in the selected range.
        </div>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse" data-testid="table-suppressed-during-mute">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Time</th>
                <th className="py-1 pr-3 font-medium">Metric</th>
                <th className="py-1 pr-3 font-medium">Severity</th>
                <th className="py-1 pr-3 font-medium text-right">Value</th>
                <th className="py-1 pr-3 font-medium text-right">Threshold</th>
                <th className="py-1 pr-3 font-medium">Mute window</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 10).map((d, idx) => (
                <tr
                  key={`${d.timestamp}-${d.metric}-${d.severity}-${idx}`}
                  className="border-b last:border-b-0 align-top"
                  data-testid={`row-suppressed-${idx}`}
                >
                  <td className="py-1 pr-3 whitespace-nowrap" data-testid={`text-suppressed-time-${idx}`}>
                    {new Date(d.timestamp).toLocaleString()}
                  </td>
                  <td className="py-1 pr-3 font-mono" data-testid={`text-suppressed-metric-${idx}`}>
                    {d.metric}
                  </td>
                  <td className="py-1 pr-3" data-testid={`text-suppressed-severity-${idx}`}>
                    <Badge
                      variant="outline"
                      className={
                        d.severity === "critical"
                          ? "bg-red-50 text-red-700 border-red-200"
                          : d.severity === "warning"
                          ? "bg-amber-50 text-amber-700 border-amber-200"
                          : "bg-muted/50 text-muted-foreground border-border"
                      }
                    >
                      {d.severity}
                    </Badge>
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums" data-testid={`text-suppressed-value-${idx}`}>
                    {d.value}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums text-muted-foreground" data-testid={`text-suppressed-threshold-${idx}`}>
                    {d.threshold}
                  </td>
                  <td className="py-1 pr-3 text-xs text-muted-foreground" data-testid={`text-suppressed-mute-${idx}`}>
                    {d.mutedBy && (
                      <div>
                        by <span className="font-medium">{d.mutedBy}</span>
                      </div>
                    )}
                    {d.muteReason && <div className="italic">{d.muteReason}</div>}
                    {d.detail && (
                      <div className="text-muted-foreground" data-testid={`text-suppressed-detail-${idx}`}>
                        {d.detail}
                      </div>
                    )}
                    {!d.mutedBy && !d.muteReason && !d.detail && (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 10 && (
            <div className="mt-1 text-xs text-muted-foreground" data-testid="text-suppressed-more">
              +{rows.length - 10} more — see the full audit log below.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ManualReserveMuteControl({
  muteState,
  onMute,
  onMuteUntil,
  onUnmute,
  isPendingSet,
  isPendingClear,
}: {
  muteState: {
    muted: boolean;
    mutedUntil: number | null;
    mutedAt: number | null;
    mutedBy: string | null;
    reason: string | null;
    source?: "manual" | "auto" | null;
    jobId?: string | null;
    jobLabel?: string | null;
  } | null;
  onMute: (durationMs: number) => void;
  onMuteUntil: (ts: number) => void;
  onUnmute: () => void;
  isPendingSet: boolean;
  isPendingClear: boolean;
}) {
  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTickNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const muted = !!muteState?.muted && !!muteState.mutedUntil && muteState.mutedUntil > tickNow;
  const disabled = isPendingSet || isPendingClear;

  if (muted && muteState?.mutedUntil) {
    const isAutoMute = muteState.source === "auto";
    return (
      <div
        className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-200 bg-amber-50 p-3"
        data-testid="section-manual-reserve-mute-active"
      >
        <BellOff className="w-4 h-4 text-amber-700 shrink-0" />
        <div className="text-xs text-amber-900 flex-1 min-w-[12rem]">
          <div className="font-medium" data-testid="text-mute-active">
            {isAutoMute
              ? `Manual reserve alerts auto-muted by ${muteState.jobLabel ?? "background job"} — dispatch paused`
              : "Manual reserve alerts muted — dispatch paused"}
          </div>
          <div className="text-amber-800" data-testid="text-mute-until">
            Until {new Date(muteState.mutedUntil).toLocaleString()} ({formatMuteRemaining(muteState.mutedUntil, tickNow)} left)
          </div>
          {isAutoMute && muteState.jobId && (
            <div className="text-amber-800 mt-0.5" data-testid="text-mute-source">
              Source: auto-muted by job {muteState.jobLabel ?? "(unknown)"} ({muteState.jobId})
            </div>
          )}
          {muteState.reason && (
            <div className="text-amber-800 mt-0.5" data-testid="text-mute-reason">
              Reason: {muteState.reason}
            </div>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onUnmute}
          disabled={disabled}
          data-testid="button-unmute-manual-reserve"
        >
          <Bell className="w-3 h-3 mr-1" />
          {isPendingClear ? "Unmuting..." : "Unmute now"}
        </Button>
      </div>
    );
  }

  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 p-3"
      data-testid="section-manual-reserve-mute-controls"
    >
      <BellOff className="w-4 h-4 text-muted-foreground shrink-0" />
      <div className="text-xs text-foreground mr-2">
        <span className="font-medium">Mute manual reserve alerts</span>
        <span className="text-muted-foreground ml-1">— for planned background backfills</span>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onMute(60 * 60_000)}
        data-testid="button-mute-1h"
      >
        1 hour
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onMute(4 * 60 * 60_000)}
        data-testid="button-mute-4h"
      >
        4 hours
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onMuteUntil(nextLocalMidnightMs())}
        data-testid="button-mute-until-tomorrow"
      >
        Until tomorrow
      </Button>
    </div>
  );
}