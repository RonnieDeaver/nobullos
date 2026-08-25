/* test-registration
{
  "name": "Service Desk sync-client-options route — exact/normalized/AI tiers, carry-over, accept persistence, 403/401 gates",
  "regression": true,
  "smoke": true,
  "smokeReason": "sync-client-options + accept-client-suggestions: exact/normalized/AI tiers, carry-over, accept persistence, 403/401 gates. Stubs: ClickUp + OpenAI via resolve-hook loader (sd-sync-client-options-loader.mjs).",
  "extraNodeArgs": [
    "--import",
    "./tests/sd-sync-client-options-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Route-level test for POST /api/service-desk/setup/sync-client-options
 * and POST /api/service-desk/setup/accept-client-suggestions.
 *
 * Covers:
 *   (A) Tier-1a exact match — options whose name matches a NoBull firm name exactly
 *       are auto-mapped and persisted immediately.
 *   (B) Tier-1b normalized match — options like "Ackah Law NoBull3571, PC" match
 *       "Ackah Law NoBull3571" after legal-suffix stripping.
 *   (C) Carry-over — existing clientOptionIds entries are never overwritten.
 *   (D) AI-failure degradation — when OpenAI throws, sync still succeeds with
 *       suggestionsNote set and an empty suggestions array.
 *   (E) Accept-suggestion persistence — POST accept-client-suggestions writes
 *       accepted pairs to the DB map without overwriting existing entries;
 *       the endpoint skips already-mapped options silently.
 *   (F) Non-CEO user → 403; unauthenticated → 401 (both endpoints).
 *
 * Client IDs and firm names use a long unique suffix so inserts into the real
 * public.clients table (clients is not auto-cloned) don't collide with real data.
 * A finally block removes the test client rows.
 *
 * Uses pinGetDbForCrossAsync so Express handlers outside the sandbox ALS scope
 * read the cloned tables.
 * ClickUp API calls are stubbed via sd-sync-client-options-loader.mjs.
 * OpenAI is stubbed via sd-sync-client-options-openai-stub.mjs.
 *
 * Registered in run-all.ts with:
 *   extraNodeArgs: ["--import", "./tests/sd-sync-client-options-setup.mjs"]
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

import { registerServiceDeskRoutes } from "../server/routes/serviceDesk";
import { sdListMapping, clients } from "@shared/schema";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

// ── Constants ─────────────────────────────────────────────────────────────────

const CEO_ID = "test-3571-ceo";
const AM_ID = "test-3571-am";
const LIST_ID = "list-3571";
const CLIENT_FIELD_ID = "cf-client-3571";

// ── NoBull client IDs ─────────────────────────────────────────────────────────
// These IDs use a long unique suffix to avoid colliding with any real dev-DB
// client. Because `clients` falls through to public.* (not auto-cloned by
// runInIsolatedSchema), the inserts land in the real dev DB and must be
// cleaned up in the `finally` block.

const CLIENT_EXACT_ID = "client-exact-3571x9k";    // firmName = "Apex Legal NoBull3571"
const CLIENT_SUFFIX_ID = "client-suffix-3571x9k";  // firmName = "Ackah Law NoBull3571"
// OPT_UNMATCHED has no NoBull counterpart → goes to AI tier
const CLIENT_AI_ID = "client-ai-3571x9k";          // firmName = "Jordan Partners Ltd NoBull3571" (AI-matched)
const CLIENT_EXISTING_ID = "client-existing-3571x9k"; // firmName = "Old Firm NoBull3571" (already mapped)

// ── ClickUp option IDs ────────────────────────────────────────────────────────

const OPT_EXACT = "opt-exact-3571";     // name = "Apex Legal NoBull3571"        → exact → CLIENT_EXACT_ID
const OPT_SUFFIX = "opt-suffix-3571";   // name = "Ackah Law NoBull3571, PC"     → normalized → CLIENT_SUFFIX_ID
const OPT_AI = "opt-ai-3571";           // name = "Jordan 3571 Advisory" → no Tier-1 match → AI matches CLIENT_AI_ID
const OPT_EXISTING = "opt-existing-3571"; // already mapped to CLIENT_EXISTING_ID

// ── App factory ───────────────────────────────────────────────────────────────

let activeUserId: string | null = CEO_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerServiceDeskRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function postSync(baseUrl: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/service-desk/setup/sync-client-options`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function postAccept(
  baseUrl: string,
  pairs: Array<{ optionId: string; clientId: string }>,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/service-desk/setup/accept-client-suggestions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairs }),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// Shared ClickUp fields stub — includes the client dropdown field
function setClientCuFields() {
  (globalThis as any).__sdSyncCuFields = [
    {
      id: CLIENT_FIELD_ID,
      type: "drop_down",
      type_config: {
        options: [
          // A: exact match
          { id: OPT_EXACT, name: "Apex Legal NoBull3571", orderindex: 0 },
          // B: normalized match (", PC" stripped → "Ackah Law NoBull3571")
          { id: OPT_SUFFIX, name: "Ackah Law NoBull3571, PC", orderindex: 1 },
          // AI tier: option name doesn't normalize to any client → goes to AI
          { id: OPT_AI, name: "Jordan 3571 Advisory", orderindex: 2 },
          // C: already mapped — must be carried over
          { id: OPT_EXISTING, name: "Old Firm NoBull3571", orderindex: 3 },
        ],
      },
    },
  ];
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed actors ──────────────────────────────────────────────────────
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${CEO_ID}, 'ceo', 'CEO 3571')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${AM_ID}, 'account_manager', 'AM 3571')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);

      // Users are seeded inside the isolated (uncommitted) sandbox schema, so
      // requireAuth's ambient public-schema lookup would miss them. Pre-register
      // with the Clerk test registry so role gating reads the seeded profile.
      __test_markUserReconciled(CEO_ID, {
        id: CEO_ID,
        firstName: "CEO 3571",
        role: "ceo",
      });
      __test_markUserReconciled(AM_ID, {
        id: AM_ID,
        firstName: "AM 3571",
        role: "account_manager",
      });

      // ── Seed NoBull clients ──────────────────────────────────────────────
      // `clients` is not auto-cloned by runInIsolatedSchema, so these inserts
      // land in public.clients. Firm names include "NoBull3571" to avoid
      // colliding with real clients. The finally block removes them.
      const TEST_CLIENTS: Array<[string, string]> = [
        [CLIENT_EXACT_ID, "Apex Legal NoBull3571"],
        [CLIENT_SUFFIX_ID, "Ackah Law NoBull3571"],
        [CLIENT_AI_ID, "Jordan Partners Ltd NoBull3571"],
        [CLIENT_EXISTING_ID, "Old Firm NoBull3571"],
      ];
      for (const [id, firmName] of TEST_CLIENTS) {
        await db.execute(sql`
          INSERT INTO clients (id, firm_name)
          VALUES (${id}, ${firmName})
          ON CONFLICT (id) DO UPDATE SET firm_name = EXCLUDED.firm_name
        `);
      }

      // ── Seed a configured list mapping with the existing mapping ─────────
      // sd_list_mapping is NOT isolated (not in opts.tables), so it writes to
      // public.*. Delete any stale row with this LIST_ID first so LIMIT 1 in
      // getListMappingConfig() sees only the fresh test row.
      await db.execute(sql`DELETE FROM sd_list_mapping WHERE clickup_list_id = ${LIST_ID}`);
      await db.insert(sdListMapping).values({
        clickupListId: LIST_ID,
        fieldClientId: CLIENT_FIELD_ID,
        setupStep: "complete",
        clientOptionIds: {
          [OPT_EXISTING]: CLIENT_EXISTING_ID,
        },
      });

      setClientCuFields();

      // Default AI stub: returns one high-confidence pair for OPT_AI
      (globalThis as any).__sdSyncOpenaiResponse = {
        content: JSON.stringify([
          { optionId: OPT_AI, clientId: CLIENT_AI_ID },
        ]),
      };

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      try {
        // ── (F) 403 + 401 for sync ───────────────────────────────────────
        activeUserId = AM_ID;
        const amSync = await postSync(baseUrl);
        assert.equal(amSync.status, 403, `account_manager must get 403 on sync (got ${amSync.status})`);
        console.log("  ✓ F-sync: account_manager rejected with 403");

        activeUserId = null;
        const anonSync = await postSync(baseUrl);
        assert.equal(anonSync.status, 401, `unauthenticated must get 401 on sync (got ${anonSync.status})`);
        console.log("  ✓ F-sync: unauthenticated rejected with 401");

        // ── (F) 403 + 401 for accept ─────────────────────────────────────
        activeUserId = AM_ID;
        const amAccept = await postAccept(baseUrl, [{ optionId: OPT_AI, clientId: CLIENT_AI_ID }]);
        assert.equal(amAccept.status, 403, `account_manager must get 403 on accept (got ${amAccept.status})`);
        console.log("  ✓ F-accept: account_manager rejected with 403");

        activeUserId = null;
        const anonAccept = await postAccept(baseUrl, [{ optionId: OPT_AI, clientId: CLIENT_AI_ID }]);
        assert.equal(anonAccept.status, 401, `unauthenticated must get 401 on accept (got ${anonAccept.status})`);
        console.log("  ✓ F-accept: unauthenticated rejected with 401");

        // Switch to CEO for the rest of the test
        activeUserId = CEO_ID;

        // ── (A) + (B) + (C) + AI suggestions: full sync run ─────────────
        const syncResp = await postSync(baseUrl);
        assert.equal(
          syncResp.status,
          200,
          `sync must return 200 (got ${syncResp.status}: ${JSON.stringify(syncResp.body)})`,
        );

        const body = syncResp.body;
        assert.ok(typeof body.autoMatchedCount === "number", "body.autoMatchedCount must be a number");
        assert.ok(Array.isArray(body.unmatchedOptions), "body.unmatchedOptions must be an array");
        assert.ok(Array.isArray(body.clientsWithoutOption), "body.clientsWithoutOption must be an array");
        assert.ok(typeof body.savedMap === "object", "body.savedMap must be an object");
        assert.ok(Array.isArray(body.suggestions), "body.suggestions must be an array");

        // (A) OPT_EXACT → CLIENT_EXACT_ID (exact match)
        assert.equal(
          body.savedMap[OPT_EXACT],
          CLIENT_EXACT_ID,
          `OPT_EXACT must be auto-mapped to CLIENT_EXACT_ID (got ${body.savedMap[OPT_EXACT]})`,
        );
        console.log("  ✓ A: exact match → OPT_EXACT → CLIENT_EXACT_ID auto-mapped");

        // (B) OPT_SUFFIX "Ackah Law NoBull3571, PC" → CLIENT_SUFFIX_ID after normalization
        assert.equal(
          body.savedMap[OPT_SUFFIX],
          CLIENT_SUFFIX_ID,
          `OPT_SUFFIX must be normalized-matched to CLIENT_SUFFIX_ID (got ${body.savedMap[OPT_SUFFIX]})`,
        );
        console.log("  ✓ B: normalized match → OPT_SUFFIX ('Ackah Law NoBull3571, PC') → CLIENT_SUFFIX_ID");

        // (C) OPT_EXISTING must still point to CLIENT_EXISTING_ID (carry-over)
        assert.equal(
          body.savedMap[OPT_EXISTING],
          CLIENT_EXISTING_ID,
          `OPT_EXISTING must carry over to CLIENT_EXISTING_ID (got ${body.savedMap[OPT_EXISTING]})`,
        );
        console.log("  ✓ C: existing mapping carried over without modification");

        // autoMatchedCount = 2 (exact + normalized)
        assert.equal(
          body.autoMatchedCount,
          2,
          `autoMatchedCount must be 2 (got ${body.autoMatchedCount})`,
        );

        // AI suggestion for OPT_AI
        const aiSuggestion = body.suggestions.find((s: any) => s.optionId === OPT_AI);
        assert.ok(aiSuggestion, "AI suggestion for OPT_AI must be present");
        assert.equal(aiSuggestion.clientId, CLIENT_AI_ID, "AI suggestion must propose CLIENT_AI_ID");
        console.log("  ✓ AI suggestion: OPT_AI → CLIENT_AI_ID proposed by AI tier");

        // AI suggestion must NOT be persisted yet (not in savedMap)
        assert.ok(
          !body.savedMap[OPT_AI],
          `OPT_AI must NOT be in savedMap before accept (got ${body.savedMap[OPT_AI]})`,
        );
        console.log("  ✓ AI suggestion is not persisted until accepted");

        // Verify DB state after sync
        const mapRow = await db.execute(sql`
          SELECT client_option_ids FROM sd_list_mapping WHERE clickup_list_id = ${LIST_ID} LIMIT 1
        `);
        assert.equal(mapRow.rows.length, 1, "sd_list_mapping row must exist");
        const dbMap = mapRow.rows[0].client_option_ids as Record<string, string>;
        assert.equal(dbMap[OPT_EXACT], CLIENT_EXACT_ID, "DB: OPT_EXACT mapped correctly");
        assert.equal(dbMap[OPT_SUFFIX], CLIENT_SUFFIX_ID, "DB: OPT_SUFFIX mapped correctly");
        assert.equal(dbMap[OPT_EXISTING], CLIENT_EXISTING_ID, "DB: OPT_EXISTING preserved in DB");
        assert.ok(!dbMap[OPT_AI], "DB: OPT_AI not in DB map before accept");
        console.log("  ✓ DB state verified after sync");

        // ── (E) Accept suggestion ─────────────────────────────────────────
        const acceptResp = await postAccept(baseUrl, [{ optionId: OPT_AI, clientId: CLIENT_AI_ID }]);
        assert.equal(
          acceptResp.status,
          200,
          `accept must return 200 (got ${acceptResp.status}: ${JSON.stringify(acceptResp.body)})`,
        );
        assert.equal(acceptResp.body.accepted, 1, `accepted count must be 1 (got ${acceptResp.body.accepted})`);
        assert.equal(
          acceptResp.body.savedMap[OPT_AI],
          CLIENT_AI_ID,
          `OPT_AI must now be in savedMap (got ${acceptResp.body.savedMap[OPT_AI]})`,
        );
        console.log("  ✓ E: accept persists OPT_AI → CLIENT_AI_ID");

        // Verify OPT_EXISTING was not overwritten by accept
        assert.equal(
          acceptResp.body.savedMap[OPT_EXISTING],
          CLIENT_EXISTING_ID,
          "OPT_EXISTING must remain after accept",
        );
        console.log("  ✓ E: accept does not overwrite existing mappings");

        // Verify DB reflects accepted pair
        const postAcceptRow = await db.execute(sql`
          SELECT client_option_ids FROM sd_list_mapping WHERE clickup_list_id = ${LIST_ID} LIMIT 1
        `);
        const postAcceptMap = postAcceptRow.rows[0].client_option_ids as Record<string, string>;
        assert.equal(postAcceptMap[OPT_AI], CLIENT_AI_ID, "DB: OPT_AI persisted after accept");
        console.log("  ✓ E: DB persists accepted suggestion");

        // ── (E) Accept idempotency — re-accepting OPT_AI is a no-op ─────
        const acceptAgain = await postAccept(baseUrl, [{ optionId: OPT_AI, clientId: CLIENT_EXISTING_ID }]);
        assert.equal(acceptAgain.status, 200, "second accept must still return 200");
        assert.equal(acceptAgain.body.accepted, 0, "second accept must not overwrite existing entry");
        assert.equal(
          acceptAgain.body.savedMap[OPT_AI],
          CLIENT_AI_ID,
          "OPT_AI must still point to CLIENT_AI_ID after idempotent accept attempt",
        );
        console.log("  ✓ E: accept is idempotent — existing mappings are never overwritten");

        // ── (D) AI-failure degradation ────────────────────────────────────
        // Reset the mapping so unmapped options remain for this sub-test
        await db.execute(sql`
          UPDATE sd_list_mapping
          SET client_option_ids = ${JSON.stringify({ [OPT_EXISTING]: CLIENT_EXISTING_ID })}::jsonb
          WHERE clickup_list_id = ${LIST_ID}
        `);
        setClientCuFields();
        (globalThis as any).__sdSyncOpenaiResponse = { throw: true };

        const degradedResp = await postSync(baseUrl);
        assert.equal(
          degradedResp.status,
          200,
          `sync must still return 200 on AI failure (got ${degradedResp.status})`,
        );
        assert.ok(
          Array.isArray(degradedResp.body.suggestions) && degradedResp.body.suggestions.length === 0,
          "suggestions must be empty on AI failure",
        );
        assert.ok(
          typeof degradedResp.body.suggestionsNote === "string" && degradedResp.body.suggestionsNote.length > 0,
          `suggestionsNote must be set on AI failure (got: ${degradedResp.body.suggestionsNote})`,
        );
        // Tier-1 matches must still have worked
        assert.equal(
          degradedResp.body.savedMap[OPT_EXACT],
          CLIENT_EXACT_ID,
          "Tier-1 exact match still works on AI failure",
        );
        assert.equal(
          degradedResp.body.savedMap[OPT_SUFFIX],
          CLIENT_SUFFIX_ID,
          "Tier-1 normalized match still works on AI failure",
        );
        console.log("  ✓ D: AI failure degrades gracefully — Tier-1 still runs, suggestionsNote set");

      } finally {
        __test_resetReconciledUsers();
        await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
        getGlobalDispatcher().close?.();
        // Clean up stubs
        delete (globalThis as any).__sdSyncCuFields;
        delete (globalThis as any).__sdSyncOpenaiResponse;
        // Remove test client rows from public.clients (not auto-cleaned by isolated schema)
        const testClientIds = TEST_CLIENTS.map(([id]) => id);
        for (const id of testClientIds) {
          await db.execute(sql`DELETE FROM clients WHERE id = ${id}`);
        }
        // Remove test sd_list_mapping row (not auto-cleaned by isolated schema)
        await db.execute(sql`DELETE FROM sd_list_mapping WHERE clickup_list_id = ${LIST_ID}`);
      }
    },
    { pinGetDbForCrossAsync: true },
  );
}

main().then(() => {
  console.log("service-desk-sync-client-options-route: all sections passed.");
  process.exit(0);
}).catch((err) => {
  console.error("service-desk-sync-client-options-route: FAILED —", err?.stack ?? err);
  process.exit(1);
});
