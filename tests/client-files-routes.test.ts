/* test-registration
{
  "name": "Client file storage API (Task #4023)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4023: in-app client file storage — upload claim authorization (namespace confinement, foreign-owner reject, size/empty rejection with race-safe cleanup), same-name versioning with restore swap, trash lifecycle (trash/restore/purge with object deletion), folder cycle/conflict guards, DB-derived download headers with the inline whitelist, per-client authz (role-or-owner, 401/403/404), usage rollups and the global cross-client library gates. A drift here either lets a claim escape its client namespace (cross-tenant file injection) or breaks the storage lifecycle the Files tab depends on.",
  "tier": "small"
}
test-registration */
/**
 * Task #4023 — Client file storage API coverage.
 *
 * Runs the REAL registerClientFileRoutes against a real Express app (real
 * isAuthenticated behind an injected passport-shaped session, following
 * tests/save-plays.test.ts) with a FAKE object-storage seam so no network
 * or bucket is touched. The fake models the bucket as a Map keyed by the
 * PRIVATE_OBJECT_DIR-relative storage key, with per-object ACL owner state
 * — exactly the surface the routes consume.
 *
 *   1. Authz — 401 unauthenticated; 403 for a low-role non-owner and for an
 *      auto-provisioned unknown sub; 404 for a missing client; the client
 *      OWNER passes without the account_manager role (mirrors save-plays).
 *   2. Claim authorization — the security core: an object minted for client
 *      A can never be claimed into client B (namespace confinement,
 *      including a nested-segment path); an object already ACL-owned by
 *      another user is rejected; a never-uploaded path 400s; empty and
 *      oversized uploads are rejected AND the rejected object is deleted
 *      race-safely with expectedOwner = the claimant; unknown formats are
 *      accepted as application/octet-stream (download-only); a claim into
 *      another client's folder id 404s.
 *   3. Versioning — same name in the same folder supersedes: the old
 *      content becomes version 1 under the SAME file id; version download
 *      streams the old bytes; restore swaps current↔version and the swap
 *      is visible in the bytes served afterward.
 *   4. Folders + move — duplicate sibling names 409; moving a folder into
 *      its own subtree is rejected with code "cycle"; files move between
 *      folders.
 *   5. Trash lifecycle — trash hides from browse and shows in the trash
 *      list; restore returns to the original folder while it exists and
 *      falls back to the root once the folder was deleted; deleting a
 *      folder trashes its files; purge deletes objects (current + version)
 *      from storage first and drops the rows, leaving a client-level
 *      "purged" activity entry.
 *   6. Downloads — headers come from the DB row, never object metadata:
 *      inline only when requested AND the mime is whitelisted (png yes,
 *      octet-stream no), always nosniff + private no-store, exact bytes.
 *   7. Usage + global library — per-client usage counts live/version/trash
 *      bytes; /api/files search spans clients with firm names and kind
 *      filters and is role-gated (account_manager+); /api/files/usage is
 *      team_lead+; /api/files/recent surfaces the newest uploads.
 *
 * Seeding uses per-run random suffixes (client ids are hex-shaped so the
 * storage-key namespace helpers accept them) and cleans up in finally —
 * client deletes cascade folders/files/versions/activity.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  registerClientFileRoutes,
  type ClientFileStorage,
} from "../server/routes/clientFiles";
import { ObjectNotFoundError } from "../server/replit_integrations/object_storage/objectStorage";
import type { GeneralUploadVerdict } from "../server/replit_integrations/object_storage/generalUploadSniff";
import { CLIENT_FILE_MAX_BYTES } from "@shared/clientFiles";

const HEX = randomBytes(4).toString("hex");
const RUN = `t4023-${HEX}`;

// Client ids must be storage-safe (lowercase hex + hyphens) so the
// namespace helpers accept them — see isStorageSafeClientId.
const C_A = `a4023a01-${HEX}-${randomBytes(3).toString("hex")}`;
const C_B = `b4023b02-${HEX}-${randomBytes(3).toString("hex")}`;
const C_MISSING = `c4023c03-${HEX}-${randomBytes(3).toString("hex")}`;

const AM_ID = `${RUN}-am`;       // account_manager role → full per-client access
const TL_ID = `${RUN}-tl`;       // team_lead role → global usage rollup
const LOW_ID = `${RUN}-low`;     // 'sales' role, owns nothing → 403 everywhere
const OWNER_ID = `${RUN}-owner`; // 'sales' role but owns C_B → owner-path access
const GHOST_ID = `${RUN}-ghost`; // session sub with no users row

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ── Fake object storage ─────────────────────────────────────────────────────
// Bucket = Map keyed by the storage KEY (objectPath minus "/objects/").

interface FakeObject {
  bytes: Buffer;
  mime: string;
  owner: string | null;
  /** Pretend size (oversize tests without allocating 500 MiB). */
  sizeOverride?: number;
}

