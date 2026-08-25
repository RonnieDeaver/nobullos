/* test-registration
{
  "name": "RIS escalation alerts build the correct deep-link to the flagged client/month/layer (Task #2572)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/ris-flag-deep-link-mock-setup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2572 — RIS escalation alerts build the correct deep-link to the flagged
 * client and month (and layer when applicable).
 *
 * Task #2542 proved the *parsing* half: that `RisDashboard` reads
 * `/ris?clientId=…&period=YYYY-MM&layer=…` and lands on the right client /
 * month / layer (see tests/client/ris-deep-link.test.tsx). This is the
 * *generation* half: when a High/Critical RIS Fail/Blocked (or a Performance
 * Red) fires, the notification handed to `notifyUser` must carry a deep-link
 * URL whose `clientId` is the flagged client, whose `period` is the flagged
 * month, and whose `layer` is the check's own layer for non-QA checks. If
 * generation regresses, every link would parse fine but point at the wrong
 * place.
 *
 * The notify path (`notifyUser`), recipient resolution (`byFunction`), and
 * `rankSeverity` all sit on DB-backed modules, so this suite redirects those
 * three imports to stubs via the resolve hook in
 * `ris-flag-deep-link-loader.mjs` (registered through
 * `--import ./tests/ris-flag-deep-link-mock-setup.mjs`). The userInbox stub
 * records every `notifyUser` call on `globalThis.__RIS_FLAG_NOTIFY_CALLS__`, so
 * we can assert the exact `deepLink` the escalation emitted.
 *
 * Scenarios:
 *   1. High-severity QA Fail → deep-link carries the flagged client + period and
 *      NO layer (QA is the dashboard default, left implicit).
 *   2. Blocked (low severity — Blocked always escalates) → same client + period
 *      pinning, proving the Blocked path also deep-links correctly.
 *   3. Performance Red (High) → deep-link additionally pins `layer=performance`
 *      so the recipient opens the Performance layer, not the QA checklist.
 *   4. Resolve transition (Fail → Pass) → the follow-up "resolved" notice still
 *      carries the correct client + period deep-link.
 */

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

interface NotifyCall {
  userId: string;
  opts: { title: string; deepLink?: string; dedupeKey?: string; metadata?: any };
}

const notifyCalls: NotifyCall[] = ((globalThis as any).__RIS_FLAG_NOTIFY_CALLS__ =
  (globalThis as any).__RIS_FLAG_NOTIFY_CALLS__ || []);

function resetCalls(): void {
  notifyCalls.length = 0;
}

const { processRisResultFlag, buildRisFlagDeepLink } = await import(
  "../server/services/ris/risFlagging"
);

// Minimal check / result fixtures. Only the fields the flagging path reads are
// populated; the rest are cast through `any` so we don't have to hand-build the
// full Drizzle row shape.
function makeCheck(over: Record<string, any> = {}): any {
  return {
    id: "check-1",
    key: "gbp_listing_live",
    label: "GBP Listing Live",
    layer: "qa",
    product: "gbp",
    defaultOwnerFunction: "account_manager",
    defaultSeverity: "high",
    ...over,
  };
}

function makeResult(over: Record<string, any> = {}): any {
  return {
    clientId: "client-acme-2572",
    period: "2026-03",
    status: "fail",
    locationId: null,
    severityOverride: null,
    failureReason: null,
    correctiveAction: null,
    ...over,
  };
}

function lastNotify(): NotifyCall {
  assert(notifyCalls.length > 0, "expected at least one notifyUser call");
  return notifyCalls[notifyCalls.length - 1];
}

function paramsOf(deepLink: string | undefined): URLSearchParams {
  assert(typeof deepLink === "string", "notification must carry a deepLink");
  const q = (deepLink as string).indexOf("?");
  assert(q >= 0, `deepLink must have a query string (got '${deepLink}')`);
  assert(
    (deepLink as string).slice(0, q) === "/ris",
    `deepLink must target /ris (got '${deepLink}')`,
  );
  return new URLSearchParams((deepLink as string).slice(q + 1));
}

// ---------------------------------------------------------------------------
// Pure-builder direct checks — the cheapest guard on the URL shape.
// ---------------------------------------------------------------------------

function scenarioBuilderUnit(): void {
  console.log("\n— Scenario 0: buildRisFlagDeepLink shapes the URL per layer —");

  const qa = buildRisFlagDeepLink({ layer: "qa" }, {
    clientId: "c1",
    period: "2026-01",
  });
  assert(qa === "/ris?clientId=c1&period=2026-01", `QA link wrong: ${qa}`);

  const perf = buildRisFlagDeepLink({ layer: "performance" }, {
    clientId: "c2",
    period: "2026-02",
  });
  assert(
    perf === "/ris?clientId=c2&period=2026-02&layer=performance",
    `Performance link wrong: ${perf}`,
  );

  const eng = buildRisFlagDeepLink({ layer: "engagement" }, {
    clientId: "c3",
    period: "2026-12",
  });
  assert(
    eng === "/ris?clientId=c3&period=2026-12&layer=engagement",
    `Engagement link wrong: ${eng}`,
  );

  console.log("  ✓ QA implicit, Performance + Engagement pin their layer");
}

