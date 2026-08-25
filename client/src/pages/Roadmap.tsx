/**
 * Task #3728 — Public company roadmap (and its chrome-less embed variant).
 *
 * One component serves both routes:
 *   /roadmap        public SaaS-style status-column board with visitor-usable
 *                   board/department/type filter chips (filtering is
 *                   client-side — the page fetches the full published payload
 *                   once).
 *   /roadmap/embed  the same board with zero chrome, sized for an iframe on a
 *                   third-party site. Filters come from the embed URL's query
 *                   params (boards/departments/types/statuses, comma-separated
 *                   slugs) and are passed straight to the JSON endpoint, so
 *                   the embed shows exactly what its snippet was configured to
 *                   show.
 *
 * Task #4215: every card carries the shared auto-ticking progress bar
 * (shared/roadmapProgress.ts — pure date math over status + releaseQuarter,
 * re-rendered on a useNow() timer so percentages stay current with no
 * background job) and completed items get completed styling with the quarter
 * they finished in. `timeframe` is now the server-derived quarter label.
 *
 * Data: GET /api/public/roadmap — published initiatives only, public fields
 * only (the server enforces this; nothing here ever sees internal notes).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  roadmapBoardLabels,
  roadmapBoards,
  roadmapStatuses,
  roadmapStatusLabels,
  type PublicRoadmapPayload,
  type PublicRoadmapInitiative,
  type RoadmapStatus,
} from "@shared/schema";
import { RoadmapMarkdown } from "@/components/RoadmapMarkdown";
import { RoadmapProgressBar } from "@/components/RoadmapProgressBar";
import { useNow } from "@/hooks/useNow";

const EMBED_FILTER_KEYS = ["boards", "departments", "types", "statuses"] as const;

/** Whitelist + normalize the embed URL's filter params for the JSON call. */
function embedQueryString(search: string): string {
  const incoming = new URLSearchParams(search);
  const outgoing = new URLSearchParams();
  for (const key of EMBED_FILTER_KEYS) {
    const raw = incoming.get(key);
    if (raw && raw.trim()) outgoing.set(key, raw.trim());
  }
  const qs = outgoing.toString();
  return qs ? `?${qs}` : "";
}

const STATUS_STYLES: Record<
  RoadmapStatus,
  { dot: string; headerBg: string; border: string }
> = {
  planned: { dot: "bg-slate-400", headerBg: "bg-muted/50", border: "border-border" },
  in_progress: { dot: "bg-amber-400", headerBg: "bg-amber-50", border: "border-amber-200" },
  shipped: { dot: "bg-emerald-500", headerBg: "bg-emerald-50", border: "border-emerald-200" },
};

const TYPE_PILL_PALETTE = [
  "bg-sky-100 text-sky-800",
  "bg-violet-100 text-violet-800",
  "bg-rose-100 text-rose-800",
  "bg-teal-100 text-teal-800",
  "bg-orange-100 text-orange-800",
  "bg-indigo-100 text-indigo-800",
];

function typePillClass(typeSlug: string, orderedTypeSlugs: string[]): string {
  const idx = orderedTypeSlugs.indexOf(typeSlug);
  return TYPE_PILL_PALETTE[(idx >= 0 ? idx : 0) % TYPE_PILL_PALETTE.length];
}

