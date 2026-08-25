/* test-registration
{
  "name": "Hide-demo filter — isDemo marker on list payloads (Task #4363)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4363: the global hide-demo toggle (audit P3-4) filters client-side on the isDemo marker carried by GET /api/dashboard/client-summaries, GET /api/reports/matrix, and GET /api/clients. If any of those payloads silently drops the field, the toggle no-ops on that surface with no visible error. This locks the marker's presence and value on all three endpoints for a CEO caller (the only role that still sees demo rows) plus the pure partition helper every surface shares. Real routes + real auth seam; DB writes are suite-owned run-token-suffixed users/clients rows deleted in finally.",
  "tier": "small"
}
test-registration */
/**
 * Task #4363 — contract test for the global "hide demo/test accounts"
 * filter's data dependency: every adopting list payload must carry the
 * `isDemo` marker (the same `clients.is_demo` flag behind the in-app
 * "Demo Account" badge).
 *
 * Covers:
 *   1. GET /api/dashboard/client-summaries (Dashboard) — summaries carry
 *      isDemo true/false for the fixture rows.
 *   2. GET /api/reports/matrix (Report Matrix) — rows carry isDemo.
 *   3. GET /api/clients (admin Client Management) — storage rows carry
 *      isDemo.
 *   4. partitionDemoAccounts — the shared pure helper: off = passthrough
 *      with hiddenDemoCount 0; on = drops only flagged rows and counts
 *      them; rows without the key stay visible.
 *
 * Caller is a CEO fixture because the server already strips demo rows for
 * every other role on these endpoints — the client-side toggle is the
 * CEO-facing control (their demo account legitimately lives in prod).
 *
 * Isolation note (.agents/memory/route-test-public-schema-collision.md):
 * writes to public.users/public.clients carry a per-run random token in
 * ids/names/codes and are deleted in finally. Assertions scope to fixture
 * ids, never totals.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { inArray } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users, clients } from "@shared/schema";
import { registerClientRoutes } from "../server/routes/clients";
import { registerReportRoutes } from "../server/routes/reports";
import { partitionDemoAccounts } from "../client/src/lib/demoAccounts";

const RUN = randomBytes(4).toString("hex");

const CEO_ID = `hidedemo-4363-ceo-${RUN}`;
const DEMO_CLIENT_ID = `hidedemo-4363-demo-${RUN}`;
const REAL_CLIENT_ID = `hidedemo-4363-real-${RUN}`;

async function seed(): Promise<void> {
  await db.insert(users).values({
    id: CEO_ID,
    email: `ceo-4363-${RUN}@test.local`,
    firstName: "Hd-Ceo",
    lastName: `T4363-${RUN}`,
    role: "ceo",
    functions: [],
    authorityLevel: "lead",
  });
  await db.insert(clients).values([
    {
      id: DEMO_CLIENT_ID,
      // clientCode is varchar(10) unique — "D" + 8 hex chars fits.
      clientCode: `D${RUN}`,
      firmName: `Demo Firm T4363 ${RUN}`,
      isDemo: true,
    },
    {
      id: REAL_CLIENT_ID,
      clientCode: `N${RUN}`,
      firmName: `Real Firm T4363 ${RUN}`,
      isDemo: false,
    },
  ]);
}

async function cleanup(): Promise<void> {
  await db.delete(clients).where(inArray(clients.id, [DEMO_CLIENT_ID, REAL_CLIENT_ID]));
  await db.delete(users).where(inArray(users.id, [CEO_ID]));
}

/**
 * Real route modules behind the Clerk-era per-request test seam
 * (server/middlewares/requireAuth.ts): a string authenticates as that
 * userId; the seeded users row supplies the CEO role end-to-end.
 */
async function withApp<T>(
  sub: string | null,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.__test_clerkUserId = sub;
    next();
  });
  registerClientRoutes(app);
  registerReportRoutes(app);

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

