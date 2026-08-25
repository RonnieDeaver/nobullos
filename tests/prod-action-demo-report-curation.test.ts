/* test-registration
{
  "name": "Prod action: demo report dataset curation (Task #4289)",
  "smoke": true,
  "smokeReason": "Hermetic isolated-schema suite guarding a registered prod action (curate_demo_report_dataset): stamp-gated one-shot semantics, env-field preservation, empty-draft deletion scoping, and the curated dataset's internal consistency.",
  "tier": "small"
}
test-registration */
/**
 * Task #4289 — the public demo report (`/demo-report`) is curated by a
 * one-shot, stamp-gated prod action. This suite pins the action's whole
 * lifecycle against the EXACT production data it will run on:
 *
 *   (A) unset `demoReportId`            → not-needed (quiet in fresh envs)
 *   (B) setting points at missing report → not-needed
 *   (C) full prod-shaped fixture:
 *         pending (4 sections + 2 empty drafts)
 *         → apply: curated sections (env fields preserved, legacy
 *           `webinars`/`blogPostUrl` junk gone), empty drafts deleted,
 *           non-empty reports untouched, history rows attributed,
 *           stamp written
 *         → not-needed; re-press = no-op (stamp-gated)
 *         → drift after stamp STAYS not-needed (operator edits respected)
 *   (D) curated dataset self-consistency: monotonic funnel, bucket sums,
 *       canonical Common Issues formatting (normalizer fixed point),
 *       actions distinct from the Task #4227 serve-time fallback copy.
 *
 * Section fixtures are the VERBATIM prod rows for report c719aeeb… read
 * via the production replica on 2026-08-10 (Task #4289 evidence pass) —
 * per prod-fixture-from-replica, exact values pinned before writing.
 *
 * Whole test runs inside runInIsolatedSchema — no writes touch public.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { runInIsolatedSchema } from "./db-sandbox";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  CURATED_GBP_LOCATIONS,
  CURATED_INTAKE,
  CURATED_MARKETING,
  CURATED_NEXT_ACTIONS,
  CURATED_SALES,
  DEMO_CURATION_STAMP_KEY,
  DEMO_CURATION_EDITOR,
  DEMO_REPORT_ID_SETTING_KEY,
  buildCuratedIntake,
  buildCuratedMarketing,
  buildCuratedNextActions,
  buildCuratedSales,
} from "../server/services/demoReportCuration";
import { normalizeCommonIssuesStructure } from "../server/services/commonIssuesFormatter";

// ─── Prod fixtures (replica read 2026-08-10, report c719aeeb…) ───────

const DEMO_REPORT_ID = "c719aeeb-f469-4aa1-9ccc-2c24a9d2c4d5";
const DEMO_CLIENT_ID = "42d5a0d6-3cab-45b8-9fb6-95bd485045ce";

/** Verbatim prod `report_sections.data` payloads (see header). */
const PROD_INTAKE = JSON.parse(
  `{"commonIssues": "🔴 **Issue:** Long time to Answer  \\n↳ **Impact:** Delays in client engagement and potential loss of leads  \\n> ➡️ **Strategic Fix:** Implement a system to track and reduce response times  \\n\\n---  \\n\\n2) Incomplete Information Gathering  \\n🔴 **Issue:** Incomplete Information Gathering  \\n↳ **Impact:** Inefficient consultations and potential misalignment with client needs  \\n> ➡️ **Strategic Fix:** Develop a standardized intake form to ensure all necessary information is collected  \\n\\n---  \\n\\n3) Poor Follow-Up Practices  \\n🔴 **Issue:** Poor Follow-Up Practices  \\n↳ **Impact:** Decreased client retention and increased drop-off rates  \\n> ➡️ **Strategic Fix:** Establish a follow-up schedule and assign team members to ensure timely outreach  \\n\\n---  \\n\\n4) Lack of Training for Intake Staff  \\n🔴 **Issue:** Lack of Training for Intake Staff  \\n↳ **Impact:** Inconsistent client experiences and missed opportunities for conversion  \\n> ➡️ **Strategic Fix:** Create a comprehensive training program for all intake personnel  \\n\\n---  \\n\\n5) Inefficient Use of Technology  \\n🔴 **Issue:** Inefficient Use of Technology  \\n↳ **Impact:** Slower processing times and increased administrative burden  \\n> ➡️ **Strategic Fix:** Evaluate and upgrade technology tools to streamline the intake process  ", "qualityScore": 85, "totalConsults": 200, "missedCallRate": 6.9, "avgTimeToAnswer": 15, "leadToConsultRate": 46.3, "recommendedActions": "2) How can we answer phones faster?", "commonIssuesReformatBackfillVersion": 1}`,
);

