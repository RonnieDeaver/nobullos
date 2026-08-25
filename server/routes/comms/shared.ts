// @db-pool-intent: api (request-scoped reads/writes)
/**
 * NoBull Comms routes — shared helpers & singletons.
 * Extracted verbatim from server/routes/comms.ts (Task #3787 split);
 * sections: object storage, emoji resize, standard emoji list, auth helpers, LiveKit token minting, call-end finalization.
 * Mounted by registerCommsRoutes in ../comms.ts — route order is
 * preserved by the aggregator's call sequence.
 */

import { broadcastTwilioEvent } from "../../services/twilioEvents";
import * as commsStorage from "../../storage/commsStorage";
import { createCanvas, loadImage } from "canvas";
import { ObjectStorageService } from "../../replit_integrations/object_storage/objectStorage";

export const objectStorage = new ObjectStorageService();

// ─── Emoji resize helper ──────────────────────────────────────────────────────
// GIF and WebP are passed through unchanged (GIF preserves animation; WebP
// has no Canvas encode path). PNG and JPEG are resized down to ≤128 px on the
// longest side if they exceed that, using node-canvas.
export async function maybeResizeEmojiBuffer(buf: Buffer, mimeType: string): Promise<Buffer> {
  if (mimeType === "image/gif" || mimeType === "image/webp") return buf;
  const MAX = 128;
  const img = await loadImage(buf);
  if (img.width <= MAX && img.height <= MAX) return buf;
  const ratio = Math.min(MAX / img.width, MAX / img.height);
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);
  const canvas = createCanvas(w, h);
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  if (mimeType === "image/png") return canvas.toBuffer("image/png");
  return canvas.toBuffer("image/jpeg", { quality: 0.9 });
}

// ─── Common standard emoji for autocomplete ───────────────────────────────────
export const STANDARD_EMOJI_LIST: Array<{ name: string; char: string }> = [
  { name: "thumbsup", char: "👍" }, { name: "thumbsdown", char: "👎" },
  { name: "heart", char: "❤️" }, { name: "smile", char: "😊" },
  { name: "laughing", char: "😄" }, { name: "joy", char: "😂" },
  { name: "sob", char: "😭" }, { name: "fire", char: "🔥" },
  { name: "wave", char: "👋" }, { name: "clap", char: "👏" },
  { name: "eyes", char: "👀" }, { name: "tada", char: "🎉" },
  { name: "rocket", char: "🚀" }, { name: "star", char: "⭐" },
  { name: "check", char: "✅" }, { name: "x", char: "❌" },
  { name: "warning", char: "⚠️" }, { name: "thinking", char: "🤔" },
  { name: "100", char: "💯" }, { name: "muscle", char: "💪" },
  { name: "pray", char: "🙏" }, { name: "ok_hand", char: "👌" },
  { name: "raised_hands", char: "🙌" }, { name: "point_right", char: "👉" },
  { name: "point_left", char: "👈" }, { name: "bulb", char: "💡" },
  { name: "memo", char: "📝" }, { name: "email", char: "📧" },
  { name: "phone", char: "📞" }, { name: "calendar", char: "📅" },
  { name: "chart", char: "📊" }, { name: "lock", char: "🔒" },
  { name: "key", char: "🔑" }, { name: "link", char: "🔗" },
  { name: "hammer", char: "🔨" }, { name: "bug", char: "🐛" },
  { name: "robot", char: "🤖" }, { name: "computer", char: "💻" },
  { name: "coffee", char: "☕" }, { name: "pizza", char: "🍕" },
  { name: "money", char: "💰" }, { name: "boom", char: "💥" },
  { name: "clock", char: "⏰" }, { name: "mega", char: "📣" },
  { name: "bookmark", char: "🔖" }, { name: "pencil", char: "✏️" },
  { name: "sparkles", char: "✨" }, { name: "zap", char: "⚡" },
  { name: "sunglasses", char: "😎" }, { name: "raised_hand", char: "✋" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getUserId(req: any): string {
  return req.user?.claims?.sub;
}

export function isTeamLead(req: any): boolean {
  const role = req.user?.dbUser?.role;
  return role === "team_lead" || role === "ceo";
}

/**
 * Returns true if the requesting user is a channel admin (role "owner" or
 * "channel_admin") OR a global team lead / CEO.  DM channels are exempt from
 * this concept — callers should gate DM routes separately.
 */
export async function isChannelAdminFor(req: any, channelId: string): Promise<boolean> {
  if (isTeamLead(req)) return true;
  const userId = getUserId(req);
  const role = await commsStorage.getChannelMemberRole(channelId, userId);
  return role === "owner" || role === "channel_admin";
}

// ─── LiveKit token minting ────────────────────────────────────────────────────
//
// If the LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_SERVER_URL environment
// variables are absent, the call-token endpoint returns 503 gracefully rather
// than crashing. This lets the rest of Comms function without LiveKit configured.

export async function mintLiveKitToken(
  roomName: string,
  participantIdentity: string,
  participantName: string,
): Promise<string | null> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- livekit-server-sdk is optional; gracefully degrades to null token if absent
    const { AccessToken } = await import("livekit-server-sdk");
    const token = new AccessToken(apiKey, apiSecret, {
      identity: participantIdentity,
      name: participantName,
      ttl: "4h",
    });
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    return await token.toJwt();
  } catch (err: any) {
    console.error("[Comms] LiveKit token mint failed:", err?.message);
    return null;
  }
}

