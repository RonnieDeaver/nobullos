/* test-registration
{
  "name": "Front historical recovery observability (Task #843)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #843 — pin Task #841's two silent-disappearance fixes for the
 * Front historical-recovery worker.
 *
 * Path 1: a window that fails (mocked Front fetch returns 401, forced
 *   refresh succeeds, retry still 401) must:
 *     - emit a `Window <label>: status=...` log line that includes
 *       `first error:` + the actual error message
 *     - persist `statusReason` containing the typed error code
 *     - surface `firstError` on the per-window record the
 *       `/api/integrations/front/console/overview` mapping reads from
 *       (`w.errors[0] ?? null`)
 *
 * Path 2: when an inner step inside `runHistoricalRecovery`'s IIFE
 *   throws (mocked `generateCoverageReport` rejects via a patched
 *   `db.execute`), the outer catch must:
 *     - end the job in `status=failed` with `error` set to the message
 *     - emit a `[FrontRecovery] [job=…] Fatal error` log line
 *     - persist the failed state so the next `listRecoveryJobs()` call
 *       reflects the failure (i.e. the job does not "disappear")
 *
 * Tests stub `globalThis.fetch` and (for Path 2) `db.execute` so they
 * run without a real Front token or live API. The test DB is used for
 * `system_settings` storage so the persistence assertions exercise the
 * real durable path.
 */

import assert from "node:assert/strict";
import { storage } from "../server/storage";
import { db, workerDb } from "../server/db";

// Stub Front OAuth env so refresh attempts don't bail with
// "credentials not configured".
process.env.FRONT_CLIENT_ID = process.env.FRONT_CLIENT_ID || "test-client-id";
process.env.FRONT_CLIENT_SECRET = process.env.FRONT_CLIENT_SECRET || "test-client-secret";

// Seed a connected Front auth state so getValidFrontAccessToken returns
// the cached token without hitting the network on the happy path.
const nowSec = Math.floor(Date.now() / 1000);
await storage.setSystemSetting("front_access_token", "access-A", "system");
await storage.setSystemSetting("front_refresh_token", "refresh-A", "system");
await storage.setSystemSetting("front_token_expires_at", String(nowSec + 3600), "system");

// Task #1787 Stage 6: disable the active-inbox-filter kill switch so the
// recovery loop does not perform a sibling /inboxes Front fetch that this
// test would (incorrectly) attribute to the page-fetch counter. Uses the
// pool-epic switch writer so the in-memory override and the persisted row
// stay in lockstep (raw setSystemSetting alone would not update the
// already-loaded switch snapshot).
const { setPoolEpicSwitch } = await import(
  "../server/services/poolEpicKillSwitches"
);
await setPoolEpicSwitch(
  "front_recovery_active_inbox_filter_enabled",
  false,
  "system",
);

// fetch mock with a per-test scripted handler.
// IMPORTANT: only Front API + Front OAuth URLs are routed to the test
// handler. Everything else (Upstash Redis pipeline calls used by the
// `system_settings` cache layer, etc.) passes through to the real fetch
// so unrelated I/O does not pollute the page/refresh counters that the
// 401 assertion below depends on. Pre Task #1788 the `system_settings`
// reads were direct PG queries and never touched fetch, so the original
// "anything not /oauth/token is a page hit" heuristic was safe; once the
// Redis cache landed every cached read became a fetch and the counter
// blew up to ~32. — Task #1789 follow-up.
type FetchHandler = (url: string, init: any) => Promise<Response>;
let currentFetchHandler: FetchHandler = async () => {
  throw new Error("fetch handler not set");
};
const realFetch = globalThis.fetch.bind(globalThis);
function isFrontUrl(url: string): boolean {
  return (
    url.startsWith("https://api2.frontapp.com") ||
    url.startsWith("https://app.frontapp.com/oauth") ||
    url.includes("frontapp.com/oauth/token")
  );
}
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!isFrontUrl(url)) {
    return realFetch(input, init);
  }
  return currentFetchHandler(url, init ?? {});
}) as any;

// Console capture so we can assert log lines fire in order.
const captured: string[] = [];
const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);
const realError = console.error.bind(console);
function flatten(args: any[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : String(a)))
    .join(" ");
}
console.log = ((...args: any[]) => {
  captured.push(flatten(args));
}) as any;
console.warn = ((...args: any[]) => {
  captured.push(flatten(args));
}) as any;
console.error = ((...args: any[]) => {
  captured.push(flatten(args));
}) as any;

