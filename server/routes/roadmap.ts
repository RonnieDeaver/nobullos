/**
 * Task #3728 — Company roadmap with public embed.
 *
 * Admin surface (team_lead+): CRUD for initiatives and the department/type
 * value sets, reorder, publish/unpublish. Public surface: ONE unauthenticated,
 * rate-limited endpoint that returns published initiatives only, shaped to
 * the shared `PublicRoadmapPayload` — public-facing fields exclusively (never
 * `internalNotes`, never unpublished drafts).
 *
 * Filter params (`?departments=&types=&statuses=&boards=`, comma-separated)
 * key on value-set SLUGS, which stay stable across renames so already-pasted
 * embed snippets keep working. Unknown department/type slugs simply match
 * nothing — an embed with a typo shows an empty board rather than silently
 * showing everything. `statuses`/`boards` are closed enums: garbage-only
 * values mean the filter is skipped, same as an absent param.
 *
 * Task #4215 — quarter-based kanban boards:
 *   - create/update take `board` ('product' | 'company') and `releaseQuarter`
 *     (sortable "2026-Q3" key, null = "Later"); the legacy free-text
 *     `timeframe` column is DROPPED (Task #4230; strict schemas reject the
 *     key) and the public payload's `timeframe` value is DERIVED from the
 *     quarter label for embed back-compat.
 *   - `completedAt` is server-owned: stamped when a PATCH transitions status
 *     INTO "shipped" (the boards' Done state), cleared on the transition out,
 *     untouched otherwise. Never accepted from request bodies.
 *   - progress percentages are pure date math in shared/roadmapProgress.ts,
 *     computed at render time by every surface — deliberately NO cron here.
 *   - value sets self-seed at first read (see ensureRoadmapValueSetsSeeded).
 *
 * Runs on the request-scoped API pool `db` (same as savePlays/booking); all
 * queries are tiny indexed reads/writes.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import {
  roadmapBoards,
  roadmapDepartments,
  roadmapInitiatives,
  roadmapSeedDepartments,
  roadmapSeedTypes,
  roadmapStatuses,
  roadmapTypes,
  type PublicRoadmapPayload,
  type RoadmapBoard,
  type RoadmapStatus,
} from "@shared/schema";
import { QUARTER_KEY_RE } from "@shared/roadmapProgress";
import { queryPublicRoadmapInitiatives } from "../lib/publicRoadmap";
import { registerModuleStateResetForTest } from "../services/moduleStateReset";

// Public roadmap endpoint gets its own limiter (modeled on the public booking
// endpoints): loose enough for embeds on busy third-party pages, tight enough
// to blunt scrapers. Per-IP, 60/min.
const publicRoadmapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

// ── Validation ───────────────────────────────────────────────────────────────

const releaseQuarterField = z
  .string()
  .trim()
  .regex(QUARTER_KEY_RE, "releaseQuarter must be a sortable quarter key like 2026-Q3");

const createInitiativeSchema = z
  .object({
    title: z.string().trim().min(1, "title is required").max(300),
    publicDescription: z.string().trim().max(2000).default(""),
    internalNotes: z.string().trim().max(8000).nullish(),
    departmentId: z.string().trim().min(1, "departmentId is required"),
    typeId: z.string().trim().min(1, "typeId is required"),
    status: z.enum(roadmapStatuses).default("planned"),
    board: z.enum(roadmapBoards),
    releaseQuarter: releaseQuarterField.nullish(),
    published: z.boolean().default(false),
  })
  .strict();

const updateInitiativeSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    publicDescription: z.string().trim().max(2000).optional(),
    internalNotes: z.string().trim().max(8000).nullable().optional(),
    departmentId: z.string().trim().min(1).optional(),
    typeId: z.string().trim().min(1).optional(),
    status: z.enum(roadmapStatuses).optional(),
    board: z.enum(roadmapBoards).optional(),
    releaseQuarter: releaseQuarterField.nullable().optional(),
    published: z.boolean().optional(),
  })
  .strict();

const reorderSchema = z
  .object({ orderedIds: z.array(z.string().trim().min(1)).min(1).max(500) })
  .strict();

const valueSetCreateSchema = z
  .object({ name: z.string().trim().min(1, "name is required").max(120) })
  .strict();

const valueSetUpdateSchema = valueSetCreateSchema;

/** Comma-separated query param → cleaned lowercase slug list (may be empty). */
function parseSlugListParam(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 50);
}

