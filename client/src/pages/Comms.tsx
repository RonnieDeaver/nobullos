/**
 * NoBull Comms — the /comms page.
 *
 * Task #3787: the page's inline sections (call UI, channel header, dialogs,
 * sidebar, SSE hook, shared types) are extracted into components under
 * client/src/components/comms/; this file keeps the main page component and
 * re-exports the components that tests import from this path. Props/state
 * flow is unchanged — extraction was verbatim.
 */

import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { useCommsContext } from "@/contexts/CommsContext";
import { channelDisplayName } from "@/components/comms/helpers";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Archive, Hash, Menu, MessageSquare, Phone, X, Smile, Users, FileText, Clock, Bell } from "lucide-react";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { ChannelInfoSheet } from "@/components/comms/ChannelInfoSheet";
import { DraftsView } from "@/components/comms/DraftsView";
import { ScheduledMessagesPanel, AllScheduledMessagesPanel } from "@/components/comms/ScheduledMessagesPanel";
import { ThreadsView } from "@/components/comms/ThreadsView";
import { SearchPanel } from "@/components/comms/SearchPanel";
import { CustomEmojiManager } from "@/components/comms/CustomEmojiManager";
import { requestNotificationPermission } from "@/components/comms/useDesktopNotifications";
import { MessagePane } from "@/components/comms/MessagePane";
import { Composer } from "@/components/comms/Composer";
import { type ActiveCallRoom, type IncomingCallInfo, type CommsChannel } from "@/components/comms/pageTypes";
import { ChannelHeader } from "@/components/comms/ChannelHeader";
import { ChannelSettingsDialog } from "@/components/comms/ChannelSettingsDialog";
import { CreateChannelDialog } from "@/components/comms/CreateChannelDialog";
import { BrowseChannelsDialog } from "@/components/comms/BrowseChannelsDialog";
import { NewDmDialog } from "@/components/comms/NewDmDialog";
import { CallView, IncomingCallBanner } from "@/components/comms/CallUI";
import { CommsView, CommsSidebar } from "@/components/comms/CommsSidebar";

// ─── Main Comms page ──────────────────────────────────────────────────────────

// Task #4373 (audit §8.4-b): the Conversation Hub (client SMS/calls over
// Twilio) converged into /comms as its "clients" view. Loaded lazily so the
// Twilio SDK stays in the hub's own chunk (bundle-guard: the comms route
// chunk carries livekit only).
const ConversationHubView = lazyWithRetry(() => import("@/pages/ConversationHub"));

// Valid ?view= deep-link values — CommsSidebar renders a nav entry for each.
const VALID_VIEWS: CommsView[] = ["channel", "drafts", "scheduled", "threads", "search", "emoji", "clients"];

