/* test-registration
{
  "name": "Churn Command Center leaderboard API (Task #3691)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3691: Churn Command Center leaderboard API — the strict director gate (core/lead 403 in BOTH permissive modes), archived/demo exclusion, latest-judgment + latest-signals selection, headline fallback, and the 7/30-day baseline-window delta arithmetic with in-window decoy rows. Now also pins the enriched briefing payload: full judgment content passthrough (concerns/actions/wins/evidence fields), the statusSince streak boundary (older same-status runs must NOT leak through a different-status row), the latest-engagement-snapshot join, and the reportMetrics extraction (newest-4-months cap, evidence-gated nulls instead of fabricated zeros, 30d/90d reference values). Real route mounted behind an injected session against the shared dev DB with per-run suffixed rows + cascade cleanup; no network, a handful of fast queries. A drift here either opens the churn surface below director or silently mis-ranks/mis-trends/mis-explains every client on it.",
  "tier": "small"
}
test-registration */
/**
 * Task #3691 — Churn Command Center leaderboard API coverage.
 *
 * Pins the contract of GET /api/churn/leaderboard end-to-end through a real
 * Express app (real registerChurnRoutes + real isAuthenticated behind an
 * injected passport-shaped session, following the route-mount pattern of
 * tests/semrush-role-gate-403.test.ts):
 *
 *   1. Authz — the gate is STRICT director+: core and lead get 403 with
 *      permissive mode pinned OFF *and* pinned ON (permissive mode elevates
 *      core only to lead, never to director — see canAccessChurnCommandCenter
 *      in server/auth/permissions.ts); director and ceo authority get 200;
 *      an unauthenticated request gets 401; a session whose sub has no
 *      users row is denied at admission (Task #4554 closed sign-in) and
 *      gets 403 without any row being written.
 *   2. Aggregation shape — each entry carries the latest judgment
 *      (status/riskScore/headline/judgmentDate), the latest relationship-
 *      signal sub-scores, the owner's display name, and 7/30-day risk deltas.
 *   3. Delta windows — baseline7 is the most recent SCORED judgment dated
 *      <= latest−7d and baseline30 <= latest−30d. The seeded history plants
 *      decoy rows INSIDE each window (07-28, 07-10) that must lose to the
 *      correct boundary rows (07-25, 07-02), so deltas are 22/42, not the
 *      decoys' 12.5/32.5.
 *   4. Latest-row selection — the newest signals row wins over an older one;
 *      the judgment headline falls back to summary_text when the headline
 *      column is empty (the current cron writer fills summary_text only).
 *   5. Exclusion — archived and demo clients never appear even with
 *      high-risk judgments; a client with no judgment rows appears with
 *      judgment=null (the UI's "No data" bucket) instead of being dropped.
 *   6. Ordering — scored clients come back risk-desc; null-risk (no-data)
 *      clients sort after every scored client.
 *   7. Enriched judgment content (briefing payload) — the latest judgment
 *      carries its full readable content (summaryText, narrativeSummary,
 *      changeSummary, sentimentSummary, concernsJson, actionsJson, winsJson)
 *      and evidence fields (unresolvedAskCount, communicationsAnalyzed,
 *      dataSourcesSummary, confidenceLevel, generatedFromStartAt/EndAt)
 *      straight through, plus statusSince = the first date of the CURRENT
 *      consecutive same-status run. The seeded history plants an OLD
 *      Critical row (06-20) before an At Risk boundary — the streak must
 *      start at 07-30 (the first Critical after the last non-Critical row),
 *      not reach back to 06-20 and not collapse to the latest date.
 *   8. Engagement join — the newest engagement snapshot's facts
 *      (daysSinceLastInbound / daysSinceLastCallMeeting / inbound30d /
 *      outbound30d) win over an older decoy snapshot; clients without
 *      snapshots carry engagement=null.
 *   9. reportMetrics — real lead/review numbers extracted from the newest 4
 *      monthly-report marketing sections with the same canonical readers the
 *      client-facing report trend uses: latest + prior month values, the
 *      avg of up to 3 pre-latest months, evidence-gated nulls (a month with
 *      no lead shapes yields leads=null, never a fabricated 0; same for
 *      reviews), and a poison 5th month that must be cut by the newest-4
 *      window. Clients without reports carry reportMetrics=null.
 *
 * Seeding uses per-run random suffixes on ids/emails so repeated or
 * concurrent runs never collide, and cleans up in finally (client deletes
 * cascade to judgments/signals). The permissive-mode switch is captured
 * first and restored in finally, with __resetPermissiveModeCacheForTests()
 * after every flip (tests/user-role-permissions.test.ts pattern; raw-SQL
 * writes to system_settings are banned — storage.setSystemSetting keeps the
 * caches consistent).
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { __resetPermissiveModeCacheForTests } from "../server/auth/permissions";
import { registerChurnRoutes } from "../server/routes/churn";
import { TIER_GATE_VERSION } from "../server/services/judgmentTierGate";
import {
  accountHealthContract,
  accountHealthStatusOptions,
  riskMatchesAccountHealthStatus,
} from "@shared/clientRating";

const RUN = `t3691-${randomBytes(4).toString("hex")}`;

const DIRECTOR_ID = `${RUN}-director`;
const LEAD_ID = `${RUN}-lead`;
const CORE_ID = `${RUN}-core`;
const OWNER_ID = `${RUN}-owner`; // ceo authority; also owns every seeded client
const GHOST_ID = `${RUN}-ghost`; // session sub with no pre-seeded users row

const C_ACTIVE = `${RUN}-client-active`;
const C_SECOND = `${RUN}-client-second`;
const C_NODATA = `${RUN}-client-nodata`;
const C_ARCHIVED = `${RUN}-client-archived`;
const C_DEMO = `${RUN}-client-demo`;

// Monthly reports for the reportMetrics extraction (newest 4 win; -03 is the
// poison 5th month whose absurd numbers must never reach the averages).
const REP_IDS = {
  "2026-07": `${RUN}-rep-07`,
  "2026-06": `${RUN}-rep-06`,
  "2026-05": `${RUN}-rep-05`,
  "2026-04": `${RUN}-rep-04`,
  "2026-03": `${RUN}-rep-03`,
} as const;

// Enriched content on the latest C_ACTIVE judgment (briefing payload).
const CONCERNS = [
  "Three emails unanswered for over a week",
  "Lead volume dropped sharply month-over-month",
  "Client asked about contract terms twice",
];
const ACTIONS = [
  { action: "Call the client today", why: "Unanswered emails signal escalation risk" },
  { action: "Send the July lead report", why: null },
];
const WINS = ["Reviews up in July", "Positive call with the paralegal"];
const BASIS = {
  version: 2,
  tier: "full",
  generatedAt: "2026-08-01T12:00:00.000Z",
  inputsFingerprint: "f".repeat(64),
  promptRevision: "fixture-repaired-revision",
  tierGateVersion: TIER_GATE_VERSION,
  basedOn: ["front_emails", "call_transcripts", "monthly_reports"],
  missing: [],
  silenceDays: 0,
  sources: {},
  tierGate: {
    version: TIER_GATE_VERSION,
    judgmentDate: "2026-08-01",
    proposedStatus: "Critical",
    finalStatus: "Critical",
    proposedRelationshipStatus: "Strained",
    finalRelationshipStatus: "Strained",
    cap: "Critical",
    overridden: false,
    healthyForced: false,
    proposedOverallRisk: 97,
    finalOverallRisk: 82.5,
    riskDrivers: [{
      id: "evidence:client-msg-1",
      severity: "critical",
      reason: "critical_evidence_validated",
    }],
    capReasons: ["critical_evidence_validated"],
    silenceExceeded: false,
    deliveryStability: "stable",
    deliveryStabilitySource: "entered_reports",
    evidence: {
      validCount: 1,
      rejectedCount: 1,
      reclassifiedCount: 0,
      items: [{
        category: "explicit_churn_language",
        effectiveCategory: "explicit_churn_language",
        provenance: "client_authored",
        date: "2026-07-31",
        quote: "redacted from the bounded projection",
        valid: true,
        reason: "Direct client-authored cancellation language",
        quoteFingerprint: "private-source-fingerprint",
        matchedFragment: {
          id: "private-fragment-id",
          independenceKey: "client-msg-1",
          sourceType: "email",
          occurredAt: "2026-07-31T14:00:00.000Z",
        },
      }],
    },
  },
};
const NARRATIVE = "**Summary**\nThe firm is drifting after two escalations.\n\n**Concerns**\nEmails are going unanswered.";
const CHANGE_SUMMARY = "Risk rose after two more emails went unanswered since yesterday.";
const SENTIMENT_SUMMARY = "Tone is frustrated but still professional.";

const PERMISSIVE_KEY = "role_permissions_permissive_mode";

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

async function seed(): Promise<void> {
  // Users: the authority axis drives the gate; roles kept legacy-realistic
  // (director rides an account_manager legacy role to prove the authority
  // column, not the legacy role, is what passes the gate).
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${DIRECTOR_ID}, ${`${DIRECTOR_ID}@t3691.example`}, 'Task3691', 'Director', 'account_manager', 'director'),
      (${LEAD_ID}, ${`${LEAD_ID}@t3691.example`}, 'Task3691', 'Lead', 'team_lead', 'lead'),
      (${CORE_ID}, ${`${CORE_ID}@t3691.example`}, 'Task3691', 'Core', 'account_manager', 'core'),
      (${OWNER_ID}, ${`${OWNER_ID}@t3691.example`}, 'Task3691', 'Owner', 'ceo', 'ceo')
  `);

  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES
      (${C_ACTIVE}, ${`${RUN} Zulu Firm`}, ${OWNER_ID}, false, false),
      (${C_SECOND}, ${`${RUN} Alpha Firm`}, ${OWNER_ID}, false, false),
      (${C_NODATA}, ${`${RUN} Quiet Firm`}, ${OWNER_ID}, false, false),
      (${C_ARCHIVED}, ${`${RUN} Archived Firm`}, ${OWNER_ID}, true, false),
      (${C_DEMO}, ${`${RUN} Demo Firm`}, ${OWNER_ID}, false, true)
  `);

  // C_ACTIVE risk history. Latest is 2026-08-01 (82.5, Critical).
  //   cutoff7  = 2026-07-25 → 07-28 (70) sits INSIDE the window (decoy);
  //              the correct baseline is 07-25 (60.5) → delta7 = 22
  //   cutoff30 = 2026-07-02 → 07-10 (50) sits INSIDE the window (decoy);
  //              the correct baseline is 07-02 (40.5) → delta30 = 42
  // Streak rows: 07-30 Critical starts the CURRENT Critical run (after the
  // 07-28 At Risk boundary), and 06-20 Critical is an OLD Critical run that
  // statusSince must NOT reach back to. Neither disturbs the baselines:
  // 07-30 > cutoff7, and 07-02 is still the newest row <= cutoff30.
  await db.execute(sql`
    INSERT INTO client_daily_judgments (client_id, judgment_date, status, headline, summary_text, risk_score)
    VALUES
      (${C_ACTIVE}, '2026-08-01', 'Critical', ${"Escalating complaints - three unanswered emails"}, ${"Latest full summary."}, 82.5),
      (${C_ACTIVE}, '2026-07-30', 'Critical', ${"Start of the current Critical streak"}, NULL, 75),
      (${C_ACTIVE}, '2026-07-28', 'At Risk', ${"Decoy inside the 7d window"}, NULL, 70),
      (${C_ACTIVE}, '2026-07-25', 'At Risk', ${"Correct 7d baseline row"}, NULL, 60.5),
      (${C_ACTIVE}, '2026-07-10', 'Watch', ${"Decoy inside the 30d window"}, NULL, 50),
      (${C_ACTIVE}, '2026-07-02', 'Watch', ${"Correct 30d baseline row"}, NULL, 40.5),
      (${C_ACTIVE}, '2026-06-20', 'Critical', ${"OLD Critical run - streak must not reach this"}, NULL, 80),
      (${C_SECOND}, '2026-08-01', 'Watch', '', ${"Second firm summary line."}, 30),
      (${C_ARCHIVED}, '2026-08-01', 'Critical', ${"Archived must not appear"}, NULL, 99),
      (${C_DEMO}, '2026-08-01', 'Critical', ${"Demo must not appear"}, NULL, 99)
  `);

  // Enrich the latest C_ACTIVE judgment with the full briefing content the
  // leaderboard now returns (the cron writes these fields on real rows).
  await db.execute(sql`
    UPDATE client_daily_judgments SET
      narrative_summary = ${NARRATIVE},
      change_summary = ${CHANGE_SUMMARY},
      sentiment_summary = ${SENTIMENT_SUMMARY},
      concerns_json = ${JSON.stringify(CONCERNS)}::jsonb,
      actions_json = ${JSON.stringify(ACTIONS)}::jsonb,
      wins_json = ${JSON.stringify(WINS)}::jsonb,
      data_sources_summary = ${JSON.stringify(BASIS)}::jsonb,
      unresolved_ask_count = 2,
      communications_analyzed = 14,
      confidence_level = 'High',
      relationship_health = 'Strained',
      generated_from_start_at = '2026-07-25 00:00:00',
      generated_from_end_at = '2026-08-01 00:00:00'
    WHERE client_id = ${C_ACTIVE} AND judgment_date = '2026-08-01'
  `);

  // Engagement snapshots: the 08-01 row must win over the 07-25 decoy;
  // C_SECOND gets none → engagement must come back null.
  await db.execute(sql`
    INSERT INTO client_engagement_snapshots (client_id, snapshot_date, inbound_30d, outbound_30d, days_since_last_inbound, days_since_last_call_meeting)
    VALUES
      (${C_ACTIVE}, '2026-07-25', 9, 20, 1, 3),
      (${C_ACTIVE}, '2026-08-01', 4, 11, 9, 21)
  `);

  // Monthly reports + marketing sections for reportMetrics. Expected:
  //   2026-07: leads 12 (evidence), reviews 5 (reviewGeneration.totalReviews)
  //   2026-06: leads 20, reviews 4 (per-location sum fallback: 3 + 1)
  //   2026-05: NO lead shapes → leads null; reviews 6 (list.reviews)
  //   2026-04: leads 30; NO review shapes → reviews null
  //   2026-03: poison month (999s) — 5th-newest, must be cut by the window
  // → leads=12, prev=20, avg90 = (20+30)/2 = 25 over 2 months (null skipped)
  // → reviews=5, prev=4, avg90 = (4+6)/2 = 5 over 2 months (null skipped)
  await db.execute(sql`
    INSERT INTO reports (id, client_id, report_month)
    VALUES
      (${REP_IDS["2026-07"]}, ${C_ACTIVE}, '2026-07'),
      (${REP_IDS["2026-06"]}, ${C_ACTIVE}, '2026-06'),
      (${REP_IDS["2026-05"]}, ${C_ACTIVE}, '2026-05'),
      (${REP_IDS["2026-04"]}, ${C_ACTIVE}, '2026-04'),
      (${REP_IDS["2026-03"]}, ${C_ACTIVE}, '2026-03')
  `);
  await db.execute(sql`
    INSERT INTO report_sections (report_id, section_key, data)
    VALUES
      (${REP_IDS["2026-07"]}, 'marketing', ${JSON.stringify({ totalLeads: 12, reviewGeneration: { totalReviews: 5 } })}::jsonb),
      (${REP_IDS["2026-06"]}, 'marketing', ${JSON.stringify({ totalLeads: 20, gbp: { locations: [{ reviewsGenerated: 3 }, { reviewsGenerated: 1 }] } })}::jsonb),
      (${REP_IDS["2026-05"]}, 'marketing', ${JSON.stringify({ reviewGeneration: { list: { reviews: 6 } } })}::jsonb),
      (${REP_IDS["2026-04"]}, 'marketing', ${JSON.stringify({ totalLeads: 30 })}::jsonb),
      (${REP_IDS["2026-03"]}, 'marketing', ${JSON.stringify({ totalLeads: 999, reviewGeneration: { totalReviews: 999 } })}::jsonb)
  `);

  // Signals: an older row plus the latest row for C_ACTIVE — the endpoint
  // must return the 2026-08-01 values, not the 2026-07-25 ones. C_SECOND
  // gets none, so its entry must carry signals=null.
  await db.execute(sql`
    INSERT INTO client_relationship_signals (client_id, signal_date, sentiment_score, complaint_score, trust_score, responsiveness_risk_score, execution_risk_score, lead_volume_concern_score, unresolved_task_score, relationship_health_score)
    VALUES
      (${C_ACTIVE}, '2026-07-25', 10, 20, 80, 15, 15, 10, 5, 85),
      (${C_ACTIVE}, '2026-08-01', -40, 77.5, 22, 66, 55, 44, 33, 25)
  `);
}

async function cleanup(): Promise<void> {
  // reports.client_id has NO ON DELETE CASCADE (nor report_sections →
  // reports), so the report rows must go first or the client delete 23503s.
  try {
    const repIds = Object.values(REP_IDS);
    await db.execute(sql`
      DELETE FROM report_sections
      WHERE report_id IN (${sql.join(repIds.map((id) => sql`${id}`), sql`, `)})
    `);
    await db.execute(sql`
      DELETE FROM reports
      WHERE id IN (${sql.join(repIds.map((id) => sql`${id}`), sql`, `)})
    `);
  } catch {}
  // Client deletes cascade to client_daily_judgments,
  // client_relationship_signals and client_engagement_snapshots
  // (FK ON DELETE CASCADE).
  try {
    await db.execute(sql`
      DELETE FROM clients
      WHERE id IN (${C_ACTIVE}, ${C_SECOND}, ${C_NODATA}, ${C_ARCHIVED}, ${C_DEMO})
    `);
  } catch {}
  try {
    await db.execute(sql`
      DELETE FROM users
      WHERE id IN (${DIRECTOR_ID}, ${LEAD_ID}, ${CORE_ID}, ${OWNER_ID}, ${GHOST_ID})
    `);
  } catch {}
}

// Clerk test seam (server/middlewares/requireAuth.ts) so the real requireAuth
// middleware runs against seeded user rows; the acting user switches per
// request. actingUserId === null models an unauthenticated request (→ 401).
// Users are seeded into the committed public schema, so no registry is needed.
let actingUserId: string | null = DIRECTOR_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
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

async function call(baseUrl: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}/api/churn/leaderboard`, { method: "GET" });
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

async function main(): Promise<void> {
  console.log(`Churn Command Center leaderboard API coverage (Task #3691) [${RUN}]`);

  await step("shared account-health contract pins every inclusive risk-band boundary", async () => {
    const expected = {
      Healthy: [0, 24],
      Watch: [25, 49],
      "At Risk": [50, 74],
      Critical: [75, 100],
    } as const;
    for (const status of accountHealthStatusOptions) {
      const [minimum, maximum] = expected[status];
      assertEq(JSON.stringify(accountHealthContract[status].riskRange), JSON.stringify(expected[status]), `${status} risk range`);
      assert(riskMatchesAccountHealthStatus(minimum, status), `${status} includes lower boundary ${minimum}`);
      assert(riskMatchesAccountHealthStatus(maximum, status), `${status} includes upper boundary ${maximum}`);
      assert(!riskMatchesAccountHealthStatus(minimum - 1, status), `${status} excludes ${minimum - 1}`);
      assert(!riskMatchesAccountHealthStatus(maximum + 1, status), `${status} excludes ${maximum + 1}`);
    }
  });

  const originalPermissive = await storage.getSystemSetting(PERMISSIVE_KEY);
  await seed();
  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // ── 1. Authz matrix ──────────────────────────────────────────────
    await setPermissive("false");

    await step("strict mode: core authority ⇒ 403 naming the required level", async () => {
      actingUserId = CORE_ID;
      const { status, json } = await call(baseUrl);
      assertEq(status, 403, "status for core in strict mode");
      assert(
        typeof json.error === "string" && json.error.includes("Director"),
        `403 body names the required level (got ${JSON.stringify(json.error)})`,
      );
    });

    await step("strict mode: lead authority ⇒ 403", async () => {
      actingUserId = LEAD_ID;
      const { status } = await call(baseUrl);
      assertEq(status, 403, "status for lead in strict mode");
    });

    await step("strict mode: director authority ⇒ 200", async () => {
      actingUserId = DIRECTOR_ID;
      const { status } = await call(baseUrl);
      assertEq(status, 200, "status for director in strict mode");
    });

    await setPermissive("true");

    await step("permissive mode: core STILL 403 (gate never opens below director)", async () => {
      actingUserId = CORE_ID;
      const { status } = await call(baseUrl);
      assertEq(status, 403, "status for core in permissive mode");
    });

    await step("permissive mode: lead STILL 403", async () => {
      actingUserId = LEAD_ID;
      const { status } = await call(baseUrl);
      assertEq(status, 403, "status for lead in permissive mode");
    });

    await step("permissive mode: director ⇒ 200, ceo authority ⇒ 200", async () => {
      actingUserId = DIRECTOR_ID;
      assertEq((await call(baseUrl)).status, 200, "status for director in permissive mode");
      actingUserId = OWNER_ID;
      assertEq((await call(baseUrl)).status, 200, "status for ceo authority in permissive mode");
    });

    await step("unauthenticated request ⇒ 401", async () => {
      actingUserId = null;
      const { status } = await call(baseUrl);
      assertEq(status, 401, "status without a session");
    });

    await step("unknown-sub session is denied at admission ⇒ 403", async () => {
      // Task #4554 closed admission: requireAuth no longer JIT-provisions a
      // users row — an unknown sub with no approved row is denied outright
      // (403 account_not_approved) and no row is written. cleanup()'s
      // GHOST_ID delete is now a no-op.
      actingUserId = GHOST_ID;
      const { status } = await call(baseUrl);
      assertEq(status, 403, "status for unapproved unknown user");
    });

    // ── 2-6. Aggregation contract (as director) ──────────────────────
    actingUserId = DIRECTOR_ID;
    const { status, json } = await call(baseUrl);
    assertEq(status, 200, "leaderboard status for director");
    const clients: any[] = json.clients;

    await step("response shape: clients array + generatedAt", async () => {
      assert(Array.isArray(clients), "clients is an array");
      assert(typeof json.generatedAt === "string" && json.generatedAt.length > 0, "generatedAt present");
    });

    const active = clients.find((c) => c.clientId === C_ACTIVE);
    const second = clients.find((c) => c.clientId === C_SECOND);
    const nodata = clients.find((c) => c.clientId === C_NODATA);

    await step("active clients present; archived and demo excluded", async () => {
      assert(active, "active client present");
      assert(second, "second client present");
      assert(nodata, "no-data client present");
      assert(!clients.some((c) => c.clientId === C_ARCHIVED), "archived client must be excluded");
      assert(!clients.some((c) => c.clientId === C_DEMO), "demo client must be excluded");
    });

    await step("latest judgment fields (status/riskScore/headline/date) + owner name", async () => {
      assertEq(active.judgment.status, "Critical", "latest judgment status");
      approx(active.judgment.riskScore, 82.5, "latest judgment riskScore");
      assertEq(active.judgment.judgmentDate, "2026-08-01", "latest judgment date");
      assertEq(
        active.judgment.headline,
        "Escalating complaints - three unanswered emails",
        "headline comes from the headline column when set",
      );
      assertEq(active.ownerName, "Task3691 Owner", "ownerName is the owner's display name");
      assertEq(active.firmName, `${RUN} Zulu Firm`, "firmName");
    });

    await step("7/30-day deltas use the boundary rows, not the in-window decoys", async () => {
      approx(active.riskDelta7d, 22, "delta7 = 82.5 - 60.5 (07-25 row); 07-28 decoy would give 12.5");
      approx(active.riskDelta30d, 42, "delta30 = 82.5 - 40.5 (07-02 row); 07-10 decoy would give 32.5");
    });

    await step("latest signals row wins; all eight sub-scores surfaced", async () => {
      assertEq(active.signals.signalDate, "2026-08-01", "signals date is the newest row");
      approx(active.signals.sentimentScore, -40, "sentimentScore");
      approx(active.signals.complaintScore, 77.5, "complaintScore");
      approx(active.signals.trustScore, 22, "trustScore");
      approx(active.signals.responsivenessRiskScore, 66, "responsivenessRiskScore");
      approx(active.signals.executionRiskScore, 55, "executionRiskScore");
      approx(active.signals.leadVolumeConcernScore, 44, "leadVolumeConcernScore");
      approx(active.signals.unresolvedTaskScore, 33, "unresolvedTaskScore");
      approx(active.signals.relationshipHealthScore, 25, "relationshipHealthScore");
    });

    await step("headline falls back to summary_text when headline is empty", async () => {
      assertEq(second.judgment.headline, "Second firm summary line.", "fallback headline");
      approx(second.judgment.riskScore, 30, "second riskScore");
    });

    await step("client without baselines/signals: null deltas + null signals", async () => {
      assertEq(second.riskDelta7d, null, "delta7 null without a scored row 7d back");
      assertEq(second.riskDelta30d, null, "delta30 null without a scored row 30d back");
      assertEq(second.signals, null, "signals null when no signal rows exist");
    });

    await step("no-data client kept with judgment=null (UI 'No data' bucket)", async () => {
      assertEq(nodata.judgment, null, "judgment null when never judged");
      assertEq(nodata.signals, null, "signals null when never judged");
      assertEq(nodata.riskDelta7d, null, "delta7 null when never judged");
      assertEq(nodata.riskDelta30d, null, "delta30 null when never judged");
    });

    await step("ordering: risk desc, no-data after every scored client", async () => {
      const ia = clients.findIndex((c) => c.clientId === C_ACTIVE);
      const is2 = clients.findIndex((c) => c.clientId === C_SECOND);
      const ind = clients.findIndex((c) => c.clientId === C_NODATA);
      assert(ia >= 0 && is2 > ia, "active (82.5) ranks above second (30)");
      assert(ind > is2, "no-data client sorts after scored clients");
    });

    // ── 7. Enriched judgment content (briefing payload) ───────────────
    await step("enriched judgment content passes straight through", async () => {
      const j = active.judgment;
      assertEq(j.summaryText, "Latest full summary.", "summaryText");
      assertEq(j.narrativeSummary, NARRATIVE, "narrativeSummary");
      assertEq(j.changeSummary, CHANGE_SUMMARY, "changeSummary");
      assertEq(j.sentimentSummary, SENTIMENT_SUMMARY, "sentimentSummary");
      assertEq(JSON.stringify(j.concernsJson), JSON.stringify(CONCERNS), "concernsJson round-trips");
      assertEq(JSON.stringify(j.winsJson), JSON.stringify(WINS), "winsJson round-trips");
      assert(Array.isArray(j.actionsJson) && j.actionsJson.length === 2, "actionsJson is the 2-action array");
      assertEq(j.actionsJson[0].action, ACTIONS[0].action, "first recommended action text");
      assertEq(j.actionsJson[0].why, ACTIONS[0].why, "first recommended action rationale");
      assertEq(j.unresolvedAskCount, 2, "unresolvedAskCount");
      assertEq(j.communicationsAnalyzed, 14, "communicationsAnalyzed");
      assertEq(JSON.stringify(j.dataSourcesSummary?.basedOn), JSON.stringify(BASIS.basedOn), "dataSourcesSummary.basedOn");
      assertEq(j.confidenceLevel, "High", "confidenceLevel");
      assert(
        typeof j.generatedFromStartAt === "string" && j.generatedFromStartAt.startsWith("2026-07-25"),
        `generatedFromStartAt is the seeded window start (got ${JSON.stringify(j.generatedFromStartAt)})`,
      );
      assert(
        typeof j.generatedFromEndAt === "string" && j.generatedFromEndAt.startsWith("2026-08-01"),
        `generatedFromEndAt is the seeded window end (got ${JSON.stringify(j.generatedFromEndAt)})`,
      );
    });

    await step("bounded authoritative rating explains provenance, freshness, and policy without raw evidence", async () => {
      const rating = active.judgment.rating;
      assertEq(rating.status, "Critical", "authoritative rating status");
      assertEq(rating.relationship, "Strained", "independent relationship read");
      assertEq(rating.riskScore, 82.5, "stored authoritative risk");
      assertEq(JSON.stringify(rating.riskRange), JSON.stringify([75, 100]), "shared Critical band");
      assertEq(rating.policyVersion, TIER_GATE_VERSION, "rating policy version");
      assertEq(rating.promptRevision, BASIS.promptRevision, "rating prompt revision");
      assertEq(rating.generation, "generated", "fresh generation lineage");
      assertEq(rating.primaryDrivers.length, 1, "bounded driver count");
      assertEq(rating.primaryDrivers[0].label, "Explicit churn or cancellation language", "driver label");
      assertEq(rating.primaryDrivers[0].provenance, "client-authored", "driver provenance");
      assertEq(rating.primaryDrivers[0].freshness, "current", "driver freshness");
      const bounded = JSON.stringify(rating);
      assert(!bounded.includes("redacted from the bounded projection"), "projection excludes quote text");
      assert(!bounded.includes("private-fragment-id"), "projection excludes raw fragment ids");
      assert(!bounded.includes("private-source-fingerprint"), "projection excludes evidence fingerprints");
      assert(bounded.length < 3000, `projection stays bounded (got ${bounded.length} chars)`);
    });

    await step("statusSince = start of the CURRENT streak, not the latest date, not an old run", async () => {
      // Critical rows: 06-20 (old run), 07-30, 08-01. Last non-Critical row
      // is 07-28 → the current streak starts 07-30. A naive MIN over all
      // same-status rows would give 06-20; latest-date-only would give 08-01.
      assertEq(active.judgment.statusSince, "2026-07-30", "statusSince streak boundary");
      // Never-changed history: the single Watch row is its own streak start.
      assertEq(second.judgment.statusSince, "2026-08-01", "statusSince with no prior different status");
    });

    // ── 8. Engagement snapshot join ───────────────────────────────────
    await step("latest engagement snapshot wins; absent snapshots → null", async () => {
      assert(active.engagement, "active client has engagement facts");
      assertEq(active.engagement.snapshotDate, "2026-08-01", "engagement snapshotDate is the newest row");
      assertEq(active.engagement.daysSinceLastInbound, 9, "daysSinceLastInbound from the newest snapshot");
      assertEq(active.engagement.daysSinceLastCallMeeting, 21, "daysSinceLastCallMeeting");
      assertEq(active.engagement.inbound30d, 4, "inbound30d");
      assertEq(active.engagement.outbound30d, 11, "outbound30d");
      assertEq(second.engagement, null, "engagement null when no snapshots exist");
    });

    // ── 9. reportMetrics extraction ───────────────────────────────────
    await step("reportMetrics: latest/prev values + evidence-gated nulls + newest-4 window", async () => {
      const rm = active.reportMetrics;
      assert(rm, "active client has reportMetrics");
      assertEq(rm.latestMonth, "2026-07", "latestMonth");
      assertEq(rm.leads, 12, "latest leads");
      assertEq(rm.reviews, 5, "latest reviews (reviewGeneration.totalReviews)");
      assertEq(rm.prevMonth, "2026-06", "prevMonth");
      assertEq(rm.leadsPrev, 20, "prior-month leads");
      assertEq(rm.reviewsPrev, 4, "prior-month reviews via per-location sum (3+1)");
      // 2026-05 has no lead shapes → skipped from the average, NOT counted
      // as 0; 2026-03's 999s must be cut by the newest-4 window.
      approx(rm.leadsAvg90, 25, "leadsAvg90 = (20+30)/2, null month skipped, poison month cut");
      assertEq(rm.leadsMonthsInAvg, 2, "leadsMonthsInAvg");
      // 2026-04 has no review shapes → skipped (null), not a fabricated 0.
      approx(rm.reviewsAvg90, 5, "reviewsAvg90 = (4+6)/2");
      assertEq(rm.reviewsMonthsInAvg, 2, "reviewsMonthsInAvg");
      assertEq(second.reportMetrics, null, "reportMetrics null when the client has no reports");
    });
  } finally {
    server.close();
    // Restore the permissive switch exactly as found. A missing original
    // row and value "false" behave identically (the helper defaults OFF),
    // so value-restore is faithful either way.
    try {
      await storage.setSystemSetting(PERMISSIVE_KEY, originalPermissive?.value ?? "false", "system");
    } catch {}
    __resetPermissiveModeCacheForTests();
    await cleanup();
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll churn-leaderboard tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit(); a
// leaked handle surfaces as a hang instead of being masked by a forced exit.
let exitCode = 0;
main()
  .catch((err) => {
    console.error("churn-leaderboard: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
