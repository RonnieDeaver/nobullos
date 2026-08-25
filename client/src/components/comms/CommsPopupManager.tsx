/**
 * CommsPopupManager — up to 3 docked popup chat windows, bottom-right corner.
 *
 * Each popup:
 *   - Shows a slim title bar with channel name, minimize, expand, close
 *   - Expands to a compact message pane + composer
 *   - Marks the channel read when focused
 *   - "Open in full view" navigates to /comms?channel=<id>
 *   - Survives page navigation (lives in the global shell)
 */

import { memo, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Phone,
  Video,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommsSelector } from "@/contexts/CommsContext";
import { MessagePane } from "./MessagePane";
import { Composer } from "./Composer";
import { ChannelIcon, channelDisplayName } from "./helpers";
import type { CommsChannel } from "./types";

const STATUS_DOT_COLORS: Record<string, string> = {
  online: "bg-green-400",
  away: "bg-yellow-400",
  dnd: "bg-red-400",
  offline: "bg-white/30",
};

const POPUP_WIDTH = 340;
const POPUP_TITLE_HEIGHT = 40;
const POPUP_BODY_HEIGHT = 380;
const POPUP_GAP = 8;
// Gap between the right edge of the rightmost popup and the left edge of the rail.
const POPUP_RAIL_GAP = 12;
// Collapsed rail: w-0 panel + w-5 (20px) edge tab — 56px gives comfortable clearance.
const POPUP_RIGHT_OFFSET_COLLAPSED = 56;
// Expanded rail: w-64 = 256px (Tailwind). Popups must clear that plus the gap.
const RAIL_EXPANDED_WIDTH = 256;
const POPUP_RIGHT_OFFSET_EXPANDED = RAIL_EXPANDED_WIDTH + POPUP_RAIL_GAP;
// Below this viewport width the popup collapses its right offset and shrinks
// so it fits fully on screen (340px + 56px offset needs 396px — wider than
// a 375px phone). The rail is `hidden md:flex` so it never shows on narrow
// screens; narrow handling is independent of rail state.
const NARROW_VIEWPORT_BREAKPOINT = 480;
const NARROW_RIGHT_OFFSET = 8;
const NARROW_LEFT_MARGIN = 8;
// Breathing room kept above an expanded popup when the visual viewport is
// short (e.g. phone keyboard open) so the title bar never touches the top edge.
const POPUP_TOP_MARGIN = 8;
// Desktop overflow: minimum left margin kept clear of the leftmost column,
// and the width floor a clamped column/bar may shrink to before we accept
// overlapping the rail instead (composer usability floor).
const DESKTOP_LEFT_MARGIN = 8;
const DESKTOP_MIN_POPUP_WIDTH = 240;

/**
 * Viewport metrics for popup layout — one consolidated subscription.
 *
 * Tracks the layout viewport's width plus the *visual* viewport's height so
 * popups stay above the on-screen keyboard: on phones, opening the keyboard
 * shrinks `window.visualViewport.height` without necessarily resizing the
 * layout viewport (`window.innerHeight`) — so a `bottom: 0` fixed element
 * can end up hidden behind the keyboard.
 *
 * Returns:
 *   - viewportWidth: window.innerWidth (drives the column-fit math below)
 *   - viewportHeight: the visible height (keyboard excluded when open)
 *   - keyboardInset: how far the bottom of the layout viewport is obscured
 *     (0 on desktop / when the keyboard is closed). Popups are lifted by
 *     this amount so the composer stays visible while typing.
 *
 * Audit P2-9 (§4.4) — these listeners are deliberately JS, noted as
 * intentional; CSS media/container queries cannot replace them:
 *   - viewportWidth feeds *continuous* column-fit math in
 *     computePopupLayouts() (how many columns fit given rail state + popup
 *     count, width clamping) and flips interaction semantics — overflow
 *     popups become forcedBar bars whose tap PROMOTES instead of toggling
 *     minimize. React must know the width; a breakpoint class can't drive
 *     that behavior.
 *   - viewportHeight/keyboardInset come from window.visualViewport, which no
 *     CSS unit (dvh included — it ignores the keyboard on iOS/Android) or
 *     media query can observe.
 * The previous separate width hook duplicated the window `resize`
 * subscription; consolidating keeps ONE handler for all three metrics.
 */
type ViewportMetrics = {
  viewportWidth: number;
  viewportHeight: number;
  keyboardInset: number;
};

