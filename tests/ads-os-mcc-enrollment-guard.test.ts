/* test-registration
{
  "name": "Ads OS MCC enrollment guard — client+CID copy, ET-day dedupe, daily re-fire, partial delivery retry, source-failure non-observation, kill switch and lock skip",
  "regression": true,
  "smoke": true,
  "smokeReason": "This evaluator is the only automatic signal when a ClickUp-enrolled account disappears from the Google Ads MCC. The injected unit contract prevents silent drops, intra-day Slack spam, stale-directory false alerts, and loss of retry state without DB or vendor egress.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "medium"
}
test-registration */
// future-date-literal-reviewed: the 2026-08-18 through 2026-08-23 instants are injected
// clocks used only for same-day/next-day comparisons and never compared with now.

import assert from "node:assert/strict";
import {
  findMissingClickUpEnrolledAccounts,
  MCC_ENROLLMENT_ALERT_DEDUPE_PREFIX,
  __resetMccEnrollmentGuardDepsForTest,
  __setMccEnrollmentGuardDepsForTest,
  evaluateMccEnrollmentGuard,
  mccEnrollmentDayStamp,
  runMccEnrollmentGuardPassOnce,
  type MissingMccEnrollment,
} from "../server/services/adsOs/enrollmentMissingGuard";
import type { MccAccounts } from "../server/services/adsOs/enrollment";

function missing(
  cid: string,
  clientName: string,
  products: MissingMccEnrollment["products"] = ["gads"],
): MissingMccEnrollment {
  return { cid, clientName, products };
}

