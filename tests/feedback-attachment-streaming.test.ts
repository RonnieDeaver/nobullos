/* test-registration
{
  "name": "Feedback attachment streaming handler \u2014 real handler ACL + streaming (Task #2421)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2421 — end-to-end coverage for the REAL feedback attachment streaming
 * handler (`GET /api/feedback/:id/attachment`).
 *
 * The Task #2415 test only re-created the auth middleware chain on a minimal app
 * with a placeholder handler, so it never exercised the handler's actual ACL +
 * namespace + streaming logic. Now that the handler is extracted into
 * `server/routes/feedbackAttachment.ts`, this test mounts the EXACT handler
 * `registerRoutes` mounts (behind the same intent) and drives it against a fake
 * Object Storage service + a fake DB — no Replit Object Storage call is made.
 *
 * Pinned behavior:
 *   1. A path outside the feedback namespace is rejected (400) before any
 *      storage call — namespace confinement.
 *   2. A path not in the row's stored `screenshots` list is rejected (404).
 *   3. A path whose object ACL owner != the feedback submitter is rejected (403)
 *      — the `canStreamFeedbackAttachment` provenance check; nothing is streamed.
 *   4. A valid in-namespace, listed, owner-matched path streams the object bytes
 *      via `downloadObject`.
 *   5. A missing feedback row is a 404; an ObjectNotFoundError from storage is a
 *      404 (not a 500).
 */
import assert from "node:assert/strict";
import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { Response } from "express";

import { FEEDBACK_ATTACHMENT_PREFIX } from "@shared/attachments";
import { ObjectNotFoundError } from "../server/replit_integrations/object_storage";
import {
  createFeedbackAttachmentHandler,
  type FeedbackAttachmentStorage,
  type FeedbackAttachmentDb,
} from "../server/routes/feedbackAttachment";

const OWNER = "user-owner";
const ATTACKER = "user-attacker";
const GOOD_PATH = `${FEEDBACK_ATTACHMENT_PREFIX}${randomUUID()}.png`;
const OTHER_NS_PATH = "/objects/uploads/forged.png";
const BODY = Buffer.from("the-attachment-bytes");

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

// ── A fake DB returning a single canned feedback row in the same shape
//    `db.execute(...).rows` produces for the handler's SELECT. Each test app
//    serves exactly one id, so the query itself is irrelevant — pass `null`
//    to model a missing row. ──────────────────────────────────────────────
interface FakeRow {
  user_id: string | null;
  screenshots: string;
}
function makeDb(row: FakeRow | null): FeedbackAttachmentDb {
  return {
    async execute() {
      return { rows: row ? [row] : [] };
    },
  };
}

