/* test-registration
{
  "name": "Prod actions: report data historical hygiene (Task #4175)",
  "tier": "small"
}
test-registration */
/**
 * Task #4175 — dedicated coverage for the three F3-closure prod actions
 * that replaced the retained-but-never-run report hygiene scripts:
 *
 *   - backfill_empty_report_sections (converging): inserts missing
 *     canonical section rows, each with a baseline history entry; a
 *     concurrent-save collision loses to ON CONFLICT DO NOTHING.
 *   - backfill_report_section_history_baseline (converging): seeds exactly
 *     one baseline history row per history-less section, attributed to the
 *     report's webhook import log when findable, else unknown; backfills
 *     NULL last_edited_* columns only.
 *   - cleanup_inactive_product_report_blocks (manual lever): strips
 *     inactive-product blocks through upsertReportSection (history
 *     preserved); never mutates a section whose client resolves to no
 *     products; status always reads not-needed (lever-lane contract).
 *
 * Whole test runs inside runInIsolatedSchema — no writes touch public.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { runInIsolatedSchema } from "./db-sandbox";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";

const TAG = "task4175";

function action(id: string) {
  const a = PROD_ACTIONS.find((x) => x.id === id);
  assert(a, `action ${id} must be registered`);
  return a!;
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      const one = async (q: any): Promise<any> =>
        (((await db.execute(q)) as any).rows ?? [])[0];
      const count = async (q: any): Promise<number> =>
        Number((await one(q))?.n ?? 0);

      // ── Seed ────────────────────────────────────────────────────────
      // Client A owns only GBP (clients.products, no command panel).
      // Client B resolves to NO products (empty products, no CP).
      await db.execute(sql`
        INSERT INTO clients (id, firm_name, products)
        VALUES (${`${TAG}-client-a`}, ${`${TAG} Firm A`}, ARRAY['gbp']::text[]),
               (${`${TAG}-client-b`}, ${`${TAG} Firm B`}, ARRAY[]::text[])
      `);
      // R1: only a marketing section (3 canonical rows missing), whose data
      // holds an ACTIVE gbp block AND an INACTIVE googleAds block with data.
      // R2 (client B): marketing section with an lsa block — dirty but the
      // client resolves to no products, so the lever must never touch it.
      await db.execute(sql`
        INSERT INTO reports (id, client_id, report_month)
        VALUES (${`${TAG}-r1`}, ${`${TAG}-client-a`}, '2026-04'),
               (${`${TAG}-r2`}, ${`${TAG}-client-b`}, '2026-04')
      `);
      const r1Marketing = {
        gbp: { locations: [{ name: "Main", leads: 5 }], shared: {} },
        googleAds: { uniqueLeads: 7, adSpend: 1200, costPerLead: 171 },
      };
      const r2Marketing = { lsa: { uniqueLeads: 3, adSpend: 300 } };
      await db.execute(sql`
        INSERT INTO report_sections (id, report_id, section_key, data)
        VALUES (${`${TAG}-s1`}, ${`${TAG}-r1`}, 'marketing', ${JSON.stringify(r1Marketing)}::jsonb),
               (${`${TAG}-s2`}, ${`${TAG}-r2`}, 'marketing', ${JSON.stringify(r2Marketing)}::jsonb)
      `);
      // Successful webhook log matching R1's client+month → the history
      // seed must attribute R1's marketing baseline to it. R2 has no log →
      // unknown attribution.
      await db.execute(sql`
        INSERT INTO webhook_import_logs (id, client_id, report_month, status, created_at)
        VALUES (${`${TAG}-log1`}, ${`${TAG}-client-a`}, '2026-04', 'success', '2026-04-10T00:00:00Z')
      `);

      const emptyBackfill = action("backfill_empty_report_sections");
      const historySeed = action("backfill_report_section_history_baseline");
      const lever = action("cleanup_inactive_product_report_blocks");
      assert.equal(lever.manualLever, true, "cleanup must be a manual lever");
      assert.equal(emptyBackfill.manualLever, undefined);
      assert.equal(historySeed.manualLever, undefined);

      // ── (1) empty-section backfill ─────────────────────────────────
      let st = await emptyBackfill.status();
      assert.equal(st.state, "pending", `expected pending, got ${st.state}: ${st.detail}`);
      assert(st.detail.includes("2 report(s)"), st.detail);
      assert(st.detail.includes("6 canonical"), st.detail);

      let out = await emptyBackfill.apply();
      assert.equal(out.state, "applied", (out as any).detail);
      assert.equal((out as any).rowsAffected, 6);
      assert.equal(
        await count(sql`SELECT count(*)::int AS n FROM report_sections WHERE report_id = ${`${TAG}-r1`}`),
        4,
      );
      // Every backfilled row carries its own baseline history entry.
      assert.equal(
        await count(sql`
          SELECT count(*)::int AS n FROM report_section_history
          WHERE edited_by = 'system:backfill_empty_sections' AND edit_source = 'migration_seed'
        `),
        6,
      );
      st = await emptyBackfill.status();
      assert.equal(st.state, "not-needed", st.detail);
      out = await emptyBackfill.apply();
      assert.equal(out.state, "not-needed", "second press must be a no-op");

      // ── (2) history baseline seed ──────────────────────────────────
      // Only the two seeded marketing sections still lack history.
      st = await historySeed.status();
      assert.equal(st.state, "pending", st.detail);
      assert(st.detail.startsWith("2 report section(s)"), st.detail);

      out = await historySeed.apply();
      assert.equal(out.state, "applied", (out as any).detail);
      assert.equal((out as any).rowsAffected, 2);

      const s1Hist = await one(sql`
        SELECT edited_by, edit_source, webhook_import_log_id, new_data, data_changed
        FROM report_section_history
        WHERE report_id = ${`${TAG}-r1`} AND section_key = 'marketing'
      `);
      assert.equal(s1Hist.edited_by, "system:pdf-webhook");
      assert.equal(s1Hist.edit_source, "pdf_webhook");
      assert.equal(s1Hist.webhook_import_log_id, `${TAG}-log1`);
      assert.equal(s1Hist.data_changed, false);
      assert.deepEqual(s1Hist.new_data, r1Marketing, "baseline must snapshot current data");
      const s2Hist = await one(sql`
        SELECT edited_by, edit_source, webhook_import_log_id
        FROM report_section_history
        WHERE report_id = ${`${TAG}-r2`} AND section_key = 'marketing'
      `);
      assert.equal(s2Hist.edited_by, "unknown");
      assert.equal(s2Hist.edit_source, "unknown");
      assert.equal(s2Hist.webhook_import_log_id, null);
      // last_edited_* backfilled on the live rows (were NULL).
      const s1Live = await one(sql`
        SELECT last_edited_by, last_edit_source FROM report_sections WHERE id = ${`${TAG}-s1`}
      `);
      assert.equal(s1Live.last_edited_by, "system:pdf-webhook");
      assert.equal(s1Live.last_edit_source, "pdf_webhook");

      st = await historySeed.status();
      assert.equal(st.state, "not-needed", st.detail);
      out = await historySeed.apply();
      assert.equal(out.state, "not-needed", "second press must be a no-op");

      // ── (3) inactive-product cleanup lever ─────────────────────────
      // Lever-lane contract: status NEVER pending, count in the detail.
      st = await lever.status();
      assert.equal(st.state, "not-needed", st.detail);
      assert(st.detail.includes("1 of 2 stored marketing"), st.detail);
      assert(st.detail.includes("1 skipped"), st.detail);

      out = await lever.apply();
      assert.equal(out.state, "applied", (out as any).detail);
      assert.equal((out as any).rowsAffected, 1);

      const s1Data = (await one(sql`SELECT data FROM report_sections WHERE id = ${`${TAG}-s1`}`)).data;
      assert.equal(s1Data.googleAds, undefined, "inactive googleAds block must be stripped");
      assert.deepEqual(s1Data.gbp, r1Marketing.gbp, "active gbp block must survive");
      // R2 (unresolved client) untouched.
      const s2Data = (await one(sql`SELECT data FROM report_sections WHERE id = ${`${TAG}-s2`}`)).data;
      assert.deepEqual(s2Data, r2Marketing, "unresolved-client section must never be mutated");
      // The write went through the audited section writer → a history row
      // with the FULL previous payload (reversible).
      const cleanupHist = await one(sql`
        SELECT previous_data, new_data, data_changed FROM report_section_history
        WHERE report_id = ${`${TAG}-r1`} AND section_key = 'marketing'
          AND edited_by = 'system:inactive_products_cleanup' AND edit_source = 'system'
      `);
      assert(cleanupHist, "cleanup must append an edit-history row");
      assert.deepEqual(cleanupHist.previous_data, r1Marketing);
      assert.equal(cleanupHist.new_data.googleAds, undefined);
      assert.equal(cleanupHist.data_changed, true);

      // Idempotent: cleaned rows drop out of the residue scan.
      st = await lever.status();
      assert(st.detail.includes("no stored marketing section holds inactive-product data"), st.detail);
      out = await lever.apply();
      assert.equal(out.state, "not-needed", (out as any).detail);

      console.log("prod-actions-report-hygiene: all assertions passed");
    },
    {
      tables: [
        "clients",
        "command_panels",
        "reports",
        "report_sections",
        "report_section_history",
        "webhook_import_logs",
      ],
    },
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
