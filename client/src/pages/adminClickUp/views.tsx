// ClickUp admin — saved views panel + board/table/calendar/list renderers.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  LayoutGrid,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import type { Folder, Space, Task, Workspace } from "./types";
import { fmtDate, priorityLabel, statusColor } from "./lib";
import { TaskDetailDialog } from "./taskDetail";

// ─── Views panel ─────────────────────────────────────────────────────────────
//
// View types natively rendered: list, board, table, calendar
// Unsupported (deep-link to ClickUp): timeline, workload, gantt, map, activity, chat
// List views (GetListViews) return both `views` and `required_views` — both shown.

export type CUView = {
  id: string;
  name: string;
  type: string;
  url?: string;
  grouping?: { field?: string; dir?: number };
  sorting?: { fields?: Array<{ field: string; idx?: number }> };
  filters?: { show_closed?: boolean; assignees?: any[]; fields?: any[] };
  columns?: { fields?: any[] };
  settings?: any;
};

export const NATIVE_VIEW_TYPES = ["list", "board", "table", "calendar"];

export function viewTypeLabel(type: string): string {
  return (
    ({
      list: "List", board: "Board", calendar: "Calendar", table: "Table",
      timeline: "Timeline", workload: "Workload", gantt: "Gantt",
      map: "Map", activity: "Activity", chat: "Chat",
    } as Record<string, string>)[type] ?? type
  );
}

export function viewTypeColor(type: string): string {
  if (type === "board") return "bg-purple-100 text-purple-700";
  if (type === "table") return "bg-green-100 text-green-700";
  if (type === "calendar") return "bg-orange-100 text-orange-700";
  if (type === "list") return "bg-blue-100 text-blue-700";
  return "bg-muted text-muted-foreground";
}

export function useViewTasks(viewId: string | null) {
  const [page, setPage] = useState(0);
  const [allTasks, setAllTasks] = useState<Task[]>([]);

  const { data, isLoading, isFetching } = useQuery<{ tasks: Task[]; last_page: boolean }>({
    queryKey: ["clickup-view-tasks", viewId, page],
    queryFn: async () => {
      const res = await fetch(`/api/clickup/views/${viewId}/tasks?page=${page}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed to load view tasks (${res.status})`);
      return res.json();
    },
    enabled: !!viewId,
  });

  useEffect(() => {
    if (page === 0) setAllTasks(data?.tasks ?? []);
    else setAllTasks((prev) => [...prev, ...(data?.tasks ?? [])]);
  }, [data, page]);

  useEffect(() => {
    setPage(0);
    setAllTasks([]);
  }, [viewId]);

  return {
    tasks: allTasks,
    isLoading,
    isFetching,
    lastPage: data?.last_page ?? true,
    loadMore: () => setPage((p) => p + 1),
    page,
  };
}