function readViewportMetrics(): ViewportMetrics {
  if (typeof window === "undefined") {
    return {
      viewportWidth: NARROW_VIEWPORT_BREAKPOINT,
      viewportHeight: POPUP_TITLE_HEIGHT + POPUP_BODY_HEIGHT,
      keyboardInset: 0,
    };
  }
  const vv = window.visualViewport;
  if (!vv) {
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      keyboardInset: 0,
    };
  }
  return {
    viewportWidth: window.innerWidth,
    viewportHeight: vv.height,
    keyboardInset: Math.max(0, window.innerHeight - vv.height - vv.offsetTop),
  };
}

function useViewportMetrics(): ViewportMetrics {
  const [metrics, setMetrics] = useState<ViewportMetrics>(readViewportMetrics);

  useEffect(() => {
    const onChange = () =>
      setMetrics((prev) => {
        const next = readViewportMetrics();
        // visualViewport `scroll` fires continuously while panning a zoomed
        // page — return the previous object when nothing changed so the
        // manager doesn't re-render per frame.
        return prev.viewportWidth === next.viewportWidth &&
          prev.viewportHeight === next.viewportHeight &&
          prev.keyboardInset === next.keyboardInset
          ? prev
          : next;
      });
    const vv = window.visualViewport;
    window.addEventListener("resize", onChange);
    vv?.addEventListener("resize", onChange);
    vv?.addEventListener("scroll", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
      vv?.removeEventListener("resize", onChange);
      vv?.removeEventListener("scroll", onChange);
    };
  }, []);

  return metrics;
}

/**
 * Per-popup layout, computed by the manager for all open popups.
 *
 * Desktop (>= 480px): 340px-wide columns offset left of the rail, up to 3
 * side-by-side (bottom-anchored, horizontal). When the viewport is only wide
 * enough for fewer columns (e.g. 768–800px with the rail expanded fits just
 * one), the overflow popups collapse into minimized bars stacked above the
 * newest column — same tap-to-promote behavior as narrow viewports.
 *
 * Narrow (< 480px): a phone only fits one popup wide, so popups stack
 * vertically at the right edge instead. Only the newest (last) popup can
 * expand; every older popup renders as a minimized title bar above it.
 * Tapping an older bar promotes that chat to the newest slot.
 */
export type PopupLayout = {
  width: number;
  rightOffset: number;
  bottomOffset: number;
  /**
   * Height of the expanded body (message pane + composer). Normally
   * POPUP_BODY_HEIGHT, but capped so title + body never exceed the visible
   * viewport (e.g. phone keyboard open shrinks the visual viewport).
   */
  bodyHeight: number;
  /** Narrow viewports: popup is forced into a minimized bar; tapping promotes it. */
  forcedBar: boolean;
};

