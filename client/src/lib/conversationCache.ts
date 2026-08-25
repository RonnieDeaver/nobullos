/**
 * Task #848: Lightweight per-user localStorage cache for the Conversation Hub.
 *
 * Hydrates the conversation list and the most recently viewed thread on mount
 * so the page renders instantly from the last known good state while the
 * network refetch is in flight.
 */

// Cache key axes: prefix + schema version + app build version + userId
// (+ optional scope, currently the user role since this codebase is
// single-tenant per user — no workspace/account discriminator exists in
// shared/models/auth.User). Bump SCHEMA_VERSION any time
// CachedConversation/CachedMessage shapes change.
// v2 was introduced alongside the Task #847 unified hub model so the
// older single-conversation snapshot shape isn't read by the new code.
const STORAGE_PREFIX = "conv-hub-cache";
const SCHEMA_VERSION = "v2";
const APP_VERSION: string = import.meta.env?.VITE_APP_VERSION ?? "dev";

export type CachedConversation = {
  id: string;
  clientId: string | null;
  clientContactId: string | null;
  contactPhone: string;
  contactName: string | null;
  displayName: string | null;
  twilioPhoneNumber: string;
  status: string;
  conversationType: string;
  participants: Array<{ phone: string; name?: string; contactId?: string }> | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number | null;
  clientName?: string;
};

export type CachedMessage = {
  id: string;
  conversationId: string;
  twilioSid: string | null;
  direction: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  status: string;
  // Task #875: Twilio diagnostic info from the SMS status callback so
  // the persisted thread cache renders the same tooltip after reload.
  errorCode?: string | null;
  errorMessage?: string | null;
  // Task #883: which Twilio transport sent the outbound message. When
  // set, Twilio routed via the Messaging Service (RCS-capable Sender
  // Pool); when null on outbound, the legacy single-`from` path was
  // used. Always null on inbound rows.
  messagingServiceSid?: string | null;
  sentByUserId: string | null;
  createdAt: string;
  // Task #875: bumped server-side on every status-callback write so the
  // thread view's incremental poll can pick up in-place status mutations
  // (queued → sent → delivered) that don't change createdAt. Optional
  // because cache snapshots persisted before this column existed (and
  // older API responses) won't have it; the merger falls back to
  // createdAt when undefined.
  updatedAt?: string;
};

type Snapshot = {
  conversations?: CachedConversation[];
  messagesByConvId?: Record<string, CachedMessage[]>;
  // Legacy single-conversation selection (pre-Task #847 hub).
  selectedConvId?: string | null;
  // Task #847 unified hub: opaque thread key (UnifiedThread.key) so the
  // last-open thread can be restored across reloads even when the thread
  // spans multiple SMS conversations.
  selectedThreadKey?: string | null;
  savedAt?: number;
};

const MAX_THREADS_CACHED = 6;
const MAX_MESSAGES_PER_THREAD = 60;
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function storageKey(userId: string, scope?: string): string {
  // Optional scope (e.g. user role) lets the same browser hold per-role
  // caches without leaking conversations across role switches.
  const ns = scope ? `${userId}:${scope}` : userId;
  return `${STORAGE_PREFIX}:${SCHEMA_VERSION}:${APP_VERSION}:${ns}`;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadConversationCache(
  userId: string | undefined,
  scope?: string,
): Snapshot | null {
  if (!userId) return null;
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const key = storageKey(userId, scope);
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Snapshot;
    if (parsed.savedAt && Date.now() - parsed.savedAt > MAX_AGE_MS) {
      storage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveConversationCache(
  userId: string | undefined,
  patch: Partial<Snapshot>,
  scope?: string,
): void {
  if (!userId) return;
  const storage = safeStorage();
  if (!storage) return;
  try {
    const existing = loadConversationCache(userId, scope) || {};
    const next: Snapshot = { ...existing, ...patch, savedAt: Date.now() };

    // Trim message history to bound localStorage usage.
    if (next.messagesByConvId) {
      const trimmed: Record<string, CachedMessage[]> = {};
      const ids = Object.keys(next.messagesByConvId);
      // Prefer keeping the selected thread plus the most recently used ones
      // (we approximate by truncation order — list pages newest-first).
      const toKeep = ids.slice(0, MAX_THREADS_CACHED);
      if (next.selectedConvId && !toKeep.includes(next.selectedConvId)) {
        toKeep.push(next.selectedConvId);
      }
      for (const id of toKeep) {
        const msgs = next.messagesByConvId[id];
        if (Array.isArray(msgs)) {
          trimmed[id] = msgs.slice(0, MAX_MESSAGES_PER_THREAD);
        }
      }
      next.messagesByConvId = trimmed;
    }

    storage.setItem(storageKey(userId, scope), JSON.stringify(next));
  } catch {
    // Quota / serialization failures are non-fatal — cache is best-effort.
  }
}

export function clearConversationCache(userId?: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    if (userId) {
      storage.removeItem(storageKey(userId));
      return;
    }
    // No user id known — purge every entry under our prefix.
    const toRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) toRemove.push(key);
    }
    for (const key of toRemove) storage.removeItem(key);
  } catch {
    // ignore
  }
}
