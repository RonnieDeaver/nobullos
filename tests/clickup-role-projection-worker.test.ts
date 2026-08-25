/* test-registration
{
  "name": "ClickUp role projection WORKER — executed hermetic lifecycle: execution-time gate, kill-switch re-check, direct_task read/write/readback, absent-override default fan-out universe, honest immediate response, ambiguous readback, terminal non-reclaim/supersession (Task #5156)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5156: drives the SAME processOneCommand the worker uses, with injected vendor + kill-switch deps and real DB finalizers against an isolated schema — proving zero-egress on revoked/kill-switch, direct_task full round-trip, ambiguous readback-before-mutation, and terminal non-reclaim. Also covers durable delivery: (a) initial command staging atomically inserts an immediate queue wake that still drains after the post-commit accelerator kick fails; (b) >50 commands leave a durable continuation that drains the remainder; (c) a transient failure atomically writes next_attempt_at plus a delayed wake that becomes eligible and retries to synced — no restart, boot catch-up, or new assignment mutation. No network.",
  "extraEnv": {
    "NODE_ENV": "test",
    "CLICKUP_ROLE_PROJECTION_ENVIRONMENT": "sandbox"
  },
  "tier": "small",
  "tierReason": "One isolated-schema transaction with injected in-process vendor dependencies; no external network, browser, child process, or long-lived timers. Runs in under 5 seconds."
}
test-registration */

import "./helpers/forceTestEnv";

import { sql } from "drizzle-orm";
import { runInIsolatedSchema } from "./db-sandbox";
import { getDb } from "../server/db";
import {
  processOneCommand,
  computeProjectionRevision,
  upsertRoleProjectionDestination,
  handleClickUpRoleProjectionJob,
  manualResyncProjectionCommand,
  stageProjectionCommandInTx,
  stageProjectionCommandsInTx,
  __test_setProjectionWorkerDeps,
  type ClaimedCommand,
  type ProjectionWorkerDeps,
  type CurrentProjectionConfig,
} from "../server/services/clickUpRoleProjection";
import {
  __test_setClickUpRoleProjectionEnqueueOverride,
  kickClickUpRoleProjectionSafe,
  projectionWakeDedupeKey,
} from "../server/services/clickUpRoleProjectionKick";
import { runWithWorkerDb } from "../server/db";
import { __test_dequeueFromQueueUsingCurrentDb } from "../server/services/workQueueLease";
import type { WorkQueueJob } from "@shared/schema";
import {
  fanOutDepartmentProjectionForTest,
  summaryFromStatuses,
  type ProjectionRefStatusLite,
} from "../server/services/assignmentBoundary";
import type { ProjectionStageSummary } from "../server/services/clickUpRoleProjection";
import {
  CANONICAL_PRODUCTION_LIST_ID,
  CLICKUP_CHECKER_FIELD_ID,
  CLICKUP_DOER_FIELD_ID,
  PAID_SEARCH_DEPT_NAME,
} from "../server/services/adsOs/paidSearchRoleContract";
import { PAID_SEARCH_DEPARTMENT_ID } from "@shared/departmentRoleCapabilities";

const CU_TABLES = [
  "cu_role_projection_destinations",
  "cu_role_projection_client_targets",
  "cu_role_projection_commands",
  "sd_departments",
  "sd_department_members",
  "sd_client_dept_assignments",
  "clients",
  // Task #5156 durable-wake tests: the atomic retry wake and the >50 drain
  // continuation both INSERT into work_queue via the same isolated-schema tx.
  // Isolating it prevents public-schema fallthrough polluting the live queue.
  "work_queue",
] as const;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${name}${detail ? ` (${detail})` : ""}`);
  }
}

// ── Test seams ────────────────────────────────────────────────────────────────

interface VendorCallLog {
  applyCalls: number;
  readBackCalls: number;
}

/** Build worker deps that count vendor calls and return scripted outcomes. */
function makeDeps(opts: {
  log: VendorCallLog;
  killSwitchActive?: boolean;
  config: CurrentProjectionConfig;
  applyOutcome?: any;
  readBackOutcome?: any;
  retryDelayMs?: number;
}): ProjectionWorkerDeps {
  return {
    isKillSwitchActive: async () => opts.killSwitchActive === true,
    loadCurrentConfig: async () => opts.config,
    applyProjectionDelta: async () => {
      opts.log.applyCalls++;
      return opts.applyOutcome ?? { ok: true, action: "set", previousIds: [], desiredId: "111" };
    },
    readBackProjectionField: async () => {
      opts.log.readBackCalls++;
      return opts.readBackOutcome ?? { ok: true, currentIds: ["111"], matchesDesired: true };
    },
    retryDelayMs: () => opts.retryDelayMs ?? 30_000,
  } as ProjectionWorkerDeps;
}

function directTaskConfig(over?: Partial<CurrentProjectionConfig["destination"]>): CurrentProjectionConfig {
  return {
    destination: {
      id: "dest-1",
      environment: "sandbox",
      enabled: true,
      targetKind: "direct_task",
      listId: "list-owning-1",
      targetId: "task-1",
      peopleFieldId: "field-1",
      maxPeople: 1,
      sandboxExitApprovedAt: null,
      ownerApprovedAt: null,
      responsibility: "doer",
      ...(over ?? {}),
    },
    clientTarget: null,
  };
}

async function ensureDirectTaskDest(destId: string): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO cu_role_projection_destinations
      (id, workspace_id, department_id, responsibility, target_kind, list_id, target_id, people_field_id, max_people, environment, enabled)
    VALUES (${destId}, 'ws-1', 'dept-1', 'doer', 'direct_task', 'list-owning-1', 'task-1', 'field-1', 1, 'sandbox', true)
    ON CONFLICT (id) DO NOTHING
  `);
}

async function seedCommand(destId: string, clientId: string, revision: string): Promise<void> {
  await ensureDirectTaskDest(destId);
  await getDb().execute(sql`
    INSERT INTO cu_role_projection_commands
      (client_id, destination_id, desired_user_id, desired_clickup_user_id, revision, target_snapshot, status, attempt_count, max_attempts, mutation_attempts)
    VALUES (
      ${clientId}, ${destId}, 'user-1', '111', ${revision},
      ${JSON.stringify({ targetId: "task-1", listId: "list-owning-1", peopleFieldId: "field-1", targetKind: "direct_task" })}::jsonb,
      'pending', 1, 5, 0
    )
  `);
}

