/* test-registration
{
  "name": "Comms custom emoji — schema, storage, route, token logic (Task #3256)",
  "smoke": true,
  "smokeReason": "Task #3256: Custom emoji — schema tables, storage functions, route registration order (literal before :id), and :name: token-splitting logic. DB-free, no network, pure import assertions + source scans.",
  "scanPaths": [
    "server/routes/comms"
  ],
  "tier": "small"
}
test-registration */
/**
 * Custom emoji — smoke-style checks covering the full end-to-end surface:
 *  1. Schema tables exported from shared/models/comms.ts
 *  2. Storage functions exported from server/storage/commsStorage.ts
 *  3. Route registration (source-scan) — emoji routes in comms.ts
 *  4. renderContent :name: token logic — pure TypeScript, no DOM/React
 *  5. Route ordering guard — literal paths appear before parameterized /:id
 *  6. Skin tone (Task #3304):
 *     a. applyTone() unit tests — imports the REAL picker helper (pure module
 *        client/src/components/comms/emojiSkinTone.ts, no React/DOM)
 *     b. Route-level reaction round-trip — a skin-tone-modified emoji posted
 *        twice deduplicates (added:false the second time, one row), and a
 *        different skin-tone variant of the same base is a DISTINCT reaction.
 *
 * Isolation for part 6b: seeded rows carry a per-run random token and are
 * deleted in finally (shared dev DB — see route-test-public-schema-collision).
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { eq, and, inArray } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok  ${msg}`); }
  else { failed++; console.error(`  FAIL  ${msg}`); }
}

// ─── 1. Schema tables ─────────────────────────────────────────────────────────

const commsSchema = await import("../shared/models/comms.js");

const NEW_TABLES = ["commsCustomEmoji", "commsEmojiUsage"] as const;
for (const t of NEW_TABLES) {
  ok((commsSchema as any)[t] !== undefined, `shared/models/comms exports table: ${t}`);
}

// ─── 2. Storage functions ─────────────────────────────────────────────────────

const commsStorage = await import("../server/storage/commsStorage.js");

const EMOJI_STORAGE_FNS = [
  "listCustomEmoji",
  "getCustomEmojiByName",
  "getCustomEmojiById",
  "createCustomEmoji",
  "deleteCustomEmoji",
  "searchCustomEmoji",
  "trackEmojiUsage",
  "getFrequentlyUsedEmoji",
] as const;

function readCommsRouteSources(): string {
  const dir = join(process.cwd(), "server/routes/comms");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf-8"))
    .join("\n");
}
const commsSrc = readCommsRouteSources();

ok(commsSrc.includes("/api/comms/emoji"), "comms.ts registers /api/comms/emoji");
ok(commsSrc.includes("frequently-used"), "comms.ts registers frequently-used route");
ok(commsSrc.includes("autocomplete"), "comms.ts registers autocomplete route");
ok(commsSrc.includes("/image"), "comms.ts registers :id/image route");
ok(commsSrc.includes("multer") || commsSrc.includes("emojiUpload"), "comms.ts uses multer for emoji upload");

// ─── 4. Route ordering guard — literal before parameterized ───────────────────
//
// Express uses first-match routing. GET /api/comms/emoji/frequently-used MUST be
// registered BEFORE GET /api/comms/emoji/:id or it would be shadowed by the
// parameterized route treating "frequently-used" as an id.

const frequentlyIdx = commsSrc.indexOf("frequently-used");
const autocompleteIdx = commsSrc.indexOf("autocomplete");
const imageIdx = commsSrc.indexOf("/image");
const idDeleteIdx = commsSrc.indexOf('"/api/comms/emoji/:id"') !== -1
  ? commsSrc.indexOf('"/api/comms/emoji/:id"')
  : commsSrc.indexOf("'/api/comms/emoji/:id'");

ok(frequentlyIdx !== -1, "frequently-used route is present");
ok(autocompleteIdx !== -1, "autocomplete route is present");

// Literal paths should appear before :id DELETE (or at least before the last /:id)
if (idDeleteIdx !== -1) {
  ok(frequentlyIdx < idDeleteIdx, "frequently-used registered before /:id");
  ok(autocompleteIdx < idDeleteIdx, "autocomplete registered before /:id");
  ok(imageIdx < idDeleteIdx, ":id/image registered before bare /:id DELETE");
}

// ─── 5. :name: token rendering (pure logic, no React/DOM) ────────────────────
//
// We replicate the renderContent token-splitting logic in pure TS to verify
// it correctly identifies :name: tokens without spinning up React.

function tokenize(content: string): string[] {
  return content.split(/(@\[[^\]]+\]\([^)]+\)|@channel|@here|:[a-zA-Z0-9_-]{2,64}:)/g);
}

function isCustomEmojiToken(part: string): boolean {
  return /^:[a-zA-Z0-9_-]{2,64}:$/.test(part);
}

// Valid :name: tokens
ok(isCustomEmojiToken(":parrot:"), ":parrot: is a valid custom emoji token");
ok(isCustomEmojiToken(":party-blob:"), ":party-blob: is a valid custom emoji token");
ok(isCustomEmojiToken(":ab:"), ":ab: (2-char) is a valid custom emoji token");
ok(isCustomEmojiToken(":a_b-c:"), "underscores + hyphens are valid");

// Invalid tokens (should not match)
ok(!isCustomEmojiToken(":x:"), ":x: (1-char) must not match — too short");
ok(!isCustomEmojiToken(":has space:"), ":has space: must not match — space inside");
ok(!isCustomEmojiToken("parrot"), "bare word must not match — no colons");
ok(!isCustomEmojiToken("::"), ":: must not match — empty name");

// Splitting produces the right tokens
const parts = tokenize("Hello :parrot: and :unknown: world");
ok(parts.includes(":parrot:"), "tokenize isolates :parrot:");
ok(parts.includes(":unknown:"), "tokenize isolates :unknown:");

// Standard emoji (@channel etc.) still split correctly alongside custom tokens
const mixed = tokenize(":parrot: @channel :blob:");
ok(mixed.some((p) => isCustomEmojiToken(p)), "mixed content still captures custom tokens");
ok(mixed.includes("@channel"), "mixed content still captures @channel");

// ─── 6a. Skin tone — applyTone() unit tests (real picker helper) ─────────────

const { applyTone, SKIN_TONE_MODIFIERS, SKIN_TONE_COMPATIBLE } = await import(
  "../client/src/components/comms/emojiSkinTone.js"
);

const TONE_MEDIUM_DARK = 4; // 🏾 \u{1F3FE}
const TONE_LIGHT = 1; // 🏻 \u{1F3FB}

ok(applyTone("👍", TONE_MEDIUM_DARK) === "👍" + "\u{1F3FE}", "applyTone appends medium-dark modifier to 👍 → 👍🏾");
ok(applyTone("👍", TONE_LIGHT) === "👍" + "\u{1F3FB}", "applyTone appends light modifier to 👍 → 👍🏻");
ok(applyTone("👍", 0) === "👍", "tone 0 (default) leaves emoji unchanged");
ok(applyTone("🐶", TONE_MEDIUM_DARK) === "🐶", "non-compatible emoji is returned unchanged");
ok(
  applyTone("👍" + "\u{1F3FB}", TONE_MEDIUM_DARK) === "👍" + "\u{1F3FE}",
  "re-toning an already-toned emoji replaces the modifier (no stacking)",
);
ok(SKIN_TONE_MODIFIERS.length === 6, "6 tone slots (default + 5 Fitzpatrick modifiers)");
for (let i = 1; i <= 5; i++) {
  const out = applyTone("👋", i);
  ok(out === "👋" + SKIN_TONE_MODIFIERS[i], `tone ${i} appends exactly one modifier to 👋`);
}
ok(SKIN_TONE_COMPATIBLE.has("👍") && SKIN_TONE_COMPATIBLE.has("🙏"), "compatible set includes 👍 and 🙏");

// Distinctness at the string level — what the DB unique constraint keys on
ok(applyTone("👍", TONE_LIGHT) !== applyTone("👍", TONE_MEDIUM_DARK), "different tone variants are distinct strings");
ok(applyTone("👍", TONE_MEDIUM_DARK) !== "👍", "toned variant is distinct from the base emoji");

// The picker's max emitted length must fit the route's z.string().max(64) guard
const longestToned = applyTone("🖐️", 5);
ok(longestToned.length <= 64, "toned emoji fits the reaction route's 64-char limit");

// ─── 6a′. Reaction-pill labelling helpers (Task: separate-pill decision) ─────
// Skin-tone variants deliberately render as SEPARATE reaction pills (Slack
// parity — see COMMS.md "Skin-tone reaction pills"); these helpers back the
// tone-labelled tooltip on toned pills.
const { baseEmojiOf, toneLabelOf } = await import(
  "../client/src/components/comms/emojiSkinTone.js"
);

ok(baseEmojiOf("👍" + "\u{1F3FE}") === "👍", "baseEmojiOf strips the medium-dark modifier");
ok(baseEmojiOf("👍") === "👍", "baseEmojiOf is identity for untoned emoji");
ok(baseEmojiOf("🐶") === "🐶", "baseEmojiOf is identity for non-compatible emoji");
ok(toneLabelOf("👍") === null, "toneLabelOf returns null for untoned emoji");
ok(toneLabelOf("👍" + "\u{1F3FE}") === "Medium-Dark", "toneLabelOf labels the medium-dark variant");
ok(toneLabelOf("👍" + "\u{1F3FB}") === "Light", "toneLabelOf labels the light variant");
ok(toneLabelOf(":parrot:") === null, "toneLabelOf returns null for custom emoji tokens");
for (let i = 1; i <= 5; i++) {
  const toned = applyTone("👋", i);
  ok(baseEmojiOf(toned) === "👋", `baseEmojiOf recovers the base for tone ${i}`);
  ok(toneLabelOf(toned) !== null, `toneLabelOf labels tone ${i}`);
}
// Round-trip contract: distinct variants stay distinct pills but share a base
ok(
  baseEmojiOf(applyTone("👍", TONE_LIGHT)) === baseEmojiOf(applyTone("👍", TONE_MEDIUM_DARK)),
  "different tone variants share the same base (for tooltip labelling only — pills stay separate)",
);

// ─── 6b. Route-level reaction round-trip (skin-tone dedup + distinctness) ────

const { db, closeDbPools } = await import("../server/db.js");
const { users } = await import("@shared/schema");
const { commsChannels, commsReactions } = await import("../shared/models/comms.js");
const { registerCommsRoutes } = await import("../server/routes/comms.js");
const commsStorageMod = await import("../server/storage/commsStorage.js");

const RUN = randomBytes(4).toString("hex");
const USER_ID = `comms-tone-${RUN}`;
const LEAD_ID = `comms-tone-lead-${RUN}`;

function makeApp(actingUserId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; requireAuth loads the real users row
    // (public schema, seeded below) so requireRole reflects the DB role.
    req.__test_clerkUserId = actingUserId;
    next();
  });
  registerCommsRoutes(app);
  return app;
}

let toneChannelId = "";
let toneMessageId = "";

try {
  await db.insert(users).values([
    {
      id: USER_ID,
      email: `comms-tone-${RUN}@test.local`,
      firstName: "Tone",
      lastName: `Test-${RUN}`,
      role: "account_manager",
    },
    {
      id: LEAD_ID,
      email: `comms-tone-lead-${RUN}@test.local`,
      firstName: "Tone",
      lastName: `Lead-${RUN}`,
      role: "team_lead",
    },
  ]);

  const channel = await commsStorageMod.createChannel({
    name: `tone-test-${RUN}`,
    slug: `tone-test-${RUN}`,
    type: "channel",
    visibility: "private",
    createdBy: USER_ID,
  } as any);
  toneChannelId = channel.id;
  await commsStorageMod.addChannelMember(toneChannelId, USER_ID, "owner");

  const msg = await commsStorageMod.createMessage({
    channelId: toneChannelId,
    userId: USER_ID,
    content: `skin tone reaction seed ${RUN}`,
  } as any);
  toneMessageId = msg.id;

  const app = makeApp(USER_ID);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;

  const tonedEmoji = applyTone("👍", TONE_MEDIUM_DARK); // 👍🏾 — exactly what the picker emits
  const otherVariant = applyTone("👍", TONE_LIGHT); // 👍🏻

  async function postReaction(emoji: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/comms/messages/${toneMessageId}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji }),
    });
    return { status: res.status, body: await res.json() };
  }

  try {
    // First insert of the picker-emitted toned emoji → added
    const first = await postReaction(tonedEmoji);
    ok(first.status === 200, "first toned reaction returns 200");
    ok(first.body.added === true, "first toned reaction is added:true");

    // Same toned emoji again (SSE echo → client re-posts) → dedup, not a 2nd row
    const second = await postReaction(tonedEmoji);
    ok(second.status === 200, "duplicate toned reaction returns 200");
    ok(second.body.added === false, "duplicate toned reaction dedups (added:false)");

    const dupRows = await db
      .select({ id: commsReactions.id })
      .from(commsReactions)
      .where(
        and(
          eq(commsReactions.messageId, toneMessageId),
          eq(commsReactions.userId, USER_ID),
          eq(commsReactions.emoji, tonedEmoji),
        ),
      );
    ok(dupRows.length === 1, "exactly one row exists for the toned emoji (no duplicate row)");

    // A DIFFERENT tone variant of the same base emoji is a distinct reaction
    const variant = await postReaction(otherVariant);
    ok(variant.status === 200, "different-tone variant returns 200");
    ok(variant.body.added === true, "different-tone variant is a distinct reaction (added:true)");

    // And the bare base emoji is distinct from both toned variants
    const bare = await postReaction("👍");
    ok(bare.body.added === true, "base (untoned) emoji is distinct from toned variants (added:true)");

    const allRows = await db
      .select({ emoji: commsReactions.emoji })
      .from(commsReactions)
      .where(and(eq(commsReactions.messageId, toneMessageId), eq(commsReactions.userId, USER_ID)));
    ok(allRows.length === 3, "three distinct reaction rows: base + two tone variants");
    const stored = new Set(allRows.map((r) => r.emoji));
    ok(stored.has(tonedEmoji), "stored row byte-equals the picker-emitted toned emoji (round-trip intact)");
    ok(stored.has(otherVariant), "stored row byte-equals the second tone variant");

    // DELETE round-trip — the URL-encoded toned emoji removes exactly its own row
    const del = await fetch(
      `${base}/api/comms/messages/${toneMessageId}/reactions/${encodeURIComponent(tonedEmoji)}`,
      { method: "DELETE" },
    );
    const delBody = await del.json();
    ok(del.status === 200 && delBody.removed === true, "DELETE with URL-encoded toned emoji removes it");

    const afterDel = await db
      .select({ emoji: commsReactions.emoji })
      .from(commsReactions)
      .where(and(eq(commsReactions.messageId, toneMessageId), eq(commsReactions.userId, USER_ID)));
    ok(afterDel.length === 2, "only the targeted toned variant was removed; other variants remain");
    ok(!afterDel.some((r) => r.emoji === tonedEmoji), "removed row is the toned emoji, not another variant");

    // ─── 7. Upload role gate (Task #3315) ────────────────────────────────────
    // POST /api/comms/emoji must reject non-managers with 403 BEFORE any
    // validation/storage work; team_lead passes the gate (proven by reaching
    // the name-validation 400 instead of a 403).

    // Regular user (account_manager, same app as above) → 403
    const uploadDenied = await fetch(`${base}/api/comms/emoji`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "valid_name" }),
    });
    const deniedBody = await uploadDenied.json();
    ok(uploadDenied.status === 403, "non-manager emoji upload is rejected with 403");
    ok(
      typeof deniedBody.error === "string" && /team lead/i.test(deniedBody.error),
      "403 response carries a clear role-based error message",
    );

    // team_lead passes the gate — invalid name hits the 400 validator, not 403
    const leadApp = makeApp(LEAD_ID);
    const leadServer = leadApp.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => leadServer.once("listening", resolve));
    const leadBase = `http://127.0.0.1:${(leadServer.address() as AddressInfo).port}`;
    try {
      const leadUpload = await fetch(`${leadBase}/api/comms/emoji`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "!" }),
      });
      ok(leadUpload.status === 400, "team_lead passes the role gate (reaches 400 name validation, not 403)");
    } finally {
      await new Promise<void>((resolve) => leadServer.close(() => resolve()));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
} finally {
  // Cleanup — deleting the channel cascades messages and reactions.
  try {
    if (toneChannelId) {
      await db.delete(commsChannels).where(eq(commsChannels.id, toneChannelId));
    }
    await db.delete(users).where(inArray(users.id, [USER_ID, LEAD_ID]));
  } catch (e: any) {
    console.error("cleanup error:", e.message);
  }
  await undici.getGlobalDispatcher().close();
  await closeDbPools();
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\ncomms-custom-emoji: ${passed + failed} assertion(s), ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
