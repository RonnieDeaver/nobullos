/* test-registration
{
  "name": "Front batch domain-attach guardrails + combined lift (Task #2536)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/front-attach-senders-setup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2536 — Batch domain-attach guardrails + combined lift.
 *
 * Task #2526 added the batch route
 *   POST /api/integrations/front/attach-senders-to-client
 * which lets an operator trust several sender domains to ONE client in a
 * single press. The only existing automated coverage
 * (`tests/front-unmatched-diagnosis.test.ts`) pins the empty/blank
 * short-circuit of `reEvaluateUnmatchedForTargets`. Nothing pins the route's
 * precision guardrails, which is where "raise match rate" could quietly weaken
 * precision.
 *
 * This boots the REAL integration routes (via `registerIntegrationRoutes`) and
 * drives the batch route over HTTP with a mix of valid, public free-mail,
 * internal-company, duplicate, already-present and malformed domains, asserting
 * that the batch path:
 *   1. Skips public + company + malformed domains WITH a reason while still
 *      attaching the valid ones (precision preserved — the skipped domains are
 *      never fed into re-eval).
 *   2. De-dupes a request-level duplicate (case-insensitive) and reports an
 *      already-present domain as `already` (not re-attached) while STILL
 *      including it in the combined re-eval set (so the operator sees the full
 *      lift across the selected set).
 *   3. Reports ONE combined matched / re-evaluated total — proving the service
 *      is invoked exactly once for the whole trusted set, not once per domain,
 *      so the batch flow can never weaken precision relative to the one-at-a-
 *      time route.
 *
 * `reEvaluateUnmatchedForTargets` is stubbed (loader redirect) to record the
 * targets it receives and return a deterministic combined result, so the heavy
 * per-row hard-match pipeline doesn't have to run. Auth + the
 * `requireAccountManager` gate run for real against a seeded user inside an
 * isolated Postgres schema; `storage.getClient` / `storage.updateClient` are
 * stubbed in-memory so no real client rows are mutated.
 *
 * Run:
 *   NODE_ENV=test npx tsx --import ./tests/front-attach-senders-setup.mjs \
 *     tests/front-attach-senders-batch-route.test.ts
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { storage } from "../server/storage";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

// Take the Clerk per-request test seam even under a bare `npx tsx` repro.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const AM_ID = "test-2536-am";
const CLIENT_ID = "client-2536";

type ReEvalGlobal = {
  calls: Array<Array<{ email?: string; domain?: string }>>;
  result: { total: number; matched: number; filterRuleHandled: number };
};

function reEvalState(): ReEvalGlobal {
  const g =
    ((globalThis as any).__attachSendersReEval as ReEvalGlobal | undefined) ??
    ((globalThis as any).__attachSendersReEval = {
      calls: [],
      result: { total: 0, matched: 0, filterRuleHandled: 0 },
    });
  return g;
}

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

async function post(
  baseUrl: string,
  p: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

// In-memory client whose emailDomains the route reads + (would) update.
let currentClient: { id: string; firmName: string; emailDomains: string[] } | null = null;
let lastUpdateDomains: string[] | null = null;

function installStorageStubs(): void {
  currentClient = {
    id: CLIENT_ID,
    firmName: "Acme Law",
    emailDomains: ["existing-firm.com"],
  };
  lastUpdateDomains = null;
  (storage as any).getClient = async (id: string) =>
    id === CLIENT_ID ? { ...currentClient } : undefined;
  (storage as any).updateClient = async (id: string, patch: any) => {
    if (id !== CLIENT_ID || !currentClient) return undefined;
    if (Array.isArray(patch?.emailDomains)) {
      lastUpdateDomains = [...patch.emailDomains];
      currentClient.emailDomains = [...patch.emailDomains];
    }
    return { ...currentClient };
  };
}

let passed = 0;
function check(cond: unknown, label: string): void {
  assert.ok(cond, label);
  passed++;
  console.log(`  ok  ${label}`);
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      // requireAccountManager → storage.getUser(...) resolves against this
      // cloned `users` row. account_manager is the minimum role the route
      // gate requires.
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES (${AM_ID}, 'account_manager', 'account_manager', 'T2536 AM')
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);
      // User is seeded in the isolated (uncommitted) schema; requireAuth
      // resolves identity via the ambient PUBLIC-schema db, so pre-register
      // the profile in the module registry with the role the route needs.
      __test_markUserReconciled(AM_ID, {
        id: AM_ID,
        role: "account_manager",
        firstName: "T2536 AM",
      });

      installStorageStubs();
      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      try {
        // ── Scenario A: mixed batch ─────────────────────────────────────
        const state = reEvalState();
        state.calls.length = 0;
        state.result = { total: 5, matched: 3, filterRuleHandled: 1 };

        const a = await post(baseUrl, "/api/integrations/front/attach-senders-to-client", {
          clientId: CLIENT_ID,
          domains: [
            "valid-firm.com",
            "VALID-FIRM.COM", // request-level duplicate (case-insensitive)
            "@trusted-two.com", // leading-@ normalization
            "gmail.com", // public free-mail → skipped
            "nobullmarketing.com", // internal company → skipped
            "stripe.com", // Task #4790: vendor platform → skipped
            "existing-firm.com", // already present → "already"
            "invalidnodot", // malformed (no dot) → skipped
          ],
        });

        check(a.status === 200, "mixed batch → 200");

        const results: Array<{ domain: string; status: string; reason?: string }> = a.body.results;
        const byDomain = (d: string) => results.filter((r) => r.domain === d);

        // (1) Precision: public + company + malformed are skipped with a reason.
        const gmail = byDomain("gmail.com")[0];
        check(
          gmail?.status === "skipped" && /public/i.test(gmail.reason ?? ""),
          "public free-mail domain skipped with a public-domain reason",
        );
        const company = byDomain("nobullmarketing.com")[0];
        check(
          company?.status === "skipped" && /company/i.test(company.reason ?? ""),
          "internal company domain skipped with a company reason",
        );
        const malformed = byDomain("invalidnodot")[0];
        check(
          malformed?.status === "skipped" && /valid domain/i.test(malformed.reason ?? ""),
          "malformed (no-dot) domain skipped with a not-a-valid-domain reason",
        );
        // Task #4790 — vendor platform domains are refused like public/company
        // (the Dellutri poison shape: stripe.com trusted to one client).
        const vendor = byDomain("stripe.com")[0];
        check(
          vendor?.status === "skipped" && /vendor/i.test(vendor.reason ?? ""),
          "vendor platform domain skipped with a vendor-platform reason",
        );

        // ...while the valid ones are still attached.
        check(byDomain("valid-firm.com")[0]?.status === "attached", "valid new domain attached");
        check(byDomain("trusted-two.com")[0]?.status === "attached", "leading-@ domain normalized + attached");

        // (2) De-dupe: the case-insensitive duplicate collapses to ONE entry,
        //     and the already-present domain is reported `already` (not added).
        check(byDomain("valid-firm.com").length === 1, "case-insensitive duplicate collapses to one result");
        check(byDomain("existing-firm.com")[0]?.status === "already", "already-present domain reported as already");

        // Summary counts.
        check(a.body.attached === 2, "attached count = 2");
        check(a.body.alreadyPresent === 1, "alreadyPresent count = 1");
        check(a.body.skipped === 4, "skipped count = 4 (public + company + vendor + malformed)");

        // updateClient only ever received the two NEW valid domains on top of
        // the existing one — never the public/company/malformed ones.
        check(
          !!lastUpdateDomains &&
            lastUpdateDomains.includes("valid-firm.com") &&
            lastUpdateDomains.includes("trusted-two.com") &&
            lastUpdateDomains.includes("existing-firm.com"),
          "client domains updated with the existing + both new valid domains",
        );
        check(
          !!lastUpdateDomains &&
            !lastUpdateDomains.includes("gmail.com") &&
            !lastUpdateDomains.includes("nobullmarketing.com") &&
            !lastUpdateDomains.includes("stripe.com") &&
            !lastUpdateDomains.includes("invalidnodot"),
          "skipped domains never persisted to the client",
        );

        // (3) ONE combined re-eval call across the whole trusted set — not one
        //     per domain. This is the core "can't weaken precision" guarantee.
        check(state.calls.length === 1, "re-eval invoked exactly once (one combined lift, not per-domain)");
        const sentDomains = (state.calls[0] ?? [])
          .map((t) => (t.domain ?? "").toLowerCase())
          .sort();
        check(
          JSON.stringify(sentDomains) ===
            JSON.stringify(["existing-firm.com", "trusted-two.com", "valid-firm.com"]),
          "re-eval received exactly the trusted set (attached + already), never public/company/malformed",
        );

        // The route surfaces ONE combined matched / re-evaluated total verbatim
        // from the single service call.
        check(a.body.reEvaluated === 5, "reEvaluated total surfaced from the single combined call");
        check(a.body.matched === 3, "matched total is the single combined number");
        check(a.body.filterRuleHandled === 1, "filterRuleHandled total surfaced from the combined call");

        // ── Scenario B: only excluded domains → re-eval never runs ───────
        state.calls.length = 0;
        state.result = { total: 99, matched: 99, filterRuleHandled: 99 };
        const b = await post(baseUrl, "/api/integrations/front/attach-senders-to-client", {
          clientId: CLIENT_ID,
          domains: ["gmail.com", "nobullmarketing.com"],
        });
        check(b.status === 200, "all-excluded batch → 200");
        check(b.body.attached === 0 && b.body.skipped === 2, "all-excluded batch attaches nothing, skips both");
        check(
          state.calls.length === 0,
          "no trusted domain ⇒ re-eval never invoked (excluded domains never re-evaluated)",
        );
        check(
          b.body.matched === 0 && b.body.reEvaluated === 0,
          "all-excluded batch reports zero lift (does not surface the stub's would-be result)",
        );

        // ── Scenario C: empty domains → 400 ─────────────────────────────
        const c = await post(baseUrl, "/api/integrations/front/attach-senders-to-client", {
          clientId: CLIENT_ID,
          domains: [],
        });
        check(c.status === 400, "empty domains → 400 (no work performed)");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    { tables: ["users"] },
  );

  // Route test fetches a local express server → undici keep-alive sockets keep
  // the loop alive on exit. Close the global dispatcher so the suite drains.
  try {
    const { getGlobalDispatcher } = await import("undici");
    await getGlobalDispatcher().close();
  } catch {
    // undici not resolvable as a bare specifier in some setups — harmless.
  }
}

main().then(
  () => {
    console.log(`\nfront-attach-senders-batch-route: ${passed} checks passed`);
    process.exit(0);
  },
  (err) => {
    console.error("front-attach-senders-batch-route: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
