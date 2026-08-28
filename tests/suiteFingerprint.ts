/**
 * Task #3791 — Incremental test execution: per-suite input fingerprints plus
 * a per-environment "last green" store, so every run mode (full `npm test`,
 * smoke, related-smoke, regression sweep) skips suites whose inputs are
 * byte-identical to their last green execution in THIS environment.
 *
 * Why: even with related-only gate selection (Task #3755) and a fast lint
 * phase (Task #3789), the harness still re-executed work whose inputs had not
 * changed — predeploy ran every suite on every Publish, the nightly sweep
 * re-ran the whole regression set on quiet days, and the Run-tests completion
 * workflow re-executed all smoke files minutes after a green gate.
 *
 * What a suite's fingerprint covers (sha256 over a canonical JSON document):
 *   - FINGERPRINT_ALGO_VERSION and the store schema version — bumping either
 *     invalidates the store wholesale (a runner-behavior change must never
 *     honor greens recorded under the old semantics);
 *   - process.version (Node upgrades invalidate everything);
 *   - global inputs: package.json, package-lock.json, root tsconfig*.json,
 *     and the runner/selection/fingerprint modules themselves;
 *   - the migrations/ tree hash, applied ONLY to DB-backed suites (Task
 *     #4077): a suite is migration-sensitive when its traced closure reaches
 *     the DB layer by path (server/db.ts, tests/hermetic/) or a closure file
 *     matches a DB content marker (a "pg" driver import, DATABASE_URL, the
 *     drizzle node-postgres binding, or a server/index.ts boot reference —
 *     suites that spawn the full server apply migrations transitively). Pure
 *     lint/jsdom/source-scan suites keep migration-insensitive fingerprints,
 *     so a routine migration merge no longer invalidates them; any
 *     classification error falls open to executing the suite;
 *   - the suite's registration metadata (extraNodeArgs, extraEnv, timeoutMs);
 *   - (path, contentHash) of every file in the suite's traced import closure —
 *     entries are the test file plus its registered setup/hook files from
 *     extraNodeArgs, traced with the shared Task #3755 esbuild tracer;
 *   - for suites with extraNodeArgs: the "shim tree" hash — every non-test
 *     file under tests/ (loader shims register stub modules by STRING path,
 *     invisible to import tracing, so a stub edit must re-execute every
 *     shim-using suite even though no import reaches it).
 *
 * Safety invariants (proved by tests/incremental-green-skip.test.ts):
 *   - failures never record green; a failure overwrites any prior green so a
 *     stale same-fingerprint green cannot mask a real failure;
 *   - the always-run core (DEFAULT_CORE_RULES — repo-scanning lint-style
 *     suites whose real inputs are invisible to import tracing) is never
 *     skipped in any mode;
 *   - any store/trace/hash error falls open to EXECUTING, never to skipping;
 *   - a suite whose closure contains an unresolvable import is never skipped;
 *   - green records expire after TEST_GREEN_MAX_AGE_DAYS (default 7);
 *   - a full run (`npm test`, mode "all") only skips when a genuine
 *     full-suite green (every suite executed, zero skips, zero failures)
 *     exists within TEST_FULL_GREEN_WINDOW_DAYS (default 7) in this
 *     environment — this is predeploy's integrity guard: environment/DB
 *     drift is invisible to fingerprints, so "publish after a quiet period"
 *     stays cheap only while a recent full green proves the environment;
 *   - `--force-all` / TEST_FORCE_ALL=1 bypasses all skipping in every mode.
 *
 * The store lives at .local/state/test-green-store.json — outside git
 * (.local/ is gitignored) so it can never become a merge surface.
 *
 * Baseline inheritance (Task: cut task validation to minutes): greens WERE
 * strictly per-environment while suites shared the mutable Helium dev DB —
 * a green proved "this code passed against THIS environment's state". The
 * hermetic per-run DB cutover (Tasks #3797/#3839/#3851) removed that state:
 * a fingerprint now covers every input a suite's verdict depends on. So the
 * main workspace publishes a committed snapshot of its green records to
 * tests/green-baseline.json (publishGreenBaseline — the ONLY writer, gated
 * behind TEST_GREEN_BASELINE_PUBLISH=1 which only the nightly sweep
 * scheduler sets), and a runner whose LOCAL store is absent/empty seeds
 * itself from that snapshot. Rails preserved:
 *   - the baseline carries only verdict-"green" records; failures are never
 *     published and never seeded (loadGreenBaseline drops anything else);
 *   - schema/algo version mismatch discards the baseline wholesale, exactly
 *     like the local-store load; any read error falls open to executing;
 *   - lastFullRunGreenAt is NEVER inherited — mode-"all" integrity runs
 *     stay per-environment;
 *   - a non-empty local store is never overwritten by the baseline (local
 *     history, including local failures, always wins);
 *   - decideSuite still applies the exact-fingerprint match, freshness
 *     expiry, core exemption, and every fall-open rule to seeded records —
 *     a task's own diff changes fingerprints and forces affected suites.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  DEFAULT_CORE_RULES,
  coreReason,
  extraNodeArgsEntryFiles,
  generatedArtifactOwnershipInputsForSuite,
  traceImportClosures,
  traceImportClosuresWithBudget,
  type CoreRule,
} from "./relatedSmokeSelection";

export const FINGERPRINT_ALGO_VERSION = "fp-v1";
export const GREEN_STORE_SCHEMA_VERSION = 1;
export const DEFAULT_GREEN_STORE_PATH = ".local/state/test-green-store.json";
/** Committed snapshot of main's green records. Single writer: the main
 * workspace via publishGreenBaseline (TEST_GREEN_BASELINE_PUBLISH=1, set only
 * by the nightly sweep scheduler). Task branches must never modify it — the
 * guard test in tests/incremental-green-skip.test.ts pins this wiring. */
export const DEFAULT_GREEN_BASELINE_PATH = "tests/green-baseline.json";
/** Committed snapshot of main's currently-RED suites (Task #3922) — the red
 * sibling of the green baseline, written by the SAME single publisher (see
 * tests/redManifest.ts). The constant lives here so computeShimTreeHash below
 * can exclude it without importing the red-manifest module (which imports
 * this one). */
export const DEFAULT_RED_MANIFEST_PATH = "tests/red-manifest.json";
/** Task #5028 — auto-quarantine ledger. Excluded from the shim-tree hash
 * (same reasoning as the green baseline and red manifest: it is nightly
 * runner STATE, not a stub/shim; hashing it would invalidate all
 * extraNodeArgs suites on every nightly quarantine transition). */
export const DEFAULT_QUARANTINE_LEDGER_PATH = "tests/flake-quarantine.json";
export const DEFAULT_SKIP_AUDIT_PATH = ".local/runs/incremental-skip.json";
export const DEFAULT_GREEN_MAX_AGE_DAYS = 7;
export const DEFAULT_FULL_GREEN_WINDOW_DAYS = 7;
/** Records older than this are pruned from the store on save. */
const STORE_PRUNE_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The registration fields that shape a suite's child process. Matches the
 * relevant subset of TestDef in tests/testRegistry.ts (structural, so this
 * module stays importable without the registry). */
export interface SuiteLike {
  file: string;
  extraNodeArgs?: string[];
  scanPaths?: string[];
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
}

export interface GreenRecord {
  fingerprint: string;
  verdict: "green" | "failed";
  /** Passed only after an in-suite retry (quarantine/flake reporting input). */
  flaky: boolean;
  durationMs: number;
  recordedAt: string; // ISO
  mode: "all" | "smoke" | "regression";
}

export interface GreenStore {
  schemaVersion: number;
  fingerprintAlgo: string;
  /** Last time a mode-"all" run executed EVERY suite (zero skips) and passed. */
  lastFullRunGreenAt: string | null;
  records: Record<string, GreenRecord>;
}

export function emptyGreenStore(): GreenStore {
  return {
    schemaVersion: GREEN_STORE_SCHEMA_VERSION,
    fingerprintAlgo: FINGERPRINT_ALGO_VERSION,
    lastFullRunGreenAt: null,
    records: {},
  };
}

/** Load the store, falling open (fresh empty store + note) on ANY problem:
 * missing file, unreadable JSON, wrong shape, or a schema/algo mismatch
 * (a runner change invalidates the store wholesale). Never throws. */
export function loadGreenStore(absPath: string): { store: GreenStore; note: string | null } {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    return { store: emptyGreenStore(), note: "green store missing — first run in this environment executes everything" };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GreenStore> | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.schemaVersion !== "number" || typeof parsed.records !== "object" || parsed.records === null) {
      return { store: emptyGreenStore(), note: "green store malformed — discarded (fall open to executing)" };
    }
    if (parsed.schemaVersion !== GREEN_STORE_SCHEMA_VERSION || parsed.fingerprintAlgo !== FINGERPRINT_ALGO_VERSION) {
      return {
        store: emptyGreenStore(),
        note: `green store schema/algo mismatch (found v${parsed.schemaVersion}/${parsed.fingerprintAlgo ?? "?"}, need v${GREEN_STORE_SCHEMA_VERSION}/${FINGERPRINT_ALGO_VERSION}) — discarded`,
      };
    }
    return {
      store: {
        schemaVersion: GREEN_STORE_SCHEMA_VERSION,
        fingerprintAlgo: FINGERPRINT_ALGO_VERSION,
        lastFullRunGreenAt: typeof parsed.lastFullRunGreenAt === "string" ? parsed.lastFullRunGreenAt : null,
        records: parsed.records as Record<string, GreenRecord>,
      },
      note: null,
    };
  } catch {
    return { store: emptyGreenStore(), note: "green store unparseable — discarded (fall open to executing)" };
  }
}

function saveGreenStore(absPath: string, store: GreenStore): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tmp, absPath); // atomic on the same filesystem
}

// ---------------------------------------------------------------------------
// Committed green baseline (main → task environments)
// ---------------------------------------------------------------------------

export interface GreenBaseline {
  schemaVersion: number;
  fingerprintAlgo: string;
  publishedAt: string;
  records: Record<string, GreenRecord>;
}

