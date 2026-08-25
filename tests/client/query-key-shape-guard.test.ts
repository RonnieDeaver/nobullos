/* test-registration
{
  "name": "Query-key shape guard (F-QK, Task #3964) — dev-only validation of default-queryFn keys, zero effect on valid keys",
  "regression": true,
  "smoke": true,
  "smokeReason": "F-QK closure: the shared queryClient's default queryFn builds its URL as queryKey.join('/'), so an unresolved undefined/null/object entry silently fetches a garbage URL (mystery 404s, accidental cache aliasing). This suite pins (a) the validator's accept/reject matrix over the repo's real key shapes — path-only, path+scalar segments, query-string keys, tolerated trailing slash — and (b) that the dev-mode guard throws BEFORE any network call for malformed keys while staying invisible to valid ones, and is never classified as a transient error (no retry storm). A regression either mutes the guard (the bug class returns) or false-positives on legitimate keys (breaks every dev page). DB-free, DOM-free, scripted fetch stub; fast and deterministic.",
  "extraNodeArgs": [
    "--import",
    "./tests/query-transient-retry-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3964 (F-QK) — the shared query client's default queryFn joins the
 * query key into the request URL with no shape validation. The dev-only
 * guard (`validateApiQueryKeyShape` + the `QUERY_KEY_SHAPE_GUARD_ENABLED`
 * gate inside `getQueryFn`) turns a malformed key into an immediate,
 * descriptive throw instead of a silent garbage fetch.
 *
 * Contract pinned here:
 *   A. Validator accepts every legitimate repo key shape: ["/api/x"],
 *      ["/api/x", "id"], ["/api/x", 42], single-entry query-string keys
 *      ("/api/ris/portfolio?period=…", "…/messages?parentId=…"), a
 *      tolerated trailing slash, and query-string content is NOT policed.
 *   B. Validator rejects: empty key, relative first entry, non-string first
 *      entry, undefined/null/object/array/NaN/empty-string entries, interior
 *      "//" segments, and literal "undefined"/"null"/"NaN"/"[object Object]"
 *      path segments.
 *   C. In this (non-production) environment the guard is enabled: a
 *      malformed key REJECTS before fetch is called (fetch-call count is
 *      unchanged) with a "Malformed query key" error that is NOT transient
 *      (no retry storm), and a valid key fetches exactly its joined URL.
 *      Production builds compile the gate out via import.meta.env.DEV — that
 *      is a build-time property, asserted here only via the runtime flag.
 *
 * The toast surface is captured via the shared use-toast stub loader
 * (tests/query-transient-retry-setup.mjs); no DOM is needed.
 */

import assert from "node:assert/strict";

(globalThis as any).__capturedToasts = [];

import {
  validateApiQueryKeyShape,
  QUERY_KEY_SHAPE_GUARD_ENABLED,
  isTransientQueryError,
  queryClient,
} from "../../client/src/lib/queryClient";

let failures = 0;
async function step(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

// ---- Minimal Response stand-in (json/text/clone are all getQueryFn uses) ----
function makeRes(status: number, body: unknown): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => makeRes(status, body),
  };
}

