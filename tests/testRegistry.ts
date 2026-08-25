/**
 * Task #3786 — Decentralized test registration.
 *
 * Why this exists
 * ---------------
 * The TESTS array + SMOKE_FILES set in tests/run-all.ts used to be
 * hand-maintained literals that EVERY task had to edit (158 of the 400
 * commits before the cutover touched run-all.ts), which made whole-file
 * merge conflicts there the #1 recurring merge failure. Registration is now
 * decentralized: each test file declares its own registration in a
 * `/* test-registration ... *\/` block at the very top of the file, and the
 * runner derives its registry by discovery. Adding a test = adding ONE new
 * file; no shared file changes, so concurrent test-adding tasks cannot
 * conflict.
 *
 * The registration block
 * ----------------------
 * Line 1 of every `*.test.ts` / `*.test.tsx` file under `tests/` or
 * `client/src/` must be exactly `/* test-registration`, followed by a JSON
 * object, closed by a line holding only the end marker (`test-registration`
 * plus the block-comment closer, as in the example):
 *
 *     /* test-registration
 *     {
 *       "name": "My feature routes (Task #NNNN)",
 *       "regression": true,
 *       "smoke": true,
 *       "tier": "small",
 *       "smokeReason": "DB-free pure-function suite; guards the X bug class."
 *     }
 *     test-registration *\/
 *
 * Fields (all optional except `name`):
 *   - name             Display name the runner prints (include the task ref).
 *   - regression       true = included in the nightly `--regression` sweep.
 *   - smoke            true = member of the TEST_SMOKE merge/completion gate
 *                      universe (the related-selection engine picks from
 *                      these). Smoke tests must be fast (<30s) and
 *                      deterministic; prefer DB-free.
 *   - smokeReason      Why this test earns a smoke-gate slot (required by
 *                      lint when smoke is true).
 *   - tier             Required by lint: "small" (<=30s), "medium" (<=90s),
 *                      or "large" (slow/browser/dev-server harness). Tier
 *                      policy and measurement enforcement live in
 *                      tests/sizeTiers.ts and lint-smoke-gate-regression.
 *   - tierReason       Required for large tiers and non-mechanical overrides;
 *                      records why the suite needs the larger resource lane.
 *   - sweepOnlyReason  The explicit decision NOT to gate a regression test
 *                      (required by lint when regression is true and smoke is
 *                      not; e.g. slow, DB-heavy, or contention-sensitive).
 *   - timeoutMs        Per-file wall-clock override; falls back to
 *                      TEST_FILE_TIMEOUT_MS (default 180s). Only for
 *                      legitimately slow fixtures (Task #1701).
 *   - extraNodeArgs    Extra args spliced into `npx tsx <args> <file>`
 *                      (loader shims, --import setup hooks, --tsconfig).
 *   - extraEnv         Extra env vars for the child process.
 *   - notes            Free-form context worth keeping next to the
 *                      registration (migrated array comments live here).
 *   - scanPaths        Task #4103: repo-root-relative files/directories this
 *                      suite reads via fs at runtime (readFileSync source
 *                      scans etc.). These are invisible to import tracing, so
 *                      declaring them (a) makes the related-smoke selector
 *                      pick the suite when a scanned file changes and (b)
 *                      folds their content hashes into the green-skip
 *                      fingerprint so the suite re-executes when a scanned
 *                      file changes. Enforced by
 *                      scripts/lint-test-fs-scan-inputs.ts: a non-core test
 *                      that fs-reads repo source must declare its targets.
 *
 * The per-suite `sharedDev` escape hatch (Task #3797) was retired in Task
 * #3862 after the last tagged suite went hermetic (Task #3851). The keys
 * are no longer allowed — registration validation rejects them — so a suite
 * cannot quietly opt back onto the shared dev DB. The whole-run
 * TEST_SHARED_DEV_DB=1 legacy mode was also retired — hermetic is the only mode.
 *
 * Smoke-gate policy (unchanged from the pre-#3786 SMOKE_FILES header): the
 * merge/completion gate runs `TEST_SMOKE=1 npm test`, selecting only the
 * smoke universe so the gate terminates in-window while still exercising
 * representative paths. The full suite (no flag) still runs everything, and
 * `--regression` runs the nightly sweep set. A regression-flagged test that
 * is not in the smoke universe never runs in the routine gate — which is why
 * lint-smoke-gate-regression demands an explicit smoke-vs-sweep-only
 * decision, recorded HERE in the test's own block instead of a shared
 * baseline file.
 *
 * Structural notes for parsers
 * ----------------------------
 * The block must start at line 1 so naive scans can never confuse an example
 * block inside a string literal (e.g. in the lint fixtures) with the real
 * registration. The end marker must appear within MAX_BLOCK_LINES lines.
 * This module is the ONLY parser; the runner (tests/run-all.ts),
 * scripts/lint-test-registration.ts, and scripts/lint-smoke-gate-regression.ts
 * all consume it, so format and enforcement cannot drift apart.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Shape the runner consumes — identical to the pre-#3786 TestDef. */
