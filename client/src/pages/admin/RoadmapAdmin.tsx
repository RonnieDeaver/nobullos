/**
 * Task #3728 / #4215 — Roadmap admin (team_lead+): two quarter-based kanban
 * boards (Product Development / Company Development) backing the public
 * /roadmap page and the third-party /roadmap/embed iframe.
 *
 * Columns per board: the current quarter, the next three, any further quarter
 * an open item is scheduled into, "Later" (no quarter yet — no progress bar),
 * and "Done". Cards move three equivalent ways:
 *   - drag & drop (@dnd-kit; pointer + touch sensors — the primary operator
 *     is often on an iPhone, and the grip handle keeps page scroll usable);
 *   - the per-card menu's "Move to…" entries (the always-works fallback);
 *   - the edit dialog's board/release-quarter selects.
 *
 * Dropping into Done PATCHes status:"shipped" (the SERVER stamps
 * `completedAt`); dragging back out un-completes (server clears the stamp).
 * Open items' status is DERIVED from the target quarter (current/past ⇒
 * in_progress, future ⇒ planned, Later ⇒ planned) — the old free-text
 * timeframe input and manual status select are gone.
 *
 * Progress bars are pure date math from shared/roadmapProgress.ts ticking on
 * useNow() — no background job, no refetch. Also here: value-set CRUD cards
 * and the embed snippet generator (now with a board filter).
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Bold,
  Copy,
  ExternalLink,
  GripVertical,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Map as MapIcon,
  MoreHorizontal,
  MoveRight,
  Pencil,
  Plus,
  Strikethrough,
  Trash2,
} from "lucide-react";
import { RoadmapMarkdown } from "@/components/RoadmapMarkdown";
import { PageHeader } from "@/components/admin/PageHeader";
import {
  roadmapBoardLabels,
  roadmapBoards,
  roadmapStatuses,
  roadmapStatusLabels,
  type RoadmapBoard,
  type RoadmapDepartment,
  type RoadmapInitiative,
  type RoadmapStatus,
  type RoadmapType,
} from "@shared/schema";
import {
  addQuarters,
  compareQuarterKeys,
  currentQuarterKey,
  isQuarterKey,
  quarterLabel,
} from "@shared/roadmapProgress";
import { RoadmapProgressBar } from "@/components/RoadmapProgressBar";
import { useNow } from "@/hooks/useNow";

interface AdminPayload {
  departments: RoadmapDepartment[];
  types: RoadmapType[];
  initiatives: RoadmapInitiative[];
  departmentUsage: Record<string, number>;
  typeUsage: Record<string, number>;
  /** The app's configured public address (null when not deployed/configured). */
  publicBaseUrl: string | null;
}

// Kanban column ids: a quarter key ("2026-Q3"), "later", or "done".
type ColumnId = string;
const LATER_COL = "later";
const DONE_COL = "done";
/** Droppable ids get a prefix so they can't collide with card UUIDs. */
const colDroppableId = (colId: ColumnId) => `col:${colId}`;

interface InitiativeForm {
  title: string;
  publicDescription: string;
  internalNotes: string;
  departmentId: string;
  typeId: string;
  board: RoadmapBoard;
  /** Quarter key, or LATER_COL for "no quarter yet". */
  releaseQuarter: string;
  published: boolean;
}

const EMPTY_FORM: InitiativeForm = {
  title: "",
  publicDescription: "",
  internalNotes: "",
  departmentId: "",
  typeId: "",
  board: "product",
  releaseQuarter: LATER_COL,
  published: false,
};

