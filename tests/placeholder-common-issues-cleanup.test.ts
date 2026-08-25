/* test-registration
{
  "name": "Placeholder Common Issues cleanup service scan/clear convergence (Task #3769)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3769: placeholder Common Issues cleanup service — the shared scan/clear core behind the `clear_placeholder_common_issues` CEO prod-action (and CLI). Pins the classification buckets, the sibling-key-preserving blank, the re-read guard that refuses to clobber an interim operator edit, and the second-scan-clean convergence the action's “not needed” state relies on. Isolated schema (one cloned table), no HTTP, no AI, fast; a drift here makes the cleanup button destructive or perpetually pending.",
  "tier": "small"
}
test-registration */
/**
 * Task #3769 — placeholder Common Issues cleanup service (the shared core
 * behind both `scripts/clear-placeholder-common-issues.ts` and the
 * `clear_placeholder_common_issues` CEO prod-action).
 *
 * Against an isolated schema, verifies:
 *   1. `scanPlaceholderCommonIssues` classifies stored intake/sales rows into
 *      literal / blank-artifact / AI-rewritten candidates, counts real and
 *      already-empty rows separately, and ignores non-target sections.
 *   2. `clearPlaceholderCommonIssuesCandidates` blanks ONLY placeholder rows,
 *      preserves every other data key, and — via its re-read guard — never
 *      clobbers real content an operator saved between scan and clear.
 *   3. Convergence: a second scan finds zero candidates, which is exactly the
 *      condition the prod-action uses to settle to "not needed".
 *
 * No HTTP, no AI; the service receives the sandbox db handle directly.
 */

import assert from "node:assert/strict";
import { runInIsolatedSchema, sql } from "./db-sandbox";
import {
  clearPlaceholderCommonIssuesCandidates,
  scanPlaceholderCommonIssues,
} from "../server/services/placeholderCommonIssuesCleanup";

const TAG = `task-3769-cleanup-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const BASE =
  "Missing data source - There is no data source associated with this component. See details";
const LITERAL_TAIL = `${BASE} Name_Clean (1): Ackah Law`;
const AI_REWRITTEN = `🔴 **Issue:** Missing data source.
↳ **Impact:** The component has no data source associated with this component, so no findings are available.
➡️ **Strategic Fix:** Reconnect the data source.

