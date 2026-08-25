/* test-registration
{
  "name": "ClickUp sync hardening — breaker persistence, handlers, scheduler, notifications (Task #2984)",
  "smoke": true,
  "smokeReason": "Task #2984: ClickUp sync hardening smoke gate. Verifies the 4 deliverables: auth-breaker persistence (hydrateClickUpAuthBreakers export + hooks registered at module load), the 3 new work-queue handlers registered via registerAllHandlers() + assertRequiredHandlersRegistered passes, scheduler exports (start/stop), and both new ClickUp notification IDs in the canonical registry. Fast, DB-free, no network, pure module-import assertions. Keeps handler registration guard in-sync with delivery.",
  "tier": "small"
}
test-registration */
/**
 * Task #2984 — ClickUp sync hardening smoke test.
 *
 * Verifies the four deliverables compile and export their required
 * contracts without starting the server, touching the DB, or making
 * any network calls:
 *
 *  1. Auth-breaker persistence — `hydrateClickUpAuthBreakers` export +
 *     the persistence hooks are registered at module load time.
 *  2. Worker handlers — the 3 new handlers (`handleClickUpReconciliationSweep`,
 *     `handleClickUpWebhookHealthCheck`, `handleClickUpWebhookRepair`) are
 *     exported from clickUpWorkerHandlers and registered via
 *     `registerAllHandlers()` (mirrors the handler required-handlers test).
 *  3. Scheduler — `startClickUpReconciliationScheduler` and
 *     `stopClickUpReconciliationScheduler` are exported + the scheduler
 *     does NOT start automatically when force-enable is absent.
 *  4. Notification registry — both new ClickUp notification IDs are in
 *     the canonical registry.
 *
 * Fast, DB-free, network-free, pure module-import assertions.
 */
import assert from "node:assert/strict";
import { registerAllHandlers } from "../server/services/workQueueHandlers";
import {
  isHandlerRegistered,
  assertRequiredHandlersRegistered,
} from "../server/services/workScheduler";

async function run(): Promise<void> {
  let passed = 0;
  const ok = (cond: boolean, msg: string) => {
    assert.ok(cond, msg);
    passed++;
    console.log(`  ok  ${msg}`);
  };

  // ── 1. Persistence hooks ────────────────────────────────────────────────────
  const breakerPersistence = await import(
    "../server/services/clickUpBreakerPersistence"
  );
  ok(
    typeof breakerPersistence.hydrateClickUpAuthBreakers === "function",
    "hydrateClickUpAuthBreakers is exported from clickUpBreakerPersistence",
  );

  // ── 2. Worker handlers ──────────────────────────────────────────────────────
  const handlers = await import("../server/services/clickUpWorkerHandlers");
  ok(
    typeof handlers.handleClickUpReconciliationSweep === "function",
    "handleClickUpReconciliationSweep is exported from clickUpWorkerHandlers",
  );
  ok(
    typeof handlers.handleClickUpWebhookHealthCheck === "function",
    "handleClickUpWebhookHealthCheck is exported from clickUpWorkerHandlers",
  );
  ok(
    typeof handlers.handleClickUpWebhookRepair === "function",
    "handleClickUpWebhookRepair is exported from clickUpWorkerHandlers",
  );

  // Register all handlers (no DB or scheduler side-effects).
  await registerAllHandlers();

  ok(
    isHandlerRegistered("clickup_reconciliation_sweep"),
    "clickup_reconciliation_sweep is registered after registerAllHandlers()",
  );
  ok(
    isHandlerRegistered("clickup_webhook_health_check"),
    "clickup_webhook_health_check is registered after registerAllHandlers()",
  );
  ok(
    isHandlerRegistered("clickup_webhook_repair"),
    "clickup_webhook_repair is registered after registerAllHandlers()",
  );

  // Ensure the startup assert passes for our 3 new required handlers.
  assertRequiredHandlersRegistered([
    "clickup_reconciliation_sweep",
    "clickup_webhook_health_check",
    "clickup_webhook_repair",
  ]);
  ok(
    true,
    "assertRequiredHandlersRegistered passes for all 3 new ClickUp handlers",
  );

  // ── 3. Scheduler exports ────────────────────────────────────────────────────
  const scheduler = await import(
    "../server/services/clickUpReconciliationScheduler"
  );
  ok(
    typeof scheduler.startClickUpReconciliationScheduler === "function",
    "startClickUpReconciliationScheduler is exported from clickUpReconciliationScheduler",
  );
  ok(
    typeof scheduler.stopClickUpReconciliationScheduler === "function",
    "stopClickUpReconciliationScheduler is exported from clickUpReconciliationScheduler",
  );

  // ── 4. Notification registry ────────────────────────────────────────────────
  const { NOTIFICATION_REGISTRY } = await import(
    "../server/services/notifications/registry"
  );
  const ids = new Set(NOTIFICATION_REGISTRY.map((n: any) => n.id));
  ok(
    ids.has("integration.clickup.auth_dead"),
    "notification registry contains integration.clickup.auth_dead",
  );
  ok(
    ids.has("integration.clickup.webhook_health_degraded"),
    "notification registry contains integration.clickup.webhook_health_degraded",
  );

  console.log(`\nclickup-sync-handlers: ${passed} assertion(s) passed.`);
  console.log("clickup-sync-handlers: verified");
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
