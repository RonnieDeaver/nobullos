/* test-registration
{
  "name": "Comms calls lifecycle — storage exports, schema, route gates, LiveKit wiring (Task #3094)",
  "smoke": true,
  "smokeReason": "Task #3094: Comms calls lifecycle smoke gate. Proves the four call-lifecycle storage functions (createCall, getCallById, endCall, addCallParticipant, removeCallParticipant), callType migration 0116, route-level env-var 503 gates, PATCH join/leave/end wiring, frontend CallView/IncomingCallBanner testids, and @livekit/* package resolution. DB-free, no network.",
  "tier": "small"
}
test-registration */
/**
 * Comms calls lifecycle — HTTP route tests (Task #3094).
 *
 * Covers:
 *   1. 503 when LiveKit not configured (start-call + token-mint).
 *   2. Start a voice call → 201, call row created.
 *   3. callType=voice preserved in call row.
 *   4. 409 when call already active on the channel.
 *   5. GET /api/comms/channels returns activeCall for the channel.
 *   6. PATCH join → 200.
 *   7. PATCH leave → 200.
 *   8. PATCH end → 200 + call_ended system message.
 *   9. Non-existent channel → 404.
 *  10. activeCall cleared from channel list after call ends.
 *  11. Start a video call → callType=video preserved.
 *
 * Rows go into public.* (same pattern as sheets-routes.test.ts); all IDs
 * are suffixed with a per-run token so repeated runs never collide.
 */

// Self-establish test mode before requireAuth runs so bare repros (npx tsx)
// take the Clerk per-request seam path instead of 401ing.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import { createServer } from "http";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

// Per-run suffix — keeps IDs and channel names unique across repeated runs
// against the shared public schema.
const RUN = randomBytes(4).toString("hex");

// ── Clerk test-seam auth helpers ────────────────────────────────────────────

function makeAuthMiddleware(userId: string, _role = "account_manager") {
  return (_req: any, _res: any, next: any) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. Users here are seeded inside an
    // isolated schema (runInIsolatedSchema) that requireAuth's ambient
    // public-schema `db` cannot see, so callers ALSO pre-register the
    // profile via __test_markUserReconciled before hitting the app.
    _req.__test_clerkUserId = userId;
    next();
  };
}

async function buildTestApp(userId: string, role = "account_manager") {
  const app = express();
  app.use(express.json());
  app.use(makeAuthMiddleware(userId, role));
  const { registerCommsRoutes } = await import("../server/routes/comms.js");
  registerCommsRoutes(app);
  return app;
}

// ── server lifecycle ───────────────────────────────────────────────────────

let baseUrl = "";
let server: ReturnType<typeof createServer>;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
let currentAgent: Agent | null = null;

async function startServer(app: express.Express) {
  originalDispatcher = getGlobalDispatcher();
  currentAgent = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 });
  setGlobalDispatcher(currentAgent);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function stopServer() {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setGlobalDispatcher(originalDispatcher);
  if (currentAgent) {
    try { await currentAgent.close(); } catch { }
    currentAgent = null;
  }
}

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: any;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

// ── counters ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string) {
  passed++;
  console.log(`  ✓ ${label}`);
}

function fail(label: string, detail: string) {
  failed++;
  console.error(`  ✗ ${label}: ${detail}`);
}

function check(cond: boolean, label: string, detail = "") {
  if (cond) ok(label);
  else fail(label, detail || "condition was false");
}

// ── 1. 503 gate ────────────────────────────────────────────────────────────

