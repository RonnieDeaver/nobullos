/* test-registration
{
  "name": "client_semrush_integrations typed error_category (E-F16 typed-failure parity)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy focused suite for the Local Dominance typed failure classification on client_semrush_integrations (stamp on error, clear on recovery), exercising the real worker write path against the hermetic per-run DB; runs in the full suite and the nightly --regression sweep rather than the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
/**
 * E-F16 typed-failure parity — `client_semrush_integrations.error_category`.
 *
 * The integration rows historically persisted only raw `error_message`
 * text; #3966 adds a machine-readable `error_category` beside it (same
 * `classifyError` vocabulary as `semrush_location_sync_state`). This suite
 * pins:
 *  - a real worker error path stamps BOTH the raw text and the typed
 *    category (`syncSingleClient` with no mapped campaigns ⇒
 *    `invalid_mapping`);
 *  - the paused_auth recovery sweep clears the category together with the
 *    message (no stale classification after recovery);
 *  - representative `classifyError` mappings the integration writers rely
 *    on (tagged errors, auth-config strings, timeouts, 5xx).
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { syncSingleClient } from "../server/services/localDominanceSyncWorker";
import { recoverPausedAuthRows, classifyError } from "../server/services/semrushLocationSyncState";

const MARKER = `t_csi_cat_${process.pid}_${Date.now()}`;

let clientId = "";

async function seedClientWithIntegration(): Promise<void> {
  const cr = await workerDb.execute(sql`INSERT INTO clients (firm_name) VALUES (${`${MARKER} Firm`}) RETURNING id`);
  clientId = String((cr.rows?.[0] as any)?.id);
  await workerDb.execute(sql`
    INSERT INTO client_semrush_integrations (client_id, integration_enabled, sync_status)
    VALUES (${clientId}, true, 'idle')
  `);
}

async function readIntegrationRow(): Promise<any> {
  const r = await workerDb.execute(sql`
    SELECT sync_status, error_message, error_category, last_sync_outcome
    FROM client_semrush_integrations WHERE client_id = ${clientId}
  `);
  return r.rows?.[0] as any;
}

async function cleanup(): Promise<void> {
  if (clientId) {
    await workerDb.execute(sql`DELETE FROM client_semrush_integrations WHERE client_id = ${clientId}`);
    await workerDb.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  }
}

async function main(): Promise<void> {
  await seedClientWithIntegration();
  try {
    // ------------------------------------------------------------------
    // 1. Real worker error path stamps raw text + typed category.
    //    No campaign mapped anywhere ⇒ deterministic config failure.
    // ------------------------------------------------------------------
    {
      const result = await syncSingleClient(clientId, { origin: "user_manual" });
      assert.equal(result.success, false);
      assert.equal(result.error, "No Semrush campaigns mapped to locations");
      const row = await readIntegrationRow();
      assert.equal(row.sync_status, "error");
      assert.equal(row.error_message, "No Semrush campaigns mapped to locations", "human-readable detail preserved");
      assert.equal(row.error_category, "invalid_mapping", "typed machine-readable classification stamped beside the raw text");
      assert.equal(row.last_sync_outcome, "error");
      console.log("PASS: syncSingleClient no-mapping failure stamps error_category=invalid_mapping + raw error_message");
    }

    // ------------------------------------------------------------------
    // 2. paused_auth recovery clears the category with the message.
    // ------------------------------------------------------------------
    {
      await workerDb.execute(sql`
        UPDATE client_semrush_integrations
        SET sync_status = 'paused_auth',
            error_message = 'Semrush not connected — sweep paused until re-authorization via Integrations Hub',
            error_category = 'auth_config',
            last_sync_outcome = 'paused_auth'
        WHERE client_id = ${clientId}
      `);
      const { integrationRows } = await recoverPausedAuthRows();
      assert.ok(integrationRows >= 1, `recovery sweep clears the seeded paused_auth row (cleared ${integrationRows})`);
      const row = await readIntegrationRow();
      assert.equal(row.sync_status, "idle");
      assert.equal(row.error_message, null, "recovery clears the raw text");
      assert.equal(row.error_category, null, "recovery clears the typed category - no stale classification");
      console.log("PASS: recoverPausedAuthRows clears error_category together with error_message");
    }

    // ------------------------------------------------------------------
    // 3. Representative classifyError mappings the writers rely on.
    // ------------------------------------------------------------------
    {
      const tagged: any = new Error("boom");
      tagged.errorCategory = "rate_limit";
      assert.equal(classifyError(tagged), "rate_limit", "explicit errorCategory tag wins");
      assert.equal(
        classifyError(new Error("Semrush not connected — sweep paused until re-authorization via Integrations Hub")),
        "auth_config",
      );
      const abortish: any = new Error("The operation was aborted");
      abortish.name = "AbortError";
      assert.equal(classifyError(abortish), "timeout");
      assert.equal(classifyError(new Error("HTTP 503 from SEMrush API")), "server");
      assert.equal(classifyError(new Error("No Semrush campaigns... mapping not found")), "invalid_mapping");
      console.log("PASS: classifyError representative mappings");
    }

    console.log("ALL client_semrush_integrations error_category tests passed");
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("FAIL:", err);
    process.exit(1);
  },
);