export default function Comms() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const search = useSearch();
  const channelFromUrl = new URLSearchParams(search).get("channel");
  const viewFromUrl = new URLSearchParams(search).get("view") as CommsView | null;
  const { addSseListener, updateNotificationSettings } = useCommsContext();
  const qc = useQueryClient();
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(channelFromUrl);
  const [selectedView, setSelectedView] = useState<CommsView>(
    viewFromUrl && VALID_VIEWS.includes(viewFromUrl) ? viewFromUrl : "channel",
  );
  // Task #4373: the clients view stays mounted after first visit (hidden via
  // CSS) so an active Twilio browser call / SSE stream survives view switches.
  const [clientsViewMounted, setClientsViewMounted] = useState(selectedView === "clients");
  useEffect(() => {
    if (selectedView === "clients") setClientsViewMounted(true);
  }, [selectedView]);
  // Sync URL → view so in-app navigations to /comms?view=… (e.g. a client
  // profile "Text" quick action fired while already on /comms) switch views.
  useEffect(() => {
    if (viewFromUrl && VALID_VIEWS.includes(viewFromUrl)) setSelectedView(viewFromUrl);
  }, [viewFromUrl]);
  const openClientsView = useCallback(() => setSelectedView("clients"), []);
  const pageUserRole = (user as any)?.dbUser?.role ?? "";
  const canManageEmoji = pageUserRole === "team_lead" || pageUserRole === "ceo";
  // Non-managers who deep-link to ?view=emoji fall back to the channel view
  // (role arrives async, so wait until it's known before deciding).
  useEffect(() => {
    if (selectedView === "emoji" && pageUserRole && !canManageEmoji) {
      setSelectedView("channel");
    }
  }, [selectedView, pageUserRole, canManageEmoji]);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [showBrowse, setShowBrowse] = useState(false);
  const [showNewDm, setShowNewDm] = useState(false);
  const [showChannelSettings, setShowChannelSettings] = useState(false);
  const [showChannelInfo, setShowChannelInfo] = useState(false);
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const [activeCallRoom, setActiveCallRoom] = useState<ActiveCallRoom | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);
  const [callsConfigured, setCallsConfigured] = useState(true);
  const { toast } = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const currentUserId = (user as any)?.id ?? "";

  const urlParams = new URLSearchParams(search);
  const autoStartCallType = urlParams.get("autoStartCall") as "voice" | "video" | null;
  const joinCallId = urlParams.get("joinCall");
  // Room context passed by CommsPopupManager so enterCall() never needs a stale channel cache.
  const joinRoomFromUrl = urlParams.get("joinRoom") ?? "";
  const joinCallTypeFromUrl = urlParams.get("joinCallType") as "voice" | "video" | null;
  // Permalink target message id (?message=<id>) — jump-to-message on open.
  const messageFromUrl = urlParams.get("message");

  // Refs so SSE handler always reads current values without stale closure
  const channelsRef = useRef<CommsChannel[]>([]);
  const selectedChannelIdRef = useRef<string | null>(null);
  const activeCallRoomRef = useRef<ActiveCallRoom | null>(null);
  // Tracks the last handled autoStart key ("start:<type>:<channelId>" or "join:<callId>:<channelId>")
  // so each unique ?autoStartCall / ?joinCall navigation fires once but a new param fires again.
  const autoStartFiredRef = useRef<string | null>(null);

  // Fetch my channels
  const { data: channels = [], refetch: refetchChannels } = useQuery<CommsChannel[]>({
    queryKey: ["/api/comms/channels"],
    queryFn: () => apiRequest("GET", "/api/comms/channels").then((r) => r.json()),
    refetchInterval: false,
    staleTime: 30000,
  });

  // Fetch presence
  const { data: presenceData } = useQuery<{ onlineUserIds: string[] }>({
    queryKey: ["/api/comms/presence"],
    queryFn: () => apiRequest("GET", "/api/comms/presence").then((r) => r.json()),
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (presenceData?.onlineUserIds) setOnlineUserIds(presenceData.onlineUserIds);
  }, [presenceData]);

  // Keep refs in sync so SSE handler always sees current values
  useEffect(() => { channelsRef.current = channels; }, [channels]);
  useEffect(() => { selectedChannelIdRef.current = selectedChannelId; }, [selectedChannelId]);
  useEffect(() => { activeCallRoomRef.current = activeCallRoom; }, [activeCallRoom]);

  // Auto-select first channel on load
  useEffect(() => {
    if (!selectedChannelId && channels.length > 0) {
      setSelectedChannelId(channels[0].id);
    }
  }, [channels, selectedChannelId]);

  // ── First-visit desktop-notification permission prompt ─────────────────────
  // Shown once when browser permission is still "default" and the user hasn't
  // dismissed the prompt before. Enabling requests permission (user gesture)
  // and turns on desktopEnabled in comms notification settings.
  // Task #4350 (audit P0-3): rendered as a compact inline strip at the top of
  // the page column (never a floating overlay), so it cannot cover the nav or
  // the composer on any breakpoint; dismissal persists via localStorage.
  const NOTIF_PROMPT_DISMISSED_KEY = "comms-notif-prompt-dismissed";
  const [showNotifPrompt, setShowNotifPrompt] = useState(false);
  useEffect(() => {
    try {
      if (
        typeof window !== "undefined" &&
        "Notification" in window &&
        Notification.permission === "default" &&
        localStorage.getItem(NOTIF_PROMPT_DISMISSED_KEY) !== "1"
      ) {
        setShowNotifPrompt(true);
      }
    } catch {
      /* best-effort */
    }
  }, []);

  const dismissNotifPrompt = useCallback(() => {
    try { localStorage.setItem(NOTIF_PROMPT_DISMISSED_KEY, "1"); } catch {}
    setShowNotifPrompt(false);
  }, []);

  const enableNotifPrompt = useCallback(async () => {
    try { localStorage.setItem(NOTIF_PROMPT_DISMISSED_KEY, "1"); } catch {}
    setShowNotifPrompt(false);
    try {
      const result = await requestNotificationPermission();
      if (result === "granted") {
        await updateNotificationSettings({ desktopEnabled: true });
        toast({
          title: "Desktop notifications enabled",
          description: "You'll be notified about new messages even when this tab is in the background.",
        });
      } else if (result === "denied") {
        toast({
          title: "Notifications blocked",
          description: "Your browser blocked notifications. You can re-enable them in your browser's site settings.",
        });
      }
    } catch {
      /* best-effort */
    }
  }, [updateNotificationSettings, toast]);

  // Sync URL → selection: when ?channel changes while already mounted
  // (e.g. clicking a desktop notification while on /comms), switch to it.
  useEffect(() => {
    if (channelFromUrl && channelFromUrl !== selectedChannelIdRef.current) {
      setSelectedChannelId(channelFromUrl);
      setSelectedView("channel");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelFromUrl]);

  const selectedChannel = channels.find((c) => c.id === selectedChannelId) ?? null;

  // SSE handler — reads via refs to avoid stale closure
  const handleSSE = useCallback(
    (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        switch (data.type) {
          case "comms:message":
          case "comms:message_edit":
          case "comms:message_delete":
            void qc.invalidateQueries({
              queryKey: [`/api/comms/channels/${data.channelId}/messages`],
            }); // fire-and-forget: cache refresh only
            void qc.invalidateQueries({ queryKey: ["/api/comms/channels"] }); // fire-and-forget: cache refresh only
            break;
          case "comms:reaction":
            void qc.invalidateQueries({
              queryKey: [`/api/comms/channels/${data.channelId}/messages`],
            }); // fire-and-forget: cache refresh only
            break;
          case "comms:presence":
            setOnlineUserIds((prev) => {
              if (data.online) {
                return prev.includes(data.userId) ? prev : [...prev, data.userId];
              } else {
                return prev.filter((id) => id !== data.userId);
              }
            });
            break;
          case "comms:typing":
            setTypingUsers((prev) => {
              const next = new Map(prev);
              if (data.isTyping) {
                next.set(`${data.channelId}:${data.userId}`, data.userId);
              } else {
                next.delete(`${data.channelId}:${data.userId}`);
              }
              return next;
            });
            break;
          case "comms:call": {
            void qc.invalidateQueries({ queryKey: ["/api/comms/channels"] }); // fire-and-forget: cache refresh only
            const curChannels = channelsRef.current;
            const curSelectedId = selectedChannelIdRef.current;
            const curActiveRoom = activeCallRoomRef.current;
            if (data.status === "started" && data.channelId !== curSelectedId) {
              const ch = curChannels.find((c: CommsChannel) => c.id === data.channelId);
              const chName = ch?.name ?? data.channelName ?? "channel";
              setIncomingCall({
                channelId: data.channelId,
                callId: data.callId,
                channelName: chName,
                callType: data.callType ?? "voice",
                livekitRoomName: data.livekitRoomName ?? "",
                recordingStatus: data.recordingStatus,
              });
            }
            if (data.status === "ended" && curActiveRoom?.callId === data.callId) {
              setActiveCallRoom(null);
            }
            break;
          }
        }
      } catch {
        /* ignore parse errors */
      }
    },
    [qc],
  );

  // Share the SSE connection owned by CommsContext; subscribe for typing + call events
  useEffect(() => addSseListener(handleSSE), [addSseListener, handleSSE]);

  // Fetch a LiveKit token and enter the call view
  const enterCall = useCallback(async (callId: string, roomName: string, callType: "voice" | "video", channelName: string, recordingEnabled?: boolean) => {
    try {
      // Use fetch directly so we can inspect status codes; apiRequest throws on non-2xx
      const joinResp = await fetch(`/api/comms/calls/${callId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "join" }),
        credentials: "include",
      });
      if (!joinResp.ok) {
        const joinErr = await joinResp.json().catch(() => ({}));
        toast({ title: "Could not join call", description: joinErr.error ?? 'Failed to join. Use the "End call" button in the header to stop the call.', variant: "destructive" });
        return;
      }
      const tokenResp = await fetch("/api/comms/calls/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName }),
        credentials: "include",
      });
      if (!tokenResp.ok) {
        if (tokenResp.status === 503) {
          setCallsConfigured(false);
          toast({ title: "Calls not configured", description: "LiveKit is not set up. Contact your administrator.", variant: "destructive" });
        } else {
          toast({ title: "Could not enter call", description: 'Failed to get a room token. Use the "End call" button in the channel header to stop the call.', variant: "destructive" });
        }
        return;
      }
      const { token, serverUrl } = await tokenResp.json();
      setActiveCallRoom({ callId, callType, channelName, token, serverUrl, roomName, recordingEnabled });
      setIncomingCall(null);
    } catch (e: any) {
      console.error("[Comms] Enter call error:", e?.message);
      toast({ title: "Could not enter call", description: 'A network error occurred. Use the "End call" button in the channel header to stop the call.', variant: "destructive" });
    }
  }, [toast]);

  // Start a new call
  const handleStartCall = useCallback(async (callType: "voice" | "video") => {
    if (!selectedChannel) return;
    try {
      // Use fetch directly so we can inspect status codes; apiRequest throws on non-2xx
      const resp = await fetch(`/api/comms/channels/${selectedChannel.id}/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callType }),
        credentials: "include",
      });
      if (!resp.ok) {
        if (resp.status === 503) {
          setCallsConfigured(false);
          toast({ title: "Calls not configured", description: "LiveKit is not set up. Contact your administrator.", variant: "destructive" });
          return;
        }
        if (resp.status === 409) {
          const data = await resp.json();
          if (data.call) {
            await enterCall(
              data.call.id,
              data.call.livekitRoomName,
              data.call.callType ?? callType,
              selectedChannel.name ?? "channel",
            );
          }
          return;
        }
        const errData = await resp.json().catch(() => ({}));
        toast({ title: "Could not start call", description: errData.error ?? "An unexpected error occurred.", variant: "destructive" });
        return;
      }
      const { call, roomName } = await resp.json();
      void refetchChannels(); // fire-and-forget: background refetch only
      const recEnabled = call.recordingStatus === "pending" || call.recordingStatus === "recording";
      await enterCall(call.id, roomName, callType, selectedChannel.name ?? "channel", recEnabled);
    } catch (e: any) {
      console.error("[Comms] Start call error:", e?.message);
      toast({ title: "Could not start call", description: "A network error occurred. Please try again.", variant: "destructive" });
    }
  }, [selectedChannel, enterCall, refetchChannels, toast]);

  // Auto-start a call when navigated here from a popup with ?autoStartCall=voice|video
  // Key includes both the call type and channel id so a new popup navigation with a
  // different param fires again even within the same mounted Comms session.
  useEffect(() => {
    if (!autoStartCallType || !selectedChannel) return;
    const key = `start:${autoStartCallType}:${selectedChannel.id}`;
    if (autoStartFiredRef.current === key) return;
    autoStartFiredRef.current = key;
    void handleStartCall(autoStartCallType); // fire-and-forget: handler manages its own errors internally
  }, [autoStartCallType, selectedChannel, handleStartCall]);

  // Join a specific call by ID when navigated here from a popup with ?joinCall=<id>.
  // joinRoomFromUrl + joinCallTypeFromUrl are passed by CommsPopupManager so this
  // works even when the channel cache hasn't yet reflected the new activeCall.
  // If the URL doesn't carry room context (manual navigation), fall back to the
  // channel cache as before.
  useEffect(() => {
    if (!joinCallId || !selectedChannel) return;
    const key = `join:${joinCallId}:${selectedChannel.id}`;
    if (autoStartFiredRef.current === key) return;
    autoStartFiredRef.current = key;
    const ch = selectedChannel;
    const roomName = joinRoomFromUrl || ch.activeCall?.livekitRoomName || "";
    const callType = joinCallTypeFromUrl ?? ch.activeCall?.callType ?? "voice";
    void (async () => {
      try {
        const recEnabled =
          ch.activeCall?.recordingStatus === "pending" ||
          ch.activeCall?.recordingStatus === "recording";
        await enterCall(
          joinCallId,
          roomName,
          callType,
          ch.name ?? "channel",
          recEnabled,
        );
      } catch {
        /* best-effort — user can join manually */
      }
    })();
  }, [joinCallId, selectedChannel, joinRoomFromUrl, joinCallTypeFromUrl, enterCall]);

  // End an active call from the channel header (without joining the room first)
  const handleEndCallFromHeader = useCallback(async () => {
    if (!selectedChannel?.activeCall) return;
    try {
      const resp = await fetch(`/api/comms/calls/${selectedChannel.activeCall.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end" }),
        credentials: "include",
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        toast({ title: "Could not end call", description: errData.error ?? "An unexpected error occurred. Please try again.", variant: "destructive" });
        return;
      }
      void refetchChannels(); // fire-and-forget: background refetch only
    } catch (e: any) {
      console.error("[Comms] End call error:", e?.message);
      toast({ title: "Could not end call", description: "A network error occurred. Please try again.", variant: "destructive" });
    }
  }, [selectedChannel, refetchChannels, toast]);

  // Join an already-active call in the current channel
  const handleJoinCall = useCallback(async () => {
    if (!selectedChannel?.activeCall) return;
    const call = selectedChannel.activeCall;
    const recEnabled =
      call.recordingStatus === "pending" || call.recordingStatus === "recording";
    await enterCall(
      call.id,
      call.livekitRoomName ?? "",
      call.callType ?? "voice",
      selectedChannel.name ?? "channel",
      recEnabled,
    );
  }, [selectedChannel, enterCall]);

  // Join an incoming call (from banner) — uses livekitRoomName stored at event time,
  // so it doesn't depend on channel list having activeCall populated
  const handleJoinIncoming = useCallback(async () => {
    if (!incomingCall) return;
    const recEnabled =
      incomingCall.recordingStatus === "pending" ||
      incomingCall.recordingStatus === "recording";
    await enterCall(
      incomingCall.callId,
      incomingCall.livekitRoomName,
      incomingCall.callType,
      incomingCall.channelName,
      recEnabled,
    );
    setSelectedChannelId(incomingCall.channelId);
  }, [incomingCall, enterCall]);

  return (
    <div
      className={cn(
        // Task #4350 (audit P0-3): column shell — the notification strip sits
        // in document flow ABOVE the sidebar/pane row, so it can never overlay
        // the nav or the composer. Height = viewport minus the sticky h-14
        // GlobalAppNav band (dvh so mobile browser chrome doesn't push the
        // composer below the fold on first load).
        "flex flex-col h-[calc(100dvh-var(--nav-height))] overflow-hidden transition-[padding] duration-200",
      )}
    >
      {showNotifPrompt && (
        <div
          className="flex shrink-0 items-center gap-2 sm:gap-3 border-b border-border bg-secondary px-3 sm:px-4 py-1.5"
          data-testid="banner-notification-prompt"
        >
          <Bell className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1 truncate text-body">
            <span className="font-medium text-foreground">Don't miss new messages</span>
            <span className="hidden sm:inline text-muted-foreground">
              {" — get desktop notifications when this tab is in the background."}
            </span>
          </p>
          <Button size="sm" className="shrink-0" onClick={enableNotifPrompt} data-testid="button-enable-notifications">
            Enable
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2"
            onClick={dismissNotifPrompt}
            aria-label="Dismiss notification prompt"
            data-testid="button-dismiss-notification-prompt"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      {/* Sidebar + active pane row — fills the column below the strip. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <CommsSidebar
          channels={channels}
          selectedId={selectedChannelId}
          onSelect={(id) => {
            setSelectedChannelId(id);
            setSelectedView("channel");
          }}
          onNewChannel={() => setShowNewChannel(true)}
          onNewDm={() => setShowNewDm(true)}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          selectedView={selectedView}
          onSelectView={(view) => {
            setSelectedView(view);
            setSelectedChannelId(null);
          }}
        />

        {/* Task #4373: clients view (embedded Conversation Hub) — kept
            mounted after first visit and CSS-hidden on other views, so
            switching views never drops an active client call or the hub's
            SSE stream. Sibling of the exclusive view chain below. */}
        {clientsViewMounted && (
          <div
            className={cn(
              "flex-1 min-w-0 flex-col min-h-0 overflow-hidden",
              selectedView === "clients" ? "flex" : "hidden",
            )}
            data-testid="clients-view-pane"
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-background md:hidden">
              <button
                onClick={() => setSidebarOpen(true)}
                className="h-8 w-8 flex items-center justify-center border border-border bg-background hover:bg-muted"
                aria-label="Open sidebar"
                data-testid="button-open-sidebar-clients"
              >
                <Menu className="h-4 w-4" />
              </button>
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Client Texts & Calls</span>
            </div>
            <Suspense
              fallback={
                <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                  Loading client conversations…
                </div>
              }
            >
              <ConversationHubView onIncomingCall={openClientsView} />
            </Suspense>
          </div>
        )}
        {selectedView === "clients" ? null : selectedView === "search" ? (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden" data-testid="search-view-pane">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-background md:hidden">
              <button
                onClick={() => setSidebarOpen(true)}
                className="h-8 w-8 flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
                aria-label="Open sidebar"
                data-testid="button-open-sidebar-search"
              >
                <Menu className="h-4 w-4" />
              </button>
            </div>
            <SearchPanel
              currentUserId={currentUserId}
              channels={channels as any}
              onClose={() => setSelectedView("channel")}
              onJumpTo={(channelId, messageId) => {
                setSelectedChannelId(channelId);
                setSelectedView("channel");
                setTimeout(() => {
                  const el = document.querySelector(`[data-msg-id="${messageId}"]`);
                  if (el) el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
                }, 400);
              }}
            />
          </div>
        ) : selectedView === "threads" ? (
          <div className="flex-1 flex flex-col min-h-0 overflow-auto" data-testid="threads-view-pane">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-background md:hidden">
              <button
                onClick={() => setSidebarOpen(true)}
                className="h-8 w-8 flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
                aria-label="Open sidebar"
                data-testid="button-open-sidebar-threads"
              >
                <Menu className="h-4 w-4" />
              </button>
            </div>
            <ThreadsView />
          </div>
        ) : selectedView === "drafts" ? (
          <div className="flex-1 flex flex-col min-h-0 overflow-auto" data-testid="drafts-view-pane">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-background">
              <button
                onClick={() => setSidebarOpen(true)}
                className="md:hidden h-8 w-8 flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
                aria-label="Open sidebar"
                data-testid="button-open-sidebar-drafts"
              >
                <Menu className="h-4 w-4" />
              </button>
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="font-semibold text-sm">Drafts</span>
            </div>
            <DraftsView
              onSelectChannel={(channelId) => {
                setSelectedChannelId(channelId);
                setSelectedView("channel");
              }}
            />
          </div>
        ) : selectedView === "emoji" && canManageEmoji ? (
          <div className="flex-1 flex flex-col min-h-0 overflow-auto" data-testid="emoji-view-pane">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-background">
              <button
                onClick={() => setSidebarOpen(true)}
                className="md:hidden h-8 w-8 flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
                aria-label="Open sidebar"
                data-testid="button-open-sidebar-emoji"
              >
                <Menu className="h-4 w-4" />
              </button>
              <Smile className="h-4 w-4 text-muted-foreground" />
              <span className="font-semibold text-sm">Custom Emoji</span>
            </div>
            <div className="flex-1 overflow-auto">
              <CustomEmojiManager className="max-w-2xl mx-auto p-4 md:p-6" />
            </div>
          </div>
        ) : selectedView === "scheduled" ? (
          <div className="flex-1 flex flex-col min-h-0 overflow-auto" data-testid="scheduled-view-pane">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-background">
              <button
                onClick={() => setSidebarOpen(true)}
                className="md:hidden h-8 w-8 flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
                aria-label="Open sidebar"
                data-testid="button-open-sidebar-scheduled"
              >
                <Menu className="h-4 w-4" />
              </button>
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="font-semibold text-sm">Scheduled Messages</span>
            </div>
            <AllScheduledMessagesPanel className="flex-1" />
          </div>
        ) : selectedChannel ? (
          <div className="flex flex-1 min-w-0 flex-col">
            <ChannelHeader
              channel={selectedChannel}
              onStartCall={handleStartCall}
              onJoinCall={handleJoinCall}
              onEndCall={handleEndCallFromHeader}
              callActive={!!selectedChannel.activeCall}
              callType={selectedChannel.activeCall?.callType ?? "voice"}
              callsConfigured={callsConfigured}
              onOpenSettings={() => setShowChannelInfo((v) => !v)}
              onOpenSidebar={() => setSidebarOpen(true)}
              currentUserId={currentUserId}
            />
            <div className="flex flex-1 min-h-0">
              <div className="flex flex-col flex-1 min-w-0">
                <MessagePane
                  channel={selectedChannel}
                  currentUserId={currentUserId}
                  initialMessageId={messageFromUrl}
                  hideComposer
                  hideHeader
                />
                {!selectedChannel.archivedAt && (
                  <>
                    <ScheduledMessagesPanel channelId={selectedChannel.id} />
                    <Composer
                      channelId={selectedChannel.id}
                      placeholder={`Message ${channelDisplayName(selectedChannel)}`}
                    />
                  </>
                )}
                {selectedChannel.archivedAt && (
                  <div className="flex-shrink-0 flex items-center justify-center gap-2 px-4 py-3 border-t border-border bg-muted/30 text-xs text-muted-foreground">
                    <Archive className="h-3.5 w-3.5" />
                    This channel is archived — it is read-only.
                  </div>
                )}
              </div>

              {/* Channel info / settings side panel */}
              {showChannelInfo && selectedChannel.type === "channel" && (
                <div className="w-72 xl:w-80 flex-shrink-0 h-full overflow-hidden border-l border-border">
                  <ChannelInfoSheet
                    channel={selectedChannel as any}
                    currentUserId={currentUserId}
                    onClose={() => setShowChannelInfo(false)}
                    onChannelUpdated={() => {
                      void qc.invalidateQueries({ queryKey: [`/api/comms/channels/${selectedChannel.id}/messages`] }); // fire-and-forget: cache refresh only
                      void qc.invalidateQueries({ queryKey: [`/api/comms/channels/${selectedChannel.id}`] }); // fire-and-forget: cache refresh only
                      void refetchChannels(); // fire-and-forget: background refetch only
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center relative bg-muted/10">
            {/* Mobile: open sidebar button */}
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden absolute top-3 left-3 h-9 w-9 flex items-center justify-center rounded-md border border-border bg-background shadow-sm hover:bg-muted text-foreground"
              aria-label="Open sidebar"
              data-testid="button-open-sidebar-empty"
            >
              <Menu className="h-4 w-4" />
            </button>

            {/* Empty state card */}
            <div className="flex flex-col items-center gap-6 px-6 max-w-sm text-center">
              <div className="relative">
                <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center">
                  <MessageSquare className="h-10 w-10 text-primary/60" />
                </div>
                {channels.length > 0 && (
                  <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-primary text-primary-foreground text-caption font-semibold flex items-center justify-center">
                    {channels.length}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <h2 className="text-xl font-semibold text-foreground tracking-tight">
                  {channels.length === 0 ? "Setting up…" : "NoBull Comms"}
                </h2>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {channels.length === 0
                    ? "Loading your channels. This only takes a moment."
                    : "Pick a channel or DM from the sidebar to start the conversation."}
                </p>
              </div>

              {channels.length > 0 && (
                <div className="flex flex-col sm:flex-row gap-2 w-full justify-center">
                  <Button
                    variant="default"
                    onClick={() => setShowNewChannel(true)}
                    data-testid="empty-state-new-channel"
                    className="gap-2"
                  >
                    <Hash className="h-4 w-4" />
                    New channel
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowNewDm(true)}
                    data-testid="empty-state-new-dm"
                    className="gap-2"
                  >
                    <Users className="h-4 w-4" />
                    New message
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {selectedChannel && (
        <ChannelSettingsDialog
          channel={selectedChannel}
          open={showChannelSettings}
          onClose={() => setShowChannelSettings(false)}
        />
      )}

      <CreateChannelDialog
        open={showNewChannel}
        onClose={() => setShowNewChannel(false)}
        onCreated={(id) => {
          setShowNewChannel(false);
          void refetchChannels().then(() => setSelectedChannelId(id)); // fire-and-forget: background refetch then select
        }}
      />
      <BrowseChannelsDialog
        open={showBrowse}
        onClose={() => setShowBrowse(false)}
        onJoined={(id) => {
          setShowBrowse(false);
          void refetchChannels().then(() => setSelectedChannelId(id)); // fire-and-forget: background refetch then select
        }}
      />
      <NewDmDialog
        open={showNewDm}
        onClose={() => setShowNewDm(false)}
        currentUserId={currentUserId}
        onlineUserIds={onlineUserIds}
        onOpened={(id) => {
          setShowNewDm(false);
          void refetchChannels().then(() => setSelectedChannelId(id)); // fire-and-forget: background refetch then select
        }}
      />

      {/* Active call overlay */}
      {activeCallRoom && (
        <CallView
          callRoom={activeCallRoom}
          channelName={activeCallRoom.channelName}
          onLeave={() => setActiveCallRoom(null)}
        />
      )}

      {/* Incoming call toast */}
      {incomingCall && !activeCallRoom && (
        <IncomingCallBanner
          info={incomingCall}
          onJoin={handleJoinIncoming}
          onDismiss={() => setIncomingCall(null)}
        />
      )}
    </div>
  );
}

// ─── Re-exports (historical public surface of this page) ─────────────────────
// Tests and callers import ChannelHeader / CommsSidebar from this path.
export { ChannelHeader } from "@/components/comms/ChannelHeader";
export { CommsSidebar } from "@/components/comms/CommsSidebar";
