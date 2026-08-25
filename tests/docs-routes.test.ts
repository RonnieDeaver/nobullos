/* test-registration
{
  "name": "NoBull Docs — data model, storage & routes foundation (Task #4024)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4024: NoBull Docs foundation. Covers document CRUD + list scoping, the optimistic-revision guard (400 MISSING_REVISION / 409 REVISION_CONFLICT), the single-editor lock quartet (acquire, steal-blocked, heartbeat, 423 LOCK_REQUIRED on save, release), the 10 MB snapshot cap, client-linked access sharing, owner/CEO-only delete, and 401 on unauthenticated access. A regression here breaks every docs editor session.",
  "tier": "small"
}
test-registration */
/**
 * NoBull Docs — route-level tests (Task #4024).
 *
 * Mirrors tests/sheets-routes.test.ts: real Express app with the real
 * isAuthenticated gate satisfied by a fake session middleware, HTTP
 * round-trips over a loopback server, and every write scoped to the
 * hermetic per-run test DB.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import { createServer } from "http";
import { runInIsolatedSchema } from "./db-sandbox";

// ---- minimal fake-auth helpers (Clerk-era test seams, same as sheets-routes) ----

// The suite must run with NODE_ENV=test so requireAuth honors the
// per-request __test_clerkUserId seam (bare `npx tsx` repros included).
process.env.NODE_ENV ||= "test";

// Clerk-era auth seam: requireAuth reads req.__test_clerkUserId under
// NODE_ENV=test; __test_markUserReconciled pre-registers the profile so the
// middleware never looks the user up in the PUBLIC schema (this suite seeds
// users only inside its isolated schema).
function makeAuthMiddleware(userId: string) {
  return (_req: any, _res: any, next: any) => {
    _req.__test_clerkUserId = userId;
    next();
  };
}

/** Anonymous seam value → requireAuth rejects with 401. */
function makeUnauthenticatedMiddleware() {
  return (_req: any, _res: any, next: any) => {
    _req.__test_clerkUserId = null;
    next();
  };
}

async function buildTestApp(userId: string | null, role = "account_manager") {
  const { storage } = await import("../server/storage");
  if (userId) {
    const { __test_markUserReconciled } = await import(
      "../server/middlewares/requireAuth"
    );
    __test_markUserReconciled(userId, {
      id: userId,
      email: `${userId}@test.local`,
      firstName: "Tester",
      lastName: "Docs",
      role,
    });
  }

  const app = express();
  // Large-enough JSON limit that the in-route 10 MB snapshot guard (not the
  // body parser) is what rejects oversized snapshots.
  app.use(express.json({ limit: "20mb" }));
  app.use(userId ? makeAuthMiddleware(userId) : makeUnauthenticatedMiddleware());

  const { registerDocsRoutes } = await import("../server/routes/docs");
  registerDocsRoutes(app);

  return { app, storage };
}

// ---- loopback server helpers ----

let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
let currentAgent: Agent | null = null;

interface RunningServer {
  baseUrl: string;
  server: ReturnType<typeof createServer>;
}

