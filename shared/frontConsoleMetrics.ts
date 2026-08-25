/**
 * Task #2502 — Front Console metric definitions (single source of truth).
 *
 * The Front Integration console reads THREE different populations, each correct
 * on its own but historically labelled with the same generic words ("Messages",
 * "Matched", "Unmatched", "Match rate", "Backlog"). This module is the one place
 * that defines which rows count toward each canonical figure, so the server
 * overview endpoint, the KPI header, the Hard-match panel, and the docs/audit
 * note can never drift from one another.
 *
 * Populations:
 *  1. Raw imported   — `raw_communication_records WHERE source_type='front_email'`.
 *                      Every Front record ever imported, INCLUDING per-version
 *                      duplicates. This is the largest count and is NOT a count
 *                      of distinct conversations.
 *  2. Tracked convos — `front_sync_emails`. The de-duplicated operational rows,
 *                      one per tracked conversation, carrying `match_status`.
 *  3. Pipeline state — `front_sync_emails` grouped by `pipeline_state`. The
 *                      processing lifecycle of those tracked rows.
 *
 * This module changes NOTHING about ingestion, matching, or dismissal (Task #867
 * hard-match-only behavior is preserved). It only defines how the console reports.
 */

/** `front_sync_emails.match_status` values that count as a successful match. */
export const FRONT_MATCHED_STATUSES = ["auto_matched", "manually_matched"] as const;

/** `match_status` values that are matchable but not (yet) matched. */
export const FRONT_UNMATCHED_STATUSES = ["unmatched"] as const;

/**
 * `match_status` values that are NOT part of the matchable population:
 * spam / system-notification rows deliberately dismissed, plus blocked.
 * Including these in a match-rate denominator is what produced the
 * misleading "~1%" headline (Bug A).
 *
 * Task #2637: the legacy `dismissed_operational` status is retired — the
 * operational classifier is gone and its backlog is re-matched into
 * matched / unmatched / dismissed / blocked, so it is no longer a bucket.
 */
export const FRONT_NON_MATCHABLE_STATUSES = [
  "dismissed",
  "blocked",
] as const;

/**
 * Pipeline states that are terminal "done" — a row here is NOT awaiting or
 * failing processing and must never be counted as backlog (Bug B).
 *  - `applied`: fully processed into NoBull.
 *  - `triage_dismissed`: intentionally dismissed at triage.
 */
export const FRONT_TERMINAL_DONE_PIPELINE_STATES = [
  "applied",
  "triage_dismissed",
] as const;

export type FrontMatchableStats = {
  /** auto_matched + manually_matched */
  matched: number;
  /** unmatched */
  unmatched: number;
  /** matched + unmatched — the match-rate denominator */
  matchable: number;
  /** dismissed + blocked */
  nonMatchable: number;
  /** every tracked row regardless of status */
  trackedTotal: number;
  /** matched / matchable, rounded to a whole percent (0 when no matchable rows) */
  matchRate: number;
};

function sumStatuses(byStatus: Record<string, number>, keys: readonly string[]): number {
  let total = 0;
  for (const k of keys) total += Number(byStatus[k]) || 0;
  return total;
}

/**
 * Task #2633 — message-grain console stats.
 *
 * Conversations are not a NoBull metric (Tasks #2602 / #2603 / #2604). The Front
 * Console must count individual MESSAGES (`raw_communication_records`,
 * source_type='front_email'), using `front_sync_emails` only as the internal
 * conversation-state lookup. This is the message-grain twin of
 * `FrontMatchableStats`:
 *  - `total`        — non-orphaned Front-email messages (the tracked population).
 *  - `matched`      — messages assigned to a client.
 *  - `unmatched`    — messages whose conversation is still `unmatched` (no client).
 *  - `matchable`    — matched + unmatched (constructed so the rate can't overflow,
 *                     mirroring the conversation-grain rule).
 *  - `nonMatchable` — messages whose conversation is dismissed / blocked.
 *  - `matchRate`    — matched ÷ matchable, whole percent.
 */
export type FrontMessageGrainStats = {
  total: number;
  matched: number;
  unmatched: number;
  matchable: number;
  nonMatchable: number;
  matchRate: number;
};

/**
 * Pure derivation of the canonical message-grain stats from the raw COUNTs the
 * query produces. Kept here (not in the query helper) so the server stats helper
 * and any test can share one definition of matchable / matchRate and never drift.
 */
export function deriveFrontMessageGrainStats(counts: {
  total: number;
  matched: number;
  unmatched: number;
  nonMatchable: number;
}): FrontMessageGrainStats {
  const matched = Number(counts.matched) || 0;
  const unmatched = Number(counts.unmatched) || 0;
  const matchable = matched + unmatched;
  const matchRate = matchable > 0 ? Math.round((matched / matchable) * 100) : 0;
  return {
    total: Number(counts.total) || 0,
    matched,
    unmatched,
    matchable,
    nonMatchable: Number(counts.nonMatchable) || 0,
    matchRate,
  };
}

