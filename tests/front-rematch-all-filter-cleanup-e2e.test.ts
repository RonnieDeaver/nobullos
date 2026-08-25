/* test-registration
{
  "name": "Front rematchAll + reprocessDismissedNonSpam(all) filter-rule re-suppress e2e (Task #2258)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #2258 — Prove the OTHER two whole-corpus "full reprocess" sweeps also
// revisit an already-matched `front_sync_emails` row and re-suppress it when a
// brand-new block FILTER rule now matches its sender. Task #2221 already pinned
// `reprocessSyncEmailBatch` (the per-row processor the `front_sync_reprocess`
// queue feeds). This test pins the two sibling sweeps that ALSO enumerate
// `matchStatuses: [...frontSyncMatchStatuses]` (so they revisit
// `auto_matched`/`manually_matched`):
//
//   1. `rematchAll` — cursor-based, runs triage with `runClassifier: false`.
//      On `filter_rule_handled` the triage's filter-rule tier has ALREADY
//      mutated the row to `blocked`, but `rematchAll` counts that row as
//      `unchanged` (it only increments reassigned/newlyMatched when its own
//      hard-matcher would move a row). That counter-vs-mutation nuance is the
//      headline this phase pins: status === "blocked" YET counted unchanged.
//      A row the hard-matcher can't re-match is LEFT assigned (control stays
//      `auto_matched`).
//
//   2. `reprocessDismissedNonSpam({ cohort: "all" })` — the literally-named
//      "all" branch. Same filter-rule-first triage, so block-rule rows go to
//      `blocked`. Its non-filter path differs from `rematchAll`: a revisited
//      assigned row the hard-matcher can't reproduce is RESET to `unmatched`
//      (not left alone). This phase pins that block-rule rows → `blocked`
//      while a non-matching control assigned row is reset to `unmatched`.
//
// Both sweeps are scoped to exactly the seeded ids via a test-only
// `restrictToIds` hook added in this task (mirroring the one on
// `reEvaluateExistingUnmatched`) so the dev DB's large backlog can't turn the
// run into a multi-minute whole-corpus scan.
//
// The block rule is a FILTER rule that wins for the block-rule rows; for the
// CONTROL row triage falls through to the offline hard matcher, which finds no
// client.

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
import { rematchAll, reprocessDismissedNonSpam } from "../server/services/frontIntegration";
import { invalidateFilterRulesCache } from "../server/services/frontFilterRules";
import { createFrontSyncEmail } from "../server/storage/communicationStorage";

const TAG = `2258-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const BLOCK_DOMAIN = `block-${TAG}.com`;
const CONTROL_DOMAIN = `keep-${TAG}.com`;

const ROWS_PER_COHORT = 2;

type Cohort = "automatch" | "manualmatch" | "control";
const cohortNames: Cohort[] = ["automatch", "manualmatch", "control"];

// Each phase seeds its OWN fresh rows (a separate conversation-id namespace)
// so the second sweep never inherits the first sweep's mutations.
type Phase = "rematch" | "reprocess";
const phaseNames: Phase[] = ["rematch", "reprocess"];

function convId(phase: Phase, cohort: Cohort, i: number): string {
  return `conv_${phase}_${cohort}_${TAG}_${i}`;
}

const allConversationIds: string[] = [];
for (const phase of phaseNames) {
  for (const cohort of cohortNames) {
    for (let i = 0; i < ROWS_PER_COHORT; i++) {
      allConversationIds.push(convId(phase, cohort, i));
    }
  }
}

function senderFor(cohort: Cohort, i: number): string {
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

async function seedCohorts(
  phase: Phase,
  clientId: string,
): Promise<Record<Cohort, string[]>> {
  const idsByCohort: Record<Cohort, string[]> = {
    automatch: [],
    manualmatch: [],
    control: [],
  };
  for (const cohort of cohortNames) {
    const seededStatus =
      cohort === "manualmatch" ? "manually_matched" : "auto_matched";
    for (let i = 0; i < ROWS_PER_COHORT; i++) {
      const row = await createFrontSyncEmail({
        conversationId: convId(phase, cohort, i),
        subject: `Benign ${phase} ${cohort} subject ${TAG} #${i}`,
        snippet: "test snippet body",
        participantsJson: [
          { name: "Sender", email: senderFor(cohort, i), role: "sender" },
          { name: "Inbox", email: "ops@inbox.example", role: "recipient" },
        ] as any,
        frontStatus: "archived",
        matchStatus: seededStatus,
        matchedClientId: clientId,
        matchConfidence: 1,
        matchReason: `[seed] pre-existing ${seededStatus}`,
        pipelineState: "applied",
        lastMessageAt: new Date(),
      });
      idsByCohort[cohort].push(row.id);
    }
  }
  return idsByCohort;
}

async function run(): Promise<void> {
  // The filter-rule mutation stamps `dismissedBy: userId ?? "system"`, FK to
  // users.id. The sweeps don't plumb a userId, so they use "system".
  const existingSystem = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, "system"));
  const createdSystemUser = existingSystem.length === 0;
  if (createdSystemUser) {
    await db.insert(users).values({ id: "system" }).onConflictDoNothing();
  }

  // Seed a client so assigned rows can carry a valid matchedClientId. The firm
  // has no registered email domain, so neither sweep's hard matcher can
  // re-match the control row to it.
  const [client] = await db
    .insert(clients)
    .values({ firmName: `Rematch Cleanup Firm ${TAG}` })
    .returning();

  // Seed the block filter rule (createdBy nullable).
  const [blockRule] = await db
    .insert(frontFilterRules)
    .values({ type: "block", scope: "domain", value: BLOCK_DOMAIN, enabled: true })
    .returning();
  const filterRuleIds = [blockRule.id];
  invalidateFilterRulesCache();

  try {
    // ───────────────────────── PHASE 1 — rematchAll ─────────────────────────
    {
      const ids = await seedCohorts("rematch", client.id);
      const allIds = cohortNames.flatMap((c) => ids[c]);

      const result = await rematchAll({ restrictToIds: allIds });

      const rows = await db
        .select()
        .from(frontSyncEmails)
        .where(inArray(frontSyncEmails.id, allIds));
      const byId = new Map(rows.map((r) => [r.id, r]));
      assert.equal(
        rows.length,
        cohortNames.length * ROWS_PER_COHORT,
        "rematch: all seeded rows still present",
      );

      // PRIMARY GUARD — block-rule auto_matched + manually_matched rows are
      // re-suppressed to `blocked` by the triage filter-rule tier.
      for (const id of [...ids.automatch, ...ids.manualmatch]) {
        const row = byId.get(id)!;
        assert.equal(
          row.matchStatus,
          "blocked",
          `rematch: block-rule row ${id} must be re-suppressed to blocked (was ${row.matchStatus})`,
        );
      }

      // NEGATIVE CONTROL — auto_matched row whose sender matches no rule and
      // whom the hard matcher can't re-match stays `auto_matched` with client.
      for (const id of ids.control) {
        const row = byId.get(id)!;
        assert.equal(
          row.matchStatus,
          "auto_matched",
          `rematch: control row ${id} must remain auto_matched (was ${row.matchStatus})`,
        );
        assert.equal(
          row.matchedClientId,
          client.id,
          `rematch: control row ${id} must keep its matched client`,
        );
      }

      // Counter-vs-mutation nuance: every row counts as `unchanged` — the
      // block-rule rows because rematchAll routes `filter_rule_handled` to
      // `unchanged` (even though triage mutated them to blocked), the control
      // rows because the hard matcher found nothing to move them to.
      assert.equal(
        result.total,
        cohortNames.length * ROWS_PER_COHORT,
        `rematch: expected all rows processed, got ${result.total}`,
      );
      assert.equal(
        result.unchanged,
        cohortNames.length * ROWS_PER_COHORT,
        `rematch: expected all rows counted unchanged, got ${result.unchanged}`,
      );
      assert.equal(result.reassigned, 0, `rematch: expected 0 reassigned, got ${result.reassigned}`);
      assert.equal(result.newlyMatched, 0, `rematch: expected 0 newlyMatched, got ${result.newlyMatched}`);
      assert.equal(result.errors, 0, `rematch: expected 0 errors, got ${result.errors}`);
    }

    // ───────────── PHASE 2 — reprocessDismissedNonSpam (cohort all) ──────────
    {
      const ids = await seedCohorts("reprocess", client.id);
      const allIds = cohortNames.flatMap((c) => ids[c]);

      const result = await reprocessDismissedNonSpam({
        cohort: "all",
        restrictToIds: allIds,
      });

      const rows = await db
        .select()
        .from(frontSyncEmails)
        .where(inArray(frontSyncEmails.id, allIds));
      const byId = new Map(rows.map((r) => [r.id, r]));
      assert.equal(
        rows.length,
        cohortNames.length * ROWS_PER_COHORT,
        "reprocess: all seeded rows still present",
      );

      // PRIMARY GUARD — block-rule rows (auto + manual) re-suppressed to
      // `blocked` by the same filter-rule tier.
      for (const id of [...ids.automatch, ...ids.manualmatch]) {
        const row = byId.get(id)!;
        assert.equal(
          row.matchStatus,
          "blocked",
          `reprocess: block-rule row ${id} must be re-suppressed to blocked (was ${row.matchStatus})`,
        );
      }

      // CONTROL — this sweep's non-filter path RESETS a revisited assigned row
      // the hard matcher can't reproduce to `unmatched` (differs from
      // rematchAll, which leaves it assigned). Pin that real difference.
      for (const id of ids.control) {
        const row = byId.get(id)!;
        assert.equal(
          row.matchStatus,
          "unmatched",
          `reprocess: control row ${id} must be reset to unmatched (was ${row.matchStatus})`,
        );
        assert.equal(
          row.matchedClientId,
          null,
          `reprocess: control row ${id} must have its client cleared (was ${row.matchedClientId})`,
        );
      }

      // Accounting: all rows counted in total; control rows are `reset`; no
      // row newly hard-matched; no errors.
      assert.equal(
        result.total,
        cohortNames.length * ROWS_PER_COHORT,
        `reprocess: expected all rows processed, got ${result.total}`,
      );
      assert.equal(
        result.reset,
        ROWS_PER_COHORT,
        `reprocess: expected ${ROWS_PER_COHORT} control rows reset, got ${result.reset}`,
      );
      assert.equal(result.matched, 0, `reprocess: expected 0 matched, got ${result.matched}`);
      assert.equal(result.errors, 0, `reprocess: expected 0 errors, got ${result.errors}`);
    }

    console.log("front-rematch-all-filter-cleanup-e2e: OK");
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
