/* test-registration
{
  "name": "Ads OS Hygiene Audit route surfaces Account Alerts (Task #5332) — GET /api/ads-os/audit/:cid now includes alerts + alerts_at read straight from the same accountAlertsStore doc the combined dashboard's badge reads (no ClickUp task-ref enrichment, no extra vendor call); zero-alerts account gets alerts:[] + alerts_at:null; client AccountAlertsPanel renders nothing for a fresh empty account, the explanatory panel + AlertList for an account with alerts, and the stale marker mirroring AlertBadge's threshold",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5332: the Hygiene Audit report page used to hide active Account Alerts entirely, so an operator could see a 99 'Excellent' score next to unseen critical alerts. This pins the route contract (alerts/alerts_at sourced from the existing store, no new vendor call) and the panel's visibility rule (empty+fresh -> nothing, else the explanatory panel) so the gap doesn't silently reopen.",
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small",
  "tierReason": "Deliberately small, overriding the mechanical unmeasured default of medium: the audit engine runs against a path-dispatched fetch stub (no real vendor egress, no DB), and the client half renders via react-dom/server with no jsdom — the whole suite completes in well under a second."
}
test-registration */
/**
 * Task #5332 — Account Alerts surfaced on the Google Ads Hygiene Audit report.
 *
 * Hygiene Audit (campaign configuration quality) and Account Alerts
 * (real-time policy/performance feed) are intentionally separate systems
 * (see server/services/adsOs/audit/checksConfig.ts's note on the removed POL
 * category). The gap this task closes is purely presentational: the audit
 * report page never showed the account's already-computed alerts. This test
 * covers both ends of that fix:
 *
 * (A) Server — GET /api/ads-os/audit/:cid additionally reads getAlerts("gads",
 *     cid) (the exact store read dashboardService.ts uses for its ⚠ badge)
 *     and folds {alerts, alerts_at} into the JSON response:
 *       1. an account with a stored alerts doc gets its alerts array + the
 *          doc's generated_at verbatim in the response;
 *       2. an account with no stored doc gets alerts:[] + alerts_at:null;
 *       3. a stale doc's generated_at still passes through unchanged (the
 *          route does no staleness computation itself — that's a client
 *          concern, mirroring the dashboard badge).
 *     The audit itself runs for real (scope resolves to zero campaigns via a
 *     path-dispatched Google Ads fetch stub, so the engine reports band
 *     "Inactive" quickly) — this proves the alerts merge sits at the route
 *     level without disturbing the audit engine's own computation. The fetch
 *     stub also proves no ClickUp host is ever hit by this route (no new
 *     vendor call beyond what the audit engine already made).
 *
 * (B) Client — AccountAlertsPanel (pure render, react-dom/server, no jsdom):
 *       4. zero alerts + fresh timestamp -> renders nothing (no empty-state
 *          clutter);
 *       5. zero alerts + stale timestamp -> a minimal "no active alerts as of
 *          last check" panel + the stale marker (mirrors AlertBadge's own
 *          frozen-all-clear visibility rule);
 *       6. alerts present -> the explanatory copy + AlertList rendering
 *          severity/title/detail, no stale marker when fresh;
 *       7. alerts present + stale -> same list, plus the stale marker.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

// Dynamic imports so the NODE_ENV pin above lands before module-load-time env reads.
const { registerAdsOsRoutes } = await import("../server/routes/adsOs");
const { putAlerts } = await import("../server/services/adsOs/store");
const { runInIsolatedSchema } = await import("./db-sandbox");
const { __test_markUserReconciled, __test_resetReconciledUsers } = await import(
  "../server/middlewares/requireAuth"
);
const { AccountAlertsPanel } = await import(
  "../client/src/pages/adsOs/components/AccountAlertsPanel"
);

// ── Constants ────────────────────────────────────────────────────────────────

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const CEO_ID = `test-5332-ceo-${RUN}`;
const CID_WITH_ALERTS = `53${String(randomInt(0, 99999999)).padStart(8, "0")}`;
const CID_NO_ALERTS = `54${String(randomInt(0, 99999999)).padStart(8, "0")}`;
const CID_STALE = `55${String(randomInt(0, 99999999)).padStart(8, "0")}`;

const FRESH_AT = new Date().toISOString();
const STALE_AT = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago

const ALERTS = [
  { code: "NO_CONV_7D", severity: "critical", title: "No conversions in 7 days", detail: "0 conversions since Aug 20", product: "gads" },
  { code: "DISAPPROVED_ASSET", severity: "high", title: "4 disapproved asset(s)", detail: "4 assets rejected by policy review", product: "gads" },
];

let failures = 0;
async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

// ── Google Ads fetch stub — path-dispatched, never a real vendor hostname ────
// Every GAQL query returns zero rows: the labeled-campaign query resolves to
// an empty scannable set, so the audit engine reports scope_empty (band
// "Inactive") without erroring — exercising the real runAuditCached path
// while keeping this test hermetic. Any /api/v2/* (ClickUp) hit would prove
// this route now makes an unwanted vendor call, so it's tracked and asserted
// away at the end.
const realFetch = globalThis.fetch;
let clickUpHits = 0;
function installFetchStub(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    let pathname = "";
    try { pathname = new URL(url).pathname; } catch { /* fall through */ }
    if (pathname === "/token") {
      return new Response(
        JSON.stringify({ access_token: `test-token-5332-${RUN}`, expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (pathname.includes("googleAds:search")) {
      return new Response(JSON.stringify([{ results: [] }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (pathname.startsWith("/api/v2/")) {
      clickUpHits += 1;
      return new Response(JSON.stringify({ tasks: [], last_page: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
function restoreFetchStub(): void {
  globalThis.fetch = realFetch;
}

// ── App factory (Clerk test seam) ─────────────────────────────────────────────

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = CEO_ID;
    next();
  });
  registerAdsOsRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function getAudit(baseUrl: string, cid: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/ads-os/audit/${cid}`);
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Task #5332: Account Alerts on the Hygiene Audit report");

  // ── (A) Server: route response contract ────────────────────────────────────
  await runInIsolatedSchema(
    async ({ db }) => {
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${CEO_ID}, 'ceo', 'CEO 5332')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo", firstName: "CEO 5332" });

      // Seed the exact store doc dashboardService.ts's overlayLive reads.
      await putAlerts("gads", CID_WITH_ALERTS, { alerts: ALERTS, generated_at: FRESH_AT });
      await putAlerts("gads", CID_STALE, { alerts: [ALERTS[0]], generated_at: STALE_AT });
      // CID_NO_ALERTS: deliberately no stored doc at all.

      installFetchStub();
      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        await step("account with stored alerts: response carries alerts[] + alerts_at verbatim", async () => {
          const { status, body } = await getAudit(baseUrl, CID_WITH_ALERTS);
          assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body).slice(0, 300)}`);
          assert.equal(body.customer_id, CID_WITH_ALERTS);
          assert.deepEqual(body.alerts, ALERTS, "alerts array matches the stored doc exactly (no recomputation)");
          assert.equal(body.alerts_at, FRESH_AT, "alerts_at is the doc's generated_at verbatim");
        });

        await step("account with no stored alerts doc: alerts:[] + alerts_at:null", async () => {
          const { status, body } = await getAudit(baseUrl, CID_NO_ALERTS);
          assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body).slice(0, 300)}`);
          assert.deepEqual(body.alerts, [], "no stored doc -> empty alerts array, never an error");
          assert.equal(body.alerts_at, null, "no stored doc -> alerts_at null");
        });

        await step("stale doc: alerts_at passes through unchanged (staleness is a client concern)", async () => {
          const { status, body } = await getAudit(baseUrl, CID_STALE);
          assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body).slice(0, 300)}`);
          assert.deepEqual(body.alerts, [ALERTS[0]]);
          assert.equal(body.alerts_at, STALE_AT, "route does no staleness math itself — same convention as the dashboard read");
        });

        await step("audit engine itself still ran (untouched) — band reflects the real scope_empty computation", async () => {
          const { body } = await getAudit(baseUrl, CID_WITH_ALERTS);
          assert.equal(body.band, "Inactive", "zero scannable campaigns from the stub -> Inactive, exactly like a real empty-scope account (proves alerts are layered on, not faked)");
        });

        await step("no ClickUp host was ever hit by this route (no new vendor call)", async () => {
          assert.equal(clickUpHits, 0, "the audit route must read the stored alerts doc directly, never enrich via ClickUp task refs");
        });
      } finally {
        server.close();
        restoreFetchStub();
        __test_resetReconciledUsers();
      }
    },
    {
      tables: ["users", "ads_os_audit_scores", "ads_os_account_alerts"],
      pinGetDbForCrossAsync: true,
    },
  );

  // ── (B) Client: AccountAlertsPanel visibility + content ─────────────────────
  const html = (alerts: any[], alertsAt: string | null): string =>
    renderToStaticMarkup(createElement(AccountAlertsPanel as any, { alerts, alertsAt } as any));

  await step("zero alerts + fresh timestamp -> renders nothing", () => {
    assert.equal(html([], FRESH_AT), "", "a fresh, empty alert set must not render an empty-state panel");
    assert.equal(html([], null), "", "no alerts + no timestamp (never checked) also renders nothing");
  });

  await step("zero alerts + stale timestamp -> minimal frozen-all-clear panel with the stale marker", () => {
    const m = html([], STALE_AT);
    assert.ok(m.includes("Account Alerts"), "panel is labeled");
    assert.match(m, /No active alerts recorded/, "explains there are zero CURRENT alerts, not that nothing was checked");
    assert.match(m, /last checked 5d ago/, "stale marker reuses AlertBadge's own day-rounding");
  });

  await step("alerts present (fresh) -> explanatory copy + AlertList content, no stale marker", () => {
    const m = html(ALERTS, FRESH_AT);
    assert.ok(m.includes("Account Alerts"), "panel is labeled");
    assert.match(m, /separately from the Hygiene score/, "explanatory copy clarifies the two systems don't contradict");
    assert.ok(m.includes("No conversions in 7 days"), "renders the alert title");
    assert.ok(m.includes("4 disapproved asset(s)"), "renders the second alert title");
    assert.ok(m.includes("0 conversions since Aug 20"), "renders alert detail");
    assert.ok(m.includes("sev-critical") && m.includes("sev-high"), "severity classes ride through from the shared AlertList");
    assert.ok(!m.includes("last checked"), "fresh data shows no staleness marker");
  });

  await step("alerts present + stale -> list renders AND the stale marker appears", () => {
    const m = html([ALERTS[0]], STALE_AT);
    assert.ok(m.includes("No conversions in 7 days"), "alert still renders even when stale");
    assert.match(m, /last checked 5d ago/, "stale marker appended alongside the real alert list");
  });

  if (failures > 0) {
    console.error(`\n${failures} step(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nAll steps passed (Task #5332).");
  }

  await getGlobalDispatcher().close();
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
  try {
    restoreFetchStub();
    __test_resetReconciledUsers();
    await getGlobalDispatcher().close();
  } catch {}
});