/** "Client Success!" → "client-success"; always non-empty for non-empty input. */
export function slugifyRoadmapName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "item";
}

type ValueSetTable = typeof roadmapDepartments | typeof roadmapTypes;

async function uniqueSlugFor(table: ValueSetTable, name: string): Promise<string> {
  const base = slugifyRoadmapName(name);
  const existing = await db
    .select({ slug: table.slug })
    .from(table)
    .where(sql`${table.slug} LIKE ${base + "%"}`);
  const taken = new Set(existing.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 100 same-named value-set rows is operator error, not a real flow.
  throw new Error(`Could not derive a unique slug for "${name}"`);
}

// ── Value-set seed ensure (Task #4215) ───────────────────────────────────────
// Production's schema arrives via the Publish diff (structure only), so the
// migration's seed INSERTs never reach prod — which is exactly why prod sat
// with ZERO departments/types rows after Task #3728 shipped. This runtime
// ensure runs once per process on the first roadmap read (any environment)
// and is idempotent via ON CONFLICT (slug) DO NOTHING, so a fresh prod deploy
// self-seeds on first use. Single-flight; a failure clears the latch so the
// next request retries (and surfaces as that request's 500 — never a silent
// skip). Seed rows live in shared/models/roadmap.ts, in lockstep with
// migrations/20260810040050_roadmap_quarter_boards.sql.
let valueSetSeedPromise: Promise<void> | null = null;

/**
 * Test-only: clear the once-per-process seed latch so a suite can exercise
 * the "empty DB → first request seeds" path even when a sibling suite in the
 * same batched test process already latched it. Registered in the
 * between-suite module-state reset registry (Task #4097 convention); no-op
 * registration outside NODE_ENV=test.
 */
export function __resetRoadmapValueSetSeedLatchForTest(): void {
  valueSetSeedPromise = null;
}
registerModuleStateResetForTest("roadmapValueSetSeedLatch", __resetRoadmapValueSetSeedLatchForTest);

export function ensureRoadmapValueSetsSeeded(): Promise<void> {
  if (!valueSetSeedPromise) {
    valueSetSeedPromise = (async () => {
      await db
        .insert(roadmapDepartments)
        .values(roadmapSeedDepartments.map((r) => ({ ...r })))
        .onConflictDoNothing({ target: roadmapDepartments.slug });
      await db
        .insert(roadmapTypes)
        .values(roadmapSeedTypes.map((r) => ({ ...r })))
        .onConflictDoNothing({ target: roadmapTypes.slug });
    })().catch((err) => {
      valueSetSeedPromise = null;
      throw err;
    });
  }
  return valueSetSeedPromise;
}

export function registerRoadmapRoutes(app: Express): void {
  // ── Public: published initiatives only, public fields only ────────────────
  app.get("/api/public/roadmap", publicRoadmapLimiter, async (req: Request, res: Response) => {
    try {
      await ensureRoadmapValueSetsSeeded();
      const departmentSlugs = parseSlugListParam(req.query.departments);
      const typeSlugs = parseSlugListParam(req.query.types);
      const statusSlugs = parseSlugListParam(req.query.statuses).filter(
        (s): s is RoadmapStatus => (roadmapStatuses as readonly string[]).includes(s),
      );
      const boardSlugs = parseSlugListParam(req.query.boards).filter(
        (b): b is RoadmapBoard => (roadmapBoards as readonly string[]).includes(b),
      );
      // NOTE: if ?statuses= (or ?boards=) was provided but contained only
      // garbage values, the cleaned list is empty and the filter is skipped —
      // same treatment as an absent param. Unknown department/type slugs
      // instead flow into inArray and match nothing (empty board), because
      // slugs are an open set while statuses/boards are closed enums.

      // Task #4216 — the published-only projection + public-field mapping
      // moved to server/lib/publicRoadmap.ts so this route and the report
      // "Product updates" block share ONE hygiene path (published=true is
      // applied inside the helper and cannot be opted out of here).
      const conds: SQL[] = [];
      if (departmentSlugs.length > 0) conds.push(inArray(roadmapDepartments.slug, departmentSlugs));
      if (typeSlugs.length > 0) conds.push(inArray(roadmapTypes.slug, typeSlugs));
      if (statusSlugs.length > 0) conds.push(inArray(roadmapInitiatives.status, statusSlugs));
      if (boardSlugs.length > 0) conds.push(inArray(roadmapInitiatives.board, boardSlugs));

      const [departments, types, initiatives] = await Promise.all([
        db
          .select({
            slug: roadmapDepartments.slug,
            name: roadmapDepartments.name,
            displayOrder: roadmapDepartments.displayOrder,
          })
          .from(roadmapDepartments)
          .orderBy(asc(roadmapDepartments.displayOrder), asc(roadmapDepartments.name)),
        db
          .select({
            slug: roadmapTypes.slug,
            name: roadmapTypes.name,
            displayOrder: roadmapTypes.displayOrder,
          })
          .from(roadmapTypes)
          .orderBy(asc(roadmapTypes.displayOrder), asc(roadmapTypes.name)),
        queryPublicRoadmapInitiatives(conds),
      ]);

      const payload: PublicRoadmapPayload = {
        departments,
        types,
        statuses: roadmapStatuses,
        boards: roadmapBoards,
        initiatives,
      };
      res.json(payload);
    } catch (err) {
      console.error("[Roadmap] public payload failed:", err);
      res.status(500).json({ error: "Failed to load roadmap" });
    }
  });

  // ── Admin: full read (all fields, incl. drafts + internal notes) ──────────
  app.get(
    "/api/roadmap/admin",
    isAuthenticated,
    requireTeamLead,
    async (_req: Request, res: Response) => {
      try {
        await ensureRoadmapValueSetsSeeded();
        const [departments, types, initiatives, deptUsage, typeUsage] = await Promise.all([
          db
            .select()
            .from(roadmapDepartments)
            .orderBy(asc(roadmapDepartments.displayOrder), asc(roadmapDepartments.name)),
          db
            .select()
            .from(roadmapTypes)
            .orderBy(asc(roadmapTypes.displayOrder), asc(roadmapTypes.name)),
          db
            .select()
            .from(roadmapInitiatives)
            .orderBy(asc(roadmapInitiatives.displayOrder), asc(roadmapInitiatives.createdAt)),
          db
            .select({
              departmentId: roadmapInitiatives.departmentId,
              count: sql<number>`count(*)::int`,
            })
            .from(roadmapInitiatives)
            .groupBy(roadmapInitiatives.departmentId),
          db
            .select({
              typeId: roadmapInitiatives.typeId,
              count: sql<number>`count(*)::int`,
            })
            .from(roadmapInitiatives)
            .groupBy(roadmapInitiatives.typeId),
        ]);
        // Task #4364 — the embed dialog must emit the app's public address,
        // not whatever origin the admin happens to be browsing from (a dev
        // workspace origin pasted into an external site is a dead link).
        // Same base-URL resolution convention as the alert deep links; null
        // when nothing is configured so the client can fall back and say so.
        const publicBaseUrl =
          (
            process.env.APP_BASE_URL ||
            process.env.PUBLIC_BASE_URL ||
            process.env.REPLIT_DEPLOYMENT_URL ||
            ""
          )
            .trim()
            .replace(/\/+$/, "") || null;
        res.json({
          departments,
          types,
          initiatives,
          departmentUsage: Object.fromEntries(deptUsage.map((r) => [r.departmentId, r.count])),
          typeUsage: Object.fromEntries(typeUsage.map((r) => [r.typeId, r.count])),
          publicBaseUrl,
        });
      } catch (err) {
        console.error("[Roadmap] admin read failed:", err);
        res.status(500).json({ error: "Failed to load roadmap admin data" });
      }
    },
  );

  // ── Admin: initiatives ─────────────────────────────────────────────────────
  app.post(
    "/api/roadmap/initiatives",
    isAuthenticated,
    requireTeamLead,
    async (req: Request, res: Response) => {
      try {
        const parsed = createInitiativeSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: parsed.error.errors[0]?.message ?? "Invalid initiative" });
        }
        const body = parsed.data;

        // Validate FKs explicitly so a bad id is a 400, never an FK 500.
        const [dept] = await db
          .select({ id: roadmapDepartments.id })
          .from(roadmapDepartments)
          .where(eq(roadmapDepartments.id, body.departmentId));
        if (!dept) return res.status(400).json({ error: "Unknown department" });
        const [type] = await db
          .select({ id: roadmapTypes.id })
          .from(roadmapTypes)
          .where(eq(roadmapTypes.id, body.typeId));
        if (!type) return res.status(400).json({ error: "Unknown type" });

        const [{ maxOrder }] = await db
          .select({ maxOrder: sql<number>`COALESCE(MAX(${roadmapInitiatives.displayOrder}), 0)` })
          .from(roadmapInitiatives);

        const [created] = await db
          .insert(roadmapInitiatives)
          .values({
            title: body.title,
            publicDescription: body.publicDescription,
            internalNotes: body.internalNotes ?? null,
            departmentId: body.departmentId,
            typeId: body.typeId,
            status: body.status,
            board: body.board,
            releaseQuarter: body.releaseQuarter ?? null,
            // Server-owned: an item born completed still gets its stamp.
            completedAt: body.status === "shipped" ? new Date() : null,
            displayOrder: Number(maxOrder) + 10,
            published: body.published,
          })
          .returning();
        res.status(201).json(created);
      } catch (err) {
        console.error("[Roadmap] create initiative failed:", err);
        res.status(500).json({ error: "Failed to create initiative" });
      }
    },
  );

  app.patch(
    "/api/roadmap/initiatives/:id",
    isAuthenticated,
    requireTeamLead,
    async (req: Request, res: Response) => {
      try {
        const parsed = updateInitiativeSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: parsed.error.errors[0]?.message ?? "Invalid update" });
        }
        const body = parsed.data;
        if (Object.keys(body).length === 0) {
          return res.status(400).json({ error: "No fields to update" });
        }
        if (body.departmentId !== undefined) {
          const [dept] = await db
            .select({ id: roadmapDepartments.id })
            .from(roadmapDepartments)
            .where(eq(roadmapDepartments.id, body.departmentId));
          if (!dept) return res.status(400).json({ error: "Unknown department" });
        }
        if (body.typeId !== undefined) {
          const [type] = await db
            .select({ id: roadmapTypes.id })
            .from(roadmapTypes)
            .where(eq(roadmapTypes.id, body.typeId));
          if (!type) return res.status(400).json({ error: "Unknown type" });
        }

        // Completion stamping (Task #4215): `completedAt` is server-owned.
        // Stamp on the transition INTO "shipped", clear on the transition
        // out, leave untouched when status is absent or unchanged (a publish
        // toggle on a Done card must not re-date the completion).
        const [existing] = await db
          .select({ id: roadmapInitiatives.id, status: roadmapInitiatives.status })
          .from(roadmapInitiatives)
          .where(eq(roadmapInitiatives.id, req.params.id));
        if (!existing) return res.status(404).json({ error: "Initiative not found" });

        const set: Partial<typeof roadmapInitiatives.$inferInsert> = {
          ...body,
          updatedAt: new Date(),
        };
        if (body.status !== undefined && body.status !== existing.status) {
          if (body.status === "shipped") set.completedAt = new Date();
          else if (existing.status === "shipped") set.completedAt = null;
        }

        const [updated] = await db
          .update(roadmapInitiatives)
          .set(set)
          .where(eq(roadmapInitiatives.id, req.params.id))
          .returning();
        if (!updated) return res.status(404).json({ error: "Initiative not found" });
        res.json(updated);
      } catch (err) {
        console.error("[Roadmap] update initiative failed:", err);
        res.status(500).json({ error: "Failed to update initiative" });
      }
    },
  );

  app.delete(
    "/api/roadmap/initiatives/:id",
    isAuthenticated,
    requireTeamLead,
    async (req: Request, res: Response) => {
      try {
        const [deleted] = await db
          .delete(roadmapInitiatives)
          .where(eq(roadmapInitiatives.id, req.params.id))
          .returning({ id: roadmapInitiatives.id });
        if (!deleted) return res.status(404).json({ error: "Initiative not found" });
        res.json({ ok: true });
      } catch (err) {
        console.error("[Roadmap] delete initiative failed:", err);
        res.status(500).json({ error: "Failed to delete initiative" });
      }
    },
  );

  // Reorder: client sends the full desired order; rows are renumbered in
  // tens. Ids not in the list keep their old displayOrder (stable for
  // concurrent edits); unknown ids are ignored. The kanban UI sends one
  // COLUMN's ids at a time — per-column relative order is what matters, and
  // every surface groups by column before sorting on displayOrder.
  app.post(
    "/api/roadmap/initiatives/reorder",
    isAuthenticated,
    requireTeamLead,
    async (req: Request, res: Response) => {
      try {
        const parsed = reorderSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: parsed.error.errors[0]?.message ?? "Invalid reorder" });
        }
        const { orderedIds } = parsed.data;
        await db.transaction(async (tx) => {
          for (let i = 0; i < orderedIds.length; i++) {
            await tx
              .update(roadmapInitiatives)
              .set({ displayOrder: (i + 1) * 10, updatedAt: new Date() })
              .where(eq(roadmapInitiatives.id, orderedIds[i]));
          }
        });
        res.json({ ok: true });
      } catch (err) {
        console.error("[Roadmap] reorder failed:", err);
        res.status(500).json({ error: "Failed to reorder initiatives" });
      }
    },
  );

  // ── Admin: value sets (departments + types share one implementation) ──────
  function registerValueSetRoutes(
    kind: "departments" | "types",
    table: ValueSetTable,
    usageColumn: typeof roadmapInitiatives.departmentId | typeof roadmapInitiatives.typeId,
  ): void {
    const label = kind === "departments" ? "Department" : "Type";

    app.post(
      `/api/roadmap/${kind}`,
      isAuthenticated,
      requireTeamLead,
      async (req: Request, res: Response) => {
        try {
          const parsed = valueSetCreateSchema.safeParse(req.body);
          if (!parsed.success) {
            return res
              .status(400)
              .json({ error: parsed.error.errors[0]?.message ?? `Invalid ${label.toLowerCase()}` });
          }
          const slug = await uniqueSlugFor(table, parsed.data.name);
          const [{ maxOrder }] = await db
            .select({ maxOrder: sql<number>`COALESCE(MAX(${table.displayOrder}), 0)` })
            .from(table);
          const [created] = await db
            .insert(table)
            .values({ name: parsed.data.name, slug, displayOrder: Number(maxOrder) + 10 })
            .returning();
          res.status(201).json(created);
        } catch (err) {
          console.error(`[Roadmap] create ${kind} failed:`, err);
          res.status(500).json({ error: `Failed to create ${label.toLowerCase()}` });
        }
      },
    );

    // Rename only — the slug is deliberately stable so filter params inside
    // already-pasted embed snippets keep matching after a rename.
    app.patch(
      `/api/roadmap/${kind}/:id`,
      isAuthenticated,
      requireTeamLead,
      async (req: Request, res: Response) => {
        try {
          const parsed = valueSetUpdateSchema.safeParse(req.body);
          if (!parsed.success) {
            return res
              .status(400)
              .json({ error: parsed.error.errors[0]?.message ?? `Invalid ${label.toLowerCase()}` });
          }
          const [updated] = await db
            .update(table)
            .set({ name: parsed.data.name })
            .where(eq(table.id, req.params.id))
            .returning();
          if (!updated) return res.status(404).json({ error: `${label} not found` });
          res.json(updated);
        } catch (err) {
          console.error(`[Roadmap] rename ${kind} failed:`, err);
          res.status(500).json({ error: `Failed to rename ${label.toLowerCase()}` });
        }
      },
    );

    app.delete(
      `/api/roadmap/${kind}/:id`,
      isAuthenticated,
      requireTeamLead,
      async (req: Request, res: Response) => {
        try {
          const [{ used }] = await db
            .select({ used: sql<number>`count(*)::int` })
            .from(roadmapInitiatives)
            .where(eq(usageColumn, req.params.id));
          if (Number(used) > 0) {
            return res.status(409).json({
              error: `${label} is used by ${used} initiative${Number(used) === 1 ? "" : "s"} — reassign them first`,
            });
          }
          const [deleted] = await db
            .delete(table)
            .where(eq(table.id, req.params.id))
            .returning({ id: table.id });
          if (!deleted) return res.status(404).json({ error: `${label} not found` });
          res.json({ ok: true });
        } catch (err) {
          console.error(`[Roadmap] delete ${kind} failed:`, err);
          res.status(500).json({ error: `Failed to delete ${label.toLowerCase()}` });
        }
      },
    );
  }

  registerValueSetRoutes("departments", roadmapDepartments, roadmapInitiatives.departmentId);
  registerValueSetRoutes("types", roadmapTypes, roadmapInitiatives.typeId);
}
