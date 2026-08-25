// @db-pool-intent: ambient
//
// `recordFeedbackSlackResult` is the only DB caller in this module. It
// runs in two contexts: the `/api/feedback` + `/api/feedback/:id/retry-
// slack` route handlers (API pool) and the `feedback_slack_retry`
// work-queue handler (worker pool, wrapped in `runWithWorkerDb`). It
// therefore resolves its handle via `getDb()` and inherits whichever
// pool the caller installed, which is exactly the "ambient" intent.
/**
 * Task #2064 / Task #2066 — shared feedback → Slack relay.
 *
 * Task #2064 added per-feedback Slack relay state (`slack_status` /
 * `slack_reason` / `slack_updated_at`) plus a manual "Retry Slack"
 * button so a failure to reach the "Ronnie thought stream" channel is
 * visible instead of silently swallowed. The relay logic originally
 * lived as closures inside `registerRoutes` in `server/routes.ts`.
 *
 * Task #2066 adds a background driver that re-drives un-delivered
 * feedback once Slack connectivity returns. That driver runs on the
 * worker pool and must call the exact same relay + result-recording
 * path the routes use, so this module extracts that logic into a single
 * shared place. Both the routes and the retry scheduler import from
 * here; there is no second copy of the channel-resolution / message-
 * building / status-classification logic to drift.
 *
 * Connectivity is decided by an active `auth.test` probe
 * (`probeConnection`) — not just "a token string exists" — so a stored-
 * but-revoked token is correctly reported as not-connected. Channel /
 * user IDs are resolved once and cached in module state across calls; a
 * channel-not-found clears the cache so the next attempt re-resolves.
 */
import {
  postMessage,
  lookupUserByEmail,
  listChannels,
  probeConnection as probeSlackConnection,
  plainEnglishSlackReason,
  parseSlackErrorCode,
  isTerminalSlackAuthCode,
} from "./slackIntegration";
import { getPublicBaseUrl } from "./publicUrl";

/**
 * Absolute URL of the feedback admin console where an attached video can be
 * viewed/played (Task #2409). Slack can't embed the clip inline, so the relay
 * appends this link whenever a feedback row carries a video attachment. Falls
 * back to localhost in dev so the link is still clickable from a local Slack.
 */
export function buildFeedbackAdminUrl(): string {
  const base = getPublicBaseUrl({ allowLocalhostFallback: true }).replace(/\/+$/, "");
  return `${base}/admin/feedback`;
}

// Task #2064 — per-feedback Slack relay outcome. `delivered` = posted OK,
// `not_connected` = Slack rejected the token / no token (operator must
// re-auth), `failed` = transient/channel problem (retryable), `pending` =
// relay still in flight (slow Slack) — the row keeps `pending` until the
// background relay resolves and persists the terminal status.
export type FeedbackSlackResult = {
  status: "delivered" | "failed" | "not_connected" | "pending";
  reason: string | null;
};

export interface FeedbackSlackRelayArgs {
  topic: string;
  userName: string;
  page: string | null;
  feedbackText: string;
  // Number of image (screenshot) attachments.
  screenshotCount: number;
  // Number of video attachments (Task #2409). Slack can't embed the video
  // inline, so when this is > 0 the message notes it and includes `viewUrl`
  // so an admin can open the clip in the feedback admin console.
  videoCount?: number;
  // Absolute URL where the attached video(s) can be viewed (the feedback
  // admin console). Only appended when `videoCount > 0`.
  viewUrl?: string | null;
}

// The feedback row is persisted before we even attempt the relay, so a slow
// Slack must never hold the submit request. We give the relay a short budget
// to produce a terminal status inline (so the common fast path returns an
// accurate badge); if it overruns we respond `pending` and let the relay
// finish + persist in the background.
export const FEEDBACK_SLACK_RELAY_BUDGET_MS = 2000;

const FEEDBACK_TOPIC_LABELS: Record<string, string> = {
  BUG_REPORT: "Bug Report",
  FEATURE_REQUEST: "Feature Request",
  DESIGN: "Design Feedback",
  CONTENT: "Content Issue",
  OTHER: "Other",
};

