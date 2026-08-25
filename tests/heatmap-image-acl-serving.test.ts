/* test-registration
{
  "name": "Heatmap image ACL serving + claim + claim-time content verification + scan-format gate/thumb variants (Tasks #2493, #3964, #4544)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2493 — heatmap (Map Rank) screenshot ACL.
 *
 * Two invariants are pinned here against the EXACT handlers `registerObjectStorageRoutes`
 * mounts (both extracted into testable factories), driven over real HTTP against
 * a fake Object Storage service — no Replit Object Storage call is made:
 *
 *   A. The object-serving route keeps the Task #1571 default: a MISSING ACL
 *      policy is PRIVATE. Only an explicit `visibility:"public"` object is
 *      served to an unauthenticated viewer; a no-policy object 401s (anon) /
 *      403s (authed-but-not-owner). The fix must NOT relax this.
 *   B. The heatmap-public claim endpoint sets `{owner,visibility:"public"}` only
 *      on an object that is unclaimed or already owned by the caller; a foreign-
 *      owned object is rejected (403) and an anon caller is rejected (401).
 *
 * Plus the lazy heal helper (`ensureHeatmapImagesPublic`) is scoped strictly to
 * objects referenced as a location heatmap — never a blanket missing→public.
 *
 * Task #3964 (audit A-006) adds claim-time content verification: presigned
 * PUT uploads are unconstrained at mint time, so before an object is flipped
 * to publicly-served the handler verifies the stored bytes (image sniff +
 * cap). Pinned here: a failing verdict is a 400; an unclaimed reject is
 * deleted while a self-owned reject is preserved; a foreign-owned object is
 * refused BEFORE any content probe; the success path verifies exactly once.
 */
// Self-set test mode BEFORE any server import (see helper doc): transitive
// modules build a pg pool whose idle sockets only reap (idleTimeoutMillis=0)
// under NODE_ENV=test — without this a bare `tsx` run passes every assertion
// but never exits.
import "./helpers/forceTestEnv";

import assert from "node:assert/strict";
import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { Response } from "express";

import { createServeObjectHandler } from "../server/replit_integrations/object_storage/routes";
import type { ObjectAclPolicy } from "../server/replit_integrations/object_storage/objectAcl";
import {
  createHeatmapPublicAclHandler,
  ensureHeatmapImagesPublic,
  ensureHeatmapThumbVariants,
  collectHeatmapObjectPaths,
  heatmapPublicClaimAllowed,
  type HeatmapAclStorage,
  type HeatmapVariantStorage,
} from "../server/services/heatmapImageAcl";
import {
  classifyScanProbe,
  heatmapThumbPath,
  HEATMAP_THUMB_SUFFIX,
} from "../shared/heatmapScan";
import type {
  UploadContentVerdict,
  UploadContentVerifyingStorage,
} from "../server/replit_integrations/object_storage/uploadContentVerification";

const OWNER = "user-owner";
const ATTACKER = "user-attacker";
const PATH = `/objects/uploads/${randomUUID()}`;
const BODY = Buffer.from("the-heatmap-png-bytes");

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

