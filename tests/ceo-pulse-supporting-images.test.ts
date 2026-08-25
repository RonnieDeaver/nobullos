/* test-registration
{
  "name": "CEO Pulse (The NoBull Brief) supporting images (Task #4293) — upload magic-byte/size/cap validation, caption+reorder permutation PATCH, delete, public serving gate (anon-unpublished 404 / CEO draft bypass), {{image-N}} placeholder resolution and the share payload",
  "regression": true,
  "sweepOnlyReason": "DB-bound route suite (isolated-schema Postgres tables + a real HTTP server per run); belongs in the full suite and the nightly --regression sweep, not the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
/**
 * Task #4293 — uploaded supporting images for update briefs. These endpoints
 * are the ONLY writers of ceo_pulses.supporting_images (the sibling
 * ceo-pulse-patch-validation suite pins the generic PATCH/POST exclusion).
 * This suite pins the endpoint contracts end to end against an isolated
 * schema, with object storage replaced by an in-memory fake (the
 * ceoPulseImageObjects mutable-singleton seam — established vendor-seam
 * pattern, no ESM resolve hooks):
 *
 *   (1) Upload accepts JPEG/PNG/WebP by MAGIC BYTES (sniffed format decides
 *       the stored extension — "jpeg" → "jpg" — never mimetype/filename),
 *       allocates stable max+1 slots, persists metadata, writes the object.
 *   (2) Upload rejections: wrong content (PDF bytes named .png), sniffable
 *       but non-whitelisted image (GIF), oversize (multer cap → clean 400),
 *       missing file, unknown pulse 404, non-CEO 403 — all with zero
 *       metadata/object writes.
 *   (3) Per-brief count cap: the (max+1)th upload → 400, row stays at cap.
 *   (4) Caption/reorder PATCH: body must be EXACTLY the current slot set
 *       (permutation); ext is re-derived from stored metadata (strict schema
 *       rejects client `ext`); caption null clears / omitted preserves;
 *       invalid shapes → 400 with no write.
 *   (5) DELETE: metadata-first removal + object delete; other entries keep
 *       order/captions; missing slot 404; freed highest slot number is
 *       reused (max+1 semantics), non-highest is not.
 *   (6) Serving GET /api/ceo-pulse-charts/:monthKey/image-:slot — published
 *       ⇒ anonymous 200 with the metadata-derived content type; unpublished
 *       ⇒ anonymous/non-CEO 404 (no existence leak), authenticated CEO 200
 *       (Studio draft preview); strict param validation; metadata-present/
 *       object-missing ⇒ 404.
 *   (7) resolveImagePlaceholders: resolves {{image-<slot>}} to <figure> with
 *       escaped captions, ALWAYS strips unknown slots, no-placeholder fast
 *       path returns the input string unchanged.
 *   (8) Share payload: ordered supportingImages [{slot,url,caption}] with
 *       extension-less URLs; letter HTML resolves known slots and strips
 *       removed ones (never a broken tag).
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { registerReportRoutes } from "../server/routes/reports";
import {
  ceoPulseImageObjects,
  getCeoPulseImageUrl,
  resolveImagePlaceholders,
} from "../server/services/ceoPulseSupportingImages";
import type { CeoPulseSupportingImage } from "../shared/models/reports";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const CEO_ID = "test-ceo-pulse-images-ceo";
const AM_ID = "test-ceo-pulse-images-am";
const TAG = "task-4293-images";

// ── In-memory object-store fake (monkey-patches the mutable singleton) ──────
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const fakeStore = new Map<string, { ext: string; bytes: Buffer }>();
function fakeKey(monthKey: string, slot: number, ext: string): string {
  return `${monthKey}/image-${slot}.${ext}`;
}
ceoPulseImageObjects.save = async (monthKey, slot, ext, bytes) => {
  fakeStore.set(fakeKey(monthKey, slot, ext), { ext, bytes: Buffer.from(bytes) });
};
ceoPulseImageObjects.delete = async (monthKey, slot, ext) => {
  fakeStore.delete(fakeKey(monthKey, slot, ext));
};
ceoPulseImageObjects.serve = async (monthKey, slot, ext, res) => {
  const hit = fakeStore.get(fakeKey(monthKey, slot, ext));
  if (!hit) return false;
  res.setHeader("Content-Type", CONTENT_TYPE_BY_EXT[hit.ext] ?? "application/octet-stream");
  res.end(hit.bytes);
  return true;
};

// ── Magic-byte fixtures (sniffUploadFormat signatures) ──────────────────────
function pngBytes(pad = 64): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(pad, 7)]);
}
function jpegBytes(pad = 64): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(pad, 7)]);
}
function webpBytes(pad = 64): Buffer {
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0x00, 0x00, 0x00]), Buffer.from("WEBP"), Buffer.alloc(pad, 7)]);
}
function gifBytes(pad = 64): Buffer {
  return Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(pad, 7)]);
}
function pdfBytes(pad = 64): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(pad, 7)]);
}

// ── Harness ──────────────────────────────────────────────────────────────────
// Clerk test seam (server/middlewares/requireAuth.ts): `x-test-anon` ⇒
// null (genuinely unauthenticated → 401/404 on the public serving route);
// otherwise `x-test-user` (default CEO) is the acting identity. Both users
// are pre-registered via __test_markUserReconciled after seeding, since the
// isolated-schema seed is invisible to requireAuth's public-schema lookup.
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.headers["x-test-anon"]) {
      (req as any).__test_clerkUserId = null;
      next();
      return;
    }
    const sub = (req.headers["x-test-user"] as string) || CEO_ID;
    (req as any).__test_clerkUserId = sub;
    next();
  });
  registerReportRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function parseResponse(r: globalThis.Response): Promise<{ status: number; body: any }> {
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

/** Hand-rolled multipart body — no form-data dependency needed. */
function multipart(filename: string, contentType: string, data: Buffer): { body: Buffer; header: string } {
  const boundary = `----test4293${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, data, tail]), header: `multipart/form-data; boundary=${boundary}` };
}

async function uploadImage(
  baseUrl: string,
  pulseId: string,
  file: { name: string; type: string; data: Buffer },
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const { body, header } = multipart(file.name, file.type, file.data);
  const r = await fetch(`${baseUrl}/api/ceo-pulses/${pulseId}/images`, {
    method: "POST",
    headers: { "Content-Type": header, ...headers },
    body,
  });
  return parseResponse(r);
}

async function patchImages(
  baseUrl: string,
  pulseId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/ceo-pulses/${pulseId}/images`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return parseResponse(r);
}

