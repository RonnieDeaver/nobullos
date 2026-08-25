/* test-registration
{
  "name": "Front unmatched-cohort filter-rule cleanup e2e (Task #2158)",
  "regression": true,
  "sweepOnlyReason": "Task #4096 triage of the migrated no-reason boilerplate: too slow for the routine gate (~5.1s in the 2026-08-07 nightly sweep); still runs in the full suite and the nightly --regression sweep.",
  "notes": "Task #2366: heavy isolated-schema fixture. Each section spins up its own cloned schema (front_operational_rules + deletions + system_settings + admin_setting_audit) plus an HTTP server; under shared dev-DB contention (the always-on dev server drives 8\u201311s pool-acquire latency) the default 180s wall-clock is too tight and the suite intermittently SIGKILLs. Bump it in line with the other heavy Front fixtures (300s) so it bounds without flaking.",
  "tier": "small"
}
test-registration */
// Task #2158 — End-to-end integration test guarding that a brand-new
// block/dismiss FILTER rule cleans up the recent `unmatched` cohort, the
// sister behaviour to the dismissed-cohort test in
// `tests/operational-rules-filter-cleanup-e2e.test.ts` (Task #2134).
//
// `applyNewRulesToRecent`'s unmatched branch is a thin wrapper around
// `reEvaluateExistingUnmatched`, which runs the FULL triage (filter rules +
// deterministic hard match) over each recent `unmatched` row. There was no
// focused test asserting that a freshly created block/dismiss rule moves a
// recent UNMATCHED row OUT of the unmatched feed (to `blocked`/`dismissed`),
// so a future change could silently regress that path.
//
// This test exercises `reEvaluateExistingUnmatched({ restrictToIds })` — the
// exact handler the unmatched branch invokes — using the function's built-in
// test-scoping hook so the dev DB's pre-existing unmatched backlog can't turn
// the run into a multi-minute scan (the production-equivalent call
// `applyNewRulesToRecent({ cohorts: ["unmatched"] })` passes no
// `restrictToIds` and would sweep the whole backlog).
//
// Three cohorts are seeded, all starting as `unmatched`:
//   1. BLOCK cohort   — sender domain matches a new `block` filter rule.
//                       After the sweep the rows are `blocked`.
//   2. DISMISS cohort — sender email matches a new `dismiss` filter rule.
//                       After the sweep the rows are `dismissed`.
//   3. NOMATCH cohort — matches NO filter rule and no client hard-matches,
//                       so the rows stay `unmatched` (regression guard).

import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import {
  frontFilterRules,
  frontSyncEmails,
  frontMatchAuditLog,
  users,
} from "@shared/schema";
import { reEvaluateExistingUnmatched } from "../server/services/frontIntegration";
import { invalidateFilterRulesCache } from "../server/services/frontFilterRules";
import { createFrontSyncEmail } from "../server/storage/communicationStorage";

