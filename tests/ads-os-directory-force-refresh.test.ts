/* test-registration
{
  "name": "Ads OS directory force-refresh — force busts the 10-min TTL and serves changed ClickUp data immediately; proof mode propagates fetch failures (Task #3609)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3609: manual directory force-refresh — force busts the 10-min TTL and serves changed ClickUp data immediately; the route's proof mode propagates fetch failures instead of silently serving stale. Stubbed ClickUp fetch: no DB, no network.",
  "tier": "small"
}
test-registration */
/**
 * Ads OS — manual directory force-refresh (Task #3609).
 *
 * Operators editing "Ads Status" in ClickUp shouldn't wait out the 10-min
 * directory TTL. Under test, at the module level backing
 * POST /api/ads-os/directory/refresh:
 *  (a) a TTL-fresh cache hit does NOT re-fetch (baseline: the cache works);
 *  (b) getClientDirectory({ force: true }) re-fetches even while the cache is
 *      TTL-fresh, and the served bundle reflects the changed ClickUp data
 *      (client added between fetches shows up immediately);
 *  (c) force + throwOnError (the route's proof mode) PROPAGATES a fetch
 *      failure instead of silently serving the stale bundle — the route must
 *      never report "refreshed" without refreshing.
 *
 * All network is stubbed at global.fetch: no DB, no real network, no timers.
 */

import { strict as assert } from "node:assert";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// Env BEFORE import: config constants are read at module load.
process.env.CLICKUP_API_TOKEN = "pk_fake_force_refresh_test";

function tasksPayload(names: string[]) {
  return {
    last_page: true,
    tasks: names.map((name, i) => ({
      id: `p${i}`, name, status: { status: "active" }, custom_fields: [],
    })),
  };
}

let clickupResponse: any = tasksPayload(["Acme Law"]);
let failNextFetch = false;
let fetchCount = 0;

const realFetch = global.fetch;
global.fetch = (async (url: any) => {
  const u = String(url);
  // Dispatch on URL *path shape*, never on live vendor hostnames — naming the
  // real API hosts here would make this test a net-new raw vendor-host caller
  // under lint-vendor-confinement. ClickUp API routes are all under /api/v2/.
  let pathname = "";
  try {
    pathname = new URL(u).pathname;
  } catch {
    // Non-absolute input: fall through.
  }
  if (pathname.startsWith("/api/v2/")) {
    if (isClickUpListFieldPath(pathname)) {
      return failNextFetch
        ? new Response(JSON.stringify({ err: "boom" }), { status: 500 })
        : new Response(JSON.stringify(EMPTY_CLICKUP_PRACTICE_AREA_FIELDS), {
            status: 200,
          });
    }
    fetchCount++;
    if (failNextFetch) {
      return new Response(JSON.stringify({ err: "boom" }), { status: 500 });
    }
    return new Response(JSON.stringify(clickupResponse), { status: 200 });
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

  // Seed the cache.
  const first = await dir.getClientDirectory({ force: true });
  assert.equal(first.blocks.length, 1, "seed bundle has the one fixture client");
  assert.equal(fetchCount, 1, "seed fetch happened");

  // (a) TTL-fresh plain read serves the cache — no new fetch.
  clickupResponse = tasksPayload(["Acme Law", "New Client LLC"]);
  const cached = await dir.getClientDirectory();
  assert.equal(fetchCount, 1, "TTL-fresh read must not re-fetch");
  assert.equal(cached.blocks.length, 1, "cached bundle still served (old data)");

  // (b) force busts the TTL: re-fetches and serves the CHANGED data now.
  const forced = await dir.getClientDirectory({ force: true });
  assert.equal(fetchCount, 2, "force re-fetches despite fresh TTL");
  assert.equal(forced.blocks.length, 2, "forced bundle reflects the ClickUp edit");
  assert.ok(
    forced.blocks.some((b) => b.name === "New Client LLC"),
    "newly added client visible immediately after force",
  );
  assert.equal(dir.bundleIsLive(), true, "successful force → live");

  // (c) proof mode: a failed forced fetch throws (route → 502), never a
  // silent stale-serve masquerading as a refresh.
  failNextFetch = true;
  await assert.rejects(
    () => dir.getClientDirectory({ force: true, throwOnError: true }),
    /HTTP 500/,
    "force+throwOnError propagates the fetch failure",
  );
  assert.equal(dir.bundleIsLive(), false, "failed attempt flips liveness");
  // The stale bundle is still there for display reads.
  failNextFetch = false;
  const after = await dir.getClientDirectory();
  assert.ok(after.blocks.length >= 1, "display reads keep working after a failed force");

  dir.__testResetDirectoryCache();
  global.fetch = realFetch;
  console.log("ads-os-directory-force-refresh: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
