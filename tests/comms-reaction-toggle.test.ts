/* test-registration
{
  "name": "Reaction toggling — myReactions per requesting user + POST/DELETE toggle end-to-end (Task #3519)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3519: Reaction toggling regression — listMessages({currentUserId}) returns myReactions holding ONLY the requesting user's exact emoji strings (skin-tone variants independent), and the POST/DELETE reaction routes toggle end-to-end: idempotent added/removed flags, DELETE removes only the caller's reaction, pill count drops while the other user's survives. Seeds users/channel/message with a per-run token, cleans up in finally.",
  "tier": "small"
}
test-registration */
/**
 * Reaction toggling regression — myReactions + POST/DELETE toggle (Task #3519).
 *
 * Locks in the Task #3433 contract:
 *
 *  1. Storage: listMessages({ currentUserId }) returns myReactions holding ONLY
 *     the requesting user's exact emoji strings — skin-tone variants stay
 *     independent, other users' reactions never leak in, and omitting
 *     currentUserId yields an empty myReactions.
 *  2. Route toggle end-to-end: POST /api/comms/messages/:id/reactions adds
 *     (added: true, idempotent re-POST reports added: false), DELETE
 *     /api/comms/messages/:id/reactions/:emoji removes ONLY the caller's
 *     reaction (removed: true, idempotent re-DELETE reports removed: false),
 *     and the pill count drops by exactly one while the other user's
 *     reaction survives.
 *
 * Isolation: seeded rows carry a per-run random token and are deleted in
 * finally (shared dev DB — see route-test-public-schema-collision).
 */

