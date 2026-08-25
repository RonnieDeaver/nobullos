/**
 * Task #2779 — Slack channel alert when a client texts.
 *
 * Fired best-effort from the inbound-SMS webhook path
 * (`twilioService.handleInboundSms`) AFTER the per-user inbox fan-out.
 * Posts one message per inbound SMS to the configured Slack channel
 * (default `#client-texts`) and @-mentions the conversation owners —
 * the thread assignee and/or the client's account manager — using
 * their linked `user_slack_identities` rows (Slack mention syntax
 * `<@SLACK_USER_ID>`, per https://docs.slack.dev/messaging/formatting-message-text).
 * Owners without a linked Slack identity are named in plain text so
 * the alert still shows who is responsible.
 *
 * Delivery goes through the unified dispatcher (`notifyByType`) so the
 * admin Notifications Console owns enable/disable + channel routing
 * and every attempt lands a `notification_deliveries` row. No
 * `dedupeKey` is passed on purpose: dispatcher dedupe implements
 * health-transition semantics (suppress while already unhealthy) which
 * would swallow every text after the first. Per-message idempotency is
 * inherited from Twilio webhook handling upstream (the caller only
 * invokes this once per persisted inbound message).
 *
 * The default channel is seeded idempotently into the legacy setting
 * key `client_text_slack_channel_id` (= `#client-texts`) — the lowest
 * rung of the dispatcher's channel-resolution order, so an admin-saved
 * Notifications Console row always wins and an admin can still blank
 * the channel there.
 */

import { notifyByType } from "./dispatcher";
import { getUserSlackIdentity } from "../../storage/userSlackPreferencesStorage";
import { storage } from "../../storage";

export const CLIENT_TEXT_NOTIFICATION_ID = "workflow.client_sms.received";
export const CLIENT_TEXT_CHANNEL_SETTING = "client_text_slack_channel_id";
export const CLIENT_TEXT_DEFAULT_CHANNEL = "#client-texts";

let channelSeeded = false;

export function __resetClientTextSeedForTests(): void {
  channelSeeded = false;
}

/**
 * Idempotently seed the legacy channel setting so a fresh deployment
 * routes to #client-texts without any admin action. Never overwrites
 * an existing row (admin edits — including clearing — are preserved).
 */
export async function ensureClientTextChannelSeeded(): Promise<void> {
  if (channelSeeded) return;
  try {
    const existing = await storage.getSystemSetting(CLIENT_TEXT_CHANNEL_SETTING);
    if (!existing) {
      // No updatedBy — system_settings.updated_by has an FK to users, so
      // synthetic actor markers would violate it (see memory: isolated-schema
      // FK-gated actor tests).
      await storage.setSystemSetting(
        CLIENT_TEXT_CHANNEL_SETTING,
        CLIENT_TEXT_DEFAULT_CHANNEL,
      );
    }
    channelSeeded = true;
  } catch {
    // Best-effort — retry on the next alert.
  }
}

export interface ClientTextAlertInput {
  /** Conversation owners (thread assignee ∪ client account manager). */
  recipientUserIds: string[];
  /** e.g. `Jane Doe (+15551234567)` or the bare number. */
  fromLabel: string;
  /** Truncated message preview. */
  preview: string;
  clientId?: string | null;
  messageSid: string;
  threadKey: string;
}

export interface ResolvedMention {
  userId: string;
  /** `<@U…>` when a Slack identity is linked, otherwise a plain name. */
  display: string;
  mentioned: boolean;
}

/**
 * Resolve each owner to a Slack `<@id>` mention, falling back to the
 * user's name/email in plain text when no identity is linked.
 */
export async function resolveMentions(
  userIds: string[],
): Promise<ResolvedMention[]> {
  const out: ResolvedMention[] = [];
  for (const userId of Array.from(new Set(userIds))) {
    let display: string | null = null;
    let mentioned = false;
    try {
      const identity = await getUserSlackIdentity(userId);
      if (identity?.slackUserId && !identity.disconnectedAt) {
        display = `<@${identity.slackUserId}>`;
        mentioned = true;
      }
    } catch {
      // fall through to name fallback
    }
    if (!display) {
      try {
        const user = await storage.getUser(userId);
        const name = [user?.firstName, user?.lastName]
          .filter(Boolean)
          .join(" ")
          .trim();
        display = name || user?.email || userId;
      } catch {
        display = userId;
      }
    }
    out.push({ userId, display, mentioned });
  }
  return out;
}

export function buildClientTextAlertText(
  input: Pick<ClientTextAlertInput, "fromLabel" | "preview">,
  mentions: ResolvedMention[],
): string {
  const owners = mentions.length
    ? mentions.map((m) => m.display).join(" ")
    : "_no assigned owner_";
  return [
    `:speech_balloon: *New client text* from ${input.fromLabel}`,
    `> ${input.preview}`,
    `Owner: ${owners}`,
  ].join("\n");
}

/**
 * Post the alert. Never throws — the inbound-SMS webhook must always
 * return 200 to Twilio regardless of Slack health.
 */
export async function sendClientTextSlackAlert(
  input: ClientTextAlertInput,
): Promise<void> {
  try {
    await ensureClientTextChannelSeeded();
    const mentions = await resolveMentions(input.recipientUserIds);
    const text = buildClientTextAlertText(input, mentions);
    await notifyByType(
      CLIENT_TEXT_NOTIFICATION_ID,
      { text },
      {
        triggerSource: "watcher",
        // notifyUser() upstream already writes targeted inbox rows for
        // the same owners — don't add a generic admin mirror row too.
        skipAdminInAppMirror: true,
        metadata: {
          messageSid: input.messageSid,
          threadKey: input.threadKey,
          clientId: input.clientId ?? null,
          mentionedUserIds: mentions
            .filter((m) => m.mentioned)
            .map((m) => m.userId),
        },
      },
    );
  } catch (err: any) {
    console.warn(
      `[clientTextSlackAlert] failed for ${input.messageSid}: ${err?.message ?? err}`,
    );
  }
}
