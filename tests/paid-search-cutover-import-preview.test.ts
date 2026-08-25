/* test-registration
{
  "name": "Paid Search role cutover — preview stable-binding-first matching + flags, exact-only resumable Doer/Checker import with CAS conflict protection and gate-blocked zero egress, and overlay resolver compare/universal/default fallback (Tasks #5157/#5234)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Tasks #5157/#5234: buildPreview must match parent→client by stable target binding FIRST (never first-of-many; ambiguous binding & duplicate name are flagged) then unique exact name, and flag multi-person/blank/unmapped/conflict/excluded. runPaidSearchRoleImport must import ONLY exact eligible Doer/Checker rows, reject stale Doer/Checker snapshots, never overwrite a conflicting explicit supported role, leave transient write failures RETRYABLE (non-terminal) so a repeat press advances, skip terminal rows, and create ZERO projection commands / ClickUp egress even when production projection is fully approved and enabled. resolveRoleOverlay must compare vs universal effective roles and fall back to legacy on unmatched/duplicate. Isolated Postgres schema (getDb pinned cross-async), fetch stubbed by path shape, injected vendor deps: no network.",
  "extraEnv": {
    "NODE_ENV": "test",
    "CLICKUP_API_TOKEN": "pk_fake_cutover_import",
    "CLICKUP_ROLE_PROJECTION_ENVIRONMENT": "production"
  },
  "tier": "small",
  "tierReason": "One isolated-schema run with getDb pinned for the worker's cross-async immediate attempt; fetch + vendor deps stubbed in-process; no external network, browser, child process, or long-lived timers."
}
test-registration */

import "./helpers/forceTestEnv";

import { strict as assert } from "node:assert";
import { and, eq } from "drizzle-orm";
import { runInIsolatedSchema } from "./db-sandbox";
import { getDb } from "../server/db";
import {
  sdDepartments,
  sdDepartmentMembers,
  sdClientDeptAssignments,
  cuRoleProjectionDestinations,
  cuRoleProjectionClientTargets,
} from "@shared/schema";
import { clients } from "@shared/models/clients";
import { users } from "@shared/models/auth";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";
import {
  psRoleImportAudit,
  psRoleImportAttempts,
} from "@shared/models/paidSearchRoleImport";
import { PAID_SEARCH_DEPARTMENT_ID } from "@shared/departmentRoleCapabilities";

// Canonical config defaults.
const CANONICAL_LIST_ID = "901417549202";
const F_CID = "a886aa6f-c7f8-41cc-940b-8afef551bf49";
const F_DOER = "21335dc5-98ba-470c-b8a9-944e3cfed343";
const F_CHECKER = "0bfb4a38-47e4-4343-bb83-051a9fd40122";

// ---------------------------------------------------------------------------
// ClickUp evidence fixture — mutable so tests can reshape the canonical list.
// ---------------------------------------------------------------------------
const peopleField = (id: string, persons: any[]) => ({ id, name: id, type: "users", value: persons });
const person = (uid: string) => ({ id: uid, username: `u${uid}`, email: `u${uid}@x.com` });

// ClickUp user IDs are digit-only (validated by the projection chain). Map the
// friendly member handles used in assertions to canonical digit IDs.
const CU_ALICE = "1000001";
const CU_BOB = "1000002";
const CU_CAROL = "1000003";

let CLICKUP_TASKS: any = { last_page: true, tasks: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : input?.url ?? input);
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* non-absolute → realFetch */
  }
  if (isClickUpListFieldPath(pathname)) {
    return jsonResponse(EMPTY_CLICKUP_PRACTICE_AREA_FIELDS);
  }
  if (/^\/api\/v2\/list\/[^/]+\/task$/.test(pathname)) {
    return jsonResponse(CLICKUP_TASKS);
  }
  return realFetch(input, init);
}) as typeof fetch;

