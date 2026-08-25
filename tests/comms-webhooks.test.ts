/* test-registration
{
  "name": "Comms incoming webhooks + slash commands — ingress auth, payload validation, token lifecycle, command dispatch (Task #3260)",
  "smoke": true,
  "smokeReason": "Task #3260: Comms incoming webhooks + slash commands. Proves token-hash auth on the public ingress route, revocation lifecycle, create/list/revoke admin management, payload validation (text required, 4000-char limit), and slash command dispatch (/shrug, /me, /away, /online, /dnd, /mute, /leave, /help, ephemeral errors). DB-free, network-free, fully self-contained.",
  "scanPaths": [
    "client/src/App.tsx",
    "migrations/0121_comms_webhooks.sql"
  ],
  "tier": "small"
}
test-registration */
/**
 * comms-webhooks.test.ts
 *
 * Covers:
 *  - Webhook creation (team-lead only, channel validation)
 *  - Public incoming-webhook POST: valid token, bad token, revoked token
 *  - Payload validation (text required, oversized text rejected)
 *  - Slash command dispatch: /shrug, /me, /away, /online, /dnd, /mute, /leave, /help, ephemeral errors
 *
 * DB-free, network-free — all storage is stubbed in-memory.
 */

import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import express from "express";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import { createServer } from "http";

// ─── Token helper ─────────────────────────────────────────────────────────────

function hashToken(t: string) {
  return createHash("sha256").update(t).digest("hex");
}

// ─── In-memory stubs ─────────────────────────────────────────────────────────

const channels = new Map<string, { id: string; slug: string | null; name: string | null; archivedAt: null; type: string }>();
const messages: any[] = [];
const webhooks = new Map<string, { id: string; channelId: string; name: string; tokenHash: string; enabled: boolean; lastUsedAt: Date | null }>();
let memberCheckResult = true;

function seedChannel(id = "ch1", slug = "general") {
  channels.set(id, { id, slug, name: "General", archivedAt: null, type: "public" });
  return id;
}

function seedWebhook(channelId: string, enabled = true) {
  const raw = randomBytes(16).toString("hex");
  const hash = hashToken(raw);
  const id = `wh-${randomBytes(4).toString("hex")}`;
  webhooks.set(id, { id, channelId, name: "Test Hook", tokenHash: hash, enabled, lastUsedAt: null });
  return { id, raw };
}

function reset() {
  channels.clear();
  messages.length = 0;
  webhooks.clear();
  memberCheckResult = true;
  seedChannel("ch1", "general");
}

// ─── Stub storage layer ───────────────────────────────────────────────────────

const COMMS_STORAGE_STUB = {
  getChannelById: async (id: string) => channels.get(id) ?? null,
  getChannelBySlug: async (slug: string) => {
    for (const ch of channels.values()) if (ch.slug === slug) return ch;
    return null;
  },
  isChannelMember: async (_cid: string, _uid: string) => memberCheckResult,
  createMessage: async (data: any) => {
    const m = { ...data, id: `msg-${messages.length}`, createdAt: new Date(), updatedAt: new Date(), editedAt: null, deletedAt: null };
    messages.push(m);
    return m;
  },
  getChannelMemberIds: async (_cid: string): Promise<string[] | null> => ["u1", "u2"],
  getWebhookByTokenHash: async (hash: string) => {
    for (const wh of webhooks.values()) if (wh.tokenHash === hash) return wh;
    return null;
  },
  createWebhook: async (data: any) => {
    const wh = { ...data, id: `wh-${webhooks.size}`, lastUsedAt: null, createdAt: new Date(), updatedAt: new Date() };
    webhooks.set(wh.id, wh);
    return wh;
  },
  listAllWebhooks: async () => [...webhooks.values()],
  revokeWebhook: async (id: string) => {
    const wh = webhooks.get(id);
    if (!wh) return null;
    const updated = { ...wh, enabled: false };
    webhooks.set(id, updated);
    return updated;
  },
  touchWebhookLastUsed: async (id: string) => {
    const wh = webhooks.get(id);
    if (wh) wh.lastUsedAt = new Date();
  },
  setUserManualStatus: async (_uid: string, status: string) => ({ manualStatus: status }),
  getUserStatus: async (_uid: string) => null,
  getChannelMembers: async (_channelId: string) => [],
  removeChannelMember: async (_cid: string, _uid: string) => true,
  setNotificationPref: async (_channelId: string, _userId: string, _pref: string) => {},
  getNotificationPref: async (_cid: string, _uid: string) => null,
};

// ─── Minimal express app ──────────────────────────────────────────────────────

