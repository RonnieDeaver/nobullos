/* test-registration
{
  "name": "Prod-actions self-heal status route body e2e (Task #2205)",
  "regression": true,
  "sweepOnlyReason": "Owner-approved 2026-08 blocking-portfolio audit: this isolated-schema Express route E2E uniquely proves the persisted tick summary survives GET /api/admin/prod-actions serialization, but repeated forced focused runs took about 48s. It remains in the full/post-merge/nightly regression lanes and the existing blast-radius expansion re-adds it to the blocking run whenever its imported prod-actions route or service closure changes.",
  "tier": "medium"
}
test-registration */
/**
 * Task #2205 — Confirm the auto-healer summary actually reaches the admin
 * panel over the network.
 *
 * Task #2126 (`tests/prod-actions-self-heal-status-readout.test.ts`)
 * asserts that the *service* function `getProdActionStatuses()` threads
 * `selfHealEnabled` and `selfHealLastRun` through. That covers the
 * data-assembly layer but NOT the actual HTTP response body of
 * `GET /api/admin/prod-actions` — the JSON the CEO panel fetches. If the
 * route handler ever stopped spreading those fields into its payload (or a
 * serializer dropped them), the service test would still pass while the
 * panel silently blanks.
 *
 * This test boots the prod-actions Express route (as in
 * `tests/prod-actions-routes.test.ts`), seeds a persisted self-heal
 * last-run summary (master switch ON + `prod_action_self_heal_last_run`),
 * performs an authenticated CEO GET against `/api/admin/prod-actions`, and
 * asserts the parsed JSON body contains `selfHealEnabled === true` and a
 * `selfHealLastRun` object with the expected `ranAt` + applied / not-needed
 * / error counts (plus the eligible/due counts derived from the seeded
 * arrays).
 *
 * Everything runs inside `runInIsolatedSchema(...)` so the seeded master
 * switch (`prod_action_self_heal_enabled`) is invisible to the live
 * `Start application` workers — flipping the real master switch on the
 * shared `public` schema would actually arm the auto-healer against live
 * state.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { registerProdActionsRoutes } from "../server/routes/prodActions";
import { setSystemSetting } from "../server/storage/settingsStorage";
import {
  SETTING_ENABLED,
  SETTING_LAST_RUN,
  type ProdActionSelfHealTickResult,
} from "../server/services/prodActionSelfHeal";
import { runInIsolatedSchema } from "./db-sandbox";

const CEO_ID = "test-2205-ceo";
const TAG = "task-2205";
const RAN_AT = "2026-06-01T12:00:00.000Z";

// A persisted tick summary in the exact shape `persistLastRun()` writes (a
// `ProdActionSelfHealTickResult` serialized as JSON). The readout derives
// `eligibleCount` / `dueCount` from the array lengths and copies the
// applied / not-needed / errors counts straight through to the route body.
const SEEDED_TICK: ProdActionSelfHealTickResult = {
  ranAt: RAN_AT,
  enabled: true,
  paused: false,
  maxPerTick: 3,
  eligibleActionIds: ["alpha", "bravo", "charlie", "delta"],
  dueActionIds: ["alpha", "bravo"],
  attempted: [],
  applied: 2,
  notNeeded: 1,
  errors: 1,
  blocked: 0,
  failureAlertsSent: [],
  schedule: {},
};

function buildCeoApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = CEO_ID;
    next();
  });
  registerProdActionsRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function get(baseUrl: string, p: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${p}`);
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      // Seed the CEO user inside the isolated schema. FK constraints to
      // `public.users` are NOT carried over by
      // `CREATE TABLE … (LIKE … INCLUDING ALL)`, so the `requireCeo` gate's
      // `storage.getUser(...)` resolves against this cloned `users` row.
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES (${CEO_ID}, 'ceo', 'ceo', ${`${TAG}-CEO`})
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);
      // Seeded in the isolated (uncommitted) schema, invisible to requireAuth's
      // ambient public-schema lookup. Pre-register so the real middleware admits
      // the CEO without JIT-provisioning a public row (surprise default role).
      __test_markUserReconciled(CEO_ID, {
        id: CEO_ID,
        role: "ceo",
        authorityLevel: "ceo",
        firstName: `${TAG}-CEO`,
      });

      // Seed the master switch ON and the persisted last-run summary
      // through the real persistence path (the same `setSystemSetting`
      // calls the enable toggle / `persistLastRun()` use). Inside the
      // isolated schema these land in the cloned `system_settings` table.
      await setSystemSetting(SETTING_ENABLED, "true");
      await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(SEEDED_TICK));

      const app = buildCeoApp();
      const { server, baseUrl } = await listen(app);
      try {
        const r = await get(baseUrl, "/api/admin/prod-actions");
        assert.equal(r.status, 200, "GET /api/admin/prod-actions as CEO → 200");

        // (1) The master-switch state survives the round-trip into the
        //     HTTP body, not just the service return value.
        assert.equal(
          r.body?.selfHealEnabled,
          true,
          "response body selfHealEnabled must be true",
        );

        // (2) The tick summary is present in the parsed JSON body — the
        //     field the panel renders.
        assert.ok(
          r.body?.selfHealLastRun,
          "response body selfHealLastRun must be present, not null/undefined",
        );
        const lastRun = r.body.selfHealLastRun;

        // (3) Field-by-field: ranAt verbatim, counts copied through, and
        //     eligible/due counts derived from the seeded array lengths.
        assert.equal(lastRun.ranAt, RAN_AT, "ranAt copied verbatim into body");
        assert.equal(
          lastRun.eligibleCount,
          SEEDED_TICK.eligibleActionIds.length,
          "eligibleCount derived from eligibleActionIds length",
        );
        assert.equal(
          lastRun.dueCount,
          SEEDED_TICK.dueActionIds.length,
          "dueCount derived from dueActionIds length",
        );
        assert.equal(lastRun.applied, SEEDED_TICK.applied, "applied count in body");
        assert.equal(
          lastRun.notNeeded,
          SEEDED_TICK.notNeeded,
          "notNeeded count in body",
        );
        assert.equal(lastRun.errors, SEEDED_TICK.errors, "errors count in body");

        console.log(
          "  ok  GET /api/admin/prod-actions body carries selfHealEnabled + selfHealLastRun",
        );
      } finally {
        server.close();
      }
    },
    {
      // The GET handler runs `getProdActionStatuses()`, which reads the
      // seeded settings, runs each action's `status()` (best-effort;
      // uncloned tables surface as `error` rows we do not assert on), and
      // reads recent runs for completed actions. Clone the tables those
      // paths touch directly so they resolve inside the isolated schema
      // rather than racing the live `public` workers.
      tables: ["system_settings", "prod_action_runs", "work_queue", "users"],
    },
  ).finally(() => {
    __test_resetReconciledUsers();
  });
}

main().then(
  () => {
    console.log("prod-actions-self-heal-status-route-e2e: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error(
      "prod-actions-self-heal-status-route-e2e: FAILED —",
      err?.stack ?? err,
    );
    process.exit(1);
  },
);