const PROD_MARKETING = JSON.parse(
  `{"gbp": {"shared": {"blogPostUrl": "test.com"}, "locations": [{"id": "415f34aa-fdf1-48cf-afd7-f34cbcc2610c", "name": "Dallas", "leadQuality": {"good": 0, "noData": 0, "missedCalls": 0, "notQuotable": 0}, "uniqueLeads": 100, "postsQaCount": 20, "heatmapImageUrl": "/objects/uploads/71bf6630-020f-4d31-8617-044ba8b06cc8", "reviewsGenerated": 20, "reviewsRespondedTo": 20}, {"id": "3e81c09b-5c00-4bb4-8619-4e992acdfb93", "name": "Fort Worth", "leadQuality": {"good": 0, "noData": 0, "missedCalls": 0, "notQuotable": 0}, "uniqueLeads": 100, "postsQaCount": 20, "heatmapImageUrl": "/objects/uploads/50cbfdbc-b0c0-4a39-a297-a7e58f4cdd80", "reviewsGenerated": 20, "reviewsRespondedTo": 20}]}, "lsa": {"adSpend": 3000, "costPerLead": 30, "leadQuality": {"good": 60, "noData": 10, "missedCalls": 10, "notQuotable": 20}, "uniqueLeads": 100}, "posture": "scaling", "webinars": {"showRate": 50, "attendees": 50, "registrants": 100, "hotTransfers": 20, "hotTransferRate": 40}, "googleAds": {"adSpend": 3000, "costPerLead": 30, "leadQuality": {"good": 60, "noData": 10, "missedCalls": 10, "notQuotable": 20}, "uniqueLeads": 100}, "lsaEnabled": true, "totalLeads": 432, "leadQuality": {"good": 302, "noData": 30, "missedCalls": 30, "notQuotable": 70}, "gbpLeadQuality": {"good": 150, "noData": 10, "missedCalls": 10, "notQuotable": 30}, "googleAdsEnabled": true, "reviewGeneration": {"list": {"reviews": 30, "contacted": 200, "activationRate": 15}, "other": {"count": 5}, "webinar": {"reviews": 20, "activationRate": 40}}}`,
);

const PROD_SALES = JSON.parse(
  `{"noShowRate": 10, "totalCases": 100, "avgFollowUps": 10, "commonIssues": "Great job on maintaining a strong Consult-to-Case rate! \\n\\n🔴 **Issue:** Average follow ups is just a little low  \\n↳ **Impact:** This may limit opportunities to engage potential clients.  \\n> ➡️ **Strategic Fix:** Consider increasing the frequency of follow-ups to enhance client engagement.  \\n\\n---", "qualityScore": 81, "totalConsults": 200, "averageCaseValue": 5500, "consultToCaseRate": 50, "recommendedActions": "2) How can we do more follow ups?", "commonIssuesReformatBackfillVersion": 1}`,
);

const PROD_NEXT_ACTIONS = JSON.parse(
  `{"ours": [{"why": "A taper period is not far off. We can use this downtime to open a new location", "action": "Open a new GBP Location"}], "theirs": [{"why": "We will miss less calls and convert more into consults", "action": "Fix the slow time to answer"}]}`,
);

/**
 * First `ours` action of the Task #4227 serve-time DEMO_NEXT_ACTIONS
 * fallback (server/routes/reports.ts). The curated stored copy must
 * DIFFER so a capture of the served deck proves stored-data provenance.
 * (If the fallback copy is ever reworded, keep this in sync — the assert
 * is a pure inequality, so drift can only produce a false pass if the
 * fallback is reworded to exactly equal the curated copy.)
 */
const FALLBACK_FIRST_OUR_ACTION =
  "Launch review-generation campaign across all office locations";

const deep = (v: unknown) => JSON.parse(JSON.stringify(v));

