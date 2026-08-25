/* test-registration
{
  "name": "Roadmap value-set runtime self-seed — empty DB → first public read seeds 5 departments / 4 types, idempotent on re-run (Task #4267)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4267: ensureRoadmapValueSetsSeeded is the ONLY mechanism that populates roadmap departments/types in production (the Publish diff carries schema structure only, never seed rows). A regression here — bad SQL, a schema change that breaks the INSERT — would silently ship an empty public roadmap board while every other roadmap test stays green, because none of them ever exercises empty tables. Small: one in-process HTTP server, a handful of indexed queries, no external network; fast and deterministic.",
  "tier": "small"
}
test-registration */
/**
 * Task #4267 — catch a deploy where roadmap value sets fail to self-seed.
 *
 * Production gets its schema from the Publish diff (structure only), so the
 * migration's seed INSERTs never reach prod. The runtime ensure in
 * server/routes/roadmap.ts is the only thing standing between a fresh deploy
 * and clients staring at an empty public board. This suite proves, via the
 * real route:
 *
 *   1. EMPTY DB → first GET /api/public/roadmap triggers the seed: the
 *      payload carries exactly the 5 seed departments and 4 seed types (by
 *      slug, in lockstep with shared/models/roadmap.ts) plus the boards enum.
 *   2. IDEMPOTENCY — the seed INSERTs run a SECOND time (latch reset via the
 *      test seam, so the ON CONFLICT path itself is exercised, not just the
 *      in-process latch) without double-inserting rows, and the row ids are
 *      unchanged (DO NOTHING, not delete+reinsert).
 *
 * The once-per-process latch is module-global and batched suites share a
 * process, so the suite resets it through
 * __resetRoadmapValueSetSeedLatchForTest (also registered in the Task #4097
 * between-suite reset registry). DB: hermetic per-run Postgres; the suite
 * empties the roadmap tables up front (initiatives first — FK), which is the
 * exact fresh-prod shape under test. undici dispatcher closed at exit
 * (memory: route-test-undici-drain-hang).
 */

process.env.NODE_ENV = "test";

import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

const { registerRoadmapRoutes, __resetRoadmapValueSetSeedLatchForTest } = await import(
  "../server/routes/roadmap"
);
const { db, closeDbPools } = await import("../server/db");
const { sql } = await import("drizzle-orm");
const { roadmapSeedDepartments, roadmapSeedTypes } = await import("@shared/schema");

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

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function getPayload(baseUrl: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/public/roadmap`);
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

async function countRows(table: "roadmap_departments" | "roadmap_types"): Promise<number> {
  const res = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
  return (res.rows[0] as any).n as number;
}

async function main(): Promise<void> {
  const app = express();
  registerRoadmapRoutes(app);
  const { server, baseUrl } = await listen(app);
  try {
    // ── Arrange: the fresh-prod shape — truly empty value-set tables ──────
    // Initiatives first (FK to both value sets). Hermetic per-run DB, so
    // this only ever clears rows this run created.
    await db.execute(sql`DELETE FROM roadmap_initiatives`);
    await db.execute(sql`DELETE FROM roadmap_departments`);
    await db.execute(sql`DELETE FROM roadmap_types`);
    check(
      "arranged: value-set tables are empty",
      (await countRows("roadmap_departments")) === 0 && (await countRows("roadmap_types")) === 0,
    );
    // Clear the once-per-process latch: a sibling suite in the same batch
    // child may already have latched a resolved seed promise, which would
    // skip the seed and fail this suite for the wrong reason.
    __resetRoadmapValueSetSeedLatchForTest();

    // ── Act 1: first request against the empty DB triggers the seed ───────
    let r = await getPayload(baseUrl);
    check("first public read → 200 (seed did not 500)", r.status === 200, `got ${r.status}`);
    check(
      `payload departments.length === ${roadmapSeedDepartments.length} (expected 5)`,
      Array.isArray(r.body?.departments) &&
        r.body.departments.length === 5 &&
        roadmapSeedDepartments.length === 5,
      JSON.stringify(r.body?.departments?.map((d: any) => d.slug)),
    );
    check(
      `payload types.length === ${roadmapSeedTypes.length} (expected 4)`,
      Array.isArray(r.body?.types) && r.body.types.length === 4 && roadmapSeedTypes.length === 4,
      JSON.stringify(r.body?.types?.map((t: any) => t.slug)),
    );
    const gotDeptSlugs = (r.body?.departments ?? []).map((d: any) => d.slug).sort();
    const gotTypeSlugs = (r.body?.types ?? []).map((t: any) => t.slug).sort();
    check(
      "seeded department slugs match shared/models/roadmap.ts exactly",
      JSON.stringify(gotDeptSlugs) ===
        JSON.stringify(roadmapSeedDepartments.map((d) => d.slug).slice().sort()),
      JSON.stringify(gotDeptSlugs),
    );
    check(
      "seeded type slugs match shared/models/roadmap.ts exactly",
      JSON.stringify(gotTypeSlugs) ===
        JSON.stringify(roadmapSeedTypes.map((t) => t.slug).slice().sort()),
      JSON.stringify(gotTypeSlugs),
    );
    check(
      "payload carries boards",
      JSON.stringify(r.body?.boards) === JSON.stringify(["product", "company"]),
      JSON.stringify(r.body?.boards),
    );

    // Snapshot ids so re-seed can be proven a DO NOTHING, not delete+insert.
    const idsBefore = await db.execute(
      sql`SELECT id FROM roadmap_departments ORDER BY slug`,
    );

    // ── Act 2: idempotency — force the INSERTs to run AGAIN ───────────────
    // A second HTTP call alone would hit the in-process latch and prove
    // nothing about the SQL; resetting the latch makes the ON CONFLICT
    // (slug) DO NOTHING path itself execute against the now-populated
    // tables — the restarted-deploy / second-instance scenario.
    __resetRoadmapValueSetSeedLatchForTest();
    r = await getPayload(baseUrl);
    check("second (re-seeding) read → 200", r.status === 200, `got ${r.status}`);
    check(
      "no double-insert: still exactly 5 departments / 4 types in the DB",
      (await countRows("roadmap_departments")) === 5 && (await countRows("roadmap_types")) === 4,
      `depts=${await countRows("roadmap_departments")} types=${await countRows("roadmap_types")}`,
    );
    const idsAfter = await db.execute(sql`SELECT id FROM roadmap_departments ORDER BY slug`);
    check(
      "re-seed is DO NOTHING: department row ids unchanged",
      JSON.stringify(idsBefore.rows) === JSON.stringify(idsAfter.rows),
    );
    check(
      "payload still exactly the seed sets after re-seed",
      r.body?.departments?.length === 5 && r.body?.types?.length === 4,
      JSON.stringify({ d: r.body?.departments?.length, t: r.body?.types?.length }),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Leave the seeded canonical rows in place — they are exactly what a
    // healthy DB contains, and later suites in the run expect them.
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

console.log(`\nroadmap-value-set-seed: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
