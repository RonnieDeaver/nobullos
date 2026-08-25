/* test-registration
{
  "name": "Ads OS LSA schedule chip — scheduleLabel formatter (Every day / en-dash runs / comma lists / unknown-token drop) + /lsa/dashboard rows carry lsa_schedule_days from the criteria store, default [] unsaved, degrade [] on a throwing read and recover (Task #3681)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3681: LSA dashboard schedule chip — scheduleLabel's compact formatting rules and the overlayLive criteria read that puts lsa_schedule_days on every dashboard row (default [] unsaved, [] on a store blip). Fetch fully stubbed, isolated-schema DB, fast; a drift here silently mislabels every account's pacing schedule.",
  "extraNodeArgs": [
    "--import",
    "./tests/ads-os-lsa-schedule-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3681 — LSA dashboard schedule chip coverage.
 *
 * (1) Unit: scheduleLabel (client/src/pages/adsOs/lib/format.ts) — the compact
 *     "Mon–Fri" chip formatter. Empty / null / all-7 → "Every day"; a
 *     contiguous run of ≥3 → en-dash range; non-contiguous or short runs →
 *     comma list; unknown tokens ignored; dupes deduped; order normalized.
 *
 * (2) Route: GET /api/ads-os/lsa/dashboard rows carry lsa_schedule_days from
 *     the criteria store (overlayLive, live on every request — no metric-cache
 *     force needed), default [] when nothing is saved, and degrade to [] when
 *     the criteria read THROWS (a store blip must not sink the row).
 *
 * Harness: ACCOUNT_ENROLLMENT=label + a fetch stub that answers the GAQL
 * enrollment queries (label resource → applied_labels → MCC accounts) with one
 * fake LSA account and empty metric slices; ClickUp is stubbed down (500) so
 * the directory serves an empty bundle (people/city null — best-effort).
 * Hermetic DB: runInIsolatedSchema clones users + every store table
 * overlayLive touches. The store-read-failure leg needs loadCriteria to
 * actually throw (storeGet swallows DB errors into null), so the criteriaService
 * module is redirected to a re-exporting stub with a settable failure —
 * requires the loader: run via
 *   npx tsx --import ./tests/ads-os-lsa-schedule-setup.mjs tests/ads-os-lsa-dashboard-schedule.test.ts
 */

process.env.NODE_ENV = "test";
process.env.ACCOUNT_ENROLLMENT = "label";

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

import { scheduleLabel } from "../client/src/pages/adsOs/lib/format";

// Dynamic imports so the env pins above land before module-load-time reads,
// and so the criteriaService stub (registered by the --import setup) is in
// place for the whole route graph.
const { registerAdsOsRoutes } = await import("../server/routes/adsOs");
const { __testResetLsaDashboardCache } = await import("../server/services/adsOs/lsaDashboardService");
const criteriaStub: any = await import("./ads-os-lsa-schedule-criteria-stub.mjs");
const { runInIsolatedSchema } = await import("./db-sandbox");
const { __test_markUserReconciled, __test_resetReconciledUsers } = await import(
  "../server/middlewares/requireAuth"
);

// ── Constants ────────────────────────────────────────────────────────────────

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const CEO_ID = `test-3681-ceo-${RUN}`;
const CID = `36${String(randomInt(0, 99999999)).padStart(8, "0")}`; // digits-only, 10 chars
const LABEL_RES = `customers/000/labels/3681`;

// ── (1) scheduleLabel unit cases ─────────────────────────────────────────────

function unitTests(): void {
  // Empty / absent → every day.
  assert.equal(scheduleLabel([]), "Every day", "empty array");
  assert.equal(scheduleLabel(null), "Every day", "null");
  assert.equal(scheduleLabel(undefined), "Every day", "undefined");
  // All 7 days (any order) → every day.
  assert.equal(
    scheduleLabel(["Sun", "Sat", "Fri", "Thu", "Wed", "Tue", "Mon"]),
    "Every day",
    "all seven days, shuffled",
  );
  // Contiguous run of ≥3 → en-dash range (order-insensitive).
  assert.equal(scheduleLabel(["Mon", "Tue", "Wed", "Thu", "Fri"]), "Mon–Fri", "weekday run");
  assert.equal(scheduleLabel(["Fri", "Wed", "Thu", "Tue", "Mon"]), "Mon–Fri", "weekday run shuffled");
  assert.equal(scheduleLabel(["Wed", "Thu", "Fri", "Sat", "Sun"]), "Wed–Sun", "late-week run");
  assert.equal(scheduleLabel(["Tue", "Wed", "Thu"]), "Tue–Thu", "minimum 3-day run");
  // Contiguous but SHORT (<3) → comma list, not a range.
  assert.equal(scheduleLabel(["Tue", "Mon"]), "Mon, Tue", "2-day contiguous stays a list");
  // Non-contiguous → comma list in week order.
  assert.equal(scheduleLabel(["Fri", "Mon", "Wed"]), "Mon, Wed, Fri", "non-contiguous");
  // Weekend-only.
  assert.equal(scheduleLabel(["Sun", "Sat"]), "Sat, Sun", "weekend only");
  // Unknown tokens ignored; unknown-only behaves like empty.
  assert.equal(scheduleLabel(["Funday", "Mon", "mon", "Tues"]), "Mon", "unknown tokens dropped");
  assert.equal(scheduleLabel(["Funday", "Blursday"]), "Every day", "all-unknown → every day");
  // Duplicates deduped (would otherwise break the contiguity math).
  assert.equal(scheduleLabel(["Mon", "Mon", "Tue", "Wed"]), "Mon–Wed", "dupes deduped");
  console.log("  ✓ 1: scheduleLabel — empty/all-7, ranges, short runs, lists, unknown tokens, dupes");
}

