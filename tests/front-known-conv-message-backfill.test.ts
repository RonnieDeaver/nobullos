/* test-registration
{
  "name": "Known-conversation per-message backfill — walk/checkpoint/blocked/transient (Task #2716)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2716: the known-conversation per-message backfill walks `front_sync_emails` DIRECTLY (Front search under-enumerates) to write the ~120k missing per-message rows that block \"Bring it to 100%\". A regression in the walk/cursor advance, the auth-death checkpoint-pin (re-fetch the failed conversation, never skip its messages), the transient-error skip, or the disabled-switch gate would silently re-break coverage convergence. Gate this fast, DB-free, deterministic test (every external touch is a seam).",
  "tier": "small"
}
test-registration */
/**
 * Task #2716 — Known-conversation per-message backfill.
 *
 * The Task #2708 applied-conversation materializer re-walks a month via Front's
 * Conversations Search, which under-enumerates: `front_sync_emails` tracks more
 * conversations for a month than search `_total` returns, so the extra (already
 * known) conversations never get their per-message rows written. This driver
 * enumerates those conversations DIRECTLY from `front_sync_emails` and writes
 * each missing per-message row through the shared `materializeFrontMessageRecord`
 * helper (deduped on external_source_id).
 *
 * Deterministic units (no live Front / no DB needed — every external touch is a
 * test-seam override):
 *   1. Disabled switch ⇒ status "disabled", done, zero writes.
 *   2. Happy path ⇒ fetches every selected conversation's messages, counts
 *      inserted vs deduped(skipped), advances the checkpoint to the last
 *      conversation, and reports done when the page is short.
 *   3. Resume ⇒ the previous checkpoint's cursor is forwarded to the selector.
 *   4. Full page (rows === budget) ⇒ done=false so the caller keeps walking.
 *   5. Auth death mid-walk ⇒ status "blocked", checkpoint pinned BEFORE the
 *      failed conversation so the next tick re-fetches it (no skipped messages).
 *   6. Transient per-conversation error ⇒ counted, cursor advances past it, the
 *      walk continues (does not wedge).
 *   7. The convergence-lens registry descriptor is registered.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  runKnownConversationMessageBackfill,
  KNOWN_CONV_BACKFILL_REQUIRED_SWITCH,
  KNOWN_CONV_BACKFILL_CONVERSATION_BUDGET_DEFAULT,
  __knownConvBackfillTestHelpers as H,
} from "../server/services/frontHistoricalRecovery";
import { FrontAuthError } from "../server/services/frontIntegration";
import { setPoolEpicSwitch } from "../server/services/poolEpicKillSwitches";
import { FRONT_CONSOLE_METRIC_REGISTRY } from "../shared/frontConsoleMetrics";

const WINDOW = {
  label: "2991-12",
  monthStart: new Date(Date.UTC(2991, 11, 1)),
  monthEnd: new Date(Date.UTC(2992, 0, 1)),
};

function resetOverrides(): void {
  H.setSelectOverride(null);
  H.setFetchMessagesOverride(null);
  H.setMaterializeOverride(null);
  H.setValidateAuthOverride(null);
}

/** Auth always passes in tests unless a case overrides the fetcher to throw. */
function authPasses(): void {
  H.setValidateAuthOverride(async () => {});
}

test("Task #2716 — disabled switch no-ops with status=disabled and no writes", async () => {
  resetOverrides();
  await setPoolEpicSwitch(KNOWN_CONV_BACKFILL_REQUIRED_SWITCH, false);
  let selected = false;
  H.setSelectOverride(async () => {
    selected = true;
    return [];
  });
  const r = await runKnownConversationMessageBackfill(WINDOW, null);
  assert.equal(r.status, "disabled");
  assert.equal(r.done, true);
  assert.equal(r.inserted, 0);
  assert.equal(r.scanned, 0);
  assert.equal(selected, false, "selector must not run when the switch is OFF");
  resetOverrides();
});