async function main(): Promise<void> {
  console.log("Query-key shape guard (F-QK, Task #3964)");

  // ── A. Validator accepts every legitimate repo key shape ──────────────────
  await step("valid key shapes pass (null problem)", () => {
    const good: Array<readonly unknown[]> = [
      ["/api/clients"],
      ["/api/clients", "abc-123"],
      ["/api/clients", 42],
      ["/api/auth/user"],
      // Query-string keys (real repo shapes — RIS portfolio, comms threads):
      ["/api/ris/portfolio?period=2025-Q1"],
      ["/api/comms/channels/ch1/messages?parentId=m1"],
      // Trailing slash is tolerated (express matches it; not worth breaking):
      ["/api/clients/"],
      // Query-string content is deliberately NOT policed:
      ["/api/search?q=null&flag=undefined"],
      ["/api/things", "42?compact=1"],
    ];
    for (const key of good) {
      assert.equal(
        validateApiQueryKeyShape(key),
        null,
        `expected valid: ${JSON.stringify(key)} → ${validateApiQueryKeyShape(key)}`,
      );
    }
  });

  // ── B. Validator rejects malformed keys with a problem description ────────
  await step("malformed key shapes are rejected", () => {
    const bad: Array<[readonly unknown[], RegExp]> = [
      [[], /empty/],
      [["api/clients"], /absolute path/],
      [[42, "x"], /absolute path/],
      [["/api/clients", undefined], /of type undefined/],
      [["/api/clients", null], /null/],
      [["/api/clients", { id: 1 }], /of type object/],
      [["/api/clients", ["nested"]], /an array/],
      [["/api/clients", NaN], /non-finite/],
      [["/api/clients", Infinity], /non-finite/],
      [["/api/clients", ""], /empty string/],
      [["/api//clients"], /empty path segment/],
      [["/api/clients", "undefined"], /"undefined" path segment/],
      [["/api/clients", "null"], /"null" path segment/],
      [["/api/clients/NaN"], /"NaN" path segment/],
      [["/api/clients", "[object Object]"], /\[object Object\]/],
    ];
    for (const [key, expect] of bad) {
      const problem = validateApiQueryKeyShape(key);
      assert.ok(problem, `expected rejection: ${JSON.stringify(key)}`);
      assert.match(problem!, expect, `problem for ${JSON.stringify(key)}: ${problem}`);
    }
  });

  // ── C. Guard behavior inside the real default queryFn ─────────────────────
  await step("guard is enabled outside production builds", () => {
    assert.equal(
      QUERY_KEY_SHAPE_GUARD_ENABLED,
      true,
      "NODE_ENV here is not 'production', so the runtime gate is on (Vite prod builds replace import.meta.env.DEV with false and compile the branch out)",
    );
  });

  const fetchCalls: string[] = [];
  (global as any).fetch = async (url: string) => {
    fetchCalls.push(String(url));
    return makeRes(200, { ok: true });
  };

  await step("valid key fetches exactly its joined URL", async () => {
    const data = await queryClient.fetchQuery({ queryKey: ["/api/guard-ok", 7] });
    assert.deepEqual(data, { ok: true });
    assert.deepEqual(fetchCalls, ["/api/guard-ok/7"], "one fetch, joined URL");
  });

  await step("malformed key throws BEFORE any network call", async () => {
    (globalThis as any).__capturedToasts = [];
    const before = fetchCalls.length;
    let caught: unknown = null;
    try {
      await queryClient.fetchQuery({ queryKey: ["/api/guard-bad", undefined] });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, "fetchQuery rejected");
    assert.match((caught as Error).message, /Malformed query key/);
    assert.match((caught as Error).message, /fix the useQuery call site/);
    assert.equal(fetchCalls.length, before, "fetch was never called for the malformed key");
    assert.equal(
      isTransientQueryError(caught),
      false,
      "guard errors are terminal — the global retry policy must not re-run them",
    );
  });

  await step("malformed-key rejection is a single attempt (no retry storm)", async () => {
    const before = fetchCalls.length;
    let rejections = 0;
    try {
      await queryClient.fetchQuery({ queryKey: ["/api/guard-bad-2", null] });
    } catch {
      rejections += 1;
    }
    assert.equal(rejections, 1);
    assert.equal(fetchCalls.length, before, "still zero fetches");
  });

  if (failures > 0) {
    console.error(`\n${failures} step(s) failed`);
    process.exit(1);
  }
  console.log("\nAll query-key shape guard steps passed");
  // The shared queryClient schedules gc/retry timers; exit explicitly once
  // assertions are done (mirrors tests/client/query-transient-retry.test.ts).
  process.exit(0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
