/* test-registration
{
  "name": "Google Ads stale-account prune — discovery flags REMOVED + list hides them (Task #2904)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2904: the inverse guard — discovery must PRUNE rows that disappeared from the MCC (flag REMOVED + disable sync) and the default customer list must hide them, or the account dropdown shows accounts that no longer exist. Real-DB seed + source pin on the discovery→prune wiring (non-empty guard so a failed discovery can never mass-flag live rows).",
  "scanPaths": [
    "server/services/googleAdsIntegration.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2904 — prune Google Ads accounts that disappeared from the MCC.
 *
 * Prod `google_ads_customers` had 102 rows while live MCC discovery returned
 * 97 — discovery upserts but never pruned, so the account dropdown showed
 * accounts that no longer exist. Discovery now flags rows absent from the
 * latest complete discovery set as `REMOVED` (and disables sync on them),
 * and `listGoogleAdsCustomers` hides those rows by default.
 *
 * Real-DB integration checks:
 *   1. `markGoogleAdsCustomersRemoved(activeIds)` flags exactly the rows NOT
 *      in the active set (REMOVED + sync_enabled=false) and returns the
 *      newly-pruned count (already-REMOVED rows are not re-counted).
 *   2. `listGoogleAdsCustomers()` hides REMOVED rows;
 *      `listGoogleAdsCustomers({ includeRemoved: true })` still shows them.
 *   3. Empty active set is a hard no-op (never mass-flags on a failed
 *      discovery).
 *   4. A re-appearing account is un-flagged by the discovery upsert (status
 *      overwritten with the live value) and shows in the list again.
 *
 * Source pins:
 *   5. `discoverAndUpsertCustomers` calls the prune with the discovered set,
 *      guarded on a non-empty discovery.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  GOOGLE_ADS_CUSTOMER_REMOVED_STATUS,
  listGoogleAdsCustomers,
  markGoogleAdsCustomersRemoved,
  upsertGoogleAdsCustomer,
} from "../server/storage/googleAdsStorage";
import { db } from "../server/db";
import { sql } from "drizzle-orm";

const SYNTH_PREFIX = "999029040"; // task-unique synthetic customer_id prefix
const ID_A = `${SYNTH_PREFIX}001`;
const ID_B = `${SYNTH_PREFIX}002`;
const ID_GONE = `${SYNTH_PREFIX}003`;

let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => {
      failed++;
      console.error(`  ✗ ${name}\n    ${err?.message}`);
    });
}

async function seed(customerId: string): Promise<void> {
  await upsertGoogleAdsCustomer({
    customerId,
    descriptiveName: `Synthetic prune fixture ${customerId}`,
    currencyCode: "USD",
    timeZone: "America/New_York",
    isManager: false,
    isTestAccount: true,
    status: "ENABLED",
  });
}

async function main() {
  const like = `${SYNTH_PREFIX}%`;
  const cleanup = () =>
    db.execute(
      sql`DELETE FROM google_ads_customers WHERE customer_id LIKE ${like}`,
    );
  try {
    await cleanup();
    await seed(ID_A);
    await seed(ID_B);
    await seed(ID_GONE);

    // The active set must include every non-synthetic row too, or this test
    // would flag REAL rows in the shared dev DB. Build it from the current
    // table contents minus the one synthetic row we want pruned.
    const allBefore = await listGoogleAdsCustomers({ includeRemoved: true });
    const activeIds = allBefore
      .map((c) => c.customerId)
      .filter((id) => id !== ID_GONE);

    await check(
      "prune flags exactly the missing row (REMOVED + sync disabled), count=1",
      async () => {
        const pruned = await markGoogleAdsCustomersRemoved(activeIds);
        assert.equal(pruned, 1);
        const all = await listGoogleAdsCustomers({ includeRemoved: true });
        const gone = all.find((c) => c.customerId === ID_GONE);
        assert.ok(gone, "pruned row still exists in the table");
        assert.equal(gone!.status, GOOGLE_ADS_CUSTOMER_REMOVED_STATUS);
        assert.equal(gone!.syncEnabled, false);
        const a = all.find((c) => c.customerId === ID_A);
        assert.equal(a!.status, "ENABLED", "active row untouched");
      },
    );

    await check(
      "already-REMOVED rows are not re-counted on the next pass",
      async () => {
        const prunedAgain = await markGoogleAdsCustomersRemoved(activeIds);
        assert.equal(prunedAgain, 0);
      },
    );

    await check(
      "listGoogleAdsCustomers hides REMOVED rows by default",
      async () => {
        const visible = await listGoogleAdsCustomers();
        assert.ok(
          !visible.some((c) => c.customerId === ID_GONE),
          "REMOVED row must not appear in the default list",
        );
        assert.ok(visible.some((c) => c.customerId === ID_A));
        assert.ok(visible.some((c) => c.customerId === ID_B));
      },
    );

    await check("empty active set is a hard no-op", async () => {
      const pruned = await markGoogleAdsCustomersRemoved([]);
      assert.equal(pruned, 0);
      const all = await listGoogleAdsCustomers({ includeRemoved: true });
      const a = all.find((c) => c.customerId === ID_A);
      assert.equal(a!.status, "ENABLED", "no-op must not flag live rows");
    });

    await check(
      "a re-appearing account is un-flagged by the discovery upsert",
      async () => {
        // Discovery upserts overwrite `status` with the live value.
        await seed(ID_GONE);
        const visible = await listGoogleAdsCustomers();
        const back = visible.find((c) => c.customerId === ID_GONE);
        assert.ok(back, "re-discovered row visible again");
        assert.equal(back!.status, "ENABLED");
      },
    );
  } finally {
    await cleanup();
  }

  // ---- Source pins -------------------------------------------------------
  const integration = readFileSync(
    "server/services/googleAdsIntegration.ts",
    "utf8",
  );
  await check(
    "discoverAndUpsertCustomers prunes with the discovered set (non-empty guard)",
    () => {
      const start = integration.indexOf(
        "export async function discoverAndUpsertCustomers",
      );
      assert.ok(start > 0);
      const body = integration.slice(start, start + 4000);
      assert.match(body, /discoveredIds\.length > 0/);
      assert.match(body, /markGoogleAdsCustomersRemoved\(discoveredIds\)/);
    },
  );

  if (failed > 0) throw new Error(`${failed} prune test(s) failed`);
  console.log("google-ads-customer-prune: all tests passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
