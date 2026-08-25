// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
import { useMemo } from "react";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Line, XAxis, YAxis, CartesianGrid, ReferenceLine, Area, ComposedChart, Legend } from "recharts";
import type { ChartConfig } from "@/components/ui/chart";
import type { HealthSample, ThresholdConfig, ManualReserveWorkerSamplePoint } from "./types";
// Task #4481: semantic series colors come from the status tokens below;
// the categorical per-worker rotation lives in the documented palette module.
import { PER_WORKER_LINE_COLORS, HEALTH_SERIES_VIOLET } from "@/lib/healthChartPalette";

const chartConfig: ChartConfig = {
  dbLatency: {
    label: "DB round-trip (ms)",
    color: "hsl(var(--primary))",
  },
  // Task #813: secondary series so saturation of the API pool is visible
  // alongside the actual DB round-trip line.
  apiPoolWait: {
    label: "API pool wait (ms)",
    color: "hsl(var(--status-info))",
  },
};

function formatTime(timestamp: number, windowMs?: number): string {
  const d = new Date(timestamp);
  if (windowMs && windowMs > 24 * 60 * 60 * 1000) {
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (windowMs && windowMs > 6 * 60 * 60 * 1000) {
    return d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const CHART_TARGET_POINTS = 360;

function downsampleSamples(samples: HealthSample[], targetPoints: number): HealthSample[] {
  if (samples.length <= targetPoints) return samples;
  const stride = Math.ceil(samples.length / targetPoints);
  const out: HealthSample[] = [];
  for (let i = 0; i < samples.length; i += stride) {
    const end = Math.min(i + stride - 1, samples.length - 1);
    out.push(samples[end]);
  }
  if (out[out.length - 1] !== samples[samples.length - 1]) {
    out.push(samples[samples.length - 1]);
  }
  return out;
}

export function LatencyChart({ samples, thresholds, windowMs }: { samples: HealthSample[]; thresholds: ThresholdConfig | null; windowMs?: number }) {
  const chartData = useMemo(() => {
    const filtered = samples.filter((s) => s.dbLatencyMs !== null || s.apiPoolWaitMs != null);
    const reduced = downsampleSamples(filtered, CHART_TARGET_POINTS);
    return reduced.map((s) => ({
      time: formatTime(s.timestamp, windowMs),
      timestamp: s.timestamp,
      // Task #813: prefer the new dbRoundTripMs field; fall back to the
      // legacy dbLatencyMs alias for older samples persisted before the
      // metric was split.
      dbLatency: s.dbRoundTripMs ?? s.dbLatencyMs,
      apiPoolWait: s.apiPoolWaitMs,
      status: s.status,
    }));
  }, [samples, windowMs]);

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground" data-testid="text-no-latency-data">
        No latency data available yet
      </div>
    );
  }

  const maxLatency = Math.max(
    ...chartData.map((d) => Math.max(d.dbLatency ?? 0, d.apiPoolWait ?? 0)),
  );
  const yMax = Math.max(
    maxLatency * 1.2,
    thresholds ? thresholds.dbLatencyCriticalMs * 1.2 : 0
  );

  return (
    <ChartContainer config={chartConfig} className="h-72 w-full" data-testid="chart-db-latency">
      <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="time"
          tickLine={false}
          axisLine={false}
          className="text-xs"
          interval="preserveStartEnd"
          minTickGap={40}
        />
        <YAxis
          domain={[0, yMax]}
          tickLine={false}
          axisLine={false}
          className="text-xs"
          width={50}
          tickFormatter={(v: number) => `${v}ms`}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                if (payload?.[0]?.payload?.timestamp) {
                  return new Date(payload[0].payload.timestamp).toLocaleString();
                }
                return "";
              }}
              formatter={(value, name) => {
                const label = name === "apiPoolWait"
                  ? "API pool wait"
                  : "DB round-trip";
                return [`${value}ms`, label];
              }}
            />
          }
        />
        {thresholds && (
          <>
            <ReferenceLine
              y={thresholds.dbLatencyWarningMs}
              stroke="hsl(var(--status-warn))"
              strokeDasharray="6 3"
              label={{ value: `Warning (${thresholds.dbLatencyWarningMs}ms)`, position: "insideTopRight", fill: "hsl(var(--status-warn))", fontSize: 11 }}
            />
            <ReferenceLine
              y={thresholds.dbLatencyCriticalMs}
              stroke="hsl(var(--status-critical))"
              strokeDasharray="6 3"
              label={{ value: `Critical (${thresholds.dbLatencyCriticalMs}ms)`, position: "insideTopRight", fill: "hsl(var(--status-critical))", fontSize: 11 }}
            />
          </>
        )}
        <Area
          type="monotone"
          dataKey="dbLatency"
          fill="hsl(var(--primary))"
          fillOpacity={0.08}
          stroke="none"
        />
        <Line
          type="monotone"
          dataKey="dbLatency"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: "hsl(var(--primary))" }}
        />
        {/* Task #813: secondary line shows API pool acquire-wait time so a
            saturated pool is visible without inflating "DB round-trip". */}
        <Line
          type="monotone"
          dataKey="apiPoolWait"
          stroke="hsl(var(--status-info))"
          strokeWidth={1.5}
          strokeDasharray="4 2"
          dot={false}
          activeDot={{ r: 3, fill: "hsl(var(--status-info))" }}
          connectNulls
        />
      </ComposedChart>
    </ChartContainer>
  );
}