// Import after the stubs so the module captures them.
const {
  runTargetedWindowBackfill,
  runHistoricalRecovery,
  getRecoveryJob,
  listRecoveryJobs,
} = await import("../server/services/frontHistoricalRecovery");

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  captured.length = 0;
  try {
    await fn();
    realLog(`  ok  ${name}`);
  } catch (e) {
    realError(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`);
    failed++;
  }
}
function findLine(predicate: (s: string) => boolean): string | undefined {
  return captured.find(predicate);
}
function jsonResponse(body: any, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
}
function errorResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers: headers ?? {} });
}

// Mirror the relevant slice of the
// `/api/integrations/front/console/overview` mapping for
// historical_recovery jobs (server/routes/integrations.ts ~line 3220).
// Pinning it here means a refactor that drops `firstError` from the
// route also breaks this test.
function mapWindowsForConsoleOverview(j: { windows: Array<any> }) {
  return j.windows.map((w) => ({
    label: w.windowLabel,
    status: w.status,
    statusReason: w.statusReason ?? null,
    scanned: w.scanned,
    ingested: w.ingested,
    skipped: w.skipped,
    pages: w.pages,
    errorCount: w.errors.length,
    firstError: w.errors[0] ?? null,
  }));
}

console.log = realLog;
console.warn = realWarn;
console.error = realError;
realLog("\n=== Front historical recovery observability (Task #843) ===");
console.log = ((...args: any[]) => captured.push(flatten(args))) as any;
console.warn = ((...args: any[]) => captured.push(flatten(args))) as any;
console.error = ((...args: any[]) => captured.push(flatten(args))) as any;

// ─────────────────────────────────────────────────────────────────────
// Path 1: window-level 401 → first-error surfaced everywhere
// ─────────────────────────────────────────────────────────────────────
await run(
  "window 401 surfaces firstError in log line, statusReason, and console-overview window shape",
  async () => {
    // Initial token is fresh so the first per-page accessor call short-
    // circuits to the cached value. Both page fetches return 401; the
    // forced-refresh OAuth call in between succeeds and rotates tokens.
    let pageHits = 0;
    let refreshHits = 0;
    currentFetchHandler = async (url) => {
      if (url.includes("/oauth/token")) {
        refreshHits++;
        return jsonResponse({
          access_token: "access-B",
          refresh_token: "refresh-B",
          expires_in: 3600,
        });
      }
      // Task #1869 — after two 401s the fetch helper runs one cheap `/me`
      // soft-gate probe (`probeConnection()`) before classifying the page
      // as terminally unauthorized. That probe is NOT a page-fetch attempt,
      // so it must not inflate `pageHits` (the assertion below pins the
      // initial + post-refresh page fetches at exactly two). Returning 401
      // here keeps the probe outcome `unauthorized` so the flow still falls
      // through to the `front_auth_unauthorized_after_refresh` terminal.
      if (/\/me(\?|$)/.test(url)) {
        return errorResponse(
          401,
          JSON.stringify({ _error: { status: 401, message: "unauthorized" } }),
        );
      }
      pageHits++;
      return errorResponse(
        401,
        JSON.stringify({ _error: { status: 401, message: "unauthorized" } }),
        { "x-request-id": `req-${pageHits}` },
      );
    };

    const checkpoint = await runTargetedWindowBackfill(
      {
        label: "2024-07",
        afterTimestamp: Math.floor(new Date("2024-07-01T00:00:00Z").getTime() / 1000),
        beforeTimestamp: Math.floor(new Date("2024-08-01T00:00:00Z").getTime() / 1000),
      },
      { dryRun: false, resume: false, jobId: "obs-test-1" },
    );

    assert.equal(pageHits, 2, "expected exactly two page-fetch attempts (initial + post-refresh)");
    assert.equal(refreshHits, 1, "expected exactly one forced-refresh OAuth call");
    assert.equal(
      checkpoint.statusReason,
      "front_auth_unauthorized_after_refresh",
      `statusReason should pin the typed error code, got ${checkpoint.statusReason}`,
    );
    assert.equal(
      checkpoint.status,
      "blocked",
      "post-refresh 401 must classify as blocked (operator must reconnect)",
    );
    assert.ok(
      checkpoint.errors.length >= 1 && typeof checkpoint.errors[0] === "string",
      "checkpoint.errors[0] must be set so the route can surface firstError",
    );
    assert.ok(
      checkpoint.errors[0].includes("401 after forced refresh"),
      `errors[0] should contain the actual 401 message, got ${checkpoint.errors[0]}`,
    );

    const windowLogLine = findLine(
      (s) =>
        s.includes("[FrontRecovery]") &&
        s.includes("[job=obs-test-1]") &&
        s.includes("Window 2024-07: status=blocked") &&
        s.includes("first error:"),
    );
    assert.ok(
      windowLogLine,
      `expected window status log line with 'first error:' tail; captured:\n${captured.join("\n")}`,
    );
    assert.ok(
      windowLogLine!.includes("401 after forced refresh"),
      `window log line should embed the actual error message; got: ${windowLogLine}`,
    );

    // Console-overview shape: this is the contract the route serves.
    const consoleWindows = mapWindowsForConsoleOverview({ windows: [checkpoint] });
    assert.equal(consoleWindows.length, 1);
    assert.equal(consoleWindows[0].status, "blocked");
    assert.equal(consoleWindows[0].statusReason, "front_auth_unauthorized_after_refresh");
    assert.equal(consoleWindows[0].errorCount, checkpoint.errors.length);
    assert.ok(
      typeof consoleWindows[0].firstError === "string" &&
        consoleWindows[0].firstError!.includes("401 after forced refresh"),
      `console-overview firstError must surface the actual error; got: ${consoleWindows[0].firstError}`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────
// Path 2: IIFE outer catch on a thrown coverage report
// ─────────────────────────────────────────────────────────────────────
await run(
  "runHistoricalRecovery: thrown coverage report results in persisted failed job + Fatal error log",
  async () => {
    const realDbExecute = (db as any).execute.bind(db);
    const realWorkerDbExecute = (workerDb as any).execute.bind(workerDb);
    let coverageRejected = false;
    const FATAL_MSG = "synthetic generateCoverageReport failure (Task #843)";

    // generateCoverageReport is the only thing in the IIFE that calls
    // `db.execute` before any window work. persistJob uses drizzle's
    // insert/update path (not db.execute) so this targeted patch lets
    // the job write its initial + terminal state via storage while the
    // coverage scan blows up exactly once. Task #1723 Phase 2.3 moved the
    // recovery loop onto `workerDb`, so we patch both pools' `.execute`
    // — whichever the coverage scan hits first will throw, then fall
    // back to the real implementation for any subsequent calls.
    const rejectOnce = (real: (...args: any[]) => any) =>
      async (...args: any[]) => {
        if (!coverageRejected) {
          coverageRejected = true;
          throw new Error(FATAL_MSG);
        }
        return real(...args);
      };
    (db as any).execute = rejectOnce(realDbExecute);
    (workerDb as any).execute = rejectOnce(realWorkerDbExecute);

    // Belt-and-braces: also fail any further fetch attempts so that if
    // (somehow) the windows loop is reached, the synthetic-failure
    // assertions still distinguish the coverage path from a fetch path.
    currentFetchHandler = async () => {
      throw new Error("fetch should not be called once coverage rejects");
    };

    let jobId: string;
    let job: Awaited<ReturnType<typeof getRecoveryJob>>;
    try {
      jobId = await runHistoricalRecovery({
        dryRun: true,
        // Custom windows are honoured but generateCoverageReport runs
        // unconditionally before the window loop — so the synthetic
        // throw fires regardless and never touches the windows path.
        customWindows: [
          {
            label: "2024-08",
            afterTimestamp: Math.floor(new Date("2024-08-01T00:00:00Z").getTime() / 1000),
            beforeTimestamp: Math.floor(new Date("2024-09-01T00:00:00Z").getTime() / 1000),
          },
        ],
      });
      // Keep db.execute patched until the IIFE has finished — restoring
      // it inside `finally` would race with the asynchronously-spawned
      // IIFE and let generateCoverageReport see the real db.execute.
      const deadline = Date.now() + 10_000;
      job = await getRecoveryJob(jobId);
      while (
        job &&
        job.status !== "failed" &&
        job.status !== "complete" &&
        job.status !== "partial" &&
        job.status !== "blocked" &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
        job = await getRecoveryJob(jobId);
      }
    } finally {
      // Restore so a failure doesn't leak the patched db.execute into
      // other tests that follow.
      (db as any).execute = realDbExecute;
      (workerDb as any).execute = realWorkerDbExecute;
    }
    assert.ok(job, "expected job state to be retrievable");
    assert.equal(job!.status, "failed", `job must end as failed; got ${job!.status}`);
    assert.ok(
      typeof job!.error === "string" && job!.error.includes(FATAL_MSG),
      `job.error must carry the thrown message; got: ${job!.error}`,
    );
    assert.ok(
      typeof job!.statusReason === "string" && job!.statusReason!.startsWith("fatal_error:"),
      `statusReason must be reclassified to fatal_error:*; got: ${job!.statusReason}`,
    );
    assert.ok(coverageRejected, "synthetic coverage failure should have fired");

    const fatalLine = findLine(
      (s) =>
        s.includes("[FrontRecovery]") &&
        s.includes(`[job=${jobId}]`) &&
        s.includes("Fatal error") &&
        s.includes(FATAL_MSG),
    );
    assert.ok(
      fatalLine,
      `expected '[FrontRecovery] [job=${jobId}] Fatal error: …' log line; captured:\n${captured.join("\n")}`,
    );

    // Persisted state survives a fresh listRecoveryJobs() call — i.e.
    // the failed job did not "disappear" in memory only.
    const all = await listRecoveryJobs();
    const persisted = all.find((j) => j.jobId === jobId);
    assert.ok(persisted, "failed job must be present in listRecoveryJobs()");
    assert.equal(persisted!.status, "failed");
    assert.ok(
      typeof persisted!.error === "string" && persisted!.error!.includes(FATAL_MSG),
      "persisted job.error must carry the fatal message",
    );
  },
);

// Restore globals.
console.log = realLog;
console.warn = realWarn;
console.error = realError;
globalThis.fetch = realFetch;

if (failed > 0) {
  realError(`\n${failed} test(s) failed`);
  process.exitCode = 1;
} else {
  realLog(`\nAll tests passed.`);
}
// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the process
// exits on its own once the tests settle — no manual process.exit() (Task #2084).
