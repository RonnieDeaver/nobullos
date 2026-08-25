/* test-registration
{
  "name": "Audit-history endpoint + client/product logging (Task #1953)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1953 — Coverage for the generic entity-audit history endpoint
 * (`GET /api/audit-history`) and the client/product activity logging in
 * `server/routes/clients.ts` that feeds it.
 *
 * The History popover (Task #1941) renders whatever this endpoint
 * returns, so a silent break in the logging shape (e.g. a refactor of
 * `insertActivityLogs`, a metadata-key rename, or a change to the
 * product bucket key) would quietly empty the popover with no test
 * failure. This pins:
 *
 *   1. Lifecycle — POST creates `client_created` (+ `product_added` per
 *      initial product); PATCH adds/removes products → `client_updated`
 *      plus the per-product diff; DELETE → `client_deleted`. For
 *      entity=client the events come back newest-first under `[clientId]`.
 *   2. Product diff bucketing — entity=product keys each bucket by
 *      `${clientId}:${product}` so the product-list popover can look up
 *      one product's timeline directly.
 *   3. Auth + validation — non-account-manager → 403; invalid entity →
 *      400; > 200 ids → 400.
 *
 * Follows the live-DB + real-express-server pattern of
 * `client-viewed-route-bumps.test.ts`: the route awaits
 * `insertActivityLogs` before responding, so no polling is needed —
 * the rows exist by the time the HTTP response returns.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerClientRoutes } from "../server/routes/clients";
import { registerActivityRoutes } from "../server/routes/activity";

const TAG = `task-1953-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CEO_ID = `${TAG}-ceo`;
const SALES_ID = `${TAG}-sales`;
const FIRM_NAME = `Task1953 Firm ${TAG}`;

let createdClientId: string | null = null;

let passed = 0;
let failed = 0;

function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

async function cleanup(): Promise<void> {
  // Activity logs reference the client only through metadata (no FK), so
  // they survive the client delete and must be cleaned up explicitly.
  if (createdClientId) {
    await db
      .execute(
        sql`DELETE FROM user_activity_logs WHERE metadata->>'clientId' = ${createdClientId}`,
      )
      .catch(() => 0);
    await db
      .execute(sql`DELETE FROM clients WHERE id = ${createdClientId}`)
      .catch(() => 0);
  }
  await db.execute(sql`DELETE FROM users WHERE id = ${CEO_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM users WHERE id = ${SALES_ID}`).catch(() => 0);
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name, last_name)
    VALUES (${CEO_ID}, 'ceo', 'Task1953', 'Ceo')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name, last_name)
    VALUES (${SALES_ID}, 'sales', 'Task1953', 'Sales')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

function buildApp(opts: { authAs?: string | null } = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that committed public-schema users row; null/undefined
    // is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = opts.authAs ?? null;
    next();
  });
  registerClientRoutes(app);
  registerActivityRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

type AuditEvent = {
  id: string;
  actionType: string;
  actorId: string | null;
  actorName: string | null;
  timestamp: string;
  actionDetail: string | null;
  metadata: Record<string, any> | null;
};

async function fetchAuditHistory(
  baseUrl: string,
  entity: string,
  ids: string,
): Promise<{ status: number; body: Record<string, AuditEvent[]> }> {
  const r = await fetch(
    `${baseUrl}/api/audit-history?entity=${encodeURIComponent(entity)}&ids=${encodeURIComponent(ids)}`,
  );
  const body = r.status === 200 ? await r.json() : {};
  return { status: r.status, body };
}

async function run(): Promise<void> {
  await cleanup();
  await seed();

  const ceoApp = buildApp({ authAs: CEO_ID });
  const { server: ceoServer, baseUrl: ceoBase } = await listen(ceoApp);

  try {
    // ── 1. Create a client with two initial products. ──────────────────
    {
      const r = await fetch(`${ceoBase}/api/clients`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firmName: FIRM_NAME,
          contactName: "Task1953 Contact",
          products: ["gbp", "lsa"],
        }),
      });
      ok(r.status === 201, `POST /api/clients → 201 (got ${r.status})`);
      const client = await r.json();
      createdClientId = client.id;
      ok(typeof createdClientId === "string" && createdClientId.length > 0, "created client has an id");
    }

    const cid = createdClientId!;

    // Audit-history (entity=client) should show the creation event.
    {
      const { status, body } = await fetchAuditHistory(ceoBase, "client", cid);
      ok(status === 200, `GET /api/audit-history?entity=client → 200 (got ${status})`);
      const events = body[cid] ?? [];
      ok(events.length >= 1, "client bucket has at least the creation event");
      ok(
        events.some((e) => e.actionType === "client_created"),
        "client_created event recorded on create",
      );
      ok(
        events.some(
          (e) => e.actionType === "client_created" && e.actorId === CEO_ID,
        ),
        "client_created event carries the acting CEO as actor",
      );
    }

    // Audit-history (entity=product) buckets keyed by `${clientId}:${product}`.
    {
      const { body } = await fetchAuditHistory(ceoBase, "product", cid);
      ok(
        Array.isArray(body[`${cid}:gbp`]) && body[`${cid}:gbp`].length === 1,
        "product bucket `<clientId>:gbp` has the initial product_added",
      );
      ok(
        Array.isArray(body[`${cid}:lsa`]) && body[`${cid}:lsa`].length === 1,
        "product bucket `<clientId>:lsa` has the initial product_added",
      );
      ok(
        body[`${cid}:gbp`]?.[0]?.actionType === "product_added",
        "initial gbp bucket event is product_added",
      );
    }

    // ── 2. PATCH: add google_ads, remove lsa (keep gbp). ───────────────
    {
      const r = await fetch(`${ceoBase}/api/clients/${cid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ products: ["gbp", "google_ads"] }),
      });
      ok(r.status === 200, `PATCH /api/clients/:id → 200 (got ${r.status})`);
    }

    // entity=product: gbp unchanged (still 1), google_ads added, lsa removed.
    {
      const { body } = await fetchAuditHistory(ceoBase, "product", cid);
      ok(
        body[`${cid}:gbp`]?.length === 1,
        "gbp bucket unchanged after PATCH (still 1 event, no churn)",
      );
      ok(
        body[`${cid}:google_ads`]?.length === 1 &&
          body[`${cid}:google_ads`][0].actionType === "product_added",
        "google_ads bucket records a product_added",
      );
      ok(
        body[`${cid}:lsa`]?.length === 2,
        "lsa bucket now has both the add and the remove",
      );
      ok(
        body[`${cid}:lsa`]?.[0]?.actionType === "product_removed",
        "newest lsa event is product_removed (newest-first ordering)",
      );
      ok(
        body[`${cid}:lsa`]?.[1]?.actionType === "product_added",
        "oldest lsa event is the original product_added",
      );
    }

    // entity=client: now has client_created + client_updated.
    {
      const { body } = await fetchAuditHistory(ceoBase, "client", cid);
      const events = body[cid] ?? [];
      ok(
        events.some((e) => e.actionType === "client_updated"),
        "client_updated event recorded on PATCH",
      );
      const updated = events.find((e) => e.actionType === "client_updated");
      ok(
        Array.isArray(updated?.metadata?.changedKeys) &&
          updated!.metadata!.changedKeys.includes("products"),
        "client_updated metadata.changedKeys includes 'products'",
      );
    }

    // ── 3. DELETE the client. ──────────────────────────────────────────
    {
      const r = await fetch(`${ceoBase}/api/clients/${cid}`, { method: "DELETE" });
      ok(r.status === 204, `DELETE /api/clients/:id → 204 (got ${r.status})`);
    }

    // entity=client: full lifecycle present, newest-first ordering.
    {
      const { body } = await fetchAuditHistory(ceoBase, "client", cid);
      const events = body[cid] ?? [];
      const types = events.map((e) => e.actionType);
      ok(types.includes("client_deleted"), "client_deleted event recorded on delete");
      ok(types.includes("client_updated"), "client_updated still present after delete");
      ok(types.includes("client_created"), "client_created still present after delete");
      ok(
        types[0] === "client_deleted",
        `newest client event is client_deleted (got ${types[0]})`,
      );
      ok(
        types[types.length - 1] === "client_created",
        `oldest client event is client_created (got ${types[types.length - 1]})`,
      );
    }

    // ── 4. Validation: invalid entity → 400; > 200 ids → 400. ──────────
    {
      const r = await fetch(`${ceoBase}/api/audit-history?entity=banana&ids=${cid}`);
      ok(r.status === 400, `invalid entity → 400 (got ${r.status})`);
    }
    {
      const r = await fetch(`${ceoBase}/api/audit-history?entity=client`);
      const body = await r.json();
      ok(
        r.status === 200 && Object.keys(body).length === 0,
        `missing ids → 200 with empty object (got ${r.status})`,
      );
    }
    {
      const tooMany = Array.from({ length: 201 }, (_, i) => `id-${i}`).join(",");
      const r = await fetch(
        `${ceoBase}/api/audit-history?entity=client&ids=${encodeURIComponent(tooMany)}`,
      );
      ok(r.status === 400, `> 200 ids → 400 (got ${r.status})`);
    }
  } finally {
    await closeServer(ceoServer);
  }

  // ── 5. Auth: non-account-manager (sales) → 403. ──────────────────────
  const salesApp = buildApp({ authAs: SALES_ID });
  const { server: salesServer, baseUrl: salesBase } = await listen(salesApp);
  try {
    const r = await fetch(
      `${salesBase}/api/audit-history?entity=client&ids=${createdClientId ?? "x"}`,
    );
    ok(r.status === 403, `non-account-manager → 403 (got ${r.status})`);
  } finally {
    await closeServer(salesServer);
  }

  // Unauthenticated → 401 (requireAuth gate).
  const anonApp = buildApp({ authAs: null });
  const { server: anonServer, baseUrl: anonBase } = await listen(anonApp);
  try {
    const r = await fetch(`${anonBase}/api/audit-history?entity=client&ids=x`);
    ok(r.status === 401, `unauthenticated → 401 (got ${r.status})`);
  } finally {
    await closeServer(anonServer);
  }

  await cleanup();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  async (err) => {
    console.error("Test threw:", err);
    await cleanup().catch(() => 0);
    process.exitCode = 1;
  },
);