async function main(): Promise<void> {
  console.log("Hide-demo filter — isDemo marker on list payloads (Task #4363)");

  await seed();
  try {
    await withApp(CEO_ID, async (baseUrl) => {
      await step("GET /api/dashboard/client-summaries carries isDemo", async () => {
        const r = await fetch(`${baseUrl}/api/dashboard/client-summaries`);
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        const rows = (await r.json()) as Array<Record<string, any>>;
        assert.ok(Array.isArray(rows), "summaries payload must be an array");
        const byId = new Map(rows.map((c) => [c.id, c]));
        const demo = byId.get(DEMO_CLIENT_ID);
        const real = byId.get(REAL_CLIENT_ID);
        assert.ok(demo, "CEO summaries must include the demo fixture");
        assert.ok(real, "CEO summaries must include the non-demo fixture");
        assert.equal(demo!.isDemo, true, "demo fixture must carry isDemo: true");
        assert.equal(real!.isDemo, false, "non-demo fixture must carry isDemo: false");
      });

      await step("GET /api/reports/matrix carries isDemo", async () => {
        const r = await fetch(`${baseUrl}/api/reports/matrix`);
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        const rows = (await r.json()) as Array<Record<string, any>>;
        assert.ok(Array.isArray(rows), "matrix payload must be an array");
        const byId = new Map(rows.map((c) => [c.clientId, c]));
        const demo = byId.get(DEMO_CLIENT_ID);
        const real = byId.get(REAL_CLIENT_ID);
        assert.ok(demo, "CEO matrix must include the demo fixture");
        assert.ok(real, "CEO matrix must include the non-demo fixture");
        assert.equal(demo!.isDemo, true, "demo matrix row must carry isDemo: true");
        assert.equal(real!.isDemo, false, "non-demo matrix row must carry isDemo: false");
      });

      await step("GET /api/clients carries isDemo", async () => {
        const r = await fetch(`${baseUrl}/api/clients`);
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        const rows = (await r.json()) as Array<Record<string, any>>;
        assert.ok(Array.isArray(rows), "unpaginated /api/clients payload must be an array");
        const byId = new Map(rows.map((c) => [c.id, c]));
        const demo = byId.get(DEMO_CLIENT_ID);
        const real = byId.get(REAL_CLIENT_ID);
        assert.ok(demo, "CEO client list must include the demo fixture");
        assert.ok(real, "CEO client list must include the non-demo fixture");
        assert.equal(demo!.isDemo, true, "demo client row must carry isDemo: true");
        assert.equal(real!.isDemo, false, "non-demo client row must carry isDemo: false");
      });
    });

    await step("partitionDemoAccounts: off = passthrough, count 0", async () => {
      const rows = [
        { id: "a", isDemo: true },
        { id: "b", isDemo: false },
        { id: "c" },
      ];
      const off = partitionDemoAccounts(rows, false);
      assert.deepEqual(
        off.visible.map((r) => r.id),
        ["a", "b", "c"],
        "toggle off must keep every row (demo included)",
      );
      assert.equal(off.hiddenDemoCount, 0, "toggle off reports zero hidden");
    });

    await step("partitionDemoAccounts: on = drops only flagged rows, counts them", async () => {
      const rows = [
        { id: "a", isDemo: true },
        { id: "b", isDemo: false },
        { id: "c" }, // marker absent → visible (never guess a row is demo)
        { id: "d", isDemo: null }, // storage rows can carry null
        { id: "e", isDemo: true },
      ];
      const on = partitionDemoAccounts(rows, true);
      assert.deepEqual(
        on.visible.map((r) => r.id),
        ["b", "c", "d"],
        "toggle on must drop exactly the isDemo: true rows",
      );
      assert.equal(on.hiddenDemoCount, 2, "hidden count matches the dropped rows");
      const none = partitionDemoAccounts([{ id: "x", isDemo: false }], true);
      assert.equal(none.hiddenDemoCount, 0, "active filter over zero demo rows reports 0 hidden");
      assert.equal(none.visible.length, 1, "non-demo rows all stay visible");
    });
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} step(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nAll steps passed");
  }

  // Route tests that fetch a local server hang on exit unless undici's
  // keep-alive sockets are closed (see users-paged-route.test.ts).
  await undici.getGlobalDispatcher().close();
  await closeDbPools();
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
  try {
    await cleanup();
    await undici.getGlobalDispatcher().close();
    await closeDbPools();
  } catch {}
});
