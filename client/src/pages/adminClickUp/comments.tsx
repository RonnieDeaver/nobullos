// ClickUp admin — rich-text comment rendering/composer + task & list comment threads.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Loader2,
  MessageSquare,
  Trash2,
  UserCheck,
  CircleDot,
} from "lucide-react";
import type { Comment, CommentBlock, Task } from "./types";

// ─── Rich-text comment helpers ────────────────────────────────────────────────

/**
 * Render a ClickUp `comment` blocks array into styled React nodes.
 * Falls back gracefully when blocks are missing/empty.
 */
export function renderCommentBlocks(blocks: CommentBlock[] | undefined | null): React.ReactNode {
  if (!blocks || blocks.length === 0) return null;
  return (
    <>
      {blocks.map((block, i) => {
        const { text, attributes: a } = block;
        if (!a || Object.keys(a).length === 0) {
          return <span key={i}>{text}</span>;
        }
        if (a.mention?.user) {
          return (
            <span key={i} className="text-purple-600 font-medium">
              @{a.mention.user.username}
            </span>
          );
        }
        if (a.link) {
          return (
            <a key={i} href={a.link} target="_blank" rel="noreferrer" className="text-blue-600 underline">
              {text}
            </a>
          );
        }
        if (a.code) {
          return (
            <code key={i} className="bg-muted rounded px-1 text-[11px] font-mono">
              {text}
            </code>
          );
        }
        let cls = "";
        if (a.bold) cls += "font-bold ";
        if (a.italic) cls += "italic ";
        if (a.underline) cls += "underline ";
        if (a.strikethrough) cls += "line-through ";
        return <span key={i} className={cls.trim() || undefined}>{text}</span>;
      })}
    </>
  );
}

/**
 * Parse a user-typed comment string with simple inline markup into ClickUp
 * comment blocks. Supported markers:
 *   **bold**  *italic*  `code`  [text](url)  @username (plain mention text)
 */
export function parseCommentMarkup(text: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[(.+?)\]\((.+?)\)/gs;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      if (plain) blocks.push({ text: plain });
    }
    if (match[1] !== undefined) {
      blocks.push({ text: match[1], attributes: { bold: true } });
    } else if (match[2] !== undefined) {
      blocks.push({ text: match[2], attributes: { italic: true } });
    } else if (match[3] !== undefined) {
      blocks.push({ text: match[3], attributes: { code: true } });
    } else if (match[4] !== undefined && match[5] !== undefined) {
      blocks.push({ text: match[4], attributes: { link: match[5] } });
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) blocks.push({ text: text.slice(lastIndex) });
  return blocks.length > 0 ? blocks : [{ text }];
}

/** Wrap selected text in a textarea with a prefix+suffix marker. */
export function wrapSelection(
  ref: React.RefObject<HTMLTextAreaElement>,
  pre: string,
  suf: string,
  setState: (s: string) => void,
): void {
  const el = ref.current;
  if (!el) return;
  const { selectionStart: start, selectionEnd: end, value } = el;
  const selected = value.slice(start, end) || "text";
  const next = value.slice(0, start) + pre + selected + suf + value.slice(end);
  setState(next);
  setTimeout(() => {
    el.focus();
    el.setSelectionRange(start + pre.length, start + pre.length + selected.length);
  }, 0);
}

// ─── Rich comment composer ────────────────────────────────────────────────────

