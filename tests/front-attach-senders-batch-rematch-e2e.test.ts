/* test-registration
{
  "name": "Front batch domain-attach re-matches real conversations e2e (Task #2561)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2561 — End-to-end proof that the BATCH domain-attach actually re-matches
 * real conversations (no stub for the re-eval pipeline).
 *
 * The guardrail test (`tests/front-attach-senders-batch-route.test.ts`, Task
 * #2536) STUBS `reEvaluateUnmatchedForTargets` to pin the route's precision
 * guardrails (skip public/company/malformed, de-dupe, one combined lift). That
 * means nothing yet proves the batch path, end-to-end:
 *   - actually flips the affected unmatched `front_sync_emails` rows to
 *     `auto_matched` when several domains are attached in one press, and
 *   - de-dupes a conversation reached via TWO different attached domains so the
 *     combined `matched` total counts it exactly once (the by-id `Map` inside
 *     `reEvaluateUnmatchedForTargets`).
 *
 * This boots the REAL integration routes (via `registerIntegrationRoutes`) and
 * drives the batch route over HTTP with the REAL service (no loader stub),
 * inside an isolated Postgres schema seeded with clients + contacts + a handful
 * of unmatched rows whose participants span the two attached domains.
 *
 * Why an isolated schema (not the tx sandbox): the Express request handler runs
 * in a separate async context outside the sandbox's ALS scope, so we pin
 * getDb() at the isolated, cloned tables via `pinGetDbForCrossAsync` (the
 * cross-async handler then reads/writes the seeded rows instead of live
 * `public`).
 *
 * Hermetic: matching is deterministic hard-match only (the AI operational
 * classifier was removed), and a pre-seeded `raw_communication_records` row
 * (matched on `external_source_id`) makes `applyMatchedConversation` take the
 * existing-record branch instead of calling the Front API to ingest. A global
 * fetch override throws on any unexpected egress so a regression is loud.
 *
 * Public-API doc note: this exercises our OWN route + service code, not a
 * third-party endpoint; no external API surface is touched (the Front-ingest
 * path that would call Front is suppressed as described above). Prior-task
 * research: builds on Task #2525's isolated-schema single-target attach
 * harness, the Task #2536 batch route + guardrails, and the Task #867
 * trusted-domain hard-match rules.
 *
 * Run:
 *   NODE_ENV=test npx tsx tests/front-attach-senders-batch-rematch-e2e.test.ts
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";

import { runInIsolatedSchema, sql } from "./db-sandbox";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import { invalidateHardMatchIndexes } from "../server/services/frontHardMatch";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

// Take the Clerk per-request test seam even under a bare `npx tsx` repro.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

// Hermetic guard: matching is deterministic hard-match only and a pre-seeded
// raw record suppresses Front ingest, so no upstream HTTP should occur. The
// loopback call uses `originalFetch` below.
const originalFetch: typeof fetch = global.fetch;
global.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  throw new Error(`[task-2561] Unexpected network call during hermetic test: ${url}`);
}) as any;

const AM_ID = "task-2561-am";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): authenticate as AM_ID.
    (req as any).__test_clerkUserId = AM_ID;
    next();
  });
  registerIntegrationRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function postBatch(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  // Use the un-stubbed fetch (the global stub throws); this is a local loopback
  // call to our own server, not an external API.
  const r = await originalFetch(`${baseUrl}/api/integrations/front/attach-senders-to-client`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

const TABLES = [
  "users",
  "clients",
  "client_contacts",
  "client_contacts_audit",
  "front_sync_emails",
  "front_hydrate_snapshots",
  "raw_communication_records",
  "front_match_audit_log",
  "import_entity_suggestions",
  "front_filter_rules",
  "system_settings",
] as const;

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  \u2717 ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  }
}

async function main(): Promise<void> {
  console.log("Front batch domain-attach re-matches real conversations end-to-end (Task #2561)");

  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed: AM user (role gating reads users via getDb → isolated) ──────
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${AM_ID}, 'account_manager', 'Task2561 AM')
      `);
      // Users are seeded in the isolated (uncommitted) schema; requireAuth
      // resolves identity via the ambient PUBLIC-schema db, so pre-register
      // the profile in the module registry with the role the routes need.
      __test_markUserReconciled(AM_ID, {
        id: AM_ID,
        role: "account_manager",
        firstName: "Task2561 AM",
      });

      // ── Seed: target client with an EMPTY trusted-domain list ────────────
      // It will gain TWO domains in one batch press. Both belong to the SAME
      // client so a conversation spanning both stays a UNIQUE hard match (not
      // ambiguous).
      const CLIENT_A = "client-2561-a";
      const DOMAIN_ONE = "alpha-law.com";
      const DOMAIN_TWO = "alpha-legal.com";
      await db.execute(sql`
        INSERT INTO clients (id, firm_name, email_domains, is_archived)
        VALUES (${CLIENT_A}, 'Alpha Law Firm', ARRAY[]::text[], false)
      `);

      // ── Seed: unmatched front_sync_emails rows ───────────────────────────
      // CONV_SPAN spans BOTH attached domains in its participants → it is
      // returned by the participant query for EACH target, so the by-id Map is
      // what stops it being counted/processed twice.
      const CONV_SPAN = "conv-2561-span";
      // Single-domain rows — one per attached domain.
      const CONV_LAW_ONLY = "conv-2561-law";
      const CONV_LEGAL_ONLY = "conv-2561-legal";
      // Unrelated (un-attached domain) — must stay untouched.
      const CONV_UNRELATED = "conv-2561-unrelated";

      const rows: Array<{ conv: string; participants: Array<{ name: string; email: string; role: string }> }> = [
        {
          conv: CONV_SPAN,
          participants: [
            { name: "Jane Doe", email: `jane@${DOMAIN_ONE}`, role: "from" },
            { name: "Bob Roe", email: `bob@${DOMAIN_TWO}`, role: "to" },
          ],
        },
        { conv: CONV_LAW_ONLY, participants: [{ name: "Kate Poe", email: `kate@${DOMAIN_ONE}`, role: "from" }] },
        { conv: CONV_LEGAL_ONLY, participants: [{ name: "Liam Loe", email: `liam@${DOMAIN_TWO}`, role: "from" }] },
        { conv: CONV_UNRELATED, participants: [{ name: "Zoe Foe", email: "zoe@unrelated-firm.com", role: "from" }] },
      ];

      for (const r of rows) {
        const participants = JSON.stringify(r.participants);
        const versionKey = `${r.conv}::no_msg`;
        await db.execute(sql`
          INSERT INTO front_sync_emails
            (conversation_id, subject, snippet, participants_json, match_status,
             pipeline_state, version_key)
          VALUES
            (${r.conv}, ${"Subject " + r.conv}, ${"snippet"},
             ${participants}::jsonb, 'unmatched', 'apply_pending', ${versionKey})
        `);
        // Hydrated snapshot so apply finds it (no Front re-hydrate call).
        await db.execute(sql`
          INSERT INTO front_hydrate_snapshots
            (conversation_id, version_key, conversation_json, messages_json, message_count)
          VALUES
            (${r.conv}, ${versionKey}, '{}'::jsonb, '[]'::jsonb, 0)
        `);
      }

      // Pre-seed raw records for the three rows we EXPECT to flip, each already
      // pointing at the target client → apply takes the existing-record noop
      // branch (no ingestConversation / Front API call).
      await db.execute(sql`
        INSERT INTO raw_communication_records
          (client_id, source_type, title, timestamp, external_source_id)
        VALUES
          (${CLIENT_A}, 'front_email', 'raw span', now(), ${CONV_SPAN}),
          (${CLIENT_A}, 'front_email', 'raw law', now(), ${CONV_LAW_ONLY}),
          (${CLIENT_A}, 'front_email', 'raw legal', now(), ${CONV_LEGAL_ONLY})
      `);

      invalidateHardMatchIndexes();

      const { server, baseUrl } = await listen(buildApp());
      try {
        // ── Batch attach: TWO new domains to ONE client in a single press ──
        const r = await postBatch(baseUrl, {
          clientId: CLIENT_A,
          domains: [DOMAIN_ONE, DOMAIN_TWO],
        });

        check("batch attach returns 200", () => assert.equal(r.status, 200, JSON.stringify(r.json)));
        check("batch attaches both new domains, skips none", () => {
          assert.equal(r.json.attached, 2, `attached=${r.json.attached}`);
          assert.equal(r.json.skipped, 0, `skipped=${r.json.skipped}`);
        });

        // Core de-dupe proof: CONV_SPAN is reachable via BOTH attached domains,
        // so a naive (non-Map) implementation would count it twice → total 4 /
        // matched 4. The by-id Map collapses it: 3 DISTINCT conversations, each
        // matched exactly once.
        check("combined re-eval reports 3 DISTINCT conversations (CONV_SPAN counted once)", () =>
          assert.equal(r.json.reEvaluated, 3, `reEvaluated=${r.json.reEvaluated}`));
        check("combined matched total counts each conversation once (by-id de-dupe)", () =>
          assert.equal(r.json.matched, 3, `matched=${r.json.matched}`));

        // ── End-to-end effect: the affected rows actually flipped ──────────
        const flipped = (await db.execute(sql`
          SELECT conversation_id, match_status, matched_client_id
          FROM front_sync_emails
          WHERE match_status = 'auto_matched'
          ORDER BY conversation_id
        `)).rows as Array<{ conversation_id: string; match_status: string; matched_client_id: string }>;

        check("exactly three rows flipped to auto_matched", () =>
          assert.equal(flipped.length, 3, `flipped=${JSON.stringify(flipped)}`));
        check("the two-domain (spanning) conversation flipped to the target client", () => {
          const span = flipped.find((x) => x.conversation_id === CONV_SPAN);
          assert.ok(span, `CONV_SPAN not flipped: ${JSON.stringify(flipped)}`);
          assert.equal(span!.matched_client_id, CLIENT_A);
        });
        check("each single-domain conversation flipped to the target client", () => {
          for (const conv of [CONV_LAW_ONLY, CONV_LEGAL_ONLY]) {
            const row = flipped.find((x) => x.conversation_id === conv);
            assert.ok(row, `${conv} not flipped: ${JSON.stringify(flipped)}`);
            assert.equal(row!.matched_client_id, CLIENT_A);
          }
        });

        // ── Precision: the unrelated row is untouched ──────────────────────
        const unrelated = (await db.execute(sql`
          SELECT match_status, matched_client_id FROM front_sync_emails WHERE conversation_id = ${CONV_UNRELATED}
        `)).rows[0] as any;
        check("unrelated row (un-attached domain) stays unmatched", () => {
          assert.equal(unrelated.match_status, "unmatched");
          assert.equal(unrelated.matched_client_id, null);
        });

        // The client really did gain both trusted domains (the data write that
        // the matcher then read).
        const domainsAfter = (await db.execute(sql`
          SELECT email_domains FROM clients WHERE id = ${CLIENT_A}
        `)).rows[0] as any;
        check("target client now trusts both attached domains", () => {
          const got = [...(domainsAfter.email_domains as string[])].sort();
          assert.deepEqual(got, [DOMAIN_ONE, DOMAIN_TWO].sort());
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        invalidateHardMatchIndexes();
        __test_resetReconciledUsers();
      }
    },
    { tables: TABLES, pinGetDbForCrossAsync: true },
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    global.fetch = originalFetch;
    // Loopback fetches keep undici keep-alive sockets alive → close the global
    // dispatcher so the suite drains on exit (run-all scores a hang as FAIL).
    try {
      const { getGlobalDispatcher } = await import("undici");
      await getGlobalDispatcher().close();
    } catch {
      /* undici not resolvable as a bare specifier in some setups — harmless. */
    }
  })
  .catch((err) => {
    global.fetch = originalFetch;
    console.error("Test runner failed:", err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
