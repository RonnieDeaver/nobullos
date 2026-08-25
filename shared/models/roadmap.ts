/**
 * Task #3728 — Company roadmap with public embed.
 *
 * Native roadmap module: this app's database is the system of record (NOT
 * ClickUp). Team-curated initiatives are shown on a public SaaS-style
 * status-column roadmap and on a chrome-less embed route third-party sites
 * can iframe.
 *
 *   - roadmap_departments / roadmap_types  manageable value sets (admin CRUD,
 *     not hard-coded). Initiatives reference them by FK; the public filter
 *     params key on their stable slugs so renaming a department never breaks
 *     an already-pasted embed snippet.
 *   - roadmap_initiatives  one row per initiative. `publicDescription` is the
 *     ONLY prose the public payload may carry; `internalNotes` exists so the
 *     public-payload hygiene is a provable filter, not an accident of the
 *     schema. Unpublished rows are invisible everywhere public.
 *
 * Task #4215 — quarter-based kanban boards. Initiatives now live on one of
 * two boards (`board` is a hard column, NOT a value-set row — report
 * inclusion depends on it structurally) and are scheduled into release
 * quarters (`releaseQuarter`, sortable "2026-Q3" keys with UTC boundaries;
 * null = the "Later" column). Completion is recorded in `completedAt`
 * (server-owned: stamped on the transition to `shipped`, cleared on
 * un-complete, never accepted from request bodies). Progress percentages are
 * NEVER stored — they are pure date math over status + releaseQuarter in
 * shared/roadmapProgress.ts, computed at render time. The legacy free-text
 * `timeframe` COLUMN was dropped (Task #4230); the public payload still
 * carries a `timeframe` field for embed back-compat, derived from the
 * release quarter's label.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const roadmapStatuses = ["planned", "in_progress", "shipped"] as const;
export type RoadmapStatus = (typeof roadmapStatuses)[number];

export const roadmapStatusLabels: Record<RoadmapStatus, string> = {
  planned: "Planned",
  in_progress: "In Progress",
  shipped: "Shipped",
};

// The two kanban boards (Task #4215). "shipped" doubles as the boards' Done
// state — no parallel status value — so existing `statuses=` embed filters
// stay meaningful.
export const roadmapBoards = ["product", "company"] as const;
export type RoadmapBoard = (typeof roadmapBoards)[number];

export const roadmapBoardLabels: Record<RoadmapBoard, string> = {
  product: "Product Development",
  company: "Company Development",
};

// Starter value-set rows. Declared in shared so the migration
// (migrations/20260810040050_roadmap_quarter_boards.sql), the runtime seed
// ensure in server/routes/roadmap.ts (which is how an empty PRODUCTION gets
// them — the Publish diff carries structure only, never seed rows), and any
// future tooling all state the SAME rows. Idempotent by slug everywhere.
export const roadmapSeedDepartments = [
  { name: "Marketing", slug: "marketing", displayOrder: 10 },
  { name: "Sales", slug: "sales", displayOrder: 20 },
  { name: "Operations", slug: "operations", displayOrder: 30 },
  { name: "Client Success", slug: "client-success", displayOrder: 40 },
  { name: "Product & Engineering", slug: "product-engineering", displayOrder: 50 },
] as const;

export const roadmapSeedTypes = [
  { name: "New Capability", slug: "new-capability", displayOrder: 10 },
  { name: "Improvement", slug: "improvement", displayOrder: 20 },
  { name: "Internal Tooling", slug: "internal-tooling", displayOrder: 30 },
  { name: "Process", slug: "process", displayOrder: 40 },
] as const;

export const roadmapDepartments = pgTable(
  "roadmap_departments",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    slugIdx: uniqueIndex("roadmap_departments_slug_idx").on(table.slug),
  }),
);

export const roadmapTypes = pgTable(
  "roadmap_types",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    slugIdx: uniqueIndex("roadmap_types_slug_idx").on(table.slug),
  }),
);

export const roadmapInitiatives = pgTable(
  "roadmap_initiatives",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    title: text("title").notNull(),
    publicDescription: text("public_description").notNull().default(""),
    /** Team-only notes. MUST never appear in any public payload. */
    internalNotes: text("internal_notes"),
    departmentId: varchar("department_id")
      .notNull()
      .references(() => roadmapDepartments.id),
    typeId: varchar("type_id")
      .notNull()
      .references(() => roadmapTypes.id),
    status: varchar("status", { length: 24 }).notNull().default("planned"),
    /** Which kanban board the item lives on ('product' | 'company'). */
    board: varchar("board", { length: 16 }).notNull().default("product"),
    /** Sortable release-quarter key, e.g. "2026-Q3" (UTC); null = "Later". */
    releaseQuarter: varchar("release_quarter", { length: 8 }),
    /**
     * When the item was moved to Done (status `shipped`). Server-owned:
     * stamped/cleared by the PATCH route on status transitions, never
     * accepted from request bodies. Drives "completed in quarter X" queries.
     */
    completedAt: timestamp("completed_at"),
    displayOrder: integer("display_order").notNull().default(0),
    published: boolean("published").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    publishedStatusIdx: index("roadmap_initiatives_published_status_idx").on(
      table.published,
      table.status,
    ),
    departmentIdx: index("roadmap_initiatives_department_idx").on(table.departmentId),
    typeIdx: index("roadmap_initiatives_type_idx").on(table.typeId),
  }),
);

