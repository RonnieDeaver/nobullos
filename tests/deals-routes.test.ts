/* test-registration
{
  "name": "Deals pipeline API (Task #4327)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4327: deals pipeline foundation — the stage-move contract (stage changes ONLY via POST /move writing deal_stage_history atomically; PATCH cannot touch stageId), the required-fields-on-entry 422 gate with field-overlay persistence, lazy default-pipeline seed idempotence, sales-role scoping (owner forced to self, list filtered, foreign detail/delete 403), contact↔client integrity, cross-pipeline move rejection, and team_lead-gated stage configuration. A drift here silently corrupts the stage history every later CRM feature (automations, scoring, attribution) hangs off, or lets a sales user read or reassign deals outside their book.",
  "tier": "small"
}
test-registration */
/**
 * Task #4327 — Deals pipeline route coverage.
 *
 * Runs the REAL registerDealsRoutes against a real Express app with an
 * injected passport-shaped session (switchable acting user, following
 * tests/client-files-routes.test.ts) and the real db (hermetic per-run DB
 * under `npm test`).
 *
 *   1. Authn — 401 unauthenticated on list and create.
 *   2. Seeding — GET /api/deals/pipelines lazily seeds EXACTLY one 'sales'
 *      pipeline with the 6 ordered stages; a second call is a no-op.
 *   3. Create — AM-created deal lands in the first open stage with a
 *      creation history row (fromStageId null) and its contacts attached;
 *      bad bodies 400; a contact belonging to another client 400s.
 *   4. Sales scoping — owner forced to self on create (even when the body
 *      names someone else), board list filtered to own deals, foreign deal
 *      detail 403, owner reassignment attempt 403.
 *   5. Moves — happy path updates stage + stamps stageEnteredAt and writes
 *      the history row (who/when); a stage with unmet requiredFields
 *      answers 422 {missingFields} and the retry WITH fields persists them
 *      (amount overlay, lost_reason on closed-lost); a stage from another
 *      pipeline 400s; PATCH with a smuggled stageId leaves the stage
 *      untouched (write-boundary proof).
 *   6. Stage config — POST/PATCH stages are team_lead-gated (AM 403);
 *      created stage appends at the end (max position + 1); an unknown
 *      requiredFields key 400s.
 *   7. Client entry point — /api/clients/:id/deals honors client access
 *      (sales non-owner 403, sales owner 200).
 *   8. Delete — non-owner sales 403; owner deletes own deal.
 *
 * All fixtures are RUN-suffixed and removed in finally; list assertions
 * filter to RUN-prefixed names, never totals (shared-DB hygiene). The
 * seeded 'sales' pipeline is left in place — it IS the lazy-ensure global.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerDealsRoutes } from "../server/routes/deals";
import { dealPipelines, dealStages, deals } from "@shared/schema";

const HEX = randomBytes(4).toString("hex");
const RUN = `t4327-${HEX}`;

// Clock-derived so the payload date never rots when the calendar passes a
// hardcoded literal (Task #4433; see tests/save-plays.test.ts dueIn pattern).
const FUTURE_CLOSE_DATE = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);

const AM_ID = `${RUN}-am`;      // account_manager → sees all deals
const TL_ID = `${RUN}-tl`;      // team_lead → stage config
const SALES_ID = `${RUN}-sales`; // sales role, owns client C_B
const SALES2_ID = `${RUN}-s2`;  // sales role, owns nothing

const C_A = `${RUN}-client-a`; // owned by AM
const C_B = `${RUN}-client-b`; // owned by SALES

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ── Harness ─────────────────────────────────────────────────────────────────

let actingUserId: string | null = AM_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated.
    // (The pre-Clerk passport-shape injection stopped working when auth
    // migrated — requireAuth ignores req.user/req.isAuthenticated.)
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerDealsRoutes(app);
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

let contactA = ""; // belongs to C_A
let contactB = ""; // belongs to C_B

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${AM_ID}, ${`${AM_ID}@t4327.example`}, 'Task4327', 'Manager', 'account_manager', 'core'),
      (${TL_ID}, ${`${TL_ID}@t4327.example`}, 'Task4327', 'Lead', 'team_lead', 'lead'),
      (${SALES_ID}, ${`${SALES_ID}@t4327.example`}, 'Task4327', 'Seller', 'sales', 'core'),
      (${SALES2_ID}, ${`${SALES2_ID}@t4327.example`}, 'Task4327', 'Other', 'sales', 'core')
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES
      (${C_A}, ${`${RUN} Firm A`}, ${AM_ID}, false, false),
      (${C_B}, ${`${RUN} Firm B`}, ${SALES_ID}, false, false)
  `);
  const contactRows = await db.execute(sql`
    INSERT INTO client_contacts (client_id, name, is_primary)
    VALUES
      (${C_A}, ${`${RUN} Contact A`}, true),
      (${C_B}, ${`${RUN} Contact B`}, false)
    RETURNING id, client_id
  `);
  for (const row of contactRows.rows as { id: string; client_id: string }[]) {
    if (row.client_id === C_A) contactA = row.id;
    else contactB = row.id;
  }
}

async function cleanup(): Promise<void> {
  // Deal deletes cascade deal_contacts + deal_stage_history.
  await db.delete(deals).where(like(deals.name, `${RUN}%`));
  // RUN-created stages on the seeded pipeline (POST test) + alt pipeline.
  await db.delete(dealStages).where(like(dealStages.name, `${RUN}%`));
  await db.delete(dealPipelines).where(like(dealPipelines.slug, `${RUN}%`));
  // Clients cascade contacts.
  await db.execute(sql`DELETE FROM clients WHERE id IN (${C_A}, ${C_B})`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${RUN}%`}`);
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

  // Populated by the seeding step; used everywhere after.
  let stagesBySlug = new Map<string, any>();
  let salesPipelineId = "";

  let dealA: any = null;       // AM's deal on C_A
  let dealNoAmount: any = null; // AM's deal without amount
  let dealS: any = null;       // SALES-owned deal on C_B

  try {
    await step("unauthenticated requests 401", async () => {
      actingUserId = null;
      assertEq((await api("GET", "/api/deals")).status, 401, "GET /api/deals");
      assertEq(
        (await api("POST", "/api/deals", { name: "x" })).status,
        401,
        "POST /api/deals",
      );
    });

    await step("pipelines GET lazily seeds exactly one sales pipeline (idempotent)", async () => {
      actingUserId = AM_ID;
      const first = await api("GET", "/api/deals/pipelines");
      assertEq(first.status, 200, "first pipelines GET");
      const second = await api("GET", "/api/deals/pipelines");
      assertEq(second.status, 200, "second pipelines GET");

      const salesPipelines = (second.json as any[]).filter((p) => p.slug === "sales");
      assertEq(salesPipelines.length, 1, "exactly one seeded sales pipeline in payload");
      const pipeline = salesPipelines[0];
      salesPipelineId = pipeline.id;
      assert(pipeline.isDefault, "seeded pipeline is default");

      const dbCount = await db
        .select({ id: dealPipelines.id })
        .from(dealPipelines)
        .where(eq(dealPipelines.slug, "sales"));
      assertEq(dbCount.length, 1, "exactly one sales pipeline row after two GETs");

      const slugs = pipeline.stages.map((s: any) => s.slug);
      assertEq(
        JSON.stringify(slugs),
        JSON.stringify([
          "new-opportunity",
          "discovery-call",
          "proposal-sent",
          "negotiation",
          "closed-won",
          "closed-lost",
        ]),
        "6 stages in seeded order",
      );
      for (const s of pipeline.stages) stagesBySlug.set(s.slug, s);
      assertEq(stagesBySlug.get("closed-won").stageType, "won", "closed-won type");
      assertEq(stagesBySlug.get("closed-lost").stageType, "lost", "closed-lost type");
      assertEq(stagesBySlug.get("negotiation").winProbability, 75, "negotiation probability");
    });

    await step("create deal lands in first open stage with creation history + contacts", async () => {
      actingUserId = AM_ID;
      const res = await api("POST", "/api/deals", {
        name: `${RUN} Deal A`,
        clientId: C_A,
        contactIds: [contactA],
        amount: 5000,
        expectedCloseDate: FUTURE_CLOSE_DATE,
        notes: "from test",
      });
      assertEq(res.status, 201, "create deal A");
      dealA = res.json;
      assertEq(dealA.stageId, stagesBySlug.get("new-opportunity").id, "lands in first open stage");
      assertEq(dealA.ownerId, AM_ID, "owner defaults to creator");
      assertEq(dealA.createdBy, AM_ID, "createdBy stamped");

      const detail = await api("GET", `/api/deals/${dealA.id}`);
      assertEq(detail.status, 200, "detail fetch");
      assertEq(detail.json.history.length, 1, "one creation history row");
      assertEq(detail.json.history[0].fromStageId, null, "creation row has null fromStageId");
      assertEq(
        detail.json.history[0].toStageId,
        stagesBySlug.get("new-opportunity").id,
        "creation row toStageId",
      );
      assertEq(detail.json.history[0].movedByUserId, AM_ID, "creation row actor");
      assertEq(detail.json.contacts.length, 1, "contact attached");
      assertEq(detail.json.contacts[0].id, contactA, "right contact");
      assertEq(detail.json.clientFirmName, `${RUN} Firm A`, "client firm joined");
    });

    await step("bad create bodies 400", async () => {
      actingUserId = AM_ID;
      assertEq((await api("POST", "/api/deals", {})).status, 400, "missing name");
      assertEq(
        (await api("POST", "/api/deals", { name: `${RUN} bad`, amount: "abc" })).status,
        400,
        "non-numeric amount",
      );
      assertEq(
        (await api("POST", "/api/deals", { name: `${RUN} bad`, expectedCloseDate: "not-a-date" })).status,
        400,
        "malformed date",
      );
    });

    await step("contact from another client rejected", async () => {
      actingUserId = AM_ID;
      const res = await api("POST", "/api/deals", {
        name: `${RUN} wrong contact`,
        clientId: C_A,
        contactIds: [contactB],
      });
      assertEq(res.status, 400, "cross-client contact 400");
    });

    await step("sales scoping: owner forced to self, list filtered, foreign detail 403", async () => {
      actingUserId = SALES_ID;
      const res = await api("POST", "/api/deals", {
        name: `${RUN} Deal S`,
        clientId: C_B,
        ownerId: AM_ID, // smuggle attempt — must be ignored for sales
        amount: 900,
      });
      assertEq(res.status, 201, "sales create");
      dealS = res.json;
      assertEq(dealS.ownerId, SALES_ID, "owner forced to self for sales role");

      const list = await api("GET", "/api/deals");
      assertEq(list.status, 200, "sales board list");
      const runDeals = (list.json as any[]).filter((d) => d.name.startsWith(RUN));
      assertEq(runDeals.length, 1, "sales sees only own RUN deal");
      assertEq(runDeals[0].id, dealS.id, "and it is Deal S");

      assertEq(
        (await api("GET", `/api/deals/${dealA.id}`)).status,
        403,
        "foreign deal detail 403",
      );

      const reassign = await api("PATCH", `/api/deals/${dealS.id}`, { ownerId: AM_ID });
      assertEq(reassign.status, 403, "sales owner reassignment 403");

      actingUserId = SALES2_ID;
      const list2 = await api("GET", "/api/deals");
      assertEq(list2.status, 200, "other sales board list");
      assertEq(
        (list2.json as any[]).filter((d) => d.name.startsWith(RUN)).length,
        0,
        "unrelated sales user sees no RUN deals",
      );
    });

    await step("move writes history atomically with who/when", async () => {
      actingUserId = AM_ID;
      const before = new Date(dealA.stageEnteredAt).getTime();
      const res = await api("POST", `/api/deals/${dealA.id}/move`, {
        toStageId: stagesBySlug.get("discovery-call").id,
      });
      assertEq(res.status, 200, "move to discovery");
      assertEq(res.json.deal.stageId, stagesBySlug.get("discovery-call").id, "stage updated");
      assertEq(
        res.json.historyEntry.fromStageId,
        stagesBySlug.get("new-opportunity").id,
        "history fromStageId",
      );
      assertEq(
        res.json.historyEntry.toStageId,
        stagesBySlug.get("discovery-call").id,
        "history toStageId",
      );
      assertEq(res.json.historyEntry.movedByUserId, AM_ID, "history actor");
      assert(
        new Date(res.json.deal.stageEnteredAt).getTime() >= before,
        "stageEnteredAt restamped",
      );
      assert(
        res.json.deal.stageEnteredAt !== dealA.stageEnteredAt,
        "stageEnteredAt actually changed",
      );
      dealA = res.json.deal;

      const detail = await api("GET", `/api/deals/${dealA.id}`);
      assertEq(detail.json.history.length, 2, "two history rows after move");
      assertEq(
        detail.json.history[0].toStageName,
        "Discovery Call",
        "latest history row first (desc order) with stage name",
      );
      assert(
        typeof detail.json.history[0].movedByName === "string" &&
          detail.json.history[0].movedByName.includes("Manager"),
        "history row names the mover",
      );
    });

    await step("required-fields gate: 422 lists missing amount, retry with overlay persists it", async () => {
      actingUserId = AM_ID;
      const created = await api("POST", "/api/deals", { name: `${RUN} No Amount` });
      assertEq(created.status, 201, "create amount-less deal");
      dealNoAmount = created.json;

      const blocked = await api("POST", `/api/deals/${dealNoAmount.id}/move`, {
        toStageId: stagesBySlug.get("proposal-sent").id,
      });
      assertEq(blocked.status, 422, "move without amount blocked");
      assertEq(
        JSON.stringify(blocked.json.missingFields),
        JSON.stringify(["amount"]),
        "missingFields names amount",
      );

      const retried = await api("POST", `/api/deals/${dealNoAmount.id}/move`, {
        toStageId: stagesBySlug.get("proposal-sent").id,
        fields: { amount: 7500 },
      });
      assertEq(retried.status, 200, "retry with amount succeeds");
      assertEq(retried.json.deal.amount, 7500, "amount overlay persisted");
      assertEq(
        retried.json.deal.stageId,
        stagesBySlug.get("proposal-sent").id,
        "stage moved",
      );
      dealNoAmount = retried.json.deal;
    });

    await step("closed-lost requires lost_reason; retry stores it", async () => {
      actingUserId = AM_ID;
      const blocked = await api("POST", `/api/deals/${dealA.id}/move`, {
        toStageId: stagesBySlug.get("closed-lost").id,
      });
      assertEq(blocked.status, 422, "closed-lost without reason blocked");
      assertEq(
        JSON.stringify(blocked.json.missingFields),
        JSON.stringify(["lost_reason"]),
        "missingFields names lost_reason",
      );

      const retried = await api("POST", `/api/deals/${dealA.id}/move`, {
        toStageId: stagesBySlug.get("closed-lost").id,
        fields: { lostReason: "budget cut" },
      });
      assertEq(retried.status, 200, "retry with reason succeeds");
      assertEq(retried.json.deal.lostReason, "budget cut", "lostReason stored");
      dealA = retried.json.deal;

      const detail = await api("GET", `/api/deals/${dealA.id}`);
      assertEq(detail.json.history.length, 3, "three history rows after second move");
    });

    await step("stage from another pipeline rejected", async () => {
      actingUserId = AM_ID;
      const [altPipeline] = await db
        .insert(dealPipelines)
        .values({ slug: `${RUN}-alt`, name: `${RUN} Alt`, isDefault: false, position: 99 })
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
      const res = await api("POST", `/api/deals/${dealA.id}/move`, {
        toStageId: altStage.id,
      });
      assertEq(res.status, 400, "cross-pipeline move 400");
    });

    await step("PATCH cannot smuggle a stage change (write boundary)", async () => {
      actingUserId = AM_ID;
      const before = dealNoAmount.stageId;
      const res = await api("PATCH", `/api/deals/${dealNoAmount.id}`, {
        name: `${RUN} Renamed`,
        stageId: stagesBySlug.get("negotiation").id,
      });
      assertEq(res.status, 200, "patch succeeds");
      assertEq(res.json.name, `${RUN} Renamed`, "name updated");
      assertEq(res.json.stageId, before, "stageId untouched by PATCH");

      const detail = await api("GET", `/api/deals/${dealNoAmount.id}`);
      assertEq(detail.json.history.length, 2, "no phantom history row from PATCH");
    });

    await step("stage config is team_lead-gated with validated bodies", async () => {
      actingUserId = AM_ID;
      assertEq(
        (
          await api("PATCH", `/api/deals/stages/${stagesBySlug.get("new-opportunity").id}`, {
            winProbability: 15,
          })
        ).status,
        403,
        "AM cannot edit stages",
      );
      assertEq(
        (
          await api("POST", `/api/deals/pipelines/${salesPipelineId}/stages`, {
            name: `${RUN} Contract`,
            winProbability: 90,
            stageType: "open",
          })
        ).status,
        403,
        "AM cannot create stages",
      );

      actingUserId = TL_ID;
      const created = await api("POST", `/api/deals/pipelines/${salesPipelineId}/stages`, {
        name: `${RUN} Contract`,
        winProbability: 90,
        stageType: "open",
        requiredFields: ["amount"],
      });
      assertEq(created.status, 201, "TL creates stage");
      assertEq(created.json.position, 7, "appended after the 6 seeded stages");

      const badKey = await api("POST", `/api/deals/pipelines/${salesPipelineId}/stages`, {
        name: `${RUN} Bogus`,
        winProbability: 10,
        stageType: "open",
        requiredFields: ["not_a_field"],
      });
      assertEq(badKey.status, 400, "unknown requiredFields key 400");

      const patched = await api("PATCH", `/api/deals/stages/${created.json.id}`, {
        winProbability: 95,
      });
      assertEq(patched.status, 200, "TL edits stage");
      assertEq(patched.json.winProbability, 95, "probability updated");

      const pipelines = await api("GET", "/api/deals/pipelines");
      const sales = (pipelines.json as any[]).find((p) => p.id === salesPipelineId);
      const last = sales.stages[sales.stages.length - 1];
      assertEq(last.id, created.json.id, "new stage ordered last");
    });

    await step("client-page deals honor client access", async () => {
      actingUserId = AM_ID;
      const forA = await api("GET", `/api/clients/${C_A}/deals`);
      assertEq(forA.status, 200, "AM reads client A deals");
      assert(
        (forA.json as any[]).some((d) => d.id === dealA.id),
        "deal A listed for client A",
      );
      assert(
        (forA.json as any[]).every((d) => typeof d.stageName === "string"),
        "client deals carry stage names",
      );

      actingUserId = SALES_ID;
      assertEq(
        (await api("GET", `/api/clients/${C_A}/deals`)).status,
        403,
        "sales non-owner client 403",
      );
      const forB = await api("GET", `/api/clients/${C_B}/deals`);
      assertEq(forB.status, 200, "sales owner reads own client deals");
      assert(
        (forB.json as any[]).some((d) => d.id === dealS.id),
        "deal S listed for client B",
      );
    });

    await step("delete: foreign sales 403, owner succeeds", async () => {
      actingUserId = SALES2_ID;
      assertEq(
        (await api("DELETE", `/api/deals/${dealS.id}`)).status,
        403,
        "non-owner sales cannot delete",
      );
      actingUserId = SALES_ID;
      const res = await api("DELETE", `/api/deals/${dealS.id}`);
      assertEq(res.status, 200, "owner deletes own deal");
      assertEq(
        (await api("GET", `/api/deals/${dealS.id}`)).status,
        404,
        "deleted deal 404s",
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
  console.log("\nAll deals route tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
let exitCode = 0;
main()
  .catch((err) => {
    console.error("deals-routes: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
