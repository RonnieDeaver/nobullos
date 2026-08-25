/**
 * Conservative process-sharing policy for run-all batch workers.
 *
 * A suite may share a warm child only when its process-start contract is
 * already provided by the worker. In particular, loader/import arguments stay
 * solo: they run before the worker can receive an IPC message, and Task #1305
 * owns any future shared module-mocking contract.
 */

export interface BatchWorkerSuiteDefinition {
  file: string;
  extraNodeArgs?: string[];
  extraEnv?: Record<string, string>;
}

export type BatchCompatibility =
  | { batchable: true; key: string }
  | { batchable: false; reason: "process-start-arguments" };

/**
 * Derive a deterministic compatibility key from the child configuration that
 * can differ between suites. Values the runner itself always injects are
 * normalized away, allowing declarations that are operationally identical to
 * share the same existing batch-worker path.
 */
export function batchCompatibilityForSuite(
  suite: BatchWorkerSuiteDefinition,
): BatchCompatibility {
  if ((suite.extraNodeArgs?.length ?? 0) > 0) {
    return { batchable: false, reason: "process-start-arguments" };
  }

  const env = { ...(suite.extraEnv ?? {}) };
  // Both solo and batch paths unconditionally set these before suite-provided
  // env is spread. Removing only equal values preserves every effective child
  // environment while joining redundant declarations to the default class.
  if (env.NODE_ENV === "test") delete env.NODE_ENV;
  if (suite.file.endsWith(".tsx") && env.TSX_TSCONFIG_PATH === "./tsconfig.tests.json") {
    delete env.TSX_TSCONFIG_PATH;
  }

  return {
    batchable: true,
    key: JSON.stringify({
      env: Object.entries(env).sort(([left], [right]) => left.localeCompare(right)),
      tsconfig: suite.file.endsWith(".tsx") ? "tests-tsx" : "default",
    }),
  };
}

export type BatchRecycleCause = "hard-cap" | "resource-pressure";

/** The hard cap is always retained even when the resource signal is quiet. */
export function recycleBeforeDispatch(
  ranSuites: number,
  maxSuites: number,
): BatchRecycleCause | null {
  return ranSuites >= maxSuites ? "hard-cap" : null;
}

/** A worker reports this after a completed suite, before the next dispatch. */
export function recycleAfterResult(resourcePressure: boolean): BatchRecycleCause | null {
  return resourcePressure ? "resource-pressure" : null;
}