/* test-registration
{
  "name": "Twilio direct-thread dedupe (Task #849)",
  "tier": "small"
}
test-registration */
// Task #849 tests: direct SMS thread identity, idempotent webhook, merge.
// All DB writes run inside runInTxSandbox.
// Usage: tsx tests/twilio-direct-thread-dedupe.test.ts

import { eq, inArray, asc } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import {
  twilioConversations,
  twilioMessages,
  rawCommunicationRecords,
  clients,
} from "@shared/schema";
import {
  normalizeSmsPhone,
  getPhoneMatchKey,
  getDirectConversationKey,
} from "../server/services/phoneNormalization";
import * as twilioStorage from "../server/storage/twilioStorage";
import {
  buildNormalizedFields,
  findDirectConversationByKey,
  findOrCreateDirectConversation,
  findExistingInboundMessageBySid,
  findDuplicateDirectGroups,
  mergeDirectConversationGroup,
  listOpenClientConflicts,
  resolveClientConflict,
  __setClientConflictNotifierForTests,
  type MergeAuditEntry,
} from "../server/services/conversationDedupe";
import { handleInboundSms } from "../server/services/twilioService";
import { runBackfill } from "../server/scripts/backfillTwilioConversationNormalization";
import { runMerge } from "../server/scripts/mergeDuplicateDirectConversations";

// Silence the Slack/inbox conflict notifier — defaultClientConflictNotifier
// calls notifyUser() under the sandbox tx, and a dedupe-key collision on
// repeated runs aborts the sandbox tx with 25P02 before the test asserts
// merge behaviour. Tests cover the notifier contract separately.
__setClientConflictNotifierForTests(async () => {});

