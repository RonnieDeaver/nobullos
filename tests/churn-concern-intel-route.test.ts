/* test-registration
{
  "name": "Churn concern-intel API — director gate, zod write boundary, leaderboard embed round-trip, KB mirror (Task #4292)",
  "regression": true,
  "sweepOnlyReason": "DB-backed route suite: real Express mount + seeded clients/judgments/intel with cascade cleanup and a permissive-mode pin — solid regression coverage but not smoke-gate material; the smoke gate carries the pure calibration suite instead.",
  "tier": "small"
}
test-registration */
/**
 * Task #4292 — operator concern-intel API coverage.
 *
 * Pins the contract of POST /api/churn/concern-intel and the leaderboard's
 * intel embed end-to-end through a real Express app (real
 * registerChurnRoutes behind an injected passport-shaped session — the
 * tests/churn-leaderboard.test.ts harness):
 *
 *   1. Authz — the POST rides the same STRICT director gate as the rest of
 *      the churn surface: core gets 403 with permissive mode pinned OFF
 *      *and* pinned ON (permissive mode elevates core only to lead, never
 *      director); an unauthenticated request gets 401; director gets 201.
 *   2. Write boundary — the body is parsed by a focused zod schema:
 *      unknown keys are rejected (.strict()), a missing/empty note is
 *      rejected, a bad intelType is rejected, and createdBy in the body is
 *      rejected outright (attribution comes from the session, never the
 *      client). Malformed bodies get 400 with zod issues, not 500.
 *   3. 404 — a well-formed body naming a nonexistent client is a 404, not
 *      an FK 500.
 *   4. Round-trip — a saved "resolved" note on a concern whose text matches
 *      a displayed keyRisk only after normalization (case + punctuation
 *      differences) comes back in GET /api/churn/leaderboard as a
 *      concernIntel entry with matchedConcern = the EXACT displayed string,
 *      attributed to the director's display name; a second note whose
 *      concern text matches nothing comes back with matchedConcern = null
 *      (the UI's unmatched intel log). createdBy is the session user even
 *      though the body never sent it.
 *   5. KB mirror — the 201 path synchronously mirrors the note into
 *      agent_knowledge_base under fact_category 'operator_intel' with
 *      source_agent 'manual' and source_record_id = the intel row id, so
 *      the radar sweep and agent chat see human-addressed concerns.
 *
 * Seeding uses per-run random suffixes; cleanup deletes clients (cascades
 * client_daily_judgments, client_concern_intel, agent_knowledge_base) then
 * users, and restores the permissive-mode switch exactly as found.
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

const RUN = `t4292-${randomBytes(4).toString("hex")}`;

const DIRECTOR_ID = `${RUN}-director`;
const CORE_ID = `${RUN}-core`;
const OWNER_ID = `${RUN}-owner`;

const C_ACTIVE = `${RUN}-client`;
const JUDGMENT_ID = `${RUN}-judgment`;

// Displayed concern (keyRisks) vs the operator's filed text: same words,
// different case + punctuation — must match via normalization only.
const DISPLAYED_CONCERN = "Three emails unanswered for over a week";
const FILED_CONCERN = "  three EMAILS unanswered, for over a week!! ";
const UNMATCHED_CONCERN = "Old concern from a superseded judgment";

const PERMISSIVE_KEY = "role_permissions_permissive_mode";

let failures = 0;

function check(name: string, cond: unknown, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${DIRECTOR_ID}, ${`${DIRECTOR_ID}@t4292.example`}, 'Task4292', 'Director', 'account_manager', 'director'),
      (${CORE_ID}, ${`${CORE_ID}@t4292.example`}, 'Task4292', 'Core', 'account_manager', 'core'),
      (${OWNER_ID}, ${`${OWNER_ID}@t4292.example`}, 'Task4292', 'Owner', 'ceo', 'ceo')
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES (${C_ACTIVE}, ${`${RUN} Intel Firm`}, ${OWNER_ID}, false, false)
  `);
  await db.execute(sql`
    INSERT INTO client_daily_judgments (id, client_id, judgment_date, status, headline, risk_score, key_risks)
    VALUES (${JUDGMENT_ID}, ${C_ACTIVE}, '2026-08-09', 'At Risk', ${"Unanswered emails piling up"}, 55,
            ${JSON.stringify([DISPLAYED_CONCERN, "Lead volume dropped sharply"])}::jsonb)
  `);
}

async function cleanup(): Promise<void> {
  // Client delete cascades client_daily_judgments, client_concern_intel and
  // agent_knowledge_base (all FK ON DELETE CASCADE on client_id).
  try {
    await db.execute(sql`DELETE FROM clients WHERE id = ${C_ACTIVE}`);
  } catch {}
  try {
    await db.execute(sql`
      DELETE FROM users WHERE id IN (${DIRECTOR_ID}, ${CORE_ID}, ${OWNER_ID})
    `);
  } catch {}
}

// Clerk test seam (server/middlewares/requireAuth.ts); actingUserId === null
// models an unauthenticated request (null → 401 from requireAuth). Users are
// seeded into the committed public schema below, so no registry is needed —
// requireAuth resolves the real users row (real role gating).
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

async function postIntel(
  baseUrl: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}/api/churn/concern-intel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

async function getLeaderboard(baseUrl: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}/api/churn/leaderboard`, { method: "GET" });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

async function main(): Promise<void> {
  const originalPermissive = await storage.getSystemSetting(PERMISSIVE_KEY);
  await seed();
  const { server, baseUrl } = await listen(buildApp());

  try {
    const validBody = {
      clientId: C_ACTIVE,
      judgmentId: JUDGMENT_ID,
      concernText: FILED_CONCERN,
      intelType: "resolved",
      note: "Called the client Tuesday — campaign approved, they're satisfied.",
    };

    // ── 1. Authz ──────────────────────────────────────────────────────────
    console.log("\nAuthz:");

    actingUserId = null;
    check("unauthenticated POST → 401", (await postIntel(baseUrl, validBody)).status === 401);

    await storage.setSystemSetting(PERMISSIVE_KEY, "false", "test");
    __resetPermissiveModeCacheForTests();
    actingUserId = CORE_ID;
    check("core POST → 403 (permissive OFF)", (await postIntel(baseUrl, validBody)).status === 403);

    await storage.setSystemSetting(PERMISSIVE_KEY, "true", "test");
    __resetPermissiveModeCacheForTests();
    check("core POST → 403 (permissive ON — no bypass)", (await postIntel(baseUrl, validBody)).status === 403);

    await storage.setSystemSetting(PERMISSIVE_KEY, "false", "test");
    __resetPermissiveModeCacheForTests();

    // ── 2. Write boundary (zod) ───────────────────────────────────────────
    console.log("\nWrite boundary:");
    actingUserId = DIRECTOR_ID;

    const unknownKey = await postIntel(baseUrl, { ...validBody, rogueField: "x" });
    check("unknown key → 400 with issues", unknownKey.status === 400 && Array.isArray(unknownKey.json.error), unknownKey);

    const missingNote = await postIntel(baseUrl, { ...validBody, note: "" });
    check("empty note → 400", missingNote.status === 400, missingNote);

    const badType = await postIntel(baseUrl, { ...validBody, intelType: "escalated" });
    check("bad intelType → 400", badType.status === 400, badType);

    const bodyCreatedBy = await postIntel(baseUrl, { ...validBody, createdBy: CORE_ID });
    check("createdBy in body → 400 (attribution is session-only)", bodyCreatedBy.status === 400, bodyCreatedBy);

    const longConcern = await postIntel(baseUrl, { ...validBody, concernText: "x".repeat(501) });
    check("over-long concernText → 400", longConcern.status === 400, longConcern);

    // ── 3. Unknown client ─────────────────────────────────────────────────
    const ghostClient = await postIntel(baseUrl, { ...validBody, clientId: `${RUN}-ghost` });
    check("unknown client → 404", ghostClient.status === 404, ghostClient);

    // ── 4. Happy path + round-trip ────────────────────────────────────────
    console.log("\nRound-trip:");

    const created = await postIntel(baseUrl, validBody);
    check("director POST → 201 with intel row", created.status === 201 && typeof created.json?.intel?.id === "string", created);
    check("createdBy stamped from session", created.json?.intel?.createdBy === DIRECTOR_ID, created.json?.intel);
    const intelId = created.json?.intel?.id as string;

    const unmatched = await postIntel(baseUrl, {
      clientId: C_ACTIVE,
      concernText: UNMATCHED_CONCERN,
      intelType: "context",
      note: "Client paused ads during their office move; expected through September.",
    });
    check("second (unmatched, no judgmentId) POST → 201", unmatched.status === 201, unmatched);

    const lb = await getLeaderboard(baseUrl);
    check("leaderboard → 200", lb.status === 200, lb.status);
    const entry = (lb.json?.clients ?? []).find((c: any) => c.clientId === C_ACTIVE);
    check("client entry present with concernIntel array", Array.isArray(entry?.concernIntel), entry?.concernIntel);
    check("judgment carries its row id for new intel", entry?.judgment?.judgmentId === JUDGMENT_ID, entry?.judgment?.judgmentId);

    const matchedEntry = (entry?.concernIntel ?? []).find((e: any) => e.id === intelId);
    check(
      "filed note matches the displayed concern via normalization",
      matchedEntry?.matchedConcern === DISPLAYED_CONCERN,
      matchedEntry,
    );
    check("matched entry keeps type/note/attribution", 
      matchedEntry?.intelType === "resolved" &&
        typeof matchedEntry?.note === "string" &&
        matchedEntry?.createdByName === "Task4292 Director",
      matchedEntry,
    );

    const unmatchedEntry = (entry?.concernIntel ?? []).find((e: any) => e.concernText === UNMATCHED_CONCERN);
    check("unmatched note comes back with matchedConcern = null", unmatchedEntry != null && unmatchedEntry.matchedConcern === null, unmatchedEntry);

    // ── 5. KB mirror ──────────────────────────────────────────────────────
    console.log("\nKnowledge-base mirror:");

    const kbRows = await db.execute(sql`
      SELECT fact_category, source_agent, source_record_id, fact_text, is_active
      FROM agent_knowledge_base
      WHERE client_id = ${C_ACTIVE} AND source_record_id = ${intelId}
    `);
    const kb = (kbRows.rows ?? [])[0] as any;
    check("mirror row exists under operator_intel/manual", 
      kb?.fact_category === "operator_intel" && kb?.source_agent === "manual" && kb?.is_active === true,
      kb,
    );
    check("mirror text carries the resolution note", 
      typeof kb?.fact_text === "string" && kb.fact_text.includes("campaign approved"),
      kb?.fact_text,
    );
  } finally {
    server.close();
    try {
      await storage.setSystemSetting(PERMISSIVE_KEY, originalPermissive?.value ?? "false", "test");
    } catch {}
    __resetPermissiveModeCacheForTests();
    await cleanup();
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll churn-concern-intel tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
let exitCode = 0;
main()
  .catch((err) => {
    console.error("churn-concern-intel: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
