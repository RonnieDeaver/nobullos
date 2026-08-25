/* test-registration
{
  "name": "Ads OS label-drift guard staleness watchdog — 30-minute threshold, durable episode dedupe, recovery, kill switch, and singleton lock",
  "regression": true,
  "smoke": true,
  "smokeReason": "The label-drift guard is the only signal that enrolled Ads OS accounts have silently lost monitor labels. This DB-free injected-dependency unit test proves its independent watchdog alerts responsible admins after two missed ticks without spamming, then resets after recovery. No DB, network, or timers.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "medium"
}
test-registration */
// future-date-literal-reviewed: all 2026-08-24 literals are injected clocks
// compared only with each other, never with the real wall clock.
import assert from "node:assert/strict";
import {
  __resetLabelDriftStalenessDepsForTest,
  __setLabelDriftStalenessDepsForTest,
  evaluateLabelDriftStaleness,
  LABEL_DRIFT_STALENESS_INBOX_DEDUPE_PREFIX,
  LABEL_DRIFT_STALENESS_THRESHOLD_MS,
  runLabelDriftStalenessPassOnce,
} from "../server/services/adsOs/labelDriftStalenessWatchdog";

interface State {
  state?: "healthy" | "unhealthy";
  lastNotifiedAt?: Date | null;
  metadataJson?: unknown;
}

