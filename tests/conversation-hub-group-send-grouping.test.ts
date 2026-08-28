/* test-registration
{
  "name": "Conversation Hub groups multi-recipient sends into one bubble (Task #5300)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pins the pure grouping logic behind Task #5300 (group text sends looked like duplicates): a compose action against N recipients fans out to N `twilio_messages` rows server-side, and `groupOutboundSendEvents` is the ONLY thing standing between that and N look-alike bubbles in the thread view. Pure function, no DOM/DB/network — sub-second.",
  "scanPaths": ["client/src/lib/conversationModel.ts"],
  "tier": "small"
}
test-registration */
/**
 * Task #5300 — "Make group text sends look like one message, not duplicates".
 *
 * server/routes/twilio.ts sends exactly one SMS per participant
 * (Promise.allSettled, one sendSms() call each) and persists one
 * `twilio_messages` row per recipient. There is no backend duplicate-send
 * bug — the confusion was purely visual: the thread rendered one bubble per
 * row with no indication they came from the same compose action.
 *
 * `groupOutboundSendEvents` (client/src/lib/conversationModel.ts) collapses
 * a contiguous run of outbound SMS events into one `SmsGroupEvent` when they
 * plausibly came from the same compose action: same body, same from-number,
 * no repeated recipient within the run, and each hop within
 * GROUP_SEND_WINDOW_MS of the previous one. This suite pins that decision
 * table directly, independent of the (separately covered) Hub rendering
 * wiring.
 */

import { groupOutboundSendEvents, type ConversationEvent, type SmsEvent } from "../client/src/lib/conversationModel";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const CONV_ID = "conv-group-1";
const FROM = "+15559990000";

function sms(overrides: Partial<SmsEvent> & { id: string; ts: Date }): SmsEvent {
  return {
    kind: "sms",
    conversationId: CONV_ID,
    direction: "outbound",
    body: "Hello team",
    status: "sent",
    errorCode: null,
    errorMessage: null,
    messagingServiceSid: null,
    fromNumber: FROM,
    toNumber: "+15551110001",
    sentByUserId: "user-1",
    ...overrides,
  };
}

const T0 = new Date("2026-08-20T12:00:00.000Z");
const msLater = (ms: number) => new Date(T0.getTime() + ms);

