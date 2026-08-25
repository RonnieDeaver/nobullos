/**
 * Global Comms Provider — owns the single shared SSE connection,
 * channel list, unread counts, presence, popup state, and rail state.
 *
 * Mounted in the App shell next to GlobalAppNav; gated behind the same
 * authenticated / non-public-route check so it never runs on booking pages,
 * pulse links, share tokens, etc.
 *
 * Consumers (Comms.tsx page, CommsRail, CommsPopupManager) all read from
 * this context instead of each opening their own SSE connection.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { shouldRenderGlobalQuicklinksBar } from "@/lib/quicklinksVisibility";
import {
  nextSseReconnectState,
  SSE_MAX_CONSECUTIVE_FAILURES,
} from "@/lib/sseReconnect";
import type {
  CommsChannel,
  CommsDraft,
  CommsFollowedThread,
  CommsThreadUnreadSummary,
  CommsUserNotificationSettings,
  PopupEntry,
  CommsUserStatusResponse,
  CommsSidebarCategoryResponse,
} from "@/components/comms/types";
import { useDesktopNotifications } from "@/components/comms/useDesktopNotifications";

const SSE_EVENT_TYPES = [
  "comms:message",
  "comms:message_edit",
  "comms:message_delete",
  "comms:reaction",
  "comms:read_state",
  "comms:typing",
  "comms:presence",
  "comms:call",
  "comms:pin",
  "comms:member_change",
  "comms:channel_update",
  "comms:user_status",
  "comms:draft",
  "comms:scheduled_message",
  "comms:bookmark",
  "comms:thread_follow",
  "comms:thread_unread",
  "comms:sidebar",
] as const;

const RAIL_LS_KEY = "comms_rail_open";
const PINNED_LS_KEY = "comms_pinned_channels";
const POPUPS_SS_KEY = "comms_open_popups";
const MAX_POPUPS = 3;

function loadPersistedPopups(): PopupEntry[] {
  try {
    const raw = sessionStorage.getItem(POPUPS_SS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is PopupEntry =>
          !!p && typeof p.channelId === "string" && typeof p.minimized === "boolean",
      )
      .slice(0, MAX_POPUPS);
  } catch {
    return [];
  }
}

// ─── Context types ────────────────────────────────────────────────────────────

interface CommsContextValue {
  channels: CommsChannel[];
  /** True once the channel list has loaded successfully at least once. */
  channelsLoaded: boolean;
  onlineUserIds: string[];
  /** Total unread messages across all non-muted channels. */
  totalUnread: number;
  /** Total mention-style unreads (direct mentions + all DM unreads). */
  totalMentions: number;

  /** channelId → draft for channels where the current user has a saved draft */
  draftsByChannelId: Map<string, CommsDraft>;
  /** Manually refresh draft list (called after sending a draft or explicit clear). */
  refetchDrafts: () => void;

  popups: PopupEntry[];
  openPopup: (channelId: string) => void;
  closePopup: (channelId: string) => void;
  setPopupMinimized: (channelId: string, minimized: boolean) => void;
  /**
   * Move an already-open popup to the end of the list (newest position) and
   * un-minimize it. Used on narrow viewports where only the newest popup
   * expands — tapping an older popup's bar promotes it to the front.
   */
  promotePopup: (channelId: string) => void;

  /**
   * Archived channels are not included in the main `channels` list.
   * When a user opens an archived channel from the rail, it is registered
   * here so popup resolution and pruning work correctly.
   */
  archivedChannelOverrides: Record<string, CommsChannel>;
  registerArchivedChannel: (channel: CommsChannel) => void;

  railOpen: boolean;
  toggleRail: () => void;
  /** Derived from the server-side favorites category. Kept for backward-compat
   *  with CommsRail and Comms.tsx which use this to drive the "Favorites" section. */
  pinnedChannelIds: string[];
  /** Toggles a channel in the server-side favorites category and emits an SSE
   *  sidebar event so other sessions stay in sync. Calls the server; best-effort
   *  optimistic update is applied immediately via the in-memory favorites set. */
  togglePin: (channelId: string) => void;

  /** Subscribe to raw SSE events (e.g. for typing indicators, call banners). */
  addSseListener: (fn: (e: MessageEvent) => void) => () => void;

  refetchChannels: () => void;

  /** Own status, fetched once on mount and kept in sync via SSE. */
  myStatus: CommsUserStatusResponse | null;
  /** Effective status map for other users — keyed by userId, updated via SSE. */
  userStatuses: Map<string, CommsUserStatusResponse>;

  /** Current user's global notification preferences; null until loaded. */
  notificationSettings: CommsUserNotificationSettings | null;
  /** Partially update notification settings (saves immediately to server). */
  updateNotificationSettings: (patch: Partial<CommsUserNotificationSettings>) => Promise<void>;

  // ── Thread following ──────────────────────────────────────────────────────
  /** Total unread thread replies across all followed threads. */
  totalThreadUnread: number;
  /** Total thread mention unreads. */
  totalThreadMentions: number;
  /** Refresh the thread unread summary (e.g. after marking a thread read). */
  refetchThreadSummary: () => Promise<void>;
  /** Followed threads list — lazy-loaded when the Threads view opens. */
  followedThreads: CommsFollowedThread[];
  /** Refresh the followed threads list. */
  refetchFollowedThreads: () => Promise<void>;

  // ── Sidebar categories ──────────────────────────────────────────────────
  /** All sidebar categories for the current user, ordered by sortOrder. */
  sidebarCategories: CommsSidebarCategoryResponse[];
  /** Re-fetch sidebar categories (called after mutations). */
  refetchSidebarCategories: () => void;
  /** Create a new custom sidebar category. */
  createSidebarCategory: (name: string) => Promise<CommsSidebarCategoryResponse | null>;
  /** Update a sidebar category (name, collapsed, clientSubgroupCollapsed, sorting, unreadsOnTop). */
  updateSidebarCategory: (
    id: string,
    data: { name?: string; collapsed?: boolean; clientSubgroupCollapsed?: boolean; sorting?: "recent" | "alpha" | "manual"; unreadsOnTop?: boolean },
  ) => Promise<void>;
  /** Delete a custom sidebar category. */
  deleteSidebarCategory: (id: string) => Promise<void>;
  /** Reorder all categories for the current user. */
  reorderSidebarCategories: (orderedIds: string[]) => Promise<void>;
  /**
   * Move a channel between categories. `fromCategoryId` may be null when the
   * channel is not explicitly assigned anywhere (e.g. dragged from a built-in
   * Channels/DMs section). `toCategoryId` may be null to only remove the
   * explicit assignment (dropping back onto a built-in Channels/DMs section).
   */
  moveChannelToCategory: (
    channelId: string,
    fromCategoryId: string | null,
    toCategoryId: string | null,
  ) => Promise<void>;
  /** Reorder the channels within a category (manual sorting). */
  reorderCategoryItems: (categoryId: string, orderedChannelIds: string[]) => Promise<void>;
}

