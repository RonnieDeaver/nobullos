/* test-registration
{
  "name": "Comms DM participant names — channel enrichment, display-name helper, fallback (Task #3328)",
  "regression": true,
  "sweepOnlyReason": "Task #3328 — DM participant name enrichment: seeds real users + DM/group-DM channels via storage, verifies dmParticipantNames in GET /api/comms/channels. Real DB writes (seed+cleanup), not a smoke-gate candidate.",
  "scanPaths": [
    "client/src/components/comms/CommsPopupManager.tsx",
    "client/src/components/comms/CommsRail.tsx",
    "client/src/components/comms/helpers.tsx",
    "client/src/components/comms/types.ts",
    "server/middlewares/requireAuth.ts",
    "server/routes/comms",
    "server/storage/comms/channels.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3328 — DM participant name resolution.
 *
 * Tests the two critical contracts:
 *   1. GET /api/comms/channels enriches DM channels with `dmParticipantNames`
 *      (an array of other participants' display names, excluding the caller).
 *   2. `channelDisplayName` (helper) returns the other member's name for a DM
 *      and comma-separated first names for a group DM, falling back to the
 *      generic string when `dmParticipantNames` is null/missing.
 *
 * Part 1: static source scan — verifies the key source contracts are in place.
 * Part 2: live route test — seeds two users + a DM channel via the storage
 *         layer, then calls GET /api/comms/channels acting as USER_A and asserts
 *         the response includes `dmParticipantNames: ["<USER_B full name>"]`.
 *
 * Task #3344 additions — lock in the Task #3337 enrichment so a refactor of
 * these handlers can never silently drop dmParticipantNames and regress DM
 * labels to "Direct Message"/"Group DM":
 *   - GET /api/comms/channels/:id returns dmParticipantNames for dm + group_dm
 *     (other participants only) and null for non-DM channels.
 *   - GET /api/comms/channels/public and /api/comms/channels/archived return
 *     non-DM rows unchanged (fields intact) with dmParticipantNames: null.
 *
 * Isolation: per-run random token; all seeded rows deleted in finally.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { getGlobalDispatcher } from "undici";
import { inArray, eq } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import { commsChannels } from "../shared/models/comms";
import { registerCommsRoutes } from "../server/routes/comms";
import * as commsStorage from "../server/storage/commsStorage";

const RUN = randomBytes(4).toString("hex");

const USER_A_ID = `dm-names-a-${RUN}`;
const USER_B_ID = `dm-names-b-${RUN}`;
const USER_C_ID = `dm-names-c-${RUN}`;
// Task #3528 — email-fallback users
const USER_D_ID = `dm-names-d-${RUN}`; // no first/last name, has email
const USER_E_ID = `dm-names-e-${RUN}`; // no first/last name, no email

let dmChannelId = "";
let groupDmChannelId = "";
let emailFallbackDmId = "";  // A ↔ D (no-name-has-email)
let anonDmId = "";           // A ↔ E (no-name, no-email)

let passed = 0;
let failed = 0;

function ok(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ok  ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL  ${msg}`);
    failed++;
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err?.message ?? err}`);
    failed++;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readSrc(relPath: string): string {
  return readFileSync(join(process.cwd(), relPath), "utf-8");
}

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

async function withApp<T>(userId: string, fn: (base: string) => Promise<T>): Promise<T> {
  const app = makeApp(userId);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.close();
  }
}

async function seed(): Promise<void> {
  await db.insert(users).values([
    { id: USER_A_ID, email: `dm-names-a-${RUN}@test.local`, firstName: "Alice", lastName: `A-${RUN}`, role: "account_manager" },
    { id: USER_B_ID, email: `dm-names-b-${RUN}@test.local`, firstName: "Bob",   lastName: `B-${RUN}`, role: "account_manager" },
    { id: USER_C_ID, email: `dm-names-c-${RUN}@test.local`, firstName: "Carol", lastName: `C-${RUN}`, role: "account_manager" },
    // Task #3528 — no-name users for email-fallback testing
    { id: USER_D_ID, email: `jdavis-${RUN}@nobullmarketing.co`, firstName: null, lastName: null, role: "account_manager" },
    { id: USER_E_ID, email: null, firstName: null, lastName: null, role: "account_manager" },
  ]);

  const { channel: dm } = await commsStorage.findOrCreateDmChannel([USER_A_ID, USER_B_ID]);
  dmChannelId = dm.id;

  const { channel: gdm } = await commsStorage.findOrCreateDmChannel([USER_A_ID, USER_B_ID, USER_C_ID]);
  groupDmChannelId = gdm.id;

  const { channel: efDm } = await commsStorage.findOrCreateDmChannel([USER_A_ID, USER_D_ID]);
  emailFallbackDmId = efDm.id;

  const { channel: anonDm } = await commsStorage.findOrCreateDmChannel([USER_A_ID, USER_E_ID]);
  anonDmId = anonDm.id;
}

async function cleanup(): Promise<void> {
  const ids = [dmChannelId, groupDmChannelId, emailFallbackDmId, anonDmId].filter(Boolean);
  if (ids.length) {
    await db.delete(commsChannels).where(inArray(commsChannels.id, ids)).catch(() => {});
  }
  await db.delete(users).where(inArray(users.id, [USER_A_ID, USER_B_ID, USER_C_ID, USER_D_ID, USER_E_ID])).catch(() => {});
}

// ─── Part 1: static source contracts ─────────────────────────────────────────

console.log("\n── Part 1: source contracts ──");

const helperSrc = readSrc("client/src/components/comms/helpers.tsx");
const typesSrc   = readSrc("client/src/components/comms/types.ts");
const routeSrc   = readCommsRouteSources();

function readCommsRouteSources(): string {
  const dir = join(process.cwd(), "server/routes/comms");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf-8"))
    .join("\n");
}
const storageSrc = readSrc("server/storage/comms/channels.ts");
const railSrc    = readSrc("client/src/components/comms/CommsRail.tsx");
const popupSrc   = readSrc("client/src/components/comms/CommsPopupManager.tsx");

ok(
  typesSrc.includes("dmParticipantNames"),
  "CommsChannel type includes dmParticipantNames field",
);
ok(
  storageSrc.includes("getDmParticipantNamesForChannels"),
  "commsStorage exports getDmParticipantNamesForChannels",
);
ok(
  routeSrc.includes("getDmParticipantNamesForChannels"),
  "GET /api/comms/channels calls getDmParticipantNamesForChannels",
);
ok(
  routeSrc.includes("dmParticipantNames"),
  "GET /api/comms/channels spreads dmParticipantNames onto result",
);
ok(
  helperSrc.includes("dmParticipantNames"),
  "channelDisplayName helper uses dmParticipantNames",
);
ok(
  !helperSrc.includes('"Direct Message"') ||
    helperSrc.indexOf("dmParticipantNames") < helperSrc.indexOf('"Direct Message"'),
  "channelDisplayName checks dmParticipantNames before falling back to 'Direct Message'",
);
ok(
  !helperSrc.includes('"Group DM"') ||
    helperSrc.indexOf("dmParticipantNames") < helperSrc.indexOf('"Group DM"'),
  "channelDisplayName checks dmParticipantNames before falling back to 'Group DM'",
);
{
  // The collapsed rail strip (CollapsedChannelItem) was removed in the
  // Task #3326 slide-out-tab redesign (#3333 deleted the dead code). The
  // surviving rail row must still derive its label from the resolved
  // display name — channelDisplayName(ch) — not raw ch.name.
  const rowBlock = railSrc.slice(
    railSrc.indexOf("function ExpandedChannelRow"),
    railSrc.indexOf("function railMemberName"),
  );
  ok(
    rowBlock.includes("channelDisplayName(ch)"),
    "ExpandedChannelRow derives its label from the resolved display name (channelDisplayName), not ch.name",
  );
}
ok(
  popupSrc.includes("channelDisplayName"),
  "CommsPopupManager uses channelDisplayName (picks up resolved DM name)",
);
{
  // Task #3344 — each of the three Task #3337 handlers must route through the
  // shared enrichment helper so dmParticipantNames can't be dropped from one.
  const publicHandler = routeSrc.slice(
    routeSrc.indexOf('"/api/comms/channels/public"'),
    routeSrc.indexOf('"/api/comms/default-channels"'),
  );
  const archivedHandler = routeSrc.slice(
    routeSrc.indexOf('"/api/comms/channels/archived"'),
    routeSrc.indexOf('app.get("/api/comms/channels/:id"'),
  );
  const byIdHandler = routeSrc.slice(
    routeSrc.indexOf('app.get("/api/comms/channels/:id"'),
    routeSrc.indexOf('app.patch("/api/comms/channels/:id"'),
  );
  ok(
    publicHandler.includes("enrichWithDmParticipantNames"),
    "GET /api/comms/channels/public routes through enrichWithDmParticipantNames",
  );
  ok(
    archivedHandler.includes("enrichWithDmParticipantNames"),
    "GET /api/comms/channels/archived routes through enrichWithDmParticipantNames",
  );
  ok(
    byIdHandler.includes("enrichWithDmParticipantNames"),
    "GET /api/comms/channels/:id routes through enrichWithDmParticipantNames",
  );
}

// ── Task #3528: email-fallback source contracts ───────────────────────────────
{
  // displayName must fall back to email local-part before the truncated-ID fallback
  const displayNameFn = helperSrc.slice(
    helperSrc.indexOf("export function displayName"),
    helperSrc.indexOf("export function avatarInitials"),
  );
  ok(
    displayNameFn.includes('user.email') && displayNameFn.includes('.split("@")[0]'),
    "displayName falls back to email local-part (user.email.split('@')[0]) before truncated-ID",
  );
  ok(
    displayNameFn.indexOf("user.email") < displayNameFn.indexOf(".slice(0, 8)"),
    "displayName checks email fallback before the truncated-ID fallback",
  );
}
{
  // getDmParticipantsForChannels must select email and use it as a fallback
  const storageFn = storageSrc.slice(
    storageSrc.indexOf("export async function getDmParticipantsForChannels"),
    storageSrc.indexOf("export async function getClientFirmNamesForChannels"),
  );
  ok(
    storageFn.includes("email: users.email"),
    "getDmParticipantsForChannels selects email from users table",
  );
  ok(
    storageFn.includes('r.email') && storageFn.includes('.split("@")[0]'),
    "getDmParticipantsForChannels falls back to email local-part",
  );
}
{
  // CommsMessage.user type must include email
  ok(
    typesSrc.includes("email?:") || typesSrc.includes("email:"),
    "CommsMessage.user type includes email field",
  );
}
{
  // JIT provisioning in requireAuth.ts only writes email from claims;
  // user-managed firstName/lastName are never overwritten by auth.
  const requireAuthSrc = readSrc("server/middlewares/requireAuth.ts");
  ok(
    requireAuthSrc.includes("autoJoinDefaultChannels"),
    "requireAuth JIT provisioning triggers autoJoinDefaultChannels for new users",
  );
}

// ─── Part 2: live route tests ─────────────────────────────────────────────────

console.log("\n── Part 2: route tests ──");

async function run() {
  await seed();
  try {
    await test("DM channel response includes dmParticipantNames with Bob's name", async () => {
      const { channels } = await withApp(USER_A_ID, async (base) => {
        const res = await undici.fetch(`${base}/api/comms/channels`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        return { channels: (await res.json()) as any[] };
      });
      const dm = channels.find((c: any) => c.id === dmChannelId);
      assert.ok(dm, "DM channel should appear in channels list");
      assert.ok(Array.isArray(dm.dmParticipantNames), "dmParticipantNames should be an array");
      assert.equal(dm.dmParticipantNames.length, 1, "DM should have exactly 1 other participant");
      assert.ok(
        dm.dmParticipantNames[0].includes("Bob"),
        `Expected participant name to include 'Bob', got '${dm.dmParticipantNames[0]}'`,
      );
    });

    await test("Group DM channel includes both other participants", async () => {
      const { channels } = await withApp(USER_A_ID, async (base) => {
        const res = await undici.fetch(`${base}/api/comms/channels`);
        assert.equal(res.status, 200);
        return { channels: (await res.json()) as any[] };
      });
      const gdm = channels.find((c: any) => c.id === groupDmChannelId);
      assert.ok(gdm, "Group DM channel should appear in channels list");
      assert.ok(Array.isArray(gdm.dmParticipantNames), "dmParticipantNames should be an array");
      assert.equal(gdm.dmParticipantNames.length, 2, "Group DM should have 2 other participants");
      const names: string = gdm.dmParticipantNames.join(" ");
      assert.ok(names.includes("Bob"), `Expected 'Bob' in participant names, got '${names}'`);
      assert.ok(names.includes("Carol"), `Expected 'Carol' in participant names, got '${names}'`);
    });

    // ── Task #3342: dmParticipants pairs each name with its userId ─────────
    await test("Group DM includes dmParticipants keyed by userId (name paired with id)", async () => {
      const { channels } = await withApp(USER_A_ID, async (base) => {
        const res = await undici.fetch(`${base}/api/comms/channels`);
        assert.equal(res.status, 200);
        return { channels: (await res.json()) as any[] };
      });
      const gdm = channels.find((c: any) => c.id === groupDmChannelId);
      assert.ok(gdm, "Group DM channel should appear in channels list");
      assert.ok(Array.isArray(gdm.dmParticipants), "dmParticipants should be an array");
      assert.equal(gdm.dmParticipants.length, 2, "Group DM should have 2 other participants");
      for (const p of gdm.dmParticipants) {
        assert.ok(typeof p.userId === "string" && p.userId.length > 0, "each participant has a userId");
        assert.ok(typeof p.name === "string" && p.name.length > 0, "each participant has a name");
      }
      const bob = gdm.dmParticipants.find((p: any) => p.userId === USER_B_ID);
      const carol = gdm.dmParticipants.find((p: any) => p.userId === USER_C_ID);
      assert.ok(bob && bob.name.includes("Bob"), `Expected Bob paired with ${USER_B_ID}`);
      assert.ok(carol && carol.name.includes("Carol"), `Expected Carol paired with ${USER_C_ID}`);
      assert.ok(
        !gdm.dmParticipants.some((p: any) => p.userId === USER_A_ID),
        "Caller must not appear in dmParticipants",
      );
      // dmParticipantNames stays in lockstep with dmParticipants
      assert.deepEqual(
        gdm.dmParticipantNames,
        gdm.dmParticipants.map((p: any) => p.name),
        "dmParticipantNames must equal dmParticipants names in the same order",
      );
    });

    await test("Non-DM channel has null dmParticipants", async () => {
      const { channels } = await withApp(USER_A_ID, async (base) => {
        const res = await undici.fetch(`${base}/api/comms/channels`);
        assert.equal(res.status, 200);
        return { channels: (await res.json()) as any[] };
      });
      const nonDm = channels.find((c: any) => c.type === "channel");
      if (nonDm) {
        assert.equal(nonDm.dmParticipants ?? null, null, "Non-DM channel should have null dmParticipants");
      }
    });

    await test("Caller's own name not included in dmParticipantNames", async () => {
      const { channels } = await withApp(USER_A_ID, async (base) => {
        const res = await undici.fetch(`${base}/api/comms/channels`);
        assert.equal(res.status, 200);
        return { channels: (await res.json()) as any[] };
      });
      const dm = channels.find((c: any) => c.id === dmChannelId);
      assert.ok(dm, "DM channel should appear");
      const names: string[] = dm.dmParticipantNames ?? [];
      const hasAlice = names.some((n: string) => n.includes("Alice"));
      assert.ok(!hasAlice, `Caller's own name 'Alice' should not appear in dmParticipantNames`);
    });

    await test("Non-DM channel has null dmParticipantNames", async () => {
      const testChannel = await commsStorage.createChannel({
        name: `dm-names-regular-${RUN}`,
        slug: `dm-names-regular-${RUN}`,
        type: "channel",
        visibility: "public",
        createdBy: USER_A_ID,
      });
      try {
        await commsStorage.addChannelMember(testChannel.id, USER_A_ID, "member");
        const { channels } = await withApp(USER_A_ID, async (base) => {
          const res = await undici.fetch(`${base}/api/comms/channels`);
          assert.equal(res.status, 200);
          return { channels: (await res.json()) as any[] };
        });
        const ch = channels.find((c: any) => c.id === testChannel.id);
        assert.ok(ch, "Regular channel should appear in list");
        assert.equal(ch.dmParticipantNames, null, "Non-DM channel should have null dmParticipantNames");
      } finally {
        await db.delete(commsChannels).where(eq(commsChannels.id, testChannel.id)).catch(() => {});
      }
    });

    // ── Task #3344: GET /api/comms/channels/:id ───────────────────────────

    await test("GET /channels/:id for a DM includes dmParticipantNames with Bob's name", async () => {
      const ch = await withApp(USER_A_ID, async (base) => {
        const res = await undici.fetch(`${base}/api/comms/channels/${dmChannelId}`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        return (await res.json()) as any;
      });
      assert.ok(Array.isArray(ch.dmParticipantNames), "dmParticipantNames should be an array");
      assert.equal(ch.dmParticipantNames.length, 1, "DM should have exactly 1 other participant");
      assert.ok(
        ch.dmParticipantNames[0].includes("Bob"),
        `Expected participant name to include 'Bob', got '${ch.dmParticipantNames[0]}'`,
      );
      assert.ok(
        !ch.dmParticipantNames.some((n: string) => n.includes("Alice")),
        "Caller's own name should not appear in /channels/:id dmParticipantNames",
      );
    });

    await test("GET /channels/:id for a group DM includes both other participants", async () => {
      const ch = await withApp(USER_A_ID, async (base) => {
        const res = await undici.fetch(`${base}/api/comms/channels/${groupDmChannelId}`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        return (await res.json()) as any;
      });
      assert.ok(Array.isArray(ch.dmParticipantNames), "dmParticipantNames should be an array");
      assert.equal(ch.dmParticipantNames.length, 2, "Group DM should have 2 other participants");
      const names = ch.dmParticipantNames.join(" ");
      assert.ok(names.includes("Bob"), `Expected 'Bob' in participant names, got '${names}'`);
      assert.ok(names.includes("Carol"), `Expected 'Carol' in participant names, got '${names}'`);
    });

    await test("GET /channels/:id for a non-DM channel returns dmParticipantNames: null", async () => {
      const testChannel = await commsStorage.createChannel({
        name: `dm-names-byid-${RUN}`,
        slug: `dm-names-byid-${RUN}`,
        type: "channel",
        visibility: "public",
        createdBy: USER_A_ID,
      });
      try {
        await commsStorage.addChannelMember(testChannel.id, USER_A_ID, "member");
        const ch = await withApp(USER_A_ID, async (base) => {
          const res = await undici.fetch(`${base}/api/comms/channels/${testChannel.id}`);
          assert.equal(res.status, 200, `expected 200, got ${res.status}`);
          return (await res.json()) as any;
        });
        assert.equal(ch.dmParticipantNames, null, "Non-DM channel should have null dmParticipantNames");
        assert.ok(Array.isArray(ch.members), "/channels/:id still returns members");
      } finally {
        await db.delete(commsChannels).where(eq(commsChannels.id, testChannel.id)).catch(() => {});
      }
    });

    // ── Task #3344: public + archived lists keep non-DM rows unchanged ───────

    await test("GET /channels/public returns non-DM rows unchanged with dmParticipantNames: null", async () => {
      const testChannel = await commsStorage.createChannel({
        name: `dm-names-public-${RUN}`,
        slug: `dm-names-public-${RUN}`,
        type: "channel",
        visibility: "public",
        createdBy: USER_A_ID,
      });
      try {
        const channels = await withApp(USER_A_ID, async (base) => {
          const res = await undici.fetch(`${base}/api/comms/channels/public`);
          assert.equal(res.status, 200, `expected 200, got ${res.status}`);
          return (await res.json()) as any[];
        });
        const ch = channels.find((c: any) => c.id === testChannel.id);
        assert.ok(ch, "Public channel should appear in /channels/public");
        assert.equal(ch.dmParticipantNames, null, "Public non-DM row should have null dmParticipantNames");
        assert.equal(ch.name, testChannel.name, "Public row name unchanged");
        assert.equal(ch.slug, testChannel.slug, "Public row slug unchanged");
        assert.equal(ch.type, "channel", "Public row type unchanged");
        assert.equal(ch.visibility, "public", "Public row visibility unchanged");
      } finally {
        await db.delete(commsChannels).where(eq(commsChannels.id, testChannel.id)).catch(() => {});
      }
    });

    await test("GET /channels/archived returns non-DM rows unchanged with dmParticipantNames: null", async () => {
      const testChannel = await commsStorage.createChannel({
        name: `dm-names-arch-${RUN}`,
        slug: `dm-names-arch-${RUN}`,
        type: "channel",
        visibility: "public",
        createdBy: USER_A_ID,
      });
      try {
        await commsStorage.addChannelMember(testChannel.id, USER_A_ID, "member");
        await commsStorage.archiveChannel(testChannel.id);
        const channels = await withApp(USER_A_ID, async (base) => {
          const res = await undici.fetch(`${base}/api/comms/channels/archived`);
          assert.equal(res.status, 200, `expected 200, got ${res.status}`);
          return (await res.json()) as any[];
        });
        const ch = channels.find((c: any) => c.id === testChannel.id);
        assert.ok(ch, "Archived channel should appear in /channels/archived");
        assert.equal(ch.dmParticipantNames, null, "Archived non-DM row should have null dmParticipantNames");
        assert.equal(ch.name, testChannel.name, "Archived row name unchanged");
        assert.equal(ch.slug, testChannel.slug, "Archived row slug unchanged");
        assert.ok(ch.archivedAt, "Archived row keeps archivedAt");
      } finally {
        await db.delete(commsChannels).where(eq(commsChannels.id, testChannel.id)).catch(() => {});
      }
    });

    // ── Task #3528: email-fallback live tests ─────────────────────────────────

    await test("DM with no-name user shows email local-part in dmParticipantNames", async () => {
      const { channels } = await withApp(USER_A_ID, async (base) => {
        const res = await undici.fetch(`${base}/api/comms/channels`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        return { channels: (await res.json()) as any[] };
      });
      const dm = channels.find((c: any) => c.id === emailFallbackDmId);
      assert.ok(dm, "Email-fallback DM channel should appear in channels list");
      assert.ok(Array.isArray(dm.dmParticipantNames), "dmParticipantNames should be an array");
      assert.equal(dm.dmParticipantNames.length, 1, "DM should have exactly 1 other participant");
      // email is jdavis-${RUN}@nobullmarketing.co → local-part is jdavis-${RUN}
      assert.ok(
        dm.dmParticipantNames[0].startsWith("jdavis-"),
        `Expected participant name to be email local-part 'jdavis-*', got '${dm.dmParticipantNames[0]}'`,
      );
    });

    await test("DM with no-name-no-email user shows empty dmParticipantNames (graceful fallback)", async () => {
      const { channels } = await withApp(USER_A_ID, async (base) => {
        const res = await undici.fetch(`${base}/api/comms/channels`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        return { channels: (await res.json()) as any[] };
      });
      const dm = channels.find((c: any) => c.id === anonDmId);
      assert.ok(dm, "Anonymous DM channel should appear in channels list");
      // No name, no email → participant is skipped → dmParticipantNames is null or empty array
      const names: string[] = dm.dmParticipantNames ?? [];
      assert.equal(
        names.length,
        0,
        `Expected empty dmParticipantNames for fully-anonymous user, got: ${JSON.stringify(names)}`,
      );
    });

    await test("Named users are unaffected by email-fallback change", async () => {
      const { channels } = await withApp(USER_A_ID, async (base) => {
        const res = await undici.fetch(`${base}/api/comms/channels`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        return { channels: (await res.json()) as any[] };
      });
      const dm = channels.find((c: any) => c.id === dmChannelId);
      assert.ok(dm, "Named-user DM should still appear");
      assert.ok(
        dm.dmParticipantNames[0].includes("Bob"),
        `Named user DM should still show full name, got '${dm.dmParticipantNames[0]}'`,
      );
    });

    console.log(`\ncomms-dm-participant-names: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } finally {
    await cleanup();
    // Drain undici keep-alive sockets so the process exits cleanly
    await (getGlobalDispatcher() as any).close?.().catch(() => {});
    await closeDbPools();
  }
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
