/**
 * Task #1208 — Auto-clear the "campaign no longer in SEMrush" portion of
 * `clientSemrushIntegrations.warningMessage` once the operator has
 * reconfigured all stale mappings.
 *
 * The local-dominance sync worker stamps `warningMessage` with phrases like
 * "N campaign(s) marked stale" / "N stale" when one or more
 * `semrush_location_campaigns` rows are flipped to `isStale=true` (the
 * source SEMrush campaign returned 404). That warning lingers on the
 * integration row until the next full sync overwrites it — even when the
 * operator has already replaced the broken mapping in Settings or
 * un-staled it via the inventory apply pipeline.
 *
 * This helper short-circuits that latency: any code path that reconfigures
 * a stale mapping (mapping replaced via the PUT settings route, or
 * `isStale` flipped back to `false` via the inventory apply handler) calls
 * it after the write commits. If no stale rows remain on the integration
 * AND the warning text mentions "stale" (so we don't wipe unrelated
 * warnings such as "incomplete keyword inventory"), the warning is cleared
 * immediately.
 */
import { and, eq } from "drizzle-orm";
// Task #1573 (Audit Track C): periodic background cleanup — uses the worker
// pool so it doesn't consume request-pool capacity.
import { workerDb as defaultDb } from "../db";
import {
  clientSemrushIntegrations,
  semrushLocationCampaigns,
} from "@shared/schema";

type DbHandle =
  | typeof defaultDb
  | Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];

export type ClearStaleWarningOutcome =
  | "no_integration"
  | "no_stale_warning"
  | "stale_remaining"
  | "cleared";

export async function clearStaleWarningIfResolved(
  clientId: string,
  dbHandle: DbHandle = defaultDb,
): Promise<{ cleared: boolean; reason: ClearStaleWarningOutcome }> {
  const [integration] = await dbHandle
    .select({
      id: clientSemrushIntegrations.id,
      warningMessage: clientSemrushIntegrations.warningMessage,
    })
    .from(clientSemrushIntegrations)
    .where(eq(clientSemrushIntegrations.clientId, clientId))
    .limit(1);

  if (!integration) {
    return { cleared: false, reason: "no_integration" };
  }
  const warning = integration.warningMessage ?? "";
  // Match the specific stale-campaign phrasing the sync worker stamps
  // ("N campaign(s) marked stale"). Avoid plain /stale/ because unrelated
  // warnings like "stale-keyword cleanup skipped" also contain that
  // substring and must NOT be wiped here.
  if (!/marked stale/i.test(warning)) {
    return { cleared: false, reason: "no_stale_warning" };
  }

  const remaining = await dbHandle
    .select({ id: semrushLocationCampaigns.id })
    .from(semrushLocationCampaigns)
    .where(
      and(
        eq(semrushLocationCampaigns.clientId, clientId),
        eq(semrushLocationCampaigns.isStale, true),
      ),
    )
    .limit(1);
  if (remaining.length > 0) {
    return { cleared: false, reason: "stale_remaining" };
  }

  await dbHandle
    .update(clientSemrushIntegrations)
    .set({ warningMessage: null, updatedAt: new Date() })
    .where(eq(clientSemrushIntegrations.id, integration.id));

  console.log(
    `[SemrushStaleWarning] Cleared stale warning for client=${clientId} (no stale mappings remain)`,
  );
  return { cleared: true, reason: "cleared" };
}
