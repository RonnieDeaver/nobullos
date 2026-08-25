import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { OsTable, type OsTableColumn } from "@/components/ui/os-table";
import {
  Bot,
  Calendar,
  CalendarCheck,
  ChevronDown,
  ChevronRight,
  Gauge,
  History,
  Lightbulb,
  MessageSquare,
  Phone,
  Trophy,
} from "lucide-react";
import { PageHeader } from "@/components/admin/PageHeader";

/**
 * Task #3721 — Internal Usage (leadership only).
 *
 * Shows, for a selectable window (7/30/90/365 days or all time — the
 * "All time" preset covers each tool's entire recorded history, including
 * pre-launch rows; Task #4872), how often each team member used the five
 * core client tools — scheduler bookings, SMS, calls, intel notes, and
 * agent chat — plus a per-member client × tool grid over their assigned
 * clients with zero-usage cells flagged as gaps.
 */

type ToolCounts = {
  bookings: number;
  bookingsDirect: number;
  bookingsPublicLink: number;
  sms: number;
  calls: number;
  intel: number;
  agentChat: number;
};

type ClientRow = {
  clientId: string;
  firmName: string;
  counts: ToolCounts;
  total: number;
  agentChatUnattributed: number;
  othersActivity: number;
  noActivity: boolean;
};

type Member = {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
  counts: ToolCounts;
  total: number;
  assignedClientCount: number;
  clientsWithNoActivity: number;
  clients: ClientRow[];
};

/** Selected reporting window: trailing day count, or "all" for full history. */
type DaysChoice = number | "all";

type UsageReport = {
  days: DaysChoice;
  since: string;
  until: string;
  /**
   * Earliest counted row in the window (true coverage start) — null when
   * the window has no data. Optional so the page tolerates a server that
   * predates the field (Task #4872).
   */
  coverageStart?: string | null;
  totals: {
    bookings: number;
    bookingsDirect: number;
    bookingsPublicLink: number;
    bookingsAttributed: number;
    bookingsUnattributed: number;
    sms: number;
    smsAttributed: number;
    smsUnattributed: number;
    calls: number;
    callsAttributed: number;
    callsUnattributed: number;
    intel: number;
    agentChat: number;
    agentChatAttributed: number;
    agentChatUnattributed: number;
  };
  members: Member[];
  unattributedAgentChat: Array<{ clientId: string | null; firmName: string | null; count: number }>;
};

const DAYS_OPTIONS: Array<{ value: DaysChoice; label: string }> = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  // Task #4872 — pre-launch history: the API caps numeric windows at 365,
  // and "all" lifts the lower bound entirely (query-time aggregation over
  // never-pruned tables reaches back to each tool's first row).
  { value: 365, label: "365 days" },
  { value: "all", label: "All time" },
];

const TOOL_COLUMNS: Array<{ key: keyof ToolCounts & ("bookings" | "sms" | "calls" | "intel" | "agentChat"); label: string; icon: typeof Phone }> = [
  { key: "bookings", label: "Bookings", icon: CalendarCheck },
  { key: "sms", label: "SMS", icon: MessageSquare },
  { key: "calls", label: "Calls", icon: Phone },
  { key: "intel", label: "Intel", icon: Lightbulb },
  { key: "agentChat", label: "Agent Chat", icon: Bot },
];

/** Per-tool buckets of activity with no recorded team member (intel has none). */
type UnattributedCounts = {
  bookings: number;
  sms: number;
  calls: number;
  agentChat: number;
};

/**
 * Expansion-state key for the pinned reconciliation row. Member rows key by
 * OIDC user id, so this sentinel can never collide with a real member.
 */
const UNATTRIBUTED_ROW_KEY = "__unattributed__";

function memberName(m: Member): string {
  const name = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim();
  return name || m.email || m.userId;
}

function roleLabel(role: string | null): string {
  switch (role) {
    case "ceo": return "CEO";
    case "team_lead": return "Team Lead";
    case "account_manager": return "Account Manager";
    default: return role || "—";
  }
}

