/**
 * Task #1687 — Per-user Slack DM forwarding REST API.
 *
 * Surface (all user-scoped except the admin block):
 *   GET    /api/notifications/preferences            current user's matrix
 *   PUT    /api/notifications/preferences            update single (category)
 *   GET    /api/notifications/slack-identity         current user's link status
 *   POST   /api/notifications/slack-identity/link    link via email lookup
 *   DELETE /api/notifications/slack-identity         disconnect
 *   POST   /api/notifications/slack-identity/test    send self a test DM
 *
 *   GET    /api/admin/notifications/user-slack-identities       list (team_lead)
 *   DELETE /api/admin/notifications/user-slack-identities/:userId  force-disconnect
 *   GET    /api/admin/notifications/user-slack-dm-enabled       read kill switch
 *   PUT    /api/admin/notifications/user-slack-dm-enabled       set kill switch
 *
 * The user-scoped DELETE / POST endpoints never error on a missing
 * identity — they return `{ ok: true, status: ... }` so the UI can be
 * idempotent (Profile.tsx renders "Connect" or "Disconnect" based on
 * the GET response).
 */

import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { storage } from "../storage";
import {
  userNotificationCategories,
} from "@shared/schema";
import {
  disconnectUserSlackIdentity,
  getUserNotificationPreferences,
  getUserSlackIdentity,
  listUserSlackIdentitiesAdmin,
  upsertUserNotificationPreference,
} from "../storage/userSlackPreferencesStorage";
import {
  isUserSlackDmGloballyEnabled,
  linkSlackIdentityByEmail,
  sendSlackDmToUser,
  setUserSlackDmGloballyEnabled,
  USER_SLACK_DM_ENABLED_SETTING,
} from "../services/notifications/userSlackSender";

function getUserId(req: any): string | null {
  return req?.user?.claims?.sub ?? null;
}

const prefUpdateSchema = z.object({
  category: z.enum(userNotificationCategories),
  inAppEnabled: z.boolean(),
  slackDmEnabled: z.boolean(),
});

const linkBodySchema = z.object({
  email: z.string().email().optional(),
});

const killSwitchSchema = z.object({
  enabled: z.boolean(),
});

// Middleware handlers passed in from routes.ts are async (they return a
// Promise) — Express's own RequestHandler is typed as returning void, so we
// widen the accepted shape to also allow a Promise-returning handler. Express
// handles the returned promise idiomatically; this keeps no-misused-promises
// from flagging the async isAuthenticated/requireTeamLead assignment.
type MaybeAsyncRequestHandler =
  | RequestHandler
  | ((...args: Parameters<RequestHandler>) => Promise<void>);

export interface RegisterUserSlackPreferenceRoutesOpts {
  isAuthenticated: MaybeAsyncRequestHandler;
  requireTeamLead: MaybeAsyncRequestHandler;
}

