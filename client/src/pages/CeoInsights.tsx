import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { useQuery } from "@tanstack/react-query";
import { CeoInsightsSkeleton, CeoInsightsContentSkeleton } from "@/components/ui/skeleton-loaders";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OsTable, type OsTableColumn } from "@/components/ui/os-table";
import { KpiCard } from "@/components/kit/KpiCard";
import { StatusPill } from "@/components/kit/StatusPill";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/admin/PageHeader";
import { Link } from "wouter";
import {
  BarChart3,
  AlertTriangle,
  TrendingUp,
  Clock,
  CheckCircle2,
  XCircle,
  UserCheck,
  AlertCircle,
  Calendar,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  MessageSquare,
  Snowflake,
  Sun,
  Leaf,
  CloudSun,
} from "lucide-react";
import { getTermLabel, dataAccessCategoryDefs, type ClientTerminology } from "@shared/schema";

type Client = {
  id: string;
  firmName: string;
  ownerId: string | null;
  isArchived: boolean;
  isDemo: boolean;
  createdAt: string;
  terminology?: ClientTerminology | null;
};

type Report = {
  id: string;
  clientId: string;
  reportMonth: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  ceoPulseId: string | null;
};

type ReportSection = {
  id: string;
  reportId: string;
  clientId: string;
  reportMonth: string;
  reportStatus: string;
  sectionKey: string;
  data: any;
  updatedAt: string;
};

type User = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
};

type DataAccess = {
  id: string;
  clientId: string;
  category: string;
  status: string;
  notes: string | null;
};

/**
 * Task #4463 — categories come from the shared single source of truth
 * (shared/models/clients.ts) so labels here can never diverge from the
 * client-management surfaces again. Table headers use the compact
 * `shortLabel` variant so the gaps-matrix columns stay narrow.
 */
const DATA_ACCESS_CATEGORIES = dataAccessCategoryDefs.map(d => ({
  key: d.id,
  label: d.label,
  shortLabel: d.shortLabel,
}));

/** Rows the mobile lists show before the "Show all" escape hatch. */
const MOBILE_TOP_N = 10;

/** Sort rank per data-access status — worst first when ascending. */
const GAP_STATUS_RANK: Record<string, number> = {
  refused: 0,
  unknown: 1,
  pending: 1,
  available: 2,
};

type GapRow = {
  client: Client;
  statusByCategory: Record<string, string>;
  hasPostConsult: boolean;
  hasPostCase: boolean;
  /** Labels for every gap (categories + review feeds) — mobile caption. */
  gapLabels: string[];
  totalIssues: number;
  /** Explicit refusals are the actionable-now signal — the only red on the page. */
  refusedCount: number;
};

type TrackerRow = {
  client: Client;
  monthStatus: Record<string, { status: string; id: string }>;
  finalCount: number;
};

/** Per-category cell mark. Red is reserved for refused (the chase list). */
function AccessMark({ status }: { status: string }) {
  if (status === "available") {
    return <CheckCircle2 aria-label="Have it" className="mx-auto h-4 w-4 text-status-ok/80" />;
  }
  if (status === "refused") {
    return <XCircle aria-label="Refused" className="mx-auto h-4 w-4 text-status-critical" />;
  }
  return (
    <span
      aria-label="Missing or pending"
      title="Missing / pending"
      className="mx-auto block h-2 w-2 rounded-pill bg-muted-foreground/30"
    />
  );
}

/** Review-feed cell mark: a standing "not connected" is neutral, not red. */
function ReviewMark({ connected }: { connected: boolean }) {
  return connected ? (
    <CheckCircle2 aria-label="Connected" className="mx-auto h-4 w-4 text-status-ok/80" />
  ) : (
    <Minus aria-label="Not connected" className="mx-auto h-4 w-4 text-muted-foreground/40" />
  );
}

function MonthMark({ entry }: { entry: { status: string; id: string } }) {
  if (entry.status === "missing") {
    return (
      <span
        title="No report"
        aria-label="No report"
        className="mx-auto flex h-6 w-6 items-center justify-center rounded-pill bg-muted"
      >
        <Minus className="h-3 w-3 text-muted-foreground/60" />
      </span>
    );
  }
  if (entry.status === "draft") {
    return (
      <Link href={`/reports/${entry.id}`}>
        <span
          title="Draft — open editor"
          aria-label="Draft report"
          className="mx-auto block h-6 w-6 cursor-pointer rounded-pill border-2 border-status-warn bg-status-warn/15"
        />
      </Link>
    );
  }
  return (
    <Link href={`/reports/${entry.id}`}>
      <span
        title="Final — view report"
        aria-label="Final report"
        className="mx-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-pill bg-status-ok"
      >
        <CheckCircle2 className="h-4 w-4 text-white" />
      </span>
    </Link>
  );
}