// Modules under test — imported AFTER env + fetch stub.
const cutover = await import("../server/services/adsOs/paidSearchRoleCutover");
const tok = await import("../server/services/clickUpCompanyToken");
const dir = await import("../server/services/adsOs/clickUpDirectory");
const worker = await import("../server/services/clickUpRoleProjectionWorker");
const assignmentBoundary = await import("../server/services/assignmentBoundary");

// Env-only token (no settings/DB read); noop alert hooks.
tok.__setClickUpCompanyTokenStoreForTest({
  async get() {
    return undefined;
  },
  async set() {},
  async del() {},
  async recordAudit() {},
});
tok.invalidateClickUpCompanyTokenCache();
dir.__setDirectoryAlertHooksForTest({ onSuccess: async () => {}, onFailure: async () => {} });

// Vendor-call counter for the projection worker. If any ClickUp write escapes
// the fresh cutover gate, applyCalls increments — the "zero egress" tripwire.
// loadCurrentConfig mirrors the production default (DB read, no network) so the
// command reaches the cutover gate; only the vendor I/O deps are counted.
let applyCalls = 0;
let readBackCalls = 0;
async function loadCurrentConfigForTest(cmd: any): Promise<any> {
  const db = getDb();
  const [dest] = await db
    .select()
    .from(cuRoleProjectionDestinations)
    .where(eq(cuRoleProjectionDestinations.id, cmd.destinationId))
    .limit(1);
  let clientTarget: any = null;
  if (dest && dest.targetKind !== "direct_task") {
    const [ct] = await db
      .select()
      .from(cuRoleProjectionClientTargets)
      .where(
        and(
          eq(cuRoleProjectionClientTargets.clientId, cmd.clientId),
          eq(cuRoleProjectionClientTargets.destinationId, cmd.destinationId),
        ),
      )
      .limit(1);
    clientTarget = ct ? { targetId: ct.targetId, resolvedListId: ct.resolvedListId ?? null } : null;
  }
  return {
    destination: dest
      ? {
          id: dest.id,
          environment: dest.environment,
          enabled: dest.enabled,
          targetKind: dest.targetKind,
          listId: dest.listId ?? null,
          targetId: dest.targetId ?? null,
          peopleFieldId: dest.peopleFieldId,
          maxPeople: dest.maxPeople ?? 1,
          sandboxExitApprovedAt: dest.sandboxExitApprovedAt ?? null,
          ownerApprovedAt: dest.ownerApprovedAt ?? null,
          departmentId: dest.departmentId ?? null,
          responsibility: dest.responsibility ?? null,
        }
      : null,
    clientTarget,
  };
}
function installCountingWorkerDeps(): void {
  worker.__test_setProjectionWorkerDeps({
    isKillSwitchActive: async () => false,
    loadCurrentConfig: loadCurrentConfigForTest,
    async applyProjectionDelta() {
      applyCalls++;
      return { ok: true, currentIds: [], mutated: true } as any;
    },
    async readBackProjectionField() {
      readBackCalls++;
      return { ok: true, matchesDesired: true, currentIds: [] } as any;
    },
    retryDelayMs: () => 1000,
  } as any);
}

const PAID_SEARCH_DEPT_NAME = cutover.PAID_SEARCH_DEPT_NAME;

