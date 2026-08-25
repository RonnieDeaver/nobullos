/* test-registration
{
  "name": "Front filter rules (Task #825)",
  "regression": true,
  "sweepOnlyReason": "Task #4096 triage of the migrated no-reason boilerplate: too slow for the routine gate (~5.1s in the 2026-08-07 nightly sweep); still runs in the full suite and the nightly --regression sweep.",
  "tier": "small"
}
test-registration */
/**
 * Task #825 — Front filter rule coverage.
 *
 * Verifies the new `evaluateFilterRules` engine and its ingestion-side
 * wiring (`reEvaluateExistingUnmatched` -> `applyFilterRulesToSyncEmail`):
 *
 *   1. Every (type × scope) combination evaluates correctly:
 *        block / dismiss / never_match  ×  sender_email / domain / channel
 *   2. Precedence tiebreakers — block > dismiss > never_match — across
 *      multiple matching rules of different types.
 *   3. Same-type tiebreaker is the deterministic createdAt-asc order
 *      established by `loadEnabledRules()`.
 *   4. Value normalization (`@`-stripped + lowercased) on rule write.
 *   5. The 30-second in-memory cache is correctly invalidated on
 *      create / update / delete so a newly-flipped rule wins on the
 *      very next ingestion call.
 *   6. Ingestion-level: a sync_email matching an enabled rule is
 *      transitioned to `blocked` / `dismissed` (and a never_match-only
 *      match is left as `unmatched`) by `reEvaluateExistingUnmatched`.
 *
 * Everything runs inside `runInTxSandbox` so no rows leak.
 */

import { sql } from "drizzle-orm";
import { frontFilterRules, frontSyncEmails } from "@shared/schema";
import { getDb } from "../server/db";
import { runInTxSandbox } from "./db-sandbox";
import {
  evaluateFilterRules,
  invalidateFilterRulesCache,
  normalizeRuleValue,
  createFilterRule,
  updateFilterRule,
  deleteFilterRule,
  listFilterRules,
} from "../server/services/frontFilterRules";
import { reEvaluateExistingUnmatched, reprocessSyncEmailBatch } from "../server/services/frontIntegration";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

