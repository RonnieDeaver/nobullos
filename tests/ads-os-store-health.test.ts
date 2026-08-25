/* test-registration
{
  "name": "Ads OS store schema self-heal + health — boot ensure creates all 12 jsonb store tables idempotently, collection registry ⊆ ensure list, dropped-table 42P01 → ensure + one retry persists a STRICT criteria save (getDb pinned iso-only so no public fallthrough), ensure-failure cooldown gates DDL retries, health state machine: missing_tables flips immediately / generic errors need the 3-strike / success resets (Task #3706)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3706: Ads OS store self-heal + health — the boot ensure that recreates the jsonb store tables after a DB reset (they exist ONLY via raw SQL, not shared/schema.ts) and the loud store-outage signal. The whole subsystem silently blanked once when these tables vanished; this is the regression gate that keeps that failure loud and self-healing.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS — store schema self-heal + health signal (Task #3706).
 *
 * The whole `ads_os_*` jsonb store vanished once (prod-snapshot dev DB reset;
 * the tables live only in migrations/0136, not shared/schema.ts) and the
 * best-effort store swallowed every failure — dashboards silently blanked and
 * criteria saves no-op'd. This test locks in the two defenses:
 *
 *   (A) `ensureAdsOsStoreTables` creates ALL store tables idempotently in the
 *       active schema (re-runnable, DDL matches 0136's two-column jsonb shape).
 *   (B) The store collection registry ⊆ the ensure list — a future collection
 *       can't be added without boot-ensure coverage.
 *   (C) Real round-trip through the store lands in the ensured tables and
 *       marks health ok.
 *   (D) 42P01 self-heal: with a table dropped (and NO public fallthrough —
 *       getDb pinned to an iso-only search_path), a STRICT criteria save
 *       recreates the table and persists on the retry; health returns to ok.
 *   (E) Ensure-failure cooldown: after a failed ensure (dead DB), the
 *       self-heal entry point refuses to hammer DDL until the cooldown clears.
 *   (F) Health state machine: missing-relation flips the signal immediately;
 *       generic errors only flip it at the consecutive-failure threshold; any
 *       success resets it. Plus isMissingRelationError shape/nesting checks.
 *
 * Hermetic: runInIsolatedSchema owns every table this test touches (they are
 * created by the ensure under test, in the isolated schema); the self-heal
 * section re-pins getDb() to an iso-ONLY pool so a dropped table can never
 * silently fall through to public.* (memory: isolated-schema search_path
 * fallthrough). Undici dispatcher closed at exit so the process drains.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getGlobalDispatcher } from "undici";

// Dynamic imports so the NODE_ENV pin above lands before module-load-time env
// reads (db pool test-mode idle timeouts) — static imports hoist.
const {
  ADS_OS_STORE_TABLES,
  STORE_FAILURE_THRESHOLD,
  isMissingRelationError,
  recordStoreSuccess,
  recordStoreFailure,
  getAdsOsStoreHealth,
  ensureAdsOsStoreTables,
  ensureAdsOsStoreTablesForSelfHeal,
  __testResetAdsOsStoreHealth,
  __testResetEnsureCooldown,
} = await import("../server/services/adsOs/storeSchema");
const { putCriteria, getCriteria, REGISTERED_STORE_TABLES } =
  await import("../server/services/adsOs/store");
const { __setTestDbOverrideResolver } = await import("../server/db");
const { runInIsolatedSchema } = await import("./db-sandbox");

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const CID = `37${String(randomInt(0, 99999999)).padStart(8, "0")}`; // digits-only

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db, schema }) => {
      __testResetAdsOsStoreHealth();
      __testResetEnsureCooldown();

      const listTables = async (): Promise<string[]> => {
        const res = await db.execute(sql`
          SELECT tablename FROM pg_tables
          WHERE schemaname = ${schema} AND tablename LIKE 'ads_os_%'
          ORDER BY tablename
        `);
        return (res.rows ?? []).map((r: any) => String(r.tablename));
      };

      // ── (A) ensure creates every store table, idempotently ────────────────
      assert.deepEqual(await listTables(), [], "isolated schema starts with zero ads_os tables");
      await ensureAdsOsStoreTables();
      assert.deepEqual(
        await listTables(),
        [...ADS_OS_STORE_TABLES].sort(),
        "ensure created every store table in the active schema",
      );
      await ensureAdsOsStoreTables(); // second run must be a clean no-op
      assert.equal((await listTables()).length, ADS_OS_STORE_TABLES.length, "idempotent re-run");
      console.log(`  ✓ A: ensure creates all ${ADS_OS_STORE_TABLES.length} tables, idempotent re-run`);

      // ── (B) collection registry ⊆ ensure list (and covers all of it) ──────
      assert.deepEqual(
        [...REGISTERED_STORE_TABLES].sort(),
        [...ADS_OS_STORE_TABLES].sort(),
        "every store collection's table must be in ADS_OS_STORE_TABLES (and vice versa) — " +
          "a new collection must be added to the boot ensure",
      );
      console.log("  ✓ B: collection registry and boot-ensure list are in lockstep");

      // ── (C) round-trip through the real store path + health ok ────────────
      await putCriteria(CID, { business_name: `Store Health ${RUN}` });
      const doc = await getCriteria(CID);
      assert.equal(doc?.business_name, `Store Health ${RUN}`, "strict save persisted");
      const okHealth = getAdsOsStoreHealth();
      assert.equal(okHealth.ok, true);
      assert.equal(okHealth.kind, "ok");
      assert.ok(okHealth.last_ok_at, "success stamps last_ok_at");
      console.log("  ✓ C: criteria round-trip lands in the ensured tables; health ok");

      // ── (D) 42P01 self-heal with NO public fallthrough ────────────────────
      // Pin getDb() at a pool whose search_path is the isolated schema ONLY:
      // after the boot ensure ships, public.* will have these tables too, and
      // the default `iso, public` path would silently absorb the INSERT
      // instead of raising 42P01 (the exact bug class this feature heals).
      // lint-hermetic-db-ok: constrained pool over the injected (hermetic) env to pin search_path at the isolated schema only
      const isoOnlyPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 2,
        idleTimeoutMillis: 1_000,
        connectionTimeoutMillis: 10_000,
        application_name: `nobull-test-store-health-${RUN}`,
      });
      isoOnlyPool.on("connect", (client) => {
        client.query(`SET search_path TO "${schema}"`).catch(() => {});
      });
      const isoOnlyDb = drizzle(isoOnlyPool);
      __setTestDbOverrideResolver(() => isoOnlyDb as any);
      try {
        await db.execute(sql.raw(`DROP TABLE "${schema}".ads_os_clients_criteria`));
        __testResetEnsureCooldown();
        await putCriteria(CID, { business_name: `Healed ${RUN}` });
        assert.ok(
          (await listTables()).includes("ads_os_clients_criteria"),
          "self-heal recreated the dropped table",
        );
        const healedRow = await db.execute(sql`
          SELECT data FROM ${sql.raw(`"${schema}"`)}.ads_os_clients_criteria WHERE key = ${CID}
        `);
        const healedData = healedRow.rows?.[0]?.data as any;
        const healed = typeof healedData === "string" ? JSON.parse(healedData) : healedData;
        assert.equal(healed?.business_name, `Healed ${RUN}`, "retry persisted INTO the healed table");
        assert.equal(getAdsOsStoreHealth().ok, true, "successful retry resets health to ok");

        // Read path heals too: drop again, a swallowed GET recreates the table
        // (returns null — the dropped row is gone) and health stays ok.
        await db.execute(sql.raw(`DROP TABLE "${schema}".ads_os_clients_criteria`));
        __testResetEnsureCooldown();
        const afterDropRead = await getCriteria(CID);
        assert.equal(afterDropRead, null, "row died with the dropped table");
        assert.ok(
          (await listTables()).includes("ads_os_clients_criteria"),
          "swallowed read also self-heals the table",
        );
        assert.equal(getAdsOsStoreHealth().ok, true);
        console.log("  ✓ D: dropped table → strict save 42P01 → ensure + retry persists; read path heals too");

        // ── (E) ensure-failure cooldown gates rapid DDL retries ─────────────
        __testResetAdsOsStoreHealth();
        __testResetEnsureCooldown();
        // lint-hermetic-db-ok: deliberately dead pool (port 9) to simulate store outage; touches no database at all
        const deadPool = new Pool({
          host: "127.0.0.1",
          port: 9, // discard — nothing listens; connect fails fast
          connectionTimeoutMillis: 400,
          max: 1,
        });
        const deadDb = drizzle(deadPool);
        __setTestDbOverrideResolver(() => deadDb as any);
        await assert.rejects(() => ensureAdsOsStoreTables(), "ensure against a dead DB must throw");
        __setTestDbOverrideResolver(() => isoOnlyDb as any); // DB is healthy again…
        await assert.rejects(
          () => ensureAdsOsStoreTablesForSelfHeal(),
          /cooling down/,
          "…but the self-heal entry point must respect the post-failure cooldown",
        );
        __testResetEnsureCooldown();
        await ensureAdsOsStoreTablesForSelfHeal(); // cooldown cleared → heals fine
        await deadPool.end();
        console.log("  ✓ E: failed ensure arms the cooldown; self-heal refuses until it clears");
      } finally {
        __setTestDbOverrideResolver(() => db as any); // restore the harness pin
        await isoOnlyPool.end();
      }

      // ── (F) health state machine ──────────────────────────────────────────
      __testResetAdsOsStoreHealth();
      assert.equal(getAdsOsStoreHealth().kind, "ok");
      for (let i = 1; i < STORE_FAILURE_THRESHOLD; i++) {
        recordStoreFailure(new Error(`transient blip ${i}`));
        assert.equal(getAdsOsStoreHealth().ok, true, `below threshold (${i}) stays ok`);
      }
      recordStoreFailure(new Error("third strike"));
      const errored = getAdsOsStoreHealth();
      assert.equal(errored.ok, false, "threshold reached → outage");
      assert.equal(errored.kind, "errors");
      assert.match(errored.reason ?? "", /failing \(3 in a row\)/, "reason names the streak");
      recordStoreSuccess();
      assert.equal(getAdsOsStoreHealth().ok, true, "any success resets the signal");

      recordStoreFailure({ code: "42P01", message: 'relation "ads_os_budget_pacing" does not exist' });
      const missing = getAdsOsStoreHealth();
      assert.equal(missing.ok, false, "missing relation flips IMMEDIATELY (no threshold)");
      assert.equal(missing.kind, "missing_tables");
      assert.match(missing.reason ?? "", /missing from the database/i);
      recordStoreSuccess();

      // isMissingRelationError: pg code, message match, nested cause, negatives.
      assert.ok(isMissingRelationError({ code: "42P01" }), "bare pg code");
      assert.ok(
        isMissingRelationError(new Error('relation "ads_os_x" does not exist')),
        "message-only match",
      );
      const nested: any = new Error("query wrapper failed");
      nested.cause = { cause: { code: "42P01" } };
      assert.ok(isMissingRelationError(nested), "walks err.cause chain");
      assert.ok(!isMissingRelationError(new Error("deadlock detected")), "generic error ≠ structural");
      assert.ok(!isMissingRelationError(undefined), "undefined is safe");
      console.log("  ✓ F: 42P01 flips immediately; generic errors need the 3-strike; success resets");

      __testResetAdsOsStoreHealth(); // leave the process-global state pristine
      __testResetEnsureCooldown();
    },
    { tables: [], pinGetDbForCrossAsync: true },
  );

  await getGlobalDispatcher().close();
  console.log("ads-os-store-health: all sections passed (Task #3706).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("ads-os-store-health: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
