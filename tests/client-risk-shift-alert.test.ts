/* test-registration
{
  "name": "Client risk-shift alerts — transition classification (severity ordering, score-jump boundary, contradictory reads), once-per-streak no-repeat + escalation re-alert + recovery re-arm via markRecovered, mass-degradation bundling, kill-switch suppression with recovery still marked, tunable threshold fallback, director+ ∪ owner in-app fan-out under the client-risk-shift: dedupe prefix (Task #3693)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3693: client risk-shift alerts — the morning-degradation notification path (transition classification, once-per-streak with recovery re-arm, bundling, kill switch, director+/owner fan-out). Injected dispatcher/recipients/settings, DB-free, fast; a drift here silently stops the team hearing about client health slips.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3693 — Client risk-shift alerts.
 *
 * Covers, hermetically (injected dispatcher + notifyUser + recipients +
 * settings reader + previous-judgment loader — no DB, no network):
 *  (a) classifyRiskShift: explicit severity ordering across every
 *      degradation pair, score-jump boundary (== threshold silent,
 *      > threshold alerts), recovery via status improvement or score
 *      drop, no-baseline → none, unknown statuses, contradictory reads
 *      classify degraded (under-alerting is the worse failure);
 *  (b) individual dispatch: per-client dispatcher dedupe key +
 *      skipAdminInAppMirror, in-app rows to director+ ∪ client owner
 *      with the `client-risk-shift:` dedupe prefix, payload carries
 *      old→new status, headline, top concerns, and the client deep link;
 *  (c) once-per-streak: a still-degraded day is silent, a FURTHER slip
 *      re-alerts with a new failureType, recovery calls markRecovered
 *      (re-arm) and sends nothing;
 *  (d) bundling: >= CLIENT_RISK_SHIFT_BUNDLE_THRESHOLD degradations in
 *      one run send exactly ONE bundled alert + one in-app row per
 *      recipient (union of directors and all degraded clients' owners);
 *  (e) kill switch: suppresses all notifications but recovery marking
 *      still runs; flipping it back mid-streak alerts again;
 *  (f) threshold setting: tunes the jump bar; non-numeric / non-positive
 *      values fall back to the default;
 *  (g) recordJudgmentForRiskShift: snapshot extraction (overallStatus
 *      preferred over legacy status, headline from summaryText's first
 *      sentence, top-3 concerns) and a throwing loader never throws past
 *      the hook.
 *
 * All notification assertions are scoped by the `client-risk-shift:`
 * dedupe-key prefix (in-app) / `client:`+`bulk:` dispatcher keys so this
 * suite stays additive next to existing notification-count tests.
 */
import { strict as assert } from "node:assert";

