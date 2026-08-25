import type { Express } from "express";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { canAccessRIS, canManageRIS } from "../auth/permissions";
import { z } from "zod";
import {
  insertRisCheckSchema,
  updateRisCheckSchema,
  insertRisCheckResultSchema,
  upsertRisAutoSourceMappingSchema,
  updateRisClientAutoSourceOverrideSchema,
  isStatusValidForLayer,
  risLayers,
  type User,
} from "@shared/schema";
import {
  buildClientChecklist,
  buildPortfolioRollup,
  buildClientPerformance,
  buildPortfolioPerformance,
  currentPeriod,
  resolveLaunchPeriodForSave,
} from "../services/ris/risService";
import { processRisResultFlag } from "../services/ris/risFlagging";
import { runRisAutoPull } from "../services/ris/risAutoPull";
import { runRisPerformancePull } from "../services/ris/risPerformancePull";

// Task #2367 — Revenue Integrity System (RIS) QA Layer routes. Reporting
// role owns the surface; the data-driven catalog is admin-editable.
export function registerRisRoutes(app: Express): void {
  async function loadUser(req: any, res: any): Promise<User | null> {
    const userId = req.user?.claims?.sub;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    const user = await storage.getUser(userId);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    return user;
  }

  function resolvePeriod(raw: unknown): string {
    if (typeof raw === "string" && /^\d{4}-\d{2}$/.test(raw)) return raw;
    return currentPeriod();
  }

  // Task #2388 — layer selector. Defaults to the QA layer so existing
  // callers (and the default dashboard view) are unchanged.
  function resolveLayer(raw: unknown): string {
    return typeof raw === "string" && (risLayers as readonly string[]).includes(raw)
      ? raw
      : "qa";
  }

  // ─── Catalog (read) ──────────────────────────────────────────────────
  app.get("/api/ris/checks", isAuthenticated, async (req: any, res) => {
    const user = await loadUser(req, res);
    if (!user) return;
    if (!(await canAccessRIS(user))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      const activeOnly = req.query.activeOnly === "true";
      const checks = await storage.listRisChecks({ activeOnly });
      res.json(checks);
    } catch (err: any) {
      console.error("[ris] listRisChecks failed:", err);
      res.status(500).json({ error: "Failed to load RIS checks" });
    }
  });

  // ─── Catalog (manage) ────────────────────────────────────────────────
  app.post("/api/ris/checks", isAuthenticated, async (req: any, res) => {
    const user = await loadUser(req, res);
    if (!user) return;
    if (!(await canManageRIS(user))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const parsed = insertRisCheckSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid check", details: parsed.error.flatten() });
    }
    try {
      const existing = await storage.getRisCheckByKey(parsed.data.key);
      if (existing) {
        return res.status(409).json({ error: "A check with that key already exists" });
      }
      const check = await storage.createRisCheck(parsed.data);
      res.status(201).json(check);
    } catch (err: any) {
      console.error("[ris] createRisCheck failed:", err);
      res.status(500).json({ error: "Failed to create check" });
    }
  });

  app.patch("/api/ris/checks/:id", isAuthenticated, async (req: any, res) => {
    const user = await loadUser(req, res);
    if (!user) return;
    if (!(await canManageRIS(user))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const parsed = updateRisCheckSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid update", details: parsed.error.flatten() });
    }
    try {
      const updated = await storage.updateRisCheck(req.params.id, parsed.data);
      if (!updated) return res.status(404).json({ error: "Check not found" });
      res.json(updated);
    } catch (err: any) {
      console.error("[ris] updateRisCheck failed:", err);
      res.status(500).json({ error: "Failed to update check" });
    }
  });

  app.post("/api/ris/checks/reorder", isAuthenticated, async (req: any, res) => {
    const user = await loadUser(req, res);
    if (!user) return;
    if (!(await canManageRIS(user))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const ids = req.body?.orderedIds;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) {
      return res.status(400).json({ error: "orderedIds must be a string array" });
    }
    try {
      await storage.reorderRisChecks(ids);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[ris] reorderRisChecks failed:", err);
      res.status(500).json({ error: "Failed to reorder checks" });
    }
  });

  // ─── Portfolio rollup ────────────────────────────────────────────────
  app.get("/api/ris/portfolio", isAuthenticated, async (req: any, res) => {
    const user = await loadUser(req, res);
    if (!user) return;
    if (!(await canAccessRIS(user))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      const period = resolvePeriod(req.query.period);
      const layer = resolveLayer(req.query.layer);
      const rollup = await buildPortfolioRollup(period, layer);
      res.json(rollup);
    } catch (err: any) {
      console.error("[ris] buildPortfolioRollup failed:", err);
      res.status(500).json({ error: "Failed to load RIS portfolio" });
    }
  });

  // ─── Per-client drilldown ────────────────────────────────────────────
  app.get(
    "/api/ris/clients/:clientId",
    isAuthenticated,
    async (req: any, res) => {
      const user = await loadUser(req, res);
      if (!user) return;
      if (!(await canAccessRIS(user))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      try {
        const period = resolvePeriod(req.query.period);
        const layer = resolveLayer(req.query.layer);
        const checklist = await buildClientChecklist(
          req.params.clientId,
          period,
          layer,
        );
        if (!checklist) return res.status(404).json({ error: "Client not found" });
        res.json(checklist);
      } catch (err: any) {
        console.error("[ris] buildClientChecklist failed:", err);
        res.status(500).json({ error: "Failed to load client checklist" });
      }
    },
  );

  // ─── Task #2371 — Performance Layer: portfolio Product Health roll-up ─
  app.get(
    "/api/ris/performance/portfolio",
    isAuthenticated,
    async (req: any, res) => {
      const user = await loadUser(req, res);
      if (!user) return;
      if (!(await canAccessRIS(user))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      try {
        const period = resolvePeriod(req.query.period);
        const rollup = await buildPortfolioPerformance(period);
        res.json(rollup);
      } catch (err: any) {
        console.error("[ris] buildPortfolioPerformance failed:", err);
        res.status(500).json({ error: "Failed to load RIS performance portfolio" });
      }
    },
  );

  // ─── Task #2371 — Performance Layer: per-client Product Health Cards ──
  app.get(
    "/api/ris/performance/clients/:clientId",
    isAuthenticated,
    async (req: any, res) => {
      const user = await loadUser(req, res);
      if (!user) return;
      if (!(await canAccessRIS(user))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      try {
        const period = resolvePeriod(req.query.period);
        const perf = await buildClientPerformance(req.params.clientId, period);
        if (!perf) return res.status(404).json({ error: "Client not found" });
        res.json(perf);
      } catch (err: any) {
        console.error("[ris] buildClientPerformance failed:", err);
        res.status(500).json({ error: "Failed to load client performance" });
      }
    },
  );

  // ─── Set / update a result ───────────────────────────────────────────
  app.post(
    "/api/ris/clients/:clientId/results",
    isAuthenticated,
    async (req: any, res) => {
      const user = await loadUser(req, res);
      if (!user) return;
      if (!(await canAccessRIS(user))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const body = { ...req.body, clientId: req.params.clientId };
      const parsed = insertRisCheckResultSchema.safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid result", details: parsed.error.flatten() });
      }
      try {
        const check = await storage.getRisCheck(parsed.data.checkId);
        if (!check) return res.status(404).json({ error: "Check not found" });

        // Guard against cross-layer writes: the result schema accepts the wide
        // risAllStatuses union (QA + performance), so a manual save could
        // otherwise pin a performance status (green/red) onto a QA check or
        // vice-versa, corrupting layer semantics and flagging. (Task #2371)
        if (!isStatusValidForLayer(check.layer, parsed.data.status)) {
          return res.status(400).json({
            error: `Status "${parsed.data.status}" is not valid for a ${check.layer} check`,
          });
        }

        // Normalize period to the catalog cadence. Launch-only checks resolve
        // to the SAME scoped period key expandInstances() renders/reads (via
        // the shared helper) so the saved result matches its instance instead
        // of a static "launch" sentinel that never lines up.
        const period =
          check.frequency === "launch_only"
            ? await resolveLaunchPeriodForSave(
                parsed.data.clientId,
                check.locationSpecific,
                parsed.data.locationId ?? null,
              )
            : resolvePeriod(parsed.data.period);

        const evidenceUrl =
          parsed.data.evidenceUrl === "" ? null : parsed.data.evidenceUrl ?? null;

        const outcome = await storage.setRisCheckResult(
          { ...parsed.data, period, evidenceUrl, locationId: parsed.data.locationId ?? null },
          user.id,
        );

        // Fire / resolve the escalation flag (best effort, non-blocking).
        let locationName: string | null = null;
        if (outcome.result.locationId) {
          const loc = await storage.getClientLocation(outcome.result.locationId);
          locationName = loc?.name ?? null;
        }
        const client = await storage.getClient(parsed.data.clientId);
        await processRisResultFlag({
          check,
          result: outcome.result,
          firmName: client?.firmName ?? "Client",
          locationName,
          previousStatus: outcome.previousStatus,
        });

        res.status(outcome.created ? 201 : 200).json(outcome.result);
      } catch (err: any) {
        console.error("[ris] setRisCheckResult failed:", err);
        res.status(500).json({ error: "Failed to save result" });
      }
    },
  );

  // ─── Task #2368 — On-demand BigQuery auto-pull ───────────────────────
  // Refreshes auto-sourced results for one client (or all active clients
  // when no clientId is supplied) for the given period. Anyone who can
  // view RIS can trigger a refresh; the writer never clobbers manual or
  // confirmed rows, and degrades unreachable/no-row to Needs Review.
  app.post("/api/ris/refresh", isAuthenticated, async (req: any, res) => {
    const user = await loadUser(req, res);
    if (!user) return;
    if (!(await canAccessRIS(user))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const clientId =
      typeof req.body?.clientId === "string" && req.body.clientId.length > 0
        ? req.body.clientId
        : undefined;
    const period = resolvePeriod(req.body?.period);
    try {
      // Drive both pulls: QA auto-pull (Pass/Fail) and the Performance pull
      // (color-coded period-over-period). Each writer skips manual/confirmed
      // rows and degrades unreachable data to its own "unknown" status.
      const [qa, performance] = await Promise.all([
        runRisAutoPull({ clientId, period }),
        runRisPerformancePull({ clientId, period }),
      ]);
      res.json({ qa, performance });
    } catch (err: any) {
      console.error("[ris] RIS refresh failed:", err);
      res.status(500).json({ error: "Failed to refresh auto-sourced results" });
    }
  });

  // ─── Task #2368 — Confirm an auto result (pins it; stops auto-pull) ───
  app.post(
    "/api/ris/results/:id/confirm",
    isAuthenticated,
    async (req: any, res) => {
      const user = await loadUser(req, res);
      if (!user) return;
      if (!(await canAccessRIS(user))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      try {
        const row = await storage.confirmRisResult(req.params.id, user.id);
        if (!row) return res.status(404).json({ error: "Result not found" });
        res.json(row);
      } catch (err: any) {
        console.error("[ris] confirmRisResult failed:", err);
        res.status(500).json({ error: "Failed to confirm result" });
      }
    },
  );

  // ─── Task #2368 — Auto-source mapping registry (manage) ──────────────
  // Returns existing mappings plus the distinct auto_source keys referenced
  // by the catalog that still have no mapping row, so the admin panel can
  // surface everything that needs configuring.
  app.get("/api/ris/auto-mappings", isAuthenticated, async (req: any, res) => {
    const user = await loadUser(req, res);
    if (!user) return;
    if (!(await canManageRIS(user))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      const [mappings, checks] = await Promise.all([
        storage.listRisAutoSourceMappings(),
        storage.listRisChecks({ activeOnly: false }),
      ]);
      const configured = new Set(mappings.map((m) => m.autoSource));
      const unmapped = Array.from(
        new Set(
          checks
            .map((c) => c.autoSource)
            .filter((s): s is string => !!s && !configured.has(s)),
        ),
      ).sort();
      res.json({ mappings, unmapped });
    } catch (err: any) {
      console.error("[ris] listRisAutoSourceMappings failed:", err);
      res.status(500).json({ error: "Failed to load auto-source mappings" });
    }
  });

  // Upsert keyed on the immutable autoSource (from the URL), so an admin
  // can configure a mapping that does not exist yet.
  app.put(
    "/api/ris/auto-mappings/:autoSource",
    isAuthenticated,
    async (req: any, res) => {
      const user = await loadUser(req, res);
      if (!user) return;
      if (!(await canManageRIS(user))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const parsed = upsertRisAutoSourceMappingSchema.safeParse({
        ...req.body,
        autoSource: req.params.autoSource,
      });
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid mapping", details: parsed.error.flatten() });
      }
      try {
        const row = await storage.upsertRisAutoSourceMapping(parsed.data);
        res.json(row);
      } catch (err: any) {
        console.error("[ris] upsertRisAutoSourceMapping failed:", err);
        res.status(500).json({ error: "Failed to save mapping" });
      }
    },
  );

  // ─── Task #2485 — Per-client BigQuery binding (managers only) ──────────
  //
  // The per-client BigQuery client key (bound as `@clientKey`) plus the
  // per-client overrides of the global auto-source mappings. All four
  // endpoints are gated by canManageRIS, mirroring the global mapping admin.

  // Returns one client's binding: its BigQuery client key + every override
  // row keyed by autoSource, so the Setup panel can render inherit-vs-override
  // per field against the global mappings the panel already loads.
  app.get(
    "/api/ris/client-bindings/:clientId",
    isAuthenticated,
    async (req: any, res) => {
      const user = await loadUser(req, res);
      if (!user) return;
      if (!(await canManageRIS(user))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      try {
        const client = await storage.getClient(req.params.clientId);
        if (!client) {
          return res.status(404).json({ error: "Client not found" });
        }
        const overrides = await storage.listRisClientAutoSourceOverrides(
          req.params.clientId,
        );
        res.json({
          clientId: client.id,
          firmName: client.firmName,
          bigQueryClientKey: client.bigQueryClientKey ?? null,
          overrides,
        });
      } catch (err: any) {
        console.error("[ris] get client-bindings failed:", err);
        res.status(500).json({ error: "Failed to load client binding" });
      }
    },
  );

  // Set (or clear) one client's BigQuery client key. Empty / whitespace-only
  // input clears it back to NULL (the pulls then degrade key-requiring
  // templates to Needs Review).
  app.put(
    "/api/ris/client-bindings/:clientId/bigquery-key",
    isAuthenticated,
    async (req: any, res) => {
      const user = await loadUser(req, res);
      if (!user) return;
      if (!(await canManageRIS(user))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const parsed = z
        .object({ bigQueryClientKey: z.string().nullable().optional() })
        .safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid key", details: parsed.error.flatten() });
      }
      const trimmed = parsed.data.bigQueryClientKey?.trim();
      const value = trimmed ? trimmed : null;
      try {
        const updated = await storage.updateClient(req.params.clientId, {
          bigQueryClientKey: value,
        });
        if (!updated) {
          return res.status(404).json({ error: "Client not found" });
        }
        res.json({ bigQueryClientKey: updated.bigQueryClientKey ?? null });
      } catch (err: any) {
        console.error("[ris] set bigquery-key failed:", err);
        res.status(500).json({ error: "Failed to save BigQuery client key" });
      }
    },
  );

  // Upsert one (client, autoSource) override. Override fields come from the
  // body; client + autoSource are the route params. Any omitted/null field
  // means "inherit the global mapping value".
  app.put(
    "/api/ris/client-bindings/:clientId/overrides/:autoSource",
    isAuthenticated,
    async (req: any, res) => {
      const user = await loadUser(req, res);
      if (!user) return;
      if (!(await canManageRIS(user))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const parsed = updateRisClientAutoSourceOverrideSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid override", details: parsed.error.flatten() });
      }
      try {
        const client = await storage.getClient(req.params.clientId);
        if (!client) {
          return res.status(404).json({ error: "Client not found" });
        }
        const row = await storage.upsertRisClientAutoSourceOverride({
          ...parsed.data,
          clientId: req.params.clientId,
          autoSource: req.params.autoSource,
        });
        res.json(row);
      } catch (err: any) {
        console.error("[ris] upsert client override failed:", err);
        res.status(500).json({ error: "Failed to save override" });
      }
    },
  );

  // Delete one (client, autoSource) override, reverting it to the global
  // mapping. Idempotent — deleting a non-existent override still 204s.
  app.delete(
    "/api/ris/client-bindings/:clientId/overrides/:autoSource",
    isAuthenticated,
    async (req: any, res) => {
      const user = await loadUser(req, res);
      if (!user) return;
      if (!(await canManageRIS(user))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      try {
        await storage.deleteRisClientAutoSourceOverride(
          req.params.clientId,
          req.params.autoSource,
        );
        res.status(204).end();
      } catch (err: any) {
        console.error("[ris] delete client override failed:", err);
        res.status(500).json({ error: "Failed to delete override" });
      }
    },
  );
}