export function ViewBoardRenderer({
  tasks,
  workspaceId,
}: {
  tasks: Task[];
  workspaceId: string;
}) {
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const groups = new Map<string, { tasks: Task[] }>();
  for (const task of tasks) {
    const key = task.status?.status ?? "No Status";
    if (!groups.has(key)) groups.set(key, { tasks: [] });
    groups.get(key)!.tasks.push(task);
  }

  if (groups.size === 0) {
    return <p className="text-xs text-muted-foreground italic">No tasks in this view</p>;
  }

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-2" data-testid="view-board-renderer">
        {Array.from(groups.entries()).map(([status, { tasks: gt }]) => (
          <div key={status} className="flex-shrink-0 w-56 space-y-1" data-testid={`board-column-${status}`}>
            <div className="flex items-center gap-1.5 px-2 py-1">
              <span className="text-xs font-medium text-foreground">{status}</span>
              <Badge variant="outline" className="text-[10px] px-1">{gt.length}</Badge>
            </div>
            <div className="space-y-1.5">
              {gt.map((task) => (
                <div
                  key={task.id}
                  className="bg-card border rounded p-2 cursor-pointer hover:border-purple-300 transition-colors"
                  onClick={() => setSelectedTask(task)}
                  data-testid={`board-card-${task.id}`}
                >
                  <p className="text-xs text-foreground line-clamp-2">{task.name}</p>
                  {task.due_date && (
                    <p className="text-[10px] text-muted-foreground mt-1">{fmtDate(task.due_date)}</p>
                  )}
                  {task.assignees?.length ? (
                    <div className="flex gap-0.5 mt-1">
                      {task.assignees.slice(0, 3).map((a, i) => (
                        <span key={i} className="text-[9px] bg-purple-100 text-purple-700 px-1 rounded">
                          {a.username.slice(0, 2).toUpperCase()}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <TaskDetailDialog task={selectedTask} workspaceId={workspaceId} spaceId={null} onClose={() => setSelectedTask(null)} />
    </>
  );
}

export function ViewTableRenderer({
  tasks,
  workspaceId,
}: {
  tasks: Task[];
  workspaceId: string;
}) {
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  if (tasks.length === 0) {
    return <p className="text-xs text-muted-foreground italic">No tasks in this view</p>;
  }

  return (
    <>
      <div className="os-table-wrap" data-testid="view-table-renderer">
        <table className="w-full text-xs os-sticky-col">
          <thead>
            <tr className="bg-muted/50 border-b">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Name</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Priority</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Assignee</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Due</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr
                key={task.id}
                className="border-b last:border-0 hover:bg-muted/50 cursor-pointer"
                onClick={() => setSelectedTask(task)}
                data-testid={`table-row-${task.id}`}
              >
                <td className="px-3 py-1.5 max-w-[200px] truncate text-foreground">{task.name}</td>
                <td className="px-3 py-1.5">
                  {task.status && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusColor(task.status)}`}>
                      {task.status.status}
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">{priorityLabel(task.priority)}</td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {task.assignees?.map((a) => a.username).join(", ") || "—"}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">{fmtDate(task.due_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TaskDetailDialog task={selectedTask} workspaceId={workspaceId} spaceId={null} onClose={() => setSelectedTask(null)} />
    </>
  );
}

export function ViewCalendarRenderer({
  tasks,
  workspaceId,
}: {
  tasks: Task[];
  workspaceId: string;
}) {
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [monthOffset, setMonthOffset] = useState(0);

  const today = new Date();
  const viewDate = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfWeek = new Date(year, month, 1).getDay();

  const tasksByDay = new Map<number, Task[]>();
  for (const task of tasks) {
    if (!task.due_date) continue;
    const d = new Date(Number(task.due_date));
    if (d.getFullYear() === year && d.getMonth() === month) {
      const day = d.getDate();
      if (!tasksByDay.has(day)) tasksByDay.set(day, []);
      tasksByDay.get(day)!.push(task);
    }
  }

  const monthName = viewDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const cells: Array<{ day: number | null }> = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push({ day: null });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d });

  return (
    <div className="space-y-2" data-testid="view-calendar-renderer">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setMonthOffset((m) => m - 1)}
          className="p-1 rounded hover:bg-muted"
          data-testid="button-cal-prev-month"
        >
          <ChevronLeft className="w-4 h-4 text-muted-foreground" />
        </button>
        <span className="text-sm font-medium text-foreground">{monthName}</span>
        <button
          onClick={() => setMonthOffset((m) => m + 1)}
          className="p-1 rounded hover:bg-muted"
          data-testid="button-cal-next-month"
        >
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>
      {/* 7-column month grid keeps its shape at all widths and scrolls
          horizontally inside this wrapper on narrow screens
          (mobile-grid-keep opts out of the global mobile grid stacking). */}
      <div className="overflow-x-auto">
        <div className="min-w-[560px]">
      <div className="mobile-grid-keep grid grid-cols-7 text-center">
        {DAY_NAMES.map((dn) => (
          <div key={dn} className="text-[10px] text-muted-foreground font-medium py-1">
            {dn}
          </div>
        ))}
      </div>
      <div className="mobile-grid-keep grid grid-cols-7 gap-px bg-muted border rounded overflow-hidden">
        {cells.map((cell, i) => {
          const isToday =
            cell.day === today.getDate() &&
            month === today.getMonth() &&
            year === today.getFullYear();
          const dayTasks = cell.day ? (tasksByDay.get(cell.day) ?? []) : [];
          return (
            <div
              key={i}
              className={`bg-card min-h-[60px] p-1 ${!cell.day ? "bg-muted/50" : ""}`}
              data-testid={cell.day ? `cal-day-${cell.day}` : undefined}
            >
              {cell.day && (
                <>
                  <div className={`text-[10px] font-medium mb-0.5 ${isToday ? "text-purple-600 font-bold" : "text-muted-foreground"}`}>
                    {cell.day}
                  </div>
                  {dayTasks.slice(0, 2).map((task) => (
                    <button
                      key={task.id}
                      className="w-full text-left text-[9px] bg-purple-100 text-purple-700 rounded px-1 py-0.5 mb-0.5 truncate hover:bg-purple-200"
                      onClick={() => setSelectedTask(task)}
                      data-testid={`cal-task-${task.id}`}
                    >
                      {task.name}
                    </button>
                  ))}
                  {dayTasks.length > 2 && (
                    <span className="text-[9px] text-muted-foreground">+{dayTasks.length - 2}</span>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
        </div>
      </div>
      <TaskDetailDialog task={selectedTask} workspaceId={workspaceId} spaceId={null} onClose={() => setSelectedTask(null)} />
    </div>
  );
}

export function ViewListRenderer({
  tasks,
  workspaceId,
  lastPage,
  loadMore,
  isFetching,
  page,
}: {
  tasks: Task[];
  workspaceId: string;
  lastPage: boolean;
  loadMore(): void;
  isFetching: boolean;
  page: number;
}) {
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  if (tasks.length === 0 && !isFetching) {
    return <p className="text-xs text-muted-foreground italic">No tasks in this view</p>;
  }

  return (
    <div className="space-y-1.5" data-testid="view-list-renderer">
      {tasks.map((task) => (
        <div
          key={task.id}
          className="flex items-center gap-2 bg-card border rounded px-3 py-2 hover:bg-muted/50 cursor-pointer"
          onClick={() => setSelectedTask(task)}
          data-testid={`view-task-row-${task.id}`}
        >
          <CheckCircle className={`w-4 h-4 flex-shrink-0 ${task.status?.type === "done" ? "text-green-500" : "text-gray-300"}`} />
          <span className="text-sm text-foreground flex-1 truncate">{task.name}</span>
          {task.status && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusColor(task.status)}`}>
              {task.status.status}
            </span>
          )}
          {task.priority && (
            <span className="text-[10px] text-muted-foreground">{priorityLabel(task.priority)}</span>
          )}
          {task.due_date && (
            <span className="text-[10px] text-muted-foreground">{fmtDate(task.due_date)}</span>
          )}
        </div>
      ))}
      {!lastPage && !isFetching && (
        <Button
          size="sm"
          variant="outline"
          className="w-full text-xs"
          onClick={loadMore}
          data-testid="button-view-load-more"
        >
          Load more
        </Button>
      )}
      {isFetching && page > 0 && (
        <div className="flex justify-center py-2">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      )}
      <TaskDetailDialog task={selectedTask} workspaceId={workspaceId} spaceId={null} onClose={() => setSelectedTask(null)} />
    </div>
  );
}

export function ViewEditorDialog({
  open,
  onClose,
  editingView,
  onSave,
  isPending,
}: {
  open: boolean;
  onClose(): void;
  editingView: CUView | null;
  onSave(name: string, type: string): void;
  isPending: boolean;
}) {
  const isEdit = editingView != null;
  const [name, setName] = useState(editingView?.name ?? "");
  const [type, setType] = useState(editingView?.type ?? "list");

  useEffect(() => {
    setName(editingView?.name ?? "");
    setType(editingView?.type ?? "list");
  }, [editingView, open]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm" data-testid="dialog-view-editor">
        <DialogHeader>
          <DialogTitle className="text-sm">{isEdit ? "Rename view" : "Create view"}</DialogTitle>
          <DialogDescription className="text-xs">
            {isEdit ? "Update the name of this view." : "Add a new saved view to this location."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="View name…"
              className="text-xs h-8"
              data-testid="input-view-name"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) onSave(name.trim(), type);
              }}
            />
          </div>
          {!isEdit && (
            <div className="space-y-1">
              <Label className="text-xs">Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-view-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["list", "board", "calendar", "table"].map((t) => (
                    <SelectItem key={t} value={t} className="text-xs capitalize">
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} data-testid="button-cancel-view-editor">
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={isPending || !name.trim()}
            onClick={() => onSave(name.trim(), type)}
            data-testid="button-save-view"
          >
            {isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ViewsPanel({
  workspaceId,
  spaceId,
  folderId,
  listId,
}: {
  workspaceId: string;
  spaceId: string | null;
  folderId: string | null;
  listId: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingView, setEditingView] = useState<CUView | null>(null);

  const locationKey = listId ? "list" : folderId ? "folder" : spaceId ? "space" : "workspace";
  const locationId = listId ?? folderId ?? spaceId ?? workspaceId;
  const viewsQueryKey = ["clickup-views", locationKey, locationId];
  const viewsUrl = listId
    ? `/api/clickup/lists/${listId}/views`
    : folderId
    ? `/api/clickup/folders/${folderId}/views`
    : spaceId
    ? `/api/clickup/spaces/${spaceId}/views`
    : `/api/clickup/workspaces/${workspaceId}/views`;
  const createUrl = viewsUrl;

  const { data: viewsData, isLoading: viewsLoading, refetch: refetchViews } = useQuery<{
    views: CUView[];
    required_views?: CUView[];
  }>({
    queryKey: viewsQueryKey,
    queryFn: async () => {
      const res = await fetch(viewsUrl, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load views (${res.status})`);
      return res.json();
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    setSelectedViewId(null);
  }, [locationKey, locationId]);

  const allViews: CUView[] = [
    ...(viewsData?.views ?? []),
    ...(viewsData?.required_views ?? []),
  ];
  const selectedView = allViews.find((v) => v.id === selectedViewId) ?? null;

  const { tasks, isLoading: tasksLoading, isFetching: tasksFetching, lastPage, loadMore, page } =
    useViewTasks(selectedViewId);

  const saveMut = useMutation({
    mutationFn: async ({ name, type }: { name: string; type: string }) => {
      if (editingView) {
        const res = await fetch(`/api/clickup/views/${editingView.id}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error(`Rename failed (${res.status})`);
      } else {
        const res = await fetch(createUrl, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, type }),
        });
        if (!res.ok) throw new Error(`Create failed (${res.status})`);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: viewsQueryKey }); // fire-and-forget: cache refresh only
      void refetchViews(); // fire-and-forget: refetch only
      setEditorOpen(false);
      toast({ title: editingView ? "View renamed" : "View created" });
      setEditingView(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (viewId: string) => {
      const res = await fetch(`/api/clickup/views/${viewId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
    },
    onSuccess: (_, viewId) => {
      if (selectedViewId === viewId) setSelectedViewId(null);
      void queryClient.invalidateQueries({ queryKey: viewsQueryKey }); // fire-and-forget: cache refresh only
      void refetchViews(); // fire-and-forget: refetch only
      toast({ title: "View deleted" });
    },
    onError: (e: any) =>
      toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const locationLabel =
    listId ? "List" : folderId ? "Folder" : spaceId ? "Space" : "Workspace";

  return (
    <div className="space-y-4" data-testid="panel-views">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {locationLabel} views{allViews.length > 0 ? ` (${allViews.length})` : ""}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1"
          onClick={() => {
            setEditingView(null);
            setEditorOpen(true);
          }}
          data-testid="button-new-view"
        >
          <Plus className="w-3 h-3" /> New view
        </Button>
      </div>

      {viewsLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading views…
        </div>
      ) : allViews.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2"
          data-testid="text-no-views"
        >
          <LayoutGrid className="w-6 h-6" />
          <p className="text-xs">No views at this location yet</p>
          <p className="text-[11px] text-gray-300">
            Select a space, folder, or list, or create one above.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5" data-testid="view-picker">
          {allViews.map((view) => {
            const isSelected = selectedViewId === view.id;
            return (
              <div
                key={view.id}
                className="flex items-center"
                data-testid={`view-item-${view.id}`}
              >
                <button
                  onClick={() => setSelectedViewId(isSelected ? null : view.id)}
                  className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-l border transition-colors ${
                    isSelected
                      ? "bg-purple-600 text-white border-purple-600"
                      : "bg-card text-foreground border-border hover:border-purple-300"
                  }`}
                  data-testid={`button-view-${view.id}`}
                >
                  <span
                    className={`text-[9px] px-1 py-0.5 rounded font-medium ${
                      isSelected ? "bg-purple-500 text-white" : viewTypeColor(view.type)
                    }`}
                  >
                    {viewTypeLabel(view.type)}
                  </span>
                  <span className="max-w-[120px] truncate">{view.name}</span>
                </button>
                <div
                  className={`flex items-center border border-l-0 rounded-r overflow-hidden ${
                    isSelected ? "border-purple-600 bg-purple-600" : "border-border bg-card"
                  }`}
                >
                  <button
                    onClick={() => {
                      setEditingView(view);
                      setEditorOpen(true);
                    }}
                    className={`px-1.5 py-1.5 ${
                      isSelected
                        ? "text-white hover:bg-purple-500"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    }`}
                    title="Rename view"
                    data-testid={`button-rename-view-${view.id}`}
                  >
                    <FileText className="w-3 h-3" />
                  </button>
                  <ConfirmActionDialog
                    trigger={
                      <button
                        disabled={deleteMut.isPending}
                        className={`px-1.5 py-1.5 ${
                          isSelected
                            ? "text-white hover:bg-purple-500"
                            : "text-muted-foreground hover:text-red-500 hover:bg-muted/50"
                        }`}
                        title="Delete view"
                        data-testid={`button-delete-view-${view.id}`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    }
                    title={`Delete view "${view.name}"?`}
                    description="This deletes the saved view in ClickUp for everyone who uses it. Tasks are not affected. This cannot be undone."
                    confirmLabel="Delete view"
                    onConfirm={() => deleteMut.mutate(view.id)}
                    testId={`dialog-delete-view-${view.id}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedView && (
        <div className="mt-2 space-y-3" data-testid={`view-content-${selectedView.id}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{selectedView.name}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${viewTypeColor(selectedView.type)}`}>
                {viewTypeLabel(selectedView.type)}
              </span>
            </div>
            {selectedView.url && (
              <a
                href={selectedView.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-purple-600"
                data-testid="link-open-in-clickup"
              >
                <ExternalLink className="w-3 h-3" /> Open in ClickUp
              </a>
            )}
          </div>

          {!NATIVE_VIEW_TYPES.includes(selectedView.type) ? (
            <div
              className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-3"
              data-testid="view-unsupported"
            >
              <LayoutGrid className="w-8 h-8" />
              <p className="text-sm font-medium text-muted-foreground">
                {viewTypeLabel(selectedView.type)} views open in ClickUp
              </p>
              <p className="text-xs text-center max-w-xs text-muted-foreground">
                NoBull OS renders list, board, table, and calendar views natively.
                This view type must be opened in ClickUp.
              </p>
              {selectedView.url ? (
                <a
                  href={selectedView.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700"
                  data-testid="link-open-unsupported-view"
                >
                  <ExternalLink className="w-3 h-3" /> Open in ClickUp
                </a>
              ) : (
                <p className="text-xs text-gray-300 italic">No direct URL available for this view</p>
              )}
            </div>
          ) : tasksLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading tasks…
            </div>
          ) : selectedView.type === "board" ? (
            <ViewBoardRenderer tasks={tasks} workspaceId={workspaceId} />
          ) : selectedView.type === "table" ? (
            <ViewTableRenderer tasks={tasks} workspaceId={workspaceId} />
          ) : selectedView.type === "calendar" ? (
            <ViewCalendarRenderer tasks={tasks} workspaceId={workspaceId} />
          ) : (
            <ViewListRenderer
              tasks={tasks}
              workspaceId={workspaceId}
              lastPage={lastPage}
              loadMore={loadMore}
              isFetching={tasksFetching}
              page={page}
            />
          )}
        </div>
      )}

      <ViewEditorDialog
        open={editorOpen}
        onClose={() => {
          setEditorOpen(false);
          setEditingView(null);
        }}
        editingView={editingView}
        onSave={(name, type) => saveMut.mutate({ name, type })}
        isPending={saveMut.isPending}
      />
    </div>
  );
}

