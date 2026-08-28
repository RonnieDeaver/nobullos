import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { nextSseReconnectState } from "@/lib/sseReconnect";
import {
  loadConversationCache,
  saveConversationCache,
  type CachedConversation,
  type CachedMessage,
} from "@/lib/conversationCache";
import {
  bumpConversationPreview,
  failOptimisticMessage,
  insertOptimisticMessage,
  isTempId,
  makeTempId,
  mergeIncrementalMessages,
  applyMessageStatusPatch,
  type MessageStatusPatch,
  removeMessageFromCache,
  replaceOptimisticMessage,
} from "@/lib/conversationOptimisticUpdates";
import {
  SEND_RETRY_BACKOFF_MS,
  isTransientErrorMessage,
  isTransientHttpStatus,
  sleep,
} from "@/lib/sendRetry";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { TwilioErrorToast } from "@/components/TwilioErrorToast";
import { BrandMark } from "@/components/kit/BrandMark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { Link, useSearch } from "wouter";
import {
  MessageSquare, Search, Send, User, Plus,
  Users, X, UserPlus, ChevronLeft, Building2, Check,
  Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed, Clock,
  PhoneCall, MoreHorizontal, MicOff, Mic,
  PhoneOff, StickyNote, Inbox, AlertCircle, ChevronRight,
  ChevronDown, Pencil, Unlink2, Voicemail,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
// Task #874: browser-based VOIP via Twilio Voice JS SDK.
import { useTwilioDevice } from "@/hooks/useTwilioDevice";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  buildUnifiedConversationList, buildConversationTimelineEvents, groupTimelineByDate,
  filterThreadsByInbox, filterThreadsByActivity, filterEventsByActivity, searchThreads,
  formatPhone, getInitials, formatCallStatus, formatCallDuration, resolveThreadKey,
  attachThreadOverlays, buildNoteTimelineEvents, groupOutboundSendEvents,
  type RawConversation, type RawMessage, type RawCall, type Participant,
  type UnifiedThread, type SmsEvent, type SmsGroupEvent, type CallEvent, type NoteEvent,
  type InboxFilter, type ActivityFilter,
  type RawThreadNote, type RawThreadAssignment, type RawThreadReadState, type ThreadStatus,
} from "@/lib/conversationModel";
// Task #880: short, human-readable label for an SMS delivery failure.
import { friendlySmsFailureReason } from "@/lib/smsErrors";
// Task #4308: pure deep-link resolution (consumer side of the
// contactHubUrl.ts producer contract) — see conversationDeepLink.ts.
import { resolveDeepLink, normalizeDeepLinkPhone, DEEP_LINK_PARAM_KEYS } from "@/lib/conversationDeepLink";
import { fabColliderRef } from "@/lib/fabCollider";
import { SmsConsentBadgeForPhone, useSmsConsentStatus } from "@/components/SmsConsentBadge";

type ClientBasic = {
  id: string;
  firmName: string;
};

// Hoisted from below so the main hub component can share the same shape
// as `ClientCard` for the Task #850 assignment dropdown.
type UserSummary = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
};

type ClientContact = {
  id: string;
  clientId: string;
  name: string;
  phones: string[] | null;
  emails: string[] | null;
  roleTitle: string | null;
  isPrimary: boolean;
};

export type ActiveCallStatus =
  | "calling"
  | "ringing"
  | "in-progress"
  | "ending"
  | "ended";

export type ActiveCallState = {
  thread: UnifiedThread;
  phone: string;
  startedAt: number;
  status: ActiveCallStatus;
  callId: string | null;
  // Task #874: which transport placed this call.
  // - "browser": placed via Twilio Voice JS SDK in the page; status/mute
  //   are driven by the device hook, end-call calls device.disconnect.
  // - "forward": legacy forward-to-cell mode; status updates come from
  //   /initiate-call response and the bar's End button hits /hangup.
  mode: "browser" | "forward";
};

// Task #851: the set of Twilio CallStatus values that mean the call has
// wrapped up. Exported so the Task #1273 regression test exercises the
// same set the production poller does (not a private copy).
//
// Twilio CallStatus reference:
//   https://www.twilio.com/docs/voice/api/call-resource#call-status-values
export const ACTIVE_CALL_TERMINAL_TWILIO_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "no-answer",
  "busy",
  "failed",
  "canceled",
]);

// Map Twilio's CallStatus vocabulary into our internal active-call enum.
// Returns null for any status we don't recognise (in which case the
// poller leaves the bar untouched and waits for the next tick).
export function mapTwilioStatusToActiveCallStatus(remote: string): ActiveCallStatus | null {
  const r = (remote || "").toLowerCase();
  if (r === "in-progress") return "in-progress";
  if (r === "ringing") return "ringing";
  if (r === "queued" || r === "initiated") return "calling";
  if (ACTIVE_CALL_TERMINAL_TWILIO_STATUSES.has(r)) return "ended";
  return null;
}

// How long the bar lingers on its final "Ended" label before being
// retired, so the user sees the terminal state flash before it
// disappears. Exported so tests can verify the value without
// hard-coding it twice.
export const ACTIVE_CALL_BAR_RETIRE_DELAY_MS = 600;

// Task #874: shape of GET /api/users/me/twilio-settings (subset we use here).
type TwilioUserSettings = {
  callerIdName: string;
  smsSignOff: string;
  callRoutingPhone: string;
  callMode: "browser" | "forward";
};

const BURGUNDY = "hsl(var(--primary))";

// Server response from POST /api/twilio/conversations/:id/messages.
// Single-recipient: returned as a flat object; multi-recipient: returned
// inside `{ results: SendResult[] }`. `messageId`/`twilioSid` are present
// on success rows; `error` is present on failure rows.
type SendResult = {
  phone: string;
  status: "sent" | "failed" | "queued" | "delivered" | string;
  messageId?: string;
  twilioSid?: string | null;
  conversationId?: string;
  error?: string;
};

// The POST /messages endpoint returns either a single SendResult (one
// recipient) or `{ results: SendResult[] }` (multi). Discriminating on
// `results` lets the caller treat the two shapes uniformly.
type SendApiResponse = SendResult | { results: SendResult[] };

function isMultiSendResponse(r: SendApiResponse): r is { results: SendResult[] } {
  return Array.isArray((r as { results?: unknown }).results);
}

