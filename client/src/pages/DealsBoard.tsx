/**
 * Task #4327 — Deals pipeline board.
 *
 * Kanban of deals grouped by stage for the default "Sales" pipeline.
 * Mirrors the roadmap/ATS board interaction language: @dnd-kit drag with a
 * grip handle, droppable stage columns, and a drag overlay. Dragging a card
 * into another stage POSTs /api/deals/:id/move — the ONLY stage writer, so
 * every move lands in deal_stage_history with who/when. A 422 answer means
 * the target stage requires fields the deal lacks; DealRequiredFieldsDialog
 * collects them and retries the same move.
 *
 * The header strip shows per-stage totals and the weighted forecast
 * (amount × stage win probability) across open stages.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import {
  ArrowRightLeft,
  Briefcase,
  Building2,
  CalendarDays,
  Gauge,
  GripVertical,
  Loader2,
  Plus,
  User as UserIcon,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import {
  DealRequiredFieldsDialog,
  formatDealAmount,
  postDealMove,
  type DealMoveFields,
  type RequiredFieldsPrompt,
} from "@/components/DealRequiredFieldsDialog";
import { TagChipRow, type TagChipData } from "@/components/tags/TagChip";
import { EmptyState } from "@/components/kit/EmptyState";
import type { Deal, DealPipeline, DealStage } from "@shared/schema";

type PipelineWithStages = DealPipeline & { stages: DealStage[] };

export type BoardDeal = Deal & {
  clientFirmName: string | null;
  ownerName: string | null;
  stageName: string | null;
  contactIds: string[];
  // Task #4333 — deterministic fit+engagement score (null until first
  // compute). Serialized timestamps arrive as ISO strings.
  score: number | null;
  fitScore: number | null;
  engagementScore: number | null;
  scoreComputedAt: string | null;
};

const DEALS_QUERY_KEY = ["/api/deals"] as const;

/**
 * Keyboard drags jump whole stage columns instead of inching 25px per press:
 * ←/→ (and the same keys in the stacked phone layout) move the lifted card to
 * the previous/next column's center in reading order, ↑/↓ nudge within a
 * column. Space/Enter lifts and drops, Esc cancels — dnd-kit's KeyboardSensor
 * defaults. Works for both the lg+ row layout and the stacked single-column
 * layout because columns are ordered by their on-screen position.
 */
const stageColumnCoordinateGetter: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates, context },
) => {
  switch (event.code) {
    case "ArrowUp":
      return { ...currentCoordinates, y: currentCoordinates.y - 25 };
    case "ArrowDown":
      return { ...currentCoordinates, y: currentCoordinates.y + 25 };
    case "ArrowLeft":
    case "ArrowRight": {
      const centers: { x: number; y: number }[] = [];
      for (const container of context.droppableContainers.getEnabled()) {
        if (!String(container.id).startsWith("stage:")) continue;
        const rect = context.droppableRects.get(container.id);
        if (!rect) continue;
        centers.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }
      if (centers.length === 0) return undefined;
      centers.sort((a, b) => a.x - b.x || a.y - b.y);
      let nearest = 0;
      let best = Number.POSITIVE_INFINITY;
      centers.forEach((c, i) => {
        const d =
          (c.x - currentCoordinates.x) ** 2 + (c.y - currentCoordinates.y) ** 2;
        if (d < best) {
          best = d;
          nearest = i;
        }
      });
      const target = centers[nearest + (event.code === "ArrowRight" ? 1 : -1)];
      return target ? { x: target.x, y: target.y } : undefined;
    }
  }
  return undefined;
};

