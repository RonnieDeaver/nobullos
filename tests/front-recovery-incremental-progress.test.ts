/* test-registration
{
  "name": "Front recovery per-page persistence + fingerprint (Task #1636)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~4.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1636 — per-page persistence + heartbeat + fingerprint
 * regression tests for Front historical recovery.
 *
 * T1: per-page checkpoint persistence (saveCheckpoint + onProgress
 *     fire once per completed page).
 * T2: interruption preserves cursor (page 1 success, page 2 fails →
 *     persisted checkpoint shows pages=1 and the page-2 URL).
 * T3: fingerprint changes when page/cursor advances.
 * T4: fingerprint stable when no progress occurs.
 */

import { storage } from "../server/storage";

let failed = 0;
async function run(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(
      `  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`,
    );
    failed++;
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// In-memory fake of the system-settings store, also recording every
// setSystemSetting call so the test can audit per-page persistence.
const settings = new Map<string, string>();
const setCalls: Array<{ key: string; value: string }> = [];
// Task #1787 Stage 6: disable the active-inbox-filter kill switch so the
// recovery loop does not perform a sibling /inboxes fetch that would
// consume a page-iteration the test counts.
settings.set("front_recovery_active_inbox_filter_enabled", "false");
(storage as any).getSystemSettings = async (keys: string[]) => {
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = settings.get(k);
  return out;
};
(storage as any).getSystemSetting = async (key: string) => {
  return settings.has(key) ? { key, value: settings.get(key)! } : undefined;
};
// Prime the Pool-Epic kill-switch cache so the first synchronous read
// of `front_recovery_active_inbox_filter_enabled` returns false rather
// than the hard-coded ON default.
const { ensurePoolEpicSwitchesLoaded } = await import(
  "../server/services/poolEpicKillSwitches"
);
await ensurePoolEpicSwitchesLoaded();
(storage as any).setSystemSetting = async (key: string, value: string) => {
  settings.set(key, value);
  setCalls.push({ key, value });
  return { key, value };
};
(storage as any).deleteSystemSetting = async (key: string) => {
  settings.delete(key);
};

// Stub Front OAuth env so the page helper doesn't bail on missing creds.
process.env.FRONT_CLIENT_ID = process.env.FRONT_CLIENT_ID || "test-client-id";
process.env.FRONT_CLIENT_SECRET =
  process.env.FRONT_CLIENT_SECRET || "test-client-secret";

function seedConnected() {
  settings.clear();
  setCalls.length = 0;
  const now = Math.floor(Date.now() / 1000);
  settings.set("front_access_token", "access-A");
  settings.set("front_refresh_token", "refresh-A");
  settings.set("front_token_expires_at", String(now + 3600));
}

type FetchHandler = (url: string, init: any) => Promise<Response>;
let currentFetchHandler: FetchHandler = async () => {
  throw new Error("fetch handler not set");
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  return currentFetchHandler(url, init ?? {});
}) as any;

function jsonResponse(body: any, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
}
function errorResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

const recoveryModule = await import(
  "../server/services/frontHistoricalRecovery"
);
const { runTargetedWindowBackfill } = recoveryModule;
// buildProgressFingerprint is module-private; access via the module
// namespace cast so tests can exercise its formatting contract
// without exporting it from production code.
const buildProgressFingerprint: (job: any) => string =
  (recoveryModule as any).buildProgressFingerprint ??
  (() => {
    throw new Error(
      "buildProgressFingerprint not accessible; test must be updated",
    );
  });

console.log(
  "\n=== Front historical recovery: per-page persistence + fingerprint (Task #1636) ===",
);

