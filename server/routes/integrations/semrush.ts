/**
 * Integrations routes — SEMrush console mapping inventory / suggestions.
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 28–51, 7240–7867); sections: SEMrush console mapping inventory / suggestions; heatmap coverage gaps.
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { db } from "../../db";
import { eq, and, inArray, sql, desc } from "drizzle-orm";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager } from "../middleware";
import type { AuthenticatedRequest, TenantScopedRequest } from "../requestContext";
import {
  semrushLocationCampaigns,
  clientLocations,
  clients,
  importEntitySuggestions,
} from "@shared/schema";
import { applySemrushLocationMapping } from "../../services/semrushLocationMappingWriter";

/**
 * Parse a YYYY-MM-DD (or ISO) date query param into a UTC ms boundary.
 * `start` snaps to 00:00:00 UTC of that day; `end` snaps to 23:59:59.999 UTC.
 * Returns `null` for missing or unparseable inputs (treated as "no bound").
 */
function parseDateBoundary(
  raw: unknown,
  bound: "start" | "end",
): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymd) {
    const [, y, m, d] = ymd;
    const t =
      bound === "start"
        ? Date.UTC(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0)
        : Date.UTC(Number(y), Number(m) - 1, Number(d), 23, 59, 59, 999);
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function registerIntegrationsSemrushRoutes(app: Express) {
  // ============================================
  // SEMrush Console — Mapping inventory & suggestions (Task #936D)
  // ============================================

  // Inventory: list all semrush_location_campaigns rows joined with client +
  // location labels and an effective status (linked / stale / orphan-location).
  // Read-only; admin gating consistent with the other SEMrush console reads.
  app.get(
    "/api/integrations/semrush/mapping-inventory",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const search = String(req.query.search ?? "").trim().toLowerCase();
        const rows = await db
          .select({
            id: semrushLocationCampaigns.id,
            clientId: semrushLocationCampaigns.clientId,
            locationId: semrushLocationCampaigns.locationId,
            semrushCampaignId: semrushLocationCampaigns.semrushCampaignId,
            semrushCampaignName: semrushLocationCampaigns.semrushCampaignName,
            isStale: semrushLocationCampaigns.isStale,
            staleSince: semrushLocationCampaigns.staleSince,
            createdAt: semrushLocationCampaigns.createdAt,
            firmName: clients.firmName,
            locationName: clientLocations.name,
            locationCity: clientLocations.city,
            locationState: clientLocations.state,
            locationAddress: clientLocations.address,
            locationConfigured: sql<boolean>`${clientLocations.id} IS NOT NULL`,
          })
          .from(semrushLocationCampaigns)
          .leftJoin(clients, eq(clients.id, semrushLocationCampaigns.clientId))
          .leftJoin(
            clientLocations,
            and(
              eq(clientLocations.id, semrushLocationCampaigns.locationId),
              eq(clientLocations.clientId, semrushLocationCampaigns.clientId),
            ),
          )
          .orderBy(desc(semrushLocationCampaigns.createdAt))
          .limit(1000);

        const items = rows.map((r) => {
          const status: "linked" | "stale" | "orphan_location" = !r.locationConfigured
            ? "orphan_location"
            : r.isStale
            ? "stale"
            : "linked";
          return {
            id: r.id,
            clientId: r.clientId,
            firmName: r.firmName,
            locationId: r.locationId,
            locationLabel: r.locationName
              ? `${r.locationName}${r.locationCity ? ` — ${r.locationCity}${r.locationState ? `, ${r.locationState}` : ""}` : ""}`
              : null,
            locationAddress: r.locationAddress,
            locationConfigured: !!r.locationConfigured,
            semrushCampaignId: r.semrushCampaignId,
            semrushCampaignName: r.semrushCampaignName,
            isStale: r.isStale,
            staleSince: r.staleSince,
            createdAt: r.createdAt,
            status,
          };
        });

        const filtered = search
          ? items.filter((i) =>
              [
                i.firmName,
                i.locationLabel,
                i.locationAddress,
                i.semrushCampaignName,
                i.semrushCampaignId,
                i.clientId,
                i.locationId,
              ]
                .filter(Boolean)
                .some((v) => String(v).toLowerCase().includes(search)),
            )
          : items;

        res.json({
          items: filtered,
          totalCount: items.length,
          shownCount: filtered.length,
          counts: {
            linked: items.filter((i) => i.status === "linked").length,
            stale: items.filter((i) => i.status === "stale").length,
            orphanLocation: items.filter((i) => i.status === "orphan_location").length,
          },
        });
      } catch (error: any) {
        console.error("[SemrushConsole] mapping-inventory error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Suggestions: list pending location_mapping suggestions (the SEMrush slice
  // of import_entity_suggestions) with a per-row classification matching the
  // canonical writer's decision table.
  app.get(
    "/api/integrations/semrush/mapping-suggestions",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const search = String(req.query.search ?? "").trim().toLowerCase();
        const status = String(req.query.status ?? "pending");

        const suggestions = await db
          .select()
          .from(importEntitySuggestions)
          .where(
            and(
              eq(importEntitySuggestions.entityKind, "location_mapping"),
              eq(importEntitySuggestions.status, status),
            ),
          )
          .orderBy(desc(importEntitySuggestions.createdAt))
          .limit(1000);

        if (suggestions.length === 0) {
          return res.json({
            items: [],
            totalCount: 0,
            shownCount: 0,
            counts: { promotable: 0, blockedUnconfigured: 0, alreadyMapped: 0, staleConflict: 0, invalid: 0 },
          });
        }

        // Pre-load configured (clientId, locationId) pairs and existing
        // mapping rows so we can classify each suggestion in O(1) lookups.
        const allLocs = await db
          .select({ id: clientLocations.id, clientId: clientLocations.clientId })
          .from(clientLocations);
        const configuredKey = new Set(allLocs.map((l) => `${l.clientId}::${l.id}`));

        const allMappings = await db
          .select({
            id: semrushLocationCampaigns.id,
            clientId: semrushLocationCampaigns.clientId,
            locationId: semrushLocationCampaigns.locationId,
            semrushCampaignId: semrushLocationCampaigns.semrushCampaignId,
            isStale: semrushLocationCampaigns.isStale,
          })
          .from(semrushLocationCampaigns);
        type MappingRow = (typeof allMappings)[number];
        const mappingByTriple = new Map<string, MappingRow[]>();
        for (const m of allMappings) {
          const k = `${m.clientId}::${m.locationId}::${m.semrushCampaignId}`;
          const arr = mappingByTriple.get(k) ?? [];
          arr.push(m);
          mappingByTriple.set(k, arr);
        }

        const clientIds = [...new Set(suggestions.map((s) => s.clientId))];
        const clientRows = clientIds.length
          ? await db
              .select({ id: clients.id, firmName: clients.firmName })
              .from(clients)
              .where(inArray(clients.id, clientIds))
          : [];
        const clientMap = new Map(clientRows.map((c) => [c.id, c.firmName]));

        const locationIds = [
          ...new Set(
            suggestions
              .map((s) => {
                const c = (s.candidate as Record<string, unknown> | null) ?? {};
                return typeof c.locationId === "string" ? c.locationId : null;
              })
              .filter((id): id is string => !!id),
          ),
        ];
        const locRows = locationIds.length
          ? await db
              .select({
                id: clientLocations.id,
                name: clientLocations.name,
                city: clientLocations.city,
                state: clientLocations.state,
              })
              .from(clientLocations)
              .where(inArray(clientLocations.id, locationIds))
          : [];
        const locMap = new Map(locRows.map((l) => [l.id, l]));

        type Classification =
          | "promotable"
          | "blocked_unconfigured"
          | "already_mapped"
          | "stale_conflict"
          | "invalid";

        const items = suggestions.map((s) => {
          const candidate = (s.candidate as Record<string, unknown> | null) ?? {};
          const locationId =
            typeof candidate.locationId === "string" ? candidate.locationId : null;
          const semrushCampaignId =
            typeof candidate.semrushCampaignId === "string"
              ? candidate.semrushCampaignId
              : null;
          const semrushCampaignName =
            typeof candidate.semrushCampaignName === "string"
              ? candidate.semrushCampaignName
              : null;

          let classification: Classification = "invalid";
          let canApprove = false;
          let canReject = true;
          let note: string | null = null;

          if (!locationId || !semrushCampaignId) {
            classification = "invalid";
            note = "candidate missing locationId or semrushCampaignId";
          } else if (!configuredKey.has(`${s.clientId}::${locationId}`)) {
            classification = "blocked_unconfigured";
            note = "parent (clientId, locationId) is not configured";
          } else {
            const triple = `${s.clientId}::${locationId}::${semrushCampaignId}`;
            const existing = mappingByTriple.get(triple) ?? [];
            const live = existing.find((r) => !r.isStale);
            if (live) {
              classification = "already_mapped";
              note = "a non-stale mapping row already exists";
              canApprove = true; // approving will mark suggestion promoted, no insert
            } else if (existing.length > 0) {
              classification = "stale_conflict";
              note = "only a stale mapping row exists; cannot auto-revive";
            } else {
              classification = "promotable";
              canApprove = true;
            }
          }

          const loc = locationId ? locMap.get(locationId) : null;
          return {
            id: s.id,
            clientId: s.clientId,
            firmName: clientMap.get(s.clientId) ?? null,
            surface: s.surface,
            reason: s.reason,
            createdAt: s.createdAt,
            candidate: {
              locationId,
              semrushCampaignId,
              semrushCampaignName,
            },
            locationLabel: loc
              ? `${loc.name}${loc.city ? ` — ${loc.city}${loc.state ? `, ${loc.state}` : ""}` : ""}`
              : null,
            classification,
            canApprove,
            canReject,
            note,
          };
        });

        const filtered = search
          ? items.filter((i) =>
              [
                i.firmName,
                i.locationLabel,
                i.candidate.semrushCampaignName,
                i.candidate.semrushCampaignId,
                i.clientId,
                i.candidate.locationId,
              ]
                .filter(Boolean)
                .some((v) => String(v).toLowerCase().includes(search)),
            )
          : items;

        res.json({
          items: filtered,
          totalCount: items.length,
          shownCount: filtered.length,
          counts: {
            promotable: items.filter((i) => i.classification === "promotable").length,
            blockedUnconfigured: items.filter((i) => i.classification === "blocked_unconfigured").length,
            alreadyMapped: items.filter((i) => i.classification === "already_mapped").length,
            staleConflict: items.filter((i) => i.classification === "stale_conflict").length,
            invalid: items.filter((i) => i.classification === "invalid").length,
          },
        });
      } catch (error: any) {
        console.error("[SemrushConsole] mapping-suggestions error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Approve a single SEMrush location_mapping suggestion. Goes through the
  // canonical write helper (`applySemrushLocationMapping`) so the import
  // write policy and stale/conflict rules apply identically to the
  // auto-match endpoint and the inventory-sync worker.
  app.post(
    "/api/integrations/semrush/mapping-suggestions/:id/approve",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest<{ id: string }>, res) => {
      try {
        const userId = req.user?.claims?.sub || req.user?.id || null;
        const { id } = req.params;
        const [sug] = await db
          .select()
          .from(importEntitySuggestions)
          .where(eq(importEntitySuggestions.id, id))
          .limit(1);
        if (!sug) return res.status(404).json({ error: "Suggestion not found" });
        if (sug.entityKind !== "location_mapping") {
          return res
            .status(400)
            .json({ error: "Only location_mapping suggestions are handled here" });
        }
        if (sug.status !== "pending") {
          return res.status(409).json({ error: `Suggestion is not pending (status=${sug.status})` });
        }
        const candidate = (sug.candidate as Record<string, unknown> | null) ?? {};
        const locationId =
          typeof candidate.locationId === "string" ? candidate.locationId : null;
        const semrushCampaignId =
          typeof candidate.semrushCampaignId === "string"
            ? candidate.semrushCampaignId
            : null;
        if (!locationId || !semrushCampaignId) {
          return res.status(400).json({
            error: "Suggestion candidate missing locationId or semrushCampaignId",
          });
        }
        const semrushCampaignName =
          typeof candidate.semrushCampaignName === "string"
            ? candidate.semrushCampaignName
            : null;
        const matchType =
          typeof candidate.matchType === "string" ? candidate.matchType : null;
        const sourceSurface =
          sug.surface === "local_dominance_sync" ? "local_dominance_sync" : "semrush_inventory";

        const outcome = await applySemrushLocationMapping({
          clientId: sug.clientId,
          locationId,
          semrushCampaignId,
          semrushCampaignName,
          source: {
            surface: sourceSurface as "semrush_inventory" | "local_dominance_sync",
            sourceRef: { route: "semrush_console.approve", suggestionId: sug.id },
            matchType,
          },
        });

        let suggestionStatus: "promoted" | "pending" = "pending";
        let promotedEntityId: string | null = null;
        let httpStatus = 200;
        let message = "";
        switch (outcome.kind) {
          case "saved":
            suggestionStatus = "promoted";
            promotedEntityId = outcome.row.id;
            message = "Mapping created.";
            break;
          case "already_mapped":
            suggestionStatus = "promoted";
            promotedEntityId = outcome.row.id;
            message = "Mapping already existed; suggestion marked promoted.";
            break;
          case "queued_for_review":
          case "invalid_parent":
            httpStatus = 409;
            message = "Approval blocked: parent (clientId, locationId) is not configured.";
            break;
          case "stale_conflict":
            httpStatus = 409;
            message = "Approval blocked: only a stale mapping exists; cannot auto-revive.";
            break;
          case "blocked":
            httpStatus = 409;
            message = `Approval blocked by policy: ${outcome.reason}`;
            break;
        }

        if (suggestionStatus === "promoted") {
          await db
            .update(importEntitySuggestions)
            .set({
              status: "promoted",
              promotedEntityId,
              reviewedByUserId: userId,
              reviewedAt: new Date(),
            })
            .where(eq(importEntitySuggestions.id, sug.id));
        }

        res.status(httpStatus).json({
          ok: httpStatus === 200,
          outcome: outcome.kind,
          message,
          promotedEntityId,
          suggestionId: sug.id,
        });
      } catch (error: any) {
        console.error("[SemrushConsole] approve error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Reject a single SEMrush location_mapping suggestion. Marks the row
  // `dismissed` and stamps the reviewer + timestamp; never mutates
  // `semrush_location_campaigns`.
  app.post(
    "/api/integrations/semrush/mapping-suggestions/:id/reject",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest<{ id: string }>, res) => {
      try {
        const userId = req.user?.claims?.sub || req.user?.id || null;
        const { id } = req.params;
        const [sug] = await db
          .select()
          .from(importEntitySuggestions)
          .where(eq(importEntitySuggestions.id, id))
          .limit(1);
        if (!sug) return res.status(404).json({ error: "Suggestion not found" });
        if (sug.entityKind !== "location_mapping") {
          return res
            .status(400)
            .json({ error: "Only location_mapping suggestions are handled here" });
        }
        if (sug.status !== "pending") {
          return res.status(409).json({ error: `Suggestion is not pending (status=${sug.status})` });
        }
        await db
          .update(importEntitySuggestions)
          .set({
            status: "dismissed",
            reviewedByUserId: userId,
            reviewedAt: new Date(),
          })
          .where(eq(importEntitySuggestions.id, sug.id));
        res.json({ ok: true, suggestionId: sug.id, message: "Suggestion dismissed." });
      } catch (error: any) {
        console.error("[SemrushConsole] reject error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // ============================================
  // Heatmap coverage gaps (Task #652)
  // ============================================

  // Per-location coverage summary across the SEMrush mapping inventory.
  // Reads can be slow because they hit SEMrush per campaign — the service
  // caches both per-campaign metadata and the assembled result for a few
  // minutes. Pass `?force=true` to bypass the result cache (campaign
  // metadata is still cached at the campaign level).
  app.get(
    "/api/integrations/semrush/heatmap-coverage",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const { computeHeatmapCoverage } = await import(
          "../../services/heatmapCoverage"
        );
        const force = req.query.force === "true" || req.query.force === "1";
        const includeRows =
          req.query.includeRows === "true" || req.query.includeRows === "1";
        const sinceMs = parseDateBoundary(req.query.since, "start");
        const untilMs = parseDateBoundary(req.query.until, "end");
        const result = await computeHeatmapCoverage(
          { sinceMs, untilMs },
          { force },
        );
        // The panel only needs aggregate/per-location data; trim the row
        // payload by default to keep the response small for large inventories.
        const { rows, ...rest } = result;
        res.json(includeRows ? result : rest);
      } catch (error: any) {
        console.error("[SemrushConsole] heatmap-coverage error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Per-(client, location) drill-down with the specific gap report dates and
  // pre-computed per-campaign rerun windows.
  app.get(
    "/api/integrations/semrush/heatmap-coverage/:clientId/:locationId",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const { getLocationDrilldown } = await import(
          "../../services/heatmapCoverage"
        );
        const force = req.query.force === "true" || req.query.force === "1";
        const sinceMs = parseDateBoundary(req.query.since, "start");
        const untilMs = parseDateBoundary(req.query.until, "end");
        const drilldown = await getLocationDrilldown(
          req.params.clientId,
          req.params.locationId,
          { force, sinceMs, untilMs },
        );
        res.json(drilldown);
      } catch (error: any) {
        console.error("[SemrushConsole] heatmap-coverage drilldown error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // One-click "re-run backfill for these gaps" for a given (client, location).
  // Always live (confirm=true under the hood) — the UI funnels the operator
  // through a confirm step before calling this endpoint. Calls
  // `backfillLocationHeatmaps` once per gap-window campaign with the
  // narrowest since/until span the drilldown produced. Coverage cache is
  // invalidated so the panel reflects the new state on the next refresh.
  // Force a fresh metadata fetch for a single SEMrush campaign and report
  // whether the live call worked or whether we fell back to the persisted
  // last-known-good snapshot. Used by the inconclusive-row "Refresh metadata"
  // button so operators can re-try a campaign without waiting for the next
  // panel-wide refresh. Coverage cache is invalidated on the way out.
  app.post(
    "/api/integrations/semrush/heatmap-coverage/campaign/:campaignId/refresh-metadata",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest<{ campaignId: string }>, res) => {
      try {
        const { refreshCampaignMetadata } = await import(
          "../../services/heatmapCoverage"
        );
        const meta = await refreshCampaignMetadata(req.params.campaignId);
        res.json({
          campaignId: req.params.campaignId,
          reportDateCount: meta.reportDates.length,
          activeKeywordCount: meta.activeKeywordCount,
          campaignError: meta.campaignError ?? null,
          keywordError: meta.keywordError ?? null,
          usedCachedMetadata: !!meta.usedCachedMetadata,
          cachedMetadataAt: meta.cachedMetadataAt ?? null,
          live: !meta.campaignError && !meta.keywordError,
        });
      } catch (error: any) {
        console.error(
          "[SemrushConsole] heatmap-coverage refresh-metadata error:",
          error,
        );
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/api/integrations/semrush/heatmap-coverage/:clientId/:locationId/rerun",
    isAuthenticated,
    requireAccountManager,
    async (req: TenantScopedRequest<{ clientId: string; locationId: string }>, res) => {
      try {
        const { getLocationDrilldown, invalidateHeatmapCoverageCache } =
          await import("../../services/heatmapCoverage");
        const { backfillLocationHeatmaps } = await import(
          "../../services/semrushInventorySync"
        );
        const { clientId, locationId } = req.params;
        const sinceMs = parseDateBoundary(req.query.since, "start");
        const untilMs = parseDateBoundary(req.query.until, "end");
        const drilldown = await getLocationDrilldown(clientId, locationId, {
          force: true,
          sinceMs,
          untilMs,
        });
        if (drilldown.gapWindows.length === 0) {
          return res.json({
            ok: true,
            ranWindows: 0,
            message: "No actionable gaps for this location.",
            results: [],
          });
        }
        const results: Array<{
          campaignId: string;
          sinceDate: string;
          untilDate: string;
          jobId: string | null;
          enqueued: number;
        }> = [];
        for (const w of drilldown.gapWindows) {
          if (!w.sinceDate || !w.untilDate) continue;
          const r = await backfillLocationHeatmaps({
            clientIds: [clientId],
            locationIds: [locationId],
            campaignIds: [w.campaignId],
            sinceDate: w.sinceDate,
            untilDate: w.untilDate,
            dryRun: false,
            triggeredBy:
              req.user?.claims?.sub || req.user?.id
                ? String(req.user?.claims?.sub || req.user?.id)
                : null,
          });
          results.push({
            campaignId: w.campaignId,
            sinceDate: w.sinceDate,
            untilDate: w.untilDate,
            jobId: r.jobId ?? null,
            enqueued: r.enqueuedJobCount,
          });
        }
        invalidateHeatmapCoverageCache();
        res.json({
          ok: true,
          ranWindows: results.length,
          totalEnqueued: results.reduce((s, x) => s + x.enqueued, 0),
          results,
        });
      } catch (error: any) {
        console.error("[SemrushConsole] heatmap-coverage rerun error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

}
