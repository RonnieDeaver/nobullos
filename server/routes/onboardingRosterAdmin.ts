/**
 * Onboarding roster admin routes (Task #5295) — stage 1 of the New Client
 * Onboarding epic.
 *
 * GET is available to any authenticated user because stage 2 (pool-aware
 * availability/assignment) and stage 3 (the intake form) both need to read
 * "who is on the onboarding roster and who is the default" outside of an
 * admin context. Writes (add/toggle/remove/set-default) require team-lead,
 * matching the Service Desk department-membership write bar.
 */
import type { Express } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import {
  listOnboardingRoster,
  upsertOnboardingAssignee,
  setOnboardingAssigneeActive,
  deleteOnboardingAssignee,
  setOnboardingDefault,
} from "../services/onboardingRoster";

export function registerOnboardingRosterAdminRoutes(app: Express): void {
  app.get("/api/admin/onboarding/roster", isAuthenticated, async (_req: any, res) => {
    try {
      const members = await listOnboardingRoster();
      const defaultUserId = members.find((m) => m.isDefault)?.userId ?? null;
      res.json({ members, defaultUserId });
    } catch (err: any) {
      console.error("[OnboardingRoster] GET failed:", err?.message);
      res.status(500).json({ error: "Failed to load onboarding roster" });
    }
  });

  app.post("/api/admin/onboarding/roster", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
      if (!userId) {
        return res.status(400).json({ error: "userId is required" });
      }
      const member = await upsertOnboardingAssignee(userId);
      res.status(201).json({ member });
    } catch (err: any) {
      console.error("[OnboardingRoster] POST failed:", err?.message);
      res.status(500).json({ error: "Failed to add onboarding assignee" });
    }
  });

  app.put("/api/admin/onboarding/roster/:id", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { id } = req.params;
      const active = req.body?.active;
      if (typeof active !== "boolean") {
        return res.status(400).json({ error: "active must be a boolean" });
      }
      const result = await setOnboardingAssigneeActive(id, active);
      if (!result) {
        return res.status(404).json({ error: "Onboarding assignee not found" });
      }
      res.json(result);
    } catch (err: any) {
      console.error("[OnboardingRoster] PUT active failed:", err?.message);
      res.status(500).json({ error: "Failed to update onboarding assignee" });
    }
  });

  app.delete("/api/admin/onboarding/roster/:id", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { id } = req.params;
      const result = await deleteOnboardingAssignee(id);
      if (!result) {
        return res.status(404).json({ error: "Onboarding assignee not found" });
      }
      res.json(result);
    } catch (err: any) {
      console.error("[OnboardingRoster] DELETE failed:", err?.message);
      res.status(500).json({ error: "Failed to remove onboarding assignee" });
    }
  });

  app.put("/api/admin/onboarding/default", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const raw = req.body?.userId;
      const userId = raw === null || raw === undefined ? null : typeof raw === "string" ? raw.trim() || null : undefined;
      if (userId === undefined) {
        return res.status(400).json({ error: "userId must be a string or null" });
      }
      const result = await setOnboardingDefault(userId);
      if (!result.ok) {
        if (result.kind === "not_found") {
          return res.status(404).json({ error: "That user is not on the onboarding roster" });
        }
        return res.status(409).json({ error: "That user's onboarding membership is inactive" });
      }
      res.json({ roster: result.roster, defaultUserId: userId });
    } catch (err: any) {
      console.error("[OnboardingRoster] PUT default failed:", err?.message);
      res.status(500).json({ error: "Failed to set onboarding default" });
    }
  });
}
