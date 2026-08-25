/* test-registration
{
  "name": "Deal stage automation engine (Task #4331)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4331: the automation substrate every later CRM trigger/sequence plugs into — stage writers must emit exactly one durable event per deal_stage_history row, processing must be idempotent at every layer (processed-event no-op, UNIQUE (rule,event) run claim, notify dedupe) so replays/double-moves never duplicate actions, the four bounded executors must degrade per contract (ClickUp skips when unconnected), the global kill switch must record visible skipped runs instead of executing, and failures must land in the run log AND notification_deliveries. A drift here silently double-fires vendor writes or drops automations without a trace.",
  "tier": "small"
}
test-registration */
/**
 * Task #4331 — deal stage automation coverage.
 *
 * Real registerDealsRoutes + registerDealAutomationRoutes on one Express
 * app with the requireAuth per-request test seam (__test_clerkUserId —
 * string authenticates as that users row, null is anonymous) against the
 * real db (hermetic per-run DB under `npm test`). Queue processing is
 * exercised by calling processDealStageEvent directly — the scheduler
 * loop is not running in tests; the enqueue side is asserted via
 * work_queue rows.
 *
 *   1. Authz — automation surface is 401 unauthenticated, 403 for
 *      account_manager, 200 for team_lead.
 *   2. Rule validation — notify target=user without userId 400; from-stage
 *      equal to trigger stage 400; from-stage from another pipeline 400.
 *   3. Event emission — creating a deal and moving it each write exactly
 *      one deal_stage_events row keyed to the history row, plus a
 *      work_queue job deduped on the event id.
 *   4. Creation-event matching — from-null events match only unfiltered
 *      rules; disabled rules never fire.
 *   5. Full executor pass — one rule with all four actions: notify (owner,
 *      rendered template), set_property (notes persisted), clickup_task
 *      (skipped — no connection in the hermetic DB), advance_lifecycle
 *      (client lead → session_booked).
 *   6. Idempotency — re-processing a processed event no-ops; resetting the
 *      event to pending and re-processing hits the terminal run claim: one
 *      run row, one notification, no re-execution.
 *   7. Kill switch — flip via the route, status reflects it, a move while
 *      OFF records skipped/killswitch runs and executes nothing; flip back.
 *   8. Failure path — a set_property rule pointing at a ghost owner
 *      records a failed run + actionResults error AND a
 *      workflow.deal_automation.run_failed delivery row.
 *   9. Same-stage rows never fire (synthetic from===to event).
 *  10. Requeue lever — a pending event whose work_queue kick was lost is
 *      re-enqueued by POST /events/requeue.
 *  11. Admin surface — list carries run stats; PATCH toggles enabled and
 *      cannot smuggle a stageId change; runs endpoint filters by rule;
 *      DELETE removes the rule.
 *
 * All fixtures are RUN-suffixed; asserts are scoped to fixture keys
 * (dedupe keys / rule ids), never totals. The kill-switch system_settings
 * row is removed in finally (pin-to-absent restore — the suite asserts
 * both switch positions itself).
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerDealsRoutes } from "../server/routes/deals";
import { registerDealAutomationRoutes } from "../server/routes/dealAutomation";
import {
  processDealStageEvent,
  DEAL_AUTOMATION_KILL_SWITCH_KEY,
  DEAL_AUTOMATION_RUN_FAILED_NOTIFICATION_ID,
  renderAutomationTemplate,
} from "../server/services/dealAutomationEngine";
import {
  dealAutomationRules,
  dealAutomationRuns,
  dealPipelines,
  dealStageEvents,
  dealStages,
  deals,
} from "@shared/schema";

const HEX = randomBytes(4).toString("hex");
const RUN = `t4331-${HEX}`;

// Clock-derived so the payload date never rots when the calendar passes a
// hardcoded literal (Task #4433; see tests/save-plays.test.ts dueIn pattern).
const FUTURE_CLOSE_DATE = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);

const TL_ID = `${RUN}-tl`; // team_lead → manages rules
const AM_ID = `${RUN}-am`; // account_manager → creates/moves deals, owns them
const CLIENT_ID = `${RUN}-client`;

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ── Harness ─────────────────────────────────────────────────────────────────

let actingUserId: string | null = TL_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // requireAuth test seam (NODE_ENV=test): string = authenticated as that
    // users row (role read from the DB), null = anonymous → 401.
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerDealsRoutes(app);
  registerDealAutomationRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

let baseUrl = "";

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${TL_ID}, ${`${TL_ID}@t4331.example`}, 'Task4331', 'Lead', 'team_lead', 'lead'),
      (${AM_ID}, ${`${AM_ID}@t4331.example`}, 'Task4331', 'Owner', 'account_manager', 'core')
  `);
  // lifecycle_stage defaults to 'customer' (forward-only ladder would make
  // advance_lifecycle a no-op) — pin the fixture client to 'lead'.
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo, lifecycle_stage)
    VALUES (${CLIENT_ID}, ${`${RUN} Firm`}, ${AM_ID}, false, false, 'lead')
  `);
}

/** Event ids created during the run — used to prune our work_queue litter. */
const seenEventIds: string[] = [];

