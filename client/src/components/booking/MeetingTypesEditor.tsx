import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Pencil, Plus, Save, Trash2, X } from "lucide-react";

type MeetingType = {
  id: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  sortOrder: number;
};

type Draft = {
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
};

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isValidDraft(d: Draft): boolean {
  return (
    d.name.trim().length > 0 &&
    d.durationMinutes >= 15 &&
    d.durationMinutes <= 240 &&
    d.bufferBeforeMinutes >= 0 &&
    d.bufferBeforeMinutes <= 120 &&
    d.bufferAfterMinutes >= 0 &&
    d.bufferAfterMinutes <= 120
  );
}

export default function MeetingTypesEditor() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<{ meetingTypes: MeetingType[] }>({
    queryKey: ["/api/booking/me/meeting-types"],
    meta: { silent: true },
  });

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // Inline edit state — when set, the matching row renders an editable
  // form instead of the read-only summary so AMs can rename or change
  // length/buffers without leaving the page.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);

  const startEdit = (mt: MeetingType) => {
    setEditingId(mt.id);
    setEditDraft({
      name: mt.name,
      durationMinutes: mt.durationMinutes,
      bufferBeforeMinutes: mt.bufferBeforeMinutes,
      bufferAfterMinutes: mt.bufferAfterMinutes,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft(EMPTY_DRAFT);
  };

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/booking/me/meeting-types", {
        name: draft.name.trim(),
        durationMinutes: clamp(draft.durationMinutes, 15, 240),
        bufferBeforeMinutes: clamp(draft.bufferBeforeMinutes, 0, 120),
        bufferAfterMinutes: clamp(draft.bufferAfterMinutes, 0, 120),
      });
      return res.json();
    },
    onSuccess: () => {
      setDraft(EMPTY_DRAFT);
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/meeting-types"] }); // fire-and-forget: cache refresh only
      toast({ title: "Meeting type saved" });
    },
    onError: (err: any) => {
      toast({
        title: "Could not save meeting type",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const update = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest(
        "PUT",
        `/api/booking/me/meeting-types/${id}`,
        {
          name: editDraft.name.trim(),
          durationMinutes: clamp(editDraft.durationMinutes, 15, 240),
          bufferBeforeMinutes: clamp(editDraft.bufferBeforeMinutes, 0, 120),
          bufferAfterMinutes: clamp(editDraft.bufferAfterMinutes, 0, 120),
        },
      );
      return res.json();
    },
    onSuccess: () => {
      cancelEdit();
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/meeting-types"] }); // fire-and-forget: cache refresh only
      toast({ title: "Meeting type updated" });
    },
    onError: (err: any) => {
      toast({
        title: "Could not update meeting type",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest(
        "DELETE",
        `/api/booking/me/meeting-types/${id}`,
      );
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/meeting-types"] }); // fire-and-forget: cache refresh only
      toast({ title: "Meeting type deleted" });
    },
    onError: (err: any) => {
      toast({
        title: "Could not delete",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const types = data?.meetingTypes || [];
  const canSaveCreate = isValidDraft(draft) && !create.isPending;
  const canSaveEdit = isValidDraft(editDraft) && !update.isPending;

  return (
    <Card data-testid="card-meeting-types">
      <CardHeader>
        <CardTitle className="text-lg">Saved meeting types</CardTitle>
        <CardDescription>
          Reusable presets that show up as one-click chips on the
          Schedule panel — picking one fills in the length and buffers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <div
            className="text-sm text-destructive"
            data-testid="text-meeting-types-error"
          >
            Could not load meeting types. Please try again shortly.
          </div>
        ) : isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : types.length === 0 ? (
          <div
            className="text-sm text-muted-foreground"
            data-testid="text-meeting-types-empty"
          >
            No saved meeting types yet — add one below.
          </div>
        ) : (
          <ul className="space-y-2">
            {types.map((mt) => {
              const isEditing = editingId === mt.id;
              return (
                <li
                  key={mt.id}
                  className="border rounded p-2 text-sm"
                  data-testid={`row-meeting-type-${mt.id}`}
                >
                  {isEditing ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                        <div className="md:col-span-2">
                          <Label htmlFor={`mtEditName-${mt.id}`}>Name</Label>
                          <Input
                            id={`mtEditName-${mt.id}`}
                            value={editDraft.name}
                            onChange={(e) =>
                              setEditDraft((d) => ({
                                ...d,
                                name: e.target.value,
                              }))
                            }
                            maxLength={80}
                            data-testid={`input-edit-meeting-type-name-${mt.id}`}
                          />
                        </div>
                        <div>
                          <Label htmlFor={`mtEditDuration-${mt.id}`}>
                            Length (min)
                          </Label>
                          <Input
                            id={`mtEditDuration-${mt.id}`}
                            type="number"
                            min={15}
                            max={240}
                            step={5}
                            value={editDraft.durationMinutes}
                            onChange={(e) =>
                              setEditDraft((d) => ({
                                ...d,
                                durationMinutes: Number(e.target.value) || 0,
                              }))
                            }
                            data-testid={`input-edit-meeting-type-duration-${mt.id}`}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label htmlFor={`mtEditBefore-${mt.id}`}>
                              Before
                            </Label>
                            <Input
                              id={`mtEditBefore-${mt.id}`}
                              type="number"
                              min={0}
                              max={120}
                              step={5}
                              value={editDraft.bufferBeforeMinutes}
                              onChange={(e) =>
                                setEditDraft((d) => ({
                                  ...d,
                                  bufferBeforeMinutes:
                                    Number(e.target.value) || 0,
                                }))
                              }
                              data-testid={`input-edit-meeting-type-buffer-before-${mt.id}`}
                            />
                          </div>
                          <div>
                            <Label htmlFor={`mtEditAfter-${mt.id}`}>
                              After
                            </Label>
                            <Input
                              id={`mtEditAfter-${mt.id}`}
                              type="number"
                              min={0}
                              max={120}
                              step={5}
                              value={editDraft.bufferAfterMinutes}
                              onChange={(e) =>
                                setEditDraft((d) => ({
                                  ...d,
                                  bufferAfterMinutes:
                                    Number(e.target.value) || 0,
                                }))
                              }
                              data-testid={`input-edit-meeting-type-buffer-after-${mt.id}`}
                            />
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => update.mutate(mt.id)}
                          disabled={!canSaveEdit}
                          data-testid={`button-save-meeting-type-${mt.id}`}
                        >
                          {update.isPending ? (
                            <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                          ) : (
                            <Save className="w-3.5 h-3.5 mr-1.5" />
                          )}
                          Save
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={cancelEdit}
                          data-testid={`button-cancel-edit-meeting-type-${mt.id}`}
                        >
                          <X className="w-3.5 h-3.5 mr-1.5" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div>
                        <div
                          className="font-medium"
                          data-testid={`text-meeting-type-name-${mt.id}`}
                        >
                          {mt.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {mt.durationMinutes} min · buffers{" "}
                          {mt.bufferBeforeMinutes}/{mt.bufferAfterMinutes} min
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => startEdit(mt)}
                          data-testid={`button-edit-meeting-type-${mt.id}`}
                          title="Edit meeting type"
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => remove.mutate(mt.id)}
                          disabled={remove.isPending}
                          data-testid={`button-delete-meeting-type-${mt.id}`}
                          title="Delete meeting type"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="border-t pt-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="md:col-span-2">
              <Label htmlFor="mtName">Name</Label>
              <Input
                id="mtName"
                value={draft.name}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
                placeholder="e.g. Discovery 30min"
                maxLength={80}
                data-testid="input-meeting-type-name"
              />
            </div>
            <div>
              <Label htmlFor="mtDuration">Length (min)</Label>
              <Input
                id="mtDuration"
                type="number"
                min={15}
                max={240}
                step={5}
                value={draft.durationMinutes}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    durationMinutes: Number(e.target.value) || 0,
                  }))
                }
                data-testid="input-meeting-type-duration"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="mtBufferBefore">Before</Label>
                <Input
                  id="mtBufferBefore"
                  type="number"
                  min={0}
                  max={120}
                  step={5}
                  value={draft.bufferBeforeMinutes}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      bufferBeforeMinutes: Number(e.target.value) || 0,
                    }))
                  }
                  data-testid="input-meeting-type-buffer-before"
                />
              </div>
              <div>
                <Label htmlFor="mtBufferAfter">After</Label>
                <Input
                  id="mtBufferAfter"
                  type="number"
                  min={0}
                  max={120}
                  step={5}
                  value={draft.bufferAfterMinutes}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      bufferAfterMinutes: Number(e.target.value) || 0,
                    }))
                  }
                  data-testid="input-meeting-type-buffer-after"
                />
              </div>
            </div>
          </div>
          <div className="mt-3">
            <Button
              type="button"
              onClick={() => create.mutate()}
              disabled={!canSaveCreate}
              data-testid="button-add-meeting-type"
            >
              {create.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-2" />
              )}
              Add meeting type
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
