/* test-registration
{
  "name": "Command Panel PUT / key-calls / RER bodies are Zod-validated with whitelisted persistence and no partial writes (audit A-007)",
  "regression": true,
  "sweepOnlyReason": "DB-bound route suite (isolated-schema Postgres tables + a real HTTP server per run); belongs in the full suite and the nightly --regression sweep, not the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
/**
 * Audit A-007 remainder — three Command Panel mutation endpoints accepted
 * bodies with no schema validation:
 *
 *   PUT  /api/clients/:clientId/command-panel                (key whitelist, no value types)
 *   POST /api/clients/:clientId/command-panel/key-calls      (manual callType check only)
 *   POST /api/clients/:clientId/command-panel/rer-recordings (manual typeof/trim only)
 *
 * They now validate via updateCommandPanelRequestSchema /
 * assignCommandPanelKeyCallRequestSchema /
 * assignCommandPanelRerRecordingRequestSchema (shared/models/commandCenter.ts)
 * before any DB mutation. This suite pins:
 *
 *   (1) The PUT whitelist is derived from updateCommandPanelSchema and stays
 *       in lockstep with the 42 operator-editable fields — server-managed
 *       columns are not in the schema shape.
 *   (2) Baseline valid PUT bodies (the exact CommandPanel.tsx save shape,
 *       explicit-null clears, enum/union values, productTypes client sync,
 *       first-save productTypes inheritance, empty body) behave as before.
 *   (3) Protected/unknown PUT fields are stripped and never persisted; type-
 *       and enum-invalid values → 400 `{ error: issues[] }` with NO write and
 *       NO history/version rows.
 *   (4) key-calls: valid shapes (with/without/empty recording id) unchanged,
 *       "Invalid callType" envelope preserved verbatim, non-string recording
 *       id → 400 issues[] before any link/upsert side effect.
 *   (5) RER: trim coercion preserved, every malformed shape gets the exact
 *       legacy fixed-message 400 with no row and no raw-record mutation,
 *       duplicate response contract unchanged.
 *   (6) Auth contracts unchanged (sales write → 403; unknown client → 404;
 *       missing panel → 404 with the legacy message).
 *   (7) Task #4510: productTypes is canonicalized at the PUT boundary —
 *       legacy aliases (plural "webinars", still stored by 26 prod panels as
 *       of 2026-08-11) heal to canonical ids on save, the alias+canonical
 *       double-entry artifact dedupes, unknown values → 400 with the exact
 *       INVALID_PRODUCTS envelope the clients routes use and NO write, and
 *       explicit null / empty list keep their existing meanings.
 *
 * Hermetic: runs against a per-test isolated schema via runInIsolatedSchema.
 * findOpenZoomReviewForRaw intentionally queries the shared pool's public
 * schema (empty in the hermetic per-run test DB), so the review-queue branch
 * stays inert here by construction.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { registerCommandCenterRoutes } from "../server/routes/commandCenter";
import { updateCommandPanelSchema } from "../shared/models/commandCenter";
import { normalizeProductList } from "../server/utils/productResolution";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const CEO_ID = "test-cp-validation-ceo";
const SALES_ID = "test-cp-validation-sales";
const CLIENT_A = "test-cp-validation-client-a";
const CLIENT_B = "test-cp-validation-client-b";
const RAW_LINK = "test-cp-validation-raw-link";
const RAW_OTHER = "test-cp-validation-raw-other-client";
const RAW_RER_1 = "test-cp-validation-raw-rer-1";
const RAW_RER_2 = "test-cp-validation-raw-rer-2";
const TAG = "audit-a007";

// The Clerk-era requireAuth middleware ignores pre-provisioned passport-shape
// req.user objects entirely — it authenticates from its own session lookup and
// 401s first, which is why the old injection harness stopped working after the
// Clerk migration. Under NODE_ENV=test it reads the per-request seam
// req.__test_clerkUserId instead and builds req.user itself (the users rows
// seeded in the isolated schema supply the roles authorizeClientAccess reads).
process.env.NODE_ENV = "test";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): the acting id comes
    // from the x-test-user header (defaults to CEO_ID). The pre-Clerk
    // passport-shape injection stopped working when auth migrated.
    const sub = (req.headers["x-test-user"] as string) || CEO_ID;
    (req as any).__test_clerkUserId = sub;
    next();
  });
  registerCommandCenterRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function send(
  baseUrl: string,
  method: "PUT" | "POST",
  p: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// The 42 operator-editable panel fields (the pre-rewrite ALLOWED_PANEL_FIELDS
// literal). The route now derives its whitelist from
// updateCommandPanelSchema.shape, so this pin proves the schema and the
// legacy whitelist are the same set — and that server-managed columns stayed
// out of it.
const EXPECTED_PANEL_FIELDS = [
  "accountOwnerId", "secondaryOwnerIds", "productTypes", "productStatusNotes",
  "googleAdsBudget", "webinarBudget", "lsaBudget",
  "quarterPrimaryObjective", "annualGoals", "longTermGoals",
  "successDefinitionQuarter", "growthStrategy", "currentBottleneck", "budgetPosture",
  "approvedTerritory", "priorityMarkets", "secondaryMarkets",
  "annualRevenueGoal", "onboardingNotes", "geographicExpansionNotes",
  "googleAdsTargetAreas", "googleAdsTargetingMethod", "googleAdsExcludedAreas", "googleAdsGeoNotes",
  "webinarTargetAreas", "webinarGeoNotes",
  "activeCampaignFocus", "activeOffers", "keyActiveInitiatives",
  "currentRiskFlags", "currentOpportunities", "clientPreferences",
  "internalHandlingNotes", "googleDriveFolderLink", "googleDriveFolderName",
  "zoomRecordingsFolderId", "zoomRecordingsFolderLink", "zoomRecordingsFolderName",
  "rerReportsFolderId", "rerReportsFolderLink", "rerReportsFolderName",
  "externalSystemLinks",
];

const SERVER_MANAGED_FIELDS = [
  "clientId", "lastReviewedAt", "lastReviewedBy", "lastUpdatedAt", "lastUpdatedBy",
  "callRecordingsSubfolderId", "callTranscriptsSubfolderId", "id", "createdAt",
];

function testWhitelistLockstep(): void {
  const shapeKeys = Object.keys(updateCommandPanelSchema.shape).sort();
  assert.deepEqual(
    shapeKeys,
    [...EXPECTED_PANEL_FIELDS].sort(),
    "updateCommandPanelSchema keys = exactly the 42 operator-editable panel fields",
  );
  for (const protectedField of SERVER_MANAGED_FIELDS) {
    assert.ok(
      !(protectedField in updateCommandPanelSchema.shape),
      `server-managed field "${protectedField}" is not in the update schema`,
    );
  }
  console.log("  ok  (1) whitelist lockstep: schema shape = 42 editable fields, server-managed excluded");
}

async function main(): Promise<void> {
  testWhitelistLockstep();

  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES
          (${CEO_ID}, 'ceo', 'ceo', ${`${TAG}-ceo`}),
          (${SALES_ID}, 'sales', 'sales', ${`${TAG}-sales`})
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);
      // Users live only in the isolated sandbox schema; pre-register them
      // with requireAuth's registry so admission uses the profile directly
      // rather than missing the public lookup and JIT-provisioning a stray
      // public row. The route re-reads role via storage.getUser.
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo", authorityLevel: "ceo" });
      __test_markUserReconciled(SALES_ID, { id: SALES_ID, role: "sales", authorityLevel: "sales" });
      await isoDb.execute(sql`
        INSERT INTO clients (id, firm_name, products)
        VALUES
          (${CLIENT_A}, ${`${TAG} Firm A`}, ARRAY['gbp']::text[]),
          (${CLIENT_B}, ${`${TAG} Firm B`}, ARRAY['gbp']::text[])
      `);
      await isoDb.execute(sql`
        INSERT INTO raw_communication_records (id, source_type, title, timestamp, client_id)
        VALUES
          (${RAW_LINK}, 'zoom', ${`${TAG} unlinked call`}, NOW(), NULL),
          (${RAW_OTHER}, 'zoom', ${`${TAG} other-client call`}, NOW(), ${CLIENT_B}),
          (${RAW_RER_1}, 'zoom', ${`${TAG} rer call 1`}, NOW(), NULL),
          (${RAW_RER_2}, 'zoom', ${`${TAG} rer call 2`}, NOW(), NULL)
      `);

      async function readPanel(clientId: string): Promise<any> {
        const res: any = await isoDb.execute(sql`
          SELECT * FROM command_panels WHERE client_id = ${clientId}
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return rows[0];
      }
      async function countRows(table: "command_panel_history" | "command_panel_versions" | "command_panel_key_calls" | "command_panel_rer_recordings"): Promise<number> {
        const res: any = await isoDb.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM ${table}`));
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return Number(rows[0]?.n ?? 0);
      }
      async function readRaw(id: string): Promise<any> {
        const res: any = await isoDb.execute(sql`
          SELECT id, client_id, match_status, match_method FROM raw_communication_records WHERE id = ${id}
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return rows[0];
      }

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      const panelPath = `/api/clients/${CLIENT_A}/command-panel`;
      try {
        // ── (2a) First save: exact CommandPanel.tsx shape + productTypes inheritance ──
        {
          const r = await send(baseUrl, "PUT", panelPath, {
            annualGoals: "Grow signed cases 20%",
            googleAdsBudget: 2500,
            priorityMarkets: ["Dallas", "Austin"],
            currentBottleneck: "intake_capacity",
            budgetPosture: "moderate",
            externalSystemLinks: [{ label: "CRM", url: "https://crm.example.com" }],
            reason: "initial setup",
          });
          assert.equal(r.status, 200, "valid first PUT → 200");
          assert.equal(r.body.clientId, CLIENT_A, "response is the panel entity");
          const row = await readPanel(CLIENT_A);
          assert.equal(row.annual_goals, "Grow signed cases 20%");
          assert.equal(Number(row.google_ads_budget), 2500, "numeric budget persisted as number");
          assert.deepEqual(row.priority_markets, ["Dallas", "Austin"]);
          assert.equal(row.current_bottleneck, "intake_capacity");
          assert.equal(row.budget_posture, "moderate");
          assert.deepEqual(row.external_system_links, [{ label: "CRM", url: "https://crm.example.com" }]);
          assert.equal(row.last_updated_by, CEO_ID, "lastUpdatedBy stamped from session");
          assert.deepEqual(
            row.product_types,
            normalizeProductList(["gbp"]),
            "first save inherits productTypes from clients.products",
          );

          const hist: any = await isoDb.execute(sql`
            SELECT field_name, old_value, new_value, reason FROM command_panel_history
            WHERE client_id = ${CLIENT_A} AND field_name = 'annualGoals'
          `);
          const histRows = Array.isArray(hist) ? hist : hist?.rows ?? [];
          assert.equal(histRows.length, 1, "new-panel history row written");
          assert.equal(histRows[0].old_value, null);
          assert.equal(histRows[0].new_value, "Grow signed cases 20%");
          assert.equal(histRows[0].reason, "initial setup", "audit reason recorded");
          console.log("  ok  (2a) baseline first PUT: client shape persists, inheritance + history intact");
        }

        // ── (2b) Explicit null clears; union "other:" bottleneck accepted ──
        {
          const r = await send(baseUrl, "PUT", panelPath, {
            annualGoals: null,
            currentBottleneck: "other: intake chaos",
            reason: "clear goals",
          });
          assert.equal(r.status, 200, "null-clear PUT → 200");
          const row = await readPanel(CLIENT_A);
          assert.equal(row.annual_goals, null, "explicit null clears the field");
          assert.equal(row.current_bottleneck, "other: intake chaos", 'union "other:*" branch still accepted');
          const hist: any = await isoDb.execute(sql`
            SELECT old_value, new_value FROM command_panel_history
            WHERE client_id = ${CLIENT_A} AND field_name = 'annualGoals' AND old_value IS NOT NULL
          `);
          const histRows = Array.isArray(hist) ? hist : hist?.rows ?? [];
          assert.equal(histRows.length, 1, "clear recorded in history");
          assert.equal(histRows[0].new_value, null);
          console.log("  ok  (2b) explicit-null clear + other:* union preserved");
        }

        // ── (3a) Protected/unknown fields stripped, never persisted ────────
        {
          const before = await readPanel(CLIENT_A);
          const r = await send(baseUrl, "PUT", panelPath, {
            clientId: CLIENT_B,
            id: "evil-id",
            callRecordingsSubfolderId: "evil-folder",
            callTranscriptsSubfolderId: "evil-folder-2",
            lastUpdatedBy: "evil-user",
            lastReviewedBy: "evil-reviewer",
            lastReviewedAt: "2020-01-01T00:00:00.000Z",
            totallyUnknownField: { sneaky: true },
            longTermGoals: "Become market leader",
          });
          assert.equal(r.status, 200, "stripped fields do not fail the request (family convention)");
          const row = await readPanel(CLIENT_A);
          assert.equal(row.id, before.id, "panel id unchanged");
          assert.equal(row.client_id, CLIENT_A, "clientId cannot be redirected via body");
          assert.equal(row.call_recordings_subfolder_id, before.call_recordings_subfolder_id, "server-managed subfolder id untouched");
          assert.equal(row.call_transcripts_subfolder_id, before.call_transcripts_subfolder_id, "server-managed transcript subfolder untouched");
          assert.equal(row.last_updated_by, CEO_ID, "lastUpdatedBy comes from the session, not the body");
          assert.equal(row.last_reviewed_by, before.last_reviewed_by, "lastReviewedBy untouched");
          assert.equal(row.long_term_goals, "Become market leader", "whitelisted field in the same request applied");
          const hist: any = await isoDb.execute(sql`
            SELECT COUNT(*)::int AS n FROM command_panel_history
            WHERE client_id = ${CLIENT_A} AND field_name IN ('clientId', 'lastUpdatedBy', 'lastReviewedBy', 'callRecordingsSubfolderId', 'totallyUnknownField')
          `);
          const histRows = Array.isArray(hist) ? hist : hist?.rows ?? [];
          assert.equal(Number(histRows[0].n), 0, "no history rows minted for stripped fields");
          console.log("  ok  (3a) protected + unknown PUT fields stripped from persistence and history");
        }

        // ── (3b) Type/enum-invalid values → 400 issues[], zero write ───────
        {
          const before = await readPanel(CLIENT_A);
          const historyBefore = await countRows("command_panel_history");
          const versionsBefore = await countRows("command_panel_versions");
          const badBodies: Array<[string, unknown, string]> = [
            ["string budget", { googleAdsBudget: "2500" }, "googleAdsBudget"],
            ["string productTypes", { productTypes: "gbp" }, "productTypes"],
            ["string revenue goal", { annualRevenueGoal: "one million" }, "annualRevenueGoal"],
            ["unknown budgetPosture", { budgetPosture: "yolo" }, "budgetPosture"],
            ["plain bottleneck string", { currentBottleneck: "not-an-option" }, "currentBottleneck"],
            ["non-string reason", { reason: 42, annualGoals: "x" }, "reason"],
          ];
          for (const [label, body, path] of badBodies) {
            const r = await send(baseUrl, "PUT", panelPath, body);
            assert.equal(r.status, 400, `${label} → 400`);
            assert.ok(Array.isArray(r.body.error), `${label}: error envelope is the issues array`);
            assert.ok(
              r.body.error.some((i: any) => i.path?.[0] === path),
              `${label}: issue names the offending field`,
            );
          }
          assert.deepEqual(await readPanel(CLIENT_A), before, "panel row byte-identical after every rejection");
          assert.equal(await countRows("command_panel_history"), historyBefore, "no history rows from rejected bodies");
          assert.equal(await countRows("command_panel_versions"), versionsBefore, "no version rows from rejected bodies");
          console.log("  ok  (3b) invalid PUT values → 400 { error: issues[] }, no partial write");
        }

        // ── (3c) Array elements are coerced to strings, matching what the
        // pre-validation path stored via the pg driver for text[] columns. ──
        {
          const r = await send(baseUrl, "PUT", panelPath, { secondaryOwnerIds: [1, 2] });
          assert.equal(r.status, 200, "numeric array elements accepted (coerced)");
          const row = await readPanel(CLIENT_A);
          assert.deepEqual(row.secondary_owner_ids, ["1", "2"], "elements stored as strings");
          console.log("  ok  (3c) text[] element coercion pinned (schema matches legacy driver behavior)");
        }

        // ── (2c) productTypes sync to clients.products preserved ──────────
        {
          const r = await send(baseUrl, "PUT", panelPath, { productTypes: ["google_ads", "gbp"] });
          assert.equal(r.status, 200);
          const clientRes: any = await isoDb.execute(sql`SELECT products FROM clients WHERE id = ${CLIENT_A}`);
          const clientRows = Array.isArray(clientRes) ? clientRes : clientRes?.rows ?? [];
          assert.deepEqual(
            clientRows[0].products,
            normalizeProductList(["google_ads", "gbp"]),
            "clients.products mirrors the canonical panel productTypes",
          );
          console.log("  ok  (2c) productTypes → clients.products sync unchanged");
        }

        // ── (2e) Task #4510: productTypes canonicalized at the write boundary ──
        {
          // Legacy-alias shape pinned from the prod replica (2026-08-11): 26
          // command_panels rows store plural "webinars" (the only non-canonical
          // value in prod), e.g. ["gbp","google_ads","lsa","webinars"] — the
          // shape that made Webinars unremovable from the edit UI because the
          // panel used to persist the array raw.
          const r1 = await send(baseUrl, "PUT", panelPath, { productTypes: ["gbp", "google_ads", "lsa", "webinars"] });
          assert.equal(r1.status, 200, "legacy plural webinars accepted");
          let row = await readPanel(CLIENT_A);
          assert.deepEqual(
            row.product_types,
            ["gbp", "google_ads", "lsa", "webinar"],
            "stored panel value healed to canonical ids (alias never persisted again)",
          );
          const mirror1: any = await isoDb.execute(sql`SELECT products FROM clients WHERE id = ${CLIENT_A}`);
          const mirror1Rows = Array.isArray(mirror1) ? mirror1 : mirror1?.rows ?? [];
          assert.deepEqual(
            mirror1Rows[0].products,
            ["gbp", "google_ads", "lsa", "webinar"],
            "clients.products mirror carries the same canonical list",
          );
          const aliasHist: any = await isoDb.execute(sql`
            SELECT COUNT(*)::int AS n FROM command_panel_history
            WHERE client_id = ${CLIENT_A} AND field_name = 'productTypes' AND new_value LIKE '%webinars%'
          `);
          const aliasHistRows = Array.isArray(aliasHist) ? aliasHist : aliasHist?.rows ?? [];
          assert.equal(Number(aliasHistRows[0].n), 0, "history records the canonical value, never the raw alias");

          // Prod artifact (4 rows): a failed uncheck attempt left BOTH the alias
          // and the canonical id, e.g. ["gbp","webinars","webinar"].
          const r2 = await send(baseUrl, "PUT", panelPath, { productTypes: ["gbp", "webinars", "webinar"] });
          assert.equal(r2.status, 200, "alias+canonical double entry accepted");
          row = await readPanel(CLIENT_A);
          assert.deepEqual(row.product_types, ["gbp", "webinar"], "double entry dedupes to one canonical id");

          // Unknown values → 400 INVALID_PRODUCTS (same envelope as the clients
          // routes) with no write at all — including other fields in the body.
          const before = await readPanel(CLIENT_A);
          const historyBefore = await countRows("command_panel_history");
          const versionsBefore = await countRows("command_panel_versions");
          const rBad = await send(baseUrl, "PUT", panelPath, {
            productTypes: ["gbp", "webinarz"],
            annualGoals: "must not persist",
          });
          assert.equal(rBad.status, 400, "unknown product value → 400");
          assert.equal(rBad.body.code, "INVALID_PRODUCTS", "same code the clients routes use");
          assert.deepEqual(rBad.body.invalid, ["webinarz"], "invalid list names the offending value");
          assert.ok(
            Array.isArray(rBad.body.allowed) && rBad.body.allowed.includes("webinar"),
            "allowed list is the canonical taxonomy",
          );
          assert.deepEqual(await readPanel(CLIENT_A), before, "no write on INVALID_PRODUCTS (whole body rejected)");
          assert.equal(await countRows("command_panel_history"), historyBefore, "no history rows from the rejected body");
          assert.equal(await countRows("command_panel_versions"), versionsBefore, "no version rows from the rejected body");

          // Explicit null still clears; empty list is still allowed (the panel
          // PUT deliberately has no "at least one product" rule — that rule
          // belongs to the clients PATCH).
          const rNull = await send(baseUrl, "PUT", panelPath, { productTypes: null });
          assert.equal(rNull.status, 200, "explicit null → 200");
          row = await readPanel(CLIENT_A);
          assert.equal(row.product_types, null, "explicit null still clears the column");
          const rEmpty = await send(baseUrl, "PUT", panelPath, { productTypes: [] });
          assert.equal(rEmpty.status, 200, "empty product list → 200");
          row = await readPanel(CLIENT_A);
          assert.deepEqual(row.product_types, [], "empty list persisted as before");
          console.log("  ok  (2e) Task #4510: aliases heal to canonical, unknown values rejected with INVALID_PRODUCTS and no write");
        }

        // ── (2d) Empty body PUT stays a 200 stamp-only upsert ─────────────
        {
          const before = await readPanel(CLIENT_A);
          const r = await send(baseUrl, "PUT", panelPath, {});
          assert.equal(r.status, 200, "empty body {} → 200");
          const row = await readPanel(CLIENT_A);
          assert.equal(row.annual_goals, before.annual_goals, "no field changed by empty body");
          assert.deepEqual(row.product_types, before.product_types, "productTypes untouched by empty body");
          console.log("  ok  (2d) empty-body PUT preserved (stamp-only upsert)");
        }

        // ── (6a) Auth contracts: sales write → 403, unknown client → 404 ──
        {
          const before = await readPanel(CLIENT_A);
          const r403 = await send(baseUrl, "PUT", panelPath, { annualGoals: "sales edit" }, { "x-test-user": SALES_ID });
          assert.equal(r403.status, 403, "sales write → 403");
          assert.equal(r403.body.error, "Sales role has read-only access to command panels");
          assert.deepEqual(await readPanel(CLIENT_A), before, "403 leaves the panel untouched");

          const r404 = await send(baseUrl, "PUT", `/api/clients/no-such-client/command-panel`, { annualGoals: "x" });
          assert.equal(r404.status, 404, "unknown client → 404");
          assert.equal(r404.body.error, "Client not found");
          console.log("  ok  (6a) PUT auth/not-found contracts unchanged");
        }

        // ── (4) key-calls POST ─────────────────────────────────────────────
        const keyCallsPath = `${panelPath}/key-calls`;
        {
          // (4a) valid, no recording id.
          const r1 = await send(baseUrl, "POST", keyCallsPath, { callType: "discovery" });
          assert.equal(r1.status, 200, "callType-only body → 200");
          assert.equal(r1.body.callType, "discovery");
          assert.equal(r1.body.rawCommunicationRecordId, null, "absent recording id stored as null");

          // (4b) empty-string recording id → null (legacy || null coercion).
          const r2 = await send(baseUrl, "POST", keyCallsPath, { callType: "demo", rawCommunicationRecordId: "" });
          assert.equal(r2.status, 200, "empty-string recording id → 200");
          assert.equal(r2.body.rawCommunicationRecordId, null, "empty string coerced to null");

          // (4c) unknown extra field stripped.
          const r3 = await send(baseUrl, "POST", keyCallsPath, { callType: "onboarding", futureField: true });
          assert.equal(r3.status, 200, "unknown extra field stripped, request succeeds");

          // (4d) invalid/missing callType → exact legacy envelope, no row.
          const kcBefore = await countRows("command_panel_key_calls");
          for (const body of [{ callType: "bogus" }, {}, { callType: 7 }]) {
            const r = await send(baseUrl, "POST", keyCallsPath, body);
            assert.equal(r.status, 400, `bad callType ${JSON.stringify(body)} → 400`);
            assert.equal(r.body.error, "Invalid callType", "legacy envelope preserved verbatim");
          }
          assert.equal(await countRows("command_panel_key_calls"), kcBefore, "no key-call rows from rejected callType bodies");

          // (4e) non-string recording id → 400 issues[] BEFORE any link/upsert.
          const r4 = await send(baseUrl, "POST", keyCallsPath, { callType: "handoff", rawCommunicationRecordId: 42 });
          assert.equal(r4.status, 400, "non-string recording id → 400");
          assert.ok(Array.isArray(r4.body.error), "recording-id type failure reports the issues envelope");
          assert.ok(r4.body.error.some((i: any) => i.path?.[0] === "rawCommunicationRecordId"));
          assert.equal(await countRows("command_panel_key_calls"), kcBefore, "rejected before upsert — no row");

          // (4f) valid link path still works end-to-end.
          const r5 = await send(baseUrl, "POST", keyCallsPath, { callType: "handoff", rawCommunicationRecordId: RAW_LINK });
          assert.equal(r5.status, 200, "linkable recording id → 200");
          assert.equal(r5.body.rawCommunicationRecordId, RAW_LINK);
          const linked = await readRaw(RAW_LINK);
          assert.equal(linked.client_id, CLIENT_A, "raw record linked to the panel's client");
          assert.equal(linked.match_status, "matched");
          assert.equal(linked.match_method, "manual_command_panel");

          // (4g) cross-client recording → legacy 400; unknown recording → legacy 404.
          const rCross = await send(baseUrl, "POST", keyCallsPath, { callType: "demo", rawCommunicationRecordId: RAW_OTHER });
          assert.equal(rCross.status, 400);
          assert.equal(rCross.body.error, "Recording belongs to a different client and cannot be assigned");
          const rGone = await send(baseUrl, "POST", keyCallsPath, { callType: "demo", rawCommunicationRecordId: "no-such-raw" });
          assert.equal(rGone.status, 404);
          assert.equal(rGone.body.error, "Recording not found");

          // (4h) no panel yet (client B) → legacy 404.
          const rNoPanel = await send(baseUrl, "POST", `/api/clients/${CLIENT_B}/command-panel/key-calls`, { callType: "discovery" });
          assert.equal(rNoPanel.status, 404);
          assert.equal(rNoPanel.body.error, "Command panel not found. Create one first.");
          console.log("  ok  (4) key-calls: valid shapes, legacy envelopes, and reject-before-mutation all preserved");
        }

        // ── (5) RER recordings POST ────────────────────────────────────────
        const rerPath = `${panelPath}/rer-recordings`;
        {
          // (5a) valid body links + creates.
          const r1 = await send(baseUrl, "POST", rerPath, { rawCommunicationRecordId: RAW_RER_1, reportingMonth: "2026-07" });
          assert.equal(r1.status, 200, "valid RER body → 200");
          assert.equal(r1.body.reportingMonth, "2026-07");
          assert.equal((await readRaw(RAW_RER_1)).client_id, CLIENT_A, "raw record linked");

          // (5b) trim coercion preserved (ids arrive space-padded from copy/paste).
          const r2 = await send(baseUrl, "POST", rerPath, {
            rawCommunicationRecordId: `  ${RAW_RER_2}  `,
            reportingMonth: " 2026-08 ",
          });
          assert.equal(r2.status, 200, "space-padded ids trimmed and accepted");
          assert.equal(r2.body.rawCommunicationRecordId, RAW_RER_2, "stored id is the trimmed value");
          assert.equal(r2.body.reportingMonth, "2026-08", "stored month is the trimmed value");

          // (5c) duplicate contract unchanged.
          const r3 = await send(baseUrl, "POST", rerPath, { rawCommunicationRecordId: RAW_RER_1, reportingMonth: "2026-07" });
          assert.equal(r3.status, 200, "duplicate assignment → 200");
          assert.equal(r3.body.duplicate, true, "duplicate flag preserved");

          // (5d) every malformed shape → the exact legacy fixed message, no row.
          const rerBefore = await countRows("command_panel_rer_recordings");
          const rawBefore = await readRaw(RAW_OTHER);
          const malformed: unknown[] = [
            {},
            { rawCommunicationRecordId: RAW_OTHER },
            { reportingMonth: "2026-07" },
            { rawCommunicationRecordId: "   ", reportingMonth: "2026-07" },
            { rawCommunicationRecordId: RAW_OTHER, reportingMonth: "   " },
            { rawCommunicationRecordId: 5, reportingMonth: "2026-07" },
            { rawCommunicationRecordId: RAW_OTHER, reportingMonth: { month: "2026-07" } },
          ];
          for (const body of malformed) {
            const r = await send(baseUrl, "POST", rerPath, body);
            assert.equal(r.status, 400, `malformed RER body ${JSON.stringify(body)} → 400`);
            assert.equal(
              r.body.error,
              "rawCommunicationRecordId and reportingMonth are required",
              "legacy fixed-message envelope preserved for every malformed shape",
            );
          }
          assert.equal(await countRows("command_panel_rer_recordings"), rerBefore, "no RER rows from rejected bodies");
          assert.deepEqual(await readRaw(RAW_OTHER), rawBefore, "raw record untouched by rejected bodies");

          // (5e) no panel yet (client B) → legacy 404.
          const rNoPanel = await send(baseUrl, "POST", `/api/clients/${CLIENT_B}/command-panel/rer-recordings`, {
            rawCommunicationRecordId: RAW_OTHER,
            reportingMonth: "2026-07",
          });
          assert.equal(rNoPanel.status, 404);
          assert.equal(rNoPanel.body.error, "Command panel not found. Create one first.");
          console.log("  ok  (5) RER: trim + duplicate contracts kept, legacy 400 envelope for all malformed shapes, no partial writes");
        }

        // The link path fires a void recordCommandPanelClaim audit stamp after
        // responding; give it a beat to finish its (empty) decision lookup
        // before the schema is torn down.
        await new Promise((resolve) => setTimeout(resolve, 250));
      } finally {
        __test_resetReconciledUsers();
        server.close();
      }
    },
    {
      tables: [
        "users",
        "clients",
        "command_panels",
        "command_panel_history",
        "command_panel_versions",
        "command_panel_key_calls",
        "command_panel_rer_recordings",
        "raw_communication_records",
        "agent_match_decisions",
      ],
    },
  );
}

main().then(
  () => {
    console.log("command-panel-endpoint-validation: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("command-panel-endpoint-validation: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
