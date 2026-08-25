// @db-pool-intent: api
/**
 * Task #3056 — Service Desk foundation: ClickUp structure, config & ticket mapping.
 *
 * Mounted at /api/service-desk (CEO/admin) and /api/service-desk/public (all users).
 *
 * Task #3787: the implementation is split into per-feature modules under
 * ./serviceDesk/ to keep merge surfaces small; this aggregator preserves the
 * original import path, the public exports, and the exact route registration
 * order (each register function registers its routes in the original
 * statement order, and they are invoked here in the original sequence).
 * Add new routes to the matching feature module, not here.
 */
import type { Express } from "express";
import { registerServiceDeskConfigSetupRoutes } from "./serviceDesk/configSetup";
import { registerServiceDeskDepartmentRoutes } from "./serviceDesk/departments";
import { registerServiceDeskRequestTypeRoutes } from "./serviceDesk/requestTypes";
import { registerServiceDeskClickUpImportRoutes } from "./serviceDesk/clickupImports";
import { registerServiceDeskTicketReadRoutes } from "./serviceDesk/ticketsRead";
import { registerServiceDeskTicketActionRoutes } from "./serviceDesk/ticketActions";
import { registerServiceDeskReportRoutes } from "./serviceDesk/reports";
import { registerServiceDeskTemplateRoutes } from "./serviceDesk/templates";

export function registerServiceDeskRoutes(app: Express): void {
  registerServiceDeskConfigSetupRoutes(app);
  registerServiceDeskDepartmentRoutes(app);
  registerServiceDeskRequestTypeRoutes(app);
  registerServiceDeskClickUpImportRoutes(app);
  registerServiceDeskTicketReadRoutes(app);
  registerServiceDeskTicketActionRoutes(app);
  registerServiceDeskReportRoutes(app);
  registerServiceDeskTemplateRoutes(app);
}

// ─── Exported eligibility helper for intake/workflow tasks ───────────────────
export { getEligibleAssignees, findStaleWaitingFieldBindings } from "./serviceDesk/helpers";