async function startServer(app: express.Express): Promise<RunningServer> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${addr.port}`, server };
}

async function stopServer(rs: RunningServer): Promise<void> {
  await new Promise<void>((resolve) => rs.server.close(() => resolve()));
}

async function req(
  rs: RunningServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${rs.baseUrl}${path}`, {
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

// ---- test bookkeeping ----

let passed = 0;
let failed = 0;

function ok(label: string) {
  passed++;
  console.log(`  ✓ ${label}`);
}

// A tiny valid Univer document snapshot.
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

async function run() {
  await runInIsolatedSchema(async () => {
    const { getDb } = await import("../server/db");
    const db = getDb();

    const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
    const ownerId = `docs-owner-${RUN}`;
    const otherId = `docs-other-${RUN}`;
    const ceoId = `docs-ceo-${RUN}`;
    const clientId = randomUUID();

    await db.execute(
      `INSERT INTO users (id, first_name, email, role)
       VALUES ('${ownerId}', 'docs_owner', 'docs_owner_${RUN}@test.local', 'account_manager'),
              ('${otherId}', 'docs_other', 'docs_other_${RUN}@test.local', 'account_manager'),
              ('${ceoId}', 'docs_ceo', 'docs_ceo_${RUN}@test.local', 'ceo')
       ON CONFLICT (id) DO NOTHING` as any,
    );
    await db.execute(
      `INSERT INTO clients (id, firm_name) VALUES ('${clientId}', 'Docs Test Firm ${RUN}')
       ON CONFLICT (id) DO NOTHING` as any,
    );

    originalDispatcher = getGlobalDispatcher();
    currentAgent = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 });
    setGlobalDispatcher(currentAgent);

    const { app: ownerApp } = await buildTestApp(ownerId);
    const { app: otherApp } = await buildTestApp(otherId);
    const { app: ceoApp } = await buildTestApp(ceoId, "ceo");
    const { app: unauthApp } = await buildTestApp(null);

    const owner = await startServer(ownerApp);
    const other = await startServer(otherApp);
    const ceo = await startServer(ceoApp);
    const unauth = await startServer(unauthApp);

    try {
      // ---- 401 unauthenticated ----
      {
        const r = await req(unauth, "GET", "/api/docs/documents");
        assert.equal(r.status, 401, `unauthenticated list: ${JSON.stringify(r.body)}`);
        ok("unauthenticated access returns 401");
      }

      // ---- document CRUD ----
      let docId = "";
      {
        const create = await req(owner, "POST", "/api/docs/documents", { name: "Meeting Notes" });
        assert.equal(create.status, 201, `create: ${JSON.stringify(create.body)}`);
        assert.ok(create.body.document?.id, "create returned id");
        assert.equal(create.body.document.revision, 0, "new document starts at revision 0");
        docId = create.body.document.id;
        ok("createDocument returns 201, id, revision 0");

        const list = await req(owner, "GET", "/api/docs/documents");
        assert.equal(list.status, 200);
        assert.ok(Array.isArray(list.body.documents));
        assert.ok(list.body.documents.some((d: any) => d.id === docId));
        ok("listDocuments includes owned document");

        const get = await req(owner, "GET", `/api/docs/documents/${docId}`);
        assert.equal(get.status, 200);
        assert.equal(get.body.document.id, docId);
        ok("getDocument returns full document");

        const ren = await req(owner, "PATCH", `/api/docs/documents/${docId}`, { name: "Meeting Notes v2" });
        assert.equal(ren.status, 200);
        assert.equal(ren.body.document.name, "Meeting Notes v2");
        ok("rename via PATCH works");
      }

      // ---- revision guard ----
      {
        const s1 = docSnapshot("First body");
        const noRev = await req(owner, "PATCH", `/api/docs/documents/${docId}`, { snapshot: s1 });
        assert.equal(noRev.status, 400, `missing revision: ${JSON.stringify(noRev.body)}`);
        assert.equal(noRev.body.error, "MISSING_REVISION");
        ok("snapshot save without expectedRevision → 400 MISSING_REVISION");

        const save1 = await req(owner, "PATCH", `/api/docs/documents/${docId}`, {
          snapshot: s1,
          expectedRevision: 0,
        });
        assert.equal(save1.status, 200, `save1: ${JSON.stringify(save1.body)}`);
        assert.equal(save1.body.document.revision, 1, "revision bumps to 1");
        ok("snapshot save with matching expectedRevision succeeds, bumps revision");

        const stale = await req(owner, "PATCH", `/api/docs/documents/${docId}`, {
          snapshot: docSnapshot("Stale writer"),
          expectedRevision: 0,
        });
        assert.equal(stale.status, 409, `stale: ${JSON.stringify(stale.body)}`);
        assert.equal(stale.body.error, "REVISION_CONFLICT");
        assert.equal(stale.body.currentRevision, 1);
        ok("stale expectedRevision → 409 REVISION_CONFLICT with currentRevision");

        const reload = await req(owner, "GET", `/api/docs/documents/${docId}`);
        assert.ok(
          JSON.stringify(reload.body.document.snapshot).includes("First body"),
          "stale write did not clobber content",
        );
        ok("stale write left the saved snapshot intact");
      }

      // ---- snapshot size cap ----
      {
        const big = { data: "x".repeat(10 * 1024 * 1024 + 1) };
        const r = await req(owner, "PATCH", `/api/docs/documents/${docId}`, {
          snapshot: big,
          expectedRevision: 1,
        });
        assert.equal(r.status, 413, `oversize: ${r.status}`);
        ok("snapshot > 10 MB rejected with 413");
      }

      // ---- edit lock quartet ----
      {
        const acq = await req(owner, "POST", `/api/docs/documents/${docId}/lock`, {
          holderName: "Owner",
        });
        assert.equal(acq.status, 200);
        assert.equal(acq.body.acquired, true, `acquire: ${JSON.stringify(acq.body)}`);
        assert.equal(acq.body.lock.holderUserId, ownerId);
        ok("owner acquires the edit lock");

        // Client-link the doc so `other` can even see it (lock enforcement is
        // the thing under test, not access).
        const link = await req(owner, "PATCH", `/api/docs/documents/${docId}`, { clientId });
        assert.equal(link.status, 200, `link client: ${JSON.stringify(link.body)}`);

        const steal = await req(other, "POST", `/api/docs/documents/${docId}/lock`, {
          holderName: "Other",
        });
        assert.equal(steal.status, 200);
        assert.equal(steal.body.acquired, false, "second user cannot steal an active lock");
        assert.equal(steal.body.lock.holderUserId, ownerId, "lock reports current holder");
        ok("second user cannot steal an active lock");

        const blockedSave = await req(other, "PATCH", `/api/docs/documents/${docId}`, {
          snapshot: docSnapshot("Blocked writer"),
          expectedRevision: 1,
        });
        assert.equal(blockedSave.status, 423, `blocked save: ${JSON.stringify(blockedSave.body)}`);
        assert.equal(blockedSave.body.error, "LOCK_REQUIRED");
        ok("snapshot save while someone else holds the lock → 423 LOCK_REQUIRED");

        const hb = await req(owner, "POST", `/api/docs/documents/${docId}/lock/heartbeat`);
        assert.equal(hb.status, 200);
        assert.equal(hb.body.lock.holderUserId, ownerId);
        ok("holder heartbeat extends the lock");

        const hbOther = await req(other, "POST", `/api/docs/documents/${docId}/lock/heartbeat`);
        assert.equal(hbOther.status, 409);
        assert.equal(hbOther.body.error, "LOCK_LOST");
        ok("non-holder heartbeat → 409 LOCK_LOST");

        const peek = await req(other, "GET", `/api/docs/documents/${docId}/lock`);
        assert.equal(peek.status, 200);
        assert.equal(peek.body.locked, true);
        ok("lock peek reports locked:true with holder");

        const rel = await req(owner, "DELETE", `/api/docs/documents/${docId}/lock`);
        assert.equal(rel.status, 200);
        assert.ok(rel.body.ok);
        ok("holder releases the lock");

        const acq2 = await req(other, "POST", `/api/docs/documents/${docId}/lock`, {
          holderName: "Other",
        });
        assert.equal(acq2.status, 200);
        assert.equal(acq2.body.acquired, true, "lock is acquirable after release");
        ok("lock is acquirable after release");
        await req(other, "DELETE", `/api/docs/documents/${docId}/lock`);
      }

      // ---- client scoping & access ----
      {
        const byClient = await req(other, "GET", `/api/docs/documents?clientId=${clientId}`);
        assert.equal(byClient.status, 200);
        assert.ok(
          byClient.body.documents.some((d: any) => d.id === docId),
          "client-linked doc appears in ?clientId list",
        );
        ok("client-linked document appears in the client's list for teammates");

        const asOther = await req(other, "GET", `/api/docs/documents/${docId}`);
        assert.equal(asOther.status, 200, "client-linked docs are team-readable");
        ok("teammate can open a client-linked document");

        // A personal (non-client) doc from `other` is invisible to owner.
        const personal = await req(other, "POST", "/api/docs/documents", { name: "Private notes" });
        assert.equal(personal.status, 201);
        const personalId = personal.body.document.id;
        const denied = await req(owner, "GET", `/api/docs/documents/${personalId}`);
        assert.equal(denied.status, 403, `expected 403, got ${denied.status}`);
        ok("someone else's personal document → 403");

        const ceoRead = await req(ceo, "GET", `/api/docs/documents/${personalId}`);
        assert.equal(ceoRead.status, 200, "CEO can read any document");
        ok("CEO can read any document");

        // Cleanup the personal doc (owner-only delete: other owns it).
        const delPersonal = await req(other, "DELETE", `/api/docs/documents/${personalId}`);
        assert.equal(delPersonal.status, 200);
      }

      // ---- delete permissions ----
      {
        const delByOther = await req(other, "DELETE", `/api/docs/documents/${docId}`);
        assert.equal(delByOther.status, 403, "non-owner cannot delete a client-linked doc");
        ok("non-owner delete → 403");

        const ceoDoc = await req(owner, "POST", "/api/docs/documents", { name: "CEO delete target" });
        const ceoDocId = ceoDoc.body.document.id;
        const delByCeo = await req(ceo, "DELETE", `/api/docs/documents/${ceoDocId}`);
        assert.equal(delByCeo.status, 200, `CEO delete: ${JSON.stringify(delByCeo.body)}`);
        ok("CEO can delete any document");

        const delByOwner = await req(owner, "DELETE", `/api/docs/documents/${docId}`);
        assert.equal(delByOwner.status, 200);
        const gone = await req(owner, "GET", `/api/docs/documents/${docId}`);
        assert.equal(gone.status, 404);
        ok("owner delete works and the document is gone");
      }

      // ---- server-side pagination/search/sort (Task #4488) ----
      {
        const names = ["PgT Alpha", "PgT Bravo", "PgT Charlie"];
        const createdIds: string[] = [];
        for (const name of names) {
          const r = await req(owner, "POST", "/api/docs/documents", { name });
          assert.equal(r.status, 201, `create ${name}`);
          createdIds.push(r.body.document.id);
        }

        const page1 = await req(
          owner,
          "GET",
          "/api/docs/documents?q=PgT&sort=name&dir=asc&limit=2&offset=0",
        );
        assert.equal(page1.status, 200);
        assert.equal(page1.body.total, 3, "total counts the full match set");
        assert.deepEqual(
          page1.body.documents.map((d: any) => d.name),
          ["PgT Alpha", "PgT Bravo"],
          "page 1 is name-asc sorted and sliced server-side",
        );
        ok("paged documents list returns sorted slice + full total");

        const page2 = await req(
          owner,
          "GET",
          "/api/docs/documents?q=PgT&sort=name&dir=asc&limit=2&offset=2",
        );
        assert.equal(page2.status, 200);
        assert.deepEqual(
          page2.body.documents.map((d: any) => d.name),
          ["PgT Charlie"],
          "offset walks past page 1",
        );
        ok("documents offset returns the next page");

        // Legacy shape: no limit → full list (plus additive total).
        const legacy = await req(owner, "GET", "/api/docs/documents?q=PgT");
        assert.equal(legacy.status, 200);
        assert.equal(legacy.body.documents.length, 3);
        assert.equal(legacy.body.total, 3);
        ok("omitting limit keeps the legacy full-list documents behavior");

        const bad = await req(owner, "GET", "/api/docs/documents?limit=0");
        assert.equal(bad.status, 400, "limit below 1 is rejected");
        ok("invalid documents pagination params → 400");

        for (const id of createdIds) {
          await req(owner, "DELETE", `/api/docs/documents/${id}`);
        }
      }

      // ---- bad client on create ----
      {
        const r = await req(owner, "POST", "/api/docs/documents", {
          name: "Bad client",
          clientId: randomUUID(),
        });
        assert.equal(r.status, 400, `bad client: ${JSON.stringify(r.body)}`);
        ok("create with unknown clientId → 400");
      }
    } finally {
      const { __test_resetReconciledUsers } = await import(
        "../server/middlewares/requireAuth"
      );
      __test_resetReconciledUsers();
      await stopServer(owner);
      await stopServer(other);
      await stopServer(ceo);
      await stopServer(unauth);
      setGlobalDispatcher(originalDispatcher);
      if (currentAgent) {
        try {
          await currentAgent.close();
        } catch {
          /* ignore */
        }
        currentAgent = null;
      }
      // Best-effort cleanup of seeded rows (hermetic DB, but keep it tidy).
      await db.execute(`DELETE FROM doc_documents WHERE owner_id IN ('${ownerId}', '${otherId}', '${ceoId}')` as any);
      await db.execute(`DELETE FROM clients WHERE id = '${clientId}'` as any);
      await db.execute(`DELETE FROM users WHERE id IN ('${ownerId}', '${otherId}', '${ceoId}')` as any);
    }
  });

  console.log(`\nNoBull Docs routes: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("docs-routes test crashed:", err);
  process.exit(1);
});
