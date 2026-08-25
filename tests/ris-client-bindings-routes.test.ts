/* test-registration
{
  "name": "RIS per-client BigQuery binding routes (Task #2491)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2491 — HTTP-level coverage for the per-client BigQuery setup screen.
 *
 * Task #2485 added four manager-gated RIS endpoints behind `canManageRIS`:
 *
 *   GET    /api/ris/client-bindings/:clientId
 *   PUT    /api/ris/client-bindings/:clientId/bigquery-key
 *   PUT    /api/ris/client-bindings/:clientId/overrides/:autoSource
 *   DELETE /api/ris/client-bindings/:clientId/overrides/:autoSource
 *
 * `tests/ris-auto-pull-safety.test.ts` Section C already covers the resolver
 * + missing-key degrade at the SERVICE level, but nothing drives the route
 * handlers over the network. This suite boots the real RIS routes and:
 *
 *   (A) As a manager, walks the full setup round-trip: read the empty
 *       binding, set then clear the client's BigQuery key, and upsert → list
 *       → delete an override (reverting it to the global mapping), asserting
 *       the delete is idempotent.
 *   (B) As a non-manager, hits all four endpoints and asserts each is
 *       rejected by the permission gate (403).
 *   (C) As a manager, drives the error/edge branches the happy path skips:
 *       an unknown client id returns 404 on GET binding / PUT bigquery-key /
 *       PUT override, and a malformed body (wrong type for `bigQueryClientKey`,
 *       out-of-enum `comparator`) returns 400 with the Zod `details`.
 *
 * Everything runs inside `runInIsolatedSchema(..., { pinGetDbForCrossAsync })`
 * so the Express handlers — which run OUTSIDE this sandbox's ALS scope —
 * still read the cloned `users` / `clients` / override tables rather than
 * racing the live `Start application` workers on `public`. Permissive mode
 * defaults ON (so a config blip can't lock everyone out), which would make
 * `canManageRIS` return true for ANY authenticated user and silently void
 * the non-manager rejection assertions; we pin it OFF in the cloned
 * `system_settings` and reset the in-memory cache so the authority gate is
 * actually exercised.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { registerRisRoutes } from "../server/routes/ris";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { setSystemSetting } from "../server/storage/settingsStorage";
import { __resetPermissiveModeCacheForTests } from "../server/auth/permissions";
import { clients } from "@shared/schema";
import { runInIsolatedSchema } from "./db-sandbox";

const MANAGER_ID = "test-2491-manager";
const NONMANAGER_ID = "test-2491-core";
const PERMISSIVE_KEY = "role_permissions_permissive_mode";
const AUTO_SOURCE = "as_2491_demo";

const TABLES = [
  "users",
  "clients",
  "ris_client_auto_source_overrides",
  "system_settings",
] as const;

// The middleware reads this closure variable so each request can present a
// different actor without re-registering routes.
let activeUserId: string = MANAGER_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerRisRoutes(app);
  return app;
}

async function listen(
  app: express.Express,
): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

interface Resp {
  status: number;
  body: any;
}

async function call(
  baseUrl: string,
  method: string,
  p: string,
  body?: unknown,
): Promise<Resp> {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // Permissive mode defaults ON; pin it OFF so the authority gate runs.
      await setSystemSetting(PERMISSIVE_KEY, "false", "test");
      __resetPermissiveModeCacheForTests();

      // A manager (authority `lead`) and a non-manager (authority `core`).
      // The LIKE clone drops the FK to public.users, so these cloned rows
      // satisfy `storage.getUser(...)` inside the isolated schema.
      await db.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES (${MANAGER_ID}, 'team_lead', 'lead', 'Manager 2491')
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);
      await db.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES (${NONMANAGER_ID}, 'account_manager', 'core', 'Core 2491')
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);

      // Both users are seeded in the isolated (uncommitted) schema, invisible
      // to requireAuth's ambient public-schema lookup. Pre-register their
      // profiles so the real middleware admits each acting identity without
      // JIT-provisioning a public row (which would grant a surprise role).
      __test_markUserReconciled(MANAGER_ID, {
        id: MANAGER_ID,
        role: "team_lead",
        authorityLevel: "lead",
        firstName: "Manager 2491",
      });
      __test_markUserReconciled(NONMANAGER_ID, {
        id: NONMANAGER_ID,
        role: "account_manager",
        authorityLevel: "core",
        firstName: "Core 2491",
      });

      const [client] = await db
        .insert(
          // Use a raw insert so we don't depend on the full insert schema.
          (await import("@shared/schema")).clients,
        )
        .values({
          firmName: "Setup Screen Firm",
          products: ["gbp"],
          isArchived: false,
          isDemo: false,
        })
        .returning();

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      const bindingPath = `/api/ris/client-bindings/${client.id}`;
      const overridePath = `${bindingPath}/overrides/${AUTO_SOURCE}`;

      try {
        // ── (A) Manager round-trip ──────────────────────────────────────
        activeUserId = MANAGER_ID;

        // (A1) Initial binding: no key, no overrides.
        const initial = await call(baseUrl, "GET", bindingPath);
        assert.equal(initial.status, 200, "manager GET binding → 200");
        assert.equal(initial.body.clientId, client.id, "binding clientId echoed");
        assert.equal(
          initial.body.firmName,
          "Setup Screen Firm",
          "binding firmName echoed",
        );
        assert.equal(
          initial.body.bigQueryClientKey,
          null,
          "fresh client has no BigQuery key",
        );
        assert.deepEqual(
          initial.body.overrides,
          [],
          "fresh client has no overrides",
        );

        // (A2) Set the BigQuery client key, then read it back.
        const setKey = await call(baseUrl, "PUT", `${bindingPath}/bigquery-key`, {
          bigQueryClientKey: "bq-key-2491",
        });
        assert.equal(setKey.status, 200, "manager PUT bigquery-key → 200");
        assert.equal(
          setKey.body.bigQueryClientKey,
          "bq-key-2491",
          "set key is returned",
        );
        const afterSet = await call(baseUrl, "GET", bindingPath);
        assert.equal(
          afterSet.body.bigQueryClientKey,
          "bq-key-2491",
          "GET reflects the persisted key",
        );

        // (A3) Whitespace-only input clears the key back to NULL.
        const clearKey = await call(
          baseUrl,
          "PUT",
          `${bindingPath}/bigquery-key`,
          { bigQueryClientKey: "   " },
        );
        assert.equal(clearKey.status, 200, "manager clear bigquery-key → 200");
        assert.equal(
          clearKey.body.bigQueryClientKey,
          null,
          "whitespace clears key to null",
        );
        const afterClear = await call(baseUrl, "GET", bindingPath);
        assert.equal(
          afterClear.body.bigQueryClientKey,
          null,
          "GET reflects the cleared key",
        );

        // (A4) Upsert an override, then confirm it lists.
        const upsert = await call(baseUrl, "PUT", overridePath, {
          comparator: "gte",
          threshold: "3",
          filterValue: "region-west",
        });
        assert.equal(upsert.status, 200, "manager PUT override → 200");
        assert.equal(upsert.body.clientId, client.id, "override bound to client");
        assert.equal(
          upsert.body.autoSource,
          AUTO_SOURCE,
          "override bound to the autoSource",
        );
        assert.equal(upsert.body.comparator, "gte", "override comparator saved");
        assert.equal(upsert.body.threshold, "3", "override threshold saved");
        assert.equal(
          upsert.body.filterValue,
          "region-west",
          "override filterValue saved",
        );
        const afterUpsert = await call(baseUrl, "GET", bindingPath);
        assert.equal(
          afterUpsert.body.overrides.length,
          1,
          "binding lists the new override",
        );
        assert.equal(
          afterUpsert.body.overrides[0].autoSource,
          AUTO_SOURCE,
          "listed override is the one we upserted",
        );

        // (A5) Delete the override → 204, and it reverts to the global mapping.
        const del = await call(baseUrl, "DELETE", overridePath);
        assert.equal(del.status, 204, "manager DELETE override → 204");
        const afterDelete = await call(baseUrl, "GET", bindingPath);
        assert.deepEqual(
          afterDelete.body.overrides,
          [],
          "override removed (reverted to global)",
        );

        // (A6) Deleting again is idempotent.
        const delAgain = await call(baseUrl, "DELETE", overridePath);
        assert.equal(delAgain.status, 204, "idempotent DELETE override → 204");

        console.log("ris-client-bindings-routes: manager round-trip passed");

        // ── (B) Non-manager is rejected on every endpoint ───────────────
        activeUserId = NONMANAGER_ID;

        const getForbidden = await call(baseUrl, "GET", bindingPath);
        assert.equal(getForbidden.status, 403, "non-manager GET binding → 403");

        const keyForbidden = await call(
          baseUrl,
          "PUT",
          `${bindingPath}/bigquery-key`,
          { bigQueryClientKey: "should-not-apply" },
        );
        assert.equal(
          keyForbidden.status,
          403,
          "non-manager PUT bigquery-key → 403",
        );

        const overrideForbidden = await call(baseUrl, "PUT", overridePath, {
          comparator: "gte",
          threshold: "3",
        });
        assert.equal(
          overrideForbidden.status,
          403,
          "non-manager PUT override → 403",
        );

        const deleteForbidden = await call(baseUrl, "DELETE", overridePath);
        assert.equal(
          deleteForbidden.status,
          403,
          "non-manager DELETE override → 403",
        );

        // The rejected writes left no trace: the key is still null and there
        // are still no overrides (verified back as the manager).
        activeUserId = MANAGER_ID;
        const finalState = await call(baseUrl, "GET", bindingPath);
        assert.equal(
          finalState.body.bigQueryClientKey,
          null,
          "rejected key write did not persist",
        );
        assert.deepEqual(
          finalState.body.overrides,
          [],
          "rejected override write did not persist",
        );

        console.log("ris-client-bindings-routes: non-manager rejection passed");

        // ── (C) Manager error/edge paths ───────────────────────────────
        activeUserId = MANAGER_ID;

        // A syntactically-valid UUID that no client row uses.
        const MISSING_ID = "00000000-0000-0000-0000-000000000000";
        const missingBinding = `/api/ris/client-bindings/${MISSING_ID}`;
        const missingOverride = `${missingBinding}/overrides/${AUTO_SOURCE}`;

        // (C1) Unknown client id → 404 on every read/write that resolves it.
        const getMissing = await call(baseUrl, "GET", missingBinding);
        assert.equal(
          getMissing.status,
          404,
          "GET binding for unknown client → 404",
        );

        // A VALID body so the 404 comes from the missing client, not the body.
        const keyMissing = await call(
          baseUrl,
          "PUT",
          `${missingBinding}/bigquery-key`,
          { bigQueryClientKey: "bq-key-orphan" },
        );
        assert.equal(
          keyMissing.status,
          404,
          "PUT bigquery-key for unknown client → 404",
        );

        const overrideMissing = await call(baseUrl, "PUT", missingOverride, {
          comparator: "gte",
          threshold: "3",
        });
        assert.equal(
          overrideMissing.status,
          404,
          "PUT override for unknown client → 404",
        );

        // (C2) Malformed body → 400 with the Zod validation details. These
        // hit the EXISTING client so the failure is the body, not the id.
        const badKeyType = await call(
          baseUrl,
          "PUT",
          `${bindingPath}/bigquery-key`,
          { bigQueryClientKey: 123 },
        );
        assert.equal(
          badKeyType.status,
          400,
          "PUT bigquery-key with non-string key → 400",
        );
        assert.equal(
          badKeyType.body.error,
          "Invalid key",
          "400 surfaces the invalid-key error",
        );
        assert.ok(
          badKeyType.body.details?.fieldErrors?.bigQueryClientKey?.length,
          "400 includes the bigQueryClientKey validation details",
        );

        const badComparator = await call(baseUrl, "PUT", overridePath, {
          comparator: "between",
          threshold: "3",
        });
        assert.equal(
          badComparator.status,
          400,
          "PUT override with out-of-enum comparator → 400",
        );
        assert.equal(
          badComparator.body.error,
          "Invalid override",
          "400 surfaces the invalid-override error",
        );
        assert.ok(
          badComparator.body.details?.fieldErrors?.comparator?.length,
          "400 includes the comparator validation details",
        );

        // The rejected writes left the real client's binding untouched.
        const afterErrors = await call(baseUrl, "GET", bindingPath);
        assert.equal(
          afterErrors.body.bigQueryClientKey,
          null,
          "malformed key write did not persist",
        );
        assert.deepEqual(
          afterErrors.body.overrides,
          [],
          "malformed override write did not persist",
        );

        console.log("ris-client-bindings-routes: manager error paths passed");
      } finally {
        server.close();
      }
    },
    { tables: TABLES, pinGetDbForCrossAsync: true },
  ).finally(() => {
    __test_resetReconciledUsers();
  });

  console.log("ris-client-bindings-routes: all sections passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("ris-client-bindings-routes: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
