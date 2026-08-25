import type { Express, Response, NextFunction } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { isAuthenticated } from "../middlewares/requireAuth";
import { getCachedSummary, triggerRefresh } from "../mcu/worker";
import { computeHexGridForState } from "../mcu/hexgrid";
import { evaluateForSales, evaluateForInternal, getMarketSummary } from "../mcu";
import { clientLocations, mcuEvaluations, insertMcuEvaluationSchema, mcuPracticeAreas } from "@shared/schema";

export function registerMcuRoutes(app: Express) {

  app.get("/api/mcu/practice-areas", (_req, res) => {
    res.json(mcuPracticeAreas);
  });

  app.post("/api/mcu/evaluate", async (req: any, res) => {
    try {
      const { addresses, practiceArea } = req.body;

      if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
        return res.status(400).json({ error: "Addresses array is required" });
      }
      if (!practiceArea) {
        return res.status(400).json({ error: "Practice area is required" });
      }

      const result = await evaluateForSales({ addresses, practiceArea });

      const userId = req.user?.id || null;
      const firstResult = result.results[0];
      await db.insert(mcuEvaluations).values({
        userId,
        evaluationType: "sales",
        practiceArea,
        addresses,
        results: result,
        verdict: firstResult?.verdict,
      });

      res.json(result);
    } catch (error) {
      console.error("MCU evaluate error:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  const requireInternal = async (req: any, res: Response, next: NextFunction) => {
    if (!req.user?.claims?.sub) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const user = await storage.getUser(req.user.claims.sub);
      if (!user) {
        return res.status(401).json({ message: "Unauthorized" });
      }
      (req as any).dbUser = user;
      next();
    } catch (err) {
      console.error("[MCU] Auth check error:", err);
      res.status(500).json({ error: "Server error" });
    }
  };

  app.post("/api/mcu/internal/evaluate", isAuthenticated, requireInternal, async (req: any, res) => {
    try {
      const { addresses, practiceArea } = req.body;

      if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
        return res.status(400).json({ error: "Addresses array is required" });
      }
      if (!practiceArea) {
        return res.status(400).json({ error: "Practice area is required" });
      }

      const result = await evaluateForInternal({ addresses, practiceArea });

      await db.insert(mcuEvaluations).values({
        userId: req.user.claims.sub,
        evaluationType: "internal",
        practiceArea,
        addresses,
        results: result,
        verdict: result.results[0]?.verdict,
        mcuTotal: result.results[0]?.mcuTotal,
        mcuAllocated: result.results[0]?.mcuAllocated,
        mcuRemaining: result.results[0]?.mcuRemaining,
        overlapRisk: result.results[0]?.overlapRisk,
        scarcityLabel: result.results[0]?.scarcityLabel,
      });

      res.json(result);
    } catch (error) {
      console.error("MCU internal evaluate error:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/mcu/internal/summary", isAuthenticated, requireInternal, (req: any, res) => {
    try {
      const { state, practice } = req.query;
      const cached = getCachedSummary();

      let responseStatus = cached.status;
      let data = cached.data;

      if (cached.status === 'computing' && data) {
        responseStatus = 'refreshing';
      }

      if (!data) {
        data = [];
      }

      let filtered = [...data];
      if (state) {
        filtered = filtered.filter(s => s.state === state);
      }
      if (practice) {
        filtered = filtered
          .map(s => ({
            ...s,
            practices: s.practices.filter(p => p.practiceArea === practice),
          }))
          .filter(s => s.practices.length > 0);
      }

      res.json({
        status: responseStatus,
        lastComputedAt: cached.lastComputedAt,
        progress: cached.progress,
        percent: cached.percent,
        etaSeconds: cached.etaSeconds,
        error: cached.error,
        isComputing: cached.isComputing,
        data: filtered,
      });
    } catch (error) {
      console.error("MCU summary error:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/mcu/internal/summary/refresh", isAuthenticated, requireInternal, async (req: any, res) => {
    const { clearRadii, clearProbeCache } = req.body || {};

    if (clearRadii) {
      try {
        await db.update(clientLocations).set({
          radiusCore: null,
          radiusExtended: null,
          radiusFringe: null,
          competitorsInR2: null,
          radiusMarket: null,
        });
        console.log("[MCU] Cleared all stored radii + R_market - will recompute with probe search");
      } catch (e) {
        console.warn("[MCU] Failed to clear radii:", e);
      }
    }

    if (clearProbeCache) {
      const { clearAllProbeCache } = await import("../mcu/cache");
      await clearAllProbeCache();
      console.log("[MCU] Cleared all probe search cache");
    }

    const forceProbe = !!(clearRadii);
    triggerRefresh(forceProbe);
    res.json({ ok: true, message: "Refresh triggered", clearedRadii: !!clearRadii, clearedProbeCache: !!clearProbeCache });
  });

  app.get("/api/mcu/internal/hex-grid", isAuthenticated, requireInternal, async (req: any, res) => {
    try {
      const { state, practice } = req.query;
      if (!state) {
        return res.status(400).json({ error: "State parameter is required" });
      }
      const result = await computeHexGridForState(state as string, practice as string | undefined);
      if (!result) {
        return res.json({ hexes: [], locations: [], practiceArea: practice || "", marketCapacityPercent: 0 });
      }
      res.json(result);
    } catch (error) {
      console.error("MCU hex grid error:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/config/maptiler-key", isAuthenticated, (_req: any, res) => {
    const key = process.env.MAPTILER_API_KEY || "";
    if (!key) {
      return res.status(500).json({ error: "MAPTILER_API_KEY not configured" });
    }
    res.json({ key });
  });

  app.get("/api/public/config/maptiler-key", (_req, res) => {
    const key = process.env.MAPTILER_API_KEY || "";
    if (!key) {
      return res.status(500).json({ error: "MAPTILER_API_KEY not configured" });
    }
    res.json({ key });
  });

  app.get("/api/mcu/internal/hex-grid-geojson", isAuthenticated, requireInternal, async (req: any, res) => {
    try {
      const { state, practice } = req.query;
      if (!state) {
        return res.status(400).json({ error: "State parameter is required" });
      }
      const result = await computeHexGridForState(state as string, practice as string | undefined);
      if (!result) {
        return res.json({
          hexes: { type: "FeatureCollection", features: [] },
          heatPoints: { type: "FeatureCollection", features: [] },
          pins: { type: "FeatureCollection", features: [] },
          practiceArea: practice || "",
          marketCapacityPercent: 0,
        });
      }

      const hexFeatures = result.hexes.map(hex => ({
        type: "Feature" as const,
        properties: {
          hexId: hex.hexId,
          capacityUsedPercent: hex.capacityUsedPercent,
          status: hex.status,
          statusColor: hex.statusColor,
          effectiveClients: hex.effectiveClients,
          contributors: hex.contributors,
        },
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [...hex.vertices.map(([lat, lng]) => [lng, lat]), [hex.vertices[0][1], hex.vertices[0][0]]],
          ],
        },
      }));

      const heatFeatures = result.hexes.map(hex => ({
        type: "Feature" as const,
        properties: {
          weight: Math.max(0.01, hex.capacityUsedPercent / 100),
          capacityUsedPercent: hex.capacityUsedPercent,
          status: hex.status,
        },
        geometry: {
          type: "Point" as const,
          coordinates: [hex.centerLng, hex.centerLat],
        },
      }));

      const pinFeatures = result.locations.map(loc => ({
        type: "Feature" as const,
        properties: {
          locationId: loc.locationId,
          clientId: loc.clientId,
          clientName: loc.clientName,
          city: loc.city,
          r2Radius: loc.r2Radius,
          practiceAreas: loc.practiceAreas,
          radiusDiagnostics: loc.radiusDiagnostics || null,
        },
        geometry: {
          type: "Point" as const,
          coordinates: [loc.lng, loc.lat],
        },
      }));

      res.json({
        hexes: { type: "FeatureCollection", features: hexFeatures },
        heatPoints: { type: "FeatureCollection", features: heatFeatures },
        pins: { type: "FeatureCollection", features: pinFeatures },
        practiceArea: result.practiceArea,
        marketCapacityPercent: result.marketCapacityPercent,
      });
    } catch (error) {
      console.error("MCU hex grid GeoJSON error:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/mcu/internal/evaluations", isAuthenticated, requireInternal, async (req: any, res) => {
    try {
      const evaluations = await db
        .select()
        .from(mcuEvaluations)
        .orderBy(mcuEvaluations.createdAt)
        .limit(100);
      res.json(evaluations);
    } catch (error) {
      console.error("MCU evaluations error:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  }
  