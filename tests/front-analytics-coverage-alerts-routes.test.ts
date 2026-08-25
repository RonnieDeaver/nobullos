/* test-registration
{
  "name": "Front Analytics coverage alert threshold routes (Task #1661)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1661 — End-to-end coverage for the Front coverage alert
 * threshold editor routes added in Task #1645.
 *
 * Routes under test (both live in server/routes/integrations.ts):
 *   - GET  /api/admin/front/analytics-coverage/alerts (requireAccountManager)
 *   - PUT  /api/admin/front/analytics-coverage/alerts (requireTeamLead)
 *
 * Strategy: mount `registerIntegrationRoutes` on a minimal Express app
 * with a passport-shaped fake-auth middleware that swaps the actor id
 * per-request via an `x-test-actor` header. Both real `isAuthenticated`
 * and the real `requireAccountManager` / `requireTeamLead` guards run
 * against seeded `users` rows.
 *
 * Pinned behavior:
 *   1. GET requires account_manager+ (account_manager 200, base user 403).
 *   2. PUT requires team_lead+ (account_manager 403, team_lead 200).
 *   3. Bounds validation rejects negative / >100 / non-finite values
 *      for both `dropDeltaPct` and `monthFloorPct` with HTTP 400 and
 *      does not mutate system_settings.
 *   4. An admin_setting_audit row is written for each changed key, and
 *      none is written for keys whose values are unchanged in the PUT
 *      body.
 *   5. Partial-body PUTs that include only one of `enabled` /
 *      `dropDeltaPct` / `monthFloorPct` update only that key.
 *   6. (Task #2220) The finalized-month completeness toggle
 *      (`completenessAlertsEnabled`, backed by
 *      SETTING_COMPLETENESS_ALERTS_ENABLED) round-trips through GET/PUT:
 *      GET exposes `completenessAlertsEnabled` and
 *      `defaultCompletenessAlertsEnabled`; a PUT that flips it persists
 *      the setting and writes exactly one audit row; a no-op PUT (same
 *      value) writes none — matching the other keys' behavior.
 *   7. (Task #2834) The Task #2819 denominator floor-raise switch
 *      (`floorRaiseAlertsEnabled`) and material-regrowth threshold
 *      (`floorRaiseRegrowthPct`) round-trip the same way: GET exposes
 *      values + defaults + regrowth bounds; PUT validates the regrowth
 *      bounds (400, no mutation), persists changes with exactly one
 *      audit row per changed key, and writes none on no-op.
 */

// Self-establish test mode so the Clerk per-request auth seam is honored even
// under a bare `tsx` repro (requireAuth reads NODE_ENV at request time).
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import {
  SETTING_ENABLED,
  SETTING_DROP_DELTA_PCT,
  SETTING_MONTH_FLOOR_PCT,
  SETTING_COMPLETENESS_ALERTS_ENABLED,
  SETTING_FLOOR_RAISE_ALERTS_ENABLED,
  SETTING_FLOOR_RAISE_REGROWTH_PCT,
  DEFAULTS,
  MAX_DROP_DELTA_PCT,
  MAX_MONTH_FLOOR_PCT,
  MIN_FLOOR_RAISE_REGROWTH_PCT,
  MAX_FLOOR_RAISE_REGROWTH_PCT,
} from "../server/services/frontAnalyticsCoverageAlerts";

const TAG = "task-1661";
const BASE_ID = `${TAG}-base`;
const AM_ID = `${TAG}-am`;
const TL_ID = `${TAG}-tl`;

// The three threshold keys exercised by the original Task #1661 audit
// assertions (the combined-change section expects one audit row for each
// of these). The completeness key is tracked separately below so it can
// be backed up / restored and audited without disturbing those loops.
const SETTING_KEYS = [
  SETTING_ENABLED,
  SETTING_DROP_DELTA_PCT,
  SETTING_MONTH_FLOOR_PCT,
];

