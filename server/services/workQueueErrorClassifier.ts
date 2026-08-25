/**
 * Task #1050: small, shared classifier for `work_queue.error_code`.
 *
 * Maps a thrown handler error (or persisted `error_message` text) into a
 * narrow enum so dead-letter rows can be triaged without re-reading
 * every freeform message. The enum is intentionally small — its job is
 * to answer "is this transient or not?" at a glance, not to reproduce
 * the full upstream taxonomy.
 *
 *   db_connection_timeout  — pg pool acquire / connection terminated.
 *                            Transient. Resumable if the handler
 *                            knows how to release + reschedule.
 *   external_fetch_failed  — undici `fetch failed`, ECONNRESET,
 *                            upstream 5xx, request-side timeouts.
 *                            Transient — safe to replay.
 *   external_auth_failed   — 401 / token expired / re-authorize.
 *                            NOT auto-replayable — needs operator.
 *   circuit_breaker_open   — local breaker tripped. The handler's own
 *                            deferred re-enqueue path covers this; if
 *                            it surfaces as a dead letter the breaker
 *                            stayed open across maxAttempts.
 *   unknown                — uncategorized — leave for manual review.
 */
export const workQueueErrorCodes = [
  "db_connection_timeout",
  "external_fetch_failed",
  "external_auth_failed",
  "circuit_breaker_open",
  "unknown",
] as const;

export type WorkQueueErrorCode = typeof workQueueErrorCodes[number];

export const TRANSIENT_ERROR_CODES: ReadonlySet<WorkQueueErrorCode> = new Set([
  "db_connection_timeout",
  "external_fetch_failed",
]);

export function classifyWorkQueueError(err: unknown): WorkQueueErrorCode {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return classifyWorkQueueErrorMessage(msg);
}

export function classifyWorkQueueErrorMessage(rawMsg: string | null | undefined): WorkQueueErrorCode {
  if (!rawMsg) return "unknown";
  const msg = rawMsg;

  // DB pool / pg connection failures. Mirrors the patterns in
  // server/services/frontHistoricalRecovery.ts:isDbPoolSaturationError
  // so the two classifiers agree on what counts as a pool-saturation
  // signal.
  if (
    /timeout exceeded when trying to connect/i.test(msg) ||
    /connection terminated due to connection timeout/i.test(msg) ||
    /terminating connection due to administrator command/i.test(msg) ||
    /connection terminated unexpectedly/i.test(msg) ||
    /^Connection terminated$/i.test(msg) ||
    /pool acquire timeout/i.test(msg) ||
    /Cannot use a pool after calling end/i.test(msg) ||
    /remaining connection slots are reserved/i.test(msg) ||
    /sorry, too many clients already/i.test(msg)
  ) {
    return "db_connection_timeout";
  }

  // Local circuit breaker — tagged before the generic timeout/fetch
  // patterns because the message often contains "open" + a timeout
  // hint.
  if (/circuit.?breaker.*open|breaker is open|breaker_open/i.test(msg)) {
    return "circuit_breaker_open";
  }

  // Auth / token failures from upstream APIs. Checked before the
  // generic fetch-failed bucket so a 401 doesn't get filed as transient.
  if (
    /\b401\b/.test(msg) ||
    /unauthor/i.test(msg) ||
    /token expired/i.test(msg) ||
    /re-?authorize/i.test(msg) ||
    /not connected[^a-z]/i.test(msg) ||
    /token refresh failed/i.test(msg)
  ) {
    return "external_auth_failed";
  }

  // External HTTP / upstream fetch failures. Includes undici's
  // "fetch failed", explicit SEMrush API request-timeout / 5xx, and
  // common low-level socket errors that bubble up unchanged.
  if (
    /\bfetch failed\b/i.test(msg) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up/i.test(msg) ||
    /SEMrush API request timed out/i.test(msg) ||
    /SEMrush API retry timed out/i.test(msg) ||
    /SEMrush API returned 5\d\d/.test(msg) ||
    /AbortError/i.test(msg)
  ) {
    return "external_fetch_failed";
  }

  return "unknown";
}