/**
 * Task #2691 — "Bring it to 100%" reachable-target math (pure, shared so the
 * server summary helper and its unit tests can never drift).
 *
 * The Front Console headline is `applied / front_total` over the SAME in-scope,
 * message-grain months the all-time card sums (caller pre-filters to that set —
 * see `getFrontBringTo100Summary`). The honest ceiling is NOT 100%: a
 * plan-limited month (Front's analytics plan blocks its per-message history, so
 * its `ingest_gap` can never be fetched without a Front plan upgrade) caps the
 * reachable target. We therefore split the remaining gap into:
 *   - reachable work  = apply gap (fetched-not-applied; pure DB) +
 *     reachable ingest gap (ingest gap on NON-plan-limited months; re-pullable)
 *   - plan-limited remainder = ingest gap on plan-limited months (needs a Front
 *     plan upgrade — labeled, never chased by the button)
 * so "Bring it to 100%" converges to "as complete as Front allows" instead of
 * spinning forever. Verified against live prod coverage rows before wiring.
 *
 * Task #2705 — the plan-limited remainder is split further. Front's analytics
 * PLAN limit only blocks the Analytics-Reports denominator; the Conversations
 * Search API + per-message enumeration workaround (#1681/#1983) can still
 * enumerate a plan-limited month's messages. So we separate:
 *   - search-recoverable plan-limited gap — the button CAN still make progress
 *     here via the search workaround, so it counts toward the reachable target /
 *     the button's work (an approximation, "close enough" until enumeration
 *     completes), and
 *   - truly-unreachable plan-limited gap — search itself plan-limits / fails for
 *     the month, the only bucket that still needs a Front plan upgrade.
 * Grain safety is unchanged: the caller still only feeds message-grain months
 * into this math, so conversation-grain counts never pollute the headline.
 */
export type FrontBringTo100MonthInput = {
  frontTotalMessages: number;
  fetchedIntoNobull: number;
  appliedIntoNobull: number;
  ingestGap: number;
  applyGap: number;
  /** `analytics_plan_limited_at IS NOT NULL` — Front plan blocks this month's history. */
  planLimited: boolean;
  /**
   * Task #2705 — only meaningful when `planLimited`. True when the
   * conversation-search workaround can still enumerate this month's messages
   * (search did NOT hard-fail). Derive via `isFrontMonthSearchRecoverable`.
   * Defaults to falsy → treated as truly-unreachable (the conservative,
   * backward-compatible bucket).
   */
  searchRecoverable?: boolean;
  /**
   * Task #2745 — only meaningful when NOT `planLimited`. True when reach's deep
   * per-message search enumeration ran to exhaustion for this month and still
   * left an ingest gap: the gap is genuinely un-fetchable (no driver can close
   * it), so it is parked in `searchExhaustedRemainder` and EXCLUDED from
   * reachable work rather than spun on forever. Defaults falsy → treated as
   * reachable (backward compatible). A `planLimited` month ignores this flag —
   * its residue is classified by `searchRecoverable` instead.
   */
  deepSearchExhausted?: boolean;
  /**
   * Task #2722 — the month's coverage denominator unit (`messages_all` /
   * `inbound_messages` → message grain; `conversations_all` /
   * `inbound_conversations` → conversation grain). When omitted (legacy
   * callers / unit tests) the month is treated as message grain and counts
   * normally. A conversation-grain month is EXCLUDED from the message-grain
   * ceiling so a long conversation active in several months — returned once by
   * each month's `/conversations/search` — is not double-counted across
   * months. See `computeFrontBringTo100Target`.
   */
  denominatorUnit?: string | null;
};

export type FrontBringTo100Target = {
  frontTotal: number;
  applied: number;
  fetched: number;
  /** applied / frontTotal * 100 — the headline "% of messages logged". */
  loggedPct: number;
  /** applied + all reachable remaining work. */
  reachableApplied: number;
  /** reachableApplied / frontTotal * 100 — the honest ceiling. */
  reachableTargetPct: number;
  /** apply gap + reachable ingest gap — messages the button can still log. */
  reachableRemainingWork: number;
  /** fetched - applied — always reachable (pure DB drain/attribution). */
  applyGap: number;
  /** ingest gap on non-plan-limited months — re-pullable from Front. */
  reachableIngestGap: number;
  /**
   * Task #2705 — ingest gap on plan-limited months the conversation-search
   * workaround can still recover. Counted toward `reachableRemainingWork` (the
   * button chases it), an approximation until per-message enumeration completes.
   */
  searchRecoverableRemainder: number;
  /** searchRecoverableRemainder / frontTotal * 100. */
  searchRecoverableRemainderPct: number;
  /**
   * Task #2745 — ingest gap on NON-plan-limited months whose deep per-message
   * search enumeration is proven exhausted (`deepSearchExhausted`). Genuinely
   * un-fetchable: no driver can close it, so it is EXCLUDED from
   * `reachableRemainingWork` (the button can't spin on it forever) and reported
   * as its own honest bucket — distinct from `planLimitedRemainder`, which is a
   * Front-plan-upgrade concern, not a "we already searched exhaustively" one.
   */
  searchExhaustedRemainder: number;
  /** searchExhaustedRemainder / frontTotal * 100. */
  searchExhaustedRemainderPct: number;
  /**
   * ingest gap on plan-limited months search ITSELF cannot reach — the genuine
   * residual that needs a Front plan upgrade (the only "needs upgrade" bucket).
   */
  planLimitedRemainder: number;
  /** planLimitedRemainder / frontTotal * 100. */
  planLimitedRemainderPct: number;
  /**
   * Task #2722 — count of in-scope months excluded from this message-grain
   * ceiling because their denominator is still a conversation count (per-message
   * enumeration not yet complete). They are excluded — not summed — so a long
   * conversation active in several months is never double-counted across them.
   * The existing finish-message-grain / reach drivers converge these to message
   * grain, after which they count in-window, once each. 0 when none.
   */
  conversationGrainExcludedMonths: number;
  /**
   * Task #2722 — total conversation-grain denominator (conversations) sitting in
   * the excluded months, for an honest "still counted by conversation" note.
   * NOT a message count and deliberately NOT added to `frontTotal`.
   */
  conversationGrainExcludedConversations: number;
  /** true when no reachable work remains (button is done; spinning would be a lie). */
  atReachableTarget: boolean;
};