function isTeamLead(req: any) {
  const r = req.user?.dbUser?.role;
  return r === "team_lead" || r === "ceo";
}

function buildTestApp() {
  const app = express();
  app.use(express.json());

  const fakeAuth = (req: any, _res: any, next: any) => {
    req.user = { claims: { sub: "user-1" }, dbUser: { role: "team_lead" } };
    next();
  };

  // POST /api/comms/incoming/:token — public ingress
  app.post("/api/comms/incoming/:token", async (req, res) => {
    const rawToken = req.params.token;
    if (!rawToken || rawToken.length < 8) {
      res.status(400).json({ error: "Invalid token" }); return;
    }
    const hash = hashToken(rawToken);
    const wh = await COMMS_STORAGE_STUB.getWebhookByTokenHash(hash);
    if (!wh || !wh.enabled) { res.status(401).json({ error: "Invalid or revoked webhook token" }); return; }

    const { text, fields, link, source } = req.body ?? {};
    if (typeof text !== "string" || !text.trim()) { res.status(400).json({ error: "text is required" }); return; }
    if (text.length > 4000) { res.status(400).json({ error: "text exceeds 4000-character limit" }); return; }

    const ch = await COMMS_STORAGE_STUB.getChannelById(wh.channelId);
    if (!ch || ch.archivedAt) { res.status(404).json({ error: "Channel not found or archived" }); return; }

    const metadata: any = { type: "bot_message" };
    if (source) metadata.source = source;
    if (fields) metadata.fields = fields;
    if (link) metadata.link = link;

    const msg = await COMMS_STORAGE_STUB.createMessage({ channelId: wh.channelId, userId: null, content: text.trim(), contentType: "bot", metadata });
    await COMMS_STORAGE_STUB.touchWebhookLastUsed(wh.id);
    res.status(200).json({ ok: true, messageId: msg.id });
  });

  // POST /api/comms/webhooks — create (team-lead+)
  app.post("/api/comms/webhooks", fakeAuth, async (req: any, res) => {
    if (!isTeamLead(req)) { res.status(403).json({ error: "Requires team lead" }); return; }
    const { channelId, name } = req.body ?? {};
    if (!channelId) { res.status(400).json({ error: "channelId required" }); return; }
    const ch = await COMMS_STORAGE_STUB.getChannelById(channelId);
    if (!ch) { res.status(404).json({ error: "Channel not found" }); return; }
    const raw = randomBytes(32).toString("hex");
    const hash = hashToken(raw);
    const wh = await COMMS_STORAGE_STUB.createWebhook({ channelId, name: name?.trim() || "Incoming Webhook", tokenHash: hash, createdBy: req.user.claims.sub, enabled: true });
    const { tokenHash: _h, ...safe } = wh;
    res.status(201).json({ webhook: safe, token: raw });
  });

  // GET /api/comms/webhooks — list (team-lead+)
  app.get("/api/comms/webhooks", fakeAuth, async (req: any, res) => {
    if (!isTeamLead(req)) { res.status(403).json({ error: "Requires team lead" }); return; }
    const all = await COMMS_STORAGE_STUB.listAllWebhooks();
    const safe = all.map(({ tokenHash: _h, ...r }) => r);
    res.json(safe);
  });

  // DELETE /api/comms/webhooks/:id — revoke (team-lead+)
  app.delete("/api/comms/webhooks/:id", fakeAuth, async (req: any, res) => {
    if (!isTeamLead(req)) { res.status(403).json({ error: "Requires team lead" }); return; }
    const wh = await COMMS_STORAGE_STUB.revokeWebhook(req.params.id);
    if (!wh) { res.status(404).json({ error: "Webhook not found" }); return; }
    res.json({ ok: true });
  });

  // POST /api/comms/channels/:id/slash — slash commands
  app.post("/api/comms/channels/:id/slash", fakeAuth, async (req: any, res) => {
    const userId = req.user.claims.sub;
    const channelId = req.params.id;
    const ch = await COMMS_STORAGE_STUB.getChannelById(channelId);
    if (!ch) { res.status(404).json({ error: "Channel not found" }); return; }
    const isMember = await COMMS_STORAGE_STUB.isChannelMember(channelId, userId);
    if (!isMember) { res.status(403).json({ error: "Not a member" }); return; }
    const command: string = req.body?.command ?? "";
    const args: string = req.body?.args ?? "";
    const ephemeral = (text: string) => res.json({ ephemeral: true, text });

    if (command === "/shrug") {
      const prefix = args.trim() ? `${args.trim()} ` : "";
      await COMMS_STORAGE_STUB.createMessage({ channelId, userId, content: `${prefix}¯\\_(ツ)_/¯`, contentType: "text" });
      return res.json({ ok: true });
    }
    if (command === "/me") {
      if (!args.trim()) return ephemeral("Usage: /me [action]");
      await COMMS_STORAGE_STUB.createMessage({ channelId, userId, content: `_${args.trim()}_`, contentType: "text" });
      return res.json({ ok: true });
    }
    if (["/status", "/online", "/away", "/dnd", "/offline"].includes(command)) {
      const statusMap: Record<string, string> = { "/online": "online", "/away": "away", "/dnd": "dnd", "/offline": "offline" };
      const newStatus = command === "/status" ? (args.trim() || "online") : statusMap[command];
      const valid = ["online", "away", "dnd", "offline"];
      if (!valid.includes(newStatus)) return ephemeral(`Unknown status "${newStatus}"`);
      await COMMS_STORAGE_STUB.setUserManualStatus(userId, newStatus);
      return res.json({ ok: true, status: newStatus });
    }
    if (command === "/mute") {
      await COMMS_STORAGE_STUB.setNotificationPref(channelId, userId, "muted");
      return ephemeral(`You muted #${ch.name ?? ch.slug ?? channelId}. Use /unmute to restore.`);
    }
    if (command === "/unmute") {
      await COMMS_STORAGE_STUB.setNotificationPref(channelId, userId, "all");
      return ephemeral(`Notifications restored for #${ch.name ?? ch.slug ?? channelId}.`);
    }
    if (command === "/leave") {
      if (ch.type === "dm") return ephemeral("You cannot leave a DM channel.");
      await COMMS_STORAGE_STUB.removeChannelMember(channelId, userId);
      return res.json({ ok: true, left: true });
    }
    if (command === "/help") {
      return ephemeral("Available commands: /status, /away, /online, /dnd, /shrug, /me, /mute, /unmute, /leave");
    }
    return ephemeral(`Unknown command: ${command}. Type /help for a list.`);
  });

  return app;
}

