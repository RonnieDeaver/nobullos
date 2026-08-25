import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/admin/PageHeader";
import { SERVICE_DESK_STATUS_COLORS, SERVICE_DESK_STATUS_FALLBACK } from "@/lib/serviceDeskStatusColors";
import {
  Clock, CheckCircle2, AlertTriangle, TrendingUp, BarChart2,
  ClipboardList, Calendar, Download,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface VolumeTrendPoint {
  startMs: number;
  created: number;
  closed: number;
}

interface BreakdownRow {
  name: string;
  count: number;
  closed: number;
  avgTtrMs: number | null;
}

interface AgingBucket {
  label: string;
  count: number;
}

interface OldestTicket {
  id: string;
  name: string;
  status: string;
  departmentName: string;
  requestType: string;
  createdMs: number | null;
  ageMs: number;
}

interface StatusFlowItem {
  status: string;
  count: number;
}

interface ReportData {
  configured: boolean;
  dateRange?: { fromMs: number; toMs: number };
  volume?: { created: number; closed: number; openBacklog: number; trend: VolumeTrendPoint[] };
  timeToResolve?: { avgMs: number | null; medianMs: number | null; sampleCount: number };
  breakdowns?: {
    byDepartment: BreakdownRow[];
    byRequestType: BreakdownRow[];
    byPriority: BreakdownRow[];
    byAssignee?: BreakdownRow[];
  };
  aging?: AgingBucket[];
  oldestOpen?: OldestTicket[];
  commitment?: { onTimePercent: number | null; slipCount: number; overdueCount: number };
  statusFlow?: StatusFlowItem[];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  const hours = ms / 3_600_000;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  return `${(days / 30).toFixed(1)}mo`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Task #4481: ClickUp status colors are canonical for this surface — the
// categorical series lives in the documented palette module. Semantic chart
// series (created/closed/aging) map to the status tokens instead.
const DAYS_OPTIONS = [
  { label: "Last 7 days", value: 7 },
  { label: "Last 30 days", value: 30 },
  { label: "Last 90 days", value: 90 },
];

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, icon: Icon, warn,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  warn?: boolean;
}) {
  return (
    <Card data-testid={`kpi-card-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <Icon className={`h-4 w-4 ${warn ? "text-amber-500" : "text-muted-foreground"}`} />
          <span className="text-xs text-muted-foreground font-medium">{label}</span>
        </div>
        <p className={`text-2xl font-bold ${warn ? "text-amber-600" : "text-foreground"}`}>
          {value}
        </p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ─── Breakdown Table ──────────────────────────────────────────────────────────

function BreakdownTable({ title, rows, testId }: { title: string; rows: BreakdownRow[]; testId: string }) {
  if (!rows.length) return null;
  return (
    <Card>
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm font-semibold text-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table data-testid={testId}>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Name</TableHead>
              <TableHead className="text-xs text-right">Created</TableHead>
              <TableHead className="text-xs text-right">Closed</TableHead>
              <TableHead className="text-xs text-right">Avg TTR</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.name} data-testid={`breakdown-row-${row.name}`}>
                <TableCell className="text-sm py-2">
                  {row.name === "Unmapped" ? (
                    <span className="text-muted-foreground italic">Unmapped</span>
                  ) : row.name}
                </TableCell>
                <TableCell className="text-sm py-2 text-right">{row.count}</TableCell>
                <TableCell className="text-sm py-2 text-right">{row.closed}</TableCell>
                <TableCell className="text-sm py-2 text-right text-muted-foreground">
                  {formatMs(row.avgTtrMs)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ServiceDeskReports() {
  const [days, setDays] = useState(30);

  const { data: report, isLoading, error } = useQuery<ReportData>({
    queryKey: ["/api/service-desk/reports", days],
    queryFn: () =>
      fetch(`/api/service-desk/reports?days=${days}`, { credentials: "include" }).then((r) =>
        r.json(),
      ),
    staleTime: 60_000,
  });

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-muted/50">
      {/* Header — shared admin PageHeader anatomy (Task #4450; audit §6.1-B),
          kept inside the page's white sub-bar container. */}
      <div className="bg-card border-b border-border px-6 py-4">
        <PageHeader
          className="max-w-7xl mx-auto"
          title="Service Desk Reports"
          icon={BarChart2}
          backHref="/admin/service-desk/home"
          backLabel="Back to Home"
          subtitle="Volume, TTR, commitment & status analytics"
          actions={
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            {/* Date range selector */}
            <div className="flex gap-1" data-testid="date-range-selector">
              {DAYS_OPTIONS.map((opt) => (
                <Button
                  key={opt.value}
                  variant={days === opt.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setDays(opt.value)}
                  data-testid={`date-range-${opt.value}`}
                  className="text-xs"
                >
                  {opt.label}
                </Button>
              ))}
            </div>

            {/* CSV export */}
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={!report?.configured}
              onClick={() => {
                window.location.href = `/api/service-desk/reports/export?days=${days}`;
              }}
              data-testid="button-export-csv"
            >
              <Download className="h-3.5 w-3.5 mr-1" />
              Download CSV
            </Button>
          </div>
          }
        />
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Not configured */}
        {!isLoading && report && !report.configured && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <ClipboardList className="h-10 w-10 mx-auto mb-3 text-slate-300" />
              <p className="font-medium">Service Desk not configured</p>
              <p className="text-sm mt-1">
                Set up the ClickUp list mapping in{" "}
                <Link href="/admin/service-desk" className="underline text-amber-700">
                  Settings
                </Link>{" "}
                first.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Error state */}
        {error && (
          <Card className="border-red-200">
            <CardContent className="py-6 text-center text-red-500 text-sm">
              Failed to load report data. Please try refreshing.
            </CardContent>
          </Card>
        )}

        {/* Loading skeleton */}
        {isLoading && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <Skeleton className="h-3 w-20 mb-2" />
                  <Skeleton className="h-8 w-12" />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Main content */}
        {!isLoading && report?.configured && report.volume && (
          <>
            {/* Date range label */}
            {report.dateRange && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Calendar className="h-3.5 w-3.5" />
                <span>
                  {formatDate(report.dateRange.fromMs)} – {formatDate(report.dateRange.toMs)}
                </span>
              </div>
            )}

            {/* KPI row */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <KpiCard
                label="Open Backlog"
                value={report.volume.openBacklog}
                icon={ClipboardList}
                warn={report.volume.openBacklog > 20}
              />
              <KpiCard
                label="Created"
                value={report.volume.created}
                sub="in period"
                icon={TrendingUp}
              />
              <KpiCard
                label="Closed"
                value={report.volume.closed}
                sub="in period"
                icon={CheckCircle2}
              />
              <KpiCard
                label="Avg TTR"
                value={formatMs(report.timeToResolve?.avgMs ?? null)}
                sub={
                  report.timeToResolve?.sampleCount
                    ? `${report.timeToResolve.sampleCount} tickets`
                    : undefined
                }
                icon={Clock}
              />
              <KpiCard
                label="Median TTR"
                value={formatMs(report.timeToResolve?.medianMs ?? null)}
                icon={Clock}
              />
              <KpiCard
                label="On-Time %"
                value={
                  report.commitment?.onTimePercent !== null &&
                  report.commitment?.onTimePercent !== undefined
                    ? `${report.commitment.onTimePercent}%`
                    : "—"
                }
                icon={AlertTriangle}
                warn={
                  report.commitment?.onTimePercent !== null &&
                  report.commitment?.onTimePercent !== undefined &&
                  report.commitment.onTimePercent < 80
                }
              />
            </div>

            {/* Commitment row */}
            <div className="grid grid-cols-2 gap-4">
              <Card data-testid="card-commitment-slips">
                <CardContent className="p-4 flex items-center gap-4">
                  <AlertTriangle className="h-8 w-8 text-amber-400 shrink-0" />
                  <div>
                    <p className="text-2xl font-bold text-foreground">
                      {report.commitment?.slipCount ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground">Committed-date slips in period</p>
                  </div>
                </CardContent>
              </Card>
              <Card data-testid="card-commitment-overdue">
                <CardContent className="p-4 flex items-center gap-4">
                  <Clock className="h-8 w-8 text-red-400 shrink-0" />
                  <div>
                    <p className="text-2xl font-bold text-foreground">
                      {report.commitment?.overdueCount ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground">Open tickets past committed date</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Volume trend chart */}
            {report.volume.trend.length > 0 && (
              <Card>
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-sm font-semibold text-foreground">
                    Volume Trend
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <ResponsiveContainer width="100%" height={180} data-testid="volume-trend-chart">
                    <AreaChart data={report.volume.trend}>
                      <defs>
                        <linearGradient id="colorCreated" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(var(--status-warn))" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(var(--status-warn))" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="colorClosed" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(var(--status-ok))" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(var(--status-ok))" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" />
                      <XAxis
                        dataKey="startMs"
                        tickFormatter={(v) => formatDate(v)}
                        tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        labelFormatter={(v) => formatDate(Number(v))}
                        formatter={(val, name) => [val, name === "created" ? "Created" : "Closed"]}
                      />
                      <Area
                        type="monotone"
                        dataKey="created"
                        stroke="hsl(var(--status-warn))"
                        strokeWidth={2}
                        fill="url(#colorCreated)"
                      />
                      <Area
                        type="monotone"
                        dataKey="closed"
                        stroke="hsl(var(--status-ok))"
                        strokeWidth={2}
                        fill="url(#colorClosed)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                  <div className="flex gap-4 mt-2 justify-center">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="w-3 h-0.5 bg-status-warn inline-block rounded" /> Created
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="w-3 h-0.5 bg-status-ok inline-block rounded" /> Closed
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Breakdowns row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <BreakdownTable
                title="By Department"
                rows={report.breakdowns?.byDepartment ?? []}
                testId="breakdown-by-department"
              />
              <BreakdownTable
                title="By Request Type"
                rows={report.breakdowns?.byRequestType ?? []}
                testId="breakdown-by-request-type"
              />
              <BreakdownTable
                title="By Priority"
                rows={report.breakdowns?.byPriority ?? []}
                testId="breakdown-by-priority"
              />
            </div>

            {/* By Assignee */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <BreakdownTable
                title="By Assignee"
                rows={report.breakdowns?.byAssignee ?? []}
                testId="breakdown-by-assignee"
              />
            </div>

            {/* Status flow + Aging row */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Status flow */}
              {report.statusFlow && report.statusFlow.length > 0 && (
                <Card>
                  <CardHeader className="py-3 px-4">
                    <CardTitle className="text-sm font-semibold text-foreground">
                      Current Status Distribution
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <ResponsiveContainer
                      width="100%"
                      height={220}
                      data-testid="status-flow-chart"
                    >
                      <BarChart
                        data={report.statusFlow}
                        layout="vertical"
                        margin={{ left: 8, right: 12 }}
                      >
                        <XAxis
                          type="number"
                          allowDecimals={false}
                          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          type="category"
                          dataKey="status"
                          width={130}
                          tick={{ fontSize: 10, fill: "hsl(var(--foreground))" }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          formatter={(val) => [val, "Tickets"]}
                        />
                        <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                          {report.statusFlow.map((entry) => (
                            <Cell
                              key={entry.status}
                              fill={SERVICE_DESK_STATUS_COLORS[entry.status] ?? SERVICE_DESK_STATUS_FALLBACK}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}

              {/* Aging distribution */}
              {report.aging && (
                <Card>
                  <CardHeader className="py-3 px-4">
                    <CardTitle className="text-sm font-semibold text-foreground">
                      Open Ticket Aging
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <ResponsiveContainer width="100%" height={220} data-testid="aging-chart">
                      <BarChart data={report.aging}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" vertical={false} />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          allowDecimals={false}
                          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip formatter={(val) => [val, "Open tickets"]} />
                        <Bar dataKey="count" fill="hsl(var(--status-warn))" radius={[3, 3, 0, 0]}>
                          {report.aging.map((entry) => (
                            <Cell
                              key={entry.label}
                              fill={entry.label === ">14d" ? "hsl(var(--status-critical))" : "hsl(var(--status-warn))"}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Oldest open tickets */}
            {report.oldestOpen && report.oldestOpen.length > 0 && (
              <Card>
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-sm font-semibold text-foreground">
                    Oldest Open Tickets
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table data-testid="oldest-open-table">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Ticket</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs">Department</TableHead>
                        <TableHead className="text-xs">Request Type</TableHead>
                        <TableHead className="text-xs text-right">Age</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.oldestOpen.map((ticket) => (
                        <TableRow key={ticket.id} data-testid={`oldest-ticket-${ticket.id}`}>
                          <TableCell className="text-sm py-2">
                            <Link
                              href={`/admin/service-desk/tickets/${ticket.id}`}
                              className="text-amber-700 underline underline-offset-2 hover:text-amber-800"
                            >
                              {ticket.name || ticket.id}
                            </Link>
                          </TableCell>
                          <TableCell className="py-2">
                            <Badge
                              variant="outline"
                              className="text-xs capitalize"
                              style={{ borderColor: SERVICE_DESK_STATUS_COLORS[ticket.status] ?? SERVICE_DESK_STATUS_FALLBACK }}
                            >
                              {ticket.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm py-2 text-muted-foreground">
                            {ticket.departmentName}
                          </TableCell>
                          <TableCell className="text-sm py-2 text-muted-foreground">
                            {ticket.requestType}
                          </TableCell>
                          <TableCell className="text-sm py-2 text-right font-medium">
                            {formatMs(ticket.ageMs)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