export function computeFrontBringTo100Target(
  months: FrontBringTo100MonthInput[],
): FrontBringTo100Target {
  let frontTotal = 0;
  let applied = 0;
  let fetched = 0;
  let reachableIngestGap = 0;
  let searchRecoverableRemainder = 0;
  let searchExhaustedRemainder = 0;
  let planLimitedRemainder = 0;
  let conversationGrainExcludedMonths = 0;
  let conversationGrainExcludedConversations = 0;
  for (const m of months) {
    // Task #2722 — a conversation-grain month (per-message enumeration not yet
    // complete; its denominator is a `/conversations/search` count) must NOT
    // feed the message-grain ceiling. A long-lived conversation active across
    // several months is returned by EVERY month's search, so summing those
    // months would count that one conversation once per month — inflating the
    // aggregate denominator with cross-month overlap. We exclude such months
    // from the ceiling entirely and tally them into an honest excluded-count
    // note; the existing finish-message-grain / reach drivers converge them to
    // message grain, at which point each in-window message counts exactly once.
    if (frontCoverageGrain(m.denominatorUnit) === "conversations") {
      conversationGrainExcludedMonths += 1;
      conversationGrainExcludedConversations += Math.max(
        0,
        Number(m.frontTotalMessages) || 0,
      );
      continue;
    }
    const total = Math.max(0, Number(m.frontTotalMessages) || 0);
    const a = Math.max(0, Number(m.appliedIntoNobull) || 0);
    const f = Math.max(0, Number(m.fetchedIntoNobull) || 0);
    const ingest = Math.max(0, Number(m.ingestGap) || 0);
    frontTotal += total;
    applied += a;
    fetched += f;
    if (m.planLimited) {
      // Task #2705 — a plan-limited month whose conversation-search workaround
      // can still enumerate its messages is reachable work the button drives;
      // only a month where search ITSELF plan-limits/fails is the genuine
      // residual that needs a Front plan upgrade.
      if (m.searchRecoverable) searchRecoverableRemainder += ingest;
      else planLimitedRemainder += ingest;
    } else if (m.deepSearchExhausted) {
      // Task #2745 — a NON-plan-limited month whose deep per-message search walk
      // is proven exhausted: the residual ingest gap is genuinely un-fetchable
      // (reach ran the walk to exhaustion). Park it in its own bucket, EXCLUDED
      // from reachable work, so the button converges instead of spinning forever
      // on a gap no driver can close.
      searchExhaustedRemainder += ingest;
    } else {
      reachableIngestGap += ingest;
    }
  }
  const applyGap = Math.max(0, fetched - applied);
  const reachableRemainingWork =
    applyGap + reachableIngestGap + searchRecoverableRemainder;
  const reachableApplied = Math.min(frontTotal, applied + reachableRemainingWork);
  const pct = (n: number) => (frontTotal > 0 ? (n / frontTotal) * 100 : 0);
  return {
    frontTotal,
    applied,
    fetched,
    loggedPct: pct(applied),
    reachableApplied,
    reachableTargetPct: pct(reachableApplied),
    reachableRemainingWork,
    applyGap,
    reachableIngestGap,
    searchRecoverableRemainder,
    searchRecoverableRemainderPct: pct(searchRecoverableRemainder),
    searchExhaustedRemainder,
    searchExhaustedRemainderPct: pct(searchExhaustedRemainder),
    planLimitedRemainder,
    planLimitedRemainderPct: pct(planLimitedRemainder),
    conversationGrainExcludedMonths,
    conversationGrainExcludedConversations,
    atReachableTarget: reachableRemainingWork === 0,
  };
}

/**
 * Task #2705 — whether a plan-limited month can still be recovered by the
 * conversation-search + per-message enumeration workaround (#1681/#1983), as
 * opposed to being genuinely unreachable. Front's analytics PLAN limit blocks
 * the Analytics-Reports denominator, but the Conversations Search API + the
 * per-message walk can still enumerate the month's messages — UNLESS search
 * itself hard-fails (Front auth dead → `auth_blocked`, a generic `error`, or a
 * search-fallback failure stamped into `front_analytics_error`). Pure +
 * presentation-safe: classifies from the coverage row's own status/error
 * fields and makes no Front call. Only meaningful for a plan-limited month.
 */
export function isFrontMonthSearchRecoverable(row: {
  frontAnalyticsStatus?: string | null;
  frontAnalyticsError?: string | null;
}): boolean {
  const status = row.frontAnalyticsStatus ?? "";
  const err = row.frontAnalyticsError ?? "";
  // Task #2743 — a TRANSIENT search failure (a transport abort / timeout, or a
  // rate-limit that exhausted its budget) is still REACHABLE — it just needs
  // another tick, not a Front plan upgrade. These are persisted with
  // `frontAnalyticsStatus='error'`, so this check MUST come before the coarse
  // `status === 'error'` gate below, otherwise a single aborted request
  // permanently latches a reachable month into the "needs a plan upgrade"
  // bucket (the Nov-2025 ceiling bug). Only genuine plan-retention /
  // query-shape / auth failures fall through to unreachable.
  //
  // We match two shapes:
  //   - the retriable code prefixes introduced going forward, AND
  //   - the legacy `front_analytics_search_failed: Front search transport
  //     error: ...` string that pre-fix rows (like the stuck Nov-2025 row)
  //     were stamped with before the retriable code existed — detected by the
  //     distinctive "transport error" phrase, which genuine query-shape 4xx /
  //     plan / auth messages never contain. This lets the existing driver pick
  //     the row back up on the next run without a manual DB edit.
  if (
    err.startsWith("front_analytics_transport_failed") ||
    err.startsWith("front_analytics_rate_limited") ||
    err.toLowerCase().includes("transport error")
  ) {
    return true;
  }
  if (status === "error" || status === "auth_blocked") return false;
  if (err.startsWith("front_analytics_search_failed")) return false;
  return true;
}

