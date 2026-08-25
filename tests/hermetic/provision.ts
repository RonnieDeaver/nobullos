/**
 * Task #3797 — Hermetic per-run test database: ephemeral Postgres provisioner.
 *
 * Gives the test runner a PRIVATE, throwaway Postgres per run so test
 * children physically cannot touch the shared Helium dev database (the
 * root cause of years of full-run flakes: the always-on dev server and
 * every task's leftover data share one mutable DB with all ~750 suites).
 *
 * Pattern (big-tech CI): testcontainers-style ephemeral server + the
 * integresql/pgtestdb template-database trick for speed:
 *
 *   1. LOCAL CLUSTER (primary): initdb a private Postgres 16 cluster under
 *      /tmp (same major.minor as dev — binaries ship in PATH), CI-tuned
 *      (fsync off, synchronous_commit off, autovacuum off, UNIX SOCKET
 *      only — listen_addresses='' means no TCP listener at all, so the
 *      Replit workspace never auto-registers a [[ports]] mapping for it,
 *      and nothing outside this container can reach it; trust auth).
 *   2. TEMPLATE CACHE: the migrated+seeded cluster is built ONCE per
 *      schema-content hash (see computeSchemaHash) into
 *      `.local/hermetic-pg/templates/<hash>/` and copied to /tmp per run,
 *      so a normal run pays seconds, not a full migration replay. The
 *      cluster also carries a pristine `nobull_template` database for
 *      suites that opt into a per-suite clone (CREATE DATABASE … TEMPLATE).
 *   3. FALLBACK (no local binaries): a uniquely named throwaway database
 *      on the shared dev INSTANCE (the Helium role has CREATEDB). Still
 *      hermetic at the database level — never the shared `heliumdb`.
 *
 * This module is intentionally dependency-light: node stdlib + CLI tools
 * (initdb/pg_ctl/psql). It must NOT import server/db (env is read at module
 * eval there; the runner mutates env AFTER provisioning).
 *
 * Schema bootstrap itself lives in `tests/hermetic/bootstrap-db.ts` and runs
 * in a CHILD process with the hermetic env, through the app's own migration
 * path (devMigrations → drizzle-kit push → SAFE re-apply → boot ensures) —
 * never a parallel DDL copy that can drift.
 */
import { spawnSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename_resolved = fileURLToPath(import.meta.url);
const ROOT = resolve(__filename_resolved, "..", "..", "..");

export const HERMETIC_TMP_ROOT = "/tmp/nobull-hermetic";
/**
 * One shared socket dir for every hermetic cluster: socket files are named
 * `.s.PGSQL.<port>`, so concurrent clusters coexist. The "port" only names
 * the socket — there is no TCP listener (listen_addresses='').
 */
export const HERMETIC_SOCK_DIR = "/tmp/nobull-hermetic/sock";
export const TEMPLATE_CACHE_ROOT = resolve(ROOT, ".local/hermetic-pg/templates");
export const HERMETIC_DB_NAME = "nobull_test";
export const HERMETIC_TEMPLATE_DB_NAME = "nobull_template";
/** Marker env var: set in every child so helpers/tests can assert hermetic mode. */
export const HERMETIC_MARKER_ENV = "NOBULL_HERMETIC_DB";

// Dev-DB parity (probed 2026-08: Helium Postgres 16.10, C.UTF-8, GMT).
const CLUSTER_LOCALE = "C.UTF-8";
const CLUSTER_TZ = "GMT";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): RunResult {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    env: opts?.env ?? process.env,
    timeout: opts?.timeoutMs ?? 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function fail(msg: string, extra?: RunResult): never {
  const detail = extra
    ? `\n  exit=${extra.status}\n  stdout: ${extra.stdout.slice(-2000)}\n  stderr: ${extra.stderr.slice(-2000)}`
    : "";
  throw new Error(`[hermetic] ${msg}${detail}`);
}

// ─── Binary discovery ────────────────────────────────────────────────

export interface PgBinaries {
  initdb: string;
  pg_ctl: string;
  psql: string;
  pg_isready: string;
  versionLine: string;
}

/**
 * Locate local Postgres binaries. Honors NOBULL_PG_BIN (a bin dir) first,
 * then PATH. Returns null when unavailable → caller uses the shared-instance
 * fallback.
 */
export function findPgBinaries(): PgBinaries | null {
  const fromDir = (dir: string | null): PgBinaries | null => {
    const p = (name: string) => (dir ? join(dir, name) : name);
    const probe = run(p("pg_ctl"), ["--version"], { timeoutMs: 15_000 });
    if (probe.status !== 0) return null;
    for (const tool of ["initdb", "psql", "pg_isready"]) {
      if (run(p(tool), ["--version"], { timeoutMs: 15_000 }).status !== 0) return null;
    }
    return {
      initdb: p("initdb"),
      pg_ctl: p("pg_ctl"),
      psql: p("psql"),
      pg_isready: p("pg_isready"),
      versionLine: probe.stdout.trim(),
    };
  };
  const override = process.env.NOBULL_PG_BIN;
  if (override) return fromDir(override);
  return fromDir(null);
}

// ─── Schema-content hash (template cache key) ────────────────────────

function listFilesRecursive(dir: string, filter: (f: string) => boolean): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...listFilesRecursive(full, filter));
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Hash of everything that determines the SCHEMA CONTENT of the bootstrapped
 * template. When any input changes the template is rebuilt from scratch.
 * Idempotent per-run ensures (boot DDL ensures + seeds) are ALSO re-run
 * against the clone on every provision — the hash only has to cover the
 * expensive replay path (migrations + drizzle push), not every ensure body.
 */
