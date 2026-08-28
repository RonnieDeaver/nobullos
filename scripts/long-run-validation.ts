/**
 * Long-running validation runner.
 *
 * This is deliberately an invocation and evidence wrapper around existing
 * commands. It neither changes gate/test-runner behavior nor accepts arbitrary
 * command strings. Operators select a small reviewed profile in a strict JSON
 * request, then start the permanent "Long validation" console workflow. This
 * is the sole managed workflow path for an explicitly requested canonical
 * gate; routine task completion does not invoke a repository harness.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  LONG_RUN_SCHEMA_VERSION,
  MAIN_WORKSPACE_ONLY_PROFILES,
  PROFILE_DEFINITIONS,
  assertProfileAllowedInEnvironment,
  validateLongRunRequest,
  type LongRunProfile,
  type StageDefinition,
} from "./long-run-validation-contract";
import { detectSubEnvironment } from "../server/lib/subEnvironment";

export * from "./long-run-validation-contract";

export const LONG_RUNS_DIR = ".local/runs/long-validation";
export const DEFAULT_REQUEST_PATH = ".local/runs/long-validation-request.json";
export const LONG_RUN_EVENT_FILE = "events.jsonl";
export const LONG_RUN_INDEX_FILE = "index.json";
/** Owner-approved evidence window: never evict a completed run younger than this. */
export const LONG_RUN_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const LONG_RUN_MAX_COMPLETED = 20;
export const LONG_RUN_MAX_BYTES = 256 * 1024 * 1024;
export const LONG_RUN_INDEX_MAX_RECORDS = 100;
const LOCK_FILE = ".active-lock.json";
const LOCK_OWNER_FILE = "owner.json";
const LOCK_RECOVERY_SUFFIX = ".recovery";
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;
const SIGNAL_GRACE_MS = 10_000;
const MAX_PARTIAL_LOG_LINE = 64 * 1024;
const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(4));