async function main(): Promise<void> {
  console.log("— A. two participants, near-simultaneous rows collapse into one group —");
  {
    const events: ConversationEvent[] = [
      sms({ id: "m1", ts: msLater(0), toNumber: "+15551110001" }),
      sms({ id: "m2", ts: msLater(150), toNumber: "+15551110002" }),
    ];
    const out = groupOutboundSendEvents(events);
    assert(out.length === 1, `two-recipient send collapses to 1 display event (got ${out.length})`);
    assert(out[0].kind === "sms-group", `collapsed event is kind "sms-group" (got "${out[0].kind}")`);
    if (out[0].kind === "sms-group") {
      assert(out[0].recipients.length === 2, `group carries both recipients (got ${out[0].recipients.length})`);
      assert(
        out[0].recipients.map((r) => r.toNumber).join(",") === "+15551110001,+15551110002",
        "group recipients preserve send order",
      );
      assert(out[0].body === "Hello team", "group carries the shared body text");
      assert(out[0].id === "sms-group:m1", `group id derives from the first row's id (got "${out[0].id}")`);
    }
  }

  console.log("— B. per-recipient status/error is preserved for a partial failure —");
  {
    const events: ConversationEvent[] = [
      sms({ id: "m1", ts: msLater(0), toNumber: "+15551110001", status: "delivered" }),
      sms({
        id: "m2",
        ts: msLater(200),
        toNumber: "+15551110002",
        status: "failed",
        errorCode: "30003",
        errorMessage: "Unreachable",
      }),
    ];
    const out = groupOutboundSendEvents(events);
    assert(out.length === 1 && out[0].kind === "sms-group", "still one group");
    if (out[0].kind === "sms-group") {
      const [r1, r2] = out[0].recipients;
      assert(r1.status === "delivered", `recipient 1 keeps its own status (got "${r1.status}")`);
      assert(r2.status === "failed", `recipient 2 keeps its own status (got "${r2.status}")`);
      assert(r2.errorCode === "30003", "failed recipient's Twilio error code survives grouping");
    }
  }

  console.log("— C. a single-recipient send is left ungrouped —");
  {
    const events: ConversationEvent[] = [sms({ id: "m1", ts: msLater(0) })];
    const out = groupOutboundSendEvents(events);
    assert(out.length === 1 && out[0].kind === "sms", "lone outbound SMS stays a plain sms event, not a group of 1");
  }

  console.log("— D. inbound replies never join an outbound group —");
  {
    const events: ConversationEvent[] = [
      sms({ id: "m1", ts: msLater(0), toNumber: "+15551110001" }),
      sms({ id: "m2", ts: msLater(100), toNumber: "+15551110002" }),
      sms({ id: "m3", ts: msLater(500), direction: "inbound", toNumber: FROM, fromNumber: "+15551110001", body: "ok" }),
    ];
    const out = groupOutboundSendEvents(events);
    assert(out.length === 2, `group + separate inbound reply (got ${out.length} display events)`);
    assert(out[0].kind === "sms-group", "first display event is the outbound group");
    assert(out[1].kind === "sms" && out[1].direction === "inbound", "inbound reply stays its own bubble");
  }

  console.log("— E. a resend of the identical text to the same recipients starts a NEW group —");
  {
    // Same body, same two recipients, sent twice back-to-back (e.g. the
    // group composer used again). A repeated recipient can only mean a
    // new compose action, never more rows from the first one.
    const events: ConversationEvent[] = [
      sms({ id: "m1", ts: msLater(0), toNumber: "+15551110001" }),
      sms({ id: "m2", ts: msLater(100), toNumber: "+15551110002" }),
      sms({ id: "m3", ts: msLater(300), toNumber: "+15551110001" }),
      sms({ id: "m4", ts: msLater(420), toNumber: "+15551110002" }),
    ];
    const out = groupOutboundSendEvents(events);
    assert(out.length === 2, `two separate resends of the same text stay two distinct groups (got ${out.length})`);
    assert(
      out.every((e) => e.kind === "sms-group" && e.recipients.length === 2),
      "each group has exactly the 2 recipients from its own compose action",
    );
  }

  console.log("— F. a large time gap breaks the run even with unique recipients —");
  {
    const events: ConversationEvent[] = [
      sms({ id: "m1", ts: msLater(0), toNumber: "+15551110001" }),
      sms({ id: "m2", ts: msLater(25_000), toNumber: "+15551110002" }), // > GROUP_SEND_WINDOW_MS (20s)
    ];
    const out = groupOutboundSendEvents(events);
    assert(out.length === 2, `messages more than the grouping window apart stay separate (got ${out.length})`);
    assert(
      out.every((e) => e.kind === "sms"),
      "neither lone message becomes a group of 1",
    );
  }

  console.log("— G. different from-numbers never merge (e.g. two configured Twilio lines) —");
  {
    const events: ConversationEvent[] = [
      sms({ id: "m1", ts: msLater(0), toNumber: "+15551110001", fromNumber: "+15550001111" }),
      sms({ id: "m2", ts: msLater(100), toNumber: "+15551110002", fromNumber: "+15550002222" }),
    ];
    const out = groupOutboundSendEvents(events);
    assert(out.length === 2, "mismatched from-numbers never collapse into one group");
  }

  console.log("— H. events sort order is preserved for non-sms kinds mixed in —");
  {
    const events: ConversationEvent[] = [
      { kind: "note", id: "n1", threadKey: "k", ts: msLater(-100), body: "note", createdByUserId: null, createdByName: null },
      sms({ id: "m1", ts: msLater(0), toNumber: "+15551110001" }),
      sms({ id: "m2", ts: msLater(100), toNumber: "+15551110002" }),
    ];
    const out = groupOutboundSendEvents(events);
    assert(out.length === 2, `note stays separate from the trailing group (got ${out.length})`);
    assert(out[0].kind === "note", "note keeps its position ahead of the group");
    assert(out[1].kind === "sms-group", "group follows the note");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