export function computePopupLayouts({
  viewportWidth,
  onCommsPage,
  railOpen,
  totalPopups,
  newestExpanded,
  viewportHeight = POPUP_TITLE_HEIGHT + POPUP_BODY_HEIGHT + POPUP_TOP_MARGIN,
  keyboardInset = 0,
}: {
  viewportWidth: number;
  onCommsPage: boolean;
  railOpen: boolean;
  totalPopups: number;
  newestExpanded: boolean;
  /** Visible (visual viewport) height — shrinks when the phone keyboard opens. */
  viewportHeight?: number;
  /** Pixels of the layout viewport's bottom obscured by the keyboard; popups lift by this. */
  keyboardInset?: number;
}): PopupLayout[] {
  const isNarrow = viewportWidth < NARROW_VIEWPORT_BREAKPOINT;

  // Cap the expanded body so title + body always fit within the visible
  // viewport, leaving a small top margin. Never below the title height so
  // the composer remains usable on absurdly short viewports.
  const bodyHeight = Math.max(
    POPUP_TITLE_HEIGHT,
    Math.min(POPUP_BODY_HEIGHT, viewportHeight - POPUP_TITLE_HEIGHT - POPUP_TOP_MARGIN),
  );

  // The Tailwind `md` breakpoint (768px) is where CommsRail becomes visible
  // (`hidden md:flex`). Below 768px the rail panel is never rendered even if
  // railOpen is true in persisted state, so expanded offset must not apply.
  const RAIL_VISIBLE_BREAKPOINT = 768;

  if (!isNarrow) {
    // Desktop: horizontal row, right-most is newest.
    // When the rail is visibly expanded (viewport ≥ 768px AND railOpen), shift
    // popups left far enough to clear its full width so the rail's footer
    // controls (status, Open full view, bell, +) remain reachable.
    // On 480–767px the rail is hidden regardless of railOpen, so always use
    // the collapsed offset to keep popups on-screen at those widths.
    const railVisiblyExpanded = railOpen && viewportWidth >= RAIL_VISIBLE_BREAKPOINT;
    let baseOffset: number;
    if (onCommsPage) {
      baseOffset = 0;
    } else if (railVisiblyExpanded) {
      baseOffset = POPUP_RIGHT_OFFSET_EXPANDED;
    } else {
      baseOffset = POPUP_RIGHT_OFFSET_COLLAPSED;
    }

    // Overflow handling: only as many full 340px columns fit as the space
    // between the rail (baseOffset) and the left edge allows. At tight
    // desktop widths (e.g. 768–800px with the rail expanded: 768 − 268 −
    // 8 = 492px) only ONE column fits — older popups must not slide
    // off-screen left, so they collapse into minimized bars stacked above
    // the newest column (same tap-to-promote behavior as narrow viewports).
    const available = viewportWidth - baseOffset - DESKTOP_LEFT_MARGIN;
    // Clamp column/bar width so even a single column never overlaps the
    // rail or runs off the left edge. Floor keeps the composer usable if a
    // future design ever narrows the viewport-to-rail ratio further; at
    // that point overlapping the rail slightly beats an unusable popup.
    const width = Math.min(POPUP_WIDTH, Math.max(DESKTOP_MIN_POPUP_WIDTH, available));
    const columnsThatFit = Math.max(
      1,
      Math.floor((available + POPUP_GAP) / (width + POPUP_GAP)),
    );
    const columnCount = Math.min(totalPopups, columnsThatFit);
    // Index of the oldest popup that still gets a full column.
    const firstColumnIndex = totalPopups - columnCount;
    // Bars stack above the newest (right-most) column, so their bottom
    // offsets depend on whether that column is expanded or minimized.
    const newestHeight = newestExpanded
      ? POPUP_TITLE_HEIGHT + bodyHeight
      : POPUP_TITLE_HEIGHT;

    return Array.from({ length: totalPopups }, (_, index) => {
      if (index >= firstColumnIndex) {
        return {
          width,
          rightOffset: baseOffset + (totalPopups - 1 - index) * (width + POPUP_GAP),
          bottomOffset: keyboardInset,
          bodyHeight,
          forcedBar: false,
        };
      }
      // Overflow popup: minimized bar above the newest column, newest bar
      // closest to it (mirrors the narrow-viewport vertical stack).
      return {
        width,
        rightOffset: baseOffset,
        bottomOffset:
          keyboardInset +
          newestHeight +
          POPUP_GAP +
          (firstColumnIndex - 1 - index) * (POPUP_TITLE_HEIGHT + POPUP_GAP),
        bodyHeight,
        forcedBar: true,
      };
    });
  }

  const width = Math.min(
    POPUP_WIDTH,
    viewportWidth - NARROW_RIGHT_OFFSET - NARROW_LEFT_MARGIN,
  );
  const newestHeight = newestExpanded
    ? POPUP_TITLE_HEIGHT + bodyHeight
    : POPUP_TITLE_HEIGHT;

  return Array.from({ length: totalPopups }, (_, index) => {
    const isNewest = index === totalPopups - 1;
    return {
      width,
      rightOffset: NARROW_RIGHT_OFFSET,
      bottomOffset:
        keyboardInset +
        (isNewest
          ? 0
          : newestHeight +
            POPUP_GAP +
            (totalPopups - 2 - index) * (POPUP_TITLE_HEIGHT + POPUP_GAP)),
      bodyHeight,
      forcedBar: !isNewest,
    };
  });
}

// ─── Single popup window ──────────────────────────────────────────────────────

