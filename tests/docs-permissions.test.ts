/* test-registration
{
  "name": "NoBull Docs — per-user sharing grants (Task #4053)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4053: per-user viewer/editor grants for private documents. Covers the grant/revoke lifecycle (owner-or-CEO-only management), the full access matrix (viewer read-only vs editor write vs no-grant 403), grantee library-list visibility, userPermission in GET responses, viewer 403s on every write path (PATCH, lock, manual version, restore), and delete staying owner/CEO-only for editors. A regression here either locks teammates out of shared documents or silently lets viewers write.",
  "tier": "small"
}
test-registration */
/**
 * NoBull Docs — per-user sharing grant tests (Task #4053).
 *
 * Mirrors tests/docs-routes.test.ts: real Express app with the real
 * isAuthenticated gate satisfied by a fake session middleware, HTTP
 * round-trips over a loopback server, per-run random-suffixed fixture IDs,
 * and finally-cleanup of every seeded row.
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

// ---- Clerk test seam (same shape as docs-routes) ----
// A string authenticates as that user id. Users are seeded in an isolated
// schema (uncommitted to public), so each acting identity is pre-registered
// via __test_markUserReconciled — requireAuth then populates req.user/req.dbUser
// from that profile (docs routes read req.dbUser?.role).

function makeAuthMiddleware(userId: string, _role: string) {
  return (_req: any, _res: any, next: any) => {
    _req.__test_clerkUserId = userId;
    next();
  };
}

async function buildTestApp(userId: string, role = "account_manager") {
  const { storage } = await import("../server/storage");

  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use(makeAuthMiddleware(userId, role));

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
    const ownerId = `docperm-owner-${RUN}`;
    const viewerId = `docperm-viewer-${RUN}`;
    const editorId = `docperm-editor-${RUN}`;
    const strangerId = `docperm-stranger-${RUN}`;
    const ceoId = `docperm-ceo-${RUN}`;

    await db.execute(
      `INSERT INTO users (id, first_name, email, role)
       VALUES ('${ownerId}', 'perm_owner', 'docperm_owner_${RUN}@test.local', 'account_manager'),
              ('${viewerId}', 'perm_viewer', 'docperm_viewer_${RUN}@test.local', 'account_manager'),
              ('${editorId}', 'perm_editor', 'docperm_editor_${RUN}@test.local', 'account_manager'),
              ('${strangerId}', 'perm_stranger', 'docperm_stranger_${RUN}@test.local', 'account_manager'),
              ('${ceoId}', 'perm_ceo', 'docperm_ceo_${RUN}@test.local', 'ceo')
       ON CONFLICT (id) DO NOTHING` as any,
    );

    // Seeded in an isolated schema (uncommitted to public); pre-register each
    // acting identity so requireAuth uses the profile (with role) directly
    // instead of JIT-provisioning a public row / firing the comms auto-join.
    __test_markUserReconciled(ownerId, {
      id: ownerId, email: `docperm_owner_${RUN}@test.local`, firstName: "perm_owner", role: "account_manager",
    });
    __test_markUserReconciled(viewerId, {
      id: viewerId, email: `docperm_viewer_${RUN}@test.local`, firstName: "perm_viewer", role: "account_manager",
    });
    __test_markUserReconciled(editorId, {
      id: editorId, email: `docperm_editor_${RUN}@test.local`, firstName: "perm_editor", role: "account_manager",
    });
    __test_markUserReconciled(strangerId, {
      id: strangerId, email: `docperm_stranger_${RUN}@test.local`, firstName: "perm_stranger", role: "account_manager",
    });
    __test_markUserReconciled(ceoId, {
      id: ceoId, email: `docperm_ceo_${RUN}@test.local`, firstName: "perm_ceo", role: "ceo",
    });

    originalDispatcher = getGlobalDispatcher();
    currentAgent = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 });
    setGlobalDispatcher(currentAgent);

    const { app: ownerApp } = await buildTestApp(ownerId);
    const { app: viewerApp } = await buildTestApp(viewerId);
    const { app: editorApp } = await buildTestApp(editorId);
    const { app: strangerApp } = await buildTestApp(strangerId);
    const { app: ceoApp } = await buildTestApp(ceoId, "ceo");

    const owner = await startServer(ownerApp);
    const viewer = await startServer(viewerApp);
    const editor = await startServer(editorApp);
    const stranger = await startServer(strangerApp);
    const ceo = await startServer(ceoApp);

    try {
      // ---- setup: owner creates a private (non-client) document ----
      let docId = "";
      {
        const create = await req(owner, "POST", "/api/docs/documents", {
          name: `Hiring plan ${RUN}`,
          snapshot: docSnapshot("Draft"),
        });
        assert.equal(create.status, 201, `create: ${JSON.stringify(create.body)}`);
        docId = create.body.document.id;
        ok("owner creates a private document");
      }

      // ---- baseline 403s before any grant ----
      {
        for (const [rs, who] of [[viewer, "future viewer"], [editor, "future editor"], [stranger, "stranger"]] as const) {
          const r = await req(rs, "GET", `/api/docs/documents/${docId}`);
          assert.equal(r.status, 403, `${who} pre-grant get: ${JSON.stringify(r.body)}`);
        }
        const list = await req(viewer, "GET", "/api/docs/documents");
        assert.ok(
          !list.body.documents.some((d: any) => d.id === docId),
          "ungranted user must not see the doc in their library",
        );
        ok("no access and no library visibility before a grant exists");
      }

      // ---- team roster for the Share dialog picker ----
      {
        const roster = await req(owner, "GET", "/api/docs/team-roster");
        assert.equal(roster.status, 200, `roster: ${JSON.stringify(roster.body)}`);
        assert.ok(Array.isArray(roster.body.users), "roster is wrapped as { users: [...] }");
        assert.ok(
          roster.body.users.some((u: any) => u.id === viewerId),
          "roster includes teammates",
        );
        const sample = roster.body.users.find((u: any) => u.id === viewerId);
        assert.deepEqual(
          Object.keys(sample).sort(),
          ["email", "firstName", "id", "lastName", "role"],
          "roster exposes only identity fields",
        );
        ok("team roster returns { users } with identity fields only");
      }

      // ---- grant management authz ----
      {
        const nonOwner = await req(viewer, "PUT", `/api/docs/documents/${docId}/permissions`, {
          userId: strangerId,
          role: "viewer",
        });
        assert.equal(nonOwner.status, 403, `non-owner grant: ${JSON.stringify(nonOwner.body)}`);

        const listPerms = await req(viewer, "GET", `/api/docs/documents/${docId}/permissions`);
        assert.equal(listPerms.status, 403, "non-owner cannot list grants");
        ok("only owner/CEO can list or manage grants (403 otherwise)");

        const badRole = await req(owner, "PUT", `/api/docs/documents/${docId}/permissions`, {
          userId: viewerId,
          role: "owner",
        });
        assert.equal(badRole.status, 400, `owner-level grant rejected: ${JSON.stringify(badRole.body)}`);
        ok("granting the 'owner' level is rejected (viewer/editor only)");

        const selfGrant = await req(owner, "PUT", `/api/docs/documents/${docId}/permissions`, {
          userId: ownerId,
          role: "editor",
        });
        assert.equal(selfGrant.status, 400, "granting to the owner is rejected");
        ok("granting to the document owner is rejected");

        const ghost = await req(owner, "PUT", `/api/docs/documents/${docId}/permissions`, {
          userId: `docperm-ghost-${RUN}`,
          role: "viewer",
        });
        assert.equal(ghost.status, 400, `unknown grantee: ${JSON.stringify(ghost.body)}`);
        ok("granting to an unknown user returns 400 (not a 500)");
      }

      // ---- owner grants viewer + editor ----
      {
        const g1 = await req(owner, "PUT", `/api/docs/documents/${docId}/permissions`, {
          userId: viewerId,
          role: "viewer",
        });
        assert.equal(g1.status, 200, `grant viewer: ${JSON.stringify(g1.body)}`);
        assert.equal(g1.body.permission.role, "viewer");

        const g2 = await req(owner, "PUT", `/api/docs/documents/${docId}/permissions`, {
          userId: editorId,
          role: "editor",
        });
        assert.equal(g2.status, 200, `grant editor: ${JSON.stringify(g2.body)}`);
        assert.equal(g2.body.permission.role, "editor");

        const listPerms = await req(owner, "GET", `/api/docs/documents/${docId}/permissions`);
        assert.equal(listPerms.status, 200);
        assert.equal(listPerms.body.permissions.length, 2, "two grants listed");
        ok("owner grants viewer and editor access; grants are listed");
      }

      // ---- library visibility for grantees ----
      {
        for (const [rs, who] of [[viewer, "viewer"], [editor, "editor"]] as const) {
          const list = await req(rs, "GET", "/api/docs/documents");
          assert.equal(list.status, 200);
          assert.ok(
            list.body.documents.some((d: any) => d.id === docId),
            `${who} sees the shared doc in their library`,
          );
        }
        const strangerList = await req(stranger, "GET", "/api/docs/documents");
        assert.ok(
          !strangerList.body.documents.some((d: any) => d.id === docId),
          "stranger still does not see the doc",
        );
        ok("grantees see the document in their library list; stranger does not");
      }

      // ---- access matrix: reads ----
      {
        const vGet = await req(viewer, "GET", `/api/docs/documents/${docId}`);
        assert.equal(vGet.status, 200, `viewer get: ${JSON.stringify(vGet.body)}`);
        assert.equal(vGet.body.userPermission, "viewer", "viewer userPermission");

        const eGet = await req(editor, "GET", `/api/docs/documents/${docId}`);
        assert.equal(eGet.status, 200);
        assert.equal(eGet.body.userPermission, "editor", "editor userPermission");

        const oGet = await req(owner, "GET", `/api/docs/documents/${docId}`);
        assert.equal(oGet.body.userPermission, "owner", "owner userPermission");

        const cGet = await req(ceo, "GET", `/api/docs/documents/${docId}`);
        assert.equal(cGet.body.userPermission, "owner", "CEO userPermission is owner-equivalent");

        const sGet = await req(stranger, "GET", `/api/docs/documents/${docId}`);
        assert.equal(sGet.status, 403, "stranger still 403 after other grants");
        ok("GET returns userPermission per grant; stranger stays 403");

        const vVersions = await req(viewer, "GET", `/api/docs/documents/${docId}/versions`);
        assert.equal(vVersions.status, 200, "viewer can list versions");
        const vActivity = await req(viewer, "GET", `/api/docs/documents/${docId}/activity`);
        assert.equal(vActivity.status, 200, "viewer can read activity");
        ok("viewer can read versions and activity");
      }

      // ---- lock metadata is access-gated ----
      {
        const sPeek = await req(stranger, "GET", `/api/docs/documents/${docId}/lock`);
        assert.equal(sPeek.status, 403, "ungranted user cannot peek at lock state");
        const vPeek = await req(viewer, "GET", `/api/docs/documents/${docId}/lock`);
        assert.equal(vPeek.status, 200, "viewer can peek at lock state");
        const sHb = await req(stranger, "POST", `/api/docs/documents/${docId}/lock/heartbeat`, {});
        assert.equal(sHb.status, 403, "ungranted user cannot heartbeat");
        const vHb = await req(viewer, "POST", `/api/docs/documents/${docId}/lock/heartbeat`, {});
        assert.equal(vHb.status, 403, "viewer cannot heartbeat");
        const vRel = await req(viewer, "DELETE", `/api/docs/documents/${docId}/lock`);
        assert.equal(vRel.status, 403, "viewer cannot release the lock");
        const ghost = await req(owner, "GET", `/api/docs/documents/${randomUUID()}/lock`);
        assert.equal(ghost.status, 404, "lock peek on a missing document is 404");
        ok("lock inspection needs viewer+; heartbeat/release need editor+");
      }

      // ---- access matrix: viewer write paths are 403 ----
      {
        const patch = await req(viewer, "PATCH", `/api/docs/documents/${docId}`, {
          name: "Viewer rename attempt",
        });
        assert.equal(patch.status, 403, `viewer rename: ${JSON.stringify(patch.body)}`);

        const save = await req(viewer, "PATCH", `/api/docs/documents/${docId}`, {
          snapshot: docSnapshot("viewer write"),
          expectedRevision: 0,
        });
        assert.equal(save.status, 403, "viewer snapshot save rejected");

        const lock = await req(viewer, "POST", `/api/docs/documents/${docId}/lock`, {});
        assert.equal(lock.status, 403, "viewer cannot acquire the edit lock");

        const version = await req(viewer, "POST", `/api/docs/documents/${docId}/versions`, {
          snapshot: docSnapshot("viewer version"),
        });
        assert.equal(version.status, 403, "viewer cannot save a manual version");

        const del = await req(viewer, "DELETE", `/api/docs/documents/${docId}`);
        assert.equal(del.status, 403, "viewer cannot delete");
        ok("viewer is read-only: PATCH, lock, manual version, delete all 403");
      }

      // ---- access matrix: editor can write, but not delete/manage ----
      {
        const lock = await req(editor, "POST", `/api/docs/documents/${docId}/lock`, {
          holderName: "Perm Editor",
        });
        assert.equal(lock.status, 200, `editor lock: ${JSON.stringify(lock.body)}`);
        assert.equal(lock.body.acquired, true, "editor acquires the edit lock");

        const current = await req(editor, "GET", `/api/docs/documents/${docId}`);
        const rev = current.body.document.revision;
        const save = await req(editor, "PATCH", `/api/docs/documents/${docId}`, {
          snapshot: docSnapshot("editor write"),
          expectedRevision: rev,
        });
        assert.equal(save.status, 200, `editor save: ${JSON.stringify(save.body)}`);
        assert.equal(save.body.document.revision, rev + 1, "editor save bumps revision");

        const release = await req(editor, "DELETE", `/api/docs/documents/${docId}/lock`);
        assert.equal(release.status, 200);
        ok("editor can acquire the lock and save a snapshot");

        const del = await req(editor, "DELETE", `/api/docs/documents/${docId}`);
        assert.equal(del.status, 403, "delete remains owner/CEO-only for editors");

        const manage = await req(editor, "PUT", `/api/docs/documents/${docId}/permissions`, {
          userId: strangerId,
          role: "viewer",
        });
        assert.equal(manage.status, 403, "editor cannot manage grants");
        ok("editor cannot delete the document or manage sharing");
      }

      // ---- upsert: role change viewer → editor ----
      {
        const up = await req(owner, "PUT", `/api/docs/documents/${docId}/permissions`, {
          userId: viewerId,
          role: "editor",
        });
        assert.equal(up.status, 200);
        assert.equal(up.body.permission.role, "editor", "grant upserted to editor");

        const save = await req(viewer, "PATCH", `/api/docs/documents/${docId}`, {
          name: "Upgraded viewer rename",
        });
        assert.equal(save.status, 200, "upgraded grantee can now write");

        // Downgrade back for the revoke test.
        const down = await req(owner, "PUT", `/api/docs/documents/${docId}/permissions`, {
          userId: viewerId,
          role: "viewer",
        });
        assert.equal(down.status, 200);
        ok("re-granting upserts the role (viewer → editor → viewer)");
      }

      // ---- CEO can manage grants on someone else's document ----
      {
        const g = await req(ceo, "PUT", `/api/docs/documents/${docId}/permissions`, {
          userId: strangerId,
          role: "viewer",
        });
        assert.equal(g.status, 200, `ceo grant: ${JSON.stringify(g.body)}`);
        const sGet = await req(stranger, "GET", `/api/docs/documents/${docId}`);
        assert.equal(sGet.status, 200, "CEO-granted user can now read");
        const rv = await req(ceo, "DELETE", `/api/docs/documents/${docId}/permissions/${strangerId}`);
        assert.equal(rv.status, 200);
        ok("CEO can grant and revoke on another owner's document");
      }

      // ---- revoking a lock-holding editor frees the lock ----
      {
        // Give the (currently viewer) grantee editor access and let them
        // take the lock, then revoke while they hold it.
        const up = await req(owner, "PUT", `/api/docs/documents/${docId}/permissions`, {
          userId: viewerId,
          role: "editor",
        });
        assert.equal(up.status, 200);
        const lock = await req(viewer, "POST", `/api/docs/documents/${docId}/lock`, {
          holderName: "Soon Revoked",
        });
        assert.equal(lock.body.acquired, true, "grantee holds the lock pre-revoke");

        const rv = await req(owner, "DELETE", `/api/docs/documents/${docId}/permissions/${viewerId}`);
        assert.equal(rv.status, 200);

        const hb = await req(viewer, "POST", `/api/docs/documents/${docId}/lock/heartbeat`, {});
        assert.equal(hb.status, 403, "revoked holder cannot keep heartbeating");

        const takeover = await req(editor, "POST", `/api/docs/documents/${docId}/lock`, {
          holderName: "Perm Editor",
        });
        assert.equal(takeover.status, 200, `post-revoke acquire: ${JSON.stringify(takeover.body)}`);
        assert.equal(
          takeover.body.acquired,
          true,
          "another editor acquires immediately — revoke released the stale lock",
        );
        const release = await req(editor, "DELETE", `/api/docs/documents/${docId}/lock`);
        assert.equal(release.status, 200);

        // Restore the viewer grant so the revoke-lifecycle block below
        // exercises revoke-from-viewer as originally written.
        const down = await req(owner, "PUT", `/api/docs/documents/${docId}/permissions`, {
          userId: viewerId,
          role: "viewer",
        });
        assert.equal(down.status, 200);
        ok("revoking a lock-holding grantee frees the lock and blocks their heartbeat");
      }

      // ---- revoke restores the 403 + hides from library ----
      {
        const rv = await req(owner, "DELETE", `/api/docs/documents/${docId}/permissions/${viewerId}`);
        assert.equal(rv.status, 200, `revoke: ${JSON.stringify(rv.body)}`);

        const get = await req(viewer, "GET", `/api/docs/documents/${docId}`);
        assert.equal(get.status, 403, "revoked user is 403 again");

        const list = await req(viewer, "GET", "/api/docs/documents");
        assert.ok(
          !list.body.documents.some((d: any) => d.id === docId),
          "revoked user no longer sees the doc in their library",
        );

        const again = await req(owner, "DELETE", `/api/docs/documents/${docId}/permissions/${viewerId}`);
        assert.equal(again.status, 200, "revoke is idempotent");
        ok("revoke removes access, hides the doc from the library, and is idempotent");
      }

      // ---- sharing activity is logged ----
      {
        const act = await req(owner, "GET", `/api/docs/documents/${docId}/activity?limit=200`);
        assert.equal(act.status, 200);
        const actions = act.body.activity.map((a: any) => a.action);
        assert.ok(actions.includes("shared"), `expected a 'shared' entry, got: ${actions.join(",")}`);
        assert.ok(actions.includes("unshared"), `expected an 'unshared' entry, got: ${actions.join(",")}`);
        ok("grant/revoke are recorded in the activity log as shared/unshared");
      }
    } catch (err) {
      failed++;
      console.error("  ✗ FAILED:", err);
    } finally {
      __test_resetReconciledUsers();
      await stopServer(owner);
      await stopServer(viewer);
      await stopServer(editor);
      await stopServer(stranger);
      await stopServer(ceo);

      // Cleanup own litter (isolated schema is dropped, but the docs test
      // convention deletes fixture rows explicitly too).
      await db.execute(`DELETE FROM doc_documents WHERE owner_id = '${ownerId}'` as any);
      await db.execute(
        `DELETE FROM users WHERE id IN ('${ownerId}', '${viewerId}', '${editorId}', '${strangerId}', '${ceoId}')` as any,
      );

      if (currentAgent) {
        await currentAgent.close();
        setGlobalDispatcher(originalDispatcher);
      }
    }
  });

  console.log(`\nTest run: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// void: top-level runner; failures set the exit code inside run().
void run().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
