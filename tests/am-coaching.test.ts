/* test-registration
{
  "name": "Team Coaching trends, sampler attribution + coaching runs (Task #3712)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3712: Team Coaching — the director-only per-AM trend aggregation (owner bucketing, unassigned bucket, complaint-theme guards), the sampler's attribution guarantee (mistakes pinned only on the AM who was verifiably on the call / authored the email; other-staff records excluded), and the coaching-run orchestrator (409 while active, per-AM failure isolation, insufficient-data, demotion of unverified evidence, synthesis index→user-id mapping, completion notification) with the model stubbed. Real routes behind an injected session on the shared dev DB; per-run suffixed seeds with cascade cleanup. A drift here either opens coaching data below director or lets an unverified excerpt get blamed on the wrong person — the exact harm the feature promises not to do.",
  "tier": "small"
}
test-registration */
/**
 * Task #3712 — Team Coaching: trends aggregation, sampler attribution,
 * coaching-run orchestration and authz.
 *
 * Runs the real registerChurnRoutes behind an injected passport-shaped
 * session (tests/churn-leaderboard.test.ts pattern) and covers:
 *
 *   1. Authz — /api/churn/team-trends and /api/churn/coaching/* are STRICT
 *      director+: core/lead get 403 in strict AND permissive mode, director
 *      gets 200, no session gets 401.
 *   2. Trends shape — per-AM buckets grouped by clients.owner_id with
 *      status mix, avg risk, 7/30-day deltas (boundary rows), zoom/email
 *      comm counts and complaint themes exploded from
 *      client_communication_insights (incl. the non-array jsonb guard and
 *      the non-numeric-severity 0.5 fallback); the unassigned bucket is
 *      present, marked, and sorted last; department rollup covers all
 *      active clients.
 *   3. Sampler attribution — an AM's packet contains only calls they were
 *      verifiably on and emails they verifiably authored; another internal
 *      user's call/email is EXCLUDED (not blamed, not context); records
 *      with no identifiable internal actor come back as unattributed
 *      context; inbound emails and sub-minimum transcripts are skipped;
 *      the per-AM email cap holds.
 *   4. Run e2e with a stubbed model — POST starts a background run (202);
 *      a second POST while it runs gets 409 with the active run attached
 *      (the stub gates its first response until the 409 is asserted, so
 *      the overlap is deterministic); per-AM isolation (one AM's model
 *      failure → failed report, run completes); insufficient-data AM gets
 *      an explicit report without any model call; a mistake whose only
 *      evidence is unattributed material is demoted to an unattributed
 *      observation instead of being pinned on the AM; a citation whose
 *      excerpt does not occur in the cited sample's text is rejected, so a
 *      fabricated quote never renders as verbatim evidence; department
 *      synthesis maps AM indexes back to user ids and only keeps a
 *      single-AM pattern via the severity-5 exception (a direct
 *      synthesizeDepartment step proves 2+-AM patterns are kept, deduped
 *      singletons below severity 5 are dropped); the requester gets exactly
 *      one completion notification; run history lists the run with the
 *      requester's name.
 *
 * Seeds use per-run random suffixes and are removed in finally. The
 * permissive-mode switch is pinned and restored (storage.setSystemSetting +
 * __resetPermissiveModeCacheForTests — raw system_settings writes are
 * banned).
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { getGlobalDispatcher } from "undici";
import { and, eq, inArray, like } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { __resetPermissiveModeCacheForTests } from "../server/auth/permissions";
import { registerChurnRoutes } from "../server/routes/churn";
import {
  amCoachingReports,
  amCoachingRuns,
  clientDailyJudgments,
  clientCommunicationInsights,
  clients,
  rawCommunicationRecords,
  userNotifications,
  users,
} from "@shared/schema";
import {
  listCoachedManagers,
  sampleAmCommunications,
  MAX_EMAIL_SAMPLES_PER_AM,
} from "../server/services/amCoachingSampler";
import {
  __test_setCoachingChatCreate,
  synthesizeDepartment,
} from "../server/services/amCoachingAnalysis";
import { __test_awaitCoachingRuns } from "../server/services/amCoachingRun";

const RUN = `t3712-${randomBytes(4).toString("hex")}`;

const DIRECTOR_ID = `${RUN}-director`;
const LEAD_ID = `${RUN}-lead`;
const CORE_ID = `${RUN}-core`;
const AM1_ID = `${RUN}-am1`;
const AM2_ID = `${RUN}-am2`;
const AM3_ID = `${RUN}-am3`;
const AM4_ID = `${RUN}-am4-deleted`;
const OTHER_INTERNAL_ID = `${RUN}-other`;

const AM1_EMAIL = `${RUN}-am1@t3712.example`;
const AM2_EMAIL = `${RUN}-am2@t3712.example`;
const AM3_EMAIL = `${RUN}-am3@t3712.example`;
const OTHER_EMAIL = `${RUN}-other@t3712.example`;

const C_AM1_A = `${RUN}-c-am1-a`;
const C_AM1_B = `${RUN}-c-am1-b`;
const C_AM2 = `${RUN}-c-am2`;
const C_AM3 = `${RUN}-c-am3`;
const C_UNOWNED = `${RUN}-c-unowned`;
const C_ARCHIVED = `${RUN}-c-archived`;
const C_AM4 = `${RUN}-c-am4`;

const PERMISSIVE_KEY = "role_permissions_permissive_mode";

// Record ids referenced across the sampler + e2e sections.
const Z1 = `${RUN}-z1`; // AM1 verifiably on call (newest attributed zoom)
const Z2 = `${RUN}-z2`; // AM1 verifiably on call
const Z3 = `${RUN}-z3`; // OTHER internal user's call → excluded
const Z4 = `${RUN}-z4`; // externals only → unattributed context
const Z5 = `${RUN}-z5`; // AM1 on call but transcript under the minimum → skipped
const E1 = `${RUN}-e1`; // AM1 authored (message-grain role "author")
const E2 = `${RUN}-e2`; // AM1 authored
const E3 = `${RUN}-e3`; // OTHER internal authored → excluded
const E4 = `${RUN}-e4`; // no author participant → unattributed context
const E5 = `${RUN}-e5`; // inbound, AM1 as author → skipped by direction filter

const LONG_TRANSCRIPT = `Manager: Thanks for joining today. Client: We are worried about lead volume this month. Manager: Understood, let me walk through the campaign changes and the intake numbers so far. `.repeat(3);
const SHORT_TRANSCRIPT = "Too short to be a usable transcript.";
const EMAIL_BODY = "Following up on our conversation — here is the plan for next month and the two action items we owe you.";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function approx(actual: unknown, expected: number, msg: string): void {
  if (typeof actual !== "number" || Math.abs(actual - expected) > 1e-6) {
    throw new Error(`${msg}: expected ~${expected}, got ${JSON.stringify(actual)}`);
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function dateStr(daysBack: number): string {
  return daysAgo(daysBack).toISOString().slice(0, 10);
}

async function seed(): Promise<void> {
  await db.insert(users).values([
    { id: DIRECTOR_ID, email: `${RUN}-dir@t3712.example`, firstName: "Task3712", lastName: "Director", role: "account_manager", authorityLevel: "director" },
    { id: LEAD_ID, email: `${RUN}-lead@t3712.example`, firstName: "Task3712", lastName: "Lead", role: "team_lead", authorityLevel: "lead" },
    { id: CORE_ID, email: `${RUN}-core@t3712.example`, firstName: "Task3712", lastName: "Core", role: "account_manager", authorityLevel: "core" },
    { id: AM1_ID, email: AM1_EMAIL, firstName: "Task3712", lastName: "AlphaAM", role: "account_manager", authorityLevel: "core" },
    { id: AM2_ID, email: AM2_EMAIL, firstName: "Task3712", lastName: "BravoAM", role: "account_manager", authorityLevel: "core" },
    { id: AM3_ID, email: AM3_EMAIL, firstName: "Task3712", lastName: "CharlieAM", role: "account_manager", authorityLevel: "core" },
    { id: AM4_ID, email: `${RUN}-am4@t3712.example`, firstName: "Task3712", lastName: "DeletedAM", role: "account_manager", authorityLevel: "core", deletedAt: new Date() },
    { id: OTHER_INTERNAL_ID, email: OTHER_EMAIL, firstName: "Task3712", lastName: "OtherStaff", role: "account_manager", authorityLevel: "core" },
  ]);

  await db.insert(clients).values([
    { id: C_AM1_A, firmName: `${RUN} AlphaBook One`, ownerId: AM1_ID, isArchived: false, isDemo: false },
    { id: C_AM1_B, firmName: `${RUN} AlphaBook Two`, ownerId: AM1_ID, isArchived: false, isDemo: false },
    { id: C_AM2, firmName: `${RUN} BravoBook`, ownerId: AM2_ID, isArchived: false, isDemo: false },
    { id: C_AM3, firmName: `${RUN} CharlieBook`, ownerId: AM3_ID, isArchived: false, isDemo: false },
    { id: C_UNOWNED, firmName: `${RUN} Ownerless Firm`, ownerId: null, isArchived: false, isDemo: false },
    { id: C_ARCHIVED, firmName: `${RUN} Archived Firm`, ownerId: AM1_ID, isArchived: true, isDemo: false },
    { id: C_AM4, firmName: `${RUN} DeletedAM Book`, ownerId: AM4_ID, isArchived: false, isDemo: false },
  ]);

  // Judgments. AM1's first client carries baselines exactly 7/30 days back
  // (the <= latest-7/-30 boundary), so delta7 = 80-60 = 20, delta30 = 80-40
  // = 40. AM1's second client is scored with no baselines → bucket avgRisk
  // (80+20)/2 = 50 while the deltas average only the contributing client.
  await db.insert(clientDailyJudgments).values([
    { clientId: C_AM1_A, judgmentDate: dateStr(0), status: "Critical", riskScore: 80, headline: "Escalating" },
    { clientId: C_AM1_A, judgmentDate: dateStr(7), status: "At Risk", riskScore: 60 },
    { clientId: C_AM1_A, judgmentDate: dateStr(30), status: "Watch", riskScore: 40 },
    { clientId: C_AM1_B, judgmentDate: dateStr(0), status: "Watch", riskScore: 20 },
    { clientId: C_AM2, judgmentDate: dateStr(0), status: "Healthy", riskScore: 10 },
    { clientId: C_UNOWNED, judgmentDate: dateStr(0), status: "At Risk", riskScore: 55 },
    // C_AM3 gets no judgments → its bucket shows the noData mix.
  ]);

  const zoomParticipants = (emails: Array<[string, string]>) =>
    emails.map(([email, role]) => ({ name: email.split("@")[0], email, role }));

  await db.insert(rawCommunicationRecords).values([
    // ── Zoom, client C_AM1_A ──
    { id: Z1, clientId: C_AM1_A, sourceType: "zoom", title: `${RUN} Z1 strategy call`, timestamp: daysAgo(2), contentText: LONG_TRANSCRIPT, participantsJson: zoomParticipants([[AM1_EMAIL, "participant"], ["client-a@external.example", "external"]]), processingStatus: "completed", reviewStatus: "reviewed" },
    { id: Z2, clientId: C_AM1_A, sourceType: "zoom", title: `${RUN} Z2 check-in call`, timestamp: daysAgo(3), contentText: LONG_TRANSCRIPT, participantsJson: zoomParticipants([[AM1_EMAIL, "host"], ["client-b@external.example", "external"]]), processingStatus: "completed", reviewStatus: "reviewed" },
    { id: Z3, clientId: C_AM1_A, sourceType: "zoom", title: `${RUN} Z3 other staff call`, timestamp: daysAgo(4), contentText: LONG_TRANSCRIPT, participantsJson: zoomParticipants([[OTHER_EMAIL, "participant"], ["client-c@external.example", "external"]]), processingStatus: "completed", reviewStatus: "reviewed" },
    { id: Z4, clientId: C_AM1_A, sourceType: "zoom", title: `${RUN} Z4 unidentified call`, timestamp: daysAgo(4.5), contentText: LONG_TRANSCRIPT, participantsJson: zoomParticipants([["client-d@external.example", "external"]]), processingStatus: "completed", reviewStatus: "reviewed" },
    { id: Z5, clientId: C_AM1_A, sourceType: "zoom", title: `${RUN} Z5 no transcript`, timestamp: daysAgo(1), contentText: SHORT_TRANSCRIPT, participantsJson: zoomParticipants([[AM1_EMAIL, "participant"]]), processingStatus: "completed", reviewStatus: "reviewed" },
    // ── Email, client C_AM1_A ──
    { id: E1, clientId: C_AM1_A, sourceType: "front_email", title: `${RUN} E1 follow-up`, timestamp: daysAgo(2), direction: "outbound", contentText: EMAIL_BODY, participantsJson: [{ name: "AM1", email: AM1_EMAIL, role: "author" }, { name: "Client", email: "client-a@external.example", role: "recipient" }], processingStatus: "completed", reviewStatus: "reviewed" },
    { id: E2, clientId: C_AM1_A, sourceType: "front_email", title: `${RUN} E2 plan email`, timestamp: daysAgo(3), direction: "outbound", contentText: EMAIL_BODY, participantsJson: [{ name: "AM1", email: AM1_EMAIL, role: "author" }], processingStatus: "completed", reviewStatus: "reviewed" },
    { id: E3, clientId: C_AM1_A, sourceType: "front_email", title: `${RUN} E3 other staff email`, timestamp: daysAgo(4), direction: "outbound", contentText: EMAIL_BODY, participantsJson: [{ name: "Other", email: OTHER_EMAIL, role: "author" }], processingStatus: "completed", reviewStatus: "reviewed" },
    { id: E4, clientId: C_AM1_A, sourceType: "front_email", title: `${RUN} E4 authorless email`, timestamp: daysAgo(5.5), direction: "outbound", contentText: EMAIL_BODY, participantsJson: [{ name: "Client", email: "client-a@external.example", role: "recipient" }], processingStatus: "completed", reviewStatus: "reviewed" },
    { id: E5, clientId: C_AM1_A, sourceType: "front_email", title: `${RUN} E5 inbound`, timestamp: daysAgo(1), direction: "inbound", contentText: EMAIL_BODY, participantsJson: [{ name: "AM1", email: AM1_EMAIL, role: "author" }], processingStatus: "completed", reviewStatus: "reviewed" },
    // ── Email, client C_AM2: cap + thread-grain "team" author role ──
    ...Array.from({ length: MAX_EMAIL_SAMPLES_PER_AM + 2 }, (_, i) => ({
      id: `${RUN}-am2-e${i}`,
      clientId: C_AM2,
      sourceType: "front_email",
      title: `${RUN} AM2 email ${i}`,
      timestamp: daysAgo(1 + i * 0.1),
      direction: "outbound",
      contentText: EMAIL_BODY,
      participantsJson: [{ name: "AM2", email: AM2_EMAIL, role: "team" }, { name: "Client", email: "client-x@external.example", role: "recipient" }],
      processingStatus: "completed",
      reviewStatus: "reviewed",
    })),
    // C_AM3 gets no communications at all → insufficient data.
  ]);

  // Complaint-theme insights hang off C_AM1_A records: two numeric-severity
  // "communication" mentions across Z1+E1, one "results", one non-numeric
  // severity ("high" → 0.5 fallback) and one non-array complaint_themes
  // value the jsonb_typeof guard turns into no rows.
  await db.insert(clientCommunicationInsights).values([
    { clientId: C_AM1_A, rawCommunicationRecordId: Z1, complaintThemes: [{ category: "communication", severity: 0.8, evidence: "unanswered emails" }, { category: "results", severity: 0.6, evidence: "lead volume" }] },
    { clientId: C_AM1_A, rawCommunicationRecordId: E1, complaintThemes: [{ category: "communication", severity: "0.4", evidence: "slow replies" }] },
    { clientId: C_AM1_A, rawCommunicationRecordId: E2, complaintThemes: [{ category: "speed", severity: "high", evidence: "delays" }] },
    { clientId: C_AM1_A, rawCommunicationRecordId: Z2, complaintThemes: "notanarray" },
  ]);
}

async function cleanup(): Promise<void> {
  try {
    await db.delete(userNotifications).where(
      and(eq(userNotifications.userId, DIRECTOR_ID), like(userNotifications.dedupeKey, "am-coaching-run:%")),
    );
  } catch {}
  try {
    // Cascades to am_coaching_reports (runId FK ON DELETE CASCADE).
    await db.delete(amCoachingRuns).where(eq(amCoachingRuns.requestedByUserId, DIRECTOR_ID));
  } catch {}
  try {
    await db.delete(rawCommunicationRecords).where(like(rawCommunicationRecords.id, `${RUN}-%`));
  } catch {}
  try {
    await db.delete(clients).where(
      inArray(clients.id, [C_AM1_A, C_AM1_B, C_AM2, C_AM3, C_UNOWNED, C_ARCHIVED, C_AM4]),
    );
  } catch {}
  try {
    await db.delete(users).where(
      inArray(users.id, [DIRECTOR_ID, LEAD_ID, CORE_ID, AM1_ID, AM2_ID, AM3_ID, AM4_ID, OTHER_INTERNAL_ID]),
    );
  } catch {}
}

let actingUserId: string | null = DIRECTOR_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id (looked up in the committed public-schema
    // users row seeded above); null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerChurnRoutes(app);
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

async function call(
  baseUrl: string,
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${path}`, { method });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
  }
}

async function setPermissive(value: "true" | "false"): Promise<void> {
  await storage.setSystemSetting(PERMISSIVE_KEY, value, "system");
  __resetPermissiveModeCacheForTests();
}

// ── Model stub ──────────────────────────────────────────────────────────────
// Analysis calls resolve by which AM's email appears in the user prompt;
// synthesis calls are recognized by the synthesis system prompt. The gate
// promise holds every analysis response until the 409-overlap assertion has
// run, making "second POST while active" deterministic instead of a race.

let releaseGate: () => void = () => {};
const gate = new Promise<void>((resolve) => {
  releaseGate = resolve;
});
const stubCalls: { kind: string; am: string | null }[] = [];

const AM1_RESPONSE = {
  mistakes: [
    {
      title: "Vague next steps",
      description: "Calls end without owners or dates.",
      severity: 4,
      channel: "zoom",
      evidence: [{ sampleIndex: 0, excerpt: "let me walk through the campaign changes" }],
    },
    {
      // Only evidence is the unattributed sample (index 4 = Z4) → the
      // analysis layer demotes this to an unattributed observation.
      title: "Ghost problem",
      description: "Unverified call shows an unanswered complaint.",
      severity: 5,
      channel: "zoom",
      evidence: [{ sampleIndex: 4, excerpt: "worried about lead volume this month" }],
    },
    {
      // Evidence index out of range → no usable evidence → dropped outright.
      title: "Uncited claim",
      description: "No resolvable evidence.",
      severity: 3,
      channel: "email",
      evidence: [{ sampleIndex: 99, excerpt: "nothing" }],
    },
    {
      // Cites a REAL verified sample but the quote is invented — the
      // excerpt-grounding check rejects the citation, leaving no evidence,
      // so the mistake is dropped outright (never rendered as verbatim).
      title: "Fabricated quote",
      description: "Invented excerpt attributed to a real call.",
      severity: 5,
      channel: "zoom",
      evidence: [{ sampleIndex: 0, excerpt: "you promised the client a full refund yesterday" }],
    },
  ],
  unattributedObservations: [
    {
      title: "Unknown staff over-promised",
      description: "An authorless email promises a rank guarantee.",
      evidence: [{ sampleIndex: 5, excerpt: "here is the plan for next month" }],
    },
  ],
  strengths: [{ title: "Warm rapport", description: "Opens calls personally.", channel: "zoom" }],
  zoomSummary: "Strong rapport, weak call closings.",
  emailSummary: "Emails answer questions but omit deadlines.",
  coachingFocus: "Close every call with named owners and dates.",
};

const DEFAULT_RESPONSE = {
  mistakes: [],
  unattributedObservations: [],
  strengths: [],
  zoomSummary: "No verified Zoom samples.",
  emailSummary: "No verified email samples.",
  coachingFocus: "n/a",
};

const SYNTHESIS_RESPONSE = {
  summary: "The team's shared gap is follow-through discipline.",
  commonMistakes: [
    {
      // Only AM1 has mistakes in this run, so this resolves to a single-AM
      // pattern; severity 5 is what lets it survive the ≥2-AM cardinality
      // guard (the singleton exception the prompt promises).
      title: "Vague next steps",
      description: "Calls and emails end without commitments.",
      severity: 5,
      amIndexes: [0, 99], // 99 is out of range and must be dropped.
    },
  ],
};

function installStub(): void {
  __test_setCoachingChatCreate(async (params) => {
    const system = params.messages[0]?.content ?? "";
    const user = params.messages[1]?.content ?? "";
    if (system.includes("head coach")) {
      stubCalls.push({ kind: "synthesis", am: null });
      return { choices: [{ message: { content: JSON.stringify(SYNTHESIS_RESPONSE) } }] };
    }
    await gate; // hold analyses until the 409 overlap has been asserted
    if (user.includes(AM1_EMAIL)) {
      stubCalls.push({ kind: "analysis", am: AM1_ID });
      return { choices: [{ message: { content: JSON.stringify(AM1_RESPONSE) } }] };
    }
    if (user.includes(AM2_EMAIL)) {
      stubCalls.push({ kind: "analysis", am: AM2_ID });
      throw new Error(`${RUN} synthetic model outage`);
    }
    stubCalls.push({ kind: "analysis", am: null });
    return { choices: [{ message: { content: JSON.stringify(DEFAULT_RESPONSE) } }] };
  });
}

async function main(): Promise<void> {
  console.log(`Team Coaching trends + coaching runs (Task #3712) [${RUN}]`);

  const originalPermissive = await storage.getSystemSetting(PERMISSIVE_KEY);
  await seed();
  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // ── 1. Authz matrix ──────────────────────────────────────────────
    await setPermissive("false");

    await step("strict: core ⇒ 403 on team-trends, lead ⇒ 403 on POST coaching/runs", async () => {
      actingUserId = CORE_ID;
      const trends = await call(baseUrl, "/api/churn/team-trends");
      assertEq(trends.status, 403, "core team-trends status");
      assert(String(trends.json.error).includes("Director"), "403 body names the required level");
      actingUserId = LEAD_ID;
      assertEq((await call(baseUrl, "/api/churn/coaching/runs", "POST")).status, 403, "lead POST runs status");
      assertEq((await call(baseUrl, "/api/churn/coaching/runs")).status, 403, "lead GET runs status");
    });

    await step("permissive mode still refuses below-director", async () => {
      await setPermissive("true");
      actingUserId = CORE_ID;
      assertEq((await call(baseUrl, "/api/churn/team-trends")).status, 403, "core team-trends in permissive mode");
      await setPermissive("false");
    });

    await step("no session ⇒ 401; director ⇒ 200", async () => {
      actingUserId = null;
      assertEq((await call(baseUrl, "/api/churn/team-trends")).status, 401, "unauthenticated status");
      actingUserId = DIRECTOR_ID;
      assertEq((await call(baseUrl, "/api/churn/team-trends")).status, 200, "director status");
    });

    // ── 2. Trends aggregation ────────────────────────────────────────
    actingUserId = DIRECTOR_ID;
    const trendsRes = await call(baseUrl, "/api/churn/team-trends");
    assertEq(trendsRes.status, 200, "trends status for director");
    const managers: any[] = trendsRes.json.managers;
    const am1 = managers.find((m) => m.ownerId === AM1_ID);
    const am2 = managers.find((m) => m.ownerId === AM2_ID);
    const am3 = managers.find((m) => m.ownerId === AM3_ID);

    await step("AM1 bucket: book size, status mix, avg risk, boundary deltas", async () => {
      assert(am1, "AM1 bucket present");
      assertEq(am1.clientCount, 2, "archived client excluded from AM1 book");
      assertEq(am1.statusMix.critical, 1, "AM1 critical count");
      assertEq(am1.statusMix.watch, 1, "AM1 watch count");
      assertEq(am1.statusMix.noData, 0, "AM1 noData count");
      approx(am1.avgRisk, 50, "AM1 avgRisk = (80+20)/2");
      approx(am1.riskDelta7d, 20, "AM1 delta7 from the -7d boundary row");
      approx(am1.riskDelta30d, 40, "AM1 delta30 from the -30d boundary row");
      assertEq(am1.ownerName, "Task3712 AlphaAM", "AM1 display name");
    });

    await step("AM1 comms volume splits zoom/email over the 30d window", async () => {
      assertEq(am1.comms.zoom, 5, "AM1 zoom comm count");
      assertEq(am1.comms.email, 5, "AM1 email comm count");
      assertEq(am1.comms.total, 10, "AM1 total comm count");
    });

    await step("AM1 complaint themes: aggregated, guarded, weight-ranked", async () => {
      assertEq(am1.topThemes.length, 3, "non-array complaint_themes contributes no theme");
      assertEq(am1.topThemes[0].category, "communication", "top theme by weight");
      assertEq(am1.topThemes[0].mentions, 2, "communication mentions across Z1+E1");
      assertEq(am1.topThemes[0].clientCount, 1, "distinct clients for communication theme");
      approx(am1.topThemes[0].weight, 1.2, "communication weight 0.8 + 0.4");
      const speed = am1.topThemes.find((t: any) => t.category === "speed");
      approx(speed.weight, 0.5, "non-numeric severity falls back to 0.5");
    });

    await step("AM2/AM3 buckets: healthy mix, noData book, no fabricated deltas", async () => {
      assert(am2, "AM2 bucket present");
      assertEq(am2.statusMix.healthy, 1, "AM2 healthy count");
      approx(am2.avgRisk, 10, "AM2 avgRisk");
      assertEq(am2.riskDelta7d, null, "AM2 delta7 null without baselines");
      assertEq(am2.comms.email, MAX_EMAIL_SAMPLES_PER_AM + 2, "AM2 email comm count");
      assert(am3, "AM3 bucket present");
      assertEq(am3.statusMix.noData, 1, "AM3 unjudged client counts as noData");
      assertEq(am3.avgRisk, null, "AM3 avgRisk null with no scored clients");
    });

    await step("unassigned bucket present, flagged, and sorted last", async () => {
      const unassigned = managers[managers.length - 1];
      assertEq(unassigned.unassigned, true, "last bucket is the unassigned one");
      assertEq(unassigned.ownerId, null, "unassigned ownerId");
      assertEq(unassigned.ownerName, "Unassigned", "unassigned label");
      assert(unassigned.clientCount >= 1, "ownerless book not dropped");
      assert(
        managers.filter((m: any) => m.unassigned).length === 1,
        "exactly one unassigned bucket",
      );
    });

    await step("department rollup spans all active clients", async () => {
      const dept = trendsRes.json.department;
      assert(dept.clientCount >= 6, "department covers at least the seeded active clients");
      assert(dept.statusMix.critical >= 1, "department mix includes the critical client");
      assert(dept.comms.total >= 22, "department comms include all seeded records");
      assert(dept.managerCount >= 4, "manager count covers seeded AMs (incl. deleted-AM book)");
      assert(typeof trendsRes.json.generatedAt === "string", "generatedAt present");
    });

    // ── 3. Sampler attribution (direct service calls) ────────────────
    await step("coached-manager roster: owners only, deleted AM excluded", async () => {
      const roster = await listCoachedManagers();
      const ids = new Set(roster.map((m) => m.id));
      assert(ids.has(AM1_ID) && ids.has(AM2_ID) && ids.has(AM3_ID), "seeded AMs coached");
      assert(!ids.has(AM4_ID), "soft-deleted AM never coached");
      assert(!ids.has(DIRECTOR_ID), "non-owners not in the roster");
      const rosterAm1 = roster.find((m) => m.id === AM1_ID)!;
      assertEq(rosterAm1.clientIds.length, 2, "AM1 roster book excludes archived client");
    });

    const internalEmails = new Set([AM1_EMAIL, AM2_EMAIL, AM3_EMAIL, OTHER_EMAIL]);

    await step("zoom attribution: on-call kept, other-staff excluded, unknown unattributed", async () => {
      const set = await sampleAmCommunications(
        { id: AM1_ID, email: AM1_EMAIL, name: "Task3712 AlphaAM" },
        [C_AM1_A, C_AM1_B],
        internalEmails,
      );
      assertEq(set.zoomAttributedCount, 2, "two verified zoom samples (short transcript skipped)");
      assertEq(set.emailAttributedCount, 2, "two verified email samples (inbound skipped)");
      assertEq(set.unattributedCount, 2, "Z4 + E4 kept as unattributed context");
      assertEq(set.attributedCount, 4, "attributed total");
      const ids = set.samples.map((s) => s.recordId);
      assert(!ids.includes(Z3), "another internal user's call excluded");
      assert(!ids.includes(E3), "another internal user's email excluded");
      assert(!ids.includes(Z5), "sub-minimum transcript skipped");
      assert(!ids.includes(E5), "inbound email skipped");
      assertEq(set.samples[0].recordId, Z1, "newest attributed zoom first");
      assertEq(set.samples[0].attributionBasis, `zoom_participant:${AM1_EMAIL.toLowerCase()}`, "zoom attribution basis");
      const e1 = set.samples.find((s) => s.recordId === E1)!;
      assertEq(e1.attributionBasis, `email_author:${AM1_EMAIL.toLowerCase()}`, "email attribution basis");
      for (const s of set.samples.slice(0, 4)) assertEq(s.attributed, true, `sample ${s.recordId} attributed`);
      const z4 = set.samples.find((s) => s.recordId === Z4)!;
      assertEq(z4.attributed, false, "externals-only call is unattributed");
    });

    await step("email cap bounds the packet; thread-grain 'team' role attributes", async () => {
      const set = await sampleAmCommunications(
        { id: AM2_ID, email: AM2_EMAIL, name: "Task3712 BravoAM" },
        [C_AM2],
        internalEmails,
      );
      assertEq(set.emailAttributedCount, MAX_EMAIL_SAMPLES_PER_AM, "email samples capped");
      assertEq(set.samples.length, MAX_EMAIL_SAMPLES_PER_AM, "no unattributed leakage");
      assert(set.samples.every((s) => s.attributed), "all AM2 samples verified");
    });

    // ── 4. Coaching run e2e with stubbed model ───────────────────────
    installStub();
    actingUserId = DIRECTOR_ID;

    const startRes = await call(baseUrl, "/api/churn/coaching/runs", "POST");
    const runId: string = startRes.json?.run?.id;

    await step("POST starts a run: 202 with a running row and manager total", async () => {
      assertEq(startRes.status, 202, "start status");
      assert(runId, "run id returned");
      assertEq(startRes.json.run.status, "running", "run starts running");
      assert(startRes.json.run.totalManagers >= 3, "seeded AMs counted");
    });

    await step("second POST while active ⇒ 409 with the active run attached", async () => {
      const conflict = await call(baseUrl, "/api/churn/coaching/runs", "POST");
      assertEq(conflict.status, 409, "conflict status");
      assert(String(conflict.json.error).length > 0, "conflict error message present");
      assertEq(conflict.json.activeRun?.id, runId, "active run surfaced in the 409 body");
    });

    releaseGate();
    await __test_awaitCoachingRuns();

    const detail = await call(baseUrl, `/api/churn/coaching/runs/${runId}`);
    const reports: any[] = detail.json.reports ?? [];
    const r1 = reports.find((r) => r.amUserId === AM1_ID);
    const r2 = reports.find((r) => r.amUserId === AM2_ID);
    const r3 = reports.find((r) => r.amUserId === AM3_ID);

    await step("run completes with full progress counters", async () => {
      assertEq(detail.status, 200, "run detail status");
      assertEq(detail.json.run.status, "completed", "run completed despite AM2 failure");
      assertEq(detail.json.run.processedManagers, detail.json.run.totalManagers, "all managers processed");
      assert(detail.json.run.failedManagers >= 1, "AM2 counted as failed");
      assert(detail.json.run.finishedAt, "finishedAt set");
    });

    await step("AM1 report: verified mistake kept with real-record evidence", async () => {
      assert(r1, "AM1 report present");
      assertEq(r1.status, "completed", "AM1 status");
      assertEq(r1.clientCount, 2, "AM1 report book size");
      assertEq(r1.zoomSampleCount, 2, "AM1 zoom sample count");
      assertEq(r1.emailSampleCount, 2, "AM1 email sample count");
      assertEq(r1.unattributedSampleCount, 2, "AM1 unattributed sample count");
      assertEq(r1.mistakes.length, 1, "only the verified mistake survives");
      const m = r1.mistakes[0];
      assertEq(m.title, "Vague next steps", "kept mistake title");
      assertEq(m.severity, 4, "kept mistake severity");
      assertEq(m.channel, "zoom", "kept mistake channel");
      assertEq(m.evidence[0].recordId, Z1, "evidence resolves to the real zoom record");
      assertEq(m.evidence[0].clientId, C_AM1_A, "evidence carries the client id for linking");
      assertEq(m.evidence[0].attributed, true, "evidence marked verified");
      assertEq(m.evidence[0].excerpt, "let me walk through the campaign changes", "verbatim excerpt");
      assertEq(r1.coachingFocus, "Close every call with named owners and dates.", "coaching focus");
      assertEq(r1.zoomSummary, "Strong rapport, weak call closings.", "zoom summary");
      assertEq(r1.emailSummary, "Emails answer questions but omit deadlines.", "email summary");
      assertEq(r1.strengths.length, 1, "strength kept");
    });

    await step("attribution guarantee: unverified-evidence mistake demoted, not pinned", async () => {
      const titles = r1.unattributed.map((u: any) => u.title);
      assert(titles.includes("Ghost problem"), "mistake with only unattributed evidence demoted");
      assert(titles.includes("Unknown staff over-promised"), "model's own unattributed observation kept");
      assert(!titles.includes("Uncited claim"), "evidence-less item dropped entirely");
      assert(!r1.mistakes.some((m: any) => m.title === "Ghost problem"), "demoted item absent from mistakes");
      assert(
        !r1.mistakes.some((m: any) => m.title === "Fabricated quote") && !titles.includes("Fabricated quote"),
        "invented excerpt rejected: citation dropped, mistake never rendered anywhere",
      );
      const ghost = r1.unattributed.find((u: any) => u.title === "Ghost problem");
      assertEq(ghost.evidence[0].recordId, Z4, "demoted evidence still cites the real record");
      assertEq(ghost.evidence[0].attributed, false, "demoted evidence flagged unverified");
    });

    await step("per-AM isolation: AM2's model failure yields a failed report only", async () => {
      assert(r2, "AM2 report present");
      assertEq(r2.status, "failed", "AM2 status");
      assert(String(r2.error).includes("synthetic model outage"), "AM2 error recorded");
      assert(r1.status === "completed" && detail.json.run.status === "completed", "run and siblings unaffected");
    });

    await step("insufficient data is explicit and never reaches the model", async () => {
      assert(r3, "AM3 report present");
      assertEq(r3.status, "insufficient_data", "AM3 status");
      assertEq(r3.insufficientData, true, "AM3 flag");
      assertEq(r3.mistakes.length, 0, "no fabricated coaching for AM3");
      assert(!stubCalls.some((c) => c.am === AM3_ID), "no analysis call for AM3");
    });

    await step("department synthesis maps AM indexes to user ids", async () => {
      const synth = detail.json.run.departmentSynthesisJson;
      assert(synth, "synthesis present");
      assertEq(synth.summary, SYNTHESIS_RESPONSE.summary, "synthesis summary");
      assertEq(synth.commonMistakes.length, 1, "one common mistake");
      assertEq(synth.commonMistakes[0].title, "Vague next steps", "common mistake title");
      assertEq(JSON.stringify(synth.commonMistakes[0].amUserIds), JSON.stringify([AM1_ID]), "index 0 → AM1, out-of-range 99 dropped");
      assertEq(synth.commonMistakes[0].severity, 5, "single-AM pattern only survives via the severity-5 exception");
    });

    await step("synthesis cardinality: ≥2 AMs required, severity-5 singleton exception", async () => {
      __test_setCoachingChatCreate(async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Cardinality enforcement check.",
                commonMistakes: [
                  { title: "Shared pattern", description: "Both AMs.", severity: 3, amIndexes: [0, 1] },
                  // Duplicate indexes dedupe to ONE distinct AM → dropped below severity 5.
                  { title: "Singleton minor", description: "One AM, severity 4.", severity: 4, amIndexes: [1, 1] },
                  { title: "Singleton crisis", description: "One AM, severity 5.", severity: 5, amIndexes: [0] },
                ],
              }),
            },
          },
        ],
      }));
      try {
        const synth = await synthesizeDepartment([
          { amUserId: `${RUN}-am-x`, amName: "X", mistakes: [{ title: "t1", description: "d1", severity: 3, channel: "zoom" }] },
          { amUserId: `${RUN}-am-y`, amName: "Y", mistakes: [{ title: "t2", description: "d2", severity: 4, channel: "email" }] },
        ]);
        assert(synth !== null, "synthesis returned");
        const titles = synth!.commonMistakes.map((m: any) => m.title);
        assert(titles.includes("Shared pattern"), "2-AM pattern kept");
        assert(titles.includes("Singleton crisis"), "severity-5 singleton kept via the exception");
        assert(!titles.includes("Singleton minor"), "deduped single-AM pattern below severity 5 dropped");
        assertEq(
          JSON.stringify(synth!.commonMistakes.find((m: any) => m.title === "Shared pattern")!.amUserIds),
          JSON.stringify([`${RUN}-am-x`, `${RUN}-am-y`]),
          "shared pattern maps both AM ids",
        );
      } finally {
        installStub(); // restore the run-level stub for any later steps
      }
    });

    await step("run history lists the run with the requester's name", async () => {
      const list = await call(baseUrl, "/api/churn/coaching/runs");
      assertEq(list.status, 200, "list status");
      const mine = (list.json.runs as any[]).find((r) => r.id === runId);
      assert(mine, "run present in history");
      assertEq(mine.requestedByName, "Task3712 Director", "requester display name");
      assertEq((await call(baseUrl, `/api/churn/coaching/runs/${RUN}-nope`)).status, 404, "unknown run id ⇒ 404");
    });

    await step("requester notified exactly once on completion", async () => {
      const rows = await db
        .select()
        .from(userNotifications)
        .where(
          and(
            eq(userNotifications.userId, DIRECTOR_ID),
            like(userNotifications.dedupeKey, `am-coaching-run:${runId}:%`),
          ),
        );
      assertEq(rows.length, 1, "one completion notification");
      assertEq(rows[0].title, "AM coaching reports are ready", "notification title");
      assert(String(rows[0].deepLink).includes(runId), "deep link targets the run");
      assertEq(rows[0].category, "system", "notification category");
    });
  } finally {
    releaseGate(); // belt-and-braces: never leave a wedged run holding the lock
    __test_setCoachingChatCreate(null);
    try {
      await __test_awaitCoachingRuns();
    } catch {}
    server.close();
    try {
      await storage.setSystemSetting(PERMISSIVE_KEY, originalPermissive?.value ?? "false", "system");
    } catch {}
    __resetPermissiveModeCacheForTests();
    await cleanup();
    // fetch()'s keep-alive sockets to the local server otherwise hold the
    // event loop open past pool drain and the runner scores it as a hang.
    await getGlobalDispatcher().close();
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll am-coaching tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit(); a
// leaked handle surfaces as a hang instead of being masked by a forced exit.
let exitCode = 0;
main()
  .catch((err) => {
    console.error("am-coaching: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