const objects = new Map<string, FakeObject>();
const rejectedDeletes: { objectPath: string; expectedOwner: string | null }[] = [];
const deletedKeys: string[] = [];

function keyOf(objectPath: string): string {
  return objectPath.replace(/^\/objects\//, "");
}

/** Simulates the browser PUT to the presigned URL. */
function putObject(
  objectPath: string,
  bytes: Buffer,
  mime: string,
  sizeOverride?: number,
): void {
  objects.set(keyOf(objectPath), { bytes, mime, owner: null, sizeOverride });
}

const fakeStorage: ClientFileStorage = {
  async getClientFileUploadURL(clientId, opts) {
    const ext =
      opts?.extension && /^\.[a-z0-9]{1,5}$/.test(opts.extension)
        ? opts.extension
        : "";
    const leaf = `${randomBytes(8).toString("hex")}${ext}`;
    const objectPath = `/objects/client-files/${clientId}/${leaf}`;
    return { uploadUrl: `https://fake-bucket.invalid/put/${leaf}`, objectPath };
  },
  async getObjectEntityAclPolicy(objectPath) {
    const rec = objects.get(keyOf(objectPath));
    if (!rec) throw new ObjectNotFoundError();
    return { owner: rec.owner };
  },
  async verifyClientFileObjectContent(objectPath, opts): Promise<GeneralUploadVerdict> {
    const rec = objects.get(keyOf(objectPath));
    if (!rec) throw new ObjectNotFoundError();
    const size = rec.sizeOverride ?? rec.bytes.length;
    if (size <= 0) {
      return { ok: false, reason: "empty_object", detail: "empty object", sizeBytes: 0 };
    }
    if (size > opts.maxBytes) {
      return { ok: false, reason: "too_large", detail: `size ${size}`, sizeBytes: size };
    }
    return { ok: true, sizeBytes: size, mime: rec.mime, format: "fake" };
  },
  async trySetObjectEntityAclPolicy(objectPath, policy) {
    const rec = objects.get(keyOf(objectPath));
    if (rec) rec.owner = policy.owner;
    return undefined;
  },
  async deleteRejectedUploadObject(objectPath, opts) {
    rejectedDeletes.push({ objectPath, expectedOwner: opts.expectedOwner });
    return objects.delete(keyOf(objectPath));
  },
  async deletePrivateObjectByKey(objectKey) {
    deletedKeys.push(objectKey);
    return objects.delete(objectKey);
  },
  async createPrivateObjectReadStream(objectKey) {
    const rec = objects.get(objectKey);
    if (!rec) throw new ObjectNotFoundError();
    return Readable.from(rec.bytes);
  },
};

// ── Harness ─────────────────────────────────────────────────────────────────

// requireAuth honors the __test_clerkUserId seam only under NODE_ENV=test
// (bare `npx tsx` repros included). Users are seeded in the hermetic public
// schema, so requireAuth's DB lookup resolves real roles.
process.env.NODE_ENV ||= "test";

let actingUserId: string | null = AM_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk-era auth seam: string = authenticated as that user, null =
    // anonymous (requireAuth returns 401). NODE_ENV=test only.
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerClientFileRoutes(app, { storage: fakeStorage });
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

let baseUrl = "";

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; res: globalThis.Response }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, res };
}

