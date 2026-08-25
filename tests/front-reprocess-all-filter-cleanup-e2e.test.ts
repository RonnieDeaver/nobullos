/* test-registration
{
  "name": "Front full-reprocess (cohort all) filter-rule cleanup e2e (Task #2221)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #2221 — End-to-end integration test guarding the OTHER side of the
// boundary documented by Task #2188: where the recent-cohort sweep
// (`applyNewRulesToRecent` → `reEvaluateExistingUnmatched`) intentionally
// LEAVES an already `auto_matched` row untouched, the heavier FULL REPROCESS
// path DOES revisit assigned rows and re-suppress them when a brand-new
// block/dismiss FILTER rule now matches their sender.
//
// Behaviour the code actually intends (verified in
// `server/services/frontIntegration.ts` and `frontSyncEmailTriage.ts`):
//   The full reprocess pipeline enumerates EVERY match status
//   (`enumerateReprocessEmailIds({ cohort: "all" })` lists
//   `frontSyncMatchStatuses`, which includes `auto_matched` and
//   `manually_matched`) and feeds those ids to the per-row processor
//   `reprocessSyncEmailBatch`. That processor routes each row through the
//   canonical `triageSyncEmailForMatching`, whose first tier
//   (`applyFilterRules`) owns the `matchStatus: "blocked"|"dismissed"`
//   mutation. A brand-new block rule therefore mutates an already
//   auto_matched / manually_matched row to `blocked` and the batch counts it
//   as `dismissed`. (The recent-cohort sweep never reaches these rows because
//   its candidate query is restricted to `matchStatus = "unmatched"` — that
//   is the #2188 boundary.)
//
// To make this a real guard rather than a false pass from a broken or
// unloaded rule, the test seeds THREE cohorts:
//   1. AUTOMATCH cohort     — seeded `auto_matched` (real matched client),
//      sender matches the new block rule. MUST move to `blocked`.
//   2. MANUALMATCH cohort   — seeded `manually_matched` (real matched
//      client), sender matches the new block rule. MUST move to `blocked`
//      (the full reprocess revisits manual matches too).
//   3. CONTROL cohort       — seeded `auto_matched` whose sender does NOT
//      match the block rule. MUST stay `auto_matched`. This proves the
//      reprocess only suppresses block-rule senders rather than blanket-
//      blocking every assigned row it revisits.
//
// All rows are passed by id to `reprocessSyncEmailBatch(ids)` — the exact
// per-row processor the `front_sync_reprocess` queue handler invokes after
// `enumerateReprocessEmailIds({ cohort: "all" })`. Passing only the seeded
// ids is the id-scoping (mirroring how #2158 / #2188 scope via the function's
// test hook) so the dev DB's pre-existing backlog can't turn the run into a
// multi-minute scan.
//
// The block rule is a FILTER rule that wins for the block-rule rows; the
// CONTROL row proceeds to the offline hard matcher, which finds no client.

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
import { reprocessSyncEmailBatch } from "../server/services/frontIntegration";
import { invalidateFilterRulesCache } from "../server/services/frontFilterRules";
import { createFrontSyncEmail } from "../server/storage/communicationStorage";

const TAG = `2221-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const BLOCK_DOMAIN = `block-${TAG}.com`;
// A distinct, non-block-rule domain for the control cohort.
const CONTROL_DOMAIN = `keep-${TAG}.com`;

const ROWS_PER_COHORT = 2;

type Cohort = "automatch" | "manualmatch" | "control";
const cohortNames: Cohort[] = ["automatch", "manualmatch", "control"];

const conversationIds: Record<Cohort, string[]> = {
  automatch: [],
  manualmatch: [],
  control: [],
};
for (const cohort of cohortNames) {
  for (let i = 0; i < ROWS_PER_COHORT; i++) {
    conversationIds[cohort].push(`conv_${cohort}_${TAG}_${i}`);
  }
}
const allConversationIds = cohortNames.flatMap((c) => conversationIds[c]);

function senderFor(cohort: Cohort, i: number): string {
  // Only the automatch/manualmatch cohorts share the block-rule domain; the
  // control cohort uses a domain no rule matches.
  const domain = cohort === "control" ? CONTROL_DOMAIN : BLOCK_DOMAIN;
  return `someone-${cohort}-${i}@${domain}`;
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
  // that column FK-references users.id. The reprocess doesn't plumb a userId,
  // so it uses "system" — ensure that row exists. Track whether we created it
  // so we only clean up our own seed.
  const existingSystem = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, "system"));
  const createdSystemUser = existingSystem.length === 0;
  if (createdSystemUser) {
    await db.insert(users).values({ id: "system" }).onConflictDoNothing();
  }

  // Seed a client so the assigned rows can carry a valid matchedClientId
  // (FK to clients.id). The firm has no registered email domain, so the
  // control row's offline hard matcher finds no client and leaves it as-is.
  const [client] = await db
    .insert(clients)
    .values({ firmName: `Reprocess Cleanup Firm ${TAG}` })
    .returning();

  // Seed the block filter rule. Insert directly (createdBy nullable) so the
  // test doesn't need a creating-user row.
  const [blockRule] = await db
    .insert(frontFilterRules)
    .values({ type: "block", scope: "domain", value: BLOCK_DOMAIN, enabled: true })
    .returning();
  const filterRuleIds = [blockRule.id];

  // Make the filter-rule cache re-read so the freshly inserted rule
  // participates in the reprocess triage.
  invalidateFilterRulesCache();

  const idsByCohort: Record<Cohort, string[]> = {
    automatch: [],
    manualmatch: [],
    control: [],
  };

  try {
    // Seed the rows for each cohort. All three start as ASSIGNED rows so the
    // test exercises the "revisit already-matched" behaviour of the full
    // reprocess.
    for (const cohort of cohortNames) {
      const seededStatus =
        cohort === "manualmatch" ? "manually_matched" : "auto_matched";
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
          matchStatus: seededStatus,
          matchedClientId: client.id,
          matchConfidence: 1,
          matchReason: `[seed] pre-existing ${seededStatus}`,
          pipelineState: "applied",
          lastMessageAt: new Date(),
        });
        idsByCohort[cohort].push(row.id);
      }
    }

    // Run the FULL reprocess per-row processor, scoped to exactly our seeded
    // ids. In production these ids come from
    // `enumerateReprocessEmailIds({ cohort: "all" })` (which enumerates every
    // match status, including auto_matched / manually_matched); here we pass
    // them directly so the dev DB's pre-existing rows are untouched.
    const allIds = cohortNames.flatMap((c) => idsByCohort[c]);
    const result = await reprocessSyncEmailBatch(allIds);

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

    // PRIMARY GUARD — AUTOMATCH cohort: an already auto_matched row whose
    // sender matches the new block rule IS re-suppressed to `blocked` by the
    // full reprocess (the triage filter-rule tier owns this mutation).
    for (const id of idsByCohort.automatch) {
      const row = byId.get(id)!;
      assert.equal(
        row.matchStatus,
        "blocked",
        `automatch-cohort row ${id} must be re-suppressed to blocked (was ${row.matchStatus})`,
      );
    }

    // PRIMARY GUARD — MANUALMATCH cohort: the full reprocess revisits manual
    // matches too, so a manually_matched row with a block-rule sender is also
    // re-suppressed to `blocked`.
    for (const id of idsByCohort.manualmatch) {
      const row = byId.get(id)!;
      assert.equal(
        row.matchStatus,
        "blocked",
        `manualmatch-cohort row ${id} must be re-suppressed to blocked (was ${row.matchStatus})`,
      );
    }

    // NEGATIVE CONTROL — CONTROL cohort: an auto_matched row whose sender does
    // NOT match the block rule stays `auto_matched` with its client intact.
    // This proves the reprocess only suppresses block-rule senders rather than
    // blanket-blocking every assigned row it revisits.
    for (const id of idsByCohort.control) {
      const row = byId.get(id)!;
      assert.equal(
        row.matchStatus,
        "auto_matched",
        `control-cohort row ${id} must remain auto_matched (was ${row.matchStatus})`,
      );
      assert.equal(
        row.matchedClientId,
        client.id,
        `control-cohort row ${id} must keep its matched client (was ${row.matchedClientId})`,
      );
    }

    // Batch accounting: both block-rule cohorts are filter-handled and counted
    // as dismissed; the control row is neither dismissed nor (newly) matched.
    const blockRuleRows = ROWS_PER_COHORT * 2;
    assert.equal(
      result.total,
      cohortNames.length * ROWS_PER_COHORT,
      `expected all ${cohortNames.length * ROWS_PER_COHORT} seeded rows processed, got ${result.total}`,
    );
    assert.equal(
      result.dismissed,
      blockRuleRows,
      `expected ${blockRuleRows} filter-handled (dismissed) rows, got ${result.dismissed}`,
    );
    assert.equal(
      result.matched,
      0,
      `expected 0 newly hard-matched rows, got ${result.matched}`,
    );
    assert.equal(
      result.errors,
      0,
      `expected 0 errors, got ${result.errors}`,
    );

    console.log("front-reprocess-all-filter-cleanup-e2e: OK");
  } finally {
    await cleanup(filterRuleIds, client?.id ?? null, createdSystemUser);
    invalidateFilterRulesCache();
  }
}

await run();
// Background DB pool monitors / hit-flush timers can keep the event loop
// alive; force a clean exit so the run-all harness doesn't fall back to the
// per-test wall-clock timeout.
process.exit(0);