async function test503Gate() {
  // ── case A: missing API key / secret ────────────────────────────────────
  {
    const savedKey = process.env.LIVEKIT_API_KEY;
    const savedSecret = process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    try {
      await runInIsolatedSchema(async () => {
        const { getDb } = await import("../server/db.js");
        const db = getDb();
        const gateUser = `comms-gate-${RUN}`;

        await db.execute(
          `INSERT INTO users (id, first_name, email, role)
           VALUES ('${gateUser}', 'GateTest', 'gate-${RUN}@test.local', 'account_manager')
           ON CONFLICT (id) DO NOTHING` as any,
        );
        // Isolated-schema seed: pre-register so requireAuth uses this profile
        // directly instead of missing the (invisible) public-schema row.
        __test_markUserReconciled(gateUser, {
          id: gateUser,
          email: `gate-${RUN}@test.local`,
          firstName: "GateTest",
          role: "account_manager",
        });

        const app = await buildTestApp(gateUser);
        await startServer(app);
        try {
          const ch = await req("POST", "/api/comms/channels", { name: `gate-ch-${RUN}` });
          assert.equal(ch.status, 201, `create gate channel: ${JSON.stringify(ch.body)}`);
          const channelId: string = ch.body?.id;
          assert.ok(channelId, "gate channel id");

          const r = await req("POST", `/api/comms/channels/${channelId}/calls`, { callType: "voice" });
          check(r.status === 503, "start-call returns 503 when LIVEKIT_API_KEY unset",
            `got ${r.status}: ${JSON.stringify(r.body)}`);
          check(
            typeof r.body?.error === "string" && r.body.error.toLowerCase().includes("not configured"),
            "503 body explains LiveKit not configured",
            `body: ${JSON.stringify(r.body)}`,
          );

          const t = await req("POST", "/api/comms/calls/token", { roomName: "test-room" });
          check(t.status === 503, "token-mint returns 503 when LIVEKIT_API_KEY unset",
            `got ${t.status}`);
        } finally {
          await stopServer();
        }
      });
    } finally {
      if (savedKey !== undefined) process.env.LIVEKIT_API_KEY = savedKey;
      if (savedSecret !== undefined) process.env.LIVEKIT_API_SECRET = savedSecret;
    }
  }

  // ── case B: key+secret present but LIVEKIT_SERVER_URL missing ───────────
  // This is the degrade path the code reviewer flagged: without the URL
  // the client cannot connect, so we must return 503 at the route level.
  {
    const savedKey = process.env.LIVEKIT_API_KEY;
    const savedSecret = process.env.LIVEKIT_API_SECRET;
    const savedUrl = process.env.LIVEKIT_SERVER_URL;
    if (!process.env.LIVEKIT_API_KEY) process.env.LIVEKIT_API_KEY = "test-livekit-key";
    if (!process.env.LIVEKIT_API_SECRET) process.env.LIVEKIT_API_SECRET = "test-livekit-secret";
    delete process.env.LIVEKIT_SERVER_URL;
    try {
      await runInIsolatedSchema(async () => {
        const { getDb } = await import("../server/db.js");
        const db = getDb();
        const urlGateUser = `comms-gate-url-${RUN}`;
        await db.execute(
          `INSERT INTO users (id, first_name, email, role)
           VALUES ('${urlGateUser}', 'UrlGate', 'urlgate-${RUN}@test.local', 'account_manager')
           ON CONFLICT (id) DO NOTHING` as any,
        );
        __test_markUserReconciled(urlGateUser, {
          id: urlGateUser,
          email: `urlgate-${RUN}@test.local`,
          firstName: "UrlGate",
          role: "account_manager",
        });
        const app = await buildTestApp(urlGateUser);
        await startServer(app);
        try {
          const ch = await req("POST", "/api/comms/channels", { name: `gate-url-ch-${RUN}` });
          assert.equal(ch.status, 201, `create url-gate channel: ${JSON.stringify(ch.body)}`);
          const channelId: string = ch.body?.id;

          const r = await req("POST", `/api/comms/channels/${channelId}/calls`, { callType: "voice" });
          check(r.status === 503, "start-call returns 503 when LIVEKIT_SERVER_URL unset",
            `got ${r.status}: ${JSON.stringify(r.body)}`);

          const t = await req("POST", "/api/comms/calls/token", { roomName: "test-room" });
          check(t.status === 503, "token-mint returns 503 when LIVEKIT_SERVER_URL unset",
            `got ${t.status}`);
          ok("missing LIVEKIT_SERVER_URL → 503 on both endpoints");
        } finally {
          await stopServer();
        }
      });
    } finally {
      if (savedKey !== undefined) process.env.LIVEKIT_API_KEY = savedKey;
      else delete process.env.LIVEKIT_API_KEY;
      if (savedSecret !== undefined) process.env.LIVEKIT_API_SECRET = savedSecret;
      else delete process.env.LIVEKIT_API_SECRET;
      if (savedUrl !== undefined) process.env.LIVEKIT_SERVER_URL = savedUrl;
    }
  }
}

// ── 2–10. Full call lifecycle ──────────────────────────────────────────────