export function computeSchemaHash(root: string = ROOT): { hash: string; fileCount: number } {
  const h = createHash("sha256");
  const inputs: string[] = [];

  inputs.push(...listFilesRecursive(join(root, "migrations"), (f) => f.endsWith(".sql")));
  inputs.push(...listFilesRecursive(join(root, "shared"), (f) => f.endsWith(".ts")));
  for (const f of [
    "drizzle.config.ts",
    "scripts/post-merge.sh", // SAFE_MIGRATIONS list is parsed from here
    "server/devMigrations.ts",
    "tests/hermetic/bootstrap-db.ts",
  ]) {
    const full = join(root, f);
    if (existsSync(full)) inputs.push(full);
  }

  for (const file of inputs) {
    h.update(file.slice(root.length));
    h.update("\u0000");
    h.update(readFileSync(file));
    h.update("\u0000");
  }

  // Tool versions matter: drizzle-kit push output depends on the kit version.
  try {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    for (const dep of ["drizzle-kit", "drizzle-orm", "pg"]) {
      const v = lock?.packages?.[`node_modules/${dep}`]?.version ?? "unknown";
      h.update(`${dep}@${v}\u0000`);
    }
  } catch {
    h.update("no-lockfile\u0000");
  }

  return { hash: h.digest("hex").slice(0, 16), fileCount: inputs.length };
}

// ─── Port allocation ─────────────────────────────────────────────────

export async function pickFreePort(): Promise<number> {
  // Ask the OS for an ephemeral port by listening on 0, then release it.
  // A race with another process grabbing it between close and postgres
  // start is possible but vanishingly rare; the caller retries.
  return await new Promise<number>((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("no address")));
      }
    });
  });
}

// ─── Child env construction ──────────────────────────────────────────

export interface HermeticChildEnv {
  /** Vars to set on every test child (and on the runner's own process.env). */
  set: Record<string, string>;
  /**
   * Vars that MUST be deleted (not just overwritten): `??` fallbacks in
   * server/db.ts mean an inherited POOLED/MIGRATIONS URL would silently
   * route some pools back at the shared dev DB.
   */
  unset: string[];
}

export function buildChildDbEnv(opts: {
  url: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  runId: string;
}): HermeticChildEnv {
  return {
    set: {
      DATABASE_URL: opts.url,
      DATABASE_URL_DIRECT: opts.url,
      PGDATABASE_URL: opts.url,
      PGHOST: opts.host,
      PGPORT: String(opts.port),
      PGUSER: opts.user,
      PGPASSWORD: opts.password,
      PGDATABASE: opts.database,
      PGSSLMODE: "disable",
      [HERMETIC_MARKER_ENV]: "1",
      // Step 6 (cache isolation): children read/write a per-run Redis key
      // namespace so hermetic DB state can never be contradicted by another
      // process's live cache. See server/services/cache/redisCache.ts.
      NOBULL_TEST_CACHE_NAMESPACE: opts.runId,
    },
    unset: ["DATABASE_URL_POOLED", "DATABASE_URL_MIGRATIONS"],
  };
}

