/**
 * Task #848: Cache mutators for instant Conversation Hub feedback.
 *
 * Optimistic message inserts use `temp:<uuid>` ids that are later replaced
 * (or marked failed) once the server responds.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { CachedConversation, CachedMessage } from "./conversationCache";

export type OptimisticMessageStatus = "sending" | "sent" | "failed";

export function makeTempId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `temp:${rand}`;
}

export function isTempId(id: string): boolean {
  return id.startsWith("temp:");
}

const messageQueryKey = (convId: string) =>
  ["/api/twilio/conversations", convId, "messages"] as const;

/** Insert a temporary outbound message at the front of the cache (newest-first list). */
export function insertOptimisticMessage(
  qc: QueryClient,
  convId: string,
  msg: CachedMessage,
): void {
  qc.setQueryData<CachedMessage[]>(messageQueryKey(convId), (prev) => {
    const list = Array.isArray(prev) ? prev : [];
    if (list.some((m) => m.id === msg.id)) return list;
    return [msg, ...list];
  });
}

/**
 * Replace a temp message with the server-confirmed payload.
 *
 * Idempotent against an interleaved poll: if the polling refresh already
 * inserted the server row by id or twilioSid, we drop the temp row
 * instead of producing a duplicate. Either way the cache ends up with
 * exactly one row keyed to the server id.
 */
export function replaceOptimisticMessage(
  qc: QueryClient,
  convId: string,
  tempId: string,
  patch: Partial<CachedMessage> & { id?: string },
): void {
  qc.setQueryData<CachedMessage[]>(messageQueryKey(convId), (prev) => {
    if (!Array.isArray(prev)) return prev;
    const serverId = patch.id;
    const serverSid = patch.twilioSid ?? null;
    const tempIdx = prev.findIndex((m) => m.id === tempId);
    if (tempIdx === -1) return prev;
    const dupeExists = prev.some(
      (m, i) =>
        i !== tempIdx &&
        ((serverId && m.id === serverId) ||
          (serverSid && m.twilioSid && m.twilioSid === serverSid)),
    );
    if (dupeExists) {
      // Server row already arrived via polling — drop temp to dedupe.
      return prev.filter((_, i) => i !== tempIdx);
    }
    return prev.map((m, i) =>
      i === tempIdx ? { ...m, ...patch, id: serverId ?? m.id } : m,
    );
  });
}

/** Mark a temp message as failed without removing it. */
export function failOptimisticMessage(qc: QueryClient, convId: string, tempId: string): void {
  replaceOptimisticMessage(qc, convId, tempId, { status: "failed" });
}

/**
 * Task #854: drop a message from the cache by id. Used when retrying a
 * failed send — the failed bubble is removed and the send mutation
 * inserts a fresh optimistic row in its place.
 */
export function removeMessageFromCache(
  qc: QueryClient,
  convId: string,
  messageId: string,
): void {
  qc.setQueryData<CachedMessage[]>(messageQueryKey(convId), (prev) => {
    if (!Array.isArray(prev)) return prev;
    const idx = prev.findIndex((m) => m.id === messageId);
    if (idx === -1) return prev;
    return prev.filter((_, i) => i !== idx);
  });
}

/**
 * Merge a server-side incremental response into the existing message cache.
 * Drops any message ids already present (e.g., the optimistic-confirmed ones).
 */
