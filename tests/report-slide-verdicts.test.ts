/* test-registration
{
  "name": "Per-slide verdict sentence system (Task #4273, operator-only per Task #4902)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4273 (audit §8.1-1) + Task #4902 (owner mandate: no AI-invented advice on client-facing reports): slide verdicts are OPERATOR-authored copy served VERBATIM to anonymous share/demo viewers from the stored slideVerdicts section row. This suite defends four invariants no other suite covers: (1) the finalize HARD 422 (verdict_quality_floor — deliberately NOT confirm-bypassable, unlike the #4227 gate) that keeps degenerate verdict copy out of finalized reports; (2) the internal slideVerdicts row never leaks into served sections on the share OR demo payloads while the stored map IS served as slideVerdicts with ZERO OpenAI calls on the anonymous path; (3) finalizing NEVER auto-drafts verdict copy — asserted structurally (the route source carries no reference to the deleted finalize generator, the service no longer exports it) AND behaviorally (finalize stores no verdict row and makes zero OpenAI calls); (4) the retired lifetimeValue slot stays dead — operator PUTs strip it, the finalize floor ignores legacy stored junk under it, share/demo payload maps drop it, and the draft endpoint 400s it. A drift here ships junk or AI-invented copy to paying clients or starts billing OpenAI per anonymous page view.",
  "scanPaths": [
    "server/routes/reports.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4273 — per-slide verdict sentence system, reworked for Task #4902
 * (verdicts are operator-authored ONLY; finalize never auto-drafts; the
 * lifetimeValue slot is retired):
 *
 *   1. Unit: `findDegenerateVerdict` floor (placeholder / too_short /
 *      too_long / too_few_words / repetitive; empty always passes) and
 *      `sanitizeSlideVerdictMap` narrowing (which now also strips the
 *      retired lifetimeValue key).
 *   2. Unit: the KEPT on-demand draft generator (`generateSlideVerdicts`)
 *      floor-drops all-degenerate AI output (returns null, stores nothing —
 *      it never stores anyway), and `buildSlideVerdictContext` omits slides
 *      with no data — including (Task #4983) resolving the missed-call fact
 *      exactly like the card: pushed stored rate > 0 clamped in, stored 0
 *      only with bucket evidence, otherwise the key is omitted so the model
 *      can never cite a fabricated 0% the deck renders as "No data".
 *   3. PUT /api/reports/:id/sections/slideVerdicts is STRICT: valid saves
 *      trim values, drop empties, strip unknown keys — including the
 *      retired lifetimeValue; shape violations 400.
 *   4. Finalize gate: PATCH status:"final" with a degenerate stored verdict
 *      → HARD 422 `verdict_quality_floor` naming slideKey+reason+snippet;
 *      confirm flags do NOT bypass it; fixing (or clearing) the verdict lets
 *      finalize through; legacy stored junk under the retired lifetimeValue
 *      key is IGNORED by the gate; a report with no verdicts finalizes
 *      plainly. Task #4902: the whole lane runs with a throwing OpenAI mock
 *      and asserts ZERO calls + no auto-created verdict row — finalize
 *      never drafts.
 *   5. Share + demo payloads serve the stored map verbatim under
 *      `slideVerdicts` (minus retired keys a legacy row still carries),
 *      strip BOTH internal rows (slideVerdicts, seasonalTrendsAi) from
 *      `sections`, and make zero OpenAI calls.
 *   6. POST /api/reports/:id/verdicts/draft: 200 returns the sentence
 *      WITHOUT storing; degenerate AI output → 502; bad slideKey (including
 *      the retired lifetimeValue) → 400; anonymous → 401.
 *
 * Harness mirrors tests/report-finalize-quality-gate.test.ts: express app +
 * registerReportRoutes with an injected fake session, OpenAI singleton
 * mocked (no network), runInIsolatedSchema with pinGetDbForCrossAsync.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

import { registerReportRoutes } from "../server/routes/reports";
import { openai } from "../server/routes/middleware";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import * as slideVerdictsService from "../server/services/slideVerdicts";
import {
  SLIDE_VERDICTS_SECTION_KEY,
  buildSlideVerdictContext,
  generateSlideVerdicts,
  readStoredSlideVerdicts,
  type SlideVerdictChatClient,
} from "../server/services/slideVerdicts";
import {
  SLIDE_VERDICT_KEYS,
  VERDICT_MAX_CHARS,
  findDegenerateVerdict,
  sanitizeSlideVerdictMap,
  slideVerdictsSectionSchema,
} from "../shared/slideVerdicts";
import { SEASONAL_TRENDS_AI_SECTION_KEY } from "../server/services/practiceAreaTrendAnalysis";
import { runInIsolatedSchema, sql } from "./db-sandbox";

// The Clerk-era auth seam (`req.__test_clerkUserId`) is only honored under
// NODE_ENV=test. The registered runner establishes it; self-establish here
// too so a direct `npx tsx tests/report-slide-verdicts.test.ts` invocation
// (e.g. during review) exercises the same authenticated paths instead of
// 401ing. The check is per-request, so setting it post-import is safe.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = `task-4273-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OWNER_ID = `${TAG}-owner`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`; // main flow: PUT/gate/generation/share/demo
const PLAIN_REPORT_ID = `${TAG}-plain`; // no verdicts: plain finalize + failure lanes
const SHARE_TOKEN = `${TAG}-share-token`;

const HEALTHY_VERDICT =
  "Intake is leaking ~$18K/mo — answer speed is the fix.";
const HEALTHY_COMMON_ISSUES = `🔴 **Issue:** Intake staff are not asking qualifying questions on inbound calls
↳ **Impact:** Unqualified leads consume consult slots and drag conversion down
> ➡️ **Strategic Fix:** Roll out the three-question qualification script this week`;

// ---------------------------------------------------------------- OpenAI
// Module-singleton mock (the draft route passes `openai` from middleware).
type CreateFn = typeof openai.chat.completions.create;
const ORIGINAL_CREATE: CreateFn = openai.chat.completions.create.bind(
  openai.chat.completions,
);
let singletonCalls = 0;

function mockOpenAiReturns(content: string): void {
  (openai.chat.completions as any).create = async () => {
    singletonCalls++;
    return { choices: [{ finish_reason: "stop", message: { content } }] };
  };
}

function mockOpenAiThrows(): void {
  (openai.chat.completions as any).create = async () => {
    singletonCalls++;
    throw new Error("task-4273: unexpected OpenAI call");
  };
}

function restoreOpenAi(): void {
  (openai.chat.completions as any).create = ORIGINAL_CREATE;
}

// ---------------------------------------------------------------- harness
function buildApp(authed: boolean): express.Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk-era per-request test seam (server/middlewares/requireAuth.ts):
    // a string id authenticates as that user; null → unauthenticated (401).
    // OWNER_ID's users row lives in this suite's ISOLATED schema, which
    // requireAuth's ambient-db lookup cannot see, so run() pre-registers the
    // profile via __test_markUserReconciled — otherwise requireAuth would JIT
    // -provision a public-schema users row (and fire comms auto-join).
    (req as any).__test_clerkUserId = authed ? OWNER_ID : null;
    next();
  });
  registerReportRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readVerdictRow(
  isoDb: any,
  reportId: string,
): Promise<Record<string, any> | null> {
  const rows: any = await isoDb.execute(sql`
    SELECT data FROM report_sections
    WHERE report_id = ${reportId} AND section_key = ${SLIDE_VERDICTS_SECTION_KEY}
    LIMIT 1
  `);
  const list = Array.isArray(rows) ? rows : rows?.rows;
  return list?.[0]?.data ?? null;
}

async function readReportStatus(isoDb: any, reportId: string): Promise<string | undefined> {
  const rows: any = await isoDb.execute(sql`
    SELECT status FROM reports WHERE id = ${reportId} LIMIT 1
  `);
  const list = Array.isArray(rows) ? rows : rows?.rows;
  return list?.[0]?.status;
}

// ---------------------------------------------------------------- 1. units
function unitTests(): void {
  // Empty / absent input is never degenerate (cleared verdict = no line).
  assert.equal(findDegenerateVerdict(""), null, "empty passes");
  assert.equal(findDegenerateVerdict("   "), null, "whitespace passes");
  assert.equal(findDegenerateVerdict(undefined), null, "undefined passes");
  assert.equal(findDegenerateVerdict(null), null, "null passes");

  // The reference sentence passes.
  assert.equal(findDegenerateVerdict(HEALTHY_VERDICT), null, "reference verdict passes");

  // Placeholder junk — including trailing punctuation and case variants.
  for (const junk of ["TBD", "tbd.", "Placeholder", "verdict goes here", "N/A", "todo…"]) {
    assert.equal(
      findDegenerateVerdict(junk)?.reason,
      "placeholder",
      `"${junk}" flagged as placeholder`,
    );
  }
  assert.equal(
    findDegenerateVerdict("Some lorem ipsum dolor sit amet filler sentence here")?.reason,
    "placeholder",
    "lorem ipsum flagged",
  );

  assert.equal(findDegenerateVerdict("Bad calls.")?.reason, "too_short", "thin text flagged");
  assert.equal(
    findDegenerateVerdict("x".repeat(VERDICT_MAX_CHARS + 1))?.reason,
    "too_long",
    "overlong flagged",
  );
  assert.equal(
    findDegenerateVerdict("Extraordinarily disappointing performance.")?.reason,
    "too_few_words",
    "3 long words flagged",
  );
  assert.equal(
    findDegenerateVerdict("money money money money money")?.reason,
    "repetitive",
    "single repeated word flagged",
  );

  // Task #4902 — the retired lifetimeValue slot is OUT of the key set (7
  // slides remain), so every key-set-driven surface drops it automatically.
  assert.ok(
    !(SLIDE_VERDICT_KEYS as readonly string[]).includes("lifetimeValue"),
    "lifetimeValue is retired from SLIDE_VERDICT_KEYS",
  );
  assert.equal(SLIDE_VERDICT_KEYS.length, 7, "seven verdict slots remain");

  // sanitizeSlideVerdictMap narrows unknown input.
  assert.deepEqual(sanitizeSlideVerdictMap(null), {}, "null → {}");
  assert.deepEqual(sanitizeSlideVerdictMap([1, 2]), {}, "array → {}");
  assert.deepEqual(
    sanitizeSlideVerdictMap({
      intake: `  ${HEALTHY_VERDICT}  `,
      marketing: "   ",
      bogusSlide: "should be dropped",
      lifetimeValue: "legacy stored line — retired key must strip",
      sales: 42,
    }),
    { intake: HEALTHY_VERDICT },
    "trims, drops empties/non-strings, strips unknown AND retired slide keys",
  );

  // readStoredSlideVerdicts: garbled rows → null, valid rows → map.
  assert.equal(readStoredSlideVerdicts(null), null, "null row → null");
  assert.equal(readStoredSlideVerdicts({ verdicts: {} }), null, "empty map → null");
  assert.equal(readStoredSlideVerdicts({ verdicts: "junk" }), null, "garbled → null");
  assert.deepEqual(
    readStoredSlideVerdicts({ verdicts: { intake: HEALTHY_VERDICT }, generatedAt: "x" }),
    { intake: HEALTHY_VERDICT },
    "valid row reads back the sparse map",
  );

  // Write schema: unknown top-level keys strip; shape violations reject.
  const parsedOk = slideVerdictsSectionSchema.safeParse({
    verdicts: { intake: HEALTHY_VERDICT },
    generatedAt: "operator-cannot-forge-this",
  });
  assert.ok(parsedOk.success, "valid write parses");
  assert.ok(
    parsedOk.success && !("generatedAt" in (parsedOk.data as any)),
    "unknown top-level keys are stripped (generatedAt is server-stamped only)",
  );
  assert.ok(
    !slideVerdictsSectionSchema.safeParse({ verdicts: [1] }).success,
    "array verdicts rejected",
  );
  assert.ok(
    !slideVerdictsSectionSchema.safeParse({ verdicts: { intake: 42 } }).success,
    "numeric verdict rejected",
  );
  assert.ok(
    !slideVerdictsSectionSchema.safeParse({ verdicts: { intake: "y".repeat(501) } }).success,
    "shape cap (500 chars) rejected",
  );

  console.log("unit: verdict floor + sanitize + schema PASSED");
}

// ------------------------------------------------------------------- seed
async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${OWNER_ID}, 'ceo', ${`${OWNER_ID}@example.com`}, 'Verdict', 'Author')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  // is_demo=true so the demo endpoint's newest-demo-report fallback lane
  // serves REPORT_ID (2026-03 > PLAIN's 2026-01). practice_areas stays NULL
  // — keeps seasonal-phase computation entirely out of this suite.
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, owner_id, is_demo)
    VALUES (${CLIENT_ID}, ${"Verdict Line Law (test)"}, ARRAY['gbp']::text[], ${OWNER_ID}, true)
    ON CONFLICT (id) DO NOTHING
  `);
  // Reviewed command panel → the unrelated monthly-review finalize gate
  // passes; healthy commonIssues + both Next-30 columns → the #4227 gate
  // passes. This suite exercises ONLY the verdict gate.
  await isoDb.execute(sql`
    INSERT INTO command_panels (client_id, last_reviewed_at)
    VALUES (${CLIENT_ID}, now())
  `);

  for (const [reportId, month] of [
    [REPORT_ID, "2026-03"],
    [PLAIN_REPORT_ID, "2026-01"],
  ] as const) {
    await isoDb.execute(sql`
      INSERT INTO reports (id, client_id, report_month, status)
      VALUES (${reportId}, ${CLIENT_ID}, ${month}, 'draft')
    `);
    await isoDb.execute(sql`
      INSERT INTO report_sections (id, report_id, section_key, data)
      VALUES (${`${reportId}-intake`}, ${reportId}, 'intake',
              ${JSON.stringify({
                totalConsults: 24,
                missedCallRate: 18,
                avgTimeToAnswer: 42,
                qualityScore: 71,
                commonIssues: HEALTHY_COMMON_ISSUES,
              })}::jsonb)
    `);
    await isoDb.execute(sql`
      INSERT INTO report_sections (id, report_id, section_key, data)
      VALUES (${`${reportId}-actions`}, ${reportId}, 'nextActions',
              ${JSON.stringify({
                ours: [{ action: "Launch the answer-speed sprint", why: "cuts missed calls" }],
                theirs: [{ action: "Send signed-case list by the 5th", why: "accuracy" }],
              })}::jsonb)
    `);
  }
}

// ------------------------------------------------- 2. strict section PUT
async function sectionPutTests(isoDb: any, baseUrl: string): Promise<void> {
  const put = (body: unknown) =>
    fetch(`${baseUrl}/api/reports/${REPORT_ID}/sections/${SLIDE_VERDICTS_SECTION_KEY}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // Valid save: trims, drops empties, strips unknown keys (both levels) —
  // including the Task #4902-retired lifetimeValue slot: an editor payload
  // (e.g. a stale open tab) carrying it saves fine but never stores it.
  const ok = await put({
    data: {
      verdicts: {
        intake: `  ${HEALTHY_VERDICT}  `,
        marketing: "   ",
        bogusSlide: "dropped by the schema",
        lifetimeValue: "Average case nets $12,500 now — retired slot must not store.",
      },
      generatedAt: "forged-should-strip",
    },
  });
  assert.equal(ok.status, 200, `valid verdict save: expected 200, got ${ok.status}`);
  const stored = await readVerdictRow(isoDb, REPORT_ID);
  assert.deepEqual(
    stored?.verdicts,
    { intake: HEALTHY_VERDICT },
    "stored row: trimmed, empties dropped, unknown AND retired slide keys stripped",
  );
  assert.ok(
    !("generatedAt" in (stored ?? {})),
    "operator saves cannot forge the server-stamped generatedAt",
  );

  // Shape violations → 400 (zod issues in the body).
  for (const bad of [
    { verdicts: "junk" },
    { verdicts: { intake: 42 } },
    { verdicts: { intake: "z".repeat(501) } },
  ]) {
    const res = await put({ data: bad });
    assert.equal(
      res.status,
      400,
      `bad shape ${JSON.stringify(bad).slice(0, 40)}: expected 400, got ${res.status}`,
    );
  }
  // …and the 400s stored nothing new.
  const after = await readVerdictRow(isoDb, REPORT_ID);
  assert.deepEqual(after?.verdicts, { intake: HEALTHY_VERDICT }, "rejected saves stored nothing");

  console.log("route: strict slideVerdicts section PUT PASSED");
}

// ------------------------------------------------- 3. finalize hard gate
// Task #4902: the ENTIRE lane runs with a throwing OpenAI mock installed —
// any finalize-time drafting attempt fails loudly, and the closing
// assertions prove zero calls + no auto-created verdict row.
async function finalizeGateTests(isoDb: any, baseUrl: string): Promise<void> {
  const patchFinal = (reportId: string, extra: Record<string, unknown> = {}) =>
    fetch(`${baseUrl}/api/reports/${reportId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "final", ...extra }),
    });

  singletonCalls = 0;
  mockOpenAiThrows();
  try {
    // Poison one verdict (placeholder junk passes the save shape on purpose).
    const poison = await fetch(
      `${baseUrl}/api/reports/${REPORT_ID}/sections/${SLIDE_VERDICTS_SECTION_KEY}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { verdicts: { intake: HEALTHY_VERDICT, sales: "TBD" } } }),
      },
    );
    assert.equal(poison.status, 200, "junk verdict SAVES fine (floor bites at finalize)");

    // 1. Finalize → hard 422 naming the slide, reason, snippet.
    const fin1 = await patchFinal(REPORT_ID);
    const fin1Body: any = await fin1.json().catch(() => ({}));
    assert.equal(
      fin1.status,
      422,
      `degenerate verdict finalize: expected 422, got ${fin1.status} body=${JSON.stringify(fin1Body)}`,
    );
    assert.equal(fin1Body.error, "verdict_quality_floor", "gate error code");
    assert.deepEqual(
      fin1Body.degenerateVerdicts,
      [{ slideKey: "sales", reason: "placeholder", snippet: "TBD" }],
      "names exactly the offending slide + reason + snippet (healthy intake NOT flagged)",
    );
    assert.equal(await readReportStatus(isoDb, REPORT_ID), "draft", "blocked finalize stays draft");

    // 2. NO confirm flag bypasses it — this is the deliberate difference from
    //    the #4227 confirm-able gate: degenerate verdicts can NEVER ship.
    const fin2 = await patchFinal(REPORT_ID, {
      confirmReportQualityFinalize: true,
      confirmBrokenSourceFinalize: true,
    });
    const fin2Body: any = await fin2.json().catch(() => ({}));
    assert.equal(
      fin2.status,
      422,
      `confirm flags must NOT bypass the verdict floor: expected 422, got ${fin2.status}`,
    );
    assert.equal(fin2Body.error, "verdict_quality_floor", "still the verdict gate");
    assert.equal(await readReportStatus(isoDb, REPORT_ID), "draft", "still draft after confirm attempt");

    // 3. Clearing the junk (remediation lane) lets finalize through. Before
    //    finalizing, plant legacy junk under the RETIRED lifetimeValue key
    //    via raw SQL (no live write path can store it anymore — this mirrors
    //    a pre-#4902 row): the gate iterates SLIDE_VERDICT_KEYS only, so the
    //    degenerate "TBD" under a retired key must NOT block finalize.
    const fix = await fetch(
      `${baseUrl}/api/reports/${REPORT_ID}/sections/${SLIDE_VERDICTS_SECTION_KEY}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { verdicts: { intake: HEALTHY_VERDICT } } }),
      },
    );
    assert.equal(fix.status, 200, "clearing the junk verdict saves");
    await isoDb.execute(sql`
      UPDATE report_sections
      SET data = jsonb_set(data, '{verdicts,lifetimeValue}', '"TBD"'::jsonb)
      WHERE report_id = ${REPORT_ID} AND section_key = ${SLIDE_VERDICTS_SECTION_KEY}
    `);
    const fin3 = await patchFinal(REPORT_ID);
    const fin3Body: any = await fin3.json().catch(() => ({}));
    assert.equal(
      fin3.status,
      200,
      `fixed report finalizes despite retired-key junk: expected 200, got ${fin3.status} body=${JSON.stringify(fin3Body)}`,
    );
    assert.equal(await readReportStatus(isoDb, REPORT_ID), "final", "finalize lands");

    // 4. A report with NO verdicts at all finalizes plainly — empty is always
    //    allowed (slides simply render without a verdict line).
    const finPlain = await patchFinal(PLAIN_REPORT_ID);
    const finPlainBody: any = await finPlain.json().catch(() => ({}));
    assert.equal(
      finPlain.status,
      200,
      `no-verdicts finalize: expected 200, got ${finPlain.status} body=${JSON.stringify(finPlainBody)}`,
    );

    // 5. Task #4902 — finalize NEVER auto-drafts. Behaviorally: the plain
    //    report still has NO verdict row (the old kick would have created
    //    one), the main report's row was not rewritten by finalize (the raw
    //    legacy key survives untouched in storage — serves strip it), and
    //    the throwing OpenAI singleton was never reached.
    assert.equal(
      await readVerdictRow(isoDb, PLAIN_REPORT_ID),
      null,
      "finalize auto-created NO verdict row for the plain report",
    );
    const mainRow = await readVerdictRow(isoDb, REPORT_ID);
    assert.deepEqual(
      mainRow?.verdicts,
      { intake: HEALTHY_VERDICT, lifetimeValue: "TBD" },
      "finalize rewrote nothing: stored row keeps exactly the operator copy + raw legacy key",
    );
    assert.equal(singletonCalls, 0, "ZERO OpenAI calls across every finalize");
  } finally {
    restoreOpenAi();
  }

  // 6. Structural proof the auto-draft path is GONE: the route source has no
  //    reference to the deleted finalize generator, and the service module
  //    no longer exports it. (A reintroduction under the same name fails
  //    here even if some new gate keeps the behavioral asserts green.)
  const routeSource = readFileSync("server/routes/reports.ts", "utf8");
  assert.ok(
    !routeSource.includes("generateAndStoreSlideVerdicts"),
    "server/routes/reports.ts carries no finalize-time verdict generation call",
  );
  assert.ok(
    !("generateAndStoreSlideVerdicts" in slideVerdictsService),
    "slideVerdicts service no longer exports the finalize bulk generator",
  );

  console.log("route: finalize verdict_quality_floor hard gate + never-drafts PASSED");
}

// ---------------------------- 4. draft-generator units (the KEPT service)
// Task #4902 deleted the finalize bulk generator; what remains is the
// on-demand single-slide generator behind the editor's "Draft with AI"
// button. It never stores anything (pure: context in → sentence map out),
// so these are DB-free unit lanes.
async function draftGeneratorUnitTests(): Promise<void> {
  // All-degenerate output yields null (the floor bites before the caller
  // ever sees a sentence).
  const junkClient: SlideVerdictChatClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ intake: "TBD", sales: "todo", marketing: "N/A" }),
              },
            },
          ],
        }),
      },
    },
  };
  const junkOut = await generateSlideVerdicts({
    context: { reportMonth: "2026-01" },
    slideKeys: [...SLIDE_VERDICT_KEYS],
    openaiClient: junkClient,
  });
  assert.equal(junkOut, null, "all-degenerate AI output yields null");

  // Context builder omits slides with no data (model can't invent numbers).
  const ctx = buildSlideVerdictContext({
    reportMonth: "2026-03",
    sections: [],
    reportId: REPORT_ID,
  });
  assert.ok(!("intake" in ctx) && !("sales" in ctx) && !("next30Days" in ctx),
    "no sections → no per-slide facts in the context");

  // Task #4983 — the context carries the SAME three-tier-resolved missed-call
  // value the card displays (bucket recompute → stored > 0 → omitted), so a
  // drafted verdict can never cite a rate the deck renders as "No data",
  // contradict a pushed rate with a fabricated 0%, or quote a stale stored
  // value the card overrides with the bucket recompute.
  const mkSections = (intakeData: unknown, marketingData: unknown) => [
    { sectionKey: "intake", data: intakeData },
    { sectionKey: "marketing", data: marketingData },
  ];
  // Cambridge class (prod-pinned, replica 2026-08-18): lead volume but no
  // counted missed call and a write-path-stamped 0 → the fact is OMITTED.
  const cambridgeCtx = buildSlideVerdictContext({
    reportMonth: "2026-07",
    sections: mkSections(
      { totalConsults: 12, missedCallRate: 0 },
      { totalLeads: 340, googleAds: { uniqueLeads: 120, leadQuality: { good: 40, missedCalls: 0 } } },
    ),
    reportId: REPORT_ID,
  });
  assert.equal(
    (cambridgeCtx.intake as any)?.missedCallRate,
    undefined,
    "no missed-call evidence → the fabricated 0% never becomes a prompt fact",
  );
  assert.ok(
    !JSON.stringify(cambridgeCtx).includes('"missedCallRate"'),
    "the omitted key serializes out of the prompt JSON entirely",
  );
  // Parman class: pushed 9.5 with all-zero buckets → the pushed rate IS the
  // fact the model sees (matching the card).
  const parmanCtx = buildSlideVerdictContext({
    reportMonth: "2026-07",
    sections: mkSections(
      { totalConsults: 9, missedCallRate: 9.5 },
      { totalLeads: 137, leadQuality: { good: 0, missedCalls: 0 } },
    ),
    reportId: REPORT_ID,
  });
  assert.equal((parmanCtx.intake as any)?.missedCallRate, 9.5, "pushed rate reaches the prompt");
  // Bucket-backed months RECOMPUTE from the buckets — the absurd stored 5300
  // is ignored and the same-lead-set recompute itself clamps (53 missed over
  // 1 lead is legacy junk data) so nothing absurd reaches the prompt raw.
  const bucketCtx = buildSlideVerdictContext({
    reportMonth: "2026-06",
    sections: mkSections(
      { missedCallRate: 5300 },
      { totalLeads: 1, leadQuality: { missedCalls: 53 } },
    ),
    reportId: REPORT_ID,
  });
  assert.equal((bucketCtx.intake as any)?.missedCallRate, 100, "bucket-backed month recomputes, clamped to 100");
  // THE review-caught divergence class: an in-range stored rate that
  // CONFLICTS with the buckets. The card shows the 25% recompute (5 of 20),
  // so the prompt must see 25 — never the stale stored 55.
  const staleStoredCtx = buildSlideVerdictContext({
    reportMonth: "2026-06",
    sections: mkSections(
      { missedCallRate: 55 },
      { totalLeads: 20, googleAds: { leadQuality: { missedCalls: 5 } } },
    ),
    reportId: REPORT_ID,
  });
  assert.equal(
    (staleStoredCtx.intake as any)?.missedCallRate,
    25,
    "bucket-backed months feed the prompt the recompute, never a conflicting stored rate",
  );
  // A stale stored 0 never masks counted missed calls either (2 of 8 → 25).
  const zeroEvidenceCtx = buildSlideVerdictContext({
    reportMonth: "2026-06",
    sections: mkSections(
      { missedCallRate: 0 },
      { totalLeads: 8, gbpLocations: [{ leadQuality: { missedCalls: 2 } }] },
    ),
    reportId: REPORT_ID,
  });
  assert.equal((zeroEvidenceCtx.intake as any)?.missedCallRate, 25, "stored 0 with counted missed calls → the recompute");
  // hideOtherLeads reaches the resolution: with Other's calls hidden the
  // month has no missed-call numerator left, so the fact is omitted — the
  // same lead set the client's card displays.
  const hideOtherSections = mkSections(
    { missedCallRate: 0 },
    { totalLeads: 30, googleAds: { leadQuality: { missedCalls: 0 } }, otherLeads: { count: 10, leadQuality: { missedCalls: 4 } } },
  );
  const otherShownCtx = buildSlideVerdictContext({
    reportMonth: "2026-06",
    sections: hideOtherSections,
    reportId: REPORT_ID,
  });
  assert.equal(
    (otherShownCtx.intake as any)?.missedCallRate,
    13.3,
    "Other-bucket missed calls recompute when the client displays Other (4 of 30)",
  );
  const otherHiddenCtx = buildSlideVerdictContext({
    reportMonth: "2026-06",
    sections: hideOtherSections,
    reportId: REPORT_ID,
    hideOtherLeads: true,
  });
  assert.equal(
    (otherHiddenCtx.intake as any)?.missedCallRate,
    undefined,
    "hideOtherLeads drops Other from BOTH sides — no evidence left, fact omitted like the card's No data",
  );

  console.log("service: on-demand draft generator units PASSED");
}

// ------------------------------------------- 5. share + demo public paths
async function publicPayloadTests(isoDb: any, baseUrl: string): Promise<void> {
  await isoDb.execute(sql`
    UPDATE reports SET share_token = ${SHARE_TOKEN} WHERE id = ${REPORT_ID}
  `);
  // The stored row still carries the raw legacy lifetimeValue key planted in
  // the finalize lane (pre-#4902 rows look exactly like this until the purge
  // prod action runs) — the SERVED maps must drop it while keeping the
  // operator's line.
  const rawStored = (await readVerdictRow(isoDb, REPORT_ID))?.verdicts;
  assert.equal(
    rawStored?.lifetimeValue,
    "TBD",
    "fixture sanity: raw stored row still carries the retired legacy key",
  );
  const expected = { intake: HEALTHY_VERDICT };

  // Any OpenAI call on these anonymous paths must blow up the test.
  singletonCalls = 0;
  mockOpenAiThrows();
  try {
    const share = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
    assert.equal(share.status, 200, `share fetch: expected 200, got ${share.status}`);
    const shareBody: any = await share.json();
    assert.deepEqual(
      shareBody.slideVerdicts,
      expected,
      "share payload serves the operator verdicts and DROPS the retired lifetimeValue key",
    );
    for (const internalKey of [SLIDE_VERDICTS_SECTION_KEY, SEASONAL_TRENDS_AI_SECTION_KEY]) {
      assert.ok(
        !(shareBody.sections ?? []).some((s: any) => s?.sectionKey === internalKey),
        `internal ${internalKey} row is stripped from served share sections`,
      );
    }

    const demo = await fetch(`${baseUrl}/api/demo-report`);
    assert.equal(demo.status, 200, `demo fetch: expected 200, got ${demo.status}`);
    const demoBody: any = await demo.json();
    assert.equal(
      demoBody.report?.id,
      REPORT_ID,
      "fixture sanity: demo fallback serves the newest demo report",
    );
    assert.deepEqual(
      demoBody.slideVerdicts,
      expected,
      "demo payload serves the operator verdicts and DROPS the retired lifetimeValue key",
    );
    for (const internalKey of [SLIDE_VERDICTS_SECTION_KEY, SEASONAL_TRENDS_AI_SECTION_KEY]) {
      assert.ok(
        !(demoBody.sections ?? []).some((s: any) => s?.sectionKey === internalKey),
        `internal ${internalKey} row is stripped from served demo sections`,
      );
    }

    assert.equal(singletonCalls, 0, "ZERO OpenAI calls on the anonymous share/demo paths");
  } finally {
    restoreOpenAi();
  }

  console.log("route: share/demo stored-copy serving + internal-row strip PASSED");
}

// ------------------------------------------------------ 6. draft endpoint
async function draftEndpointTests(
  isoDb: any,
  baseUrl: string,
  unauthBaseUrl: string,
): Promise<void> {
  const draft = (base: string, body: unknown) =>
    fetch(`${base}/api/reports/${PLAIN_REPORT_ID}/verdicts/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // Anonymous → 401 (authenticated trigger only; anonymous viewers can
  // never mint AI drafts).
  singletonCalls = 0;
  mockOpenAiThrows();
  try {
    const anon = await draft(unauthBaseUrl, { slideKey: "intake" });
    assert.equal(anon.status, 401, `anonymous draft: expected 401, got ${anon.status}`);
    assert.equal(singletonCalls, 0, "anonymous draft never reaches OpenAI");
  } finally {
    restoreOpenAi();
  }

  // Bad slideKey → 400 before any AI call. The retired lifetimeValue slot
  // (Task #4902) is now just another unknown key — the operator can never
  // mint an LV draft again.
  mockOpenAiThrows();
  try {
    for (const slideKey of ["notASlide", "lifetimeValue"]) {
      const bad = await draft(baseUrl, { slideKey });
      assert.equal(bad.status, 400, `bad slideKey ${slideKey}: expected 400, got ${bad.status}`);
    }
    assert.equal(singletonCalls, 0, "rejected slideKeys never reach OpenAI");
  } finally {
    restoreOpenAi();
  }

  // Happy path: returns the sentence WITHOUT storing it (operator applies
  // it in the form; the save flows through the section PUT).
  const draftedSentence = "Sales stalled at the consult stage — no-show calls are the fix.";
  mockOpenAiReturns(JSON.stringify({ sales: draftedSentence }));
  try {
    const ok = await draft(baseUrl, { slideKey: "sales" });
    const okBody: any = await ok.json().catch(() => ({}));
    assert.equal(ok.status, 200, `draft: expected 200, got ${ok.status} body=${JSON.stringify(okBody)}`);
    assert.equal(okBody.verdict, draftedSentence, "returns the drafted sentence");
    assert.equal(
      await readVerdictRow(isoDb, PLAIN_REPORT_ID),
      null,
      "draft endpoint stores NOTHING (human applies + saves)",
    );
  } finally {
    restoreOpenAi();
  }

  // Degenerate AI output → 502, still nothing stored.
  mockOpenAiReturns(JSON.stringify({ sales: "TBD" }));
  try {
    const junk = await draft(baseUrl, { slideKey: "sales" });
    const junkBody: any = await junk.json().catch(() => ({}));
    assert.equal(junk.status, 502, `degenerate draft: expected 502, got ${junk.status}`);
    assert.equal(junkBody.error, "verdict_generation_failed", "names the failure");
    assert.equal(await readVerdictRow(isoDb, PLAIN_REPORT_ID), null, "nothing stored on 502");
  } finally {
    restoreOpenAi();
  }

  console.log("route: verdicts/draft endpoint PASSED");
}

// -------------------------------------------------------------------- run
async function run(): Promise<void> {
  try {
    unitTests();
    await draftGeneratorUnitTests();

    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);
        __test_markUserReconciled(OWNER_ID, {
          id: OWNER_ID,
          email: `${OWNER_ID}@example.com`,
          firstName: "Verdict",
          lastName: "Author",
          role: "ceo",
        });
        const authedApp = buildApp(true);
        const unauthApp = buildApp(false);
        const authed = await listen(authedApp);
        const unauth = await listen(unauthApp);
        try {
          await sectionPutTests(isoDb, authed.baseUrl);
          await finalizeGateTests(isoDb, authed.baseUrl);
          await publicPayloadTests(isoDb, authed.baseUrl);
          await draftEndpointTests(isoDb, authed.baseUrl, unauth.baseUrl);
        } finally {
          __test_resetReconciledUsers();
          await closeServer(authed.server);
          await closeServer(unauth.server);
        }
      },
      {
        tables: [
          "users",
          "clients",
          "command_panels",
          "client_locations",
          "client_data_access",
          "reports",
          "report_sections",
          "report_section_history",
          "user_notifications",
          "system_settings",
          "ceo_pulses",
        ],
        pinGetDbForCrossAsync: true,
      },
    );

    console.log("report-slide-verdicts: PASSED");
  } finally {
    restoreOpenAi();
    await getGlobalDispatcher().close().catch(() => undefined);
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("report-slide-verdicts: FAILED", err);
    process.exitCode = 1;
  });
