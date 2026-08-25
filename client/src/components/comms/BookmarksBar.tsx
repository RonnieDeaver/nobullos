/**
 * BookmarksBar — compact horizontal bar pinned to the channel header.
 * Shows link bookmarks (open in new tab) and file bookmarks (authenticated download).
 * Members can add bookmarks; channel_admin / team_lead can edit, delete, and drag-reorder.
 * Overflow collapses into a "+N more" dropdown menu.
 * Live-synced via SSE (comms:bookmark events invalidate the query cache).
 */

import { useState, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Plus,
  Link2,
  FileText,
  Pencil,
  Trash2,
  GripVertical,
  ChevronDown,
  ExternalLink,
  Download,
  Smile,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EmojiPicker, AnchoredPortalPanel } from "./EmojiPicker";
import type { CommsBookmark } from "./types";
export { makeBookmarkSseHandler } from "./bookmarkSse";

// Max bookmarks shown inline before collapsing to "+N" overflow menu
const INLINE_LIMIT = 6;

interface BookmarksBarProps {
  channelId: string;
  isChannelAdmin: boolean;
  isArchived: boolean;
}

function BookmarkIcon({ bookmark }: { bookmark: CommsBookmark }) {
  if (bookmark.emoji) {
    return <span className="text-xs leading-none">{bookmark.emoji}</span>;
  }
  if (bookmark.type === "file") {
    return <FileText className="h-3 w-3 flex-shrink-0" />;
  }
  return <Link2 className="h-3 w-3 flex-shrink-0" />;
}