export interface TestDef {
  name: string;
  file: string;
  regression?: boolean;
  extraNodeArgs?: string[];
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
  scanPaths?: string[];
}

/** The parsed registration block of a single test file. */
export interface TestRegistration {
  name: string;
  regression?: boolean;
  smoke?: boolean;
  smokeReason?: string;
  sweepOnlyReason?: string;
  tier?: "small" | "medium" | "large";
  tierReason?: string;
  timeoutMs?: number;
  extraNodeArgs?: string[];
  extraEnv?: Record<string, string>;
  notes?: string;
  scanPaths?: string[];
}

export const REGISTRATION_START = "/* test-registration";
export const REGISTRATION_END = "test-registration */";
/** The end marker must appear within this many lines of the top. */
export const MAX_BLOCK_LINES = 400;

/** Roots discovery walks for `*.test.ts(x)` files. */
export const DEFAULT_TEST_ROOTS = ["tests", "client/src"];

const ALLOWED_KEYS = new Set([
  "name",
  "regression",
  "smoke",
  "smokeReason",
  "sweepOnlyReason",
  "tier",
  "tierReason",
  "timeoutMs",
  "extraNodeArgs",
  "extraEnv",
  "notes",
  "scanPaths",
]);

/** Recursively collect every *.test.ts / *.test.tsx under the roots (sorted). */
export function discoverTestFiles(
  rootDirs: string[] = DEFAULT_TEST_ROOTS,
  repoRoot: string = process.cwd(),
): string[] {
  const out: string[] = [];
  const walk = (absDir: string, relDir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return; // root missing in a fixture tree — treat as empty
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const abs = join(absDir, entry);
      const rel = relDir ? `${relDir}/${entry}` : entry;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, rel);
      } else if (/\.test\.tsx?$/.test(entry)) {
        out.push(rel);
      }
    }
  };
  for (const root of rootDirs) {
    walk(join(repoRoot, root), root);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * Extract and structurally validate the registration block of one file's
 * source. Returns the registration or a list of problems (never both).
 * Structural = "the runner can trust this shape"; the smoke-vs-sweep gate
 * DECISION rules live in validateGateDecision (lint concern, so a missing
 * reason never blocks running tests).
 */
export function parseRegistration(source: string): {
  registration: TestRegistration | null;
  errors: string[];
} {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== REGISTRATION_START) {
    return {
      registration: null,
      errors: [
        `missing registration block: line 1 must be exactly \`${REGISTRATION_START}\` (see tests/testRegistry.ts for the format)`,
      ],
    };
  }
  let endIdx = -1;
  const limit = Math.min(lines.length, MAX_BLOCK_LINES);
  for (let i = 1; i < limit; i++) {
    if (lines[i].trim() === REGISTRATION_END) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return {
      registration: null,
      errors: [
        `registration block never closes: expected a line that is exactly \`${REGISTRATION_END}\` within the first ${MAX_BLOCK_LINES} lines`,
      ],
    };
  }
  const body = lines.slice(1, endIdx).join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      registration: null,
      errors: [
        `registration block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  return validateRegistrationShape(parsed);
}

/** Structural/type validation of a parsed registration object. */
export function validateRegistrationShape(parsed: unknown): {
  registration: TestRegistration | null;
  errors: string[];
} {
  const errors: string[] = [];
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      registration: null,
      errors: ["registration block must be a JSON object"],
    };
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push(
        `unknown key "${key}" (allowed: ${[...ALLOWED_KEYS].join(", ")})`,
      );
    }
  }
  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    errors.push(`"name" is required and must be a non-empty string`);
  }
  for (const key of ["regression", "smoke"] as const) {
    if (key in obj && typeof obj[key] !== "boolean") {
      errors.push(`"${key}" must be a boolean when present`);
    }
  }
  for (const key of ["smokeReason", "sweepOnlyReason", "tierReason", "notes"] as const) {
    if (key in obj && (typeof obj[key] !== "string" || (obj[key] as string).trim() === "")) {
      errors.push(`"${key}" must be a non-empty string when present`);
    }
  }
  if (!("tier" in obj)) {
    errors.push(`"tier" is required — declare "small", "medium", or "large"`);
  } else if (obj.tier !== "small" && obj.tier !== "medium" && obj.tier !== "large") {
    errors.push(`"tier" must be "small", "medium", or "large"`);
  }
  if ("timeoutMs" in obj) {
    const v = obj.timeoutMs;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      errors.push(`"timeoutMs" must be a positive integer (milliseconds)`);
    }
  }
  if ("extraNodeArgs" in obj) {
    const v = obj.extraNodeArgs;
    if (
      !Array.isArray(v) ||
      v.length === 0 ||
      v.some((a) => typeof a !== "string" || a.trim() === "")
    ) {
      errors.push(`"extraNodeArgs" must be a non-empty array of non-empty strings`);
    }
  }
  if ("extraEnv" in obj) {
    const v = obj.extraEnv;
    if (
      typeof v !== "object" ||
      v === null ||
      Array.isArray(v) ||
      Object.keys(v).length === 0 ||
      Object.entries(v).some(
        ([k, val]) => k.trim() === "" || typeof val !== "string",
      )
    ) {
      errors.push(`"extraEnv" must be a non-empty object of string values`);
    }
  }
  if ("scanPaths" in obj) {
    const v = obj.scanPaths;
    if (
      !Array.isArray(v) ||
      v.length === 0 ||
      v.some((p) => typeof p !== "string" || p.trim() === "")
    ) {
      errors.push(`"scanPaths" must be a non-empty array of non-empty strings`);
    } else {
      for (const p of v as string[]) {
        if (p.startsWith("/") || p.startsWith("./") || p.split("/").includes("..") || p.endsWith("/")) {
          errors.push(
            `"scanPaths" entry "${p}" must be a normalized repo-root-relative path (no leading "/" or "./", no ".." segments, no trailing "/")`,
          );
        }
      }
    }
  }
  if (errors.length > 0) return { registration: null, errors };
  return { registration: obj as unknown as TestRegistration, errors: [] };
}

/**
 * The smoke-vs-sweep gate-decision rules (enforced by
 * scripts/lint-smoke-gate-regression.ts, deliberately NOT by the runner):
 * every regression test must record an explicit decision — gate it (`smoke`
 * + `smokeReason`) or keep it sweep-only with a stated `sweepOnlyReason`.
 */
export function validateGateDecision(reg: TestRegistration): string[] {
  const errors: string[] = [];
  if (reg.smoke === true && !reg.smokeReason) {
    errors.push(
      `"smoke": true requires a "smokeReason" — say why this test earns a routine-gate slot`,
    );
  }
  if (reg.smoke === true && reg.sweepOnlyReason) {
    errors.push(
      `"smoke": true contradicts "sweepOnlyReason" — a test is gated or sweep-only, not both`,
    );
  }
  if (reg.regression === true && reg.smoke !== true && !reg.sweepOnlyReason) {
    errors.push(
      `"regression": true without "smoke": true requires a "sweepOnlyReason" — a regression test outside the smoke universe never runs in the routine TEST_SMOKE gate, so record the decision (the pre-#3786 baseline-file rot class)`,
    );
  }
  if (reg.sweepOnlyReason && reg.regression !== true) {
    errors.push(
      `"sweepOnlyReason" only makes sense on a "regression": true test`,
    );
  }
  if (reg.smokeReason && reg.smoke !== true) {
    errors.push(`"smokeReason" only makes sense with "smoke": true`);
  }
  return errors;
}

