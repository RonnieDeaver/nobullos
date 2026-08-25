// @cross-instance-safe: idempotent, log-only nightly scan (jittered); duplicate runs are harmless by design.
/**
 * Task #1724 Phase 4.4 — In-process nightly scheduler for the
 * `pg_stat_statements` regression scan.
 *
 * Companion to `scripts/pg-stat-statements-regression.ts`. The script
 * is the canonical entry point (designed to be runnable from a thin
 * nightly container), but a hosted deployment without external cron
 * still needs the scan to fire on a cadence — this scheduler is that
 * cadence, spawning the script as a child process exactly once per
 * `INTERVAL_MS` and letting it own the actual scan logic.
 *
 * **Default ON.** The scheduler runs in every long-lived process by
 * default. Set `PG_STAT_STATEMENTS_REGRESSION_SCHEDULER_ENABLED=false`
 * to opt out (e.g. an operator using external cron, or a one-shot
 * script process). The scan itself is a no-op when:
 *
 *   - `pg_stat_statements` isn't installed (script exits 0 with a
 *     log line — see `PROD_REMEDIATION.md` for the one-time setup);
 *   - the baseline is empty (script exits 0; first run uses
 *     `--update-baseline` to seed);
 *   - `QUEUE_HEALTH_SLACK_CHANNEL` / `SLACK_BOT_TOKEN` are unset
 *     (script logs the top regressions but doesn't post).
 *
 * That graceful no-op behavior is why default-ON is safe: a process
 * that isn't ready to scan simply logs and exits.
 */
import { spawn } from "node:child_process";
import { withDbAttribution } from "../db";

// Once every 24h. Add a small jitter so a multi-replica deploy doesn't
// have every instance fire at the same wall-clock minute. The script
// is idempotent so duplicate runs are harmless — the jitter is purely
// to spread the load on `pg_stat_statements`.
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const JITTER_MS = 5 * 60 * 1000;

let interval: ReturnType<typeof setInterval> | null = null;
let lastRunAt: number | null = null;
let lastExitCode: number | null = null;

function isEnabled(): boolean {
  // Default ON. Explicit "false" / "0" / "off" opts out.
  const raw = (
    process.env.PG_STAT_STATEMENTS_REGRESSION_SCHEDULER_ENABLED ?? ""
  )
    .trim()
    .toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") {
    return false;
  }
  return true;
}

function runOnce(): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    lastRunAt = started;
    const child = spawn(
      "npx",
      ["--yes", "tsx", "scripts/pg-stat-statements-regression.ts"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
    child.stdout?.on("data", (buf) => {
      process.stdout.write(`[PgStatStatementsRegression] ${buf}`);
    });
    child.stderr?.on("data", (buf) => {
      process.stderr.write(`[PgStatStatementsRegression] ${buf}`);
    });
    child.on("exit", (code) => {
      lastExitCode = code ?? -1;
      const durSec = Math.round((Date.now() - started) / 1000);
      console.log(
        `[PgStatStatementsRegression] tick finished exit=${lastExitCode} duration=${durSec}s`,
      );
      resolve();
    });
    child.on("error", (err) => {
      console.warn(
        `[PgStatStatementsRegression] tick failed to spawn: ${err?.message ?? err}`,
      );
      resolve();
    });
  });
}

export function startPgStatStatementsRegressionScheduler(): void {
  if (interval) return;
  if (!isEnabled()) {
    console.log(
      "[PgStatStatementsRegression] scheduler disabled by " +
        "PG_STAT_STATEMENTS_REGRESSION_SCHEDULER_ENABLED",
    );
    return;
  }
  const jitter = Math.floor(Math.random() * JITTER_MS);
  // Defer the first tick by a full interval + jitter so a process
  // that restarts every few hours doesn't re-spawn the scan on every
  // boot. Operators who want an immediate run can invoke the script
  // by hand.
  interval = setInterval(() => {
    void withDbAttribution(
      "scheduler:pg-stat-statements-regression",
      async () => {
        await runOnce();
      },
    );
  }, INTERVAL_MS + jitter);
  console.log(
    `[PgStatStatementsRegression] scheduler started (interval=${(INTERVAL_MS + jitter) / 3600000}h)`,
  );
}

export function stopPgStatStatementsRegressionScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

/** Test-only / ops-only introspection. */
export function getPgStatStatementsRegressionSchedulerState(): {
  running: boolean;
  lastRunAt: number | null;
  lastExitCode: number | null;
} {
  return { running: !!interval, lastRunAt, lastExitCode };
}
