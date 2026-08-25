/**
 * Task #3797 — Hermetic test DB bootstrap child.
 *
 * Runs INSIDE a child process whose env already points every connection-
 * string variant at the hermetic database (see provision.ts). Builds the
 * schema through the APP'S OWN migration path — the exact sequence
 * `scripts/post-merge.sh` runs against the dev DB — plus the server's own
 * boot-time ensure functions. No parallel DDL copy exists here that could
 * drift from what the server actually runs.
 *
 *   --full          drizzle-kit push --force → dev-migration ledger
 *                   baseline → SAFE re-apply → boot ensures → baseline seed
 *                   (template build; runs once per schema-content hash)
 *   --ensures-only  idempotent ensures + baseline seed only
 *                   (every run, against the fresh clone — closes the drift
 *                   window between template build time and now)
 *
 * Why push-first (empirically verified 2026-08): the migration FILES are
 * not a self-contained genesis path — e.g. 0033 ALTERs
 * `semrush_location_sync_state`, a table no migration creates (it is
 * push-only). The app's own genesis for a fresh DB is exactly what
 * server/devMigrations does when it meets a POPULATED database: baseline
 * the ledger (mark every file applied) because the schema came from
 * `drizzle-kit push`. That is also precisely the sequence
 * scripts/post-merge.sh maintains dev with (push → SAFE re-apply), so the
 * hermetic template follows the same path — no parallel DDL copy. Raw-SQL
 * objects that live OUTSIDE schema.ts arrive via the SAFE re-apply list
 * (parsed from post-merge.sh) + the server's own boot ensures; template
 * fidelity is verified against the live dev schema (see task notes).
 *
 * Safety: refuses to run unless NOBULL_HERMETIC_BOOTSTRAP=1 and the target
 * is NOT the shared `heliumdb` database or any Neon host.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function guardTarget(): URL {
  if (process.env.NOBULL_HERMETIC_BOOTSTRAP !== "1") {
    console.error("[bootstrap-db] refusing: NOBULL_HERMETIC_BOOTSTRAP=1 not set (this script is runner-internal)");
    process.exit(2);
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error("[bootstrap-db] refusing: DATABASE_URL not set");
    process.exit(2);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error("[bootstrap-db] refusing: DATABASE_URL is not parseable");
    process.exit(2);
  }
  if (url.hostname.includes("neon.tech")) {
    console.error("[bootstrap-db] refusing: DATABASE_URL points at the production Neon instance");
    process.exit(2);
  }
  if (url.pathname === "/heliumdb") {
    console.error(
      "[bootstrap-db] refusing: DATABASE_URL points at the SHARED dev database (heliumdb). " +
        "The hermetic bootstrap only ever targets private throwaway databases.",
    );
    process.exit(2);
  }
  return url;
}

function parseSafeMigrationsFromPostMerge(): string[] {
  // Single source of truth: scripts/post-merge.sh SAFE_MIGRATIONS array.
  // Parsing it (instead of keeping a second list) means the two paths
  // cannot drift.
  const src = readFileSync(resolve(ROOT, "scripts/post-merge.sh"), "utf8");
  const m = src.match(/SAFE_MIGRATIONS=\(([\s\S]*?)\)/);
  if (!m) {
    throw new Error("[bootstrap-db] could not find SAFE_MIGRATIONS=( … ) in scripts/post-merge.sh");
  }
  const files: string[] = [];
  for (const line of m[1].split("\n")) {
    const fm = line.match(/^\s*"(migrations\/[^"]+\.sql)"/);
    if (fm) files.push(fm[1]);
  }
  if (files.length === 0) {
    throw new Error("[bootstrap-db] SAFE_MIGRATIONS parsed empty — post-merge.sh format changed?");
  }
  return files;
}

async function runCommand(cmd: string, args: string[], label: string, timeoutMs = 300_000): Promise<void> {
  await new Promise<void>((resolveDone, rejectDone) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const capture = (buf: Buffer) => {
      tail = (tail + buf.toString()).slice(-6000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      rejectDone(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s\n${tail}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveDone();
      else rejectDone(new Error(`${label} exited ${code}\n${tail}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectDone(err);
    });
  });
}

async function applySafeMigrations(pass: string): Promise<void> {
  const files = parseSafeMigrationsFromPostMerge();
  for (const f of files) {
    console.log(`[bootstrap-db] ${pass}: applying ${f}`);
    await runCommand("psql", [process.env.DATABASE_URL!, "-v", "ON_ERROR_STOP=1", "-q", "-f", f], `psql -f ${f}`);
  }
}

async function baselineMigrationLedger(): Promise<void> {
  // Runs AFTER drizzle push, so the core schema exists and
  // server/devMigrations initialises its ledger the same way it did on the
  // real dev DB: baseline (mark every migration file applied). Anything it
  // still considers pending afterwards is a hard error.
  console.log("[bootstrap-db] initialising dev-migration ledger through server/devMigrations…");
  const { applyPendingDevMigrations, getPendingDevMigrations } = await import("../../server/devMigrations");
  await applyPendingDevMigrations();
  const pending = await getPendingDevMigrations();
  if (pending.length > 0) {
    throw new Error(`[bootstrap-db] migrations still pending after ledger baseline: ${pending.join(", ")}`);
  }
}

async function drizzlePush(): Promise<void> {
  console.log("[bootstrap-db] drizzle-kit push --force…");
  await runCommand("npx", ["drizzle-kit", "push", "--force"], "drizzle-kit push --force", 420_000);
}

/**
 * The server's own boot-time DDL ensures + idempotent seeds. Uses the exact
 * exported functions `server/index.ts` runs at startup (Batch B + worker
 * bootstrap), so hermetic schema state matches a freshly booted dev server.
 */
