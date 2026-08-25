// ClickUp admin — hierarchy create/rename/delete/info/ClickApps/template dialogs.
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
import { Switch } from "@/components/ui/switch";
import { BookmarkPlus, Info, Loader2, Settings, Trash2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { SELECT_NONE_VALUE } from "@/lib/constants";
import type { CUList, CUTemplate, Folder, Space } from "./types";

// ─── Delete Confirmation Dialog ───────────────────────────────────────────────

export function DeleteConfirmDialog({
  open,
  entityType,
  entityName,
  onConfirm,
  onClose,
  isPending,
}: {
  open: boolean;
  entityType: "Space" | "Folder" | "List";
  entityName: string;
  onConfirm(): void;
  onClose(): void;
  isPending: boolean;
}) {
  const [typed, setTyped] = useState("");

  const consequences: Record<string, string> = {
    Space: "all folders, lists, and tasks inside it",
    Folder: "all lists and tasks inside it",
    List: "all tasks inside it",
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) { setTyped(""); onClose(); }
      }}
    >
      <DialogContent data-testid="dialog-delete-confirm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <Trash2 className="w-4 h-4" /> Delete {entityType}
          </DialogTitle>
          <DialogDescription className="space-y-2 pt-1">
            <p>
              This will permanently delete <strong>&ldquo;{entityName}&rdquo;</strong> and{" "}
              <strong>{consequences[entityType]}</strong> directly in ClickUp. This cannot be
              undone.
            </p>
            <p className="text-gray-600 mt-2">
              Type <strong>{entityName}</strong> to confirm:
            </p>
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={entityName}
          className="text-sm"
          data-testid="input-delete-confirm"
        />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => { setTyped(""); onClose(); }} data-testid="button-delete-cancel">
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => { setTyped(""); onConfirm(); }}
            disabled={typed !== entityName || isPending}
            data-testid="button-delete-execute"
          >
            {isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Trash2 className="w-3 h-3 mr-1" />}
            Delete {entityType}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Create / Rename dialog ───────────────────────────────────────────────────

