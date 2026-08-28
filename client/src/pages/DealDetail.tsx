/**
 * Task #4327 — Deal detail view.
 *
 * Shows a deal's fields, its linked client + contacts, and the full stage
 * history (who moved it where, and when — deal_stage_history). The move
 * control here is the non-drag path onto POST /api/deals/:id/move and funnels
 * 422 required-fields answers into the same DealRequiredFieldsDialog the
 * board uses. Field edits go through PATCH /api/deals/:id, which cannot
 * change stage (stageId is not in the update schema — moves must leave
 * history).
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "wouter";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
  Gauge,
  History,
  Loader2,
  Pencil,
  Trash2,
  User as UserIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClientTimeline } from "@/components/ClientTimeline";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { RecordTagsCard } from "@/components/tags/RecordTagsCard";
import {
  DealRequiredFieldsDialog,
  formatDealAmount,
  postDealMove,
  type DealMoveFields,
  type RequiredFieldsPrompt,
} from "@/components/DealRequiredFieldsDialog";
import {
  dealTriggerTypeLabels,
  type Deal,
  type DealPipeline,
  type DealStage,
  type DealStageHistoryEntry,
  type DealTriggerType,
  type ScoreBreakdownEntry,
} from "@shared/schema";

type PipelineWithStages = DealPipeline & { stages: DealStage[] };

type DealDetailPayload = Deal & {
  clientFirmName: string | null;
  ownerName: string | null;
  createdByName: string | null;
  contacts: { id: string; name: string; roleTitle: string | null; isPrimary: boolean }[];
  history: (DealStageHistoryEntry & {
    fromStageName: string | null;
    toStageName: string | null;
    movedByName: string | null;
  })[];
  // Task #4333 — deterministic fit+engagement score (null until first
  // compute). Timestamps arrive serialized as ISO strings.
  score: number | null;
  fitScore: number | null;
  engagementScore: number | null;
  scoreComputedAt: string | null;
  scoreBreakdown: ScoreBreakdownEntry[] | null;
};

function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function DealDetail() {
  const params = useParams<{ id: string }>();
  const dealId = params.id;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const dealQuery = useQuery<DealDetailPayload>({
    queryKey: ["/api/deals", dealId],
    enabled: Boolean(dealId),
  });
  const pipelinesQuery = useQuery<PipelineWithStages[]>({
    queryKey: ["/api/deals/pipelines"],
  });

  const deal = dealQuery.data;
  const stages = useMemo(() => {
    if (!deal) return [];
    return (
      pipelinesQuery.data?.find((p) => p.id === deal.pipelineId)?.stages ?? []
    );
  }, [deal, pipelinesQuery.data]);
  const currentStage = stages.find((s) => s.id === deal?.stageId);

  // ── Move control ───────────────────────────────────────────────────────────
  const [moveTargetId, setMoveTargetId] = useState<string>("");
  const [requiredPrompt, setRequiredPrompt] = useState<RequiredFieldsPrompt | null>(null);
  const [moving, setMoving] = useState(false);

  async function attemptMove(toStage: DealStage, fields?: DealMoveFields) {
    if (!deal) return;
    setMoving(true);
    try {
      const result = await postDealMove(deal.id, toStage.id, fields);
      if (result.ok) {
        setRequiredPrompt(null);
        setMoveTargetId("");
        toast({ title: `Moved to ${toStage.name}` });
        void queryClient.invalidateQueries({ queryKey: ["/api/deals", deal.id] });
        void queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
        return;
      }
      if (result.status === 422 && result.missingFields?.length) {
        setRequiredPrompt({
          dealId: deal.id,
          dealName: deal.name,
          toStageId: toStage.id,
          toStageName: toStage.name,
          missingFields: result.missingFields,
        });
        return;
      }
      toast({
        title: "Couldn't move deal",
        description: result.error ?? "Something went wrong. Try again.",
        variant: "destructive",
      });
    } catch {
      // Network/aborted request: surface it instead of leaving the move
      // control silently stuck with no feedback.
      toast({
        title: "Couldn't move deal",
        description: "Something went wrong. Try again.",
        variant: "destructive",
      });
    } finally {
      setMoving(false);
    }
  }

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/deals/${dealId}`);
    },
    onSuccess: () => {
      toast({ title: "Deal deleted" });
      void queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      setLocation("/deals");
    },
    onError: (error: Error) => {
      toast({
        title: "Couldn't delete deal",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const [editOpen, setEditOpen] = useState(false);

  if (dealQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading deal…
      </div>
    );
  }
  if (dealQuery.isError || !deal) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm" data-testid="text-deal-error">
          This deal could not be loaded — it may have been deleted or you may
          not have access to it.
        </div>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/deals">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back to board
          </Link>
        </Button>
      </div>
    );
  }

  const stageTone =
    currentStage?.stageType === "won"
      ? "border-status-ok/30 bg-status-ok/10 text-status-ok"
      : currentStage?.stageType === "lost"
        ? "border-status-critical/30 bg-status-critical/10 text-status-critical"
        : "";

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6" data-testid="page-deal-detail">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm" data-testid="link-back-board">
          <Link href="/deals">
            <ArrowLeft className="mr-1 h-4 w-4" />
            Board
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold" data-testid="text-deal-name">
          {deal.name}
        </h1>
        {currentStage && (
          <Badge variant="outline" className={stageTone} data-testid="badge-deal-stage">
            {currentStage.name}
          </Badge>
        )}
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Select value={moveTargetId} onValueChange={setMoveTargetId}>
          <SelectTrigger className="w-56" aria-label="Deal stage" data-testid="select-move-stage">
            <SelectValue placeholder="Move to stage…" />
          </SelectTrigger>
          <SelectContent>
            {stages
              .filter((s) => s.id !== deal.stageId)
              .map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} ({s.winProbability}%)
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Button
          disabled={!moveTargetId || moving}
          onClick={() => {
            const target = stages.find((s) => s.id === moveTargetId);
            if (target) void attemptMove(target);
          }}
          data-testid="button-move-deal"
        >
          <ArrowRight className="mr-1.5 h-4 w-4" />
          {moving ? "Moving…" : "Move"}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setEditOpen(true)}
            data-testid="button-edit-deal"
          >
            <Pencil className="mr-1.5 h-4 w-4" />
            Edit
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="text-destructive" data-testid="button-delete-deal">
                <Trash2 className="mr-1.5 h-4 w-4" />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this deal?</AlertDialogTitle>
                <AlertDialogDescription>
                  “{deal.name}” and its stage history will be permanently
                  removed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate()}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  data-testid="button-confirm-delete"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr,minmax(280px,380px)]">
        <div className="space-y-6">
          <Card data-testid="card-deal-fields">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <div className="text-xs text-muted-foreground">Amount</div>
                <div className="font-semibold" data-testid="text-deal-amount">
                  {formatDealAmount(deal.amount)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Expected close</div>
                <div data-testid="text-deal-close-date">
                  {deal.expectedCloseDate ?? "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Owner</div>
                <div className="flex items-center gap-1.5" data-testid="text-deal-owner">
                  <UserIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  {deal.ownerName ?? "Unassigned"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Created</div>
                <div>
                  {formatDateTime(deal.createdAt)}
                  {deal.createdByName ? ` · ${deal.createdByName}` : ""}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">In current stage since</div>
                <div>{formatDateTime(deal.stageEnteredAt)}</div>
              </div>
              {/* Task #4337 — first-touch attribution, stamped at creation
                  (inherited from the linked client) and immutable. */}
              <div>
                <div className="text-xs text-muted-foreground">First-touch source</div>
                <div data-testid="text-deal-first-touch">
                  {deal.firstTouchSource ?? "Unknown (pre-tracking)"}
                  {deal.firstTouchCampaign ? ` · ${deal.firstTouchCampaign}` : ""}
                </div>
              </div>
              {currentStage?.stageType === "lost" && (
                <div className="sm:col-span-2">
                  <div className="text-xs text-muted-foreground">Lost reason</div>
                  <div data-testid="text-deal-lost-reason">{deal.lostReason ?? "—"}</div>
                </div>
              )}
              {deal.notes && (
                <div className="sm:col-span-2">
                  <div className="text-xs text-muted-foreground">Notes</div>
                  <div className="whitespace-pre-wrap" data-testid="text-deal-notes">
                    {deal.notes}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-deal-client">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Client & contacts</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {deal.clientId ? (
                <Link
                  href={`/clients/${deal.clientId}`}
                  className="flex items-center gap-2 font-medium hover:underline"
                  data-testid="link-deal-client"
                >
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  {deal.clientFirmName ?? "View client"}
                </Link>
              ) : (
                <div className="text-muted-foreground">No client linked.</div>
              )}
              {deal.contacts.length > 0 && (
                <ul className="space-y-1.5" data-testid="list-deal-contacts">
                  {deal.contacts.map((contact) => (
                    <li key={contact.id} className="flex items-center gap-2">
                      <UserIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {contact.name}
                        {contact.isPrimary ? " (primary)" : ""}
                        {contact.roleTitle ? (
                          <span className="text-muted-foreground"> — {contact.roleTitle}</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <RecordTagsCard entityType="deal" recordId={deal.id} />
        </div>

        <div className="space-y-6 self-start">
        <Card data-testid="card-deal-score">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Gauge className="h-4 w-4" />
              Score
            </CardTitle>
          </CardHeader>
          <CardContent>
            {deal.score === null ? (
              <p className="text-sm text-muted-foreground" data-testid="text-score-empty">
                Not scored yet. Scores recompute nightly and after scoring
                rules change.
              </p>
            ) : (
              <div className="space-y-3 text-sm">
                <div className="flex items-baseline gap-3">
                  <span className="text-3xl font-bold tabular-nums" data-testid="text-deal-score">
                    {deal.score}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Fit <span className="font-medium text-foreground" data-testid="text-deal-fit-score">{deal.fitScore ?? 0}</span>
                    {" · "}
                    Engagement <span className="font-medium text-foreground" data-testid="text-deal-engagement-score">{deal.engagementScore ?? 0}</span>
                  </span>
                </div>
                {(deal.scoreBreakdown?.length ?? 0) > 0 && (
                  <ul className="space-y-1.5" data-testid="list-score-breakdown">
                    {(deal.scoreBreakdown ?? []).map((entry) => (
                      <li key={entry.ruleId} className="flex items-start justify-between gap-2">
                        <span className="min-w-0">
                          <span className="block truncate">{entry.name}</span>
                          {entry.detail && (
                            <span className="block text-xs text-muted-foreground">
                              {entry.detail}
                            </span>
                          )}
                        </span>
                        <span
                          className={`shrink-0 font-semibold tabular-nums ${
                            entry.points < 0 ? "text-status-critical" : "text-status-ok"
                          }`}
                        >
                          {entry.points > 0 ? `+${entry.points}` : entry.points}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="text-xs text-muted-foreground" data-testid="text-score-computed-at">
                  Computed {formatDateTime(deal.scoreComputedAt)}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-stage-history">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="h-4 w-4" />
              Stage history
            </CardTitle>
          </CardHeader>
          <CardContent>
            {deal.history.length === 0 ? (
              <div className="text-sm text-muted-foreground">No history yet.</div>
            ) : (
              <ol className="space-y-3" data-testid="list-stage-history">
                {deal.history.map((entry) => (
                  <li key={entry.id} className="flex gap-2.5 text-sm">
                    <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary/60" />
                    <div className="min-w-0">
                      <div>
                        {entry.fromStageName ? (
                          <>
                            <span className="text-muted-foreground">
                              {entry.fromStageName}
                            </span>
                            <ArrowRight className="mx-1 inline h-3 w-3 text-muted-foreground" />
                            <span className="font-medium">{entry.toStageName ?? "—"}</span>
                          </>
                        ) : (
                          <>
                            Created in{" "}
                            <span className="font-medium">{entry.toStageName ?? "—"}</span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <CalendarDays className="h-3 w-3" />
                        {formatDateTime(entry.movedAt)}
                        {entry.movedByName ? (
                          <> · {entry.movedByName}</>
                        ) : entry.movedBySource ? (
                          // Task #4332 — auto-moves carry their source event
                          // instead of a user.
                          <span data-testid={`text-history-source-${entry.id}`}>
                            · Auto ·{" "}
                            {dealTriggerTypeLabels[
                              entry.movedBySource as DealTriggerType
                            ] ?? entry.movedBySource}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
        </div>
      </div>

      {/* Task #4328 — unified activity timeline scoped to the deal's client
          (emails, SMS, calls, meetings, tickets, notes). Same component as
          the client detail Timeline tab, pointed at the deal-scoped route. */}
      <Card className="mt-6" data-testid="card-deal-timeline">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" />
            Activity timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          {deal.clientId ? (
            <ClientTimeline
              endpoint={`/api/deals/${deal.id}/timeline`}
              noteClientId={deal.clientId}
            />
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="text-timeline-no-client">
              Link a client to this deal to see its activity timeline.
            </p>
          )}
        </CardContent>
      </Card>

      <DealRequiredFieldsDialog
        prompt={requiredPrompt}
        submitting={moving}
        onCancel={() => setRequiredPrompt(null)}
        onSubmit={(fields) => {
          const target = stages.find((s) => s.id === requiredPrompt?.toStageId);
          if (target) void attemptMove(target, fields);
        }}
      />

      <EditDealDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        deal={deal}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ["/api/deals", deal.id] });
          void queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
        }}
      />
    </div>
  );
}

// ── Edit dialog ─────────────────────────────────────────────────────────────

function EditDealDialog({
  open,
  onOpenChange,
  deal,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal: DealDetailPayload;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(deal.name);
  const [amount, setAmount] = useState(deal.amount !== null ? String(deal.amount) : "");
  const [expectedCloseDate, setExpectedCloseDate] = useState(deal.expectedCloseDate ?? "");
  const [notes, setNotes] = useState(deal.notes ?? "");
  const [lostReason, setLostReason] = useState(deal.lostReason ?? "");

  // Re-sync form state each time the dialog opens on a (possibly refetched) deal.
  const [syncedFor, setSyncedFor] = useState<string | null>(null);
  if (open && syncedFor !== `${deal.id}:${deal.updatedAt}`) {
    setSyncedFor(`${deal.id}:${deal.updatedAt}`);
    setName(deal.name);
    setAmount(deal.amount !== null ? String(deal.amount) : "");
    setExpectedCloseDate(deal.expectedCloseDate ?? "");
    setNotes(deal.notes ?? "");
    setLostReason(deal.lostReason ?? "");
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        amount: amount.trim() === "" ? null : Number(amount),
        expectedCloseDate: expectedCloseDate === "" ? null : expectedCloseDate,
        notes: notes.trim() === "" ? null : notes.trim(),
        lostReason: lostReason.trim() === "" ? null : lostReason.trim(),
      };
      const res = await apiRequest("PATCH", `/api/deals/${deal.id}`, body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Deal updated" });
      onOpenChange(false);
      onSaved();
    },
    onError: (error: Error) => {
      toast({
        title: "Couldn't save deal",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="dialog-edit-deal">
        <DialogHeader>
          <DialogTitle>Edit deal</DialogTitle>
          <DialogDescription>
            Stage changes happen on the board or via the move control — edits
            here never skip stage history.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="edit-deal-name">Deal name *</Label>
            <Input
              id="edit-deal-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="input-edit-name"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-deal-amount">Amount (USD)</Label>
              <Input
                id="edit-deal-amount"
                type="number"
                min="0"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="input-edit-amount"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-deal-close">Expected close</Label>
              <Input
                id="edit-deal-close"
                type="date"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
                data-testid="input-edit-close-date"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-deal-lost-reason">Lost reason</Label>
            <Input
              id="edit-deal-lost-reason"
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              placeholder="Only relevant for lost deals"
              data-testid="input-edit-lost-reason"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-deal-notes">Notes</Label>
            <Textarea
              id="edit-deal-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              data-testid="input-edit-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-edit-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={name.trim() === "" || saveMutation.isPending}
            data-testid="button-edit-save"
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