export type ChildOutcome =
  | { kind: "exited"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { kind: "timed-out"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { kind: "cancelled"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { kind: "killed"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { kind: "spawn-error"; exitCode: null; signal: null };

export type LongRunLifecycleState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted";

export type LongRunCleanupDisposition =
  | "retained"
  | "deleted"
  | "not-eligible"
  | "cleanup-failed";

export interface LongRunLifecycleEvent {
  schemaVersion: 1;
  sequence: number;
  at: string;
  runId: string;
  state: LongRunLifecycleState;
  stage?: string;
  reason?: string;
  outcome?: ChildOutcome["kind"];
}

export interface LongRunIndexRecord {
  runId: string;
  profile: LongRunProfile;
  label?: string;
  lifecycleState: LongRunLifecycleState;
  status: LongRunManifest["status"];
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  interruptionReason?: LongRunManifest["interruptionReason"];
  stages: Array<{
    name: string;
    status: LongRunManifest["stages"][number]["status"];
    durationMs?: number;
    outcome?: ChildOutcome["kind"];
  }>;
  cleanup: {
    disposition: LongRunCleanupDisposition;
    updatedAt: string;
    reason?: string;
  };
}

interface LongRunIndex {
  schemaVersion: 1;
  records: LongRunIndexRecord[];
}

export interface LongRunManifest {
  schemaVersion: 1;
  runId: string;
  profile: LongRunProfile;
  status: "queued" | "running" | "passed" | "failed" | "cancelled";
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  interruptionReason?:
    | ChildOutcome["kind"]
    | "source-changed"
    | "missing-report"
    | "stale-lock-recovered"
    | "lock-unavailable";
  source: {
    commit: string | null;
    tree: string | null;
    workingTreeHash: string;
  };
  profileDefinitionHash: string;
  stages: Array<{
    name: string;
    status: "pending" | "running" | "passed" | "failed";
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    outcome?: ChildOutcome;
    reports: Array<{ name: string; sha256: string }>;
  }>;
}

interface LockRecord {
  schemaVersion: 1;
  pid: number;
  createdAt: string;
  runId: string;
}

export interface RunResult {
  runDir: string;
  manifest: LongRunManifest;
}

export interface RunHandle {
  done: Promise<RunResult>;
  cancel(signal?: NodeJS.Signals): void;
}

export interface LongRunDependencies {
  rootDir?: string;
  now?: () => Date;
  executeStage?: (
    stage: StageDefinition,
    context: { rootDir: string; logPath: string; signal: AbortSignal },
  ) => Promise<ChildOutcome>;
  /**
   * Task #5292 injection seam for tests. Production callers omit this and
   * get real structural detection (`server/lib/subEnvironment.ts`).
   */
  isSubEnvironment?: boolean;
}

export interface LongRunCleanupOptions {
  rootDir?: string;
  now?: () => Date;
  maxAgeMs?: number;
  maxCompleted?: number;
  maxBytes?: number;
  activeRunId?: string;
  dryRun?: boolean;
}

export interface LongRunCleanupReport {
  dryRun: boolean;
  eligibleRunIds: string[];
  deletedRunIds: string[];
  retainedRunIds: string[];
  notEligibleRunIds: string[];
  unsafeEntries: string[];
  bytesFreed: number;
  protectedOverage: boolean;
  errors: string[];
}

export function startLongRunValidation(
  requestValue: unknown,
  dependencies: LongRunDependencies = {},
): RunHandle {
  const controller = new AbortController();
  const done = runLongValidation(requestValue, controller.signal, dependencies);
  return {
    done,
    cancel: (signal = "SIGTERM") => controller.abort(signal),
  };
}

export async function runLongValidation(
  requestValue: unknown,
  signal?: AbortSignal,
  dependencies: LongRunDependencies = {},
): Promise<RunResult> {
  const validated = validateLongRunRequest(requestValue);
  if (!validated.ok) throw new Error(`Invalid long-run request: ${validated.error}`);
  // Task #5292 — refuse a main-workspace-only profile before anything else
  // runs: no source capture, run directory, lock, or child process. Only
  // resolve the (git-probing) real detector when the profile actually needs
  // it, so focused-test/routine-gate behavior and cost are unchanged.
  if (MAIN_WORKSPACE_ONLY_PROFILES.has(validated.request.profile)) {
    const isSubEnvironment = dependencies.isSubEnvironment ?? detectSubEnvironment();
    assertProfileAllowedInEnvironment(validated.request.profile, isSubEnvironment);
  }
  const rootDir = resolve(dependencies.rootDir ?? process.cwd());
  const now = dependencies.now ?? (() => new Date());
  const profile = PROFILE_DEFINITIONS[validated.request.profile];
  const source = captureSource(rootDir);
  if (profile.requiresGitRevision && !source.commit) {
    throw new Error("Control profiles require a captured Git source revision");
  }
  const runId = buildRunId(now());
  const runsDir = resolve(rootDir, LONG_RUNS_DIR);
  const runDir = allocateRunDirectory(runsDir, runId);
  const lockPath = join(runsDir, LOCK_FILE);
  const stages = profile.stages(validated.request);
  const manifest: LongRunManifest = {
    schemaVersion: 1,
    runId,
    profile: validated.request.profile,
    status: "queued",
    startedAt: now().toISOString(),
    updatedAt: now().toISOString(),
    source,
    profileDefinitionHash: sha256(JSON.stringify(stages.map((stage) => ({
      name: stage.name,
      args: stage.args,
      env: stage.env,
      timeoutMs: stage.timeoutMs,
      reports: stage.reports,
      privateTestReport: stage.privateTestReport,
      isolatedWorkspace: stage.isolatedWorkspace,
      expectedFiles: stage.expectedFiles,
      requireExecutedResults: stage.requireExecutedResults,
    })))),
    stages: stages.map((stage) => ({
      name: stage.name,
      status: "pending",
      reports: [],
    })),
  };
  let lockHeld = false;
  try {
    writeJsonAtomic(join(runDir, "request.json"), validated.request);
    writeJsonAtomic(join(runDir, "source.json"), source);
    writeManifest(runDir, manifest);
    appendLifecycleEvent(runDir, {
      at: now().toISOString(),
      runId,
      state: "queued",
    });
    acquireLock(lockPath, { schemaVersion: 1, pid: process.pid, createdAt: now().toISOString(), runId }, now);
    lockHeld = true;
    manifest.status = "running";
    manifest.updatedAt = now().toISOString();
    writeManifest(runDir, manifest);
    appendLifecycleEvent(runDir, {
      at: now().toISOString(),
      runId,
      state: "running",
    });
    syncLongRunIndex(rootDir, manifest, "running", "retained", now());

    for (let index = 0; index < stages.length; index++) {
      const stage = stages[index];
      const result = manifest.stages[index];
      if (signal?.aborted) {
        result.status = "failed";
        result.outcome = {
          kind: "cancelled",
          exitCode: null,
          signal: isSignal(signal.reason) ? signal.reason : null,
        };
        manifest.status = "cancelled";
        manifest.interruptionReason = "cancelled";
        break;
      }
      result.status = "running";
      result.startedAt = now().toISOString();
      manifest.updatedAt = now().toISOString();
      writeManifest(runDir, manifest);
      appendLifecycleEvent(runDir, {
        at: now().toISOString(),
        runId,
        state: "running",
        stage: stage.name,
      });
      const stageDir = join(runDir, "stages", `${String(index + 1).padStart(2, "0")}-${stage.name}`);
      mkdirSync(stageDir, { recursive: true, mode: 0o700 });
      const logPath = join(stageDir, "raw.log");
      const startedMs = Date.now();
      const executionRoot = stage.isolatedWorkspace
        ? prepareIsolatedWorkspace(rootDir, join(stageDir, "workspace"), source)
        : rootDir;
      const privateTestReportPath = relative(
        executionRoot,
        join(stageDir, "raw-test-report.json"),
      );
      const runtimeStage = stage.privateTestReport
        ? {
            ...stage,
            env: {
              ...stage.env,
              TEST_TASK_GATE_SWEEP_REPORT_PATH: privateTestReportPath,
            },
            reports: [privateTestReportPath],
          }
        : stage;
      const before = snapshotReports(executionRoot, runtimeStage.reports);
      const outcome = await (dependencies.executeStage ?? executeStageProcess)(runtimeStage, {
        rootDir: executionRoot,
        logPath,
        signal: signal ?? new AbortController().signal,
      });
      result.finishedAt = now().toISOString();
      result.durationMs = Math.max(0, Date.now() - startedMs);
      result.outcome = outcome;
      result.reports = copyFreshReports(
        executionRoot,
        stageDir,
        runtimeStage,
        before,
        startedMs,
        Date.now(),
      );
      const missingReport = result.reports.length !== runtimeStage.reports.length;
      const finalSource = captureSource(rootDir);
      const finalExecutionSource = captureSource(executionRoot);
      const sourceChanged =
        finalSource.workingTreeHash !== source.workingTreeHash ||
        finalSource.commit !== source.commit ||
        finalExecutionSource.workingTreeHash !== source.workingTreeHash ||
        finalExecutionSource.commit !== source.commit;
      if (stage.isolatedWorkspace) {
        writeJsonAtomic(join(stageDir, "workspace-source-after.json"), finalExecutionSource);
        rmSync(executionRoot, { recursive: true, force: true });
      }
      if (outcome.kind === "exited" && outcome.exitCode === 0 && !missingReport && !sourceChanged) {
        result.status = "passed";
      } else {
        result.status = "failed";
        manifest.status = outcome.kind === "cancelled" ? "cancelled" : "failed";
        manifest.interruptionReason = sourceChanged
          ? "source-changed"
          : outcome.kind !== "exited" || outcome.exitCode !== 0
            ? outcome.kind
            : "missing-report";
        manifest.updatedAt = now().toISOString();
        writeManifest(runDir, manifest);
        break;
      }
      manifest.updatedAt = now().toISOString();
      writeManifest(runDir, manifest);
    }
    if (manifest.status === "running") manifest.status = "passed";
    manifest.finishedAt = now().toISOString();
    manifest.updatedAt = manifest.finishedAt;
    writeManifest(runDir, manifest);
    const lifecycleState = lifecycleStateFor(manifest);
    appendLifecycleEvent(runDir, {
      at: manifest.finishedAt,
      runId,
      state: lifecycleState,
      reason: manifest.interruptionReason,
      outcome: manifest.stages.find((stage) => stage.outcome)?.outcome?.kind,
    });
    syncLongRunIndex(rootDir, manifest, lifecycleState, "retained", now());
    cleanupLongRunValidationArtifacts({
      rootDir,
      now,
      activeRunId: runId,
    });
    return { runDir, manifest };
  } catch (error) {
    const manifestPath = join(runDir, "manifest.json");
    if (existsSync(manifestPath)) {
      const failedManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as LongRunManifest;
      failedManifest.status = "failed";
      failedManifest.interruptionReason ??= lockHeld ? "spawn-error" : "lock-unavailable";
      failedManifest.finishedAt = now().toISOString();
      failedManifest.updatedAt = failedManifest.finishedAt;
      writeManifest(runDir, failedManifest);
      appendLifecycleEvent(runDir, {
        at: failedManifest.finishedAt,
        runId,
        state: "failed",
        reason: failedManifest.interruptionReason,
        outcome: "spawn-error",
      });
      if (isSafeManifest(failedManifest)) {
        syncLongRunIndex(rootDir, failedManifest, "failed", "retained", now());
      }
      if (lockHeld) {
        cleanupLongRunValidationArtifacts({
          rootDir,
          now,
          activeRunId: runId,
        });
      }
    }
    throw error;
  } finally {
    if (lockHeld) releaseLock(lockPath, runId);
  }
}

async function executeStageProcess(
  stage: StageDefinition,
  context: { rootDir: string; logPath: string; signal: AbortSignal },
): Promise<ChildOutcome> {
  return await new Promise((resolveOutcome) => {
    const log = createWriteStream(context.logPath, { flags: "a", mode: 0o600 });
    const child = spawn("npm", stage.args, {
      cwd: context.rootDir,
      env: buildDeclaredChildEnv(stage.env),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let finished = false;
    let cancellation: "timed-out" | "cancelled" | null = null;
    const stdoutRedactor = createLineRedactor((safe) => {
      log.write(safe);
      process.stdout.write(safe);
    });
    const stderrRedactor = createLineRedactor((safe) => {
      log.write(safe);
      process.stderr.write(safe);
    });
    const finish = (outcome: ChildOutcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", onAbort);
      stdoutRedactor.end();
      stderrRedactor.end();
      log.end(() => resolveOutcome(outcome));
    };
    const forward = (reason: "timed-out" | "cancelled") => {
      if (finished || cancellation) return;
      cancellation = reason;
      const forwardedSignal =
        reason === "cancelled" && isSignal(context.signal.reason)
          ? context.signal.reason
          : "SIGTERM";
      terminateChild(child.pid, forwardedSignal);
      setTimeout(() => terminateChild(child.pid, "SIGKILL"), SIGNAL_GRACE_MS).unref();
    };
    const onAbort = () => forward("cancelled");
    const timeout = setTimeout(() => forward("timed-out"), stage.timeoutMs);
    timeout.unref();
    context.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => stdoutRedactor.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => stderrRedactor.push(chunk.toString()));
    child.on("error", () => finish({ kind: "spawn-error", exitCode: null, signal: null }));
    child.on("close", (exitCode, childSignal) => {
      finish(
        classifyChildClose(
          cancellation,
          exitCode,
          childSignal as NodeJS.Signals | null,
        ),
      );
    });
  });
}

export function buildDeclaredChildEnv(
  stageEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "TEST_SMOKE",
    "TEST_SMOKE_RELATED",
    "TEST_FORCE_ALL",
    "TEST_FULL_DEFERRAL",
    "TEST_DYNAMIC_SHARDS",
    "TEST_SHARDS",
    "TEST_FILE_TIMEOUT_MS",
    "TEST_DURATION_BUDGET",
    "LINT_VERDICT_CACHE",
    "TEST_GREEN_BASELINE_PUBLISH",
    "TEST_GREEN_BASELINE_PATH",
  ]) {
    delete env[key];
  }
  return { ...env, ...stageEnv };
}

function terminateChild(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    // A process that exited between the check and signal needs no second action.
  }
}

function snapshotReports(rootDir: string, reports: string[]): Map<string, string | null> {
  return new Map(reports.map((report) => {
    const path = resolve(rootDir, report);
    return [report, isRegularFileWithin(rootDir, path) ? sha256(readFileSync(path)) : null];
  }));
}

function copyFreshReports(
  rootDir: string,
  stageDir: string,
  stage: StageDefinition,
  before: Map<string, string | null>,
  startedAtMs: number,
  finishedAtMs: number,
): Array<{ name: string; sha256: string }> {
  const copied: Array<{ name: string; sha256: string }> = [];
  for (const report of stage.reports) {
    const source = resolve(rootDir, report);
    if (!isRegularFileWithin(rootDir, source)) continue;
    const contents = readFileSync(source);
    const hash = sha256(contents);
    if (before.get(report) === hash) continue;
    if (!hasFreshReportTimestamp(report, contents, stage, startedAtMs, finishedAtMs)) {
      continue;
    }
    const target = join(stageDir, "reports", basenameForEvidence(report));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, contents, { mode: 0o600 });
    if (sha256(readFileSync(target)) !== hash) continue;
    copied.push({ name: basenameForEvidence(report), sha256: hash });
  }
  return copied;
}

function basenameForEvidence(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop() ?? "report.json";
}

function hasFreshReportTimestamp(
  report: string,
  contents: Buffer,
  stage: StageDefinition,
  startedAtMs: number,
  finishedAtMs: number,
): boolean {
  try {
    const parsed = JSON.parse(contents.toString()) as {
      generatedAt?: unknown;
      finishedAt?: unknown;
    };
    if (basenameForEvidence(report) === "raw-test-report.json") {
      const results = (parsed as { results?: unknown }).results;
      const problems = (parsed as { verificationProblems?: unknown }).verificationProblems;
      if (
        (parsed as { verificationComplete?: unknown }).verificationComplete !== true ||
        !Array.isArray(results) ||
        !Array.isArray(problems) ||
        problems.length > 0
      ) {
        return false;
      }
      const files = results.map((result) =>
        result && typeof result === "object"
          ? (result as { file?: unknown }).file
          : undefined,
      );
      if (
        files.some((file) => typeof file !== "string") ||
        new Set(files).size !== files.length
      ) {
        return false;
      }
      const total = (parsed as { total?: unknown }).total;
      if (total !== results.length) return false;
      const skippedFiles = (parsed as { skippedGreenFiles?: unknown }).skippedGreenFiles;
      if (stage.expectedFiles) {
        if (!Array.isArray(skippedFiles)) return false;
        const observed = new Set([
          ...(files as string[]),
          ...skippedFiles.filter((file): file is string => typeof file === "string"),
        ]);
        if (
          observed.size !== stage.expectedFiles.length ||
          stage.expectedFiles.some((file) => !observed.has(file))
        ) {
          return false;
        }
      }
      if (
        stage.requireExecutedResults &&
        (results.length === 0 ||
          (parsed as { skippedGreen?: unknown }).skippedGreen !== 0)
      ) {
        return false;
      }
    }
    const timestamp =
      typeof parsed.generatedAt === "string"
        ? parsed.generatedAt
        : typeof parsed.finishedAt === "string"
          ? parsed.finishedAt
          : "";
    const reportMs = Date.parse(timestamp);
    return (
      Number.isFinite(reportMs) &&
      reportMs >= startedAtMs - 1_000 &&
      reportMs <= finishedAtMs + 5_000
    );
  } catch {
    return false;
  }
}

function prepareIsolatedWorkspace(
  rootDir: string,
  workspace: string,
  source: LongRunManifest["source"],
): string {
  if (!source.commit) throw new Error("Routine gate requires a captured Git revision");
  execFileSync("git", ["clone", "--shared", "--no-checkout", rootDir, workspace], {
    cwd: rootDir,
    stdio: ["ignore", "ignore", "ignore"],
  });
  execFileSync("git", ["checkout", "--detach", source.commit], {
    cwd: workspace,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const diff = execFileSync("git", ["diff", "--binary", "HEAD"], {
    cwd: rootDir,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  }) as Buffer;
  if (diff.length > 0) {
    execFileSync("git", ["apply", "--binary", "--whitespace=nowarn", "-"], {
      cwd: workspace,
      input: diff,
      stdio: ["pipe", "ignore", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  const untracked = (
    execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: rootDir,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    }) as Buffer
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const file of untracked) {
    const sourcePath = resolve(rootDir, file);
    const targetPath = resolve(workspace, file);
    if (!isRegularFileWithin(rootDir, sourcePath) || lstatSync(sourcePath).isSymbolicLink()) {
      throw new Error("Source contains an unsupported untracked file type");
    }
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    copyFileSync(sourcePath, targetPath);
  }
  const nodeModules = resolve(rootDir, "node_modules");
  if (existsSync(nodeModules)) {
    symlinkSync(nodeModules, resolve(workspace, "node_modules"), "dir");
  }
  for (const input of [
    ".local/state",
    ".local/runs/history",
    ".local/runs/suite-durations.json",
  ]) {
    const sourcePath = resolve(rootDir, input);
    if (!existsSync(sourcePath)) continue;
    const targetPath = resolve(workspace, input);
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    cpSync(sourcePath, targetPath, { recursive: true });
  }
  const mirrored = captureSource(workspace);
  if (
    mirrored.commit !== source.commit ||
    mirrored.workingTreeHash !== source.workingTreeHash
  ) {
    throw new Error("Could not reproduce the captured source in the private gate workspace");
  }
  return workspace;
}

function captureSource(rootDir: string): LongRunManifest["source"] {
  return {
    commit: gitValue(rootDir, ["rev-parse", "HEAD"]),
    tree: gitValue(rootDir, ["rev-parse", "HEAD^{tree}"]),
    workingTreeHash: workingTreeHash(rootDir),
  };
}

function workingTreeHash(rootDir: string): string {
  try {
    const tracked = execFileSync("git", ["diff", "--binary", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: rootDir,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    }) as Buffer;
    const untrackedDigests = untracked
      .toString()
      .split("\0")
      .filter(Boolean)
      .sort()
      .map((file) => `${file}:${sha256(readFileSync(resolve(rootDir, file)))}`)
      .join("\n");
    return sha256(`${tracked}${untrackedDigests ? `\n${untrackedDigests}` : ""}`);
  } catch {
    // A missing/unreadable git source is still represented as a hash. Controls
    // require the canonical committed source, so the missing commit rejects them.
    return sha256("source-unavailable");
  }
}

function gitValue(rootDir: string, args: string[]): string | null {
  try {
    return (execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }) as string).trim() || null;
  } catch {
    return null;
  }
}

function acquireLock(lockPath: string, record: LockRecord, now: () => Date): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (tryCreateLock(lockPath, record, false)) return;
  if (existsSync(`${lockPath}${LOCK_RECOVERY_SUFFIX}`)) {
    throw new Error("Another long-run validation job is recovering the lock");
  }
  const observed = readLockState(lockPath, now);
  if (!observed.stale) throw new Error("Another long-run validation job is active");
  const recoveryPath = `${lockPath}${LOCK_RECOVERY_SUFFIX}`;
  try {
    mkdirSync(recoveryPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another long-run validation job is recovering the lock");
    }
    throw error;
  }
  try {
    const current = readLockState(lockPath, now);
    if (!current.stale || current.fingerprint !== observed.fingerprint) {
      throw new Error("Another long-run validation job is active");
    }
    if (current.record) finalizeRecoveredManifest(dirname(lockPath), current.record, now());
    rmSync(lockPath, { recursive: true, force: true });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (tryCreateLock(lockPath, record, true)) return;
      Atomics.wait(SLEEP_WORD, 0, 0, 10);
    }
    throw new Error("Could not acquire the recovered long-run validation lock");
  } finally {
    rmSync(recoveryPath, { recursive: true, force: true });
  }
}

function tryCreateLock(
  lockPath: string,
  record: LockRecord,
  recoveryOwner: boolean,
): boolean {
  try {
    if (!recoveryOwner && existsSync(`${lockPath}${LOCK_RECOVERY_SUFFIX}`)) return false;
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, LOCK_OWNER_FILE), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    if (!recoveryOwner && existsSync(`${lockPath}${LOCK_RECOVERY_SUFFIX}`)) {
      releaseLock(lockPath, record.runId);
      return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
}

function readLockState(
  lockPath: string,
  now: () => Date,
): { stale: boolean; fingerprint: string; record: LockRecord | null } {
  try {
    const raw = readFileSync(join(lockPath, LOCK_OWNER_FILE), "utf8");
    const value = JSON.parse(raw) as Partial<LockRecord>;
    const record =
      value.schemaVersion === 1 &&
      typeof value.pid === "number" &&
      typeof value.createdAt === "string" &&
      typeof value.runId === "string"
        ? (value as LockRecord)
        : null;
    const age = now().getTime() - Date.parse(record?.createdAt ?? "");
    const stale =
      Number.isFinite(age) &&
      age >= STALE_LOCK_MS &&
      (!record || !isPidAlive(record.pid));
    return { stale, fingerprint: sha256(raw), record };
  } catch {
    const age = now().getTime() - statSync(lockPath).mtimeMs;
    return {
      stale: Number.isFinite(age) && age >= STALE_LOCK_MS,
      fingerprint: `malformed:${statSync(lockPath).mtimeMs}`,
      record: null,
    };
  }
}

function finalizeRecoveredManifest(runsDir: string, lock: LockRecord, now: Date): void {
  if (!isValidRunId(lock.runId)) return;
  const runDir = resolve(runsDir, lock.runId);
  if (!isWithin(runsDir, runDir)) return;
  const manifestPath = join(runDir, "manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as LongRunManifest;
    if (manifest.runId !== lock.runId || manifest.status !== "running") return;
    const active = manifest.stages.find((stage) => stage.status === "running");
    if (active) {
      active.status = "failed";
      active.finishedAt = now.toISOString();
      active.outcome = { kind: "killed", exitCode: null, signal: null };
    }
    manifest.status = "failed";
    manifest.interruptionReason = "stale-lock-recovered";
    manifest.finishedAt = now.toISOString();
    manifest.updatedAt = manifest.finishedAt;
    writeManifest(runDir, manifest);
    appendLifecycleEvent(runDir, {
      at: now.toISOString(),
      runId: lock.runId,
      state: "interrupted",
      reason: "stale-lock-recovered",
      outcome: "killed",
    });
    syncLongRunIndex(
      resolve(runsDir, "../../.."),
      manifest,
      "interrupted",
      "retained",
      now,
      "stale dead-owner lock recovered",
    );
  } catch {
    // Missing/malformed abandoned evidence cannot be invented; recovery still
    // proceeds, while the untouched partial directory remains diagnostic.
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockPath: string, runId: string): void {
  try {
    const lock = JSON.parse(
      readFileSync(join(lockPath, LOCK_OWNER_FILE), "utf8"),
    ) as Partial<LockRecord>;
    if (lock.runId === runId) rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Another recovered owner or an external cleanup must not be unlinked.
  }
}

function allocateRunDirectory(runsDir: string, baseId: string): string {
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const candidate = join(runsDir, `${baseId}${suffix}`);
    try {
      mkdirSync(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a collision-safe run directory");
}

function buildRunId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

function writeManifest(runDir: string, manifest: LongRunManifest): void {
  writeJsonAtomic(join(runDir, "manifest.json"), manifest);
}

function lifecycleStateFor(manifest: LongRunManifest): LongRunLifecycleState {
  if (manifest.status === "passed") return "succeeded";
  if (
    manifest.status === "cancelled" ||
    manifest.interruptionReason === "timed-out" ||
    manifest.interruptionReason === "killed" ||
    manifest.interruptionReason === "stale-lock-recovered"
  ) {
    return "interrupted";
  }
  return "failed";
}

function appendLifecycleEvent(
  runDir: string,
  event: Omit<LongRunLifecycleEvent, "schemaVersion" | "sequence">,
): void {
  const eventPath = join(runDir, LONG_RUN_EVENT_FILE);
  const sequence = nextLifecycleSequence(eventPath);
  appendFileSync(
    eventPath,
    `${JSON.stringify({ schemaVersion: 1, sequence, ...event satisfies Omit<LongRunLifecycleEvent, "schemaVersion" | "sequence"> })}\n`,
    { mode: 0o600 },
  );
}

function nextLifecycleSequence(eventPath: string): number {
  try {
    return readFileSync(eventPath, "utf8")
      .split("\n")
      .filter(Boolean).length + 1;
  } catch {
    return 1;
  }
}

function syncLongRunIndex(
  rootDir: string,
  manifest: LongRunManifest,
  lifecycleState: LongRunLifecycleState,
  cleanupDisposition: LongRunCleanupDisposition,
  now: Date,
  cleanupReason?: string,
): void {
  if (!isSafeManifest(manifest)) return;
  const runsDir = resolve(rootDir, LONG_RUNS_DIR);
  const index = readLongRunIndex(runsDir);
  const record = indexRecordFromManifest(
    manifest,
    lifecycleState,
    now,
    cleanupDisposition,
    cleanupReason,
  );
  index.records = [
    ...index.records.filter((existing) => existing.runId !== manifest.runId),
    record,
  ]
    .sort((a, b) => Date.parse(b.finishedAt ?? b.startedAt) - Date.parse(a.finishedAt ?? a.startedAt))
    .slice(0, LONG_RUN_INDEX_MAX_RECORDS);
  writeJsonAtomic(join(runsDir, LONG_RUN_INDEX_FILE), index);
}

function durationBetween(startedAt: string, finishedAt?: string): number | undefined {
  if (!finishedAt) return undefined;
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function readLongRunIndex(runsDir: string): LongRunIndex {
  try {
    const value = JSON.parse(readFileSync(join(runsDir, LONG_RUN_INDEX_FILE), "utf8")) as LongRunIndex;
    if (value.schemaVersion === 1 && Array.isArray(value.records)) {
      return {
        schemaVersion: 1,
        records: value.records
          .map(normalizeIndexRecord)
          .filter((record): record is LongRunIndexRecord => record !== null),
      };
    }
  } catch {
    // The manifest is authoritative. A corrupt index is safely rebuilt as new
    // lifecycle updates arrive; it never changes control execution.
  }
  return { schemaVersion: 1, records: [] };
}

/**
 * Prune only completed direct-child evidence directories in LONG_RUNS_DIR.
 * The current run, active lock, symlinks, malformed names, and evidence within
 * the owner-approved window are never deletion candidates.
 */
export function cleanupLongRunValidationArtifacts(
  options: LongRunCleanupOptions = {},
): LongRunCleanupReport {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const runsDir = resolve(rootDir, LONG_RUNS_DIR);
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();
  const maxAgeMs = options.maxAgeMs ?? LONG_RUN_RETENTION_MS;
  const maxCompleted = options.maxCompleted ?? LONG_RUN_MAX_COMPLETED;
  const maxBytes = options.maxBytes ?? LONG_RUN_MAX_BYTES;
  const report: LongRunCleanupReport = {
    dryRun: options.dryRun ?? false,
    eligibleRunIds: [],
    deletedRunIds: [],
    retainedRunIds: [],
    notEligibleRunIds: [],
    unsafeEntries: [],
    bytesFreed: 0,
    protectedOverage: false,
    errors: [],
  };
  if (!existsSync(runsDir)) return report;

  const candidates: Array<{
    runId: string;
    path: string;
    manifest: LongRunManifest;
    finishedAtMs: number;
    bytes: number;
  }> = [];
  for (const entry of readdirSync(runsDir)) {
    if (entry === LOCK_FILE || entry === `${LOCK_FILE}${LOCK_RECOVERY_SUFFIX}` || entry === LONG_RUN_INDEX_FILE) {
      continue;
    }
    const path = resolve(runsDir, entry);
    if (!isWithin(runsDir, path)) {
      report.unsafeEntries.push(entry);
      continue;
    }
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) {
      report.unsafeEntries.push(entry);
      continue;
    }
    if (!stat.isDirectory() || !isValidRunId(entry)) {
      report.unsafeEntries.push(entry);
      continue;
    }
    const manifest = readCompletedManifest(path, entry);
    if (!manifest) {
      report.notEligibleRunIds.push(entry);
      continue;
    }
    const finishedAtMs = Date.parse(manifest.finishedAt!);
    candidates.push({
      runId: entry,
      path,
      manifest,
      finishedAtMs,
      bytes: statTree(path),
    });
  }

  candidates.sort((a, b) => a.finishedAtMs - b.finishedAtMs);
  const protectedCandidates = candidates.filter((candidate) =>
    candidate.runId === options.activeRunId ||
    candidate.finishedAtMs > nowMs - maxAgeMs,
  );
  const expired = candidates.filter((candidate) =>
    candidate.runId !== options.activeRunId &&
    candidate.finishedAtMs <= nowMs - maxAgeMs,
  );
  let retainedCount = protectedCandidates.length + expired.length;
  let retainedBytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0);
  const eligible = new Set<string>();
  for (const candidate of expired) {
    const exceedsCount = retainedCount > maxCompleted;
    const exceedsBytes = retainedBytes > maxBytes;
    if (exceedsCount || exceedsBytes || candidate.finishedAtMs <= nowMs - maxAgeMs) {
      eligible.add(candidate.runId);
      retainedCount--;
      retainedBytes -= candidate.bytes;
    }
  }
  if (protectedCandidates.length > maxCompleted || protectedCandidates.reduce((sum, c) => sum + c.bytes, 0) > maxBytes) {
    report.protectedOverage = true;
  }

  const index = readLongRunIndex(runsDir);
  for (const candidate of candidates) {
    if (!eligible.has(candidate.runId)) {
      report.retainedRunIds.push(candidate.runId);
      continue;
    }
    try {
      report.eligibleRunIds.push(candidate.runId);
      if (report.dryRun) continue;
      rmSync(candidate.path, { recursive: true, force: false });
      report.deletedRunIds.push(candidate.runId);
      report.bytesFreed += candidate.bytes;
      const prior = index.records.find((record) => record.runId === candidate.runId);
      const tombstone = prior ?? indexRecordFromManifest(candidate.manifest, lifecycleStateFor(candidate.manifest), now);
      index.records = [
        ...index.records.filter((record) => record.runId !== candidate.runId),
        {
          ...tombstone,
          cleanup: {
            disposition: "deleted",
            updatedAt: now().toISOString(),
            reason: "age/count/size retention cleanup",
          },
        },
      ];
    } catch (error) {
      report.errors.push(`${candidate.runId}: ${error instanceof Error ? error.message : String(error)}`);
      const prior = index.records.find((record) => record.runId === candidate.runId);
      if (prior) {
        prior.cleanup = {
          disposition: "cleanup-failed",
          updatedAt: now().toISOString(),
          reason: "retention cleanup failed",
        };
      }
    }
  }
  if (!report.dryRun) {
    index.records = index.records
      .sort((a, b) => Date.parse(b.cleanup.updatedAt) - Date.parse(a.cleanup.updatedAt))
      .slice(0, LONG_RUN_INDEX_MAX_RECORDS);
    writeJsonAtomic(join(runsDir, LONG_RUN_INDEX_FILE), index);
  }
  return report;
}

function indexRecordFromManifest(
  manifest: LongRunManifest,
  lifecycleState: LongRunLifecycleState,
  now: Date,
  cleanupDisposition: LongRunCleanupDisposition = "retained",
  cleanupReason?: string,
): LongRunIndexRecord {
  return {
    runId: manifest.runId,
    profile: manifest.profile,
    lifecycleState,
    status: manifest.status,
    startedAt: manifest.startedAt,
    ...(manifest.finishedAt ? { finishedAt: manifest.finishedAt } : {}),
    ...(durationBetween(manifest.startedAt, manifest.finishedAt) !== undefined
      ? { durationMs: durationBetween(manifest.startedAt, manifest.finishedAt) }
      : {}),
    ...(isSafeInterruptionReason(manifest.interruptionReason)
      ? { interruptionReason: manifest.interruptionReason }
      : {}),
    stages: manifest.stages.map((stage) => ({
      name: stage.name,
      status: stage.status,
      ...(stage.durationMs !== undefined ? { durationMs: stage.durationMs } : {}),
      ...(stage.outcome ? { outcome: stage.outcome.kind } : {}),
    })),
    cleanup: {
      disposition: cleanupDisposition,
      updatedAt: now.toISOString(),
      ...(cleanupReason ? { reason: cleanupReason } : {}),
    },
  };
}

function isValidRunId(value: string): boolean {
  return /^[0-9TZ-]+-\d+-[0-9a-f]{12}(?:-\d+)?$/.test(value);
}

function readCompletedManifest(path: string, runId: string): LongRunManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")) as LongRunManifest;
    return (isSafeManifest(manifest) && manifest.runId === runId && isTerminalStatus(manifest.status))
      ? manifest
      : null;
  } catch {
    return null;
  }
}

function isTerminalStatus(status: LongRunManifest["status"]): boolean {
  return status === "passed" || status === "failed" || status === "cancelled";
}

function isSafeManifest(value: unknown): value is LongRunManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<LongRunManifest>;
  if (
    manifest.schemaVersion !== LONG_RUN_SCHEMA_VERSION ||
    !isValidRunId(manifest.runId ?? "") ||
    typeof manifest.profile !== "string" ||
    !Object.hasOwn(PROFILE_DEFINITIONS, manifest.profile) ||
    !["queued", "running", "passed", "failed", "cancelled"].includes(manifest.status ?? "") ||
    typeof manifest.startedAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.startedAt)) ||
    (manifest.finishedAt !== undefined &&
      (typeof manifest.finishedAt !== "string" || !Number.isFinite(Date.parse(manifest.finishedAt)))) ||
    !isSafeInterruptionReason(manifest.interruptionReason) ||
    !Array.isArray(manifest.stages)
  ) {
    return false;
  }
  return manifest.stages.every((stage) => {
    const candidate = stage as LongRunManifest["stages"][number];
    return (
      !!candidate &&
      typeof candidate.name === "string" &&
      /^[a-z0-9-]{1,80}$/i.test(candidate.name) &&
      ["pending", "running", "passed", "failed"].includes(candidate.status) &&
      (candidate.durationMs === undefined ||
        (typeof candidate.durationMs === "number" && Number.isFinite(candidate.durationMs) && candidate.durationMs >= 0)) &&
      (candidate.outcome === undefined ||
        ["exited", "timed-out", "cancelled", "killed", "spawn-error"].includes(candidate.outcome.kind))
    );
  });
}