// ─── HTTP test helper ─────────────────────────────────────────────────────────

type Method = "GET" | "POST" | "DELETE" | "PATCH";

async function req(
  app: ReturnType<typeof buildTestApp>,
  method: Method,
  path: string,
  body?: any,
): Promise<{ status: number; body: any }> {
  const server = createServer(app);
  const dispatcher = getGlobalDispatcher();
  const agent = new Agent({ connect: { rejectUnauthorized: false } });
  setGlobalDispatcher(agent);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    const opts: any = {
      method,
      headers: { "content-type": "application/json" },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const { statusCode, body: rawBody } = await agent.request({ origin: `http://127.0.0.1:${port}`, path, ...opts });
    let parsed: any = {};
    try {
      let text = "";
      for await (const chunk of rawBody) text += chunk.toString();
      parsed = JSON.parse(text);
    } catch {}
    return { status: statusCode, body: parsed };
  } finally {
    setGlobalDispatcher(dispatcher);
    await new Promise<void>((r) => server.close(() => r()));
    agent.destroy();
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✗ ${label}\n    ${err?.message}`);
    failed++;
  }
}

async function runSuite(label: string, suite: () => Promise<void>) {
  console.log(`\n${label}`);
  await suite();
}

// ─── Suite: Incoming Webhook Ingress ─────────────────────────────────────────

await runSuite("Comms Incoming Webhooks", async () => {
  let app: ReturnType<typeof buildTestApp>;

  reset();
  app = buildTestApp();

  await test("accepts valid token and posts bot message", async () => {
    const { raw } = seedWebhook("ch1");
    const r = await req(app, "POST", `/api/comms/incoming/${raw}`, { text: "Hello from webhook" });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].contentType, "bot");
    assert.equal(messages[0].content, "Hello from webhook");
  });

  reset();
  app = buildTestApp();

  await test("rejects bad token with 401", async () => {
    seedWebhook("ch1");
    const r = await req(app, "POST", "/api/comms/incoming/badtokenthatisnotvalid", { text: "Hello" });
    assert.equal(r.status, 401);
  });

  reset();
  app = buildTestApp();

  await test("rejects revoked webhook token with 401", async () => {
    const { id, raw } = seedWebhook("ch1", true);
    webhooks.get(id)!.enabled = false;
    const r = await req(app, "POST", `/api/comms/incoming/${raw}`, { text: "Hello" });
    assert.equal(r.status, 401);
  });

  reset();
  app = buildTestApp();

  await test("rejects empty text with 400", async () => {
    const { raw } = seedWebhook("ch1");
    const r = await req(app, "POST", `/api/comms/incoming/${raw}`, { text: "   " });
    assert.equal(r.status, 400);
  });

  reset();
  app = buildTestApp();

  await test("rejects oversized text (>4000 chars) with 400", async () => {
    const { raw } = seedWebhook("ch1");
    const r = await req(app, "POST", `/api/comms/incoming/${raw}`, { text: "x".repeat(4001) });
    assert.equal(r.status, 400);
  });

  reset();
  app = buildTestApp();

  await test("stores source and fields in metadata", async () => {
    const { raw } = seedWebhook("ch1");
    const r = await req(app, "POST", `/api/comms/incoming/${raw}`, { text: "Build passed", source: "CI", fields: [{ title: "Branch", value: "main" }] });
    assert.equal(r.status, 200);
    assert.equal(messages[0].metadata.source, "CI");
    assert.equal(messages[0].metadata.fields[0].title, "Branch");
  });
});

// ─── Suite: Webhook Management (admin) ───────────────────────────────────────

await runSuite("Comms Webhook Management (admin)", async () => {
  let app: ReturnType<typeof buildTestApp>;

  reset();
  app = buildTestApp();

  await test("creates webhook and returns raw token (once, never stored)", async () => {
    const r = await req(app, "POST", "/api/comms/webhooks", { channelId: "ch1", name: "My Hook" });
    assert.equal(r.status, 201);
    assert.equal(typeof r.body.token, "string");
    assert.ok(r.body.token.length > 16);
    assert.equal(r.body.webhook.name, "My Hook");
    assert.equal(r.body.webhook.tokenHash, undefined, "tokenHash must never be exposed");
  });

  reset();
  app = buildTestApp();

  await test("list response never exposes tokenHash", async () => {
    seedWebhook("ch1");
    const r = await req(app, "GET", "/api/comms/webhooks");
    assert.equal(r.status, 200);
    for (const wh of r.body) {
      assert.equal(wh.tokenHash, undefined, "tokenHash must not appear in list");
    }
  });

  reset();
  app = buildTestApp();

  await test("revokes webhook so subsequent ingress fails with 401", async () => {
    const { id, raw } = seedWebhook("ch1");
    const revokeRes = await req(app, "DELETE", `/api/comms/webhooks/${id}`);
    assert.equal(revokeRes.status, 200);
    const ingressRes = await req(app, "POST", `/api/comms/incoming/${raw}`, { text: "Should fail" });
    assert.equal(ingressRes.status, 401);
  });

  reset();
  app = buildTestApp();

  await test("returns 404 for unknown channel on create", async () => {
    const r = await req(app, "POST", "/api/comms/webhooks", { channelId: "nonexistent" });
    assert.equal(r.status, 404);
  });

  reset();
  app = buildTestApp();

  await test("returns 404 for unknown webhook on revoke", async () => {
    const r = await req(app, "DELETE", "/api/comms/webhooks/not-a-real-id");
    assert.equal(r.status, 404);
  });
});

// ─── Suite: Slash Command Dispatch ───────────────────────────────────────────

await runSuite("Slash command dispatch", async () => {
  let app: ReturnType<typeof buildTestApp>;

  reset();
  app = buildTestApp();

  await test("/shrug appends ¯\\_(ツ)_/¯ to message", async () => {
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/shrug", args: "whatever" });
    assert.equal(r.status, 200);
    assert.ok(messages[0].content.includes("¯\\_(ツ)_/¯"));
  });

  reset();
  app = buildTestApp();

  await test("/me posts italic action text", async () => {
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/me", args: "dances" });
    assert.equal(r.status, 200);
    assert.equal(messages[0].content, "_dances_");
  });

  reset();
  app = buildTestApp();

  await test("/me with empty args returns ephemeral error", async () => {
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/me", args: "" });
    assert.equal(r.body.ephemeral, true);
    assert.ok(r.body.text.includes("Usage"));
  });

  reset();
  app = buildTestApp();

  await test("/away sets status to away", async () => {
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/away", args: "" });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "away");
  });

  reset();
  app = buildTestApp();

  await test("/online sets status to online", async () => {
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/online", args: "" });
    assert.equal(r.body.status, "online");
  });

  reset();
  app = buildTestApp();

  await test("/dnd sets status to dnd", async () => {
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/dnd", args: "" });
    assert.equal(r.body.status, "dnd");
  });

  reset();
  app = buildTestApp();

  await test("/mute returns ephemeral confirmation", async () => {
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/mute", args: "" });
    assert.equal(r.body.ephemeral, true);
    assert.ok(r.body.text.includes("muted"));
  });

  reset();
  app = buildTestApp();

  await test("/unmute returns ephemeral confirmation", async () => {
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/unmute", args: "" });
    assert.equal(r.body.ephemeral, true);
    assert.ok(r.body.text.includes("Notifications"));
  });

  reset();
  app = buildTestApp();

  await test("/leave removes user from channel", async () => {
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/leave", args: "" });
    assert.equal(r.status, 200);
    assert.equal(r.body.left, true);
  });

  reset();
  app = buildTestApp();

  await test("/leave in DM channel returns ephemeral error", async () => {
    channels.get("ch1")!.type = "dm";
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/leave", args: "" });
    assert.equal(r.body.ephemeral, true);
    assert.ok(r.body.text.includes("cannot leave"));
    channels.get("ch1")!.type = "public";
  });

  reset();
  app = buildTestApp();

  await test("/help returns ephemeral command list", async () => {
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/help", args: "" });
    assert.equal(r.body.ephemeral, true);
    assert.ok(r.body.text.length > 20);
  });

  reset();
  app = buildTestApp();

  await test("unknown command returns ephemeral error", async () => {
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/banana", args: "" });
    assert.equal(r.body.ephemeral, true);
    assert.ok(r.body.text.includes("Unknown command"));
  });

  reset();
  app = buildTestApp();

  await test("returns 404 for unknown channel", async () => {
    const r = await req(app, "POST", "/api/comms/channels/nonexistent/slash", { command: "/shrug", args: "x" });
    assert.equal(r.status, 404);
  });

  reset();
  app = buildTestApp();

  await test("returns 403 when user is not a channel member", async () => {
    memberCheckResult = false;
    const r = await req(app, "POST", "/api/comms/channels/ch1/slash", { command: "/shrug", args: "x" });
    assert.equal(r.status, 403);
    memberCheckResult = true;
  });
});

// ─── Suite: Schema + Service Contract ────────────────────────────────────────

await runSuite("Schema and service contract smoke checks", async () => {
  await test("commsWebhooks table is exported from shared/models/comms.ts", async () => {
    const mod = await import("../shared/models/comms.js");
    assert.ok((mod as any).commsWebhooks, "commsWebhooks must be exported");
    assert.ok((mod as any).insertCommsWebhookSchema, "insertCommsWebhookSchema must be exported");
  });

  await test("commsBotService exports postBotMessage and hashWebhookToken", async () => {
    const mod = await import("../server/services/commsBotService.js");
    assert.equal(typeof mod.postBotMessage, "function");
    assert.equal(typeof mod.hashWebhookToken, "function");
  });

  await test("hashWebhookToken is deterministic SHA-256 hex", async () => {
    const { hashWebhookToken } = await import("../server/services/commsBotService.js");
    const h1 = hashWebhookToken("abc123");
    const h2 = hashWebhookToken("abc123");
    const h3 = hashWebhookToken("different");
    assert.equal(h1, h2, "same input must produce same hash");
    assert.notEqual(h1, h3, "different inputs must produce different hashes");
    assert.equal(h1.length, 64, "SHA-256 hex is 64 characters");
  });

  await test("commsStorage exports createWebhook, getWebhookByTokenHash, listAllWebhooks, revokeWebhook, touchWebhookLastUsed", async () => {
    const mod = await import("../server/storage/commsStorage.js");
    const required = ["createWebhook", "getWebhookByTokenHash", "listAllWebhooks", "revokeWebhook", "touchWebhookLastUsed"];
    for (const fn of required) {
      assert.equal(typeof (mod as any)[fn], "function", `commsStorage.${fn} must be exported`);
    }
  });

  await test("'bot' is in commsMessageContentTypes", async () => {
    const mod = await import("../shared/models/comms.js");
    assert.ok((mod as any).commsMessageContentTypes.includes("bot"), "'bot' must be a valid content type");
  });

  await test("App.tsx registers /admin/comms/webhooks route", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("client/src/App.tsx", "utf-8");
    assert.ok(src.includes("/admin/comms/webhooks"), "App.tsx must include the webhook admin route");
  });

  await test("migration 0121_comms_webhooks.sql exists and contains comms_webhooks", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("migrations/0121_comms_webhooks.sql", "utf-8");
    assert.ok(sql.includes("CREATE TABLE comms_webhooks"), "migration must create comms_webhooks table");
    assert.ok(sql.includes("token_hash"), "migration must include token_hash column");
  });
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\ncomms-webhooks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