/** Full mint→PUT→claim round trip as the acting user. */
async function uploadFile(args: {
  clientId: string;
  fileName: string;
  bytes: Buffer;
  mime: string;
  folderId?: string | null;
}): Promise<{ status: number; json: any; objectPath: string }> {
  const mint = await api("POST", `/api/clients/${args.clientId}/files/upload-url`, {
    fileName: args.fileName,
  });
  assertEq(mint.status, 200, `upload-url for ${args.fileName}`);
  putObject(mint.json.objectPath, args.bytes, args.mime);
  const claim = await api("POST", `/api/clients/${args.clientId}/files/claim`, {
    objectPath: mint.json.objectPath,
    fileName: args.fileName,
    ...(args.folderId ? { folderId: args.folderId } : {}),
  });
  return { status: claim.status, json: claim.json, objectPath: mint.json.objectPath };
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${AM_ID}, ${`${AM_ID}@t4023.example`}, 'Task4023', 'Manager', 'account_manager', 'core'),
      (${TL_ID}, ${`${TL_ID}@t4023.example`}, 'Task4023', 'Lead', 'team_lead', 'lead'),
      (${LOW_ID}, ${`${LOW_ID}@t4023.example`}, 'Task4023', 'Low', 'sales', 'core'),
      (${OWNER_ID}, ${`${OWNER_ID}@t4023.example`}, 'Task4023', 'Owner', 'sales', 'core')
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES
      (${C_A}, ${`${RUN} Alpha Firm`}, ${AM_ID}, false, false),
      (${C_B}, ${`${RUN} Beta Firm`}, ${OWNER_ID}, false, false)
  `);
}

async function cleanup(): Promise<void> {
  // Client deletes cascade folders/files/versions/activity.
  try {
    await db.execute(sql`DELETE FROM clients WHERE id IN (${C_A}, ${C_B})`);
  } catch {}
  try {
    await db.execute(sql`
      DELETE FROM users WHERE id IN (${AM_ID}, ${TL_ID}, ${LOW_ID}, ${OWNER_ID}, ${GHOST_ID})
    `);
  } catch {}
}

// ── Steps ───────────────────────────────────────────────────────────────────

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${err?.message ?? err}`);
  }
}

