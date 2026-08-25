/* test-registration
{
  "name": "Front auto_matched-cohort filter-rule boundary e2e (Task #2188)",
  "regression": true,
  "sweepOnlyReason": "Task #4096 triage of the migrated no-reason boilerplate: too slow for the routine gate (~5.0s in the 2026-08-07 nightly sweep); still runs in the full suite and the nightly --regression sweep.",
  "tier": "small"
}
test-registration */
// Task #2188 — End-to-end integration test guarding the BOUNDARY of the
// recent-cohort filter-rule cleanup: a brand-new block/dismiss FILTER rule
// must NOT override an existing `auto_matched` row during the recent sweep.
//
// This is the sister of the dismissed-cohort test (Task #2134,
// `tests/operational-rules-filter-cleanup-e2e.test.ts`) and the unmatched-
// cohort test (Task #2158, `tests/front-unmatched-filter-cleanup-e2e.test.ts`).
//
// Behaviour the code actually intends (verified in
// `server/services/frontIntegration.ts`):
//   `applyNewRulesToRecent` sweeps only the `unmatched` and
//   `dismissed_operational` cohorts. The unmatched branch is
//   `reEvaluateExistingUnmatched`, whose candidate list comes from
//   `storage.listUnmatchedFrontSyncEmails`, which filters to
//   `matchStatus = "unmatched"`. An `auto_matched` row is therefore never a
//   candidate for either cohort, so a freshly created block/dismiss rule does
//   NOT re-suppress an already auto-matched conversation during the recent
//   sweep — it is intentionally left `auto_matched`. (A full reprocess with
//   cohort "all" is the path that would revisit assigned rows; that is a
//   separate, heavier operation, not the recent-cohort sweep.)
//
// To make this a real boundary guard rather than a false pass from a broken
// or unloaded rule, the test seeds TWO rows that share the SAME block-rule-
// matching sender domain:
//   1. AUTOMATCH cohort — seeded as `auto_matched` (with a real matched
//      client). After the sweep it MUST stay `auto_matched`.
//   2. CONTROL cohort   — seeded as `unmatched`. After the sweep it MUST move
//      to `blocked`. This proves the rule is loaded and the sweep is live, so
//      the AUTOMATCH row's non-change is specifically due to its status, not a
//      broken sweep.
//
// Both rows are passed via `reEvaluateExistingUnmatched({ restrictToIds })` —
// the exact handler the unmatched branch invokes — using the function's
// built-in test-scoping hook so the dev DB's pre-existing unmatched backlog
// can't turn the run into a multi-minute scan.
//
// The block rule is a FILTER rule, and the auto_matched row is filtered out
// before any triage.

import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import {
  frontFilterRules,
  frontSyncEmails,
  frontMatchAuditLog,
  clients,
  users,
} from "@shared/schema";
import { reEvaluateExistingUnmatched } from "../server/services/frontIntegration";
import { invalidateFilterRulesCache } from "../server/services/frontFilterRules";
import { createFrontSyncEmail } from "../server/storage/communicationStorage";