async function cleanup(): Promise<void> {
  for (const id of seenEventIds) {
    await db.execute(
      sql`DELETE FROM work_queue WHERE dedupe_key = ${`deal_stage_automation:${id}`}`,
    );
  }
  // Rules cascade their runs; deals cascade history/events (and their runs).
  await db.delete(dealAutomationRules).where(like(dealAutomationRules.name, `${RUN}%`));
  await db.delete(deals).where(like(deals.name, `${RUN}%`));
  await db.delete(dealStages).where(like(dealStages.name, `${RUN}%`));
  await db.delete(dealPipelines).where(like(dealPipelines.slug, `${RUN}%`));
  await db.execute(
    sql`DELETE FROM user_notifications WHERE user_id LIKE ${`${RUN}%`}`,
  );
  await db.execute(
    sql`DELETE FROM notification_deliveries WHERE dedupe_key LIKE ${`%${RUN}%`} OR trigger_actor_id LIKE ${`${RUN}%`}`,
  );
  // Kill-switch restore: the key did not exist before this suite (missing =
  // enabled) — pin back to absent, not to a value.
  await db.execute(
    sql`DELETE FROM system_settings WHERE key = ${DEAL_AUTOMATION_KILL_SWITCH_KEY}`,
  );
  await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${RUN}%`}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function eventForHistory(stageHistoryId: string) {
  const [row] = await db
    .select()
    .from(dealStageEvents)
    .where(eq(dealStageEvents.stageHistoryId, stageHistoryId))
    .limit(1);
  if (row) seenEventIds.push(row.id);
  return row ?? null;
}

async function runsForRule(ruleId: string) {
  return db
    .select()
    .from(dealAutomationRuns)
    .where(eq(dealAutomationRuns.ruleId, ruleId));
}

async function notificationCount(dedupeKey: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM user_notifications WHERE dedupe_key = ${dedupeKey}`,
  );
  return (res.rows[0] as { n: number }).n;
}