function isGreenRecordShape(r: unknown): r is GreenRecord {
  return (
    !!r &&
    typeof r === "object" &&
    typeof (r as GreenRecord).fingerprint === "string" &&
    typeof (r as GreenRecord).recordedAt === "string"
  );
}

/**
 * Load the committed baseline snapshot. Same wholesale-discard validation as
 * loadGreenStore (schema/algo mismatch, malformed JSON, wrong shape → null),
 * plus one extra rail: only verdict-"green" records survive — a failure can
 * never seed anything, whatever a (hand-edited or corrupted) baseline says.
 * A missing file is normal (main has not published yet) → null, no note.
 * Never throws.
 */
export function loadGreenBaseline(absPath: string): { baseline: GreenBaseline | null; note: string | null } {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    return { baseline: null, note: null }; // no committed baseline — nothing to seed
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GreenBaseline> | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.schemaVersion !== "number" || typeof parsed.records !== "object" || parsed.records === null) {
      return { baseline: null, note: "green baseline malformed — ignored (fall open to executing)" };
    }
    if (parsed.schemaVersion !== GREEN_STORE_SCHEMA_VERSION || parsed.fingerprintAlgo !== FINGERPRINT_ALGO_VERSION) {
      return {
        baseline: null,
        note: `green baseline schema/algo mismatch (found v${parsed.schemaVersion}/${parsed.fingerprintAlgo ?? "?"}, need v${GREEN_STORE_SCHEMA_VERSION}/${FINGERPRINT_ALGO_VERSION}) — ignored`,
      };
    }
    const records: Record<string, GreenRecord> = {};
    for (const [file, rec] of Object.entries(parsed.records as Record<string, unknown>)) {
      if (isGreenRecordShape(rec) && rec.verdict === "green") records[file] = rec;
    }
    return {
      baseline: {
        schemaVersion: GREEN_STORE_SCHEMA_VERSION,
        fingerprintAlgo: FINGERPRINT_ALGO_VERSION,
        publishedAt: typeof parsed.publishedAt === "string" ? parsed.publishedAt : "unknown",
        records,
      },
      note: null,
    };
  } catch {
    return { baseline: null, note: "green baseline unparseable — ignored (fall open to executing)" };
  }
}

/**
 * Publish the local store's GREEN records as the committed baseline snapshot.
 * The ONLY writer of tests/green-baseline.json. Failures are filtered out —
 * a red suite is simply absent from the baseline, so a seeded environment
 * executes it. Never throws.
 */
export function publishGreenBaseline(opts: {
  storePath: string;
  baselinePath: string;
  now?: Date;
}): { published: boolean; count: number; note: string | null } {
  try {
    const { store } = loadGreenStore(opts.storePath);
    const records: Record<string, GreenRecord> = {};
    for (const [file, rec] of Object.entries(store.records)) {
      if (rec.verdict === "green") records[file] = rec;
    }
    const baseline: GreenBaseline = {
      schemaVersion: GREEN_STORE_SCHEMA_VERSION,
      fingerprintAlgo: FINGERPRINT_ALGO_VERSION,
      publishedAt: (opts.now ?? new Date()).toISOString(),
      records,
    };
    mkdirSync(dirname(opts.baselinePath), { recursive: true });
    const tmp = `${opts.baselinePath}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    renameSync(tmp, opts.baselinePath);
    return { published: true, count: Object.keys(records).length, note: null };
  } catch (err) {
    return {
      published: false,
      count: 0,
      note: `baseline publish failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Fingerprint computation
// ---------------------------------------------------------------------------

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function hashFile(absPath: string, cache: Map<string, string>): string {
  const hit = cache.get(absPath);
  if (hit) return hit;
  const digest = sha256(readFileSync(absPath));
  cache.set(absPath, digest);
  return digest;
}

/** Recursively list files under `absDir` (repo-relative results, sorted). */
function listFilesRecursive(absDir: string, repoRoot: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git") continue;
    const abs = join(absDir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listFilesRecursive(abs, repoRoot));
    else if (st.isFile()) out.push(relative(repoRoot, abs).replaceAll("\\", "/"));
  }
  return out.sort();
}

const RUNNER_FILES = [
  "tests/run-all.ts",
  "tests/testRegistry.ts",
  "tests/relatedSmokeSelection.ts",
  "tests/suiteFingerprint.ts",
  // Task #5028: auto-quarantine state module is a runner-behavior dependency;
  // editing it must invalidate every suite's fingerprint (same reasoning as
  // the modules above).
  "tests/flakeQuarantine.ts",
];

function isTestFile(relPath: string): boolean {
  return /\.test\.tsx?$/.test(relPath);
}

/** Hash the global inputs shared by every suite. Throws on unreadable files —
 * callers treat that as "fingerprinting unavailable" and fall open. */
function computeGlobalInputsHash(repoRoot: string, cache: Map<string, string>): string {
  const parts: Array<[string, string]> = [];
  const addIfPresent = (rel: string) => {
    try {
      parts.push([rel, hashFile(resolve(repoRoot, rel), cache)]);
    } catch {
      parts.push([rel, "missing"]);
    }
  };
  addIfPresent("package.json");
  addIfPresent("package-lock.json");
  for (const rel of RUNNER_FILES) addIfPresent(rel);
  let rootEntries: string[] = [];
  try {
    rootEntries = readdirSync(repoRoot);
  } catch {
    /* fall through — no tsconfig entries */
  }
  for (const name of rootEntries.sort()) {
    if (/^tsconfig.*\.json$/.test(name)) addIfPresent(name);
  }
  return sha256(JSON.stringify({ algo: FINGERPRINT_ALGO_VERSION, node: process.version, parts }));
}

/** Hash the migrations/ tree. Task #4077: this WAS part of the global inputs
 * hash, which made every routine migration merge invalidate every suite —
 * including pure lint/jsdom/source-scan suites that never touch a database.
 * It is now a per-suite input folded in only for DB-backed suites (see
 * closureIsDbSensitive). Throws on unreadable files — callers fall open. */
function computeMigrationsHash(repoRoot: string, cache: Map<string, string>): string {
  const parts: Array<[string, string]> = [];
  for (const rel of listFilesRecursive(resolve(repoRoot, "migrations"), repoRoot)) {
    parts.push([rel, hashFile(resolve(repoRoot, rel), cache)]);
  }
  return sha256(JSON.stringify({ algo: FINGERPRINT_ALGO_VERSION, parts }));
}

// ---------------------------------------------------------------------------
// Task #4503 — per-table migration sensitivity.
//
// Task #4077 made migrations/ a per-suite input, but every DB-sensitive suite
// still folded the ENTIRE migrations-tree hash, so a routine one-table
// migration merge re-ran ~all ~680 DB suites. Now each DB-sensitive suite is
// sub-classified:
//   - scope "tables": the fingerprint folds (a) the per-table hash of the
//     migration files touching each table the suite's closure textually
//     references (SQL table name OR its drizzle pgTable export identifier,
//     word-boundary scan of the RAW file content — comments/strings included,
//     deliberately over-inclusive: a false table reference only re-runs the
//     suite, never skips it), and (b) a global hash of every migration file
//     whose statements could NOT all be attributed to plain table DDL/DML
//     (DO blocks, functions, views, triggers, zero extracted tables, …) —
//     an unattributable migration still invalidates EVERY DB-sensitive suite.
//   - scope "full": the whole-tree hash, exactly the pre-#4503 behavior, for
//     suites whose verdict can depend on migrations beyond any table list:
//     the closure reaches the migration runner (server/devMigrations.ts) or
//     the hermetic harness helpers, or a tests/-side closure member
//     (comment-stripped) references server/index.ts (spawned-server suites
//     apply ALL migrations at boot) or queries information_schema/pg_catalog.
// Any extraction/scan error throws into the existing per-suite catch →
// unskippable (falls open to executing, never to a wrong skip).
// ---------------------------------------------------------------------------

/** Table-referencing SQL statements a migration file can be attributed by. */
const MIGRATION_TABLE_STMT_RES: readonly RegExp[] = [
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
  /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
  /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\s+ON\s+(?:ONLY\s+)?(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
  /\bINSERT\s+INTO\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
  /\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+SET\b/gi,
  /\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
  /\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
  /\bCOMMENT\s+ON\s+TABLE\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
  /\bREFERENCES\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
  /\bRENAME\s+TO\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
];

/** Keywords that introduce a COMMA-SEPARATED relation list. Handled by
 * extractRelationLists (not a single-capture regex) so `DROP TABLE a, b`,
 * `TRUNCATE a, b`, `FROM a, b`, `USING a, b`, and joins attribute EVERY
 * relation — recording only the first would wrong-skip suites scoped to the
 * omitted ones. Over-capturing non-table idents (EXTRACT(x FROM …), USING
 * btree, JOIN LATERAL) is fine: extra names only widen invalidation. */
const RELATION_LIST_KEYWORD_RE =
  /\b(?:FROM|USING|(?:LEFT|RIGHT|FULL|INNER|CROSS|OUTER)?\s*JOIN|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|TRUNCATE(?:\s+TABLE)?)\s+/gi;
const RELATION_IDENT_RE = /^(?:ONLY\s+)?(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/;

/** Walk every relation-list keyword in `stmt` and add EACH comma-separated
 * relation (skipping optional aliases) to `out`. */
function extractRelationLists(stmt: string, out: Set<string>): void {
  RELATION_LIST_KEYWORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RELATION_LIST_KEYWORD_RE.exec(stmt))) {
    let rest = stmt.slice(m.index + m[0].length).trimStart();
    for (;;) {
      const im = RELATION_IDENT_RE.exec(rest);
      if (!im) break;
      out.add(im[1].toLowerCase());
      rest = rest.slice(im[0].length).trimStart();
      // Optional alias (`AS x` or bare ident); consuming a clause keyword as
      // an "alias" is harmless — we only continue the list on a comma.
      const alias = /^(?:AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*/.exec(rest);
      if (alias) rest = rest.slice(alias[0].length).trimStart();
      if (!rest.startsWith(",")) break;
      rest = rest.slice(1).trimStart();
    }
  }
}
/** WHITELIST of statement heads whose table set the regexes above can fully
 * extract. Attribution is per-STATEMENT: every substantive statement in a
 * migration file must match one of these heads AND yield at least one table,
 * or the whole file is global. Anything not on this list (DO blocks,
 * functions, views, types, domains, extensions, GRANT/REVOKE, SET, DROP
 * INDEX — no table name recoverable, …) leans global by construction. */
const MIGRATION_ATTRIBUTABLE_STMT_HEAD_RE =
  /^(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|INSERT\s+INTO|UPDATE\b|DELETE\s+FROM|TRUNCATE\b|COMMENT\s+ON\s+TABLE)/i;

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Extract the set of tables a migration file touches, or null when the file
 * is unattributable (global). A file is attributable ONLY when EVERY
 * substantive statement matches a whitelisted table-statement head and
 * yields at least one table — one unrecognized statement (dollar-quoted
 * body, unsupported DDL/DCL, …) makes the whole file global, even alongside
 * plain ALTER TABLEs. Exported for the guard tests. */
export function extractMigrationTables(sql: string): Set<string> | null {
  const clean = stripSqlComments(sql);
  // Dollar-quoted bodies hide semicolons from the naive splitter → global.
  if (/\$[A-Za-z0-9_]*\$/.test(clean)) return null;
  const statements = clean
    .split(/;/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (statements.length === 0) return null;
  const tables = new Set<string>();
  for (const stmt of statements) {
    if (!MIGRATION_ATTRIBUTABLE_STMT_HEAD_RE.test(stmt)) return null;
    const stmtTables = new Set<string>();
    for (const re of MIGRATION_TABLE_STMT_RES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stmt))) stmtTables.add(m[1].toLowerCase());
    }
    extractRelationLists(stmt, stmtTables);
    if (stmtTables.size === 0) return null; // whitelisted head but no table extracted → global
    for (const t of stmtTables) tables.add(t);
  }
  return tables.size > 0 ? tables : null;
}

