/**
 * Task #1804 — Universal "Apply pending prod writes" routes.
 *
 * Two endpoints gated by `isAuthenticated` plus an inline CEO check
 * (mirrors how `canAccessCEOPulse` is enforced elsewhere — see
 * `server/auth/permissions.ts`). Non-CEO users get a 403; the panel on
 * the client renders nothing in that case.
 */
import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { isAuthenticated } from "../middlewares/requireAuth";
import { getAssignedAuthority } from "../auth/permissions";
import { storage } from "../storage";
import {
  getProdActionStatuses,
  applyAllProdActions,
  applyOneProdAction,
} from "../services/prodActionsRegistry";
import {
  setFailureAlertThreshold,
  FAILURE_ALERT_THRESHOLD_MIN,
  FAILURE_ALERT_THRESHOLD_CAP,
} from "../services/prodActionSelfHeal";
import {
  listProdActionRuns,
  ensureProdActionRunsTable,
} from "../storage/prodActionRuns";
import { runWithWorkerDb } from "../db";

/**
 * Strict CEO gate — bypasses `role_permissions_permissive_mode`. Uses
 * `getAssignedAuthority` (legacy-role-aware but NOT permissive-aware)
 * so non-CEO users get a hard 403 even when permissive mode is on.
 */
async function requireCeo(req: any, res: Response, next: NextFunction) {
  try {
    const userId: string | undefined = req.user?.claims?.sub;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (getAssignedAuthority(user) !== "ceo") {
      return res.status(403).json({ error: "Forbidden — CEO only" });
    }
    (req as any).ceoUser = user;
    next();
  } catch (err: any) {
    console.error("[prod-actions] auth check failed:", err?.message ?? err);
    res.status(500).json({ error: "Internal error" });
  }
}

export function registerProdActionsRoutes(app: Express): void {
  app.get(
    "/api/admin/prod-actions",
    isAuthenticated,
    requireCeo,
    async (_req, res) => {
      try {
        const result = await getProdActionStatuses();
        // Task #1824 — return a superset: legacy `actions` (every row)
        // plus `active` / `completed` partitions used by the CEO panel.
        res.json(result);
      } catch (err: any) {
        console.error("[prod-actions] status failed:", err?.message ?? err);
        res.status(500).json({ error: err?.message ?? "Internal error" });
      }
    },
  );

  app.get(
    "/api/admin/prod-actions/runs",
    isAuthenticated,
    requireCeo,
    async (req, res) => {
      try {
        const rawLimit = Number((req.query as any)?.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50;
        // Task #2125 — `?actor=system` restricts to automatic self-heal
        // runs (actor_user_id IS NULL) for the panel's auto-heal timeline.
        const actor =
          (req.query as any)?.actor === "system" ? "system" : "all";
        // Task #2232 — optional `?actionId=` filters the history to a
        // single action so operators can follow a flapping action.
        const rawActionId = (req.query as any)?.actionId;
        const actionId =
          typeof rawActionId === "string" && rawActionId.trim().length > 0
            ? rawActionId.trim()
            : undefined;
        const runs = await runWithWorkerDb(async () => {
          await ensureProdActionRunsTable();
          return listProdActionRuns(limit, { actor, actionId });
        });
        res.json({ runs });
      } catch (err: any) {
        console.error("[prod-actions] runs list failed:", err?.message ?? err);
        res.status(500).json({ error: err?.message ?? "Internal error" });
      }
    },
  );

  // Task #2173 — let the CEO tune the self-heal persistent-failure alert
  // sensitivity (consecutive-error trip point) from the panel, without
  // editing the raw `prod_action_self_heal_failure_alert_threshold`
  // system setting. The setter clamps to the bounded [MIN, CAP] range and
  // the value is read fresh on every self-heal tick, so the new trip
  // point takes effect on the next tick (no restart). Returns the
  // effective (clamped) value so the panel can reflect what was stored.
  app.post(
    "/api/admin/prod-actions/failure-alert-threshold",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const raw = (req.body ?? {}).threshold;
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          return res.status(400).json({
            error: `threshold must be a number between ${FAILURE_ALERT_THRESHOLD_MIN} and ${FAILURE_ALERT_THRESHOLD_CAP}`,
          });
        }
        const actorId: string | null = req.user?.claims?.sub ?? null;
        const threshold = await setFailureAlertThreshold(
          value,
          actorId ?? undefined,
        );
        console.log(
          `[prod-actions] CEO ${actorId ?? "?"} set self-heal failure-alert threshold → ${threshold}`,
        );
        res.json({ threshold });
      } catch (err: any) {
        console.error(
          "[prod-actions] set failure-alert threshold failed:",
          err?.message ?? err,
        );
        res.status(500).json({ error: err?.message ?? "Internal error" });
      }
    },
  );

  app.post(
    "/api/admin/prod-actions/apply",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const actorId: string | null = req.user?.claims?.sub ?? null;
        const results = await applyAllProdActions(actorId);
        console.log(
          `[prod-actions] CEO ${actorId ?? "?"} applied ${results.length} actions: ` +
            results
              .map((r) => `${r.id}=${r.outcome.state}`)
              .join(", "),
        );
        res.json({ results });
      } catch (err: any) {
        console.error("[prod-actions] apply failed:", err?.message ?? err);
        res.status(500).json({ error: err?.message ?? "Internal error" });
      }
    },
  );

  // Task #4019 — single-action apply for MANUAL LEVERS only (e.g. the
  // Zoom S2S emergency rollback). Levers are excluded from the Apply-all
  // pass — a pending rollback riding along with a routine Apply-all press
  // would bounce the mode straight back — so this endpoint is the only
  // way to fire one. Non-lever actions get a 400 (they stay in the
  // one-and-done Apply-all lane); unknown ids get a 404.
  app.post(
    "/api/admin/prod-actions/:actionId/apply",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const actionId = String(req.params?.actionId ?? "").trim();
        const actorId: string | null = req.user?.claims?.sub ?? null;
        const parsed = z.object({
          confirmation: z.string().trim().max(160).optional(),
        }).safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid confirmation" });
        }
        const applied = await applyOneProdAction(
          actionId,
          actorId,
          parsed.data.confirmation,
        );
        if (applied.kind === "not_found") {
          return res.status(404).json({ error: `Unknown prod action: ${actionId}` });
        }
        if (applied.kind === "not_manual_lever") {
          return res.status(400).json({
            error:
              "Only manual-lever actions can be applied individually — use Apply all for regular actions.",
          });
        }
        const { result } = applied;
        console.log(
          `[prod-actions] CEO ${actorId ?? "?"} applied manual lever ${result.id}: ${result.outcome.state}`,
        );
        res.json({ result });
      } catch (err: any) {
        console.error(
          "[prod-actions] manual-lever apply failed:",
          err?.message ?? err,
        );
        res.status(500).json({ error: err?.message ?? "Internal error" });
      }
    },
  );
}
