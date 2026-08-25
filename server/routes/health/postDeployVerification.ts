// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 1420–1657 at split time).
 *
 * Post-deploy verification: run the runbook checklist, baselines list/save, digest config, and the legacy-incident force-resolve route.
 *
 * Mount-order contract: registerPostDeployVerificationRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { and } from "drizzle-orm";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireTeamLead } from "../middleware";
export function registerPostDeployVerificationRoutes(app: Express): void {
  // Task #928 — Post-deploy verification: run the §8 runbook checklist on
  // demand, persist a baseline for compare-to-last-deploy, and provide a
  // one-click force-resolve for the documented legacy stuck incidents.
  app.get(
    "/api/health/post-deploy-verification",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const svc = await import("../../services/postDeployVerification");
        // Task #983 — optional `baselineId` selects which historical baseline
        // to compare against; defaults to the most recent.
        const raw = req.query?.baselineId;
        let baselineId: number | null = null;
        if (raw != null && raw !== "") {
          const n = Number(raw);
          if (Number.isFinite(n)) baselineId = n;
        }
        res.json(await svc.runPostDeployVerification({ baselineId }));
      } catch (err: any) {
        console.error("[PostDeployVerification] run failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to run post-deploy verification" });
      }
    },
  );

  app.post(
    "/api/health/post-deploy-verification/baseline",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const svc = await import("../../services/postDeployVerification");
        const by = req.user?.claims?.sub ?? req.user?.username ?? null;
        res.json({ baseline: await svc.snapshotBaseline(by) });
      } catch (err: any) {
        console.error("[PostDeployVerification] baseline failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to snapshot post-deploy baseline" });
      }
    },
  );

  // Task #1004 — delete a single baseline from the rolling history so an
  // operator can curate out a known-bad snapshot.
  app.delete(
    "/api/health/post-deploy-verification/baseline/:id",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const id = Number(req.params?.id);
        if (!Number.isFinite(id)) {
          return res.status(400).json({ error: "Invalid baseline id" });
        }
        const svc = await import("../../services/postDeployVerification");
        const by = req.user?.claims?.sub ?? req.user?.username ?? null;
        const removed = await svc.deleteBaseline(id, by);
        if (!removed) {
          return res.status(404).json({ error: "Baseline not found" });
        }
        res.json({ ok: true });
      } catch (err: any) {
        console.error(
          "[PostDeployVerification] baseline delete failed:",
          err?.message ?? err,
        );
        res.status(500).json({ error: "Failed to delete baseline" });
      }
    },
  );

  // Task #1007 — restore a baseline previously moved to the trash by the
  // delete handler above. Returns 404 when the trash entry has expired,
  // been pushed past the 5-entry cap, or never existed.
  app.post(
    "/api/health/post-deploy-verification/baseline/:id/restore",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const id = Number(req.params?.id);
        if (!Number.isFinite(id)) {
          return res.status(400).json({ error: "Invalid baseline id" });
        }
        const svc = await import("../../services/postDeployVerification");
        const by = req.user?.claims?.sub ?? req.user?.username ?? null;
        const restored = await svc.restoreBaseline(id, by);
        if (!restored) {
          return res
            .status(404)
            .json({ error: "Baseline not found in trash (may have expired)" });
        }
        res.json({ baseline: restored });
      } catch (err: any) {
        console.error(
          "[PostDeployVerification] baseline restore failed:",
          err?.message ?? err,
        );
        res.status(500).json({ error: "Failed to restore baseline" });
      }
    },
  );

  // Task #974 — toggle the boot-time auto-snapshot of the baseline.
  app.post(
    "/api/health/post-deploy-verification/auto-baseline-setting",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        if (typeof req.body?.enabled !== "boolean") {
          return res
            .status(400)
            .json({ error: "Body must include `enabled: boolean`" });
        }
        const enabled: boolean = req.body.enabled;
        const svc = await import("../../services/postDeployVerification");
        const by = req.user?.claims?.sub ?? req.user?.username ?? null;
        res.json(await svc.setAutoBaselineEnabled(enabled, by));
      } catch (err: any) {
        console.error(
          "[PostDeployVerification] auto-baseline toggle failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({ error: "Failed to update auto-baseline setting" });
      }
    },
  );

  // Task #973 — manually re-send the post-deploy verification report to
  // Slack (bypasses the per-boot guard so an operator can re-trigger after
  // tweaking thresholds or fixing a regression).
  app.post(
    "/api/health/post-deploy-verification/send-now",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { maybeSendPostDeployDigest } = await import(
          "../../services/postDeployVerificationDigest"
        );
        const r = await maybeSendPostDeployDigest({ force: true });
        res.json(r);
      } catch (err: any) {
        console.error(
          "[PostDeployVerificationDigest] manual send failed:",
          err?.message ?? err,
        );
        res.status(500).json({ error: "Failed to send post-deploy digest" });
      }
    },
  );

  // Task #1018 — acknowledge / un-acknowledge a worsening metric for the
  // currently-selected baseline so it stops shouting on every re-run.
  app.post(
    "/api/health/post-deploy-verification/acknowledge",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const baselineId = Number(req.body?.baselineId);
        const metricKey =
          typeof req.body?.metricKey === "string" ? req.body.metricKey : "";
        if (!Number.isFinite(baselineId) || !metricKey) {
          return res
            .status(400)
            .json({ error: "Body must include numeric `baselineId` and string `metricKey`" });
        }
        const svc = await import("../../services/postDeployVerification");
        const by = req.user?.claims?.sub ?? req.user?.username ?? null;
        const result = await svc.acknowledgeMetric(baselineId, metricKey, by);
        if (!result.ok) return res.status(400).json({ error: result.error });
        res.json(result);
      } catch (err: any) {
        console.error(
          "[PostDeployVerification] acknowledge failed:",
          err?.message ?? err,
        );
        res.status(500).json({ error: "Failed to acknowledge metric" });
      }
    },
  );

  app.delete(
    "/api/health/post-deploy-verification/acknowledge",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const baselineId = Number(
          req.body?.baselineId ?? req.query?.baselineId,
        );
        const metricKey =
          typeof (req.body?.metricKey ?? req.query?.metricKey) === "string"
            ? String(req.body?.metricKey ?? req.query?.metricKey)
            : "";
        if (!Number.isFinite(baselineId) || !metricKey) {
          return res
            .status(400)
            .json({ error: "Must include numeric `baselineId` and string `metricKey`" });
        }
        const svc = await import("../../services/postDeployVerification");
        const by = req.user?.claims?.sub ?? req.user?.username ?? null;
        const result = await svc.unacknowledgeMetric(baselineId, metricKey, by);
        if (!result.ok) return res.status(400).json({ error: result.error });
        res.json({ ok: true });
      } catch (err: any) {
        console.error(
          "[PostDeployVerification] unacknowledge failed:",
          err?.message ?? err,
        );
        res.status(500).json({ error: "Failed to unacknowledge metric" });
      }
    },
  );

  app.post(
    "/api/health/post-deploy-verification/force-resolve-legacy",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const svc = await import("../../services/postDeployVerification");
        const by = req.user?.claims?.sub ?? req.user?.username ?? null;
        const result = await svc.forceResolveLegacyStuckIncidents(by);
        res.json(result);
      } catch (err: any) {
        console.error(
          "[PostDeployVerification] force-resolve failed:",
          err?.message ?? err,
        );
        res.status(500).json({ error: "Failed to force-resolve legacy incidents" });
      }
    },
  );
}