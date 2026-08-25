import { useState, useRef, useEffect, useCallback } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Search,
  ChevronDown,
  Filter,
  Pin,
  Bell,
  BellOff,
  Bookmark,
  X,
  Loader2,
  Hash,
  MessageCircle,
  Reply,
  ChevronsDown,
  Settings,
  Archive,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MessageItem } from "./MessageItem";
import { Composer } from "./Composer";
import { ChannelInfoSheet } from "./ChannelInfoSheet";
import { BookmarksBar } from "./BookmarksBar";
import { makeBookmarkSseHandler } from "./bookmarkSse";
import { EditHistoryDialog } from "./EditHistoryDialog";
import { ReminderDialog } from "./ReminderDialog";
import { ForwardDialog } from "./ForwardDialog";
import { useCommsSelector } from "@/contexts/CommsContext";
import { useAuth } from "@/hooks/use-auth";
import type { CommsChannel, CommsMessage } from "./types";
import { channelDisplayName, renderContent } from "./helpers";
import { SearchPanel } from "./SearchPanel";

interface ThreadState {
  parentMsg: CommsMessage;
}

type NotifPref = "all" | "mentions" | "muted";

function PinsPanel({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: pins = [], isLoading } = useQuery({
    queryKey: [`/api/comms/channels/${channelId}/pins`],
    queryFn: () =>
      fetch(`/api/comms/channels/${channelId}/pins`).then((r) => r.json()),
  });

  const unpin = async (messageId: string) => {
    await fetch(`/api/comms/messages/${messageId}/pin`, { method: "DELETE" });
    void qc.invalidateQueries({ queryKey: [`/api/comms/channels/${channelId}/pins`] }); // fire-and-forget: cache refresh only
  };

  return (
    <div className="flex flex-col h-full border-l border-border bg-background">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <Pin className="h-4 w-4" />
          <span className="font-semibold text-sm">Pinned Messages</span>
        </div>
        <button onClick={onClose} aria-label="Close pinned messages" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {isLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!isLoading && pins.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-8 px-4">
            No pinned messages yet.
          </p>
        )}
        {pins.map((pin: any) => (
          <div key={pin.id} className="px-4 py-2 border-b border-border/50">
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm text-foreground break-words flex-1 line-clamp-3">
                {renderContent(pin.message?.content ?? "")}
              </div>
              <button
                onClick={() => unpin(pin.messageId)}
                className="text-xs text-muted-foreground hover:text-foreground flex-shrink-0 mt-0.5"
                aria-label="Unpin message"
                data-testid={`unpin-${pin.messageId}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {pin.message?.user
                ? `${pin.message.user.firstName ?? ""} ${pin.message.user.lastName ?? ""}`.trim()
                : "Unknown"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SavedPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: saved = [], isLoading } = useQuery({
    queryKey: ["/api/comms/saved"],
    queryFn: () => fetch("/api/comms/saved").then((r) => r.json()),
  });

  const unsave = async (messageId: string) => {
    await fetch(`/api/comms/messages/${messageId}/save`, { method: "DELETE" });
    void qc.invalidateQueries({ queryKey: ["/api/comms/saved"] }); // fire-and-forget: cache refresh only
  };

  return (
    <div className="flex flex-col h-full border-l border-border bg-background">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <Bookmark className="h-4 w-4" />
          <span className="font-semibold text-sm">Saved Messages</span>
        </div>
        <button onClick={onClose} aria-label="Close saved messages" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {isLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!isLoading && saved.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-8 px-4">
            No saved messages yet.
          </p>
        )}
        {saved.map((msg: CommsMessage) => (
          <div key={msg.id} className="px-4 py-2 border-b border-border/50">
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm text-foreground break-words flex-1 line-clamp-3">
                {renderContent(msg.content ?? "")}
              </div>
              <button
                onClick={() => unsave(msg.id)}
                className="text-xs text-muted-foreground hover:text-foreground flex-shrink-0 mt-0.5"
                aria-label="Remove from saved"
                data-testid={`unsave-${msg.id}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {msg.user
                ? `${msg.user.firstName ?? ""} ${msg.user.lastName ?? ""}`.trim()
                : "Unknown"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SearchBar({
  channelId,
  onClose,
  onJumpTo,
}: {
  channelId: string;
  onClose: () => void;
  onJumpTo?: (messageId: string) => void;
}) {
  const [q, setQ] = useState("");
  const [fromUserId, setFromUserId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [results, setResults] = useState<CommsMessage[]>([]);
  const [loading, setLoading] = useState(false);

  const doSearch = useCallback(async () => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: q.trim(), channelId });
      if (fromUserId) params.set("fromUserId", fromUserId);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const data = await fetch(`/api/comms/search?${params}`).then((r) => r.json());
      setResults(Array.isArray(data) ? data : []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [q, channelId, fromUserId, dateFrom, dateTo]);

  useEffect(() => {
    const t = setTimeout(doSearch, 400);
    return () => clearTimeout(t);
  }, [doSearch]);

  return (
    <div className="border-b border-border bg-background flex-shrink-0">
      <div className="flex items-center gap-2 px-4 py-2">
        <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search in this channel…"
          className="h-7 border-0 bg-transparent focus-visible:ring-0 p-0 text-sm"
          autoFocus
          data-testid="channel-search-input"
        />
        <button
          onClick={() => setShowFilters((v) => !v)}
          className={cn(
            "text-muted-foreground hover:text-foreground transition-colors",
            showFilters && "text-primary-ink",
          )}
          data-testid="search-filters-toggle"
        >
          <Filter className="h-4 w-4" />
        </button>
        <button onClick={onClose} aria-label="Close search" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      {showFilters && (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
          <Input
            value={fromUserId}
            onChange={(e) => setFromUserId(e.target.value)}
            placeholder="From user ID…"
            className="h-6 text-xs w-36"
            data-testid="search-filter-user"
          />
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-6 text-xs w-32"
            data-testid="search-filter-date-from"
          />
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-6 text-xs w-32"
            data-testid="search-filter-date-to"
          />
        </div>
      )}
      {(loading || results.length > 0 || q.trim().length >= 2) && (
        <div className="max-h-48 overflow-y-auto border-t border-border">
          {loading && (
            <div className="flex justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && results.length === 0 && q.trim().length >= 2 && (
            <p className="text-center text-xs text-muted-foreground py-3">No results</p>
          )}
          {results.map((msg) => (
            <div
              key={msg.id}
              className="px-4 py-2 hover:bg-muted/50 cursor-pointer border-b border-border/30"
              data-testid={`search-result-${msg.id}`}
              onClick={() => onJumpTo?.(msg.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && onJumpTo?.(msg.id)}
            >
              <p className="text-xs text-muted-foreground mb-0.5">
                {msg.user
                  ? `${msg.user.firstName ?? ""} ${msg.user.lastName ?? ""}`.trim()
                  : "Unknown"}
              </p>
              <div className="text-sm text-foreground line-clamp-2">{renderContent(msg.content ?? "")}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MessagePane({
  channel,
  currentUserId,
  hideComposer = false,
  hideHeader = false,
  initialMessageId = null,
  mediaCompact = false,
}: {
  channel: CommsChannel;
  currentUserId: string;
  hideComposer?: boolean;
  /** Suppress the built-in MessagePane header (channel name + search/pins/settings toolbar).
   *  Use this when the parent page renders its own header (e.g. ChannelHeader with call controls). */
  hideHeader?: boolean;
  /** Permalink target: message id from the URL to jump to on open. */
  initialMessageId?: string | null;
  /** Narrow surface (340px popup): render capped images + compact link previews. */
  mediaCompact?: boolean;
}) {
  const qc = useQueryClient();
  // Narrow store subscriptions (Task #3848): addSseListener is a stable
  // callback and notificationSettings only changes when the user edits their
  // prefs — SSE bursts in other channels never re-render this pane.
  const addSseListener = useCommsSelector((s) => s.addSseListener);
  const notificationSettings = useCommsSelector((s) => s.notificationSettings);
  const { user } = useAuth();
  const myKeywords = notificationSettings?.keywords ?? [];
  const bottomRef = useRef<HTMLDivElement>(null);

  // Determine if the current user is a channel admin (owner/channel_admin role, or team_lead/CEO)
  const userRole = (user as any)?.dbUser?.role ?? "";
  const isTeamLead = userRole === "team_lead" || userRole === "ceo";
  const currentMember = channel.members?.find((m) => m.userId === currentUserId);
  const isChannelAdmin =
    isTeamLead || (currentMember ? currentMember.role === "owner" || currentMember.role === "channel_admin" : false);

  // Invalidate bookmarks query on SSE bookmark events for this channel
  useEffect(() => {
    return addSseListener(makeBookmarkSseHandler(qc, channel.id));
  }, [addSseListener, channel.id, qc]);
  const [thread, setThread] = useState<ThreadState | null>(null);
  const [editingMsg, setEditingMsg] = useState<CommsMessage | null>(null);
  const [editContent, setEditContent] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [sidePanel, setSidePanel] = useState<"pins" | "saved" | "info" | null>(null);
  const [notifPref, setNotifPref] = useState<NotifPref>(channel.notifPref ?? "all");
  const [highlightedMsgId, setHighlightedMsgId] = useState<string | null>(null);
  const [editHistoryMsg, setEditHistoryMsg] = useState<CommsMessage | null>(null);
  const [remindMsg, setRemindMsg] = useState<CommsMessage | null>(null);
  const [forwardMsg, setForwardMsg] = useState<CommsMessage | null>(null);
  const messageListRef = useRef<HTMLDivElement>(null);

  // Anchor mode: when the oldest-unread message is outside the tail window we switch
  // to loading a context window centred on it via ?around=<id>. null = tail (default).
  const [anchorMsgId, setAnchorMsgId] = useState<string | null>(null);
  // Set to true when we want to scroll to the anchor after the anchor query resolves.
  const pendingAnchorScrollRef = useRef(false);

  // Capture oldest-unread at mount time so the divider stays stable while reading.
  // snapshotUnreadIdRef drives the "New Messages" divider (ref so it doesn't re-render the whole list).
  // hasSnapshotUnread is a state mirror used to show/hide the Jump button.
  const snapshotUnreadIdRef = useRef<string | null>(channel.oldestUnreadMessageId ?? null);
  const [hasSnapshotUnread, setHasSnapshotUnread] = useState<boolean>(
    !!(channel.oldestUnreadMessageId),
  );
  useEffect(() => {
    const id = channel.oldestUnreadMessageId ?? null;
    snapshotUnreadIdRef.current = id;
    setHasSnapshotUnread(!!id);
    setAnchorMsgId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  // Mark channel as read on mount and when the channel changes
  useEffect(() => {
    fetch(`/api/comms/channels/${channel.id}/read-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastReadMessageId: null }),
    }).catch(() => {});
  }, [channel.id]);

  // Scroll to and briefly highlight a message (used by search deep-link)
  const jumpToMessage = useCallback((messageId: string) => {
    setShowSearch(false);
    setHighlightedMsgId(messageId);
    requestAnimationFrame(() => {
      const el = messageListRef.current?.querySelector(`[data-msg-id="${messageId}"]`);
      el?.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
    });
    // Remove highlight after 2.5 s
    setTimeout(() => setHighlightedMsgId((cur) => (cur === messageId ? null : cur)), 2500);
  }, []);

  const messagesKey = `/api/comms/channels/${channel.id}/messages`;

  const { data: messages = [], isLoading } = useQuery<CommsMessage[]>({
    queryKey: [messagesKey],
    queryFn: () => fetch(messagesKey).then((r) => r.json()),
    refetchInterval: 8000,
    staleTime: 4000,
  });

  // Anchor window query — only active when anchorMsgId is set.
  const anchorKey = anchorMsgId
    ? `${messagesKey}?around=${encodeURIComponent(anchorMsgId)}`
    : null;
  const { data: anchorMessages = [], isLoading: anchorLoading } = useQuery<CommsMessage[]>({
    queryKey: [anchorKey],
    queryFn: () => fetch(anchorKey!).then((r) => r.json()),
    enabled: !!anchorKey,
    staleTime: 30000,
  });

  // Once the anchor window loads, scroll to the target and highlight it.
  useEffect(() => {
    if (!anchorLoading && anchorMsgId && pendingAnchorScrollRef.current) {
      pendingAnchorScrollRef.current = false;
      jumpToMessage(anchorMsgId);
    }
  }, [anchorLoading, anchorMsgId, jumpToMessage]);

  // Permalink jump: when opened with ?message=<id>, load an anchor window
  // centred on it and scroll + highlight once it resolves.
  useEffect(() => {
    if (!initialMessageId) return;
    pendingAnchorScrollRef.current = true;
    setAnchorMsgId(initialMessageId);
  }, [initialMessageId, channel.id]);

  const { data: threadMessages = [] } = useQuery<CommsMessage[]>({
    queryKey: [`${messagesKey}?parentId=${thread?.parentMsg.id}`],
    queryFn: () =>
      fetch(`${messagesKey}?parentId=${thread!.parentMsg.id}`).then((r) => r.json()),
    enabled: !!thread,
    refetchInterval: 5000,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: motionSafeScrollBehavior() });
  }, [messages.length]);

  const handleReact = async (messageId: string, emoji: string) => {
    try {
      // Slack-style toggle: if the current user already reacted with this exact
      // emoji string, clicking removes it; otherwise it adds (skin-tone variants
      // stay independent — exact string match only).
      const msg =
        messages.find((m) => m.id === messageId) ??
        threadMessages.find((m) => m.id === messageId) ??
        (thread?.parentMsg.id === messageId ? thread.parentMsg : undefined);
      const alreadyMine = msg?.myReactions?.includes(emoji) ?? false;
      if (alreadyMine) {
        await apiRequest(
          "DELETE",
          `/api/comms/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
        );
      } else {
        await apiRequest("POST", `/api/comms/messages/${messageId}/reactions`, { emoji });
      }
      void qc.invalidateQueries({ queryKey: [messagesKey] }); // fire-and-forget: cache refresh only
      if (thread) {
        void qc.invalidateQueries({ queryKey: [`${messagesKey}?parentId=${thread.parentMsg.id}`] }); // fire-and-forget: cache refresh only
      }
    } catch {}
  };

  // Task #4621: deletion confirms through the shared ConfirmActionDialog
  // (controlled mode — delete lives in message hover menus, not a wrappable
  // trigger). Same endpoint, same guards as the old window.confirm.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const handleDelete = (messageId: string) => {
    setPendingDeleteId(messageId);
  };
  const performDelete = async (messageId: string) => {
    try {
      await apiRequest("DELETE", `/api/comms/messages/${messageId}`);
      void qc.invalidateQueries({ queryKey: [messagesKey] }); // fire-and-forget: cache refresh only
    } catch {}
  };

  const startEdit = (msg: CommsMessage) => {
    setEditingMsg(msg);
    setEditContent(msg.content);
  };

  const submitEdit = async () => {
    if (!editingMsg || !editContent.trim()) return;
    try {
      await apiRequest("PATCH", `/api/comms/messages/${editingMsg.id}`, {
        content: editContent.trim(),
      });
      void qc.invalidateQueries({ queryKey: [messagesKey] }); // fire-and-forget: cache refresh only
      setEditingMsg(null);
    } catch {}
  };

  const handlePin = async (messageId: string) => {
    try {
      await apiRequest("POST", `/api/comms/messages/${messageId}/pin`);
      void qc.invalidateQueries({ queryKey: [`/api/comms/channels/${channel.id}/pins`] }); // fire-and-forget: cache refresh only
    } catch {}
  };

  const handleSave = async (messageId: string) => {
    try {
      await apiRequest("POST", `/api/comms/messages/${messageId}/save`);
    } catch {}
  };

  const handleBookmarkAttachment = useCallback(
    async (att: { id: string; objectKey: string; filename: string | null; contentType: string }) => {
      const label = att.filename ?? "File attachment";
      try {
        await fetch(`/api/comms/channels/${channel.id}/bookmarks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "file",
            label,
            attachmentId: att.id,
            objectKey: att.objectKey,
            filename: att.filename ?? undefined,
          }),
          credentials: "include",
        });
        void qc.invalidateQueries({ queryKey: [`/api/comms/channels/${channel.id}/bookmarks`] }); // fire-and-forget: cache refresh only
      } catch {}
    },
    [channel.id, qc],
  );

  const handleMarkUnread = async (messageId: string) => {
    try {
      const res = await fetch(`/api/comms/channels/${channel.id}/mark-unread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
        credentials: "include",
      });
      if (!res.ok) return;
      // Set the snapshot divider to this message so the divider reappears
      snapshotUnreadIdRef.current = messageId;
      setHasSnapshotUnread(true);
      void qc.invalidateQueries({ queryKey: ["/api/comms/channels"] }); // fire-and-forget: cache refresh only
    } catch {}
  };

  const jumpToOldestUnread = () => {
    const msgId = snapshotUnreadIdRef.current;
    if (!msgId) return;
    // If the message is already rendered, scroll to it immediately.
    const el = messageListRef.current?.querySelector(`[data-msg-id="${msgId}"]`);
    if (el) {
      jumpToMessage(msgId);
      return;
    }
    // Message not in current window — switch to anchor mode.
    // The useEffect above will scroll once anchorMessages loads.
    pendingAnchorScrollRef.current = true;
    setAnchorMsgId(msgId);
  };

  const exitAnchorMode = () => {
    setAnchorMsgId(null);
  };

  const changeNotifPref = async (pref: NotifPref) => {
    const prev = notifPref;
    setNotifPref(pref);
    try {
      await apiRequest("PUT", `/api/comms/channels/${channel.id}/notification-pref`, { pref });
    } catch {
      setNotifPref(prev);
    }
  };

  // In anchor mode display the anchor window; in tail mode display the live tail.
  const displayMessages = anchorMsgId ? anchorMessages : messages;
  const filteredMessages = displayMessages.filter((m) => !m.deletedAt);

  return (
    <div className="flex h-full overflow-hidden">
      <ConfirmActionDialog
        open={!!pendingDeleteId}
        onOpenChange={(open) => { if (!open) setPendingDeleteId(null); }}
        title="Delete this message?"
        description="The message is removed from the conversation for everyone in the channel. This cannot be undone."
        confirmLabel="Delete message"
        testId="dialog-confirm-delete-message"
        onConfirm={() => {
          if (pendingDeleteId) void performDelete(pendingDeleteId);
          setPendingDeleteId(null);
        }}
      />
      {/* Main column */}
      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
        {/* Header — suppressed when hideHeader=true (parent page owns the header) */}
        {!hideHeader && <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-background flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Hash className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            <h2 className="font-semibold text-sm truncate">
              {channelDisplayName(channel)}
            </h2>
            {channel.topic && (
              <span className="text-xs text-muted-foreground hidden md:block truncate border-l border-border pl-2">
                {channel.topic}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    setShowSearch((v) => !v);
                    setSidePanel(null);
                  }}
                  className={cn(
                    "h-7 w-7 flex items-center justify-center rounded hover:bg-muted transition-colors",
                    showSearch && "bg-muted",
                  )}
                  data-testid="toggle-search"
                >
                  <Search className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Search</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    setSidePanel((v) => (v === "pins" ? null : "pins"));
                    setShowSearch(false);
                  }}
                  className={cn(
                    "h-7 w-7 flex items-center justify-center rounded hover:bg-muted transition-colors",
                    sidePanel === "pins" && "bg-muted",
                  )}
                  data-testid="toggle-pins"
                >
                  <Pin className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Pinned</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    setSidePanel((v) => (v === "saved" ? null : "saved"));
                    setShowSearch(false);
                  }}
                  className={cn(
                    "h-7 w-7 flex items-center justify-center rounded hover:bg-muted transition-colors",
                    sidePanel === "saved" && "bg-muted",
                  )}
                  data-testid="toggle-saved"
                >
                  <Bookmark className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Saved</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    setSidePanel((v) => (v === "info" ? null : "info"));
                    setShowSearch(false);
                  }}
                  className={cn(
                    "h-7 w-7 flex items-center justify-center rounded hover:bg-muted transition-colors",
                    sidePanel === "info" && "bg-muted",
                  )}
                  data-testid="toggle-channel-info"
                >
                  <Settings className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Channel settings</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="h-7 flex items-center gap-1 px-2 rounded hover:bg-muted text-muted-foreground hover:text-foreground text-xs transition-colors"
                  data-testid="notif-pref-trigger"
                >
                  {notifPref === "muted" ? (
                    <BellOff className="h-4 w-4" />
                  ) : (
                    <Bell className="h-4 w-4" />
                  )}
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => changeNotifPref("all")}
                  className={cn(notifPref === "all" && "font-semibold")}
                  data-testid="notif-pref-all"
                >
                  <Bell className="h-4 w-4 mr-2" /> All messages
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => changeNotifPref("mentions")}
                  className={cn(notifPref === "mentions" && "font-semibold")}
                  data-testid="notif-pref-mentions"
                >
                  <Bell className="h-4 w-4 mr-2" /> Mentions only
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => changeNotifPref("muted")}
                  className={cn(notifPref === "muted" && "font-semibold text-muted-foreground")}
                  data-testid="notif-pref-muted"
                >
                  <BellOff className="h-4 w-4 mr-2" /> Mute
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>}

        {showSearch && (
          <div className="border-b border-border flex-shrink-0">
            <SearchPanel
              currentUserId={currentUserId}
              channels={[channel]}
              scopeChannelId={channel.id}
              onClose={() => setShowSearch(false)}
              onJumpTo={(_channelId, messageId) => jumpToMessage(messageId)}
            />
          </div>
        )}

        <BookmarksBar
          channelId={channel.id}
          isChannelAdmin={isChannelAdmin}
          isArchived={!!channel.archivedAt}
        />

        {channel.archivedAt && (
          <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-300 flex-shrink-0" data-testid="archived-banner">
            <Archive className="h-3.5 w-3.5 flex-shrink-0" />
            <span>This channel is archived and read-only.</span>
          </div>
        )}

        {/* Jump to oldest unread / anchor mode controls */}
        {(hasSnapshotUnread || anchorMsgId) && (
          <div className="flex items-center justify-center gap-3 py-1 px-4 bg-background border-b border-border/50 flex-shrink-0">
            {hasSnapshotUnread && !anchorMsgId && (
              <button
                onClick={jumpToOldestUnread}
                className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-600 font-medium transition-colors"
                data-testid="jump-to-oldest-unread"
              >
                <ChevronsDown className="h-3.5 w-3.5" />
                Jump to new messages
              </button>
            )}
            {anchorMsgId && anchorLoading && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading messages…
              </span>
            )}
            {anchorMsgId && (
              <button
                onClick={exitAnchorMode}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground font-medium transition-colors"
                data-testid="exit-anchor-mode"
              >
                Back to latest
              </button>
            )}
          </div>
        )}

        {/* Messages */}
        <div
          ref={messageListRef}
          className="flex-1 overflow-y-auto py-2"
          data-testid="messages-list"
        >
          {(isLoading || anchorLoading) && filteredMessages.length === 0 && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!isLoading && !anchorLoading && filteredMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <MessageCircle className="h-10 w-10 text-muted-foreground/40 mb-3" />
              <p className="font-medium text-sm">No messages yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Be the first to say something in {channelDisplayName(channel)}.
              </p>
            </div>
          )}
          {filteredMessages.map((msg, i) => {
            const prev = filteredMessages[i - 1];
            const isCompact =
              !!prev &&
              prev.userId === msg.userId &&
              new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() <
                5 * 60 * 1000;
            const isHighlighted = highlightedMsgId === msg.id;
            const isNewMessagesDivider =
              snapshotUnreadIdRef.current !== null &&
              msg.id === snapshotUnreadIdRef.current;
            return (
              <div
                key={msg.id}
                data-msg-id={msg.id}
                className={isHighlighted ? "ring-2 ring-primary/50 bg-primary/5 rounded transition-all" : undefined}
              >
                {isNewMessagesDivider && (
                  <div
                    className="flex items-center gap-2 px-4 py-1 my-1"
                    data-testid="new-messages-divider"
                  >
                    <div className="flex-1 h-px bg-red-400/60" />
                    <span className="text-caption font-semibold text-red-500 uppercase tracking-wider flex-shrink-0">
                      New Messages
                    </span>
                    <div className="flex-1 h-px bg-red-400/60" />
                  </div>
                )}
                <MessageItem
                  msg={msg}
                  currentUserId={currentUserId}
                  onReact={handleReact}
                  onEdit={startEdit}
                  onDelete={handleDelete}
                  onReply={(m) => setThread({ parentMsg: m })}
                  onOpenThread={(m) => setThread({ parentMsg: m })}
                  onPin={handlePin}
                  onSave={handleSave}
                  onMarkUnread={handleMarkUnread}
                  onBookmarkAttachment={handleBookmarkAttachment}
                  onShowEditHistory={setEditHistoryMsg}
                  onRemind={setRemindMsg}
                  onForward={setForwardMsg}
                  isCompact={isCompact}
                  highlightKeywords={myKeywords}
                  mediaCompact={mediaCompact}
                />
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Inline edit bar */}
        {editingMsg && (
          <div className="flex items-center gap-2 px-4 py-2 border-t border-border bg-amber-50 dark:bg-amber-950/20 flex-shrink-0">
            <input
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submitEdit(); // fire-and-forget: errors handled inside submitEdit
                }
                if (e.key === "Escape") setEditingMsg(null);
              }}
              className="flex-1 text-sm bg-transparent outline-none"
              autoFocus
              data-testid="edit-input"
            />
            <Button
              size="sm"
              onClick={submitEdit}
              className="h-6 text-xs"
              data-testid="edit-submit"
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditingMsg(null)}
              className="h-6 text-xs"
              data-testid="edit-cancel"
            >
              Cancel
            </Button>
          </div>
        )}

        {/* Composer — hidden when channel is archived */}
        {!hideComposer && !channel.archivedAt && (
          <Composer
            channelId={channel.id}
            placeholder={`Message ${channelDisplayName(channel)}`}
            onSent={() => bottomRef.current?.scrollIntoView({ behavior: motionSafeScrollBehavior() })}
          />
        )}
      </div>

      {/* Thread panel */}
      {thread && !sidePanel && (
        <div className="w-72 xl:w-80 flex flex-col border-l border-border bg-background flex-shrink-0 h-full overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <div className="flex items-center gap-2">
              <Reply className="h-4 w-4" />
              <span className="font-semibold text-sm">Thread</span>
            </div>
            <button
              onClick={() => setThread(null)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close thread"
              data-testid="close-thread"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            <MessageItem
              msg={thread.parentMsg}
              currentUserId={currentUserId}
              onReact={handleReact}
              onEdit={startEdit}
              onDelete={handleDelete}
              isCompact={false}
              highlightKeywords={myKeywords}
            />
            <div className="px-4 py-2 border-y border-border/50">
              <p className="text-xs text-muted-foreground font-medium">
                {threadMessages.filter((m) => !m.deletedAt).length} replies
              </p>
            </div>
            {threadMessages
              .filter((m) => !m.deletedAt)
              .map((msg) => (
                <MessageItem
                  key={msg.id}
                  msg={msg}
                  currentUserId={currentUserId}
                  onReact={handleReact}
                  onEdit={startEdit}
                  onDelete={handleDelete}
                  isCompact={false}
                  highlightKeywords={myKeywords}
                />
              ))}
          </div>
          <Composer
            channelId={channel.id}
            parentId={thread.parentMsg.id}
            placeholder="Reply…"
            compact
            onSent={() => {
              void qc.invalidateQueries({
                queryKey: [`${messagesKey}?parentId=${thread.parentMsg.id}`],
              }); // fire-and-forget: cache refresh only
            }}
          />
        </div>
      )}

      {/* Pins side panel */}
      {sidePanel === "pins" && (
        <div className="w-72 xl:w-80 flex-shrink-0 h-full overflow-hidden">
          <PinsPanel channelId={channel.id} onClose={() => setSidePanel(null)} />
        </div>
      )}

      {/* Saved side panel */}
      {sidePanel === "saved" && (
        <div className="w-72 xl:w-80 flex-shrink-0 h-full overflow-hidden">
          <SavedPanel onClose={() => setSidePanel(null)} />
        </div>
      )}

      {/* Channel info / settings panel */}
      {sidePanel === "info" && (
        <div className="w-72 xl:w-80 flex-shrink-0 h-full overflow-hidden">
          <ChannelInfoSheet
            channel={channel}
            currentUserId={currentUserId}
            onClose={() => setSidePanel(null)}
            onChannelUpdated={() => {
              void qc.invalidateQueries({ queryKey: [messagesKey] }); // fire-and-forget: cache refresh only
              void qc.invalidateQueries({ queryKey: [`/api/comms/channels/${channel.id}`] }); // fire-and-forget: cache refresh only
            }}
          />
        </div>
      )}

      {/* Edit history dialog */}
      {editHistoryMsg && (
        <EditHistoryDialog
          messageId={editHistoryMsg.id}
          channelId={channel.id}
          isAuthor={editHistoryMsg.userId === currentUserId}
          canRestore={editHistoryMsg.userId === currentUserId || isTeamLead}
          open={!!editHistoryMsg}
          onClose={() => setEditHistoryMsg(null)}
          onRestored={() => {
            void qc.invalidateQueries({ queryKey: [messagesKey] }); // fire-and-forget: cache refresh only
            setEditHistoryMsg(null);
          }}
        />
      )}

      {/* Reminder dialog */}
      {remindMsg && (
        <ReminderDialog
          messageId={remindMsg.id}
          open={!!remindMsg}
          onClose={() => setRemindMsg(null)}
        />
      )}

      {/* Forward dialog */}
      {forwardMsg && (
        <ForwardDialog
          messageId={forwardMsg.id}
          messagePreview={forwardMsg.content}
          open={!!forwardMsg}
          onClose={() => setForwardMsg(null)}
        />
      )}
    </div>
  );
}
