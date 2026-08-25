/* test-registration
{
  "name": "Service-desk ticket detail returns intake question answers (Task #3397)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3397: the ticket read model must surface intake question answers (stored sd_ticket_mapping.question_answers, with a description-parse fallback for pre-column tickets) so staff can read them inline on the NoBull ticket detail instead of opening ClickUp. Route-level, fully inside runInIsolatedSchema — fast and race-free.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3397 — Intake question answers inline on the ticket detail view.
 *
 * The native ServiceDeskCreate form stores structured answers on
 * sd_ticket_mapping.question_answers ([{ label, value }]) at submit time,
 * and the ticket read model (GET /api/service-desk/tickets/:taskId) must
 * surface them so staff never need to open ClickUp to read them.
 *
 * Route-level integration test (isolated schema):
 *
 *   1. Mapping row WITH stored question_answers → the ticket response
 *      returns them verbatim, in stored order.
 *   2. Mapping row WITHOUT stored answers but with the "## Intake
 *      Questions" markdown block in the mirrored description (tickets
 *      submitted before the column existed) → the resolver parses the
 *      block as a fallback, skipping "*(not provided)*" placeholders and
 *      stopping at the next section ("## Additional Details" / "---").
 *   3. Neither stored answers nor a parseable block → questionAnswers
 *      is null.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { createServer } from "http";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import { sql } from "drizzle-orm";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const TABLES = [
  "sd_list_mapping",
  "sd_ticket_mapping",
  "sd_ticket_events",
  "clickup_tasks",
  "clients",
  "users",
] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

// Per-run random token so repeated runs never collide even if a clone
// fallthrough bug ever leaks writes to public.* (see memory note).
const RUN = randomUUID().replace(/-/g, "").slice(0, 8);

const LIST_ID = `sd-list-${RUN}`;
const USER_ID = `sd-user-${RUN}`;

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

function makeAuthMiddleware(userId: string) {
  // Clerk per-request test seam (server/middlewares/requireAuth.ts): the real
  // requireAuth middleware runs and resolves this id. The user is seeded in the
  // isolated sandbox schema, so its profile is pre-registered via
  // __test_markUserReconciled below.
  return (req: any, _res: any, next: any) => {
    req.__test_clerkUserId = userId;
    next();
  };
}

let baseUrl = "";
let server: ReturnType<typeof createServer>;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
let agent: Agent | null = null;

async function startApp(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(makeAuthMiddleware(USER_ID));
  const { registerServiceDeskRoutes } = await import("../server/routes/serviceDesk");
  registerServiceDeskRoutes(app as any);

  originalDispatcher = getGlobalDispatcher();
  agent = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 });
  setGlobalDispatcher(agent);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function stopApp(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setGlobalDispatcher(originalDispatcher);
  if (agent) {
    try { await agent.close(); } catch { /* ignore */ }
    agent = null;
  }
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: parsed };
}

async function seedConfig(isoDb: IsoDb): Promise<void> {
  await isoDb.execute(sql`DELETE FROM sd_list_mapping`);
  await isoDb.execute(sql`
    INSERT INTO sd_list_mapping (id, clickup_list_id, setup_step, created_at, updated_at)
    VALUES (${`cfg-${RUN}`}, ${LIST_ID}, 'complete', NOW(), NOW())
  `);
}

async function seedTask(isoDb: IsoDb, taskId: string, description: string | null): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO clickup_tasks (id, list_id, name, description, status, date_updated, synced_at, updated_at)
    VALUES (${taskId}, ${LIST_ID}, ${`Ticket ${taskId}`}, ${description}, 'submitted', ${String(Date.now())}, NOW(), NOW())
  `);
}

async function seedMapping(
  isoDb: IsoDb,
  taskId: string,
  questionAnswers: Array<{ label: string; value: string }> | null,
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO sd_ticket_mapping (clickup_task_id, requester_user_id, created_via_nobull, question_answers)
    VALUES (${taskId}, ${USER_ID}, true, ${questionAnswers ? JSON.stringify(questionAnswers) : null}::jsonb)
  `);
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await isoDb.execute(sql`
        INSERT INTO users (id, email, role) VALUES (${USER_ID}, ${`sd-${RUN}@nobull.test`}, 'ceo')
      `);
      __test_markUserReconciled(USER_ID, {
        id: USER_ID,
        email: `sd-${RUN}@nobull.test`,
        role: "ceo",
        firstName: "Tester",
      });
      await seedConfig(isoDb);
      await startApp();

      try {
        // ── 1. Stored structured answers returned verbatim ────────────────
        {
          const taskId = `t-stored-${RUN}`;
          const answers = [
            { label: "What page needs the change?", value: "Homepage hero" },
            { label: "Deadline context", value: "Client demo on Friday\nHard stop" },
          ];
          await seedTask(isoDb, taskId, "irrelevant description");
          await seedMapping(isoDb, taskId, answers);

          const res = await get(`/api/service-desk/tickets/${taskId}`);
          assert.equal(res.status, 200);
          assert.deepEqual(res.body.ticket.questionAnswers, answers);
          ok("stored question_answers are returned verbatim in order");
        }

        // ── 2. Fallback: parse the description's Intake Questions block ───
        {
          const taskId = `t-parsed-${RUN}`;
          const description = [
            "**Client:** Acme Law",
            "**Request Type:** Website Change",
            "",
            "## Intake Questions",
            "**What page needs the change?:** Contact page",
            "**Optional context:** *(not provided)*",
            "**Approved by:** Jane",
            "",
            "## Additional Details",
            "**Not a question:** should not appear",
            "",
            "---",
            "*Submitted via NoBull OS*",
          ].join("\n");
          await seedTask(isoDb, taskId, description);
          await seedMapping(isoDb, taskId, null);

          const res = await get(`/api/service-desk/tickets/${taskId}`);
          assert.equal(res.status, 200);
          assert.deepEqual(res.body.ticket.questionAnswers, [
            { label: "What page needs the change?", value: "Contact page" },
            { label: "Approved by", value: "Jane" },
          ]);
          ok("legacy tickets fall back to parsing the description block, skipping *(not provided)* and later sections");
        }

        // ── 3. No answers anywhere → null ──────────────────────────────────
        {
          const taskId = `t-none-${RUN}`;
          await seedTask(isoDb, taskId, "A plain ClickUp-created ticket with no intake block");
          await seedMapping(isoDb, taskId, null);

          const res = await get(`/api/service-desk/tickets/${taskId}`);
          assert.equal(res.status, 200);
          assert.equal(res.body.ticket.questionAnswers, null);
          ok("tickets without answers return questionAnswers: null");
        }
      } finally {
        await stopApp();
        __test_resetReconciledUsers();
      }
    },
    { tables: TABLES },
  );

  console.log(`\nAll ${passed} assertions passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
