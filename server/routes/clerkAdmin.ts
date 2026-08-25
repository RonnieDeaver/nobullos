/**
 * CEO-only Clerk admin routes (Task #4611).
 *
 * Exposes two endpoints for reading and enabling the Clerk instance's
 * Restricted sign-up mode (allowlist). The CEO presses a button in
 * /admin/system-health?tab=auth instead of manually navigating the Clerk
 * dashboard. Each endpoint calls the Clerk Backend API using the ambient
 * CLERK_SECRET_KEY; the key is environment-scoped (dev vs. prod), so the
 * CEO must trigger the action once per deployed environment.
 *
 * Vendor confinement: Clerk API calls are confined to this file.
 * API host: api.clerk.com  <!-- clerk-api-host -->
 */
import type { Express, Request, Response } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireCeo } from "./middleware";

const CLERK_API_BASE = "https://api.clerk.com/v1";

async function clerkApiFetch(
  method: "GET" | "PATCH",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error("CLERK_SECRET_KEY is not set");
  const res = await fetch(`${CLERK_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    throw new Error(`Clerk API ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

export function registerClerkAdminRoutes(app: Express): void {
  /**
   * GET /api/admin/clerk/restrictions
   * Returns the current Clerk instance restriction settings.
   * Response: { allowlist: boolean, blocklist: boolean }
   */
  app.get(
    "/api/admin/clerk/restrictions",
    isAuthenticated,
    requireCeo,
    async (_req: Request, res: Response) => {
      try {
        const instance = (await clerkApiFetch("GET", "/instance")) as any;
        const restrictions = instance?.restrictions ?? {};
        res.json({
          allowlist: restrictions.allowlist ?? false,
          blocklist: restrictions.blocklist ?? false,
        });
      } catch (err: any) {
        console.error(
          "[clerkAdmin] GET /restrictions failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({ error: err?.message ?? "Failed to read Clerk restrictions" });
      }
    },
  );

  /**
   * POST /api/admin/clerk/enable-restricted-signup
   * Flips the Clerk instance to Restricted sign-up mode (allowlist: true).
   * Idempotent — safe to call when already enabled.
   * Response: { ok: true, allowlist: true }
   */
  app.post(
    "/api/admin/clerk/enable-restricted-signup",
    isAuthenticated,
    requireCeo,
    async (_req: Request, res: Response) => {
      try {
        await clerkApiFetch("PATCH", "/instance/restrictions", {
          allowlist: true,
        });
        res.json({ ok: true, allowlist: true });
      } catch (err: any) {
        console.error(
          "[clerkAdmin] POST /enable-restricted-signup failed:",
          err?.message ?? err,
        );
        res.status(500).json({
          error: err?.message ?? "Failed to update Clerk restrictions",
        });
      }
    },
  );
}
