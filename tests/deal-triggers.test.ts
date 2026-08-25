/* test-registration
{
  "name": "Native deal auto-move triggers (Task #4332)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4332: first-party trigger events (booking confirmed / PandaDoc status / Front inbound reply) auto-move deals — replay safety is the whole contract: event_key INSERT…ON CONFLICT dedupe must make webhook/sync replays structurally single-shot (never double-move), moves must ride the standard stage-move path with movedBySource+triggerEventId attribution in history, ambiguity must skip visibly (multiple open deals, unlinked PandaDoc docs surface for manual linking) instead of guessing, per-hook toggles default OFF and are read fresh per event, and 3 consecutive hook failures must land a notification_deliveries row. A drift here silently double-moves deals on replays or moves the wrong deal.",
  "tier": "small"
}
test-registration */
/**
 * Task #4332 — native deal auto-move trigger coverage.
 *
 * Real registerDealsRoutes + registerDealAutomationRoutes on one Express
 * app with the requireAuth per-request test seam (__test_clerkUserId —
 * string authenticates as that users row, null is anonymous) against the
 * real db (hermetic per-run DB under `npm test`). Emitters are exercised
 * by calling emit*Trigger directly — exactly what the booking/PandaDoc/
 * Front taps call; processing is inline so the returned row is settled.
 *
 *   1. Authz — trigger surface is 401 unauthenticated, 403 account_manager,
 *      200 team_lead; GET returns all-OFF defaults.
 *   2. Hooks OFF — all three emitters return null and mint NO event rows.
 *   3. Config PUT — unknown booking slug 400; map to ghost stage 400;
 *      valid save round-trips through GET.
 *   4. Booking — single open deal moves to the configured stage through
 *      the standard move path: history row carries movedBySource +
 *      triggerEventId with a null mover, and a deal_stage_events row exists
 *      for the history row (stage automations plug in downstream).
 *   5. Replay — re-emitting the same meetingId returns null (ON CONFLICT
 *      dedupe): one event row, no second move.
 *   6. already_in_stage / forward-only (already_past_stage — a booking
 *      never yanks a deal backward) / multiple_open_deals skip / autoDealId
 *      short-circuit (deal_created — lead-intake already acted).
 *   7. Reprocess lever — a no_open_deal skip re-skips while unresolvable,
 *      succeeds after a deal exists, 409s once processed, 404s on ghosts.
 *   8. Events log — type/status filters.
 *   9. PandaDoc — unmapped status mints nothing; mapped status with no
 *      deal link skips no_deal_link and surfaces in the unlinked list;
 *      map edits apply on reprocess (no_mapping, fresh-read proof);
 *      linking auto-reprocesses into deal_moved; replays dedupe;
 *      already_in_stage on a second mapped status.
 *  10. Failure streak — 3 consecutive failures (required-fields violation:
 *      proposal-sent needs amount) land exactly one alerted
 *      notification_deliveries row keyed deal_triggers:<type>; the deal
 *      never moves.
 *  11. Front reply — reply_logged event, replay dedupe, recency gate
 *      (>14d mints nothing), toggle-off mints nothing.
 *
 * All fixtures are RUN-suffixed and asserts are scoped to fixture keys,
 * never totals. The five deal_triggers_* system_settings rows are removed
 * in finally (pin-to-absent restore — they did not exist before, missing =
 * every hook OFF).
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerDealsRoutes } from "../server/routes/deals";
import { registerDealAutomationRoutes } from "../server/routes/dealAutomation";
import {
  emitBookingConfirmedTrigger,
  emitFrontInboundReplyTrigger,
  emitPandadocStatusTrigger,
  FRONT_REPLY_RECENCY_DAYS,
} from "../server/services/dealTriggers";
import {
  dealStageEvents,
  dealTriggerEvents,
  deals,
  pandadocDocuments,
  DEAL_TRIGGERS_BOOKING_ENABLED_KEY,
  DEAL_TRIGGERS_BOOKING_STAGE_KEY,
  DEAL_TRIGGERS_FRONT_REPLY_ENABLED_KEY,
  DEAL_TRIGGERS_PANDADOC_ENABLED_KEY,
  DEAL_TRIGGERS_PANDADOC_STAGE_MAP_KEY,
} from "@shared/schema";

const HEX = randomBytes(4).toString("hex");
const RUN = `t4332-${HEX}`;

// Clock-derived so the payload dates never rot when the calendar passes a
// hardcoded literal (Task #4433; see tests/save-plays.test.ts dueIn pattern).
// Kept distinct so deal A and deal B stay distinguishable by close date.
const daysFromNowIso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const FUTURE_CLOSE_A = daysFromNowIso(45);
const FUTURE_CLOSE_B = daysFromNowIso(75);

const TL_ID = `${RUN}-tl`; // team_lead → manages trigger config
const AM_ID = `${RUN}-am`; // account_manager → creates/owns deals
const CLIENT_A = `${RUN}-client-a`;
const CLIENT_B = `${RUN}-client-b`;

/** Fixed by design (not fixture-scoped) — the per-hook alert dedupe keys. */
const ALERT_DEDUPE_KEYS = [
  "deal_triggers:booking_confirmed",
  "deal_triggers:pandadoc_status_changed",
  "deal_triggers:front_inbound_reply",
];

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
      (${TL_ID}, ${`${TL_ID}@t4332.example`}, 'Task4332', 'Lead', 'team_lead', 'lead'),
      (${AM_ID}, ${`${AM_ID}@t4332.example`}, 'Task4332', 'Owner', 'account_manager', 'core')
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES
      (${CLIENT_A}, ${`${RUN} Firm A`}, ${AM_ID}, false, false),
      (${CLIENT_B}, ${`${RUN} Firm B`}, ${AM_ID}, false, false)
  `);
}

async function seedPandadocDoc(documentId: string, status: string): Promise<string> {
  const res = await db
    .insert(pandadocDocuments)
    .values({
      documentId,
      title: `${RUN} ${documentId}`,
      status,
      linkedClientId: CLIENT_A,
    })
    .returning({ id: pandadocDocuments.id });
  return res[0].id;
}

async function cleanup(): Promise<void> {
  // Stage moves feed the #4331 automation queue — prune our work_queue litter
  // (dedupe key is deal_stage_automation:<stage event id>).
  const evts = await db.execute(sql`
    SELECT dse.id FROM deal_stage_events dse
    JOIN deals d ON d.id = dse.deal_id
    WHERE d.name LIKE ${`${RUN}%`}
  `);
  for (const row of evts.rows as Array<{ id: string }>) {
    await db.execute(
      sql`DELETE FROM work_queue WHERE dedupe_key = ${`deal_stage_automation:${row.id}`}`,
    );
  }
  // Every event key embeds a RUN-suffixed source id (meeting/document/conv).
  await db.delete(dealTriggerEvents).where(like(dealTriggerEvents.eventKey, `%${RUN}%`));
  await db.delete(pandadocDocuments).where(like(pandadocDocuments.documentId, `${RUN}%`));
  await db.delete(deals).where(like(deals.name, `${RUN}%`));
  for (const key of ALERT_DEDUPE_KEYS) {
    await db.execute(sql`DELETE FROM user_notifications WHERE dedupe_key = ${key}`);
    await db.execute(sql`DELETE FROM notification_deliveries WHERE dedupe_key = ${key}`);
  }
  // Pin-to-absent restore: the keys did not exist before this suite ran
  // (missing = hook OFF). Settings rows FK users via updated_by — delete
  // before the fixture users.
  for (const key of [
    DEAL_TRIGGERS_BOOKING_ENABLED_KEY,
    DEAL_TRIGGERS_BOOKING_STAGE_KEY,
    DEAL_TRIGGERS_PANDADOC_ENABLED_KEY,
    DEAL_TRIGGERS_PANDADOC_STAGE_MAP_KEY,
    DEAL_TRIGGERS_FRONT_REPLY_ENABLED_KEY,
  ]) {
    await db.execute(sql`DELETE FROM system_settings WHERE key = ${key}`);
  }
  await db.execute(sql`DELETE FROM clients WHERE id IN (${CLIENT_A}, ${CLIENT_B})`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${RUN}%`}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function eventRowsForKey(eventKey: string) {
  return db.select().from(dealTriggerEvents).where(eq(dealTriggerEvents.eventKey, eventKey));
}

