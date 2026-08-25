/**
 * Task #4552 — refresh the DEV database from the newest production backup.
 *
 * Restores the latest prod `pg_dump` artifact (written daily by the Task
 * #2657 app-backup producer to private Object Storage under
 * `backups/<date>/database-<stamp>.sql.gz`) into the DEV database, then
 * verifies every restored report is fully populated
 * (`scripts/verify-report-completeness.ts`) and flushes the shared Redis
 * caches so stale pre-restore values cannot be re-latched.
 *
 * This tool is DESTRUCTIVE on its target: it drops and recreates the
 * `public` schema, plus any schemas the dump itself creates (prod carries
 * `_system` and `stripe` — leaving them in place would abort the dump's own
 * CREATE SCHEMA under ON_ERROR_STOP). It is built to be impossible to aim
 * at production:
 *
 *   1. Refuses to run inside a deployment (`REPLIT_DEPLOYMENT === "1"`).
 *   2. Refuses any target on a Neon host or named `neondb` — prod is Neon
 *      `neondb`; dev is Helium `heliumdb` (mirrors the test-mode guard in
 *      `server/db.ts`). Unparseable connection strings are refused outright.
 *   3. Requires the explicit `--confirm-refresh-dev` flag.
 *   4. Refuses to start while OTHER connections are active on the target
 *      (a running dev app self-heals "missing" tables mid-restore, which
 *      collides with the dump's CREATE TABLE under ON_ERROR_STOP) — stop
 *      the "Start application" workflow first.
 *
 * The dump enumerates Object Storage DIRECTLY (`backups/2…` date prefix) —
 * NOT the `app_backup_runs` table, which is itself part of the stale dev
 * data this tool exists to replace. The restore streams gunzip → `psql -v
 * ON_ERROR_STOP=1` over the direct (non-pooled) connection with the
 * password passed via PG* env vars (`pgEnvFromConnString`, shared with the
 * backup producer) so it never appears in argv.
 *
 * Usage (on the MAIN dev workspace, with the app workflow STOPPED):
 *
 *   npx tsx scripts/refresh-dev-db-from-backup.ts --confirm-refresh-dev
 *   npx tsx scripts/refresh-dev-db-from-backup.ts --confirm-refresh-dev \
 *     --dump-key=backups/2026-08-10/database-2026-08-10T08-00-01-123Z.sql.gz
 *
 * Exit codes: 0 = restored + report-completeness PASS; 1 = restore or
 * completeness failure; 2 = usage (missing confirm flag); 3 = refused
 * (deployment / Neon target / busy target).
 *
 * NOTE: running this in a task environment refreshes only that
 * environment's private DB clone. The real dev refresh must be executed on
 * the main workspace. Full runbook: BACKUPS.md §7.1.
 */

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Client } from "pg";

// ─── Pure guard helpers (unit-tested in tests/refresh-dev-db-guards.test.ts) ───
//
// These are deliberately free of any project imports so the guard test can
// import this module without touching DB pools, Object Storage, or env.

/** Refusal distinct from operational failure — CLI exits 3, not 1. */
export class RefreshRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefreshRefusedError";
  }
}

/** The restore DESTROYS its target; a deployment run would aim it at prod. */
export function assertNotInDeployment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.REPLIT_DEPLOYMENT === "1") {
    throw new RefreshRefusedError(
      "refusing to run inside a deployment (REPLIT_DEPLOYMENT=1) — this tool DROPS the target " +
        "database's public schema and must only ever run against dev.",
    );
  }
}

/**
 * Refuse any target that is (or even smells like) production. Prod is Neon
 * `neondb`; dev is Helium `heliumdb`. Mirrors the test-mode guard shape in
 * `server/db.ts` (raw substring checks + parsed hostname/pathname), and
 * fails CLOSED: an unparseable connection string is refused rather than
 * trusted.
 */
