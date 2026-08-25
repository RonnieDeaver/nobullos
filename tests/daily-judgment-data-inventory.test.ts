/* test-registration
{
  "name": "Daily judgment data-availability inventory e2e — tiered generation, Task #98 guard, null sub-scores, carry-forward, cron sweep, regenerate route, summaries basis (Task #3697), tier-gate persistence (Task #4761)",
  "regression": true,
  "sweepOnlyReason": "Task #3697: DB-heavy e2e (seeds clients/comms/reports in the shared dev DB, mounts real agent+client routes, ~40s); the pure policy core gates via tests/daily-judgment-tiering-pure.test.ts in SMOKE_FILES",
  "timeoutMs": 180000,
  "tier": "small"
}
test-registration */
/**
 * Task #3697 — data-availability-aware daily judgments, end to end against
 * the real generation flow + routes:
 *
 *   1. FULL tier: a client WITH recent comms generates a judgment whose
 *      persisted `dataSourcesSummary` carries the inventory (tier, basedOn,
 *      missing, fingerprint), `communicationsAnalyzed` counts the analyzed
 *      window, legacy display columns stay in lockstep, and agent-memory
 *      fact extraction RUNS (comms exist).
 *   2. OPERATIONAL tier: a client with a report + command panel but ZERO
 *      comms is judged (no more binary skip). The prompt carries the
 *      manifest + operational paragraph; fact extraction is SKIPPED (Task
 *      #98 guard); sentiment is hard-nulled even when the model returns a
 *      number; garbage score values persist as null in BOTH the judgment and
 *      the relationship-signal row; High confidence is downgraded to Medium.
 *   3. EMPTY client → JudgmentSkippedError (the only true "No data").
 *   4. Cron tiering: runDailyJudgmentCron over [full, operational, empty]
 *      scoped via onlyClientIds → { processed: 2, skipped: 1 }.
 *   5. Carry-forward: unchanged inputs the next day → no AI call, status
 *      copied, dataSourcesSummary.carriedForward.fromDate set, signal row
 *      mirrored; a NEW comm changes the fingerprint → fresh generation.
 *   6. Regenerate route: POST /api/clients/:id/judgments/regenerate now
 *      accepts a sparse-data (no-comms) client (200) and 422s ONLY for a
 *      truly-empty client via the JudgmentSkippedError mapping.
 *   7. Summaries API: GET /api/dashboard/client-summaries returns
 *      judgmentBasis {tier, basedOn, missing, carriedForward} +
 *      judgmentConfidence for the health column tooltip.
 *   8. Tier gate persistence (Task #4761): a model "Critical" whose only
 *      citation is fabricated is STORED as Watch with risk clamped into the
 *      Watch band and the proposal+rule audited in dataSourcesSummary.tierGate;
 *      a verbatim client cancel quote keeps Critical with its risk intact.
 *
 * Determinism: the AI call and the fact extractor are swapped through the
 * module's own `__test_setJudgmentChatCreate` / `__test_setJudgmentFactExtractor`
 * seams (ESM named exports can't be monkey-patched). All rows are seeded in
 * the shared dev DB (`runWithWorkerDb` bypasses tx sandboxes) with per-run
 * random-suffixed ids and deleted in `finally`.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express from "express";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

import { db, closeDbPools } from "../server/db";
import {
  clients,
  users,
  rawCommunicationRecords,
  reports,
  commandPanels,
  clientDailyJudgments,
  clientRelationshipSignals,
  clientOpenAsks,
} from "@shared/schema";
import {
  generateDailyJudgment,
  generateDailyJudgmentDetailed,
  runDailyJudgmentCron,
  JudgmentSkippedError,
  __test_setJudgmentChatCreate,
  __test_setJudgmentFactExtractor,
} from "../server/services/dailyJudgment";
import { registerAgentRoutes } from "../server/routes/agents";
import { registerClientRoutes } from "../server/routes/clients";

const RUN = randomBytes(4).toString("hex");
const AM_USER_ID = `dj3697-am-${RUN}`;
const OWNER_USER_ID = `dj3697-own-${RUN}`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── AI + extractor seams ────────────────────────────────────────────────────

const aiCalls: Array<{ system: string; user: string }> = [];
let nextAiResponse: Record<string, unknown> = {};

function cannedAiResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    overallStatus: "Watch",
    relationshipStatus: "Stable",
    confidenceLevel: "High",
    summary: "Test summary from stubbed model.",
    sentimentSummary: "Test sentiment summary.",
    whatChanged: [],
    concerns: [],
    unresolvedAsks: [],
    wins: [],
    recommendedActions: [],
    scores: {
      relationshipHealth: 70,
      sentiment: 42,
      complaint: 10,
      trust: 65,
      responsivenessRisk: 20,
      executionRisk: 15,
      leadVolumeConcern: null,
      unresolvedTaskRisk: 5,
      overallRisk: 25,
    },
    openAskUpdates: [],
    newAsks: [],
    ...overrides,
  };
}

const extractorCalls: Array<{ clientId: string }> = [];

function installSeams(): void {
  __test_setJudgmentChatCreate(async (params) => {
    aiCalls.push({
      system: params.messages[0]?.content ?? "",
      user: params.messages[1]?.content ?? "",
    });
    return { choices: [{ message: { content: JSON.stringify(nextAiResponse) } }] };
  });
  __test_setJudgmentFactExtractor(async (clientId) => {
    extractorCalls.push({ clientId });
    return 0;
  });
}

// ─── seeding helpers ─────────────────────────────────────────────────────────

const createdClientIds: string[] = [];

async function seedClient(label: string, ownerId?: string): Promise<string> {
  const [c] = await db
    .insert(clients)
    .values({
      firmName: `DJ3697 ${label} ${RUN}`,
      ownerId: ownerId ?? null,
      contactEmail: "client@dj3697.test",
      emailDomains: ["dj3697.test"],
    })
    .returning({ id: clients.id });
  createdClientIds.push(c.id);
  return c.id;
}

async function seedComm(clientId: string, timestamp: Date): Promise<void> {
  // Band math: endAt = targetDate T23:59:59.999Z, startAt24h = endAt − 24h,
  // windowStartAt30d = endAt − 30d.  Pass a timestamp whose UTC *date* matches
  // the targetDate you'll supply to generation — never `Date.now() − Nh` when
  // N ≤ 2 unless targetDate is explicitly pinned to the seed's UTC day, or a
  // run between 00:00–02:00 UTC will place the seed on the PREVIOUS day and
  // silently shift its band membership (24h → 7d, 7d → 30d, etc.).
  await db.insert(rawCommunicationRecords).values({
    clientId,
    sourceType: "front_email",
    sourceSubtype: "email_message",
    direction: "inbound",
    title: `DJ3697 comm ${RUN}`,
    timestamp,
    contentText: "We are frustrated that the campaign update is still missing.",
    contentPreview: "We are frustrated that the campaign update is still missing.",
    participantsJson: [{ email: "client@dj3697.test", role: "author" }],
    matchStatus: "matched",
  });
}

async function seedReport(clientId: string, reportMonth: string): Promise<void> {
  await db.insert(reports).values({ clientId, reportMonth, status: "final" });
}

async function seedPanel(clientId: string): Promise<void> {
  await db.insert(commandPanels).values({
    clientId,
    quarterPrimaryObjective: "Dominate the local PI market this quarter.",
  });
}

async function readSignal(clientId: string, signalDate: string) {
  const rows = await db
    .select()
    .from(clientRelationshipSignals)
    .where(eq(clientRelationshipSignals.clientId, clientId));
  return rows.find((r) => r.signalDate === signalDate) ?? null;
}

// ─── tests ───────────────────────────────────────────────────────────────────

async function testFullTier(clientId: string, targetDate: string): Promise<void> {
  console.log("\nFull tier — comms client:");
  nextAiResponse = cannedAiResponse();
  const aiBefore = aiCalls.length;
  const extractBefore = extractorCalls.length;

  const result = await generateDailyJudgmentDetailed(clientId, { targetDate });
  check("outcome generated", result.outcome === "generated");
  check("tier full", result.tier === "full");
  check("AI called once", aiCalls.length === aiBefore + 1);
  check("fact extraction RAN (comms exist)", extractorCalls.length === extractBefore + 1 && extractorCalls[extractorCalls.length - 1]?.clientId === clientId);

  const prompt = aiCalls[aiCalls.length - 1]?.user ?? "";
  check("prompt carries the availability manifest", prompt.includes("=== DATA AVAILABILITY MANIFEST ==="));
  check("prompt lists the comm counts", prompt.includes("2 matched in last 30 days"));
  check("prompt is NOT operational-basis", !prompt.includes("THIS IS AN OPERATIONAL-BASIS JUDGMENT"));

  const j = result.judgment;
  const summary = j.dataSourcesSummary as any;
  check("dataSourcesSummary.tier = full", summary?.tier === "full");
  check("dataSourcesSummary.inputsFingerprint present", typeof summary?.inputsFingerprint === "string" && summary.inputsFingerprint.length === 64);
  check("basedOn includes comms", Array.isArray(summary?.basedOn) && summary.basedOn.includes("2 comms (30d)"), JSON.stringify(summary?.basedOn));
  check("missing includes absent sources", Array.isArray(summary?.missing) && summary.missing.includes("no monthly report"));
  // Both seeded comms (2h and 10d old) fall inside the analyzed 30-day window,
  // so the analyzed count matches the tier/manifest count — that alignment is
  // the point: whatever the basis claims, the model actually saw.
  check("communicationsAnalyzed counts the full 30d window", j.communicationsAnalyzed === 2, String(j.communicationsAnalyzed));
  check("older comm content actually reaches the prompt", prompt.includes("EARLIER IN THE ANALYZED WINDOW"));
  check("sentiment persisted when comms exist", j.sentimentScore === 42);
  check("legacy relationshipHealth in lockstep", j.relationshipHealth === "Stable" && j.relationshipStatus === "Stable");
  check("full tier keeps High confidence", j.confidence === "High" && j.confidenceLevel === "High");

  const signal = await readSignal(clientId, j.judgmentDate);
  check("signal row written with grounded scores", signal?.sentimentScore === 42 && signal?.trustScore === 65);
  check("ungrounded leadVolumeConcern null in signal", signal !== null && signal.leadVolumeConcernScore === null);
}

async function testOperationalTier(clientId: string): Promise<void> {
  console.log("\nOperational tier — report + panel, zero comms:");
  nextAiResponse = cannedAiResponse({
    confidenceLevel: "High", // must be downgraded
    scores: {
      relationshipHealth: 55,
      sentiment: 88, // model misbehaves — must be hard-nulled (no comms)
      complaint: null,
      trust: "not a number", // garbage — must persist as null
      responsivenessRisk: null,
      executionRisk: null,
      leadVolumeConcern: null,
      unresolvedTaskRisk: null,
      overallRisk: 40,
    },
  });
  const aiBefore = aiCalls.length;
  const extractBefore = extractorCalls.length;

  const result = await generateDailyJudgmentDetailed(clientId, {});
  check("outcome generated (no skip despite zero comms)", result.outcome === "generated");
  check("tier operational", result.tier === "operational");
  check("AI called", aiCalls.length === aiBefore + 1);
  check("fact extraction SKIPPED (Task #98 guard)", extractorCalls.length === extractBefore);

  const prompt = aiCalls[aiCalls.length - 1]?.user ?? "";
  check("prompt flags operational basis", prompt.includes("THIS IS AN OPERATIONAL-BASIS JUDGMENT"));
  check("prompt marks missing comms as UNKNOWN-not-evidence", prompt.includes("treat as UNKNOWN — never as evidence of a problem"));

  const j = result.judgment;
  const summary = j.dataSourcesSummary as any;
  check("dataSourcesSummary.tier = operational", summary?.tier === "operational");
  check("basedOn lists report + panel", Array.isArray(summary?.basedOn) && summary.basedOn.includes("Jun 2026 report") && summary.basedOn.includes("command panel"), JSON.stringify(summary?.basedOn));
  check("missing records never-matched comms", Array.isArray(summary?.missing) && summary.missing.includes("no comms ever matched"));
  check("sentiment hard-nulled with zero comms", j.sentimentScore === null);
  check("High confidence downgraded to Medium", j.confidence === "Medium" && j.confidenceLevel === "Medium");
  check("communicationsAnalyzed = 0", j.communicationsAnalyzed === 0);

  const signal = await readSignal(clientId, j.judgmentDate);
  check("signal sentiment null (not mid-range)", signal !== null && signal.sentimentScore === null);
  check("signal garbage trust persisted as null", signal !== null && signal.trustScore === null);
  check("signal grounded score kept", signal?.relationshipHealthScore === 55);
}

async function testEmptyClientSkips(clientId: string): Promise<void> {
  console.log("\nEmpty client — no usable sources:");
  const aiBefore = aiCalls.length;
  let threw: unknown = null;
  try {
    await generateDailyJudgment(clientId);
  } catch (err) {
    threw = err;
  }
  check("throws JudgmentSkippedError", threw instanceof JudgmentSkippedError);
  check("error name survives (route mapping key)", (threw as any)?.name === "JudgmentSkippedError");
  check("message names the missing sources", String((threw as any)?.message ?? "").includes("No usable data sources"));
  check("no AI call burned", aiCalls.length === aiBefore);
}

async function testStaleCommsFullTier(): Promise<void> {
  // Completion-review case: the ONLY comm sits in the 8-30 day band. Because
  // the tier and manifest count the 30-day window, the model must actually
  // receive that comm — full tier with an empty prompt would overstate the
  // basis. So: content in prompt, sentiment grounded, extraction runs.
  console.log("\nFull tier — single comm 12 days old (8-30d band):");
  const staleClient = await seedClient("Stale");
  await db.insert(rawCommunicationRecords).values({
    clientId: staleClient,
    sourceType: "email",
    title: `DJ3697 stale comm ${RUN}`,
    timestamp: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000),
    contentText: `Unique stale-window marker ${RUN}: client asked about intake volumes.`,
    aiSummary: `Stale-window summary ${RUN}: client asked about intake volumes.`,
    matchStatus: "matched",
  });
  nextAiResponse = cannedAiResponse();
  const aiBefore = aiCalls.length;
  const extractBefore = extractorCalls.length;

  const result = await generateDailyJudgmentDetailed(staleClient, {});
  check("tier full (comm inside 30d)", result.tier === "full");
  check("outcome generated", result.outcome === "generated");
  check("AI called once", aiCalls.length === aiBefore + 1);
  check("fact extraction RAN for 12d-old comm", extractorCalls.length === extractBefore + 1);

  const prompt = aiCalls[aiCalls.length - 1]?.user ?? "";
  // Older-window comms render compactly (title + AI summary — no raw content
  // preview); the point is the RECORD and its substance reach the model.
  check("the 12d-old comm reaches the prompt", prompt.includes(`DJ3697 stale comm ${RUN}`));
  check("its summary content reaches the prompt", prompt.includes(`Stale-window summary ${RUN}`));
  check("rendered under the analyzed-window section", prompt.includes("EARLIER IN THE ANALYZED WINDOW"));
  check("not flagged operational", !prompt.includes("THIS IS AN OPERATIONAL-BASIS JUDGMENT"));

  const j = result.judgment;
  check("communicationsAnalyzed = 1", j.communicationsAnalyzed === 1, String(j.communicationsAnalyzed));
  check("sentiment grounded, not forced null", j.sentimentScore === 42);
  const summary = j.dataSourcesSummary as any;
  check("basis claims exactly the analyzed comm", Array.isArray(summary?.basedOn) && summary.basedOn.includes("1 comm (30d)"), JSON.stringify(summary?.basedOn));
}

async function testOrphanedCommsDontCount(): Promise<void> {
  // Predicate alignment: retrieval excludes matchStatus='orphaned', so the
  // inventory counts must too — a client with ONLY orphaned rows and no other
  // source is truly empty (skip), never a phantom "full" basis.
  console.log("\nOrphaned-only comms — counts share the retrieval predicate:");
  const orphanClient = await seedClient("Orphan");
  await db.insert(rawCommunicationRecords).values({
    clientId: orphanClient,
    sourceType: "email",
    title: `DJ3697 orphaned comm ${RUN}`,
    timestamp: new Date(Date.now() - 60 * 60 * 1000),
    contentText: "Orphaned row that must never be analyzed or counted.",
    matchStatus: "orphaned",
  });
  const aiBefore = aiCalls.length;
  let threw: unknown = null;
  try {
    await generateDailyJudgment(orphanClient);
  } catch (err) {
    threw = err;
  }
  check("orphaned-only client skipped", threw instanceof JudgmentSkippedError);
  check("no AI call for orphaned-only client", aiCalls.length === aiBefore);
}

async function testCronTiering(fullId: string, opsId: string, emptyId: string): Promise<void> {
  console.log("\nCron sweep — tiered outcomes:");
  nextAiResponse = cannedAiResponse();
  const aiBefore = aiCalls.length;

  const result = await runDailyJudgmentCron({
    onlyClientIds: [fullId, opsId, emptyId],
    interJudgmentSleepMs: 0,
  });
  check("processed 2 (full + operational)", result.processed === 2, JSON.stringify(result));
  check("skipped 1 (empty)", result.skipped === 1);
  check("no errors", result.errors === 0);
  check("no carry-forward on first run", result.carriedForward === 0);
  check("AI called exactly twice", aiCalls.length === aiBefore + 2);
}

async function testCarryForward(clientId: string): Promise<void> {
  console.log("\nCarry-forward — unchanged inputs skip the AI call:");
  const day1 = "2026-07-20";
  const day2 = "2026-07-21";
  // Task #4761: "At Risk" must survive the deterministic tier gate, so the
  // canned response cites validated evidence — attributable client-authored
  // Content, never an inbound transport direction or subject alone.
  nextAiResponse = cannedAiResponse({
    overallStatus: "At Risk",
    relationshipStatus: "Strained",
    churnEvidence: [
      {
        category: "expressed_dissatisfaction",
        quote: "We are frustrated that the campaign update is still missing",
        source: "communications",
        date: day1,
      },
    ],
  });

  const r1 = await generateDailyJudgmentDetailed(clientId, { targetDate: day1 });
  check("day 1 generated", r1.outcome === "generated" && r1.judgment.judgmentDate === day1);
  const gate1 = (r1.judgment.dataSourcesSummary as any)?.tierGate;
  check("day 1 status came through the gate on validated evidence", gate1?.finalStatus === "At Risk" && gate1?.evidence?.validCount === 1, JSON.stringify(gate1?.evidence));

  const aiBefore = aiCalls.length;
  const r2 = await generateDailyJudgmentDetailed(clientId, { targetDate: day2 });
  check("day 2 carried forward", r2.outcome === "carried_forward");
  check("no AI call for carry-forward", aiCalls.length === aiBefore);
  check("as-of advanced to day 2", r2.judgment.judgmentDate === day2);
  check("status copied", r2.judgment.status === "At Risk");
  const summary2 = r2.judgment.dataSourcesSummary as any;
  check("carriedForward.fromDate = day 1", summary2?.carriedForward?.fromDate === day1);
  check("carriedForward.fromJudgmentId set", summary2?.carriedForward?.fromJudgmentId === r1.judgment.id);
  check("carriedForward rootDate stays at the generation day", summary2?.carriedForward?.rootDate === day1);
  check("carriedForward rootJudgmentId stays at the generation row", summary2?.carriedForward?.rootJudgmentId === r1.judgment.id);
  check(
    "carriedForward retains a usable root gate audit",
    summary2?.carriedForward?.rootTierGate?.version === gate1?.version &&
      summary2?.carriedForward?.rootTierGate?.finalStatus === "At Risk",
    JSON.stringify(summary2?.carriedForward),
  );

  const signal2 = await readSignal(clientId, day2);
  check("signal row mirrored onto day 2", signal2 !== null && signal2.sentimentScore === r1.judgment.sentimentScore);

  // Same-date rerun with unchanged inputs: returns the existing row, no write.
  const rSame = await generateDailyJudgmentDetailed(clientId, { targetDate: day2 });
  check("same-date rerun stays carried, no AI call", rSame.outcome === "carried_forward" && aiCalls.length === aiBefore);

  // A new comm changes the fingerprint → fresh generation.
  await seedComm(clientId, new Date("2026-07-21T10:00:00.000Z"));
  const r3 = await generateDailyJudgmentDetailed(clientId, { targetDate: day2 });
  check("new comm → regenerated", r3.outcome === "generated");
  check("regeneration called the AI", aiCalls.length === aiBefore + 1);
  const summary3 = r3.judgment.dataSourcesSummary as any;
  check("fresh judgment is not marked carried", !summary3?.carriedForward);
}

async function testMultiHopCarryForward(clientId: string): Promise<void> {
  console.log("\nCarry-forward — root lineage survives multiple hops:");
  const day1 = "2026-07-20";
  const day2 = "2026-07-21";
  const day3 = "2026-07-22";
  nextAiResponse = cannedAiResponse({
    overallStatus: "Watch",
    relationshipStatus: "Stable",
    churnEvidence: [],
  });

  const generated = await generateDailyJudgmentDetailed(clientId, { targetDate: day1 });
  const carry1 = await generateDailyJudgmentDetailed(clientId, { targetDate: day2 });
  const carry2 = await generateDailyJudgmentDetailed(clientId, { targetDate: day3 });
  const summary = carry2.judgment.dataSourcesSummary as any;

  check("multi-hop root generated", generated.outcome === "generated");
  check("first hop carried", carry1.outcome === "carried_forward");
  check("second hop carried", carry2.outcome === "carried_forward");
  check("second hop points to its immediate parent", summary?.carriedForward?.fromJudgmentId === carry1.judgment.id);
  check("second hop preserves the original root id", summary?.carriedForward?.rootJudgmentId === generated.judgment.id);
  check("second hop preserves the original root date", summary?.carriedForward?.rootDate === day1);
  check(
    "second hop preserves the original root gate audit",
    summary?.carriedForward?.rootTierGate?.version ===
      (generated.judgment.dataSourcesSummary as any)?.tierGate?.version,
    JSON.stringify(summary?.carriedForward),
  );

  const app = makeAuthedApp(AM_USER_ID);
  registerAgentRoutes(app);
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/judgments?limit=10`);
    const rows: any[] = await res.json();
    const servedCarry = rows.find((row) => row.id === carry2.judgment.id);
    check("judgment stream route serves bounded authoritative rating", res.status === 200 && Boolean(servedCarry?.rating));
    check("served rating keeps overall health separate from relationship", servedCarry?.rating?.status === carry2.judgment.status && servedCarry?.rating?.relationship === carry2.judgment.relationshipHealth, JSON.stringify(servedCarry?.rating));
    check("served carried rating names its generation lineage", servedCarry?.rating?.generation === "carried-forward" && servedCarry?.rating?.lineage?.rootJudgmentId === generated.judgment.id && servedCarry?.rating?.lineage?.fromJudgmentId === carry1.judgment.id, JSON.stringify(servedCarry?.rating?.lineage));
    check("served rating includes policy + revision audit", servedCarry?.rating?.policyVersion === summary?.tierGateVersion && servedCarry?.rating?.promptRevision === summary?.promptRevision, JSON.stringify(servedCarry?.rating));
  });
}

function makeAuthedApp(userId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. requireAuth reads the committed,
    // public-schema users seed for the real role/access checks.
    (req as any).__test_clerkUserId = userId;
    next();
  });
  return app;
}

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testRegenerateRoute(sparseId: string, emptyId: string): Promise<void> {
  console.log("\nRegenerate route — sparse ok, empty 422:");
  nextAiResponse = cannedAiResponse();
  const app = makeAuthedApp(AM_USER_ID);
  registerAgentRoutes(app);

  await withServer(app, async (baseUrl) => {
    const okRes = await fetch(`${baseUrl}/api/clients/${sparseId}/judgments/regenerate`, { method: "POST" });
    const okBody: any = await okRes.json();
    check("sparse-data client regenerates (200)", okRes.status === 200, `status ${okRes.status}: ${JSON.stringify(okBody).slice(0, 200)}`);
    check("regenerate returns the judgment row", typeof okBody?.id === "string" && okBody?.clientId === sparseId);

    const emptyRes = await fetch(`${baseUrl}/api/clients/${emptyId}/judgments/regenerate`, { method: "POST" });
    const emptyBody: any = await emptyRes.json();
    check("truly-empty client → 422", emptyRes.status === 422, `status ${emptyRes.status}`);
    check("422 names the missing sources", String(emptyBody?.error ?? "").includes("No usable data sources"));
  });
}

async function testSummariesApi(opsId: string, fullId: string): Promise<void> {
  console.log("\nDashboard client-summaries — basis + confidence exposed:");
  await db.update(clientDailyJudgments)
    .set({ relationshipHealth: null })
    .where(eq(clientDailyJudgments.clientId, fullId));
  const app = makeAuthedApp(OWNER_USER_ID);
  registerClientRoutes(app);

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dashboard/client-summaries`);
    const body: any = await res.json();
    check("summaries 200", res.status === 200, `status ${res.status}`);
    const rows: any[] = Array.isArray(body) ? body : [];
    const ops = rows.find((r) => r.id === opsId);
    const full = rows.find((r) => r.id === fullId);
    check("owner sees both seeded clients", Boolean(ops && full), `got ${rows.length} rows`);
    check("operational client: judgmentBasis.tier", ops?.judgmentBasis?.tier === "operational");
    check("operational client: basedOn array populated", Array.isArray(ops?.judgmentBasis?.basedOn) && ops.judgmentBasis.basedOn.includes("command panel"));
    check("operational client: missing array populated", Array.isArray(ops?.judgmentBasis?.missing) && ops.judgmentBasis.missing.length > 0);
    check("operational client: judgmentConfidence Medium", ops?.judgmentConfidence === "Medium");
    check("full client: judgmentBasis.tier full", full?.judgmentBasis?.tier === "full");
    check("full client: judgmentConfidence High", full?.judgmentConfidence === "High");
    check("full client: bounded authoritative rating exposed", Boolean(full?.accountRating));
    check("full client: account health and relationship are independent fields", full?.accountRating?.status === full?.judgmentStatus && full?.accountRating?.relationship === full?.relationshipHealth, JSON.stringify(full?.accountRating));
    check("dashboard preserves the legacy relationship read when relationship_health is null", full?.relationshipHealth === "Stable", JSON.stringify(full));
    check("full client: rating carries policy and prompt revision", typeof full?.accountRating?.policyVersion === "number" && typeof full?.accountRating?.promptRevision === "string", JSON.stringify(full?.accountRating));
    check("dashboard projection omits detailed evidence payload", !JSON.stringify(full?.accountRating).includes("matchedFragment") && !JSON.stringify(full?.accountRating).includes("quoteFingerprint"), JSON.stringify(full?.accountRating));
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

async function testTierGateEnforcement(): Promise<void> {
  console.log("\nTier gate — deterministic stored status (Task #4761):");

  // A: the model proposes Critical/96 but its only citation is fabricated —
  // the gate treats it as absent evidence, stores Watch with server-derived
  // risk, and audits the proposal + applied rule.
  const gateCap = await seedClient("GateCap");
  // Pin the seed to new Date() and targetDate to today's UTC date: the tier
  // gate evidence corpus bands from targetDate 23:59:59.999Z ± 24h; a −2h
  // seed between 00:00–02:00 UTC would land on the previous day and could
  // place citations in a different corpus tier when future asserts probe it.
  const gateCapNow = new Date();
  await seedComm(gateCap, gateCapNow);
  nextAiResponse = cannedAiResponse({
    overallStatus: "Critical",
    relationshipStatus: "At Risk",
    summary: [
      "This account is Healthy.",
      "The account appropriately sits at Critical.",
      "Overall health is healthy.",
      "Risk remains low.",
      "The relationship remains Strong.",
      "The citation is fabricated, but the operational facts remain useful context.",
    ].join(" "),
    churnEvidence: [
      {
        category: "explicit_churn_language",
        quote: "we are cancelling the contract effective Friday",
        source: "communications",
        date: "2026-08-14",
      },
    ],
    scores: {
      relationshipHealth: 40,
      sentiment: -20,
      complaint: 55,
      trust: 35,
      responsivenessRisk: 60,
      executionRisk: 50,
      leadVolumeConcern: null,
      unresolvedTaskRisk: 30,
      overallRisk: 96,
    },
  });
  const capRes = await generateDailyJudgmentDetailed(gateCap, {
    targetDate: gateCapNow.toISOString().slice(0, 10),
  });
  check("gate-cap judgment generated", capRes.outcome === "generated");
  const capJ = capRes.judgment;
  check(
    "fabricated Critical stored as Watch (both status columns)",
    capJ.status === "Watch" && capJ.overallStatus === "Watch",
    `${capJ.status}/${capJ.overallStatus}`,
  );
  check("stored risk derived independently inside the Watch band", capJ.riskScore === 25, String(capJ.riskScore));
  check(
    "unsupported relationship proposal is not persisted",
    capJ.relationshipStatus === "Stable" && capJ.relationshipHealth === "Stable",
    `${capJ.relationshipStatus}/${capJ.relationshipHealth}`,
  );
  check(
    "persisted summary is server-owned and strips contradictory model ratings",
    capJ.summaryText ===
      "Server verdict: Watch / 25. Relationship: Stable.\n\n" +
        "Supporting context: The citation is fabricated, but the operational facts remain useful context.",
    String(capJ.summaryText),
  );
  const capSummary = capJ.dataSourcesSummary as any;
  const capGate = capSummary?.tierGate;
  check(
    "audit preserves the model's proposal",
    capGate?.proposedStatus === "Critical" && capGate?.proposedOverallRisk === 96,
    JSON.stringify(capGate),
  );
  check(
    "audit records the override + applied rule",
    capGate?.overridden === true && Array.isArray(capGate?.capReasons) && capGate.capReasons.includes("no_validated_negative_evidence"),
    JSON.stringify(capGate?.capReasons),
  );
  check(
    "fabricated citation rejected as not_found_in_inputs",
    capGate?.evidence?.rejectedCount === 1 && capGate?.evidence?.items?.[0]?.rejectReason === "not_found_in_inputs",
    JSON.stringify(capGate?.evidence?.items?.[0]),
  );
  check("inventory carries the calibrated-era marker", typeof capSummary?.tierGateVersion === "number");

  // B: genuine explicit churn language quoted VERBATIM from the CLIENT'S
  // OWN inbound message content → Critical survives, risk intact. (The
  // client-authored scope is the only provenance that unlocks Critical —
  // an aiSummary quote would validate but cap at At Risk.)
  const gateCrit = await seedClient("GateCrit");
  // The comm timestamp and the judgment's targetDate are pinned to the SAME
  // UTC day: the corpus's full-detail band is [targetDate 23:59:59.999Z − 24h,
  // targetDate 23:59:59.999Z], so a `Date.now() − 2h` timestamp seeded between
  // 00:00 and 02:00 UTC lands on the previous day, drops the comm into the
  // older band (title-only in the client-scope corpus), and the cancel quote
  // then validates as internal_context instead of client_communication.
  const gateCritNow = new Date();
  await db.insert(rawCommunicationRecords).values({
    clientId: gateCrit,
    sourceType: "front_email",
    sourceSubtype: "email_message",
    direction: "inbound",
    title: `DJ3697 cancel comm ${RUN}`,
    timestamp: gateCritNow,
    contentText: "We want to cancel the contract next month unless results improve.",
    contentPreview: "We want to cancel the contract next month unless results improve.",
    participantsJson: [{ email: "client@dj3697.test", role: "author" }],
    aiSummary: "Client said they want to cancel the contract next month unless results improve.",
    matchStatus: "matched",
  });
  nextAiResponse = cannedAiResponse({
    overallStatus: "Critical",
    relationshipStatus: "At Risk",
    churnEvidence: [
      {
        category: "explicit_churn_language",
        quote: "want to cancel the contract next month",
        source: "communications",
        date: "2026-08-14",
      },
    ],
    scores: {
      relationshipHealth: 40,
      sentiment: -30,
      complaint: 60,
      trust: 30,
      responsivenessRisk: 55,
      executionRisk: 45,
      leadVolumeConcern: null,
      unresolvedTaskRisk: 35,
      overallRisk: 85,
    },
  });
  const critRes = await generateDailyJudgmentDetailed(gateCrit, {
    targetDate: gateCritNow.toISOString().slice(0, 10),
  });
  check("gate-crit judgment generated", critRes.outcome === "generated");
  const critJ = critRes.judgment;
  check(
    "validated cancel quote keeps Critical",
    critJ.status === "Critical" && critJ.overallStatus === "Critical",
    `${critJ.status}/${critJ.overallStatus}`,
  );
  check("risk derived from accepted Critical evidence, not model 85", critJ.riskScore === 76, String(critJ.riskScore));
  check("direct Critical client evidence grounds relationship At Risk", critJ.relationshipStatus === "At Risk");
  const critGate = (critJ.dataSourcesSummary as any)?.tierGate;
  check(
    "no override — Critical cap earned by validated evidence",
    critGate?.overridden === false && critGate?.cap === "Critical" && critGate?.evidence?.validCount === 1,
    JSON.stringify(critGate),
  );
}

async function main(): Promise<void> {
  installSeams();

  await db.insert(users).values([
    { id: AM_USER_ID, email: `dj3697-am-${RUN}@test.local`, role: "account_manager" },
    { id: OWNER_USER_ID, email: `dj3697-own-${RUN}@test.local`, role: "viewer" },
  ]);

  try {
    // Route/generation fixtures (owned so the summaries API sees them).
    const fullClient = await seedClient("Full", OWNER_USER_ID);
    const now = Date.now();
    // Pin the "recent" comm to new Date() (not now−2h) and pass the matching
    // targetDate to generation: the judgment band is targetDate 23:59:59.999Z
    // ± 24h, so a −2h seed between 00:00–02:00 UTC would land on the PREVIOUS
    // day and silently change 24h/7d/30d band membership (see seedComm comment).
    const fullTodayStr = new Date().toISOString().slice(0, 10);
    await seedComm(fullClient, new Date()); // today → 24h/7d/30d bands
    await seedComm(fullClient, new Date(now - 10 * 24 * 60 * 60 * 1000)); // 10d ago → 30d only

    const opsClient = await seedClient("Ops", OWNER_USER_ID);
    await seedReport(opsClient, "2026-06");
    await seedPanel(opsClient);

    const emptyClient = await seedClient("Empty");

    await testFullTier(fullClient, fullTodayStr);
    await testOperationalTier(opsClient);
    await testEmptyClientSkips(emptyClient);
    await testStaleCommsFullTier();
    await testOrphanedCommsDontCount();

    // Fresh clients for the cron sweep so earlier judgments can't turn
    // "generated" into "carried_forward".
    const cronFull = await seedClient("CronFull");
    // Pin to new Date() so the seed's UTC day always matches the cron's
    // implicit targetDate (today). A −3h seed between 00:00–02:00 UTC would
    // land on the previous day, outside the implicit judgment window bands.
    await seedComm(cronFull, new Date());
    const cronOps = await seedClient("CronOps");
    await seedPanel(cronOps);
    const cronEmpty = await seedClient("CronEmpty");
    await testCronTiering(cronFull, cronOps, cronEmpty);

    const cfClient = await seedClient("Carry");
    // Exact intersection of day1's endAt and day2's startAt24h: the same
    // attributable Content remains in the full-detail band on BOTH days, so
    // this test isolates carry-forward rather than a legitimate band change.
    await seedComm(cfClient, new Date("2026-07-20T23:59:59.999Z"));
    await testCarryForward(cfClient);

    const multiHopClient = await seedClient("CarryMultiHop");
    await seedReport(multiHopClient, "2026-06");
    await seedPanel(multiHopClient);
    await testMultiHopCarryForward(multiHopClient);

    await testTierGateEnforcement();

    await testRegenerateRoute(opsClient, emptyClient);
    await testSummariesApi(opsClient, fullClient);
  } finally {
    __test_setJudgmentChatCreate(null);
    __test_setJudgmentFactExtractor(null);

    try {
      if (createdClientIds.length > 0) {
        await db.delete(clientRelationshipSignals).where(inArray(clientRelationshipSignals.clientId, createdClientIds));
        await db.delete(clientDailyJudgments).where(inArray(clientDailyJudgments.clientId, createdClientIds));
        await db.delete(clientOpenAsks).where(inArray(clientOpenAsks.clientId, createdClientIds));
        await db.delete(rawCommunicationRecords).where(inArray(rawCommunicationRecords.clientId, createdClientIds));
        await db.delete(commandPanels).where(inArray(commandPanels.clientId, createdClientIds));
        await db.delete(reports).where(inArray(reports.clientId, createdClientIds));
        await db.delete(clients).where(inArray(clients.id, createdClientIds));
      }
      await db.delete(users).where(inArray(users.id, [AM_USER_ID, OWNER_USER_ID]));
    } catch (err) {
      console.error("Cleanup failed:", err);
      failed++;
    }

    // Local-server fetches keep undici keep-alive sockets ref'd; close the
    // dispatcher so the process can drain naturally (run-all scores a hang
    // as a SIGKILL FAIL).
    try {
      const undici = await import("undici");
      await undici.getGlobalDispatcher().close();
    } catch {
      /* best-effort */
    }
    await closeDbPools();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err);
  try { await closeDbPools(); } catch { /* best-effort */ }
  process.exitCode = 1;
});