// ── Fake serving service: returns a sentinel "file" for any path, streams a
//    fixed body, and grants access only to OWNER. ─────────────────────────────
function makeServeService(allowUser: string | null) {
  const calls = { downloads: 0 };
  return {
    calls,
    service: {
      async getObjectEntityFile(p: string) {
        return { __path: p };
      },
      async canAccessObjectEntity({ userId }: { userId?: string }) {
        return !!userId && userId === allowUser;
      },
      async downloadObject(_file: unknown, res: Response) {
        calls.downloads += 1;
        res.status(200).end(BODY);
      },
    },
  };
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

// Mount the serve handler with a configurable injected ACL + an optional fake
// authenticated user.
function mountServe(opts: {
  acl: ObjectAclPolicy | null;
  allowUser: string | null;
  authUser?: string | null;
}) {
  const app = express();
  if (opts.authUser) {
    app.use((req: any, _res, next) => {
      req.user = { claims: { sub: opts.authUser } };
      next();
    });
  }
  const { service, calls } = makeServeService(opts.allowUser);
  app.get(
    "/objects/:objectPath(*)",
    createServeObjectHandler({ service, getAclPolicy: async () => opts.acl }),
  );
  return { app, calls };
}

// ── Fake ACL store for the claim endpoint + heal helper. ─────────────────────
// The claim handler additionally requires the Task #3964 content-verification
// surface; `verdict` scripts its outcome (defaults to an ok image verdict).
const OK_IMAGE_VERDICT: UploadContentVerdict = {
  ok: true,
  sizeBytes: BODY.length,
  sniffed: { kind: "image", format: "png", mime: "image/png" },
};

// A real 1×1 transparent PNG so the Task #4544 variant path can exercise the
// REAL sharp pipeline (decode → resize → webp) instead of stubbing it.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function makeAclStorage(
  initial: Record<string, ObjectAclPolicy | null>,
  content?: {
    verdict?: UploadContentVerdict;
    /** Simulates a concurrent actor mutating ACLs mid-verify (claim race). */
    beforeVerdict?: (store: Map<string, ObjectAclPolicy | null>) => void;
    /** Task #4544 — byte store backing the variant surface. */
    objects?: Record<string, Buffer>;
  },
) {
  const store = new Map<string, ObjectAclPolicy | null>(Object.entries(initial));
  const objects = new Map<string, { bytes: Buffer; contentType?: string }>(
    Object.entries(content?.objects ?? {}).map(([p, bytes]) => [p, { bytes }]),
  );
  const sets: Array<{ path: string; policy: ObjectAclPolicy }> = [];
  const verifies: string[] = [];
  const deletes: Array<{ path: string; expectedOwner: string | null }> = [];
  const uploads: Array<{ path: string; contentType: string; size: number }> = [];
  const storage: HeatmapVariantStorage & UploadContentVerifyingStorage = {
    async getObjectEntityAclPolicy(p: string) {
      return store.has(p) ? store.get(p)! : null;
    },
    async trySetObjectEntityAclPolicy(p: string, policy: ObjectAclPolicy) {
      store.set(p, policy);
      sets.push({ path: p, policy });
      return p;
    },
    async verifyObjectEntityContent(p: string) {
      verifies.push(p);
      content?.beforeVerdict?.(store);
      return content?.verdict ?? OK_IMAGE_VERDICT;
    },
    // Mirrors the real implementation's race-safe contract: re-check the
    // CURRENT owner at delete time and only delete while the entitlement
    // still holds (rejectedUploadDeleteAllowed semantics).
    async deleteRejectedUploadObject(p: string, opts: { expectedOwner: string | null }) {
      deletes.push({ path: p, expectedOwner: opts.expectedOwner });
      const currentOwner = store.get(p)?.owner ?? null;
      if (currentOwner && currentOwner !== opts.expectedOwner) return false;
      store.delete(p);
      return true;
    },
    // ── Task #4544 — variant byte surface ────────────────────────────────────
    async objectExists(p: string) {
      return objects.has(p);
    },
    async downloadObjectBytes(p: string) {
      const entry = objects.get(p);
      if (!entry) throw new Error(`no bytes stored for ${p}`);
      return entry.bytes;
    },
    async uploadObjectBytes(p: string, bytes: Buffer, contentType: string) {
      objects.set(p, { bytes, contentType });
      uploads.push({ path: p, contentType, size: bytes.length });
    },
  };
  return { storage, store, objects, sets, verifies, deletes, uploads };
}

