// ClickUp admin — goals + key results panel.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Clock, Loader2, Plus, MoreHorizontal, Pencil, Target, Trash2, Users } from "lucide-react";
import type { Goal, KeyResult, Task } from "./types";
import { fmtDate } from "./lib";

// ─── Goals panel ─────────────────────────────────────────────────────────────

export const GOAL_COLORS = [
  { label: "Purple", value: "#7C4DFF" },
  { label: "Blue", value: "#2196F3" },
  { label: "Green", value: "#4CAF50" },
  { label: "Teal", value: "#009688" },
  { label: "Cyan", value: "#00BCD4" },
  { label: "Orange", value: "#FF9800" },
  { label: "Red", value: "#F44336" },
  { label: "Pink", value: "#E91E63" },
  { label: "Yellow", value: "#FFEB3B" },
];

export const KR_TYPES = [
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency ($)" },
  { value: "boolean", label: "True/False" },
  { value: "percentage", label: "Percentage" },
  { value: "automatic", label: "Task-based (automatic)" },
];

export function krProgress(kr: KeyResult): string {
  if (kr.percent_completed != null) return `${Math.round(kr.percent_completed)}%`;
  if (kr.type === "boolean") {
    return kr.steps_current === 1 ? "Done" : "Not done";
  }
  if (kr.steps_end != null) {
    const cur = kr.steps_current ?? kr.steps_start ?? 0;
    const unit = kr.unit ? ` ${kr.unit}` : "";
    return `${cur}${unit} / ${kr.steps_end}${unit}`;
  }
  return "—";
}

// ─── Goal form dialog (create + edit) ────────────────────────────────────────

