/* test-registration
{
  "name": "Ads OS monitor-label drift guard — daily per-user consolidation, dedupe, re-fire, unknowns, retries, kill switch + lock skip",
  "regression": true,
  "smoke": true,
  "smokeReason": "This evaluator is the only thing that tells the team when an enrolled account drifts back to zero monitor labels (its dashboards silently read $0.00 again). A daily-recipient grouping or dedupe regression either floods the inbox or collapses recurring escalation into one forever-unread row. Fully injected deps — no DB, no network, no timers.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Drift-guard semantics, all through injected deps:
 *
 *   1. One zero-label account → its existing single-account bell, one per
 *      recipient. Multiple zero-label accounts → one consolidated bell per
 *      recipient, listing every name and account ID. Dedupe is always
 *      `ads_os.label_drift:<ET day>:<uid>`.
 *   2. Second pass same day → durable completed-day stamp short-circuits:
 *      zero notifies (no intra-day spam), even across "restarts" (state is
 *      durable, not in-module).
 *   3. Next ET day, condition persists → re-fires with the new day's keys.
 *   4. "unknown" classifications never alert or advance the completed-pass
 *      heartbeat.
 *   5. Partial delivery failure keeps the day open; the retry pass delivers
 *      ONLY the missing recipient (ledger dedupes the delivered one).
 *   6. runLabelDriftPassOnce: disabled kill switch and a lost lock both
 *      skip without classifying.
 */
// future-date-literal-reviewed: 2026-08-18/19/20/21/22/23T12:00:00Z are PINNED
// injected clocks passed directly to evaluateLabelDrift(now)/labelDriftDayStamp(now)
// — every assertion compares these literals against each other (same day vs next
// day), never against the real clock, so they cannot rot when the dates pass.
import assert from "node:assert/strict";
import {
  evaluateLabelDrift,
  runLabelDriftPassOnce,
  labelDriftDayStamp,
  __setLabelDriftDepsForTest,
  __resetLabelDriftDepsForTest,
  LABEL_DRIFT_INBOX_DEDUPE_PREFIX,
} from "../server/services/adsOs/labelDriftGuard";
import type { AccountLabelCoverage } from "../server/services/adsOs/labelCoverage";

function acct(
  cid: string,
  name: string,
  coverage: AccountLabelCoverage["coverage"],
  active: string[] = ["1", "2"],
): AccountLabelCoverage {
  return {
    customer_id: cid,
    descriptive_name: name,
    coverage,
    activeCampaignIds: active,
    labeledActiveCampaignIds: [],
  };
}

// In-memory durable state (simulates notification_health_state across
// "restarts" — the module keeps nothing in RAM between passes).
function makeStateStore() {
  let state: { metadataJson?: unknown } | undefined;
  return {
    getState: async () => state,
    upsertState: async (patch: any) => {
      state = { ...(state ?? {}), ...patch };
      return state;
    },
    read: () => state,
  };
}

