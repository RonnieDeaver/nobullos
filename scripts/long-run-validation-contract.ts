import { isAbsolute } from "node:path";

export const LONG_RUN_SCHEMA_VERSION = 1;

export type LongRunProfile =
  | "routine-gate"
  | "focused-test"
  | "full-control"
  | "matched-comparison";
export type FullControl = "serial" | "static-4" | "dynamic-4";

export interface LongRunRequest {
  schemaVersion: typeof LONG_RUN_SCHEMA_VERSION;
  profile: LongRunProfile;
  files?: string[];
  control?: FullControl;
  label?: string;
}

/**
 * Task #5292 — `full-control` and `matched-comparison` are main-workspace
 * central-integrity actions: they exercise the full test universe, capture
 * matched evidence, and (for `full-control`) are the reviewed operator path
 * for explicitly requested central controls. A task/sub-environment must
 * never be able to select them, even via an otherwise valid request file or
 * inherited environment values — `focused-test` and `routine-gate` remain
 * available everywhere. All requested canonical gates use this durable
 * workflow rather than a foreground validation role.
 */
export const MAIN_WORKSPACE_ONLY_PROFILES: ReadonlySet<LongRunProfile> = new Set([
  "full-control",
  "matched-comparison",
]);

/**
 * Fail-closed profile/environment gate. Pure function: callers supply the
 * already-detected `isSubEnvironment` signal (see
 * `server/lib/subEnvironment.ts`) rather than this module reaching out to
 * detect it itself, keeping the request contract dependency-light and
 * directly testable with injected signals.
 */
export function assertProfileAllowedInEnvironment(
  profile: LongRunProfile,
  isSubEnvironment: boolean,
): void {
  if (isSubEnvironment && MAIN_WORKSPACE_ONLY_PROFILES.has(profile)) {
    throw new Error(
      `Profile "${profile}" is a main-workspace central-integrity control and is not available in a task/sub-environment. Use "focused-test" or "routine-gate" instead.`,
    );
  }
}

export interface StageDefinition {
  name: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
  reports: string[];
  privateTestReport: boolean;
  isolatedWorkspace: boolean;
  expectedFiles?: string[];
  requireExecutedResults: boolean;
}

interface ProfileDefinition {
  stages: (request: LongRunRequest) => StageDefinition[];
  requiresGitRevision: boolean;
}

const TEST_REPORT = ".local/runs/suite-durations.json";
const CONTROL_ENV = {
  TEST_SMOKE: "1",
  TEST_FORCE_ALL: "1",
  TEST_FULL_DEFERRAL: "0",
  TEST_DYNAMIC_SHARDS: "0",
  TEST_FILE_TIMEOUT_MS: "180000",
};

export const PROFILE_DEFINITIONS: Record<LongRunProfile, ProfileDefinition> = {
  "routine-gate": {
    requiresGitRevision: true,
    stages: () => [
      {
        name: "routine-gate",
        args: ["run", "gate"],
        env: {},
        timeoutMs: 60 * 60_000,
        reports: [".local/runs/gate-timings.json", TEST_REPORT],
        privateTestReport: false,
        isolatedWorkspace: true,
        requireExecutedResults: false,
      },
    ],
  },
  "focused-test": {
    requiresGitRevision: false,
    stages: (request) => [
      {
        name: "focused-test",
        args: ["test", "--", `--file=${request.files!.join(",")}`],
        env: {},
        timeoutMs: 30 * 60_000,
        reports: [],
        privateTestReport: true,
        isolatedWorkspace: false,
        expectedFiles: request.files!,
        requireExecutedResults: false,
      },
    ],
  },
  "full-control": {
    requiresGitRevision: true,
    stages: (request) => [controlStage(request.control!)],
  },
  "matched-comparison": {
    requiresGitRevision: true,
    stages: () => [controlStage("static-4"), controlStage("dynamic-4")],
  },
};

function controlStage(control: FullControl): StageDefinition {
  const args = ["test", "--", "--full-smoke"];
  const env = { ...CONTROL_ENV };
  if (control === "serial") args.push("--serial");
  if (control === "static-4") args.push("--shards=4");
  if (control === "dynamic-4") {
    args.push("--shards=4", "--dynamic-shards");
    env.TEST_DYNAMIC_SHARDS = "1";
  }
  return {
    name: `control-${control}`,
    args,
    env,
    timeoutMs: 2 * 60 * 60_000,
    reports: [],
    privateTestReport: true,
    isolatedWorkspace: false,
    requireExecutedResults: true,
  };
}

export function validateLongRunRequest(value: unknown):
  | { ok: true; request: LongRunRequest }
  | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "request must be a JSON object" };
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "profile", "files", "control", "label"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    return { ok: false, error: "request contains unsupported fields" };
  }
  if (raw.schemaVersion !== LONG_RUN_SCHEMA_VERSION) {
    return { ok: false, error: `schemaVersion must be ${LONG_RUN_SCHEMA_VERSION}` };
  }
  if (
    raw.profile !== "routine-gate" &&
    raw.profile !== "focused-test" &&
    raw.profile !== "full-control" &&
    raw.profile !== "matched-comparison"
  ) {
    return { ok: false, error: "profile is not allowlisted" };
  }
  if (
    raw.label !== undefined &&
    (typeof raw.label !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(raw.label))
  ) {
    return { ok: false, error: "label must be a short alphanumeric slug" };
  }
  const request: LongRunRequest = {
    schemaVersion: LONG_RUN_SCHEMA_VERSION,
    profile: raw.profile,
    ...(raw.label ? { label: raw.label } : {}),
  };
  if (raw.profile === "focused-test") {
    if (!Array.isArray(raw.files) || raw.files.length < 1 || raw.files.length > 20) {
      return { ok: false, error: "focused-test requires 1 to 20 test files" };
    }
    if (
      raw.files.some(
        (file) =>
          typeof file !== "string" ||
          !isSafeTestPath(file) ||
          !/\.(test\.ts|test\.tsx)$/.test(file),
      )
    ) {
      return { ok: false, error: "focused-test files must be safe registered test paths" };
    }
    request.files = [...new Set(raw.files)].sort();
    if (request.files.length !== raw.files.length) {
      return { ok: false, error: "focused-test files must not contain duplicates" };
    }
  } else if (raw.files !== undefined) {
    return { ok: false, error: "files are supported only for focused-test" };
  }
  if (raw.profile === "full-control") {
    if (
      raw.control !== "serial" &&
      raw.control !== "static-4" &&
      raw.control !== "dynamic-4"
    ) {
      return { ok: false, error: "full-control requires an allowlisted control" };
    }
    request.control = raw.control;
  } else if (raw.control !== undefined) {
    return { ok: false, error: "control is supported only for full-control" };
  }
  return { ok: true, request };
}

function isSafeTestPath(path: string): boolean {
  return (
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").includes("..") &&
    (path.startsWith("tests/") || path.startsWith("client/src/"))
  );
}