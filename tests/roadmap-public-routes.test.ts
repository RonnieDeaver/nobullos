/* test-registration
{
  "name": "Company roadmap — public payload hygiene (published-only, public fields only), slug/board filters, quarter-board validation, server-owned completedAt stamping, reorder, publish toggle, value-set guards, RBAC 401/403, embed-scoped CSP frame-ancestors relaxation, rate limit (Tasks #3728/#4215)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Tasks #3728/#4215: Company roadmap public surface — the ONE unauthenticated roadmap read (public JSON) plus the deliberately iframe-able embed route. Guards the leak class (draft initiatives / internal notes on the open internet), the exact public field set (now including board/releaseQuarter/completedAt with timeframe DERIVED from the quarter), server-owned completion stamps (client writes rejected), the boards= embed filter, and the CSP scope (frame-ancestors * ONLY on the embed surface, never the authenticated app). Injected session, per-run suffixed rows, cascade cleanup, no external network; small and fast.",
  "tier": "small"
}
test-registration */
/**
 * Task #3728 — Company roadmap: public payload hygiene + embed CSP relaxation.
 *
 * The public roadmap JSON is the ONE unauthenticated read surface of the
 * roadmap module, and the embed route is deliberately iframe-able by
 * arbitrary third-party sites. The two invariants that must never drift:
 *
 *   1. PAYLOAD HYGIENE — /api/public/roadmap returns ONLY published rows and
 *      ONLY public-facing fields. A leak here exposes internal notes / draft
 *      initiatives on the open internet (and inside every pasted embed).
 *   2. CSP SCOPE — frame-ancestors is relaxed to * ONLY for the embed
 *      surface (/roadmap/embed + /api/public/roadmap); every other path keeps
 *      the strict self+replit policy. Relaxing globally would let any site
 *      iframe the authenticated app (clickjacking).
 *
 * Also pinned: slug filters (departments/types/statuses/boards, unknown slug
 * ⇒ empty board, garbage status/board ⇒ ignored), publish/unpublish
 * visibility, reorder → public order, value-set slug generation + collision
 * suffixing + delete-in-use 409, and the team_lead RBAC gates (401/403).
 *
 * Task #4215 (quarter kanban boards) additions: create/update take `board` +
 * `releaseQuarter` (strict schemas REJECT the legacy free-text timeframe and
 * any client-supplied completedAt); the public `timeframe` value is DERIVED
 * from the quarter label; `completedAt` is stamped only on the transition
 * INTO "shipped" (publish toggles must not re-date it) and cleared on the
 * way out; `boards=` narrows the public payload.
 *
 * DB: shared dev DB public schema (routes run on the request pool `db`), all
 * rows suffixed with a per-run token and deleted in `finally` (memory:
 * route-test-public-schema-collision). Auth: Clerk per-request test seam +
 * seeded users rows; the REAL isAuthenticated/requireTeamLead middlewares
 * run (memory: clerk-route-test-auth-seam). undici dispatcher closed at exit
 * (memory: route-test-undici-drain-hang).
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomInt } from "node:crypto";
import { getGlobalDispatcher } from "undici";

const { registerRoadmapRoutes, slugifyRoadmapName } = await import("../server/routes/roadmap");
const { db, closeDbPools } = await import("../server/db");
const { sql } = await import("drizzle-orm");
const {
  isFrameRelaxedPath,
  buildCspDirectives,
  STRICT_FRAME_ANCESTORS,
  EMBED_FRAME_ANCESTORS,
} = await import("../server/embedCsp");
const helmet = (await import("helmet")).default;

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const LEAD_ID = `test-3728-lead-${RUN}`;
const SALES_ID = `test-3728-sales-${RUN}`;
const SECRET_NOTE = `internal-secret-${RUN}`;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── App with switchable Clerk test seam (real RBAC middlewares still run) ───
let activeUserId: string | null = LEAD_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a
    // string authenticates as that user id; null models an anonymous
    // request (→ 401).
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerRoadmapRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const createdInitiativeIds: string[] = [];
const createdDeptIds: string[] = [];
const createdTypeIds: string[] = [];

async function main(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name) VALUES (${LEAD_ID}, 'team_lead', 'Lead 3728')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name) VALUES (${SALES_ID}, 'sales', 'Sales 3728')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);

  const { server, baseUrl } = await listen(buildApp());
  try {
    // ── RBAC gates ──────────────────────────────────────────────────────────
    activeUserId = null;
    let r = await call(baseUrl, "GET", "/api/roadmap/admin");
    check("unauthenticated admin read → 401", r.status === 401, `got ${r.status}`);
    r = await call(baseUrl, "POST", "/api/roadmap/initiatives", { title: "x" });
    check("unauthenticated create → 401", r.status === 401, `got ${r.status}`);

    activeUserId = SALES_ID;
    r = await call(baseUrl, "GET", "/api/roadmap/admin");
    check("sales admin read → 403", r.status === 403, `got ${r.status}`);
    r = await call(baseUrl, "DELETE", `/api/roadmap/initiatives/nope`);
    check("sales delete → 403", r.status === 403, `got ${r.status}`);

    // ── Value sets: slug generation + collision suffix ──────────────────────
    activeUserId = LEAD_ID;
    r = await call(baseUrl, "POST", "/api/roadmap/departments", {
      name: `Growth & Partnerships ${RUN}`,
    });
    check("create department → 201", r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);
    const dept = r.body;
    createdDeptIds.push(dept.id);
    check(
      "department slug is slugified",
      dept.slug === `growth-partnerships-${RUN}`,
      `got ${dept.slug}`,
    );

    r = await call(baseUrl, "POST", "/api/roadmap/types", { name: `Feature ${RUN}` });
    const typeA = r.body;
    createdTypeIds.push(typeA.id);
    r = await call(baseUrl, "POST", "/api/roadmap/types", { name: `Feature ${RUN}` });
    const typeB = r.body;
    createdTypeIds.push(typeB.id);
    check(
      "same-name type gets suffixed slug",
      typeA.slug === `feature-${RUN}` && typeB.slug === `feature-${RUN}-2`,
      `got ${typeA.slug} / ${typeB.slug}`,
    );

    check(
      "slugifyRoadmapName strips accents/symbols",
      slugifyRoadmapName("Café & Crème!!") === "cafe-creme",
      slugifyRoadmapName("Café & Crème!!"),
    );

    // ── Initiatives: create (published × 2, draft × 1 with secret note) ─────
    const mk = async (over: Record<string, unknown>) => {
      const res = await call(baseUrl, "POST", "/api/roadmap/initiatives", {
        title: `Init ${RUN}`,
        publicDescription: "public words",
        departmentId: dept.id,
        typeId: typeA.id,
        board: "product",
        status: "planned",
        published: true,
        ...over,
      });
      check(`create initiative → 201 (${JSON.stringify(over).slice(0, 40)})`, res.status === 201, `got ${res.status} ${JSON.stringify(res.body)}`);
      createdInitiativeIds.push(res.body.id);
      return res.body;
    };

    const pubPlanned = await mk({ title: `Planned pub ${RUN}`, releaseQuarter: "2026-Q3" });
    const pubShipped = await mk({
      title: `Shipped pub ${RUN}`,
      status: "shipped",
      typeId: typeB.id,
    });
    check(
      "born-shipped create stamps completedAt server-side",
      typeof pubShipped.completedAt === "string" && !Number.isNaN(Date.parse(pubShipped.completedAt)),
      JSON.stringify(pubShipped.completedAt ?? null),
    );
    const draft = await mk({
      title: `Draft ${RUN}`,
      published: false,
      internalNotes: SECRET_NOTE,
    });

    r = await call(baseUrl, "POST", "/api/roadmap/initiatives", {
      title: "bad dept",
      departmentId: "does-not-exist",
      typeId: typeA.id,
      board: "product",
    });
    check("unknown departmentId → 400 (not FK 500)", r.status === 400, `got ${r.status}`);

    // ── Public payload hygiene ──────────────────────────────────────────────
    const scoped = `?departments=${dept.slug}`;
    r = await call(baseUrl, "GET", `/api/public/roadmap${scoped}`);
    check("public read → 200", r.status === 200, `got ${r.status}`);
    const ids = (r.body.initiatives as any[]).map((i) => i.id);
    check(
      "published initiatives present",
      ids.includes(pubPlanned.id) && ids.includes(pubShipped.id),
      JSON.stringify(ids),
    );
    check("draft initiative absent", !ids.includes(draft.id), JSON.stringify(ids));

    const PUBLIC_KEYS = [
      "id",
      "title",
      "description",
      "status",
      "timeframe",
      "board",
      "releaseQuarter",
      "completedAt",
      "displayOrder",
      "departmentSlug",
      "departmentName",
      "typeSlug",
      "typeName",
    ].sort();
    const rowKeyProblems = (r.body.initiatives as any[])
      .map((i) => JSON.stringify(Object.keys(i).sort()))
      .filter((k) => k !== JSON.stringify(PUBLIC_KEYS));
    check("every public row has EXACTLY the public field set", rowKeyProblems.length === 0, rowKeyProblems[0]);
    check(
      "no internal note text anywhere in the public payload",
      !JSON.stringify(r.body).includes(SECRET_NOTE),
    );
    check(
      "payload carries value sets + canonical statuses",
      Array.isArray(r.body.departments) &&
        Array.isArray(r.body.types) &&
        JSON.stringify(r.body.statuses) === JSON.stringify(["planned", "in_progress", "shipped"]),
    );
    check(
      "payload carries canonical boards",
      JSON.stringify(r.body.boards) === JSON.stringify(["product", "company"]),
      JSON.stringify(r.body.boards),
    );
    const deptEntry = (r.body.departments as any[]).find((d) => d.slug === dept.slug);
    check(
      "value sets expose slug/name/displayOrder only",
      !!deptEntry && JSON.stringify(Object.keys(deptEntry).sort()) === JSON.stringify(["displayOrder", "name", "slug"]),
      JSON.stringify(deptEntry),
    );

    const plannedRow = (r.body.initiatives as any[]).find((i) => i.id === pubPlanned.id);
    check(
      "public timeframe is DERIVED from releaseQuarter ('2026-Q3' → 'Q3 2026')",
      plannedRow?.releaseQuarter === "2026-Q3" && plannedRow?.timeframe === "Q3 2026",
      JSON.stringify({ releaseQuarter: plannedRow?.releaseQuarter, timeframe: plannedRow?.timeframe }),
    );
    const shippedRow = (r.body.initiatives as any[]).find((i) => i.id === pubShipped.id);
    check(
      "shipped row exposes completedAt as an ISO string",
      typeof shippedRow?.completedAt === "string" && !Number.isNaN(Date.parse(shippedRow.completedAt)),
      JSON.stringify(shippedRow?.completedAt ?? null),
    );

    // ── Filters ─────────────────────────────────────────────────────────────
    r = await call(baseUrl, "GET", `/api/public/roadmap${scoped}&statuses=shipped`);
    check(
      "statuses filter narrows to shipped",
      (r.body.initiatives as any[]).map((i: any) => i.id).join() === pubShipped.id,
      JSON.stringify(r.body.initiatives.map((i: any) => i.id)),
    );
    r = await call(baseUrl, "GET", `/api/public/roadmap${scoped}&statuses=garbage`);
    check(
      "garbage status values are ignored (both rows back)",
      (r.body.initiatives as any[]).length === 2,
      `got ${r.body.initiatives.length}`,
    );
    r = await call(baseUrl, "GET", `/api/public/roadmap${scoped}&types=${typeB.slug}`);
    check(
      "types filter narrows to the typeB row",
      (r.body.initiatives as any[]).map((i: any) => i.id).join() === pubShipped.id,
      JSON.stringify(r.body.initiatives.map((i: any) => i.id)),
    );
    r = await call(baseUrl, "GET", `/api/public/roadmap?departments=no-such-dept-${RUN}`);
    check(
      "unknown department slug → empty board (never 'show everything')",
      (r.body.initiatives as any[]).length === 0,
      `got ${r.body.initiatives.length}`,
    );

    // ── Reorder reflected in public order ───────────────────────────────────
    r = await call(baseUrl, "POST", "/api/roadmap/initiatives/reorder", {
      orderedIds: [pubShipped.id, pubPlanned.id, draft.id],
    });
    check("reorder → ok", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
    r = await call(baseUrl, "GET", `/api/public/roadmap${scoped}`);
    check(
      "public order follows reorder (shipped now first)",
      (r.body.initiatives as any[]).map((i: any) => i.id).join(",") ===
        `${pubShipped.id},${pubPlanned.id}`,
      JSON.stringify(r.body.initiatives.map((i: any) => i.id)),
    );

    // ── Publish toggle drives public visibility ────────────────────────────
    r = await call(baseUrl, "PATCH", `/api/roadmap/initiatives/${draft.id}`, { published: true });
    check("publish draft → 200", r.status === 200 && r.body.published === true, JSON.stringify(r.body));
    r = await call(baseUrl, "GET", `/api/public/roadmap${scoped}`);
    check(
      "newly published row appears",
      (r.body.initiatives as any[]).some((i: any) => i.id === draft.id),
    );
    r = await call(baseUrl, "PATCH", `/api/roadmap/initiatives/${draft.id}`, { published: false });
    r = await call(baseUrl, "GET", `/api/public/roadmap${scoped}`);
    check(
      "unpublished row disappears again",
      !(r.body.initiatives as any[]).some((i: any) => i.id === draft.id),
    );

    // ── Task #4215: quarter-board validation (strict schemas) ───────────────
    r = await call(baseUrl, "POST", "/api/roadmap/initiatives", {
      title: "bad board",
      departmentId: dept.id,
      typeId: typeA.id,
      board: "engineering",
    });
    check("unknown board → 400 (closed enum)", r.status === 400, `got ${r.status}`);
    r = await call(baseUrl, "POST", "/api/roadmap/initiatives", {
      title: "bad quarter",
      departmentId: dept.id,
      typeId: typeA.id,
      board: "product",
      releaseQuarter: "Q3 2026",
    });
    check("malformed releaseQuarter (label, not key) → 400", r.status === 400, `got ${r.status}`);
    r = await call(baseUrl, "POST", "/api/roadmap/initiatives", {
      title: "legacy timeframe",
      departmentId: dept.id,
      typeId: typeA.id,
      board: "product",
      timeframe: "Q3 2026",
    });
    check("legacy free-text timeframe write → 400 (stop-write)", r.status === 400, `got ${r.status}`);
    r = await call(baseUrl, "PATCH", `/api/roadmap/initiatives/${pubPlanned.id}`, {
      completedAt: new Date().toISOString(),
    });
    check("client-supplied completedAt → 400 (server-owned column)", r.status === 400, `got ${r.status}`);

    // ── Task #4215: completedAt lifecycle (stamp / keep / clear) ────────────
    const compl = await mk({ title: `Completing ${RUN}`, releaseQuarter: "2026-Q1" });
    check(
      "open create leaves completedAt null",
      compl.completedAt === null,
      JSON.stringify(compl.completedAt),
    );
    r = await call(baseUrl, "PATCH", `/api/roadmap/initiatives/${compl.id}`, { status: "shipped" });
    check(
      "transition INTO shipped stamps completedAt",
      r.status === 200 && typeof r.body.completedAt === "string",
      JSON.stringify(r.body.completedAt ?? null),
    );
    const stampedAt = r.body.completedAt;
    r = await call(baseUrl, "PATCH", `/api/roadmap/initiatives/${compl.id}`, { published: false });
    check(
      "publish toggle on a Done row does NOT re-date completedAt",
      r.status === 200 && r.body.completedAt === stampedAt,
      `${JSON.stringify(r.body.completedAt)} vs ${JSON.stringify(stampedAt)}`,
    );
    r = await call(baseUrl, "PATCH", `/api/roadmap/initiatives/${compl.id}`, { status: "in_progress" });
    check(
      "transition OUT of shipped clears completedAt",
      r.status === 200 && r.body.completedAt === null,
      JSON.stringify(r.body.completedAt),
    );

    // ── Task #4215: boards= public filter (closed enum, garbage ignored) ────
    // The company-board row is created AFTER the order/count-sensitive
    // assertions above so their expectations stay exact.
    const companyItem = await mk({ title: `Company ops ${RUN}`, board: "company" });
    r = await call(baseUrl, "GET", `/api/public/roadmap${scoped}&boards=company`);
    check(
      "boards=company narrows to the company-board row",
      (r.body.initiatives as any[]).map((i: any) => i.id).join() === companyItem.id,
      JSON.stringify(r.body.initiatives.map((i: any) => i.id)),
    );
    r = await call(baseUrl, "GET", `/api/public/roadmap${scoped}&boards=product`);
    {
      const got = (r.body.initiatives as any[]).map((i: any) => i.id);
      check(
        "boards=product excludes the company-board row",
        !got.includes(companyItem.id) && got.includes(pubPlanned.id) && got.includes(pubShipped.id),
        JSON.stringify(got),
      );
    }
    r = await call(baseUrl, "GET", `/api/public/roadmap${scoped}&boards=garbage`);
    check(
      "garbage boards values are ignored (all published rows back)",
      (r.body.initiatives as any[]).length === 3,
      `got ${r.body.initiatives.length}`,
    );

    // ── Value-set delete guard ──────────────────────────────────────────────
    r = await call(baseUrl, "DELETE", `/api/roadmap/departments/${dept.id}`);
    check("delete in-use department → 409", r.status === 409, `got ${r.status}`);
    r = await call(baseUrl, "POST", "/api/roadmap/types", { name: `Ephemeral ${RUN}` });
    const ephemeral = r.body;
    r = await call(baseUrl, "DELETE", `/api/roadmap/types/${ephemeral.id}`);
    check("delete unused type → ok", r.status === 200, `got ${r.status}`);

    // ── Admin read includes drafts + internals (the contrast case) ─────────
    r = await call(baseUrl, "GET", "/api/roadmap/admin");
    const adminRow = (r.body.initiatives as any[]).find((i: any) => i.id === draft.id);
    check(
      "admin read still sees the draft with its internal notes",
      !!adminRow && adminRow.internalNotes === SECRET_NOTE,
      JSON.stringify(adminRow ?? null),
    );

    // ── Embed CSP: relaxation is scoped to the embed surface only ──────────
    check("predicate: /roadmap/embed relaxed", isFrameRelaxedPath("/roadmap/embed"));
    check("predicate: /roadmap/embed/ sub-path relaxed", isFrameRelaxedPath("/roadmap/embed/x"));
    check("predicate: /api/public/roadmap relaxed", isFrameRelaxedPath("/api/public/roadmap"));
    check("predicate: /roadmap (public page) NOT relaxed", !isFrameRelaxedPath("/roadmap"));
    check(
      "predicate: /roadmap/embedded-other NOT relaxed (segment boundary)",
      !isFrameRelaxedPath("/roadmap/embedded-other"),
    );
    check("predicate: / NOT relaxed", !isFrameRelaxedPath("/"));

    // Mirror of the server/index.ts mounting: two helmet instances, one
    // chooser. Proves the actual header emitted per path.
    const cspApp = express();
    const strictHelmet = helmet({
      contentSecurityPolicy: { directives: buildCspDirectives(STRICT_FRAME_ANCESTORS) },
      frameguard: false,
      crossOriginEmbedderPolicy: false,
    });
    const embedHelmet = helmet({
      contentSecurityPolicy: { directives: buildCspDirectives(EMBED_FRAME_ANCESTORS) },
      frameguard: false,
      crossOriginEmbedderPolicy: false,
    });
    cspApp.use((req: Request, res: Response, next: NextFunction) => {
      (isFrameRelaxedPath(req.path) ? embedHelmet : strictHelmet)(req, res, next);
    });
    cspApp.get(/.*/, (_req, res) => res.send("ok"));
    const cspSrv = await listen(cspApp);
    try {
      const hdr = async (path: string) => {
        const res = await fetch(`${cspSrv.baseUrl}${path}`);
        await res.arrayBuffer();
        return res.headers.get("content-security-policy") ?? "";
      };
      const embedHdr = await hdr("/roadmap/embed?departments=x");
      check(
        "embed HTML path: frame-ancestors *",
        /frame-ancestors \*/.test(embedHdr),
        embedHdr,
      );
      const apiHdr = await hdr("/api/public/roadmap");
      check("public JSON path: frame-ancestors *", /frame-ancestors \*/.test(apiHdr), apiHdr);
      const rootHdr = await hdr("/");
      check(
        "root path keeps strict frame-ancestors (self + replit hosts)",
        rootHdr.includes("frame-ancestors 'self' https://*.replit.dev") &&
          !/frame-ancestors \*/.test(rootHdr),
        rootHdr,
      );
      const publicPageHdr = await hdr("/roadmap");
      check(
        "/roadmap (non-embed) keeps strict frame-ancestors",
        publicPageHdr.includes("frame-ancestors 'self'"),
        publicPageHdr,
      );
    } finally {
      await new Promise<void>((resolve) => cspSrv.server.close(() => resolve()));
    }

    // ── Rate limiter wired on the public endpoint (LAST — burns the budget) ─
    let saw429 = false;
    for (let i = 0; i < 70 && !saw429; i++) {
      const res = await fetch(`${baseUrl}/api/public/roadmap?departments=none-${RUN}`);
      await res.arrayBuffer();
      if (res.status === 429) saw429 = true;
    }
    check("public endpoint rate-limits (429 within budget)", saw429);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Cleanup: children first (FK), then value sets, then users.
    try {
      for (const id of createdInitiativeIds) {
        await db.execute(sql`DELETE FROM roadmap_initiatives WHERE id = ${id}`);
      }
      await db.execute(sql`DELETE FROM roadmap_departments WHERE slug LIKE ${"%" + RUN + "%"}`);
      await db.execute(sql`DELETE FROM roadmap_types WHERE slug LIKE ${"%" + RUN + "%"}`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${LEAD_ID}, ${SALES_ID})`);
    } catch (err) {
      console.error("cleanup failed:", err);
    }
  }
}

try {
  await main();
} catch (err) {
  failed++;
  console.error("FATAL:", err);
} finally {
  await closeDbPools().catch(() => {});
  await getGlobalDispatcher().close().catch(() => {});
}

console.log(`\nroadmap-public-routes: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
