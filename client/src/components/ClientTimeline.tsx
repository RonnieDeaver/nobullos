/**
 * Task #4328 — Unified client activity timeline.
 *
 * One newest-first feed merging everything captured for a client: Front
 * emails, SMS + calls (Twilio), meetings (booking + Zoom records), service
 * desk tickets, Slack, and manual notes. Rendered on the client detail
 * Timeline tab and on deal detail scoped to the deal's client (`endpoint`
 * points at either GET /api/clients/:id/timeline or
 * GET /api/deals/:id/timeline — same payload shape).
 *
 * The one write path is the manual note composer, which posts through the
 * EXISTING comm-log route (POST /api/clients/:clientId/communications,
 * sourceType "manual") — notes are raw communication records, not a second
 * model. Sales users are read-only there, so the composer hides for them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  ExternalLink,
  Hash,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  Search,
  StickyNote,
  TicketCheck,
  Video,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";

/** Mirrors timelineEntryTypes in server/storage/timelineStorage.ts. */
const TIMELINE_TYPES = [
  "email",
  "sms",
  "call",
  "meeting",
  "ticket",
  "note",
  "slack",
] as const;
type TimelineType = (typeof TIMELINE_TYPES)[number];

interface TimelineEntry {
  id: string;
  type: TimelineType;
  timestamp: string;
  title: string;
  preview: string | null;
  direction: "inbound" | "outbound" | "internal" | null;
  actorLabel: string | null;
  href: string | null;
  hrefExternal: boolean;
  meta: Record<string, string | number | boolean | null>;
}

interface TimelinePage {
  entries: TimelineEntry[];
  nextCursor: string | null;
  clientId?: string | null;
}

const TYPE_CONFIG: Record<
  TimelineType,
  { label: string; icon: typeof Mail; bubble: string }
> = {
  email: { label: "Email", icon: Mail, bubble: "bg-blue-50 dark:bg-blue-950/25 text-blue-600 dark:text-blue-400" },
  sms: { label: "SMS", icon: MessageSquare, bubble: "bg-emerald-50 dark:bg-emerald-950/25 text-emerald-600 dark:text-emerald-400" },
  call: { label: "Call", icon: Phone, bubble: "bg-indigo-50 dark:bg-indigo-950/25 text-indigo-600 dark:text-indigo-400" },
  meeting: { label: "Meeting", icon: Video, bubble: "bg-violet-50 dark:bg-violet-950/25 text-violet-600 dark:text-violet-400" },
  ticket: { label: "Ticket", icon: TicketCheck, bubble: "bg-amber-50 dark:bg-amber-950/25 text-amber-700 dark:text-amber-300" },
  note: { label: "Note", icon: StickyNote, bubble: "bg-yellow-50 dark:bg-yellow-950/25 text-yellow-700 dark:text-yellow-300" },
  slack: { label: "Slack", icon: Hash, bubble: "bg-rose-50 dark:bg-rose-950/25 text-rose-600 dark:text-rose-400" },
};