/** A count cell: zero renders as a highlighted gap, non-zero as a plain count. */
function CountCell({ value, testId }: { value: number; testId?: string }) {
  if (value === 0) {
    return (
      <span
        data-testid={testId}
        className="inline-flex min-w-[2rem] justify-center rounded bg-red-50 px-1.5 py-0.5 text-xs font-semibold text-red-500 border border-red-100"
      >
        0
      </span>
    );
  }
  return (
    <span data-testid={testId} className="text-sm font-semibold text-foreground tabular-nums">
      {value.toLocaleString()}
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ── Task #4874: weekly win cadence tracker ───────────────────────────────────

type WinTrackingWeek = { start: string; end: string; isCurrent: boolean };
type WinTrackingWeekCell = { count: number; met: boolean | null };
type WinTrackingMember = {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
  isAccountManager: boolean;
  weeks: WinTrackingWeekCell[];
  total: number;
};
type WinTrackingReport = {
  weeks: WinTrackingWeek[];
  members: WinTrackingMember[];
  summary: { accountManagers: number; metThisWeek: number };
  generatedAt: string;
};

function winMemberName(m: WinTrackingMember): string {
  const name = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim();
  return name || m.email || m.userId;
}

/** Week-start label; the API sends UTC week boundaries, so render in UTC. */
function formatWeekStart(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * One week cell. Account-manager cells carry met/missed; the in-progress week
 * never shows "missed" — a zero there is "pending", not a gap yet. Non-AM
 * rows show plain counts (no target applies).
 */
function WinWeekCellView({ cell, isCurrent, testId }: { cell: WinTrackingWeekCell; isCurrent: boolean; testId: string }) {
  if (cell.met === null) {
    return (
      <span data-testid={testId} className={`text-sm tabular-nums ${cell.count === 0 ? "text-muted-foreground/60" : "text-foreground"}`}>
        {cell.count === 0 ? "—" : cell.count}
      </span>
    );
  }
  if (cell.met) {
    return (
      <span
        data-testid={testId}
        className="inline-flex min-w-7 items-center justify-center rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-green-800 dark:bg-green-950/40 dark:text-green-300"
        title="Met — at least one win this week"
      >
        {cell.count}
      </span>
    );
  }
  if (isCurrent) {
    return (
      <span
        data-testid={testId}
        className="inline-flex min-w-7 items-center justify-center rounded-full border border-dashed border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        title="In progress — no win yet this week"
      >
        0
      </span>
    );
  }
  return (
    <span
      data-testid={testId}
      className="inline-flex min-w-7 items-center justify-center rounded-full bg-red-100 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-red-700 dark:bg-red-950/40 dark:text-red-300"
      title="Missed — no win this week"
    >
      0
    </span>
  );
}

export default function InternalUsage() {
  const { user, isLoading: authLoading } = useAuth();
  usePageTitle("Internal Usage");
  const [days, setDays] = useState<DaysChoice>(30);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const isLeadership = user && (user.role === "team_lead" || user.role === "ceo");

  const { data: report, isLoading, error } = useQuery<UsageReport>({
    queryKey: ["/api/internal-usage", days],
    queryFn: () =>
      fetch(`/api/internal-usage?days=${days}`, { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error("Failed to fetch internal usage");
        return r.json();
      }),
    staleTime: 60_000,
    enabled: !!isLeadership,
  });

  // Task #4874: weekly win cadence — fixed 8-week window, independent of the
  // selected usage range above (the cadence target is fixed, so its window
  // is too).
  const {
    data: winReport,
    isLoading: winsLoading,
    error: winsError,
  } = useQuery<WinTrackingReport>({
    queryKey: ["/api/internal-usage/wins-weekly"],
    queryFn: () =>
      fetch(`/api/internal-usage/wins-weekly`, { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error("Failed to fetch win tracking");
        return r.json();
      }),
    staleTime: 60_000,
    enabled: !!isLeadership,
  });

  if (authLoading) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-muted/50 p-6">
        <div className="max-w-7xl mx-auto space-y-4">
          <Skeleton className="h-10 w-64" />
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  if (!isLeadership) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <div className="text-foreground" data-testid="text-access-denied">
          Access denied. Team Lead or CEO access required.
        </div>
      </div>
    );
  }

  const members = report?.members ?? [];
  const membersWithGaps = members.filter((m) => m.clientsWithNoActivity > 0).length;

  // Reconciliation row: activity with no recorded team member (agent chats
  // sent before sender tracking shipped, automated bookings/SMS/calls) gets a
  // pinned pseudo-row in the member table so the columns visibly sum to the
  // top cards. Intel has no bucket — intel notes have always recorded their
  // creator.
  const unattributedCounts: UnattributedCounts = {
    bookings: report?.totals?.bookingsUnattributed ?? 0,
    sms: report?.totals?.smsUnattributed ?? 0,
    calls: report?.totals?.callsUnattributed ?? 0,
    agentChat: report?.totals?.agentChatUnattributed ?? 0,
  };
  const unattributedTotal =
    unattributedCounts.bookings +
    unattributedCounts.sms +
    unattributedCounts.calls +
    unattributedCounts.agentChat;
  const hasUnattributed = unattributedTotal > 0;

  // Task #4348 — flattened row stream for the virtualized member table.
  // Expansion inserts typed sub-rows in place instead of nesting <Table>s
  // inside colSpan cells; with dev-scale member counts (~8k) OsTable
  // virtualizes above 100 rows. NO column is sortable, so member rows
  // always precede the pinned reconciliation row. Plain derivation (no
  // hooks): this code sits below the loading/error early returns, where a
  // conditional hook would break the Rules of Hooks.
  const usageRows: UsageRow[] = (() => {
    const rows: UsageRow[] = [];
    for (const m of members) {
      const isOpen = !!expanded[m.userId];
      rows.push({ kind: "member", member: m, isOpen });
      if (isOpen) {
        if (m.clients.length === 0) {
          rows.push({ kind: "member-empty", member: m });
        } else {
          rows.push({ kind: "member-grid-header", member: m });
          for (const c of m.clients) rows.push({ kind: "member-client", member: m, client: c });
        }
      }
    }
    if (hasUnattributed) {
      rows.push({
        kind: "unattributed",
        counts: unattributedCounts,
        total: unattributedTotal,
        isOpen: !!expanded[UNATTRIBUTED_ROW_KEY],
      });
      if (expanded[UNATTRIBUTED_ROW_KEY] && (report?.unattributedAgentChat?.length ?? 0) > 0) {
        rows.push({ kind: "uc-header" });
        for (const c of report?.unattributedAgentChat ?? []) {
          rows.push({ kind: "uc-client", chatClient: c });
        }
      }
    }
    return rows;
  })();

  const usageColumns: Array<OsTableColumn<UsageRow>> = [
    {
      key: "expand",
      header: "",
      width: 36,
      cell: (row) =>
        row.kind === "member" ? (
          row.isOpen ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )
        ) : row.kind === "unattributed" ? (
          row.isOpen ? (
            <ChevronDown className="h-4 w-4 text-amber-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-amber-500" />
          )
        ) : null,
    },
    {
      key: "member",
      header: "Member",
      width: 300,
      cell: (row) => {
        switch (row.kind) {
          case "member":
            return (
              <div data-testid={`row-member-${row.member.userId}`} className="min-w-0 truncate">
                <span className="font-medium text-foreground">{memberName(row.member)}</span>
                <span className="ml-1.5 text-[11px] text-muted-foreground">· {roleLabel(row.member.role)}</span>
              </div>
            );
          case "member-grid-header":
            return (
              <div
                data-testid={`grid-member-${row.member.userId}`}
                className="truncate text-xs font-medium text-muted-foreground"
              >
                {memberName(row.member)}&apos;s assigned clients ({row.member.clients.length}) — usage
                by {memberName(row.member)} per tool
              </div>
            );
          case "member-empty":
            return <div className="pl-6 text-sm text-muted-foreground">No assigned clients.</div>;
          case "member-client":
            return (
              <div
                data-testid={`row-client-${row.member.userId}-${row.client.clientId}`}
                className="flex min-w-0 items-center gap-2 pl-6"
              >
                <Link
                  href={`/clients/${row.client.clientId}`}
                  className="truncate text-sm text-foreground hover:underline"
                >
                  {row.client.firmName}
                </Link>
                {row.client.noActivity ? (
                  <Badge
                    variant="outline"
                    className="shrink-0 border-red-200 bg-red-50 text-[10px] text-red-600"
                    data-testid={`badge-no-activity-${row.client.clientId}`}
                  >
                    No activity
                  </Badge>
                ) : row.client.total === 0 && row.client.othersActivity > 0 ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    others active ({row.client.othersActivity})
                  </span>
                ) : null}
              </div>
            );
          case "unattributed":
            return (
              <div data-testid="row-unattributed" className="flex min-w-0 items-center gap-2">
                <History className="h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0">
                  <div className="truncate font-medium italic text-amber-900">
                    Historical — no recorded sender
                  </div>
                  <div className="truncate text-[11px] text-amber-700">
                    Not a team member · predates sender tracking or ran automated
                  </div>
                </div>
              </div>
            );
          case "uc-header":
            return (
              <div className="pl-6 text-xs font-medium text-muted-foreground">
                Historical agent chats by client
              </div>
            );
          case "uc-client":
            return (
              <div
                data-testid={`row-unattributed-client-${row.chatClient.clientId ?? "none"}`}
                className="min-w-0 truncate pl-6 text-sm text-foreground"
              >
                {row.chatClient.clientId ? (
                  <Link href={`/clients/${row.chatClient.clientId}`} className="hover:underline">
                    {row.chatClient.firmName ?? row.chatClient.clientId}
                  </Link>
                ) : (
                  <span className="italic text-muted-foreground">No linked client</span>
                )}
              </div>
            );
          default:
            return null;
        }
      },
    },
    {
      key: "clients",
      header: "Clients",
      align: "right",
      width: 90,
      cell: (row) =>
        row.kind === "member" ? (
          <span className="text-sm text-muted-foreground tabular-nums">
            {row.member.assignedClientCount}
            {row.member.clientsWithNoActivity > 0 && (
              <span className="ml-1 text-[11px] text-red-500">
                ({row.member.clientsWithNoActivity} idle)
              </span>
            )}
          </span>
        ) : row.kind === "unattributed" ? (
          <span className="text-sm text-amber-700/50">—</span>
        ) : null,
    },
    ...TOOL_COLUMNS.map(
      (t): OsTableColumn<UsageRow> => ({
        key: t.key,
        header: t.label,
        align: "center",
        width: 110,
        cell: (row) => renderToolCell(row, t.key),
      }),
    ),
    {
      key: "total",
      header: "Total",
      align: "center",
      width: 90,
      cell: (row) =>
        row.kind === "member" ? (
          <span className="text-sm font-bold text-foreground tabular-nums">{row.member.total}</span>
        ) : row.kind === "member-client" ? (
          <span className="text-sm font-semibold tabular-nums">{row.client.total}</span>
        ) : row.kind === "unattributed" ? (
          <span
            className="text-sm font-bold text-amber-900 tabular-nums"
            data-testid="cell-unattributed-total"
          >
            {row.total.toLocaleString()}
          </span>
        ) : null,
    },
  ];

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-muted/50">
      {/* Header */}
      <div className="bg-card border-b border-border px-6 py-4">
        <div className="max-w-7xl mx-auto">
          <PageHeader
            title="Internal Usage"
            subtitle="Team adoption of the five core client tools — zero cells are gaps"
            icon={Gauge}
            backHref="/"
            backLabel="Dashboard"
            actions={
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
            }
          />
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {report && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Calendar className="h-3.5 w-3.5" />
            <span data-testid="text-date-range">
              {formatDate(report.since)} – {formatDate(report.until)}
            </span>
            {/* Task #4872 — true coverage start: earliest counted row in the
                selected window, so leadership can see at a glance how far
                back the displayed data really reaches. Guarded: absent on
                older servers, null when the window is empty. */}
            {report.coverageStart ? (
              <span data-testid="text-coverage-start" className="text-muted-foreground/80">
                · data begins {formatDate(report.coverageStart)}
              </span>
            ) : report.days === "all" ? (
              <span data-testid="text-coverage-start" className="text-muted-foreground/80">
                · no counted activity yet
              </span>
            ) : null}
          </div>
        )}

        {error && (
          <Card className="border-red-200">
            <CardContent className="py-6 text-center text-red-500 text-sm">
              Failed to load usage data. Please try refreshing.
            </CardContent>
          </Card>
        )}

        {isLoading && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <Skeleton className="h-3 w-20 mb-2" />
                  <Skeleton className="h-8 w-12" />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {report && (
          <>
            {/* Per-tool totals */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <Card data-testid="card-total-bookings">
                <CardContent className="p-4">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                    <CalendarCheck className="h-3.5 w-3.5" /> Bookings
                  </div>
                  <div className="text-2xl font-bold text-foreground">
                    {report.totals.bookings.toLocaleString()}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {report.totals.bookingsDirect} direct · {report.totals.bookingsPublicLink} via link
                  </div>
                  {report.totals.bookingsUnattributed > 0 && (
                    <div className="text-[11px] text-muted-foreground" data-testid="text-bookings-unattributed">
                      {report.totals.bookingsUnattributed} automated / no account manager
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card data-testid="card-total-sms">
                <CardContent className="p-4">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                    <MessageSquare className="h-3.5 w-3.5" /> SMS sent
                  </div>
                  <div className="text-2xl font-bold text-foreground">
                    {report.totals.sms.toLocaleString()}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">outbound only</div>
                  {report.totals.smsUnattributed > 0 && (
                    <div className="text-[11px] text-muted-foreground" data-testid="text-sms-unattributed">
                      {report.totals.smsUnattributed} automated / no sender
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card data-testid="card-total-calls">
                <CardContent className="p-4">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                    <Phone className="h-3.5 w-3.5" /> Calls made
                  </div>
                  <div className="text-2xl font-bold text-foreground">
                    {report.totals.calls.toLocaleString()}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">outbound only</div>
                  {report.totals.callsUnattributed > 0 && (
                    <div className="text-[11px] text-muted-foreground" data-testid="text-calls-unattributed">
                      {report.totals.callsUnattributed} automated / no initiator
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card data-testid="card-total-intel">
                <CardContent className="p-4">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                    <Lightbulb className="h-3.5 w-3.5" /> Intel notes
                  </div>
                  <div className="text-2xl font-bold text-foreground">
                    {report.totals.intel.toLocaleString()}
                  </div>
                </CardContent>
              </Card>
              <Card data-testid="card-total-agent-chat">
                <CardContent className="p-4">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                    <Bot className="h-3.5 w-3.5" /> Agent chats
                  </div>
                  <div className="text-2xl font-bold text-foreground">
                    {report.totals.agentChat.toLocaleString()}
                  </div>
                  {report.totals.agentChatUnattributed > 0 && (
                    <div className="text-[11px] text-muted-foreground mt-0.5" data-testid="text-agent-chat-unattributed">
                      {report.totals.agentChatUnattributed} sent before sender tracking existed
                      (Aug 3, 2026) — cannot be counted toward a person
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Member overview + drill-downs */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Usage by team member</CardTitle>
                  {membersWithGaps > 0 && (
                    <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
                      {membersWithGaps} member{membersWithGaps === 1 ? "" : "s"} with idle clients
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {members.length === 0 && !hasUnattributed ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">No team members found.</div>
                ) : (
                  <>
                    <OsTable
                      data-testid="table-members"
                      rows={usageRows}
                      columns={usageColumns}
                      stickyFirstColumn={false}
                      rowKey={usageRowKey}
                      onRowClick={(row) => {
                        if (row.kind === "member") {
                          const id = row.member.userId;
                          setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
                        } else if (row.kind === "unattributed") {
                          setExpanded((prev) => ({
                            ...prev,
                            [UNATTRIBUTED_ROW_KEY]: !prev[UNATTRIBUTED_ROW_KEY],
                          }));
                        }
                      }}
                      rowClassName={(row) => {
                        switch (row.kind) {
                          case "member":
                            return "hover:bg-muted/50";
                          case "member-client":
                            return row.client.noActivity
                              ? "bg-red-50/60 cursor-default"
                              : "bg-muted/70 cursor-default";
                          case "member-grid-header":
                          case "member-empty":
                            return "bg-muted/70 cursor-default";
                          case "unattributed":
                            return "border-t-2 border-dashed border-amber-300 bg-amber-50/60 hover:bg-amber-50";
                          default:
                            return "bg-amber-50/40 cursor-default";
                        }
                      }}
                      emptyState={
                        <div className="py-8 text-center text-sm text-muted-foreground">
                          No team members found.
                        </div>
                      }
                    />
                    {/* Explainer for the expanded reconciliation row lives outside the
                        table so column widths stay stable (no colSpan rows in OsTable);
                        grid-unattributed mounts/unmounts with the expansion state. */}
                    {report && hasUnattributed && expanded[UNATTRIBUTED_ROW_KEY] && (
                      <div
                        data-testid="grid-unattributed"
                        className="mt-3 space-y-2 border border-amber-200 bg-amber-50/40 px-4 py-3"
                      >
                        <p className="max-w-3xl text-xs leading-relaxed text-amber-900">
                          These actions happened in the selected window but carry no recorded team
                          member. Agent chats here were sent before sender tracking shipped (Aug 3,
                          2026) — no record exists of who sent them, so they can never be credited
                          to a person. Automated bookings, SMS and calls (no account manager,
                          sender or initiator) land here too. Everything above counts in the top
                          cards, but never toward a member and never in idle-client detection.
                        </p>
                        {unattributedCounts.bookings + unattributedCounts.sms + unattributedCounts.calls >
                          0 && (
                          <p className="text-[11px] text-muted-foreground">
                            Automated bookings, SMS and calls are counted per tool above; the report
                            carries no per-client breakdown for them.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            <p className="text-[11px] text-muted-foreground leading-relaxed" data-testid="text-member-footnote">
              Member rows count team-initiated actions only: bookings attributed to the account
              manager (direct or via their public booking link), outbound SMS by sender, outbound
              calls by initiator, intel notes by creator, and agent chat messages sent by a team
              member. Activity with no recorded team member — agent chats sent before sender
              tracking existed (Aug 3, 2026) and automated bookings, SMS or calls — appears on
              the &ldquo;Historical — no recorded sender&rdquo; row above so the table adds up to
              the top cards; it can never be counted toward a person and never affects
              idle-client detection.
            </p>
          </>
        )}

        {/* Task #4874: weekly win cadence tracker — fixed 8-week window,
            independent of the selected usage range above. */}
        <Card data-testid="card-win-tracking">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Trophy className="h-4 w-4" />
                Weekly win tracking
              </CardTitle>
              {winReport && winReport.summary.accountManagers > 0 && (
                <Badge
                  variant="outline"
                  className={
                    winReport.summary.metThisWeek >= winReport.summary.accountManagers
                      ? "border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300"
                      : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                  }
                  data-testid="badge-win-summary"
                >
                  {winReport.summary.metThisWeek} of {winReport.summary.accountManagers} account manager
                  {winReport.summary.accountManagers === 1 ? "" : "s"} met this week
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {winsLoading ? (
              <Skeleton className="h-40" data-testid="win-tracking-loading" />
            ) : winsError ? (
              <div className="py-6 text-center text-sm text-muted-foreground" data-testid="win-tracking-error">
                Failed to load win tracking. Refresh to retry.
              </div>
            ) : !winReport || winReport.members.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground" data-testid="win-tracking-empty">
                No team members found.
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-win-tracking">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="py-2 pr-3 font-medium text-muted-foreground">Member</th>
                        {winReport.weeks.map((w) => (
                          <th
                            key={w.start}
                            className={`whitespace-nowrap px-2 py-2 text-center font-medium ${w.isCurrent ? "text-foreground" : "text-muted-foreground"}`}
                          >
                            {w.isCurrent ? "This week" : formatWeekStart(w.start)}
                          </th>
                        ))}
                        <th className="px-2 py-2 text-right font-medium text-muted-foreground">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {winReport.members.map((m) => (
                        <tr key={m.userId} className="border-b last:border-0" data-testid={`row-win-member-${m.userId}`}>
                          <td className="py-2 pr-3">
                            <div className="font-medium text-foreground">{winMemberName(m)}</div>
                            <div className="text-xs text-muted-foreground">{roleLabel(m.role)}</div>
                          </td>
                          {m.weeks.map((cell, i) => (
                            <td key={winReport.weeks[i].start} className="px-2 py-2 text-center">
                              <WinWeekCellView
                                cell={cell}
                                isCurrent={winReport.weeks[i].isCurrent}
                                testId={`cell-win-${m.userId}-${i}`}
                              />
                            </td>
                          ))}
                          <td className="px-2 py-2 text-right font-semibold tabular-nums">{m.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid="text-win-tracking-footnote">
                  Target: at least one win per week per account manager, logged as a Win / Progress
                  entry on any client's Intelligence Feed. Weeks run Monday–Sunday (UTC). Wins on demo
                  or archived clients don't count, and retracted entries are excluded. The current week
                  is still in progress — a dashed cell means no win yet, not a miss. Other team roles
                  are shown for context without a target.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** Count cell for the reconciliation row: zero is neutral (an em dash), never
 * the red gap badge — that treatment means "adoption gap" on member rows. */
function UnattributedCountCell({ value, testId }: { value: number; testId: string }) {
  if (value === 0) {
    return (
      <span data-testid={testId} className="text-sm text-amber-700/50">
        —
      </span>
    );
  }
  return (
    <span data-testid={testId} className="text-sm font-semibold text-amber-900 tabular-nums">
      {value.toLocaleString()}
    </span>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Task #4348: flattened row model for the OsTable refit. The member × client
// matrix used to nest <Table>s inside colSpan expansion rows; OsTable
// virtualizes a single flat row stream instead, so expansion inserts typed
// sub-rows in place. The pinned reconciliation pseudo-row ("Historical — no
// recorded sender") stays last because no column is sortable.
// ─────────────────────────────────────────────────────────────────────────────

type UsageRow =
  | { kind: "member"; member: Member; isOpen: boolean }
  | { kind: "member-grid-header"; member: Member }
  | { kind: "member-empty"; member: Member }
  | { kind: "member-client"; member: Member; client: Member["clients"][number] }
  | { kind: "unattributed"; counts: UnattributedCounts; total: number; isOpen: boolean }
  | { kind: "uc-header" }
  | {
      kind: "uc-client";
      chatClient: { clientId: string | null; firmName: string | null; count: number };
    };

function usageRowKey(row: UsageRow): string {
  switch (row.kind) {
    case "member":
      return `member-${row.member.userId}`;
    case "member-grid-header":
      return `mgrid-${row.member.userId}`;
    case "member-empty":
      return `mempty-${row.member.userId}`;
    case "member-client":
      return `mclient-${row.member.userId}-${row.client.clientId}`;
    case "unattributed":
      return "unattributed";
    case "uc-header":
      return "uc-header";
    case "uc-client":
      return `uc-client-${row.chatClient.clientId ?? "none"}`;
  }
}

/** Tool-count cell dispatch for every row kind in the flattened stream. */
function renderToolCell(row: UsageRow, key: (typeof TOOL_COLUMNS)[number]["key"]) {
  switch (row.kind) {
    case "member": {
      const m = row.member;
      return (
        <>
          <CountCell value={m.counts[key]} testId={`cell-${m.userId}-${key}`} />
          {key === "bookings" && m.counts.bookings > 0 && (
            <div
              className="text-[10px] text-muted-foreground"
              title="Booked directly from the client profile vs via a public booking link"
            >
              {m.counts.bookingsDirect} direct · {m.counts.bookingsPublicLink} link
            </div>
          )}
        </>
      );
    }
    case "member-client": {
      const { member: m, client: c } = row;
      return (
        <>
          <CountCell value={c.counts[key]} testId={`cell-${m.userId}-${c.clientId}-${key}`} />
          {key === "bookings" && c.counts.bookings > 0 && (
            <div
              className="text-[10px] text-muted-foreground"
              title="Booked directly from the client profile vs via a public booking link"
            >
              {c.counts.bookingsDirect} direct · {c.counts.bookingsPublicLink} link
            </div>
          )}
          {key === "agentChat" && c.agentChatUnattributed > 0 && (
            <span
              className="ml-1 text-[10px] text-muted-foreground"
              title="Historical chats on this client without a recorded sender"
            >
              +{c.agentChatUnattributed}
            </span>
          )}
        </>
      );
    }
    case "unattributed": {
      if (key === "intel") {
        return (
          <span
            className="text-sm text-amber-700/50"
            data-testid="cell-unattributed-intel"
            title="Intel notes have always recorded their creator, so none are unattributed"
          >
            —
          </span>
        );
      }
      return <UnattributedCountCell value={row.counts[key]} testId={`cell-unattributed-${key}`} />;
    }
    case "uc-client": {
      if (key === "agentChat") {
        return (
          <span
            className="text-sm font-semibold tabular-nums"
            data-testid={`cell-unattributed-client-${row.chatClient.clientId ?? "none"}`}
          >
            {row.chatClient.count.toLocaleString()}
          </span>
        );
      }
      return null;
    }
    default:
      return null;
  }
}
