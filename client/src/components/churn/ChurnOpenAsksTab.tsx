/**
 * Task #3694 — Churn Command Center: "Promises & Asks" tab.
 *
 * Cross-client view of every open / likely-open client ask and unkept
 * internal promise the daily judgment pipeline has extracted, ranked by
 * the age×concern blend (concern already grows with every re-mention).
 * Columns: client, owner, type, summary, age, mentions, concern.
 * Filters: type / owner / client. Default sort = rank blend; any column
 * header re-sorts. Row click opens the client detail page; Resolve /
 * Dismiss act inline (with an optional note) through the SAME per-client
 * PATCH endpoint the client-detail asks panel uses, so lifecycle
 * semantics live in exactly one place.
 *
 * Reads GET /api/churn/open-asks (director-gated, strict). Filtering and
 * sorting happen client-side on the full rollup — same pattern as the
 * Leaderboard tab — so filter dropdowns always show the complete option
 * sets; the API's server-side filter/sort params exist for other
 * consumers (weekly digest, scripts) and are covered by route tests.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowDown, ArrowUp, ArrowUpDown, CheckCircle, CircleSlash, Handshake,
  Loader2, MessageCircleQuestion, RefreshCw, Target,
} from "lucide-react";

// ── API types (mirror server/routes/churn.ts /open-asks response) ──────────

export interface OpenAskRollupItem {
  id: string;
  clientId: string;
  firmName: string;
  clientCode: string | null;
  ownerId: string | null;
  ownerName: string | null;
  askType: string;
  status: string;
  summary: string;
  detail: string | null;
  askCategory: string | null;
  relatedPromiseText: string | null;
  concernScore: number;
  mentionCount: number;
  firstMentionedAt: string | null;
  lastReferencedAt: string | null;
  ageDays: number;
  rankScore: number;
}

interface OpenAsksResponse {
  asks: OpenAskRollupItem[];
  generatedAt: string;
}

// ── Display config ──────────────────────────────────────────────────────────

type TypeFilter = "all" | "client_ask" | "internal_promise";

const TYPE_FILTERS: Array<{ key: TypeFilter; label: string; color: string; activeColor: string }> = [
  { key: "all", label: "All", color: "bg-gray-100 text-gray-600 hover:bg-gray-200", activeColor: "bg-primary text-primary-foreground" },
  { key: "client_ask", label: "Client asks", color: "bg-gray-100 text-gray-600 hover:bg-gray-200", activeColor: "bg-primary text-primary-foreground" },
  { key: "internal_promise", label: "Internal promises", color: "bg-gray-100 text-gray-600 hover:bg-gray-200", activeColor: "bg-primary text-primary-foreground" },
];

function TypeBadge({ askType, status }: { askType: string; status: string }) {
  const isPromise = askType === "internal_promise";
  const Icon = isPromise ? Handshake : MessageCircleQuestion;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-caption font-medium whitespace-nowrap ${
          isPromise ? "bg-surface-warm-2 text-gray-600" : "bg-gray-100 text-gray-600"
        }`}
      >
        <Icon className="w-2.5 h-2.5" />
        {isPromise ? "Internal promise" : "Client ask"}
      </span>
      {status === "likely_open" && (
        <span className="text-caption text-muted-foreground pl-1">likely open</span>
      )}
    </span>
  );
}

function ageToneClass(days: number): string {
  if (days >= 30) return "text-status-critical font-semibold";
  if (days >= 14) return "text-status-warn font-medium";
  return "text-gray-600";
}

function concernToneClass(v: number): string {
  if (v >= 5) return "text-status-critical font-semibold";
  if (v >= 3) return "text-status-warn font-medium";
  return "text-gray-600";
}

function mentionToneClass(v: number): string {
  if (v >= 5) return "text-status-critical font-semibold";
  if (v >= 3) return "text-status-warn font-medium";
  return "text-gray-600";
}

function fmtConcern(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function fmtAge(days: number): string {
  return `${Math.floor(days)}d`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function OwnerTag({ name }: { name: string | null }) {
  if (!name) return <span className="text-gray-300 text-xs">—</span>;
  const isEmail = name.includes("@");
  const label = isEmail ? name.split("@")[0].toUpperCase() : (name.split(" ")[0] || name).toUpperCase();
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-caption font-bold tracking-wide bg-gray-100 text-gray-500 whitespace-nowrap">
      {label}
    </span>
  );
}

type SortField = "rank" | "firmName" | "ownerName" | "askType" | "ageDays" | "mentionCount" | "concernScore";
type SortDirection = "asc" | "desc";

const TEXT_FIELDS: SortField[] = ["firmName", "ownerName", "askType"];

// ── Main component ──────────────────────────────────────────────────────────

export function ChurnOpenAsksTab() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [sortField, setSortField] = useState<SortField>("rank");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [pendingAction, setPendingAction] = useState<{
    ask: OpenAskRollupItem;
    action: "resolved" | "dismissed";
  } | null>(null);
  const [note, setNote] = useState("");

  const { data, isLoading, isError, refetch, isRefetching } = useQuery<OpenAsksResponse>({
    queryKey: ["/api/churn/open-asks"],
  });

  const allAsks = useMemo(() => data?.asks ?? [], [data]);

  const owners = useMemo(() => {
    const m = new Map<string, string>();
    allAsks.forEach((a) => {
      if (a.ownerId && a.ownerName) m.set(a.ownerId, a.ownerName);
    });
    return Array.from(m.entries()).sort((x, y) => x[1].localeCompare(y[1]));
  }, [allAsks]);

  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    allAsks.forEach((a) => m.set(a.clientId, a.firmName));
    return Array.from(m.entries()).sort((x, y) => x[1].localeCompare(y[1]));
  }, [allAsks]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allAsks.length, client_ask: 0, internal_promise: 0 };
    allAsks.forEach((a) => {
      counts[a.askType] = (counts[a.askType] ?? 0) + 1;
    });
    return counts;
  }, [allAsks]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(TEXT_FIELDS.includes(field) ? "asc" : "desc");
    }
  };

  const numericValue = (a: OpenAskRollupItem, field: SortField): number => {
    switch (field) {
      case "rank": return a.rankScore;
      case "ageDays": return a.ageDays;
      case "mentionCount": return a.mentionCount;
      case "concernScore": return a.concernScore;
      default: return 0;
    }
  };

  const rows = useMemo(() => {
    let filtered = allAsks;
    if (typeFilter !== "all") filtered = filtered.filter((a) => a.askType === typeFilter);
    if (ownerFilter !== "all") filtered = filtered.filter((a) => a.ownerId === ownerFilter);
    if (clientFilter !== "all") filtered = filtered.filter((a) => a.clientId === clientFilter);
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (TEXT_FIELDS.includes(sortField)) {
        const av = sortField === "firmName" ? a.firmName : sortField === "askType" ? a.askType : (a.ownerName ?? "");
        const bv = sortField === "firmName" ? b.firmName : sortField === "askType" ? b.askType : (b.ownerName ?? "");
        const cmp = av.localeCompare(bv);
        // Same text value → keep the rank blend inside the group.
        return cmp !== 0 ? dir * cmp : b.rankScore - a.rankScore;
      }
      const cmp = numericValue(a, sortField) - numericValue(b, sortField);
      return cmp !== 0 ? dir * cmp : b.rankScore - a.rankScore;
    });
  }, [allAsks, typeFilter, ownerFilter, clientFilter, sortField, sortDir]);

  const updateAskMutation = useMutation({
    mutationFn: async ({ ask, action, resolutionNote }: {
      ask: OpenAskRollupItem;
      action: "resolved" | "dismissed";
      resolutionNote: string;
    }) => {
      // Same per-client endpoint the client-detail asks panel uses —
      // resolve/dismiss semantics deliberately live there, not in a new
      // churn-specific writer.
      const res = await fetch(`/api/clients/${ask.clientId}/open-asks/${ask.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(
          resolutionNote.trim().length > 0
            ? { status: action, resolutionNote: resolutionNote.trim() }
            : { status: action },
        ),
      });
      if (!res.ok) throw new Error(`Failed to update ask (${res.status})`);
      return res.json();
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/churn/open-asks"] }); // fire-and-forget: cache refresh only
      // Keep the per-client panel in sync if it's mounted elsewhere.
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", vars.ask.clientId, "open-asks"] }); // fire-and-forget: cache refresh only
      toast({ title: vars.action === "resolved" ? "Ask marked resolved" : "Ask dismissed" });
      setPendingAction(null);
      setNote("");
    },
    onError: () => {
      toast({ title: "Failed to update ask", variant: "destructive" });
    },
  });

  const ariaSort = (field: SortField): "ascending" | "descending" | "none" =>
    sortField === field ? (sortDir === "asc" ? "ascending" : "descending") : "none";

  const SortHeader = ({ field, children, title }: { field: SortField; children: React.ReactNode; title?: string }) => (
    <button
      onClick={() => toggleSort(field)}
      className="inline-flex items-center gap-1 hover:text-primary-ink transition-colors whitespace-nowrap"
      title={title}
      data-testid={`sort-asks-${field}`}
    >
      {children}
      {sortField === field ? (
        sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
      ) : (
        <ArrowUpDown className="w-3 h-3 opacity-30" />
      )}
    </button>
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 p-8 justify-center" data-testid="open-asks-tab-loading">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading promises &amp; asks…
      </div>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="p-8 text-center" data-testid="open-asks-tab-error">
          <p className="text-sm text-gray-600 mb-3">Couldn&apos;t load the promises &amp; asks rollup.</p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5" data-testid="filter-ask-type">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setTypeFilter(f.key)}
              className={`px-2.5 py-1 rounded-pill text-caption font-medium transition-colors ${
                typeFilter === f.key ? f.activeColor : f.color
              }`}
              data-testid={`filter-type-${f.key}`}
            >
              {f.label} ({typeCounts[f.key] ?? 0})
            </button>
          ))}
        </div>
        <Select value={ownerFilter} onValueChange={setOwnerFilter}>
          <SelectTrigger className="h-7 w-[150px] text-xs" data-testid="select-asks-owner-filter">
            <SelectValue placeholder="All owners" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All owners</SelectItem>
            {owners.map(([id, name]) => (
              <SelectItem key={id} value={id}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={clientFilter} onValueChange={setClientFilter}>
          <SelectTrigger className="h-7 w-[180px] text-xs" data-testid="select-asks-client-filter">
            <SelectValue placeholder="All clients" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All clients</SelectItem>
            {clientOptions.map(([id, name]) => (
              <SelectItem key={id} value={id}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-caption text-muted-foreground" data-testid="text-asks-count">
            {rows.length} of {allAsks.length} item{allAsks.length === 1 ? "" : "s"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => refetch()}
            disabled={isRefetching}
            data-testid="button-refresh-asks"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center" data-testid="open-asks-tab-empty">
            <Target className="w-8 h-8 mx-auto mb-2 text-primary/30" />
            <p className="text-sm text-gray-600">
              {allAsks.length === 0
                ? "No open asks or unkept promises across active clients right now."
                : "Nothing matches the current filters."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50/70 text-caption uppercase tracking-wide text-gray-500">
                  <th className="text-left px-3 py-2 font-medium" aria-sort={ariaSort("firmName")}>
                    <SortHeader field="firmName">Client</SortHeader>
                  </th>
                  <th className="text-left px-2 py-2 font-medium" aria-sort={ariaSort("ownerName")}>
                    <SortHeader field="ownerName">Owner</SortHeader>
                  </th>
                  <th className="text-left px-2 py-2 font-medium" aria-sort={ariaSort("askType")}>
                    <SortHeader field="askType">Type</SortHeader>
                  </th>
                  <th className="text-left px-2 py-2 font-medium w-[38%]">Summary</th>
                  <th className="text-right px-2 py-2 font-medium" aria-sort={ariaSort("ageDays")}>
                    <SortHeader field="ageDays" title="Days since first mention">Age</SortHeader>
                  </th>
                  <th className="text-right px-2 py-2 font-medium" aria-sort={ariaSort("mentionCount")}>
                    <SortHeader field="mentionCount" title="Times the client has raised it">Mentions</SortHeader>
                  </th>
                  <th className="text-right px-2 py-2 font-medium" aria-sort={ariaSort("concernScore")}>
                    <SortHeader field="concernScore" title="Concern score (grows on every re-mention)">Concern</SortHeader>
                  </th>
                  <th className="text-right px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((ask) => (
                  <tr
                    key={ask.id}
                    className="border-b last:border-0 hover:bg-surface-warm-1/50 cursor-pointer transition-colors"
                    onClick={() => navigate(`/clients/${ask.clientId}`)}
                    data-testid={`row-ask-${ask.id}`}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground whitespace-nowrap" data-testid={`text-ask-client-${ask.id}`}>
                        {ask.firmName}
                      </div>
                      {ask.clientCode && (
                        <div className="text-caption text-muted-foreground">{ask.clientCode}</div>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <OwnerTag name={ask.ownerName} />
                    </td>
                    <td className="px-2 py-2">
                      <TypeBadge askType={ask.askType} status={ask.status} />
                    </td>
                    <td className="px-2 py-2">
                      <p
                        className="text-xs text-gray-700 line-clamp-2"
                        title={ask.detail ?? ask.summary}
                        data-testid={`text-ask-summary-${ask.id}`}
                      >
                        {ask.summary}
                      </p>
                      {ask.askType === "internal_promise" && ask.relatedPromiseText && (
                        <p className="text-caption text-muted-foreground line-clamp-1 mt-0.5" title={ask.relatedPromiseText}>
                          Promised: {ask.relatedPromiseText}
                        </p>
                      )}
                    </td>
                    <td
                      className={`px-2 py-2 text-right text-xs whitespace-nowrap ${ageToneClass(ask.ageDays)}`}
                      title={`First mentioned ${fmtDate(ask.firstMentionedAt)}`}
                      data-testid={`text-ask-age-${ask.id}`}
                    >
                      {fmtAge(ask.ageDays)}
                    </td>
                    <td className={`px-2 py-2 text-right text-xs ${mentionToneClass(ask.mentionCount)}`} data-testid={`text-ask-mentions-${ask.id}`}>
                      {ask.mentionCount}×
                    </td>
                    <td className={`px-2 py-2 text-right text-xs ${concernToneClass(ask.concernScore)}`} data-testid={`text-ask-concern-${ask.id}`}>
                      {fmtConcern(ask.concernScore)}
                    </td>
                    <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-caption text-gray-600 hover:bg-gray-50"
                          onClick={() => { setNote(""); setPendingAction({ ask, action: "resolved" }); }}
                          data-testid={`button-resolve-${ask.id}`}
                        >
                          <CheckCircle className="w-3 h-3 mr-1" />
                          Resolve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-caption text-gray-500 hover:bg-gray-50"
                          onClick={() => { setNote(""); setPendingAction({ ask, action: "dismissed" }); }}
                          data-testid={`button-dismiss-${ask.id}`}
                        >
                          <CircleSlash className="w-3 h-3 mr-1" />
                          Dismiss
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {data?.generatedAt && (
        <p className="text-caption text-muted-foreground text-right" data-testid="text-asks-generated-at">
          Generated {fmtDate(data.generatedAt)}
        </p>
      )}

      {/* Resolve / dismiss dialog */}
      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingAction(null);
            setNote("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md" data-testid="dialog-ask-action">
          <DialogHeader>
            <DialogTitle>
              {pendingAction?.action === "resolved" ? "Resolve" : "Dismiss"}{" "}
              {pendingAction?.ask.askType === "internal_promise" ? "promise" : "ask"}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {pendingAction?.ask.firmName} — {pendingAction?.ask.summary}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              pendingAction?.action === "resolved"
                ? "How was it resolved? (optional note)"
                : "Why is this being dismissed? (optional note)"
            }
            rows={3}
            data-testid="input-resolution-note"
          />
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setPendingAction(null); setNote(""); }}
              data-testid="button-cancel-ask-action"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className={pendingAction?.action === "resolved" ? "" : "bg-gray-600 hover:bg-gray-700"}
              disabled={updateAskMutation.isPending}
              onClick={() => {
                if (!pendingAction) return;
                updateAskMutation.mutate({
                  ask: pendingAction.ask,
                  action: pendingAction.action,
                  resolutionNote: note,
                });
              }}
              data-testid="button-confirm-ask-action"
            >
              {updateAskMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
              {pendingAction?.action === "resolved" ? "Mark resolved" : "Dismiss"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