import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { inArray, eq } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok  ${msg}`); }
  else { failed++; console.error(`  FAIL  ${msg}`); }
}

const { db, closeDbPools } = await import("../server/db.js");
const { users } = await import("@shared/schema");
const { commsChannels } = await import("../shared/models/comms.js");
const { registerCommsRoutes } = await import("../server/routes/comms.js");
const commsStorage = await import("../server/storage/commsStorage.js");

const RUN = randomBytes(4).toString("hex");
const ALICE = `rt-toggle-a-${RUN}`;
const BOB = `rt-toggle-b-${RUN}`;
const THUMB = "👍";
const TONED = "👍\u{1F3FE}"; // 👍🏾 medium-dark variant — must stay distinct from base

let channelId = "";
let messageId = "";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeApp(actingUserId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; requireAuth loads the real users row
    // (public schema, seeded above) so role gating reflects the DB.
    req.__test_clerkUserId = actingUserId;
    next();
  });
  registerCommsRoutes(app);
  return app;
}

async function withApp<T>(actingUserId: string, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = makeApp(actingUserId);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const addReactionUrl = (base: string) => `${base}/api/comms/messages/${messageId}/reactions`;
const removeReactionUrl = (base: string, emoji: string) =>
  `${base}/api/comms/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`;

async function listAs(userId: string | undefined) {
  const rows = await commsStorage.listMessages(channelId, { id: messageId, currentUserId: userId });
  const row = rows.find((m) => m.id === messageId);
  if (!row) throw new Error("seeded message not returned by listMessages");
  return row;
}

// ─── run ─────────────────────────────────────────────────────────────────────

try {
  await db.insert(users).values([
    { id: ALICE, email: `${ALICE}@test.local`, firstName: "Alice", lastName: `Toggle-${RUN}`, role: "account_manager" },
    { id: BOB, email: `${BOB}@test.local`, firstName: "Bob", lastName: `Toggle-${RUN}`, role: "account_manager" },
  ]);

  const channel = await commsStorage.createChannel({
    name: `rt-toggle-${RUN}`,
    slug: `rt-toggle-${RUN}`,
    type: "channel",
    visibility: "private",
    createdBy: ALICE,
  } as any);
  channelId = channel.id;
  await commsStorage.addChannelMember(channelId, ALICE, "owner");
  await commsStorage.addChannelMember(channelId, BOB, "member");

  const msg = await commsStorage.createMessage({
    channelId,
    userId: ALICE,
    content: `reaction toggle seed ${RUN}`,
  } as any);
  messageId = msg.id;

  // ── 1. Route: both users add reactions via POST ──────────────────────────
  await withApp(ALICE, async (base) => {
    const res = await fetch(addReactionUrl(base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: THUMB }),
    });
    const body = await res.json();
    ok(res.status === 200 && body.added === true, "POST adds Alice's 👍 (added: true)");

    const again = await fetch(addReactionUrl(base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: THUMB }),
    });
    const againBody = await again.json();
    ok(again.status === 200 && againBody.added === false, "re-POST of the same emoji is idempotent (added: false)");
  });

  await withApp(BOB, async (base) => {
    for (const emoji of [THUMB, TONED]) {
      const res = await fetch(addReactionUrl(base), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji }),
      });
      const body = await res.json();
      ok(res.status === 200 && body.added === true, `POST adds Bob's ${emoji} (added: true)`);
    }
  });

  // ── 2. Storage: myReactions is per-requesting-user and exact-string ──────
  const asAlice = await listAs(ALICE);
  ok(
    asAlice.myReactions.length === 1 && asAlice.myReactions[0] === THUMB,
    `Alice's myReactions holds ONLY her 👍 (got ${JSON.stringify(asAlice.myReactions)})`,
  );
  ok(asAlice.reactionCounts[THUMB] === 2, `👍 pill count is 2 (got ${asAlice.reactionCounts[THUMB]})`);
  ok(asAlice.reactionCounts[TONED] === 1, `toned 👍🏾 keeps its own count of 1 (got ${asAlice.reactionCounts[TONED]})`);

  const asBob = await listAs(BOB);
  ok(
    asBob.myReactions.length === 2 && asBob.myReactions.includes(THUMB) && asBob.myReactions.includes(TONED),
    `Bob's myReactions holds his exact strings 👍 + 👍🏾, tone-independent (got ${JSON.stringify(asBob.myReactions)})`,
  );
  ok(
    !asBob.myReactions.includes(`${TONED}x`) && asBob.myReactions.every((e) => e === THUMB || e === TONED),
    "Bob's myReactions carries no foreign or merged emoji strings",
  );

  const anon = await listAs(undefined);
  ok(anon.myReactions.length === 0, "omitting currentUserId yields empty myReactions");

  // ── 3. Route: DELETE removes only the caller's reaction, count drops ─────
  await withApp(ALICE, async (base) => {
    const res = await fetch(removeReactionUrl(base, THUMB), { method: "DELETE" });
    const body = await res.json();
    ok(res.status === 200 && body.removed === true, "DELETE removes Alice's 👍 (removed: true)");

    const again = await fetch(removeReactionUrl(base, THUMB), { method: "DELETE" });
    const againBody = await again.json();
    ok(again.status === 200 && againBody.removed === false, "re-DELETE is idempotent (removed: false)");
  });

  const afterAlice = await listAs(ALICE);
  ok(afterAlice.myReactions.length === 0, "after DELETE, Alice's myReactions is empty");
  ok(
    afterAlice.reactionCounts[THUMB] === 1,
    `👍 pill count dropped 2 → 1, Bob's survives (got ${afterAlice.reactionCounts[THUMB]})`,
  );
  ok(afterAlice.reactionCounts[TONED] === 1, "Bob's toned 👍🏾 untouched by Alice's DELETE");

  const afterBob = await listAs(BOB);
  ok(
    afterBob.myReactions.length === 2 && afterBob.myReactions.includes(THUMB) && afterBob.myReactions.includes(TONED),
    "Bob's myReactions unchanged after Alice's DELETE",
  );

  // ── 4. Full second toggle end-to-end: re-add then remove again ───────────
  await withApp(ALICE, async (base) => {
    const add = await fetch(addReactionUrl(base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: THUMB }),
    });
    const addBody = await add.json();
    ok(add.status === 200 && addBody.added === true, "second toggle: re-POST re-adds Alice's 👍");

    const del = await fetch(removeReactionUrl(base, THUMB), { method: "DELETE" });
    const delBody = await del.json();
    ok(del.status === 200 && delBody.removed === true, "second toggle: DELETE removes it again");
  });

  const final = await listAs(ALICE);
  ok(final.myReactions.length === 0, "after full second toggle, Alice's myReactions is empty again");
  ok(final.reactionCounts[THUMB] === 1, `final 👍 count back to 1 (got ${final.reactionCounts[THUMB]})`);
} finally {
  try {
    if (channelId) await db.delete(commsChannels).where(eq(commsChannels.id, channelId));
    await db.delete(users).where(inArray(users.id, [ALICE, BOB]));
  } catch (e) {
    console.error("cleanup failed:", e);
  }
  try {
    const { getGlobalDispatcher } = await import("undici");
    await getGlobalDispatcher().close();
  } catch {}
  await closeDbPools();
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
