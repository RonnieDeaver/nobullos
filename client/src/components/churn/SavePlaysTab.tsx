/**
 * Task #3696 — Save Plays tab (Churn Command Center, director-gated).
 *
 * Two views off GET /api/churn/save-plays (see server/routes/savePlays.ts):
 *  1. At-risk coverage — every active client whose latest judgment is
 *     At Risk/Critical, with its active-play count. Clients with NO active
 *     play are the whole point: they sort first and are highlighted red so
 *     the director immediately sees who nobody is saving.
 *  2. All plays — every save play (demo clients excluded; archived clients
 *     kept + flagged so history survives churn), filterable by owner and
 *     status, with server-derived overdue flagging.
 *
 * Row clicks land on the client's Daily Judgment tab, where the SavePlaysPanel
 * lives. Overdue comes from the server (`overdue`, DB clock) — this component
 * never re-derives it from the browser's date.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle, AlertTriangle, CalendarClock, CheckCircle, LifeBuoy, RefreshCw, ShieldAlert, XCircle,
} from "lucide-react";

type RiskyClient = {
  clientId: string;
  firmName: string;
  clientCode: string | null;
  ownerId: string | null;
  ownerName: string | null;
  status: string;
  riskScore: number | null;
  judgmentDate: string;
  activePlayCount: number;
  hasActivePlay: boolean;
};

type RollupPlay = {
  id: string;
  clientId: string;
  firmName: string;
  clientCode: string | null;
  clientArchived: boolean;
  clientJudgmentStatus: string | null;
  title: string;
  why: string | null;
  sourceJudgmentId: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  dueDate: string;
  status: string;
  notes: string | null;
  outcomeNote: string | null;
  createdByUserId: string | null;
  closedAt: string | null;
  closedByUserId: string | null;
  createdAt: string | null;
  overdue: boolean;
};

type SavePlaysRollupResponse = {
  riskyClients: RiskyClient[];
  plays: RollupPlay[];
  today: string;
  generatedAt: string;
};

const RISK_STATUS_CHIP: Record<string, string> = {
  "Critical": "bg-status-critical/10 text-status-critical",
  "At Risk": "bg-status-warn/10 text-status-warn",
  "Watch": "bg-muted/50 text-muted-foreground",
  "Healthy": "bg-muted/50 text-muted-foreground",
};

const PLAY_STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-muted/50 text-muted-foreground" },
  completed: { label: "Completed", cls: "bg-muted/50 text-muted-foreground" },
  abandoned: { label: "Abandoned", cls: "bg-muted/50 text-muted-foreground" },
};

type StatusFilter = "all" | "active" | "overdue" | "completed" | "abandoned";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "overdue", label: "Overdue" },
  { key: "completed", label: "Completed" },
  { key: "abandoned", label: "Abandoned" },
];

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const t = Date.parse(d.length <= 10 ? `${d}T00:00:00` : d);
  if (Number.isNaN(t)) return d;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function SavePlaysTab() {
  const [, navigate] = useLocation();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");

  const { data, isLoading, isError, error, refetch, isRefetching } =
    useQuery<SavePlaysRollupResponse>({
      queryKey: ["/api/churn/save-plays"],
    });

  const riskyClients = data?.riskyClients ?? [];
  const plays = useMemo(() => data?.plays ?? [], [data]);

  const uncovered = riskyClients.filter((c) => !c.hasActivePlay);
  const activePlays = plays.filter((p) => p.status === "active");
  const overduePlays = activePlays.filter((p) => p.overdue);

  // Owner filter options come from the plays themselves (assignees).
  const owners = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of plays) {
      if (p.assignedToUserId) map.set(p.assignedToUserId, p.assignedToName ?? p.assignedToUserId);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [plays]);

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: 0, active: 0, overdue: 0, completed: 0, abandoned: 0 };
    for (const p of plays) {
      if (ownerFilter !== "all" && p.assignedToUserId !== ownerFilter) continue;
      counts.all++;
      if (p.status === "active") { counts.active++; if (p.overdue) counts.overdue++; }
      else if (p.status === "completed") counts.completed++;
      else if (p.status === "abandoned") counts.abandoned++;
    }
    return counts;
  }, [plays, ownerFilter]);

  const filteredPlays = useMemo(() => {
    return plays.filter((p) => {
      if (ownerFilter !== "all" && p.assignedToUserId !== ownerFilter) return false;
      if (statusFilter === "all") return true;
      if (statusFilter === "overdue") return p.status === "active" && p.overdue;
      return p.status === statusFilter;
    });
  }, [plays, statusFilter, ownerFilter]);

  const openClient = (clientId: string) => navigate(`/clients/${clientId}?tab=daily-judgment`);

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="loading-save-plays">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-12 bg-gray-100 animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError) {
    const message = error instanceof Error ? error.message : "Failed to load save plays";
    const denied = message.startsWith("403");
    return (
      <Card data-testid="error-save-plays">
        <CardContent className="py-10 flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground text-center">
            {denied ? "Access restricted to directors." : `Couldn't load save plays. ${message}`}
          </p>
          {!denied && (
            <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-retry-save-plays">
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${isRefetching ? "animate-spin" : ""}`} />
              Retry
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="flex items-center gap-2 flex-wrap" data-testid="save-plays-summary">
        <span className="px-2.5 py-1 rounded-pill text-caption font-medium bg-gray-100 text-gray-600">
          {riskyClients.length} risky client{riskyClients.length === 1 ? "" : "s"}
        </span>
        <span
          className={`px-2.5 py-1 rounded-pill text-caption font-semibold ${
            uncovered.length > 0 ? "bg-status-critical/10 text-status-critical" : "bg-muted/50 text-muted-foreground"
          }`}
          data-testid="chip-uncovered-count"
        >
          {uncovered.length === 0 ? "All covered" : `${uncovered.length} without a save play`}
        </span>
        <span className="px-2.5 py-1 rounded-pill text-caption font-medium bg-muted/50 text-muted-foreground">
          {activePlays.length} active play{activePlays.length === 1 ? "" : "s"}
        </span>
        {overduePlays.length > 0 && (
          <span className="px-2.5 py-1 rounded-pill text-caption font-semibold bg-status-critical/10 text-status-critical" data-testid="chip-overdue-count">
            {overduePlays.length} overdue
          </span>
        )}
      </div>

      {/* 1. At-risk coverage */}
      <Card data-testid="card-risky-coverage">
        <CardContent className="py-3 px-3">
          <div className="flex items-center gap-2 mb-2">
            <ShieldAlert className="w-3.5 h-3.5 text-primary" />
            <h3 className="text-xs font-semibold text-foreground">
              At-risk client coverage
            </h3>
            <span className="text-caption text-muted-foreground">latest judgment At Risk / Critical</span>
          </div>
          {riskyClients.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground" data-testid="empty-risky-clients">
              No clients are currently At Risk or Critical.
            </p>
          ) : (
            <div className="divide-y divide-gray-50">
              {riskyClients.map((c) => (
                <div
                  key={c.clientId}
                  onClick={() => openClient(c.clientId)}
                  className={`flex items-center justify-between gap-3 py-2 px-1.5 rounded cursor-pointer transition-colors ${
                    c.hasActivePlay ? "hover:bg-gray-50" : "bg-status-critical/5 hover:bg-status-critical/10"
                  }`}
                  data-testid={`row-coverage-${c.clientId}`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <span className="text-xs font-medium text-foreground truncate">{c.firmName}</span>
                    {c.clientCode && <span className="text-caption text-muted-foreground font-mono">{c.clientCode}</span>}
                    <span className={`px-1.5 py-0.5 rounded-pill text-caption font-medium whitespace-nowrap ${RISK_STATUS_CHIP[c.status] ?? "bg-gray-100 text-gray-500"}`}>
                      {c.status}
                    </span>
                    {c.riskScore !== null && (
                      <span className="text-caption text-muted-foreground">risk {Math.round(c.riskScore)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {c.ownerName && <span className="text-caption text-muted-foreground hidden sm:inline">{c.ownerName}</span>}
                    {c.hasActivePlay ? (
                      <Badge className="bg-muted/50 text-muted-foreground hover:bg-muted/50 text-caption px-1.5" data-testid={`badge-covered-${c.clientId}`}>
                        <CheckCircle className="w-2.5 h-2.5 mr-1" />
                        {c.activePlayCount} active play{c.activePlayCount === 1 ? "" : "s"}
                      </Badge>
                    ) : (
                      <Badge className="bg-status-critical/10 text-status-critical hover:bg-status-critical/10 text-caption px-1.5 font-semibold" data-testid={`badge-uncovered-${c.clientId}`}>
                        <AlertCircle className="w-2.5 h-2.5 mr-1" />
                        No active play
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. All plays */}
      <Card data-testid="card-all-plays">
        <CardContent className="py-3 px-3 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <LifeBuoy className="w-3.5 h-3.5 text-primary" />
            <h3 className="text-xs font-semibold text-foreground">All save plays</h3>
            <div className="flex items-center gap-1.5 flex-wrap ml-2">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setStatusFilter(f.key)}
                  className={`px-2.5 py-1 rounded-pill text-caption font-medium transition-colors ${
                    statusFilter === f.key
                      ? "bg-primary text-primary-foreground"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                  data-testid={`filter-play-status-${f.key}`}
                >
                  {f.label} ({statusCounts[f.key]})
                </button>
              ))}
            </div>
            <div className="ml-auto">
              <Select value={ownerFilter} onValueChange={setOwnerFilter}>
                <SelectTrigger className="h-8 w-[170px] text-xs" data-testid="select-play-owner-filter">
                  <SelectValue placeholder="All owners" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All owners</SelectItem>
                  {owners.map(([id, name]) => (
                    <SelectItem key={id} value={id}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {plays.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground" data-testid="empty-save-plays">
              No save plays yet. Open one from a client's Daily Judgment tab.
            </p>
          ) : filteredPlays.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground" data-testid="empty-filtered-plays">
              No plays match the current filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="px-2 py-1.5 text-xs font-semibold text-foreground">Client</th>
                    <th className="px-2 py-1.5 text-xs font-semibold text-foreground">Play</th>
                    <th className="px-2 py-1.5 text-xs font-semibold text-foreground">Owner</th>
                    <th className="px-2 py-1.5 text-xs font-semibold text-foreground">Status</th>
                    <th className="px-2 py-1.5 text-xs font-semibold text-foreground">Due</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filteredPlays.map((p) => {
                    const chip = PLAY_STATUS_CHIP[p.status] ?? { label: p.status, cls: "bg-gray-100 text-gray-500" };
                    return (
                      <tr
                        key={p.id}
                        onClick={() => openClient(p.clientId)}
                        className="cursor-pointer hover:bg-gray-50 transition-colors"
                        data-testid={`row-play-${p.id}`}
                      >
                        <td className="px-2 py-2 max-w-[220px]">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-xs font-medium text-foreground truncate">{p.firmName}</span>
                            {p.clientArchived && (
                              <span className="px-1 py-0.5 rounded text-caption bg-gray-200 text-gray-500" data-testid={`badge-archived-${p.id}`}>archived</span>
                            )}
                            {p.clientJudgmentStatus && (p.clientJudgmentStatus === "Critical" || p.clientJudgmentStatus === "At Risk") && (
                              <span className={`px-1.5 py-0.5 rounded-pill text-caption font-medium ${RISK_STATUS_CHIP[p.clientJudgmentStatus]}`}>
                                {p.clientJudgmentStatus}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-2 max-w-[300px]">
                          <p className="text-xs text-foreground truncate" title={p.why ?? undefined} data-testid={`text-play-title-${p.id}`}>{p.title}</p>
                          {p.status !== "active" && p.outcomeNote && (
                            <p className="text-caption text-muted-foreground italic truncate" title={p.outcomeNote}>{p.outcomeNote}</p>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <span className="text-xs text-gray-600 whitespace-nowrap" data-testid={`text-play-owner-${p.id}`}>
                            {p.assignedToName ?? "—"}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-pill text-caption font-medium whitespace-nowrap ${chip.cls}`} data-testid={`badge-play-status-${p.id}`}>
                            {chip.label}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <span
                            className={`inline-flex items-center gap-1 text-xs whitespace-nowrap ${
                              p.overdue ? "text-status-critical font-semibold" : "text-gray-600"
                            }`}
                            data-testid={`text-play-due-${p.id}`}
                          >
                            <CalendarClock className="w-3 h-3" />
                            {fmtDate(p.dueDate)}
                            {p.overdue && (
                              <Badge className="bg-status-critical/10 text-status-critical hover:bg-status-critical/10 text-caption px-1 ml-1" data-testid={`badge-overdue-${p.id}`}>
                                Overdue
                              </Badge>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {data && (
        <p className="text-caption text-muted-foreground" data-testid="text-save-plays-generated-at">
          {plays.length} play{plays.length === 1 ? "" : "s"} · updated {new Date(data.generatedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