async function deleteImage(
  baseUrl: string,
  pulseId: string,
  slot: number | string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/ceo-pulses/${pulseId}/images/${slot}`, {
    method: "DELETE",
    headers,
  });
  return parseResponse(r);
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES
          (${CEO_ID}, 'ceo', 'ceo', ${`${TAG}-ceo`}),
          (${AM_ID}, 'account_manager', 'account_manager', ${`${TAG}-am`})
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);

      // Isolated-schema seed is uncommitted & invisible to requireAuth's
      // ambient public-schema db lookup — pre-register both profiles so the
      // middleware uses them directly (role gating stays real: AM → 403).
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo" });
      __test_markUserReconciled(AM_ID, { id: AM_ID, role: "account_manager" });

      let seedCounter = 0;
      async function seedPulse(overrides: {
        published?: boolean;
        fullLetterHtml?: string | null;
        images?: CeoPulseSupportingImage[] | null;
      } = {}): Promise<{ id: string; monthKey: string; shareToken: string }> {
        seedCounter++;
        const monthKey = `20${String(40 + seedCounter)}-0${(seedCounter % 9) + 1}`;
        const shareToken = `${TAG}-token-${seedCounter}`;
        const res: any = await isoDb.execute(sql`
          INSERT INTO ceo_pulses
            (month_key, title, raw_content, include_graphs, is_published, share_token, created_by, ai_analysis, full_letter_html, edition, supporting_images)
          VALUES (
            ${monthKey},
            ${"Images pulse " + monthKey},
            ${"Raw content for " + monthKey},
            false,
            ${overrides.published ?? false},
            ${shareToken},
            ${CEO_ID},
            ${JSON.stringify({ headline: "Update brief", keyTakeaways: ["t1"] })}::jsonb,
            ${overrides.fullLetterHtml ?? null},
            'company_update',
            ${overrides.images === undefined || overrides.images === null ? null : JSON.stringify(overrides.images)}::jsonb
          )
          RETURNING id
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        // Seeded images must also exist in the fake object store so the
        // serving route can stream them (metadata and objects move together).
        for (const img of overrides.images ?? []) {
          fakeStore.set(fakeKey(monthKey, img.slot, img.ext), { ext: img.ext, bytes: pngBytes(8) });
        }
        return { id: String(rows[0].id), monthKey, shareToken };
      }

      async function readImages(pulseId: string): Promise<any> {
        const res: any = await isoDb.execute(sql`
          SELECT supporting_images FROM ceo_pulses WHERE id = ${pulseId}
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return rows[0]?.supporting_images ?? null;
      }

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        // ── (1) Upload accepts by magic bytes; slots are stable max+1 ──────
        {
          const pulse = await seedPulse();

          const r1 = await uploadImage(baseUrl, pulse.id, { name: "cover.png", type: "image/png", data: pngBytes() });
          assert.equal(r1.status, 201, `png upload → 201 (got ${JSON.stringify(r1.body)})`);
          assert.equal(r1.body.slot, 1, "first upload takes slot 1");
          assert.equal(r1.body.supportingImages.length, 1);
          assert.equal(r1.body.supportingImages[0].ext, "png", "sniffed png stored as ext png");

          // JPEG bytes deliberately named .png with a lying mimetype — the
          // sniffed format wins and maps "jpeg" → "jpg".
          const r2 = await uploadImage(baseUrl, pulse.id, { name: "actually-jpeg.png", type: "image/png", data: jpegBytes() });
          assert.equal(r2.status, 201, "jpeg upload → 201");
          assert.equal(r2.body.slot, 2, "second upload takes slot 2");
          assert.equal(r2.body.supportingImages[1].ext, "jpg", "sniffed jpeg stored as ext jpg (not filename's png)");

          const r3 = await uploadImage(baseUrl, pulse.id, { name: "photo.webp", type: "image/webp", data: webpBytes() });
          assert.equal(r3.status, 201, "webp upload → 201");
          assert.equal(r3.body.slot, 3, "third upload takes slot 3");
          assert.equal(r3.body.supportingImages[2].ext, "webp");

          const stored = await readImages(pulse.id);
          assert.deepEqual(
            stored.map((i: any) => ({ slot: i.slot, ext: i.ext })),
            [{ slot: 1, ext: "png" }, { slot: 2, ext: "jpg" }, { slot: 3, ext: "webp" }],
            "metadata persisted in upload order with sniffed extensions",
          );
          assert.ok(fakeStore.has(fakeKey(pulse.monthKey, 1, "png")), "png object written under slot key");
          assert.ok(fakeStore.has(fakeKey(pulse.monthKey, 2, "jpg")), "jpg object written under sniffed ext");
          assert.ok(fakeStore.has(fakeKey(pulse.monthKey, 3, "webp")), "webp object written");
          console.log("  ok  (1) uploads accepted by magic bytes; stable max+1 slots; ext from sniffed format");
        }

        // ── (2) Upload rejections — zero writes ────────────────────────────
        {
          const pulse = await seedPulse();
          const storeSizeBefore = fakeStore.size;

          const rPdf = await uploadImage(baseUrl, pulse.id, { name: "sneaky.png", type: "image/png", data: pdfBytes() });
          assert.equal(rPdf.status, 400, "PDF bytes named .png → 400");
          assert.match(String(rPdf.body.error), /Unsupported image content/i, "rejection names the content check");

          const rGif = await uploadImage(baseUrl, pulse.id, { name: "anim.gif", type: "image/png", data: gifBytes() });
          assert.equal(rGif.status, 400, "GIF (sniffable but not whitelisted) → 400");

          const rBig = await uploadImage(baseUrl, pulse.id, {
            name: "huge.png",
            type: "image/png",
            data: Buffer.concat([pngBytes(0), Buffer.alloc(5 * 1024 * 1024, 1)]),
          });
          assert.equal(rBig.status, 400, "oversize upload → clean 400 (multer LIMIT_FILE_SIZE wrapped)");
          assert.match(String(rBig.body.error), /5 MB/i, "oversize rejection names the cap");

          const rNoFile = await fetch(`${baseUrl}/api/ceo-pulses/${pulse.id}/images`, { method: "POST" }).then(parseResponse);
          assert.equal(rNoFile.status, 400, "no multipart file → 400");

          const rBadMime = await uploadImage(baseUrl, pulse.id, { name: "note.txt", type: "text/plain", data: pngBytes() });
          assert.equal(rBadMime.status, 400, "advisory mimetype filter rejects text/plain envelope");

          const r404 = await uploadImage(baseUrl, "00000000-0000-4000-8000-000000000000", { name: "a.png", type: "image/png", data: pngBytes() });
          assert.equal(r404.status, 404, "unknown pulse → 404");

          const r403 = await uploadImage(baseUrl, pulse.id, { name: "a.png", type: "image/png", data: pngBytes() }, { "x-test-user": AM_ID });
          assert.equal(r403.status, 403, "non-CEO → 403");

          assert.equal(await readImages(pulse.id), null, "no metadata written by any rejection");
          assert.equal(fakeStore.size, storeSizeBefore, "no objects written by any rejection");
          console.log("  ok  (2) upload rejections (content/size/mime/no-file/404/403) leave zero writes");
        }

        // ── (3) Count cap ───────────────────────────────────────────────────
        {
          const pulse = await seedPulse();
          for (let i = 1; i <= 6; i++) {
            const r = await uploadImage(baseUrl, pulse.id, { name: `img${i}.png`, type: "image/png", data: pngBytes() });
            assert.equal(r.status, 201, `upload ${i}/6 → 201`);
          }
          const rCap = await uploadImage(baseUrl, pulse.id, { name: "img7.png", type: "image/png", data: pngBytes() });
          assert.equal(rCap.status, 400, "7th upload → 400");
          assert.match(String(rCap.body.error), /maximum of 6/i, "cap rejection names the limit");
          assert.equal((await readImages(pulse.id)).length, 6, "row stays at the cap");
          console.log("  ok  (3) per-brief count cap enforced atomically at 6");
        }

        // ── (4) Caption/reorder PATCH — exact permutation contract ─────────
        {
          const pulse = await seedPulse({
            images: [
              { slot: 1, ext: "png", caption: "First" },
              { slot: 2, ext: "jpg", caption: null },
              { slot: 3, ext: "webp", caption: "Third" },
            ],
          });

          // Reorder 3,1,2 + caption edits: slot 3 keeps caption via omission,
          // slot 1 cleared via explicit null, slot 2 gains one.
          const rOk = await patchImages(baseUrl, pulse.id, {
            images: [{ slot: 3 }, { slot: 1, caption: null }, { slot: 2, caption: "Now captioned" }],
          });
          assert.equal(rOk.status, 200, `valid permutation → 200 (got ${JSON.stringify(rOk.body)})`);
          const after = await readImages(pulse.id);
          assert.deepEqual(
            after,
            [
              { slot: 3, ext: "webp", caption: "Third" },
              { slot: 1, ext: "png", caption: null },
              { slot: 2, ext: "jpg", caption: "Now captioned" },
            ],
            "array order = display order; ext re-derived from stored metadata; omitted caption preserved, null cleared",
          );

          const badBodies: Array<[string, unknown]> = [
            ["unknown slot", { images: [{ slot: 3 }, { slot: 1 }, { slot: 9 }] }],
            ["missing slot (subset)", { images: [{ slot: 3 }, { slot: 1 }] }],
            ["duplicate slot", { images: [{ slot: 3 }, { slot: 3 }, { slot: 1 }] }],
            ["added slot (superset)", { images: [{ slot: 3 }, { slot: 1 }, { slot: 2 }, { slot: 4 }] }],
            ["client-supplied ext (strict schema)", { images: [{ slot: 3, ext: "png" }, { slot: 1 }, { slot: 2 }] }],
            ["caption over 300 chars", { images: [{ slot: 3, caption: "x".repeat(301) }, { slot: 1 }, { slot: 2 }] }],
            ["non-integer slot", { images: [{ slot: 1.5 }, { slot: 1 }, { slot: 2 }] }],
            ["images not an array", { images: "nope" }],
            ["empty body", {}],
          ];
          for (const [label, body] of badBodies) {
            const r = await patchImages(baseUrl, pulse.id, body);
            assert.equal(r.status, 400, `${label} → 400`);
            assert.deepEqual(await readImages(pulse.id), after, `${label}: no write`);
          }

          const r403 = await patchImages(baseUrl, pulse.id, { images: [{ slot: 3 }, { slot: 1 }, { slot: 2 }] }, { "x-test-user": AM_ID });
          assert.equal(r403.status, 403, "non-CEO PATCH → 403");

          // No-image brief accepts only the empty permutation.
          const bare = await seedPulse();
          const rEmptyOk = await patchImages(baseUrl, bare.id, { images: [] });
          assert.equal(rEmptyOk.status, 200, "empty list on image-less brief → 200 no-op");
          console.log("  ok  (4) caption/reorder PATCH enforces exact permutation; ext never client-writable");
        }

        // ── (5) DELETE — metadata-first, slot reuse semantics ───────────────
        {
          const pulse = await seedPulse({
            images: [
              { slot: 1, ext: "png", caption: "Keep A" },
              { slot: 2, ext: "jpg", caption: "Drop me" },
              { slot: 3, ext: "webp", caption: "Keep B" },
            ],
          });

          const rDel = await deleteImage(baseUrl, pulse.id, 2);
          assert.equal(rDel.status, 200, "delete existing slot → 200");
          assert.deepEqual(
            await readImages(pulse.id),
            [
              { slot: 1, ext: "png", caption: "Keep A" },
              { slot: 3, ext: "webp", caption: "Keep B" },
            ],
            "remaining entries keep order and captions",
          );
          assert.ok(!fakeStore.has(fakeKey(pulse.monthKey, 2, "jpg")), "object removed from storage");

          const rGone = await deleteImage(baseUrl, pulse.id, 2);
          assert.equal(rGone.status, 404, "deleting an absent slot → 404");
          const rBadSlot = await deleteImage(baseUrl, pulse.id, "abc");
          assert.equal(rBadSlot.status, 400, "non-numeric slot param → 400");
          const r403 = await deleteImage(baseUrl, pulse.id, 1, { "x-test-user": AM_ID });
          assert.equal(r403.status, 403, "non-CEO delete → 403");

          // Slot allocation is max+1 over the REMAINING entries: deleting the
          // highest slot (3) frees its number for the next upload…
          const rDel3 = await deleteImage(baseUrl, pulse.id, 3);
          assert.equal(rDel3.status, 200);
          const rUp = await uploadImage(baseUrl, pulse.id, { name: "new.png", type: "image/png", data: pngBytes() });
          assert.equal(rUp.body.slot, 2, "after deleting slots 2+3, next upload takes max(1)+1 = 2");
          // …but deleting a non-highest slot does NOT renumber survivors.
          const rDel1 = await deleteImage(baseUrl, pulse.id, 1);
          assert.equal(rDel1.status, 200);
          const rUp2 = await uploadImage(baseUrl, pulse.id, { name: "new2.png", type: "image/png", data: pngBytes() });
          assert.equal(rUp2.body.slot, 3, "survivor slot 2 is never renumbered; next slot = max(2)+1 = 3");
          console.log("  ok  (5) delete removes metadata+object, keeps survivors intact; max+1 slot reuse");
        }

        // ── (6) Public serving gate ─────────────────────────────────────────
        {
          const draft = await seedPulse({
            images: [{ slot: 1, ext: "png", caption: null }],
            published: false,
          });
          const published = await seedPulse({
            images: [{ slot: 1, ext: "jpg", caption: "Cover" }],
            published: true,
          });

          const anonPublished = await fetch(`${baseUrl}/api/ceo-pulse-charts/${published.monthKey}/image-1`, { headers: { "x-test-anon": "1" } });
          assert.equal(anonPublished.status, 200, "published brief image → anonymous 200");
          assert.equal(anonPublished.headers.get("content-type"), "image/jpeg", "content type comes from stored metadata ext");
          await anonPublished.arrayBuffer();

          const anonDraft = await fetch(`${baseUrl}/api/ceo-pulse-charts/${draft.monthKey}/image-1`, { headers: { "x-test-anon": "1" } });
          assert.equal(anonDraft.status, 404, "unpublished brief image → anonymous 404 (no existence leak)");

          const amDraft = await fetch(`${baseUrl}/api/ceo-pulse-charts/${draft.monthKey}/image-1`, { headers: { "x-test-user": AM_ID } });
          assert.equal(amDraft.status, 404, "unpublished brief image → authenticated non-CEO 404");

          const ceoDraft = await fetch(`${baseUrl}/api/ceo-pulse-charts/${draft.monthKey}/image-1`);
          assert.equal(ceoDraft.status, 200, "unpublished brief image → authenticated CEO 200 (Studio draft preview)");
          await ceoDraft.arrayBuffer();

          const badMonth = await fetch(`${baseUrl}/api/ceo-pulse-charts/${"20XX-01"}/image-1`, { headers: { "x-test-anon": "1" } });
          assert.equal(badMonth.status, 400, "malformed monthKey → 400");
          const badSlot = await fetch(`${baseUrl}/api/ceo-pulse-charts/${published.monthKey}/image-99999`, { headers: { "x-test-anon": "1" } });
          assert.equal(badSlot.status, 400, "over-long slot param → 400 (regex caps digits)");
          const unknownSlot = await fetch(`${baseUrl}/api/ceo-pulse-charts/${published.monthKey}/image-7`, { headers: { "x-test-anon": "1" } });
          assert.equal(unknownSlot.status, 404, "slot absent from metadata → 404");
          const unknownMonth = await fetch(`${baseUrl}/api/ceo-pulse-charts/2039-12/image-1`, { headers: { "x-test-anon": "1" } });
          assert.equal(unknownMonth.status, 404, "month with no brief → 404");

          fakeStore.delete(fakeKey(published.monthKey, 1, "jpg"));
          const objectGone = await fetch(`${baseUrl}/api/ceo-pulse-charts/${published.monthKey}/image-1`, { headers: { "x-test-anon": "1" } });
          assert.equal(objectGone.status, 404, "metadata present but object missing → 404 (serve returns false)");
          console.log("  ok  (6) serving gate: anon-published 200, draft 404 unless CEO, strict params, object-missing 404");
        }

        // ── (7) resolveImagePlaceholders unit behavior ──────────────────────
        {
          const images: CeoPulseSupportingImage[] = [
            { slot: 1, ext: "jpg", caption: 'Front <cover> & "teaser"' },
            { slot: 2, ext: "png", caption: null },
          ];
          const html = `<p>Intro</p>{{image-1}}<p>Mid</p>{{image-2}}{{image-9}}<p>End</p>`;
          const resolved = resolveImagePlaceholders(html, "2077-01", images);
          assert.ok(
            resolved.includes(`src="${getCeoPulseImageUrl("2077-01", 1)}"`),
            "slot 1 resolves to its extension-less serving URL",
          );
          assert.ok(
            resolved.includes("Front &lt;cover&gt; &amp; &quot;teaser&quot;"),
            "caption is HTML-escaped in the figcaption",
          );
          assert.ok(resolved.includes(`alt="Supporting image 2"`), "caption-less image gets the fallback alt");
          assert.ok(!resolved.includes("<figcaption") || resolved.split("<figcaption").length === 2, "no figcaption for caption-less image");
          assert.ok(!resolved.includes("{{image-"), "unknown slot 9 strips clean — no leftover placeholder");
          assert.ok(!resolved.includes("image-9"), "stripped slot leaves no URL fragment either");

          const untouched = "<p>No placeholders here</p>";
          assert.equal(resolveImagePlaceholders(untouched, "2077-01", images), untouched, "fast path returns input unchanged");
          assert.equal(resolveImagePlaceholders(html, "2077-01", []), `<p>Intro</p><p>Mid</p><p>End</p>`, "empty image list strips every placeholder");
          console.log("  ok  (7) resolver: figure/img/figcaption with escaping, fallback alt, always-strip semantics");
        }

        // ── (8) Share payload — images + letter resolution ──────────────────
        {
          const pulse = await seedPulse({
            published: true,
            fullLetterHtml: `<h1>Update</h1>{{image-2}}<p>Body</p>{{image-1}}{{image-9}}`,
            images: [
              { slot: 2, ext: "png", caption: "Shown first" },
              { slot: 1, ext: "jpg", caption: null },
            ],
          });
          const r = await fetch(`${baseUrl}/api/ceo-pulse/share/${pulse.shareToken}`, { headers: { "x-test-anon": "1" } });
          assert.equal(r.status, 200, "share → 200");
          const body: any = await r.json();
          assert.deepEqual(
            body.supportingImages,
            [
              { slot: 2, url: `/api/ceo-pulse-charts/${pulse.monthKey}/image-2`, caption: "Shown first" },
              { slot: 1, url: `/api/ceo-pulse-charts/${pulse.monthKey}/image-1`, caption: null },
            ],
            "share payload carries ordered images with extension-less URLs and null-for-unset captions",
          );
          assert.ok(body.fullLetterHtml.includes(`src="/api/ceo-pulse-charts/${pulse.monthKey}/image-2"`), "letter resolves {{image-2}}");
          assert.ok(body.fullLetterHtml.includes(`src="/api/ceo-pulse-charts/${pulse.monthKey}/image-1"`), "letter resolves {{image-1}}");
          assert.ok(!body.fullLetterHtml.includes("{{image-"), "removed slot 9 strips from the letter — never a broken tag");
          console.log("  ok  (8) share payload: ordered supportingImages + letter placeholder resolution/stripping");
        }
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    {
      tables: ["ceo_pulses", "users"],
    },
  );
}

main().then(
  () => {
    console.log("ceo-pulse-supporting-images: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("ceo-pulse-supporting-images: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
