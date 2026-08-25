// @db-pool-intent: api
/**
 * Task #3662 — Ads OS ClickUp COMPANY token admin routes.
 *
 * The company token (Client List directory, Ads OS ticket pushes, hygiene
 * alerts) is runtime-rotatable: a DB-backed override takes precedence over
 * the CLICKUP_API_TOKEN env var, so a rotation reaches all production
 * instances within ~a minute — no republish (deployments freeze env secrets
 * at publish time; that's how prod went auth-dead twice).
 *
 * Routes (mounted from registerClickUpRoutes):
 *   GET    /api/integrations/clickup/company-token/status  (account_manager+)
 *          → source (db|env|none), directory health, last-edited metadata.
 *   POST   /api/integrations/clickup/company-token/test    (team_lead+)
 *          → live-probes the Client List with the CANDIDATE token from the
 *            body (or the active token when omitted); reports client count
 *            or the EXACT ClickUp error. Pure: never mutates directory
 *            cache/liveness/alert state.
 *   POST   /api/integrations/clickup/company-token         (team_lead+)
 *          → save/rotate the override, then force a directory refresh so
 *            recovery is immediate and verified.
 *   DELETE /api/integrations/clickup/company-token         (team_lead+)
 *          → clear the override (revert to env bootstrap token).
 *
 * Security invariants:
 *   - The token value is NEVER echoed by any response and NEVER logged.
 *   - Status distinguishes "no token" from "settings read failed"
 *     (503 statusUnknown) — a DB blip must not report "not configured".
 *   - Auth middlewares are injected by the caller (clickup.ts passes the
 *     real isAuthenticated/requireRole chain; route tests pass recorders),
 *     keeping this module import-light for hermetic tests.
 */

import type { Express, RequestHandler } from "express";
import {
  clearClickUpCompanyToken,
  getClickUpCompanyTokenStatus,
  isClickUpEnvTokenPresent,
  setClickUpCompanyToken,
} from "../services/clickUpCompanyToken";
import {
  ClickUpHttpError,
  directoryHealth,
  getClientDirectory,
  probeClientList,
} from "../services/adsOs/clickUpDirectory";

// Middleware passed in from routes.ts is async (returns a Promise). Express's
// RequestHandler is typed with a void return, so we widen the accepted shape to
// also allow a Promise-returning handler; this keeps no-misused-promises from
// flagging the async requireAccountManager/requireTeamLead assignment. Express
// handles the returned promise idiomatically.
type MaybeAsyncRequestHandler =
  | RequestHandler
  | ((...args: Parameters<RequestHandler>) => Promise<void>);

export interface ClickUpCompanyTokenRouteDeps {
  isAuthenticated: MaybeAsyncRequestHandler;
  /** Read access (status): account_manager and up. */
  requireRead: MaybeAsyncRequestHandler;
  /** Write access (test/set/clear): team_lead and up. */
  requireWrite: MaybeAsyncRequestHandler;
}

/** Shape-validate a pasted token WITHOUT interpreting it. */
function validateTokenShape(raw: unknown): { ok: true; token: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "token must be a string" };
  const token = raw.trim();
  if (token.length < 20 || token.length > 500) {
    return { ok: false, error: "Token length looks wrong (expected 20–500 characters)." };
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    return { ok: false, error: "Token must be a single line of printable ASCII with no spaces." };
  }
  return { ok: true, token };
}

function probeErrorPayload(err: any): { ok: false; error: string; httpStatus: number | null } {
  return {
    ok: false,
    // Surface the EXACT ClickUp error (e.g. "HTTP 401: Oauth token not found")
    // so the admin sees what production sees. Never contains the token.
    error: String(err?.message ?? err),
    httpStatus: err instanceof ClickUpHttpError ? err.status : null,
  };
}