/**
 * Derive the canonical matchable-population stats from a
 * `front_sync_emails` match_status histogram.
 */
export function computeFrontMatchableStats(
  byStatus: Record<string, number>,
): FrontMatchableStats {
  const matched = sumStatuses(byStatus, FRONT_MATCHED_STATUSES);
  const unmatched = sumStatuses(byStatus, FRONT_UNMATCHED_STATUSES);
  const nonMatchable = sumStatuses(byStatus, FRONT_NON_MATCHABLE_STATUSES);
  const matchable = matched + unmatched;
  let trackedTotal = 0;
  for (const v of Object.values(byStatus)) trackedTotal += Number(v) || 0;
  const matchRate = matchable > 0 ? Math.round((matched / matchable) * 100) : 0;
  return {
    matched,
    unmatched,
    matchable,
    nonMatchable,
    trackedTotal,
    matchRate,
  };
}

/**
 * Real backlog = pipeline rows NOT in a terminal-done state. Sums every
 * `pipeline_state` bucket except `applied` / `triage_dismissed`, so already-done
 * rows never inflate the backlog (Bug B). Failed and dead_lettered DO count as
 * backlog because they still need attention.
 */
export function computeFrontBacklogCount(backlogs: Record<string, number>): number {
  let total = 0;
  for (const [state, count] of Object.entries(backlogs)) {
    if ((FRONT_TERMINAL_DONE_PIPELINE_STATES as readonly string[]).includes(state)) continue;
    total += Number(count) || 0;
  }
  return total;
}

/** Count of terminal-done pipeline rows (applied + triage_dismissed). */
export function computeFrontAppliedDoneCount(backlogs: Record<string, number>): number {
  let total = 0;
  for (const state of FRONT_TERMINAL_DONE_PIPELINE_STATES) {
    total += Number(backlogs[state]) || 0;
  }
  return total;
}

/**
 * Task #2510 — one conversations-vs-messages story across both Front console
 * screens. Pipeline Health counts de-duplicated CONVERSATIONS; Analytics
 * Coverage counts individual MESSAGES (inbound + outbound). Historically the
 * two screens never stated which grain each number was in, so a ~100%
 * conversation figure read as if it contradicted a ~6.6% message figure. These
 * plain-English grain labels + the single shared caption live here so both
 * screens (and the docs) can never word the distinction differently.
 *
 * Presentation only — nothing here changes any count, query, denominator, or
 * threshold.
 */

/** Grain word for a conversation-grain figure (Pipeline Health, search fallback). */
export const FRONT_GRAIN_CONVERSATIONS = "conversations" as const;

/** Grain word for a message-grain figure (Analytics Coverage headline). */
export const FRONT_GRAIN_MESSAGES = "messages (inbound + outbound)" as const;

export type FrontCoverageGrain = "messages" | "conversations" | "unknown";

/**
 * Classify a coverage row's denominator unit into a plain-English grain.
 *  - `messages_all` / `inbound_messages` → message grain.
 *  - `conversations_all` / `inbound_conversations` (search fallback) →
 *    conversation grain.
 * Mirrors the unit constants in server/services/frontAnalyticsCoverage.ts.
 * Presentation only.
 */
export function frontCoverageGrain(
  denominatorUnit: string | null | undefined,
): FrontCoverageGrain {
  switch (denominatorUnit) {
    case "messages_all":
    case "inbound_messages":
      return "messages";
    case "conversations_all":
    case "inbound_conversations":
      return "conversations";
    default:
      return "unknown";
  }
}

/** Short inline grain label: "message-grain" / "conversation-grain" / "grain unknown". */
export function frontCoverageGrainLabel(
  denominatorUnit: string | null | undefined,
): string {
  const g = frontCoverageGrain(denominatorUnit);
  if (g === "messages") return "message-grain";
  if (g === "conversations") return "conversation-grain";
  return "grain unknown";
}

/**
 * Task #2669 — honest conversation-grain fallback for plan-limited months.
 *
 * Front's analytics plan only retains a limited per-message history window. For
 * older months outside that window, NoBull can never pull message-grain data;
 * the month's denominator is instead a CONVERSATION count from the search-API
 * fallback (#1681) and the month carries an `analytics_plan_limited_at` memo.
 * Rendering a message-grain coverage % for such a month is misleading — it reads
 * as data we lost, when in truth Front never exposes the per-message history at
 * all. Instead we surface the trustworthy conversation count with an explicit
 * unit + reason ("X of Y conversations — Front plan blocks per-message history").
 *
 * Grain safety: BOTH sides are conversations — `fetchedIntoNobull`
 * (front_sync_emails, one row per conversation NoBull pulled) of
 * `frontTotalMessages` (the search-fallback conversation denominator). We
 * deliberately do NOT use `appliedIntoNobull` (a message-grain row count), which
 * would mix grains. This is presentation-only — it changes no count, query,
 * denominator, threshold, or alert.
 */
export const FRONT_PLAN_LIMITED_REASON =
  "Front plan blocks per-message history" as const;

export type FrontPlanLimitedFallback = {
  /** Conversations NoBull fetched (front_sync_emails) — conversation grain. */
  coveredConversations: number;
  /** Conversations Front reports for the month (search fallback) — conversation grain. */
  totalConversations: number;
  /** coveredConversations ÷ totalConversations, the existing fetched-coverage %. */
  coveragePct: number;
  /** "X of Y conversations — Front plan blocks per-message history". */
  label: string;
};

