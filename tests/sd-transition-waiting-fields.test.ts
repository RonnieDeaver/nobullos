/* test-registration
{
  "name": "Service-desk transition waiting-on field writes + missing-UUID admin alert (Tasks #3082, #3175)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3082: the service-desk transition waiting-on custom-field write path, route-level. Guards the silent-loss bug class where a list mapping without fieldWaitingWho/What/WhenId UUIDs lets the transition succeed while the waiting-on metadata never reaches ClickUp: fully configured → exactly 3 setCustomFieldValue calls with the right field IDs; missing/partial UUIDs → transition still succeeds, zero/partial writes, and a console.warn names the missing config keys. Runs inside runInIsolatedSchema with the ClickUp client stubbed via resolve hook, so it is fast, network-free, and race-free vs live workers. Task #3175 extension: the same missing-UUID condition also fires the in-app admin alert (workflow.service_desk.waiting_on_fields_missing) exactly once per list per 24h with a per-list dedupe key, naming the missing config keys and linking to /admin/service-desk; fully configured mappings fire nothing (dispatcher stubbed in-module).",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/sdTransitionSetup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3082 — Waiting-on custom-field write path, end-to-end.
 *
 * The /transition route writes waitingWho/What/When custom-field values
 * to ClickUp — but only if the sd_list_mapping config has the field
 * UUIDs (fieldWaitingWhoId etc.). If an admin configures the list
 * mapping without those UUIDs, the guard passes (status still moves)
 * but the waiting-on metadata silently never reaches ClickUp.
 *
 * Route-level integration test (isolated schema, stubbed ClickUp client
 * via resolve hook — see tests/helpers/sdTransitionSetup.mjs):
 *
 *   1. FULLY configured mapping (all 3 waiting-field UUIDs set):
 *      POST /transition → blocked succeeds, cu.setCustomFieldValue is
 *      called exactly 3 times with the right field IDs + values, status
 *      is updated in ClickUp and mirrored locally, event recorded.
 *   2. Mapping WITHOUT the waiting-field UUIDs:
 *      the transition still succeeds (status moves, mirror + event
 *      land) but zero field-write calls are made, and the server logs a
 *      console.warn naming the missing field UUID config keys.
 *
 * Task #3175 additions — in-app admin alert for the same condition:
 *
 *   - When UUIDs are missing, alertServiceDeskWaitingFieldsMissing fires
 *     notifyByType("workflow.service_desk.waiting_on_fields_missing")
 *     with dedupeKey `list:<listId>`, naming the missing config keys and
 *     linking to /admin/service-desk.
 *   - Rate limit: at most once per list per 24h in-process — the partial
 *     config step (same list) must NOT fire a second notification.
 *   - Fully configured mapping fires nothing.
 *   - Registry contains the id as implemented.
 *
 * Task #3228 additions — persisted rate-limit ledger:
 *
 *   - Fires persist `{listId: epochMs}` to the system_settings ledger key.
 *   - Simulated restart (in-memory reset only) keeps suppressing via the
 *     persisted ledger.
 *   - Backdated ledger past 24h re-arms the alert; the write-through prunes
 *     expired entries.
 *
 * Run with: --import ./tests/helpers/sdTransitionSetup.mjs
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

type CuCall = { fn: string; args: Record<string, any> };
declare global {
  // eslint-disable-next-line no-var
  var __sdCuCalls: CuCall[] | undefined;
}

const TABLES = [
  "sd_list_mapping",
  "sd_ticket_mapping",
  "sd_departments",
  "sd_ticket_events",
  "clickup_tasks",
  "users",
  // Task #3228 — the alert module persists its rate-limit ledger to
  // system_settings; clone it so test writes stay in the isolated schema.
  "system_settings",
] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

// Per-run random token so repeated runs never collide even if a clone
// fallthrough bug ever leaks writes to public.* (see memory note).
const RUN = randomUUID().replace(/-/g, "").slice(0, 8);

const LIST_ID = `sd-list-${RUN}`;
const USER_ID = `sd-user-${RUN}`;
const FIELD_WHO = `cf-who-${RUN}`;
const FIELD_WHAT = `cf-what-${RUN}`;
const FIELD_WHEN = `cf-when-${RUN}`;

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

function cuCalls(): CuCall[] {
  return globalThis.__sdCuCalls ?? [];
}

function resetCuCalls(): void {
  globalThis.__sdCuCalls = [];
}

// ─── Clerk-seam express app (real requireAuth in the loop) ──────────────────

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

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: parsed };
}

async function put(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: parsed };
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: parsed };
}

// ─── seeding ─────────────────────────────────────────────────────────────────

async function seedConfig(isoDb: IsoDb, withWaitingFieldIds: boolean): Promise<void> {
  await isoDb.execute(sql`DELETE FROM sd_list_mapping`);
  await isoDb.execute(sql`
    INSERT INTO sd_list_mapping
      (id, clickup_list_id, field_waiting_who_id, field_waiting_what_id,
       field_waiting_when_id, setup_step, created_at, updated_at)
    VALUES (
      ${`cfg-${RUN}-${withWaitingFieldIds ? "full" : "bare"}`}, ${LIST_ID},
      ${withWaitingFieldIds ? FIELD_WHO : null},
      ${withWaitingFieldIds ? FIELD_WHAT : null},
      ${withWaitingFieldIds ? FIELD_WHEN : null},
      'complete', NOW(), NOW()
    )
  `);
}

async function seedTask(isoDb: IsoDb, taskId: string): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO clickup_tasks (id, list_id, name, status, date_updated, synced_at, updated_at)
    VALUES (${taskId}, ${LIST_ID}, ${`Ticket ${taskId}`}, 'in progress', ${String(Date.now())}, NOW(), NOW())
  `);
}

async function getMirrorStatus(isoDb: IsoDb, taskId: string): Promise<string | null> {
  const res = await isoDb.execute(sql`SELECT status FROM clickup_tasks WHERE id = ${taskId}`);
  return (res.rows[0] as any)?.status ?? null;
}

async function countTransitionEvents(isoDb: IsoDb, taskId: string): Promise<number> {
  const res = await isoDb.execute(sql`
    SELECT COUNT(*)::int AS n FROM sd_ticket_events
    WHERE clickup_task_id = ${taskId} AND event_type = 'status_transition'
  `);
  return (res.rows[0] as any)?.n ?? 0;
}

// ─── main ────────────────────────────────────────────────────────────────────

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
      await startApp();

      // ── Task #3175: intercept the dispatcher so the alert never hits
      // Slack / notification_deliveries and we can assert the calls.
      const {
        __setNotifyForTest,
        __resetNotifyForTest,
        __resetServiceDeskConfigAlertForTest,
        SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID,
        SERVICE_DESK_CONFIG_FIELDS_NOTIFICATION_ID,
      } = await import("../server/services/serviceDeskConfigAlert");
      type NotifyCall = {
        id: string;
        text: string;
        dedupeKey: string | null | undefined;
        mirrorDeepLink: string | undefined;
      };
      const notifyCalls: NotifyCall[] = [];
      __setNotifyForTest((async (id: string, payload: any, options: any = {}) => {
        notifyCalls.push({
          id,
          text: String(payload?.text ?? ""),
          dedupeKey: options.dedupeKey,
          mirrorDeepLink: options.mirrorDeepLink,
        });
        return { attempted: true, delivered: true, skipped: false, status: "delivered", deliveryId: null } as any;
      }) as any);
      __resetServiceDeskConfigAlertForTest();

      // The route fires the alert with `void` (fire-and-forget); with the
      // dispatcher stubbed it resolves synchronously enough that a single
      // macrotask tick drains it deterministically.
      const drainAlert = () => new Promise((r) => setTimeout(r, 25));

      // Task #3228 — the fire path now does a persisted-ledger DB read
      // before notifying and a write after; poll instead of a fixed sleep
      // wherever a positive outcome is expected (see memory note about
      // fire-and-forget persist reordering).
      const waitFor = async (cond: () => boolean | Promise<boolean>, label: string) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (await cond()) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`waitFor timed out: ${label}`);
      };

      // capture console.warn
      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: any[]) => {
        warns.push(args.map((a) => String(a)).join(" "));
        origWarn.apply(console, args);
      };

      try {
        // ── 1. Fully configured: 3 field writes with the right UUIDs ──────
        {
          await seedConfig(isoDb, true);
          const taskId = `t-full-${RUN}`;
          await seedTask(isoDb, taskId);
          resetCuCalls();
          warns.length = 0;

          const { status, body } = await post(`/api/service-desk/tickets/${taskId}/transition`, {
            toStatus: "blocked",
            waitingWho: "Acme AM",
            waitingWhat: "Approve the copy",
            waitingWhen: "Friday",
          });
          assert.equal(status, 200, `transition should succeed: ${JSON.stringify(body)}`);

          const fieldWrites = cuCalls().filter((c) => c.fn === "setCustomFieldValue");
          assert.equal(fieldWrites.length, 3, "exactly 3 custom-field writes");
          const byField = new Map(fieldWrites.map((c) => [c.args.fieldId, c.args.value]));
          assert.equal(byField.get(FIELD_WHO), "Acme AM", "waiting-who written to the who field UUID");
          assert.equal(byField.get(FIELD_WHAT), "Approve the copy", "waiting-what written to the what field UUID");
          assert.equal(byField.get(FIELD_WHEN), "Friday", "waiting-when written to the when field UUID");
          for (const c of fieldWrites) {
            assert.equal(c.args.taskId, taskId, "field write targets the transitioned task");
          }

          const statusUpdates = cuCalls().filter((c) => c.fn === "updateTask");
          assert.equal(statusUpdates.length, 1, "one ClickUp status update");
          assert.equal(statusUpdates[0].args.patch?.status, "blocked", "ClickUp status set to blocked");

          assert.equal(await getMirrorStatus(isoDb, taskId), "blocked", "mirror status updated");
          assert.equal(await countTransitionEvents(isoDb, taskId), 1, "status_transition event recorded");
          assert.ok(
            !warns.some((w) => w.includes("custom-field UUID(s) missing")),
            "no missing-UUID warning when config is complete",
          );
          await drainAlert();
          assert.equal(notifyCalls.length, 0, "no admin alert when config is complete");
          ok("1: fully configured mapping → 3 setCustomFieldValue calls with the right field IDs, no warning, no alert");
        }

        // ── 2. Missing UUIDs: transition succeeds, zero writes, warn ──────
        {
          await seedConfig(isoDb, false);
          const taskId = `t-bare-${RUN}`;
          await seedTask(isoDb, taskId);
          resetCuCalls();
          warns.length = 0;

          const { status, body } = await post(`/api/service-desk/tickets/${taskId}/transition`, {
            toStatus: "blocked",
            waitingWho: "Acme AM",
            waitingWhat: "Approve the copy",
            waitingWhen: "Friday",
          });
          assert.equal(status, 200, `transition should still succeed: ${JSON.stringify(body)}`);

          const fieldWrites = cuCalls().filter((c) => c.fn === "setCustomFieldValue");
          assert.equal(fieldWrites.length, 0, "no custom-field writes when UUIDs are missing from config");

          const statusUpdates = cuCalls().filter((c) => c.fn === "updateTask");
          assert.equal(statusUpdates.length, 1, "ClickUp status still updated");
          assert.equal(statusUpdates[0].args.patch?.status, "blocked", "ClickUp status set to blocked");

          assert.equal(await getMirrorStatus(isoDb, taskId), "blocked", "mirror status still updated");
          assert.equal(await countTransitionEvents(isoDb, taskId), 1, "status_transition event still recorded");

          const missingWarn = warns.find((w) => w.includes("custom-field UUID(s) missing"));
          assert.ok(missingWarn, "server logs a warn about missing field UUIDs");
          assert.ok(missingWarn!.includes("fieldWaitingWhoId"), "warn names fieldWaitingWhoId");
          assert.ok(missingWarn!.includes("fieldWaitingWhatId"), "warn names fieldWaitingWhatId");
          assert.ok(missingWarn!.includes("fieldWaitingWhenId"), "warn names fieldWaitingWhenId");
          assert.ok(missingWarn!.includes(taskId), "warn names the affected task id");

          // Task #3175 — the in-app admin alert fires exactly once with the
          // registry id, a per-list dedupe key, the missing config keys, and
          // a link to the setup wizard. (The fire path now includes a
          // persisted-ledger DB read, so poll rather than fixed-sleep.)
          await waitFor(() => notifyCalls.length >= 1, "route-fired alert lands");
          assert.equal(notifyCalls.length, 1, "admin alert fired exactly once");
          const alert = notifyCalls[0];
          assert.equal(
            alert.id,
            SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID,
            "alert uses the registered notification id",
          );
          assert.equal(alert.dedupeKey, `list:${LIST_ID}`, "alert dedupe key is per-list");
          assert.ok(alert.text.includes("fieldWaitingWhoId"), "alert names fieldWaitingWhoId");
          assert.ok(alert.text.includes("fieldWaitingWhatId"), "alert names fieldWaitingWhatId");
          assert.ok(alert.text.includes("fieldWaitingWhenId"), "alert names fieldWaitingWhenId");
          assert.ok(alert.text.includes("/admin/service-desk"), "alert links to the setup wizard");

          // The dispatcher's admin in-app mirror truncates the body to 240
          // chars and deep-links each inbox row. Assert what admins ACTUALLY
          // receive: the missing keys + wizard link must all sit within the
          // first 240 chars of the text (so truncation can't cut them off),
          // and the mirror deep link must target the setup wizard itself.
          const mirrored = alert.text.length > 240 ? alert.text.slice(0, 237) + "..." : alert.text;
          assert.ok(mirrored.includes("fieldWaitingWhoId"), "truncated in-app body keeps fieldWaitingWhoId");
          assert.ok(mirrored.includes("fieldWaitingWhatId"), "truncated in-app body keeps fieldWaitingWhatId");
          assert.ok(mirrored.includes("fieldWaitingWhenId"), "truncated in-app body keeps fieldWaitingWhenId");
          assert.ok(
            mirrored.includes("/admin/service-desk"),
            "truncated in-app body keeps the setup wizard link",
          );
          assert.equal(
            alert.mirrorDeepLink,
            "/admin/service-desk",
            "in-app inbox rows deep-link to the setup wizard",
          );
          ok("2: missing UUIDs → transition succeeds, zero field writes, warning logged, admin alert fired once");
        }

        // ── 3. Partially configured: only present UUIDs written, warn ─────
        {
          await isoDb.execute(sql`DELETE FROM sd_list_mapping`);
          await isoDb.execute(sql`
            INSERT INTO sd_list_mapping
              (id, clickup_list_id, field_waiting_who_id, field_waiting_what_id,
               field_waiting_when_id, setup_step, created_at, updated_at)
            VALUES (${`cfg-${RUN}-part`}, ${LIST_ID}, ${FIELD_WHO}, NULL, NULL,
                    'complete', NOW(), NOW())
          `);
          const taskId = `t-part-${RUN}`;
          await seedTask(isoDb, taskId);
          resetCuCalls();
          warns.length = 0;

          const { status } = await post(`/api/service-desk/tickets/${taskId}/transition`, {
            toStatus: "blocked",
            waitingWho: "Acme AM",
            waitingWhat: "Approve the copy",
            waitingWhen: "Friday",
          });
          assert.equal(status, 200, "partial config transition succeeds");

          const fieldWrites = cuCalls().filter((c) => c.fn === "setCustomFieldValue");
          assert.equal(fieldWrites.length, 1, "only the configured field is written");
          assert.equal(fieldWrites[0].args.fieldId, FIELD_WHO, "the who field is the one written");

          const missingWarn = warns.find((w) => w.includes("custom-field UUID(s) missing"));
          assert.ok(missingWarn, "partial config still warns");
          assert.ok(!missingWarn!.includes("fieldWaitingWhoId"), "warn omits the configured field");
          assert.ok(missingWarn!.includes("fieldWaitingWhatId"), "warn names missing fieldWaitingWhatId");
          assert.ok(missingWarn!.includes("fieldWaitingWhenId"), "warn names missing fieldWaitingWhenId");
          // Task #3175 — same list within 24h: the alert is rate-limited and
          // must NOT fire again (notifyCalls still holds only step 2's call).
          await drainAlert();
          assert.equal(
            notifyCalls.length,
            1,
            "alert suppressed for the same list within the 24h window",
          );
          ok("3: partially configured mapping → only present UUIDs written, warn names only the missing ones, alert rate-limited");
        }

        // ── 4. Alert module contract: persisted ledger + registry entry ───
        {
          const {
            alertServiceDeskWaitingFieldsMissing,
            SERVICE_DESK_WAITING_FIELDS_LEDGER_KEY,
            SERVICE_DESK_WAITING_FIELDS_ALERT_WINDOW_MS,
          } = await import("../server/services/serviceDeskConfigAlert");

          const readLedger = async (): Promise<Record<string, number>> => {
            const res = await isoDb.execute(sql`
              SELECT value FROM system_settings
              WHERE key = ${SERVICE_DESK_WAITING_FIELDS_LEDGER_KEY}
            `);
            const raw = (res.rows[0] as any)?.value;
            return raw ? JSON.parse(raw) : {};
          };

          // A DIFFERENT list is not suppressed by the first list's ledger.
          await alertServiceDeskWaitingFieldsMissing(`other-list-${RUN}`, ["fieldWaitingWhoId"]);
          assert.equal(notifyCalls.length, 2, "different list fires its own alert");
          assert.equal(
            notifyCalls[1].dedupeKey,
            `list:other-list-${RUN}`,
            "second alert scoped to the other list",
          );

          // Empty missing-list is a no-op.
          await alertServiceDeskWaitingFieldsMissing(LIST_ID, []);
          assert.equal(notifyCalls.length, 2, "empty missing-field list never alerts");

          // Task #3228 — both fires above persisted their timestamps.
          // (Step 2's route fire is void'd, so poll until its write lands.)
          await waitFor(async () => {
            const ledger = await readLedger();
            return (
              ledger[`${SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID}:${LIST_ID}`] !== undefined &&
              ledger[`${SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID}:other-list-${RUN}`] !== undefined
            );
          }, "persisted ledger holds both fired lists");

          // Task #3228 — simulate a server restart: wipe ONLY the in-memory
          // map. The persisted ledger must keep suppressing the same list,
          // so no new notification fires.
          __resetServiceDeskConfigAlertForTest();
          await alertServiceDeskWaitingFieldsMissing(LIST_ID, ["fieldWaitingWhenId"], {
            toStatus: "blocked",
          });
          assert.equal(
            notifyCalls.length,
            2,
            "restart (in-memory reset) does NOT re-alert — persisted 24h window holds",
          );

          // Task #3228 — window elapsed: backdate the persisted ledger past
          // 24h and restart again. The alert re-arms, and the write-through
          // prunes the expired other-list entry from the persisted ledger.
          const stale = Date.now() - SERVICE_DESK_WAITING_FIELDS_ALERT_WINDOW_MS - 60_000;
          await isoDb.execute(sql`
            UPDATE system_settings
            SET value = ${JSON.stringify({
              [`${SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID}:${LIST_ID}`]: stale,
              [`${SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID}:other-list-${RUN}`]: stale,
            })}
            WHERE key = ${SERVICE_DESK_WAITING_FIELDS_LEDGER_KEY}
          `);
          __resetServiceDeskConfigAlertForTest();
          await alertServiceDeskWaitingFieldsMissing(LIST_ID, ["fieldWaitingWhenId"], {
            toStatus: "blocked",
          });
          assert.equal(notifyCalls.length, 3, "same list re-alerts after the 24h window elapses");
          await waitFor(async () => {
            const ledger = await readLedger();
            return (
              ledger[`${SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID}:${LIST_ID}`] !== undefined &&
              ledger[`${SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID}:${LIST_ID}`] > stale &&
              ledger[`${SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID}:other-list-${RUN}`] === undefined
            );
          }, "re-fire persists fresh timestamp and prunes the expired entry");

          // Registry contract: the id exists and is marked implemented.
          const { NOTIFICATION_REGISTRY } = await import(
            "../server/services/notifications/registry"
          );
          const entry = NOTIFICATION_REGISTRY.find(
            (e: any) => e.id === SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID,
          );
          assert.ok(entry, "registry contains the service-desk waiting-fields notification id");
          assert.equal((entry as any).implemented, true, "registry entry marked implemented");
          ok("4: alert module — per-list scoping, empty no-op, persisted ledger survives restart, 24h re-arm + pruning, registry entry present");
        }

        // ── 4. Setup verify: waiting-on UUIDs cross-checked vs List fields ──
        {
          await seedConfig(isoDb, true);

          // All three bound UUIDs exist on the List → check ok
          (globalThis as any).__sdCuFields = [
            { id: FIELD_WHO, name: "Waiting On" },
            { id: FIELD_WHAT, name: "Action Needed" },
            { id: FIELD_WHEN, name: "Response Needed By" },
          ];
          let { status, body } = await get("/api/service-desk/setup/verify");
          assert.equal(status, 200, `verify should succeed: ${JSON.stringify(body)}`);
          let check = (body.checks as any[]).find((c) => c.key === "waiting_field_uuids");
          assert.ok(check, "verify includes a waiting_field_uuids check");
          assert.equal(check.status, "ok", "all-matching UUIDs → ok");

          // The when-field UUID no longer exists on the List → flagged stale
          (globalThis as any).__sdCuFields = [
            { id: FIELD_WHO, name: "Waiting On" },
            { id: FIELD_WHAT, name: "Action Needed" },
          ];
          ({ status, body } = await get("/api/service-desk/setup/verify"));
          assert.equal(status, 200, "verify with stale UUID still 200");
          check = (body.checks as any[]).find((c) => c.key === "waiting_field_uuids");
          assert.equal(check.status, "missing", "stale UUID → missing status");
          assert.ok(check.detail.includes(FIELD_WHEN), "detail names the stale UUID");
          assert.ok(check.detail.includes("Response Needed By"), "detail names the field label");
          assert.ok(!check.detail.includes(FIELD_WHO), "detail omits UUIDs that do exist");
          ok("4: setup verify flags a bound waiting-on UUID that no longer exists on the List");
        }

        // ── 5. Config PUT: save-time validation returns fieldWarnings ──────
        {
          await seedConfig(isoDb, true);
          (globalThis as any).__sdCuFields = [
            { id: FIELD_WHO, name: "Waiting On" },
            { id: FIELD_WHAT, name: "Action Needed" },
            { id: FIELD_WHEN, name: "Response Needed By" },
          ];

          // Save a mistyped who-UUID → warned, but save still succeeds
          const staleId = `cf-typo-${RUN}`;
          let { status, body } = await put("/api/service-desk/config", {
            fieldWaitingWhoId: staleId,
          });
          assert.equal(status, 200, `config save should succeed: ${JSON.stringify(body)}`);
          assert.equal(body.config.fieldWaitingWhoId, staleId, "stale value still persisted (warn, not block)");
          assert.ok(Array.isArray(body.fieldWarnings), "response includes fieldWarnings array");
          assert.equal(body.fieldWarnings.length, 1, "exactly one warning for the mistyped UUID");
          assert.equal(body.fieldWarnings[0].key, "fieldWaitingWhoId", "warning names the config key");
          assert.ok(body.fieldWarnings[0].message.includes(staleId), "warning message names the bad UUID");

          // Fix it back → no warnings
          ({ status, body } = await put("/api/service-desk/config", {
            fieldWaitingWhoId: FIELD_WHO,
          }));
          assert.equal(status, 200, "corrected config save succeeds");
          assert.equal(body.fieldWarnings.length, 0, "no warnings once all bound UUIDs match the List");
          ok("5: config PUT warns on a mistyped waiting-on UUID and clears once corrected");
        }

        // ── 6. Task #3227: change-department config gap → generic alert ────
        {
          // seedConfig never sets field_department_id / department_option_ids,
          // so the change-department write path hits the config-gap branch.
          await seedConfig(isoDb, true);
          const taskId = `t-dept-${RUN}`;
          const deptId = `dept-${RUN}`;
          await seedTask(isoDb, taskId);
          resetCuCalls();
          warns.length = 0;
          notifyCalls.length = 0;
          __resetServiceDeskConfigAlertForTest();
          // Task #3228 — also clear the persisted cross-instance ledger, or
          // step 4's waiting-on fire keeps suppressing across this step.
          await isoDb.execute(sql`
            DELETE FROM system_settings
            WHERE key = 'service_desk_waiting_fields_alert_ledger'
          `);

          const { status, body } = await post(
            `/api/service-desk/tickets/${taskId}/change-department`,
            { newDepartmentId: deptId },
          );
          assert.equal(status, 200, `change-department should succeed: ${JSON.stringify(body)}`);

          const fieldWrites = cuCalls().filter((c) => c.fn === "setCustomFieldValue");
          assert.equal(fieldWrites.length, 0, "no custom-field write when dept mapping is missing");

          const missingWarn = warns.find((w) =>
            w.includes("department will NOT be written to ClickUp"),
          );
          assert.ok(missingWarn, "server warns about the skipped department write");
          assert.ok(missingWarn!.includes("fieldDepartmentId"), "warn names fieldDepartmentId");
          assert.ok(
            missingWarn!.includes(`departmentOptionIds[${deptId}]`),
            "warn names the missing option-map entry",
          );

          await drainAlert();
          assert.equal(notifyCalls.length, 1, "generic config alert fired exactly once");
          const alert = notifyCalls[0];
          assert.equal(
            alert.id,
            SERVICE_DESK_CONFIG_FIELDS_NOTIFICATION_ID,
            "alert uses the generic config-fields notification id",
          );
          assert.equal(alert.dedupeKey, `list:${LIST_ID}`, "alert dedupe key is per-list");
          assert.ok(alert.text.includes("fieldDepartmentId"), "alert names fieldDepartmentId");
          assert.ok(
            alert.text.includes(`departmentOptionIds[${deptId}]`),
            "alert names the missing option-map entry",
          );
          assert.ok(alert.text.includes("/admin/service-desk"), "alert links to the setup wizard");
          assert.equal(
            alert.mirrorDeepLink,
            "/admin/service-desk",
            "in-app inbox rows deep-link to the setup wizard",
          );
          // Missing keys + wizard link must survive the 240-char in-app
          // mirror truncation.
          const mirrored = alert.text.length > 240 ? alert.text.slice(0, 237) + "..." : alert.text;
          assert.ok(mirrored.includes("fieldDepartmentId"), "truncated body keeps fieldDepartmentId");
          assert.ok(
            mirrored.includes("/admin/service-desk"),
            "truncated body keeps the setup wizard link",
          );

          // Second change-department on the same list within 24h → suppressed.
          const taskId2 = `t-dept2-${RUN}`;
          await seedTask(isoDb, taskId2);
          const second = await post(
            `/api/service-desk/tickets/${taskId2}/change-department`,
            { newDepartmentId: deptId },
          );
          assert.equal(second.status, 200, "second change-department succeeds");
          await drainAlert();
          assert.equal(
            notifyCalls.length,
            1,
            "generic alert rate-limited per list within the 24h window",
          );

          // The generic ledger is independent of the waiting-on ledger:
          // a waiting-on alert for the SAME list still fires.
          const { alertServiceDeskWaitingFieldsMissing } = await import(
            "../server/services/serviceDeskConfigAlert"
          );
          await alertServiceDeskWaitingFieldsMissing(LIST_ID, ["fieldWaitingWhoId"]);
          assert.equal(
            notifyCalls.length,
            2,
            "waiting-on alert not suppressed by the generic alert's ledger entry",
          );
          assert.equal(
            notifyCalls[1].id,
            SERVICE_DESK_WAITING_FIELDS_NOTIFICATION_ID,
            "second call is the waiting-on notification id",
          );

          // Registry contract for the new id.
          const { NOTIFICATION_REGISTRY } = await import(
            "../server/services/notifications/registry"
          );
          const entry = NOTIFICATION_REGISTRY.find(
            (e: any) => e.id === SERVICE_DESK_CONFIG_FIELDS_NOTIFICATION_ID,
          );
          assert.ok(entry, "registry contains the generic config-fields notification id");
          assert.equal((entry as any).implemented, true, "registry entry marked implemented");
          ok("6: change-department config gap → write skipped, warn + generic alert once per list per day, independent ledger, registry entry present");
        }
      } finally {
        console.warn = origWarn;
        __resetNotifyForTest();
        __resetServiceDeskConfigAlertForTest();
        await stopApp();
        __test_resetReconciledUsers();
      }
    },
    { tables: [...TABLES] },
  );

  console.log(`\nsd-transition-waiting-fields: ${passed} assertion-groups passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL sd-transition-waiting-fields:", err);
    process.exit(1);
  });