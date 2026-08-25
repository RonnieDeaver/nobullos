/* test-registration
{
  "name": "Global query-error toast copy — failure-class → humane copy mapping (Task #4346)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Every surface's global error toast flows through this pure mapping (client/src/lib/queryErrorCopy.ts); a regression re-exposes raw engineering text (\"bundled 429\", raw 500 JSON bodies) to operators — the exact P1-8 audit finding this replaced. Pure function suite: fast, deterministic, DB-free.",
  "tier": "small"
}
test-registration */
/**
 * Task #4346 — failure-class → humane toast copy mapping.
 *
 * The global QueryCache/MutationCache handlers (client/src/lib/queryClient.ts)
 * and formatQueryError() delegate to humanizeQueryError(). This suite pins:
 *   1. classification of every real error-message shape observed in the
 *      client (leading "NNN:", "bundled NNN", "HTTP NNN", trailing "(NNN)"),
 *   2. operator-grade copy per class — plain-language title, recovery
 *      guidance, NO raw status codes / JSON in the headline copy,
 *   3. demotion of raw text to technicalDetail (kept for bug reports),
 *   4. offline vs generic network distinction via injected onLine.
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import {
  classifyQueryFailure,
  extractHttpStatus,
  humanizeQueryError,
  type QueryFailureClass,
} from "../client/src/lib/queryErrorCopy";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

// ---------------------------------------------------------------------------
// 1. Status extraction across the real message shapes in this codebase.
// ---------------------------------------------------------------------------
check("extracts leading 'NNN:' status (default queryFn / apiRequest shape)", () => {
  assert.equal(extractHttpStatus("429: Too Many Requests"), 429);
  assert.equal(extractHttpStatus('500: {"error":"boom"}'), 500);
});

check("extracts 'bundled NNN' status (notifications poll shape)", () => {
  assert.equal(extractHttpStatus("bundled 429"), 429);
  assert.equal(extractHttpStatus("bundled 503"), 503);
});

check("extracts 'HTTP NNN' and trailing '(NNN)' / '(HTTP NNN)' shapes", () => {
  assert.equal(extractHttpStatus("HTTP 500"), 500);
  assert.equal(extractHttpStatus("Failed to load meetings (500)"), 500);
  assert.equal(extractHttpStatus("Failed to clear (429)"), 429);
  assert.equal(extractHttpStatus("Failed to reclaim job (HTTP 500)"), 500);
});

check("does NOT misread ordinary copy containing digits", () => {
  assert.equal(extractHttpStatus("Imported 429 rows"), null);
  assert.equal(extractHttpStatus("Failed to create client"), null);
  assert.equal(extractHttpStatus("(429) leading paren is not our shape x"), null);
});

// ---------------------------------------------------------------------------
// 2. Classification per failure class.
// ---------------------------------------------------------------------------
const CLASS_CASES: Array<[string, QueryFailureClass]> = [
  ["429: Too Many Requests", "rate_limited"],
  ["bundled 429", "rate_limited"],
  ["Failed to clear (429)", "rate_limited"],
  ["401: Unauthorized", "auth_expired"],
  ["403: Forbidden", "forbidden"],
  ["404: Not Found", "not_found"],
  ["409: version conflict", "conflict"],
  ["400: bad request", "validation"],
  ["422: unprocessable", "validation"],
  ['500: {"error":"boom"}', "server_error"],
  ["502: Bad Gateway", "server_error"],
  ["503: Service Unavailable", "server_error"],
  ["504: Gateway Timeout", "server_error"],
  ["HTTP 500", "server_error"],
  ["bundled 500", "server_error"],
  ["Failed to load meetings (500)", "server_error"],
  ["Failed to create client", "unknown"],
  ["418: teapot", "unknown"],
];
for (const [message, expected] of CLASS_CASES) {
  check(`classifies ${JSON.stringify(message)} as ${expected}`, () => {
    assert.equal(classifyQueryFailure(new Error(message)), expected);
  });
}

check("network errors classify offline vs network by onLine", () => {
  for (const msg of [
    "Failed to fetch",
    "NetworkError when attempting to fetch resource.",
    "Load failed",
  ]) {
    assert.equal(classifyQueryFailure(new Error(msg), { onLine: false }), "offline");
    assert.equal(classifyQueryFailure(new Error(msg), { onLine: true }), "network");
    // No navigator in this process: "can't tell" is treated as online.
    assert.equal(classifyQueryFailure(new Error(msg)), "network");
  }
});

check("non-Error inputs classify as unknown", () => {
  assert.equal(classifyQueryFailure(undefined), "unknown");
  assert.equal(classifyQueryFailure("boom"), "unknown");
  assert.equal(classifyQueryFailure({ message: "429: nope" }), "unknown");
});

// ---------------------------------------------------------------------------
// 3. Humane copy: the audit's exact scenario — "bundled 429" must become
//    human rate-limit copy, never surface raw in the headline.
// ---------------------------------------------------------------------------
check("'bundled 429' produces 'Too many requests — wait a moment and retry' copy", () => {
  const humane = humanizeQueryError(new Error("bundled 429"), { kind: "query" });
  assert.equal(humane.failureClass, "rate_limited");
  assert.equal(humane.title, "Too many requests");
  assert.equal(humane.description, "Wait a moment and retry.");
  // Raw text survives — but only in the secondary technical line.
  assert.equal(humane.technicalDetail, "bundled 429");
});

check("raw 500 JSON body never headlines; guidance present; detail demoted", () => {
  const humane = humanizeQueryError(new Error('500: {"error":"pool exhausted"}'), {
    kind: "mutation",
  });
  assert.equal(humane.failureClass, "server_error");
  assert.equal(humane.title, "Server problem");
  assert.ok(!humane.title.includes("500"));
  assert.ok(!humane.description.includes("{"));
  assert.ok(!humane.description.includes("500"));
  assert.match(humane.description, /retry/i);
  assert.ok(humane.technicalDetail?.includes("pool exhausted"));
});

// Recovery guidance per class: every class's description tells the operator
// what to DO next, and headline copy never leaks raw status digits.
const GUIDANCE: Array<[string, QueryFailureClass, RegExp]> = [
  ["429: Too Many Requests", "rate_limited", /wait a moment and retry/i],
  ["401: Unauthorized", "auth_expired", /sign in again/i],
  ["403: Forbidden", "forbidden", /ask an admin/i],
  ["404: Not Found", "not_found", /refresh and try again/i],
  ["409: conflict", "conflict", /refresh to load the latest/i],
  ["400: bad", "validation", /fix the highlighted fields/i],
  ["503: down", "server_error", /wait a moment and retry/i],
];
for (const [message, expectedClass, guidance] of GUIDANCE) {
  check(`${expectedClass} copy carries recovery guidance and no raw digits`, () => {
    const humane = humanizeQueryError(new Error(message));
    assert.equal(humane.failureClass, expectedClass);
    assert.match(humane.description, guidance);
    assert.ok(
      !/\d{3}/.test(humane.title) && !/\d{3}/.test(humane.description),
      `headline copy leaked a status code: ${humane.title} / ${humane.description}`,
    );
    assert.ok(humane.title.length > 0 && humane.description.length > 0);
  });
}

check("offline copy tells the operator to reconnect; network copy to check connection", () => {
  const offline = humanizeQueryError(new Error("Failed to fetch"), { onLine: false });
  assert.equal(offline.title, "You're offline");
  assert.match(offline.description, /reconnect/i);
  const network = humanizeQueryError(new Error("Failed to fetch"), { onLine: true });
  assert.equal(network.title, "Connection problem");
  assert.match(network.description, /check your connection and retry/i);
});

// ---------------------------------------------------------------------------
// 4. Unknown-class handling: human messages stay visible, engineering blobs
//    are demoted, non-Errors get generic copy. Query vs mutation titles.
// ---------------------------------------------------------------------------
check("already-human component messages stay in the description with a retry hint", () => {
  const humane = humanizeQueryError(new Error("Failed to create client"), {
    kind: "mutation",
  });
  assert.equal(humane.failureClass, "unknown");
  assert.equal(humane.title, "That didn't go through");
  assert.ok(humane.description.startsWith("Failed to create client."));
  assert.match(humane.description, /try again/i);
  assert.equal(humane.technicalDetail, undefined);
});

check("engineering-looking unknown messages are demoted to technicalDetail", () => {
  const humane = humanizeQueryError(new Error('Unexpected token { in JSON at position 0'));
  assert.equal(humane.failureClass, "unknown");
  assert.ok(!humane.description.includes("{"));
  assert.ok(humane.technicalDetail?.includes("Unexpected token"));
});

check("unmapped 4xx (teapot 418) gets generic copy with detail demoted", () => {
  const humane = humanizeQueryError(new Error("418: teapot"));
  assert.equal(humane.failureClass, "unknown");
  assert.ok(!/\d{3}/.test(humane.description), "generic copy must not leak the status");
  assert.ok(humane.technicalDetail?.includes("418"));
});

check("query vs mutation unknown titles differ (load vs write framing)", () => {
  assert.equal(humanizeQueryError(new Error("x y z"), { kind: "query" }).title, "Couldn't load this data");
  assert.equal(
    humanizeQueryError(new Error("x y z"), { kind: "mutation" }).title,
    "That didn't go through",
  );
});

check("non-Error rejection gets generic copy; string rejections keep the string as detail", () => {
  const fromUndefined = humanizeQueryError(undefined);
  assert.equal(fromUndefined.failureClass, "unknown");
  assert.match(fromUndefined.description, /unexpected error/i);
  assert.equal(fromUndefined.technicalDetail, undefined);
  const fromString = humanizeQueryError("socket hang up");
  assert.equal(fromString.technicalDetail, "socket hang up");
});

check("long raw bodies are truncated in technicalDetail", () => {
  const longBody = "500: " + JSON.stringify({ error: "x".repeat(500) });
  const humane = humanizeQueryError(new Error(longBody));
  assert.ok(humane.technicalDetail !== undefined);
  assert.ok(humane.technicalDetail.length <= 161, "detail must be truncated (160 + ellipsis)");
  assert.ok(humane.technicalDetail.endsWith("…"));
});

check("whitespace in raw detail is collapsed to one line", () => {
  const humane = humanizeQueryError(new Error("500: line one\n   line two\t\tend"));
  assert.equal(humane.technicalDetail, "500: line one line two end");
});

console.log(`\nTest run complete: ${passed} passed, 0 failed.`);