async function main() {
  const now = new Date("2026-08-24T12:30:00.000Z");
  let guardState: State | undefined = {
    state: "healthy",
    metadataJson: {
      lastEvaluatedAt: new Date(
        now.getTime() - LABEL_DRIFT_STALENESS_THRESHOLD_MS + 1,
      ).toISOString(),
    },
  };
  let watchdogState: State | undefined;
  let guardReads = 0;
  let releases = 0;
  let notifyFailureFor: string | null = null;
  const sent: Array<{
    userId: string;
    dedupeKey?: string;
    deepLink?: string;
    body?: string;
  }> = [];

  __setLabelDriftStalenessDepsForTest({
    getGuardState: async () => {
      guardReads += 1;
      return guardState;
    },
    getWatchdogState: async () => watchdogState,
    upsertWatchdogState: async (patch) => {
      watchdogState = { ...(watchdogState ?? {}), ...patch };
      return watchdogState;
    },
    getRecipients: async () => ["uid-ceo", "uid-ops"],
    notifyUser: async (userId, opts) => {
      if (userId === notifyFailureFor) {
        throw new Error("injected inbox failure");
      }
      sent.push({
        userId,
        dedupeKey: opts.dedupeKey,
        deepLink: opts.deepLink,
        body: opts.body,
      });
      return {};
    },
    acquireWatchdogLock: async () => ({
      release: async () => {
        releases += 1;
      },
    }),
    isEnabled: async () => true,
    getDeploymentLogsLink: () =>
      "https://replit.com/@nobull/no-bull-os#deployment",
  });

  const fresh = await evaluateLabelDriftStaleness(now);
  assert.equal(fresh.stale, false, "strictly under 30 minutes is fresh");
  assert.equal(sent.length, 0);

  // Missing heartbeat gets a durable 30-minute first-observation grace. A
  // normal boot must not page merely because the guard's first pass is still
  // running (the two scheduler starts have independent jitter).
  guardState = { state: "healthy", metadataJson: {} };
  watchdogState = {
    state: "healthy",
    metadataJson: {
      observedEpisode: "no-valid-pass:missing",
      firstObservedStaleAt: new Date(now.getTime() + 60_000).toISOString(),
    },
  };
  const missingFirstSeen = await evaluateLabelDriftStaleness(now);
  assert.equal(missingFirstSeen.stale, true);
  assert.equal(
    missingFirstSeen.graceRemainingMs,
    LABEL_DRIFT_STALENESS_THRESHOLD_MS,
  );
  assert.equal(sent.length, 0, "missing heartbeat does not alert immediately");
  assert.equal(
    (watchdogState.metadataJson as any).firstObservedStaleAt,
    now.toISOString(),
    "implausibly future watchdog stamps reset instead of extending grace",
  );
  const missingStillGrace = await evaluateLabelDriftStaleness(
    new Date(now.getTime() + LABEL_DRIFT_STALENESS_THRESHOLD_MS - 1),
  );
  assert.equal(missingStillGrace.notified.length, 0);
  const missingOverdue = await evaluateLabelDriftStaleness(
    new Date(now.getTime() + LABEL_DRIFT_STALENESS_THRESHOLD_MS),
  );
  assert.deepEqual(
    missingOverdue.notified,
    ["uid-ceo", "uid-ops"],
    "missing heartbeat alerts only after durable grace expires",
  );

  // Start the valid-heartbeat episode with clean state/counts.
  sent.length = 0;
  watchdogState = undefined;
  guardState = {
    state: "healthy",
    metadataJson: {
      lastEvaluatedAt: new Date(
        now.getTime() - LABEL_DRIFT_STALENESS_THRESHOLD_MS,
      ).toISOString(),
    },
  };
  const stale = await runLabelDriftStalenessPassOnce({ now });
  assert.equal(stale?.stale, true, "exactly 30 minutes is stale");
  assert.deepEqual(stale?.notified, ["uid-ceo", "uid-ops"]);
  assert.equal(sent.length, 2, "one bell per responsible admin");
  assert.equal(releases, 1, "singleton lock is released");
  const firstEpisodeDedupeKey = sent[0].dedupeKey;
  for (const notification of sent) {
    assert.match(
      notification.dedupeKey ?? "",
      new RegExp(`^${LABEL_DRIFT_STALENESS_INBOX_DEDUPE_PREFIX}`),
    );
    assert.equal(
      notification.deepLink,
      "https://replit.com/@nobull/no-bull-os#deployment",
      "bell links to the deployment pane/logs",
    );
    assert.match(notification.body ?? "", /deployment logs/i);
  }

  const repeated = await runLabelDriftStalenessPassOnce({ now });
  assert.deepEqual(repeated?.notified, []);
  assert.equal(sent.length, 2, "durable episode ledger prevents tick spam");

  // A DIFFERENT invalid episode does not inherit an older unhealthy
  // incident's age. Missing starts grace; changing to malformed resets it.
  guardState = { state: "healthy", metadataJson: {} };
  const missingAfterValidStale = await evaluateLabelDriftStaleness(now);
  assert.equal(missingAfterValidStale.notified.length, 0);
  assert.equal(
    missingAfterValidStale.graceRemainingMs,
    LABEL_DRIFT_STALENESS_THRESHOLD_MS,
    "valid-stale/unhealthy → missing starts a new grace window",
  );
  const invalidTransitionAt = new Date(
    now.getTime() + LABEL_DRIFT_STALENESS_THRESHOLD_MS - 1,
  );
  guardState = {
    state: "healthy",
    metadataJson: { lastEvaluatedAt: "not-an-iso-timestamp" },
  };
  const invalidTransition = await evaluateLabelDriftStaleness(
    invalidTransitionAt,
  );
  assert.equal(invalidTransition.notified.length, 0);
  assert.equal(
    invalidTransition.graceRemainingMs,
    LABEL_DRIFT_STALENESS_THRESHOLD_MS,
    "changing invalid reason resets grace deterministically",
  );
  const invalidOverdueAt = new Date(
    invalidTransitionAt.getTime() + LABEL_DRIFT_STALENESS_THRESHOLD_MS,
  );
  const invalidOverdue = await evaluateLabelDriftStaleness(invalidOverdueAt);
  assert.deepEqual(invalidOverdue.notified, ["uid-ceo", "uid-ops"]);

  // Recovery clears both active and observing episode metadata. A later
  // missing heartbeat starts a completely new grace window.
  guardState = {
    state: "healthy",
    metadataJson: { lastEvaluatedAt: invalidOverdueAt.toISOString() },
  };
  const transitionRecovery = await evaluateLabelDriftStaleness(
    invalidOverdueAt,
  );
  assert.equal(transitionRecovery.stale, false);
  assert.equal(
    (watchdogState?.metadataJson as any).observedEpisode,
    undefined,
  );
  guardState = { state: "healthy", metadataJson: {} };
  const missingAfterRecovery = await evaluateLabelDriftStaleness(
    invalidOverdueAt,
  );
  assert.equal(missingAfterRecovery.notified.length, 0);
  assert.equal(
    missingAfterRecovery.graceRemainingMs,
    LABEL_DRIFT_STALENESS_THRESHOLD_MS,
    "recovery → invalid starts grace anew",
  );

  // A per-recipient rejection must not block the other admin, and each
  // successful delivery is persisted before the loop advances.
  const partialNow = new Date("2026-08-24T12:44:00.000Z");
  guardState = {
    state: "healthy",
    metadataJson: {
      lastEvaluatedAt: new Date(
        partialNow.getTime() - LABEL_DRIFT_STALENESS_THRESHOLD_MS,
      ).toISOString(),
    },
  };
  watchdogState = undefined;
  sent.length = 0;
  notifyFailureFor = "uid-ops";
  const partial = await runLabelDriftStalenessPassOnce({ now: partialNow });
  assert.deepEqual(partial?.notified, ["uid-ceo"]);
  assert.deepEqual(partial?.failed, ["uid-ops"]);
  assert.deepEqual(
    (watchdogState?.metadataJson as any).notifiedRecipients,
    ["uid-ceo"],
    "accepted delivery is durably recorded before the next recipient",
  );
  notifyFailureFor = null;
  const partialRetry = await runLabelDriftStalenessPassOnce({
    now: partialNow,
  });
  assert.deepEqual(partialRetry?.notified, ["uid-ops"]);
  assert.equal(sent.length, 2, "retry sends only the previously failed admin");

  sent.length = 0;
  const recoveredAt = new Date("2026-08-24T12:45:00.000Z");
  guardState = {
    state: "healthy",
    metadataJson: { lastEvaluatedAt: recoveredAt.toISOString() },
  };
  const recovered = await runLabelDriftStalenessPassOnce({
    now: new Date("2026-08-24T12:46:00.000Z"),
  });
  assert.equal(recovered?.stale, false);
  assert.equal(watchdogState?.state, "healthy", "fresh pass closes the episode");

  const later = new Date("2026-08-24T13:15:00.000Z");
  const secondEpisode = await runLabelDriftStalenessPassOnce({ now: later });
  assert.equal(secondEpisode?.stale, true);
  assert.equal(sent.length, 2, "a later independent stale episode alerts again");
  assert.notEqual(
    sent[0].dedupeKey,
    firstEpisodeDedupeKey,
    "episode heartbeat is part of the inbox dedupe key",
  );

  __setLabelDriftStalenessDepsForTest({
    isEnabled: async () => false,
    acquireWatchdogLock: async () => {
      throw new Error("disabled watchdog must not take its lock");
    },
  });
  const readsBeforeDisabled = guardReads;
  assert.equal(await runLabelDriftStalenessPassOnce({ now }), null);
  assert.equal(guardReads, readsBeforeDisabled, "kill switch skips all reads");

  __setLabelDriftStalenessDepsForTest({
    isEnabled: async () => true,
    acquireWatchdogLock: async () => null,
  });
  assert.equal(await runLabelDriftStalenessPassOnce({ now }), null);
  assert.equal(guardReads, readsBeforeDisabled, "lost lock skips all reads");

  __resetLabelDriftStalenessDepsForTest();
  console.log(
    "ads-os-label-drift-staleness-watchdog: all assertions passed",
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);