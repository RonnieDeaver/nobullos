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
  members?: { channelId: string; userId: string; role: string }[];
  activeCall?: CommsCall | null;
  clientFirmName?: string | null;
  dmParticipantNames?: string[] | null;
  dmParticipants?: { userId: string; name: string }[] | null;
  lastMessageAt?: string | null;
  notifPref?: "all" | "mentions" | "muted";
}

export interface CommsAttachment {
  id: string;
  messageId: string;
  uploadedBy: string | null;
  objectKey: string;
  thumbnailKey: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  createdAt: string;
}

export interface CommsLinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  faviconUrl: string | null;
}

export interface CommsMessage {
  id: string;
  channelId: string;
  userId: string | null;
  parentId: string | null;
  content: string;
  contentType: "text" | "system" | "bot";
  editedAt: string | null;
  deletedAt: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email?: string | null;
    profileImageUrl: string | null;
  } | null;
  reactionCounts: Record<string, number>;
  /** Emoji strings the current user reacted with (exact strings — skin-tone variants independent). */
  myReactions?: string[];
  reactionNames?: Record<string, string[]>;
  replyCount: number;
  attachments?: CommsAttachment[];
  linkPreviews?: CommsLinkPreview[];
}

export interface CommsCall {
  id: string;
  channelId: string;
  initiatedBy: string | null;
  livekitRoomName: string | null;
  callType: "voice" | "video";
  status: "active" | "ended";
  startedAt: string;
  endedAt: string | null;
}

export interface PopupEntry {
  channelId: string;
  minimized: boolean;
}

// ─── User status ──────────────────────────────────────────────────────────────

export type CommsManualStatus = "online" | "away" | "dnd" | "offline";

export interface CommsUserStatusResponse {
  userId: string;
  effectiveStatus: CommsManualStatus;
  manualStatus: CommsManualStatus | null;
  dndExpiresAt: string | null;
  priorStatus: CommsManualStatus | null;
  customEmoji: string | null;
  customText: string | null;
  customExpiresAt: string | null;
  recentCustomStatuses: Array<{ emoji: string; text: string }>;
}

export interface CommsDraft {
  id: string;
  userId: string;
  channelId: string;
  parentId: string | null;
  content: string;
  metadata: unknown;
  updatedAt: string;
  createdAt: string;
}

export interface CommsScheduledMessage {
  id: string;
  userId: string;
  channelId: string;
  parentId: string | null;
  content: string;
  metadata: unknown;
  scheduledFor: string;
  status: "pending" | "delivering" | "delivered" | "failed" | "cancelled";
  errorMessage: string | null;
  deliveredMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Notification settings ────────────────────────────────────────────────────

export type CommsGlobalNotifDefault = "all" | "mentions" | "nothing";
export type CommsNotifSoundChoice = "default" | "ding" | "subtle";

export interface CommsUserNotificationSettings {
  globalDefault: CommsGlobalNotifDefault;
  soundEnabled: boolean;
  soundChoice: CommsNotifSoundChoice;
  desktopEnabled: boolean;
  suppressSnippetPrivate: boolean;
  keywords: string[];
}

export interface CommsBookmark {
  id: string;
  channelId: string;
  type: "link" | "file";
  label: string;
  emoji: string | null;
  url: string | null;
  attachmentId: string | null;
  objectKey: string | null;
  filename: string | null;
  sortOrder: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
// ─── Thread following ─────────────────────────────────────────────────────────

export interface CommsFollowedThread {
  rootMessageId: string;
  channelId: string;
  following: boolean;
  lastReadReplyAt: string;
  /** Number of unread replies since lastReadReplyAt */
  unreadReplies: number;
  /** Number of unread @mentions in the thread since lastReadReplyAt */
  mentionCount: number;
  /** Root message preview */
  rootMessage: {
    content: string;
    user: { id: string; firstName: string | null; lastName: string | null } | null;
    createdAt: string;
  } | null;
  /** Number of total replies in the thread */
  replyCount: number;
  /** Timestamp of the most recent reply */
  lastReplyAt: string | null;
  /** Participant user IDs (recent repliers) */
  participantIds: string[];
}

export interface CommsThreadUnreadSummary {
  totalUnreadReplies: number;
  totalMentions: number;
}

// ─── Sidebar categories ───────────────────────────────────────────────────────

export type CommsSidebarCategoryType = "favorites" | "channels" | "dms" | "custom";
export type CommsSidebarSorting = "recent" | "alpha" | "manual";

export interface CommsSidebarCategoryResponse {
  id: string;
  userId: string;
  name: string;
  type: CommsSidebarCategoryType;
  sortOrder: number;
  collapsed: boolean;
  /** Whether the client-channels sub-group within the built-in Channels category is collapsed. */
  clientSubgroupCollapsed: boolean;
  sorting: CommsSidebarSorting;
  unreadsOnTop: boolean;
  /** Ordered channel IDs in this category. */
  channelIds: string[];
  createdAt: string;
  updatedAt: string;
}
