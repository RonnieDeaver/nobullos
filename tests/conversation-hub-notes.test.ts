/* test-registration
{
  "name": "Conversation Hub thread notes + assignment routes (Task #1289)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #1289: Cover the seven Task #850 thread notes & assignment HTTP
// routes with API tests. Mounts registerTwilioRoutes onto a throw-away
// Express app inside a per-test isolated Postgres schema so no rows leak.
// Auth shim toggles the effective user per request so we can exercise the
// author-only DELETE guard.
//
// Hermetic-DB fix (Task #1289): this suite used `runInTxSandbox`, which
// wraps everything in a SINGLE uncommitted transaction and redirects
// `getDb()` via AsyncLocalStorage. But the Express request handlers run in
// a SEPARATE async context OUTSIDE that ALS scope, so their `getDb()` calls
// fell through to a different pool connection than the open sandbox tx —
// they could neither see the seeded (uncommitted) `users` rows nor write
// notes the seed-side could read, and the auth middleware's `users` read
// blocked on the uncommitted rows until the 30s statement_timeout fired
// (twice → the 180s SIGTERM). Per the db-sandbox contract, HTTP-endpoint
// tests must use `runInIsolatedSchema` with `pinGetDbForCrossAsync: true`:
// it clones the touched tables into a private schema, pins `getDb()` at
// that schema's handle by captured reference (so cross-async request
// handlers resolve there too), and drops the schema on exit. No open
// transaction → no lock/timeout.
//
// Routes under test:
//   GET    /api/twilio/threads/notes
//   GET    /api/twilio/threads/assignments
//   GET    /api/twilio/threads/:key/notes
//   POST   /api/twilio/threads/:key/notes
//   DELETE /api/twilio/threads/notes/:id
//   GET    /api/twilio/threads/:key/assignment
//   PATCH  /api/twilio/threads/:key/assignment
//
// Usage: tsx tests/conversation-hub-notes.test.ts

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express from "express";
import http from "http";
import type { AddressInfo } from "net";

import { registerTwilioRoutes } from "../server/routes/twilio";
import { runInIsolatedSchema } from "./db-sandbox";
import { getDb } from "../server/db";
import { users } from "@shared/schema";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

// Clerk test seam — installed before registerTwilioRoutes so the real
// requireAuth + requireTwilioAccess middleware admits the acting identity.
// The current effective user can be swapped per-request (null = anonymous 401).
// Users are seeded in an isolated schema (uncommitted to public), so each
// acting identity is pre-registered via __test_markUserReconciled below.
let currentUserId: string | null = null;

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    (req as any).__test_clerkUserId = currentUserId;
    next();
  });
  registerTwilioRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function jsonRequest(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const u = new URL(url);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let parsed: any = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            /* leave as text */
          }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function seedUser(id: string, role: "team_lead" | "account_manager"): Promise<void> {
  await getDb().insert(users).values({
    id,
    email: `${id}@test.local`,
    firstName: id,
    lastName: "Tester",
    role,
  });
  // Seeded in an isolated schema (uncommitted to public); pre-register so
  // requireAuth uses the profile (with role) directly instead of
  // JIT-provisioning a public row / firing the comms auto-join side effect.
  __test_markUserReconciled(id, {
    id,
    email: `${id}@test.local`,
    firstName: id,
    lastName: "Tester",
    role,
  });
}

