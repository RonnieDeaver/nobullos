// @db-pool-intent: worker
//
// Task #4640 — automated dev/prod database catalog drift detection.
//
// Automates the one-off manual sweep in audits/safe-migrations-sweep-2026-08-12.md
// (Task #4625): if a future `drizzle push` strips a raw-SQL object from dev
// (the 0085 incident class) while its migration is unlisted, the next Publish
// diff would propose dropping it from production. This service catches that
// BEFORE Publish by comparing the production catalog against a dev-published
// catalog snapshot every night.
//
// Architecture (two lanes, one scheduler entry point):
//   1. DEV LANE (main workspace only, never deployments, never task-env
//      sub-environment clones — structural detectSubEnvironment gate, fail
//      closed): periodically captures the dev DB catalog (public-schema
//      pg_tables + pg_indexes + pg_constraint), computes the SAFE_MIGRATIONS
//      "pending intentional drop" exclusion set from repo files, and uploads
//      the snapshot JSON to private object storage (the established
//      cross-environment channel — see appBackup). The deployment bundle
//      contains neither scripts/ nor migrations/, so ALL repo-file parsing
//      happens on the dev side and travels inside the snapshot.
//   2. PROD LANE (deployment-gated, cross-instance singleton, nightly):
//      downloads the dev snapshot, captures the production catalog locally,
//      and alerts through the standard notify dispatch (dedupe-keyed, never
//      silent) when prod has a table/index/constraint dev lacks — excluding
//      objects net-dropped by listed SAFE_MIGRATIONS files (pending
//      intentional Publish drops). A missing or stale (>7 d) dev snapshot is
//      itself an alert, so a dead publisher cannot silently blind the check.
//
// Only the prod→dev direction alerts: dev legitimately carries hundreds of
// dev-only objects (schema source runs ahead of prod between Publishes).
//
// Kill switches (system settings, both default ON — this is a safety net):
//   schema_drift_check_enabled            — prod comparator lane
//   schema_drift_snapshot_publish_enabled — dev publisher lane
// Local/test override: SCHEMA_DRIFT_FORCE_ENABLE=1 bypasses the deployment
// gate (comparator) — tests inject deps instead of hitting real stores.

import { runWithWorkerDb, getDb, withDbAttribution } from "../db";
import { sql } from "drizzle-orm";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { getSystemSetting } from "../storage/settingsStorage";
import { registerModuleStateResetForTest } from "./moduleStateReset";
import fs from "node:fs";

const SINGLETON_KEY = "schema_drift_check";
export const SCHEMA_DRIFT_CHECK_ENABLED_SETTING = "schema_drift_check_enabled";
export const SCHEMA_DRIFT_PUBLISH_ENABLED_SETTING =
  "schema_drift_snapshot_publish_enabled";
export const SCHEMA_DRIFT_NOTIFICATION_ID = "infra.schema_drift.prod_only_objects";
export const SCHEMA_DRIFT_DEDUPE_KEY = "schema_drift:nightly";
/**
 * Task #4749 — durable last-run stamp. A CLEAN nightly run used to leave no
 * durable evidence (no notification_deliveries row, markRecovered no-ops
 * without a prior unhealthy row, and the "Nightly check clean" log line was
 * dropped in a platform log flood — see
 * audits/schema-drift-prod-verification-2026-08-14.md). Every comparator
 * tick (clean or not, including kill-switch skips) now upserts a small JSON
 * stamp into system_settings so an operator can answer "did the check run
 * last night?" without grepping deployment logs:
 *
 *   SELECT value FROM system_settings WHERE key = 'schema_drift_check_last_run';
 *
 * The stamp itself is staleness-alertable via the in-process watchdog below
 * (dedupe key schema_drift:last_run_stale) — never-silent, matching the
 * snapshot_stale philosophy.
 */
export const SCHEMA_DRIFT_LAST_RUN_SETTING = "schema_drift_check_last_run";
export const SCHEMA_DRIFT_LAST_RUN_STALE_DEDUPE_KEY = "schema_drift:last_run_stale";
/** Stamp older than this alerts (2× the nightly cadence — one missed tick). */
export const LAST_RUN_MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** Object-storage key (under PRIVATE_OBJECT_DIR) for the dev snapshot. */
export const SCHEMA_DRIFT_SNAPSHOT_KEY = "schema-drift/dev-catalog-snapshot.json";
/** Snapshot older than this is untrustworthy — alert instead of comparing. */
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // nightly comparator
const LAST_RUN_WATCHDOG_INTERVAL_MS = 6 * 60 * 60 * 1000; // stamp staleness watchdog
const PUBLISH_INTERVAL_MS = 6 * 60 * 60 * 1000; // dev publisher refresh
/** Cap object names listed in the alert text (full list in metadata). */
const ALERT_LIST_CAP = 25;

