/**
 * Test DB isolation primitives.
 *
 * Two primitives are exported, for two different test categories:
 *
 *  ──────────────────────────────────────────────────────────────────────
 *  1. `runInTxSandbox(fn)` — single-connection transactional sandbox.
 *  ──────────────────────────────────────────────────────────────────────
 *  Wraps `fn` in a single Postgres transaction, redirects every
 *  `getDb()` call inside that scope to the transaction's client (via
 *  AsyncLocalStorage), and ALWAYS rolls back at the end — so the test
 *  can exercise real storage / service code paths against the live DB
 *  without leaving any rows behind, even if the test fails.
 *
 *  Drizzle nests calls to `getDb().transaction(...)` as SAVEPOINTs of
 *  the outer tx, so service code that opens its own transactions
 *  participates in the same sandbox automatically.
 *
 *  Use this for category (a) tests where all reads + writes happen on a
 *  single connection (no cross-process, no separate-pool worker that
 *  needs to see committed rows).
 *
 *  Usage:
 *      import { runInTxSandbox } from "./db-sandbox";
 *      await runInTxSandbox(async (tx) => {
 *        // … exercise services that use getDb() …
 *      });
 *
 *  Requirement: every storage / service that the test touches must read
 *  from `getDb()` (not the raw `db` / `workerDb` imports) so the
 *  AsyncLocalStorage redirection actually applies. Imports of the bare
 *  `db` const sidestep the sandbox.
 *
 *  ──────────────────────────────────────────────────────────────────────
 *  2. `runInIsolatedSchema(fn, opts)` — per-test Postgres schema.
 *  ──────────────────────────────────────────────────────────────────────
 *  Creates a fresh, uniquely-named Postgres schema (e.g.
 *  `test_iso_<uuid>`), clones the requested tables from `public` into
 *  it via `CREATE TABLE … (LIKE public.<t> INCLUDING ALL)`, opens a
 *  dedicated pg.Pool whose connections have `search_path =
 *  <schema>,public`, and points `getDb()` at a drizzle wrapper over
 *  that pool for the duration of `fn`. On exit (success OR failure)
 *  the schema is `DROP … CASCADE`-ed and the pool is ended.
 *
 *  Use this for category (b) tests that:
 *    - need committed cross-connection visibility (one half of the
 *      test enqueues via a request-pool connection, the other half
 *      reads via a worker-pool connection), OR
 *    - touch tables that the live `Start application` workers may also
 *      be reading from / writing to (e.g. `work_queue`,
 *      `prod_action_runs`) and would race with the test.
 *
 *  Because the live workflow's workers were started with the default
 *  search_path (`public`), they cannot see — or claim — rows in the
 *  test's isolated schema, even though both are in the same database.
 *
 *  Limitations:
 *    - Only the requested tables are cloned; foreign-key references
 *      that point at `public.*` rows will not resolve through the
 *      isolated schema. Tests should seed the minimum table set they
 *      need and pass it via `opts.tables`.
 *    - Same "must use `getDb()`" requirement as the tx sandbox.
 *      Production code that imports `db` directly bypasses the
 *      override; migrate the touched code paths to `getDb()` before
 *      relying on schema isolation.
 *
 *  Usage:
 *      await runInIsolatedSchema(
 *        async ({ db, schema }) => {
 *          await db.execute(sql`INSERT INTO work_queue …`);
 *          // …
 *        },
 *        { tables: ["work_queue", "system_settings"] },
 *      );
 */

import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "@shared/schema";

import { db, __setTestDbOverrideResolver } from "../server/db";
import { __setTestBypassResolver } from "../server/services/cache/redisCache";

type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;
type TxClient = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

// Either-or override: tx sandbox stores a TxClient, schema sandbox stores
// a DrizzleClient. `getDb()` consumers only need a DB-like interface,
// which both satisfy.
type SandboxOverride = TxClient | DrizzleClient;

const sandboxStorage = new AsyncLocalStorage<SandboxOverride>();

// The default, AsyncLocalStorage-based override resolver: getDb() inside an
// active sandbox scope receives the per-scope override; outside any scope it
// returns undefined and getDb() falls through to its normal pool selection.
// Kept as a named const so the cross-async pinning path (see
// `pinGetDbForCrossAsync`) can ALWAYS restore exactly this resolver in a
// `finally` after temporarily pinning getDb() by captured reference.
const alsBasedDbResolver = () =>
  sandboxStorage.getStore() as unknown as typeof db | undefined;