export function RichCommentComposer({
  placeholder,
  onSubmit,
  pending,
  buttonLabel,
  compact,
}: {
  placeholder?: string;
  onSubmit(blocks: CommentBlock[], text: string): void;
  pending: boolean;
  buttonLabel?: string;
  compact?: boolean;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const blocks = parseCommentMarkup(trimmed);
    onSubmit(blocks, trimmed);
    setText("");
  };

  const wrap = (pre: string, suf: string) =>
    wrapSelection(textareaRef as React.RefObject<HTMLTextAreaElement>, pre, suf, setText);

  return (
    <div className="space-y-1">
      {/* Toolbar */}
      <div className="flex gap-1">
        <button
          type="button"
          className="text-xs px-2 py-0.5 border rounded font-bold text-muted-foreground hover:bg-muted"
          onClick={() => wrap("**", "**")}
          title="Bold — **text**"
          data-testid="btn-comment-bold"
        >B</button>
        <button
          type="button"
          className="text-xs px-2 py-0.5 border rounded italic text-muted-foreground hover:bg-muted"
          onClick={() => wrap("*", "*")}
          title="Italic — *text*"
          data-testid="btn-comment-italic"
        >I</button>
        <button
          type="button"
          className="text-xs px-2 py-0.5 border rounded font-mono text-muted-foreground hover:bg-muted"
          onClick={() => wrap("`", "`")}
          title="Code — `text`"
          data-testid="btn-comment-code"
        >{"`"}</button>
        <span className="text-[10px] text-muted-foreground ml-1 self-center">**bold** *italic* `code` [text](url)</span>
      </div>
      <div className={`flex gap-2 ${compact ? "items-center" : "items-end"}`}>
        <textarea
          ref={textareaRef as any}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder ?? "Add a comment… (supports **bold**, *italic*, `code`, [text](url))"}
          className={`text-xs flex-1 border rounded px-2 py-1.5 resize-none outline-none focus:ring-1 focus:ring-purple-300 ${compact ? "h-8 leading-5" : "min-h-[60px]"}`}
          data-testid="input-rich-comment"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={pending || !text.trim()}
          data-testid="btn-submit-comment"
          className={compact ? "h-8 px-2" : undefined}
        >
          {pending ? <Loader2 className="w-3 h-3 animate-spin" /> : <MessageSquare className="w-3 h-3" />}
          {!compact && <span className="ml-1">{buttonLabel ?? "Comment"}</span>}
        </Button>
      </div>
    </div>
  );
}

// ─── Task comments tab ────────────────────────────────────────────────────────

