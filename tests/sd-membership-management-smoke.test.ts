/* test-registration
{
  "name": "Membership management smoke — dialog editor at the row, people picker (no raw-ID paste), console Members tab + warning routing, team-lead member mutations (Task #4002)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4002: membership management contracts. Source-level scans (DB-free, network-free, fast): member mutations team-lead-gated with ClickUp auto-resolve + reactivation-preserve, departments listing carries memberCount, settings opens a dialog at the row (raw-ID inputs gone), shared editor uses a searchable people picker and invalidates counts+coverage, console gains Members tab / by-person memberships / warning that routes to the fix.",
  "scanPaths": [
    "client/src/components/admin/DepartmentMembersDialog.tsx",
    "client/src/pages/admin/RoleAssignments.tsx",
    "client/src/pages/admin/ServiceDeskSettings.tsx",
    "server/routes/serviceDesk",
    "server/services/assignmentBoundary.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4002 — membership management smoke gate.
 *
 * Source-level contracts, following the role-assignments-smoke pattern:
 *
 *  A. Server: member add/update/remove are team-lead-gated (console audience),
 *     while department structure routes stay CEO-gated; the departments
 *     listing carries an active-only memberCount; member add auto-resolves the
 *     ClickUp id from connected clickup_user_tokens, reports clickupResolution,
 *     and preserves a stored id on reactivation (COALESCE).
 *  B. Shared DepartmentMembersDialog: searchable people picker (cmdk) that
 *     excludes active members, manual ClickUp override input, member rows with
 *     names/emails, and invalidation of departments (counts) + coverage (role
 *     pickers) on membership changes.
 *  C. Settings Departments tab: member-count badge in the Members column,
 *     dialog opened from the row, and the raw NoBull-ID/ClickUp-ID paste
 *     inputs are gone.
 *  D. Role Assignments console: Members tab with per-department manage
 *     buttons, by-person membership display, and the "no active members"
 *     warnings (bulk dialog + grid editor) route to membership management
 *     instead of dead-ending.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// server/routes/serviceDesk.ts is a thin aggregator over per-feature modules;
// scan the concatenation so contracts hold regardless of which module hosts a
// route (same approach as role-assignments-smoke).
const serviceDeskDir = resolve("server/routes/serviceDesk");
const serverSource = readdirSync(serviceDeskDir)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map((f) => readFileSync(resolve(serviceDeskDir, f), "utf8"))
  .join("\n");
const assignmentBoundarySource = readFileSync(
  resolve("server/services/assignmentBoundary.ts"),
  "utf8",
);

// ─── A. Server contracts ──────────────────────────────────────────────────

{
  // Members section: every member mutation is team-lead-gated. Slice the
  // members block out of the departments module so the assertions can't be
  // satisfied by unrelated routes.
  const start = serverSource.indexOf('"/api/service-desk/departments/:id/members"');
  // fromIndex=start: the phrase also appears in the module's header comment,
  // which precedes the members routes.
  const end = serverSource.indexOf("Client × department assignments", start);
  assert.ok(start > -1 && end > start, "A: expected members routes before the assignments section");
  const membersBlock = serverSource.slice(start, end);

  assert.ok(
    !membersBlock.includes("requireCeo"),
    "A: member routes must NOT be CEO-gated anymore (console team leads manage membership)",
  );
  const teamLeadGates = membersBlock.match(/requireTeamLead/g) ?? [];
  assert.ok(
    teamLeadGates.length >= 3,
    `A: member add/update/remove must all be requireTeamLead-gated (found ${teamLeadGates.length})`,
  );

  // Department STRUCTURE stays CEO-gated (create/update/delete/import).
  const structureBlock = serverSource.slice(0, start);
  assert.ok(
    structureBlock.includes("requireCeo"),
    "A: department structure routes (create/update/delete) must stay CEO-gated",
  );

  // memberCount in the departments listing (active-only counted).
  assert.ok(
    serverSource.includes("memberCount"),
    "A: GET /api/service-desk/departments must include memberCount per department",
  );
  assert.ok(
    /count\(\*\)::int/.test(serverSource) && serverSource.includes("sdDepartmentMembers.active, true"),
    "A: memberCount must count ACTIVE members only",
  );

  // ClickUp auto-resolve seam: the shared durable-identity resolver, resolution
  // indicator, and COALESCE so reactivation never wipes a stored id.
  assert.ok(
    membersBlock.includes("resolveClickUpIdentity") &&
      membersBlock.includes('identity.source === "personal_oauth"'),
    "A: member add must auto-resolve the ClickUp id through the shared durable identity boundary",
  );
  assert.ok(
    membersBlock.includes("clickupResolution"),
    "A: member add must report how the ClickUp id was resolved (manual/connected/none)",
  );
  assert.ok(
    assignmentBoundarySource.includes("upsertDepartmentMember") &&
      assignmentBoundarySource.includes("COALESCE"),
    "A: reactivation must preserve a previously stored ClickUp id (COALESCE on conflict)",
  );
  console.log("  ✓ A: member mutations team-lead-gated; memberCount + ClickUp auto-resolve contracts hold");
}

// ─── B. Shared DepartmentMembersDialog ────────────────────────────────────

{
  const dialogSource = readFileSync(
    resolve("client/src/components/admin/DepartmentMembersDialog.tsx"),
    "utf8",
  );
  assert.ok(
    dialogSource.includes('data-testid="dialog-dept-members"'),
    "B: member editor must render as a dialog (immediate feedback at the clicked row)",
  );
  assert.ok(
    dialogSource.includes("CommandInput") && dialogSource.includes('data-testid="input-member-search"'),
    "B: adding a member must be a searchable people picker, not an ID field",
  );
  assert.ok(
    dialogSource.includes("activeMemberIds") && dialogSource.includes("!activeMemberIds.has("),
    "B: picker must exclude current ACTIVE members (inactive ones stay pickable to reactivate)",
  );
  assert.ok(
    dialogSource.includes('data-testid="input-member-clickup-override"'),
    "B: manual ClickUp override input must remain available",
  );
  assert.ok(
    dialogSource.includes("clickupResolution"),
    "B: dialog must surface the server's ClickUp resolution outcome",
  );
  assert.ok(
    dialogSource.includes('queryKey: ["/api/service-desk/departments"]') &&
      dialogSource.includes('apiScope === "universal" ? "/api/admin/role-assignments" : "/api/service-desk/coverage"') &&
      dialogSource.includes("queryKey: [coverageQueryKey]"),
    "B: membership changes must invalidate department counts AND coverage so role pickers update immediately",
  );
  assert.ok(
    dialogSource.includes("userLabel") && dialogSource.includes("u.email"),
    "B: member rows must show human names/emails instead of raw UUIDs",
  );
  const saveDefaultsBlock = dialogSource.slice(
    dialogSource.indexOf("async function saveRoleDefaults()"),
    dialogSource.indexOf("return (", dialogSource.indexOf("async function saveRoleDefaults()")),
  );
  assert.ok(
    !dialogSource.includes('select-dept-default-supervisor') &&
      !saveDefaultsBlock.includes("defaultSupervisorUserId"),
    "B: department role defaults must offer and submit Doer/Checker only",
  );
  console.log("  ✓ B: shared members dialog — searchable picker, override, invalidations, names/emails");
}

// ─── C. Service Desk Settings departments tab ─────────────────────────────

{
  const settingsSource = readFileSync(
    resolve("client/src/pages/admin/ServiceDeskSettings.tsx"),
    "utf8",
  );
  assert.ok(
    settingsSource.includes("badge-dept-member-count-"),
    "C: Members column must show a per-department member-count badge",
  );
  assert.ok(
    settingsSource.includes("DepartmentMembersDialog"),
    "C: settings must open the shared members dialog (no below-the-fold panel)",
  );
  assert.ok(
    settingsSource.includes("button-dept-members-"),
    "C: per-row Manage members affordance must remain",
  );
  assert.ok(
    !settingsSource.includes("input-member-user-id"),
    "C: raw NoBull-user-ID paste input must be gone from settings",
  );
  assert.ok(
    !settingsSource.includes("input-member-clickup-id"),
    "C: raw ClickUp-ID paste input must be gone from settings (override lives in the dialog)",
  );
  const coverageBlock = settingsSource.slice(
    settingsSource.indexOf("function CoveragePanel("),
    settingsSource.indexOf("function NeedsMappingPanel(", settingsSource.indexOf("function CoveragePanel(")),
  );
  assert.ok(
    !settingsSource.includes('value="role:supervisor"') &&
      settingsSource.includes('v === "role:doer" || v === "role:checker"'),
    "C: dynamic checklist assignee pickers must neither offer nor submit Supervisor",
  );
  assert.ok(
    !coverageBlock.includes("select-supervisor-coverage") &&
      !coverageBlock.includes("supervisorUserId:"),
    "C: coverage editing must not offer or submit Supervisor",
  );
  console.log("  ✓ C: settings shows member counts and opens the dialog at the row; raw-ID inputs gone");
}

// ─── D. Role Assignments console membership surfaces ──────────────────────

{
  const pageSource = readFileSync(resolve("client/src/pages/admin/RoleAssignments.tsx"), "utf8");
  assert.ok(
    pageSource.includes('data-testid="tab-members"') &&
      pageSource.includes('data-testid="role-assignments-members"'),
    "D: console must gain a Members tab with the membership view",
  );
  assert.ok(
    pageSource.includes("button-manage-members-"),
    "D: membership view must offer per-department manage buttons",
  );
  assert.ok(
    pageSource.includes("DepartmentMembersDialog"),
    "D: console must open the shared members dialog for add/remove",
  );
  assert.ok(
    pageSource.includes("person-memberships-"),
    "D: by-person view must show department memberships alongside roles",
  );
  assert.ok(
    pageSource.includes("This department has no active members.") &&
      pageSource.includes('data-testid="button-bulk-manage-members"'),
    "D: bulk-assign 'no active members' warning must link to membership management",
  );
  assert.ok(
    pageSource.includes("button-grid-manage-members-"),
    "D: grid editor's empty-membership state must link to membership management",
  );
  assert.ok(
    pageSource.includes("openMembersFor"),
    "D: warnings must route through the members-tab opener (tab switch + dialog)",
  );
  console.log("  ✓ D: console Members tab, by-person memberships, warnings route to the fix");
}

console.log("sd-membership-management-smoke: all sections passed (Task #4002).");