export function assertRefreshTargetSafe(
  rawUrl: string | null | undefined,
): void {
  if (!rawUrl) {
    throw new RefreshRefusedError(
      "no target connection string resolved — set DATABASE_URL (resolution order mirrors " +
        "server/db.ts: DATABASE_URL_MIGRATIONS ?? DATABASE_URL_DIRECT ?? DATABASE_URL).",
    );
  }
  // Raw substring checks run FIRST so a Neon marker is refused even when the
  // string is not URL-parseable.
  if (rawUrl.includes("neon.tech")) {
    throw new RefreshRefusedError(
      "target connection string references a neon.tech host — that is PRODUCTION (Neon). " +
        "This tool only restores into the Helium dev database.",
    );
  }
  if (rawUrl.includes("neondb")) {
    throw new RefreshRefusedError(
      "target connection string references the `neondb` database — that is PRODUCTION. " +
        "This tool only restores into the Helium dev database (heliumdb).",
    );
  }
  let hostname = "";
  let pathname = "";
  try {
    const u = new URL(rawUrl);
    hostname = u.hostname;
    pathname = u.pathname;
  } catch {
    throw new RefreshRefusedError(
      "target connection string is not a parseable URL — refusing to aim a destructive " +
        "restore at an unverifiable target.",
    );
  }
  if (hostname.endsWith("neon.tech")) {
    throw new RefreshRefusedError(
      `target host ${hostname} is a Neon host — that is PRODUCTION. Refusing.`,
    );
  }
  if (pathname === "/neondb") {
    throw new RefreshRefusedError(
      "target database is named `neondb` — that is PRODUCTION. Refusing.",
    );
  }
}

export interface RefreshArgs {
  confirmed: boolean;
  dumpKey: string | null;
}

export function parseRefreshArgs(argv: string[]): RefreshArgs {
  let confirmed = false;
  let dumpKey: string | null = null;
  for (const arg of argv) {
    if (arg === "--confirm-refresh-dev") confirmed = true;
    else if (arg.startsWith("--dump-key=")) {
      dumpKey = arg.slice("--dump-key=".length);
    }
  }
  return { confirmed, dumpKey };
}

/**
 * Database dumps live at `backups/<YYYY-MM-DD>/database-<runStamp>.sql.gz`
 * (see `runAppBackup` in server/services/appBackup.ts). The pattern excludes
 * the per-day `…/file-manifest.json.gz` manifests and the content-addressed
 * `backups/files/<hash>/<gen>` archive objects.
 */
export const DUMP_KEY_RE =
  /^backups\/\d{4}-\d{2}-\d{2}\/database-.+\.sql\.gz$/;

/** Only ever restore a real database dump — never a manifest or file blob. */
export function assertDumpKeyRestorable(key: string): void {
  if (!DUMP_KEY_RE.test(key)) {
    throw new RefreshRefusedError(
      `--dump-key=${key} is not a database dump (expected backups/<YYYY-MM-DD>/database-*.sql.gz).`,
    );
  }
}

/**
 * Pick the newest dump by key. Both the date folder and the in-name run
 * stamp are ISO-8601, so plain lexicographic order IS chronological order —
 * including two runs on the same day (a manual "Run backup now" press after
 * the scheduled 04:00 run sorts after it).
 */
export function pickNewestDump(
  objects: ReadonlyArray<{ objectKey: string }>,
): string {
  const dumps = objects
    .map((o) => o.objectKey)
    .filter((k) => DUMP_KEY_RE.test(k))
    .sort();
  if (dumps.length === 0) {
    throw new Error(
      "no database dumps found under backups/<date>/ in Object Storage — has the daily " +
        "prod backup (Task #2657) run yet? Check /admin/backups in prod.",
    );
  }
  return dumps[dumps.length - 1];
}

/**
 * PG15+ dumps of a database whose `public` schema was re-created carry their
 * own `CREATE SCHEMA public;` — restoring one into a freshly created public
 * schema would abort under ON_ERROR_STOP with "schema already exists". The
 * head peek decides whether WE create the schema after dropping it.
 */
export function dumpHeadCreatesPublicSchema(headText: string): boolean {
  return /^CREATE SCHEMA (IF NOT EXISTS )?public;/m.test(headText);
}

/**
 * Non-public schemas the dump itself creates (`CREATE SCHEMA foo;`) — prod
 * carries `_system` (Replit migration bookkeeping) and `stripe`. Each must
 * be dropped before the restore or its CREATE SCHEMA aborts under
 * ON_ERROR_STOP; the dump then recreates it with prod's content. System
 * schemas are never returned (defense in depth — pg_dump never emits them).
 */