test("Task #2716 — happy path: fetch, materialize, count inserted vs deduped, advance checkpoint, done on short page", async () => {
  resetOverrides();
  await setPoolEpicSwitch(KNOWN_CONV_BACKFILL_REQUIRED_SWITCH, true);
  authPasses();

  // 2 conversations: conv A has 2 messages (both new), conv B has 1 (deduped).
  H.setSelectOverride(async () => [
    { conversationId: "cnv_a", subject: "A", lastMessageAt: new Date() },
    { conversationId: "cnv_b", subject: "B", lastMessageAt: new Date() },
  ]);
  const fetched: string[] = [];
  H.setFetchMessagesOverride(async (conversationId) => {
    fetched.push(conversationId);
    if (conversationId === "cnv_a")
      return [{ id: "msg_a1" }, { id: "msg_a2" }] as any;
    return [{ id: "msg_b1" }] as any;
  });
  const written: string[] = [];
  H.setMaterializeOverride(async ({ msg }) => {
    written.push(msg.id);
    return msg.id === "msg_b1" ? "skipped" : "inserted";
  });

  const r = await runKnownConversationMessageBackfill(WINDOW, null);
  assert.equal(r.status, "ok");
  assert.deepEqual(fetched, ["cnv_a", "cnv_b"]);
  assert.deepEqual(written, ["msg_a1", "msg_a2", "msg_b1"]);
  assert.equal(r.fetched, 2);
  assert.equal(r.scanned, 2);
  assert.equal(r.inserted, 2);
  assert.equal(r.skipped, 1);
  assert.equal(r.errors, 0);
  assert.equal(r.checkpoint.afterConversationId, "cnv_b");
  assert.equal(r.done, true, "short page (2 < budget) ⇒ walk exhausted");
  resetOverrides();
});

test("Task #2716 — resume forwards the previous checkpoint cursor to the selector", async () => {
  resetOverrides();
  await setPoolEpicSwitch(KNOWN_CONV_BACKFILL_REQUIRED_SWITCH, true);
  authPasses();
  let seenCursor: string | null = "UNSET";
  H.setSelectOverride(async (_w, after) => {
    seenCursor = after;
    return [];
  });
  const r = await runKnownConversationMessageBackfill(WINDOW, {
    afterConversationId: "cnv_resume",
  });
  assert.equal(seenCursor, "cnv_resume");
  // No rows after the cursor ⇒ window exhausted.
  assert.equal(r.done, true);
  assert.equal(r.status, "ok");
  assert.equal(r.checkpoint.afterConversationId, "cnv_resume");
  resetOverrides();
});

test("Task #2716 — a full page (rows === budget) reports done=false so the caller keeps walking", async () => {
  resetOverrides();
  await setPoolEpicSwitch(KNOWN_CONV_BACKFILL_REQUIRED_SWITCH, true);
  authPasses();
  const budget = 3;
  H.setSelectOverride(async (_w, _after, limit) => {
    assert.equal(limit, budget);
    return Array.from({ length: budget }, (_v, i) => ({
      conversationId: `cnv_${i}`,
      subject: null,
      lastMessageAt: null,
    }));
  });
  H.setFetchMessagesOverride(async () => [] as any);
  const r = await runKnownConversationMessageBackfill(WINDOW, null, {
    conversationBudget: budget,
  });
  assert.equal(r.scanned, budget);
  assert.equal(r.done, false, "full page ⇒ more conversations may remain");
  assert.equal(r.checkpoint.afterConversationId, `cnv_${budget - 1}`);
  resetOverrides();
});