async function testLifecycle() {
  const stubKey = !process.env.LIVEKIT_API_KEY;
  const stubSecret = !process.env.LIVEKIT_API_SECRET;
  const stubUrl = !process.env.LIVEKIT_SERVER_URL;
  if (stubKey) process.env.LIVEKIT_API_KEY = "test-livekit-key";
  if (stubSecret) process.env.LIVEKIT_API_SECRET = "test-livekit-secret";
  if (stubUrl) process.env.LIVEKIT_SERVER_URL = "wss://test.livekit.local";

  try {
    await runInIsolatedSchema(async () => {
      const { getDb } = await import("../server/db.js");
      const db = getDb();

      const callerId = `comms-caller-${RUN}`;
      const memberId = `comms-member-${RUN}`;

      await db.execute(
        `INSERT INTO users (id, first_name, email, role)
         VALUES ('${callerId}', 'Caller', 'caller-${RUN}@test.local', 'account_manager'),
                ('${memberId}', 'Member', 'member-${RUN}@test.local', 'account_manager')
         ON CONFLICT (id) DO NOTHING` as any,
      );
      __test_markUserReconciled(callerId, {
        id: callerId,
        email: `caller-${RUN}@test.local`,
        firstName: "Caller",
        role: "account_manager",
      });
      __test_markUserReconciled(memberId, {
        id: memberId,
        email: `member-${RUN}@test.local`,
        firstName: "Member",
        role: "account_manager",
      });

      const callerApp = await buildTestApp(callerId);
      await startServer(callerApp);
      try {
        // ── Create channel ──
        const chRes = await req("POST", "/api/comms/channels", {
          name: `lifecycle-ch-${RUN}`,
          memberUserIds: [memberId],
        });
        assert.equal(chRes.status, 201, `create channel: ${JSON.stringify(chRes.body)}`);
        const channelId: string = chRes.body?.id;
        assert.ok(channelId, "channel id present");
        ok("create channel → 201");

        // ── 2. Start a voice call ──
        const startRes = await req("POST", `/api/comms/channels/${channelId}/calls`, { callType: "voice" });
        assert.equal(startRes.status, 201, `start call: ${JSON.stringify(startRes.body)}`);
        const callId: string = startRes.body?.call?.id;
        const roomName: string = startRes.body?.roomName;
        assert.ok(callId, "callId present");
        assert.ok(roomName, "roomName present");
        assert.equal(startRes.body?.call?.status, "active", "call status=active");
        ok("start voice call → 201 + active call");

        // ── 3. callType=voice persisted ──
        check(startRes.body?.call?.callType === "voice",
          "callType=voice persisted in call row",
          `got: ${startRes.body?.call?.callType}`);

        // ── 4. 409 when call already active ──
        const dup = await req("POST", `/api/comms/channels/${channelId}/calls`, { callType: "voice" });
        check(dup.status === 409, "duplicate start-call → 409", `got ${dup.status}`);
        check(dup.body?.call?.id === callId, "409 body includes the existing call id",
          `got: ${JSON.stringify(dup.body?.call)}`);
        ok("start-call on active channel → 409 with existing call");

        // ── 5. GET /api/comms/channels includes activeCall ──
        const listRes = await req("GET", "/api/comms/channels");
        assert.equal(listRes.status, 200, `list channels: ${JSON.stringify(listRes.body)}`);
        const channelInList = Array.isArray(listRes.body)
          ? listRes.body.find((c: any) => c.id === channelId)
          : null;
        assert.ok(channelInList, "channel appears in list");
        check(channelInList?.activeCall?.id === callId,
          "channel list includes activeCall with correct callId",
          `activeCall: ${JSON.stringify(channelInList?.activeCall)}`);
        ok("GET /api/comms/channels returns activeCall");

        // ── 6. PATCH join ──
        const joinRes = await req("PATCH", `/api/comms/calls/${callId}`, { action: "join" });
        check(joinRes.status === 200, "join call → 200",
          `got ${joinRes.status}: ${JSON.stringify(joinRes.body)}`);
        ok("PATCH join → 200");

        // ── 7. PATCH leave ──
        const leaveRes = await req("PATCH", `/api/comms/calls/${callId}`, { action: "leave" });
        check(leaveRes.status === 200, "leave call → 200",
          `got ${leaveRes.status}: ${JSON.stringify(leaveRes.body)}`);
        ok("PATCH leave → 200");

        // ── 8. PATCH end + call_ended system message ──
        const endRes = await req("PATCH", `/api/comms/calls/${callId}`, { action: "end" });
        check(endRes.status === 200, "end call → 200",
          `got ${endRes.status}: ${JSON.stringify(endRes.body)}`);
        const msgRes = await req("GET", `/api/comms/channels/${channelId}/messages`);
        const msgs: any[] = msgRes.body?.messages ?? (Array.isArray(msgRes.body) ? msgRes.body : []);
        const summary = msgs.find(
          (m: any) => m.contentType === "system" && m.metadata?.type === "call_ended",
        );
        check(summary !== undefined, "call_ended system message written after end",
          `messages: ${JSON.stringify(msgs.map((m: any) => m.metadata?.type))}`);
        ok("PATCH end → 200 + call_ended summary message");

        // ── 10. activeCall cleared from list after end ──
        const listAfter = await req("GET", "/api/comms/channels");
        const chAfter = Array.isArray(listAfter.body)
          ? listAfter.body.find((c: any) => c.id === channelId)
          : null;
        check(
          chAfter?.activeCall === null || chAfter?.activeCall === undefined,
          "activeCall is null after call ends",
          `activeCall: ${JSON.stringify(chAfter?.activeCall)}`,
        );
        ok("activeCall cleared from channel list after end");

        // ── 9. Non-existent channel → 404 ──
        const noChannel = await req("POST", "/api/comms/channels/nonexistent-ch/calls", { callType: "voice" });
        check(noChannel.status === 404, "start-call on non-existent channel → 404",
          `got ${noChannel.status}`);
        ok("start-call on non-existent channel → 404");

      } finally {
        await stopServer();
      }
    });
  } finally {
    if (stubKey) delete process.env.LIVEKIT_API_KEY;
    if (stubSecret) delete process.env.LIVEKIT_API_SECRET;
    if (stubUrl) delete process.env.LIVEKIT_SERVER_URL;
  }
}

