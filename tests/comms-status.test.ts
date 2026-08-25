/* test-registration
{
  "name": "Comms user status — deriveEffectiveStatus, storage CRUD, route smoke (Task #3310)",
  "smoke": true,
  "smokeReason": "Comms user status smoke gate: proves deriveEffectiveStatus all 11 precedence paths (pure, DB-free), storage CRUD (getUserStatus, setUserManualStatus, setUserCustomStatus, touchUserActivity, getUserStatusBulk) in isolated schema, and route smoke (GET/PUT status/me, PUT status/me/custom, GET status/bulk, 400 on invalid status enum). Validates auto-away window + DND expiry guard.",
  "tier": "small"
}
test-registration */
/**
 * Comms user status — unit + integration tests.
 *
 * Coverage:
 *  1. deriveEffectiveStatus pure helper — all 11 precedence paths + DND expiry guard
 *  2. Storage CRUD via runInIsolatedSchema (isolated public.* clone)
 *  3. Route smoke: GET/PUT /api/comms/status/me, PUT /api/comms/status/me/custom,
 *     GET /api/comms/status/bulk, 400 on invalid status enum
 */

// Self-establish test mode so the Clerk per-request auth seam is honored even
// under a bare `tsx` repro (requireAuth reads NODE_ENV at request time).
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import { createServer } from "http";

import {
  deriveEffectiveStatus,
  COMMS_AUTO_AWAY_WINDOW_MS,
} from "../server/services/commsPresence.ts";
import { runInIsolatedSchema } from "./db-sandbox.ts";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth.ts";

const RUN = randomBytes(4).toString("hex");

// ─── pure helper assertions ────────────────────────────────────────────────────

function row(overrides: {
  manualStatus?: string | null;
  dndExpiresAt?: Date | null;
  priorStatus?: string | null;
  lastActivityAt?: Date | null;
} = {}) {
  return {
    manualStatus: null,
    dndExpiresAt: null,
    priorStatus: null,
    lastActivityAt: null,
    ...overrides,
  };
}

const NOW = Date.now();

// 1. null row + active heartbeat → online
assert.equal(deriveEffectiveStatus(null, true, NOW), "online", "null row + heartbeat → online");

// 2. no heartbeat + recent activity → away
assert.equal(
  deriveEffectiveStatus(row({ lastActivityAt: new Date(NOW - COMMS_AUTO_AWAY_WINDOW_MS / 2) }), false, NOW),
  "away",
  "no heartbeat + recent activity → away",
);

// 3. no heartbeat + stale activity → offline
assert.equal(
  deriveEffectiveStatus(row({ lastActivityAt: new Date(NOW - COMMS_AUTO_AWAY_WINDOW_MS - 1000) }), false, NOW),
  "offline",
  "no heartbeat + stale activity → offline",
);

// 4. active DND → dnd
assert.equal(
  deriveEffectiveStatus(row({ manualStatus: "dnd", dndExpiresAt: new Date(NOW + 60_000) }), false, NOW),
  "dnd",
  "active DND → dnd",
);

// 5. expired DND + priorStatus → restore priorStatus
assert.equal(
  deriveEffectiveStatus(row({ manualStatus: "dnd", dndExpiresAt: new Date(NOW - 1000), priorStatus: "away" }), false, NOW),
  "away",
  "expired DND, priorStatus=away → away",
);

// 6. expired DND, no priorStatus → online fallback
assert.equal(
  deriveEffectiveStatus(row({ manualStatus: "dnd", dndExpiresAt: new Date(NOW - 1000), priorStatus: null }), false, NOW),
  "online",
  "expired DND, no priorStatus → online fallback",
);

// 7. expired DND, priorStatus=dnd → guard returns online
assert.equal(
  deriveEffectiveStatus(row({ manualStatus: "dnd", dndExpiresAt: new Date(NOW - 1000), priorStatus: "dnd" }), false, NOW),
  "online",
  "expired DND, priorStatus=dnd → online (guard)",
);

// 8. DND no expiry → dnd forever
assert.equal(
  deriveEffectiveStatus(row({ manualStatus: "dnd", dndExpiresAt: null }), false, NOW),
  "dnd",
  "DND no expiry → dnd forever",
);

// 9. manual=offline overrides active heartbeat
assert.equal(
  deriveEffectiveStatus(row({ manualStatus: "offline" }), true, NOW),
  "offline",
  "manual offline overrides active heartbeat",
);

// 10. manual=away overrides active heartbeat
assert.equal(
  deriveEffectiveStatus(row({ manualStatus: "away" }), true, NOW),
  "away",
  "manual away overrides active heartbeat",
);

