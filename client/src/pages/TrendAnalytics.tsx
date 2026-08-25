import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/admin/PageHeader";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, BarChart, Bar } from "recharts";
import { getTermLabel, type ClientTerminology } from "@shared/schema";
import { ComparisonSkeleton } from "@/components/ui/skeleton-loaders";
import { EmptyState } from "@/components/kit/EmptyState";
import { adjustDisplayLeads, adjustLeadToConsultRate } from "@shared/missedCallRate";

/* Chart series ride theme tokens so both themes stay legible (recharts resolves
   hsl(var(--x)) at render). Multi-series charts differentiate by LIGHTNESS
   (primary vs primary/0.65) and stroke DASH, not hue alone — colorblind-safe. */
const SERIES = {
  primary: "hsl(var(--primary))",
  primarySoft: "hsl(var(--primary) / 0.65)",
  accent: "hsl(var(--status-warn))",
  ok: "hsl(var(--status-ok))",
} as const;

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

type ChartData = {
  month: string;
  leads: number;
  consults: number;
  cases: number;
  conversionRate: number;
  closeRate: number;
  adSpend: number;
  caseValue: number;
};

export default function TrendAnalytics() {
  const { user, isLoading: authLoading } = useAuth();
  const [selectedClientId, setSelectedClientId] = useState<string>("");

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

  const { data: clientReports, isError: reportsError } = useQuery<Report[]>({
    queryKey: ["/api/clients", selectedClientId, "reports-full"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${selectedClientId}/reports`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch reports");
      const reports = await res.json();
      
      // Fetch full report data with sections for each report
      const fullReports = await Promise.all(
        reports.map(async (r: Report) => {
          const fullRes = await fetch(`/api/reports/${r.id}`, { credentials: "include" });
          if (!fullRes.ok) return r;
          return fullRes.json();
        })
      );
      return fullReports;
    },
    enabled: !!selectedClientId,
  });

  const chartData = useMemo<ChartData[]>(() => {
    if (!clientReports) return [];
    const hideOtherLeads = selectedClient?.hideOtherLeads === true;
    
    return clientReports
      .sort((a, b) => a.reportMonth.localeCompare(b.reportMonth))
      .map(report => {
        const intake = report.sections?.find((s: any) => s.sectionKey === "intake")?.data || {};
        const sales = report.sections?.find((s: any) => s.sectionKey === "sales")?.data || {};
        const marketing = report.sections?.find((s: any) => s.sectionKey === "marketing")?.data || {};
        
        const [year, monthNum] = report.reportMonth.split('-').map(Number);
        const date = new Date(year, monthNum - 1, 1);
        const monthLabel = date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
        
        const leads = adjustDisplayLeads(
          intake.totalLeads || 0,
          marketing.otherLeads?.count || 0,
          hideOtherLeads,
        );

        return {
          month: monthLabel,
          leads,
          consults: intake.totalConsults || 0,
          cases: sales.totalCases || 0,
          conversionRate: adjustLeadToConsultRate(
            intake.totalConsults || 0,
            leads,
            intake.leadToConsultRate || 0,
            hideOtherLeads,
          ),
          closeRate: sales.consultToCaseRate || 0,
          adSpend: (marketing.googleAds?.adSpend || 0) + (marketing.lsa?.adSpend || 0),
          caseValue: sales.averageCaseValue || 0,
        };
      });
  }, [clientReports, selectedClient]);

  const formatMonth = (monthKey: string) => {
    const [year, month] = monthKey.split('-').map(Number);
    const date = new Date(year, month - 1, 1);
    return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  };

  if (authLoading) {
    return <ComparisonSkeleton />;
  }

  if (!user) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <p className="text-muted-foreground">Please sign in to view analytics.</p>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      {/* Task #4710 — standard page-header grammar (PageHeader, Task #4344)
          on the light canvas; replaces the legacy bg-primary band whose bare
          h1 was repainted illegible by the base-layer heading rule. */}
      <div className="max-w-7xl mx-auto px-6 pt-6">
        <PageHeader title="Trend Analytics" backHref="/" backLabel="Dashboard" />
      </div>

      <main className="max-w-7xl mx-auto p-6">
        <Card className="bg-card border-primary/10 mb-6">
          <CardHeader>
            <CardTitle className="text-foreground">Select Client</CardTitle>
          </CardHeader>
          <CardContent>
            <Select value={selectedClientId} onValueChange={setSelectedClientId}>
              <SelectTrigger className="w-full md:w-96" aria-label="Select client" data-testid="select-client">
                <SelectValue placeholder="Select a client to view trends" />
              </SelectTrigger>
              <SelectContent>
                {clients?.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.firmName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {chartData.length > 0 && (
          <div className="space-y-6">
            <Card className="bg-card border-primary/10">
              <CardHeader>
                <CardTitle className="text-foreground">{t("leads")} Volume & {t("cases")} Over Time</CardTitle>
              </CardHeader>
              <CardContent>
                <div
                  className="h-80"
                  role="img"
                  aria-label={`Bar chart of monthly ${t("leads").toLowerCase()}, ${t("consults").toLowerCase()}, and ${t("cases").toLowerCase()} across ${chartData.length} months. Totals appear in the Summary Statistics section below.`}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 12 }} />
                      <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 12 }} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: "hsl(var(--card))", 
                          color: "hsl(var(--foreground))",
                          border: "1px solid hsl(var(--primary))",
                          borderRadius: "0px"
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 14 }} />
                      <Bar dataKey="leads" name={t("leads")} fill={SERIES.primary} />
                      <Bar dataKey="consults" name={t("consults")} fill={SERIES.primarySoft} />
                      <Bar dataKey="cases" name={t("cases")} fill={SERIES.accent} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card border-primary/10">
              <CardHeader>
                <CardTitle className="text-foreground">Conversion Rates Over Time</CardTitle>
              </CardHeader>
              <CardContent>
                <div
                  className="h-80"
                  role="img"
                  aria-label={`Line chart of lead-to-consult and consult-to-case conversion rates by month. Average conversion appears in the Summary Statistics section below.`}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 12 }} />
                      <YAxis stroke="hsl(var(--muted-foreground))" unit="%" tick={{ fontSize: 12 }} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: "hsl(var(--card))", 
                          color: "hsl(var(--foreground))",
                          border: "1px solid hsl(var(--primary))",
                          borderRadius: "0px"
                        }}
                        formatter={(value: number) => [`${value}%`, ""]}
                      />
                      <Legend wrapperStyle={{ fontSize: 14 }} />
                      <Line 
                        type="monotone" 
                        dataKey="conversionRate" 
                        name="Lead to Consult" 
                        stroke={SERIES.primary}
                        strokeWidth={2}
                        dot={{ fill: SERIES.primary, strokeWidth: 2 }}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="closeRate" 
                        name="Consult to Case" 
                        stroke={SERIES.ok}
                        strokeWidth={2}
                        strokeDasharray="6 3"
                        dot={{ fill: SERIES.ok, strokeWidth: 2 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card className="bg-card border-primary/10">
                <CardHeader>
                  <CardTitle className="text-foreground">Ad Spend Over Time</CardTitle>
                </CardHeader>
                <CardContent>
                  <div
                    className="h-64"
                    role="img"
                    aria-label="Bar chart of total monthly ad spend. The all-months total appears in the Summary Statistics section below."
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 12 }} />
                        <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 12 }} tickFormatter={(v) => `$${v.toLocaleString()}`} />
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: "hsl(var(--card))", 
                          color: "hsl(var(--foreground))",
                            border: "1px solid hsl(var(--primary))",
                            borderRadius: "0px"
                          }}
                          formatter={(value: number) => [`$${value.toLocaleString()}`, "Ad Spend"]}
                        />
                        <Bar dataKey="adSpend" name="Total Ad Spend" fill={SERIES.primary} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card border-primary/10">
                <CardHeader>
                  <CardTitle className="text-foreground">Avg Case Value Over Time</CardTitle>
                </CardHeader>
                <CardContent>
                  <div
                    className="h-64"
                    role="img"
                    aria-label="Line chart of average case value by month."
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 12 }} />
                        <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 12 }} tickFormatter={(v) => `$${v.toLocaleString()}`} />
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: "hsl(var(--card))", 
                          color: "hsl(var(--foreground))",
                            border: "1px solid hsl(var(--primary))",
                            borderRadius: "0px"
                          }}
                          formatter={(value: number) => [`$${value.toLocaleString()}`, "Case Value"]}
                        />
                        <Line 
                          type="monotone" 
                          dataKey="caseValue" 
                          name="Avg Case Value" 
                          stroke="hsl(var(--primary))" 
                          strokeWidth={2}
                          dot={{ fill: "hsl(var(--primary))", strokeWidth: 2 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card className="bg-card border-primary/10">
              <CardHeader>
                <CardTitle className="text-foreground">Summary Statistics</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="p-4 bg-surface-warm-1 text-center">
                    <p className="text-2xl font-bold text-foreground">
                      {chartData.reduce((sum, d) => sum + d.leads, 0).toLocaleString()}
                    </p>
                    <p className="text-sm text-muted-foreground">Total {t("leads")}</p>
                  </div>
                  <div className="p-4 bg-surface-warm-1 text-center">
                    <p className="text-2xl font-bold text-foreground">
                      {chartData.reduce((sum, d) => sum + d.cases, 0).toLocaleString()}
                    </p>
                    <p className="text-sm text-muted-foreground">Total {t("cases")}</p>
                  </div>
                  <div className="p-4 bg-surface-warm-1 text-center">
                    <p className="text-2xl font-bold text-foreground">
                      ${chartData.reduce((sum, d) => sum + d.adSpend, 0).toLocaleString()}
                    </p>
                    <p className="text-sm text-muted-foreground">Total Ad Spend</p>
                  </div>
                  <div className="p-4 bg-surface-warm-1 text-center">
                    <p className="text-2xl font-bold text-foreground">
                      {chartData.length > 0 
                        ? `${(chartData.reduce((sum, d) => sum + d.conversionRate, 0) / chartData.length).toFixed(1)}%`
                        : "0%"}
                    </p>
                    <p className="text-sm text-muted-foreground">Avg Conversion</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {selectedClientId && chartData.length === 0 && (
          <Card className="bg-card border-primary/10">
            <CardContent className="py-6">
              {/* Distinguish a failed fetch from a genuinely report-less client —
                  a transient error must not read as "this client has no reports". */}
              <EmptyState
                testId="empty-trends"
                title={reportsError ? "Couldn't load reports" : `No reports yet for ${selectedClient?.firmName ?? "this client"}`}
                description={reportsError
                  ? "Something went wrong fetching this client's reports. Try again in a moment."
                  : "Create monthly reports to see trend data here."}
              />
            </CardContent>
          </Card>
        )}

        {!selectedClientId && (
          <Card className="bg-card border-primary/10">
            <CardContent className="py-6">
              <EmptyState
                testId="empty-trends-no-client"
                title="Pick a client to get started"
                description="Their monthly performance trends will chart here."
              />
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
