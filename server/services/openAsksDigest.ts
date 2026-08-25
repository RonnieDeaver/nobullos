// @db-pool-intent: worker
//
// Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
// intent above declares which pool every `getDb()` call in this module
// is expected to land on. See `scripts/lint-db-pool-tenancy.ts` for the
// contract and `server/db.ts` for the routing.

/**
 * Task #3694 — weekly "aging asks & promises" digest.
 *
 * Every Monday morning (America/New_York), director-level+ users get one
 * in-app digest summarizing the oldest / highest-concern open client asks
 * and unkept internal promises across all active clients, deep-linking to
 * the Churn Command Center "Promises & Asks" tab.
 *
 * Guarantees:
 *   - at-most-once per ISO week: a `system_settings` last-sent week key is
 *     written only after ≥1 in-app row actually landed, so a failed run
 *     retries on the next Monday tick/boot instead of silently skipping;
 *     per-user rows additionally carry a week-scoped dedupeKey as a
 *     second layer.
 *   - kill switch `kill_switch_open_asks_digest` (default ON; set the
 *     setting to "false" to disable) checked at send time.
 *   - cross-instance singleton: the scheduler pass takes the same
 *     Postgres advisory lock family as the other schedulers, so autoscale
 *     siblings can't double-send.
 *   - the optional Slack/ops copy goes through the notifications
 *     dispatcher under `workflow.open_asks.weekly_digest` (defaultEnabled
 *     false) with `skipAdminInAppMirror` — the digest already writes its
 *     own TARGETED per-user rows (director+), while the generic mirror
 *     would fan to ceo/team_lead, which is both wider (leads) and
 *     narrower (directors with legacy non-lead roles) than the intended
 *     audience.
 *
 * The rollup query is shared with GET /api/churn/open-asks
 * (services/openAsksRollup.ts) so the digest can never disagree with the
 * tab it links to.
 */

import cron from "node-cron";
import { getDb, withDbAttribution } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { fetchOpenAsksRollup, type OpenAskRollupItem } from "./openAsksRollup";
import { notifyByType } from "./notifications/dispatcher";
import { notifyUser } from "./notifications/userInbox";
import { getDirectorPlusUsers } from "./notifications/recipients";
import { acquireWorkerSingletonLock } from "./crossInstanceLock";
import { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } from "./workerConfig";
import { workerLog } from "./workerLogger";

export const OPEN_ASKS_DIGEST_NOTIFICATION_ID = "workflow.open_asks.weekly_digest";
export const KILL_SWITCH_OPEN_ASKS_DIGEST = "kill_switch_open_asks_digest";
export const SETTING_OPEN_ASKS_DIGEST_LAST_SENT = "open_asks_digest.last_sent_week";
export const OPEN_ASKS_DIGEST_TOP_N = 5;
/** Digest is eligible from this hour (America/New_York) on Mondays. */
export const OPEN_ASKS_DIGEST_SEND_HOUR_NY = 8;
export const OPEN_ASKS_TAB_DEEP_LINK = "/churn?tab=asks";

export type OpenAsksDigestDecision =
  | "sent"
  | "skipped_kill_switch"
  | "skipped_not_window"
  | "skipped_already_sent"
  | "skipped_no_items"
  | "skipped_no_recipients"
  | "skipped_send_failed"
  | "error";

export interface OpenAsksDigestRunResult {
  decision: OpenAsksDigestDecision;
  weekKey: string;
  totalCount?: number;
  recipientCount?: number;
  inAppDelivered?: number;
  reason?: string;
}

export interface OpenAsksDigestContent {
  title: string;
  body: string;
  /** Slack/ops-channel copy for the dispatcher. */
  text: string;
}

/**
 * ISO-8601 week key (`YYYY-Www`, UTC math). Monday NY time is always
 * Monday or (late-evening) Tuesday in UTC — both belong to the same ISO
 * week (ISO weeks run Mon–Sun), so the key is stable across the whole
 * send window.
 */
export function getOpenAsksDigestWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to the week's Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** Weekday + hour in America/New_York (DST-aware via Intl). */
export function getNewYorkSendWindow(now: Date): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "-1");
  return { weekday, hour };
}