function makeStateStore() {
  let state: { metadataJson?: unknown; state?: string } | undefined;
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
  const compared = findMissingClickUpEnrolledAccounts(
    [
      {
        name: "Enabled Client",
        gads_cids: ["111-111-1111"],
        lsa_cids: [],
      },
      {
        name: "Alpha Legal",
        gads_cids: ["319-748-5605"],
        lsa_cids: [],
      },
      {
        name: "Bravo Law",
        gads_cids: ["4333959201"],
        lsa_cids: ["433-395-9201"],
      },
    ],
    new Map([
      ["1111111111", { name: "Enabled Account", currency: "USD" }],
    ]) as MccAccounts,
  );
  assert.deepEqual(compared, [
    {
      cid: "3197485605",
      clientName: "Alpha Legal",
      products: ["gads"],
    },
    {
      cid: "4333959201",
      clientName: "Bravo Law",
      products: ["gads", "lsa"],
    },
  ]);

  const day1a = new Date("2026-08-18T12:00:00Z");
  const day1b = new Date("2026-08-18T18:00:00Z");
  const day2 = new Date("2026-08-19T12:00:00Z");
  assert.equal(mccEnrollmentDayStamp(day1a), mccEnrollmentDayStamp(day1b));
  assert.notEqual(mccEnrollmentDayStamp(day1a), mccEnrollmentDayStamp(day2));

  const store = makeStateStore();
  const accounts = [
    missing("3197485605", "Alpha Legal"),
    missing("4333959201", "Bravo Law", ["gads", "lsa"]),
  ];
  const sentBells: Array<{
    uid: string;
    cid: string;
    title: string;
    dedupeKey: string;
    deepLink: string;
  }> = [];
  const sentSlack: Array<{ cid: string; text: string }> = [];
  let failSlackCid: string | null = null;
  let failBellKey: string | null = null;
  let scans = 0;

  __setMccEnrollmentGuardDepsForTest({
    scan: async () => {
      scans += 1;
      return accounts;
    },
    getState: store.getState,
    upsertState: store.upsertState,
    getRecipients: async () => ["uid-ceo", "uid-lead"],
    notifyUser: async (uid, options) => {
      const cid = String(options.metadata.customerId);
      if (`${cid}:${uid}` === failBellKey) {
        return null;
      }
      sentBells.push({
        uid,
        cid,
        title: options.title,
        dedupeKey: options.dedupeKey,
        deepLink: options.deepLink,
      });
      return {};
    },
    postSlack: async (text) => {
      const cid = accounts.find((account) => text.includes(account.cid))!.cid;
      if (cid === failSlackCid) {
        return { sent: false, reason: "stubbed Slack failure" };
      }
      sentSlack.push({ cid, text });
      return { sent: true };
    },
  });

  const first = await evaluateMccEnrollmentGuard(day1a);
  assert.ok(first && !first.alreadyComplete);
  assert.deepEqual(first!.missingCids, ["3197485605", "4333959201"]);
  assert.equal(first!.notified.length, 6, "two bells + one Slack delivery per CID");
  assert.equal(sentBells.length, 4, "one bell per missing CID and responsible admin");
  assert.equal(sentSlack.length, 2, "one Slack message per missing CID");
  const day1 = mccEnrollmentDayStamp(day1a);
  for (const delivery of sentBells) {
    assert.equal(
      delivery.dedupeKey,
      `${MCC_ENROLLMENT_ALERT_DEDUPE_PREFIX}${day1}:${delivery.cid}:${delivery.uid}`,
    );
    assert.match(delivery.title, new RegExp(delivery.cid));
    assert.equal(delivery.deepLink, "/ads-os");
  }
  assert.match(sentBells[0].title, /Alpha Legal/);
  assert.match(sentSlack[0].text, /Alpha Legal.*3197485605/);
  assert.match(sentSlack[1].text, /Bravo Law.*4333959201/);
  assert.match(sentSlack[1].text, /Google Ads \+ LSA/);

  const sameDay = await evaluateMccEnrollmentGuard(day1b);
  assert.ok(sameDay!.alreadyComplete, "durable day stamp short-circuits");
  assert.equal(sentBells.length, 4, "no intra-day duplicate bells");
  assert.equal(sentSlack.length, 2, "no intra-day duplicate Slack messages");
  assert.equal(scans, 1, "completed day skips both ClickUp and MCC reads");

  const nextDay = await evaluateMccEnrollmentGuard(day2);
  assert.ok(!nextDay!.alreadyComplete);
  assert.equal(sentBells.length, 8, "persistent mismatch re-fires bells next ET day");
  assert.equal(sentSlack.length, 4, "persistent mismatch re-fires Slack next ET day");

  const day3 = new Date("2026-08-20T12:00:00Z");
  failBellKey = "3197485605:uid-lead";
  failSlackCid = "4333959201";
  const partial = await evaluateMccEnrollmentGuard(day3);
  assert.deepEqual(partial!.failed, [
    "3197485605:bell:uid-lead",
    "4333959201:slack",
  ]);
  const bellsAfterPartial = sentBells.length;
  const slackAfterPartial = sentSlack.length;

  failBellKey = null;
  failSlackCid = null;
  const retried = await evaluateMccEnrollmentGuard(day3);
  assert.ok(!retried!.alreadyComplete, "failed delivery keeps the day open");
  assert.equal(
    sentBells.length,
    bellsAfterPartial + 1,
    "retry sends only the bell recipient absent from the durable ledger",
  );
  assert.equal(
    sentSlack.length,
    slackAfterPartial + 1,
    "retry sends only the Slack/CID dimension absent from the durable ledger",
  );
  const complete = await evaluateMccEnrollmentGuard(day3);
  assert.ok(complete!.alreadyComplete);

  const day4 = new Date("2026-08-21T12:00:00Z");
  const day4Stamp = mccEnrollmentDayStamp(day4);
  let failDay4CompletionWrite = true;
  __setMccEnrollmentGuardDepsForTest({
    upsertState: async (patch: any) => {
      const patchMetadata = (patch.metadataJson ?? {}) as Record<string, unknown>;
      if (
        failDay4CompletionWrite &&
        patchMetadata.completedDay === day4Stamp
      ) {
        throw new Error("stubbed final completion write failure");
      }
      return store.upsertState(patch);
    },
  });
  const bellsBeforeCommitFailure = sentBells.length;
  const slackBeforeCommitFailure = sentSlack.length;
  assert.equal(
    await evaluateMccEnrollmentGuard(day4),
    null,
    "a failed final completion write is a non-observation",
  );
  assert.equal(sentBells.length, bellsBeforeCommitFailure + 4);
  assert.equal(sentSlack.length, slackBeforeCommitFailure + 2);

  failDay4CompletionWrite = false;
  const recoveredCompletion = await evaluateMccEnrollmentGuard(day4);
  assert.ok(recoveredCompletion && !recoveredCompletion.alreadyComplete);
  assert.equal(
    sentBells.length,
    bellsBeforeCommitFailure + 4,
    "persisted per-recipient progress prevents duplicate bells after final write failure",
  );
  assert.equal(
    sentSlack.length,
    slackBeforeCommitFailure + 2,
    "persisted per-CID progress prevents duplicate Slack after final write failure",
  );

  const day5 = new Date("2026-08-22T12:00:00Z");
  __setMccEnrollmentGuardDepsForTest({ scan: async () => [] });
  const healthy = await evaluateMccEnrollmentGuard(day5);
  assert.deepEqual(healthy!.missingCids, []);
  assert.equal(store.read()!.state, "healthy");

  const beforeFailedRead = store.read();
  __setMccEnrollmentGuardDepsForTest({
    scan: async () => {
      throw new Error("ClickUp directory is stale");
    },
  });
  const sourceFailure = await evaluateMccEnrollmentGuard(
    new Date("2026-08-23T12:00:00Z"),
  );
  assert.equal(sourceFailure, null, "failed source read is a non-observation");
  assert.equal(
    store.read(),
    beforeFailedRead,
    "source failure does not advance healthy/completed state",
  );

  let wrappedScans = 0;
  __setMccEnrollmentGuardDepsForTest({
    scan: async () => {
      wrappedScans += 1;
      return [];
    },
    isEnabled: async () => false,
    acquireEvaluatorLock: async () => {
      throw new Error("disabled pass must not acquire the lock");
    },
  });
  assert.equal(await runMccEnrollmentGuardPassOnce(), null);
  __setMccEnrollmentGuardDepsForTest({
    isEnabled: async () => true,
    acquireEvaluatorLock: async () => null,
  });
  assert.equal(await runMccEnrollmentGuardPassOnce(), null);
  assert.equal(wrappedScans, 0, "disabled/lost-lock passes make no vendor reads");

  __resetMccEnrollmentGuardDepsForTest();
  console.log("ads-os-mcc-enrollment-guard: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
