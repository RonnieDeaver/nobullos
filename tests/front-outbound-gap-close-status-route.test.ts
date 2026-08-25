/* test-registration
{
  "name": "Front outbound gap-close status route + last-run persistence (Task #2026)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2026 — Cover the outbound gap-close status readout with an
 * automated test.
 *
 * Two surfaces are pinned here, both shipped by Task #2021 / #1984:
 *
 *   1. server/services/frontOutboundGapCloser.ts
 *        - runOutboundGapCloseTick persists its summary to the
 *          `front_outbound_gap_close_last_run` system_settings key.
 *        - getLastOutboundGapCloseRun round-trips that persisted JSON
 *          back into the OutboundGapCloseTickResult shape.
 *      We exercise the deterministic disabled path (SETTING_ENABLED is
 *      not "true") so the tick is a guaranteed no-op — it never spawns
 *      real Front Historical Recovery jobs — yet still persists a full
 *      summary.
 *
 *   2. server/routes/integrations.ts
 *        GET /api/admin/front/analytics-coverage/outbound-gap-status
 *        (isAuthenticated + requireTeamLead)
 *      Returns:
 *        - config: { enabled, materializationEnabled, materializationSwitch,
 *                    paused, maxMonthsPerTick }
 *        - lastRun: the persisted summary (or null)
 *        - gapMonths: worst-gap-first rows from
 *          front_analytics_monthly_coverage where messages_outbound_gap > 0
 *
 * The route never runs a tick (it is a pure read), so it is safe to flip
 * SETTING_ENABLED on for the config assertion without triggering recovery.
 *
 * Task #2082 — also pins the never-run / corrupt last-run path: when
 * nothing has run yet (SETTING_LAST_RUN absent) or the persisted value is
 * unparseable, getLastOutboundGapCloseRun returns null and the route must
 * still respond 200 with `lastRun: null` (plus a well-formed config) rather
 * than 500, so admins never see a blank or broken status panel.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
import {
  getSystemSetting,
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import {
  runOutboundGapCloseTick,
  getLastOutboundGapCloseRun,
  readLastOutboundGapCloseRun,
  SETTING_LAST_RUN,
  SETTING_ENABLED,
  SETTING_MAX_MONTHS_PER_TICK,
} from "../server/services/frontOutboundGapCloser";

const TAG = "task-2026";
const TL_ID = `${TAG}-tl`;
const AM_ID = `${TAG}-am`;

// Far-future test months so they never collide with real coverage rows.
const MONTH_BIG = "2099-03"; // largest gap
const MONTH_MID = "2099-02"; // middle gap
const MONTH_ZERO = "2099-01"; // gap = 0, must be excluded
const TEST_MONTHS = [MONTH_BIG, MONTH_MID, MONTH_ZERO];

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function ensureUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${TL_ID}, 'team_lead', ${"Task2026 TL"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task2026 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUsers(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id IN (${TL_ID}, ${AM_ID})`);
  } catch {}
}

async function deleteTestCoverageRows(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage
    WHERE month IN (${MONTH_BIG}, ${MONTH_MID}, ${MONTH_ZERO})
  `);
}

async function insertCoverageRow(
  month: string,
  outboundFront: number,
  outboundLocal: number,
  outboundGap: number,
): Promise<void> {
  const monthStart = `${month}-01T00:00:00.000Z`;
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const monthEnd = `${next}-01T00:00:00.000Z`;
  await db.execute(sql`
    INSERT INTO front_analytics_monthly_coverage
      (month, month_start, month_end,
       messages_outbound_front, messages_outbound_local, messages_outbound_gap)
    VALUES
      (${month}, ${monthStart}, ${monthEnd},
       ${outboundFront}, ${outboundLocal}, ${outboundGap})
    ON CONFLICT (month) DO UPDATE SET
      month_start = EXCLUDED.month_start,
      month_end = EXCLUDED.month_end,
      messages_outbound_front = EXCLUDED.messages_outbound_front,
      messages_outbound_local = EXCLUDED.messages_outbound_local,
      messages_outbound_gap = EXCLUDED.messages_outbound_gap
  `);
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const actor = String(req.headers["x-test-actor"] ?? "");
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; empty header (null) is
    // explicit-unauthenticated → 401. (The pre-Clerk passport-shape
    // injection stopped working when auth migrated.)
    (req as any).__test_clerkUserId = actor || null;
    next();
  });
  registerIntegrationRoutes(app);
  return app;
}

async function listen(
  app: express.Express,
): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function getStatus(
  baseUrl: string,
  actor: string | null,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (actor) headers["x-test-actor"] = actor;
  const r = await fetch(
    `${baseUrl}/api/admin/front/analytics-coverage/outbound-gap-status`,
    { method: "GET", headers },
  );
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  await ensureUsers();

  // Snapshot settings we mutate so the run is hermetic.
  const savedEnabled = (await getSystemSetting(SETTING_ENABLED))?.value ?? null;
  const savedMax =
    (await getSystemSetting(SETTING_MAX_MONTHS_PER_TICK))?.value ?? null;
  const savedLastRun = (await getSystemSetting(SETTING_LAST_RUN))?.value ?? null;

  await deleteTestCoverageRows();

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // ── 1. Tick persists a summary; getLastOutboundGapCloseRun round-trips ──
    // Force the deterministic disabled no-op path so the tick never spawns
    // recovery work, but still persists a complete summary.
    await setSystemSetting(SETTING_ENABLED, "false", "test");

    const before = new Date();
    const tick = await runOutboundGapCloseTick();
    const after = new Date();

    assertEq(tick.enabled, false, "disabled tick reports enabled=false");
    assert.ok(
      typeof tick.ranAt === "string" && !Number.isNaN(Date.parse(tick.ranAt)),
      `tick.ranAt should be an ISO string (got ${JSON.stringify(tick.ranAt)})`,
    );
    assert.ok(
      typeof tick.reason === "string" && tick.reason.length > 0,
      "disabled tick records a reason",
    );

    // The raw system_settings value must be the JSON-serialized summary.
    const rawRow = await getSystemSetting(SETTING_LAST_RUN);
    assert.ok(rawRow?.value, "tick persisted a value under SETTING_LAST_RUN");
    const reparsed = JSON.parse(rawRow!.value);
    assertEq(reparsed.ranAt, tick.ranAt, "persisted ranAt matches tick");

    // getLastOutboundGapCloseRun round-trips that persisted JSON.
    const roundTripped = await getLastOutboundGapCloseRun();
    assert.ok(roundTripped, "getLastOutboundGapCloseRun returns the summary");
    assertEq(
      roundTripped!.ranAt,
      tick.ranAt,
      "round-tripped ranAt matches the tick",
    );
    assertEq(
      roundTripped!.enabled,
      false,
      "round-tripped enabled flag preserved",
    );
    assertEq(
      roundTripped!.reason,
      tick.reason,
      "round-tripped reason preserved",
    );
    assertEq(
      Array.isArray(roundTripped!.attempted),
      true,
      "round-tripped attempted is an array",
    );
    // ranAt was stamped during the tick window.
    const ranAtMs = Date.parse(roundTripped!.ranAt);
    assert.ok(
      ranAtMs >= before.getTime() - 1000 && ranAtMs <= after.getTime() + 1000,
      "ranAt falls within the tick execution window",
    );

    // ── 2. Status route auth gating ───────────────────────────────────
    const anon = await getStatus(baseUrl, null);
    assertEq(anon.status, 401, `anon should 401 (got ${anon.status})`);

    const am = await getStatus(baseUrl, AM_ID);
    assertEq(am.status, 403, `account_manager should 403 (got ${am.status})`);

    // ── 3. Status route happy path: config + lastRun + worst-first gapMonths ──
    // Flip the readout config on (route is a pure read — no tick runs).
    await setSystemSetting(SETTING_ENABLED, "true", "test");
    await setSystemSetting(SETTING_MAX_MONTHS_PER_TICK, "5", "test");

    // Insert gap fixtures: BIG(120) > MID(40) > ZERO(0, excluded).
    await insertCoverageRow(MONTH_BIG, 200, 80, 120);
    await insertCoverageRow(MONTH_MID, 100, 60, 40);
    await insertCoverageRow(MONTH_ZERO, 50, 50, 0);

    const ok = await getStatus(baseUrl, TL_ID);
    assertEq(ok.status, 200, `team_lead should 200 (got ${ok.status} ${JSON.stringify(ok.body)})`);

    // config shape + values.
    const cfg = ok.body?.config;
    assert.ok(cfg && typeof cfg === "object", "response has a config object");
    assertEq(cfg.enabled, true, "config.enabled reflects SETTING_ENABLED='true'");
    assertEq(cfg.maxMonthsPerTick, 5, "config.maxMonthsPerTick reflects the setting");
    assertEq(
      typeof cfg.materializationEnabled,
      "boolean",
      "config.materializationEnabled is a boolean",
    );
    assert.ok(
      typeof cfg.materializationSwitch === "string" &&
        cfg.materializationSwitch.length > 0,
      "config.materializationSwitch names the required switch",
    );
    assertEq(typeof cfg.paused, "boolean", "config.paused is a boolean");

    // lastRun mirrors the persisted summary from step 1.
    assert.ok(ok.body?.lastRun, "response includes the persisted lastRun");
    assertEq(
      ok.body.lastRun.ranAt,
      tick.ranAt,
      "route lastRun.ranAt matches the persisted tick",
    );
    assertEq(
      ok.body.lastRun.enabled,
      false,
      "route lastRun preserves the disabled-run snapshot",
    );

    // gapMonths: worst-first ordering, ZERO excluded, values mapped.
    const gapMonths: any[] = Array.isArray(ok.body?.gapMonths)
      ? ok.body.gapMonths
      : [];
    const idxBig = gapMonths.findIndex((g) => g.month === MONTH_BIG);
    const idxMid = gapMonths.findIndex((g) => g.month === MONTH_MID);
    const idxZero = gapMonths.findIndex((g) => g.month === MONTH_ZERO);

    assert.ok(idxBig >= 0, "gapMonths includes the BIG-gap month");
    assert.ok(idxMid >= 0, "gapMonths includes the MID-gap month");
    assertEq(idxZero, -1, "gapMonths excludes the zero-gap month");
    assert.ok(
      idxBig < idxMid,
      `worst-gap-first: BIG (idx ${idxBig}) must precede MID (idx ${idxMid})`,
    );

    const big = gapMonths[idxBig];
    assertEq(big.messagesOutboundFront, 200, "BIG month front count mapped");
    assertEq(big.messagesOutboundLocal, 80, "BIG month local count mapped");
    assertEq(big.messagesOutboundGap, 120, "BIG month gap mapped");

    // ── 4. Never-run: SETTING_LAST_RUN absent → lastRun is null, no 500 ──
    // (Task #2082) The closer may never have run on a fresh deploy. The
    // route must still serve a well-formed status panel with lastRun: null
    // rather than failing or hiding the rest of the readout.
    await deleteSystemSetting(SETTING_LAST_RUN);
    assertEq(
      await getLastOutboundGapCloseRun(),
      null,
      "getLastOutboundGapCloseRun returns null when nothing has run",
    );

    const neverRun = await getStatus(baseUrl, TL_ID);
    assertEq(
      neverRun.status,
      200,
      `never-run status must be 200, not 500 (got ${neverRun.status} ${JSON.stringify(neverRun.body)})`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(neverRun.body ?? {}, "lastRun"),
      "never-run response still includes a lastRun key",
    );
    assertEq(
      neverRun.body.lastRun,
      null,
      "never-run response surfaces lastRun: null",
    );
    // Task #2130 — the never-run state is explicitly classified so admins
    // never confuse "fresh deploy" with "corrupt persisted value".
    assertEq(
      neverRun.body.lastRunStatus,
      "never_run",
      "never-run response classifies lastRunStatus as never_run",
    );
    assertEq(
      Object.prototype.hasOwnProperty.call(neverRun.body ?? {}, "lastRunError"),
      false,
      "never-run response carries no lastRunError",
    );
    {
      const read = await readLastOutboundGapCloseRun();
      assertEq(read.status, "never_run", "reader classifies never_run");
      assertEq(read.lastRun, null, "reader returns null lastRun for never_run");
    }
    assert.ok(
      neverRun.body?.config && typeof neverRun.body.config === "object",
      "never-run response still includes the config block",
    );
    assertEq(
      typeof neverRun.body.config.maxMonthsPerTick,
      "number",
      "never-run config still reports maxMonthsPerTick",
    );
    assert.ok(
      Array.isArray(neverRun.body?.gapMonths),
      "never-run response still includes the gapMonths list",
    );

    // ── 5. Corrupt last-run value → lastRun is null, no 500 ──────────────
    // (Task #2082) A malformed JSON blob in SETTING_LAST_RUN (truncated
    // write, manual edit) must be tolerated: getLastOutboundGapCloseRun
    // swallows the parse error and the route degrades to lastRun: null.
    await setSystemSetting(SETTING_LAST_RUN, "{not-valid-json", "test");
    assertEq(
      await getLastOutboundGapCloseRun(),
      null,
      "getLastOutboundGapCloseRun returns null for an unparseable value",
    );

    const corrupt = await getStatus(baseUrl, TL_ID);
    assertEq(
      corrupt.status,
      200,
      `corrupt last-run status must be 200, not 500 (got ${corrupt.status} ${JSON.stringify(corrupt.body)})`,
    );
    assertEq(
      corrupt.body.lastRun,
      null,
      "corrupt last-run response surfaces lastRun: null",
    );
    // Task #2130 — the corrupt branch must produce a distinct "unreadable"
    // signal (plus a plain-English error) so a silent persistence
    // regression is visible to admins, not hidden behind an empty panel.
    assertEq(
      corrupt.body.lastRunStatus,
      "unreadable",
      "corrupt last-run response classifies lastRunStatus as unreadable",
    );
    assert.ok(
      typeof corrupt.body.lastRunError === "string" &&
        corrupt.body.lastRunError.length > 0,
      "corrupt last-run response includes a non-empty lastRunError",
    );
    {
      const read = await readLastOutboundGapCloseRun();
      assertEq(read.status, "unreadable", "reader classifies unreadable");
      assertEq(read.lastRun, null, "reader returns null lastRun for unreadable");
      assert.ok(
        typeof read.error === "string" && read.error.length > 0,
        "reader surfaces a non-empty error for unreadable",
      );
    }
    assert.ok(
      corrupt.body?.config && typeof corrupt.body.config === "object",
      "corrupt last-run response still includes the config block",
    );

    console.log("front-outbound-gap-close-status-route.test.ts: OK");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await deleteTestCoverageRows();
    await cleanupUsers();

    // Restore mutated settings (synthetic "test" actor keeps the FK happy).
    if (savedEnabled === null) await deleteSystemSetting(SETTING_ENABLED);
    else await setSystemSetting(SETTING_ENABLED, savedEnabled, "test");

    if (savedMax === null) await deleteSystemSetting(SETTING_MAX_MONTHS_PER_TICK);
    else await setSystemSetting(SETTING_MAX_MONTHS_PER_TICK, savedMax, "test");

    if (savedLastRun === null) await deleteSystemSetting(SETTING_LAST_RUN);
    else await setSystemSetting(SETTING_LAST_RUN, savedLastRun, "test");
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
await main();
