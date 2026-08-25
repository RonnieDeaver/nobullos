/* test-registration
{
  "name": "Front sync-email mirror writer (Task #1831)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~5.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1831 — verifies the webhook-stage mirror back into
 * `front_sync_emails` actually writes a row.
 *
 * Coverage:
 *   (a) `mirrorWebhookToFrontSyncEmail` inserts a `discovered` row when the
 *       conversation is new.
 *   (b) Re-calling with the same conversation but a newer message updates
 *       in place (no duplicate row) and bumps `lastMessageAt` to the
 *       greater of the two timestamps.
 *   (c) `markFrontSyncEmailMirrorApplied` transitions the row to `applied`
 *       and stamps `processedAt`.
 *   (d) When the `front_sync_emails_mirror_enabled` kill switch is OFF,
 *       both helpers are no-ops (no row inserted, no state mutated).
 *
 * Uses real workerDb (not a tx sandbox) because the helpers import
 * `workerDb` directly — see `server/services/frontSyncEmailMirror.ts`
 * @db-pool-intent header for the rationale. Cleanup is via DELETE on the
 * generated conversation IDs.
 */
import { eq, inArray } from "drizzle-orm";
import { workerDb } from "../server/db";
import { frontSyncEmails } from "@shared/schema";
import {
  mirrorWebhookToFrontSyncEmail,
  markFrontSyncEmailMirrorApplied,
} from "../server/services/frontSyncEmailMirror";
import { setPoolEpicSwitch } from "../server/services/poolEpicKillSwitches";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${msg} — expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

