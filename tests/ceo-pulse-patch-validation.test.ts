/* test-registration
{
  "name": "CEO Pulse (The NoBull Brief) write validation — PATCH updateCeoPulseSchema whitelist, no raw req.body spread (audit D-PATCH) + Task #4268 edition tag enforcement on PATCH/POST and the share payload + Task #4293 supportingImages exclusion from the generic write schemas",
  "regression": true,
  "sweepOnlyReason": "DB-bound route suite (isolated-schema Postgres tables + a real HTTP server per run); belongs in the full suite and the nightly --regression sweep, not the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
/**
 * Audit D-PATCH remainder — PATCH /api/ceo-pulses/:id previously persisted a
 * raw `const updates: any = { ...req.body }` straight into
 * storage.updateCeoPulse. That let any authenticated CEO request overwrite
 * server-owned columns (monthKey, shareToken, createdBy) and blank
 * NOT NULL columns (rawContent: null → DB 500), and it silently persisted
 * arbitrary unknown keys into the update path.
 *
 * The handler now strips protected fields and validates the remainder with
 * `updateCeoPulseSchema` (shared/models/reports.ts) — the explicit whitelist
 * of CEO-editable fields: title, rawContent, aiAnalysis, fullLetterHtml,
 * includeGraphs, isPublished, edition (Task #4268). This suite pins:
 *
 *   (1) Baseline partial updates (the exact shapes CeoPulseAdmin.tsx sends)
 *       still return 200 and persist only the supplied fields.
 *   (2) Partial-update semantics: omitted ≠ explicit null ≠ empty string.
 *   (3) aiAnalysis round-trips byte-for-byte, including unknown nested keys
 *       (the reorder editor depends on this).
 *   (4) Protected fields (monthKey/shareToken/createdBy/id/createdAt) and
 *       unknown fields are silently dropped and NEVER reach the DB row.
 *   (5) Type-invalid bodies → 400 `{ error: issues[] }` with NO write at all
 *       (updated_at unchanged), including the rawContent-null blanking probe.
 *   (6) The includeGraphs=false chart-stripping branch is preserved for all
 *       three sub-shapes (no aiAnalysis / supplied with charts / null).
 *   (7) Auth is unchanged: non-CEO roles still get 403, unknown id → 404.
 *   (8) Task #4268 edition tag: both allowed values persist and switch via
 *       PATCH; unknown values and null (untagging) → 400 with no write.
 *   (9) POST /api/ceo-pulses requires a valid edition at create (400 with
 *       no row otherwise).
 *  (10) The public share payload serves edition — null for legacy untagged
 *       rows (the "renders cleanly with no tag" server-side contract).
 *  (11) Task #4293 supporting images: `supportingImages` is NOT in the
 *       generic PATCH/POST whitelists (only the dedicated image endpoints
 *       manage the column), and the share payload serves supportingImages:
 *       [] for legacy rows whose column is NULL.
 *
 * Runs against a per-test isolated schema via runInIsolatedSchema so the
 * writes are invisible to live workers and the suite is hermetic.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { registerReportRoutes } from "../server/routes/reports";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const CEO_ID = "test-ceo-pulse-patch-validation-ceo";
const AM_ID = "test-ceo-pulse-patch-validation-am";
const TAG = "audit-d-patch";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): the x-test-user
    // header selects the acting identity (default CEO). Both users are
    // pre-registered via __test_markUserReconciled after seeding, since the
    // isolated-schema seed is invisible to requireAuth's public-schema lookup.
    const sub = (req.headers["x-test-user"] as string) || CEO_ID;
    (req as any).__test_clerkUserId = sub;
    next();
  });
  registerReportRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function patch(
  baseUrl: string,
  p: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function postJson(
  baseUrl: string,
  p: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// The analysis shape the analyze pipeline produces, plus deliberately-unknown
// nested keys to prove the JSON blob round-trips without being re-shaped.
function seedAnalysis(): any {
  return {
    headline: "Original headline",
    keyTakeaways: ["takeaway one", "takeaway two"],
    strategicImplications: ["implication"],
    charts: [
      {
        type: "bar",
        title: "Lead Sources",
        valueSuffix: "",
        data: [{ label: "Google", value: 120 }],
        futureUnknownKey: { nested: true },
      },
    ],
    somethingExtra: "must survive",
  };
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES
          (${CEO_ID}, 'ceo', 'ceo', ${`${TAG}-ceo`}),
          (${AM_ID}, 'account_manager', 'account_manager', ${`${TAG}-am`})
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);

      // Isolated-schema seed is uncommitted & invisible to requireAuth's
      // ambient public-schema db lookup — pre-register both profiles so the
      // middleware uses them directly (role gating stays real: AM → 403).
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo" });
      __test_markUserReconciled(AM_ID, { id: AM_ID, role: "account_manager" });

      let seedCounter = 0;
      async function seedPulse(overrides: { analysis?: any; fullLetterHtml?: string | null; edition?: string | null; published?: boolean } = {}): Promise<string> {
        seedCounter++;
        const monthKey = `20${String(10 + seedCounter)}-0${(seedCounter % 9) + 1}`;
        const analysis = "analysis" in overrides ? overrides.analysis : seedAnalysis();
        const res: any = await isoDb.execute(sql`
          INSERT INTO ceo_pulses
            (month_key, title, raw_content, include_graphs, is_published, share_token, created_by, ai_analysis, full_letter_html, edition)
          VALUES (
            ${monthKey},
            ${"Pulse " + monthKey},
            ${"Original raw content for " + monthKey},
            true,
            ${overrides.published ?? false},
            ${TAG + "-token-" + seedCounter},
            ${CEO_ID},
            ${analysis === null ? null : JSON.stringify(analysis)}::jsonb,
            ${overrides.fullLetterHtml ?? null},
            ${overrides.edition ?? null}
          )
          RETURNING id
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return String(rows[0].id);
      }

      async function readRow(pulseId: string): Promise<any> {
        const res: any = await isoDb.execute(sql`
          SELECT id, month_key, title, raw_content, ai_analysis, full_letter_html,
                 include_graphs, is_published, share_token, created_by, created_at, updated_at,
                 edition, supporting_images
          FROM ceo_pulses WHERE id = ${pulseId}
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return rows[0];
      }

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        // ── (1) Baseline partial updates: the exact CeoPulseAdmin.tsx shapes ──
        {
          const id = await seedPulse();
          const before = await readRow(id);

          const r1 = await patch(baseUrl, `/api/ceo-pulses/${id}`, { isPublished: true });
          assert.equal(r1.status, 200, "publish toggle → 200");
          assert.equal(r1.body.isPublished, true, "response reflects isPublished");
          const after1 = await readRow(id);
          assert.equal(after1.is_published, true, "is_published persisted");
          assert.equal(after1.raw_content, before.raw_content, "raw_content untouched");
          assert.deepEqual(after1.ai_analysis, before.ai_analysis, "ai_analysis untouched");
          assert.equal(after1.month_key, before.month_key, "month_key untouched");
          console.log("  ok  (1a) { isPublished } partial update persists only that field");

          const r2 = await patch(baseUrl, `/api/ceo-pulses/${id}`, {
            rawContent: "Edited raw content",
            includeGraphs: true,
          });
          assert.equal(r2.status, 200, "editor save shape → 200");
          const after2 = await readRow(id);
          assert.equal(after2.raw_content, "Edited raw content", "raw_content persisted");
          assert.equal(after2.include_graphs, true, "include_graphs persisted");
          assert.equal(after2.is_published, true, "earlier isPublished retained");
          console.log("  ok  (1b) { rawContent, includeGraphs } editor save persists");
        }

        // ── (2) omitted ≠ null ≠ empty string ─────────────────────────────
        {
          const id = await seedPulse({ fullLetterHtml: "<p>letter</p>" });

          const rOmit = await patch(baseUrl, `/api/ceo-pulses/${id}`, { title: "Kept letter" });
          assert.equal(rOmit.status, 200);
          assert.equal((await readRow(id)).full_letter_html, "<p>letter</p>", "omitted field untouched");

          const rNull = await patch(baseUrl, `/api/ceo-pulses/${id}`, { fullLetterHtml: null });
          assert.equal(rNull.status, 200, "explicit null clear → 200");
          assert.equal((await readRow(id)).full_letter_html, null, "explicit null clears the column");

          const rEmpty = await patch(baseUrl, `/api/ceo-pulses/${id}`, { title: "" });
          assert.equal(rEmpty.status, 200, "empty-string title → 200");
          assert.equal((await readRow(id)).title, "", "empty string stored as empty string, not null");

          const before = await readRow(id);
          const rEmptyBody = await patch(baseUrl, `/api/ceo-pulses/${id}`, {});
          assert.equal(rEmptyBody.status, 200, "empty body {} stays 200");
          const after = await readRow(id);
          assert.equal(after.title, before.title, "empty body changes nothing (title)");
          assert.equal(after.full_letter_html, before.full_letter_html, "empty body changes nothing (letter)");
          console.log("  ok  (2) omitted vs null vs empty-string semantics preserved");
        }

        // ── (3) aiAnalysis round-trips byte-for-byte ──────────────────────
        {
          const id = await seedPulse();
          const newAnalysis = {
            ...seedAnalysis(),
            headline: "Replaced",
            charts: [...seedAnalysis().charts].reverse(),
            anotherUnknownTopLevel: [1, 2, { deep: "yes" }],
          };
          const r = await patch(baseUrl, `/api/ceo-pulses/${id}`, { aiAnalysis: newAnalysis });
          assert.equal(r.status, 200, "aiAnalysis PATCH → 200");
          assert.deepEqual(
            (await readRow(id)).ai_analysis,
            newAnalysis,
            "stored aiAnalysis is byte-for-byte the supplied object (unknown nested keys intact)",
          );
          console.log("  ok  (3) aiAnalysis JSON blob round-trips unchanged");
        }

        // ── (4) Protected + unknown fields never reach the row ────────────
        {
          const id = await seedPulse();
          const before = await readRow(id);
          const r = await patch(baseUrl, `/api/ceo-pulses/${id}`, {
            id: "evil-id",
            monthKey: "1999-01",
            shareToken: "hijacked-token",
            createdBy: "evil-user",
            createdAt: "2020-01-01T00:00:00.000Z",
            updatedAt: "2020-01-01T00:00:00.000Z",
            notAColumn: { sneaky: true },
            isPublished: true,
          });
          assert.equal(r.status, 200, "protected/unknown fields are stripped, not rejected (family convention)");
          const after = await readRow(id);
          assert.equal(after.id, before.id, "id unchanged");
          assert.equal(after.month_key, before.month_key, "monthKey cannot be overwritten");
          assert.equal(after.share_token, before.share_token, "shareToken cannot be overwritten");
          assert.equal(after.created_by, before.created_by, "createdBy cannot be overwritten");
          assert.deepEqual(after.created_at, before.created_at, "createdAt cannot be overwritten");
          assert.equal(after.is_published, true, "whitelisted field in the same request still applies");
          console.log("  ok  (4) protected + unknown fields dropped; whitelisted field applied");
        }

        // ── (5) Type-invalid bodies → 400 issues[], zero write ─────────────
        {
          const id = await seedPulse();
          const before = await readRow(id);
          const badBodies: Array<[string, unknown, string]> = [
            ["rawContent null (NOT NULL blank-out probe)", { rawContent: null }, "rawContent"],
            ["rawContent number", { rawContent: 123 }, "rawContent"],
            ["includeGraphs string", { includeGraphs: "false" }, "includeGraphs"],
            ["title number", { title: 5 }, "title"],
            ["isPublished string", { isPublished: "yes" }, "isPublished"],
          ];
          for (const [label, body, path] of badBodies) {
            const r = await patch(baseUrl, `/api/ceo-pulses/${id}`, body);
            assert.equal(r.status, 400, `${label} → 400`);
            assert.ok(Array.isArray(r.body.error), `${label}: error envelope is the issues array`);
            assert.ok(
              r.body.error.some((i: any) => i.path?.[0] === path),
              `${label}: issue names the offending field`,
            );
          }
          const after = await readRow(id);
          assert.deepEqual(after, before, "row byte-identical after every rejection (updated_at included — no write occurred)");
          console.log("  ok  (5) invalid types → 400 { error: issues[] } with no partial write");
        }

        // ── (6) includeGraphs=false chart stripping preserved ─────────────
        {
          // (6a) no aiAnalysis supplied → stored analysis keeps every key, charts emptied.
          const idA = await seedPulse();
          const rA = await patch(baseUrl, `/api/ceo-pulses/${idA}`, { includeGraphs: false });
          assert.equal(rA.status, 200);
          assert.deepEqual(
            (await readRow(idA)).ai_analysis,
            { ...seedAnalysis(), charts: [] },
            "stored analysis = existing analysis with charts emptied",
          );

          // (6b) supplied aiAnalysis with charts → supplied object stored with charts emptied.
          const idB = await seedPulse({ analysis: { headline: "no charts here", charts: [] } });
          const supplied = { ...seedAnalysis(), headline: "Fresh analysis" };
          const rB = await patch(baseUrl, `/api/ceo-pulses/${idB}`, { includeGraphs: false, aiAnalysis: supplied });
          assert.equal(rB.status, 200);
          assert.deepEqual(
            (await readRow(idB)).ai_analysis,
            { ...supplied, charts: [] },
            "supplied analysis stored with charts force-emptied",
          );

          // (6c) aiAnalysis:null is treated as not-supplied — the stored
          // analysis (charts stripped) wins, exactly as before the rewrite.
          const idC = await seedPulse();
          const rC = await patch(baseUrl, `/api/ceo-pulses/${idC}`, { includeGraphs: false, aiAnalysis: null });
          assert.equal(rC.status, 200);
          assert.deepEqual(
            (await readRow(idC)).ai_analysis,
            { ...seedAnalysis(), charts: [] },
            "null aiAnalysis + includeGraphs:false falls back to stripped existing analysis",
          );

          // (6d) unknown id on the includeGraphs branch → 404.
          const rD = await patch(baseUrl, `/api/ceo-pulses/00000000-0000-4000-8000-000000000000`, { includeGraphs: false });
          assert.equal(rD.status, 404, "includeGraphs branch 404 for unknown pulse");
          assert.equal(rD.body.error, "NoBull Brief not found");
          console.log("  ok  (6) includeGraphs=false chart-strip branch preserved (all three shapes + 404)");
        }

        // ── (7) Auth + not-found contracts unchanged ──────────────────────
        {
          const id = await seedPulse();
          const before = await readRow(id);
          const r403 = await patch(baseUrl, `/api/ceo-pulses/${id}`, { isPublished: true }, { "x-test-user": AM_ID });
          assert.equal(r403.status, 403, "non-CEO role → 403");
          assert.equal(r403.body.error, "ceo access required", "403 envelope unchanged");
          assert.deepEqual(await readRow(id), before, "403 leaves the row untouched");

          const r404 = await patch(baseUrl, `/api/ceo-pulses/00000000-0000-4000-8000-000000000000`, { title: "x" });
          assert.equal(r404.status, 404, "valid body, unknown id → 404");
          assert.equal(r404.body.error, "NoBull Brief not found");
          console.log("  ok  (7) 403 non-CEO and 404 unknown-id contracts unchanged");
        }

        // ── (8) Task #4268 — edition tag PATCH validation ──────────────────
        {
          const id = await seedPulse(); // legacy row: edition NULL
          assert.equal((await readRow(id)).edition, null, "seed sanity: legacy row starts untagged");

          const rA = await patch(baseUrl, `/api/ceo-pulses/${id}`, { edition: "market_shift" });
          assert.equal(rA.status, 200, "edition market_shift → 200");
          assert.equal(rA.body.edition, "market_shift", "response reflects the new edition");
          assert.equal((await readRow(id)).edition, "market_shift", "edition persisted");

          const rB = await patch(baseUrl, `/api/ceo-pulses/${id}`, { edition: "company_update" });
          assert.equal(rB.status, 200, "edition switch → 200");
          assert.equal((await readRow(id)).edition, "company_update", "edition switched");

          const before = await readRow(id);
          const badEditions: Array<[string, unknown]> = [
            ["unknown edition value", { edition: "quarterly_recap" }],
            ["edition null (untagging not allowed)", { edition: null }],
            ["edition number", { edition: 1 }],
          ];
          for (const [label, body] of badEditions) {
            const r = await patch(baseUrl, `/api/ceo-pulses/${id}`, body);
            assert.equal(r.status, 400, `${label} → 400`);
            assert.ok(Array.isArray(r.body.error), `${label}: error envelope is the issues array`);
            assert.ok(
              r.body.error.some((i: any) => i.path?.[0] === "edition"),
              `${label}: issue names edition`,
            );
          }
          assert.deepEqual(await readRow(id), before, "row untouched after every edition rejection");
          console.log("  ok  (8) edition: both values persist and switch; invalid/null rejected with no write");
        }

        // ── (9) Task #4268 — POST requires an edition at create ───────────
        {
          const noEdition = await postJson(baseUrl, "/api/ceo-pulses", {
            monthKey: "2031-01",
            rawContent: "Brief content submitted without an edition",
          });
          assert.equal(noEdition.status, 400, "create without edition → 400");
          assert.ok(Array.isArray(noEdition.body.error), "issues[] envelope on create rejection");
          assert.ok(
            noEdition.body.error.some((i: any) => i.path?.[0] === "edition"),
            "create rejection names edition",
          );
          const countRes: any = await isoDb.execute(sql`SELECT COUNT(*)::int AS n FROM ceo_pulses WHERE month_key = ${"2031-01"}`);
          const countRows = Array.isArray(countRes) ? countRes : countRes?.rows ?? [];
          assert.equal(countRows[0].n, 0, "no row created on rejection");

          const created = await postJson(baseUrl, "/api/ceo-pulses", {
            monthKey: "2031-01",
            rawContent: "Brief content submitted with an edition",
            edition: "company_update",
          });
          assert.equal(created.status, 201, "create with edition → 201");
          assert.equal(created.body.edition, "company_update", "created response carries the edition");
          assert.equal((await readRow(created.body.id)).edition, "company_update", "edition persisted at create");
          console.log("  ok  (9) POST /api/ceo-pulses enforces a valid edition at create");
        }

        // ── (10) Task #4268 — share payload serves edition; legacy stays null ──
        {
          const legacyId = await seedPulse({ published: true });
          const legacyRow = await readRow(legacyId);
          const legacy = await fetch(`${baseUrl}/api/ceo-pulse/share/${legacyRow.share_token}`);
          assert.equal(legacy.status, 200, "legacy published pulse share → 200");
          const legacyBody: any = await legacy.json();
          assert.equal(legacyBody.edition, null, "legacy untagged pulse serves edition: null (client renders no tag)");
          assert.equal(legacyBody.monthKey, legacyRow.month_key, "share payload intact for legacy pulse");

          const taggedId = await seedPulse({ published: true, edition: "market_shift" });
          const taggedRow = await readRow(taggedId);
          const tagged = await fetch(`${baseUrl}/api/ceo-pulse/share/${taggedRow.share_token}`);
          assert.equal(tagged.status, 200, "tagged published pulse share → 200");
          const taggedBody: any = await tagged.json();
          assert.equal(taggedBody.edition, "market_shift", "tagged pulse serves its edition in the share payload");
          console.log("  ok  (10) share payload: edition for tagged pulses, null for legacy untagged");
        }

        // ── (11) Task #4293 — supportingImages excluded from generic writes ──
        {
          // PATCH: supportingImages is an unknown key to updateCeoPulseSchema
          // (family convention: stripped, not rejected) — the column must
          // never change through the generic endpoint.
          const id = await seedPulse();
          const before = await readRow(id);
          assert.equal(before.supporting_images, null, "seed sanity: column starts NULL");
          const rPatch = await patch(baseUrl, `/api/ceo-pulses/${id}`, {
            supportingImages: [{ slot: 1, ext: "png", caption: "smuggled" }],
            title: "Whitelisted field still applies",
          });
          assert.equal(rPatch.status, 200, "PATCH with supportingImages → 200 (stripped like any unknown key)");
          const afterPatch = await readRow(id);
          assert.equal(afterPatch.supporting_images, null, "supporting_images NOT writable via generic PATCH");
          assert.equal(afterPatch.title, "Whitelisted field still applies", "whitelisted field in the same request applied");

          // POST: insertCeoPulseSchema omits supportingImages — a create
          // carrying it must not seed the column.
          const created = await postJson(baseUrl, "/api/ceo-pulses", {
            monthKey: "2031-02",
            rawContent: "Create carrying supportingImages",
            edition: "company_update",
            supportingImages: [{ slot: 1, ext: "png", caption: "smuggled at create" }],
          });
          assert.equal(created.status, 201, "create ignores the unknown supportingImages key");
          assert.equal((await readRow(created.body.id)).supporting_images, null, "supporting_images NOT settable via POST");

          // Share payload: legacy NULL column serves supportingImages: [].
          const legacyId = await seedPulse({ published: true });
          const legacyRow = await readRow(legacyId);
          const share = await fetch(`${baseUrl}/api/ceo-pulse/share/${legacyRow.share_token}`);
          assert.equal(share.status, 200, "legacy published pulse share → 200");
          const shareBody: any = await share.json();
          assert.deepEqual(shareBody.supportingImages, [], "legacy NULL column serves supportingImages: []");
          console.log("  ok  (11) supportingImages excluded from generic PATCH/POST; legacy share payload serves []");
        }
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    {
      tables: ["ceo_pulses", "users"],
    },
  );
}

main().then(
  () => {
    console.log("ceo-pulse-patch-validation: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("ceo-pulse-patch-validation: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
