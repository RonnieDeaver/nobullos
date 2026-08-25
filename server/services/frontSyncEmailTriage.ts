/**
 * Task #1271 / #2637 — Canonical triage helper for `front_sync_emails` ingestion.
 *
 * Background:
 *   Task #825 wired filter-rule evaluation into Front sync_email ingestion,
 *   but every ingestion site (`reEvaluateExistingUnmatched`,
 *   `reprocessSyncEmailBatch`, `rematchSyncEmailBatch`,
 *   `reprocessDismissedNonSpam`, `rematchAll`) re-implemented the same
 *   filter-rule branching inline. That made it easy for a future ingestion
 *   path to forget the filter-rule call and silently regress — a brand-new
 *   email could slip past a "block" rule until the next re-evaluation cycle.
 *
 * This module is the single shared entry point. Every ingestion site that
 * iterates `front_sync_emails` rows must route them through
 * `triageSyncEmailForMatching` before any matcher runs. The static guard
 * `scripts/lint-front-sync-email-triage.ts` fails the build if a new
 * function in `server/services/frontIntegration.ts` lists sync_email rows
 * without calling this helper.
 *
 * Task #2637 removed the operational classifier (auto-dismiss). The ONLY
 * thing that may dismiss/block a message is an operator-authored manual
 * filter rule. There is no longer any AI / heuristic / learned-memory
 * dismissal tier.
 *
 * Outcomes:
 *   - `filter_rule_handled` — row was mutated to `blocked`/`dismissed` and
 *     short-circuited. Caller should bump its dismissed counter and skip
 *     all downstream processing.
 *   - `skip_match` — row matched a `never_match` rule. Row is left as-is
 *     but the caller must NOT run the matcher.
 *   - `proceed` — no rule fired; caller proceeds with its own matcher.
 */

import { storage } from "../storage";

export type TriageSyncEmailInput = {
  id: string;
  subject: string | null;
  snippet?: string | null;
  participantsJson: unknown;
  conversationId?: string | null;
};

export type TriageOutcome =
  | {
      outcome: "filter_rule_handled";
      ruleType: "block" | "dismiss";
      ruleId: string | null;
    }
  | {
      outcome: "skip_match";
      reason: "never_match";
      ruleId: string | null;
    }
  | {
      outcome: "proceed";
    };

export type TriageOptions = {
  /**
   * Who is performing the triage. Stamped onto `dismissedBy` for filter
   * rule mutations. Falls back to `"system"` when null.
   */
  userId?: string | null;
  /**
   * Diagnostic prefix used in error logs so operators can tell which
   * ingestion path produced a warning.
   */
  logTag?: string;
};

/**
 * Filter-rule branch — owns every `matchStatus: "blocked"|"dismissed"`
 * mutation on `front_sync_emails`. The lint guard
 * (`scripts/lint-front-sync-email-triage.ts`) enforces that this is the
 * only call site that writes those statuses outside the operator-facing
 * paths (admin block/dismiss routes and bulk-actions) which are
 * explicitly allow-listed.
 */
async function applyFilterRules(
  email: TriageSyncEmailInput,
  userId: string | null,
): Promise<
  | { handled: true; ruleType: "block" | "dismiss"; ruleId: string | null }
  | { handled: false; neverMatch: false; ruleId: null }
  | { handled: false; neverMatch: true; ruleId: string | null }
