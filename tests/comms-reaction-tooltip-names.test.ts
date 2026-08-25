/* test-registration
{
  "name": "Reaction pill hover shows who reacted (Task #3434)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3434: Reaction pill hover tooltip — listMessages returns reactor display names per exact emoji string (earliest first, bounded to 10, nameless users filtered, toned variants keyed separately) and both MessageItem pill spots pass names+count into reactionPillTitle. Seeds a channel/message/reactions with a per-run token, cleans up in finally.",
  "scanPaths": [
    "client/src/components/comms/MessageItem.tsx",
    "client/src/components/comms/types.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Reaction hover tooltip — "who reacted" names (Task #3434)
 *
 *  1. Storage: listMessages returns reactionNames per emoji — reactor display
 *     names (earliest first, bounded to 10) alongside reactionCounts, keyed by
 *     the EXACT emoji string (skin-tone variants stay distinct).
 *  2. Client wiring (source scan): both pill render spots in MessageItem.tsx
 *     pass msg.reactionNames + count into reactionPillTitle, and the helper
 *     builds the "X, Y and N others reacted with <emoji>" label while keeping
 *     the tone label for toned variants.
 *
 * Isolation: seeded rows carry a per-run random token and are deleted in
 * finally (shared dev DB — see route-test-public-schema-collision).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok  ${msg}`); }
  else { failed++; console.error(`  FAIL  ${msg}`); }
}

const { db, closeDbPools } = await import("../server/db.js");
const { users } = await import("@shared/schema");
const { commsChannels, commsMessages, commsReactions } = await import("../shared/models/comms.js");
const commsStorage = await import("../server/storage/commsStorage.js");

const RUN = randomBytes(4).toString("hex");
const U1 = `rt-names-a-${RUN}`;
const U2 = `rt-names-b-${RUN}`;
const U3 = `rt-names-c-${RUN}`;
const TONED = "👍\u{1F3FE}"; // 👍🏾 medium-dark variant

let channelId = "";

try {
  await db.insert(users).values([
    { id: U1, email: `${U1}@test.local`, firstName: "Jane", lastName: `Alpha-${RUN}`, role: "account_manager" },
    { id: U2, email: `${U2}@test.local`, firstName: "Bob", lastName: `Bravo-${RUN}`, role: "account_manager" },
    { id: U3, email: `${U3}@test.local`, firstName: null, lastName: null, role: "account_manager" },
  ]);

  const channel = await commsStorage.createChannel({
    name: `rt-names-${RUN}`,
    slug: `rt-names-${RUN}`,
    type: "channel",
    visibility: "private",
    createdBy: U1,
  } as any);
  channelId = channel.id;
  await commsStorage.addChannelMember(channelId, U1, "owner");

  const msg = await commsStorage.createMessage({
    channelId,
    userId: U1,
    content: `reaction names seed ${RUN}`,
  } as any);

  // Two users react 👍, one reacts with the toned variant, one nameless user reacts 👍
  await commsStorage.addReaction(msg.id, U1, "👍");
  await new Promise((r) => setTimeout(r, 20)); // deterministic createdAt ordering
  await commsStorage.addReaction(msg.id, U2, "👍");
  await commsStorage.addReaction(msg.id, U2, TONED);
  await new Promise((r) => setTimeout(r, 20));
  await commsStorage.addReaction(msg.id, U3, "👍");

  const listed = await commsStorage.listMessages(channelId, { id: msg.id });
  const row = listed.find((m) => m.id === msg.id);
  ok(!!row, "listMessages returns the seeded message");

  const names = (row as any).reactionNames as Record<string, string[]>;
  ok(names && typeof names === "object", "listMessages rows carry a reactionNames map");
  ok(row!.reactionCounts["👍"] === 3, `👍 count is 3 (got ${row!.reactionCounts["👍"]})`);
  ok(
    Array.isArray(names["👍"]) && names["👍"].length === 2,
    `👍 names hold the 2 named reactors, nameless user filtered (got ${JSON.stringify(names["👍"])})`,
  );
  ok(names["👍"][0] === `Jane Alpha-${RUN}`, "earliest reactor is first");
  ok(names["👍"][1] === `Bob Bravo-${RUN}`, "second reactor follows");
  ok(
    Array.isArray(names[TONED]) && names[TONED].length === 1 && names[TONED][0] === `Bob Bravo-${RUN}`,
    "toned variant keys its OWN names entry (exact emoji string, no merge with base)",
  );

  // ── 2. Client wiring — source scan + pure helper behavior ────────────────
  const src = readFileSync(join(process.cwd(), "client/src/components/comms/MessageItem.tsx"), "utf-8");
  const callSites = src.match(/reactionPillTitle\(emoji, msg\.reactionNames\?\.\[emoji\], count\)/g) ?? [];
  ok(callSites.length === 2, `both pill render spots pass names + count (found ${callSites.length})`);

  // Replicate reactionPillTitle's contract via a pure import path: the helper
  // lives in MessageItem.tsx (React-heavy), so assert its formatting logic on
  // the source directly plus contract checks on the shape it consumes.
  ok(src.includes("reacted with"), "tooltip helper builds a 'reacted with' label");
  ok(src.includes("skin tone"), "tooltip helper keeps the tone label for toned variants");
  ok(/and \$\{extra\} other/.test(src), "tooltip helper renders 'and N others' overflow");

  // types.ts carries the field so the payload survives the client type layer
  const typesSrc = readFileSync(join(process.cwd(), "client/src/components/comms/types.ts"), "utf-8");
  ok(typesSrc.includes("reactionNames?: Record<string, string[]>"), "client CommsMessage type carries reactionNames");
} finally {
  try {
    if (channelId) {
      const msgs = await db.select({ id: commsMessages.id }).from(commsMessages).where(eq(commsMessages.channelId, channelId));
      const ids = msgs.map((m) => m.id);
      if (ids.length) await db.delete(commsReactions).where(inArray(commsReactions.messageId, ids));
      await db.delete(commsMessages).where(eq(commsMessages.channelId, channelId));
      await db.delete(commsChannels).where(eq(commsChannels.id, channelId));
    }
    await db.delete(users).where(inArray(users.id, [U1, U2, U3]));
  } catch (e) {
    console.error("cleanup failed:", e);
  }
  await closeDbPools();
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
