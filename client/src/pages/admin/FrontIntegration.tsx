import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { AlertCircle, ChevronDown, Settings2 } from "lucide-react";
import { BreakerDetailRow } from "@/components/admin/BreakerDetailRow";
import { PageHeader } from "@/components/admin/PageHeader";
import { FrontBringTo100 } from "@/components/admin/front/FrontBringTo100";
import { FrontKpiHeader } from "@/components/admin/front/FrontKpiHeader";
import { FrontMessagesTab } from "@/components/admin/front/FrontMessagesTab";
import { FrontFilterRules } from "@/components/admin/front/FrontFilterRules";
import { FrontPipelineHealthTab } from "@/components/admin/front/FrontPipelineHealthTab";
import { FrontJobsTab } from "@/components/admin/front/FrontJobsTab";
import { FrontHistoricalRecoveryPanel } from "@/components/admin/FrontHistoricalRecoveryPanel";

type TabId = "messages" | "filters" | "pipeline" | "recovery" | "jobs";

const VALID_TABS: readonly TabId[] = ["messages", "filters", "pipeline", "recovery", "jobs"];
const DEFAULT_TAB: TabId = "messages";

function parseTab(search: string): TabId {
  const params = new URLSearchParams(search);
  const raw = params.get("tab");
  if (raw && (VALID_TABS as readonly string[]).includes(raw)) {
    return raw as TabId;
  }
  return DEFAULT_TAB;
}

type FrontBreakerStatus = {
  breakerOpen?: boolean;
  lastTrippedAt?: string | null;
  cooldownUntil?: string | null;
  tripCount?: number;
};

export default function FrontIntegration() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const initialTab = useMemo(() => parseTab(search), [search]);
  const [tab, setTab] = useState<TabId>(initialTab);
  // Task #2691 — operator tabs are collapsed by default; auto-open when the URL
  // deep-links to a specific tab so existing ?tab= links keep working.
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(
    () => parseTab(search) !== DEFAULT_TAB,
  );

  // Task #2216 — pull the Front auth-dead breaker detail from the shared
  // all-status endpoint so the dedicated console matches the Integrations Hub.
  const { data: allStatus } = useQuery<{ front?: FrontBreakerStatus }>({
    queryKey: ["/api/integrations/all-status"],
  });
  const frontBreaker = allStatus?.front;

  useEffect(() => {
    const fromUrl = parseTab(search);
    if (fromUrl !== tab) {
      setTab(fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const handleTabChange = (next: string) => {
    if (!(VALID_TABS as readonly string[]).includes(next)) return;
    const nextTab = next as TabId;
    setTab(nextTab);
    const params = new URLSearchParams(search);
    if (nextTab === DEFAULT_TAB) {
      params.delete("tab");
    } else {
      params.set("tab", nextTab);
    }
    const qs = params.toString();
    const base = location.split("?")[0];
    setLocation(qs ? `${base}?${qs}` : base, { replace: true });
  };

  return (
    <div className="container mx-auto p-4 sm:p-6 max-w-6xl space-y-4" data-testid="page-front-console">
      <PageHeader
        title="Front Console"
        backHref="/admin/integrations"
        backLabel="Integrations"
        backTestId="button-back"
        titleTestId="heading-front-console"
        actions={
          <div className="text-xs text-gray-500" data-testid="text-console-canonical-note">
            Canonical Front management console
          </div>
        }
      />

      {frontBreaker?.breakerOpen && (
        <div
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 space-y-1"
          data-testid="banner-front-breaker"
        >
          <div className="flex items-center gap-1.5 text-sm font-medium text-red-700">
            <AlertCircle className="w-4 h-4" />
            Front disconnected — reconnect required
          </div>
          <BreakerDetailRow
            lastTrippedAt={frontBreaker.lastTrippedAt}
            cooldownUntil={frontBreaker.cooldownUntil}
            tripCount={frontBreaker.tripCount}
            testIdPrefix="front"
          />
        </div>
      )}

      {/* Task #2691 — dead-simple default view: "% of messages logged" +
          classification + ONE "Bring it to 100%" button. Operator tooling is
          demoted behind the Advanced disclosure below. */}
      <FrontBringTo100 />

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-between"
            data-testid="button-toggle-advanced"
          >
            <span className="flex items-center gap-2">
              <Settings2 className="w-4 h-4" />
              Advanced operator tools
            </span>
            <ChevronDown
              className={`w-4 h-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4 space-y-4">
          <FrontKpiHeader />

          <Tabs value={tab} onValueChange={handleTabChange} data-testid="tabs-front-console">
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-5">
          <TabsTrigger value="messages" data-testid="tab-front-messages">
            Messages
          </TabsTrigger>
          <TabsTrigger value="filters" data-testid="tab-front-filters">
            Filter Rules
          </TabsTrigger>
          <TabsTrigger value="pipeline" data-testid="tab-front-pipeline">
            Pipeline Health
          </TabsTrigger>
          <TabsTrigger value="recovery" data-testid="tab-front-recovery">
            Historical Recovery
          </TabsTrigger>
          <TabsTrigger value="jobs" data-testid="tab-front-jobs">
            Jobs &amp; Bulk Actions
          </TabsTrigger>
        </TabsList>

        <TabsContent value="messages" data-testid="tabpanel-front-messages">
          <FrontMessagesTab />
        </TabsContent>

        <TabsContent value="filters" data-testid="tabpanel-front-filters">
          <div className="space-y-6">
            <FrontFilterRules />
          </div>
        </TabsContent>

        <TabsContent value="pipeline" data-testid="tabpanel-front-pipeline">
          <FrontPipelineHealthTab />
        </TabsContent>

        <TabsContent value="recovery" data-testid="tabpanel-front-recovery">
          <div data-testid="section-front-historical-recovery">
            <FrontHistoricalRecoveryPanel />
          </div>
        </TabsContent>

        <TabsContent value="jobs" data-testid="tabpanel-front-jobs">
          <FrontJobsTab />
        </TabsContent>
          </Tabs>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
