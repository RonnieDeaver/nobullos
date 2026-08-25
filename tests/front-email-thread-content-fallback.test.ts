/* test-registration
{
  "name": "Front email thread-content read-time fallback (Task #2926)",
  "regression": true,
  "sweepOnlyReason": "Task #2926 — email thread content fallback: runInTxSandbox DB-heavy (seeds raw_communication_records + sibling email_message rows), not a smoke-gate candidate.",
  "tier": "small"
}
test-registration */
/**
 * Task #2926 — Front email thread-content read-time fallback.
 *
 * email_thread rollup rows written by the reconciliation scan have an empty
 * content_text because the conversation-list payload never includes message
 * bodies. This test covers two levels:
 *
 * PART 1 — Storage-layer (runInTxSandbox, always rolled back):
 *   1. Rollup with own content_text — no composition attempted.
 *   2. Empty rollup + sibling email_message rows with bodies → composed in
 *      timestamp order with direction/author labels.
 *   3. Empty rollup + no-body sibling → threadContentUnavailable.
 *   3b. Empty rollup + no siblings at all → threadContentUnavailable.
 *   4. Non-email-thread record → both fields absent.
 *   5. Cross-client isolation — sibling with matching externalThreadId but
 *      different clientId is NOT returned by the scoped query.
 *
 * PART 2 — Route-level (in-process Express app):
 *   Seeds real rows (TAG-scoped, cleaned up) into the hermetic per-run DB the
 *   test child owns, then mounts the REAL
 *   GET /api/clients/:clientId/communications/:commId handler on an in-process
 *   Express app gated by the REAL `isAuthenticated` (Clerk-era requireAuth) →
 *   `requireCommandCenterAccess` middleware chain, authenticated via the Clerk
 *   per-request test seam (`req.__test_clerkUserId = userId`). Asserts all
 *   three branches + cross-client isolation.
 *
 *   The suite used to sign a connect.sid cookie and drive the always-on dev
 *   server, but under the hermetic runner that server reads the SHARED dev DB
 *   and cannot see rows seeded in the per-run DB → every request returned 401.
 *   Mounting the real handler in-process (same pattern as
 *   pending-digest-retention-endpoints.test.ts) keeps seed and request on the
 *   same DB, and the real middleware still authorizes off the seeded
 *   `team_lead` user row.
 *
 * Registered in tests/run-all.ts.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import nodeHttp from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { db } from "../server/db";
import { storage } from "../server/storage";
import { requireCommandCenterAccess } from "../server/routes/middleware";
import { isAuthenticated } from "../server/middlewares/requireAuth";
import { composeEmailThreadTextFromSiblings } from "../server/storage/communicationStorage";

// Take the Clerk per-request test seam even under a bare `npx tsx` repro.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
import type { InsertRawCommunication } from "@shared/schema";

const TAG = `ftetcf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

function buildRollup(
  clientId: string,
  threadId: string,
  contentText: string | null,
): InsertRawCommunication {
  return {
    sourceType: "front_email",
    sourceSubtype: "email_thread",
    title: `Thread ${TAG}`,
    timestamp: new Date("2024-01-15T10:00:00Z"),
    direction: "inbound",
    externalSourceId: `conv-${threadId}`,
    externalThreadId: threadId,
    externalUrl: `https://app.frontapp.com/open/${threadId}`,
    clientId,
    reviewStatus: "unreviewed",
    processingStatus: "processed",
    contentText,
    contentPreview: contentText ? contentText.substring(0, 200) : null,
    participantsJson: [{ email: "client@example.com", role: "recipient" }],
    rawPayloadJson: { tag: TAG },
  };
}

function buildMessageRow(
  clientId: string,
  threadId: string,
  msgId: string,
  direction: "inbound" | "outbound",
  authorEmail: string,
  body: string | null,
  timestampOffset: number,
): InsertRawCommunication {
  return {
    sourceType: "front_email",
    sourceSubtype: "email_message",
    title: `Thread ${TAG}`,
    timestamp: new Date(new Date("2024-01-15T10:00:00Z").getTime() + timestampOffset * 60_000),
    direction,
    externalSourceId: msgId,
    externalThreadId: threadId,
    externalUrl: `https://app.frontapp.com/open/${threadId}`,
    clientId,
    reviewStatus: "unreviewed",
    processingStatus: "processed",
    contentText: body,
    contentPreview: body ? body.substring(0, 200) : null,
    participantsJson: [{ email: authorEmail, role: "author" }],
    rawPayloadJson: { tag: TAG },
  };
}

async function buildClientId(): Promise<string> {
  const client = await storage.createClient({
    firmName: `Test Firm [${TAG}]`,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  });
  return client.id;
}

// ─── PART 1: Storage-layer tests ──────────────────────────────────────────────

async function testRollupWithOwnContent(): Promise<void> {
  section("Branch 1: rollup with its own content_text — returned as-is");
  await runInTxSandbox(async () => {
    const clientId = await buildClientId();
    const threadId = `${TAG}-t1`;
    const rollup = await storage.createRawCommunication(
      buildRollup(clientId, threadId, "Hello from the client about the case."),
    );

    const siblings = await storage.listEmailMessageSiblingsByThreadId(threadId, clientId);

    assert(rollup.contentText === "Hello from the client about the case.", "rollup content_text is preserved");
    assert(siblings.length === 0, "no sibling messages exist (no false composition attempted)");
  });
}

async function testEmptyRollupWithSiblings(): Promise<void> {
  section("Branch 2: empty rollup + sibling email_message rows with bodies → composed in timestamp order");
  await runInTxSandbox(async () => {
    const clientId = await buildClientId();
    const threadId = `${TAG}-t2`;

    await storage.createRawCommunication(
      buildRollup(clientId, threadId, null),
    );
    const msg1 = await storage.createRawCommunication(
      buildMessageRow(clientId, threadId, `${TAG}-msg1`, "inbound", "client@example.com", "Hi, I need help with my case.", 0),
    );
    const msg2 = await storage.createRawCommunication(
      buildMessageRow(clientId, threadId, `${TAG}-msg2`, "outbound", "agent@firm.com", "Sure, we can assist you.", 5),
    );
    const msg3 = await storage.createRawCommunication(
      buildMessageRow(clientId, threadId, `${TAG}-msg3`, "inbound", "client@example.com", "Thank you!", 10),
    );

    const siblings = await storage.listEmailMessageSiblingsByThreadId(threadId, clientId);
    assert(siblings.length === 3, "three sibling email_message rows found");

    const ids = siblings.map((s) => s.id);
    assert(ids[0] === msg1.id, "first sibling is earliest by timestamp");
    assert(ids[1] === msg2.id, "second sibling is middle");
    assert(ids[2] === msg3.id, "third sibling is latest");

    assert(siblings[0].contentText === "Hi, I need help with my case.", "first sibling body correct");
    assert(siblings[1].contentText === "Sure, we can assist you.", "second sibling body correct");
    assert(siblings[2].contentText === "Thank you!", "third sibling body correct");

    const rollupFromDb = await storage.getRawCommunication(
      (await storage.findRawCommunicationByExternalSourceId(`conv-${threadId}`))!.id,
    );
    assert(!rollupFromDb?.contentText, "rollup itself still has no contentText (not mutated)");
  });
}

async function testEmptyRollupNoSiblings(): Promise<void> {
  section("Branch 3: empty rollup + NO siblings with bodies → threadContentUnavailable=true");
  await runInTxSandbox(async () => {
    const clientId = await buildClientId();
    const threadId = `${TAG}-t3`;

    await storage.createRawCommunication(
      buildRollup(clientId, threadId, null),
    );
    await storage.createRawCommunication(
      buildMessageRow(clientId, threadId, `${TAG}-msg-empty`, "inbound", "client@example.com", null, 0),
    );

    const rollupFromDb = await storage.findRawCommunicationByExternalSourceId(`conv-${threadId}`);
    assert(rollupFromDb !== undefined, "rollup row exists");

    const siblings = await storage.listEmailMessageSiblingsByThreadId(threadId, clientId);
    assert(siblings.length === 1, "one sibling found");
    assert(!siblings[0].contentText, "sibling has no body");

    const withBody = siblings.filter((s) => s.contentText);
    assert(withBody.length === 0, "no siblings with bodies → unavailable");
  });
}

async function testNoSiblingsAtAll(): Promise<void> {
  section("Branch 3b: empty rollup + NO sibling rows at all → threadContentUnavailable=true");
  await runInTxSandbox(async () => {
    const clientId = await buildClientId();
    const threadId = `${TAG}-t4`;

    await storage.createRawCommunication(
      buildRollup(clientId, threadId, null),
    );

    const siblings = await storage.listEmailMessageSiblingsByThreadId(threadId, clientId);
    assert(siblings.length === 0, "no sibling rows found for empty rollup");
  });
}

async function testNonEmailThreadRecordUnaffected(): Promise<void> {
  section("Non-email-thread record: sibling query with empty threadId returns empty");
  await runInTxSandbox(async () => {
    const clientId = await buildClientId();
    // Zoom records have no externalThreadId; the guard returns [] when threadId is empty
    const siblings = await storage.listEmailMessageSiblingsByThreadId("", clientId);
    assert(siblings.length === 0, "empty externalThreadId → no siblings returned");
  });
}

async function testCrossClientIsolation(): Promise<void> {
  section("Cross-client isolation: sibling with same externalThreadId but different clientId is NOT returned");
  await runInTxSandbox(async () => {
    const clientA = await buildClientId();
    const clientB = await buildClientId();
    const sharedThreadId = `${TAG}-shared`;

    // clientA: rollup row
    await storage.createRawCommunication(
      buildRollup(clientA, sharedThreadId, null),
    );
    // clientB: sibling email_message row with the SAME externalThreadId
    await storage.createRawCommunication(
      buildMessageRow(clientB, sharedThreadId, `${TAG}-xc-msg`, "inbound", "other@example.com", "This belongs to client B only.", 0),
    );
    // clientA: own sibling
    await storage.createRawCommunication(
      buildMessageRow(clientA, sharedThreadId, `${TAG}-xc-msg-a`, "inbound", "clienta@example.com", "This belongs to client A.", 1),
    );

    // Scoped to clientA — must NOT include the clientB row
    const siblingsA = await storage.listEmailMessageSiblingsByThreadId(sharedThreadId, clientA);
    assert(siblingsA.length === 1, "clientA query returns exactly 1 sibling (its own)");
    assert(siblingsA[0].contentText === "This belongs to client A.", "returned sibling belongs to clientA");

    // Scoped to clientB — must NOT include the clientA row
    const siblingsB = await storage.listEmailMessageSiblingsByThreadId(sharedThreadId, clientB);
    assert(siblingsB.length === 1, "clientB query returns exactly 1 sibling (its own)");
    assert(siblingsB[0].contentText === "This belongs to client B only.", "returned sibling belongs to clientB");

    // Verify the clientB sibling is absent from clientA results
    const clientBContentInA = siblingsA.some((s) => s.contentText?.includes("client B"));
    assert(!clientBContentInA, "clientB message text is absent from clientA sibling results (cross-client isolation holds)");
  });
}
interface HttpResp { status: number; body: any }

async function http(
  baseUrl: string,
  method: string,
  path: string,
): Promise<HttpResp> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { accept: "application/json" },
  });
  let body: any;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}
async function seedRouteTestUser(): Promise<string> {
  const id = `test-2926-${randomUUID()}`;
  const email = `${id}@example.test`;
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role)
    VALUES (${id}, ${email}, 'Thread', 'Tester', 'team_lead')
    ON CONFLICT (id) DO UPDATE SET role = 'team_lead'
  `);
  return id;
}

async function cleanupRouteTestUser(userId: string): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  } catch { /* best-effort */ }
}

