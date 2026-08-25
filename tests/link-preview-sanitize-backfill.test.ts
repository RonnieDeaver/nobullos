/* test-registration
{
  "name": "Link-preview sanitize backfill — static-bad SQL counters, chunked NULLing of failing asset URLs on both surfaces, metadata preservation, idempotent re-run, prod-action registration (Task #3413)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "tier": "small"
}
test-registration */
/**
 * Task #3413 — sanitize previously saved link-preview asset URLs.
 *
 * Covers the db-injected backfill core the `sanitize_saved_link_preview_assets`
 * prod-action drives:
 *  – countStaticallyBadLinkPreviewRows: SQL regex counts non-https / literal
 *    private-IP asset URLs in comms_link_previews
 *  – countStaticallyBadMessagePreviewRows: same over
 *    comms_messages.metadata.linkPreviews payloads
 *  – sanitizeLinkPreviewRowsChunk: NULLs failing image_url/favicon_url,
 *    keeps passing ones, idempotent on re-run (still-equals guarded)
 *  – sanitizeMessagePreviewsChunk: rewrites only the linkPreviews key
 *    (other metadata preserved), nulls failing per-preview URLs, idempotent
 *
 * DB-backed against the shared dev DB; every row is suffixed with a per-run
 * random token and deleted in finally (memory "Route-test public.* collision").
 * The sanitize function is injected as a stub — no real DNS in the test.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, closeDbPools } from "../server/db";
import {
  countStaticallyBadLinkPreviewRows,
  countStaticallyBadMessagePreviewRows,
  sanitizeLinkPreviewRowsChunk,
  sanitizeMessagePreviewsChunk,
  type SanitizeFn,
} from "../server/services/linkPreviewSanitizeBackfill";

const RUN = randomBytes(6).toString("hex");

let passed = 0;
let failed = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e?.message ?? e}`);
  }
}

// Sanitize stub mirroring the real policy without DNS: reject non-https,
// literal private hosts, and one marker hostname standing in for a
// "public-looking hostname that resolves to a private IP".
const stubSanitize: SanitizeFn = async (raw) => {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) return null;
  if (u.hostname === `dns-private-${RUN}.example`) return null;
  return u.href;
};

const previewUrls = {
  badHttp: `https://lpsb-${RUN}-a.example`,
  badPrivate: `https://lpsb-${RUN}-b.example`,
  dnsOnly: `https://lpsb-${RUN}-c.example`,
  clean: `https://lpsb-${RUN}-d.example`,
};

async function main() {
  const db = getDb();
  let channelId: string | null = null;
  let messageId: string | null = null;
  try {
    // ── Seed comms_link_previews rows ────────────────────────────────────
    await db.execute(sql`
      INSERT INTO comms_link_previews (url, image_url, favicon_url)
      VALUES
        (${previewUrls.badHttp}, ${"http://cdn.example/og.png"}, ${"https://ok.example/fav.ico"}),
        (${previewUrls.badPrivate}, ${"https://192.168.1.10/og.png"}, NULL),
        (${previewUrls.dnsOnly}, ${`https://dns-private-${RUN}.example/og.png`}, NULL),
        (${previewUrls.clean}, ${"https://ok.example/og.png"}, ${"https://ok.example/fav.ico"})
    `);

    await step("static counter counts non-https + literal private-IP preview rows", async () => {
      const n = await countStaticallyBadLinkPreviewRows(db);
      // badHttp (http image) + badPrivate (literal 192.168 host). The
      // dnsOnly row looks clean statically; the clean row never counts.
      assert.ok(n >= 2, `expected >=2 statically-bad rows, got ${n}`);
    });

    await step("preview chunk NULLs failing URLs, keeps passing ones", async () => {
      let cursor: string | null = null;
      // Walk the whole table in chunks (shared dev DB may hold other rows).
      for (let i = 0; i < 1000; i++) {
        const r = await sanitizeLinkPreviewRowsChunk(db, cursor, 200, stubSanitize);
        if (r.nextCursor === null) break;
        cursor = r.nextCursor;
      }
      const res = await db.execute(sql`
        SELECT url, image_url, favicon_url FROM comms_link_previews
        WHERE url LIKE ${`https://lpsb-${RUN}-%`} ORDER BY url
      `);
      const rows = (res as any).rows as any[];
      const byUrl = new Map(rows.map((r) => [r.url, r]));
      assert.equal(byUrl.get(previewUrls.badHttp)?.image_url, null, "http image nulled");
      assert.equal(
        byUrl.get(previewUrls.badHttp)?.favicon_url,
        "https://ok.example/fav.ico",
        "passing favicon kept",
      );
      assert.equal(byUrl.get(previewUrls.badPrivate)?.image_url, null, "private-IP image nulled");
      assert.equal(byUrl.get(previewUrls.dnsOnly)?.image_url, null, "DNS-only-private image nulled");
      assert.equal(byUrl.get(previewUrls.clean)?.image_url, "https://ok.example/og.png", "clean image untouched");
    });

    await step("preview chunk is idempotent on re-run", async () => {
      let cursor: string | null = null;
      let cleaned = 0;
      for (let i = 0; i < 1000; i++) {
        const r = await sanitizeLinkPreviewRowsChunk(db, cursor, 200, stubSanitize);
        cleaned += r.cleaned;
        if (r.nextCursor === null) break;
        cursor = r.nextCursor;
      }
      // Our four rows are already clean; other dev-DB rows (written post-fix)
      // should also pass the stub except unrelated test residue, so assert on
      // OUR rows only via a fresh read.
      const res = await db.execute(sql`
        SELECT image_url, favicon_url FROM comms_link_previews
        WHERE url = ${previewUrls.badHttp}
      `);
      const row = (res as any).rows[0];
      assert.equal(row.image_url, null);
      assert.equal(row.favicon_url, "https://ok.example/fav.ico");
      void cleaned;
    });

    // ── Seed a channel + message with metadata.linkPreviews ─────────────
    const chRes = await db.execute(sql`
      INSERT INTO comms_channels (name, type, created_by)
      VALUES (${`lpsb-test-${RUN}`}, 'channel', NULL)
      RETURNING id
    `);
    channelId = String((chRes as any).rows[0].id);
    const previews = [
      {
        url: previewUrls.badHttp,
        title: "t",
        description: null,
        imageUrl: "http://cdn.example/og.png",
        siteName: null,
        faviconUrl: "https://ok.example/fav.ico",
      },
      {
        url: previewUrls.clean,
        title: "t2",
        description: null,
        imageUrl: "https://ok.example/og.png",
        siteName: null,
        faviconUrl: null,
      },
    ];
    const msgRes = await db.execute(sql`
      INSERT INTO comms_messages (channel_id, content, metadata)
      VALUES (${channelId}, ${"link test"}, ${JSON.stringify({ keepMe: `yes-${RUN}`, linkPreviews: previews })}::jsonb)
      RETURNING id
    `);
    messageId = String((msgRes as any).rows[0].id);

    await step("static counter counts message rows with bad preview payloads", async () => {
      const n = await countStaticallyBadMessagePreviewRows(db);
      assert.ok(n >= 1, `expected >=1 statically-bad message rows, got ${n}`);
    });

    await step("message chunk nulls failing preview URLs, preserves other metadata", async () => {
      let cursor: string | null = null;
      for (let i = 0; i < 1000; i++) {
        const r = await sanitizeMessagePreviewsChunk(db, cursor, 200, stubSanitize);
        if (r.nextCursor === null) break;
        cursor = r.nextCursor;
      }
      const res = await db.execute(sql`
        SELECT metadata FROM comms_messages WHERE id = ${messageId}
      `);
      const meta = (res as any).rows[0].metadata;
      assert.equal(meta.keepMe, `yes-${RUN}`, "sibling metadata key preserved");
      const lp = meta.linkPreviews as any[];
      assert.equal(lp.length, 2);
      assert.equal(lp[0].imageUrl, null, "http imageUrl nulled");
      assert.equal(lp[0].faviconUrl, "https://ok.example/fav.ico", "passing faviconUrl kept");
      assert.equal(lp[0].title, "t", "other preview fields untouched");
      assert.equal(lp[1].imageUrl, "https://ok.example/og.png", "clean preview untouched");
    });

    await step("message chunk is idempotent (no rewrite on second pass)", async () => {
      const before = await db.execute(sql`
        SELECT metadata FROM comms_messages WHERE id = ${messageId}
      `);
      let cursor: string | null = null;
      for (let i = 0; i < 1000; i++) {
        const r = await sanitizeMessagePreviewsChunk(db, cursor, 200, stubSanitize);
        if (r.nextCursor === null) break;
        cursor = r.nextCursor;
      }
      const after = await db.execute(sql`
        SELECT metadata FROM comms_messages WHERE id = ${messageId}
      `);
      assert.deepEqual((after as any).rows[0].metadata, (before as any).rows[0].metadata);
    });

    await step("registry exposes the prod-action with drain semantics", async () => {
      const { PROD_ACTIONS } = await import("../server/services/prodActionsRegistry");
      const action = PROD_ACTIONS.find((a) => a.id === "sanitize_saved_link_preview_assets");
      assert.ok(action, "action registered");
      assert.match(action!.description, /sanitizeAssetUrl/);
      assert.match(action!.description, /link_preview_sanitize_backfill_done_v1/);
    });
  } finally {
    try {
      await db.execute(sql`
        DELETE FROM comms_link_previews WHERE url LIKE ${`https://lpsb-${RUN}-%`}
      `);
      if (messageId) {
        await db.execute(sql`DELETE FROM comms_messages WHERE id = ${messageId}`);
      }
      if (channelId) {
        await db.execute(sql`DELETE FROM comms_channels WHERE id = ${channelId}`);
      }
    } catch (e: any) {
      console.error(`[cleanup] ${e?.message ?? e}`);
    }
    await closeDbPools().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
