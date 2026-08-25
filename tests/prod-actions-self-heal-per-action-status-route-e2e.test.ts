/* test-registration
{
  "name": "Prod-actions self-heal per-action status route body e2e (Task #2241)",
  "regression": true,
  "sweepOnlyReason": "Owner-approved 2026-08 blocking-portfolio audit: this isolated-schema Express route E2E uniquely proves each action's durable self-heal readout survives GET /api/admin/prod-actions serialization, but repeated forced focused runs took about 48s. It remains in the full/post-merge/nightly regression lanes and the existing blast-radius expansion re-adds it to the blocking run whenever its imported prod-actions route or service closure changes.",
  "tier": "medium"
}
test-registration */
/**
 * Task #2241 — Confirm each auto-fix's per-action self-heal status reaches
 * the admin panel over the network.
 *
 * Task #2205 (`tests/prod-actions-self-heal-status-route-e2e.test.ts`)
 * already asserts that the *tick-level* self-heal summary
 * (`selfHealEnabled` + `selfHealLastRun`) survives the round-trip into the
 * `GET /api/admin/prod-actions` JSON body. But the panel ALSO renders a
 * per-action durable readout — the `selfHeal` field on each action row
 * (lastRunAt, lastOutcome, lastRowsAffected, nextEligibleAt,
 * consecutiveFailures, failureAlertSent, reconnectAlertSent), built from
 * the persisted last-run `schedule` map by
 * `getProdActionSelfHealReadout()` and threaded onto each row in
 * `getProdActionStatuses()`. Nothing asserts that per-row `selfHeal`
 * object actually appears in the HTTP response body. A serializer or
 * handler regression could blank the per-action timeline while the tick
 * summary still renders, and no existing test would catch it.
 *
 * This test boots the prod-actions Express route (as in
 * `tests/prod-actions-self-heal-status-route-e2e.test.ts`), seeds a
 * persisted last-run summary whose `schedule` map carries a known entry
 * for a REAL eligible action id (`cancel_stale_front_backlog`, which opts
 * into self-heal via `ProdAction.selfHeal`), performs an authenticated
 * CEO GET against `/api/admin/prod-actions`, finds the matching row in the
 * parsed `actions` array, and asserts its `selfHeal` object carries the
 * seeded lastRunAt / lastOutcome / lastRowsAffected (plus the rest of the
 * durable trio).
 *
 * Everything runs inside `runInIsolatedSchema(...)` so the seeded master
 * switch (`prod_action_self_heal_enabled`) and last-run summary are
 * invisible to the live `Start application` workers — flipping the real
 * master switch on the shared `public` schema would actually arm the
 * auto-healer against live state.
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
  type SelfHealScheduleEntry,
} from "../server/services/prodActionSelfHeal";
import { runInIsolatedSchema } from "./db-sandbox";

const CEO_ID = "test-2241-ceo";
const TAG = "task-2241";
const RAN_AT = "2026-06-02T09:30:00.000Z";

// A real self-heal-eligible action id (opts in via `ProdAction.selfHeal`
// in the registry). Using a real id is the whole point: the per-row
// `selfHeal` field is only populated for rows whose action id appears in
// both `PROD_ACTIONS` (selfHealEligible) and the persisted `schedule` map.
const ELIGIBLE_ACTION_ID = "cancel_stale_front_backlog";

// The per-action durable trio the panel renders for each eligible row.
const SEEDED_ENTRY: SelfHealScheduleEntry = {
  nextEligibleAt: "2026-06-02T10:00:00.000Z",
  lastOutcome: "applied",
  lastRunAt: RAN_AT,
  lastRowsAffected: 7,
  consecutiveFailures: 0,
  lastErrorDetail: null,
  failureAlertSent: false,
  reconnectAlertSent: false,
};

// A persisted tick summary in the exact shape `persistLastRun()` writes,
// carrying the per-action `schedule` entry the readout derives the per-row
// `selfHeal` field from.
const SEEDED_TICK: ProdActionSelfHealTickResult = {
  ranAt: RAN_AT,
  enabled: true,
  paused: false,
  maxPerTick: 2,
  eligibleActionIds: [ELIGIBLE_ACTION_ID],
  dueActionIds: [ELIGIBLE_ACTION_ID],
  attempted: [],
  applied: 1,
  notNeeded: 0,
  errors: 0,
  blocked: 0,
  failureAlertsSent: [],
  reconnectAlertsSent: [],
  schedule: {
    [ELIGIBLE_ACTION_ID]: SEEDED_ENTRY,
  },
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
      // (with its per-action `schedule` entry) through the real
      // persistence path. Inside the isolated schema these land in the
      // cloned `system_settings` table.
      await setSystemSetting(SETTING_ENABLED, "true");
      await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(SEEDED_TICK));

      const app = buildCeoApp();
      const { server, baseUrl } = await listen(app);
      try {
        const r = await get(baseUrl, "/api/admin/prod-actions");
        assert.equal(r.status, 200, "GET /api/admin/prod-actions as CEO → 200");

        // The route returns every action row under `actions`. Find the
        // row for our real eligible action id.
        assert.ok(
          Array.isArray(r.body?.actions),
          "response body must carry an `actions` array",
        );
        const row = (r.body.actions as any[]).find(
          (a) => a?.id === ELIGIBLE_ACTION_ID,
        );
        assert.ok(
          row,
          `response body actions[] must contain the ${ELIGIBLE_ACTION_ID} row`,
        );

        // (1) The row is flagged self-heal-eligible (it opts in via
        //     `ProdAction.selfHeal` in the registry).
        assert.equal(
          row.selfHealEligible,
          true,
          `${ELIGIBLE_ACTION_ID} must be selfHealEligible`,
        );

        // (2) The per-action durable readout survives the round-trip into
        //     the HTTP body — not just the tick summary. This is the field
        //     the panel renders per row, and the regression this test
        //     guards: a serializer/handler change could blank it while
        //     `selfHealLastRun` still renders.
        assert.ok(
          row.selfHeal,
          `${ELIGIBLE_ACTION_ID} row must carry a populated selfHeal object, not null`,
        );
        const sh = row.selfHeal;

        // (3) Field-by-field: the seeded durable trio is copied through
        //     verbatim into the per-row body.
        assert.equal(
          sh.lastRunAt,
          SEEDED_ENTRY.lastRunAt,
          "selfHeal.lastRunAt copied verbatim into the row body",
        );
        assert.equal(
          sh.lastOutcome,
          SEEDED_ENTRY.lastOutcome,
          "selfHeal.lastOutcome copied verbatim into the row body",
        );
        assert.equal(
          sh.lastRowsAffected,
          SEEDED_ENTRY.lastRowsAffected,
          "selfHeal.lastRowsAffected copied verbatim into the row body",
        );
        assert.equal(
          sh.nextEligibleAt,
          SEEDED_ENTRY.nextEligibleAt,
          "selfHeal.nextEligibleAt copied verbatim into the row body",
        );
        assert.equal(
          sh.consecutiveFailures,
          SEEDED_ENTRY.consecutiveFailures,
          "selfHeal.consecutiveFailures present in the row body",
        );

        console.log(
          "  ok  GET /api/admin/prod-actions body carries the per-action selfHeal readout",
        );
      } finally {
        server.close();
      }
    },
    {
      // The GET handler runs `getProdActionStatuses()`, which reads the
      // seeded settings, runs each action's `status()` (best-effort;
      // uncloned tables surface as `error`/`blocked` rows we do not assert
      // on — we only assert on the seeded per-row `selfHeal` field), and
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
    console.log("prod-actions-self-heal-per-action-status-route-e2e: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error(
      "prod-actions-self-heal-per-action-status-route-e2e: FAILED —",
      err?.stack ?? err,
    );
    process.exit(1);
  },
);
