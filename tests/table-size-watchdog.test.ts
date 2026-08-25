/* test-registration
{
  "name": "Table-size watchdog: band breach alert, hysteresis, recovery, trend samples (Task #3814)",
  "smoke": true,
  "smokeReason": "Guards the table-growth alert wiring end-to-end (band breach, hysteresis, recovery, trend persistence); a regression means production tables regrow silently with no alert.",
  "tier": "small"
}
test-registration */
/**
 * Task #3814 — table-size watchdog (tableSizeWatchdog.ts).
 *
 * Asserts:
 *  - disabled gate: captureAndEvaluateOnce is a no-op while
 *    `table_size_watchdog_enabled` is false;
 *  - a covered table over its band dispatches `infra.database.table_growth`
 *    with the per-table dedupeKey (`table_growth:<table>`);
 *  - a size inside the hysteresis window (between 90% of band and band)
 *    neither alerts nor marks recovery — no flapping at the boundary;
 *  - a size under 90% of band calls markRecovered with the same dedupeKey;
 *  - band overrides via `table_size_watchdog_bands_mb` JSON are honored;
 *  - a REAL capture (sizes from pg_class, dispatcher still stubbed) inserts
 *    one table_size_samples trend row per covered table, and
 *    buildTableSizeTrendSummary surfaces them with band + over-band flags;
 *  - the notification id is registered (implemented) in the registry.
 *
 * Dispatcher and markRecovered are ALWAYS stubbed via the service's test
 * seams — dev-DB tables genuinely over their bands must not fire real
 * notifications from a test run. Settings pinned + restored in finally.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { storage } from "../server/storage";
import {
  NOTIFICATION_ID,
  REARM_FRACTION,
  captureAndEvaluateOnce,
  buildTableSizeTrendSummary,
  fetchTableSizes,
  __testHelpers,
  type TableSizeRow,
} from "../server/services/tableSizeWatchdog";
import {
  COVERED_TABLES,
  COVERED_TABLE_NAMES,
  TABLE_SIZE_BANDS_SETTING_KEY,
  TABLE_SIZE_WATCHDOG_ENABLED_KEY,
  resolveBandBytes,
} from "../server/services/tableMaintenancePolicy";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const MB = 1024 * 1024;

function sizeMap(totalByTable: Record<string, number>): Map<string, TableSizeRow> {
  const m = new Map<string, TableSizeRow>();
  for (const t of COVERED_TABLE_NAMES) {
    const totalBytes = totalByTable[t] ?? 1 * MB;
    m.set(t, {
      tableName: t,
      totalBytes,
      tableBytes: Math.floor(totalBytes * 0.7),
      indexBytes: Math.floor(totalBytes * 0.3),
      liveTuples: 100,
      deadTuples: 5,
    });
  }
  return m;
}

async function main(): Promise<void> {
  const prevEnabled = await storage.getSystemSetting(TABLE_SIZE_WATCHDOG_ENABLED_KEY);
  const prevBands = await storage.getSystemSetting(TABLE_SIZE_BANDS_SETTING_KEY);
  const notifyCalls: Array<{ id: string; text: string; options: any }> = [];
  const recoveredCalls: Array<{ id: string; dedupeKey: string }> = [];
  const realNow = Date.now();

  __testHelpers.setDispatcherForTests(async (id, payload, options) => {
    notifyCalls.push({ id, text: payload.text, options });
    return { delivered: true };
  });
  __testHelpers.setMarkRecoveredForTests(async (id, dedupeKey) => {
    recoveredCalls.push({ id, dedupeKey });
  });

  try {
    // ── disabled gate ──
    await storage.setSystemSetting(TABLE_SIZE_WATCHDOG_ENABLED_KEY, "false", "test");
    __testHelpers.setSizesForTests((tables) => sizeMap({}));
    let out = await captureAndEvaluateOnce();
    assert(!out.ran && out.skippedReason === "disabled", "no-op while disabled");
    assert(notifyCalls.length === 0, "no dispatch while disabled");

    // ── enable + clear band overrides for deterministic defaults ──
    await storage.setSystemSetting(TABLE_SIZE_WATCHDOG_ENABLED_KEY, "true", "test");
    await storage.setSystemSetting(TABLE_SIZE_BANDS_SETTING_KEY, "{}", "test");

    const wqBand = resolveBandBytes("work_queue", "{}");
    assert(wqBand > 0, "work_queue has a declared default band");

    // ── breach: work_queue over band → alert with per-table dedupeKey ──
    __testHelpers.setSizesForTests(() => sizeMap({ work_queue: wqBand + 50 * MB }));
    out = await captureAndEvaluateOnce();
    assert(out.ran, "watchdog ran once enabled");
    const wqEval = out.evaluations.find((e) => e.table === "work_queue");
    assert(wqEval?.decision === "alerted", `work_queue over band alerts (got ${wqEval?.decision})`);
    assert(notifyCalls.length === 1, "exactly one dispatch for the single over-band table");
    assert(notifyCalls[0].id === NOTIFICATION_ID, "dispatched under infra.database.table_growth");
    assert(
      notifyCalls[0].options?.dedupeKey === "table_growth:work_queue",
      "dedupeKey is per-table",
    );
    assert(
      /work_queue/.test(notifyCalls[0].text) && /band/i.test(notifyCalls[0].text),
      "alert text names the table and the band",
    );
    // All other tables were tiny (1 MB) → they recovered (markRecovered
    // no-ops when already healthy), never alerted.
    assert(
      out.evaluations.filter((e) => e.decision === "alerted").length === 1,
      "only the over-band table alerted",
    );

    // ── hysteresis: between re-arm level and band → no alert, no recovery ──
    notifyCalls.length = 0;
    recoveredCalls.length = 0;
    const midBand = Math.floor(wqBand * (REARM_FRACTION + 1) / 2); // 95% of band
    __testHelpers.setSizesForTests(() => sizeMap({ work_queue: midBand }));
    out = await captureAndEvaluateOnce();
    const wqMid = out.evaluations.find((e) => e.table === "work_queue");
    assert(
      wqMid?.decision === "in_hysteresis_band",
      `95%-of-band sits in hysteresis (got ${wqMid?.decision})`,
    );
    assert(
      notifyCalls.every((c) => c.options?.dedupeKey !== "table_growth:work_queue"),
      "no alert inside hysteresis",
    );
    assert(
      recoveredCalls.every((c) => c.dedupeKey !== "table_growth:work_queue"),
      "no recovery inside hysteresis",
    );

    // ── recovery: under 90% of band → markRecovered with same dedupeKey ──
    recoveredCalls.length = 0;
    __testHelpers.setSizesForTests(() => sizeMap({ work_queue: Math.floor(wqBand * 0.5) }));
    out = await captureAndEvaluateOnce();
    assert(
      recoveredCalls.some(
        (c) => c.id === NOTIFICATION_ID && c.dedupeKey === "table_growth:work_queue",
      ),
      "markRecovered called once size drops under the re-arm level",
    );

    // ── band override honored ──
    notifyCalls.length = 0;
    await storage.setSystemSetting(
      TABLE_SIZE_BANDS_SETTING_KEY,
      JSON.stringify({ work_queue: 1 }), // 1 MB band
      "test",
    );
    __testHelpers.setSizesForTests(() => sizeMap({ work_queue: 10 * MB }));
    out = await captureAndEvaluateOnce();
    assert(
      out.evaluations.find((e) => e.table === "work_queue")?.decision === "alerted",
      "10 MB table alerts against a 1 MB override band",
    );
    assert(
      resolveBandBytes("work_queue", JSON.stringify({ work_queue: 1 })) === 1 * MB,
      "resolveBandBytes applies the JSON override",
    );
    assert(
      resolveBandBytes("work_queue", "not-json") === wqBand,
      "malformed override JSON falls back to the default band",
    );
    await storage.setSystemSetting(TABLE_SIZE_BANDS_SETTING_KEY, "{}", "test");

    // ── REAL capture: sizes from pg_class, trend rows persisted ──
    __testHelpers.setSizesForTests(null); // real fetch; dispatcher still stubbed
    const captureStamp = realNow - 1234; // unique sampled_at for cleanup
    out = await captureAndEvaluateOnce(captureStamp);
    assert(out.ran, "real capture ran");
    assert(out.sampled >= 5, `real capture sampled covered tables (got ${out.sampled})`);
    const inserted = await getDb().execute<any>(
      sql`SELECT table_name, total_bytes FROM table_size_samples WHERE sampled_at = ${captureStamp}`,
    );
    assert(
      inserted.rows.length === out.sampled,
      "one trend row persisted per sampled covered table",
    );
    assert(
      inserted.rows.every((r: any) => COVERED_TABLE_NAMES.includes(String(r.table_name))),
      "trend rows only cover policy tables",
    );
    assert(
      inserted.rows.some((r: any) => Number(r.total_bytes) > 0),
      "real sizes are non-zero",
    );

    // Direct real-size read agrees with the sampler's source.
    const real = await fetchTableSizes(["work_queue"]);
    assert((real.get("work_queue")?.totalBytes ?? 0) > 0, "fetchTableSizes reads real sizes");

    // ── trend summary for the admin tab ──
    const summary = await buildTableSizeTrendSummary(60 * 60_000);
    assert(summary.enabled === true, "summary reflects the enabled setting");
    assert(
      summary.tables.length === COVERED_TABLES.length,
      "summary has one entry per covered table",
    );
    const wqEntry = summary.tables.find((t) => t.table === "work_queue");
    assert(wqEntry?.latest !== null, "work_queue entry carries the fresh sample");
    assert(typeof wqEntry?.bandMb === "number" && wqEntry.bandMb > 0, "entry exposes its band");
    assert(
      typeof wqEntry?.retentionNote === "string" && wqEntry.retentionNote.length > 0,
      "entry exposes its retention note",
    );

    // ── registry entry ──
    const { NOTIFICATION_REGISTRY } = await import("../server/services/notifications/registry");
    const entry = (NOTIFICATION_REGISTRY as any[]).find((t) => t.id === NOTIFICATION_ID);
    assert(entry, "infra.database.table_growth registered");
    assert(entry.implemented === true, "registry entry marked implemented");

    console.log("table-size-watchdog.test.ts: ALL PASSED");
  } finally {
    __testHelpers.setSizesForTests(null);
    __testHelpers.setDispatcherForTests(null);
    __testHelpers.setMarkRecoveredForTests(null);
    const { deleteSystemSetting } = await import("../server/storage/settingsStorage");
    if (prevEnabled) {
      await storage.setSystemSetting(TABLE_SIZE_WATCHDOG_ENABLED_KEY, prevEnabled.value, "test");
    } else {
      await deleteSystemSetting(TABLE_SIZE_WATCHDOG_ENABLED_KEY);
    }
    if (prevBands) {
      await storage.setSystemSetting(TABLE_SIZE_BANDS_SETTING_KEY, prevBands.value, "test");
    } else {
      await deleteSystemSetting(TABLE_SIZE_BANDS_SETTING_KEY);
    }
    await getDb().execute(
      sql`DELETE FROM table_size_samples WHERE sampled_at = ${realNow - 1234}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("table-size-watchdog.test.ts FAILED:", err);
    process.exit(1);
  });
