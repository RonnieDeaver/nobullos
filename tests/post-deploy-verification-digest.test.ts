/* test-registration
{
  "name": "Post-deploy verification digest (Task #973)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #973 regression tests: post-deploy verification Slack digest.
 *
 * Stubs both the verification report and the dispatcher so the test runs
 * in pure-memory and asserts on routing + boot-guard semantics:
 *   (a) overall=pass routes to the pass/warn notification id and the
 *       boot-guard suppresses a second send unless `force` is set.
 *   (b) overall=warn routes to the same pass/warn notification id.
 *   (c) overall=fail routes to the dedicated paging notification id.
 *   (d) the SETTING_ENABLED kill switch suppresses the send.
 *   (e) composeDigestMessage includes the comparison-to-baseline section
 *       when a baseline is present.
 *   (f) when email recipients are configured, both Slack AND email are
 *       dispatched in parallel and the result reflects both channels.
 *   (g) integration: a WARN-only post-deploy verification report forces
 *       the daily health digest to send even when health/incidents/freshness
 *       are otherwise quiet.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  maybeSendPostDeployDigest,
  composeDigestMessage,
  __testHelpers,
} from "../server/services/postDeployVerificationDigest";
import type {
  VerificationReport,
  CheckStatus,
} from "../server/services/postDeployVerification";

interface DispatchCall {
  id: string;
  text: string;
}

function makeReport(overall: CheckStatus, opts?: {
  withBaseline?: boolean;
}): VerificationReport {
  const groupStatus = (idx: number): CheckStatus => {
    // First group carries the worst status; others pass.
    if (idx === 0) return overall;
    return "pass";
  };
  const checkStatus = (gIdx: number): CheckStatus => groupStatus(gIdx);
  const groups = [
    { id: "913F.1", title: "Sampler verification", status: groupStatus(0) },
    { id: "913F.2", title: "Incident verification", status: groupStatus(1) },
    { id: "913F.3", title: "Attribution verification", status: groupStatus(2) },
    { id: "913F.4", title: "Health-metric correctness", status: groupStatus(3) },
  ].map((g, i) => ({
    id: g.id,
    title: g.title,
    status: g.status,
    checks: [
      {
        id: `${g.id}_check`,
        label: `${g.id} representative check`,
        status: checkStatus(i),
        detail: g.status === "pass" ? "all good" : `${g.status} reason`,
        numeric: 1,
      },
    ],
  })) as VerificationReport["groups"];

  const baseline = opts?.withBaseline
    ? {
        id: 1,
        savedAt: Date.now() - 3_600_000,
        savedBy: "test",
        metrics: { apiUnknownPct: 0.5, rtP95Ms: 10 },
        overallStatus: "pass" as CheckStatus,
      }
    : null;

  return {
    generatedAt: Date.now(),
    overall,
    groups,
    baseline,
    baselines: baseline ? [baseline] : [],
    comparison: baseline
      ? [
          {
            key: "apiUnknownPct",
            label: "api pool unknownPct",
            baseline: 0.5,
            current: 0.6,
            delta: 0.1,
            drift: "worse",
          },
          {
            key: "rtP95Ms",
            label: "DB round-trip p95 (ms)",
            baseline: 10,
            current: 8,
            delta: -2,
            drift: "better",
          },
        ]
      : [],
    metrics: { apiUnknownPct: 0.6, rtP95Ms: 8 },
    autoBaseline: { enabled: true },
  };
}

async function withCleanState(fn: () => Promise<void>): Promise<void> {
  __testHelpers.resetBootGuardForTests();
  __testHelpers.setReportFnForTests(null);
  __testHelpers.setDispatcherForTests(null);
  __testHelpers.setMailerForTests(null);
  try {
    await storage.deleteSystemSetting(__testHelpers.SETTING_ENABLED);
  } catch {}
  try {
    await storage.deleteSystemSetting(__testHelpers.SETTING_EMAIL_RECIPIENTS);
  } catch {}
  try {
    await fn();
  } finally {
    __testHelpers.resetBootGuardForTests();
    __testHelpers.setReportFnForTests(null);
    __testHelpers.setDispatcherForTests(null);
    __testHelpers.setMailerForTests(null);
    try {
      await storage.deleteSystemSetting(__testHelpers.SETTING_ENABLED);
    } catch {}
    try {
      await storage.deleteSystemSetting(__testHelpers.SETTING_EMAIL_RECIPIENTS);
    } catch {}
  }
}

async function caseA_passRoutesAndBootGuard(): Promise<void> {
  await withCleanState(async () => {
    __testHelpers.setReportFnForTests(async () => makeReport("pass"));
    const calls: DispatchCall[] = [];
    __testHelpers.setDispatcherForTests(async (id, payload) => {
      calls.push({ id, text: payload.text });
      return { delivered: true, status: "sent" };
    });

    const r1 = await maybeSendPostDeployDigest();
    assert.equal(r1.sent, true, "first send must succeed");
    assert.equal(r1.notificationId, __testHelpers.NOTIFICATION_ID_PASS_OR_WARN);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.id, __testHelpers.NOTIFICATION_ID_PASS_OR_WARN);
    assert.match(calls[0]!.text, /PASS/);

    // Boot guard must suppress the second non-forced send.
    const r2 = await maybeSendPostDeployDigest();
    assert.equal(r2.sent, false);
    assert.match(r2.reason, /already sent/);
    assert.equal(calls.length, 1, "no second dispatch without force");

    // force=true bypasses the guard.
    const r3 = await maybeSendPostDeployDigest({ force: true });
    assert.equal(r3.sent, true);
    assert.equal(calls.length, 2);
  });
}

async function caseB_warnRoutesToPassWarnChannel(): Promise<void> {
  await withCleanState(async () => {
    __testHelpers.setReportFnForTests(async () => makeReport("warn"));
    const calls: DispatchCall[] = [];
    __testHelpers.setDispatcherForTests(async (id, payload) => {
      calls.push({ id, text: payload.text });
      return { delivered: true };
    });
    const r = await maybeSendPostDeployDigest();
    assert.equal(r.sent, true);
    assert.equal(r.notificationId, __testHelpers.NOTIFICATION_ID_PASS_OR_WARN);
    assert.match(calls[0]!.text, /WARN/);
  });
}

async function caseC_failRoutesToPagingChannel(): Promise<void> {
  await withCleanState(async () => {
    __testHelpers.setReportFnForTests(async () => makeReport("fail"));
    const calls: DispatchCall[] = [];
    __testHelpers.setDispatcherForTests(async (id, payload) => {
      calls.push({ id, text: payload.text });
      return { delivered: true };
    });
    const r = await maybeSendPostDeployDigest();
    assert.equal(r.sent, true);
    assert.equal(r.notificationId, __testHelpers.NOTIFICATION_ID_FAIL);
    assert.equal(calls[0]!.id, __testHelpers.NOTIFICATION_ID_FAIL);
    assert.match(calls[0]!.text, /FAIL/);
  });
}

async function caseD_killSwitchSuppresses(): Promise<void> {
  await withCleanState(async () => {
    await storage.setSystemSetting(
      __testHelpers.SETTING_ENABLED,
      "false",
      "system",
    );
    __testHelpers.setReportFnForTests(async () => makeReport("pass"));
    let dispatched = 0;
    __testHelpers.setDispatcherForTests(async () => {
      dispatched++;
      return { delivered: true };
    });
    const r = await maybeSendPostDeployDigest();
    assert.equal(r.sent, false);
    assert.match(r.reason, /disabled/);
    assert.equal(dispatched, 0);

    // force=true bypasses the kill switch too (manual send-now).
    const r2 = await maybeSendPostDeployDigest({ force: true });
    assert.equal(r2.sent, true);
    assert.equal(dispatched, 1);
  });
}

async function caseE_composeIncludesBaselineDiff(): Promise<void> {
  await withCleanState(async () => {
    const report = makeReport("warn", { withBaseline: true });
    const { text, preview } = composeDigestMessage(report);
    assert.match(text, /Vs baseline saved/);
    assert.match(text, /api pool unknownPct/);
    assert.match(text, /DB round-trip p95/);
    assert.match(preview, /post-deploy verification WARN/);
  });
}

async function caseF_emailDispatchedAlongsideSlack(): Promise<void> {
  await withCleanState(async () => {
    await storage.setSystemSetting(
      __testHelpers.SETTING_EMAIL_RECIPIENTS,
      "ops@example.com, oncall@example.com",
      "system",
    );
    __testHelpers.setReportFnForTests(async () =>
      makeReport("warn", { withBaseline: true }),
    );
    let slackCalls = 0;
    __testHelpers.setDispatcherForTests(async () => {
      slackCalls++;
      return { delivered: true };
    });
    const emailCalls: Array<{ to: string[]; subject: string; body: string }> = [];
    __testHelpers.setMailerForTests(async (opts) => {
      emailCalls.push({ to: opts.to, subject: opts.subject, body: opts.text });
      return { ok: true } as const;
    });

    const r = await maybeSendPostDeployDigest();
    assert.equal(r.sent, true, "must report sent when both channels delivered");
    assert.equal(slackCalls, 1, "slack must be dispatched");
    assert.equal(emailCalls.length, 1, "email must be dispatched in parallel");
    assert.deepEqual(emailCalls[0]!.to, ["ops@example.com", "oncall@example.com"]);
    assert.match(emailCalls[0]!.subject, /WARN/);
    assert.match(emailCalls[0]!.body, /post-deploy verification/i);
    assert.match(emailCalls[0]!.body, /Vs baseline saved/);
    assert.equal(r.email?.delivered, true);
    assert.equal(r.email?.recipients, 2);
    assert.equal(r.slack?.delivered, true);
    assert.match(r.reason, /slack\+email/);
  });

  // Email-only success path: Slack dispatcher fails, but email succeeds →
  // result.sent must still be true (channels are independent).
  await withCleanState(async () => {
    await storage.setSystemSetting(
      __testHelpers.SETTING_EMAIL_RECIPIENTS,
      "ops@example.com",
      "system",
    );
    __testHelpers.setReportFnForTests(async () => makeReport("warn"));
    __testHelpers.setDispatcherForTests(async () => ({
      delivered: false,
      skipReason: "no_channel_configured",
    }));
    let emailed = 0;
    __testHelpers.setMailerForTests(async () => {
      emailed++;
      return { ok: true } as const;
    });
    const r = await maybeSendPostDeployDigest();
    assert.equal(r.sent, true, "email-only success must mark digest as sent");
    assert.equal(emailed, 1);
    assert.equal(r.email?.delivered, true);
    assert.equal(r.slack?.delivered, false);
  });
}

async function caseG_warnOnlyForcesDailyDigest(): Promise<void> {
  // Integration check at the planDigest layer: verify the gating decision
  // includes post-deploy verification status, so a WARN-only deploy still
  // fires the daily digest even when health/incidents/freshness are quiet.
  // We do this by directly inspecting the gating logic — full pipeline
  // mocking of `computeOverview`/`listOpenIncidents` is out of scope; this
  // case asserts the contract that warn/fail is treated as `needsAttention`.
  const { __testGating } = await import(
    "../server/services/healthSlackDigest"
  ).then((m) =>
    // Surface the helper via a type-cast — see healthSlackDigest export.
    m as unknown as {
      __testGating: {
        evaluatePostDeployNeedsAttention: (
          report: { overall: CheckStatus } | null,
        ) => boolean;
      };
    },
  );
  assert.equal(
    __testGating.evaluatePostDeployNeedsAttention({ overall: "pass" }),
    false,
    "pass must NOT force the digest",
  );
  assert.equal(
    __testGating.evaluatePostDeployNeedsAttention({ overall: "warn" }),
    true,
    "warn MUST force the digest",
  );
  assert.equal(
    __testGating.evaluatePostDeployNeedsAttention({ overall: "fail" }),
    true,
    "fail MUST force the digest",
  );
  assert.equal(
    __testGating.evaluatePostDeployNeedsAttention(null),
    false,
    "missing report must NOT force the digest",
  );
}

async function run(): Promise<void> {
  await caseA_passRoutesAndBootGuard();
  console.log("ok (A) pass routes + boot guard");
  await caseB_warnRoutesToPassWarnChannel();
  console.log("ok (B) warn routes to pass/warn channel");
  await caseC_failRoutesToPagingChannel();
  console.log("ok (C) fail routes to paging channel");
  await caseD_killSwitchSuppresses();
  console.log("ok (D) kill switch suppresses, force overrides");
  await caseE_composeIncludesBaselineDiff();
  console.log("ok (E) compose includes baseline diff");
  await caseF_emailDispatchedAlongsideSlack();
  console.log("ok (F) email dispatched alongside (and independently of) slack");
  await caseG_warnOnlyForcesDailyDigest();
  console.log("ok (G) warn-only post-deploy report forces daily digest");
  console.log("\nAll Task #973 post-deploy verification digest tests passed.");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