export function GoalFormDialog({
  workspaceId,
  goal,
  open,
  onClose,
  members,
}: {
  workspaceId: string;
  goal?: Goal;
  open: boolean;
  onClose(): void;
  members: Array<{ id: string; username: string }>;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const isEdit = !!goal;

  const [name, setName] = useState(goal?.name ?? "");
  const [description, setDescription] = useState(goal?.description ?? "");
  const [color, setColor] = useState(goal?.color ?? GOAL_COLORS[0].value);
  const [dueDate, setDueDate] = useState(
    goal?.due_date ? new Date(Number(goal.due_date)).toISOString().slice(0, 10) : "",
  );
  const [ownerIds, setOwnerIds] = useState<string[]>(
    (goal?.owners ?? []).map((o) => String(o.id)),
  );

  const existingOwnerIds = (goal?.owners ?? []).map((o) => String(o.id));

  const mut = useMutation({
    mutationFn: async () => {
      const dueDateMs = dueDate ? new Date(dueDate).getTime() : null;
      if (isEdit) {
        const addOwners = ownerIds
          .filter((id) => !existingOwnerIds.includes(id))
          .map(Number);
        const remOwners = existingOwnerIds
          .filter((id) => !ownerIds.includes(id))
          .map(Number);
        const body: Record<string, any> = { name: name.trim(), description, color };
        if (dueDateMs) body.due_date = dueDateMs;
        else body.due_date = null;
        if (addOwners.length) body.add_owners = addOwners;
        if (remOwners.length) body.rem_owners = remOwners;
        const res = await fetch(`/api/clickup/goals/${goal!.id}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      } else {
        const body: Record<string, any> = {
          name: name.trim(),
          description,
          color,
          multiple_owners: ownerIds.length > 1,
          owners: ownerIds.map(Number),
        };
        if (dueDateMs) body.due_date = dueDateMs;
        const res = await fetch(`/api/clickup/workspaces/${workspaceId}/goals`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/clickup/workspaces", workspaceId, "goals"] }); // fire-and-forget: cache refresh only
      toast({ title: isEdit ? "Goal updated" : "Goal created" });
      onClose();
    },
    onError: (e: any) =>
      toast({ title: isEdit ? "Update failed" : "Create failed", description: e.message, variant: "destructive" }),
  });

  function toggleOwner(id: string) {
    setOwnerIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="dialog-goal-form">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Goal" : "New Goal"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update goal details, owners, and due date." : "Create a new goal in this workspace."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label className="text-xs">Goal name *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Increase NPS to 70"
              className="mt-1 h-8 text-sm"
              data-testid="input-goal-name"
            />
          </div>
          <div>
            <Label className="text-xs">Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description…"
              className="mt-1 text-sm min-h-[60px]"
              data-testid="input-goal-description"
            />
          </div>
          <div className="flex gap-4">
            <div className="flex-1">
              <Label className="text-xs">Due date</Label>
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="mt-1 h-8 text-sm"
                data-testid="input-goal-due-date"
              />
            </div>
            <div>
              <Label className="text-xs">Color</Label>
              <Select value={color} onValueChange={setColor}>
                <SelectTrigger className="mt-1 h-8 text-xs w-36" data-testid="select-goal-color">
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full inline-block" style={{ background: color }} />
                      {GOAL_COLORS.find((c) => c.value === color)?.label ?? "Custom"}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {GOAL_COLORS.map((c) => (
                    <SelectItem key={c.value} value={c.value} className="text-xs">
                      <span className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full inline-block flex-shrink-0" style={{ background: c.value }} />
                        {c.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {members.length > 0 && (
            <div>
              <Label className="text-xs">Owners</Label>
              <div className="mt-1 flex flex-wrap gap-1 max-h-24 overflow-y-auto border rounded p-1">
                {members.map((m) => {
                  const selected = ownerIds.includes(String(m.id));
                  return (
                    <button
                      key={m.id}
                      onClick={() => toggleOwner(String(m.id))}
                      className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                        selected
                          ? "bg-purple-600 text-white border-purple-600"
                          : "bg-muted/50 text-muted-foreground border-border hover:border-purple-300"
                      }`}
                      data-testid={`btn-owner-${m.id}`}
                    >
                      {m.username}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={mut.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => mut.mutate()}
            disabled={!name.trim() || mut.isPending}
            data-testid="button-save-goal"
          >
            {mut.isPending && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            {isEdit ? "Save changes" : "Create goal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Key result form dialog (create + edit) ───────────────────────────────────

export function KeyResultFormDialog({
  goalId,
  workspaceId,
  kr,
  open,
  onClose,
}: {
  goalId: string;
  workspaceId: string;
  kr?: KeyResult;
  open: boolean;
  onClose(): void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const isEdit = !!kr;

  const [name, setName] = useState(kr?.name ?? "");
  const [type, setType] = useState<string>(kr?.type ?? "number");
  const [stepsStart, setStepsStart] = useState(kr?.steps_start != null ? String(kr.steps_start) : "0");
  const [stepsEnd, setStepsEnd] = useState(kr?.steps_end != null ? String(kr.steps_end) : "100");
  const [unit, setUnit] = useState(kr?.unit ?? "");
  const [stepsCurrent, setStepsCurrent] = useState(
    kr?.steps_current != null ? String(kr.steps_current) : "",
  );
  const [note, setNote] = useState(kr?.note ?? "");

  const showSteps = type === "number" || type === "currency" || type === "percentage";

  const mut = useMutation({
    mutationFn: async () => {
      if (isEdit) {
        const body: Record<string, any> = { name: name.trim() };
        if (stepsCurrent !== "") body.steps_current = Number(stepsCurrent);
        if (note) body.note = note;
        const res = await fetch(`/api/clickup/goals/${goalId}/key-results/${kr!.id}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      } else {
        const body: Record<string, any> = { name: name.trim(), type };
        if (showSteps) {
          body.steps_start = Number(stepsStart);
          body.steps_end = Number(stepsEnd);
          if (unit) body.unit = unit;
        }
        const res = await fetch(`/api/clickup/goals/${goalId}/key-results`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/clickup/workspaces", workspaceId, "goals"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/clickup/goals", goalId] }); // fire-and-forget: cache refresh only
      toast({ title: isEdit ? "Target updated" : "Target added" });
      onClose();
    },
    onError: (e: any) =>
      toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid="dialog-kr-form">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Target" : "Add Target"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update target name or current progress." : "Add a key result to track progress toward this goal."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label className="text-xs">Target name *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Revenue from new clients"
              className="mt-1 h-8 text-sm"
              data-testid="input-kr-name"
            />
          </div>
          {!isEdit && (
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="mt-1 h-8 text-xs" data-testid="select-kr-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KR_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value} className="text-xs">
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {!isEdit && showSteps && (
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label className="text-xs">Start</Label>
                <Input
                  type="number"
                  value={stepsStart}
                  onChange={(e) => setStepsStart(e.target.value)}
                  className="mt-1 h-8 text-sm"
                  data-testid="input-kr-start"
                />
              </div>
              <div>
                <Label className="text-xs">End</Label>
                <Input
                  type="number"
                  value={stepsEnd}
                  onChange={(e) => setStepsEnd(e.target.value)}
                  className="mt-1 h-8 text-sm"
                  data-testid="input-kr-end"
                />
              </div>
              <div>
                <Label className="text-xs">Unit</Label>
                <Input
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  placeholder="tasks"
                  className="mt-1 h-8 text-sm"
                  data-testid="input-kr-unit"
                />
              </div>
            </div>
          )}
          {isEdit && (
            <>
              <div>
                <Label className="text-xs">Current progress</Label>
                <Input
                  type="number"
                  value={stepsCurrent}
                  onChange={(e) => setStepsCurrent(e.target.value)}
                  placeholder="Current value"
                  className="mt-1 h-8 text-sm"
                  data-testid="input-kr-current"
                />
              </div>
              <div>
                <Label className="text-xs">Note</Label>
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional note…"
                  className="mt-1 h-8 text-sm"
                  data-testid="input-kr-note"
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={mut.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => mut.mutate()}
            disabled={!name.trim() || mut.isPending}
            data-testid="button-save-kr"
          >
            {mut.isPending && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            {isEdit ? "Save" : "Add target"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Individual goal card ─────────────────────────────────────────────────────

export function GoalCard({
  goal,
  workspaceId,
  members,
  onEdit,
  onDelete,
}: {
  goal: Goal;
  workspaceId: string;
  members: Array<{ id: string; username: string }>;
  onEdit(g: Goal): void;
  onDelete(g: Goal): void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [addKrOpen, setAddKrOpen] = useState(false);
  const [editKr, setEditKr] = useState<KeyResult | null>(null);
  const [confirmDeleteKrId, setConfirmDeleteKrId] = useState<string | null>(null);

  const goalDetailQ = useQuery<{ goal: Goal }>({
    queryKey: ["/api/clickup/goals", goal.id],
    queryFn: () =>
      fetch(`/api/clickup/goals/${goal.id}`, { credentials: "include" }).then((r) => r.json()),
    enabled: expanded,
    staleTime: 30_000,
  });

  const detailGoal = goalDetailQ.data?.goal ?? goal;
  const keyResults = detailGoal.key_results ?? goal.key_results ?? [];

  const deleteKrMut = useMutation({
    mutationFn: async (krId: string) => {
      const res = await fetch(`/api/clickup/goals/${goal.id}/key-results/${krId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/clickup/workspaces", workspaceId, "goals"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/clickup/goals", goal.id] }); // fire-and-forget: cache refresh only
      toast({ title: "Target deleted" });
      setConfirmDeleteKrId(null);
    },
    onError: (e: any) =>
      toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const goalColor = goal.color ?? "#7C4DFF";

  return (
    <div className="bg-card border rounded-lg overflow-hidden" data-testid={`goal-card-${goal.id}`}>
      <div className="p-3">
        <div className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ background: goalColor }}
            aria-hidden="true"
          />
          <button
            className="text-sm font-medium text-foreground flex-1 text-left truncate hover:underline"
            onClick={() => setExpanded((v) => !v)}
            data-testid={`button-expand-goal-${goal.id}`}
          >
            {goal.name}
            {goal.pretty_id && (
              <span className="ml-1.5 text-[10px] text-muted-foreground">#{goal.pretty_id}</span>
            )}
          </button>
          {goal.percent_completed != null && (
            <Badge
              variant="outline"
              className="text-[10px] ml-auto flex-shrink-0"
              data-testid={`goal-pct-${goal.id}`}
            >
              {Math.round(goal.percent_completed)}%
            </Badge>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0" data-testid={`button-goal-menu-${goal.id}`}>
                <MoreHorizontal className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(goal)} data-testid={`menu-edit-goal-${goal.id}`}>
                <Pencil className="w-3 h-3 mr-2" /> Edit goal
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(goal)}
                className="text-red-600"
                data-testid={`menu-delete-goal-${goal.id}`}
              >
                <Trash2 className="w-3 h-3 mr-2" /> Delete goal
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {goal.percent_completed != null && (
          <div className="w-full bg-muted rounded-full h-1.5 mt-2">
            <div
              className="h-1.5 rounded-full transition-all"
              style={{
                width: `${Math.min(100, goal.percent_completed)}%`,
                background: goalColor,
              }}
            />
          </div>
        )}

        <div className="flex items-center gap-3 mt-1.5">
          {goal.due_date && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" /> Due {fmtDate(goal.due_date)}
            </span>
          )}
          {(goal.owners ?? []).length > 0 && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Users className="w-2.5 h-2.5" />
              {(goal.owners ?? []).map((o) => o.username).join(", ")}
            </span>
          )}
          {goal.description && (
            <span className="text-[10px] text-muted-foreground italic truncate">{goal.description}</span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t bg-muted/50 px-3 py-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">Targets (Key Results)</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs gap-1"
              onClick={() => setAddKrOpen(true)}
              data-testid={`button-add-kr-${goal.id}`}
            >
              <Plus className="w-3 h-3" /> Add
            </Button>
          </div>

          {goalDetailQ.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading targets…
            </div>
          ) : keyResults.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-1" data-testid={`text-no-krs-${goal.id}`}>
              No targets yet — add one above
            </p>
          ) : (
            <div className="space-y-1.5">
              {keyResults.map((kr) => (
                <div
                  key={kr.id}
                  className="bg-card border rounded px-2.5 py-2 flex items-center gap-2"
                  data-testid={`kr-row-${kr.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-foreground truncate">{kr.name}</span>
                      <Badge variant="outline" className="text-[9px] flex-shrink-0">
                        {KR_TYPES.find((t) => t.value === kr.type)?.label ?? kr.type}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-muted-foreground" data-testid={`kr-progress-${kr.id}`}>
                        {krProgress(kr)}
                      </span>
                      {kr.percent_completed != null && (
                        <div className="flex-1 bg-muted rounded-full h-1" style={{ maxWidth: 80 }}>
                          <div
                            className="h-1 rounded-full bg-purple-500"
                            style={{ width: `${Math.min(100, kr.percent_completed)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => setEditKr(kr)}
                      data-testid={`button-edit-kr-${kr.id}`}
                    >
                      <Pencil className="w-3 h-3 text-muted-foreground" />
                    </Button>
                    {confirmDeleteKrId === kr.id ? (
                      <>
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-6 text-[10px] px-2"
                          onClick={() => deleteKrMut.mutate(kr.id)}
                          disabled={deleteKrMut.isPending}
                          data-testid={`button-confirm-delete-kr-${kr.id}`}
                        >
                          {deleteKrMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Delete"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[10px] px-2"
                          onClick={() => setConfirmDeleteKrId(null)}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={() => setConfirmDeleteKrId(kr.id)}
                        data-testid={`button-delete-kr-${kr.id}`}
                      >
                        <Trash2 className="w-3 h-3 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {addKrOpen && (
        <KeyResultFormDialog
          goalId={goal.id}
          workspaceId={workspaceId}
          open={addKrOpen}
          onClose={() => setAddKrOpen(false)}
        />
      )}
      {editKr && (
        <KeyResultFormDialog
          goalId={goal.id}
          workspaceId={workspaceId}
          kr={editKr}
          open={!!editKr}
          onClose={() => setEditKr(null)}
        />
      )}
    </div>
  );
}

// ─── Goals panel ──────────────────────────────────────────────────────────────

export function GoalsPanel({ workspaceId }: { workspaceId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [editGoal, setEditGoal] = useState<Goal | null>(null);
  const [deleteGoal, setDeleteGoal] = useState<Goal | null>(null);

  const { data, isLoading } = useQuery<{ goals: Goal[] }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "goals"],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/goals`, { credentials: "include" }).then((r) =>
        r.json(),
      ),
  });

  const facetsQ = useQuery<{ members: Array<{ id: string; username: string }> }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "facets"],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/facets`, { credentials: "include" }).then((r) =>
        r.json(),
      ),
    staleTime: 60_000,
  });
  const members = facetsQ.data?.members ?? [];

  const deleteMut = useMutation({
    mutationFn: async (goalId: string) => {
      const res = await fetch(`/api/clickup/goals/${goalId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/clickup/workspaces", workspaceId, "goals"] }); // fire-and-forget: cache refresh only
      toast({ title: "Goal deleted" });
      setDeleteGoal(null);
    },
    onError: (e: any) =>
      toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading goals…
      </div>
    );
  }

  const goals = data?.goals ?? [];

  return (
    <div className="space-y-3" data-testid="panel-goals">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">Goals</span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1"
          onClick={() => setCreateOpen(true)}
          data-testid="button-create-goal"
        >
          <Plus className="w-3 h-3" /> New goal
        </Button>
      </div>

      {goals.length === 0 ? (
        <p className="text-xs text-muted-foreground italic" data-testid="text-no-goals">
          No goals yet — create one above
        </p>
      ) : (
        <div className="space-y-2">
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              workspaceId={workspaceId}
              members={members}
              onEdit={setEditGoal}
              onDelete={setDeleteGoal}
            />
          ))}
        </div>
      )}

      {createOpen && (
        <GoalFormDialog
          workspaceId={workspaceId}
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          members={members}
        />
      )}
      {editGoal && (
        <GoalFormDialog
          workspaceId={workspaceId}
          goal={editGoal}
          open={!!editGoal}
          onClose={() => setEditGoal(null)}
          members={members}
        />
      )}
      {deleteGoal && (
        <Dialog open={!!deleteGoal} onOpenChange={(o) => { if (!o) setDeleteGoal(null); }}>
          <DialogContent className="max-w-sm" data-testid="dialog-delete-goal">
            <DialogHeader>
              <DialogTitle>Delete goal?</DialogTitle>
              <DialogDescription>
                This will permanently delete <strong>{deleteGoal.name}</strong> and all its targets from ClickUp. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setDeleteGoal(null)} disabled={deleteMut.isPending}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => deleteMut.mutate(deleteGoal.id)}
                disabled={deleteMut.isPending}
                data-testid="button-confirm-delete-goal"
              >
                {deleteMut.isPending && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

