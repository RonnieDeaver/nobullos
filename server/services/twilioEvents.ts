/**
 * Task #853: Real-time push for inbound Twilio SMS replies.
 *
 * A tiny SSE broadcaster. The Twilio inbound webhook calls
 * `broadcastTwilioEvent(...)` after a new message has been persisted;
 * the Conversation Hub subscribes to `GET /api/twilio/events` and
 * merges the pushed payload into the React Query cache so new replies
 * appear within ~1s instead of waiting for the next 5s poll.
 *
 * Task #1280: multi-instance fan-out via Postgres LISTEN/NOTIFY.
 *
 * `broadcastTwilioEvent` issues `pg_notify('twilio_events', <json>)` on
 * the API pool; every instance owns a single dedicated `pg.Client` that
 * `LISTEN`s on the same channel and fans out received notifications to
 * its local SSE subscriber set. This means the instance that received
 * the Twilio webhook is no longer the only one that can push the event
 * — any horizontally-scaled peer with subscribed hubs will see it too.
 *
 * On a single instance, behaviour is unchanged: the originating
 * instance's own LISTEN client receives its own NOTIFY and delivers it
 * to local subscribers (one extra Postgres round-trip, ~ms).
 *
 * `twilioEventSubscriberCount` still reports the local-instance count
 * so health metrics keep their per-instance meaning.
 */

import type { Response } from "express";
import { randomUUID } from "crypto";
import { Client } from "pg";
import { apiPool } from "../db";

// Per-process identifier stamped on every NOTIFY we publish. The LISTEN
// handler drops notifications whose origin matches our own so the
// originating instance does not double-deliver: it delivers locally
// immediately inside `broadcastTwilioEvent` (race-free even before
// LISTEN is connected) and ignores the echo of its own NOTIFY when it
// loops back over the channel.
const PROCESS_ORIGIN_ID = randomUUID();

type NotifyEnvelope = {
  origin: string;
  event: TwilioEvent;
};

export type TwilioMessageEvent = {
  type: "message:new";
  conversationId: string;
  message: {
    id: string;
    conversationId: string;
    twilioSid: string | null;
    direction: string;
    fromNumber: string;
    toNumber: string;
    body: string;
    status: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    sentByUserId: string | null;
    createdAt: string;
    updatedAt?: string;
  };
  conversationPreview: {
    id: string;
    lastMessageAt: string;
    lastMessagePreview: string;
    unreadCountDelta: number;
  };
};

/**
 * Task #882: in-place delivery-status update for an already-known
 * outbound message. Pushed by the `/api/twilio/webhooks/sms-status`
 * handler so the open thread can move the badge from
 * queued → sent → delivered (or failed/undelivered) within ~1s instead
 * of waiting on the next thread-messages poll. The payload carries
 * just the fields the merger needs to overwrite the matching row by
 * id / twilioSid; everything else on the cached message is preserved.
 */
export type TwilioMessageStatusEvent = {
  type: "message:status";
  conversationId: string;
  message: {
    id: string;
    conversationId: string;
    twilioSid: string | null;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    updatedAt: string;
  };
};

/**
 * Task #1272: real-time push for forward-mode call-status transitions
 * (ringing → in-progress → ended). Replaces the 2s REST poll in the
 * Active Call Bar. Scoped to the user who placed the call so other
 * operators don't get cross-talk for someone else's outbound calls.
 */
export type TwilioCallStatusEvent = {
  type: "call:status";
  /** The user who placed the call. Used to scope the SSE delivery so
   *  only that user's subscribers receive the event. */
  userId: string;
  call: {
    /** Our internal twilio_calls.id (matches activeCall.callId on the client). */
    id: string;
    twilioSid: string | null;
    /** Raw Twilio CallStatus: queued | initiated | ringing | in-progress |
     *  completed | busy | failed | no-answer | canceled */
    status: string;
    duration: number | null;
    updatedAt: string;
  };
};

