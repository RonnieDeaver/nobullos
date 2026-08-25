// @db-pool-intent: api
//
// Task #2418: this file calls `getDb()`. The intent above declares the
// pool every `getDb()` call in this module is expected to land on — the
// request-scoped `api` pool, because the only caller is the
// GET /api/clients/:clientId/data-access/detection route handler. See
// `scripts/lint-db-pool-tenancy.ts` for the contract and `server/db.ts`
// for the routing.

/**
 * Advisory, best-effort per-client data-presence detection for the five
 * Data Access categories (Task #2418).
 *
 * The Data Access flags are manual-only, so the report's "Critical Missing
 * Data" warning used to flatly declare data unavailable even when records
 * were demonstrably flowing in. This helper reads ONLY already-ingested
 * local tables (no new external/BigQuery calls) and reports, per category,
 * whether data appears to be present. It NEVER changes a flag — the account
 * manager always confirms via "Mark Available".
 *
 * Every probe is a cheap, bounded `EXISTS`-style query so it respects the
 * DB-hold rules. Each category resolves to `present` / `absent` / `unknown`.
 */

import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import type {
  DataAccessCategory,
  DataAccessDetectionMap,
  DataAccessPresence,
} from "@shared/schema";

async function rowExists(label: string, query: ReturnType<typeof sql>): Promise<boolean> {
  return withDbAttribution(`data-access-detection:${label}`, async () => {
    const res: any = await getDb().execute(query);
    const rows = Array.isArray(res) ? res : res?.rows ?? [];
    return rows.length > 0;
  });
}

/**
 * Detect, per category, whether data appears to be flowing for `clientId`.
 *
 * - `follow_up_touches`  → any `raw_communication_records` for the client.
 * - `sales_transcripts`  → transcript-bearing Zoom `raw_communication_records`
 *                          (a Zoom source row with a ready transcript).
 * - `consult_bookings` / `no_show_rate` → presence of the client's
 *                          `scheduled_meetings` booking rows.
 * - `sales_conversions`  → presence of an already-computed local signal
 *                          (`ris_check_results`); if none exist we cannot
 *                          cheaply tell, so we return `unknown` and the
 *                          report falls back to the current manual behaviour.
 *
 * Each probe is defensive: a query that throws degrades that single
 * category to `unknown` rather than failing the whole request.
 */
export async function detectClientDataPresence(
  clientId: string,
): Promise<DataAccessDetectionMap> {
  const safe = async (
    fn: () => Promise<DataAccessPresence>,
  ): Promise<DataAccessPresence> => {
    try {
      return await fn();
    } catch {
      return "unknown";
    }
  };

  const [
    commPresent,
    transcriptPresent,
    bookingPresent,
    risPresent,
  ] = await Promise.all([
    safe(async () =>
      (await rowExists("comm", sql`
        SELECT 1 FROM raw_communication_records
        WHERE client_id = ${clientId}
        LIMIT 1
      `))
        ? "present"
        : "absent",
    ),
    safe(async () =>
      (await rowExists("transcript", sql`
        SELECT 1 FROM raw_communication_records
        WHERE client_id = ${clientId}
          AND source_type = 'zoom'
          AND transcript_status = 'ready'
        LIMIT 1
      `))
        ? "present"
        : "absent",
    ),
    safe(async () =>
      (await rowExists("booking", sql`
        SELECT 1 FROM scheduled_meetings
        WHERE client_id = ${clientId}
        LIMIT 1
      `))
        ? "present"
        : "absent",
    ),
    // sales_conversions: presence of any RIS check result is the only cheap
    // local signal. Absence does NOT mean "no conversion data" (RIS may not
    // be configured for the client), so absence degrades to `unknown`.
    safe(async () =>
      (await rowExists("ris", sql`
        SELECT 1 FROM ris_check_results
        WHERE client_id = ${clientId}
        LIMIT 1
      `))
        ? "present"
        : "unknown",
    ),
  ]);

  const map: Record<DataAccessCategory, DataAccessPresence> = {
    consult_bookings: bookingPresent,
    no_show_rate: bookingPresent,
    follow_up_touches: commPresent,
    sales_transcripts: transcriptPresent,
    sales_conversions: risPresent,
  };

  return map;
}