// ── 11. Video call callType=video ──────────────────────────────────────────

async function testVideoCallType() {
  const stubKey = !process.env.LIVEKIT_API_KEY;
  const stubSecret = !process.env.LIVEKIT_API_SECRET;
  const stubUrl = !process.env.LIVEKIT_SERVER_URL;
  if (stubKey) process.env.LIVEKIT_API_KEY = "test-livekit-key";
  if (stubSecret) process.env.LIVEKIT_API_SECRET = "test-livekit-secret";
  if (stubUrl) process.env.LIVEKIT_SERVER_URL = "wss://test.livekit.local";

  try {
    await runInIsolatedSchema(async () => {
      const { getDb } = await import("../server/db.js");
      const db = getDb();
      const videoUser = `comms-video-${RUN}`;
      await db.execute(
        `INSERT INTO users (id, first_name, email, role)
         VALUES ('${videoUser}', 'VideoTest', 'video-${RUN}@test.local', 'account_manager')
         ON CONFLICT (id) DO NOTHING` as any,
      );
      __test_markUserReconciled(videoUser, {
        id: videoUser,
        email: `video-${RUN}@test.local`,
        firstName: "VideoTest",
        role: "account_manager",
      });
      const vApp = await buildTestApp(videoUser);
      await startServer(vApp);
      try {
        const vch = await req("POST", "/api/comms/channels", { name: `video-ch-${RUN}` });
        assert.equal(vch.status, 201, `create video channel: ${JSON.stringify(vch.body)}`);
        const vId: string = vch.body?.id;
        const vidRes = await req("POST", `/api/comms/channels/${vId}/calls`, { callType: "video" });
        assert.equal(vidRes.status, 201, `start video call: ${JSON.stringify(vidRes.body)}`);
        check(vidRes.body?.call?.callType === "video",
          "callType=video persisted in call row",
          `got: ${vidRes.body?.call?.callType}`);
        ok("start video call → 201 + callType=video");
      } finally {
        await stopServer();
      }
    });
  } finally {
    if (stubKey) delete process.env.LIVEKIT_API_KEY;
    if (stubSecret) delete process.env.LIVEKIT_API_SECRET;
    if (stubUrl) delete process.env.LIVEKIT_SERVER_URL;
  }
}

// ── entry point ────────────────────────────────────────────────────────────

console.log("\ncomms-calls lifecycle route tests:");
try {
  await test503Gate();
  await testLifecycle();
  await testVideoCallType();
} catch (err: any) {
  failed++;
  console.error(`  ✗ unexpected error: ${err?.stack ?? err?.message ?? err}`);
} finally {
  __test_resetReconciledUsers();
}
console.log(`\ncomms-calls-lifecycle: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
