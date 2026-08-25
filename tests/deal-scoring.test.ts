/* test-registration
{
  "name": "Deal & lead scoring (Task #4333)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4333: deterministic fit+engagement scoring — the config/rule persistence-write boundary (team_lead-gated mutations, zod-shaped bodies, meeting-direction coherence), the scoring contract itself (fit criteria matching, engagement activity-window counting with direction + minCount filters, clamp-to-range with raw components preserved), synchronous re-rank on every config mutation, the event-bump paths (stage move and new inbound activity re-score WITHOUT a full sweep), orphan reap + zero-rules clear convergence, disabled-config freeze, and the write-boundary proof that deal routes cannot smuggle score values. A drift here silently mis-ranks every lead/deal operators triage by, or lets scores go stale after the exact events that are supposed to refresh them.",
  "tier": "small"
}
test-registration */
/**
 * Task #4333 — Deal & lead scoring coverage.
 *
 * Runs the REAL registerScoringRoutes + registerDealsRoutes against a real
 * Express app with an injected per-request Clerk test identity
 * (__test_clerkUserId seam in requireAuth; switchable acting user) and the
 * real db (hermetic per-run DB under `npm test`).
 *
 *   1. Authn/authz — 401 unauthenticated; config GET is any-authed;
 *      mutations/recompute/preview are team_lead+ (account_manager 403).
 *   2. Validation — zero points 400, meeting+direction 400, min>=max 400.
 *   3. Fit scoring — criteria-matched deals gain points, unmatched get the
 *      clamped zero; breakdown carries ONLY matched rules; clamp to
 *      scoreMax; negative totals clamp to scoreMin after a range change
 *      (config edits re-rank synchronously).
 *   4. Engagement scoring — inbound-email rule counts only in-window,
 *      direction-matched activity; minCount unsatisfied drops the points;
 *      raw components (fitScore/engagementScore) survive the clamp.
 *   5. Event bumps — a stage move refreshes computedAt without a sweep; a
 *      new inbound communication (real createRawCommunication ingest hook)
 *      re-scores the client's deals via the debounced bump queue.
 *   6. Convergence — recompute reaps orphan score rows; deleting the last
 *      rule clears scores; disabled config freezes (bumps + recompute
 *      no-op) and re-enabling re-ranks.
 *   7. Write boundary — PATCH /api/deals cannot smuggle score values.
 *   8. Preview — team_lead previews a deal (saved rules and draftRules).
 *
 * All fixtures are RUN-suffixed and removed in finally; score assertions
 * target fixture deal ids, never table totals (shared-DB hygiene).
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerDealsRoutes } from "../server/routes/deals";
import { registerScoringRoutes } from "../server/routes/scoring";
import { deals, entityScores, scoreConfigs, scoreRules } from "@shared/schema";
import { createRawCommunication } from "../server/storage/communicationStorage";
import { __test_drainPendingScoreBumps } from "../server/services/scoringEngine";

const HEX = randomBytes(4).toString("hex");
const RUN = `t4333-${HEX}`;

const AM_ID = `${RUN}-am`;   // account_manager — below team_lead
const TL_ID = `${RUN}-tl`;   // team_lead — scoring management
const C_A = `${RUN}-client-a`;
const C_B = `${RUN}-client-b`;

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
    // Clerk-era per-request test seam (see server/middlewares/requireAuth.ts):
    // requireAuth reads __test_clerkUserId under NODE_ENV=test and resolves
    // the seeded users row itself (string = authed, null = anonymous).
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerDealsRoutes(app);
  registerScoringRoutes(app);
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

async function scoreRowFor(dealId: string): Promise<any | null> {
  const [row] = await db
    .select()
    .from(entityScores)
    .where(and(eq(entityScores.entityType, "deal"), eq(entityScores.entityId, dealId)));
  return row ?? null;
}

/** Board payload entry for one fixture deal (list carries flat score fields). */
async function listedDeal(dealId: string): Promise<any> {
  const res = await api("GET", "/api/deals");
  assertEq(res.status, 200, "board list 200");
  const row = (res.json as any[]).find((d) => d.id === dealId);
  assert(row, `deal ${dealId} present in board list`);
  return row;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${AM_ID}, ${`${AM_ID}@t4333.example`}, 'Task4333', 'Manager', 'account_manager', 'core'),
      (${TL_ID}, ${`${TL_ID}@t4333.example`}, 'Task4333', 'Lead', 'team_lead', 'lead')
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES
      (${C_A}, ${`${RUN} Firm A`}, ${AM_ID}, false, false),
      (${C_B}, ${`${RUN} Firm B`}, ${AM_ID}, false, false)
  `);
  // Engagement fixtures for C_A: two inbound in-window emails, one inbound
  // far outside any window we use, one outbound in-window (direction
  // filter must exclude it). C_B gets nothing.
  const now = Date.now();
  await db.execute(sql`
    INSERT INTO raw_communication_records
      (client_id, source_type, title, direction, external_source_id, match_status, timestamp)
    VALUES
      (${C_A}, 'front_email', ${`${RUN} email 1`}, 'inbound',  ${`${RUN}-em-1`}, 'matched', ${new Date(now - 2 * DAY_MS)}),
      (${C_A}, 'front_email', ${`${RUN} email 2`}, 'inbound',  ${`${RUN}-em-2`}, 'matched', ${new Date(now - 5 * DAY_MS)}),
      (${C_A}, 'front_email', ${`${RUN} email old`}, 'inbound',  ${`${RUN}-em-old`}, 'matched', ${new Date(now - 200 * DAY_MS)}),
      (${C_A}, 'front_email', ${`${RUN} email out`}, 'outbound', ${`${RUN}-em-out`}, 'matched', ${new Date(now - 1 * DAY_MS)})
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM entity_scores WHERE entity_id IN (
    SELECT id FROM deals WHERE name LIKE ${`${RUN}%`}
  ) OR entity_id LIKE ${`${RUN}%`}`);
  await db.delete(deals).where(like(deals.name, `${RUN}%`));
  // Rules cascade with the config; the config row is the lazy-ensure
  // global — reset it to defaults instead of deleting (other suites may
  // read it in a shared-DB run).
  const [config] = await db.select().from(scoreConfigs).where(eq(scoreConfigs.entityType, "deal"));
  if (config) {
    await db.delete(scoreRules).where(eq(scoreRules.configId, config.id));
    await db
      .update(scoreConfigs)
      .set({ scoreMin: 0, scoreMax: 100, isEnabled: true })
      .where(eq(scoreConfigs.id, config.id));
  }
  await db.execute(sql`DELETE FROM raw_communication_records WHERE external_source_id LIKE ${`${RUN}%`}`);
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

  let dealA: any = null; // client C_A, amount 5000
  let dealB: any = null; // client C_B, amount 2000
  const ruleIds: Record<string, string> = {};

  try {
    // Deals routes lazily seed the sales pipeline on first read.
    actingUserId = TL_ID;
    assertEq((await api("GET", "/api/deals/pipelines")).status, 200, "pipeline seed");
    {
      const a = await api("POST", "/api/deals", {
        name: `${RUN} Deal A`,
        clientId: C_A,
        amount: 5000,
      });
      assertEq(a.status, 201, "create deal A");
      dealA = a.json;
      const b = await api("POST", "/api/deals", {
        name: `${RUN} Deal B`,
        clientId: C_B,
        amount: 2000,
      });
      assertEq(b.status, 201, "create deal B");
      dealB = b.json;
    }

    await step("unauthenticated scoring routes 401", async () => {
      actingUserId = null;
      assertEq((await api("GET", "/api/scoring/deal/config")).status, 401, "GET config");
      assertEq(
        (await api("PUT", "/api/scoring/deal/config", { isEnabled: true })).status,
        401,
        "PUT config",
      );
    });

    await step("config GET lazily ensures the default config for any authed user", async () => {
      actingUserId = AM_ID;
      const res = await api("GET", "/api/scoring/deal/config");
      assertEq(res.status, 200, "config GET as account_manager");
      assertEq(res.json.config.entityType, "deal", "entity type");
      assertEq(res.json.config.scoreMin, 0, "default min");
      assertEq(res.json.config.scoreMax, 100, "default max");
      assertEq(res.json.config.isEnabled, true, "default enabled");
      assert(Array.isArray(res.json.config.rules), "rules array present");
      assertEq(res.json.maxRules, 50, "rule cap surfaced");
      const again = await api("GET", "/api/scoring/deal/config");
      assertEq(again.json.config.id, res.json.config.id, "ensure is idempotent");
    });

    await step("mutations are team_lead-gated (account_manager 403)", async () => {
      actingUserId = AM_ID;
      assertEq(
        (await api("PUT", "/api/scoring/deal/config", { scoreMax: 200 })).status,
        403,
        "PUT config",
      );
      assertEq(
        (
          await api("POST", "/api/scoring/deal/rules", {
            kind: "fit",
            name: "x",
            points: 10,
            criteria: {
              combinator: "and",
              groups: [
                { combinator: "and", conditions: [{ field: "amount", operator: "gt", value: 1 }] },
              ],
            },
          })
        ).status,
        403,
        "POST rule",
      );
      assertEq((await api("POST", "/api/scoring/deal/recompute")).status, 403, "recompute");
      assertEq(
        (await api("POST", "/api/scoring/preview", { entityType: "deal", entityId: dealA.id }))
          .status,
        403,
        "preview",
      );
    });

    await step("validation: zero points, meeting direction, inverted range 400", async () => {
      actingUserId = TL_ID;
      const zero = await api("POST", "/api/scoring/deal/rules", {
        kind: "engagement",
        name: "zero",
        points: 0,
        eventType: "email",
        windowDays: 14,
      });
      assertEq(zero.status, 400, "zero points rejected");
      const meeting = await api("POST", "/api/scoring/deal/rules", {
        kind: "engagement",
        name: "bad meeting",
        points: 5,
        eventType: "meeting",
        direction: "inbound",
        windowDays: 14,
      });
      assertEq(meeting.status, 400, "meeting with direction rejected");
      const range = await api("PUT", "/api/scoring/deal/config", { scoreMin: 100, scoreMax: 100 });
      assertEq(range.status, 400, "min >= max rejected");
      const smuggle = await api("PUT", "/api/scoring/deal/config", { entityType: "client" });
      assertEq(smuggle.status, 200, "unknown keys stripped, empty update ok");
      assertEq(smuggle.json.config.entityType, "deal", "entityType untouched");
    });

    await step("fit rule scores matching deals synchronously; breakdown = matched only", async () => {
      actingUserId = TL_ID;
      const res = await api("POST", "/api/scoring/deal/rules", {
        kind: "fit",
        name: `${RUN} High value`,
        points: 40,
        criteria: {
          combinator: "and",
          groups: [
            { combinator: "and", conditions: [{ field: "amount", operator: "gt", value: 4000 }] },
          ],
        },
      });
      assertEq(res.status, 201, "create fit rule");
      ruleIds.highValue = res.json.rule.id;
      assert(res.json.recompute.scored >= 2, "recompute covered the fixture deals");

      const a = await listedDeal(dealA.id);
      assertEq(a.score, 40, "deal A matched (+40)");
      assertEq(a.fitScore, 40, "deal A fit component");
      assertEq(a.engagementScore, 0, "deal A engagement component");
      assert(a.scoreComputedAt, "computedAt stamped on list payload");

      const b = await listedDeal(dealB.id);
      assertEq(b.score, 0, "deal B unmatched (clamped 0)");

      const detail = await api("GET", `/api/deals/${dealA.id}`);
      assertEq(detail.status, 200, "deal detail");
      assertEq(detail.json.score, 40, "detail score");
      assertEq(detail.json.scoreBreakdown.length, 1, "breakdown has only the matched rule");
      assertEq(detail.json.scoreBreakdown[0].ruleId, ruleIds.highValue, "breakdown rule id");
      assertEq(detail.json.scoreBreakdown[0].points, 40, "breakdown points");
      const bDetail = await api("GET", `/api/deals/${dealB.id}`);
      assertEq(bDetail.json.scoreBreakdown.length, 0, "unmatched deal has empty breakdown");
    });

    await step("clamp: totals above scoreMax pin to the max, raw components preserved", async () => {
      actingUserId = TL_ID;
      const res = await api("POST", "/api/scoring/deal/rules", {
        kind: "fit",
        name: `${RUN} Any real amount`,
        points: 80,
        criteria: {
          combinator: "and",
          groups: [
            { combinator: "and", conditions: [{ field: "amount", operator: "gt", value: 1000 }] },
          ],
        },
      });
      assertEq(res.status, 201, "create +80 rule");
      ruleIds.anyAmount = res.json.rule.id;
      const a = await listedDeal(dealA.id);
      assertEq(a.score, 100, "deal A clamped to 100 (40+80=120)");
      assertEq(a.fitScore, 120, "raw fit survives the clamp");
      const b = await listedDeal(dealB.id);
      assertEq(b.score, 80, "deal B within range");
    });

    await step("negative totals clamp to scoreMin; range change re-ranks synchronously", async () => {
      actingUserId = TL_ID;
      const res = await api("POST", "/api/scoring/deal/rules", {
        kind: "fit",
        name: `${RUN} Small deal penalty`,
        points: -200,
        criteria: {
          combinator: "and",
          groups: [
            { combinator: "and", conditions: [{ field: "amount", operator: "lt", value: 3000 }] },
          ],
        },
      });
      assertEq(res.status, 201, "create -200 rule");
      ruleIds.penalty = res.json.rule.id;
      let b = await listedDeal(dealB.id);
      assertEq(b.score, 0, "deal B total (80-200) clamps to min 0");
      assertEq(b.fitScore, -120, "raw negative fit preserved");

      const put = await api("PUT", "/api/scoring/deal/config", { scoreMin: -50 });
      assertEq(put.status, 200, "widen range downward");
      b = await listedDeal(dealB.id);
      assertEq(b.score, -50, "config change re-ranked deal B to the new min");
      const a = await listedDeal(dealA.id);
      assertEq(a.score, 100, "deal A unaffected (5000 not < 3000)");
    });

    await step("engagement rule counts only in-window direction-matched activity", async () => {
      actingUserId = TL_ID;
      const res = await api("POST", "/api/scoring/deal/rules", {
        kind: "engagement",
        name: `${RUN} Recent inbound email`,
        points: 25,
        eventType: "email",
        direction: "inbound",
        windowDays: 14,
        minCount: 2,
      });
      assertEq(res.status, 201, "create engagement rule");
      ruleIds.email = res.json.rule.id;

      const a = await listedDeal(dealA.id);
      assertEq(a.engagementScore, 25, "2 in-window inbound emails satisfy minCount 2");
      const b = await listedDeal(dealB.id);
      assertEq(b.engagementScore, 0, "client B has no activity");

      const detail = await api("GET", `/api/deals/${dealA.id}`);
      const entry = (detail.json.scoreBreakdown as any[]).find(
        (e) => e.ruleId === ruleIds.email,
      );
      assert(entry, "engagement entry in breakdown");
      assert(
        String(entry.detail).includes("in the last 14 days"),
        `human detail names the window (got: ${entry?.detail})`,
      );

      // minCount 3 cannot be satisfied by 2 qualifying emails (the old one
      // is outside the window, the outbound one fails the direction).
      const patch = await api("PATCH", `/api/scoring/rules/${ruleIds.email}`, { minCount: 3 });
      assertEq(patch.status, 200, "raise minCount");
      const a2 = await listedDeal(dealA.id);
      assertEq(a2.engagementScore, 0, "minCount 3 unsatisfied → no points");
    });

    await step("kind-immutable: engagement fields rejected on a fit rule", async () => {
      actingUserId = TL_ID;
      const res = await api("PATCH", `/api/scoring/rules/${ruleIds.highValue}`, {
        eventType: "sms",
      });
      assertEq(res.status, 400, "cross-kind field rejected");
    });

    await step("stage move bumps the deal's score row without a sweep", async () => {
      actingUserId = TL_ID;
      const before = await scoreRowFor(dealA.id);
      assert(before, "deal A has a score row");
      await new Promise((r) => setTimeout(r, 30));
      const pipelines = await api("GET", "/api/deals/pipelines");
      const stages = (pipelines.json as any[]).find((p: any) => p.slug === "sales")?.stages ?? [];
      const discovery = stages.find((s: any) => s.slug === "discovery-call");
      assert(discovery, "discovery stage present");
      const move = await api("POST", `/api/deals/${dealA.id}/move`, { toStageId: discovery.id });
      assertEq(move.status, 200, "move deal A");
      // The move handler awaits recomputeEntityScoreSafe before responding.
      const after = await scoreRowFor(dealA.id);
      assert(
        new Date(after.computedAt).getTime() > new Date(before.computedAt).getTime(),
        "computedAt advanced on stage move",
      );
    });

    await step("new inbound activity bumps scores via the ingest hook", async () => {
      actingUserId = TL_ID;
      const before = await scoreRowFor(dealA.id);
      assertEq(before.engagementScore, 0, "engagement 0 before third email");
      // Real ingest path: createRawCommunication fires the debounced bump.
      await createRawCommunication({
        clientId: C_A,
        sourceType: "front_email",
        title: `${RUN} email 3`,
        direction: "inbound",
        externalSourceId: `${RUN}-em-3`,
        matchStatus: "matched",
        timestamp: new Date(),
      } as any);
      await __test_drainPendingScoreBumps();
      const after = await scoreRowFor(dealA.id);
      assertEq(after.engagementScore, 25, "third inbound email satisfies minCount 3");
      assert(
        new Date(after.computedAt).getTime() >= new Date(before.computedAt).getTime(),
        "computedAt refreshed by the bump",
      );
    });

    await step("recompute reaps orphan score rows", async () => {
      actingUserId = TL_ID;
      const orphanId = `${RUN}-ghost`;
      await db.insert(entityScores).values({
        entityType: "deal",
        entityId: orphanId,
        score: 42,
        fitScore: 42,
        engagementScore: 0,
        breakdown: [],
      });
      const res = await api("POST", "/api/scoring/deal/recompute");
      assertEq(res.status, 200, "manual recompute");
      assert(res.json.orphansReaped >= 1, "orphan counted");
      assertEq(await scoreRowFor(orphanId), null, "orphan row deleted");
    });

    await step("deal writes cannot smuggle score values (write boundary)", async () => {
      actingUserId = TL_ID;
      const before = await scoreRowFor(dealA.id);
      const res = await api("PATCH", `/api/deals/${dealA.id}`, {
        notes: "score smuggle attempt",
        score: 999,
        fitScore: 999,
        engagementScore: 999,
        scoreComputedAt: new Date().toISOString(),
      });
      assertEq(res.status, 200, "PATCH accepts (unknown keys stripped)");
      const after = await scoreRowFor(dealA.id);
      assertEq(after.score, before.score, "score unchanged by deal PATCH");
      assertEq(after.fitScore, before.fitScore, "fitScore unchanged");
      const listed = await listedDeal(dealA.id);
      assertEq(listed.score, before.score, "list payload score unchanged");
    });

    await step("preview: saved rules match stored score; draftRules replace them", async () => {
      actingUserId = TL_ID;
      const stored = await scoreRowFor(dealA.id);
      const res = await api("POST", "/api/scoring/preview", {
        entityType: "deal",
        entityId: dealA.id,
      });
      assertEq(res.status, 200, "preview 200");
      assertEq(res.json.found, true, "found");
      assertEq(res.json.computed.score, stored.score, "preview matches stored score");
      assertEq(res.json.ruleCount, 4, "4 saved rules evaluated");

      const draft = await api("POST", "/api/scoring/preview", {
        entityType: "deal",
        entityId: dealA.id,
        draftRules: [
          {
            kind: "fit",
            name: "draft only",
            points: 7,
            criteria: {
              combinator: "and",
              groups: [
                { combinator: "and", conditions: [{ field: "amount", operator: "gt", value: 1 }] },
              ],
            },
          },
        ],
      });
      assertEq(draft.status, 200, "draft preview 200");
      assertEq(draft.json.computed.score, 7, "draft rules replace saved ones");
      assertEq(draft.json.ruleCount, 1, "only the draft rule evaluated");

      const missing = await api("POST", "/api/scoring/preview", {
        entityType: "deal",
        entityId: `${RUN}-nope`,
      });
      assertEq(missing.status, 404, "unknown deal 404");
    });

    await step("disabled config freezes scores; re-enable re-ranks", async () => {
      actingUserId = TL_ID;
      const off = await api("PUT", "/api/scoring/deal/config", { isEnabled: false });
      assertEq(off.status, 200, "disable");
      assert(
        String(off.json.recompute.note ?? "").includes("disabled"),
        "recompute reports the freeze",
      );
      const frozen = await scoreRowFor(dealA.id);

      // Amount edit fires the deal-route bump — the engine must skip it.
      const patch = await api("PATCH", `/api/deals/${dealA.id}`, { amount: 100 });
      assertEq(patch.status, 200, "amount edit while disabled");
      const still = await scoreRowFor(dealA.id);
      assertEq(still.score, frozen.score, "score frozen while disabled");
      assertEq(
        new Date(still.computedAt).getTime(),
        new Date(frozen.computedAt).getTime(),
        "computedAt frozen while disabled",
      );

      const on = await api("PUT", "/api/scoring/deal/config", { isEnabled: true });
      assertEq(on.status, 200, "re-enable");
      const rescored = await scoreRowFor(dealA.id);
      // amount 100: no +40 (not >4000), no +80 (not >1000), -200 (<3000)
      // → clamp(-200 + 25 eng, -50, 100) = -50.
      assertEq(rescored.score, -50, "re-enable re-ranked with current fields");
    });

    await step("deleting the last rule clears fixture scores; list shows null", async () => {
      actingUserId = TL_ID;
      for (const id of Object.values(ruleIds)) {
        assertEq((await api("DELETE", `/api/scoring/rules/${id}`)).status, 200, `delete ${id}`);
      }
      assertEq(await scoreRowFor(dealA.id), null, "deal A score cleared");
      assertEq(await scoreRowFor(dealB.id), null, "deal B score cleared");
      const listed = await listedDeal(dealA.id);
      assertEq(listed.score, null, "list score null after clear");
      assertEq(listed.scoreComputedAt, null, "list computedAt null after clear");
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
  console.log("\nAll deal scoring tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
let exitCode = 0;
main()
  .catch((err) => {
    console.error("deal-scoring: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