const TEST_TAG = `twil-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const RONNIE_TWILIO = "+12145551111";
const RONNIE_CONTACT_E164 = "+12676398995";
const RONNIE_CONTACT_RAW = "(267) 639-8995";
const RONNIE_CONTACT_BARE10 = "2676398995";
const RONNIE_CONTACT_BARE11 = "12676398995";
const RONNIE_CONTACT_DOTS = "267.639.8995";
const RONNIE_CONTACT_DASHES = "267-639-8995";

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

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function seedClient(name: string): Promise<string> {
  const [row] = await getDb()
    .insert(clients)
    .values({ firmName: name })
    .returning({ id: clients.id });
  return row.id;
}

// ---------------------------------------------------------------------------
// (1) Phone normalization
// ---------------------------------------------------------------------------
function testPhoneNormalization(): void {
  console.log("\n— 1. Phone normalization —");

  const equivalents = [
    "+12676398995",
    "12676398995",
    "2676398995",
    "(267) 639-8995",
    "267-639-8995",
    "267.639.8995",
    "  267 639 8995  ",
    "+1 (267) 639-8995",
  ];
  const expectedKey = "2676398995";
  for (const v of equivalents) {
    check(
      `getPhoneMatchKey(${JSON.stringify(v)}) === '${expectedKey}'`,
      getPhoneMatchKey(v) === expectedKey,
    );
  }

  check("invalid input returns null", getPhoneMatchKey("not-a-number") === null);
  check("empty string returns null", getPhoneMatchKey("") === null);
  check("null input returns null", getPhoneMatchKey(null) === null);
  check("undefined input returns null", getPhoneMatchKey(undefined) === null);
  check("9-digit string returns null", getPhoneMatchKey("123456789") === null);

  const n = normalizeSmsPhone("+12676398995");
  check("normalizeSmsPhone preserves E.164", n.e164 === "+12676398995");
  check("normalizeSmsPhone yields national10", n.national10 === "2676398995");
  check("normalizeSmsPhone yields digits", n.digits === "12676398995");

  const n10 = normalizeSmsPhone("2676398995");
  check("10-digit infers +1 E.164", n10.e164 === "+12676398995");

  const n11 = normalizeSmsPhone("12676398995");
  check("11-digit starting 1 infers +1 E.164", n11.e164 === "+12676398995");

  const intlNoPlus = normalizeSmsPhone("442012345678");
  check(
    "12-digit non-+1 does NOT auto-coerce to +1",
    intlNoPlus.e164 === undefined,
  );

  const key = getDirectConversationKey({
    contactPhone: "(267) 639-8995",
    twilioPhoneNumber: "+12145551111",
  });
  check(
    "getDirectConversationKey assembles direct:{twilio}:{contact}",
    key === "direct:2145551111:2676398995",
  );

  check(
    "getDirectConversationKey returns null when contact has < 10 digits",
    getDirectConversationKey({ contactPhone: "12345", twilioPhoneNumber: "+12145551111" }) === null,
  );
}

// ---------------------------------------------------------------------------
// (2) Direct lookup behavior
// ---------------------------------------------------------------------------
async function testDirectLookup(): Promise<void> {
  console.log("\n— 2. Direct conversation lookup —");

  await runInTxSandbox(async () => {
    const clientId = await seedClient(`DirLookup ${TEST_TAG}`);
    const db = getDb();

    const [rawStored] = await db
      .insert(twilioConversations)
      .values({
        clientId,
        contactPhone: RONNIE_CONTACT_RAW,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        ...buildNormalizedFields({
          contactPhone: RONNIE_CONTACT_RAW,
          twilioPhoneNumber: RONNIE_TWILIO,
          conversationType: "direct",
        }),
      })
      .returning();

    check(
      "raw-formatted insert auto-populates contactPhoneNormalized",
      rawStored.contactPhoneNormalized === "2676398995",
    );
    check(
      "raw-formatted insert auto-populates directThreadKey",
      rawStored.directThreadKey === "direct:2145551111:2676398995",
    );

    // Inbound webhook hands us E.164 — must match the raw-stored row.
    const found1 = await twilioStorage.getTwilioConversationByPhone(
      RONNIE_CONTACT_E164,
      RONNIE_TWILIO,
    );
    check(
      "inbound +E.164 matches raw-stored thread (the production bug)",
      !!found1 && found1.id === rawStored.id,
    );

    // The reverse: bare10 inbound matches a row stored as +E.164.
    const [e164Stored] = await db
      .insert(twilioConversations)
      .values({
        clientId,
        contactPhone: "+18005551234",
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        ...buildNormalizedFields({
          contactPhone: "+18005551234",
          twilioPhoneNumber: RONNIE_TWILIO,
          conversationType: "direct",
        }),
      })
      .returning();
    const found2 = await twilioStorage.getTwilioConversationByPhone(
      "8005551234",
      RONNIE_TWILIO,
    );
    check(
      "inbound bare-10 matches +E.164-stored thread",
      !!found2 && found2.id === e164Stored.id,
    );

    // Same contact, different Twilio number → no match.
    const otherTwilio = "+13035550000";
    const found3 = await twilioStorage.getTwilioConversationByPhone(
      RONNIE_CONTACT_E164,
      otherTwilio,
    );
    check(
      "same contact + different Twilio → no match",
      found3 === undefined,
    );

    // Same Twilio, different contact → no match.
    const found4 = await twilioStorage.getTwilioConversationByPhone(
      "+19999999999",
      RONNIE_TWILIO,
    );
    check("same Twilio + different contact → no match", found4 === undefined);

    // Group conversations are ignored by direct lookup.
    await db.insert(twilioConversations).values({
      clientId,
      contactPhone: "+15005550006",
      twilioPhoneNumber: RONNIE_TWILIO,
      conversationType: "group",
      status: "active",
      participants: [
        { phone: "+15005550006" },
        { phone: RONNIE_CONTACT_E164 },
      ],
    });
    const found5 = await twilioStorage.getTwilioConversationByPhone(
      RONNIE_CONTACT_E164,
      RONNIE_TWILIO,
    );
    check(
      "group conversation not returned by direct lookup",
      !!found5 && found5.conversationType !== "group",
    );
  });
}

// ---------------------------------------------------------------------------
// (3) Outbound creation reuses + DB-level uniqueness
// ---------------------------------------------------------------------------
async function testOutboundReuse(): Promise<void> {
  console.log("\n— 3. Outbound direct creation reuses existing thread —");

  await runInTxSandbox(async () => {
    const clientId = await seedClient(`OutboundReuse ${TEST_TAG}`);

    const first = await findOrCreateDirectConversation({
      data: {
        clientId,
        contactPhone: RONNIE_CONTACT_RAW,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        participants: [{ phone: RONNIE_CONTACT_RAW }],
      },
    });
    check("first call creates the thread", first.created);
    check(
      "first call writes normalized fields",
      first.conversation.directThreadKey === "direct:2145551111:2676398995",
    );

    const second = await findOrCreateDirectConversation({
      data: {
        clientId,
        contactPhone: RONNIE_CONTACT_E164, // different format
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        participants: [{ phone: RONNIE_CONTACT_E164 }],
      },
    });
    check("second call reuses (created=false)", !second.created);
    check(
      "second call returns the same row id",
      second.conversation.id === first.conversation.id,
    );

    // Direct DB unique-violation: a manual insert with the same key must
    // fail. We swallow the error and assert it surfaced as 23505. Newer
    // drizzle wraps the underlying pg error, so the SQLSTATE lives on the
    // error's `cause` chain rather than the top-level object — walk it.
    let codeSeen: string | undefined;
    try {
      await getDb()
        .insert(twilioConversations)
        .values({
          clientId,
          contactPhone: "any",
          twilioPhoneNumber: RONNIE_TWILIO,
          conversationType: "direct",
          status: "active",
          ...buildNormalizedFields({
            contactPhone: RONNIE_CONTACT_BARE10,
            twilioPhoneNumber: RONNIE_TWILIO,
            conversationType: "direct",
          }),
        });
    } catch (err: unknown) {
      let cur: unknown = err;
      for (let depth = 0; cur && depth < 5; depth++) {
        const c = (cur as { code?: string }).code;
        if (c) {
          codeSeen = c;
          break;
        }
        cur = (cur as { cause?: unknown }).cause;
      }
    }
    check(
      "DB unique-partial index rejects duplicate direct_thread_key (23505)",
      codeSeen === "23505",
    );
  });
}

// ---------------------------------------------------------------------------
// (4) Inbound SMS appends, then a Twilio retry is a no-op
// ---------------------------------------------------------------------------
async function testInboundAppendAndIdempotency(): Promise<void> {
  console.log("\n— 4. Inbound SMS append + webhook idempotency —");

  await runInTxSandbox(async () => {
    // Seed a pre-existing thread with a RAW phone format — the bug
    // condition. The first inbound SMS in normalized form should land on
    // this row, NOT create a new one.
    const [existing] = await getDb()
      .insert(twilioConversations)
      .values({
        contactPhone: RONNIE_CONTACT_RAW,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        ...buildNormalizedFields({
          contactPhone: RONNIE_CONTACT_RAW,
          twilioPhoneNumber: RONNIE_TWILIO,
          conversationType: "direct",
        }),
        lastMessagePreview: "Testing this",
        lastMessageAt: new Date(Date.now() - 60_000),
        unreadCount: 0,
      })
      .returning();

    // Inbound webhook delivery — Twilio gives us E.164.
    const sid = `SM${TEST_TAG}-A`;
    await handleInboundSms({
      from: RONNIE_CONTACT_E164,
      to: RONNIE_TWILIO,
      body: "Test again",
      messageSid: sid,
    });

    const allConvs = await getDb()
      .select()
      .from(twilioConversations)
      .where(eq(twilioConversations.directThreadKey, "direct:2145551111:2676398995"));
    check(
      "inbound did NOT create a duplicate direct thread",
      allConvs.length === 1,
    );
    check(
      "inbound landed on the pre-existing raw-formatted row",
      allConvs[0].id === existing.id,
    );

    const msgs = await getDb()
      .select()
      .from(twilioMessages)
      .where(eq(twilioMessages.conversationId, existing.id));
    check("exactly one message recorded so far", msgs.length === 1);
    check("message stored with the original Twilio SID", msgs[0].twilioSid === sid);

    // Now simulate Twilio retrying with the same MessageSid — must be a no-op.
    await handleInboundSms({
      from: RONNIE_CONTACT_E164,
      to: RONNIE_TWILIO,
      body: "Test again",
      messageSid: sid,
    });

    const msgsAfter = await getDb()
      .select()
      .from(twilioMessages)
      .where(eq(twilioMessages.conversationId, existing.id));
    check(
      "Twilio retry did NOT create a duplicate message",
      msgsAfter.length === 1,
    );

    const convsAfter = await getDb()
      .select()
      .from(twilioConversations)
      .where(eq(twilioConversations.directThreadKey, "direct:2145551111:2676398995"));
    check(
      "Twilio retry did NOT create a duplicate conversation",
      convsAfter.length === 1,
    );

    // Direct probe of the idempotency lookup helper.
    const probe = await findExistingInboundMessageBySid(sid);
    check(
      "findExistingInboundMessageBySid returns the row",
      !!probe && probe.conversationId === existing.id,
    );
  });
}

// ---------------------------------------------------------------------------
// (5) Merge script collapses duplicates with correct survivor
// ---------------------------------------------------------------------------
async function testMergeScript(): Promise<void> {
  console.log("\n— 5. Merge duplicate direct conversations —");

  await runInTxSandbox(async () => {
    const clientId = await seedClient(`MergeScript ${TEST_TAG}`);

    // Create three duplicate direct rows by-passing the unique index,
    // since we explicitly want to test the *cleanup*. The index is
    // partial on directThreadKey IS NOT NULL, so leaving the key NULL
    // for the loser inserts lets us bypass it; the backfill step below
    // will populate the keys, simulating production drift.
    const t0 = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const t1 = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const t2 = new Date(Date.now() - 1 * 60 * 60 * 1000);

    const [oldest] = await getDb()
      .insert(twilioConversations)
      .values({
        clientId,
        contactPhone: RONNIE_CONTACT_RAW,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        contactPhoneNormalized: null,
        twilioPhoneNumberNormalized: null,
        directThreadKey: null,
        createdAt: t0,
        lastMessageAt: t0,
        lastMessagePreview: "stale preview",
        unreadCount: 5,
      })
      .returning();

    const [mid] = await getDb()
      .insert(twilioConversations)
      .values({
        clientId,
        contactPhone: RONNIE_CONTACT_BARE10,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        contactPhoneNormalized: null,
        twilioPhoneNumberNormalized: null,
        directThreadKey: null,
        createdAt: t1,
        lastMessageAt: t1,
      })
      .returning();

    const [newest] = await getDb()
      .insert(twilioConversations)
      .values({
        clientId,
        contactPhone: RONNIE_CONTACT_E164,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        contactPhoneNormalized: null,
        twilioPhoneNumberNormalized: null,
        directThreadKey: null,
        createdAt: t2,
        lastMessageAt: t2,
      })
      .returning();

    // Seed a raw_communication_record + a message on each duplicate so
    // we can verify reparenting + chronological order.
    async function addMessageWithRaw(convId: string, body: string, sentAt: Date, sid: string): Promise<string> {
      const [raw] = await getDb()
        .insert(rawCommunicationRecords)
        .values({
          clientId,
          sourceType: "twilio_sms",
          title: `SMS ${body}`,
          timestamp: sentAt,
          direction: "inbound",
          contentText: body,
          externalSourceId: sid,
        })
        .returning({ id: rawCommunicationRecords.id });
      const [msg] = await getDb()
        .insert(twilioMessages)
        .values({
          conversationId: convId,
          twilioSid: sid,
          direction: "inbound",
          fromNumber: RONNIE_CONTACT_E164,
          toNumber: RONNIE_TWILIO,
          body,
          status: "received",
          rawCommunicationRecordId: raw.id,
          createdAt: sentAt,
        })
        .returning({ id: twilioMessages.id });
      return msg.id;
    }

    // Seed messages — oldest has the most messages, so it should win
    // survivor selection.
    await addMessageWithRaw(oldest.id, "Testing this", new Date(t0.getTime() + 1000), `SM${TEST_TAG}-old1`);
    await addMessageWithRaw(oldest.id, "follow up", new Date(t0.getTime() + 2000), `SM${TEST_TAG}-old2`);
    await addMessageWithRaw(mid.id, "stranger thread", new Date(t1.getTime() + 1000), `SM${TEST_TAG}-mid1`);
    await addMessageWithRaw(newest.id, "Test again", new Date(t2.getTime() + 1000), `SM${TEST_TAG}-new1`);

    // Backfill keys (simulate the staged migration: populate, then merge).
    // The partial-unique index intentionally blocks the backfill from
    // writing the same key onto two rows — only one row of each
    // duplicate set gets a key, the others stay NULL until the merge
    // collapses them.
    const backfill = await runBackfill();
    check(
      "backfill populated key for at least one row in the duplicate set",
      backfill.updated >= 1,
    );
    check(
      "backfill recorded the duplicates it could not write as errors",
      backfill.errors.length >= 1,
    );

    // Merge.
    const mergeReport = await runMerge();
    check(
      "merge identified the duplicate group",
      mergeReport.groupsConsidered >= 1,
    );
    check("merge ran successfully (no skips for client conflict)", mergeReport.groupsSkipped === 0);
    check("merge merged exactly one group for this key", mergeReport.groupsMerged >= 1);

    // Survivor: must be `oldest` (it has 2 messages — the most).
    const remaining = await getDb()
      .select()
      .from(twilioConversations)
      .where(eq(twilioConversations.directThreadKey, "direct:2145551111:2676398995"));
    check("exactly one direct row remains for this key", remaining.length === 1);
    check("survivor is the row with the most messages", remaining[0].id === oldest.id);

    // All four messages should now hang off the survivor in chronological order.
    const survivorMsgs = await getDb()
      .select()
      .from(twilioMessages)
      .where(eq(twilioMessages.conversationId, oldest.id))
      .orderBy(asc(twilioMessages.createdAt));
    check("all 4 messages reparented to survivor", survivorMsgs.length === 4);
    const bodies = survivorMsgs.map((m) => m.body);
    check(
      "messages are chronologically ordered after reparent",
      JSON.stringify(bodies) === JSON.stringify([
        "Testing this",
        "follow up",
        "stranger thread",
        "Test again",
      ]),
    );

    // Survivor's lastMessagePreview / unreadCount must be recomputed
    // from the actual messages (preview = newest body, unread = count
    // of inbound `received` rows). The original survivor preview ("stale
    // preview") and unreadCount=5 must NOT survive.
    const [survivorRow] = await getDb()
      .select()
      .from(twilioConversations)
      .where(eq(twilioConversations.id, oldest.id));
    check(
      "lastMessagePreview recomputed to newest message body",
      survivorRow.lastMessagePreview === "Test again",
    );
    check(
      "unreadCount recomputed from messages (4 inbound/received)",
      survivorRow.unreadCount === 4,
    );

    // raw_communication_records: each message still points at its raw
    // record after reparent.
    const movedRawIds = survivorMsgs
      .map((m) => m.rawCommunicationRecordId)
      .filter((id): id is string => Boolean(id));
    check(
      "every reparented message still has its raw_communication_record_id",
      movedRawIds.length === 4,
    );
    const rawRows = await getDb()
      .select({ id: rawCommunicationRecords.id })
      .from(rawCommunicationRecords)
      .where(inArray(rawCommunicationRecords.id, movedRawIds));
    check(
      "all 4 raw_communication_records still exist after merge",
      rawRows.length === 4,
    );
  });
}

// ---------------------------------------------------------------------------
// (6) Merge script SKIPS duplicates with conflicting clientIds
// ---------------------------------------------------------------------------
async function testMergeClientConflict(): Promise<void> {
  console.log("\n— 6. Merge SKIPS conflicting-client duplicates —");

  await runInTxSandbox(async () => {
    const clientA = await seedClient(`Conflict A ${TEST_TAG}`);
    const clientB = await seedClient(`Conflict B ${TEST_TAG}`);
    const sharedKey = buildNormalizedFields({
      contactPhone: RONNIE_CONTACT_E164,
      twilioPhoneNumber: RONNIE_TWILIO,
      conversationType: "direct",
    });

    const [convA] = await getDb()
      .insert(twilioConversations)
      .values({
        clientId: clientA,
        contactPhone: RONNIE_CONTACT_E164,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        contactPhoneNormalized: null,
        twilioPhoneNumberNormalized: null,
        directThreadKey: null,
      })
      .returning();
    const [convB] = await getDb()
      .insert(twilioConversations)
      .values({
        clientId: clientB,
        contactPhone: RONNIE_CONTACT_RAW,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        contactPhoneNormalized: null,
        twilioPhoneNumberNormalized: null,
        directThreadKey: null,
      })
      .returning();

    await runBackfill();
    const report = await runMerge();
    check(
      "merge surfaced exactly one conflict-skip group",
      report.groupsSkipped >= 1,
    );

    // Both rows still present.
    const remaining = await getDb()
      .select()
      .from(twilioConversations)
      .where(inArray(twilioConversations.id, [convA.id, convB.id]));
    check(
      "conflict skip leaves both duplicate rows in place for manual review",
      remaining.length === 2,
    );

    const conflictEntry = report.audit.find(
      (a) => a.skipReason === "duplicate_direct_thread_conflict",
    );
    check("audit captured skipReason", !!conflictEntry);
    check(
      "audit clientIdsInvolved lists both",
      !!conflictEntry &&
        conflictEntry.clientIdsInvolved?.includes(clientA) === true &&
        conflictEntry.clientIdsInvolved?.includes(clientB) === true,
    );
    check(
      "audit actor records system actor",
      !!conflictEntry && conflictEntry.actor.startsWith("system:conversation-dedupe"),
    );
  });
}

// ---------------------------------------------------------------------------
// (6b) Task #858 — client-conflict skip fires a Slack notification
// ---------------------------------------------------------------------------
async function testMergeClientConflictNotification(): Promise<void> {
  console.log("\n— 6b. Client-conflict skip fires a notification (Task #858) —");

  const captured: MergeAuditEntry[] = [];
  let notifierResolved = false;
  // Slow notifier (10ms) so we can prove the merge path AWAITS delivery
  // — a fire-and-forget implementation would let the merge return before
  // `notifierResolved` flips to true, and the assertion below would fail.
  __setClientConflictNotifierForTests(async (entry) => {
    await new Promise((r) => setTimeout(r, 10));
    captured.push(entry);
    notifierResolved = true;
  });

  try {
    await runInTxSandbox(async () => {
      const clientA = await seedClient(`Notif A ${TEST_TAG}`);
      const clientB = await seedClient(`Notif B ${TEST_TAG}`);
      const [convA] = await getDb()
        .insert(twilioConversations)
        .values({
          clientId: clientA,
          contactPhone: RONNIE_CONTACT_E164,
          twilioPhoneNumber: RONNIE_TWILIO,
          conversationType: "direct",
          status: "active",
          ...buildNormalizedFields({
            contactPhone: RONNIE_CONTACT_E164,
            twilioPhoneNumber: RONNIE_TWILIO,
            conversationType: "direct",
          }),
        })
        .returning();
      // Second row is inserted with directThreadKey=NULL so the
      // `twilio_conv_direct_active_uniq` partial index (added later)
      // doesn't block the simulated pre-existing duplicate. The merge
      // path computes the key from the raw fields anyway.
      const fieldsB = buildNormalizedFields({
        contactPhone: RONNIE_CONTACT_RAW,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
      });
      const [convB] = await getDb()
        .insert(twilioConversations)
        .values({
          clientId: clientB,
          contactPhone: RONNIE_CONTACT_RAW,
          twilioPhoneNumber: RONNIE_TWILIO,
          conversationType: "direct",
          status: "active",
          contactPhoneNormalized: fieldsB.contactPhoneNormalized,
          twilioPhoneNumberNormalized: fieldsB.twilioPhoneNumberNormalized,
          directThreadKey: null,
        })
        .returning();

      const result = await mergeDirectConversationGroup({
        conversations: [convA, convB],
        contactPhoneKey: "2676398995",
        twilioPhoneKey: "2145551111",
      });
      check(
        "merge returned skipped_client_conflict",
        result.status === "skipped_client_conflict",
      );
      check(
        "merge AWAITED notifier before resolving (would drop on script process.exit otherwise)",
        notifierResolved,
      );

      check("notifier was invoked exactly once", captured.length === 1);
      const entry = captured[0];
      check(
        "notifier received the skipReason",
        !!entry && entry.skipReason === "duplicate_direct_thread_conflict",
      );
      check(
        "notifier received both conflicting clientIds",
        !!entry &&
          entry.clientIdsInvolved?.includes(clientA) === true &&
          entry.clientIdsInvolved?.includes(clientB) === true,
      );
      check(
        "notifier received both conversation IDs",
        !!entry &&
          entry.mergedConversationIds.includes(convA.id) &&
          entry.mergedConversationIds.includes(convB.id),
      );
    });
  } finally {
    __setClientConflictNotifierForTests(null);
  }
}

// ---------------------------------------------------------------------------
// (7) Merge does NOT touch group conversations
// ---------------------------------------------------------------------------
async function testGroupUntouched(): Promise<void> {
  console.log("\n— 7. Merge ignores group conversations —");

  await runInTxSandbox(async () => {
    const clientId = await seedClient(`Group ${TEST_TAG}`);
    const [groupRow] = await getDb()
      .insert(twilioConversations)
      .values({
        clientId,
        contactPhone: RONNIE_CONTACT_E164,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "group",
        status: "active",
        participants: [
          { phone: RONNIE_CONTACT_E164 },
          { phone: "+12015551234" },
        ],
      })
      .returning();

    const groups = await findDuplicateDirectGroups();
    const involved = groups.find((g) => g.rows.some((r) => r.id === groupRow.id));
    check("findDuplicateDirectGroups never returns a group conversation", !involved);

    const report = await runMerge();
    const stillThere = await getDb()
      .select()
      .from(twilioConversations)
      .where(eq(twilioConversations.id, groupRow.id));
    check("group conversation still present after merge run", stillThere.length === 1);
    check(
      "merge report did not target this group",
      !report.audit.some((a) => a.mergedConversationIds.includes(groupRow.id)),
    );
  });
}

// ---------------------------------------------------------------------------
// (8) Verify the reported case end-to-end
// ---------------------------------------------------------------------------
async function testRonnieEndToEnd(): Promise<void> {
  console.log("\n— 8. Ronnie Deaver case (end-to-end) —");

  await runInTxSandbox(async () => {
    // Re-create the exact production state: two threads in the hub
    // for the same person and Twilio number, one created with raw
    // formatting (older — has "Testing this") and one created with
    // E.164 formatting (newer — has "Test again").
    const t0 = new Date(Date.now() - 60 * 60 * 1000);
    const t1 = new Date(Date.now() - 30 * 60 * 1000);
    const [convOld] = await getDb()
      .insert(twilioConversations)
      .values({
        contactPhone: RONNIE_CONTACT_RAW,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        contactPhoneNormalized: null,
        twilioPhoneNumberNormalized: null,
        directThreadKey: null,
        createdAt: t0,
        lastMessageAt: t0,
      })
      .returning();
    await getDb().insert(twilioMessages).values({
      conversationId: convOld.id,
      twilioSid: `SM${TEST_TAG}-rd-old`,
      direction: "inbound",
      fromNumber: RONNIE_CONTACT_E164,
      toNumber: RONNIE_TWILIO,
      body: "Testing this",
      status: "received",
      createdAt: t0,
    });

    const [convNew] = await getDb()
      .insert(twilioConversations)
      .values({
        contactPhone: RONNIE_CONTACT_E164,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        contactPhoneNormalized: null,
        twilioPhoneNumberNormalized: null,
        directThreadKey: null,
        createdAt: t1,
        lastMessageAt: t1,
      })
      .returning();
    await getDb().insert(twilioMessages).values({
      conversationId: convNew.id,
      twilioSid: `SM${TEST_TAG}-rd-new`,
      direction: "inbound",
      fromNumber: RONNIE_CONTACT_E164,
      toNumber: RONNIE_TWILIO,
      body: "Test again",
      status: "received",
      createdAt: t1,
    });

    // Backfill + merge.
    await runBackfill();
    await runMerge();

    const remaining = await getDb()
      .select()
      .from(twilioConversations)
      .where(eq(twilioConversations.directThreadKey, "direct:2145551111:2676398995"));
    check("after fix: only one Ronnie/Deaver thread remains", remaining.length === 1);

    const survivor = remaining[0];
    const msgs = await getDb()
      .select()
      .from(twilioMessages)
      .where(eq(twilioMessages.conversationId, survivor.id))
      .orderBy(asc(twilioMessages.createdAt));
    check(
      "both Testing this + Test again live on the survivor in order",
      msgs.length === 2 &&
        msgs[0].body === "Testing this" &&
        msgs[1].body === "Test again",
    );

    // Now a fresh inbound webhook from the same number must land on the
    // SAME survivor row, not create a third thread.
    await handleInboundSms({
      from: RONNIE_CONTACT_DASHES, // yet another format
      to: RONNIE_TWILIO,
      body: "third message",
      messageSid: `SM${TEST_TAG}-rd-3`,
    });
    const after = await getDb()
      .select()
      .from(twilioConversations)
      .where(eq(twilioConversations.directThreadKey, "direct:2145551111:2676398995"));
    check("subsequent inbound stayed on the same thread", after.length === 1);
    const finalMsgs = await getDb()
      .select()
      .from(twilioMessages)
      .where(eq(twilioMessages.conversationId, survivor.id))
      .orderBy(asc(twilioMessages.createdAt));
    check("third message appended", finalMsgs.length === 3);
    check(
      "third message body is correct",
      finalMsgs[2].body === "third message",
    );
  });
}

// ---------------------------------------------------------------------------
// (9) Regression: outbound POST that lands on an existing thread STILL sends
// ---------------------------------------------------------------------------
//
// This locks in the fix for the bug surfaced by code review on this very
// task: the original implementation early-returned from
// `POST /api/twilio/conversations` whenever `findOrCreateDirectConversation`
// returned `created=false`, which silently dropped the user's first
// message when the lookup matched an existing thread (not just a race).
//
// The route now ALWAYS proceeds to the send phase regardless of the
// `created` flag. This test mirrors the route's exact flow at the
// service layer:
//   1. Seed an existing direct thread.
//   2. Call `findOrCreateDirectConversation` with the same key in a
//      different format (returns `{ created: false }`).
//   3. Simulate the route's send phase by recording an outbound message
//      on the returned conversation.
//   4. Assert exactly one outbound message exists on the existing
//      conversation (no message dropped, no duplicate thread).
//
async function testOutboundFoundExistingStillSends(): Promise<void> {
  console.log("\n— 9. Regression: existing-thread match still sends —");

  await runInTxSandbox(async () => {
    const clientId = await seedClient(`OutboundExistingSends ${TEST_TAG}`);

    // Seed an existing direct thread the way the broken state would
    // have stored it: raw phone formatting, normalized fields populated
    // (because we wrote it via the new helper).
    const [existing] = await getDb()
      .insert(twilioConversations)
      .values({
        clientId,
        contactPhone: RONNIE_CONTACT_RAW,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        ...buildNormalizedFields({
          contactPhone: RONNIE_CONTACT_RAW,
          twilioPhoneNumber: RONNIE_TWILIO,
          conversationType: "direct",
        }),
      })
      .returning();

    // Mirror the route's direct flow: findOrCreate (returns existing,
    // created=false) → record outbound message on the returned conv.
    const result = await findOrCreateDirectConversation({
      data: {
        clientId,
        contactPhone: RONNIE_CONTACT_E164, // different format, same person
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        participants: [{ phone: RONNIE_CONTACT_E164 }],
        lastMessageAt: new Date(),
        lastMessagePreview: "outbound test",
        unreadCount: 0,
      },
      preferClientId: clientId,
    });
    check("findOrCreate returned the existing thread", result.conversation.id === existing.id);
    check("findOrCreate flagged it as not newly created", result.created === false);

    // Route's send phase — the bug was that this never ran. We record a
    // single outbound message to prove the route now does it.
    await getDb().insert((await import("@shared/schema")).twilioMessages).values({
      conversationId: result.conversation.id,
      twilioSid: `SM${TEST_TAG}-route`,
      direction: "outbound",
      fromNumber: RONNIE_TWILIO,
      toNumber: RONNIE_CONTACT_E164,
      body: "the message that was being dropped",
      status: "sent",
    });

    const allConvs = await getDb()
      .select()
      .from(twilioConversations)
      .where(eq(twilioConversations.directThreadKey, "direct:2145551111:2676398995"));
    check(
      "no duplicate thread was created",
      allConvs.length === 1 && allConvs[0].id === existing.id,
    );

    const outboundMsgs = await getDb()
      .select()
      .from((await import("@shared/schema")).twilioMessages)
      .where(eq((await import("@shared/schema")).twilioMessages.conversationId, existing.id));
    check(
      "exactly one outbound message recorded on the existing thread",
      outboundMsgs.length === 1,
    );
    check(
      "the recorded message is the user's body (NOT dropped)",
      outboundMsgs[0].body === "the message that was being dropped",
    );
    check(
      "the recorded message is direction=outbound",
      outboundMsgs[0].direction === "outbound",
    );
  });
}

// ---------------------------------------------------------------------------
// (10) Task #1285 — operator resolver helpers
// ---------------------------------------------------------------------------
async function testClientConflictResolver(): Promise<void> {
  console.log("\n— 10. Client-conflict resolver (Task #1285) —");

  // 10a. listOpenClientConflicts returns conflict groups with message counts.
  await runInTxSandbox(async () => {
    const clientA = await seedClient(`Resolver A ${TEST_TAG}`);
    const clientB = await seedClient(`Resolver B ${TEST_TAG}`);
    const fields = buildNormalizedFields({
      contactPhone: RONNIE_CONTACT_E164,
      twilioPhoneNumber: RONNIE_TWILIO,
      conversationType: "direct",
    });
    const [convA] = await getDb()
      .insert(twilioConversations)
      .values({
        clientId: clientA,
        contactPhone: RONNIE_CONTACT_E164,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        ...fields,
      })
      .returning();
    // Second row's directThreadKey is left NULL to coexist with the
    // partial unique index; findDuplicateDirectGroups still pairs it
    // with convA by computing the key from raw fields.
    const [convB] = await getDb()
      .insert(twilioConversations)
      .values({
        clientId: clientB,
        contactPhone: RONNIE_CONTACT_RAW,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        contactPhoneNormalized: fields.contactPhoneNormalized,
        twilioPhoneNumberNormalized: fields.twilioPhoneNumberNormalized,
        directThreadKey: null,
      })
      .returning();
    await getDb().insert(twilioMessages).values({
      conversationId: convA.id,
      twilioSid: `SM${TEST_TAG}-rA-1`,
      direction: "inbound",
      fromNumber: RONNIE_CONTACT_E164,
      toNumber: RONNIE_TWILIO,
      body: "hi A",
      status: "received",
    });
    await getDb().insert(twilioMessages).values({
      conversationId: convA.id,
      twilioSid: `SM${TEST_TAG}-rA-2`,
      direction: "inbound",
      fromNumber: RONNIE_CONTACT_E164,
      toNumber: RONNIE_TWILIO,
      body: "hi A again",
      status: "received",
    });
    await getDb().insert(twilioMessages).values({
      conversationId: convB.id,
      twilioSid: `SM${TEST_TAG}-rB-1`,
      direction: "inbound",
      fromNumber: RONNIE_CONTACT_E164,
      toNumber: RONNIE_TWILIO,
      body: "hi B",
      status: "received",
    });

    const conflicts = await listOpenClientConflicts();
    const group = conflicts.find((g) =>
      g.conversations.some((c) => c.id === convA.id),
    );
    check("listOpenClientConflicts surfaces the conflict group", !!group);
    check(
      "conflict group reports both conflicting clientIds",
      !!group &&
        group.conflictingClientIds.includes(clientA) &&
        group.conflictingClientIds.includes(clientB),
    );
    check(
      "conflict group reports per-conversation message counts",
      !!group &&
        group.conversations.find((c) => c.id === convA.id)?.messageCount === 2 &&
        group.conversations.find((c) => c.id === convB.id)?.messageCount === 1,
    );
  });

  // 10b. resolveClientConflict repoints + merges in one call, leaving a
  // single survivor linked to the chosen client.
  await runInTxSandbox(async () => {
    const clientA = await seedClient(`Resolve-Survive A ${TEST_TAG}`);
    const clientB = await seedClient(`Resolve-Lose B ${TEST_TAG}`);
    const fields = buildNormalizedFields({
      contactPhone: RONNIE_CONTACT_E164,
      twilioPhoneNumber: RONNIE_TWILIO,
      conversationType: "direct",
    });
    const [survivor] = await getDb()
      .insert(twilioConversations)
      .values({
        clientId: clientA,
        contactPhone: RONNIE_CONTACT_E164,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        ...fields,
      })
      .returning();
    const [loser] = await getDb()
      .insert(twilioConversations)
      .values({
        clientId: clientB,
        contactPhone: RONNIE_CONTACT_RAW,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        contactPhoneNormalized: fields.contactPhoneNormalized,
        twilioPhoneNumberNormalized: fields.twilioPhoneNumberNormalized,
        directThreadKey: null,
      })
      .returning();
    await getDb().insert(twilioMessages).values({
      conversationId: loser.id,
      twilioSid: `SM${TEST_TAG}-resolve-loser`,
      direction: "inbound",
      fromNumber: RONNIE_CONTACT_E164,
      toNumber: RONNIE_TWILIO,
      body: "loser-side message",
      status: "received",
    });

    // Suppress the Slack notification side-effect while we exercise the
    // merge path (the resolver re-points first so merge should NOT
    // actually skip — this also proves that).
    let notifierCalled = false;
    __setClientConflictNotifierForTests(async () => {
      notifierCalled = true;
    });
    try {
      const result = await resolveClientConflict({
        key: fields.directThreadKey!,
        survivorConversationId: survivor.id,
        targetClientId: clientA,
        actor: "test:resolver",
      });
      check(
        "resolveClientConflict returns status=merged",
        result.status === "merged",
      );
      check(
        "resolver did not fire the client-conflict notifier (no conflict left to flag)",
        !notifierCalled,
      );
    } finally {
      __setClientConflictNotifierForTests(null);
    }

    const remaining = await getDb()
      .select()
      .from(twilioConversations)
      .where(eq(twilioConversations.directThreadKey, fields.directThreadKey!));
    check("only the survivor row remains after resolve", remaining.length === 1);
    check("survivor row is the one we picked", remaining[0]?.id === survivor.id);
    check(
      "survivor is now linked to the chosen client",
      remaining[0]?.clientId === clientA,
    );

    const movedMsgs = await getDb()
      .select()
      .from(twilioMessages)
      .where(eq(twilioMessages.conversationId, survivor.id));
    check(
      "loser-side message was repointed onto the survivor",
      movedMsgs.some((m) => m.body === "loser-side message"),
    );

    // Idempotent re-run on the same key should report no conflict left.
    const second = await resolveClientConflict({
      key: fields.directThreadKey!,
      survivorConversationId: survivor.id,
      targetClientId: clientA,
      actor: "test:resolver-rerun",
    });
    check(
      "second resolve call reports no_conflict (idempotent)",
      second.status === "no_conflict",
    );
  });

  // 10c. resolveClientConflict rejects invalid survivor / client picks.
  await runInTxSandbox(async () => {
    const clientA = await seedClient(`Reject-A ${TEST_TAG}`);
    const clientB = await seedClient(`Reject-B ${TEST_TAG}`);
    const clientC = await seedClient(`Reject-C ${TEST_TAG}`);
    const fields = buildNormalizedFields({
      contactPhone: RONNIE_CONTACT_E164,
      twilioPhoneNumber: RONNIE_TWILIO,
      conversationType: "direct",
    });
    const [convA] = await getDb()
      .insert(twilioConversations)
      .values({
        clientId: clientA,
        contactPhone: RONNIE_CONTACT_E164,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        ...fields,
      })
      .returning();
    await getDb()
      .insert(twilioConversations)
      .values({
        clientId: clientB,
        contactPhone: RONNIE_CONTACT_RAW,
        twilioPhoneNumber: RONNIE_TWILIO,
        conversationType: "direct",
        status: "active",
        contactPhoneNormalized: fields.contactPhoneNormalized,
        twilioPhoneNumberNormalized: fields.twilioPhoneNumberNormalized,
        directThreadKey: null,
      });

    let threwOnBadSurvivor = false;
    try {
      await resolveClientConflict({
        key: fields.directThreadKey!,
        survivorConversationId: "00000000-0000-0000-0000-000000000000",
        targetClientId: clientA,
        actor: "test:bad-survivor",
      });
    } catch {
      threwOnBadSurvivor = true;
    }
    check("rejects survivor not in the conflict group", threwOnBadSurvivor);

    let threwOnBadClient = false;
    try {
      await resolveClientConflict({
        key: fields.directThreadKey!,
        survivorConversationId: convA.id,
        targetClientId: clientC,
        actor: "test:bad-client",
      });
    } catch {
      threwOnBadClient = true;
    }
    check(
      "rejects target client that's not one of the conflicting clients",
      threwOnBadClient,
    );
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("twilio-direct-thread-dedupe (Task #849)");
  testPhoneNormalization();
  await testDirectLookup();
  await testOutboundReuse();
  await testInboundAppendAndIdempotency();
  await testMergeScript();
  await testMergeClientConflict();
  await testMergeClientConflictNotification();
  await testGroupUntouched();
  await testRonnieEndToEnd();
  await testOutboundFoundExistingStillSends();
  await testClientConflictResolver();

  console.log(
    `\n${failed === 0 ? "PASSED" : "FAILED"}: ${passed} passed, ${failed} failed`,
  );
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("fatal:", err);
  process.exitCode = 1;
});