const TAG = `2188-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const BLOCK_DOMAIN = `block-${TAG}.com`;

const ROWS_PER_COHORT = 2;

type Cohort = "automatch" | "control";
const cohortNames: Cohort[] = ["automatch", "control"];

const conversationIds: Record<Cohort, string[]> = {
  automatch: [],
  control: [],
};
for (const cohort of cohortNames) {
  for (let i = 0; i < ROWS_PER_COHORT; i++) {
    conversationIds[cohort].push(`conv_${cohort}_${TAG}_${i}`);
  }
}
const allConversationIds = cohortNames.flatMap((c) => conversationIds[c]);

function senderFor(cohort: Cohort, i: number): string {
  // Both cohorts share the same block-rule-matching sender domain so the only
  // difference between them is the seeded matchStatus.
  return `someone-${cohort}-${i}@${BLOCK_DOMAIN}`;
}

async function cleanup(
  filterRuleIds: string[],
  clientId: string | null,
  deleteSystemUser: boolean,
): Promise<void> {
  await db
    .delete(frontMatchAuditLog)
    .where(inArray(frontMatchAuditLog.conversationId, allConversationIds));
  await db
    .delete(frontSyncEmails)
    .where(inArray(frontSyncEmails.conversationId, allConversationIds));
  if (filterRuleIds.length > 0) {
    await db
      .delete(frontFilterRules)
      .where(inArray(frontFilterRules.id, filterRuleIds));
  }
  if (clientId) {
    await db.delete(clients).where(eq(clients.id, clientId));
  }
  if (deleteSystemUser) {
    await db.delete(users).where(eq(users.id, "system"));
  }
}

async function run(): Promise<void> {
  // The filter-rule mutation stamps `dismissedBy: userId ?? "system"`, and
  // that column FK-references users.id. The unmatched sweep doesn't plumb a
  // userId, so it uses "system" — ensure that row exists. Track whether we
  // created it so we only clean up our own seed.
  const existingSystem = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, "system"));
  const createdSystemUser = existingSystem.length === 0;
  if (createdSystemUser) {
    await db.insert(users).values({ id: "system" }).onConflictDoNothing();
  }

  // Seed a client so the auto_matched row can carry a valid matchedClientId
  // (FK to clients.id).
  const [client] = await db
    .insert(clients)
    .values({ firmName: `Automatch Boundary Firm ${TAG}` })
    .returning();

  // Seed the block filter rule. Insert directly (createdBy nullable) so the
  // test doesn't need a creating-user row.
  const [blockRule] = await db
    .insert(frontFilterRules)
    .values({ type: "block", scope: "domain", value: BLOCK_DOMAIN, enabled: true })
    .returning();
  const filterRuleIds = [blockRule.id];

  // Make the filter-rule cache re-read so the freshly inserted rule
  // participates in the sweep.
  invalidateFilterRulesCache();

  const idsByCohort: Record<Cohort, string[]> = {
    automatch: [],
    control: [],
  };

  try {
    // Seed the rows for each cohort, both with senders matching the block rule.
    for (const cohort of cohortNames) {
      for (let i = 0; i < ROWS_PER_COHORT; i++) {
        const isAutoMatch = cohort === "automatch";
        const row = await createFrontSyncEmail({
          conversationId: conversationIds[cohort][i],
          subject: `Benign ${cohort} subject ${TAG} #${i}`,
          snippet: "test snippet body",
          participantsJson: [
            { name: "Sender", email: senderFor(cohort, i), role: "sender" },
            { name: "Inbox", email: "ops@inbox.example", role: "recipient" },
          ] as any,
          frontStatus: "archived",
          matchStatus: isAutoMatch ? "auto_matched" : "unmatched",
          matchedClientId: isAutoMatch ? client.id : null,
          matchConfidence: isAutoMatch ? 1 : null,
          matchReason: isAutoMatch ? "[seed] pre-existing auto match" : null,
          pipelineState: "applied",
          lastMessageAt: new Date(),
        });
        idsByCohort[cohort].push(row.id);
      }
    }

    // Run the unmatched sweep, scoped to our seeded ids so the dev DB's
    // pre-existing unmatched backlog is not touched. This is the same handler
    // `applyNewRulesToRecent({ cohorts: ["unmatched"] })` calls. The
    // auto_matched ids are deliberately included to prove they are NOT picked
    // up by the unmatched candidate query.
    const allIds = cohortNames.flatMap((c) => idsByCohort[c]);
    const result = await reEvaluateExistingUnmatched({ restrictToIds: allIds });

    // Read every seeded row back.
    const rowsAfter = await db
      .select()
      .from(frontSyncEmails)
      .where(inArray(frontSyncEmails.id, allIds));
    const byId = new Map(rowsAfter.map((r) => [r.id, r]));
    assert.equal(
      rowsAfter.length,
      cohortNames.length * ROWS_PER_COHORT,
      "all seeded rows still present",
    );

    // BOUNDARY GUARD — AUTOMATCH cohort: an already auto_matched row whose
    // sender matches the new block rule is intentionally left untouched by the
    // recent-cohort sweep (it is never a candidate for the unmatched cohort).
    for (const id of idsByCohort.automatch) {
      const row = byId.get(id)!;
      assert.equal(
        row.matchStatus,
        "auto_matched",
        `automatch-cohort row ${id} must remain auto_matched (was ${row.matchStatus})`,
      );
      assert.equal(
        row.matchedClientId,
        client.id,
        `automatch-cohort row ${id} must keep its matched client (was ${row.matchedClientId})`,
      );
    }

    // POSITIVE CONTROL — CONTROL cohort: an unmatched row with the IDENTICAL
    // block-rule-matching sender DOES move to blocked. This proves the rule is
    // loaded and the sweep is live, so the automatch non-change above is
    // specifically due to its status, not a broken/unloaded sweep.
    for (const id of idsByCohort.control) {
      const row = byId.get(id)!;
      assert.equal(
        row.matchStatus,
        "blocked",
        `control-cohort row ${id} must transition to blocked (was ${row.matchStatus})`,
      );
    }

    // The sweep only ever scans the unmatched cohort, so the auto_matched rows
    // are not counted in `total`; only the control rows are scanned and they
    // are filter-rule-handled (counted under filterRuleHandled).
    assert.equal(
      result.total,
      ROWS_PER_COHORT,
      `expected only the ${ROWS_PER_COHORT} unmatched control rows scanned, got ${result.total}`,
    );
    assert.ok(
      result.filterRuleHandled >= ROWS_PER_COHORT,
      `expected ≥${ROWS_PER_COHORT} filter-handled rows, got ${result.filterRuleHandled}`,
    );
    assert.equal(
      result.matched,
      0,
      `expected 0 hard-matched rows, got ${result.matched}`,
    );

    console.log("front-automatch-filter-cleanup-e2e: OK");
  } finally {
    await cleanup(filterRuleIds, client?.id ?? null, createdSystemUser);
    invalidateFilterRulesCache();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
await run();
// Background DB pool monitors / hit-flush timers can keep the event loop
// alive; force a clean exit so the run-all harness doesn't fall back to the
// per-test wall-clock timeout.