// Per-scope flag for the Redis-cache bypass primitive. Lives in its
// own ALS so the bypass can be activated independently of the DB
// override (e.g. a runInTxSandbox caller can still choose to exercise
// the real cache, while runInIsolatedSchema always bypasses it).
const cacheBypassStorage = new AsyncLocalStorage<true>();

// Install once: every getDb() call inside an active sandbox will receive
// the per-sandbox override. Outside any sandbox the resolver returns
// undefined and getDb() falls through to its normal pool selection.
__setTestDbOverrideResolver(alsBasedDbResolver);

// Install once: any cache op running inside a scope that opted in via
// `cacheBypassStorage.run(true, …)` short-circuits as bypassed. Outside
// such a scope the resolver returns false and the cache behaves normally.
// This solves the process-shared Upstash poisoning problem documented in
// `tests/prod-actions-semrush-cadence-cutover.test.ts` — isolated-schema
// tests would otherwise see stale public-schema reads served from cache
// and have to enumerate every key to invalidate.
__setTestBypassResolver(() => cacheBypassStorage.getStore() === true);

/**
 * Internal: returns the current sandbox override if we're inside any
 * sandbox primitive, otherwise undefined. The patched `getDb()` consults
 * this first.
 */
export function getSandboxTx(): SandboxOverride | undefined {
  return sandboxStorage.getStore();
}

class RollbackSentinel extends Error {
  constructor() {
    super("[db-sandbox] intentional rollback");
  }
}

/**
 * Run `fn` inside a transaction whose work is unconditionally rolled back.
 * Any exception thrown by `fn` is re-raised after rollback so test failures
 * still propagate to the caller.
 */
export async function runInTxSandbox<T>(
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let userErr: unknown = null;

  try {
    await db.transaction(async (tx) => {
      try {
        result = await sandboxStorage.run(tx, () => fn(tx));
      } catch (err) {
        userErr = err;
      }
      throw new RollbackSentinel();
    });
  } catch (err) {
    if (!(err instanceof RollbackSentinel)) {
      // Real DB-level error — surface it.
      throw err;
    }
  }

  if (userErr) throw userErr;
  return result as T;
}

// ──────────────────────────────────────────────────────────────────────
// runInIsolatedSchema
// ──────────────────────────────────────────────────────────────────────

export interface IsolatedSchemaContext {
  /** Drizzle handle pinned to the isolated schema's search_path. */
  db: DrizzleClient;
  /** The generated schema name (e.g. `test_iso_ab12cd34`). */
  schema: string;
}

export interface IsolatedSchemaOptions {
  /**
   * Tables to clone (via `CREATE TABLE … (LIKE public.<t> INCLUDING ALL)`)
   * from `public` into the isolated schema before `fn` runs.
   *
   * Cloning is structural only — no row data is copied. Use INCLUDING ALL
   * so defaults, constraints, indexes, and storage parameters carry over.
   */
  tables?: readonly string[];
  /**
   * Optional connection string override. Defaults to `DATABASE_URL`.
   */
  connectionString?: string;
  /**
   * When true, getDb() is pinned at the isolated db handle by captured
   * reference (NOT via AsyncLocalStorage) for the entire duration of `fn`,
   * and the ALS-based resolver is ALWAYS restored in a `finally` BEFORE the
   * isolated pool is torn down.
   *
   * Use this for HTTP-endpoint tests: the Express request handler runs in a
   * separate async context OUTSIDE this sandbox's ALS scope, so the normal
   * ALS redirection never reaches it and its getDb() calls would fall
   * through to live `public`. Pinning makes the cross-async handler read the
   * isolated, cloned tables instead.
   *
   * Clone only the tables the handler must read in isolation; uncloned
   * tables (e.g. `users`, `system_settings`) still fall through to `public`
   * for role gating / rate limits.
   *
   * This replaces the by-hand `__setTestDbOverrideResolver` pin/restore
   * dance (Task #2024), which was easy to get wrong — forgetting to restore
   * the resolver before pool teardown left a dead-pool reference for later
   * getDb() calls.
   */
  pinGetDbForCrossAsync?: boolean;
}

function isolatedSchemaConnectionString(opts: IsolatedSchemaOptions): string {
  const conn =
    opts.connectionString ??
    process.env.DATABASE_URL ??
    process.env.PGDATABASE_URL;
  if (!conn) {
    throw new Error(
      "[db-sandbox] runInIsolatedSchema requires DATABASE_URL (or opts.connectionString)",
    );
  }
  return conn;
}