// ─── Call-end finalization (shared by manual End + LiveKit webhook) ─────────
//
// Creates the "Call ended" system summary message in the channel and
// broadcasts a comms:call status=ended SSE event so every connected client
// clears its call state. `endedBy` is the user id for a manual end, or
// "livekit_webhook" when the room emptied on its own (room_finished).
export async function finalizeEndedCall(
  call: {
    id: string;
    channelId: string;
    callType: string | null;
    durationSeconds: number | null;
    participantsJson: Array<{ userId: string; joinedAt: string; leftAt?: string }> | null;
    livekitRoomName: string | null;
  },
  endedBy: string,
): Promise<void> {
  const participants = call.participantsJson ?? [];
  const participantCount = participants.length;
  const durationMin = call.durationSeconds ? Math.ceil(call.durationSeconds / 60) : 0;
  const durationStr = call.durationSeconds
    ? durationMin === 1
      ? "1 minute"
      : `${durationMin} minutes`
    : "just now";
  const callIcon = call.callType === "video" ? "🎥" : "📞";
  const summaryContent =
    participantCount > 0
      ? `${callIcon} Call ended — ${participantCount} participant${participantCount === 1 ? "" : "s"}, ${durationStr}`
      : `${callIcon} Call ended — ${durationStr}`;

  await commsStorage.createMessage({
    channelId: call.channelId,
    userId: null,
    content: summaryContent,
    contentType: "system",
    metadata: {
      type: "call_ended",
      callId: call.id,
      durationSeconds: call.durationSeconds ?? 0,
      participants,
    },
  });

  const memberIds = await commsStorage.getChannelMemberIds(call.channelId);
  broadcastTwilioEvent({
    type: "comms:call",
    channelId: call.channelId,
    callId: call.id,
    status: "ended",
    initiatedBy: endedBy,
    livekitRoomName: call.livekitRoomName ?? "",
    ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
  });
}

// ─── Mention extraction ──────────────────────────────────────────────────────

export function extractMentionedUserIds(content: string): string[] {
  const userIds: string[] = [];
  const mentionPattern = /@\[([^\]]+)\]\(user:([^)]+)\)/g;
  let match;
  while ((match = mentionPattern.exec(content)) !== null) {
    userIds.push(match[2]);
  }
  return userIds;
}