async function workQueueJobCount(eventId: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM work_queue WHERE dedupe_key = ${`deal_stage_automation:${eventId}`}`,
  );
  return (res.rows[0] as { n: number }).n;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let failures = 0;
  async function step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (err: any) {
      failures += 1;
      console.error(`FAIL - ${name}`);
      console.error(`  ${err?.message ?? err}`);
    }
  }

  await seed();
  const app = buildApp();
  const started = await listen(app);
  const server = started.server;
  baseUrl = started.baseUrl;

  const stagesBySlug = new Map<string, any>();
  let salesPipelineId = "";

  let ruleAll: any = null;      // discovery-call, all four actions
  let ruleFiltered: any = null; // discovery-call, only from proposal-sent
  let ruleDisabled: any = null; // new-opportunity, disabled
  let ruleCreation: any = null; // new-opportunity, notify owner
  let ruleKill: any = null;     // proposal-sent, notify (kill-switch probe)
  let ruleFail: any = null;     // negotiation, set_property ghost owner

  let dealA: any = null;
  let dealB: any = null;
  let evtCreationA: any = null;
  let evtDiscovery: any = null;

  try {
    await step("authz: 401 unauthenticated, 403 account_manager, 200 team_lead", async () => {
      actingUserId = null;
      assertEq((await api("GET", "/api/deal-automation/rules")).status, 401, "unauthed rules list");
      assertEq(
        (await api("POST", "/api/deal-automation/kill-switch", { enabled: false })).status,
        401,
        "unauthed kill switch",
      );
      actingUserId = AM_ID;
      assertEq((await api("GET", "/api/deal-automation/rules")).status, 403, "AM rules list");
      assertEq((await api("GET", "/api/deal-automation/runs")).status, 403, "AM runs list");
      assertEq((await api("GET", "/api/deal-automation/status")).status, 403, "AM status");
      assertEq(
        (await api("POST", "/api/deal-automation/kill-switch", { enabled: false })).status,
        403,
        "AM kill switch",
      );
      actingUserId = TL_ID;
      const ok = await api("GET", "/api/deal-automation/rules");
      assertEq(ok.status, 200, "TL rules list");
      assert(Array.isArray(ok.json), "rules list is an array");
    });

    await step("pipeline seed + stage handles", async () => {
      actingUserId = TL_ID;
      const res = await api("GET", "/api/deals/pipelines");
      assertEq(res.status, 200, "pipelines GET");
      const sales = (res.json as any[]).find((p) => p.slug === "sales");
      assert(sales, "seeded sales pipeline present");
      salesPipelineId = sales.id;
      for (const s of sales.stages) stagesBySlug.set(s.slug, s);
      assert(stagesBySlug.get("discovery-call"), "discovery-call stage present");
    });

    await step("rule validation: bad bodies 400 with reasons", async () => {
      actingUserId = TL_ID;
      const noUser = await api("POST", "/api/deal-automation/rules", {
        stageId: stagesBySlug.get("discovery-call").id,
        name: `${RUN} bad notify`,
        actions: [{ type: "notify", target: "user", title: "hi" }],
      });
      assertEq(noUser.status, 400, "notify target=user without userId 400");

      const selfFrom = await api("POST", "/api/deal-automation/rules", {
        stageId: stagesBySlug.get("discovery-call").id,
        fromStageId: stagesBySlug.get("discovery-call").id,
        name: `${RUN} self from`,
        actions: [{ type: "notify", target: "owner", title: "hi" }],
      });
      assertEq(selfFrom.status, 400, "fromStage === trigger stage 400");

      const [altPipeline] = await db
        .insert(dealPipelines)
        .values({ slug: `${RUN}-alt`, name: `${RUN} Alt`, isDefault: false, position: 98 })
        .returning();
      const [altStage] = await db
        .insert(dealStages)
        .values({
          pipelineId: altPipeline.id,
          slug: "alt-stage",
          name: `${RUN} Alt Stage`,
          position: 1,
          winProbability: 50,
          stageType: "open",
        })
        .returning();
      const crossPipeline = await api("POST", "/api/deal-automation/rules", {
        stageId: stagesBySlug.get("discovery-call").id,
        fromStageId: altStage.id,
        name: `${RUN} cross pipeline`,
        actions: [{ type: "notify", target: "owner", title: "hi" }],
      });
      assertEq(crossPipeline.status, 400, "cross-pipeline fromStage 400");

      const emptyActions = await api("POST", "/api/deal-automation/rules", {
        stageId: stagesBySlug.get("discovery-call").id,
        name: `${RUN} empty actions`,
        actions: [],
      });
      assertEq(emptyActions.status, 400, "empty actions 400");
    });

    await step("create rules (pipelineId derived server-side)", async () => {
      actingUserId = TL_ID;
      const all = await api("POST", "/api/deal-automation/rules", {
        stageId: stagesBySlug.get("discovery-call").id,
        name: `${RUN} all actions`,
        actions: [
          {
            type: "notify",
            target: "owner",
            title: "Deal {{deal_name}} entered {{stage_name}}",
            body: "From {{from_stage_name}} — client {{client_name}}",
          },
          { type: "set_property", property: "notes", value: `${RUN} automated note` },
          { type: "clickup_task", listId: "900100", nameTemplate: "Follow up on {{deal_name}}" },
          // NOTE: deal creation itself auto-advances the client to
          // 'opportunity' (lead-lifecycle behavior), so target the next
          // rung up — a real forward move proves the executor writes.
          { type: "advance_lifecycle", targetStage: "customer" },
        ],
      });
      assertEq(all.status, 201, "create all-actions rule");
      ruleAll = all.json;
      assertEq(ruleAll.pipelineId, salesPipelineId, "pipelineId derived from stage");
      assertEq(ruleAll.enabled, true, "enabled defaults true");

      const filtered = await api("POST", "/api/deal-automation/rules", {
        stageId: stagesBySlug.get("discovery-call").id,
        fromStageId: stagesBySlug.get("proposal-sent").id,
        name: `${RUN} from filter`,
        actions: [{ type: "notify", target: "owner", title: "backwards move" }],
      });
      assertEq(filtered.status, 201, "create from-filtered rule");
      ruleFiltered = filtered.json;

      const disabled = await api("POST", "/api/deal-automation/rules", {
        stageId: stagesBySlug.get("new-opportunity").id,
        name: `${RUN} disabled`,
        enabled: false,
        actions: [{ type: "notify", target: "owner", title: "should never fire" }],
      });
      assertEq(disabled.status, 201, "create disabled rule");
      ruleDisabled = disabled.json;

      const creation = await api("POST", "/api/deal-automation/rules", {
        stageId: stagesBySlug.get("new-opportunity").id,
        name: `${RUN} on create`,
        actions: [{ type: "notify", target: "owner", title: "New deal {{deal_name}}" }],
      });
      assertEq(creation.status, 201, "create creation rule");
      ruleCreation = creation.json;
    });

    await step("deal creation emits exactly one pending event + deduped queue job", async () => {
      actingUserId = AM_ID;
      const res = await api("POST", "/api/deals", {
        name: `${RUN} Deal A`,
        clientId: CLIENT_ID,
        amount: 5000,
        expectedCloseDate: FUTURE_CLOSE_DATE,
      });
      assertEq(res.status, 201, "create deal A");
      dealA = res.json;

      const detail = await api("GET", `/api/deals/${dealA.id}`);
      assertEq(detail.json.history.length, 1, "one creation history row");
      evtCreationA = await eventForHistory(detail.json.history[0].id);
      assert(evtCreationA, "event row keyed to the creation history row");
      assertEq(evtCreationA.status, "pending", "event starts pending");
      assertEq(evtCreationA.fromStageId, null, "creation event has null from");
      assertEq(
        evtCreationA.toStageId,
        stagesBySlug.get("new-opportunity").id,
        "creation event toStageId",
      );
      assertEq(evtCreationA.movedByUserId, AM_ID, "event actor stamped");
      assertEq(await workQueueJobCount(evtCreationA.id), 1, "one deduped work_queue job");
    });

    await step("creation event: unfiltered enabled rule fires, disabled rule never does", async () => {
      const summary = await processDealStageEvent(evtCreationA.id);
      assertEq(summary.outcome, "processed", "outcome");
      assertEq(summary.rulesMatched, 1, "only the enabled creation rule matches");
      assertEq(summary.runsSucceeded, 1, "one run succeeded");

      const creationRuns = await runsForRule(ruleCreation.id);
      assertEq(creationRuns.length, 1, "creation rule has one run");
      assertEq(creationRuns[0].status, "succeeded", "run succeeded");
      assertEq(creationRuns[0].dealName, `${RUN} Deal A`, "deal name snapshot");
      assertEq((await runsForRule(ruleDisabled.id)).length, 0, "disabled rule has zero runs");

      assertEq(
        await notificationCount(`deal_automation:${ruleCreation.id}:${evtCreationA.id}:0`),
        1,
        "owner notified once",
      );
      const titleRow = await db.execute(
        sql`SELECT title, category, user_id FROM user_notifications
            WHERE dedupe_key = ${`deal_automation:${ruleCreation.id}:${evtCreationA.id}:0`}`,
      );
      const notif = titleRow.rows[0] as { title: string; category: string; user_id: string };
      assertEq(notif.title, `New deal ${RUN} Deal A`, "template rendered into title");
      assertEq(notif.category, "crm", "crm category");
      assertEq(notif.user_id, AM_ID, "targeted at the deal owner");
    });

    await step("move fires the all-actions rule; from-filtered rule stays quiet", async () => {
      actingUserId = AM_ID;
      const move = await api("POST", `/api/deals/${dealA.id}/move`, {
        toStageId: stagesBySlug.get("discovery-call").id,
      });
      assertEq(move.status, 200, "move to discovery");
      evtDiscovery = await eventForHistory(move.json.historyEntry.id);
      assert(evtDiscovery, "event row keyed to the move history row");
      assertEq(
        evtDiscovery.fromStageId,
        stagesBySlug.get("new-opportunity").id,
        "event fromStageId",
      );

      const summary = await processDealStageEvent(evtDiscovery.id);
      assertEq(summary.outcome, "processed", "outcome");
      assertEq(summary.rulesMatched, 1, "from-filtered rule excluded (came from new-opportunity)");
      assertEq(summary.runsSucceeded, 1, "all-actions run succeeded");
      assertEq((await runsForRule(ruleFiltered.id)).length, 0, "from-filtered rule has zero runs");

      const [run] = await runsForRule(ruleAll.id);
      assert(run, "all-actions run row exists");
      assertEq(run.status, "succeeded", "run status");
      assert(run.finishedAt, "finishedAt stamped");
      const results = run.actionResults as any[];
      assertEq(results.length, 4, "four action results");
      assertEq(results[0].status, "succeeded", "notify succeeded");
      assertEq(results[1].status, "succeeded", "set_property succeeded");
      assertEq(results[2].status, "skipped", "clickup skipped (no connection)");
      assert(
        String(results[2].detail ?? "").includes("no ClickUp connection"),
        "clickup skip reason recorded",
      );
      assertEq(results[3].status, "succeeded", "advance_lifecycle succeeded");

      // Side effects actually landed:
      const [dealRow] = await db.select().from(deals).where(eq(deals.id, dealA.id));
      assertEq(dealRow.notes, `${RUN} automated note`, "set_property wrote the deal");
      const clientRow = await db.execute(
        sql`SELECT lifecycle_stage FROM clients WHERE id = ${CLIENT_ID}`,
      );
      assertEq(
        (clientRow.rows[0] as { lifecycle_stage: string }).lifecycle_stage,
        "customer",
        "client lifecycle advanced opportunity → customer",
      );
      const [evtRow] = await db
        .select()
        .from(dealStageEvents)
        .where(eq(dealStageEvents.id, evtDiscovery.id));
      assertEq(evtRow.status, "processed", "event flipped to processed");
      assert(evtRow.processedAt, "processedAt stamped");
    });

    await step("replays never duplicate: processed no-op + terminal run claim", async () => {
      const again = await processDealStageEvent(evtDiscovery.id);
      assertEq(again.outcome, "already_processed", "processed event no-ops");

      // Harsher replay: force the event back to pending (simulates a crash
      // AFTER runs finished but BEFORE the processed flip) — the terminal
      // (rule,event) run claim must swallow the re-fire.
      await db
        .update(dealStageEvents)
        .set({ status: "pending", processedAt: null })
        .where(eq(dealStageEvents.id, evtDiscovery.id));
      const replay = await processDealStageEvent(evtDiscovery.id);
      assertEq(replay.outcome, "processed", "replay completes");
      assertEq(replay.rulesMatched, 1, "rule still matches on replay");
      assertEq(replay.runsSucceeded, 0, "nothing re-executed");
      assertEq(replay.runsFailed, 0, "nothing failed");

      assertEq((await runsForRule(ruleAll.id)).length, 1, "still exactly one run row");
      assertEq(
        await notificationCount(`deal_automation:${ruleAll.id}:${evtDiscovery.id}:0`),
        1,
        "still exactly one notification",
      );
    });

    await step("kill switch: skipped runs recorded, nothing executes, flip is audited", async () => {
      actingUserId = TL_ID;
      const kill = await api("POST", "/api/deal-automation/kill-switch", { enabled: false });
      assertEq(kill.status, 200, "kill switch OFF");
      const status = await api("GET", "/api/deal-automation/status");
      assertEq(status.status, 200, "status GET");
      assertEq(status.json.enabled, false, "status reflects OFF");

      const killRule = await api("POST", "/api/deal-automation/rules", {
        stageId: stagesBySlug.get("proposal-sent").id,
        name: `${RUN} kill probe`,
        actions: [{ type: "notify", target: "owner", title: "should be skipped" }],
      });
      assertEq(killRule.status, 201, "create kill-probe rule");
      ruleKill = killRule.json;

      actingUserId = AM_ID;
      const move = await api("POST", `/api/deals/${dealA.id}/move`, {
        toStageId: stagesBySlug.get("proposal-sent").id,
      });
      assertEq(move.status, 200, "move to proposal-sent");
      const evt = await eventForHistory(move.json.historyEntry.id);
      assert(evt, "event emitted while switch is OFF");

      const summary = await processDealStageEvent(evt!.id);
      assertEq(summary.outcome, "killswitch", "killswitch outcome");
      assertEq(summary.runsSkipped, 1, "one visible skipped run");
      const [skipRun] = await runsForRule(ruleKill.id);
      assert(skipRun, "skipped run row exists");
      assertEq(skipRun.status, "skipped", "run status skipped");
      assertEq(skipRun.skipReason, "killswitch", "skip reason");
      assertEq(
        await notificationCount(`deal_automation:${ruleKill.id}:${evt!.id}:0`),
        0,
        "no notification sent while OFF",
      );

      actingUserId = TL_ID;
      assertEq(
        (await api("POST", "/api/deal-automation/kill-switch", { enabled: true })).status,
        200,
        "kill switch back ON",
      );
      assertEq(
        (await api("GET", "/api/deal-automation/status")).json.enabled,
        true,
        "status reflects ON",
      );
    });

    await step("failed action → failed run + run_failed delivery row", async () => {
      actingUserId = TL_ID;
      const failRule = await api("POST", "/api/deal-automation/rules", {
        stageId: stagesBySlug.get("negotiation").id,
        name: `${RUN} ghost owner`,
        actions: [
          { type: "set_property", property: "ownerId", value: `${RUN}-ghost` },
        ],
      });
      assertEq(failRule.status, 201, "create failing rule");
      ruleFail = failRule.json;

      actingUserId = AM_ID;
      const move = await api("POST", `/api/deals/${dealA.id}/move`, {
        toStageId: stagesBySlug.get("negotiation").id,
      });
      assertEq(move.status, 200, "move to negotiation");
      const evt = await eventForHistory(move.json.historyEntry.id);

      const summary = await processDealStageEvent(evt!.id);
      assertEq(summary.outcome, "processed", "outcome");
      assertEq(summary.runsFailed, 1, "one failed run");

      const [run] = await runsForRule(ruleFail.id);
      assertEq(run.status, "failed", "run recorded failed");
      assert(
        String(run.error ?? "").includes("not found"),
        `error names the cause (got: ${run.error})`,
      );
      const results = run.actionResults as any[];
      assertEq(results[0].status, "failed", "action result failed");

      // House alerting evidence: the dispatcher writes a delivery row even
      // when the channel is unconfigured (skipped_no_channel is dev-normal).
      const deliveries = await db.execute(
        sql`SELECT status FROM notification_deliveries
            WHERE notification_id = ${DEAL_AUTOMATION_RUN_FAILED_NOTIFICATION_ID}
              AND dedupe_key LIKE ${`%rule:${ruleFail.id}%`}`,
      );
      assert(
        deliveries.rows.length >= 1,
        "run_failed delivery row exists for this rule",
      );
      // Deal owner unchanged — the ghost write never landed.
      const [dealRow] = await db.select().from(deals).where(eq(deals.id, dealA.id));
      assertEq(dealRow.ownerId, AM_ID, "ghost owner write rejected");
    });

    await step("same-stage history rows never fire", async () => {
      const negotiation = stagesBySlug.get("negotiation").id;
      const hist = await db.execute(sql`
        INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, moved_by_user_id)
        VALUES (${dealA.id}, ${negotiation}, ${negotiation}, ${AM_ID})
        RETURNING id
      `);
      const histId = (hist.rows[0] as { id: string }).id;
      const evtRes = await db
        .insert(dealStageEvents)
        .values({
          stageHistoryId: histId,
          dealId: dealA.id,
          pipelineId: salesPipelineId,
          fromStageId: negotiation,
          toStageId: negotiation,
          movedByUserId: AM_ID,
        })
        .returning();
      seenEventIds.push(evtRes[0].id);

      const summary = await processDealStageEvent(evtRes[0].id);
      assertEq(summary.outcome, "same_stage", "same-stage outcome");
      assertEq((await runsForRule(ruleFail.id)).length, 1, "no extra run on the negotiation rule");
    });

    await step("requeue lever re-enqueues a pending event whose kick was lost", async () => {
      actingUserId = AM_ID;
      const res = await api("POST", "/api/deals", {
        name: `${RUN} Deal B`,
        clientId: CLIENT_ID,
        amount: 100,
      });
      assertEq(res.status, 201, "create deal B");
      dealB = res.json;
      const detail = await api("GET", `/api/deals/${dealB.id}`);
      const evt = await eventForHistory(detail.json.history[0].id);
      assert(evt, "deal B creation event exists");

      // Simulate the lost post-commit kick.
      await db.execute(
        sql`DELETE FROM work_queue WHERE dedupe_key = ${`deal_stage_automation:${evt!.id}`}`,
      );
      assertEq(await workQueueJobCount(evt!.id), 0, "kick lost");

      actingUserId = TL_ID;
      const requeue = await api("POST", "/api/deal-automation/events/requeue", {
        olderThanMs: 0,
      });
      assertEq(requeue.status, 200, "requeue POST");
      assert(requeue.json.requeued >= 1, `at least deal B's event requeued (${requeue.json.requeued})`);
      assertEq(await workQueueJobCount(evt!.id), 1, "job re-enqueued");

      // Drain it so no RUN event stays pending.
      const summary = await processDealStageEvent(evt!.id);
      assertEq(summary.outcome, "processed", "deal B creation processed");
    });

    await step("admin surface: stats, toggle, stageId immutability, filtered runs, delete", async () => {
      actingUserId = TL_ID;
      const list = await api("GET", "/api/deal-automation/rules");
      assertEq(list.status, 200, "rules list");
      const runRules = (list.json as any[]).filter((r) => r.name.startsWith(RUN));
      const allEntry = runRules.find((r) => r.id === ruleAll.id);
      assert(allEntry, "all-actions rule listed");
      assertEq(allEntry.stats.totalRuns, 1, "run count in stats");
      assertEq(allEntry.stats.lastRunStatus, "succeeded", "last run status");
      const failEntry = runRules.find((r) => r.id === ruleFail.id);
      assertEq(failEntry.stats.lastRunStatus, "failed", "failed rule surfaces failed status");

      // Toggle + write-boundary: a smuggled stageId must be stripped.
      const patch = await api("PATCH", `/api/deal-automation/rules/${ruleCreation.id}`, {
        enabled: false,
        stageId: stagesBySlug.get("negotiation").id,
      });
      assertEq(patch.status, 200, "patch rule");
      assertEq(patch.json.enabled, false, "toggle persisted");
      assertEq(
        patch.json.stageId,
        stagesBySlug.get("new-opportunity").id,
        "stageId untouched by PATCH (trigger stage is immutable)",
      );
      assertEq(patch.json.updatedBy, TL_ID, "updatedBy stamped");

      const runsFiltered = await api(
        "GET",
        `/api/deal-automation/runs?ruleId=${ruleAll.id}`,
      );
      assertEq(runsFiltered.status, 200, "filtered runs GET");
      assert(
        (runsFiltered.json as any[]).length >= 1 &&
          (runsFiltered.json as any[]).every((r) => r.ruleId === ruleAll.id),
        "runs filtered to the requested rule",
      );

      const del = await api("DELETE", `/api/deal-automation/rules/${ruleFiltered.id}`);
      assertEq(del.status, 200, "delete rule");
      const after = await api("GET", "/api/deal-automation/rules");
      assert(
        !(after.json as any[]).some((r) => r.id === ruleFiltered.id),
        "deleted rule gone from list",
      );
      assertEq(
        (await api("DELETE", `/api/deal-automation/rules/${ruleFiltered.id}`)).status,
        404,
        "double delete 404s",
      );
    });

    await step("template renderer: tokens + unknown-token passthrough", async () => {
      const ctx = {
        deal: { name: "Acme", amount: 12000 } as any,
        pipelineName: "Sales",
        stageName: "Negotiation",
        fromStageName: null,
        clientName: null,
        ownerName: "Jo",
      };
      assertEq(
        renderAutomationTemplate(
          "{{deal_name}}/{{stage_name}}/{{from_stage_name}}/{{client_name}}/{{amount}}/{{bogus_token}}",
          ctx,
        ),
        "Acme/Negotiation/(created)/(no client)/12000/{{bogus_token}}",
        "token rendering",
      );
    });
  } finally {
    server.closeAllConnections?.();
    server.close();
    await cleanup();
    // Route tests hang on undici keep-alive sockets otherwise.
    try {
      const { getGlobalDispatcher } = await import("undici");
      await getGlobalDispatcher().close();
    } catch {}
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll deal automation tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
let exitCode = 0;
main()
  .catch((err) => {
    console.error("deal-automation: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
