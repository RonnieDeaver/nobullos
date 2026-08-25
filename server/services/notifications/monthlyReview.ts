// Task #1713 — Stage B/C migration helpers for the two monthly-review
// inline legacy-notification create call sites:
//
//   - server/routes/reports.ts (PATCH /api/reports/:id) — fires when a
//     report finalize is blocked because the command panel has not been
//     reviewed this month. Notifies the client owner.
//   - server/routes/settings.ts (POST /api/monthly-review-notifications)
//     — admin tool that fans out a "monthly review due" reminder to the
//     client owners whose command panels are still unreviewed.
//
// Both helpers write to the per-user inbox via `notifyUser()` and use
// deterministic dedupe keys so a re-fire (retry, double-click, second
// request) collapses to a single inbox row per recipient.

import { notifyUser } from "./userInbox";

export interface NotifyReportReviewBlockedParams {
  ownerId: string;
  reportId: string;
  clientId: string;
  firmName: string | null | undefined;
  monthKey: string;
}

/**
 * Notify the client owner that a report finalize was blocked because
 * the command panel still needs its monthly review.
 *
 * Dedupe key: `report:<reportId>:<ownerId>` — repeated finalize attempts
 * against the same report collapse to one bell row per owner.
 */
export async function notifyReportFinalizationBlocked(
  params: NotifyReportReviewBlockedParams,
): Promise<void> {
  await notifyUser(params.ownerId, {
    category: "system",
    title: "Report finalization blocked",
    body: `${params.firmName || "Client"}'s command panel needs its monthly review (${params.monthKey}) before this report can be finalized.`,
    deepLink: `/clients/${params.clientId}`,
    dedupeKey: `report:${params.reportId}:${params.ownerId}`,
    metadata: {
      reportId: params.reportId,
      clientId: params.clientId,
      monthKey: params.monthKey,
    },
  });
}

export interface NotifyMonthlyReviewReminderParams {
  userId: string;
  clientId: string;
  firmName: string | null | undefined;
  monthKey: string;
}

/**
 * Notify a user that one of their clients still needs its monthly
 * command-panel review for `monthKey`.
 *
 * Dedupe key: `monthly_review:<monthKey>:<clientId>:<userId>`. This
 * replaces the legacy per-user notification scan + ad-hoc string-match
 * suppression that lived in server/routes/settings.ts; the
 * partial-unique index on `user_notifications.dedupeKey` now enforces
 * idempotency directly.
 *
 * Returns `true` when a new inbox row was created, `false` when the
 * call was deduplicated (so the caller can keep its `created` counter
 * accurate for the admin tool's response).
 */
export async function notifyMonthlyReviewReminder(
  params: NotifyMonthlyReviewReminderParams,
): Promise<boolean> {
  const result = await notifyUser(params.userId, {
    category: "system",
    title: "Monthly review due",
    body: `${params.firmName || "Client"}'s command panel needs review for ${params.monthKey}.`,
    deepLink: `/clients/${params.clientId}`,
    dedupeKey: `monthly_review:${params.monthKey}:${params.clientId}:${params.userId}`,
    metadata: { clientId: params.clientId, monthKey: params.monthKey },
  });
  return Boolean(result) && !result!.deduped;
}
