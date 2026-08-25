/**
 * Task #3691 — Churn Command Center.
 *
 * Director-level hub for portfolio churn tooling. Built as a tab shell:
 * Leaderboard (Task #3691), Going Quiet (Task #3695), Save Plays
 * (Task #3696), Risk Radar (Task #3692) and Team Coaching (Task #3712)
 * are the first tabs; later churn tools plug in as sibling tabs by
 * adding an entry to TAB_DEFS + a TabsContent block — no restructuring
 * needed.
 *
 * Access mirrors the STRICT server gate (canAccessChurnCommandCenter):
 * director+ authority only, with the legacy role "ceo" bridge. Permissive
 * mode does not open this page — below-director users get the access
 * card here and a 403 from /api/churn/*.
 *
 * Tab state is synced to ?tab= following the SystemHealthConsole pattern
 * so tabs are deep-linkable and survive refresh.
 */
import { useEffect } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ArrowLeft, Radar } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { PageSkeleton } from "@/components/ui/skeleton-loaders";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChurnLeaderboardTab } from "@/components/churn/ChurnLeaderboardTab";
import { ChurnOpenAsksTab } from "@/components/churn/ChurnOpenAsksTab";
import { GoingQuietTab } from "@/components/churn/GoingQuietTab";
import { SavePlaysTab } from "@/components/churn/SavePlaysTab";
import { ChurnRiskRadarTab } from "@/components/churn/ChurnRiskRadarTab";
import { TeamCoachingTab } from "@/components/churn/TeamCoachingTab";
import { ChurnStabilityTriageTab } from "@/components/churn/ChurnStabilityTriageTab";

// Tab manifest — later churn tabs register here (key must be URL-safe).
const TAB_DEFS = [
  { key: "leaderboard", label: "Leaderboard" },
  { key: "going-quiet", label: "Going Quiet" },
  { key: "save-plays", label: "Save Plays" },
  // Task #3694 — cross-client aging asks & promises rollup. The weekly
  // digest notification deep-links to /churn?tab=asks; keep this key
  // stable (server/services/openAsksDigest.ts OPEN_ASKS_TAB_DEEP_LINK).
  { key: "asks", label: "Promises & Asks" },
  { key: "radar", label: "Risk Radar" },
  // Task #3712 — per-AM churn trends + coaching reports. The coaching-run
  // completion notification deep-links to /churn?tab=team-coaching; keep
  // this key stable (server/services/amCoachingRun.ts notifyRequester).
  { key: "team-coaching", label: "Team Coaching" },
  // Task #4766 — unknown-delivery-stability operator triage: data gaps vs
  // archive candidates, each with evidence + a path to the existing flows.
  { key: "stability-triage", label: "Stability Triage" },
] as const;

type TabKey = (typeof TAB_DEFS)[number]["key"];
const TAB_KEYS: readonly string[] = TAB_DEFS.map((t) => t.key);
const DEFAULT_TAB: TabKey = "leaderboard";

function isTabKey(value: string | null | undefined): value is TabKey {
  return !!value && TAB_KEYS.includes(value);
}

function readTabFromSearch(search: string): TabKey {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = params.get("tab");
  return isTabKey(raw) ? raw : DEFAULT_TAB;
}

export default function ChurnCommandCenter() {
  usePageTitle("Churn Command Center");
  const { user, isLoading: authLoading } = useAuth();
  const [, navigate] = useLocation();
  const search = useSearch();

  // Mirrors the server's strict director+ gate (see module docblock).
  const isDirector =
    user?.role === "ceo" ||
    user?.authorityLevel === "director" ||
    user?.authorityLevel === "ceo";

  const activeTab: TabKey = readTabFromSearch(search);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const raw = params.get("tab");
    if (!isTabKey(raw)) {
      params.set("tab", DEFAULT_TAB);
      navigate(`/churn?${params.toString()}`, { replace: true });
    }
  }, [search, navigate]);

  const handleTabChange = (next: string) => {
    if (!isTabKey(next)) return;
    const params = new URLSearchParams(search);
    params.set("tab", next);
    navigate(`/churn?${params.toString()}`, { replace: false });
  };

  if (authLoading) return <PageSkeleton />;

  if (!user || !isDirector) {
    return (
      <div
        className="min-h-[calc(100dvh-var(--nav-height))] flex items-center justify-center"
        data-testid="text-access-denied"
      >
        <p className="text-muted-foreground">Access restricted to directors.</p>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      <header className="border-b bg-card sticky top-14 z-10">
        <div className="container mx-auto px-3 sm:px-4 py-2 sm:py-3 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="shrink-0"
              data-testid="button-back-dashboard"
            >
              <Link href="/">
                <ArrowLeft className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">Dashboard</span>
              </Link>
            </Button>
            <div className="flex items-center gap-2 min-w-0">
              <Radar className="w-5 h-5 text-primary shrink-0" />
              <div className="min-w-0">
                <h1 className="text-base sm:text-lg font-semibold text-foreground truncate">
                  Churn Command Center
                </h1>
                <p className="text-caption text-muted-foreground hidden sm:block">
                  Portfolio-wide churn early warning for account management
                </p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-3 sm:px-4 py-4">
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          {/* flex-wrap: six triggers overflow a 375px viewport by ~255px if the
              list stays a single row. */}
          <TabsList className="h-auto max-w-full flex-wrap" data-testid="tabs-churn-command-center">
            {TAB_DEFS.map((t) => (
              <TabsTrigger key={t.key} value={t.key} data-testid={`tab-${t.key}`}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="leaderboard" className="mt-4">
            <ChurnLeaderboardTab />
          </TabsContent>
          <TabsContent value="going-quiet" className="mt-4">
            <GoingQuietTab />
          </TabsContent>
          <TabsContent value="asks" className="mt-4">
            <ChurnOpenAsksTab />
          </TabsContent>
          <TabsContent value="save-plays" className="mt-4">
            <SavePlaysTab />
          </TabsContent>
          <TabsContent value="radar" className="mt-4">
            <ChurnRiskRadarTab />
          </TabsContent>
          <TabsContent value="team-coaching" className="mt-4">
            <TeamCoachingTab />
          </TabsContent>
          <TabsContent value="stability-triage" className="mt-4">
            <ChurnStabilityTriageTab />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
