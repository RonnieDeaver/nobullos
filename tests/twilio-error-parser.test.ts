/* test-registration
{
  "name": "Twilio error toast parser + describeTwilioError round-trip (Task #1283)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1283 — Coverage for `parseTwilioError` and a round-trip against
 * the server-side `describeTwilioError` formatter.
 *
 * Task #862 introduced the client-side parser
 * (`client/src/lib/twilioError.ts`) that splits the server's formatted
 * Twilio error string ("[HTTP X / Twilio code Y] message (url)") into
 * structured fields used by `TwilioErrorToast`. The parser is small
 * string-handling logic that's easy to break with a future format tweak
 * on the server side (`server/services/twilioErrors.ts`); this suite
 * pins the parser's behaviour AND wires the two formats together so a
 * server-side format change fails the suite.
 */
import { parseTwilioError } from "../client/src/lib/twilioError";
import { describeTwilioError } from "../server/services/twilioErrors";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function expectEq<T>(actual: T, expected: T, msg: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(
      `  ✗ ${msg}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`,
    );
  }
}

console.log("twilio-error-parser: null / undefined / empty inputs");
expectEq(parseTwilioError(null), { message: "Unknown error" }, "null → { message: 'Unknown error' }");
expectEq(parseTwilioError(undefined), { message: "Unknown error" }, "undefined → { message: 'Unknown error' }");
expectEq(parseTwilioError(""), { message: "Unknown error" }, "empty string → { message: 'Unknown error' }");

console.log("twilio-error-parser: full Twilio string (status + code + moreInfo)");
{
  const raw =
    "[HTTP 400 / Twilio code 21211] The 'To' number +1555 is not a valid phone number. (https://www.twilio.com/docs/errors/21211)";
  const parsed = parseTwilioError(raw);
  expectEq(parsed.status, 400, "status parsed");
  expectEq(parsed.code, 21211, "code parsed");
  expectEq(
    parsed.moreInfo,
    "https://www.twilio.com/docs/errors/21211",
    "moreInfo parsed",
  );
  expectEq(
    parsed.message,
    "The 'To' number +1555 is not a valid phone number.",
    "message stripped of prefix and suffix",
  );
}

console.log("twilio-error-parser: message-only (non-Twilio string)");
{
  const parsed = parseTwilioError("Something went wrong");
  expectEq(parsed.message, "Something went wrong", "raw message preserved");
  expectEq(parsed.status, undefined, "no status");
  expectEq(parsed.code, undefined, "no code");
  expectEq(parsed.moreInfo, undefined, "no moreInfo");
}

console.log("twilio-error-parser: status-only prefix");
{
  const parsed = parseTwilioError("[HTTP 503] upstream timeout");
  expectEq(parsed.status, 503, "status parsed");
  expectEq(parsed.code, undefined, "no code");
  expectEq(parsed.message, "upstream timeout", "message preserved");
  expectEq(parsed.moreInfo, undefined, "no moreInfo");
}

console.log("twilio-error-parser: code-only prefix");
{
  const parsed = parseTwilioError("[Twilio code 30007] Carrier filtering");
  expectEq(parsed.code, 30007, "code parsed");
  expectEq(parsed.status, undefined, "no status");
  expectEq(parsed.message, "Carrier filtering", "message preserved");
  expectEq(parsed.moreInfo, undefined, "no moreInfo");
}

console.log("twilio-error-parser: prefix with no moreInfo suffix");
{
  const parsed = parseTwilioError("[HTTP 401 / Twilio code 20003] Authenticate");
  expectEq(parsed.status, 401, "status parsed");
  expectEq(parsed.code, 20003, "code parsed");
  expectEq(parsed.message, "Authenticate", "message preserved");
  expectEq(parsed.moreInfo, undefined, "no moreInfo");
}

