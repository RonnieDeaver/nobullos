import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TrendingUp, TrendingDown, Minus, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { PageHeader } from "@/components/admin/PageHeader";
import { getTermLabel, type ClientTerminology } from "@shared/schema";
import { ComparisonSkeleton } from "@/components/ui/skeleton-loaders";
import { EmptyState } from "@/components/kit/EmptyState";
import { adjustDisplayLeads, adjustLeadToConsultRate } from "@shared/missedCallRate";

type Client = {
  id: string;
  firmName: string;
  terminology?: ClientTerminology | null;
  hideOtherLeads?: boolean;
};

type Report = {
  id: string;
  clientId: string;
  reportMonth: string;
  status: string;
  sections?: Array<{
    sectionKey: string;
    data: any;
  }>;
};

function DeltaIndicator({ current, previous, suffix = "", prefix = "" }: { current: number; previous: number; suffix?: string; prefix?: string }) {
  const delta = current - previous;
  const percentChange = previous > 0 ? `${((delta / previous) * 100).toFixed(1)}%` : (current > 0 ? "new" : "");
  
  if (delta > 0) {
    return (
      <span className="inline-flex items-center text-status-ok text-sm">
        <ArrowUpRight className="w-4 h-4" />
        {prefix}{delta.toLocaleString()}{suffix} {percentChange && `(${percentChange})`}
      </span>
    );
  } else if (delta < 0) {
    return (
      <span className="inline-flex items-center text-status-critical text-sm">
        <ArrowDownRight className="w-4 h-4" />
        {prefix}{Math.abs(delta).toLocaleString()}{suffix} {percentChange && `(${percentChange})`}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-muted-foreground text-sm">
      <Minus className="w-4 h-4" /> No change
    </span>
  );
}

function MetricCard({ 
  label, 
  current, 
  previous, 
  prefix = "", 
  suffix = "" 
}: { 
  label: string; 
  current: number; 
  previous: number; 
  prefix?: string; 
  suffix?: string;
}) {
  return (
    <div className="p-4 bg-surface-warm-1 rounded-lg">
      <p className="text-sm text-muted-foreground mb-1">{label}</p>
      <div className="flex items-baseline justify-between">
        <p className="text-2xl font-bold text-foreground">
          {prefix}{current.toLocaleString()}{suffix}
        </p>
        <p className="text-sm text-muted-foreground">
          was {prefix}{previous.toLocaleString()}{suffix}
        </p>
      </div>
      <div className="mt-2">
        <DeltaIndicator current={current} previous={previous} prefix={prefix} suffix={suffix} />
      </div>
    </div>
  );
}

export default function ReportComparison() {
  const { user, isLoading: authLoading } = useAuth();
  const [selectedClientId, setSelectedClientId] = useState<string>("");
  const [report1Month, setReport1Month] = useState<string>("");
  const [report2Month, setReport2Month] = useState<string>("");

  const { data: clients } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    queryFn: async () => {
      const res = await fetch("/api/clients", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch clients");
      return res.json();
    },
    enabled: !!user,
  });

  const selectedClient = useMemo(() => clients?.find(c => c.id === selectedClientId), [clients, selectedClientId]);
  const t = (key: Parameters<typeof getTermLabel>[1]) => getTermLabel(selectedClient?.terminology, key);

  const { data: clientReports } = useQuery<Report[]>({
    queryKey: ["/api/clients", selectedClientId, "reports"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${selectedClientId}/reports`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch reports");
      return res.json();
    },
    enabled: !!selectedClientId,
  });

  const { data: report1 } = useQuery<Report>({
    queryKey: ["/api/reports", report1Month],
    queryFn: async () => {
      const report = clientReports?.find(r => r.reportMonth === report1Month);
      if (!report) throw new Error("Report not found");
      const res = await fetch(`/api/reports/${report.id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch report");
      return res.json();
    },
    enabled: !!report1Month && !!clientReports,
  });

  const { data: report2 } = useQuery<Report>({
    queryKey: ["/api/reports", report2Month],
    queryFn: async () => {
      const report = clientReports?.find(r => r.reportMonth === report2Month);
      if (!report) throw new Error("Report not found");
      const res = await fetch(`/api/reports/${report.id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch report");
      return res.json();
    },
    enabled: !!report2Month && !!clientReports,
  });

  const availableMonths = useMemo(() => {
    return (clientReports || [])
      .map(r => r.reportMonth)
      .sort((a, b) => b.localeCompare(a));
  }, [clientReports]);

  const formatMonth = (monthKey: string) => {
    const [year, month] = monthKey.split('-').map(Number);
    const date = new Date(year, month - 1, 1);
    return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  };

  const getSection = (report: Report | undefined, key: string) => {
    return report?.sections?.find(s => s.sectionKey === key)?.data || {};
  };

  if (authLoading) {
    return <ComparisonSkeleton />;
  }

  if (!user) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <p className="text-muted-foreground">Please sign in to compare reports.</p>
      </div>
    );
  }

  const intake1 = getSection(report1, "intake");
  const intake2 = getSection(report2, "intake");
  const sales1 = getSection(report1, "sales");
  const sales2 = getSection(report2, "sales");
  const marketing1 = getSection(report1, "marketing");
  const marketing2 = getSection(report2, "marketing");

  const hideOtherLeads = selectedClient?.hideOtherLeads === true;
  const totalLeads1 = adjustDisplayLeads(
    intake1.totalLeads || 0,
    marketing1.otherLeads?.count || 0,
    hideOtherLeads,
  );
  const totalLeads2 = adjustDisplayLeads(
    intake2.totalLeads || 0,
    marketing2.otherLeads?.count || 0,
    hideOtherLeads,
  );
  const conversionRate1 = adjustLeadToConsultRate(
    intake1.totalConsults || 0,
    totalLeads1,
    intake1.leadToConsultRate || 0,
    hideOtherLeads,
  );
  const conversionRate2 = adjustLeadToConsultRate(
    intake2.totalConsults || 0,
    totalLeads2,
    intake2.leadToConsultRate || 0,
    hideOtherLeads,
  );

  const canCompare = report1 && report2 && report1Month !== report2Month;

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      {/* Task #4710 — standard page-header grammar (PageHeader, Task #4344)
          on the light canvas; replaces the legacy bg-primary band whose bare
          h1 was repainted illegible by the base-layer heading rule. */}
      <div className="max-w-7xl mx-auto px-6 pt-6">
        <PageHeader title="Report Comparison" backHref="/" backLabel="Dashboard" />
      </div>

      <main className="max-w-7xl mx-auto p-6">
        <Card className="bg-card border-primary/10 mb-6">
          <CardHeader>
            <CardTitle className="text-foreground">Select Reports to Compare</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label htmlFor="compare-select-client" className="text-sm font-medium text-muted-foreground mb-1 block">Client</label>
                <Select value={selectedClientId} onValueChange={(val) => {
                  setSelectedClientId(val);
                  setReport1Month("");
                  setReport2Month("");
                }}>
                  <SelectTrigger id="compare-select-client" data-testid="select-client">
                    <SelectValue placeholder="Select client" />
                  </SelectTrigger>
                  <SelectContent>
                    {clients?.map(c => (
                      <SelectItem key={c.id} value={c.id}>{c.firmName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label htmlFor="compare-select-report1" className="text-sm font-medium text-muted-foreground mb-1 block">Earlier Report</label>
                <Select value={report1Month} onValueChange={setReport1Month} disabled={!selectedClientId}>
                  <SelectTrigger id="compare-select-report1" data-testid="select-report1">
                    <SelectValue placeholder="Select month" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableMonths.map(m => (
                      <SelectItem key={m} value={m} disabled={m === report2Month}>{formatMonth(m)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label htmlFor="compare-select-report2" className="text-sm font-medium text-muted-foreground mb-1 block">Later Report</label>
                <Select value={report2Month} onValueChange={setReport2Month} disabled={!selectedClientId}>
                  <SelectTrigger id="compare-select-report2" data-testid="select-report2">
                    <SelectValue placeholder="Select month" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableMonths.map(m => (
                      <SelectItem key={m} value={m} disabled={m === report1Month}>{formatMonth(m)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {canCompare && (
          <div className="space-y-6">
            <Card className="bg-card border-primary/10">
              <CardHeader>
                <CardTitle className="text-foreground">
                  Intake: {formatMonth(report1Month)} vs {formatMonth(report2Month)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <MetricCard 
                    label={`Total ${t("leads")}`}
                    current={totalLeads2}
                    previous={totalLeads1}
                  />
                  <MetricCard 
                    label={`Total ${t("consults")}`}
                    current={intake2.totalConsults || 0}
                    previous={intake1.totalConsults || 0}
                  />
                  <MetricCard 
                    label="Conversion Rate"
                    current={conversionRate2}
                    previous={conversionRate1}
                    suffix="%"
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card border-primary/10">
              <CardHeader>
                <CardTitle className="text-foreground">
                  Sales: {formatMonth(report1Month)} vs {formatMonth(report2Month)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <MetricCard 
                    label={`${t("cases")} Signed`}
                    current={sales2.totalCases || 0}
                    previous={sales1.totalCases || 0}
                  />
                  <MetricCard 
                    label="Close Rate"
                    current={sales2.consultToCaseRate || 0}
                    previous={sales1.consultToCaseRate || 0}
                    suffix="%"
                  />
                  <MetricCard 
                    label={t("averageCaseValue")}
                    current={sales2.averageCaseValue || 0}
                    previous={sales1.averageCaseValue || 0}
                    prefix="$"
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card border-primary/10">
              <CardHeader>
                <CardTitle className="text-foreground">
                  Marketing: {formatMonth(report1Month)} vs {formatMonth(report2Month)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <MetricCard 
                    label={`Google Ads ${t("leads")}`}
                    current={marketing2.googleAds?.uniqueLeads || 0}
                    previous={marketing1.googleAds?.uniqueLeads || 0}
                  />
                  <MetricCard 
                    label="Google Ads Spend"
                    current={marketing2.googleAds?.adSpend || 0}
                    previous={marketing1.googleAds?.adSpend || 0}
                    prefix="$"
                  />
                  <MetricCard 
                    label={`LSA ${t("leads")}`}
                    current={marketing2.lsa?.uniqueLeads || 0}
                    previous={marketing1.lsa?.uniqueLeads || 0}
                  />
                  <MetricCard 
                    label="LSA Spend"
                    current={marketing2.lsa?.adSpend || 0}
                    previous={marketing1.lsa?.adSpend || 0}
                    prefix="$"
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card border-primary/10">
              <CardHeader>
                <CardTitle className="text-foreground">Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    {totalLeads2 > totalLeads1 ? (
                      <TrendingUp className="w-5 h-5 text-status-ok" />
                    ) : totalLeads2 < totalLeads1 ? (
                      <TrendingDown className="w-5 h-5 text-status-critical" />
                    ) : (
                      <Minus className="w-5 h-5 text-muted-foreground" />
                    )}
                    <span className="text-foreground">
                      {t("leads")} volume {totalLeads2 >= totalLeads1 ? "increased" : "decreased"} from {totalLeads1} to {totalLeads2}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {(sales2.totalCases || 0) > (sales1.totalCases || 0) ? (
                      <TrendingUp className="w-5 h-5 text-status-ok" />
                    ) : (sales2.totalCases || 0) < (sales1.totalCases || 0) ? (
                      <TrendingDown className="w-5 h-5 text-status-critical" />
                    ) : (
                      <Minus className="w-5 h-5 text-muted-foreground" />
                    )}
                    <span className="text-foreground">
                      {t("cases")} signed {(sales2.totalCases || 0) >= (sales1.totalCases || 0) ? "increased" : "decreased"} from {sales1.totalCases || 0} to {sales2.totalCases || 0}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {/* Spend DECREASE reads as the good outcome here — up-arrow/ok on lower spend is intentional. */}
                    {((marketing2.googleAds?.adSpend || 0) + (marketing2.lsa?.adSpend || 0)) < ((marketing1.googleAds?.adSpend || 0) + (marketing1.lsa?.adSpend || 0)) ? (
                      <TrendingUp className="w-5 h-5 text-status-ok" />
                    ) : ((marketing2.googleAds?.adSpend || 0) + (marketing2.lsa?.adSpend || 0)) > ((marketing1.googleAds?.adSpend || 0) + (marketing1.lsa?.adSpend || 0)) ? (
                      <TrendingDown className="w-5 h-5 text-status-critical" />
                    ) : (
                      <Minus className="w-5 h-5 text-muted-foreground" />
                    )}
                    <span className="text-foreground">
                      Total ad spend {((marketing2.googleAds?.adSpend || 0) + (marketing2.lsa?.adSpend || 0)) <= ((marketing1.googleAds?.adSpend || 0) + (marketing1.lsa?.adSpend || 0)) ? "decreased" : "increased"} from ${((marketing1.googleAds?.adSpend || 0) + (marketing1.lsa?.adSpend || 0)).toLocaleString()} to ${((marketing2.googleAds?.adSpend || 0) + (marketing2.lsa?.adSpend || 0)).toLocaleString()}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {!canCompare && selectedClientId && (
          <Card className="bg-card border-primary/10">
            <CardContent className="py-6">
              <EmptyState
                testId="empty-comparison"
                title="Nothing to compare yet"
                description={availableMonths.length < 2
                  ? "This client needs at least 2 monthly reports before a comparison can run."
                  : "Pick two different months above to see what changed."}
              />
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