async function main(): Promise<void> {
  const action = PROD_ACTIONS.find((a) => a.id === "curate_demo_report_dataset");
  assert(action, "curate_demo_report_dataset must be registered in PROD_ACTIONS");
  assert.equal(action.convergence.kind, "converging");

  // ── (D) dataset self-consistency (pure, no DB) ─────────────────────
  {
    const sum = (q: { good: number; notQuotable: number; missedCalls: number; noData: number }) =>
      q.good + q.notQuotable + q.missedCalls + q.noData;

    // Every leadQuality bucket sums to its platform total.
    for (const loc of CURATED_GBP_LOCATIONS) {
      assert.equal(sum(loc.leadQuality), loc.uniqueLeads, `${loc.name} buckets`);
    }
    const gbpTotal = CURATED_GBP_LOCATIONS.reduce((s, l) => s + l.uniqueLeads, 0);
    assert.equal(sum(CURATED_MARKETING.gbpLeadQuality), gbpTotal, "gbp rollup");
    assert.equal(
      sum(CURATED_MARKETING.googleAds.leadQuality),
      CURATED_MARKETING.googleAds.uniqueLeads,
    );
    assert.equal(sum(CURATED_MARKETING.lsa.leadQuality), CURATED_MARKETING.lsa.uniqueLeads);
    assert.equal(
      sum(CURATED_MARKETING.otherLeads.leadQuality),
      CURATED_MARKETING.otherLeads.count,
    );
    // Top-level rollup = all non-webinar platforms.
    const nonWebinar =
      gbpTotal +
      CURATED_MARKETING.googleAds.uniqueLeads +
      CURATED_MARKETING.lsa.uniqueLeads +
      CURATED_MARKETING.otherLeads.count;
    assert.equal(sum(CURATED_MARKETING.leadQuality), nonWebinar, "top rollup");

    // Stored totalLeads equals what the public deck computes: platforms +
    // webinar hot-transfer lead-equivalents (ceil(HT × 1.6)).
    const webinarEquiv = Math.ceil(CURATED_MARKETING.webinar.hotTransfers * 1.6);
    assert.equal(CURATED_MARKETING.totalLeads, nonWebinar + webinarEquiv);

    // Monotonic funnel with plausible ratios, matching the stored rates.
    assert(
      CURATED_MARKETING.totalLeads > CURATED_INTAKE.totalConsults &&
        CURATED_INTAKE.totalConsults > CURATED_SALES.totalCases,
      "funnel must be monotonic",
    );
    assert.equal(
      CURATED_INTAKE.leadToConsultRate,
      Math.round((CURATED_INTAKE.totalConsults / CURATED_MARKETING.totalLeads) * 1000) / 10,
    );
    assert.equal(
      CURATED_SALES.consultToCaseRate,
      Math.round((CURATED_SALES.totalCases / CURATED_SALES.totalConsults) * 1000) / 10,
    );
    assert.equal(CURATED_SALES.totalConsults, CURATED_INTAKE.totalConsults);

    // Review channels agree with the GBP location review sum.
    const gbpReviews = CURATED_GBP_LOCATIONS.reduce((s, l) => s + l.reviewsGenerated, 0);
    const rg = CURATED_MARKETING.reviewGeneration;
    assert.equal(rg.totalReviews, gbpReviews);
    assert.equal(rg.list.reviews + rg.webinar.reviews + rg.other.count, gbpReviews);

    // Canonical Common Issues formatting: normalizer fixed point, no
    // stray list-numbering junk, no trailing whitespace/divider.
    for (const text of [CURATED_INTAKE.commonIssues, CURATED_SALES.commonIssues]) {
      assert.equal(normalizeCommonIssuesStructure(text), text, "normalizer fixed point");
      assert(!/^\d+\)/m.test(text), "no bare numbered-name lines");
      assert(!/[ \t]\n/.test(text) && !/---\s*$/.test(text.trim()), "clean edges");
    }
    for (const ra of [CURATED_INTAKE.recommendedActions, CURATED_SALES.recommendedActions]) {
      assert(!/^\s*\d+\)/.test(ra), "recommendedActions numbering junk");
    }

    // Both columns populated with copy distinct from the serve-time
    // fallback (stored-data provenance is verifiable from a capture).
    assert.equal(CURATED_NEXT_ACTIONS.ours.length, 3);
    assert.equal(CURATED_NEXT_ACTIONS.theirs.length, 3);
    for (const item of [...CURATED_NEXT_ACTIONS.ours, ...CURATED_NEXT_ACTIONS.theirs]) {
      assert(item.action.length >= 20 && item.why.length >= 20, "substantial copy");
    }
    assert(
      CURATED_NEXT_ACTIONS.ours.every((a) => a.action !== FALLBACK_FIRST_OUR_ACTION),
      "curated copy must differ from the serve-time fallback",
    );

    // Builders are idempotent (apply twice = apply once), so a re-press
    // that somehow bypassed the stamp would still write identical bytes.
    for (const build of [
      buildCuratedIntake,
      buildCuratedSales,
      buildCuratedMarketing,
      buildCuratedNextActions,
    ]) {
      const once = build(deep(PROD_MARKETING));
      assert.deepEqual(build(deep(once)), once, "builder idempotence");
    }
  }

  await runInIsolatedSchema(
    async ({ db }) => {
      const insertSetting = (key: string, value: string) =>
        db.execute(sql`
          INSERT INTO system_settings (key, value) VALUES (${key}, ${value})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `);
      const insertReport = (id: string, month: string, status: string) =>
        db.execute(sql`
          INSERT INTO reports (id, client_id, report_month, status, share_token)
          VALUES (${id}, ${DEMO_CLIENT_ID}, ${month}, ${status}, ${`tok-${id}`})
        `);
      const insertSection = (reportId: string, key: string, data: unknown) =>
        db.execute(sql`
          INSERT INTO report_sections (report_id, section_key, data)
          VALUES (${reportId}, ${key}, ${JSON.stringify(data)}::jsonb)
        `);

      // ── (A) unset demoReportId → quiet not-needed ──────────────────
      let st = await action!.status();
      assert.equal(st.state, "not-needed", st.detail);
      assert(st.detail.includes("demoReportId"), st.detail);
      let out = await action!.apply("test-actor");
      assert.equal(out.state, "not-needed", out.detail);

      // ── (B) setting → missing report → not-needed ──────────────────
      await insertSetting(DEMO_REPORT_ID_SETTING_KEY, DEMO_REPORT_ID);
      st = await action!.status();
      assert.equal(st.state, "not-needed", st.detail);
      assert(st.detail.includes("does not exist"), st.detail);

      // ── (C) full prod-shaped fixture ───────────────────────────────
      await insertReport(DEMO_REPORT_ID, "2026-02", "final");
      await insertSection(DEMO_REPORT_ID, "intake", PROD_INTAKE);
      await insertSection(DEMO_REPORT_ID, "sales", PROD_SALES);
      await insertSection(DEMO_REPORT_ID, "marketing", PROD_MARKETING);
      await insertSection(DEMO_REPORT_ID, "nextActions", PROD_NEXT_ACTIONS);

      // Prod-shaped empty draft (zero section rows) + dev-shaped empty
      // draft (`{}` section rows and a history row) — both must go.
      const EMPTY_A = "00000000-0000-4000-8000-00000000000a";
      const EMPTY_B = "00000000-0000-4000-8000-00000000000b";
      await insertReport(EMPTY_A, "2025-03", "draft");
      await insertReport(EMPTY_B, "2026-03", "draft");
      await insertSection(EMPTY_B, "intake", {});
      await db.execute(sql`
        INSERT INTO report_section_history
          (report_id, section_key, previous_data, new_data, data_changed, edited_by, edit_source)
        VALUES (${EMPTY_B}, 'intake', NULL, '{}'::jsonb, false, 'seed', 'system')
      `);

      // Survivors: the populated January final + a draft WITH content.
      const FINAL_JAN = "00000000-0000-4000-8000-00000000001a";
      const DRAFT_REAL = "00000000-0000-4000-8000-00000000001b";
      await insertReport(FINAL_JAN, "2026-01", "final");
      await insertSection(FINAL_JAN, "intake", { totalConsults: 100 });
      await insertReport(DRAFT_REAL, "2026-06", "draft");
      await insertSection(DRAFT_REAL, "sales", { totalCases: 3 });

      st = await action!.status();
      assert.equal(st.state, "pending", st.detail);
      assert(st.detail.includes("4 demo-report section(s)"), st.detail);
      assert(st.detail.includes("2 empty draft report(s)"), st.detail);

      out = await action!.apply("test-actor");
      assert.equal(out.state, "applied", out.detail);

      const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)).rows;

      // Sections curated — env-specific fields preserved, junk gone.
      const sections = await rows(sql`
        SELECT section_key, data, last_edited_by, last_edit_source
        FROM report_sections WHERE report_id = ${DEMO_REPORT_ID}
      `);
      const byKey = new Map(sections.map((r: any) => [r.section_key, r]));
      const marketing = (byKey.get("marketing") as any).data;
      assert.equal(marketing.webinars, undefined, "legacy webinars key retired");
      assert.deepEqual(marketing.webinar, deep(CURATED_MARKETING.webinar));
      assert.equal(marketing.gbp.shared, undefined, "test.com blog link dropped");
      const locs = marketing.gbp.locations;
      assert.equal(locs.length, 2);
      assert.equal(
        locs[0].heatmapImageUrl,
        "/objects/uploads/71bf6630-020f-4d31-8617-044ba8b06cc8",
        "env-specific heatmap ref preserved (Dallas)",
      );
      assert.equal(locs[0].id, CURATED_GBP_LOCATIONS[0].id);
      assert.equal(locs[0].uniqueLeads, 118);
      assert.equal(
        locs[1].heatmapImageUrl,
        "/objects/uploads/50cbfdbc-b0c0-4a39-a297-a7e58f4cdd80",
        "env-specific heatmap ref preserved (Fort Worth)",
      );
      assert.equal(marketing.totalLeads, CURATED_MARKETING.totalLeads);

      const intake = (byKey.get("intake") as any).data;
      const sales = (byKey.get("sales") as any).data;
      assert.equal(intake.totalConsults, 212);
      assert.equal(sales.totalCases, 71);
      assert.equal(sales.pipelineMomentumScore, 74);
      assert(marketing.totalLeads > intake.totalConsults);
      assert(intake.totalConsults > sales.totalCases);

      const nextActions = (byKey.get("nextActions") as any).data;
      assert.equal(nextActions.ours.length, 3);
      assert.equal(nextActions.theirs.length, 3);
      assert.notEqual(nextActions.ours[0].action, FALLBACK_FIRST_OUR_ACTION);

      // Audited attribution on every curated write.
      for (const key of ["intake", "sales", "marketing", "nextActions"]) {
        const row = byKey.get(key) as any;
        assert.equal(row.last_edited_by, `${DEMO_CURATION_EDITOR}:test-actor`);
        assert.equal(row.last_edit_source, "system");
      }
      const history = await rows(sql`
        SELECT section_key, previous_data FROM report_section_history
        WHERE report_id = ${DEMO_REPORT_ID} AND edited_by LIKE ${`${DEMO_CURATION_EDITOR}%`}
      `);
      assert.equal(history.length, 4, "one history row per curated section");
      const prevIntake = (history as any[]).find((h) => h.section_key === "intake");
      assert.deepEqual(prevIntake.previous_data, PROD_INTAKE, "full previous payload recorded");

      // Empty drafts (both shapes) deleted, with their litter…
      const remaining = await rows(sql`SELECT id, status FROM reports ORDER BY report_month`);
      const ids = (remaining as any[]).map((r) => r.id);
      assert(!ids.includes(EMPTY_A) && !ids.includes(EMPTY_B), "empty drafts deleted");
      assert.equal(
        (await rows(sql`SELECT 1 FROM report_section_history WHERE report_id = ${EMPTY_B}`)).length,
        0,
        "empty-draft history removed (no orphans)",
      );
      // …while populated reports (final AND draft) survive untouched.
      assert(ids.includes(FINAL_JAN) && ids.includes(DRAFT_REAL), "populated reports survive");
      const survivor = await rows(sql`
        SELECT data FROM report_sections WHERE report_id = ${DRAFT_REAL}
      `);
      assert.deepEqual((survivor as any[])[0].data, { totalCases: 3 });

      // Stamp written → settled.
      const stamp = await rows(sql`
        SELECT value FROM system_settings WHERE key = ${DEMO_CURATION_STAMP_KEY}
      `);
      assert.equal(stamp.length, 1, "one-time stamp written");

      st = await action!.status();
      assert.equal(st.state, "not-needed", st.detail);
      assert(st.detail.includes("already applied"), st.detail);

      // Re-press = no-op: identical bytes, no new history rows.
      const snapshot = await rows(sql`
        SELECT section_key, data FROM report_sections
        WHERE report_id = ${DEMO_REPORT_ID} ORDER BY section_key
      `);
      out = await action!.apply("test-actor");
      assert.equal(out.state, "not-needed", out.detail);
      assert.deepEqual(
        await rows(sql`
          SELECT section_key, data FROM report_sections
          WHERE report_id = ${DEMO_REPORT_ID} ORDER BY section_key
        `),
        snapshot,
        "re-press changes nothing",
      );
      assert.equal(
        (
          await rows(sql`
            SELECT 1 FROM report_section_history
            WHERE report_id = ${DEMO_REPORT_ID} AND edited_by LIKE ${`${DEMO_CURATION_EDITOR}%`}
          `)
        ).length,
        4,
        "no duplicate history rows on re-press",
      );

      // Drift AFTER the stamp is a deliberate operator edit — the action
      // must stay not-needed and never invite a reverting re-press.
      await db.execute(sql`
        UPDATE report_sections SET data = jsonb_set(data, '{qualityScore}', '99')
        WHERE report_id = ${DEMO_REPORT_ID} AND section_key = 'intake'
      `);
      st = await action!.status();
      assert.equal(st.state, "not-needed", st.detail);

      console.log("prod-action-demo-report-curation: all assertions passed");
    },
    {
      tables: [
        "reports",
        "report_sections",
        "report_section_history",
        "system_settings",
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