export function mergeIncrementalMessages(
  qc: QueryClient,
  convId: string,
  incoming: CachedMessage[],
): void {
  if (!incoming || incoming.length === 0) return;
  qc.setQueryData<CachedMessage[]>(messageQueryKey(convId), (prev) => {
    const existing = Array.isArray(prev) ? prev : [];
    const byId = new Map(existing.map((m) => [m.id, m] as const));
    const bySid = new Map(
      existing
        .filter((m) => m.twilioSid)
        .map((m) => [m.twilioSid as string, m] as const),
    );

    // Task #875: an incoming row may be either (a) brand-new or (b) an
    // in-place update to a row already in the cache (status changed:
    // queued → sent → delivered, or errorCode set on failure). We
    // distinguish by id and twilioSid:
    //   - id match           → overwrite the existing row
    //   - twilioSid match    → overwrite the existing row (id is the same
    //                          server-side anyway; this is just defensive)
    //   - neither            → new row, prepend
    let touched = false;
    const additions: CachedMessage[] = [];
    for (const m of incoming) {
      const prevById = byId.get(m.id);
      const prevBySid = m.twilioSid ? bySid.get(m.twilioSid) : undefined;
      const target = prevById ?? prevBySid;
      if (target) {
        // In-place update. Skip if nothing meaningful changed so React
        // Query subscribers don't re-render unnecessarily.
        if (
          target.status !== m.status ||
          target.errorCode !== m.errorCode ||
          target.errorMessage !== m.errorMessage ||
          target.twilioSid !== m.twilioSid ||
          // Task #883: status callbacks may backfill the transport for
          // historical rows, so a change here also has to bust the cache.
          target.messagingServiceSid !== m.messagingServiceSid
        ) {
          byId.set(target.id, { ...target, ...m, id: target.id });
          touched = true;
        }
      } else {
        additions.push(m);
      }
    }

    if (!touched && additions.length === 0) return existing;

    const merged = [...additions, ...Array.from(byId.values())].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return merged;
  });
}

/**
 * Task #882: apply an in-place delivery-status patch to an already-
 * cached message. Used by the SSE `message:status` listener so the
 * badge can move queued → sent → delivered (or failed/undelivered)
 * within ~1s of the Twilio callback. Unlike `mergeIncrementalMessages`
 * this never inserts a new row — if the target message isn't in the
 * cache yet (e.g. the user just opened the thread and the messages
 * fetch hasn't returned), the patch is dropped and the next poll /
 * fetch picks up the final status. Match is by id first, twilioSid
 * as a fallback. No-op patches (status / errorCode / errorMessage all
 * unchanged) skip the cache write entirely so subscribers don't
 * re-render.
 */
export type MessageStatusPatch = {
  id: string;
  twilioSid: string | null;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
};

export function applyMessageStatusPatch(
  qc: QueryClient,
  convId: string,
  patch: MessageStatusPatch,
): void {
  qc.setQueryData<CachedMessage[]>(messageQueryKey(convId), (prev) => {
    if (!Array.isArray(prev)) return prev;
    const idx = prev.findIndex(
      (m) =>
        m.id === patch.id ||
        (patch.twilioSid && m.twilioSid && m.twilioSid === patch.twilioSid),
    );
    if (idx === -1) return prev;
    const cur = prev[idx];
    if (
      cur.status === patch.status &&
      (cur.errorCode ?? null) === patch.errorCode &&
      (cur.errorMessage ?? null) === patch.errorMessage
    ) {
      return prev;
    }
    const updated: CachedMessage = {
      ...cur,
      status: patch.status,
      errorCode: patch.errorCode,
      errorMessage: patch.errorMessage,
      updatedAt: patch.updatedAt,
    };
    return prev.map((m, i) => (i === idx ? updated : m));
  });
}

/**
 * Optimistically bump the conversation list ordering / preview so the
 * sidebar reflects the just-sent message immediately.
 */
export function bumpConversationPreview(
  qc: QueryClient,
  searchQuery: string,
  convId: string,
  preview: string,
  when: string,
): void {
  qc.setQueryData<CachedConversation[]>(
    ["/api/twilio/conversations", searchQuery],
    (prev) => {
      if (!Array.isArray(prev)) return prev;
      const idx = prev.findIndex((c) => c.id === convId);
      if (idx === -1) return prev;
      const updated: CachedConversation = {
        ...prev[idx],
        lastMessagePreview: preview.slice(0, 100),
        lastMessageAt: when,
      };
      const next = [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
      return next;
    },
  );
}
