/* test-registration
{
  "name": "SD role resolution — company scope + per-role default fallback across submit/checklist consumers (Task #4171)",
  "regression": true,
  "sweepOnlyReason": "Task #4171 — DB-heavy (runInIsolatedSchema: users, clients, sd_departments, sd_client_dept_assignments, clickup_user_tokens); the pure computeEffectiveRoles semantics are exercised here alongside the DB-backed resolvers.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #5235 — shared Doer/Checker resolution semantics.
 *
 * Sections:
 *   (A) computeEffectiveRoles (pure) — per_client: assignment wins per role,
 *       empty slot falls back to the dept default, non-null slot BLOCKS the
 *       default even when stale (Task #3586 semantics), null assignment row
 *       = all-defaults; sources labeled assignment/default.
 *   (B) computeEffectiveRoles (pure) — company: dept-level holders win
 *       regardless of any assignment row; sources labeled company.
 *   (C) resolveEffectiveRoles (DB) — loads dept + assignment; company scope
 *       never consults the assignment row; unknown dept resolves all-null.
 *   (D) resolveSubmitAutoAssign (DB) — doer/checker + connected ClickUp ids;
 *       default fallback for empty slots; no-client per-client dept resolves
 *       from defaults alone.
 *   (E) resolveChecklistStepAssignees (DB) — role tokens resolve via the
 *       shared rules: per-client dept default fallback; company dept with
 *       NO client still resolves; unconfigured role → unassigned + warning.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import {
  computeEffectiveRoles,
  resolveClickUpIdentity,
  resolveEffectiveRoles,
  resolveSubmitAutoAssign,
  resolveUniversalAssignment,
  type SdDeptRoleFields,
} from "../server/services/sdRoleResolution";
import { resolveChecklistStepAssignees } from "../server/services/sdChecklistAssignees";
import {
  GBP_LOCAL_SEO_DEPARTMENT_ID,
  PAID_SEARCH_DEPARTMENT_ID,
  departmentSupportsChecker,
  getDepartmentRoleCapabilities,
} from "../shared/departmentRoleCapabilities";
import { runInIsolatedSchema } from "./db-sandbox";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const DOER_ID = `test-4171rr-doer-${RUN}`;
const CHECKER_ID = `test-4171rr-checker-${RUN}`;
const DEFAULT_DOER_ID = `test-4171rr-ddoer-${RUN}`;
const DEFAULT_CHECKER_ID = `test-4171rr-dchecker-${RUN}`;
const CLIENT_ID = `test-4171rr-client-${RUN}`;
const DEPT_PC = PAID_SEARCH_DEPARTMENT_ID; // per_client scope, Checker approved
const DEPT_CO = GBP_LOCAL_SEO_DEPARTMENT_ID; // company scope, Checker approved
const DEPT_EMPTY = `dept-4171rr-empty-${RUN}`; // per_client, no defaults, no assignment

const TABLES = [
  "users",
  "clients",
  "sd_departments",
  "sd_department_members",
  "sd_client_dept_assignments",
  "sd_list_mapping",
  "clickup_user_tokens",
] as const;

// ── (A)+(B) pure semantics — no DB needed ────────────────────────────────────

function pureSections(): void {
  // Task #5233: checker capability is an explicit UUID allow-list, not a
  // display-name convention. Both owner-approved departments are supported;
  // any new/unknown UUID defaults to Doer-only.
  for (const [id, label] of [
    [PAID_SEARCH_DEPARTMENT_ID, "Paid Search"],
    [GBP_LOCAL_SEO_DEPARTMENT_ID, "GBP / Local SEO"],
  ] as const) {
    assert.equal(departmentSupportsChecker(id), true, `${label}: approved UUID supports Checker`);
    assert.deepEqual(
      getDepartmentRoleCapabilities(id),
      { doer: true, checker: true },
      `${label}: approved UUID has the complete Checker-capable shape`,
    );
  }
  const newDepartmentId = `new-department-${RUN}`;
  assert.equal(departmentSupportsChecker(newDepartmentId), false, "new department is Checker default-deny");
  assert.deepEqual(
    getDepartmentRoleCapabilities(newDepartmentId),
    { doer: true, checker: false },
    "new department remains Doer-capable while Checker is denied",
  );
  console.log("  ✓ capability contract: both approved UUIDs + default-deny new department");

  const perClientDept: SdDeptRoleFields = {
    id: PAID_SEARCH_DEPARTMENT_ID,
    assignmentScope: "per_client",
    defaultPrimaryUserId: "d-doer",
    defaultCheckerUserId: "d-checker",
  };

  // A1: assignment wins per role; empty slots fall back per role.
  const a1 = computeEffectiveRoles(perClientDept, {
    primaryUserId: "a-doer",
    checkerUserId: null,
  });
  assert.equal(a1.primaryUserId, "a-doer", "A1: assigned doer wins");
  assert.equal(a1.checkerUserId, "d-checker", "A1: empty checker falls back to dept default");
  assert.deepEqual(
    a1.sources,
    { primary: "assignment", checker: "default" },
    "A1: sources labeled per role",
  );

  // A2: null assignment row = all defaults; roles without a default are null.
  const a2 = computeEffectiveRoles(perClientDept, null);
  assert.equal(a2.primaryUserId, "d-doer", "A2: doer from default");
  assert.equal(a2.checkerUserId, "d-checker", "A2: checker from default");
  assert.deepEqual(
    a2.sources,
    { primary: "default", checker: "default" },
    "A2: default/null sources",
  );

  // A3: a non-null assigned slot BLOCKS the default — resolution is pure and
  // does not know about membership, so even a "stale" assigned user wins
  // (coverage math layers staleness on top; Task #3586 semantics).
  const a3 = computeEffectiveRoles(perClientDept, {
    primaryUserId: "stale-doer",
    checkerUserId: null,
  });
  assert.equal(a3.primaryUserId, "stale-doer", "A3: assigned (possibly stale) doer blocks the default");
  assert.equal(a3.sources.primary, "assignment", "A3: source stays assignment");
  console.log("  ✓ A: computeEffectiveRoles per_client — per-role assignment-wins + default fallback");

  // B: company scope — dept-level holders regardless of the assignment row.
  const companyDept: SdDeptRoleFields = {
    id: GBP_LOCAL_SEO_DEPARTMENT_ID,
    assignmentScope: "company",
    defaultPrimaryUserId: "c-doer",
    defaultCheckerUserId: null,
  };
  const b1 = computeEffectiveRoles(companyDept, {
    primaryUserId: "ignored-doer",
    checkerUserId: "ignored-checker",
  });
  assert.equal(b1.primaryUserId, "c-doer", "B: company doer from dept-level holder");
  assert.equal(b1.checkerUserId, null, "B: empty company checker stays null (assignment row ignored)");
  assert.deepEqual(
    b1.sources,
    { primary: "company", checker: null },
    "B: company/null sources",
  );
  console.log("  ✓ B: computeEffectiveRoles company — dept-level holders, assignment row ignored");
}

// ── DB-backed sections ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  pureSections();

  await runInIsolatedSchema(
    async ({ db }) => {
      // Seed users.
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES
          (${DOER_ID}, 'account_manager', 'Doer'),
          (${CHECKER_ID}, 'account_manager', 'Checker'),
          (${DEFAULT_DOER_ID}, 'account_manager', 'DefaultDoer'),
          (${DEFAULT_CHECKER_ID}, 'account_manager', 'DefaultChecker')
      `);
      await db.execute(sql`
        INSERT INTO clients (id, firm_name, is_archived)
        VALUES (${CLIENT_ID}, ${'RR Firm ' + RUN}, false)
      `);
      await db.execute(sql`
        INSERT INTO sd_list_mapping (id, clickup_workspace_id)
        VALUES (${`mapping-${RUN}`}, 'workspace-1')
      `);

      // Departments: per_client with defaults; company with holders; empty.
      await db.execute(sql`
        INSERT INTO sd_departments
          (id, name, active, sort_order, assignment_scope,
           default_primary_user_id, default_checker_user_id)
        VALUES
          (${DEPT_PC}, ${'PC ' + RUN}, true, 1, 'per_client', ${DEFAULT_DOER_ID}, ${DEFAULT_CHECKER_ID}),
          (${DEPT_CO}, ${'CO ' + RUN}, true, 2, 'company', ${DOER_ID}, ${CHECKER_ID}),
          (${DEPT_EMPTY}, ${'EMPTY ' + RUN}, true, 3, 'per_client', NULL, NULL)
      `);

      // Per-client assignment for DEPT_PC: explicit doer, empty checker
      // (→ default). A poison row for the COMPANY dept
      // proves company resolution ignores assignment rows entirely.
      await db.execute(sql`
        INSERT INTO sd_client_dept_assignments (id, client_id, department_id, primary_user_id, checker_user_id)
        VALUES
          (${`a-pc-${RUN}`}, ${CLIENT_ID}, ${DEPT_PC}, ${DOER_ID}, NULL),
          (${`a-co-${RUN}`}, ${CLIENT_ID}, ${DEPT_CO}, ${DEFAULT_DOER_ID}, ${DEFAULT_CHECKER_ID})
      `);

      // Every configured holder is an active department member. The company
      // checker has a durable verified member identity but disconnected OAuth.
      await db.execute(sql`
        INSERT INTO sd_department_members (id, department_id, user_id, clickup_user_id, active)
        VALUES
          (${`m-pc-doer-${RUN}`}, ${DEPT_PC}, ${DOER_ID}, NULL, true),
          (${`m-pc-ddoer-${RUN}`}, ${DEPT_PC}, ${DEFAULT_DOER_ID}, NULL, true),
          (${`m-pc-dchecker-${RUN}`}, ${DEPT_PC}, ${DEFAULT_CHECKER_ID}, NULL, true),
          (${`m-co-doer-${RUN}`}, ${DEPT_CO}, ${DOER_ID}, NULL, true),
          (${`m-co-checker-${RUN}`}, ${DEPT_CO}, ${CHECKER_ID}, '91003', true)
      `);

      // Connected ClickUp identities for doer + default-checker. The company
      // checker token is intentionally disconnected; projection uses the
      // durable department-member id above.
      await db.execute(sql`
        INSERT INTO clickup_user_tokens (id, user_id, access_token_encrypted, clickup_user_id, status, connected_at, updated_at)
        VALUES
          (${`tok-doer-${RUN}`}, ${DOER_ID}, 'stub-enc', '91001', 'connected', NOW(), NOW()),
          (${`tok-dchk-${RUN}`}, ${DEFAULT_CHECKER_ID}, 'stub-enc', '91002', 'connected', NOW(), NOW()),
          (${`tok-co-${RUN}`}, ${CHECKER_ID}, 'stub-enc', '91003', 'disconnected', NOW(), NOW())
      `);

      // ── (C) resolveEffectiveRoles ────────────────────────────────────────
      const cPc = await resolveEffectiveRoles({ departmentId: DEPT_PC, clientId: CLIENT_ID });
      assert.equal(cPc.primaryUserId, DOER_ID, "C: per_client assigned doer");
      assert.equal(cPc.checkerUserId, DEFAULT_CHECKER_ID, "C: per_client empty checker → default");

      const cCo = await resolveEffectiveRoles({ departmentId: DEPT_CO, clientId: CLIENT_ID });
      assert.equal(cCo.primaryUserId, DOER_ID, "C: company doer = dept holder (poison assignment ignored)");
      assert.equal(cCo.checkerUserId, CHECKER_ID, "C: company checker = dept holder");
      assert.deepEqual(
        cCo.sources,
        { primary: "company", checker: "company" },
        "C: company sources",
      );

      // Company dept without a client still resolves (no assignment lookup).
      const cCoNoClient = await resolveEffectiveRoles({ departmentId: DEPT_CO, clientId: null });
      assert.equal(cCoNoClient.checkerUserId, CHECKER_ID, "C: company checker resolves without a client");

      const cUnknown = await resolveEffectiveRoles({ departmentId: `nope-${RUN}`, clientId: CLIENT_ID });
      assert.deepEqual(
        [cUnknown.primaryUserId, cUnknown.checkerUserId],
        [null, null],
        "C: unknown department resolves all-null",
      );
      console.log("  ✓ C: resolveEffectiveRoles — per_client fallback, company ignores assignments, unknown dept null");

      // ── (D) resolveSubmitAutoAssign ──────────────────────────────────────
      const dPc = await resolveSubmitAutoAssign({ departmentId: DEPT_PC, clientId: CLIENT_ID });
      assert.equal(dPc.primaryUserId, DOER_ID, "D: submit doer = assigned");
      assert.equal(dPc.checkerUserId, DEFAULT_CHECKER_ID, "D: submit checker = dept default fallback");
      assert.equal(dPc.primaryClickupId, "91001", "D: doer ClickUp id resolved");
      assert.equal(dPc.checkerClickupId, "91002", "D: default checker ClickUp id resolved");

      // No client on the ticket: per-client dept falls back to defaults for
      // all roles (Task #4171 behavior change — previously nobody resolved).
      const dNoClient = await resolveSubmitAutoAssign({ departmentId: DEPT_PC, clientId: null });
      assert.equal(dNoClient.primaryUserId, DEFAULT_DOER_ID, "D: no-client ticket → default doer");
      assert.equal(dNoClient.checkerUserId, DEFAULT_CHECKER_ID, "D: no-client ticket → default checker");
      assert.equal(dNoClient.primaryClickupId, null, "D: default doer has no ClickUp token → null");

      const dCo = await resolveSubmitAutoAssign({ departmentId: DEPT_CO, clientId: null });
      assert.equal(dCo.primaryUserId, DOER_ID, "D: company dept doer without client");
      assert.equal(
        dCo.checkerClickupId,
        "91003",
        "D: durable company-checker ClickUp id survives disconnected personal OAuth",
      );

      const dEmpty = await resolveSubmitAutoAssign({ departmentId: DEPT_EMPTY, clientId: CLIENT_ID });
      assert.deepEqual(
        [dEmpty.primaryUserId, dEmpty.checkerUserId, dEmpty.primaryClickupId, dEmpty.checkerClickupId],
        [null, null, null, null],
        "D: dept with no assignment and no defaults resolves nobody",
      );
      console.log("  ✓ D: resolveSubmitAutoAssign — assigned + default fallback + ClickUp ids + no-client cases");

      // ── (E) resolveChecklistStepAssignees ───────────────────────────────
      // Steps: doer (assigned → 91001), checker (default → 91002).
      const ePc = await resolveChecklistStepAssignees(
        [
          { name: "Do it", assigneeRole: "doer" },
          { name: "Check it", assigneeRole: "checker" },
        ],
        { clientId: CLIENT_ID, departmentId: DEPT_PC },
      );
      assert.deepEqual(ePc.assignees, [91001, 91002], "E: per_client Doer/Checker tokens resolve");

      // Company dept with NO client: role tokens still resolve from holders.
      const eCo = await resolveChecklistStepAssignees(
        [
          { name: "Do it", assigneeRole: "doer" },
          { name: "Check it", assigneeRole: "checker" },
        ],
        { clientId: null, departmentId: DEPT_CO },
      );
      assert.deepEqual(eCo.assignees, [91001, 91003], "E: company dept resolves role tokens without a client");

      // Unconfigured role on the empty dept → unassigned + role warning.
      const eEmpty = await resolveChecklistStepAssignees(
        [{ name: "Check it", assigneeRole: "checker" }],
        { clientId: CLIENT_ID, departmentId: DEPT_EMPTY },
      );
      assert.deepEqual(eEmpty.assignees, [null], "E: unconfigured role → unassigned");
      assert.ok(
        eEmpty.warnings.some(
          (w) =>
            w.includes("not supported for this department") ||
            w.includes('role "checker" has no configured person'),
        ),
        `E: warning explains the unavailable role (got ${JSON.stringify(eEmpty.warnings)})`,
      );
      console.log("  ✓ E: resolveChecklistStepAssignees — shared rules incl. no-client company dept");

      // ── (F) neutral snapshot + identity contract ──────────────────────────
      const companySnapshot = await resolveUniversalAssignment({
        departmentId: DEPT_CO,
        clientId: CLIENT_ID,
        workspaceId: "workspace-1",
      });
      assert.ok(companySnapshot, "F: company snapshot exists");
      assert.equal(companySnapshot.clientId, null, "F: company scope is not keyed by client");
      assert.equal(companySnapshot.departmentId, DEPT_CO, "F: stable department id exposed");
      assert.equal(companySnapshot.roles.checker.source, "company", "F: neutral company source");
      assert.equal(companySnapshot.roles.checker.eligibility, "eligible", "F: active member eligible");
      assert.equal(
        companySnapshot.roles.checker.projection.source,
        "department_member",
        "F: durable member identity is the projection source",
      );
      assert.equal(
        companySnapshot.roles.checker.projection.credentialConnected,
        false,
        "F: credential state remains separate from durable identity",
      );
      assert.equal(companySnapshot.roles.checker.projection.ready, true, "F: durable identity remains projection-ready");
      assert.ok(companySnapshot.revision.includes("company:"), "F: current assignment revision exposed");
      assert.ok(companySnapshot.freshness.computedAt, "F: freshness timestamp exposed");

      const disconnectedIdentity = await resolveClickUpIdentity(
        { userId: CHECKER_ID, departmentId: DEPT_CO },
        "workspace-1",
      );
      assert.equal(disconnectedIdentity.externalUserId, "91003", "F: workspace-aware identity resolves durable id");
      assert.equal(disconnectedIdentity.credentialConnected, false, "F: disconnected credential is reported");
      assert.equal(disconnectedIdentity.ready, true, "F: disconnected OAuth does not block verified projection id");

      const mismatchedWorkspaceIdentity = await resolveClickUpIdentity(
        { userId: CHECKER_ID, departmentId: DEPT_CO },
        "other-workspace",
      );
      assert.equal(
        mismatchedWorkspaceIdentity.workspaceVerification,
        "mismatch",
        "F: durable member identity is scoped to the configured workspace",
      );
      assert.equal(
        mismatchedWorkspaceIdentity.ready,
        false,
        "F: durable identity is not projection-ready for another workspace",
      );

      const unverifiedProvidedIdentity = await resolveClickUpIdentity(
        { userId: CHECKER_ID, preferredClickUpUserId: "91999" },
        "workspace-1",
      );
      assert.equal(
        unverifiedProvidedIdentity.workspaceVerification,
        "unverified",
        "F: a caller-provided ID is not implicitly workspace-verified",
      );
      assert.equal(
        unverifiedProvidedIdentity.ready,
        false,
        "F: an unverified caller-provided ID cannot be projected",
      );

      await db.execute(sql`
        UPDATE clickup_user_tokens
        SET workspace_id = 'workspace-1', authorized_workspaces = NULL
        WHERE user_id = ${DOER_ID}
      `);
      const selectedButUnauthorizedWorkspace = await resolveClickUpIdentity(
        { userId: DOER_ID },
        "workspace-1",
      );
      assert.equal(
        selectedButUnauthorizedWorkspace.workspaceVerification,
        "unverified",
        "F: selected workspace_id alone is not authorization evidence",
      );
      assert.equal(
        selectedButUnauthorizedWorkspace.ready,
        false,
        "F: connected OAuth cannot project without authorizedWorkspaces evidence",
      );

      const nullDepartmentTicketIdentity = await resolveClickUpIdentity(
        {
          userId: CHECKER_ID,
          requireActiveDepartmentMembership: false,
          allowDurableMemberFallback: false,
        },
        "workspace-1",
      );
      assert.equal(
        nullDepartmentTicketIdentity.externalUserId,
        null,
        "F: a null-department ticket cannot borrow a durable ID from another department",
      );
      assert.equal(
        nullDepartmentTicketIdentity.ready,
        false,
        "F: null-department ticket projection requires authorized connected OAuth",
      );

      await db.execute(sql`
        INSERT INTO sd_department_members
          (id, department_id, user_id, clickup_user_id, active)
        VALUES
          (${`m-pc-checker-ambiguous-${RUN}`}, ${DEPT_PC}, ${CHECKER_ID}, '92003', true)
      `);
      const ambiguousDurableIdentity = await resolveClickUpIdentity(
        { userId: CHECKER_ID },
        "workspace-1",
      );
      assert.equal(
        ambiguousDurableIdentity.externalUserId,
        null,
        "F: department-less lookup never guesses between conflicting durable IDs",
      );
      assert.equal(
        ambiguousDurableIdentity.ready,
        false,
        "F: conflicting cross-department durable IDs are not projection-ready",
      );

      await db.execute(sql`
        UPDATE sd_department_members
        SET active = false, updated_at = NOW()
        WHERE department_id = ${DEPT_PC} AND user_id = ${DOER_ID}
      `);
      const staleSnapshot = await resolveUniversalAssignment({
        departmentId: DEPT_PC,
        clientId: CLIENT_ID,
      });
      assert.ok(staleSnapshot, "F: stale assignment snapshot exists");
      assert.equal(staleSnapshot.roles.doer.userId, DOER_ID, "F: explicit stale override still blocks default");
      assert.equal(staleSnapshot.roles.doer.source, "client_override", "F: source remains explicit override");
      assert.equal(staleSnapshot.roles.doer.eligibility, "ineligible", "F: stale member is ineligible");
      assert.equal(staleSnapshot.roles.doer.stale, true, "F: stale member is flagged");
      assert.equal(staleSnapshot.roles.doer.projection.ready, false, "F: stale member cannot be projected");
      console.log("  ✓ F: neutral snapshot exposes source/revision/eligibility and durable disconnected identity");
    },
    { tables: [...TABLES], pinGetDbForCrossAsync: true },
  );

  console.log("sd-role-resolution: all sections passed (Task #4171).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("sd-role-resolution: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