export function TaskCommentsTab({ taskId }: { taskId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Pagination cursor: { start: epoch-ms, start_id: string } of last visible comment
  const [paginationCursor, setPaginationCursor] = useState<{
    start: number;
    start_id: string;
  } | null>(null);
  const [allComments, setAllComments] = useState<Comment[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const PAGE_SIZE = 25;

  // Initial page fetch
  const { data: firstPage, isLoading } = useQuery<{ comments: Comment[] }>({
    queryKey: ["/api/clickup/tasks", taskId, "comments", "page0"],
    queryFn: async () => {
      const res = await fetch(`/api/clickup/tasks/${taskId}/comments`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json();
    },
    enabled: !!taskId,
    refetchInterval: 20_000,
  });

  // Merge new first-page data into allComments
  useEffect(() => {
    if (!firstPage) return;
    const page = firstPage.comments ?? [];
    setAllComments((prev) => {
      const ids = new Set(page.map((c) => c.id));
      const older = prev.filter((c) => !ids.has(c.id));
      const merged = [...page, ...older];
      setHasMore(page.length >= PAGE_SIZE);
      return merged;
    });
  }, [firstPage]);

  const loadMoreMut = useMutation({
    mutationFn: async () => {
      if (!paginationCursor) {
        // Use the oldest comment currently shown
        const oldest = allComments[allComments.length - 1];
        if (!oldest) return [];
        const url = `/api/clickup/tasks/${taskId}/comments?start=${oldest.date}&start_id=${oldest.id}`;
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`Failed (${res.status})`);
        const d = await res.json();
        return d.comments ?? [];
      }
      const url = `/api/clickup/tasks/${taskId}/comments?start=${paginationCursor.start}&start_id=${paginationCursor.start_id}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const d = await res.json();
      return d.comments ?? [];
    },
    onSuccess: (older: Comment[]) => {
      if (older.length === 0) {
        setHasMore(false);
        return;
      }
      setAllComments((prev) => {
        const ids = new Set(prev.map((c) => c.id));
        const next = [...prev, ...older.filter((c) => !ids.has(c.id))];
        const last = next[next.length - 1];
        if (last) setPaginationCursor({ start: Number(last.date), start_id: last.id });
        setHasMore(older.length >= PAGE_SIZE);
        return next;
      });
    },
    onError: (e: any) =>
      toast({ title: "Failed to load older comments", description: e.message, variant: "destructive" }),
  });

  const addMut = useMutation({
    mutationFn: async ({ blocks, text }: { blocks: CommentBlock[]; text: string }) => {
      const res = await fetch(`/api/clickup/tasks/${taskId}/comments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: blocks, comment_text: text }),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/tasks", taskId, "comments", "page0"] }); // fire-and-forget: cache refresh only
      toast({ title: "Comment added" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to add comment", description: e.message, variant: "destructive" }),
  });

  const resolveMut = useMutation({
    mutationFn: async ({ commentId, resolved }: { commentId: string; resolved: boolean }) => {
      const res = await fetch(`/api/clickup/comments/${commentId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved }),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
    },
    onSuccess: (_data, vars) => {
      setAllComments((prev) =>
        prev.map((c) => (c.id === vars.commentId ? { ...c, resolved: vars.resolved } : c)),
      );
      toast({ title: vars.resolved ? "Comment resolved" : "Comment unresolved" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to update comment", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (commentId: string) => {
      const res = await fetch(`/api/clickup/comments/${commentId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
    },
    onSuccess: (_data, commentId) => {
      setAllComments((prev) => prev.filter((c) => c.id !== commentId));
      toast({ title: "Comment deleted" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to delete comment", description: e.message, variant: "destructive" }),
  });

  const comments = allComments;

  return (
    <div className="space-y-3 pt-1" data-testid="task-comments-tab">
      {/* Comment list */}
      <div className="space-y-2 max-h-72 overflow-y-auto" data-testid="list-comments">
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading comments…
          </div>
        )}
        {!isLoading && comments.length === 0 && (
          <p className="text-xs text-muted-foreground italic">No comments yet</p>
        )}
        {comments.map((c) => (
          <CommentRow
            key={c.id}
            comment={c}
            taskId={taskId}
            expandedReplies={expandedReplies}
            setExpandedReplies={setExpandedReplies}
            replyingTo={replyingTo}
            setReplyingTo={setReplyingTo}
            onResolve={(resolved) => resolveMut.mutate({ commentId: c.id, resolved })}
            onDelete={() => setPendingDeleteId(c.id)}
            resolvePending={resolveMut.isPending}
          />
        ))}
        <ConfirmActionDialog
          open={pendingDeleteId != null}
          onOpenChange={(open) => { if (!open) setPendingDeleteId(null); }}
          title="Delete this comment?"
          description="This deletes the comment (and its thread replies) from the ClickUp task for everyone. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => {
            if (pendingDeleteId) deleteMut.mutate(pendingDeleteId);
            setPendingDeleteId(null);
          }}
          testId="dialog-delete-task-comment"
        />
        {/* Load older button — comments are newest→oldest, so "older" is at the end */}
        {hasMore && (
          <Button
            size="sm"
            variant="outline"
            className="w-full text-xs"
            onClick={() => loadMoreMut.mutate()}
            disabled={loadMoreMut.isPending}
            data-testid="btn-load-older-comments"
          >
            {loadMoreMut.isPending ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <ChevronDown className="w-3 h-3 mr-1" />
            )}
            Load older comments
          </Button>
        )}
      </div>

      {/* New comment composer */}
      <RichCommentComposer
        onSubmit={(blocks, text) => addMut.mutate({ blocks, text })}
        pending={addMut.isPending}
      />
    </div>
  );
}

// ─── Single comment row (with threaded replies) ───────────────────────────────

export function CommentRow({
  comment: c,
  taskId,
  expandedReplies,
  setExpandedReplies,
  replyingTo,
  setReplyingTo,
  onResolve,
  onDelete,
  resolvePending,
}: {
  comment: Comment;
  taskId: string;
  expandedReplies: Set<string>;
  setExpandedReplies: React.Dispatch<React.SetStateAction<Set<string>>>;
  replyingTo: string | null;
  setReplyingTo: React.Dispatch<React.SetStateAction<string | null>>;
  onResolve(resolved: boolean): void;
  onDelete(): void;
  resolvePending: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const showReplies = expandedReplies.has(c.id);

  const { data: repliesData, isLoading: repliesLoading } = useQuery<{ comments: Comment[] }>({
    queryKey: ["/api/clickup/comments", c.id, "replies"],
    queryFn: async () => {
      const res = await fetch(`/api/clickup/comments/${c.id}/replies`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json();
    },
    enabled: showReplies,
  });

  const replyMut = useMutation({
    mutationFn: async ({ blocks, text }: { blocks: CommentBlock[]; text: string }) => {
      const res = await fetch(`/api/clickup/comments/${c.id}/replies`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: blocks, comment_text: text }),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/comments", c.id, "replies"] }); // fire-and-forget: cache refresh only
      setReplyingTo(null);
      toast({ title: "Reply added" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to add reply", description: e.message, variant: "destructive" }),
  });

  const richContent = (c.comment?.length ?? 0) > 0
    ? renderCommentBlocks(c.comment)
    : <span className="whitespace-pre-wrap">{c.comment_text}</span>;

  const replies = repliesData?.comments ?? [];
  const replyCount = c.reply_count ?? replies.length;

  return (
    <div
      className={`rounded p-2 text-xs border ${c.resolved ? "bg-green-50 border-green-200 opacity-75" : "bg-muted/50 border-border"}`}
      data-testid={`comment-${c.id}`}
    >
      {/* Header row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-medium text-foreground">{c.user.username}</span>
        <span className="text-muted-foreground">{new Date(Number(c.date)).toLocaleString()}</span>
        {c.resolved && (
          <span className="flex items-center gap-0.5 text-green-600 text-[10px] font-medium">
            <CheckCircle2 className="w-3 h-3" /> Resolved
          </span>
        )}
        {c.assignee && (
          <span className="flex items-center gap-0.5 text-blue-600 text-[10px]">
            <UserCheck className="w-3 h-3" /> {c.assignee.username}
          </span>
        )}
        {/* Actions */}
        <div className="ml-auto flex items-center gap-1">
          <button
            className="text-muted-foreground hover:text-green-600"
            title={c.resolved ? "Unresolve" : "Resolve"}
            onClick={() => onResolve(!c.resolved)}
            disabled={resolvePending}
            data-testid={`btn-resolve-comment-${c.id}`}
          >
            {c.resolved ? (
              <CircleDot className="w-3 h-3" />
            ) : (
              <CheckCircle2 className="w-3 h-3" />
            )}
          </button>
          <button
            className="text-muted-foreground hover:text-red-500"
            title="Delete comment"
            onClick={onDelete}
            data-testid={`btn-delete-comment-${c.id}`}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="mt-1 text-foreground leading-relaxed">{richContent}</div>

      {/* Reply controls */}
      <div className="mt-1.5 flex items-center gap-2">
        <button
          className="flex items-center gap-0.5 text-muted-foreground hover:text-purple-600"
          onClick={() => setReplyingTo(replyingTo === c.id ? null : c.id)}
          data-testid={`btn-reply-${c.id}`}
        >
          <CornerDownRight className="w-3 h-3" /> Reply
        </button>
        {(replyCount > 0 || showReplies) && (
          <button
            className="flex items-center gap-0.5 text-muted-foreground hover:text-purple-600"
            onClick={() =>
              setExpandedReplies((prev) => {
                const n = new Set(prev);
                if (n.has(c.id)) n.delete(c.id);
                else n.add(c.id);
                return n;
              })
            }
            data-testid={`btn-toggle-replies-${c.id}`}
          >
            <MessageSquare className="w-3 h-3" />
            {replyCount > 0 ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}` : "Replies"}
            {showReplies ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>
        )}
      </div>

      {/* Inline reply composer */}
      {replyingTo === c.id && (
        <div className="mt-2 pl-3 border-l-2 border-purple-200">
          <RichCommentComposer
            placeholder="Write a reply…"
            onSubmit={(blocks, text) => replyMut.mutate({ blocks, text })}
            pending={replyMut.isPending}
            buttonLabel="Reply"
            compact
          />
        </div>
      )}

      {/* Expanded replies */}
      {showReplies && (
        <div className="mt-2 pl-3 border-l-2 border-border space-y-2">
          {repliesLoading && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading replies…
            </div>
          )}
          {!repliesLoading && replies.length === 0 && (
            <p className="text-xs text-muted-foreground italic">No replies yet</p>
          )}
          {replies.map((r) => {
            const rRich = (r.comment?.length ?? 0) > 0
              ? renderCommentBlocks(r.comment)
              : <span className="whitespace-pre-wrap">{r.comment_text}</span>;
            return (
              <div key={r.id} className="bg-card rounded p-1.5 text-xs border border-border" data-testid={`reply-${r.id}`}>
                <span className="font-medium text-foreground">{r.user.username}</span>
                <span className="text-muted-foreground ml-1.5">{new Date(Number(r.date)).toLocaleString()}</span>
                <div className="mt-0.5 text-foreground leading-relaxed">{rRich}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── List comments panel ──────────────────────────────────────────────────────

export function ListCommentsPanel({ listId }: { listId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [allComments, setAllComments] = useState<Comment[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const PAGE_SIZE = 25;

  const { data: firstPage, isLoading } = useQuery<{ comments: Comment[] }>({
    queryKey: ["/api/clickup/lists", listId, "comments", "page0"],
    queryFn: async () => {
      const res = await fetch(`/api/clickup/lists/${listId}/comments`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json();
    },
    enabled: !!listId,
    refetchInterval: 20_000,
  });

  useEffect(() => {
    if (!firstPage) return;
    const page = firstPage.comments ?? [];
    setAllComments((prev) => {
      const ids = new Set(page.map((c) => c.id));
      const older = prev.filter((c) => !ids.has(c.id));
      setHasMore(page.length >= PAGE_SIZE);
      return [...page, ...older];
    });
  }, [firstPage]);

  const loadMoreMut = useMutation({
    mutationFn: async () => {
      const oldest = allComments[allComments.length - 1];
      if (!oldest) return [];
      const url = `/api/clickup/lists/${listId}/comments?start=${oldest.date}&start_id=${oldest.id}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const d = await res.json();
      return d.comments ?? [];
    },
    onSuccess: (older: Comment[]) => {
      setAllComments((prev) => {
        const ids = new Set(prev.map((c) => c.id));
        const next = [...prev, ...older.filter((c) => !ids.has(c.id))];
        setHasMore(older.length >= PAGE_SIZE);
        return next;
      });
    },
    onError: (e: any) =>
      toast({ title: "Failed to load older comments", description: e.message, variant: "destructive" }),
  });

  const addMut = useMutation({
    mutationFn: async ({ blocks, text }: { blocks: CommentBlock[]; text: string }) => {
      const res = await fetch(`/api/clickup/lists/${listId}/comments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: blocks, comment_text: text }),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/lists", listId, "comments", "page0"] }); // fire-and-forget: cache refresh only
      toast({ title: "Comment added" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to add comment", description: e.message, variant: "destructive" }),
  });

  const resolveMut = useMutation({
    mutationFn: async ({ commentId, resolved }: { commentId: string; resolved: boolean }) => {
      const res = await fetch(`/api/clickup/comments/${commentId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved }),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
    },
    onSuccess: (_data, vars) => {
      setAllComments((prev) =>
        prev.map((c) => (c.id === vars.commentId ? { ...c, resolved: vars.resolved } : c)),
      );
    },
    onError: (e: any) =>
      toast({ title: "Failed to update comment", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (commentId: string) => {
      const res = await fetch(`/api/clickup/comments/${commentId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
    },
    onSuccess: (_data, commentId) => {
      setAllComments((prev) => prev.filter((c) => c.id !== commentId));
    },
    onError: (e: any) =>
      toast({ title: "Failed to delete comment", description: e.message, variant: "destructive" }),
  });

  const comments = allComments;

  return (
    <div className="space-y-3" data-testid="panel-list-comments">
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading list comments…
          </div>
        )}
        {!isLoading && comments.length === 0 && (
          <p className="text-xs text-muted-foreground italic">No list comments yet</p>
        )}
        {comments.map((c) => (
          <CommentRow
            key={c.id}
            comment={c}
            taskId={listId}
            expandedReplies={expandedReplies}
            setExpandedReplies={setExpandedReplies}
            replyingTo={replyingTo}
            setReplyingTo={setReplyingTo}
            onResolve={(resolved) => resolveMut.mutate({ commentId: c.id, resolved })}
            onDelete={() => setPendingDeleteId(c.id)}
            resolvePending={resolveMut.isPending}
          />
        ))}
        <ConfirmActionDialog
          open={pendingDeleteId != null}
          onOpenChange={(open) => { if (!open) setPendingDeleteId(null); }}
          title="Delete this comment?"
          description="This deletes the comment (and its thread replies) from the ClickUp list for everyone. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => {
            if (pendingDeleteId) deleteMut.mutate(pendingDeleteId);
            setPendingDeleteId(null);
          }}
          testId="dialog-delete-list-comment"
        />
        {hasMore && (
          <Button
            size="sm"
            variant="outline"
            className="w-full text-xs"
            onClick={() => loadMoreMut.mutate()}
            disabled={loadMoreMut.isPending}
            data-testid="btn-load-older-list-comments"
          >
            {loadMoreMut.isPending ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <ChevronDown className="w-3 h-3 mr-1" />
            )}
            Load older comments
          </Button>
        )}
      </div>

      <RichCommentComposer
        placeholder="Add a list comment…"
        onSubmit={(blocks, text) => addMut.mutate({ blocks, text })}
        pending={addMut.isPending}
      />
    </div>
  );
}

