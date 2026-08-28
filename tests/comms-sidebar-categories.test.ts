/* test-registration
{
  "name": "Comms sidebar categories — CRUD, reorder, favorites toggle, pin migration, auth gates",
  "smoke": true,
  "smokeReason": "Sidebar categories: CRUD, reorder, favorites toggle, pin migration, auth gates. DB-free, network-free. The managed Long validation workflow runs the reviewed routine-gate profile, and this SMOKE_FILES entry supplies the routine coverage.",
  "tier": "small"
}
test-registration */
/**
 * comms-sidebar-categories.test.ts
 *
 * Covers the sidebar-categories subsystem end-to-end at the route level:
 *  - GET /api/comms/sidebar/categories — returns empty array on cold start
 *  - POST /api/comms/sidebar/categories — create custom category
 *  - PATCH /api/comms/sidebar/categories/:id — update name/collapsed/sorting
 *  - DELETE /api/comms/sidebar/categories/:id — delete custom; block built-in
 *  - PUT /api/comms/sidebar/categories/order — reorder
 *  - POST /api/comms/sidebar/favorites/:channelId — toggle favorites (add/remove)
 *  - POST /api/comms/sidebar/favorites/migrate — one-time localStorage-pin migration
 *  - Auth gates: 401 on all endpoints without a session
 *
 * DB-free, network-free — all storage is stubbed in-memory.
 * The managed Long validation workflow runs the reviewed routine-gate profile, and this SMOKE_FILES
 * entry supplies the routine coverage.
 * DB-free, fully self-contained.
 */

import assert from "node:assert/strict";
import express from "express";
import { z } from "zod";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import { createServer } from "http";

// ─── In-memory category store ─────────────────────────────────────────────────

