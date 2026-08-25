// Rate Limits admin — Delivery Ops panel — digest growth, auto-retry, max-attempts warning, test alerts.
// Extracted VERBATIM from the former 5.9k-line RateLimitUsers.tsx monolith
// (house aggregator pattern, cf. ClickUpModule / Task #3787; this split:
// F11C / Task #4159). The page composition root is
// client/src/pages/admin/RateLimitUsers.tsx — new rate-limit admin UI
// belongs here (or in a new sibling module), never in the aggregator.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";
import { formatTime, statusBadgeClass } from "./shared";

type AutoRetryConfig = {
  enabled: boolean;
  maxAttempts: number;
  minIntervalMinutes: number;
  lookbackHours: number;
};

type DigestGrowthHistory = {
  samples: Array<{ at: number; pending: number }>;
  max: number;
};

export type DigestGrowthInfo = {
  config: {
    enabled: boolean;
    warnAt: number;
    cooldownMinutes: number;
    overdueMultiplier: number;
    autoFlushOnOverdue: boolean;
  };
  state: {
    lastWarningAt: number | null;
    lastWarningPending: number | null;
    lastWarningStatus: string | null;
    lastWarningError: string | null;
    lastWarningReason: "threshold" | "overdue" | null;
  };
  pending: number;
  triggered: boolean;
  overdue: boolean;
  overdueByMs: number | null;
  expectedFlushBy: number | null;
  lastFlushAt: number | null;
  cadence: "realtime" | "hourly" | "daily";
};

type MaxAttemptsWarningInfo = {
  config: {
    enabled: boolean;
    cooldownMinutes: number;
  };
  state: {
    chains: Record<
      string,
      {
        lastWarningAt: number;
        lastWarningStatus: "sent" | "failed" | "skipped";
        lastWarningError: string | null;
        attemptNumber: number;
      }
    >;
  };
  trackedChains: number;
};

type LastTestAlertResp = {
  lastTest: {
    attemptedAt: number;
    actorId: string | null;
    outcomes: Array<{
      channel: string;
      destination: string;
      status: string;
      errorMessage: string | null;
      latencyMs: number | null;
    }>;
  } | null;
};

