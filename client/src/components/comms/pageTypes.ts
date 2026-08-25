/**
 * NoBull Comms page — shared page types.
 * Extracted verbatim from client/src/pages/Comms.tsx (Task #3787 split).
 * Channel/message/call shapes used by the page and its extracted components.
 */

import type { CommsAttachment } from "@/components/comms/types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommsChannel {
  id: string;
  name: string | null;
  slug: string | null;
  type: "channel" | "dm" | "group_dm";
  visibility: "public" | "private";
  topic: string | null;
  description: string | null;
  clientId: string | null;
  createdBy: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  unreadCount: number;
  mentionCount?: number;
  oldestUnreadMessageId?: string | null;
  notifPref?: "all" | "mentions" | "muted";
  members?: { channelId: string; userId: string; role: string }[];
  activeCall?: CommsCall | null;
  clientFirmName?: string | null;
  dmParticipants?: { userId: string; name: string }[] | null;
  lastMessageAt?: string | null;
}

interface CommsMessage {
  id: string;
  channelId: string;
  userId: string | null;
  parentId: string | null;
  content: string;
  contentType: "text" | "system";
  editedAt: string | null;
  deletedAt: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    profileImageUrl: string | null;
  } | null;
  reactionCounts: Record<string, number>;
  myReactions?: string[];
  replyCount: number;
  attachments?: CommsAttachment[];
}

interface CommsCall {
  id: string;
  channelId: string;
  initiatedBy: string | null;
  livekitRoomName: string | null;
  callType: "voice" | "video";
  status: "active" | "ended";
  startedAt: string;
  endedAt: string | null;
  recordingStatus?: string | null;
}

export interface ActiveCallRoom {
  callId: string;
  callType: "voice" | "video";
  channelName: string;
  token: string;
  serverUrl: string;
  roomName: string;
  recordingEnabled?: boolean;
}

export interface IncomingCallInfo {
  channelId: string;
  callId: string;
  channelName: string;
  callType: "voice" | "video";
  livekitRoomName: string;
  recordingStatus?: string;
}