async function runBootEnsures(): Promise<void> {
  const steps: Array<[string, () => Promise<unknown>]> = [
    [
      "bootstrapDdl (front_sync_emails/twilio/raw_communication columns + external_source_id unique)",
      async () => {
        const { runBootstrapDdlEnsures } = await import("../../server/bootstrapDdl");
        await runBootstrapDdlEnsures();
      },
    ],
    [
      "ads OS store tables",
      async () => {
        const { ensureAdsOsStoreTables } = await import("../../server/services/adsOs/storeSchema");
        await ensureAdsOsStoreTables();
      },
    ],
    [
      "booking tables + constraints",
      async () => {
        const { ensureBookingTables } = await import("../../server/services/bookingSchemaReadiness");
        await ensureBookingTables();
        const { ensureBookingDbConstraints } = await import("../../server/services/bookingDbConstraints");
        await ensureBookingDbConstraints();
      },
    ],
    [
      "durable pipeline tables",
      async () => {
        const { ensureDurablePipelineTables } = await import("../../server/services/applyPipeline");
        await ensureDurablePipelineTables();
      },
    ],
    [
      "RIS checks catalog seed",
      async () => {
        const { seedRisCatalog } = await import("../../server/services/ris/risCatalog");
        await seedRisCatalog();
      },
    ],
    [
      "pool-epic kill switches seed",
      async () => {
        const { ensurePoolEpicSwitchesSeeded } = await import("../../server/services/poolEpicKillSwitches");
        await ensurePoolEpicSwitchesSeeded();
      },
    ],
  ];
  for (const [label, fn] of steps) {
    console.log(`[bootstrap-db] ensure: ${label}`);
    await fn();
  }
}

/**
 * Baseline the harness expects (mirrors tests/run-all.ts's historical
 * ensureTestDbBootstrap plus the synthetic operator every attribution path
 * can rely on).
 */
async function seedBaseline(): Promise<void> {
  const { db } = await import("../../server/db");
  const { sql } = await import("drizzle-orm");

  console.log("[bootstrap-db] seeding baseline (extensions, client_code_seq, synthetic test user)…");
  // Dev parity: the dev DB carries pg_stat_statements (server metrics code
  // queries the view). The local cluster preloads the library
  // (provision.ts); the fallback dev instance already has it.
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
  await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS client_code_seq START WITH 1`);
  const maxRaw = await db.execute(sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(client_code FROM 'NB-([0-9]+)') AS INTEGER)), 0) AS max_num
    FROM clients WHERE client_code IS NOT NULL
  `);
  const maxRows = Array.isArray(maxRaw) ? maxRaw : ((maxRaw as any).rows ?? []);
  const maxNum = Number(maxRows[0]?.max_num || 0);
  if (maxNum > 0) {
    await db.execute(sql`SELECT setval('client_code_seq', ${maxNum})`);
  }

  // Synthetic operator row: suites mint sessions/audit rows for a generic
  // "test" actor; auto-provisioning covers most paths, but FK-carrying
  // writes (audit trails) need the row to exist up front.
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role)
    VALUES ('test', 'test@hermetic.local', 'Hermetic', 'Test', 'ceo')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function main(): Promise<void> {
  const url = guardTarget();
  const mode = process.argv.includes("--ensures-only") ? "ensures-only" : "full";
  const t0 = Date.now();
  console.log(`[bootstrap-db] mode=${mode} target=${url.hostname}:${url.port || 5432}${url.pathname}`);

  if (mode === "full") {
    await drizzlePush();
    await baselineMigrationLedger();
    await applySafeMigrations("post-push");
  }
  await runBootEnsures();
  await seedBaseline();

  console.log(`[bootstrap-db] done in ${Math.round((Date.now() - t0) / 1000)}s`);
  // Pools in the imported server modules keep the loop alive; exit explicitly.
  process.exit(0);
}

main().catch((err) => {
  console.error("[bootstrap-db] FAILED:", err);
  process.exit(1);
});