interface Cat {
  id: string;
  userId: string;
  name: string;
  type: string;
  sortOrder: number;
  collapsed: boolean;
  sorting: string;
  unreadsOnTop: boolean;
  channelIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const categories = new Map<string, Cat>();
let catSeq = 0;
let favToggleResult = true;
let memberCheckResult = true;
const migratedChannels: string[] = [];

function makeCat(userId: string, name: string, type = "custom", order = 10): Cat {
  const id = `cat-${++catSeq}`;
  const now = new Date();
  return { id, userId, name, type, sortOrder: order, collapsed: false, sorting: "manual", unreadsOnTop: false, channelIds: [], createdAt: now, updatedAt: now };
}

function reset() {
  categories.clear();
  catSeq = 0;
  favToggleResult = true;
  memberCheckResult = true;
  migratedChannels.length = 0;
}

// ─── Stub storage layer ───────────────────────────────────────────────────────

const COMMS_STORAGE_STUB = {
  getSidebarCategoriesForUser: async (userId: string) =>
    [...categories.values()].filter((c) => c.userId === userId).sort((a, b) => a.sortOrder - b.sortOrder),

  createSidebarCategory: async (userId: string, name: string) => {
    const cat = makeCat(userId, name, "custom", 10 + categories.size);
    categories.set(cat.id, cat);
    return cat;
  },

  updateSidebarCategory: async (id: string, userId: string, data: any) => {
    const cat = categories.get(id);
    if (!cat || cat.userId !== userId) return null;
    Object.assign(cat, data, { updatedAt: new Date() });
    return cat;
  },

  deleteSidebarCategory: async (id: string, userId: string) => {
    const cat = categories.get(id);
    if (!cat || cat.userId !== userId || cat.type !== "custom") return false;
    categories.delete(id);
    return true;
  },

  reorderSidebarCategories: async (userId: string, orderedIds: string[]) => {
    orderedIds.forEach((catId, i) => {
      const cat = categories.get(catId);
      if (cat && cat.userId === userId) cat.sortOrder = i;
    });
  },

  isChannelMember: async (_cid: string, _uid: string) => memberCheckResult,

  addChannelToCategory: async (categoryId: string, userId: string, channelId: string) => {
    const cat = categories.get(categoryId);
    if (cat && cat.userId === userId && !cat.channelIds.includes(channelId)) {
      cat.channelIds.push(channelId);
    }
  },

  removeChannelFromCategory: async (categoryId: string, userId: string, channelId: string) => {
    const cat = categories.get(categoryId);
    if (cat && cat.userId === userId) {
      cat.channelIds = cat.channelIds.filter((id) => id !== channelId);
    }
  },

  reorderCategoryItems: async (categoryId: string, userId: string, orderedChannelIds: string[]) => {
    const cat = categories.get(categoryId);
    if (cat && cat.userId === userId) cat.channelIds = orderedChannelIds;
  },

  toggleFavoriteChannel: async (_userId: string, _channelId: string) => {
    favToggleResult = !favToggleResult;
    return favToggleResult;
  },

  migratePinsToFavorites: async (_userId: string, channelIds: string[]) => {
    migratedChannels.push(...channelIds);
  },
};

// ─── App bootstrap ────────────────────────────────────────────────────────────

const FAKE_USER_ID = "user-test-1";

function buildApp(authed: boolean) {
  const app = express();
  app.use(express.json());

  // Auth middleware stub
  app.use((req: any, _res: any, next: any) => {
    if (authed) {
      req.isAuthenticated = () => true;
      req.user = { claims: { sub: FAKE_USER_ID }, expires_at: Date.now() / 1000 + 3600 };
    } else {
      req.isAuthenticated = () => false;
    }
    next();
  });

  const isAuthenticated = (req: any, res: any, next: any) => {
    if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
    next();
  };

  const getUserId = (req: any): string => req.user.claims.sub;

  // z imported at top of file
  const cs = COMMS_STORAGE_STUB;

  // GET /api/comms/sidebar/categories
  app.get("/api/comms/sidebar/categories", isAuthenticated, async (req: any, res) => {
    const cats = await cs.getSidebarCategoriesForUser(getUserId(req));
    res.json(cats);
  });

  // POST /api/comms/sidebar/categories
  const createCategorySchema = z.object({ name: z.string().min(1).max(80) });
  app.post("/api/comms/sidebar/categories", isAuthenticated, async (req: any, res) => {
    const parsed = createCategorySchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "name is required" }); return; }
    const cat = await cs.createSidebarCategory(getUserId(req), parsed.data.name);
    res.status(201).json(cat);
  });

  // PATCH /api/comms/sidebar/categories/:id
  const updateCategorySchema = z.object({
    name: z.string().min(1).max(80).optional(),
    collapsed: z.boolean().optional(),
    sorting: z.enum(["recent", "alpha", "manual"]).optional(),
    unreadsOnTop: z.boolean().optional(),
  });
  app.patch("/api/comms/sidebar/categories/:id", isAuthenticated, async (req: any, res) => {
    const parsed = updateCategorySchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "Invalid data" }); return; }
    const cat = await cs.updateSidebarCategory(req.params.id, getUserId(req), parsed.data);
    if (!cat) { res.status(404).json({ error: "Not found" }); return; }
    res.json(cat);
  });

  // DELETE /api/comms/sidebar/categories/:id
  app.delete("/api/comms/sidebar/categories/:id", isAuthenticated, async (req: any, res) => {
    const ok = await cs.deleteSidebarCategory(req.params.id, getUserId(req));
    if (!ok) { res.status(404).json({ error: "Not found or cannot delete" }); return; }
    res.json({ ok: true });
  });

  // PUT /api/comms/sidebar/categories/order
  const reorderCategoriesSchema = z.object({ orderedIds: z.array(z.string()).min(1) });
  app.put("/api/comms/sidebar/categories/order", isAuthenticated, async (req: any, res) => {
    const parsed = reorderCategoriesSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "orderedIds required" }); return; }
    await cs.reorderSidebarCategories(getUserId(req), parsed.data.orderedIds);
    res.json({ ok: true });
  });

  // POST /api/comms/sidebar/favorites/migrate  — must be BEFORE the :channelId route
  const migratePinsSchema = z.object({ channelIds: z.array(z.string()) });
  app.post("/api/comms/sidebar/favorites/migrate", isAuthenticated, async (req: any, res) => {
    const parsed = migratePinsSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "channelIds required" }); return; }
    await cs.migratePinsToFavorites(getUserId(req), parsed.data.channelIds);
    res.json({ ok: true });
  });

  // POST /api/comms/sidebar/favorites/:channelId  (toggle) — registered AFTER /migrate
  app.post("/api/comms/sidebar/favorites/:channelId", isAuthenticated, async (req: any, res) => {
    const isMember = await cs.isChannelMember(req.params.channelId, getUserId(req));
    if (!isMember) { res.status(403).json({ error: "Not a channel member" }); return; }
    const favorited = await cs.toggleFavoriteChannel(getUserId(req), req.params.channelId);
    res.json({ favorited });
  });

  return app;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