await run(
  "T1: per-page checkpoint persistence — saveCheckpoint + onProgress fire once per page",
  async () => {
    seedConnected();
    let pageCalls = 0;
    currentFetchHandler = async (url) => {
      if (url.includes("/oauth/token")) {
        return jsonResponse({
          access_token: "access-A",
          refresh_token: "refresh-A",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      pageCalls++;
      // 3 pages, page 1 + 2 advance the cursor; page 3 has no next.
      // Each page must return >= batchSize (50) conversations or the
      // loop short-circuits via the `conversations.length < batchSize`
      // tail-page break.
      const nextByPage: Array<string | null> = [
        "/conversations?page_token=2",
        "/conversations?page_token=3",
        null,
      ];
      const results = Array.from({ length: 50 }, (_, i) => ({
        id: `conv-p${pageCalls}-${i}`,
      }));
      return jsonResponse({
        _results: results,
        _pagination: { next: nextByPage[pageCalls - 1] },
      });
    };

    const progressSeen: Array<{ pages: number; lastPageUrl: string | null }> =
      [];
    const checkpoint = await runTargetedWindowBackfill(
      {
        label: "w-t1",
        afterTimestamp: 1700000000,
        beforeTimestamp: 1700100000,
      },
      {
        dryRun: true,
        resume: false,
        jobId: "test-t1",
        onProgress: (cp) => {
          progressSeen.push({
            pages: cp.pages,
            lastPageUrl: cp.lastPageUrl,
          });
        },
      },
    );

    assert(
      checkpoint.pages === 3,
      `expected 3 pages processed, got ${checkpoint.pages}`,
    );
    // onProgress fires once per completed page (3 times), not once at
    // the end and not only every 5 pages.
    assert(
      progressSeen.length === 3,
      `expected onProgress 3 times, got ${progressSeen.length}: ${JSON.stringify(progressSeen)}`,
    );
    assert(
      progressSeen[0].pages === 1 &&
        progressSeen[1].pages === 2 &&
        progressSeen[2].pages === 3,
      `onProgress should see pages 1,2,3 in order, got ${JSON.stringify(progressSeen)}`,
    );
    // saveCheckpoint writes the window's setting. We expect at least
    // one write per page (3) plus the trailing terminal save (4 total).
    const cpKey = "front_recovery_checkpoint_w_t1";
    const cpWrites = setCalls.filter((c) => c.key === cpKey);
    assert(
      cpWrites.length >= 3,
      `expected ≥3 per-page checkpoint writes, got ${cpWrites.length}`,
    );
    // The first 3 writes should reflect monotonically advancing pages.
    const pagesPerWrite = cpWrites
      .slice(0, 3)
      .map((c) => JSON.parse(c.value).pages);
    assert(
      pagesPerWrite[0] === 1 &&
        pagesPerWrite[1] === 2 &&
        pagesPerWrite[2] === 3,
      `expected per-page writes to show pages 1,2,3; got ${JSON.stringify(pagesPerWrite)}`,
    );
  },
);

await run(
  "T2: interruption preserves cursor — page 1 ok, page 2 errors, persisted checkpoint shows page-2 URL",
  async () => {
    seedConnected();
    let pageCalls = 0;
    currentFetchHandler = async (url) => {
      if (url.includes("/oauth/token")) {
        return jsonResponse({
          access_token: "access-A",
          refresh_token: "refresh-A",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      // Page 1 succeeds with next_page_url = /conv?page=2.
      // Page 2+ always 503 — retries exhaust → recoverable error.
      if (url.includes("page_token=2")) {
        pageCalls++;
        return errorResponse(503, "Service Unavailable");
      }
      pageCalls++;
      const results = Array.from({ length: 50 }, (_, i) => ({
        id: `c1-${i}`,
      }));
      return jsonResponse({
        _results: results,
        _pagination: { next: "/conversations?page_token=2" },
      });
    };

    const checkpoint = await runTargetedWindowBackfill(
      {
        label: "w-t2",
        afterTimestamp: 1700000000,
        beforeTimestamp: 1700100000,
      },
      { dryRun: true, resume: false, jobId: "test-t2" },
    );

    // Page 1 completed; page 2 failed → status partial, page-2 URL
    // preserved as the resume cursor.
    assert(
      checkpoint.pages === 1,
      `expected pages=1 (only page 1 completed), got ${checkpoint.pages}`,
    );
    assert(
      checkpoint.status === "partial",
      `expected partial, got ${checkpoint.status}`,
    );
    assert(
      typeof checkpoint.lastPageUrl === "string" &&
        checkpoint.lastPageUrl.includes("page_token=2"),
      `expected lastPageUrl to preserve page-2 URL, got ${checkpoint.lastPageUrl}`,
    );

    // The persisted setting must agree with the in-memory checkpoint
    // — that's the entire point of per-page persistence.
    const persistedRaw = settings.get("front_recovery_checkpoint_w_t2");
    assert(persistedRaw, "checkpoint should be persisted");
    const persisted = JSON.parse(persistedRaw!);
    assert(
      persisted.pages === 1,
      `persisted pages should be 1, got ${persisted.pages}`,
    );
    assert(
      typeof persisted.lastPageUrl === "string" &&
        persisted.lastPageUrl.includes("page_token=2"),
      `persisted lastPageUrl should preserve page-2 URL, got ${persisted.lastPageUrl}`,
    );
  },
);

await run(
  "T3: fingerprint changes when page/cursor advances",
  async () => {
    const baseWindow = {
      windowLabel: "2025-08",
      afterTimestamp: 1,
      beforeTimestamp: 2,
      status: "partial" as const,
      statusReason: null,
      scanned: 25,
      ingested: 23,
      skipped: 0,
      errors: [] as string[],
      pages: 1,
      lastPageUrl: "/conversations?page=2",
      startedAt: null,
      completedAt: null,
    };
    const a: any = {
      jobId: "a",
      status: "partial",
      statusReason: null,
      dryRun: false,
      coverageReport: null,
      windows: [{ ...baseWindow }],
      totals: { scanned: 25, ingested: 23, skipped: 0, errors: 0, pages: 1 },
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      requestedCustomWindows: null,
    };
    const b: any = {
      ...a,
      windows: [
        { ...baseWindow, pages: 2, lastPageUrl: "/conversations?page=3" },
      ],
    };
    const fpA = buildProgressFingerprint(a);
    const fpB = buildProgressFingerprint(b);
    assert(
      fpA !== fpB,
      `fingerprints should differ when page/cursor advances; got identical: ${fpA}`,
    );
  },
);

await run(
  "T4: fingerprint stable when no progress occurs",
  async () => {
    const baseWindow = {
      windowLabel: "2025-08",
      afterTimestamp: 1,
      beforeTimestamp: 2,
      status: "partial" as const,
      statusReason: null,
      scanned: 25,
      ingested: 23,
      skipped: 0,
      errors: [] as string[],
      pages: 1,
      lastPageUrl: "/conversations?page=2",
      startedAt: null,
      completedAt: null,
    };
    const a: any = {
      jobId: "a",
      status: "partial",
      statusReason: null,
      dryRun: false,
      coverageReport: null,
      windows: [{ ...baseWindow }],
      totals: { scanned: 25, ingested: 23, skipped: 0, errors: 0, pages: 1 },
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      requestedCustomWindows: null,
    };
    const b: any = { ...a, windows: [{ ...baseWindow }] };
    const fpA = buildProgressFingerprint(a);
    const fpB = buildProgressFingerprint(b);
    assert(
      fpA === fpB,
      `fingerprints should be identical when no progress occurred; got A=${fpA} B=${fpB}`,
    );
  },
);

globalThis.fetch = realFetch;

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
}
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
console.log("\nAll Front recovery incremental-progress tests passed.");
