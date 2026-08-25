import { useState, useMemo } from "react";
import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Link, useLocation } from "wouter";
import {
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileText,
  Pencil,
  Plus,
  TrendingUp,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/admin/PageHeader";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { ReportMatrixSkeleton } from "@/components/ui/skeleton-loaders";
import { Skeleton } from "@/components/ui/skeleton";
import { OsTable, type OsTableColumn } from "@/components/ui/os-table";
import { StatusPill } from "@/components/kit/StatusPill";
import { EmptyState } from "@/components/kit/EmptyState";
import { cn } from "@/lib/utils";
import {
  computeClientTriage,
  monthKeyOffset,
  type ClientTriage,
  type TriageInputRow,
} from "@/lib/reportMatrixTriage";
import { HideDemoToggle } from "@/components/HideDemoToggle";
import { useHideDemoAccounts } from "@/hooks/use-hide-demo-accounts";
import { partitionDemoAccounts } from "@/lib/demoAccounts";

type MatrixRow = TriageInputRow;

type OpenableReport = { id: string; status: string; shareToken: string | null };

function getMonthColumns(startMonth: string, count: number): string[] {
  const [year, month] = startMonth.split("-").map(Number);
  const months: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(year, month - 1 + i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

function formatMonthShort(month: string): string {
  try {
    const [year, m] = month.split("-");
    return format(new Date(parseInt(year), parseInt(m) - 1), "MMM yyyy");
  } catch {
    return month;
  }
}

function formatMonthCompact(month: string): string {
  try {
    const [year, m] = month.split("-");
    return format(new Date(parseInt(year), parseInt(m) - 1), "MMM ''yy");
  } catch {
    return month;
  }
}

/**
 * One client row of the triage lists (Task #4351). Used by BOTH the
 * action-first view (all widths) and the mobile all-clients list, so 375w
 * always gets per-client status plus touch-sized create/open actions instead
 * of the data-dropping table.
 */
function TriageRow({
  entry,
  showStatusLine,
  creating,
  onCreate,
  onOpen,
}: {
  entry: ClientTriage;
  /** All-clients mode: adds the latest-report caption + "Up to date" pill. */
  showStatusLine?: boolean;
  creating: boolean;
  onCreate: (clientId: string, month: string) => void;
  onOpen: (report: OpenableReport) => void;
}) {
  const createMonth = entry.dueMonth ?? entry.missingMonths[0] ?? null;
  const openDraft = entry.drafts.length > 0 ? entry.drafts[0] : null;
  const latest = entry.latest;

  return (
    <li
      className="flex flex-col gap-3 p-4 md:flex-row md:items-center"
      data-testid={`action-row-${entry.clientId}`}
    >
      <div className="min-w-0 flex-1">
        <Link href={`/clients/${entry.clientId}`} className="hover:underline">
          <span
            className="text-sm font-semibold text-foreground"
            data-testid={`action-firm-${entry.clientId}`}
          >
            {entry.firmName}
          </span>
        </Link>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {entry.dueMonth && (
            <StatusPill tone="warn" dot testId={`pill-due-${entry.clientId}`}>
              {formatMonthShort(entry.dueMonth)} due
            </StatusPill>
          )}
          {entry.missingMonths.length > 0 && (
            <StatusPill testId={`pill-missing-${entry.clientId}`}>
              {entry.missingMonths.length} earlier missing
            </StatusPill>
          )}
          {entry.drafts.length > 0 && (
            <StatusPill tone="info" testId={`pill-drafts-${entry.clientId}`}>
              {entry.drafts.length} draft{entry.drafts.length > 1 ? "s" : ""}
            </StatusPill>
          )}
          {showStatusLine && !entry.needsAction && (
            <StatusPill testId={`pill-uptodate-${entry.clientId}`}>Up to date</StatusPill>
          )}
          {showStatusLine && (
            <span className="text-xs text-muted-foreground">
              {latest ? (
                <>
                  Latest: {formatMonthCompact(latest.month)} ·{" "}
                  <span className="capitalize">{latest.report.status}</span>
                </>
              ) : (
                "No reports yet"
              )}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {createMonth && (
          <Button
            size="sm"
            disabled={creating}
            onClick={() => onCreate(entry.clientId, createMonth)}
            className="min-h-11 bg-primary text-primary-foreground hover:bg-primary/90 md:min-h-9"
            data-testid={`button-create-${entry.clientId}`}
          >
            <Plus className="mr-1 h-4 w-4" />
            Create {formatMonthCompact(createMonth)}
          </Button>
        )}
        {openDraft && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpen(openDraft.report)}
            className="min-h-11 border-primary/30 text-primary-ink md:min-h-9"
            data-testid={`button-open-draft-${entry.clientId}`}
          >
            Open draft
          </Button>
        )}
        {latest && (!openDraft || openDraft.report.id !== latest.report.id) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpen(latest.report)}
            className="min-h-11 text-primary-ink hover:bg-primary/5 md:min-h-9"
            data-testid={`button-open-latest-${entry.clientId}`}
          >
            Open latest
          </Button>
        )}
      </div>
    </li>
  );
}

export default function ReportMatrix() {
  const { user, isLoading: authLoading } = useAuth();
  usePageTitle("All Reports");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const defaultStart = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}`;
  const [startMonth, setStartMonth] = useState(defaultStart);
  const monthCount = 12;
  // Action-first by default (design audit P0-4): the ~95%-empty grid is the
  // secondary mode, reached via the view toggle.
  const [view, setView] = useState<"action" | "grid">("action");

  const months = useMemo(() => getMonthColumns(startMonth, monthCount), [startMonth, monthCount]);

  const { data: matrixData, isLoading, error: matrixError } = useQuery<MatrixRow[]>({
    queryKey: ["/api/reports/matrix"],
    queryFn: async () => {
      const res = await fetch("/api/reports/matrix", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch report matrix");
      return res.json();
    },
    enabled: !!user,
  });

  // Task #4363 — global hide-demo filter (audit P3-4): partition before
  // triage so every KPI card, view count, and list below stays consistent
  // while it filters.
  const [hideDemo, setHideDemo] = useHideDemoAccounts(user?.id);
  const demoPartition = useMemo(
    () => partitionDemoAccounts(matrixData ?? [], hideDemo),
    [matrixData, hideDemo],
  );
  const visibleMatrix = demoPartition.visible;
  const hiddenDemoCount = demoPartition.hiddenDemoCount;

  const triage = useMemo(
    () => computeClientTriage(visibleMatrix, new Date()),
    [visibleMatrix],
  );

  const createReportMutation = useMutation({
    mutationFn: async ({ clientId, month }: { clientId: string; month: string }) => {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ clientId, reportMonth: month }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to create report");
      }
      return res.json();
    },
    onSuccess: (report) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      navigate(`/reports/${report.id}`);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create report", description: error.message, variant: "destructive" });
    },
  });

  const shiftMonths = (delta: number) => {
    const [year, month] = startMonth.split("-").map(Number);
    const d = new Date(year, month - 1 + delta, 1);
    setStartMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  if (authLoading) {
    return <ReportMatrixSkeleton />;
  }

  if (!user) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <p className="text-muted-foreground">Please log in to view this page.</p>
      </div>
    );
  }

  const sortedData = visibleMatrix.slice().sort((a, b) => a.firmName.localeCompare(b.firmName));

  const totalReports = sortedData.reduce((sum, row) => sum + Object.keys(row.reports).length, 0);
  const finalReports = sortedData.reduce((sum, row) => 
    sum + Object.values(row.reports).filter(r => r.status === "final").length, 0
  );
  const draftReports = totalReports - finalReports;

  const dueMonthKey = monthKeyOffset(new Date(), -1);
  const needsActionRows = triage.filter((e) => e.needsAction);
  const allClientsAlpha = [...triage].sort((a, b) => a.firmName.localeCompare(b.firmName));

  const openReport = (report: OpenableReport) => {
    if (report.status === "final" && report.shareToken) {
      navigate(`/share/${report.shareToken}`);
    } else {
      navigate(`/reports/${report.id}`);
    }
  };

  const handleCreate = (clientId: string, month: string) =>
    createReportMutation.mutate({ clientId, month });

  // Grid column defs stay plain consts below the early returns (OsTable
  // adopter convention — no JSX generics, no hooks needed).
  const clientColumn: OsTableColumn<MatrixRow> = {
    key: "client",
    header: "Client",
    sortable: true,
    sortValue: (r) => r.firmName,
    width: 200,
    cell: (r) => (
      <Link href={`/clients/${r.clientId}`} className="hover:underline">
        <span className="text-sm font-medium text-foreground" data-testid={`text-firm-${r.clientId}`}>
          {r.firmName}
        </span>
      </Link>
    ),
  };

  const monthColumnDefs: Array<OsTableColumn<MatrixRow>> = months.map((month) => ({
    key: month,
    header: formatMonthCompact(month),
    align: "center" as const,
    width: 100,
    cellClassName: "p-1",
    cell: (row: MatrixRow) => {
      const report = row.reports[month];
      if (report) {
        // Task #4537 — presented/delivered mark: a final+presented cell must
        // read visibly different from final-but-not-presented so operators
        // can scan delivery coverage across months at a glance.
        const isPresented = !!report.presentedAt;
        // Task #4801 — finalized reports STAY editable (section PUTs carry no
        // status gate). A final cell's main click opens the client deck, so
        // without a second affordance the edit form becomes tribal knowledge:
        // pair every deck-routed cell with an explicit pencil button.
        const opensDeck = report.status === "final" && !!report.shareToken;
        const statusButton = (
          <button
            onClick={() => openReport(report)}
            title={
              isPresented
                ? `Presented/Delivered ${format(new Date(report.presentedAt!), "MMM d, yyyy")}`
                : opensDeck
                  ? `Open client deck for ${formatMonthShort(month)}`
                  : undefined
            }
            className={`flex min-h-9 ${opensDeck ? "min-w-0 flex-1" : "w-full"} items-center justify-center gap-1 rounded border px-1.5 text-xs transition-colors ${
              report.status === "final"
                ? isPresented
                  ? "border-status-ok/60 bg-status-ok/25 text-status-ok hover:bg-status-ok/30"
                  : "border-status-ok/40 bg-status-ok/10 text-status-ok hover:bg-status-ok/20"
                : "border-status-warn/40 bg-status-warn/10 text-status-warn hover:bg-status-warn/20"
            }`}
            data-testid={`cell-report-${row.clientId}-${month}`}
          >
            {isPresented && (
              <CheckCircle2
                className="h-3 w-3 shrink-0"
                data-testid={`icon-presented-${row.clientId}-${month}`}
              />
            )}
            <span className="font-medium capitalize">{report.status}</span>
            {(report.totalLeads > 0 || report.totalCases > 0) && (
              <span className="text-[11px] opacity-80">
                {report.totalLeads > 0 ? `${report.totalLeads}L` : ""}
                {report.totalLeads > 0 && report.totalCases > 0 ? "·" : ""}
                {report.totalCases > 0 ? `${report.totalCases}C` : ""}
              </span>
            )}
          </button>
        );
        if (!opensDeck) return statusButton;
        return (
          <div className="flex w-full items-stretch gap-1">
            {statusButton}
            <button
              onClick={() => navigate(`/reports/${report.id}`)}
              title={`Edit ${formatMonthShort(month)} report for ${row.firmName}`}
              aria-label={`Edit ${formatMonthShort(month)} report for ${row.firmName}`}
              className="flex min-h-9 shrink-0 items-center justify-center rounded border border-status-ok/40 bg-status-ok/10 px-1.5 text-status-ok transition-colors hover:bg-status-ok/20"
              data-testid={`button-edit-report-${row.clientId}-${month}`}
            >
              <Pencil className="h-3 w-3" />
            </button>
          </div>
        );
      }
      const isDue = month === dueMonthKey;
      return (
        <button
          onClick={() => handleCreate(row.clientId, month)}
          disabled={createReportMutation.isPending}
          title={`Create ${formatMonthShort(month)} report for ${row.firmName}`}
          aria-label={`Create ${formatMonthShort(month)} report for ${row.firmName}`}
          className={`flex min-h-9 w-full items-center justify-center gap-1 rounded border px-1.5 text-xs transition-colors ${
            isDue
              ? "border-dashed border-status-warn/60 bg-status-warn/10 font-medium text-status-warn hover:bg-status-warn/20"
              : "border-transparent text-foreground/30 hover:border-primary/20 hover:bg-primary/5 hover:text-primary-ink"
          }`}
          data-testid={`cell-empty-${row.clientId}-${month}`}
        >
          <Plus className="h-3.5 w-3.5" />
          {isDue && <span>Due</span>}
        </button>
      );
    },
  }));

  const gridColumns: Array<OsTableColumn<MatrixRow>> = [clientColumn, ...monthColumnDefs];

  const monthToolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => shiftMonths(-6)}
        className="border-primary/30 text-primary-ink"
        data-testid="button-shift-back"
      >
        <ChevronLeft className="mr-1 h-4 w-4" />
        6 mo
      </Button>
      <span className="px-1 text-sm text-muted-foreground" data-testid="text-month-range">
        {formatMonthShort(months[0])} — {formatMonthShort(months[months.length - 1])}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => shiftMonths(6)}
        className="border-primary/30 text-primary-ink"
        data-testid="button-shift-forward"
      >
        6 mo
        <ChevronRight className="ml-1 h-4 w-4" />
      </Button>
    </div>
  );

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      {/* Task #4710 — standard page-header grammar (PageHeader, Task #4344)
          on the light canvas; replaces the legacy bg-primary band whose bare
          h1 was repainted illegible by the base-layer heading rule. */}
      <div className="max-w-[1600px] mx-auto px-4 pt-4 sm:px-6 sm:pt-6">
        <PageHeader
          title="All Reports"
          backHref="/"
          backLabel="Dashboard"
          backTestId="button-back-dashboard"
          actions={
            /* Persistent, touch-friendly create path — no hover-only affordance. */
            <Button
              asChild
              size="sm"
              className="min-h-11 sm:min-h-9"
              data-testid="button-new-report"
            >
              <Link href="/reports/new">
                <Plus className="mr-1 h-4 w-4" />
                New Report
              </Link>
            </Button>
          }
        />
      </div>

      <main className="max-w-[1600px] mx-auto p-4 sm:p-6">
        {/* Task #4363 — global hide-demo filter (audit P3-4): visible above
            the KPI cards it scopes; all four cards and both views derive
            from the filtered rows. */}
        <div className="mb-3 flex justify-end">
          <HideDemoToggle
            surface="matrix"
            checked={hideDemo}
            onCheckedChange={setHideDemo}
            hiddenCount={hiddenDemoCount}
          />
        </div>
        <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <div className="bg-card rounded-lg border border-primary/10 p-4" data-testid="card-needs-action">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <CalendarClock className="w-4 h-4" />
              Needing Action
            </div>
            <div
              className={`text-2xl font-bold ${needsActionRows.length > 0 ? "text-status-warn" : "text-foreground"}`}
              data-testid="text-needs-action"
            >
              {needsActionRows.length}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Due, missing, or draft reports</div>
          </div>
          <div className="bg-card rounded-lg border border-primary/10 p-4" data-testid="card-total-clients">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Users className="w-4 h-4" />
              Active Clients
            </div>
            <div className="text-2xl font-bold text-foreground" data-testid="text-total-clients">{sortedData.length}</div>
          </div>
          <div className="bg-card rounded-lg border border-primary/10 p-4" data-testid="card-total-reports">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <FileText className="w-4 h-4" />
              Total Reports
            </div>
            <div className="text-2xl font-bold text-foreground" data-testid="text-total-reports">{totalReports}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{finalReports} final, {draftReports} draft</div>
          </div>
          <div className="bg-card rounded-lg border border-primary/10 p-4" data-testid="card-completion">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <TrendingUp className="w-4 h-4" />
              Window Coverage
            </div>
            <div className="text-2xl font-bold text-foreground" data-testid="text-coverage">
              {sortedData.length > 0 
                ? Math.round((months.reduce((count, m) => count + sortedData.filter(r => r.reports[m]).length, 0) / (sortedData.length * monthCount)) * 100)
                : 0}%
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Reports filled in visible window</div>
          </div>
        </div>

        <div className="bg-card rounded-lg border border-primary/10 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-primary/10 p-4">
            {/* No color utility: inherits the base-layer heading ink
                (Earth on light, warm-light in dark) — dark text-primary
                measured ~3:1 here (Task #4710). */}
            <h2 className="text-lg font-semibold">Report Matrix</h2>
            <div
              role="group"
              aria-label="Matrix view"
              className="inline-flex rounded-md border border-primary/20 bg-surface-warm-1/60 p-0.5"
            >
              <button
                type="button"
                aria-pressed={view === "action"}
                onClick={() => setView("action")}
                className={cn(
                  "min-h-9 rounded px-3 text-sm font-medium transition-colors",
                  view === "action"
                    ? "bg-primary text-primary-foreground"
                    : "text-primary-ink hover:bg-primary/10",
                )}
                data-testid="button-view-action"
              >
                Needs action{needsActionRows.length > 0 ? ` (${needsActionRows.length})` : ""}
              </button>
              <button
                type="button"
                aria-pressed={view === "grid"}
                onClick={() => setView("grid")}
                className={cn(
                  "min-h-9 rounded px-3 text-sm font-medium transition-colors",
                  view === "grid"
                    ? "bg-primary text-primary-foreground"
                    : "text-primary-ink hover:bg-primary/10",
                )}
                data-testid="button-view-grid"
              >
                All clients
              </button>
            </div>
          </div>

          {matrixError ? (
            <div className="p-8 text-center">
              <div className="text-status-critical font-medium mb-1">Unable to load report data</div>
              <div className="text-sm text-muted-foreground">Please refresh the page or try again later.</div>
            </div>
          ) : isLoading ? (
            <div className="p-4">
              <div className="space-y-3">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-5 w-32" />
                    {Array.from({ length: 6 }).map((_, j) => (
                      <Skeleton key={j} className="h-10 w-[90px] rounded-md" />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : sortedData.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
              {hideDemo && (matrixData ?? []).length > 0
                ? `All ${(matrixData ?? []).length} clients are demo accounts — hidden by the demo filter.`
                : "No clients found. Add a client to get started."}
            </div>
          ) : view === "action" ? (
            needsActionRows.length === 0 ? (
              <EmptyState
                testId="empty-caught-up"
                icon={<CheckCircle2 />}
                title="All caught up"
                description={`Every active client has a ${formatMonthShort(dueMonthKey)} report and no drafts are waiting.`}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setView("grid")}
                    className="border-primary/30 text-primary-ink"
                    data-testid="button-caught-up-view-grid"
                  >
                    View all clients
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y divide-primary/10" data-testid="list-needs-action">
                {needsActionRows.map((entry) => (
                  <TriageRow
                    key={entry.clientId}
                    entry={entry}
                    creating={createReportMutation.isPending}
                    onCreate={handleCreate}
                    onOpen={openReport}
                  />
                ))}
              </ul>
            )
          ) : (
            <>
              {/* Desktop: the full pivot grid on the shared OsTable primitive —
                  bounded viewport, sticky header row + sticky client column. */}
              <div className="hidden p-3 sm:p-4 md:block">
                <OsTable
                  columns={gridColumns}
                  rows={sortedData}
                  rowKey={(r) => r.clientId}
                  defaultSort={{ key: "client", direction: "asc" }}
                  maxHeight="68vh"
                  toolbar={monthToolbar}
                  data-testid="table-report-matrix"
                />
                <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <div className="h-3 w-3 rounded border border-status-ok/40 bg-status-ok/10"></div>
                    Final
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="flex h-3 w-3 items-center justify-center rounded border border-status-ok/60 bg-status-ok/25">
                      <CheckCircle2 className="h-2.5 w-2.5 text-status-ok" />
                    </div>
                    Presented
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="flex h-3 w-3 items-center justify-center rounded border border-status-ok/40 bg-status-ok/10">
                      <Pencil className="h-2.5 w-2.5 text-status-ok" />
                    </div>
                    Edit final report
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="h-3 w-3 rounded border border-status-warn/40 bg-status-warn/10"></div>
                    Draft
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="h-3 w-3 rounded border border-dashed border-status-warn/60 bg-status-warn/10"></div>
                    Due (create)
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="h-3 w-3 rounded border border-border bg-card"></div>
                    No report (+ creates)
                  </div>
                  <span className="ml-2">L = Leads · C = Cases</span>
                </div>
              </div>
              {/* Mobile: the grid would drop every data column at 375w, so the
                  all-clients mode renders the same per-client status list. */}
              <ul className="divide-y divide-primary/10 md:hidden" data-testid="list-all-clients">
                {allClientsAlpha.map((entry) => (
                  <TriageRow
                    key={entry.clientId}
                    entry={entry}
                    showStatusLine
                    creating={createReportMutation.isPending}
                    onCreate={handleCreate}
                    onOpen={openReport}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
