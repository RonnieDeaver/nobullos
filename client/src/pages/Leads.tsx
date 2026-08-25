/**
 * Task #4330 — Leads view.
 *
 * Prospect records on the clients model (lifecycle lead / session_booked /
 * opportunity), fed automatically by website inquiries and booked sessions.
 * Shows source + last activity, filters by lifecycle stage and source, and
 * offers quick promote-to-deal (POST /api/deals defaults to the default
 * pipeline's first open stage; the deal-created hook then advances the
 * lifecycle to Opportunity). Manual lifecycle correction (AM+) is the only
 * backwards-capable move and is always audited server-side.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import {
  clientLifecycleStageLabels,
  clientLifecycleStages,
  leadSources,
  type Client,
  type ClientLifecycleHistoryEntry,
  type ClientLifecycleStage,
  type Deal,
  type LeadSource,
  type ScheduledMeeting,
  type WebsiteInquiry,
} from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Magnet, Briefcase, CalendarClock, Mail, Phone, ArrowUpRight, History, Merge } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";

type LeadRow = Client & { openDealId: string | null; openDealName: string | null };

interface LeadsListResponse {
  data: LeadRow[];
  total: number;
}

interface LeadDetailResponse {
  client: Client;
  history: ClientLifecycleHistoryEntry[];
  inquiries: WebsiteInquiry[];
  meetings: ScheduledMeeting[];
  deals: (Deal & { stageName: string | null })[];
}

// Task #4584 — slim row from GET /api/leads/merge-candidates (server-backed
// merge-target search over all clients, customers included).
interface MergeCandidate {
  id: string;
  firmName: string;
  contactName: string | null;
  contactEmail: string | null;
  lifecycleStage: string;
}

const STAGE_BADGE: Record<ClientLifecycleStage, string> = {
  lead: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30",
  session_booked: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  opportunity: "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/30",
  customer: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
};

const SOURCE_LABELS: Record<LeadSource, string> = {
  website_inquiry: "Website inquiry",
  booking: "Booked session",
  manual: "Manual",
};

const HISTORY_SOURCE_LABELS: Record<string, string> = {
  website_inquiry: "Website inquiry",
  booking: "Booked session",
  deal_created: "Deal created",
  deal_won: "Deal won",
  manual: "Manual correction",
};

function stageLabel(stage: string): string {
  return clientLifecycleStageLabels[stage as ClientLifecycleStage] ?? stage;
}

function lastActivity(row: LeadRow): string {
  const ts = row.leadLastActivityAt ?? row.updatedAt ?? row.createdAt;
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true });
}

export default function Leads() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [stageFilter, setStageFilter] = useState<string>("prospects");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [detailId, setDetailId] = useState<string | null>(null);

  const canManage = ["account_manager", "team_lead", "director", "ceo"].includes(
    user?.role ?? "",
  );

  const listUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (stageFilter !== "prospects") params.set("stage", stageFilter);
    if (sourceFilter !== "all") params.set("source", sourceFilter);
    const qs = params.toString();
    return qs ? `/api/leads?${qs}` : "/api/leads";
  }, [stageFilter, sourceFilter]);

  const leadsQuery = useQuery<LeadsListResponse>({ queryKey: [listUrl] });

  const detailQuery = useQuery<LeadDetailResponse>({
    queryKey: [`/api/leads/${detailId}`],
    enabled: !!detailId,
  });

  const invalidateLeads = () => {
    void queryClient.invalidateQueries({
      predicate: (q) =>
        typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/leads"),
    });
  };

  const promoteMutation = useMutation({
    mutationFn: async (lead: LeadRow) => {
      const res = await apiRequest("POST", "/api/deals", {
        name: lead.firmName,
        clientId: lead.id,
      });
      return res.json() as Promise<Deal>;
    },
    onSuccess: () => {
      toast({ title: "Deal created", description: "Lead promoted to the deals pipeline." });
      invalidateLeads();
      void queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
    },
    onError: (err: any) => {
      toast({
        title: "Could not create deal",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Task #4424 — merge a duplicate lead (detailId, the loser) into another
  // record. On success the loser is gone: close the dialog and refresh.
  const mergeMutation = useMutation({
    mutationFn: async (input: { id: string; targetClientId: string }) => {
      const res = await apiRequest("POST", `/api/leads/${input.id}/merge`, {
        targetClientId: input.targetClientId,
        reason: "Merged from Leads view",
      });
      return res.json() as Promise<{ merged: boolean; moved: Record<string, number> }>;
    },
    onSuccess: (data) => {
      const m = data.moved ?? {};
      toast({
        title: "Leads merged",
        description: `Moved ${m.inquiries ?? 0} inquiries, ${m.meetings ?? 0} sessions, ${m.deals ?? 0} deals, and the lifecycle history.`,
      });
      setDetailId(null);
      invalidateLeads();
      void queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
    },
    onError: (err: any) => {
      toast({
        title: "Could not merge leads",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const lifecycleMutation = useMutation({
    mutationFn: async (input: { id: string; stage: ClientLifecycleStage }) => {
      const res = await apiRequest("POST", `/api/leads/${input.id}/lifecycle`, {
        stage: input.stage,
        reason: "Corrected from Leads view",
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Lifecycle updated" });
      invalidateLeads();
      if (detailId) {
        void queryClient.invalidateQueries({ queryKey: [`/api/leads/${detailId}`] });
      }
    },
    onError: (err: any) => {
      toast({
        title: "Could not update lifecycle",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const rows = leadsQuery.data?.data ?? [];

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4" data-testid="page-leads">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-leads-title">
            <Magnet className="h-6 w-6 text-muted-foreground" />
            Leads
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Prospects from website inquiries and booked sessions — before they’re paying clients.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={stageFilter} onValueChange={setStageFilter}>
            <SelectTrigger className="w-[180px]" data-testid="select-lifecycle-filter">
              <SelectValue placeholder="Stage" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="prospects">All prospects</SelectItem>
              {clientLifecycleStages.map((s) => (
                <SelectItem key={s} value={s}>
                  {stageLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-[170px]" data-testid="select-source-filter">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {leadSources.map((s) => (
                <SelectItem key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {leadsQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Magnet />}
          title="No leads match these filters"
          description="New website inquiries and booked sessions create leads here automatically."
          hint="Try widening the stage or source filter above to see more prospects."
          testId="text-leads-empty"
        />
      ) : (
        <div className="border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Last activity</TableHead>
                <TableHead className="text-right">Deal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((lead) => (
                <TableRow key={lead.id} data-testid={`row-lead-${lead.id}`}>
                  <TableCell>
                    <button
                      type="button"
                      className="text-left font-medium hover:underline"
                      onClick={() => setDetailId(lead.id)}
                      data-testid={`button-lead-detail-${lead.id}`}
                    >
                      {lead.firmName}
                    </button>
                    {lead.contactName && lead.contactName !== lead.firmName && (
                      <div className="text-xs text-muted-foreground">{lead.contactName}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm space-y-0.5">
                      {lead.contactEmail && (
                        <div className="flex items-center gap-1.5">
                          <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="truncate max-w-[220px]">{lead.contactEmail}</span>
                        </div>
                      )}
                      {lead.contactPhone && (
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <Phone className="h-3.5 w-3.5" />
                          {lead.contactPhone}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={STAGE_BADGE[lead.lifecycleStage as ClientLifecycleStage] ?? ""}
                      data-testid={`badge-stage-${lead.id}`}
                    >
                      {stageLabel(lead.lifecycleStage)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {lead.leadSource ? SOURCE_LABELS[lead.leadSource as LeadSource] ?? lead.leadSource : "—"}
                    {/* Task #4337 — immutable first-touch marketing source. */}
                    {lead.firstTouchSource && (
                      <div
                        className="text-xs text-muted-foreground/80"
                        data-testid={`text-first-touch-${lead.id}`}
                      >
                        First touch: {lead.firstTouchSource}
                        {lead.firstTouchCampaign ? ` · ${lead.firstTouchCampaign}` : ""}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {lastActivity(lead)}
                  </TableCell>
                  <TableCell className="text-right">
                    {lead.openDealId ? (
                      <Button asChild variant="ghost" size="sm" data-testid={`link-lead-deal-${lead.id}`}>
                        <Link href={`/deals/${lead.openDealId}`}>
                          <Briefcase className="h-4 w-4 mr-1" />
                          View deal
                        </Link>
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={promoteMutation.isPending}
                        onClick={() => promoteMutation.mutate(lead)}
                        data-testid={`button-promote-${lead.id}`}
                      >
                        <ArrowUpRight className="h-4 w-4 mr-1" />
                        Promote to deal
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={!!detailId} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="dialog-lead-detail">
          {detailQuery.isLoading || !detailQuery.data ? (
            <div className="space-y-3 py-4">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : (
            <LeadDetail
              detail={detailQuery.data}
              canManage={canManage}
              onSetStage={(stage) =>
                lifecycleMutation.mutate({ id: detailQuery.data.client.id, stage })
              }
              stagePending={lifecycleMutation.isPending}
              onMerge={(targetClientId) =>
                mergeMutation.mutate({ id: detailQuery.data.client.id, targetClientId })
              }
              mergePending={mergeMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LeadDetail({
  detail,
  canManage,
  onSetStage,
  stagePending,
  onMerge,
  mergePending,
}: {
  detail: LeadDetailResponse;
  canManage: boolean;
  onSetStage: (stage: ClientLifecycleStage) => void;
  stagePending: boolean;
  onMerge: (targetClientId: string) => void;
  mergePending: boolean;
}) {
  const { client, history, inquiries, meetings, deals } = detail;
  // Task #4424 — two-step "merge into…": pick a target, then confirm with
  // an explicit list of what moves before the destructive call.
  // Task #4584 — the target picker is a server-backed search over ALL
  // clients (customers included — the "former client wrote in with a new
  // address" case), not just the leads on the current page.
  const [mergeSearch, setMergeSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [mergeTarget, setMergeTarget] = useState<MergeCandidate | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(mergeSearch.trim()), 250);
    return () => clearTimeout(t);
  }, [mergeSearch]);
  const candidatesQuery = useQuery<{ data: MergeCandidate[] }>({
    queryKey: [
      `/api/leads/merge-candidates?q=${encodeURIComponent(debouncedSearch)}&exclude=${client.id}`,
    ],
    enabled: canManage && !mergeTarget && debouncedSearch.length >= 2,
  });
  const candidates = candidatesQuery.data?.data ?? [];
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {client.firmName}
          <Badge
            variant="outline"
            className={STAGE_BADGE[client.lifecycleStage as ClientLifecycleStage] ?? ""}
          >
            {stageLabel(client.lifecycleStage)}
          </Badge>
        </DialogTitle>
        <DialogDescription>
          {client.contactEmail}
          {client.contactPhone ? ` · ${client.contactPhone}` : ""}
          {client.leadSource
            ? ` · Source: ${SOURCE_LABELS[client.leadSource as LeadSource] ?? client.leadSource}`
            : ""}
          {client.firstTouchSource
            ? ` · First touch: ${client.firstTouchSource}${client.firstTouchCampaign ? ` (${client.firstTouchCampaign})` : ""}`
            : ""}
        </DialogDescription>
      </DialogHeader>

      {canManage && (
        <div className="flex items-center gap-2 border p-3 bg-muted/40">
          <span className="text-sm text-muted-foreground">Correct stage:</span>
          <Select
            value={client.lifecycleStage}
            onValueChange={(v) => onSetStage(v as ClientLifecycleStage)}
            disabled={stagePending}
          >
            <SelectTrigger className="w-[180px]" data-testid="select-correct-stage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {clientLifecycleStages.map((s) => (
                <SelectItem key={s} value={s}>
                  {stageLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            Manual corrections are audited; automatic movement never goes backwards.
          </span>
        </div>
      )}

      {canManage && client.lifecycleStage !== "customer" && (
        <div className="border p-3 bg-muted/40 space-y-2" data-testid="section-merge-lead">
          <div className="flex items-center gap-2">
            <Merge className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Merge into…</span>
            {mergeTarget ? (
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium" data-testid="text-merge-target-selected">
                  {mergeTarget.firmName}
                  {mergeTarget.contactEmail ? ` · ${mergeTarget.contactEmail}` : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={mergePending}
                  onClick={() => setMergeTarget(null)}
                  data-testid="button-change-merge-target"
                >
                  Change
                </Button>
              </div>
            ) : (
              <Input
                value={mergeSearch}
                onChange={(e) => setMergeSearch(e.target.value)}
                disabled={mergePending}
                placeholder="Search all clients by name or email…"
                className="w-[300px]"
                data-testid="input-merge-search"
              />
            )}
          </div>
          {!mergeTarget && debouncedSearch.length >= 2 && (
            <div className="border bg-background divide-y" data-testid="list-merge-candidates">
              {candidatesQuery.isLoading ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">Searching…</div>
              ) : candidates.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground" data-testid="text-merge-no-matches">
                  No clients match “{debouncedSearch}”
                </div>
              ) : (
                candidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover-elevate flex items-center justify-between gap-2"
                    onClick={() => setMergeTarget(c)}
                    data-testid={`button-merge-candidate-${c.id}`}
                  >
                    <span className="truncate">
                      <span className="font-medium">{c.firmName}</span>
                      {c.contactEmail ? (
                        <span className="text-muted-foreground"> · {c.contactEmail}</span>
                      ) : null}
                    </span>
                    <Badge
                      variant="outline"
                      className={STAGE_BADGE[c.lifecycleStage as ClientLifecycleStage] ?? ""}
                    >
                      {stageLabel(c.lifecycleStage)}
                    </Badge>
                  </button>
                ))
              )}
            </div>
          )}
          {mergeTarget && (
            <div className="text-sm border bg-background p-3 space-y-2" data-testid="text-merge-confirm">
              <p>
                This moves <strong>{inquiries.length}</strong> website{" "}
                {inquiries.length === 1 ? "inquiry" : "inquiries"}, <strong>{meetings.length}</strong>{" "}
                {meetings.length === 1 ? "session" : "sessions"}, <strong>{deals.length}</strong>{" "}
                {deals.length === 1 ? "deal" : "deals"}, all contacts, and the lifecycle history into{" "}
                <strong>{mergeTarget.firmName}</strong>. The surviving record keeps the
                furthest-forward stage; <strong>{client.firmName}</strong> is deleted. The merge is
                audited and cannot be undone.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={mergePending}
                  onClick={() => onMerge(mergeTarget.id)}
                  data-testid="button-confirm-merge"
                >
                  <Merge className="h-4 w-4 mr-1" />
                  {mergePending ? "Merging…" : "Merge and delete this lead"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={mergePending}
                  onClick={() => setMergeTarget(null)}
                  data-testid="button-cancel-merge"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {deals.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Briefcase className="h-4 w-4" /> Deals
          </h3>
          {deals.map((d) => (
            <div key={d.id} className="flex items-center justify-between text-sm border px-3 py-2">
              <span>{d.name}</span>
              <span className="flex items-center gap-2">
                {d.stageName && <Badge variant="secondary">{d.stageName}</Badge>}
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/deals/${d.id}`}>Open</Link>
                </Button>
              </span>
            </div>
          ))}
        </section>
      )}

      {meetings.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <CalendarClock className="h-4 w-4" /> Sessions
          </h3>
          {meetings.slice(0, 5).map((m) => (
            <div key={m.id} className="text-sm border px-3 py-2 flex items-center justify-between">
              <span>{m.meetingTypeName || "Session"}</span>
              <span className="text-muted-foreground">
                {new Date(m.startTimeUtc).toLocaleString()} · {m.status}
              </span>
            </div>
          ))}
        </section>
      )}

      {inquiries.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Mail className="h-4 w-4" /> Website inquiries
          </h3>
          {inquiries.map((inq) => (
            <div key={inq.id} className="text-sm border px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {inq.createdAt ? new Date(inq.createdAt).toLocaleString() : ""}
                  {inq.sourcePage ? ` · ${inq.sourcePage}` : ""}
                </span>
              </div>
              {inq.message && <p className="mt-1 whitespace-pre-wrap">{inq.message}</p>}
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <History className="h-4 w-4" /> Lifecycle history
        </h3>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No lifecycle changes recorded — this account predates lifecycle tracking.
          </p>
        ) : (
          <div className="space-y-1.5">
            {/* Decorative timeline rail (already on the neutral `muted` token,
                not a status signal) — exempt from the --status-* token sweep
                (Task #4492). */}
            {history.map((h) => (
              <div key={h.id} className="text-sm flex items-center justify-between border-l-2 border-muted pl-3 py-0.5">
                <span>
                  {h.fromStage ? `${stageLabel(h.fromStage)} → ` : "Created as "}
                  <span className="font-medium">{stageLabel(h.toStage)}</span>
                  <span className="text-muted-foreground"> · {HISTORY_SOURCE_LABELS[h.source] ?? h.source}</span>
                  {h.reason && <span className="text-muted-foreground italic"> — {h.reason}</span>}
                </span>
                <span className="text-xs text-muted-foreground whitespace-nowrap ml-3">
                  {h.createdAt ? formatDistanceToNow(new Date(h.createdAt), { addSuffix: true }) : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
