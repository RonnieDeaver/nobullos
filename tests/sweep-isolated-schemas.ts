/**
 * Task #b65e9824 — Sweep leftover isolated test schemas (`test_iso_*`)
 * from the shared dev database.
 *
 * Why this exists
 * ---------------
 * `runInIsolatedSchema` (tests/db-sandbox.ts) DROPs its schema in a
 * `finally`, but a test child that is SIGKILL'd mid-flight (timeout kill,
 * OOM, operator Ctrl-C) never reaches that finally. Historical legacy
 * shared-dev runs (the retired TEST_SHARED_DEV_DB=1 mode) orphaned such
 * schemas into the shared Helium dev DB, where they accumulate. Because each one contains `LIKE public.*
 * INCLUDING ALL` clones of real tables — including their constraints —
 * they have already fooled a schema-unqualified presence check into
 * believing a dropped `public` constraint was still in place, silently
 * skipping the restore and breaking a later check in every full sweep.
 *
 * The sweeper runs at test-runner start (tests/run-all.ts) against the
 * shared dev DB and drops isolated test schemas older than MAX_AGE_MS
 * (1 day). Schema names embed their creation time
 * (`test_iso_<epoch-ms base36>_<rand>`, see tests/db-sandbox.ts); names
 * in the pre-timestamp legacy format (`test_iso_<12 hex>`) can only have
 * been minted by pre-change code, so they are treated as old and dropped
 * too. Anything under `test_iso_` that matches neither shape is left
 * alone and reported — the sweeper never guesses at unknown objects.
 *
 * The sweep is best-effort: any failure is logged and swallowed so it
 * can never block a test run. It is DDL against throwaway schemas only —
 * `public` is never touched.
 */
import { Pool } from "pg";

export const ISO_SCHEMA_PREFIX = "test_iso_";
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** New timestamped format: test_iso_<epoch-ms base36>_<rand a-z0-9>. */
const TIMESTAMPED_RE = /^test_iso_([0-9a-z]+)_[0-9a-z]+$/;
/** Legacy format (pre-timestamp): test_iso_<12 hex chars from a UUID>. */
const LEGACY_RE = /^test_iso_[0-9a-f]{12}$/;

/**
 * Parse the creation epoch-ms embedded in a timestamped isolated-schema
 * name. Returns null for legacy or unrecognized names, and rejects
 * implausible decodes (base36 garbage that happens to parse) by requiring
 * the timestamp to land between 2020 and 100 years from `now`.
 */
export function parseIsoSchemaTimestamp(
  name: string,
  now: number = Date.now(),
): number | null {
  const m = TIMESTAMPED_RE.exec(name);
  if (!m) return null;
  const ts = parseInt(m[1], 36);
  if (!Number.isFinite(ts)) return null;
  const MIN = Date.UTC(2020, 0, 1);
  const MAX = now + 100 * 365 * 24 * 60 * 60 * 1000;
  if (ts < MIN || ts > MAX) return null;
  return ts;
}

export type SweepDecision = "drop-expired" | "drop-legacy" | "keep-fresh" | "keep-unrecognized";

/**
 * Pure classification: what should happen to a schema with this name?
 *  - timestamped + older than maxAgeMs  → drop-expired
 *  - timestamped + fresh                → keep-fresh (a live run may own it)
 *  - legacy 12-hex format               → drop-legacy (only pre-change code
 *                                          minted these; nothing live can)
 *  - anything else under the prefix     → keep-unrecognized (never guess)
 */
export function classifyIsoSchema(
  name: string,
  now: number = Date.now(),
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): SweepDecision {
  const ts = parseIsoSchemaTimestamp(name, now);
  if (ts !== null) return now - ts > maxAgeMs ? "drop-expired" : "keep-fresh";
  if (LEGACY_RE.test(name)) return "drop-legacy";
  return "keep-unrecognized";
}

/** Minimal query surface so the core is testable without a live DB. */
export interface SweepExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface SweepResult {
  dropped: string[];
  kept: string[];
  unrecognized: string[];
  errors: { schema: string; message: string }[];
}

/**
 * Core sweep against an injected executor. Lists `test_iso_*` schemas,
 * classifies each, and DROP ... CASCADEs the droppable ones one at a time
 * (a failure on one schema never blocks the rest).
 */
export async function sweepIsolatedSchemas(
  exec: SweepExecutor,
  opts: { now?: number; maxAgeMs?: number } = {},
): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const res = await exec.query(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`,
    [`${ISO_SCHEMA_PREFIX}%`],
  );
  const result: SweepResult = { dropped: [], kept: [], unrecognized: [], errors: [] };
  for (const row of res.rows) {
    const name: string = row.nspname;
    // Defense in depth: only ever DROP identifiers in our safe alphabet.
    if (!/^[a-z0-9_]+$/.test(name)) {
      result.unrecognized.push(name);
      continue;
    }
    const decision = classifyIsoSchema(name, now, maxAgeMs);
    if (decision === "keep-fresh") {
      result.kept.push(name);
    } else if (decision === "keep-unrecognized") {
      result.unrecognized.push(name);
    } else {
      try {
        await exec.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
        result.dropped.push(name);
      } catch (err) {
        result.errors.push({ schema: name, message: (err as Error)?.message ?? String(err) });
      }
    }
  }
  return result;
}

/**
 * Best-effort entry point for the test runner: opens a short-lived
 * single-connection pool to `connectionString`, sweeps, logs a one-line
 * summary, and NEVER throws — a sweep failure must not block a test run.
 */
export async function sweepLeftoverIsolatedSchemas(
  connectionString: string,
  opts: { maxAgeMs?: number } = {},
): Promise<SweepResult | null> {
  const pool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: 10_000,
    application_name: "nobull-test-iso-sweeper",
  });
  try {
    const result = await sweepIsolatedSchemas(pool, opts);
    const bits = [
      `dropped ${result.dropped.length}`,
      `kept ${result.kept.length} fresh`,
    ];
    if (result.unrecognized.length > 0) bits.push(`left ${result.unrecognized.length} unrecognized`);
    if (result.errors.length > 0) bits.push(`${result.errors.length} error(s)`);
    if (result.dropped.length > 0 || result.unrecognized.length > 0 || result.errors.length > 0) {
      console.log(`[iso-schema-sweep] ${bits.join(", ")}`);
      for (const d of result.dropped) console.log(`[iso-schema-sweep]   dropped ${d}`);
      for (const u of result.unrecognized)
        console.warn(`[iso-schema-sweep]   left unrecognized schema ${u} (manual review)`);
      for (const e of result.errors)
        console.warn(`[iso-schema-sweep]   failed to drop ${e.schema}: ${e.message}`);
    }
    return result;
  } catch (err) {
    console.warn(
      `[iso-schema-sweep] sweep failed (non-fatal): ${(err as Error)?.message ?? String(err)}`,
    );
    return null;
  } finally {
    await pool.end().catch(() => {});
  }
}
