/**
 * CommsSidebarCategories — categorized channel list for the Comms rail.
 *
 * Renders the user's sidebar categories (built-in Favorites / Channels / DMs
 * plus custom ones) from CommsContext. Supports:
 *  - collapsing any category (persisted via PATCH)
 *  - renaming / deleting custom categories
 *  - creating a new custom category via the "+" button
 *  - drag-and-drop of channels within a category (manual reorder) and
 *    between categories (move), using native HTML5 DnD like BookmarksBar
 *  - drag-and-drop reordering of the categories themselves
 *
 * Membership semantics:
 *  - Favorites and custom categories own an explicit ordered channelIds list.
 *  - Built-in Channels / DMs are residual: they show every channel of the
 *    matching type that is not explicitly placed in Favorites or a custom
 *    category, sorted by recency.
 */

import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Building2,
  ChevronRight,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommsContext } from "@/contexts/CommsContext";
import { byChannelRecency } from "./channelGrouping";
import type { CommsChannel } from "./types";
import type { CommsSidebarCategoryResponse } from "./types";

interface ChannelDragState {
  channelId: string;
  /** Explicit source category id, or null when dragged from a residual built-in. */
  fromCategoryId: string | null;
}

export function CommsSidebarCategories({
  channels,
  renderChannel,
}: {
  channels: CommsChannel[];
  renderChannel: (ch: CommsChannel) => ReactNode;
}) {
  const {
    sidebarCategories,
    createSidebarCategory,
    updateSidebarCategory,
    deleteSidebarCategory,
    reorderSidebarCategories,
    moveChannelToCategory,
    reorderCategoryItems,
  } = useCommsContext();

  const channelById = useMemo(() => {
    const map = new Map<string, CommsChannel>();
    for (const ch of channels) map.set(ch.id, ch);
    return map;
  }, [channels]);

  // Channels explicitly placed in favorites or a custom category.
  const explicitIds = useMemo(() => {
    const set = new Set<string>();
    for (const cat of sidebarCategories) {
      if (cat.type === "favorites" || cat.type === "custom") {
        for (const id of cat.channelIds) set.add(id);
      }
    }
    return set;
  }, [sidebarCategories]);

  const membersOf = (cat: CommsSidebarCategoryResponse): CommsChannel[] => {
    if (cat.type === "favorites" || cat.type === "custom") {
      return cat.channelIds
        .map((id) => channelById.get(id))
        .filter((ch): ch is CommsChannel => !!ch);
    }
    if (cat.type === "channels") {
      return channels
        .filter((ch) => ch.type === "channel" && !explicitIds.has(ch.id))
        .sort(byChannelRecency);
    }
    // dms
    return channels
      .filter(
        (ch) => (ch.type === "dm" || ch.type === "group_dm") && !explicitIds.has(ch.id),
      )
      .sort(byChannelRecency);
  };

  // ── drag state (refs mirror BookmarksBar's native-DnD pattern) ────────────
  const dragChannelRef = useRef<ChannelDragState | null>(null);
  const dragCategoryIdRef = useRef<string | null>(null);
  const [dragOverCategoryId, setDragOverCategoryId] = useState<string | null>(null);
  const [dragOverChannelKey, setDragOverChannelKey] = useState<string | null>(null);

  const clearDrag = () => {
    dragChannelRef.current = null;
    dragCategoryIdRef.current = null;
    setDragOverCategoryId(null);
    setDragOverChannelKey(null);
  };

  const handleDropOnCategory = (cat: CommsSidebarCategoryResponse) => {
    const drag = dragChannelRef.current;
    if (drag) {
      const isExplicitTarget = cat.type === "favorites" || cat.type === "custom";
      const toCategoryId = isExplicitTarget ? cat.id : null;
      if (drag.fromCategoryId !== toCategoryId) {
        void moveChannelToCategory(drag.channelId, drag.fromCategoryId, toCategoryId); // fire-and-forget: optimistic update, errors handled inside context
      }
      clearDrag();
      return;
    }
    const dragCatId = dragCategoryIdRef.current;
    if (dragCatId && dragCatId !== cat.id) {
      const ids = sidebarCategories.map((c) => c.id);
      const from = ids.indexOf(dragCatId);
      const to = ids.indexOf(cat.id);
      if (from !== -1 && to !== -1) {
        ids.splice(from, 1);
        ids.splice(to, 0, dragCatId);
        void reorderSidebarCategories(ids); // fire-and-forget: optimistic update, errors handled inside context
      }
    }
    clearDrag();
  };

  const handleDropOnChannel = (
    cat: CommsSidebarCategoryResponse,
    targetChannelId: string,
  ) => {
    const drag = dragChannelRef.current;
    if (!drag) {
      // A category header was dropped onto a channel row — treat as a
      // drop on that channel's category.
      handleDropOnCategory(cat);
      return;
    }
    const isExplicit = cat.type === "favorites" || cat.type === "custom";
    if (isExplicit && drag.fromCategoryId === cat.id) {
      // Reorder within the same explicit category.
      if (drag.channelId !== targetChannelId) {
        const ids = [...cat.channelIds];
        const from = ids.indexOf(drag.channelId);
        const to = ids.indexOf(targetChannelId);
        if (from !== -1 && to !== -1) {
          ids.splice(from, 1);
          ids.splice(to, 0, drag.channelId);
          void reorderCategoryItems(cat.id, ids); // fire-and-forget: optimistic update, errors handled inside context
        }
      }
      clearDrag();
      return;
    }
    // Cross-category drop — same as dropping on the category itself.
    handleDropOnCategory(cat);
  };

  // ── create / rename dialogs ───────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [renameTarget, setRenameTarget] = useState<CommsSidebarCategoryResponse | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    try {
      await createSidebarCategory(name);
      setNewName("");
      setCreateOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) return;
    setSaving(true);
    try {
      await updateSidebarCategory(renameTarget.id, { name });
      setRenameTarget(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="rail-sidebar-categories">
      {sidebarCategories.map((cat) => {
        const members = membersOf(cat);
        const isExplicit = cat.type === "favorites" || cat.type === "custom";
        // Hide an empty Favorites section (matches previous behavior) but
        // always show custom categories so they remain visible drop targets.
        if (cat.type === "favorites" && members.length === 0) return null;
        if (cat.type !== "custom" && cat.type !== "favorites" && members.length === 0) {
          return null;
        }
        return (
          <div
            key={cat.id}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverCategoryId(cat.id);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDragOverCategoryId((prev) => (prev === cat.id ? null : prev));
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleDropOnCategory(cat);
            }}
            className={cn(
              "rounded-md transition-colors",
              dragOverCategoryId === cat.id && "bg-muted/40 ring-1 ring-border",
            )}
            data-testid={`rail-category-${cat.id}`}
          >
            {/* Header */}
            <div
              className="group/cat flex items-center gap-1 px-2 pt-2 pb-0.5"
              draggable
              onDragStart={(e) => {
                dragCategoryIdRef.current = cat.id;
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={clearDrag}
              data-testid={`rail-category-header-${cat.id}`}
            >
              <GripVertical className="h-3 w-3 text-muted-foreground/40 opacity-0 group-hover/cat:opacity-100 cursor-grab flex-shrink-0" />
              <button
                onClick={() => updateSidebarCategory(cat.id, { collapsed: !cat.collapsed })}
                className="flex-1 flex items-center gap-1 text-left min-w-0"
                data-testid={`rail-category-toggle-${cat.id}`}
              >
                <span className="text-caption font-semibold text-muted-foreground uppercase tracking-wider truncate">
                  {cat.name}
                </span>
                <ChevronRight
                  className={cn(
                    "h-3 w-3 text-muted-foreground transition-transform flex-shrink-0",
                    !cat.collapsed && "rotate-90",
                  )}
                />
              </button>
              {cat.type === "custom" && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground opacity-0 group-hover/cat:opacity-100 hover:text-foreground hover:bg-muted"
                      data-testid={`rail-category-menu-${cat.id}`}
                      aria-label={`Options for ${cat.name}`}
                    >
                      <MoreHorizontal className="h-3 w-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-36">
                    <DropdownMenuItem
                      onClick={() => {
                        setRenameValue(cat.name);
                        setRenameTarget(cat);
                      }}
                      data-testid={`rail-category-rename-${cat.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => deleteSidebarCategory(cat.id)}
                      data-testid={`rail-category-delete-${cat.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>

            {/* Items */}
            {!cat.collapsed && (
              <>
                {members.length === 0 && cat.type === "custom" && (
                  <p
                    className="text-caption text-muted-foreground px-3 pb-1 italic"
                    data-testid={`rail-category-empty-${cat.id}`}
                  >
                    Drag conversations here
                  </p>
                )}
                {(() => {
                  if (cat.type !== "channels") {
                    return members.map((ch) => {
                      const rowKey = `${cat.id}:${ch.id}`;
                      return (
                        <div
                          key={rowKey}
                          draggable
                          onDragStart={(e) => {
                            dragChannelRef.current = {
                              channelId: ch.id,
                              fromCategoryId: isExplicit ? cat.id : null,
                            };
                            e.dataTransfer.effectAllowed = "move";
                            e.stopPropagation();
                          }}
                          onDragEnd={clearDrag}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDragOverCategoryId(cat.id);
                            setDragOverChannelKey(rowKey);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleDropOnChannel(cat, ch.id);
                          }}
                          className={cn(
                            "cursor-grab active:cursor-grabbing",
                            dragOverChannelKey === rowKey &&
                              dragChannelRef.current &&
                              "border-t-2 border-primary",
                          )}
                          data-testid={`rail-category-item-${cat.id}-${ch.id}`}
                        >
                          {renderChannel(ch)}
                        </div>
                      );
                    });
                  }
                  // ── "channels" category: split regular vs client channels ──
                  const nonClientMembers = members.filter((ch) => !ch.clientId);
                  const clientMembers = members.filter((ch) => !!ch.clientId);

                  // Aggregate badge: sum unread/mention counts across all client channels
                  const clientBadgeCount = clientMembers.reduce((sum, ch) => {
                    const hasMention = (ch.mentionCount ?? 0) > 0;
                    return sum + (hasMention ? (ch.mentionCount ?? 0) : (ch.unreadCount ?? 0));
                  }, 0);

                  // clientSubgroupCollapsed=true means the sub-group is closed;
                  // false means open. Derive a local alias for readability.
                  const clientsSubOpen = !cat.clientSubgroupCollapsed;

                  // When collapsed, only show client channels that have badges
                  const visibleClientMembers = clientsSubOpen
                    ? clientMembers
                    : clientMembers.filter(
                        (ch) => (ch.unreadCount ?? 0) > 0 || (ch.mentionCount ?? 0) > 0,
                      );

                  return (
                    <>
                      {nonClientMembers.map((ch) => {
                        const rowKey = `${cat.id}:${ch.id}`;
                        return (
                          <div
                            key={rowKey}
                            draggable
                            onDragStart={(e) => {
                              dragChannelRef.current = {
                                channelId: ch.id,
                                fromCategoryId: isExplicit ? cat.id : null,
                              };
                              e.dataTransfer.effectAllowed = "move";
                              e.stopPropagation();
                            }}
                            onDragEnd={clearDrag}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setDragOverCategoryId(cat.id);
                              setDragOverChannelKey(rowKey);
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleDropOnChannel(cat, ch.id);
                            }}
                            className={cn(
                              "cursor-grab active:cursor-grabbing",
                              dragOverChannelKey === rowKey &&
                                dragChannelRef.current &&
                                "border-t-2 border-primary",
                            )}
                            data-testid={`rail-category-item-${cat.id}-${ch.id}`}
                          >
                            {renderChannel(ch)}
                          </div>
                        );
                      })}

                      {clientMembers.length > 0 && (
                        <div data-testid="rail-clients-sub-group">
                          {/* Clients sub-group header */}
                          <button
                            onClick={() => updateSidebarCategory(cat.id, { clientSubgroupCollapsed: !cat.clientSubgroupCollapsed })}
                            className="w-full flex items-center gap-1 px-2 pt-1.5 pb-0.5"
                            data-testid="rail-clients-subgroup-toggle"
                          >
                            <Building2 className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                            <span className="text-caption font-semibold text-muted-foreground uppercase tracking-wider flex-1 text-left ml-0.5">
                              Clients
                            </span>
                            {!clientsSubOpen && clientBadgeCount > 0 && (
                              <Badge
                                variant="secondary"
                                className="text-caption h-4 min-w-4 px-1 flex-shrink-0 bg-red-500 text-white"
                                data-testid="rail-clients-subgroup-badge"
                              >
                                {clientBadgeCount > 99 ? "99+" : clientBadgeCount}
                              </Badge>
                            )}
                            <ChevronRight
                              className={cn(
                                "h-3 w-3 text-muted-foreground transition-transform flex-shrink-0",
                                clientsSubOpen && "rotate-90",
                              )}
                            />
                          </button>

                          {/* Visible client channels (all when open; badged-only when collapsed) */}
                          {visibleClientMembers.map((ch) => {
                            const rowKey = `${cat.id}:${ch.id}`;
                            return (
                              <div
                                key={rowKey}
                                draggable
                                onDragStart={(e) => {
                                  dragChannelRef.current = {
                                    channelId: ch.id,
                                    fromCategoryId: isExplicit ? cat.id : null,
                                  };
                                  e.dataTransfer.effectAllowed = "move";
                                  e.stopPropagation();
                                }}
                                onDragEnd={clearDrag}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setDragOverCategoryId(cat.id);
                                  setDragOverChannelKey(rowKey);
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleDropOnChannel(cat, ch.id);
                                }}
                                className={cn(
                                  "cursor-grab active:cursor-grabbing pl-3",
                                  dragOverChannelKey === rowKey &&
                                    dragChannelRef.current &&
                                    "border-t-2 border-primary",
                                )}
                                data-testid={`rail-category-item-${cat.id}-${ch.id}`}
                              >
                                {renderChannel(ch)}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  );
                })()}
              </>
            )}
          </div>
        );
      })}

      {/* New category */}
      <button
        onClick={() => setCreateOpen(true)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 mt-1 rounded-md text-left text-caption text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        data-testid="rail-new-category-button"
      >
        <Plus className="h-3 w-3 flex-shrink-0" />
        New category
      </button>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => { if (!o) { setCreateOpen(false); setNewName(""); } }}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">New category</DialogTitle>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleCreate().catch((err) => console.error("[CommsSidebarCategories] create failed:", err)); }}
            placeholder="e.g. Projects"
            maxLength={80}
            autoFocus
            data-testid="rail-new-category-name-input"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setCreateOpen(false); setNewName(""); }}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={saving || !newName.trim()}
              data-testid="rail-new-category-submit"
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(o) => { if (!o) setRenameTarget(null); }}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Rename category</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleRename().catch((err) => console.error("[CommsSidebarCategories] rename failed:", err)); }}
            maxLength={80}
            autoFocus
            data-testid="rail-rename-category-input"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleRename}
              disabled={saving || !renameValue.trim()}
              data-testid="rail-rename-category-submit"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
