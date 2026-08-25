/* test-registration
{
  "name": "Global transient query retry — 5xx/network blips self-heal before the global error toast; 4xx/BOOT_503/structured-503s stay single-attempt",
  "regression": true,
  "smoke": true,
  "smokeReason": "The shared queryClient's global transient retry is the fix for the production \"Request failed — Couldn't reach the server\" toast on page open (/sheets report): with `retry: false`, ONE transient 5xx/network blip among the page-load burst of parallel queries fires the global toast. A regression in the classifier (retrying 4xx/429, re-entering the BOOT_503 loop, delaying the structured-503 banners) or in the retry wiring would either bring the scary-toast UX back or mask terminal errors. Fast, DB-free, deterministic (scripted fetch stub, toast captured; no DOM).",
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
 * Global transient query retry — the shared `queryClient` self-heals transient
 * blips (bare 5xx, browser network errors) by retrying up to
 * TRANSIENT_QUERY_RETRY_LIMIT times before any error surfaces, so a single
 * blip during a page-load burst never fires the global error toast
 * (the production /sheets symptom: one transient 5xx among ~15 parallel
 * queries under background-job load → scary "Couldn't reach the server"
 * toast on every visit; since Task #4346 the toast copy is the humane
 * failure-class mapping from queryErrorCopy.ts).
 *
 * Contract pinned here:
 *   A. Bare 5xx twice then 200 → query resolves, 3 fetch attempts, ZERO toasts.
 *   B. Persistent bare 500 → rejects after exactly 3 attempts (1 + 2 retries),
 *      exactly ONE humane "Server problem" toast (Task #4685: humane copy
 *      ONLY — no raw "500: …" text anywhere in the toast).
 *   C. Terminal 400 → rejects after exactly 1 attempt (no retry), one toast.
 *   D. Structured Google-Ads-disconnected 503 → 1 attempt (not classified
 *      transient), NO toast (dedicated page banner owns it).
 *   E. Network error (fetch rejects) twice then 200 → resolves, 3 attempts,
 *      zero toasts.
 *   F. Classifier units — BOOT_503-coded 503 and status-unknown 503 are NOT
 *      transient (each has its own dedicated handling), 429/401/4xx are NOT
 *      transient, bare 500/502/503/504 + network errors ARE.
 *
 * The toast surface is captured via the shared use-toast stub loader
 * (tests/query-transient-retry-setup.mjs); no DOM is needed — scenarios drive
 * the real shared queryClient (default queryFn + default retry policy)
 * through `fetchQuery`, and QueryCache.onError fires exactly as in the app.
 */

import assert from "node:assert/strict";

(globalThis as any).__capturedToasts = [];

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

// ---- Scripted fetch stub: per-URL verdict queues (last verdict is sticky) ---

type Verdict = { status: number; body: unknown } | "network";
const scripts: Record<string, Verdict[]> = {};
const attempts: Record<string, number> = {};

(globalThis as any).fetch = async (input: any) => {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  attempts[url] = (attempts[url] ?? 0) + 1;
  const queue = scripts[url];
  assert.ok(queue && queue.length > 0, `unexpected fetch: ${url}`);
  const verdict = queue.length > 1 ? (queue.shift() as Verdict) : queue[0];
  if (verdict === "network") throw new TypeError("Failed to fetch");
  return makeRes(verdict.status, verdict.body);
};

function toasts(): any[] {
  return (globalThis as any).__capturedToasts;
}

// ---- Run --------------------------------------------------------------------

