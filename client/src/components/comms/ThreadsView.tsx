/**
 * ThreadsView — Mattermost-style "Threads" inbox.
 *
 * Lists all threads the current user follows, sorted by last-reply recency.
 * Each row shows:
 *   - Root-message snippet
 *   - Unread reply count badge (red for mentions, blue otherwise)
 *   - Reply count + participant count
 *   - Follow/unfollow toggle
 *   - Mark-read / mark-unread actions
 * Thread replies do NOT inflate channel unread (enforced server-side).
 */

import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BellOff,
  BellRing,
  CheckCheck,
  Circle,
  GitBranch,
  Loader2,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommsContext } from "@/contexts/CommsContext";
import type { CommsFollowedThread } from "./types";
import { stripFormatting } from "./helpers";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const delta = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function truncate(text: string, max = 80): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// ─── Individual thread row ────────────────────────────────────────────────────

function ThreadRow({
  thread,
  onMarkRead,
  onMarkUnread,
  onFollow,
  onUnfollow,
  onOpen,
}: {
  thread: CommsFollowedThread;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onFollow: () => void;
  onUnfollow: () => void;
  onOpen: () => void;
}) {
  const hasUnread = thread.unreadReplies > 0;
  const hasMention = thread.mentionCount > 0;
  const snippet = thread.rootMessage?.content
    ? truncate(stripFormatting(thread.rootMessage.content))
    : "(no content)";

  return (
    <div
      className={cn(
        "group flex items-start gap-3 px-3 py-2.5 rounded-md hover:bg-muted/60 transition-colors cursor-pointer",
        hasUnread && "bg-primary/5",
      )}
      data-testid={`thread-row-${thread.rootMessageId}`}
      onClick={onOpen}
    >
      {/* Unread dot */}
      <div className="flex-shrink-0 mt-1.5">
        {hasUnread ? (
          <Circle
            className={cn(
              "h-2 w-2 fill-current",
              hasMention ? "text-red-500" : "text-primary",
            )}
            data-testid={`thread-unread-dot-${thread.rootMessageId}`}
          />
        ) : (
          <Circle className="h-2 w-2 text-transparent" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          <span
            className={cn(
              "text-xs truncate",
              hasUnread ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
            data-testid={`thread-snippet-${thread.rootMessageId}`}
          >
            {snippet}
          </span>
          {hasUnread && (
            <Badge
              className={cn(
                "ml-auto flex-shrink-0 text-caption px-1.5 h-4",
                hasMention
                  ? "bg-red-500 text-white"
                  : "bg-primary text-primary-foreground",
              )}
              data-testid={`thread-unread-badge-${thread.rootMessageId}`}
            >
              {hasMention ? `@${thread.mentionCount}` : thread.unreadReplies > 99 ? "99+" : thread.unreadReplies}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
          {thread.replyCount > 0 && (
            <span data-testid={`thread-reply-count-${thread.rootMessageId}`}>
              {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
            </span>
          )}
          {thread.participantIds.length > 0 && (
            <span className="flex items-center gap-0.5">
              <Users className="h-2.5 w-2.5" />
              {thread.participantIds.length}
            </span>
          )}
          {thread.lastReplyAt && (
            <span className="ml-auto">{relativeTime(thread.lastReplyAt)}</span>
          )}
        </div>
      </div>

      {/* Action buttons — visible on hover */}
      <div
        className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        {hasUnread ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onMarkRead}
                data-testid={`thread-mark-read-${thread.rootMessageId}`}
                className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              >
                <CheckCheck className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Mark thread read</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onMarkUnread}
                data-testid={`thread-mark-unread-${thread.rootMessageId}`}
                className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              >
                <Circle className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Mark thread unread</TooltipContent>
          </Tooltip>
        )}

        {thread.following ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onUnfollow}
                data-testid={`thread-unfollow-${thread.rootMessageId}`}
                className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              >
                <BellOff className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Stop following</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onFollow}
                data-testid={`thread-follow-${thread.rootMessageId}`}
                className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              >
                <BellRing className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Follow thread</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

// ─── ThreadsView ──────────────────────────────────────────────────────────────

export function ThreadsView() {
  const {
    followedThreads,
    refetchFollowedThreads,
    refetchThreadSummary,
  } = useCommsContext();
  const [, navigate] = useLocation();
  const [loading, setLoading] = useState(false);

  // Fetch followed threads on mount
  useEffect(() => {
    setLoading(true);
    void refetchFollowedThreads(); // fire-and-forget: mount refresh, errors handled inside
    setLoading(false);
  }, [refetchFollowedThreads]);

  const callThreadApi = useCallback(
    async (rootMessageId: string, path: string, method = "POST") => {
      try {
        await fetch(`/api/comms/threads/${encodeURIComponent(rootMessageId)}/${path}`, {
          method,
          credentials: "include",
        });
        await Promise.all([refetchFollowedThreads(), refetchThreadSummary()]);
      } catch { /* best-effort */ }
    },
    [refetchFollowedThreads, refetchThreadSummary],
  );

  const handleMarkRead = useCallback(
    (rootMessageId: string) => callThreadApi(rootMessageId, "read"),
    [callThreadApi],
  );

  const handleMarkUnread = useCallback(
    (rootMessageId: string) => callThreadApi(rootMessageId, "unread"),
    [callThreadApi],
  );

  const handleFollow = useCallback(
    (rootMessageId: string) => callThreadApi(rootMessageId, "follow"),
    [callThreadApi],
  );

  const handleUnfollow = useCallback(
    (rootMessageId: string) => callThreadApi(rootMessageId, "follow", "DELETE"),
    [callThreadApi],
  );

  const handleOpen = useCallback(
    (thread: CommsFollowedThread) => {
      navigate(`/comms/${thread.channelId}?thread=${thread.rootMessageId}`);
    },
    [navigate],
  );

  const unreadCount = followedThreads.reduce((sum, t) => sum + t.unreadReplies, 0);

  return (
    <div className="flex flex-col h-full" data-testid="threads-view">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Threads</h2>
          {unreadCount > 0 && (
            <Badge
              className="text-caption px-1.5 h-4 bg-primary text-primary-foreground"
              data-testid="threads-view-unread-total"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </Badge>
          )}
        </div>
        {unreadCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7"
            data-testid="threads-mark-all-read"
            onClick={async () => {
              for (const t of followedThreads.filter((th) => th.unreadReplies > 0)) {
                await callThreadApi(t.rootMessageId, "read");
              }
            }}
          >
            <CheckCheck className="h-3.5 w-3.5 mr-1" />
            Mark all read
          </Button>
        )}
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : followedThreads.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6">
          <GitBranch className="h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm font-medium text-muted-foreground">No followed threads</p>
          <p className="text-xs text-muted-foreground/70">
            You automatically follow threads you start, reply to, or are mentioned in.
            You can also manually follow any thread.
          </p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-0.5">
            {followedThreads.map((thread) => (
              <ThreadRow
                key={thread.rootMessageId}
                thread={thread}
                onMarkRead={() => handleMarkRead(thread.rootMessageId)}
                onMarkUnread={() => handleMarkUnread(thread.rootMessageId)}
                onFollow={() => handleFollow(thread.rootMessageId)}
                onUnfollow={() => handleUnfollow(thread.rootMessageId)}
                onOpen={() => handleOpen(thread)}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
