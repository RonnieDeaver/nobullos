/* test-registration
{
  "name": "notifyUser query-count budget (Task #1724 Phase 4.3)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #1724 Phase 4.3 — Pin the query-count budget for the optimized
// notifyUser path. Phase 1.1 collapsed the legacy four-round-trip path
// into a single combined-CTE round trip plus the recipient existence
// probe; this test makes a regression back to multiple round trips a
// CI-visible failure instead of a silent slow query.
//
// Budget reasoning:
//   - notifyUserCombined (happy path): 1 query — single combined CTE.
//     This is the core regression guard: the Phase 1.1 fix collapsed a
//     four-roundtrip pattern into one CTE; any future code change that
//     re-introduces extra round trips here will trip this assertion.
//   - notifyUser() wrapper additionally broadcasts SSE events, fetches
//     a refreshed unread count when the CTE didn't return one, and
//     enqueues a per-user Slack DM (which itself reads user prefs and
//     inserts a work-queue job). The wrapper budget is therefore set
//     loose (15) — it's a backstop against a doubling of round trips,
//     not a tight floor.
//
// Usage: tsx tests/notify-user-query-budget.test.ts

import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { users } from "@shared/schema";
import { notifyUser } from "../server/services/notifications/userInbox";
import { notifyUserCombined } from "../server/storage/userNotificationsStorage";
import { runWithQueryBudget } from "./helpers/queryBudget";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

async function seedUser(suffix: string): Promise<string> {
  const id = `u-${Date.now()}-${Math.floor(Math.random() * 1e6)}-${suffix}`;
  await getDb().insert(users).values({ id, email: `${id}@test.local` });
  return id;
}

const COMBINED_BUDGET = 1;
const NOTIFY_USER_BUDGET = 15;

async function main(): Promise<void> {
  console.log("Task #1724 Phase 4.3 — notifyUser query-count budget");

  await runInTxSandbox(async () => {
    const alice = await seedUser("a");
    const bob = await seedUser("b");

    // Warm any AsyncLocalStorage / module-init queries that the sandbox
    // itself runs out of the budget by performing one ignored insert
    // before measuring.
    await notifyUserCombined({ userId: alice, category: "system", title: "warmup" });

    // (1) notifyUserCombined happy path is a single round trip.
    const combined = await runWithQueryBudget(() =>
      notifyUserCombined({
        userId: alice,
        category: "system",
        title: "budget-combined",
      }),
    );
    check(
      `notifyUserCombined uses ≤ ${COMBINED_BUDGET} query`,
      combined.count <= COMBINED_BUDGET,
      `observed ${combined.count}`,
    );
    check(
      "notifyUserCombined still returns inserted row",
      combined.result.status === "inserted" && !!combined.result.row,
    );

    // (2) notifyUserCombined dedupe hit is also a single round trip.
    await notifyUserCombined({
      userId: alice,
      category: "comms.sms",
      title: "first",
      dedupeKey: "thread:budget",
    });
    const dedupeHit = await runWithQueryBudget(() =>
      notifyUserCombined({
        userId: alice,
        category: "comms.sms",
        title: "dup",
        dedupeKey: "thread:budget",
      }),
    );
    check(
      `notifyUserCombined dedupe hit uses ≤ ${COMBINED_BUDGET} query`,
      dedupeHit.count <= COMBINED_BUDGET,
      `observed ${dedupeHit.count}`,
    );
    check(
      "dedupe hit returns deduped status",
      dedupeHit.result.status === "deduped",
    );

    // (3) notifyUser() wrapper path: ≤ NOTIFY_USER_BUDGET round trips
    // for the optimized branch.
    const optimized = await runWithQueryBudget(() =>
      notifyUser(bob, { category: "system", title: "budget-opt" }),
    );
    check(
      `notifyUser optimized path uses ≤ ${NOTIFY_USER_BUDGET} queries`,
      optimized.count <= NOTIFY_USER_BUDGET,
      `observed ${optimized.count}`,
    );
    check("notifyUser optimized path returns row", !!optimized.result);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