// Channel / user IDs resolved once and cached across calls. Mutable on
// purpose — a channel-not-found / archived response clears them so the
// next attempt re-resolves.
let feedbackSlackChannelId: string | null = null;
let feedbackSlackUserId: string | null = null;
let slackLookupDone = false;

/**
 * Drop the cached channel / user resolution so the next relay attempt
 * re-resolves from scratch. Used by the manual "Retry Slack" route to
 * force a fresh lookup (e.g. after the channel was renamed / recreated).
 */
export function resetFeedbackSlackLookupCache(): void {
  slackLookupDone = false;
  feedbackSlackChannelId = null;
}

/** Test-only: reset all cached Slack identifiers between cases. */
export function __resetFeedbackSlackStateForTest(): void {
  slackLookupDone = false;
  feedbackSlackChannelId = null;
  feedbackSlackUserId = null;
}

function buildFeedbackSlackMessage(args: FeedbackSlackRelayArgs): string {
  const tag = feedbackSlackUserId ? `<@${feedbackSlackUserId}>` : "@Ronnie";
  const parts: string[] = [];
  if (args.screenshotCount > 0) {
    parts.push(`${args.screenshotCount} screenshot${args.screenshotCount > 1 ? "s" : ""}`);
  }
  const videoCount = args.videoCount ?? 0;
  if (videoCount > 0) {
    parts.push(`${videoCount} video${videoCount > 1 ? "s" : ""}`);
  }
  let attachmentNote = parts.length > 0 ? `\n📎 ${parts.join(" + ")} attached` : "";
  // Slack can't embed the uploaded video inline, so point admins at the
  // feedback console where they can play it (Task #2409).
  if (videoCount > 0 && args.viewUrl) {
    attachmentNote += `\n▶️ View video: ${args.viewUrl}`;
  }
  const label = FEEDBACK_TOPIC_LABELS[args.topic] || args.topic;
  const body = args.feedbackText.substring(0, 500) + (args.feedbackText.length > 500 ? "..." : "");
  return `${tag} — New feedback submitted:\n*${label}* from *${args.userName}*\nPage: \`${args.page || "/"}\`\n>${body}${attachmentNote}`;
}

/**
 * Relay a feedback row to the "Ronnie thought stream" Slack channel and
 * report the outcome instead of swallowing it. Connectivity is decided
 * by an active `auth.test` probe (bypassing the auth breaker) so a
 * stored-but-revoked token is reported as `not_connected`. Channel /
 * user IDs are resolved once and cached; a channel-not-found clears the
 * cache so the next attempt re-resolves. Never throws — every failure
 * mode maps onto a `FeedbackSlackResult`.
 */
