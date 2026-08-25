import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function run() {
  console.log("--- (1) Recent Rows in client_semrush_integrations where sync_status='error' ---");
  const integrationsFailed = await db.execute(sql`
    SELECT id, client_id, error_message, updated_at
    FROM client_semrush_integrations
    WHERE sync_status = 'error'
    ORDER BY updated_at DESC
  `);
  console.log(JSON.stringify(integrationsFailed.rows, null, 2));

  console.log("\n--- (1b) Distinct Error Types in client_semrush_integrations ---");
  const distinctErrorTypes = await db.execute(sql`
    SELECT error_message, COUNT(*) as count
    FROM client_semrush_integrations
    WHERE sync_status = 'error'
    GROUP BY error_message
    ORDER BY count DESC
  `);
  console.log(JSON.stringify(distinctErrorTypes.rows, null, 2));

  console.log("\n--- (2) Recent Rows in client_semrush_integrations where last_sync_outcome='partial_success' ---");
  const partials = await db.execute(sql`
    SELECT id, client_id, last_sync_summary, last_sync_outcome, updated_at
    FROM client_semrush_integrations
    WHERE last_sync_outcome = 'partial_success'
    ORDER BY updated_at DESC
  `);
  console.log(JSON.stringify(partials.rows, null, 2));

  console.log("\n--- (2b) Per-campaign failure/skip/stale flags from semrush_location_sync_state for partials ---");
  const partialCampaigns = await db.execute(sql`
    SELECT ss.client_id, ss.location_id, ss.campaign_id, ss.status, ss.last_error, ss.error_category, ss.imported_keyword_count, ss.expected_keyword_count, ss.updated_at
    FROM semrush_location_sync_state ss
    JOIN client_semrush_integrations ci ON ci.client_id = ss.client_id
    WHERE ci.last_sync_outcome = 'partial_success'
    ORDER BY ss.updated_at DESC
  `);
  console.log(JSON.stringify(partialCampaigns.rows, null, 2));

  console.log("\n--- (3) semrush_location_sync_state for recent failed attempts ---");
  const failedAttempts = await db.execute(sql`
    SELECT id, client_id, location_id, campaign_id, status, last_error, error_category, attempt_count, last_failed_at
    FROM semrush_location_sync_state
    WHERE status = 'failed'
    ORDER BY last_failed_at DESC
    LIMIT 20
  `);
  console.log(JSON.stringify(failedAttempts.rows, null, 2));
}

run().catch(console.error).finally(() => process.exit(0));
