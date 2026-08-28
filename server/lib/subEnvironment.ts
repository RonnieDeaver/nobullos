/**
 * Task #4530 / Task #5292 — structural sub-environment (task workspace)
 * detection.
 *
 * Extracted from `server/services/regressionSweepScheduler.ts` into its own
 * dependency-light module so callers that must NOT pull in the full server
 * dependency graph (database pools, notification services, cron, …) can
 * still reuse the exact same fail-closed classifier. Notably
 * `scripts/long-run-validation.ts` runs as a standalone CLI wrapper and must
 * never import `../db` transitively just to ask "is this a task
 * environment?".
 *
 * The publisher opt-in flag alone cannot be "main workspace only": Replit
 * Secrets and shared env vars both propagate into task-branch environments,
 * so a flag set on main is visible in every clone. Two structural signals
 * distinguish the environments regardless of env-var inheritance:
 *
 *  1. REPL_ID shape — task environments run under a sub-scoped repl id of the
 *     form "<uuid>:<subid>"; the main workspace has a bare "<uuid>".
 *  2. The `main-repl` git remote — task environments carry a remote named
 *     `main-repl` (the completion-rebase target). The main workspace has no
 *     such remote (it IS the main repl).
 *
 * Fail-closed: when signals are missing or git cannot answer, we classify as
 * sub-environment. A wrong "sub-env" answer on main only blocks a workspace
 * central control or the sweep publisher — both loudly reported (a refused
 * long-control request, or the staleness watchdog alarm within a day) rather
 * than silently corrupting or unblocking something.
 *
 * This module intentionally imports nothing beyond `node:child_process`.
 * Do not add a database, notification, or other server-graph import here —
 * that would defeat the reason it was split out of
 * `regressionSweepScheduler.ts` in the first place.
 */
import { spawnSync } from "node:child_process";

export interface MainReplRemoteProbe {
  /** spawnSync status: 0 = remote present, 1 = key absent, other/null = git error. */
  status: number | null;
  stdout: string;
}

export function classifySubEnvironment(
  replId: string | undefined,
  mainReplProbe: MainReplRemoteProbe,
): boolean {
  const id = (replId ?? "").trim();
  if (id === "" || id.includes(":")) return true; // missing/sub-scoped id → sub-env (fail closed)
  if (mainReplProbe.status === 0 && mainReplProbe.stdout.trim().length > 0) {
    return true; // main-repl remote present → task environment
  }
  if (mainReplProbe.status === 1) return false; // key absent → main workspace
  return true; // git error / unknown → fail closed (sub-environment)
}

let cachedIsSubEnvironment: boolean | null = null;

/**
 * Cached real-signal detection. Sub-environment-ness cannot change within a
 * process lifetime, so the git probe runs at most once per process.
 */
export function detectSubEnvironment(): boolean {
  if (cachedIsSubEnvironment === null) {
    cachedIsSubEnvironment = classifySubEnvironment(
      process.env.REPL_ID,
      probeMainReplRemote(),
    );
  }
  return cachedIsSubEnvironment;
}

/** Reset seam for test suites sharing a process — see moduleStateReset.ts. */
export function __resetSubEnvironmentCacheForTest(): void {
  cachedIsSubEnvironment = null;
}

function probeMainReplRemote(): MainReplRemoteProbe {
  try {
    const probe = spawnSync("git", ["config", "--get", "remote.main-repl.url"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { status: probe.status, stdout: probe.stdout ?? "" };
  } catch {
    return { status: null, stdout: "" }; // classify() fails closed on null
  }
}