export async function relayFeedbackToSlack(
  args: FeedbackSlackRelayArgs,
): Promise<FeedbackSlackResult> {
  // 1) Active connectivity self-check (bypasses the auth breaker).
  const probe = await probeSlackConnection();
  if (probe.outcome === "unauthorized") {
    return { status: "not_connected", reason: plainEnglishSlackReason(probe.reason) };
  }
  if (probe.outcome === "probe_failed") {
    return {
      status: "failed",
      reason: probe.reason === "breaker_open_recovering"
        ? "Slack is temporarily unreachable (recovering) — it will retry."
        : "Slack is temporarily unreachable — it will retry.",
    };
  }

  // 2) Resolve channel + Ronnie's user id (cached across requests).
  if (!slackLookupDone || !feedbackSlackChannelId) {
    try {
      slackLookupDone = true;
      const channels = await listChannels();
      const thoughtStream = channels.find(
        (ch) => ch.name.toLowerCase().includes("ronnie") && ch.name.toLowerCase().includes("thought"),
      );
      if (thoughtStream) {
        feedbackSlackChannelId = thoughtStream.id;
        console.log(`[Feedback] Slack channel found: #${thoughtStream.name} (${thoughtStream.id})`);
      } else {
        console.warn("[Feedback] Could not find 'Ronnie thought stream' channel");
      }
      for (const email of ["rdeaver@nobullmarketing.co", "rdeaver@nobullmarketing.com"]) {
        const uid = await lookupUserByEmail(email);
        if (uid) {
          feedbackSlackUserId = uid;
          console.log(`[Feedback] Slack user found: ${email} (${uid})`);
          break;
        }
      }
      if (!feedbackSlackUserId) {
        console.warn("[Feedback] Could not find Ronnie's Slack user ID");
      }
    } catch (err: any) {
      slackLookupDone = false; // allow a later retry to re-resolve
      const code = parseSlackErrorCode(err?.message);
      console.warn("[Feedback] Slack lookup failed:", err?.message);
      if (isTerminalSlackAuthCode(code)) {
        return { status: "not_connected", reason: plainEnglishSlackReason(code) };
      }
      return {
        status: "failed",
        reason: code ? plainEnglishSlackReason(code) : "Could not reach Slack to look up the channel — it will retry.",
      };
    }
  }

  if (!feedbackSlackChannelId) {
    return { status: "failed", reason: plainEnglishSlackReason("channel_not_found") };
  }

  // 3) Post the message and classify any failure.
  try {
    await postMessage(feedbackSlackChannelId, buildFeedbackSlackMessage(args));
    return { status: "delivered", reason: null };
  } catch (err: any) {
    const code = parseSlackErrorCode(err?.message);
    console.warn("[Feedback] Slack notification failed:", err?.message);
    if (isTerminalSlackAuthCode(code)) {
      return { status: "not_connected", reason: plainEnglishSlackReason(code) };
    }
    if (code === "channel_not_found" || code === "is_archived") {
      // Channel moved/archived — drop the cache so the next attempt re-resolves.
      slackLookupDone = false;
      feedbackSlackChannelId = null;
    }
    return {
      status: "failed",
      reason: code
        ? plainEnglishSlackReason(code)
        : (err?.message ? String(err.message).slice(0, 200) : "Slack post failed — it will retry."),
    };
  }
}

/**
 * Persist the relay outcome onto the `user_feedback` row. Resolves the
 * DB handle via `getDb()` so it works on the API pool (route context)
 * and the worker pool (the `feedback_slack_retry` handler wraps its call
 * in `runWithWorkerDb`). Never throws — a persistence failure is logged
 * and the next attempt re-drives the row.
 *
 * Task #2131 — every non-`delivered` outcome bumps `slack_attempts` so the
 * retry scheduler can count failed attempts and eventually give up on a
 * permanently-broken row (revoked token / deleted channel) instead of
 * retrying it forever. A `delivered` outcome leaves the counter alone (the
 * row is terminal-success and never re-driven). The increment is done in
 * SQL (`slack_attempts + 1`) so concurrent attempts can't lose a count.
 */
export async function recordFeedbackSlackResult(
  rowId: number | null,
  result: FeedbackSlackResult,
): Promise<void> {
  if (rowId == null) return;
  const { getDb, withDbAttribution } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const attemptDelta = result.status === "delivered" ? sql`0` : sql`1`;
  try {
    await withDbAttribution("feedbackSlackRelay:recordResult", async () => {
      await getDb().execute(sql`
        UPDATE user_feedback
        SET slack_status = ${result.status},
            slack_reason = ${result.reason},
            slack_updated_at = now(),
            slack_attempts = slack_attempts + ${attemptDelta}
        WHERE id = ${rowId}
      `);
    });
  } catch (err: any) {
    console.warn("[Feedback] Failed to persist Slack status:", err?.message);
  }
}

/**
 * Task #2131 — terminally mark a feedback row as `undeliverable` after the
 * retry scheduler has decided to give up on it (too many failed attempts
 * or stuck too long). This is a one-way transition: the candidate scan in
 * `feedbackSlackRetry.ts` excludes `undeliverable` rows, so they stop
 * consuming the live retry budget and are never re-driven automatically.
 * The manual "Retry Slack" route still works — it calls
 * `recordFeedbackSlackResult` directly, which can move the row back to a
 * non-terminal status (and a later `delivered`) once a human re-auths
 * Slack / fixes the channel. The final attempt is counted here so the
 * persisted `slack_attempts` reflects reality. Never throws.
 */