export default function ConversationHub({
  onIncomingCall,
}: {
  /**
   * Task #4373 (audit §8.4-b): the hub is embedded in /comms as the
   * "clients" view (kept mounted but CSS-hidden on other views). Fired when
   * a Twilio browser call rings so the host can surface this view.
   */
  onIncomingCall?: () => void;
} = {}) {
  const { user } = useAuth();
  const { toast } = useToast();
  // Task #848: scope the persisted cache by user.role so a role change
  // (e.g., demoted from team_lead to account_manager) invalidates the
  // RBAC-sensitive snapshot. This codebase has no workspace/account on
  // the User model, so user+role+app version is the strictest namespace.
  const cacheScope = user?.role ?? undefined;
  const queryClient = useQueryClient();
  const currentUserId = user?.id || null;

  // Task #848 Phase 1: hydrate from per-user localStorage so the sidebar +
  // thread render instantly while the network refetch runs. The auth user
  // loads asynchronously, so we hydrate inside an effect (not via initial
  // useState) and also restore the last-open conversation id once the
  // cache becomes available.
  const hydratedRef = useRef(false);
  const initialCache = useMemo(
    () => (currentUserId ? loadConversationCache(currentUserId, cacheScope) : null),
    [currentUserId, cacheScope],
  );

  const [selectedKey, setSelectedKey] = useState<string | null>(
    initialCache?.selectedThreadKey ?? null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [messageInput, setMessageInput] = useState("");
  const [composing, setComposing] = useState(false);
  const [showNewCallDialer, setShowNewCallDialer] = useState(false);
  // Deep-link pre-fill state — consumed from URL params once threads load.
  const deepLinkAppliedRef = useRef(false);
  const [composeInitialPhone, setComposeInitialPhone] = useState<string | null>(null);
  const [composeInitialClientId, setComposeInitialClientId] = useState<string | null>(null);
  const [dialerInitialPhone, setDialerInitialPhone] = useState<string | null>(null);
  const [showAddParticipant, setShowAddParticipant] = useState(false);
  const [showInboxMobile, setShowInboxMobile] = useState(true);
  const [showContextMobile, setShowContextMobile] = useState(false);
  const [showNumberPicker, setShowNumberPicker] = useState<{ phones: string[]; thread: UnifiedThread } | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  // Task #874: per-user call mode + browser device. Cached for 5 minutes —
  // the user can change this from Profile and it propagates on next focus.
  const { data: twilioSettings } = useQuery<TwilioUserSettings>({
    queryKey: ["/api/users/me/twilio-settings"],
    queryFn: async () => {
      const res = await fetch("/api/users/me/twilio-settings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load Twilio user settings");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
  const callMode: "browser" | "forward" = twilioSettings?.callMode === "forward" ? "forward" : "browser";
  const device = useTwilioDevice({ enabled: callMode === "browser" });
  const [followUpPromptThreadKey, setFollowUpPromptThreadKey] = useState<string | null>(null);
  // Task #951: dialog for retroactively linking a client-less conversation to a client.
  // Task #968: same dialog also drives reassignment when an existing
  // linkage was wrong; `linkClientMode` toggles the title + button copy
  // and tells the mutation whether to send `expectedClientId`.
  const [showLinkClient, setShowLinkClient] = useState(false);
  const [linkClientMode, setLinkClientMode] = useState<"link" | "reassign">("link");
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  // Task #850: dialogs for note + assignment.
  const [noteDialog, setNoteDialog] = useState<{ open: boolean; draft: string }>({ open: false, draft: "" });
  const [assignDialog, setAssignDialog] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Task #848 Phase 1: hydrate conversations + per-conv message lists from
  // localStorage on mount so the sidebar + open thread render instantly
  // while the network refetch runs in the background.
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!currentUserId || !initialCache) return;
    if (initialCache.conversations && initialCache.conversations.length > 0) {
      queryClient.setQueryData<CachedConversation[]>(
        ["/api/twilio/conversations"],
        initialCache.conversations,
      );
    }
    if (initialCache.messagesByConvId) {
      for (const [convId, msgs] of Object.entries(initialCache.messagesByConvId)) {
        if (Array.isArray(msgs) && msgs.length > 0) {
          queryClient.setQueryData<CachedMessage[]>(
            ["/api/twilio/conversations", convId, "messages"],
            msgs,
          );
        }
      }
    }
    hydratedRef.current = true;
  }, [currentUserId, initialCache, queryClient]);

  // Task #848 Phase 4: visibility-aware polling.
  const [isVisible, setIsVisible] = useState(
    typeof document === "undefined" ? true : !document.hidden,
  );

  // Task #853: real-time inbound replies via SSE. When the push channel
  // is connected we slow polling way down (still kept as a safety net);
  // when it disconnects we fall back to the original 5s/10s cadence.
  const [pushConnected, setPushConnected] = useState(false);
  useEffect(() => {
    const onVisibility = () => {
      const visible = !document.hidden;
      setIsVisible(visible);
      if (visible) {
        // Force an immediate refetch of the conversation list when the
        // tab regains focus; per-thread message refetch is wired below.
        void queryClient.invalidateQueries({ queryKey: ["/api/twilio/conversations"] }); // fire-and-forget: cache refresh only
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [queryClient]);

  // Task #853: open the SSE channel and merge pushed inbound messages
  // straight into the React Query cache. We reuse mergeIncrementalMessages
  // so the dedupe-by-id / dedupe-by-twilioSid logic is shared with polling.
  // EventSource auto-reconnects with exponential backoff; if the
  // connection ever errors we flip back to fast polling so the user
  // never silently misses a message.
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Task #2840 — backoff on rapid failures instead of a fixed 5 s retry.
    let consecutiveFailures = 0;
    let openedAt = 0;

    const connect = () => {
      if (cancelled) return;
      openedAt = Date.now();
      es = new EventSource("/api/twilio/events", { withCredentials: true });
      es.addEventListener("ready", () => setPushConnected(true));
      // Task #882: live delivery-status updates (queued → sent →
      // delivered, or failed/undelivered) for outbound messages
      // already in the cache. mergeIncrementalMessages overwrites by
      // id / twilioSid and skips no-op patches, so this is safe to
      // race against the per-thread poll.
      // Task #1272: live forward-mode call-status push. Replaces the
      // 2s REST poll that used to drive the Active Call Bar. The server
      // scopes this event to the user who placed the call, so we know
      // it's safe to apply unconditionally. Terminal statuses retire
      // the bar (with a brief flash of "Ended" so the operator sees it)
      // and refresh the call list so the new event drops into the
      // timeline without a manual reload.
      es.addEventListener("call:status", (ev: MessageEvent) => {
        try {
          const payload = JSON.parse(ev.data) as {
            userId: string;
            call: { id: string; status: string };
          };
          const remote = (payload.call.status || "").toLowerCase();
          // Task #1273: mapping + terminal-set live at the top of this
          // file so the regression test exercises the same code paths.
          const mapped = mapTwilioStatusToActiveCallStatus(remote);
          if (!mapped) return;
          setActiveCall((prev) => {
            if (!prev || prev.mode !== "forward" || prev.callId !== payload.call.id) return prev;
            if (mapped === prev.status) return prev;
            const becameInProgress =
              mapped === "in-progress" && prev.status !== "in-progress";
            return {
              ...prev,
              status: mapped,
              startedAt: becameInProgress ? Date.now() : prev.startedAt,
            };
          });
          if (ACTIVE_CALL_TERMINAL_TWILIO_STATUSES.has(remote)) {
            setTimeout(() => {
              setActiveCall((prev) => {
                if (!prev || prev.mode !== "forward" || prev.callId !== payload.call.id) return prev;
                setFollowUpPromptThreadKey(prev.thread.key);
                return null;
              });
              void queryClient.invalidateQueries({
                queryKey: ["/api/twilio/calls", "hub-all"],
              }); // fire-and-forget: cache refresh only
            }, ACTIVE_CALL_BAR_RETIRE_DELAY_MS);
          }
        } catch (err) {
          console.error("[ConversationHub] Failed to handle pushed call status event", err);
        }
      });
      es.addEventListener("message:status", (ev: MessageEvent) => {
        try {
          const payload = JSON.parse(ev.data) as {
            conversationId: string;
            message: MessageStatusPatch;
          };
          // applyMessageStatusPatch only mutates an already-cached row;
          // if the message isn't present yet (e.g. messages fetch in
          // flight) the patch is dropped and the next fetch / poll
          // picks up the final status. Avoids inserting a partial row.
          applyMessageStatusPatch(queryClient, payload.conversationId, payload.message);
        } catch (err) {
          console.error("[ConversationHub] Failed to handle pushed status event", err);
        }
      });
      es.addEventListener("message:new", (ev: MessageEvent) => {
        try {
          const payload = JSON.parse(ev.data) as {
            conversationId: string;
            message: CachedMessage;
            conversationPreview: {
              id: string;
              lastMessageAt: string;
              lastMessagePreview: string;
              unreadCountDelta: number;
            };
          };
          // Merge into the per-thread message cache (no-op if already
          // present from a poll that raced us).
          mergeIncrementalMessages(queryClient, payload.conversationId, [payload.message]);
          // Bump conversation list ordering + preview + unread count.
          queryClient.setQueryData<RawConversation[]>(
            ["/api/twilio/conversations"],
            (prev) => {
              if (!Array.isArray(prev)) return prev;
              const idx = prev.findIndex((c) => c.id === payload.conversationPreview.id);
              if (idx === -1) {
                // Conversation isn't in the list yet (newly created by
                // this inbound). Trigger a refetch to pull it in.
                void queryClient.invalidateQueries({ queryKey: ["/api/twilio/conversations"] }); // fire-and-forget: cache refresh only
                return prev;
              }
              const cur = prev[idx];
              const updated: RawConversation = {
                ...cur,
                lastMessageAt: payload.conversationPreview.lastMessageAt,
                lastMessagePreview: payload.conversationPreview.lastMessagePreview,
                unreadCount:
                  (cur.unreadCount || 0) + (payload.conversationPreview.unreadCountDelta || 0),
              };
              return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
            },
          );
        } catch (err) {
          console.error("[ConversationHub] Failed to handle pushed event", err);
        }
      });
      es.onerror = () => {
        setPushConnected(false);
        es?.close();
        es = null;
        if (cancelled) return;
        // Reconnect via the shared policy: quick retry after a healthy
        // connection drops, exponential backoff on rapid failures.
        // Closing + retrying ourselves keeps `pushConnected` honest.
        const next = nextSseReconnectState(
          consecutiveFailures,
          Date.now() - openedAt,
        );
        consecutiveFailures = next.consecutiveFailures;
        reconnectTimer = setTimeout(connect, next.delayMs);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      setPushConnected(false);
    };
  }, [queryClient]);

  const { data: conversations = [], isSuccess: conversationsLoaded } = useQuery<RawConversation[]>({
    queryKey: ["/api/twilio/conversations"],
    queryFn: async () => {
      const res = await fetch(`/api/twilio/conversations`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch conversations");
      return res.json();
    },
    // Task #848 Phase 4: pause polling while the tab is hidden; an immediate
    // refetch happens in the visibility listener above when focus returns.
    // Task #853: when the SSE push channel is live, slow polling way down
    // (kept as a safety net) — the push listener bumps the cache directly.
    refetchInterval: isVisible ? (pushConnected ? 60000 : 10000) : false,
    // Show stale cached data instantly while we revalidate in the background.
    placeholderData: (prev) => prev,
  });

  const { data: allCalls = [] } = useQuery<RawCall[]>({
    queryKey: ["/api/twilio/calls", "hub-all"],
    queryFn: async () => {
      const res = await fetch(`/api/twilio/calls?limit=500`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: isVisible ? 15000 : false,
    placeholderData: (prev) => prev,
  });

  // Task #850: notes + assignments are loaded in bulk so every thread in
  // the inbox can show its note count + assignment chip without a per-row
  // round-trip. Polled at the same cadence as conversations.
  const { data: allNotes = [] } = useQuery<RawThreadNote[]>({
    queryKey: ["/api/twilio/threads/notes"],
    queryFn: async () => {
      const res = await fetch("/api/twilio/threads/notes", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: isVisible ? 15000 : false,
    placeholderData: (prev) => prev,
  });

  const { data: allAssignments = [] } = useQuery<RawThreadAssignment[]>({
    queryKey: ["/api/twilio/threads/assignments"],
    queryFn: async () => {
      const res = await fetch("/api/twilio/threads/assignments", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: isVisible ? 15000 : false,
    placeholderData: (prev) => prev,
  });

  // Task #1685: manual read/unread overlay. Polled at the same cadence
  // as conversations so a teammate's toggle propagates without a hard
  // refresh. Mutations below pre-write the cache so the row badge flips
  // immediately and rolls back on failure.
  const { data: allReadStates = [] } = useQuery<RawThreadReadState[]>({
    queryKey: ["/api/twilio/threads/read-states"],
    queryFn: async () => {
      const res = await fetch("/api/twilio/threads/read-states", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: isVisible ? 15000 : false,
    placeholderData: (prev) => prev,
  });

  // Task #1685: roster for the Assign dropdown now comes from the
  // dedicated `/api/twilio/threads/assignees` endpoint so the eligibility
  // contract used to validate writes on the server is the same list the
  // UI offers to pick from. `ClientCard` continues to consume the same
  // `allUsers` prop, so its display logic doesn't change.
  const { data: allUsers = [] } = useQuery<UserSummary[]>({
    queryKey: ["/api/twilio/threads/assignees"],
    queryFn: async () => {
      const res = await fetch("/api/twilio/threads/assignees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch assignees");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  // Task #1288 — unread "you were assigned to this thread" pings for the
  // current user. We render a count badge on the "Mine" chip and surface
  // a one-time toast on first load so newly-assigned threads aren't
  // missed. Polled at the same cadence as conversations so a brand-new
  // assignment from another user shows up without a hard refresh.
  type AssignmentNotification = {
    id: string;
    threadKey: string;
    userId: string;
    assignedByUserId: string | null;
    createdAt: string;
    readAt: string | null;
  };
  const { data: assignmentNotifications = [] } = useQuery<AssignmentNotification[]>({
    queryKey: ["/api/twilio/threads/assignment-notifications"],
    queryFn: async () => {
      const res = await fetch("/api/twilio/threads/assignment-notifications", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!currentUserId,
    refetchInterval: isVisible ? 15000 : false,
    placeholderData: (prev) => prev,
  });

  const markAssignmentNotificationsRead = useCallback(async (ids?: string[]) => {
    try {
      await fetch("/api/twilio/threads/assignment-notifications/mark-read", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ids ? { ids } : {}),
      });
    } catch {
      // Swallow — we'll just re-show the badge on next poll.
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/threads/assignment-notifications"] }); // fire-and-forget: cache refresh only
    }
  }, [queryClient]);

  // One-time toast when unread assignments are first observed in this
  // session. We track the seen IDs in a ref so re-renders / poll cycles
  // don't re-toast for the same notifications.
  const toastedAssignmentIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (assignmentNotifications.length === 0) return;
    const fresh = assignmentNotifications.filter((n) => !toastedAssignmentIdsRef.current.has(n.id));
    if (fresh.length === 0) return;
    fresh.forEach((n) => toastedAssignmentIdsRef.current.add(n.id));
    toast({
      title: fresh.length === 1
        ? "New thread assigned to you"
        : `${fresh.length} new threads assigned to you`,
      description: "Check the Mine filter to see them.",
    });
  }, [assignmentNotifications, toast]);

  const assignmentNotificationCount = assignmentNotifications.length;
  const assignmentNotificationKeys = useMemo(
    () => new Set(assignmentNotifications.map((n) => n.threadKey)),
    [assignmentNotifications],
  );

  const threadsAll = useMemo(
    () => attachThreadOverlays(
      buildUnifiedConversationList(conversations, allCalls, currentUserId),
      allNotes,
      allAssignments,
      allReadStates,
    ),
    [conversations, allCalls, currentUserId, allNotes, allAssignments, allReadStates],
  );

  const threadsFiltered = useMemo(() => {
    let list = threadsAll;
    list = filterThreadsByActivity(list, activityFilter);
    list = filterThreadsByInbox(list, inboxFilter, currentUserId);
    list = searchThreads(list, searchQuery);
    return list;
  }, [threadsAll, activityFilter, inboxFilter, currentUserId, searchQuery]);

  // Deep-link: consume URL params once thread data has loaded and apply the
  // intent (select a thread, open compose pre-filled, or open the call
  // dialer). Params consumed:
  //   threadKey — select thread by its unified key
  //   convId    — select thread by any of its SMS conversation ids
  //   phone     — match thread by contact phone (or pre-fill compose/dialer)
  //   contactName — display name for compose/dialer pre-fill
  //   clientId  — client to pre-select in compose (valid trigger on its own)
  //   intent    — "message" (default) | "call"
  //
  // Loading gate:
  //   Thread-matching paths (threadKey / convId / phone) need the conversations
  //   query to have resolved at least once so empty-inbox cases still fire.
  //   Client-id-only paths open compose immediately — no thread data needed.
  const searchString = useSearch();
  useEffect(() => {
    if (deepLinkAppliedRef.current) return;
    // Task #4308: all decision logic lives in the pure resolver so the
    // consumer side of the deep-link contract is testable without
    // mounting this page. Keep param handling there, not here.
    const plan = resolveDeepLink(searchString, threadsAll, conversationsLoaded);
    if (plan.kind === "wait") return;

    deepLinkAppliedRef.current = true;
    if (plan.kind === "none") return;

    // Remove deep-link params from the URL so a reload / back-nav doesn't
    // re-trigger the selection.
    const url = new URL(window.location.href);
    DEEP_LINK_PARAM_KEYS.forEach((k) => url.searchParams.delete(k));
    window.history.replaceState(null, "", url.toString());

    if (plan.kind === "consumed") {
      // Stale threadKey/convId with nothing to prefill — params stripped
      // above, no state change.
    } else if (plan.kind === "select-thread") {
      setSelectedKey(plan.threadKey);
      setComposing(false);
      setShowInboxMobile(false);
      // For call intent: open the dialer so the user can place a call from
      // the matched thread without needing to click again.
      if (plan.openDialer) setShowNewCallDialer(true);
    } else if (plan.kind === "dial") {
      setDialerInitialPhone(plan.phone);
      setShowNewCallDialer(true);
    } else {
      // compose: phone-no-match message intent, or clientId-only link.
      if (plan.phone) setComposeInitialPhone(plan.phone);
      if (plan.clientId) setComposeInitialClientId(plan.clientId);
      setComposing(true);
      setSelectedKey(null);
      setShowInboxMobile(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationsLoaded, threadsAll.length, searchString]);

  const selectedThread = useMemo(
    () => threadsAll.find((t) => t.key === selectedKey) || null,
    [threadsAll, selectedKey],
  );

  const selectedSmsConvId = selectedThread?.primarySmsConversationId || null;
  const selectedSmsConvIds = useMemo(
    () => selectedThread?.smsConversationIds || [],
    [selectedThread],
  );

  // Task #848 Phase 5: incremental polling. Inside each per-conversation
  // queryFn we read the current cache and request `?afterId=<latestRealId>`
  // so the server only returns new rows; the optimistic-send code path
  // keeps the cache hot in between polls. The merge dedupes by id and by
  // twilioSid so an optimistic temp row gets replaced by its real twin.
  const messageQueries = useQueries({
    queries: selectedSmsConvIds.map((convId) => ({
      queryKey: ["/api/twilio/conversations", convId, "messages"],
      queryFn: async (): Promise<RawMessage[]> => {
        const cached = queryClient.getQueryData<CachedMessage[]>([
          "/api/twilio/conversations",
          convId,
          "messages",
        ]);
        const latestRealId = Array.isArray(cached)
          ? cached.find((m) => !isTempId(m.id))?.id
          : undefined;
        // Task #875: also derive a separate "most recently updated"
        // watermark so the incremental poll picks up rows whose status
        // was mutated by the Twilio delivery-status callback (queued →
        // sent → delivered → failed/undelivered). Those rows have the
        // same id and createdAt as before, so an afterId-only fetch
        // would never see them. We compare by `updatedAt ?? createdAt`
        // so cache snapshots that pre-date this column still work.
        let latestUpdatedAt: string | undefined;
        if (Array.isArray(cached)) {
          for (const m of cached) {
            if (isTempId(m.id)) continue;
            const ts = m.updatedAt ?? m.createdAt;
            if (!ts) continue;
            if (!latestUpdatedAt || new Date(ts).getTime() > new Date(latestUpdatedAt).getTime()) {
              latestUpdatedAt = ts;
            }
          }
        }
        const params = new URLSearchParams();
        if (latestRealId) params.set("afterId", latestRealId);
        if (latestUpdatedAt) params.set("updatedSince", latestUpdatedAt);
        const url = params.toString()
          ? `/api/twilio/conversations/${convId}/messages?${params.toString()}`
          : `/api/twilio/conversations/${convId}/messages`;
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) return [];
        const fresh = (await res.json()) as RawMessage[];
        // First-ever load: no markers, return the full server payload.
        if (!latestRealId && !latestUpdatedAt) return fresh;
        // Incremental: merge into the existing cache. mergeIncrementalMessages
        // overwrites in-place by id (status/errorCode mutations) and
        // prepends genuinely new rows.
        mergeIncrementalMessages(queryClient, convId, fresh as CachedMessage[]);
        return (queryClient.getQueryData<RawMessage[]>([
          "/api/twilio/conversations",
          convId,
          "messages",
        ]) || cached || []) as RawMessage[];
      },
      // Task #853 / #1278: drop to a pure safety-net cadence when the
      // SSE push channel is connected. Both new inbound messages
      // (#853) and outbound delivery-status transitions (#882) are
      // pushed live, so the poll only exists to reconcile if the SSE
      // stream silently drops or a status callback is lost — 60s is
      // plenty for that, and matches the conversation-list cadence.
      refetchInterval: (isVisible ? (pushConnected ? 60000 : 5000) : false) as number | false,
      placeholderData: (prev: RawMessage[] | undefined): RawMessage[] | undefined => prev,
    })),
  });

  const messages = useMemo(() => {
    const all: RawMessage[] = [];
    for (const q of messageQueries) {
      const d = q.data as RawMessage[] | undefined;
      if (d && Array.isArray(d)) all.push(...d);
    }
    return all;
  }, [messageQueries]);

  const threadCalls = useMemo(() => {
    if (!selectedThread) return [] as RawCall[];
    const ids = new Set(selectedThread.callIds);
    return allCalls.filter((c) => ids.has(c.id));
  }, [allCalls, selectedThread]);

  // Task #850: notes for the currently-open thread are rendered inline as
  // timeline events. They're never hidden by the messages/calls activity
  // filter — operators always want to see context for the conversation
  // they're scoped to.
  const threadNotes = useMemo(() => {
    if (!selectedThread) return [] as RawThreadNote[];
    return allNotes.filter((n) => n.threadKey === selectedThread.key);
  }, [allNotes, selectedThread]);

  const timelineEvents = useMemo(() => {
    const events = buildConversationTimelineEvents(messages, threadCalls);
    const filtered = filterEventsByActivity(events, activityFilter);
    const notes = buildNoteTimelineEvents(threadNotes);
    return [...filtered, ...notes].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }, [messages, threadCalls, activityFilter, threadNotes]);

  // Task #5300: collapse a multi-recipient compose action's per-recipient
  // rows into one grouped bubble before day-bucketing so a group text send
  // renders as one logical message instead of N look-alike duplicates.
  // Kept separate from `timelineEvents` (used above for scroll/unread
  // bookkeeping keyed by the raw per-row events).
  const displayTimeline = useMemo(() => groupOutboundSendEvents(timelineEvents), [timelineEvents]);
  const groupedTimeline = useMemo(() => groupTimelineByDate(displayTimeline), [displayTimeline]);

  const markReadMutation = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/twilio/conversations/${id}/read`, { method: "POST", credentials: "include" });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/conversations"] }); // fire-and-forget: cache refresh only
    },
  });

  // Task #1685: per-thread manual read/unread toggle.
  // Optimistic write to the read-states query cache so the row badge
  // flips before the network call returns; rolls back on error. The
  // server only updates `thread_read_states`; for `read=true` we also
  // send the SMS conv ids so the existing per-conv unread_count column
  // is cleared in the same call (no extra round-trip).
  const setReadStateMutation = useMutation({
    mutationFn: async ({
      threadKey,
      read,
      smsConversationIds,
    }: {
      threadKey: string;
      read: boolean;
      smsConversationIds: string[];
    }) => {
      const res = await fetch(`/api/twilio/threads/${encodeURIComponent(threadKey)}/read-state`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read, smsConversationIds }),
      });
      if (!res.ok) throw new Error("Failed to update read state");
      return res.json() as Promise<RawThreadReadState>;
    },
    onMutate: async ({ threadKey, read, smsConversationIds }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/twilio/threads/read-states"] });
      await queryClient.cancelQueries({ queryKey: ["/api/twilio/conversations"] });
      const prevReadStates = queryClient.getQueryData<RawThreadReadState[]>(["/api/twilio/threads/read-states"]) ?? [];
      const nextReadStates = (() => {
        const idx = prevReadStates.findIndex((r) => r.threadKey === threadKey);
        const row: RawThreadReadState = {
          threadKey,
          manuallyUnread: !read,
          updatedByUserId: currentUserId,
          updatedAt: new Date().toISOString(),
        };
        if (idx === -1) return [...prevReadStates, row];
        const copy = prevReadStates.slice();
        copy[idx] = row;
        return copy;
      })();
      queryClient.setQueryData(["/api/twilio/threads/read-states"], nextReadStates);
      // Task #1685 — also pre-write `twilio_conversations.unread_count`
      // in the cache when marking read so the numeric badge / Unread
      // filter count update instantly (review finding #2). Mark-unread
      // doesn't bump the count since the badge already shows via the
      // manual flag.
      const prevConversations = queryClient.getQueryData<RawConversation[]>(["/api/twilio/conversations"]);
      if (read && prevConversations && smsConversationIds.length > 0) {
        const idSet = new Set(smsConversationIds);
        const nextConversations = prevConversations.map((c) =>
          idSet.has(c.id) ? { ...c, unreadCount: 0 } : c,
        );
        queryClient.setQueryData(["/api/twilio/conversations"], nextConversations);
      }
      return { prevReadStates, prevConversations };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevReadStates) {
        queryClient.setQueryData(["/api/twilio/threads/read-states"], ctx.prevReadStates);
      }
      if (ctx?.prevConversations) {
        queryClient.setQueryData(["/api/twilio/conversations"], ctx.prevConversations);
      }
      toast({ title: "Could not update read state", variant: "destructive" });
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/threads/read-states"] }); // fire-and-forget: cache refresh only
      if (vars.read) void queryClient.invalidateQueries({ queryKey: ["/api/twilio/conversations"] }); // fire-and-forget: cache refresh only
    },
  });

  // Task #1685: auto-mark-read on open continues to zero the SMS
  // `unread_count` column for every open conv (so a thread that has new
  // inbound SMS while flagged manually unread still clears its numeric
  // badge once read). The manual flag lives in the separate
  // `thread_read_states` row and is untouched by this path, so it
  // survives the open exactly as the spec requires ("Manual unread must
  // survive the existing auto-mark-read-on-open behavior").
  useEffect(() => {
    for (const id of selectedSmsConvIds) markReadMutation.mutate(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSmsConvIds.join(",")]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: motionSafeScrollBehavior() });
  }, [timelineEvents.length]);

  const lastScrolledRef = useRef<string | null>(null);
  const scrollTargetEventId = useMemo(() => {
    if (activityFilter !== "calls" || !selectedKey) return null;
    for (let i = timelineEvents.length - 1; i >= 0; i--) {
      const evt = timelineEvents[i];
      if (evt.kind === "call") return evt.id;
    }
    return null;
  }, [activityFilter, selectedKey, timelineEvents]);

  useEffect(() => {
    if (!scrollTargetEventId) return;
    const tag = `${selectedKey}::${scrollTargetEventId}`;
    if (lastScrolledRef.current === tag) return;
    lastScrolledRef.current = tag;
  }, [scrollTargetEventId, selectedKey]);

  // bump the sidebar preview, then reconcile to the server-confirmed
  // payload (id + twilioSid) so the next incremental poll de-dupes
  // correctly. The previous flow waited for the round-trip and a refetch
  // before showing the new message (~8s in production).
  const sendMessageMutation = useMutation({
    // Task #1275: silently auto-retry transient send failures (network
    // blip, Twilio 5xx) up to twice with short backoff before letting
    // the bubble flip to "Failed". The optimistic row stays in "sending"
    // throughout because `onMutate` ran once and `mutation.isPending`
    // stays true for the lifetime of `mutationFn`. Permanent failures
    // (Twilio numeric error code / 4xx) skip retry entirely.
    mutationFn: async (vars: { convId: string; body: string; tempId: string }): Promise<SendApiResponse> => {
      const maxAttempts = SEND_RETRY_BACKOFF_MS.length + 1;
      let lastErr: Error | null = null;
      // Task #3896 (audit B-003): ONE idempotency key per logical send,
      // shared by every retry attempt below — a re-POST after a lost
      // response (or any duplicate of this submission) reuses the same
      // durable server-side operation and can never send twice.
      const clientOperationId = crypto.randomUUID();

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const backoff = SEND_RETRY_BACKOFF_MS[attempt - 1];
        const canRetry = attempt < maxAttempts;

        let res: Response;
        try {
          res = await fetch(`/api/twilio/conversations/${vars.convId}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ body: vars.body, clientOperationId }),
          });
        } catch (e) {
          // Fetch rejects on raw network failures (DNS / dropped socket /
          // offline). Always transient — retry until we run out of tries.
          lastErr = e instanceof Error ? e : new Error(String(e));
          if (canRetry) {
            await sleep(backoff);
            continue;
          }
          throw lastErr;
        }

        if (!res.ok) {
          const err = await res.json().catch(() => ({} as { error?: string }));
          const msg = err.error || `Failed to send (HTTP ${res.status})`;
          lastErr = new Error(msg);
          if (canRetry && isTransientHttpStatus(res.status)) {
            await sleep(backoff);
            continue;
          }
          throw lastErr;
        }

        const data = (await res.json()) as SendApiResponse;

        // A 200 response can still represent a failed send: the server
        // wraps per-recipient Twilio failures into `result.error` (single
        // recipient) or `results[i].error` (multi). Auto-retry only when
        // EVERY recipient failed AND every failure looks transient — a
        // partial failure (some succeeded) would otherwise re-deliver to
        // the successful recipients.
        const results: SendResult[] = isMultiSendResponse(data) ? data.results : [data];
        const successes = results.filter(
          (r) => !!r && !r.error && (!!r.messageId || !!r.twilioSid),
        );
        const failures = results.filter((r) => !!r && !(!r.error && (!!r.messageId || !!r.twilioSid)));
        const allFailed = successes.length === 0 && failures.length > 0;
        const allTransient = allFailed && failures.every((r) => isTransientErrorMessage(r.error));

        if (allFailed && allTransient && canRetry) {
          lastErr = new Error(failures[0]?.error || "Send failed");
          await sleep(backoff);
          continue;
        }

        return data;
      }

      throw lastErr || new Error("Failed to send");
    },
    onMutate: (vars) => {
      // Clear input immediately so the textarea feels responsive.
      setMessageInput("");
      const conv = conversations.find((c) => c.id === vars.convId);
      const fromNumber = (conv as RawConversation | undefined)?.twilioPhoneNumber || "";
      const toNumber = (conv as RawConversation | undefined)?.contactPhone || "";
      const now = new Date().toISOString();
      const optimistic: CachedMessage = {
        id: vars.tempId,
        conversationId: vars.convId,
        twilioSid: null,
        direction: "outbound",
        fromNumber,
        toNumber,
        body: vars.body,
        status: "sending",
        sentByUserId: currentUserId ?? null,
        createdAt: now,
      };
      insertOptimisticMessage(queryClient, vars.convId, optimistic);
      // No search-suffix on the conversations query key in the new hub.
      bumpConversationPreview(queryClient, "", vars.convId, vars.body, now);
    },
    onSuccess: (data, vars) => {
      // Server returns either a single-recipient shape:
      //   { phone, status, messageId, twilioSid, conversationId }
      // or a multi-recipient shape:
      //   { results: [{ phone, status, messageId?, twilioSid?, error? }, ...] }
      // Task #875: a successful Twilio handoff now reports the real
      // initial Twilio status (typically "queued" or "accepted") rather
      // than the legacy hard-coded "sent". We treat presence of a
      // server-confirmed messageId/twilioSid (and absence of `error`)
      // as success so the optimistic row is reconciled regardless of
      // which Twilio in-flight enum we got back; the row will then
      // progress queued → sent → delivered as the status-callback
      // webhook updates the DB and the next poll picks it up.
      const results: SendResult[] = isMultiSendResponse(data) ? data.results : [data];
      const isSuccess = (r: SendResult | undefined): r is SendResult =>
        !!r && !r.error && (!!r.messageId || !!r.twilioSid);
      const successes = results.filter(isSuccess);
      const failures = results.filter((r): r is SendResult => !!r && !isSuccess(r));

      if (successes.length === 0) {
        // Every recipient failed — surface as failed and toast.
        failOptimisticMessage(queryClient, vars.convId, vars.tempId);
        toast({
          title: "Message not sent",
          description: <TwilioErrorToast error={failures[0]?.error || "All recipients failed"} />,
          variant: "destructive",
        });
        // Restore the composer so the user doesn't lose what they typed.
        setMessageInput(vars.body);
        return;
      }

      const first = successes[0];
      const partial = failures.length > 0;
      replaceOptimisticMessage(queryClient, vars.convId, vars.tempId, {
        id: first.messageId || vars.tempId,
        twilioSid: first.twilioSid ?? null,
        status: partial ? "partial" : ((first.status as CachedMessage["status"]) || "sent"),
      });

      if (partial) {
        const failedPhones = failures.map((f) => f.phone).filter(Boolean).join(", ");
        toast({
          title: `Sent to ${successes.length} of ${results.length}`,
          description: failedPhones ? `Failed: ${failedPhones}` : "Some recipients failed.",
          variant: "destructive",
        });
      }

      // Pull in any sibling rows the server created (groups) and refresh
      // the sidebar preview/order from the server as the source of truth.
      void queryClient.invalidateQueries({
        queryKey: ["/api/twilio/conversations", vars.convId, "messages"],
        refetchType: "active",
      }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({
        queryKey: ["/api/twilio/conversations"],
        refetchType: "active",
      }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error, vars) => {
      failOptimisticMessage(queryClient, vars.convId, vars.tempId);
      // Restore composer text so the user doesn't have to retype.
      setMessageInput(vars.body);
      toast({ title: "Failed to send message", description: <TwilioErrorToast error={err.message} />, variant: "destructive" });
    },
  });

  const createConvMutation = useMutation({
    mutationFn: async (payload: { clientId: string | null; contacts: Participant[]; body: string }) => {
      // Task #3896 (audit B-003): idempotency key for this submission — a
      // duplicate POST (double-click, replayed request) reuses the same
      // durable per-recipient operations server-side instead of re-sending.
      const clientOperationId = crypto.randomUUID();
      const res = await fetch("/api/twilio/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...payload, clientOperationId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setComposing(false);
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/conversations"] }); // fire-and-forget: cache refresh only
      toast({ title: "Message sent" });
      setTimeout(() => {
        const found = (queryClient.getQueryData(["/api/twilio/conversations"]) as RawConversation[] | undefined)
          ?.find((c) => c.id === data.conversationId);
        if (found) {
          const isGroup = found.conversationType === "group";
          const k = resolveThreadKey({
            isGroup,
            convId: found.id,
            contactId: found.clientContactId,
            clientId: found.clientId,
            phone: found.contactPhone,
          });
          setSelectedKey(k);
        }
      }, 200);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to send", description: <TwilioErrorToast error={err.message} />, variant: "destructive" });
    },
  });

  const initiateCallMutation = useMutation({
    mutationFn: async ({ to }: { to: string }) => {
      // Task #3896 (audit B-003): duplicate dial protection — same key
      // contract as the SMS sends.
      const clientOperationId = crypto.randomUUID();
      const res = await fetch("/api/twilio/initiate-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ to, clientOperationId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to initiate call");
      }
      return res.json();
    },
    onSuccess: (data: { callId: string; twilioSid: string }) => {
      // Task #851: keep the bar in "calling" until the live status poll
      // (started once `callId` is set) reports the real Twilio state.
      // Forcing "in-progress" here used to flash a false "On call" label
      // before the called party had even picked up.
      setActiveCall((prev) => (prev ? { ...prev, callId: data.callId } : prev));
      toast({ title: "Call initiated", description: "Your phone will ring; pick up to connect." });
    },
    onError: (err: Error) => {
      toast({ title: "Call failed", description: <TwilioErrorToast error={err.message} />, variant: "destructive" });
      setActiveCall(null);
    },
  });

  const hangupCallMutation = useMutation({
    mutationFn: async ({ callId }: { callId: string }) => {
      const res = await fetch(`/api/twilio/calls/${callId}/hangup`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to end call" }));
        throw new Error(err.error || "Failed to end call");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/calls", "hub-all"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't end call", description: <TwilioErrorToast error={err.message} />, variant: "destructive" });
    },
  });

  // Task #951: PATCH /api/twilio/conversations/:id/client. Optimistically
  // patch the cached conversation row so the header + inbox flip to the
  // linked state without waiting for the next list refetch. On 409 (the
  // row was just claimed by another operator linking it to a different
  // client) we surface a clear toast and refresh from the server so the UI
  // matches the truth.
  const linkClientMutation = useMutation({
    mutationFn: async ({
      convId,
      clientId,
      expectedClientId,
    }: {
      convId: string;
      clientId: string | null;
      // `undefined` → original link path (must currently be unlinked).
      // `null`/string → reassign or unlink (Task #968) keyed off the
      // last-seen client_id so two operators can't silently overwrite
      // each other.
      expectedClientId?: string | null;
    }): Promise<RawConversation> => {
      const body: Record<string, unknown> = { clientId };
      if (expectedClientId !== undefined) body.expectedClientId = expectedClientId;
      const res = await fetch(`/api/twilio/conversations/${convId}/client`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err.error || "Failed to update client") as Error & { status?: number };
        e.status = res.status;
        throw e;
      }
      return res.json();
    },
    onSuccess: (updated, vars) => {
      queryClient.setQueryData<RawConversation[]>(
        ["/api/twilio/conversations"],
        (prev) => {
          if (!Array.isArray(prev)) return prev;
          return prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c));
        },
      );
      // Link/reassign/unlink all change the unified-thread key
      // (`phone:...` ↔ `contact:...` ↔ `client-phone:...`), so the
      // currently-open thread would otherwise vanish on the next
      // render. Remap selectedKey to the new thread key when the
      // updated conversation belongs to it.
      if (selectedThread?.smsConversationIds.includes(updated.id)) {
        const newKey = resolveThreadKey({
          isGroup: updated.conversationType === "group",
          convId: updated.id,
          contactId: updated.clientContactId,
          clientId: updated.clientId,
          phone: updated.contactPhone,
        });
        if (newKey !== selectedThread.key) setSelectedKey(newKey);
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/conversations"] }); // fire-and-forget: cache refresh only
      setShowLinkClient(false);
      setShowUnlinkConfirm(false);
      const isUnlink = vars.clientId === null;
      const isReassign = !isUnlink && vars.expectedClientId !== undefined;
      toast({
        title: isUnlink ? "Unlinked" : isReassign ? "Client reassigned" : "Linked to client",
      });
    },
    onError: (err: Error & { status?: number }, vars) => {
      const isUnlink = vars.clientId === null;
      const isReassign = !isUnlink && vars.expectedClientId !== undefined;
      if (err.status === 409) {
        // Refresh so the header reflects whatever the other operator did.
        void queryClient.invalidateQueries({ queryKey: ["/api/twilio/conversations"] }); // fire-and-forget: cache refresh only
        toast({
          title: isUnlink || isReassign ? "Out of date" : "Already linked",
          description: err.message,
          variant: "destructive",
        });
        setShowLinkClient(false);
        setShowUnlinkConfirm(false);
        return;
      }
      toast({
        title: isUnlink ? "Couldn't unlink" : isReassign ? "Couldn't reassign" : "Couldn't link client",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Task #850: thread notes + assignment mutations. Both invalidate the
  // bulk caches so the inbox chip counts and assignment overlays stay in
  // sync without per-thread per-key invalidation logic.
  const createNoteMutation = useMutation({
    mutationFn: async ({ threadKey, body }: { threadKey: string; body: string }): Promise<RawThreadNote> => {
      const res = await fetch(`/api/twilio/threads/${encodeURIComponent(threadKey)}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to add note");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/threads/notes"] }); // fire-and-forget: cache refresh only
      setNoteDialog({ open: false, draft: "" });
      toast({ title: "Note added" });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't add note", description: err.message, variant: "destructive" });
    },
  });

  const deleteNoteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/twilio/threads/notes/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to delete note");
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/threads/notes"] }); // fire-and-forget: cache refresh only
      toast({ title: "Note deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't delete note", description: err.message, variant: "destructive" });
    },
  });

  const upsertAssignmentMutation = useMutation({
    mutationFn: async ({
      threadKey,
      assignedToUserId,
      status,
    }: {
      threadKey: string;
      assignedToUserId?: string | null;
      status?: ThreadStatus;
    }): Promise<RawThreadAssignment> => {
      const body: Record<string, unknown> = {};
      if (assignedToUserId !== undefined) body.assignedToUserId = assignedToUserId;
      if (status !== undefined) body.status = status;
      const res = await fetch(`/api/twilio/threads/${encodeURIComponent(threadKey)}/assignment`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update assignment");
      }
      return res.json();
    },
    // Task #1685 — optimistic update mirrors the read-state mutation:
    // pre-write the assignments cache so the header chip, the inbox-row
    // chip, and the Mine filter flip immediately; rollback + toast on
    // API failure so the user sees the real state again.
    onMutate: async ({ threadKey, assignedToUserId, status }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/twilio/threads/assignments"] });
      const prevAssignments = queryClient.getQueryData<RawThreadAssignment[]>(["/api/twilio/threads/assignments"]) ?? [];
      const existing = prevAssignments.find((a) => a.threadKey === threadKey);
      const optimistic: RawThreadAssignment = {
        threadKey,
        assignedToUserId: assignedToUserId !== undefined ? assignedToUserId : (existing?.assignedToUserId ?? null),
        status: status ?? existing?.status ?? "open",
        updatedByUserId: currentUserId,
        updatedAt: new Date().toISOString(),
      };
      const nextAssignments = existing
        ? prevAssignments.map((a) => (a.threadKey === threadKey ? optimistic : a))
        : [...prevAssignments, optimistic];
      queryClient.setQueryData(["/api/twilio/threads/assignments"], nextAssignments);
      return { prevAssignments };
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prevAssignments) {
        queryClient.setQueryData(["/api/twilio/threads/assignments"], ctx.prevAssignments);
      }
      toast({ title: "Couldn't update", description: err.message, variant: "destructive" });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/threads/assignments"] }); // fire-and-forget: cache refresh only
    },
  });

  const handleOpenAddNote = useCallback(() => {
    if (!selectedThread) return;
    setNoteDialog({ open: true, draft: "" });
  }, [selectedThread]);

  const handleSubmitNote = useCallback(() => {
    if (!selectedThread) return;
    const body = noteDialog.draft.trim();
    if (!body) return;
    createNoteMutation.mutate({ threadKey: selectedThread.key, body });
  }, [selectedThread, noteDialog.draft, createNoteMutation]);

  const handleSetThreadStatus = useCallback(
    (status: ThreadStatus) => {
      if (!selectedThread) return;
      upsertAssignmentMutation.mutate({ threadKey: selectedThread.key, status });
    },
    [selectedThread, upsertAssignmentMutation],
  );

  const handleAssignThread = useCallback(
    (userId: string | null) => {
      if (!selectedThread) return;
      upsertAssignmentMutation.mutate({ threadKey: selectedThread.key, assignedToUserId: userId });
      setAssignDialog(false);
    },
    [selectedThread, upsertAssignmentMutation],
  );

  const addParticipantMutation = useMutation({
    mutationFn: async ({ convId, participants }: { convId: string; participants: Participant[] }) => {
      const res = await fetch(`/api/twilio/conversations/${convId}/participants`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ add: participants }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/conversations"] }); // fire-and-forget: cache refresh only
      setShowAddParticipant(false);
      toast({ title: "Participant added" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add participant", description: err.message, variant: "destructive" });
    },
  });

  const handleSelectThread = useCallback((key: string) => {
    setSelectedKey(key);
    setComposing(false);
    setShowInboxMobile(false);
    setMessageInput("");
  }, []);

  // Task #854 / #880: re-send a previously-failed outbound message.
  // Uses /api/twilio/send-sms — the single-recipient send route — so a
  // retry on a group thread only re-fires the failed bubble's recipient
  // instead of blasting every participant via the conversation send
  // route (which sends to all participants). We drop the failed bubble
  // from the cache and insert an optimistic "sending" row keyed to the
  // same recipient so the UI reacts immediately.
  const retrySendMutation = useMutation({
    mutationFn: async (vars: { convId: string; to: string; body: string }) => {
      // Task #3896 (audit B-003): each human retry click is a NEW logical
      // operation (fresh key) — but any network-level duplicate of THIS
      // click reuses the same key and cannot double-send.
      const clientOperationId = crypto.randomUUID();
      const res = await fetch("/api/twilio/send-sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ to: vars.to, body: vars.body, clientOperationId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to resend");
      }
      return (await res.json()) as { phone?: string; status?: string; messageId?: string; twilioSid?: string };
    },
    onError: (err: Error) => {
      toast({ title: "Retry failed", description: <TwilioErrorToast error={err.message} />, variant: "destructive" });
    },
    onSettled: (_data, _err, vars) => {
      void queryClient.invalidateQueries({ queryKey: [`/api/twilio/conversations/${vars.convId}/messages`] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/conversations"] }); // fire-and-forget: cache refresh only
    },
  });

  const handleRetrySend = useCallback((convId: string, failedId: string, body: string, toNumber: string) => {
    if (!body.trim() || !toNumber) return;
    const conv = conversations.find((c) => c.id === convId) as RawConversation | undefined;
    const fromNumber = conv?.twilioPhoneNumber || "";
    removeMessageFromCache(queryClient, convId, failedId);
    const tempId = makeTempId();
    const now = new Date().toISOString();
    insertOptimisticMessage(queryClient, convId, {
      id: tempId,
      conversationId: convId,
      twilioSid: null,
      direction: "outbound",
      fromNumber,
      toNumber,
      body,
      status: "sending",
      sentByUserId: currentUserId ?? null,
      createdAt: now,
    });
    bumpConversationPreview(queryClient, "", convId, body, now);
    retrySendMutation.mutate({ convId, to: toNumber, body });
  }, [queryClient, retrySendMutation, conversations, currentUserId]);

  const handleSend = useCallback(() => {
    if (!selectedThread) return;
    const body = messageInput.trim();
    if (!body) return;
    if (!selectedThread.smsAvailability.available) return;
    if (selectedSmsConvId) {
      sendMessageMutation.mutate({
        convId: selectedSmsConvId,
        body,
        tempId: makeTempId(),
      });
    } else if (selectedThread.contactPhone && selectedThread.clientId) {
      createConvMutation.mutate({
        clientId: selectedThread.clientId,
        contacts: [{ phone: selectedThread.contactPhone, name: selectedThread.contactName || undefined, contactId: selectedThread.contactId || undefined }],
        body,
      });
    } else if (selectedThread.contactPhone) {
      toast({
        title: "Link a client first",
        description: "This phone number isn't tied to a client yet. Open New Message to send.",
        variant: "destructive",
      });
    }
  }, [selectedThread, messageInput, selectedSmsConvId, sendMessageMutation, createConvMutation, toast]);

  // Task #848 Phase 1: persist conversation list and the active thread key
  // to the per-user cache so the next mount can hydrate instantly.
  useEffect(() => {
    if (!currentUserId || conversations.length === 0) return;
    saveConversationCache(currentUserId, {
      conversations: conversations as CachedConversation[],
      selectedThreadKey: selectedKey,
    }, cacheScope);
  }, [currentUserId, conversations, selectedKey, cacheScope]);

  // Persist messages for every SMS conversation that backs the open
  // thread (a single-thread can fan out to multiple SMS conversation ids).
  useEffect(() => {
    if (!currentUserId || selectedSmsConvIds.length === 0) return;
    const messagesByConvId: Record<string, CachedMessage[]> = {};
    let hasAny = false;
    for (const convId of selectedSmsConvIds) {
      const list = queryClient.getQueryData<CachedMessage[]>([
        "/api/twilio/conversations",
        convId,
        "messages",
      ]);
      if (Array.isArray(list) && list.length > 0) {
        // Drop optimistic temps from the persisted snapshot — they would
        // never be reconciled across a reload.
        const persistable = list.filter((m) => !isTempId(m.id));
        if (persistable.length > 0) {
          messagesByConvId[convId] = persistable;
          hasAny = true;
        }
      }
    }
    if (!hasAny) return;
    saveConversationCache(currentUserId, { messagesByConvId }, cacheScope);
    // Re-key on the joined conv id list and on messages length so we
    // re-persist when new rows arrive on either side of a multi-conv thread.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, selectedSmsConvIds.join(","), messages.length, cacheScope, queryClient]);

  // Task #848 Phase 4: when the tab regains focus, also kick every SMS
  // conversation that backs the open thread.
  useEffect(() => {
    if (!isVisible) return;
    for (const convId of selectedSmsConvIds) {
      void queryClient.invalidateQueries({
        queryKey: ["/api/twilio/conversations", convId, "messages"],
      }); // fire-and-forget: cache refresh only
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, selectedSmsConvIds.join(","), queryClient]);

  const handleStartCall = useCallback((thread: UnifiedThread, phoneOverride?: string) => {
    if (!thread) return;
    const phones = phoneOverride ? [phoneOverride] : thread.callablePhones.filter(Boolean);
    if (phones.length === 0) {
      toast({ title: "No phone number", description: "There's no callable number for this contact.", variant: "destructive" });
      return;
    }
    if (phones.length > 1 && !phoneOverride) {
      setShowNumberPicker({ phones, thread });
      return;
    }
    const phone = phones[0];
    if (callMode === "browser") {
      // Task #874: browser-mode calls go through the Twilio Voice JS SDK.
      // The device hook owns mic permissions, audio streaming, status, and
      // mute. We only kick off the connect; the hook's status events drive
      // the ActiveCallBar, and end-call hits device.disconnect (no
      // /hangup REST round-trip needed because the call is local to this tab).
      if (device.status === "loading-token" || device.status === "registering" || device.status === "idle") {
        toast({
          title: "Browser dialer is starting",
          description: "Give it a moment to register with Twilio, then try again.",
        });
        return;
      }
      if (device.status === "error") {
        toast({
          title: "Browser dialer not ready",
          description: device.error?.message || "Open Profile to switch to forward-to-phone mode, or contact your admin.",
          variant: "destructive",
        });
        return;
      }
      setActiveCall({ thread, phone, startedAt: Date.now(), status: "calling", callId: null, mode: "browser" });
      device.connect({ to: phone }).catch(() => { /* device hook surfaces error */ });
      return;
    }
    // Forward mode: legacy server-initiated bridge.
    setActiveCall({ thread, phone, startedAt: Date.now(), status: "calling", callId: null, mode: "forward" });
    initiateCallMutation.mutate({ to: phone });
    // We intentionally depend on the stable parts of `device` we use; the
    // hook's connect/disconnect callbacks are memoized internally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initiateCallMutation, toast, callMode, device.status, device.connect, device.error?.message]);

  const handleEndActiveCall = useCallback(() => {
    if (!activeCall) return;
    const tk = activeCall.thread.key;
    if (activeCall.mode === "browser") {
      // Task #874: tear down via device hook. Twilio's call.disconnect
      // event will fire, but we proactively reset activeCall so the UI
      // doesn't strand on "On call" if the underlying media stream is slow
      // to close.
      setActiveCall((prev) => (prev ? { ...prev, status: "ending" } : prev));
      device.disconnect();
      // Brief defer so any final disconnect callback can settle before we
      // surface the follow-up prompt and refetch the call log.
      setTimeout(() => {
        setActiveCall(null);
        setFollowUpPromptThreadKey(tk);
        void queryClient.invalidateQueries({ queryKey: ["/api/twilio/calls", "hub-all"] }); // fire-and-forget: cache refresh only
      }, 250);
      return;
    }
    const cid = activeCall.callId;
    if (cid) {
      setActiveCall((prev) => (prev ? { ...prev, status: "ending" } : prev));
      hangupCallMutation.mutate(
        { callId: cid },
        {
          onSettled: () => {
            setActiveCall(null);
            setFollowUpPromptThreadKey(tk);
          },
        },
      );
    } else {
      setActiveCall(null);
      setFollowUpPromptThreadKey(tk);
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/calls", "hub-all"] }); // fire-and-forget: cache refresh only
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCall, hangupCallMutation, queryClient, device.disconnect]);

  // Task #874: reflect device status into activeCall for the active-call
  // bar's label. We translate the SDK's lifecycle into the existing
  // status enum so the UI components don't all need to learn new states.
  useEffect(() => {
    if (!activeCall || activeCall.mode !== "browser") return;
    const next: ActiveCallState["status"] | null =
      device.status === "in-call" ? "in-progress" :
      device.status === "ringing" ? "ringing" :
      device.status === "connecting" ? "calling" :
      device.status === "ending" ? "ending" :
      null;
    if (next && next !== activeCall.status) {
      // When a browser call actually connects (accept event), reset startedAt
      // so the call timer reflects "time since answered" rather than "time
      // since the call was initiated" — matching the duration that Twilio
      // ultimately reports back via the dial-status webhook.
      const becameInProgress = next === "in-progress" && activeCall.status !== "in-progress";
      setActiveCall(prev =>
        prev ? { ...prev, status: next, startedAt: becameInProgress ? Date.now() : prev.startedAt } : prev
      );
    }
    // When the SDK disconnects (status -> 'ready') after a call, retire the bar.
    if (device.status === "ready" && (activeCall.status === "in-progress" || activeCall.status === "ending")) {
      const tk = activeCall.thread.key;
      setActiveCall(null);
      setFollowUpPromptThreadKey(tk);
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/calls", "hub-all"] }); // fire-and-forget: cache refresh only
    }
    // Loud failure during an active call.
    if (device.status === "error" && activeCall) {
      toast({
        title: "Call failed",
        description: device.error?.message || "The browser call ended with an error.",
        variant: "destructive",
      });
      setActiveCall(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.status, device.error?.message]);

  // Task #1272: the forward-mode active call bar used to poll
  // `GET /api/twilio/calls/:id/status` every 2 s. That polling was
  // replaced with the `call:status` SSE push handled in the
  // EventSource setup above, which is driven directly off the Twilio
  // `/webhooks/call-status` handler. No client-side polling required.
  // The status-mapping helpers extracted at the top of this file
  // (`mapTwilioStatusToActiveCallStatus`,
  // `ACTIVE_CALL_TERMINAL_TWILIO_STATUSES`, `ACTIVE_CALL_BAR_RETIRE_DELAY_MS`)
  // are now the single source of truth for both the SSE handler and
  // the Task #1273 regression test.

  const handleFocusComposer = useCallback(() => {
    setTimeout(() => composerRef.current?.focus(), 50);
  }, []);

  const handleCallBackFromCard = useCallback((event: CallEvent) => {
    if (!selectedThread) return;
    handleStartCall(selectedThread, event.callbackPhone);
  }, [selectedThread, handleStartCall]);

  // Task #852: mark a voicemail as listened. Fires the first time the
  // operator presses play on the audio element (or the explicit
  // "Mark as listened" button). Idempotent on the server. Optimistically
  // patches the cached call row so the inbox VM badge clears
  // immediately without waiting for the next /calls poll.
  const markVoicemailListenedMutation = useMutation({
    mutationFn: async ({ callId }: { callId: string }) => {
      const res = await fetch(`/api/twilio/calls/${callId}/voicemail/listened`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to mark voicemail" }));
        throw new Error(err.error || "Failed to mark voicemail");
      }
      return res.json() as Promise<{ ok: boolean; voicemailListenedAt: string | null }>;
    },
    onMutate: async ({ callId }) => {
      const key = ["/api/twilio/calls", "hub-all"];
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<RawCall[]>(key);
      if (prev) {
        queryClient.setQueryData<RawCall[]>(
          key,
          prev.map((c) =>
            c.id === callId && !c.voicemailListenedAt
              ? { ...c, voicemailListenedAt: new Date().toISOString() }
              : c,
          ),
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/twilio/calls", "hub-all"], ctx.prev);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/calls", "hub-all"] }); // fire-and-forget: cache refresh only
    },
  });

  const handleMarkVoicemailListened = useCallback((event: CallEvent) => {
    if (!event.voicemailRecordingUrl || event.voicemailListenedAt) return;
    markVoicemailListenedMutation.mutate({ callId: event.id });
  }, [markVoicemailListenedMutation]);

  const handleTextFollowUpFromCard = useCallback(() => {
    handleFocusComposer();
  }, [handleFocusComposer]);

  // Task #877: when the Voice JS SDK device receives an inbound call, show
  // a top-of-page ring banner with caller info + accept/decline. On accept,
  // promote the call into the existing ActiveCallBar by synthesizing a
  // minimal UnifiedThread from the caller phone (we have no
  // contact/conversation context at ring time — the caller may not be in
  // the system yet). Forward-mode users won't see this banner because the
  // device hook stays disabled for them; their inbound calls still ring
  // their cell via the unchanged forward fallback.
  const handleAcceptIncoming = useCallback(() => {
    const inc = device.incomingCall;
    if (!inc) return;
    // Caller `From` may be a PSTN number ('+15551234567') or a Twilio
    // client identity ('client:<userId>') for client-to-client calls.
    const rawFrom = inc.from || "";
    const phone = rawFrom.startsWith("client:") ? rawFrom : rawFrom;
    const synthThread: UnifiedThread = {
      unheardVoicemailCount: 0,
      key: `inbound:${rawFrom || "unknown"}`,
      contactName: null,
      contactPhone: phone || null,
      contactId: null,
      clientId: null,
      clientName: null,
      isGroup: false,
      groupDisplayName: null,
      groupParticipants: [],
      smsConversationIds: [],
      primarySmsConversationId: null,
      twilioPhoneNumber: null,
      callIds: [],
      lastActivityAt: null,
      lastActivityPreview: "",
      lastActivityKind: "call",
      lastActivityDirection: "inbound",
      unreadSmsCount: 0,
      hasMissedCall: false,
      hasVoicemail: false,
      needsReply: false,
      myConversation: true,
      smsAvailability: { available: false },
      displayName: rawFrom.startsWith("client:")
        ? `Internal: ${rawFrom.slice("client:".length)}`
        : (formatPhone(phone) || phone || "Unknown caller"),
      callablePhones: phone ? [phone] : [],
      noteCount: 0,
      assignedToUserId: null,
      threadStatus: "open",
      manuallyUnread: false,
    };
    device.acceptIncoming();
    setActiveCall({
      thread: synthThread,
      phone: phone || "",
      startedAt: Date.now(),
      status: "in-progress",
      callId: null,
      mode: "browser",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.incomingCall, device.acceptIncoming]);

  const handleRejectIncoming = useCallback(() => {
    device.rejectIncoming();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.rejectIncoming]);

  // Task #4373: tell the embedding Comms page a client call is ringing so it
  // can auto-switch to this view (the pane may be mounted but hidden).
  useEffect(() => {
    if (device.incomingCall) onIncomingCall?.();
  }, [device.incomingCall, onIncomingCall]);

  // Task #2791: this early return MUST come after every hook above —
  // returning before hook declarations violates the rules of hooks and
  // hard-crashes React ("Rendered more hooks than during the previous
  // render") if `user` resolves after mount or a session expires in place.
  if (!user) return null;

  // Task #4350 (audit §3.3 P1): token canvas — same beige --background as the
  // rest of the app, replacing the off-token #FAF7F2 page fill.
  // Task #4373: fill-parent flex column (not min-h-[calc(100dvh-var(--nav-height))]) — the hub renders
  // inside the Comms shell's content pane, which owns the viewport height.
  return (
    <div className="flex-1 min-h-0 bg-background flex flex-col" data-testid="conversation-hub-root">
      <div className="max-w-[1400px] w-full mx-auto p-3 md:p-4 flex-1 min-h-0 flex flex-col">
        {device.incomingCall && (
          <IncomingCallBanner
            incoming={device.incomingCall}
            onAccept={handleAcceptIncoming}
            onReject={handleRejectIncoming}
          />
        )}
        <HubHeader
          activityFilter={activityFilter}
          setActivityFilter={setActivityFilter}
          onToggleInboxMobile={() => setShowInboxMobile((v) => !v)}
          onToggleContextMobile={() => setShowContextMobile((v) => !v)}
          showInboxMobile={showInboxMobile}
        />

        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr_320px] gap-3 md:gap-4 flex-1 min-h-0">
          <div
            className={`${showInboxMobile ? "block" : "hidden"} lg:block min-h-0`}
            data-testid="column-inbox"
          >
            <InboxColumn
              threads={threadsFiltered}
              selectedKey={selectedKey}
              onSetReadState={(threadKey, read, smsConversationIds) =>
                setReadStateMutation.mutate({ threadKey, read, smsConversationIds })
              }
              onSelect={(key) => {
                handleSelectThread(key);
                // Task #1288: clearing the badge when the user opens a
                // thread that's in their unread-assignments list. Re-
                // assigning to the same user is a server-side no-op, so
                // we only need to mark *this* notification read.
                if (assignmentNotificationKeys.has(key)) {
                  const ids = assignmentNotifications
                    .filter((n) => n.threadKey === key)
                    .map((n) => n.id);
                  if (ids.length > 0) void markAssignmentNotificationsRead(ids); // fire-and-forget: errors swallowed inside, refreshed on next poll
                }
              }}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              inboxFilter={inboxFilter}
              setInboxFilter={(f) => {
                setInboxFilter(f);
                // Task #1288: opening the "Mine" filter implies the user
                // has now seen their newly-assigned threads.
                if (f === "mine" && assignmentNotificationCount > 0) {
                  void markAssignmentNotificationsRead(); // fire-and-forget: errors swallowed inside, refreshed on next poll
                }
              }}
              onCompose={() => { setComposing(true); setSelectedKey(null); setShowInboxMobile(false); }}
              onNewCall={() => setShowNewCallDialer(true)}
              totalThreadCount={threadsAll.length}
              users={allUsers}
              mineNotificationCount={assignmentNotificationCount}
            />
          </div>

          <div
            className={`${!showInboxMobile || composing || selectedKey ? "block" : "hidden"} lg:block min-h-0`}
            data-testid="column-timeline"
          >
            {composing ? (
              <ComposeNewMessage
                onCancel={() => { setComposing(false); setComposeInitialPhone(null); setComposeInitialClientId(null); }}
                onSend={(payload) => createConvMutation.mutate(payload)}
                isPending={createConvMutation.isPending}
                initialPhone={composeInitialPhone ?? undefined}
                initialClientId={composeInitialClientId ?? undefined}
              />
            ) : selectedThread ? (
              <TimelineColumn
                thread={selectedThread}
                groups={groupedTimeline}
                messageInput={messageInput}
                setMessageInput={setMessageInput}
                onSend={handleSend}
                sendPending={sendMessageMutation.isPending || createConvMutation.isPending}
                onStartCall={() => handleStartCall(selectedThread)}
                onAddParticipant={() => setShowAddParticipant(true)}
                onBack={() => { setSelectedKey(null); setShowInboxMobile(true); }}
                onCallBack={handleCallBackFromCard}
                onTextFollowUp={handleTextFollowUpFromCard}
                onRetrySend={handleRetrySend}
                retryDisabled={retrySendMutation.isPending}
                onMarkVoicemailListened={handleMarkVoicemailListened}
                composerRef={composerRef}
                messagesEndRef={messagesEndRef}
                activeCall={activeCall && activeCall.thread.key === selectedThread.key ? activeCall : null}
                onEndActiveCall={handleEndActiveCall}
                activeCallIsMuted={device.isMuted}
                onToggleMute={device.toggleMute}
                followUpPrompt={followUpPromptThreadKey === selectedThread.key}
                onDismissFollowUp={() => setFollowUpPromptThreadKey(null)}
                onShowContextMobile={() => setShowContextMobile(true)}
                scrollTargetEventId={scrollTargetEventId}
                onLinkClient={() => {
                  setLinkClientMode("link");
                  setShowLinkClient(true);
                }}
                onChangeClient={() => {
                  setLinkClientMode("reassign");
                  setShowLinkClient(true);
                }}
                onUnlinkClient={() => setShowUnlinkConfirm(true)}
                onAddNote={handleOpenAddNote}
                onDeleteNote={(id) => deleteNoteMutation.mutate(id)}
                currentUserId={currentUserId}
                users={allUsers}
                onAssignThread={handleAssignThread}
              />
            ) : (
              <EmptyTimeline onCompose={() => setComposing(true)} />
            )}
          </div>

          <div
            className={`${showContextMobile ? "block" : "hidden"} lg:block min-h-0`}
            data-testid="column-context"
          >
            <ContextColumn
              thread={selectedThread}
              onClose={() => setShowContextMobile(false)}
              onAddParticipant={() => setShowAddParticipant(true)}
              onAddNote={handleOpenAddNote}
              onDeleteNote={(id) => deleteNoteMutation.mutate(id)}
              onAssign={() => selectedThread && setAssignDialog(true)}
              onSetStatus={handleSetThreadStatus}
              notes={threadNotes}
              users={allUsers}
              currentUserId={currentUserId}
            />
          </div>
        </div>
      </div>

      <NumberPickerDialog
        state={showNumberPicker}
        onClose={() => setShowNumberPicker(null)}
        onPick={(phone) => {
          if (showNumberPicker) {
            handleStartCall(showNumberPicker.thread, phone);
          }
          setShowNumberPicker(null);
        }}
      />

      <NewCallDialer
        open={showNewCallDialer}
        onOpenChange={(v) => { setShowNewCallDialer(v); if (!v) setDialerInitialPhone(null); }}
        threads={threadsAll}
        initialPhone={dialerInitialPhone ?? undefined}
        onPlaceCall={(phone, displayName) => {
          // Task #4308: same last-10-digit rule as the deep-link resolver.
          const phoneNorm = normalizeDeepLinkPhone(phone);
          const matches = threadsAll.filter((t) => {
            if (t.isGroup) return false;
            return normalizeDeepLinkPhone(t.contactPhone || "") === phoneNorm;
          });
          // Only auto-attach when there's a single unambiguous match; otherwise treat as unknown caller.
          const existing = matches.length === 1 ? matches[0] : undefined;
          const key = existing?.key || resolveThreadKey({ phone });
          const thread: UnifiedThread = existing || {
            key,
            contactName: displayName,
            contactPhone: phone,
            contactId: null,
            clientId: null,
            clientName: null,
            isGroup: false,
            groupDisplayName: null,
            groupParticipants: [],
            smsConversationIds: [],
            primarySmsConversationId: null,
            twilioPhoneNumber: null,
            callIds: [],
            lastActivityAt: null,
            lastActivityPreview: "",
            lastActivityKind: "call",
            lastActivityDirection: "outbound",
            unreadSmsCount: 0,
            hasMissedCall: false,
            hasVoicemail: false,
            unheardVoicemailCount: 0,
            needsReply: false,
            myConversation: false,
            smsAvailability: { available: true },
            displayName: displayName || formatPhone(phone) || phone,
            callablePhones: [phone],
            noteCount: 0,
            assignedToUserId: null,
            threadStatus: "open",
            manuallyUnread: false,
          };
          setShowNewCallDialer(false);
          if (existing) {
            setSelectedKey(existing.key);
            setShowInboxMobile(false);
          }
          handleStartCall(thread, phone);
        }}
      />

      <AddParticipantDialog
        open={showAddParticipant}
        onOpenChange={setShowAddParticipant}
        thread={selectedThread}
        onAdd={(participants) => {
          if (!selectedThread?.primarySmsConversationId) return;
          addParticipantMutation.mutate({ convId: selectedThread.primarySmsConversationId, participants });
        }}
        isPending={addParticipantMutation.isPending}
      />

      <LinkClientDialog
        open={showLinkClient}
        onOpenChange={setShowLinkClient}
        thread={selectedThread}
        mode={linkClientMode}
        onLink={(clientId) => {
          const convId = selectedThread?.primarySmsConversationId;
          if (!convId) return;
          if (linkClientMode === "reassign") {
            // Race-safety: send the client_id we last saw on the row so a
            // concurrent reassign by another operator surfaces as a 409
            // instead of overwriting their change.
            const expectedClientId = selectedThread?.clientId ?? null;
            if (clientId === expectedClientId) {
              setShowLinkClient(false);
              return;
            }
            linkClientMutation.mutate({ convId, clientId, expectedClientId });
          } else {
            linkClientMutation.mutate({ convId, clientId });
          }
        }}
        isPending={linkClientMutation.isPending}
      />

      <AlertDialog open={showUnlinkConfirm} onOpenChange={setShowUnlinkConfirm}>
        <AlertDialogContent data-testid="dialog-unlink-client-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedThread?.clientName ? (
                <>
                  This will detach the conversation from <strong>{selectedThread.clientName}</strong>.
                  Future messages from this number will go back to the unmatched inbox until they're linked again.
                </>
              ) : (
                <>This will detach the conversation from its client. Future messages from this number will go back to the unmatched inbox until they're linked again.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-unlink">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-unlink"
              onClick={(e) => {
                e.preventDefault();
                const convId = selectedThread?.primarySmsConversationId;
                if (!convId) return;
                linkClientMutation.mutate({
                  convId,
                  clientId: null,
                  expectedClientId: selectedThread?.clientId ?? null,
                });
              }}
              disabled={linkClientMutation.isPending}
            >
              {linkClientMutation.isPending ? "Unlinking…" : "Unlink"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Task #850: Add Note dialog. Cmd/Ctrl+Enter saves so operators
          working through a backlog don't have to mouse over to the
          button after every entry. */}
      <Dialog
        open={noteDialog.open}
        onOpenChange={(open) => setNoteDialog((d) => ({ ...d, open }))}
      >
        <DialogContent data-testid="dialog-add-note">
          <DialogHeader>
            <DialogTitle>Add note</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              value={noteDialog.draft}
              onChange={(e) => setNoteDialog((d) => ({ ...d, draft: e.target.value }))}
              placeholder="Write a note for this thread…"
              rows={5}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSubmitNote();
                }
              }}
              data-testid="input-note-body"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setNoteDialog({ open: false, draft: "" })}
                data-testid="button-cancel-note"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmitNote}
                disabled={!noteDialog.draft.trim() || createNoteMutation.isPending}
                className="text-white"
                style={{ background: BURGUNDY }}
                data-testid="button-save-note"
              >
                {createNoteMutation.isPending ? "Saving…" : "Save note"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Task #850: Assign-to-teammate dialog. Single-select; "Unassigned"
          clears the row. The user list is the same /api/users response
          used by ClientCard, so the cache is shared. */}
      <Dialog open={assignDialog} onOpenChange={setAssignDialog}>
        <DialogContent data-testid="dialog-assign-thread">
          <DialogHeader>
            <DialogTitle>Assign conversation</DialogTitle>
          </DialogHeader>
          <div className="space-y-1 max-h-80 overflow-y-auto">
            <button
              type="button"
              onClick={() => handleAssignThread(null)}
              className={`w-full text-left px-3 py-2 rounded text-sm hover:bg-muted/50 border ${
                selectedThread?.assignedToUserId == null ? "border-primary/40 bg-primary/5" : "border-transparent"
              }`}
              data-testid="button-assign-unassigned"
            >
              Unassigned
            </button>
            {allUsers.map((u) => {
              const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id;
              const isCurrent = selectedThread?.assignedToUserId === u.id;
              return (
                <button
                  type="button"
                  key={u.id}
                  onClick={() => handleAssignThread(u.id)}
                  className={`w-full text-left px-3 py-2 rounded text-sm hover:bg-muted/50 border ${
                    isCurrent ? "border-primary/40 bg-primary/5" : "border-transparent"
                  }`}
                  data-testid={`button-assign-user-${u.id}`}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HubHeader({
  activityFilter, setActivityFilter,
  onToggleInboxMobile, onToggleContextMobile, showInboxMobile,
}: {
  activityFilter: ActivityFilter;
  setActivityFilter: (f: ActivityFilter) => void;
  onToggleInboxMobile: () => void;
  onToggleContextMobile: () => void;
  showInboxMobile: boolean;
}) {
  return (
    <div className="flex items-center gap-3 mb-3 md:mb-4 flex-wrap">
      {/* Task #4373: Back button + page title removed — the Comms shell owns
          page chrome now (sidebar nav names the view); toggles/filters stay. */}
      <Button
        size="sm"
        variant="outline"
        className="lg:hidden"
        onClick={onToggleInboxMobile}
        data-testid="button-toggle-inbox-mobile"
      >
        <Inbox className="w-4 h-4 mr-1" />
        {showInboxMobile ? "Hide list" : "Conversations"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="lg:hidden"
        onClick={onToggleContextMobile}
        data-testid="button-toggle-context-mobile"
      >
        <ChevronRight className="w-4 h-4 mr-1" />
        Details
      </Button>

      <div className="flex ml-auto gap-1 bg-card rounded-lg border p-1 shadow-sm">
        {([
          { v: "all", label: "All Activity", icon: Inbox },
          { v: "messages", label: "Messages", icon: MessageSquare },
          { v: "calls", label: "Calls", icon: Phone },
        ] as const).map(({ v, label, icon: Icon }) => (
          <button
            key={v}
            onClick={() => setActivityFilter(v)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${
              activityFilter === v
                ? "text-white shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
            style={activityFilter === v ? { background: BURGUNDY } : undefined}
            data-testid={`filter-activity-${v}`}
          >
            <Icon className="w-4 h-4" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function InboxColumn({
  threads, selectedKey, onSelect,
  searchQuery, setSearchQuery,
  inboxFilter, setInboxFilter,
  onCompose, onNewCall, totalThreadCount,
  users,
  mineNotificationCount,
  onSetReadState,
}: {
  threads: UnifiedThread[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  inboxFilter: InboxFilter;
  setInboxFilter: (f: InboxFilter) => void;
  onCompose: () => void;
  onNewCall: () => void;
  totalThreadCount: number;
  users: UserSummary[];
  mineNotificationCount: number;
  // Task #1685
  onSetReadState: (threadKey: string, read: boolean, smsConversationIds: string[]) => void;
}) {
  // Task #1287: build a lookup once so InboxRow can render the
  // assignee chip with the teammate's display name in the tooltip.
  const userById = useMemo(() => {
    const m = new Map<string, UserSummary>();
    for (const u of users) m.set(u.id, u);
    return m;
  }, [users]);
  // Task #850: added Needs Follow-Up + Resolved chips. "All" hides
  // resolved threads (see `filterThreadsByInbox`); the Resolved chip is
  // the way to surface them again.
  const chips: Array<{ v: InboxFilter; label: string }> = [
    { v: "all", label: "All" },
    { v: "unread", label: "Unread" },
    { v: "needs_reply", label: "Needs Reply" },
    { v: "missed_calls", label: "Missed Calls" },
    { v: "voicemails", label: "Voicemails" },
    { v: "mine", label: "Mine" },
    { v: "needs_follow_up", label: "Needs Follow-Up" },
    { v: "resolved", label: "Resolved" },
  ];

  return (
    <Card className="h-full flex flex-col overflow-hidden border-border/80 shadow-sm" data-testid="card-inbox">
      <CardHeader className="pb-2 flex-shrink-0 space-y-2 border-b">
        <div className="flex gap-2">
          <Button
            onClick={onCompose}
            className="flex-1 text-white"
            style={{ background: BURGUNDY }}
            data-testid="button-new-message"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            New Message
          </Button>
          <Button
            onClick={onNewCall}
            variant="outline"
            className="border-primary/30"
            style={{ color: BURGUNDY }}
            aria-label="New call"
            data-testid="button-new-call"
          >
            <PhoneCall className="w-4 h-4" />
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-muted/50 border-border"
            data-testid="input-search-conversations"
          />
        </div>
        {/* Task #4350 (audit §3.3 P2): filter chips on the token scale —
            h-8 (≥ the app's 24px WCAG 2.5.8 pointer floor), text-body size,
            token colors: active = primary fill, inactive = bordered surface
            with full-contrast foreground text on the beige canvas. */}
        <div className="flex flex-wrap gap-1.5">
          {chips.map(({ v, label }) => (
            <button
              key={v}
              onClick={() => setInboxFilter(v)}
              className={`h-8 px-3 rounded-full text-body font-medium transition-colors inline-flex items-center gap-1.5 border ${
                inboxFilter === v
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-foreground hover:bg-muted"
              }`}
              data-testid={`chip-${v}`}
            >
              {label}
              {v === "mine" && mineNotificationCount > 0 && (
                <span
                  className={`inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full text-caption font-semibold ${
                    inboxFilter === v ? "bg-primary-foreground text-primary" : "bg-primary text-primary-foreground"
                  }`}
                  data-testid="badge-mine-unread"
                >
                  {mineNotificationCount > 99 ? "99+" : mineNotificationCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto p-2 space-y-1">
        {threads.length === 0 ? (
          totalThreadCount === 0 ? (
            <EmptyState
              icon={MessageSquare}
              brandMark
              title="No conversations yet"
              description="Start a new message or call to get going."
              action={{ label: "New Message", onClick: onCompose }}
              testId="empty-inbox-all"
            />
          ) : (
            <EmptyState
              icon={Search}
              title="No matches"
              description="Try a different filter or search term."
              testId="empty-inbox-filtered"
            />
          )
        ) : (
          threads.map((t) => (
            <InboxRow
              key={t.key}
              thread={t}
              selected={selectedKey === t.key}
              onClick={() => onSelect(t.key)}
              assignee={t.assignedToUserId ? userById.get(t.assignedToUserId) ?? null : null}
              onSetReadState={onSetReadState}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function InboxRow({ thread, selected, onClick, assignee, onSetReadState }: {
  thread: UnifiedThread;
  selected: boolean;
  onClick: () => void;
  assignee: UserSummary | null;
  // Task #1685
  onSetReadState: (threadKey: string, read: boolean, smsConversationIds: string[]) => void;
}) {
  // Task #1685: a thread is "unread" if either the real SMS unread_count
  // is > 0 or an operator has manually flagged it. The menu label flips
  // accordingly so a manually-unread thread offers "Mark as read".
  const isUnread = thread.unreadSmsCount > 0 || thread.manuallyUnread;
  const initials = getInitials(thread.contactName, thread.contactPhone);
  const ts = thread.lastActivityAt;
  const ActivityIcon = thread.lastActivityKind === "call"
    ? (thread.hasMissedCall ? PhoneMissed : thread.lastActivityDirection === "inbound" ? PhoneIncoming : PhoneOutgoing)
    : MessageSquare;

  // Task #1287: surface threadStatus on the row itself so operators
  // can triage Needs Follow-Up / Resolved threads without opening each
  // one. Resolved gets a green left rail + muted text, follow-up gets
  // an amber rail + dot.
  const isFollowUp = thread.threadStatus === "needs_follow_up";
  const isResolved = thread.threadStatus === "resolved";
  // Task #4372 (audit P2-14): rail colors come from the status tokens the
  // shared Card accent uses, so row rails and card stripes stay in lockstep.
  const statusRail = isResolved
    ? "border-l-4 border-l-status-ok"
    : isFollowUp
      ? "border-l-4 border-l-status-warn"
      : "";

  // Task #1287: when the row is assigned but the user is missing from
  // the /api/users roster (deleted teammate, roster still loading,
  // permissions trimmed it), still show a generic chip so operators
  // know the thread is owned — just without a name.
  const hasAssignment = thread.assignedToUserId != null;
  const assigneeName = assignee
    ? [assignee.firstName, assignee.lastName].filter(Boolean).join(" ").trim() || assignee.email || "Teammate"
    : null;
  const assigneeInitials = assignee ? getInitials(assigneeName, assignee.email) : "";

  return (
    // Task #1685: switched from a `<button>` to a `<div role="button">`
    // so the row can host a nested DropdownMenu trigger (button-in-
    // button is invalid HTML). Keyboard activation still maps to Enter /
    // Space for parity with the prior implementation.
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={`group relative w-full text-left p-2.5 rounded-lg transition-all border cursor-pointer ${statusRail} ${
        selected
          ? "bg-primary/8 border-primary/25 shadow-sm"
          : "border-transparent hover:bg-muted/50"
      } ${isResolved ? "opacity-70" : ""}`}
      data-testid={`row-thread-${thread.key}`}
    >
      <div className="flex gap-2.5">
        <Avatar initials={initials} group={thread.isGroup} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <ActivityIcon
              className={`w-3.5 h-3.5 flex-shrink-0 ${
                thread.hasMissedCall ? "text-red-500" : "text-muted-foreground"
              }`}
            />
            <span className="font-medium text-sm truncate flex-1" data-testid={`text-thread-name-${thread.key}`}>
              {thread.displayName}
            </span>
            {isFollowUp && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span data-testid={`indicator-status-follow-up-${thread.key}`}>
                    <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>Needs Follow-Up</TooltipContent>
              </Tooltip>
            )}
            {isResolved && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span data-testid={`indicator-status-resolved-${thread.key}`}>
                    <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-400 flex-shrink-0" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>Resolved</TooltipContent>
              </Tooltip>
            )}
            {hasAssignment && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center text-white text-caption font-semibold flex-shrink-0"
                    style={{ background: BURGUNDY }}
                    data-testid={`chip-assignee-${thread.key}`}
                  >
                    {assignee ? assigneeInitials : <User className="w-2.5 h-2.5" />}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{assignee ? `Assigned to ${assigneeName}` : "Assigned"}</TooltipContent>
              </Tooltip>
            )}
            {ts && (
              <span className="text-caption text-muted-foreground flex-shrink-0">
                {formatRelativeTime(ts)}
              </span>
            )}
          </div>
          {thread.clientName && (
            <div className="flex items-center gap-1 mt-0.5">
              <Building2 className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              <span className="text-caption text-muted-foreground truncate">{thread.clientName}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 mt-0.5">
            <p className="text-xs text-muted-foreground truncate flex-1" data-testid={`text-thread-preview-${thread.key}`}>
              {thread.lastActivityPreview || "No activity"}
            </p>
            <div className="flex items-center gap-1 flex-shrink-0">
              {thread.noteCount > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="text-caption px-1 py-0 gap-0.5 flex items-center text-muted-foreground border-border"
                      data-testid={`badge-notes-${thread.key}`}
                    >
                      <StickyNote className="w-2.5 h-2.5" />
                      {thread.noteCount}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{thread.noteCount} note{thread.noteCount === 1 ? "" : "s"}</TooltipContent>
                </Tooltip>
              )}
              {thread.unheardVoicemailCount > 0 && (
                <Badge
                  className="text-white text-caption px-1 py-0 gap-0.5 flex items-center"
                  style={{ background: BURGUNDY }}
                  data-testid={`badge-voicemail-${thread.key}`}
                >
                  <Voicemail className="w-2.5 h-2.5" />
                  VM {thread.unheardVoicemailCount}
                </Badge>
              )}
              {thread.hasMissedCall && !thread.unreadSmsCount && thread.unheardVoicemailCount === 0 && (
                <Badge variant="destructive" className="text-caption px-1 py-0" data-testid={`badge-missed-${thread.key}`}>Missed</Badge>
              )}
              {thread.unreadSmsCount > 0 && (
                <Badge className="text-white text-caption px-1.5 py-0" style={{ background: BURGUNDY }} data-testid={`badge-unread-${thread.key}`}>
                  {thread.unreadSmsCount}
                </Badge>
              )}
              {/* Task #1685: manual-unread dot. We only show it when there
                  isn't already a numeric SMS unread badge, otherwise the
                  count above already communicates "unread". */}
              {thread.manuallyUnread && thread.unreadSmsCount === 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: BURGUNDY }}
                      data-testid={`badge-manual-unread-${thread.key}`}
                    />
                  </TooltipTrigger>
                  <TooltipContent>Marked unread</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
        {/* Task #1685: row-level overflow menu with the Mark as read /
            unread action. Visible on hover (and when selected) so it
            doesn't visually clutter the inbox. `e.stopPropagation` on
            the trigger keeps a click from also selecting the row. */}
        <div
          className={`flex-shrink-0 ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"} transition-opacity`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="p-1 rounded hover:bg-muted text-muted-foreground"
                aria-label="Thread actions"
                data-testid={`button-thread-actions-${thread.key}`}
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-testid={`menu-thread-actions-${thread.key}`}>
              {isUnread ? (
                <DropdownMenuItem
                  onSelect={() =>
                    onSetReadState(thread.key, true, thread.smsConversationIds)
                  }
                  data-testid={`menu-item-mark-read-${thread.key}`}
                >
                  Mark as read
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onSelect={() =>
                    onSetReadState(thread.key, false, thread.smsConversationIds)
                  }
                  data-testid={`menu-item-mark-unread-${thread.key}`}
                >
                  Mark as unread
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

function Avatar({ initials, group }: { initials: string; group?: boolean }) {
  return (
    <div
      className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0"
      style={{ background: group ? "hsl(var(--primary) / 0.75)" : BURGUNDY }}
    >
      {group ? <Users className="w-4 h-4" /> : initials}
    </div>
  );
}

function formatRelativeTime(d: Date): string {
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return format(d, "MMM d");
}

function TimelineColumn({
  thread, groups, messageInput, setMessageInput, onSend, sendPending,
  onStartCall, onAddParticipant, onBack, onCallBack, onTextFollowUp,
  onRetrySend, retryDisabled,
  composerRef, messagesEndRef, activeCall, onEndActiveCall,
  activeCallIsMuted, onToggleMute,
  followUpPrompt, onDismissFollowUp, onShowContextMobile,
  scrollTargetEventId, onLinkClient, onChangeClient, onUnlinkClient,
  onAddNote, onDeleteNote, currentUserId,
  onMarkVoicemailListened,
  users, onAssignThread,
}: {
  thread: UnifiedThread;
  groups: ReturnType<typeof groupTimelineByDate>;
  messageInput: string;
  setMessageInput: (v: string) => void;
  onSend: () => void;
  sendPending: boolean;
  onStartCall: () => void;
  onAddParticipant: () => void;
  onBack: () => void;
  onCallBack: (event: CallEvent) => void;
  onTextFollowUp: () => void;
  onRetrySend: (convId: string, failedId: string, body: string, toNumber: string) => void;
  retryDisabled: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  activeCall: ActiveCallState | null;
  onEndActiveCall: () => void;
  // Task #874: mute is real for browser calls, hidden/disabled for forward.
  activeCallIsMuted: boolean;
  onToggleMute: () => void;
  followUpPrompt: boolean;
  onDismissFollowUp: () => void;
  onShowContextMobile: () => void;
  scrollTargetEventId: string | null;
  onLinkClient: () => void;
  onChangeClient: () => void;
  onUnlinkClient: () => void;
  // Task #850
  onAddNote: () => void;
  onDeleteNote: (id: string) => void;
  currentUserId: string | null;
  onMarkVoicemailListened: (event: CallEvent) => void;
  // Task #1685: header-pane assign popover + optimistic mutate handler.
  users: UserSummary[];
  onAssignThread: (userId: string | null) => void;
}) {
  const initials = getInitials(thread.contactName, thread.contactPhone);
  const sms = thread.smsAvailability;
  const eventRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const [highlightId, setHighlightId] = useState<string | null>(null);

  useEffect(() => {
    if (!scrollTargetEventId) return;
    const el = eventRefs.current.get(scrollTargetEventId);
    if (el) {
      el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
      setHighlightId(scrollTargetEventId);
      const t = window.setTimeout(() => setHighlightId(null), 1600);
      return () => window.clearTimeout(t);
    }
  }, [scrollTargetEventId, groups]);

  return (
    <Card className="h-full flex flex-col overflow-hidden border-border/80 shadow-sm" data-testid="card-timeline">
      <ThreadHeader
        thread={thread}
        initials={initials}
        onStartCall={onStartCall}
        onAddParticipant={onAddParticipant}
        onTextFocus={() => composerRef.current?.focus()}
        onBack={onBack}
        onShowContextMobile={onShowContextMobile}
        onLinkClient={onLinkClient}
        onChangeClient={onChangeClient}
        onUnlinkClient={onUnlinkClient}
        onAddNote={onAddNote}
        users={users}
        onAssign={onAssignThread}
      />

      {/* Task #877 incoming-call surface lives at the top-level hub render below */}
      {activeCall && (
        <ActiveCallBar
          call={activeCall}
          onEnd={onEndActiveCall}
          isMuted={activeCallIsMuted}
          onToggleMute={onToggleMute}
          muteAvailable={activeCall.mode === "browser"}
        />
      )}

      <CardContent className="flex-1 overflow-y-auto p-4 space-y-4 bg-surface-warm-2">
        {groups.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No events in this thread yet"
            description="Send a text or place a call to start the conversation."
            testId="empty-timeline"
          />
        ) : (
          groups.map((g) => (
            <div key={g.date} className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-muted" />
                <span className="text-caption font-medium text-muted-foreground uppercase tracking-wide" data-testid={`timeline-divider-${g.date}`}>
                  {g.label}
                </span>
                <div className="flex-1 h-px bg-muted" />
              </div>
              {g.events.map((evt) => {
                if (evt.kind === "sms") {
                  return (
                    <SmsBubble
                      key={evt.id}
                      event={evt}
                      thread={thread}
                      onRetry={onRetrySend}
                      retryDisabled={retryDisabled}
                    />
                  );
                }
                if (evt.kind === "sms-group") {
                  return (
                    <SmsGroupBubble
                      key={evt.id}
                      event={evt}
                      thread={thread}
                      onRetry={onRetrySend}
                      retryDisabled={retryDisabled}
                    />
                  );
                }
                if (evt.kind === "note") {
                  return (
                    <div
                      key={evt.id}
                      ref={(el) => { eventRefs.current.set(evt.id, el); }}
                      className={highlightId === evt.id ? "ring-2 ring-primary/50 rounded-xl transition-all" : "transition-all"}
                    >
                      <NoteBubble
                        event={evt}
                        canDelete={!!currentUserId && evt.createdByUserId === currentUserId}
                        onDelete={() => onDeleteNote(evt.id)}
                      />
                    </div>
                  );
                }
                return (
                  <div
                    key={evt.id}
                    ref={(el) => { eventRefs.current.set(evt.id, el); }}
                    className={highlightId === evt.id ? "ring-2 ring-primary/50 rounded-xl transition-all" : "transition-all"}
                  >
                    <CallCard
                      event={evt}
                      onCallBack={() => onCallBack(evt)}
                      onTextFollowUp={onTextFollowUp}
                      onAddNote={onAddNote}
                      onMarkVoicemailListened={() => onMarkVoicemailListened(evt)}
                    />
                  </div>
                );
              })}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </CardContent>

      {followUpPrompt && (
        <div ref={fabColliderRef} className="px-4 py-2 border-t bg-amber-50 dark:bg-amber-950/25 flex items-center justify-between" data-testid="follow-up-prompt">
          <span className="text-sm text-amber-900 dark:text-amber-200">Call ended. Send a follow-up text?</span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onDismissFollowUp} data-testid="button-dismiss-follow-up">
              Dismiss
            </Button>
            <Button
              size="sm"
              className="text-white"
              style={{ background: BURGUNDY }}
              onClick={() => { onTextFollowUp(); onDismissFollowUp(); }}
              data-testid="button-follow-up-text"
            >
              <Send className="w-3.5 h-3.5 mr-1" />
              Follow-Up Text
            </Button>
          </div>
        </div>
      )}

      <Composer
        thread={thread}
        value={messageInput}
        setValue={setMessageInput}
        onSend={onSend}
        sendPending={sendPending}
        composerRef={composerRef}
        availability={sms}
      />
    </Card>
  );
}

function ThreadHeader({
  thread, initials, onStartCall, onAddParticipant, onTextFocus, onBack, onShowContextMobile,
  onLinkClient, onChangeClient, onUnlinkClient, onAddNote,
  users, onAssign,
}: {
  thread: UnifiedThread;
  initials: string;
  onStartCall: () => void;
  onAddParticipant: () => void;
  onTextFocus: () => void;
  onBack: () => void;
  onShowContextMobile: () => void;
  onLinkClient: () => void;
  // Task #968: shown only when the thread is already linked to a
  // client, so operators can fix mistakes (wrong firm) or detach
  // entirely without an engineer.
  onChangeClient: () => void;
  onUnlinkClient: () => void;
  // Task #850
  onAddNote: () => void;
  // Task #1685: right-pane assignment control. `onAssign(null)` clears
  // the assignment; the parent mutation is optimistic, so the chip
  // label flips instantly and rolls back on failure.
  users: UserSummary[];
  onAssign: (userId: string | null) => void;
}) {
  const sms = thread.smsAvailability;
  const callable = thread.callablePhones.length > 0;
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignFilter, setAssignFilter] = useState("");
  const assignee = thread.assignedToUserId
    ? users.find((u) => u.id === thread.assignedToUserId) ?? null
    : null;
  const assigneeLabel = assignee
    ? ([assignee.firstName, assignee.lastName].filter(Boolean).join(" ") || assignee.email || assignee.id)
    : "Unassigned";
  const filteredUsers = useMemo(() => {
    const q = assignFilter.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
      return (
        name.toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q)
      );
    });
  }, [users, assignFilter]);
  return (
    <CardHeader className="pb-3 flex-shrink-0 border-b py-3 px-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="lg:hidden text-muted-foreground hover:text-foreground p-1"
          data-testid="button-back-inbox"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <Avatar initials={initials} group={thread.isGroup} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base md:text-lg truncate" style={{ color: BURGUNDY }} data-testid="text-thread-title">
              {thread.displayName}
            </CardTitle>
            {sms.available ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 text-caption font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/25 px-1.5 py-0.5 rounded" data-testid="indicator-sms-ready">
                    <Check className="w-3 h-3" />
                    SMS
                  </span>
                </TooltipTrigger>
                <TooltipContent>SMS ready</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 text-caption font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/25 px-1.5 py-0.5 rounded" data-testid="indicator-sms-blocked">
                    <AlertCircle className="w-3 h-3" />
                    SMS blocked
                  </span>
                </TooltipTrigger>
                <TooltipContent>{sms.reason || "SMS unavailable"}</TooltipContent>
              </Tooltip>
            )}
            {/* Task #4336 — recipient consent state, always visible to the sender. */}
            {thread.contactPhone && !thread.isGroup && (
              <SmsConsentBadgeForPhone phone={thread.contactPhone} compact />
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground flex-wrap">
            {thread.contactPhone && (
              <span data-testid="text-thread-phone">{formatPhone(thread.contactPhone)}</span>
            )}
            {thread.clientName && (
              <span className="flex items-center gap-1">
                <Building2 className="w-3 h-3" />
                {thread.clientName}
              </span>
            )}
            {/* Task #1685: right-pane assignee chip. Always visible so
                operators can see and change ownership without opening
                the context column. Searchable popover; "Clear
                assignment" unassigns. */}
            <Popover open={assignOpen} onOpenChange={(o) => { setAssignOpen(o); if (!o) setAssignFilter(""); }}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-caption font-medium ${
                    assignee
                      ? "border-primary/30 bg-primary/5 text-primary-ink"
                      : "border-border bg-muted/50 text-muted-foreground hover:bg-muted"
                  }`}
                  data-testid="button-thread-assignee"
                  aria-label={assignee ? `Assigned to ${assigneeLabel}` : "Assign conversation"}
                >
                  <UserPlus className="w-3 h-3" />
                  {assignee ? `Assigned to ${assigneeLabel}` : "Unassigned"}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-2" data-testid="popover-thread-assignee">
                <Input
                  autoFocus
                  value={assignFilter}
                  onChange={(e) => setAssignFilter(e.target.value)}
                  placeholder="Search teammates"
                  className="h-8 text-sm mb-2"
                  data-testid="input-assignee-search"
                />
                <div className="max-h-64 overflow-y-auto space-y-0.5">
                  <button
                    type="button"
                    onClick={() => { onAssign(null); setAssignOpen(false); }}
                    className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-muted/50 ${
                      assignee == null ? "bg-primary/5 text-primary-ink" : ""
                    }`}
                    data-testid="button-assignee-clear"
                  >
                    Clear assignment
                  </button>
                  {filteredUsers.length === 0 ? (
                    <div className="px-2 py-2 text-xs text-muted-foreground" data-testid="text-assignee-empty">
                      No teammates match
                    </div>
                  ) : (
                    filteredUsers.map((u) => {
                      const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id;
                      const isCurrent = thread.assignedToUserId === u.id;
                      return (
                        <button
                          type="button"
                          key={u.id}
                          onClick={() => { onAssign(u.id); setAssignOpen(false); }}
                          className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-muted/50 ${
                            isCurrent ? "bg-primary/5 text-primary-ink" : ""
                          }`}
                          data-testid={`button-assignee-option-${u.id}`}
                        >
                          {name}
                        </button>
                      );
                    })
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button
            size="sm"
            onClick={onStartCall}
            disabled={!callable}
            className="text-white shadow-sm"
            style={{ background: callable ? BURGUNDY : undefined }}
            data-testid="button-call-thread"
          >
            <Phone className="w-3.5 h-3.5 mr-1" />
            Call
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onTextFocus}
            disabled={!sms.available}
            data-testid="button-text-thread"
          >
            <MessageSquare className="w-3.5 h-3.5 mr-1" />
            Text
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" onClick={onAddNote} data-testid="button-add-note-header" title="Add note">
                <StickyNote className="w-3.5 h-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Add note</TooltipContent>
          </Tooltip>
          {thread.primarySmsConversationId && (
            <Button size="sm" variant="outline" onClick={onAddParticipant} data-testid="button-add-participant-header" title="Add participant">
              <UserPlus className="w-3.5 h-3.5" />
            </Button>
          )}
          {thread.clientId ? (
            // Task #968: split control — left half jumps to the client
            // page (preserves the existing one-click affordance), right
            // half drops a menu with Change client / Unlink so operators
            // can fix mistakes from the UI. Menu is only enabled for
            // direct (non-group) threads with a real conversation row;
            // group threads don't have a single row to reassign.
            <div className="inline-flex" data-testid="group-client-link-actions">
              <Button
                asChild
                size="sm"
                variant="outline"
                className="rounded-r-none border-r-0 px-2"
                data-testid="button-view-client-header"
                title="View client"
              >
                <Link href={`/clients/${thread.clientId}`}>
                  <Building2 className="w-3.5 h-3.5" />
                </Link>
              </Button>
              {thread.primarySmsConversationId && !thread.isGroup ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-l-none px-1.5"
                      data-testid="button-client-link-menu"
                      title="Change or unlink client"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" data-testid="menu-client-link-actions">
                    <DropdownMenuItem onSelect={onChangeClient} data-testid="menu-item-change-client">
                      <Pencil className="w-3.5 h-3.5 mr-2" />
                      Change client…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={onUnlinkClient}
                      className="text-red-600 dark:text-red-400 focus:text-red-700 dark:focus:text-red-200 focus:bg-red-50 dark:focus:bg-red-950/25"
                      data-testid="menu-item-unlink-client"
                    >
                      <Unlink2 className="w-3.5 h-3.5 mr-2" />
                      Unlink from client
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          ) : thread.primarySmsConversationId && !thread.isGroup ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onLinkClient}
              data-testid="button-link-client-header"
              title="Link to client"
            >
              <Building2 className="w-3.5 h-3.5 mr-1" />
              Link to client
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="lg:hidden"
            onClick={onShowContextMobile}
            data-testid="button-show-context-mobile"
            title="Details"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </CardHeader>
  );
}

// Task #877: ring banner shown at the top of the hub when the Voice JS
// SDK device receives an inbound call. Caller context is whatever Twilio
// gave us in `parameters.From` — typically a PSTN number, occasionally a
// `client:<userId>` for a client-to-client call. We display the formatted
// phone (best-effort) and offer Accept / Decline. Accept hands control to
// the existing ActiveCallBar via the parent's handleAcceptIncoming.
function IncomingCallBanner({
  incoming,
  onAccept,
  onReject,
}: {
  incoming: { from: string; callSid?: string; receivedAt: number };
  onAccept: () => void;
  onReject: () => void;
}) {
  const isClientIdentity = incoming.from.startsWith("client:");
  const display = isClientIdentity
    ? `Internal call (${incoming.from.slice("client:".length)})`
    : (formatPhone(incoming.from) || incoming.from || "Unknown caller");
  return (
    <div
      className="mb-3 px-4 py-3 rounded-lg border bg-primary text-primary-foreground flex items-center gap-3 shadow-md"
      data-testid="incoming-call-banner"
    >
      <div className="w-10 h-10 rounded-full bg-white/15 flex items-center justify-center animate-pulse">
        <PhoneCall className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs uppercase tracking-wide opacity-80">Incoming call</div>
        <div className="text-sm font-medium truncate" data-testid="incoming-call-from">
          {display}
        </div>
      </div>
      <Button
        size="sm"
        onClick={onReject}
        className="bg-red-600 hover:bg-red-700 text-white"
        data-testid="button-incoming-reject"
      >
        <PhoneOff className="w-3.5 h-3.5 mr-1" />
        Decline
      </Button>
      <Button
        size="sm"
        onClick={onAccept}
        className="bg-green-600 hover:bg-green-700 text-white"
        data-testid="button-incoming-accept"
      >
        <PhoneCall className="w-3.5 h-3.5 mr-1" />
        Accept
      </Button>
    </div>
  );
}

export function ActiveCallBar({
  call, onEnd, isMuted, onToggleMute, muteAvailable,
}: {
  call: ActiveCallState;
  onEnd: () => void;
  // Task #874: real for browser-mode calls; visually disabled for forward.
  isMuted: boolean;
  onToggleMute: () => void;
  muteAvailable: boolean;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.floor((Date.now() - call.startedAt) / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const timer = `${mins}:${String(secs).padStart(2, "0")}`;
  const modeLabel = call.mode === "browser" ? "Browser" : "Phone";
  return (
    <div className="px-4 py-2.5 border-b bg-primary text-primary-foreground flex items-center gap-3" data-testid="active-call-bar">
      <div className="w-8 h-8 rounded-full bg-white/15 flex items-center justify-center animate-pulse">
        <PhoneCall className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate" data-testid="active-call-name">
          {call.thread.displayName}
        </div>
        <div className="text-xs opacity-80" data-testid="active-call-meta">
          {formatPhone(call.phone)} · {modeLabel} · {
            call.status === "calling" ? "Connecting" :
            call.status === "ringing" ? "Ringing" :
            call.status === "ending" ? "Ending…" :
            call.status === "ended" ? "Ended" :
            "On call"
          } · {timer}
        </div>
      </div>
      <button
        className={`p-2 rounded-full ${muteAvailable ? "opacity-90 hover:bg-white/15" : "opacity-50 cursor-not-allowed"}`}
        title={
          muteAvailable
            ? (isMuted ? "Unmute" : "Mute")
            : "Mute is handled on your phone in forward mode"
        }
        data-testid="button-active-mute"
        onClick={muteAvailable ? onToggleMute : undefined}
        disabled={!muteAvailable}
      >
        {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
      </button>
      <Button
        size="sm"
        onClick={onEnd}
        disabled={call.status === "ending"}
        className="bg-red-600 hover:bg-red-700 text-white"
        data-testid="button-end-active-call"
      >
        <PhoneOff className="w-3.5 h-3.5 mr-1" />
        {call.status === "ending" ? "Ending…" : "End"}
      </Button>
    </div>
  );
}

// Task #875: render the SMS delivery-status badge under each outbound
// message bubble. Maps the raw Twilio status to a friendly label,
// colors `failed` / `undelivered` red, and (when Twilio sent us an
// error code) renders a hover tooltip with the diagnostic info so
// users can self-diagnose without leaving the thread view.
function SmsStatusBadge({
  status,
  errorCode,
  errorMessage,
  "data-testid": testId,
}: {
  status: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  "data-testid"?: string;
}) {
  const isFailed = status === "failed" || status === "undelivered";
  const label =
    status === "delivered" ? "Delivered" :
    status === "sent" ? "Sent" :
    status === "queued" || status === "accepted" || status === "scheduled" ? "Queued" :
    status === "sending" ? "Sending" :
    status === "failed" ? "Failed" :
    status === "undelivered" ? "Undelivered" :
    status;
  const badge = (
    <span
      className={`${isFailed ? "text-red-300" : ""} ${errorCode ? "underline decoration-dotted underline-offset-2 cursor-help" : ""}`}
      data-testid={testId}
    >
      {" · "}
      {label}
    </span>
  );
  if (errorCode) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" align="end">
          <span className="text-xs">
            Twilio error {errorCode}
            {errorMessage ? `: ${errorMessage}` : ""}
          </span>
        </TooltipContent>
      </Tooltip>
    );
  }
  return badge;
}

// Task #883: render which Twilio transport actually sent this outbound
// message — Messaging Service (RCS-capable Sender Pool) or a single
// From phone — so admins can tell at a glance from the thread whether
// a contact would have received an RCS card vs SMS, and triage why.
// Mirrors the persisted column on `twilio_messages`: a non-null
// `messaging_service_sid` means the Messaging Service path was used;
// otherwise the legacy `from: <phoneNumber>` path was used and we show
// the configured Twilio number instead.
function SmsTransportBadge({
  messagingServiceSid,
  fromNumber,
  "data-testid": testId,
}: {
  messagingServiceSid?: string | null;
  fromNumber: string;
  "data-testid"?: string;
}) {
  const viaService = !!(messagingServiceSid && messagingServiceSid.length > 0);
  const shortLabel = viaService
    ? `via Messaging Service ${messagingServiceSid!.slice(0, 6)}…`
    : fromNumber
      ? `via ${fromNumber}`
      : null;
  if (!shortLabel) return null;
  const tooltip = viaService
    ? `Sent through Twilio Messaging Service ${messagingServiceSid} (RCS-capable Sender Pool).`
    : `Sent directly from ${fromNumber} (single-number SMS path).`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="underline decoration-dotted underline-offset-2 cursor-help"
          data-testid={testId}
        >
          {" · "}
          {shortLabel}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="end">
        <span className="text-xs">{tooltip}</span>
      </TooltipContent>
    </Tooltip>
  );
}

// Task #5300: shared bubble-shape tokens so the group-send bubble
// (SmsGroupBubble) reuses the exact same on-contract rounded-* classes as
// the single-recipient bubble instead of re-declaring them (design-contract
// ratchet: Task #4347 — the frozen rounded-* count must never grow).
const SMS_BUBBLE_CORNER_RADIUS = "rounded-2xl";
const SMS_BUBBLE_CORNER_OUT = "rounded-br-md";
const SMS_BUBBLE_CORNER_IN = "rounded-bl-md";
const SMS_FAILURE_CHIP_SHAPE = "rounded-md";

function SmsBubble({ event, thread, onRetry, retryDisabled }: {
  event: SmsEvent;
  thread: UnifiedThread;
  onRetry?: (convId: string, failedId: string, body: string, toNumber: string) => void;
  retryDisabled?: boolean;
}) {
  const out = event.direction === "outbound";
  // Task #880: any failed/undelivered outbound bubble shows the inline
  // reason chip — independent of retry eligibility — so users always
  // see why a message didn't go through.
  const isFailed = out && (event.status === "failed" || event.status === "undelivered");
  // Task #854 / #880: one-click retry on failed outbound sends. We only
  // surface it when we have a body and a target phone (Twilio's
  // /send-sms route requires both); group threads can have multiple
  // recipients but each bubble carries the single recipient that failed.
  const canRetry =
    isFailed &&
    !!onRetry &&
    !!event.body.trim() &&
    !!event.toNumber;
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`} data-testid={`message-${event.id}`}>
      <div
        className={`max-w-[78%] ${SMS_BUBBLE_CORNER_RADIUS} px-3.5 py-2 shadow-sm ${
          out ? `${SMS_BUBBLE_CORNER_OUT} text-white` : `${SMS_BUBBLE_CORNER_IN} bg-card border border-border text-foreground`
        }`}
        style={out ? { background: BURGUNDY } : undefined}
      >
        {thread.isGroup && !out && (
          <p className="text-caption font-medium mb-0.5 opacity-70">{event.fromNumber}</p>
        )}
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{event.body}</p>
        {isFailed && (
          // Task #880: inline failure reason — visible at a glance so
          // users don't have to hover the status badge to find out why.
          // Rendered for every failed/undelivered bubble, even when the
          // retry button can't be offered (missing body / recipient).
          <div
            className={`mt-1.5 flex items-center gap-1 ${SMS_FAILURE_CHIP_SHAPE} bg-white/15 px-2 py-1 text-caption text-white`}
            data-testid={`reason-sms-${event.id}`}
          >
            <AlertCircle className="w-3 h-3 flex-shrink-0" />
            <span className="truncate">
              {friendlySmsFailureReason(event.errorCode, event.errorMessage)}
            </span>
          </div>
        )}
        <div className={`flex items-center gap-1 text-caption mt-1 ${out ? "text-white/70" : "text-muted-foreground"}`}>
          <span>{format(event.ts, "h:mm a")}</span>
          {out && (
            <SmsStatusBadge
              status={event.status}
              errorCode={event.errorCode ?? null}
              errorMessage={event.errorMessage ?? null}
              data-testid={`status-sms-${event.id}`}
            />
          )}
          {out && (
            <SmsTransportBadge
              messagingServiceSid={event.messagingServiceSid ?? null}
              fromNumber={event.fromNumber}
              data-testid={`transport-sms-${event.id}`}
            />
          )}
          {canRetry && (
            <button
              type="button"
              onClick={() => onRetry!(event.conversationId, event.id, event.body, event.toNumber)}
              disabled={retryDisabled}
              className={`ml-1 underline hover:no-underline text-white/90 hover:text-white ${
                retryDisabled ? "opacity-50 cursor-not-allowed" : ""
              }`}
              data-testid={`button-retry-sms-${event.id}`}
              title={retryDisabled ? "A send is already in progress" : "Retry sending this message"}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Task #5300: one compose action targeting multiple recipients renders as
// ONE bubble (the shared message text) plus a compact per-recipient
// delivery list, instead of N look-alike bubbles that read as duplicate
// sends. Per-recipient outcomes (sent/delivered/failed) stay visible —
// failures still need a name/number and a reason attached to them.
function SmsGroupBubble({ event, thread, onRetry, retryDisabled }: {
  event: SmsGroupEvent;
  thread: UnifiedThread;
  onRetry?: (convId: string, failedId: string, body: string, toNumber: string) => void;
  retryDisabled?: boolean;
}) {
  const nameByPhone = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of thread.groupParticipants) {
      if (p.name) map.set(p.phone, p.name);
    }
    return map;
  }, [thread.groupParticipants]);

  const recipientLabels = event.recipients.map((r) => nameByPhone.get(r.toNumber) || formatPhone(r.toNumber));
  const failedCount = event.recipients.filter((r) => r.status === "failed" || r.status === "undelivered").length;

  return (
    <div className="flex justify-end" data-testid={`message-group-${event.id}`}>
      <div
        className={`max-w-[78%] ${SMS_BUBBLE_CORNER_RADIUS} ${SMS_BUBBLE_CORNER_OUT} px-3.5 py-2 shadow-sm text-white`}
        style={{ background: BURGUNDY }}
      >
        <p
          className="text-caption font-medium mb-1 opacity-80"
          data-testid={`text-group-recipients-${event.id}`}
        >
          Sent to {recipientLabels.join(", ")}
        </p>
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{event.body}</p>
        {failedCount > 0 && (
          <div
            className={`mt-1.5 flex items-center gap-1 ${SMS_FAILURE_CHIP_SHAPE} bg-white/15 px-2 py-1 text-caption text-white`}
            data-testid={`reason-sms-group-${event.id}`}
          >
            <AlertCircle className="w-3 h-3 flex-shrink-0" />
            <span>
              Failed for {failedCount} of {event.recipients.length} recipient{event.recipients.length === 1 ? "" : "s"}
            </span>
          </div>
        )}
        <div className="mt-1.5 space-y-1" data-testid={`list-group-recipients-${event.id}`}>
          {event.recipients.map((r, idx) => {
            const isFailed = r.status === "failed" || r.status === "undelivered";
            const canRetry = isFailed && !!onRetry && !!event.body.trim() && !!r.toNumber;
            return (
              <div key={r.id} className="text-caption text-white/85" data-testid={`row-group-recipient-${r.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{recipientLabels[idx]}</span>
                  <span className="flex items-center gap-1 flex-shrink-0">
                    <SmsStatusBadge
                      status={r.status}
                      errorCode={r.errorCode ?? null}
                      errorMessage={r.errorMessage ?? null}
                      data-testid={`status-sms-${r.id}`}
                    />
                    {canRetry && (
                      <button
                        type="button"
                        onClick={() => onRetry!(event.conversationId, r.id, event.body, r.toNumber)}
                        disabled={retryDisabled}
                        className={`underline hover:no-underline text-white/90 hover:text-white ${
                          retryDisabled ? "opacity-50 cursor-not-allowed" : ""
                        }`}
                        data-testid={`button-retry-sms-${r.id}`}
                        title={retryDisabled ? "A send is already in progress" : "Retry sending this message"}
                      >
                        Retry
                      </button>
                    )}
                  </span>
                </div>
                {isFailed && (
                  <div
                    className={`flex items-center gap-1 mt-0.5 ${SMS_FAILURE_CHIP_SHAPE} bg-white/15 px-2 py-0.5 text-white`}
                    data-testid={`reason-sms-${r.id}`}
                  >
                    <AlertCircle className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">{friendlySmsFailureReason(r.errorCode, r.errorMessage)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-1 text-caption mt-1 text-white/70">
          <span>{format(event.ts, "h:mm a")}</span>
        </div>
      </div>
    </div>
  );
}

function CallCard({ event, onCallBack, onTextFollowUp, onAddNote, onMarkVoicemailListened }: {
  event: CallEvent;
  onCallBack: () => void;
  onTextFollowUp: () => void;
  // Task #850
  onAddNote: () => void;
  onMarkVoicemailListened: () => void;
}) {
  // Task #852: voicemail variant. Inbound calls that left a voicemail
  // render a distinct card with the voicemail audio + transcript and a
  // burgundy "VM" header so operators can spot/triage them quickly.
  // Pressing play (or the explicit button) flips voicemailListenedAt
  // and clears the inbox VM badge for the thread.
  if (event.direction === "inbound" && event.voicemailRecordingUrl) {
    const isUnheard = !event.voicemailListenedAt;
    const txStatus = event.voicemailTranscriptionStatus;
    const transcriptPending = txStatus === "in-progress";
    const transcriptFailed = txStatus === "failed";
    return (
      <div className="flex justify-center" data-testid={`call-card-${event.id}`}>
        <div
          className={`w-full max-w-[78%] border rounded-xl px-3 py-2.5 shadow-sm ${
            isUnheard ? "border-primary/40 bg-primary/5" : "border-border bg-card"
          }`}
          data-testid={`voicemail-card-${event.id}`}
        >
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-white"
              style={{ background: BURGUNDY }}
            >
              <Voicemail className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium" data-testid={`voicemail-status-${event.id}`}>
                  Voicemail
                </span>
                {isUnheard && (
                  <Badge
                    className="text-white text-caption px-1.5 py-0"
                    style={{ background: BURGUNDY }}
                    data-testid={`voicemail-unheard-${event.id}`}
                  >
                    Unheard
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
                <span>{format(event.ts, "h:mm a")}</span>
                {event.voicemailRecordingDurationSeconds != null && event.voicemailRecordingDurationSeconds > 0 && (
                  <span>· {formatCallDuration(event.voicemailRecordingDurationSeconds)}</span>
                )}
              </div>
            </div>
          </div>
          <div className="mt-2">
            <audio
              controls
              preload="none"
              className="w-full h-9"
              src={`/api/twilio/calls/${event.id}/voicemail-recording`}
              onPlay={onMarkVoicemailListened}
              data-testid={`audio-voicemail-${event.id}`}
            />
          </div>
          {event.voicemailTranscriptionText ? (
            <div
              className="mt-2 p-2 bg-muted/50 rounded border border-border whitespace-pre-wrap text-xs text-foreground max-h-64 overflow-y-auto"
              data-testid={`text-voicemail-transcript-${event.id}`}
            >
              {event.voicemailTranscriptionText}
            </div>
          ) : transcriptPending ? (
            <div className="mt-2 text-xs text-muted-foreground italic" data-testid={`voicemail-transcript-pending-${event.id}`}>
              Transcribing voicemail…
            </div>
          ) : transcriptFailed ? (
            <div className="mt-2 text-xs text-muted-foreground italic" data-testid={`voicemail-transcript-failed-${event.id}`}>
              Transcript unavailable
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            <Button size="sm" variant="outline" onClick={onCallBack} data-testid={`button-voicemail-callback-${event.id}`} className="h-7">
              <Phone className="w-3 h-3 mr-1" />
              Call Back
            </Button>
            <Button size="sm" variant="outline" onClick={onTextFollowUp} data-testid={`button-voicemail-text-${event.id}`} className="h-7">
              <MessageSquare className="w-3 h-3 mr-1" />
              Text Follow-Up
            </Button>
            {isUnheard && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onMarkVoicemailListened}
                data-testid={`button-voicemail-mark-listened-${event.id}`}
                className="h-7 text-muted-foreground"
              >
                <Check className="w-3 h-3 mr-1" />
                Mark as listened
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const status = formatCallStatus(event.rawStatus, event.direction);
  const Icon = status.display === "missed" || status.display === "no-answer"
    ? PhoneMissed
    : event.direction === "inbound" ? PhoneIncoming : PhoneOutgoing;
  const tone = status.tone;
  const toneClass =
    tone === "danger" ? "border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/25" :
    tone === "warning" ? "border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/25" :
    tone === "success" ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/25" :
    "border-border bg-card";
  const iconBgClass =
    tone === "danger" ? "bg-red-100 dark:bg-red-950/35 text-red-600 dark:text-red-400" :
    tone === "warning" ? "bg-amber-100 dark:bg-amber-950/35 text-amber-700 dark:text-amber-300" :
    tone === "success" ? "bg-emerald-100 dark:bg-emerald-950/35 text-emerald-700 dark:text-emerald-300" :
    "bg-muted text-muted-foreground";

  return (
    <div className={`flex justify-center`} data-testid={`call-card-${event.id}`}>
      <div className={`w-full max-w-[78%] border rounded-xl px-3 py-2.5 shadow-sm ${toneClass}`}>
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${iconBgClass}`}>
            <Icon className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium" data-testid={`call-status-${event.id}`}>
                {event.direction === "inbound" ? "Inbound call" : "Outbound call"} · {status.label}
              </span>
              {event.routingTier && (
                <Badge variant="outline" className="text-caption px-1.5 py-0">
                  Tier {event.routingTier}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
              <span>{format(event.ts, "h:mm a")}</span>
              {event.durationSeconds != null && event.durationSeconds > 0 && (
                <span>· {formatCallDuration(event.durationSeconds)}</span>
              )}
              {event.routedToUserName && event.direction === "inbound" && (
                <span>· → {event.routedToUserName}</span>
              )}
              {event.initiatedByUserName && event.direction === "outbound" && (
                <span>· by {event.initiatedByUserName}</span>
              )}
            </div>
          </div>
        </div>
        {event.recordingStatus === "completed" && event.recordingUrl ? (
          <div className="mt-2" data-testid={`call-recording-${event.id}`}>
            <audio
              controls
              preload="none"
              className="w-full h-9"
              src={`/api/twilio/calls/${event.id}/recording`}
              data-testid={`audio-recording-${event.id}`}
            />
          </div>
        ) : event.recordingStatus === "in-progress" ? (
          <div className="mt-2 text-xs text-muted-foreground italic" data-testid={`call-recording-pending-${event.id}`}>
            Recording processing…
          </div>
        ) : event.recordingStatus === "failed" ? (
          <div className="mt-2 text-xs text-muted-foreground italic" data-testid={`call-recording-failed-${event.id}`}>
            Recording unavailable
          </div>
        ) : null}
        {event.recordingStatus === "completed" && (event.transcriptText || event.archiveStatus === "queued" || event.archiveStatus === "processing") ? (
          <details className="mt-2 text-xs" data-testid={`call-transcript-${event.id}`}>
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
              {event.transcriptText ? "Transcript" : "Transcript processing…"}
            </summary>
            {event.transcriptText ? (
              <div
                className="mt-1.5 p-2 bg-muted/50 rounded border border-border whitespace-pre-wrap text-foreground max-h-64 overflow-y-auto"
                data-testid={`text-transcript-${event.id}`}
              >
                {event.transcriptText}
              </div>
            ) : (
              <div className="mt-1.5 text-muted-foreground italic">
                We're transcribing this call now. Refresh in a minute.
              </div>
            )}
          </details>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <Button size="sm" variant="outline" onClick={onCallBack} data-testid={`button-callback-${event.id}`} className="h-7">
            <Phone className="w-3 h-3 mr-1" />
            Call Back
          </Button>
          <Button size="sm" variant="outline" onClick={onTextFollowUp} data-testid={`button-follow-up-${event.id}`} className="h-7">
            <MessageSquare className="w-3 h-3 mr-1" />
            Text Follow-Up
          </Button>
          <Button size="sm" variant="ghost" data-testid={`button-add-note-${event.id}`} className="h-7 text-muted-foreground" onClick={onAddNote} title="Add note">
            <StickyNote className="w-3 h-3 mr-1" />
            Add Note
          </Button>
        </div>
      </div>
    </div>
  );
}

function Composer({
  thread, value, setValue, onSend, sendPending, composerRef, availability,
}: {
  thread: UnifiedThread;
  value: string;
  setValue: (v: string) => void;
  onSend: () => void;
  sendPending: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  availability: { available: boolean; reason?: string };
}) {
  // Task #4336 — human 1:1 sends bypass the automated-send consent gate,
  // but the sender must SEE the recipient's consent state before sending.
  const { data: consent } = useSmsConsentStatus(!thread.isGroup ? thread.contactPhone : null);
  return (
    // Marked as a FAB collider so the global floating comms button lifts
    // above the send controls on mobile instead of covering them (Task #4374).
    <div ref={fabColliderRef} className="p-3 border-t flex-shrink-0 bg-card">
      {!availability.available && (
        <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/25 px-2 py-1 rounded mb-2 flex items-center gap-1.5" data-testid="composer-blocked-reason">
          <AlertCircle className="w-3 h-3" />
          {availability.reason || "SMS unavailable"}
        </div>
      )}
      {consent?.state === "opted_out" && (
        <div className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/25 px-2 py-1 rounded mb-2 flex items-center gap-1.5" data-testid="composer-consent-optout-warning">
          <AlertCircle className="w-3 h-3" />
          This number texted STOP — it has opted out of SMS. Twilio will block sends until they text START.
        </div>
      )}
      <div className="flex gap-2">
        <Textarea
          ref={composerRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            !availability.available ? "SMS unavailable" :
            thread.isGroup ? `Message ${thread.groupParticipants.length} people...` : "Type a message..."
          }
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={sendPending || !availability.available}
          className="resize-none min-h-[40px] max-h-32 bg-muted/50 border-border"
          data-testid="input-message"
        />
        <Button
          onClick={onSend}
          disabled={!value.trim() || sendPending || !availability.available}
          className="text-white"
          style={{ background: BURGUNDY }}
          data-testid="button-send-message"
        >
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function ContextColumn({
  thread, onClose, onAddParticipant,
  onAddNote, onDeleteNote, onAssign, onSetStatus,
  notes, users, currentUserId,
}: {
  thread: UnifiedThread | null;
  onClose: () => void;
  onAddParticipant: () => void;
  // Task #850
  onAddNote: () => void;
  onDeleteNote: (id: string) => void;
  onAssign: () => void;
  onSetStatus: (status: ThreadStatus) => void;
  notes: RawThreadNote[];
  users: UserSummary[];
  currentUserId: string | null;
}) {
  if (!thread) {
    return (
      <Card className="h-full flex flex-col overflow-hidden border-border/80 shadow-sm" data-testid="card-context-empty">
        <CardContent className="flex-1 flex items-center justify-center text-center text-muted-foreground p-6">
          <div>
            <User className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">Select a conversation to see contact details</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full flex flex-col overflow-hidden border-border/80 shadow-sm" data-testid="card-context">
      <CardHeader className="pb-2 flex-shrink-0 border-b flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-semibold" style={{ color: BURGUNDY }}>Details</CardTitle>
        <button
          className="lg:hidden text-muted-foreground hover:text-muted-foreground p-1"
          onClick={onClose}
          data-testid="button-close-context-mobile"
        >
          <X className="w-4 h-4" />
        </button>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto p-3 space-y-3">
        <ClientCard thread={thread} users={users} />
        <ContactInfoCard thread={thread} />
        <QuickActionsCard
          thread={thread}
          onAddParticipant={onAddParticipant}
          onAddNote={onAddNote}
          onAssign={onAssign}
          onSetStatus={onSetStatus}
        />
        <NotesCard
          notes={notes}
          users={users}
          currentUserId={currentUserId}
          onAddNote={onAddNote}
          onDeleteNote={onDeleteNote}
        />
        <RecentActivityCard thread={thread} />
      </CardContent>
    </Card>
  );
}

function PanelSection({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="bg-card border border-border/80 rounded-lg p-3" data-testid={testId}>
      <div className="text-caption font-semibold uppercase tracking-wide text-muted-foreground mb-2">{title}</div>
      {children}
    </div>
  );
}

type ClientDetail = {
  id: string;
  firmName: string;
  clientCode: string | null;
  ownerId: string | null;
  isArchived: boolean | null;
  consultType: string | null;
  practiceAreas: string[] | null;
  products: string[] | null;
};

function ClientCard({ thread, users }: { thread: UnifiedThread; users: UserSummary[] }) {
  const { data: client } = useQuery<ClientDetail>({
    queryKey: [`/api/clients/${thread.clientId}`],
    enabled: !!thread.clientId,
  });
  // Task #850: roster comes from the parent so the same /api/users query
  // backs the assignment dropdown without a second request.
  const owner = client?.ownerId ? users.find((u) => u.id === client.ownerId) : null;
  const ownerName = owner
    ? [owner.firstName, owner.lastName].filter(Boolean).join(" ") || owner.email || "Unassigned"
    : null;
  const status = client ? (client.isArchived ? "Archived" : "Active") : null;

  return (
    <PanelSection title="Client" testId="panel-client">
      {thread.clientId ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center" style={{ color: BURGUNDY }}>
              <Building2 className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate" data-testid="text-client-name">
                {client?.firmName || thread.clientName || "Linked client"}
              </div>
              <Link href={`/clients/${thread.clientId}`} className="text-xs underline hover:no-underline" style={{ color: BURGUNDY }} data-testid="link-view-client">
                View Client
              </Link>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs pt-1">
            <div>
              <div className="text-muted-foreground">Status</div>
              <div className="font-medium" data-testid="text-client-status">
                {status ? (
                  <span className={status === "Active" ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}>{status}</span>
                ) : "—"}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Owner</div>
              <div className="font-medium truncate" data-testid="text-client-owner" title={ownerName || ""}>
                {ownerName || (client?.ownerId ? "—" : "Unassigned")}
              </div>
            </div>
            {client?.clientCode && (
              <div>
                <div className="text-muted-foreground">Code</div>
                <div className="font-medium" data-testid="text-client-code">{client.clientCode}</div>
              </div>
            )}
            {client?.consultType && (
              <div>
                <div className="text-muted-foreground">Consult</div>
                <div className="font-medium capitalize" data-testid="text-client-consult-type">{client.consultType}</div>
              </div>
            )}
          </div>
          {client?.practiceAreas && client.practiceAreas.length > 0 && (
            <div className="text-xs pt-1">
              <div className="text-muted-foreground mb-1">Practice Areas</div>
              <div className="flex flex-wrap gap-1">
                {client.practiceAreas.slice(0, 4).map((p) => (
                  <Badge key={p} variant="secondary" className="text-caption px-1.5 py-0" data-testid={`badge-practice-${p}`}>
                    {p}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="text-no-client">Not linked to a client yet.</p>
      )}
    </PanelSection>
  );
}

function ContactInfoCard({ thread }: { thread: UnifiedThread }) {
  const phones = thread.isGroup
    ? thread.groupParticipants.map((p) => ({ phone: p.phone, label: p.name || formatPhone(p.phone) }))
    : thread.contactPhone ? [{ phone: thread.contactPhone, label: thread.contactName || formatPhone(thread.contactPhone) }] : [];

  return (
    <PanelSection title="Contact" testId="panel-contact-info">
      {phones.length === 0 ? (
        <p className="text-xs text-muted-foreground">No phone numbers on file.</p>
      ) : (
        <div className="space-y-1.5">
          {phones.map((p, i) => (
            <div key={`${p.phone}-${i}`} className="flex items-center gap-2 text-xs">
              <Phone className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{p.label}</div>
                <div className="text-muted-foreground">{formatPhone(p.phone)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 pt-2 border-t text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">SMS:</span>
          <span className={thread.smsAvailability.available ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
            {thread.smsAvailability.available ? "Ready" : (thread.smsAvailability.reason || "Unavailable")}
          </span>
        </div>
      </div>
    </PanelSection>
  );
}

function QuickActionsCard({
  thread, onAddParticipant, onAddNote, onAssign, onSetStatus,
}: {
  thread: UnifiedThread;
  onAddParticipant: () => void;
  onAddNote: () => void;
  onAssign: () => void;
  onSetStatus: (status: ThreadStatus) => void;
}) {
  // Task #850: status buttons toggle. Clicking the active status flips
  // the thread back to "open" so operators can undo without a separate
  // "reopen" affordance.
  const isFollowUp = thread.threadStatus === "needs_follow_up";
  const isResolved = thread.threadStatus === "resolved";
  return (
    <PanelSection title="Quick Actions" testId="panel-quick-actions">
      <div className="grid grid-cols-2 gap-1.5">
        <Button size="sm" variant="outline" className="text-xs h-8" data-testid="button-add-note" onClick={onAddNote}>
          <StickyNote className="w-3 h-3 mr-1" />
          Add Note
        </Button>
        <Button size="sm" variant="outline" className="text-xs h-8" data-testid="button-assign" onClick={onAssign}>
          <User className="w-3 h-3 mr-1" />
          Assign
        </Button>
        <Button
          size="sm"
          variant={isFollowUp ? "default" : "outline"}
          className={`text-xs h-8 ${isFollowUp ? "text-white" : ""}`}
          style={isFollowUp ? { background: BURGUNDY } : undefined}
          data-testid="button-mark-follow-up"
          onClick={() => onSetStatus(isFollowUp ? "open" : "needs_follow_up")}
        >
          <AlertCircle className="w-3 h-3 mr-1" />
          {isFollowUp ? "Following Up" : "Needs Follow-Up"}
        </Button>
        <Button
          size="sm"
          variant={isResolved ? "default" : "outline"}
          className={`text-xs h-8 ${isResolved ? "text-white" : ""}`}
          style={isResolved ? { background: "hsl(var(--status-ok))" } : undefined}
          data-testid="button-mark-resolved"
          onClick={() => onSetStatus(isResolved ? "open" : "resolved")}
        >
          <Check className="w-3 h-3 mr-1" />
          {isResolved ? "Resolved" : "Resolved"}
        </Button>
        {thread.primarySmsConversationId && (
          <Button size="sm" variant="outline" onClick={onAddParticipant} className="text-xs h-8 col-span-2" data-testid="button-add-participant-quick">
            <UserPlus className="w-3 h-3 mr-1" />
            Add Participant
          </Button>
        )}
        {thread.clientId && (
          <Button asChild size="sm" variant="outline" className="text-xs h-8 col-span-2" data-testid="button-view-client-quick">
            <Link href={`/clients/${thread.clientId}`}>
              <Building2 className="w-3 h-3 mr-1" />
              View Client Profile
            </Link>
          </Button>
        )}
      </div>
    </PanelSection>
  );
}

// Task #850: read-only list of all notes on the open thread, with a
// composer affordance that reuses the same dialog the Quick Action +
// header buttons open. Keeps note management within one column so the
// timeline view stays focused on the conversation itself.
function NotesCard({
  notes, users, currentUserId, onAddNote, onDeleteNote,
}: {
  notes: RawThreadNote[];
  users: UserSummary[];
  currentUserId: string | null;
  onAddNote: () => void;
  onDeleteNote: (id: string) => void;
}) {
  const userById = useMemo(() => {
    const m = new Map<string, UserSummary>();
    for (const u of users) m.set(u.id, u);
    return m;
  }, [users]);
  return (
    <PanelSection title={`Notes (${notes.length})`} testId="panel-notes">
      <div className="space-y-2">
        {notes.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="text-notes-empty">No notes yet.</p>
        ) : (
          notes
            .slice()
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .map((n) => {
              const author = n.createdByUserId ? userById.get(n.createdByUserId) : null;
              const authorName = n.createdByName
                || (author ? [author.firstName, author.lastName].filter(Boolean).join(" ") || author.email : null)
                || "Unknown";
              const canDelete = !!currentUserId && n.createdByUserId === currentUserId;
              return (
                <div key={n.id} className="text-xs bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded p-2" data-testid={`note-panel-${n.id}`}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-medium text-amber-900 dark:text-amber-200 truncate">{authorName}</span>
                    <span className="text-amber-700 dark:text-amber-300/70 flex-shrink-0">{format(new Date(n.createdAt), "MMM d, h:mm a")}</span>
                  </div>
                  <div className="text-amber-900 dark:text-amber-200 whitespace-pre-wrap break-words">{n.body}</div>
                  {canDelete && (
                    <div className="mt-1 text-right">
                      <button
                        type="button"
                        className="text-caption text-red-600 dark:text-red-400 hover:underline"
                        onClick={() => onDeleteNote(n.id)}
                        data-testid={`button-delete-note-panel-${n.id}`}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })
        )}
        <Button
          size="sm"
          variant="outline"
          className="w-full text-xs h-8"
          onClick={onAddNote}
          data-testid="button-add-note-panel"
        >
          <StickyNote className="w-3 h-3 mr-1" />
          Add Note
        </Button>
      </div>
    </PanelSection>
  );
}

// Task #850: timeline rendering for a NoteEvent. Stylized as a sticky-note
// bubble centered in the timeline so it reads as out-of-band context, not
// an SMS message.
function NoteBubble({
  event, canDelete, onDelete,
}: {
  event: NoteEvent;
  canDelete: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="flex justify-center" data-testid={`note-bubble-${event.id}`}>
      <div className="w-full max-w-[78%] bg-amber-50 dark:bg-amber-950/25 border border-amber-200 dark:border-amber-800 rounded-xl px-3 py-2.5 shadow-sm">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded-full bg-amber-100 dark:bg-amber-950/35 text-amber-700 dark:text-amber-300 flex items-center justify-center flex-shrink-0">
            <StickyNote className="w-3.5 h-3.5" />
          </div>
          <div className="flex-1 min-w-0 text-xs">
            <span className="font-medium text-amber-900 dark:text-amber-200" data-testid={`note-author-${event.id}`}>
              {event.createdByName || "Note"}
            </span>
            <span className="text-amber-700 dark:text-amber-300/70"> · {format(event.ts, "h:mm a")}</span>
          </div>
          {canDelete && (
            <button
              type="button"
              className="text-caption text-red-600 dark:text-red-400 hover:underline flex-shrink-0"
              onClick={onDelete}
              data-testid={`button-delete-note-${event.id}`}
            >
              Delete
            </button>
          )}
        </div>
        <div className="text-sm text-amber-900 dark:text-amber-200 whitespace-pre-wrap break-words" data-testid={`note-body-${event.id}`}>
          {event.body}
        </div>
      </div>
    </div>
  );
}

function RecentActivityCard({ thread }: { thread: UnifiedThread }) {
  const callCount = thread.callIds.length;
  const smsConvCount = thread.smsConversationIds.length;
  return (
    <PanelSection title="Recent Activity" testId="panel-recent-activity">
      <ul className="space-y-1.5 text-xs">
        <li className="flex items-center gap-2">
          <Phone className="w-3 h-3 text-muted-foreground flex-shrink-0" />
          <span className="text-muted-foreground flex-1">Calls on file</span>
          <span className="font-medium" data-testid="text-call-count">{callCount}</span>
        </li>
        <li className="flex items-center gap-2">
          <MessageSquare className="w-3 h-3 text-muted-foreground flex-shrink-0" />
          <span className="text-muted-foreground flex-1">SMS threads</span>
          <span className="font-medium" data-testid="text-sms-thread-count">{smsConvCount}</span>
        </li>
        <li className="flex items-center gap-2">
          <Clock className="w-3 h-3 text-muted-foreground flex-shrink-0" />
          <span className="text-muted-foreground flex-1">Last activity</span>
          <span className="font-medium" data-testid="text-last-activity">
            {thread.lastActivityAt ? format(thread.lastActivityAt, "MMM d, h:mm a") : "—"}
          </span>
        </li>
        {thread.unreadSmsCount > 0 && (
          <li className="flex items-center gap-2">
            <AlertCircle className="w-3 h-3 text-amber-500 flex-shrink-0" />
            <span className="text-muted-foreground flex-1">Unread messages</span>
            <span className="font-medium text-amber-700 dark:text-amber-300" data-testid="text-unread-count">{thread.unreadSmsCount}</span>
          </li>
        )}
      </ul>
    </PanelSection>
  );
}

function EmptyTimeline({ onCompose }: { onCompose: () => void }) {
  return (
    <Card className="h-full flex flex-col items-center justify-center border-border/80 shadow-sm" data-testid="card-timeline-empty">
      <div className="text-center max-w-xs">
        <div className="w-16 h-16 rounded-full bg-primary/8 mx-auto mb-3 flex items-center justify-center" style={{ color: BURGUNDY }}>
          <MessageSquare className="w-7 h-7 opacity-70" />
        </div>
        <h3 className="text-base font-semibold mb-1" style={{ color: BURGUNDY }}>No conversation selected</h3>
        <p className="text-sm text-muted-foreground mb-4">Pick a thread on the left or start a new one.</p>
        <div className="flex justify-center gap-2">
          <Button onClick={onCompose} className="text-white" style={{ background: BURGUNDY }} data-testid="button-empty-new-message">
            <Plus className="w-4 h-4 mr-1.5" />
            New Message
          </Button>
        </div>
      </div>
    </Card>
  );
}

function EmptyState({
  icon: Icon, title, description, action, testId, brandMark,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  testId?: string;
  /** Task #4618: flagship empty states carry the earth bull mark (the soft
   * content-area brand variant — never crimson here) instead of the glyph. */
  brandMark?: boolean;
}) {
  return (
    <div className="text-center text-muted-foreground py-12 px-3" data-testid={testId}>
      {brandMark ? (
        <BrandMark kind="icon" variant="earth" className="h-10 w-auto mx-auto mb-3" />
      ) : (
        <Icon className="w-10 h-10 mx-auto mb-3 opacity-30" />
      )}
      <p className="font-medium text-sm mb-1 text-foreground">{title}</p>
      <p className="text-xs mb-3">{description}</p>
      {action && (
        <Button size="sm" onClick={action.onClick} className="text-white" style={{ background: BURGUNDY }} data-testid="button-empty-action">
          {action.label}
        </Button>
      )}
    </div>
  );
}

function NumberPickerDialog({
  state, onClose, onPick,
}: {
  state: { phones: string[]; thread: UnifiedThread } | null;
  onClose: () => void;
  onPick: (phone: string) => void;
}) {
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="dialog-number-picker">
        <DialogHeader>
          <DialogTitle>Pick a number to call</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          {state?.phones.map((phone) => (
            <button
              key={phone}
              onClick={() => onPick(phone)}
              className="w-full text-left p-3 rounded-lg border hover:bg-muted/50 flex items-center gap-3"
              data-testid={`button-number-pick-${phone}`}
            >
              <Phone className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">{formatPhone(phone)}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddParticipantDialog({
  open, onOpenChange, thread, onAdd, isPending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  thread: UnifiedThread | null;
  onAdd: (participants: Participant[]) => void;
  isPending: boolean;
}) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const clientId = thread?.clientId;

  const { data: clientContacts = [] } = useQuery<ClientContact[]>({
    queryKey: [`/api/clients/${clientId}/contacts`, "add-participant"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/contacts`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open && !!clientId,
  });

  const existingPhones = useMemo(() => {
    if (!thread) return new Set<string>();
    return new Set([
      ...thread.groupParticipants.map((p) => p.phone),
      ...(thread.contactPhone ? [thread.contactPhone] : []),
    ]);
  }, [thread]);

  const availableContacts = useMemo(
    () => clientContacts.filter((c) => c.phones?.some((p) => !existingPhones.has(p))),
    [clientContacts, existingPhones],
  );

  const handleAddContact = (contact: ClientContact, contactPhone: string) => {
    onAdd([{ phone: contactPhone, name: contact.name, contactId: contact.id }]);
  };

  const handleAddManual = () => {
    if (!phone.trim()) return;
    onAdd([{ phone: phone.trim(), name: name.trim() || undefined }]);
    setPhone("");
    setName("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-add-participant">
        <DialogHeader>
          <DialogTitle>Add Participant</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          {availableContacts.length > 0 && (
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">Client Contacts</label>
              <div className="space-y-1 border rounded-lg p-2">
                {availableContacts.map((contact) =>
                  contact.phones?.filter((p) => !existingPhones.has(p)).map((contactPhone) => (
                    <button
                      key={`${contact.id}-${contactPhone}`}
                      onClick={() => handleAddContact(contact, contactPhone)}
                      disabled={isPending}
                      className="w-full text-left p-2 rounded-md flex items-center gap-3 hover:bg-muted/50"
                      data-testid={`button-add-participant-${contact.id}`}
                    >
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center" style={{ color: BURGUNDY }}>
                        <User className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{contact.name}</p>
                        <p className="text-xs text-muted-foreground">{contactPhone}</p>
                      </div>
                    </button>
                  )),
                )}
              </div>
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-foreground mb-1.5 block">Or add manually</label>
            <div className="space-y-2">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" data-testid="input-add-participant-phone" />
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" data-testid="input-add-participant-name" />
              <Button
                onClick={handleAddManual}
                disabled={!phone.trim() || isPending}
                className="w-full text-white"
                style={{ background: BURGUNDY }}
                data-testid="button-add-participant-manual"
              >
                <UserPlus className="w-4 h-4 mr-2" />
                Add Participant
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Task #951: client picker dialog used to attach a client-less Twilio
// conversation to a client. Mirrors the search + list interaction from
// ComposeNewMessage's client section so operators have a familiar
// pattern. Only enabled for direct (non-group) threads — group threads
// don't currently expose a single conversation row to attach to.
//
// Task #968: same dialog now also drives reassignment when the existing
// linkage was wrong. `mode='reassign'` swaps the title + helper copy
// and visually marks the currently-linked client as the active choice
// so operators can see what they're changing away from.
function LinkClientDialog({
  open, onOpenChange, thread, onLink, isPending, mode = "link",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  thread: UnifiedThread | null;
  onLink: (clientId: string) => void;
  isPending: boolean;
  mode?: "link" | "reassign";
}) {
  const [search, setSearch] = useState("");

  const { data: allClients = [] } = useQuery<ClientBasic[]>({
    queryKey: ["/api/clients-basic-hub"],
    queryFn: async () => {
      const res = await fetch("/api/clients", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return (Array.isArray(data) ? data : []).map((c: Record<string, string>) => ({
        id: c.id,
        firmName: c.firmName || c.firm_name || "Unknown",
      }));
    },
    enabled: open,
  });

  // Task #969: ranked "Suggested" matches keyed off the thread's contact
  // phone — saved contact, prior matched calls/conversations. Hidden when
  // the user is actively searching so it doesn't fight the filter.
  type ClientSuggestion = { clientId: string; firmName: string; score: number; reasons: string[] };
  const suggestionPhone = thread?.contactPhone || "";
  const { data: suggestions = [] } = useQuery<ClientSuggestion[]>({
    queryKey: ["/api/twilio/client-suggestions", suggestionPhone],
    queryFn: async () => {
      const res = await fetch(`/api/twilio/client-suggestions?phone=${encodeURIComponent(suggestionPhone)}&limit=5`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open && suggestionPhone.replace(/\D/g, "").length >= 10,
    staleTime: 60_000,
  });

  const filteredClients = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allClients.slice(0, 50);
    return allClients.filter((c) => c.firmName.toLowerCase().includes(q)).slice(0, 100);
  }, [allClients, search]);

  const isSearching = search.trim().length > 0;
  const showSuggestions = !isSearching && suggestions.length > 0;

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const isReassign = mode === "reassign";
  const currentClientId = thread?.clientId ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-link-client">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-4 h-4" style={{ color: BURGUNDY }} />
            {isReassign ? "Change client" : "Link to client"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {isReassign && thread?.clientName ? (
            <p className="text-xs text-muted-foreground" data-testid="text-link-client-current">
              Currently linked to <strong>{thread.clientName}</strong>. Pick the firm this thread should belong to instead.
            </p>
          ) : thread?.contactPhone ? (
            <p className="text-xs text-muted-foreground" data-testid="text-link-client-phone">
              Pick the client this thread with {formatPhone(thread.contactPhone)} belongs to.
            </p>
          ) : null}
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients..."
            data-testid="input-link-client-search"
            autoFocus
          />

          {showSuggestions && (
            <div data-testid="section-link-client-suggestions">
              <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                Suggested
              </p>
              <div className="border rounded-lg overflow-hidden mb-2">
                {suggestions.map((s) => (
                  <button
                    key={`suggested-${s.clientId}`}
                    onClick={() => onLink(s.clientId)}
                    disabled={isPending}
                    className="w-full text-left p-2.5 hover:bg-muted/50 flex items-start gap-2 border-b last:border-b-0 disabled:opacity-50"
                    style={{ background: "hsl(var(--primary) / 0.04)" }}
                    data-testid={`button-link-client-suggested-${s.clientId}`}
                  >
                    <Building2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: BURGUNDY }} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate">{s.firmName}</span>
                      <span className="block text-xs text-muted-foreground truncate" data-testid={`text-link-client-suggested-reason-${s.clientId}`}>
                        {s.reasons.join(" · ")}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {showSuggestions && (
            <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
              All clients
            </p>
          )}
          <div className="max-h-[55vh] overflow-y-auto border rounded-lg">
            {filteredClients.length === 0 ? (
              <p className="text-sm text-muted-foreground p-3 text-center" data-testid="text-link-client-empty">
                {allClients.length === 0 ? "Loading clients..." : "No matching clients"}
              </p>
            ) : (
              filteredClients.map((c) => {
                const isCurrent = c.id === currentClientId;
                return (
                  <button
                    key={c.id}
                    onClick={() => onLink(c.id)}
                    disabled={isPending || isCurrent}
                    className={`w-full text-left p-2 text-sm flex items-center gap-2 border-b last:border-b-0 disabled:opacity-50 ${
                      isCurrent ? "bg-emerald-50/50 dark:bg-emerald-950/25 cursor-default" : "hover:bg-muted/50"
                    }`}
                    data-testid={`button-link-client-${c.id}`}
                  >
                    <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{c.firmName}</span>
                    {isCurrent && (
                      <span className="text-caption font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/35 px-1.5 py-0.5 rounded" data-testid={`badge-current-client-${c.id}`}>
                        Current
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NewCallDialer({
  open, onOpenChange, threads, onPlaceCall, initialPhone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  threads: UnifiedThread[];
  onPlaceCall: (phone: string, displayName: string | null) => void;
  initialPhone?: string;
}) {
  const [search, setSearch] = useState("");
  const [manualPhone, setManualPhone] = useState("");
  const [composeClientId, setComposeClientId] = useState("");

  // Pre-fill phone when the dialer is opened via a deep-link.
  useEffect(() => {
    if (open && initialPhone && !manualPhone) {
      setManualPhone(initialPhone);
    }
  // Only fire when the dialer opens or the initial phone changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPhone]);
  const [showClientPicker, setShowClientPicker] = useState(false);

  // Task #964: debounced "did you mean this client?" lookup driven by the
  // manual phone input — mirrors the New Message composer (Task #950) so a
  // raw outbound dial that actually belongs to a known client contact gets
  // auto-attributed instead of landing as an unmatched outbound call.
  const [debouncedPhone, setDebouncedPhone] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedPhone(manualPhone.trim()), 200);
    return () => clearTimeout(t);
  }, [manualPhone]);
  const debouncedDigitCount = debouncedPhone.replace(/\D/g, "").length;
  type ContactSuggestion = { clientId: string; firmName: string; contactId: string; contactName: string; phone: string };
  const { data: phoneSuggestions = [] } = useQuery<ContactSuggestion[]>({
    queryKey: ["/api/twilio/client-contacts/search", debouncedPhone],
    queryFn: async () => {
      const res = await fetch(`/api/twilio/client-contacts/search?phone=${encodeURIComponent(debouncedPhone)}&limit=3`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open && debouncedDigitCount >= 4,
    staleTime: 30_000,
  });

  // Task #981: ranked client suggestions for the typed number — surfaces
  // "this number had prior matched calls to firm X" so a manually-dialed
  // outbound number gets attributed even when no saved contact exists.
  type ClientSuggestion = { clientId: string; firmName: string; score: number; reasons: string[] };
  const { data: clientSuggestions = [] } = useQuery<ClientSuggestion[]>({
    queryKey: ["/api/twilio/client-suggestions", debouncedPhone],
    queryFn: async () => {
      const res = await fetch(`/api/twilio/client-suggestions?phone=${encodeURIComponent(debouncedPhone)}&limit=5`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open && debouncedDigitCount >= 10,
    staleTime: 60_000,
  });
  const contactSuggestionClientIds = useMemo(
    () => new Set(phoneSuggestions.map((s) => s.clientId)),
    [phoneSuggestions],
  );
  const filteredClientSuggestions = useMemo(
    () => clientSuggestions.filter((s) => !contactSuggestionClientIds.has(s.clientId)),
    [clientSuggestions, contactSuggestionClientIds],
  );

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return threads.slice(0, 25);
    return threads.filter((t) => {
      if (t.isGroup) return false;
      if (!t.contactPhone) return false;
      if (t.displayName.toLowerCase().includes(q)) return true;
      if (t.contactPhone.includes(q)) return true;
      if (t.clientName && t.clientName.toLowerCase().includes(q)) return true;
      return false;
    }).slice(0, 50);
  }, [threads, search]);

  const { data: allClients = [] } = useQuery<ClientBasic[]>({
    queryKey: ["/api/clients-basic-hub"],
    queryFn: async () => {
      const res = await fetch("/api/clients", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return (Array.isArray(data) ? data : []).map((c: Record<string, string>) => ({
        id: c.id,
        firmName: c.firmName || c.firm_name || "Unknown",
      }));
    },
    enabled: open && showClientPicker,
  });

  const { data: clientContacts = [] } = useQuery<ClientContact[]>({
    queryKey: [`/api/clients/${composeClientId}/contacts`, "new-call"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${composeClientId}/contacts`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open && !!composeClientId,
  });

  const contactsWithPhones = useMemo(() => clientContacts.filter((c) => c.phones && c.phones.length > 0), [clientContacts]);
  const filteredClients = useMemo(() => {
    if (!search.trim()) return allClients.slice(0, 30);
    const q = search.toLowerCase();
    return allClients.filter((c) => c.firmName.toLowerCase().includes(q)).slice(0, 50);
  }, [allClients, search]);

  const reset = () => {
    setSearch("");
    setManualPhone("");
    setComposeClientId("");
    setShowClientPicker(false);
  };

  const handleManual = () => {
    const phone = manualPhone.trim();
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) return;
    onPlaceCall(phone, null);
    reset();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent data-testid="dialog-new-call">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PhoneCall className="w-4 h-4" style={{ color: BURGUNDY }} />
            New Call
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Enter a number</label>
            <div className="flex gap-2">
              <Input
                value={manualPhone}
                onChange={(e) => setManualPhone(e.target.value)}
                placeholder="(555) 123-4567"
                onKeyDown={(e) => e.key === "Enter" && handleManual()}
                data-testid="input-new-call-phone"
              />
              <Button
                onClick={handleManual}
                disabled={manualPhone.replace(/\D/g, "").length < 10}
                className="text-white"
                style={{ background: BURGUNDY }}
                data-testid="button-new-call-place"
              >
                <PhoneCall className="w-4 h-4 mr-1" />
                Call
              </Button>
            </div>
            {(phoneSuggestions.length > 0 || filteredClientSuggestions.length > 0) && (
              <div className="mt-2 border rounded-lg overflow-hidden" data-testid="list-new-call-phone-suggestions">
                <p className="text-caption uppercase tracking-wide text-muted-foreground px-2 pt-1.5 pb-1 bg-muted/50">
                  Did you mean…
                </p>
                {phoneSuggestions.map((s) => (
                  <button
                    key={`${s.contactId}-${s.phone}`}
                    type="button"
                    onClick={() => { onPlaceCall(s.phone, s.contactName); reset(); }}
                    className="w-full text-left px-2 py-1.5 hover:bg-muted/50 flex items-center gap-2 border-t first:border-t-0"
                    data-testid={`button-new-call-phone-suggestion-${s.contactId}-${s.phone}`}
                  >
                    <Building2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: BURGUNDY }} />
                    <span className="text-sm truncate">
                      <span className="font-medium">{s.firmName}</span>
                      <span className="text-muted-foreground"> — {s.contactName}</span>
                      <span className="text-muted-foreground"> ({formatPhone(s.phone)})</span>
                    </span>
                  </button>
                ))}
                {filteredClientSuggestions.map((s) => (
                  <button
                    key={`client-suggestion-${s.clientId}`}
                    type="button"
                    onClick={() => {
                      // Use the debounced phone that actually produced this
                      // suggestion list, not the current input — guards
                      // against the user editing the field between the
                      // last query and the click.
                      const phone = debouncedPhone;
                      if (phone.replace(/\D/g, "").length < 10) return;
                      onPlaceCall(phone, s.firmName);
                      reset();
                    }}
                    className="w-full text-left px-2 py-1.5 hover:bg-muted/50 flex items-start gap-2 border-t first:border-t-0"
                    style={{ background: "hsl(var(--primary) / 0.04)" }}
                    data-testid={`button-new-call-client-suggestion-${s.clientId}`}
                  >
                    <Building2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: BURGUNDY }} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate">{s.firmName}</span>
                      <span className="block text-xs text-muted-foreground truncate" data-testid={`text-new-call-client-suggestion-reason-${s.clientId}`}>
                        {s.reasons.join(" · ")}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Recent contacts</label>
            <div className="relative mb-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search recent or clients..."
                className="pl-9"
                data-testid="input-new-call-search"
              />
            </div>
            {matches.length === 0 ? (
              <p className="text-xs text-muted-foreground italic px-1">No recent contacts match.</p>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto border rounded-lg p-1">
                {matches.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => { onPlaceCall(t.contactPhone!, t.displayName); reset(); }}
                    className="w-full text-left p-2 rounded-md hover:bg-muted/50 flex items-center gap-3"
                    data-testid={`button-new-call-recent-${t.key}`}
                  >
                    <Avatar initials={getInitials(t.contactName, t.contactPhone)} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{t.displayName}</div>
                      <div className="text-xs text-muted-foreground">{formatPhone(t.contactPhone)}</div>
                    </div>
                    <PhoneCall className="w-4 h-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <button
              onClick={() => setShowClientPicker((v) => !v)}
              className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1 hover:text-foreground"
              data-testid="button-toggle-client-contacts"
            >
              <Building2 className="w-3 h-3" />
              {showClientPicker ? "Hide client contacts" : "Pick from a client"}
            </button>
            {showClientPicker && (
              <div className="mt-2 space-y-2">
                {!composeClientId ? (
                  <div className="space-y-1 max-h-40 overflow-y-auto border rounded-lg">
                    {filteredClients.length === 0 ? (
                      <p className="text-xs text-muted-foreground p-3 text-center">No matching clients</p>
                    ) : (
                      filteredClients.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => setComposeClientId(c.id)}
                          className="w-full text-left p-2 text-sm hover:bg-muted/50 flex items-center gap-2 border-b last:border-b-0"
                          data-testid={`button-new-call-client-${c.id}`}
                        >
                          <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
                          {c.firmName}
                        </button>
                      ))
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 p-2 border rounded-lg bg-muted/50">
                      <Building2 className="w-4 h-4" style={{ color: BURGUNDY }} />
                      <span className="text-sm font-medium flex-1">
                        {allClients.find((c) => c.id === composeClientId)?.firmName || ""}
                      </span>
                      <button onClick={() => setComposeClientId("")} className="text-muted-foreground hover:text-muted-foreground" data-testid="button-clear-new-call-client">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    {contactsWithPhones.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic px-1">No contacts with phone numbers.</p>
                    ) : (
                      <div className="space-y-1 max-h-48 overflow-y-auto border rounded-lg p-1">
                        {contactsWithPhones.map((contact) =>
                          contact.phones?.map((phone) => (
                            <button
                              key={`${contact.id}-${phone}`}
                              onClick={() => { onPlaceCall(phone, contact.name); reset(); }}
                              className="w-full text-left p-2 rounded-md hover:bg-muted/50 flex items-center gap-3"
                              data-testid={`button-new-call-contact-${contact.id}-${phone}`}
                            >
                              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center" style={{ color: BURGUNDY }}>
                                <User className="w-4 h-4" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium truncate">{contact.name}</div>
                                <div className="text-xs text-muted-foreground">{formatPhone(phone)}</div>
                              </div>
                              <PhoneCall className="w-4 h-4 text-muted-foreground" />
                            </button>
                          )),
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ComposeNewMessage({
  onCancel, onSend, isPending, initialPhone, initialClientId,
}: {
  onCancel: () => void;
  onSend: (payload: { clientId: string | null; contacts: Participant[]; body: string }) => void;
  isPending: boolean;
  initialPhone?: string;
  initialClientId?: string;
}) {
  const [composeClientId, setComposeClientId] = useState(initialClientId ?? "");
  const [clientSearchQuery, setClientSearchQuery] = useState("");
  const [composeSelectedContacts, setComposeSelectedContacts] = useState<Array<{ phone: string; name: string; contactId?: string }>>([]);
  const [composeMessage, setComposeMessage] = useState("");
  const [composeManualPhone, setComposeManualPhone] = useState(initialPhone ?? "");
  const [manualPhoneError, setManualPhoneError] = useState<string | null>(null);

  // Task #950: debounced "did you mean this client?" lookup driven by the
  // manual phone input. We hold a separate `debouncedPhone` so the network
  // call doesn't fire on every keystroke.
  const [debouncedPhone, setDebouncedPhone] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedPhone(composeManualPhone.trim()), 200);
    return () => clearTimeout(t);
  }, [composeManualPhone]);
  const debouncedDigitCount = debouncedPhone.replace(/\D/g, "").length;
  type ContactSuggestion = { clientId: string; firmName: string; contactId: string; contactName: string; phone: string };
  const { data: phoneSuggestions = [] } = useQuery<ContactSuggestion[]>({
    queryKey: ["/api/twilio/client-contacts/search", debouncedPhone],
    queryFn: async () => {
      const res = await fetch(`/api/twilio/client-contacts/search?phone=${encodeURIComponent(debouncedPhone)}&limit=3`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: debouncedDigitCount >= 4,
    staleTime: 30_000,
  });

  // Task #981: ranked client suggestions for the typed number — surfaces
  // "this number had prior matched calls to firm X" so a manually-typed
  // outbound recipient gets attributed even when no saved contact exists.
  type ClientSuggestion = { clientId: string; firmName: string; score: number; reasons: string[] };
  const { data: clientSuggestions = [] } = useQuery<ClientSuggestion[]>({
    queryKey: ["/api/twilio/client-suggestions", debouncedPhone],
    queryFn: async () => {
      const res = await fetch(`/api/twilio/client-suggestions?phone=${encodeURIComponent(debouncedPhone)}&limit=5`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: debouncedDigitCount >= 10,
    staleTime: 60_000,
  });
  const contactSuggestionClientIds = useMemo(
    () => new Set(phoneSuggestions.map((s) => s.clientId)),
    [phoneSuggestions],
  );
  const filteredClientSuggestions = useMemo(
    () => clientSuggestions.filter((s) => !contactSuggestionClientIds.has(s.clientId)),
    [clientSuggestions, contactSuggestionClientIds],
  );

  const { data: allClients = [] } = useQuery<ClientBasic[]>({
    queryKey: ["/api/clients-basic-hub"],
    queryFn: async () => {
      const res = await fetch("/api/clients", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return (Array.isArray(data) ? data : []).map((c: Record<string, string>) => ({ id: c.id, firmName: c.firmName || c.firm_name || "Unknown" }));
    },
  });

  const { data: clientContacts = [] } = useQuery<ClientContact[]>({
    queryKey: [`/api/clients/${composeClientId}/contacts`, "compose"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${composeClientId}/contacts`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!composeClientId,
  });

  const contactsWithPhones = useMemo(() => clientContacts.filter((c) => c.phones && c.phones.length > 0), [clientContacts]);

  const filteredClients = useMemo(() => {
    if (!clientSearchQuery.trim()) return allClients;
    const q = clientSearchQuery.toLowerCase();
    return allClients.filter((c) => c.firmName.toLowerCase().includes(q));
  }, [allClients, clientSearchQuery]);

  const selectedClientName = allClients.find((c) => c.id === composeClientId)?.firmName;

  const handleAddContact = (contact: ClientContact, phone: string) => {
    if (composeSelectedContacts.some((c) => c.phone === phone)) return;
    setComposeSelectedContacts((prev) => [...prev, { phone, name: contact.name, contactId: contact.id }]);
  };

  const handleRemoveContact = (phone: string) => {
    setComposeSelectedContacts((prev) => prev.filter((c) => c.phone !== phone));
  };

  // Task #950: pick a client-contact suggestion. This selects the client,
  // adds the contact (with its real name + saved phone) as a recipient,
  // and clears the manual phone input — exactly as if the user had picked
  // the contact from the client's contact list below.
  const handlePickSuggestion = (s: ContactSuggestion) => {
    setComposeClientId(s.clientId);
    setComposeSelectedContacts((prev) => {
      if (prev.some((c) => c.phone === s.phone)) return prev;
      return [...prev, { phone: s.phone, name: s.contactName, contactId: s.contactId }];
    });
    setComposeManualPhone("");
    setManualPhoneError(null);
  };

  // Task #981: pick a ranked client suggestion. Unlike the contact-level
  // suggestion above, there's no saved contact yet — so we attribute the
  // typed phone to the suggested client and add it as a recipient using
  // the firm name as the display label. We bind to `debouncedPhone` (the
  // exact value that produced the suggestion list) instead of the raw
  // input to guard against the user editing the field between the last
  // query and the click.
  const handlePickClientSuggestion = (s: ClientSuggestion) => {
    const phone = debouncedPhone;
    if (!phone || phone.replace(/\D/g, "").length < 10) return;
    setComposeClientId(s.clientId);
    setComposeSelectedContacts((prev) => {
      if (prev.some((c) => c.phone === phone)) return prev;
      return [...prev, { phone, name: s.firmName }];
    });
    setComposeManualPhone("");
    setManualPhoneError(null);
  };

  const handleAddManualPhone = () => {
    const phone = composeManualPhone.trim();
    if (!phone) {
      setManualPhoneError("Enter a phone number");
      return;
    }
    const digitCount = phone.replace(/\D/g, "").length;
    if (digitCount < 7) {
      setManualPhoneError("Enter a valid phone number (at least 7 digits, e.g. +1 555 123 4567)");
      return;
    }
    if (composeSelectedContacts.some((c) => c.phone === phone)) {
      setManualPhoneError("That number is already added");
      return;
    }
    setComposeSelectedContacts((prev) => [...prev, { phone, name: phone }]);
    setComposeManualPhone("");
    setManualPhoneError(null);
  };

  const handleSend = () => {
    if (composeSelectedContacts.length === 0 || !composeMessage.trim()) return;
    onSend({
      clientId: composeClientId || null,
      contacts: composeSelectedContacts,
      body: composeMessage.trim(),
    });
  };

  return (
    <Card className="h-full flex flex-col overflow-hidden border-border/80 shadow-sm" data-testid="compose-panel">
      <CardHeader className="pb-2 flex-shrink-0 border-b">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} data-testid="button-cancel-compose">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <CardTitle className="text-base" style={{ color: BURGUNDY }}>New Message</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">To</label>
          {composeSelectedContacts.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {composeSelectedContacts.map((c) => (
                <Badge key={c.phone} variant="secondary" className="pl-2 pr-1 py-1 bg-primary/10 text-primary text-xs flex items-center gap-1" data-testid={`chip-recipient-${c.phone}`}>
                  <User className="w-3 h-3" />
                  {c.name}
                  <span className="text-caption text-muted-foreground ml-0.5">{c.phone}</span>
                  <button onClick={() => handleRemoveContact(c.phone)} className="ml-1 hover:bg-primary/20 rounded p-0.5" data-testid={`button-remove-recipient-${c.phone}`}>
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              value={composeManualPhone}
              onChange={(e) => { setComposeManualPhone(e.target.value); if (manualPhoneError) setManualPhoneError(null); }}
              placeholder="Enter phone number (e.g. +1 555 123 4567)"
              className="flex-1"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddManualPhone(); } }}
              data-testid="input-compose-manual-phone-top"
            />
            <Button variant="outline" size="sm" onClick={handleAddManualPhone} disabled={!composeManualPhone.trim()} data-testid="button-add-manual-phone-top">
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          {manualPhoneError && (
            <p className="text-xs mt-1 text-red-600 dark:text-red-400" data-testid="text-manual-phone-error">{manualPhoneError}</p>
          )}
          {(phoneSuggestions.length > 0 || filteredClientSuggestions.length > 0) && (
            <div className="mt-2 border rounded-lg overflow-hidden" data-testid="list-phone-suggestions">
              <p className="text-caption uppercase tracking-wide text-muted-foreground px-2 pt-1.5 pb-1 bg-muted/50">
                Did you mean…
              </p>
              {phoneSuggestions.map((s) => (
                <button
                  key={`${s.contactId}-${s.phone}`}
                  type="button"
                  onClick={() => handlePickSuggestion(s)}
                  className="w-full text-left px-2 py-1.5 hover:bg-muted/50 flex items-center gap-2 border-t first:border-t-0"
                  data-testid={`button-phone-suggestion-${s.contactId}-${s.phone}`}
                >
                  <Building2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: BURGUNDY }} />
                  <span className="text-sm truncate">
                    <span className="font-medium">{s.firmName}</span>
                    <span className="text-muted-foreground"> — {s.contactName}</span>
                    <span className="text-muted-foreground"> ({formatPhone(s.phone)})</span>
                  </span>
                </button>
              ))}
              {filteredClientSuggestions.map((s) => (
                <button
                  key={`client-suggestion-${s.clientId}`}
                  type="button"
                  onClick={() => handlePickClientSuggestion(s)}
                  className="w-full text-left px-2 py-1.5 hover:bg-muted/50 flex items-start gap-2 border-t first:border-t-0"
                  style={{ background: "hsl(var(--primary) / 0.04)" }}
                  data-testid={`button-client-suggestion-${s.clientId}`}
                >
                  <Building2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: BURGUNDY }} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium truncate">{s.firmName}</span>
                    <span className="block text-xs text-muted-foreground truncate" data-testid={`text-client-suggestion-reason-${s.clientId}`}>
                      {s.reasons.join(" · ")}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <p className="text-xs mt-1 text-muted-foreground">Type a number to start a conversation, or pick a client below to choose from their contacts.</p>
        </div>

        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">Client (optional)</label>
          {composeClientId && selectedClientName ? (
            <div className="flex items-center gap-2 p-2 border rounded-lg bg-muted/50">
              <Building2 className="w-4 h-4" style={{ color: BURGUNDY }} />
              <span className="font-medium text-sm flex-1">{selectedClientName}</span>
              <button onClick={() => { setComposeClientId(""); setComposeSelectedContacts([]); }} className="text-muted-foreground hover:text-muted-foreground" data-testid="button-clear-client">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="space-y-1">
              <Input
                value={clientSearchQuery}
                onChange={(e) => setClientSearchQuery(e.target.value)}
                placeholder="Search clients..."
                data-testid="input-search-clients"
              />
              {clientSearchQuery.trim() || allClients.length <= 10 ? (
                <div className="max-h-40 overflow-y-auto border rounded-lg">
                  {filteredClients.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-3 text-center">No matching clients</p>
                  ) : (
                    filteredClients.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => setComposeClientId(c.id)}
                        className="w-full text-left p-2 text-sm hover:bg-muted/50 flex items-center gap-2 border-b last:border-b-0"
                        data-testid={`button-select-client-${c.id}`}
                      >
                        <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
                        {c.firmName}
                      </button>
                    ))
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground px-1">Type to search {allClients.length} clients</p>
              )}
            </div>
          )}
        </div>

        {composeClientId && (
          <div>
            <label className="text-sm font-medium text-foreground mb-1.5 block">Client contacts</label>

            {contactsWithPhones.length > 0 ? (
              <div className="space-y-1 max-h-48 overflow-y-auto border rounded-lg p-2">
                {contactsWithPhones.map((contact) =>
                  contact.phones?.map((phone) => {
                    const isSelected = composeSelectedContacts.some((c) => c.phone === phone);
                    return (
                      <button
                        key={`${contact.id}-${phone}`}
                        onClick={() => !isSelected && handleAddContact(contact, phone)}
                        className={`w-full text-left p-2 rounded-md flex items-center gap-3 transition-colors ${
                          isSelected ? "bg-primary/5 opacity-50" : "hover:bg-muted/50"
                        }`}
                        disabled={isSelected}
                        data-testid={`button-add-contact-${contact.id}-${phone}`}
                      >
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0" style={{ color: BURGUNDY }}>
                          <User className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{contact.name}</p>
                          <p className="text-xs text-muted-foreground">{phone} {contact.roleTitle ? `· ${contact.roleTitle}` : ""}</p>
                        </div>
                        {isSelected && <Check className="w-4 h-4" style={{ color: BURGUNDY }} />}
                      </button>
                    );
                  }),
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">No contacts with phone numbers for this client</p>
            )}

            <div className="mt-2 flex gap-2">
              <Input
                value={composeManualPhone}
                onChange={(e) => setComposeManualPhone(e.target.value)}
                placeholder="Or enter a phone number manually..."
                className="flex-1"
                onKeyDown={(e) => e.key === "Enter" && handleAddManualPhone()}
                data-testid="input-manual-phone"
              />
              <Button variant="outline" size="sm" onClick={handleAddManualPhone} disabled={!composeManualPhone.trim()}>
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            {composeSelectedContacts.length > 1 && (
              <p className="text-xs mt-2 flex items-center gap-1" style={{ color: BURGUNDY }}>
                <Users className="w-3 h-3" />
                Group message — will be sent to {composeSelectedContacts.length} recipients
              </p>
            )}
          </div>
        )}

        {composeSelectedContacts.length > 0 && (
          <div>
            <label className="text-sm font-medium text-foreground mb-1.5 block">Message</label>
            <Textarea
              value={composeMessage}
              onChange={(e) => setComposeMessage(e.target.value)}
              placeholder="Type your message..."
              rows={4}
              data-testid="input-compose-message"
            />
          </div>
        )}
      </CardContent>
      {composeSelectedContacts.length > 0 && (
        <div className="p-3 border-t flex-shrink-0 bg-card">
          <Button
            onClick={handleSend}
            disabled={!composeMessage.trim() || isPending}
            className="w-full text-white"
            style={{ background: BURGUNDY }}
            data-testid="button-send-compose"
          >
            <Send className="w-4 h-4 mr-2" />
            {isPending ? "Sending..." : composeSelectedContacts.length > 1 ? `Send to ${composeSelectedContacts.length} recipients` : "Send Message"}
          </Button>
        </div>
      )}
    </Card>
  );
}
