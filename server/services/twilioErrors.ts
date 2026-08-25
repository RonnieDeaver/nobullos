// Task #859 (audit step 7): Twilio's `RestException` carries diagnostic
// fields beyond `.message` — `status` (HTTP), `code` (Twilio error code,
// e.g. 21211 for "Invalid 'To' phone number"), and `moreInfo` (link to
// the docs page for that code). Surface them in a single string so a
// failed Twilio call is debuggable from logs and from the UI without
// leaking the auth token. Safe for any error shape — non-Twilio errors
// fall through to `.message`.
//
// Standalone module (no DB / SDK imports) so it can be unit-tested
// without bootstrapping the rest of the server.
//
// Twilio docs: https://www.twilio.com/docs/api/errors

// Audit Track B (Task #1572): plain-English explanations for the most
// frequently-seen Twilio error codes, so logs and UI surfaces don't just
// echo the raw Twilio message. Sourced from Twilio's public error-code
// reference (https://www.twilio.com/docs/api/errors). Extend as new
// codes show up in production.
const TWILIO_CODE_EXPLANATIONS: Record<number, string> = {
  // Auth / account
  20003: "Authentication failed — check Account SID and Auth Token",
  20404: "Resource not found",
  20429: "Too many requests (Twilio rate limit)",
  // SMS delivery — carrier rejections
  30003: "Unreachable destination handset — phone off, out of coverage, or incompatible",
  30004: "Message blocked by the recipient (STOP/blocklist)",
  30005: "Unknown destination handset",
  30006: "Landline or unreachable carrier — SMS not supported by destination",
  30007: "Carrier violation — message filtered as spam by the carrier",
  30008: "Unknown delivery error",
  // SMS validation
  21211: "Invalid 'To' phone number",
  21212: "Invalid 'From' phone number",
  21214: "'To' phone number cannot be reached",
  21408: "Permission to send to this region is not enabled",
  21610: "Recipient has opted out (STOP) — cannot send until they reply START",
  21611: "Source number has reached its daily message limit",
  21614: "'To' number is not a valid mobile number",
  // Voice
  13224: "Dial 'To' attribute is invalid — number cannot be called",
  31002: "Connection declined by the called party",
};

export function describeTwilioError(err: unknown): string {
  if (!err || typeof err !== "object") {
    return typeof err === "string" ? err : "Unknown error";
  }
  const e = err as { message?: string; status?: number; code?: number; moreInfo?: string };
  const base = e.message || "Twilio request failed";
  const parts: string[] = [];
  if (typeof e.status === "number") parts.push(`HTTP ${e.status}`);
  if (typeof e.code === "number") parts.push(`Twilio code ${e.code}`);
  const tag = parts.length > 0 ? `[${parts.join(" / ")}] ` : "";
  const moreInfo = e.moreInfo ? ` (${e.moreInfo})` : "";
  return `${tag}${base}${moreInfo}`;
}

// Audit Track B (Task #1572): callers (UI toasts, log enrichers) can use
// this to surface a human-readable explanation alongside the raw Twilio
// string without changing `describeTwilioError`'s wire format (which the
// client-side parser in `client/src/lib/twilioError.ts` relies on).
export function explainTwilioErrorCode(code: number | null | undefined): string | null {
  if (typeof code !== "number") return null;
  return TWILIO_CODE_EXPLANATIONS[code] ?? null;
}
