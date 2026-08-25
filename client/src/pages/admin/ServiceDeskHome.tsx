import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Link } from "wouter";
import { PageHeader } from "@/components/admin/PageHeader";
import { EmptyState } from "@/components/kit/EmptyState";
import {
  ClipboardList,
  AlertCircle,
  Clock,
  CheckCircle2,
  Users,
  CalendarClock,
  RefreshCw,
  Search,
  Plus,
  ExternalLink,
  XCircle,
  BarChart2,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface SdTicketResolved {
  clickupTaskId: string;
  name: string;
  status: string | null;
  statusColor: string | null;
  url: string | null;
  priority: any;
  priorityName: string | null;
  dateCreated: string | null;
  dateUpdated: string | null;
  clientId: number | null;
  resolvedClientId: string | null;
  clientName: string | null;
  requesterUserId: string | null;
  requesterRaw: string | null;
  ownerUserId: string | null;
  departmentId: string | null;
  requestType: string | null;
  requestedDate: string | null;
  committedDate: string | null;
  waitingWho: string | null;
  waitingWhat: string | null;
  waitingWhen: string | null;
  assignees: Array<{ id: string; username: string }>;
  readAt: string | null;
  lastNotifiedAt: string | null;
}

interface ViewCounts {
  my_submitted: number;
  assigned_to_me: number;
  waiting_on_me: number;
  my_department: number;
  due_today: number;
  overdue: number;
  recently_updated: number;
  delivered_for_review: number;
  closed: number;
}

interface SdDepartment {
  id: string;
  name: string;
  active: boolean;
}

// ─── View tab config ────────────────────────────────────────────────────────────

const VIEWS = [
  { key: "my_submitted", label: "My Requests", icon: ClipboardList },
  { key: "assigned_to_me", label: "Assigned to Me", icon: Users },
  { key: "waiting_on_me", label: "Waiting on Me", icon: Clock },
  { key: "my_department", label: "My Department", icon: Users },
  { key: "due_today", label: "Due Today", icon: CalendarClock },
  { key: "overdue", label: "Overdue", icon: AlertCircle },
  { key: "recently_updated", label: "Recently Updated", icon: RefreshCw },
  { key: "delivered_for_review", label: "For My Review", icon: CheckCircle2 },
  { key: "closed", label: "Closed", icon: XCircle },
] as const;

type ViewKey = (typeof VIEWS)[number]["key"];

// ─── Status badge helper ─────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  "submitted": "bg-slate-100 text-slate-700 dark:bg-slate-800/40 dark:text-slate-300",
  "scheduled": "bg-blue-100 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300",
  "in progress": "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-300",
  "needs information": "bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
  "waiting on account manager": "bg-orange-100 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300",
  "waiting on client": "bg-orange-100 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300",
  "waiting on approval": "bg-orange-100 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300",
  "blocked": "bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-300",
  "quality review": "bg-purple-100 text-purple-700 dark:bg-purple-950/30 dark:text-purple-300",
  "delivered": "bg-teal-100 text-teal-700 dark:bg-teal-950/30 dark:text-teal-300",
  "closed": "bg-slate-100 text-slate-500 dark:bg-slate-800/40 dark:text-slate-400",
  "reopened": "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/30 dark:text-yellow-300",
  "out of scope": "bg-slate-100 text-slate-500 dark:bg-slate-800/40 dark:text-slate-400",
  "canceled": "bg-slate-100 text-slate-500 dark:bg-slate-800/40 dark:text-slate-400",
  "duplicate": "bg-slate-100 text-slate-500 dark:bg-slate-800/40 dark:text-slate-400",
};

function StatusBadge({ status }: { status: string | null }) {
  const s = (status ?? "").toLowerCase();
  const cls = STATUS_COLORS[s] ?? "bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-300";
  const label = s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : "—";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function formatCommittedDate(dateMs: string | null): { label: string; overdue: boolean } {
  if (!dateMs) return { label: "—", overdue: false };
  const ms = Number(dateMs);
  if (isNaN(ms)) return { label: "—", overdue: false };
  const d = new Date(ms);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const overdue = d < todayStart;
  return {
    label: d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    overdue,
  };
}

// ─── Main Component ───────────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { key: "created_desc", label: "Newest first" },
  { key: "created_asc", label: "Oldest first" },
  { key: "updated_desc", label: "Recently updated" },
  { key: "committed_asc", label: "Committed date (soonest)" },
  { key: "committed_desc", label: "Committed date (latest)" },
] as const;

type SortKey = (typeof SORT_OPTIONS)[number]["key"];