async function main(): Promise<void> {
  console.log("Heatmap image ACL serving + claim (Task #2493)");

  // ── A. Serving route keeps missing-ACL-is-private ──────────────────────────
  await step("explicit public object is served to an anonymous viewer (200)", async () => {
    const { app, calls } = mountServe({
      acl: { owner: OWNER, visibility: "public" },
      allowUser: null,
      authUser: null,
    });
    const { server, baseUrl } = await listen(app);
    try {
      const r = await fetch(`${baseUrl}${PATH}`);
      assert.equal(r.status, 200, "public object → 200 for anon");
      assert.equal(await r.text(), BODY.toString(), "bytes streamed");
      assert.equal(calls.downloads, 1);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  await step("MISSING ACL is private: anonymous viewer is 401, nothing streamed", async () => {
    const { app, calls } = mountServe({ acl: null, allowUser: OWNER, authUser: null });
    const { server, baseUrl } = await listen(app);
    try {
      const r = await fetch(`${baseUrl}${PATH}`);
      assert.equal(r.status, 401, "no-policy object → 401 for anon");
      assert.equal(calls.downloads, 0, "nothing streamed");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  await step("MISSING ACL: authed non-owner is 403, nothing streamed", async () => {
    const { app, calls } = mountServe({ acl: null, allowUser: OWNER, authUser: ATTACKER });
    const { server, baseUrl } = await listen(app);
    try {
      const r = await fetch(`${baseUrl}${PATH}`);
      assert.equal(r.status, 403, "no-policy object → 403 for non-owner");
      assert.equal(calls.downloads, 0, "nothing streamed");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  // ── B. Heatmap-public claim endpoint ───────────────────────────────────────
  function mountClaim(
    initial: Record<string, ObjectAclPolicy | null>,
    authUser?: string | null,
    content?: { verdict?: UploadContentVerdict },
  ) {
    const app = express();
    app.use(express.json());
    if (authUser) {
      app.use((req: any, _res, next) => {
        req.user = { claims: { sub: authUser } };
        next();
      });
    }
    const acl = makeAclStorage(initial, content);
    app.post("/api/object-storage/heatmap-public", createHeatmapPublicAclHandler({ storage: acl.storage }));
    return { app, acl };
  }

  async function postClaim(baseUrl: string, objectPath: string) {
    const r = await fetch(`${baseUrl}/api/object-storage/heatmap-public`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectPath }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  await step("claim sets public on an UNCLAIMED object (200)", async () => {
    const { app, acl } = mountClaim({ [PATH]: null }, OWNER);
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, PATH);
      assert.equal(r.status, 200);
      assert.deepEqual(acl.store.get(PATH), { owner: OWNER, visibility: "public" });
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  await step("claim on an object the user ALREADY owns (200)", async () => {
    const { app, acl } = mountClaim({ [PATH]: { owner: OWNER, visibility: "private" } }, OWNER);
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, PATH);
      assert.equal(r.status, 200);
      assert.equal(acl.store.get(PATH)?.visibility, "public");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  await step("claim on a FOREIGN-owned object is rejected (403); not flipped", async () => {
    const { app, acl } = mountClaim({ [PATH]: { owner: ATTACKER, visibility: "private" } }, OWNER);
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, PATH);
      assert.equal(r.status, 403, "foreign object → 403");
      assert.equal(acl.store.get(PATH)?.visibility, "private", "unchanged");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  await step("claim by an anonymous caller is rejected (401)", async () => {
    const { app } = mountClaim({ [PATH]: null }, null);
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, PATH);
      assert.equal(r.status, 401);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  await step("claim rejects a non-/objects/ path (400)", async () => {
    const { app } = mountClaim({}, OWNER);
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, "/etc/passwd");
      assert.equal(r.status, 400);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  // ── B2. Task #3964 — claim-time content verification ──────────────────────
  await step("success path runs content verification exactly once before public", async () => {
    const { app, acl } = mountClaim({ [PATH]: null }, OWNER);
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, PATH);
      assert.equal(r.status, 200);
      assert.deepEqual(acl.verifies, [PATH], "verified exactly once");
      assert.equal(acl.deletes.length, 0, "nothing deleted");
      assert.equal(acl.store.get(PATH)?.visibility, "public");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  await step("failing verdict on an UNCLAIMED object → 400, deleted, never public", async () => {
    const badVerdict: UploadContentVerdict = {
      ok: false,
      reason: "disallowed_type",
      detail: "sniffed video (mp4-family) but this flow accepts: image",
      sizeBytes: 123,
      sniffed: { kind: "video", format: "mp4-family", mime: "video/mp4" },
    };
    const { app, acl } = mountClaim({ [PATH]: null }, OWNER, { verdict: badVerdict });
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, PATH);
      assert.equal(r.status, 400, "rejected upload → 400");
      assert.equal(r.body.reason, "disallowed_type", "reason surfaced");
      assert.deepEqual(
        acl.deletes,
        [{ path: PATH, expectedOwner: null }],
        "unclaimed reject is deleted with an unclaimed-only entitlement",
      );
      assert.equal(acl.sets.length, 0, "never made public");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  await step("failing verdict on a SELF-OWNED object → 400 but NOT deleted", async () => {
    const badVerdict: UploadContentVerdict = {
      ok: false,
      reason: "too_large",
      detail: "20971521 bytes exceeds the image cap of 10485760 bytes",
      sizeBytes: 20_971_521,
      sniffed: { kind: "image", format: "png", mime: "image/png" },
    };
    const { app, acl } = mountClaim(
      { [PATH]: { owner: OWNER, visibility: "private" } },
      OWNER,
      { verdict: badVerdict },
    );
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, PATH);
      assert.equal(r.status, 400);
      assert.equal(acl.deletes.length, 0, "self-owned object preserved (may back an existing report)");
      assert.equal(acl.store.get(PATH)?.visibility, "private", "stays private");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  await step("claim RACE: object claimed mid-verify is NOT deleted (expectedOwner honored)", async () => {
    const badVerdict: UploadContentVerdict = {
      ok: false,
      reason: "disallowed_type",
      detail: "sniffed video (mp4-family) but this flow accepts: image",
      sizeBytes: 123,
      sniffed: { kind: "video", format: "mp4-family", mime: "video/mp4" },
    };
    // Starts unclaimed, so it passes the handler's claim gate. DURING
    // verification a concurrent actor claims it; the storage-level ownership
    // re-check must then refuse the delete the handler requests (the TOCTOU
    // race from review round 1).
    const { app, acl } = mountClaim({ [PATH]: null }, OWNER, {
      verdict: badVerdict,
      beforeVerdict: (store) => store.set(PATH, { owner: ATTACKER, visibility: "private" }),
    });
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, PATH);
      assert.equal(r.status, 400, "upload still rejected for this claimant");
      assert.deepEqual(
        acl.deletes,
        [{ path: PATH, expectedOwner: null }],
        "delete attempted with the unclaimed-only entitlement",
      );
      assert.equal(
        acl.store.get(PATH)?.owner,
        ATTACKER,
        "now-claimed object SURVIVES the reject cleanup",
      );
      assert.equal(acl.sets.length, 0, "never made public by this handler");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  // ── B3. Task #4544 — scan-format gate + thumbnail variants ────────────────
  await step("claim REJECTS a sniffed JPEG (photo, not a map scan): 400, deleted, never public", async () => {
    const jpegVerdict: UploadContentVerdict = {
      ok: true,
      sizeBytes: 123,
      sniffed: { kind: "image", format: "jpeg", mime: "image/jpeg" },
    };
    const { app, acl } = mountClaim({ [PATH]: null }, OWNER, { verdict: jpegVerdict });
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, PATH);
      assert.equal(r.status, 400, "photo upload → 400");
      assert.equal(r.body.reason, "not_a_map_scan", "explicit rejection reason");
      assert.deepEqual(
        acl.deletes,
        [{ path: PATH, expectedOwner: null }],
        "unclaimed photo reject is deleted like any other reject",
      );
      assert.equal(acl.sets.length, 0, "never made public");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  await step("successful PNG claim mints a public `__thumb` variant (real sharp)", async () => {
    const thumbPath = heatmapThumbPath(PATH)!;
    const { app, acl } = mountClaim({ [PATH]: null }, OWNER, {
      objects: { [PATH]: TINY_PNG },
    });
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, PATH);
      assert.equal(r.status, 200);
      assert.equal(acl.uploads.length, 1, "one variant upload");
      assert.equal(acl.uploads[0].path, thumbPath, "deterministic sibling key");
      assert.equal(acl.uploads[0].contentType, "image/webp", "resized webp variant");
      assert.deepEqual(acl.store.get(thumbPath), { owner: OWNER, visibility: "public" });
      assert.deepEqual(acl.store.get(PATH), { owner: OWNER, visibility: "public" });
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  await step("variant generation failure is best-effort: claim still succeeds", async () => {
    // Bytes sharp cannot decode — the variant path must swallow the failure.
    const { app, acl } = mountClaim({ [PATH]: null }, OWNER, {
      objects: { [PATH]: Buffer.from("not-an-image") },
    });
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, PATH);
      assert.equal(r.status, 200, "claim unaffected by variant failure");
      assert.equal(acl.uploads.length, 0, "no variant uploaded");
      assert.equal(acl.store.get(PATH)?.visibility, "public");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  await step("ensureHeatmapThumbVariants heals PNG scans, skips photos + existing variants", async () => {
    const pngRef = `/objects/uploads/${randomUUID()}`;
    const jpegRef = `/objects/uploads/${randomUUID()}`;
    const doneRef = `/objects/uploads/${randomUUID()}`;
    const acl = makeAclStorage(
      { [pngRef]: null, [jpegRef]: null, [doneRef]: null },
      {
        objects: {
          [pngRef]: TINY_PNG,
          [jpegRef]: Buffer.from("jpeg-bytes"),
          [doneRef]: TINY_PNG,
          [heatmapThumbPath(doneRef)!]: TINY_PNG, // variant already exists
        },
      },
    );
    // Script per-path verdicts: sniff by our fixture knowledge.
    const verdictFor = (p: string): UploadContentVerdict =>
      p === jpegRef
        ? { ok: true, sizeBytes: 10, sniffed: { kind: "image", format: "jpeg", mime: "image/jpeg" } }
        : { ok: true, sizeBytes: TINY_PNG.length, sniffed: { kind: "image", format: "png", mime: "image/png" } };
    acl.storage.verifyObjectEntityContent = async (p: string) => {
      acl.verifies.push(p);
      return verdictFor(p);
    };
    const sections = [
      {
        sectionKey: "marketing",
        data: {
          gbpLocations: [
            { heatmapImageUrl: pngRef },
            { heatmapImageUrl: jpegRef },
            { heatmapImageUrl: doneRef },
          ],
        },
      },
    ];
    const ensured = await ensureHeatmapThumbVariants(acl.storage, sections, OWNER);
    assert.equal(ensured, 2, "png healed + existing variant counted");
    assert.equal(acl.uploads.length, 1, "exactly one new variant minted");
    assert.equal(acl.uploads[0].path, heatmapThumbPath(pngRef));
    assert.equal(acl.store.get(heatmapThumbPath(pngRef)!)?.visibility, "public");
    assert.equal(
      acl.objects.has(heatmapThumbPath(jpegRef)!),
      false,
      "photo never gets a scan variant",
    );
    assert.deepEqual(acl.verifies.sort(), [jpegRef, pngRef].sort(), "existing variant skips the sniff");
  });

  await step("shared scan contract: thumb path derivation + HEAD-probe classifier", async () => {
    assert.equal(heatmapThumbPath("/objects/uploads/abc"), `/objects/uploads/abc${HEATMAP_THUMB_SUFFIX}`);
    assert.equal(heatmapThumbPath(`/objects/uploads/abc${HEATMAP_THUMB_SUFFIX}`), null, "no variant-of-variant");
    assert.equal(heatmapThumbPath("https://external/x.png"), null, "external URLs get no variant");
    assert.equal(classifyScanProbe({ ok: true, contentType: "image/png" }), "valid");
    assert.equal(classifyScanProbe({ ok: true, contentType: "image/webp; charset=binary" }), "valid");
    assert.equal(
      classifyScanProbe({ ok: true, contentType: "image/jpeg" }),
      "invalid",
      "the 2254×2271 portrait headshot class: 200 + image/jpeg must NOT render as a scan",
    );
    assert.equal(classifyScanProbe({ ok: true, contentType: null }), "invalid");
    assert.equal(classifyScanProbe({ ok: false, contentType: "image/png" }), "invalid");
  });

  await step("FOREIGN-owned object is refused before any content probe", async () => {
    const { app, acl } = mountClaim({ [PATH]: { owner: ATTACKER, visibility: "private" } }, OWNER);
    const { server, baseUrl } = await listen(app);
    try {
      const r = await postClaim(baseUrl, PATH);
      assert.equal(r.status, 403);
      assert.equal(acl.verifies.length, 0, "no content probe on a foreign object");
      assert.equal(acl.deletes.length, 0, "no delete on a foreign object");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  // ── C. Heal helper scope ───────────────────────────────────────────────────
  await step("collectHeatmapObjectPaths only picks /objects/ heatmap urls in marketing", async () => {
    const sections = [
      {
        sectionKey: "marketing",
        data: {
          gbpLocations: [
            { heatmapImageUrl: PATH },
            { heatmapImageUrl: "https://external/not-an-object.png" },
            { name: "no image" },
          ],
          gbp: { locations: [{ heatmapImageUrl: "/objects/uploads/second" }] },
        },
      },
      { sectionKey: "sales", data: { gbpLocations: [{ heatmapImageUrl: "/objects/uploads/ignored" }] } },
    ];
    const paths = collectHeatmapObjectPaths(sections);
    assert.deepEqual(paths.sort(), [PATH, "/objects/uploads/second"].sort());
  });

  await step("ensureHeatmapImagesPublic flips only referenced unclaimed/owned objects", async () => {
    const referenced = `/objects/uploads/${randomUUID()}`;
    const foreign = `/objects/uploads/${randomUUID()}`;
    const acl = makeAclStorage({ [referenced]: null, [foreign]: { owner: ATTACKER, visibility: "private" } });
    const sections = [
      {
        sectionKey: "marketing",
        data: { gbpLocations: [{ heatmapImageUrl: referenced }, { heatmapImageUrl: foreign }] },
      },
    ];
    const healed = await ensureHeatmapImagesPublic(acl.storage, sections, OWNER);
    assert.equal(healed, 1, "only the unclaimed referenced object is healed");
    assert.equal(acl.store.get(referenced)?.visibility, "public");
    assert.equal(acl.store.get(foreign)?.visibility, "private", "foreign object untouched");
  });

  await step("ensureHeatmapImagesPublic is a no-op when no heatmap urls present", async () => {
    const acl = makeAclStorage({});
    const healed = await ensureHeatmapImagesPublic(
      acl.storage,
      [{ sectionKey: "marketing", data: { gbpLocations: [{ name: "x" }] } }],
      OWNER,
    );
    assert.equal(healed, 0);
    assert.equal(acl.sets.length, 0, "no metadata writes");
  });

  await step("heatmapPublicClaimAllowed guard", async () => {
    assert.equal(heatmapPublicClaimAllowed(null, OWNER), true);
    assert.equal(heatmapPublicClaimAllowed(undefined, OWNER), true);
    assert.equal(heatmapPublicClaimAllowed(OWNER, OWNER), true);
    assert.equal(heatmapPublicClaimAllowed(ATTACKER, OWNER), false);
  });

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nAll heatmap image ACL tests passed");
}

let exitCode = 0;
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    try {
      // Drain undici's keep-alive sockets from the local-server fetches or a
      // bare `tsx` run never exits (the batched runner masks this). Built-in
      // fetch uses Node's BUNDLED undici, not node_modules undici — its
      // global dispatcher is only reachable via the registration symbol, so
      // close BOTH (npm undici too, in case a transitive import used it).
      const nodeDispatcher = (globalThis as any)[
        Symbol.for("undici.globalDispatcher.1")
      ];
      if (nodeDispatcher?.close) await nodeDispatcher.close();
      const { getGlobalDispatcher } = await import("undici");
      await getGlobalDispatcher().close();
    } catch {}
    process.exitCode = exitCode;
  });