// ─── Store bridge (Task #3838) ───────────────────────────────────────────────
//
// The provider holds live-updating state (channels, presence, unread counts,
// statuses) that changes on every SSE event. If that state were published
// through a plain React context value, EVERY consumer — including ones that
// only need a stable slice — would re-render on every chat event.
//
// Instead the context carries a STABLE store object (identity never changes),
// and consumers subscribe via useSyncExternalStore:
//   - useCommsSelector(fn) re-renders only when the selected slice changes
//     (Object.is on the selection) — used by non-comms surfaces like
//     GlobalTitleManager so busy chat activity leaves the rest of the app idle.
//   - useCommsContext() subscribes to the whole snapshot — comms surfaces
//     (rail, popups, Comms page) keep today's behavior unchanged.

interface CommsStore {
  getSnapshot: () => CommsContextValue;
  subscribe: (listener: () => void) => () => void;
}

const CommsContext = createContext<CommsStore | null>(null);

export function useCommsSelector<T>(selector: (state: CommsContextValue) => T): T {
  const store = useContext(CommsContext);
  if (!store) throw new Error("useCommsSelector must be used inside CommsProvider");

  // Keep the latest selector without re-subscribing, and cache the last
  // selection so an unchanged slice returns the SAME reference — that is what
  // lets useSyncExternalStore skip the re-render for unrelated updates.
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef<{ snapshot: CommsContextValue; selection: T } | null>(null);

  const getSelection = useCallback((): T => {
    const snapshot = store.getSnapshot();
    const cache = cacheRef.current;
    if (cache && cache.snapshot === snapshot) return cache.selection;
    const next = selectorRef.current(snapshot);
    if (cache && Object.is(cache.selection, next)) {
      cacheRef.current = { snapshot, selection: cache.selection };
      return cache.selection;
    }
    cacheRef.current = { snapshot, selection: next };
    return next;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}

export function useCommsContext(): CommsContextValue {
  // Whole-snapshot subscription: re-renders on every provider update, exactly
  // like the pre-store context did. Comms surfaces use this deliberately.
  return useCommsSelector((s) => s);
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function CommsProvider({ children }: { children: ReactNode }) {
  const [pathname] = useLocation();
  const { user, isAuthenticated } = useAuth();
  const qc = useQueryClient();

  const isInternal = isAuthenticated && !!user && shouldRenderGlobalQuicklinksBar(pathname);

  return isInternal ? (
    <CommsProviderInner>{children}</CommsProviderInner>
  ) : (
    <CommsContext.Provider value={NULL_STORE}>
      {children}
    </CommsContext.Provider>
  );
}

// Stable null context so consumers on public routes never crash
const NULL_CONTEXT: CommsContextValue = {
  channels: [],
  channelsLoaded: false,
  onlineUserIds: [],
  totalUnread: 0,
  totalMentions: 0,
  draftsByChannelId: new Map(),
  refetchDrafts: () => {},
  popups: [],
  openPopup: () => {},
  closePopup: () => {},
  setPopupMinimized: () => {},
  promotePopup: () => {},
  archivedChannelOverrides: {},
  registerArchivedChannel: () => {},
  railOpen: false,
  toggleRail: () => {},
  totalThreadUnread: 0,
  totalThreadMentions: 0,
  refetchThreadSummary: () => Promise.resolve(),
  followedThreads: [],
  refetchFollowedThreads: () => Promise.resolve(),
  pinnedChannelIds: [],
  togglePin: () => {},
  addSseListener: () => () => {},
  refetchChannels: () => {},
  notificationSettings: null,
  updateNotificationSettings: async () => {},
  myStatus: null,
  userStatuses: new Map(),
  sidebarCategories: [],
  refetchSidebarCategories: () => {},
  createSidebarCategory: () => Promise.resolve(null),
  updateSidebarCategory: async () => {},
  deleteSidebarCategory: async () => {},
  reorderSidebarCategories: async () => {},
  moveChannelToCategory: async () => {},
  reorderCategoryItems: async () => {},
};

// Static store wrapping the null context — never notifies, snapshot never changes.
const NULL_STORE: CommsStore = {
  getSnapshot: () => NULL_CONTEXT,
  subscribe: () => () => {},
};

function CommsProviderInner({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { user } = useAuth();

  // ── channel list ────────────────────────────────────────────────────────────
  const [channels, setChannels] = useState<CommsChannel[]>([]);
  const [channelsLoaded, setChannelsLoaded] = useState(false);

  // ── user status ─────────────────────────────────────────────────────────────
  const [myStatus, setMyStatus] = useState<CommsUserStatusResponse | null>(null);
  const [userStatuses, setUserStatuses] = useState<Map<string, CommsUserStatusResponse>>(
    () => new Map(),
  );

  // ── notification settings ────────────────────────────────────────────────────
  const [notificationSettings, setNotificationSettings] =
    useState<CommsUserNotificationSettings | null>(null);

  const fetchNotificationSettings = useCallback(async () => {
    try {
      const data = await apiRequest("GET", "/api/comms/notification-settings").then((r) => r.json());
      if (data && typeof data === "object") setNotificationSettings(data);
    } catch {
      /* best-effort */
    }
  }, []);

  const updateNotificationSettings = useCallback(
    async (patch: Partial<CommsUserNotificationSettings>) => {
      // Optimistic update
      setNotificationSettings((prev) =>
        prev ? { ...prev, ...patch } : (patch as CommsUserNotificationSettings),
      );
      try {
        const data = await apiRequest("PUT", "/api/comms/notification-settings", patch).then((r) =>
          r.json(),
        );
        if (data && typeof data === "object") setNotificationSettings(data);
      } catch {
        // Revert on failure by re-fetching
        void fetchNotificationSettings(); // fire-and-forget: best-effort revert, errors handled inside
      }
    },
    [fetchNotificationSettings],
  );

  useEffect(() => {
    void fetchNotificationSettings(); // fire-and-forget: best-effort load, errors handled inside
  }, [fetchNotificationSettings]);

  // Fetch own status on mount
  useEffect(() => {
    fetch("/api/comms/status/me", { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((data: CommsUserStatusResponse | null) => { if (data) setMyStatus(data); })
      .catch(() => {});
  }, []);

  // Bulk-hydrate userStatuses for all members visible across channels so
  // the map is populated even for users who haven't manually changed status.
  const bulkHydrateStatuses = useCallback(async (channelList: CommsChannel[]) => {
    const ids = Array.from(
      new Set(
        channelList.flatMap((ch) => (ch.members ?? []).map((m) => m.userId)),
      ),
    ).slice(0, 200); // cap to avoid giant URL
    if (ids.length === 0) return;
    try {
      const data: CommsUserStatusResponse[] = await fetch(
        `/api/comms/status/bulk?userIds=${encodeURIComponent(ids.join(","))}`,
        { credentials: "include" },
      ).then((r) => r.ok ? r.json() : []);
      if (!Array.isArray(data)) return;
      setUserStatuses((prev) => {
        const next = new Map(prev);
        for (const s of data) next.set(s.userId, s);
        return next;
      });
    } catch {
      /* best-effort */
    }
  }, []);

  const fetchChannels = useCallback(async () => {
    try {
      const data: CommsChannel[] = await apiRequest("GET", "/api/comms/channels")
        .then((r) => r.json());
      // Preserve object identity for channels whose content is unchanged so
      // narrow subscribers (e.g. one popup's channel slice via useCommsSelector)
      // skip re-renders when only OTHER channels changed (Task #3848).
      setChannels((prev) => {
        const prevById = new Map(prev.map((c) => [c.id, c] as const));
        let changed = prev.length !== data.length;
        const next = data.map((c, i) => {
          const old = prevById.get(c.id);
          if (old && JSON.stringify(old) === JSON.stringify(c)) {
            if (prev[i] !== old) changed = true;
            return old;
          }
          changed = true;
          return c;
        });
        return changed ? next : prev;
      });
      setChannelsLoaded(true);
      // Keep the query cache in sync so the /comms page sees the same list
      qc.setQueryData(["/api/comms/channels"], data);
      // Hydrate statuses for all visible channel members
      void bulkHydrateStatuses(data); // fire-and-forget: background hydration, errors handled inside
    } catch {
      /* best-effort */
    }
  }, [qc, bulkHydrateStatuses]);

  // Debounced variant for SSE event handlers: collapses rapid bursts of
  // comms:message / comms:read_state / etc. events into a single channels
  // refetch so concurrent calls don't saturate the api DB pool and delay
  // the /channels/:id/messages query that fires when a DM is opened.
  const channelsFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchChannelsDebounced = useCallback(() => {
    if (channelsFetchTimerRef.current) clearTimeout(channelsFetchTimerRef.current);
    channelsFetchTimerRef.current = setTimeout(() => {
      channelsFetchTimerRef.current = null;
      void fetchChannels(); // fire-and-forget: debounced refresh, errors handled inside
    }, 800);
  }, [fetchChannels]);

  useEffect(() => {
    void fetchChannels(); // fire-and-forget: initial load, errors handled inside
  }, [fetchChannels]);

  // ── sidebar categories ──────────────────────────────────────────────────────
  const [sidebarCategories, setSidebarCategories] = useState<CommsSidebarCategoryResponse[]>([]);
  // Tracks whether we have run the one-time localStorage-pins migration for this session.
  const pinsMigratedRef = useRef(false);

  const fetchSidebarCategories = useCallback(async () => {
    try {
      const data: CommsSidebarCategoryResponse[] = await apiRequest(
        "GET",
        "/api/comms/sidebar/categories",
      ).then((r) => r.json());
      if (Array.isArray(data)) setSidebarCategories(data);
    } catch {
      /* best-effort */
    }
  }, []);

  // Migrate existing localStorage pins to server-side favorites on first load.
  // This runs once per session (guarded by ref) after categories have loaded.
  const migrateLocalStoragePins = useCallback(async (categories: CommsSidebarCategoryResponse[]) => {
    if (pinsMigratedRef.current) return;
    pinsMigratedRef.current = true;
    try {
      const raw = localStorage.getItem(PINNED_LS_KEY);
      if (!raw) return;
      const localPins: string[] = JSON.parse(raw);
      if (!Array.isArray(localPins) || localPins.length === 0) return;
      const favCat = categories.find((c) => c.type === "favorites");
      // Skip migration if the favorites category already has items (already migrated).
      if (favCat && favCat.channelIds.length > 0) return;
      await apiRequest("POST", "/api/comms/sidebar/favorites/migrate", {
        channelIds: localPins,
      });
      // Clear localStorage pins after successful migration.
      try { localStorage.removeItem(PINNED_LS_KEY); } catch {}
      // Refresh categories to reflect the migration.
      await fetchSidebarCategories();
    } catch {
      /* best-effort — do not block the app if migration fails */
    }
  }, [fetchSidebarCategories]);

  useEffect(() => {
    void fetchSidebarCategories(); // fire-and-forget: initial load, errors handled inside
  }, [fetchSidebarCategories]);

  // Run migration after categories load for the first time.
  useEffect(() => {
    if (sidebarCategories.length > 0 && !pinsMigratedRef.current) {
      void migrateLocalStoragePins(sidebarCategories); // fire-and-forget: background migration, errors handled inside
    }
  }, [sidebarCategories, migrateLocalStoragePins]);

  const createSidebarCategory = useCallback(async (name: string): Promise<CommsSidebarCategoryResponse | null> => {
    try {
      const cat: CommsSidebarCategoryResponse = await apiRequest(
        "POST",
        "/api/comms/sidebar/categories",
        { name },
      ).then((r) => r.json());
      setSidebarCategories((prev) => [...prev, cat]);
      return cat;
    } catch {
      return null;
    }
  }, []);

  const updateSidebarCategory = useCallback(async (
    id: string,
    data: { name?: string; collapsed?: boolean; clientSubgroupCollapsed?: boolean; sorting?: "recent" | "alpha" | "manual"; unreadsOnTop?: boolean },
  ): Promise<void> => {
    // Optimistic update
    setSidebarCategories((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...data } : c)),
    );
    try {
      await apiRequest("PATCH", `/api/comms/sidebar/categories/${id}`, data);
    } catch {
      // Roll back on error
      await fetchSidebarCategories();
    }
  }, [fetchSidebarCategories]);

  const deleteSidebarCategory = useCallback(async (id: string): Promise<void> => {
    setSidebarCategories((prev) => prev.filter((c) => c.id !== id));
    try {
      await apiRequest("DELETE", `/api/comms/sidebar/categories/${id}`);
    } catch {
      await fetchSidebarCategories();
    }
  }, [fetchSidebarCategories]);

  const reorderSidebarCategories = useCallback(async (orderedIds: string[]): Promise<void> => {
    // Optimistic update — reorder in state
    setSidebarCategories((prev) => {
      const ordered: CommsSidebarCategoryResponse[] = [];
      for (const id of orderedIds) {
        const cat = prev.find((c) => c.id === id);
        if (cat) ordered.push({ ...cat });
      }
      return ordered;
    });
    try {
      await apiRequest("PUT", "/api/comms/sidebar/categories/order", { orderedIds });
    } catch {
      await fetchSidebarCategories();
    }
  }, [fetchSidebarCategories]);

  const moveChannelToCategory = useCallback(async (
    channelId: string,
    fromCategoryId: string | null,
    toCategoryId: string | null,
  ): Promise<void> => {
    if (fromCategoryId === toCategoryId) return;
    // Optimistic update: remove from the old category, append to the new one.
    setSidebarCategories((prev) =>
      prev.map((c) => {
        if (c.id === fromCategoryId) {
          return { ...c, channelIds: c.channelIds.filter((id) => id !== channelId) };
        }
        if (c.id === toCategoryId && !c.channelIds.includes(channelId)) {
          return { ...c, channelIds: [...c.channelIds, channelId] };
        }
        return c;
      }),
    );
    try {
      if (fromCategoryId) {
        await apiRequest(
          "DELETE",
          `/api/comms/sidebar/categories/${fromCategoryId}/channels/${channelId}`,
        );
      }
      if (toCategoryId) {
        await apiRequest("POST", `/api/comms/sidebar/categories/${toCategoryId}/channels`, {
          channelId,
        });
      }
    } catch {
      await fetchSidebarCategories();
    }
  }, [fetchSidebarCategories]);

  const reorderCategoryItems = useCallback(async (
    categoryId: string,
    orderedChannelIds: string[],
  ): Promise<void> => {
    setSidebarCategories((prev) =>
      prev.map((c) => (c.id === categoryId ? { ...c, channelIds: [...orderedChannelIds] } : c)),
    );
    try {
      await apiRequest("PUT", `/api/comms/sidebar/categories/${categoryId}/channels/order`, {
        orderedChannelIds,
      });
    } catch {
      await fetchSidebarCategories();
    }
  }, [fetchSidebarCategories]);

  // ── drafts ───────────────────────────────────────────────────────────────────
  const [draftsByChannelId, setDraftsByChannelId] = useState<Map<string, CommsDraft>>(new Map());

  const fetchDrafts = useCallback(async () => {
    try {
      const drafts: CommsDraft[] = await apiRequest("GET", "/api/comms/drafts")
        .then((r) => r.json());
      const map = new Map<string, CommsDraft>();
      for (const d of drafts) {
        // Top-level drafts only (no parentId) for rail indicators.
        if (!d.parentId) map.set(d.channelId, d);
      }
      setDraftsByChannelId(map);
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    void fetchDrafts(); // fire-and-forget: initial load, errors handled inside
  }, [fetchDrafts]);

  // ── presence ────────────────────────────────────────────────────────────────
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);

  // ── SSE connection ───────────────────────────────────────────────────────────
  const esRef = useRef<EventSource | null>(null);
  const failuresRef = useRef(0);
  const connectedAtRef = useRef<number | null>(null);
  // ISO timestamp of the last moment we had a live SSE connection; used to
  // anchor the catch-up request window after a reconnect.
  const lastEventAtIsoRef = useRef<string | null>(null);
  const listenersRef = useRef<Set<(e: MessageEvent) => void>>(new Set());

  // Re-sync the authoritative presence list after a disconnect.
  const fetchPresence = useCallback(async () => {
    try {
      const data: { onlineUserIds: string[] } = await fetch(
        "/api/comms/presence",
        { credentials: "include" },
      ).then((r) => r.json());
      setOnlineUserIds(data.onlineUserIds ?? []);
    } catch {
      /* best-effort */
    }
  }, []);

  // Called immediately after a new SSE stream is established when we had a
  // previous connection.  Asks the server which channels received messages
  // while we were disconnected and invalidates their caches — including open
  // thread panes (matched by predicate prefix on the channel key) — so the UI
  // refreshes without a full page reload.
  const runCatchUp = useCallback(async (since: string) => {
    try {
      const res = await fetch(
        `/api/comms/events/catch-up?since=${encodeURIComponent(since)}`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      const body: { activeChannelIds: string[]; serverTime: string } = await res.json();
      for (const channelId of body.activeChannelIds) {
        // Predicate match catches both the base message list AND thread-level
        // queries (e.g. /api/comms/channels/:id/messages?parentId=…) whose
        // query key string starts with the same prefix.
        void qc.invalidateQueries({
          predicate: (query) =>
            typeof query.queryKey[0] === "string" &&
            (query.queryKey[0] as string).startsWith(
              `/api/comms/channels/${channelId}/messages`,
            ),
        }); // fire-and-forget: cache refresh only
      }
      // Always re-sync unread counts and presence after a disconnect,
      // regardless of whether there was message activity.
      await Promise.allSettled([fetchChannels(), fetchPresence()]);
      // Advance the anchor to the server's reported time so the next catch-up
      // window starts from a consistent server-clock point.
      lastEventAtIsoRef.current = body.serverTime;
    } catch {
      /* best-effort — the user will still see correct state on next manual refresh */
    }
  }, [qc, fetchChannels, fetchPresence]);

  // ── Thread following state ────────────────────────────────────────────────
  // Declared before connectSse so they can appear in its deps array without
  // triggering a temporal dead-zone error (const declarations are not hoisted).
  const [threadSummary, setThreadSummary] = useState<CommsThreadUnreadSummary>({
    totalUnreadReplies: 0,
    totalMentions: 0,
  });
  const [followedThreads, setFollowedThreads] = useState<CommsFollowedThread[]>([]);

  const fetchThreadSummary = useCallback(async () => {
    try {
      const data: CommsThreadUnreadSummary = await fetch("/api/comms/threads/unread-summary", {
        credentials: "include",
      }).then((r) => r.ok ? r.json() : { totalUnreadReplies: 0, totalMentions: 0 });
      setThreadSummary(data);
    } catch {
      /* best-effort */
    }
  }, []);

  const connectSse = useCallback(() => {
    const previousSince = lastEventAtIsoRef.current;
    const es = new EventSource("/api/comms/events");
    esRef.current = es;
    connectedAtRef.current = Date.now();

    const handleEvent = (e: MessageEvent) => {
      // NOTE: anchor is intentionally NOT updated here — it is only ever set
      // from server-supplied timestamps (ready event serverTime or catch-up
      // serverTime) to avoid client/server clock-skew causing silent gaps.

      // Fan out to page-level subscribers first
      for (const fn of listenersRef.current) {
        try { fn(e); } catch { /* ignore */ }
      }

      // Core global handler
      try {
        const data = JSON.parse(e.data);
        switch (data.type) {
          case "comms:message":
          case "comms:message_edit":
          case "comms:message_delete":
            void qc.invalidateQueries({ queryKey: [`/api/comms/channels/${data.channelId}/messages`] }); // fire-and-forget: cache refresh only
            // Debounced refetch: collapses rapid SSE bursts so the DB pool is
            // not saturated and the messages query can run without queuing.
            fetchChannelsDebounced();
            break;
          case "comms:reaction":
          case "comms:pin":
            // Refresh the message list so pin icons / reaction counts update
            void qc.invalidateQueries({ queryKey: [`/api/comms/channels/${data.channelId}/messages`] }); // fire-and-forget: cache refresh only
            break;
          case "comms:channel_update":
            // Channel name / topic / description changed — refresh the channel list
            fetchChannelsDebounced();
            break;
          case "comms:member_change":
            // Membership changed — refresh channels so rail/popup membership is accurate
            fetchChannelsDebounced();
            break;
          case "comms:presence":
            setOnlineUserIds((prev) =>
              data.online
                ? prev.includes(data.userId) ? prev : [...prev, data.userId]
                : prev.filter((id) => id !== data.userId),
            );
            break;
          case "comms:read_state":
            // Instant local update: the payload carries the channelId that was
            // read, so zero its unread/mention counts without a server round-trip.
            setChannels((prev) =>
              prev.map((ch) =>
                ch.id === data.channelId &&
                ((ch.unreadCount ?? 0) !== 0 || (ch.mentionCount ?? 0) !== 0)
                  ? { ...ch, unreadCount: 0, mentionCount: 0 }
                  : ch,
              ),
            );
            // Debounced refetch converges on the true server count (read-state
            // fires immediately when a DM is opened, and a direct fetchChannels()
            // here would race the messages query for the same DB pool slots)
            fetchChannelsDebounced();
            break;
          case "comms:user_status": {
            const status = data as CommsUserStatusResponse;
            // Update the shared userStatuses map — SSE events are authoritative
            // for effectiveStatus/manualStatus/customEmoji/customText/expiries.
            setUserStatuses((prev) => {
              const next = new Map(prev);
              // Spread status first, then override with preserved "me-only" history
              // fields (recentCustomStatuses, priorStatus) that SSE events omit.
              const old = prev.get(status.userId);
              next.set(status.userId, {
                ...status,
                recentCustomStatuses: status.recentCustomStatuses ?? old?.recentCustomStatuses ?? [],
                priorStatus: status.priorStatus ?? old?.priorStatus ?? null,
              });
              return next;
            });
            // Also update myStatus if this is for the current user.
            // Keep recentCustomStatuses + priorStatus from the existing value
            // so mutation responses (which include them) survive expiry broadcasts.
            qc.setQueryData(["/api/comms/status/me"], (old: CommsUserStatusResponse | undefined) => {
              if (old && old.userId === status.userId) {
                const merged: CommsUserStatusResponse = {
                  ...status,
                  recentCustomStatuses: status.recentCustomStatuses ?? old.recentCustomStatuses ?? [],
                  priorStatus: status.priorStatus ?? old.priorStatus ?? null,
                };
                setMyStatus(merged);
                return merged;
              }
              return old;
            });
            setMyStatus((prev) => {
              if (!prev) return null;
              if (prev.userId !== status.userId) return prev;
              return {
                ...status,
                recentCustomStatuses: status.recentCustomStatuses ?? prev.recentCustomStatuses ?? [],
                priorStatus: status.priorStatus ?? prev.priorStatus ?? null,
              };
            });
            break;
          }
          case "comms:draft":
            // Another session by the same user saved or cleared a draft;
            // re-sync the draft map so rail indicators stay accurate.
            void fetchDrafts(); // fire-and-forget: re-sync draft map, errors handled inside
            break;
          case "comms:scheduled_message":
            // Scheduled message was created/cancelled/delivered/failed;
            // invalidate per-channel and all-user scheduled message queries.
            if (data.channelId) {
              void qc.invalidateQueries({
                queryKey: [`/api/comms/channels/${data.channelId}/scheduled-messages`],
              }); // fire-and-forget: cache refresh only
            }
            void qc.invalidateQueries({ queryKey: ["/api/comms/scheduled-messages"] }); // fire-and-forget: cache refresh only
            break;
          case "comms:thread_unread":
            // A new reply arrived in a followed thread — bump the badge.
            void fetchThreadSummary(); // fire-and-forget: badge refresh, errors handled inside
            break;
          case "comms:thread_follow":
            // Follow/unfollow state changed — refresh the followed threads list.
            void fetchThreadSummary(); // fire-and-forget: badge refresh, errors handled inside
            break;
          case "comms:sidebar":
            // Sidebar category changed (favorites toggle, reorder, create/delete)
            // — re-fetch categories to keep all open sessions in sync.
            void fetchSidebarCategories(); // fire-and-forget: re-sync categories, errors handled inside
            break;
        }
      } catch {
        /* ignore parse errors */
      }
    };

    for (const type of SSE_EVENT_TYPES) {
      es.addEventListener(type, (e) => handleEvent(e as MessageEvent));
    }

    es.addEventListener("error", () => {
      es.close();
      const lifetimeMs = connectedAtRef.current ? Date.now() - connectedAtRef.current : 0;
      const state = nextSseReconnectState(failuresRef.current, lifetimeMs);
      failuresRef.current = state.consecutiveFailures;

      if (state.consecutiveFailures >= SSE_MAX_CONSECUTIVE_FAILURES) {
        // Stop hammering — session likely dead
        return;
      }

      setTimeout(() => {
        connectSse();
      }, state.delayMs);
    });

    // Reset failure counter on first message (successful connection).
    // Also trigger a catch-up if we had a previous connection so messages
    // that arrived while the stream was down are not silently missed.
    es.addEventListener(
      "ready",
      (e: Event) => {
        failuresRef.current = 0;
        // Use the server-supplied timestamp to avoid client/server clock skew.
        let serverTime: string | null = null;
        try {
          const parsed = JSON.parse((e as MessageEvent).data ?? "{}");
          if (typeof parsed.serverTime === "string") {
            serverTime = parsed.serverTime;
          }
        } catch { /* ignore */ }
        if (previousSince) {
          void runCatchUp(previousSince); // fire-and-forget: reconnect catch-up, errors handled inside
        } else {
          // First-ever connection — seed the anchor from the server's clock.
          lastEventAtIsoRef.current = serverTime ?? new Date().toISOString();
        }
      },
      { once: true },
    );
  }, [qc, fetchChannelsDebounced, fetchDrafts, runCatchUp, fetchThreadSummary, fetchSidebarCategories]);

  useEffect(() => {
    connectSse();
    return () => {
      esRef.current?.close();
    };
    // connectSse is stable in practice (useCallback over the stable queryClient
    // and fetchChannels); if it ever did change, close-and-reconnect is the
    // correct behavior anyway.
  }, [connectSse]);

  // Presence heartbeat
  useEffect(() => {
    const interval = setInterval(() => {
      fetch("/api/comms/presence/heartbeat", { method: "POST", credentials: "include" }).catch(() => {});
    }, 25000);
    return () => clearInterval(interval);
  }, []);

  // ── popup state ─────────────────────────────────────────────────────────────
  // Rehydrated from sessionStorage so popups survive full-page navigations and
  // browser-tab backgrounding; entries referencing channels that haven't
  // hydrated yet render as a loading skeleton until the channel list arrives.
  const [popups, setPopups] = useState<PopupEntry[]>(() => loadPersistedPopups());

  // Persist popup state on every change
  useEffect(() => {
    try {
      sessionStorage.setItem(POPUPS_SS_KEY, JSON.stringify(popups));
    } catch {
      /* best-effort */
    }
  }, [popups]);

  // ── archived channel overrides ───────────────────────────────────────────────
  // Archived channels do not appear in the main `channels` list, but members
  // should be able to open them from the Archived rail section.  When a user
  // clicks an archived channel, CommsRail registers it here so that popup
  // resolution and pruning both work without reworking the active channel list.
  const [archivedChannelOverrides, setArchivedChannelOverrides] = useState<
    Record<string, CommsChannel>
  >({});

  const registerArchivedChannel = useCallback((channel: CommsChannel) => {
    setArchivedChannelOverrides((prev) =>
      prev[channel.id] === channel ? prev : { ...prev, [channel.id]: channel },
    );
  }, []);

  // Once channels have loaded, prune persisted popups whose channel no longer
  // exists (deleted channel, lost membership, stale storage).
  // Archived channels are exempt — they live in archivedChannelOverrides.
  useEffect(() => {
    if (!channelsLoaded) return;
    setPopups((prev) => {
      const next = prev.filter(
        (p) =>
          channels.some((c) => c.id === p.channelId) ||
          !!archivedChannelOverrides[p.channelId],
      );
      return next.length === prev.length ? prev : next;
    });
  }, [channelsLoaded, channels, archivedChannelOverrides]);

  const openPopup = useCallback((channelId: string) => {
    setPopups((prev) => {
      const exists = prev.find((p) => p.channelId === channelId);
      if (exists) {
        // Un-minimize if already open
        return prev.map((p) =>
          p.channelId === channelId ? { ...p, minimized: false } : p,
        );
      }
      let trimmed = prev;
      if (prev.length >= MAX_POPUPS) {
        // Prefer evicting the oldest minimized popup; fall back to the oldest.
        const oldestMinimizedIdx = prev.findIndex((p) => p.minimized);
        const evictIdx = oldestMinimizedIdx !== -1 ? oldestMinimizedIdx : 0;
        trimmed = prev.filter((_, i) => i !== evictIdx);
        // Guard against any unexpected state where nothing was evicted.
        if (trimmed.length >= MAX_POPUPS) {
          trimmed = trimmed.slice(trimmed.length - (MAX_POPUPS - 1));
        }
      }
      return [...trimmed, { channelId, minimized: false }];
    });
  }, []);

  const closePopup = useCallback((channelId: string) => {
    setPopups((prev) => prev.filter((p) => p.channelId !== channelId));
  }, []);

  const setPopupMinimized = useCallback((channelId: string, minimized: boolean) => {
    setPopups((prev) =>
      prev.map((p) => (p.channelId === channelId ? { ...p, minimized } : p)),
    );
  }, []);

  const promotePopup = useCallback((channelId: string) => {
    setPopups((prev) => {
      const entry = prev.find((p) => p.channelId === channelId);
      if (!entry) return prev;
      return [
        ...prev.filter((p) => p.channelId !== channelId),
        { ...entry, minimized: false },
      ];
    });
  }, []);

  // ── rail state ──────────────────────────────────────────────────────────────
  const [railOpen, setRailOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_LS_KEY) === "true"; } catch { return false; }
  });

  const toggleRail = useCallback(() => {
    setRailOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(RAIL_LS_KEY, String(next)); } catch {}
      return next;
    });
  }, []);

  // pinnedChannelIds — derived from server-side favorites category.
  // Remains empty until categories have loaded from the server.
  const pinnedChannelIds = useMemo(() => {
    const favCat = sidebarCategories.find((c) => c.type === "favorites");
    return favCat ? favCat.channelIds : [];
  }, [sidebarCategories]);

  const togglePin = useCallback((channelId: string) => {
    // Optimistic update: flip the favorites category's channelIds in local state
    setSidebarCategories((prev) => {
      const idx = prev.findIndex((c) => c.type === "favorites");
      if (idx === -1) return prev;
      const cat = prev[idx];
      const next = cat.channelIds.includes(channelId)
        ? cat.channelIds.filter((id) => id !== channelId)
        : [...cat.channelIds, channelId];
      const updated = [...prev];
      updated[idx] = { ...cat, channelIds: next };
      return updated;
    });
    // Server call — if it fails, refetch to reconcile
    apiRequest("POST", `/api/comms/sidebar/favorites/${channelId}`)
      .catch(() => { void fetchSidebarCategories(); }); // fire-and-forget: reconcile after failure, errors handled inside
  }, [fetchSidebarCategories]);

  // ── SSE listener registration ───────────────────────────────────────────────
  const addSseListener = useCallback((fn: (e: MessageEvent) => void) => {
    listenersRef.current.add(fn);
    return () => { listenersRef.current.delete(fn); };
  }, []);

  const fetchFollowedThreads = useCallback(async () => {
    try {
      const data = await fetch("/api/comms/threads", { credentials: "include" })
        .then((r) => r.ok ? r.json() : []);
      if (!Array.isArray(data)) return;
      // Map server FollowedThreadItem shape to CommsFollowedThread client shape
      const mapped: CommsFollowedThread[] = data.map((item: any) => ({
        rootMessageId: item.rootMessageId,
        channelId: item.channelId,
        following: item.following,
        lastReadReplyAt: item.lastReadReplyAt instanceof Date
          ? item.lastReadReplyAt.toISOString()
          : String(item.lastReadReplyAt),
        unreadReplies: item.unreadReplies ?? 0,
        mentionCount: item.mentionCount ?? 0,
        rootMessage: item.rootMessageContent
          ? {
              content: item.rootMessageContent,
              user: item.rootMessageUserId
                ? { id: item.rootMessageUserId, firstName: null, lastName: null }
                : null,
              createdAt: item.rootMessageCreatedAt
                ? (item.rootMessageCreatedAt instanceof Date
                    ? item.rootMessageCreatedAt.toISOString()
                    : String(item.rootMessageCreatedAt))
                : new Date().toISOString(),
            }
          : null,
        replyCount: item.replyCount ?? 0,
        lastReplyAt: item.lastReplyAt
          ? (item.lastReplyAt instanceof Date
              ? item.lastReplyAt.toISOString()
              : String(item.lastReplyAt))
          : null,
        participantIds: item.participantIds ?? [],
      }));
      setFollowedThreads(mapped);
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    void fetchThreadSummary(); // fire-and-forget: initial load, errors handled inside
  }, [fetchThreadSummary]);

  // ── totalUnread: respects notifPref — muted channels contribute 0
  const totalUnread = channels.reduce((sum, c) => {
    const pref = c.notifPref ?? "all";
    if (pref === "muted") return sum;
    if (pref === "mentions") return sum + (c.mentionCount ?? 0);
    return sum + (c.unreadCount ?? 0);
  }, 0);

  // totalMentions: only direct mentions + DM unreads, ignoring muted
  const totalMentions = channels.reduce((sum, c) => {
    if ((c.notifPref ?? "all") === "muted") return sum;
    return sum + (c.mentionCount ?? 0);
  }, 0);

  // NOTE (Task #3354): the legacy tab-title badge effect that lived here wrote
  // `document.title` directly and raced GlobalTitleManager (the designated
  // single title writer, which already composes bell + chat counts from this
  // context's totalUnread/totalThreadUnread). It clobbered the composed title
  // whenever channels refetched — removed; GlobalTitleManager owns the title.

  // ── Desktop notifications ─────────────────────────────────────────────────────
  const isDndActive = myStatus?.effectiveStatus === "dnd";
  const providerUserId = (user as any)?.claims?.sub ?? null;

  useDesktopNotifications({
    settings: notificationSettings,
    channels,
    myUserId: providerUserId,
    isDndActive,
    addSseListener,
  });

  // Build the snapshot (same object shape the plain context value used to be).
  const snapshot: CommsContextValue = {
        channels,
        channelsLoaded,
        onlineUserIds,
        totalUnread,
        totalMentions,
        draftsByChannelId,
        refetchDrafts: () => { void fetchDrafts(); }, // fire-and-forget: refresh, errors handled inside
        popups,
        openPopup,
        closePopup,
        setPopupMinimized,
        promotePopup,
        archivedChannelOverrides,
        registerArchivedChannel,
        railOpen,
        toggleRail,
        pinnedChannelIds,
        togglePin,
        addSseListener,
        refetchChannels: () => { void fetchChannels(); }, // fire-and-forget: refresh, errors handled inside
        myStatus,
        userStatuses,
        notificationSettings,
        updateNotificationSettings,
        totalThreadUnread: threadSummary.totalUnreadReplies,
        totalThreadMentions: threadSummary.totalMentions,
        refetchThreadSummary: fetchThreadSummary,
        followedThreads,
        refetchFollowedThreads: fetchFollowedThreads,
        sidebarCategories,
        refetchSidebarCategories: () => { void fetchSidebarCategories(); }, // fire-and-forget: refresh, errors handled inside
        createSidebarCategory,
        updateSidebarCategory,
        deleteSidebarCategory,
        reorderSidebarCategories,
        moveChannelToCategory,
        reorderCategoryItems,
  };

  // Store bridge: the context value below is a STABLE object, so React never
  // invalidates consumers via context. Instead, consumers subscribe through
  // useSyncExternalStore (useCommsSelector / useCommsContext) and are notified
  // after each commit; selector consumers bail out when their slice is
  // unchanged, keeping non-comms surfaces idle during busy chat periods.
  const storeRef = useRef<{ snapshot: CommsContextValue; listeners: Set<() => void> } | null>(null);
  if (!storeRef.current) storeRef.current = { snapshot, listeners: new Set() };
  storeRef.current.snapshot = snapshot;

  const store = useMemo<CommsStore>(() => ({
    getSnapshot: () => storeRef.current!.snapshot,
    subscribe: (listener: () => void) => {
      storeRef.current!.listeners.add(listener);
      return () => { storeRef.current!.listeners.delete(listener); };
    },
  }), []);

  // Notify subscribers after every commit — the snapshot object is rebuilt on
  // each provider render, so subscribers re-run their selectors and re-render
  // only if their selected slice actually changed.
  useEffect(() => {
    for (const listener of Array.from(storeRef.current!.listeners)) {
      try { listener(); } catch { /* subscriber errors must not break the fan-out */ }
    }
  });

  return (
    <CommsContext.Provider value={store}>
      {children}
    </CommsContext.Provider>
  );
}