const TAG = `2158-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const BLOCK_DOMAIN = `block-${TAG}.com`;
const DISMISS_SENDER = `dismiss-sender-${TAG}@example.com`;
const NOMATCH_DOMAIN = `nomatch-${TAG}.com`;

const ROWS_PER_COHORT = 2;

type Cohort = "block" | "dismiss" | "nomatch";
const cohortNames: Cohort[] = ["block", "dismiss", "nomatch"];

const conversationIds: Record<Cohort, string[]> = {
  block: [],
  dismiss: [],
  nomatch: [],
};
for (const cohort of cohortNames) {
  for (let i = 0; i < ROWS_PER_COHORT; i++) {
    conversationIds[cohort].push(`conv_${cohort}_${TAG}_${i}`);
  }
}
const allConversationIds = cohortNames.flatMap((c) => conversationIds[c]);

function senderFor(cohort: Cohort, i: number): string {
  switch (cohort) {
    case "block":
      return `someone-${i}@${BLOCK_DOMAIN}`;
    case "dismiss":
      return DISMISS_SENDER;
    case "nomatch":
      return `someone-${i}@${NOMATCH_DOMAIN}`;
  }
}

async function cleanup(
  filterRuleIds: string[],
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

  // 1. Seed the two filter rules. Insert directly (createdBy nullable) so the
  //    test doesn't need a creating-user row.
  const [blockRule] = await db
    .insert(frontFilterRules)
    .values({ type: "block", scope: "domain", value: BLOCK_DOMAIN, enabled: true })
    .returning();
  const [dismissRule] = await db
    .insert(frontFilterRules)
    .values({ type: "dismiss", scope: "sender_email", value: DISMISS_SENDER, enabled: true })
    .returning();
  const filterRuleIds = [blockRule.id, dismissRule.id];

  // Make the filter-rule cache re-read so the freshly inserted rules
  // participate in the sweep.
  invalidateFilterRulesCache();

  const idsByCohort: Record<Cohort, string[]> = {
    block: [],
    dismiss: [],
    nomatch: [],
  };

  try {
    // 2. Seed the unmatched rows for each cohort.
    for (const cohort of cohortNames) {
      for (let i = 0; i < ROWS_PER_COHORT; i++) {
        const row = await createFrontSyncEmail({
          conversationId: conversationIds[cohort][i],
          subject: `Benign ${cohort} subject ${TAG} #${i}`,
          snippet: "test snippet body",
          participantsJson: [
            { name: "Sender", email: senderFor(cohort, i), role: "sender" },
            { name: "Inbox", email: "ops@inbox.example", role: "recipient" },
          ] as any,
          frontStatus: "archived",
          matchStatus: "unmatched",
          pipelineState: "applied",
          lastMessageAt: new Date(),
        });
        idsByCohort[cohort].push(row.id);
      }
    }

    // 3. Run the unmatched sweep, scoped to our seeded ids so the dev DB's
    //    pre-existing unmatched backlog is not touched. This is the same
    //    handler `applyNewRulesToRecent({ cohorts: ["unmatched"] })` calls.
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

    // 4a. BLOCK cohort — rows moved OUT of unmatched to blocked.
    for (const id of idsByCohort.block) {
      const row = byId.get(id)!;
      assert.equal(
        row.matchStatus,
        "blocked",
        `block-cohort row ${id} must transition to blocked (was ${row.matchStatus})`,
      );
    }

    // 4b. DISMISS cohort — rows moved OUT of unmatched to dismissed.
    for (const id of idsByCohort.dismiss) {
      const row = byId.get(id)!;
      assert.equal(
        row.matchStatus,
        "dismissed",
        `dismiss-cohort row ${id} must transition to dismissed (was ${row.matchStatus})`,
      );
    }

    // 4c. NOMATCH cohort (regression guard) — no filter rule matched and the
    //     stubbed classifier is non-operational with no client hard-match, so
    //     the rows stay unmatched.
    for (const id of idsByCohort.nomatch) {
      const row = byId.get(id)!;
      assert.equal(
        row.matchStatus,
        "unmatched",
        `nomatch-cohort row ${id} must remain unmatched (was ${row.matchStatus})`,
      );
    }

    // The sweep counts filter-rule-handled rows under `filterRuleHandled`
    // (the canonical triage lumps filter_rule_handled with operational
    // dismissal in that counter), so it must cover the two filter cohorts.
    assert.ok(
      result.filterRuleHandled >= 2 * ROWS_PER_COHORT,
      `expected ≥${2 * ROWS_PER_COHORT} filter-handled rows, got ${result.filterRuleHandled}`,
    );
    assert.equal(
      result.total,
      cohortNames.length * ROWS_PER_COHORT,
      `expected ${cohortNames.length * ROWS_PER_COHORT} rows scanned, got ${result.total}`,
    );

    console.log("front-unmatched-filter-cleanup-e2e: OK");
  } finally {
    await cleanup(filterRuleIds, createdSystemUser);
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
