// @db-pool-intent: worker
/**
 * Task #4789 — Leaf-module alert for POST /api/feedback 5xx failures.
 *
 * The `requestMetricsAlerts` evaluator covers 5xx regressions generically but
 * requires ≥30 requests in a 10-minute window before it fires — feedback sees
 * ~2 req/day in production, so it is structurally blind to feedback 5xxs.
 * This dedicated hook fires immediately on any server-error catch in the
 * feedback route, with a day+route-scoped dedupeKey so repeated errors on
 * the same UTC day collapse into one alert instead of flooding the bell.
 *
 * Leaf module: no static imports of dispatcher (dynamic only), injectable
 * override for tests. Pattern follows tableSizeWatchdog / requestMetricsAlerts.
 */

export const NOTIFICATION_ID = "infra.feedback.submit_failure";

/** Day-scoped dedupeKey — one alert per UTC calendar day, not forever. */
export function buildDedupeKey(now: number = Date.now()): string {
  const d = new Date(now);
  const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return `feedback:submit:5xx:${ymd}`;
}

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: unknown },
  options: Record<string, unknown>,
) => Promise<{ delivered: boolean; skipped?: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;

export const __testHelpers = {
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
};

/**
 * Fire an ops alert for a feedback submit 5xx. Call from the route catch block.
 * Best-effort: never throws, never awaited on the request path (fire-and-forget).
 */
export async function alertFeedbackSubmitFailure(
  err: unknown,
  context: { userId?: string; page?: string | null },
): Promise<void> {
  const errMsg = err instanceof Error ? err.message : String(err);
  const text = [
    `:rotating_light: *Feedback submit server error* — POST \`/api/feedback\` threw in the route handler.`,
    `• Error: \`${errMsg.slice(0, 300)}\``,
    context.page ? `• Page: \`${context.page}\`` : null,
    context.userId ? `• User: \`${context.userId}\`` : null,
    `• Check server logs for \`[Feedback] Error:\` lines. Row may or may not have been inserted — verify \`user_feedback\` table.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const dispatch =
      dispatcherOverride ?? (await import("./notifications/dispatcher")).notifyByType;
    await dispatch(
      NOTIFICATION_ID,
      { text, preview: { errMsg: errMsg.slice(0, 100) } },
      {
        triggerSource: "alert_service",
        dedupeKey: buildDedupeKey(),
        failureType: "server_error",
        metadata: { route: "POST /api/feedback", errMsg },
      },
    );
  } catch (dispatchErr: any) {
    console.error(
      `[FeedbackSubmitFailureAlert] dispatch failed: ${dispatchErr?.message ?? dispatchErr}`,
    );
  }
}
