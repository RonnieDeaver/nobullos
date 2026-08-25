/**
 * Task #1687 — Per-user Slack DM sender.
 *
 * Hooks off `notifyUser()` (userInbox.ts) AFTER the in-app row has been
 * persisted. Slack failures NEVER block in-app delivery: this entry
 * point catches and swallows everything except a return-value signal.
 *
 * Why no per-user OAuth: the existing Slack app only ships a bot
 * token. Building a full user-scope OAuth flow is out of scope for
 * Phase 2 — instead we use Slack's `users.lookupByEmail` (bot scope
 * `users:read.email`) to resolve a user's NoBull OS email → Slack
 * user id, then `conversations.open` (bot scope `im:write`) to open
 * a DM channel and post via `chat.postMessage`. The trade-off:
 *   - Pro: zero per-user OAuth state, no token storage, no refresh.
 *   - Con: users must use the same email in NoBull OS and Slack.
 * If a user later wants OAuth, that's a Phase 3+ migration that
 * swaps `linkSlackIdentityByEmail` for an OAuth callback without
 * touching the rest of the pipeline.
 *
 * Retry pathway: the actual `chat.postMessage` runs inside a
 * work_queue job (`user_slack_dm` queue, maintenance class). The
 * `notifyUser()` hook just enqueues — the job is dequeued by the
 * scheduler, executes with exponential backoff, and on terminal
 * failure (`user_not_found`, `channel_not_found`, terminal-auth)
 * dead-letters without further retry. `recordUserSlackDmAttempt`
 * captures `last_dm_status` / `last_dm_error` so the user-settings
 * panel surfaces a "reconnect Slack" banner.
 */

import { storage } from "../../storage";
import {
  getUserSlackIdentity,
  upsertUserSlackIdentity,
  recordUserSlackDmAttempt,
  getUserPreferenceForCategory,
} from "../../storage/userSlackPreferencesStorage";
import {
  isConnected as isSlackBotConfigured,
  lookupUserByEmail,
  openDmChannel,
  getCurrentTeamId,
  postMessage,
} from "../slackIntegration";
import { enqueueJob } from "../workScheduler";
import type { WorkQueueJob } from "@shared/schema";

export const USER_SLACK_DM_QUEUE = "user_slack_dm";
export const USER_SLACK_DM_ENABLED_SETTING = "user_slack_dm_enabled";

// Cached for 30s so the per-event hook doesn't pay a DB round-trip
// for every notification fired by a chatty source.
let killSwitchCacheAtMs = 0;
let killSwitchCacheValue = true;
const KILL_SWITCH_CACHE_MS = 30_000;

export async function isUserSlackDmGloballyEnabled(): Promise<boolean> {
  const now = Date.now();
  if (now - killSwitchCacheAtMs < KILL_SWITCH_CACHE_MS) {
    return killSwitchCacheValue;
  }
  try {
    const setting = await storage.getSystemSetting(
      USER_SLACK_DM_ENABLED_SETTING,
    );
    // Default ON so brand-new installs get the feature without an
    // operator first having to flip a setting. To turn it OFF set
    // the value to "false".
    killSwitchCacheValue = setting?.value !== "false";
  } catch (err: any) {
    console.warn(
      `[userSlackSender] kill-switch read failed (defaulting ON): ${err?.message ?? err}`,
    );
    killSwitchCacheValue = true;
  }
  killSwitchCacheAtMs = now;
  return killSwitchCacheValue;
}

export function __resetUserSlackKillSwitchCacheForTests(): void {
  killSwitchCacheAtMs = 0;
}

export async function setUserSlackDmGloballyEnabled(
  enabled: boolean,
  updatedBy?: string,
): Promise<void> {
  await storage.setSystemSetting(
    USER_SLACK_DM_ENABLED_SETTING,
    enabled ? "true" : "false",
    updatedBy ?? "system",
  );
  __resetUserSlackKillSwitchCacheForTests();
}

// Stable terminal Slack error codes — we never retry these.
const TERMINAL_SLACK_ERROR_CODES = new Set([
  "user_not_found",
  "users_not_found",
  "channel_not_found",
  "user_disabled",
  "user_is_bot",
  "im_blocked",
  "invalid_user",
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "invalid_token",
  "missing_scope",
]);

function classifySlackError(message: string): {
  terminal: boolean;
  code: string;
} {
  const m = /Slack API error:\s*([a-zA-Z_]+)/.exec(message);
  const code = m?.[1] ?? "unknown";
  return { terminal: TERMINAL_SLACK_ERROR_CODES.has(code), code };
}

// ─── identity linking ──────────────────────────────────────────────────

export async function linkSlackIdentityByEmail(params: {
  userId: string;
  email: string;
}): Promise<{
  status: "linked" | "slack_not_configured" | "not_found" | "error";
  identity?: Awaited<ReturnType<typeof getUserSlackIdentity>>;
  error?: string;
}> {
  if (!(await isSlackBotConfigured())) {
    return { status: "slack_not_configured" };
  }
  let slackUserId: string | null = null;
  try {
    slackUserId = await lookupUserByEmail(params.email);
  } catch (err: any) {
    return { status: "error", error: err?.message ?? String(err) };
  }
  if (!slackUserId) return { status: "not_found" };
  const teamId = await getCurrentTeamId();
  const identity = await upsertUserSlackIdentity({
    userId: params.userId,
    slackUserId,
    slackTeamId: teamId,
    slackEmail: params.email,
  });
  return { status: "linked", identity };
}