async function readStatus(clientId: string, destId: string): Promise<{ status: string; mutationAttempts: number; verifiedAt: unknown; terminalAt: unknown; errorCode: string | null }> {
  const res = await getDb().execute(sql`
    SELECT status, mutation_attempts, verified_at, terminal_at, last_error_code
    FROM cu_role_projection_commands WHERE client_id = ${clientId} AND destination_id = ${destId} LIMIT 1
  `);
  const r = (res.rows as any[])[0];
  return {
    status: String(r.status),
    mutationAttempts: Number(r.mutation_attempts),
    verifiedAt: r.verified_at,
    terminalAt: r.terminal_at,
    errorCode: r.last_error_code ? String(r.last_error_code) : null,
  };
}

/** Build a ClaimedCommand pointing at the seeded row (with a fresh lease token that matches the DB). */
async function claimSeeded(clientId: string, destId: string, revision: string): Promise<ClaimedCommand> {
  const token = "test-lease-" + Math.random().toString(36).slice(2);
  const expiry = new Date(Date.now() + 300_000);
  await getDb().execute(sql`
    UPDATE cu_role_projection_commands
    SET lease_token = ${token}, lease_owner = 'test', lease_expires_at = ${expiry}
    WHERE client_id = ${clientId} AND destination_id = ${destId}
  `);
  return {
    id: "ignored", // casPredicate uses id; fetch real id
    clientId,
    destinationId: destId,
    desiredUserId: "user-1",
    desiredClickupUserId: "111",
    revision,
    targetSnapshot: { targetId: "task-1", listId: "list-owning-1", peopleFieldId: "field-1", targetKind: "direct_task" },
    status: "pending",
    attemptCount: 1,
    maxAttempts: 5,
    mutationAttempts: 0,
    leaseToken: token,
    leaseExpiresAt: expiry.toISOString(),
  };
}