// ─────────────────────────── Pure catalog/diff logic ───────────────────────────

export interface CatalogIndex {
  name: string;
  table: string;
}
export interface CatalogConstraint {
  name: string;
  table: string;
}
export interface Catalog {
  tables: string[];
  indexes: CatalogIndex[];
  constraints: CatalogConstraint[];
}
export interface DevCatalogSnapshot extends Catalog {
  version: 1;
  capturedAt: string; // ISO
  /** Tables net-dropped by listed SAFE_MIGRATIONS files (pending Publish drops). */
  pendingDropTables: string[];
  /** Index names net-dropped (directly, or implicitly via their table). */
  pendingDropIndexes: string[];
}
export interface DriftDiff {
  prodOnlyTables: string[];
  prodOnlyIndexes: string[];
  prodOnlyConstraints: string[];
}

/**
 * SAFE_MIGRATIONS SQL parsing — regexes kept in LOCKSTEP with
 * scripts/post-merge-instrument.mjs (parseSafeMigrations / stripSqlComments /
 * extractObjectOps). Only idempotent forms count (IF NOT EXISTS / IF EXISTS):
 * those are exactly the raw-SQL objects the post-merge trio manages. The net
 * here is the INVERSE of computeProtectedObjects: we want objects the listed
 * files net-DROP (dropped and not re-created later in array order) — the
 * intentional pending Publish drops the comparator must not alert on.
 */
export function parseSafeMigrationsList(shContent: string): string[] {
  const m = shContent.match(/SAFE_MIGRATIONS=\(([\s\S]*?)\n\)/);
  if (!m) throw new Error("SAFE_MIGRATIONS array not found in post-merge.sh");
  const entries = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (entries.length === 0) throw new Error("SAFE_MIGRATIONS array parsed empty");
  return entries;
}

function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function cleanName(raw: unknown): string | null {
  const n = String(raw ?? "").trim().replaceAll('"', "");
  return /^[A-Za-z0-9_.]+$/.test(n) ? n : null;
}

function lastSegment(name: string): string {
  return name.split(".").pop() as string;
}

interface ObjectOp {
  kind: "table" | "index";
  name: string;
  onTable?: string;
}