const manualReserveChartConfig: ChartConfig = {
  delayedDelta: { label: "Delayed by background (Δ)", color: "hsl(var(--status-warn))" },
  timeoutDelta: { label: "Manual timeouts (Δ)", color: "hsl(var(--status-critical))" },
  saturationDelta: { label: "Background saturation (Δ)", color: HEALTH_SERIES_VIOLET },
  waitAvg: { label: "Manual wait avg (ms)", color: "hsl(var(--primary))" },
  waitP95: { label: "Manual wait p95 (ms)", color: "hsl(var(--status-info))" },
};

export function ManualReserveChart({ samples, windowMs }: { samples: HealthSample[]; windowMs?: number }) {
  const chartData = useMemo(() => {
    const withReserveAll = samples.filter((s) => s.manualReserve !== null);
    const withReserve = downsampleSamples(withReserveAll, CHART_TARGET_POINTS);
    if (withReserve.length === 0) return [];
    const rows: Array<{
      time: string;
      timestamp: number;
      delayedDelta: number;
      timeoutDelta: number;
      saturationDelta: number;
      waitAvg: number | null;
      waitP95: number | null;
    }> = [];
    for (let i = 0; i < withReserve.length; i++) {
      const cur = withReserve[i].manualReserve!;
      const prev = i > 0 ? withReserve[i - 1].manualReserve : null;
      const delta = (curVal: number, prevVal: number | undefined) => {
        if (prevVal === undefined) return 0;
        const d = curVal - prevVal;
        return d >= 0 ? d : curVal;
      };
      rows.push({
        time: formatTime(withReserve[i].timestamp, windowMs),
        timestamp: withReserve[i].timestamp,
        delayedDelta: delta(cur.manualDelayedByBackgroundCount, prev?.manualDelayedByBackgroundCount),
        timeoutDelta: delta(cur.manualTimeoutCount, prev?.manualTimeoutCount),
        saturationDelta: delta(cur.backgroundIngestionSaturationCount, prev?.backgroundIngestionSaturationCount),
        waitAvg: cur.manualWaitAvgMs,
        waitP95: cur.manualWaitP95Ms,
      });
    }
    return rows;
  }, [samples, windowMs]);

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground" data-testid="text-no-manual-reserve-history">
        No manual reserve history yet — values will appear once samples accumulate.
      </div>
    );
  }

  return (
    <ChartContainer config={manualReserveChartConfig} className="h-64 w-full" data-testid="chart-manual-reserve">
      <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="time"
          tickLine={false}
          axisLine={false}
          className="text-xs"
          interval="preserveStartEnd"
          minTickGap={40}
        />
        <YAxis
          yAxisId="counts"
          tickLine={false}
          axisLine={false}
          className="text-xs"
          width={40}
          allowDecimals={false}
        />
        <YAxis
          yAxisId="wait"
          orientation="right"
          tickLine={false}
          axisLine={false}
          className="text-xs"
          width={50}
          tickFormatter={(v: number) => `${v}ms`}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                if (payload?.[0]?.payload?.timestamp) {
                  return new Date(payload[0].payload.timestamp).toLocaleString();
                }
                return "";
              }}
            />
          }
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line yAxisId="counts" type="monotone" dataKey="delayedDelta" name="Delayed by bg (Δ)" stroke="hsl(var(--status-warn))" strokeWidth={2} dot={false} />
        <Line yAxisId="counts" type="monotone" dataKey="timeoutDelta" name="Timeouts (Δ)" stroke="hsl(var(--status-critical))" strokeWidth={2} dot={false} />
        <Line yAxisId="counts" type="monotone" dataKey="saturationDelta" name="Bg saturation (Δ)" stroke={HEALTH_SERIES_VIOLET} strokeWidth={2} dot={false} />
        <Line yAxisId="wait" type="monotone" dataKey="waitAvg" name="Wait avg (ms)" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} strokeDasharray="4 2" connectNulls />
        <Line yAxisId="wait" type="monotone" dataKey="waitP95" name="Wait p95 (ms)" stroke="hsl(var(--status-info))" strokeWidth={2} dot={false} strokeDasharray="4 2" connectNulls />
      </ComposedChart>
    </ChartContainer>
  );
}