const PAGE_SIZE = 30;

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ClientTimeline({
  endpoint,
  noteClientId,
}: {
  /** Timeline GET endpoint (client- or deal-scoped, same payload). */
  endpoint: string;
  /** Client to attach manual notes to; omit/null to hide the composer. */
  noteClientId?: string | null;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [activeTypes, setActiveTypes] = useState<Set<TimelineType>>(new Set());
  const typesKey = useMemo(
    () => (activeTypes.size > 0 ? Array.from(activeTypes).sort().join(",") : ""),
    [activeTypes],
  );

  // Task #4418 — search + date-range narrowing. The search input is
  // debounced so the query refires on pauses, not every keystroke; dates
  // are plain YYYY-MM-DD values the server expands to inclusive UTC days.
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const hasNarrowing = Boolean(q || fromDate || toDate);

  const {
    data,
    isPending,
    isError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery<TimelinePage>({
    queryKey: ["timeline", endpoint, typesKey, q, fromDate, toDate],
    queryFn: async ({ pageParam }) => {
      const sp = new URLSearchParams();
      sp.set("limit", String(PAGE_SIZE));
      if (typesKey) sp.set("types", typesKey);
      if (q) sp.set("q", q);
      if (fromDate) sp.set("after", fromDate);
      if (toDate) sp.set("before", toDate);
      if (pageParam) sp.set("cursor", String(pageParam));
      const res = await apiRequest("GET", `${endpoint}?${sp.toString()}`);
      return res.json();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const entries = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p.entries),
    [data],
  );

  // Infinite scroll: fetch the next page when the sentinel nears the viewport.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (obs) => {
        if (obs.some((o) => o.isIntersecting) && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // ── Manual note composer (the one write path) ──────────────────────────
  const canAddNote = Boolean(noteClientId) && user?.role !== "sales";
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const addNote = useMutation({
    mutationFn: async () => {
      const text = noteText.trim();
      const firstLine = (text.split("\n")[0] ?? "").trim();
      const title =
        firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine || "Note";
      const res = await apiRequest(
        "POST",
        `/api/clients/${noteClientId}/communications`,
        {
          sourceType: "manual",
          sourceSubtype: "manual_note",
          title,
          contentText: text,
          direction: "internal",
        },
      );
      return res.json();
    },
    onSuccess: () => {
      setNoteText("");
      setNoteOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["timeline", endpoint] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({
        queryKey: ["/api/clients", noteClientId, "communications"],
      }); // fire-and-forget: comm-log tab shares the record
      toast({ title: "Note added" });
    },
    onError: (err: unknown) =>
      toast({
        title: "Could not add note",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      }),
  });

  const toggleType = (t: TimelineType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  return (
    <div className="space-y-4" data-testid="client-timeline">
      {/* Filters + note action */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant={activeTypes.size === 0 ? "default" : "outline"}
          size="sm"
          className="h-7 rounded-full px-3 text-xs"
          onClick={() => setActiveTypes(new Set())}
          data-testid="timeline-filter-all"
        >
          All
        </Button>
        {TIMELINE_TYPES.map((t) => {
          const cfg = TYPE_CONFIG[t];
          const active = activeTypes.has(t);
          return (
            <Button
              key={t}
              variant={active ? "default" : "outline"}
              size="sm"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => toggleType(t)}
              data-testid={`timeline-filter-${t}`}
            >
              <cfg.icon className="mr-1 h-3 w-3" />
              {cfg.label}
            </Button>
          );
        })}
        {canAddNote && (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto h-7 px-3 text-xs"
            onClick={() => setNoteOpen((v) => !v)}
            data-testid="timeline-add-note-toggle"
          >
            <Plus className="mr-1 h-3 w-3" />
            Add note
          </Button>
        )}
      </div>

      {/* Task #4418 — search + date-range narrowing */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search titles & previews…"
            maxLength={200}
            className="h-8 pl-8 text-sm"
            data-testid="timeline-search"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
            aria-label="From date"
            className="h-8 w-[140px] text-sm"
            data-testid="timeline-date-from"
          />
          <span className="text-xs text-muted-foreground" aria-hidden>–</span>
          <Input
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
            aria-label="To date"
            className="h-8 w-[140px] text-sm"
            data-testid="timeline-date-to"
          />
        </div>
        {hasNarrowing && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => {
              setSearchInput("");
              setQ("");
              setFromDate("");
              setToDate("");
            }}
            data-testid="timeline-filters-clear"
          >
            <X className="mr-1 h-3 w-3" />
            Clear
          </Button>
        )}
      </div>

      {canAddNote && noteOpen && (
        <div className="space-y-2 border bg-muted/30 p-3" data-testid="timeline-note-composer">
          <Textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Write a note… (first line becomes the title)"
            rows={3}
            data-testid="timeline-note-input"
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setNoteOpen(false);
                setNoteText("");
              }}
              data-testid="timeline-note-cancel"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!noteText.trim() || addNote.isPending}
              onClick={() => addNote.mutate()}
              data-testid="timeline-note-save"
            >
              {addNote.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Save note
            </Button>
          </div>
        </div>
      )}

      {/* Feed */}
      {isPending ? (
        <div className="space-y-3" data-testid="timeline-loading">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="border border-destructive/30 bg-destructive/5 p-4 text-sm" data-testid="timeline-error">
          <p className="text-destructive">Couldn&apos;t load the timeline.</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground" data-testid="timeline-empty">
          {activeTypes.size > 0 || hasNarrowing
            ? "No activity matches these filters."
            : "No activity captured for this client yet."}
        </p>
      ) : (
        <ol className="space-y-1" data-testid="timeline-entries">
          {entries.map((entry) => {
            const cfg = TYPE_CONFIG[entry.type] ?? TYPE_CONFIG.note;
            const Icon = cfg.icon;
            const upcoming =
              entry.type === "meeting" &&
              new Date(entry.timestamp).getTime() > Date.now();
            const canceled = entry.meta?.status === "canceled";
            const failedSms =
              entry.type === "sms" &&
              (entry.meta?.status === "failed" || entry.meta?.status === "undelivered");
            return (
              <li
                key={entry.id}
                className="group flex gap-3 px-2 py-2.5 transition-colors hover:bg-muted/40"
                data-testid={`timeline-entry-${entry.id}`}
              >
                <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${cfg.bubble}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-sm font-medium leading-tight">{entry.title}</span>
                    {entry.direction === "inbound" && (
                      <Badge variant="outline" className="h-4 gap-0.5 px-1 text-caption font-normal">
                        <ArrowDownLeft className="h-2.5 w-2.5" /> In
                      </Badge>
                    )}
                    {entry.direction === "outbound" && (
                      <Badge variant="outline" className="h-4 gap-0.5 px-1 text-caption font-normal">
                        <ArrowUpRight className="h-2.5 w-2.5" /> Out
                      </Badge>
                    )}
                    {upcoming && !canceled && (
                      <Badge className="h-4 gap-0.5 bg-violet-100 dark:bg-violet-950/35 px-1 text-caption font-normal text-violet-700 dark:text-violet-300 hover:bg-violet-100 dark:hover:bg-violet-900/40">
                        <CalendarClock className="h-2.5 w-2.5" /> Upcoming
                      </Badge>
                    )}
                    {canceled && (
                      <Badge variant="outline" className="h-4 px-1 text-caption font-normal text-muted-foreground">
                        Canceled
                      </Badge>
                    )}
                    {failedSms && (
                      <Badge variant="destructive" className="h-4 px-1 text-caption font-normal">
                        Not delivered
                      </Badge>
                    )}
                  </div>
                  {entry.preview && entry.preview !== entry.title && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{entry.preview}</p>
                  )}
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-caption text-muted-foreground">
                    <span>{formatWhen(entry.timestamp)}</span>
                    {entry.actorLabel && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{entry.actorLabel}</span>
                      </>
                    )}
                  </div>
                </div>
                {entry.href &&
                  (entry.hrefExternal ? (
                    <a
                      href={entry.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="self-center rounded p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                      aria-label="Open in source"
                      data-testid={`timeline-link-${entry.id}`}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    <Link
                      href={entry.href}
                      className="self-center rounded p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                      aria-label="Open"
                      data-testid={`timeline-link-${entry.id}`}
                    >
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </Link>
                  ))}
              </li>
            );
          })}
        </ol>
      )}

      {/* Pagination sentinel + manual fallback */}
      {!isPending && !isError && hasNextPage && (
        <div className="flex flex-col items-center gap-1 pb-2">
          <div ref={sentinelRef} aria-hidden className="h-px w-full" />
          <Button
            variant="ghost"
            size="sm"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
            data-testid="timeline-load-more"
          >
            {isFetchingNextPage ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Loading…
              </>
            ) : (
              "Load more"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