async function main() {
  // Fixed instants: two on the same ET day, one the next ET day (noon UTC is
  // mid-morning ET — no midnight-boundary ambiguity).
  const day1a = new Date("2026-08-18T12:00:00Z");
  const day1b = new Date("2026-08-18T18:00:00Z");
  const day2 = new Date("2026-08-19T12:00:00Z");
  assert.equal(labelDriftDayStamp(day1a), labelDriftDayStamp(day1b));
  assert.notEqual(labelDriftDayStamp(day1a), labelDriftDayStamp(day2));

  const store = makeStateStore();
  const sent: Array<{ uid: string; dedupeKey?: string; title: string; body?: string }> = [];
  let notifyFailFor: string | null = null;

  __setLabelDriftDepsForTest({
    classify: async () => [
      acct("1085092927", "Geman Law", "zero", ["10", "11"]),
      acct("2222222222", "Weber Law", "partial"),
    ],
    getState: store.getState,
    upsertState: store.upsertState,
    getRecipients: async () => ["uid-ceo", "uid-lead"],
    notifyUser: async (uid, opts) => {
      if (uid === notifyFailFor) throw new Error("inbox write failed");
      sent.push({ uid, dedupeKey: opts.dedupeKey, title: opts.title, body: opts.body });
      return {};
    },
  });

  // ── 1. One zero-label account preserves the account-specific bell ────────
  const r1 = await evaluateLabelDrift(day1a);
  assert.ok(r1 && !r1.alreadyComplete);
  assert.deepEqual(r1!.zeroLabelCids, ["1085092927"], "partial coverage never alerts");
  assert.equal(sent.length, 2);
  const d1 = labelDriftDayStamp(day1a);
  for (const s of sent) {
    assert.equal(
      s.dedupeKey,
      `${LABEL_DRIFT_INBOX_DEDUPE_PREFIX}${d1}:${s.uid}`,
      "day+user scoped dedupe key — never constant",
    );
    assert.match(s.title, /Geman Law/);
    assert.match(s.body ?? "", /Geman Law \(1085092927\)/);
  }

  // ── 2. Same-day re-pass: durable stamp short-circuits, zero sends ───────
  const r2 = await evaluateLabelDrift(day1b);
  assert.ok(r2!.alreadyComplete, "completed day short-circuits");
  assert.equal(sent.length, 2, "no intra-day spam");
  assert.equal(
    ((store.read() as any).metadataJson as any).lastEvaluatedAt,
    day1b.toISOString(),
    "same-day short-circuit still refreshes the completed-pass heartbeat",
  );

  // ── 3. Next day, condition persists: re-fires with new day's keys ───────
  const r3 = await evaluateLabelDrift(day2);
  assert.ok(!r3!.alreadyComplete);
  assert.equal(sent.length, 4, "daily re-fire while the condition persists");
  assert.equal(
    sent[2].dedupeKey,
    `${LABEL_DRIFT_INBOX_DEDUPE_PREFIX}${labelDriftDayStamp(day2)}:uid-ceo`,
  );

  // ── 5. Partial delivery failure keeps the day open, retry fills the gap ──
  const day3 = new Date("2026-08-20T12:00:00Z");
  notifyFailFor = "uid-lead";
  const r5a = await evaluateLabelDrift(day3);
  assert.deepEqual(r5a!.failed, ["uid-lead"]);
  assert.equal(sent.length, 5, "ceo delivered despite lead failure");
  notifyFailFor = null;
  const r5b = await evaluateLabelDrift(day3);
  assert.ok(!r5b!.alreadyComplete, "failed delivery keeps the day open");
  assert.deepEqual(r5b!.notified, ["uid-lead"], "retry delivers ONLY the missing recipient");
  assert.equal(sent.length, 6);
  const r5c = await evaluateLabelDrift(day3);
  assert.ok(r5c!.alreadyComplete, "day completes once every due row delivered");

  // ── Multiple accounts consolidate into one complete summary per recipient ─
  const dayMulti = new Date("2026-08-21T12:00:00Z");
  __setLabelDriftDepsForTest({
    classify: async () => [
      acct("1085092927", "Geman Law", "zero", ["10", "11"]),
      acct("3333333333", "Harper Legal", "zero", ["20"]),
      acct("5555555555", "Mystery Law", "unknown"),
    ],
  });
  const multiStart = sent.length;
  const multi = await evaluateLabelDrift(dayMulti);
  assert.deepEqual(multi!.zeroLabelCids, ["1085092927", "3333333333"]);
  assert.deepEqual(multi!.notified, ["uid-ceo", "uid-lead"]);
  assert.equal(sent.length, multiStart + 2, "one consolidated bell per recipient");
  for (const s of sent.slice(multiStart)) {
    assert.equal(
      s.dedupeKey,
      `${LABEL_DRIFT_INBOX_DEDUPE_PREFIX}${labelDriftDayStamp(dayMulti)}:${s.uid}`,
    );
    assert.match(s.title, /2 accounts/);
    assert.match(s.body ?? "", /Geman Law \(1085092927;/);
    assert.match(s.body ?? "", /Harper Legal \(3333333333;/);
  }

  // ── 4. All-unknown pass: no alert, no completed-day or heartbeat advance ──
  const heartbeatBeforeUnknown = ((store.read() as any).metadataJson as any)
    .lastEvaluatedAt;
  const unknownDay = new Date("2026-08-22T12:00:00Z");
  __setLabelDriftDepsForTest({
    classify: async () => [acct("5555555555", "Mystery Law", "unknown")],
  });
  const beforeUnknown = sent.length;
  const unknownResult = await evaluateLabelDrift(unknownDay);
  assert.equal(unknownResult!.unknownCount, 1);
  assert.equal(sent.length, beforeUnknown, "unknown classifications never alert");
  assert.equal(
    ((store.read() as any).metadataJson as any).lastEvaluatedAt,
    heartbeatBeforeUnknown,
    "unknown-only pass preserves the previous completed-pass heartbeat",
  );
  assert.notEqual(
    ((store.read() as any).metadataJson as any).completedDay,
    labelDriftDayStamp(unknownDay),
    "unknown-only pass does not complete the day",
  );

  // ── Healthy portfolio: state flips healthy, nothing sent ─────────────────
  const day4 = new Date("2026-08-23T12:00:00Z");
  __setLabelDriftDepsForTest({
    classify: async () => [acct("1085092927", "Geman Law", "full")],
  });
  const before = sent.length;
  const r6 = await evaluateLabelDrift(day4);
  assert.deepEqual(r6!.zeroLabelCids, []);
  assert.equal(sent.length, before, "healthy day sends nothing");
  assert.equal((store.read() as any).state, "healthy");

  // ── 6. Pass wrapper: kill switch + lock skip without classifying ────────
  let classified = 0;
  __setLabelDriftDepsForTest({
    classify: async () => {
      classified += 1;
      return [];
    },
    isEnabled: async () => false,
    acquireEvaluatorLock: async () => {
      throw new Error("lock must not be taken while disabled");
    },
  });
  assert.equal(await runLabelDriftPassOnce(), null, "kill switch skips");
  __setLabelDriftDepsForTest({
    isEnabled: async () => true,
    acquireEvaluatorLock: async () => null, // sibling instance owns the tick
  });
  assert.equal(await runLabelDriftPassOnce(), null, "lost lock skips");
  assert.equal(classified, 0, "skipped passes never classify (no Ads API load)");

  __resetLabelDriftDepsForTest();
  console.log("ads-os-label-drift-guard: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
