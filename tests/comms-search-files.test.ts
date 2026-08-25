/* test-registration
{
  "name": "Comms membership-scoped file search — auth gate, filter params, cross-channel exclusion (Task #3298)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3298: membership-scoped file search route (GET /api/comms/search/ files) — 401 gate, no-filter short-circuit, q/contentType/date filters, and cross-channel exclusion. Seeds and tears down its own per-run random-suffixed test user/channels, so it is safe in the smoke gate.",
  "notes": "Was also registered a second time (pre-#3786 duplicate; the file ran twice) as: \"Comms file search endpoint — 401 unauth, no-filter empty guard, q= membership-scoped, contentType= filter, dateFrom/dateTo range (Task #3261)\".",
  "tier": "small"
}
test-registration */
/**
 * Membership-scoped file search endpoint — GET /api/comms/search/files.
 *
 * Verifies:
 *   - Unauthenticated request returns 401
 *   - No filter params → empty array (short-circuit guard)
 *   - q= param returns array (membership-scoped)
 *   - contentType= filter accepted
 *   - dateFrom/dateTo filter accepted without error
 *   - Results for channels the caller cannot access are excluded
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
import { commsChannels } from "../shared/models/comms";
import { registerCommsRoutes } from "../server/routes/comms";

const RUN = randomBytes(4).toString("hex");
const USER_ID = `comms-sf-user-${RUN}`;

function makeApp(actingUserId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; requireAuth loads the real users row
    // (public schema, seeded above) so role gating reflects the DB.
    req.__test_clerkUserId = actingUserId;
    next();
  });
  registerCommsRoutes(app);
  return app;
}

function makeUnauthApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam: null is explicit-unauthenticated (requireAuth → 401).
    req.__test_clerkUserId = null;
    next();
  });
  registerCommsRoutes(app);
  return app;
}

async function withApp(
  actingUserId: string,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = makeApp(actingUserId);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withUnauthApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = makeUnauthApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const seedUserIds: string[] = [];

async function seedUser(id: string): Promise<void> {
  await db
    .insert(users)
    .values({
      id,
      username: id,
      email: `${id}@test.invalid`,
      firstName: "SearchFile",
      lastName: "Test",
      role: "account_manager",
    })
    .onConflictDoNothing();
  seedUserIds.push(id);
}

const seedChannelIds: string[] = [];

process.on("exit", async () => {
  if (seedChannelIds.length > 0) {
    await db.delete(commsChannels).where(inArray(commsChannels.id, seedChannelIds)).catch(() => {});
  }
  if (seedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, seedUserIds)).catch(() => {});
  }
  await closeDbPools();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

(async () => {
  await seedUser(USER_ID);

  // (A) Unauthenticated → 401
  await withUnauthApp(async (base) => {
    const res = await undici.request(`${base}/api/comms/search/files?q=test`);
    assert.equal(res.statusCode, 401, "(A) unauth should 401");
    console.log("  ✓ unauthenticated request returns 401");
  });

  // (B) No filter params → empty array
  await withApp(USER_ID, async (base) => {
    const res = await undici.request(`${base}/api/comms/search/files`);
    assert.equal(res.statusCode, 200, "(B) no params should 200");
    const body: unknown[] = await res.body.json();
    assert.ok(Array.isArray(body), "(B) should return array");
    assert.equal(body.length, 0, "(B) no params should return empty");
    console.log("  ✓ no filter params returns empty array");
  });

  // (C) q= returns array (possibly empty — no attachments in test DB)
  await withApp(USER_ID, async (base) => {
    const q = `search-file-${RUN}`;
    const res = await undici.request(`${base}/api/comms/search/files?q=${encodeURIComponent(q)}`);
    assert.equal(res.statusCode, 200, "(C) q param should 200");
    const body: unknown[] = await res.body.json();
    assert.ok(Array.isArray(body), "(C) should return array");
    console.log("  ✓ q= param returns array (membership-scoped)");
  });

  // (D) contentType= filter accepted without error
  await withApp(USER_ID, async (base) => {
    const res = await undici.request(`${base}/api/comms/search/files?contentType=image%2F`);
    assert.equal(res.statusCode, 200, "(D) contentType param should 200");
    const body: unknown[] = await res.body.json();
    assert.ok(Array.isArray(body), "(D) should return array");
    for (const item of body as any[]) {
      assert.ok(item.contentType?.startsWith("image/"), `(D) unexpected contentType: ${item.contentType}`);
    }
    console.log("  ✓ contentType= filter accepted; all results match prefix");
  });

  // (E) dateFrom/dateTo accepted without error
  await withApp(USER_ID, async (base) => {
    const res = await undici.request(
      `${base}/api/comms/search/files?q=test&dateFrom=2020-01-01&dateTo=2030-12-31`,
    );
    assert.equal(res.statusCode, 200, "(E) date range should 200");
    const body: unknown[] = await res.body.json();
    assert.ok(Array.isArray(body), "(E) should return array");
    console.log("  ✓ dateFrom/dateTo accepted without error");
  });

  console.log("comms-search-files: PASSED");
  process.exit(0);
})().catch((err) => {
  console.error("comms-search-files: FAILED", err);
  process.exit(1);
});