const TABLES = [
  "system_settings",
  "sd_departments",
  "sd_department_members",
  "sd_client_dept_assignments",
  "cu_role_projection_destinations",
  "cu_role_projection_client_targets",
  "cu_role_projection_commands",
  "clients",
  "users",
  "ps_role_import_audit",
  "ps_role_import_attempts",
  "work_queue",
] as const;

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// ── Seed helpers. ───────────────────────────────────────────────────────────
async function seedUser(id: string, first: string): Promise<void> {
  await getDb().insert(users).values({ id, firstName: first, lastName: "T", email: `${id}@x.com` });
}
async function seedClient(id: string, firmName: string): Promise<void> {
  await getDb()
    .insert(clients)
    .values({ id, firmName, isArchived: false, isDemo: false, lifecycleStage: "customer" as any });
}
async function seedDepartment(): Promise<string> {
  const [d] = await getDb()
    .insert(sdDepartments)
    .values({
      id: PAID_SEARCH_DEPARTMENT_ID,
      name: PAID_SEARCH_DEPT_NAME,
      active: true,
      assignmentScope: "per_client",
    })
    .returning();
  return d.id;
}
async function seedMember(deptId: string, userId: string, clickupUserId: string | null, active = true): Promise<void> {
  await getDb().insert(sdDepartmentMembers).values({ departmentId: deptId, userId, clickupUserId, active });
}
async function seedProdDest(deptId: string, responsibility: "doer" | "checker", fieldId: string): Promise<string> {
  const [d] = await getDb()
    .insert(cuRoleProjectionDestinations)
    .values({
      workspaceId: "ws-1",
      departmentId: deptId,
      responsibility,
      targetKind: "client_list_parent",
      listId: CANONICAL_LIST_ID,
      peopleFieldId: fieldId,
      maxPeople: 1,
      environment: "production",
      enabled: true,
      sandboxExitApprovedAt: new Date(),
      sandboxExitApprovedBy: "ceo",
      ownerApprovedAt: new Date(),
      ownerApprovedBy: "ceo",
    })
    .returning();
  return d.id;
}

async function enableCutoverWritesFor(deptId: string): Promise<void> {
  await cutover.putCutoverState({ action: "approveRead" }, "ceo");
  await cutover.putCutoverState({ action: "approveProjectionWrite" }, "ceo");
  const r = await cutover.putCutoverState(
    { action: "setProjectionWritesEnabled", projectionWritesEnabled: true },
    "ceo",
  );
  assert.equal(r.ok, true, "precondition: cutover writes enabled");
  assert.equal(r.ok && r.state.approvedDepartmentId, deptId);
}