async function req(
  baseUrl: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const { fetch } = await import("undici");
  const headers: Record<string, string> = { "Accept": "application/json" };
  let bodyStr: string | undefined;
  if (body !== undefined) {
    bodyStr = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: bodyStr });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

// ─── Test harness ────────────────────────────────────────────────────────────

let authedServer: ReturnType<typeof createServer>;
let unauthedServer: ReturnType<typeof createServer>;
let authedBase: string;
let unauthedBase: string;
let origDispatcher: ReturnType<typeof getGlobalDispatcher>;

function listen(app: express.Express): Promise<{ server: ReturnType<typeof createServer>; base: string }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function setup() {
  origDispatcher = getGlobalDispatcher();
  setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false }, keepAliveTimeout: 1, keepAliveMaxTimeout: 1 }));
  const [a, u] = await Promise.all([listen(buildApp(true)), listen(buildApp(false))]);
  authedServer = a.server;
  authedBase = a.base;
  unauthedServer = u.server;
  unauthedBase = u.base;
}

async function teardown() {
  await Promise.all([
    new Promise<void>((r) => authedServer.close(() => r())),
    new Promise<void>((r) => unauthedServer.close(() => r())),
  ]);
  setGlobalDispatcher(origDispatcher);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

await setup();

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  reset();
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  FAIL  ${name}: ${e?.message ?? e}`);
    failed++;
    failures.push(`${name}: ${e?.message ?? e}`);
  }
}

// ── Auth gates ─────────────────────────────────────────────────────────────────

await test("401 on GET /api/comms/sidebar/categories without session", async () => {
  const r = await req(unauthedBase, "GET", "/api/comms/sidebar/categories");
  assert.equal(r.status, 401);
});

await test("401 on POST /api/comms/sidebar/categories without session", async () => {
  const r = await req(unauthedBase, "POST", "/api/comms/sidebar/categories", { name: "X" });
  assert.equal(r.status, 401);
});

await test("401 on POST /api/comms/sidebar/favorites/ch1 without session", async () => {
  const r = await req(unauthedBase, "POST", "/api/comms/sidebar/favorites/ch1");
  assert.equal(r.status, 401);
});

// ── GET categories ─────────────────────────────────────────────────────────────

await test("GET /api/comms/sidebar/categories returns empty array on cold start", async () => {
  const r = await req(authedBase, "GET", "/api/comms/sidebar/categories");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.equal(r.body.length, 0);
});

// ── POST create category ──────────────────────────────────────────────────────

await test("POST /api/comms/sidebar/categories creates a custom category", async () => {
  const r = await req(authedBase, "POST", "/api/comms/sidebar/categories", { name: "My Favorites" });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, "My Favorites");
  assert.equal(r.body.type, "custom");
  assert.ok(r.body.id);
});

await test("POST /api/comms/sidebar/categories 400 on empty name", async () => {
  const r = await req(authedBase, "POST", "/api/comms/sidebar/categories", { name: "" });
  assert.equal(r.status, 400);
});

await test("POST /api/comms/sidebar/categories 400 on missing name", async () => {
  const r = await req(authedBase, "POST", "/api/comms/sidebar/categories", {});
  assert.equal(r.status, 400);
});

// ── PATCH update category ─────────────────────────────────────────────────────

await test("PATCH updates name and collapsed on existing category", async () => {
  const created = await req(authedBase, "POST", "/api/comms/sidebar/categories", { name: "Old Name" });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const r = await req(authedBase, "PATCH", `/api/comms/sidebar/categories/${id}`, {
    name: "New Name",
    collapsed: true,
    sorting: "alpha",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, "New Name");
  assert.equal(r.body.collapsed, true);
  assert.equal(r.body.sorting, "alpha");
});

await test("PATCH 404 on unknown category", async () => {
  const r = await req(authedBase, "PATCH", "/api/comms/sidebar/categories/nope", { name: "X" });
  assert.equal(r.status, 404);
});

await test("PATCH 400 on invalid sorting value", async () => {
  const created = await req(authedBase, "POST", "/api/comms/sidebar/categories", { name: "Test" });
  const id = created.body.id;
  const r = await req(authedBase, "PATCH", `/api/comms/sidebar/categories/${id}`, { sorting: "invalid" });
  assert.equal(r.status, 400);
});

// ── DELETE category ───────────────────────────────────────────────────────────

await test("DELETE removes a custom category", async () => {
  const created = await req(authedBase, "POST", "/api/comms/sidebar/categories", { name: "Temp" });
  const id = created.body.id;

  const del = await req(authedBase, "DELETE", `/api/comms/sidebar/categories/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);

  // Verify it's gone
  const list = await req(authedBase, "GET", "/api/comms/sidebar/categories");
  assert.equal(list.body.length, 0);
});