/**
 * Task #1686 — Per-user in-app inbox push. Emitted by `notifyUser()`
 * (server/services/notifications/userInbox.ts) after a row lands in
 * `user_notifications`. Scoped to the recipient userId so the bell +
 * dropdown in another operator's tab is never disturbed.
 *
 * The event is named `notification:*` to namespace it clearly away
 * from the SMS `message:*` events above; the legacy "twilioEvents"
 * service name is kept because the SSE channel + LISTEN/NOTIFY plumbing
 * is the same — extending the existing broadcaster is cheaper and
 * less risky than spinning up a second one.
 */
export type UserNotificationPushNewEvent = {
  type: "notification:new";
  /** The recipient. Only that user's SSE subscribers receive this. */
  userId: string;
  notification: {
    id: string;
    category: string;
    title: string;
    body: string | null;
    deepLink: string | null;
    metadata: unknown;
    dedupeKey: string | null;
    readAt: string | null;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
};

/** Read / unread / archived state-change events for the inbox. Carry
 *  enough payload that an open tab can update its cached row in place
 *  without a refetch. Scoped to the owning user. */
export type UserNotificationPushStateEvent = {
  type: "notification:read" | "notification:unread" | "notification:archived";
  userId: string;
  notificationId: string;
  readAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
};

/** Emitted whenever the unread count for a user changes — covers both
 *  the singular state changes above and bulk operations like mark-all-read.
 *  Tabs use this to authoritatively reset the bell badge rather than
 *  mutating it locally.
 *
 *  Task #3570 — Per-bucket split:
 *   - `count`    — personal bucket count (drives the main bell badge).
 *                  Kept as the top-level field for backward compat with
 *                  older clients that only read `count`.
 *   - `personal` — same as count (explicit).
 *   - `system`   — system bucket count (drives the muted secondary indicator).
 */
export type UserNotificationCountEvent = {
  type: "notification:count_updated";
  userId: string;
  /** Personal unread count — drives the main bell badge. */
  count: number;
  /** Explicit personal bucket count (same as `count`). */
  personal?: number;
  /** System bucket unread count — drives the muted secondary indicator. */
  system?: number;
};

export type UserNotificationPushEvent =
  | UserNotificationPushNewEvent
  | UserNotificationPushStateEvent
  | UserNotificationCountEvent;

// ─── NoBull Comms events ──────────────────────────────────────────────────
//
// comms:* events are scoped to channel members (targetUserIds). deliverLocal
// checks the set and skips subscribers whose userId is not a member. This
// prevents private channel content from leaking to non-members via SSE.

export type CommsMessageEvent = {
  type: "comms:message";
  channelId: string;
  message: {
    id: string;
    channelId: string;
    userId: string | null;
    parentId: string | null;
    content: string;
    contentType: string;
    editedAt: string | null;
    deletedAt: string | null;
    metadata: unknown;
    createdAt: string;
    updatedAt: string;
    user?: { id: string; username?: string; firstName?: string; lastName?: string; profileImageUrl?: string } | null;
  };
  // Present when the message was created via the attachment-upload route so
  // live consumers (e.g. file search) can update without a re-fetch.
  attachment?: {
    id: string;
    messageId: string;
    objectKey: string;
    filename: string;
    contentType: string;
    sizeBytes: number | null;
    uploadedBy: string | null;
    createdAt: string;
  } | null;
  targetUserIds?: string[];
};

// NOTE (Task #3426 decision): message edits are content-only. Attachments are
// immutable in comms — there is no route that updates or removes an attachment
// after upload (the PATCH /api/comms/messages/:id route and edit-history
// restore both change `content` only). Because of that, this event carries no
// attachment payload and the Files tab of the search overlay deliberately
// ignores it. If attachments ever become mutable (edit/remove after send),
// extend this event (or add a dedicated comms:attachment_change event) with
// the affected attachment ids and handle it in SearchPanel's Files overlay.
export type CommsMessageEditEvent = {
  type: "comms:message_edit";
  channelId: string;
  messageId: string;
  content: string;
  editedAt: string;
  targetUserIds?: string[];
};

export type CommsMessageDeleteEvent = {
  type: "comms:message_delete";
  channelId: string;
  messageId: string;
  deletedAt: string;
  targetUserIds?: string[];
};

export type CommsReactionEvent = {
  type: "comms:reaction";
  channelId: string;
  messageId: string;
  emoji: string;
  userId: string;
  action: "add" | "remove";
  targetUserIds?: string[];
};

export type CommsReadStateEvent = {
  type: "comms:read_state";
  channelId: string | null;
  userId: string;
  lastReadMessageId?: string | null;
  lastReadAt?: string;
  /** true when all channels were marked read at once */
  bulk?: boolean;
};

export type CommsTypingEvent = {
  type: "comms:typing";
  channelId: string;
  userId: string;
  isTyping: boolean;
  targetUserIds?: string[];
};

export type CommsPresenceEvent = {
  type: "comms:presence";
  userId: string;
  online: boolean;
};

export type CommsCallEvent = {
  type: "comms:call";
  channelId: string;
  callId: string;
  status: "started" | "ended";
  initiatedBy: string;
  livekitRoomName: string;
  callType?: "voice" | "video";
  recordingStatus?: string;
  targetUserIds?: string[];
};

/** Fired after a message is pinned or unpinned in a channel. */
export type CommsPinEvent = {
  type: "comms:pin";
  channelId: string;
  messageId: string;
  /** "pin" when the message was pinned, "unpin" when it was removed. */
  pinAction: "pin" | "unpin";
  pinnedBy: string;
  targetUserIds?: string[];
};

/** Fired when a member is added to, removed from, or has their role changed in a channel. */
export type CommsMemberChangeEvent = {
  type: "comms:member_change";
  channelId: string;
  userId: string;
  action: "add" | "remove" | "role_update";
  targetUserIds?: string[];
};

/** Fired when channel metadata (name, topic, description, archived status) changes. */
export type CommsChannelUpdateEvent = {
  type: "comms:channel_update";
  channelId: string;
  name: string;
  topic: string | null;
  description: string | null;
  archived?: boolean;
  targetUserIds?: string[];
};

/** Fired when a user's effective status changes (manual, DND expiry, custom status). */
export type CommsUserStatusEvent = {
  type: "comms:user_status";
  userId: string;
  effectiveStatus: "online" | "away" | "dnd" | "offline";
  manualStatus: string | null;
  customEmoji: string | null;
  customText: string | null;
  customExpiresAt: string | null;
  dndExpiresAt: string | null;
};

/** Fired when a draft is upserted or deleted for a user+channel. */
export type CommsDraftEvent = {
  type: "comms:draft";
  action: "upserted" | "deleted";
  channelId: string;
  parentId: string | null;
  targetUserIds?: string[];
};

/** Fired when a scheduled message lifecycle changes (created/updated/cancelled/delivered/failed). */
export type CommsScheduledMessageEvent = {
  type: "comms:scheduled_message";
  action: "created" | "updated" | "cancelled" | "delivered" | "failed";
  channelId: string;
  scheduledMessageId: string;
  targetUserIds?: string[];
};

/** Fired when a channel bookmark is created, updated, deleted, or reordered. */
export type CommsBookmarkEvent = {
  type: "comms:bookmark";
  action: "created" | "updated" | "deleted" | "reordered";
  channelId: string;
  bookmark?: Record<string, unknown>;
  bookmarks?: Record<string, unknown>[];
  bookmarkId?: string;
  targetUserIds?: string[];
};

/** Fired when a user follows or unfollows a thread. */
export type CommsThreadFollowEvent = {
  type: "comms:thread_follow";
  rootMessageId: string;
  channelId: string;
  following: boolean;
  targetUserIds?: string[];
};

/** Fired when a new reply arrives in a thread, prompting followers to refresh unread counts. */
export type CommsThreadUnreadEvent = {
  type: "comms:thread_unread";
  channelId: string;
  rootMessageId: string;
  messageId?: string;
  targetUserIds?: string[];
};

/** Fired when the current user's sidebar categories are mutated (favorites toggle, category CRUD). */
export type CommsSidebarEvent = {
  type: "comms:sidebar";
  /** The user whose sidebar was changed — clients only act on events for their own userId. */
  userId: string;
};

export type CommsLinkPreviewEvent = {
  type: "comms:link_preview";
  channelId: string;
  messageId: string;
  previews: Array<{
    url: string;
    title: string | null;
    description: string | null;
    imageUrl: string | null;
    siteName: string | null;
    faviconUrl: string | null;
  }>;
  targetUserIds?: string[];
};

export type CommsEvent =
  | CommsMessageEvent
  | CommsMessageEditEvent
  | CommsMessageDeleteEvent
  | CommsReactionEvent
  | CommsReadStateEvent
  | CommsTypingEvent
  | CommsPresenceEvent
  | CommsCallEvent
  | CommsPinEvent
  | CommsMemberChangeEvent
  | CommsChannelUpdateEvent
  | CommsUserStatusEvent
  | CommsDraftEvent
  | CommsScheduledMessageEvent
  | CommsBookmarkEvent
  | CommsThreadFollowEvent
  | CommsThreadUnreadEvent
  | CommsSidebarEvent
  | CommsLinkPreviewEvent;

export type TwilioEvent =
  | TwilioMessageEvent
  | TwilioMessageStatusEvent
  | TwilioCallStatusEvent
  | UserNotificationPushEvent
  | CommsEvent;

type SubscriberEntry = {
  res: Response;
  /** When set, only events scoped to this userId (currently
   *  `call:status`, `notification:*`, and `comms:*`) are delivered to
   *  this subscriber. Broadcast events without a userId scope
   *  (e.g. `message:new`, `message:status`) are delivered regardless. */
  userId: string | null;
};

const subscribers = new Set<SubscriberEntry>();

// ─── Task #1280 — Postgres LISTEN/NOTIFY fan-out ────────────────────────
//
// Channel name is shared by every instance. Payload is the JSON-encoded
// `TwilioEvent`. Postgres caps NOTIFY payloads at 8000 bytes; we guard
// at 7500 bytes (well under the limit, leaves room for the channel name
// and overhead) and fall back to local-only delivery if a payload would
// be rejected.
const CHANNEL = "twilio_events";
const NOTIFY_PAYLOAD_MAX_BYTES = 7500;

let listenClient: Client | null = null;
let listenStartPromise: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
// Disabled in tests that don't want a real Postgres LISTEN side-channel.
// Production code never sets this.
let listenDisabledForTest = false;

export function __disableTwilioEventListenerForTest(): void {
  listenDisabledForTest = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (listenClient) {
    const c = listenClient;
    listenClient = null;
    listenStartPromise = null;
    c.end().catch(() => {});
  }
}

async function startListener(): Promise<void> {
  if (listenDisabledForTest) return;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  client.on("notification", (msg) => {
    if (msg.channel !== CHANNEL || !msg.payload) return;
    let envelope: NotifyEnvelope;
    try {
      envelope = JSON.parse(msg.payload) as NotifyEnvelope;
    } catch (err: any) {
      console.error(
        `[twilioEvents] Failed to parse NOTIFY payload: ${err?.message ?? err}`,
      );
      return;
    }
    if (!envelope || !envelope.event) return;
    // Skip our own echo — `broadcastTwilioEvent` already delivered this
    // event to local subscribers before publishing. This is what keeps
    // single-instance behaviour race-free: local delivery doesn't depend
    // on the LISTEN client being connected at the moment of publish.
    if (envelope.origin === PROCESS_ORIGIN_ID) return;
    deliverLocal(envelope.event);
  });
  client.on("error", (err) => {
    console.error(
      `[twilioEvents] LISTEN client error: ${err?.message ?? err}; will reconnect`,
    );
    handleListenerLoss();
  });
  client.on("end", () => {
    // If the connection ended unexpectedly (we didn't deliberately tear
    // it down), schedule a reconnect.
    if (listenClient === client) {
      console.warn("[twilioEvents] LISTEN client ended unexpectedly; will reconnect");
      handleListenerLoss();
    }
  });
  await client.connect();
  await client.query(`LISTEN ${CHANNEL}`);
  listenClient = client;
  console.log(`[twilioEvents] LISTEN started on channel "${CHANNEL}"`);
}

function handleListenerLoss(): void {
  const stale = listenClient;
  listenClient = null;
  listenStartPromise = null;
  if (stale) {
    stale.removeAllListeners();
    stale.end().catch(() => {});
  }
  if (reconnectTimer || listenDisabledForTest) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureListenerStarted().catch((err) => {
      console.error(
        `[twilioEvents] LISTEN reconnect failed: ${err?.message ?? err}`,
      );
    });
  }, 5000);
  if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
}