function isSafeInterruptionReason(
  value: LongRunManifest["interruptionReason"] | undefined,
): value is NonNullable<LongRunManifest["interruptionReason"]> | undefined {
  return (
    value === undefined ||
    [
      "exited",
      "timed-out",
      "cancelled",
      "killed",
      "spawn-error",
      "source-changed",
      "missing-report",
      "stale-lock-recovered",
      "lock-unavailable",
    ].includes(value)
  );
}

function normalizeIndexRecord(value: unknown): LongRunIndexRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<LongRunIndexRecord>;
  if (
    !isValidRunId(record.runId ?? "") ||
    typeof record.profile !== "string" ||
    !Object.hasOwn(PROFILE_DEFINITIONS, record.profile) ||
    !["queued", "running", "succeeded", "failed", "interrupted"].includes(record.lifecycleState ?? "") ||
    !["queued", "running", "passed", "failed", "cancelled"].includes(record.status ?? "") ||
    typeof record.startedAt !== "string" ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    (record.finishedAt !== undefined &&
      (typeof record.finishedAt !== "string" || !Number.isFinite(Date.parse(record.finishedAt)))) ||
    !isSafeInterruptionReason(record.interruptionReason) ||
    !Array.isArray(record.stages) ||
    !record.cleanup ||
    !["retained", "deleted", "not-eligible", "cleanup-failed"].includes(record.cleanup.disposition) ||
    typeof record.cleanup.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.cleanup.updatedAt))
  ) {
    return null;
  }
  const stages = record.stages.map((stage) => {
    const candidate = stage as LongRunIndexRecord["stages"][number];
    if (
      !candidate ||
      typeof candidate.name !== "string" ||
      !/^[a-z0-9-]{1,80}$/i.test(candidate.name) ||
      !["pending", "running", "passed", "failed"].includes(candidate.status) ||
      (candidate.durationMs !== undefined &&
        (typeof candidate.durationMs !== "number" || !Number.isFinite(candidate.durationMs) || candidate.durationMs < 0)) ||
      (candidate.outcome !== undefined &&
        !["exited", "timed-out", "cancelled", "killed", "spawn-error"].includes(candidate.outcome))
    ) {
      return null;
    }
    return {
      name: candidate.name,
      status: candidate.status,
      ...(candidate.durationMs !== undefined ? { durationMs: candidate.durationMs } : {}),
      ...(candidate.outcome !== undefined ? { outcome: candidate.outcome } : {}),
    };
  });
  if (stages.some((stage) => stage === null)) return null;
  return {
    runId: record.runId,
    profile: record.profile as LongRunProfile,
    lifecycleState: record.lifecycleState as LongRunLifecycleState,
    status: record.status as LongRunManifest["status"],
    startedAt: record.startedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(typeof record.durationMs === "number" && Number.isFinite(record.durationMs) && record.durationMs >= 0
      ? { durationMs: record.durationMs }
      : {}),
    ...(record.interruptionReason ? { interruptionReason: record.interruptionReason } : {}),
    stages: stages as LongRunIndexRecord["stages"],
    cleanup: {
      disposition: record.cleanup.disposition,
      updatedAt: record.cleanup.updatedAt,
    },
  };
}