function daysSince(iso: string | Date | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

export default function DealsBoard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Mirrors the server hierarchy (requireTeamLead): team_lead and ceo only.
  const { user: authUser } = useAuth();
  const isTeamLead = authUser?.role === "team_lead" || authUser?.role === "ceo";

  const pipelinesQuery = useQuery<PipelineWithStages[]>({
    queryKey: ["/api/deals/pipelines"],
  });
  const dealsQuery = useQuery<BoardDeal[]>({ queryKey: [...DEALS_QUERY_KEY] });

  // Task #4329 — one board-level query covers every card's chips (no per-card
  // fetches) and powers the tag filter.
  const tagsQuery = useQuery<{
    tags: (TagChipData & { criteria: unknown })[];
    assignments: { tagId: string; entityId: string; source: "manual" | "rule" }[];
  }>({ queryKey: ["/api/tags?entityType=deal&includeAssignments=1"] });
  const [tagFilter, setTagFilter] = useState<string>("all");
  // Task #4333 — score-based ranking: order cards within each column and
  // optionally hide deals below a threshold (both client-side; the board
  // query already carries each deal's score).
  const [sortBy, setSortBy] = useState<"newest" | "score">("newest");
  const [minScore, setMinScore] = useState<string>("");

  const tagsByDeal = useMemo(() => {
    const map = new Map<string, TagChipData[]>();
    const tagById = new Map(
      (tagsQuery.data?.tags ?? []).map((t) => [t.id, t]),
    );
    for (const a of tagsQuery.data?.assignments ?? []) {
      const tag = tagById.get(a.tagId);
      if (!tag) continue;
      const list = map.get(a.entityId) ?? [];
      // A record can carry the same tag once per source only; keep first.
      if (!list.some((t) => t.id === tag.id)) {
        list.push({ id: tag.id, name: tag.name, color: tag.color, source: a.source });
      }
      map.set(a.entityId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  }, [tagsQuery.data]);

  const pipeline = useMemo(
    () =>
      pipelinesQuery.data?.find((p) => p.isDefault) ?? pipelinesQuery.data?.[0],
    [pipelinesQuery.data],
  );
  const stages = useMemo(() => pipeline?.stages ?? [], [pipeline]);
  const deals = useMemo(() => {
    let all = dealsQuery.data ?? [];
    if (tagFilter !== "all") {
      all = all.filter((d) => (tagsByDeal.get(d.id) ?? []).some((t) => t.id === tagFilter));
    }
    const threshold = minScore.trim() === "" ? null : Number(minScore);
    if (threshold !== null && Number.isFinite(threshold)) {
      // Unscored deals (score null) can't clear a threshold.
      all = all.filter((d) => d.score !== null && d.score >= threshold);
    }
    return all;
  }, [dealsQuery.data, tagFilter, tagsByDeal, minScore]);

  const dealsByStage = useMemo(() => {
    const map = new Map<string, BoardDeal[]>();
    for (const stage of stages) map.set(stage.id, []);
    for (const deal of deals) {
      const list = map.get(deal.stageId);
      if (list) list.push(deal);
    }
    if (sortBy === "score") {
      // Highest score first; unscored last. Ties keep the server's
      // newest-first order (Array.prototype.sort is stable).
      for (const list of map.values()) {
        list.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
      }
    }
    return map;
  }, [stages, deals, sortBy]);

  // Weighted forecast across open stages: Σ amount × winProbability.
  const forecast = useMemo(() => {
    let weighted = 0;
    let openTotal = 0;
    let openCount = 0;
    for (const stage of stages) {
      if (stage.stageType !== "open") continue;
      for (const deal of dealsByStage.get(stage.id) ?? []) {
        const amount = deal.amount ?? 0;
        openTotal += amount;
        weighted += (amount * stage.winProbability) / 100;
        openCount += 1;
      }
    }
    return { weighted, openTotal, openCount };
  }, [stages, dealsByStage]);

  // ── Drag & drop ────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    // Keyboard equivalent for drag: focus a card's grip handle, Space/Enter
    // to lift, arrows to pick a column, Space/Enter to drop.
    useSensor(KeyboardSensor, { coordinateGetter: stageColumnCoordinateGetter }),
  );
  const [activeDealId, setActiveDealId] = useState<string | null>(null);
  const activeDeal = activeDealId
    ? deals.find((d) => d.id === activeDealId)
    : undefined;

  const [requiredPrompt, setRequiredPrompt] = useState<RequiredFieldsPrompt | null>(null);
  const [moving, setMoving] = useState(false);

  async function attemptMove(
    deal: BoardDeal,
    toStage: DealStage,
    fields?: DealMoveFields,
  ) {
    setMoving(true);
    // Optimistic: shift the card into the target column immediately.
    const prev = queryClient.getQueryData<BoardDeal[]>([...DEALS_QUERY_KEY]);
    if (prev) {
      queryClient.setQueryData<BoardDeal[]>(
        [...DEALS_QUERY_KEY],
        prev.map((d) =>
          d.id === deal.id ? { ...d, stageId: toStage.id, stageName: toStage.name } : d,
        ),
      );
    }
    try {
      const result = await postDealMove(deal.id, toStage.id, fields);
      if (result.ok) {
        setRequiredPrompt(null);
        void queryClient.invalidateQueries({ queryKey: [...DEALS_QUERY_KEY] });
        return;
      }
      if (prev) queryClient.setQueryData([...DEALS_QUERY_KEY], prev);
      if (result.status === 422 && result.missingFields?.length) {
        setRequiredPrompt({
          dealId: deal.id,
          dealName: deal.name,
          toStageId: toStage.id,
          toStageName: toStage.name,
          missingFields: result.missingFields,
        });
        return;
      }
      toast({
        title: "Couldn't move deal",
        description: result.error ?? "Something went wrong. Try again.",
        variant: "destructive",
      });
    } catch {
      // Network/aborted request: roll back the optimistic stage change and
      // surface it — otherwise the card silently stays in the wrong column.
      if (prev) queryClient.setQueryData([...DEALS_QUERY_KEY], prev);
      toast({
        title: "Couldn't move deal",
        description: "Something went wrong. Try again.",
        variant: "destructive",
      });
    } finally {
      setMoving(false);
    }
  }

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDealId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDealId(null);
    const { active, over } = event;
    if (!over) return;
    const deal = deals.find((d) => d.id === String(active.id));
    if (!deal) return;
    const overId = String(over.id);
    const stageId = overId.startsWith("stage:") ? overId.slice(6) : null;
    if (!stageId || stageId === deal.stageId) return;
    const toStage = stages.find((s) => s.id === stageId);
    if (!toStage) return;
    void attemptMove(deal, toStage);
  };

  // ── Create deal dialog ─────────────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);

  const isLoading = pipelinesQuery.isLoading || dealsQuery.isLoading;
  const loadFailed = pipelinesQuery.isError || dealsQuery.isError;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6" data-testid="page-deals-board">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Briefcase className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold" data-testid="text-deals-title">
            {pipeline ? `${pipeline.name} pipeline` : "Deals"}
          </h1>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          {(tagsQuery.data?.tags.length ?? 0) > 0 && (
            <Select value={tagFilter} onValueChange={setTagFilter}>
              <SelectTrigger className="h-9 w-44" data-testid="select-tag-filter">
                <SelectValue placeholder="All tags" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tags</SelectItem>
                {(tagsQuery.data?.tags ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as "newest" | "score")}>
            <SelectTrigger className="h-9 w-36" data-testid="select-score-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Sort: Newest</SelectItem>
              <SelectItem value="score">Sort: Score</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="number"
            inputMode="numeric"
            value={minScore}
            onChange={(e) => setMinScore(e.target.value)}
            placeholder="Min score"
            aria-label="Minimum lead score"
            className="h-9 w-24 min-w-0"
            data-testid="input-min-score"
          />
          <div className="hidden items-center gap-4 text-sm sm:flex" data-testid="strip-forecast">
            <div>
              <span className="text-muted-foreground">Open: </span>
              <span className="font-medium" data-testid="text-open-total">
                {formatDealAmount(forecast.openTotal)}
              </span>
              <span className="text-muted-foreground"> · {forecast.openCount} deals</span>
            </div>
            <div>
              <span className="text-muted-foreground">Weighted forecast: </span>
              <span className="font-semibold" data-testid="text-weighted-forecast">
                {formatDealAmount(Math.round(forecast.weighted))}
              </span>
            </div>
          </div>
          {isTeamLead && (
            <Button asChild variant="outline" data-testid="button-deal-automations">
              <Link href="/admin/deal-automation">
                <Zap className="mr-1.5 h-4 w-4" />
                Automations
              </Link>
            </Button>
          )}
          <Button onClick={() => setCreateOpen(true)} data-testid="button-new-deal">
            <Plus className="mr-1.5 h-4 w-4" />
            New Deal
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading pipeline…
        </div>
      ) : loadFailed ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive" data-testid="text-board-error">
          Couldn't load the deals board. Refresh to try again.
        </div>
      ) : !pipeline || stages.length === 0 ? (
        <EmptyState
          icon={<Briefcase />}
          title="No pipeline configured yet"
          description="A sales pipeline with stages is needed before deals can appear on the board."
          testId="empty-no-pipeline"
        />
      ) : deals.length === 0 ? (
        <EmptyState
          icon={<Briefcase />}
          title={
            tagFilter !== "all" || minScore.trim() !== ""
              ? "No deals match these filters"
              : "No deals yet"
          }
          description={
            tagFilter !== "all" || minScore.trim() !== ""
              ? "Clear the tag or minimum-score filter to see the full pipeline."
              : "Track your first opportunity through the pipeline to see it here."
          }
          action={
            tagFilter === "all" && minScore.trim() === "" ? (
              <Button onClick={() => setCreateOpen(true)} data-testid="button-empty-new-deal">
                <Plus className="mr-1.5 h-4 w-4" />
                New Deal
              </Button>
            ) : undefined
          }
          testId="empty-no-deals"
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDealId(null)}
        >
          {/* Phones/tablets get stacked full-width stages (no page h-scroll);
              lg+ keeps the kanban row inside a contained scroll wrapper. */}
          <div className="min-w-0 pb-4 lg:overflow-x-auto">
            <div className="flex flex-col gap-3 lg:min-w-max lg:flex-row" data-testid="row-stage-columns">
              {stages.map((stage) => (
                <StageColumn
                  key={stage.id}
                  stage={stage}
                  deals={dealsByStage.get(stage.id) ?? []}
                  tagsByDeal={tagsByDeal}
                  stages={stages}
                  onMoveToStage={(deal, toStage) => void attemptMove(deal, toStage)}
                />
              ))}
            </div>
          </div>
          <DragOverlay>
            {activeDeal ? (
              <DealCard deal={activeDeal} tags={tagsByDeal.get(activeDeal.id)} overlay />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      <DealRequiredFieldsDialog
        prompt={requiredPrompt}
        submitting={moving}
        onCancel={() => setRequiredPrompt(null)}
        onSubmit={(fields) => {
          const deal = deals.find((d) => d.id === requiredPrompt?.dealId);
          const toStage = stages.find((s) => s.id === requiredPrompt?.toStageId);
          if (deal && toStage) void attemptMove(deal, toStage, fields);
        }}
      />

      <CreateDealDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: [...DEALS_QUERY_KEY] });
        }}
      />
    </div>
  );
}

