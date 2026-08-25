/* test-registration
{
  "name": "Automated SMS send gate: consent + quiet hours + kill switch (Task #4336)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast (~3s) and deterministic under the hermetic per-run test DB (tx sandbox, injected clock + send stub, no network) guarding the compliance contract every future automated SMS must pass: kill switch default OFF, strict opt-in, recipient-local quiet hours, and a complete audit trail.",
  "timeoutMs": 120000,
  "tier": "small"
}
test-registration */
// Task #4336 — sendAutomatedSms is the single sanctioned entry point for
// any future automated SMS. This suite pins its decision order and audit
// trail with an injected clock and send stub (no Twilio traffic):
//
//   (1) quiet-hours engine unit checks (tz map, conservative fallback,
//       overnight + empty windows)
//   (2) kill switch default OFF blocks even an opted-in recipient
//   (3) strict opt-in: unknown (no row) and opted_out both block
//   (4) quiet hours block at recipient-local night; ledger tz override wins
//   (5) allowed send delegates to sendSms with the right params
//   (6) send failure after the gate audits `send_failed` and rethrows
//   (7) every evaluation (allowed or blocked) leaves an audit row
//
// Usage: tsx tests/sms-send-gate.test.ts

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { eq } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { smsSendGateAudit, users } from "@shared/schema";
import {
  sendAutomatedSms,
  SMS_SEND_GATE_CONFIG_KEY,
  SMS_SEND_GATE_DEFAULT_CONFIG,
} from "../server/services/smsSendGate";
import {
  resolveCandidateTimezones,
  evaluateQuietHours,
  CONSERVATIVE_FALLBACK_TIMEZONES,
} from "../server/services/smsQuietHours";
import { applyConsentStateChange } from "../server/storage/smsConsentStorage";
import { setSystemSetting } from "../server/storage/settingsStorage";

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

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

function freshPhone(): string {
  const suffix = String(Math.floor(1000000 + Math.random() * 8999999));
  return `+1215${suffix}`;
}

async function seedLedger(
  phoneE164: string,
  state: "opted_in" | "opted_out",
  timezone?: string,
): Promise<void> {
  await applyConsentStateChange({
    phoneE164,
    phoneMatchKey: phoneE164.slice(-10),
    newState: state,
    source: "manual",
    evidence: `Test seed (${RUN})`,
    timezone,
    event: { eventType: "manual_set", detail: `test seed ${RUN}` },
  });
}

async function auditRowsFor(phoneE164: string) {
  return getDb()
    .select()
    .from(smsSendGateAudit)
    .where(eq(smsSendGateAudit.phoneNormalized, phoneE164))
    .orderBy(smsSendGateAudit.createdAt);
}

function quietHoursUnitChecks(): void {
  console.log("\n— 1. Quiet-hours engine (pure) —");

  const nyc = resolveCandidateTimezones("+12125551234", null);
  check(
    "212 (NYC) resolves via the area-code map to America/New_York",
    nyc.source === "area_code" && nyc.timezones.includes("America/New_York"),
    `source=${nyc.source} zones=${nyc.timezones.join(",")}`,
  );

  const unmapped = resolveCandidateTimezones("+19995551234", null);
  check(
    "unmapped area code falls back to the conservative 4-zone set",
    unmapped.source === "conservative_fallback" &&
      unmapped.timezones.length === CONSERVATIVE_FALLBACK_TIMEZONES.length,
  );

  const override = resolveCandidateTimezones("+12125551234", "America/Los_Angeles");
  check(
    "explicit override beats the area-code map",
    override.source === "override" && override.timezones.join() === "America/Los_Angeles",
  );

  // 2026-08-10T16:00Z = 12:00 EDT / 09:00 PDT — inside an 8–21 window everywhere.
  const middayOk = evaluateQuietHours({
    now: new Date("2026-08-10T16:00:00Z"),
    phoneE164: "+19995551234",
    startHourLocal: 8,
    endHourLocal: 21,
  });
  check("conservative fallback passes only when EVERY zone is in-window", middayOk.withinSendWindow);

  // 2026-08-10T13:00Z = 09:00 EDT but 06:00 PDT — a single blocked zone blocks.
  const pacificEarly = evaluateQuietHours({
    now: new Date("2026-08-10T13:00:00Z"),
    phoneE164: "+19995551234",
    startHourLocal: 8,
    endHourLocal: 21,
  });
  check(
    "conservative fallback blocks when ANY zone is still asleep",
    !pacificEarly.withinSendWindow && pacificEarly.blockedZones.length > 0,
  );

  // Overnight window 22→6: 03:00Z = 23:00 EDT (inside); 16:00Z = noon (outside).
  const overnightIn = evaluateQuietHours({
    now: new Date("2026-08-10T03:00:00Z"),
    phoneE164: "+12125551234",
    startHourLocal: 22,
    endHourLocal: 6,
  });
  const overnightOut = evaluateQuietHours({
    now: new Date("2026-08-10T16:00:00Z"),
    phoneE164: "+12125551234",
    startHourLocal: 22,
    endHourLocal: 6,
  });
  check("overnight window (start > end) admits late-night hours", overnightIn.withinSendWindow);
  check("overnight window rejects midday", !overnightOut.withinSendWindow);

  // start === end — empty window, always quiet (safe misconfiguration default).
  const empty = evaluateQuietHours({
    now: new Date("2026-08-10T16:00:00Z"),
    phoneE164: "+12125551234",
    startHourLocal: 9,
    endHourLocal: 9,
  });
  check("start === end is an always-quiet empty window", !empty.withinSendWindow);
}

