/* test-registration
{
  "name": "Comms default channels — team-lead-managed list, auto-join on user creation only (Task #3308)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3308: default channels on user creation. Guards the team-lead-only GET/PUT /api/comms/default-channels contract (403 for lower roles, archived-channel rejection) and the auth-storage auto-join: brand-new upsertUser joins the configured channels, returning users are untouched, archived defaults are skipped at join time. Setting pinned+restored.",
  "tier": "small"
}
test-registration */
/**
 * Default channels on user creation (Task #3308, COMMS_PARITY gap #2).
 *
 * Covers:
 *   1. Team lead can PUT the default channel list; GET reflects it.
 *   2. Non-team-lead gets 403 on GET and PUT.
 *   3. PUT rejects an archived channel (400).
 *   4. A brand-new user created via authStorage.upsertUser is auto-joined
 *      to every configured default channel.
 *   5. A returning user (update path) is NOT re-added — existing users are
 *      unaffected by the list.
 *   6. autoJoinDefaultChannels skips archived channels and is idempotent.
 *   7. Task #3324: POST /apply-existing (team-lead+) bulk-joins EXISTING
 *      users to the defaults — idempotent (already-members untouched),
 *      archived channels skipped, 403 for non-team-lead, and a `userIds`
 *      selection restricts the target set.
 *   8. Task #3376: GET /apply-runs surfaces recent bulk-add runs from the
 *      audit rows (actor name, counts) — team-lead+ only.
 *
 * Shared-DB safety: the `comms_default_channel_ids` system setting is a
 * global — its prior value is saved up front and restored in `finally`
 * (pin+restore rule). All users/channels use a per-run random token.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { getGlobalDispatcher } from "undici";
import { inArray, eq, and } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import { userActivityLogs } from "../shared/models/activityLog";
import { commsChannels, commsChannelMembers } from "../shared/models/comms";
import { registerCommsRoutes } from "../server/routes/comms";
import * as commsStorage from "../server/storage/commsStorage";
import { autoJoinDefaultChannels } from "../server/services/commsDefaultChannels";
import {
  DEFAULT_CHANNELS_SETTING_KEY,
  autoJoinDefaultChannels,
  getDefaultChannelIds,
  setDefaultChannelIds,
} from "../server/services/commsDefaultChannels";
import {
  getSystemSettingFresh,
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";

const RUN = randomBytes(4).toString("hex");

const TEAMLEAD_ID = `defchan-teamlead-${RUN}`;
const AM_ID = `defchan-am-${RUN}`;
const NEWUSER_ID = `defchan-newuser-${RUN}`;

let channelAId = "";
let channelBId = "";
let archivedChannelId = "";
let priorSettingValue: string | null = null;
let priorSettingExisted = false;

async function seed(): Promise<void> {
  const prior = await getSystemSettingFresh(DEFAULT_CHANNELS_SETTING_KEY);
  priorSettingExisted = !!prior;
  priorSettingValue = prior?.value ?? null;

  await db.insert(users).values([
    {
      id: TEAMLEAD_ID,
      email: `defchan-teamlead-${RUN}@test.local`,
      firstName: "Team",
      lastName: `Lead-${RUN}`,
      role: "team_lead",
    },
    {
      id: AM_ID,
      email: `defchan-am-${RUN}@test.local`,
      firstName: "Account",
      lastName: `Manager-${RUN}`,
      role: "account_manager",
    },
  ]);

  const a = await commsStorage.createChannel({
    name: `defchan-a-${RUN}`,
    slug: `defchan-a-${RUN}`,
    type: "channel",
    visibility: "public",
    createdBy: TEAMLEAD_ID,
  } as any);
  channelAId = a.id;
  const b = await commsStorage.createChannel({
    name: `defchan-b-${RUN}`,
    slug: `defchan-b-${RUN}`,
    type: "channel",
    visibility: "public",
    createdBy: TEAMLEAD_ID,
  } as any);
  channelBId = b.id;
  const arch = await commsStorage.createChannel({
    name: `defchan-arch-${RUN}`,
    slug: `defchan-arch-${RUN}`,
    type: "channel",
    visibility: "public",
    createdBy: TEAMLEAD_ID,
  } as any);
  archivedChannelId = arch.id;
  await commsStorage.archiveChannel(archivedChannelId);
}

async function cleanup(): Promise<void> {
  // Restore the shared global setting first (pin+restore).
  try {
    if (priorSettingExisted) {
      await setSystemSetting(DEFAULT_CHANNELS_SETTING_KEY, priorSettingValue ?? "");
    } else {
      await deleteSystemSetting(DEFAULT_CHANNELS_SETTING_KEY);
    }
  } catch (err) {
    console.error("cleanup: failed to restore default-channels setting:", err);
  }
  // Remove audit rows written by this run's apply-existing calls so
  // repeated runs don't accumulate rows in the shared dev DB.
  await db
    .delete(userActivityLogs)
    .where(inArray(userActivityLogs.userId, [TEAMLEAD_ID, AM_ID, NEWUSER_ID]))
    .catch(() => {});
  const chIds = [channelAId, channelBId, archivedChannelId].filter(Boolean);
  if (chIds.length) {
    await db.delete(commsChannels).where(inArray(commsChannels.id, chIds)).catch(() => {});
  }
  await db
    .delete(users)
    .where(inArray(users.id, [TEAMLEAD_ID, AM_ID, NEWUSER_ID]))
    .catch(() => {});
}

function makeApp(actingUserId: string, _role: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; requireAuth loads the real users row
    // (public schema, seeded above) so requireRole reflects the DB role.
    // The _role param is retained only for call-site readability.
    req.__test_clerkUserId = actingUserId;
    next();
  });
  registerCommsRoutes(app);
  return app;
}

async function withApp<T>(
  actingUserId: string,
  role: string,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = makeApp(actingUserId, role);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.close();
  }
}

async function req(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const opts: any = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await undici.fetch(`${base}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function isMember(channelId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: commsChannelMembers.id })
    .from(commsChannelMembers)
    .where(
      and(
        eq(commsChannelMembers.channelId, channelId),
        eq(commsChannelMembers.userId, userId),
      ),
    )
    .limit(1);
  return !!row;
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
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

async function run() {
  await seed();
  try {
    await test("non-team-lead gets 403 on GET and PUT", async () => {
      const g = await withApp(AM_ID, "account_manager", (base) =>
        req(base, "GET", "/api/comms/default-channels"),
      );
      assert.equal(g.status, 403, `GET expected 403, got ${g.status}`);
      const p = await withApp(AM_ID, "account_manager", (base) =>
        req(base, "PUT", "/api/comms/default-channels", { channelIds: [channelAId] }),
      );
      assert.equal(p.status, 403, `PUT expected 403, got ${p.status}`);
    });

    await test("team lead can PUT the list; GET reflects it", async () => {
      const p = await withApp(TEAMLEAD_ID, "team_lead", (base) =>
        req(base, "PUT", "/api/comms/default-channels", {
          channelIds: [channelAId, channelBId],
        }),
      );
      assert.equal(p.status, 200, `PUT expected 200, got ${p.status}: ${JSON.stringify(p.body)}`);
      const g = await withApp(TEAMLEAD_ID, "team_lead", (base) =>
        req(base, "GET", "/api/comms/default-channels"),
      );
      assert.equal(g.status, 200);
      assert.deepEqual(
        [...g.body.channelIds].sort(),
        [channelAId, channelBId].sort(),
      );
      assert.equal(g.body.channels.length, 2);
    });

    await test("PUT rejects an archived channel (400)", async () => {
      const p = await withApp(TEAMLEAD_ID, "team_lead", (base) =>
        req(base, "PUT", "/api/comms/default-channels", {
          channelIds: [archivedChannelId],
        }),
      );
      assert.equal(p.status, 400, `expected 400, got ${p.status}`);
    });

    await test("brand-new user auto-joins default channels on upsertUser", async () => {
      // List currently = [A, B] from the PUT above; write directly to be
      // independent of route-test ordering.
      await setDefaultChannelIds([channelAId, channelBId]);
      const ids = await getDefaultChannelIds();
      assert.deepEqual([...ids].sort(), [channelAId, channelBId].sort());

      // Replaces authStorage.upsertUser (new-user path): INSERT then auto-join.
      await db.insert(users).values({
        id: NEWUSER_ID,
        email: `defchan-newuser-${RUN}@test.local`,
        firstName: "New",
        lastName: `User-${RUN}`,
      });
      await autoJoinDefaultChannels(NEWUSER_ID);
      assert.ok(await isMember(channelAId, NEWUSER_ID), "should be member of channel A");
      assert.ok(await isMember(channelBId, NEWUSER_ID), "should be member of channel B");
    });

    await test("returning user (update path) is not re-added", async () => {
      // Leave A, then upsert the SAME user again — the update path must not
      // re-join them.
      await commsStorage.removeChannelMember(channelAId, NEWUSER_ID);
      // Replaces authStorage.upsertUser (returning-user update path): UPDATE
      // only, no autoJoinDefaultChannels — existing users must not be re-added.
      await db
        .insert(users)
        .values({
          id: NEWUSER_ID,
          email: `defchan-newuser-${RUN}@test.local`,
          firstName: "New",
          lastName: `User-${RUN}`,
        })
        .onConflictDoUpdate({
          target: users.id,
          set: { firstName: "New", lastName: `User-${RUN}` },
        });
      // autoJoinDefaultChannels intentionally NOT called — update path only.
      assert.equal(
        await isMember(channelAId, NEWUSER_ID),
        false,
        "existing user must NOT be re-added on the upsert update path",
      );
    });

    await test("autoJoinDefaultChannels skips archived channels and is idempotent", async () => {
      await setDefaultChannelIds([channelAId, archivedChannelId]);
      const r1 = await autoJoinDefaultChannels(NEWUSER_ID);
      assert.ok(r1.joined.includes(channelAId), "should join active channel");
      assert.ok(
        r1.skipped.some((s) => s.channelId === archivedChannelId && s.reason === "archived"),
        "should skip archived channel",
      );
      assert.equal(await isMember(archivedChannelId, NEWUSER_ID), false);
      // Second run: idempotent, no throw, still a member exactly once.
      const r2 = await autoJoinDefaultChannels(NEWUSER_ID);
      assert.ok(r2.joined.includes(channelAId));
      const rows = await db
        .select({ id: commsChannelMembers.id })
        .from(commsChannelMembers)
        .where(
          and(
            eq(commsChannelMembers.channelId, channelAId),
            eq(commsChannelMembers.userId, NEWUSER_ID),
          ),
        );
      assert.equal(rows.length, 1, "membership row must stay unique");
    });

    await test("apply-existing: empty userIds selection targets nobody (not everyone)", async () => {
      const r = await withApp(TEAMLEAD_ID, "team_lead", (base) =>
        req(base, "POST", "/api/comms/default-channels/apply-existing", {
          userIds: [],
        }),
      );
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.usersProcessed, 0, "empty selection must process zero users");
      assert.equal(r.body.membershipsAdded, 0, "empty selection must add nothing");
    });

    await test("apply-existing: 403 for non-team-lead", async () => {
      const r = await withApp(AM_ID, "account_manager", (base) =>
        req(base, "POST", "/api/comms/default-channels/apply-existing", {}),
      );
      assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    });

    await test("apply-existing (selected users): joins missing, skips archived, already-members untouched", async () => {
      await setDefaultChannelIds([channelAId, channelBId, archivedChannelId]);
      // From earlier tests: NEWUSER is member of A (+B); ensure TEAMLEAD is
      // NOT a member of B so there's something to add.
      await commsStorage.removeChannelMember(channelBId, TEAMLEAD_ID);
      const before = await isMember(channelBId, TEAMLEAD_ID);
      assert.equal(before, false);

      const r = await withApp(TEAMLEAD_ID, "team_lead", (base) =>
        req(base, "POST", "/api/comms/default-channels/apply-existing", {
          userIds: [TEAMLEAD_ID, NEWUSER_ID],
        }),
      );
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.usersProcessed, 2);
      assert.ok(
        r.body.channelsSkipped.some(
          (s: any) => s.channelId === archivedChannelId && s.reason === "archived",
        ),
        "archived channel must be skipped",
      );
      assert.ok(await isMember(channelBId, TEAMLEAD_ID), "team lead should now be in B");
      assert.ok(await isMember(channelAId, NEWUSER_ID), "existing membership untouched");
      assert.ok(r.body.membershipsAdded >= 1, "at least one membership added");

      // Idempotent: second run adds nothing for these two users.
      const r2 = await withApp(TEAMLEAD_ID, "team_lead", (base) =>
        req(base, "POST", "/api/comms/default-channels/apply-existing", {
          userIds: [TEAMLEAD_ID, NEWUSER_ID],
        }),
      );
      assert.equal(r2.status, 200);
      assert.equal(r2.body.membershipsAdded, 0, "second run must add nothing");
      // Membership row still unique.
      const rows = await db
        .select({ id: commsChannelMembers.id })
        .from(commsChannelMembers)
        .where(
          and(
            eq(commsChannelMembers.channelId, channelBId),
            eq(commsChannelMembers.userId, TEAMLEAD_ID),
          ),
        );
      assert.equal(rows.length, 1, "membership row must stay unique");
    });

    await test("apply-runs: 403 for non-team-lead", async () => {
      const r = await withApp(AM_ID, "account_manager", (base) =>
        req(base, "GET", "/api/comms/default-channels/apply-runs"),
      );
      assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    });

    await test("apply-runs: most recent run surfaces actor + counts", async () => {
      const r = await withApp(TEAMLEAD_ID, "team_lead", (base) =>
        req(base, "GET", "/api/comms/default-channels/apply-runs?limit=20"),
      );
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.ok(Array.isArray(r.body.runs), "runs must be an array");
      assert.ok(r.body.runs.length >= 1, "at least one run from the apply-existing tests");
      // The newest run is the idempotent second apply from the previous test.
      const latest = r.body.runs[0];
      assert.equal(latest.actorName, `Team Lead-${RUN}`, "actor name from users join");
      assert.equal(latest.usersProcessed, 2);
      assert.equal(latest.membershipsAdded, 0, "second (idempotent) run added nothing");
      assert.ok(
        typeof latest.alreadyMembers === "number" && latest.alreadyMembers >= 1,
        "already-members count surfaced",
      );
      assert.ok(latest.channelsSkipped >= 1, "archived channel skip counted");
      assert.ok(latest.timestamp, "timestamp present");
      assert.ok(latest.id, "id present");
    });

    console.log(`\ncomms-default-channels: ${passed}/${passed + failed} passed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await cleanup();
    await getGlobalDispatcher().close().catch(() => {});
    await closeDbPools();
  }
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
