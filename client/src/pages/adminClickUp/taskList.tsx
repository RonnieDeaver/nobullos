// ClickUp admin — list task table panel.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BookmarkPlus, CheckCircle, Loader2, Plus } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { Task } from "./types";
import { fmtDate, statusColor } from "./lib";
import { TemplatePickerDialog } from "./hierarchyDialogs";
import { TaskDetailDialog } from "./taskDetail";

// ─── Task list panel ──────────────────────────────────────────────────────────

export function TaskListPanel({
  listId,
  workspaceId,
  spaceId,
}: {
  listId: string;
  workspaceId: string;
  spaceId: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [newTaskName, setNewTaskName] = useState("");
  const [addingTask, setAddingTask] = useState(false);
  const [taskTplOpen, setTaskTplOpen] = useState(false);

  const createTaskFromTemplateMut = useMutation({
    mutationFn: async ({ templateId, name }: { templateId: string; name: string }) => {
      const res = await apiRequest("POST", `/api/clickup/lists/${listId}/tasks-from-template`, {
        templateId,
        name: name || undefined,
        workspaceId,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Task created from template" });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/lists", listId, "tasks"] }); // fire-and-forget: cache refresh only
      setTaskTplOpen(false);
    },
    onError: (e: any) =>
      toast({ title: "Failed to create task from template", description: e.message, variant: "destructive" }),
  });

  const { data, isLoading } = useQuery<{ tasks: Task[] }>({
    queryKey: ["/api/clickup/lists", listId, "tasks"],
    queryFn: () =>
      fetch(`/api/clickup/lists/${listId}/tasks`, { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const createMut = useMutation({
    mutationFn: async () => {
      if (!newTaskName.trim()) throw new Error("Name required");
      await apiRequest("POST", `/api/clickup/lists/${listId}/tasks`, { name: newTaskName.trim() });
    },
    onSuccess: () => {
      setNewTaskName("");
      setAddingTask(false);
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/lists", listId, "tasks"] }); // fire-and-forget: cache refresh only
    },
    onError: (e: any) =>
      toast({ title: "Failed to create task", description: e.message, variant: "destructive" }),
  });

  const tasks = data?.tasks ?? [];

  return (
    <div className="space-y-2" data-testid="panel-task-list">
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading tasks…
        </div>
      ) : tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No tasks in this list</p>
      ) : (
        tasks.map((t) => (
          <div
            key={t.id}
            className="flex items-center gap-2 bg-card border rounded px-3 py-2 hover:bg-muted/50 cursor-pointer group"
            onClick={() => setSelectedTask(t)}
            data-testid={`task-row-${t.id}`}
          >
            <CheckCircle className={`w-4 h-4 flex-shrink-0 ${t.status?.type === "done" ? "text-green-500" : "text-gray-300"}`} />
            <span className="text-sm text-foreground flex-1 truncate">{t.name}</span>
            {t.status && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusColor(t.status)}`}>
                {t.status.status}
              </span>
            )}
            {t.due_date && (
              <span className="text-[10px] text-muted-foreground">{fmtDate(t.due_date)}</span>
            )}
          </div>
        ))
      )}

      {addingTask ? (
        <div className="flex gap-2 pt-1">
          <Input
            autoFocus
            value={newTaskName}
            onChange={(e) => setNewTaskName(e.target.value)}
            placeholder="Task name…"
            className="text-xs h-8 flex-1"
            data-testid="input-new-task"
            onKeyDown={(e) => {
              if (e.key === "Enter") createMut.mutate();
              if (e.key === "Escape") setAddingTask(false);
            }}
          />
          <Button size="sm" onClick={() => createMut.mutate()} disabled={createMut.isPending} data-testid="button-save-task">
            {createMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Add"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAddingTask(false)} data-testid="button-cancel-task">Cancel</Button>
        </div>
      ) : (
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="text-xs text-muted-foreground"
            onClick={() => setAddingTask(true)}
            data-testid="button-add-task"
          >
            <Plus className="w-3 h-3 mr-1" /> Add task
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-xs text-muted-foreground"
            onClick={() => setTaskTplOpen(true)}
            data-testid="button-add-task-from-template"
          >
            <BookmarkPlus className="w-3 h-3 mr-1" /> From template
          </Button>
        </div>
      )}

      <TemplatePickerDialog
        open={taskTplOpen}
        workspaceId={workspaceId}
        kind="task"
        title="Add Task from Template"
        isPending={createTaskFromTemplateMut.isPending}
        onClose={() => setTaskTplOpen(false)}
        onConfirm={(templateId, name) =>
          createTaskFromTemplateMut.mutate({ templateId, name })
        }
      />

      <TaskDetailDialog
        task={selectedTask}
        workspaceId={workspaceId}
        listId={listId}
        spaceId={spaceId}
        onClose={() => setSelectedTask(null)}
        onTagsChanged={(tid, tags) => {
          if (selectedTask?.id === tid) {
            setSelectedTask((prev) => prev ? { ...prev, tags } : prev);
          }
        }}
      />
    </div>
  );
}