async function main(): Promise<void> {
  console.log("Automated SMS send gate (Task #4336)");

  quietHoursUnitChecks();

  await runInTxSandbox(async () => {
    // Seed the sender user (senderUserId / requestedByUserId attribution).
    const senderUserId = `sms-gate-user-${RUN}`;
    await getDb().insert(users).values({
      id: senderUserId,
      email: `sms-gate-${RUN}@example.test`,
      firstName: "Gate",
      lastName: "Test",
      role: "account_manager",
    });

    const sends: Array<{ to: string; body: string; userId: string }> = [];
    const okStub = async (params: any) => {
      sends.push({ to: params.to, body: params.body, userId: params.userId });
      return {
        messageId: `msg-${RUN}`,
        twilioSid: `SM${RUN}gate`,
        conversationId: `conv-${RUN}`,
        status: "queued",
      };
    };

    console.log("\n— 2. Purpose + phone validation —");
    let threw = false;
    try {
      await sendAutomatedSms(
        { to: freshPhone(), body: "x", purpose: "   ", senderUserId },
        { sendSmsImpl: okStub as any },
      );
    } catch {
      threw = true;
    }
    check("blank purpose throws (attribution is mandatory)", threw);

    const badPhone = await sendAutomatedSms(
      { to: "12", body: "x", purpose: "test_gate", senderUserId },
      { sendSmsImpl: okStub as any },
    );
    check(
      "non-NANP phone → blocked invalid_phone",
      badPhone.outcome === "blocked" && badPhone.reason === "invalid_phone",
    );

    console.log("\n— 3. Kill switch (default OFF) —");
    const optedIn = freshPhone();
    await seedLedger(optedIn, "opted_in");
    const killed = await sendAutomatedSms(
      { to: optedIn, body: "hello", purpose: "test_gate", senderUserId },
      { sendSmsImpl: okStub as any, now: () => new Date("2026-08-10T16:00:00Z") },
    );
    check(
      "no config row → kill switch blocks even an opted-in recipient",
      killed.outcome === "blocked" && killed.reason === "kill_switch",
    );
    check("kill-switch block never reaches the sender", sends.length === 0);

    // Enable the gate for the rest of the matrix (8–21 window).
    await setSystemSetting(
      SMS_SEND_GATE_CONFIG_KEY,
      JSON.stringify({
        automatedSendsEnabled: true,
        sendWindowStartHourLocal: 8,
        sendWindowEndHourLocal: 21,
      }),
    );

    console.log("\n— 4. Strict opt-in —");
    const unknownPhone = freshPhone();
    const noConsent = await sendAutomatedSms(
      { to: unknownPhone, body: "hello", purpose: "test_gate", senderUserId },
      { sendSmsImpl: okStub as any, now: () => new Date("2026-08-10T16:00:00Z") },
    );
    check(
      "no ledger row → blocked no_consent (unknown is NOT sendable)",
      noConsent.outcome === "blocked" && noConsent.reason === "no_consent",
    );

    const optedOut = freshPhone();
    await seedLedger(optedOut, "opted_out");
    const blockedOut = await sendAutomatedSms(
      { to: optedOut, body: "hello", purpose: "test_gate", senderUserId },
      { sendSmsImpl: okStub as any, now: () => new Date("2026-08-10T16:00:00Z") },
    );
    check(
      "opted_out → blocked opted_out",
      blockedOut.outcome === "blocked" && blockedOut.reason === "opted_out",
    );
    check("no consent-blocked case reached the sender", sends.length === 0);

    console.log("\n— 5. Quiet hours —");
    // 07:00Z = 03:00 EDT for a 215 (Philadelphia) number.
    const night = await sendAutomatedSms(
      { to: optedIn, body: "hello", purpose: "test_gate", senderUserId },
      { sendSmsImpl: okStub as any, now: () => new Date("2026-08-10T07:00:00Z") },
    );
    check(
      "recipient-local 3 AM → blocked quiet_hours",
      night.outcome === "blocked" && night.reason === "quiet_hours",
    );

    // Ledger timezone override wins: 01:00Z = 21:00 EDT (outside 8–21) but
    // 18:00 PDT (inside) — an LA override must allow it.
    const westCoast = freshPhone();
    await seedLedger(westCoast, "opted_in", "America/Los_Angeles");
    const overrideSend = await sendAutomatedSms(
      { to: westCoast, body: "override ok", purpose: "test_gate", senderUserId },
      { sendSmsImpl: okStub as any, now: () => new Date("2026-08-11T01:00:00Z") },
    );
    check("ledger timezone override wins over the area-code map", overrideSend.outcome === "sent");

    console.log("\n— 6. Allowed send + failure semantics —");
    const sent = await sendAutomatedSms(
      { to: optedIn, body: "hello world", purpose: "test_gate", senderUserId },
      { sendSmsImpl: okStub as any, now: () => new Date("2026-08-10T16:00:00Z") },
    );
    check(
      "opted_in + midday → sent with the stub's identifiers",
      sent.outcome === "sent" && sent.twilioSid === `SM${RUN}gate` && sent.consentState === "opted_in",
    );
    check(
      "delegate received to/body/userId",
      sends.length === 2 &&
        sends[1].to === optedIn &&
        sends[1].body === "hello world" &&
        sends[1].userId === senderUserId,
    );

    const failingStub = async () => {
      throw new Error(`twilio exploded (${RUN})`);
    };
    let rethrown: Error | null = null;
    try {
      await sendAutomatedSms(
        { to: optedIn, body: "boom", purpose: "test_gate", senderUserId },
        { sendSmsImpl: failingStub as any, now: () => new Date("2026-08-10T16:00:00Z") },
      );
    } catch (err: any) {
      rethrown = err;
    }
    check(
      "post-gate send failure rethrows the sender's error",
      Boolean(rethrown?.message.includes(`twilio exploded (${RUN})`)),
    );

    console.log("\n— 7. Audit trail —");
    const optedInAudit = await auditRowsFor(optedIn);
    const outcomes = optedInAudit.map((r) => r.outcome);
    check(
      "opted-in phone audit sequence: kill_switch → quiet_hours → allowed → send_failed",
      JSON.stringify(outcomes) ===
        JSON.stringify(["blocked_kill_switch", "blocked_quiet_hours", "allowed", "send_failed"]),
      outcomes.join(","),
    );
    check(
      "audit rows carry purpose + requesting user",
      optedInAudit.every((r) => r.purpose === "test_gate" && r.requestedByUserId === senderUserId),
    );
    const noConsentAudit = await auditRowsFor(unknownPhone);
    check(
      "no-consent block audited with consentState unknown",
      noConsentAudit.length === 1 &&
        noConsentAudit[0].outcome === "blocked_no_consent" &&
        noConsentAudit[0].consentState === "unknown",
    );
    const outAudit = await auditRowsFor(optedOut);
    check(
      "opted-out block audited",
      outAudit.length === 1 && outAudit[0].outcome === "blocked_opted_out",
    );
  });

  // The sandbox tx rolled the settings row back, but setSystemSetting also
  // writes the shared settings cache — restore the locked default (kill
  // switch OFF) so no later reader ever sees the test's enabled config.
  await setSystemSetting(SMS_SEND_GATE_CONFIG_KEY, JSON.stringify(SMS_SEND_GATE_DEFAULT_CONFIG));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