interface MigrationIndex {
  /** table → hash over the sorted (file, contentHash) list touching it. */
  perTableHash: Map<string, string>;
  /** Hash over every unattributable migration file — folded into EVERY
   * table-scoped fingerprint so those files keep whole-radius invalidation. */
  globalHash: string;
}

/** Attribute every migration file to tables (or the global bucket) and hash
 * each bucket. Throws on unreadable files — callers fall open. */
function computeMigrationIndex(repoRoot: string, cache: Map<string, string>): MigrationIndex {
  const perTableParts = new Map<string, Array<[string, string]>>();
  const globalParts: Array<[string, string]> = [];
  for (const rel of listFilesRecursive(resolve(repoRoot, "migrations"), repoRoot)) {
    const abs = resolve(repoRoot, rel);
    const digest = hashFile(abs, cache);
    const tables = /\.sql$/i.test(rel) ? extractMigrationTables(readFileSync(abs, "utf8")) : null;
    if (tables === null) {
      globalParts.push([rel, digest]);
      continue;
    }
    for (const table of tables) {
      const list = perTableParts.get(table) ?? [];
      list.push([rel, digest]);
      perTableParts.set(table, list);
    }
  }
  const perTableHash = new Map<string, string>();
  for (const [table, parts] of perTableParts) {
    perTableHash.set(table, sha256(JSON.stringify({ algo: FINGERPRINT_ALGO_VERSION, table, parts })));
  }
  return {
    perTableHash,
    globalHash: sha256(JSON.stringify({ algo: FINGERPRINT_ALGO_VERSION, global: globalParts })),
  };
}

/** Strip TS/JS comments for the FULL-scope marker scan (comments routinely
 * mention server/index.ts). `//` preceded by `:` is kept (https:// URLs) —
 * over-keeping only errs toward scope "full", never toward a wrong skip. */
function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** tests/-side content that pins a DB suite to FULL migration scope: spawned
 * full-server harnesses (boot applies every migration) and catalog-wide
 * queries whose verdicts can depend on arbitrary schema state. */
const FULL_SCOPE_CONTENT_RE = /server\/index\.ts|information_schema|\bpg_catalog\b|\bpg_tables\b/;
/** Closure members that pin FULL scope by path: the migration runner reads
 * the whole migrations/ tree; the hermetic harness provisions from it. */
const FULL_SCOPE_PATH_MARKERS = new Set(["server/devMigrations.ts"]);

const PGTABLE_DEF_RE = /export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*pgTable\(\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']/g;

/** Lazily-built, per-computation view of the drizzle table universe: which
 * files define pgTable()s, and a token → tables map covering both the SQL
 * table name and the export identifier. */
interface TableUniverse {
  definingFiles: Set<string>;
  tokenToTables: Map<string, Set<string>>;
  /** Single alternation over every token (null when no tables exist). */
  tokenRe: RegExp | null;
}

/** Directories scanned REPO-WIDE for pgTable definitions. The universe must
 * not depend on which suites were selected: a raw-SQL-only suite still needs
 * every table name as a token, or it would silently under-reference. */
const TABLE_DEF_SCAN_DIRS = ["shared", "server", "db", "src"];

function buildTableUniverse(
  repoRoot: string,
  sourceCache: Map<string, string>,
  migrationTableNames: Iterable<string>,
): TableUniverse {
  const definingFiles = new Set<string>();
  const tokenToTables = new Map<string, Set<string>>();
  const addToken = (token: string, table: string) => {
    const set = tokenToTables.get(token) ?? new Set<string>();
    set.add(table);
    tokenToTables.set(token, set);
  };
  // Every table name seen in the migration ledger is a token even when no
  // pgTable definition exists (migration-only/legacy tables): raw-SQL suites
  // referencing them must still re-run on their migrations.
  for (const name of migrationTableNames) addToken(name, name);
  const files: string[] = [];
  for (const dir of TABLE_DEF_SCAN_DIRS) {
    try {
      files.push(...listFilesRecursive(resolve(repoRoot, dir), repoRoot));
    } catch {
      // absent dir — fine
    }
  }
  for (const rel of files) {
    if (!SCANNABLE_SOURCE.test(rel)) continue;
    let content: string;
    try {
      content = readSource(resolve(repoRoot, rel), sourceCache);
    } catch {
      continue; // unreadable defs never widen the universe; suites referencing them fall open elsewhere
    }
    PGTABLE_DEF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PGTABLE_DEF_RE.exec(content))) {
      definingFiles.add(rel);
      addToken(m[1], m[2].toLowerCase());
      addToken(m[2].toLowerCase(), m[2].toLowerCase());
    }
  }
  const tokens = [...tokenToTables.keys()].sort((a, b) => b.length - a.length);
  const tokenRe = tokens.length > 0 ? new RegExp(`\\b(${tokens.join("|")})\\b`, "g") : null;
  return { definingFiles, tokenToTables, tokenRe };
}

function readSource(absPath: string, cache: Map<string, string>): string {
  const hit = cache.get(absPath);
  if (hit !== undefined) return hit;
  const content = readFileSync(absPath, "utf8");
  cache.set(absPath, content);
  return content;
}

export type MigrationScope = "full" | "tables";

/** Sub-classify a migration-sensitive suite. Throws on unreadable files —
 * the caller's per-suite catch falls open to executing. */
function classifyMigrationScope(
  closure: Set<string>,
  repoRoot: string,
  universe: TableUniverse,
  sourceCache: Map<string, string>,
): { scope: MigrationScope; tables: string[] } {
  const tables = new Set<string>();
  for (const member of closure) {
    if (FULL_SCOPE_PATH_MARKERS.has(member)) return { scope: "full", tables: [] };
    if (!SCANNABLE_SOURCE.test(member)) continue;
    const content = readSource(resolve(repoRoot, member), sourceCache);
    if (member.startsWith("tests/") && FULL_SCOPE_CONTENT_RE.test(stripTsComments(content))) {
      return { scope: "full", tables: [] };
    }
    // Defining files textually mention EVERY table — matching them would
    // collapse table scoping to "all tables"; their content hash is already
    // in the closure, so schema edits still invalidate normally.
    if (universe.definingFiles.has(member) || !universe.tokenRe) continue;
    universe.tokenRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = universe.tokenRe.exec(content))) {
      for (const t of universe.tokenToTables.get(m[1]) ?? []) tables.add(t);
    }
  }
  // A DB-sensitive suite referencing ZERO known tables is doing something we
  // cannot attribute (dynamic table names, exotic access) — pin FULL scope
  // rather than let it skip attributable migrations. Leans open.
  if (tables.size === 0) return { scope: "full", tables: [] };
  return { scope: "tables", tables: [...tables].sort() };
}

/** Closure members that mark a suite migration-sensitive by PATH: the DB
 * layer itself and the hermetic-DB harness helpers. */
const DB_PATH_MARKERS = new Set(["server/db.ts"]);
const DB_PATH_PREFIXES = ["tests/hermetic/"];

/** Content markers for closure files that reach Postgres WITHOUT importing
 * server/db.ts: raw `pg` clients, DATABASE_URL plumbing, the drizzle driver
 * binding, or spawning the full server (`server/index.ts` — the boot path
 * applies migrations/bootstrap SQL transitively). Matching leans sensitive —
 * a false positive merely re-runs a suite on migration merges, never skips
 * one wrongly. Deliberately NOT bare `drizzle-orm`: schema/type-only imports
 * (shared/schema.ts) don't make a suite's verdict depend on migration files. */
