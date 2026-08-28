// ClickUp admin — task search picker, merge dialog, hierarchy list picker.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Loader2,
  GitMerge,
  Search,
  X,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { CUList, SearchResult, Task } from "./types";

// ─── Task picker (search + select) ───────────────────────────────────────────

export function TaskPicker({
  workspaceId,
  excludeId,
  onSelect,
  placeholder,
}: {
  workspaceId: string | null;
  excludeId?: string;
  onSelect(task: SearchResult): void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const { data, isFetching, isError } = useQuery<{ tasks: SearchResult[] }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "search", query],
    queryFn: async () => {
      if (!workspaceId || !query.trim()) return { tasks: [] };
      const res = await fetch(
        // Server reads the free-text term from `q`, not `query` — using the
        // wrong param name silently returned the unfiltered task list.
        `/api/clickup/workspaces/${workspaceId}/search?q=${encodeURIComponent(query)}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      return res.json();
    },
    enabled: !!workspaceId && query.trim().length > 1,
    staleTime: 10_000,
    retry: false,
  });

  const results = (data?.tasks ?? []).filter((t) => t.id !== excludeId).slice(0, 8);

  return (
    <div className="relative">
      <div className="flex items-center gap-1 border rounded h-8 px-2 bg-card">
        <Search className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        <input
          className="text-xs flex-1 outline-none bg-transparent placeholder-gray-400"
          placeholder={placeholder ?? "Search tasks…"}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          data-testid="input-task-picker"
        />
        {isFetching && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
      </div>
      {open && isError && (
        <div className="absolute z-[var(--z-overlay)] top-9 left-0 right-0 bg-card border rounded shadow-lg px-3 py-2 text-xs text-red-600" data-testid="task-picker-error">
          Search failed — try again.
        </div>
      )}
      {open && !isError && results.length > 0 && (
        <div className="absolute z-50 top-9 left-0 right-0 bg-card border rounded shadow-lg max-h-48 overflow-y-auto" data-testid="task-picker-results">
          {results.map((t) => (
            <button
              key={t.id}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-purple-50 text-left"
              onMouseDown={() => { onSelect(t); setQuery(""); setOpen(false); }}
              data-testid={`picker-option-${t.id}`}
            >
              <span className="text-xs text-foreground flex-1 truncate">{t.name}</span>
              {t.list?.name && (
                <span className="text-[10px] text-muted-foreground shrink-0">{t.list.name}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Merge dialog ─────────────────────────────────────────────────────────────

export function MergeDialog({
  task,
  workspaceId,
  open,
  onClose,
}: {
  task: Task;
  workspaceId: string | null;
  open: boolean;
  onClose(): void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  const mergeMut = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("No task selected");
      await apiRequest("POST", `/api/clickup/tasks/${task.id}/merge`, {
        task_ids: [selected.id],
      });
    },
    onSuccess: () => {
      toast({ title: "Tasks merged", description: `Merged into "${task.name}"` });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/tasks", task.id] }); // fire-and-forget: cache refresh only
      setSelected(null);
      setConfirming(false);
      onClose();
    },
    onError: (e: any) =>
      toast({ title: "Merge failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="dialog-merge">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <GitMerge className="w-4 h-4 text-purple-600" /> Merge duplicate task
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Select a duplicate task to merge <strong>into</strong> this one.
            The source task will be closed and its data merged into{" "}
            <strong>"{task.name}"</strong>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <TaskPicker
            workspaceId={workspaceId}
            excludeId={task.id}
            onSelect={(t) => { setSelected(t); setConfirming(false); }}
            placeholder="Search for duplicate task…"
          />
          {selected && (
            <div className="flex items-center justify-between bg-purple-50 rounded px-3 py-2" data-testid="merge-selected-task">
              <span className="text-sm text-foreground truncate flex-1">{selected.name}</span>
              <button onClick={() => { setSelected(null); setConfirming(false); }} className="ml-2 text-muted-foreground hover:text-muted-foreground">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          {selected && !confirming && (
            <Button
              size="sm"
              variant="outline"
              className="w-full text-amber-700 border-amber-300"
              onClick={() => setConfirming(true)}
              data-testid="button-confirm-merge-step1"
            >
              Review merge
            </Button>
          )}
          {selected && confirming && (
            <div className="space-y-2">
              <p className="text-xs text-amber-700 bg-amber-50 rounded p-2">
                This will merge <strong>"{selected.name}"</strong> into <strong>"{task.name}"</strong>. The source task will be closed.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1 bg-purple-700 hover:bg-purple-800"
                  onClick={() => mergeMut.mutate()}
                  disabled={mergeMut.isPending}
                  data-testid="button-execute-merge"
                >
                  {mergeMut.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <GitMerge className="w-3 h-3 mr-1" />}
                  Confirm merge
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} data-testid="button-cancel-merge">
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Hierarchy list picker (used for Move + TIML Add) ────────────────────────

export type HierarchySpace = {
  id: string;
  name: string;
  archived?: boolean;
  folders: Array<{ id: string; name: string; hidden?: boolean; lists: CUList[] }>;
  lists: CUList[];
};

export function ListPicker({
  workspaceId,
  excludeListId,
  onPick,
}: {
  workspaceId: string;
  excludeListId?: string | null;
  onPick(list: { id: string; name: string }): void;
}) {
  const { data, isLoading } = useQuery<{ hierarchy: HierarchySpace[] }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "hierarchy"],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/hierarchy`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
    staleTime: 2 * 60_000,
  });

  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading hierarchy…
      </div>
    );
  }

  const spaces = (data?.hierarchy ?? []).filter((s) => !s.archived);

  return (
    <div className="max-h-64 overflow-y-auto border rounded text-xs" data-testid="list-picker">
      {spaces.length === 0 && (
        <p className="text-muted-foreground text-center py-4">No spaces found</p>
      )}
      {spaces.map((space) => {
        const spaceExpanded = expandedSpaces.has(space.id);
        return (
          <div key={space.id}>
            <button
              className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted/50 font-medium text-foreground"
              onClick={() =>
                setExpandedSpaces((prev) => {
                  const n = new Set(prev);
                  if (n.has(space.id)) n.delete(space.id);
                  else n.add(space.id);
                  return n;
                })
              }
              data-testid={`picker-space-${space.id}`}
            >
              {spaceExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {space.name}
            </button>
            {spaceExpanded && (
              <div>
                {space.lists.map((l) =>
                  l.id === excludeListId ? null : (
                    <button
                      key={l.id}
                      className="w-full flex items-center gap-1.5 pl-6 pr-2 py-1 hover:bg-purple-50 text-muted-foreground"
                      onClick={() => onPick({ id: l.id, name: l.name })}
                      data-testid={`picker-list-${l.id}`}
                    >
                      <CheckSquare className="w-3 h-3 text-purple-400" />
                      <span className="truncate">{l.name}</span>
                    </button>
                  ),
                )}
                {space.folders.filter((f) => !f.hidden).map((folder) => {
                  const folderExpanded = expandedFolders.has(folder.id);
                  return (
                    <div key={folder.id}>
                      <button
                        className="w-full flex items-center gap-1.5 pl-4 pr-2 py-1 hover:bg-muted/50 text-muted-foreground"
                        onClick={() =>
                          setExpandedFolders((prev) => {
                            const n = new Set(prev);
                            if (n.has(folder.id)) n.delete(folder.id);
                            else n.add(folder.id);
                            return n;
                          })
                        }
                        data-testid={`picker-folder-${folder.id}`}
                      >
                        {folderExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        <FolderOpen className="w-3 h-3 text-amber-500" />
                        <span className="truncate">{folder.name}</span>
                      </button>
                      {folderExpanded &&
                        folder.lists.map((l) =>
                          l.id === excludeListId ? null : (
                            <button
                              key={l.id}
                              className="w-full flex items-center gap-1.5 pl-10 pr-2 py-1 hover:bg-purple-50 text-muted-foreground"
                              onClick={() => onPick({ id: l.id, name: l.name })}
                              data-testid={`picker-list-${l.id}`}
                            >
                              <CheckSquare className="w-3 h-3 text-purple-400" />
                              <span className="truncate">{l.name}</span>
                            </button>
                          ),
                        )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