function statTree(path: string): number {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let bytes = 0;
  for (const entry of readdirSync(path)) bytes += statTree(join(path, entry));
  return bytes;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isRegularFileWithin(root: string, candidate: string): boolean {
  try {
    return (
      isWithin(root, candidate) &&
      statSync(candidate).isFile() &&
      isWithin(root, realpathSync(candidate))
    );
  } catch {
    return false;
  }
}

function isSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === "string" && /^SIG[A-Z0-9]+$/.test(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function redactText(value: string): string {
  return value
    .replace(/xox[baposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/=]{6,}/gi, "Basic [REDACTED]")
    .replace(
      /-----BEGIN (?:(?:RSA|EC|OPENSSH) )?PRIVATE KEY-----[\s\S]*?-----END (?:(?:RSA|EC|OPENSSH) )?PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(
      /("?[\w-]*(?:authorization|api[_-]?key|private[_-]?key|service[_-]?account[_-]?key|client[_-]?secret|webhook[_-]?secret|secret|password|passwd|token)[\w-]*"?\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,;}]{4,})/gi,
      (_match, key: string) => `${key}"[REDACTED]"`,
    )
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi,
      "$1[REDACTED]@",
    );
}

export function classifyChildClose(
  cancellation: "timed-out" | "cancelled" | null,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): ChildOutcome {
  if (cancellation === "timed-out") {
    return { kind: "timed-out", exitCode, signal };
  }
  if (cancellation === "cancelled") {
    return { kind: "cancelled", exitCode, signal };
  }
  if (signal !== null) {
    return { kind: "killed", exitCode, signal };
  }
  return { kind: "exited", exitCode, signal: null };
}