// ─── Local cluster primitives ────────────────────────────────────────

function clusterOptions(port: number, sockDir: string): string[] {
  return [
    "-p", String(port),
    "-k", sockDir,
    // Socket-only: an empty listen_addresses disables TCP entirely. This is
    // faster, collision-free, and keeps the Replit port auto-detector from
    // writing [[ports]] entries into .replit (which a smoke suite asserts on).
    "-c", "listen_addresses=",
    // CI tuning: throwaway data, favor speed. NEVER copy these to prod.
    "-c", "fsync=off",
    "-c", "synchronous_commit=off",
    "-c", "full_page_writes=off",
    "-c", "autovacuum=off",
    "-c", "shared_buffers=128MB",
    "-c", "max_connections=100",
    "-c", "log_min_messages=warning",
    "-c", `timezone=${CLUSTER_TZ}`,
    // Dev parity: server metrics code (dbServerMetrics, pg_stat_statements
    // regression scheduler) queries the pg_stat_statements view; the
    // extension only collects when preloaded.
    "-c", "shared_preload_libraries=pg_stat_statements",
  ];
}

function startCluster(bins: PgBinaries, dataDir: string, port: number, sockDir: string, logFile: string): void {
  mkdirSync(sockDir, { recursive: true });
  const opts = clusterOptions(port, sockDir)
    .map((o) => (o.startsWith("-") ? o : `"${o}"`))
    .join(" ");
  const res = run(bins.pg_ctl, ["-D", dataDir, "-l", logFile, "-o", opts, "-w", "-t", "60", "start"], {
    timeoutMs: 90_000,
  });
  if (res.status !== 0) {
    let logTail = "";
    try {
      logTail = readFileSync(logFile, "utf8").slice(-2000);
    } catch {}
    fail(`pg_ctl start failed (port ${port})\n  server log tail: ${logTail}`, res);
  }
}

/**
 * Connection URL for a socket-only cluster. node-postgres (and everything
 * built on it, incl. drizzle-kit) honors the `host` query param as the
 * socket directory; the authority hostname is a display placeholder.
 */
function hermeticUrl(port: number, database: string): string {
  return `postgresql://postgres@localhost:${port}/${database}?host=${encodeURIComponent(HERMETIC_SOCK_DIR)}`;
}

function stopCluster(bins: PgBinaries, dataDir: string, mode: "fast" | "immediate"): void {
  run(bins.pg_ctl, ["-D", dataDir, "-m", mode, "-w", "-t", "30", "stop"], { timeoutMs: 60_000 });
}

function psqlExec(bins: PgBinaries, port: number, database: string, sqlText: string): RunResult {
  return run(bins.psql, [
    "-h", HERMETIC_SOCK_DIR,
    "-p", String(port),
    "-U", "postgres",
    "-d", database,
    "-v", "ON_ERROR_STOP=1",
    "-tAc", sqlText,
  ]);
}

function waitForReady(bins: PgBinaries, port: number): void {
  for (let i = 0; i < 60; i++) {
    const res = run(bins.pg_isready, ["-h", HERMETIC_SOCK_DIR, "-p", String(port), "-U", "postgres"], {
      timeoutMs: 10_000,
    });
    if (res.status === 0) return;
    spawnSync("sleep", ["0.25"]);
  }
  fail(`cluster on port ${port} never became ready`);
}

/**
 * Health-check the started cluster: basic query + every extension the
 * migrations require must be installable (binary parity guard — a missing
 * .so would otherwise surface as a confusing mid-replay failure).
 */
function healthCheckCluster(bins: PgBinaries, port: number): void {
  const sel = psqlExec(bins, port, "postgres", "SELECT 1");
  if (sel.status !== 0) fail("cluster health check (SELECT 1) failed", sel);
  // btree_gist: required by migrations/0036 (scheduled_meetings no-overlap).
  // pgcrypto/uuid-ossp: available on dev; verify parity so a suite using
  // gen_random_uuid()/uuid_generate_v4() behaves identically.
  const ext = psqlExec(
    bins,
    port,
    "postgres",
    "SELECT count(*) FROM pg_available_extensions WHERE name IN ('btree_gist','pgcrypto','uuid-ossp','pg_stat_statements')",
  );
  if (ext.status !== 0 || Number(ext.stdout.trim()) < 4) {
    fail(`required extensions unavailable in local Postgres (btree_gist/pgcrypto/uuid-ossp/pg_stat_statements)`, ext);
  }
}

