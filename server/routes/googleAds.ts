/**
 * Task #1759 / reshaped by Task #4008 — Google Ads integration routes.
 *
 * Unified single-credential model: every Google Ads surface mints via the
 * shared env-trio path (see `adsOs/googleAdsClient.getEnvAccessToken`), so
 * there is no in-app OAuth flow anymore — the old authorize / callback /
 * disconnect routes are gone with the retired `google_ads_connection` row.
 * Credential rotation is a secrets edit + restart (GOOGLE_ADS.md runbook).
 *
 * Remaining surface: status (env + auth-snapshot derived, never a token
 * POST), customer list / discover / mapping, sync-now, sync-runs. Write
 * endpoints require Team Lead; read endpoints require Account Manager.
 */

import type { Express } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireAccountManager, requireTeamLead } from "./middleware";
import {
  isGoogleAdsConfigured,
  discoverAndUpsertCustomers,
} from "../services/googleAdsIntegration";
import {
  listGoogleAdsCustomers,
  listRecentGoogleAdsSyncRuns,
  updateGoogleAdsCustomerMapping,
} from "../storage/googleAdsStorage";
import { buildGoogleAdsOsLaneSummary } from "../services/integrationStatusLoaders";
import { runGoogleAdsSync } from "../services/googleAdsSync";
import {
  googleAdsSyncSkipAuthDeadError,
  respondGoogleAdsDisconnected,
} from "./googleAdsDisconnected";

export function registerGoogleAdsRoutes(app: Express): void {
  app.get(
    "/api/integrations/google-ads/status",
    isAuthenticated,
    async (_req, res) => {
      try {
        // Task #4008 — status is derived from env presence + the shared
        // env-trio mint's in-process auth snapshot + store freshness. This
        // path NEVER POSTs to Google's token endpoint (Task #4000
        // invariant): a dead credential is only ever discovered by a real
        // pull/sync, and the 5-min negative cache carries it here.
        const configured = isGoogleAdsConfigured();
        const lane = await buildGoogleAdsOsLaneSummary();
        return res.json({
          configured,
          connected: configured && lane.health !== "token_rejected",
          loginCustomerId:
            process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/[^0-9]/g, "") ??
            null,
          adsOs: lane,
        });
      } catch (error: any) {
        // Task #2807 — a THROWN read here is a transient failure, NOT a
        // confirmed "not configured / disconnected". Confirmed-empty vs
        // read-threw stay distinct: a failed read surfaces as an explicit
        // status-unknown 503 the client can treat as last-known-good.
        // `isGoogleAdsConfigured()` is env-only and cannot throw, so it is
        // still answered definitively.
        console.error("[GoogleAds] /status error:", error?.message || error);
        res.status(503).json({
          statusUnknown: true,
          probeFailed: true,
          configured: isGoogleAdsConfigured(),
          connected: null,
          reason: String(error?.message ?? error).slice(0, 200),
        });
      }
    },
  );

  app.get(
    "/api/integrations/google-ads/customers",
    isAuthenticated,
    requireAccountManager,
    async (_req, res) => {
      try {
        const customers = await listGoogleAdsCustomers();
        res.json({ customers });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/api/integrations/google-ads/customers/discover",
    isAuthenticated,
    requireTeamLead,
    async (_req, res) => {
      try {
        const upserted = await discoverAndUpsertCustomers();
        const customers = await listGoogleAdsCustomers();
        res.json({ upserted, customers });
      } catch (error: any) {
        // Task #2797 — auth-dead credential → the same structured 503 the
        // Ads Hygiene pages render as a rotate-credentials banner
        // (presentation only, no state writes; same contract as Task #2794).
        if (respondGoogleAdsDisconnected(res, error)) return;
        console.error("[GoogleAds] Discovery error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.patch(
    "/api/integrations/google-ads/customers/:customerId",
    isAuthenticated,
    requireTeamLead,
    async (req, res) => {
      try {
        const { customerId } = req.params;
        const { nobullClientId, syncEnabled } = req.body ?? {};
        const patch: { nobullClientId?: string | null; syncEnabled?: boolean } =
          {};
        if (nobullClientId !== undefined) {
          patch.nobullClientId =
            nobullClientId === null || nobullClientId === ""
              ? null
              : String(nobullClientId);
        }
        if (typeof syncEnabled === "boolean") patch.syncEnabled = syncEnabled;
        const updated = await updateGoogleAdsCustomerMapping(customerId, patch);
        if (!updated) return res.status(404).json({ error: "Customer not found" });
        res.json({ customer: updated });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/api/integrations/google-ads/sync-now",
    isAuthenticated,
    requireTeamLead,
    async (_req, res) => {
      try {
        const summary = await runGoogleAdsSync();
        // Task #2797 — a dead/missing credential makes runGoogleAdsSync
        // RETURN a skipped summary (never throw), which used to toast
        // "Synced 0 customer(s)". Map the credential-level skip reasons to
        // the shared structured 503 so the operator sees the rotate-secrets
        // message instead. Other skip reasons (overlap, kill switches) keep
        // the plain summary — editing secrets would not fix them.
        if (summary.skipped) {
          const authDead = googleAdsSyncSkipAuthDeadError(summary.reason);
          if (authDead && respondGoogleAdsDisconnected(res, authDead)) {
            return;
          }
        }
        // UI naming contract: customersSynced / campaignsSynced /
        // keywordsSynced. Backend uses the more precise *Upserted
        // suffix. Translate at the route boundary so both sides stay
        // self-consistent.
        res.json({
          ...summary,
          customersSynced: summary.customersProcessed,
          campaignsSynced: summary.campaignsUpserted,
          campaignStatsSynced: summary.campaignStatsUpserted,
          keywordsSynced: summary.keywordStatsUpserted,
        });
      } catch (error: any) {
        // Task #2797 — same auth-dead → structured 503 mapping as above.
        if (respondGoogleAdsDisconnected(res, error)) return;
        console.error("[GoogleAds] Sync-now error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get(
    "/api/integrations/google-ads/sync-runs",
    isAuthenticated,
    requireAccountManager,
    async (req, res) => {
      try {
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 200));
        const runs = await listRecentGoogleAdsSyncRuns(limit);
        // Translate to the UI-facing contract: `success` (not `succeeded`)
        // for the status enum, and `campaignsSynced` / `keywordsSynced`
        // for the count fields. Originals are preserved on the row so
        // operator debugging can still see the raw values.
        res.json({
          runs: runs.map((r: any) => ({
            ...r,
            status: r.status === "succeeded" ? "success" : r.status,
            campaignsSynced: r.campaignsUpserted ?? 0,
            campaignStatsSynced: r.campaignStatsUpserted ?? 0,
            keywordsSynced: r.keywordStatsUpserted ?? 0,
          })),
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );
}
