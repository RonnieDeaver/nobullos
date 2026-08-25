/* test-registration
{
  "name": "Book Operations Console role, bounds, and repair-command contract",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast DB-free HTTP coverage for the new team-lead-only oversight boundary: ordinary reads are bounded/private and use the injected cache-only health reader, repair commands validate idempotency and preserve actor attribution, and the route surface exposes no payment fabrication, entitlement grant, consent edit, or CRM edit command.",
  "tier": "small",
  "tierReason": "One in-process Express server, local dependency stubs, and source-shape assertions; no database writes, external network, workers, or child processes.",
  "scanPaths": [
    "server/routes/bookOperations.ts"
  ]
}
test-registration */

import "./helpers/forceTestEnv";
import assert from "node:assert/strict";
import fs from "node:fs";
import http, { type Server } from "node:http";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import * as undici from "undici";

import {
  registerBookOperationsRoutes,
  type BookOperationsRouteDeps,
} from "../server/routes/bookOperations";
import { closeDbPools } from "../server/db";
import {
  __resetIntegrationStatusCacheForTest,
  __rewindStoredAtMsForTest,
  getCachedIntegrationStatus,
  readCachedIntegrationStatusOnly,
} from "../server/services/integrationStatusCache";

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
  text: string;
}

const calls = {
  summary: 0,
  records: 0,
  detail: 0,
  exceptions: 0,
  health: 0,
  paymentRepairs: [] as Array<Record<string, string>>,
  outboxRepairs: [] as Array<Record<string, string>>,
};

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const role = req.header("x-test-role");
  if (!role) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as any).user = { claims: { sub: `actor-${role}`, role } };
  next();
}

function authorizeTeamLead(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const role = (req as any).user?.claims?.role;
  if (role !== "team_lead" && role !== "ceo") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

const deps: BookOperationsRouteDeps = {
  authenticate,
  authorizeTeamLead,
  getSummary: async ({ from, to }) => {
    calls.summary++;
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      funnel: [],
      marginInputs: { status: "unavailable", value: null },
    };
  },
  listRecords: async (input) => {
    calls.records++;
    assert.equal(input.limit, 25);
    assert.equal(input.offset, 0);
    return {
      items: [
        {
          id: "checkout-1",
          maskedContact: {
            email: "b***@example.com",
            name: "B***",
            phone: "***1234",
          },
        },
      ],
      total: 1,
      hasMore: false,
    };
  },
  getRecord: async (recordId) => {
    calls.detail++;
    return recordId === "checkout-1"
      ? {
          id: recordId,
          correlations: [
            {
              provider: "stripe",
              providerEntityType: "payment_intent",
              providerEntityId: "pi_support_reference",
            },
          ],
        }
      : null;
  },
  listExceptions: async () => {
    calls.exceptions++;
    return { items: [], total: 0, hasMore: false };
  },
  readHealth: async () => {
    calls.health++;
    return {
      source: "cache_only",
      providers: {
        stripe: { connected: null, lastCheckedAt: null },
        ghl: { connected: true, lastCheckedAt: "2026-08-21T12:00:00.000Z" },
      },
      launchReadiness: {
        evaluatedAt: "2026-08-21T12:00:00.000Z",
        environment: "test",
        policySnapshotSchemaVersion: "book-purchase-policy-snapshot-v1",
        policies: [],
        fulfillmentBoundary: {
          state: "inactive",
          provider: null,
          providerApproved: false,
          capabilities: {
            create: false,
            status: false,
            tracking: false,
            cancel: false,
            replacement: false,
          },
        },
        packages: {
          digital: {
            purchasable: false,
            blockers: [
              {
                code: "policy.terms_unapproved",
                state: "missing_approval",
                detail: "Terms approval is missing.",
              },
            ],
            policySnapshot: null,
          },
          complete: {
            purchasable: false,
            blockers: [
              {
                code: "fulfillment.provider_inactive",
                state: "inactive",
                detail: "No provider is active.",
              },
            ],
            policySnapshot: null,
          },
        },
      },
    };
  },
  retryPaymentEvent: async (input) => {
    calls.paymentRepairs.push(input);
    return {
      attempted: 1,
      processed: 1,
      needsReconciliation: 0,
      errors: [],
    };
  },
  replayOutbox: async (input) => {
    calls.outboxRepairs.push(input);
    return { replayed: false, idempotent: true, status: "pending" };
  },
};

async function listen(
  overrides: Partial<BookOperationsRouteDeps> = {},
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  registerBookOperationsRoutes(app, { ...deps, ...overrides });
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

async function request(
  baseUrl: string,
  path: string,
  options: { role?: string; method?: string; body?: unknown } = {},
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.role ? { "x-test-role": options.role } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Assertions below surface malformed responses with the original text.
  }
  return { status: response.status, headers: response.headers as any, json, text };
}

