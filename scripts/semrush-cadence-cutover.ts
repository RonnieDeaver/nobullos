/**
 * Task #1785 — SEMrush demand-driven cadence cutover.
 *
 * Idempotent helper that:
 *   1. Flips the three feature kill switches ON (no-op if already ON).
 *   2. Sets the cadence `system_settings` to their documented defaults
 *      (only when missing — never clobbers an operator override).
 *   3. Unpauses `semrush_background_refresh` and `semrush_report_refresh`
 *      via the canonical queueDrainControl helpers.
 *
 * Default: dry-run. Pass `--apply` to commit.
 *
 * Usage:
 *   npx tsx scripts/semrush-cadence-cutover.ts            # dry-run
 *   npx tsx scripts/semrush-cadence-cutover.ts --apply    # commit
 */
import { storage } from "../server/storage";
import { setQueuePause } from "../server/services/queueDrainControl";

const APPLY = process.argv.includes("--apply");
const ACTOR = "cadence-cutover-script";

const KILL_SWITCH_KEYS = [
  "semrush_demand_driven_refresh",
  "semrush_auto_retry_backoff",
  "semrush_identical_result_apply_suppression",
];

const SETTING_DEFAULTS: Array<{ key: string; value: string }> = [
  { key: "semrush_background_refresh_interval_ms", value: String(12 * 60 * 60_000) },
  { key: "semrush_refresh_staleness_threshold_hours", value: "24" },
  { key: "semrush_active_client_window_days", value: "14" },
];

const QUEUES_TO_RESUME = ["semrush_background_refresh", "semrush_report_refresh"];

async function main() {
  console.log(`[cadence-cutover] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // 1. Kill switches.
  for (const key of KILL_SWITCH_KEYS) {
    const settingKey = `kill_switch_${key}`;
    const existing = await storage.getSystemSettings([settingKey]);
    const current = existing[settingKey];
    const desired = "true";
    if (current === desired) {
      console.log(`  switch  ${key} = already ON`);
      continue;
    }
    console.log(`  switch  ${key} : ${current ?? "unset"} → ${desired}`);
    if (APPLY) await storage.setSystemSetting(settingKey, desired, ACTOR);
  }

  // 2. Cadence settings — only set when missing.
  const existing = await storage.getSystemSettings(SETTING_DEFAULTS.map((s) => s.key));
  for (const { key, value } of SETTING_DEFAULTS) {
    if (existing[key]) {
      console.log(`  setting ${key} = ${existing[key]} (kept)`);
      continue;
    }
    console.log(`  setting ${key} = (unset) → ${value}`);
    if (APPLY) await storage.setSystemSetting(key, value, ACTOR);
  }

  // 3. Resume the two SEMrush queues.
  for (const q of QUEUES_TO_RESUME) {
    console.log(`  resume  ${q}`);
    if (APPLY) {
      try {
        await setQueuePause(q, false, ACTOR);
      } catch (err: any) {
        console.warn(`    resume failed: ${err?.message}`);
      }
    }
  }

  console.log(`[cadence-cutover] done`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[cadence-cutover] fatal:", err);
  process.exit(1);
});