function ensureListenerStarted(): Promise<void> {
  if (listenDisabledForTest) return Promise.resolve();
  if (listenClient) return Promise.resolve();
  if (listenStartPromise) return listenStartPromise;
  listenStartPromise = startListener().catch((err) => {
    listenStartPromise = null;
    console.error(
      `[twilioEvents] Failed to start LISTEN client: ${err?.message ?? err}; will retry`,
    );
    handleListenerLoss();
    throw err;
  });
  return listenStartPromise;
}

function deliverLocal(event: TwilioEvent): void {
  if (subscribers.size === 0) return;
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  // Both `call:status` (Task #1272) and `notification:new` (Task #1686)
  // are per-user — only deliver to subscribers attached to that user.
  const scopedUserId =
    event.type === "call:status" ||
    event.type === "notification:new" ||
    event.type === "notification:read" ||
    event.type === "notification:unread" ||
    event.type === "notification:archived" ||
    event.type === "notification:count_updated"
      ? event.userId
      : null;
  // comms:* events carry a targetUserIds allow-list (channel members) to
  // prevent private channel content from leaking to non-members via SSE.
  const targetUserIds: Set<string> | null =
    "targetUserIds" in event && Array.isArray((event as any).targetUserIds)
      ? new Set((event as any).targetUserIds)
      : null;
  // comms:read_state events go only to the individual user.
  const commsReadUserId =
    event.type === "comms:read_state" ? (event as CommsReadStateEvent).userId : null;
  for (const entry of subscribers) {
    if (scopedUserId && entry.userId !== scopedUserId) continue;
    if (commsReadUserId && entry.userId !== commsReadUserId) continue;
    if (targetUserIds && entry.userId !== null && !targetUserIds.has(entry.userId)) continue;
    try {
      entry.res.write(payload);
    } catch {
      // Best-effort: drop dead sockets silently. Express will trigger
      // the `close` handler on the SSE route which removes the entry.
    }
  }
}