function DigestGrowthSparkline({
  samples,
  warnAt,
  triggered,
}: {
  samples: Array<{ at: number; pending: number }>;
  warnAt: number;
  triggered: boolean;
}) {
  if (samples.length < 2) {
    return (
      <div
        className="text-xs text-muted-foreground italic"
        data-testid="text-growth-sparkline-empty"
      >
        Collecting…
      </div>
    );
  }
  const W = 96;
  const H = 28;
  const PAD = 2;
  const values = samples.map((s) => s.pending);
  const dataMax = Math.max(...values, warnAt, 1);
  const dataMin = Math.min(...values, 0);
  const range = Math.max(1, dataMax - dataMin);
  const scaleX = (i: number) =>
    PAD + (samples.length === 1 ? 0 : (i / (samples.length - 1)) * (W - PAD * 2));
  const scaleY = (v: number) => H - PAD - ((v - dataMin) / range) * (H - PAD * 2);
  const linePath = samples
    .map((s, i) => `${i === 0 ? "M" : "L"}${scaleX(i).toFixed(1)},${scaleY(s.pending).toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L${scaleX(samples.length - 1).toFixed(1)},${(H - PAD).toFixed(
    1,
  )} L${scaleX(0).toFixed(1)},${(H - PAD).toFixed(1)} Z`;
  const stroke = triggered ? "#b45309" : "hsl(var(--primary))";
  const fill = triggered ? "rgba(180,83,9,0.12)" : "hsl(var(--primary) / 0.10)";
  const thresholdY =
    warnAt >= dataMin && warnAt <= dataMax ? scaleY(warnAt) : null;
  const first = samples[0].pending;
  const last = samples[samples.length - 1].pending;
  const delta = last - first;
  const spanMs = samples[samples.length - 1].at - samples[0].at;
  const spanMin = Math.max(1, Math.round(spanMs / 60_000));
  const trendArrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "▬";
  const trendColor =
    delta > 0 ? "text-amber-700 dark:text-amber-300" : delta < 0 ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground";
  return (
    <div
      className="flex flex-col items-end gap-0.5"
      title={`${samples.length} samples over ~${spanMin}m · min ${dataMin} · max ${dataMax}`}
      data-testid="sparkline-digest-growth"
    >
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block"
        aria-label="Digest queue size over time"
      >
        <path d={areaPath} fill={fill} stroke="none" />
        {thresholdY != null ? (
          <line
            x1={PAD}
            x2={W - PAD}
            y1={thresholdY}
            y2={thresholdY}
            stroke="#b45309"
            strokeWidth={1}
            strokeDasharray="2 2"
            opacity={0.6}
          />
        ) : null}
        <path d={linePath} fill="none" stroke={stroke} strokeWidth={1.25} />
        <circle
          cx={scaleX(samples.length - 1)}
          cy={scaleY(last)}
          r={1.75}
          fill={stroke}
        />
      </svg>
      <div
        className={`text-xs font-mono ${trendColor}`}
        data-testid="text-growth-sparkline-delta"
      >
        {trendArrow} {delta > 0 ? "+" : ""}
        {delta} / {spanMin}m
      </div>
    </div>
  );
}

export function DeliveryOpsPanel() {
  const { toast } = useToast();
  const isTabVisible = useTabVisibility();
  const queryClient = useQueryClient();

  const autoRetryQ = useQuery<AutoRetryConfig>({
    queryKey: ["/api/health/rate-limits/auto-retry-config"],
    queryFn: async () => {
      const r = await fetch("/api/health/rate-limits/auto-retry-config", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load auto-retry config");
      return r.json();
    },
  });
  const growthQ = useQuery<DigestGrowthInfo>({
    queryKey: ["/api/health/rate-limits/digest-growth"],
    queryFn: async () => {
      const r = await fetch("/api/health/rate-limits/digest-growth", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load digest growth info");
      return r.json();
    },
    refetchInterval: isTabVisible ? 30000 : false,
  });
  const growthHistoryQ = useQuery<DigestGrowthHistory>({
    queryKey: ["/api/health/rate-limits/digest-growth/history"],
    queryFn: async () => {
      const r = await fetch("/api/health/rate-limits/digest-growth/history", {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to load digest growth history");
      return r.json();
    },
    refetchInterval: isTabVisible ? 30000 : false,
  });
  const maxAttemptsQ = useQuery<MaxAttemptsWarningInfo>({
    queryKey: ["/api/health/rate-limits/max-attempts-warning"],
    queryFn: async () => {
      const r = await fetch("/api/health/rate-limits/max-attempts-warning", {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to load max-attempts warning info");
      return r.json();
    },
    refetchInterval: isTabVisible ? 30000 : false,
  });
  const lastTestQ = useQuery<LastTestAlertResp>({
    queryKey: ["/api/health/rate-limits/last-test-alert"],
    queryFn: async () => {
      const r = await fetch("/api/health/rate-limits/last-test-alert", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load last test alert");
      return r.json();
    },
  });

  const [autoDraft, setAutoDraft] = useState<AutoRetryConfig | null>(null);
  useEffect(() => {
    if (autoRetryQ.data && !autoDraft) setAutoDraft(autoRetryQ.data);
  }, [autoRetryQ.data, autoDraft]);
  const [growthDraft, setGrowthDraft] = useState<DigestGrowthInfo["config"] | null>(null);
  useEffect(() => {
    if (growthQ.data?.config && !growthDraft) setGrowthDraft(growthQ.data.config);
  }, [growthQ.data, growthDraft]);
  const [maxAttemptsDraft, setMaxAttemptsDraft] = useState<
    MaxAttemptsWarningInfo["config"] | null
  >(null);
  useEffect(() => {
    if (maxAttemptsQ.data?.config && !maxAttemptsDraft)
      setMaxAttemptsDraft(maxAttemptsQ.data.config);
  }, [maxAttemptsQ.data, maxAttemptsDraft]);

  const [savingAuto, setSavingAuto] = useState(false);
  const [savingGrowth, setSavingGrowth] = useState(false);
  const [savingMaxAttempts, setSavingMaxAttempts] = useState(false);
  const [runningAuto, setRunningAuto] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);

  const saveAuto = async () => {
    if (!autoDraft) return;
    setSavingAuto(true);
    try {
      const r = await fetch("/api/health/rate-limits/auto-retry-config", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(autoDraft),
      });
      if (!r.ok) throw new Error(`Failed (${r.status})`);
      const next = (await r.json()) as AutoRetryConfig;
      setAutoDraft(next);
      void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/auto-retry-config"] }); // fire-and-forget: cache refresh only
      toast({ title: "Auto-retry settings saved" });
    } catch (e: unknown) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : "Could not save auto-retry settings",
        variant: "destructive",
      });
    } finally {
      setSavingAuto(false);
    }
  };
  const saveGrowth = async () => {
    if (!growthDraft) return;
    setSavingGrowth(true);
    try {
      const r = await fetch("/api/health/rate-limits/digest-growth", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(growthDraft),
      });
      if (!r.ok) throw new Error(`Failed (${r.status})`);
      const next = await r.json();
      setGrowthDraft(next);
      void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/digest-growth"] }); // fire-and-forget: cache refresh only
      toast({ title: "Digest growth settings saved" });
    } catch (e: unknown) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : "Could not save digest growth settings",
        variant: "destructive",
      });
    } finally {
      setSavingGrowth(false);
    }
  };
  const saveMaxAttempts = async () => {
    if (!maxAttemptsDraft) return;
    setSavingMaxAttempts(true);
    try {
      const r = await fetch("/api/health/rate-limits/max-attempts-warning", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(maxAttemptsDraft),
      });
      if (!r.ok) throw new Error(`Failed (${r.status})`);
      const next = (await r.json()) as MaxAttemptsWarningInfo["config"];
      setMaxAttemptsDraft(next);
      void queryClient.invalidateQueries({
        queryKey: ["/api/health/rate-limits/max-attempts-warning"],
      }); // fire-and-forget: cache refresh only
      toast({ title: "Max-attempts warning settings saved" });
    } catch (e: unknown) {
      toast({
        title: "Save failed",
        description:
          e instanceof Error ? e.message : "Could not save max-attempts warning settings",
        variant: "destructive",
      });
    } finally {
      setSavingMaxAttempts(false);
    }
  };
  const runAutoNow = async () => {
    setRunningAuto(true);
    try {
      const r = await fetch("/api/health/rate-limits/auto-retry-run", {
        method: "POST",
        credentials: "include",
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json?.error || `Failed (${r.status})`);
      toast({
        title: "Auto-retry run complete",
        description: `scanned=${json.scanned} retried=${json.retried} skipped=${json.skipped}`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/notifications"] }); // fire-and-forget: cache refresh only
    } catch (e: unknown) {
      toast({
        title: "Auto-retry run failed",
        description: e instanceof Error ? e.message : "Could not run auto-retry",
        variant: "destructive",
      });
    } finally {
      setRunningAuto(false);
    }
  };
  const sendTest = async () => {
    setSendingTest(true);
    try {
      const r = await fetch("/api/health/rate-limits/test-alert", {
        method: "POST",
        credentials: "include",
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json?.error || `Failed (${r.status})`);
      toast({
        title: "Test alert sent",
        description: (json?.lastTest?.outcomes ?? [])
          .map((o: any) => `${o.channel}: ${o.status}`)
          .join(" · ") || "No destinations configured",
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/last-test-alert"] }); // fire-and-forget: cache refresh only
    } catch (e: unknown) {
      toast({
        title: "Test alert failed",
        description: e instanceof Error ? e.message : "Could not send test alert",
        variant: "destructive",
      });
    } finally {
      setSendingTest(false);
    }
  };

  const lastTest = lastTestQ.data?.lastTest ?? null;
  const growth = growthQ.data;
  const maxAttempts = maxAttemptsQ.data;
  const recentMaxAttemptsChains = useMemo(() => {
    if (!maxAttempts?.state?.chains) return [] as Array<
      [string, MaxAttemptsWarningInfo["state"]["chains"][string]]
    >;
    return Object.entries(maxAttempts.state.chains)
      .sort((a, b) => b[1].lastWarningAt - a[1].lastWarningAt)
      .slice(0, 5);
  }, [maxAttempts]);

  return (
    <Card data-testid="card-delivery-ops">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          Delivery Ops
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Test alerts, queue growth warnings, and auto-retry settings for rate-limit notifications.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Test alert */}
        <div className="border rounded-md p-3" data-testid="panel-test-alert">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Send a test alert</div>
              <div className="text-xs text-muted-foreground">
                Pushes a synthetic warning through every configured channel and saves the outcome.
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={sendTest}
              disabled={sendingTest}
              data-testid="button-send-test-alert"
            >
              {sendingTest ? "Sending…" : "Send test alert"}
            </Button>
          </div>
          {lastTest ? (
            <div
              className="mt-2 text-xs space-y-1 border-t pt-2"
              data-testid="panel-last-test-alert"
            >
              <div className="text-muted-foreground">
                Last sent {formatTime(lastTest.attemptedAt)}
              </div>
              {lastTest.outcomes.map((o, i) => (
                <div
                  key={`${o.channel}-${i}`}
                  className="flex items-center gap-2"
                  data-testid={`text-last-test-outcome-${i}`}
                >
                  <Badge className={`text-xs ${statusBadgeClass(o.status)}`}>
                    {o.channel}: {o.status}
                  </Badge>
                  <span className="font-mono text-xs">
                    {typeof o.latencyMs === "number" ? `${o.latencyMs}ms` : "—"}
                  </span>
                  {o.errorMessage ? (
                    <span className="text-red-700 dark:text-red-300 text-xs">{o.errorMessage}</span>
                  ) : (
                    <span className="text-muted-foreground text-xs break-all">
                      {o.destination}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 text-xs text-muted-foreground" data-testid="text-no-last-test">
              No test alert has been sent yet.
            </div>
          )}
        </div>

        {/* Digest queue growth */}
        <div className="border rounded-md p-3" data-testid="panel-digest-growth">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">Queued-digest growth warning</div>
              <div className="text-xs text-muted-foreground">
                Sends a one-off Slack/email warning when the pending digest queue stays above the
                threshold, or when the last successful flush is older than the cadence interval ×
                overdue multiplier. The dashboard also shows a banner while either condition is
                active.
              </div>
            </div>
            {growth ? (
              <div className="flex items-center gap-2">
                <DigestGrowthSparkline
                  samples={growthHistoryQ.data?.samples ?? []}
                  warnAt={growth.config.warnAt}
                  triggered={growth.triggered}
                />
                <div className="flex flex-col items-end gap-1">
                  <Badge
                    className={`text-xs ${growth.triggered ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300" : "bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300"}`}
                    data-testid="badge-growth-status"
                  >
                    {growth.pending} pending / {growth.config.warnAt} threshold
                  </Badge>
                  {growth.overdue && growth.overdueByMs != null ? (
                    <Badge
                      className="text-xs bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                      data-testid="badge-growth-overdue"
                    >
                      Flush overdue by {Math.round(growth.overdueByMs / 60_000)}m
                    </Badge>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
          {growthDraft ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={growthDraft.enabled}
                  onChange={(e) =>
                    setGrowthDraft({ ...growthDraft, enabled: e.target.checked })
                  }
                  data-testid="checkbox-growth-enabled"
                />
                Enabled
              </label>
              <div className="flex flex-col gap-1">
                <label htmlFor="input-growth-warn-at" className="text-xs uppercase tracking-wide text-muted-foreground">
                  Warn at (pending count)
                </label>
                <Input
                  id="input-growth-warn-at"
                  type="number"
                  min={1}
                  max={5000}
                  value={growthDraft.warnAt}
                  onChange={(e) =>
                    setGrowthDraft({ ...growthDraft, warnAt: Number(e.target.value) || 0 })
                  }
                  className="h-8 w-28 text-xs"
                  data-testid="input-growth-warn-at"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="input-growth-cooldown" className="text-xs uppercase tracking-wide text-muted-foreground">
                  Cooldown (min)
                </label>
                <Input
                  id="input-growth-cooldown"
                  type="number"
                  min={1}
                  max={10080}
                  value={growthDraft.cooldownMinutes}
                  onChange={(e) =>
                    setGrowthDraft({
                      ...growthDraft,
                      cooldownMinutes: Number(e.target.value) || 0,
                    })
                  }
                  className="h-8 w-24 text-xs"
                  data-testid="input-growth-cooldown"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="input-growth-overdue-multiplier" className="text-xs uppercase tracking-wide text-muted-foreground">
                  Overdue × interval
                </label>
                <Input
                  id="input-growth-overdue-multiplier"
                  type="number"
                  min={1}
                  max={100}
                  step={0.5}
                  value={growthDraft.overdueMultiplier}
                  onChange={(e) =>
                    setGrowthDraft({
                      ...growthDraft,
                      overdueMultiplier: Number(e.target.value) || 0,
                    })
                  }
                  className="h-8 w-24 text-xs"
                  data-testid="input-growth-overdue-multiplier"
                />
              </div>
              <label
                className="flex items-center gap-1 text-xs"
                title="When the overdue warning fires, also call flushDigestNow so destinations that recover on their own catch up automatically. Rides the warning's cooldown."
              >
                <input
                  type="checkbox"
                  checked={growthDraft.autoFlushOnOverdue}
                  onChange={(e) =>
                    setGrowthDraft({
                      ...growthDraft,
                      autoFlushOnOverdue: e.target.checked,
                    })
                  }
                  data-testid="checkbox-growth-auto-flush-on-overdue"
                />
                Auto-flush on overdue
              </label>
              <Button
                type="button"
                size="sm"
                onClick={saveGrowth}
                disabled={savingGrowth}
                data-testid="button-save-growth"
              >
                {savingGrowth ? "Saving…" : "Save"}
              </Button>
            </div>
          ) : null}
          {growth?.state.lastWarningAt ? (
            <div className="mt-2 text-xs text-muted-foreground" data-testid="text-growth-last">
              Last warning {formatTime(growth.state.lastWarningAt)} —{" "}
              {growth.state.lastWarningReason ?? "threshold"} reason, pending was{" "}
              {growth.state.lastWarningPending} (status: {growth.state.lastWarningStatus ?? "—"})
              {growth.state.lastWarningError ? ` · ${growth.state.lastWarningError}` : ""}
            </div>
          ) : null}
        </div>

        {/* Max-attempts-reached warning (Task #793) */}
        <div className="border rounded-md p-3" data-testid="panel-max-attempts-warning">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <div className="text-sm font-medium">Auto-retry exhausted warning</div>
              <div className="text-xs text-muted-foreground">
                Sends a one-shot Slack/email warning when a delivery chain reaches the auto-retry
                attempt cap and stops being retried, so persistently broken destinations
                (revoked tokens, bounced addresses, etc.) get noticed instead of sitting in
                history. Cooldown keeps the same chain from re-warning while the destination
                stays broken.
              </div>
            </div>
            {maxAttempts ? (
              <Badge
                className="text-xs bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300"
                data-testid="badge-max-attempts-tracked"
              >
                {maxAttempts.trackedChains} tracked
              </Badge>
            ) : null}
          </div>
          {maxAttemptsDraft ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={maxAttemptsDraft.enabled}
                  onChange={(e) =>
                    setMaxAttemptsDraft({ ...maxAttemptsDraft, enabled: e.target.checked })
                  }
                  data-testid="checkbox-max-attempts-enabled"
                />
                Enabled
              </label>
              <div className="flex flex-col gap-1">
                <label htmlFor="input-max-attempts-cooldown" className="text-xs uppercase tracking-wide text-muted-foreground">
                  Cooldown (min)
                </label>
                <Input
                  id="input-max-attempts-cooldown"
                  type="number"
                  min={1}
                  max={43200}
                  value={maxAttemptsDraft.cooldownMinutes}
                  onChange={(e) =>
                    setMaxAttemptsDraft({
                      ...maxAttemptsDraft,
                      cooldownMinutes: Number(e.target.value) || 0,
                    })
                  }
                  className="h-8 w-28 text-xs"
                  data-testid="input-max-attempts-cooldown"
                />
              </div>
              <Button
                type="button"
                size="sm"
                onClick={saveMaxAttempts}
                disabled={savingMaxAttempts}
                data-testid="button-save-max-attempts"
              >
                {savingMaxAttempts ? "Saving…" : "Save"}
              </Button>
            </div>
          ) : null}
          {recentMaxAttemptsChains.length > 0 ? (
            <div
              className="mt-2 text-xs text-muted-foreground space-y-1 border-t pt-2"
              data-testid="text-max-attempts-recent"
            >
              <div>Recent warnings:</div>
              {recentMaxAttemptsChains.map(([key, entry]) => (
                <div
                  key={key}
                  className="flex items-center gap-2"
                  data-testid={`text-max-attempts-entry-${key}`}
                >
                  <Badge className={`text-xs ${statusBadgeClass(entry.lastWarningStatus)}`}>
                    {entry.lastWarningStatus}
                  </Badge>
                  <span className="font-mono text-xs truncate max-w-[260px]">{key}</span>
                  <span>
                    attempt {entry.attemptNumber} · {formatTime(entry.lastWarningAt)}
                  </span>
                  {entry.lastWarningError ? (
                    <span className="text-red-700 dark:text-red-300">· {entry.lastWarningError}</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* Auto-retry config */}
        <div className="border rounded-md p-3" data-testid="panel-auto-retry">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <div className="text-sm font-medium">Background auto-retry</div>
              <div className="text-xs text-muted-foreground">
                Automatically retries failed notifications, bounded by max attempts and a minimum
                interval. Per-row and bulk retry buttons share these limits.
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={runAutoNow}
              disabled={runningAuto}
              data-testid="button-run-auto-retry-now"
            >
              {runningAuto ? "Running…" : "Run pass now"}
            </Button>
          </div>
          {autoDraft ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={autoDraft.enabled}
                  onChange={(e) => setAutoDraft({ ...autoDraft, enabled: e.target.checked })}
                  data-testid="checkbox-auto-retry-enabled"
                />
                Enabled
              </label>
              <div className="flex flex-col gap-1">
                <label htmlFor="input-auto-max-attempts" className="text-xs uppercase tracking-wide text-muted-foreground">
                  Max attempts
                </label>
                <Input
                  id="input-auto-max-attempts"
                  type="number"
                  min={1}
                  max={20}
                  value={autoDraft.maxAttempts}
                  onChange={(e) =>
                    setAutoDraft({ ...autoDraft, maxAttempts: Number(e.target.value) || 1 })
                  }
                  className="h-8 w-20 text-xs"
                  data-testid="input-auto-max-attempts"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="input-auto-min-interval" className="text-xs uppercase tracking-wide text-muted-foreground">
                  Min interval (min)
                </label>
                <Input
                  id="input-auto-min-interval"
                  type="number"
                  min={1}
                  max={1440}
                  value={autoDraft.minIntervalMinutes}
                  onChange={(e) =>
                    setAutoDraft({
                      ...autoDraft,
                      minIntervalMinutes: Number(e.target.value) || 1,
                    })
                  }
                  className="h-8 w-24 text-xs"
                  data-testid="input-auto-min-interval"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="input-auto-lookback" className="text-xs uppercase tracking-wide text-muted-foreground">
                  Lookback (hr)
                </label>
                <Input
                  id="input-auto-lookback"
                  type="number"
                  min={1}
                  max={168}
                  value={autoDraft.lookbackHours}
                  onChange={(e) =>
                    setAutoDraft({ ...autoDraft, lookbackHours: Number(e.target.value) || 1 })
                  }
                  className="h-8 w-20 text-xs"
                  data-testid="input-auto-lookback"
                />
              </div>
              <Button
                type="button"
                size="sm"
                onClick={saveAuto}
                disabled={savingAuto}
                data-testid="button-save-auto-retry"
              >
                {savingAuto ? "Saving…" : "Save"}
              </Button>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
