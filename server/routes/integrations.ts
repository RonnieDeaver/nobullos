/**
 * Integrations routes — composition root (Task #4152 / F6 split).
 *
 * Formerly a 7,869-line monolith registering all 131 integration routes
 * inline; now a thin aggregator over the domain modules in
 * server/routes/integrations/. Each register function registers its routes
 * in the module's original statement order, and the calls below run in the
 * order each domain first appeared in the pre-split file. Cross-module path
 * families are disjoint literal prefixes, so this ordering preserves
 * Express matching behavior for every route.
 *
 * Do not add routes here — add them to the owning domain module (or a new
 * module under server/routes/integrations/) and register it below. Shared
 * pure helpers live in server/routes/integrations/helpers.ts.
 */
import type { Express } from "express";
import { registerIntegrationsHubRoutes } from "./integrations/hub";
import { registerIntegrationsUnmatchedRoutes } from "./integrations/unmatched";
import { registerIntegrationsFrontConnectionRoutes } from "./integrations/frontConnection";
import { registerIntegrationsFrontConsoleRoutes } from "./integrations/frontConsole";
import { registerIntegrationsFrontAnalyticsCoverageRoutes } from "./integrations/frontAnalyticsCoverage";
import { registerIntegrationsFrontHistoricalRecoveryRoutes } from "./integrations/frontHistoricalRecovery";
import { registerIntegrationsFrontAutoClosureRoutes } from "./integrations/frontAutoClosure";
import { registerIntegrationsZoomRoutes } from "./integrations/zoom";
import { registerIntegrationsFrontOpsRoutes } from "./integrations/frontOps";
import { registerIntegrationsPipelineRoutes } from "./integrations/pipeline";
import { registerIntegrationsFrontFilterRulesRoutes } from "./integrations/frontFilterRules";
import { registerIntegrationsWorkQueueRoutes } from "./integrations/workQueue";
import { registerIntegrationsSemrushRoutes } from "./integrations/semrush";
import { registerIntegrationsGhlRoutes } from "./integrations/ghl";

export function registerIntegrationRoutes(app: Express) {
  registerIntegrationsHubRoutes(app);
  registerIntegrationsUnmatchedRoutes(app);
  registerIntegrationsFrontConnectionRoutes(app);
  registerIntegrationsFrontConsoleRoutes(app);
  registerIntegrationsFrontAnalyticsCoverageRoutes(app);
  registerIntegrationsFrontHistoricalRecoveryRoutes(app);
  registerIntegrationsFrontAutoClosureRoutes(app);
  registerIntegrationsZoomRoutes(app);
  registerIntegrationsFrontOpsRoutes(app);
  registerIntegrationsPipelineRoutes(app);
  registerIntegrationsFrontFilterRulesRoutes(app);
  registerIntegrationsWorkQueueRoutes(app);
  registerIntegrationsSemrushRoutes(app);
  registerIntegrationsGhlRoutes(app);
}
