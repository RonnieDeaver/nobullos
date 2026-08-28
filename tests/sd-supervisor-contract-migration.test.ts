/* test-registration
{
  "name": "Supervisor schema contraction — fail-closed upgrade, supported-role constraints, replay (Task #5235)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5235 physically drops the retired Supervisor columns. This disposable-schema migration test proves a non-neutral legacy marker blocks before any drop, a neutral prior schema upgrades successfully, Doer/Checker constraints reject Supervisor, and the forward migration replays cleanly.",
  "scanPaths": [
    "migrations/20260825130000_contract_supervisor_schema.sql",
    "shared/models/serviceDesk.ts"
  ],
  "tier": "medium",
  "tierReason": "Creates a disposable schema and runs the migration through upgrade, constraint, and replay cases."
}
test-registration */

import { spawnSync } from "node:child_process";

const dbUrl = process.env.DATABASE_URL ?? "";
if (!dbUrl || dbUrl.includes("neon.tech")) {
  console.error("A disposable hermetic DATABASE_URL is required.");
  process.exit(1);
}

const schema = `sd_contract_${process.pid}_${Date.now()}`.toLowerCase();
const migration = "migrations/20260825130000_contract_supervisor_schema.sql";
let passed = 0;
let failed = 0;

function assert(condition: unknown, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function psql(args: string[]) {
  return spawnSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-q", ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PGOPTIONS: `-c search_path=${schema}`,
    },
  });
}

function sql(statement: string) {
  return psql(["-At", "-c", statement]);
}

try {
  const setup = spawnSync(
    "psql",
    [
      dbUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-c",
      `
        CREATE SCHEMA ${schema};
        SET search_path TO ${schema};
        CREATE TABLE sd_departments (default_supervisor_user_id text);
        CREATE TABLE sd_client_dept_assignments (supervisor_user_id text);
        CREATE TABLE sd_ticket_mapping (supervisor_escalated_at timestamptz);
        CREATE TABLE sd_request_type_checklist_steps (assignee_role text);
        CREATE TABLE cu_role_projection_destinations (
          id text PRIMARY KEY,
          responsibility text NOT NULL
        );
        CREATE TABLE cu_role_projection_commands (destination_id text NOT NULL);
        CREATE TABLE cu_role_projection_client_targets (destination_id text NOT NULL);
        INSERT INTO sd_ticket_mapping (supervisor_escalated_at) VALUES (NOW());
      `,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert(setup.status === 0, "prior Supervisor-era schema fixture created");

  const blocked = psql(["-f", migration]);
  assert(blocked.status !== 0, "non-neutral legacy escalation marker blocks contraction");
  assert(
    blocked.stderr.includes("sd_ticket_mapping.supervisor_escalated_at is not neutralized"),
    "blocking error identifies the exact unmet precondition",
  );
  const beforeColumns = sql(`
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND column_name IN (
        'default_supervisor_user_id',
        'supervisor_user_id',
        'supervisor_escalated_at'
      )
  `);
  assert(beforeColumns.stdout.trim() === "3", "failed precondition drops no retired columns");

  assert(
    sql("UPDATE sd_ticket_mapping SET supervisor_escalated_at = NULL").status === 0,
    "legacy marker neutralized by the cleanup precondition fixture",
  );
  const applied = psql(["-f", migration]);
  assert(applied.status === 0, `neutral prior schema upgrades (${applied.stderr.trim()})`);

  const afterColumns = sql(`
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND column_name IN (
        'default_supervisor_user_id',
        'supervisor_user_id',
        'supervisor_escalated_at'
      )
  `);
  assert(afterColumns.stdout.trim() === "0", "all three retired Supervisor columns are absent");

  assert(
    sql("INSERT INTO sd_request_type_checklist_steps (assignee_role) VALUES ('supervisor')").status !== 0,
    "checklist storage rejects the retired responsibility",
  );
  assert(
    sql("INSERT INTO cu_role_projection_destinations (id, responsibility) VALUES ('legacy', 'supervisor')").status !== 0,
    "projection storage rejects the retired responsibility",
  );
  assert(
    sql("INSERT INTO sd_request_type_checklist_steps (assignee_role) VALUES ('doer'), ('checker')").status === 0,
    "checklist storage accepts Doer and Checker",
  );
  assert(
    sql("INSERT INTO cu_role_projection_destinations (id, responsibility) VALUES ('doer', 'doer'), ('checker', 'checker')").status === 0,
    "projection storage accepts Doer and Checker",
  );

  const replayed = psql(["-f", migration]);
  assert(replayed.status === 0, `contract migration replays cleanly (${replayed.stderr.trim()})`);
} finally {
  spawnSync("psql", [dbUrl, "-q", "-c", `DROP SCHEMA IF EXISTS ${schema} CASCADE`], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

console.log(`Supervisor contract migration: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);