// ── Column ─────────────────────────────────────────────────────────────────

function StageColumn({
  stage,
  deals,
  tagsByDeal,
  stages,
  onMoveToStage,
}: {
  stage: DealStage;
  deals: BoardDeal[];
  tagsByDeal: Map<string, TagChipData[]>;
  stages: DealStage[];
  onMoveToStage: (deal: BoardDeal, toStage: DealStage) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage:${stage.id}` });
  const total = deals.reduce((sum, d) => sum + (d.amount ?? 0), 0);
  const tone =
    stage.stageType === "won"
      ? "border-status-ok/30 bg-status-ok/10"
      : stage.stageType === "lost"
        ? "border-status-critical/30 bg-status-critical/10"
        : "border-border bg-muted/40";
  return (
    <div
      ref={setNodeRef}
      className={`flex max-h-[calc(100vh-14rem)] w-full shrink-0 flex-col rounded-xl border transition-colors lg:w-64 ${
        isOver ? "border-primary bg-primary/5" : tone
      }`}
      data-testid={`column-stage-${stage.slug}`}
    >
      <div className="border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{stage.name}</span>
          <span
            className="ml-auto rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground"
            data-testid={`count-stage-${stage.slug}`}
          >
            {deals.length}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span data-testid={`total-stage-${stage.slug}`}>{formatDealAmount(total)}</span>
          <span>·</span>
          <span>{stage.winProbability}%</span>
        </div>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {deals.map((deal) => (
          <DraggableDealCard
            key={deal.id}
            deal={deal}
            tags={tagsByDeal.get(deal.id)}
            stages={stages}
            onMoveToStage={onMoveToStage}
          />
        ))}
        {deals.length === 0 && (
          <div className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
            No deals
          </div>
        )}
      </div>
    </div>
  );
}

// ── Cards ──────────────────────────────────────────────────────────────────

type DragHandleProps = Pick<ReturnType<typeof useDraggable>, "attributes" | "listeners">;

function DraggableDealCard({
  deal,
  tags,
  stages,
  onMoveToStage,
}: {
  deal: BoardDeal;
  tags?: TagChipData[];
  stages: DealStage[];
  onMoveToStage: (deal: BoardDeal, toStage: DealStage) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: deal.id,
  });
  return (
    <div ref={setNodeRef} className={isDragging ? "opacity-40" : undefined}>
      <DealCard
        deal={deal}
        tags={tags}
        dragHandle={{ attributes, listeners }}
        stages={stages}
        onMoveToStage={onMoveToStage}
      />
    </div>
  );
}

function DealCard({
  deal,
  tags,
  dragHandle,
  overlay,
  stages,
  onMoveToStage,
}: {
  deal: BoardDeal;
  tags?: TagChipData[];
  dragHandle?: DragHandleProps;
  overlay?: boolean;
  stages?: DealStage[];
  onMoveToStage?: (deal: BoardDeal, toStage: DealStage) => void;
}) {
  const inStageDays = daysSince(deal.stageEnteredAt);
  return (
    <div
      className={`rounded-lg border bg-card p-3 shadow-sm ${overlay ? "ring-2 ring-primary" : ""}`}
      data-testid={`card-deal-${deal.id}`}
    >
      <div className="flex items-start gap-1.5">
        {dragHandle ? (
          <button
            type="button"
            className="mt-0.5 shrink-0 cursor-grab touch-none rounded p-0.5 text-muted-foreground/50 hover:text-muted-foreground"
            aria-label="Drag to move"
            data-testid={`handle-drag-deal-${deal.id}`}
            {...dragHandle.attributes}
            {...(dragHandle.listeners ?? {})}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <Link
            href={`/deals/${deal.id}`}
            className="block truncate text-sm font-medium leading-snug hover:underline"
            data-testid={`link-deal-${deal.id}`}
          >
            {deal.name}
          </Link>
          {deal.clientFirmName && (
            <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
              <Building2 className="h-3 w-3 shrink-0" />
              <span className="truncate">{deal.clientFirmName}</span>
            </div>
          )}
        </div>
        {/* Pointer-free equivalent for the drag move: a labeled menu that
            drives the same attemptMove path (incl. the 422 required-fields
            dialog). Hidden on the drag overlay clone. */}
        {!overlay && stages && onMoveToStage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-muted-foreground"
                aria-label={`Move ${deal.name} to another stage`}
                data-testid={`button-move-deal-${deal.id}`}
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Move to stage</DropdownMenuLabel>
              {stages
                .filter((s) => s.id !== deal.stageId)
                .map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => onMoveToStage(deal, s)}
                    data-testid={`menuitem-move-${deal.id}-${s.slug}`}
                  >
                    {s.name}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <TagChipRow tags={tags ?? []} testIdPrefix={`chip-deal-${deal.id}-tag`} />
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="font-semibold" data-testid={`amount-deal-${deal.id}`}>
          {formatDealAmount(deal.amount)}
        </span>
        {deal.expectedCloseDate && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <CalendarDays className="h-3 w-3" />
            {deal.expectedCloseDate}
          </span>
        )}
        {deal.score !== null && (
          <span
            className="ml-auto inline-flex items-center gap-1 rounded-full border bg-background px-1.5 py-0.5 font-semibold tabular-nums"
            title={`Fit ${deal.fitScore ?? 0} · Engagement ${deal.engagementScore ?? 0}`}
            data-testid={`score-deal-${deal.id}`}
          >
            <Gauge className="h-3 w-3 text-muted-foreground" />
            {deal.score}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        {deal.ownerName ? (
          <span className="flex min-w-0 items-center gap-1">
            <UserIcon className="h-3 w-3 shrink-0" />
            <span className="truncate">{deal.ownerName}</span>
          </span>
        ) : (
          <span>Unassigned</span>
        )}
        {inStageDays !== null && (
          <span className="ml-auto" title="Days in this stage">
            {inStageDays}d in stage
          </span>
        )}
      </div>
    </div>
  );
}

// ── Create dialog ──────────────────────────────────────────────────────────

interface ClientOption {
  id: string;
  firmName: string;
}

interface ContactOption {
  id: string;
  name: string;
  isPrimary: boolean;
}

interface UserOption {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

function userLabel(u: UserOption): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return name || u.email || u.id;
}

function CreateDealDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState<string>("none");
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [amount, setAmount] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [ownerId, setOwnerId] = useState<string>("me");
  const [notes, setNotes] = useState("");

  const clientsQuery = useQuery<ClientOption[]>({
    queryKey: ["/api/clients"],
    enabled: open,
  });
  // Contacts are AM+-gated server-side; sales users simply don't get a picker.
  const contactsQuery = useQuery<ContactOption[]>({
    queryKey: ["/api/clients", clientId, "contacts"],
    enabled: open && clientId !== "none",
    retry: false,
  });
  // /api/users is team_lead+; below that the owner select is hidden and the
  // server assigns the deal to the creator.
  const usersQuery = useQuery<UserOption[]>({
    queryKey: ["/api/users"],
    enabled: open,
    retry: false,
  });

  const reset = () => {
    setName("");
    setClientId("none");
    setContactIds([]);
    setAmount("");
    setExpectedCloseDate("");
    setOwnerId("me");
    setNotes("");
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { name: name.trim() };
      if (clientId !== "none") body.clientId = clientId;
      if (contactIds.length > 0) body.contactIds = contactIds;
      if (amount.trim() !== "") body.amount = Number(amount);
      if (expectedCloseDate) body.expectedCloseDate = expectedCloseDate;
      if (ownerId !== "me") body.ownerId = ownerId;
      if (notes.trim()) body.notes = notes.trim();
      const res = await apiRequest("POST", "/api/deals", body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Deal created" });
      reset();
      onOpenChange(false);
      onCreated();
    },
    onError: (error: Error) => {
      toast({
        title: "Couldn't create deal",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const contacts = contactsQuery.data ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="dialog-create-deal">
        <DialogHeader>
          <DialogTitle>New deal</DialogTitle>
          <DialogDescription>
            Track an opportunity through the pipeline.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="deal-name">Deal name *</Label>
            <Input
              id="deal-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Smith & Co — SEO retainer"
              data-testid="input-deal-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Client / prospect</Label>
            <Select
              value={clientId}
              onValueChange={(v) => {
                setClientId(v);
                setContactIds([]);
              }}
            >
              <SelectTrigger data-testid="select-deal-client">
                <SelectValue placeholder="No client linked" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No client linked</SelectItem>
                {(clientsQuery.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.firmName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {clientId !== "none" && contacts.length > 0 && (
            <div className="space-y-1.5">
              <Label>Contacts</Label>
              <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-md border p-2">
                {contacts.map((contact) => (
                  <label
                    key={contact.id}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={contactIds.includes(contact.id)}
                      onCheckedChange={(checked) => {
                        setContactIds((prevIds) =>
                          checked
                            ? [...prevIds, contact.id]
                            : prevIds.filter((id) => id !== contact.id),
                        );
                      }}
                      data-testid={`checkbox-contact-${contact.id}`}
                    />
                    <span className="truncate">
                      {contact.name}
                      {contact.isPrimary ? " (primary)" : ""}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="deal-amount">Amount (USD)</Label>
              <Input
                id="deal-amount"
                type="number"
                min="0"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="5000"
                data-testid="input-deal-amount"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deal-close-date">Expected close</Label>
              <Input
                id="deal-close-date"
                type="date"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
                data-testid="input-deal-close-date"
              />
            </div>
          </div>
          {usersQuery.data && usersQuery.data.length > 0 && (
            <div className="space-y-1.5">
              <Label>Owner</Label>
              <Select value={ownerId} onValueChange={setOwnerId}>
                <SelectTrigger data-testid="select-deal-owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="me">Me</SelectItem>
                  {usersQuery.data.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {userLabel(u)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="deal-notes">Notes</Label>
            <Textarea
              id="deal-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              data-testid="input-deal-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="button-create-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={name.trim() === "" || createMutation.isPending}
            data-testid="button-create-submit"
          >
            {createMutation.isPending ? "Creating…" : "Create deal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