/**
 * Returns a conversation-grain fallback descriptor when a coverage month is
 * plan-limited AND its denominator is genuinely conversation grain; otherwise
 * `null` (the month stays strict message-grain and renders its normal %).
 *
 * Trigger is keyed strictly on the `analyticsPlanLimitedAt` memo — NOT on the
 * search-fallback source alone — so a transitional / force-search row that is
 * not plan-limited is never relabeled with conversation vocabulary (Task #2603
 * keeps non-plan-limited rows message-grain-only).
 */
export function frontPlanLimitedFallback(month: {
  analyticsPlanLimitedAt: string | null;
  denominatorUnit: string | null;
  fetchedIntoNobull: number;
  frontTotalMessages: number;
  fetchedCoveragePct: number;
}): FrontPlanLimitedFallback | null {
  const planLimited = month.analyticsPlanLimitedAt != null;
  const conversationGrain =
    frontCoverageGrain(month.denominatorUnit) === "conversations";
  if (!planLimited || !conversationGrain) return null;
  const coveredConversations = Number(month.fetchedIntoNobull) || 0;
  const totalConversations = Number(month.frontTotalMessages) || 0;
  const coveragePct = Number(month.fetchedCoveragePct) || 0;
  return {
    coveredConversations,
    totalConversations,
    coveragePct,
    label: `${coveredConversations.toLocaleString()} of ${totalConversations.toLocaleString()} conversations — ${FRONT_PLAN_LIMITED_REASON}`,
  };
}

/**
 * Task #2685 — One honest source of truth for "completeness".
 *
 * The Front Console answers THREE different questions with the same words
 * ("complete", "covered", "gaps", "no backlog"), each computed from a different
 * table/lens. Read alone every figure is correct; side by side they look like
 * they contradict each other. The fix is presentation/reconciliation only —
 * nothing here changes ingestion, matching, counts, denominators, thresholds,
 * or alerts. It (1) names each lens with a distinct question + vocabulary,
 * (2) registers every console figure against its lens/grain/source so a renamed
 * or relabelled figure can't silently drift, and (3) reconciles the all-time
 * coverage numbers into one identity + plain-English sentence so an operator can
 * see WHY "no backlog" and "25% covered" are both true at once.
 */

/** The three populations/lenses the Front Console reads. */
export type FrontConsoleLens = 1 | 2 | 3;

export type FrontConsoleLensInfo = {
  lens: FrontConsoleLens;
  /** Short tab/section label, e.g. "Processing pipeline (of fetched messages)". */
  title: string;
  /** The single question this lens answers — never reused by another lens. */
  question: string;
  /**
   * The word this lens uses for its "done" concept. Deliberately distinct per
   * lens so the same word never means two things on one screen.
   */
  completenessNoun: string;
};

export const FRONT_CONSOLE_LENSES: Readonly<Record<FrontConsoleLens, FrontConsoleLensInfo>> = {
  1: {
    lens: 1,
    title: "Processing pipeline (of fetched messages)",
    question:
      "Of the messages we already fetched, how many are processed vs still queued or failing?",
    completenessNoun: "drained",
  },
  2: {
    lens: 2,
    title: "Ingestion coverage vs Front",
    question:
      "Of every message Front recorded, how many did we fetch and apply into NoBull?",
    completenessNoun: "covered",
  },
  3: {
    lens: 3,
    title: "Recovery run progress (per run)",
    question: "For a single recovery run, how much did that run scan and ingest?",
    completenessNoun: "run-complete",
  },
} as const;

/** Resolve the lens descriptor for a numeric lens. */
export function frontConsoleLens(lens: FrontConsoleLens): FrontConsoleLensInfo {
  return FRONT_CONSOLE_LENSES[lens];
}

export type FrontMetricGrain =
  | "messages"
  | "conversations"
  | "runs"
  | "n/a";

export type FrontMetricTimeWindow =
  | "all-time"
  | "per-month"
  | "per-run"
  | "live";

/**
 * A declarative descriptor for one figure rendered anywhere on the Front
 * Console. Registering every figure here makes its lens, grain, source table,
 * numerator, denominator, and time window explicit and traceable — so a figure
 * can never be quietly re-pointed at a different table or relabelled with
 * another lens's vocabulary without a registry change (and a failing guard).
 */
export type FrontConsoleMetricDescriptor = {
  /** Stable id, namespaced by lens (`front.pipeline.*`, `front.coverage.*`, `front.recovery.*`). */
  id: string;
  /** The exact question THIS figure answers (a refinement of its lens question). */
  question: string;
  lens: FrontConsoleLens;
  grain: FrontMetricGrain;
  /** The authoritative table/source the figure is computed from. */
  sourceTable: string;
  /** What the numerator counts (plain English). */
  numerator: string;
  /** What the denominator counts, or "n/a" for a raw count. */
  denominator: string;
  timeWindow: FrontMetricTimeWindow;
};

