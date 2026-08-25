/* test-registration
{
  "name": "Paid Search role cutover — state approval/revocation rules, production-destination write-enable validation, department detection, and fresh fail-closed projection gate (Task #5157)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5157: the cutover's write-enable path is the blast radius. getCutoverState/putCutoverState must fail closed (universal needs read approval; writes need read+write approval AND enabled/owner-approved canonical production destinations for BOTH doer & checker); findPaidSearchDepartment must fail closed on missing/duplicate; and the worker's evaluatePaidSearchProjectionGate must read FRESH and deny a governed destination unless authorized and department-scoped. Isolated Postgres schema, no network.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small",
  "tierReason": "One isolated-schema run exercising storage-backed cutover state + gate reads; no external network, browser, child process, or long-lived timers."
}
test-registration */

import "./helpers/forceTestEnv";

import { strict as assert } from "node:assert";
import { and, eq } from "drizzle-orm";
import { runInIsolatedSchema } from "./db-sandbox";
import { getDb } from "../server/db";
import { sdDepartments, cuRoleProjectionDestinations } from "@shared/schema";
import {
  getCutoverState,
  putCutoverState,
  findPaidSearchDepartment,
  PAID_SEARCH_DEPT_NAME,
} from "../server/services/adsOs/paidSearchRoleCutover";
import {
  readCutoverProjectionAuthorizationFresh,
  evaluatePaidSearchProjectionGate,
} from "../server/services/adsOs/paidSearchCutoverGate";

// Canonical field IDs (config defaults) — must match to pass validation.
const F_DOER = "21335dc5-98ba-470c-b8a9-944e3cfed343";
const F_CHECKER = "0bfb4a38-47e4-4343-bb83-051a9fd40122";
const CANONICAL_LIST_ID = "901417549202";

const TABLES = [
  "system_settings",
  "sd_departments",
  "cu_role_projection_destinations",
] as const;

const ACTOR = "user-ceo";

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

async function seedDepartment(): Promise<string> {
  const db = getDb();
  const [dept] = await db
    .insert(sdDepartments)
    .values({ name: PAID_SEARCH_DEPT_NAME, active: true, assignmentScope: "per_client" })
    .returning();
  return dept.id;
}

async function insertProdDest(args: {
  departmentId: string;
  responsibility: "doer" | "checker";
  peopleFieldId: string;
  enabled: boolean;
  ownerApproved: boolean;
}): Promise<void> {
  const db = getDb();
  await db.insert(cuRoleProjectionDestinations).values({
    workspaceId: "ws-1",
    departmentId: args.departmentId,
    responsibility: args.responsibility,
    targetKind: "client_list_parent",
    listId: CANONICAL_LIST_ID,
    peopleFieldId: args.peopleFieldId,
    maxPeople: 1,
    environment: "production",
    enabled: args.enabled,
    sandboxExitApprovedAt: new Date(),
    sandboxExitApprovedBy: ACTOR,
    ownerApprovedAt: args.ownerApproved ? new Date() : null,
    ownerApprovedBy: args.ownerApproved ? ACTOR : null,
  });
}