async function testNotesAndAssignmentRoutes(): Promise<void> {
  console.log(
    "\n— /api/twilio/threads notes + assignment HTTP routes (Task #1289) —",
  );

  await runInIsolatedSchema(async () => {
    const ts = Date.now().toString(36);
    const ALICE = `u_alice_${ts}`;
    const BOB = `u_bob_${ts}`;
    await seedUser(ALICE, "team_lead");
    await seedUser(BOB, "team_lead");

    await withApp(async (baseUrl) => {
      const THREAD_KEY = `phone:8005551234`;
      const OTHER_KEY = `phone:8005559999`;

      // ---------------------------------------------------------------
      // (1) POST a note as ALICE; GET via per-key + bulk endpoints.
      // ---------------------------------------------------------------
      currentUserId = ALICE;
      const post = await jsonRequest(
        "POST",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/notes`,
        { body: "first note from alice" },
      );
      check("POST note → 200", post.status === 200, `got ${post.status}`);
      check(
        "POST response carries note id + body + author",
        typeof post.body?.id === "string"
          && post.body?.body === "first note from alice"
          && post.body?.createdByUserId === ALICE,
        JSON.stringify(post.body).slice(0, 160),
      );
      const noteId: string = post.body.id;

      // Empty body → 400.
      const emptyPost = await jsonRequest(
        "POST",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/notes`,
        { body: "   " },
      );
      check(
        "POST empty/whitespace body → 400",
        emptyPost.status === 400,
        `got ${emptyPost.status}`,
      );

      const perKey = await jsonRequest(
        "GET",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/notes`,
      );
      check(
        "GET per-key notes → 200 with 1 row",
        perKey.status === 200
          && Array.isArray(perKey.body)
          && perKey.body.length === 1
          && perKey.body[0].id === noteId,
        `status=${perKey.status} len=${Array.isArray(perKey.body) ? perKey.body.length : "?"}`,
      );

      // Task #1700 — Bulk endpoint now returns real rows so the
      // Conversation Hub inbox can paint per-thread note badges in
      // a single round-trip. Seed a second note on OTHER_KEY so we
      // can also exercise the optional `keys=` query-param filter.
      const otherPost = await jsonRequest(
        "POST",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(OTHER_KEY)}/notes`,
        { body: "note on other thread" },
      );
      check(
        "POST note on OTHER_KEY → 200",
        otherPost.status === 200,
        `got ${otherPost.status}`,
      );
      const otherNoteId: string = otherPost.body.id;

      const bulk = await jsonRequest(
        "GET",
        `${baseUrl}/api/twilio/threads/notes`,
      );
      const bulkKeys: string[] = Array.isArray(bulk.body)
        ? bulk.body.map((n: any) => n.threadKey)
        : [];
      check(
        "GET bulk notes → 200 returns notes across all threads",
        bulk.status === 200
          && Array.isArray(bulk.body)
          && bulk.body.length === 2
          && bulkKeys.includes(THREAD_KEY)
          && bulkKeys.includes(OTHER_KEY)
          && bulk.body.every((n: any) => typeof n.createdByUserId === "string"),
        `status=${bulk.status} len=${Array.isArray(bulk.body) ? bulk.body.length : "?"}`,
      );

      const bulkFiltered = await jsonRequest(
        "GET",
        `${baseUrl}/api/twilio/threads/notes?keys=${encodeURIComponent(THREAD_KEY)}`,
      );
      check(
        "GET bulk notes?keys=THREAD_KEY → only that thread's notes",
        bulkFiltered.status === 200
          && Array.isArray(bulkFiltered.body)
          && bulkFiltered.body.length === 1
          && bulkFiltered.body[0].threadKey === THREAD_KEY,
        `status=${bulkFiltered.status} len=${Array.isArray(bulkFiltered.body) ? bulkFiltered.body.length : "?"}`,
      );

      // Clean up the OTHER_KEY note so later assertions about
      // THREAD_KEY's note lifecycle stay independent.
      const cleanupOther = await jsonRequest(
        "DELETE",
        `${baseUrl}/api/twilio/threads/notes/${otherNoteId}`,
      );
      check(
        "DELETE OTHER_KEY note (cleanup) → 200",
        cleanupOther.status === 200,
        `got ${cleanupOther.status}`,
      );

      // ---------------------------------------------------------------
      // (2) DELETE blocked for non-author (BOB), allowed for author (ALICE).
      // ---------------------------------------------------------------
      currentUserId = BOB;
      const delByOther = await jsonRequest(
        "DELETE",
        `${baseUrl}/api/twilio/threads/notes/${noteId}`,
      );
      check(
        "DELETE by non-author → 404",
        delByOther.status === 404,
        `got ${delByOther.status}`,
      );

      // Note must still be there.
      currentUserId = ALICE;
      const stillThere = await jsonRequest(
        "GET",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/notes`,
      );
      check(
        "note survives non-author delete attempt",
        Array.isArray(stillThere.body) && stillThere.body.length === 1,
        `len=${Array.isArray(stillThere.body) ? stillThere.body.length : "?"}`,
      );

      const delByAuthor = await jsonRequest(
        "DELETE",
        `${baseUrl}/api/twilio/threads/notes/${noteId}`,
      );
      check(
        "DELETE by author → 200",
        delByAuthor.status === 200 && delByAuthor.body?.ok === true,
        `got ${delByAuthor.status}`,
      );

      const afterDelete = await jsonRequest(
        "GET",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/notes`,
      );
      check(
        "note is gone after author delete",
        Array.isArray(afterDelete.body) && afterDelete.body.length === 0,
        `len=${Array.isArray(afterDelete.body) ? afterDelete.body.length : "?"}`,
      );

      // ---------------------------------------------------------------
      // (3) Notes survive across two SMS conversations sharing the
      //     same `phone:` key — the unified key is what we persist on,
      //     not a per-conversation id.
      // ---------------------------------------------------------------
      currentUserId = ALICE;
      const cross1 = await jsonRequest(
        "POST",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/notes`,
        { body: "from conversation A" },
      );
      const cross2 = await jsonRequest(
        "POST",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/notes`,
        { body: "from conversation B" },
      );
      check(
        "two further notes posted under same phone: key",
        cross1.status === 200 && cross2.status === 200,
        `${cross1.status}/${cross2.status}`,
      );

      // A second SMS conversation that shares the same phone-derived
      // key should see both notes via the same per-key endpoint — that
      // is the entire point of keying on `phone:<digits>` instead of
      // a conversation id.
      const sharedKey = await jsonRequest(
        "GET",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/notes`,
      );
      check(
        "per-key GET returns both notes for shared phone: key",
        Array.isArray(sharedKey.body)
          && sharedKey.body.length === 2
          && sharedKey.body.map((n: any) => n.body).sort().join("|")
            === ["from conversation A", "from conversation B"].sort().join("|"),
        `len=${Array.isArray(sharedKey.body) ? sharedKey.body.length : "?"}`,
      );

      // The OTHER phone-keyed thread must be isolated.
      const otherKeyNotes = await jsonRequest(
        "GET",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(OTHER_KEY)}/notes`,
      );
      check(
        "different phone: key returns no notes (isolation)",
        Array.isArray(otherKeyNotes.body) && otherKeyNotes.body.length === 0,
        `len=${Array.isArray(otherKeyNotes.body) ? otherKeyNotes.body.length : "?"}`,
      );

      // ---------------------------------------------------------------
      // (4) GET assignment before any PATCH → empty default row.
      // ---------------------------------------------------------------
      const assignBefore = await jsonRequest(
        "GET",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/assignment`,
      );
      check(
        "GET assignment (empty) → 200 with default shape",
        assignBefore.status === 200
          && assignBefore.body?.threadKey === THREAD_KEY
          && assignBefore.body?.assignedToUserId === null
          && assignBefore.body?.status === "open",
        JSON.stringify(assignBefore.body).slice(0, 160),
      );

      // ---------------------------------------------------------------
      // (5) PATCH assignment to user, then null. Each PATCH only writes
      //     the fields it sends, so a status-only PATCH must NOT clear
      //     the assignee and vice versa.
      // ---------------------------------------------------------------
      const patchAssign = await jsonRequest(
        "PATCH",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/assignment`,
        { assignedToUserId: BOB },
      );
      check(
        "PATCH assignedToUserId=BOB → 200",
        patchAssign.status === 200
          && patchAssign.body?.assignedToUserId === BOB
          && patchAssign.body?.status === "open",
        JSON.stringify(patchAssign.body).slice(0, 160),
      );

      // PATCH status only — assignee must persist.
      const patchStatusFollowup = await jsonRequest(
        "PATCH",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/assignment`,
        { status: "needs_follow_up" },
      );
      check(
        "PATCH status=needs_follow_up preserves assignee",
        patchStatusFollowup.status === 200
          && patchStatusFollowup.body?.status === "needs_follow_up"
          && patchStatusFollowup.body?.assignedToUserId === BOB,
        JSON.stringify(patchStatusFollowup.body).slice(0, 160),
      );

      const patchStatusResolved = await jsonRequest(
        "PATCH",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/assignment`,
        { status: "resolved" },
      );
      check(
        "PATCH status=resolved → 200",
        patchStatusResolved.status === 200
          && patchStatusResolved.body?.status === "resolved",
        JSON.stringify(patchStatusResolved.body).slice(0, 160),
      );

      const patchStatusOpen = await jsonRequest(
        "PATCH",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/assignment`,
        { status: "open" },
      );
      check(
        "PATCH status=open → 200",
        patchStatusOpen.status === 200
          && patchStatusOpen.body?.status === "open",
        JSON.stringify(patchStatusOpen.body).slice(0, 160),
      );

      // PATCH unassign (assignedToUserId: null) — assignee clears, status stays.
      const patchUnassign = await jsonRequest(
        "PATCH",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/assignment`,
        { assignedToUserId: null },
      );
      check(
        "PATCH assignedToUserId=null clears assignee",
        patchUnassign.status === 200
          && patchUnassign.body?.assignedToUserId === null
          && patchUnassign.body?.status === "open",
        JSON.stringify(patchUnassign.body).slice(0, 160),
      );

      // Empty body → 400 (the schema's refine() requires at least one field).
      const patchEmpty = await jsonRequest(
        "PATCH",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/assignment`,
        {},
      );
      check(
        "PATCH empty body → 400",
        patchEmpty.status === 400,
        `got ${patchEmpty.status}`,
      );

      // Invalid status → 400.
      const patchBadStatus = await jsonRequest(
        "PATCH",
        `${baseUrl}/api/twilio/threads/${encodeURIComponent(THREAD_KEY)}/assignment`,
        { status: "bogus_value" },
      );
      check(
        "PATCH invalid status enum → 400",
        patchBadStatus.status === 400,
        `got ${patchBadStatus.status}`,
      );

      // ---------------------------------------------------------------
      // (6) Bulk GET assignments returns the row we just wrote.
      // ---------------------------------------------------------------
      const bulkAssigns = await jsonRequest(
        "GET",
        `${baseUrl}/api/twilio/threads/assignments`,
      );
      check(
        "GET bulk assignments → 200, includes our thread",
        bulkAssigns.status === 200
          && Array.isArray(bulkAssigns.body)
          && bulkAssigns.body.some(
            (a: any) => a.threadKey === THREAD_KEY && a.status === "open",
          ),
        `status=${bulkAssigns.status} len=${Array.isArray(bulkAssigns.body) ? bulkAssigns.body.length : "?"}`,
      );
    });

    currentUserId = null;
    __test_resetReconciledUsers();
  }, {
    // Clone every table the seed + the routes' storage functions touch, and
    // pin getDb() at the isolated handle so the cross-async Express request
    // handlers resolve there (see the db-sandbox contract). FKs are NOT
    // copied by CREATE TABLE (LIKE … INCLUDING ALL), so the notes/assignment
    // rows can reference the cloned `users` ids without a public.users FK.
    tables: [
      "users",
      "thread_notes",
      "thread_assignments",
      "thread_assignment_notifications",
    ],
    pinGetDbForCrossAsync: true,
  });
}

async function main(): Promise<void> {
  console.log("Conversation Hub thread notes + assignment routes (Task #1289)");

  await testNotesAndAssignmentRoutes();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
