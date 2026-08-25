/**
 * Task #4985 — Win Progress → Slack #general relay.
 *
 * When a team member logs a "Win Progress" entry on a client's
 * Intelligence Feed (the same rows that power the Dashboard's
 * cross-client Win Feed), the whole team should see it without opening
 * the OS. This module posts the win to the workspace's #general channel
 * as a single best-effort attempt.
 *
 * Deliberately NOT the feedback-relay machinery (Task #2064/#2066): no
 * per-row delivery-status column, no retry driver, no manual retry
 * button. A win that fails to post is logged with the existing
 * plain-English Slack reason mapping and forgotten — losing one Slack
 * announcement is acceptable; blocking or failing win creation is not.
 *
 * Shape mirrors `feedbackSlackRelay.ts` (the canonical relay pattern):
 *   1. Active connectivity self-check via the existing `probeConnection`
 *      (auth.test — bypasses an open auth breaker, never wipes tokens).
 *   2. Resolve the channel named "general" via the existing channel
 *      listing; cache the id across calls; a channel_not_found /
 *      is_archived response clears the cache so the next win re-resolves.
 *   3. Post via the existing `postMessage` helper and classify failures
 *      with `plainEnglishSlackReason`. Never throws.
 *
 * P11 note (timeout-after-success): exactly one attempt per win — if the
 * post times out after Slack applied it, nothing re-sends, so a win can
 * never double-post. The Slack adapter's internal retry fires only on
 * HTTP 429, which Slack defines as not-applied.
 */
import {
  postMessage,
  listChannels,
  probeConnection as probeSlackConnection,
  plainEnglishSlackReason,
  parseSlackErrorCode,
  isTerminalSlackAuthCode,
} from "./slackIntegration";
import { registerModuleStateResetForTest } from "./moduleStateReset";

/** Fixed target for now (no admin channel picker — see Task #4985 scope). */
export const WIN_SLACK_CHANNEL_NAME = "general";

/** Short excerpt cap for the win body in the Slack message. */
export const WIN_BODY_EXCERPT_MAX = 300;

// `skipped` = the entry didn't qualify (not a win, demo/archived client,
// retracted entry) — nothing was attempted. The other three mirror the
// feedback relay's classification (minus `pending`: there is no
// persisted status to hold open, so every attempt ends terminal).
export type WinSlackResult = {
  status: "delivered" | "failed" | "not_connected" | "skipped";
  reason: string | null;
};

export interface WinSlackRelayArgs {
  title: string;
  body: string | null;
  firmName: string;
  authorName: string;
}

// Channel id resolved once and cached across calls. Mutable on purpose —
// a channel_not_found / is_archived response clears it so the next
// attempt re-resolves (channel recreated / renamed back / un-archived).
let winSlackChannelId: string | null = null;
let winSlackLookupDone = false;

/** Test-only: reset the cached channel resolution between cases. */
export function __resetWinSlackStateForTest(): void {
  winSlackChannelId = null;
  winSlackLookupDone = false;
}
// Batched test children host many suites in one process (Task #4097);
// register the cache reset so a sibling suite's resolution can't leak.
registerModuleStateResetForTest("winSlackRelay", __resetWinSlackStateForTest);

/** Build the #general message: title, firm, author, short body excerpt. */
export function buildWinSlackMessage(args: WinSlackRelayArgs): string {
  const lines = [
    `:tada: *Win logged:* ${args.title}`,
    `Client: *${args.firmName}* — logged by ${args.authorName}`,
  ];
  const body = (args.body ?? "").trim();
  if (body) {
    const excerpt =
      body.length > WIN_BODY_EXCERPT_MAX
        ? `${body.slice(0, WIN_BODY_EXCERPT_MAX)}...`
        : body;
    // Blockquote each line so multi-line bodies stay visually grouped.
    lines.push(excerpt.split("\n").map((l) => `>${l}`).join("\n"));
  }
  return lines.join("\n");
}

/**
 * Relay one win to #general. Never throws — every failure mode maps onto
 * a `WinSlackResult` for the caller to log. Single attempt, no retry.
 */
export async function relayWinToSlack(args: WinSlackRelayArgs): Promise<WinSlackResult> {
  // 1) Active connectivity self-check (bypasses the auth breaker; a
  //    probe failure never wipes tokens — Task #2115 semantics).
  const probe = await probeSlackConnection();
  if (probe.outcome === "unauthorized") {
    return { status: "not_connected", reason: plainEnglishSlackReason(probe.reason) };
  }
  if (probe.outcome === "probe_failed") {
    return {
      status: "failed",
      reason: "Slack is temporarily unreachable — the win was saved but not announced.",
    };
  }

  // 2) Resolve the #general channel id (cached across wins).
  if (!winSlackLookupDone || !winSlackChannelId) {
    try {
      winSlackLookupDone = true;
      const channels = await listChannels();
      const general = channels.find(
        (ch) => ch.name.toLowerCase() === WIN_SLACK_CHANNEL_NAME,
      );
      if (general) {
        winSlackChannelId = general.id;
        console.log(`[WinRelay] Slack channel found: #${general.name} (${general.id})`);
      } else {
        console.warn(`[WinRelay] Could not find the #${WIN_SLACK_CHANNEL_NAME} Slack channel`);
      }
    } catch (err: any) {
      winSlackLookupDone = false; // let the next win re-resolve
      const code = parseSlackErrorCode(err?.message);
      console.warn("[WinRelay] Slack channel lookup failed:", err?.message);
      if (isTerminalSlackAuthCode(code)) {
        return { status: "not_connected", reason: plainEnglishSlackReason(code) };
      }
      return {
        status: "failed",
        reason: code
          ? plainEnglishSlackReason(code)
          : "Could not reach Slack to look up the channel.",
      };
    }
  }

  if (!winSlackChannelId) {
    return { status: "failed", reason: plainEnglishSlackReason("channel_not_found") };
  }

  // 3) Post the message and classify any failure.
  try {
    await postMessage(winSlackChannelId, buildWinSlackMessage(args));
    return { status: "delivered", reason: null };
  } catch (err: any) {
    const code = parseSlackErrorCode(err?.message);
    console.warn("[WinRelay] Slack post failed:", err?.message);
    if (isTerminalSlackAuthCode(code)) {
      return { status: "not_connected", reason: plainEnglishSlackReason(code) };
    }
    if (code === "channel_not_found" || code === "is_archived") {
      // Channel moved/archived — drop the cache so the next win re-resolves.
      winSlackLookupDone = false;
      winSlackChannelId = null;
    }
    return {
      status: "failed",
      reason: code
        ? plainEnglishSlackReason(code)
        : (err?.message ? String(err.message).slice(0, 200) : "Slack post failed."),
    };
  }
}

