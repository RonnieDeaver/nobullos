/* test-registration
{
  "name": "Comms notification settings — resolution matrix + keyword match + GET/PUT route contract (Task #3258)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3258: comms notification-settings resolution matrix + keyword-match + GET/PUT /api/comms/notification-settings route contract. Pure unit tests (DND/muted/channel-pref/global-default matrix, keyword word-boundary) and route smoke (defaults-on-first-read, upsert round-trip, 400 on bad enum). Real routes + DB; single run-token-suffixed user row, deleted in finally.",
  "tier": "small"
}
test-registration */
/**
 * Comms notification-resolution matrix tests (Task #3258).
 *
 * Tests the resolveEffectiveNotifDecision and contentMatchesKeywords
 * functions from shared/commsNotifResolution.ts, plus the
 * GET/PUT /api/comms/notification-settings routes against the shared dev DB.
 *
 * Isolation: user rows carry a per-run random token; they are deleted in a
 * finally block.  Route tests follow the inline-express pattern
 * (see comms-users-picker-route.test.ts for prior art).
 *
 * @regression
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import {
  resolveEffectiveNotifDecision,
  contentMatchesKeywords,
  type NotifResolutionInput,
} from "../shared/commsNotifResolution";
import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import { inArray } from "drizzle-orm";
import { registerCommsRoutes } from "../server/routes/comms";

const RUN = randomBytes(4).toString("hex");
const USER_ID = `notif-3258-${RUN}`;

let failures = 0;

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL  ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

// ─── Seed / cleanup ───────────────────────────────────────────────────────────

async function seedUser(): Promise<void> {
  await db.insert(users).values({
    id: USER_ID,
    email: `notif-3258-${RUN}@test.local`,
    firstName: "Notif",
    lastName: `Test-${RUN}`,
    role: "ceo",
  });
}

async function cleanupUser(): Promise<void> {
  await db.delete(users).where(inArray(users.id, [USER_ID]));
}

// ─── Express test app ─────────────────────────────────────────────────────────

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; requireAuth loads the real users row
    // (public schema, seeded above) so role gating reflects the DB.
    req.__test_clerkUserId = USER_ID;
    next();
  });
  registerCommsRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ─── Pure resolution-matrix tests ────────────────────────────────────────────

const base: NotifResolutionInput = {
  channelPref: null,
  globalDefault: "all",
  isDndActive: false,
  isMentionOrKeyword: false,
  isDmChannel: false,
};

async function runResolutionMatrixTests(): Promise<void> {
  console.log("\n-- resolveEffectiveNotifDecision matrix --");

  await step("DND + any pref + any global → suppress", () => {
    const cases: Array<Partial<NotifResolutionInput>> = [
      { isDndActive: true },
      { isDndActive: true, channelPref: "all", globalDefault: "all", isMentionOrKeyword: true },
      { isDndActive: true, channelPref: "mentions", globalDefault: "all", isMentionOrKeyword: true },
      { isDndActive: true, channelPref: "muted", globalDefault: "all" },
    ];
    for (const partial of cases) {
      assert.equal(
        resolveEffectiveNotifDecision({ ...base, ...partial }),
        "suppress",
        `Expected suppress for ${JSON.stringify(partial)}`,
      );
    }
  });

  await step("muted channel pref → suppress, no DND", () => {
    assert.equal(resolveEffectiveNotifDecision({ ...base, channelPref: "muted" }), "suppress");
    assert.equal(
      resolveEffectiveNotifDecision({ ...base, channelPref: "muted", globalDefault: "nothing" }),
      "suppress",
    );
    assert.equal(
      resolveEffectiveNotifDecision({ ...base, channelPref: "muted", isMentionOrKeyword: true }),
      "suppress",
    );
  });

  await step("channel pref=mentions, no mention/kw → quiet", () => {
    assert.equal(
      resolveEffectiveNotifDecision({ ...base, channelPref: "mentions", isMentionOrKeyword: false }),
      "quiet",
    );
  });

  await step("channel pref=mentions + mention/kw → notify", () => {
    assert.equal(
      resolveEffectiveNotifDecision({ ...base, channelPref: "mentions", isMentionOrKeyword: true }),
      "notify",
    );
  });

  await step("channel pref=all → notify regardless of mention flag", () => {
    assert.equal(
      resolveEffectiveNotifDecision({ ...base, channelPref: "all", isMentionOrKeyword: false }),
      "notify",
    );
    assert.equal(
      resolveEffectiveNotifDecision({ ...base, channelPref: "all", isMentionOrKeyword: true }),
      "notify",
    );
  });

  await step("no channel pref, global=nothing → suppress", () => {
    assert.equal(
      resolveEffectiveNotifDecision({ ...base, channelPref: null, globalDefault: "nothing" }),
      "suppress",
    );
  });

  await step("no channel pref, global=mentions, no mention/kw → quiet", () => {
    assert.equal(
      resolveEffectiveNotifDecision({
        ...base,
        channelPref: null,
        globalDefault: "mentions",
        isMentionOrKeyword: false,
      }),
      "quiet",
    );
  });

  await step("no channel pref, global=mentions + mention/kw → notify", () => {
    assert.equal(
      resolveEffectiveNotifDecision({
        ...base,
        channelPref: null,
        globalDefault: "mentions",
        isMentionOrKeyword: true,
      }),
      "notify",
    );
  });

  await step("no channel pref, global=all → notify", () => {
    assert.equal(
      resolveEffectiveNotifDecision({ ...base, channelPref: null, globalDefault: "all" }),
      "notify",
    );
  });

  await step("DM channel with no pref, global=nothing → treat as mention → notify", () => {
    assert.equal(
      resolveEffectiveNotifDecision({
        ...base,
        channelPref: null,
        globalDefault: "nothing",
        isDmChannel: true,
      }),
      "notify",
    );
  });

  await step("DM channel with no pref, global=mentions, no explicit mention → notify (DM=mention)", () => {
    assert.equal(
      resolveEffectiveNotifDecision({
        ...base,
        channelPref: null,
        globalDefault: "mentions",
        isDmChannel: true,
        isMentionOrKeyword: false,
      }),
      "notify",
    );
  });
}

// ─── Keyword matching tests ───────────────────────────────────────────────────

async function runKeywordMatchingTests(): Promise<void> {
  console.log("\n-- contentMatchesKeywords --");

  await step("exact word match is case-insensitive", () => {
    assert.equal(contentMatchesKeywords("Please review the Billing issue", ["billing"]), true);
    assert.equal(contentMatchesKeywords("BILLING is pending", ["billing"]), true);
  });

  await step("partial sub-string does NOT match (word-boundary)", () => {
    assert.equal(contentMatchesKeywords("rebilling the client", ["billing"]), false);
    assert.equal(contentMatchesKeywords("billingcycle starts now", ["billing"]), false);
  });

  await step("no keywords → false", () => {
    assert.equal(contentMatchesKeywords("billing is urgent", []), false);
  });

  await step("null/undefined content → false", () => {
    assert.equal(contentMatchesKeywords(null, ["billing"]), false);
    assert.equal(contentMatchesKeywords(undefined, ["billing"]), false);
  });

  await step("empty/whitespace keyword is ignored", () => {
    assert.equal(contentMatchesKeywords("billing", ["", "  "]), false);
  });

  await step("multi-word keyword matches when present", () => {
    assert.equal(
      contentMatchesKeywords("the case intake process needs review", ["case intake"]),
      true,
    );
  });

  await step("regex special chars in keyword are escaped", () => {
    assert.equal(contentMatchesKeywords("contact john.smith today", ["john.smith"]), true);
    assert.equal(contentMatchesKeywords("contact johnasmith today", ["john.smith"]), false);
  });
}

// ─── API route smoke tests ────────────────────────────────────────────────────

async function runApiRouteTests(): Promise<void> {
  console.log("\n-- GET/PUT /api/comms/notification-settings --");

  await withApp(async (baseUrl) => {
    await step("GET returns 200 with defaults when no row exists", async () => {
      const res = await fetch(`${baseUrl}/api/comms/notification-settings`);
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
      const body = await res.json() as any;
      assert.equal(body.globalDefault, "all");
      assert.equal(body.soundEnabled, true);
      assert.equal(body.desktopEnabled, false);
      assert.ok(Array.isArray(body.keywords), "keywords should be array");
      assert.equal(body.keywords.length, 0, "keywords should be empty");
    });

    await step("PUT upserts and returns new settings", async () => {
      const res = await fetch(`${baseUrl}/api/comms/notification-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          globalDefault: "mentions",
          soundEnabled: false,
          keywords: ["billing", "settlement"],
        }),
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
      const body = await res.json() as any;
      assert.equal(body.globalDefault, "mentions");
      assert.equal(body.soundEnabled, false);
      assert.ok(Array.isArray(body.keywords), "keywords should be array");
      assert.ok(body.keywords.includes("billing"), "billing keyword present");
      assert.ok(body.keywords.includes("settlement"), "settlement keyword present");
    });

    await step("GET returns the previously persisted settings", async () => {
      const res = await fetch(`${baseUrl}/api/comms/notification-settings`);
      assert.equal(res.status, 200, `expected 200 on re-read, got ${res.status}`);
      const body = await res.json() as any;
      assert.equal(body.globalDefault, "mentions", "should reflect PUT");
      assert.equal(body.soundEnabled, false, "should reflect PUT");
    });

    await step("PUT rejects invalid globalDefault with 400", async () => {
      const res = await fetch(`${baseUrl}/api/comms/notification-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ globalDefault: "invalid_value" }),
      });
      assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("comms-notification-resolution: Task #3258");

  await runResolutionMatrixTests();
  await runKeywordMatchingTests();

  await seedUser();
  try {
    await runApiRouteTests();
  } finally {
    await cleanupUser();
  }

  await undici.getGlobalDispatcher().close();
  await closeDbPools();

  if (failures > 0) {
    console.error(`\n${failures} step(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\ncomms-notification-resolution: all steps passed");
  }
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
  try {
    await cleanupUser();
    await undici.getGlobalDispatcher().close();
    await closeDbPools();
  } catch {}
});
