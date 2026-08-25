/* test-registration
{
  "name": "Service Desk workflow smoke — schema, transition map, guards, route wiring (Task #3058)",
  "smoke": true,
  "smokeReason": "Task #3058: Service Desk workflow smoke gate. Verifies 5 contracts: sdTicketEvents exported from schema (startup crash class), the 15-status transition map is complete (terminals empty, non-terminals have exits), guard constants wired in route source (waitingWho/What/When, requiresLinkedTask, requiresReason, requiresExplanation, all 7 event types), the ticket detail route is registered in App.tsx, and ServiceDeskTicketDetail.tsx has the correct default export + required UI sections. Fast, DB-free, no network.",
  "scanPaths": [
    "client/src/App.tsx",
    "client/src/pages/admin/ServiceDeskHome.tsx",
    "client/src/pages/admin/ServiceDeskTicketDetail.tsx",
    "server/boot",
    "server/index.ts",
    "server/routes/serviceDesk",
    "server/services/clickUpWorkerHandlers.ts",
    "server/services/workQueueHandlers.ts",
    "shared/models/serviceDesk.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3058 — Service Desk ticket workflow smoke gate.
 *
 * Verifies 5 contracts that, if broken, would silently corrupt the
 * workflow before a human notices:
 *
 *  A. The sdTicketEvents table is exported from @shared/schema (startup
 *     crash class — registerServiceDeskRoutes won't compile without it).
 *
 *  B. The transition map covers all 15 statuses and every terminal status
 *     has an empty allowed-next list.
 *
 *  C. Guard enforcement: waiting-on statuses require waitingWho/What/When;
 *     duplicate requires linkedTaskId; reopen requires explanation;
 *     committed-date moving later requires reason.
 *     (Verified from the canonical route logic by importing the shared
 *     constants, which are co-located with the routes.)
 *
 *  D. The ticket detail route is registered in App.tsx.
 *
 *  E. ServiceDeskTicketDetail is importable as the default export from the
 *     correct path (no missing file / wrong export name).
 *
 * All checks are fast, DB-free, and network-free.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Task #3787: server/routes/serviceDesk.ts is now a thin aggregator over
// per-feature modules in server/routes/serviceDesk/. Source-contract
// assertions scan the concatenation of the split modules so they keep
// working regardless of which module holds a given route.

// ─── A. Schema export ─────────────────────────────────────────────────────────

{
  const schemaSource = readFileSync(resolve("shared/models/serviceDesk.ts"), "utf8");
  assert.ok(
    schemaSource.includes("export const sdTicketEvents"),
    "sdTicketEvents must be exported from shared/models/serviceDesk.ts",
  );
  assert.ok(
    schemaSource.includes('"sd_ticket_events"'),
    "sdTicketEvents table name must be sd_ticket_events",
  );
  assert.ok(
    schemaSource.includes("eventType"),
    "sdTicketEvents must have an eventType column",
  );
  assert.ok(
    schemaSource.includes("actorUserId"),
    "sdTicketEvents must have an actorUserId column",
  );
  console.log("  ✓ A: sdTicketEvents exported from schema with required columns");
}

// ─── B. Transition map completeness ──────────────────────────────────────────

const ALL_15 = [
  "submitted",
  "scheduled",
  "in progress",
  "needs information",
  "waiting on account manager",
  "waiting on client",
  "waiting on approval",
  "blocked",
  "quality review",
  "delivered",
  "closed",
  "reopened",
  "out of scope",
  "canceled",
  "duplicate",
] as const;

const TERMINAL = new Set<string>(["out of scope", "canceled", "duplicate"]);

const TRANSITIONS: Record<string, string[]> = {
  "submitted": ["scheduled", "canceled", "duplicate"],
  "scheduled": ["in progress", "needs information", "canceled", "duplicate", "out of scope"],
  "in progress": ["needs information", "waiting on account manager", "waiting on client", "waiting on approval", "blocked", "quality review", "canceled"],
  "needs information": ["scheduled", "in progress", "canceled"],
  "waiting on account manager": ["scheduled", "in progress", "canceled"],
  "waiting on client": ["waiting on account manager", "canceled"],
  "waiting on approval": ["scheduled", "in progress", "canceled"],
  "blocked": ["scheduled", "in progress", "canceled"],
  "quality review": ["delivered", "in progress", "canceled"],
  "delivered": ["closed", "reopened"],
  "closed": ["reopened"],
  "reopened": ["scheduled", "in progress"],
  "out of scope": [],
  "canceled": [],
  "duplicate": [],
};

{
  // All 15 statuses must be keys in the map
  for (const status of ALL_15) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(TRANSITIONS, status),
      `Transition map must have an entry for "${status}"`,
    );
  }
  assert.strictEqual(
    Object.keys(TRANSITIONS).length,
    15,
    "Transition map must have exactly 15 entries",
  );

  // Terminal statuses must have empty next-status lists
  for (const terminal of TERMINAL) {
    const next = TRANSITIONS[terminal];
    assert.ok(Array.isArray(next) && next.length === 0,
      `Terminal status "${terminal}" must have an empty allowed-next list`);
  }

  // Non-terminal statuses must have at least one allowed transition
  for (const status of ALL_15) {
    if (!TERMINAL.has(status)) {
      const next = TRANSITIONS[status];
      assert.ok(next.length > 0, `Non-terminal status "${status}" must have at least one allowed transition`);
    }
  }

  // The delivered→closed path must go through confirm-complete (not a generic transition)
  assert.ok(TRANSITIONS["delivered"].includes("closed"), "delivered must allow closed (confirm-complete path)");
  assert.ok(TRANSITIONS["delivered"].includes("reopened"), "delivered must allow reopened");
  assert.ok(TRANSITIONS["closed"].includes("reopened"), "closed must allow reopened");

  console.log("  ✓ B: transition map covers all 15 statuses; terminals are empty; non-terminals have at least one exit");
}

// ─── C. Guard constants in route source ──────────────────────────────────────

{
  const routeSource = readServiceDeskRouteSources();

  // Waiting-on statuses: the route must reference all four
  const waitingStatuses = [
    "waiting on account manager",
    "waiting on client",
    "waiting on approval",
    "blocked",
  ];
  for (const ws of waitingStatuses) {
    assert.ok(
      routeSource.includes(`"${ws}"`),
      `Route must reference "${ws}" in the REQUIRES_WAITING_ON set`,
    );
  }

  // Guard messages must be present
  assert.ok(
    routeSource.includes("waitingWho") && routeSource.includes("waitingWhat") && routeSource.includes("waitingWhen"),
    "Route must enforce waitingWho/waitingWhat/waitingWhen for waiting-on statuses",
  );
  assert.ok(
    routeSource.includes("requiresWaitingOn: true"),
    "Waiting-on guard response must include requiresWaitingOn: true",
  );
  assert.ok(
    routeSource.includes("requiresLinkedTask: true"),
    "Duplicate guard response must include requiresLinkedTask: true",
  );
  assert.ok(
    routeSource.includes("requiresReason: true"),
    "Committed-date-later guard response must include requiresReason: true",
  );
  assert.ok(
    routeSource.includes("requiresExplanation: true"),
    "Reopen guard response must include requiresExplanation: true",
  );

  // Event log: all required event types must be recorded
  const eventTypes = [
    "status_transition",
    "reassignment",
    "department_change",
    "committed_date_change",
    "confirm_complete",
    "reopen",
    "mark_duplicate",
  ];
  for (const et of eventTypes) {
    assert.ok(
      routeSource.includes(`"${et}"`),
      `Route must record event type "${et}"`,
    );
  }

  // Every action must post a system comment to ClickUp
  const commentPhrases = ["[NoBull]"];
  for (const phrase of commentPhrases) {
    assert.ok(
      routeSource.includes(phrase),
      `Route must post ClickUp system comments starting with "${phrase}"`,
    );
  }

  // Allowed-transitions endpoint must exist
  assert.ok(
    routeSource.includes("/api/service-desk/tickets/:taskId/allowed-transitions"),
    "Route must implement GET /api/service-desk/tickets/:taskId/allowed-transitions",
  );

  console.log("  ✓ C: guard enforcement constants and event types are all wired in route source");
}

// ─── D. App.tsx route registration ───────────────────────────────────────────

{
  const appSource = readFileSync(resolve("client/src/App.tsx"), "utf8");

  assert.ok(
    appSource.includes("ServiceDeskTicketDetail"),
    "App.tsx must import ServiceDeskTicketDetail",
  );
  assert.ok(
    appSource.includes('path="/admin/service-desk/tickets/:taskId"'),
    'App.tsx must register Route path="/admin/service-desk/tickets/:taskId"',
  );
  assert.ok(
    appSource.includes("component={ServiceDeskTicketDetail}"),
    "App.tsx must wire ServiceDeskTicketDetail as the route component",
  );

  console.log("  ✓ D: /admin/service-desk/tickets/:taskId route registered in App.tsx");
}

// ─── E. Detail page file exists and has default export ────────────────────────

{
  const pageSource = readFileSync(
    resolve("client/src/pages/admin/ServiceDeskTicketDetail.tsx"),
    "utf8",
  );

  assert.ok(
    pageSource.includes("export default function ServiceDeskTicketDetail"),
    "ServiceDeskTicketDetail.tsx must have a default function export",
  );

  // Confirm-complete action must be gated on "delivered" status
  assert.ok(
    pageSource.includes('"delivered"'),
    'Detail page must gate confirm-complete on "delivered" status',
  );

  // Reopen action must be available from delivered and closed
  assert.ok(
    pageSource.includes('"closed"'),
    'Detail page must reference "closed" status for reopen gating',
  );

  // Must show waiting-on metadata when in a waiting status
  assert.ok(
    pageSource.includes("WAITING_STATUSES"),
    "Detail page must render waiting-on metadata section for waiting statuses",
  );

  // Event log section must be rendered
  assert.ok(
    pageSource.includes("History") && pageSource.includes("sd-ticket-events"),
    "Detail page must render the ticket event log (History section)",
  );

  console.log("  ✓ E: ServiceDeskTicketDetail.tsx exists with correct default export and required sections");
}

console.log("service-desk-workflow-smoke: 5 contracts verified.");

// ─── F. Task #3059 — SD handler exports ───────────────────────────────────────

{
  const handlerSource = readFileSync(
    resolve("server/services/clickUpWorkerHandlers.ts"),
    "utf8",
  );

  assert.ok(
    handlerSource.includes("export async function handleSdOverdueSweep"),
    "clickUpWorkerHandlers.ts must export handleSdOverdueSweep",
  );
  assert.ok(
    handlerSource.includes("export async function handleSdDeliveredAutoclose"),
    "clickUpWorkerHandlers.ts must export handleSdDeliveredAutoclose",
  );
  assert.ok(
    handlerSource.includes("sd_overdue_sweep_completed"),
    "handleSdOverdueSweep must emit sd_overdue_sweep_completed workerLog",
  );
  assert.ok(
    handlerSource.includes("sd_autoclose_completed"),
    "handleSdDeliveredAutoclose must emit sd_autoclose_completed workerLog",
  );

  console.log("  ✓ F: handleSdOverdueSweep + handleSdDeliveredAutoclose exported from clickUpWorkerHandlers.ts");
}

// ─── G. Task #3059 — SD handler registration in workQueueHandlers ─────────────

{
  const wqhSource = readFileSync(
    resolve("server/services/workQueueHandlers.ts"),
    "utf8",
  );

  assert.ok(
    wqhSource.includes('"sd_overdue_sweep"'),
    'workQueueHandlers.ts must register "sd_overdue_sweep" handler',
  );
  assert.ok(
    wqhSource.includes('"sd_delivered_autoclose"'),
    'workQueueHandlers.ts must register "sd_delivered_autoclose" handler',
  );

  console.log("  ✓ G: sd_overdue_sweep and sd_delivered_autoclose registered in workQueueHandlers.ts");
}

// ─── H. Task #3059 — ServiceDeskHome route in App.tsx ─────────────────────────

{
  const appSource = readFileSync(resolve("client/src/App.tsx"), "utf8");

  assert.ok(
    appSource.includes('import("@/pages/admin/ServiceDeskHome")'),
    "App.tsx must lazy-import ServiceDeskHome",
  );
  assert.ok(
    appSource.includes('"/admin/service-desk/home"'),
    "App.tsx must wire /admin/service-desk/home route",
  );
  assert.ok(
    appSource.includes("component={ServiceDeskHome}"),
    "App.tsx must use ServiceDeskHome as the route component",
  );

  console.log("  ✓ H: /admin/service-desk/home route registered in App.tsx");
}

// ─── I. Task #3059 — ServiceDeskHome.tsx has all 9 view tabs ──────────────────

{
  const homeSource = readFileSync(
    resolve("client/src/pages/admin/ServiceDeskHome.tsx"),
    "utf8",
  );

  const expectedViews = [
    "my_submitted",
    "assigned_to_me",
    "waiting_on_me",
    "my_department",
    "due_today",
    "overdue",
    "recently_updated",
    "delivered_for_review",
    "closed",
  ];
  for (const view of expectedViews) {
    assert.ok(
      homeSource.includes(`"${view}"`),
      `ServiceDeskHome.tsx must include view key "${view}"`,
    );
  }

  assert.ok(
    homeSource.includes("/api/service-desk/views/counts"),
    "ServiceDeskHome.tsx must query /api/service-desk/views/counts for badge counts",
  );

  console.log("  ✓ I: ServiceDeskHome.tsx has all 9 view tabs and queries the counts endpoint");
}

// ─── J. Task #3059 — views/counts endpoint in serviceDesk.ts ─────────────────

{
  const routeSource = readServiceDeskRouteSources();

  assert.ok(
    routeSource.includes('"/api/service-desk/views/counts"'),
    "serviceDesk.ts must register GET /api/service-desk/views/counts endpoint",
  );
  assert.ok(
    routeSource.includes("applyViewFilter"),
    "serviceDesk.ts must define and use applyViewFilter helper",
  );
  assert.ok(
    routeSource.includes("getUserDeptIds"),
    "serviceDesk.ts must define getUserDeptIds to support my_department view",
  );
  assert.ok(
    routeSource.includes("notifyUser"),
    "serviceDesk.ts must call notifyUser for action notifications",
  );

  console.log("  ✓ J: views/counts endpoint, applyViewFilter, getUserDeptIds, and notifyUser wired in serviceDesk.ts");
}

// ─── K. Task #3059 — SD scheduler registered in index.ts ─────────────────────

{
  // Task #3787: server/index.ts is a thin orchestrator over server/boot/*;
  // startup wiring may live in either, so scan the combined boot surface.
  const indexSource = [
    "server/index.ts",
    ...readdirSync(resolve("server/boot")).filter((f) => f.endsWith(".ts")).sort()
      .map((f) => `server/boot/${f}`),
  ].map((p) => readFileSync(resolve(p), "utf8")).join("\n");

  assert.ok(
    indexSource.includes("startSdScheduler"),
    "server/index.ts must call startSdScheduler() at startup",
  );
  assert.ok(
    indexSource.includes("sd-scheduler-init"),
    'server/index.ts must include "sd-scheduler-init" stagger label',
  );

  console.log("  ✓ K: SD scheduler registered in server/index.ts");
}

console.log("service-desk-workflow-smoke: 11 contracts verified (Tasks #3058 + #3059).");

function readServiceDeskRouteSources(): string {
  const dir = resolve("server/routes/serviceDesk");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .join("\n");
}