function InitiativeCard({
  item,
  orderedTypeSlugs,
  compact,
  now,
}: {
  item: PublicRoadmapInitiative;
  orderedTypeSlugs: string[];
  compact: boolean;
  now: Date;
}) {
  const done = item.status === "shipped";
  return (
    <div
      className={`border p-4 shadow-sm ${
        done ? "border-emerald-200 bg-emerald-50/50" : "border-border bg-card"
      }`}
      data-testid={`card-initiative-${item.id}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className={`inline-block rounded-pill px-2 py-0.5 text-[11px] font-medium ${typePillClass(item.typeSlug, orderedTypeSlugs)}`}
          data-testid={`badge-type-${item.id}`}
        >
          {item.typeName}
        </span>
        {item.timeframe ? (
          <span
            className={`shrink-0 text-[11px] font-medium uppercase tracking-wide ${
              done ? "text-emerald-600" : "text-muted-foreground"
            }`}
            data-testid={`text-timeframe-${item.id}`}
          >
            {item.timeframe}
          </span>
        ) : null}
      </div>
      <h3
        className={`font-semibold ${done ? "text-emerald-950" : "text-foreground"} ${compact ? "text-sm" : "text-[15px]"}`}
        data-testid={`text-title-${item.id}`}
      >
        {item.title}
      </h3>
      {item.description ? (
        // Descriptions may carry markdown source (#4266) — the shared renderer
        // keeps raw HTML escaped, which matters doubly here: this same card
        // serves the chrome-less embed iframed into third-party sites.
        <RoadmapMarkdown
          source={item.description}
          className={`mt-1 ${done ? "text-emerald-900/70" : "text-muted-foreground"} ${compact ? "text-xs" : "text-sm"}`}
          testId={`text-description-${item.id}`}
        />
      ) : null}
      <div className="mt-3 text-[11px] font-medium text-muted-foreground" data-testid={`text-department-${item.id}`}>
        {item.departmentName}
      </div>
      <div className="mt-2.5">
        <RoadmapProgressBar
          status={item.status}
          releaseQuarter={item.releaseQuarter}
          completedAt={item.completedAt}
          now={now}
          size={compact ? "sm" : "md"}
          testId={`progress-${item.id}`}
        />
      </div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`rounded-pill border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:border-slate-400"
      }`}
    >
      {label}
    </button>
  );
}

export default function Roadmap({ embed = false }: { embed?: boolean }) {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const qs = embed ? embedQueryString(search) : "";
  const now = useNow(60_000);

  const { data, isLoading, error } = useQuery<PublicRoadmapPayload>({
    queryKey: [`/api/public/roadmap${qs}`],
  });

  // Visitor filters (public page only; embeds fix filters via the URL).
  const [activeBoards, setActiveBoards] = useState<Set<string>>(new Set());
  const [activeDepartments, setActiveDepartments] = useState<Set<string>>(new Set());
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());

  const toggle = (set: Set<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const initiatives = useMemo(() => data?.initiatives ?? [], [data?.initiatives]);
  const orderedTypeSlugs = useMemo(() => (data?.types ?? []).map((t) => t.slug), [data?.types]);

  // Only offer filter options that can actually match something.
  const usedBoards = useMemo(() => new Set(initiatives.map((i) => i.board)), [initiatives]);
  const usedDepartmentSlugs = useMemo(
    () => new Set(initiatives.map((i) => i.departmentSlug)),
    [initiatives],
  );
  const usedTypeSlugs = useMemo(() => new Set(initiatives.map((i) => i.typeSlug)), [initiatives]);

  const visible = useMemo(
    () =>
      initiatives.filter(
        (i) =>
          (activeBoards.size === 0 || activeBoards.has(i.board)) &&
          (activeDepartments.size === 0 || activeDepartments.has(i.departmentSlug)) &&
          (activeTypes.size === 0 || activeTypes.has(i.typeSlug)),
      ),
    [initiatives, activeBoards, activeDepartments, activeTypes],
  );

  // Column set: embeds honoring a statuses filter only render those columns
  // (in canonical order); otherwise all three lanes always show.
  const columns = useMemo(() => {
    if (!embed) return [...roadmapStatuses];
    const raw = new URLSearchParams(search).get("statuses");
    if (!raw) return [...roadmapStatuses];
    const wanted = new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    const filtered = roadmapStatuses.filter((s) => wanted.has(s));
    return filtered.length > 0 ? filtered : [...roadmapStatuses];
  }, [embed, search]);

  const byStatus = (status: RoadmapStatus) => visible.filter((i) => i.status === status);

  const board = (
    <div
      className={`grid gap-4 ${columns.length === 1 ? "grid-cols-1" : columns.length === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"}`}
      data-testid="board-roadmap"
    >
      {columns.map((status) => {
        const items = byStatus(status);
        const style = STATUS_STYLES[status];
        return (
          <div
            key={status}
            className={`border ${style.border} bg-muted/50/60`}
            data-testid={`column-${status}`}
          >
            <div
              className={`flex items-center gap-2 border-b ${style.border} ${style.headerBg} px-4 py-3`}
            >
              <span className={`h-2.5 w-2.5 rounded-pill ${style.dot}`} />
              <span className="text-sm font-semibold text-foreground">
                {roadmapStatusLabels[status]}
              </span>
              <span
                className="ml-auto rounded-pill bg-card px-2 py-0.5 text-xs font-medium text-muted-foreground"
                data-testid={`count-${status}`}
              >
                {items.length}
              </span>
            </div>
            <div className="flex flex-col gap-3 p-3">
              {items.length === 0 ? (
                <div
                  className="border border-dashed border-border p-4 text-center text-xs text-muted-foreground"
                  data-testid={`empty-${status}`}
                >
                  Nothing here yet
                </div>
              ) : (
                items.map((item) => (
                  <InitiativeCard
                    key={item.id}
                    item={item}
                    orderedTypeSlugs={orderedTypeSlugs}
                    compact={embed}
                    now={now}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  const loadingOrError = isLoading ? (
    <div className="py-16 text-center text-sm text-muted-foreground" data-testid="text-loading">
      Loading roadmap…
    </div>
  ) : error ? (
    <div className="py-16 text-center text-sm text-muted-foreground" data-testid="text-error">
      The roadmap couldn't be loaded right now. Please try again shortly.
    </div>
  ) : null;

  if (embed) {
    return (
      <div className="min-h-screen bg-card p-4" data-testid="page-roadmap-embed">
        {loadingOrError ?? board}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-card" data-testid="page-roadmap">
      <header className="border-b border-border">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary dark:text-foreground">
            NoBull Marketing
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground" data-testid="text-page-title">
            Company Roadmap
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            What we're planning, what we're building, and what we've shipped — across every
            department.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {loadingOrError ?? (
          <>
            {(usedBoards.size > 1 ||
              data!.departments.some((d) => usedDepartmentSlugs.has(d.slug)) ||
              data!.types.some((t) => usedTypeSlugs.has(t.slug))) && (
              <div className="mb-8 flex flex-col gap-3" data-testid="section-filters">
                {usedBoards.size > 1 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Board
                    </span>
                    <FilterChip
                      label="All"
                      active={activeBoards.size === 0}
                      onClick={() => setActiveBoards(new Set())}
                      testId="chip-board-all"
                    />
                    {roadmapBoards
                      .filter((b) => usedBoards.has(b))
                      .map((b) => (
                        <FilterChip
                          key={b}
                          label={roadmapBoardLabels[b]}
                          active={activeBoards.has(b)}
                          onClick={() => setActiveBoards((s) => toggle(s, b))}
                          testId={`chip-board-${b}`}
                        />
                      ))}
                  </div>
                )}
                {data!.departments.some((d) => usedDepartmentSlugs.has(d.slug)) && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Department
                    </span>
                    <FilterChip
                      label="All"
                      active={activeDepartments.size === 0}
                      onClick={() => setActiveDepartments(new Set())}
                      testId="chip-department-all"
                    />
                    {data!.departments
                      .filter((d) => usedDepartmentSlugs.has(d.slug))
                      .map((d) => (
                        <FilterChip
                          key={d.slug}
                          label={d.name}
                          active={activeDepartments.has(d.slug)}
                          onClick={() => setActiveDepartments((s) => toggle(s, d.slug))}
                          testId={`chip-department-${d.slug}`}
                        />
                      ))}
                  </div>
                )}
                {data!.types.some((t) => usedTypeSlugs.has(t.slug)) && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Type
                    </span>
                    <FilterChip
                      label="All"
                      active={activeTypes.size === 0}
                      onClick={() => setActiveTypes(new Set())}
                      testId="chip-type-all"
                    />
                    {data!.types
                      .filter((t) => usedTypeSlugs.has(t.slug))
                      .map((t) => (
                        <FilterChip
                          key={t.slug}
                          label={t.name}
                          active={activeTypes.has(t.slug)}
                          onClick={() => setActiveTypes((s) => toggle(s, t.slug))}
                          testId={`chip-type-${t.slug}`}
                        />
                      ))}
                  </div>
                )}
              </div>
            )}
            {board}
          </>
        )}
      </main>

      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} NoBull Marketing
      </footer>
    </div>
  );
}