// ── A fake Object Storage service recording what it was asked to stream. ───
interface FakeStorageOpts {
  aclOwner?: string | null;
  throwNotFoundOnFile?: boolean;
}
function makeStorage(opts: FakeStorageOpts) {
  const calls = { downloads: 0, lastFile: undefined as unknown };
  const storage: FeedbackAttachmentStorage = {
    async getObjectEntityAclPolicy() {
      return { owner: opts.aclOwner ?? null };
    },
    async getObjectEntityFile(path: string) {
      if (opts.throwNotFoundOnFile) throw new ObjectNotFoundError();
      return { __fakeFile: path };
    },
    async downloadObject(file: unknown, res: Response) {
      calls.downloads += 1;
      calls.lastFile = file;
      res.setHeader("Content-Type", "image/png");
      res.status(200).end(BODY);
    },
  };
  return { storage, calls };
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function get(
  baseUrl: string,
  id: number | string,
  path: string,
): Promise<{ status: number; bodyText: string }> {
  const url = `${baseUrl}/api/feedback/${id}/attachment?path=${encodeURIComponent(path)}`;
  const r = await fetch(url, { method: "GET" });
  return { status: r.status, bodyText: await r.text() };
}

async function main(): Promise<void> {
  console.log("Feedback attachment streaming handler (Task #2421)");

  await step("out-of-namespace path is rejected (400) without touching storage", async () => {
    const { storage, calls } = makeStorage({ aclOwner: OWNER });
    const db = makeDb({ user_id: OWNER, screenshots: JSON.stringify([OTHER_NS_PATH]) });
    const app = express();
    app.get("/api/feedback/:id/attachment", createFeedbackAttachmentHandler({ storage, db }));
    const { server, baseUrl } = await listen(app);
    try {
      const r = await get(baseUrl, 1, OTHER_NS_PATH);
      assert.equal(r.status, 400, "non-namespaced path → 400");
      assert.equal(calls.downloads, 0, "nothing is streamed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await step("path not in the row's stored list is rejected (404)", async () => {
    const { storage, calls } = makeStorage({ aclOwner: OWNER });
    // Row has NO attachments, so the requested in-namespace path is not listed.
    const db = makeDb({ user_id: OWNER, screenshots: "[]" });
    const app = express();
    app.get("/api/feedback/:id/attachment", createFeedbackAttachmentHandler({ storage, db }));
    const { server, baseUrl } = await listen(app);
    try {
      const r = await get(baseUrl, 2, GOOD_PATH);
      assert.equal(r.status, 404, "unlisted path → 404");
      assert.equal(calls.downloads, 0, "nothing is streamed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await step("path owned by a different user is rejected (403); nothing streamed", async () => {
    const { storage, calls } = makeStorage({ aclOwner: ATTACKER });
    const db = makeDb({ user_id: OWNER, screenshots: JSON.stringify([GOOD_PATH]) });
    const app = express();
    app.get("/api/feedback/:id/attachment", createFeedbackAttachmentHandler({ storage, db }));
    const { server, baseUrl } = await listen(app);
    try {
      const r = await get(baseUrl, 3, GOOD_PATH);
      assert.equal(r.status, 403, "owner mismatch → 403");
      assert.equal(calls.downloads, 0, "forged/owner-mismatched object is never streamed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await step("valid in-namespace, listed, owner-matched path streams the bytes", async () => {
    const { storage, calls } = makeStorage({ aclOwner: OWNER });
    const db = makeDb({ user_id: OWNER, screenshots: JSON.stringify([GOOD_PATH]) });
    const app = express();
    app.get("/api/feedback/:id/attachment", createFeedbackAttachmentHandler({ storage, db }));
    const { server, baseUrl } = await listen(app);
    try {
      const r = await get(baseUrl, 4, GOOD_PATH);
      assert.equal(r.status, 200, "valid request → 200");
      assert.equal(r.bodyText, BODY.toString(), "the object bytes are streamed back");
      assert.equal(calls.downloads, 1, "downloadObject is invoked exactly once");
      assert.deepEqual(calls.lastFile, { __fakeFile: GOOD_PATH }, "the resolved file is streamed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await step("missing feedback row is a 404", async () => {
    const { storage, calls } = makeStorage({ aclOwner: OWNER });
    const db = makeDb(null); // no rows
    const app = express();
    app.get("/api/feedback/:id/attachment", createFeedbackAttachmentHandler({ storage, db }));
    const { server, baseUrl } = await listen(app);
    try {
      const r = await get(baseUrl, 99, GOOD_PATH);
      assert.equal(r.status, 404, "no such feedback row → 404");
      assert.equal(calls.downloads, 0, "nothing is streamed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await step("ObjectNotFoundError from storage maps to 404 (not 500)", async () => {
    const { storage } = makeStorage({ aclOwner: OWNER, throwNotFoundOnFile: true });
    const db = makeDb({ user_id: OWNER, screenshots: JSON.stringify([GOOD_PATH]) });
    const app = express();
    app.get("/api/feedback/:id/attachment", createFeedbackAttachmentHandler({ storage, db }));
    const { server, baseUrl } = await listen(app);
    try {
      const r = await get(baseUrl, 5, GOOD_PATH);
      assert.equal(r.status, 404, "deleted/absent object → 404");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nAll feedback attachment streaming tests passed");
}

let exitCode = 0;
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    try {
      const { closeGlobalDispatcher } = await import("undici");
      await closeGlobalDispatcher();
    } catch {}
    process.exitCode = exitCode;
  });