console.log("twilio-error-parser: moreInfo suffix without prefix");
{
  const parsed = parseTwilioError(
    "Something explained (https://example.com/docs/err)",
  );
  expectEq(parsed.status, undefined, "no status");
  expectEq(parsed.code, undefined, "no code");
  expectEq(
    parsed.moreInfo,
    "https://example.com/docs/err",
    "moreInfo parsed even with no prefix",
  );
  expectEq(parsed.message, "Something explained", "message preserved");
}

console.log("twilio-error-parser: parenthetical that is NOT a URL is left in the message");
{
  const parsed = parseTwilioError("Failure happened (please retry)");
  expectEq(
    parsed.message,
    "Failure happened (please retry)",
    "non-URL parenthetical is not stripped",
  );
  expectEq(parsed.moreInfo, undefined, "moreInfo undefined");
}

console.log("twilio-error-parser: round-trip with describeTwilioError");
{
  // Full Twilio-style RestException shape — status + code + moreInfo.
  const err = {
    message: "The 'To' number is not a valid phone number.",
    status: 400,
    code: 21211,
    moreInfo: "https://www.twilio.com/docs/errors/21211",
  };
  const formatted = describeTwilioError(err);
  const parsed = parseTwilioError(formatted);
  expectEq(parsed.status, err.status, "round-trip status matches");
  expectEq(parsed.code, err.code, "round-trip code matches");
  expectEq(parsed.moreInfo, err.moreInfo, "round-trip moreInfo matches");
  expectEq(parsed.message, err.message, "round-trip message matches");
}
{
  // Status-only error (no Twilio code, no moreInfo).
  const err = { message: "Bad gateway", status: 502 };
  const formatted = describeTwilioError(err);
  const parsed = parseTwilioError(formatted);
  expectEq(parsed.status, 502, "round-trip status-only: status matches");
  expectEq(parsed.code, undefined, "round-trip status-only: no code");
  expectEq(parsed.moreInfo, undefined, "round-trip status-only: no moreInfo");
  expectEq(parsed.message, "Bad gateway", "round-trip status-only: message matches");
}
{
  // Code-only error (no HTTP status, no moreInfo).
  const err = { message: "Carrier filtering", code: 30007 };
  const formatted = describeTwilioError(err);
  const parsed = parseTwilioError(formatted);
  expectEq(parsed.code, 30007, "round-trip code-only: code matches");
  expectEq(parsed.status, undefined, "round-trip code-only: no status");
  expectEq(parsed.message, "Carrier filtering", "round-trip code-only: message matches");
}
{
  // Plain message — no Twilio metadata at all.
  const err = new Error("Network unreachable");
  const formatted = describeTwilioError(err);
  const parsed = parseTwilioError(formatted);
  expectEq(parsed.status, undefined, "round-trip plain Error: no status");
  expectEq(parsed.code, undefined, "round-trip plain Error: no code");
  expectEq(parsed.moreInfo, undefined, "round-trip plain Error: no moreInfo");
  expectEq(parsed.message, "Network unreachable", "round-trip plain Error: message matches");
}
{
  // Plain string flows through describeTwilioError unchanged.
  const formatted = describeTwilioError("Something opaque");
  const parsed = parseTwilioError(formatted);
  expectEq(parsed.message, "Something opaque", "round-trip plain string: message matches");
  expectEq(parsed.status, undefined, "round-trip plain string: no status");
  expectEq(parsed.code, undefined, "round-trip plain string: no code");
  expectEq(parsed.moreInfo, undefined, "round-trip plain string: no moreInfo");
}
{
  // describeTwilioError on null/undefined falls back to "Unknown error",
  // which the parser must in turn surface as a plain message.
  const parsed = parseTwilioError(describeTwilioError(null));
  expectEq(parsed.message, "Unknown error", "round-trip null: message is 'Unknown error'");
}

if (failed > 0) {
  console.error(`twilio-error-parser: FAILED (${failed} of ${passed + failed})`);
  process.exit(1);
}
console.log(`twilio-error-parser: PASSED (${passed} assertions)`);
