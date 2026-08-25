import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCommsContext } from "@/contexts/CommsContext";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Search,
  X,
  Loader2,
  FileText,
  MessageSquare,
  Download,
  Clock,
  Hash,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import {
  parseSearchQuery,
  MODIFIER_HINTS,
  type ParsedSearchModifiers,
} from "@shared/commsSearchParser";
import type { CommsChannel } from "./types";
import { renderContent, displayName } from "./helpers";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CommsMessage {
  id: string;
  channelId: string;
  content: string;
  createdAt: string;
  user: { id: string; firstName: string | null; lastName: string | null } | null;
}

export interface AttachmentResult {
  id: string;
  messageId: string;
  channelId: string;
  objectKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  createdAt: string;
  uploadedBy: string | null;
  uploaderFirstName: string | null;
  uploaderLastName: string | null;
  channelName: string | null;
  channelSlug: string | null;
  channelType: string;
  messageCreatedAt: string;
}

// ─── Recent searches ──────────────────────────────────────────────────────────

const RECENT_KEY_PREFIX = "comms_recent_searches_";
const MAX_RECENT = 10;

function loadRecent(userId: string): string[] {
  try {
    const raw = localStorage.getItem(`${RECENT_KEY_PREFIX}${userId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecent(userId: string, query: string): void {
  if (!query.trim()) return;
  try {
    const current = loadRecent(userId).filter((q) => q !== query.trim());
    const updated = [query.trim(), ...current].slice(0, MAX_RECENT);
    localStorage.setItem(`${RECENT_KEY_PREFIX}${userId}`, JSON.stringify(updated));
  } catch {}
}

function removeRecent(userId: string, query: string): string[] {
  try {
    const current = loadRecent(userId).filter((q) => q !== query);
    localStorage.setItem(`${RECENT_KEY_PREFIX}${userId}`, JSON.stringify(current));
    return current;
  } catch {
    return [];
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ts: string): string {
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return "";
  }
}

function fileIcon(contentType: string): React.ReactNode {
  if (contentType.startsWith("image/")) return "🖼️";
  if (contentType.startsWith("video/")) return "🎬";
  if (contentType.startsWith("audio/")) return "🎵";
  if (contentType.includes("pdf")) return "📄";
  if (contentType.includes("spreadsheet") || contentType.includes("excel")) return "📊";
  if (contentType.includes("presentation") || contentType.includes("powerpoint")) return "📑";
  if (contentType.includes("word") || contentType.includes("document")) return "📝";
  return "📎";
}

export function FileThumb({ att }: { att: AttachmentResult }) {
  const [imgFailed, setImgFailed] = useState(false);
  const isImage = att.contentType.startsWith("image/");
  if (isImage && !imgFailed) {
    return (
      <img
        src={`/api/comms/attachments/${att.objectKey}`}
        alt={att.filename}
        loading="lazy"
        className="h-12 w-12 flex-shrink-0 rounded border border-border/50 object-cover mt-0.5"
        onError={() => setImgFailed(true)}
        data-testid={`file-result-thumb-${att.id}`}
      />
    );
  }
  return <span className="text-xl flex-shrink-0 mt-0.5">{fileIcon(att.contentType)}</span>;
}

// ─── Modifier popover ─────────────────────────────────────────────────────────

function ModifierHintPopover({
  input,
  channels,
  users,
  onInsert,
}: {
  input: string;
  channels: CommsChannel[];
  users: Array<{ id: string; firstName: string | null; lastName: string | null }>;
  onInsert: (text: string) => void;
}) {
  const lastWord = input.split(/\s/).pop() ?? "";
  const fromActive = lastWord.startsWith("from:");
  const inActive = lastWord.startsWith("in:");
  const dateActive =
    lastWord.startsWith("before:") ||
    lastWord.startsWith("after:") ||
    lastWord.startsWith("on:");

  const showGeneric = !fromActive && !inActive && !dateActive;

  const userSuggestions = fromActive
    ? users
        .filter((u) => {
          const q = lastWord.slice("from:".length).replace(/^@/, "").toLowerCase();
          if (!q) return true;
          const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase();
          return name.includes(q);
        })
        .slice(0, 5)
    : [];

  const channelSuggestions = inActive
    ? channels
        .filter((c) => {
          const q = lastWord.slice("in:".length).replace(/^#/, "").toLowerCase();
          if (!q) return c.type === "channel";
          const name = (c.name ?? c.slug ?? "").toLowerCase();
          return c.type === "channel" && name.includes(q);
        })
        .slice(0, 5)
    : [];

  return (
    <div className="bg-popover border border-border rounded-lg shadow-md min-w-[240px] max-w-xs text-xs" data-testid="modifier-hint-popover">
      {showGeneric && (
        <div className="p-2">
          <p className="text-muted-foreground font-medium mb-1 text-caption uppercase tracking-wider">Search modifiers</p>
          <div className="space-y-0.5">
            {MODIFIER_HINTS.map((h) => (
              <button
                key={h.prefix}
                className="w-full text-left px-2 py-1 rounded hover:bg-muted flex items-center gap-2"
                onMouseDown={(e) => { e.preventDefault(); onInsert(h.label); }}
                data-testid={`modifier-hint-${h.prefix.replace(":", "").replace('"', "quote")}`}
              >
                <code className="text-primary-ink font-mono text-caption">{h.label}</code>
                <span className="text-muted-foreground">{h.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {fromActive && userSuggestions.length > 0 && (
        <div className="p-2">
          <p className="text-muted-foreground font-medium mb-1 text-caption uppercase tracking-wider">People</p>
          {userSuggestions.map((u) => (
            <button
              key={u.id}
              className="w-full text-left px-2 py-1 rounded hover:bg-muted flex items-center gap-2"
              onMouseDown={(e) => {
                e.preventDefault();
                const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim().replace(/\s+/g, "_");
                const before = input.slice(0, input.lastIndexOf(" ") + 1);
                onInsert(before + `from:${name} `);
              }}
              data-testid={`user-suggest-${u.id}`}
            >
              <span>{displayName(u)}</span>
            </button>
          ))}
          {userSuggestions.length === 0 && (
            <p className="px-2 py-1 text-muted-foreground">No matching users</p>
          )}
        </div>
      )}
      {inActive && (
        <div className="p-2">
          <p className="text-muted-foreground font-medium mb-1 text-caption uppercase tracking-wider">Channels</p>
          {channelSuggestions.length > 0 ? channelSuggestions.map((c) => (
            <button
              key={c.id}
              className="w-full text-left px-2 py-1 rounded hover:bg-muted flex items-center gap-2"
              onMouseDown={(e) => {
                e.preventDefault();
                const slug = c.slug ?? c.name ?? "";
                const before = input.slice(0, input.lastIndexOf(" ") + 1);
                onInsert(before + `in:${slug} `);
              }}
              data-testid={`channel-suggest-${c.id}`}
            >
              {c.visibility === "private" ? <Lock className="h-3 w-3 flex-shrink-0" /> : <Hash className="h-3 w-3 flex-shrink-0" />}
              <span>{c.name ?? c.slug ?? "channel"}</span>
            </button>
          )) : (
            <p className="px-2 py-1 text-muted-foreground">No matching channels</p>
          )}
        </div>
      )}
      {dateActive && (
        <div className="p-2">
          <p className="text-muted-foreground font-medium mb-1 text-caption uppercase tracking-wider">Date format</p>
          <p className="px-2 text-muted-foreground">YYYY-MM-DD or MM/DD/YYYY</p>
          <p className="px-2 text-muted-foreground mt-0.5">e.g. {lastWord.split(":")[0]}:2026-01-15</p>
        </div>
      )}
    </div>
  );
}

// ─── Main SearchPanel component ───────────────────────────────────────────────

export interface SearchPanelProps {
  currentUserId: string;
  channels: CommsChannel[];
  scopeChannelId?: string | null;
  onClose: () => void;
  onJumpTo?: (channelId: string, messageId: string, parentId?: string | null) => void;
}

export function SearchPanel({
  currentUserId,
  channels,
  scopeChannelId,
  onClose,
  onJumpTo,
}: SearchPanelProps) {
  const [rawQuery, setRawQuery] = useState("");
  const [tab, setTab] = useState<"messages" | "files">("messages");
  const [showHints, setShowHints] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    loadRecent(currentUserId),
  );
  const [pendingQuery, setPendingQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { addSseListener } = useCommsContext();

  // Live SSE overlay state: new matching messages are prepended, edits update
  // rows in-place, deletes remove rows — all without a full re-fetch.
  const [livePrepends, setLivePrepends] = useState<CommsMessage[]>([]);
  const [liveEdits, setLiveEdits] = useState<Map<string, string>>(new Map());
  const [liveDeletes, setLiveDeletes] = useState<Set<string>>(new Set());
  // Live overlay for the Files tab: new matching attachments are prepended;
  // deleted messages remove their files (keyed by messageId).
  const [liveFilePrepends, setLiveFilePrepends] = useState<AttachmentResult[]>([]);
  const [liveFileDeletes, setLiveFileDeletes] = useState<Set<string>>(new Set());

  const { data: pickerUsers = [] } = useQuery<Array<{ id: string; firstName: string | null; lastName: string | null }>>({
    queryKey: ["/api/comms/users"],
    queryFn: () => fetch("/api/comms/users").then((r) => r.json()),
    staleTime: 60000,
  });

  const parsed = parseSearchQuery(rawQuery);

  const resolveFilters = useCallback((): {
    q: string;
    channelId?: string;
    fromUserId?: string;
    dateFrom?: string;
    dateTo?: string;
  } => {
    const q = parsed.ftsQuery.trim();
    let channelId: string | undefined = scopeChannelId ?? undefined;

    if (parsed.modifiers.inChannelSlug) {
      const slug = parsed.modifiers.inChannelSlug.toLowerCase();
      const ch = channels.find(
        (c) => (c.slug ?? "").toLowerCase() === slug || (c.name ?? "").toLowerCase() === slug,
      );
      if (ch) channelId = ch.id;
    }

    let fromUserId: string | undefined;
    if (parsed.modifiers.fromUsername) {
      const nameQ = parsed.modifiers.fromUsername.toLowerCase();
      const u = pickerUsers.find((user) => {
        const full = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim().toLowerCase();
        const joined = full.replace(/\s+/g, "_");
        return full.includes(nameQ) || joined.includes(nameQ);
      });
      if (u) fromUserId = u.id;
    }

    return {
      q,
      channelId,
      fromUserId,
      dateFrom: parsed.modifiers.after,
      dateTo: parsed.modifiers.before,
    };
  }, [parsed, channels, pickerUsers, scopeChannelId]);

  const filters = resolveFilters();
  const hasQuery =
    filters.q.length >= 2 ||
    !!filters.channelId ||
    !!filters.fromUserId ||
    !!filters.dateFrom ||
    !!filters.dateTo;

  const msgParams = new URLSearchParams();
  if (filters.q) msgParams.set("q", filters.q);
  if (filters.channelId) msgParams.set("channelId", filters.channelId);
  if (filters.fromUserId) msgParams.set("fromUserId", filters.fromUserId);
  if (filters.dateFrom) msgParams.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) msgParams.set("dateTo", filters.dateTo);
  const msgKey = hasQuery ? `/api/comms/search?${msgParams}` : null;

  const { data: msgResults = [], isFetching: msgLoading } = useQuery<CommsMessage[]>({
    queryKey: [msgKey],
    queryFn: () => fetch(msgKey!).then((r) => r.json()),
    enabled: !!msgKey && tab === "messages",
    staleTime: 10000,
  });

  const fileParams = new URLSearchParams();
  if (filters.q) fileParams.set("q", filters.q);
  if (filters.channelId) fileParams.set("channelId", filters.channelId);
  if (filters.fromUserId) fileParams.set("uploadedBy", filters.fromUserId);
  if (filters.dateFrom) fileParams.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) fileParams.set("dateTo", filters.dateTo);
  const fileKey = hasQuery ? `/api/comms/search/files?${fileParams}` : null;

  const { data: fileResults = [], isFetching: fileLoading } = useQuery<AttachmentResult[]>({
    queryKey: [fileKey],
    queryFn: () => fetch(fileKey!).then((r) => r.json()),
    enabled: !!fileKey && tab === "files",
    staleTime: 10000,
  });

  // ── Live SSE updates ────────────────────────────────────────────────────────
  // Reset the overlay whenever the active query changes.
  useEffect(() => {
    setLivePrepends([]);
    setLiveEdits(new Map());
    setLiveDeletes(new Set());
  }, [msgKey]);

  useEffect(() => {
    setLiveFilePrepends([]);
    setLiveFileDeletes(new Set());
  }, [fileKey]);

  // Keep latest match context in a ref so the SSE listener never goes stale.
  const matchCtxRef = useRef({ hasQuery, filters, parsed, channels });
  matchCtxRef.current = { hasQuery, filters, parsed, channels };

  useEffect(() => {
    const contentMatches = (
      content: string,
      p: { modifiers: ParsedSearchModifiers },
    ): boolean => {
      const lc = content.toLowerCase();
      for (const term of p.modifiers.terms) {
        if (!lc.includes(term.toLowerCase())) return false;
      }
      for (const phrase of p.modifiers.phrases) {
        if (!lc.includes(phrase.toLowerCase())) return false;
      }
      for (const ex of p.modifiers.excluded) {
        if (lc.includes(ex.toLowerCase())) return false;
      }
      return true;
    };

    return addSseListener((e: MessageEvent) => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      const ctx = matchCtxRef.current;

      if (data?.type === "comms:message" && data.message) {
        if (!ctx.hasQuery) return;
        const m = data.message;
        if (m.deletedAt) return;

        // Files tab: a new attachment matching the active filters is
        // prepended to the file results without a re-fetch.
        if (data.attachment) {
          const a = data.attachment;
          const fileMatches =
            (!ctx.filters.channelId || m.channelId === ctx.filters.channelId) &&
            (!ctx.filters.fromUserId || a.uploadedBy === ctx.filters.fromUserId) &&
            (!ctx.filters.dateFrom || a.createdAt >= ctx.filters.dateFrom) &&
            (!ctx.filters.dateTo || a.createdAt < ctx.filters.dateTo) &&
            // Server-side file search matches q as a filename substring.
            (!ctx.filters.q ||
              (a.filename ?? "").toLowerCase().includes(ctx.filters.q.toLowerCase()));
          if (fileMatches) {
            const entry: AttachmentResult = {
              id: a.id,
              messageId: a.messageId,
              channelId: m.channelId,
              objectKey: a.objectKey,
              filename: a.filename,
              contentType: a.contentType ?? "application/octet-stream",
              sizeBytes: a.sizeBytes ?? null,
              createdAt: a.createdAt,
              uploadedBy: a.uploadedBy ?? null,
              uploaderFirstName: m.user?.firstName ?? null,
              uploaderLastName: m.user?.lastName ?? null,
              channelName:
                ctx.channels.find((c) => c.id === m.channelId)?.name ?? null,
              channelSlug:
                ctx.channels.find((c) => c.id === m.channelId)?.slug ?? null,
              channelType: "channel",
              messageCreatedAt: m.createdAt,
            };
            setLiveFilePrepends((prev) =>
              prev.some((x) => x.id === entry.id) ? prev : [entry, ...prev],
            );
          }
        }
        // Channel scope
        if (ctx.filters.channelId && m.channelId !== ctx.filters.channelId) return;
        // Sender scope
        if (ctx.filters.fromUserId && m.userId !== ctx.filters.fromUserId) return;
        // Date scope (a live message arriving "now" can only fail a before/dateTo bound)
        if (ctx.filters.dateFrom && m.createdAt < ctx.filters.dateFrom) return;
        if (ctx.filters.dateTo && m.createdAt >= ctx.filters.dateTo) return;
        // Free-text terms (client-side substring approximation of server FTS)
        if (!contentMatches(m.content ?? "", ctx.parsed)) return;

        const entry: CommsMessage = {
          id: m.id,
          channelId: m.channelId,
          content: m.content ?? "",
          createdAt: m.createdAt,
          user: m.user
            ? {
                id: m.user.id,
                firstName: m.user.firstName ?? null,
                lastName: m.user.lastName ?? null,
              }
            : null,
        };
        setLivePrepends((prev) =>
          prev.some((x) => x.id === entry.id) ? prev : [entry, ...prev],
        );
        return;
      }

      // Message edits are content-only (attachments are immutable in comms —
      // there is no attachment edit/removal route), so the Files overlay
      // deliberately ignores comms:message_edit: filenames cannot change and
      // file search matches filenames, not message text. If attachments ever
      // become mutable, handle the new attachment-change SSE event here (see
      // CommsMessageEditEvent in server/services/twilioEvents.ts).
      if (data?.type === "comms:message_edit" && data.messageId) {
        const stillMatches = contentMatches(data.content ?? "", matchCtxRef.current.parsed);
        if (stillMatches) {
          setLiveEdits((prev) => {
            const next = new Map(prev);
            next.set(data.messageId, data.content ?? "");
            return next;
          });
          setLiveDeletes((prev) => {
            if (!prev.has(data.messageId)) return prev;
            const next = new Set(prev);
            next.delete(data.messageId);
            return next;
          });
        } else {
          // Edited content no longer matches the free-text terms — drop the row.
          setLiveDeletes((prev) => new Set(prev).add(data.messageId));
        }
        return;
      }

      if (data?.type === "comms:message_delete" && data.messageId) {
        setLiveDeletes((prev) => new Set(prev).add(data.messageId));
        // Deleted messages also remove their files from the file results.
        setLiveFileDeletes((prev) => new Set(prev).add(data.messageId));
      }
    });
  }, [addSseListener]);

  // Merge fetched results with the live overlay for display.
  const displayedResults = useMemo(() => {
    const fetchedIds = new Set(msgResults.map((m) => m.id));
    const merged = [
      ...livePrepends.filter((m) => !fetchedIds.has(m.id)),
      ...msgResults,
    ];
    return merged
      .filter((m) => !liveDeletes.has(m.id))
      .map((m) =>
        liveEdits.has(m.id) ? { ...m, content: liveEdits.get(m.id)! } : m,
      );
  }, [msgResults, livePrepends, liveEdits, liveDeletes]);

  // Merge fetched file results with the live overlay for display.
  const displayedFileResults = useMemo(() => {
    const fetchedIds = new Set(fileResults.map((f) => f.id));
    const merged = [
      ...liveFilePrepends.filter((f) => !fetchedIds.has(f.id)),
      ...fileResults,
    ];
    return merged.filter((f) => !liveFileDeletes.has(f.messageId));
  }, [fileResults, liveFilePrepends, liveFileDeletes]);

  const channelNameFor = useCallback(
    (id: string): string => {
      const ch = channels.find((c) => c.id === id);
      if (!ch) return id.slice(0, 8);
      return ch.name ?? ch.slug ?? id.slice(0, 8);
    },
    [channels],
  );

  const handleSubmit = useCallback(() => {
    if (!rawQuery.trim()) return;
    saveRecent(currentUserId, rawQuery.trim());
    setRecentSearches(loadRecent(currentUserId));
    setShowHints(false);
    inputRef.current?.blur();
  }, [rawQuery, currentUserId]);

  const applyRecent = (q: string) => {
    setRawQuery(q);
    setShowHints(false);
  };

  const deleteRecent = (q: string) => {
    setRecentSearches(removeRecent(currentUserId, q));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); handleSubmit(); }
    if (e.key === "Escape") { onClose(); }
  };

  return (
    <div className="flex flex-col h-full" data-testid="search-panel">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0">
        <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 relative">
          <Popover open={showHints} onOpenChange={setShowHints}>
            <PopoverTrigger asChild>
              <Input
                ref={inputRef}
                value={rawQuery}
                onChange={(e) => { setRawQuery(e.target.value); setShowHints(true); }}
                onFocus={() => setShowHints(true)}
                onBlur={() => setTimeout(() => setShowHints(false), 150)}
                onKeyDown={handleKeyDown}
                placeholder={scopeChannelId
                  ? 'Search this channel… (try from:name, before:2026-01-01)'
                  : 'Search all messages… (try from:name, in:channel, before:2026-01-01)'}
                className="h-8 border-0 bg-transparent focus-visible:ring-0 p-0 text-sm"
                autoFocus
                data-testid="search-panel-input"
              />
            </PopoverTrigger>
            <PopoverContent
              className="p-0 w-auto border-0 shadow-none bg-transparent"
              align="start"
              sideOffset={4}
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              <ModifierHintPopover
                input={rawQuery}
                channels={channels}
                users={pickerUsers}
                onInsert={(text) => {
                  setRawQuery(text);
                  setShowHints(true);
                  setTimeout(() => inputRef.current?.focus(), 0);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
        {rawQuery && (
          <button
            onClick={() => { setRawQuery(""); inputRef.current?.focus(); }}
            className="text-muted-foreground hover:text-foreground flex-shrink-0"
            data-testid="search-panel-clear"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground flex-shrink-0"
          data-testid="search-panel-close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Inline validation errors */}
      {parsed.errors.length > 0 && (
        <div className="flex flex-wrap gap-1 px-4 py-1.5 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800 flex-shrink-0">
          {parsed.errors.map((err, i) => (
            <Badge key={i} variant="outline" className="text-xs text-amber-700 dark:text-amber-400 border-amber-300">
              {err}
            </Badge>
          ))}
        </div>
      )}

      {/* Active modifier badges */}
      {(parsed.modifiers.fromUsername || parsed.modifiers.inChannelSlug || parsed.modifiers.after || parsed.modifiers.before || parsed.modifiers.excluded.length > 0) && (
        <div className="flex flex-wrap gap-1 px-4 py-1.5 border-b border-border flex-shrink-0" data-testid="active-modifiers">
          {parsed.modifiers.fromUsername && (
            <Badge variant="secondary" className="text-xs">
              from: {parsed.modifiers.fromUsername}
            </Badge>
          )}
          {parsed.modifiers.inChannelSlug && (
            <Badge variant="secondary" className="text-xs">
              in: #{parsed.modifiers.inChannelSlug}
            </Badge>
          )}
          {parsed.modifiers.after && (
            <Badge variant="secondary" className="text-xs">
              after: {parsed.modifiers.after}
            </Badge>
          )}
          {parsed.modifiers.before && !parsed.modifiers.on && (
            <Badge variant="secondary" className="text-xs">
              before: {parsed.modifiers.before}
            </Badge>
          )}
          {parsed.modifiers.on && (
            <Badge variant="secondary" className="text-xs">
              on: {parsed.modifiers.on}
            </Badge>
          )}
          {parsed.modifiers.excluded.map((ex) => (
            <Badge key={ex} variant="secondary" className="text-xs text-destructive border-destructive/30">
              −{ex}
            </Badge>
          ))}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {!hasQuery && recentSearches.length > 0 && (
          <div className="flex-1 overflow-y-auto py-2">
            <p className="px-4 pb-1 text-caption font-semibold uppercase tracking-wider text-muted-foreground">
              Recent searches
            </p>
            {recentSearches.map((q) => (
              <div
                key={q}
                className="flex items-center gap-2 px-4 py-2 hover:bg-muted/50 group"
              >
                <Clock className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                <button
                  className="flex-1 text-sm text-left truncate text-foreground"
                  onClick={() => applyRecent(q)}
                  data-testid={`recent-search-${q}`}
                >
                  {q}
                </button>
                <button
                  className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => deleteRecent(q)}
                  data-testid={`recent-search-delete-${q}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {!hasQuery && recentSearches.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center py-12 text-center px-4">
            <Search className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">Search Comms</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Type keywords or use modifiers like <code className="bg-muted px-0.5 rounded">from:name</code>,{" "}
              <code className="bg-muted px-0.5 rounded">in:#channel</code>, or{" "}
              <code className="bg-muted px-0.5 rounded">before:2026-01-01</code>
            </p>
          </div>
        )}

        {hasQuery && (
          <Tabs value={tab} onValueChange={(v) => setTab(v as "messages" | "files")} className="flex-1 flex flex-col overflow-hidden">
            <TabsList className="mx-4 mt-2 mb-0 flex-shrink-0 w-auto self-start h-8">
              <TabsTrigger value="messages" className="text-xs h-7 px-3" data-testid="tab-messages">
                <MessageSquare className="h-3.5 w-3.5 mr-1" />
                Messages
              </TabsTrigger>
              <TabsTrigger value="files" className="text-xs h-7 px-3" data-testid="tab-files">
                <FileText className="h-3.5 w-3.5 mr-1" />
                Files
              </TabsTrigger>
            </TabsList>

            {/* Messages tab */}
            <TabsContent value="messages" className="flex-1 overflow-y-auto mt-0 py-1 data-[state=inactive]:hidden">
              {msgLoading && (
                <div className="flex justify-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
              {!msgLoading && displayedResults.length === 0 && (
                <p className="text-center text-xs text-muted-foreground py-6 px-4">
                  No messages found
                </p>
              )}
              {displayedResults.map((msg) => (
                <button
                  key={msg.id}
                  className="w-full text-left px-4 py-2.5 hover:bg-muted/50 border-b border-border/30 transition-colors"
                  onClick={() => {
                    saveRecent(currentUserId, rawQuery.trim());
                    setRecentSearches(loadRecent(currentUserId));
                    onJumpTo?.(msg.channelId, msg.id, null);
                  }}
                  data-testid={`msg-result-${msg.id}`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-xs font-medium text-foreground">{displayName(msg.user)}</span>
                    <span className="text-caption text-muted-foreground">in #{channelNameFor(msg.channelId)}</span>
                    <span className="text-caption text-muted-foreground ml-auto">{formatTime(msg.createdAt)}</span>
                  </div>
                  <div className="text-sm text-muted-foreground line-clamp-2">{renderContent(msg.content ?? "")}</div>
                </button>
              ))}
            </TabsContent>

            {/* Files tab */}
            <TabsContent value="files" className="flex-1 overflow-y-auto mt-0 py-1 data-[state=inactive]:hidden">
              {fileLoading && (
                <div className="flex justify-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
              {!fileLoading && displayedFileResults.length === 0 && (
                <p className="text-center text-xs text-muted-foreground py-6 px-4">
                  No files found
                </p>
              )}
              {displayedFileResults.map((att) => (
                <div
                  key={att.id}
                  className="px-4 py-2.5 border-b border-border/30 flex items-start gap-3 hover:bg-muted/30"
                  data-testid={`file-result-${att.id}`}
                >
                  <FileThumb att={att} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-foreground truncate">{att.filename}</span>
                      <span className="text-caption text-muted-foreground flex-shrink-0">{formatTime(att.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-caption text-muted-foreground">
                        {att.uploaderFirstName || att.uploaderLastName
                          ? `${att.uploaderFirstName ?? ""} ${att.uploaderLastName ?? ""}`.trim()
                          : "Unknown"}
                      </span>
                      {att.channelName && (
                        <span className="text-caption text-muted-foreground">· #{att.channelName}</span>
                      )}
                      {att.sizeBytes && (
                        <span className="text-caption text-muted-foreground">· {formatBytes(att.sizeBytes)}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <button
                        className="flex items-center gap-1 text-caption text-primary-ink hover:text-primary-ink/80"
                        onClick={() => {
                          saveRecent(currentUserId, rawQuery.trim());
                          setRecentSearches(loadRecent(currentUserId));
                          onJumpTo?.(att.channelId, att.messageId, null);
                        }}
                        data-testid={`file-result-jump-${att.id}`}
                      >
                        <MessageSquare className="h-3 w-3" />
                        Jump to message
                      </button>
                      <a
                        href={`/api/comms/attachments/${att.objectKey}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
                        download={att.filename}
                        onClick={(e) => e.stopPropagation()}
                        data-testid={`file-result-download-${att.id}`}
                      >
                        <Download className="h-3 w-3" />
                        Download
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