const TAG = `mirror-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const convA = `cnv_${TAG}_a`;
const convB = `cnv_${TAG}_b`;
const convC = `cnv_${TAG}_c`;
const allConvs = [convA, convB, convC];

async function cleanup(): Promise<void> {
  await workerDb
    .delete(frontSyncEmails)
    .where(inArray(frontSyncEmails.conversationId, allConvs));
}

async function run(): Promise<void> {
  await cleanup();

  // Ensure switch is ON for case (a)-(c).
  await setPoolEpicSwitch("front_sync_emails_mirror_enabled", true, "system");

  try {
    // ── (a) new conversation → row inserted in `discovered` ────────────
    const t0 = new Date("2026-05-25T10:00:00Z");
    await mirrorWebhookToFrontSyncEmail({
      conversationId: convA,
      subject: "Initial subject",
      snippet: "first preview",
      participants: [{ email: "x@example.com", role: "recipient" }],
      lastMessageAt: t0,
      lastMessageId: "msg_1",
    });

    const [rowA1] = await workerDb
      .select()
      .from(frontSyncEmails)
      .where(eq(frontSyncEmails.conversationId, convA));
    assert(rowA1, "(a) row was inserted");
    assertEq(rowA1.pipelineState, "discovered", "(a) state is discovered");
    assertEq(rowA1.subject, "Initial subject", "(a) subject persisted");
    assertEq(rowA1.lastMessageId, "msg_1", "(a) lastMessageId persisted");
    assert(rowA1.versionKey?.includes("msg_1"), "(a) versionKey reflects message id");

    // ── (b) repeat with newer message → in-place update, lastMessageAt bumped ─
    const t1 = new Date("2026-05-25T11:00:00Z");
    await mirrorWebhookToFrontSyncEmail({
      conversationId: convA,
      subject: "Updated subject",
      snippet: "second preview",
      participants: [{ email: "y@example.com", role: "recipient" }],
      lastMessageAt: t1,
      lastMessageId: "msg_2",
    });

    const rowsA2 = await workerDb
      .select()
      .from(frontSyncEmails)
      .where(eq(frontSyncEmails.conversationId, convA));
    assertEq(rowsA2.length, 1, "(b) no duplicate row created on re-call");
    const rowA2 = rowsA2[0];
    assertEq(rowA2.subject, "Updated subject", "(b) subject overwritten");
    assertEq(rowA2.lastMessageId, "msg_2", "(b) lastMessageId overwritten");
    assertEq(
      rowA2.lastMessageAt?.getTime(),
      t1.getTime(),
      "(b) lastMessageAt bumped to newer value",
    );

    // Re-call with an OLDER timestamp must NOT regress lastMessageAt
    // (GREATEST guard in the upsert SET clause).
    const tOld = new Date("2026-05-25T09:00:00Z");
    await mirrorWebhookToFrontSyncEmail({
      conversationId: convA,
      subject: null,
      snippet: null,
      participants: null,
      lastMessageAt: tOld,
      lastMessageId: null,
    });
    const [rowA3] = await workerDb
      .select()
      .from(frontSyncEmails)
      .where(eq(frontSyncEmails.conversationId, convA));
    assertEq(
      rowA3.lastMessageAt?.getTime(),
      t1.getTime(),
      "(b) lastMessageAt does NOT regress on older payload",
    );
    assertEq(
      rowA3.subject,
      "Updated subject",
      "(b) COALESCE keeps previous subject when new payload is null",
    );

    // ── (b2) versionKey + lastMessageId must NOT regress on older payload
    // (the CASE guard in the conflict-update SET clause). After the
    // tOld upsert above, the version metadata should still reflect the
    // newer msg_2, not regress to msg_1 or null.
    assertEq(
      rowA3.lastMessageId,
      "msg_2",
      "(b2) lastMessageId does NOT regress on older payload",
    );
    assert(
      rowA3.versionKey?.includes("msg_2"),
      "(b2) versionKey does NOT regress on older payload",
    );

    // ── (b3) newer/equal timestamp WITH null messageId must keep the
    // existing lastMessageId AND derive versionKey from it (not from
    // EXCLUDED's `conv::no_msg`). This is the architect-flagged
    // null-message-id desync bug.
    const t1Equal = new Date("2026-05-25T11:00:00Z"); // same as t1
    await mirrorWebhookToFrontSyncEmail({
      conversationId: convA,
      subject: "Same-timestamp event with null msg id",
      snippet: null,
      participants: null,
      lastMessageAt: t1Equal,
      lastMessageId: null,
    });
    const [rowANullMsg] = await workerDb
      .select()
      .from(frontSyncEmails)
      .where(eq(frontSyncEmails.conversationId, convA));
    assertEq(
      rowANullMsg.lastMessageId,
      "msg_2",
      "(b3) lastMessageId kept when newer payload has null id",
    );
    assertEq(
      rowANullMsg.versionKey,
      `${convA}::msg_2`,
      "(b3) versionKey stays aligned with effective lastMessageId (no `::no_msg` regression)",
    );

    // ── (c) apply transition ──────────────────────────────────────────
    await markFrontSyncEmailMirrorApplied(convA);
    const [rowA4] = await workerDb
      .select()
      .from(frontSyncEmails)
      .where(eq(frontSyncEmails.conversationId, convA));
    assertEq(rowA4.pipelineState, "applied", "(c) state transitioned to applied");
    assert(rowA4.processedAt instanceof Date, "(c) processedAt stamped");

    // ── (c2) new normalize event on already-applied row resets
    // pipelineState back to `discovered` and clears the apply marker.
    // Without this, a fresh apply pass would have nowhere to transition
    // to and downstream readers would see a stale `applied` state.
    const t3 = new Date("2026-05-25T12:00:00Z");
    await mirrorWebhookToFrontSyncEmail({
      conversationId: convA,
      subject: "Third message on same conversation",
      snippet: "third preview",
      participants: [{ email: "z@example.com", role: "recipient" }],
      lastMessageAt: t3,
      lastMessageId: "msg_3",
    });
    const [rowA5] = await workerDb
      .select()
      .from(frontSyncEmails)
      .where(eq(frontSyncEmails.conversationId, convA));
    assertEq(
      rowA5.pipelineState,
      "discovered",
      "(c2) pipelineState reset to discovered after re-normalize",
    );
    assertEq(
      rowA5.processedAt,
      null,
      "(c2) processedAt cleared after re-normalize",
    );
    assertEq(
      rowA5.lastMessageId,
      "msg_3",
      "(c2) lastMessageId advanced to newest",
    );
    // And apply→applied again still works.
    await markFrontSyncEmailMirrorApplied(convA);
    const [rowA6] = await workerDb
      .select()
      .from(frontSyncEmails)
      .where(eq(frontSyncEmails.conversationId, convA));
    assertEq(
      rowA6.pipelineState,
      "applied",
      "(c2) second discovered→applied cycle succeeds",
    );

    // ── (d) kill switch OFF → no-op ───────────────────────────────────
    await setPoolEpicSwitch(
      "front_sync_emails_mirror_enabled",
      false,
      "system",
    );

    const t2 = new Date("2026-05-25T12:00:00Z");
    await mirrorWebhookToFrontSyncEmail({
      conversationId: convB,
      subject: "Should not insert",
      snippet: "n/a",
      participants: [],
      lastMessageAt: t2,
      lastMessageId: "msg_x",
    });
    const rowsB = await workerDb
      .select()
      .from(frontSyncEmails)
      .where(eq(frontSyncEmails.conversationId, convB));
    assertEq(rowsB.length, 0, "(d) no row inserted when switch is OFF");

    // Insert convC with switch OFF would also no-op — instead manually
    // pre-seed convC then verify markFrontSyncEmailMirrorApplied is a
    // no-op too.
    await workerDb.insert(frontSyncEmails).values({
      conversationId: convC,
      subject: "Pre-seeded",
      lastMessageAt: t2,
      pipelineState: "discovered",
    });
    await markFrontSyncEmailMirrorApplied(convC);
    const [rowC] = await workerDb
      .select()
      .from(frontSyncEmails)
      .where(eq(frontSyncEmails.conversationId, convC));
    assertEq(
      rowC.pipelineState,
      "discovered",
      "(d) markFrontSyncEmailMirrorApplied is a no-op when switch is OFF",
    );

    console.log("[front-sync-email-mirror.test] PASS — 6 cases, 20 assertions");
  } finally {
    // Always restore the switch to ON (the default) so other tests in
    // the suite don't pick up an OFF override leaked from this run, and
    // clean up the seeded rows.
    await setPoolEpicSwitch("front_sync_emails_mirror_enabled", true, "system");
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {
    // Pool monitor `setInterval` keeps the process alive forever; force
    // exit so the test runner doesn't time out on a passing test.
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