function truncate(s: string, max: number): string {
  const t = (s ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function formatConcern(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const ASK_TYPE_LABELS: Record<string, string> = {
  client_ask: "Client ask",
  internal_promise: "Internal promise",
};

/**
 * Pure composition — unit-testable without DB or dispatcher. `topItems`
 * must already be rank-ordered (the caller slices the rollup, which
 * defaults to the age×concern blend).
 */
export function buildOpenAsksDigest(
  topItems: OpenAskRollupItem[],
  stats: { totalCount: number; clientCount: number },
): OpenAsksDigestContent {
  const itemNoun = stats.totalCount === 1 ? "item" : "items";
  const clientNoun = stats.clientCount === 1 ? "client" : "clients";
  const title = `Aging asks & promises: ${stats.totalCount} open ${itemNoun} across ${stats.clientCount} ${clientNoun}`;

  const lines = topItems.map((item, i) => {
    const typeLabel = ASK_TYPE_LABELS[item.askType] ?? item.askType;
    const age = Math.floor(item.ageDays);
    const owner = item.ownerName ? ` (${item.ownerName})` : "";
    return (
      `${i + 1}. ${item.firmName}${owner} — ${typeLabel}: ` +
      `${truncate(item.summary, 110)} ` +
      `[${age}d old, mentioned ${item.mentionCount}×, concern ${formatConcern(item.concernScore)}]`
    );
  });

  const body = lines.join("\n");
  const text = `📋 ${title}\n${lines.join("\n")}\nReview & resolve: ${OPEN_ASKS_TAB_DEEP_LINK}`;
  return { title, body, text };
}

// ─── Injectable collaborators ───────────────────────────────────────────
// The shared dev DB makes "no items" / exact-recipient assertions
// nondeterministic, so tests may override the rollup fetch, the recipient
// resolver, and both send paths. Production code never touches these.
interface OpenAsksDigestDeps {
  fetchRollup: () => Promise<OpenAskRollupItem[]>;
  getRecipients: () => Promise<string[]>;
  sendUserNotification: typeof notifyUser;
  sendDispatcherAlert: typeof notifyByType;
}

const defaultDeps: OpenAsksDigestDeps = {
  fetchRollup: () =>
    withDbAttribution("open-asks-digest:rollup", () =>
      fetchOpenAsksRollup(getDb(), { sort: "rank" }),
    ),
  getRecipients: () => getDirectorPlusUsers(),
  sendUserNotification: notifyUser,
  sendDispatcherAlert: notifyByType,
};

let deps: OpenAsksDigestDeps = { ...defaultDeps };

export function __setOpenAsksDigestDepsForTest(overrides: Partial<OpenAsksDigestDeps>): void {
  deps = { ...deps, ...overrides };
}

export function __resetOpenAsksDigestDepsForTest(): void {
  deps = { ...defaultDeps };
}

/**
 * One digest attempt. Every early return is a named decision so the
 * scheduler log line (and tests) can tell WHY nothing was sent.
 */
export async function checkAndSendOpenAsksDigest(
  nowMs: number = Date.now(),
): Promise<OpenAsksDigestRunResult> {
  const now = new Date(nowMs);
  const weekKey = getOpenAsksDigestWeekKey(now);
  try {
    // 1. Kill switch (default ON — only an explicit "false" disables).
    const killSwitch = await getSystemSetting(KILL_SWITCH_OPEN_ASKS_DIGEST).catch(() => undefined);
    if (killSwitch?.value === "false") {
      return { decision: "skipped_kill_switch", weekKey };
    }

    // 2. Send window: Monday, from 8am America/New_York. The cron fires
    // at exactly 08:00 NY; the startup catch-up path relies on the rest
    // of Monday staying eligible (autoscale may have no live instance at
    // 08:00), with the last-sent key keeping it at-most-once.
    const { weekday, hour } = getNewYorkSendWindow(now);
    if (weekday !== "Mon" || hour < OPEN_ASKS_DIGEST_SEND_HOUR_NY) {
      return { decision: "skipped_not_window", weekKey };
    }

    // 3. Once per week.
    const lastSent = await getSystemSetting(SETTING_OPEN_ASKS_DIGEST_LAST_SENT).catch(() => undefined);
    if (lastSent?.value === weekKey) {
      return { decision: "skipped_already_sent", weekKey };
    }

    // 4. Build the rollup (rank-ordered; archived/demo already excluded).
    const items = await deps.fetchRollup();
    const totalCount = items.length;
    if (totalCount === 0) {
      return { decision: "skipped_no_items", weekKey, totalCount: 0 };
    }
    const topItems = items.slice(0, OPEN_ASKS_DIGEST_TOP_N);
    const clientCount = new Set(items.map((i) => i.clientId)).size;

    // 5. Resolve director+ recipients.
    const recipients = await deps.getRecipients();
    if (recipients.length === 0) {
      return { decision: "skipped_no_recipients", weekKey, totalCount };
    }

    const content = buildOpenAsksDigest(topItems, { totalCount, clientCount });

    // 6. Targeted in-app fan-out (the primary channel per the task brief).
    let inAppDelivered = 0;
    for (const userId of recipients) {
      try {
        const result = await deps.sendUserNotification(userId, {
          category: "agent",
          title: content.title,
          body: content.body,
          deepLink: OPEN_ASKS_TAB_DEEP_LINK,
          dedupeKey: `open-asks-digest:${weekKey}`,
          metadata: {
            weekKey,
            totalCount,
            topAskIds: topItems.map((t) => t.id),
          },
        });
        if (result) inAppDelivered += 1;
      } catch (err) {
        console.error(`[OpenAsksDigest] in-app notify failed for user=${userId}:`, err);
      }
    }
    if (inAppDelivered === 0) {
      // Nothing landed — do NOT record the week as sent so the next
      // Monday tick/boot retries instead of silently losing the digest.
      return {
        decision: "skipped_send_failed",
        weekKey,
        totalCount,
        recipientCount: recipients.length,
        inAppDelivered: 0,
      };
    }

    // 7. Optional ops-channel copy via the dispatcher (best-effort — the
    // in-app rows above already satisfied the digest contract).
    try {
      await deps.sendDispatcherAlert(
        OPEN_ASKS_DIGEST_NOTIFICATION_ID,
        { text: content.text },
        {
          triggerSource: "scheduled",
          dedupeKey: weekKey,
          skipAdminInAppMirror: true,
          metadata: { weekKey, totalCount, recipientCount: recipients.length },
        },
      );
    } catch (err) {
      console.error("[OpenAsksDigest] dispatcher copy failed (in-app already delivered):", err);
    }

    // 8. Record the week as sent (after successful fan-out only).
    try {
      await setSystemSetting(SETTING_OPEN_ASKS_DIGEST_LAST_SENT, weekKey, "system");
    } catch (err) {
      // Loud but non-fatal: the per-user week-scoped dedupeKey limits a
      // re-run's blast radius to users who already read this week's row.
      console.error("[OpenAsksDigest] failed to persist last-sent week key:", err);
    }

    return {
      decision: "sent",
      weekKey,
      totalCount,
      recipientCount: recipients.length,
      inAppDelivered,
    };
  } catch (err: any) {
    console.error("[OpenAsksDigest] digest attempt failed:", err);
    return { decision: "error", weekKey, reason: err?.message ?? String(err) };
  }
}

// ─── Scheduler ──────────────────────────────────────────────────────────

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let passRunning = false;

// Cross-instance singleton key (same advisory-lock family as the other
// schedulers — see server/services/crossInstanceLock.ts).
const SINGLETON_KEY = "scheduler:open-asks-digest";

async function runOpenAsksDigestPass(source: string): Promise<void> {
  if (passRunning) {
    console.log("[OpenAsksDigest] Previous pass still in progress, skipping");
    return;
  }
  passRunning = true;
  try {
    await withDbAttribution("scheduler:open-asks-digest", async () => {
      let lock: { release: () => Promise<void> } | null = null;
      try {
        lock = await acquireWorkerSingletonLock(SINGLETON_KEY, "[OpenAsksDigest]", {
          maxHoldMs: CROSS_INSTANCE_LOCK_MAX_HOLD_MS.open_asks_digest,
          onWatchdog: (info) =>
            workerLog({
              worker: "open_asks_digest",
              event: "worker_lock_watchdog_fired",
              lockAge: info.heldMs,
              maxHoldMs: info.maxHoldMs,
            }),
        });
        if (!lock) {
          console.log("[OpenAsksDigest] Another instance holds the digest lock, skipping");
          return;
        }
        const result = await checkAndSendOpenAsksDigest();
        // Benign skips log at info — most passes (kill switch, wrong day,
        // already sent) are expected no-ops, never warnings.
        console.log(
          `[OpenAsksDigest] pass (${source}) decision=${result.decision} week=${result.weekKey}` +
            (result.decision === "sent"
              ? ` items=${result.totalCount} recipients=${result.recipientCount} delivered=${result.inAppDelivered}`
              : ""),
        );
      } catch (err: any) {
        console.error("[OpenAsksDigest] pass failed:", err?.message ?? err);
      } finally {
        if (lock) await lock.release();
      }
    });
  } finally {
    passRunning = false;
  }
}

/**
 * Starts the Monday 08:00 America/New_York cron plus one immediate
 * catch-up pass (an autoscale deployment may have had no live instance
 * at 08:00 — a later Monday boot still delivers; the last-sent week key
 * keeps it at-most-once).
 */
export function startOpenAsksDigestScheduler(cronExpression = "0 8 * * 1"): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
  }
  scheduledTask = cron.schedule(
    cronExpression,
    () => {
      void runOpenAsksDigestPass("cron");
    },
    { timezone: "America/New_York" },
  );
  console.log(
    `[OpenAsksDigest] Scheduler started (${cronExpression} America/New_York, kill switch: ${KILL_SWITCH_OPEN_ASKS_DIGEST})`,
  );
  void runOpenAsksDigestPass("startup");
}

export function stopOpenAsksDigestScheduler(): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
    scheduledTask = null;
    console.log("[OpenAsksDigest] Scheduler stopped");
  }
}