> {
  try {
    const { evaluateFilterRules, recordRuleHit } = await import("./frontFilterRules");
    const participants = (email.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];
    // Front "channel" === inbox handle (role === "recipient"). Mirror the
    // semantics of the canonical evaluator so prospective and retroactive
    // applies agree on cohort.
    const channels = participants
      .filter((p) => (p?.role || "").toLowerCase() === "recipient")
      .map((p) => (p?.email || "").toLowerCase())
      .filter((e) => e.length > 0);
    const result = await evaluateFilterRules({
      subject: email.subject,
      participants,
      channels,
    });
    if (!result.matched) {
      return { handled: false, neverMatch: false, ruleId: null };
    }
    const matchReason = `Filter rule ${result.ruleId} (${result.scope}=${result.value})`;
    // Task #1270: pull a representative sender (non-recipient/team participant)
    // so the admin drill-down shows who fired the rule, not just the inbox.
    const senderEmail = (participants.find((p) => {
      const r = (p?.role || "").toLowerCase();
      return r !== "recipient" && r !== "team" && (p?.email || "").length > 0;
    })?.email ?? null) as string | null;
    const hitContext = {
      source: "sync_email" as const,
      syncEmailId: email.id,
      conversationId: email.conversationId ?? null,
      senderEmail,
      subject: email.subject ?? null,
      ruleType: result.type,
    };
    if (result.type === "block") {
      await storage.updateFrontSyncEmail(email.id, {
        matchStatus: "blocked",
        dismissedBy: userId ?? "system",
        matchReason,
        processedAt: new Date(),
      });
      recordRuleHit(result.ruleId, hitContext);
      return { handled: true, ruleType: "block", ruleId: result.ruleId };
    }
    if (result.type === "dismiss") {
      await storage.updateFrontSyncEmail(email.id, {
        matchStatus: "dismissed",
        dismissedBy: userId ?? "system",
        matchReason,
        processedAt: new Date(),
      });
      recordRuleHit(result.ruleId, hitContext);
      return { handled: true, ruleType: "dismiss", ruleId: result.ruleId };
    }
    // never_match — caller leaves the row alone but skips auto-matching.
    recordRuleHit(result.ruleId, hitContext);
    return { handled: false, neverMatch: true, ruleId: result.ruleId };
  } catch (err) {
    console.error(
      `[FrontSyncEmailTriage] filter-rule evaluation failed for sync_email ${email.id}:`,
      (err as Error).message,
    );
    return { handled: false, neverMatch: false, ruleId: null };
  }
}

/**
 * Run the ingestion triage on a `front_sync_emails` row:
 *   1. Operator-authored manual filter rules (block / dismiss / never_match)
 *
 * Task #2637 removed the operational classifier. Manual filter rules are
 * the only thing that may dismiss/block a row; everything else proceeds to
 * the caller's deterministic matcher (or lands in Unmatched).
 *
 * The returned discriminated union tells the caller exactly what to do
 * next — see the `TriageOutcome` doc for semantics.
 */
export async function triageSyncEmailForMatching(
  email: TriageSyncEmailInput,
  options: TriageOptions = {},
): Promise<TriageOutcome> {
  const userId = options.userId ?? null;

  const filterRuleOutcome = await applyFilterRules(email, userId);
  if (filterRuleOutcome.handled) {
    return {
      outcome: "filter_rule_handled",
      ruleType: filterRuleOutcome.ruleType,
      ruleId: filterRuleOutcome.ruleId,
    };
  }

  if (filterRuleOutcome.neverMatch === true) {
    return {
      outcome: "skip_match",
      reason: "never_match",
      ruleId: filterRuleOutcome.ruleId,
    };
  }

  return { outcome: "proceed" };
}

/**
 * Back-compat re-export. Older callers can import this without learning
 * the new discriminated union — but new code should prefer
 * `triageSyncEmailForMatching` directly.
 */
export async function applyFilterRulesToSyncEmail(
  email: TriageSyncEmailInput,
  userId: string | null,
): Promise<{
  handled: boolean;
  neverMatch: boolean;
  ruleId: string | null;
  ruleType: string | null;
}> {
  const r = await applyFilterRules(email, userId);
  if (r.handled) {
    return { handled: true, neverMatch: false, ruleId: r.ruleId, ruleType: r.ruleType };
  }
  if (r.neverMatch) {
    return { handled: false, neverMatch: true, ruleId: r.ruleId, ruleType: "never_match" };
  }
  return { handled: false, neverMatch: false, ruleId: null, ruleType: null };
}
