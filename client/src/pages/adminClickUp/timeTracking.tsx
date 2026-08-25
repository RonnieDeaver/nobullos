// ClickUp admin — running timer, time reports, time-in-status, per-user estimates.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Clock, Filter, History, Loader2, Plus, Square, Tag, Trash2, X } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { Space, Task, TimeEntry, TimeEntryTag, TimeInStatusEntry, Workspace } from "./types";
import { PlanLimitedNotice } from "./lib";

// ─── Running-timer widget ─────────────────────────────────────────────────────
//
// Displayed in the module header when a workspace is selected and a timer is
// currently running.  Polls every 10 seconds; counts up in real time.

export function RunningTimerWidget({ workspaceId }: { workspaceId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [elapsed, setElapsed] = useState(0);

  const { data } = useQuery<{ running: any }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "timer/current"],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/timer/current`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
    refetchInterval: 10_000,
  });

  const running = data?.running;
  const startMs = running ? Number(running.start) : null;

  useEffect(() => {
    if (!startMs) { setElapsed(0); return; }
    const tick = () => setElapsed(Date.now() - startMs);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startMs]);

  const stopMut = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/clickup/workspaces/${workspaceId}/timer/stop`, {}).then((r) =>
        r.json(),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/workspaces", workspaceId, "timer/current"] }); // fire-and-forget: cache refresh only
      toast({ title: "Timer stopped" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to stop timer", description: e.message, variant: "destructive" }),
  });

  if (!running) return null;

  const h = Math.floor(elapsed / 3_600_000);
  const m = Math.floor((elapsed % 3_600_000) / 60_000);
  const s = Math.floor((elapsed % 60_000) / 1000);
  const elapsedStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  const taskName = running.task?.name ?? "Timer";

  return (
    <div
      className="flex items-center gap-2 rounded-full bg-green-50 border border-green-200 px-3 py-1 text-xs text-green-800"
      data-testid="widget-running-timer"
    >
      <Clock className="w-3 h-3 animate-pulse text-green-600" />
      <span className="truncate max-w-[140px]" data-testid="text-timer-task">{taskName}</span>
      <span className="font-mono font-medium" data-testid="text-timer-elapsed">{elapsedStr}</span>
      <button
        className="ml-1 hover:text-red-600 disabled:opacity-40"
        onClick={() => stopMut.mutate()}
        disabled={stopMut.isPending}
        data-testid="button-widget-stop-timer"
      >
        {stopMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
      </button>
    </div>
  );
}

// ─── Time Reports panel ───────────────────────────────────────────────────────
//
// Workspace-level time report with date-range, person, location, and tag filters.
// Supports editing/deleting entries inline.  Creating entries not tied to a task
// is a Business Plus feature; the form shows a plan notice if the API rejects it.

export type EntryFilters = {
  startDate: string;
  endDate: string;
  assignee: string;
  spaceId: string;
  listId: string;
  taskId: string;
  tags: string;
};

export function defaultFilters(): EntryFilters {
  const today = new Date();
  const monthAgo = new Date(today);
  monthAgo.setDate(today.getDate() - 30);
  return {
    startDate: monthAgo.toISOString().slice(0, 10),
    endDate: today.toISOString().slice(0, 10),
    assignee: "",
    spaceId: "",
    listId: "",
    taskId: "",
    tags: "",
  };
}

export function fmtDuration(ms: number): string {
  if (!ms) return "0m";
  const absMs = Math.abs(ms);
  const h = Math.floor(absMs / 3_600_000);
  const m = Math.floor((absMs % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function TimeReportsPanel({ workspaceId }: { workspaceId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<EntryFilters>(defaultFilters);
  const [applied, setApplied] = useState<EntryFilters>(defaultFilters);
  const [editEntry, setEditEntry] = useState<TimeEntry | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editDurMin, setEditDurMin] = useState("");
  const [newEntryOpen, setNewEntryOpen] = useState(false);
  const [newDesc, setNewDesc] = useState("");
  const [newDurMin, setNewDurMin] = useState("60");
  const [newTaskId, setNewTaskId] = useState("");
  const [newStart, setNewStart] = useState(() => new Date().toISOString().slice(0, 16));
  const [historyEntryId, setHistoryEntryId] = useState<string | null>(null);

  const buildQs = (f: EntryFilters) => {
    const p = new URLSearchParams();
    if (f.startDate) p.set("start_date", String(new Date(f.startDate).getTime()));
    if (f.endDate) {
      const end = new Date(f.endDate);
      end.setHours(23, 59, 59, 999);
      p.set("end_date", String(end.getTime()));
    }
    if (f.assignee) p.set("assignee", f.assignee);
    if (f.taskId) p.set("task_id", f.taskId);
    else if (f.listId) p.set("list_id", f.listId);
    else if (f.spaceId) p.set("space_id", f.spaceId);
    if (f.tags) p.set("tags", f.tags);
    p.set("include_location_names", "true");
    return p.toString();
  };

  const entriesQuery = useQuery<{ entries: TimeEntry[]; plan_limited?: boolean; message?: string }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "time-entries", applied],
    queryFn: () =>
      fetch(
        `/api/clickup/workspaces/${workspaceId}/time-entries?${buildQs(applied)}`,
        { credentials: "include" },
      ).then((r) => r.json()),
  });

  const tagsQuery = useQuery<{ tags: TimeEntryTag[] }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "time-entry-tags"],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/time-entry-tags`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
  });

  const historyQuery = useQuery<{ history: any[] }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "time-entries", historyEntryId, "history"],
    queryFn: () =>
      fetch(
        `/api/clickup/workspaces/${workspaceId}/time-entries/${historyEntryId}/history`,
        { credentials: "include" },
      ).then((r) => r.json()),
    enabled: !!historyEntryId,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      apiRequest("DELETE", `/api/clickup/workspaces/${workspaceId}/time-entries/${id}`, {}).then(
        (r) => r.json(),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/workspaces", workspaceId, "time-entries"] }); // fire-and-forget: cache refresh only
      toast({ title: "Entry deleted" });
    },
    onError: (e: any) =>
      toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const editMut = useMutation({
    mutationFn: (entry: TimeEntry) =>
      apiRequest("PUT", `/api/clickup/workspaces/${workspaceId}/time-entries/${entry.id}`, {
        description: editDesc,
        duration: Number(editDurMin) * 60_000,
      }).then((r) => r.json()),
    onSuccess: () => {
      setEditEntry(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/workspaces", workspaceId, "time-entries"] }); // fire-and-forget: cache refresh only
      toast({ title: "Entry updated" });
    },
    onError: (e: any) =>
      toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const createMut = useMutation({
    mutationFn: () => {
      const startMs = new Date(newStart).getTime();
      const durationMs = Number(newDurMin) * 60_000;
      return apiRequest("POST", `/api/clickup/workspaces/${workspaceId}/time-entries`, {
        description: newDesc,
        start: startMs,
        duration: durationMs,
        ...(newTaskId ? { tid: newTaskId } : {}),
      }).then((r) => r.json());
    },
    onSuccess: (data: any) => {
      if (data?.plan_limited) return;
      setNewEntryOpen(false);
      setNewDesc("");
      setNewDurMin("60");
      setNewTaskId("");
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/workspaces", workspaceId, "time-entries"] }); // fire-and-forget: cache refresh only
      toast({ title: "Entry created" });
    },
    onError: (e: any) =>
      toast({ title: "Create failed", description: e.message, variant: "destructive" }),
  });

  const entries = Array.isArray(entriesQuery.data?.entries) ? entriesQuery.data!.entries : [];
  const planLimited = (entriesQuery.data as any)?.plan_limited;
  const availableTags = tagsQuery.data?.tags ?? [];

  const totalMs = entries.filter((e) => e.duration > 0).reduce((acc, e) => acc + e.duration, 0);

  const byPerson = new Map<string, number>();
  const byDay = new Map<string, number>();
  for (const e of entries) {
    if (e.duration <= 0) continue;
    const name = e.user.username;
    byPerson.set(name, (byPerson.get(name) ?? 0) + e.duration);
    const day = e.start ? new Date(e.start).toLocaleDateString() : "Unknown";
    byDay.set(day, (byDay.get(day) ?? 0) + e.duration);
  }

  return (
    <div className="space-y-4" data-testid="panel-time-reports">
      {/* Filters */}
      <div className="bg-card border rounded-lg p-3 space-y-3">
        <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Filter className="w-3.5 h-3.5" /> Filters
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <div>
            <Label className="text-[10px] text-muted-foreground">Start date</Label>
            <input
              type="date"
              className="w-full text-xs border rounded px-2 py-1 mt-0.5"
              value={filters.startDate}
              onChange={(e) => setFilters((f) => ({ ...f, startDate: e.target.value }))}
              data-testid="input-report-start-date"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">End date</Label>
            <input
              type="date"
              className="w-full text-xs border rounded px-2 py-1 mt-0.5"
              value={filters.endDate}
              onChange={(e) => setFilters((f) => ({ ...f, endDate: e.target.value }))}
              data-testid="input-report-end-date"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Tags (comma-separated)</Label>
            <Input
              className="text-xs h-7 mt-0.5"
              placeholder="design, dev…"
              value={filters.tags}
              onChange={(e) => setFilters((f) => ({ ...f, tags: e.target.value }))}
              data-testid="input-report-tags"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Space ID</Label>
            <Input
              className="text-xs h-7 mt-0.5"
              placeholder="(location filter)"
              value={filters.spaceId}
              onChange={(e) => setFilters((f) => ({ ...f, spaceId: e.target.value, listId: "", taskId: "" }))}
              data-testid="input-report-space-id"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">List ID</Label>
            <Input
              className="text-xs h-7 mt-0.5"
              placeholder="(overrides space)"
              value={filters.listId}
              onChange={(e) => setFilters((f) => ({ ...f, listId: e.target.value, spaceId: "", taskId: "" }))}
              data-testid="input-report-list-id"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Task ID</Label>
            <Input
              className="text-xs h-7 mt-0.5"
              placeholder="(overrides list)"
              value={filters.taskId}
              onChange={(e) => setFilters((f) => ({ ...f, taskId: e.target.value, spaceId: "", listId: "" }))}
              data-testid="input-report-task-id"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="text-xs"
            onClick={() => setApplied({ ...filters })}
            data-testid="button-apply-report-filters"
          >
            Apply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-xs"
            onClick={() => {
              const d = defaultFilters();
              setFilters(d);
              setApplied(d);
            }}
            data-testid="button-reset-report-filters"
          >
            Reset
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-xs ml-auto"
            onClick={() => setNewEntryOpen(true)}
            data-testid="button-new-time-entry"
          >
            <Plus className="w-3 h-3 mr-1" /> New entry
          </Button>
        </div>
      </div>

      {planLimited && <PlanLimitedNotice message={(entriesQuery.data as any)?.message} />}

      {/* Available tags */}
      {availableTags.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap" data-testid="list-workspace-tags">
          <Tag className="w-3 h-3 text-muted-foreground" />
          {availableTags.map((t) => (
            <button
              key={t.name}
              className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-muted/50 hover:bg-purple-50 hover:border-purple-200 text-muted-foreground"
              onClick={() => {
                const cur = filters.tags ? filters.tags.split(",").map((s) => s.trim()) : [];
                if (!cur.includes(t.name)) {
                  const next = [...cur, t.name].join(", ");
                  setFilters((f) => ({ ...f, tags: next }));
                }
              }}
              data-testid={`tag-chip-${t.name}`}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {/* Loading / empty */}
      {entriesQuery.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading entries…
        </div>
      ) : entries.length === 0 && !planLimited ? (
        <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2" data-testid="text-no-entries">
          <Clock className="w-6 h-6" />
          <p className="text-xs">No time entries for this date range and filters</p>
        </div>
      ) : (
        <>
          {/* Summary: total + by-person */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-card border rounded p-3" data-testid="card-total-time">
              <p className="text-[10px] text-muted-foreground mb-0.5">Total logged</p>
              <p className="text-base font-semibold text-foreground">{fmtDuration(totalMs)}</p>
            </div>
            <div className="bg-card border rounded p-3" data-testid="card-by-person">
              <p className="text-[10px] text-muted-foreground mb-1">By person</p>
              <div className="space-y-0.5">
                {Array.from(byPerson.entries())
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5)
                  .map(([name, ms]) => (
                    <div key={name} className="flex justify-between text-xs">
                      <span className="text-foreground truncate">{name}</span>
                      <span className="text-muted-foreground ml-2 flex-shrink-0">{fmtDuration(ms)}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          {/* Entries table */}
          <div className="overflow-x-auto border rounded bg-card" data-testid="table-time-entries">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Person</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Task</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Description</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Tags</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Duration</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.id}
                    className="border-b last:border-0 hover:bg-muted/50"
                    data-testid={`entry-row-${e.id}`}
                  >
                    <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                      {e.start ? new Date(e.start).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-foreground">{e.user.username}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[100px]">
                      {e.task?.name ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground max-w-[120px] truncate">
                      {e.description || "—"}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex gap-0.5 flex-wrap">
                        {(e.tags ?? []).map((t) => (
                          <span
                            key={t.name}
                            className="text-[9px] px-1 rounded bg-purple-100 text-purple-700"
                            data-testid={`entry-tag-${e.id}-${t.name}`}
                          >
                            {t.name}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right font-medium text-foreground whitespace-nowrap">
                      {e.duration < 0 ? (
                        <span className="text-green-600 animate-pulse">running</span>
                      ) : (
                        fmtDuration(e.duration)
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex gap-1 justify-end">
                        <button
                          className="text-muted-foreground hover:text-blue-500"
                          onClick={() => {
                            setEditEntry(e);
                            setEditDesc(e.description);
                            setEditDurMin(String(Math.round(e.duration / 60_000)));
                          }}
                          data-testid={`button-edit-entry-${e.id}`}
                        >
                          <Clock className="w-3 h-3" />
                        </button>
                        <button
                          className="text-muted-foreground hover:text-purple-500"
                          onClick={() => setHistoryEntryId(historyEntryId === e.id ? null : e.id)}
                          data-testid={`button-history-entry-${e.id}`}
                        >
                          <History className="w-3 h-3" />
                        </button>
                        <button
                          className="text-muted-foreground hover:text-red-500"
                          onClick={() => deleteMut.mutate(e.id)}
                          disabled={deleteMut.isPending}
                          data-testid={`button-delete-entry-${e.id}`}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Edit entry dialog */}
      <Dialog open={!!editEntry} onOpenChange={(o) => !o && setEditEntry(null)}>
        <DialogContent className="max-w-sm" data-testid="dialog-edit-entry">
          <DialogHeader>
            <DialogTitle className="text-sm">Edit time entry</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Description</Label>
              <Input
                className="text-xs h-8 mt-1"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                data-testid="input-edit-description"
              />
            </div>
            <div>
              <Label className="text-xs">Duration (minutes)</Label>
              <Input
                type="number"
                min="1"
                className="text-xs h-8 mt-1"
                value={editDurMin}
                onChange={(e) => setEditDurMin(e.target.value)}
                data-testid="input-edit-duration"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditEntry(null)} data-testid="button-cancel-edit-entry">Cancel</Button>
            <Button
              size="sm"
              onClick={() => editEntry && editMut.mutate(editEntry)}
              disabled={editMut.isPending}
              data-testid="button-save-edit-entry"
            >
              {editMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New entry dialog */}
      <Dialog open={newEntryOpen} onOpenChange={setNewEntryOpen}>
        <DialogContent className="max-w-sm" data-testid="dialog-new-entry">
          <DialogHeader>
            <DialogTitle className="text-sm">New time entry</DialogTitle>
            <DialogDescription className="text-xs">
              Entries not tied to a task require a Business Plus plan.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Start date/time</Label>
              <input
                type="datetime-local"
                className="w-full text-xs border rounded px-2 py-1 mt-1"
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
                data-testid="input-new-entry-start"
              />
            </div>
            <div>
              <Label className="text-xs">Duration (minutes)</Label>
              <Input
                type="number"
                min="1"
                className="text-xs h-8 mt-1"
                value={newDurMin}
                onChange={(e) => setNewDurMin(e.target.value)}
                data-testid="input-new-entry-duration"
              />
            </div>
            <div>
              <Label className="text-xs">Task ID (optional)</Label>
              <Input
                className="text-xs h-8 mt-1"
                placeholder="Leave blank for task-free entry (Business Plus)"
                value={newTaskId}
                onChange={(e) => setNewTaskId(e.target.value)}
                data-testid="input-new-entry-task-id"
              />
            </div>
            <div>
              <Label className="text-xs">Description</Label>
              <Input
                className="text-xs h-8 mt-1"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                data-testid="input-new-entry-description"
              />
            </div>
            {(createMut.data as any)?.plan_limited && (
              <PlanLimitedNotice message={(createMut.data as any)?.message} />
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setNewEntryOpen(false)} data-testid="button-cancel-new-entry">Cancel</Button>
            <Button
              size="sm"
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
              data-testid="button-save-new-entry"
            >
              {createMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Entry history panel */}
      {historyEntryId && (
        <div className="bg-card border rounded p-3 space-y-2" data-testid="panel-entry-history">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-foreground flex items-center gap-1">
              <History className="w-3 h-3" /> Entry history
            </p>
            <button
              className="text-muted-foreground hover:text-muted-foreground"
              onClick={() => setHistoryEntryId(null)}
              data-testid="button-close-history"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          {historyQuery.isLoading ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading history…
            </div>
          ) : (historyQuery.data?.history ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No history for this entry</p>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {(historyQuery.data?.history ?? []).map((h: any, i: number) => (
                <div key={i} className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1" data-testid={`history-row-${i}`}>
                  <span className="text-muted-foreground">{h.date ? new Date(Number(h.date)).toLocaleString() : "—"}</span>
                  {" · "}
                  <span>{h.user?.username ?? "system"}</span>
                  {" · "}
                  <span>{h.field ?? ""} {h.before !== undefined ? `${h.before} → ${h.after}` : ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Task insights: time-in-status ────────────────────────────────────────────

export function TimeInStatusPanel({ taskId }: { taskId: string }) {
  const { data, isLoading, error } = useQuery<{
    current_status?: TimeInStatusEntry;
    status_history?: TimeInStatusEntry[];
    plan_limited?: boolean;
    message?: string;
  }>({
    queryKey: ["/api/clickup/tasks", taskId, "time-in-status"],
    queryFn: () =>
      fetch(`/api/clickup/tasks/${taskId}/time-in-status`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground py-4 justify-center">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading…
      </div>
    );
  }
  if ((data as any)?.plan_limited) {
    return <PlanLimitedNotice message={(data as any).message} />;
  }
  if (error || !data) {
    return <p className="text-xs text-muted-foreground italic" data-testid="text-tis-error">Could not load time-in-status data.</p>;
  }

  const rows: TimeInStatusEntry[] = data.status_history ?? [];
  const cur = data.current_status;

  return (
    <div className="space-y-2" data-testid="panel-time-in-status">
      {cur && (
        <div className="flex items-center gap-2 text-xs bg-blue-50 border border-blue-100 rounded px-3 py-1.5" data-testid="row-current-status">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: cur.color || "#94a3b8" }} />
          <span className="font-medium text-foreground">{cur.status}</span>
          <span className="text-muted-foreground ml-auto">{cur.total_time.by_minute} min (current)</span>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No status history available</p>
      ) : (
        <div className="overflow-hidden border rounded">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Status</th>
                <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Time spent</th>
                <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Since</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b last:border-0" data-testid={`tis-row-${i}`}>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: row.color || "#94a3b8" }} />
                      {row.status}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right text-muted-foreground">
                    {row.total_time.by_minute >= 60
                      ? `${Math.floor(row.total_time.by_minute / 60)}h ${row.total_time.by_minute % 60}m`
                      : `${row.total_time.by_minute}m`}
                  </td>
                  <td className="px-3 py-1.5 text-right text-muted-foreground">
                    {row.total_time.since
                      ? new Date(row.total_time.since).toLocaleDateString()
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Per-user estimate form (Business plan+) ──────────────────────────────────

export function TaskUserEstimateForm({ taskId }: { taskId: string }) {
  const { toast } = useToast();
  const [userId, setUserId] = useState("");
  const [durMin, setDurMin] = useState("60");
  const [planNotice, setPlanNotice] = useState<string | null>(null);

  const updateMut = useMutation({
    mutationFn: async () => {
      if (!userId.trim()) throw new Error("ClickUp user ID required");
      const res = await apiRequest(
        "PUT",
        `/api/clickup/tasks/${taskId}/time-estimates/user/${encodeURIComponent(userId.trim())}`,
        { estimates: [{ duration: Number(durMin) * 60_000 }] },
      );
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data?.plan_limited) {
        setPlanNotice(data.message ?? null);
        return;
      }
      setPlanNotice(null);
      setUserId("");
      setDurMin("60");
      toast({ title: "Estimate updated" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to update estimate", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-2" data-testid="form-user-estimate">
      {planNotice && <PlanLimitedNotice message={planNotice} />}
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <Label className="text-[10px] text-muted-foreground">ClickUp user ID</Label>
          <Input
            className="text-xs h-7 mt-0.5"
            placeholder="e.g. 12345678"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            data-testid="input-estimate-user-id"
          />
        </div>
        <div className="w-24">
          <Label className="text-[10px] text-muted-foreground">Minutes</Label>
          <Input
            type="number"
            min="1"
            className="text-xs h-7 mt-0.5"
            value={durMin}
            onChange={(e) => setDurMin(e.target.value)}
            data-testid="input-estimate-duration"
          />
        </div>
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => updateMut.mutate()}
          disabled={updateMut.isPending || !userId.trim()}
          data-testid="button-save-estimate"
        >
          {updateMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Set"}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Sets the time estimate for a specific assignee. Requires Business plan+.
      </p>
    </div>
  );
}