function BookmarkChip({
  bookmark,
  isAdmin,
  isArchived,
  onEdit,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  dragging,
}: {
  bookmark: CommsBookmark;
  isAdmin: boolean;
  isArchived: boolean;
  onEdit: (b: CommsBookmark) => void;
  onDelete: (b: CommsBookmark) => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDrop: (e: React.DragEvent, id: string) => void;
  dragging: boolean;
}) {
  const href =
    bookmark.type === "link"
      ? (bookmark.url ?? "#")
      : bookmark.objectKey
      ? `/api/comms/attachments/${encodeURIComponent(bookmark.objectKey)}`
      : "#";

  const target = bookmark.type === "link" ? "_blank" : undefined;
  const rel = bookmark.type === "link" ? "noopener noreferrer" : undefined;
  const download = bookmark.type === "file" ? (bookmark.filename ?? undefined) : undefined;

  return (
    <div
      className={cn(
        "group/chip flex items-center gap-1 h-6 px-2 rounded border border-border/60 bg-background hover:bg-muted/60 transition-colors flex-shrink-0",
        dragging && "opacity-40",
      )}
      draggable={isAdmin && !isArchived}
      onDragStart={() => onDragStart(bookmark.id)}
      onDragOver={(e) => { e.preventDefault(); onDragOver(e, bookmark.id); }}
      onDrop={(e) => onDrop(e, bookmark.id)}
      data-testid={`bookmark-chip-${bookmark.id}`}
    >
      {isAdmin && !isArchived && (
        <GripVertical className="h-3 w-3 text-muted-foreground/40 group-hover/chip:text-muted-foreground cursor-grab flex-shrink-0 -ml-1" />
      )}
      <a
        href={href}
        target={target}
        rel={rel}
        download={download}
        className="flex items-center gap-1 text-xs text-foreground hover:text-primary-ink min-w-0 max-w-[140px]"
        data-testid={`bookmark-link-${bookmark.id}`}
      >
        <BookmarkIcon bookmark={bookmark} />
        <span className="truncate leading-none">{bookmark.label}</span>
        {bookmark.type === "link" ? (
          <ExternalLink className="h-2.5 w-2.5 opacity-40 flex-shrink-0" />
        ) : (
          <Download className="h-2.5 w-2.5 opacity-40 flex-shrink-0" />
        )}
      </a>
      {isAdmin && !isArchived && (
        <div className="hidden group-hover/chip:flex items-center gap-0.5 ml-0.5">
          <button
            onClick={() => onEdit(bookmark)}
            className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            data-testid={`bookmark-edit-${bookmark.id}`}
          >
            <Pencil className="h-2.5 w-2.5" />
          </button>
          <button
            onClick={() => onDelete(bookmark)}
            className="h-4 w-4 flex items-center justify-center rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
            data-testid={`bookmark-delete-${bookmark.id}`}
          >
            <Trash2 className="h-2.5 w-2.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function AddBookmarkDialog({
  channelId,
  open,
  onClose,
  editTarget,
}: {
  channelId: string;
  open: boolean;
  onClose: () => void;
  editTarget?: CommsBookmark | null;
}) {
  const qc = useQueryClient();
  const [type, setType] = useState<"link" | "file">(editTarget?.type ?? "link");
  const [label, setLabel] = useState(editTarget?.label ?? "");
  const [emoji, setEmoji] = useState(editTarget?.emoji ?? "");
  const [url, setUrl] = useState(editTarget?.url ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const emojiAnchorRef = useRef<HTMLButtonElement | null>(null);

  const isEdit = !!editTarget;

  const reset = () => {
    setType(editTarget?.type ?? "link");
    setLabel(editTarget?.label ?? "");
    setEmoji(editTarget?.emoji ?? "");
    setUrl(editTarget?.url ?? "");
    setError(null);
    setSaving(false);
    setShowEmojiPicker(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSave = async () => {
    if (!label.trim()) { setError("Label is required"); return; }
    if (type === "link" && !url.trim()) { setError("URL is required for link bookmarks"); return; }

    setSaving(true);
    setError(null);

    try {
      if (isEdit) {
        await fetch(`/api/comms/channels/${channelId}/bookmarks/${editTarget.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: label.trim(),
            emoji: emoji.trim() || null,
            url: type === "link" ? url.trim() : undefined,
          }),
          credentials: "include",
        }).then((r) => { if (!r.ok) throw new Error("Failed to update bookmark"); });
      } else {
        const body: Record<string, unknown> = {
          type,
          label: label.trim(),
          emoji: emoji.trim() || null,
        };
        if (type === "link") body.url = url.trim();
        await fetch(`/api/comms/channels/${channelId}/bookmarks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "include",
        }).then(async (r) => {
          if (!r.ok) {
            const body = await r.json().catch(() => null);
            const msg = typeof body?.error === "string" ? body.error : "Failed to create bookmark";
            throw new Error(msg);
          }
        });
      }
      void qc.invalidateQueries({ queryKey: [`/api/comms/channels/${channelId}/bookmarks`] }); // fire-and-forget: cache refresh only
      handleClose();
    } catch (e: any) {
      setError(e.message ?? "Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit bookmark" : "Add bookmark"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {!isEdit && (
            <div className="flex gap-2">
              <button
                onClick={() => setType("link")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 h-8 rounded border text-sm transition-colors",
                  type === "link"
                    ? "border-primary bg-primary/5 text-primary-ink font-medium"
                    : "border-border hover:bg-muted",
                )}
                data-testid="bookmark-type-link"
              >
                <Link2 className="h-3.5 w-3.5" /> Link
              </button>
              <button
                onClick={() => setType("file")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 h-8 rounded border text-sm transition-colors",
                  type === "file"
                    ? "border-primary bg-primary/5 text-primary-ink font-medium"
                    : "border-border hover:bg-muted",
                )}
                data-testid="bookmark-type-file"
              >
                <FileText className="h-3.5 w-3.5" /> File
              </button>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="bm-label" className="text-xs">Label</Label>
            <Input
              id="bm-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Client brief"
              className="h-8 text-sm"
              data-testid="bookmark-label-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Icon / emoji (optional)</Label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                ref={emojiAnchorRef}
                onClick={() => setShowEmojiPicker((v) => !v)}
                className={cn(
                  "h-8 w-8 flex items-center justify-center rounded border text-base transition-colors",
                  "border-border hover:bg-muted",
                )}
                aria-label={emoji ? "Change emoji" : "Pick emoji"}
                data-testid="bookmark-emoji-button"
              >
                {emoji ? (
                  <span data-testid="bookmark-emoji-preview">{emoji}</span>
                ) : (
                  <Smile className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
              {emoji && (
                <button
                  type="button"
                  onClick={() => setEmoji("")}
                  className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  aria-label="Remove emoji"
                  data-testid="bookmark-emoji-clear"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              {showEmojiPicker && (
                <AnchoredPortalPanel
                  anchorRef={emojiAnchorRef}
                  onDismiss={() => setShowEmojiPicker(false)}
                  testId="bookmark-emoji-panel"
                >
                  <EmojiPicker
                    onSelect={(e) => setEmoji(e)}
                    onClose={() => setShowEmojiPicker(false)}
                  />
                </AnchoredPortalPanel>
              )}
            </div>
          </div>
          {(type === "link" || isEdit) && (
            <div className="space-y-1.5">
              <Label htmlFor="bm-url" className="text-xs">URL</Label>
              <Input
                id="bm-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                className="h-8 text-sm"
                data-testid="bookmark-url-input"
              />
            </div>
          )}
          {type === "file" && !isEdit && (
            <p className="text-xs text-muted-foreground">
              File bookmarks can be created from the attachment menu on any message. This dialog creates a link bookmark only.
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving} data-testid="bookmark-save-btn">
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add bookmark"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BookmarksBar({ channelId, isChannelAdmin, isArchived }: BookmarksBarProps) {
  const qc = useQueryClient();
  const bookmarksKey = `/api/comms/channels/${channelId}/bookmarks`;

  const { data: bookmarks = [] } = useQuery<CommsBookmark[]>({
    queryKey: [bookmarksKey],
    queryFn: () => fetch(bookmarksKey, { credentials: "include" }).then((r) => r.json()),
    staleTime: 30000,
  });

  const [showAdd, setShowAdd] = useState(false);
  const [editTarget, setEditTarget] = useState<CommsBookmark | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  // Drag-reorder state
  const dragIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const handleDragStart = useCallback((id: string) => {
    dragIdRef.current = id;
  }, []);

  const handleDragOver = useCallback((_e: React.DragEvent, id: string) => {
    setDragOverId(id);
  }, []);

  const handleDrop = useCallback(
    async (_e: React.DragEvent, targetId: string) => {
      const fromId = dragIdRef.current;
      dragIdRef.current = null;
      setDragOverId(null);
      if (!fromId || fromId === targetId) return;
      const ids = bookmarks.map((b) => b.id);
      const fromIdx = ids.indexOf(fromId);
      const toIdx = ids.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      const reordered = [...ids];
      reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, fromId);
      // Optimistic update
      qc.setQueryData<CommsBookmark[]>([bookmarksKey], (prev) => {
        if (!prev) return prev;
        const map = new Map(prev.map((b) => [b.id, b]));
        return reordered.map((id) => map.get(id)!).filter(Boolean);
      });
      await fetch(`/api/comms/channels/${channelId}/bookmarks/reorder`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: reordered }),
        credentials: "include",
      }).catch(() => {
        void qc.invalidateQueries({ queryKey: [bookmarksKey] }); // fire-and-forget: cache refresh only
      });
    },
    [bookmarks, channelId, bookmarksKey, qc],
  );

  // Task #4621: deletion confirms through the shared ConfirmActionDialog
  // (controlled mode — the delete affordances live inside chips/menus, not a
  // wrappable trigger). Same endpoint, same guards as the old window.confirm.
  const [pendingDelete, setPendingDelete] = useState<CommsBookmark | null>(null);
  const handleDelete = useCallback((b: CommsBookmark) => {
    setPendingDelete(b);
  }, []);
  const performDelete = useCallback(
    async (b: CommsBookmark) => {
      await fetch(`/api/comms/channels/${channelId}/bookmarks/${b.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      void qc.invalidateQueries({ queryKey: [bookmarksKey] }); // fire-and-forget: cache refresh only
    },
    [channelId, bookmarksKey, qc],
  );

  // Product decision (Task #3409): any member may start the bookmarks bar —
  // the POST route already allows all members, so the empty bar renders an
  // add affordance for everyone on non-archived channels. Archived channels
  // with zero bookmarks stay hidden (nothing to show, nothing to add).
  if (bookmarks.length === 0 && isArchived) return null;

  const inline = bookmarks.slice(0, INLINE_LIMIT);
  const overflow = bookmarks.slice(INLINE_LIMIT);

  return (
    <>
      <ConfirmActionDialog
        open={!!pendingDelete}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        title={`Remove bookmark "${pendingDelete?.label ?? ""}"?`}
        description="The bookmark disappears from this channel's bookmarks bar for every member. The linked page or file itself is not affected."
        confirmLabel="Remove bookmark"
        testId="dialog-confirm-remove-bookmark"
        onConfirm={() => {
          if (pendingDelete) void performDelete(pendingDelete);
          setPendingDelete(null);
        }}
      />
      <div
        className="flex items-center gap-1 px-3 py-1 border-b border-border/50 bg-muted/20 min-h-[28px] flex-shrink-0 overflow-x-auto scrollbar-none"
        data-testid="bookmarks-bar"
      >
        {inline.map((b) => (
          <BookmarkChip
            key={b.id}
            bookmark={b}
            isAdmin={isChannelAdmin}
            isArchived={isArchived}
            onEdit={(bk) => { setEditTarget(bk); setShowAdd(true); }}
            onDelete={handleDelete}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            dragging={dragOverId === b.id}
          />
        ))}

        {overflow.length > 0 && (
          <DropdownMenu open={overflowOpen} onOpenChange={setOverflowOpen}>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-0.5 h-6 px-1.5 rounded border border-border/60 hover:bg-muted text-xs text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                data-testid="bookmarks-overflow-trigger"
              >
                +{overflow.length} more <ChevronDown className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[200px]">
              {overflow.map((b) => {
                const href =
                  b.type === "link"
                    ? (b.url ?? "#")
                    : b.objectKey
                    ? `/api/comms/attachments/${encodeURIComponent(b.objectKey)}`
                    : "#";
                return (
                  <DropdownMenuItem key={b.id} asChild>
                    <a
                      href={href}
                      target={b.type === "link" ? "_blank" : undefined}
                      rel={b.type === "link" ? "noopener noreferrer" : undefined}
                      download={b.type === "file" ? (b.filename ?? undefined) : undefined}
                      className="flex items-center gap-2 text-sm"
                      data-testid={`overflow-bookmark-${b.id}`}
                    >
                      <BookmarkIcon bookmark={b} />
                      <span className="truncate">{b.label}</span>
                    </a>
                  </DropdownMenuItem>
                );
              })}
              {isChannelAdmin && !isArchived && (
                <>
                  <DropdownMenuSeparator />
                  {overflow.map((b) => (
                    <div key={`actions-${b.id}`} className="flex items-center gap-1 px-2 py-0.5">
                      <span className="text-xs text-muted-foreground flex-1 truncate">{b.label}</span>
                      <button
                        onClick={() => { setEditTarget(b); setShowAdd(true); setOverflowOpen(false); }}
                        className="h-5 w-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                        data-testid={`overflow-edit-${b.id}`}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => { handleDelete(b); setOverflowOpen(false); }}
                        className="h-5 w-5 flex items-center justify-center rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                        data-testid={`overflow-delete-${b.id}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {!isArchived && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => { setEditTarget(null); setShowAdd(true); }}
                className={cn(
                  "flex items-center justify-center gap-1 h-6 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors flex-shrink-0",
                  bookmarks.length === 0 ? "px-1.5" : "w-6",
                )}
                data-testid="add-bookmark-btn"
              >
                <Plus className="h-3.5 w-3.5" />
                {bookmarks.length === 0 && (
                  <span className="text-xs leading-none">Add bookmark</span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>Add bookmark</TooltipContent>
          </Tooltip>
        )}
      </div>

      <AddBookmarkDialog
        // Remount per target so useState initializers pick up the bookmark
        // being edited — without this, the dialog keeps whatever state it had
        // from the previous open (edit fields render empty/stale).
        key={editTarget?.id ?? "create"}
        channelId={channelId}
        open={showAdd}
        onClose={() => { setShowAdd(false); setEditTarget(null); }}
        editTarget={editTarget}
      />
    </>
  );
}