const DB_CONTENT_PATTERNS: readonly RegExp[] = [
  /from\s+["']pg["']/,
  /require\(\s*["']pg["']\s*\)/,
  /import\(\s*["']pg["']\s*\)/,
  /@neondatabase\/serverless/,
  /drizzle-orm\/node-postgres/,
  /process\.env\.DATABASE_URL/,
  /server\/index\.ts/,
];

const SCANNABLE_SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function fileHasDbContentMarker(absPath: string, cache: Map<string, boolean>): boolean {
  const hit = cache.get(absPath);
  if (hit !== undefined) return hit;
  const content = readFileSync(absPath, "utf8");
  const sensitive = DB_CONTENT_PATTERNS.some((re) => re.test(content));
  cache.set(absPath, sensitive);
  return sensitive;
}

/** Task #4077: does this suite's verdict plausibly depend on migrations/?
 * Throws on unreadable files — the caller's per-suite try/catch turns that
 * into "unskippable" (fall open to executing, never to a wrong skip). */
function closureIsDbSensitive(
  closure: Set<string>,
  repoRoot: string,
  contentCache: Map<string, boolean>,
): boolean {
  for (const member of closure) {
    if (DB_PATH_MARKERS.has(member)) return true;
    if (DB_PATH_PREFIXES.some((p) => member.startsWith(p))) return true;
  }
  for (const member of closure) {
    if (!SCANNABLE_SOURCE.test(member)) continue;
    if (fileHasDbContentMarker(resolve(repoRoot, member), contentCache)) return true;
  }
  return false;
}

/** Task #4103: hash a suite's declared fs-scan inputs (registration
 * `scanPaths`). Suites that read repo source via fs have inputs invisible to
 * import tracing; folding the scanned files' content hashes into the
 * fingerprint makes an edit to a scanned file invalidate the suite's green.
 * A declared path may be a file or a directory (hashed recursively). A
 * missing path hashes as "<missing>" — deletion still flips the fingerprint
 * while keeping the suite skippable. Unreadable existing files throw — the
 * caller's per-suite catch marks the suite unskippable (falls open). */
function computeScanPathsParts(
  scanPaths: readonly string[],
  repoRoot: string,
  cache: Map<string, string>,
): Array<[string, string]> {
  const parts: Array<[string, string]> = [];
  for (const rel of [...scanPaths].sort()) {
    const abs = resolve(repoRoot, rel);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      parts.push([rel, "<missing>"]);
      continue;
    }
    if (stat.isDirectory()) {
      for (const sub of listFilesRecursive(abs, repoRoot)) {
        parts.push([sub, hashFile(resolve(repoRoot, sub), cache)]);
      }
    } else {
      parts.push([rel, hashFile(abs, cache)]);
    }
  }
  return parts;
}

/** Hash every non-test file under tests/ (loader shims, stubs, setup files,
 * fixtures). Loader shims register stub modules by string path — invisible to
 * import tracing — so any suite with extraNodeArgs folds this hash into its
 * fingerprint: a stub edit re-executes every shim-using suite. */
function computeShimTreeHash(repoRoot: string, cache: Map<string, string>): string {
  const parts: Array<[string, string]> = [];
  for (const rel of listFilesRecursive(resolve(repoRoot, "tests"), repoRoot)) {
    if (isTestFile(rel)) continue;
    // The committed green baseline is runner STATE, not a stub/shim: no suite
    // ever loads it, and hashing it would make every nightly publish
    // invalidate all extraNodeArgs suites (and break fingerprint round-trips
    // between main and seeded task environments).
    if (rel === DEFAULT_GREEN_BASELINE_PATH) continue;
    // Same reasoning for the red manifest (Task #3922): it is published by
    // the same nightly run, and hashing it would additionally break the
    // red-side fingerprint round-trip — a task environment could never match
    // the fingerprint main recorded at publish time, so inherited reds would
    // never be provably excusable.
    if (rel === DEFAULT_RED_MANIFEST_PATH) continue;
    // Task #5028: the auto-quarantine ledger is nightly runner STATE written
    // by the same publish run — hashing it would invalidate every
    // extraNodeArgs suite on every quarantine transition (same reasoning as
    // the two exclusions above).
    if (rel === DEFAULT_QUARANTINE_LEDGER_PATH) continue;
    parts.push([rel, hashFile(resolve(repoRoot, rel), cache)]);
  }
  return sha256(JSON.stringify(parts));
}

export interface SuiteFingerprintInfo {
  file: string;
  /** Null when the fingerprint could not be computed (suite must execute). */
  fingerprint: string | null;
  /** Non-null when this suite can never be skipped, with the reason. */
  unskippableReason: string | null;
  /** Task #4081: whether migrations/ was folded into this fingerprint (see
   * closureIsDbSensitive). Null when the fingerprint could not be computed.
   * Exposed so the classification split (sensitive vs insensitive) is
   * auditable — silent drift toward "everything is migration-sensitive"
   * re-inflates validation time on every migration merge. */
  migrationSensitive: boolean | null;
  /** Task #4503: how migrations/ was folded in for a sensitive suite —
   * "full" (whole-tree hash) or "tables" (per-referenced-table hashes plus
   * the global unattributable bucket). Null when insensitive or when the
   * fingerprint could not be computed. Exposed so the table-scoped share is
   * auditable: drift back toward "full" silently re-inflates migration-merge
   * validation time. */
  migrationScope: MigrationScope | null;
  /** Task #4503: the tables a "tables"-scoped suite references (sorted). */
  migrationTables: string[] | null;
}

export interface FingerprintComputation {
  ok: boolean;
  /** Set when ok=false: every suite must execute (fall open). */
  error: string | null;
  bySuite: Map<string, SuiteFingerprintInfo>;
}

/**
 * Compute per-suite fingerprints for every given suite. Whole-computation
 * failures (tracer crash, unreadable global input) return ok=false — the
 * caller executes everything. Per-suite problems (unresolvable import in the
 * closure, unreadable closure file) mark only that suite unskippable.
 */
export async function computeSuiteFingerprints(
  suites: SuiteLike[],
  repoRoot: string = process.cwd(),
  opts: {
    /** Task #4560: hard budget for the import trace (same stall protection
     * as the Task #4547 gate expansion). Defaults to
     * FINGERPRINT_TRACE_TIMEOUT_MS or 120s. On timeout the computation
     * returns ok=false — every suite executes (fall open, never skip). */
    traceTimeoutMs?: number;
    /** Injectable tracer seam (tests exercise the timeout path with it). */
    traceFn?: typeof traceImportClosures;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<FingerprintComputation> {
  const bySuite = new Map<string, SuiteFingerprintInfo>();
  try {
    const cache = new Map<string, string>();
    const dbContentCache = new Map<string, boolean>();
    const sourceCache = new Map<string, string>();
    const globalHash = computeGlobalInputsHash(repoRoot, cache);
    const shimTreeHash = computeShimTreeHash(repoRoot, cache);
    const migrationsHash = computeMigrationsHash(repoRoot, cache);
    const migrationIndex = computeMigrationIndex(repoRoot, cache);

    const entriesBySuite = new Map<string, string[]>();
    const allEntries = new Set<string>();
    for (const suite of suites) {
      const entries = [suite.file, ...extraNodeArgsEntryFiles(suite.extraNodeArgs)];
      entriesBySuite.set(suite.file, entries);
      for (const e of entries) allEntries.add(e);
    }

    // Task #4560: race the tracer against a hard budget (shared helper — see
    // traceImportClosuresWithBudget for the timer/exit-13 rationale). A
    // stalled esbuild BFS here used to hang the whole nightly sweep before
    // the honest fall-open path could run.
    const envForTimeout = opts.env ?? process.env;
    const traceTimeoutMs =
      opts.traceTimeoutMs ?? (Number(envForTimeout.FINGERPRINT_TRACE_TIMEOUT_MS) || 120_000);
    const { timedOut, trace } = await traceImportClosuresWithBudget(
      [...allEntries],
      repoRoot,
      { tolerateUnresolvable: true },
      { timeoutMs: traceTimeoutMs, traceFn: opts.traceFn },
    );
    if (timedOut || !trace) {
      return {
        ok: false,
        error: `import trace timed out after ${Math.round(traceTimeoutMs / 1000)}s — executing every suite (fall open)`,
        bySuite,
      };
    }
    if (!trace.ok) {
      return { ok: false, error: trace.error ?? "import trace failed", bySuite };
    }
    const unresolved = trace.unresolved ?? new Map<string, string[]>();

    // Task #4503: the table universe is repo-wide (schema dirs + every table
    // name in the migration ledger) — independent of which suites were
    // selected, so raw-SQL-only suites still match their tables.
    const tableUniverse = buildTableUniverse(repoRoot, sourceCache, migrationIndex.perTableHash.keys());

    for (const suite of suites) {
      const entries = entriesBySuite.get(suite.file) ?? [suite.file];
      const closure = new Set<string>();
      for (const entry of entries) {
        closure.add(entry);
        for (const dep of trace.closures.get(entry) ?? []) closure.add(dep);
      }

      let unskippableReason: string | null = null;
      for (const member of closure) {
        const bad = unresolved.get(member);
        if (bad && bad.length > 0) {
          unskippableReason = `closure member ${member} has unresolvable import(s): ${bad.slice(0, 3).join(", ")}`;
          break;
        }
      }
      if (unskippableReason) {
        bySuite.set(suite.file, {
          file: suite.file,
          fingerprint: null,
          unskippableReason,
          migrationSensitive: null,
          migrationScope: null,
          migrationTables: null,
        });
        continue;
      }

      let fingerprint: string | null = null;
      let migrationSensitive: boolean | null = null;
      let migrationScope: MigrationScope | null = null;
      let migrationTables: string[] | null = null;
      try {
        const closureParts: Array<[string, string]> = [...closure]
          .sort()
          .map((rel) => [rel, hashFile(resolve(repoRoot, rel), cache)]);
        // Task #4077: fold the migrations hash in ONLY for DB-backed suites.
        // A classification error throws into this catch → unskippable (falls
        // open to executing, never to a wrong skip).
        migrationSensitive = closureIsDbSensitive(closure, repoRoot, dbContentCache);
        // Task #4503: sub-classify sensitive suites. "full" keeps the exact
        // pre-#4503 whole-tree hash; "tables" folds per-referenced-table
        // hashes plus the global unattributable bucket, so a migration merge
        // touching only unreferenced tables leaves this fingerprint alone.
        let migrationsInput: unknown = null;
        if (migrationSensitive) {
          const scoped = classifyMigrationScope(closure, repoRoot, tableUniverse, sourceCache);
          migrationScope = scoped.scope;
          if (scoped.scope === "full") {
            migrationsInput = migrationsHash;
          } else {
            migrationTables = scoped.tables;
            migrationsInput = {
              tables: scoped.tables.map((t) => [t, migrationIndex.perTableHash.get(t) ?? "<none>"]),
              global: migrationIndex.globalHash,
            };
          }
        }
        // Task #4103: declared fs-scan inputs join the fingerprint. The key
        // is added ONLY for declaring suites so every other suite's
        // fingerprint document stays byte-identical (no wholesale green
        // invalidation from shipping this feature).
        const scanExtra =
          suite.scanPaths && suite.scanPaths.length > 0
            ? { scanPaths: computeScanPathsParts(suite.scanPaths, repoRoot, cache) }
            : {};
        const ownershipInputs = generatedArtifactOwnershipInputsForSuite(suite.file, repoRoot);
        if (!ownershipInputs.ok) {
          throw new Error(ownershipInputs.error);
        }
        const ownershipExtra =
          ownershipInputs.inputs.length > 0
            ? {
                generatedArtifactOwnership: {
                  families: ownershipInputs.families,
                  inputs: ownershipInputs.inputs.map((rel) => [rel, hashFile(resolve(repoRoot, rel), cache)]),
                },
              }
            : {};
        fingerprint = sha256(
          JSON.stringify({
            algo: FINGERPRINT_ALGO_VERSION,
            schema: GREEN_STORE_SCHEMA_VERSION,
            global: globalHash,
            migrations: migrationsInput,
            shimTree: suite.extraNodeArgs && suite.extraNodeArgs.length > 0 ? shimTreeHash : null,
            meta: {
              file: suite.file,
              extraNodeArgs: suite.extraNodeArgs ?? null,
              extraEnv: suite.extraEnv ?? null,
              timeoutMs: suite.timeoutMs ?? null,
            },
            closure: closureParts,
            ...scanExtra,
            ...ownershipExtra,
          }),
        );
      } catch (err) {
        unskippableReason = `failed hashing closure: ${err instanceof Error ? err.message : String(err)}`;
        migrationSensitive = null;
        migrationScope = null;
        migrationTables = null;
      }
      bySuite.set(suite.file, {
        file: suite.file,
        fingerprint,
        unskippableReason,
        migrationSensitive,
        migrationScope,
        migrationTables,
      });
    }
    return { ok: true, error: null, bySuite };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), bySuite };
  }
}

// ---------------------------------------------------------------------------
// Skip decision + run plan
// ---------------------------------------------------------------------------

/** Task #5030 (review-hardened): machine-readable classification of WHY an
 * execute decision was made — consumed by the rotation-day deferral gate.
 * Only the two positively-identified stale-green kinds ("stale-rotation" /
 * "stale-expired", i.e. real green evidence invalidated by input churn or
 * age, with a successfully computed current fingerprint) are deferrable.
 * Every other kind — run-level fall-opens, core, uncomputable/poisoned
 * closures, no-record, last-failed — and any unknown/future kind keeps
 * executing (planFullLaneDeferral fails closed). */
export type SuiteExecuteReasonKind =
  | "run-level" // skippingDisabledReason: force-all, integrity run, wholesale fingerprint fall-open
  | "core" // always-run core rule matched
  | "unskippable" // per-suite closure poisoned / uncomputable
  | "no-fingerprint" // no fingerprint for this suite (per-suite fall open)
  | "no-record" // never recorded green in this environment (or record timestamp unreadable)
  | "last-failed" // most recent recorded outcome was a failure
  | "stale-rotation" // green evidence exists but inputs changed since (fingerprint mismatch)
  | "stale-expired"; // green on identical inputs but older than the max age

export interface SuiteDecision {
  file: string;
  action: "execute" | "skip";
  reason: string;
  fingerprint: string | null;
  /** Non-null exactly when action === "execute" (Task #5030). */
  executeReasonKind: SuiteExecuteReasonKind | null;
}

export function decideSuite(args: {
  file: string;
  /** Non-null disables skipping for the whole run (force-all, window guard, trace failure). */
  runLevelExecuteReason: string | null;
  coreWhy: string | null;
  fingerprint: string | null;
  unskippableReason: string | null;
  record: GreenRecord | undefined;
  nowMs: number;
  greenMaxAgeMs: number;
}): SuiteDecision {
  const { file, fingerprint } = args;
  if (args.runLevelExecuteReason) {
    return { file, action: "execute", reason: args.runLevelExecuteReason, fingerprint, executeReasonKind: "run-level" };
  }
  if (args.coreWhy) {
    return { file, action: "execute", reason: `always-run core: ${args.coreWhy}`, fingerprint, executeReasonKind: "core" };
  }
  if (args.unskippableReason) {
    return { file, action: "execute", reason: args.unskippableReason, fingerprint, executeReasonKind: "unskippable" };
  }
  if (!fingerprint) {
    return { file, action: "execute", reason: "no fingerprint available (fall open)", fingerprint, executeReasonKind: "no-fingerprint" };
  }
  const record = args.record;
  if (!record) {
    return { file, action: "execute", reason: "no green record in this environment", fingerprint, executeReasonKind: "no-record" };
  }
  if (record.verdict !== "green") {
    return { file, action: "execute", reason: "last recorded run failed", fingerprint, executeReasonKind: "last-failed" };
  }
  if (record.fingerprint !== fingerprint) {
    return { file, action: "execute", reason: "inputs changed since last green", fingerprint, executeReasonKind: "stale-rotation" };
  }
  const recordedMs = Date.parse(record.recordedAt);
  if (!Number.isFinite(recordedMs) || args.nowMs - recordedMs > args.greenMaxAgeMs) {
    return {
      file,
      action: "execute",
      reason: "last green too old (expired)",
      fingerprint,
      // A parseable-but-old timestamp is positively-identified expiry debt
      // (deferrable); an UNREADABLE timestamp is not positive evidence of
      // anything — classify as no-record so deferral fails closed.
      executeReasonKind: Number.isFinite(recordedMs) ? "stale-expired" : "no-record",
    };
  }
  return {
    file,
    action: "skip",
    reason: `green on identical inputs at ${record.recordedAt}${record.flaky ? " (flaky pass)" : ""}`,
    fingerprint,
    executeReasonKind: null,
  };
}

export function fullGreenWithinWindow(store: GreenStore, nowMs: number, windowMs: number): boolean {
  if (!store.lastFullRunGreenAt) return false;
  const t = Date.parse(store.lastFullRunGreenAt);
  return Number.isFinite(t) && nowMs - t <= windowMs;
}

function parseDaysEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface IncrementalPlan {
  mode: "all" | "smoke" | "regression";
  forceAll: boolean;
  /** Non-null when skipping is disabled for the entire run (with the reason). */
  skippingDisabledReason: string | null;
  decisions: SuiteDecision[];
  executeFiles: Set<string>;
  skippedFiles: string[];
  /** file → fingerprint (null when uncomputable) for outcome recording. */
  fingerprints: Map<string, string | null>;
  store: GreenStore;
  storePath: string;
  greenMaxAgeDays: number;
  fullGreenWindowDays: number;
  /** Task #4077 skip-health visibility: committed-baseline freshness. Null
   * when the baseline is absent, unreadable, or has no parseable
   * publishedAt. */
  baselinePublishedAt: string | null;
  baselineAgeDays: number | null;
  /** Task #4081 classification-drift visibility: how many selected suites are
   * migration-sensitive (migrations/ folded into their fingerprint) vs
   * insensitive. If the insensitive count collapses toward zero, a
   * widely-imported helper probably grew a DB content marker and every
   * migration merge re-inflates validation time — see DB_PATH_MARKERS /
   * DB_CONTENT_PATTERNS above. Unclassified = fingerprint uncomputable. */
  migrationSensitiveCount: number;
  migrationInsensitiveCount: number;
  migrationUnclassifiedCount: number;
  /** Task #4503: split of the sensitive count — "tables"-scoped suites only
   * re-run when a merged migration touches a table they reference (or is
   * unattributable); "full" suites re-run on every migration change. Drift
   * of the table-scoped share toward zero re-inflates migration merges. */
  migrationTableScopedCount: number;
  migrationFullScopeCount: number;
  /** Task #4595 — REALIZED savings of the #4503 per-table scoping: of the
   * DB-sensitive suites this run SKIPPED (green on identical inputs), how
   * many were table-scoped vs full-scope. On a migration-bearing merge, a
   * table-scoped suite that skipped is a suite the pre-#4503 behavior would
   * have re-executed — trending this count across runs makes a silent drift
   * back toward full-tree re-runs visible without digging into audit files. */
  migrationTableScopedSkippedCount: number;
  migrationFullScopeSkippedCount: number;
  /** Task #4101: closure files carrying a `<build error: …>` this run
   * (file → build-error text). Derived from the fingerprint computation
   * itself — NOT from decision reasons, which run-level execute reasons
   * (force-all, integrity run) and core precedence would mask. */
  poisonedFiles: Record<string, string>;
  /** False when fingerprinting failed wholesale — poisonings were not
   * observable this run, so the poison history must not be reset. */
  poisonObservable: boolean;
  notes: string[];
}

/**
 * Decide which of the selected suites actually need to execute. Never throws:
 * any internal failure produces a plan that executes everything.
 */
export async function planIncrementalRun(opts: {
  suites: SuiteLike[];
  mode: "all" | "smoke" | "regression";
  forceAll: boolean;
  repoRoot?: string;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  coreRules?: CoreRule[];
  /** Task #4560: tracer stall-protection seams, threaded through to
   * computeSuiteFingerprints (tests exercise the timeout fall-open path). */
  traceTimeoutMs?: number;
  traceFn?: typeof traceImportClosures;
}): Promise<IncrementalPlan> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const env = opts.env ?? process.env;
  const storePath = resolve(repoRoot, opts.storePath ?? env.TEST_GREEN_STORE_PATH ?? DEFAULT_GREEN_STORE_PATH);
  const nowMs = (opts.now ?? new Date()).getTime();
  const coreRules = opts.coreRules ?? DEFAULT_CORE_RULES;
  const greenMaxAgeDays = parseDaysEnv(env, "TEST_GREEN_MAX_AGE_DAYS", DEFAULT_GREEN_MAX_AGE_DAYS);
  const fullGreenWindowDays = parseDaysEnv(env, "TEST_FULL_GREEN_WINDOW_DAYS", DEFAULT_FULL_GREEN_WINDOW_DAYS);
  const notes: string[] = [];

  const { store, note: storeNote } = loadGreenStore(storePath);
  if (storeNote) notes.push(storeNote);

  // Load the committed baseline up front: seeding below uses its records,
  // and the plan ALWAYS reports its age (Task #4077 skip-health visibility —
  // a frozen baseline must surface in every run summary, not only when
  // seeding happens).
  const baselinePath = resolve(repoRoot, env.TEST_GREEN_BASELINE_PATH ?? DEFAULT_GREEN_BASELINE_PATH);
  const { baseline, note: baselineNote } = loadGreenBaseline(baselinePath);
  if (baselineNote) notes.push(baselineNote);
  let baselinePublishedAt: string | null = null;
  let baselineAgeDays: number | null = null;
  if (baseline) {
    const t = Date.parse(baseline.publishedAt);
    if (Number.isFinite(t)) {
      baselinePublishedAt = baseline.publishedAt;
      baselineAgeDays = (nowMs - t) / DAY_MS;
    }
  }

  // Seed an absent/empty LOCAL store from the committed baseline (main's
  // published greens). A non-empty local store always wins — seeding never
  // merges into or overwrites real local history (including local failures).
  // lastFullRunGreenAt is deliberately NOT inherited: the mode-"all"
  // integrity guard stays per-environment. TEST_GREEN_SEED_FROM_BASELINE=0
  // opts out.
  if (Object.keys(store.records).length === 0 && env.TEST_GREEN_SEED_FROM_BASELINE !== "0") {
    if (baseline && Object.keys(baseline.records).length > 0) {
      store.records = { ...baseline.records };
      // Materialize the seed so recordRunOutcomes' read-merge-write keeps
      // seeded records for suites this run does not execute.
      try {
        saveGreenStore(storePath, store);
      } catch (err) {
        notes.push(`could not persist baseline seed: ${err instanceof Error ? err.message : String(err)}`);
      }
      notes.push(
        `seeded ${Object.keys(baseline.records).length} green record(s) from committed baseline (published ${baseline.publishedAt})`,
      );
    }
  }

  let skippingDisabledReason: string | null = null;
  if (opts.forceAll) {
    skippingDisabledReason = "force-all requested (--force-all / TEST_FORCE_ALL=1) — executing every suite";
  } else if (opts.mode === "all" && !fullGreenWithinWindow(store, nowMs, fullGreenWindowDays * DAY_MS)) {
    skippingDisabledReason = `no full-suite green within ${fullGreenWindowDays}d in this environment (last: ${store.lastFullRunGreenAt ?? "never"}) — executing every suite as the integrity run`;
  }

  let computation: FingerprintComputation;
  try {
    computation = await computeSuiteFingerprints(opts.suites, repoRoot, {
      traceTimeoutMs: opts.traceTimeoutMs,
      traceFn: opts.traceFn,
      env,
    });
  } catch (err) {
    computation = { ok: false, error: err instanceof Error ? err.message : String(err), bySuite: new Map() };
  }
  if (!computation.ok && !skippingDisabledReason) {
    skippingDisabledReason = `fingerprinting unavailable (${computation.error}) — executing every suite (fall open)`;
  } else if (!computation.ok) {
    notes.push(`fingerprinting unavailable (${computation.error})`);
  }

  // Task #4101: collect build-error poisonings from the computation itself
  // (decision reasons can be masked by run-level execute reasons / core
  // precedence). One poisoned closure member can appear in many suites'
  // reasons — the map dedupes to the offending FILE.
  const poisonedFiles: Record<string, string> = {};
  for (const info of computation.bySuite.values()) {
    if (!info.unskippableReason) continue;
    const hit = extractPoisonFromReason(info.unskippableReason);
    if (hit) poisonedFiles[hit[0]] = hit[1];
  }

  const decisions: SuiteDecision[] = [];
  const executeFiles = new Set<string>();
  const skippedFiles: string[] = [];
  const fingerprints = new Map<string, string | null>();
  let migrationSensitiveCount = 0;
  let migrationInsensitiveCount = 0;
  let migrationUnclassifiedCount = 0;
  let migrationTableScopedCount = 0;
  let migrationFullScopeCount = 0;
  let migrationTableScopedSkippedCount = 0;
  let migrationFullScopeSkippedCount = 0;
  for (const suite of opts.suites) {
    const info = computation.bySuite.get(suite.file);
    if (info?.migrationSensitive === true) {
      migrationSensitiveCount++;
      if (info.migrationScope === "tables") migrationTableScopedCount++;
      else migrationFullScopeCount++;
    } else if (info?.migrationSensitive === false) migrationInsensitiveCount++;
    else migrationUnclassifiedCount++;
    const decision = decideSuite({
      file: suite.file,
      runLevelExecuteReason: skippingDisabledReason,
      coreWhy: coreReason(suite.file, coreRules),
      fingerprint: info?.fingerprint ?? null,
      unskippableReason: info?.unskippableReason ?? (computation.ok ? null : "fingerprinting unavailable"),
      record: store.records[suite.file],
      nowMs,
      greenMaxAgeMs: greenMaxAgeDays * DAY_MS,
    });
    decisions.push(decision);
    fingerprints.set(suite.file, decision.fingerprint);
    if (decision.action === "execute") executeFiles.add(suite.file);
    else {
      skippedFiles.push(suite.file);
      // Task #4595: realized per-table-scoping savings — count skipped
      // DB-sensitive suites by scope (see IncrementalPlan field docs).
      if (info?.migrationSensitive === true) {
        if (info.migrationScope === "tables") migrationTableScopedSkippedCount++;
        else migrationFullScopeSkippedCount++;
      }
    }
  }

  return {
    mode: opts.mode,
    forceAll: opts.forceAll,
    skippingDisabledReason,
    decisions,
    executeFiles,
    skippedFiles,
    fingerprints,
    store,
    storePath,
    greenMaxAgeDays,
    fullGreenWindowDays,
    baselinePublishedAt,
    baselineAgeDays,
    migrationSensitiveCount,
    migrationInsensitiveCount,
    migrationUnclassifiedCount,
    migrationTableScopedCount,
    migrationFullScopeCount,
    migrationTableScopedSkippedCount,
    migrationFullScopeSkippedCount,
    poisonedFiles,
    poisonObservable: computation.ok,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Outcome recording + audit
// ---------------------------------------------------------------------------

export interface SuiteOutcome {
  file: string;
  passed: boolean;
  /** Passed only after an in-suite retry. */
  flaky: boolean;
  durationMs: number;
}

/**
 * Persist run outcomes into the green store. Green is recorded ONLY for a
 * pass with a computed fingerprint; failures overwrite any prior record so a
 * stale green can never mask them. `fullRunGreen` stamps lastFullRunGreenAt
 * and must only be true for a mode-"all" run that executed every selected
 * suite (zero skips) and passed. Never throws.
 */
export function recordRunOutcomes(opts: {
  storePath: string;
  mode: "all" | "smoke" | "regression";
  fingerprints: Map<string, string | null>;
  outcomes: SuiteOutcome[];
  fullRunGreen: boolean;
  now?: Date;
}): void {
  try {
    const now = opts.now ?? new Date();
    const nowIso = now.toISOString();
    // Re-read the store at save time (read-merge-write): a concurrent run may
    // have recorded outcomes since we planned.
    const { store } = loadGreenStore(opts.storePath);
    for (const outcome of opts.outcomes) {
      const fingerprint = opts.fingerprints.get(outcome.file) ?? null;
      if (outcome.passed) {
        if (!fingerprint) continue; // cannot prove inputs — leave any prior record alone
        store.records[outcome.file] = {
          fingerprint,
          verdict: "green",
          flaky: outcome.flaky,
          durationMs: outcome.durationMs,
          recordedAt: nowIso,
          mode: opts.mode,
        };
      } else {
        store.records[outcome.file] = {
          fingerprint: fingerprint ?? "unavailable",
          verdict: "failed",
          flaky: false,
          durationMs: outcome.durationMs,
          recordedAt: nowIso,
          mode: opts.mode,
        };
      }
    }
    if (opts.fullRunGreen) store.lastFullRunGreenAt = nowIso;
    const pruneBefore = now.getTime() - STORE_PRUNE_AGE_DAYS * DAY_MS;
    for (const [file, record] of Object.entries(store.records)) {
      const t = Date.parse(record.recordedAt);
      if (!Number.isFinite(t) || t < pruneBefore) delete store.records[file];
    }
    saveGreenStore(opts.storePath, store);
  } catch (err) {
    // Recording must never take down a run; worst case the next run re-executes.
    console.warn(`[incremental] failed to persist green store: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The one-line summary every run mode prints (required by Task #3791). */
export function formatExecutedSkippedLine(executed: number, skipped: number, deferred = 0): string {
  const base = `executed ${executed}, skipped ${skipped} (green on identical inputs)`;
  // Task #5030 — rotation-day deferral is a THIRD disposition, reported in
  // the same summary line so a deferral-narrowed run can never read like a
  // fully-verified one.
  return deferred > 0
    ? `${base}, deferred ${deferred} (rotation-day full-universe debt → post-merge/nightly lane; NOT verified this run)`
    : base;
}

export function formatIncrementalSummary(plan: IncrementalPlan): string[] {
  const lines: string[] = [];
  lines.push(
    `[incremental] plan: execute ${plan.executeFiles.size}, skip ${plan.skippedFiles.length} of ${plan.decisions.length} selected (store: ${relativeToCwd(plan.storePath)})`,
  );
  if (plan.skippingDisabledReason) lines.push(`[incremental] ${plan.skippingDisabledReason}`);
  // Task #4077 skip-health: baseline age in every summary, so a frozen
  // committed baseline is visible long before it slows anyone down.
  lines.push(
    plan.baselineAgeDays !== null
      ? `[incremental] committed green baseline age ${plan.baselineAgeDays.toFixed(1)}d (published ${plan.baselinePublishedAt})`
      : "[incremental] committed green baseline: absent or unreadable",
  );
  // Task #4437 — unmissable ⚠️ banner when baseline age exceeds the alert
  // threshold (kept in sync with regressionSweepScheduler.ts
  // BASELINE_STALENESS_ALERT_DAYS = 2). A stale baseline forces every task
  // validation to re-execute the full suite instead of using green-skip.
  const BASELINE_STALENESS_WARN_DAYS = 2;
  if (plan.baselineAgeDays !== null && plan.baselineAgeDays > BASELINE_STALENESS_WARN_DAYS) {
    lines.push(
      `[incremental] ⚠️  BASELINE STALE (${plan.baselineAgeDays.toFixed(1)}d) — task validations are re-executing every suite instead of using green-skip. Check the nightly sweep publish arm (TEST_GREEN_BASELINE_PUBLISH).`,
    );
  }
  // Task #4081 classification-drift visibility: surface the sensitive /
  // insensitive split in every summary so a silent collapse of the
  // insensitive set (a widely-imported helper growing a DB marker) is
  // visible long before it slows every migration merge.
  // Task #4503: the sensitive count is further split — only "full-scope"
  // suites re-run on EVERY migration merge; table-scoped suites re-run only
  // when a merged migration touches a table they reference.
  lines.push(
    `[incremental] migration classification: ${plan.migrationSensitiveCount} DB-sensitive (${plan.migrationTableScopedCount} table-scoped, ${plan.migrationFullScopeCount} full-scope), ${plan.migrationInsensitiveCount} insensitive, ${plan.migrationUnclassifiedCount} unclassified of ${plan.decisions.length} selected`,
  );
  // Task #4595 — realized savings of the #4503 per-table migration scoping:
  // how many DB-sensitive suites actually SKIPPED this run, by scope. On a
  // migration-bearing merge the table-scoped skipped count is exactly the
  // set of re-runs the scoping saved; if it trends toward zero while the
  // table-scoped classification count stays high, skipping is regressing
  // (e.g. unattributable migrations) even though classification looks fine.
  lines.push(
    `[incremental] migration-scoping realized skips: ${plan.migrationTableScopedSkippedCount} table-scoped, ${plan.migrationFullScopeSkippedCount} full-scope DB-sensitive suite(s) skipped this run`,
  );
  for (const note of plan.notes) lines.push(`[incremental] note: ${note}`);
  return lines;
}

function relativeToCwd(absPath: string): string {
  const rel = relative(process.cwd(), absPath);
  return rel.startsWith("..") ? absPath : rel;
}

// ---------------------------------------------------------------------------
// Task #4101 — repeat-poison detection.
//
// scripts/lint-test-file-parseability.ts catches `<build error: …>` poisoned
// test files at MERGE time, but the skip audit can still record them at
// RUNTIME in environments where that lint has not run (nightly sweep on main,
// task envs mid-work). A poisoned file makes itself and every dependent suite
// unskippable forever, and until now nothing alerted when the SAME file
// stayed poisoned run after run. A tiny consecutive-run history file tracks
// build-error poisonings across audits; once a file has been poisoned in
// POISON_REPEAT_THRESHOLD consecutive audits the run summary warns loudly,
// naming the file and the build error text. A run where the file is no
// longer poisoned clears its streak.
// ---------------------------------------------------------------------------

export const DEFAULT_POISON_HISTORY_PATH = ".local/state/skip-poison-history.json";
export const POISON_HISTORY_SCHEMA_VERSION = 1;
/** Same file poisoned in this many CONSECUTIVE audits ⇒ loud warning. */
export const POISON_REPEAT_THRESHOLD = 3;

export interface PoisonHistoryEntry {
  /** Consecutive audits in which this file carried a `<build error: …>`. */
  streak: number;
  firstSeenAt: string; // ISO
  lastSeenAt: string; // ISO
  /** The most recent build-error text (truncated). */
  error: string;
}

interface PoisonHistory {
  schemaVersion: number;
  entries: Record<string, PoisonHistoryEntry>;
}

export interface RepeatPoisonWarning {
  file: string;
  streak: number;
  firstSeenAt: string;
  error: string;
}

const POISON_REASON_RE = /^closure member (.+?) has unresolvable import\(s\): (.*)$/s;

/** Extract a build-error poisoning from an unskippable-reason string:
 * [file, errorText], or null. Only genuine `<build error: …>` poisonings
 * count — plain unresolvable imports are a sanctioned pattern (loader shims
 * replace them at runtime) and must not alert. */
export function extractPoisonFromReason(reason: string): [string, string] | null {
  const m = POISON_REASON_RE.exec(reason);
  if (!m || !m[2].includes("<build error")) return null;
  const errText = m[2].length > 400 ? `${m[2].slice(0, 400)}…` : m[2];
  return [m[1], errText];
}

function loadPoisonHistory(absPath: string): PoisonHistory {
  try {
    const parsed = JSON.parse(readFileSync(absPath, "utf8")) as Partial<PoisonHistory> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.schemaVersion !== POISON_HISTORY_SCHEMA_VERSION ||
      typeof parsed.entries !== "object" ||
      parsed.entries === null
    ) {
      return { schemaVersion: POISON_HISTORY_SCHEMA_VERSION, entries: {} };
    }
    return { schemaVersion: POISON_HISTORY_SCHEMA_VERSION, entries: parsed.entries as Record<string, PoisonHistoryEntry> };
  } catch {
    // Missing/corrupt history simply restarts every streak — the warning
    // fires a few runs later, never a crash.
    return { schemaVersion: POISON_HISTORY_SCHEMA_VERSION, entries: {} };
  }
}

/**
 * Fold this run's poisonings into the consecutive-run history and return the
 * files whose streak has reached the threshold. Files NOT poisoned this run
 * have their streak cleared (the whole point is CONSECUTIVE poisoning — a
 * healed file must go quiet immediately). Never throws.
 */
export function updateSkipPoisonHistory(opts: {
  plan: Pick<IncrementalPlan, "poisonedFiles" | "poisonObservable">;
  historyPath?: string;
  threshold?: number;
  now?: Date;
}): { warnings: RepeatPoisonWarning[]; poisonedThisRun: number } {
  const threshold = opts.threshold ?? POISON_REPEAT_THRESHOLD;
  try {
    // Fingerprinting failed wholesale ⇒ poisonings were unobservable this
    // run. Leave the history untouched (neither increment nor reset) — a
    // blind run must not clear a real streak.
    if (!opts.plan.poisonObservable) return { warnings: [], poisonedThisRun: 0 };
    const abs = resolve(opts.historyPath ?? DEFAULT_POISON_HISTORY_PATH);
    const nowIso = (opts.now ?? new Date()).toISOString();
    const history = loadPoisonHistory(abs);
    const poisoned = Object.entries(opts.plan.poisonedFiles);

    const nextEntries: Record<string, PoisonHistoryEntry> = {};
    for (const [file, error] of poisoned) {
      const prior = history.entries[file];
      nextEntries[file] = {
        streak: (prior?.streak ?? 0) + 1,
        firstSeenAt: prior?.firstSeenAt ?? nowIso,
        lastSeenAt: nowIso,
        error,
      };
    }
    // Files absent from this run's poison set are dropped: streak reset.

    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp.${process.pid}`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ schemaVersion: POISON_HISTORY_SCHEMA_VERSION, entries: nextEntries }, null, 2)}\n`,
      "utf8",
    );
    renameSync(tmp, abs);

    const warnings: RepeatPoisonWarning[] = Object.entries(nextEntries)
      .filter(([, e]) => e.streak >= threshold)
      .map(([file, e]) => ({ file, streak: e.streak, firstSeenAt: e.firstSeenAt, error: e.error }))
      .sort((a, b) => a.file.localeCompare(b.file));
    return { warnings, poisonedThisRun: poisoned.length };
  } catch (err) {
    console.warn(
      `[incremental] failed to update skip-poison history: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { warnings: [], poisonedThisRun: 0 };
  }
}

/** Loud, self-explanatory lines for the run summary / sweep log. */
export function formatRepeatPoisonWarnings(warnings: RepeatPoisonWarning[]): string[] {
  if (warnings.length === 0) return [];
  const lines: string[] = [];
  lines.push(
    `[incremental] ⚠ REPEAT-POISONED TEST FILE(S): ${warnings.length} file(s) have carried a <build error> in ${POISON_REPEAT_THRESHOLD}+ consecutive skip audits — they (and every dependent suite) are permanently unskippable until fixed:`,
  );
  for (const w of warnings) {
    lines.push(`[incremental]   ✗ ${w.file} — poisoned ${w.streak} consecutive audit(s) since ${w.firstSeenAt}`);
    lines.push(`[incremental]       ${w.error}`);
  }
  lines.push(
    "[incremental]   Fix the syntax/bundle-mode error (verify with: npx tsx scripts/lint-test-file-parseability.ts).",
  );
  return lines;
}

/** Write the per-suite audit manifest under .local/runs/. Never throws. */
export function writeSkipAudit(
  plan: IncrementalPlan,
  auditPath: string = DEFAULT_SKIP_AUDIT_PATH,
): void {
  try {
    const abs = resolve(auditPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: plan.mode,
          forceAll: plan.forceAll,
          skippingDisabledReason: plan.skippingDisabledReason,
          greenMaxAgeDays: plan.greenMaxAgeDays,
          fullGreenWindowDays: plan.fullGreenWindowDays,
          baselinePublishedAt: plan.baselinePublishedAt,
          baselineAgeDays: plan.baselineAgeDays,
          // Task #4081: migration-classification split — drift toward
          // all-sensitive silently re-inflates validation on migration merges.
          migrationSensitiveCount: plan.migrationSensitiveCount,
          migrationInsensitiveCount: plan.migrationInsensitiveCount,
          migrationUnclassifiedCount: plan.migrationUnclassifiedCount,
          // Task #4503: table-scoped vs full-scope split of the sensitive set.
          migrationTableScopedCount: plan.migrationTableScopedCount,
          migrationFullScopeCount: plan.migrationFullScopeCount,
          // Task #4595: realized skips among DB-sensitive suites, by scope —
          // the per-run measurement of what the #4503 scoping actually saved.
          migrationTableScopedSkippedCount: plan.migrationTableScopedSkippedCount,
          migrationFullScopeSkippedCount: plan.migrationFullScopeSkippedCount,
          // Task #4101: build-error poisonings observed this run (file →
          // error text) — the repeat-poison history is fed from these.
          poisonedFiles: plan.poisonedFiles,
          poisonObservable: plan.poisonObservable,
          lastFullRunGreenAt: plan.store.lastFullRunGreenAt,
          notes: plan.notes,
          executed: plan.executeFiles.size,
          skipped: plan.skippedFiles.length,
          decisions: plan.decisions,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch (err) {
    console.warn(`[incremental] failed to write skip audit: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Task #5030 — rotation-day full-lane deferral.
//
// L3-approved policy revision: when green evidence rotates (merge-heavy day
// bumps suite fingerprints), an ordinary task's blocking gate no longer pays
// the full-universe execution debt. Suites that would execute ONLY because
// their green evidence rotated are DEFERRED to the post-merge/nightly lane
// (which re-executes the full universe continuously and now names culprit
// merge windows — tests/redManifest.ts). The record below is the honest
// "deferred, not verified" trail: deferred suites are excluded from the run,
// NEVER recorded green, and surfaced in the executed/skipped summary line,
// the sweep report (`deferredNotVerified`), and the duration report.
//
// Hard rails (planFullLaneDeferral keeps these suites executing):
//   - related-selected: the diff's import closure reaches them — nothing you
//     touch can dodge its own tests;
//   - core: always-run guard suites (DEFAULT_CORE_RULES — fs-scanning lints
//     and selection/skip-engine guards, invisible to import tracing);
//   - expansion-added / quarantine-re-added: risk-triggered adds this run;
//   - smoke-only (regression !== true): the nightly lane would never run
//     them, so deferring would mean NEVER verified anywhere;
//   - extraNodeArgs suites: special-harness registrations stay in the gate
//     (conservative — their harness wiring is exactly what rotation-day
//     batching tends to break).
//
// Reason gate (review-hardened): beyond the rails, deferral requires the
// suite's incremental DECISION to be positively classified stale green
// evidence — executeReasonKind "stale-rotation" (inputs changed since a real
// green) or "stale-expired" (real green past max age), which both imply the
// current fingerprint computed successfully. Suites executing because they
// have NO green record, their last run FAILED, their closure is poisoned or
// unfingerprintable ("unskippable"/"no-fingerprint"), a run-level execute
// reason is active ("run-level" — force-all, integrity run, wholesale
// fingerprint fall-open), or the kind is unknown are NEVER deferred: they
// were never verified (or are known-broken), so there is no evidence debt to
// hand the nightly lane — they must run here.
// ---------------------------------------------------------------------------

/** Where the deferral record for the latest run is written (repo-relative). */
export const FULL_LANE_DEFERRAL_PATH = ".local/runs/full-lane-deferred.json";

/** Per-suite inputs to the deferral decision — resolved by tests/run-all.ts. */
export interface FullLaneDeferralCandidate {
  file: string;
  /** Incremental plan says this suite must execute (not green-skipped). */
  mustExecute: boolean;
  /** The related-selection manifest (mode "related") selected this suite. */
  relatedSelected: boolean;
  /** An always-run core rule matched (coreReason !== null). */
  core: boolean;
  /** Blast-radius expansion added this suite this run. */
  expansionAdded: boolean;
  /** The gate-red quarantine override re-added this suite this run. */
  quarantineReAdded: boolean;
  /** Registered regression: true — a member of the nightly-lane universe. */
  regression: boolean;
  /** Registration carries extraNodeArgs (special harness flags). */
  hasExtraNodeArgs: boolean;
  /** WHY the incremental plan executes this suite (SuiteDecision
   * .executeReasonKind; null when unknown). Deferral is gated on the two
   * positively-stale kinds — everything else fails closed to executing. */
  executeReasonKind: SuiteExecuteReasonKind | null;
}

export interface FullLaneDeferralPlan {
  /** Suites deferred to the post-merge/nightly lane (sorted). */
  deferredFiles: string[];
  /** Why each must-execute suite was KEPT executing (first matching rail). */
  keptExecuting: {
    relatedSelected: number;
    core: number;
    expansionAdded: number;
    quarantineReAdded: number;
    /** regression !== true — the nightly lane would never run them. */
    smokeOnly: number;
    extraNodeArgs: number;
    /** No green record in this environment — never verified anywhere, so
     * there is no evidence debt to defer (Task #5030 review). */
    noRecord: number;
    /** Last recorded outcome was a failure — known-broken suites always
     * execute in the blocking gate. */
    lastFailed: number;
    /** Execute reason not deferrable: run-level fall-opens, uncomputable or
     * poisoned closures, core kinds reaching here, unknown/null kinds. */
    notDeferrable: number;
  };
  /** Candidates the incremental plan already green-skips (not deferred —
   * green-skip is a stronger, evidence-backed disposition). */
  greenSkipped: number;
}

/**
 * Pure deferral planner. A suite is deferred ⟺ it must execute, NO
 * keep-executing rail applies (not related-selected, not core, not
 * expansion/quarantine-added, registered regression: true, no
 * extraNodeArgs), AND its execute reason is positively-identified stale
 * green evidence (executeReasonKind "stale-rotation" or "stale-expired").
 * Any other kind — no-record, last-failed, run-level fall-opens,
 * uncomputable/poisoned closures, unknown/null — keeps executing (fail
 * closed). Rails and reason buckets are checked in the order listed in
 * `keptExecuting` and each kept suite is tallied under the FIRST match.
 */
export function planFullLaneDeferral(candidates: FullLaneDeferralCandidate[]): FullLaneDeferralPlan {
  const plan: FullLaneDeferralPlan = {
    deferredFiles: [],
    keptExecuting: {
      relatedSelected: 0,
      core: 0,
      expansionAdded: 0,
      quarantineReAdded: 0,
      smokeOnly: 0,
      extraNodeArgs: 0,
      noRecord: 0,
      lastFailed: 0,
      notDeferrable: 0,
    },
    greenSkipped: 0,
  };
  for (const c of candidates) {
    if (!c.mustExecute) {
      plan.greenSkipped++;
    } else if (c.relatedSelected) {
      plan.keptExecuting.relatedSelected++;
    } else if (c.core) {
      plan.keptExecuting.core++;
    } else if (c.expansionAdded) {
      plan.keptExecuting.expansionAdded++;
    } else if (c.quarantineReAdded) {
      plan.keptExecuting.quarantineReAdded++;
    } else if (!c.regression) {
      plan.keptExecuting.smokeOnly++;
    } else if (c.hasExtraNodeArgs) {
      plan.keptExecuting.extraNodeArgs++;
    } else if (c.executeReasonKind === "no-record") {
      plan.keptExecuting.noRecord++;
    } else if (c.executeReasonKind === "last-failed") {
      plan.keptExecuting.lastFailed++;
    } else if (c.executeReasonKind === "stale-rotation" || c.executeReasonKind === "stale-expired") {
      plan.deferredFiles.push(c.file);
    } else {
      // Fail closed (Task #5030 review): "run-level" (wholesale fingerprint
      // fall-open, integrity runs, force-all), "unskippable"/"no-fingerprint"
      // (poisoned or uncomputable closures), stray "core", and any
      // unknown/future kind are NEVER deferrable — deferral requires
      // positively-identified staleness of real green evidence.
      plan.keptExecuting.notDeferrable++;
    }
  }
  plan.deferredFiles.sort((a, b) => a.localeCompare(b));
  return plan;
}

/** Build the deferral candidates exactly as tests/run-all.ts wires them: one
 * candidate per selected suite, joining the incremental plan's per-suite
 * DECISION (mustExecute + executeReasonKind) with the keep-executing rail
 * facts. Exported so behavioral tests exercise the REAL classification path
 * from planIncrementalRun decisions into planFullLaneDeferral, not a
 * reimplementation of it. */
export function deferralCandidatesFromPlan(opts: {
  plan: Pick<IncrementalPlan, "decisions" | "executeFiles">;
  suites: { file: string; regression?: boolean; extraNodeArgs?: string[] }[];
  relatedFiles: ReadonlySet<string>;
  expansionAddedFiles: ReadonlySet<string>;
  quarantineReAddedFiles: ReadonlySet<string>;
  coreRules: CoreRule[];
}): FullLaneDeferralCandidate[] {
  const decisionByFile = new Map(opts.plan.decisions.map((d) => [d.file, d] as const));
  return opts.suites.map((t) => ({
    file: t.file,
    mustExecute: opts.plan.executeFiles.has(t.file),
    relatedSelected: opts.relatedFiles.has(t.file),
    core: coreReason(t.file, opts.coreRules) !== null,
    expansionAdded: opts.expansionAddedFiles.has(t.file),
    quarantineReAdded: opts.quarantineReAddedFiles.has(t.file),
    regression: t.regression === true,
    hasExtraNodeArgs: (t.extraNodeArgs?.length ?? 0) > 0,
    // Fail closed: a suite with no decision row yields null → never
    // deferrable in planFullLaneDeferral.
    executeReasonKind: decisionByFile.get(t.file)?.executeReasonKind ?? null,
  }));
}

/** The honest on-disk "deferred, not verified" record for the latest run. */
export interface FullLaneDeferralRecord {
  generatedAt: string;
  /** Why deferral engaged (human-readable — green-evidence rotation). */
  reason: string;
  /** `generatedAt` of the related-selection manifest backing the diff scope,
   * null when unavailable. */
  selectionManifestGeneratedAt: string | null;
  deferredFiles: string[];
  keptExecuting: FullLaneDeferralPlan["keptExecuting"];
  greenSkipped: number;
}

/** Write the deferral record. Never throws — the record is evidence, and a
 * bookkeeping failure must not break the gate run that produced it. */
export function writeFullLaneDeferralRecord(
  record: FullLaneDeferralRecord,
  recordPath: string = FULL_LANE_DEFERRAL_PATH,
): void {
  try {
    const abs = resolve(recordPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[deferral] failed to write ${recordPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