const CommsPopup = memo(function CommsPopup({
  channel,
  minimized,
  layout,
  currentUserId,
}: {
  channel: CommsChannel;
  minimized: boolean;
  layout: PopupLayout;
  currentUserId: string;
}) {
  // Narrow store subscriptions (Task #3848): the action callbacks are stable,
  // and statuses are selected per relevant user below — so SSE churn in OTHER
  // channels / for unrelated users never re-renders this popup.
  const closePopup = useCommsSelector((s) => s.closePopup);
  const setPopupMinimized = useCommsSelector((s) => s.setPopupMinimized);
  const promotePopup = useCommsSelector((s) => s.promotePopup);
  // Narrow viewports force every non-newest popup into a minimized bar;
  // tapping its title promotes it to the newest (expanded) slot instead of
  // toggling the minimized flag.
  const effectiveMinimized = layout.forcedBar || minimized;
  const handleTitleAction = () => {
    if (layout.forcedBar) {
      promotePopup(channel.id);
    } else {
      setPopupMinimized(channel.id, !minimized);
    }
  };

  // For DM/group-dm channels, derive the other members' statuses for the title bar dots.
  const otherMemberIds =
    (channel.type === "dm" || channel.type === "group_dm") && channel.members
      ? channel.members.filter((m) => m.userId !== currentUserId).map((m) => m.userId)
      : [];
  const otherMemberId = channel.type === "dm" ? otherMemberIds[0] ?? null : null;
  // Match group-DM behavior: an unknown status renders as offline rather than hiding the dot.
  // Selected as a plain string so only THIS user's status change re-renders the popup.
  const otherEffectiveStatus = useCommsSelector((s) =>
    otherMemberId ? s.userStatuses.get(otherMemberId)?.effectiveStatus ?? "offline" : null,
  );
  // Group DMs: one dot per other participant (capped to keep the title bar compact).
  // Pair each dot with the participant's name (from dmParticipants) so the
  // hover tooltip reads "Jane Doe — Online" instead of just the status.
  const participantNameById = new Map(
    (channel.dmParticipants ?? []).map((p) => [p.userId, p.name]),
  );
  // Group DMs: select the participants' statuses as one joined string so the
  // slice is Object.is-comparable — presence churn for non-members stays inert.
  const groupStatusKey = useCommsSelector((s) =>
    channel.type === "group_dm"
      ? otherMemberIds
          .map((id) => s.userStatuses.get(id)?.effectiveStatus ?? "offline")
          .join("|")
      : "",
  );
  const groupStatusValues = groupStatusKey === "" ? [] : groupStatusKey.split("|");
  const allGroupStatuses =
    channel.type === "group_dm"
      ? otherMemberIds.map((id, i) => ({
          userId: id,
          name: participantNameById.get(id) ?? null,
          status: groupStatusValues[i] ?? "offline",
        }))
      : [];
  const groupStatuses = allGroupStatuses.slice(0, 5);
  // Participants beyond the first 5 dots surface via a "+N" chip whose hover
  // tooltip lists each remaining participant's name and status.
  const overflowStatuses = allGroupStatuses.slice(5);
  const [, navigate] = useLocation();
  const [startingCall, setStartingCall] = useState<"voice" | "video" | null>(null);
  const [callsConfigured, setCallsConfigured] = useState(true);

  const name = channelDisplayName(channel);

  const handleExpandFull = () => {
    navigate(`/comms?channel=${channel.id}`);
  };

  const handleStartCall = async (callType: "voice" | "video") => {
    if (startingCall || !callsConfigured) return;
    setStartingCall(callType);
    try {
      const resp = await fetch(`/api/comms/channels/${channel.id}/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callType }),
        credentials: "include",
      });
      if (resp.ok) {
        const { call, roomName } = await resp.json();
        // Pass roomName + callType directly in URL so Comms.tsx can enter the call
        // without relying on potentially-stale channel cache (activeCall).
        const params = new URLSearchParams({
          channel: channel.id,
          joinCall: call.id,
          joinRoom: roomName ?? call.livekitRoomName ?? "",
          joinCallType: callType,
        });
        navigate(`/comms?${params.toString()}`);
      } else if (resp.status === 503) {
        setCallsConfigured(false);
      } else if (resp.status === 409) {
        const data = await resp.json().catch(() => ({}));
        const activeCall = data.call;
        if (activeCall?.id) {
          const params = new URLSearchParams({
            channel: channel.id,
            joinCall: activeCall.id,
            ...(activeCall.livekitRoomName ? { joinRoom: activeCall.livekitRoomName } : {}),
            ...(activeCall.callType ? { joinCallType: activeCall.callType } : { joinCallType: callType }),
          });
          navigate(`/comms?${params.toString()}`);
        } else {
          navigate(`/comms?channel=${channel.id}`);
        }
      } else {
        navigate(`/comms?channel=${channel.id}&autoStartCall=${callType}`);
      }
    } catch {
      navigate(`/comms?channel=${channel.id}&autoStartCall=${callType}`);
    } finally {
      setStartingCall(null);
    }
  };

  // Forced-bar attention pulse: when a new message lands in a chat that is
  // currently a forced minimized bar, briefly highlight the bar so the user
  // notices activity while another chat is expanded. This applies both to the
  // narrow-viewport stack and to desktop overflow bars (which also set
  // forcedBar=true when the viewport only fits fewer columns). Expanded
  // desktop columns (forcedBar false) are unaffected.
  const [attention, setAttention] = useState(false);
  const prevActivityRef = useRef<number>(
    (channel.unreadCount ?? 0) + (channel.mentionCount ?? 0),
  );
  useEffect(() => {
    const activity = (channel.unreadCount ?? 0) + (channel.mentionCount ?? 0);
    const prev = prevActivityRef.current;
    prevActivityRef.current = activity;
    if (!layout.forcedBar) {
      if (attention) setAttention(false);
      return;
    }
    if (activity > prev) {
      setAttention(true);
      const t = setTimeout(() => setAttention(false), 2000);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.unreadCount, channel.mentionCount, layout.forcedBar]);

  // Mark read when popup gains focus
  useEffect(() => {
    if (!effectiveMinimized) {
      const handler = () => {
        fetch(`/api/comms/channels/${channel.id}/read-state`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lastReadMessageId: null }),
        }).catch(() => {});
      };
      window.addEventListener("focus", handler);
      return () => window.removeEventListener("focus", handler);
    }
  }, [channel.id, effectiveMinimized]);

  return (
    <div
      className={cn(
        "fixed z-40 flex flex-col bg-background border border-border rounded-t-lg shadow-xl overflow-hidden",
        attention && "ring-2 ring-red-400 animate-pulse",
      )}
      // Position/size are continuous values from computePopupLayouts — they
      // must stay inline. The old height/bottom/right transitions were
      // layout-property animations (audit P2-9 §4.2) and were removed: slot
      // moves now snap, and the expand reveal animates on the body below via
      // transform/opacity instead.
      style={{
        right: layout.rightOffset,
        bottom: layout.bottomOffset,
        width: layout.width,
        height: effectiveMinimized ? POPUP_TITLE_HEIGHT : POPUP_TITLE_HEIGHT + layout.bodyHeight,
      }}
      data-testid={`comms-popup-${channel.id}`}
      data-attention={attention ? "true" : undefined}
    >
      {/* Title bar */}
      <div
        className={cn(
          // h-10 = POPUP_TITLE_HEIGHT (40px) — keep in lockstep with the
          // layout constants above.
          "flex h-10 items-center gap-2 px-3 text-white flex-shrink-0 transition-colors duration-300",
          attention ? "bg-[#8B3A50]" : "bg-primary",
        )}
      >
        <ChannelIcon ch={channel} />
        {otherEffectiveStatus && (
          <span
            className={cn("h-2.5 w-2.5 rounded-full flex-shrink-0 border border-white/40", STATUS_DOT_COLORS[otherEffectiveStatus] ?? "bg-white/30")}
            title={otherEffectiveStatus === "dnd" ? "Do not disturb" : otherEffectiveStatus.charAt(0).toUpperCase() + otherEffectiveStatus.slice(1)}
            data-testid={`popup-other-status-${channel.id}`}
          />
        )}
        {groupStatuses.length > 0 && (
          <span className="flex items-center gap-0.5 flex-shrink-0" data-testid={`popup-group-statuses-${channel.id}`}>
            {groupStatuses.map((s) => {
              const statusLabel = s.status === "dnd" ? "Do not disturb" : s.status.charAt(0).toUpperCase() + s.status.slice(1);
              return (
                <span
                  key={s.userId}
                  className={cn("h-2 w-2 rounded-full border border-white/40", STATUS_DOT_COLORS[s.status] ?? "bg-white/30")}
                  title={s.name ? `${s.name} — ${statusLabel}` : statusLabel}
                  data-testid={`popup-group-status-${channel.id}-${s.userId}`}
                />
              );
            })}
            {overflowStatuses.length > 0 && (
              <span
                className="h-4 min-w-4 px-1 flex items-center justify-center rounded-full bg-white/20 text-white text-caption font-semibold leading-none cursor-default"
                title={overflowStatuses
                  .map((s) => {
                    const statusLabel = s.status === "dnd" ? "Do not disturb" : s.status.charAt(0).toUpperCase() + s.status.slice(1);
                    return s.name ? `${s.name} — ${statusLabel}` : statusLabel;
                  })
                  .join("\n")}
                data-testid={`popup-group-status-overflow-${channel.id}`}
              >
                +{overflowStatuses.length}
              </span>
            )}
          </span>
        )}
        <button
          className="flex-1 text-sm font-semibold text-left truncate hover:opacity-90"
          onClick={handleTitleAction}
          data-testid={`popup-title-${channel.id}`}
        >
          {name}
        </button>
        {effectiveMinimized && (() => {
          const pref = channel.notifPref ?? "all";
          if (pref === "muted") return false;
          const hasMention = (channel.mentionCount ?? 0) > 0;
          const hasUnread = channel.unreadCount > 0;
          const showBadge = pref === "mentions" ? hasMention : (hasMention || hasUnread);
          if (!showBadge) return false;
          // Mentions and DMs/group-DMs: numeric count. Plain unreads on regular channels: dot only.
          const isMentionOrDm = hasMention || channel.type === "dm" || channel.type === "group_dm";
          if (isMentionOrDm) {
            const count = hasMention ? (channel.mentionCount ?? channel.unreadCount) : channel.unreadCount;
            return (
              <span
                className="h-4 w-4 flex items-center justify-center rounded-full text-caption font-bold flex-shrink-0 bg-red-500 text-white"
                data-testid={`popup-unread-badge-${channel.id}`}
              >
                {(count ?? 0) > 9 ? "9+" : count}
              </span>
            );
          }
          // Plain unread: small dot, no number
          return (
            <span
              className="h-2 w-2 rounded-full bg-primary flex-shrink-0"
              data-testid={`popup-unread-badge-${channel.id}`}
            />
          );
        })()}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => handleStartCall("voice")}
                disabled={!!startingCall || !callsConfigured}
                aria-disabled={!!startingCall || !callsConfigured}
                className="h-6 w-6 flex items-center justify-center rounded hover:bg-white/20 text-white/80 hover:text-white disabled:opacity-50"
                data-testid={`popup-voice-call-${channel.id}`}
              >
                {startingCall === "voice" ? (
                  <span className="h-3.5 w-3.5 border-2 border-white/60 border-t-transparent rounded-full animate-spin inline-block" />
                ) : (
                  <Phone className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {callsConfigured ? "Start voice call" : "Calls not configured — contact your administrator"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => handleStartCall("video")}
                disabled={!!startingCall || !callsConfigured}
                aria-disabled={!!startingCall || !callsConfigured}
                className="h-6 w-6 flex items-center justify-center rounded hover:bg-white/20 text-white/80 hover:text-white disabled:opacity-50"
                data-testid={`popup-video-call-${channel.id}`}
              >
                {startingCall === "video" ? (
                  <span className="h-3.5 w-3.5 border-2 border-white/60 border-t-transparent rounded-full animate-spin inline-block" />
                ) : (
                  <Video className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {callsConfigured ? "Start video call" : "Calls not configured — contact your administrator"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleExpandFull}
                className="h-6 w-6 flex items-center justify-center rounded hover:bg-white/20 text-white/80 hover:text-white"
                data-testid={`popup-expand-${channel.id}`}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Open full view</TooltipContent>
          </Tooltip>
          <button
            onClick={handleTitleAction}
            className="h-6 w-6 flex items-center justify-center rounded hover:bg-white/20 text-white/80 hover:text-white"
            data-testid={`popup-minimize-${channel.id}`}
          >
            {effectiveMinimized ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => closePopup(channel.id)}
            className="h-6 w-6 flex items-center justify-center rounded hover:bg-white/20 text-white/80 hover:text-white"
            data-testid={`popup-close-${channel.id}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body — hidden when minimized */}
      {!effectiveMinimized && (
        <div
          // Expand reveal: transform/opacity enter utilities (tw-animate-css)
          // replace the old `transition: height` on the popup shell (audit
          // P2-9 §4.2). Collapse unmounts instantly, as before.
          className="flex flex-col flex-1 min-h-0 animate-in fade-in-0 slide-in-from-bottom-2 duration-150 motion-reduce:animate-none"
          style={{ height: layout.bodyHeight }}
        >
          <MessagePane
            channel={channel}
            currentUserId={currentUserId}
            hideComposer
            mediaCompact
          />
          <Composer
            channelId={channel.id}
            placeholder={`Message ${name}`}
            compact
          />
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  // Layout objects are rebuilt on every manager render; compare by value so a
  // channels-list refetch that only touched OTHER channels skips this popup.
  prev.channel === next.channel &&
  prev.minimized === next.minimized &&
  prev.currentUserId === next.currentUserId &&
  prev.layout.width === next.layout.width &&
  prev.layout.rightOffset === next.layout.rightOffset &&
  prev.layout.bottomOffset === next.layout.bottomOffset &&
  prev.layout.bodyHeight === next.layout.bodyHeight &&
  prev.layout.forcedBar === next.layout.forcedBar,
);

// ─── Popup manager — renders all open popups ──────────────────────────────────

function CommsPopupSkeleton({
  channelId,
  layout,
}: {
  channelId: string;
  layout: PopupLayout;
}) {
  const closePopup = useCommsSelector((s) => s.closePopup);

  return (
    <div
      // h-10 = POPUP_TITLE_HEIGHT (40px) — keep in lockstep with the layout
      // constants above. Position/width are continuous — they stay inline.
      className="fixed z-40 flex h-10 flex-col bg-background border border-border rounded-t-lg shadow-xl overflow-hidden"
      style={{
        right: layout.rightOffset,
        bottom: layout.bottomOffset,
        width: layout.width,
      }}
      data-testid={`comms-popup-skeleton-${channelId}`}
    >
      <div className="flex h-10 items-center gap-2 px-3 bg-primary text-primary-foreground flex-shrink-0">
        <div className="h-4 w-4 rounded-full bg-white/30 animate-pulse flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="h-3 w-24 rounded bg-white/30 animate-pulse" />
        </div>
        <button
          onClick={() => closePopup(channelId)}
          className="h-6 w-6 flex items-center justify-center rounded hover:bg-white/20 text-white/80 hover:text-white flex-shrink-0"
          data-testid={`popup-close-${channelId}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ─── Popup manager — renders all open popups ──────────────────────────────────

export function CommsPopupManager({ currentUserId }: { currentUserId: string }) {
  // Individual slices: presence / status churn never touches these, so the
  // manager re-renders only when popups, the channel list, or rail state change.
  const channels = useCommsSelector((s) => s.channels);
  const channelsLoaded = useCommsSelector((s) => s.channelsLoaded);
  const popups = useCommsSelector((s) => s.popups);
  const archivedChannelOverrides = useCommsSelector((s) => s.archivedChannelOverrides);
  const railOpen = useCommsSelector((s) => s.railOpen);
  const { viewportWidth, viewportHeight, keyboardInset } = useViewportMetrics();
  const [location] = useLocation();

  if (popups.length === 0) return null;

  // Resolve channels up-front so layout can account for unresolved (skeleton)
  // entries. Active channels first; fall back to archived overrides so members
  // can browse history in archived channels opened from the rail.
  const resolved = popups.map((popup) => ({
    popup,
    channel:
      channels.find((c) => c.id === popup.channelId) ??
      archivedChannelOverrides[popup.channelId] ??
      null,
  }));

  const newest = resolved[resolved.length - 1];
  // A skeleton (unresolved channel) renders title-bar height only.
  const newestExpanded = !!newest.channel && !newest.popup.minimized;

  // On the full /comms page the rail is hidden so popups sit at the right edge.
  const onCommsPage = location.startsWith("/comms");
  const layouts = computePopupLayouts({
    viewportWidth,
    onCommsPage,
    railOpen,
    totalPopups: popups.length,
    newestExpanded,
    viewportHeight,
    keyboardInset,
  });

  return (
    <>
      {resolved.map(({ popup, channel }, index) => {
        if (!channel) {
          // Channel list still hydrating — show a loading skeleton so the
          // popup survives navigation; once loaded, the context prunes
          // entries whose channel truly no longer exists.
          if (channelsLoaded) return null;
          return (
            <CommsPopupSkeleton
              key={popup.channelId}
              channelId={popup.channelId}
              layout={layouts[index]}
            />
          );
        }
        return (
          <CommsPopup
            key={popup.channelId}
            channel={channel}
            minimized={popup.minimized}
            layout={layouts[index]}
            currentUserId={currentUserId}
          />
        );
      })}
    </>
  );
}
