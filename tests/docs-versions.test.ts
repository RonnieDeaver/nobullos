/* test-registration
{
  "name": "NoBull Docs — version history, auto-capture & restore (Task #4024)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4024: version safety net for the docs editor. Covers auto-version capture on snapshot save (with the 5-minute throttle), manual Save-version checkpoints, metadata-only list vs full-snapshot get, and restore (including the restore-point capture that makes restores undoable). A regression here silently loses users' recovery points.",
  "tier": "small"
}
test-registration */
/**
 * NoBull Docs — version history tests (Task #4024).
 *
 * Same harness as tests/docs-routes.test.ts (loopback HTTP against the real
 * routes, hermetic per-run test DB).
 */

// Self-establish test mode so the Clerk per-request auth seam is honored even
// under a bare `tsx` repro (requireAuth reads NODE_ENV at request time).
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import { createServer } from "http";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

// Clerk test seam (server/middlewares/requireAuth.ts): a string authenticates
// as that user id. The owner is seeded in an isolated schema (uncommitted to
// public), so it is pre-registered via __test_markUserReconciled — requireAuth
// then populates req.user/req.dbUser from that profile.
function makeAuthMiddleware(userId: string, _role: string) {
  return (_req: any, _res: any, next: any) => {
    _req.__test_clerkUserId = userId;
    next();
  };
}

let baseUrl = "";
let server: ReturnType<typeof createServer>;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
let currentAgent: Agent | null = null;

async function startServer(app: express.Express): Promise<void> {
  originalDispatcher = getGlobalDispatcher();
  currentAgent = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 });
  setGlobalDispatcher(currentAgent);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function stopServer(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setGlobalDispatcher(originalDispatcher);
  if (currentAgent) {
    try {
      await currentAgent.close();
    } catch {
      /* ignore */
    }
    currentAgent = null;
  }
}

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: any;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

let passed = 0;
let failed = 0;
function ok(label: string) {
  passed++;
  console.log(`  ✓ ${label}`);
}

function docSnapshot(text: string) {
  const dataStream = `${text}\r\n`;
  return {
    id: `d-${randomUUID().slice(0, 8)}`,
    body: {
      dataStream,
      textRuns: [],
      paragraphs: [{ startIndex: text.length }],
      sectionBreaks: [{ startIndex: dataStream.length - 1 }],
    },
    documentStyle: { pageSize: { width: 595, height: 842 } },
  };
}