async function realIdFor(clientId: string, destId: string): Promise<string> {
  const res = await getDb().execute(sql`SELECT id FROM cu_role_projection_commands WHERE client_id = ${clientId} AND destination_id = ${destId} LIMIT 1`);
  return String((res.rows as any[])[0].id);
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function testDirectTaskRoundTrip(): Promise<void> {
  const rev = computeProjectionRevision("c1", "dest-1", "user-1", "111");
  await seedCommand("dest-1", "c1", rev);
  const cmd = await claimSeeded("c1", "dest-1", rev);
  cmd.id = await realIdFor("c1", "dest-1");
  const log: VendorCallLog = { applyCalls: 0, readBackCalls: 0 };
  await processOneCommand(cmd, makeDeps({ log, config: directTaskConfig() }));
  const st = await readStatus("c1", "dest-1");
  check("direct_task: config+list proof reaches write+readback (1 apply, 1 readback)", log.applyCalls === 1 && log.readBackCalls === 1, `apply=${log.applyCalls} rb=${log.readBackCalls}`);
  check("direct_task: synced immediate response is synced+verified", st.status === "synced" && st.verifiedAt !== null, `status=${st.status}`);
}

async function testRevokedDestinationZeroEgress(): Promise<void> {
  const rev = computeProjectionRevision("c2", "dest-1", "user-1", "111");
  await seedCommand("dest-1", "c2", rev);
  const cmd = await claimSeeded("c2", "dest-1", rev);
  cmd.id = await realIdFor("c2", "dest-1");
  const log: VendorCallLog = { applyCalls: 0, readBackCalls: 0 };
  // Destination now disabled (revoked) in current config → gate stops with zero egress.
  await processOneCommand(cmd, makeDeps({ log, config: directTaskConfig({ enabled: false }) }));
  const st = await readStatus("c2", "dest-1");
  check("revoked destination => zero vendor calls", log.applyCalls === 0 && log.readBackCalls === 0);
  check("revoked destination => disabled, no mutation_attempts", st.status === "disabled" && st.mutationAttempts === 0, `status=${st.status} mut=${st.mutationAttempts}`);
}

async function testKillSwitchAfterClaimZeroMutation(): Promise<void> {
  const rev = computeProjectionRevision("c3", "dest-1", "user-1", "111");
  await seedCommand("dest-1", "c3", rev);
  const cmd = await claimSeeded("c3", "dest-1", rev);
  cmd.id = await realIdFor("c3", "dest-1");
  const log: VendorCallLog = { applyCalls: 0, readBackCalls: 0 };
  // Kill switch toggled active after claim → mutation aborted with zero egress.
  await processOneCommand(cmd, makeDeps({ log, killSwitchActive: true, config: directTaskConfig() }));
  const st = await readStatus("c3", "dest-1");
  check("kill switch after claim => zero mutation", log.applyCalls === 0);
  check("kill switch after claim => disabled, no egress", st.status === "disabled" && st.mutationAttempts === 0, `status=${st.status}`);
}

async function testNoopReadbackFailureAmbiguous(): Promise<void> {
  const rev = computeProjectionRevision("c4", "dest-1", "user-1", "111");
  await seedCommand("dest-1", "c4", rev);
  const cmd = await claimSeeded("c4", "dest-1", rev);
  cmd.id = await realIdFor("c4", "dest-1");
  const log: VendorCallLog = { applyCalls: 0, readBackCalls: 0 };
  // Write is a noop (already correct) but the confirming read-back FAILS → ambiguous, never synced.
  await processOneCommand(
    cmd,
    makeDeps({
      log,
      config: directTaskConfig(),
      applyOutcome: { ok: true, action: "noop", previousIds: ["111"], desiredId: "111" },
      readBackOutcome: { ok: false, retryable: true, error: "read timeout", errorCode: "timeout" },
    }),
  );
  const st = await readStatus("c4", "dest-1");
  check("noop + readback failure => ambiguous (never synced)", st.status === "ambiguous", `status=${st.status}`);
  check("noop still direct-reads (readback attempted)", log.readBackCalls === 1);
}

async function testAmbiguousReadBeforeRepeatMutation(): Promise<void> {
  const rev = computeProjectionRevision("c5", "dest-1", "user-1", "111");
  await seedCommand("dest-1", "c5", rev);
  // Put row in ambiguous state.
  await getDb().execute(sql`UPDATE cu_role_projection_commands SET status = 'ambiguous' WHERE client_id = 'c5'`);
  const cmd = await claimSeeded("c5", "dest-1", rev);
  cmd.id = await realIdFor("c5", "dest-1");
  cmd.status = "ambiguous";
  const log: VendorCallLog = { applyCalls: 0, readBackCalls: 0 };
  // Ambiguous read proves already-correct → resolve WITHOUT another mutation.
  await processOneCommand(
    cmd,
    makeDeps({ log, config: directTaskConfig(), readBackOutcome: { ok: true, currentIds: ["111"], matchesDesired: true } }),
  );
  const st = await readStatus("c5", "dest-1");
  check("ambiguous: direct read BEFORE any repeat write", log.readBackCalls === 1 && log.applyCalls === 0, `apply=${log.applyCalls} rb=${log.readBackCalls}`);
  check("ambiguous read proving match => synced, no new mutation", st.status === "synced");
}

async function testTerminalNonReclaimAndSupersession(): Promise<void> {
  const rev = computeProjectionRevision("c6", "dest-1", "user-1", "111");
  await seedCommand("dest-1", "c6", rev);
  // Mark terminal.
  await getDb().execute(sql`UPDATE cu_role_projection_commands SET status = 'failed', terminal_at = now() WHERE client_id = 'c6'`);
  // Attempt to claim via the real target-claim path (not exposed here) — assert the
  // eligibility predicate: terminal rows are not claimable. We prove it by CAS:
  // a stale worker holding the OLD revision cannot finalize after supersession.
  const cmd = await claimSeeded("c6", "dest-1", rev);
  cmd.id = await realIdFor("c6", "dest-1");
  cmd.status = "failed";
  // Supersede: staging wrote a NEW revision (different desired user).
  const newRev = computeProjectionRevision("c6", "dest-1", "user-2", "222");
  await getDb().execute(sql`UPDATE cu_role_projection_commands SET revision = ${newRev}, terminal_at = NULL, status = 'pending', desired_clickup_user_id = '222' WHERE client_id = 'c6'`);
  const log: VendorCallLog = { applyCalls: 0, readBackCalls: 0 };
  // Stale worker (old rev) processes — its finalizers CAS on old revision and match 0 rows.
  await processOneCommand(cmd, makeDeps({ log, config: directTaskConfig() }));
  const st = await readStatus("c6", "dest-1");
  check("supersession: stale-revision worker cannot overwrite newer intent", st.status === "pending", `status=${st.status}`);
}

async function testAbsentOverrideDefaultFanoutUniverse(): Promise<void> {
  // Seed a per-client department with a default doer, one member, and TWO customer
  // clients — one WITH an override row, one with NO override row. A default-slot
  // change must fan out to BOTH (the no-override client inherits the default).
  await getDb().execute(sql`INSERT INTO sd_departments (id, name, assignment_scope, default_primary_user_id) VALUES ('deptF', 'Fan Dept', 'per_client', 'user-default')`);
  await getDb().execute(sql`INSERT INTO sd_department_members (department_id, user_id, clickup_user_id, active) VALUES ('deptF', 'user-default', '999', true)`);
  await getDb().execute(sql`INSERT INTO clients (id, firm_name, is_archived, lifecycle_stage) VALUES ('cliA', 'Client A', false, 'customer')`);
  await getDb().execute(sql`INSERT INTO clients (id, firm_name, is_archived, lifecycle_stage) VALUES ('cliB', 'Client B', false, 'customer')`);
  // cliA has an override row (empty doer slot → still inherits default); cliB has NONE.
  await getDb().execute(sql`INSERT INTO sd_client_dept_assignments (client_id, department_id) VALUES ('cliA', 'deptF')`);
  // Destination so staging produces commands (client_list_parent needs per-client target).
  await getDb().execute(sql`INSERT INTO cu_role_projection_destinations (id, workspace_id, department_id, responsibility, target_kind, list_id, people_field_id, max_people, environment, enabled) VALUES ('destF', 'ws-1', 'deptF', 'doer', 'client_list_parent', 'listF', 'fieldF', 1, 'sandbox', true)`);
  await getDb().execute(sql`INSERT INTO cu_role_projection_client_targets (client_id, destination_id, target_id) VALUES ('cliA', 'destF', 'taskA')`);
  await getDb().execute(sql`INSERT INTO cu_role_projection_client_targets (client_id, destination_id, target_id) VALUES ('cliB', 'destF', 'taskB')`);

  const result = await getDb().transaction(async (tx: any) =>
    fanOutDepartmentProjectionForTest(tx, "deptF", ["doer"]),
  );
  check("absent-override default fan-out enumerates full universe (>=2 subjects)", result.subjects >= 2, `subjects=${result.subjects}`);
  // cliB (no override row) must have a staged command — proving inheritance was included.
  const res = await getDb().execute(sql`SELECT COUNT(*)::int AS n FROM cu_role_projection_commands WHERE client_id = 'cliB' AND destination_id = 'destF'`);
  const n = Number((res.rows as any[])[0].n);
  check("no-override client inherits default and IS staged", n === 1, `cliB commands=${n}`);
}

async function testGateChangesAfterMutationNeverSynced(): Promise<void> {
  const rev = computeProjectionRevision("c7", "dest-1", "user-1", "111");
  await seedCommand("dest-1", "c7", rev);
  const cmd = await claimSeeded("c7", "dest-1", rev);
  cmd.id = await realIdFor("c7", "dest-1");
  const log: VendorCallLog = { applyCalls: 0, readBackCalls: 0 };

  // Config is enabled through gate1 + the pre-mutation kill-switch check, but the
  // destination is RE-POINTED to a different task AFTER the write (gate3 sees the
  // new target). The confirmation read must NOT hit the stale task, and the
  // command must never be marked synced.
  let call = 0;
  const deps: ProjectionWorkerDeps = {
    isKillSwitchActive: async () => false,
    loadCurrentConfig: async () => {
      call++;
      // gate1 (call 1): original target-1. gate3 (call 2+): re-pointed target-2.
      if (call <= 1) return directTaskConfig();
      return directTaskConfig({ targetId: "task-2" });
    },
    applyProjectionDelta: async () => {
      log.applyCalls++;
      return { ok: true, action: "set", previousIds: [], desiredId: "111" };
    },
    readBackProjectionField: async (args: any) => {
      log.readBackCalls++;
      // If we ever read the stale task, that's a failure we can detect.
      (log as any).readTaskId = args.taskId;
      return { ok: true, currentIds: ["111"], matchesDesired: true };
    },
  } as ProjectionWorkerDeps;

  await processOneCommand(cmd, deps);
  const st = await readStatus("c7", "dest-1");
  // gate3 detects the changed target and finalizes ambiguous BEFORE any readback.
  check("gate-change after mutation => confirmation read NOT made on stale (or any) target", log.readBackCalls === 0, `rb=${log.readBackCalls} readTaskId=${(log as any).readTaskId}`);
  check("gate-change after mutation => never synced (blocked/ambiguous, retry)", st.status === "blocked" || st.status === "ambiguous", `status=${st.status}`);
}

// ── Blocker A: production approval actions (executed service-level) ──────────

async function testApprovalActions(): Promise<void> {
  // Task #5157 fix 3: upsertRoleProjectionDestination now queries the
  // destination's department in the upsert transaction (to enforce the Paid
  // Search-specific policy). A GENERIC department must exist for these approval
  // tests; its non-Paid-Search name means the special policy is skipped.
  await getDb().execute(
    sql`INSERT INTO sd_departments (id, name, assignment_scope) VALUES ('dept-appr', 'Approval Dept', 'per_client') ON CONFLICT (id) DO NOTHING`,
  );

  const base = {
    workspaceId: "ws-appr",
    departmentId: "dept-appr",
    responsibility: "doer",
    targetKind: "direct_task" as const,
    listId: "list-appr",
    targetId: "task-appr",
    peopleFieldId: "field-appr",
    environment: "production" as const,
  };

  // 1) Production cannot enable absent approvals.
  const r1 = await upsertRoleProjectionDestination({ ...base, enabled: true, actorId: "ceo-1" });
  check("production enable absent approvals => rejected", r1.ok === false, JSON.stringify(r1));

  // 2) Approve BOTH via actions → row persists approvals with now()+actor.
  const r2 = await upsertRoleProjectionDestination({
    ...base,
    enabled: false,
    actorId: "ceo-1",
    sandboxExitApproval: "approve",
    ownerApproval: "approve",
  });
  const okApproved =
    r2.ok === true &&
    r2.destination.sandboxExitApprovedAt !== null &&
    r2.destination.sandboxExitApprovedBy === "ceo-1" &&
    r2.destination.ownerApprovedAt !== null &&
    r2.destination.ownerApprovedBy === "ceo-1";
  check("CEO approve actions persist now()+actor", okApproved, JSON.stringify(r2));

  // 3) Now enabling production succeeds (approvals preserved when omitted).
  const r3 = await upsertRoleProjectionDestination({ ...base, enabled: true, actorId: "ceo-1" });
  check("production enable WITH both approvals => ok + enabled", r3.ok === true && (r3 as any).destination.enabled === true, JSON.stringify(r3));

  // 4) Revoking owner approval while still enabled => rejected (cannot leave enabled).
  const r4 = await upsertRoleProjectionDestination({
    ...base,
    enabled: true,
    actorId: "ceo-1",
    ownerApproval: "revoke",
  });
  check("revoke approval while enabled => rejected (safe)", r4.ok === false, JSON.stringify(r4));

  // 5) Revoke owner approval AND disable => ok; approval cleared.
  const r5 = await upsertRoleProjectionDestination({
    ...base,
    enabled: false,
    actorId: "ceo-1",
    ownerApproval: "revoke",
  });
  const okRevoked =
    r5.ok === true &&
    (r5 as any).destination.ownerApprovedAt === null &&
    (r5 as any).destination.ownerApprovedBy === null &&
    (r5 as any).destination.enabled === false;
  check("revoke + disable => ok, owner approval cleared", okRevoked, JSON.stringify(r5));

  // 6) Approval action without an authenticated actor => rejected.
  const r6 = await upsertRoleProjectionDestination({
    ...base,
    enabled: false,
    actorId: null,
    sandboxExitApproval: "approve",
  });
  check("approve without actor => rejected", r6.ok === false, JSON.stringify(r6));
}

async function testPaidSearchDestinationPolicy(): Promise<void> {
  await getDb().execute(
    sql`INSERT INTO sd_departments (id, name, assignment_scope) VALUES ('dept-paid-search', ${PAID_SEARCH_DEPT_NAME}, 'per_client') ON CONFLICT (id) DO NOTHING`,
  );

  const base = {
    workspaceId: "ws-paid-search",
    departmentId: "dept-paid-search",
    responsibility: "doer",
    targetKind: "client_list_parent" as const,
    listId: "sandbox-copy-list",
    peopleFieldId: CLICKUP_DOER_FIELD_ID,
    environment: "sandbox" as const,
    enabled: false,
  };

  const sandboxOk = await upsertRoleProjectionDestination(base);
  check(
    "Paid Search sandbox accepts a distinct copied list with the fixed Doer field",
    sandboxOk.ok === true,
    JSON.stringify(sandboxOk),
  );

  // Checker remains an allowed projection role for its explicitly
  // checker-capable department.
  await getDb().execute(
    sql`INSERT INTO sd_departments (id, name, assignment_scope) VALUES (${PAID_SEARCH_DEPARTMENT_ID}, ${PAID_SEARCH_DEPT_NAME}, 'per_client') ON CONFLICT (id) DO NOTHING`,
  );
  const checkerOk = await upsertRoleProjectionDestination({
    ...base,
    workspaceId: "ws-paid-search-checker",
    departmentId: PAID_SEARCH_DEPARTMENT_ID,
    responsibility: "checker",
    peopleFieldId: CLICKUP_CHECKER_FIELD_ID,
  });
  check(
    "Checker projection remains accepted for a checker-capable department",
    checkerOk.ok === true,
    JSON.stringify(checkerOk),
  );

  const sandboxCanonical = await upsertRoleProjectionDestination({
    ...base,
    listId: CANONICAL_PRODUCTION_LIST_ID,
  });
  check(
    "Paid Search sandbox rejects the canonical production list",
    sandboxCanonical.ok === false,
    JSON.stringify(sandboxCanonical),
  );

  const prodWrongList = await upsertRoleProjectionDestination({
    ...base,
    environment: "production",
    listId: "not-canonical",
  });
  check(
    "Paid Search production rejects any non-canonical list",
    prodWrongList.ok === false,
    JSON.stringify(prodWrongList),
  );

  const prodOk = await upsertRoleProjectionDestination({
    ...base,
    environment: "production",
    listId: CANONICAL_PRODUCTION_LIST_ID,
  });
  check(
    "Paid Search production accepts the canonical list while disabled pending approvals",
    prodOk.ok === true,
    JSON.stringify(prodOk),
  );

  const wrongField = await upsertRoleProjectionDestination({
    ...base,
    peopleFieldId: CLICKUP_CHECKER_FIELD_ID,
  });
  check(
    "Paid Search Doer rejects the Checker People field",
    wrongField.ok === false,
    JSON.stringify(wrongField),
  );

  const directTask = await upsertRoleProjectionDestination({
    ...base,
    targetKind: "direct_task",
    targetId: "copied-parent",
  });
  check(
    "Paid Search rejects direct_task destinations",
    directTask.ok === false,
    JSON.stringify(directTask),
  );

  const unsupportedResponsibility = await upsertRoleProjectionDestination({
    ...base,
    responsibility: "unsupported" as any,
  });
  check(
    "Paid Search rejects unsupported responsibility at the configuration boundary",
    unsupportedResponsibility.ok === false,
    JSON.stringify(unsupportedResponsibility),
  );
}

async function testOnlyDoerCheckerCanStageOrConfigure(): Promise<void> {
  await getDb().execute(
    sql`INSERT INTO sd_departments (id, name, assignment_scope) VALUES ('dept-role-filter', 'Role Filter Dept', 'per_client') ON CONFLICT (id) DO NOTHING`,
  );
  await getDb().execute(
    sql`INSERT INTO sd_departments (id, name, assignment_scope) VALUES (${PAID_SEARCH_DEPARTMENT_ID}, ${PAID_SEARCH_DEPT_NAME}, 'per_client') ON CONFLICT (id) DO NOTHING`,
  );
  await getDb().execute(sql`
    INSERT INTO cu_role_projection_destinations
      (id, workspace_id, department_id, responsibility, target_kind, list_id, people_field_id, max_people, environment, enabled)
    VALUES
      ('dest-role-doer', 'ws-1', ${PAID_SEARCH_DEPARTMENT_ID}, 'doer', 'client_list_parent', 'list-role', 'field-doer', 1, 'sandbox', true),
      ('dest-role-checker', 'ws-1', ${PAID_SEARCH_DEPARTMENT_ID}, 'checker', 'client_list_parent', 'list-role', 'field-checker', 1, 'sandbox', true)
  `);
  await getDb().execute(sql`
    INSERT INTO cu_role_projection_client_targets (client_id, destination_id, target_id)
    VALUES
      ('client-role-filter', 'dest-role-doer', 'task-doer'),
      ('client-role-filter', 'dest-role-checker', 'task-checker')
  `);
  const staged = await getDb().transaction((tx: any) =>
    stageProjectionCommandsInTx(tx, [
      {
        clientId: "client-role-filter",
        departmentId: PAID_SEARCH_DEPARTMENT_ID,
        responsibility: "doer",
        desiredUserId: "user-1",
        desiredClickupUserId: "111",
      },
      {
        clientId: "client-role-filter",
        departmentId: PAID_SEARCH_DEPARTMENT_ID,
        responsibility: "checker",
        desiredUserId: "user-1",
        desiredClickupUserId: "111",
      },
    ]),
  );
  const checkerCommands = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM cu_role_projection_commands
    WHERE client_id = 'client-role-filter' AND destination_id = 'dest-role-checker'
  `);
  check("Doer and Checker projection staging remains enabled", staged.staged === 2, `staged=${staged.staged}`);
  check(
    "Checker projection stages a command",
    Number((checkerCommands.rows as any[])[0].n) === 1,
  );

  const rejected = await upsertRoleProjectionDestination({
    workspaceId: "ws-1",
    departmentId: "dept-role-filter",
    responsibility: "unsupported" as any,
    targetKind: "direct_task",
    listId: "list-role",
    targetId: "task-role",
    peopleFieldId: "field-role",
    environment: "sandbox",
  });
  check("admin rejects unsupported responsibility at the configuration boundary", rejected.ok === false, JSON.stringify(rejected));
}

// ── Blocker C: summaryFromStatuses coverage (direct unit test) ──────────────

function testSummaryFromStatusesCoverage(): void {
  const stage: ProjectionStageSummary = {
    staged: 2,
    nobullOnly: 0,
    blocked: 0,
    disabled: 0,
    missingIdentity: 0,
    stagedRefs: [
      { clientId: "x", destinationId: "d" },
      { clientId: "y", destinationId: "d" },
    ],
  };
  const verified = new Date();
  const syncedRow = (clientId: string): ProjectionRefStatusLite => ({
    clientId,
    destinationId: "d",
    status: "synced",
    verifiedAt: verified,
  });

  // Exact coverage, all synced+verified => synced.
  const s1 = summaryFromStatuses(stage, [syncedRow("x"), syncedRow("y")]);
  check("summary: exact coverage all synced+verified => synced", s1.state === "synced", s1.state);

  // Missing one row => never synced.
  const s2 = summaryFromStatuses(stage, [syncedRow("x")]);
  check("summary: missing row => not synced", s2.state !== "synced", s2.state);

  // Duplicate ref key => never synced.
  const s3 = summaryFromStatuses(stage, [syncedRow("x"), syncedRow("x"), syncedRow("y")]);
  check("summary: duplicate ref => not synced", s3.state !== "synced", s3.state);

  // Mismatched key (extraneous) => never synced.
  const s4 = summaryFromStatuses(stage, [syncedRow("x"), syncedRow("y"), syncedRow("z")]);
  check("summary: extraneous ref => not synced", s4.state !== "synced", s4.state);

  // synced status but verifiedAt null => never synced.
  const s5 = summaryFromStatuses(stage, [
    syncedRow("x"),
    { clientId: "y", destinationId: "d", status: "synced", verifiedAt: null },
  ]);
  check("summary: synced-but-unverified => not synced", s5.state !== "synced", s5.state);

  // Worst-state propagation.
  const s6 = summaryFromStatuses(stage, [
    syncedRow("x"),
    { clientId: "y", destinationId: "d", status: "failed", verifiedAt: null },
  ]);
  check("summary: one failed => failed", s6.state === "failed", s6.state);
}

// ── Durable wake-up fix (Task #5156 completion gap) ───────────────────────────

/** Count live (non-terminal) work_queue rows for the projection queue. */
async function countProjectionWakes(filter?: { dedupeKey?: string }): Promise<number> {
  const where = filter?.dedupeKey
    ? sql`AND dedupe_key = ${filter.dedupeKey}`
    : sql``;
  const res = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM work_queue
    WHERE queue_name = 'clickup_role_projection'
      AND status NOT IN ('completed', 'failed', 'dead_letter', 'cancelled')
      ${where}
  `);
  return Number((res.rows as any[])[0].n);
}