async function main(): Promise<void> {
  await cleanup();
  await seed();
  const { server, baseUrl: url } = await listen(buildApp());
  baseUrl = url;

  const filesBase = `/api/clients/${C_A}/files`;

  try {
    // ── 1. Authz ─────────────────────────────────────────────────────────
    await step("401 when unauthenticated", async () => {
      actingUserId = null;
      const r = await api("GET", `${filesBase}/browse`);
      assertEq(r.status, 401, "browse unauthenticated");
    });

    await step("403 for low-role non-owner; unapproved ghost denied at admission; 404 missing client", async () => {
      actingUserId = LOW_ID;
      assertEq((await api("GET", `${filesBase}/browse`)).status, 403, "low-role browse");
      // Task #4554 closed admission: a session whose sub has no users row is
      // no longer JIT-provisioned — requireAuth denies it outright
      // (403 account_not_approved) and writes nothing. Same pinned behavior
      // as tests/save-plays.test.ts.
      actingUserId = GHOST_ID;
      assertEq((await api("GET", `${filesBase}/browse`)).status, 403, "ghost browse (denied at admission)");
      actingUserId = AM_ID;
      assertEq(
        (await api("GET", `/api/clients/${C_MISSING}/files/browse`)).status,
        404,
        "missing client",
      );
    });

    await step("client owner passes without account_manager role", async () => {
      actingUserId = OWNER_ID;
      const r = await api("GET", `/api/clients/${C_B}/files/browse`);
      assertEq(r.status, 200, "owner browse own client");
      // …but not someone else's client.
      assertEq((await api("GET", `${filesBase}/browse`)).status, 403, "owner on foreign client");
      actingUserId = AM_ID;
    });

    // ── 2. Claim authorization ──────────────────────────────────────────
    await step("claim rejects objects minted for another client's namespace", async () => {
      const mint = await api("POST", `${filesBase}/upload-url`, { fileName: "steal.pdf" });
      assertEq(mint.status, 200, "mint for C_A");
      assert(
        String(mint.json.objectPath).startsWith(`/objects/client-files/${C_A}/`),
        "minted path sits in C_A namespace",
      );
      putObject(mint.json.objectPath, Buffer.from("PDFDATA"), "application/pdf");
      // Try to claim the C_A-minted object into C_B (as its owner).
      actingUserId = OWNER_ID;
      const cross = await api("POST", `/api/clients/${C_B}/files/claim`, {
        objectPath: mint.json.objectPath,
        fileName: "steal.pdf",
      });
      assertEq(cross.status, 403, "cross-namespace claim");
      actingUserId = AM_ID;
      assert(objects.has(keyOf(mint.json.objectPath)), "rejected cross-claim must NOT delete the object");
      // Nested extra segment → outside-namespace shape rejection. The object
      // must EXIST in the fake bucket: the route reads the ACL first (a
      // missing object 400s there), and only an existing object reaches the
      // namespace-shape gate this assertion targets.
      const nestedPath = `/objects/client-files/${C_A}/${randomBytes(8).toString("hex")}/evil`;
      putObject(nestedPath, Buffer.from("EVIL"), "application/octet-stream");
      const nested = await api("POST", `${filesBase}/claim`, {
        objectPath: nestedPath,
        fileName: "evil.bin",
      });
      assertEq(nested.status, 403, "nested-segment path");
      assert(objects.has(keyOf(nestedPath)), "shape-rejected object is NOT deleted");
    });

    await step("claim rejects an object already owned by someone else", async () => {
      const mint = await api("POST", `${filesBase}/upload-url`, { fileName: "taken.txt" });
      putObject(mint.json.objectPath, Buffer.from("hello"), "text/plain");
      objects.get(keyOf(mint.json.objectPath))!.owner = "someone-else";
      const r = await api("POST", `${filesBase}/claim`, {
        objectPath: mint.json.objectPath,
        fileName: "taken.txt",
      });
      assertEq(r.status, 403, "owned-by-other claim");
      assert(objects.has(keyOf(mint.json.objectPath)), "foreign object must not be deleted");
    });

    await step("claim 400s for a never-uploaded object path", async () => {
      const r = await api("POST", `${filesBase}/claim`, {
        objectPath: `/objects/client-files/${C_A}/${randomBytes(8).toString("hex")}`,
        fileName: "ghost.bin",
      });
      assertEq(r.status, 400, "claim without upload");
      assertEq(r.json.error, "Uploaded object not found", "not-found message");
    });

    await step("empty and oversized uploads are rejected and deleted race-safely", async () => {
      const before = rejectedDeletes.length;
      const mintEmpty = await api("POST", `${filesBase}/upload-url`, { fileName: "empty.dat" });
      putObject(mintEmpty.json.objectPath, Buffer.alloc(0), "application/octet-stream");
      const empty = await api("POST", `${filesBase}/claim`, {
        objectPath: mintEmpty.json.objectPath,
        fileName: "empty.dat",
      });
      assertEq(empty.status, 400, "empty upload");
      const mintBig = await api("POST", `${filesBase}/upload-url`, { fileName: "big.mov" });
      putObject(mintBig.json.objectPath, Buffer.from("x"), "video/quicktime", CLIENT_FILE_MAX_BYTES + 1);
      const big = await api("POST", `${filesBase}/claim`, {
        objectPath: mintBig.json.objectPath,
        fileName: "big.mov",
      });
      assertEq(big.status, 400, "oversized upload");
      assert(/500 MB/.test(String(big.json.error)), "oversize message names the cap");
      assertEq(rejectedDeletes.length, before + 2, "both rejected objects deleted");
      for (const d of rejectedDeletes.slice(before)) {
        assertEq(d.expectedOwner, AM_ID, "delete pinned to the claimant as expected owner");
      }
      assert(!objects.has(keyOf(mintEmpty.json.objectPath)), "empty object removed");
      assert(!objects.has(keyOf(mintBig.json.objectPath)), "oversized object removed");
    });

    let octetFileId = "";
    await step("unknown format is accepted as octet-stream (download-only)", async () => {
      const up = await uploadFile({
        clientId: C_A,
        fileName: `${RUN}-data.xyz`,
        bytes: Buffer.from("BINARYDATA"),
        mime: "application/octet-stream",
      });
      assertEq(up.status, 201, "octet-stream claim");
      octetFileId = up.json.file.id;
      assertEq(up.json.file.mimeType, "application/octet-stream", "stored mime");
      assertEq(Number(up.json.file.sizeBytes), 10, "stored size");
      assertEq(up.json.supersededVersionNumber, undefined, "no version on first upload");
      assertEq(objects.get(keyOf(up.objectPath))!.owner, AM_ID, "ACL owner stamped on claim");
      const browse = await api("GET", `${filesBase}/browse`);
      assert(
        browse.json.files.some((f: any) => f.id === octetFileId),
        "claimed file appears in root browse",
      );
    });

    await step("claim into another client's folder id 404s", async () => {
      actingUserId = OWNER_ID;
      const folderB = await api("POST", `/api/clients/${C_B}/files/folders`, {
        name: `${RUN} B-folder`,
      });
      assertEq(folderB.status, 201, "C_B folder created");
      actingUserId = AM_ID;
      const mint = await api("POST", `${filesBase}/upload-url`, { fileName: "misfile.txt" });
      putObject(mint.json.objectPath, Buffer.from("hi"), "text/plain");
      const r = await api("POST", `${filesBase}/claim`, {
        objectPath: mint.json.objectPath,
        fileName: "misfile.txt",
        folderId: folderB.json.id,
      });
      assertEq(r.status, 404, "foreign folder id");
    });

    // ── 3. Versioning ────────────────────────────────────────────────────
    const PNG1 = Buffer.from("PNG-VERSION-ONE-BYTES");
    const PNG2 = Buffer.from("PNG-VERSION-TWO-DIFFERENT");
    let pngFileId = "";
    let keyV1 = "";
    let keyV2 = "";

    await step("same-name upload keeps the old content as version 1 of the SAME file", async () => {
      const v1 = await uploadFile({
        clientId: C_A,
        fileName: `${RUN}-versioned.png`,
        bytes: PNG1,
        mime: "image/png",
      });
      assertEq(v1.status, 201, "v1 claim");
      pngFileId = v1.json.file.id;
      keyV1 = keyOf(v1.objectPath);
      const v2 = await uploadFile({
        clientId: C_A,
        fileName: `${RUN}-versioned.png`,
        bytes: PNG2,
        mime: "image/png",
      });
      assertEq(v2.status, 201, "v2 claim");
      keyV2 = keyOf(v2.objectPath);
      assertEq(v2.json.file.id, pngFileId, "supersede reuses the same file id");
      assertEq(v2.json.supersededVersionNumber, 1, "old content became version 1");
      const detail = await api("GET", `${filesBase}/${pngFileId}`);
      assertEq(detail.json.versions.length, 1, "one prior version");
      assertEq(detail.json.versions[0].objectKey, keyV1, "version row holds the OLD object");
      assertEq(detail.json.file.objectKey, keyV2, "file row points at the NEW object");
    });

    await step("version download streams the prior bytes", async () => {
      const detail = await api("GET", `${filesBase}/${pngFileId}`);
      const versionId = detail.json.versions[0].id;
      const res = await fetch(
        `${baseUrl}${filesBase}/${pngFileId}/versions/${versionId}/download`,
      );
      assertEq(res.status, 200, "version download");
      const body = Buffer.from(await res.arrayBuffer());
      assertEq(body.toString(), PNG1.toString(), "version bytes are the OLD content");
    });

    await step("version restore swaps current and version content", async () => {
      const detail = await api("GET", `${filesBase}/${pngFileId}`);
      const versionId = detail.json.versions[0].id;
      const r = await api(
        "POST",
        `${filesBase}/${pngFileId}/versions/${versionId}/restore`,
      );
      assertEq(r.status, 200, "restore");
      const after = await api("GET", `${filesBase}/${pngFileId}`);
      assertEq(after.json.file.objectKey, keyV1, "current is the restored (old) object");
      assert(
        after.json.versions.some((v: any) => v.objectKey === keyV2),
        "the superseded current became a version",
      );
      assert(
        after.json.activity.some((a: any) => a.action === "version_restored"),
        "version_restored activity logged",
      );
      const res = await fetch(`${baseUrl}${filesBase}/${pngFileId}/download`);
      const body = Buffer.from(await res.arrayBuffer());
      assertEq(body.toString(), PNG1.toString(), "download now serves restored bytes");
    });

    // ── 4. Rename + folders + move ──────────────────────────────────────
    await step("rename works; renaming onto an existing live name 409s", async () => {
      const ok = await api("PATCH", `${filesBase}/${octetFileId}`, {
        name: `${RUN}-renamed.xyz`,
      });
      assertEq(ok.status, 200, "rename");
      assertEq(ok.json.file?.name ?? ok.json.name, `${RUN}-renamed.xyz`, "new name persisted");
      const clash = await api("PATCH", `${filesBase}/${octetFileId}`, {
        name: `${RUN}-versioned.png`,
      });
      assertEq(clash.status, 409, "rename conflict");
    });

    let docsFolderId = "";
    let subFolderId = "";
    await step("folder create/conflict/cycle guards", async () => {
      const docs = await api("POST", `${filesBase}/folders`, { name: `${RUN} Docs` });
      assertEq(docs.status, 201, "create Docs");
      docsFolderId = docs.json.id;
      const sub = await api("POST", `${filesBase}/folders`, {
        name: `${RUN} Sub`,
        parentId: docsFolderId,
      });
      assertEq(sub.status, 201, "create Sub under Docs");
      subFolderId = sub.json.id;
      const dupe = await api("POST", `${filesBase}/folders`, { name: `${RUN} Docs` });
      assertEq(dupe.status, 409, "duplicate sibling folder name");
      const cycle = await api("PATCH", `${filesBase}/folders/${docsFolderId}`, {
        parentId: subFolderId,
      });
      assertEq(cycle.status, 400, "cycle move rejected");
      assertEq(cycle.json.code, "cycle", "cycle error code");
    });

    await step("files move between folders", async () => {
      const r = await api("POST", `${filesBase}/move`, {
        fileIds: [octetFileId],
        folderId: docsFolderId,
      });
      assertEq(r.status, 200, "move");
      assertEq(r.json.moved, 1, "moved count");
      const root = await api("GET", `${filesBase}/browse`);
      assert(!root.json.files.some((f: any) => f.id === octetFileId), "gone from root");
      const inDocs = await api("GET", `${filesBase}/browse?folderId=${docsFolderId}`);
      assert(inDocs.json.files.some((f: any) => f.id === octetFileId), "listed in Docs");
    });

    // ── 5. Trash lifecycle ──────────────────────────────────────────────
    await step("trash hides from browse; restore returns to the original folder", async () => {
      const t = await api("POST", `${filesBase}/trash-files`, { fileIds: [octetFileId] });
      assertEq(t.status, 200, "trash");
      assertEq(t.json.trashed, 1, "trashed count");
      const inDocs = await api("GET", `${filesBase}/browse?folderId=${docsFolderId}`);
      assert(!inDocs.json.files.some((f: any) => f.id === octetFileId), "hidden from Docs");
      const trash = await api("GET", `${filesBase}/trash`);
      const row = trash.json.files.find((f: any) => f.id === octetFileId);
      assert(row && row.trashedAt, "listed in trash with trashedAt");
      const r = await api("POST", `${filesBase}/restore`, { fileIds: [octetFileId] });
      assertEq(r.json.restored, 1, "restored count");
      const back = await api("GET", `${filesBase}/browse?folderId=${docsFolderId}`);
      assert(back.json.files.some((f: any) => f.id === octetFileId), "back in Docs");
    });

    await step("deleting a folder trashes its files; restore then lands at root", async () => {
      const del = await api("DELETE", `${filesBase}/folders/${docsFolderId}`);
      assertEq(del.status, 200, "delete Docs");
      assertEq(del.json.trashedFileCount, 1, "contained file trashed");
      const tree = await api("GET", `${filesBase}/tree`);
      assert(
        !tree.json.folders.some((f: any) => f.id === docsFolderId || f.id === subFolderId),
        "folder subtree gone from tree",
      );
      const r = await api("POST", `${filesBase}/restore`, { fileIds: [octetFileId] });
      assertEq(r.json.restored, 1, "restore after folder death");
      const root = await api("GET", `${filesBase}/browse`);
      const row = root.json.files.find((f: any) => f.id === octetFileId);
      assert(row, "restored to root when the original folder is gone");
    });

    // Activity rows carry ON DELETE CASCADE on file_id, so a file's
    // lifecycle entries (uploaded/renamed/moved/trashed/restored) vanish when
    // the file row is purged — only the client-level `purged` tombstone
    // (file_id NULL) survives. Assert the full lifecycle BEFORE the purge.
    await step("activity feed records the full lifecycle before purge", async () => {
      const r = await api("GET", `${filesBase}/activity`);
      assertEq(r.status, 200, "activity");
      const actions = new Set(r.json.activity.map((a: any) => a.action));
      for (const expected of [
        "uploaded",
        "renamed",
        "moved",
        "trashed",
        "restored",
        "version_restored",
        "folder_created",
        "folder_deleted",
      ]) {
        assert(actions.has(expected), `pre-purge activity includes ${expected}`);
      }
      assert(
        r.json.activity.some((a: any) => a.actorName === "Task4023 Manager"),
        "actor name denormalized onto entries",
      );
    });

    await step("purge deletes storage objects first and drops the rows", async () => {
      await api("POST", `${filesBase}/trash-files`, { fileIds: [octetFileId] });
      const detail = await api("GET", `${filesBase}/${octetFileId}`);
      const objectKey = detail.json.file.objectKey as string;
      const before = deletedKeys.length;
      const r = await api("POST", `${filesBase}/purge`, { fileIds: [octetFileId] });
      assertEq(r.status, 200, "purge");
      assert(deletedKeys.slice(before).includes(objectKey), "current object deleted from storage");
      assert(!objects.has(objectKey), "object gone from the fake bucket");
      assertEq((await api("GET", `${filesBase}/${octetFileId}`)).status, 404, "row gone");
      const activity = await api("GET", `${filesBase}/activity`);
      assert(
        activity.json.activity.some(
          (a: any) => a.action === "purged" && a.detail?.name === `${RUN}-renamed.xyz`,
        ),
        "client-level purged activity kept (fileId-free)",
      );
    });

    // ── 6. Download headers ─────────────────────────────────────────────
    let binFileId = "";
    await step("download headers: DB mime, inline only when whitelisted", async () => {
      const up = await uploadFile({
        clientId: C_A,
        fileName: `${RUN}-blob.bin`,
        bytes: Buffer.from("RAWBYTES"),
        mime: "application/octet-stream",
      });
      assertEq(up.status, 201, "bin claim");
      binFileId = up.json.file.id;

      const plain = await fetch(`${baseUrl}${filesBase}/${pngFileId}/download`);
      assertEq(plain.headers.get("content-type"), "image/png", "DB-derived content type");
      assert(
        String(plain.headers.get("content-disposition")).startsWith("attachment"),
        "attachment by default",
      );
      assertEq(plain.headers.get("x-content-type-options"), "nosniff", "nosniff");
      assertEq(plain.headers.get("cache-control"), "private, no-store", "no-store");
      await plain.arrayBuffer();

      const inline = await fetch(
        `${baseUrl}${filesBase}/${pngFileId}/download?disposition=inline`,
      );
      assert(
        String(inline.headers.get("content-disposition")).startsWith("inline"),
        "png may render inline when requested",
      );
      await inline.arrayBuffer();

      const binInline = await fetch(
        `${baseUrl}${filesBase}/${binFileId}/download?disposition=inline`,
      );
      assert(
        String(binInline.headers.get("content-disposition")).startsWith("attachment"),
        "octet-stream NEVER renders inline even when requested",
      );
      await binInline.arrayBuffer();
    });

    // ── 7. Usage, global library, zip, activity ─────────────────────────
    await step("per-client usage rollup counts live/version/trash state", async () => {
      const r = await api("GET", `${filesBase}/usage`);
      assertEq(r.status, 200, "usage");
      const u = r.json;
      assertEq(u.liveCount, 2, "two live files (png + bin)");
      assertEq(u.versionCount, 1, "one version row");
      assertEq(u.trashCount, 0, "trash empty after purge");
      assertEq(
        Number(u.liveBytes),
        PNG1.length + 8,
        "live bytes = restored png + RAWBYTES bin",
      );
      assertEq(Number(u.versionBytes), PNG2.length, "version bytes = superseded content");
      assertEq(Number(u.totalBytes), PNG1.length + 8 + PNG2.length, "total = live + versions");
    });

    await step("global search spans clients, carries firm names, filters by kind", async () => {
      actingUserId = OWNER_ID;
      const upB = await uploadFile({
        clientId: C_B,
        fileName: `${RUN}-beta-notes.txt`,
        bytes: Buffer.from("beta client notes"),
        mime: "text/plain",
      });
      assertEq(upB.status, 201, "owner uploads into C_B");
      actingUserId = AM_ID;
      const all = await api("GET", `/api/files?q=${RUN}`);
      assertEq(all.status, 200, "global search");
      const firms = new Set(all.json.files.map((f: any) => f.firmName));
      assert(firms.has(`${RUN} Alpha Firm`), "Alpha firm files present");
      assert(firms.has(`${RUN} Beta Firm`), "Beta firm files present");
      const images = await api("GET", `/api/files?q=${RUN}&kind=image`);
      assert(
        images.json.files.length >= 1 &&
          images.json.files.every((f: any) => String(f.mimeType).startsWith("image/")),
        "kind=image returns only images",
      );
      const recent = await api("GET", "/api/files/recent?limit=50");
      assert(
        recent.json.files.some((f: any) => f.id === pngFileId),
        "recent lists the fresh upload",
      );

      // ---- server-side pagination/sort (Task #4488) ----
      const recentPaged = await api(
        "GET",
        "/api/files/recent?sort=name&dir=asc&limit=2&offset=0",
      );
      assertEq(recentPaged.status, 200, "recent accepts sort/limit/offset");
      assert(recentPaged.json.files.length <= 2, "recent honors limit");
      assert(
        typeof recentPaged.json.total === "number" &&
          recentPaged.json.total >= recentPaged.json.files.length,
        "recent returns a full-set total",
      );
      const recentNames = recentPaged.json.files.map((f: any) =>
        String(f.name).toLowerCase(),
      );
      assert(
        [...recentNames].sort().join("|") === recentNames.join("|"),
        "recent page is name-asc sorted server-side",
      );
      const recentPage2 = await api(
        "GET",
        "/api/files/recent?sort=name&dir=asc&limit=2&offset=2",
      );
      assertEq(recentPage2.status, 200, "recent offset page");
      assert(
        !recentPage2.json.files.some((f: any) =>
          recentPaged.json.files.some((g: any) => g.id === f.id),
        ),
        "offset page does not repeat page-1 rows",
      );
      assertEq(
        (await api("GET", "/api/files/recent?limit=0")).status,
        400,
        "recent rejects limit below 1",
      );
      // New sort keys reachable through search too.
      const byClient = await api(
        "GET",
        `/api/files?q=${RUN}&sort=client&dir=asc&limit=2&offset=0`,
      );
      assertEq(byClient.status, 200, "search accepts sort=client");
      assert(byClient.json.files.length <= 2, "search honors limit");
      const byFolder = await api(
        "GET",
        `/api/files?q=${RUN}&sort=folder&dir=desc&limit=5&offset=0`,
      );
      assertEq(byFolder.status, 200, "search accepts sort=folder");
    });

    await step("global routes are role-gated (AM+ search, TL+ usage)", async () => {
      actingUserId = LOW_ID;
      assertEq((await api("GET", `/api/files?q=${RUN}`)).status, 403, "sales role search");
      actingUserId = OWNER_ID;
      assertEq(
        (await api("GET", `/api/files?q=${RUN}`)).status,
        403,
        "ownership grants client access, never the global library",
      );
      actingUserId = AM_ID;
      assertEq((await api("GET", "/api/files/usage")).status, 403, "AM below usage gate");
      actingUserId = TL_ID;
      const usage = await api("GET", "/api/files/usage");
      assertEq(usage.status, 200, "team lead usage");
      const row = usage.json.clients.find((c: any) => c.clientId === C_A);
      assert(row, "usage lists C_A");
      assertEq(row.liveCount, 2, "usage row live count matches per-client rollup");
      actingUserId = AM_ID;
    });

    await step("bulk zip streams a zip of the selected files", async () => {
      const res = await fetch(`${baseUrl}${filesBase}/zip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileIds: [pngFileId, binFileId] }),
      });
      assertEq(res.status, 200, "zip");
      assertEq(res.headers.get("content-type"), "application/zip", "zip content type");
      const body = Buffer.from(await res.arrayBuffer());
      assert(body.length > 4 && body[0] === 0x50 && body[1] === 0x4b, "PK zip magic");
    });

    await step("post-purge activity keeps the client-level purged tombstone", async () => {
      const r = await api("GET", `${filesBase}/activity`);
      assertEq(r.status, 200, "activity");
      const actions = new Set(r.json.activity.map((a: any) => a.action));
      // Rows for surviving files/folders remain; the purged file's per-file
      // rows cascaded away, leaving the file_id-NULL tombstone.
      for (const expected of ["uploaded", "purged", "version_restored", "folder_created", "folder_deleted"]) {
        assert(actions.has(expected), `post-purge activity includes ${expected}`);
      }
      const tombstone = r.json.activity.find((a: any) => a.action === "purged");
      assert(tombstone && tombstone.fileId === null, "purged tombstone has fileId NULL");
      assert(
        r.json.activity.some((a: any) => a.actorName === "Task4023 Manager"),
        "actor name denormalized onto entries",
      );
    });
  } finally {
    server.closeAllConnections?.();
    server.close();
    await cleanup();
    // Route tests hang on undici keep-alive sockets otherwise.
    try {
      const { getGlobalDispatcher } = await import("undici");
      await getGlobalDispatcher().close();
    } catch {}
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll client-files route tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
let exitCode = 0;
main()
  .catch((err) => {
    console.error("client-files-routes: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