// 11. manual=online overrides dead heartbeat
assert.equal(
  deriveEffectiveStatus(row({ manualStatus: "online" }), false, NOW),
  "online",
  "manual online overrides dead heartbeat",
);

console.log("ok  deriveEffectiveStatus: 11 pure assertions passed");

// ─── fake-auth helpers ─────────────────────────────────────────────────────────

function makeAuthMiddleware(userId: string, _role = "account_manager") {
  return (_req: any, _res: any, next: any) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. The users row is seeded in an isolated
    // schema (uncommitted to public), so the acting identity is pre-registered
    // via __test_markUserReconciled before requests fire — requireAuth then
    // populates req.user/req.dbUser itself from that profile.
    _req.__test_clerkUserId = userId;
    next();
  };
}

async function buildTestApp(userId: string, role = "account_manager") {
  const app = express();
  app.use(express.json());
  app.use(makeAuthMiddleware(userId, role));
  const { registerCommsRoutes } = await import("../server/routes/comms.js");
  registerCommsRoutes(app);
  return app;
}

let baseUrl = "";
let server: ReturnType<typeof createServer>;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
let currentAgent: Agent | null = null;

async function startServer(app: express.Express) {
  originalDispatcher = getGlobalDispatcher();
  currentAgent = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 });
  setGlobalDispatcher(currentAgent);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function stopServer() {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setGlobalDispatcher(originalDispatcher);
  if (currentAgent) {
    try { await currentAgent.close(); } catch {}
    currentAgent = null;
  }
}

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const init: any = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const r = await fetch(`${baseUrl}${path}`, init);
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// ─── 2. Storage CRUD ───────────────────────────────────────────────────────────