export type RoadmapDepartment = typeof roadmapDepartments.$inferSelect;
export type RoadmapType = typeof roadmapTypes.$inferSelect;
export type RoadmapInitiative = typeof roadmapInitiatives.$inferSelect;

export const insertRoadmapInitiativeSchema = createInsertSchema(roadmapInitiatives).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertRoadmapInitiative = z.infer<typeof insertRoadmapInitiativeSchema>;

// ── Public payload shape ─────────────────────────────────────────────────────
// The ONLY fields the unauthenticated endpoint may return. Shared by the
// server route, the public/embed page, and the payload-hygiene test so drift
// is a type error, not a silent leak.

export interface PublicRoadmapValueSet {
  slug: string;
  name: string;
  displayOrder: number;
}

export interface PublicRoadmapInitiative {
  id: string;
  title: string;
  /**
   * Public description — may carry markdown SOURCE (#4266: bold / italic /
   * strikethrough / lists / links authored in the admin dialog). The payload
   * shape is unchanged: consumers receive the raw string exactly as stored.
   * Our surfaces (public page, embed, report block) render it through the
   * shared RoadmapMarkdown component with raw HTML kept escaped; third-party
   * JSON consumers that treat it as plain text simply see the markdown
   * characters.
   */
  description: string;
  status: RoadmapStatus;
  /**
   * LEGACY display field kept so pre-#4215 embed consumers keep rendering —
   * now DERIVED from releaseQuarter's label ("Q3 2026"), never stored text.
   */
  timeframe: string | null;
  displayOrder: number;
  board: RoadmapBoard;
  /** Sortable "YYYY-Qn" key, or null for "Later" (no quarter scheduled). */
  releaseQuarter: string | null;
  /** ISO timestamp of completion; null while the item is open. */
  completedAt: string | null;
  departmentSlug: string;
  departmentName: string;
  typeSlug: string;
  typeName: string;
}

export interface PublicRoadmapPayload {
  departments: PublicRoadmapValueSet[];
  types: PublicRoadmapValueSet[];
  statuses: readonly RoadmapStatus[];
  boards: readonly RoadmapBoard[];
  initiatives: PublicRoadmapInitiative[];
}

/**
 * Task #4216 — the "Product updates" block on the CEO Pulse slide of client
 * reports (share/preview/demo payloads). Assembled live at fetch time from
 * the SAME public projection as /api/public/roadmap (server/lib/
 * publicRoadmap.ts), so a report payload can never carry more than the
 * public roadmap does — internalNotes, unpublished drafts, and company-board
 * rows are structurally absent. Selection window rules live in
 * shared/roadmapProgress.ts (selectReportProductUpdates); percentages are
 * NOT stored here — clients compute them at render time so already-published
 * reports tick up between views with zero regeneration.
 */
export interface ReportProductUpdates {
  /** Current quarter key at assembly time (e.g. "2026-Q3"). */
  quarterKey: string;
  /** Human label for the window headline ("Q3 2026"). */
  quarterLabel: string;
  /** Product-board items released this quarter, not yet shipped (kanban order). */
  upcoming: PublicRoadmapInitiative[];
  /** Product-board items completed this or last quarter, newest first. */
  completed: PublicRoadmapInitiative[];
}