// Task #2220 / #2834 — all keys that must be backed up and restored,
// including the finalized-month completeness toggle and the Task #2819
// floor-raise switch + regrowth threshold.
const BACKUP_KEYS = [
  ...SETTING_KEYS,
  SETTING_COMPLETENESS_ALERTS_ENABLED,
  SETTING_FLOOR_RAISE_ALERTS_ENABLED,
  SETTING_FLOOR_RAISE_REGROWTH_PCT,
];

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
    VALUES (${BASE_ID}, NULL, ${"Task1661 Base"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task1661 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${TL_ID}, 'team_lead', ${"Task1661 TL"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUsers(): Promise<void> {
  try {
    await db.execute(sql`
      DELETE FROM admin_setting_audit
      WHERE changed_by IN (${BASE_ID}, ${AM_ID}, ${TL_ID})
    `);
  } catch {}
  try {
    await db.execute(sql`
      DELETE FROM users WHERE id IN (${BASE_ID}, ${AM_ID}, ${TL_ID})
    `);
  } catch {}
}

async function backupSettings(): Promise<Map<string, string | null>> {
  const saved = new Map<string, string | null>();
  for (const k of BACKUP_KEYS) {
    const row = await storage.getSystemSetting(k).catch(() => null);
    saved.set(k, row?.value ?? null);
  }
  return saved;
}

async function restoreSettings(
  saved: Map<string, string | null>,
): Promise<void> {
  for (const [k, v] of saved.entries()) {
    if (v === null) {
      await storage.deleteSystemSetting(k);
    } else {
      await storage.setSystemSetting(k, v, "system");
    }
  }
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): actor id string
    // authenticates as that user (real role gate reads the committed users
    // seed); absent header → null → anonymous 401.
    const actor = String(req.headers["x-test-actor"] ?? "");
    (req as any).__test_clerkUserId = actor || null;
    next();
  });
  registerIntegrationRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function req(
  baseUrl: string,
  method: "GET" | "PUT",
  path: string,
  actor: string | null,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (actor) headers["x-test-actor"] = actor;
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: method === "PUT" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function countAuditRows(
  settingKey: string,
  actor: string,
): Promise<number> {
  const res: any = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM admin_setting_audit
    WHERE setting_key = ${settingKey}
      AND changed_by = ${actor}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

async function snapshotAuditCounts(actor: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const k of SETTING_KEYS) out[k] = await countAuditRows(k, actor);
  return out;
}

function delta(
  before: Record<string, number>,
  after: Record<string, number>,
  key: string,
): number {
  return (after[key] ?? 0) - (before[key] ?? 0);
}

const ROUTE = "/api/admin/front/analytics-coverage/alerts";

async function main(): Promise<void> {
  await ensureUsers();
  const savedSettings = await backupSettings();
  // Start from a known baseline that matches the service defaults so we
  // can predict whether a given PUT introduces an audit-eligible change.
  await storage.setSystemSetting(SETTING_ENABLED, "true", "system");
  await storage.setSystemSetting(SETTING_DROP_DELTA_PCT, String(DEFAULTS.dropDeltaPct), "system");
  await storage.setSystemSetting(SETTING_MONTH_FLOOR_PCT, String(DEFAULTS.monthFloorPct), "system");
  // Task #2220 — seed the completeness toggle to its default (OFF) so a
  // PUT flipping it to true is a predictable, audit-eligible change.
  await storage.setSystemSetting(
    SETTING_COMPLETENESS_ALERTS_ENABLED,
    String(DEFAULTS.completenessAlertsEnabled),
    "system",
  );
  // Task #2834 — seed the floor-raise switch (default ON) and regrowth
  // threshold (default 25) so flips/changes are predictable and
  // audit-eligible.
  await storage.setSystemSetting(
    SETTING_FLOOR_RAISE_ALERTS_ENABLED,
    String(DEFAULTS.floorRaiseAlertsEnabled),
    "system",
  );
  await storage.setSystemSetting(
    SETTING_FLOOR_RAISE_REGROWTH_PCT,
    String(DEFAULTS.floorRaiseRegrowthPct),
    "system",
  );

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // ── 1. Auth & role gating on GET ────────────────────────────────
    const anon = await req(baseUrl, "GET", ROUTE, null);
    assertEq(anon.status, 401, "GET without auth should 401");

    const base = await req(baseUrl, "GET", ROUTE, BASE_ID);
    assertEq(base.status, 403, "GET as base user should 403");

    const amGet = await req(baseUrl, "GET", ROUTE, AM_ID);
    assertEq(amGet.status, 200, `GET as account_manager should 200 (got ${amGet.status} ${JSON.stringify(amGet.body)})`);
    assertEq(typeof amGet.body?.enabled, "boolean", "GET body exposes enabled");
    assertEq(typeof amGet.body?.dropDeltaPct, "number", "GET body exposes dropDeltaPct");
    assertEq(typeof amGet.body?.monthFloorPct, "number", "GET body exposes monthFloorPct");
    assertEq(amGet.body?.dropDeltaPct, DEFAULTS.dropDeltaPct, "GET reflects baseline drop");
    assertEq(amGet.body?.monthFloorPct, DEFAULTS.monthFloorPct, "GET reflects baseline floor");
    assertEq(typeof amGet.body?.minDropDeltaPct, "number", "GET exposes bounds");
    assertEq(amGet.body?.maxDropDeltaPct, MAX_DROP_DELTA_PCT, "GET exposes max drop bound");
    assertEq(amGet.body?.maxMonthFloorPct, MAX_MONTH_FLOOR_PCT, "GET exposes max floor bound");
    // Task #2220 — the completeness toggle and its default are exposed.
    assertEq(
      typeof amGet.body?.completenessAlertsEnabled,
      "boolean",
      "GET body exposes completenessAlertsEnabled",
    );
    assertEq(
      amGet.body?.completenessAlertsEnabled,
      DEFAULTS.completenessAlertsEnabled,
      "GET reflects baseline completeness toggle",
    );
    assertEq(
      amGet.body?.defaultCompletenessAlertsEnabled,
      DEFAULTS.completenessAlertsEnabled,
      "GET exposes defaultCompletenessAlertsEnabled",
    );

    // ── 2. Role gating on PUT ───────────────────────────────────────
    const amPut = await req(baseUrl, "PUT", ROUTE, AM_ID, { dropDeltaPct: 3.5 });
    assertEq(amPut.status, 403, `PUT as account_manager should 403 (got ${amPut.status})`);
    // Bound was not mutated.
    {
      const row = await storage.getSystemSetting(SETTING_DROP_DELTA_PCT);
      assertEq(row?.value, String(DEFAULTS.dropDeltaPct), "AM PUT must not mutate setting");
    }

    // ── 3. Bounds validation (team_lead) ────────────────────────────
    const beforeBad = await snapshotAuditCounts(TL_ID);
    for (const bad of [
      { dropDeltaPct: -1 },
      { dropDeltaPct: 101 },
      { dropDeltaPct: "abc" },
      { monthFloorPct: -0.5 },
      { monthFloorPct: 100.5 },
      { monthFloorPct: "nope" },
    ]) {
      const r = await req(baseUrl, "PUT", ROUTE, TL_ID, bad);
      assertEq(r.status, 400, `PUT bad body ${JSON.stringify(bad)} should 400 (got ${r.status} ${JSON.stringify(r.body)})`);
    }
    // No audit rows written for invalid input.
    {
      const afterBad = await snapshotAuditCounts(TL_ID);
      for (const k of SETTING_KEYS) {
        assertEq(delta(beforeBad, afterBad, k), 0, `no audit row for ${k} from rejected PUTs`);
      }
      const dRow = await storage.getSystemSetting(SETTING_DROP_DELTA_PCT);
      const fRow = await storage.getSystemSetting(SETTING_MONTH_FLOOR_PCT);
      assertEq(dRow?.value, String(DEFAULTS.dropDeltaPct), "drop setting unchanged after bad PUTs");
      assertEq(fRow?.value, String(DEFAULTS.monthFloorPct), "floor setting unchanged after bad PUTs");
    }

    // ── 4. Audit row written per changed key (partial body) ─────────
    // 4a. Change only dropDeltaPct.
    const beforeA = await snapshotAuditCounts(TL_ID);
    const onlyDrop = await req(baseUrl, "PUT", ROUTE, TL_ID, { dropDeltaPct: 3.5 });
    assertEq(onlyDrop.status, 200, `PUT only drop should 200 (got ${onlyDrop.status} ${JSON.stringify(onlyDrop.body)})`);
    assertEq(onlyDrop.body?.dropDeltaPct, 3.5, "drop reflected in response");
    assertEq(onlyDrop.body?.monthFloorPct, DEFAULTS.monthFloorPct, "floor untouched in response");
    assertEq(onlyDrop.body?.enabled, true, "enabled untouched in response");
    {
      const afterA = await snapshotAuditCounts(TL_ID);
      const dRow = await storage.getSystemSetting(SETTING_DROP_DELTA_PCT);
      const fRow = await storage.getSystemSetting(SETTING_MONTH_FLOOR_PCT);
      const eRow = await storage.getSystemSetting(SETTING_ENABLED);
      assertEq(dRow?.value, "3.5", "drop persisted");
      assertEq(fRow?.value, String(DEFAULTS.monthFloorPct), "floor untouched");
      assertEq(eRow?.value, "true", "enabled untouched");
      assertEq(delta(beforeA, afterA, SETTING_DROP_DELTA_PCT), 1, "exactly one drop audit row");
      assertEq(delta(beforeA, afterA, SETTING_MONTH_FLOOR_PCT), 0, "no floor audit row");
      assertEq(delta(beforeA, afterA, SETTING_ENABLED), 0, "no enabled audit row");
    }

    // 4b. Change only monthFloorPct.
    const beforeB = await snapshotAuditCounts(TL_ID);
    const onlyFloor = await req(baseUrl, "PUT", ROUTE, TL_ID, { monthFloorPct: 90.0 });
    assertEq(onlyFloor.status, 200, "PUT only floor should 200");
    assertEq(onlyFloor.body?.monthFloorPct, 90.0, "floor reflected in response");
    assertEq(onlyFloor.body?.dropDeltaPct, 3.5, "drop still 3.5");
    {
      const afterB = await snapshotAuditCounts(TL_ID);
      assertEq(delta(beforeB, afterB, SETTING_MONTH_FLOOR_PCT), 1, "exactly one floor audit row");
      assertEq(delta(beforeB, afterB, SETTING_DROP_DELTA_PCT), 0, "no extra drop audit row");
      assertEq(delta(beforeB, afterB, SETTING_ENABLED), 0, "no enabled audit row");
    }

    // 4c. Change only enabled flag.
    const beforeC = await snapshotAuditCounts(TL_ID);
    const onlyEnabled = await req(baseUrl, "PUT", ROUTE, TL_ID, { enabled: false });
    assertEq(onlyEnabled.status, 200, "PUT only enabled should 200");
    assertEq(onlyEnabled.body?.enabled, false, "enabled reflected in response");
    assertEq(onlyEnabled.body?.dropDeltaPct, 3.5, "drop still 3.5");
    assertEq(onlyEnabled.body?.monthFloorPct, 90.0, "floor still 90");
    {
      const afterC = await snapshotAuditCounts(TL_ID);
      assertEq(delta(beforeC, afterC, SETTING_ENABLED), 1, "exactly one enabled audit row");
      assertEq(delta(beforeC, afterC, SETTING_DROP_DELTA_PCT), 0, "no drop audit row");
      assertEq(delta(beforeC, afterC, SETTING_MONTH_FLOOR_PCT), 0, "no floor audit row");
    }

    // 4d. No-op PUT (same values) must NOT write any audit row.
    const beforeD = await snapshotAuditCounts(TL_ID);
    const noop = await req(baseUrl, "PUT", ROUTE, TL_ID, {
      enabled: false,
      dropDeltaPct: 3.5,
      monthFloorPct: 90.0,
    });
    assertEq(noop.status, 200, "no-op PUT still 200");
    {
      const afterD = await snapshotAuditCounts(TL_ID);
      for (const k of SETTING_KEYS) {
        assertEq(delta(beforeD, afterD, k), 0, `no audit row for unchanged key ${k}`);
      }
    }

    // 4e. Combined change writes one row per changed key.
    const beforeE = await snapshotAuditCounts(TL_ID);
    const combo = await req(baseUrl, "PUT", ROUTE, TL_ID, {
      enabled: true,
      dropDeltaPct: 4.0,
      monthFloorPct: 92.0,
    });
    assertEq(combo.status, 200, "combined PUT should 200");
    assertEq(combo.body?.enabled, true, "enabled flipped back");
    assertEq(combo.body?.dropDeltaPct, 4.0, "drop updated");
    assertEq(combo.body?.monthFloorPct, 92.0, "floor updated");
    {
      const afterE = await snapshotAuditCounts(TL_ID);
      for (const k of SETTING_KEYS) {
        assertEq(delta(beforeE, afterE, k), 1, `exactly one audit row for ${k} after combined change`);
      }
    }

    // ── 5. Completeness toggle round-trips through PUT (Task #2220) ──
    // 5a. Flipping completenessAlertsEnabled persists + writes one audit
    //     row, and does not touch the three threshold keys' audits.
    const beforeF = await snapshotAuditCounts(TL_ID);
    const beforeFCompleteness = await countAuditRows(
      SETTING_COMPLETENESS_ALERTS_ENABLED,
      TL_ID,
    );
    const onlyCompleteness = await req(baseUrl, "PUT", ROUTE, TL_ID, {
      completenessAlertsEnabled: true,
    });
    assertEq(
      onlyCompleteness.status,
      200,
      `PUT only completeness should 200 (got ${onlyCompleteness.status} ${JSON.stringify(onlyCompleteness.body)})`,
    );
    assertEq(
      onlyCompleteness.body?.completenessAlertsEnabled,
      true,
      "completeness reflected in response",
    );
    assertEq(onlyCompleteness.body?.enabled, true, "enabled untouched in response");
    assertEq(onlyCompleteness.body?.dropDeltaPct, 4.0, "drop untouched in response");
    assertEq(onlyCompleteness.body?.monthFloorPct, 92.0, "floor untouched in response");
    {
      const afterF = await snapshotAuditCounts(TL_ID);
      const afterFCompleteness = await countAuditRows(
        SETTING_COMPLETENESS_ALERTS_ENABLED,
        TL_ID,
      );
      const cRow = await storage.getSystemSetting(
        SETTING_COMPLETENESS_ALERTS_ENABLED,
      );
      assertEq(cRow?.value, "true", "completeness toggle persisted");
      assertEq(
        afterFCompleteness - beforeFCompleteness,
        1,
        "exactly one completeness audit row",
      );
      for (const k of SETTING_KEYS) {
        assertEq(
          delta(beforeF, afterF, k),
          0,
          `no audit row for ${k} from completeness-only PUT`,
        );
      }
    }

    // 5b. No-op PUT (same completeness value) writes no audit row.
    const beforeGCompleteness = await countAuditRows(
      SETTING_COMPLETENESS_ALERTS_ENABLED,
      TL_ID,
    );
    const noopCompleteness = await req(baseUrl, "PUT", ROUTE, TL_ID, {
      completenessAlertsEnabled: true,
    });
    assertEq(noopCompleteness.status, 200, "no-op completeness PUT still 200");
    assertEq(
      noopCompleteness.body?.completenessAlertsEnabled,
      true,
      "completeness still true in response",
    );
    {
      const afterGCompleteness = await countAuditRows(
        SETTING_COMPLETENESS_ALERTS_ENABLED,
        TL_ID,
      );
      assertEq(
        afterGCompleteness - beforeGCompleteness,
        0,
        "no audit row for unchanged completeness toggle",
      );
    }

    // ── 6. Floor-raise switch + regrowth threshold (Task #2834) ──────
    // 6a. GET exposes values, defaults, and regrowth bounds.
    const frGet = await req(baseUrl, "GET", ROUTE, AM_ID);
    assertEq(frGet.status, 200, "GET for floor-raise fields should 200");
    assertEq(
      typeof frGet.body?.floorRaiseAlertsEnabled,
      "boolean",
      "GET body exposes floorRaiseAlertsEnabled",
    );
    assertEq(
      frGet.body?.floorRaiseAlertsEnabled,
      DEFAULTS.floorRaiseAlertsEnabled,
      "GET reflects baseline floor-raise switch",
    );
    assertEq(
      frGet.body?.floorRaiseRegrowthPct,
      DEFAULTS.floorRaiseRegrowthPct,
      "GET reflects baseline floor-raise regrowth pct",
    );
    assertEq(
      frGet.body?.defaultFloorRaiseAlertsEnabled,
      DEFAULTS.floorRaiseAlertsEnabled,
      "GET exposes defaultFloorRaiseAlertsEnabled",
    );
    assertEq(
      frGet.body?.defaultFloorRaiseRegrowthPct,
      DEFAULTS.floorRaiseRegrowthPct,
      "GET exposes defaultFloorRaiseRegrowthPct",
    );
    assertEq(
      frGet.body?.minFloorRaiseRegrowthPct,
      MIN_FLOOR_RAISE_REGROWTH_PCT,
      "GET exposes min regrowth bound",
    );
    assertEq(
      frGet.body?.maxFloorRaiseRegrowthPct,
      MAX_FLOOR_RAISE_REGROWTH_PCT,
      "GET exposes max regrowth bound",
    );

    // 6b. Bounds validation on floorRaiseRegrowthPct: 400 + no mutation
    //     + no audit rows.
    const beforeBadFr = await countAuditRows(SETTING_FLOOR_RAISE_REGROWTH_PCT, TL_ID);
    for (const bad of [
      { floorRaiseRegrowthPct: -1 },
      { floorRaiseRegrowthPct: MAX_FLOOR_RAISE_REGROWTH_PCT + 1 },
      { floorRaiseRegrowthPct: "nope" },
    ]) {
      const r = await req(baseUrl, "PUT", ROUTE, TL_ID, bad);
      assertEq(
        r.status,
        400,
        `PUT bad floor-raise body ${JSON.stringify(bad)} should 400 (got ${r.status} ${JSON.stringify(r.body)})`,
      );
    }
    {
      const row = await storage.getSystemSetting(SETTING_FLOOR_RAISE_REGROWTH_PCT);
      assertEq(
        row?.value,
        String(DEFAULTS.floorRaiseRegrowthPct),
        "regrowth setting unchanged after bad PUTs",
      );
      const afterBadFr = await countAuditRows(SETTING_FLOOR_RAISE_REGROWTH_PCT, TL_ID);
      assertEq(
        afterBadFr - beforeBadFr,
        0,
        "no regrowth audit rows from rejected PUTs",
      );
    }

    // 6c. Flipping the switch persists + writes exactly one audit row,
    //     without touching the other keys' audits.
    const beforeFrToggle = await snapshotAuditCounts(TL_ID);
    const beforeFrToggleCount = await countAuditRows(
      SETTING_FLOOR_RAISE_ALERTS_ENABLED,
      TL_ID,
    );
    const frToggle = await req(baseUrl, "PUT", ROUTE, TL_ID, {
      floorRaiseAlertsEnabled: false,
    });
    assertEq(frToggle.status, 200, "PUT floor-raise toggle should 200");
    assertEq(
      frToggle.body?.floorRaiseAlertsEnabled,
      false,
      "floor-raise switch reflected in response",
    );
    assertEq(frToggle.body?.enabled, true, "enabled untouched in response");
    {
      const row = await storage.getSystemSetting(SETTING_FLOOR_RAISE_ALERTS_ENABLED);
      assertEq(row?.value, "false", "floor-raise switch persisted");
      const afterFrToggleCount = await countAuditRows(
        SETTING_FLOOR_RAISE_ALERTS_ENABLED,
        TL_ID,
      );
      assertEq(
        afterFrToggleCount - beforeFrToggleCount,
        1,
        "exactly one floor-raise-enabled audit row",
      );
      const afterFrToggle = await snapshotAuditCounts(TL_ID);
      for (const k of SETTING_KEYS) {
        assertEq(
          delta(beforeFrToggle, afterFrToggle, k),
          0,
          `no audit row for ${k} from floor-raise-toggle PUT`,
        );
      }
    }

    // 6d. Changing the regrowth threshold persists + one audit row.
    const beforeFrRegrowthCount = await countAuditRows(
      SETTING_FLOOR_RAISE_REGROWTH_PCT,
      TL_ID,
    );
    const frRegrowth = await req(baseUrl, "PUT", ROUTE, TL_ID, {
      floorRaiseRegrowthPct: 40,
    });
    assertEq(frRegrowth.status, 200, "PUT regrowth should 200");
    assertEq(
      frRegrowth.body?.floorRaiseRegrowthPct,
      40,
      "regrowth reflected in response",
    );
    assertEq(
      frRegrowth.body?.floorRaiseAlertsEnabled,
      false,
      "floor-raise switch untouched in response",
    );
    {
      const row = await storage.getSystemSetting(SETTING_FLOOR_RAISE_REGROWTH_PCT);
      assertEq(row?.value, "40", "regrowth persisted");
      const afterFrRegrowthCount = await countAuditRows(
        SETTING_FLOOR_RAISE_REGROWTH_PCT,
        TL_ID,
      );
      assertEq(
        afterFrRegrowthCount - beforeFrRegrowthCount,
        1,
        "exactly one regrowth audit row",
      );
    }

    // 6e. No-op PUT (same values) writes no audit rows for either key.
    const beforeFrNoopEnabled = await countAuditRows(
      SETTING_FLOOR_RAISE_ALERTS_ENABLED,
      TL_ID,
    );
    const beforeFrNoopRegrowth = await countAuditRows(
      SETTING_FLOOR_RAISE_REGROWTH_PCT,
      TL_ID,
    );
    const frNoop = await req(baseUrl, "PUT", ROUTE, TL_ID, {
      floorRaiseAlertsEnabled: false,
      floorRaiseRegrowthPct: 40,
    });
    assertEq(frNoop.status, 200, "no-op floor-raise PUT still 200");
    {
      const afterFrNoopEnabled = await countAuditRows(
        SETTING_FLOOR_RAISE_ALERTS_ENABLED,
        TL_ID,
      );
      const afterFrNoopRegrowth = await countAuditRows(
        SETTING_FLOOR_RAISE_REGROWTH_PCT,
        TL_ID,
      );
      assertEq(
        afterFrNoopEnabled - beforeFrNoopEnabled,
        0,
        "no audit row for unchanged floor-raise switch",
      );
      assertEq(
        afterFrNoopRegrowth - beforeFrNoopRegrowth,
        0,
        "no audit row for unchanged regrowth",
      );
    }

    console.log("front-analytics-coverage-alerts-routes.test.ts: OK");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await restoreSettings(savedSettings);
    await cleanupUsers();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
await main();