// ---------------------------------------------------------------------------
// Scenario 1: a High-severity QA Fail escalates with the right client + month.
// ---------------------------------------------------------------------------

async function scenarioHighFail(): Promise<void> {
  console.log("\n— Scenario 1: High QA Fail → client + period, no layer —");
  resetCalls();

  await processRisResultFlag({
    check: makeCheck({ layer: "qa", defaultSeverity: "high" }),
    result: makeResult({ clientId: "client-acme-2572", period: "2026-03", status: "fail" }),
    firmName: "Acme Law",
    locationName: null,
    previousStatus: "pass",
  });

  const call = lastNotify();
  const p = paramsOf(call.opts.deepLink);
  assert(
    p.get("clientId") === "client-acme-2572",
    `clientId must be the flagged client (got '${p.get("clientId")}')`,
  );
  assert(
    p.get("period") === "2026-03",
    `period must be the flagged month (got '${p.get("period")}')`,
  );
  assert(
    p.get("layer") === null,
    `QA fail must not pin a layer (got '${p.get("layer")}')`,
  );
  // The metadata mirror must agree with the URL so downstream consumers can't drift.
  assert(
    call.opts.metadata?.clientId === "client-acme-2572" &&
      call.opts.metadata?.period === "2026-03",
    "metadata clientId/period must match the deep-link",
  );
  console.log("  ✓ High QA Fail deep-links to client-acme-2572 @ 2026-03");
}

// ---------------------------------------------------------------------------
// Scenario 2: a Blocked result escalates even at low severity.
// ---------------------------------------------------------------------------

async function scenarioBlocked(): Promise<void> {
  console.log("\n— Scenario 2: Blocked (low sev) → client + period —");
  resetCalls();

  await processRisResultFlag({
    check: makeCheck({ layer: "qa", defaultSeverity: "low" }),
    result: makeResult({
      clientId: "client-globex-2572",
      period: "2025-11",
      status: "blocked",
    }),
    firmName: "Globex",
    locationName: null,
    previousStatus: "pass",
  });

  const call = lastNotify();
  const p = paramsOf(call.opts.deepLink);
  assert(
    p.get("clientId") === "client-globex-2572",
    `Blocked clientId wrong (got '${p.get("clientId")}')`,
  );
  assert(
    p.get("period") === "2025-11",
    `Blocked period wrong (got '${p.get("period")}')`,
  );
  console.log("  ✓ Blocked deep-links to client-globex-2572 @ 2025-11");
}

// ---------------------------------------------------------------------------
// Scenario 3: a Performance Red pins layer=performance.
// ---------------------------------------------------------------------------

async function scenarioPerformanceRed(): Promise<void> {
  console.log("\n— Scenario 3: Performance Red → layer=performance —");
  resetCalls();

  await processRisResultFlag({
    check: makeCheck({
      key: "leads_trend",
      label: "Leads Trend",
      layer: "performance",
      defaultSeverity: "high",
    }),
    result: makeResult({
      clientId: "client-initech-2572",
      period: "2026-02",
      status: "red",
    }),
    firmName: "Initech",
    locationName: null,
    previousStatus: "green",
  });

  const call = lastNotify();
  const p = paramsOf(call.opts.deepLink);
  assert(
    p.get("clientId") === "client-initech-2572",
    `Perf Red clientId wrong (got '${p.get("clientId")}')`,
  );
  assert(
    p.get("period") === "2026-02",
    `Perf Red period wrong (got '${p.get("period")}')`,
  );
  assert(
    p.get("layer") === "performance",
    `Performance Red must pin layer=performance (got '${p.get("layer")}')`,
  );
  console.log("  ✓ Performance Red deep-links with layer=performance");
}

// ---------------------------------------------------------------------------
// Scenario 4: the resolve (clear) notice still deep-links correctly.
// ---------------------------------------------------------------------------

async function scenarioResolveNotice(): Promise<void> {
  console.log("\n— Scenario 4: Fail→Pass resolve notice keeps the deep-link —");
  resetCalls();

  await processRisResultFlag({
    check: makeCheck({ layer: "qa", defaultSeverity: "critical" }),
    result: makeResult({
      clientId: "client-umbrella-2572",
      period: "2026-01",
      status: "pass",
    }),
    firmName: "Umbrella",
    locationName: null,
    previousStatus: "fail",
  });

  // The resolve branch emits a "RIS resolved" follow-up notice.
  const resolved = notifyCalls.find((c) => c.opts.title.startsWith("RIS resolved"));
  assert(resolved !== undefined, "a resolved follow-up notice must be sent");
  const p = paramsOf(resolved!.opts.deepLink);
  assert(
    p.get("clientId") === "client-umbrella-2572" && p.get("period") === "2026-01",
    `resolve notice deep-link wrong (got '${resolved!.opts.deepLink}')`,
  );
  console.log("  ✓ Resolve notice deep-links to client-umbrella-2572 @ 2026-01");
}

async function main(): Promise<void> {
  scenarioBuilderUnit();
  await scenarioHighFail();
  await scenarioBlocked();
  await scenarioPerformanceRed();
  await scenarioResolveNotice();
  console.log("\nris-flag-deep-link: all cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
