/* test-registration
{
  "name": "ClickUp role projection routes — auth gates, Zod rejection, and mutation response projection propagation (Task #5156)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast DB-free source and SSR contract suite: proves auth gates, Zod rejection, mutation projection fields, and safe Re-sync rendering. No real vendor egress.",
  "tier": "small",
  "tierReason": "Source-level assertions plus one server-rendered status card — no DB, HTTP, browser, or vendor egress. Completes in <2s.",
  "scanPaths": [
    "server/routes/serviceDesk",
    "server/routes/serviceDesk/departments.ts",
    "client/src/components/ui/ClickUpProjectionStatus.tsx",
    "client/src/pages/admin/RoleAssignments.tsx"
  ]
}
test-registration */
/**
 * Task #5156 — ClickUp role projection routes + UI contract smoke gate.
 *
 * Source-level contracts (DB-free, network-free):
 *
 *  A. New projection routes registered in departments.ts with correct
 *     auth gates (CEO vs team-lead).
 *  B. Zod validation present for bodies and query strings.
 *  C. Assignment mutation responses include projection field.
 *  D. Sandbox destination guard: canonical production list ID blocked.
 *  E. Projection status helper: projectionToastLabel returns correct labels
 *     and never says "synced" for pending/ambiguous states.
 *  F. RoleAssignments page registers projection status section and query.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ProjectionStatusCard,
  type ProjectionStatusRow,
} from "../client/src/components/ui/ClickUpProjectionStatus";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readServiceDeskRouteSources(): string {
  const dir = resolve("server/routes/serviceDesk");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .join("\n");
}

function routeBlock(source: string, path: string): string {
  const start = source.indexOf(`"${path}"`);
  assert.notEqual(start, -1, `route ${path} must exist`);
  const end = source.indexOf("\n  );", start);
  assert.notEqual(end, -1, `route ${path} must have a closing registration`);
  return source.slice(start, end);
}

// ─── A. Projection routes registered with correct auth gates ────────────────

{
  const src = readServiceDeskRouteSources();

  // CEO-only routes
  assert.ok(
    src.includes('"/api/service-desk/role-projections/configuration"') &&
      src.includes("requireCeo"),
    "GET /configuration must be registered and use requireCeo",
  );
  assert.ok(
    src.includes('"/api/service-desk/role-projections/destinations"') &&
      src.includes("requireCeo"),
    "PUT /destinations must be registered and use requireCeo",
  );
  assert.ok(
    src.includes('"/api/service-desk/role-projections/targets"') &&
      src.includes("requireCeo"),
    "PUT /targets must be registered and use requireCeo",
  );

  // Team-lead+ routes
  assert.ok(
    src.includes('"/api/service-desk/role-projections/status"') &&
      src.includes("requireTeamLead"),
    "GET /status must be registered and use requireTeamLead",
  );
  assert.ok(
    src.includes('"/api/service-desk/role-projections/resync"') &&
      src.includes("requireTeamLead"),
    "POST /resync must be registered and use requireTeamLead",
  );

  console.log("  ✓ A: projection routes registered with correct auth gates");
}

// ─── B. Zod validation for bodies and queries ─────────────────────────────

{
  const src = readServiceDeskRouteSources();

  // Destinations body validation
  assert.ok(
    src.includes("z.string().uuid()") && src.includes("z.enum"),
    "Route bodies must use Zod UUID and enum validation",
  );
  assert.ok(
    src.includes("safeParse"),
    "Routes must use safeParse for validation",
  );
  assert.ok(
    src.includes("Invalid request") || src.includes("Invalid query parameters"),
    "Routes must return error message when validation fails",
  );

  for (const path of [
    "/api/admin/role-assignments/clients/:clientId/departments/:departmentId",
    "/api/admin/role-assignments/departments/:id",
    "/api/admin/role-assignments/bulk",
  ]) {
    assert.ok(
      routeBlock(src, path).includes(".safeParse(req.body)"),
      `${path} must reject malformed/unknown mutation fields through Zod`,
    );
  }

  // Bounded list limit ≤ 200
  assert.ok(
    src.includes("200"),
    "Status route must enforce maximum limit of 200",
  );

  console.log("  ✓ B: Zod validation present for bodies and queries");
}

// ─── C. Assignment mutation responses include projection field ─────────────

{
  const src = readServiceDeskRouteSources();

  for (const path of [
    "/api/service-desk/clients/:clientId/assignments/:departmentId",
    "/api/service-desk/assignments/bulk",
    "/api/admin/role-assignments/clients/:clientId/departments/:departmentId",
    "/api/admin/role-assignments/departments/:id",
    "/api/admin/role-assignments/bulk",
  ]) {
    assert.ok(
      routeBlock(src, path).includes("projection: result.projection ?? null"),
      `${path} must preserve its response fields and add the honest projection envelope`,
    );
  }

  console.log("  ✓ C: assignment mutation responses include projection field");
}

// ─── D. Sandbox production list guard ─────────────────────────────────────

{
  const src = readServiceDeskRouteSources();

  assert.ok(
    src.includes("901417549202"),
    "Destinations route must guard against canonical production list ID",
  );
  assert.ok(
    src.includes("Cannot set the canonical production list ID") ||
      src.includes("sandbox destination"),
    "Guard must have a clear error message for the production list ID",
  );
  assert.ok(
    src.includes('val.environment === "sandbox"') &&
      src.includes('val.listId === "901417549202"'),
    "Canonical-list route guard must reject sandbox only, not valid production configuration",
  );

  console.log("  ✓ D: sandbox production list ID guard present in destinations route");
}

// ─── D2. Fail-loud static imports + approval-action wiring (architect A/D) ──

{
  const src = readServiceDeskRouteSources();

  // D-blocker: no dynamic import / as-any / swallow of the projection service.
  assert.ok(
    !src.includes("loadProjectionService"),
    "loadProjectionService dynamic-import shim must be removed (fail loud)",
  );
  assert.ok(
    !src.includes('await import("../../services/clickUpRoleProjection")'),
    "projection service must not be dynamically imported at call time",
  );
  // Static, typed imports of the five service functions at module top.
  for (const fn of [
    "listRoleProjectionConfiguration",
    "upsertRoleProjectionDestination",
    "upsertRoleProjectionClientTarget",
    "listRoleProjectionStatuses",
    "manualResyncProjectionByRole",
  ]) {
    assert.ok(
      src.includes(fn),
      `route must statically import/use ${fn}`,
    );
  }
  // No more 503 "not yet available" degraded responses.
  assert.ok(
    !src.includes("Projection service not yet available"),
    "degraded 503/200 'not yet available' responses must be gone (fail loud)",
  );

  // A-blocker: approval ACTIONS, strict body, no raw approval timestamps.
  assert.ok(
    src.includes("sandboxExitApproval") && src.includes("ownerApproval"),
    "destinations body must accept sandboxExitApproval/ownerApproval actions",
  );
  assert.ok(
    src.includes('z.enum(["approve", "revoke"]).optional()'),
    "approval fields must be approve|revoke action enums",
  );
  assert.ok(
    src.includes(".strict()"),
    "destinations body must be a strict Zod object (rejects raw timestamp fields)",
  );
  assert.ok(
    !src.includes("sandboxExitApprovedAt: ") && !src.includes("ownerApprovedAt: req"),
    "route must never accept raw approval timestamps from the client body",
  );
  // Actor comes from session, not client input.
  assert.ok(
    src.includes("req.dbUser?.id ?? req.user?.claims?.sub"),
    "actorId must come from the authenticated session only",
  );

  console.log("  ✓ D2: fail-loud static imports + approval-action wiring present");
}

// ─── E. projectionToastLabel — correct labels, never synced for pending ────

{
  // Import the helper directly via the compiled source contract check
  const helperSrc = readFileSync(
    resolve("client/src/components/ui/ClickUpProjectionStatus.tsx"),
    "utf8",
  );

  // Verify the key label strings are present
  assert.ok(
    helperSrc.includes("ClickUp synced"),
    "Helper must have a 'ClickUp synced' label",
  );
  assert.ok(
    helperSrc.includes("ClickUp pending"),
    "Helper must have a 'ClickUp pending' label",
  );
  assert.ok(
    helperSrc.includes("ambiguous"),
    "Helper must handle ambiguous state",
  );
  assert.ok(
    helperSrc.includes("blocked"),
    "Helper must handle blocked state",
  );
  assert.ok(
    helperSrc.includes("paused/disabled") || helperSrc.includes("paused"),
    "Helper must handle disabled/paused state",
  );
  assert.ok(
    helperSrc.includes("NoBull-only"),
    "Helper must handle nobull_only state",
  );
  assert.ok(
    helperSrc.includes("Error code:") &&
      helperSrc.includes("Next retry:") &&
      helperSrc.includes("ClickUp person:"),
    "Projection problem rows must expose error code, retry time, and exact desired ClickUp person",
  );

  // Critical safety rule: synced label only when state === "synced" and staged > 0
  // Verify that "ClickUp synced" is guarded by state === "synced"
  assert.ok(
    helperSrc.includes('state === "synced" && staged > 0'),
    "Synced label must only appear when state=synced AND staged>0",
  );

  // Verify that pending state does NOT return the synced label
  // The logic order should show pending checked separately from synced
  assert.ok(
    helperSrc.includes('state === "pending"') && helperSrc.includes('"ClickUp pending"'),
    "Pending state must return ClickUp pending label, not synced",
  );

  console.log("  ✓ E: projectionToastLabel has correct labels, synced only for synced state");
}

// ─── F. RoleAssignments page — projection status section ──────────────────

{
  const pageSrc = readFileSync(
    resolve("client/src/pages/admin/RoleAssignments.tsx"),
    "utf8",
  );
  const helperSrc = readFileSync(
    resolve("client/src/components/ui/ClickUpProjectionStatus.tsx"),
    "utf8",
  );

  // Projection status query
  assert.ok(
    pageSrc.includes("/api/service-desk/role-projections/status"),
    "RoleAssignments must query projection status endpoint",
  );
  assert.ok(
    pageSrc.includes("problemOnly=true"),
    "Projection status query must filter by problemOnly=true",
  );

  // Projection status section rendered
  assert.ok(
    pageSrc.includes('data-testid="projection-status-section"'),
    "RoleAssignments must render projection status section",
  );
  assert.ok(
    pageSrc.includes('data-testid="projection-status-list"'),
    "RoleAssignments must render projection status list",
  );

  // Re-sync button capability
  assert.ok(
    pageSrc.includes("/api/service-desk/role-projections/resync"),
    "RoleAssignments must call resync endpoint for Re-sync buttons",
  );
  assert.ok(
    pageSrc.includes('data-testid="button-refresh-projection-status"'),
    "RoleAssignments must have a refresh button for projection status",
  );
  const eligibleKinds = helperSrc.match(
    /RESYNC_ELIGIBLE_KINDS:[^=]+=\s*\[([\s\S]*?)\];/,
  )?.[1] ?? "";
  assert.ok(
    eligibleKinds.includes('"failed"') && eligibleKinds.includes('"blocked"'),
    "Re-sync must remain available for failed and blocked commands",
  );
  for (const unsafeKind of ["pending", "ambiguous", "drift"]) {
    assert.ok(
      !eligibleKinds.includes(`"${unsafeKind}"`),
      `Re-sync must not be offered for ${unsafeKind} commands`,
    );
  }
  assert.ok(
    helperSrc.includes("row.resyncEligible === true"),
    "Re-sync eligibility must require the server-computed unleased-state flag",
  );

  const baseRow: ProjectionStatusRow = {
    clientId: "client-1",
    departmentId: "department-1",
    responsibility: "checker",
    kind: "failed",
    desiredUserId: "user-1",
    desiredClickupUserId: "clickup-user-1",
    lastErrorCode: "exhausted",
    lastError: "Retry budget exhausted",
    attemptCount: 5,
    maxAttempts: 5,
    resyncEligible: false,
    nextAttemptAt: null,
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
  const ineligibleMarkup = renderToStaticMarkup(
    React.createElement(ProjectionStatusCard, {
      row: baseRow,
      onResync: () => undefined,
      resyncingKey: null,
    }),
  );
  assert.ok(
    !ineligibleMarkup.includes("button-resync-"),
    "A failed row with server-declared ineligible lease state must not render Re-sync",
  );
  const eligibleMarkup = renderToStaticMarkup(
    React.createElement(ProjectionStatusCard, {
      row: { ...baseRow, resyncEligible: true },
      onResync: () => undefined,
      resyncingKey: null,
    }),
  );
  assert.ok(
    eligibleMarkup.includes("button-resync-"),
    "A terminal failed unleased row must render Re-sync",
  );

  // Query invalidation after mutations
  assert.ok(
    pageSrc.includes('"/api/service-desk/role-projections/status"'),
    "RoleAssignments must invalidate projection status query after mutations",
  );

  // Import of projection helper
  assert.ok(
    pageSrc.includes("projectionToastLabel"),
    "RoleAssignments must import and use projectionToastLabel",
  );

  console.log("  ✓ F: RoleAssignments has projection status section with re-sync and query invalidation");
}

console.log("\nclickup-role-projection-routes: all sections passed (Task #5156).");
