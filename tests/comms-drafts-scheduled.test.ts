/* test-registration
{
  "name": "Comms drafts + scheduled messages — API contract, isolation, storage idempotency (Task #3253)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3253: comms server-synced drafts + scheduled messages. Guards the full API contract: PUT/GET/DELETE draft (upsert idempotency, user isolation, empty-content = delete); POST/GET/PATCH/DELETE scheduled messages (authz: non-member 403, non-author 403 on edit/cancel); and the storage claimDueScheduledMessage boundary (future rows not returned). Real routes + DB; run-token-suffixed rows, deleted in finally.",
  "tier": "small"
}
test-registration */
/**
 * Comms drafts + scheduled-messages smoke tests (Task #3253).
 *
 * Coverage:
 *  – Draft API: PUT (upsert), GET (retrieve), DELETE via empty PUT, list all
 *  – Draft isolation: user A cannot read user B's draft for the same channel
 *  – Scheduled message API: POST, GET list, PATCH (edit before delivery), DELETE (cancel)
 *  – Scheduled auth: non-member cannot create a scheduled message; non-author cannot cancel
 *  – Storage: upsertDraft idempotency (second write returns same row id)
 *  – Storage: claimDueScheduledMessage returns row only after scheduledFor passes
 *
 * Isolation: run-token-suffixed rows seeded in the shared dev DB; all deleted in finally.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import { sql } from "drizzle-orm";
import {
  commsChannels,
  commsChannelMembers,
  commsDrafts,
  commsScheduledMessages,
} from "../shared/models/comms";
import { registerCommsRoutes } from "../server/routes/comms";
import * as commsStorage from "../server/storage/commsStorage";

const RUN = randomBytes(4).toString("hex");

const AUTHOR_ID  = `ds3253-author-${RUN}`;
const OTHER_ID   = `ds3253-other-${RUN}`;
const OUTSIDE_ID = `ds3253-out-${RUN}`;

let channelId = "";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeApp(actingUserId: string, _role = "account_manager"): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; requireAuth loads the real users row
    // (public schema, seeded above) so requireRole reflects the DB role.
    req.__test_clerkUserId = actingUserId;
    next();
  });
  registerCommsRoutes(app);
  return app;
}

async function withApp<T>(
  actingUserId: string,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = makeApp(actingUserId);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}

async function req(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  let parsed: any;
  try { parsed = await r.json(); } catch { parsed = null; }
  return { status: r.status, body: parsed };
}

// ─── test runner ─────────────────────────────────────────────────────────────

let failures = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  ✗ ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

// ─── seed / cleanup ──────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  await db.insert(users).values([
    { id: AUTHOR_ID,  email: `auth-${RUN}@x.test`, firstName: "Author",  lastName: "DS", role: "account_manager" },
    { id: OTHER_ID,   email: `othe-${RUN}@x.test`, firstName: "Other",   lastName: "DS", role: "account_manager" },
    { id: OUTSIDE_ID, email: `out-${RUN}@x.test`,  firstName: "Outside", lastName: "DS", role: "account_manager" },
  ]);

  const [ch] = await db
    .insert(commsChannels)
    .values({ name: `ds-test-${RUN}`, type: "public" })
    .returning();
  channelId = ch.id;

  await db.insert(commsChannelMembers).values([
    { channelId, userId: AUTHOR_ID },
    { channelId, userId: OTHER_ID },
  ]);
}

async function cleanup(): Promise<void> {
  if (channelId) {
    await db.delete(commsScheduledMessages).where(sql`channel_id = ${channelId}`);
    await db.delete(commsDrafts).where(sql`channel_id = ${channelId}`);
    await db.delete(commsChannelMembers).where(sql`channel_id = ${channelId}`);
    await db.delete(commsChannels).where(sql`id = ${channelId}`);
  }
  await db.delete(users).where(sql`id IN (${AUTHOR_ID}, ${OTHER_ID}, ${OUTSIDE_ID})`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("comms-drafts-scheduled: drafts + scheduled messages (Task #3253)");

  // Disable keep-alive so undici sockets drain on exit
  setGlobalDispatcher(new Agent({ keepAliveMaxTimeout: 1, connections: 1 }));

  await seed();

  try {
    // ── 1. Draft: upsert ────────────────────────────────────────────────────
    await step("PUT /api/comms/channels/:id/draft — upserts draft", async () => {
      await withApp(AUTHOR_ID, async (base) => {
        const r = await req("PUT", `${base}/api/comms/channels/${channelId}/draft`, {
          content: "hello draft",
          parentId: null,
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.ok(r.body.id, "should have id");
        assert.equal(r.body.content, "hello draft");
      });
    });

    // ── 2. Draft: retrieve ──────────────────────────────────────────────────
    await step("GET /api/comms/channels/:id/draft — retrieves own draft", async () => {
      await withApp(AUTHOR_ID, async (base) => {
        const r = await req("GET", `${base}/api/comms/channels/${channelId}/draft`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.content, "hello draft");
      });
    });

    // ── 3. Draft: isolation (other user does not see author's draft) ────────
    await step("GET draft — other member cannot see author's draft content", async () => {
      await withApp(OTHER_ID, async (base) => {
        const r = await req("GET", `${base}/api/comms/channels/${channelId}/draft`);
        if (r.status === 200) {
          assert.notEqual(
            r.body?.content,
            "hello draft",
            "must not return another user's draft",
          );
        }
        // 404 is also acceptable (no draft for OTHER_ID)
      });
    });

    // ── 4. Draft: list ──────────────────────────────────────────────────────
    await step("GET /api/comms/drafts — lists only current user's drafts", async () => {
      await withApp(AUTHOR_ID, async (base) => {
        const r = await req("GET", `${base}/api/comms/drafts`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.ok(Array.isArray(r.body), "should return array");
        const channelDraft = r.body.find((d: any) => d.channelId === channelId);
        assert.ok(channelDraft, "should include the test channel draft");
        assert.equal(channelDraft.content, "hello draft");
      });
    });

    // ── 5. Draft: clear via empty content ───────────────────────────────────
    await step("PUT with empty content deletes the draft", async () => {
      await withApp(AUTHOR_ID, async (base) => {
        const r = await req("PUT", `${base}/api/comms/channels/${channelId}/draft`, {
          content: "",
          parentId: null,
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));

        const g = await req("GET", `${base}/api/comms/channels/${channelId}/draft`);
        assert.ok(
          g.status === 404 || (g.status === 200 && (!g.body || !g.body.content)),
          `draft should be empty after clearing, got ${g.status}: ${JSON.stringify(g.body)}`,
        );
      });
    });

    // ── 6. Storage: upsert idempotency ──────────────────────────────────────
    await step("storage upsertDraft — second write updates same row", async () => {
      const first  = await commsStorage.upsertDraft(AUTHOR_ID, channelId, null, "v1");
      const second = await commsStorage.upsertDraft(AUTHOR_ID, channelId, null, "v2");
      assert.equal(first.id, second.id, "second upsert should update the same row");
      assert.equal(second.content, "v2");
      await commsStorage.upsertDraft(AUTHOR_ID, channelId, null, "");
    });

    // ─── Scheduled messages ────────────────────────────────────────────────

    const scheduledFor = new Date(Date.now() + 3_600_000).toISOString();
    let scheduledMsgId = "";

    // ── 7. Create ──────────────────────────────────────────────────────────
    await step("POST /api/comms/channels/:id/scheduled-messages — creates message", async () => {
      await withApp(AUTHOR_ID, async (base) => {
        const r = await req(
          "POST",
          `${base}/api/comms/channels/${channelId}/scheduled-messages`,
          { content: "hello future", scheduledFor, parentId: null },
        );
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.ok(r.body.id, "should have id");
        scheduledMsgId = r.body.id;
        assert.equal(r.body.status, "pending");
        assert.equal(r.body.content, "hello future");
      });
    });

    // ── 8. List by channel ─────────────────────────────────────────────────
    await step("GET /api/comms/channels/:id/scheduled-messages — returns pending list", async () => {
      if (!scheduledMsgId) { console.log("    (skip — creation failed)"); return; }
      await withApp(AUTHOR_ID, async (base) => {
        const r = await req("GET", `${base}/api/comms/channels/${channelId}/scheduled-messages`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.ok(Array.isArray(r.body));
        const found = r.body.find((m: any) => m.id === scheduledMsgId);
        assert.ok(found, "should include our scheduled message");
        assert.equal(found.status, "pending");
      });
    });

    // ── 9. All-user list ───────────────────────────────────────────────────
    await step("GET /api/comms/scheduled-messages — all-user list includes message", async () => {
      if (!scheduledMsgId) { console.log("    (skip — creation failed)"); return; }
      await withApp(AUTHOR_ID, async (base) => {
        const r = await req("GET", `${base}/api/comms/scheduled-messages`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.ok(Array.isArray(r.body));
        const found = r.body.find((m: any) => m.id === scheduledMsgId);
        assert.ok(found, "should appear in the all-user scheduled list");
      });
    });

    // ── 10. Author can edit ────────────────────────────────────────────────
    await step("PATCH /api/comms/scheduled-messages/:id — author can edit", async () => {
      if (!scheduledMsgId) { console.log("    (skip — creation failed)"); return; }
      await withApp(AUTHOR_ID, async (base) => {
        const newTime = new Date(Date.now() + 7_200_000).toISOString();
        const r = await req(
          "PATCH",
          `${base}/api/comms/scheduled-messages/${scheduledMsgId}`,
          { content: "updated content", scheduledFor: newTime },
        );
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.content, "updated content");
      });
    });

    // ── 11. Non-author edit blocked ────────────────────────────────────────
    await step("PATCH — non-author cannot edit (403)", async () => {
      if (!scheduledMsgId) { console.log("    (skip — creation failed)"); return; }
      await withApp(OTHER_ID, async (base) => {
        const r = await req(
          "PATCH",
          `${base}/api/comms/scheduled-messages/${scheduledMsgId}`,
          { content: "hacked" },
        );
        assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
      });
    });

    // ── 12. Non-member blocked ─────────────────────────────────────────────
    await step("POST scheduled-messages — non-member gets 403", async () => {
      await withApp(OUTSIDE_ID, async (base) => {
        const r = await req(
          "POST",
          `${base}/api/comms/channels/${channelId}/scheduled-messages`,
          { content: "sneaky", scheduledFor },
        );
        assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
      });
    });

    // ── 13. Non-author cancel blocked ─────────────────────────────────────
    await step("DELETE — non-author cannot cancel (403)", async () => {
      if (!scheduledMsgId) { console.log("    (skip — creation failed)"); return; }
      await withApp(OTHER_ID, async (base) => {
        const r = await req(
          "DELETE",
          `${base}/api/comms/scheduled-messages/${scheduledMsgId}`,
        );
        assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
      });
    });

    // ── 14. Author cancel ──────────────────────────────────────────────────
    await step("DELETE — author can cancel scheduled message", async () => {
      if (!scheduledMsgId) { console.log("    (skip — creation failed)"); return; }
      await withApp(AUTHOR_ID, async (base) => {
        const r = await req(
          "DELETE",
          `${base}/api/comms/scheduled-messages/${scheduledMsgId}`,
        );
        assert.equal(r.status, 200, JSON.stringify(r.body));

        const g = await req("GET", `${base}/api/comms/channels/${channelId}/scheduled-messages`);
        const found = (g.body ?? []).find(
          (m: any) => m.id === scheduledMsgId && m.status === "pending",
        );
        assert.ok(!found, "cancelled message should not appear in pending list");
      });
    });

    // ── 15. Storage: claimDue does not claim future rows ───────────────────
    await step("storage claimDueScheduledMessage — does not claim future message", async () => {
      const { id: futureId } = await commsStorage.createScheduledMessage({
        userId: AUTHOR_ID,
        channelId,
        content: "future only",
        scheduledFor: new Date(Date.now() + 3_600_000),
        parentId: null,
        metadata: null,
      });
      try {
        const claimed = await commsStorage.claimDueScheduledMessage();
        assert.ok(
          !claimed || claimed.id !== futureId,
          "must not claim a message scheduled in the future",
        );
      } finally {
        await commsStorage.cancelScheduledMessage(futureId, AUTHOR_ID);
      }
    });
  } finally {
    await cleanup();
    await closeDbPools();

    // Drain undici keep-alive sockets
    const dispatcher = getGlobalDispatcher();
    if (typeof (dispatcher as any).close === "function") {
      await (dispatcher as any).close();
    }
  }

  if (failures > 0) {
    console.error(`\ncomms-drafts-scheduled: ${failures} test(s) failed`);
    process.exit(1);
  }
  console.log(`\ncomms-drafts-scheduled: all tests passed`);
}

main().catch((err) => {
  console.error("comms-drafts-scheduled: fatal error:", err);
  process.exit(1);
});
