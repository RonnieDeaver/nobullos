/* test-registration
{
  "name": "SMS consent inbound keyword recording via handleInboundSms (Task #4336)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast (~2s) and deterministic under the hermetic per-run test DB (tx sandbox, no network, storm dispatcher stubbed inert) guarding the compliance-critical webhook behavior: STOP opts out, START opts back in, HELP records without touching state, SID-replay never double-records, and canonical changes enqueue one replay-safe GHL suppression event for a linked book contact.",
  "timeoutMs": 120000,
  "tier": "small"
}
test-registration */
// Task #4336 — the inbound Twilio webhook path (handleInboundSms) must
// RECORD consent keywords without ever replying (Twilio's toll-free edge
// already auto-replies; double-replying is the failure mode this design
// avoids). All writes run inside runInTxSandbox so nothing leaks.
//
// Covered:
//   (1) STOP from a fresh number → ledger opted_out + opt_out event with the
//       MessageSid, source keyword_inbound.
//   (2) Webhook replay (same MessageSid) → early SID dedupe, no second event.
//   (3) START → opted_in (round-trip on the same number).
//   (4) HELP → event only; ledger state untouched.
//   (5) "Stop." trailing punctuation still opts out.
//   (6) Multi-word chatter ("Can you stop by tomorrow?") → no ledger row.
//   (7) Twilio OptOutType hint opts out a multi-word body via the hint path.
//
// Usage: tsx tests/sms-consent-inbound-webhook.test.ts

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { eq, and } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import {
  smsConsentLedger,
  smsConsentEvents,
  twilioMessages,
  bookContacts,
  bookOutbox,
} from "@shared/schema";
import { handleInboundSms } from "../server/services/twilioService";
import { __setClientConflictNotifierForTests } from "../server/services/conversationDedupe";
import { __testHelpers as stormHelpers } from "../server/services/smsOptOutStormAlerts";
import { normalizeToE164 } from "../server/services/phoneNormalization";
import { __test_setGhlOutboundEnqueueOverride } from "../server/services/ghlOutboundKick";
import { recordTwilioBlockOptOut } from "../server/services/smsConsent";

// The dedupe-conflict notifier writes notifications under the sandbox tx and
// can abort it on dedupe-key collisions across repeated runs (see the Task
// #849 suite) — silence it; its contract is covered elsewhere.
__setClientConflictNotifierForTests(async () => {});

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
const TWILIO_NUMBER = "+12145550100";

// Distinct fresh numbers per scenario (random suffixes to be collision-proof
// even if a sandbox rollback ever failed).
function freshPhone(): string {
  const suffix = String(Math.floor(1000000 + Math.random() * 8999999));
  return `+1215${suffix}`;
}

async function ledgerRowFor(phoneE164: string) {
  const rows = await getDb()
    .select()
    .from(smsConsentLedger)
    .where(eq(smsConsentLedger.phoneNormalized, phoneE164));
  return rows[0] ?? null;
}

async function eventsFor(phoneE164: string) {
  return getDb()
    .select()
    .from(smsConsentEvents)
    .where(eq(smsConsentEvents.phoneNormalized, phoneE164))
    .orderBy(smsConsentEvents.createdAt);
}

async function inbound(from: string, body: string, sid: string, optOutType?: string) {
  await handleInboundSms({
    from,
    to: TWILIO_NUMBER,
    body,
    messageSid: sid,
    optOutType: optOutType ?? null,
  });
}