async function main() {
  const alert = await import("../server/services/clientRiskShiftAlert");
  const {
    classifyRiskShift,
    beginClientRiskShiftRun,
    recordJudgmentForRiskShift,
    dispatchClientRiskShiftAlerts,
    DEFAULT_RISK_SCORE_JUMP_THRESHOLD,
    CLIENT_RISK_SHIFT_BUNDLE_THRESHOLD,
    CLIENT_RISK_SHIFT_DEDUPE_PREFIX,
    JUDGMENT_STATUS_SEVERITY,
  } = alert;
  const { notificationId } = alert.__getClientRiskShiftKeysForTest();

  // ── Captured collaborator calls ─────────────────────────────────────────
  const notifies: Array<{ id: string; text: string; opts: any }> = [];
  const recoveries: Array<{ id: string; dedupeKey: string }> = [];
  const inApp: Array<{ uid: string; opts: any }> = [];
  let killValue: string | null = null;
  let thresholdValue: string | null = null;

  const ownersByClient: Record<string, string[]> = {
    "c-own": ["owner-1"],
    "c-b1": ["owner-1"],
  };

  alert.__setClientRiskShiftDepsForTest({
    notifyByType: (async (id: string, payload: any, opts: any) => {
      notifies.push({ id, text: payload.text, opts });
      return { delivered: true } as any;
    }) as any,
    markRecovered: (async (id: string, dedupeKey: string) => {
      recoveries.push({ id, dedupeKey });
    }) as any,
    notifyUser: (async (uid: string, opts: any) => {
      inApp.push({ uid, opts });
      return null;
    }) as any,
    getDirectorPlusUsers: async () => ["director-1", "ceo-1"],
    getClientOwners: async (clientId: string) => ownersByClient[clientId] ?? [],
    getSystemSetting: async (key: string) => {
      if (key === alert.KILL_SWITCH_CLIENT_RISK_SHIFT_ALERT) {
        return killValue === null ? undefined : { value: killValue };
      }
      if (key === alert.CLIENT_RISK_SHIFT_SCORE_JUMP_THRESHOLD_SETTING) {
        return thresholdValue === null ? undefined : { value: thresholdValue };
      }
      return undefined;
    },
  });

  const reset = () => {
    notifies.length = 0;
    recoveries.length = 0;
    inApp.length = 0;
  };
  const myInApp = () =>
    inApp.filter((n) =>
      String(n.opts?.dedupeKey ?? "").startsWith(CLIENT_RISK_SHIFT_DEDUPE_PREFIX),
    );

  // ── (a) classifyRiskShift ───────────────────────────────────────────────
  const T = DEFAULT_RISK_SCORE_JUMP_THRESHOLD;
  assert.deepEqual(
    Object.entries(JUDGMENT_STATUS_SEVERITY).sort((x, y) => x[1] - y[1]).map(([s]) => s),
    ["Healthy", "Watch", "At Risk", "Critical"],
    "severity ordering is Healthy < Watch < At Risk < Critical",
  );

  const snap = (status: string | null, riskScore: number | null) => ({ status, riskScore });

  assert.equal(
    classifyRiskShift(null, snap("Critical", 90), T).kind,
    "none",
    "first-ever judgment has no baseline → none (even straight to Critical)",
  );
  assert.equal(
    classifyRiskShift(snap("Healthy", 20), snap("Healthy", 25), T).kind,
    "none",
    "stable status + small wobble → none",
  );
  for (const [from, to] of [
    ["Healthy", "Watch"],
    ["Watch", "At Risk"],
    ["At Risk", "Critical"],
    ["Healthy", "Critical"],
    ["Watch", "Critical"],
    ["Healthy", "At Risk"],
  ] as const) {
    const c = classifyRiskShift(snap(from, 30), snap(to, 30), T);
    assert.equal(c.kind, "degraded", `${from}→${to} classifies degraded`);
    assert.equal(c.statusDegraded, true, `${from}→${to} sets statusDegraded`);
  }
  const improved = classifyRiskShift(snap("At Risk", 60), snap("Watch", 55), T);
  assert.equal(improved.kind, "recovered", "status improvement → recovered");
  assert.equal(improved.statusImproved, true, "statusImproved set");

  assert.equal(
    classifyRiskShift(snap("Watch", 30), snap("Watch", 30 + T), T).kind,
    "none",
    "score delta EXACTLY at threshold stays silent (strictly-more-than contract)",
  );
  const jumped = classifyRiskShift(snap("Watch", 30), snap("Watch", 30 + T + 1), T);
  assert.equal(jumped.kind, "degraded", "score jump past threshold → degraded");
  assert.equal(jumped.scoreJumped, true, "scoreJumped set");
  assert.equal(jumped.statusDegraded, false, "same status: no statusDegraded");

  const dropped = classifyRiskShift(snap("Watch", 80), snap("Watch", 80 - T - 1), T);
  assert.equal(dropped.kind, "recovered", "score drop past threshold → recovered (re-arms score-only streaks)");

  assert.equal(
    classifyRiskShift(snap("Critical", 30), snap("Watch", 30 + T + 1), T).kind,
    "degraded",
    "contradictory read (status improved BUT score jumped) classifies degraded",
  );
  assert.equal(
    classifyRiskShift(snap("Watch", 80), snap("At Risk", 40), T).kind,
    "degraded",
    "status degradation wins even when the score fell",
  );
  assert.equal(
    classifyRiskShift(snap("Bogus", null), snap("Watch", null), T).kind,
    "none",
    "unknown prev status + no scores → no signal on either axis",
  );
  assert.equal(
    classifyRiskShift(snap(null, null), snap("Critical", null), T).kind,
    "none",
    "null prev status + null scores → none",
  );
  assert.equal(
    classifyRiskShift(snap("Healthy", null), snap("Watch", null), T).kind,
    "degraded",
    "status axis alone degrades when scores are missing",
  );
  assert.equal(
    classifyRiskShift(snap("Watch", null), snap("Watch", 90), T).kind,
    "none",
    "score axis needs BOTH sides numeric",
  );

  // ── (b) individual dispatch ─────────────────────────────────────────────
  reset();
  const day1 = beginClientRiskShiftRun();
  day1.entries.push(
    {
      clientId: "c-own",
      clientName: "Acme Law",
      judgmentDate: "2026-08-03",
      prev: snap("Healthy", 30),
      curr: snap("Watch", 60),
      headline: "Client has gone quiet after the invoice conversation.",
      concerns: ["No reply in 9 days", "Invoice dispute open"],
    },
    {
      clientId: "c-stable",
      clientName: "Steady LLP",
      judgmentDate: "2026-08-03",
      prev: snap("Healthy", 20),
      curr: snap("Healthy", 22),
      headline: null,
      concerns: [],
    },
  );
  let summary = await dispatchClientRiskShiftAlerts(day1);
  assert.equal(summary.evaluated, 2, "both entries evaluated");
  assert.equal(summary.degraded, 1, "one degradation detected");
  assert.equal(summary.alertsSent, 1, "one dispatcher alert sent");
  assert.equal(summary.bundled, false, "below bundle threshold → individual path");
  assert.equal(notifies.length, 1, "exactly one notifyByType call");
  assert.equal(notifies[0].id, notificationId, "registered notification id used");
  assert.equal(notifies[0].opts.dedupeKey, "client:c-own", "per-client dispatcher dedupe key");
  assert.equal(notifies[0].opts.skipAdminInAppMirror, true, "generic admin mirror skipped (module owns fan-out)");
  assert.equal(notifies[0].opts.failureType, "status:Watch", "failureType names the new status");
  assert.ok(notifies[0].text.includes("Healthy → Watch"), "Slack text carries old→new status");
  assert.ok(notifies[0].text.includes("gone quiet"), "Slack text carries the headline");
  assert.ok(notifies[0].text.includes("No reply in 9 days"), "Slack text carries top concerns");
  assert.ok(notifies[0].text.includes("/clients/c-own"), "Slack text carries the client link");

  const rows1 = myInApp();
  assert.equal(rows1.length, 3, "in-app rows: director-1 + ceo-1 + owner-1");
  assert.deepEqual(
    rows1.map((r) => r.uid).sort(),
    ["ceo-1", "director-1", "owner-1"],
    "recipients = director+ union client owner",
  );
  assert.equal(summary.inAppRecipients, 3, "summary counts in-app recipients");
  for (const row of rows1) {
    assert.equal(row.opts.category, "system", "in-app category is system");
    assert.equal(row.opts.deepLink, "/clients/c-own", "deep link points at the client");
    assert.ok(row.opts.title.includes("Acme Law"), "title names the client");
    assert.ok(row.opts.body.includes("Healthy → Watch"), "body carries old→new status");
    assert.ok(row.opts.body.includes("Top concerns"), "body carries concerns");
    assert.equal(
      row.opts.dedupeKey,
      `${CLIENT_RISK_SHIFT_DEDUPE_PREFIX}c-own:2026-08-03:${row.uid}`,
      "per-user dedupe key is prefix:client:date:uid",
    );
    assert.equal(row.opts.metadata.fromStatus, "Healthy", "metadata carries fromStatus");
    assert.equal(row.opts.metadata.toStatus, "Watch", "metadata carries toStatus");
  }

  // ── (c) once-per-streak / escalation / recovery re-arm ─────────────────
  reset();
  const day2 = beginClientRiskShiftRun();
  day2.entries.push({
    clientId: "c-own",
    clientName: "Acme Law",
    judgmentDate: "2026-08-04",
    prev: snap("Watch", 60),
    curr: snap("Watch", 62),
    headline: "Still quiet.",
    concerns: [],
  });
  summary = await dispatchClientRiskShiftAlerts(day2);
  assert.equal(summary.degraded, 0, "still-degraded (no transition) day detects nothing");
  assert.equal(notifies.length, 0, "no repeat alert while the client stays degraded");
  assert.equal(myInApp().length, 0, "no repeat in-app rows either");
  assert.equal(recoveries.length, 0, "no recovery marked");

  const day3 = beginClientRiskShiftRun();
  day3.entries.push({
    clientId: "c-own",
    clientName: "Acme Law",
    judgmentDate: "2026-08-05",
    prev: snap("Watch", 62),
    curr: snap("At Risk", 70),
    headline: "Escalating.",
    concerns: [],
  });
  summary = await dispatchClientRiskShiftAlerts(day3);
  assert.equal(notifies.length, 1, "a FURTHER slip is a new transition → alerts again");
  assert.equal(notifies[0].opts.failureType, "status:At Risk", "escalation carries a NEW failureType");

  reset();
  const day4 = beginClientRiskShiftRun();
  day4.entries.push({
    clientId: "c-own",
    clientName: "Acme Law",
    judgmentDate: "2026-08-06",
    prev: snap("At Risk", 70),
    curr: snap("Watch", 55),
    headline: "Re-engaged.",
    concerns: [],
  });
  summary = await dispatchClientRiskShiftAlerts(day4);
  assert.equal(summary.recovered, 1, "improvement classifies recovered");
  assert.equal(notifies.length, 0, "recovery sends no notification");
  assert.equal(myInApp().length, 0, "recovery sends no in-app rows");
  assert.deepEqual(
    recoveries,
    [{ id: notificationId, dedupeKey: "client:c-own" }],
    "recovery re-arms via dispatcher markRecovered on the per-client key",
  );

  // ── (d) bundling ────────────────────────────────────────────────────────
  reset();
  const bulk = beginClientRiskShiftRun();
  for (let i = 1; i <= CLIENT_RISK_SHIFT_BUNDLE_THRESHOLD; i++) {
    bulk.entries.push({
      clientId: `c-b${i}`,
      clientName: `Bulk Firm ${i}`,
      judgmentDate: "2026-08-07",
      prev: snap("Healthy", 20),
      curr: snap("Watch", 50),
      headline: null,
      concerns: [],
    });
  }
  summary = await dispatchClientRiskShiftAlerts(bulk);
  assert.equal(summary.bundled, true, "bundle threshold reached → bundled path");
  assert.equal(summary.alertsSent, 1, "bundle sends exactly one dispatcher alert");
  assert.equal(notifies.length, 1, "one notifyByType for the whole run");
  assert.equal(notifies[0].opts.dedupeKey, "bulk:2026-08-07", "bundle uses the run-date dedupe key");
  assert.equal(notifies[0].opts.failureType, "mass_degradation", "bundle failureType");
  for (let i = 1; i <= CLIENT_RISK_SHIFT_BUNDLE_THRESHOLD; i++) {
    assert.ok(notifies[0].text.includes(`Bulk Firm ${i}`), `bundle text lists client ${i}`);
  }
  const bulkRows = myInApp();
  assert.deepEqual(
    bulkRows.map((r) => r.uid).sort(),
    ["ceo-1", "director-1", "owner-1"],
    "bundle recipients = directors union all degraded clients' owners, deduped",
  );
  for (const row of bulkRows) {
    assert.ok(
      row.opts.dedupeKey.startsWith(`${CLIENT_RISK_SHIFT_DEDUPE_PREFIX}bulk:2026-08-07:`),
      "bundle in-app dedupe key uses the bulk prefix",
    );
    assert.equal(
      row.opts.metadata.clientIds.length,
      CLIENT_RISK_SHIFT_BUNDLE_THRESHOLD,
      "bundle metadata lists every degraded client id",
    );
    assert.equal(row.opts.deepLink, "/clients", "bundle deep-links to the client list");
  }

  // One below the threshold stays on the individual path.
  reset();
  const nearBulk = beginClientRiskShiftRun();
  for (let i = 1; i < CLIENT_RISK_SHIFT_BUNDLE_THRESHOLD; i++) {
    nearBulk.entries.push({
      clientId: `c-n${i}`,
      clientName: `Near Firm ${i}`,
      judgmentDate: "2026-08-07",
      prev: snap("Healthy", 20),
      curr: snap("Watch", 50),
      headline: null,
      concerns: [],
    });
  }
  summary = await dispatchClientRiskShiftAlerts(nearBulk);
  assert.equal(summary.bundled, false, "one below the threshold stays individual");
  assert.equal(notifies.length, CLIENT_RISK_SHIFT_BUNDLE_THRESHOLD - 1, "individual alert per client");

  // ── (e) kill switch ─────────────────────────────────────────────────────
  reset();
  killValue = "false";
  const muted = beginClientRiskShiftRun();
  muted.entries.push(
    {
      clientId: "c-own",
      clientName: "Acme Law",
      judgmentDate: "2026-08-08",
      prev: snap("Healthy", 30),
      curr: snap("Critical", 90),
      headline: null,
      concerns: [],
    },
    {
      clientId: "c-rec",
      clientName: "Recovered Inc",
      judgmentDate: "2026-08-08",
      prev: snap("Watch", 60),
      curr: snap("Healthy", 20),
      headline: null,
      concerns: [],
    },
  );
  summary = await dispatchClientRiskShiftAlerts(muted);
  assert.equal(summary.skipped, "kill_switch", "kill switch OFF reports skipped");
  assert.equal(notifies.length, 0, "kill switch suppresses dispatcher alerts");
  assert.equal(myInApp().length, 0, "kill switch suppresses in-app rows");
  assert.deepEqual(
    recoveries,
    [{ id: notificationId, dedupeKey: "client:c-rec" }],
    "recovery marking still runs under the kill switch (re-arm state stays correct)",
  );

  killValue = null;
  const unmuted = beginClientRiskShiftRun();
  unmuted.entries.push({
    clientId: "c-own",
    clientName: "Acme Law",
    judgmentDate: "2026-08-09",
    prev: snap("Watch", 40),
    curr: snap("Critical", 90),
    headline: null,
    concerns: [],
  });
  summary = await dispatchClientRiskShiftAlerts(unmuted);
  assert.equal(notifies.length, 1, "switch back ON → alerts flow again");

  // ── (f) threshold setting ───────────────────────────────────────────────
  reset();
  thresholdValue = "10";
  const tuned = beginClientRiskShiftRun();
  tuned.entries.push({
    clientId: "c-own",
    clientName: "Acme Law",
    judgmentDate: "2026-08-10",
    prev: snap("Watch", 30),
    curr: snap("Watch", 45),
    headline: null,
    concerns: [],
  });
  summary = await dispatchClientRiskShiftAlerts(tuned);
  assert.equal(notifies.length, 1, "lowered threshold (10): a 15-point jump alerts");
  assert.equal(notifies[0].opts.failureType, "score_jump", "score-only degradation failureType");
  assert.ok(notifies[0].text.includes("30→45"), "score-jump text names the scores");

  reset();
  thresholdValue = "not-a-number";
  const badSetting = beginClientRiskShiftRun();
  badSetting.entries.push({
    clientId: "c-own",
    clientName: "Acme Law",
    judgmentDate: "2026-08-11",
    prev: snap("Watch", 30),
    curr: snap("Watch", 45),
    headline: null,
    concerns: [],
  });
  summary = await dispatchClientRiskShiftAlerts(badSetting);
  assert.equal(notifies.length, 0, "garbage threshold falls back to default 20 → 15-point jump silent");

  reset();
  thresholdValue = "-5";
  const negSetting = beginClientRiskShiftRun();
  negSetting.entries.push({
    clientId: "c-own",
    clientName: "Acme Law",
    judgmentDate: "2026-08-12",
    prev: snap("Watch", 30),
    curr: snap("Watch", 45),
    headline: null,
    concerns: [],
  });
  await dispatchClientRiskShiftAlerts(negSetting);
  assert.equal(notifies.length, 0, "non-positive threshold falls back to default");
  thresholdValue = null;

  // ── (g) recordJudgmentForRiskShift snapshot extraction ─────────────────
  const loaderCalls: Array<{ clientId: string; beforeDate: string }> = [];
  alert.__setClientRiskShiftDepsForTest({
    loadPreviousJudgment: async (clientId, beforeDate) => {
      loaderCalls.push({ clientId, beforeDate });
      return { status: "Healthy", riskScore: 25 };
    },
  });
  const recRun = beginClientRiskShiftRun();
  await recordJudgmentForRiskShift(
    recRun,
    { id: "c-own", firmName: "Acme Law" } as any,
    {
      judgmentDate: "2026-08-03",
      overallStatus: "Watch",
      status: "legacy-status-field",
      riskScore: 55,
      headline: null,
      summaryText:
        "This client has gone quiet for two weeks. More detail follows in the second sentence.",
      concernsJson: ["one", "two", "three", "four"],
    } as any,
  );
  assert.equal(recRun.entries.length, 1, "judgment recorded");
  assert.deepEqual(
    loaderCalls,
    [{ clientId: "c-own", beforeDate: "2026-08-03" }],
    "previous-judgment loader gets the client + today's date as the exclusive bound",
  );
  const entry = recRun.entries[0];
  assert.equal(entry.curr.status, "Watch", "overallStatus preferred over legacy status field");
  assert.equal(entry.curr.riskScore, 55, "risk score extracted");
  assert.deepEqual(entry.prev, { status: "Healthy", riskScore: 25 }, "previous snapshot attached");
  assert.equal(
    entry.headline,
    "This client has gone quiet for two weeks.",
    "headline falls back to summaryText's first sentence",
  );
  assert.deepEqual(entry.concerns, ["one", "two", "three"], "top-3 concerns kept");

  alert.__setClientRiskShiftDepsForTest({
    loadPreviousJudgment: async () => {
      throw new Error("history read blew up");
    },
  });
  await recordJudgmentForRiskShift(
    recRun,
    { id: "c-own", firmName: "Acme Law" } as any,
    { judgmentDate: "2026-08-04", overallStatus: "Watch", riskScore: 50 } as any,
  );
  assert.equal(recRun.entries.length, 1, "throwing loader never throws past the hook; entry skipped");

  // Cleanup.
  alert.__resetClientRiskShiftDepsForTest();
  console.log("client-risk-shift-alert: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
