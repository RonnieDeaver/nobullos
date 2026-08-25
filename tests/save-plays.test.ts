/* test-registration
{
  "name": "Save-play tracker API (Task #3696)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3696: save-play tracker — per-client CRUD authz (role-or-owner, ghost 403), lifecycle closure stamping (complete/abandon/reactivate), create-time source-judgment/assignee validation, and the director-gated rollup: active-play-only coverage, uncovered-first ordering, archived- kept/demo-excluded plays, and server-side overdue derivation. Same harness profile as the churn leaderboard test above (injected session, per-run suffixed rows, cascade cleanup, fast). A drift here either opens the rollup below director or mis-reports who's saving an at-risk client — the accountability surface this feature exists for.",
  "tier": "small"
}
test-registration */
/**
 * Task #3696 — Save-play tracker API coverage.
 *
 * Pins the contract of the save-play endpoints end-to-end through a real
 * Express app (real registerSavePlayRoutes + real isAuthenticated behind the
 * Clerk per-request test seam, following tests/deals-routes.test.ts):
 *
 *   1. Per-client CRUD + authz — account_manager+ role OR client owner can
 *      manage plays (mirrors the daily-judgment routes); a low-role
 *      non-owner gets 403 and an unapproved unknown sub is denied at
 *      admission (Task #4554 closed sign-in, also 403); missing
 *      client 404; unauthenticated 401. Create validates title/dueDate
 *      shape, that the assignee exists, and that a sourceJudgmentId
 *      belongs to the same client (400, never an FK 500).
 *   2. Lifecycle — completing/abandoning a play stamps closedAt +
 *      closedByUserId (the acting user) and keeps the outcome note;
 *      reactivating clears the closure stamps but keeps the note history;
 *      strict body validation rejects unknown fields and empty PATCHes.
 *   3. Rollup authz — GET /api/churn/save-plays uses the STRICT director
 *      gate (same as the churn leaderboard): core and lead get 403 with
 *      permissive mode pinned OFF and ON; director gets 200.
 *   4. Rollup coverage — riskyClients lists only active (non-archived,
 *      non-demo) clients whose LATEST judgment is At Risk/Critical, with
 *      hasActivePlay/activePlayCount computed from ACTIVE plays only (a
 *      completed play does not count as coverage) and uncovered clients
 *      ordered first. An older Healthy judgment on the covered client
 *      proves latest-row selection.
 *   5. Rollup plays list — carries every non-demo client's plays (archived
 *      clients kept + flagged clientArchived so history survives churn),
 *      with firm name, assignee display name, and server-derived overdue
 *      (active AND due_date < CURRENT_DATE; a closed play with a past due
 *      date is NOT overdue).
 *
 * Seeding uses per-run random suffixes on ids/emails so repeated or
 * concurrent runs never collide, and cleans up in finally (client deletes
 * cascade to judgments and plays). The permissive-mode switch is captured
 * first and restored in finally, with __resetPermissiveModeCacheForTests()
 * after every flip.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { __resetPermissiveModeCacheForTests } from "../server/auth/permissions";
import { registerSavePlayRoutes } from "../server/routes/savePlays";

const RUN = `t3696-${randomBytes(4).toString("hex")}`;

const DIRECTOR_ID = `${RUN}-director`; // authority director, legacy role account_manager
const AM_ID = `${RUN}-am`;             // core authority, account_manager role → CRUD yes, rollup no
const LEAD_ID = `${RUN}-lead`;         // lead authority → rollup 403
const OWNERLOW_ID = `${RUN}-ownerlow`; // 'sales' role (no ROLE_LEVELS entry) → owner-path only
const GHOST_ID = `${RUN}-ghost`;       // session sub with no pre-seeded users row

const C_COVERED = `${RUN}-client-covered`;     // At Risk latest; gets an active play via API
const C_UNCOVERED = `${RUN}-client-uncovered`; // Critical latest; only a completed play
const C_HEALTHY = `${RUN}-client-healthy`;     // Healthy latest; active OVERDUE play
const C_ARCHIVED = `${RUN}-client-archived`;   // archived; Critical; active play (history kept)
const C_DEMO = `${RUN}-client-demo`;           // demo; Critical; play must vanish everywhere
const C_OWNED = `${RUN}-client-owned`;         // owned by OWNERLOW_ID; owner-path CRUD

const PERMISSIVE_KEY = "role_permissions_permissive_mode";

// Due dates are NOW-relative, matching the CURRENT_DATE-based SQL seeds
// below: a hardcoded "future" ISO date rots into the past on the calendar
// (this suite went red the day 2026-08-10 stopped being future, breaking the
// overdue-derivation and overdue-first ordering checks). Margins ≥3 days
// keep every check clear of UTC/DB date boundaries.
const isoDaysFromNow = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const DUE_NEXT_WEEK = isoDaysFromNow(10); // valid-shape date for creates that must stay non-overdue
const DUE_CREATE = isoDaysFromNow(7);     // playId's initial dueDate (echo-asserted)
const DUE_EDIT = isoDaysFromNow(3);       // playId's PATCHed dueDate — must stay FUTURE for the overdue check

let judgmentCoveredId = "";   // latest At Risk judgment on C_COVERED
let judgmentUncoveredId = ""; // judgment on C_UNCOVERED (wrong-client source test)
let healthyPlayId = "";       // SQL-seeded overdue active play on C_HEALTHY
let archivedPlayId = "";      // SQL-seeded active play on C_ARCHIVED
let uncoveredPlayId = "";     // SQL-seeded completed play (past due) on C_UNCOVERED
let demoPlayId = "";          // SQL-seeded play on C_DEMO

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${DIRECTOR_ID}, ${`${DIRECTOR_ID}@t3696.example`}, 'Task3696', 'Director', 'account_manager', 'director'),
      (${AM_ID}, ${`${AM_ID}@t3696.example`}, 'Task3696', 'Manager', 'account_manager', 'core'),
      (${LEAD_ID}, ${`${LEAD_ID}@t3696.example`}, 'Task3696', 'Lead', 'team_lead', 'lead'),
      (${OWNERLOW_ID}, ${`${OWNERLOW_ID}@t3696.example`}, 'Task3696', 'Ownerlow', 'sales', 'core')
  `);

  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES
      (${C_COVERED}, ${`${RUN} Covered Firm`}, ${DIRECTOR_ID}, false, false),
      (${C_UNCOVERED}, ${`${RUN} Uncovered Firm`}, ${DIRECTOR_ID}, false, false),
      (${C_HEALTHY}, ${`${RUN} Healthy Firm`}, ${DIRECTOR_ID}, false, false),
      (${C_ARCHIVED}, ${`${RUN} Archived Firm`}, ${DIRECTOR_ID}, true, false),
      (${C_DEMO}, ${`${RUN} Demo Firm`}, ${DIRECTOR_ID}, false, true),
      (${C_OWNED}, ${`${RUN} Owned Firm`}, ${OWNERLOW_ID}, false, false)
  `);

  // Judgments. C_COVERED gets an older Healthy row so the rollup's
  // DISTINCT ON latest-row selection is what classifies it At Risk.
  const jCovered = await db.execute(sql`
    INSERT INTO client_daily_judgments (client_id, judgment_date, status, risk_score)
    VALUES (${C_COVERED}, '2026-08-01', 'At Risk', 62.5)
    RETURNING id
  `);
  judgmentCoveredId = (jCovered as any).rows[0].id;
  await db.execute(sql`
    INSERT INTO client_daily_judgments (client_id, judgment_date, status, risk_score)
    VALUES (${C_COVERED}, '2026-07-01', 'Healthy', 10)
  `);
  const jUncovered = await db.execute(sql`
    INSERT INTO client_daily_judgments (client_id, judgment_date, status, risk_score)
    VALUES (${C_UNCOVERED}, '2026-08-02', 'Critical', 91)
    RETURNING id
  `);
  judgmentUncoveredId = (jUncovered as any).rows[0].id;
  await db.execute(sql`
    INSERT INTO client_daily_judgments (client_id, judgment_date, status, risk_score)
    VALUES
      (${C_HEALTHY}, '2026-08-02', 'Healthy', 8),
      (${C_ARCHIVED}, '2026-08-02', 'Critical', 97),
      (${C_DEMO}, '2026-08-02', 'Critical', 96)
  `);

  // Rollup fixtures seeded directly (the CRUD-path plays are created via
  // the API in the steps below):
  //  - healthy: ACTIVE, due 3 days ago → overdue TRUE
  //  - archived: ACTIVE, due in 5 days → overdue FALSE, clientArchived TRUE
  //  - uncovered: COMPLETED, due 10 days ago → overdue FALSE (closed plays
  //    never flag) and no coverage (completed ≠ active)
  //  - demo: ACTIVE → must never appear anywhere
  const seededPlays = await db.execute(sql`
    INSERT INTO client_save_plays (client_id, title, assigned_to_user_id, due_date, status, outcome_note, closed_at, closed_by_user_id, created_by_user_id)
    VALUES
      (${C_HEALTHY}, ${`${RUN} healthy overdue play`}, ${AM_ID}, CURRENT_DATE - 3, 'active', NULL, NULL, NULL, ${AM_ID}),
      (${C_ARCHIVED}, ${`${RUN} archived play`}, ${DIRECTOR_ID}, CURRENT_DATE + 5, 'active', NULL, NULL, NULL, ${DIRECTOR_ID}),
      (${C_UNCOVERED}, ${`${RUN} tried and finished`}, ${AM_ID}, CURRENT_DATE - 10, 'completed', 'Client stabilized for a while', now(), ${AM_ID}, ${AM_ID}),
      (${C_DEMO}, ${`${RUN} demo play`}, ${AM_ID}, CURRENT_DATE + 1, 'active', NULL, NULL, NULL, ${AM_ID})
    RETURNING id, client_id
  `);
  for (const row of (seededPlays as any).rows) {
    if (row.client_id === C_HEALTHY) healthyPlayId = row.id;
    if (row.client_id === C_ARCHIVED) archivedPlayId = row.id;
    if (row.client_id === C_UNCOVERED) uncoveredPlayId = row.id;
    if (row.client_id === C_DEMO) demoPlayId = row.id;
  }
}

async function cleanup(): Promise<void> {
  // Client deletes cascade to client_daily_judgments and client_save_plays.
  try {
    await db.execute(sql`
      DELETE FROM clients
      WHERE id IN (${C_COVERED}, ${C_UNCOVERED}, ${C_HEALTHY}, ${C_ARCHIVED}, ${C_DEMO}, ${C_OWNED})
    `);
  } catch {}
  try {
    await db.execute(sql`
      DELETE FROM users
      WHERE id IN (${DIRECTOR_ID}, ${AM_ID}, ${LEAD_ID}, ${OWNERLOW_ID}, ${GHOST_ID})
    `);
  } catch {}
}

// Clerk per-request test seam (server/middlewares/requireAuth.ts): the real
// isAuthenticated/requireAuth middleware runs against seeded user rows. A
// string authenticates as that user id; null models an unauthenticated request
// (→ 401).
let actingUserId: string | null = AM_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerSavePlayRoutes(app);
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

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
  console.log(`Save-play tracker API coverage (Task #3696) [${RUN}]`);

  const originalPermissive = await storage.getSystemSetting(PERMISSIVE_KEY);
  await seed();
  const app = buildApp();
  const { server, baseUrl: url } = await listen(app);
  baseUrl = url;

  try {
    // ── 1. Per-client CRUD authz ─────────────────────────────────────
    await setPermissive("false");

    await step("unauthenticated ⇒ 401 on list, create, and rollup", async () => {
      actingUserId = null;
      assertEq((await req("GET", `/api/clients/${C_COVERED}/save-plays`)).status, 401, "list status");
      assertEq((await req("POST", `/api/clients/${C_COVERED}/save-plays`, { title: "x" })).status, 401, "create status");
      assertEq((await req("GET", `/api/churn/save-plays`)).status, 401, "rollup status");
    });

    await step("unknown client ⇒ 404", async () => {
      actingUserId = AM_ID;
      const { status } = await req("GET", `/api/clients/${RUN}-no-such-client/save-plays`);
      assertEq(status, 404, "status for missing client");
    });

    await step("low-role non-owner ⇒ 403; owner of a DIFFERENT client still 403", async () => {
      actingUserId = OWNERLOW_ID;
      assertEq((await req("GET", `/api/clients/${C_COVERED}/save-plays`)).status, 403, "list as low-role non-owner");
      assertEq(
        (await req("POST", `/api/clients/${C_COVERED}/save-plays`, {
          title: "nope", assignedToUserId: OWNERLOW_ID, dueDate: DUE_NEXT_WEEK,
        })).status,
        403,
        "create as low-role non-owner",
      );
    });

    await step("unapproved unknown sub is denied at admission ⇒ 403", async () => {
      // Task #4554 closed admission: requireAuth no longer JIT-provisions a
      // users row for an unknown authenticated id — the ghost session is
      // denied outright (403 account_not_approved) before the route runs,
      // and no users row is written. The meaningful per-client ROLE denial
      // remains the BELOW-account_manager non-owner (the 'sales' case
      // above). Pinned here so a change to admission or the route's gate
      // surfaces as a diff.
      actingUserId = GHOST_ID;
      const { status } = await req("GET", `/api/clients/${C_COVERED}/save-plays`);
      assertEq(status, 403, "status for ghost user (denied at admission)");
    });

    await step("client owner with low role manages plays on THEIR client", async () => {
      actingUserId = OWNERLOW_ID;
      const created = await req("POST", `/api/clients/${C_OWNED}/save-plays`, {
        title: `${RUN} owner-path play`,
        assignedToUserId: OWNERLOW_ID,
        dueDate: DUE_NEXT_WEEK,
      });
      assertEq(created.status, 201, "owner create status");
      const list = await req("GET", `/api/clients/${C_OWNED}/save-plays`);
      assertEq(list.status, 200, "owner list status");
      assert(list.json.some((p: any) => p.id === created.json.id), "owner sees their play");
    });

    // ── 2. Create validation ─────────────────────────────────────────
    await step("create validation: missing title / bad dueDate / unknown assignee / unknown field", async () => {
      actingUserId = AM_ID;
      assertEq(
        (await req("POST", `/api/clients/${C_COVERED}/save-plays`, { assignedToUserId: AM_ID, dueDate: DUE_NEXT_WEEK })).status,
        400, "missing title");
      assertEq(
        (await req("POST", `/api/clients/${C_COVERED}/save-plays`, { title: "x", assignedToUserId: AM_ID, dueDate: "Aug 20" })).status,
        400, "non-ISO dueDate");
      assertEq(
        (await req("POST", `/api/clients/${C_COVERED}/save-plays`, { title: "x", assignedToUserId: `${RUN}-nobody`, dueDate: DUE_NEXT_WEEK })).status,
        400, "unknown assignee");
      assertEq(
        (await req("POST", `/api/clients/${C_COVERED}/save-plays`, { title: "x", assignedToUserId: AM_ID, dueDate: DUE_NEXT_WEEK, bogus: 1 })).status,
        400, "unknown field rejected (strict schema)");
    });

    await step("create validation: source judgment must belong to the same client", async () => {
      actingUserId = AM_ID;
      const { status, json } = await req("POST", `/api/clients/${C_COVERED}/save-plays`, {
        title: "cross-client source",
        assignedToUserId: AM_ID,
        dueDate: DUE_NEXT_WEEK,
        sourceJudgmentId: judgmentUncoveredId,
      });
      assertEq(status, 400, "wrong-client judgment status");
      assert(String(json.error).includes("judgment"), "error mentions the judgment");
    });

    // ── 3. Lifecycle (create → edit → complete → reactivate → abandon) ─
    let playId = "";
    await step("create from a judgment's recommended action (201, active, stamped)", async () => {
      actingUserId = AM_ID;
      const { status, json } = await req("POST", `/api/clients/${C_COVERED}/save-plays`, {
        title: `${RUN} call the managing partner`,
        why: "Three unanswered emails in a row",
        assignedToUserId: AM_ID,
        dueDate: DUE_CREATE,
        notes: "Book before Friday",
        sourceJudgmentId: judgmentCoveredId,
      });
      assertEq(status, 201, "create status");
      playId = json.id;
      assertEq(json.status, "active", "new play is active");
      assertEq(json.clientId, C_COVERED, "clientId from path");
      assertEq(json.createdByUserId, AM_ID, "createdBy stamped from session");
      assertEq(json.sourceJudgmentId, judgmentCoveredId, "source judgment kept");
      assertEq(json.dueDate, DUE_CREATE, "dueDate echoed as YYYY-MM-DD");
      assertEq(json.closedAt, null, "no closure stamp on create");
    });

    await step("GET single play; 404 when the play belongs to another client", async () => {
      actingUserId = AM_ID;
      const one = await req("GET", `/api/clients/${C_COVERED}/save-plays/${playId}`);
      assertEq(one.status, 200, "single status");
      assertEq(one.json.id, playId, "single id");
      const cross = await req("GET", `/api/clients/${C_OWNED}/save-plays/${playId}`);
      assertEq(cross.status, 404, "cross-client fetch must 404");
    });

    await step("PATCH edits fields without touching status", async () => {
      actingUserId = AM_ID;
      const { status, json } = await req("PATCH", `/api/clients/${C_COVERED}/save-plays/${playId}`, {
        title: `${RUN} call the managing partner TODAY`,
        dueDate: DUE_EDIT,
        assignedToUserId: DIRECTOR_ID,
      });
      assertEq(status, 200, "edit status");
      assertEq(json.title, `${RUN} call the managing partner TODAY`, "title updated");
      assertEq(json.dueDate, DUE_EDIT, "dueDate updated");
      assertEq(json.assignedToUserId, DIRECTOR_ID, "owner reassigned");
      assertEq(json.status, "active", "status untouched");
      assertEq(json.closedAt, null, "still no closure stamp");
    });

    await step("PATCH validation: empty body, unknown field, bad status ⇒ 400", async () => {
      actingUserId = AM_ID;
      assertEq((await req("PATCH", `/api/clients/${C_COVERED}/save-plays/${playId}`, {})).status, 400, "empty body");
      assertEq((await req("PATCH", `/api/clients/${C_COVERED}/save-plays/${playId}`, { nope: true })).status, 400, "unknown field");
      assertEq((await req("PATCH", `/api/clients/${C_COVERED}/save-plays/${playId}`, { status: "paused" })).status, 400, "invalid status");
    });

    await step("complete stamps closedAt/closedBy (the acting user) + outcome note", async () => {
      actingUserId = DIRECTOR_ID; // director closes it, not the creator
      const { status, json } = await req("PATCH", `/api/clients/${C_COVERED}/save-plays/${playId}`, {
        status: "completed",
        outcomeNote: "Partner call happened; scope revised",
      });
      assertEq(status, 200, "complete status");
      assertEq(json.status, "completed", "status completed");
      assert(json.closedAt, "closedAt stamped");
      assertEq(json.closedByUserId, DIRECTOR_ID, "closedBy is the acting user");
      assertEq(json.outcomeNote, "Partner call happened; scope revised", "outcome note kept");
    });

    await step("reactivate clears closure stamps but keeps the outcome note", async () => {
      actingUserId = AM_ID;
      const { status, json } = await req("PATCH", `/api/clients/${C_COVERED}/save-plays/${playId}`, {
        status: "active",
      });
      assertEq(status, 200, "reactivate status");
      assertEq(json.status, "active", "status active again");
      assertEq(json.closedAt, null, "closedAt cleared");
      assertEq(json.closedByUserId, null, "closedBy cleared");
      assertEq(json.outcomeNote, "Partner call happened; scope revised", "note history preserved");
    });

    let abandonedPlayId = "";
    await step("abandon a second play (history row for the rollup)", async () => {
      actingUserId = AM_ID;
      const created = await req("POST", `/api/clients/${C_COVERED}/save-plays`, {
        title: `${RUN} discount offer`,
        assignedToUserId: AM_ID,
        dueDate: isoDaysFromNow(5),
      });
      assertEq(created.status, 201, "second create status");
      abandonedPlayId = created.json.id;
      const closed = await req("PATCH", `/api/clients/${C_COVERED}/save-plays/${abandonedPlayId}`, {
        status: "abandoned",
        outcomeNote: "Superseded by the partner call",
      });
      assertEq(closed.status, 200, "abandon status");
      assertEq(closed.json.status, "abandoned", "status abandoned");
      assert(closed.json.closedAt, "closedAt stamped on abandon");
    });

    await step("DELETE removes the play; subsequent GET 404s", async () => {
      actingUserId = AM_ID;
      const created = await req("POST", `/api/clients/${C_COVERED}/save-plays`, {
        title: `${RUN} throwaway`, assignedToUserId: AM_ID, dueDate: isoDaysFromNow(20),
      });
      assertEq(created.status, 201, "throwaway create");
      const del = await req("DELETE", `/api/clients/${C_COVERED}/save-plays/${created.json.id}`);
      assertEq(del.status, 200, "delete status");
      assertEq(del.json.ok, true, "delete ack");
      const gone = await req("GET", `/api/clients/${C_COVERED}/save-plays/${created.json.id}`);
      assertEq(gone.status, 404, "deleted play gone");
    });

    await step("per-client list orders active first and supports ?status=", async () => {
      actingUserId = AM_ID;
      const all = await req("GET", `/api/clients/${C_COVERED}/save-plays`);
      assertEq(all.status, 200, "list status");
      assertEq(all.json.length, 2, "two plays remain on covered client");
      assertEq(all.json[0].id, playId, "active play listed before closed history");
      assertEq(all.json[1].id, abandonedPlayId, "abandoned play second");
      const activeOnly = await req("GET", `/api/clients/${C_COVERED}/save-plays?status=active`);
      assertEq(activeOnly.json.length, 1, "status filter narrows to active");
      assertEq(activeOnly.json[0].id, playId, "active play id");
    });

    // ── 4. Rollup authz (strict director gate, both permissive modes) ─
    await step("rollup strict mode: core 403, lead 403, ghost 403, director 200", async () => {
      actingUserId = AM_ID;
      const denied = await req("GET", "/api/churn/save-plays");
      assertEq(denied.status, 403, "core authority");
      assert(String(denied.json.error).includes("Director"), "403 names the required level");
      actingUserId = LEAD_ID;
      assertEq((await req("GET", "/api/churn/save-plays")).status, 403, "lead authority");
      actingUserId = GHOST_ID;
      assertEq((await req("GET", "/api/churn/save-plays")).status, 403, "unapproved ghost (denied at admission)");
      actingUserId = DIRECTOR_ID;
      assertEq((await req("GET", "/api/churn/save-plays")).status, 200, "director authority");
    });

    await step("rollup permissive mode: core and lead STILL 403", async () => {
      await setPermissive("true");
      actingUserId = AM_ID;
      assertEq((await req("GET", "/api/churn/save-plays")).status, 403, "core in permissive mode");
      actingUserId = LEAD_ID;
      assertEq((await req("GET", "/api/churn/save-plays")).status, 403, "lead in permissive mode");
      actingUserId = DIRECTOR_ID;
      assertEq((await req("GET", "/api/churn/save-plays")).status, 200, "director in permissive mode");
    });

    // ── 5. Rollup content (as director) ──────────────────────────────
    actingUserId = DIRECTOR_ID;
    const { status: rollupStatus, json: rollup } = await req("GET", "/api/churn/save-plays");
    assertEq(rollupStatus, 200, "rollup status for director");

    await step("riskyClients: latest-judgment selection + archived/demo/healthy excluded", async () => {
      const ids = rollup.riskyClients.map((c: any) => c.clientId);
      assert(ids.includes(C_COVERED), "covered At Risk client present (latest row wins over old Healthy)");
      assert(ids.includes(C_UNCOVERED), "uncovered Critical client present");
      assert(!ids.includes(C_HEALTHY), "healthy client excluded");
      assert(!ids.includes(C_ARCHIVED), "archived client excluded");
      assert(!ids.includes(C_DEMO), "demo client excluded");
      assert(!ids.includes(C_OWNED), "never-judged client excluded");
    });

    await step("coverage: active play counts; completed plays do NOT cover", async () => {
      const covered = rollup.riskyClients.find((c: any) => c.clientId === C_COVERED);
      const uncovered = rollup.riskyClients.find((c: any) => c.clientId === C_UNCOVERED);
      assertEq(covered.status, "At Risk", "covered client latest status");
      assertEq(covered.hasActivePlay, true, "covered has an active play");
      assertEq(covered.activePlayCount, 1, "abandoned play not counted as coverage");
      assertEq(uncovered.status, "Critical", "uncovered client latest status");
      assertEq(uncovered.hasActivePlay, false, "completed play is not coverage");
      assertEq(uncovered.activePlayCount, 0, "uncovered active count");
      assert(typeof covered.ownerName === "string" && covered.ownerName.length > 0, "ownerName present");
    });

    await step("coverage ordering: uncovered risky clients come first", async () => {
      const iUncovered = rollup.riskyClients.findIndex((c: any) => c.clientId === C_UNCOVERED);
      const iCovered = rollup.riskyClients.findIndex((c: any) => c.clientId === C_COVERED);
      assert(iUncovered >= 0 && iCovered > iUncovered, "uncovered sorts before covered");
    });

    await step("plays list: names populated, demo excluded, archived kept + flagged", async () => {
      const byId = new Map(rollup.plays.map((p: any) => [p.id, p]));
      assert(byId.has(playId), "API-created active play listed");
      assert(byId.has(abandonedPlayId), "abandoned play kept as history");
      assert(byId.has(healthyPlayId), "healthy client's play listed even though not risky");
      assert(byId.has(archivedPlayId), "archived client's play kept for post-mortems");
      assert(byId.has(uncoveredPlayId), "completed play listed");
      assert(!byId.has(demoPlayId), "demo client's play excluded");
      const active: any = byId.get(playId);
      assertEq(active.firmName, `${RUN} Covered Firm`, "firm name joined");
      assertEq(active.assignedToName, "Task3696 Director", "assignee display name");
      assertEq(active.clientJudgmentStatus, "At Risk", "client's current judgment status");
      assertEq(active.sourceJudgmentId, judgmentCoveredId, "source judgment carried");
      const archived: any = byId.get(archivedPlayId);
      assertEq(archived.clientArchived, true, "archived flag set");
      const covered: any = byId.get(playId);
      assertEq(covered.clientArchived, false, "non-archived flag clear");
    });

    await step("overdue derivation: active+past-due only (server clock)", async () => {
      const byId = new Map(rollup.plays.map((p: any) => [p.id, p]));
      assertEq((byId.get(healthyPlayId) as any).overdue, true, "active play 3 days past due is overdue");
      assertEq((byId.get(archivedPlayId) as any).overdue, false, "active play due in 5 days is not overdue");
      assertEq((byId.get(uncoveredPlayId) as any).overdue, false, "COMPLETED play with past due date is not overdue");
      assertEq((byId.get(playId) as any).overdue, false, "future-due active play not overdue");
      assert(/^\d{4}-\d{2}-\d{2}$/.test(rollup.today), "today is the DB's YYYY-MM-DD date");
    });

    await step("plays ordering: overdue actives first, closed plays after actives", async () => {
      const runPlays = rollup.plays.filter((p: any) => String(p.title).startsWith(RUN));
      const firstClosedIdx = runPlays.findIndex((p: any) => p.status !== "active");
      const lastActiveIdx = runPlays.map((p: any) => p.status).lastIndexOf("active");
      assert(firstClosedIdx === -1 || firstClosedIdx > lastActiveIdx, "all actives precede closed plays");
      assertEq(runPlays[0].id, healthyPlayId, "overdue active sorts first");
    });
  } finally {
    server.close();
    // Restore the permissive switch exactly as found (missing row and
    // "false" behave identically — the helper defaults OFF).
    try {
      await storage.setSystemSetting(PERMISSIVE_KEY, originalPermissive?.value ?? "false", "system");
    } catch {}
    __resetPermissiveModeCacheForTests();
    await cleanup();
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll save-plays tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit(); a
// leaked handle surfaces as a hang instead of being masked by a forced exit.
let exitCode = 0;
main()
  .catch((err) => {
    console.error("save-plays: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
