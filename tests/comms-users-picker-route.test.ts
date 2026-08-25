/* test-registration
{
  "name": "DM people picker teammates visible to all roles (Task #3130)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3130: the DM people picker permission contract. GET /api/comms/users must serve picker-safe teammate fields (id, name, avatar, email — nothing else) to ANY authenticated role, while the full GET /api/users stays Team Lead+ (403 for account_manager). Real routes + real role middleware; DB use is limited to seeding/removing two suite-owned, run-token-suffixed users rows.",
  "tier": "small"
}
test-registration */
/**
 * Task #3130 — the DM people picker must show teammates to ALL roles,
 * not just team leads.
 *
 * The New DM dialog previously fetched GET /api/users, which is gated
 * behind requireTeamLead — a regular authenticated user (account_manager)
 * got a 403 and the picker silently showed "Loading teammates…" forever.
 *
 * Fix (Option 2 from the task): a dedicated GET /api/comms/users endpoint,
 * open to any authenticated user, returning ONLY picker-safe display
 * fields (id, firstName, lastName, profileImageUrl, email). This test
 * locks in the contract:
 *
 *   1. An account_manager (non-team-lead) gets 200 + the teammate list,
 *      including themselves.
 *   2. The response rows carry ONLY the five picker-safe fields — no
 *      role, settings, or audit columns leak.
 *   3. Soft-deleted users are excluded.
 *   4. Contrast: the same user still 403s on GET /api/users, proving the
 *      picker cannot depend on the Team Lead+ surface.
 *
 * Isolation note (.agents/memory/route-test-public-schema-collision.md):
 * this route test writes to the shared dev DB public.users — all seeded
 * ids/emails carry a per-run random token and are deleted in finally.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { eq, inArray } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import { registerCommsRoutes } from "../server/routes/comms";
import { registerSettingsRoutes } from "../server/routes/settings";

const RUN = randomBytes(4).toString("hex");
const AM_USER_ID = `picker-3130-am-${RUN}`;
const DELETED_USER_ID = `picker-3130-del-${RUN}`;

const PICKER_FIELDS = ["id", "firstName", "lastName", "profileImageUrl", "email"].sort();

async function seedUsers(): Promise<void> {
  await db.insert(users).values([
    {
      id: AM_USER_ID,
      email: `picker-3130-am-${RUN}@test.local`,
      firstName: "Regular",
      lastName: `Member-${RUN}`,
      role: "account_manager",
    },
    {
      id: DELETED_USER_ID,
      email: `picker-3130-del-${RUN}@test.local`,
      firstName: "Ghost",
      lastName: `Deleted-${RUN}`,
      role: "account_manager",
      deletedAt: new Date(),
    },
  ]);
}

async function cleanupUsers(): Promise<void> {
  await db.delete(users).where(inArray(users.id, [AM_USER_ID, DELETED_USER_ID]));
}

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  // Clerk test seam (server/middlewares/requireAuth.ts): a string authenticates
  // as that user id. requireAuth reads the REAL users row from the (committed,
  // public-schema) seed, so the role gate (requireTeamLead) 403 contrast below
  // is end-to-end, not stubbed.
  app.use((req: any, _res, next) => {
    (req as any).__test_clerkUserId = AM_USER_ID;
    next();
  });
  registerCommsRoutes(app);
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

async function main(): Promise<void> {
  console.log("DM people picker — teammates visible to all roles (Task #3130)");

  await seedUsers();
  try {
    await withApp(async (baseUrl) => {
      let pickerRows: any[] = [];

      await step(
        "account_manager (non-team-lead) gets 200 + teammate list from GET /api/comms/users",
        async () => {
          const r = await fetch(`${baseUrl}/api/comms/users`);
          assert.equal(r.status, 200, `expected 200, got ${r.status}`);
          pickerRows = await r.json();
          assert.ok(Array.isArray(pickerRows), "response must be an array");
          const me = pickerRows.find((u) => u.id === AM_USER_ID);
          assert.ok(me, "the seeded non-team-lead user must appear in the picker list");
          assert.equal(me.firstName, "Regular");
          assert.equal(me.lastName, `Member-${RUN}`);
        },
      );

      await step("rows carry ONLY the five picker-safe fields (no role/settings leak)", async () => {
        assert.ok(pickerRows.length > 0, "picker list must be non-empty for this check");
        for (const row of pickerRows) {
          assert.deepEqual(
            Object.keys(row).sort(),
            PICKER_FIELDS,
            `unexpected field set on picker row ${row.id}: ${Object.keys(row).join(",")}`,
          );
        }
      });

      await step("soft-deleted users are excluded from the picker", async () => {
        assert.equal(
          pickerRows.find((u) => u.id === DELETED_USER_ID),
          undefined,
          "soft-deleted user must NOT appear in the picker list",
        );
      });

      await step(
        "contrast: the same user still 403s on the Team Lead+ GET /api/users",
        async () => {
          const r = await fetch(`${baseUrl}/api/users`);
          assert.equal(
            r.status,
            403,
            `GET /api/users must stay Team Lead+ (got ${r.status}) — the picker must not depend on it`,
          );
        },
      );
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
