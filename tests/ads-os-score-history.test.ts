/* test-registration
{
  "name": "Ads OS score-history trail — atomic UPSERT append oldest→newest, trim to SCORE_HISTORY_MAX, newest-first read + limit clamp, legacy-doc synthesis, LSA mirror, history routes {customer_id, history} + ?limit clamp + 401 unauth + staff-read 200 per Task #4977 (Task #3628)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3628: Ads OS score-history trail — the best-effort (log-and-swallow) put path means a broken history append fails SILENTLY in prod; this pins the atomic-UPSERT append/trim, newest-first read + clamp, legacy-doc synthesis, and both read-only history routes. Isolated-schema DB clones, no network (routes are read-only, no audit run).",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3628 — Ads OS score-history trail (store + routes).
 *
 * The audit score stores append a compact {final_score, band, generated_at}
 * snapshot to a `history` array inside the jsonb doc on every run (single
 * atomic UPSERT, trimmed to newest SCORE_HISTORY_MAX). The put path is
 * best-effort log-and-swallow, so a refactor that breaks the append makes
 * history silently stop growing and the trend UI just shows nothing. This
 * test locks the contract in:
 *
 *   (A) Store append: repeated putAuditScoreWithHistory calls grow `history`
 *       oldest→newest inside the stored doc, one entry per run.
 *   (B) Trim: after SCORE_HISTORY_MAX+3 runs the stored trail holds exactly
 *       the newest SCORE_HISTORY_MAX entries (oldest runs dropped).
 *   (C) Read: getAuditScoreHistory returns newest-first, honors `limit`,
 *       clamps limit to 1..SCORE_HISTORY_MAX, and returns [] for an unknown
 *       CID.
 *   (D) Legacy doc: a doc written via the plain (pre-history) put with no
 *       `history` array synthesizes ONE entry from its own top-level fields.
 *   (E) LSA store mirrors the GAds behavior (same helpers, separate table).
 *   (F) Routes: GET /api/ads-os/audit/:cid/history and
 *       /api/ads-os/lsa/hygiene/:cid/history return {customer_id, history}
 *       (customer_id digits-only), newest-first, and clamp ?limit (valid N
 *       honored, oversized/garbage → SCORE_HISTORY_MAX cap). CEO-only:
 *       account_manager → 403, unauthenticated → 401.
 *
 * Hermetic: runInIsolatedSchema clones users + both score-store tables with
 * pinGetDbForCrossAsync so both the store helpers (getDb inside
 * withDbAttribution) and the Express handlers hit the clones. No network:
 * the history routes are read-only (no audit run), so no Ads/OpenAI/ClickUp
 * calls happen; nothing is written to shared tables.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

// Dynamic imports so the NODE_ENV pin above lands before module-load-time
// env reads (static imports hoist above assignments).
const { registerAdsOsRoutes } = await import("../server/routes/adsOs");
const {
  SCORE_HISTORY_MAX,
  putAuditScoreWithHistory,
  getAuditScoreHistory,
  putLsaAuditScoreWithHistory,
  getLsaAuditScoreHistory,
  auditScoresStore,
} = await import("../server/services/adsOs/store");
const { runInIsolatedSchema } = await import("./db-sandbox");
const { __test_markUserReconciled, __test_resetReconciledUsers } = await import(
  "../server/middlewares/requireAuth"
);

// ── Constants ────────────────────────────────────────────────────────────────

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const CEO_ID = `test-3628-ceo-${RUN}`;
const AM_ID = `test-3628-am-${RUN}`;
const CID = `36${String(randomInt(0, 99999999)).padStart(8, "0")}`; // digits-only
const LEGACY_CID = `37${String(randomInt(0, 99999999)).padStart(8, "0")}`;
const LSA_CID = `38${String(randomInt(0, 99999999)).padStart(8, "0")}`;

function scoreDoc(n: number): Record<string, any> {
  return {
    customer_id: CID,
    final_score: n,
    band: n >= 80 ? "green" : "yellow",
    generated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    checks: [{ id: "STR-01", status: n % 2 ? "pass" : "fail" }],
  };
}

// ── App factory (Clerk test seam; real requireAuth/requireCeo run after) ─────

let activeUserId: string | null = CEO_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerAdsOsRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function call(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`);
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${CEO_ID}, 'ceo', 'CEO 3628')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${AM_ID}, 'account_manager', 'AM 3628')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);

      // Users are seeded inside the isolated schema; requireAuth resolves the
      // acting identity against its ambient public-schema `db`, so pre-register
      // the profiles in the module registry to keep the real middleware in the
      // loop (role gating) without a JIT-provisioned public row.
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo", firstName: "CEO 3628" });
      __test_markUserReconciled(AM_ID, {
        id: AM_ID,
        role: "account_manager",
        firstName: "AM 3628",
      });

      const TOTAL_RUNS = SCORE_HISTORY_MAX + 3; // 15 runs → trail must trim to 12

      // ── (A) Append: history grows oldest→newest ─────────────────────────
      for (let n = 1; n <= 3; n++) await putAuditScoreWithHistory(CID, scoreDoc(n));
      const doc3 = await auditScoresStore.get(CID);
      assert.ok(doc3, "doc stored after 3 puts");
      assert.ok(Array.isArray(doc3!.history), "doc carries a history array");
      assert.equal(doc3!.history.length, 3, `3 runs → 3 entries (got ${doc3!.history.length}) — the atomic-UPSERT append is broken if this fails`);
      assert.deepEqual(
        doc3!.history.map((e: any) => e.final_score),
        [1, 2, 3],
        "stored trail is oldest→newest",
      );
      for (const e of doc3!.history) {
        assert.deepEqual(Object.keys(e).sort(), ["band", "final_score", "generated_at"], "snapshot is the compact 3-field shape");
      }
      // Top-level doc still reflects the LATEST run (history rides inside it).
      assert.equal(doc3!.final_score, 3, "top-level doc is the newest run's");
      console.log("  ✓ A: repeated puts append oldest→newest compact snapshots");

      // ── (B) Trim to SCORE_HISTORY_MAX ────────────────────────────────────
      for (let n = 4; n <= TOTAL_RUNS; n++) await putAuditScoreWithHistory(CID, scoreDoc(n));
      const docFull = await auditScoresStore.get(CID);
      assert.equal(docFull!.history.length, SCORE_HISTORY_MAX, `trail trims to SCORE_HISTORY_MAX=${SCORE_HISTORY_MAX} (got ${docFull!.history.length})`);
      assert.deepEqual(
        docFull!.history.map((e: any) => e.final_score),
        Array.from({ length: SCORE_HISTORY_MAX }, (_, i) => TOTAL_RUNS - SCORE_HISTORY_MAX + 1 + i),
        "trim keeps the NEWEST entries (oldest runs dropped), still oldest→newest",
      );
      console.log(`  ✓ B: ${TOTAL_RUNS} runs trim to the newest ${SCORE_HISTORY_MAX}`);

      // ── (C) Read: newest-first + limit + clamp + unknown CID ────────────
      const all = await getAuditScoreHistory(CID);
      assert.equal(all.length, SCORE_HISTORY_MAX, "default limit returns the full trail");
      assert.deepEqual(
        all.map((e) => e.final_score),
        Array.from({ length: SCORE_HISTORY_MAX }, (_, i) => TOTAL_RUNS - i),
        "getAuditScoreHistory returns newest-first",
      );
      const three = await getAuditScoreHistory(CID, 3);
      assert.deepEqual(three.map((e) => e.final_score), [TOTAL_RUNS, TOTAL_RUNS - 1, TOTAL_RUNS - 2], "limit=3 → 3 newest, newest-first");
      const over = await getAuditScoreHistory(CID, 999);
      assert.equal(over.length, SCORE_HISTORY_MAX, "oversized limit clamps to SCORE_HISTORY_MAX");
      const under = await getAuditScoreHistory(CID, 0);
      assert.equal(under.length, 1, "limit<=0 clamps up to 1");
      const none = await getAuditScoreHistory(`99${String(randomInt(0, 99999999)).padStart(8, "0")}`);
      assert.deepEqual(none, [], "unknown CID → empty history (no synthesis from nothing)");
      // Formatted CID normalizes to the same key.
      const dashed = await getAuditScoreHistory(`${CID.slice(0, 3)}-${CID.slice(3, 6)}-${CID.slice(6)}`);
      assert.equal(dashed.length, SCORE_HISTORY_MAX, "dashed CID normalizes to the same key");
      console.log("  ✓ C: read is newest-first, honors + clamps limit, empty for unknown CID");

      // ── (D) Legacy doc without history synthesizes one entry ────────────
      await auditScoresStore.put(LEGACY_CID, {
        customer_id: LEGACY_CID,
        final_score: 77,
        band: "yellow",
        generated_at: "2026-01-15T00:00:00.000Z",
      });
      const legacy = await getAuditScoreHistory(LEGACY_CID);
      assert.equal(legacy.length, 1, "legacy doc (no history array) synthesizes exactly one entry");
      assert.deepEqual(legacy[0], { final_score: 77, band: "yellow", generated_at: "2026-01-15T00:00:00.000Z" });
      console.log("  ✓ D: legacy doc without `history` synthesizes one entry from top-level fields");

      // ── (E) LSA store mirrors ────────────────────────────────────────────
      for (let n = 1; n <= 3; n++) {
        await putLsaAuditScoreWithHistory(LSA_CID, { ...scoreDoc(n), customer_id: LSA_CID });
      }
      const lsa = await getLsaAuditScoreHistory(LSA_CID, 2);
      assert.deepEqual(lsa.map((e) => e.final_score), [3, 2], "LSA trail appends + reads newest-first with limit");
      // Separate tables: the GAds trail is untouched by LSA puts.
      assert.equal((await getAuditScoreHistory(LSA_CID)).length, 0, "LSA puts never leak into the GAds store");
      console.log("  ✓ E: LSA store mirrors append/read on its own table");

      // ── (F) Routes ───────────────────────────────────────────────────────
      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        activeUserId = CEO_ID;
        const gads = await call(baseUrl, `/api/ads-os/audit/${CID}/history`);
        assert.equal(gads.status, 200, `GET audit history must be 200 (got ${gads.status}: ${JSON.stringify(gads.body)})`);
        assert.equal(gads.body.customer_id, CID, "response carries digits-only customer_id");
        assert.equal(gads.body.history.length, SCORE_HISTORY_MAX, "route default returns the full trail");
        assert.equal(gads.body.history[0].final_score, TOTAL_RUNS, "route trail is newest-first");

        const limited = await call(baseUrl, `/api/ads-os/audit/${CID}/history?limit=4`);
        assert.equal(limited.body.history.length, 4, "?limit=4 honored");
        assert.deepEqual(
          limited.body.history.map((e: any) => e.final_score),
          [TOTAL_RUNS, TOTAL_RUNS - 1, TOTAL_RUNS - 2, TOTAL_RUNS - 3],
          "?limit slice keeps newest-first",
        );
        const clamped = await call(baseUrl, `/api/ads-os/audit/${CID}/history?limit=999`);
        assert.equal(clamped.body.history.length, SCORE_HISTORY_MAX, "?limit=999 clamps to SCORE_HISTORY_MAX");
        const garbage = await call(baseUrl, `/api/ads-os/audit/${CID}/history?limit=banana`);
        assert.equal(garbage.body.history.length, SCORE_HISTORY_MAX, "garbage ?limit falls back to the max");

        const dashedRoute = await call(baseUrl, `/api/ads-os/audit/${CID.slice(0, 3)}-${CID.slice(3, 6)}-${CID.slice(6)}/history?limit=1`);
        assert.equal(dashedRoute.status, 200);
        assert.equal(dashedRoute.body.customer_id, CID, "dashed CID param normalized to digits in the response");
        assert.equal(dashedRoute.body.history[0].final_score, TOTAL_RUNS);

        const lsaRoute = await call(baseUrl, `/api/ads-os/lsa/hygiene/${LSA_CID}/history?limit=2`);
        assert.equal(lsaRoute.status, 200, `GET lsa history must be 200 (got ${lsaRoute.status}: ${JSON.stringify(lsaRoute.body)})`);
        assert.equal(lsaRoute.body.customer_id, LSA_CID);
        assert.deepEqual(lsaRoute.body.history.map((e: any) => e.final_score), [3, 2], "LSA route serves the LSA trail, newest-first, ?limit honored");

        activeUserId = AM_ID;
        const am = await call(baseUrl, `/api/ads-os/audit/${CID}/history`);
        // Task #4977: history reads are open to any authenticated staff role.
        assert.equal(am.status, 200, `account_manager must get 200 — reads open to staff, Task #4977 (got ${am.status})`);
        activeUserId = null;
        const anon = await call(baseUrl, `/api/ads-os/lsa/hygiene/${LSA_CID}/history`);
        assert.equal(anon.status, 401, `unauthenticated must get 401 (got ${anon.status})`);
        console.log("  ✓ F: both history routes serve {customer_id, history}, clamp ?limit; reads open to staff (Task #4977)");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    {
      tables: ["users", "ads_os_audit_scores", "ads_os_lsa_audit_scores"],
      pinGetDbForCrossAsync: true,
    },
  );

  await getGlobalDispatcher().close();
  console.log("ads-os-score-history: all sections passed (Task #3628).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("ads-os-score-history: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
