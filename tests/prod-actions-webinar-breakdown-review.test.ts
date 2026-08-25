/* test-registration
{
  "name": "Prod-actions webinar breakdown ↔ Hot Transfers mismatch review — selector + ack convergence (Task #2843)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2843: review_webinar_breakdown_mismatches prod-action — the selector predicate (breakdown sum > 0 AND ≠ Hot Transfers, webinar clients only), the never-mutates-report-data invariant, and the signature-acknowledgment convergence (new drift re-pends, editor fix clears). Fast (~5s), hermetic (isolated per-test schema, all touched tables cloned), deterministic — gate it so a regression in the review action can't silently rot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2843 — `review_webinar_breakdown_mismatches` prod-action.
 *
 * The "stale breakdown" class behind the stuck report bug: the webinar
 * lead-quality breakdown sum (> 0) takes priority over Hot Transfers × 1.6
 * in every derived lead total, and editing Hot Transfers historically never
 * touched the breakdown — so a report could display totals driven by an
 * old import-seeded breakdown forever. Task #2839 shipped the correction
 * surface (editable breakdown inputs + inline warning in the editor's
 * Webinars card); this action surfaces every currently-mismatched report
 * for operator review and converges via a signature acknowledgment — it
 * NEVER mutates report data (silent auto-correction was explicitly ruled
 * out because only an operator can decide the intended split).
 *
 * Asserts:
 *  - Action is registered in PROD_ACTIONS.
 *  - status() finds only true mismatches: breakdown sum > 0 AND ≠ Hot
 *    Transfers, webinar-product clients only; agreeing reports, zero
 *    breakdowns (HT-fallback mode), and non-webinar clients are excluded.
 *  - apply() acknowledges the current list (system_settings write) and the
 *    action settles to `applied` without touching report_sections.
 *  - A NEW drift on the same report (different values ⇒ new signature)
 *    returns the action to pending on its own.
 *  - Fixing the report in the editor's direction (breakdown = Hot
 *    Transfers) clears it entirely: status not-needed, and a follow-up
 *    apply() clears the stale acknowledgment row.
 *
 * Runs inside `runInIsolatedSchema` with every table the action touches
 * cloned (uncloned tables fall through to `public` — see memory
 * "isolated-schema search_path fallthrough").
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2839 (editable breakdown + mismatch warning + derivation priority),
 *   #2753 (reparse_june_2026_report_leads — report_sections candidate
 *   query pattern), #2483 (purge action test pattern), #1969 (one-and-done
 *   prod-action policy), #2281 (one-apply convergence).
 */

import assert from "node:assert/strict";

import { storage } from "../server/storage";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  WEBINAR_MISMATCH_ACK_SETTING,
  findWebinarBreakdownMismatches,
  mismatchSignature,
} from "../server/services/webinarBreakdownMismatchReview";
import { getDb } from "../server/db";
import { runInIsolatedSchema, sql } from "./db-sandbox";

const TAG = `task-2843-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR = `${TAG}-actor`;

const WEBINAR_CLIENT = `${TAG}-client-webinar`;
const GBP_CLIENT = `${TAG}-client-gbp`;
const MISMATCH_REPORT = `${TAG}-report-mismatch`;
const AGREE_REPORT = `${TAG}-report-agree`;
const ZERO_LQ_REPORT = `${TAG}-report-zero-lq`;
const NON_WEBINAR_REPORT = `${TAG}-report-non-webinar`;

function marketingData(hotTransfers: number, good: number): string {
  return JSON.stringify({
    totalLeads: 70,
    webinar: {
      registrants: 100,
      attendees: 60,
      hotTransfers,
      leadQuality: { good, notQuotable: 0, missedCalls: 0, noData: 0 },
    },
  });
}

async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products)
    VALUES
      (${WEBINAR_CLIENT}, ${"Webinar Mismatch Firm"}, ARRAY['gbp','webinar']::text[]),
      (${GBP_CLIENT}, ${"GBP Only Firm"}, ARRAY['gbp']::text[])
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status)
    VALUES
      (${MISMATCH_REPORT}, ${WEBINAR_CLIENT}, '2026-06', 'draft'),
      (${AGREE_REPORT}, ${WEBINAR_CLIENT}, '2026-05', 'draft'),
      (${ZERO_LQ_REPORT}, ${WEBINAR_CLIENT}, '2026-04', 'draft'),
      (${NON_WEBINAR_REPORT}, ${GBP_CLIENT}, '2026-06', 'draft')
  `);
  // The Kevin-shaped mismatch: HT edited to 29, breakdown stuck at 44.
  await isoDb.execute(sql`
    INSERT INTO report_sections (report_id, section_key, data)
    VALUES
      (${MISMATCH_REPORT}, 'marketing', ${marketingData(29, 44)}::jsonb),
      (${AGREE_REPORT}, 'marketing', ${marketingData(29, 29)}::jsonb),
      (${ZERO_LQ_REPORT}, 'marketing', ${marketingData(29, 0)}::jsonb),
      (${NON_WEBINAR_REPORT}, 'marketing', ${marketingData(29, 44)}::jsonb)
  `);
}

