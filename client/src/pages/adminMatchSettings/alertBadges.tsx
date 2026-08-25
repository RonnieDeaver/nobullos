// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, History } from "lucide-react";
import { ALERT_AUTO_RETRY_BACKOFF_MS, type AlertDeliveryStatus, DEFAULT_ALERT_AUTO_RETRY_MAX_ATTEMPTS, type HistoryRow } from "./model";

// Task #798 — Inline "Last resend by … at … (source)" badge so admins can see
// at a glance who recently retried a failed alert and from where, on each of
// the three Admin History panels (match settings, common-first-names, manual
// reserve). The badge is rendered next to the Retry button.
function ResendByBadge({
  lastResendAt,
  lastResendBy,
  lastResendByUser,
  lastResendSource,
  testIdSuffix,
}: {
  lastResendAt?: string | null;
  lastResendBy?: string | null;
  lastResendByUser?: { firstName?: string | null; lastName?: string | null; email?: string | null } | null;
  lastResendSource?: string | null;
  testIdSuffix: string;
}) {
  if (!lastResendAt) return null;
  const name = (() => {
    if (lastResendByUser) {
      const full = [lastResendByUser.firstName, lastResendByUser.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (full) return full;
      if (lastResendByUser.email) return lastResendByUser.email;
    }
    return lastResendBy || "unknown";
  })();
  const when = new Date(lastResendAt);
  const validDate = !isNaN(when.getTime());
  const whenLabel = validDate ? when.toLocaleString() : String(lastResendAt);
  const relativeLabel = validDate
    ? formatDistanceToNow(when, { addSuffix: true })
    : whenLabel;
  const source = lastResendSource || "unknown";
  return (
    <div
      className="mt-1 text-[10px] text-slate-600"
      title={`${whenLabel} · source: ${source}`}
      data-testid={`text-last-resend-${testIdSuffix}`}
    >
      retried{" "}
      <span data-testid={`text-last-resend-at-${testIdSuffix}`}>{relativeLabel}</span>{" "}
      by{" "}
      <span className="font-medium text-slate-700" data-testid={`text-last-resend-by-${testIdSuffix}`}>
        {name}
      </span>
      <span className="sr-only" data-testid={`text-last-resend-source-${testIdSuffix}`}>
        {source}
      </span>
    </div>
  );
}

const ALERT_STATUS_STYLE: Record<AlertDeliveryStatus, string> = {
  delivered: "bg-emerald-100 text-emerald-800 border-emerald-200",
  failed: "bg-red-100 text-red-800 border-red-200",
  skipped: "bg-slate-100 text-slate-600 border-slate-200",
};

const ALERT_STATUS_LABEL: Record<AlertDeliveryStatus, string> = {
  delivered: "delivered",
  failed: "failed",
  skipped: "skipped",
};

function AlertStatusBadge({
  channel,
  status,
  rowId,
  failureReason,
  attemptCount,
  maxAttempts,
}: {
  channel: "slack" | "email";
  status: AlertDeliveryStatus | null;
  rowId: string;
  failureReason?: string | null;
  attemptCount?: number | null;
  maxAttempts?: number;
}) {
  const channelLabel = channel === "slack" ? "Slack" : "Email";
  if (!status) {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide bg-gray-50 text-gray-400 border-gray-200"
        title={`No ${channelLabel} alert was attempted for this change.`}
        data-testid={`status-alert-${channel}-${rowId}`}
      >
        {channelLabel}: —
      </span>
    );
  }
  const trimmedReason = failureReason?.trim() || null;
  const cap = maxAttempts ?? DEFAULT_ALERT_AUTO_RETRY_MAX_ATTEMPTS;
  const attempts = Math.max(0, attemptCount ?? 0);
  const exhausted = status === "failed" && attempts >= cap;
  const cls = exhausted
    ? "bg-red-200 text-red-900 border-red-400"
    : ALERT_STATUS_STYLE[status];
  const tooltipMap: Record<AlertDeliveryStatus, string> = {
    delivered: `${channelLabel} alert delivered.`,
    failed: trimmedReason
      ? `${channelLabel} alert failed: ${trimmedReason}`
      : `${channelLabel} alert attempt failed. Check server logs.`,
    skipped: `${channelLabel} alert was skipped (not configured or no recipients).`,
  };
  let tooltip = tooltipMap[status];
  let suffix: string | null = null;
  if (status === "failed") {
    suffix = exhausted
      ? `· retries ${attempts}/${cap} (exhausted)`
      : `· retry ${attempts}/${cap}`;
    tooltip += exhausted
      ? ` Auto-retry budget exhausted (${attempts}/${cap} attempts used) — needs a manual Retry click.`
      : ` Auto-retried ${attempts} of ${cap} times so far.`;
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide ${cls}`}
      title={tooltip}
      data-testid={`status-alert-${channel}-${rowId}`}
      data-failure-reason={status === "failed" && trimmedReason ? trimmedReason : undefined}
      data-attempt-count={status === "failed" ? attempts : undefined}
      data-auto-retry-exhausted={exhausted ? "true" : undefined}
    >
      {channelLabel}: {ALERT_STATUS_LABEL[status]}
      {suffix && (
        <span
          className="ml-1 normal-case font-normal opacity-90"
          data-testid={`status-alert-${channel}-${rowId}-attempts`}
        >
          {suffix}
        </span>
      )}
    </span>
  );
}

// Task #1136 — Surface the per-row auto-retry status (last attempt timestamp,
// whether the row still has retries left, or whether the auto-retry budget is
// exhausted) underneath the Slack/Email status badges, so operators can tell
// "still in the retry window" rows apart from "needs a manual nudge" rows.
function AlertAutoRetryStatusLine({
  row,
  maxAttempts,
  testIdSuffix,
}: {
  row: HistoryRow;
  maxAttempts: number;
  testIdSuffix: string;
}) {
  const slackFailed = row.slackStatus === "failed";
  const emailFailed = row.emailStatus === "failed";
  if (!slackFailed && !emailFailed) return null;

  const slackAttempts = Math.max(0, row.slackAttemptCount ?? 0);
  const emailAttempts = Math.max(0, row.emailAttemptCount ?? 0);
  const slackExhausted = slackFailed && slackAttempts >= maxAttempts;
  const emailExhausted = emailFailed && emailAttempts >= maxAttempts;
  const allExhausted =
    (!slackFailed || slackExhausted) && (!emailFailed || emailExhausted);

  const lastAt = row.lastAutoRetryAt ? new Date(row.lastAutoRetryAt) : null;
  const lastLabel =
    lastAt && !isNaN(lastAt.getTime()) ? lastAt.toLocaleString() : null;

  // Pick the channel furthest behind in the budget to drive the "next retry"
  // hint — that's the one the background loop will run next.
  const pendingAttempts: number[] = [];
  if (slackFailed && !slackExhausted) pendingAttempts.push(slackAttempts);
  if (emailFailed && !emailExhausted) pendingAttempts.push(emailAttempts);
  const nextAttemptIndex = pendingAttempts.length > 0 ? Math.min(...pendingAttempts) : null;
  let nextRetryLabel: string | null = null;
  if (nextAttemptIndex !== null && lastAt && !isNaN(lastAt.getTime())) {
    // The loop waits backoff[nextAttemptIndex] AFTER lastAutoRetryAt before
    // running attempt#(nextAttemptIndex+1). For the very first auto-retry
    // (nextAttemptIndex === 0) lastAutoRetryAt is the original change time
    // so the same math still works.
    const backoffMs =
      ALERT_AUTO_RETRY_BACKOFF_MS[
        Math.min(nextAttemptIndex, ALERT_AUTO_RETRY_BACKOFF_MS.length - 1)
      ];
    const dueAt = new Date(lastAt.getTime() + backoffMs);
    nextRetryLabel = dueAt.toLocaleString();
  }

  if (allExhausted) {
    return (
      <div
        className="mt-1 inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-800"
        title={`Auto-retry budget exhausted on every failed channel (max ${maxAttempts} attempts). A manual Retry click is required.`}
        data-testid={`text-auto-retry-status-${testIdSuffix}`}
        data-auto-retry-state="exhausted"
      >
        <AlertTriangle className="w-3 h-3" />
        <span data-testid={`text-auto-retry-exhausted-${testIdSuffix}`}>
          Auto-retries exhausted
        </span>
        {lastLabel && (
          <span className="font-normal text-red-700">
            · last tried{" "}
            <span data-testid={`text-auto-retry-last-${testIdSuffix}`}>{lastLabel}</span>
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="mt-1 text-[10px] text-slate-600"
      data-testid={`text-auto-retry-status-${testIdSuffix}`}
      data-auto-retry-state="pending"
    >
      {lastLabel ? (
        <>
          Last auto-retry{" "}
          <span
            className="font-medium text-slate-700"
            data-testid={`text-auto-retry-last-${testIdSuffix}`}
          >
            {lastLabel}
          </span>
        </>
      ) : (
        <span data-testid={`text-auto-retry-last-${testIdSuffix}`}>
          Awaiting first auto-retry
        </span>
      )}
      {nextRetryLabel && (
        <>
          {" · next "}
          <span
            className="font-medium text-slate-700"
            data-testid={`text-auto-retry-next-${testIdSuffix}`}
          >
            {nextRetryLabel}
          </span>
        </>
      )}
    </div>
  );
}
export { ResendByBadge, ALERT_STATUS_STYLE, ALERT_STATUS_LABEL, AlertStatusBadge, AlertAutoRetryStatusLine };