function sortTickets(tickets: SdTicketResolved[], sortKey: SortKey): SdTicketResolved[] {
  const num = (v: string | null) => {
    const n = Number(v);
    return isNaN(n) ? null : n;
  };
  const sorted = [...tickets];
  switch (sortKey) {
    case "created_asc":
      return sorted.sort((a, b) => (num(a.dateCreated) ?? 0) - (num(b.dateCreated) ?? 0));
    case "created_desc":
      return sorted.sort((a, b) => (num(b.dateCreated) ?? 0) - (num(a.dateCreated) ?? 0));
    case "updated_desc":
      return sorted.sort((a, b) => (num(b.dateUpdated) ?? 0) - (num(a.dateUpdated) ?? 0));
    case "committed_asc":
      // Tickets without a committed date sink to the bottom
      return sorted.sort(
        (a, b) => (num(a.committedDate) ?? Infinity) - (num(b.committedDate) ?? Infinity),
      );
    case "committed_desc":
      return sorted.sort(
        (a, b) => (num(b.committedDate) ?? -Infinity) - (num(a.committedDate) ?? -Infinity),
      );
    default:
      return sorted;
  }
}

export default function ServiceDeskHome() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ceo" || user?.role === "team_lead";
  const [activeView, setActiveView] = useState<ViewKey>("my_submitted");
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("created_desc");

  const countsQuery = useQuery<{ counts: ViewCounts; configured: boolean }>({
    queryKey: ["/api/service-desk/views/counts"],
    queryFn: () =>
      apiRequest("GET", "/api/service-desk/views/counts").then((r) => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const ticketsQuery = useQuery<{ tickets: SdTicketResolved[]; configured: boolean }>({
    queryKey: ["/api/service-desk/tickets", activeView],
    queryFn: () =>
      apiRequest("GET", `/api/service-desk/tickets?view=${activeView}`).then((r) => r.json()),
    staleTime: 20_000,
  });

  const deptsQuery = useQuery<{ departments: SdDepartment[] }>({
    queryKey: ["/api/service-desk/departments"],
    queryFn: () =>
      apiRequest("GET", "/api/service-desk/departments").then((r) => r.json()),
    staleTime: 60_000,
  });

  const counts = countsQuery.data?.counts ?? ({} as ViewCounts);
  const configured = countsQuery.data?.configured ?? true;
  const tickets = ticketsQuery.data?.tickets ?? [];
  const departments = deptsQuery.data?.departments ?? [];

  // Statuses actually present in the current view (for the status filter dropdown)
  const availableStatuses = Array.from(
    new Set(tickets.map((t) => (t.status ?? "").toLowerCase()).filter(Boolean)),
  ).sort();

  const filteredTickets = sortTickets(
    tickets.filter((t) => {
      if (search) {
        const q = search.toLowerCase();
        const matchName = t.name?.toLowerCase().includes(q);
        const matchClient = t.clientName?.toLowerCase().includes(q);
        const matchType = t.requestType?.toLowerCase().includes(q);
        if (!matchName && !matchClient && !matchType) return false;
      }
      if (deptFilter && deptFilter !== "all") {
        if (t.departmentId !== deptFilter) return false;
      }
      if (statusFilter && statusFilter !== "all") {
        if ((t.status ?? "").toLowerCase() !== statusFilter) return false;
      }
      return true;
    }),
    sortKey,
  );

  if (!user) return null;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header — shared admin PageHeader anatomy (Task #4450; audit §6.1-B).
          Previously the Service Desk hub shipped no back affordance at all. */}
      <PageHeader
        title="Service Desk"
        backHref="/"
        backLabel="Dashboard"
        subtitle="Submit and track internal service requests"
        actions={
          <div className="flex flex-wrap gap-2 min-w-0">
            {isAdmin && (
              <Button asChild variant="outline" size="sm" data-testid="button-service-desk-reports">
                <Link href="/admin/service-desk/reports">
                  <BarChart2 className="h-4 w-4 mr-1" />
                  Reports
                </Link>
              </Button>
            )}
            {isAdmin && (
              <Button asChild variant="outline" size="sm">
                <Link href="/admin/service-desk">
                  Settings
                </Link>
              </Button>
            )}
            <Button asChild size="sm" data-testid="button-new-request">
              <Link href="/service-desk/create">
                <Plus className="h-4 w-4 mr-1" />
                New Request
              </Link>
            </Button>
          </div>
        }
      />

      {/* Not configured notice */}
      {!configured && (
        <Card className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
          <CardContent className="py-3 px-4 text-sm text-amber-700 dark:text-amber-300 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Service Desk is not yet configured. An admin must set up the ClickUp list binding first.
          </CardContent>
        </Card>
      )}

      {/* 9-view tabs */}
      <Tabs value={activeView} onValueChange={(v) => setActiveView(v as ViewKey)}>
        <TabsList className="flex flex-wrap h-auto gap-1 bg-slate-100 dark:bg-slate-800/40 p-1" data-testid="tabs-views">
          {VIEWS.map(({ key, label, icon: Icon }) => {
            const count = counts[key as keyof ViewCounts] ?? 0;
            return (
              <TabsTrigger
                key={key}
                value={key}
                data-testid={`tab-${key}`}
                className="flex items-center gap-1 text-xs px-2 py-1.5"
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                {count > 0 && (
                  <span className="ml-1 bg-primary/10 text-primary rounded-pill px-1.5 py-0 text-xs font-semibold">
                    {count}
                  </span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-2 mt-3" data-testid="filter-bar">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              data-testid="input-search"
              aria-label="Search tickets"
              placeholder="Search tickets…"
              className="pl-8 h-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[170px] h-9" data-testid="select-status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {availableStatuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace(/\b\w/g, (c) => c.toUpperCase())}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
            <SelectTrigger className="w-[200px] h-9" data-testid="select-sort">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.key} value={o.key}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {departments.length > 0 && (
            <Select value={deptFilter} onValueChange={setDeptFilter}>
              <SelectTrigger className="w-[180px] h-9" data-testid="select-department">
                <SelectValue placeholder="All departments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.filter(d => d.active).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Tab content panels */}
        {VIEWS.map(({ key }) => (
          <TabsContent key={key} value={key} className="mt-3">
            <TicketTable
              tickets={filteredTickets}
              isLoading={ticketsQuery.isLoading}
              viewKey={key}
              isAdmin={isAdmin}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

// ─── Ticket Table ─────────────────────────────────────────────────────────────

function TicketTable({
  tickets,
  isLoading,
  viewKey,
  isAdmin,
}: {
  tickets: SdTicketResolved[];
  isLoading: boolean;
  viewKey: string;
  isAdmin: boolean;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Loading tickets…
        </CardContent>
      </Card>
    );
  }

  if (!tickets.length) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            testId="empty-tickets"
            icon={<ClipboardList />}
            title="No tickets in this view"
            description="Tickets matching this view will appear here as they come in."
            hint="Try a different view tab or adjust the search and filters above."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50 dark:bg-slate-800/30">
              <TableHead className="w-[40%]">Request</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Department</TableHead>
              <TableHead className="hidden md:table-cell">Assignee</TableHead>
              <TableHead className="hidden lg:table-cell">Type</TableHead>
              <TableHead className="hidden lg:table-cell">Committed</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tickets.map((ticket) => {
              const { label: dateLabel, overdue } = formatCommittedDate(ticket.committedDate);
              return (
                <TableRow
                  key={ticket.clickupTaskId}
                  className="hover:bg-slate-50 dark:hover:bg-slate-800/30 cursor-pointer"
                  data-testid={`row-ticket-${ticket.clickupTaskId}`}
                  onClick={() => {
                    if (!isAdmin && ticket.url) {
                      window.open(ticket.url, "_blank", "noopener,noreferrer");
                    }
                  }}
                >
                  <TableCell>
                    <div className="space-y-0.5">
                      {isAdmin ? (
                        <Link
                          href={`/admin/service-desk/tickets/${ticket.clickupTaskId}`}
                          className="font-medium text-sm text-slate-900 hover:text-primary-ink line-clamp-2"
                          data-testid={`link-ticket-${ticket.clickupTaskId}`}
                        >
                          {ticket.name}
                        </Link>
                      ) : (
                        <span
                          className="font-medium text-sm text-slate-900 hover:text-primary-ink line-clamp-2"
                          data-testid={`link-ticket-${ticket.clickupTaskId}`}
                        >
                          {ticket.name}
                        </span>
                      )}
                      {ticket.clientName && (
                        <p className="text-xs text-slate-500" data-testid={`text-client-${ticket.clickupTaskId}`}>{ticket.clientName}</p>
                      )}
                      {(ticket.requestedDate ?? ticket.dateCreated) && (
                        <p className="text-xs text-slate-400" data-testid={`text-submitted-${ticket.clickupTaskId}`}>
                          Submitted {new Date(Number(ticket.requestedDate ?? ticket.dateCreated)).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={ticket.status} />
                    {ticket.waitingWho && (
                      <p className="text-xs text-slate-400 mt-0.5 truncate max-w-[120px]">
                        ↳ {ticket.waitingWho}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-slate-600">
                    {ticket.departmentId ? (
                      <DeptLabel deptId={ticket.departmentId} />
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-slate-600" data-testid={`text-assignee-${ticket.clickupTaskId}`}>
                    {ticket.assignees.length > 0 ? (
                      <span className="truncate max-w-[140px] inline-block align-bottom">
                        {ticket.assignees.map((a) => a.username).filter(Boolean).join(", ")}
                      </span>
                    ) : (
                      <span className="text-slate-400">Unassigned</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-sm text-slate-600">
                    {ticket.requestType ?? <span className="text-slate-400">—</span>}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-sm">
                    {ticket.committedDate ? (
                      <span className={overdue ? "text-red-600 font-medium" : "text-slate-600"}>
                        {overdue && <AlertCircle className="h-3 w-3 inline mr-1" />}
                        {dateLabel}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {ticket.url && (
                      <a
                        href={ticket.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-slate-400 hover:text-slate-600"
                        data-testid={`link-clickup-${ticket.clickupTaskId}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ─── Dept label (resolved from context) ─────────────────────────────────────

function DeptLabel({ deptId }: { deptId: string }) {
  const { data } = useQuery<{ departments: SdDepartment[] }>({
    queryKey: ["/api/service-desk/departments"],
    staleTime: 60_000,
  });
  const dept = data?.departments?.find((d) => d.id === deptId);
  return <span>{dept?.name ?? deptId}</span>;
}
