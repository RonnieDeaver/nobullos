/**
 * NoBull Comms page — channel header.
 * Extracted verbatim from client/src/pages/Comms.tsx (Task #3787 split).
 * ChannelIcon, header status colors, and the exported ChannelHeader.
 */

import { useCommsContext } from "@/contexts/CommsContext";
import { channelDisplayName } from "@/components/comms/helpers";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Hash, Lock, Menu, MessageSquare, Phone, PhoneOff, Video, Settings, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { type CommsChannel } from "./pageTypes";

// ─── Channel name display ────────────────────────────────────────────────────

export function ChannelIcon({ ch }: { ch: CommsChannel }) {
  if (ch.type === "dm" || ch.type === "group_dm") {
    return <MessageSquare className="h-4 w-4 flex-shrink-0" />;
  }
  if (ch.visibility === "private") {
    return <Lock className="h-4 w-4 flex-shrink-0" />;
  }
  return <Hash className="h-4 w-4 flex-shrink-0" />;
}

// ─── Channel header ───────────────────────────────────────────────────────────

const HEADER_STATUS_COLORS: Record<string, string> = {
  online: "bg-green-400",
  away: "bg-yellow-400",
  dnd: "bg-red-400",
  offline: "bg-slate-300",
};

export function ChannelHeader({
  channel,
  onStartCall,
  onJoinCall,
  onEndCall,
  callActive,
  callType,
  callsConfigured,
  onOpenSettings,
  onOpenSidebar,
  currentUserId,
}: {
  channel: CommsChannel;
  onStartCall: (type: "voice" | "video") => void;
  onJoinCall: () => void;
  onEndCall: () => void;
  callActive: boolean;
  callType?: "voice" | "video";
  callsConfigured: boolean;
  onOpenSettings: () => void;
  onOpenSidebar?: () => void;
  currentUserId?: string;
}) {
  const { userStatuses } = useCommsContext();
  const name = channelDisplayName(channel);

  // For DM channels show the other member's effective status dot.
  const otherMemberIds =
    (channel.type === "dm" || channel.type === "group_dm") && channel.members && currentUserId
      ? channel.members.filter((m) => m.userId !== currentUserId).map((m) => m.userId)
      : [];
  const otherMemberId = channel.type === "dm" ? otherMemberIds[0] ?? null : null;
  const otherMemberEntry = otherMemberId ? userStatuses.get(otherMemberId) : null;
  // Match group-DM behavior: an unknown status renders as offline rather than hiding the dot.
  const headerStatus = otherMemberId ? otherMemberEntry?.effectiveStatus ?? "offline" : null;
  const otherCustomEmoji = otherMemberEntry?.customEmoji ?? null;
  const otherCustomText = otherMemberEntry?.customText ?? null;
  // Group DMs: one dot per other participant (capped to keep the header compact).
  // Pair each dot with the participant's name (from dmParticipants) so the
  // hover tooltip reads "Jane Doe — Online" instead of just the status.
  const participantNameById = new Map(
    (channel.dmParticipants ?? []).map((p) => [p.userId, p.name]),
  );
  const allGroupStatuses =
    channel.type === "group_dm"
      ? otherMemberIds.map((id) => ({
          userId: id,
          name: participantNameById.get(id) ?? null,
          status: userStatuses.get(id)?.effectiveStatus ?? "offline",
        }))
      : [];
  const groupStatuses = allGroupStatuses.slice(0, 5);
  // Participants beyond the first 5 dots surface via a "+N" chip whose hover
  // tooltip lists each remaining participant's name and status.
  const overflowStatuses = allGroupStatuses.slice(5);

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background">
      <div className="flex items-center gap-2 min-w-0">
        {onOpenSidebar && (
          <button
            onClick={onOpenSidebar}
            className="md:hidden h-8 w-8 flex items-center justify-center rounded border border-border bg-background hover:bg-muted text-foreground flex-shrink-0"
            aria-label="Open sidebar"
            data-testid="button-open-sidebar-header"
          >
            <Menu className="h-4 w-4" />
          </button>
        )}
        <ChannelIcon ch={channel} />
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-1.5">
            {headerStatus && (
              <span
                className={cn("h-2.5 w-2.5 rounded-full flex-shrink-0", HEADER_STATUS_COLORS[headerStatus] ?? "bg-slate-300")}
                title={headerStatus === "dnd" ? "Do not disturb" : headerStatus.charAt(0).toUpperCase() + headerStatus.slice(1)}
                data-testid="channel-header-other-status"
              />
            )}
            {groupStatuses.length > 0 && (
              <span className="flex items-center gap-0.5 flex-shrink-0" data-testid="channel-header-group-statuses">
                {groupStatuses.map((s) => {
                  const statusLabel = s.status === "dnd" ? "Do not disturb" : s.status.charAt(0).toUpperCase() + s.status.slice(1);
                  return (
                    <span
                      key={s.userId}
                      className={cn("h-2 w-2 rounded-full", HEADER_STATUS_COLORS[s.status] ?? "bg-slate-300")}
                      title={s.name ? `${s.name} — ${statusLabel}` : statusLabel}
                      data-testid={`channel-header-group-status-${s.userId}`}
                    />
                  );
                })}
                {overflowStatuses.length > 0 && (
                  <span
                    className="h-4 min-w-4 px-1 flex items-center justify-center rounded-full bg-muted text-muted-foreground text-caption font-semibold leading-none cursor-default"
                    title={overflowStatuses
                      .map((s) => {
                        const statusLabel = s.status === "dnd" ? "Do not disturb" : s.status.charAt(0).toUpperCase() + s.status.slice(1);
                        return s.name ? `${s.name} — ${statusLabel}` : statusLabel;
                      })
                      .join("\n")}
                    data-testid="channel-header-group-status-overflow"
                  >
                    +{overflowStatuses.length}
                  </span>
                )}
              </span>
            )}
            <h2 className="font-semibold text-foreground truncate">{name}</h2>
          </div>
          {otherCustomText && (
            <span className="text-xs text-muted-foreground truncate" data-testid="channel-header-other-custom-status">
              {otherCustomEmoji ? `${otherCustomEmoji} ${otherCustomText}` : otherCustomText}
            </span>
          )}
        </div>
        {channel.topic && (
          <>
            <Separator orientation="vertical" className="h-4 hidden md:block" />
            <span className="text-sm text-muted-foreground truncate hidden md:inline">{channel.topic}</span>
          </>
        )}
      </div>
      <div className="md:hidden flex items-center flex-shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              aria-label="More actions"
              data-testid="channel-header-overflow-button"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid="channel-header-overflow-menu">
            {callActive ? (
              <>
                <DropdownMenuItem onClick={onJoinCall} data-testid="overflow-join-call">
                  {callType === "video" ? <Video className="h-4 w-4 mr-2" /> : <Phone className="h-4 w-4 mr-2" />}
                  Join {callType === "video" ? "video" : "voice"} call
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={onEndCall}
                  className="text-destructive focus:text-destructive"
                  data-testid="overflow-end-call"
                >
                  <PhoneOff className="h-4 w-4 mr-2" />
                  End call for everyone
                </DropdownMenuItem>
              </>
            ) : callsConfigured ? (
              <>
                <DropdownMenuItem onClick={() => onStartCall("voice")} data-testid="overflow-start-voice-call">
                  <Phone className="h-4 w-4 mr-2" />
                  Start voice call
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onStartCall("video")} data-testid="overflow-start-video-call">
                  <Video className="h-4 w-4 mr-2" />
                  Start video call
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem disabled data-testid="overflow-calls-not-configured">
                <Phone className="h-4 w-4 mr-2" />
                Calls not configured
              </DropdownMenuItem>
            )}
            {channel.type === "channel" && (
              <DropdownMenuItem onClick={onOpenSettings} data-testid="overflow-channel-settings">
                <Settings className="h-4 w-4 mr-2" />
                Channel settings
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="hidden md:flex items-center gap-1 flex-shrink-0">
        {callActive ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={onJoinCall}
              className="h-8 gap-1.5 bg-green-100 dark:bg-green-950/35 text-green-700 dark:text-green-300 hover:bg-green-200"
              data-testid="join-call-button"
            >
              {callType === "video" ? <Video className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
              <span className="text-xs font-medium">Join {callType === "video" ? "video" : "voice"} call</span>
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onEndCall}
                  className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                  data-testid="end-call-header-button"
                >
                  <PhoneOff className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>End call for everyone</TooltipContent>
            </Tooltip>
          </>
        ) : callsConfigured ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onStartCall("voice")}
                  className="h-8 w-8 p-0"
                  aria-label="Start voice call"
                  data-testid="start-voice-call-button"
                >
                  <Phone className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Start voice call</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onStartCall("video")}
                  className="h-8 w-8 p-0"
                  aria-label="Start video call"
                  data-testid="start-video-call-button"
                >
                  <Video className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Start video call</TooltipContent>
            </Tooltip>
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 opacity-40 cursor-not-allowed" disabled data-testid="calls-not-configured-button">
                <Phone className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Calls not configured</TooltipContent>
          </Tooltip>
        )}
        {channel.type === "channel" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenSettings}
                className="h-8 w-8 p-0"
                aria-label="Channel settings"
                data-testid="channel-settings-button"
              >
                <Settings className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Channel settings</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
