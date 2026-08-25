// ClickUp admin — task detail dialog (details/subtasks/deps/links/watchers/files/…).
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BarChart2,
  CheckCircle,
  Clock,
  ExternalLink,
  FolderOpen,
  Loader2,
  MessageSquare,
  MoveHorizontal,
  Paperclip,
  Play,
  Plus,
  ArrowLeftCircle,
  ArrowRightCircle,
  GitMerge,
  Link2,
  Square,
  SlidersHorizontal,
  Users,
  X,
  Shield,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type {
  LinkedTask,
  SpaceTag,
  Task,
  TaskDependency,
  TimeEntry,
  Watcher,
  Workspace,
} from "./types";
import { fmtDate, fmtMs, isApplicableToTask, priorityLabel, statusColor } from "./lib";
import { CustomFieldsTab } from "./customFields";
import { TaskCommentsTab } from "./comments";
import { TaskUserEstimateForm, TimeInStatusPanel } from "./timeTracking";
import { AttachmentsTab } from "./attachments";
import { ListPicker, MergeDialog, TaskPicker } from "./pickers";
import { AccessPanel } from "./peopleSharing";

// ─── Task detail dialog ───────────────────────────────────────────────────────

export function TaskDetailDialog({
  task: initialTask,
  workspaceId,
  spaceId,
  onClose,
  listId,
  onTagsChanged,
}: {
  task: Task | null;
  workspaceId: string | null;
  spaceId: string | null;
  onClose(): void;
  listId?: string | null;
  onTagsChanged?(taskId: string, tags: Task["tags"]): void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [trackingActive, setTrackingActive] = useState(false);
  const [trackStart, setTrackStart] = useState<number | null>(null);
  const [newSubtaskName, setNewSubtaskName] = useState("");
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [timlPickerOpen, setTimlPickerOpen] = useState(false);

  const { data: fullTaskData } = useQuery<{ task: Task }>({
    queryKey: ["/api/clickup/tasks", initialTask?.id, "full"],
    queryFn: async () => {
      if (!initialTask?.id) return { task: initialTask! };
      const res = await fetch(`/api/clickup/tasks/${initialTask.id}/full`, { credentials: "include" });
      if (!res.ok) return { task: initialTask! };
      return res.json();
    },
    enabled: !!initialTask?.id,
    staleTime: 15_000,
  });

  const task: Task | null = fullTaskData?.task ?? initialTask;

  const [localTags, setLocalTags] = useState<Task["tags"]>(initialTask?.tags ?? []);
  const [showTagPicker, setShowTagPicker] = useState(false);

  const effectiveSpaceId = spaceId ?? task?.space?.id ?? null;

  const { data: spaceTags = [] } = useQuery<SpaceTag[]>({
    queryKey: ["/api/clickup/spaces", effectiveSpaceId, "tags"],
    queryFn: async () => {
      if (!effectiveSpaceId) return [];
      const res = await fetch(`/api/clickup/spaces/${effectiveSpaceId}/tags`, { credentials: "include" });
      if (!res.ok) return [];
      const d = await res.json();
      return d.tags ?? [];
    },
    enabled: !!effectiveSpaceId && showTagPicker,
  });

  const addTagMut = useMutation({
    mutationFn: async (tagName: string) => {
      if (!task?.id) throw new Error("No task");
      await apiRequest("POST", `/api/clickup/tasks/${task.id}/tags/${encodeURIComponent(tagName)}`, {});
    },
    onSuccess: (_data, tagName) => {
      const next = [...(localTags ?? [])];
      if (!next.some((t) => t.name === tagName)) {
        const spTag = spaceTags.find((st) => st.name === tagName);
        next.push({ name: tagName, tag_fg: spTag?.tag_fg, tag_bg: spTag?.tag_bg });
      }
      setLocalTags(next);
      onTagsChanged?.(task!.id, next);
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/lists"] }); // fire-and-forget: cache refresh only
    },
    onError: (e: any) =>
      toast({ title: "Failed to add tag", description: e.message, variant: "destructive" }),
  });

  const removeTagMut = useMutation({
    mutationFn: async (tagName: string) => {
      if (!task?.id) throw new Error("No task");
      await apiRequest("DELETE", `/api/clickup/tasks/${task.id}/tags/${encodeURIComponent(tagName)}`);
    },
    onSuccess: (_data, tagName) => {
      const next = (localTags ?? []).filter((t) => t.name !== tagName);
      setLocalTags(next);
      onTagsChanged?.(task!.id, next);
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/lists"] }); // fire-and-forget: cache refresh only
    },
    onError: (e: any) =>
      toast({ title: "Failed to remove tag", description: e.message, variant: "destructive" }),
  });

  // Note: comments are now managed inside TaskCommentsTab to support pagination + threads

  const { data: timeEntries = [] } = useQuery<TimeEntry[]>({
    queryKey: ["/api/clickup/tasks", task?.id, "time-entries"],
    queryFn: async () => {
      if (!task?.id || !workspaceId) return [];
      const res = await fetch(
        `/api/clickup/workspaces/${workspaceId}/time-entries?task_id=${task.id}`,
        { credentials: "include" },
      );
      if (!res.ok) return [];
      const d = await res.json();
      return d.data ?? [];
    },
    enabled: !!task?.id && !!workspaceId,
  });

  const invalidateFull = () =>
    queryClient.invalidateQueries({ queryKey: ["/api/clickup/tasks", task?.id, "full"] });

  const addSubtaskMut = useMutation({
    mutationFn: async () => {
      if (!task?.id || !newSubtaskName.trim()) throw new Error("Name required");
      const targetList = listId ?? (task as any).list?.id;
      if (!targetList) throw new Error("Cannot determine list for subtask");
      await apiRequest("POST", `/api/clickup/lists/${targetList}/tasks`, {
        name: newSubtaskName.trim(),
        parent: task.id,
      });
    },
    onSuccess: () => {
      setNewSubtaskName("");
      setAddingSubtask(false);
      void invalidateFull(); // fire-and-forget: cache refresh only
      toast({ title: "Subtask created" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to create subtask", description: e.message, variant: "destructive" }),
  });

  const addDepMut = useMutation({
    mutationFn: async ({ type, otherId }: { type: "depends_on" | "dependency_of"; otherId: string }) => {
      await apiRequest("POST", `/api/clickup/tasks/${task!.id}/dependencies`, { [type]: otherId });
    },
    onSuccess: () => { void invalidateFull(); toast({ title: "Dependency added" }); }, // fire-and-forget: cache refresh only
    onError: (e: any) =>
      toast({ title: "Failed to add dependency", description: e.message, variant: "destructive" }),
  });

  const removeDepMut = useMutation({
    mutationFn: async ({ type, otherId }: { type: "depends_on" | "dependency_of"; otherId: string }) => {
      await apiRequest("DELETE", `/api/clickup/tasks/${task!.id}/dependencies`, { [type]: otherId });
    },
    onSuccess: () => { void invalidateFull(); toast({ title: "Dependency removed" }); }, // fire-and-forget: cache refresh only
    onError: (e: any) =>
      toast({ title: "Failed to remove dependency", description: e.message, variant: "destructive" }),
  });

  const addLinkMut = useMutation({
    mutationFn: async (otherId: string) =>
      apiRequest("POST", `/api/clickup/tasks/${task!.id}/links/${otherId}`, {}),
    onSuccess: () => { void invalidateFull(); toast({ title: "Link added" }); }, // fire-and-forget: cache refresh only
    onError: (e: any) =>
      toast({ title: "Failed to add link", description: e.message, variant: "destructive" }),
  });

  const removeLinkMut = useMutation({
    mutationFn: async (otherId: string) =>
      apiRequest("DELETE", `/api/clickup/tasks/${task!.id}/links/${otherId}`, {}),
    onSuccess: () => { void invalidateFull(); toast({ title: "Link removed" }); }, // fire-and-forget: cache refresh only
    onError: (e: any) =>
      toast({ title: "Failed to remove link", description: e.message, variant: "destructive" }),
  });

  const removeWatcherMut = useMutation({
    mutationFn: async (userId: string) =>
      apiRequest("DELETE", `/api/clickup/tasks/${task!.id}/watchers/${userId}`, {}),
    onSuccess: () => { void invalidateFull(); toast({ title: "Watcher removed" }); }, // fire-and-forget: cache refresh only
    onError: (e: any) =>
      toast({ title: "Failed to remove watcher", description: e.message, variant: "destructive" }),
  });

  const addWatcherMut = useMutation({
    mutationFn: async (userId: string) =>
      apiRequest("POST", `/api/clickup/tasks/${task!.id}/watchers`, { add: [userId] }),
    onSuccess: () => { void invalidateFull(); toast({ title: "Watcher added" }); }, // fire-and-forget: cache refresh only
    onError: (e: any) =>
      toast({ title: "Failed to add watcher", description: e.message, variant: "destructive" }),
  });

  const moveTaskMut = useMutation({
    mutationFn: async ({ listId }: { listId: string }) => {
      const res = await fetch(`/api/clickup/tasks/${task!.id}/move`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Move failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setMoveOpen(false);
      void invalidateFull(); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["clickup-list"] }); // fire-and-forget: cache refresh only
      toast({ title: "Task moved" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to move task", description: e.message, variant: "destructive" }),
  });

  const addToListMut = useMutation({
    mutationFn: async ({ listId }: { listId: string }) => {
      const res = await fetch(`/api/clickup/tasks/${task!.id}/lists/${listId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (d.timl_disabled) throw Object.assign(new Error(d.error), { timl_disabled: true });
        throw new Error(d.error || `Add to list failed (${res.status})`);
      }
      return d;
    },
    onSuccess: () => {
      setTimlPickerOpen(false);
      void invalidateFull(); // fire-and-forget: cache refresh only
      toast({ title: "Task added to list" });
    },
    onError: (e: any) => {
      if ((e as any).timl_disabled) {
        toast({
          title: "Tasks in Multiple Lists not enabled",
          description: "Enable the Tasks in Multiple Lists ClickApp in your ClickUp workspace settings to add a task to additional lists.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Failed to add to list", description: e.message, variant: "destructive" });
      }
    },
  });

  const removeFromListMut = useMutation({
    mutationFn: async ({ listId }: { listId: string }) => {
      const res = await fetch(`/api/clickup/tasks/${task!.id}/lists/${listId}`, {
        method: "DELETE",
        credentials: "include",
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (d.timl_disabled) throw Object.assign(new Error(d.error), { timl_disabled: true });
        if (d.home_list) throw Object.assign(new Error(d.error), { home_list: true });
        throw new Error(d.error || `Remove from list failed (${res.status})`);
      }
      return d;
    },
    onSuccess: () => {
      void invalidateFull(); // fire-and-forget: cache refresh only
      toast({ title: "Removed from list" });
    },
    onError: (e: any) => {
      if ((e as any).home_list) {
        toast({
          title: "Cannot remove home list",
          description: "Move the task to a different list first, then remove it from this one.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Failed to remove from list", description: e.message, variant: "destructive" });
      }
    },
  });

  const startTracking = () => {
    setTrackStart(Date.now());
    setTrackingActive(true);
    toast({ title: "Timer started" });
  };

  const stopTracking = useMutation({
    mutationFn: async () => {
      if (!task?.id || !workspaceId || !trackStart) throw new Error("No timer running");
      const duration = Date.now() - trackStart;
      await apiRequest("POST", `/api/clickup/workspaces/${workspaceId}/time-entries`, {
        tid: task.id,
        start: trackStart,
        duration,
        description: "",
      });
    },
    onSuccess: () => {
      setTrackingActive(false);
      setTrackStart(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/tasks", task?.id, "time-entries"] }); // fire-and-forget: cache refresh only
      toast({ title: "Time logged" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to log time", description: e.message, variant: "destructive" }),
  });

  if (!task) return null;

  const subtasks: Task[] = task.subtasks ?? [];
  const deps: TaskDependency[] = task.dependencies ?? [];
  const waitingOn = deps.filter((d) => d.type !== "2");
  const blocking = deps.filter((d) => d.type === "2");
  const links: LinkedTask[] = task.linked_tasks ?? [];
  const watchers: Watcher[] = task.watchers ?? [];
  const totalMs = timeEntries.reduce((s, e) => s + (e.duration ?? 0), 0);

  return (
    <>
      <Dialog open={!!initialTask} key={task?.id} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-task-detail">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base flex-wrap">
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${statusColor(task.status)}`} data-testid="text-task-status">
                {task.status?.status ?? "—"}
              </span>
              <span data-testid="text-task-name" className="flex-1">{task.name}</span>
              <Button size="sm" variant="ghost" className="text-xs text-gray-400 hover:text-blue-700"
                onClick={() => setMoveOpen(true)} data-testid="button-open-move">
                <MoveHorizontal className="w-3 h-3 mr-1" /> Move
              </Button>
              <Button size="sm" variant="ghost" className="text-xs text-gray-400 hover:text-amber-700"
                onClick={() => setMergeOpen(true)} data-testid="button-open-merge">
                <GitMerge className="w-3 h-3 mr-1" /> Merge
              </Button>
            </DialogTitle>
            <DialogDescription className="text-xs text-gray-500 space-x-3">
              {task.priority && <span data-testid="text-task-priority">Priority: {priorityLabel(task.priority)}</span>}
              {task.due_date && <span data-testid="text-task-due">Due: {fmtDate(task.due_date)}</span>}
              {task.assignees && task.assignees.length > 0 && (
                <span data-testid="text-task-assignees">Assigned: {task.assignees.map((a) => a.username).join(", ")}</span>
              )}
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="details">
            <TabsList className="text-xs flex-wrap h-auto gap-y-1">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="subtasks" data-testid="tab-subtasks">
                Subtasks{subtasks.length > 0 && <Badge className="ml-1 text-[10px] px-1 py-0">{subtasks.length}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="deps" data-testid="tab-deps">
                Dependencies{deps.length > 0 && <Badge className="ml-1 text-[10px] px-1 py-0">{deps.length}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="links" data-testid="tab-links">
                Links{links.length > 0 && <Badge className="ml-1 text-[10px] px-1 py-0">{links.length}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="fields" data-testid="tab-fields">
                <SlidersHorizontal className="w-3 h-3 mr-1" />Fields
                {(task.custom_fields ?? []).length > 0 && (
                  <Badge className="ml-1 text-[10px] px-1 py-0">
                    {(task.custom_fields ?? []).filter((f) => isApplicableToTask(f, task.custom_item_id)).length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="watchers" data-testid="tab-watchers">
                Watchers{watchers.length > 0 && <Badge className="ml-1 text-[10px] px-1 py-0">{watchers.length}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="comments" data-testid="tab-comments">
                <MessageSquare className="w-3 h-3 mr-1" />Comments
              </TabsTrigger>
              <TabsTrigger value="time" data-testid="tab-time">
                <Clock className="w-3 h-3 mr-1" />Time
              </TabsTrigger>
              <TabsTrigger value="insights" data-testid="tab-insights">
                <BarChart2 className="w-3 h-3 mr-1" />Insights
              </TabsTrigger>
              <TabsTrigger value="attachments" data-testid="tab-trigger-attachments">
                <Paperclip className="w-3 h-3 mr-1" />Files
              </TabsTrigger>
              <TabsTrigger value="lists" data-testid="tab-lists">
                Lists
              </TabsTrigger>
              <TabsTrigger value="access" data-testid="tab-task-access">
                <Shield className="w-3 h-3 mr-1" />Access
              </TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="space-y-3 pt-2">
              {task.description ? (
                <div className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 rounded p-3" data-testid="text-task-description">{task.description}</div>
              ) : (
                <p className="text-xs text-gray-400 italic" data-testid="text-task-no-description">No description</p>
              )}
              <div className="flex gap-4 text-xs text-gray-500">
                <span data-testid="text-task-estimate">Estimate: {fmtMs(task.time_estimate)}</span>
                <span data-testid="text-task-spent">Spent: {fmtMs(task.time_spent)}</span>
              </div>
              {task.tags && task.tags.length > 0 && (
                <div className="flex gap-1 flex-wrap" data-testid="task-tags">
                  {task.tags.map((t) => (
                    <span key={t.name} className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: t.tag_fg ?? "#e5e7eb", color: "#374151" }}>{t.name}</span>
                  ))}
                </div>
              )}
              {task.url && (
                <a href={task.url} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-purple-600 hover:underline" data-testid="link-task-clickup">
                  <ExternalLink className="w-3 h-3" /> Open in ClickUp
                </a>
              )}
            </TabsContent>

            <TabsContent value="subtasks" className="space-y-2 pt-2" data-testid="panel-subtasks">
              {subtasks.length === 0 ? (
                <p className="text-xs text-gray-400 italic">No subtasks yet</p>
              ) : (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {subtasks.map((st) => (
                    <div key={st.id} className="flex items-center gap-2 bg-gray-50 rounded px-3 py-1.5" data-testid={`subtask-row-${st.id}`}>
                      <CheckCircle className={`w-3 h-3 flex-shrink-0 ${st.status?.type === "done" ? "text-green-500" : "text-gray-300"}`} />
                      <span className="text-xs text-gray-800 flex-1 truncate">{st.name}</span>
                      {st.status && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusColor(st.status)}`}>{st.status.status}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {addingSubtask ? (
                <div className="flex gap-2 pt-1">
                  <Input autoFocus value={newSubtaskName} onChange={(e) => setNewSubtaskName(e.target.value)}
                    placeholder="Subtask name…" className="text-xs h-8 flex-1" data-testid="input-new-subtask"
                    onKeyDown={(e) => { if (e.key === "Enter") addSubtaskMut.mutate(); if (e.key === "Escape") setAddingSubtask(false); }} />
                  <Button size="sm" onClick={() => addSubtaskMut.mutate()}
                    disabled={addSubtaskMut.isPending || !newSubtaskName.trim()} data-testid="button-save-subtask">
                    {addSubtaskMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Add"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAddingSubtask(false)}>Cancel</Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" className="text-xs text-gray-500"
                  onClick={() => setAddingSubtask(true)} data-testid="button-add-subtask">
                  <Plus className="w-3 h-3 mr-1" /> Add subtask
                </Button>
              )}
            </TabsContent>

            <TabsContent value="deps" className="space-y-4 pt-2" data-testid="panel-deps">
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1 flex items-center gap-1">
                  <ArrowRightCircle className="w-3 h-3 text-amber-500" /> Waiting on
                </p>
                {waitingOn.length === 0 ? (
                  <p className="text-xs text-gray-400 italic pl-4">None</p>
                ) : (
                  <div className="space-y-1 pl-4">
                    {waitingOn.map((d) => (
                      <div key={d.depends_on} className="flex items-center gap-2 bg-amber-50 rounded px-2 py-1" data-testid={`dep-waiting-${d.depends_on}`}>
                        <span className="text-xs text-gray-700 flex-1 font-mono truncate">{d.depends_on}</span>
                        <button className="text-gray-400 hover:text-red-500"
                          onClick={() => removeDepMut.mutate({ type: "depends_on", otherId: d.depends_on })}
                          data-testid={`remove-dep-waiting-${d.depends_on}`}><X className="w-3 h-3" /></button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 pl-4">
                  <TaskPicker workspaceId={workspaceId} excludeId={task.id}
                    onSelect={(t) => addDepMut.mutate({ type: "depends_on", otherId: t.id })}
                    placeholder="Add waiting-on dependency…" />
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1 flex items-center gap-1">
                  <ArrowLeftCircle className="w-3 h-3 text-blue-500" /> Blocking
                </p>
                {blocking.length === 0 ? (
                  <p className="text-xs text-gray-400 italic pl-4">None</p>
                ) : (
                  <div className="space-y-1 pl-4">
                    {blocking.map((d) => (
                      <div key={d.depends_on} className="flex items-center gap-2 bg-blue-50 rounded px-2 py-1" data-testid={`dep-blocking-${d.depends_on}`}>
                        <span className="text-xs text-gray-700 flex-1 font-mono truncate">{d.depends_on}</span>
                        <button className="text-gray-400 hover:text-red-500"
                          onClick={() => removeDepMut.mutate({ type: "dependency_of", otherId: d.depends_on })}
                          data-testid={`remove-dep-blocking-${d.depends_on}`}><X className="w-3 h-3" /></button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 pl-4">
                  <TaskPicker workspaceId={workspaceId} excludeId={task.id}
                    onSelect={(t) => addDepMut.mutate({ type: "dependency_of", otherId: t.id })}
                    placeholder="Add blocking dependency…" />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="links" className="space-y-2 pt-2" data-testid="panel-links">
              {links.length === 0 ? (
                <p className="text-xs text-gray-400 italic">No linked tasks</p>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {links.map((l) => {
                    const otherId = l.task_id_b ?? (l.task_id !== task.id ? l.task_id : "");
                    return (
                      <div key={l.link_id} className="flex items-center gap-2 bg-gray-50 rounded px-3 py-1.5" data-testid={`link-row-${l.link_id}`}>
                        <Link2 className="w-3 h-3 text-purple-400 flex-shrink-0" />
                        <span className="text-xs text-gray-700 flex-1 font-mono truncate">{otherId || l.task_id}</span>
                        <button className="text-gray-400 hover:text-red-500"
                          onClick={() => removeLinkMut.mutate(otherId || l.task_id)}
                          data-testid={`remove-link-${l.link_id}`}><X className="w-3 h-3" /></button>
                      </div>
                    );
                  })}
                </div>
              )}
              <TaskPicker workspaceId={workspaceId} excludeId={task.id}
                onSelect={(t) => addLinkMut.mutate(t.id)} placeholder="Link another task…" />
            </TabsContent>

            <TabsContent value="fields" className="pt-2" data-testid="panel-fields">
              {task.custom_fields && task.custom_fields.length > 0 ? (
                <CustomFieldsTab
                  taskId={task.id}
                  customFields={task.custom_fields}
                  customItemId={task.custom_item_id}
                  onRefresh={invalidateFull}
                />
              ) : (
                <div
                  className="flex flex-col items-center justify-center py-10 text-gray-400 gap-2"
                  data-testid="cf-empty"
                >
                  <SlidersHorizontal className="w-5 h-5" />
                  <p className="text-xs">No custom fields on this task</p>
                </div>
              )}
            </TabsContent>

            <TabsContent value="watchers" className="space-y-2 pt-2" data-testid="panel-watchers">
              {watchers.length === 0 ? (
                <p className="text-xs text-gray-400 italic">No watchers</p>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {watchers.map((w) => (
                    <div key={w.id} className="flex items-center gap-2 bg-gray-50 rounded px-3 py-1.5" data-testid={`watcher-row-${w.id}`}>
                      {w.profilePicture ? (
                        <img src={w.profilePicture} alt={w.username} className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center text-[9px] font-bold text-white"
                          style={{ background: w.color ?? "#7c3aed" }}>
                          {w.username?.[0]?.toUpperCase() ?? "?"}
                        </div>
                      )}
                      <span className="text-xs text-gray-700 flex-1">{w.username}</span>
                      <button className="text-gray-400 hover:text-red-500"
                        onClick={() => removeWatcherMut.mutate(String(w.id))}
                        data-testid={`remove-watcher-${w.id}`}><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-xs text-gray-400 flex items-center gap-1 mt-1">
                <Users className="w-3 h-3" /> Add watcher by ClickUp user ID:
              </p>
              <WatcherAddInput onAdd={(uid) => addWatcherMut.mutate(uid)} pending={addWatcherMut.isPending} />
            </TabsContent>

            <TabsContent value="comments" className="pt-2">
              <TaskCommentsTab taskId={task.id} />
            </TabsContent>

            <TabsContent value="time" className="space-y-3 pt-2">
              <div className="flex items-center justify-between text-xs text-gray-600">
                <span data-testid="text-total-logged">Total logged: {fmtMs(totalMs)}</span>
                {trackingActive ? (
                  <Button size="sm" variant="outline" onClick={() => stopTracking.mutate()}
                    disabled={stopTracking.isPending} data-testid="button-stop-timer" className="text-red-600 border-red-200">
                    {stopTracking.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Square className="w-3 h-3 mr-1" />}
                    Stop timer
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={startTracking}
                    data-testid="button-start-timer" className="text-green-700 border-green-200">
                    <Play className="w-3 h-3 mr-1" /> Start timer
                  </Button>
                )}
              </div>
              <div className="space-y-1 max-h-40 overflow-y-auto" data-testid="list-time-entries">
                {timeEntries.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">No time entries</p>
                ) : (
                  timeEntries.map((e) => (
                    <div key={e.id} className="flex justify-between text-xs bg-gray-50 rounded px-2 py-1" data-testid={`time-entry-${e.id}`}>
                      <span className="text-gray-600">{e.user.username}</span>
                      <span className="text-gray-500">{e.description || "—"}</span>
                      <span className="font-medium">{fmtMs(e.duration)}</span>
                    </div>
                  ))
                )}
              </div>
            </TabsContent>

            <TabsContent value="attachments">
              <AttachmentsTab taskId={task.id} />
            </TabsContent>

            <TabsContent value="lists" className="space-y-3 pt-2" data-testid="panel-lists">
              {/* Home list */}
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1 flex items-center gap-1">
                  <FolderOpen className="w-3 h-3 text-amber-500" /> Home List
                </p>
                <div className="flex items-center gap-2 bg-amber-50 rounded px-3 py-2" data-testid="home-list-row">
                  <span className="text-xs text-gray-800 flex-1 font-medium">{task.list?.name ?? task.list?.id ?? "—"}</span>
                  <Button size="sm" variant="outline" className="text-xs h-7"
                    onClick={() => setMoveOpen(true)} data-testid="button-move-from-lists-tab">
                    <MoveHorizontal className="w-3 h-3 mr-1" /> Move
                  </Button>
                </div>
              </div>

              {/* Additional lists (TIML) */}
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1 flex items-center gap-1">
                  <FolderOpen className="w-3 h-3 text-blue-400" /> Additional Lists
                  <span className="text-[10px] text-gray-400 ml-1">(Tasks in Multiple Lists)</span>
                </p>
                {(!task.additional_lists || task.additional_lists.length === 0) ? (
                  <p className="text-xs text-gray-400 italic pl-1">None</p>
                ) : (
                  <div className="space-y-1 max-h-36 overflow-y-auto">
                    {task.additional_lists.map((l) => (
                      <div key={l.id} className="flex items-center gap-2 bg-blue-50 rounded px-3 py-1.5" data-testid={`timl-list-row-${l.id}`}>
                        <span className="text-xs text-gray-700 flex-1">{l.name ?? l.id}</span>
                        <button className="text-gray-400 hover:text-red-500"
                          onClick={() => removeFromListMut.mutate({ listId: l.id })}
                          disabled={removeFromListMut.isPending}
                          data-testid={`remove-from-list-${l.id}`}>
                          {removeFromListMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <Button size="sm" variant="outline" className="mt-2 text-xs h-7"
                  onClick={() => setTimlPickerOpen(true)} data-testid="button-add-to-list">
                  <Plus className="w-3 h-3 mr-1" /> Add to another list
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="access" className="pt-2" data-testid="panel-task-access">
              {workspaceId ? (
                <AccessPanel type="task" id={task.id} workspaceId={workspaceId} />
              ) : (
                <p className="text-xs text-gray-400 italic" data-testid="text-access-no-workspace">
                  Workspace unknown — access details unavailable
                </p>
              )}
            </TabsContent>

            <TabsContent value="insights" className="space-y-4 pt-2" data-testid="panel-insights">
              {/* Time-in-status breakdown */}
              <div>
                <p className="text-xs font-medium text-gray-600 mb-2 flex items-center gap-1">
                  <BarChart2 className="w-3.5 h-3.5 text-purple-500" /> Time in status
                </p>
                <TimeInStatusPanel taskId={task.id} />
              </div>

              {/* Per-user time estimate */}
              <div className="border-t pt-3">
                <p className="text-xs font-medium text-gray-600 mb-2 flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-blue-500" /> Per-user estimate (Business plan+)
                </p>
                <TaskUserEstimateForm taskId={task.id} />
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose} data-testid="button-task-close">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MergeDialog task={task} workspaceId={workspaceId} open={mergeOpen} onClose={() => setMergeOpen(false)} />

      {/* Move task dialog */}
      <Dialog open={moveOpen} onOpenChange={(o) => !o && setMoveOpen(false)}>
        <DialogContent className="max-w-md" data-testid="dialog-move-task">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <MoveHorizontal className="w-4 h-4 text-blue-500" /> Move Task
            </DialogTitle>
            <DialogDescription className="text-xs text-gray-500">
              Choose a destination list. The task will be removed from its current home list.
            </DialogDescription>
          </DialogHeader>
          <ListPicker
            workspaceId={workspaceId ?? ""}
            excludeListId={task.list?.id}
            onPick={({ id }) => moveTaskMut.mutate({ listId: id })}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setMoveOpen(false)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* TIML add-to-list dialog */}
      <Dialog open={timlPickerOpen} onOpenChange={(o) => !o && setTimlPickerOpen(false)}>
        <DialogContent className="max-w-md" data-testid="dialog-timl-add">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-blue-500" /> Add to List
            </DialogTitle>
            <DialogDescription className="text-xs text-gray-500">
              The task will appear in both lists. Requires the Tasks in Multiple Lists ClickApp.
            </DialogDescription>
          </DialogHeader>
          <ListPicker
            workspaceId={workspaceId ?? ""}
            excludeListId={task.list?.id}
            onPick={({ id }) => addToListMut.mutate({ listId: id })}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setTimlPickerOpen(false)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function WatcherAddInput({ onAdd, pending }: { onAdd(uid: string): void; pending: boolean }) {
  const [uid, setUid] = useState("");
  return (
    <div className="flex gap-2">
      <Input value={uid} onChange={(e) => setUid(e.target.value)} placeholder="ClickUp user ID…"
        className="text-xs h-8 flex-1" data-testid="input-watcher-uid"
        onKeyDown={(e) => { if (e.key === "Enter" && uid.trim()) { onAdd(uid.trim()); setUid(""); } }} />
      <Button size="sm" variant="outline"
        onClick={() => { if (uid.trim()) { onAdd(uid.trim()); setUid(""); } }}
        disabled={pending || !uid.trim()} data-testid="button-add-watcher">
        {pending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
      </Button>
    </div>
  );
}