async function main(): Promise<void> {
  console.log("\n=== Paid Search cutover — state + gate (isolated schema) ===\n");

  await runInIsolatedSchema(
    async () => {
      // -------------------------------------------------------------------
      console.log("phase 1: default state + department detection fail-closed");
      {
        const state = await getCutoverState();
        ok(state.mode === "legacy" && !state.readApproved, "default state is legacy, no approvals");

        const missing = await findPaidSearchDepartment();
        ok(!missing.ok, "findPaidSearchDepartment fails closed when department is missing");
      }

      // -------------------------------------------------------------------
      console.log("phase 2: mode + approval rules");
      {
        const uniBlocked = await putCutoverState({ action: "setMode", mode: "universal" }, ACTOR);
        ok(!uniBlocked.ok, "universal mode blocked before read approval");

        const cmp = await putCutoverState({ action: "setMode", mode: "compare" }, ACTOR);
        ok(cmp.ok && cmp.state.mode === "compare", "compare mode allowed without read approval");

        const badMode = await putCutoverState({ action: "setMode", mode: "nope" as any }, ACTOR);
        ok(!badMode.ok, "invalid mode rejected");

        const appr = await putCutoverState({ action: "approveRead" }, ACTOR);
        ok(appr.ok && appr.state.readApproved && appr.state.readApprovedBy === ACTOR, "read approval stamps actor");

        const uni = await putCutoverState({ action: "setMode", mode: "universal" }, ACTOR);
        ok(uni.ok && uni.state.mode === "universal", "universal mode allowed AFTER read approval");
      }

      // -------------------------------------------------------------------
      console.log("phase 3: projection-write enable requires approvals + valid destinations");
      const deptId = await seedDepartment();
      {
        // Runtime policy is scoped by the live Paid Search department identity,
        // not by a previously persisted approval. Legacy/drifted destinations
        // must fail closed even before the first write approval.
        const preApprovalWrongList = await evaluatePaidSearchProjectionGate({
          listId: "legacy-wrong-list",
          peopleFieldId: F_DOER,
          environment: "production",
          departmentId: deptId,
          responsibility: "doer",
        });
        ok(
          !preApprovalWrongList.allowed,
          "gate denies a Paid Search wrong-list destination before department approval exists",
        );
        const preApprovalWrongField = await evaluatePaidSearchProjectionGate({
          listId: CANONICAL_LIST_ID,
          peopleFieldId: "legacy-wrong-field",
          environment: "production",
          departmentId: deptId,
          responsibility: "checker",
        });
        ok(
          !preApprovalWrongField.allowed,
          "gate denies a Paid Search wrong-field destination before department approval exists",
        );
        const preApprovalUnsupportedRole = await evaluatePaidSearchProjectionGate({
          listId: CANONICAL_LIST_ID,
          peopleFieldId: F_DOER,
          environment: "production",
          departmentId: deptId,
          responsibility: "legacy-unsupported",
        });
        ok(
          !preApprovalUnsupportedRole.allowed,
          "gate denies an unsupported Paid Search destination before department approval exists",
        );

        // Read is approved (phase 2). Write approval is not yet given.
        const noWriteApproval = await putCutoverState(
          { action: "setProjectionWritesEnabled", projectionWritesEnabled: true },
          ACTOR,
        );
        ok(!noWriteApproval.ok, "enable writes blocked without projection-write approval");

        const wa = await putCutoverState({ action: "approveProjectionWrite" }, ACTOR);
        ok(wa.ok && wa.state.projectionWriteApproved, "projection-write approval granted");

        // Approvals present, but NO destinations yet → fail closed.
        const noDests = await putCutoverState(
          { action: "setProjectionWritesEnabled", projectionWritesEnabled: true },
          ACTOR,
        );
        ok(!noDests.ok, "enable writes blocked when canonical production destinations are absent");

        // Only doer present → still blocked (needs both).
        await insertProdDest({ departmentId: deptId, responsibility: "doer", peopleFieldId: F_DOER, enabled: true, ownerApproved: true });
        const onlyDoer = await putCutoverState(
          { action: "setProjectionWritesEnabled", projectionWritesEnabled: true },
          ACTOR,
        );
        ok(!onlyDoer.ok, "enable writes blocked when only Doer destination exists");

        // Add checker with a NON-canonical field id → blocked.
        await insertProdDest({ departmentId: deptId, responsibility: "checker", peopleFieldId: "wrong-field", enabled: true, ownerApproved: true });
        const wrongField = await putCutoverState(
          { action: "setProjectionWritesEnabled", projectionWritesEnabled: true },
          ACTOR,
        );
        ok(!wrongField.ok, "enable writes blocked when a destination uses a non-canonical People field");

        // Fix checker field but drift the owning list → blocked.
        await getDb()
          .update(cuRoleProjectionDestinations)
          .set({
            peopleFieldId: F_CHECKER,
            listId: "not-the-canonical-production-list",
            ownerApprovedAt: new Date(),
            ownerApprovedBy: ACTOR,
          })
          .where(eqResp(deptId, "checker"));
        const wrongList = await putCutoverState(
          { action: "setProjectionWritesEnabled", projectionWritesEnabled: true },
          ACTOR,
        );
        ok(!wrongList.ok, "enable writes blocked when a destination uses a non-canonical list");

        // Restore the list but leave it NOT owner-approved → blocked.
        await getDb()
          .update(cuRoleProjectionDestinations)
          .set({
            listId: CANONICAL_LIST_ID,
            ownerApprovedAt: null,
            ownerApprovedBy: null,
          })
          .where(eqResp(deptId, "checker"));
        const notApproved = await putCutoverState(
          { action: "setProjectionWritesEnabled", projectionWritesEnabled: true },
          ACTOR,
        );
        ok(!notApproved.ok, "enable writes blocked when a destination lacks owner approval");

        // Owner-approve checker → now valid.
        await getDb()
          .update(cuRoleProjectionDestinations)
          .set({ ownerApprovedAt: new Date(), ownerApprovedBy: ACTOR })
          .where(eqResp(deptId, "checker"));
        const enabled = await putCutoverState(
          { action: "setProjectionWritesEnabled", projectionWritesEnabled: true },
          ACTOR,
        );
        ok(enabled.ok, "enable writes succeeds with both canonical, enabled, owner-approved destinations");
        ok(
          enabled.ok && enabled.state.projectionWritesEnabled && enabled.state.approvedDepartmentId === deptId,
          "enabling writes captures the exact approved department id",
        );

      }

      // -------------------------------------------------------------------
      console.log("phase 4: fresh projection authorization + gate verdicts");
      {
        const auth = await readCutoverProjectionAuthorizationFresh();
        ok(
          auth.projectionWritesAuthorized && auth.approvedDepartmentId === deptId,
          "fresh authorization reflects enabled writes + approved department",
        );

        // Governed destination in the approved department → allowed.
        const allowed = await evaluatePaidSearchProjectionGate({
          listId: CANONICAL_LIST_ID,
          peopleFieldId: F_DOER,
          environment: "production",
          departmentId: deptId,
          responsibility: "doer",
        });
        ok(allowed.allowed === true, "gate allows governed destination in approved department when authorized");

        // Governed destination in a DIFFERENT department → denied (dept scope).
        const wrongDept = await evaluatePaidSearchProjectionGate({
          listId: CANONICAL_LIST_ID,
          peopleFieldId: F_DOER,
          environment: "production",
          departmentId: "some-other-dept",
          responsibility: "doer",
        });
        ok(wrongDept.allowed === false, "gate denies governed destination scoped to a different department");

        // Non-governed (sandbox) destination → always allowed by this gate.
        const nonGoverned = await evaluatePaidSearchProjectionGate({
          listId: CANONICAL_LIST_ID,
          peopleFieldId: F_DOER,
          environment: "sandbox",
          departmentId: deptId,
          responsibility: "doer",
        });
        ok(nonGoverned.allowed === true, "gate does not restrict non-governed destinations");

        // Destination drift after approval is still governed by the preserved
        // department identity and must fail closed before any mutation.
        const drifted = await evaluatePaidSearchProjectionGate({
          listId: "drifted-list",
          peopleFieldId: "drifted-field",
          environment: "production",
          departmentId: deptId,
          responsibility: "doer",
        });
        ok(drifted.allowed === false, "gate denies list/field drift for the approved department");

        const missingDept = await evaluatePaidSearchProjectionGate({
          listId: CANONICAL_LIST_ID,
          peopleFieldId: F_DOER,
          environment: "production",
          departmentId: null,
          responsibility: "doer",
        });
        ok(missingDept.allowed === false, "gate denies a governed destination with no department id");
      }

      // -------------------------------------------------------------------
      console.log("phase 5: revocation returns to fail-closed");
      {
        const revoked = await putCutoverState({ action: "revokeRead" }, ACTOR);
        ok(
          revoked.ok &&
            revoked.state.mode === "legacy" &&
            !revoked.state.projectionWritesEnabled &&
            revoked.state.approvedDepartmentId === deptId,
          "revoking read approval forces legacy + disables writes while preserving department identity for drift governance",
        );

        const auth = await readCutoverProjectionAuthorizationFresh();
        ok(!auth.projectionWritesAuthorized, "fresh authorization is false after revocation");

        // The governed destination that was allowed a moment ago is now denied.
        const denied = await evaluatePaidSearchProjectionGate({
          listId: CANONICAL_LIST_ID,
          peopleFieldId: F_DOER,
          environment: "production",
          departmentId: deptId,
          responsibility: "doer",
        });
        ok(denied.allowed === false, "gate fails closed on the same destination after revocation (fresh read)");

        // Re-approve read + write, then revoke ONLY projection-write.
        await putCutoverState({ action: "approveRead" }, ACTOR);
        await putCutoverState({ action: "approveProjectionWrite" }, ACTOR);
        await putCutoverState(
          { action: "setProjectionWritesEnabled", projectionWritesEnabled: true },
          ACTOR,
        );
        const revW = await putCutoverState({ action: "revokeProjectionWrite" }, ACTOR);
        ok(
          revW.ok && !revW.state.projectionWritesEnabled && !revW.state.projectionWriteApproved,
          "revoking projection-write approval disables writes but leaves read approval intact",
        );
        ok(revW.ok && revW.state.readApproved, "read approval survives a projection-write revocation");
      }

      // -------------------------------------------------------------------
      console.log("phase 6: duplicate department fails closed");
      {
        await seedDepartment(); // a second row with the exact same name
        const dup = await findPaidSearchDepartment();
        ok(!dup.ok, "findPaidSearchDepartment fails closed on duplicate departments");
      }
    },
    { tables: [...TABLES] },
  );

  console.log(`\npaid-search-cutover-state-gate: ${passed} assertions passed\n`);
}

// Small helper to build the (dept, responsibility) production predicate.
function eqResp(deptId: string, responsibility: string) {
  return and(
    eq(cuRoleProjectionDestinations.departmentId, deptId),
    eq(cuRoleProjectionDestinations.responsibility, responsibility),
    eq(cuRoleProjectionDestinations.environment, "production"),
  );
}

main().catch((err) => {
  console.error("Unexpected error in state/gate test:", err);
  process.exit(1);
});
