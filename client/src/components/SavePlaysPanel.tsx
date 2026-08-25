/**
 * Task #3696 — Save Plays panel (per-client).
 *
 * Sidebar panel on the client detail page's Daily Judgment tab: the team
 * opens accountable "save plays" (interventions) for a client — manually or
 * pre-filled from a judgment's recommended action — each with a title, why,
 * assigned owner, due date, and notes. Plays flow active → completed |
 * abandoned with an outcome note; closed plays keep their history (shown in
 * a collapsed "History" section) so the director can review what was tried.
 *
 * The `prefill` prop is how the judgment stream's "Start save play"
 * affordance opens the create dialog pre-filled (title/why/sourceJudgmentId);
 * the panel calls `onPrefillHandled` once consumed.
 *
 * API: /api/clients/:clientId/save-plays (list/create) and
 * /api/clients/:clientId/save-plays/:playId (patch/delete) — see
 * server/routes/savePlays.ts. Overdue here is a visual flag derived from the
 * viewer's local date; the director rollup derives it server-side.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  CalendarClock, Check, LifeBuoy, Loader2, Pencil, Plus, RotateCcw, Trash2, X,
} from "lucide-react";

export type SavePlayPrefill = {
  title: string;
  why?: string | null;
  sourceJudgmentId?: string | null;
};

export type SavePlay = {
  id: string;
  clientId: string;
  title: string;
  why: string | null;
  sourceJudgmentId: string | null;
  assignedToUserId: string;
  dueDate: string;
  status: "active" | "completed" | "abandoned" | string;
  notes: string | null;
  outcomeNote: string | null;
  createdByUserId: string | null;
  closedAt: string | null;
  closedByUserId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type PanelUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role?: string | null;
};

function userLabel(u: PanelUser | undefined | null): string {
  if (!u) return "Unknown";
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return name || u.email || u.id;
}

function localToday(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function defaultDueDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function fmtDue(dueDate: string): string {
  const t = Date.parse(`${dueDate}T00:00:00`);
  if (Number.isNaN(t)) return dueDate;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type FormState = {
  title: string;
  why: string;
  assignedToUserId: string;
  dueDate: string;
  notes: string;
  sourceJudgmentId: string | null;
};

const EMPTY_FORM: FormState = {
  title: "",
  why: "",
  assignedToUserId: "",
  dueDate: "",
  notes: "",
  sourceJudgmentId: null,
};

export default function SavePlaysPanel({
  clientId,
  currentUserId,
  prefill,
  onPrefillHandled,
}: {
  clientId: string;
  currentUserId?: string;
  prefill?: SavePlayPrefill | null;
  onPrefillHandled?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const listKey = ["/api/clients", clientId, "save-plays"];

  const { data: plays = [], isLoading } = useQuery<SavePlay[]>({
    queryKey: listKey,
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/save-plays`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load save plays (${res.status})`);
      return res.json();
    },
  });

  const { data: users = [] } = useQuery<PanelUser[]>({
    queryKey: ["/api/users"],
    queryFn: async () => {
      const res = await fetch("/api/users", { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load users (${res.status})`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const usersById = useMemo(() => {
    const map = new Map<string, PanelUser>();
    for (const u of users) map.set(u.id, u);
    return map;
  }, [users]);

  // ── Create / edit dialog state ─────────────────────────────────────────
  const [formOpen, setFormOpen] = useState(false);
  const [editingPlay, setEditingPlay] = useState<SavePlay | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const openCreate = (pre?: SavePlayPrefill | null) => {
    setEditingPlay(null);
    setForm({
      title: (pre?.title ?? "").slice(0, 300),
      why: pre?.why ?? "",
      assignedToUserId: currentUserId ?? "",
      dueDate: defaultDueDate(),
      notes: "",
      sourceJudgmentId: pre?.sourceJudgmentId ?? null,
    });
    setFormOpen(true);
  };

  const openEdit = (play: SavePlay) => {
    setEditingPlay(play);
    setForm({
      title: play.title,
      why: play.why ?? "",
      assignedToUserId: play.assignedToUserId,
      dueDate: play.dueDate,
      notes: play.notes ?? "",
      sourceJudgmentId: play.sourceJudgmentId,
    });
    setFormOpen(true);
  };

  // Judgment stream hands us a prefill → open the create dialog with it.
  useEffect(() => {
    if (!prefill) return;
    openCreate(prefill);
    onPrefillHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  // ── Close (complete/abandon) dialog state ──────────────────────────────
  const [closing, setClosing] = useState<{ play: SavePlay; action: "completed" | "abandoned" } | null>(null);
  const [outcomeNote, setOutcomeNote] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: listKey }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/churn/save-plays"] }); // fire-and-forget: cache refresh only
  };

  const createMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch(`/api/clients/${clientId}/save-plays`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to create save play (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      toast({ title: "Save play created" });
    },
    onError: (e: Error) => toast({ title: "Couldn't create save play", description: e.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ playId, body }: { playId: string; body: Record<string, unknown> }) => {
      const res = await fetch(`/api/clients/${clientId}/save-plays/${playId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to update save play (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      setClosing(null);
    },
    onError: (e: Error) => toast({ title: "Couldn't update save play", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (playId: string) => {
      const res = await fetch(`/api/clients/${clientId}/save-plays/${playId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to delete save play (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      toast({ title: "Save play deleted" });
    },
    onError: (e: Error) => toast({ title: "Couldn't delete save play", description: e.message, variant: "destructive" }),
  });

  const submitForm = () => {
    if (!form.title.trim()) {
      toast({ title: "Title is required", variant: "destructive" });
      return;
    }
    if (!form.assignedToUserId) {
      toast({ title: "Pick an owner for this play", variant: "destructive" });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.dueDate)) {
      toast({ title: "Pick a due date", variant: "destructive" });
      return;
    }
    if (editingPlay) {
      updateMutation.mutate({
        playId: editingPlay.id,
        body: {
          title: form.title.trim(),
          why: form.why.trim() || null,
          assignedToUserId: form.assignedToUserId,
          dueDate: form.dueDate,
          notes: form.notes.trim() || null,
        },
      });
    } else {
      createMutation.mutate({
        title: form.title.trim(),
        why: form.why.trim() || null,
        assignedToUserId: form.assignedToUserId,
        dueDate: form.dueDate,
        notes: form.notes.trim() || null,
        sourceJudgmentId: form.sourceJudgmentId,
      });
    }
  };

  const confirmClose = () => {
    if (!closing) return;
    updateMutation.mutate({
      playId: closing.play.id,
      body: {
        status: closing.action,
        outcomeNote: outcomeNote.trim() || null,
      },
    });
  };

  const today = localToday();
  const activePlays = plays.filter((p) => p.status === "active");
  const closedPlays = plays.filter((p) => p.status !== "active");
  const isOverdue = (p: SavePlay) => p.status === "active" && p.dueDate < today;
  const mutating = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  return (
    <Card data-testid="panel-save-plays">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <LifeBuoy className="w-4 h-4 text-primary" />
            Save Plays
            {activePlays.length > 0 && (
              <Badge variant="secondary" className="text-caption px-1.5" data-testid="badge-active-play-count">
                {activePlays.length} active
              </Badge>
            )}
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => openCreate()}
            data-testid="button-new-save-play"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            New
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="h-14 rounded-md bg-gray-100 animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            {activePlays.length === 0 && (
              <p className="text-xs text-muted-foreground" data-testid="text-no-active-plays">
                No active save play. If this client is at risk, someone should own the save.
              </p>
            )}

            {activePlays.map((p) => (
              <div
                key={p.id}
                className={`rounded-md border p-2.5 space-y-1.5 ${
                  isOverdue(p) ? "border-red-200 bg-red-50/50" : "border-gray-200"
                }`}
                data-testid={`save-play-item-${p.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-medium text-foreground leading-snug">{p.title}</p>
                  {isOverdue(p) && (
                    <Badge className="bg-red-100 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/40 text-caption px-1.5 shrink-0" data-testid={`badge-overdue-${p.id}`}>
                      Overdue
                    </Badge>
                  )}
                </div>
                {p.why && <p className="text-[11px] text-gray-500 line-clamp-2">{p.why}</p>}
                {p.notes && <p className="text-[11px] text-gray-400 italic line-clamp-2">{p.notes}</p>}
                <div className="flex items-center justify-between gap-2 pt-0.5">
                  <div className="flex items-center gap-2 min-w-0 text-caption text-gray-500">
                    <span className="truncate font-medium">{userLabel(usersById.get(p.assignedToUserId))}</span>
                    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap ${isOverdue(p) ? "text-red-600 font-medium" : ""}`}>
                      <CalendarClock className="w-3 h-3" />
                      {fmtDue(p.dueDate)}
                    </span>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Button
                      size="icon" variant="ghost" className="h-6 w-6 text-green-700 hover:text-green-800"
                      title="Complete play"
                      onClick={() => { setOutcomeNote(""); setClosing({ play: p, action: "completed" }); }}
                      data-testid={`button-complete-save-play-${p.id}`}
                    >
                      <Check className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      size="icon" variant="ghost" className="h-6 w-6 text-gray-500 hover:text-gray-700"
                      title="Abandon play"
                      onClick={() => { setOutcomeNote(""); setClosing({ play: p, action: "abandoned" }); }}
                      data-testid={`button-abandon-save-play-${p.id}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      size="icon" variant="ghost" className="h-6 w-6 text-gray-500 hover:text-gray-700"
                      title="Edit play"
                      onClick={() => openEdit(p)}
                      data-testid={`button-edit-save-play-${p.id}`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}

            {closedPlays.length > 0 && (
              <div className="space-y-1.5 pt-1" data-testid="section-save-play-history">
                <p className="text-caption font-semibold uppercase tracking-wide text-gray-400">History</p>
                {closedPlays.map((p) => (
                  <div key={p.id} className="rounded-md border border-gray-100 bg-gray-50/60 p-2 space-y-1" data-testid={`save-play-item-${p.id}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[11px] text-gray-500 leading-snug line-clamp-1">{p.title}</p>
                        {p.outcomeNote && (
                          <p className="text-caption text-gray-400 italic line-clamp-2" data-testid={`text-outcome-${p.id}`}>
                            {p.outcomeNote}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Badge
                          className={`text-[9px] px-1.5 ${
                            p.status === "completed"
                              ? "bg-green-100 text-green-700 hover:bg-green-100"
                              : "bg-gray-200 text-gray-600 hover:bg-gray-200"
                          }`}
                        >
                          {p.status === "completed" ? "Completed" : "Abandoned"}
                        </Badge>
                        <Button
                          size="icon" variant="ghost" className="h-5 w-5 text-gray-400 hover:text-gray-600"
                          title="Reactivate play"
                          onClick={() => updateMutation.mutate({ playId: p.id, body: { status: "active" } })}
                          data-testid={`button-reactivate-save-play-${p.id}`}
                        >
                          <RotateCcw className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>

      {/* Create / edit dialog */}
      <Dialog open={formOpen} onOpenChange={(open) => { if (!open) setFormOpen(false); }}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-save-play-form">
          <DialogHeader>
            <DialogTitle>{editingPlay ? "Edit save play" : "New save play"}</DialogTitle>
            <DialogDescription>
              {editingPlay
                ? "Update the intervention's details."
                : "An accountable intervention: what we're doing to save this client, who owns it, and by when."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="save-play-title" className="text-xs">Title *</Label>
              <Input
                id="save-play-title"
                value={form.title}
                maxLength={300}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Book a recovery call this week"
                data-testid="input-save-play-title"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="save-play-why" className="text-xs">Why</Label>
              <Textarea
                id="save-play-why"
                value={form.why}
                rows={2}
                onChange={(e) => setForm((f) => ({ ...f, why: e.target.value }))}
                placeholder="What risk is this addressing?"
                data-testid="input-save-play-why"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Owner *</Label>
                <Select
                  value={form.assignedToUserId || undefined}
                  onValueChange={(v) => setForm((f) => ({ ...f, assignedToUserId: v }))}
                >
                  <SelectTrigger className="h-9 text-xs" data-testid="select-save-play-owner">
                    <SelectValue placeholder="Pick owner" />
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={u.id} className="text-xs">
                        {userLabel(u)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="save-play-due" className="text-xs">Due date *</Label>
                <Input
                  id="save-play-due"
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
                  data-testid="input-save-play-due"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="save-play-notes" className="text-xs">Notes</Label>
              <Textarea
                id="save-play-notes"
                value={form.notes}
                rows={2}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Optional context or progress notes"
                data-testid="input-save-play-notes"
              />
            </div>
            {!editingPlay && form.sourceJudgmentId && (
              <p className="text-[11px] text-muted-foreground" data-testid="text-prefill-source">
                Pre-filled from a daily judgment's recommended action.
              </p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            {editingPlay ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                disabled={mutating}
                onClick={() => deleteMutation.mutate(editingPlay.id)}
                data-testid="button-delete-save-play"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1" />
                Delete
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setFormOpen(false)} data-testid="button-cancel-save-play">
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                disabled={mutating}
                onClick={submitForm}
                data-testid="button-submit-save-play"
              >
                {mutating && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                {editingPlay ? "Save changes" : "Create play"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Complete / abandon dialog */}
      <Dialog open={closing !== null} onOpenChange={(open) => { if (!open) setClosing(null); }}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-save-play-outcome">
          <DialogHeader>
            <DialogTitle>
              {closing?.action === "completed" ? "Complete save play" : "Abandon save play"}
            </DialogTitle>
            <DialogDescription>
              {closing?.action === "completed"
                ? "What happened? The outcome stays on record for future churn reviews."
                : "Why is this play being abandoned? The note stays on record."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="save-play-outcome" className="text-xs">Outcome note</Label>
            <Textarea
              id="save-play-outcome"
              value={outcomeNote}
              rows={3}
              onChange={(e) => setOutcomeNote(e.target.value)}
              placeholder={closing?.action === "completed" ? "e.g. Client agreed to a revised scope" : "e.g. Superseded by a bigger renegotiation play"}
              data-testid="input-save-play-outcome"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setClosing(null)} data-testid="button-cancel-outcome">
              Cancel
            </Button>
            <Button
              size="sm"
              className={closing?.action === "completed" ? "bg-green-700 hover:bg-green-800 text-white" : "bg-gray-600 hover:bg-gray-700 text-white"}
              disabled={updateMutation.isPending}
              onClick={confirmClose}
              data-testid="button-confirm-outcome"
            >
              {updateMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
              {closing?.action === "completed" ? "Mark completed" : "Abandon play"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