// ─── send path ─────────────────────────────────────────────────────────

export interface UserSlackDmContent {
  title: string;
  body?: string | null;
  deepLink?: string | null;
}

function formatDmText(content: UserSlackDmContent): string {
  const lines: string[] = [`*${content.title}*`];
  if (content.body) lines.push(content.body);
  if (content.deepLink) {
    const link = content.deepLink.startsWith("http")
      ? content.deepLink
      : `${process.env.APP_BASE_URL ?? ""}${content.deepLink}`;
    lines.push(`<${link}|Open in NoBull OS>`);
  }
  return lines.join("\n");
}

/** Direct synchronous send (used by the queue handler and the "send
 *  test DM" admin/user route). Throws on failure so the caller can
 *  decide whether to retry. */
export async function sendSlackDmToUser(params: {
  userId: string;
  content: UserSlackDmContent;
}): Promise<{ ok: true; channelId: string } | { ok: false; reason: string }> {
  const identity = await getUserSlackIdentity(params.userId);
  if (!identity || identity.disconnectedAt) {
    return { ok: false, reason: "no_identity" };
  }
  if (!(await isSlackBotConfigured())) {
    return { ok: false, reason: "slack_not_configured" };
  }
  const channelId = await openDmChannel(identity.slackUserId);
  await postMessage(channelId, formatDmText(params.content));
  return { ok: true, channelId };
}

/** Enqueue (idempotent) — called from `notifyUser` AFTER the in-app
 *  row is persisted. Returns one of:
 *    `enqueued` | `skipped_killswitch` | `skipped_disabled` |
 *    `skipped_no_identity` | `skipped_enqueue_failed`
 *  Errors are caught and translated; this function never throws. */
export async function maybeEnqueueUserSlackDm(params: {
  userId: string;
  category: string;
  notificationId: string;
  content: UserSlackDmContent;
}): Promise<string> {
  try {
    if (!(await isUserSlackDmGloballyEnabled())) {
      return "skipped_killswitch";
    }
    const pref = await getUserPreferenceForCategory({
      userId: params.userId,
      category: params.category,
    });
    if (!pref.slackDmEnabled) return "skipped_disabled";

    const identity = await getUserSlackIdentity(params.userId);
    if (!identity || identity.disconnectedAt) {
      return "skipped_no_identity";
    }

    await enqueueJob({
      queueName: USER_SLACK_DM_QUEUE,
      workloadClass: "maintenance",
      priority: 5,
      payload: {
        userId: params.userId,
        notificationId: params.notificationId,
        category: params.category,
        content: params.content,
      },
      maxAttempts: 4,
      dedupeKey: `user_slack_dm:${params.notificationId}`,
    });
    return "enqueued";
  } catch (err: any) {
    console.warn(
      `[userSlackSender] enqueue failed user=${params.userId} notif=${params.notificationId}: ${err?.message ?? err}`,
    );
    return "skipped_enqueue_failed";
  }
}

// ─── work-queue handler ────────────────────────────────────────────────

interface UserSlackDmPayload {
  userId: string;
  notificationId: string;
  category: string;
  content: UserSlackDmContent;
}

function parsePayload(job: WorkQueueJob): UserSlackDmPayload | null {
  const p = job.payload;
  if (!p || typeof p !== "object") return null;
  const obj = p as Partial<UserSlackDmPayload>;
  if (
    !obj.userId ||
    !obj.notificationId ||
    !obj.content ||
    typeof obj.content !== "object" ||
    !(obj.content as UserSlackDmContent).title
  ) {
    return null;
  }
  return obj as UserSlackDmPayload;
}

export async function handleUserSlackDmJob(
  job: WorkQueueJob,
): Promise<{ cursor?: string } | void> {
  const payload = parsePayload(job);
  if (!payload) {
    return { cursor: "invalid_payload" };
  }
  // Re-check kill switch at execution time so an operator flip while
  // jobs are queued doesn't get an extra round of DMs out the door.
  if (!(await isUserSlackDmGloballyEnabled())) {
    await recordUserSlackDmAttempt({
      userId: payload.userId,
      status: "skipped_killswitch",
    });
    return { cursor: "skipped_killswitch" };
  }
  try {
    const result = await sendSlackDmToUser({
      userId: payload.userId,
      content: payload.content,
    });
    if (result.ok) {
      await recordUserSlackDmAttempt({
        userId: payload.userId,
        status: "success",
      });
      return { cursor: "sent" };
    }
    await recordUserSlackDmAttempt({
      userId: payload.userId,
      status: result.reason,
    });
    return { cursor: result.reason };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const { terminal, code } = classifySlackError(message);
    await recordUserSlackDmAttempt({
      userId: payload.userId,
      status: terminal ? `failed_terminal:${code}` : `failed:${code}`,
      error: message.slice(0, 500),
    });
    if (terminal) {
      // Returning a cursor instead of throwing avoids burning the
      // remaining retry budget on a permanent failure (user uninstalled
      // Slack, bot lost scope, etc.). The handler is still considered
      // "successful" from the queue's perspective — the user will see
      // the in-app row and a "reconnect Slack" hint via last_dm_status.
      return { cursor: `terminal:${code}` };
    }
    throw err;
  }
}
