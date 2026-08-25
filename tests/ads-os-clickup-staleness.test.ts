/* test-registration
{
  "name": "Ads OS ClickUp staleness signal — bundleAgeMs/bundleStaleSince flag a silently-stale directory bundle independently of liveness, cleared by a successful re-fetch (Task #3608)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3608: the staleness signal — a bundle older than the threshold reports bundleStaleSince (stale-data banner) while liveness stays true, and a good re-fetch clears it. Stubbed ClickUp fetch: no DB, no network.",
  "tier": "small"
}
test-registration */
/**
 * Ads OS — ClickUp directory staleness signal (Task #3608).
 *
 * bundleIsLive() only covers an outright failed refresh; a SLOW/partial
 * ClickUp keeps serving the stale bundle silently. Under test:
 *  (a) a fresh successful fetch: bundleAgeMs() is small, bundleStaleSince()
 *      is null (no false-positive banner);
 *  (b) once the bundle is older than the threshold (default 20 min),
 *      bundleStaleSince() returns the ISO time of the last successful fetch
 *      while bundleIsLive() STAYS true — the two signals are independent, so
 *      the UI can distinguish stale-data from full outage;
 *  (c) a successful re-fetch clears the staleness signal;
 *  (d) with no bundle ever fetched, bundleAgeMs()/bundleStaleSince() are null.
 *
 * All network is stubbed at global.fetch: no DB, no real network, no timers.
 */

import { strict as assert } from "node:assert";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// Env BEFORE import: config constants are read at module load.
process.env.CLICKUP_API_TOKEN = "pk_fake_staleness_test";
process.env.CLICKUP_STALE_AFTER_MINUTES = "20";

const CLICKUP_TASKS = {
  last_page: true,
  tasks: [{ id: "p1", name: "Acme Law", status: { status: "active" }, custom_fields: [] }],
};

const realFetch = global.fetch;
global.fetch = (async (url: any) => {
  const u = String(url);
  // Dispatch on URL *path shape*, never on live vendor hostnames — naming the
  // real API hosts here would make this test a net-new raw vendor-host caller
  // under lint-vendor-confinement.
  let pathname = "";
  try {
    pathname = new URL(u).pathname;
  } catch {
    // Non-absolute input: fall through.
  }
  if (pathname.startsWith("/api/v2/")) {
    if (isClickUpListFieldPath(pathname)) {
      return new Response(JSON.stringify(EMPTY_CLICKUP_PRACTICE_AREA_FIELDS), {
        status: 200,
      });
    }
    return new Response(JSON.stringify(CLICKUP_TASKS), { status: 200 });
  }
  throw new Error(`unexpected fetch in test: ${u}`);
}) as any;

async function main() {
  const dir = await import("../server/services/adsOs/clickUpDirectory");

  // Task #3662 preamble — the company token now resolves via the runtime
  // accessor: stub its store (env-only fallback, no settings/DB read) and
  // inject noop directory alert hooks so the real dispatcher chain never loads.
  const __tok = await import("../server/services/clickUpCompanyToken");
  __tok.__setClickUpCompanyTokenStoreForTest({
    async get() {
      return undefined;
    },
    async set() {},
    async del() {},
    async recordAudit() {},
  });
  dir.__setDirectoryAlertHooksForTest({ onSuccess: async () => {}, onFailure: async () => {} });

  dir.__testResetDirectoryCache();

  // (d) nothing fetched yet → both null
  assert.equal(dir.bundleAgeMs(), null, "no bundle → bundleAgeMs null");
  assert.equal(dir.bundleStaleSince(), null, "no bundle → bundleStaleSince null");

  // (a) fresh fetch → small age, no staleness
  const bundle = await dir.getClientDirectory({ force: true });
  assert.equal(bundle.blocks.length, 1, "fixture parent built into a block");
  const age = dir.bundleAgeMs();
  assert.ok(age !== null && age >= 0 && age < 60_000, `fresh bundle age small, got ${age}`);
  assert.equal(dir.bundleStaleSince(), null, "fresh bundle → not stale");
  assert.equal(dir.bundleIsLive(), true, "fresh fetch → live");

  // (b) age past the 20-min threshold → stale, but STILL live
  dir.__testAgeBundle(21 * 60 * 1000);
  const staleSince = dir.bundleStaleSince();
  assert.ok(staleSince, "aged bundle → bundleStaleSince set");
  assert.ok(!isNaN(Date.parse(staleSince!)), "staleSince is a parsable ISO timestamp");
  const agedAge = dir.bundleAgeMs()!;
  assert.ok(agedAge > 20 * 60 * 1000, `aged bundleAgeMs > threshold, got ${agedAge}`);
  assert.equal(dir.bundleIsLive(), true, "staleness is independent of liveness");
  // staleSince points at the (aged) last successful fetch, not "now"
  assert.ok(Date.now() - Date.parse(staleSince!) > 20 * 60 * 1000, "staleSince = last fetch time");

  // (c) successful re-fetch clears the signal
  await dir.getClientDirectory({ force: true });
  assert.equal(dir.bundleStaleSince(), null, "re-fetch clears staleness");
  assert.ok(dir.bundleAgeMs()! < 60_000, "re-fetch resets age");

  dir.__testResetDirectoryCache();
  global.fetch = realFetch;
  console.log("ads-os-clickup-staleness: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