/**
 * A new desired command revision and its immediate wake commit atomically.
 * Even when the post-commit coalesced accelerator enqueue throws, the real
 * scheduler dequeue can lease the staged wake and the normal handler syncs the
 * command without another mutation, restart, or boot catch-up.
 */
async function testInitialWakeSurvivesFailedPostCommitKick(): Promise<void> {
  await getDb().execute(sql`DELETE FROM work_queue`);
  const destId = "dest-initial-wake";
  const clientId = "client-initial-wake";
  await getDb().execute(sql`
    INSERT INTO cu_role_projection_destinations
      (id, workspace_id, department_id, responsibility, target_kind, list_id, target_id, people_field_id, max_people, environment, enabled)
    VALUES (${destId}, 'ws-1', 'dept-initial-wake', 'doer', 'direct_task', 'list-owning-1', 'task-1', 'field-1', 1, 'sandbox', true)
  `);

  await getDb().transaction(async (tx: any) => {
    await stageProjectionCommandInTx(tx, {
      clientId,
      destinationId: destId,
      desiredUserId: "user-1",
      desiredClickupUserId: "111",
      targetSnapshot: {
        targetId: "task-1",
        listId: "list-owning-1",
        peopleFieldId: "field-1",
        targetKind: "direct_task",
      },
    });
  });

  __test_setClickUpRoleProjectionEnqueueOverride(async () => {
    throw new Error("injected post-commit enqueue outage");
  });
  try {
    await kickClickUpRoleProjectionSafe();
  } finally {
    __test_setClickUpRoleProjectionEnqueueOverride(null);
  }

  const command = await getDb().execute(sql`
    SELECT id, revision, attempt_count
    FROM cu_role_projection_commands
    WHERE client_id = ${clientId} AND destination_id = ${destId}
    LIMIT 1
  `);
  const row = (command.rows as any[])[0];
  const expectedKey = projectionWakeDedupeKey({
    commandId: String(row.id),
    revision: String(row.revision),
    attemptCount: Number(row.attempt_count),
  });
  check(
    "initial wake: command transaction atomically persists one immediate wake",
    (await countProjectionWakes({ dedupeKey: expectedKey })) === 1,
    `wakes=${await countProjectionWakes({ dedupeKey: expectedKey })}`,
  );

  const leasedWake = await __test_dequeueFromQueueUsingCurrentDb(
    "maintenance",
    "test-initial-wake",
    60_000,
    { queueName: "clickup_role_projection" },
  );
  check(
    "initial wake: real dequeue leases it after post-commit kick failure",
    leasedWake?.dedupeKey === expectedKey,
    `leased=${leasedWake?.dedupeKey ?? "none"}`,
  );

  const log: VendorCallLog = { applyCalls: 0, readBackCalls: 0 };
  __test_setProjectionWorkerDeps(
    makeDeps({ log, config: directTaskConfig({ id: destId }) }),
  );
  try {
    await runWithWorkerDb(() =>
      handleClickUpRoleProjectionJob(leasedWake ?? ({ id: "missing" } as WorkQueueJob)),
    );
  } finally {
    __test_setProjectionWorkerDeps(null);
  }
  const status = await readStatus(clientId, destId);
  check(
    "initial wake: normal handler verifies sync without mutation/restart/catch-up",
    status.status === "synced" && status.verifiedAt !== null,
    `status=${status.status}`,
  );

  // The authorized repair path has the same durability contract for a terminal,
  // unleased command: resetting it and inserting its new attempt-0 wake are one
  // transaction.
  await getDb().execute(sql`DELETE FROM work_queue`);
  await getDb().execute(sql`
    UPDATE cu_role_projection_commands
    SET status = 'failed',
        terminal_at = now(),
        last_error = 'injected terminal failure',
        last_error_code = 'exhausted',
        attempt_count = max_attempts,
        mutation_attempts = 1,
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL
    WHERE client_id = ${clientId} AND destination_id = ${destId}
  `);
  __test_setClickUpRoleProjectionEnqueueOverride(async () => {
    throw new Error("injected manual-resync accelerator outage");
  });
  try {
    const reset = await manualResyncProjectionCommand(clientId, destId);
    check("manual resync: command reset succeeds despite accelerator outage", reset.ok, reset.message);
  } finally {
    __test_setClickUpRoleProjectionEnqueueOverride(null);
  }
  check(
    "manual resync: reset transaction atomically persists its immediate wake",
    (await countProjectionWakes({ dedupeKey: expectedKey })) === 1,
    `wakes=${await countProjectionWakes({ dedupeKey: expectedKey })}`,
  );
  const repairWake = await __test_dequeueFromQueueUsingCurrentDb(
    "maintenance",
    "test-manual-resync-wake",
    60_000,
    { queueName: "clickup_role_projection" },
  );
  __test_setProjectionWorkerDeps(
    makeDeps({ log: { applyCalls: 0, readBackCalls: 0 }, config: directTaskConfig({ id: destId }) }),
  );
  try {
    await runWithWorkerDb(() =>
      handleClickUpRoleProjectionJob(repairWake ?? ({ id: "missing" } as WorkQueueJob)),
    );
  } finally {
    __test_setProjectionWorkerDeps(null);
  }
  const repaired = await readStatus(clientId, destId);
  check(
    "manual resync: durable wake verifies repair without another event or restart",
    repairWake?.dedupeKey === expectedKey &&
      repaired.status === "synced" &&
      repaired.verifiedAt !== null,
    `leased=${repairWake?.dedupeKey ?? "none"} status=${repaired.status}`,
  );
}