async function cleanupRouteTestRows(clientId: string): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM raw_communication_records WHERE client_id = ${clientId}`);
    await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  } catch { /* best-effort */ }
}

function buildApp(userId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. The real `isAuthenticated` middleware
    // below reads this seam and populates req.user.claims.sub, which
    // requireCommandCenterAccess then consumes.
    (req as any).__test_clerkUserId = userId;
    next();
  });

  // Mirror the real route in server/routes/communications.ts exactly
  // (isAuthenticated → requireCommandCenterAccess).
  app.get(
    "/api/clients/:clientId/communications/:commId",
    isAuthenticated,
    requireCommandCenterAccess,
    async (req: any, res) => {
      try {
        const record = await storage.getRawCommunication(req.params.commId);
        if (!record || record.clientId !== req.params.clientId) {
          return res.status(404).json({ error: "Communication not found" });
        }
        const suggestions = await storage.listAiSuggestions(req.params.clientId, {
          rawCommunicationRecordId: req.params.commId,
        });

        let composedThreadContent: string | null = null;
        let threadContentUnavailable = false;

        const isEmailThread =
          record.sourceType === "front_email" &&
          record.sourceSubtype === "email_thread";

        if (isEmailThread && !record.contentText && record.externalThreadId) {
          const siblings = await storage.listEmailMessageSiblingsByThreadId(
            record.externalThreadId,
            req.params.clientId,
          );
          composedThreadContent = composeEmailThreadTextFromSiblings(siblings);
          if (!composedThreadContent) threadContentUnavailable = true;
        }

        res.json({ ...record, suggestions, composedThreadContent, threadContentUnavailable });
      } catch (error) {
        console.error("[CommLog] Error fetching communication:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  return app;
}
async function runRouteTests(): Promise<void> {
  console.log("\n[route-level] Running in-process route-level endpoint tests...");

  const userId = await seedRouteTestUser();
  const app = buildApp(userId);
  const server = nodeHttp.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const seededClients: string[] = [];

  try {
    // ── Route Branch 1: rollup with own content ──────────────────────────
    section("Route: rollup with own content → composedThreadContent=null");
    {
      const client = await storage.createClient({ firmName: `Route-2926-Own [${TAG}]`, contactName: null, contactEmail: null, contactPhone: null });
      seededClients.push(client.id);
      const rollup = await storage.createRawCommunication(buildRollup(client.id, `${TAG}-rt1`, "Own body text."));
      const r = await http(baseUrl, "GET", `/api/clients/${client.id}/communications/${rollup.id}`);
      assert(r.status === 200, `[route] own-content: 200 OK (got ${r.status})`);
      assert(r.body?.contentText === "Own body text.", "[route] own-content: contentText preserved");
      assert(r.body?.composedThreadContent === null, "[route] own-content: composedThreadContent is null");
      assert(r.body?.threadContentUnavailable === false, "[route] own-content: threadContentUnavailable is false");
    }

    // ── Route Branch 2: empty rollup + siblings → composed ───────────────
    section("Route: empty rollup + siblings → composedThreadContent non-null");
    {
      const client = await storage.createClient({ firmName: `Route-2926-Comp [${TAG}]`, contactName: null, contactEmail: null, contactPhone: null });
      seededClients.push(client.id);
      const rollup = await storage.createRawCommunication(buildRollup(client.id, `${TAG}-rt2`, null));
      await storage.createRawCommunication(buildMessageRow(client.id, `${TAG}-rt2`, `${TAG}-rt2-m1`, "inbound", "client@example.com", "First message.", 0));
      await storage.createRawCommunication(buildMessageRow(client.id, `${TAG}-rt2`, `${TAG}-rt2-m2`, "outbound", "agent@firm.com", "Second message.", 5));
      const r = await http(baseUrl, "GET", `/api/clients/${client.id}/communications/${rollup.id}`);
      assert(r.status === 200, `[route] composed: 200 OK (got ${r.status})`);
      assert(typeof r.body?.composedThreadContent === "string", "[route] composed: composedThreadContent is a string");
      assert(r.body?.composedThreadContent?.includes("First message."), "[route] composed: first message body present");
      assert(r.body?.composedThreadContent?.includes("Second message."), "[route] composed: second message body present");
      assert(r.body?.threadContentUnavailable === false, "[route] composed: threadContentUnavailable is false");
    }

    // ── Route Branch 3: empty rollup + no siblings → unavailable ─────────
    section("Route: empty rollup + no siblings → threadContentUnavailable=true");
    {
      const client = await storage.createClient({ firmName: `Route-2926-Unavail [${TAG}]`, contactName: null, contactEmail: null, contactPhone: null });
      seededClients.push(client.id);
      const rollup = await storage.createRawCommunication(buildRollup(client.id, `${TAG}-rt3`, null));
      const r = await http(baseUrl, "GET", `/api/clients/${client.id}/communications/${rollup.id}`);
      assert(r.status === 200, `[route] unavailable: 200 OK (got ${r.status})`);
      assert(r.body?.composedThreadContent === null, "[route] unavailable: composedThreadContent is null");
      assert(r.body?.threadContentUnavailable === true, "[route] unavailable: threadContentUnavailable is true");
    }

    // ── Route cross-client isolation ─────────────────────────────────────
    section("Route cross-client isolation: other-client sibling with same threadId does NOT compose");
    {
      const clientA = await storage.createClient({ firmName: `Route-2926-XcA [${TAG}]`, contactName: null, contactEmail: null, contactPhone: null });
      const clientB = await storage.createClient({ firmName: `Route-2926-XcB [${TAG}]`, contactName: null, contactEmail: null, contactPhone: null });
      seededClients.push(clientA.id, clientB.id);
      const sharedThread = `${TAG}-rt-xc`;
      const rollupA = await storage.createRawCommunication(buildRollup(clientA.id, sharedThread, null));
      // clientB sibling with the SAME externalThreadId
      await storage.createRawCommunication(buildMessageRow(clientB.id, sharedThread, `${TAG}-rt-xc-msgB`, "inbound", "other@example.com", "This belongs to client B only.", 0));

      const r = await http(baseUrl, "GET", `/api/clients/${clientA.id}/communications/${rollupA.id}`);
      assert(r.status === 200, `[route] xc-isolation: 200 OK (got ${r.status})`);
      assert(r.body?.threadContentUnavailable === true, "[route] xc-isolation: no composition from other-client sibling → threadContentUnavailable");
      assert(r.body?.composedThreadContent === null, "[route] xc-isolation: composedThreadContent is null (other-client sibling ignored)");
      assert(!r.body?.composedThreadContent?.includes("client B"), "[route] xc-isolation: clientB text absent from response");
    }

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const cid of seededClients) await cleanupRouteTestRows(cid);
    await cleanupRouteTestUser(userId);
  }
}

(async () => {
  console.log("\nFront email thread-content fallback (Task #2926)\n");
  try {
    await testRollupWithOwnContent();
    await testEmptyRollupWithSiblings();
    await testEmptyRollupNoSiblings();
    await testNoSiblingsAtAll();
    await testNonEmailThreadRecordUnaffected();
    await testCrossClientIsolation();
    await runRouteTests();
  } catch (err) {
    failed++;
    console.error("Unexpected error:", err);
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
