import { useEffect } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Activity, ShieldAlert } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageSkeleton } from "@/components/ui/skeleton-loaders";
import { PageHeader } from "@/components/admin/PageHeader";
import { MetricsFlushSection } from "@/pages/admin/SystemHealthMetricsFlush";
import { HealthDashboardSection } from "@/components/admin/health/HealthDashboardSection";
import { RouteCoverageSection } from "./RouteLimiters";
import { AuditRetentionSection } from "./AuditRetentionSettings";
import { OrphanedUserHealSection } from "./OrphanedUserHealSection";
import { ClerkRestrictionsSection } from "./ClerkRestrictionsSection";

type TabKey =
  | "health"
  | "route-coverage"
  | "audit-retention"
  | "metrics-flush"
  | "account-heal"
  | "auth";

const TAB_KEYS: TabKey[] = [
  "health",
  "route-coverage",
  "audit-retention",
  "metrics-flush",
  "account-heal",
  "auth",
];

const DEFAULT_TAB: TabKey = "health";

function isTabKey(value: string | null | undefined): value is TabKey {
  return !!value && (TAB_KEYS as string[]).includes(value);
}

function readTabFromSearch(search: string): TabKey {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = params.get("tab");
  return isTabKey(raw) ? raw : DEFAULT_TAB;
}

export default function SystemHealthConsole() {
  usePageTitle("System Health");
  const { user, isLoading: authLoading } = useAuth();
  const [, navigate] = useLocation();
  const search = useSearch();

  const isAdmin = user?.role === "ceo" || user?.role === "team_lead";

  const activeTab: TabKey = readTabFromSearch(search);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const raw = params.get("tab");
    if (!isTabKey(raw)) {
      params.set("tab", DEFAULT_TAB);
      navigate(`/admin/system-health?${params.toString()}`, { replace: true });
    }
  }, [search, navigate]);

  const handleTabChange = (next: string) => {
    if (!isTabKey(next)) return;
    const params = new URLSearchParams(search);
    params.set("tab", next);
    navigate(`/admin/system-health?${params.toString()}`, { replace: false });
  };

  if (authLoading) return <PageSkeleton />;

  if (!user || !isAdmin) {
    return (
      <div
        className="min-h-[calc(100dvh-var(--nav-height))] flex items-center justify-center"
        data-testid="text-access-denied"
      >
        <p className="text-muted-foreground">Access restricted to admin users.</p>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      {/* Task #4355 — Pattern-A refit onto the shared PageHeader (audit
          §6.1-B / P1-4): same sticky sub-bar anatomy, now token-styled
          (--primary instead of the deprecated #6B2C3E fork). */}
      <PageHeader
        sticky
        className="px-3 sm:px-4 py-2 sm:py-3"
        title="System Health"
        icon={Activity}
        subtitle="Unified console for health, routing, audit retention, and metrics flush."
        backHref="/"
        backLabel="Dashboard"
        backTestId="button-back-dashboard"
        actions={
          <Button
            asChild
            variant="outline"
            size="sm"
            className="shrink-0"
            data-testid="link-rate-limits-from-system-health"
          >
            <Link href="/admin/rate-limits" aria-label="Rate Limits">
              <ShieldAlert className="w-4 h-4 sm:mr-1" />
              <span className="hidden sm:inline">Rate Limits</span>
            </Link>
          </Button>
        }
      />

      <main className="container mx-auto px-3 sm:px-4 py-4 sm:py-6">
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="space-y-4 sm:space-y-6"
        >
          <TabsList
            className="w-full flex flex-wrap h-auto gap-1 bg-muted p-1"
            data-testid="tabs-system-health"
          >
            <TabsTrigger
              value="health"
              className="flex-1 min-w-[120px] data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              data-testid="tab-trigger-health"
            >
              Health
            </TabsTrigger>
            <TabsTrigger
              value="route-coverage"
              className="flex-1 min-w-[120px] data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              data-testid="tab-trigger-route-coverage"
            >
              Route Coverage
            </TabsTrigger>
            <TabsTrigger
              value="audit-retention"
              className="flex-1 min-w-[120px] data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              data-testid="tab-trigger-audit-retention"
            >
              Audit Retention
            </TabsTrigger>
            <TabsTrigger
              value="metrics-flush"
              className="flex-1 min-w-[120px] data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              data-testid="tab-trigger-metrics-flush"
            >
              Metrics Flush
            </TabsTrigger>
            <TabsTrigger
              value="account-heal"
              className="flex-1 min-w-[120px] data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              data-testid="tab-trigger-account-heal"
            >
              Account Heal
            </TabsTrigger>
            <TabsTrigger
              value="auth"
              className="flex-1 min-w-[120px] data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              data-testid="tab-trigger-auth"
            >
              Auth Settings
            </TabsTrigger>
          </TabsList>

          <TabsContent value="health" data-testid="tab-panel-health">
            <HealthDashboardSection />
          </TabsContent>

          <TabsContent value="route-coverage" data-testid="tab-panel-route-coverage">
            <RouteCoverageSection />
          </TabsContent>

          <TabsContent value="audit-retention" data-testid="tab-panel-audit-retention">
            <AuditRetentionSection />
          </TabsContent>

          <TabsContent value="metrics-flush" data-testid="tab-panel-metrics-flush">
            <MetricsFlushSection enabled={activeTab === "metrics-flush"} />
          </TabsContent>

          <TabsContent value="account-heal" data-testid="tab-panel-account-heal">
            <OrphanedUserHealSection enabled={activeTab === "account-heal"} />
          </TabsContent>

          <TabsContent value="auth" data-testid="tab-panel-auth">
            <ClerkRestrictionsSection enabled={activeTab === "auth"} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
