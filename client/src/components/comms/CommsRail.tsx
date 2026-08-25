/**
 * CommsRail — persistent right-edge chat rail.
 *
 * Collapsed: slim strip of avatars/icons with unread dots, presence dots,
 *            and a total-unread badge.
 * Expanded: full conversation list with search, new-DM and browse-channels.
 * Small screens (< md): floating button bottom-right.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupChannels } from "./channelGrouping";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Archive,
  Bell,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Hash,
  Loader2,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Star,
  StarOff,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FAB_COLLIDER_ATTR, FAB_COLLIDERS_CHANGED_EVENT } from "@/lib/fabCollider";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { useCommsSelector } from "@/contexts/CommsContext";
import { CommsSidebarCategories } from "./CommsSidebarCategories";
import { Avatar, channelDisplayName, stripFormatting } from "./helpers";
import { UserStatusPicker, StatusDot } from "./UserStatusPicker";
import { NotificationSettingsPanel } from "./NotificationSettingsPanel";
import type { CommsChannel } from "./types";

// ─── Small-screen floating button ────────────────────────────────────────────

// Home-corner geometry (Tailwind right-4 / bottom-4, h-12 w-12) plus the
// clearance kept between the button and any collider (Task #4374).
const FAB_EDGE_OFFSET_PX = 16;
const FAB_SIZE_PX = 48;
const FAB_GAP_PX = 8;
// Only controls pinned within this strip above the viewport bottom can push
// the button up, and it never lifts further than this — both bounds keep it
// thumb-reachable near its corner instead of chasing arbitrary content.
const FAB_MAX_LIFT_PX = 240;

// How far the button must rise from its home corner so it clears every
// visible `[data-fab-collider]` element that intersects its corner lane
// (composer bars, upload panels, other pages' floating pills).
function computeFabLift(): number {
  if (window.innerWidth >= 768) return 0; // button is md:hidden
  const vh = window.innerHeight;
  const laneLeft = window.innerWidth - FAB_EDGE_OFFSET_PX - FAB_SIZE_PX - FAB_GAP_PX;
  let lift = 0;
  document.querySelectorAll<HTMLElement>(`[${FAB_COLLIDER_ATTR}]`).forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return; // hidden or detached
    if (r.right < laneLeft) return; // clear of the corner lane
    if (r.top > vh || r.bottom < vh - FAB_MAX_LIFT_PX) return; // not bottom-pinned
    lift = Math.max(lift, vh - r.top + FAB_GAP_PX - FAB_EDGE_OFFSET_PX);
  });
  return Math.max(0, Math.min(lift, FAB_MAX_LIFT_PX));
}

function FloatingCommsButton({ totalUnread, onClick }: { totalUnread: number; onClick: () => void }) {
  const [lift, setLift] = useState(0);

  // Collision-aware placement: re-measure when colliders mount/unmount
  // (fabColliderRef fires the window event), when any collider resizes
  // (composer grows, banner appears), and on viewport resize. A collider can
  // also MOVE without resizing (e.g. a composer settles to the card bottom
  // once messages load) — ResizeObserver never fires for position-only
  // changes, so while any collider is mounted a 1s keepalive re-checks the
  // rects; it stops the moment the last collider unmounts, so surfaces
  // without pinned controls (the vast majority) pay nothing.
  useEffect(() => {
    let raf = 0;
    let ro: ResizeObserver | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;
    const recompute = () => {
      raf = 0;
      setLift(computeFabLift());
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(recompute);
    };
    // Rescan re-observes the current collider set (RO fires an initial
    // notification per observe(), which lands on `schedule` — recompute
    // alone, no re-observe, so it cannot loop).
    let rescanRaf = 0;
    const rescan = () => {
      rescanRaf = 0;
      ro?.disconnect();
      const colliders = document.querySelectorAll<HTMLElement>(`[${FAB_COLLIDER_ATTR}]`);
      colliders.forEach((el) => ro?.observe(el));
      if (colliders.length > 0 && !keepalive) {
        keepalive = setInterval(schedule, 1000);
      } else if (colliders.length === 0 && keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      schedule();
    };
    const scheduleRescan = () => {
      if (!rescanRaf) rescanRaf = requestAnimationFrame(rescan);
    };
    ro = new ResizeObserver(schedule);
    rescan();
    window.addEventListener(FAB_COLLIDERS_CHANGED_EVENT, scheduleRescan);
    // Intentional JS resize listener (audit P2-9): the FAB lift is computed
    // from live collider rects vs the viewport (computeFabLift), so a
    // resize must trigger a re-measure — genuinely stateful, not a CSS
    // breakpoint concern.
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(rescanRaf);
      if (keepalive) clearInterval(keepalive);
      ro?.disconnect();
      window.removeEventListener(FAB_COLLIDERS_CHANGED_EVENT, scheduleRescan);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return (
    <button
      onClick={onClick}
      data-testid="comms-floating-button"
      style={{ bottom: FAB_EDGE_OFFSET_PX + lift }}
      className="fixed right-4 z-50 h-12 w-12 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:bg-primary/90 transition-[bottom,background-color] duration-200 motion-reduce:transition-none md:hidden"
      aria-label="Open chat"
    >
      <MessageSquare className="h-5 w-5" />
      {totalUnread > 0 && (
        <span className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center rounded-full bg-red-500 text-white text-caption font-bold">
          {totalUnread > 9 ? "9+" : totalUnread}
        </span>
      )}
    </button>
  );
}

// ─── Channel icon ─────────────────────────────────────────────────────────────

function RailChannelIcon({ ch }: { ch: CommsChannel }) {
  if (ch.type === "dm" || ch.type === "group_dm") {
    return <MessageSquare className="h-4 w-4" />;
  }
  if (ch.visibility === "private") {
    return <Lock className="h-4 w-4" />;
  }
  return <Hash className="h-4 w-4" />;
}

// ─── Incoming-message preview (Slack-style transient bubble) ─────────────────

const PREVIEW_MAX_CHARS = 80;
const PREVIEW_TIMEOUT_MS = 4000;

export interface RailMessagePreview {
  sender: string;
  content: string;
}

// ─── Expanded panel row ───────────────────────────────────────────────────────

// Memoized so busy activity elsewhere doesn't re-render every row: the
// provider preserves channel object identity across refetches (Task #3848),
// and the callbacks below are stable, so a message in channel A re-renders
// only channel A's row.
const ExpandedChannelRow = memo(function ExpandedChannelRow({
  ch,
  pinned,
  hasDraft,
  onOpen,
  onTogglePin,
}: {
  ch: CommsChannel;
  pinned: boolean;
  hasDraft?: boolean;
  onOpen: (channelId: string) => void;
  onTogglePin: (channelId: string) => void;
}) {
  const { user } = useAuth();
  const currentUserId = (user as any)?.id ?? "";
  const name = channelDisplayName(ch);

  const otherMemberId =
    (ch.type === "dm" || ch.type === "group_dm") && ch.members && currentUserId
      ? ch.members.find((m) => m.userId !== currentUserId)?.userId ?? null
      : null;
  // Narrow subscription: only this DM's counterpart status entry — status
  // churn for other users leaves this row idle.
  const otherEntry = useCommsSelector((s) =>
    otherMemberId ? s.userStatuses.get(otherMemberId) ?? null : null,
  );
  const customStatusLine = otherEntry?.customText
    ? `${otherEntry.customEmoji ?? ""} ${otherEntry.customText}`.trim()
    : null;

  return (
    <div
      className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors"
      data-testid={`rail-expanded-channel-${ch.id}`}
    >
      <button
        onClick={() => onOpen(ch.id)}
        className="flex-1 flex items-center gap-2 text-sm text-left min-w-0"
      >
        <RailChannelIcon ch={ch} />
        <div className="flex-1 min-w-0">
          <span className={cn("truncate block", (() => {
            const pref = ch.notifPref ?? "all";
            if (pref === "muted") return false;
            if (pref === "mentions") return (ch.mentionCount ?? 0) > 0;
            return (ch.unreadCount ?? 0) > 0;
          })() && "font-semibold")}>{name}</span>
          {customStatusLine && (
            <span className="text-caption text-muted-foreground truncate block" data-testid={`rail-dm-custom-status-${ch.id}`}>
              {customStatusLine}
            </span>
          )}
        </div>
        {hasDraft && !ch.unreadCount && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Pencil
                className="h-3 w-3 text-muted-foreground flex-shrink-0"
                data-testid={`rail-draft-indicator-${ch.id}`}
              />
            </TooltipTrigger>
            <TooltipContent>Draft saved</TooltipContent>
          </Tooltip>
        )}
        {(() => {
          const pref = ch.notifPref ?? "all";
          const muted = pref === "muted";
          const hasMention = (ch.mentionCount ?? 0) > 0;
          const hasUnread = (ch.unreadCount ?? 0) > 0;
          const showBadge = !muted && (pref === "mentions" ? hasMention : hasUnread);
          // Mentions and DM/group-DM channels: show numeric count. Plain unreads: bold text only, no badge.
          const isMentionOrDm = hasMention || ch.type === "dm" || ch.type === "group_dm";
          if (!showBadge || !isMentionOrDm) return null;
          const count = hasMention ? (ch.mentionCount ?? ch.unreadCount ?? 0) : (ch.unreadCount ?? 0);
          return (
            <Badge
              variant="secondary"
              className="text-caption h-4 min-w-4 px-1 flex-shrink-0 bg-red-500 text-white"
              data-testid={`rail-expanded-unread-${ch.id}`}
            >
              {`@${count > 9 ? "9+" : count}`}
            </Badge>
          );
        })()}
      </button>
      <button
        onClick={() => onTogglePin(ch.id)}
        className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground"
        data-testid={`rail-pin-${ch.id}`}
        title={pinned ? "Remove from Favorites" : "Add to Favorites"}
        aria-label={pinned ? "Remove from Favorites" : "Add to Favorites"}
      >
        {pinned ? <StarOff className="h-3.5 w-3.5" /> : <Star className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
});

// ─── New-chat composer (popover on the + button) ─────────────────────────────

interface RailTeamMember {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  profileImageUrl: string | null;
}

function railMemberName(u: RailTeamMember): string {
  if (u.firstName || u.lastName) {
    return [u.firstName, u.lastName].filter(Boolean).join(" ");
  }
  return u.email ?? u.id.slice(0, 8);
}

// ─── Inline channel creation dialog (used from rail popover) ────────────────

function RailCreateChannelDialog({
  open,
  onClose,
  onCreated,
  refetchChannels,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (channelId: string) => void;
  refetchChannels: () => void;
}) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = async () => {
    if (!name.trim()) { setError("Channel name is required"); return; }
    setLoading(true);
    setError("");
    try {
      const ch = await apiRequest("POST", "/api/comms/channels", {
        name: name.trim(),
        visibility,
        topic: topic.trim() || undefined,
      }).then((r) => r.json());
      if (!ch || typeof ch.id !== "string" || !ch.id) {
        throw new Error("The server did not return the new channel. Please try again.");
      }
      refetchChannels();
      try {
        onCreated(ch.id);
        setName(""); setTopic(""); setVisibility("public");
      } catch {
        setError(
          "The channel was created, but its chat window could not be opened. You can open it from the sidebar.",
        );
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to create channel");
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setName(""); setTopic(""); setError(""); setVisibility("public");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new channel</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. marketing"
              className="mt-1"
              data-testid="rail-new-channel-name-input"
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm font-medium">Topic (optional)</label>
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What is this channel about?"
              className="mt-1"
              data-testid="rail-new-channel-topic-input"
            />
          </div>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={visibility === "public"}
                onChange={() => setVisibility("public")}
                className="accent-primary"
              />
              <div>
                <div className="text-sm font-medium">Public</div>
                <div className="text-xs text-muted-foreground">Anyone can join</div>
              </div>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={visibility === "private"}
                onChange={() => setVisibility("private")}
                className="accent-primary"
              />
              <div>
                <div className="text-sm font-medium">Private</div>
                <div className="text-xs text-muted-foreground">Invite only</div>
              </div>
            </label>
          </div>
          {error && (
            <p className="text-sm text-destructive" data-testid="rail-create-channel-error">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-2">
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          <Button
            onClick={handleCreate}
            disabled={loading || !name.trim()}
            data-testid="rail-create-channel-submit"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create channel"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function NewChatPopover({
  channels,
  onOpenChannel,
  refetchChannels,
}: {
  channels: CommsChannel[];
  onOpenChannel: (channelId: string) => void;
  refetchChannels: () => void;
}) {
  const { user } = useAuth();
  // Narrow subscription: presence dots in the teammate list. Keeps this
  // subscription out of the parent rail so presence churn doesn't re-render it.
  const onlineUserIds = useCommsSelector((s) => s.onlineUserIds);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [creatingUserId, setCreatingUserId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showCreateChannel, setShowCreateChannel] = useState(false);

  const { data: users = [], isLoading: usersLoading, isError: usersError } = useQuery<RailTeamMember[]>({
    queryKey: ["/api/comms/users"],
    queryFn: () => apiRequest("GET", "/api/comms/users").then((r) => r.json()),
    enabled: open,
  });

  const q = search.trim().toLowerCase();

  const filteredUsers = users.filter(
    (u) =>
      u.id !== user?.id &&
      (q === "" ||
        `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q)),
  );

  // Existing group channels (and group DMs) matching the search
  const matchingChannels = channels
    .filter((ch) => ch.type !== "dm")
    .filter((ch) => q === "" || channelDisplayName(ch).toLowerCase().includes(q));

  const reset = () => {
    setSearch("");
    setError("");
    setCreatingUserId(null);
  };

  const handlePickUser = async (userId: string) => {
    if (creatingUserId) return;
    setCreatingUserId(userId);
    setError("");
    try {
      const ch: CommsChannel = await apiRequest("POST", "/api/comms/dms", {
        userIds: [userId],
      }).then((r) => r.json());
      if (!ch || typeof ch.id !== "string" || !ch.id) {
        throw new Error("The server did not return the conversation. Please try again.");
      }
      refetchChannels();
      try {
        onOpenChannel(ch.id);
      } catch {
        setError(
          "The conversation was created, but its chat window could not be opened. You can open it from the sidebar.",
        );
        return;
      }
      setOpen(false);
      reset();
    } catch (e: any) {
      setError(e?.message ?? "Failed to open conversation");
    } finally {
      setCreatingUserId(null);
    }
  };

  const handlePickChannel = (channelId: string) => {
    try {
      onOpenChannel(channelId);
    } catch {
      setError("This chat window could not be opened. Please try again.");
      return;
    }
    setOpen(false);
    reset();
  };

  const handleNewChannel = () => {
    setOpen(false);
    reset();
    setShowCreateChannel(true);
  };

  return (
    <>
      <RailCreateChannelDialog
        open={showCreateChannel}
        onClose={() => setShowCreateChannel(false)}
        onCreated={(channelId) => {
          // Open the popup first — if it throws, the dialog stays open and
          // shows an inline error instead of crashing the sidebar.
          onOpenChannel(channelId);
          setShowCreateChannel(false);
        }}
        refetchChannels={refetchChannels}
      />
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                data-testid="rail-new-chat"
                aria-label="New DM or channel"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>New DM or channel</TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="end"
          className="w-72 p-2"
          data-testid="rail-new-chat-popover"
        >
          <Input
            placeholder="Search teammates or channels…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs mb-2"
            autoFocus
            data-testid="rail-new-chat-search"
          />
          <ScrollArea className="max-h-64">
            <div className="space-y-0.5 pr-1">
              {usersError && (
                <p className="text-xs text-destructive text-center py-4">
                  Couldn't load teammates. Close and try again.
                </p>
              )}
              {!usersError && filteredUsers.length === 0 && matchingChannels.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">
                  {usersLoading ? "Loading teammates…" : "No results"}
                </p>
              )}
              {filteredUsers.length > 0 && (
                <p className="text-caption font-semibold text-muted-foreground uppercase tracking-wider px-1 pt-1">
                  Teammates
                </p>
              )}
              {filteredUsers.map((u) => {
                const isOnline = onlineUserIds.includes(u.id);
                const busy = creatingUserId === u.id;
                return (
                  <button
                    key={u.id}
                    onClick={() => handlePickUser(u.id)}
                    disabled={!!creatingUserId}
                    data-testid={`rail-dm-user-${u.id}`}
                    className="w-full flex items-center gap-2 px-1.5 py-1.5 rounded-md text-left hover:bg-muted/50 transition-colors disabled:opacity-60"
                  >
                  <Avatar
                    user={{
                      id: u.id,
                      firstName: u.firstName,
                      lastName: u.lastName,
                      profileImageUrl: u.profileImageUrl,
                    }}
                    online={isOnline}
                    size="xs"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{railMemberName(u)}</div>
                    {u.email && (
                      <div className="text-caption text-muted-foreground truncate">{u.email}</div>
                    )}
                  </div>
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0" />}
                </button>
              );
            })}
              {matchingChannels.length > 0 && (
                <p className="text-caption font-semibold text-muted-foreground uppercase tracking-wider px-1 pt-2">
                  Channels
                </p>
              )}
              {matchingChannels.map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => handlePickChannel(ch.id)}
                  data-testid={`rail-new-chat-channel-${ch.id}`}
                  className="w-full flex items-center gap-2 px-1.5 py-1.5 rounded-md text-left hover:bg-muted/50 transition-colors"
                >
                  <RailChannelIcon ch={ch} />
                  <span className="flex-1 text-xs truncate">{channelDisplayName(ch)}</span>
                </button>
              ))}
            </div>
          </ScrollArea>
          {error && (
            <p className="text-xs text-destructive mt-1" data-testid="rail-new-chat-error">
              {error}
            </p>
          )}
          <div className="mt-1 pt-1 border-t border-border">
            <button
              onClick={handleNewChannel}
              data-testid="rail-new-channel-button"
              className="w-full flex items-center gap-2 px-1.5 py-1.5 rounded-md text-left hover:bg-muted/50 transition-colors text-xs text-muted-foreground hover:text-foreground"
            >
              <Hash className="h-3.5 w-3.5 flex-shrink-0" />
              <span>New channel…</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}


// ─── Main CommsRail ───────────────────────────────────────────────────────────

export function CommsRail() {
  // Narrow per-field subscriptions instead of the whole-snapshot context
  // hook: each selector re-renders the rail only when ITS slice
  // changes (Object.is). Presence churn no longer touches the rail at all
  // (onlineUserIds is subscribed inside NewChatPopover), and per-channel rows
  // are memoized so a message in one channel re-renders only that row.
  const channels = useCommsSelector((s) => s.channels);
  const totalUnread = useCommsSelector((s) => s.totalUnread);
  const totalMentions = useCommsSelector((s) => s.totalMentions);
  const totalThreadUnread = useCommsSelector((s) => s.totalThreadUnread);
  const totalThreadMentions = useCommsSelector((s) => s.totalThreadMentions);
  const railOpen = useCommsSelector((s) => s.railOpen);
  const toggleRail = useCommsSelector((s) => s.toggleRail);
  const pinnedChannelIds = useCommsSelector((s) => s.pinnedChannelIds);
  const togglePin = useCommsSelector((s) => s.togglePin);
  const sidebarCategories = useCommsSelector((s) => s.sidebarCategories);
  const openPopup = useCommsSelector((s) => s.openPopup);
  const registerArchivedChannel = useCommsSelector((s) => s.registerArchivedChannel);
  const refetchChannels = useCommsSelector((s) => s.refetchChannels);
  const addSseListener = useCommsSelector((s) => s.addSseListener);
  const myStatus = useCommsSelector((s) => s.myStatus);
  const draftsByChannelId = useCommsSelector((s) => s.draftsByChannelId);
  const notificationSettings = useCommsSelector((s) => s.notificationSettings);
  const updateNotificationSettings = useCommsSelector((s) => s.updateNotificationSettings);
  const [notifSettingsOpen, setNotifSettingsOpen] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);

  const handleSaveNotifSettings = async (patch: Parameters<typeof updateNotificationSettings>[0]) => {
    setNotifSaving(true);
    try { await updateNotificationSettings(patch); } finally { setNotifSaving(false); }
  };
  const [location, navigate] = useLocation();
  const { user } = useAuth();
  const currentUserId = (user as any)?.id ?? "";
  const [search, setSearch] = useState("");

  // ── Transient per-channel message previews (Slack-style) ─────────────────
  const [previews, setPreviews] = useState<Record<string, RailMessagePreview>>({});
  const previewTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const clearPreview = useCallback((channelId: string) => {
    const timer = previewTimersRef.current[channelId];
    if (timer) {
      clearTimeout(timer);
      delete previewTimersRef.current[channelId];
    }
    setPreviews((prev) => {
      if (!(channelId in prev)) return prev;
      const { [channelId]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  useEffect(() => {
    const unsubscribe = addSseListener((e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type !== "comms:message") return;
        const msg = data.message;
        if (!msg || typeof msg.content !== "string") return;
        // Don't preview our own messages
        if (msg.userId && msg.userId === currentUserId) return;
        const channelId: string = data.channelId;
        if (!channelId) return;

        const senderUser = msg.user;
        const sender =
          senderUser && (senderUser.firstName || senderUser.lastName)
            ? [senderUser.firstName, senderUser.lastName].filter(Boolean).join(" ")
            : "Someone";
        const raw = stripFormatting(msg.content).trim();
        const content =
          raw.length > PREVIEW_MAX_CHARS ? `${raw.slice(0, PREVIEW_MAX_CHARS - 1)}…` : raw;

        setPreviews((prev) => ({ ...prev, [channelId]: { sender, content } }));
        const existing = previewTimersRef.current[channelId];
        if (existing) clearTimeout(existing);
        previewTimersRef.current[channelId] = setTimeout(() => {
          delete previewTimersRef.current[channelId];
          setPreviews((prev) => {
            const { [channelId]: _removed, ...rest } = prev;
            return rest;
          });
        }, PREVIEW_TIMEOUT_MS);
      } catch {
        /* ignore malformed events */
      }
    });
    return () => {
      unsubscribe();
      for (const timer of Object.values(previewTimersRef.current)) clearTimeout(timer);
      previewTimersRef.current = {};
    };
  }, [addSseListener, currentUserId]);

  // Archived channels query
  const { data: archivedChannels = [] } = useQuery<CommsChannel[]>({
    queryKey: ["/api/comms/channels/archived"],
    queryFn: () => apiRequest("GET", "/api/comms/channels/archived").then((r) => r.json()),
    staleTime: 30_000,
  });

  // Archived group open state
  const [archivedGroupOpen, setArchivedGroupOpen] = useState(false);

  // Clients group open state — persisted to localStorage
  const [clientsGroupOpen, setClientsGroupOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("comms_rail_clients_group_open");
      return stored === null ? false : stored === "true";
    } catch { return false; }
  });
  const handleMarkAllRead = async () => {
    try {
      await fetch("/api/comms/read-all", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      refetchChannels();
    } catch { /* best-effort */ }
  };

  const toggleClientsGroup = () => {
    setClientsGroupOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem("comms_rail_clients_group_open", String(next)); } catch {}
      return next;
    });
  };

  // Grouped sections
  const { pinnedChannels, recentChannels, clientChannels } = useMemo(
    () => groupChannels(channels, pinnedChannelIds),
    [channels, pinnedChannelIds],
  );

  // All channels in priority order for search
  const allSorted = useMemo(() => [
    ...pinnedChannels,
    ...recentChannels,
    ...clientChannels,
  ], [pinnedChannels, recentChannels, clientChannels]);

  const filtered = search
    ? allSorted.filter((ch) =>
        channelDisplayName(ch).toLowerCase().includes(search.toLowerCase()),
      )
    : null; // null = show grouped view

  // Stable so memoized ExpandedChannelRow props don't change between renders.
  const handleOpenChannel = useCallback(
    (channelId: string) => {
      clearPreview(channelId);
      openPopup(channelId);
    },
    [clearPreview, openPopup],
  );

  const handleOpenFull = () => {
    navigate("/comms");
  };

  // First pending preview (shown as a floating bubble when rail is closed)
  const closedPreviewEntry = !railOpen ? (Object.entries(previews)[0] ?? null) : null;

  // Suppress the global rail entirely when the user is on the full /comms page
  // (that page has its own sidebar, so showing both would duplicate the list).
  if (location.startsWith("/comms")) return null;

  return (
    <>
      {/* Small-screen floating button */}
      <FloatingCommsButton totalUnread={totalUnread} onClick={toggleRail} />

      {/* Desktop edge tab — shown only when rail is closed, replaces the old 48px strip */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={toggleRail}
            data-testid="rail-expand-button"
            aria-label="Open chat"
            className={cn(
              "hidden md:flex fixed top-1/2 -translate-y-1/2 right-0 z-30 h-16 w-5 flex-col items-center justify-center rounded-l-md bg-background border border-r-0 border-border shadow-md hover:bg-muted transition-all duration-200",
              railOpen ? "opacity-0 pointer-events-none" : "opacity-100",
            )}
          >
            <ChevronLeft className="h-3 w-3 text-muted-foreground" />
            {!railOpen && totalUnread > 0 && (
              <span
                className={cn(
                  "absolute -top-2 -left-2 h-4 min-w-4 px-0.5 flex items-center justify-center rounded-full text-caption font-bold",
                  totalMentions > 0
                    ? "bg-red-500 text-white"
                    : "bg-primary text-primary-foreground",
                )}
                data-testid="rail-total-unread"
              >
                {totalMentions > 0
                  ? (totalMentions > 9 ? "9+" : totalMentions)
                  : (totalUnread > 9 ? "9+" : totalUnread)}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">Open chat</TooltipContent>
      </Tooltip>

      {/* Closed-state message preview bubble — anchored near the edge tab */}
      {closedPreviewEntry && (
        <button
          onClick={() => handleOpenChannel(closedPreviewEntry[0])}
          className="hidden md:block fixed z-40 bottom-20 right-6 w-56 rounded-md border border-border bg-popover px-2.5 py-1.5 text-left shadow-md animate-in fade-in slide-in-from-right-1"
          data-testid={`rail-preview-${closedPreviewEntry[0]}`}
        >
          <p
            className="text-xs font-semibold truncate text-foreground"
            data-testid={`rail-preview-sender-${closedPreviewEntry[0]}`}
          >
            {closedPreviewEntry[1].sender}
          </p>
          <p
            className="text-xs text-muted-foreground break-words"
            data-testid={`rail-preview-content-${closedPreviewEntry[0]}`}
          >
            {closedPreviewEntry[1].content}
          </p>
        </button>
      )}

      {/* Rail panel — hidden on mobile; slides out as w-64 when open, zero-width when closed */}
      <div
        className={cn(
          "hidden md:flex fixed top-14 right-0 bottom-0 z-30 flex-col bg-background border-l border-border shadow-md transition-all duration-200",
          railOpen ? "w-64 opacity-100" : "w-0 opacity-0 overflow-hidden pointer-events-none",
        )}
        data-testid="comms-rail"
        data-rail-open={railOpen}
        aria-hidden={!railOpen}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between px-2 py-2 border-b border-border flex-shrink-0">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider pl-1">
            Chat
          </span>
          {totalUnread > 0 && (
            <Badge
              variant="secondary"
              className={cn(
                "text-caption px-1.5 h-4",
                totalMentions > 0
                  ? "bg-red-500 text-white"
                  : "bg-primary text-primary-foreground",
              )}
              data-testid={railOpen ? "rail-total-unread" : undefined}
            >
              {totalMentions > 0
                ? (totalMentions > 99 ? "@99+" : `@${totalMentions}`)
                : (totalUnread > 99 ? "99+" : totalUnread)}
            </Badge>
          )}
          {totalUnread > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleMarkAllRead}
                  data-testid="rail-mark-all-read"
                  aria-label="Mark all as read"
                  className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">Mark all as read</TooltipContent>
            </Tooltip>
          )}
          <button
            onClick={toggleRail}
            data-testid="rail-collapse-button"
            aria-label="Collapse chat"
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground ml-1"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* Expanded panel content */}
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* Search */}
            <div className="px-2 py-2 flex-shrink-0">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search chats…"
                  className="pl-7 h-7 text-xs"
                  data-testid="rail-search-input"
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Channel list — search results OR grouped sections */}
            <ScrollArea className="flex-1 px-1">
              <div className="py-1 space-y-0.5">
                {filtered !== null ? (
                  /* Search active — flat results */
                  <>
                    {filtered.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-4">No results</p>
                    )}
                    {filtered.map((ch) => (
                      <ExpandedChannelRow
                        key={ch.id}
                        ch={ch}
                        pinned={pinnedChannelIds.includes(ch.id)}
                        hasDraft={draftsByChannelId.has(ch.id)}
                        onOpen={handleOpenChannel}
                        onTogglePin={togglePin}
                      />
                    ))}
                  </>
                ) : (
                  /* Grouped view */
                  <>
                    {channels.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-4">No channels yet</p>
                    )}

                    {sidebarCategories.length > 0 ? (
                      /* Server-side categories with drag-and-drop */
                      <CommsSidebarCategories
                        channels={channels}
                        renderChannel={(ch) => (
                          <ExpandedChannelRow
                            ch={ch}
                            pinned={pinnedChannelIds.includes(ch.id)}
                            hasDraft={draftsByChannelId.has(ch.id)}
                            onOpen={handleOpenChannel}
                            onTogglePin={togglePin}
                          />
                        )}
                      />
                    ) : (
                      /* Fallback while categories are loading */
                      <>
                        {/* Favorites */}
                        {pinnedChannels.length > 0 && (
                          <>
                            <div className="px-2 pt-2 pb-0.5">
                              <span className="text-caption font-semibold text-muted-foreground uppercase tracking-wider">
                                Favorites
                              </span>
                            </div>
                            {pinnedChannels.map((ch) => (
                              <ExpandedChannelRow
                                key={ch.id}
                                ch={ch}
                                pinned
                                hasDraft={draftsByChannelId.has(ch.id)}
                                onOpen={handleOpenChannel}
                                onTogglePin={togglePin}
                              />
                            ))}
                          </>
                        )}

                        {/* Recent (team channels + DMs, sorted by recency) */}
                        {recentChannels.length > 0 && (
                          <>
                            <div className="px-2 pt-2 pb-0.5">
                              <span className="text-caption font-semibold text-muted-foreground uppercase tracking-wider">
                                Recent
                              </span>
                            </div>
                            {recentChannels.map((ch) => (
                              <ExpandedChannelRow
                                key={ch.id}
                                ch={ch}
                                pinned={false}
                                hasDraft={draftsByChannelId.has(ch.id)}
                                onOpen={handleOpenChannel}
                                onTogglePin={togglePin}
                              />
                            ))}
                          </>
                        )}

                        {/* Clients — collapsible */}
                        {clientChannels.length > 0 && (
                          <>
                            <button
                              onClick={toggleClientsGroup}
                              className="w-full flex items-center gap-1 px-2 pt-2 pb-0.5 group"
                              data-testid="rail-clients-group-toggle"
                            >
                              <span className="text-caption font-semibold text-muted-foreground uppercase tracking-wider flex-1 text-left">
                                Clients
                              </span>
                              <ChevronRight
                                className={cn(
                                  "h-3 w-3 text-muted-foreground transition-transform",
                                  clientsGroupOpen && "rotate-90",
                                )}
                              />
                            </button>
                            {clientsGroupOpen &&
                              clientChannels.map((ch) => (
                                <ExpandedChannelRow
                                  key={ch.id}
                                  ch={ch}
                                  pinned={false}
                                  hasDraft={draftsByChannelId.has(ch.id)}
                                  onOpen={handleOpenChannel}
                                  onTogglePin={togglePin}
                                />
                              ))}
                          </>
                        )}
                      </>
                    )}

                    {/* Archived — collapsible, collapsed by default */}
                    {archivedChannels.length > 0 && (
                      <>
                        <button
                          onClick={() => setArchivedGroupOpen((v) => !v)}
                          className="w-full flex items-center gap-1 px-2 pt-2 pb-0.5 group"
                          data-testid="rail-archived-group-toggle"
                        >
                          <Archive className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                          <span className="text-caption font-semibold text-muted-foreground uppercase tracking-wider flex-1 text-left ml-0.5">
                            Archived
                          </span>
                          <ChevronRight
                            className={cn(
                              "h-3 w-3 text-muted-foreground transition-transform",
                              archivedGroupOpen && "rotate-90",
                            )}
                          />
                        </button>
                        {archivedGroupOpen &&
                          archivedChannels.map((ch) => (
                            <button
                              key={ch.id}
                              onClick={() => { registerArchivedChannel(ch); handleOpenChannel(ch.id); }}
                              data-testid={`rail-archived-channel-${ch.id}`}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-muted/50 transition-colors opacity-60"
                            >
                              <Archive className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                              <span className="flex-1 text-xs truncate text-muted-foreground">
                                {channelDisplayName(ch)}
                              </span>
                            </button>
                          ))}
                      </>
                    )}
                  </>
                )}
              </div>
            </ScrollArea>

            {/* Footer actions */}
            <div className="flex-shrink-0 border-t border-border p-2 space-y-1">
              {/* My status row */}
              <UserStatusPicker myStatus={myStatus} align="end">
                <button
                  className="w-full flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-muted text-left transition-colors"
                  data-testid="rail-my-status-trigger"
                >
                  <StatusDot
                    status={myStatus?.effectiveStatus ?? "offline"}
                    className="flex-shrink-0"
                  />
                  <span className="text-xs text-muted-foreground flex-1 truncate">
                    {myStatus?.customText
                      ? `${myStatus.customEmoji ?? ""} ${myStatus.customText}`.trim()
                      : myStatus?.effectiveStatus === "online"
                      ? "Online"
                      : myStatus?.effectiveStatus === "away"
                      ? "Away"
                      : myStatus?.effectiveStatus === "dnd"
                      ? "Do Not Disturb"
                      : "Offline"}
                  </span>
                </button>
              </UserStatusPicker>

              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1 text-xs h-7 justify-start"
                  onClick={handleOpenFull}
                  data-testid="rail-open-full-comms"
                >
                  <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                  Open full view
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 shrink-0"
                      onClick={() => setNotifSettingsOpen(true)}
                      data-testid="rail-notif-settings-btn"
                      aria-label="Notification settings"
                    >
                      <Bell className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    Notification settings
                  </TooltipContent>
                </Tooltip>
                <NewChatPopover
                  channels={channels}
                  onOpenChannel={handleOpenChannel}
                  refetchChannels={refetchChannels}
                />
              </div>

              <Button
                variant="ghost"
                size="sm"
                className="w-full text-xs h-7 justify-start relative"
                onClick={() => navigate("/comms?view=threads")}
                data-testid="rail-open-threads"
              >
                <GitBranch className="h-3.5 w-3.5 mr-1.5" />
                Threads
                {totalThreadUnread > 0 && (
                  <span
                    className={cn(
                      "ml-auto text-caption px-1.5 h-4 flex items-center justify-center rounded-full font-bold",
                      totalThreadMentions > 0
                        ? "bg-red-500 text-white"
                        : "bg-primary text-primary-foreground",
                    )}
                    data-testid="rail-threads-badge"
                  >
                    {totalThreadMentions > 0
                      ? (totalThreadMentions > 99 ? "@99+" : `@${totalThreadMentions}`)
                      : (totalThreadUnread > 99 ? "99+" : totalThreadUnread)}
                  </span>
                )}
              </Button>
            </div>
          </div>
      </div>

      {/* Notification settings dialog — rendered outside rail-open ternary so it mounts regardless */}
      <Dialog open={notifSettingsOpen} onOpenChange={setNotifSettingsOpen}>
        <DialogContent className="max-w-sm" data-testid="notif-settings-dialog">
          <DialogHeader>
            <DialogTitle className="text-sm">Notification settings</DialogTitle>
          </DialogHeader>
          {notificationSettings ? (
            <NotificationSettingsPanel
              settings={notificationSettings}
              onSave={handleSaveNotifSettings}
              saving={notifSaving}
              isDndActive={myStatus?.effectiveStatus === "dnd"}
            />
          ) : (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
