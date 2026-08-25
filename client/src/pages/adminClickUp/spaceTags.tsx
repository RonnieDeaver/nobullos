// ClickUp admin — space tags manager.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, Pencil, Tag, Trash2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { Space, SpaceTag } from "./types";

// ─── Space Tags Manager ───────────────────────────────────────────────────────

export const PRESET_COLORS = [
  { bg: "#6b7280", fg: "#ffffff", label: "Gray" },
  { bg: "#ef4444", fg: "#ffffff", label: "Red" },
  { bg: "#f97316", fg: "#ffffff", label: "Orange" },
  { bg: "#eab308", fg: "#1f2937", label: "Yellow" },
  { bg: "#22c55e", fg: "#ffffff", label: "Green" },
  { bg: "#3b82f6", fg: "#ffffff", label: "Blue" },
  { bg: "#8b5cf6", fg: "#ffffff", label: "Purple" },
  { bg: "#ec4899", fg: "#ffffff", label: "Pink" },
];

export function SpaceTagsManager({ spaceId }: { spaceId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newBg, setNewBg] = useState(PRESET_COLORS[0].bg);
  const [newFg, setNewFg] = useState(PRESET_COLORS[0].fg);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editBg, setEditBg] = useState("");
  const [editFg, setEditFg] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const { data: tags = [], isLoading } = useQuery<SpaceTag[]>({
    queryKey: ["/api/clickup/spaces", spaceId, "tags"],
    queryFn: async () => {
      const res = await fetch(`/api/clickup/spaces/${spaceId}/tags`, { credentials: "include" });
      if (!res.ok) return [];
      const d = await res.json();
      return d.tags ?? [];
    },
    enabled: !!spaceId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["/api/clickup/spaces", spaceId, "tags"] });

  const createMut = useMutation({
    mutationFn: async () => {
      if (!newName.trim()) throw new Error("Name required");
      await apiRequest("POST", `/api/clickup/spaces/${spaceId}/tags`, {
        name: newName.trim(),
        tag_fg: newFg,
        tag_bg: newBg,
      });
    },
    onSuccess: () => {
      setNewName("");
      void invalidate(); // fire-and-forget: cache refresh only
    },
    onError: (e: any) =>
      toast({ title: "Failed to create tag", description: e.message, variant: "destructive" }),
  });

  const editMut = useMutation({
    mutationFn: async () => {
      if (!editingTag) throw new Error("No tag selected");
      await apiRequest("PUT", `/api/clickup/spaces/${spaceId}/tags/${encodeURIComponent(editingTag)}`, {
        name: editName.trim() || editingTag,
        tag_fg: editFg,
        tag_bg: editBg,
      });
    },
    onSuccess: () => {
      setEditingTag(null);
      void invalidate(); // fire-and-forget: cache refresh only
    },
    onError: (e: any) =>
      toast({ title: "Failed to update tag", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (tagName: string) => {
      await apiRequest("DELETE", `/api/clickup/spaces/${spaceId}/tags/${encodeURIComponent(tagName)}`);
    },
    onSuccess: () => {
      setDeleteConfirm(null);
      void invalidate(); // fire-and-forget: cache refresh only
    },
    onError: (e: any) =>
      toast({ title: "Failed to delete tag", description: e.message, variant: "destructive" }),
  });

  const startEdit = (tag: SpaceTag) => {
    setEditingTag(tag.name);
    setEditName(tag.name);
    setEditBg(tag.tag_bg);
    setEditFg(tag.tag_fg);
  };

  return (
    <div className="space-y-4" data-testid="panel-space-tags">
      {/* Create new tag */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Tag className="w-4 h-4 text-purple-500" /> Create tag
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <Label className="text-xs mb-1 block">Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Tag name…"
                className="h-8 text-xs"
                data-testid="input-new-tag-name"
                onKeyDown={(e) => { if (e.key === "Enter") createMut.mutate(); }}
              />
            </div>
            <Button
              size="sm"
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending || !newName.trim()}
              data-testid="button-create-tag"
            >
              {createMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
            </Button>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Color</Label>
            <div className="flex gap-1.5 flex-wrap">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c.bg}
                  title={c.label}
                  onClick={() => { setNewBg(c.bg); setNewFg(c.fg); }}
                  className={`w-5 h-5 rounded-full border-2 transition-all ${newBg === c.bg ? "border-gray-800 scale-110" : "border-transparent"}`}
                  style={{ background: c.bg }}
                  data-testid={`color-preset-${c.label.toLowerCase()}`}
                />
              ))}
            </div>
          </div>
          {newName && (
            <div>
              <Label className="text-xs mb-1 block">Preview</Label>
              <span
                className="inline-block text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: newBg, color: newFg }}
                data-testid="tag-preview"
              >
                {newName}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Existing tags */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading tags…
        </div>
      ) : tags.length === 0 ? (
        <p className="text-xs text-muted-foreground italic" data-testid="text-no-tags">No tags in this space yet</p>
      ) : (
        <div className="space-y-1.5" data-testid="list-space-tags">
          {tags.map((tag) => (
            <div
              key={tag.name}
              className="flex items-center gap-2 bg-card border rounded px-3 py-2"
              data-testid={`space-tag-row-${tag.name}`}
            >
              {editingTag === tag.name ? (
                <>
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="h-7 text-xs flex-1"
                    data-testid="input-edit-tag-name"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter") editMut.mutate(); if (e.key === "Escape") setEditingTag(null); }}
                  />
                  <div className="flex gap-1">
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c.bg}
                        title={c.label}
                        onClick={() => { setEditBg(c.bg); setEditFg(c.fg); }}
                        className={`w-4 h-4 rounded-full border-2 ${editBg === c.bg ? "border-gray-800" : "border-transparent"}`}
                        style={{ background: c.bg }}
                      />
                    ))}
                  </div>
                  <Button size="sm" onClick={() => editMut.mutate()} disabled={editMut.isPending} className="h-7 px-2 text-xs" data-testid="button-save-edit-tag">
                    {editMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingTag(null)} className="h-7 px-2 text-xs" data-testid="button-cancel-edit-tag">Cancel</Button>
                </>
              ) : (
                <>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: tag.tag_bg ?? "#e5e7eb", color: tag.tag_fg ?? "#374151" }}
                    data-testid={`space-tag-chip-${tag.name}`}
                  >
                    {tag.name}
                  </span>
                  <span className="text-xs text-muted-foreground flex-1">{tag.name}</span>
                  <Button size="sm" variant="ghost" onClick={() => startEdit(tag)} className="h-7 w-7 p-0" data-testid={`button-edit-tag-${tag.name}`}>
                    <Pencil className="w-3 h-3" />
                  </Button>
                  {deleteConfirm === tag.name ? (
                    <>
                      <span className="text-[10px] text-red-600">Remove from all tasks?</span>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => deleteMut.mutate(tag.name)}
                        disabled={deleteMut.isPending}
                        className="h-7 px-2 text-xs"
                        data-testid={`button-confirm-delete-tag-${tag.name}`}
                      >
                        {deleteMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Delete"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(null)} className="h-7 px-2 text-xs" data-testid={`button-cancel-delete-tag-${tag.name}`}>Cancel</Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(tag.name)} className="h-7 w-7 p-0 text-red-500 hover:text-red-700" data-testid={`button-delete-tag-${tag.name}`}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

