/* test-registration
{
  "name": "Comms link previews — SSRF unfurl service, upsert/patch storage, @channel/@here mention badge (Task #3255)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3255: link previews (SSRF unfurl service, storage upsert/patch, @channel/@here mention-badge feed-through). DB-backed, run-token isolated.",
  "tier": "small"
}
test-registration */
/**
 * Comms link-preview smoke tests (Task #3255).
 *
 * Coverage:
 *  – extractUrls: parses http/https URLs out of message text
 *  – unfurlUrl: returns a structured UnfurlResult (mocked fetch, no SSRF)
 *  – SSRF guardrail: RFC-1918 / loopback / link-local addresses are rejected
 *  – upsertLinkPreview: writes + retrieves from comms_link_previews via ON CONFLICT
 *  – setMessageLinkPreviews: patches message metadata JSONB in-place
 *  – getUnreadSummaryForUser: @channel and @here bump the mentionCount badge
 *
 * Isolation: run-token-suffixed rows in the shared dev DB; deleted in finally.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { users } from "@shared/schema";
import {
  commsChannels,
  commsChannelMembers,
  commsMessages,
  commsLinkPreviews,
} from "../shared/models/comms";
import { eq, and, gt } from "drizzle-orm";
import { extractUrls, unfurlUrl, sanitizeAssetUrl } from "../server/services/commsUnfurl";
import * as commsStorage from "../server/storage/commsStorage";

const RUN = randomBytes(4).toString("hex");
const USER_A = `lp3255-a-${RUN}`;
const USER_B = `lp3255-b-${RUN}`;

let channelId = "";
let msgId = "";

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

async function seed(): Promise<void> {
  await db.insert(users).values([
    { id: USER_A, email: `lp-a-${RUN}@x.test`, firstName: "LPA", lastName: "Test", role: "account_manager" },
    { id: USER_B, email: `lp-b-${RUN}@x.test`, firstName: "LPB", lastName: "Test", role: "account_manager" },
  ]);

  const [ch] = await db
    .insert(commsChannels)
    .values({ name: `lp-test-${RUN}`, type: "public" })
    .returning();
  channelId = ch.id;

  await db.insert(commsChannelMembers).values([
    { channelId, userId: USER_A },
    { channelId, userId: USER_B },
  ]);

  const [msg] = await db
    .insert(commsMessages)
    .values({ channelId, userId: USER_A, content: "check https://example.com", contentType: "text", metadata: {} })
    .returning();
  msgId = msg.id;
}

async function cleanup(): Promise<void> {
  // commsMessages rows are cascade-deleted with channel; delete link_preview by url
  await db.delete(commsLinkPreviews).where(eq(commsLinkPreviews.url, `https://lp-test-${RUN}.example`)).catch(() => {});
  await db.delete(commsMessages).where(eq(commsMessages.channelId, channelId)).catch(() => {});
  await db.delete(commsChannelMembers).where(eq(commsChannelMembers.channelId, channelId)).catch(() => {});
  await db.delete(commsChannels).where(eq(commsChannels.id, channelId)).catch(() => {});
  await db.delete(users).where(eq(users.id, USER_A)).catch(() => {});
  await db.delete(users).where(eq(users.id, USER_B)).catch(() => {});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("=== Comms link previews (Task #3255) ===");

await seed();

try {

  await step("extractUrls: finds http and https URLs", async () => {
    const urls = extractUrls("Visit https://example.com and http://foo.bar/page?q=1 today");
    // URLs may be normalized (trailing slash added for root paths)
    assert.ok(
      urls.some((u) => u.startsWith("https://example.com")),
      `missing https url — got: ${urls.join(", ")}`,
    );
    assert.ok(
      urls.some((u) => u.startsWith("http://foo.bar/page")),
      `missing http url — got: ${urls.join(", ")}`,
    );
    assert.equal(urls.length, 2, "should find exactly 2 URLs");
  });

  await step("extractUrls: deduplicates repeated URLs", async () => {
    const urls = extractUrls("https://x.com and https://x.com again");
    assert.equal(urls.length, 1, "should deduplicate");
    // Accept either normalized (trailing slash) or exact form
    assert.ok(
      urls[0] === "https://x.com" || urls[0] === "https://x.com/",
      `expected https://x.com[/], got: ${urls[0]}`,
    );
  });

  await step("extractUrls: ignores non-URL text", async () => {
    const urls = extractUrls("no links here");
    assert.equal(urls.length, 0);
  });

  await step("unfurlUrl: rejects RFC-1918 addresses (SSRF guard)", async () => {
    const result = await unfurlUrl("http://192.168.1.1/admin");
    assert.ok(result.error, `expected error but got: ${JSON.stringify(result)}`);
    assert.ok(
      /blocked|private|SSRF/i.test(result.error!),
      `unexpected error message: ${result.error}`,
    );
  });

  await step("unfurlUrl: rejects loopback address", async () => {
    const result = await unfurlUrl("http://127.0.0.1:8080/secret");
    assert.ok(result.error, "expected SSRF error for loopback");
  });

  await step("unfurlUrl: rejects 10.x.x.x private range", async () => {
    const result = await unfurlUrl("http://10.0.0.1/internal");
    assert.ok(result.error, "expected SSRF error for 10.x");
  });

  await step("unfurlUrl: rejects link-local 169.254.x.x", async () => {
    const result = await unfurlUrl("http://169.254.169.254/metadata");
    assert.ok(result.error, "expected SSRF error for link-local");
  });

  await step("sanitizeAssetUrl: rejects http (non-https) asset URLs", async () => {
    assert.equal(await sanitizeAssetUrl("http://example.com/og.png"), null);
  });

  await step("sanitizeAssetUrl: rejects private-IP og:image hosts", async () => {
    assert.equal(await sanitizeAssetUrl("https://10.0.0.5/pixel.png"), null);
    assert.equal(await sanitizeAssetUrl("https://192.168.1.1/img.png"), null);
    assert.equal(await sanitizeAssetUrl("https://169.254.169.254/latest/meta"), null);
    assert.equal(await sanitizeAssetUrl("https://127.0.0.1/x.png"), null);
    assert.equal(await sanitizeAssetUrl("https://localhost/x.png"), null);
  });

  await step("sanitizeAssetUrl: rejects malformed and credentialed URLs", async () => {
    assert.equal(await sanitizeAssetUrl("not-a-url"), null);
    assert.equal(await sanitizeAssetUrl(null), null);
    assert.equal(await sanitizeAssetUrl("https://user:pass@example.com/x.png"), null);
    assert.equal(await sanitizeAssetUrl("javascript:alert(1)"), null);
    assert.equal(await sanitizeAssetUrl("data:image/png;base64,AAAA"), null);
  });

  await step("sanitizeAssetUrl: allows https URLs on public addresses", async () => {
    // Literal public IP avoids DNS dependence in the allow-path assertion.
    const ok = await sanitizeAssetUrl("https://93.184.216.34/og.png");
    assert.equal(ok, "https://93.184.216.34/og.png");
  });

  await step("unfurlUrl: nulls out internal-IP og:image / favicon end-to-end", async () => {
    const html = `<html><head>
      <title>Evil Page</title>
      <meta property="og:title" content="Evil Page" />
      <meta property="og:image" content="https://10.0.0.5/pixel.png" />
      <link rel="icon" href="http://192.168.1.1/fav.ico" />
    </head><body></body></html>`;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as typeof fetch;
    try {
      // Public literal IP so the page-level SSRF host check passes without DNS.
      const result = await unfurlUrl("https://93.184.216.34/evil-page");
      assert.equal(result.error, null, `unexpected error: ${result.error}`);
      assert.equal(result.title, "Evil Page");
      assert.equal(result.imageUrl, null, "private-IP og:image must be nulled");
      assert.equal(result.faviconUrl, null, "non-https/private favicon must be nulled");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await step("upsertLinkPreview: inserts a preview row", async () => {
    const testUrl = `https://lp-test-${RUN}.example`;
    const row = await commsStorage.upsertLinkPreview({
      url: testUrl,
      title: "Test Title",
      description: "A test description",
      imageUrl: "https://img.example/og.png",
      siteName: "Example",
      faviconUrl: "https://img.example/fav.ico",
      error: null,
      fetchedAt: new Date(),
    });
    assert.equal(row.url, testUrl);
    assert.equal(row.title, "Test Title");
    assert.ok(row.id, "should have an id");
  });

  await step("upsertLinkPreview: ON CONFLICT updates existing row", async () => {
    const testUrl = `https://lp-test-${RUN}.example`;
    const updated = await commsStorage.upsertLinkPreview({
      url: testUrl,
      title: "Updated Title",
      description: "Updated description",
      imageUrl: null,
      siteName: null,
      faviconUrl: null,
      error: null,
      fetchedAt: new Date(),
    });
    assert.equal(updated.title, "Updated Title", "should have updated title");
    assert.equal(updated.url, testUrl);
  });

  await step("getLinkPreviewByUrl: retrieves the upserted row", async () => {
    const testUrl = `https://lp-test-${RUN}.example`;
    const row = await commsStorage.getLinkPreviewByUrl(testUrl);
    assert.ok(row, "expected a row");
    assert.equal(row!.title, "Updated Title");
  });

  await step("setMessageLinkPreviews: patches message metadata JSONB", async () => {
    const previews = [
      {
        url: "https://example.com",
        title: "Example Site",
        description: "An example",
        imageUrl: null,
        siteName: "Example",
        faviconUrl: null,
      },
    ];
    await commsStorage.setMessageLinkPreviews(msgId, previews);
    // Verify the metadata was written
    const [row] = await db
      .select()
      .from(commsMessages)
      .where(eq(commsMessages.id, msgId));
    const meta = row.metadata as any;
    assert.ok(Array.isArray(meta?.linkPreviews), "linkPreviews should be an array");
    assert.equal(meta.linkPreviews.length, 1);
    assert.equal(meta.linkPreviews[0].title, "Example Site");
    assert.equal(meta.linkPreviews[0].url, "https://example.com");
  });

  await step("setMessageLinkPreviews: preserves existing metadata keys", async () => {
    // Seed a message with existing metadata
    const [msgWithMeta] = await db
      .insert(commsMessages)
      .values({
        channelId,
        userId: USER_A,
        content: "msg with metadata",
        contentType: "text",
        metadata: { existingKey: "existingValue" } as any,
      })
      .returning();
    await commsStorage.setMessageLinkPreviews(msgWithMeta.id, [
      { url: "https://x.com", title: "X", description: null, imageUrl: null, siteName: null, faviconUrl: null },
    ]);
    const [updated] = await db.select().from(commsMessages).where(eq(commsMessages.id, msgWithMeta.id));
    const meta = updated.metadata as any;
    assert.equal(meta.existingKey, "existingValue", "existing key must be preserved");
    assert.ok(Array.isArray(meta.linkPreviews), "linkPreviews should also be present");
    // cleanup
    await db.delete(commsMessages).where(eq(commsMessages.id, msgWithMeta.id)).catch(() => {});
  });

  await step("getUnreadSummaryForUser: @channel bumps mentionCount", async () => {
    const [channelMsg] = await db
      .insert(commsMessages)
      .values({
        channelId,
        userId: USER_A,
        content: "hey @channel please read this",
        contentType: "text",
        metadata: {} as any,
      })
      .returning();

    const summary = await commsStorage.getUnreadSummaryForUser(USER_B, [channelId]);
    const entry = summary.get(channelId);
    assert.ok(entry, "should have an unread entry for the channel");
    assert.ok(entry!.mentionCount >= 1, `expected mentionCount ≥ 1, got ${entry!.mentionCount}`);

    // cleanup
    await db.delete(commsMessages).where(eq(commsMessages.id, channelMsg.id)).catch(() => {});
  });

  await step("getUnreadSummaryForUser: @here bumps mentionCount", async () => {
    const [hereMsg] = await db
      .insert(commsMessages)
      .values({
        channelId,
        userId: USER_A,
        content: "hey @here anyone online?",
        contentType: "text",
        metadata: {} as any,
      })
      .returning();

    const summary = await commsStorage.getUnreadSummaryForUser(USER_B, [channelId]);
    const entry = summary.get(channelId);
    assert.ok(entry, "should have an unread entry for the channel");
    assert.ok(entry!.mentionCount >= 1, `expected mentionCount ≥ 1, got ${entry!.mentionCount}`);

    // cleanup
    await db.delete(commsMessages).where(eq(commsMessages.id, hereMsg.id)).catch(() => {});
  });

} finally {
  await cleanup();
  await closeDbPools();
}

const status = failures === 0 ? "PASSED" : "FAILED";
console.log(`\nAll comms link-preview tests ${status} (${failures} failure(s))`);
if (failures > 0) process.exit(1);