export function extractObjectOps(sqlText: string): {
  creates: ObjectOp[];
  drops: ObjectOp[];
} {
  const clean = stripSqlComments(sqlText);
  const creates: ObjectOp[] = [];
  const drops: ObjectOp[] = [];
  for (const m of clean.matchAll(
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+("?[A-Za-z0-9_.]+"?)/gi,
  )) {
    const name = cleanName(m[1]);
    if (name) creates.push({ kind: "table", name });
  }
  for (const m of clean.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\s+("?[A-Za-z0-9_.]+"?)\s+ON\s+(?:ONLY\s+)?("?[A-Za-z0-9_.]+"?)/gi,
  )) {
    const name = cleanName(m[1]);
    const onTable = cleanName(m[2]) ?? undefined;
    if (name) creates.push({ kind: "index", name, onTable });
  }
  for (const m of clean.matchAll(
    /DROP\s+TABLE\s+IF\s+EXISTS\s+([A-Za-z0-9_.",\s]+?)(?=CASCADE|RESTRICT|;)/gi,
  )) {
    for (const part of m[1].split(",")) {
      const name = cleanName(part);
      if (name) drops.push({ kind: "table", name });
    }
  }
  for (const m of clean.matchAll(
    /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?IF\s+EXISTS\s+([A-Za-z0-9_.",\s]+?)(?=CASCADE|RESTRICT|;)/gi,
  )) {
    for (const part of m[1].split(",")) {
      const name = cleanName(part);
      if (name) drops.push({ kind: "index", name });
    }
  }
  return { creates, drops };
}

/**
 * Objects net-DROPPED after applying the listed SQL contents in array order:
 * a DROP joins the set, a later CREATE of the same name leaves it. A dropped
 * table also nets out every index we know sits on it (created earlier in the
 * corpus), mirroring PostgreSQL's implicit index removal.
 */
export function computePendingDrops(sqlContents: string[]): {
  tables: Set<string>;
  indexes: Set<string>;
} {
  const droppedTables = new Set<string>();
  const droppedIndexes = new Set<string>();
  /** name -> onTable for every index created so far (for implicit drops). */
  const knownIndexes = new Map<string, string | undefined>();
  for (const sqlText of sqlContents) {
    const { creates, drops } = extractObjectOps(sqlText);
    for (const c of creates) {
      if (c.kind === "table") droppedTables.delete(lastSegment(c.name));
      else {
        droppedIndexes.delete(lastSegment(c.name));
        knownIndexes.set(c.name, c.onTable);
      }
    }
    for (const d of drops) {
      if (d.kind === "table") {
        droppedTables.add(lastSegment(d.name));
        for (const [idxName, onTable] of knownIndexes) {
          if (onTable && lastSegment(onTable) === lastSegment(d.name)) {
            droppedIndexes.add(lastSegment(idxName));
          }
        }
      } else {
        droppedIndexes.add(lastSegment(d.name));
      }
    }
  }
  return { tables: droppedTables, indexes: droppedIndexes };
}

/**
 * Prod-only objects (prod has, dev lacks), minus the pending intentional
 * drops carried in the dev snapshot. Constraint identity is table-qualified
 * (`table.conname`) — constraint names alone are not unique. Constraints and
 * indexes on pending-drop tables are excluded with their table.
 */
export function diffCatalogs(prod: Catalog, dev: DevCatalogSnapshot): DriftDiff {
  const devTables = new Set(dev.tables);
  const pendingTables = new Set(dev.pendingDropTables);
  const pendingIndexes = new Set(dev.pendingDropIndexes);
  const prodOnlyTables = prod.tables.filter(
    (t) => !devTables.has(t) && !pendingTables.has(t),
  );
  const devIndexes = new Set(dev.indexes.map((i) => i.name));
  const prodOnlyIndexes = prod.indexes
    .filter(
      (i) =>
        !devIndexes.has(i.name) &&
        !pendingIndexes.has(i.name) &&
        !pendingTables.has(i.table),
    )
    .map((i) => `${i.table}.${i.name}`);
  const devConstraints = new Set(dev.constraints.map((c) => `${c.table}.${c.name}`));
  const prodOnlyConstraints = prod.constraints
    .filter(
      (c) =>
        !devConstraints.has(`${c.table}.${c.name}`) &&
        !pendingTables.has(c.table) &&
        // A prod-only TABLE's constraints are implied by the table finding —
        // don't triple-report them (matches the manual audit's grouping).
        !prodOnlyTables.includes(c.table),
    )
    .map((c) => `${c.table}.${c.name}`);
  return { prodOnlyTables, prodOnlyIndexes, prodOnlyConstraints };
}

export function isDriftEmpty(d: DriftDiff): boolean {
  return (
    d.prodOnlyTables.length === 0 &&
    d.prodOnlyIndexes.length === 0 &&
    d.prodOnlyConstraints.length === 0
  );
}

// ─────────────────────────── Injectable IO seams ───────────────────────────

export interface SchemaDriftDeps {
  captureCatalog(): Promise<Catalog>;
  /** null = snapshot object absent. */
  loadDevSnapshot(): Promise<DevCatalogSnapshot | null>;
  publishSnapshot(snapshot: DevCatalogSnapshot): Promise<void>;
  /** null = file absent (repo files never exist in the deployment bundle). */
  readRepoFile(relPath: string): string | null;
  notify(
    payload: { text: string; preview?: unknown },
    options: Record<string, unknown>,
  ): Promise<{ delivered: boolean; status: string; skipReason?: string }>;
  markRecovered(): Promise<void>;
  /** Clear a prior last-run-stale alert once the stamp is fresh again. */
  markLastRunStaleRecovered(): Promise<void>;
  /** Upsert the last-run stamp JSON (system_settings). */
  persistLastRunStamp(json: string): Promise<void>;
  /** Raw persisted stamp value, or null when never written. */
  readLastRunStamp(): Promise<string | null>;
  now(): Date;
}

async function defaultCaptureCatalog(): Promise<Catalog> {
  return runWithWorkerDb(() => withDbAttribution("worker:schema_drift_catalog", async () => {
    const db = getDb();
    const tablesRes = await db.execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const indexesRes = await db.execute(
      sql`SELECT indexname, tablename FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
    );
    const constraintsRes = await db.execute(sql`
      SELECT con.conname AS conname, rel.relname AS tablename
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public'
      ORDER BY rel.relname, con.conname
    `);
    return {
      tables: (tablesRes.rows as any[]).map((r) => String(r.tablename)),
      indexes: (indexesRes.rows as any[]).map((r) => ({
        name: String(r.indexname),
        table: String(r.tablename),
      })),
      constraints: (constraintsRes.rows as any[]).map((r) => ({
        name: String(r.conname),
        table: String(r.tablename),
      })),
    };
  }));
}

async function defaultLoadDevSnapshot(): Promise<DevCatalogSnapshot | null> {
  const { ObjectStorageService, ObjectNotFoundError } = await import(
    "../replit_integrations/object_storage/objectStorage"
  );
  const svc = new ObjectStorageService();
  try {
    const buf = await svc.downloadPrivateKeyToBuffer(SCHEMA_DRIFT_SNAPSHOT_KEY);
    return JSON.parse(buf.toString("utf8")) as DevCatalogSnapshot;
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return null;
    throw err;
  }
}

async function defaultPublishSnapshot(snapshot: DevCatalogSnapshot): Promise<void> {
  const { ObjectStorageService } = await import(
    "../replit_integrations/object_storage/objectStorage"
  );
  const { Readable } = await import("node:stream");
  const svc = new ObjectStorageService();
  await svc.streamUploadToPrivateKey(
    SCHEMA_DRIFT_SNAPSHOT_KEY,
    Readable.from(Buffer.from(JSON.stringify(snapshot), "utf8")),
    "application/json",
  );
}

function defaultReadRepoFile(relPath: string): string | null {
  try {
    if (!fs.existsSync(relPath)) return null;
    return fs.readFileSync(relPath, "utf8");
  } catch {
    return null;
  }
}

async function defaultNotify(
  payload: { text: string; preview?: unknown },
  options: Record<string, unknown>,
) {
  const { notifyByType } = await import("./notifications/dispatcher");
  return notifyByType(SCHEMA_DRIFT_NOTIFICATION_ID, payload, options as any);
}

async function defaultMarkRecovered(): Promise<void> {
  const { markRecovered } = await import("./notifications/dispatcher");
  await markRecovered(SCHEMA_DRIFT_NOTIFICATION_ID, SCHEMA_DRIFT_DEDUPE_KEY);
}

async function defaultMarkLastRunStaleRecovered(): Promise<void> {
  const { markRecovered } = await import("./notifications/dispatcher");
  await markRecovered(
    SCHEMA_DRIFT_NOTIFICATION_ID,
    SCHEMA_DRIFT_LAST_RUN_STALE_DEDUPE_KEY,
  );
}

async function defaultPersistLastRunStamp(json: string): Promise<void> {
  // updatedBy deliberately omitted — system_settings.updated_by is an FK to
  // users.id; machine writes store NULL (settingsStorage coerces synthetics).
  const { setSystemSetting } = await import("../storage/settingsStorage");
  await setSystemSetting(SCHEMA_DRIFT_LAST_RUN_SETTING, json);
}

async function defaultReadLastRunStamp(): Promise<string | null> {
  const row = await getSystemSetting(SCHEMA_DRIFT_LAST_RUN_SETTING);
  const v = row?.value;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

let deps: SchemaDriftDeps = {
  captureCatalog: defaultCaptureCatalog,
  loadDevSnapshot: defaultLoadDevSnapshot,
  publishSnapshot: defaultPublishSnapshot,
  readRepoFile: defaultReadRepoFile,
  notify: defaultNotify,
  markRecovered: defaultMarkRecovered,
  markLastRunStaleRecovered: defaultMarkLastRunStaleRecovered,
  persistLastRunStamp: defaultPersistLastRunStamp,
  readLastRunStamp: defaultReadLastRunStamp,
  now: () => new Date(),
};
const defaultDeps = deps;

/** Test seam — replace IO deps; module reset restores defaults. */
export function __setSchemaDriftTestDeps(overrides: Partial<SchemaDriftDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

// ─────────────────────────── Dev lane: snapshot publish ───────────────────────────

/**
 * Compute the pending-drop exclusion set from repo files. Throws when
 * scripts/post-merge.sh can't be read/parsed — the publisher must not upload
 * a snapshot with silently-empty exclusions (that would page on every
 * intentional pending drop). Missing individual migration files are
 * tolerated (same [-f] tolerance as the bash loop).
 */
export function computePendingDropsFromRepo(
  readRepoFile: (rel: string) => string | null,
): { tables: string[]; indexes: string[] } {
  const sh = readRepoFile("scripts/post-merge.sh");
  if (!sh) throw new Error("scripts/post-merge.sh not readable");
  const files = parseSafeMigrationsList(sh);
  const contents: string[] = [];
  for (const rel of files) {
    const content = readRepoFile(rel);
    if (content !== null) contents.push(content);
  }
  const { tables, indexes } = computePendingDrops(contents);
  return { tables: [...tables].sort(), indexes: [...indexes].sort() };
}

export async function publishDevSnapshot(): Promise<DevCatalogSnapshot> {
  const pending = computePendingDropsFromRepo(deps.readRepoFile);
  const catalog = await deps.captureCatalog();
  const snapshot: DevCatalogSnapshot = {
    version: 1,
    capturedAt: deps.now().toISOString(),
    ...catalog,
    pendingDropTables: pending.tables,
    pendingDropIndexes: pending.indexes,
  };
  await deps.publishSnapshot(snapshot);
  console.log(
    `[SchemaDrift] Dev catalog snapshot published (${catalog.tables.length} tables, ` +
      `${catalog.indexes.length} indexes, ${catalog.constraints.length} constraints, ` +
      `${pending.tables.length} pending-drop tables)`,
  );
  return snapshot;
}

// ─────────────────────────── Prod lane: nightly comparison ───────────────────────────

function capList(items: string[]): string {
  const head = items.slice(0, ALERT_LIST_CAP).join(", ");
  return items.length > ALERT_LIST_CAP
    ? `${head} … (+${items.length - ALERT_LIST_CAP} more)`
    : head;
}

// ───────────────────────── Durable last-run stamp (Task #4749) ─────────────────────────

export type LastRunStampOutcome =
  | "clean"
  | "drift"
  | "snapshot_missing"
  | "snapshot_stale"
  | "check_error"
  | "skipped_kill_switch";

export interface SchemaDriftLastRunStamp {
  /** ISO timestamp of the comparator tick. */
  ranAt: string;
  outcome: LastRunStampOutcome;
  /** Small human-readable context (drift counts / error message). */
  detail?: string;
}

/**
 * Best-effort stamp write — a persistence failure must never fail (or mask)
 * the comparator tick itself. Warn-only, mirroring the *_last_run family.
 */
async function writeLastRunStamp(
  outcome: LastRunStampOutcome,
  detail?: string,
): Promise<void> {
  const stamp: SchemaDriftLastRunStamp = {
    ranAt: deps.now().toISOString(),
    outcome,
    ...(detail ? { detail } : {}),
  };
  try {
    await deps.persistLastRunStamp(JSON.stringify(stamp));
  } catch (err: any) {
    console.warn(
      "[SchemaDrift] Failed to persist last-run stamp:",
      err?.message ?? err,
    );
  }
}

export type LastRunReadStatus = "ok" | "never_run" | "unreadable";

const LAST_RUN_STAMP_OUTCOMES: ReadonlySet<string> = new Set<LastRunStampOutcome>([
  "clean",
  "drift",
  "snapshot_missing",
  "snapshot_stale",
  "check_error",
  "skipped_kill_switch",
]);

/** Tolerated forward clock skew before a future ranAt counts as corrupt. */
export const LAST_RUN_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Strict stamp validation — the watchdog's corrupt-stamp detection is only
 * as good as this. Unknown outcome values, non-ISO/unparseable timestamps,
 * and materially-future timestamps (beyond clock skew) are all `unreadable`:
 * a fabricated or mangled stamp must alert, never suppress staleness.
 */
function validateStamp(
  parsed: unknown,
  now: Date,
): { ok: true; stamp: SchemaDriftLastRunStamp } | { ok: false; error: string } {
  const p = parsed as Partial<SchemaDriftLastRunStamp> | null;
  if (!p || typeof p !== "object") return { ok: false, error: "stamp is not an object" };
  if (typeof p.outcome !== "string" || !LAST_RUN_STAMP_OUTCOMES.has(p.outcome)) {
    return { ok: false, error: `unknown outcome ${JSON.stringify(p.outcome ?? null)}` };
  }
  if (typeof p.ranAt !== "string") return { ok: false, error: "ranAt missing" };
  const t = Date.parse(p.ranAt);
  // Round-trip equality pins strict ISO-8601 (what writeLastRunStamp emits) —
  // rejects "yesterday"-style parseable-but-non-ISO strings.
  if (!Number.isFinite(t) || new Date(t).toISOString() !== p.ranAt) {
    return { ok: false, error: `ranAt not a valid ISO timestamp: ${JSON.stringify(p.ranAt)}` };
  }
  if (t - now.getTime() > LAST_RUN_FUTURE_SKEW_MS) {
    return { ok: false, error: `ranAt is in the future: ${p.ranAt}` };
  }
  return { ok: true, stamp: p as SchemaDriftLastRunStamp };
}

/**
 * Read + classify the persisted last-run stamp: `never_run` (key absent —
 * normal before the first deployed tick) vs `unreadable` (persisted value
 * corrupt — a real persistence bug) vs `ok`.
 */
export async function readLastSchemaDriftRun(): Promise<{
  status: LastRunReadStatus;
  lastRun: SchemaDriftLastRunStamp | null;
  error?: string;
}> {
  let raw: string | null;
  try {
    raw = await deps.readLastRunStamp();
  } catch (err: any) {
    return {
      status: "unreadable",
      lastRun: null,
      error: `read failed: ${String(err?.message ?? err)}`,
    };
  }
  if (raw === null) return { status: "never_run", lastRun: null };
  try {
    const v = validateStamp(JSON.parse(raw), deps.now());
    if (!v.ok) return { status: "unreadable", lastRun: null, error: v.error };
    return { status: "ok", lastRun: v.stamp };
  } catch (err: any) {
    return {
      status: "unreadable",
      lastRun: null,
      error: `parse failed: ${String(err?.message ?? err)}`,
    };
  }
}

export type DriftCheckOutcome =
  | { kind: "clean" }
  | { kind: "drift"; diff: DriftDiff }
  | { kind: "snapshot_missing" }
  | { kind: "snapshot_stale"; ageMs: number }
  | { kind: "check_error"; message: string };

/**
 * One comparator run. Every non-clean outcome dispatches through
 * notifyByType with the stable dedupe key and an outcome-specific
 * failureType (dedupe re-alerts immediately when the failure class
 * changes; same class re-reminds on the dispatcher's interval). Errors
 * are alerted too — this check is never silent. Dispatch resolves, never
 * throws; the return value is for tests/logging.
 */
export async function runSchemaDriftCheck(): Promise<DriftCheckOutcome> {
  let outcome: DriftCheckOutcome;
  try {
    const snapshot = await deps.loadDevSnapshot();
    if (!snapshot) {
      outcome = { kind: "snapshot_missing" };
    } else {
      const ageMs = deps.now().getTime() - Date.parse(snapshot.capturedAt);
      if (!Number.isFinite(ageMs) || ageMs > SNAPSHOT_MAX_AGE_MS) {
        outcome = { kind: "snapshot_stale", ageMs };
      } else {
        const prod = await deps.captureCatalog();
        const diff = diffCatalogs(prod, snapshot);
        outcome = isDriftEmpty(diff) ? { kind: "clean" } : { kind: "drift", diff };
      }
    }
  } catch (err: any) {
    outcome = { kind: "check_error", message: String(err?.message ?? err) };
  }

  // Durable proof-of-run FIRST (Task #4749): the stamp records every tick —
  // clean or not — even if a notify dispatch below misbehaves.
  let stampDetail: string | undefined;
  if (outcome.kind === "drift") {
    const { diff } = outcome;
    stampDetail =
      `prod-only: ${diff.prodOnlyTables.length} tables, ` +
      `${diff.prodOnlyIndexes.length} indexes, ${diff.prodOnlyConstraints.length} constraints`;
  } else if (outcome.kind === "check_error") {
    stampDetail = outcome.message;
  } else if (outcome.kind === "snapshot_stale") {
    stampDetail = `snapshot ${Math.round(outcome.ageMs / 86_400_000)}d old`;
  }
  await writeLastRunStamp(outcome.kind, stampDetail);

  const base = {
    triggerSource: "alert_service",
    dedupeKey: SCHEMA_DRIFT_DEDUPE_KEY,
  };
  switch (outcome.kind) {
    case "clean":
      try {
        await deps.markRecovered();
      } catch (err: any) {
        console.warn("[SchemaDrift] markRecovered failed:", err?.message ?? err);
      }
      console.log("[SchemaDrift] Nightly check clean — no prod-only objects");
      break;
    case "drift": {
      const { diff } = outcome;
      const lines = [
        "🚨 Dev/prod schema drift: production has catalog objects the dev DB lacks. " +
          "The next Publish diff may propose DROPPING them from production " +
          "(0085 incident class — a drizzle push likely stripped a raw-SQL object " +
          "whose migration is not listed in SAFE_MIGRATIONS).",
      ];
      if (diff.prodOnlyTables.length > 0)
        lines.push(`Tables (${diff.prodOnlyTables.length}): ${capList(diff.prodOnlyTables)}`);
      if (diff.prodOnlyIndexes.length > 0)
        lines.push(`Indexes (${diff.prodOnlyIndexes.length}): ${capList(diff.prodOnlyIndexes)}`);
      if (diff.prodOnlyConstraints.length > 0)
        lines.push(
          `Constraints (${diff.prodOnlyConstraints.length}): ${capList(diff.prodOnlyConstraints)}`,
        );
      lines.push(
        "Fix: restore the object in dev (SAFE_MIGRATIONS re-apply / new migration) " +
          "or, if the drop is intentional, ship it in a listed SAFE_MIGRATIONS file.",
      );
      await deps.notify(
        { text: lines.join("\n"), preview: diff },
        { ...base, failureType: "prod_only_objects", metadata: { diff } },
      );
      break;
    }
    case "snapshot_missing":
      await deps.notify(
        {
          text:
            "⚠️ Dev/prod schema drift check cannot run: no dev catalog snapshot in object storage " +
            `(${SCHEMA_DRIFT_SNAPSHOT_KEY}). The main workspace publisher ` +
            "(schema_drift_snapshot_publish_enabled) has not published — drift would go unseen.",
        },
        { ...base, failureType: "snapshot_missing" },
      );
      break;
    case "snapshot_stale":
      await deps.notify(
        {
          text:
            "⚠️ Dev/prod schema drift check is blind: the dev catalog snapshot is " +
            `${Math.round(outcome.ageMs / 86_400_000)} days old (max ${Math.round(
              SNAPSHOT_MAX_AGE_MS / 86_400_000,
            )}d). The main workspace publisher has stopped refreshing it.`,
        },
        { ...base, failureType: "snapshot_stale", metadata: { ageMs: outcome.ageMs } },
      );
      break;
    case "check_error":
      await deps.notify(
        {
          text: `⚠️ Dev/prod schema drift check FAILED to run: ${outcome.message}`,
        },
        { ...base, failureType: "check_error", metadata: { message: outcome.message } },
      );
      break;
  }
  return outcome;
}

// ───────────────────── Last-run stamp staleness watchdog (Task #4749) ─────────────────────

export type LastRunWatchdogVerdict =
  | "fresh"
  | "stale"
  | "never_run"
  | "unreadable";

/**
 * One watchdog pass over the last-run stamp. Alerts (deduped, own dedupe
 * key + failureType so it never collides with the nightly drift alert) when
 * the stamp is missing, corrupt, or older than {@link LAST_RUN_MAX_AGE_MS};
 * marks the episode recovered when fresh. In-process like the comparator
 * interval — it catches a hung/lost comparator tick in a live deployment
 * (full-process death = deployment down, covered by platform monitoring).
 */
export async function runLastRunStalenessWatchdogOnce(): Promise<LastRunWatchdogVerdict> {
  const read = await readLastSchemaDriftRun();
  const base = {
    triggerSource: "alert_service",
    dedupeKey: SCHEMA_DRIFT_LAST_RUN_STALE_DEDUPE_KEY,
  };
  if (read.status === "unreadable") {
    await deps.notify(
      {
        text:
          "⚠️ Schema-drift check last-run stamp is UNREADABLE " +
          `(${SCHEMA_DRIFT_LAST_RUN_SETTING}): ${read.error ?? "unknown"}. ` +
          "The persisted proof-of-run is corrupt — fix the persistence path.",
      },
      { ...base, failureType: "last_run_unreadable", metadata: { error: read.error } },
    );
    return "unreadable";
  }
  if (read.status === "never_run") {
    // The boot-time comparator tick writes the stamp well before the first
    // 6h watchdog fire — never_run at watchdog time means it never completed.
    await deps.notify(
      {
        text:
          "⚠️ Schema-drift check has NEVER recorded a run " +
          `(${SCHEMA_DRIFT_LAST_RUN_SETTING} absent) although the deployment has been ` +
          "up long enough for the boot tick. The comparator may be dead or unable to persist.",
      },
      { ...base, failureType: "last_run_missing" },
    );
    return "never_run";
  }
  const ageMs = deps.now().getTime() - Date.parse(read.lastRun!.ranAt);
  if (!Number.isFinite(ageMs) || ageMs > LAST_RUN_MAX_AGE_MS) {
    await deps.notify(
      {
        text:
          "⚠️ Schema-drift check last ran " +
          `${Number.isFinite(ageMs) ? Math.round(ageMs / 3_600_000) + "h" : "an unparseable time"} ago ` +
          `(max ${Math.round(LAST_RUN_MAX_AGE_MS / 3_600_000)}h; last outcome: ` +
          `${read.lastRun!.outcome}). The nightly comparator tick has stopped running.`,
      },
      {
        ...base,
        failureType: "last_run_stale",
        metadata: { ageMs, lastOutcome: read.lastRun!.outcome },
      },
    );
    return "stale";
  }
  try {
    await deps.markLastRunStaleRecovered();
  } catch (err: any) {
    console.warn(
      "[SchemaDrift] markLastRunStaleRecovered failed:",
      err?.message ?? err,
    );
  }
  return "fresh";
}

// ─────────────────────────── Scheduler lifecycle ───────────────────────────

let checkTimer: ReturnType<typeof setInterval> | null = null;
let publishTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let checkRunning = false;
let publishRunning = false;
let watchdogRunning = false;

function isForceEnabled(): boolean {
  const v = process.env.SCHEMA_DRIFT_FORCE_ENABLE;
  return v === "1" || v === "true";
}

/** Default ON — only an explicit falsy value pauses (this is a safety net). */
async function isSettingEnabled(key: string): Promise<boolean> {
  try {
    const s = await getSystemSetting(key);
    const v = (s?.value ?? "true").toLowerCase();
    return !(v === "false" || v === "0" || v === "no" || v === "off");
  } catch {
    return true; // settings hiccup must not blind the drift check
  }
}

async function checkTick(): Promise<void> {
  if (checkRunning) return;
  checkRunning = true;
  try {
    if (!(await isSettingEnabled(SCHEMA_DRIFT_CHECK_ENABLED_SETTING))) {
      console.log("[SchemaDrift] Kill switch off — skipping comparator tick");
      // A paused check still stamps: operators see "skipped_kill_switch",
      // not a stale stamp masquerading as a dead scheduler (Task #4749).
      await writeLastRunStamp("skipped_kill_switch");
      return;
    }
    await runSchemaDriftCheck();
  } catch (err: any) {
    // runSchemaDriftCheck alerts its own errors; this guards the guard.
    console.warn("[SchemaDrift] comparator tick failed:", err?.message ?? err);
  } finally {
    checkRunning = false;
  }
}

async function watchdogTick(): Promise<void> {
  if (watchdogRunning) return;
  watchdogRunning = true;
  try {
    await runLastRunStalenessWatchdogOnce();
  } catch (err: any) {
    console.warn("[SchemaDrift] last-run watchdog tick failed:", err?.message ?? err);
  } finally {
    watchdogRunning = false;
  }
}

async function publishTick(): Promise<void> {
  if (publishRunning) return;
  publishRunning = true;
  try {
    if (!(await isSettingEnabled(SCHEMA_DRIFT_PUBLISH_ENABLED_SETTING))) {
      console.log("[SchemaDrift] Publish kill switch off — skipping snapshot publish");
      return;
    }
    await publishDevSnapshot();
  } catch (err: any) {
    // A dead publisher surfaces loudly via the prod lane's snapshot_stale
    // alert within SNAPSHOT_MAX_AGE_MS — warn locally, no dev-side alert.
    console.warn("[SchemaDrift] snapshot publish failed:", err?.message ?? err);
  } finally {
    publishRunning = false;
  }
}

/**
 * Environment-branching entry point (called from schedulerInits):
 *  - deployment (or SCHEMA_DRIFT_FORCE_ENABLE=1): nightly comparator under
 *    the cross-instance singleton lock;
 *  - main dev workspace (structurally NOT a task-env sub-environment, fail
 *    closed): periodic snapshot publisher. Task-env clones must never
 *    overwrite the snapshot with a diverged clone catalog.
 */
export async function startSchemaDriftScheduler(): Promise<void> {
  if (isRunningInDeployment() || isForceEnabled()) {
    if (checkTimer) return;
    void withWorkerSingletonLock(SINGLETON_KEY, () => checkTick());
    checkTimer = setInterval(
      () => void withWorkerSingletonLock(SINGLETON_KEY, () => checkTick()),
      CHECK_INTERVAL_MS,
    );
    // Stamp-staleness watchdog: no boot fire (the boot tick above refreshes
    // the stamp), first pass at +6h. Multi-instance double-fires collapse via
    // the dispatcher's dedupe key — no singleton lock needed for a read+notify.
    watchdogTimer = setInterval(() => void watchdogTick(), LAST_RUN_WATCHDOG_INTERVAL_MS);
    console.log(
      `[SchemaDrift] Comparator scheduled nightly (kill switch: ${SCHEMA_DRIFT_CHECK_ENABLED_SETTING})`,
    );
    return;
  }
  // Workspace side — publisher lane.
  if (process.env.NODE_ENV === "test") return; // never touch real stores from suites
  const { detectSubEnvironment } = await import("./regressionSweepScheduler");
  if (detectSubEnvironment()) {
    console.log(
      "[SchemaDrift] Task sub-environment detected — snapshot publisher disabled (main workspace only)",
    );
    return;
  }
  if (publishTimer) return;
  void publishTick();
  publishTimer = setInterval(() => void publishTick(), PUBLISH_INTERVAL_MS);
  console.log(
    `[SchemaDrift] Dev snapshot publisher scheduled every ${PUBLISH_INTERVAL_MS / 3_600_000}h ` +
      `(kill switch: ${SCHEMA_DRIFT_PUBLISH_ENABLED_SETTING})`,
  );
}

export function stopSchemaDriftScheduler(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  if (publishTimer) {
    clearInterval(publishTimer);
    publishTimer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

registerModuleStateResetForTest("schemaDriftCheck", () => {
  stopSchemaDriftScheduler();
  checkRunning = false;
  publishRunning = false;
  watchdogRunning = false;
  deps = defaultDeps;
});