export function registerUserSlackPreferenceRoutes(
  app: Express,
  opts: RegisterUserSlackPreferenceRoutesOpts,
): void {
  const { isAuthenticated, requireTeamLead } = opts;

  // ─── preferences ─────────────────────────────────────────────────
  app.get(
    "/api/notifications/preferences",
    isAuthenticated,
    async (req: any, res) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      try {
        const [rows, slackEnabled] = await Promise.all([
          getUserNotificationPreferences(userId),
          isUserSlackDmGloballyEnabled(),
        ]);
        res.json({
          preferences: rows,
          slackDmGloballyEnabled: slackEnabled,
        });
      } catch (err: any) {
        console.error(
          `[userSlackPreferences] list failed: ${err?.message ?? err}`,
        );
        res.status(500).json({ error: "list_failed" });
      }
    },
  );

  app.put(
    "/api/notifications/preferences",
    isAuthenticated,
    async (req: any, res) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const parsed = prefUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_body", details: parsed.error.flatten() });
      }
      try {
        const row = await upsertUserNotificationPreference({
          userId,
          category: parsed.data.category,
          inAppEnabled: parsed.data.inAppEnabled,
          slackDmEnabled: parsed.data.slackDmEnabled,
        });
        res.json({ ok: true, preference: row });
      } catch (err: any) {
        console.error(
          `[userSlackPreferences] update failed: ${err?.message ?? err}`,
        );
        res.status(500).json({ error: "update_failed" });
      }
    },
  );

  // ─── identity ────────────────────────────────────────────────────
  app.get(
    "/api/notifications/slack-identity",
    isAuthenticated,
    async (req: any, res) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      try {
        const identity = await getUserSlackIdentity(userId);
        res.json({
          connected: !!identity && !identity.disconnectedAt,
          identity: identity ?? null,
        });
      } catch (err: any) {
        console.error(
          `[userSlackPreferences] identity-get failed: ${err?.message ?? err}`,
        );
        res.status(500).json({ error: "identity_failed" });
      }
    },
  );

  app.post(
    "/api/notifications/slack-identity/link",
    isAuthenticated,
    async (req: any, res) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const parsed = linkBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_body", details: parsed.error.flatten() });
      }
      try {
        const user = await storage.getUser(userId);
        const email = parsed.data.email ?? user?.email ?? null;
        if (!email) {
          return res.status(400).json({ error: "missing_email" });
        }
        const result = await linkSlackIdentityByEmail({ userId, email });
        if (result.status === "linked") {
          return res.json({ ok: true, identity: result.identity });
        }
        return res.status(409).json({ error: result.status, message: result.error });
      } catch (err: any) {
        console.error(
          `[userSlackPreferences] link failed: ${err?.message ?? err}`,
        );
        res.status(500).json({ error: "link_failed" });
      }
    },
  );

  app.delete(
    "/api/notifications/slack-identity",
    isAuthenticated,
    async (req: any, res) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      try {
        await disconnectUserSlackIdentity(userId);
        res.json({ ok: true });
      } catch (err: any) {
        console.error(
          `[userSlackPreferences] disconnect failed: ${err?.message ?? err}`,
        );
        res.status(500).json({ error: "disconnect_failed" });
      }
    },
  );

  app.post(
    "/api/notifications/slack-identity/test",
    isAuthenticated,
    async (req: any, res) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      try {
        const result = await sendSlackDmToUser({
          userId,
          content: {
            title: "Test DM from NoBull OS",
            body: "If you see this in Slack, your link is working.",
            deepLink: "/notifications",
          },
        });
        res.json(result);
      } catch (err: any) {
        res
          .status(502)
          .json({ ok: false, error: "test_failed", message: err?.message });
      }
    },
  );

  // ─── admin oversight ─────────────────────────────────────────────
  app.get(
    "/api/admin/notifications/user-slack-identities",
    isAuthenticated,
    requireTeamLead,
    async (_req, res) => {
      try {
        const rows = await listUserSlackIdentitiesAdmin();
        res.json({ identities: rows });
      } catch (err: any) {
        console.error(
          `[userSlackPreferences] admin list failed: ${err?.message ?? err}`,
        );
        res.status(500).json({ error: "admin_list_failed" });
      }
    },
  );

  app.delete(
    "/api/admin/notifications/user-slack-identities/:userId",
    isAuthenticated,
    requireTeamLead,
    async (req, res) => {
      const targetId = req.params.userId;
      if (!targetId) return res.status(400).json({ error: "missing_user_id" });
      try {
        await disconnectUserSlackIdentity(targetId);
        res.json({ ok: true });
      } catch (err: any) {
        console.error(
          `[userSlackPreferences] admin disconnect failed: ${err?.message ?? err}`,
        );
        res.status(500).json({ error: "admin_disconnect_failed" });
      }
    },
  );

  app.get(
    "/api/admin/notifications/user-slack-dm-enabled",
    isAuthenticated,
    requireTeamLead,
    async (_req, res) => {
      try {
        const enabled = await isUserSlackDmGloballyEnabled();
        res.json({ enabled, settingKey: USER_SLACK_DM_ENABLED_SETTING });
      } catch (err: any) {
        res.status(500).json({ error: "kill_switch_read_failed" });
      }
    },
  );

  app.put(
    "/api/admin/notifications/user-slack-dm-enabled",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      const parsed = killSwitchSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid_body", details: parsed.error.flatten() });
      }
      try {
        await setUserSlackDmGloballyEnabled(
          parsed.data.enabled,
          getUserId(req) ?? "admin",
        );
        res.json({ ok: true, enabled: parsed.data.enabled });
      } catch (err: any) {
        res.status(500).json({ error: "kill_switch_write_failed" });
      }
    },
  );

}
