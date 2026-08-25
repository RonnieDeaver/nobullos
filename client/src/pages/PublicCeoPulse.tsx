import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import CeoPulseVisual from "@/components/CeoPulseVisual";
import { Skeleton } from "@/components/ui/skeleton";
import { NOBULL_BRIEF_STRINGS } from "@/components/ceoPulseCopy";
import { REPORT_CEO_PULSE_CHART_PALETTE } from "@/pages/publicReport/reportTokens";

function formatMonthKey(monthKey: string): string {
  if (!monthKey) return "";
  const [year, month] = monthKey.split("-");
  const date = new Date(parseInt(year), parseInt(month) - 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export default function PublicCeoPulse() {
  const params = useParams<{ token: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: [`/api/ceo-pulse/share/${params.token}`],
    queryFn: async () => {
      const res = await fetch(`/api/ceo-pulse/share/${params.token}`);
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
    enabled: !!params.token,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-brief-ink-strong flex items-center justify-center p-6" data-testid="skeleton-public-pulse">
        <div className="w-full max-w-5xl space-y-6">
          <Skeleton className="h-10 w-64 bg-white/10" />
          <Skeleton className="h-6 w-96 bg-white/10" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-40 w-full rounded-lg bg-white/10" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !data?.aiAnalysis) {
    return (
      <div className="min-h-screen bg-brief-ink-strong flex items-center justify-center">
        <div className="text-center">
          <p className="text-white/60 text-lg" data-testid="text-pulse-not-found">This NoBull Brief is not available.</p>
          <p className="text-white/50 text-sm mt-2">It may not be published yet or the link may be invalid.</p>
        </div>
      </div>
    );
  }

  const letterUrl = data.hasFullLetter ? `/pulse/${params.token}/letter` : undefined;

  return (
    <div className="min-h-screen bg-brief-ink-strong flex items-center justify-center p-6">
      <div className="w-full max-w-5xl">
        <CeoPulseVisual
          analysis={data.aiAnalysis}
          monthLabel={formatMonthKey(data.monthKey)}
          animate={true}
          letterUrl={letterUrl}
          includeGraphs={data.includeGraphs !== false}
          edition={data.edition ?? null}
          supportingImages={Array.isArray(data.supportingImages) ? data.supportingImages : []}
          /* Task #4576 — DECISION: the /pulse share page SHARES report branding
             rather than keeping its own. Its card chrome (`card-light`,
             crimson/gold masthead) already rides the `--report-*` token
             layer, so the charts adopt the same sanctioned report palette
             (Task #4414). The internal admin preview (CeoPulseAdmin.tsx)
             passes no palette and keeps the stock OS chart colors. */
          chartPalette={REPORT_CEO_PULSE_CHART_PALETTE}
        />
        <p className="text-center text-white/50 text-xs mt-6">NoBull OS — {NOBULL_BRIEF_STRINGS.title}</p>
      </div>
    </div>
  );
}