export function ManualReserveByWorkerChart({
  samples,
  windowMs,
  selectedWorkers,
}: {
  samples: ManualReserveWorkerSamplePoint[];
  windowMs?: number;
  selectedWorkers?: Set<string> | null;
}) {
  const showAll = !selectedWorkers || selectedWorkers.size === 0;
  const soloWorker = !showAll && selectedWorkers.size === 1
    ? Array.from(selectedWorkers)[0]
    : null;

  const { chartData, workers } = useMemo(() => {
    if (samples.length === 0) return { chartData: [] as Array<Record<string, number | string>>, workers: [] as string[] };

    // Group by worker
    const perWorker = new Map<string, ManualReserveWorkerSamplePoint[]>();
    for (const s of samples) {
      const arr = perWorker.get(s.worker) ?? [];
      arr.push(s);
      perWorker.set(s.worker, arr);
    }
    for (const arr of perWorker.values()) {
      arr.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Compute per-sample deltas of cumulative manualDelayedByBackgroundCount,
    // and remember the latest waitP95 reading per (worker, timestamp).
    const deltasByWorker = new Map<string, Array<{ timestamp: number; delta: number; waitP95: number | null }>>();
    const allTimestamps = new Set<number>();
    for (const [worker, arr] of perWorker) {
      const out: Array<{ timestamp: number; delta: number; waitP95: number | null }> = [];
      let prev: number | null = null;
      for (const s of arr) {
        const d = prev === null ? 0 : Math.max(0, s.manualDelayedByBackgroundCount - prev);
        prev = s.manualDelayedByBackgroundCount;
        out.push({ timestamp: s.timestamp, delta: d, waitP95: s.manualWaitP95Ms });
        allTimestamps.add(s.timestamp);
      }
      deltasByWorker.set(worker, out);
    }

    // Workers with any non-zero delay activity in the window.
    const activeWorkers = Array.from(deltasByWorker.entries())
      .filter(([, points]) => points.some((p) => p.delta > 0))
      .map(([w]) => w)
      .sort();
    if (activeWorkers.length === 0) {
      return { chartData: [] as Array<Record<string, number | string>>, workers: [] as string[] };
    }

    // Workers actually drawn as lines: respect the user's selection (if any).
    const visibleWorkers = showAll
      ? activeWorkers
      : activeWorkers.filter((w) => selectedWorkers!.has(w));

    const sortedTs = Array.from(allTimestamps).sort((a, b) => a - b);
    const rows: Array<Record<string, number | string>> = sortedTs.map((ts) => {
      const row: Record<string, number | string> = {
        time: formatTime(ts, windowMs),
        timestamp: ts,
      };
      for (const w of visibleWorkers) {
        const point = deltasByWorker.get(w)!.find((p) => p.timestamp === ts);
        row[w] = point ? point.delta : 0;
      }
      if (soloWorker && visibleWorkers.includes(soloWorker)) {
        const point = deltasByWorker.get(soloWorker)!.find((p) => p.timestamp === ts);
        if (point && point.waitP95 !== null) {
          row.__waitP95 = point.waitP95;
        }
      }
      return row;
    });

    return { chartData: rows, workers: visibleWorkers };
  }, [samples, windowMs, selectedWorkers, showAll, soloWorker]);

  const chartConfigForWorkers: ChartConfig = useMemo(() => {
    const config: ChartConfig = {};
    workers.forEach((w, i) => {
      config[w] = { label: w, color: PER_WORKER_LINE_COLORS[i % PER_WORKER_LINE_COLORS.length] };
    });
    if (soloWorker) {
      config.__waitP95 = { label: "Wait p95 (ms)", color: "hsl(var(--status-info))" };
    }
    return config;
  }, [workers, soloWorker]);

  if (chartData.length === 0 || workers.length === 0) {
    return (
      <div
        className="flex items-center justify-center h-48 text-sm text-muted-foreground"
        data-testid="text-no-per-worker-history"
      >
        {!showAll
          ? "No data for the selected entry points in this window."
          : "No per-entry-point delay history yet — values will appear once manual syncs are delayed by background work."}
      </div>
    );
  }

  return (
    <ChartContainer
      config={chartConfigForWorkers}
      className="h-64 w-full"
      data-testid="chart-manual-reserve-by-worker"
    >
      <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="time"
          tickLine={false}
          axisLine={false}
          className="text-xs"
          interval="preserveStartEnd"
          minTickGap={40}
        />
        <YAxis
          yAxisId="counts"
          tickLine={false}
          axisLine={false}
          className="text-xs"
          width={40}
          allowDecimals={false}
        />
        {soloWorker && (
          <YAxis
            yAxisId="wait"
            orientation="right"
            tickLine={false}
            axisLine={false}
            className="text-xs"
            width={50}
            tickFormatter={(v: number) => `${v}ms`}
          />
        )}
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                if (payload?.[0]?.payload?.timestamp) {
                  return new Date(payload[0].payload.timestamp as number).toLocaleString();
                }
                return "";
              }}
            />
          }
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {workers.map((w, i) => (
          <Line
            key={w}
            yAxisId="counts"
            type="monotone"
            dataKey={w}
            name={w}
            stroke={PER_WORKER_LINE_COLORS[i % PER_WORKER_LINE_COLORS.length]}
            strokeWidth={2}
            dot={false}
          />
        ))}
        {soloWorker && (
          <Line
            yAxisId="wait"
            type="monotone"
            dataKey="__waitP95"
            name="Wait p95 (ms)"
            stroke="hsl(var(--status-info))"
            strokeWidth={2}
            dot={false}
            strokeDasharray="4 2"
            connectNulls
          />
        )}
      </ComposedChart>
    </ChartContainer>
  );
}