export function NameDialog({
  open,
  title,
  initialValue,
  placeholder,
  onConfirm,
  onClose,
  isPending,
}: {
  open: boolean;
  title: string;
  initialValue?: string;
  placeholder: string;
  onConfirm(name: string): void;
  onClose(): void;
  isPending: boolean;
}) {
  const [name, setName] = useState(initialValue ?? "");

  const handleOpen = (o: boolean) => {
    if (!o) { setName(initialValue ?? ""); onClose(); }
    else setName(initialValue ?? "");
  };

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent data-testid="dialog-name">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          className="text-sm"
          data-testid="input-name"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) { onConfirm(name.trim()); setName(""); }
            if (e.key === "Escape") { setName(initialValue ?? ""); onClose(); }
          }}
        />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="button-name-cancel">Cancel</Button>
          <Button
            size="sm"
            onClick={() => { onConfirm(name.trim()); setName(""); }}
            disabled={!name.trim() || isPending}
            data-testid="button-name-confirm"
          >
            {isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Template picker dialog ───────────────────────────────────────────────────
//
// Allows users to browse workspace templates and create a task, List, or Folder
// from them without leaving NoBull.  Creating or editing template definitions
// is not exposed by the ClickUp public API and is therefore out of scope.
//
// Large templates (Folders, multi-task Lists) use return_immediately=true on the
// ClickUp side so the API call returns quickly; the backend enqueues a targeted
// sub-tree refresh.  The UI shows a "still being created in ClickUp" note in that case.

export type TplKind = "task" | "list-in-space" | "list-in-folder" | "folder";

export function TemplatePickerDialog({
  open,
  workspaceId,
  kind,
  title,
  onClose,
  onConfirm,
  isPending,
  materializing,
}: {
  open: boolean;
  workspaceId: string;
  kind: TplKind;
  title: string;
  onClose(): void;
  onConfirm(templateId: string, name: string): void;
  isPending: boolean;
  materializing?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [name, setName] = useState("");

  const apiSuffix =
    kind === "task"
      ? "task-templates"
      : kind === "folder"
        ? "folder-templates"
        : "list-templates";

  const { data, isLoading } = useQuery<{ templates: CUTemplate[] }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, apiSuffix],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/${apiSuffix}`, {
        credentials: "include",
      }).then((r) => r.json()),
    enabled: open,
    staleTime: 60_000,
  });

  const templates = data?.templates ?? [];

  const handleClose = () => {
    setSelectedId("");
    setName("");
    onClose();
  };

  const handleConfirm = () => {
    if (!selectedId) return;
    onConfirm(selectedId, name.trim());
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-md" data-testid="dialog-template-picker">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs text-gray-500">
            Note: creating or editing template definitions is managed in ClickUp directly.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-gray-400 py-4">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading templates…
          </div>
        ) : templates.length === 0 ? (
          <p className="text-xs text-gray-500 italic py-2" data-testid="text-no-templates">
            No templates found in this workspace library.
          </p>
        ) : (
          <div
            className="max-h-48 overflow-y-auto space-y-1 border rounded p-2"
            data-testid="list-templates"
          >
            {templates.map((t) => (
              <button
                key={t.id}
                className={`w-full text-left px-3 py-2 rounded text-xs transition-colors ${
                  selectedId === t.id
                    ? "bg-purple-100 text-purple-800 font-medium"
                    : "hover:bg-gray-50 text-gray-700"
                }`}
                onClick={() => setSelectedId(t.id)}
                data-testid={`template-option-${t.id}`}
              >
                <BookmarkPlus className="w-3 h-3 inline mr-1.5 opacity-60" />
                {t.name}
              </button>
            ))}
          </div>
        )}

        <Input
          placeholder="Override name (optional — leave blank to use template name)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="text-xs"
          data-testid="input-template-name"
          onKeyDown={(e) => {
            if (e.key === "Enter" && selectedId) handleConfirm();
            if (e.key === "Escape") handleClose();
          }}
        />

        {materializing && (
          <p className="text-[11px] text-amber-600 flex items-center gap-1" data-testid="text-materializing">
            <Loader2 className="w-3 h-3 animate-spin" />
            Still being created in ClickUp — hierarchy will refresh shortly.
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleClose} data-testid="button-tpl-cancel">
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={!selectedId || isPending}
            data-testid="button-tpl-confirm"
          >
            {isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
            Create from Template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Space ClickApps panel ────────────────────────────────────────────────────

export const CLICKAPPS: Array<{ key: string; label: string; featureKey: string }> = [
  { key: "multiple_assignees", label: "Multiple Assignees", featureKey: "multiple_assignees" },
  { key: "time_tracking", label: "Time Tracking", featureKey: "time_tracking" },
  { key: "tags", label: "Tags", featureKey: "tags" },
  { key: "custom_fields", label: "Custom Fields", featureKey: "custom_fields" },
  { key: "priorities", label: "Priorities", featureKey: "priorities" },
  { key: "milestones", label: "Milestones", featureKey: "milestones" },
  { key: "sprints", label: "Sprints", featureKey: "sprints" },
];

export function SpaceAppsDialog({
  open,
  space,
  onClose,
  onSaved,
}: {
  open: boolean;
  space: Space | null;
  onClose(): void;
  onSaved(): void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const getEnabled = (key: string): boolean => {
    if (!space?.features) return false;
    const f = space.features[key];
    if (typeof f === "boolean") return f;
    if (f && typeof f === "object") return !!(f as any).enabled;
    return false;
  };

  const [toggles, setToggles] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(CLICKAPPS.map((a) => [a.key, getEnabled(a.key)])),
  );

  const updateMut = useMutation({
    mutationFn: async () => {
      if (!space) return;
      const features: Record<string, { enabled: boolean }> = {};
      for (const app of CLICKAPPS) {
        if (app.key === "multiple_assignees") continue;
        features[app.featureKey] = { enabled: toggles[app.key] };
      }
      await apiRequest("PUT", `/api/clickup/spaces/${space.id}`, {
        features,
        multiple_assignees: toggles["multiple_assignees"],
      });
    },
    onSuccess: () => {
      toast({ title: "Space settings saved" });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/workspaces"] }); // fire-and-forget: cache refresh only
      onSaved();
      onClose();
    },
    onError: (e: any) =>
      toast({ title: "Failed to save settings", description: e.message, variant: "destructive" }),
  });

  if (!space) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="dialog-space-apps">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Settings className="w-4 h-4" /> Space ClickApps — {space.name}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Toggle ClickApps for this Space. Changes apply immediately in ClickUp.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {CLICKAPPS.map((app) => (
            <div key={app.key} className="flex items-center justify-between">
              <Label className="text-sm">{app.label}</Label>
              <Switch
                checked={toggles[app.key] ?? false}
                onCheckedChange={(v) => setToggles((p) => ({ ...p, [app.key]: v }))}
                data-testid={`switch-clickapp-${app.key}`}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => updateMut.mutate()} disabled={updateMut.isPending} data-testid="button-save-clickapps">
            {updateMut.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── List Info Editor ──────────────────────────────────────────────────────────

export function ListInfoDialog({
  open,
  list,
  onClose,
  onSaved,
}: {
  open: boolean;
  list: CUList | null;
  onClose(): void;
  onSaved(): void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [content, setContent] = useState(list?.content ?? "");
  const [dueDate, setDueDate] = useState(
    list?.due_date ? new Date(Number(list.due_date)).toISOString().slice(0, 10) : "",
  );
  const [priority, setPriority] = useState<string>(
    list?.priority?.id != null ? String(list.priority.id) : "",
  );
  const [color, setColor] = useState<string>((list as any)?.color ?? "");
  const [unsetAssignee, setUnsetAssignee] = useState(false);

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!list) return;
      const body: Record<string, any> = {
        name: list.name,
        content: content,
      };
      if (dueDate) {
        body.due_date = new Date(dueDate).getTime();
        body.due_date_time = false;
      } else {
        body.due_date = null;
      }
      if (priority) {
        body.priority = parseInt(priority, 10);
      } else {
        body.priority = null;
      }
      if (color) body.color = color;
      if (unsetAssignee) body.assignee = null;
      await apiRequest("PUT", `/api/clickup/lists/${list.id}`, body);
    },
    onSuccess: () => {
      toast({ title: "List info saved" });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/spaces"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/folders"] }); // fire-and-forget: cache refresh only
      onSaved();
      onClose();
    },
    onError: (e: any) =>
      toast({ title: "Failed to save", description: e.message, variant: "destructive" }),
  });

  if (!list) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="dialog-list-info">
        <DialogHeader>
          <DialogTitle className="text-sm">Edit List Info — {list.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div>
            <Label className="text-xs text-gray-600 mb-1 block">Description</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="List description…"
              className="text-sm min-h-[80px]"
              data-testid="input-list-content"
            />
          </div>
          <div>
            <Label className="text-xs text-gray-600 mb-1 block">Due Date</Label>
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="text-sm"
              data-testid="input-list-due-date"
            />
          </div>
          <div>
            <Label className="text-xs text-gray-600 mb-1 block">Priority</Label>
            <Select
              value={priority || SELECT_NONE_VALUE}
              onValueChange={(v) => setPriority(v === SELECT_NONE_VALUE ? "" : v)}
            >
              <SelectTrigger className="h-8 text-xs" data-testid="select-list-priority">
                <SelectValue placeholder="No priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_NONE_VALUE}>No priority</SelectItem>
                <SelectItem value="1">Urgent</SelectItem>
                <SelectItem value="2">High</SelectItem>
                <SelectItem value="3">Normal</SelectItem>
                <SelectItem value="4">Low</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-gray-600 mb-1 block">Color</Label>
            <div className="flex items-center gap-2">
              <Input
                type="color"
                value={color || "#6b7280"}
                onChange={(e) => setColor(e.target.value)}
                className="h-8 w-14 p-1 cursor-pointer"
                data-testid="input-list-color"
              />
              <span className="text-xs text-gray-500">{color || "None"}</span>
              {color && (
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setColor("")} data-testid="button-clear-list-color">
                  Clear
                </Button>
              )}
            </div>
          </div>
          <div>
            <Label className="text-xs text-gray-600 mb-1 block">Assignee</Label>
            {list.assignee ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-700">{list.assignee.username}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-red-600"
                  onClick={() => setUnsetAssignee(!unsetAssignee)}
                  data-testid="button-unset-assignee"
                >
                  {unsetAssignee ? "Keep" : "Remove"}
                </Button>
              </div>
            ) : (
              <span className="text-xs text-gray-400">No default assignee</span>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending} data-testid="button-save-list-info">
            {saveMut.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

