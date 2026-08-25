// @db-pool-intent: ambient
//
// Task #2367 — RIS escalation flagging. Reuses the existing per-user
// notification inbox (which also mirrors to Slack DM when the recipient
// opts in) rather than building any new transport.
//
// Flag rule: a High/Critical-severity Fail, OR any Blocked result (Blocked
// always escalates regardless of severity), fires a flag to the owning
// function + the Reporting function. The flag is deduped per
// client+check+period(+location) via the inbox `dedupeKey`, so re-saving
// the same failing result does not spam. Clearing the failing state
// (status moves to a non-flag-worthy value) resolves it with a follow-up
// notice under a paired dedupe key.

import { notifyUser, resolveDedupeNotification } from "../notifications/userInbox";
import { byFunction } from "../notifications/recipients";
import { rankSeverity } from "./risService";
import type { RisCheck, RisCheckResult } from "@shared/schema";

const REPORTING_FUNCTION = "reporting_expert";

export function isFlagWorthy(
  status: string | null | undefined,
  severity: string | null | undefined,
): boolean {
  // Blocked always escalates (an operator is actively stuck), regardless of
  // severity. A QA Fail or a Performance Red only escalates at High/Critical
  // severity (Task #2371 — Red is the Performance layer's failing state).
  if (status === "blocked") return true;
  if (status !== "fail" && status !== "red") return false;
  return rankSeverity(severity) >= rankSeverity("high");
}

function flagDedupeKey(result: RisCheckResult, checkKey: string): string {
  const loc = result.locationId ? `:${result.locationId}` : "";
  return `ris:flag:${result.clientId}:${checkKey}:${result.period}${loc}`;
}

/**
 * Build the `/ris` deep-link the flag notification carries. It always pins the
 * flagged client and month so the recipient lands on the right checklist at the
 * right period instead of the dashboard's default (current month / QA layer).
 * It additionally pins `layer` for non-QA checks (Performance / Engagement) so
 * a Red flag opens its own layer rather than silently falling back to the QA
 * checklist where that card never appears. QA is the dashboard default, so it is
 * left implicit. The layer is sourced from the CHECK (its catalog row owns the
 * layer), not the result status — a `red` status exists in both Performance and
 * Engagement, so status alone can't disambiguate.
 */
export function buildRisFlagDeepLink(
  check: Pick<RisCheck, "layer">,
  result: Pick<RisCheckResult, "clientId" | "period">,
): string {
  const base = `/ris?clientId=${result.clientId}&period=${result.period}`;
  return check.layer && check.layer !== "qa"
    ? `${base}&layer=${check.layer}`
    : base;
}

async function resolveRecipients(check: RisCheck): Promise<string[]> {
  const [owners, reporting] = await Promise.all([
    byFunction(check.defaultOwnerFunction),
    byFunction(REPORTING_FUNCTION),
  ]);
  return Array.from(new Set([...owners, ...reporting]));
}

export interface FlagContext {
  check: RisCheck;
  result: RisCheckResult;
  firmName: string;
  locationName?: string | null;
  previousStatus: string | null;
}

/**
 * Fire or resolve the escalation flag for a just-saved result. Best
 * effort — failures are logged, never thrown, so the result save itself
 * is never rolled back by a notification hiccup.
 */
export async function processRisResultFlag(ctx: FlagContext): Promise<void> {
  const { check, result, firmName, previousStatus } = ctx;
  const severity = (result.severityOverride as string | null) ?? check.defaultSeverity;
  const nowFlag = isFlagWorthy(result.status, severity);
  const wasFlag = isFlagWorthy(previousStatus, severity);

  if (!nowFlag && !wasFlag) return;

  try {
    const recipients = await resolveRecipients(check);
    if (recipients.length === 0) return;

    const scope = ctx.locationName ? `${firmName} — ${ctx.locationName}` : firmName;
    const dedupeKey = flagDedupeKey(result, check.key);
    const deepLink = buildRisFlagDeepLink(check, result);
    const sevLabel = severity.toUpperCase();

    if (nowFlag) {
      const verb =
        result.status === "blocked"
          ? "BLOCKED"
          : result.status === "red"
            ? "RED"
            : "FAILED";
      const title = `RIS ${sevLabel}: ${check.label} ${verb}`;
      const bodyParts = [`${scope} — ${check.label} is ${result.status}.`];
      if (result.failureReason) bodyParts.push(`Reason: ${result.failureReason}`);
      if (result.correctiveAction)
        bodyParts.push(`Action: ${result.correctiveAction}`);
      const body = bodyParts.join(" ");
      for (const userId of recipients) {
        await notifyUser(userId, {
          category: "system",
          title,
          body,
          deepLink,
          dedupeKey,
          metadata: {
            kind: "ris_flag",
            clientId: result.clientId,
            checkKey: check.key,
            period: result.period,
            locationId: result.locationId ?? null,
            severity,
            status: result.status,
          },
        });
      }
    } else {
      // Transitioned out of a flag-worthy state. Actively resolve the
      // outstanding fail/blocked alert (archive the dedupe-backed row)
      // so the bell clears AND a future re-fail under the same key
      // re-notifies instead of silently deduping against the stale row.
      // A short follow-up "resolved" notice is then sent under a paired
      // key for the audit trail.
      for (const userId of recipients) {
        await resolveDedupeNotification(userId, dedupeKey);
      }
      const title = `RIS resolved: ${check.label}`;
      const body = `${scope} — ${check.label} is now ${result.status}.`;
      for (const userId of recipients) {
        await notifyUser(userId, {
          category: "system",
          title,
          body,
          deepLink,
          dedupeKey: `${dedupeKey}:resolved`,
          metadata: {
            kind: "ris_flag_resolved",
            clientId: result.clientId,
            checkKey: check.key,
            period: result.period,
            locationId: result.locationId ?? null,
            status: result.status,
          },
        });
      }
    }
  } catch (err: any) {
    console.warn(
      `[ris/flagging] processRisResultFlag failed for check=${check.key} client=${result.clientId}: ${err?.message ?? err}`,
    );
  }
}
