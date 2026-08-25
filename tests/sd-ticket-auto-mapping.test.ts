/* test-registration
{
  "name": "Service-desk webhook ticket auto-mapping (Task #3077)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3077: the service-desk webhook auto-mapping hook (tryCompleteSdTicketMapping). Guards requester-email → users.id and department-option-UUID → dept-id resolution plus the fill-NULL-only ON CONFLICT upsert (manual admin edits must never be overwritten, concurrent duplicate webhooks must converge to one row). Runs fully inside runInIsolatedSchema, so it is fast and race-free vs live workers.",
  "tier": "small"
}
test-registration */
/**
 * Task #3077 — Service-desk webhook auto-mapping: tryCompleteSdTicketMapping.
 *
 * After every ClickUp webhook apply, the post-apply hook resolves the
 * requester email custom field → NoBull users.id and the department
 * dropdown option UUID → department id (via sd_list_mapping's
 * department_option_ids map), then idempotently upserts sd_ticket_mapping.
 * The upsert must be fill-NULL-only: it NEVER overwrites values already
 * set (e.g. by manual admin edits).
 *
 * Everything runs inside runInIsolatedSchema so live workers (search_path
 * = public) can neither see nor race the seeded rows. Cloned tables:
 * sd_list_mapping, sd_ticket_mapping, users. The LIKE clone drops FKs, so
 * user ids are plain strings.
 *
 * Coverage:
 *   1. Full success: email + dept option both resolve → both columns set.
 *   2. Unknown email → requesterUserId stays NULL (dept still resolves).
 *   3. Dept option missing from map → departmentId stays NULL.
 *   4. Fill-NULL-only idempotency: re-run with different resolutions
 *      leaves existing non-NULL values intact, but fills columns that
 *      were NULL.
 *   5. List mismatch / no config → no sd_ticket_mapping row at all.
 *   6. Concurrent duplicate webhooks for the same ticket → exactly one
 *      row, no throw (ON CONFLICT path).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { tryCompleteSdTicketMapping } from "../server/services/clickUpWorkerHandlers";
import { runInIsolatedSchema } from "./db-sandbox";

const TABLES = ["sd_list_mapping", "sd_ticket_mapping", "users"] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

// Per-run random token so repeated runs can never collide even if a
// clone/fallthrough bug ever leaks writes to public.* (see memory note).
const RUN = randomUUID().replace(/-/g, "").slice(0, 8);

const LIST_ID = `sd-list-${RUN}`;
const FIELD_REQUESTER = `cf-req-${RUN}`;
const FIELD_DEPT = `cf-dept-${RUN}`;
const DEPT_OPT = `opt-mkt-${RUN}`;
const DEPT_ID = `dept-mkt-${RUN}`;
const USER_ID = `user-${RUN}`;
const USER_EMAIL = `sd-req-${RUN}@nobull.test`;

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

async function seedConfig(isoDb: IsoDb): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO sd_list_mapping
      (id, clickup_list_id, field_requester_id, field_department_id,
       department_option_ids, setup_step, created_at, updated_at)
    VALUES (
      ${`cfg-${RUN}`}, ${LIST_ID}, ${FIELD_REQUESTER}, ${FIELD_DEPT},
      ${JSON.stringify({ [DEPT_OPT]: DEPT_ID })}::jsonb, 'complete', NOW(), NOW()
    )
  `);
}

async function seedUser(isoDb: IsoDb): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, email) VALUES (${USER_ID}, ${USER_EMAIL})
  `);
}

function makeTask(
  taskId: string,
  requesterValue: any,
  deptValue: any,
): any {
  return {
    id: taskId,
    custom_fields: [
      { id: FIELD_REQUESTER, value: requesterValue },
      { id: FIELD_DEPT, value: deptValue },
    ],
  };
}

async function getMapping(isoDb: IsoDb, taskId: string) {
  const res = await isoDb.execute(sql`
    SELECT clickup_task_id, requester_user_id, department_id, client_id
    FROM sd_ticket_mapping WHERE clickup_task_id = ${taskId}
  `);
  return res.rows as Array<{
    clickup_task_id: string;
    requester_user_id: string | null;
    department_id: string | null;
    client_id: number | null;
  }>;
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await seedConfig(isoDb);
      await seedUser(isoDb);

      // ── 1. Full success ────────────────────────────────────────────────
      {
        const taskId = `t1-${RUN}`;
        await tryCompleteSdTicketMapping(
          makeTask(taskId, ` ${USER_EMAIL.toUpperCase()} `, { id: DEPT_OPT }),
          LIST_ID,
        );
        const rows = await getMapping(isoDb, taskId);
        assert.equal(rows.length, 1, "exactly one mapping row created");
        assert.equal(rows[0].requester_user_id, USER_ID, "email resolved to user id (case/space-insensitive)");
        assert.equal(rows[0].department_id, DEPT_ID, "dept option UUID resolved via map");
        ok("1: full mapping — requester + department both resolved");
      }

      // ── 2. Unknown email → requester stays NULL ────────────────────────
      {
        const taskId = `t2-${RUN}`;
        await tryCompleteSdTicketMapping(
          makeTask(taskId, `nobody-${RUN}@nowhere.test`, DEPT_OPT),
          LIST_ID,
        );
        const rows = await getMapping(isoDb, taskId);
        assert.equal(rows.length, 1, "row still created for unknown email");
        assert.equal(rows[0].requester_user_id, null, "unknown email → requester_user_id NULL");
        assert.equal(rows[0].department_id, DEPT_ID, "dept still resolves (string option value)");
        ok("2: unrecognized email leaves requester_user_id NULL, row still lands");
      }

      // ── 3. Dept option not in map → department stays NULL ──────────────
      {
        const taskId = `t3-${RUN}`;
        await tryCompleteSdTicketMapping(
          makeTask(taskId, USER_EMAIL, { id: `opt-unmapped-${RUN}` }),
          LIST_ID,
        );
        const rows = await getMapping(isoDb, taskId);
        assert.equal(rows.length, 1, "row created despite unmapped dept option");
        assert.equal(rows[0].requester_user_id, USER_ID, "requester still resolves");
        assert.equal(rows[0].department_id, null, "unmapped option → department_id NULL");
        assert.equal(rows[0].client_id, null, "client_id untouched (stays NULL)");
        ok("3: unmapped department option leaves department_id NULL");
      }

      // ── 4. Fill-NULL-only idempotency ──────────────────────────────────
      {
        // Pre-existing row with a manually-set requester but NULL dept.
        const taskId = `t4-${RUN}`;
        const manualUser = `manual-user-${RUN}`;
        await isoDb.execute(sql`
          INSERT INTO sd_ticket_mapping
            (id, clickup_task_id, requester_user_id, department_id, created_at, updated_at)
          VALUES (${`m4-${RUN}`}, ${taskId}, ${manualUser}, NULL, NOW(), NOW())
        `);
        // Webhook resolves a DIFFERENT requester + a dept.
        await tryCompleteSdTicketMapping(
          makeTask(taskId, USER_EMAIL, { id: DEPT_OPT }),
          LIST_ID,
        );
        let rows = await getMapping(isoDb, taskId);
        assert.equal(rows.length, 1, "still one row after conflict upsert");
        assert.equal(
          rows[0].requester_user_id,
          manualUser,
          "existing non-NULL requester NOT overwritten by webhook resolution",
        );
        assert.equal(rows[0].department_id, DEPT_ID, "NULL department filled by webhook");
        ok("4a: ON CONFLICT fills NULL dept, preserves manually-set requester");

        // Re-run again with an unmapped dept: must not NULL-out the dept.
        await tryCompleteSdTicketMapping(
          makeTask(taskId, `nobody-${RUN}@nowhere.test`, { id: `opt-x-${RUN}` }),
          LIST_ID,
        );
        rows = await getMapping(isoDb, taskId);
        assert.equal(rows[0].requester_user_id, manualUser, "re-run keeps requester");
        assert.equal(rows[0].department_id, DEPT_ID, "re-run does not regress dept to NULL");
        ok("4b: idempotent re-run leaves existing data intact");
      }

      // ── 5. List mismatch / no binding → no row ─────────────────────────
      {
        const taskId = `t5-${RUN}`;
        await tryCompleteSdTicketMapping(
          makeTask(taskId, USER_EMAIL, { id: DEPT_OPT }),
          `other-list-${RUN}`,
        );
        const rows = await getMapping(isoDb, taskId);
        assert.equal(rows.length, 0, "non-service-desk list produces no mapping row");
        ok("5: task on a different list is ignored entirely");
      }

      // ── 6. Concurrent duplicate webhooks → one row, no throw ───────────
      {
        const taskId = `t6-${RUN}`;
        await Promise.all([
          tryCompleteSdTicketMapping(makeTask(taskId, USER_EMAIL, { id: DEPT_OPT }), LIST_ID),
          tryCompleteSdTicketMapping(makeTask(taskId, USER_EMAIL, { id: DEPT_OPT }), LIST_ID),
          tryCompleteSdTicketMapping(makeTask(taskId, USER_EMAIL, { id: DEPT_OPT }), LIST_ID),
        ]);
        const rows = await getMapping(isoDb, taskId);
        assert.equal(rows.length, 1, "concurrent webhooks converge to a single row");
        assert.equal(rows[0].requester_user_id, USER_ID, "resolved values intact after race");
        assert.equal(rows[0].department_id, DEPT_ID, "dept intact after race");
        ok("6: concurrent duplicate webhooks are safe (ON CONFLICT)");
      }
    },
    { tables: [...TABLES] },
  );

  console.log(`\nsd-ticket-auto-mapping: ${passed} assertions-groups passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL sd-ticket-auto-mapping:", err);
    process.exit(1);
  });