async function main(): Promise<void> {
  __resetIntegrationStatusCacheForTest();
  let loaderCalls = 0;
  const cacheName = "book-operations-no-probe-test";
  const cold = await readCachedIntegrationStatusOnly<{ connected: boolean }>(cacheName);
  assert.equal(cold.value, null);
  assert.equal(loaderCalls, 0, "cache-only cold read does not start a loader");
  await getCachedIntegrationStatus(
    cacheName,
    async () => {
      loaderCalls++;
      return { connected: true };
    },
    { freshTtlMs: 10 },
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    const snapshot =
      await readCachedIntegrationStatusOnly<{ connected: boolean }>(cacheName);
    if (snapshot.value) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(loaderCalls, 1);
  assert(__rewindStoredAtMsForTest(cacheName, 60_000));
  const stale =
    await readCachedIntegrationStatusOnly<{ connected: boolean }>(cacheName);
  assert.equal(stale.value?.connected, true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(loaderCalls, 1, "cache-only stale read does not start a loader");

  const { server, baseUrl } = await listen();
  try {
    const unauthenticated = await request(
      baseUrl,
      "/api/admin/book-operations/records",
    );
    assert.equal(unauthenticated.status, 401);

    const insufficient = await request(
      baseUrl,
      "/api/admin/book-operations/records",
      { role: "account_manager" },
    );
    assert.equal(insufficient.status, 403);

    const records = await request(
      baseUrl,
      "/api/admin/book-operations/records?limit=25&offset=0",
      { role: "team_lead" },
    );
    assert.equal(records.status, 200, records.text);
    assert.equal(records.headers.get?.("cache-control"), "private, no-store");
    assert.equal(records.json.items[0].maskedContact.email, "b***@example.com");
    assert(!records.text.includes("buyer@example.com"));

    const oversized = await request(
      baseUrl,
      "/api/admin/book-operations/records?limit=51",
      { role: "team_lead" },
    );
    assert.equal(oversized.status, 400);
    assert.equal(calls.records, 1, "invalid bounds never reach the read model");

    const longRange = await request(
      baseUrl,
      "/api/admin/book-operations/summary?from=2024-01-01&to=2026-01-03",
      { role: "team_lead" },
    );
    assert.equal(longRange.status, 400);
    assert.equal(calls.summary, 0);

    const health = await request(
      baseUrl,
      "/api/admin/book-operations/health",
      { role: "team_lead" },
    );
    assert.equal(health.status, 200);
    assert.equal(health.json.source, "cache_only");
    assert.equal(health.json.launchReadiness.packages.digital.purchasable, false);
    assert.equal(
      health.json.launchReadiness.packages.complete.blockers[0].code,
      "fulfillment.provider_inactive",
    );
    assert.equal(calls.health, 1);
    assert.equal(calls.paymentRepairs.length, 0);
    assert.equal(calls.outboxRepairs.length, 0);

    const missing = await request(
      baseUrl,
      "/api/admin/book-operations/records/missing",
      { role: "team_lead" },
    );
    assert.equal(missing.status, 404);

    const shortKey = await request(
      baseUrl,
      "/api/admin/book-operations/payment-events/event-1/retry",
      {
        role: "team_lead",
        method: "POST",
        body: { idempotencyKey: "short" },
      },
    );
    assert.equal(shortKey.status, 400);
    assert.equal(calls.paymentRepairs.length, 0);

    const paymentRepair = await request(
      baseUrl,
      "/api/admin/book-operations/payment-events/event-1/retry",
      {
        role: "team_lead",
        method: "POST",
        body: { idempotencyKey: "book-ops-retry-0001" },
      },
    );
    assert.equal(paymentRepair.status, 202, paymentRepair.text);
    assert.deepEqual(calls.paymentRepairs[0], {
      paymentEventId: "event-1",
      actorUserId: "actor-team_lead",
      idempotencyKey: "book-ops-retry-0001",
    });

    const pausedApp = await listen({
      retryPaymentEvent: undefined,
      isPaymentProcessingPaused: async () => true,
    });
    try {
      const pausedRepair = await request(
        pausedApp.baseUrl,
        "/api/admin/book-operations/payment-events/event-2/retry",
        {
          role: "team_lead",
          method: "POST",
          body: { idempotencyKey: "book-ops-retry-paused-0001" },
        },
      );
      assert.equal(pausedRepair.status, 409, pausedRepair.text);
      assert.match(pausedRepair.json.error, /processing is paused/i);
      assert.equal(
        calls.paymentRepairs.length,
        1,
        "paused processing never reaches the injected replay command",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        pausedApp.server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const outboxRepair = await request(
      baseUrl,
      "/api/admin/book-operations/outbox/outbox-1/replay",
      {
        role: "ceo",
        method: "POST",
        body: { idempotencyKey: "book-ops-outbox-0001" },
      },
    );
    assert.equal(outboxRepair.status, 202, outboxRepair.text);
    assert.equal(calls.outboxRepairs[0]?.actorUserId, "actor-ceo");

    const routeSource = fs.readFileSync(
      "server/routes/bookOperations.ts",
      "utf8",
    );
    const mutationPaths = Array.from(
      routeSource.matchAll(/app\.post\(\s*[\r\n]+\s*["']([^"']+)["']/g),
      (match) => match[1],
    );
    assert.deepEqual(mutationPaths.sort(), [
      "/api/admin/book-operations/outbox/:outboxId/replay",
      "/api/admin/book-operations/payment-events/:paymentEventId/retry",
    ]);
    for (const forbidden of [
      "mark-paid",
      "grant-entitlement",
      "sms-opt-in",
      "ghl-record-edit",
    ]) {
      assert(!routeSource.includes(forbidden), `forbidden command ${forbidden} absent`);
    }
  } finally {
    __resetIntegrationStatusCacheForTest();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await undici.getGlobalDispatcher().close();
    await closeDbPools();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});