// ── Fetch stubs (in-process only) ────────────────────────────────────────────

const realFetch = globalThis.fetch;

function gaqlRows(query: string): any[] {
  if (query.includes("FROM label")) {
    return [{ label: { resourceName: LABEL_RES } }];
  }
  if (query.includes("applied_labels")) {
    // Label enrollment: our one fake account carries the LSA monitor label.
    return [{ customerClient: { id: CID, manager: false, appliedLabels: [LABEL_RES] } }];
  }
  if (query.includes("FROM customer_client")) {
    // mccEnabledAccounts: name/currency lookup.
    return [{ customerClient: { id: CID, descriptiveName: `LSA Test ${RUN}`, currencyCode: "USD", manager: false } }];
  }
  // Metric slices (campaign cost/status, leads, conversations): empty.
  return [];
}

function stubFetch(): void {
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
      return new Response(
        JSON.stringify({ access_token: `test-token-${RUN}`, expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (pathname.includes("googleAds:search")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const results = gaqlRows(String(body.query ?? ""));
      return new Response(JSON.stringify([{ results }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (pathname.startsWith("/api/v2/")) {
      // Directory down: empty bundle, people/city overlay degrades to nulls.
      return new Response("stubbed clickup outage", { status: 500 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

// ── App factory (Clerk test seam; real requireAuth/requireCeo run after) ─────

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = CEO_ID;
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

async function getDashboard(baseUrl: string): Promise<any> {
  const r = await fetch(`${baseUrl}/api/ads-os/lsa/dashboard`);
  const body = await r.json();
  assert.equal(r.status, 200, `dashboard must be 200 (got ${r.status}: ${JSON.stringify(body)})`);
  return body;
}

function rowFor(body: any): any {
  assert.ok(Array.isArray(body.rows), "rows array present");
  const row = body.rows.find((x: any) => x.customer_id === CID);
  assert.ok(row, `dashboard must include the stub-enrolled account ${CID} (rows: ${body.rows.length})`);
  return row;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  unitTests();

  stubFetch();
  __testResetLsaDashboardCache();

  await runInIsolatedSchema(
    async ({ db }) => {
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${CEO_ID}, 'ceo', 'CEO 3681')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);

      // Users are seeded inside the isolated schema; requireAuth resolves the
      // acting identity against its ambient public-schema `db`, so pre-register
      // the profile in the module registry to keep the real middleware in the
      // loop (role gating) without a JIT-provisioned public row.
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo", firstName: "CEO 3681" });

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      try {
        // ── (2a) no criteria saved → lsa_schedule_days defaults to [] ──────
        const fresh = rowFor(await getDashboard(baseUrl));
        assert.deepEqual(fresh.lsa_schedule_days, [], "no saved criteria → []");
        assert.equal(fresh.descriptive_name, `LSA Test ${RUN}`, "stub account name flowed through");
        console.log("  ✓ 2a: row defaults to lsa_schedule_days [] when no criteria are saved");

        // ── (2b) saved criteria → rows carry the stored schedule live ──────
        // saveCriteria is the REAL one (stub re-exports it); the store write
        // lands in the isolated-schema clone. No cache force: the criteria
        // overlay runs on every request, like the pacing overlay.
        await criteriaStub.saveCriteria(CID, {
          ...criteriaStub.emptyCriteria(),
          business_name: `LSA Test ${RUN}`,
          lsa_schedule_days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        });
        const saved = rowFor(await getDashboard(baseUrl));
        assert.deepEqual(
          saved.lsa_schedule_days,
          ["Mon", "Tue", "Wed", "Thu", "Fri"],
          "row carries the saved schedule from the criteria store on the NEXT request (no force)",
        );
        assert.equal(scheduleLabel(saved.lsa_schedule_days), "Mon–Fri", "chip label for the served row");
        console.log("  ✓ 2b: saved lsa_schedule_days overlays live onto the dashboard row");

        // ── (2c) criteria read THROWS → best-effort [] (row still serves) ──
        criteriaStub.__setLoadCriteriaFailure(new Error(`stubbed criteria outage ${RUN}`));
        try {
          const blipped = rowFor(await getDashboard(baseUrl));
          assert.deepEqual(blipped.lsa_schedule_days, [], "store blip → default [] (every day), not a sunk row");
          assert.equal(blipped.descriptive_name, `LSA Test ${RUN}`, "rest of the row unaffected by the blip");
        } finally {
          criteriaStub.__setLoadCriteriaFailure(null);
        }
        // And recovers on the next request once the store is healthy again.
        const recovered = rowFor(await getDashboard(baseUrl));
        assert.deepEqual(recovered.lsa_schedule_days, ["Mon", "Tue", "Wed", "Thu", "Fri"], "healthy read recovers");
        console.log("  ✓ 2c: a throwing criteria read degrades to [] and recovers next request");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    {
      // Every store table overlayLive reads must be cloned or the read falls
      // through search_path to the real public one (isolated-schema
      // fallthrough); ads_os_clickup_tasks stays uncloned safely only because
      // attachTaskRefs early-returns on empty alerts — clone it anyway.
      tables: [
        "users",
        "ads_os_clients_criteria",
        "ads_os_account_alerts",
        "ads_os_clickup_tasks",
        "ads_os_lsa_audit_scores",
        "ads_os_lsa_budget_pacing",
      ],
      pinGetDbForCrossAsync: true,
    },
  );

  globalThis.fetch = realFetch;
  __testResetLsaDashboardCache();
  await getGlobalDispatcher().close();

  console.log("ads-os-lsa-dashboard-schedule: all sections passed (Task #3681).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("ads-os-lsa-dashboard-schedule: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
