/* test-registration
{
  "name": "GET /api/users/paged — server-paged user list contract (Task #4348)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4348: /admin/users now renders exclusively through GET /api/users/paged (the legacy whole-table fetch hung the page at ~8k rows). This locks the endpoint's auth gates (401/403/Team Lead+), page shape, filter semantics (search/facet/fn/authority), pagination math, the zod pageSize cap, and the per-row originalEmailTaken enrichment the restore-email UI depends on. Real routes + real role middleware; DB writes are suite-owned run-token-suffixed users rows deleted in finally.",
  "tier": "small"
}
test-registration */
/**
 * Task #4348 — contract test for the server-paged user list that powers
 * the virtualized /admin/users table.
 *
 * Covers:
 *   1. Auth: 401 unauthenticated, 403 for account_manager (below Team
 *      Lead), 200 for team_lead.
 *   2. Shape: { data, total, unableTotal, fallbackEmailTotal } with
 *      global counts as numbers; soft-deleted users never listed.
 *   3. Search: run-token ILIKE search scopes to the suite's fixtures.
 *   4. Pagination: stable firstName+id order, disjoint pages, exact
 *      totals across pages.
 *   5. Filters: facet (revenue/fulfillment/both/unassigned via function
 *      overlap), fn (array contains), authority ('core' also matches
 *      NULL legacy rows), unable=1 (subset of the unfiltered rows —
 *      exact membership depends on live Twilio settings, deliberately
 *      not pinned; see .agents/memory/test-shared-setting-pinning...).
 *   6. Validation: pageSize above the 200 cap and page=0 → 400.
 *   7. originalEmailTaken enrichment: true when the stripped original
 *      address belongs to ANOTHER active user, false when free, absent
 *      on non-fallback rows.
 *
 * Isolation note (.agents/memory/route-test-public-schema-collision.md):
 * writes to shared dev public.users carry a per-run random token in ids,
 * names, and emails, and are deleted in finally. Assertions are scoped
 * to the token search — never to global totals (unableTotal /
 * fallbackEmailTotal are whole-table by design, so those are only
 * bounded, not pinned).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { inArray } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import { registerSettingsRoutes } from "../server/routes/settings";
import { REVENUE_FUNCTIONS, FULFILLMENT_FUNCTIONS } from "../server/auth/permissions";

const RUN = randomBytes(4).toString("hex");
const REV_FN = REVENUE_FUNCTIONS[0];
const FUL_FN = FULFILLMENT_FUNCTIONS[0];

const ID = (slug: string) => `paged-4348-${slug}-${RUN}`;
const TL_ID = ID("tl");
const AM_ID = ID("am");
const REV_ID = ID("rev");
const FUL_ID = ID("ful");
const BOTH_ID = ID("both");
const UNASSIGNED_ID = ID("none");
const TAKEN_ID = ID("taken");
const OWNER_ID = ID("owner");
const FREE_ID = ID("free");
const DELETED_ID = ID("del");

const ALL_IDS = [
  TL_ID, AM_ID, REV_ID, FUL_ID, BOTH_ID, UNASSIGNED_ID,
  TAKEN_ID, OWNER_ID, FREE_ID, DELETED_ID,
];
const ACTIVE_IDS = ALL_IDS.filter((id) => id !== DELETED_ID);

// The stripped original address of TAKEN's fallback email — owned by OWNER.
const CONTESTED_EMAIL = `orig-${RUN}@test.local`;

async function seedUsers(): Promise<void> {
  await db.insert(users).values([
    // Caller — Team Lead+ so the main scenarios pass the role gate.
    {
      id: TL_ID,
      email: `tl-${RUN}@test.local`,
      firstName: "Aa-TeamLead",
      lastName: `P4348-${RUN}`,
      role: "team_lead",
      functions: [],
      authorityLevel: "lead",
    },
    // 403 contrast caller.
    {
      id: AM_ID,
      email: `am-${RUN}@test.local`,
      firstName: "Bb-Member",
      lastName: `P4348-${RUN}`,
      role: "account_manager",
      functions: [],
      authorityLevel: "core",
    },
    // Facet fixtures.
    {
      id: REV_ID,
      email: `rev-${RUN}@test.local`,
      firstName: "Cc-Revenue",
      lastName: `P4348-${RUN}`,
      role: "account_manager",
      functions: [REV_FN],
      authorityLevel: "core",
    },
    {
      id: FUL_ID,
      email: `ful-${RUN}@test.local`,
      firstName: "Dd-Fulfillment",
      lastName: `P4348-${RUN}`,
      role: "account_manager",
      functions: [FUL_FN],
      authorityLevel: "core",
    },
    {
      id: BOTH_ID,
      email: `both-${RUN}@test.local`,
      firstName: "Ee-Hybrid",
      lastName: `P4348-${RUN}`,
      role: "account_manager",
      functions: [REV_FN, FUL_FN],
      authorityLevel: "core",
    },
    // NULL authority — the 'core' filter must still match it.
    {
      id: UNASSIGNED_ID,
      email: `none-${RUN}@test.local`,
      firstName: "Ff-Unassigned",
      lastName: `P4348-${RUN}`,
      role: "account_manager",
      functions: [],
      authorityLevel: null,
    },
    // Fallback email whose stripped original is owned by OWNER → taken.
    {
      id: TAKEN_ID,
      email: `${CONTESTED_EMAIL}.restored.123`,
      firstName: "Gg-Taken",
      lastName: `P4348-${RUN}`,
      role: "account_manager",
      functions: [],
      authorityLevel: "core",
    },
    {
      id: OWNER_ID,
      email: CONTESTED_EMAIL,
      firstName: "Hh-Owner",
      lastName: `P4348-${RUN}`,
      role: "account_manager",
      functions: [],
      authorityLevel: "core",
    },
    // Fallback email whose stripped original nobody owns → free.
    {
      id: FREE_ID,
      email: `free-orig-${RUN}@test.local.restored.456`,
      firstName: "Ii-Free",
      lastName: `P4348-${RUN}`,
      role: "account_manager",
      functions: [],
      authorityLevel: "core",
    },
    // Soft-deleted — must never appear in any page.
    {
      id: DELETED_ID,
      email: `del-${RUN}@test.local`,
      firstName: "Jj-Deleted",
      lastName: `P4348-${RUN}`,
      role: "account_manager",
      functions: [],
      authorityLevel: "core",
      deletedAt: new Date(),
    },
  ]);
}

async function cleanupUsers(): Promise<void> {
  await db.delete(users).where(inArray(users.id, ALL_IDS));
}

/**
 * Builds an app with the real settings routes behind a fake session for
 * `sub` (null = unauthenticated). The role gate (requireTeamLead) reads
 * the REAL users row, so 403s are end-to-end.
 */
