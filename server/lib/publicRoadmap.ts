/**
 * Task #4216 — the ONE public-shaped roadmap initiative read.
 *
 * Both public read surfaces — GET /api/public/roadmap (server/routes/
 * roadmap.ts) and the report payload "Product updates" block (share/preview/
 * demo builders in server/routes/reports.ts) — fetch initiatives through
 * this single projection so the public-payload hygiene contract lives in
 * exactly one place: published rows only, public fields only (never
 * `internalNotes`, never drafts), `timeframe` DERIVED from the release
 * quarter's label. A second mapping would be a silent-leak drift risk; here
 * drift is a type error against the shared `PublicRoadmapInitiative` shape,
 * and the exact field set is pinned by tests/roadmap-public-routes.test.ts
 * and tests/report-product-updates.test.ts.
 *
 * Runs on the request-scoped API pool `db` (roadmap + report reads are all
 * request-path); tiny indexed reads over an operator-curated table.
 */
import { and, asc, eq, type SQL } from "drizzle-orm";
import { db } from "../db";
import {
  roadmapDepartments,
  roadmapInitiatives,
  roadmapTypes,
  type PublicRoadmapInitiative,
  type ReportProductUpdates,
  type RoadmapBoard,
  type RoadmapStatus,
} from "@shared/schema";
import { quarterLabel, selectReportProductUpdates } from "@shared/roadmapProgress";

/**
 * Published initiatives shaped to the shared public payload type, in
 * operator kanban order. Callers may narrow further (slug/status/board
 * filters) via `extraConds`; the published-only predicate is unconditional
 * here and cannot be opted out of.
 */
export async function queryPublicRoadmapInitiatives(
  extraConds: SQL[] = [],
): Promise<PublicRoadmapInitiative[]> {
  const rows = await db
    .select({
      id: roadmapInitiatives.id,
      title: roadmapInitiatives.title,
      description: roadmapInitiatives.publicDescription,
      status: roadmapInitiatives.status,
      board: roadmapInitiatives.board,
      releaseQuarter: roadmapInitiatives.releaseQuarter,
      completedAt: roadmapInitiatives.completedAt,
      displayOrder: roadmapInitiatives.displayOrder,
      departmentSlug: roadmapDepartments.slug,
      departmentName: roadmapDepartments.name,
      typeSlug: roadmapTypes.slug,
      typeName: roadmapTypes.name,
    })
    .from(roadmapInitiatives)
    .innerJoin(
      roadmapDepartments,
      eq(roadmapInitiatives.departmentId, roadmapDepartments.id),
    )
    .innerJoin(roadmapTypes, eq(roadmapInitiatives.typeId, roadmapTypes.id))
    .where(and(eq(roadmapInitiatives.published, true), ...extraConds))
    .orderBy(asc(roadmapInitiatives.displayOrder), asc(roadmapInitiatives.createdAt));
  return rows.map((r) => ({
    ...r,
    status: r.status as RoadmapStatus,
    board: r.board as RoadmapBoard,
    // Legacy embed consumers keep getting a human timeframe string — derived
    // from the quarter key now, never stored free text.
    timeframe: r.releaseQuarter ? quarterLabel(r.releaseQuarter) : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  }));
}

/**
 * The CEO Pulse "Product updates" block: product-board items scheduled for
 * the current quarter (not yet shipped) plus items completed in the current
 * or previous quarter. Returns null when nothing qualifies so the payload —
 * and the slide — omit the block entirely. Percentages are deliberately NOT
 * computed here: clients derive them live from shared/roadmapProgress, so an
 * already-published report's bars tick up between views with zero
 * regeneration and zero background jobs.
 */
export async function buildReportProductUpdates(
  now: Date = new Date(),
): Promise<ReportProductUpdates | null> {
  const items = await queryPublicRoadmapInitiatives([
    eq(roadmapInitiatives.board, "product"),
  ]);
  const window = selectReportProductUpdates(items, now);
  if (window.upcoming.length === 0 && window.completed.length === 0) return null;
  return {
    quarterKey: window.quarterKey,
    quarterLabel: quarterLabel(window.quarterKey),
    upcoming: window.upcoming,
    completed: window.completed,
  };
}