export function registerClickUpCompanyTokenRoutes(
  app: Express,
  deps: ClickUpCompanyTokenRouteDeps,
): void {
  const { isAuthenticated, requireRead, requireWrite } = deps;

  // ─── Status (never the token) ─────────────────────────────────────────────
  app.get(
    "/api/integrations/clickup/company-token/status",
    isAuthenticated,
    requireRead,
    async (_req: any, res) => {
      try {
        const status = await getClickUpCompanyTokenStatus();
        let lastEdited: unknown = null;
        if (status.updatedAt || status.updatedBy) {
          try {
            const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
            const userMap = await resolveLastEditedUsers([status.updatedBy]);
            lastEdited = buildLastEdited(
              status.updatedAt ? new Date(status.updatedAt) : null,
              status.updatedBy,
              userMap,
            );
          } catch {
            lastEdited = { at: status.updatedAt, by: null };
          }
        }
        res.json({
          configured: status.configured,
          source: status.source,
          envPresent: status.envPresent,
          dbOverride: status.dbOverride,
          lastEdited,
          directory: directoryHealth(),
        });
      } catch (err: any) {
        // Settings read THREW — unknown, not "not configured" (absent-vs-unknown).
        console.error("[ClickUpCompanyToken] status read failed:", err?.message ?? err);
        res.status(503).json({
          statusUnknown: true,
          error: "Could not read the token settings right now — try again shortly.",
        });
      }
    },
  );

  // ─── Test connection (candidate or active token; pure probe) ─────────────
  app.post(
    "/api/integrations/clickup/company-token/test",
    isAuthenticated,
    requireWrite,
    async (req: any, res) => {
      try {
        let candidate: string | undefined;
        const raw = req.body?.token;
        if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
          const shape = validateTokenShape(raw);
          if (!shape.ok) return res.status(400).json({ ok: false, error: shape.error });
          candidate = shape.token;
        }
        const probe = await probeClientList(candidate);
        res.json({
          ok: true,
          clients: probe.clients,
          tasks: probe.tasks,
          testedToken: candidate ? "candidate" : "active",
        });
      } catch (err: any) {
        // Probe failures are an EXPECTED outcome of "Test connection" — 200
        // with ok:false so the UI renders the exact error inline.
        res.json(probeErrorPayload(err));
      }
    },
  );

  // ─── Save / rotate ────────────────────────────────────────────────────────
  app.post(
    "/api/integrations/clickup/company-token",
    isAuthenticated,
    requireWrite,
    async (req: any, res) => {
      const shape = validateTokenShape(req.body?.token);
      if (!shape.ok) return res.status(400).json({ error: shape.error });
      try {
        const userId = req.user?.claims?.sub ?? null;
        // Write-through, unconditionally (prod-action rule): the admin decides
        // what to save; probe verification is advisory via the refresh below.
        await setClickUpCompanyToken(shape.token, userId);
        // Force a directory refresh so recovery is immediate on THIS instance
        // and the response reports the live outcome of the new token.
        let refresh: { ok: boolean; clients?: number; error?: string };
        try {
          const bundle = await getClientDirectory({ force: true, throwOnError: true });
          refresh = { ok: true, clients: bundle.blocks.length };
        } catch (err: any) {
          refresh = { ok: false, error: String(err?.message ?? err) };
        }
        console.log(
          `[ClickUpCompanyToken] override ${refresh.ok ? "saved & verified" : "saved (refresh failed)"} by ${userId ?? "unknown"}`,
        );
        res.json({ success: true, source: "db", refresh });
      } catch (err: any) {
        console.error("[ClickUpCompanyToken] save failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to save the token override." });
      }
    },
  );

  // ─── Clear override (revert to env) ───────────────────────────────────────
  app.delete(
    "/api/integrations/clickup/company-token",
    isAuthenticated,
    requireWrite,
    async (req: any, res) => {
      try {
        const userId = req.user?.claims?.sub ?? null;
        await clearClickUpCompanyToken(userId);
        const status = await getClickUpCompanyTokenStatus().catch(() => null);
        console.log(`[ClickUpCompanyToken] override cleared by ${userId ?? "unknown"}`);
        res.json({ success: true, source: status?.source ?? (isClickUpEnvTokenPresent() ? "env" : "none") });
      } catch (err: any) {
        console.error("[ClickUpCompanyToken] clear failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to clear the token override." });
      }
    },
  );
}