export function addTwilioEventSubscriber(
  res: Response,
  options: { userId?: string | null } = {},
): () => void {
  const entry: SubscriberEntry = { res, userId: options.userId ?? null };
  subscribers.add(entry);
  // Lazily ensure this instance is LISTENing so it receives NOTIFYs
  // (including its own) and can fan them out to this subscriber.
  ensureListenerStarted().catch(() => {
    // Already logged inside ensureListenerStarted; swallow here so the
    // subscriber still attaches and local delivery (within this
    // instance) keeps working via the fallback path in
    // `broadcastTwilioEvent`.
  });
  return () => {
    subscribers.delete(entry);
  };
}

export function broadcastTwilioEvent(event: TwilioEvent): void {
  // Always deliver locally first, synchronously. This keeps single-instance
  // behaviour race-free: subscribers on this process never depend on the
  // LISTEN client being connected (which it might not be during startup,
  // during the first-subscriber attach race, or during a reconnect window).
  // The LISTEN handler ignores notifications stamped with our own origin
  // id, so this does not cause double delivery when the NOTIFY loops back.
  deliverLocal(event);

  const envelope: NotifyEnvelope = { origin: PROCESS_ORIGIN_ID, event };
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, "utf8") > NOTIFY_PAYLOAD_MAX_BYTES) {
    // Local subscribers already received it above; only peer instances
    // will miss this one. Surface loudly so the publish site can be
    // shrunk (see follow-up task on capping payload size).
    console.warn(
      `[twilioEvents] NOTIFY payload exceeds ${NOTIFY_PAYLOAD_MAX_BYTES} bytes` +
        ` (type=${event.type}); skipping cross-instance fan-out for this event`,
    );
    return;
  }
  // Fire-and-forget pg_notify for cross-instance fan-out. A failure here
  // only affects peer instances; local delivery already happened.
  apiPool
    .query(`SELECT pg_notify($1, $2)`, [CHANNEL, serialized])
    .catch((err: any) => {
      console.error(
        `[twilioEvents] NOTIFY failed (${err?.message ?? err}); peer instances will miss this event`,
      );
    });
}

export function twilioEventSubscriberCount(): number {
  return subscribers.size;
}