test("Task #2716 — auth death mid-walk ⇒ blocked, checkpoint pinned before the failed conversation", async () => {
  resetOverrides();
  await setPoolEpicSwitch(KNOWN_CONV_BACKFILL_REQUIRED_SWITCH, true);
  authPasses();
  H.setSelectOverride(async () => [
    { conversationId: "cnv_1", subject: "1", lastMessageAt: null },
    { conversationId: "cnv_2", subject: "2", lastMessageAt: null },
    { conversationId: "cnv_3", subject: "3", lastMessageAt: null },
  ]);
  H.setFetchMessagesOverride(async (conversationId) => {
    if (conversationId === "cnv_2") {
      throw new FrontAuthError("front_not_connected", "revoked");
    }
    return [{ id: `${conversationId}_m1` }] as any;
  });
  let inserts = 0;
  H.setMaterializeOverride(async () => {
    inserts += 1;
    return "inserted";
  });
  const r = await runKnownConversationMessageBackfill(WINDOW, null);
  assert.equal(r.status, "blocked");
  assert.equal(r.done, false);
  // cnv_1 fully processed; cnv_2 failed → cursor must NOT advance past cnv_1.
  assert.equal(r.checkpoint.afterConversationId, "cnv_1");
  assert.equal(inserts, 1, "only cnv_1's message was written before the block");
  resetOverrides();
});

test("Task #2716 — transient per-conversation error is counted, cursor advances, walk continues", async () => {
  resetOverrides();
  await setPoolEpicSwitch(KNOWN_CONV_BACKFILL_REQUIRED_SWITCH, true);
  authPasses();
  H.setSelectOverride(async () => [
    { conversationId: "cnv_1", subject: "1", lastMessageAt: null },
    { conversationId: "cnv_2", subject: "2", lastMessageAt: null },
  ]);
  H.setFetchMessagesOverride(async (conversationId) => {
    if (conversationId === "cnv_1") {
      throw new Error("front 503 — transient");
    }
    return [{ id: "cnv_2_m1" }] as any;
  });
  H.setMaterializeOverride(async () => "inserted");
  const r = await runKnownConversationMessageBackfill(WINDOW, null);
  assert.equal(r.status, "ok");
  assert.equal(r.errors, 1);
  assert.equal(r.fetched, 1, "only cnv_2 was fetched (cnv_1 errored)");
  assert.equal(r.inserted, 1);
  assert.equal(r.scanned, 2);
  assert.equal(
    r.checkpoint.afterConversationId,
    "cnv_2",
    "cursor advances past the errored conversation so the walk does not wedge",
  );
  assert.equal(r.done, true);
  resetOverrides();
});

test("Task #2716 — a real disconnect at the up-front auth check surfaces as blocked", async () => {
  resetOverrides();
  await setPoolEpicSwitch(KNOWN_CONV_BACKFILL_REQUIRED_SWITCH, true);
  H.setValidateAuthOverride(async () => {
    throw new FrontAuthError("front_not_connected", "no token");
  });
  let selected = false;
  H.setSelectOverride(async () => {
    selected = true;
    return [];
  });
  const r = await runKnownConversationMessageBackfill(WINDOW, {
    afterConversationId: "cnv_keep",
  });
  assert.equal(r.status, "blocked");
  assert.equal(r.done, false);
  assert.equal(
    r.checkpoint.afterConversationId,
    "cnv_keep",
    "checkpoint preserved so the next tick resumes where it left off",
  );
  assert.equal(selected, false, "no DB read once auth is known dead");
  resetOverrides();
});

test("Task #2716 — convergence-lens metric descriptor is registered", () => {
  const d = FRONT_CONSOLE_METRIC_REGISTRY.find(
    (m) => m.id === "front.recovery.known_conv_messages_backfilled",
  );
  assert.ok(d, "known-conv backfill descriptor must be registered");
  assert.equal(d!.lens, 3);
  assert.equal(d!.grain, "messages");
  assert.ok(
    KNOWN_CONV_BACKFILL_CONVERSATION_BUDGET_DEFAULT > 0,
    "per-tick conversation budget is a positive default",
  );
});
