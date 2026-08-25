/* test-registration
{
  "name": "Ads OS criteria + cron routes — ClickUp-authoritative practice areas, two-way save/outages, aliases, schedules, auth, and cron gate",
  "regression": true,
  "sweepOnlyReason": "Task #3598 — criteria GET/PUT + alias + cron 401 gate: DB-heavy (runInIsolatedSchema: users + 2 ads_os stores) + real HTTP server; not a smoke-gate candidate.",
  "extraEnv": {
    "NODE_ENV": "test",
    "BUDGET_SOURCE": "sheet"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS Phase 2 — client criteria routes (spec §6.11) + morning cron gate.
 *
 * Covers:
 *   (A) GET /api/ads-os/clients/:cid/criteria on a fresh CID → 200 with
 *       has_saved:false, empty criteria, derived defaults — WITH the Ads API
 *       failing (stubbed 400): name/geo derivation is best-effort, the route
 *       must still serve saved criteria (bundle behavior).
 *   (B) PUT saves criteria (GAds schedule unchanged → no GAds pacing refresh;
 *       the LSA schedule IS set, so the best-effort LSA refresh hook fires and
 *       must not fail the save), returns {ok, updated_at}; unknown body keys
 *       are dropped (pydantic-style).
 *   (C) GET returns the saved doc (has_saved:true) — including the new
 *       lsa_schedule_days — on the /clients path AND the legacy /keyword-intel
 *       alias.
 *   (D) PUT via the legacy alias works.
 *   (E) Malformed body (array) → 400.
 *   (F) PUT with BOTH schedules changed still returns 200 while the stubbed
 *       Ads API fails — the immediate GAds + LSA pacing-store refreshes are
 *       best-effort and must never fail the save.
 *   (G) lowest-permission authenticated user: GET and PUT succeed through
 *       both aliases; unrelated Ads OS writes remain CEO-only.
 *   (H) unauthenticated requests to every criteria alias/method → 401.
 *   (I) POST /api/ads-os/cron/refresh-pacing: 401 when CRON_SECRET is unset
 *       (even with a header), 401 with a missing/wrong X-Cron-Key. (The
 *       success path live-refreshes every enrolled account — exercised by
 *       hand, not in tests.)
 *
 * Hermetic: runInIsolatedSchema clones users + the criteria store + BOTH
 * pacing stores (GAds + LSA — the LSA refresh hook writes the LSA one)
 * (pinGetDbForCrossAsync so Express handlers hit the clones); Google
 * OAuth/Ads endpoints are fetch-stubbed in-process (fake token is memory-only;
 * a 400 GAQL response maps to AdsOsApiError, never a creds wipe or breaker);
 * BUDGET_SOURCE=sheet with no sheet URL keeps the budget seam off the network
 * and away from ClickUp.
 */

process.env.NODE_ENV = "test";
process.env.BUDGET_SOURCE = "sheet";
process.env.CLICKUP_API_TOKEN = "pk_fake_ads_os_criteria_sync";
delete process.env.BUDGET_SHEET_CSV_URL;

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

// Dynamic imports so the env pins above (NODE_ENV, BUDGET_SOURCE=sheet) land
// BEFORE module-load-time env reads — static imports hoist above assignments,
// and a too-late BUDGET_SOURCE would send the schedule-change PUT through the
// live ClickUp budget path.
const { registerAdsOsRoutes } = await import("../server/routes/adsOs");
const { emptyCriteria } = await import("../server/services/adsOs/criteriaService");
const {
  CLICKUP_CLIENT_CID_FIELD_ID,
  CLICKUP_PRACTICE_AREA_FIELD_ID,
} = await import("../server/services/adsOs/config");
const {
  __setDirectoryAlertHooksForTest,
  __testResetDirectoryCache,
  __test_drainDirectoryAlertWork,
} = await import("../server/services/adsOs/clickUpDirectory");
const { runInIsolatedSchema } = await import("./db-sandbox");
const { __test_markUserReconciled, __test_resetReconciledUsers } = await import(
  "../server/middlewares/requireAuth"
);

// ── Constants ────────────────────────────────────────────────────────────────

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const CEO_ID = `test-3598-ceo-${RUN}`;
const LOWEST_ROLE_ID = `test-5216-sales-${RUN}`;
const CID = `35${String(randomInt(0, 99999999)).padStart(8, "0")}`; // digits-only, 10 chars
const PRACTICE_OPTIONS = [
  { id: "pa-criminal", label: "Criminal Defense", orderindex: 2 },
  { id: "pa-immigration", label: "Immigration", orderindex: 0 },
  { id: "pa-family", label: "Family", orderindex: 1 },
];
let selectedPracticeAreaIds = ["pa-criminal", "pa-family"];
let clickUpReadOutage = false;
let clickUpWriteFailure = false;
const clickUpWriteBodies: any[] = [];