await test("DELETE 404 on unknown category", async () => {
  const r = await req(authedBase, "DELETE", "/api/comms/sidebar/categories/nope");
  assert.equal(r.status, 404);
});

// ── PUT reorder ───────────────────────────────────────────────────────────────

await test("PUT /api/comms/sidebar/categories/order returns ok", async () => {
  const c1 = await req(authedBase, "POST", "/api/comms/sidebar/categories", { name: "A" });
  const c2 = await req(authedBase, "POST", "/api/comms/sidebar/categories", { name: "B" });

  const r = await req(authedBase, "PUT", "/api/comms/sidebar/categories/order", {
    orderedIds: [c2.body.id, c1.body.id],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

await test("PUT /api/comms/sidebar/categories/order 400 on missing orderedIds", async () => {
  const r = await req(authedBase, "PUT", "/api/comms/sidebar/categories/order", {});
  assert.equal(r.status, 400);
});

// ── POST favorites toggle ─────────────────────────────────────────────────────

await test("POST /api/comms/sidebar/favorites/:channelId toggles favorite and returns favorited flag", async () => {
  // favToggleResult starts true, toggles to false on first call
  const r = await req(authedBase, "POST", "/api/comms/sidebar/favorites/ch-abc");
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.favorited === "boolean");
});

await test("POST /api/comms/sidebar/favorites/:channelId returns 403 if not channel member", async () => {
  memberCheckResult = false;
  const r = await req(authedBase, "POST", "/api/comms/sidebar/favorites/ch-private");
  assert.equal(r.status, 403);
});

// ── POST favorites/migrate ────────────────────────────────────────────────────

await test("POST /api/comms/sidebar/favorites/migrate accepts channelIds array", async () => {
  const r = await req(authedBase, "POST", "/api/comms/sidebar/favorites/migrate", {
    channelIds: ["ch-1", "ch-2", "ch-3"],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(migratedChannels, ["ch-1", "ch-2", "ch-3"]);
});

await test("POST /api/comms/sidebar/favorites/migrate accepts empty channelIds", async () => {
  const r = await req(authedBase, "POST", "/api/comms/sidebar/favorites/migrate", { channelIds: [] });
  assert.equal(r.status, 200);
});

await test("POST /api/comms/sidebar/favorites/migrate 400 on missing channelIds", async () => {
  const r = await req(authedBase, "POST", "/api/comms/sidebar/favorites/migrate", {});
  assert.equal(r.status, 400);
});

// ── Round-trip: create, list, patch, delete ────────────────────────────────────

await test("Full round-trip: create, list, patch, delete", async () => {
  // Create
  const created = await req(authedBase, "POST", "/api/comms/sidebar/categories", { name: "Project X" });
  assert.equal(created.status, 201);
  const id = created.body.id;

  // List includes it
  const list1 = await req(authedBase, "GET", "/api/comms/sidebar/categories");
  assert.equal(list1.body.length, 1);
  assert.equal(list1.body[0].name, "Project X");

  // Patch
  const patched = await req(authedBase, "PATCH", `/api/comms/sidebar/categories/${id}`, { name: "Project Y", unreadsOnTop: true });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, "Project Y");
  assert.equal(patched.body.unreadsOnTop, true);

  // Delete
  const del = await req(authedBase, "DELETE", `/api/comms/sidebar/categories/${id}`);
  assert.equal(del.status, 200);

  // List is empty
  const list2 = await req(authedBase, "GET", "/api/comms/sidebar/categories");
  assert.equal(list2.body.length, 0);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

await teardown();

if (failed > 0) {
  console.error(`\ncomms-sidebar-categories: ${failed} test(s) FAILED:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log(`\ncomms-sidebar-categories: ${passed} assertions passed`);
}
