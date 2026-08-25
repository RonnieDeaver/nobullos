/* test-registration
{
  "name": "Front Analytics pull fix (Task #1675)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1675 — Regression for Front Analytics pull failures that
 * stranded the coverage tiles at 0/0 in prod.
 *
 * Pins three behaviors:
 *
 *   1. `parseSubmitResponse` extracts the report id from
 *      `_links.self` when the top-level `id` is absent (the actual
 *      shape Front's Reports API returns today). Only throws
 *      `unexpected_shape` when neither is present.
 *
 *   2. `refreshMonth` classifies typed Front errors:
 *        - `front_analytics_auth_failed` (403) → persists row with
 *          `unrecoverable=true` and an error message that includes
 *          the front-side snippet.
 *        - `front_analytics_report_failed` (transport / 5xx) →
 *          stays retriable (`unrecoverable=false`).
 *      On a subsequent successful pull, `unrecoverable` is cleared.
 *
 *   3. The refresh worker tick skips months flagged `unrecoverable`
 *      so a confirmed-permanent failure stops re-burning queue slots
 *      every 30 min. Operator-triggered POST refresh-month still
 *      re-runs them.
 *
 * Plus a thin route test for POST /api/admin/front/analytics-coverage
 *   /refresh-month covering 400 / 403 / 200 (front_error outcome).
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
  __frontAnalyticsClientTestHelpers,
  extractReportIdFromSelf,
  parseSubmitResponse,
  FrontAnalyticsError,
  type MonthlyMetricResult,
} from "../server/services/frontAnalyticsClient";
import {
  refreshMonth,
  getExistingMonth,
  runCoverageRefreshTick,
  isUnrecoverableErrorCode,
  FRONT_ADOPTION_DATE,
  SETTING_ADOPTION_DATE,
  SETTING_REFRESH_ENABLED,
} from "../server/services/frontAnalyticsCoverage";

const TAG = "task-1675";

const ADOPTION_BASE = new Date(FRONT_ADOPTION_DATE); // e.g. 2025-07-01

const BASE_YEAR = ADOPTION_BASE.getUTCFullYear();
const BASE_MONTH_IDX = ADOPTION_BASE.getUTCMonth(); // 0-based; 6 for July
const AUTH_MONTH_IDX = BASE_MONTH_IDX;
const TRANSIENT_MONTH_IDX = BASE_MONTH_IDX + 1;
const HEAL_MONTH_IDX = BASE_MONTH_IDX + 2;
const CURRENT_MONTH_IDX = BASE_MONTH_IDX + 3;
const TL_ID = `${TAG}-tl`;
const AM_ID = `${TAG}-am`;

function utcMonth(year: number, mIdx: number): { start: Date; end: Date; label: string } {
  const start = new Date(Date.UTC(year, mIdx, 1));
  const end = new Date(Date.UTC(year, mIdx + 1, 1));
  // Derive the label from the normalized Date so month offsets that roll
  // past December carry into the next year correctly.
  const label = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start, end, label };
}

const SEEDED_MONTH_LABELS = [
  utcMonth(BASE_YEAR, AUTH_MONTH_IDX).label,
  utcMonth(BASE_YEAR, TRANSIENT_MONTH_IDX).label,
  utcMonth(BASE_YEAR, HEAL_MONTH_IDX).label,
  utcMonth(BASE_YEAR, CURRENT_MONTH_IDX).label,
];
async function cleanupTestRows(): Promise<void> {
  const inList = sql.join(
    SEEDED_MONTH_LABELS.map((m) => sql`${m}`),
    sql`, `,
  );
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage
    WHERE month IN (${inList})
  `);
}

async function ensureUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${TL_ID}, 'team_lead', ${"Task1675 TL"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task1675 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUsers(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id IN (${TL_ID}, ${AM_ID})`);
  } catch {}
}

async function withSettingsBackup<T>(
  keys: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | null>();
  for (const k of keys) {
    const row = await storage.getSystemSetting(k).catch(() => null);
    saved.set(k, row?.value ?? null);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved.entries()) {
      if (v === null) {
        await storage.deleteSystemSetting(k);
      } else {
        await storage.setSystemSetting(k, v, "system");
      }
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

async function postRefreshMonth(
  baseUrl: string,
  actor: string | null,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (actor) headers["x-test-actor"] = actor;
  const r = await fetch(`${baseUrl}/api/admin/front/analytics-coverage/refresh-month`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  await ensureUsers();
  await cleanupTestRows();

  // ── 1. parseSubmitResponse — _links.self URL is enough ───────────
  {
    // 1a: only _links.self present (the current Front shape).
    const parsed = parseSubmitResponse({
      _links: { self: "https://api2.frontapp.com/analytics/reports/rpt_abc123" },
    });
    assert.equal(parsed.reportId, "rpt_abc123", "reportId extracted from _links.self");
    assert.equal(
      parsed.pollUrl,
      "https://api2.frontapp.com/analytics/reports/rpt_abc123",
      "pollUrl is the self URL",
    );

    // 1b: trailing query/fragment doesn't break extraction.
    assert.equal(
      extractReportIdFromSelf("https://api2.frontapp.com/analytics/reports/rpt_xyz?token=foo"),
      "rpt_xyz",
    );
    assert.equal(
      extractReportIdFromSelf("https://api2.frontapp.com/analytics/reports/rpt_xyz#x"),
      "rpt_xyz",
    );

    // 1c: top-level id wins when both present.
    const both = parseSubmitResponse({
      id: "rpt_top",
      _links: { self: "https://api2.frontapp.com/analytics/reports/rpt_self" },
    });
    assert.equal(both.reportId, "rpt_top");

    // 1d: missing both → throws unexpected_shape.
    assert.throws(
      () => parseSubmitResponse({} as any),
      (err: unknown) =>
        err instanceof FrontAnalyticsError &&
        err.code === "front_analytics_unexpected_shape",
      "missing _links.self must throw unexpected_shape",
    );

    // 1e: missing _links.self URL but with a self that doesn't match
    // the analytics path → also unexpected_shape.
    assert.throws(
      () =>
        parseSubmitResponse({
          _links: { self: "https://api2.frontapp.com/somewhere/else/123" },
        }),
      (err: unknown) =>
        err instanceof FrontAnalyticsError &&
        err.code === "front_analytics_unexpected_shape",
    );
  }

  // ── 2. isUnrecoverableErrorCode classification ───────────────────
  {
    assert.equal(isUnrecoverableErrorCode("front_analytics_auth_failed", 403), true);
    assert.equal(isUnrecoverableErrorCode("front_analytics_auth_failed", 401), true);
    assert.equal(isUnrecoverableErrorCode("front_analytics_report_failed", 410), true);
    assert.equal(isUnrecoverableErrorCode("front_analytics_report_failed", 400), true);
    assert.equal(isUnrecoverableErrorCode("front_analytics_report_failed", 500), false);
    assert.equal(isUnrecoverableErrorCode("front_analytics_report_failed", undefined), false);
    assert.equal(isUnrecoverableErrorCode("front_analytics_rate_limited", 429), false);
    assert.equal(isUnrecoverableErrorCode("front_analytics_unexpected_shape"), false);
    assert.equal(isUnrecoverableErrorCode("front_analytics_partial"), false);
  }

  // ── 3. refreshMonth persistence: auth-failed → unrecoverable=true
  //       transient (5xx) → unrecoverable=false; success clears it. ─
  await withSettingsBackup(
    [SETTING_ADOPTION_DATE, SETTING_REFRESH_ENABLED],
    async () => {
      const scripted: Array<
        | { kind: "ok"; value: number }
        | { kind: "throw"; err: Error }
      > = [];
      __frontAnalyticsClientTestHelpers.setPullOverride(async () => {
        const next = scripted.shift();
        if (!next) throw new Error("test: scripted pull queue empty");
        if (next.kind === "throw") throw next.err;
        return {
          reportId: `test-${Math.random().toString(36).slice(2, 8)}`,
          value: next.value,
          status: "done",
          metric: "num_messages_received",
        } as MonthlyMetricResult;
      });

      try {
        // Adoption-floor-aligned so the Section 4 worker tick actually
        // reaches them (see the ADOPTION_BASE comment above).
        const authMonth = utcMonth(BASE_YEAR, AUTH_MONTH_IDX); // floor+0
        const transientMonth = utcMonth(BASE_YEAR, TRANSIENT_MONTH_IDX); // floor+1
        const healMonth = utcMonth(BASE_YEAR, HEAL_MONTH_IDX); // floor+2

        // 3a — auth_failed → unrecoverable=true, status flagged "error".
        scripted.push({
          kind: "throw",
          err: new FrontAnalyticsError(
            "front_analytics_auth_failed",
            "Front analytics submit auth failed (403): missing analytics:read scope",
            403,
          ),
        });
        const r1 = await refreshMonth({
          month: authMonth.label,
          monthStart: authMonth.start,
          monthEnd: authMonth.end,
          isCurrentMonth: false,
        });
        assert.equal(r1.outcome, "front_error");
        assert.equal(r1.errorCode, "front_analytics_auth_failed");
        assert.equal(r1.unrecoverable, true, "auth_failed marked unrecoverable");
        const row1 = await getExistingMonth(authMonth.label);
        assert.ok(row1, "row persisted for auth-failed month");
        assert.equal(row1!.unrecoverable, true, "DB row carries unrecoverable=true");
        assert.equal(row1!.frontAnalyticsStatus, "error");
        assert.ok(
          row1!.frontAnalyticsError?.includes("front_analytics_auth_failed"),
          `error string includes code (got ${row1!.frontAnalyticsError})`,
        );
        assert.ok(
          row1!.frontAnalyticsError?.includes("403"),
          "error string includes Front status",
        );

        // 3b — transient/transport-style error stays retriable.
        scripted.push({
          kind: "throw",
          err: new FrontAnalyticsError(
            "front_analytics_report_failed",
            "Front analytics submit failed (502): bad gateway",
            502,
          ),
        });
        const r2 = await refreshMonth({
          month: transientMonth.label,
          monthStart: transientMonth.start,
          monthEnd: transientMonth.end,
          isCurrentMonth: false,
        });
        assert.equal(r2.outcome, "front_error");
        assert.equal(r2.unrecoverable, false, "5xx report_failed stays retriable");
        const row2 = await getExistingMonth(transientMonth.label);
        assert.equal(row2!.unrecoverable, false, "DB row stays retriable for 5xx");

        // 3c — first failure marks unrecoverable, subsequent success clears it.
        scripted.push({
          kind: "throw",
          err: new FrontAnalyticsError(
            "front_analytics_auth_failed",
            "Front analytics submit auth failed (403)",
            403,
          ),
        });
        await refreshMonth({
          month: healMonth.label,
          monthStart: healMonth.start,
          monthEnd: healMonth.end,
          isCurrentMonth: false,
        });
        const rowSick = await getExistingMonth(healMonth.label);
        assert.equal(rowSick!.unrecoverable, true);

        scripted.push({ kind: "ok", value: 42 });
        const r3 = await refreshMonth({
          month: healMonth.label,
          monthStart: healMonth.start,
          monthEnd: healMonth.end,
          isCurrentMonth: false,
        });
        assert.equal(r3.outcome, "ok");
        const rowHealed = await getExistingMonth(healMonth.label);
        assert.equal(
          rowHealed!.unrecoverable,
          false,
          "successful refresh clears unrecoverable flag",
        );
        assert.equal(rowHealed!.frontAnalyticsError, null);
        assert.equal(rowHealed!.frontTotalMessages, 42);

        // ── 4. Worker tick skips unrecoverable months ─────────────────
        // Task #2481 — the tick derives its month range from the hard-coded
        // FRONT_ADOPTION_DATE floor and IGNORES
        // `system_settings.front_adoption_date`, so we no longer pin the
        // adoption setting (it would be a dead write). Instead we seeded the
        // three completed months as the FIRST three months from the floor
        // (auth=floor+0, transient=floor+1, heal=floor+2) so the worker's
        // capped `missingCompleted` batch (default 3 earliest months) reaches
        // them. `fixedNow` is the month AFTER heal (floor+3) so the current
        // month is a fresh, unseeded month:
        //   - authMonth (floor+0)      — unrecoverable=true → SKIPPED.
        //   - transientMonth (floor+1) — error, recoverable → RE-ATTEMPTED.
        //   - healMonth (floor+2)      — finalized clean → skipped by the
        //     "skipped_existing_finalized" rule.
        //   - current (floor+3)        — no row yet → upserted.
        await storage.setSystemSetting(SETTING_REFRESH_ENABLED, "true", "system");

        // If the worker erroneously retries authMonth it will consume a
        // script and the order will break — we assert authMonth's pulledAt
        // does NOT move.
        const authPulledAtBefore = (await getExistingMonth(authMonth.label))!.pulledAt;

        // Anchor `now` to the month after heal so the tick's month range is
        // exactly [floor … current] and `current` is a fresh unseeded month.
        const fixedNow = new Date(Date.UTC(BASE_YEAR, CURRENT_MONTH_IDX, 15));

        // Script exactly one ok for the current-month upsert + one for the
        // transientMonth retry. `attempted` pushes current first, then the
        // completed batch, so the shift order is current(7) → transient(8).
        // authMonth must be skipped (no script consumed for it); healMonth is
        // finalized-clean so it is skipped too.
        scripted.push({ kind: "ok", value: 7 }); // current month upsert
        scripted.push({ kind: "ok", value: 8 }); // transientMonth retry

        const tick = await runCoverageRefreshTick({ now: fixedNow });
        assert.equal(tick.enabled, true);
        assert.equal(tick.paused, false);
        // Filter attempted to only the months this scenario seeded, so a
        // worker that legitimately attempts an unrelated month (e.g. a
        // newly-current month at test time) can neither silently
        // invalidate this assertion nor mask a real regression.
        const seededMonths = [
          authMonth.label,
          transientMonth.label,
          healMonth.label,
        ];
        const attemptedMonths = tick.attempted
          .map((a) => a.month)
          .filter((m) => seededMonths.includes(m));
        assert.ok(
          !attemptedMonths.includes(authMonth.label),
          `worker MUST skip unrecoverable month (seeded=${seededMonths.join(",")} attempted=${attemptedMonths.join(",")})`,
        );
        assert.ok(
          attemptedMonths.includes(transientMonth.label),
          `worker must still retry retriable months (seeded=${seededMonths.join(",")} attempted=${attemptedMonths.join(",")})`,
        );
        const authAfter = await getExistingMonth(authMonth.label);
        assert.equal(
          authAfter!.pulledAt?.toISOString() ?? null,
          authPulledAtBefore?.toISOString() ?? null,
          "unrecoverable month's pulledAt must not change",
        );
        assert.equal(authAfter!.unrecoverable, true, "unrecoverable flag persists across ticks");

        // Drain unused scripted entries; any leftover means worker
        // didn't consume what we expected.
        if (scripted.length !== 0) {
          throw new Error(
            `tick consumed wrong number of pulls; ${scripted.length} script entries left`,
          );
        }

        // ── 5. Manual refresh-month route ─────────────────────────────
        const app = buildApp();
        const { server, baseUrl } = await listen(app);
        try {
          // 5a — bad body → 400.
          const bad = await postRefreshMonth(baseUrl, TL_ID, { month: "2025/07" });
          assert.equal(bad.status, 400, `bad month should 400 (got ${bad.status})`);

          // 5b — account_manager forbidden → 403.
          const am = await postRefreshMonth(baseUrl, AM_ID, { month: authMonth.label });
          assert.equal(am.status, 403, `AM should 403 (got ${am.status})`);

          // 5c — team_lead manual retry on still-broken authMonth.
          scripted.push({
            kind: "throw",
            err: new FrontAnalyticsError(
              "front_analytics_auth_failed",
              "Front analytics submit auth failed (403)",
              403,
            ),
          });
          const retry = await postRefreshMonth(baseUrl, TL_ID, { month: authMonth.label });
          assert.equal(retry.status, 200, `manual retry should 200 (got ${retry.status})`);
          assert.equal(retry.body.outcome, "front_error");
          assert.equal(retry.body.errorCode, "front_analytics_auth_failed");
          assert.equal(retry.body.unrecoverable, true);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      } finally {
        __frontAnalyticsClientTestHelpers.setPullOverride(null);
        await cleanupTestRows();
      }
    },
  );

  await cleanupUsers();
  console.log("front-analytics-coverage-fix.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
await main();