/** Poll until `check` passes or ~3 s elapse (fire-and-forget writes). */
async function pollUntil(check: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 15; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function run() {
  await runInIsolatedSchema(async () => {
    const { getDb } = await import("../server/db");
    const db = getDb();

    const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
    const ownerId = `docsv-owner-${RUN}`;

    await db.execute(
      `INSERT INTO users (id, first_name, email, role)
       VALUES ('${ownerId}', 'docsv_owner', 'docsv_owner_${RUN}@test.local', 'account_manager')
       ON CONFLICT (id) DO NOTHING` as any,
    );
    // Seeded in an isolated schema (uncommitted to public); pre-register so
    // requireAuth uses the profile directly instead of JIT-provisioning.
    __test_markUserReconciled(ownerId, {
      id: ownerId,
      email: `docsv_owner_${RUN}@test.local`,
      firstName: "docsv_owner",
      role: "account_manager",
    });

    const { storage } = await import("../server/storage");
    const app = express();
    app.use(express.json({ limit: "20mb" }));
    app.use(makeAuthMiddleware(ownerId, "account_manager"));
    const { registerDocsRoutes } = await import("../server/routes/docs");
    registerDocsRoutes(app);
    await startServer(app);

    let docId = "";
    try {
      // Create with an initial snapshot.
      const create = await req("POST", "/api/docs/documents", {
        name: "Versioned Doc",
        snapshot: docSnapshot("Initial content"),
      });
      assert.equal(create.status, 201, `create: ${JSON.stringify(create.body)}`);
      docId = create.body.document.id;
      ok("document created with initial snapshot");

      // First snapshot save → auto-version capture (fire-and-forget).
      const save1 = await req("PATCH", `/api/docs/documents/${docId}`, {
        snapshot: docSnapshot("Edit one"),
        expectedRevision: 0,
      });
      assert.equal(save1.status, 200, `save1: ${JSON.stringify(save1.body)}`);

      const gotAuto = await pollUntil(async () => {
        const list = await req("GET", `/api/docs/documents/${docId}/versions`);
        return list.status === 200 && list.body.versions.length >= 1;
      });
      assert.ok(gotAuto, "auto-version appeared after first snapshot save");
      const list1 = await req("GET", `/api/docs/documents/${docId}/versions`);
      assert.equal(list1.body.versions.length, 1);
      assert.equal(list1.body.versions[0].isRestorePoint, false);
      assert.ok(!("snapshot" in list1.body.versions[0]), "list is metadata-only (no snapshot body)");
      ok("first snapshot save captured exactly one auto-version (metadata-only list)");

      // Second save shortly after → throttled, no new auto-version.
      const save2 = await req("PATCH", `/api/docs/documents/${docId}`, {
        snapshot: docSnapshot("Edit two"),
        expectedRevision: 1,
      });
      assert.equal(save2.status, 200, `save2: ${JSON.stringify(save2.body)}`);
      await new Promise((r) => setTimeout(r, 700)); // settle window for the (unwanted) write
      const list2 = await req("GET", `/api/docs/documents/${docId}/versions`);
      assert.equal(
        list2.body.versions.length,
        1,
        `second save within the 5-minute window must not add a version, got ${list2.body.versions.length}`,
      );
      ok("auto-versions are throttled (no capture within the 5-minute window)");

      // Manual "Save version" always captures, with a label.
      const manual = await req("POST", `/api/docs/documents/${docId}/versions`, {
        snapshot: docSnapshot("Manual checkpoint"),
        label: "Before big rewrite",
      });
      assert.equal(manual.status, 201, `manual: ${JSON.stringify(manual.body)}`);
      assert.equal(manual.body.version.label, "Before big rewrite");
      const manualVersionId = manual.body.version.id;
      const list3 = await req("GET", `/api/docs/documents/${docId}/versions`);
      assert.equal(list3.body.versions.length, 2, "manual capture ignores the throttle");
      assert.equal(list3.body.versions[0].id, manualVersionId, "list is newest-first");
      ok("manual Save version captures immediately, newest-first ordering");

      // Full version fetch includes the snapshot.
      const one = await req("GET", `/api/docs/documents/${docId}/versions/${manualVersionId}`);
      assert.equal(one.status, 200);
      assert.ok(
        JSON.stringify(one.body.version.snapshot).includes("Manual checkpoint"),
        "single-version fetch returns the stored snapshot",
      );
      ok("single-version fetch returns the full snapshot");

      // Restore the manual version: doc content replaced, restore point saved.
      const restore = await req(
        "POST",
        `/api/docs/documents/${docId}/versions/${manualVersionId}/restore`,
      );
      assert.equal(restore.status, 200, `restore: ${JSON.stringify(restore.body)}`);
      assert.ok(
        JSON.stringify(restore.body.document.snapshot).includes("Manual checkpoint"),
        "document snapshot replaced by the restored version",
      );
      // Restore must bump the revision (2 saves → rev 2; restore → rev 3):
      // otherwise a second stale tab of the same lock holder could silently
      // overwrite the restore with its next autosave.
      assert.equal(
        restore.body.document.revision,
        3,
        `restore bumps revision, got ${restore.body.document.revision}`,
      );
      const list4 = await req("GET", `/api/docs/documents/${docId}/versions`);
      assert.equal(list4.body.versions.length, 3, "restore added a restore-point version");
      const restorePoint = list4.body.versions.find((v: any) => v.isRestorePoint);
      assert.ok(restorePoint, "restore-point version exists");
      assert.ok(
        String(restorePoint.label ?? "").startsWith("Before restore"),
        `restore-point label: ${restorePoint.label}`,
      );
      ok("restore replaces content and captures an undoable restore point");

      // The restore point holds the pre-restore content ("Edit two").
      const rp = await req("GET", `/api/docs/documents/${docId}/versions/${restorePoint.id}`);
      assert.ok(
        JSON.stringify(rp.body.version.snapshot).includes("Edit two"),
        "restore point preserved the pre-restore content",
      );
      ok("restore point preserves the pre-restore content");

      // Restoring a version from a different document id → 404.
      const otherDoc = await req("POST", "/api/docs/documents", { name: "Other doc" });
      const cross = await req(
        "POST",
        `/api/docs/documents/${otherDoc.body.document.id}/versions/${manualVersionId}/restore`,
      );
      assert.equal(cross.status, 404, `cross-document restore: ${cross.status}`);
      ok("cross-document version restore → 404");
      await req("DELETE", `/api/docs/documents/${otherDoc.body.document.id}`);

      // Activity log eventually shows version_saved + restored.
      const gotActivity = await pollUntil(async () => {
        const act = await req("GET", `/api/docs/documents/${docId}/activity`);
        if (act.status !== 200) return false;
        const actions = act.body.activity.map((a: any) => a.action);
        return actions.includes("version_saved") && actions.includes("restored");
      });
      assert.ok(gotActivity, "activity log records version_saved and restored");
      ok("activity log records version_saved and restored");
    } finally {
      __test_resetReconciledUsers();
      await stopServer();
      await db.execute(`DELETE FROM doc_documents WHERE owner_id = '${ownerId}'` as any);
      await db.execute(`DELETE FROM users WHERE id = '${ownerId}'` as any);
    }
  });

  console.log(`\nNoBull Docs versions: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("docs-versions test crashed:", err);
  process.exit(1);
});
