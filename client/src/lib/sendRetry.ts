/**
 * Task #1275: classify outbound-SMS send failures as transient (worth a
 * silent auto-retry) vs permanent (fail the bubble immediately).
 *
 * Transient = network blip / Twilio 5xx-style server error. Permanent =
 * anything the user has to fix (invalid number, opt-out, auth, etc.) —
 * those carry a Twilio numeric error code or a 4xx HTTP status.
 *
 * The server tags Twilio errors with `[HTTP <status> / Twilio code <n>]`
 * via `describeTwilioError` (server/services/twilioErrors.ts). Plain
 * network errors from the fetch call have no tag at all.
 */

export const TRANSIENT_HTTP_STATUS: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

export function parseHttpStatusFromMessage(msg: string | undefined | null): number | null {
  if (!msg) return null;
  const m = msg.match(/HTTP\s+(\d{3})/);
  return m ? parseInt(m[1], 10) : null;
}

export function hasTwilioCode(msg: string | undefined | null): boolean {
  return !!msg && /Twilio code \d+/.test(msg);
}

/**
 * Decide whether an error string returned by the send API (either as the
 * top-level `err.error` from a non-2xx response or as a per-recipient
 * `result.error`) should trigger an auto-retry.
 *
 * - No tag at all (e.g. raw network message from fetch on the server) →
 *   transient.
 * - Tagged with a 5xx-style HTTP status → transient.
 * - Tagged with a 4xx status OR carrying a Twilio numeric error code →
 *   permanent (a Twilio code means Twilio understood and rejected the
 *   request; retrying won't help).
 */
export function isTransientErrorMessage(msg: string | undefined | null): boolean {
  if (!msg) return true;
  const status = parseHttpStatusFromMessage(msg);
  if (status !== null) {
    // Task #3896 (audit B-004): a server-tagged `[HTTP 429 …]` means Twilio
    // rate-limited the send AND the server's SDK already ran its bounded
    // exponential-backoff retries (4 HTTP attempts — see
    // TWILIO_HTTP_MAX_429_RETRIES in server/services/twilioService.ts). A
    // client-side re-POST would multiply that (3 × 4 = 12 requests) against
    // an account that is actively throttling us, so 429 is permanent HERE.
    // Raw transport-level 429s (our own server throttling the POST before it
    // ever reached Twilio) remain transient via `isTransientHttpStatus`.
    if (status === 429) return false;
    return TRANSIENT_HTTP_STATUS.has(status);
  }
  if (hasTwilioCode(msg)) return false;
  return true;
}

export function isTransientHttpStatus(status: number): boolean {
  return TRANSIENT_HTTP_STATUS.has(status);
}

/** Backoff schedule between auto-retry attempts (ms). Length = max retries. */
export const SEND_RETRY_BACKOFF_MS: readonly number[] = [400, 1200];

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