export function createLineRedactor(emit: (safe: string) => void): {
  push(chunk: string): void;
  end(): void;
} {
  let pending = "";
  let discardUntilNewline = false;
  return {
    push(chunk: string): void {
      pending += chunk;
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        if (discardUntilNewline) {
          discardUntilNewline = false;
          continue;
        }
        emit(redactText(line));
      }
      if (!discardUntilNewline && pending.length > MAX_PARTIAL_LOG_LINE) {
        emit("[REDACTED OVERLONG LOG LINE]\n");
        pending = "";
        discardUntilNewline = true;
      }
    },
    end(): void {
      if (!discardUntilNewline && pending) emit(redactText(pending));
      pending = "";
    },
  };
}

export function cliMain(argv = process.argv.slice(2)): Promise<number> {
  const requestFlag = argv.indexOf("--request");
  if (requestFlag < 0 || argv.length !== 2 || !argv[requestFlag + 1]) {
    console.error("Usage: npm run validate:long -- --request .local/runs/long-validation-request.json");
    return Promise.resolve(2);
  }
  const requestPath = argv[requestFlag + 1];
  if (!isSafeRequestPath(requestPath)) {
    console.error("Request path must be a JSON file under .local/runs/");
    return Promise.resolve(2);
  }
  let request: unknown;
  try {
    request = JSON.parse(readFileSync(requestPath, "utf8"));
  } catch {
    console.error("Could not read a valid JSON request file.");
    return Promise.resolve(2);
  }
  const handle = startLongRunValidation(request);
  const forwardInt = () => handle.cancel("SIGINT");
  const forwardTerm = () => handle.cancel("SIGTERM");
  process.once("SIGINT", forwardInt);
  process.once("SIGTERM", forwardTerm);
  return handle.done
    .then(({ runDir, manifest }) => {
      console.log(`Long validation ${manifest.status}: evidence retained at ${runDir}`);
      return manifest.status === "passed" ? 0 : 1;
    })
    .catch((error: unknown) => {
      console.error(`Long validation refused: ${redactText(error instanceof Error ? error.message : String(error))}`);
      return 2;
    })
    .finally(() => {
      process.removeListener("SIGINT", forwardInt);
      process.removeListener("SIGTERM", forwardTerm);
    });
}

function isSafeRequestPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!(
    !isAbsolute(path) &&
    normalized.startsWith(".local/runs/") &&
    normalized.endsWith(".json") &&
    !normalized.split("/").includes("..")
  )) return false;
  const rootDir = process.cwd();
  const expectedRoot = resolve(rootDir, ".local/runs");
  return isRegularFileWithin(expectedRoot, resolve(rootDir, path));
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("scripts/long-run-validation.ts") ?? false);

if (isMain) {
  void cliMain().then((code) => process.exit(code));
}