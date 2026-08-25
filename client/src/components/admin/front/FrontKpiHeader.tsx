import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Activity, Clock, AlertTriangle, CheckCircle, Database } from "lucide-react";
import type { ConsoleOverview } from "./types";
import { FRONT_MESSAGE_GRAIN_METRIC_TITLES as DEF } from "./messageGrainMetricTitles";
import { FRONT_CONSOLE_LENSES, getFrontConsoleMetric } from "@shared/frontConsoleMetrics";
import { PercentText } from "./PercentText";

export function FrontKpiHeader() {
  const { data } = useQuery<ConsoleOverview>({
    queryKey: ["/api/integrations/front/console/overview"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/front/console/overview", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load Front overview");
      return res.json();
    },
    refetchInterval: (query) => {
      const overview = query.state.data as ConsoleOverview | undefined;
      const hasLiveRecovery = overview?.jobs?.some(
        (j) => j.type === "historical_recovery" && (j.status === "running" || j.status === "queued"),
      );
      return hasLiveRecovery ? 5_000 : false;
    },
    refetchOnWindowFocus: true,
  });

  const msgs = data?.messages;
  const pipe = data?.pipeline;
  // Task #2502 (Bug B) — real backlog comes from the server (non-terminal +
  // failed), NOT a naive sum of every pipeline_state, which would fold in the
  // ~137k already-`applied` rows and make a healthy pipeline look stuck.
  const backlogTotal = pipe?.backlogCount ?? null;

  const tiles: Array<{
    name: string;
    // Task #2685 — every rendered figure is sourced from the metric registry so
    // a relabel/re-point can't drift from its lens/grain/source definition.
    metricId: string;
    label: string;
    // string | number for plain figures; ReactNode admits the clamped
    // <PercentText> display (Task #4367) without changing tile markup.
    value: React.ReactNode;
    sub?: string;
    title?: string;
    Icon: React.ComponentType<{ className?: string }>;
    tone: string;
  }> = [
    {
      name: "tracked",
      metricId: getFrontConsoleMetric("front.pipeline.tracked_total").id,
      label: "Tracked emails",
      value: msgs?.trackedTotal ?? "—",
      sub: "De-duplicated",
      title: DEF.trackedTotal,
      Icon: Database,
      tone: "text-slate-700",
    },
    {
      name: "matched",
      metricId: getFrontConsoleMetric("front.pipeline.matched").id,
      label: "Matched",
      value: msgs?.matched ?? "—",
      sub: "of tracked emails",
      title: DEF.matched,
      Icon: CheckCircle,
      tone: "text-green-700",
    },
    {
      name: "unmatched",
      metricId: getFrontConsoleMetric("front.pipeline.unmatched").id,
      label: "Unmatched",
      value: msgs?.unmatched ?? "—",
      sub: "matchable, no client yet",
      title: DEF.unmatched,
      Icon: AlertTriangle,
      tone: "text-amber-700",
    },
    {
      name: "match-rate",
      metricId: getFrontConsoleMetric("front.pipeline.match_rate").id,
      // Task #2603 — Front Console is message-grain only; the metric reads as a
      // plain match rate over tracked emails, no conversation framing.
      label: "Match rate",
      // Task #4367 — clamped display: an impossible stored rate renders as
      // "needs recount" (amber, raw value in the tooltip), never as a raw
      // out-of-range number.
      value: msgs ? <PercentText value={msgs.matchRate} digits={0} /> : "—",
      sub: msgs ? `of ${(msgs.matchable ?? 0).toLocaleString()} matchable emails` : undefined,
      title: DEF.matchRate,
      Icon: Activity,
      tone: "text-blue-700",
    },
    {
      name: "backlog-total",
      metricId: getFrontConsoleMetric("front.pipeline.backlog").id,
      label: "Pipeline backlog",
      value: backlogTotal ?? "—",
      sub: pipe ? `${pipe.health.failedCount} failed · ${pipe.health.deadLetteredCount} DL` : undefined,
      title: DEF.backlog,
      Icon: Clock,
      tone: backlogTotal && backlogTotal > 0 ? "text-rose-700" : "text-emerald-700",
    },
  ];

  return (
    <div>
      {/* Task #2685 — name the lens. This KPI strip is the processing-pipeline
          lens ("of fetched messages"); its "backlog/drained" vocabulary is a
          different question from the Analytics Coverage lens ("did we fetch
          everything"). Stating it stops the two screens reading as a
          contradiction. */}
      <p
        className="text-xs font-medium text-indigo-700 mb-1"
        data-testid="text-front-kpi-lens-label"
      >
        Lens {FRONT_CONSOLE_LENSES[1].lens} — {FRONT_CONSOLE_LENSES[1].title}: {FRONT_CONSOLE_LENSES[1].question}
      </p>
      <Card
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-0 divide-y sm:divide-y-0 sm:divide-x"
        data-testid="kpi-header-front"
      >
      {tiles.map(({ name, metricId, label, value, sub, title, Icon, tone }) => (
        <div
          key={name}
          className="flex items-start gap-2 p-3 min-w-0"
          data-testid={`kpi-${name}`}
          data-metric-id={metricId}
          title={title}
        >
          <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${tone}`} />
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-gray-500 truncate">{label}</p>
            <p
              className={`text-lg sm:text-xl font-semibold leading-tight ${tone}`}
              data-testid={`kpi-${name}-value`}
            >
              {value}
            </p>
            {sub && (
              <p className="text-xs text-gray-500 truncate" data-testid={`kpi-${name}-sub`}>
                {sub}
              </p>
            )}
          </div>
        </div>
      ))}
      </Card>
    </div>
  );
}