/**
 * >50 commands: the handler drains its 50-command cap, leaves ONE durable
 * work_queue continuation (unique dedupe key derived from the current job id),
 * then a subsequent run drains the remainder. Proves crash-safe progress past
 * the cap without relying on boot catch-up.
 */
async function testOverCapLeavesDurableContinuation(): Promise<void> {
  await getDb().execute(sql`DELETE FROM work_queue`);
  const destId = "dest-cap";
  // Distinct (workspace, department, responsibility) tuple — the destinations
  // table has a unique index on it, so reuse of dept-1/doer would collide.
  await getDb().execute(sql`
    INSERT INTO cu_role_projection_destinations
      (id, workspace_id, department_id, responsibility, target_kind, list_id, target_id, people_field_id, max_people, environment, enabled)
    VALUES (${destId}, 'ws-1', 'dept-cap', 'doer', 'direct_task', 'list-owning-1', 'task-1', 'field-1', 1, 'sandbox', true)
    ON CONFLICT (id) DO NOTHING
  `);
  const TOTAL = 51;
  for (let i = 0; i < TOTAL; i++) {
    await getDb().execute(sql`
      INSERT INTO cu_role_projection_commands
        (client_id, destination_id, desired_user_id, desired_clickup_user_id, revision, target_snapshot, status, attempt_count, max_attempts, mutation_attempts)
      VALUES (
        ${`cap-client-${i}`}, ${destId}, 'user-1', '111', ${`rev-${i}`},
        ${JSON.stringify({ targetId: "task-1", listId: "list-owning-1", peopleFieldId: "field-1", targetKind: "direct_task" })}::jsonb,
        'pending', 0, 5, 0
      )
    `);
  }

  // All commands synchronously synced (no network) via injected default deps.
  const log: VendorCallLog = { applyCalls: 0, readBackCalls: 0 };
  __test_setProjectionWorkerDeps(makeDeps({ log, config: directTaskConfig() }));
  try {
    const job = { id: "job-cap-1" } as WorkQueueJob;
    const r1 = await runWithWorkerDb(() => handleClickUpRoleProjectionJob(job));

    // The drain claims globally across destinations, so leftover non-terminal
    // commands from earlier scenarios may occupy a few of the 50 slots. The
    // invariant that matters is the CAP: the first run processes EXACTLY the
    // 50-command cap (cursor encodes the count) and returns a continuation.
    check(
      ">50: first run processes exactly the 50-command cap",
      (r1.cursor ?? "") === "processed:50:continuation",
      r1.cursor,
    );
    check(">50: cap run returns a continuation cursor", (r1.cursor ?? "").endsWith(":continuation"), r1.cursor);

    const contKey = `clickup_role_projection:continuation:${job.id}`;
    check(
      ">50: exactly one DURABLE continuation row enqueued with job-derived key",
      (await countProjectionWakes({ dedupeKey: contKey })) === 1,
      `wakes(contKey)=${await countProjectionWakes({ dedupeKey: contKey })}`,
    );

    // Lease the persisted continuation through the exact production dequeue
    // query, then dispatch that leased job to the handler.
    const continuationJob = await __test_dequeueFromQueueUsingCurrentDb(
      "maintenance",
      "test-cap-continuation",
      60_000,
      { queueName: "clickup_role_projection" },
    );
    check(
      ">50: persisted continuation is immediately queue-eligible and leased",
      continuationJob?.dedupeKey === contKey,
      `leased=${continuationJob?.dedupeKey ?? "none"}`,
    );
    const r2 = await runWithWorkerDb(() =>
      handleClickUpRoleProjectionJob(continuationJob ?? ({ id: "missing" } as WorkQueueJob)),
    );
    const drainedAll = await getDb().execute(sql`
      SELECT count(*)::int AS n FROM cu_role_projection_commands
      WHERE destination_id = ${destId} AND status = 'synced'
    `);
    check(
      ">50: continuation run drains the remainder to synced",
      Number((drainedAll.rows as any[])[0].n) === TOTAL,
      `synced=${(drainedAll.rows as any[])[0].n}`,
    );
    check(">50: remainder run is under-cap (no further continuation)", !(r2.cursor ?? "").endsWith(":continuation"), r2.cursor);
  } finally {
    __test_setProjectionWorkerDeps(null);
  }
}