Name_Clean (1): Ackah Law`;
const REAL_CONTENT = "Reps not following up within 24 hours on consult requests.";
const INTERIM_EDIT = "Operator typed this real finding between scan and clear.";

interface SeedRow {
  id: string;
  sectionKey: string;
  data: Record<string, unknown>;
}

const ROWS: SeedRow[] = [
  // 1 — literal placeholder + tail (the exact Ackah class) → cleared…
  //     unless an operator edits it first (we simulate that below).
  { id: `${TAG}-s1`, sectionKey: "intake", data: { commonIssues: LITERAL_TAIL, totalConsults: 0 } },
  // 2 — AI-rewritten placeholder finding → cleared.
  { id: `${TAG}-s2`, sectionKey: "sales", data: { commonIssues: AI_REWRITTEN, totalCases: 0 } },
  // 3 — real content → untouched.
  { id: `${TAG}-s3`, sectionKey: "intake", data: { commonIssues: REAL_CONTENT, totalConsults: 12 } },
  // 4 — already empty → counted, never a candidate.
  { id: `${TAG}-s4`, sectionKey: "sales", data: { commonIssues: "", totalCases: 3 } },
  // 5 — bare artifact-only body → blank_body candidate.
  { id: `${TAG}-s5`, sectionKey: "intake", data: { commonIssues: "Name_Clean (1): Ackah Law" } },
  // 6 — tail-less literal WITH sibling keys that must survive the clear.
  { id: `${TAG}-s6`, sectionKey: "sales", data: { commonIssues: BASE, totalCases: 5, noDataFlags: { totalCases: false } } },
];

// Non-target section carrying placeholder-looking text — must never be
// scanned (the cleanup targets intake/sales only).
const MARKETING_ROW: SeedRow = {
  id: `${TAG}-s7`,
  sectionKey: "marketing",
  data: { commonIssues: LITERAL_TAIL },
};

async function readData(isoDb: any, id: string): Promise<Record<string, unknown>> {
  const res: any = await isoDb.execute(sql`
    SELECT data FROM report_sections WHERE id = ${id} LIMIT 1
  `);
  const list = Array.isArray(res) ? res : res?.rows;
  return list?.[0]?.data ?? {};
}

async function run(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      for (const row of [...ROWS, MARKETING_ROW]) {
        // One synthetic report per row — report_sections has a UNIQUE
        // (report_id, section_key) constraint.
        await isoDb.execute(sql`
          INSERT INTO report_sections (id, report_id, section_key, data)
          VALUES (${row.id}, ${`${row.id}-report`}, ${row.sectionKey}, ${JSON.stringify(row.data)}::jsonb)
        `);
      }

      // ── First scan: classification ──
      const scan = await scanPlaceholderCommonIssues(isoDb as any);
      assert.equal(scan.scanned, 6, `scanned intake/sales rows only, got ${scan.scanned}`);
      assert.equal(scan.alreadyEmpty, 1, "one already-empty row");
      assert.equal(scan.skippedRealContent, 1, "one real-content row skipped");
      assert.equal(scan.countsByKind.literal_placeholder, 2, "rows 1 + 6 are literal");
      assert.equal(scan.countsByKind.blank_body, 1, "row 5 is a bare-artifact blank body");
      assert.equal(scan.countsByKind.ai_rewritten_placeholder, 1, "row 2 is AI-rewritten");
      assert.equal(scan.candidates.length, 4, "4 candidates total");
      assert.ok(
        !scan.candidates.some((c) => c.id === MARKETING_ROW.id),
        "marketing section must never be a candidate",
      );

      // ── Interim operator edit between scan and clear ──
      // The re-read guard must refuse to blank row 1 now that it holds real
      // content, even though the (stale) scan flagged it.
      await isoDb.execute(sql`
        UPDATE report_sections
        SET data = data || ${JSON.stringify({ commonIssues: INTERIM_EDIT })}::jsonb
        WHERE id = ${`${TAG}-s1`}
      `);

      // ── Clear ──
      const cleared = await clearPlaceholderCommonIssuesCandidates(isoDb as any, scan.candidates);
      assert.equal(cleared, 3, `interim-edited row skipped: expected 3 cleared, got ${cleared}`);

      const d1 = await readData(isoDb, `${TAG}-s1`);
      assert.equal(d1.commonIssues, INTERIM_EDIT, "interim operator edit survives the clear");
      const d2 = await readData(isoDb, `${TAG}-s2`);
      assert.equal(d2.commonIssues, "", "AI-rewritten row blanked");
      assert.equal(d2.totalCases, 0, "sibling keys preserved on row 2");
      const d3 = await readData(isoDb, `${TAG}-s3`);
      assert.equal(d3.commonIssues, REAL_CONTENT, "real content untouched");
      const d5 = await readData(isoDb, `${TAG}-s5`);
      assert.equal(d5.commonIssues, "", "bare-artifact row blanked");
      const d6 = await readData(isoDb, `${TAG}-s6`);
      assert.equal(d6.commonIssues, "", "literal row blanked");
      assert.equal(d6.totalCases, 5, "sibling metric preserved on row 6");
      assert.deepEqual(d6.noDataFlags, { totalCases: false }, "noDataFlags preserved on row 6");
      const d7 = await readData(isoDb, MARKETING_ROW.id);
      assert.equal(d7.commonIssues, LITERAL_TAIL, "non-target marketing section untouched");

      // ── Convergence: second scan is clean → prod-action settles "not needed" ──
      const rescan = await scanPlaceholderCommonIssues(isoDb as any);
      assert.equal(rescan.candidates.length, 0, "second scan finds no candidates");
      assert.equal(rescan.alreadyEmpty, 4, "cleared rows now count as already-empty");
      assert.equal(rescan.skippedRealContent, 2, "real + interim-edited rows counted as real");

      // Idempotence: clearing the STALE candidate list again writes nothing.
      const clearedAgain = await clearPlaceholderCommonIssuesCandidates(isoDb as any, scan.candidates);
      assert.equal(clearedAgain, 0, "re-running the clear with stale candidates is a no-op");
    },
    {
      tables: ["report_sections"],
    },
  );

  console.log("placeholder-common-issues-cleanup: PASSED");
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("placeholder-common-issues-cleanup: FAILED", err);
    process.exitCode = 1;
  });