export const FRONT_CONSOLE_METRIC_REGISTRY: readonly FrontConsoleMetricDescriptor[] = [
  // ── Lens 1 — Processing pipeline (of fetched messages) ──
  {
    id: "front.pipeline.tracked_total",
    question: "How many conversations are tracked in the processing pipeline?",
    lens: 1,
    grain: "conversations",
    sourceTable: "front_sync_emails",
    numerator: "tracked rows (any match_status)",
    denominator: "n/a",
    timeWindow: "live",
  },
  {
    id: "front.pipeline.matched",
    question: "How many tracked rows are matched to a client?",
    lens: 1,
    grain: "conversations",
    sourceTable: "front_sync_emails",
    numerator: "match_status auto_matched + manually_matched",
    denominator: "n/a",
    timeWindow: "live",
  },
  {
    id: "front.pipeline.unmatched",
    question: "How many tracked rows still await a client match?",
    lens: 1,
    grain: "conversations",
    sourceTable: "front_sync_emails",
    numerator: "match_status unmatched",
    denominator: "n/a",
    timeWindow: "live",
  },
  {
    id: "front.pipeline.match_rate",
    question: "What fraction of matchable tracked rows are matched?",
    lens: 1,
    grain: "conversations",
    sourceTable: "front_sync_emails",
    numerator: "matched",
    denominator: "matched + unmatched (matchable)",
    timeWindow: "live",
  },
  {
    id: "front.pipeline.backlog",
    question: "How many fetched rows are still queued or failing processing?",
    lens: 1,
    grain: "conversations",
    sourceTable: "front_sync_emails (pipeline_state)",
    numerator: "rows not in a terminal-done state",
    denominator: "n/a",
    timeWindow: "live",
  },
  {
    id: "front.pipeline.applied_done",
    question: "How many fetched rows are fully processed or dismissed at triage?",
    lens: 1,
    grain: "conversations",
    sourceTable: "front_sync_emails (pipeline_state)",
    numerator: "pipeline_state applied + triage_dismissed",
    denominator: "n/a",
    timeWindow: "live",
  },
  // ── Lens 2 — Ingestion coverage vs Front (all-time) ──
  {
    id: "front.coverage.front_total",
    question: "How many messages did Front record (all-time, in scope)?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "sum frontTotalMessages of in-scope message-grain months",
    denominator: "n/a",
    timeWindow: "all-time",
  },
  {
    id: "front.coverage.fetched",
    question: "How many of Front's messages did we fetch into NoBull?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "sum fetchedIntoNobull",
    denominator: "n/a",
    timeWindow: "all-time",
  },
  {
    id: "front.coverage.applied",
    question: "How many of Front's messages did we apply (process) into NoBull?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "sum appliedIntoNobull",
    denominator: "n/a",
    timeWindow: "all-time",
  },
  {
    id: "front.coverage.fetched_pct",
    question: "What share of Front's messages did we fetch?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "fetched",
    denominator: "front total",
    timeWindow: "all-time",
  },
  {
    id: "front.coverage.applied_pct",
    question: "What share of Front's messages did we apply?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "applied",
    denominator: "front total",
    timeWindow: "all-time",
  },
  {
    id: "front.coverage.ingest_gap",
    question: "How many of Front's messages did we never fetch?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "front total − fetched",
    denominator: "n/a",
    timeWindow: "all-time",
  },
  {
    id: "front.coverage.apply_gap",
    question: "How many fetched messages did we never apply?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "fetched − applied",
    denominator: "n/a",
    timeWindow: "all-time",
  },
  // ── Lens 2 — per-month coverage table ──
  {
    id: "front.coverage.month_front_total",
    question: "How many messages did Front record this month?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "frontTotalMessages",
    denominator: "n/a",
    timeWindow: "per-month",
  },
  {
    id: "front.coverage.month_fetched",
    question: "How many of this month's messages did we fetch?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "fetchedIntoNobull",
    denominator: "n/a",
    timeWindow: "per-month",
  },
  {
    id: "front.coverage.month_applied",
    question: "How many of this month's messages did we apply?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "appliedIntoNobull",
    denominator: "n/a",
    timeWindow: "per-month",
  },
  {
    id: "front.coverage.month_ingest_gap",
    question: "How many of this month's messages did we never fetch?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "frontTotalMessages − fetchedIntoNobull",
    denominator: "n/a",
    timeWindow: "per-month",
  },
  {
    id: "front.coverage.month_apply_gap",
    question: "How many of this month's fetched messages did we never apply?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "fetchedIntoNobull − appliedIntoNobull",
    denominator: "n/a",
    timeWindow: "per-month",
  },
  {
    id: "front.coverage.month_fetched_pct",
    question: "What share of this month's messages did we fetch?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "fetchedIntoNobull",
    denominator: "frontTotalMessages",
    timeWindow: "per-month",
  },
  {
    id: "front.coverage.month_applied_pct",
    question: "What share of this month's messages did we apply?",
    lens: 2,
    grain: "messages",
    sourceTable: "front_analytics_monthly_coverage",
    numerator: "appliedIntoNobull",
    denominator: "frontTotalMessages",
    timeWindow: "per-month",
  },
  // ── Lens 3 — Recovery run progress (per run) ──
  {
    id: "front.recovery.scanned",
    question: "How many conversations did this recovery run scan?",
    lens: 3,
    grain: "conversations",
    sourceTable: "front historical-recovery jobs",
    numerator: "conversations scanned by the run",
    denominator: "n/a",
    timeWindow: "per-run",
  },
  {
    id: "front.recovery.ingested",
    question: "How many conversations did this recovery run ingest?",
    lens: 3,
    grain: "conversations",
    sourceTable: "front historical-recovery jobs",
    numerator: "conversations ingested by the run",
    denominator: "n/a",
    timeWindow: "per-run",
  },
  {
    id: "front.recovery.known_conv_messages_backfilled",
    question:
      "How many per-message rows did the known-conversation backfill write this run?",
    lens: 3,
    grain: "messages",
    sourceTable: "front_sync_emails → GET /conversations/{id}/messages",
    numerator:
      "raw_communication_records rows materialized for conversations already tracked in front_sync_emails (deduped on external_source_id)",
    denominator: "n/a",
    timeWindow: "per-run",
  },
] as const;