export async function markFeedbackSlackUndeliverable(
  rowId: number | null,
  reason: string | null,
): Promise<void> {
  if (rowId == null) return;
  const { getDb, withDbAttribution } = await import("../db");
  const { sql } = await import("drizzle-orm");
  try {
    await withDbAttribution("feedbackSlackRelay:markUndeliverable", async () => {
      await getDb().execute(sql`
        UPDATE user_feedback
        SET slack_status = 'undeliverable',
            slack_reason = ${reason},
            slack_updated_at = now(),
            slack_attempts = slack_attempts + 1
        WHERE id = ${rowId}
      `);
    });
  } catch (err: any) {
    console.warn(
      "[Feedback] Failed to mark Slack status undeliverable:",
      err?.message,
    );
  }
}

// Reason stamped on a row when an operator revives it from the terminal
// `undeliverable` state so the next retry tick can pick it up again.
export const FEEDBACK_SLACK_REQUEUE_REASON =
  "Re-queued by operator — awaiting Slack retry.";

/**
 * Task #2206 — revive a single terminally-`undeliverable` feedback row so
 * the retry scheduler re-drives it. This is the inverse of
 * `markFeedbackSlackUndeliverable`: it resets `slack_status` back to the
 * retryable `failed` state, zeroes `slack_attempts` (the give-up counter),
 * and clears `slack_updated_at` so the candidate scan in
 * `feedbackSlackRetry.ts` considers the row immediately (it is no longer
 * held by the backoff window). Guarded on `slack_status = 'undeliverable'`
 * so it can never disturb a `delivered` / `pending` / `failed` row. Returns
 * the number of rows actually revived (0 if the row was not undeliverable).
 * Never throws — a persistence failure is logged and returns 0.
 */
export async function reviveFeedbackSlackUndeliverable(
  rowId: number | null,
): Promise<number> {
  if (rowId == null) return 0;
  const { getDb, withDbAttribution } = await import("../db");
  const { sql } = await import("drizzle-orm");
  try {
    return await withDbAttribution(
      "feedbackSlackRelay:reviveUndeliverable",
      async () => {
        const res = await getDb().execute(sql`
          UPDATE user_feedback
          SET slack_status = 'failed',
              slack_reason = ${FEEDBACK_SLACK_REQUEUE_REASON},
              slack_updated_at = NULL,
              slack_attempts = 0
          WHERE id = ${rowId}
            AND slack_status = 'undeliverable'
        `);
        return res.rowCount ?? 0;
      },
    );
  } catch (err: any) {
    console.warn(
      "[Feedback] Failed to revive undeliverable Slack row:",
      err?.message,
    );
    return 0;
  }
}

/**
 * Task #2206 — bulk sibling of {@link reviveFeedbackSlackUndeliverable}:
 * revive every terminally-`undeliverable` feedback row in one statement so
 * an operator can re-queue the whole given-up backlog after fixing Slack.
 * Same reset semantics (→ `failed`, zero attempts, clear backoff stamp) and
 * the same `slack_status = 'undeliverable'` guard. Returns the count
 * revived. Never throws — a failure is logged and returns 0.
 */
export async function reviveAllFeedbackSlackUndeliverable(): Promise<number> {
  const { getDb, withDbAttribution } = await import("../db");
  const { sql } = await import("drizzle-orm");
  try {
    return await withDbAttribution(
      "feedbackSlackRelay:reviveAllUndeliverable",
      async () => {
        const res = await getDb().execute(sql`
          UPDATE user_feedback
          SET slack_status = 'failed',
              slack_reason = ${FEEDBACK_SLACK_REQUEUE_REASON},
              slack_updated_at = NULL,
              slack_attempts = 0
          WHERE slack_status = 'undeliverable'
        `);
        return res.rowCount ?? 0;
      },
    );
  } catch (err: any) {
    console.warn(
      "[Feedback] Failed to bulk-revive undeliverable Slack rows:",
      err?.message,
    );
    return 0;
  }
}