async function withApp<T>(
  sub: string | null,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk-era per-request test seam (server/middlewares/requireAuth.ts):
    // a string authenticates as that userId, null stays anonymous → 401.
    req.__test_clerkUserId = sub;
    next();
  });
  registerSettingsRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

type PagedResponse = {
  data: Array<Record<string, any>>;
  total: number;
  unableTotal: number;
  fallbackEmailTotal: number;
};

async function main(): Promise<void> {
  console.log("GET /api/users/paged — server-paged user list contract (Task #4348)");

  await seedUsers();
  try {
    await step("401 when unauthenticated", async () => {
      await withApp(null, async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/users/paged?page=1&pageSize=10`);
        assert.equal(r.status, 401, `expected 401, got ${r.status}`);
      });
    });

    await step("403 for account_manager (below Team Lead)", async () => {
      await withApp(AM_ID, async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/users/paged?page=1&pageSize=10`);
        assert.equal(r.status, 403, `expected 403, got ${r.status}`);
      });
    });

    await withApp(TL_ID, async (baseUrl) => {
      const get = async (qs: string): Promise<PagedResponse> => {
        const r = await fetch(`${baseUrl}/api/users/paged?${qs}`);
        assert.equal(r.status, 200, `expected 200 for ?${qs}, got ${r.status}`);
        return r.json() as Promise<PagedResponse>;
      };
      const idsOf = (b: PagedResponse) => b.data.map((u) => u.id);
      const search = `search=${encodeURIComponent(`P4348-${RUN}`)}`;

      await step("shape + run-scoped search + soft-deleted excluded", async () => {
        const body = await get(`page=1&pageSize=50&${search}`);
        assert.equal(body.total, ACTIVE_IDS.length, `total must be the ${ACTIVE_IDS.length} active fixtures, got ${body.total}`);
        assert.deepEqual(
          [...idsOf(body)].sort(),
          [...ACTIVE_IDS].sort(),
          "search page must contain exactly the active fixtures",
        );
        assert.ok(!idsOf(body).includes(DELETED_ID), "soft-deleted row must never be listed");
        assert.equal(typeof body.unableTotal, "number", "unableTotal must be a number");
        assert.equal(typeof body.fallbackEmailTotal, "number", "fallbackEmailTotal must be a number");
        // Global (whole-table) counts: only bounded — the shared dev DB
        // has ambient rows beyond this suite's fixtures.
        assert.ok(
          body.fallbackEmailTotal >= 2,
          `fallbackEmailTotal is global and this suite seeded 2 fallback rows — got ${body.fallbackEmailTotal}`,
        );
      });

      await step("pagination: firstName+id order, disjoint pages, stable totals", async () => {
        const p1 = await get(`page=1&pageSize=4&${search}`);
        const p2 = await get(`page=2&pageSize=4&${search}`);
        const p3 = await get(`page=3&pageSize=4&${search}`);
        assert.equal(p1.data.length, 4, "page 1 holds 4 rows");
        assert.equal(p2.data.length, 4, "page 2 holds 4 rows");
        assert.equal(p3.data.length, 1, "page 3 holds the remaining row");
        for (const p of [p1, p2, p3]) {
          assert.equal(p.total, ACTIVE_IDS.length, "total is identical on every page");
        }
        const all = [...idsOf(p1), ...idsOf(p2), ...idsOf(p3)];
        assert.equal(new Set(all).size, all.length, "pages must be disjoint");
        assert.deepEqual([...all].sort(), [...ACTIVE_IDS].sort(), "pages together cover every fixture");
        // Fixtures use Aa- < Bb- < … firstName prefixes, so the pages
        // must come back in that exact order.
        const names = [...p1.data, ...p2.data, ...p3.data].map((u) => u.firstName);
        assert.deepEqual(names, [...names].sort(), `rows must be ordered by firstName — got ${names.join(", ")}`);
      });

      await step("facet filters mirror the function-overlap semantics", async () => {
        const rev = await get(`page=1&pageSize=50&${search}&facet=revenue`);
        assert.deepEqual(idsOf(rev), [REV_ID], "facet=revenue → only the revenue-only fixture");
        const ful = await get(`page=1&pageSize=50&${search}&facet=fulfillment`);
        assert.deepEqual(idsOf(ful), [FUL_ID], "facet=fulfillment → only the fulfillment-only fixture");
        const both = await get(`page=1&pageSize=50&${search}&facet=both`);
        assert.deepEqual(idsOf(both), [BOTH_ID], "facet=both → only the hybrid fixture");
        const none = await get(`page=1&pageSize=50&${search}&facet=unassigned`);
        const noneIds = idsOf(none);
        assert.ok(noneIds.includes(UNASSIGNED_ID), "facet=unassigned includes the no-functions fixture");
        for (const id of [REV_ID, FUL_ID, BOTH_ID]) {
          assert.ok(!noneIds.includes(id), `facet=unassigned must exclude ${id}`);
        }
      });

      await step("fn filter → rows whose functions contain the value", async () => {
        const body = await get(`page=1&pageSize=50&${search}&fn=${encodeURIComponent(REV_FN)}`);
        assert.deepEqual(
          [...idsOf(body)].sort(),
          [REV_ID, BOTH_ID].sort(),
          `fn=${REV_FN} → revenue-only + hybrid fixtures`,
        );
      });

      await step("authority filter — 'core' also matches NULL legacy rows", async () => {
        const lead = await get(`page=1&pageSize=50&${search}&authority=lead`);
        assert.deepEqual(idsOf(lead), [TL_ID], "authority=lead → only the team-lead fixture");
        const core = await get(`page=1&pageSize=50&${search}&authority=core`);
        const coreIds = idsOf(core);
        assert.ok(coreIds.includes(UNASSIGNED_ID), "authority=core must match the NULL-authority row");
        assert.ok(!coreIds.includes(TL_ID), "authority=core must exclude the lead row");
      });

      await step("unable=1 rows are a subset of the unfiltered search rows", async () => {
        const all = await get(`page=1&pageSize=50&${search}`);
        const unable = await get(`page=1&pageSize=50&${search}&unable=1`);
        const allIds = new Set(idsOf(all));
        for (const id of idsOf(unable)) {
          assert.ok(allIds.has(id), `unable=1 returned ${id}, which the unfiltered search did not`);
        }
        assert.ok(unable.total <= all.total, "unable-filtered total cannot exceed the unfiltered total");
      });

      await step("zod validation: pageSize over the 200 cap and page=0 → 400", async () => {
        const r1 = await fetch(`${baseUrl}/api/users/paged?page=1&pageSize=500`);
        assert.equal(r1.status, 400, `pageSize=500 must 400, got ${r1.status}`);
        const r2 = await fetch(`${baseUrl}/api/users/paged?page=0&pageSize=50`);
        assert.equal(r2.status, 400, `page=0 must 400, got ${r2.status}`);
      });

      await step("originalEmailTaken enrichment: taken vs free vs absent", async () => {
        const body = await get(`page=1&pageSize=50&${search}`);
        const byId = new Map(body.data.map((u) => [u.id, u]));
        assert.equal(
          byId.get(TAKEN_ID)?.originalEmailTaken,
          true,
          "fallback row whose original is owned by another active user → originalEmailTaken: true",
        );
        assert.equal(
          byId.get(FREE_ID)?.originalEmailTaken,
          false,
          "fallback row whose original nobody owns → originalEmailTaken: false",
        );
        assert.ok(
          !("originalEmailTaken" in (byId.get(OWNER_ID) ?? {})),
          "non-fallback rows must not carry the enrichment key",
        );
      });
    });
  } finally {
    await cleanupUsers();
  }

  if (failures > 0) {
    console.error(`\n${failures} step(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nAll steps passed");
  }

  // Route tests that fetch a local server hang on exit unless undici's
  // keep-alive sockets are closed (see add-stale-location-route.test.ts).
  await undici.getGlobalDispatcher().close();
  await closeDbPools();
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
  try {
    await cleanupUsers();
    await undici.getGlobalDispatcher().close();
    await closeDbPools();
  } catch {}
});
