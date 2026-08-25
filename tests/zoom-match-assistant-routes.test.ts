/* test-registration
{
  "name": "Zoom Match Assistant admin routes — auth gating, sweep start/status, workbench filters, assign + reanalyze (Task #4057)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4057: new account-manager-gated Zoom match-assistant endpoints. Locks the auth gate (401/403), the one-running-sweep 409 + stale-sweep supersede, workbench list filters/honest transcript statuses, and assignment reusing the manual-reassign audit stamping (incl. 'leave unattributed'). A drift could expose admin data or corrupt manual attribution stamps.",
  "tier": "small"
}
test-registration */
// calendar-fixture-gap-reviewed: make_interval seeding uses daysAgo-equivalent
// offsets of 10, 15, 20, 70, and 400 days. The ONLY pair fed into the YYYY-MM
// month-filter assertion is r1 (10d) vs r2 (70d) — a 60-day gap guaranteed to
// span different calendar months. The close fixtures (r4=15d same-month control,
// r5=400d ancient) are used for other filter assertions and never compared for
// month separation. Fixed in Task #4177; safe on any calendar date.
/**
 * Task #4057 — Zoom Transcript Match Assistant: admin API.
 *
 * Route contract under test (all under /api/admin/zoom/match-assistant,
 * isAuthenticated + requireAccountManager):
 *
 *   POST /sweep            — 202 {sweepId}; 409 while one is running;
 *                            stale running sweep (30+ min silent) is
 *                            superseded by the next start.
 *   GET  /sweep            — latest sweep + derived progress fields.
 *   GET  /calls            — year-window zoom calls with analysis joins;
 *                            filters: assigned=unassigned, month=YYYY-MM,
 *                            confidence=low; paging; honest transcript
 *                            statuses (unavailable reason, Rev AI state).
 *   POST /calls/:id/assign — reuses manual-reassign semantics: stamps
 *                            matchMethod='manual'/confidence 1.0, null
 *                            clientId = "leave unattributed" (all cleared);
 *                            400 bad clientId type, 404 unknown record/client.
 *   POST /calls/:id/reanalyze — 202 + pending row + force analyze job;
 *                            409 for transcript-less calls; 404 unknown.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";

import {
  clients,
  rawCommunicationRecords,
  zoomMatchSweeps,
  zoomTranscriptMatchAnalyses,
} from "@shared/schema";
import { db } from "../server/db";
import { registerAgentRoutes } from "../server/routes/agents";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const TAG = `zmar-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
const AM_ID = `__probe_zmar_am_${TAG}`;
const PLEB_ID = `__probe_zmar_user_${TAG}`;

let activeUserId: string | null = AM_ID;
let server: Server | null = null;
let baseUrl = "";

const clientIds: string[] = [];
const recordIds: string[] = [];
const sweepIds: string[] = [];

const rows = (r: any) => (Array.isArray(r) ? r : r.rows);

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function seed(): Promise<{
  c1: string;
  c2: string;
  r1: string;
  r2: string;
  r3: string;
  r4: string;
  r5: string;
}> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role)
    VALUES
      (${AM_ID}, ${`probe-zmar-am-${TAG}@example.invalid`}, 'Probe', 'MatchAM', 'account_manager'),
      (${PLEB_ID}, ${`probe-zmar-user-${TAG}@example.invalid`}, 'Probe', 'MatchUser', 'user')
  `);

  const c1 = rows(
    await db.execute(sql`INSERT INTO clients (firm_name) VALUES (${`ZMAR Guessed ${TAG}`}) RETURNING id`),
  )[0].id;
  const c2 = rows(
    await db.execute(sql`INSERT INTO clients (firm_name) VALUES (${`ZMAR Assigned ${TAG}`}) RETURNING id`),
  )[0].id;
  clientIds.push(c1, c2);

  const mkRecord = async (fields: {
    daysAgo: number;
    sourceType?: string;
    contentText?: string | null;
    transcriptStatus?: string | null;
    clientId?: string | null;
    matchMethod?: string | null;
    matchConfidence?: number | null;
    payload?: any;
  }): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO raw_communication_records
        (id, source_type, title, timestamp, content_text, transcript_status, client_id,
         match_method, match_confidence, google_drive_file_url, raw_payload_json)
      VALUES
        (${id}, ${fields.sourceType ?? "zoom"}, ${`ZMAR ${TAG} r${id.slice(0, 6)}`},
         NOW() - make_interval(days => ${fields.daysAgo}),
         ${fields.contentText ?? null}, ${fields.transcriptStatus ?? null},
         ${fields.clientId ?? null}, ${fields.matchMethod ?? null}, ${fields.matchConfidence ?? null},
         'https://drive.example.invalid/zmar', ${JSON.stringify(fields.payload ?? { duration: 45 })}::jsonb)
    `);
    recordIds.push(id);
    return id;
  };

  // r1: unassigned, transcript-bearing, analyzed guess c1 @ 0.4 (low).
  const r1 = await mkRecord({ daysAgo: 10, contentText: "Alice: hello", transcriptStatus: "ready" });
  await db.execute(sql`
    INSERT INTO zoom_transcript_match_analyses
      (record_id, status, guessed_client_id, confidence, rationale, call_summary,
       summary_source, names_json, model, attempts, analyzed_at)
    VALUES
      (${r1}, 'analyzed', ${c1}, 0.4, 'Weak name overlap', 'Talked about onboarding.',
       'generated', '["Zed Zeta","Amy Ames"]'::jsonb, 'stub', 1, NOW())
  `);
  // r2: already assigned manually.
  const r2 = await mkRecord({
    // 70 days keeps r2 ≥60 days from r1 (daysAgo: 10), so the two fixtures
    // ALWAYS land in different calendar months. At 40 days the pair collided
    // into the same YYYY-MM whenever "today" was in the first ~10 days of a
    // month, breaking the month-filter assertions on a calendar schedule.
    daysAgo: 70,
    contentText: "Bob: assigned call",
    transcriptStatus: "ready",
    clientId: c2,
    matchMethod: "manual",
    matchConfidence: 1.0,
  });
  // r3: no transcript, terminal unavailable with reason.
  const r3 = await mkRecord({
    daysAgo: 20,
    contentText: null,
    transcriptStatus: "unavailable",
    payload: { duration: 30, zoomTranscriptUnavailable: { reason: "no cloud recording file" } },
  });
  // r4: non-zoom — must never appear.
  const r4 = await mkRecord({ daysAgo: 15, sourceType: "front_email", contentText: "email body" });
  // r5: zoom but outside the 365-day window.
  const r5 = await mkRecord({ daysAgo: 400, contentText: "ancient call", transcriptStatus: "ready" });

  return { c1, c2, r1, r2, r3, r4, r5 };
}

async function cleanup(): Promise<void> {
  try {
    if (recordIds.length > 0) {
      await db
        .delete(zoomTranscriptMatchAnalyses)
        .where(inArray(zoomTranscriptMatchAnalyses.recordId, recordIds));
      // work_queue rows are filtered on a jsonb payload key — loop per ID
      // with scalar bindings. (Drizzle expands a JS array param into a
      // ($1,$2,…) tuple, so `unnest(${ids}::varchar[])` is a record-cast
      // error, not a list — hence inArray()/loops here, never array casts.)
      for (const id of recordIds) {
        await db.execute(sql`
          DELETE FROM work_queue
          WHERE queue_name = 'zoom_match_analyze' AND payload->>'recordId' = ${id}
        `);
      }
      await db
        .delete(rawCommunicationRecords)
        .where(inArray(rawCommunicationRecords.id, recordIds));
    }
    if (sweepIds.length > 0) {
      for (const id of sweepIds) {
        await db.execute(sql`
          DELETE FROM work_queue
          WHERE queue_name = 'zoom_match_sweep' AND payload->>'sweepId' = ${id}
        `);
      }
      await db.delete(zoomMatchSweeps).where(inArray(zoomMatchSweeps.id, sweepIds));
    }
    if (clientIds.length > 0) {
      await db.delete(clients).where(inArray(clients.id, clientIds));
    }
    await db.execute(sql`DELETE FROM users WHERE id IN (${AM_ID}, ${PLEB_ID})`);
  } catch (err) {
    // Leaked seed rows poison later runs against the same schema — a failed
    // cleanup is a test failure, not a logged shrug. cleanup() runs before
    // the summary line prints, so this lands in the exit code.
    failed++;
    console.error("  ✗ cleanup failed (seeded rows may be left behind):", err);
  }
}

async function main(): Promise<void> {
  const { c1, c2, r1, r2, r3, r4, r5 } = await seed();

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerAgentRoutes(app);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

  try {
    // ── Auth gating ──────────────────────────────────────────────────────
    console.log("A. Auth gating");
    const endpoints: Array<[string, string, unknown?]> = [
      ["GET", "/api/admin/zoom/match-assistant/sweep"],
      ["POST", "/api/admin/zoom/match-assistant/sweep", {}],
      ["GET", "/api/admin/zoom/match-assistant/calls"],
      ["POST", `/api/admin/zoom/match-assistant/calls/${r1}/assign`, { clientId: c2 }],
      ["POST", `/api/admin/zoom/match-assistant/calls/${r1}/reanalyze`, {}],
    ];
    activeUserId = null;
    for (const [method, path, body] of endpoints) {
      const res = await call(method, path, body);
      assert(res.status === 401, `${method} ${path.replace(/\/[0-9a-f-]{36}/g, "/:id")} → 401 unauthenticated`);
    }
    activeUserId = PLEB_ID;
    for (const [method, path, body] of endpoints) {
      const res = await call(method, path, body);
      assert(res.status === 403, `${method} ${path.replace(/\/[0-9a-f-]{36}/g, "/:id")} → 403 for role=user`);
    }
    activeUserId = AM_ID;

    // ── Sweep start / single-flight / stale supersede ────────────────────
    console.log("B. Sweep start");
    const start1 = await call("POST", "/api/admin/zoom/match-assistant/sweep", {});
    assert(start1.status === 202 && typeof start1.body?.sweepId === "string", "start → 202 + sweepId");
    const sweep1 = start1.body.sweepId as string;
    sweepIds.push(sweep1);

    const jobRow = rows(
      await db.execute(sql`
        SELECT id FROM work_queue
        WHERE dedupe_key = ${`zoom_match_sweep:${sweep1}:start`}
      `),
    )[0];
    assert(!!jobRow, "durable zoom_match_sweep job enqueued with the start dedupe key");

    const start2 = await call("POST", "/api/admin/zoom/match-assistant/sweep", {});
    assert(start2.status === 409, "second start while running → 409");
    assert(start2.body?.reason === "already_running", "409 carries reason=already_running");

    // Stale supersede: backdate updated_at past the stall threshold.
    await db.execute(sql`
      UPDATE zoom_match_sweeps SET updated_at = NOW() - interval '40 minutes' WHERE id = ${sweep1}
    `);
    const start3 = await call("POST", "/api/admin/zoom/match-assistant/sweep", {});
    assert(start3.status === 202, "start after 30+ min stall → 202 (stalled sweep superseded)");
    const sweep2 = start3.body.sweepId as string;
    sweepIds.push(sweep2);
    const oldSweep = rows(
      await db.execute(sql`SELECT status, last_error FROM zoom_match_sweeps WHERE id = ${sweep1}`),
    )[0];
    assert(oldSweep.status === "failed", "stalled sweep marked failed");
    assert(String(oldSweep.last_error).includes("Superseded"), "stalled sweep lastError says superseded");

    const status = await call("GET", "/api/admin/zoom/match-assistant/sweep");
    assert(status.status === 200 && status.body?.sweep?.id === sweep2, "GET sweep returns the latest sweep");
    assert(status.body.sweep.status === "running", "latest sweep is running");
    assert(status.body.sweep.windowsTotal >= 13, `year sweep has ≥13 windows (got ${status.body.sweep.windowsTotal})`);
    assert(status.body.sweep.windowsDone === 0, "no windows walked yet (no worker in this test)");
    assert(typeof status.body.sweep.analysesPending === "number", "derived analysesPending present");

    // ── Status-poll self-heal wiring (semantics pinned in zoom-match-sweep.test.ts §G) ──
    // Kill the live continuation job and backdate activity: the next GET
    // must detect the dead chain and enqueue a REAL durable resume job via
    // the route's default deps.
    await db.execute(sql`
      DELETE FROM work_queue
      WHERE queue_name = 'zoom_match_sweep' AND payload->>'sweepId' = ${sweep2}
    `);
    await db.execute(sql`
      UPDATE zoom_match_sweeps SET updated_at = NOW() - interval '3 minutes' WHERE id = ${sweep2}
    `);
    const healed = await call("GET", "/api/admin/zoom/match-assistant/sweep");
    assert(
      healed.status === 200 &&
        healed.body?.sweep?.resumed === true &&
        healed.body.sweep.resumeCount === 1,
      "GET on a silent running sweep with no live job auto-resumes it",
    );
    const resumeRow = rows(
      await db.execute(sql`
        SELECT id FROM work_queue
        WHERE dedupe_key = ${`zoom_match_sweep:${sweep2}:resume:1`} AND status = 'pending'
      `),
    )[0];
    assert(!!resumeRow, "recovery enqueued a real durable continuation job (resume:1)");

    // Park the running sweep so later asserts don't depend on it.
    await db.execute(sql`
      UPDATE zoom_match_sweeps SET status = 'failed', last_error = 'test parked', finished_at = NOW()
      WHERE id = ${sweep2}
    `);

    // ── Workbench list + filters ─────────────────────────────────────────
    console.log("C. Workbench list");
    const mine = (body: any) => {
      const byId = new Map<string, any>();
      for (const c of body?.calls ?? []) byId.set(c.id, c);
      return byId;
    };

    const all = await call("GET", "/api/admin/zoom/match-assistant/calls?assigned=all&limit=100");
    assert(all.status === 200, "GET calls → 200");
    const allMap = mine(all.body);
    assert(allMap.has(r1) && allMap.has(r2) && allMap.has(r3), "year-window zoom fixtures all listed");
    assert(!allMap.has(r4), "non-zoom record excluded");
    assert(!allMap.has(r5), "record older than 365 days excluded");

    const c1Row = allMap.get(r1);
    assert(c1Row.hasTranscript === true, "r1 hasTranscript=true");
    assert(c1Row.analysis?.status === "analyzed", "r1 carries its analysis");
    assert(c1Row.analysis.guessedClientId === c1, "r1 guess id present");
    assert(String(c1Row.analysis.guessedClientName).includes("ZMAR Guessed"), "guess joined to client name");
    assert(Math.abs(Number(c1Row.analysis.confidence) - 0.4) < 1e-6, "guess confidence present");
    assert(c1Row.analysis.rationale === "Weak name overlap", "rationale present");
    assert(c1Row.analysis.summary === "Talked about onboarding.", "call summary present");
    assert(
      Array.isArray(c1Row.analysis.names) && c1Row.analysis.names.includes("Zed Zeta"),
      "names involved present",
    );
    assert(c1Row.durationMin === 45, "duration extracted from raw payload");

    const r2Row = allMap.get(r2);
    assert(r2Row.clientId === c2 && String(r2Row.clientName).includes("ZMAR Assigned"), "assigned row carries current client");
    assert(r2Row.analysis === null, "un-analyzed row has null analysis");

    const r3Row = allMap.get(r3);
    assert(r3Row.hasTranscript === false, "unavailable row hasTranscript=false");
    assert(r3Row.transcriptStatus === "unavailable", "honest terminal transcript status");
    assert(
      r3Row.transcriptUnavailableReason === "no cloud recording file",
      "unavailable reason surfaced from raw payload",
    );
    assert(r3Row.durationMin === 30, "r3 duration extracted");

    const unassigned = await call(
      "GET",
      "/api/admin/zoom/match-assistant/calls?assigned=unassigned&limit=100",
    );
    const unMap = mine(unassigned.body);
    assert(unMap.has(r1) && unMap.has(r3), "unassigned filter keeps unassigned fixtures");
    assert(!unMap.has(r2), "unassigned filter drops the assigned fixture");

    const r2Month = rows(
      await db.execute(sql`
        SELECT to_char(timestamp, 'YYYY-MM') AS m FROM raw_communication_records WHERE id = ${r2}
      `),
    )[0].m;
    const monthRes = await call(
      "GET",
      `/api/admin/zoom/match-assistant/calls?assigned=all&month=${r2Month}&limit=100`,
    );
    const monthMap = mine(monthRes.body);
    assert(monthMap.has(r2), "month filter keeps the fixture in that month");
    assert(!monthMap.has(r1), "month filter drops fixtures from other months");

    const lowConf = await call(
      "GET",
      "/api/admin/zoom/match-assistant/calls?assigned=all&confidence=low&limit=100",
    );
    const lowMap = mine(lowConf.body);
    assert(lowMap.has(r1), "low-confidence filter keeps the 0.4 guess");
    assert(!lowMap.has(r2) && !lowMap.has(r3), "low-confidence filter drops un-analyzed rows");

    const page1 = await call("GET", "/api/admin/zoom/match-assistant/calls?assigned=all&limit=1&page=1");
    const page2 = await call("GET", "/api/admin/zoom/match-assistant/calls?assigned=all&limit=1&page=2");
    assert(page1.body.calls.length === 1 && page2.body.calls.length === 1, "limit=1 pages return one row each");
    assert(page1.body.calls[0].id !== page2.body.calls[0].id, "page 2 returns a different row");
    assert(page1.body.total >= 3 && page1.body.total === page2.body.total, "total consistent across pages");

    // ── Assign (manual-reassign semantics + unattributed) ────────────────
    console.log("D. Assign");
    const assign = await call("POST", `/api/admin/zoom/match-assistant/calls/${r1}/assign`, {
      clientId: c2,
    });
    assert(assign.status === 200 && assign.body?.success === true, "assign → 200 success");
    let r1Db = rows(
      await db.execute(sql`
        SELECT client_id, match_method, match_confidence FROM raw_communication_records WHERE id = ${r1}
      `),
    )[0];
    assert(r1Db.client_id === c2, "assignment persisted");
    assert(r1Db.match_method === "manual", "matchMethod stamped 'manual' (same audit stamp as existing reassign)");
    assert(Number(r1Db.match_confidence) === 1, "matchConfidence stamped 1.0");

    const unassign = await call("POST", `/api/admin/zoom/match-assistant/calls/${r1}/assign`, {
      clientId: null,
    });
    assert(unassign.status === 200, "leave-unattributed → 200");
    r1Db = rows(
      await db.execute(sql`
        SELECT client_id, match_method, match_confidence FROM raw_communication_records WHERE id = ${r1}
      `),
    )[0];
    assert(
      r1Db.client_id === null && r1Db.match_method === null && r1Db.match_confidence === null,
      "unattributed clears clientId + match stamps",
    );

    const badType = await call("POST", `/api/admin/zoom/match-assistant/calls/${r1}/assign`, {
      clientId: 123,
    });
    assert(badType.status === 400, "non-string clientId → 400");
    const noRecord = await call(
      "POST",
      `/api/admin/zoom/match-assistant/calls/${randomUUID()}/assign`,
      { clientId: c2 },
    );
    assert(noRecord.status === 404, "unknown record → 404");
    const noClient = await call("POST", `/api/admin/zoom/match-assistant/calls/${r1}/assign`, {
      clientId: randomUUID(),
    });
    assert(noClient.status === 404, "unknown client → 404");
    const nonZoom = await call("POST", `/api/admin/zoom/match-assistant/calls/${r4}/assign`, {
      clientId: c2,
    });
    assert(nonZoom.status === 404, "non-zoom record → 404 (tool only reassigns zoom calls)");

    // ── Reanalyze ────────────────────────────────────────────────────────
    console.log("E. Reanalyze");
    const re = await call("POST", `/api/admin/zoom/match-assistant/calls/${r1}/reanalyze`, {});
    assert(re.status === 202 && re.body?.queued === true, "reanalyze → 202 queued");
    const pendingRow = rows(
      await db.execute(sql`
        SELECT status FROM zoom_transcript_match_analyses WHERE record_id = ${r1}
      `),
    )[0];
    assert(pendingRow.status === "pending", "analysis row flipped to pending immediately");
    const forceJob = rows(
      await db.execute(sql`
        SELECT dedupe_key, payload FROM work_queue
        WHERE queue_name = 'zoom_match_analyze' AND payload->>'recordId' = ${r1}
        ORDER BY created_at DESC LIMIT 1
      `),
    )[0];
    assert(!!forceJob, "force analyze job enqueued");
    assert(String(forceJob.dedupe_key).startsWith(`zoom_match_analyze:force:${r1}:`), "force job uses the timestamped force dedupe key");
    assert(forceJob.payload?.force === true, "force flag carried in the job payload");

    const reNoTranscript = await call("POST", `/api/admin/zoom/match-assistant/calls/${r3}/reanalyze`, {});
    assert(reNoTranscript.status === 409, "reanalyze without a transcript → 409");
    const reMissing = await call(
      "POST",
      `/api/admin/zoom/match-assistant/calls/${randomUUID()}/reanalyze`,
      {},
    );
    assert(reMissing.status === 404, "reanalyze unknown record → 404");
  } finally {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    await cleanup();
  }

  console.log(`\nTest run: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("Test crashed:", err);
    try {
      await cleanup();
    } catch {}
    process.exit(1);
  });