async function main(): Promise<void> {
  console.log("\n=== Paid Search cutover — preview + import + overlay (isolated schema) ===\n");

  await runInIsolatedSchema(
    async () => {
      const deptId = await seedDepartment();

      // Members: alice, bob, and carol. Each maps to a
      // distinct digit-only ClickUp user ID (the projection chain validates
      // digit-only IDs).
      await seedUser("alice", "Alice");
      await seedUser("bob", "Bob");
      await seedUser("carol", "Carol");
      await seedMember(deptId, "alice", CU_ALICE);
      await seedMember(deptId, "bob", CU_BOB);
      await seedMember(deptId, "carol", CU_CAROL);

      // Clients — exact-name matched; one duplicated name to force ambiguity.
      await seedClient("cl-acme", "Acme Law");
      await seedClient("cl-solo", "Solo Firm");
      await seedClient("cl-dupA", "Twin Firm");
      await seedClient("cl-dupB", "Twin Firm"); // duplicate normalized name

      // -------------------------------------------------------------------
      console.log("phase 1: buildPreview — matching + flags");
      CLICKUP_TASKS = {
        last_page: true,
        tasks: [
          // Acme: clean, doer=alice, checker=bob, GAds subtask → eligible.
          {
            id: "t-acme",
            name: "Acme Law",
            status: { status: "active" },
            custom_fields: [
              peopleField(F_DOER, [person(CU_ALICE)]),
              peopleField(F_CHECKER, [person(CU_BOB)]),
            ],
          },
          // Solo: doer has TWO people (multi-person) → flagged, ineligible.
          {
            id: "t-solo",
            name: "Solo Firm",
            status: { status: "active" },
            custom_fields: [peopleField(F_DOER, [person(CU_ALICE), person(CU_BOB)])],
          },
          // Twin: NoBull has two "Twin Firm" clients → duplicate_client_name.
          {
            id: "t-twin",
            name: "Twin Firm",
            status: { status: "active" },
            custom_fields: [peopleField(F_DOER, [person(CU_ALICE)])],
          },
          // Ghost: no NoBull client → unmapped_client.
          {
            id: "t-ghost",
            name: "Ghost Co",
            status: { status: "active" },
            custom_fields: [peopleField(F_DOER, [person(CU_ALICE)])],
          },
        ],
      };

      const preview = await cutover.buildPreview();
      ok(preview.ok && preview.departmentId === deptId, "preview built against the unique department");
      const byTask = new Map(preview.rows.map((r) => [r.clickupTaskId, r]));

      const acme = byTask.get("t-acme")!;
      ok(acme.matchedClientId === "cl-acme" && acme.matchedVia === "name", "clean parent matched by unique exact name");
      ok(acme.doerMapped && acme.checkerMapped && acme.eligible, "clean parent with mapped doer+checker is eligible");

      const solo = byTask.get("t-solo")!;
      ok(solo.doerMultiPerson && solo.flags.some((f) => f.code === "doer_multi_person"), "multi-person doer flagged");
      ok(!solo.eligible, "multi-person parent is ineligible");

      const twin = byTask.get("t-twin")!;
      ok(
        twin.duplicateClientName && twin.flags.some((f) => f.code === "duplicate_client_name") && !twin.eligible,
        "duplicate NoBull client name flagged and ineligible",
      );

      const ghost = byTask.get("t-ghost")!;
      ok(
        ghost.matchedClientId === null && ghost.flags.some((f) => f.code === "unmapped_client") && !ghost.eligible,
        "unmapped parent flagged and ineligible",
      );

      // -------------------------------------------------------------------
      console.log("phase 2: buildPreview — stable target binding beats name; ambiguous binding flagged");
      {
        const doerDestId = await seedProdDest(deptId, "doer", F_DOER);
        const checkerDestId = await seedProdDest(deptId, "checker", F_CHECKER);

        // Bind t-acme's stable task id to a DIFFERENT client than its name match,
        // to prove binding is preferred over name.
        await getDb().insert(cuRoleProjectionClientTargets).values({
          clientId: "cl-solo",
          destinationId: doerDestId,
          targetId: "t-acme",
        });
        // Bind t-twin to TWO distinct clients across dests → ambiguous binding.
        await getDb().insert(cuRoleProjectionClientTargets).values({
          clientId: "cl-dupA",
          destinationId: doerDestId,
          targetId: "t-twin",
        });
        await getDb().insert(cuRoleProjectionClientTargets).values({
          clientId: "cl-dupB",
          destinationId: checkerDestId,
          targetId: "t-twin",
        });

        const p2 = await cutover.buildPreview();
        const b = new Map(p2.rows.map((r) => [r.clickupTaskId, r]));
        const acme2 = b.get("t-acme")!;
        ok(
          acme2.matchedVia === "binding" && acme2.matchedClientId === "cl-solo",
          "stable binding wins over exact-name match",
        );
        const twin2 = b.get("t-twin")!;
        ok(
          twin2.flags.some((f) => f.code === "ambiguous_target_binding") && !twin2.eligible,
          "binding to >1 distinct client is ambiguous (never first-of-many) and ineligible",
        );

        // Clean up bindings + dests so later phases start from a known state.
        await getDb().delete(cuRoleProjectionClientTargets);
        await getDb().delete(cuRoleProjectionDestinations);
      }

      // -------------------------------------------------------------------
      console.log("phase 3: resolveRoleOverlay — legacy / compare / universal / fallback");
      {
        // Give Acme a NoBull assignment so universal has something to surface.
        await getDb().insert(sdClientDeptAssignments).values({
          clientId: "cl-acme",
          departmentId: deptId,
          primaryUserId: "alice",
          checkerUserId: "bob",
        });

        const inputRows = [
          { clickupClientName: "Acme Law", legacyDoer: "cu-old-doer", legacyChecker: "cu-old-checker" },
          { clickupClientName: "Ghost Co", legacyDoer: "cu-ghost", legacyChecker: null }, // unmatched
        ];

        // legacy fast-path.
        await cutover.putCutoverState({ action: "setMode", mode: "legacy" }, "ceo");
        const legacy = await cutover.resolveRoleOverlay(inputRows);
        ok(
          legacy.mode === "legacy" && legacy.rows[0].displayDoer === "cu-old-doer",
          "legacy mode returns ClickUp values verbatim",
        );

        // compare mode: display ClickUp values, record mismatches vs NoBull.
        await cutover.putCutoverState({ action: "approveRead" }, "ceo");
        await cutover.putCutoverState({ action: "setMode", mode: "compare" }, "ceo");
        const compare = await cutover.resolveRoleOverlay(inputRows);
        const cAcme = compare.rows.find((r) => r.clickupClientName === "Acme Law")!;
        ok(cAcme.displayDoer === "cu-old-doer", "compare mode still displays ClickUp values");
        ok(
          cAcme.mismatches.some((m) => m.field === "doer" && m.universalValue === "Alice T"),
          "compare mode records doer mismatch with NoBull effective display name",
        );

        // universal mode: matched → NoBull effective; unmatched → null + rowMode legacy.
        await cutover.putCutoverState({ action: "setMode", mode: "universal" }, "ceo");
        const universal = await cutover.resolveRoleOverlay(inputRows);
        const uAcme = universal.rows.find((r) => r.clickupClientName === "Acme Law")!;
        ok(
          uAcme.mode === "universal" && uAcme.displayDoer === "Alice T" && uAcme.displayChecker === "Bob T",
          "universal mode surfaces NoBull effective doer/checker for a matched client",
        );
        const uGhost = universal.rows.find((r) => r.clickupClientName === "Ghost Co")!;
        ok(
          uGhost.mode === "legacy" && uGhost.displayDoer === null && uGhost.displayChecker === null,
          "universal mode: unmatched client yields null roles reported as rowMode legacy (never leaks legacy values)",
        );

        // Reset to legacy for the import phase.
        await cutover.putCutoverState({ action: "revokeRead" }, "ceo");
      }

      // -------------------------------------------------------------------
      console.log("phase 4: runPaidSearchRoleImport — exact-only Doer/Checker, conflict, zero egress");
      // Configure and fully enable production projection. The import must still
      // create no commands and make no vendor calls because it uses the
      // structural NoBull-only assignment mutation.
      const doerDestId = await seedProdDest(deptId, "doer", F_DOER);
      const checkerDestId = await seedProdDest(deptId, "checker", F_CHECKER);
      // Bind acme so the immediate projection attempt has a client target.
      await getDb().insert(cuRoleProjectionClientTargets).values(
        [
          { clientId: "cl-acme", destinationId: doerDestId, targetId: "t-acme", resolvedListId: CANONICAL_LIST_ID },
          { clientId: "cl-acme", destinationId: checkerDestId, targetId: "t-acme", resolvedListId: CANONICAL_LIST_ID },
        ],
      );

      // Pre-existing conflicting checker on a SECOND client to prove conflict
      // protection.
      await seedClient("cl-keep", "Keep Firm");
      await getDb().insert(sdClientDeptAssignments).values({
        clientId: "cl-keep",
        departmentId: deptId,
        primaryUserId: null,
        checkerUserId: "carol", // existing checker differs from ClickUp's bob
      });

      // Acme already has alice/bob from phase 3 → both roles "unchanged".
      // Keep Firm: ClickUp doer=alice (import), checker=bob (conflict with carol).
      CLICKUP_TASKS = {
        last_page: true,
        tasks: [
          {
            id: "t-acme",
            name: "Acme Law",
            status: { status: "active" },
            custom_fields: [
              peopleField(F_DOER, [person(CU_ALICE)]),
              peopleField(F_CHECKER, [person(CU_BOB)]),
            ],
          },
          {
            id: "t-keep",
            name: "Keep Firm",
            status: { status: "active" },
            custom_fields: [
              peopleField(F_DOER, [person(CU_ALICE)]),
              peopleField(F_CHECKER, [person(CU_BOB)]),
            ],
          },
        ],
      };

      // Enable every approval and production write flag. This is the strongest
      // no-egress proof: import safety cannot depend on the flag being off.
      await enableCutoverWritesFor(deptId);

      applyCalls = 0;
      readBackCalls = 0;
      installCountingWorkerDeps();
      let importResult: Awaited<ReturnType<typeof cutover.runPaidSearchRoleImport>>;
      try {
        importResult = await cutover.runPaidSearchRoleImport("ceo");
      } finally {
        worker.__test_setProjectionWorkerDeps(null);
      }

      ok(importResult.ok, "import completes");
      const commandCount = await getDb().execute(
        (await import("drizzle-orm")).sql`SELECT COUNT(*)::int AS n FROM cu_role_projection_commands`,
      );
      ok(
        Number((commandCount.rows as any[])[0]?.n ?? -1) === 0,
        "import stages ZERO projection commands even with production writes fully enabled",
      );
      ok(
        applyCalls === 0 && readBackCalls === 0,
        "import makes ZERO ClickUp apply/read-back calls even with production writes fully enabled",
      );

      // Keep Firm doer imported (alice), checker conflict (carol preserved).
      const keepAssign = await getDb()
        .select()
        .from(sdClientDeptAssignments)
        .where(and(eq(sdClientDeptAssignments.clientId, "cl-keep"), eq(sdClientDeptAssignments.departmentId, deptId)));
      ok(keepAssign[0].primaryUserId === "alice", "eligible doer imported to the NoBull assignment");
      ok(keepAssign[0].checkerUserId === "carol", "conflicting existing checker is NOT overwritten");
      ok(importResult.conflict >= 1, "conflict disposition recorded for the differing checker");
      ok(importResult.imported >= 1 && importResult.unchanged >= 1, "imported + unchanged dispositions recorded");

      // -------------------------------------------------------------------
      console.log("phase 5: import is resumable — terminal rows skipped on a repeat press");
      {
        const second = await cutover.runPaidSearchRoleImport("ceo");
        ok(
          second.ok && second.imported === 0 && second.skippedTerminal > 0,
          "repeat press skips already-terminal rows and imports nothing new",
        );
      }

      // -------------------------------------------------------------------
      console.log("phase 6: imported assignment + evidence commit atomically");
      {
        // A brand-new eligible parent+client whose FIRST import attempt fails
        // while persisting the imported audit row. The assignment and audit are
        // one transaction, so the assignment must roll back rather than commit
        // without evidence. A later press can then recover the original source
        // identity + actor as an imported attempt.
        await seedClient("cl-retry", "Retry Firm");
        CLICKUP_TASKS = {
          last_page: true,
          tasks: [
            {
              id: "t-retry",
              name: "Retry Firm",
              status: { status: "active" },
              // Both roles present so the forced write fault throws for BOTH
              // slots.
              custom_fields: [
                peopleField(F_DOER, [person(CU_ALICE)]),
                peopleField(F_CHECKER, [person(CU_BOB)]),
              ],
            },
          ],
        };

        const db = getDb();
        const failed = await cutover.runPaidSearchRoleImport("ceo", {
          beforeAuditWriteInTransaction: async (rows) => {
            if (rows.some((row) => row.disposition === "imported")) {
              throw new Error("injected imported-audit persistence failure");
            }
          },
        });
        ok(
          failed.ok && failed.retryable >= 1,
          "imported-audit persistence failure counts as retryable",
        );
        const assignmentAfterAuditFailure = await db
          .select()
          .from(sdClientDeptAssignments)
          .where(
            and(
              eq(sdClientDeptAssignments.clientId, "cl-retry"),
              eq(sdClientDeptAssignments.departmentId, deptId),
            ),
          );
        ok(
          assignmentAfterAuditFailure.length === 0,
          "assignment rolls back when its imported evidence cannot persist",
        );

        // No terminal audit row was persisted for the failed doer slot.
        const afterFail = await db
          .select()
          .from(psRoleImportAudit)
          .where(eq(psRoleImportAudit.clickupParentTaskId, "t-retry"));
        ok(afterFail.length === 0, "no terminal audit row persisted for a transient failure");
        const attemptHistoryAfterFail = await db
          .select()
          .from(psRoleImportAttempts)
          .where(eq(psRoleImportAttempts.clickupParentTaskId, "t-retry"));
        ok(
          attemptHistoryAfterFail.length >= 1 &&
            attemptHistoryAfterFail.every((row) => row.disposition === "retryable"),
          "append-only attempt history preserves transient retry evidence",
        );

        // Remove the injected fault and retry — the slot advances to imported.
        const retried = await cutover.runPaidSearchRoleImport("ceo");
        ok(retried.ok && retried.imported >= 1, "repeat press retries the previously-failed slot and imports it");
        const retryAssign = await db
          .select()
          .from(sdClientDeptAssignments)
          .where(and(eq(sdClientDeptAssignments.clientId, "cl-retry"), eq(sdClientDeptAssignments.departmentId, deptId)));
        ok(retryAssign[0]?.primaryUserId === "alice", "retried slot persisted the assignment");
        const attemptHistoryAfterRetry = await db
          .select()
          .from(psRoleImportAttempts)
          .where(eq(psRoleImportAttempts.clickupParentTaskId, "t-retry"));
        ok(
          attemptHistoryAfterRetry.length > attemptHistoryAfterFail.length &&
            attemptHistoryAfterRetry.some((row) => row.disposition === "retryable") &&
            attemptHistoryAfterRetry.some((row) => row.disposition === "imported"),
          "successful retry appends evidence without erasing the prior failure",
        );
        ok(
          attemptHistoryAfterRetry.some(
            (row) =>
              row.disposition === "imported" &&
              row.clickupUserIdCurrent === CU_ALICE &&
              row.nobullUserId === "alice" &&
              row.attemptedBy === "ceo",
          ),
          "recovered imported evidence retains original ClickUp ID, NoBull identity, and actor",
        );
      }

      // -------------------------------------------------------------------
      console.log("phase 7: CAS rejects stale Doer/Checker");
      {
        const [beforeConcurrentMutation] = await getDb()
          .select({
            primaryUserId: sdClientDeptAssignments.primaryUserId,
            checkerUserId: sdClientDeptAssignments.checkerUserId,
          })
          .from(sdClientDeptAssignments)
          .where(
            and(
              eq(sdClientDeptAssignments.clientId, "cl-retry"),
              eq(sdClientDeptAssignments.departmentId, deptId),
            ),
          );
        await getDb()
          .update(sdClientDeptAssignments)
          .set({ checkerUserId: "carol" })
          .where(
            and(
              eq(sdClientDeptAssignments.clientId, "cl-retry"),
              eq(sdClientDeptAssignments.departmentId, deptId),
            ),
          );
        const staleMutation =
          await assignmentBoundary.setClientDepartmentAssignmentNoProjection({
            clientId: "cl-retry",
            departmentId: deptId,
            primaryUserId: "bob",
            checkerUserId: "bob",
            expectedAssignment: beforeConcurrentMutation,
          });
        ok(
          !staleMutation.ok && staleMutation.kind === "concurrent_conflict",
          "compare-and-set guard rejects a stale Doer/Checker snapshot",
        );
        const [preserved] = await getDb()
          .select()
          .from(sdClientDeptAssignments)
          .where(
            and(
              eq(sdClientDeptAssignments.clientId, "cl-retry"),
              eq(sdClientDeptAssignments.departmentId, deptId),
            ),
          );
        ok(
          preserved.primaryUserId === "alice" && preserved.checkerUserId === "carol",
          "stale import mutation leaves newer Doer/Checker state untouched",
        );
      }
    },
    { tables: [...TABLES], pinGetDbForCrossAsync: true },
  );

  console.log(`\npaid-search-cutover-import-preview: ${passed} assertions passed\n`);
}

main().catch((err) => {
  console.error("Unexpected error in import/preview test:", err);
  process.exit(1);
});
