// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — health & observability admin surface
 * (/api/health/* core, ops switches, incidents, post-deploy verification,
 * diagnostics, digests, manual-reserve alerts).
 *
 * The implementation lives in per-feature modules under ./health/ to keep
 * merge surfaces small; this aggregator preserves the exact route
 * registration order the former inline block in server/routes.ts had (each
 * register function registers its routes in the original statement order,
 * and they are invoked here in the original sequence). Add new routes to the
 * matching feature module, not here.
 */
import type { Express } from "express";
import { registerHealthCoreRoutes } from "./health/core";
import { registerHealthOpsAndIncidentRoutes } from "./health/opsAndIncidents";
import { registerPostDeployVerificationRoutes } from "./health/postDeployVerification";
import { registerHealthDiagnosticsAndDigestRoutes } from "./health/diagnosticsAndDigests";
import { registerManualReserveAlertsAdminRoutes } from "./health/manualReserveAlertsAdmin";

export { handleManualReserveAlertsResend } from "./health/manualReserveAlertsAdmin";

export async function registerHealthRoutes(app: Express): Promise<void> {
  await registerHealthCoreRoutes(app);
  registerHealthOpsAndIncidentRoutes(app);
  registerPostDeployVerificationRoutes(app);
  registerHealthDiagnosticsAndDigestRoutes(app);
  registerManualReserveAlertsAdminRoutes(app);
}
