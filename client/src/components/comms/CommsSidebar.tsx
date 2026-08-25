/**
 * NoBull Comms page — sidebar.
 * Extracted verbatim from client/src/pages/Comms.tsx (Task #3787 split).
 * CommsSidebar (exported) and its status footer.
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { useCommsContext } from "@/contexts/CommsContext";
import { channelDisplayName } from "@/components/comms/helpers";
import { UserStatusPicker, StatusDot } from "@/components/comms/UserStatusPicker";
import { useAuth } from "@/hooks/use-auth";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  MessageSquare,
  Phone,
  Plus,
  Search,
  X,
  Smile,
  ChevronRight,
  ChevronDown,
  FileText,
  Clock,
  GitBranch,
  Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { groupChannels } from "@/components/comms/channelGrouping";
import { type CommsChannel } from "./pageTypes";
import { ChannelIcon } from "./ChannelHeader";

// ─── Sidebar ──────────────────────────────────────────────────────────────────

  export type CommsView = "channel" | "drafts" | "scheduled" | "threads" | "search" | "emoji" | "clients";

  function SidebarChannelRow({
    ch,
    selectedId,
    onSelect,
    onClose,
    isPinned,
    onTogglePin,
  }: {
    ch: CommsChannel;
    selectedId: string | null;
    onSelect: (id: string) => void;
    onClose: () => void;
    isPinned: boolean;
    onTogglePin: (id: string) => void;
  }) {
    const name = channelDisplayName(ch);
    const isActive = ch.id === selectedId;
    const hasMentions = (ch.mentionCount ?? 0) > 0;
    return (
      <div
        className={cn(
          "group flex items-center gap-1.5 px-2 py-[5px] rounded-md cursor-pointer transition-colors select-none",
          isActive
            ? "bg-primary/10 text-primary-ink font-medium"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
        data-testid={`channel-item-${ch.id}`}
        onClick={() => { onSelect(ch.id); onClose(); }}
      >
        <ChannelIcon ch={ch} />
        <span className="flex-1 text-sm truncate">{name}</span>
        {ch.unreadCount > 0 && (
          <Badge
            variant="secondary"
            className={cn(
              "text-caption h-4 min-w-4 px-1 flex-shrink-0",
              hasMentions
                ? "bg-red-500 text-white"
                : "bg-primary text-primary-foreground",
            )}
            data-testid={`channel-unread-${ch.id}`}
          >
            {hasMentions
              ? `@${(ch.mentionCount ?? 0) > 99 ? "99+" : ch.mentionCount}`
              : ch.unreadCount > 99 ? "99+" : ch.unreadCount}
          </Badge>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onTogglePin(ch.id); }}
          data-testid={`pin-toggle-${ch.id}`}
          aria-label={isPinned ? "Unpin channel" : "Pin channel"}
          className={cn(
            "h-5 w-5 flex-shrink-0 flex items-center justify-center rounded transition-all",
            isPinned
              ? "opacity-100 text-amber-500"
              : "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-amber-500",
          )}
        >
          <Star className="h-3 w-3" fill={isPinned ? "currentColor" : "none"} />
        </button>
      </div>
    );
  }

  export function CommsSidebar({
    channels,
    selectedId,
    onSelect,
    onNewChannel,
    onNewDm,
    open,
    onClose,
    selectedView,
    onSelectView,
  }: {
    channels: CommsChannel[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    onNewChannel: () => void;
    onNewDm: () => void;
    open: boolean;
    onClose: () => void;
    selectedView: CommsView;
    onSelectView: (view: CommsView) => void;
  }) {
    const { user } = useAuth();
    const sidebarUserRole = (user as any)?.dbUser?.role ?? "";
    const showEmojiAdmin = sidebarUserRole === "team_lead" || sidebarUserRole === "ceo";
    const { totalThreadUnread, totalThreadMentions, pinnedChannelIds, togglePin } = useCommsContext();

    const { pinnedChannels, recentChannels, clientChannels } = useMemo(
      () => groupChannels(channels, pinnedChannelIds),
      [channels, pinnedChannelIds],
    );

    const [clientsOpen, setClientsOpen] = useState<boolean>(() => {
      try {
        const v = localStorage.getItem("comms_page_clients_group_open");
        return v === null ? true : v === "true";
      } catch { return true; }
    });

    const toggleClientsOpen = () => {
      setClientsOpen((prev) => {
        const next = !prev;
        try { localStorage.setItem("comms_page_clients_group_open", String(next)); } catch {}
        return next;
      });
    };

    // ── Quick channel search ──────────────────────────────────────────────────
    const [filterQuery, setFilterQuery] = useState("");
    const [activeResultIndex, setActiveResultIndex] = useState(0);
    const filterInputRef = useRef<HTMLInputElement>(null);

    const trimmedFilter = filterQuery.trim().toLowerCase();

    const filteredChannels = useMemo(() => {
      if (!trimmedFilter) return [];
      const allChannels = [...pinnedChannels, ...recentChannels, ...clientChannels];
      return allChannels.filter((ch) => {
        const name = channelDisplayName(ch).toLowerCase();
        if (name.includes(trimmedFilter)) return true;
        if (ch.clientFirmName && ch.clientFirmName.toLowerCase().includes(trimmedFilter)) return true;
        return false;
      });
    }, [trimmedFilter, pinnedChannels, recentChannels, clientChannels]);

    // Reset active index when query or results change
    useEffect(() => {
      setActiveResultIndex(0);
    }, [trimmedFilter]);

    // Keep the keyboard-highlighted result visible while arrowing through a long list
    const activeResultRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (!trimmedFilter) return;
      activeResultRef.current?.scrollIntoView({ block: "nearest" });
    }, [activeResultIndex, trimmedFilter]);

    // Cmd/Ctrl+K — focus the filter input
    useEffect(() => {
      const handleGlobalKey = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "k") {
          const target = e.target;
          if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
          ) {
            return;
          }
          e.preventDefault();
          filterInputRef.current?.focus();
          filterInputRef.current?.select();
        }
      };
      window.addEventListener("keydown", handleGlobalKey);
      return () => window.removeEventListener("keydown", handleGlobalKey);
    }, []);

    const selectFilteredChannel = (ch: CommsChannel) => {
      onSelect(ch.id);
      setFilterQuery("");
      onClose();
      // Give React a tick to mount the Composer before focusing it
      setTimeout(() => {
        const el = document.querySelector<HTMLElement>('[data-testid="comms-composer-input"]');
        if (el) el.focus();
      }, 80);
    };

    const handleFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!trimmedFilter) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveResultIndex((i) => Math.min(i + 1, filteredChannels.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveResultIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const ch = filteredChannels[activeResultIndex];
        if (ch) selectFilteredChannel(ch);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setFilterQuery("");
        filterInputRef.current?.blur();
      }
    };

    const rowProps = { selectedId, onSelect, onClose, onTogglePin: togglePin };

    return (
      <>
        {open && (
          <div
            className="fixed inset-0 z-20 bg-black/30 md:hidden"
            onClick={onClose}
            aria-hidden="true"
          />
        )}
        <div
          className={cn(
            "flex-shrink-0 bg-muted/20 border-r border-border flex flex-col w-60",
            "md:flex md:relative md:translate-x-0 md:inset-auto md:z-auto",
            open ? "flex fixed top-14 left-0 bottom-0 z-30" : "hidden md:flex",
          )}
          data-testid="comms-sidebar"
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
            <h1 className="font-bold text-sm text-foreground">NoBull Comms</h1>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onNewChannel}
                    className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    aria-label="New channel"
                    data-testid="new-channel-button"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>New channel</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onNewDm}
                    className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    aria-label="New direct message"
                    data-testid="new-dm-button"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>New direct message</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Quick search input */}
          <div className="px-2 pt-2 pb-1 flex-shrink-0">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                ref={filterInputRef}
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                onKeyDown={handleFilterKeyDown}
                placeholder="Find channel… ⌘K"
                className="h-7 pl-7 pr-6 text-xs bg-muted/40 border-border/60 focus-visible:ring-1 focus-visible:ring-primary/50"
                data-testid="sidebar-channel-search-input"
                aria-label="Search channels"
                autoComplete="off"
                spellCheck={false}
              />
              {filterQuery && (
                <button
                  onClick={() => { setFilterQuery(""); filterInputRef.current?.focus(); }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  data-testid="sidebar-channel-search-clear"
                  aria-label="Clear search"
                  tabIndex={-1}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div className="px-2 py-2">

              {/* ── Quick search results ── */}
              {trimmedFilter ? (
                filteredChannels.length > 0 ? (
                  <div data-testid="sidebar-search-results">
                    {filteredChannels.map((ch, idx) => {
                      const name = channelDisplayName(ch);
                      const isHighlighted = idx === activeResultIndex;
                      const hasMentions = (ch.mentionCount ?? 0) > 0;
                      return (
                        <div
                          key={ch.id}
                          ref={isHighlighted ? activeResultRef : undefined}
                          className={cn(
                            "group flex items-center gap-1.5 px-2 py-[5px] rounded-md cursor-pointer transition-colors select-none",
                            isHighlighted || ch.id === selectedId
                              ? "bg-primary/10 text-primary-ink font-medium"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                          data-testid={`search-result-channel-${ch.id}`}
                          onMouseEnter={() => setActiveResultIndex(idx)}
                          onClick={() => selectFilteredChannel(ch)}
                        >
                          <ChannelIcon ch={ch} />
                          <span className="flex-1 text-sm truncate">{name}</span>
                          {ch.unreadCount > 0 && (
                            <Badge
                              variant="secondary"
                              className={cn(
                                "text-caption h-4 min-w-4 px-1 flex-shrink-0",
                                hasMentions
                                  ? "bg-red-500 text-white"
                                  : "bg-primary text-primary-foreground",
                              )}
                            >
                              {hasMentions
                                ? `@${(ch.mentionCount ?? 0) > 99 ? "99+" : ch.mentionCount}`
                                : ch.unreadCount > 99 ? "99+" : ch.unreadCount}
                            </Badge>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-2 py-6 text-center" data-testid="sidebar-search-empty">
                    <p className="text-xs text-muted-foreground">No channels match &ldquo;{filterQuery.trim()}&rdquo;</p>
                  </div>
                )
              ) : (
                <>
              {/* Pinned section */}
              {pinnedChannels.length > 0 && (
                <div className="mb-2">
                  <div className="flex items-center gap-1.5 px-2 py-1">
                    <Star className="h-3 w-3 text-amber-500 fill-amber-500" />
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Pinned</span>
                  </div>
                  {pinnedChannels.map((ch) => (
                    <SidebarChannelRow key={ch.id} ch={ch} isPinned={true} {...rowProps} />
                  ))}
                </div>
              )}

              {/* Recent section */}
              {recentChannels.length > 0 && (
                <div className="mb-2">
                  <div className="px-2 py-1">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Recent</span>
                  </div>
                  {recentChannels.map((ch) => (
                    <SidebarChannelRow key={ch.id} ch={ch} isPinned={false} {...rowProps} />
                  ))}
                </div>
              )}

              {/* Clients — collapsible */}
              {clientChannels.length > 0 && (
                <div className="mb-2" data-testid="sidebar-clients-section">
                  <button
                    onClick={toggleClientsOpen}
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-muted/50 text-left"
                    data-testid="sidebar-clients-toggle"
                  >
                    {clientsOpen
                      ? <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      : <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex-1">
                      Clients
                    </span>
                    <Badge variant="secondary" className="text-caption h-4 px-1.5">
                      {clientChannels.length}
                    </Badge>
                  </button>
                  {clientsOpen && clientChannels.map((ch) => (
                    <SidebarChannelRow key={ch.id} ch={ch} isPinned={false} {...rowProps} />
                  ))}
                </div>
              )}

              {/* Navigation views */}
              <div className="mt-2 border-t border-border/50 pt-2 space-y-0.5">
                {(
                  [
                    // Task #4373 (audit §8.4-b): client SMS/calls (the former
                    // /conversations page) — a comms view, not a separate page.
                    { view: "clients" as CommsView, icon: <Phone className="h-4 w-4 flex-shrink-0" />, label: "Client Texts & Calls" },
                    { view: "search" as CommsView, icon: <Search className="h-4 w-4 flex-shrink-0" />, label: "Search" },
                    {
                      view: "threads" as CommsView,
                      icon: <GitBranch className="h-4 w-4 flex-shrink-0" />,
                      label: "Threads",
                      badge: totalThreadUnread > 0
                        ? (totalThreadMentions > 0
                            ? `@${totalThreadMentions > 99 ? "99+" : totalThreadMentions}`
                            : String(totalThreadUnread > 99 ? "99+" : totalThreadUnread))
                        : undefined,
                      badgeMention: totalThreadMentions > 0,
                    },
                    { view: "drafts" as CommsView, icon: <FileText className="h-4 w-4 flex-shrink-0" />, label: "Drafts" },
                    { view: "scheduled" as CommsView, icon: <Clock className="h-4 w-4 flex-shrink-0" />, label: "Scheduled" },
                    ...(showEmojiAdmin
                      ? [{ view: "emoji" as CommsView, icon: <Smile className="h-4 w-4 flex-shrink-0" />, label: "Custom Emoji" }]
                      : []),
                  ] as Array<{ view: CommsView; icon: React.ReactNode; label: string; badge?: string; badgeMention?: boolean }>
                ).map(({ view, icon, label, badge, badgeMention }) => (
                  <button
                    key={view}
                    onClick={() => { onSelectView(view); onClose(); }}
                    data-testid={`nav-${view}`}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-left",
                      selectedView === view
                        ? "bg-primary/10 text-primary-ink font-medium"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {icon}
                    <span className="flex-1 truncate">{label}</span>
                    {badge && (
                      <Badge
                        className={cn(
                          "text-caption px-1.5 h-4",
                          badgeMention
                            ? "bg-red-500 text-white"
                            : "bg-primary text-primary-foreground",
                        )}
                        data-testid={`nav-${view}-badge`}
                      >
                        {badge}
                      </Badge>
                    )}
                  </button>
                ))}
              </div>
                </>
              )}
            </div>
          </ScrollArea>

          <CommsSidebarStatusFooter />
        </div>
      </>
    );
  }

function CommsSidebarStatusFooter() {
  const { myStatus } = useCommsContext();
  return (
    <div className="border-t border-border px-2 py-2">
      <UserStatusPicker myStatus={myStatus} align="end">
        <button
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted text-sm text-left transition-colors"
          data-testid="comms-page-status-picker-trigger"
        >
          <StatusDot status={myStatus?.effectiveStatus ?? "offline"} />
          <span className="flex-1 truncate text-muted-foreground">
            {myStatus?.customText
              ? `${myStatus.customEmoji ?? ""} ${myStatus.customText}`.trim()
              : myStatus?.effectiveStatus === "online"
                ? "Active"
                : myStatus?.effectiveStatus === "away"
                  ? "Away"
                  : myStatus?.effectiveStatus === "dnd"
                    ? "Do not disturb"
                    : "Offline"}
          </span>
        </button>
      </UserStatusPicker>
    </div>
  );
}