export function parseDumpHeadExtraSchemas(headText: string): string[] {
  const out: string[] = [];
  const re =
    /^CREATE SCHEMA (?:IF NOT EXISTS )?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*));/gm;
  for (const m of headText.matchAll(re)) {
    const name = m[1] ?? m[2];
    if (!name || name === "public") continue;
    if (name.startsWith("pg_") || name === "information_schema") continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// ─── Operational pieces (heavy project imports stay DYNAMIC — the guard test
//     must be able to import this module without side effects) ───

/** Must match `flushEnvNamespacesOnBoot` in server/services/cache/redisCache.ts. */
const CACHE_NAMESPACES_TO_FLUSH = [
  "system_settings",
  "integration_status",
  "integration_status_epoch",
] as const;

const log = (msg: string) => console.log(`[dev-refresh] ${msg}`);

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Terminate every other backend on the target and REFUSE if anything
 * reconnects within the settle window. A running dev app would race the
 * restore — its 42P01 self-heal re-creates "missing" tables that collide
 * with the dump's CREATE TABLE under ON_ERROR_STOP. Called twice: a fast
 * pre-download check (fail before minutes of download) and the
 * authoritative gate immediately before the drop. Returns a db@host label.
 */
async function ensureExclusiveTarget(
  targetUrl: string,
  phase: string,
): Promise<string> {
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const ident = await client.query(
      "select current_database() as db, inet_server_addr()::text as host",
    );
    const dbLabel = `${ident.rows[0]?.db ?? "?"}@${ident.rows[0]?.host ?? "local"}`;
    await client.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()`,
    );
    await sleep(1500);
    const busy = await client.query(
      `select count(*)::int as n,
              coalesce(string_agg(distinct nullif(application_name, ''), ', '), '(unnamed)') as apps
         from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()`,
    );
    const busyN: number = busy.rows[0]?.n ?? 0;
    if (busyN > 0) {
      throw new RefreshRefusedError(
        `target database still has ${busyN} other active connection(s) [${busy.rows[0]?.apps}] ` +
          `after termination (${phase}) — stop the "Start application" workflow (and any DB ` +
          `shells), then re-run. Nothing was dropped.`,
      );
    }
    return dbLabel;
  } finally {
    await client.end();
  }
}

function fmtMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Gunzip just the head of the downloaded dump for the schema peek. */
function gunzipHead(gzPath: string, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const rs = createReadStream(gzPath);
    const gz = createGunzip();
    let text = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(text);
      rs.destroy();
      gz.destroy();
    };
    gz.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length >= maxBytes) finish();
    });
    gz.on("end", finish);
    gz.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    rs.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    rs.pipe(gz);
  });
}

/** Stream gunzip(dump) into `psql -v ON_ERROR_STOP=1` (password via PG* env). */
function restoreDumpWithPsql(
  env: NodeJS.ProcessEnv,
  gzPath: string,
  gzBytes: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], {
      env,
      stdio: ["pipe", "inherit", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const fileStream = createReadStream(gzPath);
    const gunzip = createGunzip();
    const progress = setInterval(() => {
      const pct =
        gzBytes > 0 ? Math.round((fileStream.bytesRead / gzBytes) * 100) : 0;
      log(`  … restoring (${pct}% of dump streamed into psql)`);
    }, 15000);
    progress.unref();
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(progress);
      fileStream.destroy();
      gunzip.destroy();
      reject(err);
    };
    child.stderr!.on("data", (c) => {
      if (stderr.length < 16000) stderr += c.toString();
    });
    child.on("error", fail);
    child.on("close", (code) => {
      clearInterval(progress);
      // Stop pumping bytes into a finished psql either way.
      fileStream.destroy();
      gunzip.destroy();
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `psql (restore) exited with code ${code}: ${stderr.trim().slice(0, 4000)}`,
          ),
        );
    });
    // EPIPE lands here when psql aborts mid-stream — the close handler above
    // reports the real (stderr-bearing) error instead.
    child.stdin!.on("error", () => {});
    fileStream.on("error", (err) => {
      child.stdin!.destroy();
      fail(err);
    });
    gunzip.on("error", (err) => {
      child.stdin!.destroy();
      fail(new Error(`gunzip failed: ${err.message}`));
    });
    fileStream.pipe(gunzip).pipe(child.stdin!);
  });
}

/** Run a single SQL command through psql (same env conventions as the restore). */
function runPsqlCommand(env: NodeJS.ProcessEnv, sql: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "psql",
      ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { env, stdio: ["ignore", "inherit", "pipe"] },
    );
    let stderr = "";
    child.stderr!.on("data", (c) => {
      if (stderr.length < 8000) stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `psql -c ${JSON.stringify(sql.slice(0, 60))} exited ${code}: ${stderr.trim().slice(0, 2000)}`,
          ),
        );
    });
  });
}

async function runRefresh(): Promise<number> {
  const args = parseRefreshArgs(process.argv.slice(2));

  // Guards run BEFORE the confirm-flag check — a refusal must fire even on a
  // fully confirmed invocation.
  assertNotInDeployment();
  const targetUrl =
    process.env.DATABASE_URL_MIGRATIONS ??
    process.env.DATABASE_URL_DIRECT ??
    process.env.DATABASE_URL;
  assertRefreshTargetSafe(targetUrl);

  if (!args.confirmed) {
    console.error(
      [
        "refresh-dev-db-from-backup: DESTRUCTIVE — drops and recreates the dev DB's `public`",
        "schema, then restores the newest production backup dump from Object Storage.",
        "",
        "  Run it with the explicit confirmation flag:",
        "    npx tsx scripts/refresh-dev-db-from-backup.ts --confirm-refresh-dev",
        "",
        "  Optional: --dump-key=backups/<YYYY-MM-DD>/database-<stamp>.sql.gz to restore a",
        "  specific (older) dump instead of the newest one.",
        "",
        "  Stop the \"Start application\" workflow first; restart it afterwards.",
        "  Runbook: BACKUPS.md §7.1",
      ].join("\n"),
    );
    return 2;
  }
  if (args.dumpKey) assertDumpKeyRestorable(args.dumpKey);

  const startedAt = Date.now();

  // 0. Load every heavy project module up front: imports warm DB pools (and
  //    may touch the target), so ALL module loading happens before the
  //    exclusivity checks and the destructive window — never inside it.
  const [
    { ObjectStorageService },
    { pgEnvFromConnString },
    { setPoolEpicSwitchOverrideInMemory },
    { cacheDelByPrefix },
  ] = await Promise.all([
    import("../server/replit_integrations/object_storage"),
    import("../server/services/appBackup"),
    import("../server/services/poolEpicSwitchState"),
    import("../server/services/cache/redisCache"),
  ]);

  // Fast-fail while nothing is downloaded yet; the authoritative re-check
  // runs again immediately before the drop.
  const dbLabel = await ensureExclusiveTarget(targetUrl!, "pre-download check");
  log(`target database: ${dbLabel}`);

  // 1. Enumerate the backups/ prefix directly in Object Storage. The digit
  //    prefix ("backups/2…" — date folders) skips the unbounded
  //    content-addressed `backups/files/` archive entirely.
  log("listing database dumps in Object Storage (backups/<date>/) …");
  const objectStorage = new ObjectStorageService();
  const objects = await objectStorage.listPrivateObjectsByPrefix("backups/2");
  const dumpKey = args.dumpKey ?? pickNewestDump(objects);
  const dumpMeta = objects.find((o) => o.objectKey === dumpKey);
  if (args.dumpKey && !dumpMeta) {
    throw new Error(`--dump-key=${args.dumpKey} not found in Object Storage.`);
  }
  const gzSize = dumpMeta?.sizeBytes ?? null;
  log(
    `newest dump: ${dumpKey}${gzSize != null ? ` (${fmtMb(gzSize)} gzipped)` : ""}`,
  );

  // 2. Download to a temp file (os.tmpdir — outside the repo so no workflow
  //    watcher or git litter), so a flaky download can never half-feed psql.
  const tmpDir = await mkdtemp(path.join(tmpdir(), "dev-refresh-"));
  try {
    const gzPath = path.join(tmpDir, "dump.sql.gz");
    const t0 = Date.now();
    const ws = createWriteStream(gzPath);
    const dlProgress = setInterval(() => {
      log(
        `  … downloading (${fmtMb(ws.bytesWritten)}${gzSize != null ? ` of ${fmtMb(gzSize)}` : ""})`,
      );
    }, 10000);
    dlProgress.unref();
    try {
      const rs = await objectStorage.createPrivateObjectReadStream(dumpKey);
      await pipeline(rs, ws);
    } finally {
      clearInterval(dlProgress);
    }
    const gzBytes = (await stat(gzPath)).size;
    const downloadSecs = Math.round((Date.now() - t0) / 1000);
    log(`downloaded ${fmtMb(gzBytes)} in ${downloadSecs}s`);

    // 3. Peek the dump head: PG15+ dumps carry their own CREATE SCHEMA
    //    public, and prod's dump creates extra schemas (_system, stripe)
    //    that must be dropped before the restore.
    const headText = await gunzipHead(gzPath, 256 * 1024);
    const dumpCreatesSchema = dumpHeadCreatesPublicSchema(headText);
    const extraSchemas = parseDumpHeadExtraSchemas(headText);
    log(
      `dump ${dumpCreatesSchema ? "creates schema public itself" : "does NOT create schema public (script will)"}` +
        `${extraSchemas.length > 0 ? `; also creates schema(s): ${extraSchemas.join(", ")}` : ""}`,
    );

    // 4. Authoritative exclusivity gate immediately before the destructive
    //    window.
    await ensureExclusiveTarget(targetUrl!, "pre-drop check");

    // 5. Clean slate. Everything up to here was non-destructive.
    const client = new Client({ connectionString: targetUrl });
    await client.connect();
    try {
      log(
        `dropping schema public${extraSchemas.length > 0 ? ` + dump-created schema(s) ${extraSchemas.join(", ")}` : ""} (clean-slate restore) …`,
      );
      await client.query("drop schema if exists public cascade");
      for (const schema of extraSchemas) {
        await client.query(
          `drop schema if exists ${quoteIdent(schema)} cascade`,
        );
      }
      if (!dumpCreatesSchema) {
        await client.query("create schema public");
      }
    } finally {
      await client.end();
    }

    // 6. Restore: gunzip → psql -v ON_ERROR_STOP=1 on the direct (non-pooled)
    //    connection, password via PG* env (shared producer convention).
    const psqlEnv = pgEnvFromConnString(targetUrl!);
    log("restoring dump via psql (ON_ERROR_STOP=1) …");
    const tRestore = Date.now();
    await restoreDumpWithPsql(psqlEnv, gzPath, gzBytes);
    const restoreSecs = Math.round((Date.now() - tRestore) / 1000);
    log(`restore applied cleanly in ${restoreSecs}s`);

    // 7. ANALYZE so the first post-restore queries don't run on a
    //    statistics-free database.
    log("running ANALYZE …");
    await runPsqlCommand(psqlEnv, "ANALYZE");

    // 8. Verify: table inventory + report completeness sweep.
    const verify = new Client({ connectionString: targetUrl });
    await verify.connect();
    let sweepOk = false;
    let tableCount = 0;
    try {
      const tables = await verify.query(
        "select count(*)::int as n from pg_tables where schemaname = 'public'",
      );
      tableCount = tables.rows[0]?.n ?? 0;
      const { runReportCompletenessSweep, printCompletenessResult } =
        await import("./verify-report-completeness");
      const sweep = await runReportCompletenessSweep(verify);
      printCompletenessResult(sweep);
      sweepOk = sweep.ok;
    } finally {
      await verify.end();
    }

    // 9. Flush shared Redis caches (settings + integration status) so
    //    pre-restore values can't stay pinned or get re-latched by SWR
    //    hydration. The kill switch defaults OFF in a bare script process, so
    //    force it on IN MEMORY first — otherwise cacheDel silently no-ops.
    setPoolEpicSwitchOverrideInMemory("redis_cache_enabled", true);
    for (const ns of CACHE_NAMESPACES_TO_FLUSH) {
      const n = await cacheDelByPrefix(ns);
      log(
        `redis flush: ${ns} — ${n} key(s) deleted` +
          (n === 0 ? " (0 = empty, or Redis not configured in this environment)" : ""),
      );
    }

    // 10. Summary.
    const totalSecs = Math.round((Date.now() - startedAt) / 1000);
    console.log("");
    console.log("════════════ DEV DB REFRESH SUMMARY ════════════");
    console.log(`Dump used:        ${dumpKey} (${fmtMb(gzBytes)} gzipped)`);
    console.log(`Target:           ${dbLabel}`);
    console.log(
      `Timing:           download ${downloadSecs}s · restore ${restoreSecs}s · total ${totalSecs}s`,
    );
    console.log(`Tables restored:  ${tableCount} in schema public`);
    console.log(
      `Report check:     ${sweepOk ? "PASS" : "FAIL (see offenders above)"}`,
    );
    console.log("");
    console.log("NEXT STEPS:");
    console.log(
      '  1. Restart the "Start application" workflow (baselines the migration ledger,',
    );
    console.log(
      "     re-runs boot-time ensures, and flushes env cache namespaces on boot).",
    );
    console.log(
      "  2. If migrations merged since the last prod Publish exist, apply each one",
    );
    console.log(
      '     manually: psql "$DATABASE_URL" -f server/migrations/<file>.sql — the first',
    );
    console.log(
      "     boot BASELINES them as already-applied without executing (BACKUPS.md §7.1).",
    );
    console.log("  3. Spot-check a report in the dev UI.");
    console.log(
      "NOTE: in a task environment this refreshed only that environment's private DB",
    );
    console.log(
      "clone — the real dev refresh runs on the MAIN workspace (BACKUPS.md §7.1).",
    );
    return sweepOk ? 0 : 1;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("refresh-dev-db-from-backup.ts") ?? false);
if (isMain) {
  runRefresh()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n[dev-refresh] ${err instanceof RefreshRefusedError ? "REFUSED" : "FAILED"}: ${msg}`);
      process.exit(err instanceof RefreshRefusedError ? 3 : 1);
    });
}
