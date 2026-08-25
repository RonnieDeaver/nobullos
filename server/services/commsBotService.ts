// @db-pool-intent: api (request-scoped)
/**
 * NoBull Comms — Bot posting service.
 *
 * Provides a first-class internal API for any server-side subsystem
 * (alerts, service desk, backups, account health) to post a structured
 * message into a Comms channel without going through the user-facing
 * message-send route.
 *
 * Bot messages use contentType="bot" so MessageItem renders them with a
 * distinct NoBull Bot badge instead of a user avatar. They are posted with
 * userId=null (no real user attribution).
 *
 * Usage:
 *   import { postBotMessage } from "./commsBotService";
 *   await postBotMessage({ channel: "general", text: "Backup completed ✅" });
 *   await postBotMessage({ channelId: "some-uuid", text: "Alert!", fields: [...] });
 */

import { createHash } from "node:crypto";
import { broadcastTwilioEvent } from "./twilioEvents";
import * as commsStorage from "../storage/commsStorage";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BotField {
  title: string;
  value: string;
  short?: boolean;
}

export interface BotPostOptions {
  /** Target channel by well-known slug (e.g. "general", "alerts"). */
  channel?: string;
  /** Target channel by DB id — takes precedence over `channel`. */
  channelId?: string;
  /** Main message text. Markdown subset (bold/italic/code) is supported. */
  text: string;
  /** Optional structured key-value fields rendered below the text. */
  fields?: BotField[];
  /** Optional link with label rendered as a call-to-action at the bottom. */
  link?: { label: string; url: string };
  /** Source label shown in the bot badge (e.g. "Backup System", "Service Desk"). */
  source?: string;
}

export interface BotPostResult {
  messageId: string;
  channelId: string;
}

// ─── Well-known channel slugs ─────────────────────────────────────────────────
//
// These are the slugs NoBull creates by default. Any subsystem can target
// "general" or "alerts" without knowing the DB id.
const WELL_KNOWN_SLUGS = ["general", "alerts", "engineering", "ops"] as const;
type WellKnownSlug = (typeof WELL_KNOWN_SLUGS)[number];

function isWellKnown(s: string): s is WellKnownSlug {
  return WELL_KNOWN_SLUGS.includes(s as WellKnownSlug);
}

// ─── Core posting function ────────────────────────────────────────────────────

/**
 * Post a structured bot message to a Comms channel.
 *
 * Resolves the channel by id or slug, creates the message, and broadcasts
 * a comms:message SSE event so connected clients receive it in real time.
 *
 * Throws if the channel cannot be resolved or the message cannot be stored.
 */
export async function postBotMessage(opts: BotPostOptions): Promise<BotPostResult> {
  const { channelId: explicitId, channel: slug, text, fields, link, source } = opts;

  // ── 1. Resolve channel ───────────────────────────────────────────────────
  let channel: Awaited<ReturnType<typeof commsStorage.getChannelById>> | null = null;

  if (explicitId) {
    channel = await commsStorage.getChannelById(explicitId);
    if (!channel) throw new Error(`[BotService] Channel not found: ${explicitId}`);
  } else if (slug) {
    channel = await commsStorage.getChannelBySlug(slug);
    if (!channel) {
      throw new Error(`[BotService] No channel with slug "${slug}". Create it first or use channelId.`);
    }
  } else {
    throw new Error("[BotService] postBotMessage requires channelId or channel (slug)");
  }

  // ── 2. Build content ─────────────────────────────────────────────────────
  const content = buildBotContent({ text, fields, link });

  // ── 3. Build metadata ────────────────────────────────────────────────────
  const metadata: Record<string, unknown> = { type: "bot_message" };
  if (source) metadata.source = source;
  if (fields && fields.length > 0) metadata.fields = fields;
  if (link) metadata.link = link;

  // ── 4. Persist ───────────────────────────────────────────────────────────
  const message = await commsStorage.createMessage({
    channelId: channel.id,
    userId: null,
    content,
    contentType: "bot",
    metadata,
  });

  // ── 5. Broadcast SSE ─────────────────────────────────────────────────────
  const memberIds = await commsStorage.getChannelMemberIds(channel.id);
  broadcastTwilioEvent({
    type: "comms:message",
    channelId: channel.id,
    message: {
      ...message,
      user: null,
      createdAt: message.createdAt.toISOString(),
      updatedAt: message.updatedAt.toISOString(),
      editedAt: null,
      deletedAt: null,
    },
    ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
  });

  console.log(`[BotService] Posted bot message to channel ${channel.id} (${channel.slug ?? channel.id})`);
  return { messageId: message.id, channelId: channel.id };
}

// ─── Content builder ──────────────────────────────────────────────────────────
//
// Produces a plain-text message that the existing Markdown renderer handles.
// Fields are rendered as `**Title**: value` lines.

function buildBotContent(opts: Pick<BotPostOptions, "text" | "fields" | "link">): string {
  const parts: string[] = [opts.text.trim()];

  if (opts.fields && opts.fields.length > 0) {
    parts.push("");
    for (const f of opts.fields) {
      parts.push(`**${f.title}**: ${f.value}`);
    }
  }

  if (opts.link) {
    parts.push("");
    parts.push(`[${opts.link.label}](${opts.link.url})`);
  }

  return parts.join("\n");
}

// ─── Token hash helper (also used by webhook routes) ─────────────────────────

export function hashWebhookToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
