/* test-registration
{
  "name": "Client file external share links (Task #4028)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4028: public, unauthenticated token-gated file serving. A drift here either lets garbage/expired/revoked tokens serve private client files (data leak to anyone with an old link) or breaks the only external hand-off path staff have for client documents. Covers token minting authz, exact-one-file serving, expiry/revocation/trash gates, activity logging, and that the DB stores only the token hash.",
  "tier": "small"
}
test-registration */
/**
 * Task #4028 — external share-link coverage.
 *
 * Same harness as tests/client-files-routes.test.ts: REAL routes on a real
 * Express app with the Clerk per-request test seam and a fake object
 * storage seam. Steps:
 *
 *   1. Mint authz — 401 unauthenticated, 403 low-role non-owner, 404 for a
 *      file of another client; trashed files can't be shared.
 *   2. Valid token — serves EXACTLY the shared file's bytes without any
 *      session, headers come from the DB row (nosniff, no-store); the raw
 *      token never appears in the DB (only its sha256); access bumps
 *      access_count and logs a "downloaded" via share_link activity row.
 *   3. Guardrails — garbage-shaped token, well-shaped-but-unknown token,
 *      EXPIRED token (expires_at moved into the past), REVOKED token, and a
 *      token whose file was trashed all get the static gone page (404/410,
 *      text/html) and never bytes.
 *   4. Listing + revoke — links list per file with status fields; revoke is
 *      idempotent; "shared"/"share_revoked" land in the activity log.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  registerClientFileRoutes,
  type ClientFileStorage,
} from "../server/routes/clientFiles";
import { shareFileLimiter } from "../server/routes/middleware";
import { SHARE_FILE_PATHS } from "../server/routes/limiterMounts";
import { ObjectNotFoundError } from "../server/replit_integrations/object_storage/objectStorage";
import type { GeneralUploadVerdict } from "../server/replit_integrations/object_storage/generalUploadSniff";

const HEX = randomBytes(4).toString("hex");
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const RUN = `t4028-${HEX}`;

const C_A = `a4028a01-${HEX}-${randomBytes(3).toString("hex")}`;
const C_B = `b4028b02-${HEX}-${randomBytes(3).toString("hex")}`;

const AM_ID = `${RUN}-am`;   // account_manager → full access
const LOW_ID = `${RUN}-low`; // 'sales', owns nothing → 403

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ── Fake object storage (bucket = Map keyed by storage key) ────────────────

interface FakeObject {
  bytes: Buffer;
  mime: string;
  owner: string | null;
}
const objects = new Map<string, FakeObject>();
const keyOf = (p: string) => p.replace(/^\/objects\//, "");
function putObject(objectPath: string, bytes: Buffer, mime: string): void {
  objects.set(keyOf(objectPath), { bytes, mime, owner: null });
}

const fakeStorage: ClientFileStorage = {
  async getClientFileUploadURL(clientId, opts) {
    const ext =
      opts?.extension && /^\.[a-z0-9]{1,5}$/.test(opts.extension) ? opts.extension : "";
    const leaf = `${randomBytes(8).toString("hex")}${ext}`;
    return {
      uploadUrl: `https://fake-bucket.invalid/put/${leaf}`,
      objectPath: `/objects/client-files/${clientId}/${leaf}`,
    };
  },
  async getObjectEntityAclPolicy(objectPath) {
    const rec = objects.get(keyOf(objectPath));
    if (!rec) throw new ObjectNotFoundError();
    return { owner: rec.owner };
  },
  async verifyClientFileObjectContent(objectPath, opts): Promise<GeneralUploadVerdict> {
    const rec = objects.get(keyOf(objectPath));
    if (!rec) throw new ObjectNotFoundError();
    if (rec.bytes.length <= 0) {
      return { ok: false, reason: "empty_object", detail: "empty", sizeBytes: 0 };
    }
    if (rec.bytes.length > opts.maxBytes) {
      return { ok: false, reason: "too_large", detail: "big", sizeBytes: rec.bytes.length };
    }
    return { ok: true, sizeBytes: rec.bytes.length, mime: rec.mime, format: "fake" };
  },
  async trySetObjectEntityAclPolicy(objectPath, policy) {
    const rec = objects.get(keyOf(objectPath));
    if (rec) rec.owner = policy.owner;
    return undefined;
  },
  async deleteRejectedUploadObject(objectPath) {
    return objects.delete(keyOf(objectPath));
  },
  async deletePrivateObjectByKey(objectKey) {
    return objects.delete(objectKey);
  },
  async createPrivateObjectReadStream(objectKey) {
    const rec = objects.get(objectKey);
    if (!rec) throw new ObjectNotFoundError();
    return Readable.from(rec.bytes);
  },
};

// ── Harness ─────────────────────────────────────────────────────────────────

let actingUserId: string | null = AM_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  // Task #4041 — mirror production: the public share prefix is mounted under
  // the IP-keyed shareFileLimiter in server/boot/httpApp.ts. Mounting the
  // REAL limiter here lets the download step assert RateLimit headers are on
  // the actual public response.
  for (const sharePath of SHARE_FILE_PATHS) {
    app.use(sharePath, shareFileLimiter);
  }
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
): Promise<{ status: number; json: any; res: globalThis.Response; text: string }> {
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
  return { status: res.status, json, res, text };
}

async function uploadFile(args: {
  clientId: string;
  fileName: string;
  bytes: Buffer;
  mime: string;
}): Promise<any> {
  const mint = await api("POST", `/api/clients/${args.clientId}/files/upload-url`, {
    fileName: args.fileName,
  });
  assertEq(mint.status, 200, `upload-url for ${args.fileName}`);
  putObject(mint.json.objectPath, args.bytes, args.mime);
  const claim = await api("POST", `/api/clients/${args.clientId}/files/claim`, {
    objectPath: mint.json.objectPath,
    fileName: args.fileName,
  });
  assertEq(claim.status, 201, `claim ${args.fileName}`);
  return claim.json.file;
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${AM_ID}, ${`${AM_ID}@t4028.example`}, 'Task4028', 'Manager', 'account_manager', 'core'),
      (${LOW_ID}, ${`${LOW_ID}@t4028.example`}, 'Task4028', 'Low', 'sales', 'core')
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES
      (${C_A}, ${`T4028 Firm A ${HEX}`}, NULL, false, true),
      (${C_B}, ${`T4028 Firm B ${HEX}`}, NULL, false, true)
  `);
}

async function cleanup(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM clients WHERE id IN (${C_A}, ${C_B})`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM users WHERE id IN (${AM_ID}, ${LOW_ID})`);
  } catch {}
}

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

  const baseA = `/api/clients/${C_A}/files`;
  const BYTES_A = Buffer.from(`share-me-${RUN}`);
  const BYTES_B = Buffer.from(`other-file-${RUN}`);

  try {
    actingUserId = AM_ID;
    const fileA = await uploadFile({
      clientId: C_A,
      fileName: "contract.txt",
      bytes: BYTES_A,
      mime: "text/plain",
    });
    const fileB = await uploadFile({
      clientId: C_B,
      fileName: "unrelated.txt",
      bytes: BYTES_B,
      mime: "text/plain",
    });

    // ── 1. Mint authz ─────────────────────────────────────────────────────
    await step("share mint requires auth + client access", async () => {
      actingUserId = null;
      assertEq(
        (await api("POST", `${baseA}/${fileA.id}/shares`, {})).status,
        401,
        "unauthenticated mint",
      );
      actingUserId = LOW_ID;
      assertEq(
        (await api("POST", `${baseA}/${fileA.id}/shares`, {})).status,
        403,
        "low-role mint",
      );
      actingUserId = AM_ID;
      // File belongs to client B — minting via client A's path 404s.
      assertEq(
        (await api("POST", `${baseA}/${fileB.id}/shares`, {})).status,
        404,
        "cross-client file mint",
      );
    });

    // ── 2. Valid token round trip ─────────────────────────────────────────
    let tokenA = "";
    let shareAId = "";
    await step("valid token serves exactly the shared file, no session", async () => {
      actingUserId = AM_ID;
      const mint = await api("POST", `${baseA}/${fileA.id}/shares`, { expiresInDays: 7 });
      assertEq(mint.status, 201, "mint share");
      tokenA = mint.json.token;
      shareAId = mint.json.share.id;
      assert(typeof tokenA === "string" && tokenA.length >= 40, "token shape");
      assertEq(mint.json.path, `/share/file/${tokenA}`, "share path");
      assert(!("tokenHash" in mint.json.share), "share row must not expose tokenHash");

      // DB stores only the sha256 of the token — never the raw token.
      const dbRow = await db.execute(sql`
        SELECT token_hash FROM client_file_share_links WHERE id = ${shareAId}
      `);
      const storedHash = (dbRow as any).rows[0]?.token_hash;
      assertEq(
        storedHash,
        createHash("sha256").update(tokenA).digest("hex"),
        "stored hash = sha256(token)",
      );
      assert(storedHash !== tokenA, "raw token must not be stored");

      actingUserId = null; // no session at all
      const pub = await api("GET", `/share/file/${tokenA}`);
      assertEq(pub.status, 200, "public download status");
      assertEq(pub.text, BYTES_A.toString(), "exact shared bytes");
      assertEq(
        pub.res.headers.get("x-content-type-options"),
        "nosniff",
        "nosniff header",
      );
      assertEq(
        pub.res.headers.get("cache-control"),
        "private, no-store",
        "no-store header",
      );
      assert(pub.text !== BYTES_B.toString(), "never another file's bytes");

      // Task #4041 — the public prefix is mounted under the IP-keyed
      // shareFileLimiter (standardHeaders: true), so every response must
      // carry a RateLimit header. This proves the mount is actually in the
      // request path without exhausting the bucket.
      assert(
        (pub.res.headers.get("ratelimit-limit") ?? pub.res.headers.get("ratelimit")) !== null,
        "public share download is rate-limited (RateLimit headers present)",
      );

      // ?download=1 forces attachment disposition.
      const dl = await api("GET", `/share/file/${tokenA}?download=1`);
      assert(
        (dl.res.headers.get("content-disposition") ?? "").startsWith("attachment"),
        "download=1 forces attachment",
      );
    });

    await step("access is counted and logged in the activity trail", async () => {
      const row = await db.execute(sql`
        SELECT access_count FROM client_file_share_links WHERE id = ${shareAId}
      `);
      assert(Number((row as any).rows[0]?.access_count) >= 2, "access_count bumped");
      actingUserId = AM_ID;
      const detail = await api("GET", `${baseA}/${fileA.id}`);
      const acts = (detail.json.activity as any[]).map((a) => a.action);
      assert(acts.includes("shared"), "'shared' activity logged");
      assert(
        (detail.json.activity as any[]).some(
          (a) => a.action === "downloaded" && a.detail?.via === "share_link",
        ),
        "share download logged with via=share_link",
      );
    });

    // ── 3. Guardrails ─────────────────────────────────────────────────────
    await step("garbage and unknown tokens are rejected with the gone page", async () => {
      actingUserId = null;
      const garbage = await api("GET", `/share/file/not-a-token`);
      assertEq(garbage.status, 404, "garbage-shaped token");
      assert(
        (garbage.res.headers.get("content-type") ?? "").includes("text/html"),
        "gone page is html",
      );
      const unknown = await api(
        "GET",
        `/share/file/${randomBytes(32).toString("base64url")}`,
      );
      assertEq(unknown.status, 404, "well-shaped unknown token");
      assert(!unknown.text.includes(BYTES_A.toString()), "no bytes leak");
    });

    await step("expired token is rejected", async () => {
      await db.execute(sql`
        UPDATE client_file_share_links
        SET expires_at = now() - interval '1 hour'
        WHERE id = ${shareAId}
      `);
      actingUserId = null;
      const r = await api("GET", `/share/file/${tokenA}`);
      assertEq(r.status, 410, "expired token status");
      assert(!r.text.includes(BYTES_A.toString()), "expired serves no bytes");
      // restore for the revoke steps below
      await db.execute(sql`
        UPDATE client_file_share_links
        SET expires_at = now() + interval '1 day'
        WHERE id = ${shareAId}
      `);
    });

    await step("revoked token is rejected; revoke is idempotent + logged", async () => {
      actingUserId = AM_ID;
      const rev = await api("DELETE", `${baseA}/${fileA.id}/shares/${shareAId}`);
      assertEq(rev.status, 200, "revoke");
      assert(rev.json.revokedAt, "revokedAt set");
      const again = await api("DELETE", `${baseA}/${fileA.id}/shares/${shareAId}`);
      assertEq(again.status, 200, "revoke idempotent");
      actingUserId = null;
      const r = await api("GET", `/share/file/${tokenA}`);
      assertEq(r.status, 410, "revoked token status");
      actingUserId = AM_ID;
      const detail = await api("GET", `${baseA}/${fileA.id}`);
      assert(
        (detail.json.activity as any[]).some((a) => a.action === "share_revoked"),
        "'share_revoked' activity logged",
      );
    });

    await step("trashed file's live token is rejected; trashed files can't be shared", async () => {
      actingUserId = AM_ID;
      const mint = await api("POST", `${baseA}/${fileA.id}/shares`, { expiresInDays: 1 });
      assertEq(mint.status, 201, "fresh share");
      const freshToken = mint.json.token;
      assertEq(
        (await api("POST", `${baseA}/trash-files`, { fileIds: [fileA.id] })).status,
        200,
        "trash file",
      );
      actingUserId = null;
      assertEq(
        (await api("GET", `/share/file/${freshToken}`)).status,
        410,
        "token for trashed file",
      );
      actingUserId = AM_ID;
      assertEq(
        (await api("POST", `${baseA}/${fileA.id}/shares`, {})).status,
        400,
        "cannot share a trashed file",
      );
    });

    // ── 4. Listing ────────────────────────────────────────────────────────
    await step("share list shows all links with status fields", async () => {
      actingUserId = AM_ID;
      const list = await api("GET", `${baseA}/${fileA.id}/shares`);
      assertEq(list.status, 200, "list status");
      const shares = list.json.shares as any[];
      assert(shares.length >= 2, "both links listed");
      assert(shares.every((s) => !("tokenHash" in s)), "list never exposes tokenHash");
      assert(shares.some((s) => s.revokedAt), "revoked link visible");
    });

    // ── 5. Replace (Task #4040) ───────────────────────────────────────────
    await step("replace revokes the old link and mints a fresh one with the same expiry", async () => {
      // fileA was trashed above — restore it so it can be shared again.
      actingUserId = AM_ID;
      assertEq(
        (await api("POST", `${baseA}/restore`, { fileIds: [fileA.id] })).status,
        200,
        "restore file",
      );
      const mint = await api("POST", `${baseA}/${fileA.id}/shares`, { expiresInDays: 30 });
      assertEq(mint.status, 201, "mint share to replace");
      const oldToken = mint.json.token;
      const oldId = mint.json.share.id;
      const oldExpiry = mint.json.share.expiresAt;

      actingUserId = null;
      assertEq(
        (await api("POST", `${baseA}/${fileA.id}/shares/${oldId}/replace`)).status,
        401,
        "unauthenticated replace",
      );
      actingUserId = LOW_ID;
      assertEq(
        (await api("POST", `${baseA}/${fileA.id}/shares/${oldId}/replace`)).status,
        403,
        "low-role replace",
      );

      actingUserId = AM_ID;
      const rep = await api("POST", `${baseA}/${fileA.id}/shares/${oldId}/replace`);
      assertEq(rep.status, 201, "replace status");
      const newToken = rep.json.token;
      const newId = rep.json.share.id;
      assert(newToken && newToken !== oldToken, "fresh token issued");
      assert(newId !== oldId, "fresh share row");
      assertEq(rep.json.path, `/share/file/${newToken}`, "new share path");
      assert(!("tokenHash" in rep.json.share), "replace never exposes tokenHash");
      assertEq(
        rep.json.share.expiresAt,
        oldExpiry,
        "replacement keeps the old expiry (no silent extension)",
      );

      actingUserId = null;
      assertEq((await api("GET", `/share/file/${oldToken}`)).status, 410, "old token dead");
      const pub = await api("GET", `/share/file/${newToken}`);
      assertEq(pub.status, 200, "new token serves");
      assertEq(pub.text, BYTES_A.toString(), "new token serves same file bytes");

      actingUserId = AM_ID;
      // Replacing a revoked (non-active) link is rejected.
      assertEq(
        (await api("POST", `${baseA}/${fileA.id}/shares/${oldId}/replace`)).status,
        400,
        "cannot replace a revoked link",
      );
      // Unknown share id 404s.
      assertEq(
        (
          await api(
            "POST",
            `${baseA}/${fileA.id}/shares/00000000-0000-4000-8000-000000000000/replace`,
          )
        ).status,
        404,
        "unknown share id",
      );
      const detail = await api("GET", `${baseA}/${fileA.id}`);
      assert(
        (detail.json.activity as any[]).some((a) => a.action === "share_replaced"),
        "'share_replaced' activity logged",
      );
    });

    await step("concurrent replace mints exactly one replacement", async () => {
      actingUserId = AM_ID;
      const mint = await api("POST", `${baseA}/${fileA.id}/shares`, { expiresInDays: 7 });
      assertEq(mint.status, 201, "mint share for concurrent replace");
      const sid = mint.json.share.id;
      // Two simultaneous replaces race on the conditional revoke — exactly
      // one may claim the row and mint; the other must get the 400.
      const [r1, r2] = await Promise.all([
        api("POST", `${baseA}/${fileA.id}/shares/${sid}/replace`),
        api("POST", `${baseA}/${fileA.id}/shares/${sid}/replace`),
      ]);
      const statuses = [r1.status, r2.status].sort();
      assertEq(statuses[0], 201, "exactly one replace succeeds (winner)");
      assertEq(statuses[1], 400, "exactly one replace succeeds (loser 400)");
      const active = await db.execute(sql`
        SELECT count(*)::int AS n FROM client_file_share_links
        WHERE file_id = ${fileA.id} AND revoked_at IS NULL AND expires_at > now()
          AND id <> ${sid}
          AND created_at >= (SELECT created_at FROM client_file_share_links WHERE id = ${sid})
      `);
      assertEq(Number((active as any).rows[0]?.n), 1, "exactly one active replacement row");
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

  if (failures > 0) throw new Error(`${failures} step(s) failed`);
  console.log("\nAll client-file share-link steps passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
let exitCode = 0;
main()
  .catch((err) => {
    console.error("client-file-shares: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
