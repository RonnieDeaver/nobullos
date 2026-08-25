/* test-registration
{
  "name": "Churn open-asks rollup + weekly digest (Task #3694)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3694: cross-client open-asks rollup + weekly digest — the same strict director gate on /api/churn/open-asks, archived/demo/lifecycle exclusions, the age×concern rank blend (regression to a single-column sort flips exact-order assertions), filter/sort params, the director-grant on the reused per-client PATCH, and the Monday digest's once-per-week key + kill-switch + failure-retry semantics with injected senders. Same harness profile as the leaderboard test: injected session, per-run suffixed rows, cascade cleanup, no external network.",
  "tier": "small"
}
test-registration */
/**
 * Task #3694 — Aging asks & promises: rollup API + weekly digest coverage.
 *
 * Part A pins GET /api/churn/open-asks end-to-end through a real Express
 * app (real registerChurnRoutes + real requireAuth behind the Clerk
 * per-request test seam — tests/churn-leaderboard.test.ts pattern):
 *
 *   1. Authz — STRICT director+ gate: core and lead get 403 with
 *      permissive mode pinned OFF *and* ON; director/ceo get 200; no
 *      session gets 401; an unknown sub is denied at admission (closed
 *      sign-in) and 403s.
 *   2. Scope — only open/likely_open asks of active clients: resolved /
 *      dismissed / likely_resolved rows and archived/demo clients' asks
 *      never appear.
 *   3. Ranking — default order is the age×concern blend. The seed is
 *      crafted so rank, age, concern, and mentions orders are pairwise
 *      different: the top item wins on age despite mid concern, and a
 *      high-concern young item beats an old low-concern one — so a
 *      regression to any single-column sort flips an assertion.
 *   4. Filters/sorts — askType / ownerId / clientId narrow correctly;
 *      sort=age|concern|mentions reorder exactly (asserted with exact id
 *      sequences scoped via clientId, which isolates from unrelated rows
 *      in the shared dev DB); bogus askType/sort values get 400.
 *   5. Inline actions — the reused per-client PATCH explicitly grants
 *      churn-surface directors (authority-gated, ANY legacy role, no
 *      client ownership) resolve/dismiss with note + actor attribution,
 *      while an unmapped-legacy-role non-director non-owner stays 403 —
 *      so the rollup's read grant and the inline-action grant cannot
 *      drift apart again.
 *   6. Shape — client/owner names, effective concern/mentions (NULL
 *      columns coalesce to 1), ageDays/rankScore arithmetic, and
 *      relatedPromiseText passthrough.
 *
 * Part B pins the weekly digest (server/services/openAsksDigest.ts):
 *
 *   7. Week-key + composition — ISO week key boundaries; title carries
 *      total/client counts; body/text carry ranked worst offenders with
 *      age/mentions/concern and the /churn?tab=asks deep link.
 *   8. Send flow — with injected rollup/recipients/senders (the shared
 *      dev DB makes real-row counts nondeterministic): a Monday-noon run
 *      sends one in-app row per director+ recipient with the week-scoped
 *      dedupeKey, one dispatcher copy with dedupeKey=weekKey +
 *      skipAdminInAppMirror, and persists the last-sent week key.
 *   9. Dedupe/gates — the same week never sends twice; kill switch
 *      (value "false") skips; Tuesday and Monday-before-8am-NY skip;
 *      empty rollup and empty recipients skip WITHOUT burning the week
 *      key; an all-recipients-failed fanout also preserves the week key
 *      so the next Monday pass retries.
 *  10. getDirectorPlusUsers — includes director + ceo authority AND the
 *      legacy role='ceo' bridge row; excludes lead/core seeds.
 *
 * Seeding uses per-run random suffixes; system settings touched
 * (permissive mode, digest kill switch, digest last-sent key) are
 * captured first and restored in finally via storage.setSystemSetting
 * (raw-SQL writes to system_settings are banned — the storage helper
 * keeps its caches consistent).
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { getGlobalDispatcher } from "undici";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { __resetPermissiveModeCacheForTests } from "../server/auth/permissions";
import { registerChurnRoutes } from "../server/routes/churn";
import { registerAgentRoutes } from "../server/routes/agents";
import { getDirectorPlusUsers } from "../server/services/notifications/recipients";
import {
  buildOpenAsksDigest,
  checkAndSendOpenAsksDigest,
  getOpenAsksDigestWeekKey,
  KILL_SWITCH_OPEN_ASKS_DIGEST,
  OPEN_ASKS_DIGEST_NOTIFICATION_ID,
  OPEN_ASKS_TAB_DEEP_LINK,
  SETTING_OPEN_ASKS_DIGEST_LAST_SENT,
  __resetOpenAsksDigestDepsForTest,
  __setOpenAsksDigestDepsForTest,
  type OpenAsksDigestRunResult,
} from "../server/services/openAsksDigest";
import type { OpenAskRollupItem } from "../server/services/openAsksRollup";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const RUN = `t3694-${randomBytes(4).toString("hex")}`;

const DIRECTOR_ID = `${RUN}-director`;
const LEAD_ID = `${RUN}-lead`;
const CORE_ID = `${RUN}-core`;
const OWNER_ID = `${RUN}-owner`; // ceo authority; owns client A + archived + demo
const OWNER2_ID = `${RUN}-owner2`; // core authority; owns client B (owner-filter target)
const LEGACY_ID = `${RUN}-legacy`; // role='ceo' but core authority — the legacy bridge
const DIRECTOR2_ID = `${RUN}-director2`; // director authority, legacy role OUTSIDE the ladder
const OUTSIDER_ID = `${RUN}-outsider`; // unmapped legacy role, core authority, owns nothing
const GHOST_ID = `${RUN}-ghost`;

const C_A = `${RUN}-client-a`;
const C_B = `${RUN}-client-b`;
const C_ARCHIVED = `${RUN}-client-archived`;
const C_DEMO = `${RUN}-client-demo`;

// Ranking seed (ages via NOW() - INTERVAL so ageDays is deterministic ±ε):
//   A1: 60d × concern 2 (2 mentions)      → rank ≈120  (oldest)
//   B1: 20d × concern 3 (3 mentions)      → rank ≈60
//   A2: 10d × concern 5 (5 mentions)      → rank ≈50   (highest concern, youngest)
//   A3: 40d × concern NULL→1 (NULL→1 mentions) → rank ≈40
// Orders: rank A1>B1>A2>A3 · age A1>A3>B1>A2 · concern A2>B1>A1>A3 ·
// mentions A2>B1>A1>A3 — pairwise distinct (see docblock §3).
const ASK_A1 = `${RUN}-ask-a1`;
const ASK_A2 = `${RUN}-ask-a2`;
const ASK_A3 = `${RUN}-ask-a3`;
const ASK_B1 = `${RUN}-ask-b1`;
const ASK_B_RES = `${RUN}-ask-b-resolved`;
const ASK_B_DIS = `${RUN}-ask-b-dismissed`;
const ASK_B_LR = `${RUN}-ask-b-likelyres`;
const ASK_ARCH = `${RUN}-ask-archived`;
const ASK_DEMO = `${RUN}-ask-demo`;

const MY_ASK_IDS = [ASK_A1, ASK_A2, ASK_A3, ASK_B1, ASK_B_RES, ASK_B_DIS, ASK_B_LR, ASK_ARCH, ASK_DEMO];

const PERMISSIVE_KEY = "role_permissions_permissive_mode";

// Monday 2026-08-03 16:00 UTC = 12:00 America/New_York (EDT, in-window).
const MONDAY_NOON = Date.UTC(2026, 7, 3, 16, 0, 0);
const WEEK_KEY = "2026-W32";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function between(actual: unknown, lo: number, hi: number, msg: string): void {
  if (typeof actual !== "number" || actual < lo || actual > hi) {
    throw new Error(`${msg}: expected ${lo}..${hi}, got ${JSON.stringify(actual)}`);
  }
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${DIRECTOR_ID}, ${`${DIRECTOR_ID}@t3694.example`}, 'Task3694', 'Director', 'account_manager', 'director'),
      (${LEAD_ID}, ${`${LEAD_ID}@t3694.example`}, 'Task3694', 'Lead', 'team_lead', 'lead'),
      (${CORE_ID}, ${`${CORE_ID}@t3694.example`}, 'Task3694', 'Core', 'account_manager', 'core'),
      (${OWNER_ID}, ${`${OWNER_ID}@t3694.example`}, 'Task3694', 'Owner', 'ceo', 'ceo'),
      (${OWNER2_ID}, ${`${OWNER2_ID}@t3694.example`}, 'Task3694', 'OwnerTwo', 'account_manager', 'core'),
      (${LEGACY_ID}, ${`${LEGACY_ID}@t3694.example`}, 'Task3694', 'LegacyCeo', 'ceo', 'core'),
      (${DIRECTOR2_ID}, ${`${DIRECTOR2_ID}@t3694.example`}, 'Task3694', 'DirectorTwo', 'user', 'director'),
      (${OUTSIDER_ID}, ${`${OUTSIDER_ID}@t3694.example`}, 'Task3694', 'Outsider', 'user', 'core')
  `);

  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES
      (${C_A}, ${`${RUN} Alpha Firm`}, ${OWNER_ID}, false, false),
      (${C_B}, ${`${RUN} Bravo Firm`}, ${OWNER2_ID}, false, false),
      (${C_ARCHIVED}, ${`${RUN} Archived Firm`}, ${OWNER_ID}, true, false),
      (${C_DEMO}, ${`${RUN} Demo Firm`}, ${OWNER_ID}, false, true)
  `);

  // NULL concern/mentions on A3 pin the COALESCE→1 behavior. The archived
  // and demo asks get the most extreme age+concern so any exclusion
  // regression would surface at the TOP of the list, not hide mid-table.
  await db.execute(sql`
    INSERT INTO client_open_asks
      (id, client_id, ask_type, status, summary, detail, ask_category, related_promise_text,
       concern_score, mention_count, first_mentioned_at, last_referenced_at)
    VALUES
      (${ASK_A1}, ${C_A}, 'client_ask', 'open',
       ${"Fix the intake phone tree"}, ${"Client asked twice about the phone tree."}, 'operations', NULL,
       2, 2, NOW() - INTERVAL '60 days', NOW() - INTERVAL '2 days'),
      (${ASK_A2}, ${C_A}, 'internal_promise', 'likely_open',
       ${"Deliver the promised landing page"}, NULL, 'marketing', ${"We promised a new landing page by June"},
       5, 5, NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 days'),
      (${ASK_A3}, ${C_A}, 'client_ask', 'open',
       ${"Send the quarterly report"}, NULL, NULL, NULL,
       NULL, NULL, NOW() - INTERVAL '40 days', NOW() - INTERVAL '5 days'),
      (${ASK_B1}, ${C_B}, 'client_ask', 'open',
       ${"Update the GBP categories"}, NULL, 'seo', NULL,
       3, 3, NOW() - INTERVAL '20 days', NOW() - INTERVAL '3 days'),
      (${ASK_B_RES}, ${C_B}, 'client_ask', 'resolved',
       ${"Resolved ask must not appear"}, NULL, NULL, NULL,
       9, 9, NOW() - INTERVAL '90 days', NOW()),
      (${ASK_B_DIS}, ${C_B}, 'client_ask', 'dismissed',
       ${"Dismissed ask must not appear"}, NULL, NULL, NULL,
       9, 9, NOW() - INTERVAL '90 days', NOW()),
      (${ASK_B_LR}, ${C_B}, 'internal_promise', 'likely_resolved',
       ${"Likely-resolved promise must not appear"}, NULL, NULL, NULL,
       9, 9, NOW() - INTERVAL '90 days', NOW()),
      (${ASK_ARCH}, ${C_ARCHIVED}, 'client_ask', 'open',
       ${"Archived client ask must not appear"}, NULL, NULL, NULL,
       99, 9, NOW() - INTERVAL '400 days', NOW()),
      (${ASK_DEMO}, ${C_DEMO}, 'client_ask', 'open',
       ${"Demo client ask must not appear"}, NULL, NULL, NULL,
       99, 9, NOW() - INTERVAL '400 days', NOW())
  `);
}

async function cleanup(): Promise<void> {
  // Client deletes cascade to client_open_asks (FK ON DELETE CASCADE).
  try {
    await db.execute(sql`
      DELETE FROM clients WHERE id IN (${C_A}, ${C_B}, ${C_ARCHIVED}, ${C_DEMO})
    `);
  } catch {}
  try {
    await db.execute(sql`
      DELETE FROM users
      WHERE id IN (${DIRECTOR_ID}, ${LEAD_ID}, ${CORE_ID}, ${OWNER_ID}, ${OWNER2_ID}, ${LEGACY_ID}, ${DIRECTOR2_ID}, ${OUTSIDER_ID}, ${GHOST_ID})
    `);
  } catch {}
}

let actingUserId: string | null = DIRECTOR_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerChurnRoutes(app);
  // The inline resolve/dismiss flow reuses the per-client PATCH that
  // lives with the agent routes — mount them so §5 exercises the real
  // endpoint (same injected-session middleware).
  registerAgentRoutes(app);
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

async function call(baseUrl: string, qs = ""): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}/api/churn/open-asks${qs}`, { method: "GET" });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

async function patchAsk(
  baseUrl: string,
  clientId: string,
  askId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}/api/clients/${clientId}/open-asks/${askId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

/** Ids of MY seeded rows in response order (other tenants' rows dropped). */
function myOrder(json: any): string[] {
  return (json.asks as any[]).map((a) => a.id).filter((id) => MY_ASK_IDS.includes(id));
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

// ── Digest test scaffolding ────────────────────────────────────────────────

function mkItem(overrides: Partial<OpenAskRollupItem>): OpenAskRollupItem {
  return {
    id: `${RUN}-item`,
    clientId: `${RUN}-c`,
    firmName: "Fixture Firm",
    clientCode: null,
    ownerId: null,
    ownerName: "Fixture Owner",
    askType: "client_ask",
    status: "open",
    summary: "Fixture summary",
    detail: null,
    askCategory: null,
    relatedPromiseText: null,
    concernScore: 2,
    mentionCount: 2,
    firstMentionedAt: null,
    lastReferencedAt: null,
    ageDays: 30,
    rankScore: 60,
    ...overrides,
  };
}

interface RecordedSends {
  inApp: Array<{ userId: string; opts: any }>;
  dispatcher: Array<{ id: string; payload: any; opts: any }>;
}

function installDigestStubs(opts: {
  items: OpenAskRollupItem[];
  recipients: string[];
  inAppResult?: "ok" | "null";
}): RecordedSends {
  const recorded: RecordedSends = { inApp: [], dispatcher: [] };
  __setOpenAsksDigestDepsForTest({
    fetchRollup: async () => opts.items,
    getRecipients: async () => opts.recipients,
    sendUserNotification: (async (userId: string, o: any) => {
      recorded.inApp.push({ userId, opts: o });
      return opts.inAppResult === "null" ? null : { notification: { id: "fake" } as any, deduped: false };
    }) as any,
    sendDispatcherAlert: (async (id: string, payload: any, o: any) => {
      recorded.dispatcher.push({ id, payload, opts: o });
      return { attempted: true, delivered: true, skipped: false } as any;
    }) as any,
  });
  return recorded;
}

async function getLastSent(): Promise<string | null> {
  const row = await storage.getSystemSetting(SETTING_OPEN_ASKS_DIGEST_LAST_SENT);
  return row?.value ?? null;
}

async function main(): Promise<void> {
  console.log(`Aging asks & promises rollup + digest coverage (Task #3694) [${RUN}]`);

  const originalPermissive = await storage.getSystemSetting(PERMISSIVE_KEY);
  const originalKillSwitch = await storage.getSystemSetting(KILL_SWITCH_OPEN_ASKS_DIGEST);
  const originalLastSent = await storage.getSystemSetting(SETTING_OPEN_ASKS_DIGEST_LAST_SENT);

  await seed();
  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // ── Part A §1: authz matrix ──────────────────────────────────────
    await setPermissive("false");

    await step("strict mode: core ⇒ 403, lead ⇒ 403, director ⇒ 200", async () => {
      actingUserId = CORE_ID;
      const core = await call(baseUrl);
      assertEq(core.status, 403, "core status");
      assert(
        typeof core.json.error === "string" && core.json.error.includes("Director"),
        `403 body names the required level (got ${JSON.stringify(core.json.error)})`,
      );
      actingUserId = LEAD_ID;
      assertEq((await call(baseUrl)).status, 403, "lead status");
      actingUserId = DIRECTOR_ID;
      assertEq((await call(baseUrl)).status, 200, "director status");
    });

    await setPermissive("true");

    await step("permissive mode: core/lead STILL 403; director/ceo 200", async () => {
      actingUserId = CORE_ID;
      assertEq((await call(baseUrl)).status, 403, "core status (permissive)");
      actingUserId = LEAD_ID;
      assertEq((await call(baseUrl)).status, 403, "lead status (permissive)");
      actingUserId = DIRECTOR_ID;
      assertEq((await call(baseUrl)).status, 200, "director status (permissive)");
      actingUserId = OWNER_ID;
      assertEq((await call(baseUrl)).status, 200, "ceo-authority status (permissive)");
    });

    await step("unauthenticated ⇒ 401; unapproved unknown sub ⇒ 403", async () => {
      actingUserId = null;
      assertEq((await call(baseUrl)).status, 401, "status without a session");
      // Task #4554 closed admission: an unknown sub with no approved users
      // row is denied by requireAuth (account_not_approved) — no row is
      // written and the route never runs.
      actingUserId = GHOST_ID;
      assertEq((await call(baseUrl)).status, 403, "status for unapproved user");
    });

    // ── Part A §2-4, §6: scope, ranking, filters, shape (as director) ─
    actingUserId = DIRECTOR_ID;
    const base = await call(baseUrl);
    assertEq(base.status, 200, "rollup status for director");

    await step("scope: open/likely_open of active clients only", async () => {
      const ids = new Set((base.json.asks as any[]).map((a) => a.id));
      assert(ids.has(ASK_A1) && ids.has(ASK_A2) && ids.has(ASK_A3) && ids.has(ASK_B1), "all four live asks present");
      for (const [id, label] of [
        [ASK_B_RES, "resolved"],
        [ASK_B_DIS, "dismissed"],
        [ASK_B_LR, "likely_resolved"],
        [ASK_ARCH, "archived client"],
        [ASK_DEMO, "demo client"],
      ] as const) {
        assert(!ids.has(id), `${label} ask must be excluded`);
      }
      assert(typeof base.json.generatedAt === "string" && base.json.generatedAt.length > 0, "generatedAt present");
    });

    await step("default ranking is the age×concern blend (not age or concern alone)", async () => {
      assertEq(
        JSON.stringify(myOrder(base.json)),
        JSON.stringify([ASK_A1, ASK_B1, ASK_A2, ASK_A3]),
        "rank order A1(120) > B1(60) > A2(50) > A3(40)",
      );
      // Age alone would put A3(40d) second; concern alone would put A2(5)
      // first — both covered by the exact sequence above.
    });

    await step("row shape: names, effective scores, age/rank arithmetic, promise text", async () => {
      const a1 = (base.json.asks as any[]).find((a) => a.id === ASK_A1);
      assertEq(a1.clientId, C_A, "clientId");
      assertEq(a1.firmName, `${RUN} Alpha Firm`, "firmName");
      assertEq(a1.ownerId, OWNER_ID, "ownerId");
      assertEq(a1.ownerName, "Task3694 Owner", "ownerName");
      assertEq(a1.askType, "client_ask", "askType");
      assertEq(a1.status, "open", "status");
      assertEq(a1.concernScore, 2, "concernScore");
      assertEq(a1.mentionCount, 2, "mentionCount");
      between(a1.ageDays, 59.8, 60.2, "ageDays ≈ 60");
      between(a1.rankScore, 119.5, 120.5, "rankScore ≈ 60×2");
      assert(typeof a1.firstMentionedAt === "string", "firstMentionedAt ISO string");

      const a2 = (base.json.asks as any[]).find((a) => a.id === ASK_A2);
      assertEq(a2.status, "likely_open", "likely_open rows included with their status");
      assertEq(a2.relatedPromiseText, "We promised a new landing page by June", "relatedPromiseText passthrough");

      const a3 = (base.json.asks as any[]).find((a) => a.id === ASK_A3);
      assertEq(a3.concernScore, 1, "NULL concern coalesces to 1");
      assertEq(a3.mentionCount, 1, "NULL mentions coalesce to 1");
      between(a3.rankScore, 39.5, 40.5, "rankScore ≈ 40×1");
    });

    await step("askType filter narrows to promises; every returned row matches", async () => {
      const { status, json } = await call(baseUrl, "?askType=internal_promise");
      assertEq(status, 200, "status");
      assert((json.asks as any[]).every((a) => a.askType === "internal_promise"), "all rows internal_promise");
      assertEq(JSON.stringify(myOrder(json)), JSON.stringify([ASK_A2]), "only A2 among my rows");
    });

    await step("ownerId filter narrows to that owner's clients", async () => {
      const { status, json } = await call(baseUrl, `?ownerId=${OWNER2_ID}`);
      assertEq(status, 200, "status");
      assert((json.asks as any[]).every((a) => a.ownerId === OWNER2_ID), "all rows owned by owner2");
      assertEq(JSON.stringify(myOrder(json)), JSON.stringify([ASK_B1]), "only B1 among my rows");
    });

    await step("clientId filter + sort=age|concern|mentions exact orders", async () => {
      const rank = await call(baseUrl, `?clientId=${C_A}`);
      assertEq(JSON.stringify(myOrder(rank.json)), JSON.stringify([ASK_A1, ASK_A2, ASK_A3]), "client A default rank");
      assertEq((rank.json.asks as any[]).length, 3, "clientId filter returns exactly client A's rows");

      const age = await call(baseUrl, `?clientId=${C_A}&sort=age`);
      assertEq(JSON.stringify(myOrder(age.json)), JSON.stringify([ASK_A1, ASK_A3, ASK_A2]), "sort=age");

      const concern = await call(baseUrl, `?clientId=${C_A}&sort=concern`);
      assertEq(JSON.stringify(myOrder(concern.json)), JSON.stringify([ASK_A2, ASK_A1, ASK_A3]), "sort=concern");

      const mentions = await call(baseUrl, `?clientId=${C_A}&sort=mentions`);
      assertEq(JSON.stringify(myOrder(mentions.json)), JSON.stringify([ASK_A2, ASK_A1, ASK_A3]), "sort=mentions");
    });

    await step("bogus askType/sort values ⇒ 400", async () => {
      assertEq((await call(baseUrl, "?askType=bogus")).status, 400, "bad askType");
      assertEq((await call(baseUrl, "?sort=bogus")).status, 400, "bad sort");
    });

    // ── Part A §5: inline resolve/dismiss authorization ──────────────
    await step("director outside the legacy ladder can act inline on a non-owned client", async () => {
      // The gap the completion review flagged: the rollup keys on
      // authority_level, but the reused per-client PATCH used to key
      // only on the legacy account_manager ladder + ownership — so a
      // director with an unmapped legacy role could SEE every ask yet
      // 403 on both inline actions.
      actingUserId = DIRECTOR2_ID;
      assertEq((await call(baseUrl)).status, 200, "rollup readable via authority gate");
      const dismissed = await patchAsk(baseUrl, C_B, ASK_B1, {
        status: "dismissed",
        resolutionNote: "Handled out of band.",
      });
      assertEq(dismissed.status, 200, "dismiss allowed for churn-surface director");
      assertEq(dismissed.json.status, "dismissed", "persisted status");
      assertEq(dismissed.json.resolutionNote, "Handled out of band.", "persisted note");
      assertEq(dismissed.json.resolvedBy, DIRECTOR2_ID, "actor attribution");
      // Reopen so the seed row stays live for anything after this step.
      const reopened = await patchAsk(baseUrl, C_B, ASK_B1, { status: "open" });
      assertEq(reopened.status, 200, "reopen allowed");
      assertEq(reopened.json.status, "open", "row reopened");
    });

    await step("unmapped-role non-director non-owner keeps getting 403 on the PATCH", async () => {
      actingUserId = OUTSIDER_ID;
      const denied = await patchAsk(baseUrl, C_B, ASK_B1, { status: "dismissed" });
      assertEq(denied.status, 403, "ladder-or-owner-or-director requirement preserved");
      assertEq((await call(baseUrl)).status, 403, "rollup stays closed below director too");
    });

    // ── Part B §7: week key + composition (pure) ─────────────────────
    await step("ISO week key: Monday 2026-08-03 ⇒ 2026-W32; Sunday before ⇒ W31", async () => {
      assertEq(getOpenAsksDigestWeekKey(new Date(MONDAY_NOON)), WEEK_KEY, "Monday noon");
      assertEq(getOpenAsksDigestWeekKey(new Date(Date.UTC(2026, 7, 2, 12, 0))), "2026-W31", "Sunday before");
      // Late Monday NY (23:30 EDT = Tuesday 03:30 UTC) stays in the same
      // ISO week — the send window can never straddle two keys.
      assertEq(getOpenAsksDigestWeekKey(new Date(Date.UTC(2026, 7, 4, 3, 30))), WEEK_KEY, "late Monday NY");
    });

    await step("digest composition: counts in title, ranked offender lines, deep link", async () => {
      const items = [
        mkItem({ id: "i1", firmName: "Acme Law", ownerName: "Jane Smith", askType: "internal_promise", summary: "Launch the promised landing page", ageDays: 62.7, mentionCount: 4, concernScore: 5 }),
        mkItem({ id: "i2", firmName: "Bravo Legal", ownerName: null, summary: "Fix the intake phone tree", ageDays: 41.2, mentionCount: 2, concernScore: 2 }),
      ];
      const content = buildOpenAsksDigest(items, { totalCount: 7, clientCount: 4 });
      assertEq(content.title, "Aging asks & promises: 7 open items across 4 clients", "title");
      assert(content.body.startsWith("1. Acme Law (Jane Smith) — Internal promise:"), `line 1 ranked+typed (got ${JSON.stringify(content.body.split("\n")[0])})`);
      assert(content.body.includes("[62d old, mentioned 4×, concern 5]"), "line 1 age/mentions/concern");
      assert(content.body.includes("2. Bravo Legal — Client ask: Fix the intake phone tree"), "line 2 without owner parens");
      assert(content.text.includes(content.title), "text carries the title");
      assert(content.text.includes(OPEN_ASKS_TAB_DEEP_LINK), "text carries the tab deep link");
    });

    // ── Part B §8-9: send flow + gates (injected deps) ───────────────
    // Pin the two digest settings for the whole block; restored in finally.
    await storage.setSystemSetting(KILL_SWITCH_OPEN_ASKS_DIGEST, "true", "system");
    await storage.setSystemSetting(SETTING_OPEN_ASKS_DIGEST_LAST_SENT, "2020-W01", "system");

    const threeItems = [
      mkItem({ id: "d1", clientId: "c1", firmName: "Acme Law", ageDays: 62, concernScore: 5, rankScore: 310 }),
      mkItem({ id: "d2", clientId: "c2", firmName: "Bravo Legal", ageDays: 41, concernScore: 2, rankScore: 82 }),
      mkItem({ id: "d3", clientId: "c1", firmName: "Acme Law", ageDays: 12, concernScore: 3, rankScore: 36 }),
    ];
    const RECIP_A = `${RUN}-recip-a`;
    const RECIP_B = `${RUN}-recip-b`;

    await step("Monday noon: sends per-recipient in-app rows + dispatcher copy, persists week key", async () => {
      const recorded = installDigestStubs({ items: threeItems, recipients: [RECIP_A, RECIP_B] });
      const result = await checkAndSendOpenAsksDigest(MONDAY_NOON);
      assertEq(result.decision, "sent", "decision");
      assertEq(result.totalCount, 3, "totalCount");
      assertEq(result.recipientCount, 2, "recipientCount");
      assertEq(result.inAppDelivered, 2, "inAppDelivered");

      assertEq(recorded.inApp.length, 2, "one in-app row per recipient");
      assertEq(new Set(recorded.inApp.map((c) => c.userId)).size, 2, "distinct recipients");
      for (const c of recorded.inApp) {
        assertEq(c.opts.dedupeKey, `open-asks-digest:${WEEK_KEY}`, "in-app dedupeKey is week-scoped");
        assertEq(c.opts.deepLink, OPEN_ASKS_TAB_DEEP_LINK, "in-app deepLink");
        assertEq(c.opts.category, "agent", "in-app category");
        assert(String(c.opts.title).includes("3 open items"), "title carries total count");
        assert(String(c.opts.title).includes("2 clients"), "title carries client count");
      }

      assertEq(recorded.dispatcher.length, 1, "exactly one dispatcher send");
      const d = recorded.dispatcher[0];
      assertEq(d.id, OPEN_ASKS_DIGEST_NOTIFICATION_ID, "dispatcher notification id");
      assertEq(d.opts.dedupeKey, WEEK_KEY, "dispatcher dedupeKey is the week key");
      assertEq(d.opts.skipAdminInAppMirror, true, "mirror suppressed (digest writes its own targeted rows)");
      assertEq(d.opts.triggerSource, "scheduled", "triggerSource");

      assertEq(await getLastSent(), WEEK_KEY, "last-sent week key persisted");
    });

    await step("same week again ⇒ skipped_already_sent with zero sends", async () => {
      const recorded = installDigestStubs({ items: threeItems, recipients: [RECIP_A, RECIP_B] });
      const result = await checkAndSendOpenAsksDigest(MONDAY_NOON + 3 * 3600_000);
      assertEq(result.decision, "skipped_already_sent", "decision");
      assertEq(recorded.inApp.length, 0, "no in-app sends");
      assertEq(recorded.dispatcher.length, 0, "no dispatcher sends");
    });

    await step("kill switch value 'false' ⇒ skipped_kill_switch before any work", async () => {
      await storage.setSystemSetting(SETTING_OPEN_ASKS_DIGEST_LAST_SENT, "2020-W01", "system");
      await storage.setSystemSetting(KILL_SWITCH_OPEN_ASKS_DIGEST, "false", "system");
      const recorded = installDigestStubs({ items: threeItems, recipients: [RECIP_A] });
      const result = await checkAndSendOpenAsksDigest(MONDAY_NOON);
      assertEq(result.decision, "skipped_kill_switch", "decision");
      assertEq(recorded.inApp.length + recorded.dispatcher.length, 0, "zero sends");
      assertEq(await getLastSent(), "2020-W01", "week key not burned");
      await storage.setSystemSetting(KILL_SWITCH_OPEN_ASKS_DIGEST, "true", "system");
    });

    await step("Tuesday and Monday-6am-NY ⇒ skipped_not_window", async () => {
      const recorded = installDigestStubs({ items: threeItems, recipients: [RECIP_A] });
      const tuesday = await checkAndSendOpenAsksDigest(Date.UTC(2026, 7, 4, 16, 0));
      assertEq(tuesday.decision, "skipped_not_window", "Tuesday decision");
      // 10:00 UTC on 2026-08-03 is 06:00 America/New_York (EDT) — before
      // the 8am eligibility hour.
      const early = await checkAndSendOpenAsksDigest(Date.UTC(2026, 7, 3, 10, 0));
      assertEq(early.decision, "skipped_not_window", "early-Monday decision");
      assertEq(recorded.inApp.length + recorded.dispatcher.length, 0, "zero sends");
    });

    await step("empty rollup ⇒ skipped_no_items; empty recipients ⇒ skipped_no_recipients (key preserved)", async () => {
      const noItems = installDigestStubs({ items: [], recipients: [RECIP_A] });
      assertEq((await checkAndSendOpenAsksDigest(MONDAY_NOON)).decision, "skipped_no_items", "no-items decision");
      assertEq(noItems.inApp.length + noItems.dispatcher.length, 0, "no sends without items");

      const noRecips = installDigestStubs({ items: threeItems, recipients: [] });
      assertEq((await checkAndSendOpenAsksDigest(MONDAY_NOON)).decision, "skipped_no_recipients", "no-recipients decision");
      assertEq(noRecips.inApp.length + noRecips.dispatcher.length, 0, "no sends without recipients");

      assertEq(await getLastSent(), "2020-W01", "week key untouched by skips");
    });

    await step("all in-app sends fail ⇒ skipped_send_failed, week key preserved, no dispatcher copy", async () => {
      const recorded = installDigestStubs({ items: threeItems, recipients: [RECIP_A, RECIP_B], inAppResult: "null" });
      const result = await checkAndSendOpenAsksDigest(MONDAY_NOON);
      assertEq(result.decision, "skipped_send_failed", "decision");
      assertEq(result.inAppDelivered, 0, "nothing delivered");
      assertEq(recorded.dispatcher.length, 0, "dispatcher copy withheld when fanout failed");
      assertEq(await getLastSent(), "2020-W01", "week key preserved so next Monday retries");
    });

    // ── Part B §10: real recipient resolution ────────────────────────
    await step("getDirectorPlusUsers: director + ceo authority + legacy role bridge in; lead/core out", async () => {
      const ids = await getDirectorPlusUsers();
      assert(ids.includes(DIRECTOR_ID), "director authority included");
      assert(ids.includes(DIRECTOR2_ID), "unmapped-legacy-role director included");
      assert(ids.includes(OWNER_ID), "ceo authority included");
      assert(ids.includes(LEGACY_ID), "legacy role='ceo' bridge included");
      assert(!ids.includes(LEAD_ID), "lead excluded");
      assert(!ids.includes(CORE_ID), "core excluded");
      assert(!ids.includes(OWNER2_ID), "core owner excluded");
      assert(!ids.includes(OUTSIDER_ID), "unmapped-role core excluded");
    });
  } finally {
    // Sever keep-alive sockets on the server side up front, and close the
    // undici client dispatcher global fetch uses at the very end (after
    // cleanup's DB work) — otherwise pooled sockets keep the event loop
    // alive after the pg pools drain and the process never exits.
    server.closeAllConnections();
    server.close();
    __resetOpenAsksDigestDepsForTest();
    // Restore every pinned setting exactly as found. Missing originals
    // restore to their default-equivalent values ("false" permissive =
    // helper default; "true" kill switch = enabled default; "" last-sent
    // matches no week key).
    try {
      await storage.setSystemSetting(PERMISSIVE_KEY, originalPermissive?.value ?? "false", "system");
    } catch {}
    __resetPermissiveModeCacheForTests();
    try {
      await storage.setSystemSetting(KILL_SWITCH_OPEN_ASKS_DIGEST, originalKillSwitch?.value ?? "true", "system");
    } catch {}
    try {
      await storage.setSystemSetting(SETTING_OPEN_ASKS_DIGEST_LAST_SENT, originalLastSent?.value ?? "", "system");
    } catch {}
    await cleanup();
    await getGlobalDispatcher().close();
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll churn-open-asks tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit(); a
// leaked handle surfaces as a hang instead of being masked by a forced exit.
let exitCode = 0;
main()
  .catch((err) => {
    console.error("churn-open-asks: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