async function historyFor(dealId: string): Promise<any[]> {
  const detail = await api("GET", `/api/deals/${dealId}`);
  assertEq(detail.status, 200, `deal detail GET ${dealId}`);
  return detail.json.history as any[];
}

async function alertDeliveryCount(dedupeKey: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM notification_deliveries WHERE dedupe_key = ${dedupeKey}`,
  );
  return (res.rows[0] as { n: number }).n;
}

const CONFIG_PATH = "/api/deal-automation/triggers/config";
const EVENTS_PATH = "/api/deal-automation/triggers/events";

/** The map used by most steps: two statuses → discovery-call (no required
 * fields), one → proposal-sent (requires amount — the failure lever). */
const FULL_MAP = {
  "document.completed": "discovery-call",
  "document.paid": "discovery-call",
  "document.approved": "proposal-sent",
};

function configBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    bookingEnabled: true,
    bookingStageSlug: "discovery-call",
    pandadocEnabled: true,
    pandadocStageMap: FULL_MAP,
    frontReplyEnabled: true,
    ...overrides,
  };
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

  let dealA: any = null; // CLIENT_A, amount 5000 — booking happy path
  let dealB: any = null; // CLIENT_A, amount 7000 — multi-open + pandadoc link
  let dealC: any = null; // CLIENT_B, NO amount — reprocess lever + failure streak
  let bookingEvt: any = null; // mtg-1 deal_moved event (reprocess-409 probe)
  let noDealEvt: any = null; // mtg-6 no_open_deal skip (reprocess lever)
  let pd1RowId = ""; // document.completed doc — link flow
  let pd1Evt: any = null;

  try {
    await step("authz: 401 unauthenticated, 403 account_manager, 200 team_lead + defaults", async () => {
      actingUserId = null;
      assertEq((await api("GET", CONFIG_PATH)).status, 401, "unauthed config GET");
      actingUserId = AM_ID;
      assertEq((await api("GET", CONFIG_PATH)).status, 403, "AM config GET");
      assertEq((await api("PUT", CONFIG_PATH, configBody())).status, 403, "AM config PUT");
      assertEq((await api("GET", EVENTS_PATH)).status, 403, "AM events GET");
      assertEq(
        (await api("POST", `${EVENTS_PATH}/${randomUUID()}/reprocess`)).status,
        403,
        "AM reprocess",
      );
      assertEq(
        (await api("GET", "/api/deal-automation/triggers/pandadoc/unlinked")).status,
        403,
        "AM unlinked GET",
      );
      actingUserId = TL_ID;
      const res = await api("GET", CONFIG_PATH);
      assertEq(res.status, 200, "TL config GET");
      assertEq(res.json.config.bookingEnabled, false, "booking defaults OFF");
      assertEq(res.json.config.pandadocEnabled, false, "pandadoc defaults OFF");
      assertEq(res.json.config.frontReplyEnabled, false, "front reply defaults OFF");
      assertEq(res.json.config.bookingStageSlug, "discovery-call", "default booking stage");
      assertEq(
        Object.keys(res.json.config.pandadocStageMap).length,
        0,
        "default map empty",
      );
      assert(
        Array.isArray(res.json.knownPandadocStatuses) &&
          res.json.knownPandadocStatuses.includes("document.completed"),
        "known statuses shipped for the UI",
      );
    });

    await step("pipeline seed + stage handles", async () => {
      actingUserId = TL_ID;
      const res = await api("GET", "/api/deals/pipelines");
      assertEq(res.status, 200, "pipelines GET");
      const sales = (res.json as any[]).find((p) => p.slug === "sales");
      assert(sales, "seeded sales pipeline present");
      for (const s of sales.stages) stagesBySlug.set(s.slug, s);
      assert(stagesBySlug.get("discovery-call"), "discovery-call stage present");
      assert(stagesBySlug.get("proposal-sent"), "proposal-sent stage present");
    });

    await step("hooks OFF: emitters return null and mint no event rows", async () => {
      const booking = await emitBookingConfirmedTrigger({
        meetingId: `${RUN}-mtg-0`,
        meetingTypeName: "Intro",
        clientId: CLIENT_A,
        autoDealId: null,
      });
      assertEq(booking, null, "booking emit while OFF");
      const pandadoc = await emitPandadocStatusTrigger({
        docRowId: randomUUID(),
        documentId: `${RUN}-pd-0`,
        title: "off-gate",
        oldStatus: null,
        newStatus: "document.completed",
        linkedDealId: null,
        linkedClientId: CLIENT_A,
      });
      assertEq(pandadoc, null, "pandadoc emit while OFF");
      const front = await emitFrontInboundReplyTrigger({
        conversationId: `${RUN}-conv-0`,
        messageId: `${RUN}-msg-0`,
        clientId: CLIENT_A,
        receivedAt: new Date(),
      });
      assertEq(front, null, "front emit while OFF");
      const rows = await db
        .select({ id: dealTriggerEvents.id })
        .from(dealTriggerEvents)
        .where(like(dealTriggerEvents.eventKey, `%${RUN}%`));
      assertEq(rows.length, 0, "no event rows minted while every hook is OFF");
    });

    await step("config PUT: stage validation 400s, valid config round-trips", async () => {
      actingUserId = TL_ID;
      const badSlug = await api("PUT", CONFIG_PATH, configBody({ bookingStageSlug: "no-such-stage" }));
      assertEq(badSlug.status, 400, "unknown booking stage slug rejected");
      const badMap = await api(
        "PUT",
        CONFIG_PATH,
        configBody({ pandadocStageMap: { "document.completed": "ghost-stage" } }),
      );
      assertEq(badMap.status, 400, "map to unknown stage rejected");
      const ok = await api("PUT", CONFIG_PATH, configBody());
      assertEq(ok.status, 200, "valid config saved");
      const back = await api("GET", CONFIG_PATH);
      assertEq(back.json.config.bookingEnabled, true, "booking enabled persisted");
      assertEq(back.json.config.pandadocEnabled, true, "pandadoc enabled persisted");
      assertEq(back.json.config.frontReplyEnabled, true, "front reply enabled persisted");
      assertEq(
        back.json.config.pandadocStageMap["document.approved"],
        "proposal-sent",
        "stage map persisted",
      );
    });

    await step("booking: single open deal moves with source attribution", async () => {
      actingUserId = AM_ID;
      const res = await api("POST", "/api/deals", {
        name: `${RUN} Deal A`,
        clientId: CLIENT_A,
        amount: 5000,
        expectedCloseDate: FUTURE_CLOSE_A,
      });
      assertEq(res.status, 201, "create deal A");
      dealA = res.json;
      assertEq(dealA.stageId, stagesBySlug.get("new-opportunity").id, "deal A starts in new-opportunity");

      bookingEvt = await emitBookingConfirmedTrigger({
        meetingId: `${RUN}-mtg-1`,
        meetingTypeName: "High Impact Revenue Session",
        clientId: CLIENT_A,
        autoDealId: null,
      });
      assert(bookingEvt, "booking emit returned the settled event");
      assertEq(bookingEvt.status, "processed", "event processed");
      assertEq(bookingEvt.outcome, "deal_moved", "outcome deal_moved");
      assertEq(bookingEvt.dealId, dealA.id, "event resolved to deal A");
      assert(bookingEvt.stageHistoryId, "event carries the history row id");

      const history = await historyFor(dealA.id);
      const moveRow = history.find((h) => h.triggerEventId === bookingEvt.id);
      assert(moveRow, "history row attributed to the trigger event");
      assertEq(moveRow.toStageId, stagesBySlug.get("discovery-call").id, "moved to discovery-call");
      assertEq(moveRow.movedBySource, "booking_confirmed", "movedBySource stamped");
      assertEq(moveRow.movedByUserId, null, "no human mover on an auto-move");

      // Standard stage-move path — the #4331 automation substrate saw it.
      const stageEvts = await db
        .select({ id: dealStageEvents.id })
        .from(dealStageEvents)
        .where(eq(dealStageEvents.stageHistoryId, bookingEvt.stageHistoryId));
      assertEq(stageEvts.length, 1, "stage automation event exists for the auto-move");
    });

    await step("booking replay: same meetingId dedupes, no second move", async () => {
      const replay = await emitBookingConfirmedTrigger({
        meetingId: `${RUN}-mtg-1`,
        meetingTypeName: "High Impact Revenue Session",
        clientId: CLIENT_A,
        autoDealId: null,
      });
      assertEq(replay, null, "replay emit returns null");
      const rows = await eventRowsForKey(`booking_confirmed:${RUN}-mtg-1`);
      assertEq(rows.length, 1, "exactly one event row for the key");
      const history = await historyFor(dealA.id);
      assertEq(history.length, 2, "creation + one move — replay added nothing");
    });

    await step("booking: already_in_stage and forward-only (already_past_stage)", async () => {
      const inStage = await emitBookingConfirmedTrigger({
        meetingId: `${RUN}-mtg-2`,
        clientId: CLIENT_A,
        autoDealId: null,
      });
      assertEq(inStage?.status, "processed", "already-in-stage event processed");
      assertEq(inStage?.outcome, "already_in_stage", "outcome already_in_stage");

      actingUserId = AM_ID;
      const move = await api("POST", `/api/deals/${dealA.id}/move`, {
        toStageId: stagesBySlug.get("proposal-sent").id,
      });
      assertEq(move.status, 200, "manual move to proposal-sent");

      const past = await emitBookingConfirmedTrigger({
        meetingId: `${RUN}-mtg-3`,
        clientId: CLIENT_A,
        autoDealId: null,
      });
      assertEq(past?.status, "processed", "past-stage event processed");
      assertEq(past?.outcome, "already_past_stage", "outcome already_past_stage");
      const detail = await api("GET", `/api/deals/${dealA.id}`);
      assertEq(
        detail.json.stageId,
        stagesBySlug.get("proposal-sent").id,
        "booking never yanks the deal backward",
      );
    });

    await step("booking: multiple open deals skip + autoDealId short-circuit", async () => {
      actingUserId = AM_ID;
      const res = await api("POST", "/api/deals", {
        name: `${RUN} Deal B`,
        clientId: CLIENT_A,
        amount: 7000,
        expectedCloseDate: FUTURE_CLOSE_B,
      });
      assertEq(res.status, 201, "create deal B");
      dealB = res.json;

      const multi = await emitBookingConfirmedTrigger({
        meetingId: `${RUN}-mtg-4`,
        clientId: CLIENT_A,
        autoDealId: null,
      });
      assertEq(multi?.status, "skipped", "two open deals → skipped");
      assertEq(multi?.outcome, "multiple_open_deals", "outcome multiple_open_deals");

      const auto = await emitBookingConfirmedTrigger({
        meetingId: `${RUN}-mtg-5`,
        clientId: CLIENT_A,
        autoDealId: dealB.id,
      });
      assertEq(auto?.status, "processed", "auto-deal event processed");
      assertEq(auto?.outcome, "deal_created", "lead-intake already acted — recorded, not re-moved");
      const detail = await api("GET", `/api/deals/${dealB.id}`);
      assertEq(
        detail.json.stageId,
        stagesBySlug.get("new-opportunity").id,
        "deal B untouched by the deal_created event",
      );
    });

    await step("reprocess lever: re-skip → succeed → 409 when processed → 404 ghost", async () => {
      noDealEvt = await emitBookingConfirmedTrigger({
        meetingId: `${RUN}-mtg-6`,
        clientId: CLIENT_B,
        autoDealId: null,
      });
      assertEq(noDealEvt?.status, "skipped", "no deals for client B → skipped");
      assertEq(noDealEvt?.outcome, "no_open_deal", "outcome no_open_deal");

      actingUserId = TL_ID;
      const still = await api("POST", `${EVENTS_PATH}/${noDealEvt.id}/reprocess`);
      assertEq(still.status, 200, "reprocess claim on a skipped event");
      assertEq(still.json.status, "skipped", "still unresolvable — re-skips");

      actingUserId = AM_ID;
      const res = await api("POST", "/api/deals", {
        name: `${RUN} Deal C`,
        clientId: CLIENT_B,
      });
      assertEq(res.status, 201, "create deal C (no amount — failure lever later)");
      dealC = res.json;

      actingUserId = TL_ID;
      const ok = await api("POST", `${EVENTS_PATH}/${noDealEvt.id}/reprocess`);
      assertEq(ok.status, 200, "reprocess after a deal exists");
      assertEq(ok.json.status, "processed", "reprocessed to processed");
      assertEq(ok.json.outcome, "deal_moved", "reprocess moved the deal");
      const detail = await api("GET", `/api/deals/${dealC.id}`);
      assertEq(detail.json.stageId, stagesBySlug.get("discovery-call").id, "deal C moved");

      assertEq(
        (await api("POST", `${EVENTS_PATH}/${bookingEvt.id}/reprocess`)).status,
        409,
        "processed events are not reprocessable",
      );
      assertEq(
        (await api("POST", `${EVENTS_PATH}/${randomUUID()}/reprocess`)).status,
        404,
        "ghost event 404s",
      );
    });

    await step("events log: type/status filters", async () => {
      actingUserId = TL_ID;
      const byType = await api("GET", `${EVENTS_PATH}?type=booking_confirmed&limit=100`);
      assertEq(byType.status, 200, "events by type GET");
      assert(
        (byType.json as any[]).every((e) => e.triggerType === "booking_confirmed"),
        "type filter applied",
      );
      const ourKeys = (byType.json as any[]).filter((e) => String(e.eventKey).includes(RUN));
      assert(ourKeys.length >= 6, `our booking events in the log (got ${ourKeys.length})`);

      const skipped = await api(
        "GET",
        `${EVENTS_PATH}?type=booking_confirmed&status=skipped&limit=100`,
      );
      const ourSkips = (skipped.json as any[]).filter((e) => String(e.eventKey).includes(RUN));
      assert(
        ourSkips.some((e) => e.outcome === "multiple_open_deals"),
        "status filter surfaces the multi-deal skip",
      );
      assert(
        ourSkips.every((e) => e.status === "skipped"),
        "status filter applied",
      );
    });

    await step("pandadoc: unmapped status mints nothing", async () => {
      const res = await emitPandadocStatusTrigger({
        docRowId: randomUUID(),
        documentId: `${RUN}-pd-viewed`,
        title: "viewed doc",
        oldStatus: "document.sent",
        newStatus: "document.viewed",
        linkedDealId: null,
        linkedClientId: CLIENT_A,
      });
      assertEq(res, null, "unmapped status → no event");
      const rows = await eventRowsForKey(`pandadoc_status:${RUN}-pd-viewed:document.viewed`);
      assertEq(rows.length, 0, "no row minted for unmapped status");
    });

    await step("pandadoc: no_deal_link skip + unlinked surface + map freshness on reprocess", async () => {
      pd1RowId = await seedPandadocDoc(`${RUN}-pd-1`, "document.completed");
      pd1Evt = await emitPandadocStatusTrigger({
        docRowId: pd1RowId,
        documentId: `${RUN}-pd-1`,
        title: `${RUN} pd-1`,
        oldStatus: "document.sent",
        newStatus: "document.completed",
        linkedDealId: null,
        linkedClientId: CLIENT_A,
      });
      assertEq(pd1Evt?.status, "skipped", "unlinked doc → skipped");
      assertEq(pd1Evt?.outcome, "no_deal_link", "outcome no_deal_link");

      actingUserId = TL_ID;
      const unlinked = await api("GET", "/api/deal-automation/triggers/pandadoc/unlinked");
      assertEq(unlinked.status, 200, "unlinked list GET");
      assert(
        (unlinked.json as any[]).some((d) => d.id === pd1RowId),
        "doc surfaces for manual linking",
      );

      // Config is read fresh per event: drop the completed mapping and the
      // SAME event reprocesses to no_mapping, restore and it re-skips
      // no_deal_link (the outcome the link flow keys on).
      const withoutCompleted = { "document.approved": "proposal-sent" };
      assertEq(
        (await api("PUT", CONFIG_PATH, configBody({ pandadocStageMap: withoutCompleted }))).status,
        200,
        "map without completed saved",
      );
      const noMap = await api("POST", `${EVENTS_PATH}/${pd1Evt.id}/reprocess`);
      assertEq(noMap.json.outcome, "no_mapping", "map edit applied on reprocess (fresh read)");
      assertEq(
        (await api("PUT", CONFIG_PATH, configBody())).status,
        200,
        "full map restored",
      );
      const reSkip = await api("POST", `${EVENTS_PATH}/${pd1Evt.id}/reprocess`);
      assertEq(reSkip.json.outcome, "no_deal_link", "back to no_deal_link after restore");
    });

    await step("pandadoc: linking auto-reprocesses into deal_moved with attribution", async () => {
      actingUserId = TL_ID;
      const badDeal = await api(
        "POST",
        `/api/deal-automation/triggers/pandadoc/${pd1RowId}/link-deal`,
        { dealId: "no-such-deal" },
      );
      assertEq(badDeal.status, 400, "ghost deal link rejected");

      const link = await api(
        "POST",
        `/api/deal-automation/triggers/pandadoc/${pd1RowId}/link-deal`,
        { dealId: dealB.id },
      );
      assertEq(link.status, 200, "link-deal");
      assertEq(link.json.document.linkedDealId, dealB.id, "link persisted");
      assertEq(link.json.reprocessedEvent?.status, "processed", "skip auto-reprocessed");
      assertEq(link.json.reprocessedEvent?.outcome, "deal_moved", "reprocess moved the deal");

      const detail = await api("GET", `/api/deals/${dealB.id}`);
      assertEq(detail.json.stageId, stagesBySlug.get("discovery-call").id, "deal B moved");
      const moveRow = (detail.json.history as any[]).find(
        (h) => h.triggerEventId === pd1Evt.id,
      );
      assert(moveRow, "history attributed to the pandadoc event");
      assertEq(moveRow.movedBySource, "pandadoc_status_changed", "movedBySource stamped");
      assertEq(moveRow.movedByUserId, null, "no human mover");

      const unlinked = await api("GET", "/api/deal-automation/triggers/pandadoc/unlinked");
      assert(
        !(unlinked.json as any[]).some((d) => d.id === pd1RowId),
        "linked doc left the review list",
      );
    });

    await step("pandadoc: replay dedupes, second mapped status is already_in_stage", async () => {
      const replay = await emitPandadocStatusTrigger({
        docRowId: pd1RowId,
        documentId: `${RUN}-pd-1`,
        title: `${RUN} pd-1`,
        oldStatus: "document.sent",
        newStatus: "document.completed",
        linkedDealId: dealB.id,
        linkedClientId: CLIENT_A,
      });
      assertEq(replay, null, "sync re-observation dedupes");
      const rows = await eventRowsForKey(`pandadoc_status:${RUN}-pd-1:document.completed`);
      assertEq(rows.length, 1, "one event row for the key");
      const history = await historyFor(dealB.id);
      assertEq(history.length, 2, "creation + one move — replay added nothing");

      const paid = await emitPandadocStatusTrigger({
        docRowId: pd1RowId,
        documentId: `${RUN}-pd-1`,
        title: `${RUN} pd-1`,
        oldStatus: "document.completed",
        newStatus: "document.paid",
        linkedDealId: dealB.id,
        linkedClientId: CLIENT_A,
      });
      assertEq(paid?.status, "processed", "distinct status mints a new event");
      assertEq(paid?.outcome, "already_in_stage", "same target stage → already_in_stage");
    });

    await step("failure streak: 3 consecutive failures land one alert delivery", async () => {
      const dedupeKey = "deal_triggers:pandadoc_status_changed";
      assertEq(await alertDeliveryCount(dedupeKey), 0, "no alert before any failure");

      actingUserId = TL_ID;
      for (let i = 2; i <= 4; i++) {
        const rowId = await seedPandadocDoc(`${RUN}-pd-${i}`, "document.approved");
        const linked = await api(
          "POST",
          `/api/deal-automation/triggers/pandadoc/${rowId}/link-deal`,
          { dealId: dealC.id },
        );
        assertEq(linked.status, 200, `link pd-${i} to amount-less deal C`);

        const evt = await emitPandadocStatusTrigger({
          docRowId: rowId,
          documentId: `${RUN}-pd-${i}`,
          title: `${RUN} pd-${i}`,
          oldStatus: "document.sent",
          newStatus: "document.approved",
          linkedDealId: dealC.id,
          linkedClientId: CLIENT_B,
        });
        assertEq(evt?.status, "failed", `pd-${i} move fails (proposal-sent requires amount)`);
        assert(evt?.error, `pd-${i} failure recorded an error`);
        if (i < 4) {
          assertEq(await alertDeliveryCount(dedupeKey), 0, `no alert at streak ${i - 1}`);
        }
      }
      assert(
        (await alertDeliveryCount(dedupeKey)) >= 1,
        "streak of 3 landed a notification_deliveries row",
      );
      const detail = await api("GET", `/api/deals/${dealC.id}`);
      assertEq(
        detail.json.stageId,
        stagesBySlug.get("discovery-call").id,
        "failed moves never touched the deal",
      );
    });

    await step("front reply: reply_logged + replay dedupe + recency gate + toggle off", async () => {
      const evt = await emitFrontInboundReplyTrigger({
        conversationId: `${RUN}-conv-1`,
        messageId: `${RUN}-msg-1`,
        clientId: CLIENT_A,
        receivedAt: new Date(),
        subject: "Re: proposal",
      });
      assertEq(evt?.status, "processed", "reply event processed");
      assertEq(evt?.outcome, "reply_logged", "outcome reply_logged");
      assertEq(evt?.eventKey, `front_reply:${RUN}-conv-1:${RUN}-msg-1`, "event key shape");

      const replay = await emitFrontInboundReplyTrigger({
        conversationId: `${RUN}-conv-1`,
        messageId: `${RUN}-msg-1`,
        clientId: CLIENT_A,
        receivedAt: new Date(),
      });
      assertEq(replay, null, "unchanged latest inbound message dedupes");
      const rows = await eventRowsForKey(`front_reply:${RUN}-conv-1:${RUN}-msg-1`);
      assertEq(rows.length, 1, "one event row for the reply");

      const stale = await emitFrontInboundReplyTrigger({
        conversationId: `${RUN}-conv-1`,
        messageId: `${RUN}-msg-old`,
        clientId: CLIENT_A,
        receivedAt: new Date(Date.now() - (FRONT_REPLY_RECENCY_DAYS + 6) * 24 * 60 * 60 * 1000),
      });
      assertEq(stale, null, "historical sweep replies never mint events");
      assertEq(
        (await eventRowsForKey(`front_reply:${RUN}-conv-1:${RUN}-msg-old`)).length,
        0,
        "no row for the stale reply",
      );

      actingUserId = TL_ID;
      assertEq(
        (await api("PUT", CONFIG_PATH, configBody({ frontReplyEnabled: false }))).status,
        200,
        "front hook toggled off",
      );
      const off = await emitFrontInboundReplyTrigger({
        conversationId: `${RUN}-conv-2`,
        messageId: `${RUN}-msg-2`,
        clientId: CLIENT_A,
        receivedAt: new Date(),
      });
      assertEq(off, null, "toggle off gates the emitter");
      assertEq(
        (await eventRowsForKey(`front_reply:${RUN}-conv-2:${RUN}-msg-2`)).length,
        0,
        "no row while OFF",
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
  console.log("\nAll deal trigger tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
let exitCode = 0;
main()
  .catch((err) => {
    console.error("deal-triggers: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