/** Look up one registry descriptor by id (throws on an unknown id). */
export function getFrontConsoleMetric(id: string): FrontConsoleMetricDescriptor {
  const found = FRONT_CONSOLE_METRIC_REGISTRY.find((m) => m.id === id);
  if (!found) {
    throw new Error(`Unknown Front Console metric id: ${id}`);
  }
  return found;
}

/** Every descriptor for a given lens. */
export function frontConsoleMetricsForLens(
  lens: FrontConsoleLens,
): FrontConsoleMetricDescriptor[] {
  return FRONT_CONSOLE_METRIC_REGISTRY.filter((m) => m.lens === lens);
}

/**
 * Task #2685 — all-time coverage reconciliation.
 *
 * The three coverage figures only LOOK contradictory because nobody states the
 * identity that ties them together:
 *
 *   front total = applied + apply gap + ingest gap
 *
 * where `apply gap = fetched − applied` (fetched but not yet processed) and
 * `ingest gap = front total − fetched` (Front has it, we never fetched it). This
 * makes it obvious that a drained pipeline (apply gap ≈ 0) and a low coverage %
 * (large ingest gap) are perfectly consistent. Pure arithmetic over numbers the
 * summary already returns — no new query, count, or Front API call.
 */
export type FrontCoverageReconciliation = {
  frontTotal: number;
  fetched: number;
  applied: number;
  /** applied ÷ frontTotal, capped at 100 (0 when frontTotal is 0). */
  appliedPct: number;
  /** fetched ÷ frontTotal, capped at 100. */
  fetchedPct: number;
  /** fetched − applied (fetched but not applied). */
  applyGap: number;
  /** frontTotal − fetched (Front has it, never fetched). */
  ingestGap: number;
  /** frontTotal − applied (everything not yet processed into NoBull). */
  notInNobull: number;
  /** True when applied + applyGap + ingestGap === frontTotal and gaps are non-negative. */
  identityHolds: boolean;
};

export function computeFrontCoverageReconciliation(input: {
  frontTotal: number;
  fetched: number;
  applied: number;
}): FrontCoverageReconciliation {
  const frontTotal = Number(input.frontTotal) || 0;
  const fetched = Number(input.fetched) || 0;
  const applied = Number(input.applied) || 0;
  const ingestGap = Math.max(0, frontTotal - fetched);
  const applyGap = Math.max(0, fetched - applied);
  const notInNobull = Math.max(0, frontTotal - applied);
  const appliedPct =
    frontTotal > 0 ? Math.min(100, (applied / frontTotal) * 100) : 0;
  const fetchedPct =
    frontTotal > 0 ? Math.min(100, (fetched / frontTotal) * 100) : 0;
  const identityHolds =
    frontTotal >= fetched &&
    fetched >= applied &&
    applied >= 0 &&
    applied + applyGap + ingestGap === frontTotal;
  return {
    frontTotal,
    fetched,
    applied,
    appliedPct,
    fetchedPct,
    applyGap,
    ingestGap,
    notInNobull,
    identityHolds,
  };
}

/**
 * Plain-English, message-grain reconciliation sentence. Deliberately free of any
 * "conversation" vocabulary so it can render unconditionally on the
 * message-grain-only console (Task #2603).
 */
export function frontReconciliationSentence(
  r: FrontCoverageReconciliation,
): string {
  const pct = (n: number) => `${n.toFixed(1)}%`;
  const num = (n: number) => n.toLocaleString();
  return (
    `Front recorded ${num(r.frontTotal)} messages. ` +
    `NoBull fetched ${num(r.fetched)} (${pct(r.fetchedPct)}) and applied ${num(r.applied)} (${pct(r.appliedPct)}). ` +
    `Of the ${num(r.notInNobull)} not yet in NoBull, ${num(r.ingestGap)} were never fetched (ingest gap) ` +
    `and ${num(r.applyGap)} were fetched but not applied (apply gap).`
  );
}

/**
 * The bridge that stops Lens 1 and Lens 2 from reading as a contradiction. A
 * drained pipeline only proves everything ALREADY FETCHED is processed; it says
 * nothing about whether we fetched everything Front has. Message-grain wording
 * only — no "conversation" vocabulary, so it is safe to render unconditionally.
 */
export const FRONT_PIPELINE_BRIDGE_NOTE =
  'Pipeline Health "no backlog" means everything already fetched is processed — it does NOT mean every Front message was fetched. Ingestion coverage (the % above) is the honest "did we fetch everything" measure.' as const;

/**
 * Task #2685 — resolve the confusing `messages_all` + `analytics_plan_limited_at`
 * combination. A plan-limited month can be in one of three honest states:
 *  - `none`                   — not plan-limited; render the normal %.
 *  - `conversation-fallback`  — plan-limited AND its denominator is a
 *                               conversation count (Front blocks per-message
 *                               history); render `frontPlanLimitedFallback`.
 *  - `message-grain-memoized` — plan-limited YET already at message grain: the %
 *                               is a real message-grain figure, but the row still
 *                               carries a plan-limit memo (set when first probed,
 *                               re-checked on a TTL). Without a label this looks
 *                               like a message-grain % sitting next to a
 *                               plan-limited flag, i.e. a contradiction.
 */
export type FrontPlanLimitState =
  | "none"
  | "conversation-fallback"
  | "message-grain-memoized";

export function frontPlanLimitState(month: {
  analyticsPlanLimitedAt: string | null;
  denominatorUnit: string | null;
}): FrontPlanLimitState {
  if (month.analyticsPlanLimitedAt == null) return "none";
  return frontCoverageGrain(month.denominatorUnit) === "conversations"
    ? "conversation-fallback"
    : "message-grain-memoized";
}

