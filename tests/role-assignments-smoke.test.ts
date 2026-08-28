/* test-registration
{
  "name": "Universal Role Assignments console smoke — promoted route, retired Supervisor API contract, compatibility links",
  "regression": true,
  "smoke": true,
  "smokeReason": "Universal Role Assignments console smoke gate. Source-level contracts: promoted and compatibility routes, team-lead-gated Doer/Checker assignment API, retired Supervisor response state, grid/by-person/default/member/bulk surfaces, and adjacent cross-links. Fast, DB-free.",
  "scanPaths": [
    "client/src/App.tsx",
    "client/src/components/QuicklinksBar.tsx",
    "client/src/pages/ClientDetail.tsx",
    "client/src/pages/admin/RoleAssignments.tsx",
    "client/src/pages/admin/ServiceDeskSettings.tsx",
    "server/routes/serviceDesk",
    "server/services/assignmentBoundary.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3626 — Role Assignments console smoke gate.
 *
 * Source-level contracts (DB-free, network-free, fast), following the
 * service-desk-reports-smoke pattern:
 *
 *  A. App.tsx registers /admin/role-assignments plus the historical
 *     /admin/service-desk/role-assignments alias.
 *  B. QuicklinksBar nav entry exists, team-lead-gated, linking to the tool.
 *  C. Bulk endpoint registered in serviceDesk.ts, gated by requireTeamLead,
 *     applies transactionally and records an audit entry.
 *  D. Coverage exposes supported Doer/Checker gap + stale-member fields and
 *     omits retired Supervisor state.
 *  E. RoleAssignments page renders the grid, by-person view, per-role gap
 *     badges/filters, and the bulk preview flow (dept+role+user pickers,
 *     select-all / gaps-only shortcuts, preview with overwrite marking).
 *  F. Cross-links from Service Desk Settings coverage panel and Client
 *     Detail assignments panel.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Task #3787: server/routes/serviceDesk.ts is now a thin aggregator over
// per-feature modules in server/routes/serviceDesk/. Source-contract
// assertions scan the concatenation of the split modules so they keep
// working regardless of which module holds a given route.

// ─── A. App.tsx route registration ────────────────────────────────────────

{
  const appSource = readFileSync(resolve("client/src/App.tsx"), "utf8");
  assert.ok(
    appSource.includes('@/pages/admin/RoleAssignments'),
    "App.tsx must lazy-import @/pages/admin/RoleAssignments",
  );
  assert.ok(
    appSource.includes('"/admin/service-desk/role-assignments"'),
    "App.tsx must preserve the historical Service Desk route alias",
  );
  assert.ok(
    appSource.includes('"/admin/role-assignments"'),
    'App.tsx must register Route path="/admin/role-assignments"',
  );
  assert.ok(
    appSource.includes("component={RoleAssignments}"),
    "App.tsx must wire RoleAssignments as the route component",
  );
  console.log("  ✓ A: promoted route and historical alias registered in App.tsx");
}

// ─── B. Admin navigation entry ────────────────────────────────────────────

{
  const navSource = readFileSync(resolve("client/src/components/QuicklinksBar.tsx"), "utf8");
  assert.ok(
    navSource.includes('id: "role-assignments"'),
    'QuicklinksBar manifest must include id "role-assignments"',
  );
  const entryMatch = navSource.match(/\{ id: "role-assignments".*\}/);
  assert.ok(entryMatch, "role-assignments manifest entry must be findable");
  const entry = entryMatch![0];
  assert.ok(
    entry.includes('href: "/admin/role-assignments"'),
    "nav entry must link to the promoted company-wide route",
  );
  assert.ok(
    entry.includes("isTeamLead"),
    "nav entry must be gated to team leads and above (isVisible uses isTeamLead)",
  );
  console.log("  ✓ B: team-lead-gated Role Assignments nav entry present");
}

// ─── C. Bulk endpoint in serviceDesk.ts ───────────────────────────────────

{
  const routeSource = readServiceDeskRouteSources();
  const boundarySource = readFileSync(resolve("server/services/assignmentBoundary.ts"), "utf8");
  const start = routeSource.indexOf('"/api/service-desk/assignments/bulk"');
  assert.ok(start >= 0, "serviceDesk.ts must register POST /api/service-desk/assignments/bulk");

  // Slice the bulk handler region (up to the next route registration).
  const rest = routeSource.slice(start);
  const end = rest.indexOf("app.get(", 10);
  const block = rest.slice(0, end > 0 ? end : undefined);

  assert.ok(
    /app\.post\(\s*\n?\s*"\/api\/service-desk\/assignments\/bulk",\s*\n?\s*isAuthenticated,\s*\n?\s*requireTeamLead/.test(routeSource),
    "bulk endpoint must be gated by isAuthenticated + requireTeamLead",
  );
  assert.ok(
    block.includes("setBulkClientAssignments"),
    "bulk endpoint must delegate to the neutral assignment boundary",
  );
  assert.ok(
    boundarySource.includes("setBulkClientAssignments") && boundarySource.includes(".transaction("),
    "the neutral bulk assignment boundary must run in a DB transaction",
  );
  assert.ok(
    block.includes("recordAdminSettingChange") && block.includes("sd_role_assignments_bulk"),
    "bulk endpoint must record an admin_setting_audit entry with settingKey sd_role_assignments_bulk",
  );
  assert.ok(
    block.includes("not an active member"),
    "bulk endpoint must enforce department-membership eligibility (422 path)",
  );
  console.log("  ✓ C: bulk endpoint gated, transactional, membership-validated, audited");
}

// ─── D. Coverage supported-role fields ────────────────────────────────────

{
  const routeSource = readServiceDeskRouteSources();
  for (const field of [
    "missingDoer",
    "missingChecker",
    "stalePrimary",
    "staleChecker",
  ]) {
    assert.ok(
      routeSource.includes(field),
      `coverage endpoint must expose ${field}`,
    );
  }
  for (const retiredField of ["missingSupervisor", "staleSupervisor"]) {
    assert.equal(
      routeSource.includes(retiredField),
      false,
      `coverage routes must omit retired Supervisor field ${retiredField}`,
    );
  }
  console.log("  ✓ D: coverage exposes Doer/Checker gaps and omits retired Supervisor state");
}

// ─── E. RoleAssignments page — grid, by-person, bulk preview ──────────────

{
  const pageSource = readFileSync(resolve("client/src/pages/admin/RoleAssignments.tsx"), "utf8");

  // Grid view
  assert.ok(pageSource.includes('data-testid="role-assignments-grid"'), "page must render the grid view");
  assert.ok(pageSource.includes('data-testid="input-search-grid"'), "grid must have client/department search");
  assert.ok(pageSource.includes('data-testid="select-gap-filter"'), "grid must have a per-role gap filter");
  for (const badge of ["badge-gap-doer", "badge-gap-checker"]) {
    assert.ok(pageSource.includes(`data-testid="${badge}"`), `page must show per-role gap count ${badge}`);
  }
  assert.equal(
    pageSource.includes('data-testid="badge-gap-supervisor"'),
    false,
    "live gap badges must omit retired Supervisor",
  );
  assert.equal(
    pageSource.includes('<SelectItem value="supervisor">'),
    false,
    "live assignment pickers must not offer retired Supervisor",
  );
  assert.ok(
    pageSource.includes("no longer an active member"),
    "grid must warn when an assigned user is no longer an active department member",
  );
  // Inline editing uses the neutral assignment boundary.
  assert.ok(
    pageSource.includes("/api/admin/role-assignments/clients/${editRow.clientId}/departments/${editRow.departmentId}") &&
      pageSource.includes('"PUT"'),
    "inline editing must use the neutral single-row PUT endpoint",
  );
  // Role dropdowns respect department membership
  assert.ok(
    pageSource.includes("membersByDept[row.departmentId]"),
    "role dropdowns must be limited to active department members",
  );

  // By-person view
  assert.ok(pageSource.includes('data-testid="role-assignments-by-person"'), "page must render the by-person view");
  assert.ok(pageSource.includes('data-testid="tab-by-person"'), "page must have a by-person tab");
  for (const retiredAggregation of [
    '["supervisor", row.supervisorUserId',
    '["supervisor", d.defaultSupervisorUserId',
    'e.role === "supervisor"',
  ]) {
    assert.equal(
      pageSource.includes(retiredAggregation),
      false,
      `by-person view must not aggregate retired Supervisor state via ${retiredAggregation}`,
    );
  }

  // Bulk flow
  assert.ok(pageSource.includes('data-testid="dialog-bulk-assign"'), "page must have the bulk-assign dialog");
  for (const tid of [
    "select-bulk-department",
    "select-bulk-role",
    "select-bulk-user",
    "button-select-all-clients",
    "button-select-gaps-only",
    "button-bulk-preview",
    "bulk-preview",
    "button-bulk-apply",
  ]) {
    assert.ok(pageSource.includes(`data-testid="${tid}"`), `bulk flow must include ${tid}`);
  }
  assert.ok(pageSource.includes("Overwrite"), "bulk preview must mark overwrites");
  assert.ok(
    pageSource.includes('"/api/admin/role-assignments/bulk"'),
    "bulk apply must call the neutral bulk endpoint",
  );
  for (const state of [
    "Explicit",
    "Inherited",
    "Company-wide",
    "Stale membership",
    "Missing ClickUp identity",
    "NoBull only",
  ]) {
    assert.ok(pageSource.includes(state), `page must explain assignment state: ${state}`);
  }
  assert.ok(
    pageSource.includes('apiScope="universal"'),
    "member picker must use the neutral assignment API from the universal console",
  );
  for (const marker of [
    'data-testid="role-column-setup-section"',
    'data-testid="role-column-readiness"',
    'data-testid="button-recheck-role-columns"',
    "ID, type & cardinality verified",
    "Map field (paused)",
    "Record owner approval",
    "mapped client",
  ]) {
    assert.ok(
      pageSource.includes(marker),
      `Role Assignments must expose canonical ClickUp role-column setup: ${marker}`,
    );
  }
  console.log("  ✓ E: RoleAssignments page renders supported-role gaps and a Doer/Checker-only bulk flow");
}

// ─── F. Cross-links ───────────────────────────────────────────────────────

{
  const settingsSource = readFileSync(resolve("client/src/pages/admin/ServiceDeskSettings.tsx"), "utf8");
  assert.ok(
    settingsSource.includes('"/admin/role-assignments"'),
    "Service Desk Settings coverage panel must link to the universal Role Assignments tool",
  );
  const clientDetailSource = readFileSync(resolve("client/src/pages/ClientDetail.tsx"), "utf8");
  assert.ok(
    clientDetailSource.includes("/admin/role-assignments"),
    "Client Detail assignments panel must link to the universal Role Assignments tool",
  );
  console.log("  ✓ F: cross-links from Service Desk Settings + Client Detail present");
}

console.log("role-assignments-smoke: all sections passed (Task #3626).");

function readServiceDeskRouteSources(): string {
  const dir = resolve("server/routes/serviceDesk");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .join("\n");
}
