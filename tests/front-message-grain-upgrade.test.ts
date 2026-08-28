/* test-registration
{
  "name": "Front message grain upgrade (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #2365 — Auto-upgrade older Front coverage months to message grain.
 *
 * Pins the bounded, default-OFF message-grain UPGRADE driver — the
 * automated counterpart to the manual `reach_front_coverage_full_message_
 * grain` prod-action. Each tick it reads finalized, already-pulled,
 * non-current coverage rows whose `denominator_unit` is NOT yet
 * `messages_all` (oldest first, up to a per-tick budget) and re-probes each
 * via the search fallback so the grain converges toward `messages_all`. It
 * is MEASUREMENT-ONLY: it never ingests messages.
 *
 * The real re-probe (`refreshMonth`) issues live Front HTTP traffic, so the
 * test injects a deterministic stand-in via the driver's test seam — one
 * that flips the row's `denominator_unit` in the real test DB. The driver's
 * own SELECT + `getExistingMonth` read that real DB, so the selection,
 * gating, and outcome logic are pinned without a live Front.
 *
 * Deterministic units:
 *   1. Selection: only finalized + pulled + non-current + sub-`messages_all`
 *      rows are candidates, oldest-first, honoring the limit.
 *   2. Master switch OFF (default) → no-op with a reason; never re-probes.
 *   3. Per-message enumeration switch OFF → hard-gap reason; never re-probes.
 *   4. Enabled + enumeration ON + a sub-grain month whose re-probe reaches
 *      message grain → outcome `upgraded`.
 *   5. A month already at `messages_all` (scoped) → `already_message_grain`,
 *      never re-probes.
 *   6. A `front_error` re-probe → outcome `error` carrying the error code.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  setSystemSetting,
  getSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import { DENOMINATOR_UNIT_MESSAGES_ALL } from "../server/services/frontAnalyticsCoverage";
import {
  selectMessageGrainUpgradeMonths,
  runMessageGrainUpgradeTick,
  SETTING_ENABLED,
  SETTING_MAX_MONTHS_PER_TICK,
  SETTING_LAST_RUN,
  REQUIRED_ENUM_SWITCH,
  readLastMessageGrainUpgradeRun,
  __frontMessageGrainUpgradeTestHelpers as H,
} from "../server/services/frontMessageGrainUpgrader";

const Y = 2987; // far-future months — never collide with real coverage rows

function monthBounds(month: string): { start: Date; end: Date } {
  const [yy, mm] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(yy, mm - 1, 1)),
    end: new Date(Date.UTC(yy, mm, 1)),
  };
}

async function upsertCoverage(
  month: string,
  opts: {
    finalized: boolean;
    pulled: boolean;
    denominatorUnit: string | null;
    appliedPct?: number;
  },
): Promise<void> {
  const { start, end } = monthBounds(month);
  await db.execute(sql`
    INSERT INTO front_analytics_monthly_coverage
      (month, month_start, month_end, is_finalized_month, pulled_at,
       denominator_unit, applied_coverage_pct)
    VALUES (${month}, ${start.toISOString()}, ${end.toISOString()},
            ${opts.finalized}, ${opts.pulled ? start.toISOString() : null},
            ${opts.denominatorUnit}, ${opts.appliedPct ?? 0})
    ON CONFLICT (month) DO UPDATE SET
      is_finalized_month  = EXCLUDED.is_finalized_month,
      pulled_at           = EXCLUDED.pulled_at,
      denominator_unit    = EXCLUDED.denominator_unit,
      applied_coverage_pct = EXCLUDED.applied_coverage_pct
  `);
}

async function setDenominatorUnit(month: string, unit: string): Promise<void> {
  await db.execute(sql`
    UPDATE front_analytics_monthly_coverage
    SET denominator_unit = ${unit}
    WHERE month = ${month}
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage WHERE month LIKE ${`${Y}-%`}
  `);
}

test("Task #2365 message-grain upgrade driver", async (t) => {
  await cleanup();
  H.setRefreshMonthOverride(null);

  // Snapshot + restore every setting this driver reads so a loaded dev DB
  // is left exactly as we found it.
  const saved: Record<string, string | undefined> = {};
  for (const k of [
    SETTING_ENABLED,
    SETTING_MAX_MONTHS_PER_TICK,
    SETTING_LAST_RUN,
    REQUIRED_ENUM_SWITCH,
  ]) {
    saved[k] = (await getSystemSetting(k).catch(() => null))?.value;
  }

  t.after(async () => {
    H.setRefreshMonthOverride(null);
    await cleanup();
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) await deleteSystemSetting(k);
      else await setSystemSetting(k, v, "system");
    }
  });

  // ── 1. Selection: only finalized + pulled + non-current + sub-grain
  //       rows, oldest-first, honoring the limit. ────────────────────
  await t.test("selection filters + oldest-first + limit", async () => {
    await upsertCoverage(`${Y}-01`, {
      finalized: true,
      pulled: true,
      denominatorUnit: "conversations_all",
    });
    await upsertCoverage(`${Y}-02`, {
      finalized: true,
      pulled: true,
      denominatorUnit: "inbound_conversations",
    });
    // Already message grain → excluded.
    await upsertCoverage(`${Y}-03`, {
      finalized: true,
      pulled: true,
      denominatorUnit: DENOMINATOR_UNIT_MESSAGES_ALL,
    });
    // Not finalized → excluded.
    await upsertCoverage(`${Y}-04`, {
      finalized: false,
      pulled: true,
      denominatorUnit: "conversations_all",
    });
    // Not pulled → excluded.
    await upsertCoverage(`${Y}-05`, {
      finalized: true,
      pulled: false,
      denominatorUnit: "conversations_all",
    });

    // `now` inside the far-future year so none of these are "current".
    // The shared dev DB may hold real coverage rows that sort ahead of our
    // far-future fixtures (ORDER BY month ASC), so use a generous limit and
    // assert only over OUR months — their relative order and exclusions.
    const now = new Date(Date.UTC(Y, 6, 15));
    const all = await selectMessageGrainUpgradeMonths(5000, now);
    const ours = all.map((m) => m.month).filter((m) => m.startsWith(`${Y}-`));
    assert.deepEqual(
      ours,
      [`${Y}-01`, `${Y}-02`],
      "only finalized+pulled+sub-grain far-future rows, oldest first",
    );
    // The message-grain, not-finalized, and not-pulled rows are excluded.
    for (const excluded of [`${Y}-03`, `${Y}-04`, `${Y}-05`]) {
      assert.ok(!ours.includes(excluded), `${excluded} excluded`);
    }

    // Limit caps the candidate count.
    const one = await selectMessageGrainUpgradeMonths(1, now);
    assert.ok(one.length <= 1, "limit caps the candidate count");
  });

  // ── 2. Master switch OFF (default) → no-op, never re-probes. ──────
  await t.test("disabled → reason, no re-probe", async () => {
    await setSystemSetting(SETTING_ENABLED, "false", "system");
    await setSystemSetting(REQUIRED_ENUM_SWITCH, "true", "system");
    let probed = false;
    H.setRefreshMonthOverride(async () => {
      probed = true;
      return { outcome: "refreshed" } as any;
    });
    const r = await runMessageGrainUpgradeTick({ now: new Date(Date.UTC(Y, 6, 15)) });
    assert.equal(r.enabled, false);
    assert.match(r.reason ?? "", /disabled/);
    assert.equal(probed, false, "never re-probes while disabled");
    assert.equal(r.attempted.length, 0);
  });

  // ── 3. Per-message enumeration OFF → hard-gap reason, no re-probe. ─
  await t.test("enumeration OFF → hard-gap reason, no re-probe", async () => {
    await setSystemSetting(SETTING_ENABLED, "true", "system");
    await setSystemSetting(REQUIRED_ENUM_SWITCH, "false", "system");
    let probed = false;
    H.setRefreshMonthOverride(async () => {
      probed = true;
      return { outcome: "refreshed" } as any;
    });
    const r = await runMessageGrainUpgradeTick({ now: new Date(Date.UTC(Y, 6, 15)) });
    assert.equal(r.enumEnabled, false);
    assert.match(r.reason ?? "", /enumeration/);
    assert.equal(probed, false, "never re-probes when enumeration is OFF");
  });

  // ── 4. Enabled + enumeration ON + a sub-grain month whose re-probe
  //       reaches message grain → outcome `upgraded`. ────────────────
  await t.test("enabled + reaches message grain → upgraded", async () => {
    await setSystemSetting(SETTING_ENABLED, "true", "system");
    await setSystemSetting(REQUIRED_ENUM_SWITCH, "true", "system");
    await setSystemSetting(SETTING_MAX_MONTHS_PER_TICK, "1", "system");
    // The override simulates a completed enumeration walk by flipping the
    // row to message grain in the real DB; the driver's `getExistingMonth`
    // re-read then sees the upgrade.
    H.setRefreshMonthOverride(async (input: any) => {
      await setDenominatorUnit(input.month, DENOMINATOR_UNIT_MESSAGES_ALL);
      return { outcome: "refreshed" } as any;
    });
    // Scope to our far-future fixture so the tick never re-probes (and
    // never mutates) a real coverage row on the shared dev DB.
    const r = await runMessageGrainUpgradeTick({
      now: new Date(Date.UTC(Y, 6, 15)),
      month: `${Y}-01`,
    });
    assert.equal(r.candidateMonths, 1);
    const a = r.attempted.find((x) => x.month === `${Y}-01`)!;
    assert.equal(a.outcome, "upgraded");
    assert.equal(a.beforeUnit, "conversations_all");
    assert.equal(a.afterUnit, DENOMINATOR_UNIT_MESSAGES_ALL);
    // Persisted last-run summary reflects the tick.
    const last = await readLastMessageGrainUpgradeRun();
    assert.equal(last.status, "ok");
    assert.ok(last.lastRun && last.lastRun.enabled === true);
  });

  // ── 5. A month already at message grain (scoped) → already_message_
  //       grain, never re-probes. ─────────────────────────────────────
  await t.test("already message grain → already_message_grain", async () => {
    await setSystemSetting(SETTING_ENABLED, "true", "system");
    await setSystemSetting(REQUIRED_ENUM_SWITCH, "true", "system");
    let probed = false;
    H.setRefreshMonthOverride(async () => {
      probed = true;
      return { outcome: "refreshed" } as any;
    });
    // `${Y}-03` was seeded at message grain in test 1.
    const r = await runMessageGrainUpgradeTick({
      now: new Date(Date.UTC(Y, 6, 15)),
      month: `${Y}-03`,
    });
    const a = r.attempted.find((x) => x.month === `${Y}-03`)!;
    assert.equal(a.outcome, "already_message_grain");
    assert.equal(probed, false, "no re-probe for an already-message-grain row");
  });

  // ── 6. A `front_error` re-probe → outcome `error` with the code. ──
  await t.test("front_error re-probe → error with code", async () => {
    await setSystemSetting(SETTING_ENABLED, "true", "system");
    await setSystemSetting(REQUIRED_ENUM_SWITCH, "true", "system");
    H.setRefreshMonthOverride(async () => {
      // Does NOT flip the grain; reports a Front error.
      return { outcome: "front_error", errorCode: "rate_limited" } as any;
    });
    const r = await runMessageGrainUpgradeTick({
      now: new Date(Date.UTC(Y, 6, 15)),
      month: `${Y}-02`,
    });
    const a = r.attempted.find((x) => x.month === `${Y}-02`)!;
    assert.equal(a.outcome, "error");
    assert.equal(a.errorCode, "rate_limited");
    assert.equal(a.afterUnit, "inbound_conversations", "grain unchanged on error");
  });
});