export interface RegistryProblem {
  file: string;
  message: string;
}

export interface TestRegistry {
  /** Derived TestDef list, sorted by file path. */
  tests: TestDef[];
  /** Files whose registration declares `"smoke": true`. */
  smokeFiles: Set<string>;
  /** Per-file registrations (for the lints). */
  registrations: Map<string, TestRegistration>;
  /** Structural problems; a non-empty list means the registry is unusable. */
  problems: RegistryProblem[];
}

export interface BuildRegistryOptions {
  rootDirs?: string[];
  repoRoot?: string;
}

/** Discover every test file and derive the registry from their blocks. */
export function buildTestRegistry(options: BuildRegistryOptions = {}): TestRegistry {
  const repoRoot = options.repoRoot ?? process.cwd();
  const rootDirs = options.rootDirs ?? DEFAULT_TEST_ROOTS;
  const files = discoverTestFiles(rootDirs, repoRoot);

  const tests: TestDef[] = [];
  const smokeFiles = new Set<string>();
  const registrations = new Map<string, TestRegistration>();
  const problems: RegistryProblem[] = [];

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(repoRoot, file), "utf8");
    } catch (err) {
      problems.push({
        file,
        message: `could not read file: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const { registration, errors } = parseRegistration(source);
    if (!registration) {
      for (const e of errors) problems.push({ file, message: e });
      continue;
    }
    registrations.set(file, registration);
    const def: TestDef = { name: registration.name, file };
    if (registration.regression === true) def.regression = true;
    if (registration.extraNodeArgs) def.extraNodeArgs = registration.extraNodeArgs;
    if (registration.extraEnv) def.extraEnv = registration.extraEnv;
    if (registration.timeoutMs !== undefined) def.timeoutMs = registration.timeoutMs;
    if (registration.scanPaths) def.scanPaths = registration.scanPaths;
    tests.push(def);
    if (registration.smoke === true) smokeFiles.add(file);
  }

  return { tests, smokeFiles, registrations, problems };
}