// ── Google endpoint stubs (in-process only; nothing persisted) ───────────────

const realFetch = globalThis.fetch;
function stubGoogleFetch(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    // Dispatch on URL *path shape*, never on live vendor hostnames — naming the
    // real API hosts here would make this test a net-new raw vendor-host caller
    // under lint-vendor-confinement. The Google OAuth token endpoint uses
    // path /token; GAQL requests use paths containing googleAds:search; ClickUp
    // API routes are all under /api/v2/.
    let pathname = "";
    try {
      pathname = new URL(url).pathname;
    } catch {
      // Non-absolute input: fall through to realFetch below.
    }
    if (pathname === "/token") {
      // Fake mint: cached in googleAdsClient memory only, cleared with the process.
      return new Response(
        JSON.stringify({ access_token: `test-token-${RUN}`, expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (pathname.includes("googleAds:search")) {
      // 400 → classify → AdsOsApiError (NOT unauthenticated: no re-mint loop,
      // no negative creds cache) — the shape routes must degrade around.
      return new Response(
        JSON.stringify({ error: { code: 400, message: `stubbed ads failure ${RUN}`, status: "INVALID_ARGUMENT" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (pathname.startsWith("/api/v2/")) {
      if (clickUpReadOutage && init?.method !== "POST") {
        return new Response(JSON.stringify({ err: "stubbed ClickUp read outage" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        init?.method !== "POST" &&
        /^\/api\/v2\/list\/[^/]+\/field$/.test(pathname)
      ) {
        return new Response(
          JSON.stringify({
            fields: [
              {
                id: CLICKUP_PRACTICE_AREA_FIELD_ID,
                name: "Practice Area",
                type: "labels",
                type_config: { options: PRACTICE_OPTIONS },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        init?.method !== "POST" &&
        /^\/api\/v2\/list\/[^/]+\/task$/.test(pathname)
      ) {
        return new Response(
          JSON.stringify({
            last_page: true,
            tasks: [
              {
                id: "parent-criteria-sync",
                name: "Criteria Sync Law",
                parent: null,
                status: { status: "active" },
                custom_fields: [
                  {
                    id: CLICKUP_PRACTICE_AREA_FIELD_ID,
                    value: selectedPracticeAreaIds,
                  },
                ],
              },
              {
                id: "gads-criteria-sync",
                name: "Google Ads",
                parent: "parent-criteria-sync",
                status: { status: "active" },
                custom_fields: [
                  { id: CLICKUP_CLIENT_CID_FIELD_ID, value: CID },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        init?.method === "POST" &&
        pathname ===
          `/api/v2/task/parent-criteria-sync/field/${CLICKUP_PRACTICE_AREA_FIELD_ID}`
      ) {
        const parsed = JSON.parse(String(init.body ?? "{}"));
        clickUpWriteBodies.push(parsed);
        if (clickUpWriteFailure) {
          return new Response(JSON.stringify({ err: "stubbed write failure" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        selectedPracticeAreaIds = (parsed.value ?? []).map((entry: any) =>
          String(entry.id),
        );
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected ClickUp request: ${init?.method ?? "GET"} ${pathname}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
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

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  __setDirectoryAlertHooksForTest({
    onSuccess: async () => {},
    onFailure: async () => {},
  });
  __testResetDirectoryCache();
  stubGoogleFetch();
  const savedCronSecret = process.env.CRON_SECRET;

  await runInIsolatedSchema(
    async ({ db }) => {
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${CEO_ID}, 'ceo', 'CEO 3598')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${LOWEST_ROLE_ID}, 'sales', 'Sales 5216')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);

      // Users are seeded inside the isolated schema; requireAuth resolves the
      // acting identity against its ambient public-schema `db`, so pre-register
      // the profiles in the module registry to keep the real middleware in the
      // loop (criteria-route authentication) without a JIT-provisioned public row.
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo", firstName: "CEO 3598" });
      __test_markUserReconciled(LOWEST_ROLE_ID, {
        id: LOWEST_ROLE_ID,
        role: "sales",
        firstName: "Sales 5216",
      });

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      try {
        // ── (A) GET fresh CID: Ads failure degrades, criteria still served ──
        activeUserId = CEO_ID;
        const fresh = await call(baseUrl, "GET", `/api/ads-os/clients/${CID}/criteria`);
        assert.equal(fresh.status, 200, `GET fresh criteria must be 200 (got ${fresh.status}: ${JSON.stringify(fresh.body)})`);
        assert.equal(fresh.body.has_saved, false, "nothing saved yet");
        assert.equal(fresh.body.customer_id, CID);
        assert.equal(fresh.body.account_name, CID, "Ads name lookup failed (stub) → falls back to the CID");
        assert.deepEqual(
          fresh.body.criteria,
          {
            ...emptyCriteria(),
            practice_areas: ["Family", "Criminal Defense"],
          },
          "fresh local doc is overlaid with the ClickUp parent selection",
        );
        assert.deepEqual(
          fresh.body.practice_area_options,
          ["Immigration", "Family", "Criminal Defense"],
          "canonical options are returned in ClickUp order",
        );
        assert.equal(
          fresh.body.practice_area_sync_available,
          true,
          "practice-area synchronization is available for the mapped CID",
        );
        assert.ok(fresh.body.derived && typeof fresh.body.derived === "object", "derived defaults present");
        assert.equal(fresh.body.updated_at, null, "no updated_at before first save");
        console.log("  ✓ A: GET on a fresh CID degrades name/geo best-effort (stubbed Ads 400) and returns empty criteria");

        // ── (B) PUT saves; unknown keys dropped; GAds schedule unchanged ───
        // (lsa_schedule_days goes [] → Sat/Sun here, so the best-effort LSA
        // refresh hook runs against the stubbed-down Ads API too.)
        const put1 = await call(baseUrl, "PUT", `/api/ads-os/clients/${CID}/criteria`, {
          ...emptyCriteria(),
          business_name: `Test Firm ${RUN}`,
          website: "https://example.com",
          practice_areas: ["Criminal Defense", "Immigration", "Immigration"],
          service_area: "Austin, TX",
          lsa_schedule_days: ["Sat", "Sun"],
          practice_area_sync_base: ["Family", "Criminal Defense"],
          evil_unknown_key: "must be dropped",
        });
        assert.equal(put1.status, 200, `PUT must be 200 (got ${put1.status}: ${JSON.stringify(put1.body)})`);
        assert.equal(put1.body.ok, true);
        assert.ok(typeof put1.body.updated_at === "string" && put1.body.updated_at.length > 0, "updated_at returned");
        assert.deepEqual(
          clickUpWriteBodies.at(-1),
          { value: [{ id: "pa-immigration" }, { id: "pa-criminal" }] },
          "changed selection is deduped and written to ClickUp in canonical order before local save",
        );
        console.log("  ✓ B: PUT saves and returns {ok, updated_at}");

        // ── (C) GET returns the saved doc on both paths ─────────────────────
        for (const base of ["clients", "keyword-intel"]) {
          const got = await call(baseUrl, "GET", `/api/ads-os/${base}/${CID}/criteria`);
          assert.equal(got.status, 200, `GET /${base} must be 200`);
          assert.equal(got.body.has_saved, true, `/${base}: has_saved after PUT`);
          assert.equal(got.body.criteria.business_name, `Test Firm ${RUN}`, `/${base}: saved name round-trips`);
          assert.deepEqual(
            got.body.criteria.practice_areas,
            ["Immigration", "Criminal Defense"],
            `/${base}: ClickUp-authoritative practice areas round-trip in option order`,
          );
          assert.deepEqual(
            got.body.criteria.lsa_schedule_days,
            ["Sat", "Sun"],
            `/${base}: LSA schedule round-trips separately from the (empty) GAds schedule`,
          );
          assert.deepEqual(got.body.criteria.schedule_days, [], `/${base}: GAds schedule untouched`);
          assert.equal("evil_unknown_key" in got.body.criteria, false, "unknown keys dropped at save (pydantic-style)");
        }
        console.log("  ✓ C: saved doc (incl. lsa_schedule_days) round-trips on /clients AND the legacy /keyword-intel alias");

        // ── (D) PUT via the legacy alias ────────────────────────────────────
        const put2 = await call(baseUrl, "PUT", `/api/ads-os/keyword-intel/${CID}/criteria`, {
          ...emptyCriteria(),
          business_name: `Alias Save ${RUN}`,
          practice_areas: ["Family"],
          practice_area_sync_base: ["Immigration", "Criminal Defense"],
        });
        assert.equal(put2.status, 200, "legacy-alias PUT must save");
        const afterAlias = await call(baseUrl, "GET", `/api/ads-os/clients/${CID}/criteria`);
        assert.equal(afterAlias.body.criteria.business_name, `Alias Save ${RUN}`);
        assert.deepEqual(afterAlias.body.criteria.practice_areas, ["Family"]);
        console.log("  ✓ D: legacy-alias PUT writes the same doc");

        // ── (E) invalid option rejected; neither store changes ──────────────
        const invalidOption = await call(
          baseUrl,
          "PUT",
          `/api/ads-os/clients/${CID}/criteria`,
          {
            ...afterAlias.body.criteria,
            notes: "must not persist",
            practice_areas: ["Not a ClickUp option"],
            practice_area_sync_base: ["Family"],
          },
        );
        assert.equal(invalidOption.status, 400, "unknown practice-area option must be rejected");
        const afterInvalid = await call(baseUrl, "GET", `/api/ads-os/clients/${CID}/criteria`);
        assert.deepEqual(afterInvalid.body.criteria.practice_areas, ["Family"]);
        assert.equal(afterInvalid.body.criteria.notes, "", "invalid option leaves unrelated local fields unchanged");
        console.log("  ✓ E: invalid ClickUp option → 400 with no ClickUp or local change");

        // ── (F) malformed body → 400 ────────────────────────────────────────
        const bad = await call(baseUrl, "PUT", `/api/ads-os/clients/${CID}/criteria`, ["not", "an", "object"]);
        assert.equal(bad.status, 400, "array body must be rejected with 400");
        console.log("  ✓ F: array body → 400");

        // ── (G) both schedules change: refreshes best-effort, save never fails
        const put3 = await call(baseUrl, "PUT", `/api/ads-os/clients/${CID}/criteria`, {
          ...emptyCriteria(),
          business_name: `Alias Save ${RUN}`,
          practice_areas: ["Family"],
          practice_area_sync_base: ["Family"],
          schedule_days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
          lsa_schedule_days: ["Mon", "Wed"],
        });
        assert.equal(put3.status, 200, `schedule-change PUT must still be 200 while Ads is failing (got ${put3.status}: ${JSON.stringify(put3.body)})`);
        assert.equal(put3.body.ok, true, "save succeeds; GAds + LSA pacing-store refreshes are best-effort");
        const afterSched = await call(baseUrl, "GET", `/api/ads-os/clients/${CID}/criteria`);
        assert.deepEqual(afterSched.body.criteria.schedule_days, ["Mon", "Tue", "Wed", "Thu", "Fri"]);
        assert.deepEqual(afterSched.body.criteria.lsa_schedule_days, ["Mon", "Wed"], "LSA schedule saved independently");
        console.log("  ✓ G: GAds+LSA schedule-change PUT survives a failing Ads API (best-effort refreshes)");

        // ── (H) unrelated save reconciles a newer ClickUp selection first ───
        const writesBeforeExternalEdit = clickUpWriteBodies.length;
        selectedPracticeAreaIds = ["pa-immigration"]; // external edit after form load
        const reconciledUnrelated = await call(
          baseUrl,
          "PUT",
          `/api/ads-os/clients/${CID}/criteria`,
          {
            ...afterSched.body.criteria,
            notes: "unrelated edit after external ClickUp change",
            practice_area_sync_base: ["Family"],
          },
        );
        assert.equal(reconciledUnrelated.status, 200);
        assert.equal(
          clickUpWriteBodies.length,
          writesBeforeExternalEdit,
          "an unrelated save must not write the stale form selection back to ClickUp",
        );
        const afterReconcile = await call(baseUrl, "GET", `/api/ads-os/clients/${CID}/criteria`);
        assert.deepEqual(afterReconcile.body.criteria.practice_areas, ["Immigration"]);
        assert.equal(
          afterReconcile.body.criteria.notes,
          "unrelated edit after external ClickUp change",
          "strict local mirror is reconciled to fresh ClickUp while unrelated fields persist",
        );
        console.log("  ✓ H: unrelated save reconciles a newer ClickUp selection without overwriting it");

        // ── (I) ClickUp write failure leaves the strict local mirror unchanged
        clickUpWriteFailure = true;
        const failedWrite = await call(
          baseUrl,
          "PUT",
          `/api/ads-os/clients/${CID}/criteria`,
          {
            ...afterSched.body.criteria,
            notes: "must not survive failed ClickUp write",
            practice_areas: ["Family"],
            practice_area_sync_base: ["Immigration"],
          },
        );
        assert.equal(failedWrite.status, 503, "transient ClickUp write failure is actionable");
        assert.match(failedWrite.body.detail, /No Ads OS criteria were changed/i);
        clickUpWriteFailure = false;
        const afterFailedWrite = await call(baseUrl, "GET", `/api/ads-os/clients/${CID}/criteria`);
        assert.deepEqual(afterFailedWrite.body.criteria.practice_areas, ["Immigration"]);
        assert.equal(
          afterFailedWrite.body.criteria.notes,
          "unrelated edit after external ClickUp change",
          "failed ClickUp write blocks the local document",
        );
        console.log("  ✓ I: failed ClickUp write keeps the strict local criteria unchanged");

        // ── (J) local failure after ClickUp success is idempotently retry-safe
        const failFn = `test_fail_criteria_put_${RUN.replace(/[^a-z0-9_]/gi, "_")}`;
        const failTrigger = `${failFn}_trigger`;
        await db.execute(
          sql.raw(
            `CREATE FUNCTION "${failFn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'stubbed strict local criteria failure'; END; $$`,
          ),
        );
        await db.execute(
          sql.raw(
            `CREATE TRIGGER "${failTrigger}" BEFORE INSERT OR UPDATE ON ads_os_clients_criteria FOR EACH ROW EXECUTE FUNCTION "${failFn}"()`,
          ),
        );
        const retryBody = {
          ...afterFailedWrite.body.criteria,
          notes: "retry-safe local convergence",
          practice_areas: ["Criminal Defense"],
          practice_area_sync_base: ["Immigration"],
        };
        let partialFailure: Awaited<ReturnType<typeof call>>;
        try {
          partialFailure = await call(
            baseUrl,
            "PUT",
            `/api/ads-os/clients/${CID}/criteria`,
            retryBody,
          );
        } finally {
          await db.execute(
            sql.raw(
              `DROP TRIGGER IF EXISTS "${failTrigger}" ON ads_os_clients_criteria`,
            ),
          );
          await db.execute(sql.raw(`DROP FUNCTION IF EXISTS "${failFn}"()`));
        }
        assert.equal(partialFailure.status, 503);
        assert.match(partialFailure.body.detail, /ClickUp was updated.*retry Save/i);
        const writesAfterPartialFailure = clickUpWriteBodies.length;
        const retry = await call(
          baseUrl,
          "PUT",
          `/api/ads-os/clients/${CID}/criteria`,
          retryBody,
        );
        assert.equal(retry.status, 200, "retry converges the strict local mirror");
        assert.equal(
          clickUpWriteBodies.length,
          writesAfterPartialFailure,
          "retry recognizes the already-applied ClickUp selection and does not write twice",
        );
        const afterRetry = await call(baseUrl, "GET", `/api/ads-os/clients/${CID}/criteria`);
        assert.deepEqual(afterRetry.body.criteria.practice_areas, ["Criminal Defense"]);
        assert.equal(afterRetry.body.criteria.notes, "retry-safe local convergence");
        console.log("  ✓ J: local failure after ClickUp success retries without a duplicate vendor write");

        // ── (K) pre-success outage disables sync but permits unrelated saves
        __testResetDirectoryCache();
        clickUpReadOutage = true;
        const unavailable = await call(baseUrl, "GET", `/api/ads-os/clients/${CID}/criteria`);
        assert.equal(unavailable.status, 200);
        assert.equal(unavailable.body.practice_area_sync_available, false);
        assert.deepEqual(unavailable.body.practice_area_options, []);
        assert.deepEqual(
          unavailable.body.criteria.practice_areas,
          ["Criminal Defense"],
          "without a successful directory load the stored selection remains visible",
        );
        const unrelatedSave = await call(
          baseUrl,
          "PUT",
          `/api/ads-os/clients/${CID}/criteria`,
          {
            ...unavailable.body.criteria,
            notes: "unrelated edit while ClickUp is unavailable",
            practice_area_sync_base: ["Criminal Defense"],
          },
        );
        assert.equal(unrelatedSave.status, 200, "unchanged practice areas do not block unrelated fields");
        const blockedOverwrite = await call(
          baseUrl,
          "PUT",
          `/api/ads-os/clients/${CID}/criteria`,
          {
            ...unavailable.body.criteria,
            notes: "must not replace the successful unrelated edit",
            practice_areas: ["Immigration"],
            practice_area_sync_base: ["Criminal Defense"],
          },
        );
        assert.equal(blockedOverwrite.status, 503, "unavailable sync blocks practice-area overwrite");
        const afterOutage = await call(baseUrl, "GET", `/api/ads-os/clients/${CID}/criteria`);
        assert.equal(afterOutage.body.criteria.notes, "unrelated edit while ClickUp is unavailable");
        assert.deepEqual(afterOutage.body.criteria.practice_areas, ["Criminal Defense"]);
        clickUpReadOutage = false;
        __testResetDirectoryCache();
        console.log("  ✓ K: pre-load outage disables only practice-area overwrite; unrelated save remains available");

        // ── (L) any signed-in user can read/save through both aliases ───────
        activeUserId = LOWEST_ROLE_ID;
        for (const base of ["clients", "keyword-intel"]) {
          const lowestGet = await call(baseUrl, "GET", `/api/ads-os/${base}/${CID}/criteria`);
          assert.equal(
            lowestGet.status,
            200,
            `lowest-permission user GET /${base} must remain session-authenticated but role-open`,
          );
          const lowestPut = await call(baseUrl, "PUT", `/api/ads-os/${base}/${CID}/criteria`, {
            ...lowestGet.body.criteria,
            notes: `saved by lowest role via ${base}`,
            practice_area_sync_base: lowestGet.body.criteria.practice_areas,
          });
          assert.equal(
            lowestPut.status,
            200,
            `lowest-permission user PUT /${base} must save criteria`,
          );
        }
        const afterLowestRoleSaves = await call(
          baseUrl,
          "GET",
          `/api/ads-os/clients/${CID}/criteria`,
        );
        assert.equal(
          afterLowestRoleSaves.body.criteria.notes,
          "saved by lowest role via keyword-intel",
          "legacy alias saves the canonical criteria document",
        );
        const unrelatedMutation = await call(baseUrl, "POST", "/api/ads-os/directory/refresh");
        assert.equal(
          unrelatedMutation.status,
          403,
          "opening criteria editing must not open unrelated Ads OS mutations",
        );
        console.log("  ✓ L: lowest-permission user reads and saves through both criteria aliases; unrelated writes stay CEO-only");

        // ── (M) unauthenticated criteria requests → 401 ────────────────────
        activeUserId = null;
        for (const base of ["clients", "keyword-intel"]) {
          for (const method of ["GET", "PUT"] as const) {
            const anon = await call(
              baseUrl,
              method,
              `/api/ads-os/${base}/${CID}/criteria`,
              method === "PUT" ? emptyCriteria() : undefined,
            );
            assert.equal(
              anon.status,
              401,
              `unauthenticated ${method} /${base} must be 401 (got ${anon.status})`,
            );
          }
        }
        console.log("  ✓ M: unauthenticated users are rejected from every criteria alias and method");

        // ── (N) cron gate ───────────────────────────────────────────────────
        delete process.env.CRON_SECRET;
        const unset = await call(baseUrl, "POST", "/api/ads-os/cron/refresh-pacing", undefined, {
          "x-cron-key": "anything",
        });
        assert.equal(unset.status, 401, "CRON_SECRET unset → 401 even with a header");

        process.env.CRON_SECRET = `test-cron-${RUN}`;
        const noHeader = await call(baseUrl, "POST", "/api/ads-os/cron/refresh-pacing");
        assert.equal(noHeader.status, 401, "missing X-Cron-Key → 401");
        const wrong = await call(baseUrl, "POST", "/api/ads-os/cron/refresh-pacing", undefined, {
          "x-cron-key": "wrong-key",
        });
        assert.equal(wrong.status, 401, "wrong X-Cron-Key → 401");
        console.log("  ✓ N: cron endpoint 401s — unset secret, missing key, wrong key");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    {
      // Both pacing stores: the PUT handler's best-effort refresh hooks write
      // ads_os_budget_pacing (GAds) and ads_os_lsa_budget_pacing (LSA); an
      // uncloned table would fall through search_path to the real public one.
      tables: ["users", "ads_os_clients_criteria", "ads_os_budget_pacing", "ads_os_lsa_budget_pacing"],
      pinGetDbForCrossAsync: true,
    },
  );

  if (savedCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedCronSecret;
  globalThis.fetch = realFetch;
  await __test_drainDirectoryAlertWork();
  await getGlobalDispatcher().close();

  console.log("ads-os-criteria-cron-routes: all sections passed (Task #3598).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("ads-os-criteria-cron-routes: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
