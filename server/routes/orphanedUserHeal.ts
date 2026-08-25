/**
 * Task #2243 — operator status surface for the orphaned-user profile-row
 * heal sweep (Task #2203):
 *
 *   GET /api/admin/orphaned-user-heal/status
 *
 * Gated by `isAuthenticated` + `requireTeamLead`. The route returns the
 * live config (master switch + per-tick budget + cadence) plus the
 * persisted last-run summary (candidates / healed / errors / skip reason)
 * so an operator can confirm the sweep is enabled, running on schedule,
 * and actually healing people — without scraping worker logs. It reads the
 * existing `getLastOrphanedUserHealRun()` readout; it does not run a tick
 * or write any authoritative `users` rows.
 *
 * Extracted from `server/routes.ts` so the endpoint can be registered onto
 * a bare Express app in tests (see
 * `tests/orphaned-user-heal-routes.test.ts`).
 */
import type { Express } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";

export function registerOrphanedUserHealRoutes(app: Express): void {
  app.get(
    "/api/admin/orphaned-user-heal/status",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const {
          getOrphanedUserHealConfig,
          readLastOrphanedUserHealRun,
          MAX_PER_TICK_CAP,
        } = await import("../services/orphanedUserHeal");
        const [config, lastRunRead] = await Promise.all([
          getOrphanedUserHealConfig(),
          readLastOrphanedUserHealRun(),
        ]);
        // `lastRun` is the parsed summary or null (contract preserved).
        // `lastRunStatus` distinguishes "never_run" (normal on a fresh
        // deploy) from "unreadable" (a persisted-value parse failure →
        // real persistence bug), with `lastRunError` carrying the
        // plain-English reason when unreadable.
        res.json({
          config,
          caps: { maxPerTick: MAX_PER_TICK_CAP },
          lastRun: lastRunRead.lastRun,
          lastRunStatus: lastRunRead.status,
          ...(lastRunRead.error ? { lastRunError: lastRunRead.error } : {}),
        });
      } catch (err: any) {
        console.error(
          "[OrphanedUserHeal] status endpoint failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({ error: "Failed to fetch orphaned-user heal status" });
      }
    },
  );
}