/** completedAt arrives as an ISO string over JSON despite the Date type. */
function toMs(value: RoadmapInitiative["completedAt"]): number {
  if (!value) return 0;
  const d = new Date(value as unknown as string);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function columnLabel(colId: ColumnId): string {
  if (colId === DONE_COL) return "Done";
  if (colId === LATER_COL) return "Later";
  return quarterLabel(colId);
}

export default function RoadmapAdmin() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const now = useNow(60_000);
  const nowQuarter = currentQuarterKey(now);

  const { data, isLoading } = useQuery<AdminPayload>({
    queryKey: ["/api/roadmap/admin"],
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/roadmap/admin"] }); // fire-and-forget: cache refresh only
    // Public payload keys vary by query string — match by prefix.
    void queryClient.invalidateQueries({
      predicate: (q) =>
        typeof q.queryKey[0] === "string" &&
        (q.queryKey[0] as string).startsWith("/api/public/roadmap"),
    }); // fire-and-forget: cache refresh only
  };

  const onError = (err: unknown) =>
    toast({
      title: "Something went wrong",
      description: err instanceof Error ? err.message.replace(/^\d{3}:\s*/, "") : String(err),
      variant: "destructive",
    });

  // ── Board + column derivation ──────────────────────────────────────────────
  const [activeBoard, setActiveBoard] = useState<RoadmapBoard>("product");

  const initiatives = useMemo(() => data?.initiatives ?? [], [data]);
  const boardItems = useMemo(
    () => initiatives.filter((i) => (i.board as RoadmapBoard) === activeBoard),
    [initiatives, activeBoard],
  );

  const columnFor = (item: RoadmapInitiative): ColumnId => {
    if (item.status === "shipped") return DONE_COL;
    if (isQuarterKey(item.releaseQuarter)) return item.releaseQuarter;
    return LATER_COL;
  };

  const quarterColumns = useMemo(() => {
    // Current quarter + the next three, plus any further quarter an open
    // item is already scheduled into (so nothing can ever be off-board).
    const keys = new Set<string>();
    for (let i = 0; i < 4; i++) keys.add(addQuarters(nowQuarter, i));
    for (const item of boardItems) {
      if (item.status !== "shipped" && isQuarterKey(item.releaseQuarter)) {
        keys.add(item.releaseQuarter);
      }
    }
    return [...keys].sort(compareQuarterKeys);
  }, [boardItems, nowQuarter]);

  const columnIds = useMemo<ColumnId[]>(
    () => [...quarterColumns, LATER_COL, DONE_COL],
    [quarterColumns],
  );

  const itemsByColumn = useMemo(() => {
    const map = new Map<ColumnId, RoadmapInitiative[]>();
    for (const id of columnIds) map.set(id, []);
    for (const item of boardItems) map.get(columnFor(item))?.push(item);
    for (const [colId, items] of map) {
      if (colId === DONE_COL) {
        // Most recently completed first; completion time is the order.
        items.sort((a, b) => toMs(b.completedAt) - toMs(a.completedAt) || a.displayOrder - b.displayOrder);
      } else {
        items.sort((a, b) => a.displayOrder - b.displayOrder);
      }
    }
    return map;
  }, [boardItems, columnIds]);

  const deptById = useMemo(
    () => new Map((data?.departments ?? []).map((d) => [d.id, d])),
    [data?.departments],
  );
  const typeById = useMemo(
    () => new Map((data?.types ?? []).map((t) => [t.id, t])),
    [data?.types],
  );

  // ── Move / reorder mutations (optimistic — drops must not snap back) ──────
  type MovePatch = { status?: RoadmapStatus; releaseQuarter?: string | null };

  const applyOptimistic = (
    mutate: (items: RoadmapInitiative[]) => RoadmapInitiative[],
  ): AdminPayload | undefined => {
    const prev = queryClient.getQueryData<AdminPayload>(["/api/roadmap/admin"]);
    if (prev) {
      queryClient.setQueryData<AdminPayload>(["/api/roadmap/admin"], {
        ...prev,
        initiatives: mutate(prev.initiatives),
      });
    }
    return prev;
  };

  const moveMutation = useMutation({
    mutationFn: async ({
      id,
      patch,
      orderedIds,
    }: {
      id: string;
      patch: MovePatch;
      orderedIds?: string[];
    }) => {
      await apiRequest("PATCH", `/api/roadmap/initiatives/${id}`, patch);
      if (orderedIds && orderedIds.length > 1) {
        await apiRequest("POST", "/api/roadmap/initiatives/reorder", { orderedIds });
      }
    },
    onMutate: async ({ id, patch, orderedIds }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/roadmap/admin"] });
      const prev = applyOptimistic((items) =>
        items.map((i) => {
          let next = i;
          if (i.id === id) {
            next = {
              ...i,
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.releaseQuarter !== undefined
                ? { releaseQuarter: patch.releaseQuarter }
                : {}),
              // Mirror the server's completedAt stamping so the Done card
              // renders instantly; the authoritative value arrives on refetch.
              ...(patch.status === "shipped" && i.status !== "shipped"
                ? { completedAt: new Date() as RoadmapInitiative["completedAt"] }
                : {}),
              ...(patch.status !== undefined &&
              patch.status !== "shipped" &&
              i.status === "shipped"
                ? { completedAt: null }
                : {}),
            };
          }
          if (orderedIds) {
            const idx = orderedIds.indexOf(next.id);
            if (idx >= 0) next = { ...next, displayOrder: (idx + 1) * 10 };
          }
          return next;
        }),
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/roadmap/admin"], ctx.prev);
      onError(err);
    },
    onSettled: () => invalidate(),
  });

  const reorderMutation = useMutation({
    mutationFn: async (orderedIds: string[]) => {
      const res = await apiRequest("POST", "/api/roadmap/initiatives/reorder", { orderedIds });
      return res.json();
    },
    onMutate: async (orderedIds: string[]) => {
      await queryClient.cancelQueries({ queryKey: ["/api/roadmap/admin"] });
      const prev = applyOptimistic((items) =>
        items.map((i) => {
          const idx = orderedIds.indexOf(i.id);
          return idx >= 0 ? { ...i, displayOrder: (idx + 1) * 10 } : i;
        }),
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/roadmap/admin"], ctx.prev);
      onError(err);
    },
    onSettled: () => invalidate(),
  });

  /** What a move into `target` means: Done completes; quarters derive status. */
  const patchForTarget = (target: ColumnId): MovePatch => {
    if (target === DONE_COL) return { status: "shipped" };
    if (target === LATER_COL) return { status: "planned", releaseQuarter: null };
    return {
      status: compareQuarterKeys(target, nowQuarter) <= 0 ? "in_progress" : "planned",
      releaseQuarter: target,
    };
  };

  const moveToColumn = (item: RoadmapInitiative, target: ColumnId) => {
    if (columnFor(item) === target) return;
    moveMutation.mutate({ id: item.id, patch: patchForTarget(target) });
  };

  // ── Drag & drop ────────────────────────────────────────────────────────────
  const sensors = useSensors(
    // distance/delay activation keeps plain taps + page scrolling working.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingDeleteItem, setPendingDeleteItem] = useState<RoadmapInitiative | null>(null);
  const activeItem = activeId ? boardItems.find((i) => i.id === activeId) ?? null : null;

  const columnOfCard = (cardId: string): ColumnId | null => {
    for (const [colId, items] of itemsByColumn) {
      if (items.some((i) => i.id === cardId)) return colId;
    }
    return null;
  };

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const cardId = String(active.id);
    const item = boardItems.find((i) => i.id === cardId);
    if (!item) return;
    const sourceCol = columnFor(item);

    const overId = String(over.id);
    let targetCol: ColumnId;
    let targetIndex: number | null;
    if (overId.startsWith("col:")) {
      targetCol = overId.slice(4);
      targetIndex = null; // dropped on the column itself → append
    } else {
      const col = columnOfCard(overId);
      if (!col) return;
      targetCol = col;
      targetIndex = itemsByColumn.get(col)?.findIndex((i) => i.id === overId) ?? null;
    }

    if (targetCol === sourceCol) {
      // Same-column reorder. Done orders by completion time — nothing to do.
      if (sourceCol === DONE_COL) return;
      const ids = (itemsByColumn.get(sourceCol) ?? []).map((i) => i.id);
      const from = ids.indexOf(cardId);
      const to = targetIndex ?? ids.length - 1;
      if (from < 0 || to < 0 || from === to) return;
      reorderMutation.mutate(arrayMove(ids, from, to));
      return;
    }

    // Cross-column move: PATCH + column-scoped reorder so the drop position
    // sticks (Done ignores drop order — completion time orders it).
    let orderedIds: string[] | undefined;
    if (targetCol !== DONE_COL) {
      const ids = (itemsByColumn.get(targetCol) ?? []).map((i) => i.id);
      const insertAt = targetIndex === null ? ids.length : Math.min(targetIndex, ids.length);
      ids.splice(insertAt, 0, cardId);
      orderedIds = ids;
    }
    moveMutation.mutate({ id: cardId, patch: patchForTarget(targetCol), orderedIds });
  };

  // ── Initiative dialog state ────────────────────────────────────────────────
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<InitiativeForm>(EMPTY_FORM);

  const openCreate = () => {
    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      board: activeBoard,
      departmentId: data?.departments[0]?.id ?? "",
      typeId: data?.types[0]?.id ?? "",
    });
    setDialogOpen(true);
  };

  const openEdit = (item: RoadmapInitiative) => {
    setEditingId(item.id);
    setForm({
      title: item.title,
      publicDescription: item.publicDescription ?? "",
      internalNotes: item.internalNotes ?? "",
      departmentId: item.departmentId,
      typeId: item.typeId,
      board: (item.board as RoadmapBoard) ?? "product",
      releaseQuarter: isQuarterKey(item.releaseQuarter) ? item.releaseQuarter : LATER_COL,
      published: item.published,
    });
    setDialogOpen(true);
  };

  // Dialog quarter choices: this quarter + the next seven; when editing an
  // item scheduled into a PAST quarter, keep that quarter selectable so
  // opening + saving the dialog never silently reschedules it.
  const quarterOptions = useMemo(() => {
    const keys = Array.from({ length: 8 }, (_, i) => addQuarters(nowQuarter, i));
    if (editingId) {
      const item = initiatives.find((i) => i.id === editingId);
      if (item && isQuarterKey(item.releaseQuarter) && !keys.includes(item.releaseQuarter)) {
        keys.push(item.releaseQuarter);
        keys.sort(compareQuarterKeys);
      }
    }
    return keys;
  }, [nowQuarter, editingId, initiatives]);

  const formToBody = () => {
    const releaseQuarter = form.releaseQuarter === LATER_COL ? null : form.releaseQuarter;
    const editing = editingId ? initiatives.find((i) => i.id === editingId) : undefined;
    const keepShipped = editing?.status === "shipped";
    return {
      title: form.title.trim(),
      publicDescription: form.publicDescription.trim(),
      internalNotes: form.internalNotes.trim() ? form.internalNotes.trim() : null,
      departmentId: form.departmentId,
      typeId: form.typeId,
      board: form.board,
      releaseQuarter,
      // No manual status control anymore: open items derive status from
      // their quarter; a Done item stays Done (un-complete happens on the
      // board, not in this dialog).
      ...(keepShipped
        ? {}
        : {
            status: (releaseQuarter && compareQuarterKeys(releaseQuarter, nowQuarter) <= 0
              ? "in_progress"
              : "planned") as RoadmapStatus,
          }),
      published: form.published,
    };
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = editingId
        ? await apiRequest("PATCH", `/api/roadmap/initiatives/${editingId}`, formToBody())
        : await apiRequest("POST", "/api/roadmap/initiatives", formToBody());
      return res.json();
    },
    onSuccess: () => {
      setDialogOpen(false);
      invalidate();
      toast({ title: editingId ? "Initiative updated" : "Initiative created" });
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/roadmap/initiatives/${id}`);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Initiative deleted" });
    },
    onError,
  });

  const publishMutation = useMutation({
    mutationFn: async ({ id, published }: { id: string; published: boolean }) => {
      const res = await apiRequest("PATCH", `/api/roadmap/initiatives/${id}`, { published });
      return res.json();
    },
    onSuccess: () => invalidate(),
    onError,
  });

  // ── Value-set mutations (shared by departments + types) ──────────────────
  const valueSetMutation = useMutation({
    mutationFn: async (args: {
      kind: "departments" | "types";
      action: "create" | "rename" | "delete";
      id?: string;
      name?: string;
    }) => {
      const { kind, action, id, name } = args;
      const res =
        action === "create"
          ? await apiRequest("POST", `/api/roadmap/${kind}`, { name })
          : action === "rename"
            ? await apiRequest("PATCH", `/api/roadmap/${kind}/${id}`, { name })
            : await apiRequest("DELETE", `/api/roadmap/${kind}/${id}`);
      return res.json();
    },
    onSuccess: () => invalidate(),
    onError,
  });

  // ── Embed snippet generator state ─────────────────────────────────────────
  const [embedDepartments, setEmbedDepartments] = useState<Set<string>>(new Set());
  const [embedTypes, setEmbedTypes] = useState<Set<string>>(new Set());
  const [embedStatuses, setEmbedStatuses] = useState<Set<string>>(new Set());
  const [embedBoards, setEmbedBoards] = useState<Set<string>>(new Set());

  const toggleIn = (set: Set<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const embedUrl = useMemo(() => {
    // Task #4364 — prefer the app's configured public address so the copied
    // snippet works from an external site; only fall back to the current
    // origin (a dev/preview address) when none is configured yet.
    const base =
      data?.publicBaseUrl ||
      (typeof window !== "undefined" ? window.location.origin : "");
    const params = new URLSearchParams();
    // No boxes checked = no param = show everything in that dimension.
    if (embedBoards.size > 0)
      params.set(
        "boards",
        roadmapBoards.filter((b) => embedBoards.has(b)).join(","),
      );
    if (embedDepartments.size > 0) params.set("departments", [...embedDepartments].join(","));
    if (embedTypes.size > 0) params.set("types", [...embedTypes].join(","));
    if (embedStatuses.size > 0)
      params.set(
        "statuses",
        roadmapStatuses.filter((s) => embedStatuses.has(s)).join(","),
      );
    const qs = params.toString();
    return `${base}/roadmap/embed${qs ? `?${qs}` : ""}`;
  }, [data?.publicBaseUrl, embedBoards, embedDepartments, embedTypes, embedStatuses]);

  // Square corners to match the app's design tokens (no rounded radius).
  const embedSnippet = `<iframe src="${embedUrl}" style="width:100%;height:800px;border:0;" title="NoBull Marketing Roadmap" loading="lazy"></iframe>`;

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(embedSnippet);
      toast({ title: "Embed snippet copied" });
    } catch {
      toast({
        title: "Couldn't copy automatically",
        description: "Select the snippet text and copy it manually.",
        variant: "destructive",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const busy = moveMutation.isPending || reorderMutation.isPending;

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6" data-testid="page-roadmap-admin">
      {/* Header */}
      <PageHeader
        title="Roadmap Admin"
        icon={MapIcon}
        backHref="/"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" asChild data-testid="link-view-public">
              <a href="/roadmap" target="_blank" rel="noreferrer">
                <ExternalLink className="mr-2 h-4 w-4" />
                View public page
              </a>
            </Button>
            <Button onClick={openCreate} data-testid="button-new-initiative">
              <Plus className="mr-2 h-4 w-4" />
              New initiative
            </Button>
          </div>
        }
      />

      {/* Board tabs + kanban */}
      <Tabs value={activeBoard} onValueChange={(v) => setActiveBoard(v as RoadmapBoard)}>
        <TabsList>
          {roadmapBoards.map((b) => (
            <TabsTrigger key={b} value={b} data-testid={`tab-board-${b}`}>
              {roadmapBoardLabels[b]}
              <span className="ml-1.5 text-xs text-muted-foreground">
                {initiatives.filter((i) => (i.board as RoadmapBoard) === b).length}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <ConfirmActionDialog
        open={!!pendingDeleteItem}
        onOpenChange={(open) => { if (!open) setPendingDeleteItem(null); }}
        title={`Delete "${pendingDeleteItem?.title ?? ""}"?`}
        description="The initiative is removed from the roadmap immediately, including any published client-facing view. This cannot be undone."
        confirmLabel="Delete initiative"
        testId="dialog-confirm-delete-initiative"
        onConfirm={() => {
          if (pendingDeleteItem) deleteMutation.mutate(pendingDeleteItem.id);
          setPendingDeleteItem(null);
        }}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex gap-3 overflow-x-auto pb-3" data-testid={`board-${activeBoard}`}>
          {columnIds.map((colId) => {
            const items = itemsByColumn.get(colId) ?? [];
            return (
              <KanbanColumn
                key={colId}
                colId={colId}
                title={columnLabel(colId)}
                count={items.length}
                isCurrent={colId === nowQuarter}
                isDone={colId === DONE_COL}
              >
                <SortableContext
                  items={items.map((i) => i.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {items.length === 0 ? (
                    <div
                      className="border border-dashed p-4 text-center text-xs text-muted-foreground"
                      data-testid={`empty-${colId}`}
                    >
                      {colId === DONE_COL ? "Nothing completed yet" : "Drop cards here"}
                    </div>
                  ) : (
                    items.map((item) => (
                      <KanbanCard
                        key={item.id}
                        item={item}
                        deptName={deptById.get(item.departmentId)?.name ?? "—"}
                        typeName={typeById.get(item.typeId)?.name ?? "—"}
                        now={now}
                        busy={busy}
                        moveTargets={columnIds.filter((c) => c !== columnFor(item))}
                        onMove={(target) => moveToColumn(item, target)}
                        onEdit={() => openEdit(item)}
                        onDelete={() => setPendingDeleteItem(item)}
                        onTogglePublish={(published) =>
                          publishMutation.mutate({ id: item.id, published })
                        }
                      />
                    ))
                  )}
                </SortableContext>
              </KanbanColumn>
            );
          })}
        </div>
        <DragOverlay>
          {activeItem ? (
            <div className="w-64 rotate-2 border bg-card p-3 shadow-lg">
              <div className="text-sm font-medium leading-snug">{activeItem.title}</div>
              <div className="mt-2">
                <RoadmapProgressBar
                  status={activeItem.status}
                  releaseQuarter={activeItem.releaseQuarter}
                  completedAt={activeItem.completedAt}
                  now={now}
                  size="sm"
                />
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Value sets */}
      <div className="grid gap-6 md:grid-cols-2">
        {(
          [
            {
              kind: "departments" as const,
              title: "Departments",
              rows: data?.departments ?? [],
              usage: data?.departmentUsage ?? {},
            },
            {
              kind: "types" as const,
              title: "Types",
              rows: data?.types ?? [],
              usage: data?.typeUsage ?? {},
            },
          ]
        ).map(({ kind, title, rows, usage }) => (
          <ValueSetCard
            key={kind}
            kind={kind}
            title={title}
            rows={rows}
            usage={usage}
            pending={valueSetMutation.isPending}
            onCreate={(name) => valueSetMutation.mutate({ kind, action: "create", name })}
            onRename={(id, name) => valueSetMutation.mutate({ kind, action: "rename", id, name })}
            onDelete={(id) => valueSetMutation.mutate({ kind, action: "delete", id })}
          />
        ))}
      </div>

      {/* Embed snippet generator */}
      <Card data-testid="card-embed-generator">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Embed on an external website</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Pick what the embed should show (nothing checked = show everything), then copy the
            iframe snippet into any website. Only published initiatives ever appear.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Boards
              </p>
              <div className="space-y-1.5">
                {roadmapBoards.map((b) => (
                  <label key={b} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={embedBoards.has(b)}
                      onCheckedChange={() => setEmbedBoards((s) => toggleIn(s, b))}
                      aria-label={roadmapBoardLabels[b]}
                      data-testid={`checkbox-embed-board-${b}`}
                    />
                    {roadmapBoardLabels[b]}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Departments
              </p>
              <div className="space-y-1.5">
                {(data?.departments ?? []).map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={embedDepartments.has(d.slug)}
                      onCheckedChange={() => setEmbedDepartments((s) => toggleIn(s, d.slug))}
                      aria-label={d.name}
                      data-testid={`checkbox-embed-department-${d.slug}`}
                    />
                    {d.name}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Types
              </p>
              <div className="space-y-1.5">
                {(data?.types ?? []).map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={embedTypes.has(t.slug)}
                      onCheckedChange={() => setEmbedTypes((s) => toggleIn(s, t.slug))}
                      aria-label={t.name}
                      data-testid={`checkbox-embed-type-${t.slug}`}
                    />
                    {t.name}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Statuses
              </p>
              <div className="space-y-1.5">
                {roadmapStatuses.map((s) => (
                  <label key={s} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={embedStatuses.has(s)}
                      onCheckedChange={() => setEmbedStatuses((set) => toggleIn(set, s))}
                      aria-label={roadmapStatusLabels[s]}
                      data-testid={`checkbox-embed-status-${s}`}
                    />
                    {roadmapStatusLabels[s]}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="embed-snippet">Snippet</Label>
            <Textarea
              id="embed-snippet"
              readOnly
              value={embedSnippet}
              className="font-mono text-xs"
              rows={3}
              onFocus={(e) => e.currentTarget.select()}
              data-testid="textarea-embed-snippet"
            />
            <div className="flex items-center gap-2">
              <Button onClick={copySnippet} data-testid="button-copy-embed">
                <Copy className="mr-2 h-4 w-4" />
                Copy snippet
              </Button>
              <Button variant="outline" asChild data-testid="link-embed-preview">
                <a href={embedUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Preview embed
                </a>
              </Button>
            </div>
            {data && !data.publicBaseUrl && (
              <p className="text-xs text-muted-foreground" data-testid="text-embed-env-note">
                The snippet uses this workspace&apos;s address for now — once the app is published,
                it switches to the permanent public address automatically.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Initiative create/edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit initiative" : "New initiative"}</DialogTitle>
            <DialogDescription>
              Only the title, public description, department, type, board, and release quarter
              appear publicly — internal notes never leave the team.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="init-title">Title</Label>
              <Input
                id="init-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Launch client-facing reporting portal"
                data-testid="input-title"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="init-description">Public description</Label>
              <MarkdownField
                id="init-description"
                slug="public-description"
                value={form.publicDescription}
                onChange={(v) => setForm((f) => ({ ...f, publicDescription: v }))}
                placeholder="Visitor-facing summary of the initiative"
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="init-notes">Internal notes (never public)</Label>
              <MarkdownField
                id="init-notes"
                slug="internal-notes"
                value={form.internalNotes}
                onChange={(v) => setForm((f) => ({ ...f, internalNotes: v }))}
                placeholder="Owner, blockers, links — team only"
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Board</Label>
                <Select
                  value={form.board}
                  onValueChange={(v) => setForm((f) => ({ ...f, board: v as RoadmapBoard }))}
                >
                  <SelectTrigger data-testid="select-board">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roadmapBoards.map((b) => (
                      <SelectItem key={b} value={b}>
                        {roadmapBoardLabels[b]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Release quarter</Label>
                <Select
                  value={form.releaseQuarter}
                  onValueChange={(v) => setForm((f) => ({ ...f, releaseQuarter: v }))}
                >
                  <SelectTrigger data-testid="select-release-quarter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={LATER_COL}>Later (no quarter yet)</SelectItem>
                    {quarterOptions.map((q) => (
                      <SelectItem key={q} value={q}>
                        {quarterLabel(q)}
                        {q === nowQuarter ? " — current" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Department</Label>
                <Select
                  value={form.departmentId}
                  onValueChange={(v) => setForm((f) => ({ ...f, departmentId: v }))}
                >
                  <SelectTrigger data-testid="select-department">
                    <SelectValue placeholder="Pick a department" />
                  </SelectTrigger>
                  <SelectContent>
                    {(data?.departments ?? []).map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select
                  value={form.typeId}
                  onValueChange={(v) => setForm((f) => ({ ...f, typeId: v }))}
                >
                  <SelectTrigger data-testid="select-type">
                    <SelectValue placeholder="Pick a type" />
                  </SelectTrigger>
                  <SelectContent>
                    {(data?.types ?? []).map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between border p-3">
              <div>
                <Label htmlFor="init-published" className="font-medium">
                  Published
                </Label>
                <p className="text-xs text-muted-foreground">
                  Unpublished initiatives stay hidden from the public page, the embed, and the
                  public JSON.
                </p>
              </div>
              <Switch
                id="init-published"
                checked={form.published}
                onCheckedChange={(published) => setForm((f) => ({ ...f, published }))}
                data-testid="switch-form-published"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} data-testid="button-cancel">
              Cancel
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={
                saveMutation.isPending ||
                !form.title.trim() ||
                !form.departmentId ||
                !form.typeId
              }
              data-testid="button-save-initiative"
            >
              {saveMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {editingId ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Kanban building blocks ───────────────────────────────────────────────────

function KanbanColumn({
  colId,
  title,
  count,
  isCurrent,
  isDone,
  children,
}: {
  colId: ColumnId;
  title: string;
  count: number;
  isCurrent: boolean;
  isDone: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: colDroppableId(colId) });
  return (
    <div
      ref={setNodeRef}
      className={`flex w-72 shrink-0 flex-col border transition-colors ${
        isOver
          ? "border-primary bg-primary/5"
          : isDone
            ? "border-emerald-200 bg-emerald-50/40"
            : "border-border bg-muted/40"
      }`}
      data-testid={`column-${colId}`}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <span className="text-sm font-semibold">{title}</span>
        {isCurrent ? (
          <Badge
            variant="outline"
            className="border-primary/40 px-1.5 py-0 text-xs text-primary dark:text-foreground"
          >
            Current
          </Badge>
        ) : null}
        <span
          className="ml-auto rounded-pill bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground"
          data-testid={`count-${colId}`}
        >
          {count}
        </span>
      </div>
      <div className="flex min-h-[140px] flex-1 flex-col gap-2 p-2">{children}</div>
    </div>
  );
}

function KanbanCard({
  item,
  deptName,
  typeName,
  now,
  busy,
  moveTargets,
  onMove,
  onEdit,
  onDelete,
  onTogglePublish,
}: {
  item: RoadmapInitiative;
  deptName: string;
  typeName: string;
  now: Date;
  busy: boolean;
  moveTargets: ColumnId[];
  onMove: (target: ColumnId) => void;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePublish: (published: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  const done = item.status === "shipped";
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-40" : undefined}
    >
      <div
        className={`border p-3 shadow-sm ${
          done ? "border-emerald-200 bg-emerald-50/60" : "bg-card"
        }`}
        data-testid={`card-initiative-${item.id}`}
      >
        <div className="flex items-start gap-1.5">
          <button
            type="button"
            className="mt-0.5 shrink-0 cursor-grab touch-none rounded p-0.5 text-muted-foreground/50 hover:text-muted-foreground"
            aria-label="Drag to move"
            data-testid={`handle-drag-${item.id}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div
              className={`text-sm font-medium leading-snug ${done ? "text-emerald-900" : ""}`}
              data-testid={`text-initiative-title-${item.id}`}
            >
              {item.title}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {deptName} · {typeName}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                disabled={busy}
                aria-label={`Actions for ${item.title}`}
                data-testid={`button-card-menu-${item.id}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="flex items-center gap-1.5 text-xs">
                <MoveRight className="h-3.5 w-3.5" />
                Move to…
              </DropdownMenuLabel>
              {moveTargets.map((target) => (
                <DropdownMenuItem
                  key={target}
                  onClick={() => onMove(target)}
                  data-testid={`menuitem-move-${item.id}-${target}`}
                >
                  {columnLabel(target)}
                  {target === DONE_COL ? " (complete)" : ""}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onEdit} data-testid={`menuitem-edit-${item.id}`}>
                <Pencil className="mr-2 h-3.5 w-3.5" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onDelete}
                className="text-destructive focus:text-destructive"
                data-testid={`menuitem-delete-${item.id}`}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="mt-2">
          <RoadmapProgressBar
            status={item.status}
            releaseQuarter={item.releaseQuarter}
            completedAt={item.completedAt}
            now={now}
            size="sm"
            testId={`progress-${item.id}`}
          />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            {item.published ? "Published" : "Draft"}
          </span>
          <Switch
            className="scale-90"
            checked={item.published}
            onCheckedChange={onTogglePublish}
            data-testid={`switch-published-${item.id}`}
          />
        </div>
      </div>
    </div>
  );
}

// ── Value-set card (departments / types) ─────────────────────────────────────

function ValueSetCard({
  kind,
  title,
  rows,
  usage,
  pending,
  onCreate,
  onRename,
  onDelete,
}: {
  kind: "departments" | "types";
  title: string;
  rows: Array<RoadmapDepartment | RoadmapType>;
  usage: Record<string, number>;
  pending: boolean;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  return (
    <Card data-testid={`card-${kind}`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={`Add a ${kind === "departments" ? "department" : "type"}…`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) {
                onCreate(newName.trim());
                setNewName("");
              }
            }}
            aria-label={`Add a ${kind === "departments" ? "department" : "type"}`}
            data-testid={`input-new-${kind}`}
          />
          <Button
            size="sm"
            disabled={pending || !newName.trim()}
            onClick={() => {
              onCreate(newName.trim());
              setNewName("");
            }}
            aria-label={`Add ${kind === "departments" ? "department" : "type"}`}
            data-testid={`button-add-${kind}`}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-1.5">
          {rows.map((row) => {
            const used = usage[row.id] ?? 0;
            return (
              <div
                key={row.id}
                className="flex items-center gap-2 border px-3 py-2"
                data-testid={`row-${kind}-${row.slug}`}
              >
                {renamingId === row.id ? (
                  <>
                    <Input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      className="h-8"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && renameValue.trim()) {
                          onRename(row.id, renameValue.trim());
                          setRenamingId(null);
                        }
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      autoFocus
                      aria-label={`Rename ${row.name}`}
                      data-testid={`input-rename-${kind}-${row.slug}`}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || !renameValue.trim()}
                      onClick={() => {
                        onRename(row.id, renameValue.trim());
                        setRenamingId(null);
                      }}
                      data-testid={`button-save-rename-${kind}-${row.slug}`}
                    >
                      Save
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {used > 0 ? `${used} in use` : "unused"}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => {
                        setRenamingId(row.id);
                        setRenameValue(row.name);
                      }}
                      aria-label={`Rename ${row.name}`}
                      data-testid={`button-rename-${kind}-${row.slug}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <ConfirmActionDialog
                      title={`Delete "${row.name}"?`}
                      description={`The ${kind} is removed from the roadmap taxonomy immediately. Only unused entries can be deleted, so no initiatives are affected. This cannot be undone.`}
                      confirmLabel="Delete"
                      testId={`dialog-confirm-delete-${kind}-${row.slug}`}
                      onConfirm={() => onDelete(row.id)}
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          disabled={pending || used > 0}
                          title={used > 0 ? "Reassign its initiatives first" : "Delete"}
                          data-testid={`button-delete-${kind}-${row.slug}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      }
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Markdown field: textarea + formatting toolbar + write/preview (#4266) ────

/**
 * The dialog's prose fields take markdown, authored the same way as the Comms
 * composer and the ClickUp comment composer: a plain textarea plus a toolbar
 * whose buttons wrap the CURRENT selection with markdown markers (list
 * buttons prefix every selected line instead). After every edit the selection
 * is restored over the same text, so chaining formats keeps working. The
 * Preview tab renders through the shared RoadmapMarkdown component — exactly
 * what the public page / embed / report block will show.
 */
function MarkdownField({
  id,
  slug,
  value,
  onChange,
  placeholder,
  rows,
}: {
  id: string;
  /** data-testid stem: textarea keeps its historical `input-${slug}` id. */
  slug: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows: number;
}) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** Commit an edit, then restore focus + selection (kept usable for chaining). */
  const applyEdit = (next: string, selStart: number, selEnd: number) => {
    onChange(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(selStart, selEnd);
    });
  };

  const wrapSelection = (pre: string, suf = pre) => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end, value: v } = el;
    const selected = v.slice(start, end) || "text";
    applyEdit(
      v.slice(0, start) + pre + selected + suf + v.slice(end),
      start + pre.length,
      start + pre.length + selected.length,
    );
  };

  /** Prefix every line the selection touches ("- ", or "1. " / "2. " / …). */
  const prefixLines = (ordered: boolean) => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end, value: v } = el;
    const lineStart = v.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = v.indexOf("\n", end);
    if (lineEnd === -1) lineEnd = v.length;
    const block = v.slice(lineStart, lineEnd);
    const newBlock = block
      .split("\n")
      .map((line, i) => (ordered ? `${i + 1}. ` : "- ") + line)
      .join("\n");
    applyEdit(
      v.slice(0, lineStart) + newBlock + v.slice(lineEnd),
      start + (ordered ? 3 : 2),
      end + (newBlock.length - block.length),
    );
  };

  /** Insert `[selection](https://)` with the URL part selected for typing over. */
  const insertLink = () => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end, value: v } = el;
    const selected = v.slice(start, end) || "link text";
    const url = "https://";
    const urlStart = start + 1 + selected.length + 2; // "[" + text + "]("
    applyEdit(
      `${v.slice(0, start)}[${selected}](${url})${v.slice(end)}`,
      urlStart,
      urlStart + url.length,
    );
  };

  const tools: Array<{ key: string; title: string; icon: ReactNode; run: () => void }> = [
    { key: "bold", title: "Bold", icon: <Bold className="h-3.5 w-3.5" />, run: () => wrapSelection("**") },
    { key: "italic", title: "Italic", icon: <Italic className="h-3.5 w-3.5" />, run: () => wrapSelection("*") },
    { key: "strike", title: "Strikethrough", icon: <Strikethrough className="h-3.5 w-3.5" />, run: () => wrapSelection("~~") },
    { key: "ul", title: "Bulleted list", icon: <List className="h-3.5 w-3.5" />, run: () => prefixLines(false) },
    { key: "ol", title: "Numbered list", icon: <ListOrdered className="h-3.5 w-3.5" />, run: () => prefixLines(true) },
    { key: "link", title: "Link", icon: <Link2 className="h-3.5 w-3.5" />, run: insertLink },
  ];

  return (
    <div className="border">
      <div className="flex items-center gap-0.5 border-b bg-muted/40 px-1.5 py-1">
        {tools.map((t) => (
          <button
            key={t.key}
            type="button"
            title={t.title}
            aria-label={t.title}
            disabled={mode === "preview"}
            onClick={t.run}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            data-testid={`button-${slug}-${t.key}`}
          >
            {t.icon}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-0.5">
          {(["write", "preview"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium capitalize ${
                mode === m
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`button-${slug}-${m}`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      {mode === "write" ? (
        <Textarea
          id={id}
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          className="rounded-t-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
          data-testid={`input-${slug}`}
        />
      ) : (
        <div
          className="px-3 py-2 text-sm"
          style={{ minHeight: rows * 20 + 16 }}
          data-testid={`preview-${slug}`}
        >
          {value.trim() ? (
            <RoadmapMarkdown source={value} />
          ) : (
            <p className="italic text-muted-foreground">Nothing to preview yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