async function main() {
  const action = PROD_ACTIONS.find((a) => a.id === "review_webinar_breakdown_mismatches");
  assert.ok(action, "review_webinar_breakdown_mismatches must be registered in PROD_ACTIONS");

  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      // ── Empty schema → not-needed both ways. ─────────────────────────
      const status0 = await action.status();
      assert.equal(status0.state, "not-needed", `empty: ${JSON.stringify(status0)}`);
      const apply0 = await action.apply(ACTOR);
      assert.equal(apply0.state, "not-needed", `empty apply: ${JSON.stringify(apply0)}`);

      await seed(isoDb);

      // ── Selector: exactly the one true mismatch. ──────────────────────
      const found = await findWebinarBreakdownMismatches(getDb());
      assert.equal(found.length, 1, `selector must find exactly 1: ${JSON.stringify(found)}`);
      assert.equal(found[0].reportId, MISMATCH_REPORT);
      assert.equal(found[0].hotTransfers, 29);
      assert.equal(found[0].breakdownSum, 44);
      assert.equal(
        mismatchSignature(found[0]),
        `${MISMATCH_REPORT}:29:44`,
        "signature encodes report + both mismatched values",
      );

      // ── status(): pending, names the report with its editor link. ────
      const status1 = await action.status();
      assert.equal(status1.state, "pending", `pending: ${JSON.stringify(status1)}`);
      assert.ok(
        status1.detail?.includes(`/reports/${MISMATCH_REPORT}`),
        "pending detail links the report editor",
      );
      assert.ok(
        !status1.detail?.includes(AGREE_REPORT) &&
          !status1.detail?.includes(ZERO_LQ_REPORT) &&
          !status1.detail?.includes(NON_WEBINAR_REPORT),
        "agreeing / zero-breakdown / non-webinar reports are never surfaced",
      );

      // ── apply(): acknowledges, never touches report data. ────────────
      const apply1 = await action.apply(ACTOR);
      assert.equal(apply1.state, "applied", `apply: ${JSON.stringify(apply1)}`);
      assert.equal(apply1.rowsAffected, 1, "one mismatch acknowledged");
      const ack = await storage.getSystemSettingFresh(WEBINAR_MISMATCH_ACK_SETTING);
      assert.ok(ack?.value?.includes(`${MISMATCH_REPORT}:29:44`), "ack signature persisted");
      const sectionAfter: any = await isoDb.execute(sql`
        SELECT data FROM report_sections WHERE report_id = ${MISMATCH_REPORT}
      `);
      // jsonb round-trips reorder keys, so compare structurally (memory:
      // "jsonb-unchanged-check-key-order").
      assert.deepEqual(
        sectionAfter.rows[0].data.webinar.leadQuality,
        { good: 44, notQuotable: 0, missedCalls: 0, noData: 0 },
        "apply never mutates report data — correction is an operator judgment",
      );

      // ── Acknowledged → settles to applied (still visible, not pending).
      const status2 = await action.status();
      assert.equal(status2.state, "applied", `acked: ${JSON.stringify(status2)}`);

      // ── New drift on the same report ⇒ new signature ⇒ pending again. ─
      await isoDb.execute(sql`
        UPDATE report_sections SET data = ${marketingData(30, 44)}::jsonb
        WHERE report_id = ${MISMATCH_REPORT}
      `);
      const status3 = await action.status();
      assert.equal(status3.state, "pending", `re-drift: ${JSON.stringify(status3)}`);

      // ── Operator fixes the report (breakdown = HT) → clears entirely. ─
      await isoDb.execute(sql`
        UPDATE report_sections SET data = ${marketingData(30, 30)}::jsonb
        WHERE report_id = ${MISMATCH_REPORT}
      `);
      const status4 = await action.status();
      assert.equal(status4.state, "not-needed", `fixed: ${JSON.stringify(status4)}`);
      const apply2 = await action.apply(ACTOR);
      assert.equal(apply2.state, "not-needed", `fixed apply: ${JSON.stringify(apply2)}`);
      const ackAfter = await storage.getSystemSettingFresh(WEBINAR_MISMATCH_ACK_SETTING);
      assert.equal(ackAfter, undefined, "stale acknowledgment row cleared once nothing mismatches");

      console.log("✓ prod-actions-webinar-breakdown-review passed");
    },
    {
      tables: [
        "clients",
        "reports",
        "report_sections",
        "system_settings",
        "admin_setting_audit",
      ],
    },
  );
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles.
main().then(
  () => {},
  (err) => {
    console.error("✗ prod-actions-webinar-breakdown-review failed:", err);
    process.exitCode = 1;
  },
);