await runInIsolatedSchema(
  async () => {
    const { getDb } = await import("../server/db.js");
    const db = getDb();
    const commsStorage = await import("../server/storage/commsStorage.js");
    const { sql } = await import("drizzle-orm");

    const userId = `status-storage-${RUN}`;
    await db.execute(
      sql`INSERT INTO users (id, email, role)
          VALUES (${userId}, ${`storage-${RUN}@example.com`}, 'account_manager')
          ON CONFLICT DO NOTHING`,
    );

    // No row → null
    const none = await commsStorage.getUserStatus(userId);
    assert.equal(none, null, "no row → null");

    // setUserManualStatus: away
    const away = await commsStorage.setUserManualStatus(userId, "away");
    assert.equal(away.manualStatus, "away", "manualStatus=away persisted");
    assert.equal(away.priorStatus, null, "away: no priorStatus");

    // setUserManualStatus: dnd captures priorStatus
    const dnd = await commsStorage.setUserManualStatus(userId, "dnd");
    assert.equal(dnd.manualStatus, "dnd", "manualStatus=dnd");
    assert.equal(dnd.priorStatus, "away", "priorStatus captured as away");

    // round-trip read
    const fetched = await commsStorage.getUserStatus(userId);
    assert.equal(fetched?.manualStatus, "dnd", "persisted dnd readable");

    // setUserCustomStatus: set
    const custom = await commsStorage.setUserCustomStatus(userId, {
      emoji: "🎯",
      text: "Deep work",
      expiresAt: null,
    });
    assert.equal(custom.customEmoji, "🎯", "custom emoji stored");
    assert.equal(custom.customText, "Deep work", "custom text stored");
    assert.ok(
      Array.isArray(custom.recentCustomStatuses) && custom.recentCustomStatuses.length === 1,
      "1 recent entry added",
    );

    // Same emoji+text → deduplicates
    const dup = await commsStorage.setUserCustomStatus(userId, { emoji: "🎯", text: "Deep work", expiresAt: null });
    assert.equal(dup.recentCustomStatuses?.length, 1, "duplicate not added twice");

    // setUserCustomStatus: clear (null)
    const cleared = await commsStorage.setUserCustomStatus(userId, null);
    assert.equal(cleared.customEmoji, null, "customEmoji cleared");
    assert.equal(cleared.customText, null, "customText cleared");
    assert.equal(cleared.recentCustomStatuses?.length, 1, "recents preserved on clear");

    // touchUserActivity
    await commsStorage.touchUserActivity(userId);
    const touched = await commsStorage.getUserStatus(userId);
    assert.ok(touched?.lastActivityAt instanceof Date, "lastActivityAt set after touch");

    // getUserStatusBulk
    const map = await commsStorage.getUserStatusBulk([userId, "ghost-user"]);
    assert.ok(map.has(userId), "bulk contains known user");
    assert.ok(!map.has("ghost-user"), "bulk skips unknown user");

    // resolveCustomStatusExpiry: not expired → row unchanged
    const futureRow = await commsStorage.setUserCustomStatus(userId, {
      emoji: "🕐",
      text: "In a meeting",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const notExpired = await commsStorage.resolveCustomStatusExpiry(userId, futureRow);
    assert.equal(notExpired.customEmoji, "🕐", "unexpired custom status unchanged");

    // resolveCustomStatusExpiry: past expiry → clears custom fields
    const pastRow = await commsStorage.setUserCustomStatus(userId, {
      emoji: "🍕",
      text: "Lunch",
      expiresAt: new Date(Date.now() - 1),
    });
    const expired = await commsStorage.resolveCustomStatusExpiry(userId, pastRow);
    assert.equal(expired.customEmoji, null, "expired custom emoji cleared");
    assert.equal(expired.customText, null, "expired custom text cleared");
    assert.equal(expired.customExpiresAt, null, "expired customExpiresAt cleared");

    console.log("ok  storage CRUD: 17 assertions passed");
  },
  { tables: ["comms_user_statuses", "users"] },
);

// ─── 3. Route smoke ────────────────────────────────────────────────────────────

await runInIsolatedSchema(
  async () => {
    const { getDb } = await import("../server/db.js");
    const db = getDb();
    const { sql } = await import("drizzle-orm");

    const userId = `status-route-${RUN}`;
    await db.execute(
      sql`INSERT INTO users (id, email, role)
          VALUES (${userId}, ${`route-${RUN}@example.com`}, 'account_manager')
          ON CONFLICT DO NOTHING`,
    );
    // Seeded in an isolated schema (uncommitted to public); pre-register so
    // requireAuth uses the profile directly instead of JIT-provisioning a
    // public row / firing the comms auto-join side effect.
    __test_markUserReconciled(userId, {
      id: userId,
      email: `route-${RUN}@example.com`,
      role: "account_manager",
    });

    const app = await buildTestApp(userId);
    await startServer(app);

    try {
      // GET /api/comms/status/me — no row → offline
      {
        const r = await req("GET", "/api/comms/status/me");
        assert.equal(r.status, 200, `GET status/me → 200 (got ${r.status})`);
        assert.equal(r.body.effectiveStatus, "offline", "no row → effectiveStatus=offline");
        assert.equal(r.body.userId, userId, "userId matches");
      }

      // PUT /api/comms/status/me — set away
      {
        const r = await req("PUT", "/api/comms/status/me", { status: "away" });
        assert.equal(r.status, 200, `PUT status/me → 200 (got ${r.status})`);
        assert.equal(r.body.effectiveStatus, "away", "effectiveStatus=away after set");
      }

      // GET reflects persisted status
      {
        const r = await req("GET", "/api/comms/status/me");
        assert.equal(r.body.manualStatus, "away", "GET reflects persisted away");
      }

      // PUT /api/comms/status/me/custom — set
      {
        const r = await req("PUT", "/api/comms/status/me/custom", {
          emoji: "🚀",
          text: "Shipping it",
          expiresAt: null,
        });
        assert.equal(r.status, 200, `PUT custom → 200 (got ${r.status})`);
        assert.equal(r.body.customEmoji, "🚀", "custom emoji saved");
        assert.equal(r.body.customText, "Shipping it", "custom text saved");
      }

      // PUT /api/comms/status/me/custom — clear via { clear: true }
      {
        const r = await req("PUT", "/api/comms/status/me/custom", { clear: true });
        assert.equal(r.status, 200, `PUT custom clear → 200 (got ${r.status})`);
        assert.equal(r.body.customEmoji, null, "custom emoji cleared");
      }

      // GET /api/comms/status/bulk
      {
        const r = await req("GET", `/api/comms/status/bulk?userIds=${userId},nonexistent`);
        assert.equal(r.status, 200, `GET bulk → 200 (got ${r.status})`);
        assert.ok(Array.isArray(r.body), "bulk returns array");
        const mine = r.body.find((e: any) => e.userId === userId);
        assert.ok(mine, "bulk contains own entry");
      }

      // PUT /api/comms/status/me with invalid status → 400
      {
        const r = await req("PUT", "/api/comms/status/me", { status: "invisible" });
        assert.equal(r.status, 400, `invalid status → 400 (got ${r.status})`);
      }

      console.log("ok  route smoke: 10 assertions passed");
    } finally {
      __test_resetReconciledUsers();
      await stopServer();
    }
  },
  { tables: ["comms_user_statuses", "users"], pinGetDbForCrossAsync: true },
);
