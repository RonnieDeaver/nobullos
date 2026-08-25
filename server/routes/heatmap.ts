import type { Express } from "express";
import { db, withDbAttribution } from "../db";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { isAuthenticated } from "../middlewares/requireAuth";
import { bindArrayParam } from "../utils/sqlArray";
import { requireCommandCenterAccess, requireAccountManager, requireTeamLead } from "./middleware";
import type { ValidatedBodyRequest } from "./requestContext";
  import {
    clients,
    clientLocations,
    clientSemrushIntegrations,
    semrushLocationCampaigns,
    heatmapSnapshots,
    heatmapMetrics,
  } from "@shared/schema";

  // Task #2270 — test-only seam for the SEMrush auto-match review/suggestion
  // branch. That branch fires when a candidate location is present in the
  // in-memory `locations` snapshot taken by the "fetch" phase but is gone
  // from `client_locations` by the time the persist helper re-reads it. No
  // in-request barrier exists between those two phases, so a deterministic
  // test injects this hook to mutate the parent row in that exact gap. The
  // hook is null in production; the setter throws outside tests.
  let __autoMatchAfterFetchHookForTest: (() => Promise<void>) | null = null;
  export function __setAutoMatchAfterFetchHookForTest(
    hook: (() => Promise<void>) | null,
  ): void {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("__setAutoMatchAfterFetchHookForTest is test-only");
    }
    __autoMatchAfterFetchHookForTest = hook;
  }

  export function registerHeatmapRoutes(app: Express) {
    // ============================================
  // HEATMAP PUBLIC ROUTES (no auth - for shared reports)
  // ============================================

  app.get("/api/public/heatmaps/:snapshotId/geojson", async (req, res) => {
    try {
      const { getSnapshotGeoJSON } = await import("../services/heatmapService");
      // Task #4290 — these endpoints are unauthenticated (shared reports
      // fetch them from the browser), so a snapshot referenced by ANY
      // privacy-mode report must serve a masked business pin: its `name`
      // property renders as an on-map text label. Fails CLOSED (masks) on
      // lookup errors.
      const { isSnapshotPrivacyBound, maskPublicGeoJSONForPrivacy } = await import(
        "../services/reportPrivacyMasking"
      );
      const mode = (req.query.mode === "movement" ? "movement" : "rank") as "rank" | "movement";
      const [geojson, privacyBound] = await Promise.all([
        getSnapshotGeoJSON(req.params.snapshotId, mode),
        isSnapshotPrivacyBound(req.params.snapshotId),
      ]);
      if (!geojson) {
        return res.status(404).json({ error: "Snapshot not found" });
      }
      res.json(privacyBound ? maskPublicGeoJSONForPrivacy(geojson) : geojson);
    } catch (error) {
      console.error("[Heatmap] Public GeoJSON error:", error);
      res.status(500).json({ error: "Failed to generate GeoJSON" });
    }
  });

  app.get("/api/public/heatmaps/:snapshotId/meta", async (req, res) => {
    try {
      const { getSnapshot, getSnapshotMetrics } = await import("../services/heatmapService");
      // Task #4290 — mask identifying names (location/business/keyword +
      // vendor reference ids) when the snapshot belongs to a privacy-mode
      // report. Coordinates/grid geometry stay: the map cannot render
      // without them (documented residual in the privacy checklist).
      const { isSnapshotPrivacyBound, maskPublicSnapshotMetaForPrivacy } = await import(
        "../services/reportPrivacyMasking"
      );
      const [snapshot, privacyBound] = await Promise.all([
        getSnapshot(req.params.snapshotId),
        isSnapshotPrivacyBound(req.params.snapshotId),
      ]);
      if (!snapshot) {
        return res.status(404).json({ error: "Snapshot not found" });
      }
      const metrics = await getSnapshotMetrics(req.params.snapshotId);
      const served = { ...snapshot, rawPayload: undefined, geojsonCache: undefined };
      res.json({
        snapshot: privacyBound ? maskPublicSnapshotMetaForPrivacy(served) : served,
        metrics,
      });
    } catch (error) {
      console.error("[Heatmap] Public meta error:", error);
      res.status(500).json({ error: "Failed to fetch snapshot meta" });
    }
  });

  // ============================================
  // SEMRUSH API ROUTES
  // ============================================

  app.get("/api/semrush/status", isAuthenticated, async (req: any, res) => {
    try {
      // Task #1975 — Thin wrapper over the shared cached probe used by
      // /api/integrations/all-status. Both routes read the same cache
      // entry, so preserve semantics (transient 5xx keeps the last-known
      // connected state and surfaces lastProbeError) apply uniformly —
      // the Hub badge and this endpoint can no longer disagree on a
      // probe blip. Device-flow `pendingAuth` / `expired` are still read
      // from settings directly because the probe doesn't know about them.
      const semrushMod = await import("../services/semrushApi");
      const cacheMod = await import("../services/integrationStatusCache");
      const storageMod = await import("../storage");
      const cached = await cacheMod.getCachedIntegrationStatus<{
        connected: boolean;
        disconnectReason: string | null;
      }>("semrush", semrushMod.semrushCachedProbeLoader, { freshTtlMs: 60_000 });

      const connected = cached.value?.connected === true;
      // Task #3670 — v4 API-key mode: the probe behind the cache is already
      // key-based; the device-flow expired/pendingAuth sub-states never
      // apply, so short-circuit before reading stale OAuth settings.
      const authModeMod = await import("../services/semrushAuthMode");
      if (authModeMod.isSemrushKeyMode()) {
        res.json({
          configured: connected,
          connected,
          expired: false,
          pendingAuth: undefined,
          disconnectReason: cached.value?.disconnectReason ?? null,
          lastProbeError: cached.lastProbeError,
          lastCheckedAt: cached.lastCheckedAt,
          authMode: "api_key",
          keyModeLastSuccessAt: await authModeMod.getSemrushKeyModeLastSuccessAt(),
        });
        return;
      }
      const [expiresSetting, deviceCodeSetting, userCodeSetting, verifyUriSetting, deviceExpiresSetting] =
        await Promise.all([
          storageMod.storage.getSystemSetting("semrush_token_expires_at"),
          storageMod.storage.getSystemSetting("semrush_device_code"),
          storageMod.storage.getSystemSetting("semrush_user_code"),
          storageMod.storage.getSystemSetting("semrush_verification_uri"),
          storageMod.storage.getSystemSetting("semrush_device_expires_at"),
        ]);
      const expired =
        !connected &&
        !!expiresSetting?.value &&
        Date.now() > parseInt(expiresSetting.value) - 60_000;
      let pendingAuth: { userCode: string; verificationUri: string } | undefined;
      if (
        !connected &&
        deviceCodeSetting?.value &&
        userCodeSetting?.value &&
        deviceExpiresSetting?.value &&
        Date.now() < parseInt(deviceExpiresSetting.value)
      ) {
        pendingAuth = {
          userCode: userCodeSetting.value,
          verificationUri: verifyUriSetting?.value || "https://oauth.semrush.com/device",
        };
      }

      res.json({
        configured: connected,
        connected,
        expired,
        pendingAuth,
        disconnectReason: cached.value?.disconnectReason ?? null,
        lastProbeError: cached.lastProbeError,
        lastCheckedAt: cached.lastCheckedAt,
        authMode: "oauth",
      });
    } catch (err: any) {
      // Task #2811 — the cached probe layer already preserves last-known-good,
      // but a thrown read HERE (cache layer itself, or the device-flow
      // settings reads) is a transient failure, NOT a confirmed disconnect.
      // The old catch answered `configured: false, connected: false`, which
      // flashed "Not Connected" on a DB blip. Mirror the Google Ads route
      // (Task #2807): explicit status-unknown 503.
      console.error("[Semrush /status] failed:", err?.message ?? err);
      res.status(503).json({
        statusUnknown: true,
        probeFailed: true,
        configured: null,
        connected: null,
        expired: null,
        reason: String(err?.message ?? err).slice(0, 200),
      });
    }
  });

  app.post("/api/semrush/authorize", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { startDeviceAuthorization } = await import("../services/semrushApi");
      const result = await startDeviceAuthorization();
      res.json(result);
    } catch (error: any) {
      console.error("[Semrush] Device auth error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/semrush/poll-token", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { pollDeviceToken } = await import("../services/semrushApi");
      const result = await pollDeviceToken();
      res.json(result);
    } catch (error: any) {
      console.error("[Semrush] Token poll error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/semrush/disconnect", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { disconnect } = await import("../services/semrushApi");
      const userId = req.user?.claims?.sub || req.user?.id || null;
      await disconnect(userId ?? undefined, { trigger: "manual_disconnect" });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/semrush/campaigns/clear-cache", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const { clearCampaignCache } = await import("../services/semrushApi");
      clearCampaignCache();
      res.json({ success: true, message: "Campaign cache cleared. Next request will fetch fresh data." });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Failed to clear cache" });
    }
  });

  // Task #2185: force an immediate, cache-bypassing re-fetch + enrichment of
  // the SEMrush campaign list so brand-new campaigns (created after the last
  // background cache cycle) become available without waiting for the hourly
  // background refresh. Unlike clear-cache, this synchronously re-pages SEMrush
  // and enriches before returning, so the response carries the fresh list.
  app.post("/api/semrush/campaigns/refresh", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const { forceRefreshCampaigns } = await import("../services/semrushApi");
      const result = await forceRefreshCampaigns();
      res.json({ status: "ready", campaigns: result.campaigns, count: result.count });
    } catch (error: any) {
      const msg = error?.message || "Failed to refresh campaigns";
      const msgLower = msg.toLowerCase();
      const isAuthError = msgLower.includes("not connected") || msgLower.includes("re-authorize") || msgLower.includes("token expired");
      console.error("[Semrush] Campaign force-refresh error:", msg);
      res.status(isAuthError ? 401 : 500).json({ error: msg });
    }
  });

  app.get("/api/semrush/campaigns", isAuthenticated, async (req: any, res) => {
    try {
      const { listCampaigns, isEnrichmentComplete } = await import("../services/semrushApi");
      const query = typeof req.query.q === "string" ? req.query.q : undefined;

      const campaigns = await listCampaigns(query);

      const status = isEnrichmentComplete() ? "ready" : "enriching";
      res.json({ status, campaigns });
    } catch (error: any) {
      console.error("[Semrush] Campaign list error:", error?.message || error);
      const msg = error?.message || "";
      const isAuthError = msg.includes("not connected") || msg.includes("re-authorize") || msg.includes("token expired");
      res.status(isAuthError ? 401 : 500).json({ error: msg });
    }
  });

  app.get("/api/semrush/campaigns/:campaignId", isAuthenticated, async (req: any, res) => {
    try {
      const { getCampaign } = await import("../services/semrushApi");
      const campaign = await getCampaign(req.params.campaignId);
      res.json(campaign);
    } catch (error: any) {
      console.error("[Semrush] Campaign detail error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/semrush/campaigns/:campaignId/keywords", isAuthenticated, async (req: any, res) => {
    try {
      // Task #1973: surface `inventoryStatus` alongside the keyword list so
      // the report-UI tile can degrade gracefully ("refreshing" or
      // "incomplete") instead of rendering a partial list as canonical.
      const { getCampaignKeywordsWithMeta, getCachedKeywordInventoryMeta } =
        await import("../services/semrushApi");
      const cached = getCachedKeywordInventoryMeta(req.params.campaignId);
      const meta = await getCampaignKeywordsWithMeta(req.params.campaignId);
      const inventoryStatus: "complete" | "incomplete" | "refreshing" =
        meta.complete ? "complete" : (cached && !cached.complete ? "incomplete" : "refreshing");
      // Preserve the historical wire shape (array body) when no client
      // opt-in is set, but allow `?withMeta=1` consumers to ask for the
      // wrapped response that carries `inventoryStatus`.
      if (req.query?.withMeta) {
        res.json({
          keywords: meta.keywords,
          inventoryStatus,
          incompleteReason: meta.incompleteReason ?? null,
        });
      } else {
        res.set("X-Semrush-Inventory-Status", inventoryStatus);
        if (meta.incompleteReason) {
          res.set("X-Semrush-Inventory-Incomplete-Reason", meta.incompleteReason);
        }
        res.json(meta.keywords);
      }
    } catch (error: any) {
      console.error("[Semrush] Keywords error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/semrush/campaigns/:campaignId/fetch-heatmap", isAuthenticated, async (req: any, res) => {
    try {

      const { campaignId } = req.params;
      const { keywordId, cid, placeIds, reportMonth, clientId } = req.body;
      if (!keywordId) return res.status(400).json({ error: "keywordId is required" });

      // Task #1785: mark client active so the demand-driven gate keeps
      // refreshing this client's data. Best-effort, never blocks.
      if (clientId && typeof clientId === "string") {
        try {
          const { markClientViewed } = await import("../services/semrushCadenceGate");
          void markClientViewed(clientId, "heatmap:fetch_heatmap");
        } catch {}
      }

      const { getHeatmapData, getCampaign, findBestReportDate } = await import("../services/semrushApi");

      const campaign = await getCampaign(campaignId);

      const opts: { cid?: string; placeIds?: string[]; reportDate?: string } = {};
      const campaignCid = cid || campaign.business?.cid || campaign.cid;
      const campaignPlaceIds = placeIds?.length ? placeIds : (campaign.business?.placeIds || campaign.placeIds);
      if (campaignCid) opts.cid = campaignCid;
      if (campaignPlaceIds?.length) opts.placeIds = campaignPlaceIds;

      let selectedReportDate: string | null = null;
      let dateMatchType: "exact_month" | "prior_fallback" | "latest_fallback" | "no_month_provided" = "no_month_provided";

      if (reportMonth && typeof reportMonth === "string" && /^\d{4}-\d{2}$/.test(reportMonth)) {
        if (campaign.reportDates?.length) {
          selectedReportDate = findBestReportDate(campaign.reportDates, reportMonth);
          if (selectedReportDate) {
            const [year, month] = reportMonth.split("-").map(Number);
            const startOfMonth = new Date(year, month - 1, 1).getTime();
            const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999).getTime();
            const selectedTs = new Date(selectedReportDate).getTime();
            dateMatchType = (selectedTs >= startOfMonth && selectedTs <= endOfMonth) ? "exact_month" : "prior_fallback";
            opts.reportDate = selectedReportDate;
          } else {
            dateMatchType = "latest_fallback";
          }
        } else {
          dateMatchType = "latest_fallback";
        }
      }

      if (!opts.reportDate) {
        if (campaign.reportDates && Array.isArray(campaign.reportDates) && campaign.reportDates.length > 0) {
          opts.reportDate = campaign.reportDates[0];
          if (!selectedReportDate) selectedReportDate = opts.reportDate ?? null;
        } else {
          // Task #2493: a brand-new campaign that hasn't run its first
          // scheduled scan has an empty reportDates. Return a distinct,
          // machine-readable signal (plus the campaign's own schedule) so the
          // picker can say "no scans yet" and steer to manual upload instead of
          // surfacing a generic connection error.
          const { buildNoReportDatesPayload } = await import(
            "../services/heatmapFetchReason"
          );
          return res.status(422).json(buildNoReportDatesPayload(campaign));
        }
      }

      // Task #2893 — per-keyword report-date fallback: if the chosen date
      // 400s with SEMrush's "wasn't collected" error for this keyword, retry
      // against other campaign report dates (bounded) before giving up.
      const { fetchHeatmapWithDateFallback } = await import("../services/heatmapReportDateFallback");
      const { reportDate: chosenReportDate, ...baseOpts } = opts;
      // Best-effort display name so the friendly all-dates-failed message
      // says the keyword text, not its opaque id.
      let keywordDisplayName = keywordId;
      try {
        const { getCampaignKeywords } = await import("../services/semrushApi");
        const kws = await getCampaignKeywords(campaignId);
        const match = kws?.find((k: { id: string; name?: string }) => k.id === keywordId);
        if (match?.name) keywordDisplayName = match.name;
      } catch {}
      const { result: heatmapResult, usedFallback, reportDateUsed } =
        await fetchHeatmapWithDateFallback({
          fetchAtDate: (reportDate) =>
            getHeatmapData(campaignId, keywordId, { ...baseOpts, reportDate }),
          selectedReportDate: chosenReportDate!,
          reportDates: campaign.reportDates || [],
          reportMonth: typeof reportMonth === "string" ? reportMonth : null,
          keywordName: keywordDisplayName,
        });
      if (usedFallback) {
        console.log(`[Semrush] Fetch heatmap: keyword ${keywordId} had no data at ${chosenReportDate}; used fallback report date ${reportDateUsed}`);
        dateMatchType = "prior_fallback";
      }

      const gridSettings = campaign.gridSettings || {};
      const basePoint = gridSettings.basePoint || {};
      const businessLat = campaign.businessLat || basePoint.lat || 0;
      const businessLng = campaign.businessLng || basePoint.lng || 0;

      const importPayload = {
        // Task #4054 — carry the operator's client context into the snapshot
        // so it is born linked (importHeatmap resolves via the campaign
        // mapping when this is absent).
        clientId: typeof clientId === "string" && clientId ? clientId : undefined,
        locationId: campaign.locationId || campaignId,
        locationName: campaign.businessName || campaign.name || "Semrush Campaign",
        businessName: campaign.businessName,
        campaignId,
        keywordId: heatmapResult.keyword.id,
        keywordName: heatmapResult.keyword.name,
        reportDate: heatmapResult.date,
        businessLat,
        businessLng,
        gridTemplate: gridSettings.template || "7x7",
        gridUnit: gridSettings.unit || "KM",
        gridDistance: gridSettings.distance || 1,
        baseLat: basePoint.lat || businessLat,
        baseLng: basePoint.lng || businessLng,
        points: heatmapResult.positions.map((p: any) => ({
          id: p.point.id,
          lat: p.point.lat,
          lng: p.point.lng,
          position: p.rank,
          diff: p.diff,
        })),
        campaignReportDates: campaign.reportDates || [],
        cid: campaignCid,
        placeIds: campaignPlaceIds,
      };

      const { importHeatmap } = await import("../services/heatmapService");
      const result = await importHeatmap(importPayload);
      // Task #1973: report inventory status so the tile can distinguish
      // a real "SEMrush disconnected" failure from a "keyword inventory
      // still loading / last fetch incomplete" state. The UI today reads
      // the latter as a connection error; this field lets it render a
      // soft "refreshing" affordance instead.
      let inventoryStatus: "complete" | "incomplete" | "refreshing" = "complete";
      let inventoryIncompleteReason: string | null = null;
      try {
        const { getCachedKeywordInventoryMeta } = await import("../services/semrushApi");
        const meta = getCachedKeywordInventoryMeta(campaignId);
        if (meta) {
          inventoryStatus = meta.complete ? "complete" : "incomplete";
          inventoryIncompleteReason = meta.incompleteReason ?? null;
        } else {
          inventoryStatus = "refreshing";
        }
      } catch {}
      res.json({
        ...result,
        semrushReportDate: heatmapResult.date,
        requestedReportDate: selectedReportDate || null,
        dateMatchType,
        availableReportDates: campaign.reportDates || [],
        inventoryStatus,
        inventoryIncompleteReason,
      });
    } catch (error: any) {
      console.error("[Semrush] Fetch heatmap error:", error);
      // Task #2893 — all candidate report dates lacked data for this keyword:
      // surface a distinct, plain-language signal instead of a raw 500.
      if (error?.code === "keyword_not_collected") {
        return res.status(422).json({ error: error.message, code: error.code });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/semrush/campaigns/:campaignId/fetch-all-heatmaps", isAuthenticated, async (req: any, res) => {
    try {
      const { campaignId } = req.params;
      const { reportMonth, clientId } = req.body;

      // Task #1785: mark client active when an operator opens the
      // full-grid view for a campaign. Resolves clientId from the
      // mapping table when the caller doesn't pass it explicitly.
      // Task #4054: the resolved client is also threaded into each keyword's
      // import payload below so new snapshots are born with their client link.
      let bulkResolvedClientId: string | null = null;
      try {
        const { markClientViewed, resolveClientIdForCampaign } = await import(
          "../services/semrushCadenceGate"
        );
        let resolvedClientId: string | null = typeof clientId === "string" ? clientId : null;
        if (!resolvedClientId) {
          const m = await resolveClientIdForCampaign([campaignId]);
          resolvedClientId = m.get(campaignId) ?? null;
        }
        if (resolvedClientId) {
          bulkResolvedClientId = resolvedClientId;
          void markClientViewed(resolvedClientId, "heatmap:fetch_all_heatmaps");
        }
      } catch {}

      const { getHeatmapData, getCampaign, getCampaignKeywords, findBestReportDate } = await import("../services/semrushApi");
      const { importHeatmap } = await import("../services/heatmapService");
      // Task #2893 — per-keyword report-date fallback when SEMrush has no
      // collection for a keyword at the campaign-level date.
      const { fetchHeatmapWithDateFallback } = await import("../services/heatmapReportDateFallback");

      const campaign = await getCampaign(campaignId);
      const keywords = await getCampaignKeywords(campaignId);
      const activeKeywords = keywords.filter(kw => kw.status === "COLLECTED" || kw.status === "UNKNOWN");

      if (activeKeywords.length === 0) {
        return res.status(400).json({ error: "No active keywords found for this campaign" });
      }

      const gridSettings = campaign.gridSettings || {};
      const basePoint = gridSettings.basePoint || {};
      const businessLat = campaign.businessLat || basePoint.lat || 0;
      const businessLng = campaign.businessLng || basePoint.lng || 0;
      const campaignCid = campaign.business?.cid || campaign.cid;
      const campaignPlaceIds = campaign.business?.placeIds || campaign.placeIds;

      let selectedReportDate: string | null = null;
      if (reportMonth && typeof reportMonth === "string" && /^\d{4}-\d{2}$/.test(reportMonth)) {
        if (campaign.reportDates?.length) {
          selectedReportDate = findBestReportDate(campaign.reportDates, reportMonth);
        }
      }

      if (!selectedReportDate) {
        if (campaign.reportDates && Array.isArray(campaign.reportDates) && campaign.reportDates.length > 0) {
          selectedReportDate = campaign.reportDates[0];
        } else {
          return res.status(400).json({ error: "No report dates available for this campaign. The campaign may not have collected data yet." });
        }
      }

      const results: Array<{
        snapshotId: string;
        keywordId: string;
        keywordName: string;
        pointCount: number;
        semrushReportDate: string;
      }> = [];
      const errors: Array<{ keywordId: string; keywordName: string; error: string }> = [];

      for (const kw of activeKeywords) {
        try {
          const opts: { cid?: string; placeIds?: string[] } = {};
          if (campaignCid) opts.cid = campaignCid;
          if (campaignPlaceIds?.length) opts.placeIds = campaignPlaceIds;

          // Task #2893 — if the chosen campaign-level date 400s with SEMrush's
          // "wasn't collected" error for THIS keyword, retry against other
          // campaign report dates (bounded) instead of failing the keyword.
          const { result: heatmapResult, usedFallback, reportDateUsed } =
            await fetchHeatmapWithDateFallback({
              fetchAtDate: (reportDate: string) =>
                getHeatmapData(campaignId, kw.id, { ...opts, reportDate }),
              selectedReportDate: selectedReportDate!,
              reportDates: campaign.reportDates || [],
              reportMonth: typeof reportMonth === "string" ? reportMonth : null,
              keywordName: kw.name,
            });
          if (usedFallback) {
            console.log(`[Semrush] Bulk fetch: keyword "${kw.name}" had no data at ${selectedReportDate}; used fallback report date ${reportDateUsed}`);
          }

          const importPayload = {
            // Task #4054 — snapshots are born with their client link
            // (importHeatmap resolves via the campaign mapping when absent).
            clientId: bulkResolvedClientId ?? undefined,
            locationId: campaign.locationId || campaignId,
            locationName: campaign.businessName || campaign.name || "Semrush Campaign",
            businessName: campaign.businessName,
            campaignId,
            keywordId: heatmapResult.keyword.id,
            keywordName: heatmapResult.keyword.name || kw.name,
            reportDate: heatmapResult.date,
            businessLat,
            businessLng,
            gridTemplate: gridSettings.template || "7x7",
            gridUnit: gridSettings.unit || "KM",
            gridDistance: gridSettings.distance || 1,
            baseLat: basePoint.lat || businessLat,
            baseLng: basePoint.lng || businessLng,
            points: heatmapResult.positions.map((p: any) => ({
              id: p.point.id,
              lat: p.point.lat,
              lng: p.point.lng,
              position: p.rank,
              diff: p.diff,
            })),
            campaignReportDates: campaign.reportDates || [],
            cid: campaignCid,
            placeIds: campaignPlaceIds,
          };

          const result = await importHeatmap(importPayload);
          results.push({
            snapshotId: result.snapshotId,
            keywordId: kw.id,
            keywordName: heatmapResult.keyword.name || kw.name,
            pointCount: result.pointCount,
            semrushReportDate: heatmapResult.date,
          });

        } catch (kwErr: any) {
          console.error(`[Semrush] Bulk fetch: keyword "${kw.name}" failed:`, kwErr.message);
          errors.push({ keywordId: kw.id, keywordName: kw.name, error: kwErr.message });
        }
      }

      res.json({
        results,
        errors,
        totalKeywords: activeKeywords.length,
        successCount: results.length,
        errorCount: errors.length,
      });
    } catch (error: any) {
      console.error("[Semrush] Bulk fetch all heatmaps error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // SEMRUSH INVENTORY SYNC & REPORT-DRIVEN REFRESH
  // ============================================

  app.get("/api/semrush/inventory/status", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { getInventoryState } = await import("../services/semrushInventorySync");
      const state = getInventoryState();
      res.json({
        isRunning: state.isRunning,
        flags: state.flags,
        hasPreviousInventory: !!state.previousInventory,
        campaignCount: state.previousInventory?.campaigns.length ?? 0,
        lastFetchedAt: state.previousInventory?.fetchedAt ?? null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/semrush/inventory/campaigns", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { getInventoryState } = await import("../services/semrushInventorySync");
      const state = getInventoryState();
      if (!state.previousInventory) {
        return res.json({ campaigns: [], fetchedAt: null });
      }
      res.json({
        campaigns: state.previousInventory.campaigns,
        fetchedAt: state.previousInventory.fetchedAt,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/semrush/inventory/sync", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { PERF } = await import("../perfConfig");
      if (!PERF.SEMRUSH_INVENTORY_SYNC_ENABLED) {
        return res.status(400).json({ error: "Semrush inventory sync is disabled. Set SEMRUSH_INVENTORY_SYNC_ENABLED=true to enable." });
      }
      const { runInventorySync } = await import("../services/semrushInventorySync");
      const { withClassSlot } = await import("../services/workloadManager");
      const outcome = await withClassSlot(
        "semrush_inventory_sync",
        () => runInventorySync(),
        { origin: "user_manual" },
      );
      if (!outcome.acquired) {
        return res.status(429).json({ error: "Too many operations running. Try again shortly." });
      }
      res.json(outcome.result);
    } catch (error: any) {
      console.error("[Semrush] Manual inventory sync error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/semrush/heatmaps/backfill", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { backfillLocationHeatmaps } = await import("../services/semrushInventorySync");
      const {
        clientIds,
        locationIds,
        campaignIds,
        sinceDate,
        untilDate,
        dryRun,
      } = req.body || {};
      const toArray = (v: any): string[] | undefined =>
        Array.isArray(v) && v.length > 0 ? v.map(String) : undefined;
      const isDry = dryRun === true || dryRun === "true";
      // Mirror the CLI safeguard: live backfill must be explicitly confirmed
      // so an authenticated account manager can't kick off a cross-client
      // recovery run by accident.
      if (!isDry && req.body?.confirm !== true && req.body?.confirm !== "true") {
        return res.status(400).json({
          error:
            "Refusing to run live backfill without explicit confirm=true. Set dryRun=true to preview, or pass confirm=true to apply.",
        });
      }
      const result = await backfillLocationHeatmaps({
        clientIds: toArray(clientIds),
        locationIds: toArray(locationIds),
        campaignIds: toArray(campaignIds),
        sinceDate: sinceDate ? String(sinceDate) : undefined,
        untilDate: untilDate ? String(untilDate) : undefined,
        dryRun: isDry,
        triggeredBy: req.user?.id ? String(req.user.id) : null,
      });
      res.json(result);
    } catch (error: any) {
      console.error("[Semrush] Heatmap backfill error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Shared computation for backfill progress. Called from:
  //   - POST /api/semrush/heatmaps/backfill/progress (legacy: caller supplies
  //     runStartedAt + jobs from React state — used by the just-applied flow)
  //   - GET  /api/semrush/heatmaps/backfill/runs/:jobId/progress (new: pulls
  //     runStartedAt + jobs from the persisted `backfill_jobs` row so any
  //     operator can inspect any in-flight or recent run, even after a page
  //     refresh or from a different browser session)
  type InputJob = { jobId: string; campaignId: string; reportDate: string };
  async function computeBackfillProgress(runStartedAt: Date, jobsInput: InputJob[]) {
    const { workQueue } = await import("@shared/schema");
    const jobs: InputJob[] = [];
    const jobIds: string[] = [];
    const reportPairs = new Set<string>();
    const campaignIds = new Set<string>();
    const reportDates = new Set<string>();
    for (const r of jobsInput) {
      if (!r) continue;
      const jobId = r.jobId != null ? String(r.jobId) : "";
      const campaignId = r.campaignId != null ? String(r.campaignId) : "";
      const reportDate = r.reportDate != null ? String(r.reportDate) : "";
      if (!jobId || !campaignId || !reportDate) continue;
      jobs.push({ jobId, campaignId, reportDate });
      jobIds.push(jobId);
      reportPairs.add(`${campaignId}|${reportDate}`);
      campaignIds.add(campaignId);
      reportDates.add(reportDate);
    }

      // Look up the refresh jobs by id. We constrain by queueName as a
      // belt-and-suspenders guard so a malicious or stale jobId from another
      // queue can't be probed through this endpoint.
      let jobRows: Array<{
        id: string;
        status: string;
        errorMessage: string | null;
        attemptCount: number;
        completedAt: Date | null;
        updatedAt: Date;
      }> = [];
      if (jobIds.length > 0) {
        jobRows = await db
          .select({
            id: workQueue.id,
            status: workQueue.status,
            errorMessage: workQueue.errorMessage,
            attemptCount: workQueue.attemptCount,
            completedAt: workQueue.completedAt,
            updatedAt: workQueue.updatedAt,
          })
          .from(workQueue)
          .where(
            and(
              inArray(workQueue.id, jobIds),
              eq(workQueue.queueName, "semrush_report_refresh"),
            ),
          );
      }
      const jobById = new Map(jobRows.map((r) => [r.id, r]));

      const normalizeStatus = (s: string | undefined | null): "queued" | "running" | "completed" | "failed" | "missing" => {
        switch (s) {
          case "pending":
            return "queued";
          case "leased":
          case "processing":
            return "running";
          case "completed":
            return "completed";
          case "failed":
          case "dead_letter":
          case "cancelled":
            return "failed";
          default:
            return "missing";
        }
      };

      const jobStatuses = jobs.map((j) => {
        const row = jobById.get(j.jobId);
        return {
          jobId: j.jobId,
          campaignId: j.campaignId,
          reportDate: j.reportDate,
          status: normalizeStatus(row?.status),
          rawStatus: row?.status ?? null,
          errorMessage: row?.errorMessage ?? null,
          attemptCount: row?.attemptCount ?? 0,
          completedAt: row?.completedAt ? row.completedAt.toISOString() : null,
          updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
        };
      });

      const summary: {
        total: number;
        queued: number;
        running: number;
        completed: number;
        failed: number;
        missing: number;
        allTerminal: boolean;
      } = jobStatuses.reduce(
        (acc, j) => {
          acc.total += 1;
          if (j.status === "queued") acc.queued += 1;
          else if (j.status === "running") acc.running += 1;
          else if (j.status === "completed") acc.completed += 1;
          else if (j.status === "failed") acc.failed += 1;
          else acc.missing += 1;
          return acc;
        },
        { total: 0, queued: 0, running: 0, completed: 0, failed: 0, missing: 0, allTerminal: false },
      );
      summary.allTerminal =
        summary.total > 0 &&
        summary.queued === 0 &&
        summary.running === 0;

      // Per-(campaign, reportDate, location) snapshot writes for this run.
      // We pull from heatmap_snapshots directly; each (location, keyword)
      // success writes one row, so the keywordCount per group reflects how
      // many keyword scans actually landed for that location during this run.
      type SnapshotRow = {
        campaignId: string;
        reportDate: Date;
        clientId: string | null;
        locationId: string;
        locationName: string;
        keywordCount: number;
        latestCreatedAt: Date | null;
      };
      let snapshotRows: SnapshotRow[] = [];
      if (campaignIds.size > 0 && reportDates.size > 0) {
        const campaignValues = Array.from(campaignIds);
        const dateValues = Array.from(reportDates);
        // Aggregate at the (campaign, reportDate, location) grain. We compare
        // `report_date::date` to the date list because the snapshot stores a
        // timestamp; the input strings are calendar dates emitted by SEMrush.
        // Both arrays are passed as bound params so untrusted input can't
        // smuggle SQL into the IN/ANY clauses.
        const result: any = await db.execute(sql`
          SELECT
            campaign_id AS "campaignId",
            report_date::date AS "reportDate",
            client_id AS "clientId",
            location_id AS "locationId",
            (array_agg(location_name ORDER BY created_at DESC))[1] AS "locationName",
            COUNT(DISTINCT keyword_id) AS "keywordCount",
            MAX(created_at) AS "latestCreatedAt"
          FROM heatmap_snapshots
          WHERE campaign_id = ANY(${bindArrayParam(campaignValues)})
            AND report_date::date = ANY(${bindArrayParam(dateValues, "date")})
            AND created_at >= ${runStartedAt}
          GROUP BY campaign_id, report_date::date, client_id, location_id
        `);
        const rawRows: any[] = Array.isArray(result) ? result : (result?.rows ?? []);
        snapshotRows = rawRows
          .map((r: any) => {
            const d: Date = r.reportDate instanceof Date ? r.reportDate : new Date(r.reportDate);
            return {
              campaignId: String(r.campaignId),
              reportDate: d,
              clientId: r.clientId ?? null,
              locationId: String(r.locationId),
              locationName: r.locationName ?? "",
              keywordCount: Number(r.keywordCount ?? 0),
              latestCreatedAt: r.latestCreatedAt
                ? r.latestCreatedAt instanceof Date
                  ? r.latestCreatedAt
                  : new Date(r.latestCreatedAt)
                : null,
            };
          })
          // Drop snapshots whose (campaign, reportDate) wasn't actually part of
          // the requested set — possible when the SQL date list overlaps with
          // a different campaign's snapshot for the same report date.
          .filter((r) => {
            const iso = r.reportDate.toISOString().slice(0, 10);
            return reportPairs.has(`${r.campaignId}|${iso}`);
          });
      }

      const snapshots = snapshotRows.map((r) => ({
        campaignId: r.campaignId,
        reportDate: r.reportDate.toISOString().slice(0, 10),
        clientId: r.clientId,
        locationId: r.locationId,
        locationName: r.locationName,
        keywordCount: r.keywordCount,
        latestCreatedAt: r.latestCreatedAt ? r.latestCreatedAt.toISOString() : null,
      }));

      // Failed / in-flight `semrush_heatmap_apply` jobs grouped by
      // (campaign, reportDate, location). The refresh job (above) only tells
      // us whether SEMrush data was *fetched* and the per-location *apply*
      // job was enqueued — it doesn't tell us whether the apply actually
      // wrote snapshot rows. A successful apply shows up in `snapshots`;
      // anything still pending/leased/processing or failed/dead_letter/
      // cancelled lands here so operators know exactly which (campaign,
      // reportDate, location) tuples need a retry.
      //
      // We join `work_queue` -> `work_result_log` via the apply job's
      // `payload->>'workResultId'` because that's the only place the
      // (campaignId, reportDate, locationId) tuple is recorded for the
      // apply job. We scope by `wq.created_at >= runStartedAt` so an
      // unrelated, earlier apply job for the same tuple isn't attributed
      // to this backfill run.
      type ApplyJobAggRow = {
        campaignId: string;
        reportDate: Date;
        locationId: string;
        locationName: string | null;
        failedCount: number;
        queuedCount: number;
        runningCount: number;
        latestErrorMessage: string | null;
        latestUpdatedAt: Date | null;
      };
      let applyJobRows: ApplyJobAggRow[] = [];
      if (campaignIds.size > 0 && reportDates.size > 0) {
        const campaignValues = Array.from(campaignIds);
        const dateValues = Array.from(reportDates);
        const result: any = await db.execute(sql`
          SELECT
            wrl.result_json->>'campaignId' AS "campaignId",
            (wrl.result_json->>'reportDate')::date AS "reportDate",
            wrl.result_json->>'locationId' AS "locationId",
            (array_agg(wrl.result_json->>'locationName' ORDER BY wq.updated_at DESC))[1] AS "locationName",
            COUNT(*) FILTER (WHERE wq.status IN ('failed','dead_letter','cancelled'))::int AS "failedCount",
            COUNT(*) FILTER (WHERE wq.status = 'pending')::int AS "queuedCount",
            COUNT(*) FILTER (WHERE wq.status IN ('leased','processing'))::int AS "runningCount",
            (array_agg(wq.error_message ORDER BY wq.updated_at DESC)
              FILTER (WHERE wq.error_message IS NOT NULL
                AND wq.status IN ('failed','dead_letter','cancelled')))[1]
              AS "latestErrorMessage",
            MAX(wq.updated_at) AS "latestUpdatedAt"
          FROM work_queue wq
          JOIN work_result_log wrl ON wrl.id = (wq.payload->>'workResultId')
          WHERE wq.queue_name = 'semrush_heatmap_apply'
            AND wq.created_at >= ${runStartedAt}
            AND wrl.result_json->>'campaignId' = ANY(${bindArrayParam(campaignValues)})
            AND (wrl.result_json->>'reportDate')::date = ANY(${bindArrayParam(dateValues, "date")})
            AND wq.status IN ('failed','dead_letter','cancelled','pending','leased','processing')
          GROUP BY 1, 2, 3
        `);
        const rawRows: any[] = Array.isArray(result) ? result : (result?.rows ?? []);
        applyJobRows = rawRows
          .map((r: any) => {
            const d: Date = r.reportDate instanceof Date ? r.reportDate : new Date(r.reportDate);
            return {
              campaignId: String(r.campaignId),
              reportDate: d,
              locationId: String(r.locationId),
              locationName: r.locationName ?? null,
              failedCount: Number(r.failedCount ?? 0),
              queuedCount: Number(r.queuedCount ?? 0),
              runningCount: Number(r.runningCount ?? 0),
              latestErrorMessage: r.latestErrorMessage ?? null,
              latestUpdatedAt: r.latestUpdatedAt
                ? r.latestUpdatedAt instanceof Date
                  ? r.latestUpdatedAt
                  : new Date(r.latestUpdatedAt)
                : null,
            };
          })
          // Drop rows whose (campaign, reportDate) wasn't actually part of
          // the requested set — possible when the SQL date list overlaps
          // with a different campaign's apply jobs for the same date.
          .filter((r) => {
            const iso = r.reportDate.toISOString().slice(0, 10);
            return reportPairs.has(`${r.campaignId}|${iso}`);
          });
      }

      const applyJobs = applyJobRows.map((r) => ({
        campaignId: r.campaignId,
        reportDate: r.reportDate.toISOString().slice(0, 10),
        locationId: r.locationId,
        locationName: r.locationName,
        failedCount: r.failedCount,
        queuedCount: r.queuedCount,
        runningCount: r.runningCount,
        latestErrorMessage: r.latestErrorMessage,
        latestUpdatedAt: r.latestUpdatedAt ? r.latestUpdatedAt.toISOString() : null,
      }));

      return {
        runStartedAt: runStartedAt.toISOString(),
        summary,
        jobs: jobStatuses,
        snapshots,
        applyJobs,
      };
  }

  // Live progress for the refresh jobs enqueued by `POST /api/semrush/heatmaps/backfill`.
  // The UI sends back the `reportDatesEnqueued` rows it received from the apply
  // response plus the wall-clock time it kicked off the run. Kept for the
  // just-applied flow inside the same browser session.
  app.post("/api/semrush/heatmaps/backfill/progress", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const body = req.body || {};
      const runStartedAtRaw = body.runStartedAt;
      const runStartedAt = runStartedAtRaw ? new Date(runStartedAtRaw) : null;
      if (!runStartedAt || Number.isNaN(runStartedAt.getTime())) {
        return res.status(400).json({ error: "runStartedAt (ISO timestamp) is required" });
      }
      const rawJobs = Array.isArray(body.jobs) ? body.jobs : [];
      const payload = await computeBackfillProgress(runStartedAt, rawJobs);
      res.json(payload);
    } catch (error: any) {
      console.error("[Semrush] Heatmap backfill progress error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Lightweight pre-flight coverage hint for the SEMrush backfill picker.
  // Same filters as `POST /api/semrush/heatmaps/backfill` but read-only and
  // SEMrush-API-free — we resolve mappings against `semrush_location_campaigns`
  // and use `heatmap_snapshots` itself as the source for "which report dates
  // does this scope already know about?". For each unique campaign in the
  // matched mapping set we treat the distinct `report_date::date` values seen
  // in heatmap_snapshots (within the optional window) as the universe of
  // report dates worth covering — i.e. dates where at least one location for
  // that campaign already has a snapshot. We then count how many of the
  // (campaignId, locationId, reportDate) triples for the matched mappings are
  // already present. This deliberately avoids hitting the SEMrush `/campaigns`
  // detail endpoint so the hint can refresh live as the operator adjusts the
  // picker without paying per-keystroke API cost.
  app.post("/api/semrush/heatmaps/backfill/coverage", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { semrushLocationCampaigns } = await import("@shared/schema");
      const body = req.body || {};
      const toArray = (v: any): string[] | undefined =>
        Array.isArray(v) && v.length > 0 ? v.map(String) : undefined;
      const clientIds = toArray(body.clientIds);
      const locationIds = toArray(body.locationIds);
      const campaignIds = toArray(body.campaignIds);
      const sinceDate = body.sinceDate ? String(body.sinceDate) : "";
      const untilDate = body.untilDate ? String(body.untilDate) : "";
      // Validate dates so the SQL `report_date::date <= '<input>'::date` cast
      // can never explode on operator typos.
      const sinceMs = sinceDate ? new Date(sinceDate).getTime() : null;
      const untilMs = untilDate ? new Date(untilDate).getTime() : null;
      if (sinceMs !== null && Number.isNaN(sinceMs)) {
        return res.status(400).json({ error: `Invalid sinceDate: ${sinceDate}` });
      }
      if (untilMs !== null && Number.isNaN(untilMs)) {
        return res.status(400).json({ error: `Invalid untilDate: ${untilDate}` });
      }

      // Resolve mappings (excluding stale links) — same predicate set as the
      // backfill itself uses. If no scope filter is provided we return an
      // empty coverage so the picker doesn't accidentally light up "X / Y"
      // numbers for the entire org.
      if (!clientIds && !locationIds && !campaignIds) {
        return res.json({
          mappingCount: 0,
          campaignCount: 0,
          knownReportDateCount: 0,
          expectedSnapshotCount: 0,
          coveredSnapshotCount: 0,
          missingSnapshotCount: 0,
          hasScope: false,
        });
      }

      const conditions = [eq(semrushLocationCampaigns.isStale, false)];
      if (clientIds?.length) conditions.push(inArray(semrushLocationCampaigns.clientId, clientIds));
      if (locationIds?.length) conditions.push(inArray(semrushLocationCampaigns.locationId, locationIds));
      if (campaignIds?.length) conditions.push(inArray(semrushLocationCampaigns.semrushCampaignId, campaignIds));

      const mappings = await db
        .select({
          clientId: semrushLocationCampaigns.clientId,
          locationId: semrushLocationCampaigns.locationId,
          semrushCampaignId: semrushLocationCampaigns.semrushCampaignId,
        })
        .from(semrushLocationCampaigns)
        .where(and(...conditions));

      if (mappings.length === 0) {
        return res.json({
          mappingCount: 0,
          campaignCount: 0,
          knownReportDateCount: 0,
          expectedSnapshotCount: 0,
          coveredSnapshotCount: 0,
          missingSnapshotCount: 0,
          hasScope: true,
        });
      }

      const uniqueCampaignIds = Array.from(new Set(mappings.map((m) => m.semrushCampaignId)));
      const uniqueLocationIds = Array.from(new Set(mappings.map((m) => m.locationId)));
      // (campaignId, locationId) pairs that the backfill would actually touch.
      const matchedPair = new Set<string>(
        mappings.map((m) => `${m.semrushCampaignId}|${m.locationId}`),
      );
      // (campaignId -> matched location count) for the expected-snapshot math.
      const matchedLocsByCampaign = new Map<string, Set<string>>();
      for (const m of mappings) {
        let s = matchedLocsByCampaign.get(m.semrushCampaignId);
        if (!s) {
          s = new Set();
          matchedLocsByCampaign.set(m.semrushCampaignId, s);
        }
        s.add(m.locationId);
      }

      // Date window predicate — built once so both queries below stay aligned.
      // We `report_date::date`-cast both sides so a stored timestamp like
      // `2025-04-15 04:00:00` still matches an operator date input of
      // `2025-04-15` regardless of session timezone.
      const dateWindow = sql`
        ${sinceDate ? sql`AND report_date::date >= ${sinceDate}::date` : sql``}
        ${untilDate ? sql`AND report_date::date <= ${untilDate}::date` : sql``}
      `;

      // 1. Distinct report dates per campaign in window — drives the
      //    "expected" denominator. We restrict by campaign only (not by
      //    location) so we still discover dates that exist for some siblings
      //    of the matched location set; those are exactly the gaps the
      //    backfill is meant to close.
      const dateRows: any = await db.execute(sql`
        SELECT campaign_id AS "campaignId", report_date::date AS "reportDate"
        FROM heatmap_snapshots
        WHERE campaign_id = ANY(${bindArrayParam(uniqueCampaignIds)})
        ${dateWindow}
        GROUP BY campaign_id, report_date::date
      `);
      const dateRowsArr: any[] = Array.isArray(dateRows) ? dateRows : (dateRows?.rows ?? []);
      const datesByCampaign = new Map<string, Set<string>>();
      for (const r of dateRowsArr) {
        const cid = String(r.campaignId);
        const d: Date = r.reportDate instanceof Date ? r.reportDate : new Date(r.reportDate);
        const iso = d.toISOString().slice(0, 10);
        let s = datesByCampaign.get(cid);
        if (!s) {
          s = new Set();
          datesByCampaign.set(cid, s);
        }
        s.add(iso);
      }

      let expectedSnapshotCount = 0;
      let knownReportDateCount = 0;
      for (const [cid, dates] of datesByCampaign) {
        const locs = matchedLocsByCampaign.get(cid);
        if (!locs) continue;
        knownReportDateCount += dates.size;
        expectedSnapshotCount += dates.size * locs.size;
      }

      // 2. Existing (campaignId, locationId, reportDate) triples that fall
      //    inside the matched mapping set. Pre-filter by location list at SQL
      //    time so we don't pull rows for unrelated siblings, then drop any
      //    pair not in `matchedPair` (covers the case where a campaign+loc
      //    pair belongs to a *different* mapping outside the chosen scope).
      let coveredSnapshotCount = 0;
      if (uniqueLocationIds.length > 0) {
        const tripleRows: any = await db.execute(sql`
          SELECT
            campaign_id AS "campaignId",
            location_id AS "locationId",
            report_date::date AS "reportDate"
          FROM heatmap_snapshots
          WHERE campaign_id = ANY(${bindArrayParam(uniqueCampaignIds)})
            AND location_id = ANY(${bindArrayParam(uniqueLocationIds)})
          ${dateWindow}
          GROUP BY campaign_id, location_id, report_date::date
        `);
        const tripleRowsArr: any[] = Array.isArray(tripleRows) ? tripleRows : (tripleRows?.rows ?? []);
        for (const r of tripleRowsArr) {
          const cid = String(r.campaignId);
          const lid = String(r.locationId);
          if (!matchedPair.has(`${cid}|${lid}`)) continue;
          coveredSnapshotCount += 1;
        }
      }

      const missingSnapshotCount = Math.max(
        0,
        expectedSnapshotCount - coveredSnapshotCount,
      );

      res.json({
        mappingCount: mappings.length,
        campaignCount: uniqueCampaignIds.length,
        knownReportDateCount,
        expectedSnapshotCount,
        coveredSnapshotCount,
        missingSnapshotCount,
        hasScope: true,
      });
    } catch (error: any) {
      console.error("[Semrush] Heatmap backfill coverage error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // List recent heatmap-backfill runs so any operator can see what teammates
  // kicked off and inspect progress for any in-flight or recently finished
  // backfill — even after refreshing the page or from a different session.
  app.get("/api/semrush/heatmaps/backfill/runs", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { listBackfillJobs } = await import("../services/backfillJobs");
      const limitRaw = req.query?.limit;
      const limit = Math.min(50, Math.max(1, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 20));
      const rows = await listBackfillJobs({ jobType: "semrush_heatmap_backfill", limit });
      const runs = rows.map((r) => {
        const result: any = r.resultJson ?? null;
        const enqueued: any[] = Array.isArray(result?.reportDatesEnqueued)
          ? result.reportDatesEnqueued
          : [];
        const trackable = enqueued.filter((row) => row && row.jobId);
        return {
          id: r.id,
          status: r.status,
          triggeredBy: r.triggeredBy,
          parameters: r.parametersJson ?? null,
          processedUnits: r.processedUnits,
          succeededUnits: r.succeededUnits,
          failedUnits: r.failedUnits,
          enqueuedJobCount: trackable.length,
          startedAt: r.startedAt ? r.startedAt.toISOString() : null,
          completedAt: r.completedAt ? r.completedAt.toISOString() : null,
          createdAt: r.createdAt ? r.createdAt.toISOString() : null,
          errorMessage: r.errorMessage,
          // Whether the run has enough persisted info to power the
          // per-(campaign, reportDate) progress view. In-flight runs whose
          // `resultJson` hasn't been written yet (the apply request is still
          // enqueueing) won't have any trackable jobs and the UI can fall
          // back to the apply-time live progress card.
          hasProgress: trackable.length > 0 && !!r.startedAt,
        };
      });
      res.json({ runs });
    } catch (error: any) {
      console.error("[Semrush] Heatmap backfill runs list error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Per-run progress for any persisted backfill run — pulls runStartedAt and
  // the enqueued refresh job IDs from the `backfill_jobs` row so progress
  // works after a page refresh and across operators.
  app.get("/api/semrush/heatmaps/backfill/runs/:jobId/progress", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { getBackfillJob } = await import("../services/backfillJobs");
      const job = await getBackfillJob(String(req.params.jobId));
      if (!job || job.jobType !== "semrush_heatmap_backfill") {
        return res.status(404).json({ error: "Backfill run not found" });
      }
      const startedAt = job.startedAt ?? job.createdAt;
      if (!startedAt) {
        return res.status(409).json({ error: "Backfill run has no startedAt timestamp yet" });
      }
      const result: any = job.resultJson ?? null;
      const enqueued: any[] = Array.isArray(result?.reportDatesEnqueued)
        ? result.reportDatesEnqueued
        : [];
      const jobs: InputJob[] = enqueued
        .filter((row: any) => row && row.jobId)
        .map((row: any) => ({
          jobId: String(row.jobId),
          campaignId: String(row.campaignId),
          reportDate: String(row.reportDate),
        }));
      const payload = await computeBackfillProgress(startedAt, jobs);
      res.json({
        ...payload,
        runId: job.id,
        runStatus: job.status,
        runCompletedAt: job.completedAt ? job.completedAt.toISOString() : null,
        runErrorMessage: job.errorMessage,
        triggeredBy: job.triggeredBy,
      });
    } catch (error: any) {
      console.error("[Semrush] Heatmap backfill run progress error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/semrush/campaigns/:campaignId/refresh", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { PERF } = await import("../perfConfig");
      if (!PERF.SEMRUSH_REPORT_REFRESH_ENABLED) {
        return res.status(400).json({ error: "Semrush report-driven refresh is disabled. Set SEMRUSH_REPORT_REFRESH_ENABLED=true to enable." });
      }
      const { campaignId } = req.params;
      const { reportDate } = req.body;
      const { triggerReportRefresh } = await import("../services/semrushInventorySync");
      const jobId = await triggerReportRefresh(campaignId, "manual", reportDate);
      res.json({ success: true, jobId, message: "Refresh job enqueued" });
    } catch (error: any) {
      console.error("[Semrush] Manual refresh error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // LOCAL DOMINANCE DASHBOARD — Client Integration & Dashboard
  // ============================================

  app.get("/api/clients/:clientId/semrush-integration", isAuthenticated, async (req: any, res) => {
    try {
      const { clientSemrushIntegrations } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(clientSemrushIntegrations)
        .where(eq(clientSemrushIntegrations.clientId, req.params.clientId))
        .limit(1);
      res.json(rows[0] || null);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/clients/:clientId/semrush-integration", isAuthenticated, requireAccountManager, async (req: ValidatedBodyRequest<Record<string, unknown>, { clientId: string }>, res) => {
    try {
      const { clientSemrushIntegrations, insertClientSemrushIntegrationSchema } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      const existing = await db.select().from(clientSemrushIntegrations)
        .where(eq(clientSemrushIntegrations.clientId, req.params.clientId))
        .limit(1);

      // F8 (Task #4153) — validate the body through the shared entity schema
      // instead of spreading raw req.body into the write. clientId is bound
      // to the URL param, and the sync-state machinery columns (written only
      // by the SEMrush sync worker) are server-managed — this config PUT can
      // never touch them.
      const semrushIntegrationConfigSchema = insertClientSemrushIntegrationSchema.omit({
        clientId: true,
        syncStatus: true,
        lastSuccessfulSyncAt: true,
        lastFailedSyncAt: true,
        errorMessage: true,
        errorCategory: true,
        warningMessage: true,
        lastSyncOutcome: true,
        lastSyncSummary: true,
        syncProgress: true,
      });

      if (existing[0]) {
        const parsed = semrushIntegrationConfigSchema.partial().safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const [updated] = await db.update(clientSemrushIntegrations)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(clientSemrushIntegrations.id, existing[0].id))
          .returning();
        res.json(updated);
      } else {
        const parsed = semrushIntegrationConfigSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const [created] = await db.insert(clientSemrushIntegrations)
          .values({ ...parsed.data, clientId: req.params.clientId })
          .returning();
        res.json(created);
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/clients/:clientId/semrush-integration", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { clientSemrushIntegrations } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      await db.delete(clientSemrushIntegrations)
        .where(eq(clientSemrushIntegrations.clientId, req.params.clientId));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/clients/:clientId/semrush-integration/sync", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { clientSemrushIntegrations } = await import("@shared/schema");
      const { eq, and, ne, or, lt } = await import("drizzle-orm");
      const clientId = req.params.clientId;

      const rows = await db.select()
        .from(clientSemrushIntegrations)
        .where(eq(clientSemrushIntegrations.clientId, clientId))
        .limit(1);

      if (!rows[0]) {
        return res.status(400).json({ error: "No integration configured" });
      }

      const STALE_SYNC_THRESHOLD_MS = 10 * 60 * 1000;
      const staleThreshold = new Date(Date.now() - STALE_SYNC_THRESHOLD_MS);

      const updated = await db.update(clientSemrushIntegrations)
        .set({ syncStatus: "syncing", errorMessage: null, errorCategory: null, updatedAt: new Date() })
        .where(
          and(
            eq(clientSemrushIntegrations.id, rows[0].id),
            or(
              ne(clientSemrushIntegrations.syncStatus, "syncing"),
              lt(clientSemrushIntegrations.updatedAt, staleThreshold)
            )
          )
        )
        .returning({ id: clientSemrushIntegrations.id });

      if (updated.length === 0) {
        return res.status(409).json({ error: "Sync already in progress for this client" });
      }

      if (rows[0].syncStatus === "syncing") {
        console.warn(`[SEMrush Sync] Resetting stale sync for client ${clientId} (stuck since ${rows[0].updatedAt})`);
      }

      const { syncSingleClient } = await import("../services/localDominanceSyncWorker");
      syncSingleClient(clientId).catch(async (err) => {
        console.error(`[SEMrush Sync] Background sync failed for client ${clientId}:`, err);
        try {
          const { clientSemrushIntegrations } = await import("@shared/schema");
          const { eq } = await import("drizzle-orm");
          const { classifyError } = await import("../services/semrushLocationSyncState");
          await db.update(clientSemrushIntegrations)
            .set({
              syncStatus: "error",
              lastFailedSyncAt: new Date(),
              errorMessage: (err?.message || String(err)).substring(0, 500),
              // E-F16 typed-failure parity: machine-readable classification
              // beside the raw text (same classifier as the sync_state rows).
              errorCategory: classifyError(err),
              updatedAt: new Date(),
            })
            .where(eq(clientSemrushIntegrations.clientId, clientId));
        } catch (updateErr) {
          console.error(`[SEMrush Sync] Failed to update error status for client ${clientId}:`, updateErr);
        }
      });

      res.status(202).json({ status: "syncing", message: "Sync started" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Per-location SEMrush sync state surface — feeds the dashboard panel and
  // the manual retry path. Joined with location/campaign metadata so the UI
  // can render human-readable labels without an extra fetch.
  app.get("/api/clients/:clientId/semrush-integration/sync-state", isAuthenticated, async (req: any, res) => {
    try {
      const { clientId } = req.params;
      const { semrushLocationSyncState } = await import("@shared/schema");
      const rows = await db.select({
        id: semrushLocationSyncState.id,
        clientId: semrushLocationSyncState.clientId,
        locationId: semrushLocationSyncState.locationId,
        campaignId: semrushLocationSyncState.campaignId,
        status: semrushLocationSyncState.status,
        attemptCount: semrushLocationSyncState.attemptCount,
        maxAttempts: semrushLocationSyncState.maxAttempts,
        lastAttemptAt: semrushLocationSyncState.lastAttemptAt,
        lastSucceededAt: semrushLocationSyncState.lastSucceededAt,
        lastFailedAt: semrushLocationSyncState.lastFailedAt,
        lastError: semrushLocationSyncState.lastError,
        errorCategory: semrushLocationSyncState.errorCategory,
        nextRetryAt: semrushLocationSyncState.nextRetryAt,
        importedKeywordCount: semrushLocationSyncState.importedKeywordCount,
        expectedKeywordCount: semrushLocationSyncState.expectedKeywordCount,
        durationMs: semrushLocationSyncState.durationMs,
        runId: semrushLocationSyncState.runId,
        triggeredBy: semrushLocationSyncState.triggeredBy,
        message: semrushLocationSyncState.message,
        updatedAt: semrushLocationSyncState.updatedAt,
        locationName: clientLocations.name,
        locationCity: clientLocations.city,
        locationState: clientLocations.state,
        campaignName: semrushLocationCampaigns.semrushCampaignName,
      })
        .from(semrushLocationSyncState)
        .leftJoin(clientLocations, eq(semrushLocationSyncState.locationId, clientLocations.id))
        .leftJoin(
          semrushLocationCampaigns,
          and(
            eq(semrushLocationCampaigns.locationId, semrushLocationSyncState.locationId),
            eq(semrushLocationCampaigns.semrushCampaignId, semrushLocationSyncState.campaignId),
          ),
        )
        .where(eq(semrushLocationSyncState.clientId, clientId));
      res.json({ rows });
    } catch (error: any) {
      console.error("[SEMrush sync-state] failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Manual per-location retry. Resets the bounded-attempt counter for that
  // single (clientId, locationId, campaignId) tuple and kicks off a scoped
  // single-location sync — sibling locations are NOT touched.
  app.post(
    "/api/clients/:clientId/semrush-integration/locations/:locationId/retry",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const { clientId, locationId } = req.params;
        const mappings = await db.select()
          .from(semrushLocationCampaigns)
          .where(and(
            eq(semrushLocationCampaigns.clientId, clientId),
            eq(semrushLocationCampaigns.locationId, locationId),
          ))
          .limit(1);
        if (!mappings[0]) {
          return res.status(404).json({ error: "No SEMrush mapping for that location" });
        }
        const { resetForManualRetry } = await import("../services/semrushLocationSyncState");
        await resetForManualRetry({
          clientId,
          locationId,
          campaignId: mappings[0].semrushCampaignId,
        });
        const { syncSingleClient } = await import("../services/localDominanceSyncWorker");
        // Fire and forget — UI polls /sync-state for progress.
        syncSingleClient(clientId, { origin: "user_manual", restrictToLocationId: locationId })
          .catch((err) => {
            console.error(`[SEMrush retry] background single-location sync failed for client=${clientId} loc=${locationId}:`, err);
          });
        res.status(202).json({ status: "queued", locationId, campaignId: mappings[0].semrushCampaignId });
      } catch (error: any) {
        console.error("[SEMrush retry] failed:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Append-only attempt history for one (clientId, locationId).
  app.get(
    "/api/clients/:clientId/semrush-integration/locations/:locationId/attempts",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { clientId, locationId } = req.params;
        const limit = req.query.limit ? Math.min(500, Math.max(1, Number(req.query.limit))) : 50;
        const { listAttemptsForLocation } = await import("../services/semrushLocationSyncAttempts");
        const rows = await listAttemptsForLocation(clientId, locationId, limit);
        res.json({ rows });
      } catch (error: any) {
        console.error("[SEMrush attempts] failed:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Canonical backfill job log. Operational metadata across clients —
  // restricted to account managers (the same role gate used to TRIGGER a
  // backfill). Auditors with the team-lead role above also pass.
  app.get("/api/backfill-jobs", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { listBackfillJobs } = await import("../services/backfillJobs");
      const { backfillJobTypes, backfillJobStatuses } = await import("@shared/models/heatmap");
      const jobTypeRaw = req.query.jobType ? String(req.query.jobType) : undefined;
      const statusRaw = req.query.status ? String(req.query.status) : undefined;
      const jobType = jobTypeRaw && (backfillJobTypes as readonly string[]).includes(jobTypeRaw)
        ? (jobTypeRaw as import("@shared/models/heatmap").BackfillJobType)
        : undefined;
      const status = statusRaw && (backfillJobStatuses as readonly string[]).includes(statusRaw)
        ? (statusRaw as import("@shared/models/heatmap").BackfillJobStatus)
        : undefined;
      const rows = await listBackfillJobs({
        jobType,
        status,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({ rows });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/backfill-jobs/:jobId", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { getBackfillJob } = await import("../services/backfillJobs");
      const row = await getBackfillJob(req.params.jobId);
      if (!row) return res.status(404).json({ error: "Backfill job not found" });
      res.json(row);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Read the coverage gaps that were auto-computed when the backfill job
  // finished. The completion path now writes `coverageGapsJson` directly,
  // so this is a pure read endpoint — no expensive recompute on demand.
  app.get(
    "/api/backfill-jobs/:jobId/coverage-gaps",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const { getBackfillJob } = await import("../services/backfillJobs");
        const job = await getBackfillJob(req.params.jobId);
        if (!job) return res.status(404).json({ error: "Backfill job not found" });
        const rawGaps = (Array.isArray(job.coverageGapsJson) ? job.coverageGapsJson : []) as Array<{
          clientId: string;
          locationId: string;
          campaignId: string;
          reportDate: string;
          expected: number;
          observed: number;
          missingKeywords: string[];
        }>;

        // Task #1246: enrich raw IDs with the client firm name and the location's
        // human-readable name/address so operators see "Acme Law — Downtown office"
        // instead of bare UUIDs. Batch the lookups so we issue at most two queries
        // regardless of gap count.
        const clientIds = Array.from(new Set(rawGaps.map((g) => g.clientId).filter(Boolean)));
        const locationIds = Array.from(new Set(rawGaps.map((g) => g.locationId).filter(Boolean)));

        const clientRows = clientIds.length
          ? await db
              .select({ id: clients.id, firmName: clients.firmName })
              .from(clients)
              .where(inArray(clients.id, clientIds))
          : [];
        const locationRows = locationIds.length
          ? await db
              .select({
                id: clientLocations.id,
                name: clientLocations.name,
                address: clientLocations.address,
                city: clientLocations.city,
                state: clientLocations.state,
              })
              .from(clientLocations)
              .where(inArray(clientLocations.id, locationIds))
          : [];

        const clientNameById = new Map(clientRows.map((c) => [c.id, c.firmName]));
        const locationById = new Map(locationRows.map((l) => [l.id, l]));

        const gaps = rawGaps.map((g) => {
          const loc = locationById.get(g.locationId);
          const locationAddress = loc
            ? [loc.address, loc.city, loc.state].filter(Boolean).join(", ") || null
            : null;
          return {
            ...g,
            clientName: clientNameById.get(g.clientId) ?? null,
            locationName: loc?.name ?? null,
            locationAddress,
          };
        });

        res.json({
          jobId: job.id,
          status: job.status,
          completedAt: job.completedAt,
          gapCount: gaps.length,
          gaps,
        });
      } catch (error: any) {
        console.error("[BackfillCoverage] failed:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Task #1114: surface the post-drain heatmap coverage check (Task #651)
  // result that gets persisted onto `backfill_jobs.result_json`. Returns
  // the structured `PostDrainCoverageCheck` plus a relative download URL
  // for the markdown verification report so the admin UI can render a
  // "Post-drain coverage check" panel without having to read the JSON
  // column directly.
  app.get(
    "/api/backfill-jobs/:jobId/coverage-check",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const { getBackfillJob } = await import("../services/backfillJobs");
        const job = await getBackfillJob(req.params.jobId);
        if (!job) return res.status(404).json({ error: "Backfill job not found" });
        const result = (job.resultJson ?? {}) as {
          postDrainCoverageCheck?: import("../services/heatmapCoverageCheck").PostDrainCoverageCheck;
        };
        const check = result.postDrainCoverageCheck ?? null;
        const path = await import("path");
        const reportFileName = check?.reportFiles?.markdown
          ? path.basename(check.reportFiles.markdown)
          : null;
        res.json({
          jobId: job.id,
          status: job.status,
          completedAt: job.completedAt,
          check,
          reportDownloadUrl: reportFileName
            ? `/api/backfill-jobs/${job.id}/coverage-check/report`
            : null,
        });
      } catch (error: any) {
        console.error("[BackfillCoverageCheck] failed:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Stream the markdown verification report file written by the post-drain
  // check. Path is validated against the persisted file basename so an
  // attacker can't traverse out of the verification directory.
  app.get(
    "/api/backfill-jobs/:jobId/coverage-check/report",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const { getBackfillJob } = await import("../services/backfillJobs");
        const job = await getBackfillJob(req.params.jobId);
        if (!job) return res.status(404).json({ error: "Backfill job not found" });
        const result = (job.resultJson ?? {}) as {
          postDrainCoverageCheck?: import("../services/heatmapCoverageCheck").PostDrainCoverageCheck;
        };
        const check = result.postDrainCoverageCheck;
        const mdPath = check?.reportFiles?.markdown;
        if (!mdPath) {
          return res.status(404).json({ error: "No coverage-check report on file" });
        }
        const fs = await import("fs");
        const path = await import("path");
        const verificationDir = path.resolve(process.cwd(), "verification");
        const resolved = path.resolve(mdPath);
        if (!resolved.startsWith(verificationDir + path.sep)) {
          return res.status(400).json({ error: "Invalid report path" });
        }
        if (!fs.existsSync(resolved)) {
          return res.status(404).json({ error: "Report file no longer exists on disk" });
        }
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `inline; filename="${path.basename(resolved)}"`,
        );
        fs.createReadStream(resolved).pipe(res);
      } catch (error: any) {
        console.error("[BackfillCoverageCheckReport] failed:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // "Re-run check now" — enqueue an immediate `heatmap_coverage_check`
  // job for the given backfill. Uses a distinct manual-dedupe key so it
  // doesn't collide with an already-pending automatic recheck.
  app.post(
    "/api/backfill-jobs/:jobId/coverage-check/rerun",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const { getBackfillJob } = await import("../services/backfillJobs");
        const job = await getBackfillJob(req.params.jobId);
        if (!job) return res.status(404).json({ error: "Backfill job not found" });
        if (job.jobType !== "semrush_heatmap_backfill") {
          return res.status(400).json({
            error: "Coverage check only applies to SEMrush heatmap backfills",
            reason: "unsupported_job_type",
          });
        }
        const { enqueueJob } = await import("../services/workScheduler");
        const {
          HEATMAP_COVERAGE_CHECK_QUEUE,
          getHeatmapCoverageCheckSettings,
        } = await import("../services/heatmapCoverageCheck");
        const settings = await getHeatmapCoverageCheckSettings();
        if (!settings.enabled) {
          return res.status(409).json({
            error: "Heatmap coverage check feature flag is disabled",
            reason: "feature_flag_disabled",
          });
        }
        const runAt = new Date();
        const jobId = await enqueueJob({
          queueName: HEATMAP_COVERAGE_CHECK_QUEUE,
          workloadClass: "maintenance",
          priority: 50,
          payload: { backfillJobId: job.id, attempt: 1 },
          retryAt: runAt,
          dedupeKey: `heatmap_coverage_check:${job.id}:manual:${runAt.getTime()}`,
          maxAttempts: 3,
        });
        res.json({ scheduled: true, jobId, runAt: runAt.toISOString() });
      } catch (error: any) {
        console.error("[BackfillCoverageCheckRerun] failed:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // ============================================
  // SEMrush Operations Console — read-only panels (Task #940 / 936C)
  // Thin composite reads over canonical durable stores. No mutations.
  // ============================================

  // Queue names tracked on the SEMrush console. The inventory_sync and
  // enrichment workers run on a setInterval timer (NOT via work_queue), so
  // they're surfaced as worker flags rather than queue rows.
  const SEMRUSH_QUEUE_NAMES = [
    "semrush_report_refresh",
    "semrush_heatmap_apply",
  ] as const;

  app.get(
    "/api/semrush/console/overview",
    isAuthenticated,
    requireAccountManager,
    async (_req: any, res) => {
      try {
        const { workQueue, semrushLocationSyncState } = await import("@shared/schema");
        const { storage } = await import("../storage");
        const { getInventoryState } = await import("../services/semrushInventorySync");
        const { getStaleLeaseExhaustionMetrics } = await import("../services/pipelineObservability");
        const { getKeywordInventoryBailoutStats } = await import("../services/semrushApi");

        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

        // Connection status — mirrors /api/semrush/status semantics without
        // calling the SEMrush API (this endpoint must stay cheap).
        const [accessToken, expiresAt, deviceCode] = await Promise.all([
          storage.getSystemSetting("semrush_access_token"),
          storage.getSystemSetting("semrush_token_expires_at"),
          storage.getSystemSetting("semrush_device_code"),
        ]);
        const expiresAtMs = expiresAt?.value ? Number(expiresAt.value) : null;
        const nowMs = Date.now();
        let connectionStatus: "connected" | "expired" | "pending" | "disconnected" = "disconnected";
        // Task #3670 — v4 API-key mode: the key authenticates every call, so
        // stale OAuth token/device-code settings must never surface
        // expired/pending here. Stays cheap (no API call): key presence only.
        const { isSemrushKeyMode: consoleIsKeyMode } = await import("../services/semrushAuthMode");
        const consoleKeyMode = consoleIsKeyMode();
        if (consoleKeyMode) {
          connectionStatus = "connected";
        } else if (accessToken?.value) {
          connectionStatus = expiresAtMs && expiresAtMs <= nowMs ? "expired" : "connected";
        } else if (deviceCode?.value) {
          connectionStatus = "pending";
        }

        // Per-queue counters: backlog (pending+leased+processing), 24h
        // completed/failed counts, dead_letter total, last successful
        // completion timestamp.
        const queueRows = await db
          .select({
            queueName: workQueue.queueName,
            status: workQueue.status,
            count: sql<number>`count(*)::int`,
            lastCompletedAt: sql<Date | null>`max(case when ${workQueue.status} = 'completed' then ${workQueue.completedAt} end)`,
          })
          .from(workQueue)
          .where(inArray(workQueue.queueName, SEMRUSH_QUEUE_NAMES as unknown as string[]))
          .groupBy(workQueue.queueName, workQueue.status);

        const queue24hRows = await db
          .select({
            queueName: workQueue.queueName,
            status: workQueue.status,
            count: sql<number>`count(*)::int`,
          })
          .from(workQueue)
          .where(and(
            inArray(workQueue.queueName, SEMRUSH_QUEUE_NAMES as unknown as string[]),
            sql`${workQueue.createdAt} >= ${since24h}`,
          ))
          .groupBy(workQueue.queueName, workQueue.status);

        type QueueSummary = {
          queueName: string;
          backlog: number;
          processing: number;
          failed24h: number;
          completed24h: number;
          enqueued24h: number;
          deadLetter: number;
          lastCompletedAt: string | null;
        };
        const queueMap = new Map<string, QueueSummary>();
        for (const name of SEMRUSH_QUEUE_NAMES) {
          queueMap.set(name, {
            queueName: name,
            backlog: 0,
            processing: 0,
            failed24h: 0,
            completed24h: 0,
            enqueued24h: 0,
            deadLetter: 0,
            lastCompletedAt: null,
          });
        }
        for (const r of queueRows) {
          const q = queueMap.get(r.queueName);
          if (!q) continue;
          if (r.status === "pending" || r.status === "leased") q.backlog += r.count;
          if (r.status === "processing") q.processing += r.count;
          if (r.status === "dead_letter") q.deadLetter += r.count;
          if (r.lastCompletedAt && (!q.lastCompletedAt || new Date(r.lastCompletedAt) > new Date(q.lastCompletedAt))) {
            q.lastCompletedAt = new Date(r.lastCompletedAt).toISOString();
          }
        }
        for (const r of queue24hRows) {
          const q = queueMap.get(r.queueName);
          if (!q) continue;
          q.enqueued24h += r.count;
          if (r.status === "completed") q.completed24h += r.count;
          if (r.status === "failed" || r.status === "dead_letter") q.failed24h += r.count;
        }

        // Per-location auto-retry health (no dedicated work_queue row — uses
        // semrush_location_sync_state.nextRetryAt). Surface counts so the
        // panel can show "N locations awaiting auto-retry, M failed".
        const syncStateRows = await db
          .select({
            status: semrushLocationSyncState.status,
            count: sql<number>`count(*)::int`,
          })
          .from(semrushLocationSyncState)
          .groupBy(semrushLocationSyncState.status);
        const syncStateCounts: Record<string, number> = {};
        for (const r of syncStateRows) syncStateCounts[r.status] = r.count;

        const inventoryState = getInventoryState();
        const staleLease = getStaleLeaseExhaustionMetrics();
        // Task #1973: 24h counter for `semrush_keyword_inventory_bailout`
        // — completion-detection misfires (page cap, page-param-ignored,
        // non-array payloads). A rising count signals SEMrush API drift
        // OR a real inventory exceeding the page cap.
        const inventoryBailouts = getKeywordInventoryBailoutStats();

        res.set("Cache-Control", "no-store");
        res.json({
          connection: {
            status: connectionStatus,
            // Task #3670 — key mode: no token expiry countdown applies.
            authMode: consoleKeyMode ? "api_key" : "oauth",
            tokenExpiresAt: !consoleKeyMode && expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
            tokenExpiresInMs: !consoleKeyMode && expiresAtMs ? expiresAtMs - nowMs : null,
          },
          inventory: {
            isRunning: inventoryState.isRunning,
            campaignCount: inventoryState.previousInventory?.campaigns.length ?? 0,
            lastFetchedAt: inventoryState.previousInventory?.fetchedAt
              ? new Date(inventoryState.previousInventory.fetchedAt).toISOString()
              : null,
            flags: inventoryState.flags,
            durability: "ephemeral_reseeded_from_db",
          },
          queues: Array.from(queueMap.values()),
          locationSync: {
            counts: syncStateCounts,
            awaitingAutoRetry: syncStateCounts.failed ?? 0,
          },
          staleLease: {
            countInWindow: staleLease.countInWindow,
            windowMs: staleLease.windowMs,
            threshold: staleLease.threshold,
            durability: "ephemeral_in_memory",
          },
          keywordInventoryBailouts: {
            countInWindow: inventoryBailouts.countInWindow,
            windowMs: inventoryBailouts.windowMs,
            byReason: inventoryBailouts.byReason,
            recent: inventoryBailouts.recent,
            durability: "ephemeral_in_memory",
          },
          generatedAt: new Date().toISOString(),
        });
      } catch (error: any) {
        console.error("[SEMrush console overview] failed:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get(
    "/api/semrush/console/sync-state",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const { semrushLocationSyncState } = await import("@shared/schema");
        const { clients } = await import("@shared/schema");

        const limitParam = Number(req.query.limit);
        const limit = Number.isFinite(limitParam) && limitParam > 0
          ? Math.min(2000, limitParam)
          : 500;

        const rows = await db
          .select({
            id: semrushLocationSyncState.id,
            clientId: semrushLocationSyncState.clientId,
            clientName: clients.firmName,
            locationId: semrushLocationSyncState.locationId,
            locationName: clientLocations.name,
            locationCity: clientLocations.city,
            locationState: clientLocations.state,
            campaignId: semrushLocationSyncState.campaignId,
            campaignName: semrushLocationCampaigns.semrushCampaignName,
            status: semrushLocationSyncState.status,
            attemptCount: semrushLocationSyncState.attemptCount,
            maxAttempts: semrushLocationSyncState.maxAttempts,
            lastAttemptAt: semrushLocationSyncState.lastAttemptAt,
            lastSucceededAt: semrushLocationSyncState.lastSucceededAt,
            lastFailedAt: semrushLocationSyncState.lastFailedAt,
            lastError: semrushLocationSyncState.lastError,
            errorCategory: semrushLocationSyncState.errorCategory,
            nextRetryAt: semrushLocationSyncState.nextRetryAt,
            importedKeywordCount: semrushLocationSyncState.importedKeywordCount,
            expectedKeywordCount: semrushLocationSyncState.expectedKeywordCount,
            durationMs: semrushLocationSyncState.durationMs,
            triggeredBy: semrushLocationSyncState.triggeredBy,
            updatedAt: semrushLocationSyncState.updatedAt,
          })
          .from(semrushLocationSyncState)
          .leftJoin(clients, eq(semrushLocationSyncState.clientId, clients.id))
          .leftJoin(clientLocations, eq(semrushLocationSyncState.locationId, clientLocations.id))
          .leftJoin(
            semrushLocationCampaigns,
            and(
              eq(semrushLocationCampaigns.locationId, semrushLocationSyncState.locationId),
              eq(semrushLocationCampaigns.semrushCampaignId, semrushLocationSyncState.campaignId),
            ),
          )
          .orderBy(desc(semrushLocationSyncState.updatedAt))
          .limit(limit);

        // Per-client integration outcomes (Task #739) — surfaces the same
        // "Already current / Freshly synced / Partially refreshed / Failed"
        // distinction the per-client Local Dominance dashboard shows
        // (Task #617), but rolled up across every client mapping so ops
        // staff can see at a glance how a multi-client re-sync resolved.
        // Mapping logic lives in `./semrushSyncStateRollup` so it can be
        // unit-tested in isolation (Task #1212).
        const integrationRows = await db
          .select({
            clientId: clientSemrushIntegrations.clientId,
            clientName: clients.firmName,
            syncStatus: clientSemrushIntegrations.syncStatus,
            lastSyncOutcome: clientSemrushIntegrations.lastSyncOutcome,
            lastSyncSummary: clientSemrushIntegrations.lastSyncSummary,
            lastSuccessfulSyncAt: clientSemrushIntegrations.lastSuccessfulSyncAt,
            lastFailedSyncAt: clientSemrushIntegrations.lastFailedSyncAt,
            errorMessage: clientSemrushIntegrations.errorMessage,
            integrationEnabled: clientSemrushIntegrations.integrationEnabled,
          })
          .from(clientSemrushIntegrations)
          .leftJoin(clients, eq(clientSemrushIntegrations.clientId, clients.id))
          .where(eq(clientSemrushIntegrations.integrationEnabled, true));

        const { computeSyncStateRollup } = await import("./semrushSyncStateRollup");
        const { perClient, totals, outcomeTotals } = computeSyncStateRollup({
          syncStateRows: rows.map((r) => ({
            clientId: r.clientId,
            clientName: r.clientName,
            status: r.status,
          })),
          integrationRows,
        });

        res.set("Cache-Control", "no-store");
        res.json({
          rows,
          perClient,
          totals,
          outcomeTotals,
          generatedAt: new Date().toISOString(),
        });
      } catch (error: any) {
        console.error("[SEMrush console sync-state] failed:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get(
    "/api/semrush/console/recent-jobs",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const { workQueue } = await import("@shared/schema");
        const limitParam = Number(req.query.limit);
        const limit = Number.isFinite(limitParam) && limitParam > 0
          ? Math.min(200, limitParam)
          : 50;

        const rows = await db
          .select({
            id: workQueue.id,
            queueName: workQueue.queueName,
            jobType: workQueue.jobType,
            status: workQueue.status,
            workloadClass: workQueue.workloadClass,
            attemptCount: workQueue.attemptCount,
            maxAttempts: workQueue.maxAttempts,
            dedupeKey: workQueue.dedupeKey,
            payload: workQueue.payload,
            errorCode: workQueue.errorCode,
            errorMessage: workQueue.errorMessage,
            createdAt: workQueue.createdAt,
            leasedAt: workQueue.leasedAt,
            completedAt: workQueue.completedAt,
            updatedAt: workQueue.updatedAt,
          })
          .from(workQueue)
          .where(inArray(workQueue.queueName, SEMRUSH_QUEUE_NAMES as unknown as string[]))
          .orderBy(desc(workQueue.createdAt))
          .limit(limit);

        res.set("Cache-Control", "no-store");
        res.json({
          rows: rows.map(r => ({
            ...r,
            durationMs: r.completedAt && r.leasedAt
              ? new Date(r.completedAt).getTime() - new Date(r.leasedAt).getTime()
              : null,
          })),
          generatedAt: new Date().toISOString(),
        });
      } catch (error: any) {
        console.error("[SEMrush console recent-jobs] failed:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get("/api/clients/:clientId/semrush-mapped-campaigns", isAuthenticated, async (req: any, res) => {
    try {
      const { clientId } = req.params;
      const rows = await db.select({
        id: semrushLocationCampaigns.id,
        locationId: semrushLocationCampaigns.locationId,
        semrushCampaignId: semrushLocationCampaigns.semrushCampaignId,
        semrushCampaignName: semrushLocationCampaigns.semrushCampaignName,
        locationName: clientLocations.name,
        locationAddress: clientLocations.address,
        locationCity: clientLocations.city,
        locationState: clientLocations.state,
      })
        .from(semrushLocationCampaigns)
        .innerJoin(clientLocations, eq(semrushLocationCampaigns.locationId, clientLocations.id))
        .where(eq(semrushLocationCampaigns.clientId, clientId));

      if (rows.length === 0) {
        return res.json({ campaigns: [], semrushAvailable: true });
      }

      let semrushAvailable = true;
      const uniqueCampaignIds = [...new Set(rows.map(r => r.semrushCampaignId))];

      let enrichedCampaigns: Array<{
        semrushCampaignId: string;
        semrushCampaignName: string | null;
        locationId: string;
        locationName: string | null;
        locationAddress: string | null;
        locationCity: string | null;
        locationState: string | null;
        businessName?: string;
        address?: string;
        gridSettings?: any;
      }> = [];

      let semrushDetails: Record<string, any> = {};
      try {
        const { listCampaigns } = await import("../services/semrushApi");
        const allCampaigns = await listCampaigns();
        for (const c of allCampaigns) {
          if (uniqueCampaignIds.includes(c.id)) {
            semrushDetails[c.id] = c;
          }
        }
      } catch (semrushErr: any) {
        semrushAvailable = false;
      }

      for (const row of rows) {
        const details = semrushDetails[row.semrushCampaignId];
        enrichedCampaigns.push({
          semrushCampaignId: row.semrushCampaignId,
          semrushCampaignName: row.semrushCampaignName,
          locationId: row.locationId,
          locationName: row.locationName,
          locationAddress: row.locationAddress,
          locationCity: row.locationCity,
          locationState: row.locationState,
          businessName: details?.businessName,
          address: details?.address,
          gridSettings: details?.gridSettings,
        });
      }

      res.json({ campaigns: enrichedCampaigns, semrushAvailable });
    } catch (error: any) {
      console.error("[Semrush] Mapped campaigns error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/clients/:clientId/semrush-location-campaigns", isAuthenticated, async (req: any, res) => {
    try {
      const { semrushLocationCampaigns } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(semrushLocationCampaigns)
        .where(eq(semrushLocationCampaigns.clientId, req.params.clientId));
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/clients/:clientId/semrush-location-campaigns", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { semrushLocationCampaigns, clientSemrushIntegrations, clientLocations } = await import("@shared/schema");
      const { eq, and, inArray } = await import("drizzle-orm");
      const { mappings } = req.body as {
        mappings: Array<{
          locationId: string;
          semrushCampaignId: string;
          semrushCampaignName?: string;
        }>;
      };

      if (!Array.isArray(mappings)) {
        return res.status(400).json({ error: "mappings array required" });
      }

      const clientId = req.params.clientId;

      // Task #1848 — fetch phase: validate the location IDs before
      // opening the persist transaction so the transaction window stays
      // pure DB-write work.
      if (mappings.length > 0) {
        const locationIds = [...new Set(mappings.map(m => m.locationId))];
        const validLocations = await withDbAttribution(
          "heatmap:mappings:validate",
          () => db.select({ id: clientLocations.id })
            .from(clientLocations)
            .where(and(
              eq(clientLocations.clientId, clientId),
              inArray(clientLocations.id, locationIds)
            )),
        );
        const validIds = new Set(validLocations.map(l => l.id));
        const invalid = locationIds.filter(id => !validIds.has(id));
        if (invalid.length > 0) {
          return res.status(400).json({ error: `Invalid location IDs: ${invalid.join(", ")}` });
        }
      }

      // Task #1848 — persist phase: short labelled DB-only transaction.
      await withDbAttribution("heatmap:mappings:persist", () => db.transaction(async (tx) => {
        await tx.delete(semrushLocationCampaigns)
          .where(eq(semrushLocationCampaigns.clientId, clientId));

        if (mappings.length > 0) {
          await tx.insert(semrushLocationCampaigns).values(
            mappings.map(m => ({
              clientId,
              locationId: m.locationId,
              semrushCampaignId: m.semrushCampaignId,
              semrushCampaignName: m.semrushCampaignName || null,
              isStale: false,
              staleSince: null,
            }))
          );
        }

        const existing = await tx.select().from(clientSemrushIntegrations)
          .where(eq(clientSemrushIntegrations.clientId, clientId))
          .limit(1);

        if (!existing[0] && mappings.length > 0) {
          await tx.insert(clientSemrushIntegrations).values({
            clientId,
            integrationEnabled: true,
          });
        }
      }));

      // Task #1208: the operator just rewrote the mapping set with
      // `isStale=false` rows, so any lingering "campaign(s) marked stale"
      // text on the integration warning is now obsolete. Clear it
      // immediately instead of waiting for the next sync wave to overwrite.
      try {
        const { clearStaleWarningIfResolved } = await import("../services/semrushStaleWarningClear");
        await clearStaleWarningIfResolved(clientId);
      } catch (e: any) {
        console.warn(`[Semrush] clearStaleWarningIfResolved failed (non-fatal): ${e?.message}`);
      }

      const rows = await db.select().from(semrushLocationCampaigns)
        .where(eq(semrushLocationCampaigns.clientId, clientId));
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/clients/:clientId/semrush-location-campaigns/auto-match", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { clientLocations, semrushLocationCampaigns, clientSemrushIntegrations } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const { haversineDistance, fuzzyBusinessNameMatch, fuzzyLocationMatch } = await import("../mcu/geocoding");
      const { listCampaigns, isEnrichmentComplete, forceRefreshCampaigns } = await import("../services/semrushApi");

      const clientId = req.params.clientId;

      // Task #2185: when the caller asks for a forced refresh (e.g. the
      // "Refresh campaigns from SEMrush" control), re-page + enrich the
      // campaign list synchronously BEFORE matching, so auto-match considers
      // campaigns created since the last background cache cycle instead of
      // reporting "ready" against a stale list.
      const forceRefresh = req.body?.forceRefresh === true;
      if (forceRefresh) {
        try {
          await forceRefreshCampaigns();
        } catch (err: any) {
          const msg = err?.message || "Failed to refresh campaigns from SEMrush";
          const msgLower = msg.toLowerCase();
          const isAuthError = msgLower.includes("not connected") || msgLower.includes("re-authorize") || msgLower.includes("token expired");
          console.error(`[AutoMatch] Forced refresh failed for client ${clientId}: ${msg}`);
          return res.status(isAuthError ? 401 : 502).json({ error: isAuthError ? "SEMrush not connected — please authorize via Integrations Hub" : `SEMrush API error — ${msg}. Please try again.` });
        }
      }

      // Task #1848 — fetch phase: pull every client-side input the
      // matching loops need under a single labelled scope. The external
      // SEMrush listCampaigns() + Haversine/fuzzy math below run with NO
      // DB connection held, then the persist block re-enters under
      // `heatmap:auto-match:persist`.
      const [locations, existingMappings] = await withDbAttribution(
        "heatmap:auto-match:fetch",
        () => Promise.all([
          db.select().from(clientLocations).where(eq(clientLocations.clientId, clientId)),
          db.select().from(semrushLocationCampaigns).where(eq(semrushLocationCampaigns.clientId, clientId)),
        ]),
      );

      if (locations.length === 0) {
        return res.json({ matched: [], unmatched: [], message: "No client locations found" });
      }

      // Task #2270 — test-only seam (no-op in production): runs after the
      // `locations` snapshot is captured and before the persist phase
      // re-reads `client_locations`, letting a deterministic test exercise
      // the unconfigured-parent review/suggestion branch.
      if (__autoMatchAfterFetchHookForTest) {
        await __autoMatchAfterFetchHookForTest();
      }

      if (!isEnrichmentComplete()) {
        const MAX_ENRICH_WAIT = 30;
        const POLL_INTERVAL = 2;
        let waited = 0;
        console.log(`[AutoMatch] Waiting for enrichment to complete before matching...`);
        // listCampaigns() here (and in the poll loop below) only warms the
        // enrichment cache; failures are retried each poll tick and surfaced
        // by the enrichment-complete gate, so silence is deliberate (F10).
        try { await listCampaigns(); } catch {}
        while (!isEnrichmentComplete() && waited < MAX_ENRICH_WAIT) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL * 1000));
          waited += POLL_INTERVAL;
          try { await listCampaigns(); } catch {}
        }
        if (!isEnrichmentComplete()) {
          console.warn(`[AutoMatch] Enrichment not complete after ${MAX_ENRICH_WAIT}s, returning not-ready`);
          return res.status(202).json({
            matched: [],
            unmatched: [],
            message: "Campaign enrichment still in progress. Please try again shortly.",
            status: "enriching",
          });
        }
      }

      let campaigns: any[];
      const MAX_RETRIES = 2;
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            const backoffMs = attempt * 1000;
            console.log(`[AutoMatch] Retry attempt ${attempt}/${MAX_RETRIES} after ${backoffMs}ms backoff`);
            await new Promise(r => setTimeout(r, backoffMs));
          }
          campaigns = await listCampaigns();
          lastError = null;
          break;
        } catch (err: any) {
          lastError = err;
          console.error(`[AutoMatch] listCampaigns attempt ${attempt + 1} failed:`, err?.message || err);
        }
      }

      if (lastError) {
        const msg = lastError?.message || "Unknown error";
        const msgLower = msg.toLowerCase();
        const isAuthError = msgLower.includes("not connected") || msgLower.includes("re-authorize") || msgLower.includes("token expired");
        const userMsg = isAuthError
          ? "SEMrush not connected — please authorize via Integrations Hub"
          : `SEMrush API error — ${msg}. Please try again.`;
        console.error(`[AutoMatch] All retries exhausted for listCampaigns: ${msg}`);
        return res.status(isAuthError ? 401 : 502).json({ error: userMsg });
      }

      console.log(`[AutoMatch] Fetched ${campaigns!.length} campaigns for client ${clientId}, ${locations.length} locations to match`);

      if (campaigns!.length === 0) {
        return res.json({ matched: [], unmatched: locations.map(l => l.id), message: "No Semrush campaigns available" });
      }

      const alreadyMappedCampaignIds = new Set(existingMappings.map(m => m.semrushCampaignId));

      // Per-#1062: a location is a *candidate* even if it already has one or
      // more SEMrush campaigns attached, because multi-practice-area firms
      // legitimately have several campaigns per office (Immigration + PI at
      // the same address, etc.). The campaign-centric matching loop below
      // only considers campaigns whose IDs are not in
      // `alreadyMappedCampaignIds`, so re-running auto-match never duplicates
      // an existing mapping but can backfill missing siblings.
      const candidateLocations = locations;
      const unmappedCampaignCount = campaigns!.filter((c: any) => !alreadyMappedCampaignIds.has(c.id)).length;
      if (unmappedCampaignCount === 0) {
        return res.json({ matched: [], unmatched: [], message: "All campaigns already mapped" });
      }

      const campaignsWithCoords = campaigns!.filter((c: any) => {
        const bp = c.gridSettings?.basePoint || c.gridSettings?.base_point
          || c.gridSettings?.centerPoint || c.gridSettings?.center_point;
        return bp?.lat != null && bp?.lng != null;
      });

      console.log(`[AutoMatch] ${campaignsWithCoords.length}/${campaigns!.length} campaigns have coordinates, ${candidateLocations.length} unmapped locations`);

      const MAX_MATCH_DISTANCE_MILES = 5;
      const matched: Array<{ locationId: string; locationName: string; campaignId: string; campaignName: string; distanceMiles: number; matchType: "proximity" | "name" | "location" }> = [];
      // Each SEMrush campaign attaches to at most one location, but a single
      // location can receive multiple campaigns. This is the intended shape:
      // a law firm office with two practice areas (e.g. Immigration + PI) has
      // two SEMrush campaigns sharing the same physical address, and both
      // should map to that one office so the sync worker pulls a heatmap for
      // each practice area. Pre-#1062 the loop iterated locations and added
      // each match's campaignId to a `usedCampaignIds` set, which silently
      // dropped every additional campaign at the same office after the first
      // one. We now iterate campaigns instead, find the best location for
      // each, and let a location collect as many campaigns as legitimately
      // match it.
      const matchedCampaignIds = new Set<string>(alreadyMappedCampaignIds);
      const matchedLocationIds = new Set<string>();

      const FUZZY_NAME_THRESHOLD = 0.6;
      const FUZZY_LOCATION_THRESHOLD = 0.4;

      const locationsWithCoords = candidateLocations.filter(l => l.lat != null && l.lng != null);
      const locationsMissingCoordsLog = candidateLocations.filter(l => l.lat == null || l.lng == null);
      for (const loc of locationsMissingCoordsLog) {
        console.log(`[AutoMatch] Location "${loc.name}" (${loc.id}) has no coordinates, will only be considered for name/location matching`);
      }

      // Pass 1 — proximity. For each unmapped campaign that has coords, find
      // the closest unmapped client location within MAX_MATCH_DISTANCE_MILES.
      for (const c of campaignsWithCoords) {
        if (matchedCampaignIds.has(c.id)) continue;
        const bp = c.gridSettings?.basePoint || c.gridSettings?.base_point
          || c.gridSettings?.centerPoint || c.gridSettings?.center_point;
        let bestLoc: { loc: typeof candidateLocations[number]; distance: number } | null = null;
        let closestDistance = Infinity;
        for (const loc of locationsWithCoords) {
          const dist = haversineDistance(loc.lat!, loc.lng!, Number(bp.lat), Number(bp.lng));
          if (dist < closestDistance) closestDistance = dist;
          if (dist <= MAX_MATCH_DISTANCE_MILES && (!bestLoc || dist < bestLoc.distance)) {
            bestLoc = { loc, distance: dist };
          }
        }
        console.log(`[AutoMatch] Campaign "${c.businessName}" (${c.id}): closest location distance=${closestDistance.toFixed(2)} miles, threshold=${MAX_MATCH_DISTANCE_MILES} miles, matched=${!!bestLoc}${bestLoc ? ` -> "${bestLoc.loc.name}" (${bestLoc.loc.id})` : ""}`);
        if (bestLoc) {
          matched.push({
            locationId: bestLoc.loc.id,
            locationName: bestLoc.loc.name,
            campaignId: c.id,
            campaignName: c.businessName,
            distanceMiles: Math.round(bestLoc.distance * 100) / 100,
            matchType: "proximity",
          });
          matchedCampaignIds.add(c.id);
          matchedLocationIds.add(bestLoc.loc.id);
        }
      }

      // Pass 2 — fuzzy business-name. For each remaining unmapped campaign,
      // find the best unmapped client location by business-name similarity.
      for (const c of campaigns!) {
        if (matchedCampaignIds.has(c.id)) continue;
        if (!c.businessName) continue;
        let bestNameMatch: { loc: typeof candidateLocations[number]; score: number } | null = null;
        let bestScore = 0;
        for (const loc of candidateLocations) {
          const score = fuzzyBusinessNameMatch(loc.name, c.businessName);
          if (score > bestScore) bestScore = score;
          if (score >= FUZZY_NAME_THRESHOLD && (!bestNameMatch || score > bestNameMatch.score)) {
            bestNameMatch = { loc, score };
          }
        }
        console.log(`[AutoMatch] Campaign "${c.businessName}" (${c.id}): best name score=${bestScore.toFixed(2)}, threshold=${FUZZY_NAME_THRESHOLD}, matched=${!!bestNameMatch}${bestNameMatch ? ` -> "${bestNameMatch.loc.name}" (${bestNameMatch.loc.id})` : ""}`);
        if (bestNameMatch) {
          matched.push({
            locationId: bestNameMatch.loc.id,
            locationName: bestNameMatch.loc.name,
            campaignId: c.id,
            campaignName: c.businessName,
            distanceMiles: -1,
            matchType: "name",
          });
          matchedCampaignIds.add(c.id);
          matchedLocationIds.add(bestNameMatch.loc.id);
        }
      }

      // Pass 3 — fuzzy location/address. For each still-unmapped campaign,
      // find the best unmapped client location by location/address similarity.
      for (const c of campaigns!) {
        if (matchedCampaignIds.has(c.id)) continue;
        const grid = c.gridSettings;
        const gridLocName = grid?.locationName || grid?.location_name || grid?.location || grid?.city || grid?.name || undefined;
        let bestLocMatch: { loc: typeof candidateLocations[number]; score: number } | null = null;
        let bestLocScore = 0;
        for (const loc of candidateLocations) {
          const score = fuzzyLocationMatch(
            { name: loc.name, city: loc.city, state: loc.state, address: loc.address },
            { location: c.location, address: c.address, gridLocationName: gridLocName }
          );
          if (score > bestLocScore) bestLocScore = score;
          if (score >= FUZZY_LOCATION_THRESHOLD && (!bestLocMatch || score > bestLocMatch.score)) {
            bestLocMatch = { loc, score };
          }
        }
        console.log(`[AutoMatch] Campaign "${c.businessName}" (${c.id}): best location score=${bestLocScore.toFixed(2)}, threshold=${FUZZY_LOCATION_THRESHOLD}, matched=${!!bestLocMatch}${bestLocMatch ? ` -> "${bestLocMatch.loc.name}" (${bestLocMatch.loc.id})` : ""}`);
        if (bestLocMatch) {
          matched.push({
            locationId: bestLocMatch.loc.id,
            locationName: bestLocMatch.loc.name,
            campaignId: c.id,
            campaignName: c.businessName,
            distanceMiles: -1,
            matchType: "location",
          });
          matchedCampaignIds.add(c.id);
          matchedLocationIds.add(bestLocMatch.loc.id);
        }
      }

      const unmatchedLocationIds: string[] = candidateLocations
        .filter(l => !matchedLocationIds.has(l.id))
        .map(l => l.id);

      let savedCount = 0;
      let alreadyMappedCount = 0;
      let queuedForReviewCount = 0;
      let staleConflictCount = 0;
      let droppedWarnings: Array<{ locationId: string; campaignId: string; reason: string }> = [];
      let queuedSuggestions: Array<{ locationId: string; campaignId: string; reason: string }> = [];

      if (matched.length > 0) {
        const autoSave = req.body?.autoSave !== false;
        if (autoSave) {
          // Task #1848 — persist phase: route the writes through a
          // labelled scope. `applyAutoMatchCandidates` and the
          // integration-row ensure step are pure DB work; no external
          // calls or fuzzy math happen inside this hold.
          await withDbAttribution("heatmap:auto-match:persist", async () => {
            // Task #920C: Route every candidate through the canonical helper so
            // configured-vs-unconfigured behavior, dedup, stale-conflict
            // handling, and review-queue routing stay identical across all
            // SEMrush mapping write sites. The aggregation lives in
            // `applyAutoMatchCandidates` so regression tests can pin the
            // outcome→counter mapping without standing up the HTTP stack.
            const { applyAutoMatchCandidates } = await import("../services/semrushLocationMappingWriter");
            const agg = await applyAutoMatchCandidates(clientId, matched);
            savedCount = agg.savedCount;
            alreadyMappedCount = agg.alreadyMappedCount;
            queuedForReviewCount = agg.queuedForReviewCount;
            staleConflictCount = agg.staleConflictCount;
            droppedWarnings = agg.droppedWarnings;
            queuedSuggestions = agg.queuedSuggestions;

            (res as any).locals = (res as any).locals || {};
            (res as any).locals.autoMatchWarnings = droppedWarnings;
            (res as any).locals.autoMatchSuggestions = queuedSuggestions;

            const existing = await db.select().from(clientSemrushIntegrations)
              .where(eq(clientSemrushIntegrations.clientId, clientId))
              .limit(1);
            if (!existing[0]) {
              await db.insert(clientSemrushIntegrations).values({
                clientId,
                integrationEnabled: true,
              });
            }
          });
        }
      }

      const coordMatches = matched.filter(m => m.matchType === "proximity").length;
      const nameMatches = matched.filter(m => m.matchType === "name").length;
      const locationMatches = matched.filter(m => m.matchType === "location").length;
      let message: string;
      if (matched.length === 0) {
        message = "No matches found";
      } else {
        const parts: string[] = [];
        if (coordMatches > 0) parts.push(`${coordMatches} by proximity`);
        if (nameMatches > 0) parts.push(`${nameMatches} by business name`);
        if (locationMatches > 0) parts.push(`${locationMatches} by location`);
        message = `Auto-matched ${matched.length} location${matched.length !== 1 ? "s" : ""} (${parts.join(", ")})`;
      }

      console.log(`[AutoMatch] Result for client ${clientId}: ${matched.length} matched (${coordMatches} proximity, ${nameMatches} name, ${locationMatches} location), ${unmatchedLocationIds.length} unmatched`);

      const autoMatchWarnings = ((res as any).locals?.autoMatchWarnings || []) as Array<{ locationId: string; campaignId: string; reason: string }>;
      const autoMatchSuggestions = ((res as any).locals?.autoMatchSuggestions || []) as Array<{ locationId: string; campaignId: string; reason: string }>;
      res.json({
        matched,
        unmatched: unmatchedLocationIds,
        message,
        warnings: autoMatchWarnings,
        queuedSuggestions: autoMatchSuggestions,
        savedCount,
        alreadyMappedCount,
        queuedForReviewCount,
        staleConflictCount,
      });
    } catch (error: any) {
      console.error("[AutoMatch]", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/clients/:clientId/local-dominance", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const { getLocalDominanceDashboard } = await import("../services/localDominanceService");
      const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
      const keyword = typeof req.query.keyword === "string" ? req.query.keyword : undefined;
      const data = await getLocalDominanceDashboard(req.params.clientId, campaignId, keyword);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/clients/:clientId/local-dominance/sov-history", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const { getClientSovTrend } = await import("../services/localDominanceService");
      const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
      const keyword = typeof req.query.keyword === "string" ? req.query.keyword : undefined;
      const months = parseInt(req.query.months as string) || 6;
      const data = await getClientSovTrend(req.params.clientId, campaignId, keyword, months);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/clients/:clientId/local-dominance/competitors", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const { heatmapSnapshots } = await import("@shared/schema");
      const { eq, and: andOp, desc: descOp } = await import("drizzle-orm");
      const { buildCompetitorLeaderboard, keywordNameMatchesSql } = await import("../services/localDominanceService");

      let conditions: any[] = [eq(heatmapSnapshots.clientId, req.params.clientId)];
      if (req.query.campaignId) conditions.push(eq(heatmapSnapshots.campaignId, req.query.campaignId));
      if (req.query.keyword) conditions.push(keywordNameMatchesSql(req.query.keyword));

      const snapshots = await db.select()
        .from(heatmapSnapshots)
        .where(andOp(...conditions))
        .orderBy(descOp(heatmapSnapshots.reportDate))
        .limit(1);

      if (!snapshots[0]) {
        return res.json([]);
      }

      const competitors = await buildCompetitorLeaderboard(snapshots[0].id);
      res.json(competitors);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/clients/:clientId/local-dominance/distribution", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const { heatmapSnapshots, heatmapMetrics } = await import("@shared/schema");
      const { eq, and: andOp, desc: descOp } = await import("drizzle-orm");
      const { keywordNameMatchesSql } = await import("../services/localDominanceService");

      let conditions: any[] = [eq(heatmapSnapshots.clientId, req.params.clientId)];
      if (req.query.campaignId) conditions.push(eq(heatmapSnapshots.campaignId, req.query.campaignId));
      if (req.query.keyword) conditions.push(keywordNameMatchesSql(req.query.keyword));

      const snapshots = await db.select()
        .from(heatmapSnapshots)
        .where(andOp(...conditions))
        .orderBy(descOp(heatmapSnapshots.reportDate))
        .limit(1);

      if (!snapshots[0]) {
        return res.json(null);
      }

      const metricsRows = await db.select()
        .from(heatmapMetrics)
        .where(eq(heatmapMetrics.snapshotId, snapshots[0].id))
        .limit(1);

      if (!metricsRows[0]) {
        return res.json(null);
      }

      const m = metricsRows[0];
      res.json({
        bandTop3Pct: m.bandTop3Pct ?? 0,
        band4to10Pct: m.band4to10Pct ?? 0,
        band11to20Pct: m.band11to20Pct ?? 0,
        bandOutOfTop20Pct: m.bandOutOfTop20Pct ?? 0,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/clients/:clientId/local-dominance/location-snapshots", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const { getPerLocationSnapshots } = await import("../services/localDominanceService");
      const keyword = typeof req.query.keyword === "string" ? req.query.keyword : undefined;
      const data = await getPerLocationSnapshots(req.params.clientId, keyword);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/clients/:clientId/local-dominance/keywords", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const { heatmapSnapshots, semrushLocationCampaigns } = await import("@shared/schema");
      const { eq, and: andOp, inArray, desc: descOp } = await import("drizzle-orm");
      const { normalizeKeyword } = await import("@shared/keywordNormalization");

      const mappings = await db.select({ campaignId: semrushLocationCampaigns.semrushCampaignId })
        .from(semrushLocationCampaigns)
        .where(eq(semrushLocationCampaigns.clientId, req.params.clientId));

      const activeCampaignIds = mappings.map(m => m.campaignId);

      if (activeCampaignIds.length === 0) {
        return res.json([]);
      }

      // Pull (keyword, campaign, date) tuples newest-first so that, when
      // deduping by the CANONICAL normalized keyword form, the most recently
      // synced raw spelling wins as the pill label. SEMrush returns the same
      // keyword under inconsistent casing/whitespace across campaigns and sync
      // dates ("immigration attorney" vs "Immigration Attorney"); deduping on
      // the raw text would surface the same keyword as multiple pills.
      const rows = await db.selectDistinct({
        keywordName: heatmapSnapshots.keywordName,
        campaignId: heatmapSnapshots.campaignId,
        reportDate: heatmapSnapshots.reportDate,
      })
        .from(heatmapSnapshots)
        .where(andOp(
          eq(heatmapSnapshots.clientId, req.params.clientId),
          inArray(heatmapSnapshots.campaignId, activeCampaignIds)
        ))
        .orderBy(descOp(heatmapSnapshots.reportDate));

      const byNormalized = new Map<string, { keyword: string; campaignId: string }>();
      for (const r of rows) {
        if (!r.keywordName) continue;
        const normalized = normalizeKeyword(r.keywordName);
        if (!normalized) continue;
        // First write wins; rows are newest-first so the label is the most
        // recent stored spelling. Selecting it still matches every variant
        // because the read paths compare on the normalized form.
        if (!byNormalized.has(normalized)) {
          byNormalized.set(normalized, { keyword: r.keywordName, campaignId: r.campaignId });
        }
      }
      res.json(Array.from(byNormalized.values()));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/local-dominance/sync-all", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { syncAllActiveClients } = await import("../services/localDominanceSyncWorker");
      const result = await syncAllActiveClients();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // HEATMAP ROUTES (authenticated)
  // ============================================

  app.get("/api/heatmaps/search", isAuthenticated, async (req: any, res) => {
    try {
      const { searchSnapshots } = await import("../services/heatmapService");
      const search = typeof req.query.q === "string" ? req.query.q : undefined;
      const limit = parseInt(req.query.limit as string) || 50;
      const results = await searchSnapshots({ search, limit });
      res.json(results.map(s => ({ ...s, rawPayload: undefined, geojsonCache: undefined })));
    } catch (error) {
      console.error("[Heatmap] Search error:", error);
      res.status(500).json({ error: "Failed to search heatmaps" });
    }
  });

  app.get("/api/heatmaps/locations", isAuthenticated, async (req: any, res) => {
    try {
      const { getAllDistinctLocations } = await import("../services/heatmapService");
      const locations = await getAllDistinctLocations();
      res.json(locations);
    } catch (error) {
      console.error("[Heatmap] Locations error:", error);
      res.status(500).json({ error: "Failed to list locations" });
    }
  });

  app.post("/api/heatmaps/import", isAuthenticated, async (req: any, res) => {
    try {
      const user = req.user;
      if (!user || !["ceo", "team_lead"].includes(user.role)) {
        return res.status(403).json({ error: "Only CEO and team leads can import heatmaps" });
      }

      const { importHeatmap } = await import("../services/heatmapService");
      const payload = req.body;

      if (!payload.locationId || !payload.campaignId || !payload.keywordName || !payload.points?.length) {
        return res.status(400).json({ error: "Missing required fields: locationId, campaignId, keywordName, points" });
      }
      if (!payload.businessLat || !payload.businessLng || !payload.baseLat || !payload.baseLng) {
        return res.status(400).json({ error: "Missing required coordinate fields" });
      }

      const result = await importHeatmap(payload);
      res.json(result);
    } catch (error) {
      console.error("[Heatmap] Import error:", error);
      res.status(500).json({ error: "Failed to import heatmap data" });
    }
  });

  app.post("/api/heatmaps/import-batch", isAuthenticated, async (req: any, res) => {
    try {
      const user = req.user;
      if (!user || !["ceo", "team_lead"].includes(user.role)) {
        return res.status(403).json({ error: "Only CEO and team leads can import heatmaps" });
      }

      const { importHeatmap } = await import("../services/heatmapService");
      const { snapshots } = req.body;

      if (!Array.isArray(snapshots) || snapshots.length === 0) {
        return res.status(400).json({ error: "Expected array of snapshots" });
      }

      const results = [];
      const errors = [];

      for (const payload of snapshots) {
        try {
          const result = await importHeatmap(payload);
          results.push({ locationId: payload.locationId, keyword: payload.keywordName, ...result });
        } catch (err: any) {
          errors.push({ locationId: payload.locationId, keyword: payload.keywordName, error: err.message });
        }
      }

      res.json({ imported: results.length, failed: errors.length, results, errors });
    } catch (error) {
      console.error("[Heatmap] Batch import error:", error);
      res.status(500).json({ error: "Failed to import heatmap batch" });
    }
  });

  // Task #4087: the GET /api/heatmaps/location/:locationId/latest route was
  // removed after the D-DEAD wave-2 operator notice window closed — zero
  // callers (the UI consumes heatmaps via search/import/:snapshotId/meta|geojson
  // and Local Dominance's per-client location-snapshots aggregate) and zero
  // prod invocations while heatmap_snapshots itself stays actively written.

  app.get("/api/heatmaps/location/:locationId/snapshots", isAuthenticated, async (req: any, res) => {
    try {
      const { getSnapshotsByLocation } = await import("../services/heatmapService");
      const snapshots = await getSnapshotsByLocation(req.params.locationId);
      res.json(snapshots.map(s => ({ ...s, rawPayload: undefined, geojsonCache: undefined })));
    } catch (error) {
      console.error("[Heatmap] List snapshots error:", error);
      res.status(500).json({ error: "Failed to list snapshots" });
    }
  });

  app.get("/api/heatmaps/:snapshotId/geojson", isAuthenticated, async (req: any, res) => {
    try {
      const { getSnapshotGeoJSON } = await import("../services/heatmapService");
      const mode = (req.query.mode === "movement" ? "movement" : "rank") as "rank" | "movement";
      const geojson = await getSnapshotGeoJSON(req.params.snapshotId, mode);
      if (!geojson) {
        return res.status(404).json({ error: "Snapshot not found" });
      }
      res.json(geojson);
    } catch (error) {
      console.error("[Heatmap] GeoJSON error:", error);
      res.status(500).json({ error: "Failed to generate GeoJSON" });
    }
  });

  app.get("/api/heatmaps/:snapshotId/meta", isAuthenticated, async (req: any, res) => {
    try {
      const { getSnapshot, getSnapshotMetrics } = await import("../services/heatmapService");
      const snapshot = await getSnapshot(req.params.snapshotId);
      if (!snapshot) {
        return res.status(404).json({ error: "Snapshot not found" });
      }
      const metrics = await getSnapshotMetrics(req.params.snapshotId);
      res.json({
        snapshot: { ...snapshot, rawPayload: undefined, geojsonCache: undefined },
        metrics,
      });
    } catch (error) {
      console.error("[Heatmap] Meta error:", error);
      res.status(500).json({ error: "Failed to fetch snapshot meta" });
    }
  });

  app.post("/api/heatmaps/backfill-bands", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { backfillRankDistributionBands } = await import("../services/localDominanceService");
      const result = await backfillRankDistributionBands();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/clients/:clientId/heatmap-snapshots-for-month", isAuthenticated, async (req: any, res) => {
    try {
      const { clientId } = req.params;
      const reportMonth = req.query.month as string;
      if (!reportMonth || !/^\d{4}-\d{2}$/.test(reportMonth)) {
        return res.status(400).json({ error: "month query param required in YYYY-MM format" });
      }
      const { getSnapshotIdsForReportMonth } = await import("../services/heatmapService");
      const mapping = await getSnapshotIdsForReportMonth(clientId, reportMonth);
      res.json(mapping);
    } catch (error: any) {
      console.error("[Heatmap] Error fetching snapshots for month:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/heatmaps/backfill-all", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { backfillAllDerivedMetrics } = await import("../services/localDominanceService");
      const result = await backfillAllDerivedMetrics();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  }
  
