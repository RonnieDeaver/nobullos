/* test-registration
{
   "name": "Service Desk import-departments route — reconciles known departments, reports unknown options, preserves mappings, rename refresh, 400/401/403 gates (Tasks #3540, #3616, #5232)",
  "regression": true,
  "smoke": true,
   "smokeReason": "Tasks #3540/#5232: route-level test for POST /api/service-desk/setup/import-departments. Covers reconciliation, unknown-option reporting/no resurrection, mapping preservation, and 400/401/403 auth gates. ClickUp API is stubbed via a resolve-hook loader (sd-import-departments-loader.mjs); no real network calls. DB work runs in runInIsolatedSchema.",
  "extraNodeArgs": [
    "--import",
    "./tests/sd-import-departments-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Route-level test for POST /api/service-desk/setup/import-departments.
 *
 * Covers:
 *   (A) Reports unknown remote options without creating a local department or
 *       map entry, so a removed ClickUp option cannot resurrect a department.
 *   (B) Matches existing departments by case-insensitive name without duplicating.
 *   (C) Preserves pre-existing manual mappings — existing entries in departmentOptionIds
 *       are never overwritten even when the ClickUp option label would otherwise match a
 *       different department.
 *   (D) Returns 400 when the Department field UUID is not bound in the config.
 *   (E) Non-CEO user (account_manager) is rejected with 403.
 *   (F) Unauthenticated request is rejected with 401.
 *   (G) Finds the Department field when it is returned only by the Space-level endpoint
 *       (i.e. inherited — not visible at List level) and reconciles its options correctly.
 *   (H) Returns the "not found at any level" note when no hierarchy level has the field.
 *   (I) Task #3616 — an already-mapped option renamed in ClickUp gets its NoBull
 *       department name refreshed (with "Option N" artifact stripping), the mapping
 *       itself is untouched, and the response reports renamed/renamedCount. Idempotent.
 *   (J) Task #3616 — POST /setup/refresh-option-names refreshes department AND
 *       request-type names for already-mapped options without creating rows or
 *       changing mappings; the name-keyed requestTypeOptionIds map is re-persisted.
 *
 * Uses pinGetDbForCrossAsync so Express handlers outside the sandbox ALS scope
 * read the cloned tables, not live public.*.
 * ClickUp API calls are stubbed via sd-import-departments-loader.mjs, which
 * redirects clickUpClient to sd-import-departments-cu-stub.mjs (reads
 * globalThis.__sdImportDeptCu*Fields) and clickUpIntegration to
 * sd-import-departments-token-stub.mjs (always returns a token for CEO_ID).
 *
 * Registered in run-all.ts with:
 *   extraNodeArgs: ["--import", "./tests/sd-import-departments-setup.mjs"]
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

import { registerServiceDeskRoutes } from "../server/routes/serviceDesk";
import { sdListMapping, sdDepartments } from "@shared/schema";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

// ── Constants ─────────────────────────────────────────────────────────────────

const CEO_ID = "test-3540-ceo";
const AM_ID = "test-3540-am";
const LIST_ID = "list-3540";
const SPACE_ID = "space-3543";
const DEPT_FIELD_ID = "cf-dept-3540";

// ── App factory ───────────────────────────────────────────────────────────────

let activeUserId: string | null = CEO_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a
    // string authenticates as that user id; null models an anonymous
    // request (→ 401). Acting users are seeded in the isolated sandbox
    // schema, so pre-register their profiles via __test_markUserReconciled.
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

async function postImport(baseUrl: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/service-desk/setup/import-departments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed actors ──────────────────────────────────────────────────────
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${CEO_ID}, 'ceo', 'CEO 3540')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${AM_ID}, 'account_manager', 'AM 3540')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);

      // Pre-register the acting users so requireAuth resolves them from the
      // sandbox seed instead of JIT-provisioning a public-schema row.
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo", firstName: "CEO 3540" });
      __test_markUserReconciled(AM_ID, { id: AM_ID, role: "account_manager", firstName: "AM 3540" });

      // ── Seed a configured list mapping ───────────────────────────────────
      // Include clickupSpaceId so inherited space-level fields can be fetched
      // in test (G).  Pre-existing manual mapping: opt-existing-mapped → dept-manually-bound-3540.
      await db.insert(sdListMapping).values({
        clickupListId: LIST_ID,
        clickupSpaceId: SPACE_ID,
        fieldDepartmentId: DEPT_FIELD_ID,
        setupStep: "complete",
        departmentOptionIds: {
          "opt-existing-mapped-3540": "dept-manually-bound-3540",
          // Models a mapping whose local department was hard-deleted. Import
          // must remove the stale entry and report the remote option, never
          // recreate a substitute.
          "opt-retired-3540": "dept-retired-3540",
        },
      });

      // ── Seed existing departments ────────────────────────────────────────
      await db.insert(sdDepartments).values([
        { id: "dept-marketing-3540", name: "Marketing", sortOrder: 0 },
        // "Finance" is the existing dept that opt-existing-mapped maps to manually.
        { id: "dept-manually-bound-3540", name: "Finance", sortOrder: 1 },
          { id: "dept-operations-3543", name: "Operations", sortOrder: 2 },
      ]);

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      try {
        // ── (E) account_manager → 403 ────────────────────────────────────
        activeUserId = AM_ID;
        const amResp = await postImport(baseUrl);
        assert.equal(amResp.status, 403, `account_manager must get 403 (got ${amResp.status})`);
        console.log("  ✓ E: account_manager rejected with 403");

        // ── (F) unauthenticated → 401 ────────────────────────────────────
        activeUserId = null;
        const anonResp = await postImport(baseUrl);
        assert.equal(anonResp.status, 401, `unauthenticated must get 401 (got ${anonResp.status})`);
        console.log("  ✓ F: unauthenticated request rejected with 401");

        // Switch to CEO for the rest of the assertions
        activeUserId = CEO_ID;

        // ── (D) 400 when Department field UUID is not bound ───────────────
        await db.execute(sql`
          UPDATE sd_list_mapping SET field_department_id = NULL WHERE clickup_list_id = ${LIST_ID}
        `);
        const noFieldResp = await postImport(baseUrl);
        assert.equal(noFieldResp.status, 400, `missing dept field UUID must return 400 (got ${noFieldResp.status})`);
        assert.ok(
          (noFieldResp.body?.error ?? "").includes("Department field UUID"),
          `400 body must mention 'Department field UUID' (got: ${noFieldResp.body?.error})`,
        );
        console.log("  ✓ D: 400 when Department field UUID is not bound");

        // Restore the dept field binding
        await db.execute(sql`
          UPDATE sd_list_mapping SET field_department_id = ${DEPT_FIELD_ID} WHERE clickup_list_id = ${LIST_ID}
        `);

        // ── Set up ClickUp stub fields for functional assertions ──────────
        // Three options:
        //   opt-marketing-3540:     name="Marketing" → matches existing dept by name
        //   opt-existing-mapped-3540: name="Finance" → already mapped manually (preserved)
        //   opt-newdept-3540:       name="Legal"     → no local match → report unknown
        //   opt-retired-3540:       stale deleted-local mapping → report + detach
        (globalThis as any).__sdImportDeptCuFields = [
          {
            id: DEPT_FIELD_ID,
            type_config: {
              options: [
                { id: "opt-marketing-3540", name: "Marketing", orderindex: 0 },
                { id: "opt-existing-mapped-3540", name: "Finance", orderindex: 1 },
                { id: "opt-newdept-3540", name: "Legal", orderindex: 2 },
                { id: "opt-retired-3540", name: "Retired Department", orderindex: 3 },
              ],
            },
          },
        ];

        // ── (A) + (B) + (C): full import run ─────────────────────────────
        const importResp = await postImport(baseUrl);
        assert.equal(
          importResp.status,
          200,
          `import must return 200 (got ${importResp.status}: ${JSON.stringify(importResp.body)})`,
        );

        const body = importResp.body;
        assert.ok(Array.isArray(body.matched), "body.matched must be an array");
        assert.ok(Array.isArray(body.alreadyMapped), "body.alreadyMapped must be an array");
        assert.ok(Array.isArray(body.unknown), "body.unknown must be an array");

        // (A) "Legal" must stay unknown: imports cannot create NoBull
        // departments or map a remote option that no longer has one.
        assert.equal(body.unknownCount, 2, `unknownCount must be 2 (got ${body.unknownCount})`);
        assert.deepEqual(
          body.unknown,
          [
            { optionId: "opt-newdept-3540", optionName: "Legal", reason: "no_local_department" },
            { optionId: "opt-retired-3540", optionName: "Retired Department", reason: "stale_mapping" },
          ],
          "unknown and stale deleted-local options must be surfaced for review",
        );
        const legalRows = await db.execute(sql`
          SELECT id, name FROM sd_departments WHERE name = 'Legal' LIMIT 1
        `);
        assert.equal(legalRows.rows.length, 0, "'Legal' must not be created in the DB");
        console.log("  ✓ A: unknown 'Legal' option is reported and cannot create a department");

        // (B) "Marketing" should be MATCHED to existing by name (no new row)
        assert.equal(body.matchedCount, 1, `matchedCount must be 1 (got ${body.matchedCount})`);
        const matchedEntry = body.matched.find((e: any) => e.optionName === "Marketing");
        assert.ok(matchedEntry, "matched array must contain a 'Marketing' entry");
        assert.equal(
          matchedEntry.departmentId,
          "dept-marketing-3540",
          `Marketing must map to existing dept id (got ${matchedEntry.departmentId})`,
        );

        // Confirm no duplicate "Marketing" row was created
        const marketingRows = await db.execute(sql`
          SELECT id FROM sd_departments WHERE LOWER(name) = 'marketing'
        `);
        assert.equal(marketingRows.rows.length, 1, "no duplicate Marketing department created");
        console.log("  ✓ B: existing department 'Marketing' matched by name, no duplicate row");

        // (C) opt-existing-mapped-3540 must be in alreadyMapped and still point to the original dept
        assert.equal(
          body.alreadyMappedCount,
          1,
          `alreadyMappedCount must be 1 (got ${body.alreadyMappedCount})`,
        );
        const alreadyEntry = body.alreadyMapped.find((e: any) => e.optionId === "opt-existing-mapped-3540");
        assert.ok(alreadyEntry, "alreadyMapped must contain opt-existing-mapped-3540");
        assert.equal(
          alreadyEntry.departmentId,
          "dept-manually-bound-3540",
          "pre-existing manual mapping must be preserved unchanged",
        );

        // Verify only known local departments are persisted in the DB map.
        const mapRows = await db.execute(sql`
          SELECT department_option_ids FROM sd_list_mapping WHERE clickup_list_id = ${LIST_ID} LIMIT 1
        `);
        assert.equal(mapRows.rows.length, 1, "sd_list_mapping row must exist");
        const savedMap = mapRows.rows[0].department_option_ids as Record<string, string>;
        assert.equal(
          savedMap["opt-existing-mapped-3540"],
          "dept-manually-bound-3540",
          "manual mapping preserved in DB",
        );
        assert.equal(
          savedMap["opt-marketing-3540"],
          "dept-marketing-3540",
          "Marketing option mapped to existing dept in DB",
        );
        assert.equal(savedMap["opt-newdept-3540"], undefined, "unknown Legal option must not be mapped");
        assert.equal(savedMap["opt-retired-3540"], undefined, "stale deleted-local map must be removed");
        console.log("  ✓ C: pre-existing manual mapping preserved; only known departments are mapped");

        // ── Idempotency: second run → 0 matched, 2 alreadyMapped, 2 unknown ──
        const secondResp = await postImport(baseUrl);
        assert.equal(secondResp.status, 200, `second import must return 200 (got ${secondResp.status})`);
        assert.equal(secondResp.body.matchedCount, 0, "second run: matchedCount must be 0");
        assert.equal(secondResp.body.alreadyMappedCount, 2, "second run: both known options already mapped");
        assert.equal(secondResp.body.unknownCount, 2, "second run: unknown options remain non-creating after stale map cleanup");
        console.log("  ✓ Idempotency: repeated import preserves the no-resurrection result");

        // ── (I) Task #3616: rename refresh for already-mapped options ─────
        // Rename the Marketing option in ClickUp (with an "Option N" import
        // artifact prefix). The mapped dept must be renamed, mapping untouched.
        (globalThis as any).__sdImportDeptCuFields = [
          {
            id: DEPT_FIELD_ID,
            type_config: {
              options: [
                { id: "opt-marketing-3540", name: "Option 1Growth Marketing", orderindex: 0 },
                { id: "opt-existing-mapped-3540", name: "Finance", orderindex: 1 },
                { id: "opt-newdept-3540", name: "Legal", orderindex: 2 },
                { id: "opt-retired-3540", name: "Retired Department", orderindex: 3 },
              ],
            },
          },
        ];
        const renameResp = await postImport(baseUrl);
        assert.equal(renameResp.status, 200, `rename import must return 200 (got ${renameResp.status})`);
        assert.equal(renameResp.body.renamedCount, 1, `renamedCount must be 1 (got ${renameResp.body.renamedCount})`);
        assert.equal(renameResp.body.unknownCount, 2, "rename run: unknown options remain unknown");
        const renEntry = renameResp.body.renamed[0];
        assert.equal(renEntry.departmentId, "dept-marketing-3540", "renamed entry targets the mapped dept");
        assert.equal(renEntry.oldName, "Marketing");
        assert.equal(renEntry.newName, "Growth Marketing", "artifact prefix must be stripped from the new name");

        const renamedRow = await db.execute(sql`
          SELECT name FROM sd_departments WHERE id = 'dept-marketing-3540'
        `);
        assert.equal(renamedRow.rows[0].name, "Growth Marketing", "DB dept name refreshed");

        // Mapping untouched: option still points at the same dept; manual mapping preserved.
        const renMapRows = await db.execute(sql`
          SELECT department_option_ids FROM sd_list_mapping WHERE clickup_list_id = ${LIST_ID} LIMIT 1
        `);
        const renMap = renMapRows.rows[0].department_option_ids as Record<string, string>;
        assert.equal(renMap["opt-marketing-3540"], "dept-marketing-3540", "mapping unchanged after rename");
        assert.equal(renMap["opt-existing-mapped-3540"], "dept-manually-bound-3540", "manual mapping untouched");

        // Idempotent: second run renames nothing.
        const renameResp2 = await postImport(baseUrl);
        assert.equal(renameResp2.body.renamedCount, 0, "second rename run: renamedCount must be 0");
        console.log("  ✓ I: renamed ClickUp option refreshes mapped dept name; mapping untouched; idempotent");

        // ── (J) Task #3616: /setup/refresh-option-names (dept + request type) ──
        // Bind a Request Type field, seed a mapped request type, rename both
        // options in ClickUp, and confirm the lightweight endpoint refreshes
        // names only — no new rows, mappings preserved, name-keyed rt map re-persisted.
        const RT_FIELD_ID = "cf-rt-3616";
        await db.execute(sql`
          UPDATE sd_list_mapping
          SET field_request_type_id = ${RT_FIELD_ID},
              request_type_option_ids = '{"opt-rt-3616": "SEO Audit"}'
          WHERE clickup_list_id = ${LIST_ID}
        `);
        await db.execute(sql`
          INSERT INTO sd_request_types (id, name, active) VALUES ('rt-3616', 'SEO Audit', true)
        `);
        (globalThis as any).__sdImportDeptCuFields = [
          {
            id: DEPT_FIELD_ID,
            type_config: {
              options: [
                { id: "opt-marketing-3540", name: "Brand Marketing", orderindex: 0 },
                { id: "opt-existing-mapped-3540", name: "Finance", orderindex: 1 },
                { id: "opt-newdept-3540", name: "Legal", orderindex: 2 },
              ],
            },
          },
          {
            id: RT_FIELD_ID,
            type_config: {
              options: [{ id: "opt-rt-3616", name: "SEO Deep Audit", orderindex: 0 }],
            },
          },
        ];
        const deptCountBefore = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM sd_departments`)).rows[0].n;

        const refreshR = await fetch(`${baseUrl}/api/service-desk/setup/refresh-option-names`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const refreshBody = await refreshR.json();
        assert.equal(refreshR.status, 200, `refresh-option-names must return 200 (got ${refreshR.status}: ${JSON.stringify(refreshBody)})`);
        assert.equal(refreshBody.departmentsRenamedCount, 1, `departmentsRenamedCount must be 1 (got ${refreshBody.departmentsRenamedCount})`);
        assert.equal(refreshBody.requestTypesRenamedCount, 1, `requestTypesRenamedCount must be 1 (got ${refreshBody.requestTypesRenamedCount})`);

        const brandRow = await db.execute(sql`SELECT name FROM sd_departments WHERE id = 'dept-marketing-3540'`);
        assert.equal(brandRow.rows[0].name, "Brand Marketing", "refresh endpoint renamed the dept");
        const rtRow = await db.execute(sql`SELECT name FROM sd_request_types WHERE id = 'rt-3616'`);
        assert.equal(rtRow.rows[0].name, "SEO Deep Audit", "refresh endpoint renamed the request type row");
        const rtMapRows = await db.execute(sql`
          SELECT request_type_option_ids, department_option_ids FROM sd_list_mapping WHERE clickup_list_id = ${LIST_ID} LIMIT 1
        `);
        const rtMapSaved = rtMapRows.rows[0].request_type_option_ids as Record<string, string>;
        assert.equal(rtMapSaved["opt-rt-3616"], "SEO Deep Audit", "name-keyed rt map value re-persisted with the new name");
        const deptMapSaved = rtMapRows.rows[0].department_option_ids as Record<string, string>;
        assert.equal(deptMapSaved["opt-marketing-3540"], "dept-marketing-3540", "dept mapping unchanged by refresh endpoint");

        const deptCountAfter = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM sd_departments`)).rows[0].n;
        assert.equal(deptCountAfter, deptCountBefore, "refresh endpoint must not create departments");
        console.log("  ✓ J: refresh-option-names renames dept + request type, preserves mappings, no new rows");

        // Unbind the RT field again so later sections behave as before.
        await db.execute(sql`
          UPDATE sd_list_mapping SET field_request_type_id = NULL WHERE clickup_list_id = ${LIST_ID}
        `);

        // ── (G) Dept field found only at Space level (inherited field) ────
        // Reset stubs: list-level returns nothing, space-level returns the dept field.
        // Also reset the departmentOptionIds so we can observe a fresh import.
        (globalThis as any).__sdImportDeptCuFields = [];
        (globalThis as any).__sdImportDeptCuSpaceFields = [
          {
            id: DEPT_FIELD_ID,
            type_config: {
              options: [
                { id: "opt-ops-3543", name: "Operations", orderindex: 0 },
              ],
            },
          },
        ];
        await db.execute(sql`
          UPDATE sd_list_mapping SET department_option_ids = '{}' WHERE clickup_list_id = ${LIST_ID}
        `);

        const spaceResp = await postImport(baseUrl);
        assert.equal(
          spaceResp.status,
          200,
          `space-level import must return 200 (got ${spaceResp.status}: ${JSON.stringify(spaceResp.body)})`,
        );
        const spaceBody = spaceResp.body;
        // The field was found only via the space endpoint — "Operations" must
        // reconcile to the existing authoritative department.
        assert.equal(
          spaceBody.matchedCount,
          1,
          `space-level: matchedCount must be 1 (got ${spaceBody.matchedCount})`,
        );
        const opsEntry = spaceBody.matched.find((e: any) => e.optionName === "Operations");
        assert.ok(opsEntry, "space-level: matched array must contain 'Operations'");
        assert.equal(opsEntry.departmentId, "dept-operations-3543", "Operations must use the existing NoBull department");
        const opsRows = await db.execute(sql`
          SELECT id, name FROM sd_departments WHERE name = 'Operations' LIMIT 1
        `);
        assert.equal(opsRows.rows.length, 1, "'Operations' authoritative department row remains present");
        assert.equal(opsRows.rows[0].id, opsEntry.departmentId, "Operations map uses the existing department ID");
        console.log("  ✓ G: inherited space-level field found; existing 'Operations' department reconciled");

        // ── (H) True miss — field not found at any level ──────────────────
        // All stubs return empty; the response should include the "not found" note.
        (globalThis as any).__sdImportDeptCuFields = [];
        (globalThis as any).__sdImportDeptCuSpaceFields = [];
        (globalThis as any).__sdImportDeptCuFolderFields = [];
        (globalThis as any).__sdImportDeptCuWorkspaceFields = [];
        await db.execute(sql`
          UPDATE sd_list_mapping SET department_option_ids = '{}' WHERE clickup_list_id = ${LIST_ID}
        `);

        const missResp = await postImport(baseUrl);
        assert.equal(
          missResp.status,
          200,
          `true-miss must return 200 with a note (got ${missResp.status})`,
        );
        const missNote: string = missResp.body?.note ?? "";
        assert.ok(
          missNote.includes("not found") || missNote.includes("not found at any"),
          `true-miss note must say the field was not found (got: "${missNote}")`,
        );
        assert.ok(
          !missNote.includes("bound ClickUp List"),
          `true-miss note must NOT say only "bound ClickUp List" (must mention all levels): "${missNote}"`,
        );
        console.log("  ✓ H: true-miss returns 'not found at any level' note");

      } finally {
        server.close();
        __test_resetReconciledUsers();
        (globalThis as any).__sdImportDeptCuFields = undefined;
        (globalThis as any).__sdImportDeptCuSpaceFields = undefined;
        (globalThis as any).__sdImportDeptCuFolderFields = undefined;
        (globalThis as any).__sdImportDeptCuWorkspaceFields = undefined;
      }
    },
    {
      tables: ["users", "sd_list_mapping", "sd_departments", "sd_request_types"],
      pinGetDbForCrossAsync: true,
    },
  );

  await getGlobalDispatcher().close();

  console.log("service-desk-import-departments-route: all sections passed (Task #3540 + #3543).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("service-desk-import-departments-route: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