async function run() {
  const {
    queryClient,
    isTransientQueryError,
    TRANSIENT_QUERY_RETRY_LIMIT,
    transientRetryDelay,
  } = await import("@/lib/queryClient");

  assert.equal(TRANSIENT_QUERY_RETRY_LIMIT, 2, "retry limit contract");

  // A — transient 5xx blips self-heal: 500, 502, then 200. No toast.
  scripts["/api/case-a"] = [
    { status: 500, body: "internal" },
    { status: 502, body: "<html>bad gateway</html>" },
    { status: 200, body: { ok: true } },
  ];
  const a = await queryClient.fetchQuery({ queryKey: ["/api/case-a"] });
  assert.deepEqual(a, { ok: true }, "case A resolves with the recovered data");
  assert.equal(attempts["/api/case-a"], 3, "case A used exactly 3 attempts");
  assert.equal(toasts().length, 0, "case A fired no toast");

  // B — persistent bare 500: rejects after 1 + TRANSIENT_QUERY_RETRY_LIMIT
  // attempts, exactly one humane "Server problem" toast (Task #4685: plain
  // title + recovery sentence ONLY — the raw "500: …" text never appears in
  // the toast; it stays available to inline panels via technicalDetail).
  scripts["/api/case-b"] = [{ status: 500, body: "internal" }];
  let bErr: unknown = null;
  try {
    await queryClient.fetchQuery({ queryKey: ["/api/case-b"] });
  } catch (err) {
    bErr = err;
  }
  assert.ok(bErr instanceof Error, "case B rejects");
  assert.equal(
    attempts["/api/case-b"],
    1 + TRANSIENT_QUERY_RETRY_LIMIT,
    "case B exhausted the transient retry budget",
  );
  assert.equal(toasts().length, 1, "case B fired exactly one toast");
  assert.equal(toasts()[0].title, "Server problem");
  const bDesc = toasts()[0].description;
  assert.equal(typeof bDesc, "string", "case B description is plain humane copy");
  assert.match(
    bDesc,
    /wait a moment and retry/i,
    "case B leads with humane recovery guidance",
  );
  assert.ok(
    !/\b\d{3}:/.test(bDesc) && !bDesc.includes("internal"),
    "case B never surfaces the raw status prefix or server body in the toast",
  );

  // C — terminal 400: exactly 1 attempt (no retry), one toast.
  (globalThis as any).__capturedToasts = [];
  scripts["/api/case-c"] = [{ status: 400, body: "bad input" }];
  let cErr: unknown = null;
  try {
    await queryClient.fetchQuery({ queryKey: ["/api/case-c"] });
  } catch (err) {
    cErr = err;
  }
  assert.ok(cErr instanceof Error, "case C rejects");
  assert.equal(attempts["/api/case-c"], 1, "case C made exactly one attempt");
  assert.equal(toasts().length, 1, "case C fired exactly one toast");

  // D — structured Google-Ads-disconnected 503: 1 attempt, NO toast.
  (globalThis as any).__capturedToasts = [];
  scripts["/api/case-d"] = [
    {
      status: 503,
      body: {
        code: "google_ads_disconnected",
        message: "Google Ads is disconnected",
        reason: "breaker open",
        lastError: null,
      },
    },
  ];
  let dErr: unknown = null;
  try {
    await queryClient.fetchQuery({ queryKey: ["/api/case-d"] });
  } catch (err) {
    dErr = err;
  }
  assert.ok(dErr instanceof Error, "case D rejects");
  assert.equal(attempts["/api/case-d"], 1, "case D made exactly one attempt");
  assert.equal(toasts().length, 0, "case D suppressed the toast");

  // E — network blips self-heal: reject, reject, then 200. No toast.
  (globalThis as any).__capturedToasts = [];
  scripts["/api/case-e"] = ["network", "network", { status: 200, body: [1, 2] }];
  const e = await queryClient.fetchQuery({ queryKey: ["/api/case-e"] });
  assert.deepEqual(e, [1, 2], "case E resolves after network blips");
  assert.equal(attempts["/api/case-e"], 3, "case E used exactly 3 attempts");
  assert.equal(toasts().length, 0, "case E fired no toast");

  console.log("  ✓ scenarios A-E: transient retries self-heal, terminal errors stay single-attempt");

  // F — classifier units.
  assert.equal(isTransientQueryError(new Error("500: internal")), true);
  assert.equal(isTransientQueryError(new Error("502: <html>")), true);
  assert.equal(isTransientQueryError(new Error("503: busy")), true);
  assert.equal(isTransientQueryError(new Error("504: upstream timeout")), true);
  assert.equal(isTransientQueryError(new TypeError("Failed to fetch")), true);
  assert.equal(isTransientQueryError(new Error("NetworkError when attempting to fetch resource.")), true);
  assert.equal(isTransientQueryError(new Error("Load failed")), true);
  assert.equal(
    isTransientQueryError(new Error('503: {"code":"BOOT_503","retryAfterMs":3000}')),
    false,
    "BOOT_503 has its own dedicated retry loop inside getQueryFn",
  );
  assert.equal(
    isTransientQueryError(
      new Error('503: {"code":"google_ads_disconnected","message":"m","reason":"r","lastError":null}'),
    ),
    false,
    "structured Ads-disconnected 503 surfaces immediately to its page banner",
  );
  assert.equal(
    isTransientQueryError(
      new Error('503: {"statusUnknown":true,"probeFailed":true,"reason":"read threw"}'),
    ),
    false,
    "structured status-unknown 503 surfaces immediately to its card",
  );
  assert.equal(isTransientQueryError(new Error("429: slow down")), false);
  assert.equal(isTransientQueryError(new Error("401: unauthorized")), false);
  assert.equal(isTransientQueryError(new Error("400: bad input")), false);
  assert.equal(isTransientQueryError(new Error("404: nope")), false);
  assert.equal(isTransientQueryError("not an error"), false);

  // Backoff shape: 1s, 2s, then capped at 5s.
  assert.equal(transientRetryDelay(0), 1000);
  assert.equal(transientRetryDelay(1), 2000);
  assert.equal(transientRetryDelay(3), 5000);

  console.log("  ✓ scenario F: classifier + backoff contract");
}

run()
  .then(() => {
    console.log("\nPASS tests/client/query-transient-retry.test.ts");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL tests/client/query-transient-retry.test.ts");
    console.error(err);
    process.exit(1);
  });