async function main(): Promise<void> {
  console.log("SMS consent inbound keyword recording (Task #4336)");

  // Keep the storm watcher inert + hermetic for this suite (its own suite
  // covers alerting semantics).
  stormHelpers.resetForTests();
  stormHelpers.setDispatcherForTests(async () => ({
    attempted: false,
    delivered: false,
    skipped: true,
    status: "skipped_disabled",
  }) as any);
  __test_setGhlOutboundEnqueueOverride(async () => {});

  try {
    await runInTxSandbox(async () => {
      const p1 = freshPhone();
      const p1e164 = normalizeToE164(p1);
      const sidStop = `SM${RUN}stop00001`;

      // (1) STOP → opted_out + event
      await inbound(p1, "STOP", sidStop);
      let row = await ledgerRowFor(p1e164);
      check("STOP creates an opted_out ledger row", row?.state === "opted_out");
      check("ledger source is keyword_inbound", row?.source === "keyword_inbound");
      check("optedOutAt is stamped", row?.optedOutAt != null);
      check(
        "evidence names the keyword and MessageSid",
        Boolean(row?.evidence?.includes("STOP") && row?.evidence?.includes(sidStop)),
      );
      let evs = await eventsFor(p1e164);
      check("exactly one opt_out event", evs.length === 1 && evs[0].eventType === "opt_out");
      check("event carries the MessageSid", evs[0]?.messageSid === sidStop);

      // (2) Replay the exact same webhook → SID dedupe short-circuits before
      // the consent hook; nothing double-records.
      await inbound(p1, "STOP", sidStop);
      evs = await eventsFor(p1e164);
      check("replayed webhook does not add a second event", evs.length === 1);
      const msgs = await getDb()
        .select()
        .from(twilioMessages)
        .where(and(eq(twilioMessages.twilioSid, sidStop), eq(twilioMessages.direction, "inbound")));
      check("replayed webhook does not duplicate the message row", msgs.length === 1);

      // (3) START → back to opted_in
      await inbound(p1, "start", `SM${RUN}start0001`);
      row = await ledgerRowFor(p1e164);
      check("START flips the ledger to opted_in", row?.state === "opted_in");
      check("optedInAt is stamped", row?.optedInAt != null);
      evs = await eventsFor(p1e164);
      check("opt_in event appended", evs.length === 2 && evs[1].eventType === "opt_in");

      // (4) HELP → event only, state untouched
      await inbound(p1, "HELP", `SM${RUN}help00001`);
      row = await ledgerRowFor(p1e164);
      check("HELP leaves the ledger state untouched", row?.state === "opted_in");
      evs = await eventsFor(p1e164);
      check("HELP recorded as an event", evs.length === 3 && evs[2].eventType === "help");

      // (5) Trailing punctuation
      const p2 = freshPhone();
      await inbound(p2, "Stop.", `SM${RUN}punct0001`);
      const row2 = await ledgerRowFor(normalizeToE164(p2));
      check('"Stop." (trailing punctuation) opts out', row2?.state === "opted_out");

      // (6) Multi-word chatter never touches the ledger
      const p3 = freshPhone();
      await inbound(p3, "Can you stop by tomorrow?", `SM${RUN}chat00001`);
      const row3 = await ledgerRowFor(normalizeToE164(p3));
      check("conversational 'stop' does NOT create a ledger row", row3 === null);
      const evs3 = await eventsFor(normalizeToE164(p3));
      check("…and records no event", evs3.length === 0);

      // (7) OptOutType edge hint carries a custom multi-word opt-out
      const p4 = freshPhone();
      await inbound(p4, "remove me from this list", `SM${RUN}hint00001`, "STOP");
      const row4 = await ledgerRowFor(normalizeToE164(p4));
      check("OptOutType=STOP hint opts out a multi-word body", row4?.state === "opted_out");
      const evs4 = await eventsFor(normalizeToE164(p4));
      check(
        "hint-matched event notes the hint path",
        evs4.length === 1 && Boolean(evs4[0].detail?.includes("opt_out_type_hint")),
      );

      // (8) A canonical consent transition for an existing book contact writes
      // one durable GHL suppression event in the SAME transaction. Replaying
      // the Twilio SID creates neither a second consent event nor outbox row.
      const p5 = freshPhone();
      const p5e164 = normalizeToE164(p5);
      const [ledger5] = await getDb()
        .insert(smsConsentLedger)
        .values({
          phoneNormalized: p5e164,
          phoneMatchKey: p5e164.slice(-10),
          state: "unknown",
          source: "backfill_seed",
          evidence: "test seed",
        })
        .returning({ id: smsConsentLedger.id });
      const [contact5] = await getDb()
        .insert(bookContacts)
        .values({
          email: `ghl-consent-${RUN}@example.test`,
          phone: p5e164,
          smsConsentEvidenceRef: ledger5.id,
        })
        .returning({ id: bookContacts.id });
      const sidGhlMirror = `SM${RUN}ghlmirror1`;
      await inbound(p5, "STOP", sidGhlMirror);
      let mirrorRows = await getDb()
        .select()
        .from(bookOutbox)
        .where(
          and(
            eq(bookOutbox.eventType, "consent.sms_updated"),
            eq(bookOutbox.sourceType, "sms_consent_event"),
          ),
        );
      const contactMirrorRows = mirrorRows.filter(
        (entry) =>
          (entry.payload as Record<string, unknown> | null)?.contactId === contact5.id,
      );
      check(
        "STOP enqueues one durable GHL consent mirror for the linked book contact",
        contactMirrorRows.length === 1 &&
          contactMirrorRows[0].status === "pending" &&
          (contactMirrorRows[0].payload as Record<string, unknown>)?.source ===
            "keyword_inbound",
      );
      await inbound(p5, "STOP", sidGhlMirror);
      mirrorRows = await getDb()
        .select()
        .from(bookOutbox)
        .where(eq(bookOutbox.eventType, "consent.sms_updated"));
      check(
        "Twilio SID replay does not duplicate the GHL consent mirror",
        mirrorRows.filter(
          (entry) =>
            (entry.payload as Record<string, unknown> | null)?.contactId ===
            contact5.id,
        ).length === 1,
      );

      // (9) Twilio 21610 reconciliation uses the durable outbound operation ID
      // as its dedupe key, so a repeated failure handler cannot duplicate the
      // canonical event or the GHL suppression mirror.
      const op21610 = `op-${RUN}-21610`;
      await recordTwilioBlockOptOut({
        phone: p5,
        operationId: op21610,
        detail: "test create rejected",
      });
      await recordTwilioBlockOptOut({
        phone: p5,
        operationId: op21610,
        detail: "test create rejected replay",
      });
      const blockEvents = (await eventsFor(p5e164)).filter(
        (event) => event.eventType === "twilio_block",
      );
      check(
        "repeated 21610 handling records one canonical block event",
        blockEvents.length === 1 &&
          blockEvents[0].messageSid === `twilio:21610:${op21610}`,
      );
      const mirrorsAfter21610 = await getDb()
        .select()
        .from(bookOutbox)
        .where(eq(bookOutbox.eventType, "consent.sms_updated"));
      check(
        "repeated 21610 handling enqueues one additional GHL suppression mirror",
        mirrorsAfter21610.filter(
          (entry) =>
            (entry.payload as Record<string, unknown> | null)?.contactId ===
            contact5.id,
        ).length === 2,
      );
    });
  } finally {
    __test_setGhlOutboundEnqueueOverride(null);
    stormHelpers.setDispatcherForTests(null);
    stormHelpers.resetForTests();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