/**
 * Spin up a fresh Postgres schema, run `fn` against a dedicated pool whose
 * connections have `search_path = <schema>,public`, then drop the schema.
 *
 * The schema is dropped (`CASCADE`) and the pool is `end()`-ed in a
 * `finally` so even a thrown `fn` cannot leak the schema. Concurrent live
 * workers in `Start application` operate against `public.*` and therefore
 * cannot observe — or claim — rows the test inserts into the isolated
 * schema.
 *
 * See the module header for the cross-connection visibility / table
 * cloning trade-offs.
 */
export async function runInIsolatedSchema<T>(
  fn: (ctx: IsolatedSchemaContext) => Promise<T>,
  opts: IsolatedSchemaOptions = {},
): Promise<T> {
  // Name embeds the creation epoch-ms (base36) so the runner-start
  // sweeper (tests/sweep-isolated-schemas.ts) can drop schemas orphaned
  // by SIGKILL'd test children once they are older than a day. Keep the
  // shape in lockstep with TIMESTAMPED_RE over there.
  const schemaName = `test_iso_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const conn = isolatedSchemaConnectionString(opts);

  // Use a single, separate pool so we own the search_path. Setting
  // search_path on every checkout via the `connect` hook ensures even
  // recycled connections land on the isolated schema first.
  const pool = new Pool({
    connectionString: conn,
    min: 0,
    max: 4,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: `nobull-test-iso-${schemaName}`,
  });

  // Quoted identifier — schemaName is generated above and is always a
  // safe `[a-z0-9_]+` string, but quote anyway for defense in depth.
  const qSchema = `"${schemaName.replace(/"/g, '""')}"`;

  pool.on("connect", (client) => {
    // Best-effort — every new connection in this pool starts pointed at
    // the isolated schema. We can't await here, but pg queues the SET
    // before any user query on that connection.
    client.query(`SET search_path TO ${qSchema}, public`).catch(() => {
      /* surfaced by subsequent queries */
    });
  });

  let userErr: unknown = null;
  let result: T | undefined;

  try {
    // Create the schema using a connection from the isolated pool. We
    // must temporarily flip search_path to public so the CREATE SCHEMA
    // itself runs before the per-connection SET has landed (the SET
    // above may race with our CREATE on the very first checkout).
    const setup = await pool.connect();
    try {
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${qSchema}`);
      await setup.query(`SET search_path TO ${qSchema}, public`);
      for (const t of opts.tables ?? []) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) {
          throw new Error(
            `[db-sandbox] runInIsolatedSchema: unsafe table name ${JSON.stringify(t)}`,
          );
        }
        await setup.query(
          `CREATE TABLE ${qSchema}."${t}" (LIKE public."${t}" INCLUDING ALL)`,
        );
      }
    } finally {
      setup.release();
    }

    const isoDb = drizzle(pool, { schema });

    const runFn = () =>
      sandboxStorage.run(isoDb as unknown as SandboxOverride, () =>
        cacheBypassStorage.run(true, () => fn({ db: isoDb, schema: schemaName })),
      );

    try {
      if (opts.pinGetDbForCrossAsync) {
        // Pin getDb() at the isolated handle by captured reference so
        // cross-async consumers (e.g. HTTP request handlers running outside
        // this ALS scope) still resolve to the isolated, cloned tables.
        // Always restore the ALS-based resolver in `finally` — BEFORE the
        // outer `finally` ends the pool — so later getDb() calls never hold
        // a dead-pool reference.
        __setTestDbOverrideResolver(() => isoDb as unknown as typeof db);
        try {
          result = await runFn();
        } finally {
          __setTestDbOverrideResolver(alsBasedDbResolver);
        }
      } else {
        result = await runFn();
      }
    } catch (err) {
      userErr = err;
    }
  } finally {
    // Always drop the schema and end the pool — even if setup or fn
    // threw. We use a fresh connection for teardown so a broken pool
    // doesn't trap the schema.
    try {
      const teardown = await pool.connect();
      try {
        await teardown.query(`DROP SCHEMA IF EXISTS ${qSchema} CASCADE`);
      } finally {
        teardown.release();
      }
    } catch (dropErr) {
      console.error(
        `[db-sandbox] failed to drop isolated schema ${schemaName}:`,
        (dropErr as any)?.message ?? dropErr,
      );
    }
    await pool.end().catch(() => {
      /* pool may already be ended on the error path */
    });
  }

  if (userErr) throw userErr;
  return result as T;
}

// Keep `sql` re-exported for tests that compose schema-isolated queries
// without pulling drizzle-orm separately.
export { sql };