// ─── Orphan sweep ────────────────────────────────────────────────────

/** Best-effort cleanup of run dirs left by crashed/SIGKILLed runners. */
export function sweepOrphanRunDirs(bins: PgBinaries | null): void {
  if (!existsSync(HERMETIC_TMP_ROOT)) return;
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const entry of readdirSync(HERMETIC_TMP_ROOT)) {
    if (!entry.startsWith("run-") && !entry.startsWith("build-")) continue;
    const dir = join(HERMETIC_TMP_ROOT, entry);
    try {
      const pidFile = join(dir, "runner.pid");
      let ownerAlive = false;
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        if (pid > 0) {
          try {
            process.kill(pid, 0);
            ownerAlive = true;
          } catch {
            ownerAlive = false;
          }
        }
      }
      const stale = statSync(dir).mtimeMs < cutoff;
      if (ownerAlive && !stale) continue;
      if (bins) stopCluster(bins, join(dir, "data"), "immediate");
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ─── Template build ──────────────────────────────────────────────────

interface TemplateMeta {
  hash: string;
  createdAt: string;
  pgVersion: string;
  bootstrapLogTail: string;
}

function templateDir(hash: string): string {
  return join(TEMPLATE_CACHE_ROOT, hash);
}

function templateIsReady(hash: string): boolean {
  return existsSync(join(templateDir(hash), "meta.json")) && existsSync(join(templateDir(hash), "data"));
}

async function runBootstrapChild(env: NodeJS.ProcessEnv, args: string[], logPrefix: string): Promise<void> {
  await new Promise<void>((resolveDone, rejectDone) => {
    const child = spawn("npx", ["tsx", "tests/hermetic/bootstrap-db.ts", ...args], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const capture = (buf: Buffer) => {
      const text = buf.toString();
      tail = (tail + text).slice(-8000);
      process.stdout.write(
        text
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => `${logPrefix} ${l}\n`)
          .join(""),
      );
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      rejectDone(new Error(`[hermetic] bootstrap child timed out (15 min)\n  log tail:\n${tail}`));
    }, 15 * 60 * 1000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveDone();
      else rejectDone(new Error(`[hermetic] bootstrap child exited ${code}\n  log tail:\n${tail}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectDone(err);
    });
  });
}

function pruneOldTemplates(keepHash: string): void {
  if (!existsSync(TEMPLATE_CACHE_ROOT)) return;
  const entries = readdirSync(TEMPLATE_CACHE_ROOT)
    .filter((e) => e !== keepHash)
    .map((e) => ({ name: e, dir: join(TEMPLATE_CACHE_ROOT, e) }))
    .filter((e) => {
      try {
        return statSync(e.dir).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b.dir).mtimeMs - statSync(a.dir).mtimeMs);
  // Keep the most recent old template as a rollback cushion; drop the rest.
  for (const e of entries.slice(1)) {
    rmSync(e.dir, { recursive: true, force: true });
  }
}

/**
 * Build the template cluster for `hash` if missing: initdb → start → create
 * DB → run the full bootstrap child (app's own migration path + seed) →
 * snapshot a pristine `nobull_template` DB for per-suite clones → stop →
 * copy into the workspace template cache (meta.json written last = commit
 * marker).
 */
async function ensureTemplate(bins: PgBinaries, hash: string): Promise<void> {
  if (templateIsReady(hash)) return;

  const lockDir = join(TEMPLATE_CACHE_ROOT, `.build-lock-${hash}`);
  mkdirSync(TEMPLATE_CACHE_ROOT, { recursive: true });
  try {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), String(process.pid));
  } catch {
    // Another process is building. Wait for it (up to 20 min), honoring
    // stale locks (dead pid or >30 min old).
    const start = Date.now();
    while (Date.now() - start < 20 * 60 * 1000) {
      if (templateIsReady(hash)) return;
      try {
        const pid = Number(readFileSync(join(lockDir, "pid"), "utf8").trim());
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {}
        if (!alive || statSync(lockDir).mtimeMs < Date.now() - 30 * 60 * 1000) {
          rmSync(lockDir, { recursive: true, force: true });
          return await ensureTemplate(bins, hash);
        }
      } catch {
        if (templateIsReady(hash)) return;
        rmSync(lockDir, { recursive: true, force: true });
        return await ensureTemplate(bins, hash);
      }
      spawnSync("sleep", ["2"]);
    }
    fail(`timed out waiting for concurrent template build (${hash})`);
  }

  const buildRoot = join(HERMETIC_TMP_ROOT, `build-${Date.now()}-${process.pid}`);
  const dataDir = join(buildRoot, "data");
  const sockDir = HERMETIC_SOCK_DIR;
  const logFile = join(buildRoot, "postgres.log");
  let started = false;
  try {
    console.log(`[hermetic] building template ${hash} (schema content changed or first run)…`);
    const t0 = Date.now();
    mkdirSync(buildRoot, { recursive: true });
    writeFileSync(join(buildRoot, "runner.pid"), String(process.pid));

    const init = run(bins.initdb, [
      "-D", dataDir,
      "-U", "postgres",
      "-A", "trust",
      "--no-sync",
      "-E", "UTF8",
      `--locale=${CLUSTER_LOCALE}`,
    ], { timeoutMs: 120_000 });
    if (init.status !== 0) fail("initdb failed", init);

    const port = await pickFreePort();
    startCluster(bins, dataDir, port, sockDir, logFile);
    started = true;
    waitForReady(bins, port);
    healthCheckCluster(bins, port);

    const create = psqlExec(bins, port, "postgres", `CREATE DATABASE ${HERMETIC_DB_NAME}`);
    if (create.status !== 0) fail("CREATE DATABASE failed", create);

    const url = hermeticUrl(port, HERMETIC_DB_NAME);
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    const envSpec = buildChildDbEnv({
      url,
      host: HERMETIC_SOCK_DIR,
      port,
      user: "postgres",
      password: "",
      database: HERMETIC_DB_NAME,
      runId: `template-${hash}`,
    });
    for (const k of envSpec.unset) delete childEnv[k];
    Object.assign(childEnv, envSpec.set, {
      NOBULL_HERMETIC_BOOTSTRAP: "1",
      // Bootstrap runs the app's own migration/ensure path OUTSIDE test mode
      // (some ensures intentionally skip under NODE_ENV=test).
      NODE_ENV: "development",
    });
    await runBootstrapChild(childEnv, ["--full"], "[hermetic:bootstrap]");

    // Pristine per-suite clone source. Must be created while nothing is
    // connected to the source DB (the bootstrap child has exited).
    let templated: RunResult | null = null;
    for (let i = 0; i < 10; i++) {
      templated = psqlExec(
        bins,
        port,
        "postgres",
        `CREATE DATABASE ${HERMETIC_TEMPLATE_DB_NAME} TEMPLATE ${HERMETIC_DB_NAME}`,
      );
      if (templated.status === 0) break;
      spawnSync("sleep", ["1"]);
    }
    if (!templated || templated.status !== 0) fail("CREATE DATABASE nobull_template failed", templated ?? undefined);

    psqlExec(bins, port, HERMETIC_DB_NAME, "CHECKPOINT");
    stopCluster(bins, dataDir, "fast");
    started = false;

    // Commit to the workspace cache: copy data dir, then meta.json last.
    const dest = templateDir(hash);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const cp = run("cp", ["-a", dataDir, join(dest, "data")], { timeoutMs: 180_000 });
    if (cp.status !== 0) fail("copy template to cache failed", cp);
    const meta: TemplateMeta = {
      hash,
      createdAt: new Date().toISOString(),
      pgVersion: bins.versionLine,
      bootstrapLogTail: "",
    };
    writeFileSync(join(dest, "meta.json"), JSON.stringify(meta, null, 2));
    pruneOldTemplates(hash);
    console.log(`[hermetic] template ${hash} built in ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    if (started) stopCluster(bins, dataDir, "immediate");
    rmSync(buildRoot, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
}

// ─── Public handle ───────────────────────────────────────────────────

export interface HermeticHandle {
  mode: "local-cluster" | "shared-instance-fallback";
  url: string;
  runId: string;
  env: HermeticChildEnv;
  /** Create a pristine per-suite clone (from the template DB). */
  cloneDatabase(label?: string): Promise<{ url: string; drop(): Promise<void> }>;
  /**
   * Task #5029: create N shard databases from the ENSURED run DB (nobull_test,
   * after the per-run ensures pass) so each parallel shard lane gets an
   * isolated copy with the same schema+seed state. Returns the URL for each
   * shard in order [shard-0, shard-1, …]. Only supported in local-cluster
   * mode; the shared-instance fallback returns [].
   */
  createShardDbs(shardCount: number): Promise<string[]>;
  teardown(): Promise<void>;
}

export interface ProvisionOptions {
  /** Skip the per-run idempotent ensure pass (used by tests). */
  skipEnsures?: boolean;
  quiet?: boolean;
}

/**
 * Provision the per-run hermetic database. Local private cluster when
 * Postgres binaries are available (the normal path); otherwise a uniquely
 * named throwaway database on the shared dev instance. Never the shared
 * `heliumdb` database itself.
 */
export async function provisionHermeticDb(opts: ProvisionOptions = {}): Promise<HermeticHandle> {
  const runId = `run-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${process.pid}`;
  const bins = findPgBinaries();
  if (bins) {
    return await provisionLocalCluster(bins, runId, opts);
  }
  console.warn(
    "[hermetic] local Postgres binaries not found — falling back to a throwaway database on the dev instance " +
      "(set NOBULL_PG_BIN to a Postgres 16 bin dir to restore the local-cluster path).",
  );
  return await provisionSharedInstanceFallback(runId, opts);
}

async function provisionLocalCluster(
  bins: PgBinaries,
  runId: string,
  opts: ProvisionOptions,
): Promise<HermeticHandle> {
  const t0 = Date.now();
  sweepOrphanRunDirs(bins);
  const { hash } = computeSchemaHash();
  await ensureTemplate(bins, hash);

  const runRoot = join(HERMETIC_TMP_ROOT, runId);
  const dataDir = join(runRoot, "data");
  const sockDir = HERMETIC_SOCK_DIR;
  const logFile = join(runRoot, "postgres.log");
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(join(runRoot, "runner.pid"), String(process.pid));

  const cp = run("cp", ["-a", join(templateDir(hash), "data"), dataDir], { timeoutMs: 180_000 });
  if (cp.status !== 0) fail("copy template to run dir failed", cp);

  let port = 0;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    port = await pickFreePort();
    try {
      startCluster(bins, dataDir, port, sockDir, logFile);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  waitForReady(bins, port);

  const url = hermeticUrl(port, HERMETIC_DB_NAME);
  const env = buildChildDbEnv({
    url,
    host: HERMETIC_SOCK_DIR,
    port,
    user: "postgres",
    password: "",
    database: HERMETIC_DB_NAME,
    runId,
  });

  // Per-run idempotent ensure pass: boot DDL ensures + seeds run against the
  // CLONE so a template built before an ensure changed can never drift.
  if (!opts.skipEnsures) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of env.unset) delete childEnv[k];
    Object.assign(childEnv, env.set, {
      NOBULL_HERMETIC_BOOTSTRAP: "1",
      NODE_ENV: "development",
    });
    await runBootstrapChild(childEnv, ["--ensures-only"], "[hermetic:ensure]");
  }

  let tornDown = false;
  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    try {
      stopCluster(bins, dataDir, "immediate");
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  };

  let cloneSeq = 0;
  const cloneDatabase = async (label = "clone") => {
    const name = `nobull_${label.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}_${++cloneSeq}`;
    const res = psqlExec(bins, port, "postgres", `CREATE DATABASE ${name} TEMPLATE ${HERMETIC_TEMPLATE_DB_NAME}`);
    if (res.status !== 0) fail(`per-suite clone ${name} failed`, res);
    return {
      url: hermeticUrl(port, name),
      drop: async () => {
        psqlExec(bins, port, "postgres", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      },
    };
  };

  // Task #5029: create N shard databases from the ENSURED nobull_test DB so
  // each parallel lane gets an isolated copy that includes the ensures pass.
  // We use nobull_test (not nobull_template) as the template so the ensures
  // pass is captured — boot DDL ensures + seeds are part of the run DB state.
  // Zero-connection window is guaranteed: the ensures bootstrap child has
  // exited before provisionLocalCluster returns.
  const createShardDbs = async (shardCount: number): Promise<string[]> => {
    const urls: string[] = [];
    for (let i = 0; i < shardCount; i++) {
      const name = `nobull_shard_${i}`;
      let cloned: RunResult | null = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        cloned = psqlExec(
          bins,
          port,
          "postgres",
          `CREATE DATABASE ${name} TEMPLATE ${HERMETIC_DB_NAME}`,
        );
        if (cloned.status === 0) break;
        spawnSync("sleep", ["0.5"]);
      }
      if (!cloned || cloned.status !== 0) {
        fail(`shard DB ${name} (TEMPLATE ${HERMETIC_DB_NAME}) failed`, cloned ?? undefined);
      }
      urls.push(hermeticUrl(port, name));
    }
    return urls;
  };

  if (!opts.quiet) {
    console.log(
      `[hermetic] private Postgres ready in ${Math.round((Date.now() - t0) / 1000)}s ` +
        `(mode=local-cluster port=${port} template=${hash} runId=${runId})`,
    );
  }
  return { mode: "local-cluster", url, runId, env, cloneDatabase, createShardDbs, teardown };
}

// ─── Shared-instance fallback ────────────────────────────────────────

function adminUrlFromEnv(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) fail("fallback provisioning needs DATABASE_URL for the dev instance");
  const u = new URL(raw!);
  if (u.hostname.includes("neon.tech")) {
    fail("refusing fallback provisioning against the production Neon instance");
  }
  return u;
}

function psqlUrl(u: URL, database: string): string {
  const copy = new URL(u.toString());
  copy.pathname = `/${database}`;
  return copy.toString();
}

function psqlOnUrl(url: string, sqlText: string): RunResult {
  return run("psql", [url, "-v", "ON_ERROR_STOP=1", "-tAc", sqlText]);
}

async function provisionSharedInstanceFallback(
  runId: string,
  opts: ProvisionOptions,
): Promise<HermeticHandle> {
  const admin = adminUrlFromEnv();
  const { hash } = computeSchemaHash();
  const templateName = `nobull_htpl_${hash}`;
  const runDbName = `nobull_${runId.replace(/[^a-z0-9_]/gi, "_")}`;
  const adminDbUrl = admin.toString();

  // Sweep old throwaway run DBs (embedded timestamp; >12h = orphaned).
  const cutoffTs = new Date(Date.now() - 12 * 60 * 60 * 1000)
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  const list = psqlOnUrl(adminDbUrl, `SELECT datname FROM pg_database WHERE datname LIKE 'nobull_run_%'`);
  if (list.status === 0) {
    for (const name of list.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      const ts = name.replace(/^nobull_run_/, "").split("_")[0];
      if (ts && ts < cutoffTs) {
        psqlOnUrl(adminDbUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
    }
  }

  // Ensure the template DB exists and is marked complete.
  const ready = psqlOnUrl(
    psqlUrl(admin, templateName),
    `SELECT 1 FROM pg_tables WHERE tablename='_hermetic_template_ready'`,
  );
  if (ready.status !== 0 || ready.stdout.trim() !== "1") {
    console.log(`[hermetic] building fallback template DB ${templateName} on the dev instance…`);
    psqlOnUrl(adminDbUrl, `DROP DATABASE IF EXISTS ${templateName} WITH (FORCE)`);
    const created = psqlOnUrl(adminDbUrl, `CREATE DATABASE ${templateName}`);
    if (created.status !== 0) fail(`CREATE DATABASE ${templateName} failed`, created);

    const url = psqlUrl(admin, templateName);
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    const spec = buildChildDbEnv({
      url,
      host: admin.hostname,
      port: Number(admin.port || 5432),
      user: decodeURIComponent(admin.username),
      password: decodeURIComponent(admin.password),
      database: templateName,
      runId: `template-${hash}`,
    });
    for (const k of spec.unset) delete childEnv[k];
    Object.assign(childEnv, spec.set, {
      NOBULL_HERMETIC_BOOTSTRAP: "1",
      NOBULL_HERMETIC_FALLBACK: "1",
      NODE_ENV: "development",
    });
    await runBootstrapChild(childEnv, ["--full"], "[hermetic:bootstrap]");
    const mark = psqlOnUrl(url, `CREATE TABLE _hermetic_template_ready (built_at timestamptz DEFAULT now())`);
    if (mark.status !== 0) fail("could not mark fallback template ready", mark);
  }

  const cloned = psqlOnUrl(adminDbUrl, `CREATE DATABASE ${runDbName} TEMPLATE ${templateName}`);
  if (cloned.status !== 0) fail(`CREATE DATABASE ${runDbName} failed`, cloned);

  const url = psqlUrl(admin, runDbName);
  const env = buildChildDbEnv({
    url,
    host: admin.hostname,
    port: Number(admin.port || 5432),
    user: decodeURIComponent(admin.username),
    password: decodeURIComponent(admin.password),
    database: runDbName,
    runId,
  });
  env.set.NOBULL_HERMETIC_FALLBACK = "1";

  if (!opts.skipEnsures) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of env.unset) delete childEnv[k];
    Object.assign(childEnv, env.set, {
      NOBULL_HERMETIC_BOOTSTRAP: "1",
      NOBULL_HERMETIC_FALLBACK: "1",
      NODE_ENV: "development",
    });
    await runBootstrapChild(childEnv, ["--ensures-only"], "[hermetic:ensure]");
  }

  let tornDown = false;
  let cloneSeq = 0;
  if (!opts.quiet) {
    console.log(`[hermetic] throwaway DB ready (mode=shared-instance-fallback db=${runDbName})`);
  }
  return {
    mode: "shared-instance-fallback",
    url,
    runId,
    env,
    // Task #5029: sharding not supported in shared-instance-fallback mode
    // (we cannot safely clone from the live run DB while it may have active
    // connections; the shared-instance path is only a last-resort fallback).
    // The caller in run-all.ts detects the empty return and forces serial.
    createShardDbs: async (_shardCount: number): Promise<string[]> => [],
    cloneDatabase: async (label = "clone") => {
      const name = `nobull_run_${runId.replace(/[^a-z0-9_]/gi, "_")}_c${++cloneSeq}`;
      void label;
      const res = psqlOnUrl(adminDbUrl, `CREATE DATABASE ${name} TEMPLATE ${templateName}`);
      if (res.status !== 0) fail(`per-suite clone ${name} failed`, res);
      return {
        url: psqlUrl(admin, name),
        drop: async () => {
          psqlOnUrl(adminDbUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        },
      };
    },
    teardown: async () => {
      if (tornDown) return;
      tornDown = true;
      psqlOnUrl(adminDbUrl, `DROP DATABASE IF EXISTS ${runDbName} WITH (FORCE)`);
    },
  };
}

// ─── CLI (debugging) ─────────────────────────────────────────────────

const isMain = process.argv[1] != null && resolve(process.argv[1]) === __filename_resolved;
if (isMain) {
  const cmd = process.argv[2] ?? "--doctor";
  if (cmd === "--doctor") {
    const bins = findPgBinaries();
    console.log(`binaries: ${bins ? bins.versionLine : "NOT FOUND (fallback mode would be used)"}`);
    const { hash, fileCount } = computeSchemaHash();
    console.log(`schema hash: ${hash} (${fileCount} input files)`);
    console.log(`template ready: ${templateIsReady(hash)}`);
  } else if (cmd === "--build-template") {
    const bins = findPgBinaries();
    if (!bins) {
      console.error("no local binaries; --build-template only supports the local-cluster path");
      process.exit(1);
    }
    const { hash } = computeSchemaHash();
    ensureTemplate(bins, hash)
      .then(() => console.log(`template ${hash} ready`))
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  } else if (cmd === "--provision-smoke") {
    // Provision, run SELECT 1 through the handle URL, tear down.
    provisionHermeticDb({ skipEnsures: process.argv.includes("--skip-ensures") })
      .then(async (h) => {
        const res = run("psql", [h.url, "-tAc", "SELECT count(*) FROM pg_tables WHERE schemaname='public'"]);
        console.log(`tables in public schema: ${res.stdout.trim()} (exit ${res.status})`);
        await h.teardown();
        process.exit(res.status === 0 ? 0 : 1);
      })
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  } else {
    console.error(`unknown command ${cmd}; use --doctor | --build-template | --provision-smoke`);
    process.exit(1);
  }
}
