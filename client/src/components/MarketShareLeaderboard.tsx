import { Users, Crown, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// Shared, props-driven Market Share Leaderboard (Task #2028).
//
// Previously the in-app dashboard (`LocalDominanceDashboard.tsx`) and the
// public/printable report (`PublicReport.tsx` → `PublicLocationLocalDominance`)
// each carried their own copy of this leaderboard JSX, including the
// duplicate-firm location-label logic (Task #1966 / #1971). The two copies
// could drift apart — a label/format change applied to one and not the other.
// This component is the single source of truth. The two surfaces only differ
// visually (light/burgundy dashboard vs dark/gold report), so those
// differences are expressed via the `variant` prop while the core
// duplicate-detection + label logic lives here once.

export interface LeaderboardCompetitor {
  rank: number;
  name: string;
  shareOfVoice: number;
  isSubjectBusiness: boolean;
  locationLabel?: string | null;
}

export type MarketShareLeaderboardVariant = "dashboard" | "report";

export function MarketShareLeaderboard({
  idKey,
  competitors,
  variant = "dashboard",
  keywordName,
  reportDate,
}: {
  // Stable per-market key used to namespace data-testids. The dashboard
  // passes the locationId; the public report passes the locationName.
  idKey: string;
  competitors: LeaderboardCompetitor[];
  variant?: MarketShareLeaderboardVariant;
  // Task #3622 — methodology transparency. When provided, the footnote names
  // the exact keyword + scan date this leaderboard was measured on, so a
  // reader can tell it describes the SAME scan as the adjacent heatmap.
  keywordName?: string | null;
  reportDate?: string | null;
}) {
  const isDashboard = variant === "dashboard";

  const rowTestId = (rank: number) =>
    isDashboard ? `competitor-${idKey}-${rank}` : `competitor-public-${idKey}-${rank}`;
  const labelTestId = (rank: number) =>
    isDashboard
      ? `competitor-location-${idKey}-${rank}`
      : `competitor-public-location-${idKey}-${rank}`;

  // Count duplicate firm names across the FULL leaderboard (not just the
  // shown rows) so both surfaces decide identically when to surface a
  // per-row GBP location label.
  const nameCounts = new Map<string, number>();
  for (const c of competitors) {
    const k = c.name.trim().toLowerCase();
    nameCounts.set(k, (nameCounts.get(k) ?? 0) + 1);
  }

  return (
    <div
      className={
        isDashboard
          ? "border border-slate-100 rounded-lg p-4"
          : "bg-[#252525] rounded-lg p-4 border border-white/10"
      }
      data-testid={`loc-competitors-${idKey}`}
    >
      <div className="mb-3">
        <h4
          className={`text-xs font-medium flex items-center gap-1.5 ${
            isDashboard ? "text-foreground" : "text-[#C4A35A]"
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          Market Share Leaderboard
        </h4>
        <p
          className={`text-caption ml-5 mt-0.5 ${
            isDashboard ? "text-muted-foreground" : "text-white/40"
          }`}
        >
          Your share of total visibility across all competitors
        </p>
      </div>

      {/* Task #3622 — "how is market share calculated?" methodology footnote.
          The leaderboard % (SEMrush's per-business share of ALL local search
          visibility in the market) and the map's coverage % (how much of the
          scan grid the subject business alone covers) are two different
          formulas over the SAME scan; without this note the two numbers look
          contradictory (e.g. 1.9% market share vs 15% map coverage). */}
      <p
        className={`text-caption leading-snug mb-2 ${
          isDashboard ? "text-muted-foreground/80" : "text-white/30"
        }`}
        data-testid={`loc-competitors-methodology-${idKey}`}
      >
        How it's calculated: from the same SEMrush map scan
        {keywordName ? <> for &ldquo;{keywordName}&rdquo;</> : null}
        {reportDate ? <> ({reportDate})</> : null}, each business&rsquo;s
        visibility is totaled across every ranking spot in the market; the %
        is that business&rsquo;s slice of the whole market&rsquo;s visibility.
        It reads lower than the map&rsquo;s coverage %, which measures only
        how much of the scan grid your business covers.
      </p>

      {competitors.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">
          Competitor data will appear after the next sync.
        </p>
      ) : (
        <>
          {isDashboard &&
            (() => {
              const subjectBiz = competitors.find((c) => c.isSubjectBusiness);
              if (!subjectBiz) return null;
              const nextCompetitor = competitors.find(
                (c) => !c.isSubjectBusiness && c.rank === subjectBiz.rank + 1,
              );
              const prevCompetitor = competitors.find(
                (c) => !c.isSubjectBusiness && c.rank === subjectBiz.rank - 1,
              );
              const gap = nextCompetitor
                ? (Number(subjectBiz.shareOfVoice) - Number(nextCompetitor.shareOfVoice)).toFixed(1)
                : null;
              const gapAbove = prevCompetitor
                ? (Number(prevCompetitor.shareOfVoice) - Number(subjectBiz.shareOfVoice)).toFixed(1)
                : null;
              return (
                <div
                  className="bg-primary/5 border border-primary/15 rounded-md px-3 py-2 mb-3"
                  data-testid={`loc-position-callout-${idKey}`}
                >
                  <p className="text-xs font-semibold text-foreground">
                    #{subjectBiz.rank} in Market
                    {gap != null && Number(gap) > 0 && (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        — {gap}% gap ahead of #{subjectBiz.rank + 1}
                      </span>
                    )}
                    {gapAbove != null && Number(gapAbove) > 0 && (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · {gapAbove}% behind #{subjectBiz.rank - 1}
                      </span>
                    )}
                  </p>
                </div>
              );
            })()}
          <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
            {competitors.slice(0, 8).map((comp) => {
              const isDuplicateName =
                (nameCounts.get(comp.name.trim().toLowerCase()) ?? 0) > 1;
              const showLocationLabel = isDuplicateName && !!comp.locationLabel;
              return (
                <div
                  key={comp.rank}
                  className={
                    isDashboard
                      ? `flex items-center gap-2 p-1.5 rounded-md transition-colors ${
                          comp.isSubjectBusiness
                            ? "bg-primary/5 border border-primary/20"
                            : "hover:bg-gray-50"
                        }`
                      : `flex items-center gap-2 p-1.5 rounded-md ${
                          comp.isSubjectBusiness
                            ? "bg-[#C4A35A]/10 border border-[#C4A35A]/20"
                            : ""
                        }`
                  }
                  data-testid={rowTestId(comp.rank)}
                >
                  <div
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-caption font-bold shrink-0 ${
                      isDashboard
                        ? "bg-gray-100 text-gray-600"
                        : "bg-white/10 text-white/60"
                    }`}
                  >
                    {comp.rank <= 3 ? (
                      isDashboard ? (
                        <Crown
                          className={`w-3 h-3 ${
                            comp.rank === 1
                              ? "text-yellow-500"
                              : comp.rank === 2
                              ? "text-gray-400"
                              : "text-orange-400"
                          }`}
                        />
                      ) : (
                        <Star
                          className={`w-3 h-3 ${
                            comp.rank === 1
                              ? "text-yellow-400"
                              : comp.rank === 2
                              ? "text-gray-300"
                              : "text-orange-400"
                          }`}
                        />
                      )
                    ) : (
                      comp.rank
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span
                      className={`text-xs truncate block ${
                        comp.isSubjectBusiness
                          ? isDashboard
                            ? "text-foreground font-bold"
                            : "text-[#C4A35A] font-bold"
                          : isDashboard
                          ? "font-medium"
                          : "text-white/70 font-medium"
                      }`}
                    >
                      {comp.name}
                      {comp.isSubjectBusiness &&
                        (isDashboard ? (
                          <Badge
                            variant="outline"
                            className="text-caption border-primary/30 text-primary dark:text-foreground py-0 h-5 ml-1"
                          >
                            You
                          </Badge>
                        ) : (
                          <span className="text-caption ml-1 px-1 py-0.5 border border-[#C4A35A]/30 text-[#C4A35A] rounded">
                            You
                          </span>
                        ))}
                    </span>
                    {showLocationLabel && (
                      <span
                        className={`text-caption truncate block leading-tight ${
                          isDashboard ? "text-muted-foreground" : "text-white/40"
                        }`}
                        data-testid={labelTestId(comp.rank)}
                        title={comp.locationLabel!}
                      >
                        {comp.locationLabel}
                      </span>
                    )}
                  </div>
                  <span
                    className={`text-xs font-semibold shrink-0 ${
                      isDashboard ? "text-foreground" : "text-[#C4A35A]"
                    }`}
                  >
                    {`${Number(comp.shareOfVoice).toFixed(2)}%`}
                  </span>
                  <div
                    className={`w-14 h-1.5 rounded-full overflow-hidden shrink-0 ${
                      isDashboard ? "bg-gray-100" : "bg-white/10"
                    }`}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(comp.shareOfVoice, 100)}%`,
                        backgroundColor: comp.isSubjectBusiness
                          ? isDashboard
                            ? "hsl(var(--primary))"
                            : "#C4A35A"
                          : isDashboard
                          ? "#94a3b8"
                          : "rgba(255,255,255,0.3)",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