/**
 * Note shown beside a `message-grain-memoized` month so the message-grain % and
 * the plan-limit memo don't read as a contradiction. Message-grain wording only.
 */
export const FRONT_PLAN_LIMITED_MEMO_NOTE =
  "Message-grain figure. Carries a Front analytics-plan memo: per-message history was capped when first probed and is re-checked on a TTL — the % shown is the message-grain coverage already obtained, not a lost figure." as const;

/**
 * Human-readable definitions reused by UI tooltips/captions AND the docs/audit
 * note, so the page and the documentation always say the same thing.
 */
export const FRONT_CONSOLE_METRIC_DEFINITIONS = {
  rawImported:
    "All Front records ever imported (raw_communication_records, source_type='front_email'). Includes per-version duplicates — not a count of distinct conversations.",
  trackedTotal:
    "Tracked conversations (front_sync_emails) — the de-duplicated operational rows, one per conversation.",
  matched:
    "Tracked conversations matched to a client (match_status auto_matched or manually_matched).",
  unmatched:
    "Tracked conversations awaiting a client match (match_status unmatched).",
  matchable:
    "Matchable conversations = matched + unmatched. Excludes dismissed-operational / spam / notification / blocked rows.",
  matchRate:
    "Matched ÷ matchable conversations. Excludes non-matchable rows, so it is not diluted by operational dismissals.",
  backlog:
    "Pipeline rows still awaiting or failing processing (every pipeline_state except applied and triage_dismissed). Includes failed and dead-lettered.",
  appliedDone:
    "Pipeline rows already processed to completion (pipeline_state applied) or intentionally dismissed at triage (triage_dismissed).",
} as const;

// ---------------------------------------------------------------------------
// Task #4367 — clamped percent DISPLAY (presentation only; audit P1-5 §6.2).
//
// The Front console once rendered a raw "903.6%" coverage headline: a stored
// ratio whose numerator/denominator counts had drifted apart was presented as
// truth, torpedoing operator trust in every other health figure. The
// COMPUTATION is governed elsewhere (coverage-numerator-denominator-grain
// memo; §10.2 of the audit keeps it out of scope) — this helper only decides
// how a console percentage is PRESENTED:
//
//   - missing (null/undefined/NaN/non-finite) → "—" (never a fake 0)
//   - out of range (< 0% or > 100% + epsilon) → an explicit data-quality
//     state ("needs recount") instead of an impossible number; the raw value
//     is preserved for the tooltip so operators keep the evidence.
//   - in range → clamped to [0, 100] and formatted with the caller's digit
//     count. A hair over 100 (≤ epsilon, e.g. 100.04 from serialized
//     rounding) clamps to 100 rather than flagging.
//
// Display-only by design: it never mutates stored values, never rounds into
// storage, and never reinterprets grain semantics.
// ---------------------------------------------------------------------------

/**
 * Rounding slack for serialized ratios (e.g. 100.04% from a numeric column
 * rounded at write time). Values beyond ±epsilon of [0, 100] are impossible
 * ratios — the counts disagree — and are flagged, never clamped into a fake
 * 0% or 100%.
 */
export const FRONT_PERCENT_DISPLAY_EPSILON = 0.05;

/** Compact data-quality label rendered in place of an impossible percentage. */
export const FRONT_PERCENT_NEEDS_RECOUNT_LABEL = "needs recount";

/** Placeholder for a missing (null/NaN) percentage — the console's "—" convention. */
export const FRONT_PERCENT_MISSING_TEXT = "—";

/** Tooltip/explanation for an out-of-range percentage, carrying the raw value as evidence. */
export function frontPercentOutOfRangeTitle(raw: number): string {
  return (
    `Out-of-range figure: ${raw.toFixed(1)}%. A coverage ratio must sit between 0% and 100%, ` +
    `so the stored numerator and denominator counts disagree. Run a recount ` +
    `(recompute coverage for the affected months) before trusting this figure.`
  );
}

export type FrontPercentDisplay =
  | {
      /** In-range (after ≤ epsilon rounding slack is clamped away). */
      state: "ok";
      /** Clamped to [0, 100] — safe for text AND width/progress props. */
      value: number;
      /** e.g. "80.0%" (digit count chosen by the call site). */
      text: string;
    }
  | {
      /** Impossible ratio — presented as a data-quality state, never a number. */
      state: "out_of_range";
      /** The raw offending value, for tooltips/diagnostics only. */
      raw: number;
      /** FRONT_PERCENT_NEEDS_RECOUNT_LABEL. */
      text: string;
      /** Ready-made tooltip naming the raw value + the remedy. */
      title: string;
    }
  | {
      /** Null/undefined/NaN/non-finite input. */
      state: "missing";
      /** FRONT_PERCENT_MISSING_TEXT ("—"). */
      text: string;
    };

/**
 * The ONE presentation gate for console percentages. `digits` mirrors each
 * call site's existing precision (KPI tiles 0, hero 1, coverage tables 2) so
 * in-range values render byte-identically to the pre-#4367 console.
 */
export function frontPercentDisplay(
  raw: number | string | null | undefined,
  digits = 1,
): FrontPercentDisplay {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return { state: "missing", text: FRONT_PERCENT_MISSING_TEXT };
  }
  if (
    n < -FRONT_PERCENT_DISPLAY_EPSILON ||
    n > 100 + FRONT_PERCENT_DISPLAY_EPSILON
  ) {
    return {
      state: "out_of_range",
      raw: n,
      text: FRONT_PERCENT_NEEDS_RECOUNT_LABEL,
      title: frontPercentOutOfRangeTitle(n),
    };
  }
  const value = Math.min(100, Math.max(0, n));
  return { state: "ok", value, text: `${value.toFixed(digits)}%` };
}