// ── Route-facing kick (fire-and-forget) ─────────────────────────────────────

export interface WinRelayEntry {
  entryType: string;
  status?: string | null;
  title: string;
  body?: string | null;
}

export interface WinRelayClient {
  firmName?: string | null;
  isDemo?: boolean | null;
  isArchived?: boolean | null;
}

export interface WinRelayAuthor {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

/** Display name for the person who logged the win. */
export function formatWinAuthorName(author: WinRelayAuthor | null | undefined): string {
  const name = [author?.firstName, author?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || author?.email || "A team member";
}

// In-flight relays, tracked so tests can await background completion
// deterministically instead of sleeping (fire-and-forget drain seam).
const pendingWinRelays = new Set<Promise<unknown>>();

/** Test-only: await every in-flight win relay kicked so far. */
export async function __test_drainPendingWinRelays(): Promise<void> {
  while (pendingWinRelays.size > 0) {
    await Promise.allSettled(Array.from(pendingWinRelays));
  }
}

async function runWinProgressRelay(params: {
  entry: WinRelayEntry;
  client: WinRelayClient | null | undefined;
  author: WinRelayAuthor | null | undefined;
}): Promise<WinSlackResult> {
  try {
    const { entry, client } = params;
    // Only published "Win Progress" entries qualify (route double-checks
    // the type; this is defense in depth + the unit-testable gate).
    if (entry.entryType !== "win_progress") {
      return { status: "skipped", reason: "not_win_progress" };
    }
    // A create that arrives already retracted never announces (matches
    // Win Feed semantics: status != 'archived').
    if (entry.status === "archived") {
      return { status: "skipped", reason: "entry_archived" };
    }
    if (!client) {
      // requireCommandCenterAccess guarantees the client exists; missing
      // here means a wiring bug — skip loudly rather than guess.
      console.warn("[WinRelay] No client row provided — skipping Slack announce");
      return { status: "skipped", reason: "client_missing" };
    }
    // Demo/archived clients never announce (matches Win Feed / weekly
    // win-tracker semantics; NULL flags on legacy rows mean false).
    if (client.isDemo === true) {
      console.log(`[WinRelay] Skipping demo client win: ${entry.title}`);
      return { status: "skipped", reason: "demo_client" };
    }
    if (client.isArchived === true) {
      console.log(`[WinRelay] Skipping archived client win: ${entry.title}`);
      return { status: "skipped", reason: "archived_client" };
    }

    const result = await relayWinToSlack({
      title: entry.title,
      body: entry.body ?? null,
      firmName: client.firmName || "Unknown client",
      authorName: formatWinAuthorName(params.author),
    });
    if (result.status === "delivered") {
      console.log(`[WinRelay] Win posted to #${WIN_SLACK_CHANNEL_NAME}: ${entry.title}`);
    } else if (result.status !== "skipped") {
      console.warn(
        `[WinRelay] Win not posted to Slack (${result.status}): ${result.reason ?? "unknown"} — win "${entry.title}" saved normally`,
      );
    }
    return result;
  } catch (err: any) {
    // relayWinToSlack never throws; this catches gating/logging bugs so
    // the fire-and-forget promise can never reject into the void.
    console.warn("[WinRelay] Unexpected relay error:", err?.message ?? err);
    return { status: "failed", reason: err?.message ? String(err.message).slice(0, 200) : "unexpected error" };
  }
}

/**
 * Kick the win → #general relay in the background. Synchronous wrapper so
 * the creation route can `void` it (sanctioned fire-and-forget): the
 * request never waits on Slack, and the returned promise never rejects.
 */
export function kickWinProgressSlackRelay(params: {
  entry: WinRelayEntry;
  client: WinRelayClient | null | undefined;
  author: WinRelayAuthor | null | undefined;
}): Promise<WinSlackResult> {
  const p = runWinProgressRelay(params);
  pendingWinRelays.add(p);
  const drop = () => {
    pendingWinRelays.delete(p);
  };
  // fire-and-forget bookkeeping: runWinProgressRelay never rejects.
  void p.then(drop, drop);
  return p;
}