function MomDelta({ label, change }: { label: string; change: number | null }) {
  if (change === null) return null;
  return (
    <div className="flex items-center gap-1">
      <span className="text-muted-foreground">{label}:</span>
      <span
        className={cn(
          "flex items-center font-bold",
          change > 0 ? "text-status-ok" : change < 0 ? "text-status-critical" : "text-muted-foreground",
        )}
      >
        {change > 0 ? (
          <ArrowUpRight className="h-3 w-3" />
        ) : change < 0 ? (
          <ArrowDownRight className="h-3 w-3" />
        ) : (
          <Minus className="h-3 w-3" />
        )}
        {Math.abs(change)}%
      </span>
    </div>
  );
}

function monthShortLabel(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short" });
}

export default function CeoInsights() {
  const { user, isLoading: authLoading } = useAuth();
  usePageTitle("CEO Insights");

  const [showAllGapsMobile, setShowAllGapsMobile] = useState(false);
  const [showAllTrackerMobile, setShowAllTrackerMobile] = useState(false);

  const { data: clients = [], isLoading: clientsLoading } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    queryFn: async () => {
      const res = await fetch("/api/clients", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch clients");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: reports = [], isLoading: reportsLoading } = useQuery<Report[]>({
    queryKey: ["/api/reports"],
    queryFn: async () => {
      const res = await fetch("/api/reports", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch reports");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: users = [], isLoading: usersLoading } = useQuery<User[]>({
    queryKey: ["/api/users"],
    queryFn: async () => {
      const res = await fetch("/api/users", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: allDataAccess = [], isLoading: dataAccessLoading } = useQuery<DataAccess[]>({
    queryKey: ["/api/all-data-access"],
    queryFn: async () => {
      const res = await fetch("/api/all-data-access", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
  });

  const { data: allSections = [], isLoading: sectionsLoading } = useQuery<ReportSection[]>({
    queryKey: ["/api/all-report-sections"],
    queryFn: async () => {
      const res = await fetch("/api/all-report-sections", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
  });

  const coreDataLoading = clientsLoading || reportsLoading || usersLoading;
  const supplementaryLoading = dataAccessLoading || sectionsLoading;

  if (authLoading) {
    return <CeoInsightsSkeleton />;
  }

  if (!user || user.role !== "ceo") {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="pt-6 text-center">
            <AlertTriangle className="w-12 h-12 text-status-warn mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">Access Restricted</h2>
            <p className="text-muted-foreground mb-4">This page is only available to CEO users.</p>
            <Link href="/">
              <Button>Return to Dashboard</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const activeClients = clients.filter(c => !c.isArchived);
  const accountManagers = users.filter(u => u.role === "account_manager" || u.role === "team_lead");

  // ── Data gaps (per client) ────────────────────────────────────────────────
  const gapRows: GapRow[] = activeClients.map(client => {
    const clientAccess = allDataAccess.filter(da => da.clientId === client.id);
    const statusByCategory: Record<string, string> = {};
    const gapLabels: string[] = [];
    let refusedCount = 0;
    DATA_ACCESS_CATEGORIES.forEach(cat => {
      const status = clientAccess.find(da => da.category === cat.key)?.status || "unknown";
      statusByCategory[cat.key] = status;
      if (status === "refused") refusedCount++;
      if (status !== "available") gapLabels.push(cat.label);
    });
    const hasPostConsult = Boolean((client as any).hasPostConsultReviewAccess);
    const hasPostCase = Boolean((client as any).hasPostCaseClosedReviewAccess);
    if (!hasPostConsult) gapLabels.push("Post-Consult Reviews");
    if (!hasPostCase) gapLabels.push("Post-Case Reviews");
    return {
      client,
      statusByCategory,
      hasPostConsult,
      hasPostCase,
      gapLabels,
      totalIssues: gapLabels.length,
      refusedCount,
    };
  });

  const clientsMissingDataCount = gapRows.filter(row =>
    DATA_ACCESS_CATEGORIES.some(
      cat => row.statusByCategory[cat.key] === "refused" || row.statusByCategory[cat.key] === "pending",
    ),
  ).length;

  const noPostConsultCount = gapRows.filter(row => !row.hasPostConsult).length;

  const now = new Date();
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const stalledClients = activeClients.filter(client => {
    const clientReports = reports.filter(r => r.clientId === client.id);
    if (clientReports.length === 0) return true;
    const sortedReports = [...clientReports].sort((a, b) =>
      new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
    );
    const latestReport = sortedReports[0];
    const reportDate = new Date(latestReport.updatedAt || latestReport.createdAt);
    return reportDate < sixtyDaysAgo;
  });

  const calculateClientScore = (client: Client) => {
    const clientAccess = allDataAccess.filter(da => da.clientId === client.id);
    const clientReports = reports.filter(r => r.clientId === client.id);

    let dataScore = 0;
    const categoryCount = DATA_ACCESS_CATEGORIES.length;
    DATA_ACCESS_CATEGORIES.forEach(cat => {
      const access = clientAccess.find(da => da.category === cat.key);
      if (access?.status === "available") dataScore += 40 / categoryCount;
      else if (access?.status === "pending") dataScore += 10 / categoryCount;
    });

    const reportScore = Math.min(clientReports.length * 5, 30);
    const isActive = !stalledClients.find(sc => sc.id === client.id);
    const activityScore = isActive ? 30 : 0;

    return Math.round(Math.min(dataScore + reportScore + activityScore, 100));
  };

  const amStats = accountManagers.map(am => {
    const amClients = activeClients.filter(c => c.ownerId === am.id);
    const amDataAccess = allDataAccess.filter(da =>
      amClients.some(c => c.id === da.clientId)
    );

    let available = 0;
    let total = amClients.length * DATA_ACCESS_CATEGORIES.length;

    amClients.forEach(client => {
      DATA_ACCESS_CATEGORIES.forEach(cat => {
        const access = amDataAccess.find(da =>
          da.clientId === client.id && da.category === cat.key
        );
        if (access?.status === "available") available++;
      });
    });

    const complianceRate = total > 0 ? Math.round((available / total) * 100) : 0;

    return {
      user: am,
      clientCount: amClients.length,
      complianceRate,
    };
  });

  const needsAttentionClients = activeClients
    .map(client => {
      const issues: string[] = [];
      const score = calculateClientScore(client);

      if (stalledClients.find(sc => sc.id === client.id)) {
        issues.push("Stalled (60+ days)");
      }

      const clientAccess = allDataAccess.filter(da => da.clientId === client.id);
      const refusedCategories = DATA_ACCESS_CATEGORIES.filter(cat =>
        clientAccess.find(da => da.category === cat.key && da.status === "refused")
      );
      if (refusedCategories.length > 0) {
        issues.push(`Refused: ${refusedCategories.map(c => c.label).join(", ")}`);
      }

      if (score < 40) {
        issues.push("Low engagement score");
      }

      return { client, issues, score };
    })
    .filter(item => item.issues.length > 0)
    .sort((a, b) => a.score - b.score);

  // ── Report completion tracker (per client × last 6 months) ───────────────
  const getLast6Months = () => {
    const months: string[] = [];
    const nowDate = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return months;
  };
  const last6Months = getLast6Months();

  const trackerRows: TrackerRow[] = activeClients.map(client => {
    const clientReports = reports.filter(r => r.clientId === client.id);
    const monthStatus: Record<string, { status: string; id: string }> = {};
    let finalCount = 0;
    last6Months.forEach(month => {
      const report = clientReports.find(r => r.reportMonth === month);
      const entry = report
        ? { status: report.status, id: report.id }
        : { status: 'missing', id: '' };
      monthStatus[month] = entry;
      if (entry.status !== 'missing' && entry.status !== 'draft') finalCount++;
    });
    return { client, monthStatus, finalCount };
  });

  const SEASONAL_INSIGHTS = [
    { months: [1, 2], season: 'Winter', icon: Snowflake, insights: ['Divorce filings spike after holidays', 'DUI cases increase from holiday parties', 'New Year resolution-driven consultations'] },
    { months: [3, 4, 5], season: 'Spring', icon: Leaf, insights: ['Tax-related legal issues peak', 'Spring break DUI enforcement', 'Home buying legal services increase'] },
    { months: [6, 7, 8], season: 'Summer', icon: Sun, insights: ['Custody disputes around summer schedules', 'Vacation-related injuries', 'Construction accident cases rise'] },
    { months: [9, 10, 11, 12], season: 'Fall/Holiday', icon: CloudSun, insights: ['Back-to-school custody modifications', 'Holiday shopping injury claims', 'Year-end estate planning push'] },
  ];

  const currentMonth = new Date().getMonth() + 1;
  const currentSeason = SEASONAL_INSIGHTS.find(s => s.months.includes(currentMonth)) || SEASONAL_INSIGHTS[0];

  const calculateMoMChange = (clientId: string, metric: 'leads' | 'cases' | 'consults') => {
    const clientSections = allSections
      .filter(s => s.clientId === clientId)
      .sort((a, b) => b.reportMonth.localeCompare(a.reportMonth));

    if (clientSections.length < 2) return null;

    const getValue = (sections: ReportSection[], key: string) => {
      if (key === 'leads') {
        const marketing = sections.find(s => s.sectionKey === 'marketing');
        if (!marketing) return 0;
        const data = marketing.data as any;
        const gbpLeads = (data.gbpLocations || []).reduce((sum: number, loc: any) => sum + (loc.uniqueLeads || 0), 0);
        const adsLeads = data.googleAds?.uniqueLeads || 0;
        const lsaLeads = data.lsa?.uniqueLeads || 0;
        return gbpLeads + adsLeads + lsaLeads;
      }
      if (key === 'cases') {
        const sales = sections.find(s => s.sectionKey === 'sales');
        return (sales?.data as any)?.totalCases || 0;
      }
      if (key === 'consults') {
        const intake = sections.find(s => s.sectionKey === 'intake');
        return (intake?.data as any)?.totalConsults || 0;
      }
      return 0;
    };

    const currentMonthSections = clientSections.filter(s => s.reportMonth === clientSections[0].reportMonth);
    const prevMonthSections = clientSections.filter(s => s.reportMonth === clientSections.find(x => x.reportMonth !== clientSections[0].reportMonth)?.reportMonth);

    if (prevMonthSections.length === 0) return null;

    const current = getValue(currentMonthSections, metric);
    const previous = getValue(prevMonthSections, metric);

    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  };

  const momSummary = activeClients.map(client => ({
    client,
    leadsChange: calculateMoMChange(client.id, 'leads'),
    casesChange: calculateMoMChange(client.id, 'cases'),
    consultsChange: calculateMoMChange(client.id, 'consults'),
  })).filter(item => item.leadsChange !== null || item.casesChange !== null || item.consultsChange !== null);

  // ── Table columns (plain consts below the early returns — see memory) ────
  const gapColumns: Array<OsTableColumn<GapRow>> = [
    {
      key: "client",
      header: "Client",
      sortable: true,
      sortValue: row => row.client.firmName.toLowerCase(),
      cell: row => (
        <Link href={`/clients/${row.client.id}`}>
          <span className="block max-w-[200px] cursor-pointer truncate font-medium text-primary-ink hover:underline">
            {row.client.firmName}
          </span>
        </Link>
      ),
    },
    {
      key: "gaps",
      header: "Gaps",
      sortable: true,
      align: "center",
      sortValue: row => row.totalIssues + row.refusedCount * 100,
      cell: row =>
        row.refusedCount > 0 ? (
          <StatusPill tone="critical" dot testId={`pill-gaps-${row.client.id}`}>
            {row.totalIssues} · refused
          </StatusPill>
        ) : (
          <StatusPill testId={`pill-gaps-${row.client.id}`}>{row.totalIssues}</StatusPill>
        ),
    },
    ...DATA_ACCESS_CATEGORIES.map(
      (cat): OsTableColumn<GapRow> => ({
        key: cat.key,
        header: cat.shortLabel,
        sortable: true,
        align: "center",
        sortValue: row => GAP_STATUS_RANK[row.statusByCategory[cat.key]] ?? 1,
        cell: row => <AccessMark status={row.statusByCategory[cat.key]} />,
      }),
    ),
    {
      key: "postConsult",
      header: "Post-Consult",
      sortable: true,
      align: "center",
      sortValue: row => (row.hasPostConsult ? 1 : 0),
      cell: row => <ReviewMark connected={row.hasPostConsult} />,
    },
    {
      key: "postCase",
      header: "Post-Case",
      sortable: true,
      align: "center",
      sortValue: row => (row.hasPostCase ? 1 : 0),
      cell: row => <ReviewMark connected={row.hasPostCase} />,
    },
  ];

  const trackerColumns: Array<OsTableColumn<TrackerRow>> = [
    {
      key: "client",
      header: "Client",
      sortable: true,
      sortValue: row => row.client.firmName.toLowerCase(),
      cell: row => (
        <Link href={`/clients/${row.client.id}`}>
          <span className="block max-w-[200px] cursor-pointer truncate font-medium text-primary-ink hover:underline">
            {row.client.firmName}
          </span>
        </Link>
      ),
    },
    {
      key: "complete",
      header: "Filed",
      sortable: true,
      align: "center",
      sortValue: row => row.finalCount,
      cell: row => (
        <StatusPill testId={`pill-filed-${row.client.id}`}>
          {row.finalCount}/{last6Months.length}
        </StatusPill>
      ),
    },
    ...last6Months.map(
      (month): OsTableColumn<TrackerRow> => ({
        key: month,
        header: monthShortLabel(month),
        sortable: true,
        align: "center",
        sortValue: row => {
          const s = row.monthStatus[month].status;
          return s === "missing" ? 0 : s === "draft" ? 1 : 2;
        },
        cell: row => <MonthMark entry={row.monthStatus[month]} />,
      }),
    ),
  ];

  // Mobile bounded lists: worst-first / fewest-filed-first, top N + "Show all".
  const gapRowsWorstFirst = [...gapRows].sort(
    (a, b) => b.totalIssues + b.refusedCount * 100 - (a.totalIssues + a.refusedCount * 100),
  );
  const visibleMobileGapRows = showAllGapsMobile
    ? gapRowsWorstFirst
    : gapRowsWorstFirst.slice(0, MOBILE_TOP_N);
  const trackerRowsBehindFirst = [...trackerRows].sort((a, b) => a.finalCount - b.finalCount);
  const visibleMobileTrackerRows = showAllTrackerMobile
    ? trackerRowsBehindFirst
    : trackerRowsBehindFirst.slice(0, MOBILE_TOP_N);

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      {/* Task #4710 — standard page-header grammar (PageHeader, Task #4344)
          on the light canvas; replaces the legacy bg-primary band whose bare
          h1 was repainted illegible by the base-layer heading rule. */}
      <div className="max-w-7xl mx-auto px-4 pt-4 sm:px-6 sm:pt-6">
        <PageHeader
          title="CEO Insights"
          icon={BarChart3}
          backHref="/"
          backLabel="Dashboard"
          actions={
            <div className="text-sm text-muted-foreground" data-testid="text-header-summary">
              {coreDataLoading ? "Loading data..." : `${activeClients.length} active clients · ${reports.length} total reports`}
            </div>
          }
        />
      </div>

      <main className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
        {coreDataLoading && <CeoInsightsContentSkeleton />}
        {!coreDataLoading && <>
        {supplementaryLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground animate-pulse">
            <div className="w-2 h-2 rounded-pill bg-primary/40" />
            <span>Loading detailed analytics...</span>
          </div>
        )}

        {/* Problem summary — what needs fixing right now */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3" data-testid="grid-kpi-cards">
          <KpiCard
            testId="card-clients-missing-data"
            label="Clients Missing Data"
            icon={<AlertTriangle className="h-4 w-4" />}
            value={supplementaryLoading ? "—" : clientsMissingDataCount}
            caption={
              supplementaryLoading
                ? "Loading data access…"
                : `of ${activeClients.length} active clients · pending or refused data access`
            }
            accent={!supplementaryLoading && clientsMissingDataCount > 0 ? "critical" : undefined}
          />
          <KpiCard
            testId="card-no-post-consult-reviews"
            label="No Post-Consult Reviews"
            icon={<MessageSquare className="h-4 w-4" />}
            value={noPostConsultCount}
            caption={`of ${activeClients.length} active clients · review feed not connected`}
            accent={noPostConsultCount > 0 ? "warn" : undefined}
          />
          <KpiCard
            testId="card-stalled-clients"
            label="Stalled Clients"
            icon={<Clock className="h-4 w-4" />}
            value={stalledClients.length}
            caption="no report created or updated in the last 60 days"
            accent={stalledClients.length > 0 ? "warn" : undefined}
          />
        </div>

        {/* Main data-gaps table — THE primary view */}
        <Card data-testid="card-data-gaps-by-client">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-status-warn" />
              Data Gaps by Client
            </CardTitle>
            <CardDescription>What's missing for each client — fix these to improve reporting</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Desktop: the full matrix on the shared OsTable primitive —
                bounded viewport, sticky header + sticky client column, sortable. */}
            <div className="hidden md:block">
              <OsTable
                columns={gapColumns}
                rows={gapRows}
                rowKey={row => row.client.id}
                defaultSort={{ key: "gaps", direction: "desc" }}
                maxHeight="65vh"
                emptyState="No active clients."
                data-testid="table-data-gaps"
              />
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-status-ok/80" /> Have it
                </span>
                <span className="flex items-center gap-1.5">
                  <XCircle className="h-3.5 w-3.5 text-status-critical" /> Refused
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-pill bg-muted-foreground/30" /> Missing / pending
                </span>
                <span className="flex items-center gap-1.5">
                  <Minus className="h-3.5 w-3.5 text-muted-foreground/40" /> Review feed not connected
                </span>
              </div>
            </div>
            {/* Mobile: bounded worst-first list — "Show all" is the path to the full set. */}
            <div className="md:hidden">
              <ul className="divide-y divide-border" data-testid="list-data-gaps-mobile">
                {visibleMobileGapRows.map(row => (
                  <li
                    key={row.client.id}
                    className="flex items-center justify-between gap-3 py-2.5"
                    data-testid={`row-gap-mobile-${row.client.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <Link href={`/clients/${row.client.id}`}>
                        <span className="block truncate font-medium text-primary-ink hover:underline">
                          {row.client.firmName}
                        </span>
                      </Link>
                      {row.gapLabels.length > 0 && (
                        <p className="truncate text-caption text-muted-foreground">
                          Missing: {row.gapLabels.join(", ")}
                        </p>
                      )}
                    </div>
                    {row.refusedCount > 0 ? (
                      <StatusPill tone="critical" dot>{row.totalIssues} · refused</StatusPill>
                    ) : (
                      <StatusPill>{row.totalIssues} {row.totalIssues === 1 ? "gap" : "gaps"}</StatusPill>
                    )}
                  </li>
                ))}
              </ul>
              {gapRows.length > MOBILE_TOP_N && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 w-full"
                  onClick={() => setShowAllGapsMobile(v => !v)}
                  data-testid="button-toggle-all-gaps-mobile"
                >
                  {showAllGapsMobile ? `Show top ${MOBILE_TOP_N} only` : `Show all ${gapRows.length} clients`}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* AM performance — simplified inline */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card data-testid="card-am-data-compliance">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-primary" />
                AM Data Compliance
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {amStats.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No account managers found</p>
                ) : (
                  amStats.sort((a, b) => b.complianceRate - a.complianceRate).slice(0, 5).map(am => (
                    <div key={am.user.id} className="flex items-center gap-2 text-sm" data-testid={`row-am-compliance-${am.user.id}`}>
                      <span className="w-24 truncate">
                        {am.user.firstName && am.user.lastName
                          ? `${am.user.firstName} ${am.user.lastName}`
                          : (am.user as any).email?.split('@')[0] || `AM #${am.user.id.slice(-4)}`}
                      </span>
                      <Progress value={am.complianceRate} className="flex-1 h-2" />
                      <span
                        className={cn(
                          "w-12 text-right font-medium",
                          am.complianceRate >= 70
                            ? "text-status-ok"
                            : am.complianceRate >= 40
                              ? "text-status-warn"
                              : "text-status-critical",
                        )}
                      >
                        {am.complianceRate}%
                      </span>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-clients-needing-attention">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-status-warn" />
                Clients Needing Attention (<span data-testid="text-needs-attention-count">{needsAttentionClients.length}</span>)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {needsAttentionClients.slice(0, 5).map(({ client, issues }) => (
                  <div key={client.id} className="flex items-center justify-between text-sm" data-testid={`row-attention-${client.id}`}>
                    <Link href={`/clients/${client.id}`}>
                      <span className="text-primary-ink hover:underline">{client.firmName}</span>
                    </Link>
                    <StatusPill>{issues.length} {issues.length === 1 ? "issue" : "issues"}</StatusPill>
                  </div>
                ))}
                {needsAttentionClients.length === 0 && <p className="text-muted-foreground text-sm">All clients OK</p>}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Essential views */}
        <Tabs defaultValue="calendar" className="w-full" data-testid="tabs-essential-views">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="calendar" data-testid="tab-calendar">
              <Calendar className="w-4 h-4 mr-2" /> Report Calendar
            </TabsTrigger>
            <TabsTrigger value="trends" data-testid="tab-trends">
              <TrendingUp className="w-4 h-4 mr-2" /> MoM Trends
            </TabsTrigger>
          </TabsList>

          <TabsContent value="calendar">
            <Card data-testid="card-report-calendar">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="w-5 h-5 text-primary" />
                  Report Completion Tracker
                </CardTitle>
                <CardDescription>Monthly report status for each client (last 6 months) — fewest filed first</CardDescription>
              </CardHeader>
              <CardContent>
                {/* Desktop: OsTable with sticky header/client column, sortable months. */}
                <div className="hidden md:block">
                  <OsTable
                    columns={trackerColumns}
                    rows={trackerRows}
                    rowKey={row => row.client.id}
                    defaultSort={{ key: "complete", direction: "asc" }}
                    maxHeight="60vh"
                    emptyState="No active clients."
                    data-testid="table-report-tracker"
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="flex h-4 w-4 items-center justify-center rounded-pill bg-status-ok">
                        <CheckCircle2 className="h-3 w-3 text-white" />
                      </span>
                      Final
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-4 w-4 rounded-pill border-2 border-status-warn bg-status-warn/15" /> Draft
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-4 w-4 rounded-pill bg-muted" /> Missing
                    </span>
                  </div>
                </div>
                {/* Mobile: bounded fewest-filed-first list with the full-list escape hatch. */}
                <div className="md:hidden">
                  <ul className="divide-y divide-border" data-testid="list-report-tracker-mobile">
                    {visibleMobileTrackerRows.map(row => (
                      <li
                        key={row.client.id}
                        className="flex items-center justify-between gap-3 py-2.5"
                        data-testid={`row-tracker-mobile-${row.client.id}`}
                      >
                        {/* min-w-0 on the flex child so the long firm name can actually truncate
                            instead of forcing the row (and page) to overflow at 375px. */}
                        <Link href={`/clients/${row.client.id}`} className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-primary-ink hover:underline">
                            {row.client.firmName}
                          </span>
                        </Link>
                        <StatusPill className="shrink-0">{row.finalCount}/{last6Months.length} filed</StatusPill>
                      </li>
                    ))}
                  </ul>
                  {trackerRows.length > MOBILE_TOP_N && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 w-full"
                      onClick={() => setShowAllTrackerMobile(v => !v)}
                      data-testid="button-toggle-all-tracker-mobile"
                    >
                      {showAllTrackerMobile ? `Show top ${MOBILE_TOP_N} only` : `Show all ${trackerRows.length} clients`}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="trends">
            <Card data-testid="card-mom-trends">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-primary" />
                  Month-over-Month Summary
                </CardTitle>
                <CardDescription>Key metric changes with seasonal context</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-4 border border-primary/20 bg-gradient-to-r from-primary/10 to-transparent p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <currentSeason.icon className="w-4 h-4 text-primary" />
                    <span className="font-medium text-foreground">{currentSeason.season} Season</span>
                  </div>
                  <p className="text-caption text-muted-foreground">{currentSeason.insights[0]}</p>
                </div>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {momSummary.map(({ client, leadsChange, casesChange, consultsChange }) => (
                    <div key={client.id} className="flex items-center gap-4 bg-muted/50 p-3" data-testid={`row-mom-${client.id}`}>
                      <div className="flex-1 min-w-0">
                        <Link href={`/clients/${client.id}`}>
                          <span className="font-medium text-primary-ink hover:underline cursor-pointer truncate block">
                            {client.firmName}
                          </span>
                        </Link>
                      </div>
                      <div className="flex gap-4 text-sm">
                        <MomDelta label={getTermLabel(client.terminology, "leads")} change={leadsChange} />
                        <MomDelta label={getTermLabel(client.terminology, "cases")} change={casesChange} />
                        <MomDelta label={getTermLabel(client.terminology, "consults")} change={consultsChange} />
                      </div>
                    </div>
                  ))}
                  {momSummary.length === 0 && (
                    <p className="text-center text-muted-foreground py-4">No comparison data available (need 2+ months of reports)</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

        </Tabs>
        </>}
      </main>
    </div>
  );
}