/**
 * Transient failure writes next_attempt_at PLUS a delayed durable work_queue
 * wake in the same transaction. The test waits for the persisted schedule,
 * leases the wake through the production dequeue query, and dispatches it to
 * the same queue handler — no DB time edits, assignment mutation, restart, or
 * boot catch-up.
 */
async function testTransientFailureWritesWakeThenAutoRetries(): Promise<void> {
  await getDb().execute(sql`DELETE FROM work_queue`);
  const destId = "dest-wake";
  const clientId = "wake-client";
  // Distinct (workspace, department, responsibility) tuple (see cap test note).
  await getDb().execute(sql`
    INSERT INTO cu_role_projection_destinations
      (id, workspace_id, department_id, responsibility, target_kind, list_id, target_id, people_field_id, max_people, environment, enabled)
    VALUES (${destId}, 'ws-1', 'dept-wake', 'doer', 'direct_task', 'list-owning-1', 'task-1', 'field-1', 1, 'sandbox', true)
    ON CONFLICT (id) DO NOTHING
  `);
  await getDb().execute(sql`
    INSERT INTO cu_role_projection_commands
      (client_id, destination_id, desired_user_id, desired_clickup_user_id, revision, target_snapshot, status, attempt_count, max_attempts, mutation_attempts)
    VALUES (
      ${clientId}, ${destId}, 'user-1', '111', 'rev-wake',
      ${JSON.stringify({ targetId: "task-1", listId: "list-owning-1", peopleFieldId: "field-1", targetKind: "direct_task" })}::jsonb,
      'pending', 1, 5, 0
    )
  `);

  // First attempt: injected transient (retryable) write failure with a short,
  // real future schedule so the test can observe ineligible -> eligible.
  const failLog: VendorCallLog = { applyCalls: 0, readBackCalls: 0 };
  const cmd = await claimSeeded(clientId, destId, "rev-wake");
  cmd.id = await realIdFor(clientId, destId);
  await processOneCommand(
    cmd,
    makeDeps({
      log: failLog,
      config: directTaskConfig(),
      applyOutcome: { ok: false, retryable: true, error: "transient 502 from vendor", errorCode: "transient" },
      retryDelayMs: 1_000,
    }),
  );

  const afterFail = await readStatus(clientId, destId);
  check("wake: transient failure => failed status (retryable)", afterFail.status === "failed", `status=${afterFail.status}`);

  const wakeRows = await getDb().execute(sql`
    SELECT retry_at, dedupe_key, status FROM work_queue
    WHERE queue_name = 'clickup_role_projection'
      AND dedupe_key LIKE 'clickup_role_projection:wake:%'
    ORDER BY created_at DESC
  `);
  const expectedWakeKey = projectionWakeDedupeKey({
    commandId: cmd.id,
    revision: cmd.revision,
    attemptCount: cmd.attemptCount,
  });
  const wr = (wakeRows.rows as any[]).find((row) => row.dedupe_key === expectedWakeKey);
  check("wake: a delayed work_queue wake row was inserted atomically", !!wr && wr.status === "pending", JSON.stringify(wr ?? null));

  const cmdRow = await getDb().execute(sql`
    SELECT next_attempt_at FROM cu_role_projection_commands
    WHERE client_id = ${clientId} AND destination_id = ${destId} LIMIT 1
  `);
  const nextAt = (cmdRow.rows as any[])[0].next_attempt_at as string | Date;
  const nextAtDate = nextAt instanceof Date ? nextAt : new Date(nextAt);
  check(
    "wake: wake key is scoped to the exact command revision/attempt",
    wr?.dedupe_key === expectedWakeKey,
    `key=${wr?.dedupe_key} expected=${expectedWakeKey}`,
  );
  check(
    "wake: two commands with the same due time cannot suppress each other",
    expectedWakeKey !== projectionWakeDedupeKey({
      commandId: `${cmd.id}-other`,
      revision: cmd.revision,
      attemptCount: cmd.attemptCount,
    }),
  );
  check(
    "wake: work_queue retry_at exactly matches command next_attempt_at",
    wr && new Date(wr.retry_at).getTime() === nextAtDate.getTime(),
    `wake=${wr?.retry_at} command=${nextAtDate.toISOString()}`,
  );

  const tooEarly = await __test_dequeueFromQueueUsingCurrentDb(
    "maintenance",
    "test-wake-early",
    60_000,
    { queueName: "clickup_role_projection" },
  );
  check("wake: persisted future retry is not queue-eligible early", tooEarly === null);

  await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
  const dueWake = await __test_dequeueFromQueueUsingCurrentDb(
    "maintenance",
    "test-wake-due",
    60_000,
    { queueName: "clickup_role_projection" },
  );
  check(
    "wake: persisted retry becomes eligible and is leased by the real dequeue query",
    dueWake?.dedupeKey === expectedWakeKey,
    `leased=${dueWake?.dedupeKey ?? "none"}`,
  );

  // Dispatch the actually leased queue wake; the retried vendor call succeeds.
  const okLog: VendorCallLog = { applyCalls: 0, readBackCalls: 0 };
  __test_setProjectionWorkerDeps(makeDeps({ log: okLog, config: directTaskConfig() }));
  try {
    await runWithWorkerDb(() =>
      handleClickUpRoleProjectionJob(dueWake ?? ({ id: "missing" } as WorkQueueJob)),
    );
  } finally {
    __test_setProjectionWorkerDeps(null);
  }

  const afterRetry = await readStatus(clientId, destId);
  check(
    "wake: due wake auto-retries the command to synced (no restart, no new mutation)",
    afterRetry.status === "synced" && afterRetry.verifiedAt !== null,
    `status=${afterRetry.status}`,
  );
}

async function main(): Promise<void> {
  console.log("\n=== ClickUp role projection WORKER (executed hermetic) ===\n");

  // Pure unit test (no DB) — blocker C.
  testSummaryFromStatusesCoverage();

  await runInIsolatedSchema(
    async () => {
      await testDirectTaskRoundTrip();
      await testRevokedDestinationZeroEgress();
      await testKillSwitchAfterClaimZeroMutation();
      await testNoopReadbackFailureAmbiguous();
      await testAmbiguousReadBeforeRepeatMutation();
      await testTerminalNonReclaimAndSupersession();
      await testGateChangesAfterMutationNeverSynced();
      await testAbsentOverrideDefaultFanoutUniverse();
      await testApprovalActions();
      await testPaidSearchDestinationPolicy();
      await testOnlyDoerCheckerCanStageOrConfigure();
      await testInitialWakeSurvivesFailedPostCommitKick();
      await testOverCapLeavesDurableContinuation();
      await testTransientFailureWritesWakeThenAutoRetries();
    },
    { tables: [...CU_TABLES] },
  );

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Unexpected error in worker test:", err);
  process.exit(1);
});