const TAG = `ffr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function p(email: string, role: "external" | "recipient" = "external") {
  return { email, role };
}

async function seedTestUser(id: string): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO users (id, email, first_name, last_name)
    VALUES (${id}, ${`${id}@test.local`}, 'Test', 'User')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function seedRule(opts: {
  type: "block" | "dismiss" | "never_match";
  scope: "sender_email" | "domain" | "channel";
  value: string;
  createdAt?: Date;
  enabled?: boolean;
}): Promise<string> {
  const value = normalizeRuleValue(opts.scope, opts.value);
  const [row] = await getDb()
    .insert(frontFilterRules)
    .values({
      type: opts.type,
      scope: opts.scope,
      value,
      enabled: opts.enabled ?? true,
      createdBy: null,
    })
    .returning({ id: frontFilterRules.id });
  if (opts.createdAt) {
    await getDb().execute(
      sql`UPDATE front_filter_rules SET created_at = ${opts.createdAt} WHERE id = ${row.id}`,
    );
  }
  invalidateFilterRulesCache();
  return row.id;
}

async function seedSyncEmail(opts: {
  conversationId: string;
  participants: Array<{ email: string; role: string }>;
  subject?: string;
}): Promise<string> {
  const [row] = await getDb()
    .insert(frontSyncEmails)
    .values({
      conversationId: opts.conversationId,
      subject: opts.subject ?? "test subject",
      snippet: "snippet",
      participantsJson: opts.participants,
      matchStatus: "unmatched",
      pipelineState: "discovered",
    })
    .returning({ id: frontSyncEmails.id });
  return row.id;
}

async function getMatchStatus(id: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ s: frontSyncEmails.matchStatus })
    .from(frontSyncEmails)
    .where(sql`${frontSyncEmails.id} = ${id}`)
    .limit(1);
  return row?.s ?? null;
}

// ============================================================
// 1) normalizeRuleValue
// ============================================================
async function testNormalize(): Promise<void> {
  assertEq(normalizeRuleValue("sender_email", "  Foo@Bar.COM "), "foo@bar.com", "sender_email lowercases + trims");
  assertEq(normalizeRuleValue("domain", "@Bar.Com"), "bar.com", "domain strips leading @ and lowercases");
  assertEq(normalizeRuleValue("domain", "BAR.com"), "bar.com", "domain lowercases without @");
  assertEq(normalizeRuleValue("channel", "#Support"), "support", "channel strips leading # and lowercases");
  assertEq(normalizeRuleValue("sender_email", "   "), "", "blank value returns empty string");
  console.log("  [PASS] normalizeRuleValue handles every scope");
}

// ============================================================
// 2) Each (type × scope) combination matches correctly
// ============================================================
async function testTypeScopeMatrix(): Promise<void> {
  const cases: Array<{
    name: string;
    type: "block" | "dismiss" | "never_match";
    scope: "sender_email" | "domain" | "channel";
    value: string;
    matchInput: Parameters<typeof evaluateFilterRules>[0];
    nonMatchInput: Parameters<typeof evaluateFilterRules>[0];
  }> = [
    {
      name: "block + sender_email",
      type: "block", scope: "sender_email", value: "spammer@evil.com",
      matchInput: { participants: [p("spammer@evil.com")] },
      nonMatchInput: { participants: [p("ok@evil.com")] },
    },
    {
      name: "dismiss + sender_email",
      type: "dismiss", scope: "sender_email", value: "noise@noise.com",
      matchInput: { participants: [p("noise@noise.com")] },
      nonMatchInput: { participants: [p("real@noise.com")] },
    },
    {
      name: "never_match + sender_email",
      type: "never_match", scope: "sender_email", value: "skip@skip.com",
      matchInput: { participants: [p("skip@skip.com")] },
      nonMatchInput: { participants: [p("notskip@skip.com")] },
    },
    {
      name: "block + domain",
      type: "block", scope: "domain", value: "evilcorp.com",
      matchInput: { participants: [p("anyone@evilcorp.com")] },
      nonMatchInput: { participants: [p("anyone@goodcorp.com")] },
    },
    {
      name: "dismiss + domain",
      type: "dismiss", scope: "domain", value: "noisedomain.com",
      matchInput: { participants: [p("a@noisedomain.com")] },
      nonMatchInput: { participants: [p("a@otherdomain.com")] },
    },
    {
      name: "never_match + domain",
      type: "never_match", scope: "domain", value: "skipdomain.com",
      matchInput: { participants: [p("z@skipdomain.com")] },
      nonMatchInput: { participants: [p("z@nope.com")] },
    },
    {
      name: "block + channel",
      type: "block", scope: "channel", value: "support@firm.com",
      matchInput: {
        participants: [p("customer@external.com"), p("support@firm.com", "recipient")],
        channels: ["support@firm.com"],
      },
      nonMatchInput: {
        participants: [p("customer@external.com"), p("sales@firm.com", "recipient")],
        channels: ["sales@firm.com"],
      },
    },
    {
      name: "dismiss + channel",
      type: "dismiss", scope: "channel", value: "billing@firm.com",
      matchInput: { participants: [p("c@x.com")], channels: ["billing@firm.com"] },
      nonMatchInput: { participants: [p("c@x.com")], channels: ["sales@firm.com"] },
    },
    {
      name: "never_match + channel",
      type: "never_match", scope: "channel", value: "skipinbox@firm.com",
      matchInput: { participants: [p("c@x.com")], channels: ["skipinbox@firm.com"] },
      nonMatchInput: { participants: [p("c@x.com")], channels: ["other@firm.com"] },
    },
  ];

  for (const c of cases) {
    await runInTxSandbox(async () => {
      const ruleId = await seedRule({ type: c.type, scope: c.scope, value: c.value });

      const matched = await evaluateFilterRules(c.matchInput);
      assert(matched.matched, `${c.name}: should match input`);
      assertEq(matched.type, c.type, `${c.name}: returns rule type`);
      assertEq(matched.scope, c.scope, `${c.name}: returns scope`);
      assertEq(matched.ruleId, ruleId, `${c.name}: returns rule id`);

      const missed = await evaluateFilterRules(c.nonMatchInput);
      assertEq(missed.matched, false, `${c.name}: should NOT match unrelated input`);
      assertEq(missed.type, null, `${c.name}: returns null type when unmatched`);
    });
    invalidateFilterRulesCache();
    console.log(`  [PASS] ${c.name}`);
  }
}

// ============================================================
// 3) Precedence: block > dismiss > never_match
// ============================================================
async function testPrecedence(): Promise<void> {
  await runInTxSandbox(async () => {
    // All three rules match the same sender — block should win.
    const t0 = new Date(Date.now() - 60_000);
    await seedRule({ type: "never_match", scope: "sender_email", value: "boss@acme.com", createdAt: t0 });
    await seedRule({ type: "dismiss", scope: "domain", value: "acme.com", createdAt: new Date(t0.getTime() + 1_000) });
    const blockId = await seedRule({ type: "block", scope: "sender_email", value: "boss@acme.com", createdAt: new Date(t0.getTime() + 2_000) });
    invalidateFilterRulesCache();

    const r = await evaluateFilterRules({ participants: [p("boss@acme.com")] });
    assertEq(r.type, "block", "block beats dismiss + never_match");
    assertEq(r.ruleId, blockId, "winning ruleId is the block rule");
  });
  console.log("  [PASS] block > dismiss > never_match precedence");

  await runInTxSandbox(async () => {
    // dismiss vs never_match → dismiss wins.
    await seedRule({ type: "never_match", scope: "domain", value: "noise.com", createdAt: new Date(Date.now() - 30_000) });
    const dismissId = await seedRule({ type: "dismiss", scope: "domain", value: "noise.com", createdAt: new Date() });
    invalidateFilterRulesCache();
    const r = await evaluateFilterRules({ participants: [p("a@noise.com")] });
    assertEq(r.type, "dismiss", "dismiss beats never_match");
    assertEq(r.ruleId, dismissId, "winning ruleId is the dismiss rule");
  });
  console.log("  [PASS] dismiss > never_match precedence");

  await runInTxSandbox(async () => {
    // Same type → oldest createdAt wins (tiebreaker is asc createdAt, asc id).
    const oldest = new Date(Date.now() - 90_000);
    const olderId = await seedRule({ type: "dismiss", scope: "domain", value: "tie.com", createdAt: oldest });
    await seedRule({ type: "dismiss", scope: "sender_email", value: "x@tie.com", createdAt: new Date(oldest.getTime() + 5_000) });
    invalidateFilterRulesCache();
    const r = await evaluateFilterRules({ participants: [p("x@tie.com")] });
    assertEq(r.type, "dismiss", "dismiss type returned for same-type tie");
    assertEq(r.ruleId, olderId, "oldest rule wins same-type tiebreaker");
  });
  console.log("  [PASS] same-type tiebreaker = oldest createdAt");
}

// ============================================================
// 4) Sender role filter (recipients shouldn't trigger sender rules)
// ============================================================
async function testSenderRoleFilter(): Promise<void> {
  await runInTxSandbox(async () => {
    await seedRule({ type: "block", scope: "sender_email", value: "support@firm.com" });
    invalidateFilterRulesCache();
    // support@firm.com only present as a recipient → must NOT match.
    const r = await evaluateFilterRules({
      participants: [p("client@elsewhere.com"), p("support@firm.com", "recipient")],
    });
    assertEq(r.matched, false, "sender rule does not match a recipient-role participant");
  });
  console.log("  [PASS] sender_email rule ignores recipient-role participants");
}

// ============================================================
// 5) Cache invalidation on create / update / delete
// ============================================================
async function testCacheInvalidation(): Promise<void> {
  // create
  await runInTxSandbox(async () => {
    invalidateFilterRulesCache();
    await seedTestUser("ffr-user-create");
    const before = await evaluateFilterRules({ participants: [p("brand@new.com")] });
    assertEq(before.matched, false, "no rule yet → no match");

    await createFilterRule(
      { type: "block", scope: "sender_email", value: "brand@new.com" },
      "ffr-user-create",
    );
    // createFilterRule must invalidate the cache internally.
    const after = await evaluateFilterRules({ participants: [p("brand@new.com")] });
    assertEq(after.matched, true, "create invalidates cache → next eval sees rule");
    assertEq(after.type, "block", "create returns the new rule type");
  });
  console.log("  [PASS] createFilterRule invalidates cache");

  // update
  await runInTxSandbox(async () => {
    invalidateFilterRulesCache();
    await seedTestUser("ffr-user-update");
    const id = await seedRule({ type: "dismiss", scope: "sender_email", value: "old@val.com" });
    // Warm cache.
    await evaluateFilterRules({ participants: [p("old@val.com")] });

    await updateFilterRule(id, { value: "new@val.com" }, "ffr-user-update");
    const oldHit = await evaluateFilterRules({ participants: [p("old@val.com")] });
    assertEq(oldHit.matched, false, "after update, old value no longer matches");
    const newHit = await evaluateFilterRules({ participants: [p("new@val.com")] });
    assertEq(newHit.matched, true, "after update, new value matches");
  });
  console.log("  [PASS] updateFilterRule invalidates cache");

  // delete
  await runInTxSandbox(async () => {
    invalidateFilterRulesCache();
    await seedTestUser("ffr-user-delete");
    const id = await seedRule({ type: "block", scope: "domain", value: "doomed.com" });
    // Warm cache.
    const before = await evaluateFilterRules({ participants: [p("a@doomed.com")] });
    assertEq(before.matched, true, "rule exists → matches");

    await deleteFilterRule(id, "ffr-user-delete");
    const after = await evaluateFilterRules({ participants: [p("a@doomed.com")] });
    assertEq(after.matched, false, "after delete, rule no longer matches");
  });
  console.log("  [PASS] deleteFilterRule invalidates cache");
}

// ============================================================
// 6) Ingestion-level: reEvaluateExistingUnmatched honours rules
// ============================================================
async function testIngestionEndToEnd(): Promise<void> {
  await runInTxSandbox(async () => {
    invalidateFilterRulesCache();
    // applyFilterRulesToSyncEmail writes dismissedBy = "system" (FK -> users).
    await seedTestUser("system");

    // block rule on a sender
    await seedRule({ type: "block", scope: "sender_email", value: "blockme@evil.com" });
    // dismiss rule on a domain
    await seedRule({ type: "dismiss", scope: "domain", value: "noise.io" });
    // never_match rule on a sender — must skip auto-matching but leave
    // the row in matchStatus='unmatched' (not blocked, not dismissed,
    // not auto_matched).
    await seedRule({ type: "never_match", scope: "sender_email", value: "skipme@skip.com" });
    invalidateFilterRulesCache();

    const blockedId = await seedSyncEmail({
      conversationId: `conv-block-${TAG}`,
      participants: [p("blockme@evil.com")],
    });
    const dismissedId = await seedSyncEmail({
      conversationId: `conv-dismiss-${TAG}`,
      participants: [p("hello@noise.io")],
    });
    const neverMatchId = await seedSyncEmail({
      conversationId: `conv-never-${TAG}`,
      participants: [p("skipme@skip.com")],
    });
    const untouchedId = await seedSyncEmail({
      conversationId: `conv-pass-${TAG}`,
      participants: [p("real@customer.com")],
    });

    await reEvaluateExistingUnmatched({
      restrictToIds: [blockedId, dismissedId, neverMatchId, untouchedId],
    });

    assertEq(await getMatchStatus(blockedId), "blocked", "block rule mutates matchStatus to 'blocked'");
    assertEq(await getMatchStatus(dismissedId), "dismissed", "dismiss rule mutates matchStatus to 'dismissed'");

    // Core never_match contract: a matching never_match rule must NOT
    // mutate the row to blocked/dismissed/auto_matched. The row stays
    // unmatched (or, if the operational classifier flagged it,
    // dismissed_operational — which is the classifier's decision, not
    // the rule's). Crucially auto_matched is forbidden because
    // never_match is supposed to short-circuit matching.
    const neverStatus = await getMatchStatus(neverMatchId);
    assert(
      neverStatus !== "blocked"
        && neverStatus !== "dismissed"
        && neverStatus !== "auto_matched",
      `never_match must skip matching and leave row unmatched (got '${neverStatus}')`,
    );

    // The untouched email had no matching rule. Hard-match has no clients
    // configured in the sandbox, so it stays in some non-blocked /
    // non-dismissed state. We only assert the negative — filter rules did
    // not incorrectly transition it.
    const passStatus = await getMatchStatus(untouchedId);
    assert(
      passStatus !== "blocked" && passStatus !== "dismissed",
      `untouched email must not be blocked/dismissed (got '${passStatus}')`,
    );
  });
  console.log("  [PASS] reEvaluateExistingUnmatched applies block + dismiss + never_match rules");

  // The same applyFilterRulesToSyncEmail helper is wired into
  // reprocessSyncEmailBatch (Front "reprocess these conversations" UI
  // path). Confirm the rule outcomes are identical there so a future
  // regression in the reprocess call site can't slip past this suite.
  await runInTxSandbox(async () => {
    invalidateFilterRulesCache();
    await seedTestUser("system");
    await seedRule({ type: "block", scope: "sender_email", value: "rep-block@evil.com" });
    await seedRule({ type: "dismiss", scope: "domain", value: "rep-noise.io" });
    invalidateFilterRulesCache();

    const blockedId = await seedSyncEmail({
      conversationId: `conv-rep-block-${TAG}`,
      participants: [p("rep-block@evil.com")],
    });
    const dismissedId = await seedSyncEmail({
      conversationId: `conv-rep-dismiss-${TAG}`,
      participants: [p("hi@rep-noise.io")],
    });

    await reprocessSyncEmailBatch([blockedId, dismissedId]);

    assertEq(await getMatchStatus(blockedId), "blocked", "reprocessSyncEmailBatch honours block rule");
    assertEq(await getMatchStatus(dismissedId), "dismissed", "reprocessSyncEmailBatch honours dismiss rule");
  });
  console.log("  [PASS] reprocessSyncEmailBatch applies the same filter-rule outcomes");
}

// ============================================================
// 7) (type, scope, value) uniqueness invariant
// ============================================================
async function testUniqueness(): Promise<void> {
  await runInTxSandbox(async () => {
    invalidateFilterRulesCache();
    await seedTestUser("ffr-user-uniq");

    await createFilterRule(
      { type: "block", scope: "sender_email", value: "dup@dup.com" },
      "ffr-user-uniq",
    );

    // A duplicate insert aborts the surrounding Postgres transaction, so
    // we wrap it in a SAVEPOINT (drizzle nests `tx.transaction(...)` as
    // a SAVEPOINT) — that way the rollback is local to this attempt and
    // the outer sandbox tx survives for the follow-up assertion below.
    let threw = false;
    try {
      await getDb().transaction(async () => {
        await createFilterRule(
          // Re-uses the canonical normalized value to prove the unique
          // index fires regardless of caller-side casing.
          { type: "block", scope: "sender_email", value: "DUP@DUP.com" },
          "ffr-user-uniq",
        );
      });
    } catch (err) {
      threw = true;
      // drizzle-orm wraps the driver error in a `DrizzleQueryError` whose
      // `.message` is the generic "Failed query: …" and whose `.code` is
      // undefined; the real Postgres SQLSTATE lives on `.cause.code`. Check
      // both so the unique-violation is recognized regardless of wrapping.
      const code =
        (err as { code?: string }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      const message =
        (err as { cause?: { message?: string } }).cause?.message ??
        (err as Error).message;
      // 23505 = unique_violation
      assert(code === "23505" || /unique|duplicate/i.test(message),
        `expected unique-violation, got ${message}`);
    }
    assert(threw, "duplicate (type, scope, value) must reject");

    // Different type with the same (scope, value) is allowed — operators
    // can layer block + never_match on the same target.
    const second = await createFilterRule(
      { type: "never_match", scope: "sender_email", value: "dup@dup.com" },
      "ffr-user-uniq",
    );
    assertEq(second.type, "never_match", "different type with same value is allowed");
  });
  console.log("  [PASS] (type, scope, value) uniqueness enforced");
}

// ============================================================
// 8) Task #2504 — listFilterRules SWR cache is contention-resilient
// ============================================================
//
// The GET /api/integrations/front/filter-rules read used to do a fresh
// per-request SELECT on the api pool, so under a heavy reprocess (pool /
// lock contention) it stalled and 500'd. listFilterRules() now serves from
// a short-lived stale-while-revalidate in-memory cache, so repeated reads
// are answered from memory and never re-hit the DB within the TTL window.
//
// We prove that here WITHOUT simulating real pool contention: warm the
// cache, then mutate the underlying table *behind the cache's back* (a raw
// DELETE that does NOT invalidate). A repeated read must still return the
// cached rows — that "served from memory, no DB round-trip" property is
// exactly what keeps a flood of reads during a reprocess from tripping the
// client retry path. Finally, an explicit CRUD-style invalidation must
// force a fresh read so operator edits remain immediately visible.
async function testListCacheContentionResilience(): Promise<void> {
  await runInTxSandbox(async () => {
    invalidateFilterRulesCache();
    await seedTestUser("ffr-cache");

    const ruleId = await seedRule({
      type: "block",
      scope: "sender_email",
      value: "cache-probe@evil.com",
    });
    // seedRule() invalidates, so this is a genuinely cold read that warms
    // the SWR cache from the DB.
    const warm = await listFilterRules();
    assert(
      warm.some((r) => r.id === ruleId),
      "cold read returns the freshly-seeded rule",
    );
    const warmCount = warm.length;

    // Mutate the table behind the cache's back — a raw DELETE that does NOT
    // call any invalidation helper, standing in for the affected_count /
    // hit-flush churn that happens continuously during a reprocess.
    await getDb().execute(sql`DELETE FROM front_filter_rules WHERE id = ${ruleId}`);

    // Repeated reads within the TTL are served from the warm cache and must
    // NOT observe the behind-the-back delete — this is the no-DB-round-trip
    // property that makes the endpoint contention-resilient.
    for (let i = 0; i < 5; i++) {
      const cached = await listFilterRules();
      assertEq(cached.length, warmCount, `read #${i} served from warm cache`);
      assert(
        cached.some((r) => r.id === ruleId),
        `read #${i} still shows cached rule despite behind-the-back delete`,
      );
    }

    // An explicit CRUD-style invalidation forces a fresh read so operator
    // edits stay immediately visible.
    invalidateFilterRulesCache();
    const fresh = await listFilterRules();
    assert(
      !fresh.some((r) => r.id === ruleId),
      "after invalidation the deleted rule is gone (fresh read)",
    );
  });
  console.log("  [PASS] listFilterRules SWR cache serves repeated reads without re-querying (Task #2504)");
}

// ============================================================
// Runner
// ============================================================
async function main(): Promise<void> {
  console.log("\n=== Front filter rules (Task #825) ===");
  await testNormalize();
  await testTypeScopeMatrix();
  await testPrecedence();
  await testSenderRoleFilter();
  await testCacheInvalidation();
  await testIngestionEndToEnd();
  await testUniqueness();
  await testListCacheContentionResilience();
  console.log("=== ALL FRONT FILTER RULE TESTS PASSED ===\n");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
